// 视频导出 · 变速：纯计算（不碰 Vue / DOM）—— node 直接测（packages/core/test/videoRamp.test.mjs）。
//
// 两条时间轴分开管：
//   视频时间 u ∈ [0, 1]：成片从第一帧到最后一帧（第 k 帧 u = k / (N − 1)）。
//   仿真时间 t = t0 + (t1 − t0)·F(u)：变速就是这条 F（时间重映射，After Effects Time Remap / STK Movie Timeline 的变速同一回事）。
//     F 单调不减、F(运动段首) = 0、F(运动段尾) = 1 —— 首尾帧仍精确落在起止时刻上；停留段里 F 恒定（时间冻住）。
//
//   速度剖面 g(v) = R^(L(v) − 1)：L ∈ [0, 1] 是速度档位（1 = 最快、0 = 最慢），R = 变速比（最快 / 最慢）。
//   档位在对数速度上走五次平滑阶跃（C²），倍速跨两三个数量级（×60 → ×6000）也是匀着加速，不是一下跳上去。
//   平均倍速仍是「节奏」那一栏推出来的 S / D：剖面只决定怎么分配，不改总时长 —— 节奏三角关系一字不动。

import { computePace, MAX_FRAMES } from './videoPlan.js'

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v)
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

export const RAMP_SHAPES = ['none', 'in', 'out', 'inout']
export const RAMP_RATIO_MAX = 1000
export function defaultRamp() { return { shape: 'none', ratio: 10, trans: 0.5, hold0: 0, hold1: 0 } }
/** 存档 / 面板值 → 规整的变速设置（坏值落回出厂） */
export function normRamp(r) {
  const d = defaultRamp(), o = r && typeof r === 'object' ? r : {}
  return {
    shape: RAMP_SHAPES.includes(o.shape) ? o.shape : d.shape,
    ratio: clamp(num(o.ratio, d.ratio), 1, RAMP_RATIO_MAX),
    trans: clamp(num(o.trans, d.trans), 0.05, 1),
    hold0: clamp(num(o.hold0, 0), 0, 3600),
    hold1: clamp(num(o.hold1, 0), 0, 3600)
  }
}
/** 五次平滑阶跃（smootherstep）：0 → 1，端点一、二阶导都为 0 */
export const smoother = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10))
/**
 * 速度档位 L(v) ∈ [0, 1]（1 = 最快、0 = 最慢），v = 运动段内的归一化视频时间。trans = 过渡占运动段的比例：
 *   in    渐快：开头慢，在前 trans 内升到最快
 *   out   渐慢：末尾 trans 内降到最慢
 *   inout 两端慢：首尾各 trans/2 的升降，中间最快（trans = 1 时没有平台，钟形）
 */
export function rampLevel(shape, trans, v) {
  const p = clamp(num(trans, 0.5), 0.05, 1)
  if (shape === 'in') return smoother(v / p)
  if (shape === 'out') return smoother((1 - v) / p)
  if (shape === 'inout') return Math.min(smoother(v / (p / 2)), smoother((1 - v) / (p / 2)))
  return 1
}
/**
 * 变速剖面 → 时间重映射。返回 { flat, g(v) 相对最快的速度, Z = ∫g, F(v) ∈ [0,1], inv(f) → v, gMin, gMax }。
 * F 用 2048 格累积 Simpson + 逐格三次 Hermite（端点导数取 g 真值）：误差 O(h⁴)，30 天时段也只差到毫秒以下
 */
export function buildTimeMap(ramp) {
  const r = normRamp(ramp)
  const lnR = Math.log(r.ratio)
  if (r.shape === 'none' || lnR < 1e-9) {
    return { flat: true, g: () => 1, Z: 1, F: clamp01, inv: clamp01, gMin: 1, gMax: 1 }
  }
  const g = (v) => Math.exp(lnR * (rampLevel(r.shape, r.trans, v) - 1))
  const M = 2048, h = 1 / M
  const G = new Float64Array(M + 1), gv = new Float64Array(M + 1)
  for (let j = 0; j <= M; j++) gv[j] = g(j * h)
  for (let j = 0; j < M; j++) G[j + 1] = G[j] + h / 6 * (gv[j] + 4 * g((j + 0.5) * h) + gv[j + 1])
  const Z = G[M]
  const cum = (v) => {
    if (!(v > 0)) return 0
    if (v >= 1) return Z
    const x = v * M, j = Math.min(M - 1, Math.floor(x)), s = x - j
    const s2 = s * s, s3 = s2 * s
    return (2 * s3 - 3 * s2 + 1) * G[j] + (s3 - 2 * s2 + s) * gv[j] * h + (3 * s2 - 2 * s3) * G[j + 1] + (s3 - s2) * gv[j + 1] * h
  }
  const F = (v) => clamp01(cum(v) / Z)
  // 反解：先在累积表上二分到格，再在格内牛顿（导数 = g/Z > 0，几步收敛）
  const inv = (f) => {
    if (!(f > 0)) return 0
    if (f >= 1) return 1
    const y = f * Z
    let lo = 0, hi = M
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (G[mid] <= y) lo = mid; else hi = mid }
    let v = (lo + (y - G[lo]) / Math.max(1e-300, G[hi] - G[lo])) * h
    for (let i = 0; i < 4; i++) v = clamp(v - (cum(v) - y) / g(v), lo * h, hi * h)
    return v
  }
  return { flat: false, g, Z, F, inv, gMin: Math.exp(-lnR), gMax: 1 }
}

/**
 * 成片时间轴：节奏（帧数 / 平均倍速）+ 变速 + 起止停留 → 逐帧的仿真时刻比例与瞬时倍速。
 *   spanSec 仿真时段（秒）；pace = { mode, speed, durationSec, stepSec }（同 computePace）；ramp 见 normRamp。
 *   停留按帧数加在运动段前后（倍速 / 步长两档成片随之变长；「视频时长」档时长含停留，运动段 = 时长 − 停留）。
 * 返回 { ok, tooMany, frames, moveFrames, hold0, hold1, durationSec, speed（运动段平均倍速）, stepSec（平均每帧步长）,
 *        speedMin, speedMax, ramped, tm, at(k) / atU(u) → { frac, speed }, uOfFrac(frac, uHint) }
 */
export function planTimeline(spanSec, fps, pace, ramp) {
  const r = normRamp(ramp)
  const Fp = Number(fps), S = Number(spanSec)
  const bad = { ok: false, tooMany: false, frames: 0, moveFrames: 0, hold0: 0, hold1: 0, durationSec: 0, speed: 0, stepSec: 0, speedMin: 0, speedMax: 0, ramped: false }
  if (!(Fp > 0) || !pace) return withFns(bad, null)
  const h0 = Math.round(r.hold0 * Fp), h1 = Math.round(r.hold1 * Fp)
  const p = pace.mode === 'duration' ? { ...pace, durationSec: Number(pace.durationSec) - (h0 + h1) / Fp } : pace
  const mv = computePace(S, Fp, p)
  if (!mv.ok || !(mv.frames >= 1)) return withFns(bad, null)
  let Nm = mv.frames, tooMany = !!mv.tooMany
  if (Nm + h0 + h1 > MAX_FRAMES) { tooMany = true; Nm = Math.max(1, MAX_FRAMES - h0 - h1) }
  const N = Nm + h0 + h1
  const tm = buildTimeMap(r)
  const moving = Nm > 1 && S > 0
  const avg = moving ? S * Fp / (Nm - 1) : 0
  const out = {
    ok: true, tooMany, frames: N, moveFrames: Nm, hold0: h0, hold1: h1,
    durationSec: N > 1 ? (N - 1) / Fp : 0,
    speed: avg, stepSec: avg / Fp,
    speedMin: moving ? avg * tm.gMin / tm.Z : 0, speedMax: moving ? avg * tm.gMax / tm.Z : 0,
    ramped: moving && !tm.flat
  }
  return withFns(out, tm)
}
// 时间轴的逐帧取值：x = 帧坐标（0 … N−1，可为小数）
function withFns(P, tm) {
  const N = P.frames, h0 = P.hold0, Nm = P.moveFrames, moving = P.speed > 0
  const atX = (x) => {
    if (!tm || !(N > 1) || !moving) return { frac: 0, speed: 0 }   // 没有运动段（起止重合 / 只有一帧）：整片定格在起始时刻
    if (x <= h0) return { frac: 0, speed: x < h0 ? 0 : P.speed * tm.g(0) / tm.Z }
    const j = x - h0
    if (j >= Nm - 1) return { frac: 1, speed: j > Nm - 1 ? 0 : P.speed * tm.g(1) / tm.Z }
    const v = j / (Nm - 1)
    return { frac: tm.F(v), speed: P.speed * tm.g(v) / tm.Z }
  }
  P.tm = tm
  P.at = (k) => atX(k)
  P.atU = (u) => atX(clamp01(num(u, 0)) * Math.max(0, N - 1))
  // 仿真时刻比例 → 视频时间 u（屏上预览按时钟此刻取瞬时倍速用）。停留段里一个时刻对应一整段 u：落在 uHint 所在那段就留在原地
  P.uOfFrac = (frac, uHint) => {
    if (!tm || !(N > 1)) return 0
    const f = clamp01(num(frac, 0))
    const x = (v) => (h0 + v * Math.max(0, Nm - 1)) / (N - 1)
    if (Number.isFinite(uHint)) {
      const xh = uHint * (N - 1)
      if (f <= 0 && xh <= h0) return uHint
      if (f >= 1 && xh >= h0 + Nm - 1) return uHint
    }
    if (!(Nm > 1)) return x(0)
    return x(tm.inv(f))
  }
  return P
}
