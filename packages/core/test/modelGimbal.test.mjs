// 万向节可达（packages/core/models/gimbal.mjs）：解算器正反回环、奇点附近用例、限位 / 掩模 / 速率三种不可跟踪原因分别计数；
// 固定天线（type none）按视场算、不当全行程万向节；缺 frame 时按 D1 缺省挂点换算本体系方向与掩模查表。

import assert from 'node:assert/strict'
import {
  GIMBAL_TYPES, REASON, solveAzEl, solveXY, solveGimbal, dirFromAzEl, dirFromXY, dirFromGimbal,
  normalizeGimbal, pickSolution, trackSeries
} from '../models/gimbal.mjs'
import { mountFrame, dirMountToBody } from '../models/attitude.mjs'
import { buildMask, maskLookup } from '../models/mask.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const D2R = Math.PI / 180, R2D = 180 / Math.PI
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angDeg = (a, b) => Math.atan2(Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]), dot(a, b)) * R2D
let seed = 97531
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

t('常量', () => {
  assert.deepEqual([...GIMBAL_TYPES], ['none', 'azel', 'xy'])
  assert.deepEqual({ ...REASON }, { OK: 0, LIMIT: 1, MASK: 2, RATE: 3, NO_TARGET: 4 })
})

t('零位 = 视轴；azel：+x → az 90、+y → el 90（keyhole）；xy：+y → X 90、+x → Y 90（keyhole）', () => {
  assert.deepEqual(dirFromAzEl(0, 0), [0, 0, 1]); assert.deepEqual(dirFromXY(0, 0), [0, 0, 1])
  const a = solveAzEl([1, 0, 0]); near(a.a1, 90, 1e-12, 'az'); near(a.a2, 0, 1e-12, 'el')
  const k = solveAzEl([0, 1, 0], 33); assert.equal(k.singular, true); assert.equal(k.a1, 33); near(k.a2, 90, 1e-12, 'el keyhole')
  const x = solveXY([0, 1, 0]); near(x.a1, 90, 1e-12, 'X'); near(x.a2, 0, 1e-12, 'Y'); assert.equal(x.singular, false)
  const kx = solveXY([-1, 0, 0], -12); assert.equal(kx.singular, true); assert.equal(kx.a1, -12); near(kx.a2, -90, 1e-12, 'Y keyhole')
  // 右手：azel 绕 +y 右手（z → x），xy 的 X 朝 +y 为正
  const d = dirFromAzEl(30, 0); assert.ok(d[0] > 0)
  const d2 = dirFromXY(30, 0); assert.ok(d2[1] > 0)
})

t('正反回环：随机 5000 组（两种座；a2 离奇点 > 0.01°）角度差 < 1e-9°', () => {
  for (const type of ['azel', 'xy']) {
    for (let k = 0; k < 5000; k++) {
      const a1 = rnd() * 359.99 - 179.99, a2 = (rnd() * 2 - 1) * 89.99
      const d = dirFromGimbal(type, a1, a2)
      near(Math.hypot(...d), 1, 1e-15, '单位')
      const s = solveGimbal(type, d)
      near(s.a1, a1, 1e-9, `${type} a1`); near(s.a2, a2, 1e-9, `${type} a2`); assert.equal(s.singular, false)
    }
  }
})

t('奇点附近：离 keyhole 1e-6° ~ 1° 的方向，解出的角回代方向误差 < 1e-9°；恰在奇点取 prevA1', () => {
  for (const type of ['azel', 'xy']) {
    for (const off of [1, 0.1, 1e-3, 1e-6]) {
      for (let k = 0; k < 50; k++) {
        const ph = rnd() * 360
        const a2 = (90 - off) * (rnd() < 0.5 ? 1 : -1), a1 = ph - 180
        const d = dirFromGimbal(type, a1, a2)
        const s = solveGimbal(type, d, 0)
        assert.ok(angDeg(dirFromGimbal(type, s.a1, s.a2), d) < 1e-9, `${type} off=${off}`)
      }
    }
    const pole = type === 'azel' ? [0, -1, 0] : [1, 0, 0]
    const s = solveGimbal(type, pole, 77); assert.equal(s.a1, 77); assert.equal(s.singular, true)
    assert.ok(angDeg(dirFromGimbal(type, s.a1, s.a2), pole) < 1e-12)
  }
})

t('normalizeGimbal：多种限位写法、缺省全行程、写反对调、速率数或 {a1,a2}', () => {
  assert.deepEqual(normalizeGimbal({ type: 'azel' }), { type: 'azel', a1Min: -180, a1Max: 180, a2Min: -90, a2Max: 90, rate1: null, rate2: null })
  assert.deepEqual(normalizeGimbal({ type: 'xy', limits: { xMin: -31, xMax: 31, yMin: '-22.5', yMax: 22.5 }, rateDegS: 0.5 }),
    { type: 'xy', a1Min: -31, a1Max: 31, a2Min: -22.5, a2Max: 22.5, rate1: 0.5, rate2: 0.5 })
  assert.deepEqual(normalizeGimbal({ type: 'azel', limits: [[10, -10], [-5, 5]], rateDegS: { a1: 1, a2: 0 } }),
    { type: 'azel', a1Min: -10, a1Max: 10, a2Min: -5, a2Max: 5, rate1: 1, rate2: null })
  assert.equal(normalizeGimbal({ azMin: -20, azMax: 20 }).a1Max, 20, '平铺写法')
  assert.equal(normalizeGimbal({ type: 'azel', rateDegS: 2 }, 0.3).rate1, 0.3, 'rateOverride')
  assert.equal(normalizeGimbal(null).type, 'azel')
})

t('pickSolution：翻转解 / 360° 缠绕选离参考最近者；限位外无解', () => {
  const o = {}
  const lim = { a1Min: -270, a1Max: 270, a2Min: -90, a2Max: 90 }
  assert.ok(pickSolution(-100, 10, lim, 250, 0, o)); near(o.a1, 260, 1e-12, '缠绕 +360')
  assert.ok(pickSolution(-100, 10, lim, -250, 0, o)); near(o.a1, -100, 1e-12, '保持')
  const flip = { a1Min: -180, a1Max: 180, a2Min: -10, a2Max: 190 }
  assert.ok(pickSolution(0, 80, flip, 180, 100, o)); near(o.a1, 180, 1e-12, '翻转 a1'); near(o.a2, 100, 1e-12, '翻转 a2 = 180 − 80')
  assert.ok(!pickSolution(40, 0, { a1Min: -22.5, a1Max: 22.5, a2Min: -31, a2Max: 31 }, 0, 0, o), '限位外')
})

// 目标以恒定角速率走一条大圆，离 azel keyhole（挂点 +y）最近 missDeg
function passNearKeyhole(missDeg, rateDegS, span = 120, dt = 1) {
  const dirs = [], tMs = []
  const m = missDeg * D2R
  const p = [0, Math.cos(m), Math.sin(m)]                // 离 +y 最近点
  const u = [1, 0, 0]                                     // 运动方向（⟂ p）
  for (let s = -span; s <= span; s += dt) {
    const th = rateDegS * s * D2R
    dirs.push([Math.cos(th) * p[0] + Math.sin(th) * u[0], Math.cos(th) * p[1] + Math.sin(th) * u[1], Math.cos(th) * p[2] + Math.sin(th) * u[2]])
    tMs.push(s * 1000)
  }
  return { dirs, tMs }
}

t('keyhole 附近过顶（azel）：不限速全可跟踪、峰值方位速率 ≈ ω/sin(miss)；限速 2°/s 出现 rate 中断；同一路径 xy 座峰值速率 ≈ ω', () => {
  const rows = []
  for (const miss of [0.5, 2, 10]) {
    const { dirs, tMs } = passNearKeyhole(miss, 0.5, 120, Math.min(1, miss / (0.5 * 50)))
    const free = trackSeries(dirs, tMs, { type: 'azel' })
    near(free.trackableFrac, 1, 1e-12, `miss ${miss} 不限速`)
    const theory = 0.5 / Math.sin(miss * D2R)
    near(free.peakRateA1DegS, theory, theory * 0.02, `miss ${miss} 峰值方位速率`)
    const lim = trackSeries(dirs, tMs, { type: 'azel', rateDegS: 2 })
    const xy = trackSeries(dirs, tMs, { type: 'xy', rateDegS: 2 })
    near(xy.trackableFrac, 1, 1e-12, 'xy 不受 keyhole 影响')
    assert.ok(xy.peakRateDegS < 0.6, `xy 峰值 ${xy.peakRateDegS}`)
    if (theory > 2) { assert.ok(lim.counts.rate > 0, 'azel 限速应中断'); assert.ok(lim.longestOutageMin > 0) }
    else assert.equal(lim.counts.rate, 0)
    rows.push(`miss ${miss}°：azel 峰值 ${free.peakRateA1DegS.toFixed(2)}°/s（理论 ${theory.toFixed(2)}），限速 2°/s 可跟踪 ${(lim.trackableFrac * 100).toFixed(1)}%、最长中断 ${(lim.longestOutageMin * 60).toFixed(0)} s；xy 峰值 ${xy.peakRateDegS.toFixed(3)}°/s`)
  }
  console.log('  ' + rows.join('\n  '))
})

t('恰过 keyhole：俯仰限位 ±90° 时方位翻 180°（一步）；放宽到 [−90, 180] 走翻转解、方位不跳', () => {
  const { dirs, tMs } = passNearKeyhole(0, 0.5, 20, 1)
  const a = trackSeries(dirs, tMs, { type: 'azel' })
  let jump = 0
  for (let i = 1; i < a.series.a1.length; i++) jump = Math.max(jump, Math.abs(a.series.a1[i] - a.series.a1[i - 1]))
  near(jump, 180, 1e-9, '±90 限位：方位一步翻 180°')
  const b = trackSeries(dirs, tMs, { type: 'azel', limits: { a2Min: -90, a2Max: 180 } })
  let jb = 0, maxEl = -Infinity
  for (let i = 1; i < b.series.a1.length; i++) { jb = Math.max(jb, Math.abs(b.series.a1[i] - b.series.a1[i - 1])); maxEl = Math.max(maxEl, b.series.a2[i]) }
  assert.equal(jb, 0, '翻转解下方位不动'); assert.ok(maxEl > 90, '俯仰越过 90°')
  near(b.peakRateA2DegS, 0.5, 1e-9, '俯仰速率 = 路径角速率')
  near(b.trackableFrac, 1, 1e-12)
})

t('限位：X-Y 座 ±31° / ±22.5°（TDRS 单址量级），目标沿 Y 从 −40° 匀速扫到 +40° → 可跟踪比例 = 45/80，最长中断解析', () => {
  const dirs = [], tMs = []
  for (let s = 0; s <= 800; s++) { dirs.push(dirFromXY(5, -40 + s * 0.1)); tMs.push(s * 1000) }
  const r = trackSeries(dirs, tMs, { type: 'xy', limits: { xMin: -31, xMax: 31, yMin: -22.5, yMax: 22.5 } })
  near(r.trackableFrac, 450 / 800, 1 / 800, '比例')
  near(r.longestOutageMin, 175 / 60, 1 / 60, '最长中断（−40 → −22.5 共 175 s）')
  assert.equal(r.counts.mask + r.counts.rate + r.counts.noTarget, 0)
  assert.equal(r.counts.limit, 350)
  assert.ok(Number.isNaN(r.series.a1[0]) && r.series.reason[0] === REASON.LIMIT)
  near(r.peakRateA2DegS, 0.1, 1e-9, '限位内相邻拍的速率')
})

t('掩模：本体系方向查表（挂点系 ↔ 本体系经 frame 换算）；两种入参口径结果相同', () => {
  const mount = { boresightBody: [1, 0, 0], upBody: [0, 0, -1] }
  const frame = mountFrame(mount)
  const mask = buildMask((d) => (d[1] > 0.2 ? 1 : Infinity))        // 本体 +Y 一侧被挡
  const dirsM = [], dirsB = [], tMs = []
  for (let s = 0; s <= 600; s++) {
    const dm = dirFromAzEl(-30 + s * 0.1 + 0.0123, 0)          // 错开半度格界，免得两种口径的舍入落在格界两侧
    dirsM.push(dm); dirsB.push(dirMountToBody(dm, frame)); tMs.push(s * 1000)
  }
  const r1 = trackSeries(dirsM, tMs, { type: 'azel' }, null, mask, { frame })
  const r2 = trackSeries(dirsB, tMs, { type: 'azel' }, null, mask, { frame, dirFrame: 'body' })
  assert.deepEqual(Array.from(r1.series.reason), Array.from(r2.series.reason))
  assert.ok(r1.counts.mask > 0 && r1.counts.ok > 0)
  let bad = 0
  for (let i = 0; i < dirsB.length; i++) if ((maskLookup(mask, dirsB[i]) === 1) !== (r1.series.reason[i] === REASON.MASK)) bad++
  assert.equal(bad, 0, '被挡 ⇔ 本体方向查表为 1')
  // 函数形掩模
  const r3 = trackSeries(dirsM, tMs, { type: 'azel' }, null, (d) => (d[1] > 0.2 ? 1 : 0), { frame })
  assert.deepEqual(Array.from(r3.series.reason), Array.from(r1.series.reason))
})

t('速率：限位空档后重新捕获要回转，回转期间计 rate；中断时长 ≈ 角差 / 速率', () => {
  const dirs = [], tMs = []
  for (let s = 0; s < 200; s++) { dirs.push(s < 100 ? dirFromAzEl(-20, 0) : dirFromAzEl(20, 0)); tMs.push(s * 1000) }
  const r = trackSeries(dirs, tMs, { type: 'azel', limits: { azMin: -30, azMax: 30 } }, 1)
  // 第 100 拍目标跳到 +20°：以 1°/s 回转 40°，第 i 拍实际方位 = −20 + (i − 99) → 第 139 拍追上，第 100..138 拍计 rate
  assert.equal(r.counts.rate, 39)
  near(r.longestOutageMin, 39 / 60, 1e-12, '最长中断 39 s')
  assert.equal(r.series.reason[139], REASON.OK)
  near(r.series.act1[120], 1, 1e-12, '第 120 拍实际方位 1°')
})

t('无目标拍：不进分母、打断中断段；Float64Array 平铺入参（NaN = 无目标）；步长不均匀按中点权重', () => {
  const tMs = [0, 1000, 3000, 6000, 7000]
  const flat = new Float64Array(15)
  const pts = [[0, 0, 1], null, dirFromAzEl(60, 0), dirFromAzEl(0, 0), dirFromAzEl(0, 5)]
  pts.forEach((p, i) => { if (p) flat.set(p, i * 3); else flat.set([NaN, NaN, NaN], i * 3) })
  const r = trackSeries(flat, tMs, { type: 'azel', limits: { azMin: -45, azMax: 45 } })
  assert.equal(r.counts.noTarget, 1); assert.equal(r.counts.limit, 1); assert.equal(r.counts.ok, 3)
  // 中点权重：0.5, 1.5, 2.5, 2, 0.5（s）→ 有效 = 7 − 1.5 = 5.5；可跟踪 = 0.5 + 2 + 0.5 = 3
  near(r.durationsSec.valid, 5.5, 1e-12, '有效时长'); near(r.trackableFrac, 3 / 5.5, 1e-12, '比例')
  near(r.longestOutageMin, 2.5 / 60, 1e-12, '中断 = 第 3 拍')
})

t('线缆缠绕：方位限位 [−270, 270]，目标方位连续转到 265° 不跳变', () => {
  const dirs = [], tMs = []
  for (let s = 0; s <= 265; s++) { dirs.push(dirFromAzEl(s, 3)); tMs.push(s * 1000) }
  const r = trackSeries(dirs, tMs, { type: 'azel', limits: { azMin: -270, azMax: 270 } }, 1.5)
  near(r.series.a1[265], 265, 1e-9, '缠绕到 265°')
  near(r.trackableFrac, 1, 1e-12); near(r.peakRateA1DegS, 1, 1e-9, '速率 1°/s')
})

t('固定天线（type none，限位照存不用）：命令角钉在 (0,0)、不看限位；目标扫过 ±60° → 可跟踪比例 = 视场内时长 / 总时长；peakRate null', () => {
  const dirs = [], tMs = []
  for (let s = 0; s <= 1200; s++) { dirs.push(dirFromAzEl(-60 + s * 0.1, 0)); tMs.push(s * 1000) }   // 0.1°/s 扫 120°
  const full = { type: 'none', limits: { a1Min: -180, a1Max: 180, a2Min: -90, a2Max: 90 } }
  const r = trackSeries(dirs, tMs, full, null, null, { fovDeg: 30 })
  // |az| ≤ 15° 的拍：−15..15 共 301 拍，每拍中点权重 1 s（只有整段首末两拍是半拍）→ 视场内 301 s / 总 1200 s
  near(r.trackableFrac, 301 / 1200, 1e-12, '比例 = 视场内 / 总')
  assert.equal(r.counts.ok, 301); assert.equal(r.counts.limit, 900); assert.equal(r.counts.rate + r.counts.mask, 0)
  near(r.longestOutageMin, 449.5 / 60, 1e-9, '最长中断 = 视场外一侧 449.5 s')
  assert.equal(r.peakRateDegS, null); assert.equal(r.peakRateA1DegS, null); assert.equal(r.fixed, true)
  assert.ok(r.series.a1.every((x) => x === 0) && r.series.act2.every((x) => x === 0), '命令 / 实际角恒 0')
  near(r.series.errDeg[0], 60, 1e-9, 'errDeg = 偏离视轴角')
  // 没给 fovDeg：取 opts.mount.fovDeg；再没有：半视场 = tolDeg
  near(trackSeries(dirs, tMs, full, null, null, { mount: { fovDeg: 60 } }).trackableFrac, 601 / 1200, 1e-12, 'mount.fovDeg')
  const rt = trackSeries(dirs, tMs, full, null, null, { tolDeg: 5 })
  assert.equal(rt.counts.ok, 101, '半视场 = tolDeg 5° → −5..5 共 101 拍')
  // 审查实测：同一条 72° 扫描、全程限位，改前记 100 %（按全行程 az-el 万向节算），现在只算视场内
  const d72 = [], t72 = []
  for (let s = 0; s <= 100; s++) { d72.push(dirFromAzEl(-36 + s * 0.72, 0)); t72.push(s * 1000) }
  const r72 = trackSeries(d72, t72, full, null, null, { fovDeg: 17.4 })
  assert.ok(r72.trackableFrac < 0.3 && r72.peakRateDegS === null, `72° 扫描可跟踪 ${r72.trackableFrac}`)
  // 视场内但被掩模挡 → mask
  const rm = trackSeries(dirs, tMs, full, null, (d) => (d[0] < -0.1 ? 1 : 0), { fovDeg: 30, frame: mountFrame({ boresightBody: [0, 0, 1], upBody: [0, -1, 0] }) })
  assert.ok(rm.counts.mask > 0 && rm.counts.ok > 0 && rm.counts.ok + rm.counts.mask === 301, '视场内分 ok / mask')
  console.log(`  固定天线：±60° 扫描、30° 视场 → 可跟踪 ${(r.trackableFrac * 100).toFixed(1)} %、最长中断 ${(r.longestOutageMin * 60).toFixed(1)} s；72° 扫描 17.4° 视场 → ${(r72.trackableFrac * 100).toFixed(1)} %（改前 100 %）`)
})

t('缺 frame：按 opts.mount 现算，再没有按 D1 缺省挂点（x = −X_B、y = −Y_B）；本体系方向 / 掩模查表都换算，结果标 frameDefaulted', () => {
  const tMs = [0, 1000]
  // 本体 +X 方向：缺省挂点系下是 x_m = −1 → az = −90°（改前被当成挂点 +x → az = +90°，限位不对称时 OK / LIMIT 互换）
  const dirsB = [[1, 0, 0], [1, 0, 0]]
  const neg = trackSeries(dirsB, tMs, { type: 'azel', limits: { azMin: -100, azMax: -80 } }, null, null, { dirFrame: 'body' })
  const pos = trackSeries(dirsB, tMs, { type: 'azel', limits: { azMin: 80, azMax: 100 } }, null, null, { dirFrame: 'body' })
  assert.equal(neg.counts.ok, 2); near(neg.series.a1[0], -90, 1e-12, 'az = −90')
  assert.equal(pos.counts.limit, 2)
  assert.equal(neg.frameDefaulted, true)
  const expl = trackSeries(dirsB, tMs, { type: 'azel', limits: { azMin: -100, azMax: -80 } }, null, null, { dirFrame: 'body', frame: mountFrame(null) })
  assert.equal(expl.frameDefaulted, false)
  assert.deepEqual(Array.from(expl.series.reason), Array.from(neg.series.reason))
  // opts.mount 给了就按它：视轴 +X、up −Z → 本体 +X 就是视轴 (0,0)
  const byMount = trackSeries(dirsB, tMs, { type: 'azel', limits: { azMin: -5, azMax: 5, elMin: -5, elMax: 5 } }, null, null, { dirFrame: 'body', mount: { boresightBody: [1, 0, 0], upBody: [0, 0, -1] } })
  assert.equal(byMount.counts.ok, 2)
  // 挂点系方向 + 掩模、没给 frame：查表前换到本体系。挂点 +y（= up = 本体 −Y）不该被「本体 +Y 一侧」的掩模挡住
  const mask = buildMask((d) => (d[1] > 0.2 ? 1 : Infinity))
  const dm = [[0, 0.5, Math.sqrt(0.75)], [0, 0.5, Math.sqrt(0.75)]]
  const rm = trackSeries(dm, tMs, { type: 'azel' }, null, mask, {})
  assert.equal(rm.counts.mask, 0, '挂点 +y 半侧 = 本体 −Y 半侧，不被挡'); assert.equal(rm.counts.ok, 2)
  const rm2 = trackSeries([[0, -0.5, Math.sqrt(0.75)]], [0], { type: 'azel' }, null, mask, {})
  assert.equal(rm2.counts.mask, 1, '挂点 −y 半侧 = 本体 +Y 半侧，被挡')
})

console.log(`modelGimbal: ${n} 项通过`)
