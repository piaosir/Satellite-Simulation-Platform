// 拖拽惯性滑行自测（src/viz/globe3d/dragInertia.js）。运行：npm test
//
// 会出错的地方全在「时间记账」上，逐条钉死：
//   ① 阻尼 100% = 松手即停（一格都不许滑）；
//   ② 等速甩动估出的角速度要准（估歪了滑行长度就整体跑偏）；
//   ③ ★ 帧率无关 —— 同一起滑速度在 30 / 60 / 144 fps 下滑出的【总角度】必须一致。
//      写成左黎曼和的话这一条会差 17%，也就是画质档一换手感就变；
//   ④ θ 跨 ±π 接缝不炸（OrbitControls 的方位角落在 (−π, π]，差分会跳 2π）；
//   ⑤ 低于阈值即停、cancel 后 active=false；
//   ⑥ 滑行总角 ≈ ω₀/λ（p=50 → ω₀/12.5，这是「出厂手感」那句话的定量形式）。
import { createDragInertia, lambdaFor, STOP_OMEGA } from '../../../src/viz/globe3d/dragInertia.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const DEG = 180 / Math.PI
const near = (a, b, eps) => Math.abs(a - b) <= eps
const rel = (a, b) => Math.abs(a - b) / Math.abs(b)

// 喂一段等速拖动：从 t0 起每 stepMs 一个样本，θ 每秒走 omega 弧度
function fling(inst, omega, { t0 = 1000, stepMs = 16, n = 10, phi = 1.2, wrap = false } = {}) {
  inst.begin()
  let th = 0
  for (let i = 0; i < n; i++) {
    const t = t0 + i * stepMs
    th = omega * (i * stepMs) / 1000
    // wrap：模拟 OrbitControls 的方位角值域 (−π, π]
    const v = wrap ? ((th + Math.PI) % (2 * Math.PI)) - Math.PI : th
    inst.sample(t, v, phi)
  }
  return inst.release(t0 + (n - 1) * stepMs)
}

// 一直 step 到停，返回总角度与帧数
function runToStop(inst, dt, maxFrames = 200000) {
  let total = 0, frames = 0
  for (; frames < maxFrames; frames++) {
    const s = inst.step(dt)
    if (!s) break
    total += s.dTheta
  }
  return { total, frames }
}

// ==================== ⓪ lambdaFor ====================
{
  ok('⓪ p=100 → λ=∞', lambdaFor(100) === Infinity)
  ok('⓪ p=50（出厂）→ λ=12.5', lambdaFor(50) === 12.5)
  ok('⓪ p=10 ≈ Cesium 默认 → λ=2.5', lambdaFor(10) === 2.5)
  ok('⓪ p=0 → λ=0.5（不是 0，否则永远不停）', lambdaFor(0) === 0.5)
  ok('⓪ p=1 也钳到 0.5', lambdaFor(1) === 0.5)
  ok('⓪ 越界与非数：120→∞、−5→0.5、NaN→12.5', lambdaFor(120) === Infinity && lambdaFor(-5) === 0.5 && lambdaFor(NaN) === 12.5)
  // 半衰期核对：ln2/λ
  ok('⓪ p=50 半衰期 55 ms', near(Math.log(2) / lambdaFor(50) * 1000, 55.45, 0.1), `${(Math.log(2) / 12.5 * 1000).toFixed(2)} ms`)
  ok('⓪ p=10 半衰期 0.28 s', near(Math.log(2) / lambdaFor(10), 0.277, 0.002), `${(Math.log(2) / 2.5).toFixed(3)} s`)
  ok('⓪ p=0 半衰期 1.4 s', near(Math.log(2) / lambdaFor(0), 1.386, 0.002), `${(Math.log(2) / 0.5).toFixed(3)} s`)
}

// ==================== ① p=100 松手即停 ====================
{
  const inst = createDragInertia(100)
  const got = fling(inst, 5.0)
  ok('① p=100：release 不起滑', got === false)
  ok('① p=100：active=false', inst.active === false)
  ok('① p=100：step 返回空', inst.step(1 / 60) === null)
}

// ==================== ② 等速样本 → ω 估计误差 < 2% ====================
{
  for (const w of [0.5, 2.0, 5.236, -3.0]) {
    const inst = createDragInertia(50)
    fling(inst, w, { stepMs: 16, n: 12 })
    // 第一帧的角增量 = ω·(1−e^{−λh})/λ → 反解 ω
    const h = 1 / 1000                     // 取极小步长，(1−e^{−λh})/λ → h，反解最干净
    const s = inst.step(h)
    const est = s.dTheta / ((1 - Math.exp(-12.5 * h)) / 12.5)
    ok(`② ω=${w} 估计误差 < 2%`, rel(est, w) < 0.02, `估得 ${est.toFixed(4)}（${(rel(est, w) * 100).toFixed(3)}%）`)
  }
}

// ==================== ③ ★ 帧率无关 ====================
{
  const W0 = 300 / DEG      // 300 °/s 的甩动
  const totals = []
  for (const fps of [30, 60, 144]) {
    const inst = createDragInertia(50)
    fling(inst, W0, { stepMs: 16, n: 12 })
    const r = runToStop(inst, 1 / fps)
    totals.push({ fps, ...r })
  }
  const base = totals[0].total
  let worst = 0
  for (const t of totals) worst = Math.max(worst, rel(t.total, base))
  ok('③ 30 / 60 / 144 fps 滑行总角相差 < 1%',
    worst < 0.01,
    totals.map((t) => `${t.fps}fps:${(t.total * DEG).toFixed(3)}°/${t.frames}帧`).join('  ') + `  最大偏差 ${(worst * 100).toFixed(4)}%`)

  // 掉帧（dt 不齐）也一样
  const inst = createDragInertia(50)
  fling(inst, W0, { stepMs: 16, n: 12 })
  let jitter = 0
  for (let i = 0; i < 100000; i++) {
    const dt = (i % 7 === 0) ? 0.05 : (i % 3 === 0 ? 1 / 144 : 1 / 60)   // 帧间隔乱跳
    const s = inst.step(dt)
    if (!s) break
    jitter += s.dTheta
  }
  ok('③ 帧间隔乱跳总角也一致', rel(jitter, base) < 0.01, `${(jitter * DEG).toFixed(3)}° vs ${(base * DEG).toFixed(3)}°`)
}

// ==================== ④ θ 跨 ±π 接缝 ====================
{
  const inst = createDragInertia(50)
  // 起点就压在接缝上：θ 原始值会从 +π 跳到 −π
  inst.begin()
  const w = 3.0
  for (let i = 0; i < 10; i++) {
    const t = 1000 + i * 16
    const raw = Math.PI - 0.05 + w * (i * 16) / 1000
    inst.sample(t, ((raw + Math.PI) % (2 * Math.PI)) - Math.PI, 1.2)
  }
  const got = inst.release(1000 + 9 * 16)
  const h = 1 / 1000
  const s = inst.step(h)
  const est = s.dTheta / ((1 - Math.exp(-12.5 * h)) / 12.5)
  ok('④ 跨接缝的甩动不被当成反向超速', got === true && rel(est, w) < 0.02, `估得 ${est.toFixed(4)} rad/s（真值 ${w}）`)

  // fling() 的 wrap 路径同样不炸
  const inst2 = createDragInertia(50)
  fling(inst2, 5.0, { wrap: true, n: 40, stepMs: 16 })
  ok('④ 连转两圈（反复跨接缝）估计仍正确', inst2.active === true)
}

// ==================== ⑤ 阈值、cancel、拖动中不滑 ====================
{
  const inst = createDragInertia(50)
  ok('⑤ 慢过起滑阈值就不滑（0.5 °/s）', fling(inst, 0.5 / DEG) === false && inst.active === false)

  const inst2 = createDragInertia(50)
  fling(inst2, 5.0)
  ok('⑤ 正常甩动 active=true', inst2.active === true)
  inst2.cancel()
  ok('⑤ cancel 后 active=false 且 step 空', inst2.active === false && inst2.step(1 / 60) === null)

  const inst3 = createDragInertia(50)
  fling(inst3, 5.0)
  const r = runToStop(inst3, 1 / 60)
  ok('⑤ 会停（不是无限滑）', r.frames < 200000 && inst3.active === false, `${r.frames} 帧`)

  const inst4 = createDragInertia(50)
  fling(inst4, 5.0)
  inst4.begin()      // 又按下去了
  ok('⑤ 拖动中不滑行', inst4.step(1 / 60) === null)

  const inst5 = createDragInertia(50)
  inst5.begin(); inst5.sample(1000, 0, 1.2)
  ok('⑤ 单样本（点一下没动）不起滑', inst5.release(1000) === false)

  const inst6 = createDragInertia(50)
  fling(inst6, 5.0)
  inst6.setDamping(100)
  ok('⑤ 滑行中把阻尼改成 100% 立即停', inst6.active === false)

  // 低帧率档：一帧 100 ms，窗口里只剩一个样本，仍要能甩出去
  const inst7 = createDragInertia(50)
  ok('⑤ 低帧率（100 ms 一帧）照样甩得动', fling(inst7, 5.0, { stepMs: 100, n: 6 }) === true)
}

// ==================== ⑥ 滑行总角 = ω₀/λ ====================
{
  for (const [p, lam] of [[50, 12.5], [10, 2.5], [0, 0.5]]) {
    const W0 = 300 / DEG
    const inst = createDragInertia(p)
    fling(inst, W0, { stepMs: 16, n: 12 })
    const r = runToStop(inst, 1 / 60)
    const want = W0 / lam
    ok(`⑥ p=${p}：滑行角 = ω₀/${lam}（±3%）`, rel(r.total, want) < 0.03,
      `${(r.total * DEG).toFixed(2)}° vs ${(want * DEG).toFixed(2)}°`)
  }
  // 出厂档的一句话指标：300 °/s 甩一下滑约 24°
  const inst = createDragInertia(50)
  fling(inst, 300 / DEG, { stepMs: 16, n: 12 })
  const r = runToStop(inst, 1 / 60)
  ok('⑥ 出厂 p=50：300 °/s 甩一下滑约 24°', near(r.total * DEG, 24, 1), `${(r.total * DEG).toFixed(2)}°`)
}

// ==================== ⑦ 极角与停止阈值 ====================
{
  const inst = createDragInertia(50)
  inst.begin()
  for (let i = 0; i < 10; i++) inst.sample(1000 + i * 16, 0, 1.2 + 2.0 * (i * 16) / 1000)
  inst.release(1000 + 9 * 16)
  const s = inst.step(1 / 60)
  ok('⑦ 纬向甩动也滑（dPhi 非零）', !!s && Math.abs(s.dPhi) > 0, `dPhi=${s ? s.dPhi.toFixed(5) : 'null'}`)
  inst.stopPhi()
  ok('⑦ stopPhi 后彻底停（撞极点时用）', inst.active === false && inst.step(1 / 60) === null)

  ok('⑦ 停止阈值 = 0.02 °/s', near(STOP_OMEGA * DEG, 0.02, 1e-12), `${(STOP_OMEGA * DEG).toFixed(4)} °/s`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
