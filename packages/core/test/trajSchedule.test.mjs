// 航迹排程（packages/core/models/trajKinematics.mjs 的时刻钉点，STK Great Arc「由时间定速度」）+ 逐航点读数 + 带高度的 3D 航迹线。
//
//   ① 没有钉点：trajWaypointInfo 的时刻 = t0 + 累计 / 速度、末航点 = trajEndMs（同式逐位）；trajStartMs = t0
//   ② 全钉点：段速 = 段长 ÷ 时差，位置按段内匀速；trajEndMs = 末钉点
//   ③ 混合：起始 + 速度 + 中间钉点 —— 钉点前两段共用反推段速，其后按缺省速度外推
//   ④ 没有起始：首钉点之前按段速 / 缺省速度向前外推；只有一个钉点又没速度 → 排程不成立、退静止档
//   ⑤ 坏钉点（时刻不随里程增）记坏、不参与排程；停留（同位两航点、时刻递增）期间载具原地、moving 仍真
//   ⑥ 飞行剖面：钉点排成匀速时与「起始 + 速度」原式同一条线（逐刻比对）；变速时爬升按时间积（慢段爬得陡）
//   ⑦ 逐航点读数：航向 / 段长 / 段速 / 实际高度（运动档首末 0 m、钉点高度原值、静止档 = 巡航）/ 钉点标记
//   ⑧ trajLine3：首末 = 航点、剖面拐点真的在线上（爬升顶点 / 下降起点落在巡航高度上）、静止档飞行全程巡航、航行恒 0
//   ⑨ 计划缓存：改钉点即重建；排程下 trajStateAt 复用 out（报数）

import assert from 'node:assert/strict'
import {
  trajStateAt, trajStateAtS, makeTrajState, trajEndMs, trajStartMs, trajLengthM, trajWaypointInfo, trajLine3,
  wgs84DistanceM, clearTrajPlanCache, trajPlanStats, CRUISE_ALT_M_DEFAULT, CLIMB_RATE_MS_DEFAULT, GLIDE_DEG_DEFAULT
} from '../models/trajKinematics.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const T0 = Date.UTC(2026, 8, 24, 8, 0, 0)
const H = 3600000
const A = { lat: 0, lon: 0 }, B = { lat: 0, lon: 10 }, C = { lat: 0, lon: 20 }, D = { lat: 0, lon: 30 }
const L1 = wgs84DistanceM(0, 0, 0, 10), L2 = wgs84DistanceM(0, 10, 0, 20), L3 = wgs84DistanceM(0, 20, 0, 30)
const pts = (...ps) => ps.map((p, i) => ({ id: 'w' + i, ...p }))
// 容差按式子定：时刻是 ~1.8e12 ms 量级的双精度，末位 ulp ≈ 2.4e-4 ms。段速 = 段长 ÷ 两个这样的时刻之差，
// 相对误差 ≈ ulp / 时差（1 h 段 ≈ 7e-11）→ 取相对 1e-9；里程 = 段速 × 时差，绝对误差 ≈ ulp × 地速（≈ 5e-5 m）→ 取 1e-3 m。
const TIME_ULP_MS = 2.5e-4
const nearRel = (a, b, rel, msg) => near(a, b, Math.abs(b) * rel, msg)

// ═════════════════ ① 没有钉点 ═════════════════
t('① 没有钉点：逐航点时刻 = t0 + 累计 / 速度，末航点 = trajEndMs（逐位），trajStartMs = t0', () => {
  const tr = { id: 'u1', kind: 'sea', pts: pts(A, B, C), t0Ms: T0, speedKmh: 30 }
  const info = trajWaypointInfo(tr)
  assert.equal(info.length, 3)
  assert.ok(Object.is(info[2].tMs, trajEndMs(tr)), '末航点时刻与 trajEndMs 逐位')
  near(info[1].tMs, T0 + L1 / (30 / 3.6) * 1000, 1e-6, '中间航点')
  assert.equal(trajStartMs(tr), T0)
  assert.deepEqual(info.map((e) => e.tPinned), [true, false, false])
  assert.ok(info.every((e) => !e.tBad))
  near(info[1].speedKmh, 30, 1e-12, '段速 = 缺省速度'); assert.ok(Number.isNaN(info[0].speedKmh), '首航点无段速')
  // 只给速度不给起始：没有时刻，但有段速
  const sp = trajWaypointInfo({ id: 'u2', kind: 'sea', pts: pts(A, B), speedKmh: 20 })
  assert.ok(Number.isNaN(sp[1].tMs)); near(sp[1].speedKmh, 20, 1e-12, '只给速度')
  assert.ok(Number.isNaN(trajStartMs({ id: 'u3', kind: 'sea', pts: pts(A, B) })))
})

// ═════════════════ ② 全钉点 ═════════════════
t('② 全钉点：段速 = 段长 ÷ 时差、段内匀速、trajEndMs = 末钉点', () => {
  const tr = { id: 'p1', kind: 'sea', pts: pts(A, { ...B, tMs: T0 + H }, { ...C, tMs: T0 + 3 * H }), t0Ms: T0 }
  assert.equal(trajEndMs(tr), T0 + 3 * H); assert.equal(trajStartMs(tr), T0)
  const s1 = trajStateAt(tr, T0 + 0.5 * H)
  assert.equal(s1.moving, true); near(s1.s, L1 / 2, 1e-6, '前段半程'); near(s1.lon, 5, 1e-9, '经度 5°')
  const s2 = trajStateAt(tr, T0 + 2 * H)
  near(s2.s, L1 + L2 / 2, 1e-6, '后段半程'); near(s2.lon, 15, 1e-9, '经度 15°')
  const info = trajWaypointInfo(tr)
  assert.deepEqual(info.map((e) => e.tMs), [T0, T0 + H, T0 + 3 * H])
  assert.deepEqual(info.map((e) => e.tPinned), [true, true, true])
  near(info[1].speedKmh, L1 / 1000, 1e-9, '前段 1 h'); near(info[2].speedKmh, L2 / 1000 / 2, 1e-9, '后段 2 h')
  // 两端
  const pre = trajStateAt(tr, T0 - H), done = trajStateAt(tr, T0 + 4 * H)
  assert.equal(pre.phase, 'pre'); assert.equal(pre.lon, 0); assert.equal(done.phase, 'done'); assert.equal(done.done, true); assert.equal(done.lon, 20)
  // 首航点自带 tMs（没有 t0Ms）等同起始时刻
  const tr2 = { id: 'p2', kind: 'sea', pts: pts({ ...A, tMs: T0 }, { ...B, tMs: T0 + H }) }
  assert.equal(trajStartMs(tr2), T0); assert.equal(trajEndMs(tr2), T0 + H)
})

// ═════════════════ ③ 混合 ═════════════════
t('③ 起始 + 速度 + 中间钉点：钉点前反推段速、钉点后按缺省速度', () => {
  const tr = { id: 'mx', kind: 'sea', pts: pts(A, B, { ...C, tMs: T0 + 4 * H }, D), t0Ms: T0, speedKmh: 500 }
  const info = trajWaypointInfo(tr)
  const v = (L1 + L2) / (4 * 3600)                                         // m/s
  near(info[1].tMs, T0 + L1 / v * 1000, 1e-6, 'B 按反推段速')
  nearRel(info[1].speedKmh, v * 3.6, 1e-9, 'AB 段速'); nearRel(info[2].speedKmh, v * 3.6, 1e-9, 'BC 段速')
  near(info[3].tMs, T0 + 4 * H + L3 / (500 / 3.6) * 1000, 1e-6, 'D 按缺省速度外推')
  nearRel(info[3].speedKmh, 500, 1e-9, 'CD 段速 = 缺省（由时刻差回算）')
  assert.deepEqual(info.map((e) => e.tPinned), [true, false, true, false])
  near(trajEndMs(tr), info[3].tMs, 1e-9, 'trajEndMs = D')
})

// ═════════════════ ④ 没有起始 ═════════════════
t('④ 没有起始：首钉点前外推；单钉点无速度 → 排程不成立退静止档', () => {
  const tr = { id: 'ns', kind: 'sea', pts: pts(A, { ...B, tMs: T0 + 2 * H }, { ...C, tMs: T0 + 3 * H }) }
  const v = L2 / 3600
  const info = trajWaypointInfo(tr)
  near(info[0].tMs, T0 + 2 * H - L1 / v * 1000, 1e-6, 'A 借 BC 段速外推')
  assert.equal(info[0].tPinned, false)
  near(trajStartMs(tr), info[0].tMs, 1e-9, 'trajStartMs')
  // 缺省速度优先于借段速
  const tr2 = { ...tr, id: 'ns2', speedKmh: 100 }
  near(trajWaypointInfo(tr2)[0].tMs, T0 + 2 * H - L1 / (100 / 3.6) * 1000, 1e-6, 'A 按缺省速度外推')
  // 单钉点无速度
  const one = { id: 'one', kind: 'sea', pts: pts(A, { ...B, tMs: T0 }, C) }
  assert.ok(Number.isNaN(trajEndMs(one))); assert.equal(trajStateAt(one, T0).moving, false)
  assert.ok(trajWaypointInfo(one).every((e) => Number.isNaN(e.tMs)))
  // 单钉点有速度：两头按速度外推
  const oneV = { ...one, id: 'oneV', speedKmh: 400 }
  const iv = trajWaypointInfo(oneV)
  near(iv[0].tMs, T0 - L1 / (400 / 3.6) * 1000, 1e-6, '向前'); near(iv[2].tMs, T0 + L2 / (400 / 3.6) * 1000, 1e-6, '向后')
  assert.equal(trajStateAt(oneV, T0).moving, true)
})

// ═════════════════ ⑤ 坏钉点 / 停留 ═════════════════
t('⑤ 坏钉点记坏不参与；停留期间原地、moving 真', () => {
  const bad = { id: 'bad', kind: 'sea', pts: pts(A, { ...B, tMs: T0 + 2 * H }, { ...C, tMs: T0 + H }, { ...D, tMs: T0 + 3 * H }), t0Ms: T0 }
  const info = trajWaypointInfo(bad)
  assert.deepEqual(info.map((e) => e.tBad), [false, false, true, false])
  assert.equal(info[2].tPinned, false)
  near(info[2].tMs, T0 + 2 * H + L2 / ((L2 + L3) / 3600) * 1000, 1e-6, '坏钉点所在航点按 B→D 段速插值')
  // 停留：B 与 B' 同位，B 到达 1 h、B' 离开 2 h
  const dw = { id: 'dw', kind: 'sea', pts: pts(A, { ...B, tMs: T0 + H }, { ...B, tMs: T0 + 2 * H }, { ...C, tMs: T0 + 3 * H }), t0Ms: T0 }
  const s = trajStateAt(dw, T0 + 1.5 * H)
  assert.equal(s.moving, true); near(s.lon, 10, 1e-9, '停在 B'); near(s.s, L1, 1e-6, '里程停在 B')
  const s2 = trajStateAt(dw, T0 + 2.5 * H)
  near(s2.lon, 15, 1e-9, '离开 B 后匀速')
  const di = trajWaypointInfo(dw)
  assert.equal(di[2].speedKmh, 0, '停留段段速 0'); assert.ok(Number.isNaN(di[2].courseDeg), '零长段无航向')
  // 零长段允许同刻（重复航点）
  const same = { id: 'same', kind: 'sea', pts: pts(A, { ...B, tMs: T0 + H }, { ...B, tMs: T0 + H }, C), t0Ms: T0, speedKmh: 1000 }
  assert.ok(trajWaypointInfo(same).every((e) => !e.tBad))
})

// ═════════════════ ⑥ 飞行剖面 ═════════════════
t('⑥ 钉点排成匀速时与原式同一条线；变速时爬升按时间积', () => {
  const P = [{ lat: 30, lon: 100 }, { lat: 34, lon: 108 }, { lat: 36, lon: 118 }, { lat: 31, lon: 121 }]
  const base = { id: 'fl0', kind: 'flight', pts: pts(...P), t0Ms: T0, speedKmh: 820 }
  const info0 = trajWaypointInfo(base)
  const pinned = { id: 'fl1', kind: 'flight', pts: pts(...P.map((p, i) => (i ? { ...p, tMs: info0[i].tMs } : p))), t0Ms: T0 }
  const end = trajEndMs(base)
  near(trajEndMs(pinned), end, 1e-6, '到达时刻')
  const a = makeTrajState(), b = makeTrajState()
  let maxDh = 0, maxDs = 0
  for (let i = 0; i <= 400; i++) {
    const tm = T0 + (end - T0) * i / 400
    trajStateAt(base, tm, a); trajStateAt(pinned, tm, b)
    maxDh = Math.max(maxDh, Math.abs(a.altM - b.altM)); maxDs = Math.max(maxDs, Math.abs(a.s - b.s))
    assert.equal(a.phase, b.phase, `相位 i=${i}`)
  }
  // 里程差来自钉点时刻的双精度舍入（ulp × 地速 ≈ 5.7e-5 m），高度差再乘爬升梯度（≈ 0.045）
  const dsTol = TIME_ULP_MS * (820 / 3.6) * 10, dhTol = dsTol * CLIMB_RATE_MS_DEFAULT / (820 / 3.6)
  assert.ok(maxDh < dhTol, `高度最大差 ${maxDh} m（容差 ${dhTol} m）`); assert.ok(maxDs < dsTol, `里程最大差 ${maxDs} m（容差 ${dsTol} m）`)
  // 变速：A→B 0.2°（≈22 km）飞 10 min（慢）、B→C 按缺省 900 km/h。爬升按时间积：B 处 = 爬升率 × 600 s（6096 m，未到巡航），
  // 同样 22 km 按 900 km/h 匀速只够爬 ≈ 906 m —— 慢段爬得陡
  const M10 = 600000
  const sl = { id: 'slow', kind: 'flight', pts: pts({ lat: 0, lon: 0 }, { lat: 0, lon: 0.2, tMs: T0 + M10 }, { lat: 0, lon: 12 }), t0Ms: T0, speedKmh: 900, cruiseAltM: 12000 }
  const iS = trajWaypointInfo(sl)
  near(iS[1].altM, CLIMB_RATE_MS_DEFAULT * 600, 1e-6, 'B 处 = 爬升率 × 600 s')
  const half = trajStateAt(sl, T0 + M10 / 2)
  near(half.altM, CLIMB_RATE_MS_DEFAULT * 300, 1e-6, '5 min = 爬升率 × 300 s')
  near(half.pitchDeg, Math.atan(CLIMB_RATE_MS_DEFAULT / (wgs84DistanceM(0, 0, 0, 0.2) / 600)) * 180 / Math.PI, 1e-9, '俯仰 = atan(爬升率 / 段速)')
  assert.equal(half.phase, 'climb')
  // 过 B 之后换 900 km/h：爬升梯度变缓（同一爬升率、地速大了）
  const after = trajStateAt(sl, T0 + M10 + 60000)
  near(after.altM, CLIMB_RATE_MS_DEFAULT * 660, 1e-6, 'B 后 1 min = 爬升率 × 660 s')
  near(after.pitchDeg, Math.atan(CLIMB_RATE_MS_DEFAULT / (900 / 3.6)) * 180 / Math.PI, 1e-9, '俯仰按 900 km/h')
})

// ═════════════════ ⑦ 逐航点读数 ═════════════════
t('⑦ 逐航点：航向 / 段长 / 实际高度 / 钉点标记', () => {
  const tr = { id: 'wi', kind: 'flight', pts: pts({ lat: 0, lon: 0 }, { lat: 0, lon: 10, altM: 9000 }, { lat: 10, lon: 10 }, { lat: 20, lon: 10 }), t0Ms: T0, speedKmh: 850 }
  const info = trajWaypointInfo(tr)
  near(info[1].courseDeg, 90, 1e-9, '赤道向东'); near(info[2].courseDeg, 0, 1e-9, '子午线向北')
  near(info[1].legM, L1, 1e-6, '段长'); assert.ok(Number.isNaN(info[0].legM))
  assert.equal(info[0].altM, 0, '运动档起点 0 m'); assert.equal(info[3].altM, 0, '运动档终点 0 m')
  assert.equal(info[1].altM, 9000, '钉点高度原值'); assert.equal(info[1].altPinned, true); assert.equal(info[2].altPinned, false)
  near(info[2].altM, trajStateAtS(tr, info[2].sM).altM, 1e-9, '= trajStateAtS')
  // 静止档飞行：各航点 = 巡航（或钉点）
  const st = trajWaypointInfo({ id: 'wiS', kind: 'flight', pts: pts(A, B, C), cruiseAltM: 9500 })
  assert.deepEqual(st.map((e) => e.altM), [9500, 9500, 9500])
  const st2 = trajWaypointInfo({ id: 'wiS2', kind: 'flight', pts: pts(A, B) })
  assert.deepEqual(st2.map((e) => e.altM), [CRUISE_ALT_M_DEFAULT, CRUISE_ALT_M_DEFAULT])
  // 航行恒 0；坐标无效的行给 null（与 pts 等长）
  const sea = trajWaypointInfo({ id: 'wiSea', kind: 'sea', pts: [{ lat: 1, lon: 1, altM: 500 }, { lat: null, lon: 3 }, { lat: 2, lon: 2 }], t0Ms: T0, speedKmh: 30 })
  assert.equal(sea.length, 3); assert.equal(sea[1], null); assert.equal(sea[0].altM, 0); assert.equal(sea[2].altM, 0)
  assert.deepEqual(trajWaypointInfo(null), []); assert.deepEqual(trajWaypointInfo({ pts: [] }), [])
})

// ═════════════════ ⑧ trajLine3 ═════════════════
t('⑧ trajLine3：首末 = 航点、拐点在巡航高度上、静止档全程巡航、航行恒 0', () => {
  const tr = { id: 'l3', kind: 'flight', pts: pts({ lat: 30, lon: 100 }, { lat: 40, lon: 116 }), t0Ms: T0, speedKmh: 830 }
  const line = trajLine3(tr)
  near(line[0].lat, 30, 1e-9, '首纬'); near(line[0].lon, 100, 1e-9, '首经'); near(line.at(-1).lat, 40, 1e-9, '末纬'); near(line.at(-1).lon, 116, 1e-9, '末经')
  assert.equal(line[0].altM, 0); near(line.at(-1).altM, 0, 1e-9, '落地')
  const atCap = line.filter((p) => Math.abs(p.altM - CRUISE_ALT_M_DEFAULT) < 1e-6)
  assert.ok(atCap.length >= 2, '爬升顶点与下降起点都是线上的点')
  // 爬升顶点所在里程 = 巡航 / 爬升梯度；它前一个点在巡航以下（线真的在那里折）
  const iTop = line.findIndex((p) => Math.abs(p.altM - CRUISE_ALT_M_DEFAULT) < 1e-6)
  assert.ok(line[iTop - 1].altM < CRUISE_ALT_M_DEFAULT - 1)
  const sTop = CRUISE_ALT_M_DEFAULT / (CLIMB_RATE_MS_DEFAULT / (830 / 3.6))
  const st = trajStateAtS(tr, sTop)
  near(line[iTop].lat, st.lat, 1e-9, '爬升顶点纬度'); near(line[iTop].lon, st.lon, 1e-9, '爬升顶点经度')
  // 下降起点：终点前 巡航 / tan(3°)
  const sTod = trajLengthM(tr) - CRUISE_ALT_M_DEFAULT / Math.tan(GLIDE_DEG_DEFAULT * Math.PI / 180)
  const std = trajStateAtS(tr, sTod), iTod = line.findLastIndex((p) => Math.abs(p.altM - CRUISE_ALT_M_DEFAULT) < 1e-6)
  near(line[iTod].lat, std.lat, 1e-9, '下降起点纬度'); near(line[iTod].lon, std.lon, 1e-9, '下降起点经度')
  // 相邻点球心角 ≤ 0.5°
  const D2R = Math.PI / 180
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1], q = line[i]
    const c = Math.sin(p.lat * D2R) * Math.sin(q.lat * D2R) + Math.cos(p.lat * D2R) * Math.cos(q.lat * D2R) * Math.cos((q.lon - p.lon) * D2R)
    assert.ok(Math.acos(Math.min(1, c)) / D2R <= 0.5 + 1e-9, `步长 i=${i}`)
  }
  // 三角剖面（短航段）：顶点 = 两斜线交点，在线上
  const tri = trajLine3({ id: 'tri', kind: 'flight', pts: pts({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), t0Ms: T0, speedKmh: 800 })
  const peak = Math.max(...tri.map((p) => p.altM))
  const tc = CLIMB_RATE_MS_DEFAULT / (800 / 3.6), td = Math.tan(GLIDE_DEG_DEFAULT * Math.PI / 180), Lt = wgs84DistanceM(0, 0, 0, 1)
  near(peak, Lt * tc * td / (tc + td), 1e-6, '三角顶点高度')
  // 静止档飞行全程巡航；航行恒 0
  assert.ok(trajLine3({ id: 'l3s', kind: 'flight', pts: pts(A, B), cruiseAltM: 8000 }).every((p) => p.altM === 8000))
  assert.ok(trajLine3({ id: 'l3sea', kind: 'sea', pts: pts(A, B), t0Ms: T0, speedKmh: 30 }).every((p) => p.altM === 0))
  assert.equal(trajLine3({ id: 'l3one', kind: 'flight', pts: pts(A) }).length, 1)
  assert.deepEqual(trajLine3(null), [])
})

// ═════════════════ ⑨ 缓存 ═════════════════
t('⑨ 计划缓存：改钉点即重建；排程下 out 复用（报数）', () => {
  clearTrajPlanCache()
  const tr = { id: 'cc', kind: 'flight', pts: pts(A, { ...B, tMs: T0 + H }, C), t0Ms: T0, speedKmh: 900 }
  const out = makeTrajState()
  trajStateAt(tr, T0 + 1000, out)
  const b0 = trajPlanStats().builds
  for (let i = 0; i < 100; i++) assert.equal(trajStateAt({ ...tr, pts: tr.pts.map((p) => ({ ...p })) }, T0 + i * 60000, out), out)
  assert.equal(trajPlanStats().builds, b0, '同内容新拷贝不重建')
  tr.pts[1].tMs = T0 + 2 * H
  trajStateAt(tr, T0, out)
  assert.equal(trajPlanStats().builds, b0 + 1, '改钉点重建')
  near(trajWaypointInfo(tr)[1].tMs, T0 + 2 * H, 0, '新钉点生效')
  // 改起始 / 速度不重建计划，但排程跟着变
  tr.t0Ms = T0 - H
  near(trajWaypointInfo(tr)[0].tMs, T0 - H, 0, '起始改了'); assert.equal(trajPlanStats().builds, b0 + 1)
  // 报数：排程下每拍开销
  const end = trajEndMs(tr), N = 100000, t1 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) trajStateAt(tr, T0 - H + (end - T0 + H) * (i % 997) / 997, out)
  console.log(`  trajStateAt（排程、飞行）≈ ${(Number(process.hrtime.bigint() - t1) / N).toFixed(0)} ns / 次`)
})

console.log(`trajSchedule: ${n} 项通过`)
