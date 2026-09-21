// 时间标签位置序列（ephem）的采样表与插值取位（纯 CommonJS）。
//
// 【为什么建表时就换到 TEME】平台既有口径是「卫星位置 = TEME，经 gstime 落地」。外部星历的原帧
//   可能是 J2000 / TOD / MOD / Fixed，若留到取位时再换，(a) 每次取位都要跑 106 项章动级数，
//   15+ 处调用点 x 上万颗星 x 每帧，代价无法接受；(b) 地固帧里插值等于把地球自转也插进去。
//   故 buildTable 一次性把每个采样点换成 TEME（每点一次 gstime + 一次章动），之后取位就是纯插值。
//   原始采样（原帧、原时标）由 ephemFormats / customSats 另行保留，导出走那一份，与本表无关。
//
// 【插值】Lagrange（默认 6 点 = STK InterpolationSamplesM1 5；OEM 用 INTERPOLATION_DEGREE+1；
//   SP3 用 min(10, n)）或 Hermite（相邻两点位置 + 速度的三次样条）。窗口居中取样，端部退化为单侧。
//   精度（附录 C）：LEO 60 s 采样两法误差都 < 1 m；MEO 900 s 采样 Lagrange-10 < 0.5 m；
//   LEO 用 900 s 采样是错的（h·n > 0.3 rad），建表时给 warning。
//
// 【范围外】返回 null（不外推），两端各留 EDGE_TOL_MS 的容差 —— 采样表的首末点常常正好是
//   分析时段的端点，浮点毫秒差一点就整条取不到值。
//
// 【渲染端镜像】evalTable 在 src/viz/constellation/ephemTable.js 有一份逐字 ESM 副本（渲染端
//   吃不进 CJS，见该文件头注）。两份由 test/ephemInterp.test.mjs 逐位对拍，改一处必须改另一处。

'use strict'

const sat = require('../vendor/satellite.js')
const T = require('./timeSystems.js')
const FR = require('./frames.js')

const EDGE_TOL_MS = 1000          // 两端各 1 s 容差
const RE_KM = 6378.137
const R_MIN = RE_KM + 80          // 有效位置下界（80 km 以下即再入）
const R_MAX = 2e6                 // 上界（月球轨道外，2×10^6 km）
const DEFAULT_SAMPLES = 6

/* ===================== 建表 ===================== */
// spec: { t:Float64Array|number[]（该时标下已换算好的 UTC 毫秒）, p:Float64Array|number[]（3n，km）,
//         v:Float64Array|number[]|null（3n，km/s）, frame, interp:{method,samples} }
// 返回表对象；无有效样本返回 null。warnings 挂在表上。
function buildTable(spec) {
  const src = spec || {}
  const tIn = src.t || [], pIn = src.p || [], vIn = src.v || null
  const nIn = Math.min(tIn.length, Math.floor(pIn.length / 3))
  const frame = FR.normFrame(src.frame) || 'TEME'
  const warnings = []
  // ① 先按时间升序整理、剔除坏样本与重复时刻（严格递增）
  const order = []
  for (let i = 0; i < nIn; i++) {
    const ms = Number(tIn[i])
    const x = Number(pIn[3 * i]), y = Number(pIn[3 * i + 1]), z = Number(pIn[3 * i + 2])
    if (!Number.isFinite(ms) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    const r = Math.sqrt(x * x + y * y + z * z)
    if (!(r > R_MIN && r < R_MAX)) continue
    order.push(i)
  }
  order.sort((a, b) => Number(tIn[a]) - Number(tIn[b]))
  const keep = []
  for (let k = 0; k < order.length; k++) {
    if (keep.length && Number(tIn[order[k]]) <= Number(tIn[keep[keep.length - 1]])) continue  // 严格递增
    keep.push(order[k])
  }
  const dropped = nIn - keep.length
  if (dropped > 0) warnings.push(dropped + ' 个采样点无效或时刻重复，已剔除')
  const n = keep.length
  if (n < 2) return null

  // ② 逐点换到 TEME
  const t = new Float64Array(n), p = new Float64Array(3 * n)
  const hasV = !!(vIn && vIn.length >= 3 * nIn)
  const v = hasV ? new Float64Array(3 * n) : null
  for (let k = 0; k < n; k++) {
    const i = keep[k]
    const ms = Number(tIn[i])
    t[k] = ms
    const pos = { x: Number(pIn[3 * i]), y: Number(pIn[3 * i + 1]), z: Number(pIn[3 * i + 2]) }
    let posT = pos, velT = null
    if (frame !== 'TEME') {
      const cT = T.julianCenturiesTT(ms)
      const gmst = sat.gstime(T.jdFromMs(ms))
      const nu = frame === 'FIXED' ? null : FR.nutationAngles(cT)
      posT = FR.toTeme(pos, frame, cT, gmst, nu)
      if (hasV) {
        const vel = { x: Number(vIn[3 * i]), y: Number(vIn[3 * i + 1]), z: Number(vIn[3 * i + 2]) }
        velT = FR.velToTeme(vel, pos, frame, cT, gmst, nu)
      }
    } else if (hasV) {
      velT = { x: Number(vIn[3 * i]), y: Number(vIn[3 * i + 1]), z: Number(vIn[3 * i + 2]) }
    }
    p[3 * k] = posT.x; p[3 * k + 1] = posT.y; p[3 * k + 2] = posT.z
    if (v) {
      const ok = velT && Number.isFinite(velT.x) && Number.isFinite(velT.y) && Number.isFinite(velT.z)
      v[3 * k] = ok ? velT.x : 0; v[3 * k + 1] = ok ? velT.y : 0; v[3 * k + 2] = ok ? velT.z : 0
    }
  }

  // ②b 分段（OEM 多段）：段间不插值，落在缝里取位返 null，Lagrange 窗口也不跨段。
  //     单段（绝大多数文件）不建这三张表，取位走无分支的快路。
  let sg = null, sgA = null, sgB = null
  const spans = Array.isArray(src.spans) && src.spans.length > 1 ? src.spans : null
  if (spans) {
    sg = new Int32Array(n)
    let cur = 0
    for (let k = 0; k < n; k++) {
      while (cur < spans.length - 1 && t[k] > spans[cur][1]) cur++
      sg[k] = cur
    }
    const m = sg[n - 1] + 1
    sgA = new Int32Array(m).fill(-1); sgB = new Int32Array(m).fill(-1)
    for (let k = 0; k < n; k++) { const s = sg[k]; if (sgA[s] < 0) sgA[s] = k; sgB[s] = k }
    // 段内只剩 1 点的：并进前一段（1 点插不出值，留着只会在缝里制造假 null）
    for (let s = 0; s < m; s++) if (sgA[s] >= 0 && sgA[s] === sgB[s] && s > 0) { sgB[s - 1] = sgB[s]; for (let k = sgA[s]; k <= sgB[s]; k++) sg[k] = s - 1; sgA[s] = -1 }
  }

  // ③ 插值口径
  const ip = src.interp || {}
  let method = String(ip.method || 'lagrange').toLowerCase() === 'hermite' ? 'hermite' : 'lagrange'
  if (method === 'hermite' && !v) { method = 'lagrange'; warnings.push('无速度样本，Hermite 退回 Lagrange') }
  let samples = Math.round(Number(ip.samples) || DEFAULT_SAMPLES)
  if (!(samples >= 2)) samples = DEFAULT_SAMPLES
  samples = Math.min(samples, n)

  // ④ 采样步长与轨道角速度的合理性（附录 C：h·n > 0.3 rad 即插值不可信）
  const stepMs = n > 1 ? (t[n - 1] - t[0]) / (n - 1) : 0
  const rMid = Math.hypot(p[3 * (n >> 1)], p[3 * (n >> 1) + 1], p[3 * (n >> 1) + 2])
  const nRad = Math.sqrt(398600.4418 / (rMid * rMid * rMid))
  if (stepMs > 0 && (stepMs / 1000) * nRad > 0.3) {
    warnings.push('采样步长 ' + Math.round(stepMs / 1000) + ' s 相对该轨道过粗（单步转过 ' +
      ((stepMs / 1000) * nRad * 180 / Math.PI).toFixed(0) + '°），插值精度不可信')
  }

  return {
    __ephem: true, n, t, p, v, method, samples, sg, sgA, sgB,
    t0: t[0], t1: t[n - 1], stepMs, srcFrame: frame, warnings, _i: 0
  }
}

/* ===================== 取位 ===================== */
// 上次命中的窗口下标作提示，顺序推进时 O(1)。缓存只影响快慢，不影响结果。
function findIndex(tab, ms) {
  const t = tab.t, n = tab.n
  let i = tab._i | 0
  if (i < 0 || i > n - 2) i = 0
  if (ms >= t[i] && ms <= t[i + 1]) return i
  if (ms >= t[i + 1] && i + 2 <= n - 1 && ms <= t[i + 2]) { tab._i = i + 1; return i + 1 }
  let lo = 0, hi = n - 2
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= ms) lo = mid; else hi = mid - 1 }
  tab._i = lo
  return lo
}

// 表 + UTC 毫秒 -> TEME {x,y,z,vx,vy,vz}（km / km·s⁻¹）；范围外 null。
// ★ 与 src/viz/constellation/ephemTable.js 的 evalTable 逐字一致。
function evalTable(tab, ms) {
  if (!tab || !(tab.n >= 2)) return null
  const t = tab.t, p = tab.p, v = tab.v, n = tab.n
  if (!(ms >= t[0] - EDGE_TOL_MS) || !(ms <= t[n - 1] + EDGE_TOL_MS)) return null
  let q = ms < t[0] ? t[0] : (ms > t[n - 1] ? t[n - 1] : ms)
  let i = findIndex(tab, q)
  // 分段星历：落在段与段之间的缝里 -> null；窗口也不跨段
  let lo = 0, hi = n - 1
  if (tab.sg) {
    const s = tab.sg[i]
    lo = tab.sgA[s]; hi = tab.sgB[s]
    if (!(ms >= t[lo] - EDGE_TOL_MS) || !(ms <= t[hi] + EDGE_TOL_MS)) return null
    if (q < t[lo]) q = t[lo]
    if (q > t[hi]) q = t[hi]
  }
  if (i < lo) i = lo
  if (i > hi - 1) i = hi - 1 < lo ? lo : hi - 1

  if (tab.method === 'hermite' && v) {
    // 相邻两点位置 + 速度的三次 Hermite
    const h = (t[i + 1] - t[i]) / 1000
    if (!(h > 0)) return { x: p[3 * i], y: p[3 * i + 1], z: p[3 * i + 2], vx: v[3 * i], vy: v[3 * i + 1], vz: v[3 * i + 2] }
    const s = (q - t[i]) / 1000 / h, s2 = s * s, s3 = s2 * s
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2
    const d00 = 6 * s2 - 6 * s, d10 = 3 * s2 - 4 * s + 1, d01 = -6 * s2 + 6 * s, d11 = 3 * s2 - 2 * s
    const out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }
    const kx = ['x', 'y', 'z'], kv = ['vx', 'vy', 'vz']
    for (let c = 0; c < 3; c++) {
      const p0 = p[3 * i + c], p1 = p[3 * (i + 1) + c], m0 = v[3 * i + c] * h, m1 = v[3 * (i + 1) + c] * h
      out[kx[c]] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
      out[kv[c]] = (d00 * p0 + d10 * m0 + d01 * p1 + d11 * m1) / h
    }
    return out
  }

  // Lagrange：窗口居中，端部（与段端）退化为单侧
  const k = Math.min(tab.samples, hi - lo + 1)
  let b = i - ((k - 1) >> 1)
  if (b < lo) b = lo
  if (b > hi - k + 1) b = hi - k + 1
  const x0 = t[b]
  const xs = new Array(k)
  for (let j = 0; j < k; j++) xs[j] = (t[b + j] - x0) / 1000
  const xq = (q - x0) / 1000
  // 基函数（重心式的朴素形式，k <= 10 时数值足够稳）
  const L = new Array(k)
  for (let j = 0; j < k; j++) {
    let num = 1, den = 1
    for (let m = 0; m < k; m++) { if (m === j) continue; num *= (xq - xs[m]); den *= (xs[j] - xs[m]) }
    L[j] = num / den
  }
  const out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }
  const kx = ['x', 'y', 'z'], kv = ['vx', 'vy', 'vz']
  for (let c = 0; c < 3; c++) {
    let sp = 0, sv = 0
    for (let j = 0; j < k; j++) { sp += L[j] * p[3 * (b + j) + c]; if (v) sv += L[j] * v[3 * (b + j) + c] }
    out[kx[c]] = sp
    out[kv[c]] = sv
  }
  if (!v) {
    // 无速度样本：对位置多项式作中心差分（步长取窗口跨度的千分之一，双精度下截断/舍入都可忽略）
    const dt = Math.max(1e-3, (xs[k - 1] - xs[0]) / 1000)
    const at = (u) => {
      const LL = new Array(k)
      for (let j = 0; j < k; j++) {
        let num = 1, den = 1
        for (let m = 0; m < k; m++) { if (m === j) continue; num *= (u - xs[m]); den *= (xs[j] - xs[m]) }
        LL[j] = num / den
      }
      const r = [0, 0, 0]
      for (let c = 0; c < 3; c++) for (let j = 0; j < k; j++) r[c] += LL[j] * p[3 * (b + j) + c]
      return r
    }
    const a = at(xq - dt), c2 = at(xq + dt)
    out.vx = (c2[0] - a[0]) / (2 * dt); out.vy = (c2[1] - a[1]) / (2 * dt); out.vz = (c2[2] - a[2]) / (2 * dt)
  }
  return out
}

// 对外名：与任务书一致
const positionAt = (tab, ms) => evalTable(tab, ms)

// 表内相邻两次升交点（z 由负转正）估计的轨道周期（分钟）；估不出返回 null。
function estimatePeriodMin(tab) {
  if (!tab || !(tab.n >= 3)) return null
  const t = tab.t, p = tab.p
  const cross = []
  for (let i = 1; i < tab.n; i++) {
    const z0 = p[3 * (i - 1) + 2], z1 = p[3 * i + 2]
    if (z0 < 0 && z1 >= 0) {
      const f = z1 === z0 ? 0 : -z0 / (z1 - z0)
      cross.push(t[i - 1] + f * (t[i] - t[i - 1]))
      if (cross.length >= 2) break
    }
  }
  if (cross.length < 2) return null
  return (cross[1] - cross[0]) / 60000
}

module.exports = { EDGE_TOL_MS, DEFAULT_SAMPLES, buildTable, evalTable, positionAt, findIndex, estimatePeriodMin }
