// 航迹时间：出发 / 到达 / 历时 / 速度 四项联动（3D 页侧栏航迹卡片「时间」、航迹表格参数栏、地图右键「航迹时间…」共用）。
// 纯 ESM、node 可测。只读写航迹对象上的 t0Ms / speedKmh / pts[i].tMs —— 位置、剖面、排程的口径仍全在 trajKinematics，这里不另算。
//
// ── 口径（与时间轴设置浮层「起始 / 终止 / 时长」、STK Great Arc 的 Start Time 同一套）──
//   出发  改它 = 整条排程平移：起始时刻与各航点时刻钉点一起挪 Δ，历时与各段速度不变
//         （STK：Start Time 改了，航点表里的时刻跟着顺延）。
//   到达  改它 = 出发不动、历时随之变；改历时同理。
//         没有航点钉点：换算成匀速地速（全程 ÷ 历时）；有钉点：各钉点相对出发按同一比例伸缩、外推用的地速同比反缩，
//         各段快慢的比例不变。
//   速度  没有钉点 = 地速原值；有钉点 = 全程均速（全程 ÷ 历时），改它与改历时同一路。
//   静止档（排不出程）改任一项都补齐成能动的排程：缺出发取调用方给的此刻（时间轴游标），缺地速取缺省地速
//         （按模型 / 类型，见 defaultSpeedKmh）；只填到达时按地速倒推出发（飞行计划 ETA 档的算法）。
//   清除  删出发时刻与全部航点时刻钉点，回静止档；地速留着（下次设出发沿用）。
//   时刻一律取整毫秒（Excel 说明行只到毫秒）。越界 / 不合时序 / 超速时返回错误码，航迹原样不动（改到一半失败整笔撤回）。
//
// 导出：trajTiming（读数）/ retimeTraj（改一项）/ defaultSpeedKmh / SPEED_KMH_DEFAULT

import { trajStartMs, trajEndMs, trajLengthM } from './trajKinematics.mjs'
import { SPEED_KMH_MAX, T0_MS_MIN, T0_MS_MAX } from './entityRuntime.mjs'

const fin = Number.isFinite
const okT = (v) => fin(v) && v >= T0_MS_MIN && v <= T0_MS_MAX
const okV = (v) => fin(v) && v > 0 && v <= SPEED_KMH_MAX
const ptsOf = (t) => (Array.isArray(t.pts) ? t.pts : [])
const isPin = (p) => p !== null && typeof p === 'object' && fin(p.lat) && fin(p.lon) && fin(p.tMs)
const KN_KMH = 1.852

/**
 * 缺省地速（km/h）。★ illustrative（示意值，没有核到出处）：飞行 850（喷气客机巡航地速一带）、航行 30（≈ 16 kn，商船常见航速一带）。
 * 只在「设了出发却没有地速」时补进航迹对象（写进去、界面可见可改），不改运动学口径。
 */
export const SPEED_KMH_DEFAULT = Object.freeze({ flight: 850, sea: 30 })

/**
 * 某条航迹的缺省地速：挂的模型在模板 ops 里有出处的巡航 / 服务速度优先（cruiseSpeedKmh > serviceSpeedKn > speedKt），
 * 否则按类型取 SPEED_KMH_DEFAULT。最大速度（maxSpeedKtas）、马赫数不算巡航地速，不取。
 * @param {string} kind  'flight' | 其它（按航行）
 * @param {object} [ops] 实体模板的 ops（{key: {value, source}}）
 */
export function defaultSpeedKmh(kind, ops) {
  const val = (o) => (o !== null && typeof o === 'object' && fin(o.value) && o.value > 0 ? o.value : NaN)
  if (ops !== null && typeof ops === 'object') {
    const a = val(ops.cruiseSpeedKmh)
    if (okV(a)) return a
    for (const k of ['serviceSpeedKn', 'speedKt']) {
      const kn = val(ops[k])
      if (fin(kn)) { const v = Math.round(kn * KN_KMH * 10) / 10; if (okV(v)) return v }
    }
  }
  return kind === 'flight' ? SPEED_KMH_DEFAULT.flight : SPEED_KMH_DEFAULT.sea
}

/**
 * 航迹的时间读数。
 *   L         全程（m，WGS-84 测地线）
 *   moving    排得出程（= entityRuntime.trajMoving）
 *   depMs / arrMs  出发 / 到达（UTC ms，排程里首末航点的时刻；静止档 NaN）
 *   durMs     历时（ms）；静止档有地速、没有钉点时 = 全程 ÷ 地速，否则 NaN
 *   speedKmh  速度读数：没有钉点 = 地速原值；有钉点且排得出程 = 全程均速；静止档 = 地速原值（没有 NaN）
 *   avg       speedKmh 是全程均速（有钉点）
 *   pins      航点时刻钉点个数（坐标有效的航点）
 *   t0Set     航迹自己带起始时刻
 * 经响应式代理传进来即建立依赖（改出发 / 速度 / 航点 / 钉点都会让读数重算）。
 */
export function trajTiming(t) {
  const o = { L: 0, moving: false, depMs: NaN, arrMs: NaN, durMs: NaN, speedKmh: NaN, avg: false, pins: 0, t0Set: false }
  if (t === null || typeof t !== 'object') return o
  o.L = trajLengthM(t)
  for (const p of ptsOf(t)) if (isPin(p)) o.pins++
  o.t0Set = fin(t.t0Ms)
  const sp = t.speedKmh, v = fin(sp) && sp > 0 ? sp : NaN
  const dep = trajStartMs(t), arr = trajEndMs(t)
  if (fin(dep) && fin(arr) && arr > dep) {
    o.moving = true; o.depMs = dep; o.arrMs = arr; o.durMs = arr - dep
    if (o.pins) { o.avg = true; o.speedKmh = o.L * 3600 / o.durMs } else o.speedKmh = v
  } else {
    o.speedKmh = v
    if (o.L > 0 && v > 0 && !o.pins) o.durMs = o.L * 3600 / v
  }
  return o
}

// ─────────────────────────────── 改一项 ───────────────────────────────

const OK = Object.freeze({ ok: true })
const fail = (err) => ({ ok: false, err })

// 改动前的快照：失败时整笔撤回（只涉及 t0Ms / speedKmh / pts[i].tMs 三类字段）
function snapOf(t) {
  return {
    h0: 't0Ms' in t, t0: t.t0Ms, hv: 'speedKmh' in t, v: t.speedKmh,
    pts: ptsOf(t).map((p) => (p !== null && typeof p === 'object' ? [p, 'tMs' in p, p.tMs] : null))
  }
}
function restore(t, s) {
  if (s.h0) t.t0Ms = s.t0; else if ('t0Ms' in t) delete t.t0Ms
  if (s.hv) t.speedKmh = s.v; else if ('speedKmh' in t) delete t.speedKmh
  for (const e of s.pts) {
    if (!e) continue
    const [p, has, val] = e
    if (has) p.tMs = val; else if ('tMs' in p) delete p.tMs
  }
}
function clearTiming(t) {
  if ('t0Ms' in t) delete t.t0Ms
  for (const p of ptsOf(t)) if (p !== null && typeof p === 'object' && 'tMs' in p) delete p.tMs
}
// 钉点逐个换算成新时刻（f：旧 → 新，取整毫秒）；有一个越界就整组作废（返回 null）
function mapPins(t, f) {
  const out = []
  for (const p of ptsOf(t)) {
    if (!isPin(p)) continue
    const v = Math.round(f(p.tMs))
    if (!okT(v)) return null
    out.push([p, v])
  }
  return out
}
const writePins = (list) => { for (const [p, v] of list) p.tMs = v }

// 整条平移到出发 d（运动档）
function shiftTo(t, tm, d) {
  const dd = d - tm.depMs
  const pins = mapPins(t, (v) => v + dd)
  if (!pins) return fail('range')
  t.t0Ms = d
  writePins(pins)
  return OK
}
// 出发不动、历时改成 dur（运动档）。exactV：改的是速度时的原值（没有钉点时直接存它，免得换算出 849.9999…）
function scaleTo(t, tm, dur, exactV) {
  if (!(dur > 0) || !fin(dur)) return fail('bad')
  const d0 = Math.round(tm.depMs)
  if (!tm.pins) {
    const v = fin(exactV) ? exactV : tm.L * 3600 / dur
    if (!(v > 0)) return fail('bad')
    if (v > SPEED_KMH_MAX) return fail('fast')
    t.t0Ms = d0
    t.speedKmh = v
    return OK
  }
  const k = dur / tm.durMs
  if (!(k > 0) || !fin(k)) return fail('bad')
  const pins = mapPins(t, (v) => d0 + (v - tm.depMs) * k)
  if (!pins) return fail('range')
  let v = NaN
  if (okV(t.speedKmh)) { v = t.speedKmh / k; if (v > SPEED_KMH_MAX) return fail('fast'); if (!(v > 0)) return fail('bad') }
  t.t0Ms = d0
  writePins(pins)
  if (fin(v)) t.speedKmh = v
  return OK
}
// ── 静止档的补齐 ──
// 静止档只有三种来由：① 没有起始也没有钉点；② 有起始、缺地速，钉点全不合时序（不晚于起始）；③ 没有起始、缺地速，只有一个钉点
// （首尾都要外推却没有速度可借）。补上缺的那一项即可排程；带钉点的补齐后历时不一定正好，再按目标伸缩一次。
const movingNow = (t) => fin(trajEndMs(t))

function editDep(t, tm, d, vDef) {
  if (!okT(d)) return fail('range')
  if (tm.moving) return shiftTo(t, tm, d)
  t.t0Ms = d
  if (!movingNow(t) && !okV(t.speedKmh)) t.speedKmh = vDef
  return movingNow(t) ? OK : fail('bad')
}
function editArr(t, tm, a, vDef) {
  if (!okT(a)) return fail('range')
  if (tm.moving) return a > tm.depMs ? scaleTo(t, tm, a - tm.depMs, NaN) : fail('order')
  if (fin(t.t0Ms)) {
    // ②：出发 → 到达定地速
    if (!(a > t.t0Ms)) return fail('order')
    const v = tm.L * 3600 / (a - t.t0Ms)
    if (v > SPEED_KMH_MAX) return fail('fast')
    if (!(v > 0)) return fail('bad')
    t.speedKmh = v
  } else if (tm.pins) {
    // ③：补地速即可排程，出发由钉点外推
    if (!okV(t.speedKmh)) t.speedKmh = vDef
  } else {
    // ①：按地速（没有取缺省）倒推出发 —— 飞行计划 ETA 档
    const v = okV(t.speedKmh) ? t.speedKmh : vDef
    const d = Math.round(a - tm.L * 3600 / v)
    if (!okT(d)) return fail('range')
    t.t0Ms = d
    t.speedKmh = v
  }
  const t2 = trajTiming(t)
  if (!t2.moving) return fail('bad')
  if (Math.abs(t2.arrMs - a) < 1) return OK
  return a > t2.depMs ? scaleTo(t, t2, a - t2.depMs, NaN) : fail('order')
}
function editDur(t, tm, dur, exactV, now) {
  if (!(dur > 0) || !fin(dur)) return fail('bad')
  if (tm.moving) return scaleTo(t, tm, dur, exactV)
  const v = fin(exactV) ? exactV : tm.L * 3600 / dur
  if (v > SPEED_KMH_MAX) return fail('fast')
  if (!(v > 0)) return fail('bad')
  t.speedKmh = v
  if (!movingNow(t)) {
    // ①：没有出发 → 取此刻（时间轴游标）
    if (fin(t.t0Ms) || !okT(now)) return fail('bad')
    t.t0Ms = now
  }
  const t2 = trajTiming(t)
  if (!t2.moving) return fail('bad')
  return Math.abs(t2.durMs - dur) < 1 ? OK : scaleTo(t, t2, dur, exactV)
}

/**
 * 改一项，就地写进航迹 t（只动 t0Ms / speedKmh / pts[i].tMs）。
 * @param {object} t     航迹对象（页面传响应式对象即可，写入照常触发更新）
 * @param {{key:'dep'|'arr'|'dur'|'speed'|'clear', value?:number}} edit
 *        dep / arr：UTC ms；dur：ms；speed：km/h
 * @param {{nowMs?:number, defSpeedKmh?:number}} [ctx]  静止档补齐用：缺出发取 nowMs，缺地速取 defSpeedKmh（不合法时按类型缺省）
 * @returns {{ok:true}|{ok:false, err:'short'|'bad'|'range'|'order'|'fast'}}
 *   short = 有效航点不足 / 全程零长；bad = 值不是正的有限数（或缺 nowMs 补不齐）；range = 时刻超出四位年；
 *   order = 到达不晚于出发；fast = 地速超出上限 SPEED_KMH_MAX。出错时 t 原样不动。
 */
export function retimeTraj(t, edit, ctx) {
  if (t === null || typeof t !== 'object' || !edit || typeof edit !== 'object') return fail('bad')
  const snap = snapOf(t)
  let r
  try { r = run(t, edit, ctx || {}) } catch { r = fail('bad') }
  if (!r.ok) restore(t, snap)
  return r
}
function run(t, edit, c) {
  if (edit.key === 'clear') { clearTiming(t); return OK }
  const tm = trajTiming(t)
  if (!(tm.L > 0)) return fail('short')
  const x = Number(edit.value)
  if (!fin(x)) return fail('bad')
  const now = fin(c.nowMs) ? Math.round(c.nowMs) : NaN
  const vDef = okV(c.defSpeedKmh) ? c.defSpeedKmh : defaultSpeedKmh(t.kind)
  switch (edit.key) {
    case 'dep': return editDep(t, tm, Math.round(x), vDef)
    case 'arr': return editArr(t, tm, Math.round(x), vDef)
    case 'dur': return editDur(t, tm, x, NaN, now)
    case 'speed':
      if (!(x > 0)) return fail('bad')
      if (x > SPEED_KMH_MAX) return fail('fast')
      return editDur(t, tm, tm.L * 3600 / x, x, now)
    default: return fail('bad')
  }
}
