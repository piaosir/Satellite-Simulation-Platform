// 数值轨道传播器（纯 CommonJS，主进程 / 渲染端 / Worker 通用）。
//
// 【积分器】
//   DOP853（缺省）：Dormand–Prince 8(5,3)，12 级 + FSAL，8 阶解、5 阶与 3 阶两路误差估计合成的步长控制，
//     另加 3 级给出 7 阶稠密输出。系数与算法：Hairer, Nørsett & Wanner《Solving Ordinary Differential
//     Equations I》2nd ed., §II.10（DOP853，Fortran 原码 dop853.f）；系数逐位取自 SciPy
//     scipy/integrate/_ivp/dop853_coefficients.py（BSD-3，其本身转录自 Hairer 原码）。
//     误差范数（Hairer 原式）：err = |h|·Σ(e5/sk)² / sqrt(n·(Σ(e5/sk)² + 0.01·Σ(e3/sk)²))，
//       sk = atol + rtol·max(|y_old|, |y_new|)；步长因子 fac = clamp((err^(1/8))/0.9, 1/6, 1/0.333)。
//     稠密输出：y(t_old + θh) = y_old + θ(F0 + (1−θ)(F1 + θ(F2 + (1−θ)(F3 + θ(F4 + (1−θ)(F5 + θF6))))))，
//       F0 = Δy，F1 = h·f_old − Δy，F2 = 2Δy − h(f_new + f_old)，F3…F6 = h·D·K（Hairer contd8）。
//   RKF78（可选）：Fehlberg 7(8)，13 级，局部外推取 8 阶解；误差 = h·41/840·(k1 + k11 − k12 − k13)。
//     系数：E. Fehlberg, NASA TR R-287 (1968) Table X。无原生稠密输出：二阶系统（位置 / 速度）用两端
//     r, v, a 的五次 Hermite（位置误差 O(h⁶)），一般系统退化为三次 Hermite。
//
// 【时间】积分自变量 = 自起点起的 TAI 秒（物理均匀时）。对外一律平台口径的 UTC 毫秒：力模型收 UTC 毫秒，
//   输出网格是 UTC 毫秒上的等间隔点（tMs = t0 + k·outStepSec·1000，末点补 tEndMs）。跨闰秒时 UTC 读数
//   与 TAI 秒的换算走 timeSystems 的闰秒表（只改那一张表）。
//
// 【接口】
//   propagate(state0, forceModel, { tEndMs, outStepSec, ... }) → [{ tMs, r:[x,y,z], v:[vx,vy,vz] }]
//     J2000 惯性系（= EME2000，frames.js 的 'J2000'），km、km/s。state0 = { tMs, r, v }，r / v 可为
//     [x,y,z] 或 {x,y,z}。forceModel 为函数 (tMs, r, v) → [ax, ay, az]（km/s²，含中心引力），或带
//     acceleration(tMs, r, v) 方法的对象（见 forceModel.js）。
//     可选：integrator 'DOP853' | 'RKF78'，rtol、atolPos(km)、atolVel(km/s)、maxStepSec、minStepSec、
//       initialStepSec、maxSteps、events（见下）、maxCheckSec、eventTolSec。
//     返回数组另挂两个属性：events（事件列表）与 stats（步数 / 拒步 / 开关点截步 / 力模型调用次数）。
//     力模型若带 discontinuities（地影边界）/ breakpoints（空间天气日界），自动交给积分器，步不跨过（见 integrate）。
//   事件：events: [{ name, g(tMs, r, v) → number, direction: 0 | 1 | -1, terminal }]。每个接受步内按
//     maxCheckSec（缺省 60 s）分段查 g 的变号，变号区间用稠密输出 + Brent 法求根到 eventTolSec（缺省 1e-6 s）。
//     direction = 1 只认 g 由负变正，-1 只认由正变负。terminal 事件处停止，末点即事件时刻的状态。
//   integrate(rhs, t0, y0, t1, opts, onStep)：通用 ODE 入口（测试与非轨道问题用），rhs(t, y, dy) 写 dy。
//   toEphemSpec(states)：输出 → ephemInterp.buildTable 的 spec（t / p / v / frame:'J2000'），供将来接星历管线。

'use strict'

const T = require('../timeSystems.js')

/* ===================== DOP853 系数（Hairer dop853.f；SciPy 同表） ===================== */
const DOP_C = [0.0, 0.05260015195876773, 0.0789002279381516, 0.1183503419072274, 0.2816496580927726, 0.3333333333333333, 0.25, 0.3076923076923077, 0.6512820512820513, 0.6, 0.8571428571428571, 1.0, 1.0, 0.1, 0.2, 0.7777777777777778]
// DOP_A[i] = 第 i 级的系数（只列 j < i）；第 12 行即 B（FSAL：第 13 级就是新点的 f）
const DOP_A = [
  [],
  [0.05260015195876773],
  [0.0197250569845379, 0.0591751709536137],
  [0.02958758547680685, 0.0, 0.08876275643042054],
  [0.2413651341592667, 0.0, -0.8845494793282861, 0.924834003261792],
  [0.037037037037037035, 0.0, 0.0, 0.17082860872947386, 0.12546768756682242],
  [0.037109375, 0.0, 0.0, 0.17025221101954405, 0.06021653898045596, -0.017578125],
  [0.03709200011850479, 0.0, 0.0, 0.17038392571223998, 0.10726203044637328, -0.015319437748624402, 0.008273789163814023],
  [0.6241109587160757, 0.0, 0.0, -3.3608926294469414, -0.868219346841726, 27.59209969944671, 20.154067550477894, -43.48988418106996],
  [0.47766253643826434, 0.0, 0.0, -2.4881146199716677, -0.590290826836843, 21.230051448181193, 15.279233632882423, -33.28821096898486, -0.020331201708508627],
  [-0.9371424300859873, 0.0, 0.0, 5.186372428844064, 1.0914373489967295, -8.149787010746927, -18.52006565999696, 22.739487099350505, 2.4936055526796523, -3.0467644718982196],
  [2.273310147516538, 0.0, 0.0, -10.53449546673725, -2.0008720582248625, -17.9589318631188, 27.94888452941996, -2.8589982771350235, -8.87285693353063, 12.360567175794303, 0.6433927460157636],
  [0.054293734116568765, 0.0, 0.0, 0.0, 0.0, 4.450312892752409, 1.8915178993145003, -5.801203960010585, 0.3111643669578199, -0.1521609496625161, 0.20136540080403034, 0.04471061572777259],
  [0.056167502283047954, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25350021021662483, -0.2462390374708025, -0.12419142326381637, 0.15329179827876568, 0.00820105229563469, 0.007567897660545699, -0.008298],
  [0.03183464816350214, 0.0, 0.0, 0.0, 0.0, 0.028300909672366776, 0.053541988307438566, -0.05492374857139099, 0.0, 0.0, -0.00010834732869724932, 0.0003825710908356584, -0.00034046500868740456, 0.1413124436746325],
  [-0.42889630158379194, 0.0, 0.0, 0.0, 0.0, -4.697621415361164, 7.683421196062599, 4.06898981839711, 0.3567271874552811, 0.0, 0.0, 0.0, -0.0013990241651590145, 2.9475147891527724, -9.15095847217987]
]
const DOP_B = DOP_A[12]
const DOP_E3 = [-0.18980075407240762, 0.0, 0.0, 0.0, 0.0, 4.450312892752409, 1.8915178993145003, -5.801203960010585, -0.4226823213237919, -0.1521609496625161, 0.20136540080403034, 0.02265179219836082, 0.0]
const DOP_E5 = [0.01312004499419488, 0.0, 0.0, 0.0, 0.0, -1.2251564463762044, -0.4957589496572502, 1.6643771824549864, -0.35032884874997366, 0.3341791187130175, 0.08192320648511571, -0.022355307863886294, 0.0]
const DOP_D = [
  [-8.428938276109013, 0.0, 0.0, 0.0, 0.0, 0.5667149535193777, -3.0689499459498917, 2.38466765651207, 2.117034582445028, -0.871391583777973, 2.2404374302607883, 0.6315787787694688, -0.08899033645133331, 18.148505520854727, -9.194632392478356, -4.436036387594894],
  [10.427508642579134, 0.0, 0.0, 0.0, 0.0, 242.28349177525817, 165.20045171727028, -374.5467547226902, -22.113666853125306, 7.733432668472264, -30.674084731089398, -9.332130526430229, 15.697238121770845, -31.139403219565178, -9.35292435884448, 35.81684148639408],
  [19.985053242002433, 0.0, 0.0, 0.0, 0.0, -387.0373087493518, -189.17813819516758, 527.8081592054236, -11.57390253995963, 6.8812326946963, -1.0006050966910838, 0.7777137798053443, -2.778205752353508, -60.19669523126412, 84.32040550667716, 11.99229113618279],
  [-25.69393346270375, 0.0, 0.0, 0.0, 0.0, -154.18974869023643, -231.5293791760455, 357.6391179106141, 93.40532418362432, -37.45832313645163, 104.0996495089623, 29.8402934266605, -43.53345659001114, 96.32455395918828, -39.17726167561544, -149.72683625798564]
]

/* ===================== RKF7(8) 系数（Fehlberg 1968，NASA TR R-287 Table X） ===================== */
const RKF_C = [0, 2 / 27, 1 / 9, 1 / 6, 5 / 12, 1 / 2, 5 / 6, 1 / 6, 2 / 3, 1 / 3, 1, 0, 1]
const RKF_A = [
  [],
  [2 / 27],
  [1 / 36, 1 / 12],
  [1 / 24, 0, 1 / 8],
  [5 / 12, 0, -25 / 16, 25 / 16],
  [1 / 20, 0, 0, 1 / 4, 1 / 5],
  [-25 / 108, 0, 0, 125 / 108, -65 / 27, 125 / 54],
  [31 / 300, 0, 0, 0, 61 / 225, -2 / 9, 13 / 900],
  [2, 0, 0, -53 / 6, 704 / 45, -107 / 9, 67 / 90, 3],
  [-91 / 108, 0, 0, 23 / 108, -976 / 135, 311 / 54, -19 / 60, 17 / 6, -1 / 12],
  [2383 / 4100, 0, 0, -341 / 164, 4496 / 1025, -301 / 82, 2133 / 4100, 45 / 82, 45 / 164, 18 / 41],
  [3 / 205, 0, 0, 0, 0, -6 / 41, -3 / 205, -3 / 41, 3 / 41, 6 / 41, 0],
  [-1777 / 4100, 0, 0, -341 / 164, 4496 / 1025, -289 / 82, 2193 / 4100, 51 / 82, 33 / 164, 12 / 41, 0, 1]
]
// 8 阶权（局部外推用它）；7 阶权与之差 = 41/840·(1, 0…0, 1(k11), −1(k12), −1(k13))
const RKF_B = [0, 0, 0, 0, 0, 34 / 105, 9 / 35, 9 / 35, 9 / 280, 9 / 280, 0, 41 / 840, 41 / 840]
const RKF_E = 41 / 840

const METHODS = {
  DOP853: { stages: 12, order: 8, errExp: 1 / 8, safety: 0.9, facMin: 0.333, facMax: 6 },
  RKF78: { stages: 13, order: 8, errExp: 1 / 8, safety: 0.9, facMin: 0.2, facMax: 5 }
}

/* ===================== 通用积分 ===================== */
// 跳变时刻两侧取值的偏移量（秒）。须大于右端函数那一侧时刻的舍入粒度：propagate 换成 UTC 绝对毫秒（~1.8e12），
// 其 ulp 约 2.4e-4 ms = 2.4e-7 s，故取 5 µs；对光滑部分的影响（|∂a/∂t|·5 µs）可略。
const bpEps = (t) => Math.max(5e-6, 1e-14 * Math.abs(t))

function asTol(v, n, dflt) {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = Array.isArray(v) || ArrayBuffer.isView(v) ? Number(v[i]) : (v == null ? dflt : Number(v))
  return out
}

// Hairer hinit：先按 ‖y‖/‖f‖ 猜步长，再用一步显式 Euler 估二阶导修正（order = 8）
function initialStep(rhs, t, y, f, dir, hmax, rtol, atol, order, nfev) {
  const n = y.length
  let dnf = 0, dny = 0
  for (let i = 0; i < n; i++) {
    const sk = atol[i] + rtol[i] * Math.abs(y[i])
    dnf += (f[i] / sk) ** 2; dny += (y[i] / sk) ** 2
  }
  let h = (dnf <= 1e-10 || dny <= 1e-10) ? 1e-6 : Math.sqrt(dny / dnf) * 0.01
  h = Math.min(h, hmax)
  const y1 = new Float64Array(n), f1 = new Float64Array(n)
  for (let i = 0; i < n; i++) y1[i] = y[i] + dir * h * f[i]
  rhs(t + dir * h, y1, f1); nfev.n++
  let der2 = 0
  for (let i = 0; i < n; i++) {
    const sk = atol[i] + rtol[i] * Math.abs(y[i])
    der2 += ((f1[i] - f[i]) / sk) ** 2
  }
  der2 = Math.sqrt(der2) / h
  const der12 = Math.max(Math.abs(der2), Math.sqrt(dnf))
  const h1 = der12 <= 1e-15 ? Math.max(1e-6, h * 1e-3) : Math.pow(0.01 / der12, 1 / order)
  return Math.min(100 * h, h1, hmax)
}

/**
 * 通用自适应积分。rhs(t, y, dy)；onStep(step) 每个接受步回调一次，返回 false 则提前停。
 * step = { t0, t1, y0, y1, f0, f1, interp(t, out) }（y/f 为该步私有副本，可留用）。
 * opts：method 'DOP853' | 'RKF78'，rtol（标量或数组），atol（标量或数组），maxStep，minStep，
 *       initialStep，maxSteps，secondOrder（y 前半为位置、后半为速度时给 true，RKF78 稠密输出走五次 Hermite），
 *       breakpoints（时刻数组：步不跨过这些时刻，右端函数在此有跳变，如空间天气的日界），
 *       discontinuities（开关函数数组 g(t, y)：步不跨过 g 的零点，右端函数在此不光滑，如地影边界），
 *       discontinuityTol（开关点定位精度，缺省 1e-7）。
 *   开关点的处理（与 Orekit 对力模型事件「停—重启」同理）：试算步误差合格后若某个 g 变号，用该步的稠密输出
 *   定出零点 t*，舍弃这一步，改从原起点积分到 t* 稍后（越过 5·discontinuityTol）再接受，下一步恢复原步长提议。
 *   高阶 RK 的局部误差估计假定右端函数光滑，跨过地影的半影边界（光照因子只有一阶连续）时误差估计失灵，
 *   不这么做 LEO 光压 7 天会积出十几米的误差（Orekit 对拍实测）。
 * 返回 { t, y, nfev, nsteps, nreject, ntrunc, stopped }。
 */
function integrate(rhs, t0, y0, t1, opts, onStep) {
  const o = opts || {}
  const meth = String(o.method || 'DOP853').toUpperCase()
  const M = METHODS[meth]
  if (!M) throw new Error('未知积分器：' + o.method)
  const n = y0.length
  const rtol = asTol(o.rtol, n, 1e-12)
  const atol = asTol(o.atol, n, 1e-12)
  const span = t1 - t0
  const dir = span >= 0 ? 1 : -1
  const hmax = Math.abs(o.maxStep > 0 ? o.maxStep : span) || 1
  const hmin = o.minStep > 0 ? o.minStep : 0
  const maxSteps = o.maxSteps > 0 ? o.maxSteps : 1e7
  const nfev = { n: 0 }
  const call = (t, y, dy) => { nfev.n++; rhs(t, y, dy) }

  let t = t0
  let y = Float64Array.from(y0)
  let f = new Float64Array(n)
  call(t, y, f)
  const st = { t, y, nfev: 0, nsteps: 0, nreject: 0, stopped: false }
  if (span === 0) { st.nfev = nfev.n; return st }

  let h = o.initialStep > 0 ? Math.min(o.initialStep, hmax) : initialStep(rhs, t, y, f, dir, hmax, rtol, atol, M.order, nfev)
  const nst = meth === 'DOP853' ? 16 : 13
  const K = []
  for (let s = 0; s < nst; s++) K.push(new Float64Array(n))
  const ys = new Float64Array(n), yNew = new Float64Array(n), fNew = new Float64Array(n)
  let reject = false
  let nsteps = 0, nreject = 0, ntrunc = 0
  // 跳变时刻：只留 (t0, t1] 之内的，按积分方向排序（恰在终点的也留着：末步的 c = 1 级同样要取跳变前一侧）
  const bps = (Array.isArray(o.breakpoints) ? o.breakpoints : []).filter((b) => dir * (b - t0) > 0 && dir * (b - t1) <= 0).sort((a, b) => dir * (a - b))
  let ib = 0
  // 开关函数
  const discs = Array.isArray(o.discontinuities) ? o.discontinuities : []
  const discTol = o.discontinuityTol > 0 ? o.discontinuityTol : 1e-7
  let gVal = discs.map((g) => g(t, y))
  let hResume = 0

  for (;;) {
    if (nsteps >= maxSteps) throw new Error('积分步数超过上限 ' + maxSteps)
    let last = false, atBp = false
    if (ib < bps.length && dir * (t + dir * h - bps[ib]) >= 0) { h = Math.abs(bps[ib] - t); atBp = true }
    if (dir * (t + dir * h - t1) >= 0) { h = Math.abs(t1 - t); last = true; atBp = ib < bps.length && bps[ib] === t1 }
    const hs = dir * h
    // 落在跳变时刻上的步：步末（c = 1）的各级取跳变「之前」一侧，免得右端函数在恰好那一刻取到跳变后的值
    // （DOP853 第 11 级 c = 1 且权重非零；时刻换算的浮点误差会让它随机落在两侧）
    const tEnd1 = atBp ? t + hs - dir * bpEps(t + hs) : t + hs
    let err
    K[0].set(f)
    if (meth === 'DOP853') {
      for (let s = 1; s < 12; s++) {
        const a = DOP_A[s]
        for (let i = 0; i < n; i++) {
          let acc = 0
          for (let j = 0; j < s; j++) { const aj = a[j]; if (aj !== 0) acc += aj * K[j][i] }
          ys[i] = y[i] + hs * acc
        }
        call(DOP_C[s] === 1 ? tEnd1 : t + DOP_C[s] * hs, ys, K[s])
      }
      for (let i = 0; i < n; i++) {
        let acc = 0
        for (let j = 0; j < 12; j++) { const bj = DOP_B[j]; if (bj !== 0) acc += bj * K[j][i] }
        yNew[i] = y[i] + hs * acc
      }
      call(tEnd1, yNew, K[12])
      let e5 = 0, e3 = 0
      for (let i = 0; i < n; i++) {
        const sk = atol[i] + rtol[i] * Math.max(Math.abs(y[i]), Math.abs(yNew[i]))
        let a5 = 0, a3 = 0
        for (let j = 0; j < 13; j++) { const kj = K[j][i]; a5 += DOP_E5[j] * kj; a3 += DOP_E3[j] * kj }
        e5 += (a5 / sk) ** 2; e3 += (a3 / sk) ** 2
      }
      let deno = e5 + 0.01 * e3
      if (deno <= 0) deno = 1
      err = h * e5 * Math.sqrt(1 / (n * deno))
      fNew.set(K[12])
    } else {
      for (let s = 1; s < 13; s++) {
        const a = RKF_A[s]
        for (let i = 0; i < n; i++) {
          let acc = 0
          for (let j = 0; j < s; j++) { const aj = a[j]; if (aj !== 0) acc += aj * K[j][i] }
          ys[i] = y[i] + hs * acc
        }
        call(RKF_C[s] === 1 ? tEnd1 : t + RKF_C[s] * hs, ys, K[s])
      }
      let e = 0
      for (let i = 0; i < n; i++) {
        let acc = 0
        for (let j = 5; j < 13; j++) { const bj = RKF_B[j]; if (bj !== 0) acc += bj * K[j][i] }
        yNew[i] = y[i] + hs * acc
        const sk = atol[i] + rtol[i] * Math.max(Math.abs(y[i]), Math.abs(yNew[i]))
        const ei = h * RKF_E * (K[0][i] + K[10][i] - K[11][i] - K[12][i])
        e += (ei / sk) ** 2
      }
      err = Math.sqrt(e / n)
    }

    if (!Number.isFinite(err)) {
      // 力模型给出非有限值：缩步重试，缩到下限仍不行就报错
      nreject++; reject = true
      h *= 0.25
      if (h < Math.max(hmin, 1e-12 * Math.max(1, Math.abs(t)))) throw new Error('积分失败：右端函数在 t = ' + t + ' 附近给出非有限值')
      continue
    }

    const fac11 = Math.pow(err, M.errExp)
    let fac = Math.max(1 / M.facMax, Math.min(1 / M.facMin, fac11 / M.safety))
    if (err <= 1) {
      // 误差合格
      if (meth === 'RKF78') call(tEnd1, yNew, fNew)
      const tEnd = last ? t1 : (atBp ? bps[ib] : t + hs)   // 落点钉到 t1 / 跳变时刻，免得浮点累加差一点
      const step = makeStep(meth, rhs, nfev, t, tEnd, y, yNew, K, f, fNew, o.secondOrder)
      let gNew = null
      if (discs.length) {
        // 开关函数变号：定位零点，零点不贴着两端就截短重做
        gNew = discs.map((g) => g(tEnd, yNew))
        let tc = null
        for (let i = 0; i < discs.length; i++) {
          const ga = gVal[i], gb = gNew[i]
          if ((ga < 0 && gb > 0) || (ga > 0 && gb < 0)) {
            const g = discs[i]
            const root = brent((tt) => g(tt, step.interp(tt)), t, tEnd, ga, gb, discTol, 200)
            if (tc === null || dir * (root - tc) < 0) tc = root
          }
        }
        if (tc !== null && Math.abs(tc - t) > 10 * discTol && Math.abs(tEnd - tc) > 10 * discTol) {
          if (!(hResume > 0)) hResume = h
          h = Math.abs(tc - t) + 5 * discTol
          ntrunc++
          continue
        }
      }
      t = tEnd
      y = Float64Array.from(yNew)
      f = Float64Array.from(fNew)
      if (atBp) {
        // 越过跳变：下一步的首级取跳变「之后」一侧（稠密输出已用跳变前的步末导数建好）
        ib++
        call(t + dir * bpEps(t), y, f)
      }
      if (gNew) gVal = gNew
      nsteps++
      const cont = onStep ? onStep(step) : true
      if (cont === false) { st.stopped = true; break }
      if (last) break
      let hNew = h / fac
      if (reject) hNew = Math.min(hNew, h)
      reject = false
      if (hResume > 0) { hNew = hResume; hResume = 0 }      // 截短步之后恢复原提议
      h = Math.min(hNew, hmax)
      if (hmin > 0 && h < hmin) h = hmin
    } else {
      nreject++
      reject = true
      h = h / Math.min(1 / M.facMin, fac11 / M.safety)
      if (hmin > 0 && h < hmin) throw new Error('积分失败：步长缩到下限 ' + hmin + ' 仍不满足容差（t = ' + t + '）')
      if (h < 1e-12 * Math.max(1, Math.abs(t))) throw new Error('积分失败：步长过小（t = ' + t + '）')
    }
  }
  st.t = t; st.y = y; st.nfev = nfev.n; st.nsteps = nsteps; st.nreject = nreject; st.ntrunc = ntrunc
  return st
}

// 接受步 → 步对象（含稠密输出）。DOP853 的 3 个附加级在首次插值时才算（无输出 / 无事件的步不花这 3 次）。
function makeStep(meth, rhs, nfev, ta, tb, ya, yb, K, fa, fb, secondOrder) {
  const n = ya.length
  const step = { t0: ta, t1: tb, y0: Float64Array.from(ya), y1: Float64Array.from(yb), f0: Float64Array.from(fa), f1: Float64Array.from(fb), interp: null }
  const h = tb - ta
  if (meth === 'DOP853') {
    // K 会被下一步覆盖：先拷走前 13 级
    const Ks = []
    for (let s = 0; s < 13; s++) Ks.push(Float64Array.from(K[s]))
    let F = null
    const build = () => {
      const ys = new Float64Array(n)
      for (let s = 13; s < 16; s++) {
        const a = DOP_A[s]
        for (let i = 0; i < n; i++) {
          let acc = 0
          for (let j = 0; j < s; j++) { const aj = a[j]; if (aj !== 0) acc += aj * Ks[j][i] }
          ys[i] = step.y0[i] + h * acc
        }
        const k = new Float64Array(n)
        nfev.n++
        rhs(ta + DOP_C[s] * h, ys, k)
        Ks.push(k)
      }
      F = []
      for (let r = 0; r < 7; r++) F.push(new Float64Array(n))
      for (let i = 0; i < n; i++) {
        const dy = step.y1[i] - step.y0[i]
        F[0][i] = dy
        F[1][i] = h * step.f0[i] - dy
        F[2][i] = 2 * dy - h * (step.f1[i] + step.f0[i])
        for (let r = 0; r < 4; r++) {
          const d = DOP_D[r]
          let acc = 0
          for (let j = 0; j < 16; j++) { const dj = d[j]; if (dj !== 0) acc += dj * Ks[j][i] }
          F[3 + r][i] = h * acc
        }
      }
    }
    step.interp = (t, out) => {
      if (!F) build()
      const x = h === 0 ? 0 : (t - ta) / h, x1 = 1 - x
      const o = out || new Float64Array(n)
      for (let i = 0; i < n; i++) {
        o[i] = step.y0[i] + x * (F[0][i] + x1 * (F[1][i] + x * (F[2][i] + x1 * (F[3][i] + x * (F[4][i] + x1 * (F[5][i] + x * F[6][i]))))))
      }
      return o
    }
  } else if (secondOrder && n % 2 === 0) {
    // 五次 Hermite：位置用两端 r, v(=f 前半), a(=f 后半)；速度取其导数
    const m = n / 2
    step.interp = (t, out) => {
      const x = h === 0 ? 0 : (t - ta) / h
      const x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x
      const H0 = 1 - 10 * x3 + 15 * x4 - 6 * x5, H1 = x - 6 * x3 + 8 * x4 - 3 * x5, H2 = 0.5 * (x2 - 3 * x3 + 3 * x4 - x5)
      const H3 = 10 * x3 - 15 * x4 + 6 * x5, H4 = -4 * x3 + 7 * x4 - 3 * x5, H5 = 0.5 * (x3 - 2 * x4 + x5)
      const D0 = -30 * x2 + 60 * x3 - 30 * x4, D1 = 1 - 18 * x2 + 32 * x3 - 15 * x4, D2 = 0.5 * (2 * x - 9 * x2 + 12 * x3 - 5 * x4)
      const D3 = -D0, D4 = -12 * x2 + 28 * x3 - 15 * x4, D5 = 0.5 * (3 * x2 - 8 * x3 + 5 * x4)
      const o = out || new Float64Array(n)
      for (let i = 0; i < m; i++) {
        const r0 = step.y0[i], v0 = step.y0[m + i], a0 = step.f0[m + i]
        const r1 = step.y1[i], v1 = step.y1[m + i], a1 = step.f1[m + i]
        o[i] = H0 * r0 + H1 * h * v0 + H2 * h * h * a0 + H3 * r1 + H4 * h * v1 + H5 * h * h * a1
        o[m + i] = h === 0 ? v0 : (D0 * r0 + D1 * h * v0 + D2 * h * h * a0 + D3 * r1 + D4 * h * v1 + D5 * h * h * a1) / h
      }
      return o
    }
  } else {
    // 三次 Hermite
    step.interp = (t, out) => {
      const x = h === 0 ? 0 : (t - ta) / h
      const x2 = x * x, x3 = x2 * x
      const h00 = 2 * x3 - 3 * x2 + 1, h10 = x3 - 2 * x2 + x, h01 = -2 * x3 + 3 * x2, h11 = x3 - x2
      const o = out || new Float64Array(n)
      for (let i = 0; i < n; i++) o[i] = h00 * step.y0[i] + h10 * h * step.f0[i] + h01 * step.y1[i] + h11 * h * step.f1[i]
      return o
    }
  }
  return step
}

/* ===================== Brent 求根（Brent 1973, zeroin） ===================== */
function brent(fn, a, b, fa, fb, tol, maxIter) {
  let c = a, fc = fa, d = b - a, e = d
  for (let it = 0; it < (maxIter || 100); it++) {
    if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) { c = a; fc = fa; d = b - a; e = d }
    if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tol
    const xm = 0.5 * (c - b)
    if (Math.abs(xm) <= tol1 || fb === 0) return b
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      let p, q, r
      const s = fb / fa
      if (a === c) { p = 2 * xm * s; q = 1 - s } else {
        q = fa / fc; r = fb / fc
        p = s * (2 * xm * q * (q - r) - (b - a) * (r - 1))
        q = (q - 1) * (r - 1) * (s - 1)
      }
      if (p > 0) q = -q; else p = -p
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q } else { d = xm; e = d }
    } else { d = xm; e = d }
    a = b; fa = fb
    b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1)
    fb = fn(b)
  }
  return b
}

/* ===================== 轨道传播 ===================== */
const vec3 = (p) => Array.isArray(p) || ArrayBuffer.isView(p) ? [Number(p[0]), Number(p[1]), Number(p[2])] : [Number(p.x), Number(p.y), Number(p.z)]

// UTC 毫秒 ↔ 自起点起的 TAI 秒。整段无闰秒（绝大多数情形）走常数偏移的快路。
function makeTimeMap(t0Ms, t1Ms) {
  const l0 = T.taiMinusUtc(t0Ms)
  const tai0 = t0Ms + l0 * 1000
  const uniform = T.taiMinusUtc(t1Ms) === l0
  return {
    utc: uniform ? (s) => t0Ms + s * 1000 : (s) => T.utcMsFrom({ system: 'TAI', ms: tai0 + s * 1000 }),
    sec: uniform ? (ms) => (ms - t0Ms) / 1000 : (ms) => (T.msInSystem(ms, 'TAI') - tai0) / 1000
  }
}

function propagate(state0, forceModel, opts) {
  const o = opts || {}
  const t0Ms = Number(state0 && state0.tMs)
  const tEndMs = Number(o.tEndMs)
  if (!Number.isFinite(t0Ms) || !Number.isFinite(tEndMs)) throw new Error('propagate：state0.tMs 与 tEndMs 必须是有限的 UTC 毫秒')
  const r0 = vec3(state0.r), v0 = vec3(state0.v)
  if (![...r0, ...v0].every(Number.isFinite)) throw new Error('propagate：初始位置 / 速度含非有限值')
  const acc = typeof forceModel === 'function' ? forceModel
    : (forceModel && typeof forceModel.acceleration === 'function') ? forceModel.acceleration.bind(forceModel) : null
  if (!acc) throw new Error('propagate：forceModel 须为函数或带 acceleration 方法的对象')

  const tm = makeTimeMap(t0Ms, tEndMs)
  const dirMs = tEndMs >= t0Ms ? 1 : -1
  const outStepMs = Math.abs(o.outStepSec > 0 ? o.outStepSec : 60) * 1000
  // 输出网格（UTC 毫秒）：t0、t0 ± k·Δ…，末点补 tEndMs
  const outT = []
  for (let k = 0; ; k++) {
    const tk = t0Ms + dirMs * k * outStepMs
    if (dirMs * (tk - tEndMs) > -1e-6) break
    outT.push(tk)
  }
  outT.push(tEndMs)
  const sEnd = tm.sec(tEndMs)

  const rTmp = [0, 0, 0], vTmp = [0, 0, 0]
  const rhs = (s, y, dy) => {
    rTmp[0] = y[0]; rTmp[1] = y[1]; rTmp[2] = y[2]
    vTmp[0] = y[3]; vTmp[1] = y[4]; vTmp[2] = y[5]
    const a = acc(tm.utc(s), rTmp, vTmp)
    dy[0] = y[3]; dy[1] = y[4]; dy[2] = y[5]
    dy[3] = a[0]; dy[4] = a[1]; dy[5] = a[2]
  }

  const rtol = o.rtol > 0 ? o.rtol : 1e-12
  const aP = o.atolPos > 0 ? o.atolPos : 1e-9       // km（1 µm）
  const aV = o.atolVel > 0 ? o.atolVel : 1e-12      // km/s（1 nm/s）
  // 力模型的不光滑点 / 跳变时刻（地影边界、空间天气日界）：交给积分器，步不跨过
  const fmObj = typeof forceModel === 'function' ? null : forceModel
  const discs = fmObj && Array.isArray(fmObj.discontinuities) ? fmObj.discontinuities : []
  const rG = [0, 0, 0], vG = [0, 0, 0]
  const gWrap = (g) => (s, y) => { rG[0] = y[0]; rG[1] = y[1]; rG[2] = y[2]; vG[0] = y[3]; vG[1] = y[4]; vG[2] = y[5]; return g(tm.utc(s), rG, vG) }
  const bpMs = fmObj && typeof fmObj.breakpoints === 'function' ? fmObj.breakpoints(Math.min(t0Ms, tEndMs), Math.max(t0Ms, tEndMs)) : []
  const intOpts = {
    discontinuities: discs.map(gWrap),
    breakpoints: bpMs.map((ms) => tm.sec(ms)),
    method: o.integrator || 'DOP853',
    rtol, atol: [aP, aP, aP, aV, aV, aV],
    maxStep: o.maxStepSec > 0 ? o.maxStepSec : undefined,
    minStep: o.minStepSec > 0 ? o.minStepSec : undefined,
    initialStep: o.initialStepSec > 0 ? o.initialStepSec : undefined,
    maxSteps: o.maxSteps,
    secondOrder: true
  }

  const out = []
  const push = (tMs, y) => out.push({ tMs, r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] })
  const y0 = [r0[0], r0[1], r0[2], v0[0], v0[1], v0[2]]
  push(outT[0], y0)
  let iOut = 1
  if (outT.length === 2 && outT[1] === outT[0]) { out.events = []; out.stats = { nsteps: 0, nreject: 0, nfev: 0 }; return out }

  // 事件
  const evs = Array.isArray(o.events) ? o.events : []
  const maxCheck = o.maxCheckSec > 0 ? o.maxCheckSec : 60
  const evTol = o.eventTolSec > 0 ? o.eventTolSec : 1e-6
  const found = []
  const gAt = (e, s, y) => { rTmp[0] = y[0]; rTmp[1] = y[1]; rTmp[2] = y[2]; vTmp[0] = y[3]; vTmp[1] = y[4]; vTmp[2] = y[5]; return Number(e.g(tm.utc(s), rTmp, vTmp)) }
  const gPrev = evs.map((e) => gAt(e, 0, y0))
  let stopAt = null
  const yTmp = new Float64Array(6), yB = new Float64Array(6), yR = new Float64Array(6)

  const onStep = (step) => {
    // 1) 事件：在 [t0, t1] 内分段查变号（g 恰为 0 的点算在左段，下一段从 0 出发不再重复计）
    if (evs.length) {
      const nSub = Math.max(1, Math.ceil(Math.abs(step.t1 - step.t0) / maxCheck))
      let sa = step.t0
      for (let k = 1; k <= nSub && !stopAt; k++) {
        const sb = k === nSub ? step.t1 : step.t0 + (step.t1 - step.t0) * k / nSub
        const yb = k === nSub ? step.y1 : step.interp(sb, yB)
        const hits = []
        for (let ei = 0; ei < evs.length; ei++) {
          const e = evs[ei]
          const ga = gPrev[ei], gb = gAt(e, sb, yb)
          const crossed = (ga < 0 && gb >= 0) || (ga > 0 && gb <= 0)
          if (crossed) {
            const inc = gb > ga
            const want = !e.direction || (e.direction > 0 && inc) || (e.direction < 0 && !inc)
            if (want) {
              const fn = (s) => gAt(e, s, step.interp(s, yR))
              const root = brent(fn, sa, sb, ga, gb, evTol, 200)
              hits.push({ ei, s: root, inc })
            }
          }
          gPrev[ei] = gb
        }
        if (hits.length) {
          hits.sort((p, q) => (p.s - q.s) * (step.t1 >= step.t0 ? 1 : -1))
          for (const hgt of hits) {
            const ye = step.interp(hgt.s, new Float64Array(6))
            const e = evs[hgt.ei]
            found.push({ name: e.name, tMs: tm.utc(hgt.s), r: [ye[0], ye[1], ye[2]], v: [ye[3], ye[4], ye[5]], increasing: hgt.inc })
            if (e.terminal) { stopAt = { s: hgt.s, y: ye }; break }
          }
        }
        sa = sb
      }
    }
    // 2) 输出网格点
    const tLimit = stopAt ? stopAt.s : step.t1
    while (iOut < outT.length) {
      const s = iOut === outT.length - 1 ? sEnd : tm.sec(outT[iOut])
      if ((step.t1 >= step.t0 ? s > tLimit : s < tLimit)) break
      const yv = (s === step.t1) ? step.y1 : step.interp(s, yTmp)
      push(outT[iOut], yv)
      iOut++
    }
    if (stopAt) {
      const last = found[found.length - 1]
      if (!out.length || out[out.length - 1].tMs !== last.tMs) push(last.tMs, stopAt.y)
      return false
    }
    return true
  }

  const st = integrate(rhs, 0, y0, sEnd, intOpts, onStep)
  // 末步若因浮点没把最后一个网格点吃进来，补上终点
  if (!stopAt && iOut < outT.length) { for (; iOut < outT.length; iOut++) push(outT[iOut], st.y) }
  out.events = found
  out.stats = { nsteps: st.nsteps, nreject: st.nreject, ntrunc: st.ntrunc, nfev: st.nfev }
  return out
}

/* ===================== 输出转星历表 spec ===================== */
function toEphemSpec(states) {
  const n = states.length
  const t = new Float64Array(n), p = new Float64Array(3 * n), v = new Float64Array(3 * n)
  for (let k = 0; k < n; k++) {
    const s = states[k]
    t[k] = s.tMs
    p[3 * k] = s.r[0]; p[3 * k + 1] = s.r[1]; p[3 * k + 2] = s.r[2]
    v[3 * k] = s.v[0]; v[3 * k + 1] = s.v[1]; v[3 * k + 2] = s.v[2]
  }
  return { t, p, v, frame: 'J2000' }
}

module.exports = {
  propagate, integrate, toEphemSpec, brent,
  // 系数表（测试核对阶条件用）
  DOP853: { C: DOP_C, A: DOP_A, B: DOP_B, E3: DOP_E3, E5: DOP_E5, D: DOP_D },
  RKF78: { C: RKF_C, A: RKF_A, B: RKF_B, E: RKF_E }
}
