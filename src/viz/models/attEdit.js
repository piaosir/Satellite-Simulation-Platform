// 本体姿态律的编辑逻辑（覆盖分析「天线 boresight · 姿态 + 挂点」一节 GrdAttitudeFields.vue 用）：
// 界面上的一次改动 → 一份新的 {law, params}；外加读数 / 下拉要用的缺省推导。无 vue / DOM，node 单测直接 import（modelAttEdit.test.mjs）。
//
// 不另立口径 —— 消费端是 packages/core/models/attitude.mjs（attitudeBasisEcef），校验端是 schema.mjs（normalizeAttitude），
// 这里的每条缺省都与那边逐条对应：
//   · 主轴缺省：sun −Z、target +Z（lawSun / lawTarget）；
//   · 次约束缺省：sun 律主轴 ∥ ±Z 取 velocity、否则 nadir；target 律 sun；
//   · 次约束本体轴缺省：nadir +Z、orbitNormal −Y、velocity / sun +X（secAxisInto）；主轴与次轴平行即退化（crossLen ≤ 1e-6），
//     消费端沿 velocity → nadir → orbitNormal 往下退；
//   · inertial：q（本体 → TEME）优先，否则 eulerDeg {yaw, pitch, roll}（3-2-1，quatFromEulerZYX 同式），都没有 = 单位旋转。
// 编辑口径：
//   · 切律不丢别的律填过的参数（params 整份照留，各律只读自己的键）—— 与模型工作台卫星页同一口径；
//   · 切到「对目标定向」而还没有目标、切到「惯性定向」而还没有姿态时，按【切换那一刻】的本体姿态补上（seed，宿主给）：
//     目标 = 主轴此刻射到地面的那一点，惯性姿态 = 此刻的本体姿态冻结在惯性系 —— 切过去那一刻视轴不跳；
//   · 惯性律换给法（欧拉角 ↔ 四元数）按当前姿态互换，姿态不变（不是重置成单位旋转）；
//   · 姿态偏置为 0 不落键（与工作台「偏航偏置」写 null 同口径），绑定表不留一串 0。
// 空间点目标：地心经纬度 + 高度（r = A + h，与手动「空间点」指向、轨道壳层同口径），存成 target {kind:'ecef', ecefKm}。
import { quatFromBasis } from '@core/models/attitude.mjs'
import { A, ecefToGeodetic, geocentricToEcef, rayEllipsoid } from '../wgs84.js'

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
const unit = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null }
const crossLen = (a, b) => Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
const roundTo = (v, n) => { const k = 10 ** n, r = Math.round(v * k) / k; return r === 0 ? 0 : r }

export const LAWS = Object.freeze(['nadir', 'yawSteer', 'sun', 'inertial', 'target'])
export const LAW_NAMES = Object.freeze({ nadir: '对地定向', yawSteer: '偏航导引', sun: '对日定向', inertial: '惯性定向', target: '对目标定向' })
export const SECONDARIES = Object.freeze(['nadir', 'velocity', 'sun', 'orbitNormal'])
export const SECONDARY_NAMES = Object.freeze({ nadir: '天底方向', velocity: '速度方向', sun: '太阳方向', orbitNormal: '轨道法向' })
export const AXES = Object.freeze(['+X', '-X', '+Y', '-Y', '+Z', '-Z'])
const AXIS_V = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] }
export const BIAS_KEYS = Object.freeze(['rollBiasDeg', 'pitchBiasDeg', 'yawBiasDeg'])
/** 轴名显示：负号用真减号（U+2212），与工作台 / 报告同一写法 */
export const axisLabel = (k) => String(k).replace('-', '−')

export function axisVec(key) { return AXIS_V[key] ? AXIS_V[key].slice() : null }
/** 本体轴（'+X' … 或 [x,y,z]）→ '+X' …；不是坐标轴（任意方向）返回 '' */
export function axisKeyOf(v) {
  if (typeof v === 'string') return AXIS_V[v] ? v : ''
  if (!isVec3(v)) return ''
  const u = unit(v)
  if (!u) return ''
  for (const k of AXES) { const a = AXIS_V[k]; if (Math.abs(a[0] * u[0] + a[1] * u[1] + a[2] * u[2] - 1) < 1e-9) return k }
  return ''
}
function vecOf(v) { if (typeof v === 'string') return axisVec(v); return isVec3(v) ? unit(v) : null }

/** 任意形状的姿态 → {law, params}（params 浅拷贝；law 非法按 nadir，同 normalizeAttitude） */
export function attOf(a) {
  const law = a && LAWS.includes(a.law) ? a.law : 'nadir'
  return { law, params: a && isObj(a.params) ? { ...a.params } : {} }
}
const next = (att, fn) => { const o = attOf(att); fn(o.params, o); return o }

// ───────────── 主轴 / 次约束（sun、target 两律）─────────────
export function primaryAxisVec(law, p) { return vecOf(p && p.axis) || axisVec(law === 'sun' ? '-Z' : '+Z') }
/** 主轴的轴名；写了却不是坐标轴（JSON 导入的任意方向）返回 ''（下拉显示成自定义方向） */
export function primaryAxisKey(law, p) {
  if (p && p.axis !== undefined && p.axis !== null) return axisKeyOf(p.axis)
  return law === 'sun' ? '-Z' : '+Z'
}
/** 次约束缺省（没写 secondary 时消费端用哪一个） */
export function defaultSecondary(law, p) {
  if (law === 'target') return 'sun'
  return Math.abs(primaryAxisVec(law, p)[2]) > 1 - 1e-9 ? 'velocity' : 'nadir'
}
export function effectiveSecondary(law, p) { return p && SECONDARIES.includes(p.secondary) ? p.secondary : defaultSecondary(law, p) }
export function defaultSecondaryAxisKey(kind) { return kind === 'nadir' ? '+Z' : (kind === 'orbitNormal' ? '-Y' : '+X') }
export function secondaryAxisVec(law, p) { return vecOf(p && p.secondaryAxis) || axisVec(defaultSecondaryAxisKey(effectiveSecondary(law, p))) }
/** 主轴与次约束本体轴平行（TRIAD 退化，消费端只能沿退链改用别的约束）。只对 sun / target 有意义 */
export function secondaryConflict(law, p) {
  if (law !== 'sun' && law !== 'target') return false
  return !(crossLen(primaryAxisVec(law, p), secondaryAxisVec(law, p)) > 1e-6)
}

// ───────────── 惯性律：3-2-1 欧拉角 ↔ 四元数（与 attitude.mjs quatFromEulerZYX 同式）─────────────
/** q = qz(yaw) ⊗ qy(pitch) ⊗ qx(roll)，[x, y, z, w] */
export function quatFromEulerZYX(e) {
  const hz = (Number(e && e.yaw) || 0) * D2R / 2, hy = (Number(e && e.pitch) || 0) * D2R / 2, hx = (Number(e && e.roll) || 0) * D2R / 2
  const sz = Math.sin(hz), cz = Math.cos(hz), sy = Math.sin(hy), cy = Math.cos(hy), sx = Math.sin(hx), cx = Math.cos(hx)
  const x1 = -(sz * sy), y1 = cz * sy, z1 = sz * cy, w1 = cz * cy
  return [w1 * sx + x1 * cx, y1 * cx + z1 * sx, -(y1 * sx) + z1 * cx, w1 * cx - x1 * sx]
}
/** 四元数 → 3-2-1 欧拉角 {yaw, pitch, roll}（度）。俯仰 ±90°（万向节锁）时滚转取 0、偏航吸收两者之差 */
export function eulerZYXFromQuat(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  const x = q[0] / n, y = q[1] / n, z = q[2] / n, w = q[3] / n
  const r20 = 2 * (x * z - y * w)
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r20))) * R2D
  if (Math.abs(r20) < 1 - 1e-12) {
    return { yaw: Math.atan2(2 * (x * y + z * w), 1 - 2 * (y * y + z * z)) * R2D, pitch, roll: Math.atan2(2 * (y * z + x * w), 1 - 2 * (x * x + y * y)) * R2D }
  }
  return { yaw: Math.atan2(-2 * (x * y - z * w), 1 - 2 * (x * x + z * z)) * R2D, pitch, roll: 0 }
}
export function inertialModeOf(p) { return p && Array.isArray(p.q) ? 'q' : 'euler' }
/** 当前惯性姿态的欧拉角（q 优先；都没有 = 0, 0, 0） */
export function eulerOf(p) {
  if (p && Array.isArray(p.q) && p.q.length === 4 && p.q.every(isNum)) return eulerZYXFromQuat(p.q)
  const e = p && p.eulerDeg
  if (Array.isArray(e)) return { yaw: Number(e[0]) || 0, pitch: Number(e[1]) || 0, roll: Number(e[2]) || 0 }
  return { yaw: Number(e && e.yaw) || 0, pitch: Number(e && e.pitch) || 0, roll: Number(e && e.roll) || 0 }
}
/** 当前惯性姿态的四元数（归一；q 优先，否则由欧拉角换） */
export function quatOf(p) {
  const q = p && Array.isArray(p.q) && p.q.length === 4 && p.q.every(isNum) ? p.q.slice() : quatFromEulerZYX(eulerOf(p))
  const n = Math.hypot(q[0], q[1], q[2], q[3])
  return n > 0 ? q.map((v) => v / n) : [0, 0, 0, 1]
}
const roundEuler = (e) => ({ yaw: roundTo(e.yaw, 6), pitch: roundTo(e.pitch, 6), roll: roundTo(e.roll, 6) })
const roundQuat = (q) => { const r = q.map((v) => roundTo(v, 9)), n = Math.hypot(r[0], r[1], r[2], r[3]); return n > 0 ? r.map((v) => v / n) : [0, 0, 0, 1] }

// ───────────── 切换那一刻的本体姿态（seed，宿主按当前仿真时刻解出后给）─────────────
// seed = { X, Y, Z: 本体三轴（标准 ECEF 单位矢量）, S: 星位（ECEF km）, gmstRad: 惯性律在该时刻用的 GMST }
/** 本体三轴（ECEF）冻结到 TEME：绕极轴 +GMST（satellite.js eciToEcf 的逆），再取 本体 → TEME 四元数 */
export function freezeQuat(seed) {
  const g = seed.gmstRad, c = Math.cos(g), s = Math.sin(g)
  const toT = (v) => [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]
  return quatFromBasis(toT(seed.X), toT(seed.Y), toT(seed.Z), [0, 0, 0, 0])
}
/** 本体某轴此刻射到地面的落点（大地经纬度）；越地平取星下点 */
export function aimOf(seed, axis) {
  const a = axis || [0, 0, 1]
  const d = [0, 1, 2].map((i) => a[0] * seed.X[i] + a[1] * seed.Y[i] + a[2] * seed.Z[i])
  const P = rayEllipsoid(seed.S, d)
  const g = P ? ecefToGeodetic(P[0], P[1], P[2]) : ecefToGeodetic(seed.S[0], seed.S[1], seed.S[2])
  return { lat: roundTo(g.lat, 6), lon: roundTo(wrapLon(g.lon), 6) }
}
// 经度归到 (−180, 180]：已在区间内的原样不动（取模再减会把 116.4 算成 116.39999999999998，同 schema normTarget）
const wrapLon = (lon) => {
  if (lon <= 180 && lon > -180) return lon
  let L = ((lon + 180) % 360 + 360) % 360 - 180
  if (L === -180) L = 180
  return L
}
const okSeed = (s) => !!(s && isVec3(s.X) && isVec3(s.Y) && isVec3(s.Z) && isVec3(s.S) && isNum(s.gmstRad))

// ───────────── 改动 → 新姿态 ─────────────
/** 切律：参数照留；对目标 / 惯性律缺内容时按 seed 补上（seed 缺省或不全就不补，按消费端缺省走） */
export function withLaw(att, law, seed) {
  if (!LAWS.includes(law)) return attOf(att)
  return next(att, (p, o) => {
    o.law = law
    if (!okSeed(seed)) return
    if (law === 'target' && !isObj(p.target)) {
      const g = aimOf(seed, primaryAxisVec('target', p))
      p.target = { kind: 'station', latDeg: g.lat, lonDeg: g.lon, altM: 0 }
    }
    if (law === 'inertial' && !(Array.isArray(p.q) || p.eulerDeg)) p.eulerDeg = roundEuler(eulerZYXFromQuat(freezeQuat(seed)))
  })
}
/** 普通参数：null / undefined / '' = 删掉这个键（回消费端缺省） */
export function withParam(att, key, value) {
  return next(att, (p) => { if (value === null || value === undefined || value === '') delete p[key]; else p[key] = value })
}
/** 姿态偏置（滚转 / 俯仰 / 偏航）：0 不落键 */
export function withBias(att, key, v) {
  return next(att, (p) => { const x = Number(v); if (!BIAS_KEYS.includes(key)) return; if (!isNum(x) || x === 0) delete p[key]; else p[key] = x })
}
/** 本体轴参数（axis / secondaryAxis）：'' = 缺省 */
export function withAxis(att, key, axisKey) {
  return next(att, (p) => { const v = axisVec(axisKey); if (v) p[key] = v; else delete p[key] })
}
/** 惯性律换给法：按当前姿态互换（姿态不变） */
export function withInertialMode(att, mode) {
  return next(att, (p) => {
    if (mode === 'q') { p.q = roundQuat(quatOf(p)); delete p.eulerDeg } else { p.eulerDeg = roundEuler(eulerOf(p)); delete p.q }
  })
}
export function withEuler(att, k, v) {
  return next(att, (p) => {
    if (!['yaw', 'pitch', 'roll'].includes(k)) return
    const e = eulerOf(p)
    e[k] = Number(v) || 0
    p.eulerDeg = roundEuler(e); delete p.q
  })
}
/** 改四元数的一个分量后整体归一；归一不了（全零）就不改 */
export function withQuat(att, i, v) {
  return next(att, (p) => {
    if (!(i >= 0 && i < 4)) return
    const q = quatOf(p)
    q[i] = Number(v) || 0
    if (!(Math.hypot(q[0], q[1], q[2], q[3]) > 1e-9)) return
    p.q = roundQuat(q); delete p.eulerDeg
  })
}

// ───────────── 目标律的目标 ─────────────
/** 目标 → 界面视图：{kind:'station', lat, lon, altM, name} | {kind:'sat', satKey} | {kind:'ecef', lat, lon, altKm} | {kind:''} */
export function targetView(p) {
  const t = p && p.target
  if (!isObj(t)) return { kind: '' }
  if (t.kind === 'station') return { kind: 'station', lat: Number(t.latDeg), lon: Number(t.lonDeg), altM: Number(t.altM) || 0, name: typeof t.name === 'string' ? t.name : '' }
  if (t.kind === 'sat') return { kind: 'sat', satKey: typeof t.satKey === 'string' ? t.satKey : '' }
  if (t.kind === 'ecef' && isVec3(t.ecefKm)) {
    const [x, y, z] = t.ecefKm, r = Math.hypot(x, y, z)
    return { kind: 'ecef', lat: roundTo(Math.asin(Math.max(-1, Math.min(1, z / r))) * R2D, 6), lon: roundTo(Math.atan2(y, x) * R2D, 6), altKm: roundTo(r - A, 6) }
  }
  return { kind: '' }
}
/** 改地球站（patch：lat / lon / altM / name 的任意子集）。改坐标即去掉站名（站名只是选城市时带进来的标注，坐标一动就不再对） */
export function withStation(att, patch, seed) {
  return next(att, (p) => {
    const cur = targetView(p)
    const base = cur.kind === 'station' ? cur
      : (cur.kind === 'ecef' ? { lat: cur.lat, lon: cur.lon, altM: 0, name: '' }
        : (okSeed(seed) ? { ...aimOf(seed, primaryAxisVec('target', p)), altM: 0, name: '' } : { lat: 0, lon: 0, altM: 0, name: '' }))
    const t = { kind: 'station', latDeg: base.lat, lonDeg: base.lon, altM: base.altM || 0 }
    let name = base.name || ''
    if (patch) {
      if (isNum(patch.lat)) { t.latDeg = patch.lat; name = '' }
      if (isNum(patch.lon)) { t.lonDeg = wrapLon(patch.lon); name = '' }
      if (isNum(patch.altM)) t.altM = patch.altM
      if (typeof patch.name === 'string') name = patch.name
    }
    if (name) t.name = name
    p.target = t
  })
}
/** 改空间点（patch：lat / lon / altKm 的任意子集；地心球面口径） */
export function withSpacePoint(att, patch, seed) {
  return next(att, (p) => {
    const cur = targetView(p)
    const base = cur.kind === 'ecef' ? cur
      : (cur.kind === 'station' ? { lat: cur.lat, lon: cur.lon, altKm: 0 }
        : (okSeed(seed) ? { ...aimOf(seed, primaryAxisVec('target', p)), altKm: 0 } : { lat: 0, lon: 0, altKm: 0 }))
    const lat = patch && isNum(patch.lat) ? patch.lat : base.lat
    const lon = patch && isNum(patch.lon) ? patch.lon : base.lon
    const alt = patch && isNum(patch.altKm) ? patch.altKm : base.altKm
    p.target = { kind: 'ecef', ecefKm: geocentricToEcef(lon, lat, alt).map((v) => roundTo(v, 6)) }
  })
}
export function withTargetSat(att, satKey) {
  return next(att, (p) => { if (typeof satKey === 'string' && satKey) p.target = { kind: 'sat', satKey } })
}
