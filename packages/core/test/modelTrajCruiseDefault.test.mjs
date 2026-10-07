// 按模型的航迹缺省巡航高度（trajKinematics.MODEL_CRUISE_ALT_M / trajDefaultCruiseAltM / trajCruiseAltM；entityRuntime.normTrajMotion）的回归网。
//
//   ① 取值口径：没挂模型 / 表外模型 = 10668；表内模型 = 表值；航迹自己填的（含 0）优先；负的 / 非有限的自填值退缺省；坏形状不抛、原型链上的键不误中
//   ② 运动学：直升机航迹不填高度 → 静止档航迹头 1000 m、运动档平飞段 1000 m、爬升段按 1000 m 剖面解析；trajLine3 顶到 1000 m、逐航点读数同口径；
//      自己填了 cruiseAltM 时挂不挂直升机逐位相同
//   ③ 改前逐位不变：表外模型（客机 / 公务机 / MQ-9 / RQ-4B / nasa / 用户模型 / 坏形状）的航迹，状态 / 剖面 / 3D 线 / 逐航点读数与「没挂模型」逐位相同
//   ④ normTrajMotion：只在缺省 = 10668 时删 10668；直升机航迹上的 10668、等于模型缺省的 1000 都留着；随机语料与改前规则对拍 ——
//      缺省 = 10668 的航迹结果逐位相同（含键序），有模型缺省的航迹删掉的键是改前的子集
//   ⑤ Excel 说明行往返：trajNoteOf → parseTrajNote → 导入（透传 + normTrajMotion）后与原对象逐位相同（直升机 + 10668 也回得来）
//   ⑥ 模板目录：表里的键是飞机模板（目录里有旋翼机这批模板时必须都在）；根件为直升机 / 多旋翼、或挂撑杆 + 升力旋翼的固定翼模板都已登记
//      （漏登记 = 那型载具会飞到 FL350）；不带旋翼的固定翼（客机、公务机、MQ-9、RQ-4B）不进表

import assert from 'node:assert/strict'
import * as E from '../models/entityRuntime.mjs'
import {
  trajStateAt, trajStateAtS, trajLine3, trajWaypointInfo, trajLengthM, makeTrajState,
  CRUISE_ALT_M_DEFAULT, CLIMB_RATE_MS_DEFAULT, GLIDE_DEG_DEFAULT, MODEL_CRUISE_ALT_M, trajDefaultCruiseAltM, trajCruiseAltM
} from '../models/trajKinematics.mjs'
import { ENTITY_TEMPLATES } from '../models/entityTemplates.mjs'
import { TRAJ_NOTE_FIELDS } from '../../../src/viz/markers/useMarkerTable.js'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }

const fin = Number.isFinite
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const clone = (o) => structuredClone(o)
const T0 = Date.UTC(2026, 9, 7, 2, 0, 0)
const HELI = 'ent:aw139', QUAD = 'ent:astro-max', VTOL = 'ent:jump20'
const HELI_M = MODEL_CRUISE_ALT_M[HELI]

// 香港机场 → 澳门（≈ 40 km）：250 km/h 下爬到 1000 m 要 6.8 km、3° 从 1000 m 下滑要 19.1 km，中间有平飞段
const HK = { lat: 22.308, lon: 113.918 }, MID = { lat: 22.26, lon: 113.75 }, MO = { lat: 22.149, lon: 113.592 }
const heliStatic = () => ({ id: 'h-st', kind: 'flight', pts: [{ ...HK }, { ...MID }, { ...MO }], model: { id: HELI } })
const heliMoving = () => ({ id: 'h-mv', kind: 'flight', pts: [{ ...HK }, { ...MO }], speedKmh: 250, t0Ms: T0, model: { id: HELI } })
// 法兰克福 → 纽约（长航段，FL350 有平飞段）
const FRA = { lat: 50.033, lon: 8.571 }, KEF = { lat: 63.985, lon: -22.605 }, JFK = { lat: 40.641, lon: -73.778 }
const longMoving = () => ({ id: 'l-mv', kind: 'flight', pts: [{ ...FRA }, { ...KEF }, { ...JFK }], speedKmh: 850, t0Ms: T0 })
const longStatic = () => ({ id: 'l-st', kind: 'flight', pts: [{ ...FRA }, { ...KEF, altM: 9000 }, { ...JFK }] })
const longPinned = () => ({ id: 'l-pin', kind: 'flight', pts: [{ ...FRA, tMs: T0 }, { ...KEF }, { ...JFK, tMs: T0 + 8 * 3600e3 }] })

// ═════════════════════════════ ① 取值口径 ═════════════════════════════
t('① 取值口径：缺省 / 表值 / 自填优先 / 坏形状', () => {
  assert.equal(CRUISE_ALT_M_DEFAULT, 10668)
  assert.ok(Object.isFrozen(MODEL_CRUISE_ALT_M))
  assert.equal(trajDefaultCruiseAltM({ kind: 'flight', pts: [] }), CRUISE_ALT_M_DEFAULT)
  assert.equal(trajDefaultCruiseAltM({ model: { id: 'ent:a320neo' } }), CRUISE_ALT_M_DEFAULT)
  for (const [id, v] of Object.entries(MODEL_CRUISE_ALT_M)) {
    assert.equal(trajDefaultCruiseAltM({ model: { id } }), v, id)
    assert.equal(trajDefaultCruiseAltM({ model: { id, px: 48 }, cruiseAltM: 5000 }), v, `${id}：缺省不看自填值`)
    assert.equal(trajCruiseAltM({ model: { id } }), v, `${id}：没填取模型缺省`)
  }
  assert.equal(trajCruiseAltM({ model: { id: HELI }, cruiseAltM: 3000 }), 3000, '自填优先')
  assert.equal(trajCruiseAltM({ model: { id: HELI }, cruiseAltM: 0 }), 0, '0 是合法自填值，不当成没填')
  assert.equal(trajCruiseAltM({ model: { id: HELI }, cruiseAltM: 11277.6 }), 11277.6)
  for (const bad of [-1, NaN, Infinity, -Infinity, '3000', null, undefined]) {
    assert.equal(trajCruiseAltM({ model: { id: HELI }, cruiseAltM: bad }), HELI_M, `自填 ${String(bad)} 退模型缺省`)
    assert.equal(trajCruiseAltM({ cruiseAltM: bad }), CRUISE_ALT_M_DEFAULT, `自填 ${String(bad)} 退出厂缺省`)
  }
  // 坏形状：不抛、按没挂模型算；原型链上的键（constructor / toString / __proto__）不误中
  for (const m of [null, undefined, 0, 'ent:aw139', [HELI], {}, { id: 5 }, { id: null }, { id: 'constructor' }, { id: 'toString' }, { id: '__proto__' }, { id: 'hasOwnProperty' }]) {
    assert.equal(trajDefaultCruiseAltM({ model: m }), CRUISE_ALT_M_DEFAULT, `model = ${JSON.stringify(m)}`)
  }
  for (const v of [null, undefined, 0, 'x', true]) {
    assert.equal(trajDefaultCruiseAltM(v), CRUISE_ALT_M_DEFAULT)
    assert.equal(trajCruiseAltM(v), CRUISE_ALT_M_DEFAULT)
  }
})

// ═════════════════════════════ ② 运动学 ═════════════════════════════
t('② 直升机不填高度：静止档航迹头 / 逐航点 = 1000 m', () => {
  const tr = heliStatic()
  const st = trajStateAt(tr, T0)
  assert.ok(st.ok && !st.moving)
  assert.equal(st.altM, HELI_M)
  assert.equal(st.pitchDeg, 0)
  assert.deepEqual(trajWaypointInfo(tr).map((e) => e.altM), [HELI_M, HELI_M, HELI_M])
  // 静止档段内线性、两端都是 1000 → 全程 1000
  for (const f of [0, 0.25, 0.5, 0.9, 1]) assert.equal(trajStateAtS(tr, f * trajLengthM(tr)).altM, HELI_M, `s = ${f}·L`)
})

t('② 直升机不填高度：运动档按 1000 m 剖面（爬升 / 平飞 / 3° 下滑），3D 线顶到 1000 m', () => {
  const tr = heliMoving(), L = trajLengthM(tr), v = 250 / 3.6
  const tc = CLIMB_RATE_MS_DEFAULT / v, td = Math.tan(GLIDE_DEG_DEFAULT * Math.PI / 180)
  const sTop = HELI_M / tc, sTod = L - HELI_M / td
  assert.ok(sTop < sTod, `航段够长，有平飞段（${sTop.toFixed(0)} < ${sTod.toFixed(0)} m）`)
  near(trajStateAtS(tr, sTop / 2).altM, sTop / 2 * tc, 1e-9, '爬升段 = 爬升梯度 × 里程')
  const mid = trajStateAtS(tr, (sTop + sTod) / 2)
  assert.equal(mid.altM, HELI_M); assert.equal(mid.phase, 'cruise'); assert.equal(mid.pitchDeg, 0)
  near(trajStateAtS(tr, sTod + (L - sTod) / 2).altM, (L - sTod) / 2 * td, 1e-6, '下滑段 = 3° × 剩余里程')
  // 按时刻：起飞后中段
  const st = trajStateAt(tr, T0 + (sTop + sTod) / 2 / v * 1000, makeTrajState())
  assert.ok(st.moving); near(st.altM, HELI_M, 1e-9, '运动档平飞')
  const line = trajLine3(tr)
  assert.equal(Math.max(...line.map((p) => p.altM)), HELI_M, '3D 线最高 = 1000 m')
  assert.ok(line.some((p) => Math.abs(p.altM - HELI_M) < 1e-9 && Math.abs(p.altM) > 0), '爬升顶点 / 下降起点出拐点')
  assert.deepEqual(trajWaypointInfo(tr).map((e) => e.altM), [0, 0], '起降点 0 m')
})

t('② 多旋翼 / 垂起各按表值；自填 cruiseAltM 时与挂不挂模型无关（逐位）', () => {
  for (const id of [QUAD, VTOL]) {
    const tr = { ...heliStatic(), id: 'm-' + id, model: { id } }
    assert.equal(trajStateAt(tr, T0).altM, MODEL_CRUISE_ALT_M[id], id)
  }
  for (const c of [0, 120, 3000, 10668, 11277.6]) {
    for (const mk of [heliStatic, heliMoving]) {
      const a = { ...mk(), cruiseAltM: c }, b = { ...mk(), cruiseAltM: c }
      delete b.model
      for (const dt of [-60e3, 0, 300e3, 600e3, 900e3]) assert.deepStrictEqual(trajStateAt(a, T0 + dt), trajStateAt(b, T0 + dt), `cruise ${c} dt ${dt}`)
      assert.deepStrictEqual(trajLine3(a), trajLine3(b), `cruise ${c} 3D 线`)
      assert.deepStrictEqual(trajWaypointInfo(a), trajWaypointInfo(b), `cruise ${c} 逐航点`)
    }
  }
})

// ═════════════════════════════ ③ 表外模型逐位不变 ═════════════════════════════
t('③ 表外模型（客机 / 公务机 / 长航时无人机 / 其它前缀 / 坏形状）与没挂模型逐位相同', () => {
  const outside = ENTITY_TEMPLATES.filter((r) => r.domain === 'aircraft' && !has(MODEL_CRUISE_ALT_M, r.id)).map((r) => ({ id: r.id }))
  assert.ok(outside.some((m) => m.id === 'ent:a320neo') && outside.some((m) => m.id === 'ent:g650er') && outside.some((m) => m.id === 'ent:mq9'))
  const models = [...outside, { id: 'ent:rq4b' }, { id: 'ent:ulcs-24k' }, { id: 'nasa:iss' }, { id: 'asm:my-heli' }, { id: 'param:aw139' }, { id: 'ent:aw139x' },
    {}, { id: 5 }, null, 'ent:aw139', { id: 'constructor' }, { id: '__proto__' }]
  for (const mk of [longMoving, longStatic, longPinned]) {
    const base = mk(), L = trajLengthM(base)
    const ref = {
      at: [-3600e3, 0, 1800e3, 3 * 3600e3, 6 * 3600e3, 20 * 3600e3].map((dt) => trajStateAt(base, T0 + dt)),
      atS: [0, 0.01, 0.2, 0.5, 0.97, 1].map((f) => trajStateAtS(base, f * L)),
      line: trajLine3(base), info: trajWaypointInfo(base)
    }
    for (const m of models) {
      const tr = { ...mk(), model: m }
      const tag = `${base.id} × ${JSON.stringify(m)}`
      assert.deepStrictEqual([-3600e3, 0, 1800e3, 3 * 3600e3, 6 * 3600e3, 20 * 3600e3].map((dt) => trajStateAt(tr, T0 + dt)), ref.at, tag + ' trajStateAt')
      assert.deepStrictEqual([0, 0.01, 0.2, 0.5, 0.97, 1].map((f) => trajStateAtS(tr, f * L)), ref.atS, tag + ' trajStateAtS')
      assert.deepStrictEqual(trajLine3(tr), ref.line, tag + ' trajLine3')
      assert.deepStrictEqual(trajWaypointInfo(tr), ref.info, tag + ' trajWaypointInfo')
      assert.equal(trajCruiseAltM(tr), CRUISE_ALT_M_DEFAULT, tag)
    }
  }
  // 运动档长航段的平飞高度仍是 FL350
  const st = trajStateAt({ ...longMoving(), model: { id: 'ent:a320neo' } }, T0 + 3 * 3600e3)
  assert.equal(st.altM, CRUISE_ALT_M_DEFAULT); assert.equal(st.phase, 'cruise')
})

// ═════════════════════════════ ④ normTrajMotion ═════════════════════════════
// 改前的 normTrajMotion（139613a 原样）：对照组
const okCruise = (v) => typeof v === 'number' && fin(v) && v >= 0 && v <= E.CRUISE_ALT_M_MAX
const okSpeed = (v) => typeof v === 'number' && fin(v) && v > 0 && v <= E.SPEED_KMH_MAX
const okT0 = (v) => typeof v === 'number' && fin(v) && v >= E.T0_MS_MIN && v <= E.T0_MS_MAX
function oldNorm(o) {
  if (!isObj(o)) return o
  if (has(o, 'cruiseAltM') && !okCruise(o.cruiseAltM)) delete o.cruiseAltM
  if (has(o, 'speedKmh') && !okSpeed(o.speedKmh)) delete o.speedKmh
  if (has(o, 't0Ms') && !okT0(o.t0Ms)) delete o.t0Ms
  if (has(o, 'cruiseAltM') && o.cruiseAltM === CRUISE_ALT_M_DEFAULT) delete o.cruiseAltM
  return o
}

t('④ normTrajMotion：直升机上的 10668 / 1000 留着，客机与无模型照旧删 10668', () => {
  const N = (o) => E.normTrajMotion(o)
  assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: 10668, model: { id: HELI } }), { kind: 'flight', cruiseAltM: 10668, model: { id: HELI } })
  assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: HELI_M, model: { id: HELI } }), { kind: 'flight', cruiseAltM: HELI_M, model: { id: HELI } })
  for (const id of [QUAD, VTOL]) {
    assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: 10668, model: { id } }), { kind: 'flight', cruiseAltM: 10668, model: { id } }, id)
    assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: MODEL_CRUISE_ALT_M[id], model: { id } }), { kind: 'flight', cruiseAltM: MODEL_CRUISE_ALT_M[id], model: { id } }, id)
  }
  assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: 10668, model: { id: 'ent:a320neo' } }), { kind: 'flight', model: { id: 'ent:a320neo' } })
  assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: 10668, model: { id: 'ent:g650er' } }), { kind: 'flight', model: { id: 'ent:g650er' } })
  assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: 10668, speedKmh: 850 }), { kind: 'flight', speedKmh: 850 })
  // 非法值照删（与模型无关）
  assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: -1, model: { id: HELI } }), { kind: 'flight', model: { id: HELI } })
  assert.deepStrictEqual(N({ kind: 'flight', cruiseAltM: 30001, speedKmh: 0, t0Ms: NaN, model: { id: HELI } }), { kind: 'flight', model: { id: HELI } })
  // 航行航迹：非缺省值留着（改前口径）；挂直升机模型的航行航迹上 10668 也留着
  assert.deepStrictEqual(N({ kind: 'sea', cruiseAltM: 9000 }), { kind: 'sea', cruiseAltM: 9000 })
  assert.deepStrictEqual(N({ kind: 'sea', cruiseAltM: 10668, model: { id: 'ent:ulcs-24k' } }), { kind: 'sea', model: { id: 'ent:ulcs-24k' } })
  const same = { kind: 'flight', cruiseAltM: 10668, model: { id: HELI } }
  assert.equal(N(same), same, '就地改、返回原对象')
  assert.equal(N(null), null)
})

t('④ normTrajMotion 随机语料对拍改前规则：缺省 = 10668 逐位同（含键序）；有模型缺省的只少删、不多删', () => {
  let s = 0x2a6e9c01
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const ABSENT = Symbol('absent')
  const cruises = [ABSENT, 10668, 1000, 120, 1500, 12496.8, 9000, 0, -1, 30000, 30001, NaN, Infinity, '10668', null]
  const speeds = [ABSENT, 850, 250, -1, 0, 5000, 5001, NaN, '850']
  const t0s = [ABSENT, T0, 0, NaN, E.T0_MS_MAX, E.T0_MS_MAX + 1, E.T0_MS_MIN - 1]
  const aircraft = ENTITY_TEMPLATES.filter((r) => r.domain === 'aircraft').map((r) => r.id)
  const models = [ABSENT, ...aircraft, ...Object.keys(MODEL_CRUISE_ALT_M), 'ent:ulcs-24k', 'nasa:iss', 'asm:x', { id: 5 }, 'ent:aw139', null]
  let same = 0, kept = 0
  for (let i = 0; i < 20000; i++) {
    const o = { id: 'r' + i, kind: pick(['flight', 'sea', undefined]), pts: [] }
    for (const [k, list] of [['cruiseAltM', cruises], ['speedKmh', speeds], ['t0Ms', t0s]]) { const v = pick(list); if (v !== ABSENT) o[k] = v }
    const m = pick(models)
    if (m !== ABSENT) o.model = typeof m === 'string' && rnd() < 0.85 ? { id: m } : m
    const a = E.normTrajMotion(clone(o)), b = oldNorm(clone(o))
    if (trajDefaultCruiseAltM(o) === CRUISE_ALT_M_DEFAULT) {
      assert.deepStrictEqual(a, b, `#${i}`)
      assert.deepEqual(Object.keys(a), Object.keys(b), `#${i} 键序`)
      same++
    } else {
      // 改前删掉的键这里可以留着，但只可能是那个 10668；改前留着的这里一个不少
      for (const k of Object.keys(b)) { assert.ok(has(a, k), `#${i} 少了 ${k}`); assert.deepStrictEqual(a[k], b[k], `#${i} ${k}`) }
      const extra = Object.keys(a).filter((k) => !has(b, k))
      assert.ok(extra.length === 0 || (extra.length === 1 && extra[0] === 'cruiseAltM' && a.cruiseAltM === CRUISE_ALT_M_DEFAULT), `#${i} 多出 ${extra}`)
      if (extra.length) kept++
    }
  }
  assert.ok(same > 10000 && kept > 50, `语料覆盖：缺省 = 10668 ${same} 条、留下 10668 ${kept} 条`)
})

// ═════════════════════════════ ⑤ Excel 说明行往返 ═════════════════════════════
// 与 3D 页 mkImportTrajXlsx 同序：{id, name, kind, pts} + 说明行透传的 TRAJ_NOTE_FIELDS + normTrajMotion
function importLike(src) {
  const p = E.parseTrajNote(E.trajNoteOf(src))
  const o = { id: src.id, name: src.name, kind: p.kind, pts: src.pts }
  for (const k of TRAJ_NOTE_FIELDS) if (p[k] !== undefined) o[k] = p[k]
  return E.normTrajMotion(o)
}

t('⑤ Excel 说明行往返逐位：直升机 / 多旋翼的 10668 与模型缺省值都回得来，客机与老航迹照旧', () => {
  assert.deepEqual([...TRAJ_NOTE_FIELDS], ['cruiseAltM', 'speedKmh', 't0Ms', 'model'])
  const pts = [{ ...HK }, { ...MO }]
  const docs = [
    { id: 'x1', name: '直升机', kind: 'flight', pts, speedKmh: 250, t0Ms: T0, model: { id: HELI } },
    { id: 'x2', name: '直升机 FL350', kind: 'flight', pts, cruiseAltM: 10668, speedKmh: 250, t0Ms: T0, model: { id: HELI } },
    { id: 'x3', name: '直升机 1000', kind: 'flight', pts, cruiseAltM: HELI_M, model: { id: HELI } },
    { id: 'x4', name: '多旋翼', kind: 'flight', pts, cruiseAltM: 10668, model: { id: QUAD } },
    { id: 'x5', name: '多旋翼 120', kind: 'flight', pts, cruiseAltM: 120, model: { id: QUAD } },
    { id: 'x6', name: '垂起', kind: 'flight', pts, model: { id: VTOL } },
    { id: 'x7', name: 'A320', kind: 'flight', pts, speedKmh: 850, t0Ms: T0, model: { id: 'ent:a320neo' } },
    { id: 'x8', name: 'A320 FL370', kind: 'flight', pts, cruiseAltM: 11277.6, model: { id: 'ent:a320neo' } },
    { id: 'x9', name: '老航迹', kind: 'flight', pts },
    { id: 'x10', name: '航线', kind: 'sea', pts, speedKmh: 37.04, model: { id: 'ent:ulcs-24k' } }
  ]
  for (const d of docs) assert.equal(JSON.stringify(importLike(clone(d))), JSON.stringify(d), d.name)
  // 改前就回不来的那一种（客机上手写 10668 = 出厂缺省，不写进对象）：与改前一致
  const a320 = { id: 'x11', name: 'A320 手写 FL350', kind: 'flight', pts, cruiseAltM: 10668, model: { id: 'ent:a320neo' } }
  const want = oldNorm({ id: a320.id, name: a320.name, kind: 'flight', pts, cruiseAltM: 10668, model: { id: 'ent:a320neo' } })
  assert.equal(JSON.stringify(importLike(clone(a320))), JSON.stringify(want))
  assert.ok(!('cruiseAltM' in want))
})

// ═════════════════════════════ ⑥ 模板目录 ═════════════════════════════
const rootType = (r) => { const c = r.doc.comps.find((x) => x.parent === null || x.parent === undefined); return c ? c.type : '' }
const hasType = (r, ty) => r.doc.comps.some((c) => c.type === ty)
// 低空类：直升机机身 / 多旋翼机体为根，或固定翼挂撑杆 + 升力旋翼（复合翼垂起；只有螺旋桨 air.prop 的 MQ-9 不算）
const lowClass = (r) => (rootType(r) === 'air.heli' ? 'heli' : rootType(r) === 'air.mrbody' ? 'multirotor' : hasType(r, 'air.boom') && hasType(r, 'air.rotor') ? 'vtol' : null)

t('⑥ 模板目录：表里的键是飞机模板；直升机 / 多旋翼 / 垂起模板都已登记，不带旋翼的固定翼不进表', () => {
  const byId = new Map(ENTITY_TEMPLATES.map((r) => [r.id, r]))
  const air = ENTITY_TEMPLATES.filter((r) => r.domain === 'aircraft')
  const rotorcraft = air.filter((r) => lowClass(r))
  for (const [id, v] of Object.entries(MODEL_CRUISE_ALT_M)) {
    assert.match(id, /^ent:[a-z0-9][a-z0-9-]{0,47}$/, id)
    assert.ok(okCruise(v) && v < CRUISE_ALT_M_DEFAULT, `${id} = ${v}：0…30000 且低于 FL350`)
    const r = byId.get(id)
    if (r) { assert.equal(r.domain, 'aircraft', id); assert.ok(lowClass(r), `${id} 不是旋翼 / 垂起类`) }
    else assert.equal(rotorcraft.length, 0, `${id} 不在模板目录里（目录里已有旋翼机模板，疑似 id 写错）`)
  }
  for (const r of rotorcraft) assert.ok(has(MODEL_CRUISE_ALT_M, r.id), `${r.id}（${lowClass(r)}）没登记缺省巡航高度，会飞到 FL350`)
  for (const r of air) if (!lowClass(r)) assert.ok(!has(MODEL_CRUISE_ALT_M, r.id), `${r.id} 是固定翼，不该有模型缺省`)
  if (rotorcraft.length) {
    // 量级：多旋翼 < 直升机 < 垂起固定翼（示意值的相对关系）
    const of = (cls) => rotorcraft.filter((r) => lowClass(r) === cls).map((r) => MODEL_CRUISE_ALT_M[r.id])
    for (const q of of('multirotor')) for (const h of of('heli')) assert.ok(q < h, `多旋翼 ${q} < 直升机 ${h}`)
    for (const h of of('heli')) for (const w of of('vtol')) assert.ok(h < w, `直升机 ${h} < 垂起 ${w}`)
  }
  console.log(`  模板目录：飞机 ${air.length} 型，旋翼 / 垂起 ${rotorcraft.length} 型（${rotorcraft.map((r) => r.id).join('、') || '本分支没有'}）`)
})

console.log(`modelTrajCruiseDefault: ${n} 项通过`)
