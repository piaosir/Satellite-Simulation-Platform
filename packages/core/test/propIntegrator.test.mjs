// 数值传播器的积分器部分（packages/core/utils/prop/numProp.js）。
//
// 【外部真值】二体问题有解析解（Kepler 方程），能量与角动量严格守恒 —— 这两条不依赖任何参照软件。
//   系数表另核 Butcher 表的行和条件与求积阶条件 Σ b_i c_i^(k−1) = 1/k（k ≤ 8）。
// 【覆盖】DOP853 / RKF78 两个积分器、7 阶稠密输出（离步点取值）、事件（近 / 远地点、终止事件）、反向积分、
//   跳变时刻（breakpoints）与开关函数（discontinuities）、跨闰秒的时间换算、输出转星历表 spec。

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const NP = require('../utils/prop/numProp.js')
const E = require('../utils/prop/elements.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const MU = 398600.4415
const twoBody = (tMs, r) => { const rr = Math.hypot(r[0], r[1], r[2]); const k = -MU / (rr * rr * rr); return [k * r[0], k * r[1], k * r[2]] }

// 解析二体：Kepler 方程（e < 1）
function keplerAt(el, dtSec) {
  const n = Math.sqrt(MU / el.a ** 3)
  const E0 = 2 * Math.atan2(Math.sqrt(1 - el.e) * Math.sin(el.nu / 2), Math.sqrt(1 + el.e) * Math.cos(el.nu / 2))
  const M = E0 - el.e * Math.sin(E0) + n * dtSec
  let EE = M
  for (let k = 0; k < 50; k++) { const d = (EE - el.e * Math.sin(EE) - M) / (1 - el.e * Math.cos(EE)); EE -= d; if (Math.abs(d) < 1e-15) break }
  const nu = 2 * Math.atan2(Math.sqrt(1 + el.e) * Math.sin(EE / 2), Math.sqrt(1 - el.e) * Math.cos(EE / 2))
  return E.coe2rv(MU, Object.assign({}, el, { nu }))
}

/* ===== ① 系数表 ===== */
section('Butcher 表')
for (const [name, tab, nb] of [['DOP853', NP.DOP853, 12], ['RKF78', NP.RKF78, 13]]) {
  let worst = 0
  tab.A.forEach((row, i) => { if (row.length) worst = Math.max(worst, Math.abs(row.reduce((s, x) => s + x, 0) - tab.C[i])) })
  ok(worst < 1e-14, name + ' 行和 Σ_j a_ij = c_i', String(worst))
  // 求积阶条件：8 阶方法对 k = 1…8 成立
  for (let k = 1; k <= 8; k++) {
    let s = 0
    for (let i = 0; i < nb; i++) s += tab.B[i] * Math.pow(tab.C[i], k - 1)
    near(s, 1 / k, 1e-14, name + ' Σ b_i c_i^' + (k - 1) + ' = 1/' + k)
  }
}

/* ===== ② 二体：解析解、守恒量 ===== */
section('二体 vs Kepler 解析解')
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
const el = { a: 12000, e: 0.5, i: 0.7, raan: 1.1, argp: 0.3, nu: 0.25 }
const s0 = E.coe2rv(MU, el)
const P = 2 * Math.PI * Math.sqrt(el.a ** 3 / MU)
const energy = (r, v) => (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) / 2 - MU / Math.hypot(r[0], r[1], r[2])
const hvec = (r, v) => [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]]
for (const integrator of ['DOP853', 'RKF78']) {
  const out = NP.propagate({ tMs: t0, r: s0.r, v: s0.v }, twoBody, { tEndMs: t0 + 20 * P * 1000, outStepSec: 977.7, integrator, rtol: 1e-13, atolPos: 1e-10, atolVel: 1e-13 })
  let wr = 0
  for (const s of out) wr = Math.max(wr, dist(s.r, keplerAt(el, (s.tMs - t0) / 1000).r))
  // 守恒量看末点（末点是积分步点，不经插值；中间输出点的速度来自稠密输出，RKF78 的五次 Hermite 速度只有 O(h⁵)）
  const E0 = energy(s0.r, s0.v), H0 = hvec(s0.r, s0.v), fin = out[out.length - 1]
  const wE = Math.abs(energy(fin.r, fin.v) - E0) / Math.abs(E0)
  const wH = dist(hvec(fin.r, fin.v), H0) / Math.hypot(...H0)
  console.log('  ' + integrator + '：e = 0.5、20 圈（' + out.length + ' 个输出点，含离步点的稠密输出）位置最大误差 ' + (wr * 1e6).toFixed(3) + ' mm，' +
    '20 圈后能量相对漂移 ' + wE.toExponential(2) + '，角动量相对漂移 ' + wH.toExponential(2) + '，' + JSON.stringify(out.stats))
  ok(wr < 2e-5, integrator + ' 20 圈位置误差 < 2 cm', String(wr))
  ok(wE < 1e-11, integrator + ' 20 圈后能量守恒（相对 < 1e-11）', String(wE))
  ok(wH < 1e-11, integrator + ' 20 圈后角动量守恒（相对 < 1e-11）', String(wH))
}
// 缺省容差（rtol 1e-12）下的 LEO 一天
{
  const elL = { a: 6878, e: 0.001, i: 0.9, raan: 0.2, argp: 0.1, nu: 0 }
  const sL = E.coe2rv(MU, elL)
  const out = NP.propagate({ tMs: t0, r: sL.r, v: sL.v }, twoBody, { tEndMs: t0 + 86400e3, outStepSec: 60 })
  const ref = keplerAt(elL, 86400)
  const d = dist(out[out.length - 1].r, ref.r)
  console.log('  缺省容差 LEO 一天：位置误差 ' + (d * 1e6).toFixed(3) + ' mm')
  ok(d < 1e-5, '缺省容差 LEO 一天 < 1 cm', String(d))
  ok(out.length === 1441 && out[0].tMs === t0 && out[1440].tMs === t0 + 86400e3, '输出网格 = t0 + k·60 s 共 1441 点')
}

/* ===== ③ 事件：近 / 远地点（r·v 过零） ===== */
section('事件')
{
  const ev = [{ name: 'apsis', g: (tMs, r, v) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2] }]
  const out = NP.propagate({ tMs: t0, r: s0.r, v: s0.v }, twoBody, { tEndMs: t0 + 3 * P * 1000, outStepSec: 3600, events: ev, rtol: 1e-13, atolPos: 1e-10, atolVel: 1e-13 })
  // 解析：近地点在 M = 0（mod 2π），远地点在 M = π
  const n = Math.sqrt(MU / el.a ** 3)
  const E0 = 2 * Math.atan2(Math.sqrt(1 - el.e) * Math.sin(el.nu / 2), Math.sqrt(1 + el.e) * Math.cos(el.nu / 2))
  const M0 = E0 - el.e * Math.sin(E0)
  const truth = []
  for (let k = 1; k <= 6; k++) truth.push(((k * Math.PI - M0) / n))
  ok(out.events.length === 6, '三圈 6 次拱点', String(out.events.length))
  let w = 0
  out.events.forEach((e, k) => { w = Math.max(w, Math.abs((e.tMs - t0) / 1000 - truth[k])) })
  console.log('  拱点时刻对解析解的最大偏差 ' + (w * 1e3).toFixed(4) + ' ms')
  ok(w < 1e-3, '拱点时刻误差 < 1 ms', String(w))
  ok(out.events.every((e, k) => e.increasing === (k % 2 === 1)), '远地点（r·v 由正变负）与近地点交替出现')
  // 终止事件：第一次过远地点即停
  const term = NP.propagate({ tMs: t0, r: s0.r, v: s0.v }, twoBody, { tEndMs: t0 + 3 * P * 1000, outStepSec: 600, events: [{ name: 'apo', g: ev[0].g, direction: -1, terminal: true }] })
  const last = term[term.length - 1]
  near((last.tMs - t0) / 1000, truth[0], 1e-3, '终止事件停在第一个远地点（s）')
  near(last.r[0] * last.v[0] + last.r[1] * last.v[1] + last.r[2] * last.v[2], 0, 1e-6, '终止点 r·v ≈ 0')
}

/* ===== ④ 反向积分 ===== */
section('反向积分')
{
  const fwd = NP.propagate({ tMs: t0, r: s0.r, v: s0.v }, twoBody, { tEndMs: t0 + 2 * P * 1000, outStepSec: 1000, rtol: 1e-13, atolPos: 1e-10, atolVel: 1e-13 })
  const end = fwd[fwd.length - 1]
  const back = NP.propagate(end, twoBody, { tEndMs: t0, outStepSec: 1000, rtol: 1e-13, atolPos: 1e-10, atolVel: 1e-13 })
  ok(back[1].tMs === end.tMs - 1000e3 && back[back.length - 1].tMs === t0, '反向输出网格')
  near(dist(back[back.length - 1].r, s0.r) * 1e6, 0, 10, '前推两圈再倒推回来，位置回到起点（mm）')
}

/* ===== ⑤ 跳变时刻与开关函数 ===== */
section('跳变时刻 / 开关函数')
{
  // y' = 1（t < 1），y' = 3（t ≥ 1）：解析 y(2) = 1 + 3 = 4
  const rhs = (t, y, dy) => { dy[0] = t < 1 ? 1 : 3 }
  const a = NP.integrate(rhs, 0, [0], 2, { rtol: 1e-12, atol: 1e-12, breakpoints: [1] })
  near(a.y[0], 4, 1e-12, 'breakpoints：阶跃右端函数的积分精确')
  // 折点：y' = |t − 0.7|（右端函数连续、导数跳变 —— 误差估计对它反应迟钝，正是地影半影边界那一类）
  //   解析 ∫0^1 = 0.7²/2 + 0.3²/2 = 0.29
  const rhs2 = (t, y, dy) => { dy[0] = Math.abs(t - 0.7) }
  const b0 = NP.integrate(rhs2, 0, [0], 1, { rtol: 1e-13, atol: 1e-14, initialStep: 1 })
  const b1 = NP.integrate(rhs2, 0, [0], 1, { rtol: 1e-13, atol: 1e-14, initialStep: 1, discontinuities: [(t) => t - 0.7] })
  near(b1.y[0], 0.29, 1e-12, 'discontinuities：折点处截步后积分精确')
  ok(b1.ntrunc >= 1, '开关点触发截步', String(b1.ntrunc))
  ok(Math.abs(b1.y[0] - 0.29) <= Math.abs(b0.y[0] - 0.29), '截步后不劣于不截步')
  console.log('  折点不处理的误差 ' + Math.abs(b0.y[0] - 0.29).toExponential(2) + '，处理后 ' + Math.abs(b1.y[0] - 0.29).toExponential(2))
  // 状态相关的跳变：y' = 1（y < 0.5），3（y ≥ 0.5）。解析 y(1) = 0.5 + 3·0.5 = 2。
  // 跳变大到误差估计会把步长缩到跳变点上，加不加开关函数都精确；这里只确认开关函数不添乱
  const rhs3 = (t, y, dy) => { dy[0] = y[0] < 0.5 ? 1 : 3 }
  const c1 = NP.integrate(rhs3, 0, [0], 1, { rtol: 1e-12, atol: 1e-12, initialStep: 0.3, discontinuities: [(t, y) => y[0] - 0.5] })
  near(c1.y[0], 2, 1e-9, '状态跳变 + 开关函数：积分精确')
}

/* ===== ⑥ 跨闰秒：积分自变量是 TAI 秒 ===== */
section('跨闰秒')
{
  // 2016-12-31T23:59:60 闰秒：UTC 读数差 2 h 的两点之间，物理时间是 2 h + 1 s
  const tA = Date.UTC(2016, 11, 31, 23, 0, 0), tB = Date.UTC(2017, 0, 1, 1, 0, 0)
  const elC = { a: 7000, e: 0.001, i: 0.5, raan: 0, argp: 0, nu: 0 }
  const sC = E.coe2rv(MU, elC)
  const out = NP.propagate({ tMs: tA, r: sC.r, v: sC.v }, twoBody, { tEndMs: tB, outStepSec: 3600, rtol: 1e-13, atolPos: 1e-10, atolVel: 1e-13 })
  const ref = keplerAt(elC, 7201)
  near(dist(out[out.length - 1].r, ref.r) * 1e3, 0, 1, '跨闰秒两小时，按 7201 s 物理时间对上解析解（m）')
  ok(out[1].tMs === Date.UTC(2017, 0, 1, 0, 0, 0), '输出网格仍按 UTC 读数等间隔')
}

/* ===== ⑦ 输出转星历表 spec ===== */
section('toEphemSpec')
{
  const out = NP.propagate({ tMs: t0, r: s0.r, v: s0.v }, twoBody, { tEndMs: t0 + 3600e3, outStepSec: 600 })
  const spec = NP.toEphemSpec(out)
  ok(spec.frame === 'J2000' && spec.t.length === 7 && spec.p.length === 21 && spec.v.length === 21, 'spec 形状（t / p / v / frame）')
  ok(spec.p[3] === out[1].r[0] && spec.v[20] === out[6].v[2], 'spec 数值逐位来自输出')
  // state0 也收 {x,y,z}
  const o2 = NP.propagate({ tMs: t0, r: { x: s0.r[0], y: s0.r[1], z: s0.r[2] }, v: { x: s0.v[0], y: s0.v[1], z: s0.v[2] } }, twoBody, { tEndMs: t0 + 3600e3, outStepSec: 600 })
  ok(o2.every((s, k) => s.r[0] === out[k].r[0] && s.v[2] === out[k].v[2]), 'state0 的 r / v 写成 {x,y,z} 与数组逐位等价')
}

console.log('\npropIntegrator: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
