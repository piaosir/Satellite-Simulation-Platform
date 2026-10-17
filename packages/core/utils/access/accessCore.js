// ⚠ 自动生成，勿手改 —— 源：accessCore.mjs（ESM）。重生成：node scripts/gen-access-cjs.mjs
'use strict'

// 唯一访问引擎（差距分析 B-01，2026-10-17）—— 纯函数：无 SGP4、无 Vue / DOM、无文件系统依赖。
//
// 用在哪：
//   · 渲染端：src/viz/vis/visibility.js 的 accessWindows（可见性「时段过境」）直接 import 本文件；
//            src/viz/vis/coverageGrid.js 的覆盖 FOM 用这里的 hermitePositive / coverMinDetectSec。
//   · 主进程：packages/core/utils/ngsoGeometry.js 的 solveAccessWindows（再生式单站访问窗口）
//            require 同目录的 accessCore.js —— 那份是本文件的 CJS 镜像，由 scripts/gen-access-cjs.mjs
//            机械生成（Electron 31 内置 Node 20.18，CJS 不能同步 require ESM；Vite 又不转 packages/ 下的 CJS），
//            packages/core/test/accessEngine.test.mjs 逐字对拍钉死。★ 改本文件后必须重跑：node scripts/gen-access-cjs.mjs
//   · 不在这里的：日凌 sunOutage 仍走 eventWindows.findWindows（金标准逐位）；NGSO 典型时刻 coupledTypicalMoment
//     与 C/I 时变 ciNgso 的采样器刻意不动（前者 t* 逐位回归、后者 CDF 等权粗采样 / in-line 细化两套采样率）。
//
// ── 单目标事件：「仰角极值夹逼 + 自适应步长」──
//   g(t) = 归一化余量（≥ 0 在窗内）。仰角约束 g = El − 门限（rad）；多约束时 g 取各约束归一化余量的最小值
//   （evalAt 里用 allOf 合成；本轮只有仰角一种，接口按「目标点分量（任一）× 约束（全部）」留好）。
//   ① 步长：每拍算出「从此刻起 g 一定不会变号」的时长 safe（Lipschitz 球面追踪：|dEl/dt| ≤ V/ρ，
//      ρ 在 τ 内至少还有 ρ − V·τ ⇒ ∫ ≤ ln(ρ/(ρ−Vτ)) < |g| ⇔ τ < ρ(1 − e^{−|g|})/V），步长 = clamp(safe, Δ, Δmax)，
//      Δ = min(P/16, 5 min)（移动目标另 ≤ 60 s：载具机动时标）。safe ≥ 步长的区间「有保证」：g 在区间内不变号。
//   ② 没保证的区间（只可能是贴近门限、步长被 Δ 兜住的那些）里藏着的事件，靠极值夹逼找：
//      两端都在窗外而导数由正转负（区间内有极大）→ Brent 把极大精炼到 0.1 s，峰值 ≥ 门限才成窗；
//      两端都在窗内而导数由负转正（区间内有极小）→ 精炼极小，低于门限就把窗拆成两段；
//      另留离散局部极大兜底（导数信息不可信时）。
//   ③ 符号翻转的区间（含②里夹出来的单调段）在单调段上求根：Brent zeroin，AOS / LOS 精确到 1 ms。
//   ④ 窗内峰值：相邻两点导数由正转负 → Brent 精炼；取各段最大。
//   ⑤ GEO：V 按轨道根数取上界（同步轨道上界只有 0.1 km/s 量级），整段 safe 远大于步长、样本全在门限上 ⇒ 天然一窗常驻
//      （即「按采样极差判常驻」：样本最小值 − 两样本间可能的最大变化 ≥ 门限）。
//   可证不漏：有保证的区间不可能藏窗；没保证的区间长度 ≤ Δ，单目标仰角在其中至多一个临界点，藏着的窗必有
//   导数由正转负 → 必被精炼到；精炼精度 0.1 s ⇒ 最短可检出过境 = 2 × 0.1 s（minDetectMs）。
//
// ── 覆盖 FOM 用：区间内的三次 Hermite ──
//   hermitePositive：余量在一个采样区间里的三次 Hermite（两端值 + 两端导数）≥ 0 的子区间，覆盖核据此求精确进出时刻。

const EPS = 2.220446049250313e-16
const SQRT_EPS = 1.4901161193847656e-8
const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const MU = 398600.4418              // 地心引力常数 km³/s²
const RE = 6378.137                 // WGS-84 赤道半径 km
const WGS_B = 6356.7523142          // WGS-84 极半径 km（与 satellite.js geodeticToEcf 同参）
const OMEGA_E = 7.292115146706979e-5   // 地球自转角速度 rad/s
const MIN_PERIOD_MIN = 2 * Math.PI * Math.sqrt(RE * RE * RE / MU) / 60   // 绕地最小周期（地心距 = Re 的圆轨道）≈ 84.49 min
const INV_G = -10                   // 无状态（传播失败 / 星历断档 / 载具不在航迹上）一律按窗外：余量取这个负数（低于一切真实余量）

const ACCESS_DEFAULTS = Object.freeze({
  peakTolMs: 100,          // 峰值时刻精度（0.1 s）
  edgeTolMs: 1,            // AOS / LOS 精度（1 ms）
  baseStepCapMs: 300000,   // Δ = min(P/16, 5 min) 里的 5 min
  moveStepMs: 60000,       // 移动目标步长上限（载具机动时标）
  bigStepCapMs: 21600000,  // 有保证的大步上限（6 h；另受 P/4 约束，保证窗内相邻两点间至多一个临界点）
  maxEvals: 4000000        // 单次扫描的取值预算（防死循环；正常远用不到）
})

/** 最短可检出过境时长（ms）：极大精炼到 peakTol ⇒ 峰值时刻误差 ≤ peakTol，余量 > 0 的窗只要半宽 ≥ peakTol 就一定判得出。 */
function minDetectMs(peakTolMs) {
  return 2 * (peakTolMs > 0 ? peakTolMs : ACCESS_DEFAULTS.peakTolMs)
}

/** 粗步 Δ = min(P/16, 5 min)（ms）。P 为轨道周期（min），未知按绕地最小周期（该式对 P 单调增，取下界即最细）。 */
function baseStepMs(periodMin) {
  const P = periodMin > 0 ? periodMin : MIN_PERIOD_MIN
  return Math.min(P * 60000 / 16, ACCESS_DEFAULTS.baseStepCapMs)
}

/** 有保证时允许的最大步（ms）：min(P/4, 6 h)，不小于 Δ。 */
function bigStepMs(periodMin) {
  const P = periodMin > 0 ? periodMin : MIN_PERIOD_MIN
  return Math.max(baseStepMs(P), Math.min(P * 60000 / 4, ACCESS_DEFAULTS.bigStepCapMs))
}

// ─────────────────────────────── 一维数值件 ───────────────────────────────

/**
 * Brent zeroin（括区间求根），返回【窗内一侧】的括区间端点：f ≥ 0 视为窗内。
 * 前提：f(xa) = fa 与 f(xb) = fb 一个 ≥ 0、一个 < 0。tol = 括区间宽度上限（与 x 同单位）。
 * f 可返回 INV_G 这类「远在窗外」的值（星历断档）：Brent 一律保持括区间，必收敛到断档边界。
 */
function zeroBracket(f, xa, xb, fa, fb, tol) {
  // 「窗内」是 f ≥ 0：恰为 0 的点按窗内一侧的极小正数处理，免得 Brent 把端点上的 0 当成根就地收工（0 之后可能还在窗内）
  const TINY = 1e-300
  const F = (x) => { const v = f(x); return v === 0 ? TINY : v }
  let a = xa, b = xb, c = xa
  let fA = fa === 0 ? TINY : fa, fB = fb === 0 ? TINY : fb, fC = fA
  let d = b - a, e = d
  for (let it = 0; it < 200; it++) {
    if ((fB >= 0) === (fC >= 0)) { c = a; fC = fA; d = b - a; e = d }
    if (Math.abs(fC) < Math.abs(fB)) { a = b; b = c; c = a; fA = fB; fB = fC; fC = fA }
    const tol1 = 2 * EPS * Math.abs(b) + 0.5 * tol
    const xm = 0.5 * (c - b)
    if (Math.abs(xm) <= tol1) break
    if (Math.abs(e) >= tol1 && Math.abs(fA) > Math.abs(fB)) {
      const s = fB / fA
      let p, q
      if (a === c) { p = 2 * xm * s; q = 1 - s } else {
        const qq = fA / fC, r = fB / fC
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1))
        q = (qq - 1) * (r - 1) * (s - 1)
      }
      if (p > 0) q = -q; else p = -p
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q } else { d = xm; e = d }
    } else { d = xm; e = d }
    a = b; fA = fB
    b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1)
    fB = F(b)
  }
  return fB >= 0 ? b : c
}

/**
 * Brent 极小化（fmin，抛物线插值 + 黄金分割兜底），在 [ax, bx] 上找 f 的极小；tol = x 的收敛精度。
 * 返回 { x, fx }。不取端点（极小在端点时收敛到离端点 tol 以内）。
 */
function fminBrent(f, ax, bx, tol) {
  const CG = 0.3819660112501051   // (3 − √5) / 2
  let a = ax, b = bx
  let v = a + CG * (b - a), w = v, x = v
  let fx = f(x), fv = fx, fw = fx
  let d = 0, e = 0
  for (let it = 0; it < 200; it++) {
    const xm = 0.5 * (a + b)
    const tol1 = SQRT_EPS * Math.abs(x) + tol / 3, tol2 = 2 * tol1
    if (Math.abs(x - xm) <= tol2 - 0.5 * (b - a)) break
    let golden = true
    if (Math.abs(e) > tol1) {
      let r = (x - w) * (fx - fv)
      let q = (x - v) * (fx - fw)
      let p = (x - v) * q - (x - w) * r
      q = 2 * (q - r)
      if (q > 0) p = -p; else q = -q
      const eOld = e
      e = d
      if (Math.abs(p) < Math.abs(0.5 * q * eOld) && p > q * (a - x) && p < q * (b - x)) {
        d = p / q
        const u = x + d
        if (u - a < tol2 || b - u < tol2) d = xm >= x ? tol1 : -tol1
        golden = false
      }
    }
    if (golden) { e = (x >= xm ? a : b) - x; d = CG * e }
    const u = x + (Math.abs(d) >= tol1 ? d : (d > 0 ? tol1 : -tol1))
    const fu = f(u)
    if (fu <= fx) {
      if (u >= x) a = x; else b = x
      v = w; fv = fw; w = x; fw = fx; x = u; fx = fu
    } else {
      if (u < x) a = u; else b = u
      if (fu <= fw || w === x) { v = w; fv = fw; w = u; fw = fu } else if (fu <= fv || v === x || v === w) { v = u; fv = fu }
    }
  }
  return { x, fx }
}

// ─────────────────────────────── 通用窗口求解 ───────────────────────────────

/**
 * 通用事件窗口求解（「任一分量在窗内」的并集）。
 *   evalAt(t, s, k) → true | false：把时刻 t 的状态填进 s.g[i] / s.gd[i] / s.sf[i]（i = 分量号；k = −1 填全部，k ≥ 0 只填 k）
 *     g  = 归一化余量（≥ 0 在窗内）；gd = dg/dt（每 ms）；sf = 从 t 起 g 一定不变号的时长（ms，≥ 0；给 0 = 不保证）。
 *     返回 false = 此刻无状态（传播失败 / 星历断档），按窗外处理。
 *   t0 / t1：扫描时段（ms，绝对时刻或任意同单位）；opts：{ K, stepMinMs, stepMaxMs, peakTolMs, edgeTolMs, maxEvals }
 * 返回 { windows:[{ start, end, peakT, peakG, truncStart, truncEnd }], evals, budgetHit }
 *   truncStart / truncEnd = 该端点是时段端点（窗在时段起点前就开着 / 到时段终点还没关），不是真实穿越。
 */
function scanWindows(evalAt, t0, t1, opts) {
  const o = opts || {}
  const K = o.K > 1 ? Math.floor(o.K) : 1
  const stepMin = Math.max(1, o.stepMinMs > 0 ? o.stepMinMs : ACCESS_DEFAULTS.baseStepCapMs)
  const stepMax = Math.max(stepMin, o.stepMaxMs > 0 ? o.stepMaxMs : stepMin)
  const peakTol = o.peakTolMs > 0 ? o.peakTolMs : ACCESS_DEFAULTS.peakTolMs
  const edgeTol = o.edgeTolMs > 0 ? o.edgeTolMs : ACCESS_DEFAULTS.edgeTolMs
  const maxEvals = o.maxEvals > 0 ? o.maxEvals : ACCESS_DEFAULTS.maxEvals
  const res = { windows: [], evals: 0, budgetHit: false }
  if (!(t1 > t0) || typeof evalAt !== 'function') return res

  const mkS = () => ({ t: 0, ok: false, g: new Float64Array(K), gd: new Float64Array(K), sf: new Float64Array(K) })
  let P = mkS(), A = mkS(), B = mkS()
  const S1 = mkS()
  let hasP = false
  const sampleInto = (s, t) => {
    res.evals++
    s.t = t
    s.ok = evalAt(t, s, -1) === true
    if (!s.ok) for (let k = 0; k < K; k++) { s.g[k] = INV_G; s.gd[k] = NaN; s.sf[k] = 0 }
    return s
  }
  const gAt = (k, t) => {
    res.evals++
    S1.t = t
    return evalAt(t, S1, k) === true ? S1.g[k] : INV_G
  }
  // 单调段求根：返回窗内一侧端点（精度 edgeTol）；在局部坐标里解，避免绝对时刻的浮点粒度
  const rootIn = (k, a, b, ga, gb) => a + zeroBracket((x) => gAt(k, a + x), 0, b - a, ga, gb, edgeTol)
  const maxIn = (k, a, b) => { const r = fminBrent((x) => -gAt(k, a + x), 0, b - a, peakTol); return { t: a + r.x, g: -r.fx } }
  const minIn = (k, a, b) => { const r = fminBrent((x) => gAt(k, a + x), 0, b - a, peakTol); return { t: a + r.x, g: r.fx } }

  // 各分量的开窗状态：pt/pg/pd = 窗内的点（AOS、窗内样本、LOS）及其余量与导数（AOS 记 +∞、LOS 记 −∞）
  const C = []
  for (let k = 0; k < K; k++) C.push({ open: false, start: 0, truncStart: false, pt: [], pg: [], pd: [], wins: [], trigPrev: false, guarPrev: true })
  const openW = (c, t, trunc, g, d) => {
    c.open = true; c.start = t; c.truncStart = trunc
    c.pt.length = 0; c.pg.length = 0; c.pd.length = 0
    c.pt.push(t); c.pg.push(g); c.pd.push(d)
  }
  const addPt = (c, t, g, d) => { c.pt.push(t); c.pg.push(g); c.pd.push(d) }
  const closeW = (k, c, tEnd, trunc) => {
    let bt = c.pt[0], bg = c.pg[0]
    for (let j = 1; j < c.pt.length; j++) if (c.pg[j] > bg) { bg = c.pg[j]; bt = c.pt[j] }
    for (let j = 0; j + 1 < c.pt.length; j++) {
      if (c.pd[j] > 0 && c.pd[j + 1] < 0 && c.pt[j + 1] > c.pt[j]) {
        const pk = maxIn(k, c.pt[j], c.pt[j + 1])
        if (pk.g > bg) { bg = pk.g; bt = pk.t }
      }
    }
    c.wins.push({ start: c.start, end: tEnd, peakT: bt, peakG: bg, truncStart: c.truncStart, truncEnd: trunc })
    c.open = false
  }

  // 有效 / 无效交界（星历点序列表首尾、载具不在航迹上的时段）：二分到 edgeTol，返回有效一侧的时刻。
  // 交界处补一拍，交界前后照常按区间处理 —— 否则「窗外的有效拍 → 断档拍」之间藏着的半个过境会整段丢失。
  const S2 = mkS()
  const okAt = (t) => { res.evals++; S2.t = t; return evalAt(t, S2, -1) === true }
  const validEdge = (tOk, tBad) => {
    let a = tOk, b = tBad
    for (let i = 0; i < 64 && Math.abs(b - a) > edgeTol; i++) { const m = 0.5 * (a + b); if (okAt(m)) a = m; else b = m }
    return a
  }
  const rotate = () => { const tmp = P; P = A; A = B; B = tmp; hasP = true }

  sampleInto(A, t0)
  for (let k = 0; k < K; k++) if (A.g[k] >= 0) openW(C[k], t0, true, A.g[k], A.gd[k])
  let t = t0
  while (t < t1) {
    if (res.evals > maxEvals) { res.budgetHit = true; break }
    let sMin = Infinity
    if (A.ok) { for (let k = 0; k < K; k++) if (A.sf[k] < sMin) sMin = A.sf[k] } else sMin = 0
    const step = sMin < stepMin ? stepMin : (sMin > stepMax ? stepMax : sMin)
    let tn = t + step
    if (tn > t1 || t1 - tn < 1e-6) tn = t1
    sampleInto(B, tn)
    if (A.ok && !B.ok) {
      // 有效段到头：边界（有效一侧）补一拍，(A, 边界] 照常处理；边界处还开着的窗就地关（LOS = 数据终点）
      const Bi = B
      const te = validEdge(t, tn)
      if (te > t) {
        B = mkS(); sampleInto(B, te)
        if (B.ok) { doInterval(); rotate() } else B = Bi
      }
      for (let k = 0; k < K; k++) if (C[k].open) closeW(k, C[k], A.t, false)
      if (B === Bi) B = mkS()
      P = A; A = Bi; hasP = false
      t = tn
      continue
    }
    if (!A.ok && B.ok) {
      // 有效段开始：起点（有效一侧）补一拍当新的 A；此刻已在窗内的分量从这里开窗（起点 = 数据起点）
      const ts = validEdge(tn, t)
      if (ts < tn) {
        const As = mkS(); sampleInto(As, ts)
        if (As.ok) {
          A = As; hasP = false
          for (let k = 0; k < K; k++) if (A.g[k] >= 0 && !C[k].open) openW(C[k], ts, true, A.g[k], A.gd[k])
          doInterval()
        }
      } else for (let k = 0; k < K; k++) if (B.g[k] >= 0 && !C[k].open) openW(C[k], tn, true, B.g[k], B.gd[k])
      rotate(); hasP = false
      t = tn
      continue
    }
    if (A.ok) doInterval()
    rotate()
    t = tn
  }
  for (let k = 0; k < K; k++) if (C[k].open) closeW(k, C[k], t, true)

  // 区间 [A, B]（两拍都已采样、都有效）：符号翻转 → 单调段求根；没保证的区间 → 夹逼藏着的极值；窗内的拍记下来求峰值
  function doInterval() {
    const t = A.t, tn = B.t
    const h = tn - t
    const both = A.ok && B.ok
    for (let k = 0; k < K; k++) {
      const c = C[k]
      const ga = A.g[k], gb = B.g[k]
      const inA = ga >= 0, inB = gb >= 0
      const guar = both && (A.sf[k] >= h || B.sf[k] >= h)
      let trig = false
      if (inA && !inB) {
        if (!c.open) openW(c, t, false, ga, A.gd[k])   // 兜底：状态说在窗内却没有开窗
        const tc = rootIn(k, t, tn, ga, gb)
        addPt(c, tc, 0, -Infinity)
        closeW(k, c, tc, false)
      } else if (!inA && inB) {
        const tc = rootIn(k, t, tn, ga, gb)
        openW(c, tc, false, 0, Infinity)
        addPt(c, tn, gb, B.gd[k])
      } else if (!inA) {
        if (!guar && both && A.gd[k] > 0 && B.gd[k] < 0) {
          trig = true
          const pk = maxIn(k, t, tn)
          if (pk.g >= 0) {
            const aos = rootIn(k, t, pk.t, ga, pk.g), los = rootIn(k, pk.t, tn, pk.g, gb)
            c.wins.push({ start: aos, end: los, peakT: pk.t, peakG: pk.g, truncStart: false, truncEnd: false })
          }
        } else if (hasP && P.ok && both && !c.trigPrev && (!guar || !c.guarPrev) && P.g[k] < 0 && ga >= P.g[k] && ga > gb) {
          // 离散局部极大兜底（P、A、B 三拍都在窗外、A 最高，而两侧导数没给出极大信号）：在 [P, B] 上精炼
          trig = true
          const pk = maxIn(k, P.t, tn)
          if (pk.g >= 0) {
            const aos = rootIn(k, P.t, pk.t, P.g[k], pk.g), los = rootIn(k, pk.t, tn, pk.g, gb)
            c.wins.push({ start: aos, end: los, peakT: pk.t, peakG: pk.g, truncStart: false, truncEnd: false })
          }
        }
      } else {
        if (!c.open) openW(c, t, false, ga, A.gd[k])
        if (!guar && both && A.gd[k] < 0 && B.gd[k] > 0) {
          trig = true
          const mn = minIn(k, t, tn)
          if (mn.g < 0) {
            const los = rootIn(k, t, mn.t, ga, mn.g), aos = rootIn(k, mn.t, tn, mn.g, gb)
            addPt(c, los, 0, -Infinity)
            closeW(k, c, los, false)
            openW(c, aos, false, 0, Infinity)
          }
        }
        addPt(c, tn, gb, B.gd[k])
      }
      c.trigPrev = trig
      c.guarPrev = guar
    }
  }

  if (K === 1) { res.windows = C[0].wins; return res }
  // 多分量（多目标点「任一点可见即算」）：各分量窗口求并，峰值取并窗内各分量峰值的最大
  const all = []
  for (let k = 0; k < K; k++) for (const w of C[k].wins) all.push(w)
  all.sort((p, q) => p.start - q.start)
  const out = []
  for (const w of all) {
    const last = out.length ? out[out.length - 1] : null
    if (last && w.start <= last.end + edgeTol) {
      if (w.end > last.end) { last.end = w.end; last.truncEnd = w.truncEnd }
      else if (w.end === last.end) last.truncEnd = last.truncEnd || w.truncEnd
      if (w.peakG > last.peakG) { last.peakG = w.peakG; last.peakT = w.peakT }
      last.truncStart = last.truncStart || w.truncStart
    } else out.push({ ...w })
  }
  res.windows = out
  return res
}

/**
 * 多约束合成（「全部满足才算在窗内」，供 evalAt 用）：g = 各约束归一化余量的最小值，导数取起作用（最小）的那条；
 * 不变号时长：g ≥ 0 时任一约束翻负 g 就翻负 ⇒ 取各约束的最小；g < 0 时要所有为负的约束都翻正 g 才翻正 ⇒ 取为负那些的最大。
 * m / md / sf：n 条约束各自的余量、导数（每 ms）、不变号时长（ms）；结果写进 s.g[i] / s.gd[i] / s.sf[i]。
 * （2026-10-17 只有仰角一种约束，接口先留好：GSO 弧规避 / 方位掩模 / 斜距等约束各自给出 m / md / sf 即可接入。）
 */
function allOf(m, md, sf, n, s, i) {
  let g = Infinity, gd = NaN, j0 = -1
  for (let j = 0; j < n; j++) if (m[j] < g) { g = m[j]; j0 = j }
  if (j0 < 0) { s.g[i] = INV_G; s.gd[i] = NaN; s.sf[i] = 0; return }
  gd = md[j0]
  let safe
  if (g >= 0) { safe = Infinity; for (let j = 0; j < n; j++) if (sf[j] < safe) safe = sf[j] } else { safe = 0; for (let j = 0; j < n; j++) if (m[j] < 0 && sf[j] > safe) safe = sf[j] }
  s.g[i] = g; s.gd[i] = gd; s.sf[i] = safe
}

// ─────────────────────────────── 仰角约束 ───────────────────────────────

/** WGS-84 观测者基：站址 ECEF（大地高 hKm）+ 当地天顶方向余弦（与 visibility.js buildObservers 同式）。 */
function observerOf(latDeg, lonDeg, hKm) {
  const f = (RE - WGS_B) / RE, e2 = 2 * f - f * f
  const lat = latDeg * D2R, lon = lonDeg * D2R, h = Number.isFinite(hKm) ? hKm : 0
  const sLat = Math.sin(lat), cLat = Math.cos(lat), sLon = Math.sin(lon), cLon = Math.cos(lon)
  const N = RE / Math.sqrt(1 - e2 * sLat * sLat)
  return { ox: (N + h) * cLat * cLon, oy: (N + h) * cLat * sLon, oz: (N * (1 - e2) + h) * sLat, ux: cLat * cLon, uy: cLat * sLon, uz: sLat, vx: 0, vy: 0, vz: 0 }
}

/** TEME 位置 / 速度（km、km/s）+ GMST（rad）→ 地固系位置 / 速度（速度已扣 ω⊕ × r），写进 out 并返回。 */
function temeToEcef(p, v, gmst, out) {
  const cg = Math.cos(gmst), sg = Math.sin(gmst)
  const x = p.x * cg + p.y * sg, y = p.y * cg - p.x * sg
  out.x = x; out.y = y; out.z = p.z
  if (v) {
    out.vx = v.x * cg + v.y * sg + OMEGA_E * y
    out.vy = v.y * cg - v.x * sg - OMEGA_E * x
    out.vz = v.z
  } else { out.vx = NaN; out.vy = NaN; out.vz = NaN }
  return out
}

/**
 * 卫星地固系速度上界（km/s）：仰角变化率的 Lipschitz 上界用。
 *   satrec（a 地球半径 / ecco / inclo）：|v_ecef|² = |v_i|² + ω²(x²+y²) − 2ω·h_z ≤ v_p² + ω² r_a² − 2ω·h·cos i
 *     （h_z 在二体与 J2 下守恒）；再乘 1.05 加 0.05 km/s 给 SGP4 摄动 / 叠加星历留余量。同步轨道只有几十 m/s。
 *   星历点序列表（__ephem）：采样里的最小 / 最大地心距 → 束缚轨道速度 ≤ √(2μ/r_min) 加 ω⊕·r_max（宽松但恒成立），缓存在表上。
 *   地固定点（__fix）：0.01。其余 / 拿不到：12（> 地表逃逸速度）。
 */
function satSpeedBound(o) {
  if (!o) return 12
  if (o.__fix) return 0.01
  if (o.__ephem) {
    if (o.__vmax > 0) return o.__vmax
    const p = o.p, n = o.n | 0
    let rmin = Infinity, rmax = 0
    if (p && n > 0) for (let i = 0; i < n; i++) { const r = Math.hypot(p[3 * i], p[3 * i + 1], p[3 * i + 2]); if (r < rmin) rmin = r; if (r > rmax) rmax = r }
    const v = rmin > 0 && rmin < Infinity ? Math.sqrt(2 * MU / (rmin * 0.98)) * 1.05 + OMEGA_E * rmax * 1.02 + 0.05 : 12
    try { o.__vmax = v } catch { /* 冻结对象：不缓存 */ }
    return v
  }
  const aER = Number(o.a), e = Number(o.ecco)
  if (!(aER > 0) || !(e >= 0 && e < 1)) return 12
  const a = aER * RE, rp = a * (1 - e), ra = a * (1 + e)
  const vp2 = MU * (2 / rp - 1 / a)
  const hz = Math.sqrt(MU * a * (1 - e * e)) * Math.cos(Number(o.inclo) || 0)
  let v2 = vp2 + OMEGA_E * OMEGA_E * ra * ra - 2 * OMEGA_E * hz
  if (!(v2 > 0)) v2 = 0
  return Math.sqrt(v2) * 1.05 + 0.05
}

// 一颗星（地固系状态 st）对一个观测者 ob 的仰角余量 → s.g[i] / s.gd[i] / s.sf[i]
//   V = 相对速度上界（km/s），wUp = 观测者天顶方向转动角速率上界（rad/s，移动目标才有）
function elevInto(st, ob, thr, V, wUp, s, i) {
  const rx = st.x - ob.ox, ry = st.y - ob.oy, rz = st.z - ob.oz
  const rho = Math.sqrt(rx * rx + ry * ry + rz * rz)
  if (!(rho > 0)) { s.g[i] = INV_G; s.gd[i] = NaN; s.sf[i] = 0; return }
  const up = rx * ob.ux + ry * ob.uy + rz * ob.uz
  let sn = up / rho
  if (sn > 1) sn = 1; else if (sn < -1) sn = -1
  const g = Math.asin(sn) - thr
  s.g[i] = g
  const vx = st.vx - (ob.vx || 0), vy = st.vy - (ob.vy || 0), vz = st.vz - (ob.vz || 0)
  if (vx === vx && vy === vy && vz === vz) {
    const upd = vx * ob.ux + vy * ob.uy + vz * ob.uz
    const rhod = (rx * vx + ry * vy + rz * vz) / rho
    const ce = Math.sqrt(Math.max(0, 1 - sn * sn))
    s.gd[i] = (upd * rho - up * rhod) / (rho * rho * Math.max(ce, 1e-9)) / 1000   // rad/ms
  } else s.gd[i] = NaN
  const ag = g < 0 ? -g : g
  let safe = wUp > 0 ? rho * (1 - Math.exp(-ag / 2)) / V : rho * (1 - Math.exp(-ag)) / V
  if (wUp > 0) { const s2 = ag / (2 * wUp); if (s2 < safe) safe = s2 }
  s.sf[i] = safe * 980   // s → ms，再留 2% 余量
}

/**
 * 仰角门限访问窗口（单星 × 目标）。
 * spec = {
 *   stateAt(tMs, out) → true/false：卫星地固系位置 / 速度写进 out.{x,y,z,vx,vy,vz}（km、km/s）
 *   obs:[观测者基]（静止目标，observerOf 产物；多点 = 任一点可见即算）| obsAt(tMs) → [观测者基]（移动目标，取第 1 个；可带 vx/vy/vz）
 *   thrDeg, t0, t1（ms）, periodMin（轨道周期，未知可空）, vSat（satSpeedBound）, vObs（移动目标速度上界 km/s，缺省 1.4）
 *   peakTolMs?, edgeTolMs?
 * }
 * 返回 { windows:[{ startMs, endMs, peakMs, peakEl(°), truncStart, truncEnd }], evals, budgetHit, minDetectMs }
 */
function elevWindows(spec) {
  const sp = spec || {}
  const thr = (Number(sp.thrDeg) || 0) * D2R
  const moving = typeof sp.obsAt === 'function'
  const obsList = moving ? null : (Array.isArray(sp.obs) ? sp.obs : [])
  const K = moving ? 1 : obsList.length
  const peakTolMs = sp.peakTolMs > 0 ? sp.peakTolMs : ACCESS_DEFAULTS.peakTolMs
  const empty = { windows: [], evals: 0, budgetHit: false, minDetectMs: minDetectMs(peakTolMs) }
  if (!K || typeof sp.stateAt !== 'function') return empty
  const vSat = sp.vSat > 0 ? sp.vSat : 12
  const vObs = moving ? (sp.vObs > 0 ? sp.vObs : 1.4) : 0
  const V = vSat + vObs
  const wUp = moving ? vObs / RE : 0
  const st = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }
  const evalAt = (tMs, s, k) => {
    if (!sp.stateAt(tMs, st)) return false
    let list = obsList
    if (moving) { list = sp.obsAt(tMs); if (!list || !list.length) return false }
    const k0 = k >= 0 ? k : 0, k1 = k >= 0 ? k + 1 : K
    for (let i = k0; i < k1; i++) elevInto(st, list[moving ? 0 : i], thr, V, wUp, s, i)
    return true
  }
  const P = sp.periodMin > 0 ? sp.periodMin : MIN_PERIOD_MIN
  const stepMinMs = moving ? Math.min(baseStepMs(P), ACCESS_DEFAULTS.moveStepMs) : baseStepMs(P)
  const stepMaxMs = moving ? ACCESS_DEFAULTS.moveStepMs : bigStepMs(P)
  const r = scanWindows(evalAt, sp.t0, sp.t1, { K, stepMinMs, stepMaxMs, peakTolMs, edgeTolMs: sp.edgeTolMs })
  return {
    windows: r.windows.map((w) => ({ startMs: w.start, endMs: w.end, peakMs: w.peakT, peakEl: (w.peakG + thr) * R2D, truncStart: w.truncStart, truncEnd: w.truncEnd })),
    evals: r.evals, budgetHit: r.budgetHit, minDetectMs: minDetectMs(peakTolMs)
  }
}

// ─────────────────────────────── 覆盖 FOM：区间内三次 Hermite ───────────────────────────────

/**
 * 一个采样区间里余量 m(τ)（τ∈[0,1]）的三次 Hermite：m(0)=ma、m(1)=mb、m'(0)=da、m'(1)=db（导数已乘区间长）。
 * 求 m ≥ 0 的子区间，写进 out[2j] / out[2j+1]（τ），返回子区间个数（0..2）。
 * 做法：m' 的根（二次式闭式）把 [0,1] 切成单调段，有符号翻转的段上 Newton + 二分求根（τ 精度 1e-10）。
 */
function hermitePositive(ma, mb, da, db, out) {
  const c0 = ma, c1 = da, c2 = 3 * (mb - ma) - 2 * da - db, c3 = 2 * (ma - mb) + da + db
  // 临界点：3c3·τ² + 2c2·τ + c1 = 0
  let k1 = 2, k2 = 2
  const qa = 3 * c3, qb = 2 * c2, qc = c1
  if (qa === 0) {
    if (qb !== 0) { const r = -qc / qb; if (r > 0 && r < 1) k1 = r }
  } else {
    const disc = qb * qb - 4 * qa * qc
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      const q = -0.5 * (qb + (qb >= 0 ? sq : -sq))
      let r1 = q / qa, r2 = q !== 0 ? qc / q : r1
      if (r1 > r2) { const tt = r1; r1 = r2; r2 = tt }
      if (r1 > 0 && r1 < 1) k1 = r1
      if (r2 > 0 && r2 < 1 && r2 > r1) { if (k1 === 2) k1 = r2; else k2 = r2 }
    }
  }
  let n = 0, inside = ma >= 0, start = 0
  let u = 0, pu = ma
  for (let j = 0; j < 3; j++) {
    const v = j === 0 ? k1 : (j === 1 ? k2 : 1)
    if (v > 1) continue
    const pvv = v === 1 ? mb : c0 + v * (c1 + v * (c2 + v * c3))
    if ((pu >= 0) !== (pvv >= 0)) {
      const r = cubicRootMono(c0, c1, c2, c3, u, v, pu, pvv)
      if (inside) { out[2 * n] = start; out[2 * n + 1] = r; n++; inside = false } else { start = r; inside = true }
    }
    u = v; pu = pvv
  }
  if (inside) { out[2 * n] = start; out[2 * n + 1] = 1; n++ }
  return n
}
// 单调段 [u, v] 上三次式的根（两端异号；pu = p(u)、pv = p(v)）：从弦截点起 Newton，出界改二分；|Δτ| ≤ 1e-11 收敛
function cubicRootMono(c0, c1, c2, c3, u, v, pu, pv) {
  let lo = u, hi = v
  const upLo = pu >= 0
  let x = pu !== pv ? u + (v - u) * pu / (pu - pv) : 0.5 * (u + v)
  if (!(x > u && x < v)) x = 0.5 * (u + v)
  for (let it = 0; it < 60; it++) {
    const fx = c0 + x * (c1 + x * (c2 + x * c3))
    if (fx === 0) return x
    if ((fx >= 0) === upLo) lo = x; else hi = x
    const d = c1 + x * (2 * c2 + 3 * c3 * x)
    let xn = d !== 0 ? x - fx / d : NaN
    if (!(xn > lo && xn < hi)) xn = 0.5 * (lo + hi)
    if (Math.abs(xn - x) <= 1e-11 || hi - lo <= 1e-11) return xn
    x = xn
  }
  return x
}

/**
 * 覆盖核的最短可检出过境时长（s）：余量 m(t) = ĉ·ŝ(t) − cos λ 的三次 Hermite 误差 ε ≤ 2·ω⁴h⁴/384（ω = 星下点角速率，
 * 含导数近似的一倍余量），掠过的峰值余量低于 ε 才可能判漏；该掠过时长 = 2·√(2ε/κ)，κ = |m''| ≈ ω²·cos λ。
 * ⇒ 2·ω·h²·√(4 / (384·cos λ))。ω（rad/s）、h（采样步长 s）、cosLam（覆盖冠半角余弦）。
 */
function coverMinDetectSec(omega, hSec, cosLam) {
  if (!(omega > 0) || !(hSec > 0)) return 0
  const cl = cosLam > 0.05 ? cosLam : 0.05
  return 2 * omega * hSec * hSec * Math.sqrt(4 / (384 * cl))
}

module.exports = { ACCESS_DEFAULTS, minDetectMs, baseStepMs, bigStepMs, zeroBracket, fminBrent, scanWindows, allOf, observerOf, temeToEcef, satSpeedBound, elevWindows, hermitePositive, coverMinDetectSec }
