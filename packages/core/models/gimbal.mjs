// 万向节可达（任务书 §6.5；DESIGN2 §1）：azel / xy 两轴解算器 + 时间序列可跟踪分析。纯 ESM、无依赖。
//
// ── 轴约定（全在挂点系：z = 视轴、y = up、x = y × z，见 attitude.mountFrame；两档零位都 = 视轴）──
//   'azel'（俯仰在方位之上，地面天线座的样子：方位轴 = up）
//       外轴 a1 = 方位 az：绕挂点 +y 右手转（视轴 z 转向 +x 为正）
//       内轴 a2 = 俯仰 el：朝 +y 抬起为正
//       d(a1, a2) = [cos a2·sin a1, sin a2, cos a2·cos a1]；奇点（keyhole）= ±y（el = ±90°，up 方向的「天顶」）
//   'xy'（X-Y 座：奇点放到「地平」上，过顶跟踪不翻转）
//       外轴 a1 = X：绕挂点 +x 转，视轴朝 +y 偏为正
//       内轴 a2 = Y：绕转过后的 y 转，视轴朝 +x 偏为正
//       d(a1, a2) = [sin a2, cos a2·sin a1, cos a2·cos a1]；奇点 = ±x（Y = ±90°）
//   对地挂点（视轴 +Z、up −Y）上两种奇点都在视轴 90° 外，跟地球站碰不到；把 up 定在哪决定 keyhole 在哪。
//   每个方向有两组解：主解 (a1, a2)（a2 ∈ [−90°, 90°]）与翻转解 (a1 + 180°, 180° − a2)，再加 360° 的整数倍；
//   在限位内挑离「当前实际角度」最近的一组（连续性优先，线缆缠绕式的大行程限位 [−270°, 270°] 也照此选）。
//
// ── trackSeries 的物理模型 ──
//   每拍：目标方向 → 限位内最近解（命令角）；执行机构按角速率上限从上一拍的实际角追命令角（每轴单步 ≤ rate·Δt）；
//   不可跟踪原因互斥、按优先级计：
//     limit   限位内无解（执行机构原地保持）；固定天线（type 'none'）= 目标在视场外
//     mask    有解，但视线在本体掩模里被挡（mask 查表，方向用本体系）
//     rate    有解、没被挡，但实际指向与目标夹角 > tolDeg（追不上：过 keyhole、重新捕获时回转）
//     noTarget 该拍无目标方向（null / NaN：地球挡住、星历缺）——不进分母，也打断「最长中断」
//   时长按中点权重（每拍代表 [t_{i−½}, t_{i+½}]），步长不均匀也对；角速率峰值 = 相邻两拍命令角之差 / Δt 的最大值（「需要的」速率）。
//   type 'none'（固定天线，schema 口径「限位照存不用」）：命令角 / 实际角恒为 (0, 0)（= 视轴），不解算、不限速；
//     目标与视轴夹角 ≤ 半视场（opts.fovDeg / 2 → opts.mount.fovDeg / 2 → 没有就用 tolDeg）记 OK，否则记 limit；peakRate 恒 null。
//   挂点系 ↔ 本体系：opts.frame（attitude.mountFrame 的结果）；没给就按 opts.mount 现算，再没有按 D1 缺省挂点
//     （视轴 +Z、up −Y）——缺省挂点系不是恒等（x = −X_B、y = −Y_B），所以不能把挂点系方向直接当本体系查掩模；结果 frameDefaulted 标出。
//
// 导出：GIMBAL_TYPES / REASON / solveAzEl / solveXY / solveGimbal / dirFromAzEl / dirFromXY / dirFromGimbal /
//       normalizeGimbal / pickSolution / trackSeries

import { dirBodyToMount, dirMountToBody, mountFrame } from './attitude.mjs'
import { maskLookup } from './mask.mjs'

export const GIMBAL_TYPES = Object.freeze(['none', 'azel', 'xy'])
export const REASON = Object.freeze({ OK: 0, LIMIT: 1, MASK: 2, RATE: 3, NO_TARGET: 4 })

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const SING = 1e-12
const gx = (v) => (v.x !== undefined ? v.x : v[0]), gy = (v) => (v.y !== undefined ? v.y : v[1]), gz = (v) => (v.z !== undefined ? v.z : v[2])
// |(x,y,z)| / |(x,y)|：常规量级走 sqrt(Σx²)，越出 (1e-290, 1e290) 才退回 Math.hypot（V8 的 Math.hypot 每次调用都分配暂存数组，热路径避开）
const norm3 = (x, y, z) => { const s = x * x + y * y + z * z; return s > 1e-290 && s < 1e290 ? Math.sqrt(s) : Math.hypot(x, y, z) }
const norm2 = (x, y) => { const s = x * x + y * y; return s > 1e-290 && s < 1e290 ? Math.sqrt(s) : Math.hypot(x, y) }
const isFrame = (f) => !!(f && f.x && f.y && f.z)

/**
 * azel 主解（度）：a2 = atan2(d_y, hypot(d_x, d_z)) ∈ [−90, 90]、a1 = atan2(d_x, d_z) ∈ (−180, 180]。
 * 奇点（|cos a2| < 1e-12，方向 ∥ ±y）方位无定义：取 prevA1（缺省 0）——跟踪时保持外轴不动，不乱跳。
 * @returns {{a1:number, a2:number, singular:boolean}}
 */
export function solveAzEl(dirMount, prevA1, out) {
  const o = out || { a1: 0, a2: 0, singular: false }
  const x = gx(dirMount), y = gy(dirMount), z = gz(dirMount), h = norm2(x, z)
  o.a2 = Math.atan2(y, h) * R2D
  o.singular = !(h > SING * Math.max(1, Math.abs(y)))
  o.a1 = o.singular ? (Number.isFinite(prevA1) ? prevA1 : 0) : Math.atan2(x, z) * R2D
  return o
}
/** xy 主解（度）：a2 = atan2(d_x, hypot(d_y, d_z))、a1 = atan2(d_y, d_z)；奇点（方向 ∥ ±x）a1 取 prevA1。 */
export function solveXY(dirMount, prevA1, out) {
  const o = out || { a1: 0, a2: 0, singular: false }
  const x = gx(dirMount), y = gy(dirMount), z = gz(dirMount), h = norm2(y, z)
  o.a2 = Math.atan2(x, h) * R2D
  o.singular = !(h > SING * Math.max(1, Math.abs(x)))
  o.a1 = o.singular ? (Number.isFinite(prevA1) ? prevA1 : 0) : Math.atan2(y, z) * R2D
  return o
}
export function solveGimbal(type, dirMount, prevA1, out) { return type === 'xy' ? solveXY(dirMount, prevA1, out) : solveAzEl(dirMount, prevA1, out) }

export function dirFromAzEl(a1, a2, out = [0, 0, 0]) {
  const c2 = Math.cos(a2 * D2R)
  out[0] = c2 * Math.sin(a1 * D2R); out[1] = Math.sin(a2 * D2R); out[2] = c2 * Math.cos(a1 * D2R)
  return out
}
export function dirFromXY(a1, a2, out = [0, 0, 0]) {
  const c2 = Math.cos(a2 * D2R)
  out[0] = Math.sin(a2 * D2R); out[1] = c2 * Math.sin(a1 * D2R); out[2] = c2 * Math.cos(a1 * D2R)
  return out
}
export function dirFromGimbal(type, a1, a2, out) { return type === 'xy' ? dirFromXY(a1, a2, out) : dirFromAzEl(a1, a2, out) }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null))

/**
 * 万向节参数归一：{type, a1Min, a1Max, a2Min, a2Max, rate1, rate2}（度、°/s；rate 为 null = 不限速）。
 * 接受：gimbal = {type, limits, rateDegS} 或直接平铺；limits 认 {a1Min…} / {azMin, azMax, elMin, elMax} / {xMin, xMax, yMin, yMax} /
 *   [[a1Min, a1Max], [a2Min, a2Max]]；rateDegS 认数或 {a1, a2}。缺的限位取全行程（a1 ±180、a2 ±90）；上下限写反自动对调。
 */
export function normalizeGimbal(g, rateOverride) {
  const src = g && typeof g === 'object' ? g : {}
  const type = src.type === 'xy' ? 'xy' : (src.type === 'none' ? 'none' : 'azel')
  const L = src.limits && typeof src.limits === 'object' ? src.limits : src
  let a1Min, a1Max, a2Min, a2Max
  if (Array.isArray(L) && L.length === 2 && Array.isArray(L[0]) && Array.isArray(L[1])) {
    a1Min = num(L[0][0]); a1Max = num(L[0][1]); a2Min = num(L[1][0]); a2Max = num(L[1][1])
  } else {
    const pick = (...ks) => { for (const k of ks) { const v = num(L[k]); if (v != null) return v } return null }
    a1Min = pick('a1Min', type === 'xy' ? 'xMin' : 'azMin'); a1Max = pick('a1Max', type === 'xy' ? 'xMax' : 'azMax')
    a2Min = pick('a2Min', type === 'xy' ? 'yMin' : 'elMin'); a2Max = pick('a2Max', type === 'xy' ? 'yMax' : 'elMax')
  }
  if (a1Min == null) a1Min = -180
  if (a1Max == null) a1Max = 180
  if (a2Min == null) a2Min = -90
  if (a2Max == null) a2Max = 90
  if (a1Min > a1Max) [a1Min, a1Max] = [a1Max, a1Min]
  if (a2Min > a2Max) [a2Min, a2Max] = [a2Max, a2Min]
  const r = rateOverride !== undefined && rateOverride !== null ? rateOverride : src.rateDegS
  let rate1 = null, rate2 = null
  if (r && typeof r === 'object') { rate1 = num(r.a1); rate2 = num(r.a2) } else { rate1 = num(r); rate2 = rate1 }
  if (!(rate1 > 0)) rate1 = null
  if (!(rate2 > 0)) rate2 = null
  return { type, a1Min, a1Max, a2Min, a2Max, rate1, rate2 }
}

const EPS_LIM = 1e-9
// base + 360k 里落在 [lo, hi] 内、离 ref 最近的一个；没有返回 NaN
function nearestCongruent(base, ref, lo, hi) {
  const k0 = Math.round((ref - base) / 360)
  let best = NaN, bd = Infinity
  for (let k = k0 - 2; k <= k0 + 2; k++) {
    const v = base + 360 * k
    if (v < lo - EPS_LIM || v > hi + EPS_LIM) continue
    const d = Math.abs(v - ref)
    if (d < bd) { bd = d; best = v }
  }
  return best
}

/**
 * 在限位内挑一组解（主解 / 翻转解，各带 360° 整数倍），离参考角 (ref1, ref2) 最近（|Δa1| + |Δa2|）。
 * @returns {boolean} 有解时写进 out.a1 / out.a2 并返回 true
 */
export function pickSolution(p1, p2, lim, ref1, ref2, out) {
  const r1 = Number.isFinite(ref1) ? ref1 : 0, r2 = Number.isFinite(ref2) ? ref2 : 0
  let ok = false, bc = Infinity
  for (let br = 0; br < 2; br++) {
    const b1 = br === 0 ? p1 : p1 + 180, b2 = br === 0 ? p2 : 180 - p2
    const a1 = nearestCongruent(b1, r1, lim.a1Min, lim.a1Max)
    if (!Number.isFinite(a1)) continue
    const a2 = nearestCongruent(b2, r2, lim.a2Min, lim.a2Max)
    if (!Number.isFinite(a2)) continue
    const c = Math.abs(a1 - r1) + Math.abs(a2 - r2)
    if (c < bc) { bc = c; out.a1 = a1; out.a2 = a2; ok = true }
  }
  return ok
}

function readDir(dirs, i, out) {
  if (ArrayBuffer.isView(dirs)) { out[0] = dirs[3 * i]; out[1] = dirs[3 * i + 1]; out[2] = dirs[3 * i + 2] }
  else { const d = dirs[i]; if (!d) return null; out[0] = gx(d); out[1] = gy(d); out[2] = gz(d) }
  const l = norm3(out[0], out[1], out[2])
  if (!(l > 0) || !Number.isFinite(l)) return null
  out[0] /= l; out[1] /= l; out[2] /= l
  return out
}

/**
 * 时间序列可跟踪分析。
 * @param {Array<number[]|null>|Float64Array} dirs  每拍目标方向（缺省挂点系；opts.dirFrame === 'body' 时为本体系）；
 *                                                  Float64Array 为 3N 平铺，NaN = 无目标
 * @param {number[]|Float64Array} tMs               各拍时刻（ms，单调增）
 * @param {object} limits                           mount.gimbal（{type, limits, rateDegS}）或平铺限位，见 normalizeGimbal
 * @param {number|{a1,a2}} [rateLimitDegS]          覆盖 gimbal.rateDegS
 * @param {object|function} [mask]                  本体掩模（mask.mjs）或 (dirBody) → 0/1；查表方向用本体系
 * @param {{frame?:{x,y,z}, mount?:object, dirFrame?:'mount'|'body', tolDeg?:number, fovDeg?:number}} [opts]
 *        frame：attitude.mountFrame(mount)，挂点系 ↔ 本体系（缺省按 opts.mount 现算，再没有按 D1 缺省挂点，见头注）；
 *        tolDeg：跟踪容差（缺省 0.1°）；fovDeg：固定天线（type 'none'）的全视场角（缺省取 opts.mount.fovDeg，再没有用 2·tolDeg）
 * @returns {{trackableFrac:number|null, longestOutageMin:number, peakRateDegS:number|null, peakRateA1DegS:number|null, peakRateA2DegS:number|null,
 *            fixed:boolean, frameDefaulted:boolean,
 *            counts:{ok,limit,mask,rate,noTarget}, durationsSec:{ok,limit,mask,rate,noTarget,valid},
 *            series:{a1:Float64Array, a2:Float64Array, act1:Float64Array, act2:Float64Array, rate1:Float64Array, rate2:Float64Array, errDeg:Float64Array, ok:Uint8Array, reason:Uint8Array}}}
 *   errDeg：实际指向与目标的夹角（固定天线 = 目标偏离视轴的角）
 */
export function trackSeries(dirs, tMs, limits, rateLimitDegS, mask, opts = {}) {
  const N = tMs.length
  const o = opts && typeof opts === 'object' ? opts : {}
  const lim = normalizeGimbal(limits, rateLimitDegS)
  const fixed = lim.type === 'none'
  const type = lim.type === 'xy' ? 'xy' : 'azel'
  const frameDefaulted = !isFrame(o.frame)
  const frame = frameDefaulted ? mountFrame(o.mount && typeof o.mount === 'object' ? o.mount : null) : o.frame
  const bodyIn = o.dirFrame === 'body'
  const tol = Number.isFinite(o.tolDeg) && o.tolDeg > 0 ? o.tolDeg : 0.1
  const cosTol = Math.cos(tol * D2R)
  const fovDeg = Number.isFinite(o.fovDeg) && o.fovDeg > 0 ? o.fovDeg
    : (o.mount && Number.isFinite(o.mount.fovDeg) && o.mount.fovDeg > 0 ? o.mount.fovDeg : null)
  const cosHalfFov = Math.cos(Math.min(180, fovDeg != null ? fovDeg / 2 : tol) * D2R)
  const maskFn = typeof mask === 'function' ? mask : (mask && mask.blocked ? (d) => maskLookup(mask, d) : null)

  const a1 = new Float64Array(N).fill(NaN), a2 = new Float64Array(N).fill(NaN)
  const act1 = new Float64Array(N).fill(NaN), act2 = new Float64Array(N).fill(NaN)
  const rate1 = new Float64Array(N).fill(NaN), rate2 = new Float64Array(N).fill(NaN)
  const errDeg = new Float64Array(N).fill(NaN)
  const ok = new Uint8Array(N), reason = new Uint8Array(N)
  const counts = { ok: 0, limit: 0, mask: 0, rate: 0, noTarget: 0 }
  const dur = { ok: 0, limit: 0, mask: 0, rate: 0, noTarget: 0, valid: 0 }

  const raw = [0, 0, 0], dm = [0, 0, 0], db = [0, 0, 0], da = [0, 0, 0]
  const sol = { a1: 0, a2: 0, singular: false }, pick = { a1: 0, a2: 0 }
  let hasAct = false, c1 = 0, c2 = 0                 // 执行机构实际角
  let prevCmdI = -1                                  // 上一拍有命令角的下标
  let pk1 = null, pk2 = null
  let run = 0, longest = 0

  for (let i = 0; i < N; i++) {
    const w = N === 1 ? 0 : ((i + 1 < N ? tMs[i + 1] : tMs[i]) - (i > 0 ? tMs[i - 1] : tMs[i])) / 2000   // 中点权重（s）
    const d = readDir(dirs, i, raw)
    let rs
    if (!d) {
      rs = REASON.NO_TARGET
    } else {
      // 挂点系方向（解算用）与本体系方向（查掩模用）
      if (bodyIn) { dirBodyToMount(d, frame, dm); db[0] = d[0]; db[1] = d[1]; db[2] = d[2] }
      else { dm[0] = d[0]; dm[1] = d[1]; dm[2] = d[2]; dirMountToBody(d, frame, db) }
      let solved = false
      if (fixed) {
        // 固定天线：命令 / 实际角钉在 (0, 0)，只看目标在不在视场里
        a1[i] = 0; a2[i] = 0; c1 = 0; c2 = 0; hasAct = true
        const cz = Math.max(-1, Math.min(1, dm[2]))
        errDeg[i] = Math.acos(cz) * R2D
        if (cz < cosHalfFov) rs = REASON.LIMIT
        else if (maskFn && maskFn(db)) rs = REASON.MASK
        else rs = REASON.OK
      } else {
        solveGimbal(type, dm, hasAct ? c1 : undefined, sol)
        solved = pickSolution(sol.a1, sol.a2, lim, hasAct ? c1 : 0, hasAct ? c2 : 0, pick)
        if (!solved) rs = REASON.LIMIT
      }
      if (solved) {
        a1[i] = pick.a1; a2[i] = pick.a2
        if (prevCmdI >= 0) {
          const dt = (tMs[i] - tMs[prevCmdI]) / 1000
          if (dt > 0) {
            rate1[i] = Math.abs(pick.a1 - a1[prevCmdI]) / dt; rate2[i] = Math.abs(pick.a2 - a2[prevCmdI]) / dt
            if (prevCmdI === i - 1) {                 // 只拿相邻两拍算「需要的速率」峰值（隔着限位空档的回转不算）
              if (pk1 == null || rate1[i] > pk1) pk1 = rate1[i]
              if (pk2 == null || rate2[i] > pk2) pk2 = rate2[i]
            }
          }
        }
        prevCmdI = i
        if (!hasAct) { c1 = pick.a1; c2 = pick.a2; hasAct = true }
        else {
          const dt = i > 0 ? Math.max(0, (tMs[i] - tMs[i - 1]) / 1000) : 0
          const s1 = lim.rate1 == null ? Infinity : lim.rate1 * dt, s2 = lim.rate2 == null ? Infinity : lim.rate2 * dt
          const e1 = pick.a1 - c1, e2 = pick.a2 - c2
          c1 += Math.abs(e1) <= s1 ? e1 : Math.sign(e1) * s1
          c2 += Math.abs(e2) <= s2 ? e2 : Math.sign(e2) * s2
        }
        dirFromGimbal(type, c1, c2, da)
        const cosE = Math.max(-1, Math.min(1, da[0] * dm[0] + da[1] * dm[1] + da[2] * dm[2]))
        errDeg[i] = Math.acos(cosE) * R2D
        if (maskFn && maskFn(db)) rs = REASON.MASK
        else if (cosE < cosTol) rs = REASON.RATE
        else rs = REASON.OK
      }
    }
    if (hasAct) { act1[i] = c1; act2[i] = c2 }
    reason[i] = rs
    if (rs === REASON.OK) { ok[i] = 1; counts.ok++; dur.ok += w }
    else if (rs === REASON.LIMIT) { counts.limit++; dur.limit += w }
    else if (rs === REASON.MASK) { counts.mask++; dur.mask += w }
    else if (rs === REASON.RATE) { counts.rate++; dur.rate += w }
    else { counts.noTarget++; dur.noTarget += w }
    if (rs !== REASON.NO_TARGET) dur.valid += w
    if (rs === REASON.LIMIT || rs === REASON.MASK || rs === REASON.RATE) { run += w; if (run > longest) longest = run } else run = 0
  }
  const peak = pk1 == null && pk2 == null ? null : Math.max(pk1 ?? 0, pk2 ?? 0)
  return {
    trackableFrac: dur.valid > 0 ? dur.ok / dur.valid : (counts.ok + counts.limit + counts.mask + counts.rate > 0 ? counts.ok / (N - counts.noTarget) : null),
    longestOutageMin: longest / 60,
    peakRateDegS: peak, peakRateA1DegS: pk1, peakRateA2DegS: pk2,
    fixed, frameDefaulted,
    counts, durationsSec: dur,
    series: { a1, a2, act1, act2, rate1, rate2, errDeg, ok, reason }
  }
}
