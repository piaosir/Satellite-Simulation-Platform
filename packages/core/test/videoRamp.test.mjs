// 视频导出 · 变速（src/shared/video/videoRamp.js）：时间重映射（变速剖面 / 起止停留 / 反解）、成片时间轴。
// 运行：npm test -- videoRamp
import { buildTimeMap, planTimeline, normRamp, rampLevel, smoother } from '../../../src/shared/video/videoRamp.js'
import { computePace } from '../../../src/shared/video/videoPlan.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e

// ① 变速剖面：档位端点、单调、F(0)=0 / F(1)=1、F′ ∝ g、反解回环、积分精度
{
  ok('① smoother 端点与中点', smoother(0) === 0 && smoother(1) === 1 && near(smoother(0.5), 0.5) && smoother(-1) === 0 && smoother(2) === 1)
  ok('① 档位：渐快起点最慢、过渡后最快；渐慢反之；两端慢中间最快',
    rampLevel('in', 0.5, 0) === 0 && rampLevel('in', 0.5, 0.5) === 1 && rampLevel('out', 0.5, 1) === 0 && rampLevel('out', 0.5, 0.4) === 1 &&
    rampLevel('inout', 0.5, 0) === 0 && rampLevel('inout', 0.5, 1) === 0 && rampLevel('inout', 0.5, 0.5) === 1 && rampLevel('none', 0.5, 0.3) === 1)
  const flat = buildTimeMap({ shape: 'none' })
  ok('① 匀速：F(v) = v、反解恒等', flat.flat && near(flat.F(0.37), 0.37) && near(flat.inv(0.81), 0.81))
  let allMono = true, allEnds = true, allInv = true, allDeriv = true, maxInvErr = 0
  for (const shape of ['in', 'out', 'inout']) {
    for (const ratio of [2, 10, 100, 1000]) {
      for (const trans of [0.05, 0.3, 1]) {
        const tm = buildTimeMap({ shape, ratio, trans })
        if (tm.F(0) !== 0 || tm.F(1) !== 1) allEnds = false
        let prev = -1
        for (let j = 0; j <= 4000; j++) { const f = tm.F(j / 4000); if (f < prev - 1e-15) allMono = false; prev = f }
        for (const v of [0.013, 0.2, 0.5, 0.77, 0.999]) {
          const e = Math.abs(tm.inv(tm.F(v)) - v); maxInvErr = Math.max(maxInvErr, e); if (e > 1e-7) allInv = false
          const h = 1e-5, dF = (tm.F(v + h) - tm.F(v - h)) / (2 * h)
          if (Math.abs(dF - tm.g(v) / tm.Z) > 1e-4 * Math.max(1, tm.g(v) / tm.Z)) allDeriv = false
        }
      }
    }
  }
  ok('① 三种剖面 × 变速比 × 过渡：F 端点精确', allEnds)
  ok('① F 单调不减', allMono)
  ok('① F′ = g / Z（时间重映射的斜率就是相对速度）', allDeriv)
  ok('① 反解回环 inv(F(v)) = v', allInv, 'max ' + maxInvErr.toExponential(2))
  // 积分精度：与 20 万格中点法对比
  const tm = buildTimeMap({ shape: 'inout', ratio: 300, trans: 0.4 })
  let ref = 0; const M = 200000
  for (let j = 0; j < M; j++) ref += tm.g((j + 0.5) / M) / M
  ok('① 归一化积分 Z 精度（相对误差 < 1e-9）', Math.abs(tm.Z - ref) / ref < 1e-9, tm.Z + ' vs ' + ref)
  // 30 天时段下逐帧时刻误差：Hermite 插值 vs 精细积分
  let refHalf = 0
  for (let j = 0; j < M / 2; j++) refHalf += tm.g((j + 0.5) / M) / M
  const errMs = Math.abs(tm.F(0.5) - refHalf / ref) * 30 * 86400e3
  ok('① 30 天时段：中点时刻误差 < 1 ms', errMs < 1, errMs.toFixed(4) + ' ms')
  ok('① 最慢 / 最快 = 1 / 变速比', near(tm.gMin, 1 / 300, 1e-12) && tm.gMax === 1)
  const n = normRamp({ shape: 'zzz', ratio: -5, trans: 9, hold0: -1, hold1: 1e9 })
  ok('① normRamp：坏值落回出厂 / 夹到范围', n.shape === 'none' && n.ratio === 1 && n.trans === 1 && n.hold0 === 0 && n.hold1 === 3600)
}

// ② 成片时间轴：停留加帧、平均倍速守恒、首尾精确、瞬时倍速积分 = 时段
{
  const S = 6 * 3600, fps = 30
  const base = computePace(S, fps, { mode: 'speed', speed: 600 })
  const a = planTimeline(S, fps, { mode: 'speed', speed: 600 }, { shape: 'none' })
  ok('② 无变速无停留：与 computePace 逐项相同', a.ok && a.frames === base.frames && near(a.durationSec, base.durationSec) && near(a.speed, 600) && near(a.stepSec, 20) && !a.ramped)
  const b = planTimeline(S, fps, { mode: 'speed', speed: 600 }, { shape: 'inout', ratio: 20, trans: 0.5, hold0: 2, hold1: 3 })
  ok('② 倍速档：停留按帧数加在前后（2 s + 3 s = 150 帧）', b.frames === base.frames + 150 && b.hold0 === 60 && b.hold1 === 90 && b.moveFrames === base.frames)
  ok('② 停留段：时刻钉在起 / 止、倍速 0', b.at(0).frac === 0 && b.at(0).speed === 0 && b.at(59).frac === 0 && b.at(b.frames - 1).frac === 1 && b.at(b.frames - 1).speed === 0)
  ok('② 运动段首尾帧精确落在起止', b.at(60).frac === 0 && b.at(60 + b.moveFrames - 1).frac === 1)
  let sumSim = 0, mono = true, prev = -1
  for (let k = 0; k < b.frames; k++) {
    const f = b.at(k).frac
    if (f < prev) mono = false
    prev = f
    if (k > 0) sumSim += (b.at(k).speed + b.at(k - 1).speed) / 2 / fps
  }
  ok('② 逐帧时刻单调不减', mono)
  ok('② 瞬时倍速对视频时间积分 = 仿真时段（梯形，< 0.2%）', Math.abs(sumSim - S) / S < 2e-3, sumSim.toFixed(1) + ' vs ' + S)
  ok('② 平均倍速不变（600），最快 / 最慢之比 = 变速比', near(b.speed, 600) && near(b.speedMax / b.speedMin, 20, 1e-9) && b.speedMax > 600 && b.speedMin < 600 && b.ramped)
  const c = planTimeline(S, fps, { mode: 'duration', durationSec: 40 }, { hold0: 4, hold1: 6 })
  ok('② 视频时长档：总时长含停留（40 s），运动段 30 s', c.ok && near(c.durationSec, 40, 1e-9) && c.moveFrames === 901 && near(c.speed, 720))
  const d = planTimeline(S, fps, { mode: 'duration', durationSec: 10 }, { hold0: 6, hold1: 6 })
  ok('② 停留超过视频时长 → 无效', !d.ok)
  const f = planTimeline(0, fps, { mode: 'duration', durationSec: 12 }, { shape: 'none' })
  ok('② 起止重合：单帧', f.ok && f.frames === 1)
  const g = planTimeline(0, fps, { mode: 'speed', speed: 600 }, { hold0: 2 })
  ok('② 起止重合 + 停留：单个时刻的静帧视频', g.ok && g.frames === 61 && g.at(60).frac === 0)
  // 连续取值与逐帧一致；反解
  const u = 0.4321, x = u * (b.frames - 1)
  const ka = b.at(Math.floor(x)).frac, kb = b.at(Math.ceil(x)).frac
  const cu = b.atU(u).frac
  ok('② atU 落在相邻两帧之间', cu >= Math.min(ka, kb) - 1e-12 && cu <= Math.max(ka, kb) + 1e-12)
  ok('② uOfFrac 回环', near(b.atU(b.uOfFrac(0.3)).frac, 0.3, 1e-7) && near(b.atU(b.uOfFrac(0.9)).frac, 0.9, 1e-7))
  ok('② uOfFrac：停留段里按 uHint 原样返回', b.uOfFrac(0, 0.005) === 0.005 && b.uOfFrac(1, 0.999) === 0.999)
}

console.log(`
${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
