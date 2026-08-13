// 对星覆盖【时段扫描】核 —— 自适应步长扫描 + 边界二分 + 窗内峰值。无 Vue / 无 SGP4，可离线单测。
//
// 解决的问题：波束比地平锥窄得多。可见性分析那套「90 s 固定粗扫」是按地平锥（几十度）定的步长，
// 拿来扫波束（常是零点几度）必漏短穿越 —— 一颗 LEO 从 GEO 的 0.5° 点波束里穿过去可能只要 40 s，
// 固定 90 s 步长有一半概率两个采样点都在窗外，整段窗口凭空消失。故本核不设固定步长，改为：
//
//   ★ 步长由【方向在天线系里走了多少角度】反控，不由时间定。
//     每步实测 Δψ = ∠(d(t), d(t+Δt))，得角速度 ω = Δψ/Δt，下一步取 Δt = 允许角位移 / ω。
//     两头都在动（源星轨道 + 目标星轨道 + 地球自转 + 指向跟踪）全被这一个实测量吸收，不必分别建模。
//
//   ★ 允许角位移用「时间域的球面追踪」放大：方向离方向图域还有 (off − Rdom) 度，那它至少要走这么远
//     才可能进域 —— 域外可以放心大步跳（取一半余量），一进域立刻收回细步。于是「一天的时窗」与
//     「0.1° 的分辨率」不冲突：域外每步几百秒，域内每步几秒，一个循环搞定，不需要两趟粗细扫。
//
//   ★ 迈大了就退回重走：实测 Δψ 超过允许值 2 倍（近距离掠过 / 角加速度大）当场缩步重采，
//     防「ω 是上一步的旧值 → 这一步实际飞过整段窗口」。
//
// 判据是【布尔】不是标量：on = 落在方向图域内 && Dir ≥ 门限 && 视线没被地球挡。三条里任一条翻转
// 都是窗口边界，故边界二分直接对 on 二分（与 visibility.accessWindows 同法，18 次≈亚秒）。
// 窗内峰值另走黄金分割（Dir 在窗内单峰），种子取粗扫最高的那一格 ±1 步，与 ACCESS 峰仰角同款。

const R2D = 180 / Math.PI
const GR = (Math.sqrt(5) - 1) / 2

const angBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * R2D
// 离轴角：天线系第 3 轴就是 boresight，方向余弦 d[2] 即 cos(离轴角)
export const offAxisOf = (d) => Math.acos(Math.max(-1, Math.min(1, d[2]))) * R2D

export const DEFAULTS = {
  domRadDeg: 10,        // 方向图域的角半径（外接圆，宁大勿小——小了会把「其实还没进域」当成进域，只是慢一点）
  angStepDeg: 0.1,      // 域内每步允许的角位移：窗口比它窄就可能被漏掉，故取「波束尺度的几分之一」
  stepMinSec: 0.5,      // 步长下限（掠过极快时的兜底；到底了就认了，并在 minStepHit 里报出来）
  stepMaxSec: 600,      // 步长上限（球面追踪算出来能跳更远也不跳——ω 的外推毕竟只有一阶）
  maxSamples: 120000,   // 单次扫描的取值预算（含二分与峰值精炼）；超了截断并明说
  edgeIters: 18,        // 边界二分次数：600 s / 2¹⁸ ≈ 2 ms
  peakTolMs: 200,       // 峰值收敛到这个时间尺度就停
  peakIters: 40,
  thrDb: null           // 门限（dB）：只用于窗内均值在边界处的取值，给了更准，不给就跳过边界那两段
}

// evalAt(tMs) → { d:[a,b,c] 天线系单位方向, on:bool, val:number|null(dB) }，算不出来给 null。
//   d 必须是【天线系】的方向余弦（不是 ECEF）：指向自己在转的时候，只有天线系里的角位移才是真的相对运动。
//   val 是判据用的那个量（绝对 Dir 或相对峰值 Dir，由调用方定），峰值与均值都按它取。
// 返回 { windows:[{startMs,endMs,peakMs,peakVal,minOff,meanVal,truncStart,truncEnd}], samples, budgetHit, minStepHit }
//   truncStart/truncEnd — 该端点不是真实穿越，而是撞上了时窗端点（或星历断档）。
export function scanWindows(evalAt, t0Ms, t1Ms, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const stepMin = Math.max(50, o.stepMinSec * 1000)
  const stepMax = Math.max(stepMin, o.stepMaxSec * 1000)
  const tEnd = Math.max(t0Ms, t1Ms)
  const windows = []
  let samples = 0, budgetHit = false, minStepHit = false
  const ev = (t) => { samples++; return evalAt(t) }
  const left = () => o.maxSamples - samples

  // ---- 边界二分：对布尔 on 二分（a 端状态 = aOn），返回穿越时刻 ----
  const bisect = (a, b, aOn) => {
    let lo = a, hi = b
    for (let i = 0; i < o.edgeIters && left() > 0; i++) {
      const m = (lo + hi) / 2, r = ev(m)
      if (!!(r && r.on) === aOn) lo = m; else hi = m
    }
    return (lo + hi) / 2
  }
  // ---- 窗内峰值：黄金分割（每步只新增 1 次取值），限制在种子 ±seedStep 内 ----
  const refinePeak = (aMs, bMs, seedMs, seedStep, seedVal) => {
    let best = { ms: seedMs, val: seedVal == null ? -Infinity : seedVal }
    const f = (m) => {
      const r = ev(m), v = (r && r.val != null) ? r.val : -Infinity
      if (v > best.val) best = { ms: m, val: v }
      return v
    }
    let lo = Math.max(aMs, seedMs - seedStep), hi = Math.min(bMs, seedMs + seedStep)
    if (hi > lo && left() > 4) {
      let x1 = hi - GR * (hi - lo), x2 = lo + GR * (hi - lo)
      let f1 = f(x1), f2 = f(x2)
      for (let i = 0; i < o.peakIters && (hi - lo) > o.peakTolMs && left() > 2; i++) {
        if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + GR * (hi - lo); f2 = f(x2) }
        else { hi = x2; x2 = x1; f2 = f1; x1 = hi - GR * (hi - lo); f1 = f(x1) }
      }
      f((lo + hi) / 2)
    }
    return best
  }

  // ---- 开窗/合窗：窗内均值按【线性功率】对时间梯形加权（dB 直接平均不是功率平均，会偏低）----
  const openWin = (ms, val, off, trunc) => ({
    startMs: ms, truncStart: trunc, pkMs: ms, pkVal: val == null ? -Infinity : val,
    minOff: off, lastMs: ms, lastPw: val == null ? null : Math.pow(10, val / 10), intPw: 0, intMs: 0
  })
  const accWin = (w, ms, val, off) => {
    if (off != null && (w.minOff == null || off < w.minOff)) w.minOff = off
    if (val != null && val > w.pkVal) { w.pkVal = val; w.pkMs = ms }
    const pw = val == null ? null : Math.pow(10, val / 10)
    if (pw != null && w.lastPw != null && ms > w.lastMs) { w.intPw += (pw + w.lastPw) / 2 * (ms - w.lastMs); w.intMs += ms - w.lastMs }
    w.lastMs = ms; w.lastPw = pw
  }
  const closeWin = (w, endMs, trunc, stepMs) => {
    // 边界那一段：门限已知时按门限值补上（窗口两端的值就是门限），否则跳过——宁可少算一段也不虚报
    if (o.thrDb != null && w.lastPw != null && endMs > w.lastMs) {
      const pw = Math.pow(10, o.thrDb / 10)
      w.intPw += (pw + w.lastPw) / 2 * (endMs - w.lastMs); w.intMs += endMs - w.lastMs
    }
    const pk = (w.pkVal > -Infinity) ? refinePeak(w.startMs, endMs, w.pkMs, Math.max(stepMs, stepMin), w.pkVal) : { ms: w.pkMs, val: null }
    windows.push({
      startMs: w.startMs, endMs, durMin: (endMs - w.startMs) / 60000,
      peakMs: pk.ms, peakVal: (pk.val === -Infinity ? null : pk.val),
      minOff: w.minOff, meanVal: w.intMs > 0 ? 10 * Math.log10(w.intPw / w.intMs) : (pk.val === -Infinity ? null : pk.val),
      truncStart: !!w.truncStart, truncEnd: !!trunc
    })
  }

  let prev = ev(t0Ms)
  if (!prev) {   // 起点就算不出来（星历断档）：往前找到第一个能算的时刻再起扫
    let t = t0Ms
    while (t < tEnd && !prev && left() > 0) { t = Math.min(t + stepMax, tEnd); prev = ev(t) }
    if (!prev) return { windows, samples, budgetHit: left() <= 0, minStepHit: false }
    t0Ms = t
  }
  let t = t0Ms
  let open = prev.on ? openWin(t0Ms, prev.val, offAxisOf(prev.d), true) : null
  let omega = 0, lastDt = stepMin

  while (t < tEnd) {
    if (left() <= 0) { budgetHit = true; break }
    // 允许角位移：域内取细步；域外按「到域边界还有多远」放大（球面追踪，走一半保守）
    const off = offAxisOf(prev.d)
    const allow = Math.max(o.angStepDeg, 0.5 * Math.max(0, off - o.domRadDeg))
    let step = omega > 0 ? (allow / omega) * 1000 : stepMin
    step = Math.min(Math.max(step, stepMin), stepMax, lastDt * 4)   // 单步最多放大 4 倍，防 ω 抖动导致乱跳
    let tn = Math.min(t + step, tEnd)
    let cur = ev(tn)
    // 迈大了退回重走（近距离掠过时 ω 一步之内能翻好几倍）。缩到步长下限还压不住角位移，说明这次扫描
    // 的角分辨率没达标（可能漏窗）→ 记 minStepHit 如实上报。首步 ω 未知本就取下限，不算数。
    for (let k = 0; k < 6 && cur && left() > 0; k++) {
      const dp = angBetween(prev.d, cur.d)
      if (dp <= 2 * allow) break
      if ((tn - t) <= stepMin * 1.001) { minStepHit = true; break }
      step = Math.max(stepMin, step * (allow / dp) * 0.9)
      tn = Math.min(t + step, tEnd)
      cur = ev(tn)
    }

    if (!cur) {   // 星历断档：当场合窗（端点标截断），跳到下一个能算的时刻重新起扫
      if (open) { closeWin(open, t, true, lastDt); open = null }
      let tt = tn
      prev = null
      while (tt < tEnd && !prev && left() > 0) { prev = ev(tt); if (!prev) tt = Math.min(tt + stepMax, tEnd) }
      if (!prev) { budgetHit = left() <= 0; break }
      t = tt; omega = 0; lastDt = stepMin
      if (prev.on) open = openWin(t, prev.val, offAxisOf(prev.d), true)
      continue
    }

    const dt = tn - t
    omega = dt > 0 ? angBetween(prev.d, cur.d) / (dt / 1000) : omega
    const curOff = offAxisOf(cur.d)
    if (cur.on && !prev.on) {
      const s0 = bisect(t, tn, false)
      open = openWin(s0, null, null, false)
      accWin(open, tn, cur.val, curOff)
    } else if (cur.on && prev.on) {
      if (!open) open = openWin(t, prev.val, off, true)   // 兜底：状态说在窗内却没有窗对象
      accWin(open, tn, cur.val, curOff)
    } else if (!cur.on && prev.on && open) {
      closeWin(open, bisect(t, tn, true), false, dt)
      open = null
    }
    prev = cur; t = tn; lastDt = dt
  }
  if (open) closeWin(open, Math.min(t, tEnd), true, lastDt)
  return { windows, samples, budgetHit, minStepHit }
}

// 一颗目标星的窗口集 → 汇总统计。空档（gap）含时窗首尾：时窗开头/末尾没被照到也算一段中断，
// 与可见性分析 timeCoverage 同口径（那边的注释里写了为什么——否则「首尾各差 10 分钟」会被算成 0 空档）。
export function summarize(windows, t0Ms, t1Ms) {
  const H = Math.max(0, t1Ms - t0Ms)
  const ws = (windows || []).slice().sort((a, b) => a.startMs - b.startMs)
  let tot = 0, maxW = 0, minW = Infinity, maxGap = 0, gaps = 0, cur = t0Ms
  let pkVal = null, pkMs = null
  for (const w of ws) {
    const a = Math.max(t0Ms, w.startMs), b = Math.min(t1Ms, w.endMs)
    if (b <= a) continue
    if (a > cur) { const g = a - cur; if (g > maxGap) maxGap = g; gaps++ }
    tot += b - a
    if (b - a > maxW) maxW = b - a
    if (b - a < minW) minW = b - a
    if (w.peakVal != null && (pkVal == null || w.peakVal > pkVal)) { pkVal = w.peakVal; pkMs = w.peakMs }
    if (b > cur) cur = b
  }
  if (cur < t1Ms) { const g = t1Ms - cur; if (g > maxGap) maxGap = g; gaps++ }
  return {
    nWin: ws.length,
    totMin: tot / 60000, pct: H > 0 ? tot / H * 100 : 0,
    maxWinMin: maxW / 60000, minWinMin: minW === Infinity ? 0 : minW / 60000,
    avgWinMin: ws.length ? tot / 60000 / ws.length : 0,
    maxGapMin: maxGap / 60000, gapCount: gaps,
    firstMs: ws.length ? ws[0].startMs : null,
    peakVal: pkVal, peakMs: pkMs
  }
}
