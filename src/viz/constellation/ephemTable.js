// 星历点序列取位 —— 渲染端 ESM 镜像（与 packages/core/utils/ephemInterp.js 的 evalTable 逐字一致）。
//
// ★ 为什么要有这份副本：core 那边是 CommonJS，Vite 不转换 packages/ 下的源码 CJS（renderer 既没挂
//   @rollup/plugin-commonjs 的 include，dev 下更是直接按 ESM 发），渲染端 import 不进去。平台既有
//   同类做法见 src/shared/adaptUnits.js（adaptiveUnits 的镜像）与 src/shared/carrierRate.js。
//   漂移由 packages/core/test/ephemInterp.test.mjs 逐位对拍钉死：同一张表、同一批时刻，两份输出
//   必须【按位相同】，改一处必须改另一处。
//
// ★ 本文件只做插值。解析、坐标系换算（换到 TEME）、有效性校验全在主进程：渲染端经 omm:ephemTable
//   拿到的表【已经是 TEME 采样】，故这里不需要 frames.js / timeSystems.js。

const EDGE_TOL_MS = 1000

// 上次命中的窗口下标作提示，顺序推进时 O(1)。缓存只影响快慢，不影响结果。
export function findIndex(tab, ms) {
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
export function evalTable(tab, ms) {
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

  const k = Math.min(tab.samples, hi - lo + 1)
  let b = i - ((k - 1) >> 1)
  if (b < lo) b = lo
  if (b > hi - k + 1) b = hi - k + 1
  const x0 = t[b]
  const xs = new Array(k)
  for (let j = 0; j < k; j++) xs[j] = (t[b + j] - x0) / 1000
  const xq = (q - x0) / 1000
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

// 主进程经 IPC 传回的纯数据（结构化克隆的 typed array）装成取位表。
export function tableFrom(raw) {
  if (!raw || !raw.t || !raw.p) return null
  const t = raw.t instanceof Float64Array ? raw.t : Float64Array.from(raw.t)
  const p = raw.p instanceof Float64Array ? raw.p : Float64Array.from(raw.p)
  const v = raw.v ? (raw.v instanceof Float64Array ? raw.v : Float64Array.from(raw.v)) : null
  const n = Math.min(t.length, Math.floor(p.length / 3))
  if (n < 2) return null
  const sg = raw.sg ? (raw.sg instanceof Int32Array ? raw.sg : Int32Array.from(raw.sg)) : null
  return {
    __ephem: true, n, t, p, v,
    sg,
    sgA: sg && raw.sgA ? (raw.sgA instanceof Int32Array ? raw.sgA : Int32Array.from(raw.sgA)) : null,
    sgB: sg && raw.sgB ? (raw.sgB instanceof Int32Array ? raw.sgB : Int32Array.from(raw.sgB)) : null,
    method: raw.method === 'hermite' ? 'hermite' : 'lagrange',
    samples: Math.min(Math.max(2, Math.round(Number(raw.samples) || 6)), n),
    t0: t[0], t1: t[n - 1], srcFrame: raw.srcFrame || 'TEME', _i: 0
  }
}

// 表内相邻两次升交点（z 由负转正）估计的轨道周期（分钟）；估不出返回 null。
export function estimatePeriodMin(tab) {
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

export default { EDGE_TOL_MS, findIndex, evalTable, tableFrom, estimatePeriodMin }
