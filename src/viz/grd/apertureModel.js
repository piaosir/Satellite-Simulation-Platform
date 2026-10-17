// 口径照射解析天线模型（E-01）：圆口径「抛物面加台阶」照射的闭式远场 + 偏置反射面交叉极化 + 表面误差散射 + ITU 包络下界。
//
// 渲染端 ESM 原件；主进程 CommonJS 镜像：packages/core/utils/apertureModel.js（Vite 不转本地 CJS，故两份；函数体逐字相同，
// packages/core/test/apertureModel.test.mjs 逐位对拍）。改这里必须两处同改。生成侧（记录怎么造）在 gaussStk.buildApertureRecord
// 与 synth.reflApertureOf，这里只管【求值】——渲染端 coverage.samplePowAt 与主进程 grdSampler.sampleBeamAt 的解析分支都落在 apEval。
//
// ── 1. 口径照射与共极化远场（parabolic-on-pedestal，Balanis §15.4.2 / Silver §6.6；与 synth.solveReflector 同一个 p）──
//   口径场 E(ρ) = p + q·(1 − ρ²)，q = 1 − p，ρ = r/a ∈ [0,1]，p = 边缘照射电压比（solveReflector 解出的 core.p，θ3 与效率同源）。
//   Hankel 变换：∫₀¹ (1−ρ²)ⁿ J₀(uρ) ρ dρ = Λₙ₊₁(u)/(2(n+1))，Λₙ(u) = n!·(2/u)ⁿ·Jₙ(u)（Λₙ(0) = 1）。
//   ⇒ 归一化远场 F(u) = (2p·Λ₁(u) + q·Λ₂(u)) / (2p + q)，u = (πD/λ)·sinθ，θ = 偏离【本波束视轴】的真实锥角（不是 az/el 网格坐标差）。
//   共极化增益 G_co(θ) = G₀·F(u)²·((1 + cosθ)/2)²（Huygens 口径辐射斜率因子；θ ≤ 90° 有效，θ > 90° 取背瓣常数 back dBi）。
//   G₀ = 生成时的峰值增益（solveReflector 方向性 − 表面误差相干损失 − 扫描像差损失，见 gaussStk.buildApertureRecord）。
//   旁瓣、零点按 Bessel 闭式自然出来，【不截窗】：渲染端 / 主进程取值只认方向，不认物化网格的窗口（见 nowin）。
//
// ── 2. 交叉极化（偏置反射面去极化）──
//   线极化：Chu & Turrin, "Depolarization properties of offset reflector antennas", IEEE TAP-21(3), 1973。平衡馈源（Huygens 源）
//   经偏置抛物面后口径场仍是线极化，只是逐点旋转了 χ：以偏置面为对称面、y 垂直于它，一阶 χ ≈ κ·y，κ = sinθ₀/(2F)
//   （θ₀ = 馈源轴相对母抛物面轴的偏角，取反射面中心张角 θc；推导：馈源 Ludwig-3 基与母抛物面 Ludwig-3 基之间的平行移动角
//    β = sinθf·sinφf·[(1+cosθf)sinθ₀ − sinθf·cosφf(1−cosθ₀)] / [(1+cosθf)(1+cosθ₀cosθf − sinθ₀sinθf cosφf)]，
//    对 θf 取一阶 β ≈ tan(θ₀/2)·θf·sinφf，再以 y ≈ ρ₀·θf·sinφf、ρ₀ = 2F/(1+cosθ₀) 换到口径坐标）。
//   口径交叉极化分量 = κ·y·E_co(x,y) ⇒ 远场 E_cx = κ·(−j∂/∂k_y)E_co = −j·κ·a·F′(u)·sinφ（a = D/2，φ 自对称面量起）。
//   F′(u) = −u·G₂(u)，G₂(u) = (p·Λ₂/2 + q·Λ₃/6)/(2p + q)（dΛ₁/du = −u·Λ₂/4，dΛ₂/du = −u·Λ₃/6）⇒
//   E_cx = j·X·(πD/λ)·G₂(u)·(û·ê⊥)，X = D·sinθ₀/(4F)（ê⊥ = 视轴处垂直于对称面的单位矢量）。在 θ→0 处光滑、在对称面内为零，
//   峰值在主瓣 −4…−6 dB 附近；对称（θ₀ = 0，正馈）时 X = 0、无交叉极化。与共极化相位正交（口径同相、远场差 j）。
//   圆极化：Adatia & Rudge, "Beam squint in circularly polarised offset-reflector antennas", Electron. Lett. 11(21), 1975。
//   同一去极化旋转 χ 对圆极化只是相位 e^{∓jχ}（Huygens 馈源下严格无交叉极化），一阶线性相位 ⇒ 波束沿 ê⊥ 斜视
//   ψs = asin(λ·sinθ₀/(4πF))，右旋 / 左旋方向相反（正负号随偏置朝向约定：右旋取 +ê⊥）。
//
// ── 3. 表面误差（Ruze, "Antenna tolerance theory — a review", Proc. IEEE 54(4), 1966）──
//   随机表面误差 rms ε、相关长度 c：相位误差 δ = 4πε/λ（浅反射面往返）。相干部分 × e^{−δ²}（已并入 G₀），散射部分
//   G_sc(θ) = η_spill·(2πc/λ)²·e^{−δ²}·Σₙ δ^{2n}/(n·n!)·exp(−(πc·sinθ/λ)²/n)，按口径 ∫|A|² 归一时与照射锥度无关
//   （散射总功率 = η_spill·(1 − e^{−δ²})，与相干损失恰好互补）。散射按非相干功率加到共极化上——填零点、抬远旁瓣地板。
//
// ── 4. ITU 包络下界（可选）──
//   ITU-R S.672-4 recommends 1（GSO 单馈源圆 / 椭圆波束设计目标）与 S.1528-1 §1.2（NGSO，同族 LN 型）。圆波束 z = 1 时
//   a = 2.58、b = 6.32，两者只在主瓣段指数 α 不同（2 / 1.5）；本模型只在主瓣段之外（ψ > a·ψb）以包络为下界：
//   G = Gm + LN（a·ψb < ψ ≤ b·ψb）、X − 25·lg ψ（b·ψb < ψ ≤ Y）、LF = 0 dBi（Y < ψ ≤ 90°）、LB（ψ > 90°），
//   X = Gm + LN + 25·lg(b·ψb)，Y = b·ψb·10^{0.04(Gm + LN − LF)}，LB = max(15 + LN + 0.25·Gm, 0)。ψb = θ3/2，Gm = G₀。
//   主瓣内取物理图（包络主瓣段只是抛物线近似，拿它当下界会把波束撑宽）。
//
// ── 5. 分量与极化基（与 GRD icomp 同口径，见 polKernel.js 头注）──
//   记录 basis 'l3'（icomp 3，Ludwig-3，参考轴 = 天线系 x）：linX 共极化落分量 1、交叉落分量 2；linY 反之；圆极化波束
//   按 R̂ = (x̂ − jŷ)/√2、L̂ = (x̂ + jŷ)/√2 摊到两分量。basis 'circ'（icomp 2，RHC/LHC）：rhcp 落分量 1、lhcp 落分量 2。
//   输出 (re1, im1, re2, im2) 按 √(线性增益) 定标：|c1|² + |c2|² = 该方向总增益。

export const AP_WIN = 2.5                          // 物化网格（只给填充 / 等值线 / 数组消费者）半宽 = 2.5θ3：含主瓣与第一旁瓣；取值不受它限
export const AP_MODEL = 'aperture'
const D2R = Math.PI / 180
const SQ1_2 = Math.SQRT1_2

// ---------------- Bessel：Λ₁, Λ₂, Λ₃ 一次算出 ----------------
// u < 13：幂级数 Λₙ(u) = n!·Σₖ (−u²/4)ᵏ / (k!(k+n)!)（不除 u、无相消，u → 0 精确）。u ≥ 13：Hankel 渐近式求 J₀、J₁
// （A&S 9.2.5–9.2.10，项递推 aₖ = aₖ₋₁·(μ − (2k−1)²)/(8k)，取到最小项为止），再前向递推 J₂ = 2J₁/u − J₀、J₃ = 4J₂/u − J₁
// （阶数 < 宗量时前向递推稳定）。两段交界处相对误差 < 1e-10。
function hankelJ(nu, x, out) {
  const mu = 4 * nu * nu, ix = 1 / x
  let P = 1, Q = 0, a = 1, prev = Infinity, xp = 1
  for (let k = 1; k < 40; k++) {
    a = a * (mu - (2 * k - 1) * (2 * k - 1)) / (8 * k)
    xp *= ix
    const term = a * xp
    const at = Math.abs(term)
    if (at > prev || at < 1e-17) break
    prev = at
    // k 奇 → Q 的 (−1)^((k−1)/2) 项；k 偶 → P 的 (−1)^(k/2) 项
    if (k & 1) Q += ((k - 1) / 2) & 1 ? -term : term
    else P += (k / 2) & 1 ? -term : term
  }
  const chi = x - (nu / 2 + 0.25) * Math.PI
  out[0] = Math.sqrt(2 / (Math.PI * x)) * (P * Math.cos(chi) - Q * Math.sin(chi))
  return out[0]
}
const _hj = new Float64Array(1)
export function lambdas(u, out) {
  const x = u < 0 ? -u : u
  if (x < 13) {
    const t = x * x / 4
    let s1 = 0, s2 = 0, s3 = 0, a1 = 1, a2 = 0.5, a3 = 1 / 6
    for (let k = 0; k < 80; k++) {
      s1 += a1; s2 += a2; s3 += a3
      const f = -t / (k + 1)
      a1 *= f / (k + 2); a2 *= f / (k + 3); a3 *= f / (k + 4)
      if (k > t && Math.abs(a1) < 1e-18 && Math.abs(a2) < 1e-18 && Math.abs(a3) < 1e-18) break
    }
    out[0] = s1; out[1] = 2 * s2; out[2] = 6 * s3
    return out
  }
  const j0 = hankelJ(0, x, _hj), j1 = hankelJ(1, x, _hj)
  const j2 = 2 * j1 / x - j0, j3 = 4 * j2 / x - j1
  out[0] = 2 * j1 / x; out[1] = 8 * j2 / (x * x); out[2] = 48 * j3 / (x * x * x)
  return out
}

// ---------------- 照射核 ----------------
const _L = new Float64Array(3)
// 归一化共极化远场 F(u)（F(0) = 1）
export function apF(u, p) { const q = 1 - p; lambdas(u, _L); return (2 * p * _L[0] + q * _L[1]) / (2 * p + q) }
// 交叉极化核 G₂(u)：F′(u) = −u·G₂(u)
export function apG2(u, p) { const q = 1 - p; lambdas(u, _L); return (p * _L[1] / 2 + q * _L[2] / 6) / (2 * p + q) }
// 两支同照射波束的重叠积分核（自相关定理）：∫g(s−sⱼ)g(s−sₖ)d²s = Ω₁·Qn(u)，u = (πD/λ)·|sⱼ − sₖ|，
// Qn(u) = (p²Λ₁ + pqΛ₂ + q²Λ₃/3)/(p² + pq + q²/3)，Ω₁ = λ²/(A·η_taper)（单支波束立体角）
export function apQn(u, p) { const q = 1 - p; lambdas(u, _L); return (p * p * _L[0] + p * q * _L[1] + q * q * _L[2] / 3) / (p * p + p * q + q * q / 3) }
// 照射（锥度）效率 η_taper = (p + q/2)²/(p² + pq + q²/3)（与 synth._etaTaper 同式）
export function apEtaTaper(p) { const q = 1 - p; return (p + q / 2) ** 2 / (p * p + p * q + q * q / 3) }
// 半功率点 u_h：F(u_h)² = 1/2（二分，60 次）。θ3 = 2·asin(u_h·λ/(πD))
export function apUh(p) {
  let lo = 0.5, hi = 3.5
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2, f = apF(m, p); if (f * f > 0.5) lo = m; else hi = m }
  return (lo + hi) / 2
}

// ---------------- ITU 包络下界（主瓣段之外）----------------
// env = { t:'s672'|'s1528', ln, gm, pb }（ln = LN dB，gm = Gm dBi，pb = ψb 度）。返回下界 dBi；主瓣段（ψ ≤ a·ψb）返回 −Infinity。
export function envFloorDbi(env, psiDeg) {
  const pb = env.pb, a = 2.58, b = 6.32
  if (!(psiDeg > a * pb)) return -Infinity
  if (psiDeg > 90) return Math.max(15 + env.ln + 0.25 * env.gm, 0)
  if (psiDeg <= b * pb) return env.gm + env.ln
  const Y = b * pb * Math.pow(10, 0.04 * (env.gm + env.ln))
  if (psiDeg <= Y) return env.gm + env.ln + 25 * Math.log10(b * pb) - 25 * Math.log10(psiDeg)
  return 0
}

// ---------------- 表面误差散射（Ruze）----------------
// rz = { a, b, d2 }：a = η_spill·(2πc/λ)²·e^{−δ²}（线性），b = (πc/λ)²，d2 = δ²。返回散射增益（线性），s = sinθ。
export function rzScatter(rz, s) {
  const s2 = s * s
  let sum = 0, pw = 1, fact = 1
  for (let n = 1; n <= 30; n++) {
    pw *= rz.d2; fact *= n
    const c = pw / (n * fact)
    sum += c * Math.exp(-rz.b * s2 / n)
    if (c < 1e-16 * sum) break
  }
  return rz.a * sum
}

// ---------------- 记录 → 求值描述子 ----------------
// b：记录里的单个波束（扁平参数，见 gaussStk.buildApertureRecord）：
//   { az, el, th3, g0, kD, p, pol, basis, xp, sq, sym, rz, env, back }
//   az/el = 视轴（igrid-6 网格坐标，°）；kD = πD/λ（仿真频率）；xp = X = D·sinθ₀/(4F)；sq = 圆极化斜视角（rad）；
//   sym = 偏置对称面 'ew'（含天线系 x 轴）| 'ns'（含 y 轴）。
function dir6(X, Y) { const az = X * D2R, el = Y * D2R, ca = Math.cos(az); return [-Math.sin(az), ca * Math.sin(el), ca * Math.cos(el)] }
function frameAt(bx, by, bz, sym) {
  const rx = sym === 'ns' ? 0 : 1, ry = sym === 'ns' ? 1 : 0
  const d = rx * bx + ry * by
  let ex = rx - d * bx, ey = ry - d * by, ez = -d * bz
  const l = Math.hypot(ex, ey, ez) || 1
  ex /= l; ey /= l; ez /= l
  return [ex, ey, ez, by * ez - bz * ey, bz * ex - bx * ez, bx * ey - by * ex]   // ê_sym, ê⊥ = b̂ × ê_sym
}
export function apBeamOf(b, win) {
  let ax = dir6(+b.az, +b.el)
  const pol = b.pol === 'linY' || b.pol === 'rhcp' || b.pol === 'lhcp' ? b.pol : 'linX'
  const cp = pol === 'rhcp' || pol === 'lhcp'
  const sym = b.sym === 'ns' ? 'ns' : 'ew'
  let fr = frameAt(ax[0], ax[1], ax[2], sym)
  const sq = cp && Number.isFinite(+b.sq) ? +b.sq : 0
  if (sq) {                                        // 圆极化斜视：视轴沿 ±ê⊥ 偏 ψs（右旋 +、左旋 −），再在新视轴处重建标架
    const sg = pol === 'rhcp' ? 1 : -1, c = Math.cos(sq), s = Math.sin(sq) * sg
    const nx = ax[0] * c + fr[3] * s, ny = ax[1] * c + fr[4] * s, nz = ax[2] * c + fr[5] * s, l = Math.hypot(nx, ny, nz)
    ax = [nx / l, ny / l, nz / l]
    fr = frameAt(ax[0], ax[1], ax[2], sym)
  }
  const p = Math.max(0, Math.min(1, +b.p)), q = 1 - p
  const basis = b.basis === 'circ' ? 'circ' : 'l3'
  const coSlot = basis === 'circ' ? (pol === 'lhcp' ? 2 : 1) : (pol === 'linY' ? 2 : 1)
  const g0 = +b.g0, back = Number.isFinite(+b.back) ? +b.back : -30
  const rz = b.rz && +b.rz.d2 > 0 && +b.rz.a > 0 ? { a: +b.rz.a, b: +b.rz.b, d2: +b.rz.d2 } : null
  const env = b.env && (b.env.t === 's672' || b.env.t === 's1528') && Number.isFinite(+b.env.ln) && Number.isFinite(+b.env.gm) && +b.env.pb > 0
    ? { t: b.env.t, ln: +b.env.ln, gm: +b.env.gm, pb: +b.env.pb } : null
  // 视轴（可能已斜视）回到 igrid-6 坐标：窗口居中、峰值落点都按它
  const elOut = Math.atan2(ax[1], ax[2]) / D2R, azOut = Math.atan2(-ax[0], Math.hypot(ax[1], ax[2])) / D2R
  // g0 = 视轴上的【总】增益（相干 + 散射），相干部分 = g0 − 视轴散射 → 视轴处恰为 g0（refinedPeakDb / peakDb 直接取 g0）
  const g0lin = Math.pow(10, g0 / 10), coh = Math.max(0, g0lin - (rz ? rzScatter(rz, 0) : 0))
  return {
    kind: AP_MODEL, nowin: true, igrid: 6, az: azOut, el: elOut, th3: +b.th3, g0, back, win: +win > 0 ? +win : AP_WIN,
    bx: ax[0], by: ax[1], bz: ax[2], sx: fr[3], sy: fr[4], sz: fr[5],
    kD: +b.kD, p, q, N: 2 * p + q, amp0: Math.sqrt(coh), ampB: Math.sqrt(Math.pow(10, back / 10)),
    xpA: cp ? 0 : (Number.isFinite(+b.xp) ? +b.xp : 0) * +b.kD,
    pol, cp, basis, coSlot, rz, env
  }
}

// 天线系单位矢量 û 方向的四分量复场 → out[0..3] = re1, im1, re2, im2（√线性增益定标）
export function apEval(an, ux, uy, uz, out) {
  const c = ux * an.bx + uy * an.by + uz * an.bz
  const cx = uy * an.bz - uz * an.by, cy = uz * an.bx - ux * an.bz, cz = ux * an.by - uy * an.bx
  const s = Math.sqrt(cx * cx + cy * cy + cz * cz)                // sinθ（θ = 偏离视轴的真实锥角）
  let co, xi = 0
  if (c < 0) co = an.ampB                                         // θ > 90°：背瓣常数
  else {
    lambdas(an.kD * s, _L)
    const F = (2 * an.p * _L[0] + an.q * _L[1]) / an.N
    const obl = (1 + c) / 2
    let lin = an.amp0 * an.amp0 * F * F * obl * obl
    if (an.rz) lin += rzScatter(an.rz, s) * obl * obl
    if (an.env) { const fl = envFloorDbi(an.env, Math.atan2(s, c) / D2R); if (fl > -Infinity) { const fv = Math.pow(10, fl / 10); if (lin < fv) lin = fv } }
    co = F < 0 ? -Math.sqrt(lin) : Math.sqrt(lin)
    if (an.xpA) {
      const G2 = (an.p * _L[1] / 2 + an.q * _L[2] / 6) / an.N
      xi = an.amp0 * an.xpA * G2 * (ux * an.sx + uy * an.sy + uz * an.sz) * obl
    }
  }
  if (an.basis === 'circ') {
    if (an.coSlot === 2) { out[0] = 0; out[1] = 0; out[2] = co; out[3] = 0 } else { out[0] = co; out[1] = 0; out[2] = 0; out[3] = 0 }
  } else if (an.cp) {
    out[0] = co * SQ1_2; out[1] = 0; out[2] = 0; out[3] = an.pol === 'rhcp' ? -co * SQ1_2 : co * SQ1_2
  } else if (an.coSlot === 2) { out[0] = 0; out[1] = -xi; out[2] = co; out[3] = 0 } else { out[0] = co; out[1] = 0; out[2] = 0; out[3] = xi }
  return out
}
const _ev = new Float64Array(4)
// 总增益（dBi）
export function apGainDbi(an, ux, uy, uz) {
  apEval(an, ux, uy, uz, _ev)
  const p = _ev[0] * _ev[0] + _ev[1] * _ev[1] + _ev[2] * _ev[2] + _ev[3] * _ev[3]
  return p > 0 ? 10 * Math.log10(p) : -Infinity
}
// igrid-6 网格坐标 (X, Y)（°）处的四分量
export function apEvalXY(an, X, Y, out) {
  const az = X * D2R, el = Y * D2R, ca = Math.cos(az)
  return apEval(an, -Math.sin(az), ca * Math.sin(el), ca * Math.cos(el), out)
}
