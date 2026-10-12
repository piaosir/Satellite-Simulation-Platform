// 时间标签状态序列的整理与运动学体检（纯 CommonJS）。
//
// 外部星历的数据行进门后，在建插值表之前统一过这一道：
//   ① 时间不单调 → 稳定排序（记告警）；
//   ② 同一时刻多行：状态相同 = 弧段边界的重复打印（中国卫通 .eph 在机动结束处就这样写）；状态不同 = 脉冲式
//      间断（机动前 / 机动后两个状态）。后者必须拆段——插值跨过一个速度跳变，整段窗口都会被抹平；
//   ③ 数据缺口：按「跨缺口插值的误差估计」决定桥接还是拆段（见 bridgeErrKm），不按固定步数拍脑袋；
//   ④ 显式段界（STK SegmentBoundaryTimes）照拆。
// 拆段沿用 ephemInterp 既有的 spans 机制：段与段之间不插值、Lagrange 窗口不跨段。
// 同一时刻要并存两个状态时，后一个顺延 NUDGE_MS（1 ms）——spans 要求时刻严格递增；1 ms 对任何轨道都是亚米级。
//
// 运动学体检（kinematicFrame / velocityScale）给解析器用：帧名缺失 / 写错、速度单位与位置单位不配套时，
// 用数据自己的动力学特征判断，而不是猜。

'use strict'

const MU = 398600.4418            // km³/s²
const RE = 6378.137               // km
const J2 = 1.08262668e-3
const W_E = 7.2921158553e-5       // rad/s（与 frames.js 的 OMEGA_E 同值）
const NUDGE_MS = 1
// 桥接误差上限：带速度（三次 Hermite）1 km；只有位置（Lagrange 跨洞）收紧到 50 m——跨洞的 Lagrange 远比
// 局部 Hermite 敏感。误差估计取二体运动的 h⁴·n⁴·r/384（Hermite 余项），见 bridgeErrKm。
const BRIDGE_MAX_KM_VEL = 1.0
const BRIDGE_MAX_KM_POS = 0.05

const hyp = (x, y, z) => Math.sqrt(x * x + y * y + z * z)

/** 跨一个时长 dtS 的缺口做三次 Hermite 插值，二体运动下的误差估计（km）：h⁴/384 · n⁴ · r */
function bridgeErrKm(dtS, rKm) {
  if (!(dtS > 0) || !(rKm > 0)) return 0
  const n = Math.sqrt(MU / (rKm * rKm * rKm))
  const h = dtS, q = h * n
  return (q * q * q * q) * rKm / 384
}

/**
 * rows: [{ ms, p:[x,y,z] km, v:[vx,vy,vz] km/s | null, line, cut }]（文件顺序；cut = 新段从这一行起，OEM 的每段首行）
 * opts: { dupIsBoundary: 重复时刻（状态相同）也当段界, boundaries: [ms…] 显式段界（STK：段界【在】这一刻，两侧都有这一点） }
 * 返回 { t, p, v, spans, report, warnings }
 *   report: { sorted, dupRows, dupTimes:[ms], jumps:[{ ms, dpKm, dvKmps }], gaps:[{ t0, t1, dtS, split }], stepS, boundaries:[ms] }
 */
function normalizeRows(rowsIn, opts) {
  const o = opts || {}
  const warnings = []
  const rows = (rowsIn || []).filter((r) => r && Number.isFinite(r.ms) && r.p && r.p.every(Number.isFinite))
  const hasV = rows.length > 0 && rows.every((r) => r.v && r.v.length >= 3 && r.v.every(Number.isFinite))
  const report = { sorted: false, dupRows: 0, dupTimes: [], jumps: [], gaps: [], stepS: null, boundaries: [] }
  if (!rows.length) return { t: new Float64Array(0), p: new Float64Array(0), v: null, spans: null, report, warnings }

  // ① 单调性
  let firstBack = -1
  for (let i = 1; i < rows.length; i++) if (rows[i].ms < rows[i - 1].ms) { firstBack = i; break }
  if (firstBack >= 0) {
    rows.sort((a, b) => a.ms - b.ms)   // V8 的 sort 是稳定的：同一时刻的行保持文件里的先后
    report.sorted = true
    const ln = rowsIn[firstBack] && rowsIn[firstBack].line
    warnings.push('时刻不单调' + (ln ? '（第 ' + ln + ' 行起）' : '') + '，已按时刻重排')
  }
  const explicit = new Set((o.boundaries || []).map((x) => Math.round(Number(x))).filter(Number.isFinite))

  // ② 同刻多行
  const keep = []                 // { ms, p, v, cut }：cut = 这一点之前是段界
  const same = (a, b) => {
    const dp = hyp(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2])
    if (dp > 1e-6) return false                       // 1 mm
    if (!hasV) return true
    return hyp(a.v[0] - b.v[0], a.v[1] - b.v[1], a.v[2] - b.v[2]) <= 1e-9   // 1 µm/s
  }
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z')
  for (let i = 0; i < rows.length;) {
    let j = i + 1
    while (j < rows.length && rows[j].ms === rows[i].ms) j++
    const run = rows.slice(i, j)
    const first = run[0], last = run[run.length - 1]
    const allSame = run.every((r) => same(r, first))
    if (run.length > 1) {
      report.dupRows += run.length - 1
      if (allSame) report.dupTimes.push(first.ms)
      else {
        const dp = hyp(last.p[0] - first.p[0], last.p[1] - first.p[1], last.p[2] - first.p[2])
        const dv = hasV ? hyp(last.v[0] - first.v[0], last.v[1] - first.v[1], last.v[2] - first.v[2]) : null
        report.jumps.push({ ms: first.ms, dpKm: dp, dvKmps: dv })
        if (run.length > 2 && !run.slice(1, -1).every((r) => same(r, first) || same(r, last))) {
          warnings.push(iso(first.ms) + ' 有 ' + run.length + ' 个互不相同的状态，取首末两个')
        }
      }
    }
    // 段界：间断（状态不同）、按格式约定的重复行（dupIsBoundary）、显式段界时刻、同刻行里有新段的首行（OEM 段首与上段段尾同历元）
    const cutBefore = !!first.cut
    const cutInside = run.slice(1).some((r) => r.cut)
    const boundary = !allSame || (run.length > 1 && !!o.dupIsBoundary) || explicit.has(Math.round(first.ms)) || cutInside
    if (!keep.length) {
      // 序列开头：前面没有段可止，留后一个状态即可
      keep.push({ ms: first.ms, p: last.p, v: last.v, cut: false })
    } else if (j >= rows.length || !boundary) {
      // 序列末尾 / 不是段界：留前一个状态（末尾那一刻之后没有区间，后一个状态无处可用）
      keep.push({ ms: first.ms, p: first.p, v: first.v, cut: cutBefore })
    } else {
      // 前一段止于 first，后一段从 last 起；后者顺延 1 ms 保证严格递增，顺延撞上下一行就只留前一个状态
      keep.push({ ms: first.ms, p: first.p, v: first.v, cut: cutBefore })
      if (rows[j].ms > first.ms + NUDGE_MS) {
        keep.push({ ms: first.ms + NUDGE_MS, p: last.p, v: last.v, cut: true })
        report.boundaries.push(first.ms)
      } else warnings.push(iso(first.ms) + ' 的段界之后 1 ms 内即有下一行，后一状态已舍弃')
    }
    i = j
  }

  // ③ 缺口：中位步长 + 逐段误差估计
  const steps = []
  for (let k = 1; k < keep.length; k++) { const d = keep[k].ms - keep[k - 1].ms; if (!keep[k].cut && d > NUDGE_MS) steps.push(d) }
  steps.sort((a, b) => a - b)
  const med = steps.length ? steps[steps.length >> 1] : 0
  report.stepS = med ? med / 1000 : null
  const lim = hasV ? BRIDGE_MAX_KM_VEL : BRIDGE_MAX_KM_POS
  for (let k = 1; k < keep.length; k++) {
    if (keep[k].cut) continue
    const d = keep[k].ms - keep[k - 1].ms
    if (!(med > 0) || d <= 1.5 * med) continue
    const r = 0.5 * (hyp(keep[k].p[0], keep[k].p[1], keep[k].p[2]) + hyp(keep[k - 1].p[0], keep[k - 1].p[1], keep[k - 1].p[2]))
    const err = bridgeErrKm(d / 1000, r)
    const split = err > lim
    report.gaps.push({ t0: keep[k - 1].ms, t1: keep[k].ms, dtS: d / 1000, split, errKm: err })
    if (split) keep[k].cut = true
  }

  // ④ 装数组 + 段
  const n = keep.length
  const t = new Float64Array(n), p = new Float64Array(3 * n), v = hasV ? new Float64Array(3 * n) : null
  const spans = []
  let segStart = 0
  for (let k = 0; k < n; k++) {
    const r = keep[k]
    if (r.cut && k > segStart) { spans.push([t[segStart], t[k - 1]]); segStart = k }
    t[k] = r.ms
    p[3 * k] = r.p[0]; p[3 * k + 1] = r.p[1]; p[3 * k + 2] = r.p[2]
    if (v) { v[3 * k] = r.v[0]; v[3 * k + 1] = r.v[1]; v[3 * k + 2] = r.v[2] }
  }
  if (n) spans.push([t[segStart], t[n - 1]])
  return { t, p, v, spans: spans.length > 1 ? spans : null, report, warnings }
}

/* ===================== 运动学体检 ===================== */
// 取不超过 maxN 个「左右步长相等」的内点（等步长三点差分才是二阶精度）；步长须 ≤ 轨道周期 / 50。
function samplePoints(t, p, maxN) {
  const n = t.length
  const idx = []
  if (n < 3) return idx
  const stride = Math.max(1, Math.floor((n - 2) / (maxN || 200)))
  for (let i = 1; i < n - 1; i += stride) {
    const h1 = t[i] - t[i - 1], h2 = t[i + 1] - t[i]
    if (!(h1 > 0) || Math.abs(h1 - h2) > 1e-6 * h1) continue
    const r = hyp(p[3 * i], p[3 * i + 1], p[3 * i + 2])
    const T = 2 * Math.PI * Math.sqrt(r * r * r / MU)
    if (h1 / 1000 > T / 50) continue
    idx.push(i)
  }
  return idx
}
const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1] }
function gravityJ2(x, y, z) {
  const r2 = x * x + y * y + z * z, r = Math.sqrt(r2), r3 = r2 * r
  const k = -1.5 * J2 * MU * RE * RE / (r2 * r3), zz = 5 * z * z / r2
  return [-MU * x / r3 + k * x * (1 - zz), -MU * y / r3 + k * y * (1 - zz), -MU * z / r3 + k * z * (3 - zz)]
}

/**
 * 数据是在旋转（地固）系还是惯性系里：位置二阶差分得加速度，分别与两种假设下的理论加速度比残差。
 *   惯性：a = g(r)（含 J2）       地固：a = g(r) − 2ω×v − ω×(ω×r)
 * 返回 { frame:'FIXED'|'INERTIAL'|null, ratio:惯性残差/地固残差, n:参与点数 }；判不出（点少 / 步长过粗 / 比值在 0.1–10 之间）给 null。
 * p 为 km、t 为 ms。速度一律用位置差分算（不依赖文件里的速度列，免得速度列本身就有问题）。
 */
function kinematicFrame(t, p) {
  const idx = samplePoints(t, p, 200)
  if (idx.length < 3) return { frame: null, ratio: NaN, n: idx.length }
  const resIn = [], resRot = []
  for (const i of idx) {
    const h = (t[i] - t[i - 1]) / 1000
    const a = [0, 1, 2].map((c) => (p[3 * (i + 1) + c] - 2 * p[3 * i + c] + p[3 * (i - 1) + c]) / (h * h))
    const vv = [0, 1, 2].map((c) => (p[3 * (i + 1) + c] - p[3 * (i - 1) + c]) / (2 * h))
    const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2]
    const g = gravityJ2(x, y, z)
    const rot = [g[0] + 2 * W_E * vv[1] + W_E * W_E * x, g[1] - 2 * W_E * vv[0] + W_E * W_E * y, g[2]]
    resIn.push(hyp(a[0] - g[0], a[1] - g[1], a[2] - g[2]))
    resRot.push(hyp(a[0] - rot[0], a[1] - rot[1], a[2] - rot[2]))
  }
  const mi = median(resIn), mr = median(resRot)
  const ratio = mr > 0 ? mi / mr : (mi > 0 ? Infinity : NaN)
  const frame = ratio > 10 ? 'FIXED' : (ratio < 0.1 ? 'INERTIAL' : null)
  return { frame, ratio, n: idx.length }
}

/**
 * 文件给的速度列相对「位置差分」的比例：v_true ≈ scale · v_raw。
 * 返回 { scale（已就近吸附到 1e-3 / 1 / 1e3，吸附不上为 NaN）, raw（最小二乘原值）, rel（吸附后的相对残差中位数）, n }。
 * p 为 km、t 为 ms、vRaw 为文件原值（单位未知）。
 */
function velocityScale(t, p, vRaw) {
  const idx = samplePoints(t, p, 200)
  if (idx.length < 2 || !vRaw) return { scale: NaN, raw: NaN, rel: NaN, n: idx.length }
  let num = 0, den = 0
  const fd = []
  for (const i of idx) {
    const h = (t[i + 1] - t[i - 1]) / 1000
    const d = [0, 1, 2].map((c) => (p[3 * (i + 1) + c] - p[3 * (i - 1) + c]) / h)
    const w = [vRaw[3 * i], vRaw[3 * i + 1], vRaw[3 * i + 2]]
    num += d[0] * w[0] + d[1] * w[1] + d[2] * w[2]
    den += w[0] * w[0] + w[1] * w[1] + w[2] * w[2]
    fd.push([d, w])
  }
  const raw = den > 0 ? num / den : NaN
  let scale = NaN
  for (const c of [1e-3, 1, 1e3]) if (raw > c * 0.5 && raw < c * 2) scale = c
  if (!Number.isFinite(scale)) return { scale, raw, rel: NaN, n: idx.length }
  const rels = fd.map(([d, w], j) => {
    const e = hyp(d[0] - scale * w[0], d[1] - scale * w[1], d[2] - scale * w[2])
    // 尺度取「惯性速度量级」，与帧无关：惯性系里就是 |v|；地固系里 GEO 的速度只有几 m/s，拿它做分母会把正常的
    // 数值噪声放大成假不一致（SGP4 的速度本就不是位置的精确导数，实测 GEO 差 0.05 m/s ≈ 惯性速度的 1.6e-5），
    // 故与 ω⊕·|r_xy| 取大
    const i = idx[j]
    const base = Math.max(hyp(d[0], d[1], d[2]), W_E * Math.hypot(p[3 * i], p[3 * i + 1]), 1e-3)
    return e / base
  })
  return { scale, raw, rel: median(rels), n: idx.length }
}

module.exports = {
  MU, RE, J2, W_E, NUDGE_MS, BRIDGE_MAX_KM_VEL, BRIDGE_MAX_KM_POS,
  bridgeErrKm, normalizeRows, kinematicFrame, velocityScale, gravityJ2
}
