// 星历点序列插值的回归网（packages/core/utils/ephemInterp.js）。
//
// 【真值】解析圆轨道：r(t) = R·(cos u, sin u·cos i, sin u·sin i)，u = n·t，n = sqrt(mu/R³)。
// 采样点按解析式生成，再在【采样点之间】取值与解析式比 —— 误差就是插值误差本身，不掺轨道模型误差。
//
// 【渲染端镜像】src/viz/constellation/ephemTable.js 的 evalTable 与本模块的必须【逐位相同】。
// 那份是手写 ESM 副本（渲染端吃不进 CJS），本测试是它唯一的防漂移闸门。

import { createRequire } from 'node:module'
import { evalTable as evalMirror, tableFrom, estimatePeriodMin as periodMirror } from '../../../src/viz/constellation/ephemTable.js'
const require = createRequire(import.meta.url)
const EI = require('../utils/ephemInterp.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)

const MU = 398600.4418
const T0 = Date.UTC(2026, 8, 21)
// 解析圆轨道（TEME，倾角 incl）
function circle(R, inclDeg) {
  const n = Math.sqrt(MU / (R * R * R)), ci = Math.cos(inclDeg * Math.PI / 180), si = Math.sin(inclDeg * Math.PI / 180)
  return {
    n,
    at(sec) {
      const u = n * sec
      return {
        x: R * Math.cos(u), y: R * Math.sin(u) * ci, z: R * Math.sin(u) * si,
        vx: -R * n * Math.sin(u), vy: R * n * Math.cos(u) * ci, vz: R * n * Math.cos(u) * si
      }
    }
  }
}
function sample(orb, stepS, count, withVel) {
  const t = new Float64Array(count), p = new Float64Array(3 * count)
  const v = withVel ? new Float64Array(3 * count) : null
  for (let i = 0; i < count; i++) {
    const s = i * stepS, q = orb.at(s)
    t[i] = T0 + s * 1000
    p[3 * i] = q.x; p[3 * i + 1] = q.y; p[3 * i + 2] = q.z
    if (v) { v[3 * i] = q.vx; v[3 * i + 1] = q.vy; v[3 * i + 2] = q.vz }
  }
  return { t, p, v, frame: 'TEME' }
}
const errM = (got, want) => Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z) * 1000

/* ===== ① LEO 60 s 采样：Lagrange-6 与 Hermite 误差 < 1 m ===== */
section('LEO 60 s 采样')
const leo = circle(6878.137, 51.6)
const leoSrc = sample(leo, 60, 121, true)
// 速度容差按插值法分档：任务书只对【位置】提 <1 m。速度是插值多项式的导数，比位置低一阶 ——
// 三次 Hermite 的导数误差 ~ h³/24·|r⁗| = 60³/24 x 1e-8 ≈ 9e-5 km/s，是方法本身的阶，不是实现缺陷；
// Lagrange-6 阶数高得多，故给两个数量级更紧的尺。
for (const [method, samples, label, vTol] of [['lagrange', 6, 'Lagrange-6', 1e-5], ['hermite', 2, 'Hermite', 1e-4]]) {
  const tab = EI.buildTable(Object.assign({}, leoSrc, { interp: { method, samples } }))
  ok(tab && tab.n === 121, label + '：建表 121 点')
  ok(tab.method === method, label + '：插值法记住了')
  let worst = 0, at = 0
  for (let s = 0; s <= 7200; s += 7) {
    const got = EI.evalTable(tab, T0 + s * 1000)
    const e = errM(got, leo.at(s))
    if (e > worst) { worst = e; at = s }
  }
  ok(worst < 1, label + '：最大位置误差 < 1 m（实得 ' + worst.toFixed(4) + ' m @ t=' + at + ' s）')
  // 速度也要对（样本自带速度）
  let wv = 0
  for (let s = 30; s <= 7000; s += 137) {
    const got = EI.evalTable(tab, T0 + s * 1000), want = leo.at(s)
    wv = Math.max(wv, Math.hypot(got.vx - want.vx, got.vy - want.vy, got.vz - want.vz))
  }
  ok(wv < vTol, label + '：速度误差 < ' + vTol + ' km/s（实得 ' + wv.toExponential(2) + '）')
  // 采样点上必须精确命中
  for (const i of [0, 1, 60, 119, 120]) {
    const got = EI.evalTable(tab, leoSrc.t[i])
    ok(errM(got, leo.at(i * 60)) < 1e-3, label + '：采样点 ' + i + ' 精确命中')
  }
}

/* ===== ② MEO 900 s 采样：Lagrange-10 误差 < 0.5 m ===== */
section('MEO 900 s 采样（SP3 体例）')
const meo = circle(26560, 55)
const meoTab = EI.buildTable(Object.assign({}, sample(meo, 900, 97, false), { interp: { method: 'lagrange', samples: 10 } }))
ok(meoTab.n === 97, 'MEO 建表 97 点')
let meoWorst = 0
for (let s = 0; s <= 86400; s += 61) meoWorst = Math.max(meoWorst, errM(EI.evalTable(meoTab, T0 + s * 1000), meo.at(s)))
ok(meoWorst < 0.5, 'Lagrange-10 最大误差 < 0.5 m（实得 ' + meoWorst.toFixed(4) + ' m）')
// 无速度样本时靠位置多项式差分出速度
let meoV = 0
for (let s = 450; s <= 86000; s += 911) {
  const got = EI.evalTable(meoTab, T0 + s * 1000), want = meo.at(s)
  meoV = Math.max(meoV, Math.hypot(got.vx - want.vx, got.vy - want.vy, got.vz - want.vz))
}
ok(meoV < 1e-6, '无速度样本时的差分速度误差 < 1e-6 km/s（实得 ' + meoV.toExponential(2) + '）')

/* ===== ③ LEO 用 900 s 采样要告警 ===== */
section('步长合理性')
const coarse = EI.buildTable(Object.assign({}, sample(leo, 900, 20, true), { interp: { method: 'lagrange', samples: 10 } }))
ok(coarse.warnings.some((w) => /过粗/.test(w)), 'LEO 900 s 采样给出「过粗」告警', JSON.stringify(coarse.warnings))
ok(!meoTab.warnings.some((w) => /过粗/.test(w)), 'MEO 900 s 采样不告警')

/* ===== ④ 范围外 / 端容差 ===== */
section('范围与端容差')
const tab = EI.buildTable(Object.assign({}, leoSrc, { interp: { method: 'lagrange', samples: 6 } }))
ok(EI.evalTable(tab, T0 - 1001) === null, '起点前 1.001 s -> null')
ok(EI.evalTable(tab, T0 - 999) !== null, '起点前 0.999 s -> 仍给值（1 s 端容差）')
ok(EI.evalTable(tab, tab.t1 + 999) !== null, '终点后 0.999 s -> 仍给值')
ok(EI.evalTable(tab, tab.t1 + 1001) === null, '终点后 1.001 s -> null')
ok(errM(EI.evalTable(tab, T0 - 500), leo.at(0)) < 1e-6, '端容差内取端点值，不外推')
ok(EI.evalTable(null, T0) === null, '空表 -> null')
ok(EI.buildTable({ t: [1], p: [1, 2, 3], frame: 'TEME' }) === null, '只有 1 点建不出表')

/* ===== ⑤ 缓存下标不影响结果 ===== */
section('窗口缓存')
const times = []
for (let s = 0; s <= 7200; s += 13) times.push(T0 + s * 1000)
const fwd = times.map((ms) => EI.evalTable(tab, ms).x)
tab._i = 0
const rev = times.slice().reverse().map((ms) => EI.evalTable(tab, ms).x).reverse()
ok(fwd.every((x, i) => x === rev[i]), '正序与逆序取值逐位相同')
tab._i = 117
const jump = times.map((ms) => EI.evalTable(tab, ms).x)
ok(fwd.every((x, i) => x === jump[i]), '缓存下标乱设也逐位相同')

/* ===== ⑥ 坏样本剔除 ===== */
section('坏样本')
const bad = sample(leo, 60, 10, true)
bad.p[3 * 3] = NaN                       // 第 3 点位置 NaN
bad.p[3 * 5] = 1; bad.p[3 * 5 + 1] = 0; bad.p[3 * 5 + 2] = 0   // 第 5 点掉进地心
bad.t[7] = bad.t[6]                      // 第 7 点时刻重复
const cleaned = EI.buildTable(Object.assign({}, bad, { interp: { method: 'lagrange', samples: 6 } }))
ok(cleaned.n === 7, '三个坏样本被剔除（10 -> 7）', String(cleaned.n))
ok(cleaned.warnings.some((w) => /剔除/.test(w)), '剔除有告警')
for (let i = 1; i < cleaned.n; i++) ok(cleaned.t[i] > cleaned.t[i - 1], '时刻严格递增 @' + i)

/* ===== ⑦ 分段：段间不插值 ===== */
section('分段星历')
const segA = sample(leo, 60, 11, true)                 // 0 .. 600 s
const segSrc = { t: new Float64Array(22), p: new Float64Array(66), v: new Float64Array(66), frame: 'TEME' }
for (let i = 0; i < 11; i++) {
  segSrc.t[i] = segA.t[i]
  for (let c = 0; c < 3; c++) { segSrc.p[3 * i + c] = segA.p[3 * i + c]; segSrc.v[3 * i + c] = segA.v[3 * i + c] }
  const s2 = 3600 + i * 60, q = leo.at(s2)             // 3600 .. 4200 s（中间空 50 min）
  segSrc.t[11 + i] = T0 + s2 * 1000
  segSrc.p[3 * (11 + i)] = q.x; segSrc.p[3 * (11 + i) + 1] = q.y; segSrc.p[3 * (11 + i) + 2] = q.z
  segSrc.v[3 * (11 + i)] = q.vx; segSrc.v[3 * (11 + i) + 1] = q.vy; segSrc.v[3 * (11 + i) + 2] = q.vz
}
const segTab = EI.buildTable(Object.assign({}, segSrc, {
  interp: { method: 'lagrange', samples: 6 },
  spans: [[T0, T0 + 600000], [T0 + 3600000, T0 + 4200000]]
}))
ok(segTab.sg && segTab.sgA.length === 2, '建出两段', String(segTab.sg && segTab.sgA.length))
ok(EI.evalTable(segTab, T0 + 300000) !== null, '第一段内有值')
ok(EI.evalTable(segTab, T0 + 3900000) !== null, '第二段内有值')
ok(EI.evalTable(segTab, T0 + 2000000) === null, '缝里 -> null')
ok(EI.evalTable(segTab, T0 + 601500) === null, '第一段末 +1.5 s -> null')
ok(EI.evalTable(segTab, T0 + 600500) !== null, '第一段末 +0.5 s 仍在容差内')
// 段内取值不许被另一段的点污染
ok(errM(EI.evalTable(segTab, T0 + 570000), leo.at(570)) < 1, '第一段末附近仍准（窗口不跨段）')
ok(errM(EI.evalTable(segTab, T0 + 3630000), leo.at(3630)) < 1, '第二段首附近仍准')

/* ===== ⑧ 周期估计 ===== */
section('周期估计')
const per = EI.estimatePeriodMin(EI.buildTable(Object.assign({}, sample(leo, 60, 400, true), { interp: {} })))
near(per, 2 * Math.PI / leo.n / 60, 0.05, '升交点估出的周期（min）')
ok(EI.estimatePeriodMin(EI.buildTable(Object.assign({}, sample(leo, 60, 5, true), { interp: {} }))) === null, '样本不足返回 null')

/* ===== ⑨ 渲染端镜像逐位对拍 ===== */
section('渲染端 ESM 镜像')
const MIRROR_TABLES = [tab, meoTab, segTab,
  EI.buildTable(Object.assign({}, leoSrc, { interp: { method: 'hermite', samples: 2 } }))]
let cmp = 0, diff = 0
for (const tb of MIRROR_TABLES) {
  for (let s = -5; s <= 7300; s += 3) {
    const ms = T0 + s * 1000
    tb._i = 0; const a = EI.evalTable(tb, ms)
    tb._i = 0; const b = evalMirror(tb, ms)
    cmp++
    if ((a === null) !== (b === null)) { diff++; continue }
    if (a && (a.x !== b.x || a.y !== b.y || a.z !== b.z || a.vx !== b.vx || a.vy !== b.vy || a.vz !== b.vz)) diff++
  }
}
ok(diff === 0, '两份 evalTable 在 ' + cmp + ' 个时刻上逐位相同（不同 ' + diff + ' 处）')
// tableFrom：IPC 纯数据装回表后仍逐位相同
const raw = { t: Array.from(tab.t), p: Array.from(tab.p), v: Array.from(tab.v), method: tab.method, samples: tab.samples, srcFrame: tab.srcFrame }
const rebuilt = tableFrom(raw)
ok(rebuilt && rebuilt.n === tab.n, 'tableFrom 装回 ' + tab.n + ' 点')
let rdiff = 0
for (let s = 0; s <= 7200; s += 17) {
  const a = EI.evalTable(tab, T0 + s * 1000), b = evalMirror(rebuilt, T0 + s * 1000)
  if (a.x !== b.x || a.y !== b.y || a.z !== b.z) rdiff++
}
ok(rdiff === 0, 'tableFrom 装回后取值逐位相同')
ok(tableFrom({ t: [1], p: [1, 2, 3] }) === null, 'tableFrom 点数不足返回 null')
const segRaw = { t: Array.from(segTab.t), p: Array.from(segTab.p), v: Array.from(segTab.v), method: segTab.method, samples: segTab.samples, sg: Array.from(segTab.sg), sgA: Array.from(segTab.sgA), sgB: Array.from(segTab.sgB) }
ok(evalMirror(tableFrom(segRaw), T0 + 2000000) === null, '分段信息也过得了 IPC（缝里仍 null）')
near(periodMirror(EI.buildTable(Object.assign({}, sample(leo, 60, 400, true), { interp: {} }))), per, 1e-9, '镜像的周期估计一致')

console.log('\nephemInterp: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
