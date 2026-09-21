// 拖拽粘滞跟随自测（src/viz/globe3d/dragFollow.js）。运行：npm test
//
// 钉住的是「仪器手感」那几条可量化的性质：
//   ① 阻尼百分比 → τ 单调，两端 0 / 120 ms，出厂 50 → 42 ms；
//   ② f = 1 − e^{−dt/τ}：τ=0 直连、dt=0 不施加、dt=τ 施加 63.2%；
//   ③ ★ 帧率无关 —— 同一段剩余命令在 30 / 60 / 144 fps 下按 OrbitControls 的递推跑出【逐点相同】的轨迹
//      （精确离散化，钉到 1e−9；写成常数 dampingFactor 的话 30 fps 比 144 fps 慢 4.8 倍）；
//   ④ 永不越过命令：增量同号、累计 ≤ 命令，剩余按 e^{−t/τ} 衰减、半衰期 τ·ln2；
//   ⑤ 起步 / 停手的速度连续：匀速拖动时每帧增量单调爬到 ω·h，停手后单调掉到 0，都不振荡；
//   ⑥ 匀速拖动的稳态滞后有解析式 ω·h/(e^{h/τ} − 1)，h→0 时趋于 ω·τ；
//   ⑦ 缩放缓动 τz=84 ms 在 60 fps 下逐帧等于改造前的 0.18。
import { tauFor, dampingFor, lagFor, halfLifeMs, stepFollow, TAU_MAX_MS, ZOOM_TAU_MS } from '../../../src/viz/globe3d/dragFollow.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => Math.abs(a - b) <= eps
const rel = (a, b) => Math.abs(a - b) / Math.abs(b)

// ---------- ① τ(p) ----------
ok('① p=0 → τ=0（直连）', tauFor(0) === 0)
ok('① p=100 → τ=120 ms', near(tauFor(100), TAU_MAX_MS / 1000, 1e-12), (tauFor(100) * 1000).toFixed(2) + ' ms')
ok('① p=50（出厂）→ τ≈42.4 ms', near(tauFor(50) * 1000, 42.43, 0.05), (tauFor(50) * 1000).toFixed(2) + ' ms')
{
  let mono = true
  for (let p = 0; p < 100; p += 5) if (!(tauFor(p + 5) > tauFor(p))) mono = false
  ok('① 0→100 每 5% 一档单调递增', mono)
}
ok('① 非数按出厂 50', tauFor('abc') === tauFor(50) && tauFor(NaN) === tauFor(50))
ok('① 越界钳到 0 / 100', tauFor(-20) === 0 && tauFor(250) === tauFor(100))

// ---------- ② f(dt, τ) ----------
ok('② τ=0 → f=1（任何 dt）', dampingFor(0.001, 0) === 1 && dampingFor(0.1, 0) === 1 && dampingFor(0, 0) === 1)
ok('② dt=0 → f=0', dampingFor(0, 0.05) === 0)
ok('② dt=τ → f=1−1/e', near(dampingFor(0.05, 0.05), 1 - Math.exp(-1), 1e-12), dampingFor(0.05, 0.05).toFixed(6))
ok('② dt≫τ → f→1', dampingFor(5, 0.05) > 0.999999)
ok('② 非数 dt 当 0', dampingFor(NaN, 0.05) === 0 && dampingFor(undefined, 0.05) === 0)

// ---------- ③ 帧率无关：常数剩余命令的轨迹逐点相同 ----------
// 在 t = 0.1, 0.2, …, 0.5 s 这些公共时刻上比较（30 / 60 / 144 三档的帧都落在这些点上：取 720 Hz 的公倍数栅格）
{
  const tau = tauFor(50), R0 = 1.0
  const at = (hz) => {
    const s = { applied: 0, rem: R0 }, h = 1 / hz, out = []
    for (let i = 1; i <= hz * 0.5 + 1e-9; i++) { stepFollow(s, h, tau); if (Math.abs((i * h * 10) - Math.round(i * h * 10)) < 1e-9) out.push(s.applied) }
    return out
  }
  const a30 = at(30), a60 = at(60), a144 = at(144)   // 144·0.1 = 14.4 不是整数 → 144 档只在 0.5 s 上有采样点
  const a720 = at(720)
  const maxDiff = Math.max(...a30.map((v, i) => Math.abs(v - a60[i])), ...a30.map((v, i) => Math.abs(v - a720[i])))
  ok('③ 30 / 60 / 720 fps 在 0.1–0.5 s 各公共时刻上已施加量逐点相同（≤1e−9）', a30.length === 5 && a60.length === 5 && maxDiff < 1e-9, '最大差 ' + maxDiff.toExponential(2))
  ok('③ 144 fps 在 0.5 s 上与 30 fps 相同', a144.length >= 1 && Math.abs(a144[a144.length - 1] - a30[4]) < 1e-9)
  // 对照：常数 dampingFactor（改造前的写法）在 30 fps 下慢得多 —— 这正是「画质档一换手感就变」
  const legacy = (hz, f) => { let applied = 0, rem = R0; for (let i = 0; i < hz * 0.5; i++) { const d = rem * f; applied += d; rem -= d } return rem }
  ok('③ 对照：常数 0.08/帧 在 30 fps 下 0.5 s 后剩余是 60 fps 的 3 倍以上', legacy(30, 0.08) / legacy(60, 0.08) > 3, (legacy(30, 0.08) / legacy(60, 0.08)).toFixed(2) + '×')
}

// ---------- ④ 永不越过命令 · 半衰期 ----------
{
  const tau = tauFor(100), h = 1 / 60
  const s = { applied: 0, rem: 0.5 }
  let sameSign = true, maxApplied = 0
  const trk = []
  for (let i = 0; i < 120; i++) { const before = s.applied; stepFollow(s, h, tau); const d = s.applied - before; if (d < 0) sameSign = false; maxApplied = Math.max(maxApplied, s.applied); trk.push({ t: (i + 1) * h, rem: s.rem }) }
  ok('④ 增量全同号、累计不超过命令', sameSign && maxApplied <= 0.5 + 1e-12, '累计 ' + s.applied.toFixed(6) + ' / 命令 0.5')
  // 剩余按 e^{−t/τ}：任一时刻的剩余 = 0.5·e^{−t/τ}
  const worst = Math.max(...trk.map((p) => Math.abs(p.rem - 0.5 * Math.exp(-p.t / tau))))
  ok('④ 剩余 = 命令·e^{−t/τ}（逐帧 ≤1e−12）', worst < 1e-12, worst.toExponential(2))
  ok('④ 半衰期 = τ·ln2：p=100 → 83.2 ms，p=50 → 29.4 ms', near(halfLifeMs(tau), 83.18, 0.05) && near(halfLifeMs(tauFor(50)), 29.41, 0.05),
    halfLifeMs(tau).toFixed(2) + ' / ' + halfLifeMs(tauFor(50)).toFixed(2) + ' ms')
}

// ---------- ⑤ 起步 / 停手速度连续（匀速拖动 = 每帧注入 ω·h）----------
{
  const tau = tauFor(50), h = 1 / 60, omega = 1.5   // 1.5 rad/s ≈ 86 °/s
  const s = { applied: 0, rem: 0 }
  const inc = []
  for (let i = 0; i < 60; i++) { const b = s.applied; stepFollow(s, h, tau, omega * h); inc.push(s.applied - b) }
  let monoUp = true
  for (let i = 1; i < inc.length; i++) if (inc[i] < inc[i - 1] - 1e-12) monoUp = false
  const steady = inc[inc.length - 1]
  ok('⑤ 起步：每帧增量单调爬升、不振荡', monoUp)
  ok('⑤ 起步：1 s 后每帧增量 = ω·h（≤0.01%）', rel(steady, omega * h) < 1e-4, steady.toExponential(4) + ' vs ' + (omega * h).toExponential(4))
  // 停手：不再注入，增量单调掉到 0
  const dec = []
  for (let i = 0; i < 60; i++) { const b = s.applied; stepFollow(s, h, tau); dec.push(s.applied - b) }
  let monoDown = true
  for (let i = 1; i < dec.length; i++) if (dec[i] > dec[i - 1] + 1e-12) monoDown = false
  ok('⑤ 停手：每帧增量单调下降到 0、不反向', monoDown && dec[dec.length - 1] >= 0 && dec[dec.length - 1] < 1e-6, '末帧增量 ' + dec[dec.length - 1].toExponential(2))
  // 起步速度爬到 63% 用时 ≈ τ（离散采样按半帧修正后 ±1 帧）
  const i63 = inc.findIndex((v) => v >= 0.632 * omega * h)
  ok('⑤ 起步：增量爬到 63% 用时 ≈ τ（±1 帧）', Math.abs((i63 + 0.5) * h - tau) <= h, ((i63 + 0.5) * h * 1000).toFixed(1) + ' ms vs τ ' + (tau * 1000).toFixed(1))
}

// ---------- ⑥ 稳态滞后解析式 ----------
{
  const tau = tauFor(50), omega = 1.5
  for (const hz of [30, 60, 144, 1000]) {
    const h = 1 / hz, s = { applied: 0, rem: 0 }
    for (let i = 0; i < hz * 2; i++) stepFollow(s, h, tau, omega * h)
    const want = omega * h / (Math.exp(h / tau) - 1)     // 出帧后的剩余（= 画面上地面落后指针的角）
    ok(`⑥ ${hz} fps 稳态滞后 = ω·h/(e^{h/τ}−1)`, near(s.rem, want, 1e-9), s.rem.toFixed(6) + ' rad（连续极限 ω·τ=' + lagFor(omega, tau).toFixed(6) + '）')
  }
  ok('⑥ h→0 时趋于 ω·τ（1000 fps 下差 <1%）', rel(omega * (1 / 1000) / (Math.exp((1 / 1000) / tau) - 1), lagFor(omega, tau)) < 0.012)
}

// ---------- ⑦ 缩放缓动 ----------
ok('⑦ τz=84 ms 在 60 fps 下每帧 = 0.18（±0.003）', near(dampingFor(1 / 60, ZOOM_TAU_MS / 1000), 0.18, 0.003), dampingFor(1 / 60, ZOOM_TAU_MS / 1000).toFixed(4))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
