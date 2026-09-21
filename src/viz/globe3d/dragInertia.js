// 3D 球体拖拽的惯性滑行（Google Earth / Cesium 口径）。纯状态机 + 纯数学，不依赖 three / DOM，
// 故可直接单测（见 packages/core/test/dragInertia.test.mjs）；scene.js 只负责喂样本与施加增量。
//
// 手感三条：
//   ① 拖动中 1:1 —— 抓住的地面点跟着指针走，没有滞后（这一条靠 OrbitControls.enableDamping=false
//      与 earthSpin.rotateSpeedFor 的距离感知灵敏度做到，本模块不参与）；
//   ② 松手后有一段惯性滑行，按【时间】指数衰减；
//   ③ 与帧率无关 —— 30 / 60 / 不限三档滑行的总角度必须一致。
//
// ★ ③ 是本模块唯一容易做错的地方。若写成「每帧 θ += ω·dt; ω *= exp(−λ·dt)」，那是左黎曼和，
//   步长越大高估越多（λ=12.5 时 dt=1/30 比 dt=1/144 多滑 17%）—— 画质档从「高」切到「中」手感就变了。
//   故这里对同一段指数曲线做【解析积分】：一拍走过的角度 = ω·(1 − e^{−λ·dt}) / λ，
//   末速 = ω·e^{−λ·dt}。两式都精确，dt 取多大都得到同一条轨迹。
//   （λ→0 时 (1−e^{−λdt})/λ → dt，与匀速滑行连续；λ 下限 0.5 故无需特判。）

const TAU = Math.PI * 2
const wrapToPi = (a) => { let x = a % TAU; if (x > Math.PI) x -= TAU; else if (x <= -Math.PI) x += TAU; return x }

// 停止阈值：0.02 °/s。低于此速就不值得再画 —— 默认距离下每秒不足半个像素。
export const STOP_OMEGA = 0.02 * Math.PI / 180

// 起滑阈值：甩得比这还慢就当没甩（否则「点一下微微挪了两像素」也会滑出去一小段）。
const MIN_FLING_OMEGA = 1.2 * Math.PI / 180   // 1.2 °/s

// 速度估计窗口：只认松手前这段时间内的样本。拖到一半停住再松手 → 窗口内速度≈0 → 不滑。
const VEL_WINDOW_MS = 80

// 阻尼百分比 → 衰减率 λ（1/s）。Cesium 的形状（inertiaSpin 0.9 ≈ λ 2.5）按 0–100 重标：
//   p = 100     → 不滑行（λ = ∞，松手即停）
//   0 ≤ p < 100 → λ = max(0.5, 25·p/100)
// 参考点：p=10 ≈ Cesium 默认（半衰期 0.28 s）；p=50（出厂）λ=12.5、半衰期 55 ms，
// 一次 300°/s 的甩动滑约 24°（「有惯性但收得住」）；p=0 λ=0.5、半衰期 1.4 s。
export function lambdaFor(p) {
  const q = Number(p)
  if (!Number.isFinite(q)) return 12.5
  if (q >= 100) return Infinity
  return Math.max(0.5, 25 * Math.max(0, q) / 100)
}

export function createDragInertia(damping) {
  let lambda = lambdaFor(damping == null ? 50 : damping)
  let wTheta = 0, wPhi = 0          // 角速度（rad/s）
  let dragging = false
  // 样本：t（ms）+ 解缠后的 θ 累计 + φ。θ 必须解缠 —— OrbitControls 的方位角落在 (−π, π]，
  // 横着拖过接缝时原始值会跳 2π，直接差分就是一次「反向超音速甩动」。
  let samples = []
  let accTheta = 0, lastTheta = null

  function begin() {
    dragging = true
    samples = []; accTheta = 0; lastTheta = null
    wTheta = 0; wPhi = 0
  }

  function sample(t, theta, phi) {
    if (!dragging || !Number.isFinite(t) || !Number.isFinite(theta) || !Number.isFinite(phi)) return
    if (lastTheta == null) accTheta = 0
    else accTheta += wrapToPi(theta - lastTheta)
    lastTheta = theta
    samples.push({ t, th: accTheta, ph: phi })
    // 只留窗口内的样本 + 一个窗口外的锚点（窗口内样本不足两个时还能用它兜住）
    while (samples.length > 2 && samples[1].t < t - VEL_WINDOW_MS) samples.shift()
  }

  function release(t) {
    dragging = false
    const tEnd = Number.isFinite(t) ? t : (samples.length ? samples[samples.length - 1].t : 0)
    if (lambda === Infinity || samples.length < 2) { samples = []; return false }
    // 窗口内最早的样本：松手前 ≤ 80 ms 那一段的平均角速度即起滑速度。
    // ★ 窗口内只剩最后一个样本时（低帧率档一帧就 100 ms）再往前取一个 —— 否则跨度为 0，
    //   画质调低就再也甩不动了。
    let i = samples.length - 1
    for (let k = 0; k < samples.length; k++) { if (samples[k].t >= tEnd - VEL_WINDOW_MS) { i = k; break } }
    if (i === samples.length - 1 && i > 0) i--
    const a = samples[i], b = samples[samples.length - 1]
    if (!a || !b || b.t - a.t <= 0) { samples = []; return false }
    const dt = (b.t - a.t) / 1000
    wTheta = (b.th - a.th) / dt
    wPhi = (b.ph - a.ph) / dt
    samples = []
    if (Math.hypot(wTheta, wPhi) < MIN_FLING_OMEGA) { wTheta = 0; wPhi = 0; return false }
    return true
  }

  // 走一帧：返回本帧该施加的角增量 {dTheta, dPhi}（球坐标，与 scene.rotateBy 同一套数学），
  // 没在滑行则返回 null。dt 单位秒，由调用方按【真实经过时间】给并钳上限（掉帧不该补一大跳）。
  function step(dt) {
    if (dragging || !(Math.abs(wTheta) > 0 || Math.abs(wPhi) > 0)) return null
    const h = Math.max(0, Math.min(0.1, Number(dt) || 0))
    if (!h) return null
    const decay = Math.exp(-lambda * h)
    const k = lambda > 0 ? (1 - decay) / lambda : h     // ∫₀^h e^{−λt}dt，解析式 → 与帧率无关
    const dTheta = wTheta * k, dPhi = wPhi * k
    wTheta *= decay; wPhi *= decay
    if (Math.abs(wTheta) < STOP_OMEGA) wTheta = 0
    if (Math.abs(wPhi) < STOP_OMEGA) wPhi = 0
    return (dTheta || dPhi) ? { dTheta, dPhi } : null
  }

  // 极角撞到 ±90° 时由调用方喊停，免得贴着极点空转到阈值
  function stopPhi() { wPhi = 0 }

  function cancel() { dragging = false; samples = []; lastTheta = null; wTheta = 0; wPhi = 0 }

  return {
    setDamping(p) { lambda = lambdaFor(p); if (lambda === Infinity) { wTheta = 0; wPhi = 0 } },
    begin, sample, release, step, stopPhi, cancel,
    get active() { return Math.abs(wTheta) > 0 || Math.abs(wPhi) > 0 },
    get dragging() { return dragging },
    get lambda() { return lambda }
  }
}
