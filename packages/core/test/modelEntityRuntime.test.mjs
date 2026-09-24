// 实体运行时（packages/core/models/entityRuntime.mjs，P4 契约 §1 / §2.2）的回归网。
//
//   ① 零漂移：静止档航迹（无 t0 / speed，或只给了一半）载具逐位钉在末航点、tan 逐位 = sceneHeadTangent；trajMoving 假、trajLinePts null
//   ② 大圆运动：法兰克福 → 纽约 850 km/h、起飞后 3 h：位置 = 解析球面插值（θ = Ω·s/L_wgs84）≤ 1e-9°；航向 = 球面前进方位解析式 ≤ 1e-7°；
//      FL350 巡航 altM = 10668；爬升 pitch > 0、3° 下滑 pitch = −3°
//   ③ GEO 站对星：es-13p1 / vsat-1p2 / dsn-34m × 三站 × GEO 经差 {0, ±40, ±70} 的可见组合：画面视轴经 rig 反算 ≤ 1e-9°、
//      解在限位内、与 WGS-84 读数差 ≤ 0.2°（报最大值）；限位外（13 m 站方位行程 90–270）的北向目标 → held；仰角低于座下限 → 预指向
//   ④ LEO 正过顶（500 km、站在星下点）：天顶那一拍 keyhole 方位逐位沿用上一次；X-Y 座全程连续；az-el 座只在天顶后出现一次
//      物理上躲不开的 180° 方位回转（翻转解超出俯仰上限时）；VSAT 俯仰 > 84° 期间 held、方位不动；落地平后 park、停放俯仰 = min(90, elMax)
//   ⑤ X-Y 座：rig.type 'xy'；天顶目标 → (0, 0)；地平（el = 1°）各方位有解；停放 = (0, 0)
//   ⑥ datum 锚点：船 hull_datum、飞机 fus_datum（liftM = 盒底 − datum）、车 body_datum、地球站盒底（x / y = boresight）、无挂点飞机盒心
//   ⑦ Excel 说明行：trajNoteOf ⇄ parseTrajNote 往返逐位；单位 / 全角 / 时区变体；非法值丢弃；老说明行只出 kind
//   ⑧ 字段规范化：sanitizeMarkers 老存档深相等、坏字段删、好字段留；normTrajMotion 删等于 10668 的 cruiseAltM
//   ⑨ 跟踪滞回：仰角差 0.3° 不换、0.7° 换；上一次已落地平时照换；最高 < 0 → park
//   ⑩ 热路径分配量（采样堆分析，报数 + 宽判据）
//   ⑪ shadeOf：−6° → 0.5、+0.8° → 1、中点 0.75（smoothstep）、sunLit 假恒 1
//   另：键 / 字段工具、pickInto 与 gimbal.pickSolution 逐位、jointValuesOf 与 ground.gimbalValues 同形、aheadPoint、trajLinePts

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as E from '../models/entityRuntime.mjs'
import {
  trajStateAt, makeTrajState, sceneHeadTangent, wgs84DistanceM, CRUISE_ALT_M_DEFAULT, trajEndMs, densifyGreatCircle
} from '../models/trajKinematics.mjs'
import { stationPoseAt, geodeticToEcefKm, enuEcef, stationTrackAzEl, makeStationLook } from '../models/entityPose.mjs'
import { quatRotate } from '../models/attitude.mjs'
import { dirFromGimbal, solveGimbal, pickSolution } from '../models/gimbal.mjs'
import { entityTemplateDoc, ENTITY_TEMPLATE_IDS } from '../models/entityTemplates.mjs'
import { buildAssembly } from '../models/assembly.mjs'
import { gimbalValues } from '../models/components/ground.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const fin = Number.isFinite
const unit = (lat, lon) => { const p = lat * D2R, l = lon * D2R, c = Math.cos(p); return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)] }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const angDeg = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b)) * R2D
const conj = (q) => [-q[0], -q[1], -q[2], q[3]]
const wrap360 = (d) => ((d % 360) + 360) % 360
const azDiff = (a, b) => { const d = Math.abs(wrap360(a) - wrap360(b)); return d > 180 ? 360 - d : d }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)

const BUILT = new Map()
const built = (id) => { if (!BUILT.has(id)) BUILT.set(id, buildAssembly(entityTemplateDoc(id).doc)); return BUILT.get(id) }
const rigOf = (id) => E.aimRigOf(built(id))
// 挂点系方向 → 本体 → 场景
const mountToBody = (f, d) => [f.x[0] * d[0] + f.y[0] * d[1] + f.z[0] * d[2], f.x[1] * d[0] + f.y[1] * d[1] + f.z[1] * d[2], f.x[2] * d[0] + f.y[2] * d[1] + f.z[2] * d[2]]
// 本体视线（地球站 NED）→ ENU 方位 / 仰角（度）
const nedAzEl = (d) => ({ az: wrap360(Math.atan2(d[1], d[0]) * R2D), el: Math.atan2(-d[2], Math.hypot(d[0], d[1])) * R2D })
// 站址 WGS-84 ECEF + 在大地 ENU 里按 (az, el) 放一个目标（km）
function targetAt(lat, lon, azDeg, elDeg, rangeKm = 1000) {
  const S = geodeticToEcefKm(lat, lon, 0), B = enuEcef(lat, lon)
  const a = azDeg * D2R, e = elDeg * D2R, ce = Math.cos(e)
  const d = [0, 1, 2].map((k) => ce * (Math.cos(a) * B.N[k] + Math.sin(a) * B.E[k]) + Math.sin(e) * B.U[k])
  return [S[0] + rangeKm * d[0], S[1] + rangeKm * d[1], S[2] + rangeKm * d[2]]
}

// ═════════════════════════════ 键与字段工具 ═════════════════════════════

t('entityKey / parseEntityKey：三种前缀、载具类别并到 tr:、非法类别 / 空 id → null、原型键不中招', () => {
  assert.equal(E.entityKey('station', 'a1'), 'st:a1')
  assert.equal(E.entityKey('point', 5), 'pt:5')
  assert.equal(E.entityKey('traj', 't'), 'tr:t')
  for (const k of ['aircraft', 'ship', 'vehicle']) assert.equal(E.entityKey(k, 'x'), 'tr:x')
  for (const k of ['bogus', '__proto__', 'toString', undefined, null]) assert.equal(E.entityKey(k, 'x'), null)
  for (const id of ['', null, undefined]) assert.equal(E.entityKey('station', id), null)
  assert.deepEqual(E.parseEntityKey('st:a:b'), { kind: 'station', id: 'a:b' })
  assert.deepEqual(E.parseEntityKey('pt:7'), { kind: 'point', id: '7' })
  assert.deepEqual(E.parseEntityKey('tr:m_1'), { kind: 'traj', id: 'm_1' })
  for (const k of ['xx:1', 'st:', 'st', '', null, 3, 'ST:1']) assert.equal(E.parseEntityKey(k), null)
  for (const [k, id] of [['station', 'q'], ['point', 'r'], ['traj', 's']]) assert.deepEqual(E.parseEntityKey(E.entityKey(k, id)), { kind: k, id })
  assert.deepEqual([...E.ENT_KINDS], ['station', 'point', 'aircraft', 'ship', 'vehicle'])
  assert.equal(E.trajEntityKind({ kind: 'flight' }), 'aircraft')
  assert.equal(E.trajEntityKind({ kind: 'sea' }), 'ship')
  assert.equal(E.trajEntityKind(null), 'ship')
})

t('normEntityModel / normTrack / resolveEntityPx', () => {
  assert.deepEqual(E.normEntityModel({ id: 'ent:a320neo' }), { id: 'ent:a320neo' })
  assert.deepEqual(E.normEntityModel({ id: 'ent:a320neo', px: 48 }), { id: 'ent:a320neo', px: 48 })
  assert.deepEqual(E.normEntityModel({ id: 'ent:a320neo', px: 48.4 }), { id: 'ent:a320neo', px: 48 })
  assert.deepEqual(E.normEntityModel({ id: 'ent:a320neo', px: 300 }), { id: 'ent:a320neo', px: 256 })
  assert.deepEqual(E.normEntityModel({ id: 'ent:a320neo', px: 3 }), { id: 'ent:a320neo', px: 8 })
  for (const px of [NaN, Infinity, '48', null]) assert.deepEqual(E.normEntityModel({ id: 'ent:a320neo', px }), { id: 'ent:a320neo' })
  for (const id of ['param:default-bus', 'asm:0123456789ab', 'user:0123456789ab', 'nasa:iss', 'stk:0123456789ab']) assert.deepEqual(E.normEntityModel({ id }), { id })
  assert.deepEqual(E.normEntityModel('ent:vsat-1p2'), { id: 'ent:vsat-1p2' })
  for (const v of [null, undefined, {}, { id: '' }, { id: 'bad' }, { id: 'ent:A' }, [], 'nope', 3]) assert.equal(E.normEntityModel(v), null)
  const src = { id: 'ent:a320neo', px: 48, extra: 1 }
  assert.notEqual(E.normEntityModel(src), src, '新对象')
  assert.deepEqual(E.normTrack({ kind: 'sat', satKey: 'norad:25544' }), { kind: 'sat', satKey: 'norad:25544' })
  assert.deepEqual(E.normTrack({ kind: 'sat', satKey: 'cc:grp:s1' }), { kind: 'sat', satKey: 'cc:grp:s1' })
  assert.deepEqual(E.normTrack({ kind: 'sat', satKey: 'norad:25544', el: true }), { kind: 'sat', satKey: 'norad:25544', el: true })
  assert.deepEqual(E.normTrack({ kind: 'sat', satKey: 'norad:25544', az: true, el: 1 }), { kind: 'sat', satKey: 'norad:25544', az: true })
  assert.deepEqual(E.normTrack({ kind: 'sat', satKey: 'norad:25544', el: 1 }), { kind: 'sat', satKey: 'norad:25544' })
  for (const v of [{ kind: 'focus' }, { kind: 'sat' }, { kind: 'sat', satKey: 'bad key' }, { kind: 'sat', satKey: 'norad:0' }, null, 'sat', {}]) assert.equal(E.normTrack(v), null)
  assert.equal(E.resolveEntityPx({ id: 'x', px: 64 }, 28), 64)
  assert.equal(E.resolveEntityPx({ id: 'x' }, 28), 28)
  assert.equal(E.resolveEntityPx(null, 300), 256)
  assert.equal(E.resolveEntityPx(null, 2), 8)
  assert.equal(E.resolveEntityPx(null, NaN), 28)
  assert.equal(E.resolveEntityPx({ px: 40.6 }, 28), 41)
})

// ═════════════════════════════ ① 零漂移 ═════════════════════════════

t('① 静止档（无 t0 / speed 或只给一半、速度非正、单点）：载具逐位钉末航点、tan 逐位 = sceneHeadTangent；trajMoving 假、trajLinePts null', () => {
  const pts = [{ lat: 31.2, lon: 121.5 }, { lat: 35.6, lon: 139.7 }, { lat: 37.6, lon: 126.8 }]
  const T = Date.UTC(2026, 8, 24, 4)
  const variants = [
    {}, { speedKmh: 850 }, { t0Ms: T }, { t0Ms: T, speedKmh: 0 }, { t0Ms: T, speedKmh: -5 }, { t0Ms: NaN, speedKmh: 850 },
    { t0Ms: T, speedKmh: NaN }, { cruiseAltM: 9000 }
  ]
  const exp = [0, 0, 0]
  assert.ok(sceneHeadTangent(pts[1].lat, pts[1].lon, pts[2].lat, pts[2].lon, exp))
  let k = 0
  for (const kind of ['flight', 'sea']) {
    for (const v of variants) {
      const tr = { id: `z${k++}`, kind, pts, ...v }
      for (const tm of [T - 86400000, T, T + 3600000, NaN]) {
        const s = E.vehicleStateAt(tr, tm, makeTrajState())
        assert.ok(s.ok && !s.moving, `${JSON.stringify(v)} 静止档`)
        assert.ok(Object.is(s.lat, pts[2].lat) && Object.is(s.lon, pts[2].lon), '末航点逐位')
        assert.ok(s.hasTan && s.tan.every((x, i) => Object.is(x, exp[i])), 'tan 逐位 = sceneHeadTangent')
      }
      assert.equal(E.trajMoving(tr), false)
      assert.equal(E.trajLinePts(tr), null)
    }
  }
  // 单点 / 全重复：静止档、无切向
  const one = { id: 'one', kind: 'flight', pts: [{ lat: 10, lon: 20 }], t0Ms: T, speedKmh: 800 }
  const s1 = E.vehicleStateAt(one, T + 1000)
  assert.ok(Object.is(s1.lat, 10) && Object.is(s1.lon, 20) && !s1.hasTan && !s1.moving)
  assert.equal(E.trajMoving(one), false)
  const dup = { id: 'dup', kind: 'sea', pts: [{ lat: 1, lon: 2 }, { lat: 1, lon: 2 }], t0Ms: T, speedKmh: 30 }
  assert.equal(E.trajMoving(dup), false)
  assert.equal(E.trajLinePts(dup), null)
})

// ═════════════════════════════ ② 大圆运动 ═════════════════════════════

t('② 大圆运动（法兰克福 → 纽约，850 km/h，FL350）：位置 ≤ 1e-9°、航向 ≤ 1e-7°、巡航 10668 m、爬升 / 3° 下滑', () => {
  const T0 = Date.UTC(2026, 8, 24, 4)
  const A = { lat: 50.03, lon: 8.57 }, B = { lat: 40.64, lon: -73.78 }
  const tr = { id: 'fra-jfk', kind: 'flight', pts: [A, B], t0Ms: T0, speedKmh: 850 }
  assert.equal(E.trajMoving(tr), true)
  const L = wgs84DistanceM(A.lat, A.lon, B.lat, B.lon), v = 850 / 3.6
  const a = unit(A.lat, A.lon), b = unit(B.lat, B.lon), Om = Math.atan2(len(cross(a, b)), dot(a, b))
  const st = makeTrajState()
  let worstP = 0, worstH = 0
  for (const hr of [0.5, 1, 2, 3, 4, 5, 6]) {
    const tm = T0 + hr * 3600000
    E.vehicleStateAt(tr, tm, st)
    const s = (tm - T0) / 1000 * v
    const th = Om * s / L, sO = Math.sin(Om)
    const P = [0, 1, 2].map((k) => (Math.sin(Om - th) * a[k] + Math.sin(th) * b[k]) / sO)
    const lat = Math.atan2(P[2], Math.hypot(P[0], P[1])) * R2D, lon = Math.atan2(P[1], P[0]) * R2D
    worstP = Math.max(worstP, Math.abs(st.lat - lat), Math.abs(st.lon - lon))
    // 球面「前进方位」：以当地点为起点指向 B
    const p1 = st.lat * D2R, p2 = B.lat * D2R, dl = (B.lon - st.lon) * D2R
    const hd = wrap360(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * R2D)
    worstH = Math.max(worstH, azDiff(st.headingDeg, hd))
    if (hr === 3) { assert.equal(st.altM, CRUISE_ALT_M_DEFAULT, '3 h 巡航 FL350'); assert.equal(st.pitchDeg, 0); assert.equal(st.phase, 'cruise') }
  }
  assert.ok(worstP <= 1e-9, `位置差 ${worstP}°`)
  assert.ok(worstH <= 1e-7, `航向差 ${worstH}°`)
  // 爬升段：起飞后 5 min
  E.vehicleStateAt(tr, T0 + 300000, st)
  assert.ok(st.phase === 'climb' && st.pitchDeg > 0 && st.altM > 0 && st.altM < CRUISE_ALT_M_DEFAULT, `爬升 ${st.phase} ${st.pitchDeg}`)
  // 下滑段：距终点 50 km
  E.vehicleStateAt(tr, T0 + (L - 50000) / v * 1000, st)
  assert.ok(st.phase === 'descent', st.phase)
  near(st.pitchDeg, -3, 1e-9, '3° 下滑')
  near(st.altM, 50000 * Math.tan(3 * D2R), 1e-3, '下滑高度')
  // 两端
  E.vehicleStateAt(tr, T0 - 1000, st)
  assert.ok(st.phase === 'pre' && st.altM === 0 && Object.is(st.lat, A.lat))
  E.vehicleStateAt(tr, trajEndMs(tr) + 1000, st)
  assert.ok(st.phase === 'done' && st.done && Object.is(st.lon, B.lon))
  // trajLinePts = 大圆加密
  assert.deepEqual(E.trajLinePts(tr), densifyGreatCircle(tr.pts))
  console.log(`  大圆运动：位置最大差 ${worstP.toExponential(2)}°、航向最大差 ${worstH.toExponential(2)}°`)
})

// ═════════════════════════════ ③ GEO 站对星 ═════════════════════════════

t('③ GEO 站对星：画面视轴反算 ≤ 1e-9°、解在限位内、与 WGS-84 读数差 ≤ 0.2°；限位外北向目标 → held', () => {
  const stations = [[40.0, 116.4], [-33.9, 18.4], [64.1, -21.9]]
  let checked = 0, held = 0, pre = 0, worstRecon = 0, worstAz = 0, worstEl = 0, worstSep = 0
  const sol = { a1: 0, a2: 0, singular: false }, pk = { a1: 0, a2: 0 }
  for (const id of ['ent:es-13p1', 'ent:vsat-1p2', 'ent:dsn-34m']) {
    const rig = rigOf(id)
    assert.ok(rig && rig.type === 'azel', `${id} rig`)
    for (const [lat, lon] of stations) {
      const q = stationPoseAt(lat, lon).qB2S
      for (const dl of [0, 40, -40, 70, -70]) {
        const ecef = geodeticToEcefKm(0, lon + dl, 35786)
        const tr = E.makeTrackState()
        const idx = E.pickTrackTarget({ lat, lon, altM: 0 }, [{ key: 'geo', ecef }], 1, tr)
        assert.equal(idx, 0)
        if (tr.park) { assert.ok(tr.look.elDeg < 0); continue }
        const db = quatRotate(conj(q), tr.aim.dir)
        const as = E.makeAimState()
        const ok = E.solveAim(rig, db, as)
        // 参照路径：gimbal.solveGimbal 主解 → pickSolution（参考 = init）
        const dm = [dot(db, rig.frame.x), dot(db, rig.frame.y), dot(db, rig.frame.z)]
        solveGimbal(rig.type, dm, rig.init.a1, sol)
        const refOk = pickSolution(sol.a1, sol.a2, rig.lim, rig.init.a1, rig.init.a2, pk)
        assert.equal(ok, refOk, `${id} (${lat},${lon})→${lon + dl}：有解与参照一致`)
        if (!ok) {
          if (as.pre) {
            // 预指向（§8-4）：目标俯仰低于座的下限 → 方位对准、俯仰夹到下限
            pre++
            assert.ok(!as.held && tr.aim.elDeg < rig.lim.a2Min + 0.2 && as.a2 === rig.lim.a2Min, `${id} 预指向俯仰 = 下限：${as.a2}`)
            const ae = nedAzEl(mountToBody(rig.frame, dirFromGimbal(rig.type, as.a1, as.a2)))
            near(azDiff(ae.az, tr.aim.azDeg), 0, 1e-9, '预指向方位对准目标')
            continue
          }
          held++
          assert.ok(as.held && as.a1 === rig.init.a1 && as.a2 === rig.init.a2, '首次无解取 init')
          continue
        }
        assert.ok(Object.is(as.a1, pk.a1) && Object.is(as.a2, pk.a2), '与 gimbal.pickSolution 逐位')
        const L = rig.lim
        assert.ok(as.a1 >= L.a1Min - 1e-9 && as.a1 <= L.a1Max + 1e-9 && as.a2 >= L.a2Min - 1e-9 && as.a2 <= L.a2Max + 1e-9, '解在限位内')
        const body = mountToBody(rig.frame, dirFromGimbal(rig.type, as.a1, as.a2))
        const rec = angDeg(quatRotate(q, body), tr.aim.dir)
        worstRecon = Math.max(worstRecon, rec)
        // 画面口径的罗盘方位 / 仰角 = 本体 NED 里的方位仰角
        const ae = nedAzEl(body)
        near(azDiff(ae.az, tr.aim.azDeg), 0, 1e-9, '画面方位')
        near(ae.el, tr.aim.elDeg, 1e-9, '画面仰角')
        worstAz = Math.max(worstAz, azDiff(ae.az, tr.look.azDeg))
        worstEl = Math.max(worstEl, Math.abs(ae.el - tr.look.elDeg))
        // WGS-84 读数方向与画面视轴的夹角
        const la = tr.look.azDeg * D2R, le = tr.look.elDeg * D2R
        worstSep = Math.max(worstSep, angDeg(body, [Math.cos(le) * Math.cos(la), Math.cos(le) * Math.sin(la), -Math.sin(le)]))
        checked++
      }
    }
  }
  assert.ok(worstRecon <= 1e-9, `反算视轴差 ${worstRecon}°`)
  assert.ok(worstAz <= 0.2 && worstEl <= 0.2 && worstSep <= 0.2, `与 WGS-84 差：方位 ${worstAz}° 仰角 ${worstEl}° 夹角 ${worstSep}°`)
  assert.ok(checked >= 25 && held >= 5, `可见组合 ${checked}、held ${held}`)
  console.log(`  GEO：${checked} 组有解、${held} 组限位外、${pre} 组预指向；反算 ${worstRecon.toExponential(2)}°；与 WGS-84 最大差 方位 ${worstAz.toFixed(4)}° 仰角 ${worstEl.toFixed(4)}° 夹角 ${worstSep.toFixed(4)}°`)
  // 13 m 站（方位行程 90–270 = 朝南半圈）：正北仰角 30° 的目标无解；先有一个南向解，之后北向目标保持上一次
  const rig = rigOf('ent:es-13p1')
  const as = E.makeAimState()
  const north = [Math.cos(30 * D2R), 0, -Math.sin(30 * D2R)], south = [-Math.cos(40 * D2R), 0.1, -Math.sin(40 * D2R)]
  assert.equal(E.solveAim(rig, north, as), false)
  assert.ok(as.held && as.a1 === 180 && as.a2 === 35, `北向 held 取 init：${as.a1} ${as.a2}`)
  assert.equal(E.solveAim(rig, south, as), true)
  const keep = [as.a1, as.a2]
  assert.ok(!as.held && as.ok)
  assert.equal(E.solveAim(rig, north, as), false)
  assert.ok(as.held && as.a1 === keep[0] && as.a2 === keep[1], '北向 held 保持上一次')
  // {x,y,z} 形式的视线同样可用
  const as2 = E.makeAimState()
  assert.equal(E.solveAim(rig, { x: south[0], y: south[1], z: south[2] }, as2), true)
  assert.ok(Object.is(as2.a1, keep[0]) && Object.is(as2.a2, keep[1]))
})

// ═════════════════════════════ ④ LEO 正过顶 ═════════════════════════════

t('④ LEO 正过顶（500 km）：keyhole 方位逐位沿用；X-Y 连续；az-el 只有天顶后一次必然的 180° 回转；VSAT > 84° held；落地平 park', () => {
  const lat0 = 30, lon0 = 100, H = 500, HD = 30
  const w = Math.sqrt(398600.4418 / (6371 + H)) / (6371 + H) * R2D           // 星下点角速率（°/s，忽略地转：只要轨迹光滑）
  const q = stationPoseAt(lat0, lon0).qB2S
  const stLla = { lat: lat0, lon: lon0, altM: 0 }
  const ap = { lat: 0, lon: 0 }
  const report = []
  let worstSep = 0
  for (const id of ['ent:es-4p5', 'ent:vsat-1p2', 'ent:dsn-34m', 'ent:es-xy-2p4', 'ent:ulcs-24k']) {
    const rig = rigOf(id)
    const tr = E.makeTrackState(), as = E.makeAimState()
    let prev = null, jumps = [], heldHi = 0, keyholeChecked = false, parkedEnd = null
    for (let s = -480; s <= 480; s++) {
      E.aheadPoint(lat0, lon0, HD, w * s, ap)
      const ecef = geodeticToEcefKm(ap.lat, ap.lon, H)
      E.pickTrackTarget(stLla, [{ key: 'leo', ecef }], 1, tr)
      const pa1 = as.a1, pa2 = as.a2
      let ok = false
      if (tr.park) E.parkAim(rig, as)
      else ok = E.solveAim(rig, quatRotate(conj(q), tr.aim.dir), as)
      if (!tr.park) {
        const la = tr.look.azDeg * D2R, le = tr.look.elDeg * D2R, aa = tr.aim.azDeg * D2R, ae = tr.aim.elDeg * D2R
        const dW = [Math.cos(le) * Math.cos(la), Math.cos(le) * Math.sin(la), Math.sin(le)], dA = [Math.cos(ae) * Math.cos(aa), Math.cos(ae) * Math.sin(aa), Math.sin(ae)]
        worstSep = Math.max(worstSep, angDeg(dW, dA))
      }
      if (s === 0) {
        assert.ok(tr.aim.singular, `${id}：天顶拍应是 keyhole（el ${tr.aim.elDeg}）`)
        // az-el 座的奇点在天顶（方位轴）：方位逐位沿用上一次；X-Y 座的奇点在东西地平，天顶是普通点（解 ≈ (0, 0)）
        if (ok && rig.type === 'azel') { assert.ok(Object.is(as.a1, pa1), `${id}：keyhole 方位逐位沿用 ${pa1} → ${as.a1}`); keyholeChecked = true }
        if (ok && rig.type === 'xy') { assert.ok(Math.abs(as.a1) < 1e-9 && Math.abs(as.a2) < 1e-9, `${id}：X-Y 天顶 ≈ (0, 0)`); keyholeChecked = true }
      }
      if (as.held && !tr.park && tr.aim.elDeg > rig.lim.a2Max) {
        heldHi++
        assert.ok(Object.is(as.a1, pa1) && Object.is(as.a2, pa2), `${id}：held 期间保持`)
      }
      // 跟踪中（非停放、有解）的方位跳变：与上一个有解的拍比（中间隔着 held 的也算——VSAT / DSN 的回转发生在俯仰上限以上那段之后）
      if (ok && prev) {
        const d1 = Math.abs(as.a1 - prev.a1), d2 = Math.abs(as.a2 - prev.a2)
        if (d1 > 90) jumps.push({ s, d1, el: tr.aim.elDeg, a2: as.a2, gap: s - prev.s })
        if (rig.type === 'xy') assert.ok(d1 < 5 && d2 < 5 && s - prev.s === 1, `${id}：X-Y 每秒变化 ${d1} / ${d2}`)
      }
      if (tr.park) prev = null
      else if (ok) prev = { s, a1: as.a1, a2: as.a2 }
      if (s === 480) parkedEnd = { park: tr.park, a1: as.a1, a2: as.a2, prevA1: pa1 }
    }
    // 落地平：停放
    assert.ok(parkedEnd.park, `${id}：+8 min 已落地平`)
    if (rig.type === 'azel') {
      assert.equal(parkedEnd.a2, Math.min(90, rig.lim.a2Max), `${id}：停放俯仰`)
      assert.ok(Object.is(parkedEnd.a1, parkedEnd.prevA1), `${id}：停放方位保持`)
    } else assert.ok(parkedEnd.a1 === 0 && parkedEnd.a2 === 0, `${id}：X-Y 停放 (0, 0)`)
    if (rig.type === 'xy') { assert.equal(jumps.length, 0); assert.ok(keyholeChecked, 'X-Y 天顶有解') }
    else {
      // az-el：跟踪期间至多一次 |Δa1| > 90°，且是物理必然的天顶回转（≈ 180°、翻转解的俯仰 180 − el 超上限）
      assert.ok(jumps.length <= 1, `${id}：跳变 ${JSON.stringify(jumps)}`)
      for (const j of jumps) {
        near(j.d1, 180, 1, `${id}：回转量`)
        assert.ok(180 - j.el > rig.lim.a2Max - 1e-9 || 180 - j.el < rig.lim.a2Min, `${id}：翻转解可用时不该回转（el ${j.el}）`)
      }
      // 正过顶：az-el 座必然回转一次；俯仰上限 ≤ 90° 的在天顶之后（隔着上限以上的 held 段），翻转座（上限 > 90°）拖到 el ≈ 180 − 上限
      assert.equal(jumps.length, 1, `${id}：回转次数`)
      if (rig.lim.a2Max <= 90) assert.ok(jumps[0].s > 0 && jumps[0].s <= 30, `${id}：回转在天顶后 ${jumps[0].s} s`)
      else assert.ok(Math.abs(jumps[0].el - (180 - rig.lim.a2Max)) < 1, `${id}：翻转座在 el ≈ ${180 - rig.lim.a2Max}° 才回转（${jumps[0].el}）`)
      if (rig.lim.a2Max >= 90) assert.ok(keyholeChecked, `${id}：天顶 keyhole 有解`)
      if (rig.lim.a2Max < 90) assert.ok(heldHi > 0, `${id}：俯仰上限以上 held`)
    }
    report.push(`${id.slice(4)} 回转 ${jumps.length}、held(>上限) ${heldHi}`)
  }
  assert.ok(worstSep <= 0.2, `LEO 画面 / 读数夹角 ${worstSep}°`)
  console.log(`  LEO 过顶：${report.join('；')}；画面与 WGS-84 最大夹角 ${worstSep.toFixed(4)}°`)
})

// ═════════════════════════════ ⑤ X-Y 座 ═════════════════════════════

t('⑤ X-Y 座：type xy、天顶 → (0, 0)、地平 1° 各方位有解且反算 ≤ 1e-9°、停放 (0, 0)', () => {
  const rig = rigOf('ent:es-xy-2p4')
  assert.equal(rig.type, 'xy')
  assert.equal(rig.s1, 'xAxis'); assert.equal(rig.s2, 'yAxis')
  const as = E.makeAimState()
  assert.equal(E.solveAim(rig, [0, 0, -1], as), true)
  assert.ok(Math.abs(as.a1) < 1e-12 && Math.abs(as.a2) < 1e-12, `天顶 ${as.a1} ${as.a2}`)
  for (let az = 0; az < 360; az += 15) {
    const e = 1 * D2R, a = az * D2R
    const d = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), -Math.sin(e)]
    assert.equal(E.solveAim(rig, d, as), true, `地平方位 ${az}° 有解`)
    assert.ok(angDeg(mountToBody(rig.frame, dirFromGimbal('xy', as.a1, as.a2)), d) <= 1e-9)
  }
  E.parkAim(rig, as)
  assert.ok(Math.abs(as.a1) < 1e-12 && Math.abs(as.a2) < 1e-12 && as.ok && !as.held)
  // 首次停放（NaN 状态）同样 (0, 0)
  const fresh = E.makeAimState()
  E.parkAim(rig, fresh)
  assert.ok(Math.abs(fresh.a1) < 1e-12 && Math.abs(fresh.a2) < 1e-12)
})

// ═════════════════════════════ ⑥ datum 锚点 ═════════════════════════════

t('⑥ 锚点：船 hull_datum、飞机 fus_datum + liftM、车 body_datum、地球站盒底（boresight x/y）、无挂点飞机盒心', () => {
  const info = (id) => { const r = built(id); return { attachPoints: r.attachPoints, box: r.bboxBody } }
  const apOf = (id, name) => built(id).attachPoints.find((a) => a.name === name)
  let o = E.anchorBodyOf(info('ent:ulcs-24k'), 'ship')
  assert.equal(o.src, 'datum'); assert.deepEqual(o.pos, apOf('ent:ulcs-24k', 'hull_datum').posBody); assert.equal(o.liftM, 0)
  // 水线以下还有船体（吃水）：盒底在 datum 之下
  assert.ok(built('ent:ulcs-24k').bboxBody.max[2] - o.pos[2] > 10, '吃水 > 10 m')
  o = E.anchorBodyOf(info('ent:a320neo'), 'aircraft')
  const fd = apOf('ent:a320neo', 'fus_datum')
  assert.equal(o.src, 'datum'); assert.deepEqual(o.pos, fd.posBody)
  assert.ok(o.liftM > 0 && Object.is(o.liftM, built('ent:a320neo').bboxBody.max[2] - fd.posBody[2]), `liftM ${o.liftM}`)
  o = E.anchorBodyOf(info('ent:suv-cotm'), 'vehicle')
  assert.equal(o.src, 'datum'); assert.deepEqual(o.pos, apOf('ent:suv-cotm', 'body_datum').posBody); assert.equal(o.liftM, 0)
  const b13 = built('ent:es-13p1'), rb = apOf('ent:es-13p1', 'refl_boresight')
  o = E.anchorBodyOf(info('ent:es-13p1'), 'station')
  assert.equal(o.src, 'bottom')
  assert.ok(Object.is(o.pos[0], rb.posBody[0]) && Object.is(o.pos[1], rb.posBody[1]) && Object.is(o.pos[2], b13.bboxBody.max[2]))
  assert.equal(o.liftM, 0)
  // 无挂点的飞机 → 盒心；liftM = 半高
  const box = { min: [-10, -8, -3], max: [10, 8, 5] }
  o = E.anchorBodyOf({ attachPoints: [], box }, 'aircraft')
  assert.equal(o.src, 'center'); assert.deepEqual(o.pos, [0, 0, 1]); assert.equal(o.liftM, 4)
  // 无 boresight 的站 / 点 → 盒底盒心
  o = E.anchorBodyOf({ box }, 'point')
  assert.equal(o.src, 'bottom'); assert.deepEqual(o.pos, [0, 0, 5]); assert.equal(o.liftM, 0)
  // 飞机模型挂到站 / 点上：info.modelKind = 'aircraft' 时给离地保护（渲染端按 max(altM, liftM) 用）
  const a = info('ent:a320neo')
  assert.equal(E.anchorBodyOf(a, 'point').liftM, 0)
  assert.ok(E.anchorBodyOf({ ...a, modelKind: 'aircraft' }, 'point').liftM > 0)
  // out 复用、坏盒不炸
  const out = E.makeAnchor()
  assert.equal(E.anchorBodyOf({ attachPoints: null, box: null }, 'station', out), out)
  assert.deepEqual(out.pos, [0, 0, 0]); assert.equal(out.src, 'bottom')
  // 全部内置模板：锚点有限、datum 模板都走 datum
  for (const id of ENTITY_TEMPLATE_IDS) {
    const r = built(id), kind = /^ent:(vsat|es|dsn)/.test(id) ? 'station' : (r.attachPoints.some((p) => p.name === 'fus_datum') ? 'aircraft' : (r.attachPoints.some((p) => p.name === 'hull_datum') ? 'ship' : 'vehicle'))
    const x = E.anchorBodyOf({ attachPoints: r.attachPoints, box: r.bboxBody }, kind)
    assert.ok(x.pos.every(fin) && fin(x.liftM), id)
    assert.equal(x.src, kind === 'station' ? 'bottom' : 'datum', id)
  }
})

// ═════════════════════════════ ⑦ Excel 说明行 ═════════════════════════════

t('⑦ 说明行：往返逐位；单位 / 全角 / 时区变体；非法值丢弃；老说明行只出 kind', () => {
  const T8 = Date.UTC(2026, 8, 24, 8)
  const cases = [
    { kind: 'flight', cruiseAltM: 11277.6, speedKmh: 851.3, t0Ms: T8 + 123, model: { id: 'ent:a320neo', px: 48 } },
    { kind: 'flight', cruiseAltM: 0, speedKmh: 5000, t0Ms: T8, model: { id: 'nasa:iss' } },
    { kind: 'sea', speedKmh: 37, t0Ms: T8 - 6 * 3600000, model: { id: 'ent:ulcs-24k', px: 256 } },
    { kind: 'sea', speedKmh: 1e-7 },
    { kind: 'flight', t0Ms: Date.UTC(2026, 0, 1, 0, 0, 0, 5) }
  ]
  for (const c of cases) {
    const note = E.trajNoteOf(c)
    const p = E.parseTrajNote(note)
    assert.deepEqual(p, c, `往返：${note}`)
    for (const k of ['cruiseAltM', 'speedKmh', 't0Ms']) if (k in c) assert.ok(Object.is(p[k], c[k]), `${k} 逐位`)
  }
  assert.equal(E.trajNoteOf(cases[0]), '飞行; 巡航高度=11277.6 m; 速度=851.3 km/h; 起始=2026-09-24T08:00:00.123Z; 模型=ent:a320neo; 图标=48 px')
  // 航行航迹上的 cruiseAltM 不写；老对象 = '飞行' / '航行'
  assert.equal(E.trajNoteOf({ kind: 'sea', cruiseAltM: 9000, pts: [] }), '航行')
  assert.equal(E.trajNoteOf({ kind: 'flight', pts: [{ lat: 1, lon: 2 }] }), '飞行')
  assert.equal(E.trajNoteOf(null), '航行')
  // 非法字段不写
  assert.equal(E.trajNoteOf({ kind: 'flight', cruiseAltM: -1, speedKmh: 0, t0Ms: NaN, model: { id: 'bad', px: 48 } }), '飞行')
  assert.equal(E.trajNoteOf({ kind: 'flight', model: { id: 'ent:a320neo', px: 300 } }), '飞行; 模型=ent:a320neo')
  // 变体
  const P = E.parseTrajNote
  assert.deepEqual(P('飞行; 巡航高度=FL350'), { kind: 'flight', cruiseAltM: 10668 })
  assert.deepEqual(P('飞行; 巡航高度 = fl 350'), { kind: 'flight', cruiseAltM: 10668 })
  assert.deepEqual(P('飞行; 高度=35000 ft'), { kind: 'flight', cruiseAltM: 10668 })
  assert.deepEqual(P('飞行; cruise: 10.668 km'), { kind: 'flight', cruiseAltM: 10668 })
  assert.deepEqual(P('飞行; Cruise Alt = 10668'), { kind: 'flight', cruiseAltM: 10668 })
  assert.deepEqual(P('飞行; 速度=450 kn'), { kind: 'flight', speedKmh: 833.4 })
  assert.deepEqual(P('航行; 航速=20 节'), { kind: 'sea', speedKmh: 37.04 })
  assert.deepEqual(P('航行; speed=12 m/s'), { kind: 'sea', speedKmh: 43.2 })
  assert.deepEqual(P('航行; GS=100 mph'), { kind: 'sea', speedKmh: 160.9344 })
  assert.deepEqual(P('飞行；巡航高度＝１０６６８ｍ；速度：８５０'), { kind: 'flight', cruiseAltM: 10668, speedKmh: 850 })
  assert.deepEqual(P('飞行; 起始=2026-09-24 08:00'), { kind: 'flight', t0Ms: T8 })
  assert.deepEqual(P('飞行; 起始=2026-09-24T16:00+08:00'), { kind: 'flight', t0Ms: T8 })
  assert.deepEqual(P('飞行; 起飞时刻=2026/9/24 3:00 -05'), { kind: 'flight', t0Ms: T8 })
  assert.deepEqual(P('飞行; start: 2026–09–24T08:00:00 UTC'), { kind: 'flight', t0Ms: T8 })
  assert.deepEqual(P('飞行; 模型=ent:a320neo; 图标=64'), { kind: 'flight', model: { id: 'ent:a320neo', px: 64 } })
  assert.deepEqual(P('飞行; 图标=64 px'), { kind: 'flight' }, '没有模型时图标丢弃')
  // 非法值丢弃
  assert.deepEqual(P('飞行; 速度=-5; 图标=300; 模型=bad; 起始=2026-02-30; 巡航高度=40000'), { kind: 'flight' })
  assert.deepEqual(P('飞行; 速度=0; 巡航高度=-10 m; 起始=2026-13-01'), { kind: 'flight' })
  assert.deepEqual(P('飞行; 速度=6000; 模型=ent:a320neo; 图标=7'), { kind: 'flight', model: { id: 'ent:a320neo' } })
  // 老说明行：只出 kind（与 trajKindOf 同式）
  assert.deepEqual(P('飞行'), { kind: 'flight' })
  assert.deepEqual(P('航行'), { kind: 'sea' })
  assert.deepEqual(P('Flight A'), { kind: 'flight' })
  assert.deepEqual(P('FLIGHT'), { kind: 'flight' })
  assert.deepEqual(P(''), { kind: 'sea' })
  assert.deepEqual(P(null), { kind: 'sea' })
  assert.deepEqual(P(undefined), { kind: 'sea' })
  assert.deepEqual(P('航线：上海 → 东京'), { kind: 'sea' })
  // 模型 id 里的字样不误判类型
  assert.deepEqual(P('航行; 模型=nasa:space-flight-x'), { kind: 'sea', model: { id: 'nasa:space-flight-x' } })
})

t('⑦ parseDateTimeText / partsToUtcMs / formatUtcIso', () => {
  const D = E.parseDateTimeText
  assert.deepEqual(D('2026-09-24T08:00:00Z'), { Y: 2026, Mo: 9, D: 24, h: 8, mi: 0, s: 0, ms: 0, offMin: 0 })
  assert.deepEqual(D('2026-09-24 08:05'), { Y: 2026, Mo: 9, D: 24, h: 8, mi: 5, s: 0, ms: 0, offMin: null })
  assert.deepEqual(D('2026/9/4 8:05:07.5 utc'), { Y: 2026, Mo: 9, D: 4, h: 8, mi: 5, s: 7, ms: 500, offMin: 0 })
  assert.deepEqual(D('2026.09.24T08:00:00.05+0530'), { Y: 2026, Mo: 9, D: 24, h: 8, mi: 0, s: 0, ms: 50, offMin: 330 })
  assert.deepEqual(D('２０２６－０９－２４　０８：００'), { Y: 2026, Mo: 9, D: 24, h: 8, mi: 0, s: 0, ms: 0, offMin: null })
  assert.deepEqual(D('2026-09-24'), { Y: 2026, Mo: 9, D: 24, h: 0, mi: 0, s: 0, ms: 0, offMin: null })
  assert.deepEqual(D('2024-02-29 GMT'), { Y: 2024, Mo: 2, D: 29, h: 0, mi: 0, s: 0, ms: 0, offMin: 0 })
  assert.deepEqual(D('2026-09-24T08:00−03:30'), { Y: 2026, Mo: 9, D: 24, h: 8, mi: 0, s: 0, ms: 0, offMin: -210 })
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-09-31', '2026-09-24T24:00', '2026-09-24T08:60', '2026-09-24T08:00:60',
    '2026-09-24T08:00+25:00', '2026-09-24T08:00+08:61', '26-09-24', '2026-09-24T', 'x', '', null, undefined, '2026-09-24 08:00 PST']) assert.equal(D(bad), null, String(bad))
  const T8 = Date.UTC(2026, 8, 24, 8)
  assert.equal(E.partsToUtcMs(D('2026-09-24 16:00'), 480), T8, '没写时区按调用方给的偏移（东八区）')
  assert.equal(E.partsToUtcMs(D('2026-09-24 08:00')), T8, '缺省 UTC')
  assert.equal(E.partsToUtcMs(D('2026-09-24T08:00Z'), 480), T8, '写了时区不用缺省偏移')
  assert.ok(Number.isNaN(E.partsToUtcMs(null)))
  // 0–99 年不走 Date.UTC 的 19xx 映射
  const y50 = E.partsToUtcMs(D('0050-01-01T00:00:00Z'))
  assert.equal(new Date(y50).getUTCFullYear(), 50)
  assert.equal(E.formatUtcIso(y50), '0050-01-01T00:00:00Z')
  assert.equal(E.formatUtcIso(T8), '2026-09-24T08:00:00Z')
  assert.equal(E.formatUtcIso(T8 + 7), '2026-09-24T08:00:00.007Z')
  for (const bad of [NaN, Infinity, E.T0_MS_MAX + 1, E.T0_MS_MIN - 1, '1', null]) assert.equal(E.formatUtcIso(bad), '')
  assert.equal(E.formatUtcIso(E.T0_MS_MAX), '9999-12-31T23:59:59.999Z')
  assert.equal(E.formatUtcIso(E.T0_MS_MIN), '0000-01-01T00:00:00Z')
})

// ═════════════════════════════ ⑧ 字段规范化 ═════════════════════════════

t('⑧ sanitizeMarkers：老存档深相等；坏字段删、好字段留、别的字段不动；normTrajMotion 删 10668', () => {
  const old = {
    points: [{ id: 'p1', name: '北京', lat: 39.9, lon: 116.4, color: '#f00' }, { id: 'p2', lat: 0, lon: 0 }],
    stations: [{ id: 's1', name: '喀什', lat: 39.5, lon: 76, kind: 'gw' }],
    trajectories: [{ id: 't1', name: 'MU583', kind: 'flight', color: '#0af', pts: [{ lat: 31.2, lon: 121.5 }, { lat: 34, lon: -118.4 }] }],
    extra: { keep: true }
  }
  const snap = JSON.parse(JSON.stringify(old))
  assert.equal(E.sanitizeMarkers(old), old)
  assert.deepStrictEqual(old, snap, '老存档深相等')
  // 缺数组 / 非对象都不炸
  for (const d of [null, undefined, 3, 'x', [], {}, { points: null, stations: 'x', trajectories: [null, 3, 'y'] }]) E.sanitizeMarkers(d)

  const d = {
    points: [{ id: 'p1', lat: 1, lon: 2, model: { id: 'bad' } }, { id: 'p2', lat: 1, lon: 2, model: { id: 'ent:vsat-1p2', px: 64, note: 'x' } }, { id: 'p3', model: 'ent:vsat-1p2' }],
    stations: [
      { id: 's1', model: { id: 'ent:es-13p1', px: 300 }, track: { kind: 'focus' } },
      { id: 's2', model: { id: 'ent:es-13p1', px: 12.5 }, track: { kind: 'sat', satKey: 'norad:25544' } },
      { id: 's3', model: null, track: { kind: 'sat', satKey: 'bad key' } },
      { id: 's4', model: { id: 'ent:dsn-34m', px: 8 }, track: { kind: 'sat', satKey: 'cc:grp:s1' } }
    ],
    trajectories: [
      { id: 't1', kind: 'flight', pts: [], cruiseAltM: 10668, speedKmh: 850, t0Ms: 1790236800000, model: { id: 'ent:a320neo', px: 256 } },
      { id: 't2', kind: 'flight', pts: [], cruiseAltM: -1, speedKmh: 0, t0Ms: NaN, model: { px: 48 } },
      { id: 't3', kind: 'sea', pts: [], cruiseAltM: 30001, speedKmh: 5001, t0Ms: '2026' },
      { id: 't4', kind: 'sea', pts: [], cruiseAltM: 9000, speedKmh: 1e-9, t0Ms: E.T0_MS_MAX + 1 }
    ]
  }
  E.sanitizeMarkers(d)
  assert.deepStrictEqual(d.points, [{ id: 'p1', lat: 1, lon: 2 }, { id: 'p2', lat: 1, lon: 2, model: { id: 'ent:vsat-1p2', px: 64, note: 'x' } }, { id: 'p3' }])
  assert.deepStrictEqual(d.stations, [
    { id: 's1', model: { id: 'ent:es-13p1' } },
    { id: 's2', model: { id: 'ent:es-13p1' }, track: { kind: 'sat', satKey: 'norad:25544' } },
    { id: 's3' },
    { id: 's4', model: { id: 'ent:dsn-34m', px: 8 }, track: { kind: 'sat', satKey: 'cc:grp:s1' } }
  ])
  assert.deepStrictEqual(d.trajectories, [
    { id: 't1', kind: 'flight', pts: [], cruiseAltM: 10668, speedKmh: 850, t0Ms: 1790236800000, model: { id: 'ent:a320neo', px: 256 } },
    { id: 't2', kind: 'flight', pts: [] },
    { id: 't3', kind: 'sea', pts: [] },
    { id: 't4', kind: 'sea', pts: [], cruiseAltM: 9000, speedKmh: 1e-9 }
  ])
  // normTrajMotion：再删等于缺省的 cruiseAltM；航行航迹上的非缺省 cruiseAltM 留着
  const t1 = { kind: 'flight', cruiseAltM: 10668, speedKmh: 850 }
  assert.equal(E.normTrajMotion(t1), t1)
  assert.deepStrictEqual(t1, { kind: 'flight', speedKmh: 850 })
  const t2 = { kind: 'sea', cruiseAltM: 9000, speedKmh: -1, t0Ms: 5 }
  assert.deepStrictEqual(E.normTrajMotion(t2), { kind: 'sea', cruiseAltM: 9000, t0Ms: 5 })
  assert.equal(E.normTrajMotion(null), null)
})

// ═════════════════════════════ ⑨ 跟踪滞回 ═════════════════════════════

t('⑨ pickTrackTarget：WGS-84 仰角最高、滞回 0.5°、上一次已落地平照换、最高 < 0 → park、无候选 / 坏 ecef', () => {
  const lat = 35, lon = 110, stLla = { lat, lon, altM: 0 }
  const st = E.makeTrackState()
  const cands = [{ key: 'A', ecef: targetAt(lat, lon, 150, 30) }, { key: 'B', ecef: targetAt(lat, lon, 210, 29) }]
  assert.equal(E.pickTrackTarget(stLla, cands, 2, st), 0)
  assert.ok(st.key === 'A' && !st.park)
  near(st.look.elDeg, 30, 1e-9, 'WGS-84 仰角')
  near(st._best, 30, 1e-9, '_best')
  // B 高出 0.3° → 不换
  cands[1].ecef = targetAt(lat, lon, 210, 30.3)
  assert.equal(E.pickTrackTarget(stLla, cands, 2, st), 0)
  assert.equal(st.key, 'A')
  // B 高出 0.7° → 换
  cands[1].ecef = targetAt(lat, lon, 210, 30.7)
  assert.equal(E.pickTrackTarget(stLla, cands, 2, st), 1)
  assert.equal(st.key, 'B')
  near(st.look.azDeg, 210, 1e-9, '方位')
  // 画面口径的视线：场景轴单位矢量、与读数差 < 0.2°
  assert.ok(Math.abs(len(st.aim.dir) - 1) < 1e-12 && azDiff(st.aim.azDeg, st.look.azDeg) < 0.2 && Math.abs(st.aim.elDeg - st.look.elDeg) < 0.2)
  // 顺序无关：key 匹配而不是下标
  const sw = [cands[1], cands[0]]
  assert.equal(E.pickTrackTarget(stLla, sw, 2, st), 0)
  assert.equal(st.key, 'B')
  // 上一次的（B）已落到地平以下、A 在地平以上：即便差 < 0.5° 也换
  cands[1].ecef = targetAt(lat, lon, 210, -0.2); cands[0].ecef = targetAt(lat, lon, 150, 0.2)
  assert.equal(E.pickTrackTarget(stLla, cands, 2, st), 0)
  assert.ok(st.key === 'A' && !st.park)
  // 都在地平以下 → park（仍记最高的那颗）
  cands[0].ecef = targetAt(lat, lon, 150, -3); cands[1].ecef = targetAt(lat, lon, 210, -1)
  assert.equal(E.pickTrackTarget(stLla, cands, 2, st), 1)
  assert.ok(st.park && st.key === 'B')
  // n 只读前 n 个
  cands[1].ecef = targetAt(lat, lon, 210, 60)
  assert.equal(E.pickTrackTarget(stLla, cands, 1, st), 0)
  assert.ok(st.park && st.key === 'A')
  // 坏 ecef 跳过；没有有效候选 → park、key 清空
  assert.equal(E.pickTrackTarget(stLla, [{ key: 'X', ecef: [NaN, 0, 0] }, { key: 'Y', ecef: null }, null], 3, st), -1)
  assert.ok(st.park && st.key === '' && st.idx === -1)
  assert.equal(E.pickTrackTarget(stLla, [], 0, st), -1)
  assert.equal(E.pickTrackTarget(stLla, null, 5, st), -1)
  // {x,y,z} 形式的 ecef
  const P = targetAt(lat, lon, 90, 45)
  assert.equal(E.pickTrackTarget(stLla, [{ key: 'O', ecef: { x: P[0], y: P[1], z: P[2] } }], 1, st), 0)
  near(st.look.elDeg, 45, 1e-9, '{x,y,z}')
})

// ═════════════════════════════ 解算细节 ═════════════════════════════

t('solveAim 的限位内选解与 gimbal.solveGimbal → pickSolution 逐位相同（随机 4000 组，含翻转座 / 大行程 / X-Y）', () => {
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296)
  const rigs = ['ent:es-13p1', 'ent:vsat-1p2', 'ent:dsn-34m', 'ent:es-xy-2p4', 'ent:ulcs-24k', 'ent:mq9'].map(rigOf)
  const sol = { a1: 0, a2: 0, singular: false }, pk = { a1: 0, a2: 0 }
  let same = 0, pre = 0
  for (let i = 0; i < 4000; i++) {
    const rig = rigs[i % rigs.length]
    const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, r = Math.sqrt(1 - z * z)
    const d = [r * Math.cos(ph), r * Math.sin(ph), z]
    const st = E.makeAimState()
    if (rnd() < 0.8) { st.a1 = rig.lim.a1Min + rnd() * (rig.lim.a1Max - rig.lim.a1Min); st.a2 = rig.lim.a2Min + rnd() * (rig.lim.a2Max - rig.lim.a2Min) }
    const r1 = Number.isFinite(st.a1) ? st.a1 : rig.init.a1, r2 = Number.isFinite(st.a2) ? st.a2 : rig.init.a2
    const ok = E.solveAim(rig, d, st)
    const dm = [dot(d, rig.frame.x), dot(d, rig.frame.y), dot(d, rig.frame.z)]
    solveGimbal(rig.type, dm, r1, sol)
    const refOk = pickSolution(sol.a1, sol.a2, rig.lim, r1, r2, pk)
    assert.equal(ok, refOk)
    if (ok) { assert.ok(Object.is(st.a1, pk.a1) && Object.is(st.a2, pk.a2), `第 ${i} 组`); same++ }
    else if (st.pre) {
      // 预指向：主解俯仰低于下限、方位可达 → 与「俯仰换成下限」后的 pickSolution 逐位相同
      assert.ok(rig.type === 'azel' && !sol.singular && sol.a2 < rig.lim.a2Min && !st.held, `第 ${i} 组预指向条件`)
      assert.ok(pickSolution(sol.a1, rig.lim.a2Min, rig.lim, r1, r2, pk) && Object.is(st.a1, pk.a1) && Object.is(st.a2, pk.a2), `第 ${i} 组预指向解`)
      pre++
    } else assert.ok(Object.is(st.a1, r1) && Object.is(st.a2, r2) && st.held)
  }
  assert.ok(same > 1500 && pre > 50, `有解 ${same} 组、预指向 ${pre} 组`)
})

t('预指向（§8-4）：VSAT 1.2 m 目标仰角 3°（低于下限 7°）→ 方位对准、俯仰 = 7°、pre；13 m 站（下限 0°）北向够不着仍 held；停放清 pre', () => {
  const rig = rigOf('ent:vsat-1p2')
  assert.equal(rig.lim.a2Min, 7)
  const as = E.makeAimState()
  assert.equal(as.pre, false)
  for (const az of [0, 57, 123, 200, 301]) {
    const e = 3 * D2R, a = az * D2R
    const d = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), -Math.sin(e)]
    assert.equal(E.solveAim(rig, d, as), false)
    assert.ok(as.pre && !as.held && !as.ok, `方位 ${az}：pre`)
    assert.equal(as.a2, 7)
    const ae = nedAzEl(mountToBody(rig.frame, dirFromGimbal(rig.type, as.a1, as.a2)))
    near(azDiff(ae.az, az), 0, 1e-9, `方位 ${az} 对准`)
    near(ae.el, 7, 1e-9, '俯仰夹到下限')
  }
  // 升到下限以上：正常跟踪（ok、pre 清掉），方位不跳
  const a1Pre = as.a1
  const e2 = 9 * D2R, a2 = 301 * D2R
  assert.equal(E.solveAim(rig, [Math.cos(e2) * Math.cos(a2), Math.cos(e2) * Math.sin(a2), -Math.sin(e2)], as), true)
  assert.ok(as.ok && !as.pre && !as.held && Math.abs(as.a1 - a1Pre) < 1e-9)
  // 落地平：调用方停放 → pre 清掉
  as.pre = true
  E.parkAim(rig, as)
  assert.ok(!as.pre && as.a2 === 84)
  // 13 m 站：下限 0°、方位行程 90–270：北向低仰角（−0.5°，画面口径比 WGS-84 低一点时）方位够不着 → held，不预指向
  const r13 = rigOf('ent:es-13p1'), s13 = E.makeAimState()
  const n = [Math.cos(-0.5 * D2R), 0, Math.sin(0.5 * D2R)]
  assert.equal(E.solveAim(r13, n, s13), false)
  assert.ok(s13.held && !s13.pre)
  // 南向同一仰角：方位够得着 → 预指向到 0°
  assert.equal(E.solveAim(r13, [-n[0], 0, n[2]], s13), false)
  assert.ok(s13.pre && s13.a2 === 0 && Math.abs(s13.a1 - 180) < 1e-9, `${s13.a1} ${s13.a2}`)
  // X-Y 座不走预指向
  const rx = rigOf('ent:es-xy-2p4'), sx = E.makeAimState()
  E.solveAim(rx, [0, 1, 0.3], sx)
  assert.equal(sx.pre, false)
})

t('aimRigOf：地球站挂点系 = STATION_MOUNT、限位取交集、无关节 → null；jointValuesOf 与 ground.gimbalValues 同形、复用零新键', () => {
  const r13 = rigOf('ent:es-13p1')
  assert.deepEqual(r13.frame, { x: [0, -1, 0], y: [0, 0, -1], z: [1, 0, 0] })
  assert.deepEqual(r13.lim, { a1Min: 90, a1Max: 270, a2Min: 0, a2Max: 90 })
  assert.deepEqual(r13.init, { a1: 180, a2: 35 })
  assert.deepEqual(r13.arts, ['ped_azimuth', 'refl_gimbal'])
  assert.equal(r13.boresight, 'refl_boresight')
  assert.deepEqual(rigOf('ent:vsat-1p2').lim, { a1Min: -180, a1Max: 180, a2Min: 7, a2Max: 84 })
  assert.deepEqual(rigOf('ent:ulcs-24k').arts, ['vsat_gimbal', 'vsat_azimuth'])
  assert.equal(E.aimRigOf(built('ent:suv-cotm')), null, '平板动中通没有关节')
  assert.equal(E.aimRigOf(null), null)
  assert.equal(E.aimRigOf({ articulations: [{ name: 'prop_spin', stages: [{ name: 'spin', type: 'xRotate' }] }] }), null)
  // 有关节无 boresight：按站挂点缺省；stage 缺限位按全行程；交集为空退主关节
  const g = E.aimRigOf({ articulations: [{ name: 'a_g', stages: [{ name: 'azimuth' }, { name: 'elevation', minimumValue: 10, maximumValue: 80, initialValue: 5 }] }, { name: 'b_x', stages: [{ name: 'azimuth', minimumValue: 200, maximumValue: 300 }] }] })
  assert.deepEqual(g.frame, { x: [0, -1, 0], y: [0, 0, -1], z: [1, 0, 0] })
  assert.deepEqual(g.lim, { a1Min: -180, a1Max: 180, a2Min: 10, a2Max: 80 })
  assert.deepEqual(g.init, { a1: 0, a2: 10 }, 'init 夹进限位')
  for (const id of ENTITY_TEMPLATE_IDS) {
    const r = built(id), rig = E.aimRigOf(r)
    if (!rig) continue
    const out = {}
    const v1 = E.jointValuesOf(rig, 12.5, 34.25, out)
    assert.equal(v1, out)
    assert.deepStrictEqual(v1, gimbalValues(r.articulations, 12.5, 34.25), id)
    const inner = rig.arts.map((k) => out[k])
    E.jointValuesOf(rig, -7, 8, out)
    assert.ok(rig.arts.every((k, i) => out[k] === inner[i]), `${id}：内层对象复用`)
    assert.deepStrictEqual(out, gimbalValues(r.articulations, -7, 8))
  }
})

t('aheadPoint：d = 0 回原点、落在航段大圆上、经度区间；与 trajStateAt 的走向一致', () => {
  const T0 = Date.UTC(2026, 8, 24, 4)
  const tr = { id: 'ahead', kind: 'sea', pts: [{ lat: -20, lon: 57.5 }, { lat: 1.3, lon: 103.8 }], t0Ms: T0, speedKmh: 37 }
  const a = unit(-20, 57.5), b = unit(1.3, 103.8), nn = cross(a, b), nl = len(nn)
  const st = makeTrajState(), o = { lat: 0, lon: 0 }
  for (const hr of [1, 24, 72, 120]) {
    E.vehicleStateAt(tr, T0 + hr * 3600000, st)
    E.aheadPoint(st.lat, st.lon, st.headingDeg, 0, o)
    assert.ok(Math.abs(o.lat - st.lat) < 1e-12 && Math.abs(o.lon - st.lon) < 1e-12)
    E.aheadPoint(st.lat, st.lon, st.headingDeg, 0.05, o)
    assert.ok(Math.abs(dot(unit(o.lat, o.lon), nn) / nl) < 1e-12, '在航段大圆上')
    near(angDeg(unit(st.lat, st.lon), unit(o.lat, o.lon)), 0.05, 1e-12, '走 0.05°')
    // 朝终点走（离 B 更近）
    assert.ok(angDeg(unit(o.lat, o.lon), b) < angDeg(unit(st.lat, st.lon), b))
  }
  E.aheadPoint(10, 179.99, 90, 1, o)
  assert.ok(o.lon > -180 && o.lon <= 180 && o.lon < 0, `跨接缝 ${o.lon}`)
  E.aheadPoint(0, 0, 0, 90, o)
  near(o.lat, 90, 1e-12, '到北极')
  assert.ok(E.aheadPoint(1, 2, 3, 4).lat > 1, '缺省 out')
})

// ═════════════════════════════ ⑪ shadeOf ═════════════════════════════

t('⑪ shadeOf：−6° → 0.5、+0.8° → 1、中点 0.75、夜侧 0.5、白天 1、sunLit 假恒 1、非单位 / {x,y,z} / 坏矢量', () => {
  const up = [0.3, 0.8, Math.sqrt(1 - 0.09 - 0.64)], h = [0.8, -0.3, 0]
  const hl = len(h), hz = [h[0] / hl, h[1] / hl, 0]
  // 与 up 正交的水平方向
  const k = dot(hz, up), ho = [hz[0] - k * up[0], hz[1] - k * up[1], hz[2] - k * up[2]], hol = len(ho)
  const horiz = ho.map((x) => x / hol)
  const sunAt = (e) => up.map((u, i) => u * Math.sin(e * D2R) + horiz[i] * Math.cos(e * D2R))
  near(E.shadeOf(up, sunAt(-6), true), 0.5, 1e-12, '−6°')
  near(E.shadeOf(up, sunAt(0.8), true), 1, 1e-12, '+0.8°')
  near(E.shadeOf(up, sunAt(-2.6), true), 0.75, 1e-12, '中点')
  const e = -4, tt = (e + 6) / 6.8, ss = tt * tt * (3 - 2 * tt)
  near(E.shadeOf(up, sunAt(e), true), 0.5 + 0.5 * ss, 1e-12, 'smoothstep')
  assert.equal(E.shadeOf(up, sunAt(-40), true), 0.5)
  assert.equal(E.shadeOf(up, sunAt(45), true), 1)
  for (const x of [-90, -3, 0, 30, 90]) assert.equal(E.shadeOf(up, sunAt(x), false), 1)
  near(E.shadeOf(up.map((x) => x * 1.002), sunAt(-2.6).map((x) => x * 3), true), 0.75, 1e-12, '非单位矢量先归一')
  const U = { x: up[0], y: up[1], z: up[2] }
  near(E.shadeOf(U, sunAt(-2.6), true), 0.75, 1e-12, '{x,y,z}')
  for (const bad of [null, [0, 0, 0], [NaN, 0, 1]]) assert.equal(E.shadeOf(bad, sunAt(-2.6), true), 1)
  assert.equal(E.shadeOf(up, [0, 0, 0], true), 1)
  assert.ok(E.SHADE_FLOOR === 0.5 && E.SUN_ELEV_DARK_DEG === -6 && E.SUN_ELEV_LIT_DEG === 0.8 && E.ENT_FADE_S === 0.3 && E.TRACK_HYST_DEG === 0.5)
})

// ═════════════════════════════ ⑩ 热路径分配量（独立进程） ═════════════════════════════
// 在新进程里量：本文件前面的用例拿数组 / {x,y,z} / Vector3 形状喂过 entityPose 的取数点（stationTrackAzEl / stationAimScene），
// 类型反馈已被撑成 megamorphic，不代表页面稳态（页面的候选 ecef 恒为数组、站址恒为同形对象）。量法同 modelEntityPose ⑥：
// 采样堆分析，整份剖面计数、只剔 node: 内部帧。代码里没有显式分配：pickInto / primaryInto 逐字复写 gimbal 的选解 / 主解并从暂存读数
// （不把 double 当实参传、不经返回 double 的小函数取数）。剩下的是 V8 装箱（16 B / 个，随 JIT 反馈浮动：jointValuesOf / aheadPoint 的
// double 实参、shadeOf 的 double 返回值）。判据只抓显式分配回归（对象 / 数组字面量 ≈ 72 B 起）：上限 6 个装箱；pickTrackTarget 一次调
// n + 2 回 entityPose（每回同一上限）。ALLOC_SITES=1 打印分配点。
{
  const name = '⑩ 热路径分配量（独立进程）：pickTrackTarget / solveAim / parkAim / jointValuesOf / aheadPoint / shadeOf / vehicleStateAt 复用 out 时 ≤ 上限（报数）'
  try {
    const rtUrl = new URL('../models/entityRuntime.mjs', import.meta.url).href
    const tkUrl = new URL('../models/trajKinematics.mjs', import.meta.url).href
    const epUrl = new URL('../models/entityPose.mjs', import.meta.url).href
    const etUrl = new URL('../models/entityTemplates.mjs', import.meta.url).href
    const asUrl = new URL('../models/assembly.mjs', import.meta.url).href
    const src = `
import * as E from '${rtUrl}'
import { makeTrajState } from '${tkUrl}'
import { geodeticToEcefKm, enuEcef } from '${epUrl}'
import { entityTemplateDoc } from '${etUrl}'
import { buildAssembly } from '${asUrl}'
import { Session } from 'node:inspector/promises'
const D2R = Math.PI / 180
function targetAt(lat, lon, azDeg, elDeg, rangeKm) {
  const S = geodeticToEcefKm(lat, lon, 0), B = enuEcef(lat, lon)
  const a = azDeg * D2R, e = elDeg * D2R, ce = Math.cos(e)
  const d = [0, 1, 2].map((k) => ce * (Math.cos(a) * B.N[k] + Math.sin(a) * B.E[k]) + Math.sin(e) * B.U[k])
  return [S[0] + rangeKm * d[0], S[1] + rangeKm * d[1], S[2] + rangeKm * d[2]]
}
async function allocPerCall(ss, fn, N) {
  fn(); fn()
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
  return { b: bytes / N, sites: [...sites].sort((p, q) => q[1] - p[1]).slice(0, 4).map(([k, v]) => k + ' ' + (v / N).toFixed(1)).join('; ') }
}
const N = 100000, T0 = Date.UTC(2026, 8, 24)
const lat = 30, lon = 100, stLla = { lat, lon, altM: 0 }
const cands = [{ key: 'A', ecef: targetAt(lat, lon, 150, 30, 36000) }, { key: 'B', ecef: targetAt(lat, lon, 210, 29, 36000) }, { key: 'C', ecef: targetAt(lat, lon, 10, -5, 2000) }]
const tst = E.makeTrackState()
const rig = E.aimRigOf(buildAssembly(entityTemplateDoc('ent:es-13p1').doc)), rigX = E.aimRigOf(buildAssembly(entityTemplateDoc('ent:es-xy-2p4').doc))
const as = E.makeAimState(), asX = E.makeAimState()
const dirs = new Array(64).fill(0).map((_, i) => { const a = (100 + i) * D2R, e = (10 + i) * D2R; return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), -Math.sin(e)] })
const jv = {}, o = { lat: 0, lon: 0 }, up = [0.3, 0.8, 0.52], sun = [0.9, -0.1, 0.1]
const tr = { id: 'allocVeh', kind: 'flight', pts: [{ lat: 40.08, lon: 116.58 }, { lat: 43.9, lon: 125.2 }, { lat: 45.6, lon: 126.2 }], t0Ms: T0, speedKmh: 800 }
const ts = makeTrajState()
const hd = new Float64Array(360)
for (let i = 0; i < 360; i++) hd[i] = i + 0.5
let sink = 0
const cases = [
  ['pickTrackTarget（3 候选）', 5, () => { for (let i = 0; i < N; i++) E.pickTrackTarget(stLla, cands, 3, tst) }],
  ['solveAim（azel）', 1, () => { for (let i = 0; i < N; i++) E.solveAim(rig, dirs[i & 63], as) }],
  ['solveAim（xy）', 1, () => { for (let i = 0; i < N; i++) E.solveAim(rigX, dirs[i & 63], asX) }],
  ['parkAim（azel + xy）', 1, () => { for (let i = 0; i < N; i++) { E.parkAim(rig, as); E.parkAim(rigX, asX) } }],
  ['jointValuesOf', 1, () => { for (let i = 0; i < N; i++) E.jointValuesOf(rig, hd[i % 360], 35, jv) }],
  ['aheadPoint', 1, () => { for (let i = 0; i < N; i++) E.aheadPoint(31.2, 121.5, hd[i % 360], 0.05, o) }],
  ['shadeOf', 1, () => { for (let i = 0; i < N; i++) sink += E.shadeOf(up, sun, true) }],
  ['vehicleStateAt（运动档飞行）', 1, () => { for (let i = 0; i < N; i++) E.vehicleStateAt(tr, T0 + (i % 360) * 60000, ts) }]
]
const ss = new Session(); ss.connect()
await ss.post('HeapProfiler.enable')
const rows = []
for (const [nm, calls, fn] of cases) { const r = await allocPerCall(ss, fn, N); rows.push({ nm, calls, b: r.b, sites: r.sites }) }
await ss.post('HeapProfiler.disable'); ss.disconnect()
console.log(JSON.stringify({ rows, sink: sink > 0 }))
`
    const res = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop())
    const ALLOC_MAX_B = 96
    const over = res.rows.filter((r) => r.b > ALLOC_MAX_B * r.calls)
    console.log('  每次调用平均分配（B，100000 次、独立进程采样堆分析）：' + res.rows.map((r) => `${r.nm} ${r.b.toFixed(1)}`).join('；'))
    if (process.env.ALLOC_SITES) for (const r of res.rows) console.log(`    ${r.nm}：${r.sites}`)
    assert.ok(res.sink)
    assert.equal(over.length, 0, `超过上限（疑似显式分配回归）：${over.map((r) => `${r.nm} ${r.b.toFixed(1)} B`).join('，')}`)
    n++
  } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 }
}

console.log(`modelEntityRuntime: ${n} 项通过`)
