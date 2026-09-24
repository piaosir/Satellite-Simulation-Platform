// 分析页（DESIGN2 §3「分析」、任务书 §6.4 / §6.5 / §6.7 / §6.8）的纯计算：时间网格、逐拍星位 / 姿态 / 挂点轴、视线、
// 可跟踪序列、功率序列、星侧太阳侵入的采样包、区段（灰带 / 状态条）。无 three / vue / DOM —— node 单测直接 import
// （packages/core/test/modelWbAnalysis.test.mjs）。
//
// 口径（都在 packages/core/models 里定义过，这里只拼）：
//   · 星位：调用方给 stateAt(tMs) → {rEcef km, vEcef km/s（惯性速度的 ECEF 分量，不减 ω×r；没有就 null）, gmstRad}；
//     渲染端取位的唯一入口是 src/viz/constellation/satPos.js 的 posAt（satOrbit.js 包一层），这里不碰 SGP4。
//   · 姿态：attitude.attitudeBasisEcef（五律；太阳 = sunEcefApprox，与画面晨昏线同源 D12）；偏航律奇点靠 prevYawDeg 连续。
//   · 挂点系：attitude.mountFrame（z = 视轴、y = up 投影、x = y × z，D1），ECEF 下 = 本体三轴按分量组合。
//   · 视线遮挡：地球站按站心仰角 ≥ elMinDeg（WGS-84 大地法向）；星间按线段到地心的最近距离 ≥ 地球半径 + grazeKm。
//   · 万向节：gimbal.trackSeries（方向用本体系 dirFrame:'body'，掩模查表也用本体系）。
//   · 功率：power.sunGeometrySeries（同一套姿态律）+ arrayPowerSeries；地影 = attitude.eclipseFactor（D13 唯一实现）。
//   · 星侧太阳侵入：主进程 sunOutage.satIntrusion 吃 Float64Array[N×10]（t, 星 ECEF xyz km, 视轴 ECEF xyz, up ECEF xyz）。
// 重活都分块做（chunked：每 ~12 ms 让一次主线程），带 AbortSignal 与进度回调——一天 1 min 步长 1441 拍只要几毫秒，
// 但用户可以把时段拉到几十天、步长缩到 1 s（几百万拍），界面不能卡。整段同步的（功率、万向节）收在 HEAVY 表里，
// 页面经 anaHeavy.js 丢进 Worker（anaHeavy.worker.js）跑；Worker 起不来时同一张表在主线程跑，结果逐位一致。
// ★ 引 packages/core 走相对路径（单测是裸 node）。
import { attitudeBasisEcef, makeBasis, sunEcefApprox, mountFrame, eclipseFactor, sunDistanceAu, AU_KM } from '../../packages/core/models/attitude.mjs'
import { trackSeries, REASON } from '../../packages/core/models/gimbal.mjs'
import { arrayPowerSeries } from '../../packages/core/models/power.mjs'
import { maskLookup } from '../../packages/core/models/mask.mjs'
import { geodeticToEcef, A as RE_EQ } from '../viz/wgs84.js'

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
export const MAX_SAMPLES = 2000000

// ───────────────────────────── 分块执行 ─────────────────────────────

export function abortErr() { const e = new Error('已取消'); e.name = 'AbortError'; return e }
const yieldUi = () => new Promise((r) => setTimeout(r, 0))
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
/**
 * for (i = 0; i < N; i++) fn(i)，每 budgetMs 让一次主线程；signal 取消时抛 AbortError；onProgress(done, N) 每次让出前调。
 */
export async function chunked(N, fn, o = {}) {
  const budget = o.budgetMs || 12
  let t0 = now()
  for (let i = 0; i < N; i++) {
    fn(i)
    if ((i & 63) === 63 && now() - t0 > budget) {
      if (o.onProgress) o.onProgress(i + 1, N)
      await yieldUi()
      if (o.signal && o.signal.aborted) throw abortErr()
      t0 = now()
    }
  }
  if (o.onProgress) o.onProgress(N, N)
}

// ───────────────────────────── 时间网格 ─────────────────────────────

/**
 * [t0, t1] 按 stepS 秒取样（含两端；末拍不齐步长时补上 t1）。样本数超 maxN 返回 null（调用方提示改步长）。
 * @returns {Float64Array|null}
 */
export function timeGrid(t0, t1, stepS, maxN = MAX_SAMPLES) {
  const N = gridCount(t0, t1, stepS)
  if (!N || N > maxN) return null
  const st = stepS * 1000
  const n = Math.floor((t1 - t0) / st + 1e-9) + 1
  const out = new Float64Array(N)
  for (let i = 0; i < n; i++) out[i] = t0 + i * st
  if (N > n) out[N - 1] = t1
  return out
}
/** timeGrid 会给出的样本数（纯算术、不分配数组；入参非法返回 0）—— 界面上的样本数读数用它，时长 / 步长拉到几亿拍也不卡 */
export function gridCount(t0, t1, stepS) {
  if (!isNum(t0) || !isNum(t1) || !(t1 > t0) || !isNum(stepS) || !(stepS > 0)) return 0
  const st = stepS * 1000
  const n = Math.floor((t1 - t0) / st + 1e-9) + 1
  const last = t0 + (n - 1) * st
  return n + (t1 - last > 1e-3 ? 1 : 0)
}

// ───────────────────────────── 星位 / 姿态 / 挂点轴 ─────────────────────────────

/**
 * 逐拍星位（ECEF）。stateAt(tMs) → {rEcef, vEcef|null, gmstRad} | null。
 * @returns {Promise<{r:Float64Array, v:Float64Array, hasV:Uint8Array, ok:Uint8Array, gmst:Float64Array, nOk:number}>}
 */
export async function sampleStates(stateAt, tMs, o = {}) {
  const N = tMs.length
  const r = new Float64Array(3 * N).fill(NaN), v = new Float64Array(3 * N).fill(NaN), gmst = new Float64Array(N).fill(NaN)
  const hasV = new Uint8Array(N), ok = new Uint8Array(N)
  let nOk = 0
  await chunked(N, (i) => {
    let s = null
    try { s = stateAt(tMs[i]) } catch { s = null }
    if (!s || !s.rEcef || !isNum(s.rEcef[0])) return
    r[3 * i] = s.rEcef[0]; r[3 * i + 1] = s.rEcef[1]; r[3 * i + 2] = s.rEcef[2]
    if (s.vEcef && isNum(s.vEcef[0])) { v[3 * i] = s.vEcef[0]; v[3 * i + 1] = s.vEcef[1]; v[3 * i + 2] = s.vEcef[2]; hasV[i] = 1 }
    gmst[i] = isNum(s.gmstRad) ? s.gmstRad : NaN
    ok[i] = 1; nOk++
  }, o)
  return { r, v, hasV, ok, gmst, nOk }
}

/**
 * 逐拍本体三轴（标准 ECEF 单位矢量）+ 太阳方向（ECEF）。
 * @param {{law:string, params:object}} att
 * @param {object} st sampleStates 的结果
 * @param {Float64Array} tMs
 * @param {{targetAt?:(i:number, tMs:number)=>number[]|null, signal?, onProgress?}} [o] target 律的目标（ECEF km）
 * @returns {Promise<{X:Float64Array, Y:Float64Array, Z:Float64Array, sun:Float64Array, yaw:Float64Array, fallback:Uint8Array, ok:Uint8Array}>}
 */
export async function attitudeSeries(att, st, tMs, o = {}) {
  const N = tMs.length
  const X = new Float64Array(3 * N).fill(NaN), Y = new Float64Array(3 * N).fill(NaN), Z = new Float64Array(3 * N).fill(NaN)
  const sun = new Float64Array(3 * N), yaw = new Float64Array(N).fill(NaN), fallback = new Uint8Array(N), ok = new Uint8Array(N)
  const law = att && att.law ? att.law : 'nadir', params = (att && att.params) || {}
  const rr = [0, 0, 0], vv = [0, 0, 0], ss = [0, 0, 0], tg = [0, 0, 0]
  const ctx = { rEcef: rr, vInertialEcef: null, sunEcef: ss, targetEcef: null, gmstRad: NaN, tMs: 0, prevYawDeg: 0 }
  const b = makeBasis()
  let prevYaw = 0
  await chunked(N, (i) => {
    sunEcefApprox(tMs[i], ss)
    sun[3 * i] = ss[0]; sun[3 * i + 1] = ss[1]; sun[3 * i + 2] = ss[2]
    if (!st.ok[i]) return
    rr[0] = st.r[3 * i]; rr[1] = st.r[3 * i + 1]; rr[2] = st.r[3 * i + 2]
    if (st.hasV[i]) { vv[0] = st.v[3 * i]; vv[1] = st.v[3 * i + 1]; vv[2] = st.v[3 * i + 2]; ctx.vInertialEcef = vv } else ctx.vInertialEcef = null
    ctx.gmstRad = st.gmst[i]; ctx.tMs = tMs[i]; ctx.prevYawDeg = prevYaw
    if (law === 'target' && o.targetAt) { const p = o.targetAt(i, tMs[i]); if (p && isNum(p[0])) { tg[0] = p[0]; tg[1] = p[1]; tg[2] = p[2]; ctx.targetEcef = tg } else ctx.targetEcef = null } else ctx.targetEcef = null
    const r = attitudeBasisEcef(law, params, ctx, b)
    if (!r) return
    for (let k = 0; k < 3; k++) { X[3 * i + k] = r.X[k]; Y[3 * i + k] = r.Y[k]; Z[3 * i + k] = r.Z[k] }
    yaw[i] = r.yawDeg; fallback[i] = r.fallback ? 1 : 0; ok[i] = 1
    if (isNum(r.yawDeg)) prevYaw = r.yawDeg
  }, o)
  return { X, Y, Z, sun, yaw, fallback, ok }
}

/** 本体系方向 → ECEF（第 i 拍的本体三轴）；写进 out[3·j] */
function bodyToEcefAt(B, i, d, out, j) {
  const x = d[0], y = d[1], z = d[2], k = 3 * i
  out[3 * j] = B.X[k] * x + B.Y[k] * y + B.Z[k] * z
  out[3 * j + 1] = B.X[k + 1] * x + B.Y[k + 1] * y + B.Z[k + 1] * z
  out[3 * j + 2] = B.X[k + 2] * x + B.Y[k + 2] * y + B.Z[k + 2] * z
}
/** ECEF 方向 → 本体系（第 i 拍）；写进 out[3·j] */
function ecefToBodyAt(B, i, e0, e1, e2, out, j) {
  const k = 3 * i
  out[3 * j] = B.X[k] * e0 + B.X[k + 1] * e1 + B.X[k + 2] * e2
  out[3 * j + 1] = B.Y[k] * e0 + B.Y[k + 1] * e1 + B.Y[k + 2] * e2
  out[3 * j + 2] = B.Z[k] * e0 + B.Z[k + 1] * e1 + B.Z[k + 2] * e2
}

/**
 * 挂点三轴在 ECEF 下的逐拍序列（z = 视轴、y = up 投影、x = y × z）。本体姿态缺拍的记 NaN。
 * @returns {{x:Float64Array, y:Float64Array, z:Float64Array, frame:{x,y,z}}}
 */
export function mountAxesSeries(B, mount) {
  const N = B.ok.length
  const f = mountFrame(mount)
  const x = new Float64Array(3 * N).fill(NaN), y = new Float64Array(3 * N).fill(NaN), z = new Float64Array(3 * N).fill(NaN)
  for (let i = 0; i < N; i++) {
    if (!B.ok[i]) continue
    bodyToEcefAt(B, i, f.x, x, i); bodyToEcefAt(B, i, f.y, y, i); bodyToEcefAt(B, i, f.z, z, i)
  }
  return { x, y, z, frame: f }
}

// ───────────────────────────── 目标与视线 ─────────────────────────────

/**
 * 地球站目标：{kind:'station', latDeg, lonDeg, altM?, elMinDeg?} → ECEF 位置 + 大地法向（站心仰角用）
 */
export function stationTarget(t) {
  const lat = Number(t.latDeg), lon = Number(t.lonDeg), h = (Number(t.altM) || 0) / 1000
  const p = geodeticToEcef(lon, lat, h)
  const cl = Math.cos(lat * D2R)
  return { kind: 'station', p, n: [cl * Math.cos(lon * D2R), cl * Math.sin(lon * D2R), Math.sin(lat * D2R)], elMinDeg: isNum(t.elMinDeg) ? t.elMinDeg : 0 }
}

/**
 * 逐拍视线（星 → 目标，ECEF 单位矢量）与可见标志。目标：stationTarget(...) 或 {kind:'sat', r:Float64Array 3N, ok:Uint8Array}（另一颗星同一时间网格的位置）。
 *   地球站：站心仰角 < elMinDeg（地平以下）记不可见；星间：线段到地心最近距离 < 地球半径 + grazeKm 记不可见。
 * @returns {{los:Float64Array, vis:Uint8Array, rangeKm:Float64Array, elDeg:Float64Array|null}}
 */
export function losSeries(st, target, o = {}) {
  const N = st.ok.length
  const los = new Float64Array(3 * N).fill(NaN), vis = new Uint8Array(N), rangeKm = new Float64Array(N).fill(NaN)
  const elDeg = target && target.kind === 'station' ? new Float64Array(N).fill(NaN) : null
  const graze = RE_EQ + (isNum(o.grazeKm) ? o.grazeKm : 0)
  for (let i = 0; i < N; i++) {
    if (!st.ok[i]) continue
    const sx = st.r[3 * i], sy = st.r[3 * i + 1], sz = st.r[3 * i + 2]
    let tx, ty, tz
    if (target.kind === 'station') { tx = target.p[0]; ty = target.p[1]; tz = target.p[2] } else {
      if (!target.ok[i]) continue
      tx = target.r[3 * i]; ty = target.r[3 * i + 1]; tz = target.r[3 * i + 2]
    }
    const dx = tx - sx, dy = ty - sy, dz = tz - sz, L = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!(L > 0)) continue
    los[3 * i] = dx / L; los[3 * i + 1] = dy / L; los[3 * i + 2] = dz / L
    rangeKm[i] = L
    if (target.kind === 'station') {
      // 站心仰角：站 → 星方向与大地法向的夹角余角
      const e = Math.asin(Math.max(-1, Math.min(1, -(dx * target.n[0] + dy * target.n[1] + dz * target.n[2]) / L))) * R2D
      elDeg[i] = e
      vis[i] = e >= target.elMinDeg ? 1 : 0
    } else {
      // 线段 S→T 上离地心最近的点：参数 u = −(S·d)/|d|²，夹到 [0, 1]
      const u = Math.max(0, Math.min(1, -(sx * dx + sy * dy + sz * dz) / (L * L)))
      const px = sx + u * dx, py = sy + u * dy, pz = sz + u * dz
      vis[i] = Math.sqrt(px * px + py * py + pz * pz) >= graze ? 1 : 0
    }
  }
  return { los, vis, rangeKm, elDeg }
}

/** ECEF 方向序列 → 本体系序列（不可见 / 缺拍记 NaN） */
export function toBodySeries(vecs, B, mask) {
  const N = B.ok.length
  const out = new Float64Array(3 * N).fill(NaN)
  for (let i = 0; i < N; i++) {
    if (!B.ok[i] || (mask && !mask[i]) || !isNum(vecs[3 * i])) continue
    ecefToBodyAt(B, i, vecs[3 * i], vecs[3 * i + 1], vecs[3 * i + 2], out, i)
  }
  return out
}

// ───────────────────────────── 万向节 ─────────────────────────────

/**
 * 万向节可达：目标视线（本体系）→ gimbal.trackSeries。掩模（可选）按本体系查（遮挡的拍记 mask）。
 * @returns trackSeries 的结果 + {nTarget, tMs}
 */
export function gimbalTrack(tMs, dirsBody, mount, mask, o = {}) {
  const res = trackSeries(dirsBody, tMs, mount.gimbal || { type: 'none' }, o.rateDegS, mask || null, {
    frame: mountFrame(mount), mount, dirFrame: 'body', tolDeg: o.tolDeg, fovDeg: o.fovDeg
  })
  let nTarget = 0
  for (let i = 0; i < tMs.length; i++) if (res.series.reason[i] !== REASON.NO_TARGET) nTarget++
  return { ...res, nTarget }
}

// ───────────────────────────── 功率 ─────────────────────────────

/**
 * 逐拍：太阳在本体系的方向 + 地影因子 + 日地距离（与 power.sunGeometrySeries 同式，但复用已算好的姿态序列，不重解一遍姿态律）。
 */
export function sunBodySeries(st, B, tMs) {
  const N = tMs.length
  const sunBody = new Float64Array(3 * N).fill(NaN), eclipse = new Float64Array(N).fill(NaN), auDist = new Float64Array(N).fill(1)
  const rr = [0, 0, 0], ss = [0, 0, 0], eo = { sunDistKm: 0 }
  for (let i = 0; i < N; i++) {
    const au = sunDistanceAu(tMs[i])
    auDist[i] = au
    if (!B.ok[i]) continue
    ss[0] = B.sun[3 * i]; ss[1] = B.sun[3 * i + 1]; ss[2] = B.sun[3 * i + 2]
    ecefToBodyAt(B, i, ss[0], ss[1], ss[2], sunBody, i)
    rr[0] = st.r[3 * i]; rr[1] = st.r[3 * i + 1]; rr[2] = st.r[3 * i + 2]
    eo.sunDistKm = au * AU_KM
    eclipse[i] = eclipseFactor(rr, ss, eo)
  }
  return { sunBody, eclipse, auDist }
}
/** 功率序列（arrayPowerSeries；缺拍的太阳方向 NaN → 该拍 0 W、不计入受照） */
export function powerSeries(panels, tMs, sb) {
  const N = tMs.length
  const sunBody = new Float64Array(3 * N), eclipse = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const ok = isNum(sb.sunBody[3 * i])
    sunBody[3 * i] = ok ? sb.sunBody[3 * i] : 0; sunBody[3 * i + 1] = ok ? sb.sunBody[3 * i + 1] : 0; sunBody[3 * i + 2] = ok ? sb.sunBody[3 * i + 2] : 0
    eclipse[i] = ok && isNum(sb.eclipse[i]) ? sb.eclipse[i] : 0
  }
  return arrayPowerSeries({ panels, tMs, sunBody, eclipse, auDist: sb.auDist })
}

// ───────────────────────────── 星侧太阳侵入 ─────────────────────────────

/**
 * 主进程 sunOutage.satIntrusion 的采样包：Float64Array[N×10]（t, 星 ECEF xyz km, 视轴 ECEF xyz, up ECEF xyz）。
 * 缺拍（星位 / 姿态解不出）的不进包；返回 {samples, idx}（idx[k] = 第 k 个样本对应的网格下标）。
 */
export function intrusionSamples(tMs, st, axes) {
  const N = tMs.length
  let n = 0
  for (let i = 0; i < N; i++) if (st.ok[i] && isNum(axes.z[3 * i])) n++
  const samples = new Float64Array(n * 10), idx = new Int32Array(n)
  let k = 0
  for (let i = 0; i < N; i++) {
    if (!st.ok[i] || !isNum(axes.z[3 * i])) continue
    const o = k * 10
    samples[o] = tMs[i]
    samples[o + 1] = st.r[3 * i]; samples[o + 2] = st.r[3 * i + 1]; samples[o + 3] = st.r[3 * i + 2]
    samples[o + 4] = axes.z[3 * i]; samples[o + 5] = axes.z[3 * i + 1]; samples[o + 6] = axes.z[3 * i + 2]
    samples[o + 7] = axes.y[3 * i]; samples[o + 8] = axes.y[3 * i + 1]; samples[o + 9] = axes.y[3 * i + 2]
    idx[k++] = i
  }
  return { samples, idx }
}
/** 太阳偏离视轴的角度（°，逐拍；地心太阳方向，只作读数） */
export function sunOffAxisSeries(B, axes) {
  const N = B.ok.length
  const out = new Float64Array(N).fill(NaN)
  for (let i = 0; i < N; i++) {
    if (!isNum(axes.z[3 * i])) continue
    const c = axes.z[3 * i] * B.sun[3 * i] + axes.z[3 * i + 1] * B.sun[3 * i + 1] + axes.z[3 * i + 2] * B.sun[3 * i + 2]
    out[i] = Math.acos(Math.max(-1, Math.min(1, c))) * R2D
  }
  return out
}

// ───────────────────────────── 区段（灰带 / 状态条）与读数 ─────────────────────────────

/**
 * 逐拍布尔 → 连续区段 [{t0, t1}]（按中点切：第 i 拍代表 [t_{i−½}, t_{i+½}]，与 gimbal.trackSeries 的时长口径一致）
 */
export function segmentsOf(tMs, pred) {
  const N = tMs.length, out = []
  let s = -1
  const lo = (i) => (i > 0 ? (tMs[i - 1] + tMs[i]) / 2 : tMs[0])
  const hi = (i) => (i + 1 < N ? (tMs[i] + tMs[i + 1]) / 2 : tMs[N - 1])
  for (let i = 0; i < N; i++) {
    const p = !!pred(i)
    if (p && s < 0) s = i
    if ((!p || i === N - 1) && s >= 0) { const e = p ? i : i - 1; out.push({ t0: lo(s), t1: hi(e) }); s = -1 }
  }
  return out
}
/** 最长连续区段时长（分钟） */
export function longestMin(segs) { let m = 0; for (const s of segs) m = Math.max(m, s.t1 - s.t0); return m / 60000 }

/** 万向节状态条：可跟踪（实底 ok）/ 超限（斜纹 bad）/ 遮挡（实底 bad）/ 追不上（斜纹 bad）；无目标不画 */
export function gimbalStrip(tMs, reason) {
  const segs = []
  const kinds = [[REASON.OK, 'ok'], [REASON.LIMIT, 'badHatch'], [REASON.MASK, 'bad'], [REASON.RATE, 'badHatch']]
  for (const [r, style] of kinds) for (const s of segmentsOf(tMs, (i) => reason[i] === r)) segs.push({ ...s, style })
  return segs.sort((a, b) => a.t0 - b.t0)
}

/** 数组的有限值统计 {min, max, mean(按时间梯形), argmax} */
export function seriesStats(tMs, y) {
  let mn = Infinity, mx = -Infinity, am = -1, acc = 0, dur = 0
  for (let i = 0; i < y.length; i++) {
    const v = y[i]
    if (!isNum(v)) continue
    if (v < mn) mn = v
    if (v > mx) { mx = v; am = i }
    if (i > 0 && isNum(y[i - 1])) { const dt = tMs[i] - tMs[i - 1]; acc += (v + y[i - 1]) / 2 * dt; dur += dt }
  }
  return { min: mn === Infinity ? null : mn, max: mx === -Infinity ? null : mx, argmax: am, mean: dur > 0 ? acc / dur : (am >= 0 ? mx : null) }
}

/** 掩模查表函数（本体系方向）：没有掩模返回 null（trackSeries 按不查） */
export function maskFn(mask) { return mask && mask.blocked ? (d) => maskLookup(mask, d) : null }

// ───────────────────────────── 整段同步的重活（Worker 与主线程回退共用这一张表） ─────────────────────────────
// 入参只放要用的数组（过 postMessage 要结构化克隆，不整份搬姿态序列）；出参全是数字与 TypedArray。
export const HEAVY = Object.freeze({
  /** 功率：{panels, tMs, st:{r, ok}, B:{X, Y, Z, sun, ok}} → {p: powerSeries 结果, eclipse} */
  power({ panels, tMs, st, B }) {
    const sb = sunBodySeries(st, B, tMs)
    return { p: powerSeries(panels, tMs, sb), eclipse: sb.eclipse }
  },
  /**
   * 万向节：{tMs, st:{r, ok}, B:{X, Y, Z, ok}, target, mount, mask|null, tolDeg, fovDeg?} → {ls, tr}
   * fovDeg：固定天线的视场全锥角（mountLogic.fovFullOf：挂点视场 → 方向图 −3 dB 全宽 → 全向 360°）；不给则 trackSeries 退回 mount.fovDeg / 容差
   */
  gimbal({ tMs, st, B, target, mount, mask, tolDeg, fovDeg }) {
    const ls = losSeries(st, target)
    const dirs = toBodySeries(ls.los, B, ls.vis)
    return { ls, tr: gimbalTrack(tMs, dirs, mount, maskFn(mask), { tolDeg, fovDeg: isNum(fovDeg) && fovDeg > 0 ? fovDeg : undefined }) }
  }
})
