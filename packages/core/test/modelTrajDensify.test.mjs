// 航迹线大圆加密（packages/core/models/trajKinematics.mjs densifyGreatCircle / GC_STEP_DEG，P4 契约 §2.1）的回归网。
//
//   ① 每步球心角 ≤ GC_STEP_DEG + 1e-12（及自定步长）
//   ② 每个输出点落在所属段的大圆上（|P·n̂_seg| ≤ 1e-12；近对跖段法向无定义，跳过）
//   ③ 首点 / 每个航点逐位等于原值（经度归一：区间内的值原样，区间外按模折回）
//   ④ 段间无重复点（相邻两点球心角 > 0）
//   ⑤ 经度 ∈ (−180, 180]
//   ⑥ 跨 ±180°：(35, 170) → (40, −170) 点列连续、不切段
//   ⑦ 零长段、单点、空、非有限航点、null / 非数组输入
//   ⑧ 近对跖段与 trajStateAt 同路（同走 tangentInto 的「绕北」口径：中点纬度同号、位置一致）
//   ⑨ 段内点与 greatCircleInterp(A, B, i/n) 逐位相同
//   ⑩ stepDeg 非法按缺省；不改入参

import assert from 'node:assert/strict'
import {
  densifyGreatCircle, GC_STEP_DEG, greatCircleInterp, trajStateAt, makeTrajState, trajEndMs, wgs84DistanceM
} from '../models/trajKinematics.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 } }

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const unit = (lat, lon) => { const p = lat * D2R, l = lon * D2R, c = Math.cos(p); return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)] }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const angDeg = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b)) * R2D
const centralDeg = (p, q) => angDeg(unit(p.lat, p.lon), unit(q.lat, q.lon))
const fin = Number.isFinite
// 契约口径的经度归一：区间内原样，区间外按模折回，−180 记 180
const normLon = (lon) => { if (lon > -180 && lon <= 180) return lon; let x = ((lon + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x }

// 测试航线（含跨接缝、极区、短段、零长段、赤道整度数、近对跖）
const ROUTES = {
  fraNyc: [{ lat: 50.03, lon: 8.57 }, { lat: 40.64, lon: -73.78 }],
  transPacific: [{ lat: 35, lon: 170 }, { lat: 40, lon: -170 }, { lat: 21.3, lon: -157.9 }],
  polar: [{ lat: 70, lon: 0 }, { lat: 70, lon: 180 }, { lat: 60, lon: -120 }],
  short: [{ lat: 31.2, lon: 121.5 }, { lat: 31.25, lon: 121.6 }, { lat: 31.3, lon: 121.6 }],
  equatorExact: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2.5 }],
  withDup: [{ lat: 10, lon: 20 }, { lat: 10, lon: 20 }, { lat: 12, lon: 25 }, { lat: 12, lon: 25 }, { lat: 15, lon: 22 }],
  southOcean: [{ lat: -45, lon: 150 }, { lat: -60, lon: -60 }, { lat: -33.9, lon: 18.4 }],
  wrapInput: [{ lat: 5, lon: 190 }, { lat: 8, lon: -185 }, { lat: 9, lon: 540.25 }]
}

// 期望结构：逐个有效段的 n = ceil(θ/step)（θ = 0 的段跳过），用来还原每个输出点属于哪一段、哪些是航点
function plan(pts, step) {
  const valid = pts.filter((p) => p && fin(p.lat) && fin(p.lon))
  const segs = []
  let prev = null
  for (const p of valid) {
    if (!prev) { prev = p; continue }
    const a = unit(prev.lat, prev.lon), b = unit(p.lat, p.lon)
    const om = Math.atan2(len(cross(a, b)), dot(a, b))
    if (!(om > 1e-12)) continue                                             // 零长段判据（≈ 6 µm）：与实现同
    segs.push({ A: prev, B: p, k: Math.ceil(om * R2D / step), om })
    prev = p
  }
  return { first: valid[0] || null, segs }
}

function checkRoute(name, pts, step = GC_STEP_DEG) {
  const out = densifyGreatCircle(pts, step)
  const { first, segs } = plan(pts, step)
  const expectLen = first ? 1 + segs.reduce((s, g) => s + g.k, 0) : 0
  assert.equal(out.length, expectLen, `${name}：点数`)
  if (!first) return out
  // ③ 首点
  assert.ok(Object.is(out[0].lat, first.lat) && Object.is(out[0].lon, normLon(first.lon)), `${name}：首点逐位`)
  let i = 1
  for (const g of segs) {
    const a = unit(g.A.lat, g.A.lon), b = unit(g.B.lat, g.B.lon), nn = cross(a, b), nl = len(nn)
    for (let j = 1; j <= g.k; j++, i++) {
      const p = out[i]
      if (j < g.k) {
        // ⑨ 与 greatCircleInterp 逐位（经度归一后）
        const q = greatCircleInterp(g.A.lat, g.A.lon, g.B.lat, g.B.lon, j / g.k)
        assert.ok(Object.is(p.lat, q.lat) && Object.is(p.lon, normLon(q.lon)), `${name}：段内点 ${i} 与 greatCircleInterp 逐位`)
      } else {
        // ③ 段尾 = 航点原值
        assert.ok(Object.is(p.lat, g.B.lat) && Object.is(p.lon, normLon(g.B.lon)), `${name}：航点 ${i} 逐位`)
      }
      // ② 在所属段的大圆上（近对跖段 |A×B| 太小、法向无定义，跳过）
      if (nl > 1e-6) assert.ok(Math.abs(dot(unit(p.lat, p.lon), nn) / nl) <= 1e-12, `${name}：点 ${i} 离段大圆 ${dot(unit(p.lat, p.lon), nn) / nl}`)
    }
  }
  for (let k = 0; k < out.length; k++) {
    // ⑤ 经度区间
    assert.ok(out[k].lon > -180 && out[k].lon <= 180, `${name}：经度越界 ${out[k].lon}`)
    if (k) {
      const d = centralDeg(out[k - 1], out[k])
      // ① 步长上限；④ 无重复
      assert.ok(d <= step + 1e-12, `${name}：第 ${k} 步 ${d}° > ${step}°`)
      assert.ok(d > 0, `${name}：第 ${k} 步重复点`)
    }
  }
  return out
}

t('①–⑤ ⑨ 各航线：步长、在大圆上、航点逐位、无重复、经度区间、段内点与 greatCircleInterp 逐位', () => {
  let total = 0
  for (const [name, pts] of Object.entries(ROUTES)) total += checkRoute(name, pts).length
  assert.ok(total > 300, `总点数 ${total}`)
})

t('① 自定步长（2°、0.1°、7.3°）同样满足全部性质', () => {
  for (const step of [2, 0.1, 7.3]) for (const [name, pts] of Object.entries(ROUTES)) checkRoute(`${name}@${step}`, pts, step)
})

t('⑥ 跨 ±180°：(35, 170) → (40, −170) 连续不切（中间点经度 170 → 180 → −180 一侧），首尾逐位', () => {
  const out = checkRoute('dateline', [{ lat: 35, lon: 170 }, { lat: 40, lon: -170 }])
  const hasE = out.some((p) => p.lon > 170 && p.lon <= 180), hasW = out.some((p) => p.lon < -170 && p.lon > -180)
  assert.ok(hasE && hasW, '接缝两侧都有加密点')
  // 相邻点经度差跨接缝时 |Δlon| > 180（渲染端据此切），但球心角仍 ≤ 步长——没有在这里切段
  let wraps = 0
  for (let k = 1; k < out.length; k++) if (Math.abs(out[k].lon - out[k - 1].lon) > 180) wraps++
  assert.equal(wraps, 1, '恰好一处跨接缝')
})

t('⑦ 零长段、单点、空、非有限航点、null / 非数组输入', () => {
  assert.deepEqual(densifyGreatCircle([]), [])
  assert.deepEqual(densifyGreatCircle(null), [])
  assert.deepEqual(densifyGreatCircle(undefined), [])
  assert.deepEqual(densifyGreatCircle({}), [])
  assert.deepEqual(densifyGreatCircle([{ lat: 10, lon: 200 }]), [{ lat: 10, lon: -160 }])
  assert.deepEqual(densifyGreatCircle([{ lat: 10, lon: -180 }]), [{ lat: 10, lon: 180 }])
  // 全是同一点：只出一个
  assert.deepEqual(densifyGreatCircle([{ lat: 1, lon: 2 }, { lat: 1, lon: 2 }, { lat: 1, lon: 2 }]), [{ lat: 1, lon: 2 }])
  // 经差 360° 的同一点：也算零长
  assert.deepEqual(densifyGreatCircle([{ lat: 1, lon: 2 }, { lat: 1, lon: 362 }]), [{ lat: 1, lon: 2 }])
  // 非有限 / null 航点跳过（与页面 finLL 同口径）
  const pts = [null, { lat: NaN, lon: 1 }, { lat: 0, lon: 0 }, { lat: 0, lon: Infinity }, { lat: '1', lon: 1 }, {}, { lat: 0, lon: 0.4 }]
  assert.deepEqual(densifyGreatCircle(pts), [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.4 }])
  checkRoute('mixedInvalid', [{ lat: 0, lon: 0 }, null, { lat: 0, lon: 3 }, { lat: NaN, lon: 0 }, { lat: 2, lon: 3 }])
})

t('⑧ 近对跖段与 trajStateAt 同路：恰对跖绕北（中点纬度 > 0）、近对跖两者中点位置一致', () => {
  const T0 = Date.UTC(2026, 8, 24)
  for (const B of [{ lat: -10, lon: -160 }, { lat: -10 + 1e-9, lon: -160 }, { lat: -10, lon: -160 + 1e-7 }]) {
    const A = { lat: 10, lon: 20 }
    const out = densifyGreatCircle([A, B])
    const k = out.length - 1
    assert.ok(k >= 360, `对跖段应有 ≥ 360 步（${k}）`)
    // 与 greatCircleInterp 同一路：取 f = 1/2 的点（k 为偶数时恰是输出里的点）
    const mid = greatCircleInterp(A.lat, A.lon, B.lat, B.lon, 0.5)
    if (k % 2 === 0) assert.ok(Object.is(out[k / 2].lat, mid.lat), '中点逐位')
    // trajStateAt：s = L/2 时的位置
    const tr = { id: `anti${B.lat}${B.lon}`, kind: 'sea', pts: [A, B], t0Ms: T0, speedKmh: 36 }
    const L = wgs84DistanceM(A.lat, A.lon, B.lat, B.lon)
    const st = trajStateAt(tr, T0 + L / 2 / 10 * 1000, makeTrajState())
    assert.ok(Math.sign(st.lat) === Math.sign(mid.lat), `中点纬度同号：traj ${st.lat} vs densify ${mid.lat}`)
    assert.ok(centralDeg(st, mid) < 1e-6, `中点位置一致（差 ${centralDeg(st, mid)}°）`)
    assert.ok(fin(trajEndMs(tr)))
  }
  // 恰对跖：绕北（tangentInto 的「当地正北」口径）
  const out = densifyGreatCircle([{ lat: 10, lon: 20 }, { lat: -10, lon: -160 }])
  assert.ok(Math.max(...out.map((p) => p.lat)) > 89, '恰对跖段过北极一带')
})

t('⑩ stepDeg 非法按缺省；缺省 = 0.5°；不改入参', () => {
  assert.equal(GC_STEP_DEG, 0.5)
  const pts = ROUTES.fraNyc
  const snap = JSON.stringify(pts)
  const ref = densifyGreatCircle(pts)
  for (const bad of [NaN, 0, -1, Infinity, -Infinity, '2', null, undefined]) assert.deepEqual(densifyGreatCircle(pts, bad), ref, `step=${String(bad)}`)
  assert.equal(JSON.stringify(pts), snap, '入参未被改')
  assert.notEqual(ref[0], pts[0], '输出是新对象')
  // 法兰克福—纽约约 6200 km：0.5° ≈ 55.6 km 一步
  const L = wgs84DistanceM(pts[0].lat, pts[0].lon, pts[1].lat, pts[1].lon)
  assert.ok(ref.length - 1 === Math.ceil(centralDeg(pts[0], pts[1]) / 0.5), `步数 ${ref.length - 1}（全程 ${(L / 1000).toFixed(0)} km）`)
})

t('运动档载具恒在加密线上：trajStateAt 的位置离所在加密折线弦 ≤ 弦下陷上限（0.5° 步长 ≈ 61 m）', () => {
  const T0 = Date.UTC(2026, 8, 24, 4)
  const tr = { id: 'onLine', kind: 'flight', pts: ROUTES.transPacific, t0Ms: T0, speedKmh: 850 }
  const line = densifyGreatCircle(tr.pts)
  const st = makeTrajState()
  const end = trajEndMs(tr)
  let worstM = 0
  for (let tm = T0; tm <= end; tm += 600000) {
    trajStateAt(tr, tm, st)
    const P = unit(st.lat, st.lon)
    // 到折线的最近弦：取离 P 最近的相邻两点，算 P 到弦所在平面的距离（小角度下 = 弦下陷）
    let best = Infinity
    for (let k = 1; k < line.length; k++) {
      const a = unit(line[k - 1].lat, line[k - 1].lon), b = unit(line[k].lat, line[k].lon)
      const nrm = cross(a, b), nl = len(nrm)
      if (!(nl > 0)) continue
      // 只看 P 落在这段弧内的
      if (dot(cross(a, P), nrm) < -1e-12 || dot(cross(P, b), nrm) < -1e-12) continue
      best = Math.min(best, Math.abs(dot(P, nrm) / nl))
    }
    // 在大圆平面上（≤ 1e-12 rad）：加密线与载具同一条大圆
    assert.ok(best <= 1e-12, `t=${(tm - T0) / 60000} min：离加密线大圆平面 ${best}`)
    worstM = Math.max(worstM, best * 6371000)
  }
  assert.ok(worstM < 1e-3, `最坏 ${worstM} m`)
})

console.log(`modelTrajDensify: ${n} 项通过`)
