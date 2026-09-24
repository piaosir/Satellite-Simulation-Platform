// 日凌核二期追加（sunOutageCalculator.js：sunNoiseTemp / sunEcefAt / sunDiamDegAt / earthBlockFraction / satSunIntrusionSeries）。
//
// 逐位对拍的真值取自日凌核【自己的内部函数】：把 sunOutageCalculator.js 的源码原样载入一个新函数作用域，末尾只多一行把
// degradationAt / outageModel / daySun / deltaT / solarPosition 挂出来——跑的是同一份文本，不是测试里另抄的公式。
//   ① 地面日凌口径：sunNoiseTemp 的 ΔT 与 C/N 恶化 与 degradationAt 路径同输入逐位一致（norp / legacy、多频多口径多日）
//   ② sunEcefAt ≡ daySun(dayJD, deltaT(year)).dir(sec)；sunDiamDegAt ≡ calculateSunOutage 逐日的 2·(0.26656 / R_正午)
//   ③ earthBlockFraction ≡ 1 − attitude.eclipseFactor（D13 同式的 CJS 镜像，< 1e-12）
//   ④ GEO 全球波束：太阳在地球背后 → ΔT = 0；半遮挡按弓形比例（对数值积分）
//   ⑤ 实测增益档（小源近似）与高斯档在小源极限一致；星侧批量的最坏值与预筛

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { eclipseFactor, sunEcefApprox, sunDistanceAu, gmstRadAt } from '../models/attitude.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.resolve(here, '../utils/sunOutageCalculator.js')
const require = createRequire(import.meta.url)
const so = require(FILE)
const core = require(path.resolve(here, '..'))

// 原样载入 + 挂出内部函数
const src = fs.readFileSync(FILE, 'utf8')
const box = { exports: {} }
new Function('require', 'module', 'exports', '__filename', '__dirname',
  src + '\n;module.exports.__internal = { degradationAt: degradationAt, outageModel: outageModel, daySun: daySun, deltaT: deltaT, solarPosition: solarPosition };')(createRequire(FILE), box, box.exports, FILE, path.dirname(FILE))
const I = box.exports.__internal

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const same = (a, b, msg) => assert.ok(Object.is(a, b), `${msg}：${a} vs ${b}`)
const D2R = Math.PI / 180, DAY = 86400000
let seed = 8675309
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

// 与 calculateSunOutage 同一套日界：UT 0h 的儒略日、deltaT(整年)、正午 JDE
function dayCtx(utcMs) {
  const d0 = Math.floor(utcMs / DAY) * DAY, dayJD = d0 / DAY + 2440587.5, year = new Date(d0).getUTCFullYear(), dT = I.deltaT(year)
  const sunRad = 0.26656 / I.solarPosition(dayJD + 0.5 + dT / 86400).R
  return { d0, dayJD, dT, sunRad }
}

t('导出：日凌核与 core 出口都有六个新函数；原有导出一个不少', () => {
  for (const k of ['sunNoiseTemp', 'sunEcefAt', 'sunDiamDegAt', 'sunDistAuAt', 'earthBlockFraction', 'satSunIntrusionSeries']) {
    assert.equal(typeof so[k], 'function', k); assert.equal(core[k], so[k], `core.${k}`)
  }
  for (const k of ['calculateSunOutage', 'calculateSunOutageSeasons', 'BAND_PARAMS', 'solarTempAt', 'solarFluxAt', 'solarTempLegacy', 'equinoxDateOf', 'couplingAt']) assert.ok(so[k], k)
})

t('① 地面日凌口径：sunNoiseTemp 与 degradationAt / outageModel 同输入逐位一致（norp / legacy × 4 频 × 5 口径 × 6 日 × 13 偏轴角）', () => {
  let cnt = 0
  const days = [Date.UTC(2025, 2, 3), Date.UTC(2025, 8, 20), Date.UTC(2026, 1, 25), Date.UTC(2026, 9, 12), Date.UTC(2027, 2, 29), Date.UTC(2027, 8, 30)]
  for (const model of ['norp', 'legacy']) for (const f of [3.95, 11.75, 19.45, 40]) for (const D of [0.6, 1.2, 2.4, 4.5, 9]) for (const day of days) {
    const { sunRad } = dayCtx(day)
    const f107 = 70 + rnd() * 150, sys = 60 + rnd() * 300
    const Tb = so.solarTempAt(f, f107, 2 * sunRad, model)
    const M = I.outageModel(f, D, sys, Tb, 1.0, sunRad, 'degradation')
    for (const sep of [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 1.7, 2.5, 4, 7]) {
      const ref = I.degradationAt(sep, M, sys)
      const tMs = day + Math.floor(rnd() * DAY)
      const a = so.sunNoiseTemp({ freqGHz: f, diameterM: D, offAxisDeg: sep, utcMs: tMs, f107, solarModel: model, sysTempK: sys })
      same(a.gtLossDb, ref, `${model} f=${f} D=${D} sep=${sep}`)
      same(a.thetaB, M.thetaB, 'θB'); same(a.thetaD, M.thetaD, 'θd'); same(a.Tb, M.Tb, 'Tb')
      same(a.dT, M.Tb * so.couplingAt(sep, M.thetaB, M.thetaD), 'ΔT')
      if (sep === 0) same(a.dT, M.dTmax, 'ΔT_max')
      const b = so.sunNoiseTemp({ freqGHz: f, thetaB3dBDeg: M.thetaB, offAxisDeg: -sep, sunDiamDeg: M.thetaD, f107, solarModel: model, sysTempK: sys })
      same(b.gtLossDb, ref, '给 θB / θd 的写法')
      cnt++
    }
  }
  console.log(`  ${cnt} 组逐位一致`)
})

t('① solarTemp 覆盖、缺省 F10.7 = 120、没给 sysTempK 不出 G/T、坏输入返回 null', () => {
  const r = so.sunNoiseTemp({ freqGHz: 12, diameterM: 1.2, offAxisDeg: 0.1, sunDiamDeg: 0.533, solarTemp: 12000 })
  assert.equal(r.Tb, 12000); assert.equal(r.gtLossDb, null); assert.equal(r.f107, 120); assert.equal(r.solarModel, 'norp'); assert.equal(r.mode, 'gauss')
  assert.equal(so.sunNoiseTemp({ freqGHz: 0, diameterM: 1 }), null)
  assert.equal(so.sunNoiseTemp({ freqGHz: 12, offAxisDeg: 0 }), null, '没方向图')
  assert.equal(so.sunNoiseTemp({ freqGHz: 12, diameterM: 1, offAxisDeg: NaN }), null)
  near(so.sunNoiseTemp({ freqGHz: 12, diameterM: 1, offAxisDeg: 0 }).thetaD, 2 * 0.26656, 0, '无日期 → 1 AU 视直径')
})

t('② sunEcefAt ≡ daySun(dayJD, deltaT(year)).dir(sec)（2000 个随机时刻逐位）；sunDiamDegAt ≡ 2·(0.26656 / R_正午)', () => {
  const out = [0, 0, 0]
  for (let k = 0; k < 2000; k++) {
    const ms = Math.round(Date.UTC(2024, 0, 1) + rnd() * 4 * 365.25 * DAY) + (k % 3 === 0 ? 0.5 : 0)
    const c = dayCtx(ms)
    const ref = I.daySun(c.dayJD, c.dT).dir((ms - c.d0) / 1000)
    const s = so.sunEcefAt(ms, out)
    assert.equal(s, out)
    for (let i = 0; i < 3; i++) same(s[i], ref[i], `t=${ms}[${i}]`)
    same(so.sunDiamDegAt(ms), 2 * c.sunRad, `视直径 ${ms}`)
  }
})

// 两份解差在两处，拆开单独量（混在一起没法给出按式子算的容差）：
//   (a) 视黄经本身：Meeus 第 25 章低精度解标称 0.01°——把渲染端的恒星时换成与 VSOP87 路径同一个 GAST 后比方向；
//   (b) 恒星时：sunEcefApprox 与 terminator.js 一样用 GMST（与画面晨昏线同源，刻意不改），VSOP87 路径用
//       GAST = GMST + Δψ·cos ε。绕极轴差 e 角时单位矢量移动 2·cos δ·sin(e/2) ≤ |e|，所以原始差 ≤ (a) + |Δψ cos ε|（逐样本）。
//   日地距离：Meeus 式 25.5 是二体椭圆，不含月球（地月质心 ≈ 4671 km ≈ 3.1e-5 AU）与金星 / 木星摄动（各 ~1–3e-5 AU），
//   容差取三项之和 1e-4 AU；它只进功率的 1/R² 修正，2·1e-4 = 0.02 % 功率。
t('② 与渲染端 Meeus 低精度解（attitude.sunEcefApprox / sunDistanceAu）互验：同 GAST 方向差 < 0.01°；原始差 ≤ 上式 + |Δψ cos ε|；日地距离差 < 1e-4 AU', () => {
  let wa = 0, wc = 0, wn = 0, slack = -Infinity, wr = 0
  for (let k = 0; k < 3000; k++) {
    const ms = Math.round(Date.UTC(2020, 0, 1) + rnd() * 12 * 365.25 * DAY)
    const c = dayCtx(ms)
    const p = I.solarPosition(c.dayJD + c.dT / 86400)
    const eqeq = p.dpsi * Math.cos(p.eps0 * D2R)                       // 度，与 daySun 的 nut 同式
    const a = so.sunEcefAt(ms), b = sunEcefApprox(ms), g = sunEcefApprox(ms, [0, 0, 0], gmstRadAt(ms) + eqeq * D2R)
    const ang = (u, v) => Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])) / D2R
    const raw = ang(a, b), cor = ang(a, g)
    wa = Math.max(wa, raw); wc = Math.max(wc, cor); wn = Math.max(wn, Math.abs(eqeq))
    slack = Math.max(slack, raw - (cor + Math.abs(eqeq)) - 1e-9)
    const noon = Math.floor(ms / DAY) * DAY + DAY / 2
    wr = Math.max(wr, Math.abs(so.sunDistAuAt(ms) - sunDistanceAu(noon)))
  }
  assert.ok(wc < 0.01, `同 GAST 方向 ${wc}°`)
  assert.ok(slack <= 0, `原始差超出 (a) + |Δψ cos ε|：${slack}°`)
  assert.ok(wr < 1e-4, `距离 ${wr}`)
  console.log(`  VSOP87 vs Meeus 低精度：同 GAST 方向最差 ${(wc * 3600).toFixed(1)}″、GMST 原始最差 ${(wa * 3600).toFixed(1)}″（|Δψ cos ε| 最大 ${(wn * 3600).toFixed(1)}″）、日地距离最差 ${wr.toExponential(2)} AU`)
})

t('③ earthBlockFraction ≡ 1 − eclipseFactor（同一太阳距离；3000 组含半影 / 本影 / 全日照，< 1e-12）；环食与地内', () => {
  let worst = 0, partial = 0
  for (let k = 0; k < 3000; k++) {
    const rr = 6371 + 200 + rnd() * 40000
    const u = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1], ul = Math.hypot(...u)
    const r = u.map((x) => x / ul * rr)
    // 太阳方向：一半随机、一半贴着地影锥边缘（造半影）
    let s
    if (k % 2) { const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1], l = Math.hypot(...v); s = v.map((x) => x / l) }
    else {
      const b = Math.asin(6371 / rr), c = b + (rnd() * 2 - 1) * 0.006
      const m = r.map((x) => -x / rr), p0 = [m[1], -m[0], 0], pl = Math.hypot(...p0) || 1, p = p0.map((x) => x / pl)
      s = m.map((x, i) => Math.cos(c) * x + Math.sin(c) * p[i])
    }
    const diam = 0.52 + rnd() * 0.025
    const dist = 695700 / Math.sin(diam / 2 * D2R)
    const eb = so.earthBlockFraction(r, s, diam)
    const ef = eclipseFactor(r, s, { sunDistKm: dist })
    worst = Math.max(worst, Math.abs(eb - (1 - ef)))
    if (eb > 0 && eb < 1) partial++
  }
  assert.ok(worst < 1e-12, `最差 ${worst}`)
  assert.ok(partial > 500, `半影样本 ${partial}`)
  assert.equal(so.earthBlockFraction([100, 0, 0], [1, 0, 0], 0.533), 1, '地内')
  // 环食：把地球缩小到角半径小于日面
  const ann = so.earthBlockFraction([42164, 0, 0], [-1, 0, 0], 0.533, { earthRadiusKm: 100 })
  const a = Math.asin(695700 / (695700 / Math.sin(0.2665 * D2R) + 42164)), b = Math.asin(100 / 42164)
  near(ann, (b * b) / (a * a), 1e-12, '环食 = b²/a²')
  console.log(`  earthBlockFraction vs 1 − eclipseFactor 最差 ${worst.toExponential(2)}（半影样本 ${partial}）`)
})

t('④ GEO 全球波束（17.4°）：太阳在地球背后 → ΔT = 0；同偏轴角不遮挡时 ΔT > 0', () => {
  const r = [42164.17, 0, 0], sBehind = [-1, 0, 0]
  const blocked = so.earthBlockFraction(r, sBehind, 0.533)
  assert.equal(blocked, 1)
  const off = 0                                                     // 视轴对地心，太阳恰在正后方
  const hidden = so.sunNoiseTemp({ freqGHz: 4, thetaB3dBDeg: 17.4, offAxisDeg: off, sunDiamDeg: 0.533, visibleFrac: 1 - blocked, sysTempK: 500 })
  assert.equal(hidden.dT, 0); assert.equal(hidden.gtLossDb, 0)
  const open = so.sunNoiseTemp({ freqGHz: 4, thetaB3dBDeg: 17.4, offAxisDeg: off, sunDiamDeg: 0.533, sysTempK: 500 })
  assert.ok(open.dT > 5, `不遮挡时 ${open.dT} K`)
  console.log(`  全球波束 C 频段：不遮挡 ΔT = ${open.dT.toFixed(1)} K / ${open.gtLossDb.toFixed(3)} dB，遮挡后 0`)
})

t('④ 半遮挡按弓形比例：日面中心恰在地球边缘，遮挡比例对数值积分（平面圆盘近似同口径，< 2e-3）；ΔT 按比例缩放（逐位）', () => {
  const rr = 42164.17, r = [rr, 0, 0], b = Math.asin(6371 / rr)
  const diam = 0.533
  const dist = 695700 / Math.sin(diam / 2 * D2R)
  // 从【卫星】看日面中心恰在地球边缘上：卫星 → 太阳方向 u 与 −r 夹 b；再解 |r + λu| = dist 得地心太阳方向 s。
  //   （直接把地心方向放在 b 上不对：GEO 处视差 ≈ 42164/1.5e8 rad ≈ 0.016°，日面中心会落进地盘里侧、遮挡 > 1/2。）
  const u = [-Math.cos(b), Math.sin(b), 0], ru = r[0] * u[0]
  const lam = -ru + Math.sqrt(ru * ru - rr * rr + dist * dist)
  const P = r.map((x, i) => x + lam * u[i]), Pl = Math.hypot(...P), s = P.map((x) => x / Pl)
  const eb = so.earthBlockFraction(r, s, diam, { sunDistKm: dist })
  // 数值积分：在卫星处的角平面里铺日面网格，数落在地球圆盘内的点
  const tv = s.map((x, i) => x * dist - r[i]), tl = Math.hypot(...tv), tu = tv.map((x) => x / tl)
  const a = Math.asin(695700 / tl), c = Math.acos(Math.max(-1, Math.min(1, -(tu[0] * r[0] + tu[1] * r[1] + tu[2] * r[2]) / rr)))
  let inside = 0, total = 0
  const N = 1500
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1
    if (x * x + y * y > 1) continue
    total++
    const px = x * a, py = y * a                                 // 日面中心为原点；地心在 (c, 0)
    if ((px - c) ** 2 + py ** 2 <= b * b) inside++
  }
  near(eb, inside / total, 2e-3, '弓形比例')
  // 地盘是凸的、角半径 b ≈ 8.7° ≫ a ≈ 0.27°：日面中心在边缘上时，被遮部分 ⊂ 切线那一侧的半个日面，少掉的是切线与地盘边之间的
  //   一条月牙：横向偏 y 处宽 ≈ y²/(2b)，面积 ≈ ∫₋ₐᵃ y²/(2b) dy = a³/(3b)，占日面 a/(3πb)。下一阶是它的 (a/b)² 倍（~1e-3），
  //   所以按 0.5 − a/(3πb) 核到 1e-5。
  const aS = Math.asin(695700 / tl)
  assert.ok(eb < 0.5, `边缘遮挡必须 < 1/2：${eb}`)
  near(eb, 0.5 - aS / (3 * Math.PI * b), 1e-5, '月牙亏量 a/(3πb)')
  const full = so.sunNoiseTemp({ freqGHz: 12, diameterM: 1.2, offAxisDeg: 0.05, sunDiamDeg: diam, sysTempK: 300 })
  const half = so.sunNoiseTemp({ freqGHz: 12, diameterM: 1.2, offAxisDeg: 0.05, sunDiamDeg: diam, sysTempK: 300, visibleFrac: 1 - eb })
  same(half.dT, full.dT * (1 - eb), 'ΔT × 可见比例')
  console.log(`  日面中心在地球边缘：遮挡 ${eb.toFixed(5)}（积分 ${(inside / total).toFixed(5)}、0.5 − a/(3πb) = ${(0.5 - Math.asin(695700 / tl) / (3 * Math.PI * b)).toFixed(5)}）`)
})

// 小源近似 K_gain = Ω☉·G/(4π)；G 取高斯主瓣峰值 16·ln2/θB² 时 K_gain = x，x = ln2·(θd/θB)²；
// 高斯档轴上 K = 1 − e^(−x)（couplingAt 的 θ=0 闭式）。所以两档之比恰为 x / (1 − e^(−x)) ≈ 1 + x/2——
// 这是小源近似本身的偏差（θB = 3° 时 +1.1 %，17.4° 时 +0.03 %），按式子逐项核对，不拍容差。
t('⑤ 实测增益档（小源近似）：G = 高斯主瓣峰值增益 16·ln2/θB² 时与高斯档轴上之比 = x/(1 − e^(−x))，x = ln2·(θd/θB)²', () => {
  const rows = []
  for (const thB of [0.8, 3, 5, 17.4]) {
    const th = thB * D2R, G = 16 * Math.LN2 / (th * th)
    const g = so.sunNoiseTemp({ freqGHz: 12, gainDbi: 10 * Math.log10(G), offAxisDeg: 0, sunDiamDeg: 0.533, solarTemp: 10000 })
    const h = so.sunNoiseTemp({ freqGHz: 12, thetaB3dBDeg: thB, offAxisDeg: 0, sunDiamDeg: 0.533, solarTemp: 10000 })
    assert.equal(g.mode, 'gain'); assert.equal(g.thetaB, null); assert.equal(h.mode, 'gauss')
    const x = Math.LN2 * (0.533 / thB) ** 2
    near(g.dT / h.dT, x / -Math.expm1(-x), 1e-12, `θB=${thB}`)
    rows.push(`θB=${thB}° ${((g.dT / h.dT - 1) * 100).toFixed(3)} %`)
  }
  console.log(`  小源近似偏差：${rows.join('、')}`)
})

t('⑤ satSunIntrusionSeries：GEO 可动波束对着太阳扫过——最坏值在视轴最近太阳处；夜里太阳在地球背后记 0；预筛远处记 0；增益回调取不到退回高斯', () => {
  const r = [42164.17 * Math.cos(105.5 * D2R), 42164.17 * Math.sin(105.5 * D2R), 0]
  const t0 = Date.UTC(2026, 2, 20, 0, 0, 0)
  const N = 24 * 60, S = new Float64Array(N * 10)
  const target = Date.UTC(2026, 2, 20, 4, 30, 0)                   // 视轴固定指向这一刻的太阳方向
  const s0 = so.sunEcefAt(target), dist0 = so.sunDistAuAt(target) * 1.495978707e8
  const bv = s0.map((x, i) => x * dist0 - r[i]), bl = Math.hypot(...bv), bore = bv.map((x) => x / bl)
  for (let i = 0; i < N; i++) S.set([t0 + i * 60000, r[0], r[1], r[2], bore[0], bore[1], bore[2], 0, 0, 1], i * 10)
  const res = so.satSunIntrusionSeries({ samples: S, freqGHz: 14.25, pattern: { kind: 'diameter', diameterM: 1.2 }, sysTempK: 500, f107: 150 })
  assert.equal(res.n, N)
  assert.equal(res.worst.tMs, target, '最坏时刻')
  near(res.worst.offAxisDeg, 0, 1e-6, '最坏时偏轴 0')
  const ref = so.sunNoiseTemp({ freqGHz: 14.25, diameterM: 1.2, offAxisDeg: res.worst.offAxisDeg, utcMs: target, f107: 150, sysTempK: 500 })
  near(res.worst.dT, ref.dT, ref.dT * 1e-9, '最坏 ΔT = 单点')
  near(res.worst.gtLossDb, ref.gtLossDb, 1e-9, '最坏 ΔG/T')
  let zeroFar = 0, eclipsed = 0
  for (let i = 0; i < N; i++) { if (res.offAxisDeg[i] > 6 * ref.thetaB + ref.thetaD) { assert.equal(res.dT[i], 0); zeroFar++ } if (res.visibleFrac[i] === 0) { assert.equal(res.dT[i], 0); eclipsed++ } }
  assert.ok(zeroFar > N * 0.9, '远处预筛为 0')
  assert.ok(eclipsed > 30, `春分午夜前后地影 ${eclipsed} min`)
  assert.equal(res.counts.gauss + res.counts.blocked, N); assert.equal(res.counts.blocked, eclipsed)
  // 增益档：回调取不到 → 整拍退回 fallback 高斯（与口径档逐位同值）
  const rg = so.satSunIntrusionSeries({ samples: S.subarray(270 * 10, 271 * 10), freqGHz: 14.25, sysTempK: 500, f107: 150,
    pattern: { kind: 'gain', gainAt: () => null, fallbackThetaB3dBDeg: ref.thetaB } })
  same(rg.dT[0], res.dT[270], '退回高斯 = 口径档'); assert.deepEqual(rg.counts, { gain: 0, gauss: 1, none: 0, blocked: 0 })
  const rn = so.satSunIntrusionSeries({ samples: S.subarray(270 * 10, 271 * 10), freqGHz: 14.25, sysTempK: 500, pattern: { kind: 'gain', gainAt: () => null } })
  assert.equal(rn.dT[0], 0); assert.equal(rn.counts.none, 1)
  console.log(`  GEO 1.2 m Ku 视轴对日：最坏 ΔT ${res.worst.dT.toFixed(0)} K / ΔG/T ${res.worst.gtLossDb.toFixed(2)} dB @ ${new Date(res.worst.tMs).toISOString()}；地影 ${eclipsed} min`)
})

t('⑤ 增益档在日面上求积（SUN_DISK_RULE 24 点）：高斯方向图回调与高斯档闭式对拍——θB 1.25° 全主瓣 < 1e-4、θB 0.58° 偏轴 ≤ 1° 内 < 2e-3；求积点都在日面内、加权平均方向 = 日面中心；gainLin ≡ gainDbi', () => {
  // 求积规则本身：权和 1、单位圆盘内、对 r² 的 0..5 次矩（圆盘均匀分布：E[u^k] = 1/(k+1)）精确
  const R = so.SUN_DISK_RULE
  assert.equal(R.length, 24)
  near(R.reduce((a, p) => a + p[2], 0), 1, 1e-15, '权和')
  for (let k = 0; k <= 5; k++) near(R.reduce((a, p) => a + p[2] * (p[0] * p[0] + p[1] * p[1]) ** k, 0), 1 / (k + 1), 1e-15, `E[u^${k}]`)
  assert.ok(R.every((p) => Math.hypot(p[0], p[1]) < 1))
  // GEO 105.5°E，视轴钉在 04:30 的太阳方向，逐 10 s 04:20–04:40（太阳相对视轴 0.25°/min，偏轴 0..2.5°）；up = 北（ECEF +Z 去视轴分量）
  const r = [42164.17 * Math.cos(105.5 * D2R), 42164.17 * Math.sin(105.5 * D2R), 0]
  const t0 = Date.UTC(2026, 2, 20, 4, 20, 0), target = Date.UTC(2026, 2, 20, 4, 30, 0), N = 121
  const s0 = so.sunEcefAt(target), dist0 = so.sunDistAuAt(target) * 1.495978707e8
  const bv = s0.map((x, i) => x * dist0 - r[i]), bl = Math.hypot(...bv), bore = bv.map((x) => x / bl)
  const S = new Float64Array(N * 10)
  for (let i = 0; i < N; i++) S.set([t0 + i * 10000, r[0], r[1], r[2], bore[0], bore[1], bore[2], 0, 0, 1], i * 10)
  const rows = []
  for (const [thB, offMax, tol] of [[1.25, 2.5, 1e-4], [0.58, 1, 2e-3]]) {
    const G0 = 16 * Math.LN2 / (thB * D2R) ** 2
    let maxRad = 0
    const dirs = []
    const gauss = (d) => {
      const th = Math.acos(Math.max(-1, Math.min(1, d[2] / Math.hypot(d[0], d[1], d[2])))) / D2R
      if (dirs.length < 24) dirs.push(d.slice())
      return 10 * Math.log10(G0 * Math.exp(-4 * Math.LN2 * th * th / (thB * thB)))
    }
    const g = so.satSunIntrusionSeries({ samples: S, freqGHz: 14.25, sysTempK: 500, f107: 150, pattern: { kind: 'gain', gainAt: gauss } })
    const h = so.satSunIntrusionSeries({ samples: S, freqGHz: 14.25, sysTempK: 500, f107: 150, pattern: { kind: 'gauss', thetaB3dBDeg: thB } })
    assert.equal(g.counts.gain, N)
    let worst = 0, cnt = 0
    for (let i = 0; i < N; i++) if (h.offAxisDeg[i] <= offMax) { worst = Math.max(worst, Math.abs(g.dT[i] / h.dT[i] - 1)); cnt++ }
    assert.ok(cnt > 40, `样本 ${cnt}`)
    assert.ok(worst < tol, `θB=${thB}：求积 vs 闭式 ${worst}`)
    // 第一拍的 24 个方向：单位、都在日面内、加权平均方向 = 日面中心
    const c = so.satSunIntrusionSeries({ samples: S.subarray(0, 10), freqGHz: 14.25, sysTempK: 500, pattern: { kind: 'gain', gainAt: (d) => { dirs.push(d.slice()); return 0 } } })
    const ds = dirs.slice(-24), m = [0, 0, 0]
    ds.forEach((d, k) => { near(Math.hypot(...d), 1, 1e-14, '单位'); for (let j = 0; j < 3; j++) m[j] += R[k][2] * d[j] })
    const ml = Math.hypot(...m), cz = Math.cos(c.offAxisDeg[0] * D2R)
    near(m[2] / ml, cz, 1e-9, '平均方向 = 日面中心（z 分量 = cos 偏轴）')
    for (const d of ds) maxRad = Math.max(maxRad, Math.acos(Math.min(1, (d[0] * m[0] + d[1] * m[1] + d[2] * m[2]) / ml)) / D2R)
    assert.ok(maxRad < so.sunDiamDegAt(t0) / 2, `最外圈 ${maxRad}°`)
    rows.push(`θB=${thB}° 最差 ${worst.toExponential(1)}（${cnt} 拍）`)
  }
  // gainLin 与 gainDbi 两种写法同值
  const a1 = so.sunNoiseTemp({ freqGHz: 12, gainLin: 5000, offAxisDeg: 0, sunDiamDeg: 0.533, solarTemp: 10000 })
  const a2 = so.sunNoiseTemp({ freqGHz: 12, gainDbi: 10 * Math.log10(5000), offAxisDeg: 0, sunDiamDeg: 0.533, solarTemp: 10000 })
  near(a1.dT, a2.dT, a1.dT * 1e-14, 'gainLin ≡ gainDbi')
  assert.equal(so.sunNoiseTemp({ freqGHz: 12, gainLin: 0, offAxisDeg: 0, sunDiamDeg: 0.533, solarTemp: 10000 }).dT, 0)
  console.log(`  日面求积 vs 高斯闭式：${rows.join('、')}`)
})

console.log(`sunNoiseTemp: ${n} 项通过`)
