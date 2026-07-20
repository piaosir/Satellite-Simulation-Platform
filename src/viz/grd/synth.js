// 波束合成引擎（对齐 TICRA SATSOFT）：程序生成【标准 GRASP .grd 文本】，走现有导入链
// （parseGrd → importedCacheEntry → 存盘）贯通覆盖绘制 / 多波束选绘 / 拖拽指向 / 性能表 /
// GXT/KML/小程序导出 / 链路预算采样，全链路零改动复用。
//
// 高斯波束模型（SATSOFT 手册 §6.6/§6.7 同款）：
//   D(Δ) = D0 · exp[ −4ln2·( (Δx/θx)² + (Δy/θy)² ) ]，θx/θy = 两轴 3dB 全宽（deg）
//   相对电平 dB = −12.0412·( (Δx/θx)² + (Δy/θy)² )；D0 = eff·4π/(θx·θy)（θ 用弧度）
//   无旁瓣；频率不参与高斯场计算（SATSOFT 原文 "not used to compute the beams"），
//   仅用于 口径→波束宽度 换算 θ3dB ≈ 70·λ/D（SATSOFT 把该换算放在反射面模型档）。
// 赋形波束（真实 contoured-beam 合成，与 SATSOFT/TICRA 赋形向导同源）：覆盖区 = 所选 Polygon
//   并集（支持多 Polygon 组合），口径决定成分波束宽度 θ3≈70λ/D；覆盖区上铺馈源格（边界随形
//   环 + 内部六角填充），对各馈源高斯成分波束的同相实激励做迭代加权最小二乘 minimax 优化：
//   区内平顶 / Polygon 边界=覆盖值等值线 / 界外抑制 —— 平顶纹波、口径极限边缘滚降、界外
//   干涉旁瓣与真实赋形一致。定标见 buildShapedGrd（物理积分方向性 | 指定覆盖值反推）。
//
// 网格用 igrid=6（az over el，与校验样本同款）：全部波束共用天底指向 basis，各波束中心
// 以【相对星下点的 az/el】编码在各自 set 的 XS..XE 子窗口（与真实 HTS 多波束 GRD 同构）。
// 场写入 icomp=3（Ludwig-3 co/cx）：分量1 = √P（实部）、其余 0 → P1=|c1|²=共极化，
// 下游 RSS/P1 取值、复场 bicubic 插值（性能表）全部自然成立。
import { antennaBasis, gridDir, project, dirToAzEl, azElGround } from './coverage.js'
import { parseGrd } from './parse.js'

const D2R = Math.PI / 180
const GCOEF = 40 * Math.LN2 / Math.LN10          // 12.0412…：高斯波束相对电平系数

// ---- 参数换算（UI 实时显示用）----
// 口径→3dB 波束宽度：θ3dB ≈ 70·λ/D（deg）。fGHz=频率，Dm=口径直径（米）。
export function theta3dbFromAperture(fGHz, Dm) {
  if (!(fGHz > 0) || !(Dm > 0)) return NaN
  return 70 * (0.299792458 / fGHz) / Dm
}
// 高斯波束峰值方向性 D0 = eff·4π/(θx·θy)（dBi）。effPct=效率（%），θ 为 3dB 全宽（deg）。
export function gaussDirectivityDbi(thX, thY, effPct) {
  const tx = thX * D2R, ty = thY * D2R
  if (!(tx > 0) || !(ty > 0) || !(effPct > 0)) return NaN
  return 10 * Math.log10((effPct / 100) * 4 * Math.PI / (tx * ty))
}
// 相邻波束中心间距 s 下的交叠电平（dB）：中点距各中心 s/2 → −12.04·(s/(2θ))²。s=θ 时 −3.01。
export function crossoverDb(spacing, theta) {
  if (!(spacing > 0) || !(theta > 0)) return NaN
  return -GCOEF * Math.pow(spacing / (2 * theta), 2)
}
// 赋形成分波束 3dB 宽（deg）：θ3 = k(T)·λ/D，k(T) = 1.02 + 0.0135·|T|（rad 系数，经典口径照射
// 锥度-波束宽近似）。T = 馈源边缘锥度 dB（Shaped Reflector 档「Feed Taper」）。缺省 −15 →
// k=1.2225 rad ≈ 70.04·λ/D deg，与旧版固定 70λ/D 实质一致（旧档无 taper 字段，升级后波束宽不变）。
export function shapedTheta3db(fGHz, Dm, taperDb) {
  if (!(fGHz > 0) || !(Dm > 0)) return NaN
  const T = Number.isFinite(taperDb) && taperDb !== 0 ? Math.abs(taperDb) : 15   // 0/空/非数一律回落默认（与 feedGeom 同口径）
  return (1.02 + 0.0135 * T) * (180 / Math.PI) * (0.299792458 / fGHz) / Dm
}
// 赋形档口径效率（照射锥度效率 × 溢出效率，由馈源锥度定死——物理主体，欧姆/表面残差当理想≈1）。
// p = 边缘照射电压比 = 10^(T/20)（T=馈源边缘锥度 dB，<0）；η_taper=parabolic-on-pedestal 闭式（_etaTaper，函数声明已提升）；
// η_spill = 1 − 10^(T/10)（高斯馈源溢出：锥度越深→边缘越暗→溢出越小效率越高）。曲线峰值≈−13dB/~84%，与经典口径天线一致。
export function shapedApertureEff(taperDb) {
  const T = Number.isFinite(taperDb) && taperDb !== 0 ? -Math.abs(taperDb) : -15   // 一律取负（边缘锥度）；0/空回落 −15
  const p = Math.max(1e-3, Math.min(1, Math.pow(10, T / 20)))
  const etaT = _etaTaper(p)
  const etaS = 1 - Math.pow(10, T / 10)
  return { effPct: 100 * etaT * etaS, etaTaper: etaT, etaSpill: etaS, edgeDb: T }
}
// 偏置抛物面 + 高斯波束馈源几何读数（对齐 SATSOFT Shaped Reflector Model 对话框；手册 §6.4 + 附录 A）：
// 口径 D(m)、焦距 F(m)、偏置净空比 clr=XA/D（0=贴轴，-0.5=正馈）。馈源置于焦点、指向反射面中心。
// 反射面下/上缘对父抛物面轴的张角 θ(ρ)=2·atan(ρ/2F)（带符号），馈源轴半张角 θ*=(θ2−θ1)/2。
// 馈源=高斯波束：边缘照射 |T| dB 落在 θ* → 1/e 幅发散角 θ0=θ*/√(|T|/8.686)，束腰 w0=λ/(πθ0)，
// 喇叭口径 d≈3.2·w0（高斯-喇叭耦合 w0≈0.625a 近似）。对照官方对话框（D2/F2.5/clr0.2/T−18/12.2GHz）：
// F/D 1.25 · 均匀口径 3dB 宽 0.70° · λ 2.46cm · 馈源 3.99WL/9.80cm —— 读数逐位吻合。
export function feedGeom({ Dm, focM, fGHz, taperDb = -15, offsetClr = 0.2 }) {
  if (!(Dm > 0) || !(focM > 0) || !(fGHz > 0)) return null
  const clr = Math.max(-0.5, Number.isFinite(offsetClr) ? offsetClr : 0.2)
  const lam = 0.299792458 / fGHz                   // m
  const R2D = 180 / Math.PI
  const x1 = clr * Dm, x2 = clr * Dm + Dm          // 口径下/上缘（父抛物面径向坐标，m）
  const th1 = 2 * Math.atan(x1 / (2 * focM)), th2 = 2 * Math.atan(x2 / (2 * focM))
  const thStar = (th2 - th1) / 2                   // 馈源轴（指向反射面中心）到缘的半张角（rad）
  const T = Math.abs(Number.isFinite(taperDb) && taperDb !== 0 ? taperDb : 15)   // 0/空/非数回落默认（与 shapedTheta3db 同口径）
  const th0 = thStar / Math.sqrt(T / (20 * Math.LOG10E))   // 高斯波束 1/e 幅半角：|T|dB @ θ* 反解
  const w0 = th0 > 0 ? lam / (Math.PI * th0) : NaN         // 束腰半径（m）
  const dFeed = 3.2 * w0                                    // 馈源喇叭口径（m）
  return {
    fd: focM / Dm, lamCm: lam * 100,
    thetaUniDeg: R2D * lam / Dm,                  // 同尺寸均匀口径场 3dB 宽（官方对话框同款读数）
    th1Deg: th1 * R2D, th2Deg: th2 * R2D, thAxisDeg: (th1 + th2) / 2 * R2D,
    feedWl: dFeed / lam, feedCm: dFeed * 100
  }
}

// ============ 解析反射面模型（SATSOFT/AR Multi-Feed Reflector，手册 §6.3.2，Balling AGARD LS-151, 1987）============
// 单偏置抛物面 + 小 TE11 圆馈源阵：口径/馈源几何 → 波束宽·口径效率·方向性【全部算出】，参数互为耦合
// （不再是口径/宽度/效率三个自由框）。对齐官方两组对话框：方向性 <0.3dB、波束宽/馈源间距/间距 <2%
// （口径效率读数偏高 ~7%＝那 0.3dB：PO 积分会多算交叉极化/衍射损耗，解析模型不含——诚实边界）。
// —— Bessel J0/J1（Abramowitz & Stegun 9.4，|误差|<1e-7），J2/J1' 递推 ——
function besselJ0(x) {
  x = Math.abs(x)
  if (x < 3) { const t = (x / 3) ** 2; return 1 - 2.2499997 * t + 1.2656208 * t * t - 0.3163866 * t ** 3 + 0.0444479 * t ** 4 - 0.0039444 * t ** 5 + 0.0002100 * t ** 6 }
  const t = 3 / x, f = 0.79788456 - 0.00000077 * t - 0.00552740 * t * t - 0.00009512 * t ** 3 + 0.00137237 * t ** 4 - 0.00072805 * t ** 5 + 0.00014476 * t ** 6
  const th = x - 0.78539816 - 0.04166397 * t - 0.00003954 * t * t + 0.00262573 * t ** 3 - 0.00054125 * t ** 4 - 0.00029333 * t ** 5 + 0.00013558 * t ** 6
  return f / Math.sqrt(x) * Math.cos(th)
}
function besselJ1(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x)
  if (x < 3) { const t = (x / 3) ** 2; return s * x * (0.5 - 0.56249985 * t + 0.21093573 * t * t - 0.03954289 * t ** 3 + 0.00443319 * t ** 4 - 0.00031761 * t ** 5 + 0.00001109 * t ** 6) }
  const t = 3 / x, f = 0.79788456 + 0.00000156 * t + 0.01659667 * t * t + 0.00017105 * t ** 3 - 0.00249511 * t ** 4 + 0.00113653 * t ** 5 - 0.00020033 * t ** 6
  const th = x - 2.35619449 + 0.12499612 * t + 0.00005650 * t * t - 0.00637879 * t ** 3 + 0.00074348 * t ** 4 + 0.00079824 * t ** 5 - 0.00029166 * t ** 6
  return s * f / Math.sqrt(x) * Math.cos(th)
}
const _J2 = (x) => (Math.abs(x) < 1e-9 ? 0 : 2 * besselJ1(x) / x - besselJ0(x))
const _J1p = (u) => (Math.abs(u) < 1e-9 ? 0.5 : besselJ0(u) - besselJ1(u) / u)   // J1'(u)，u→0 → 1/2
const _X11 = 1.841184                              // J1' 首零（TE11 H 面极点）
// 归一化圆口径场变换核：Λ1=2J1(u)/u（均匀）、Λ2=8J2(u)/u²（(1−r²/a²) 锥度），u→0 均为 1
const _Lam1 = (u) => (Math.abs(u) < 1e-6 ? 1 : 2 * besselJ1(u) / u)
const _Lam2 = (u) => (Math.abs(u) < 1e-6 ? 1 : 8 * _J2(u) / (u * u))
// TE11 圆波导馈源 φ 平均功率图（Balanis §12.5.2）：E 面 ∝ J1(u)/u，H 面 ∝ J1'(u)/(1−(u/x'11)²)，u=π·d·sinψ；归一到 U(0)=1
function _te11U(u) {
  u = Math.abs(u)
  const aE = u < 1e-6 ? 0.5 : besselJ1(u) / u
  const den = 1 - (u / _X11) ** 2
  const aH = Math.abs(den) < 2e-3 ? 0.3767 : _J1p(u) / den      // 0/0 极限 ≈0.377
  return (aE * aE + aH * aH) / 0.5
}
const _oblq = (th) => ((1 + Math.cos(th)) / 2) ** 2             // 口径辐射斜率因子（功率）
// Potter（TE11+TM11）：TM 功率 16% → 方向图更宽、溢出更大。近似为等效小口径（×0.86）展宽馈源图。
const _feedDiaEff = (dWl, model) => (model === 'potter' ? dWl * 0.86 : dWl)
// 波束宽因子 k（θ3=k·λ/D，rad）：g(r)=p+(1−p)(1−r²/a²) 远场 F(u)=p·Λ1+(1−p)·Λ2 的半功率点 u_h；k=2u_h/π
function _kFactor(p) {
  const F = (u) => p * _Lam1(u) + (1 - p) * _Lam2(u)
  let lo = 0.5, hi = 3.0
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (F(m) * F(m) > 0.5) lo = m; else hi = m }
  return 2 * ((lo + hi) / 2) / Math.PI
}
// 照射（锥度）效率闭式（n=1）：g(r)=p+(1−p)(1−r²/a²)
function _etaTaper(p) { const q = 1 - p; return (p + q / 2) ** 2 / (p * p + p * q + q * q / 3) }
// 溢出效率：TE11 辐射功率 S=te11U·斜率 在 [0,θedge]/[0,π]（Simpson）
function _etaSpill(dEff, thEdge) {
  const S = (psi) => _te11U(Math.PI * dEff * Math.sin(psi)) * _oblq(psi)
  const integ = (a, b, N) => { let s = 0; const h = (b - a) / N; for (let i = 0; i <= N; i++) { const psi = a + h * i; const w = (i === 0 || i === N) ? 1 : (i % 2 ? 4 : 2); s += w * S(psi) * Math.sin(psi) } return s * h / 3 }
  return integ(0, thEdge, 600) / integ(0, Math.PI, 3000)
}
// 边缘照射电压比 p（相对反射面中心）：TE11 馈源锥度(θedge) × 空间衰减（偏置口径内近亮/外远暗 → 内外缘 cos²(θ/2) 平均作对称等效）
function _edgeIllum(dEff, thEdge, th1, th2, thc) {
  const feed = Math.sqrt(_te11U(Math.PI * dEff * Math.sin(thEdge)))
  const space = 0.5 * ((Math.cos(th2 / 2) ** 2) + (Math.cos(th1 / 2) ** 2)) / (Math.cos(thc / 2) ** 2)
  return Math.max(0.02, Math.min(1, feed * space))
}
// 波束偏移因子 BDF（Lo）
const _bdf = (Dm, Fm) => { const m = Dm / (4 * Fm); return (1 + 0.36 * m * m) / (1 + m * m) }
// 几何（偏置抛物面缘张角）
function _reflGeom(Dm, Fm, clr) {
  const rho1 = clr * Dm, rho2 = (clr + 1) * Dm
  const th1 = 2 * Math.atan(rho1 / (2 * Fm)), th2 = 2 * Math.atan(rho2 / (2 * Fm))
  return { th1, th2, thEdge: (th2 - th1) / 2, thc: (th1 + th2) / 2 }
}
// 核心：给几何 + 馈源直径 → 波束宽/效率/方向性/边缘锥度
function _reflCore({ Dm, Fm, clr, dFeedWl, model, lamD, lamS }) {
  const g = _reflGeom(Dm, Fm, clr)
  // 馈源直径按【设计频率】WL 给出（手册：feed diameter/spacing 在设计 λ 下指定）→ 边缘锥度所需的电尺寸换算到
  // 仿真频率：d_sim(WL) = d_design(WL)·λD/λS（sim=design 时不变）。馈源物理尺寸固定，仿真频率越高电尺寸越大→锥度更深、效率更高。
  const dEff = _feedDiaEff(dFeedWl, model) * (lamD / lamS)
  const p = _edgeIllum(dEff, g.thEdge, g.th1, g.th2, g.thc)
  const k = _kFactor(p)
  const eff = _etaTaper(p) * _etaSpill(dEff, g.thEdge)
  const A = Math.PI * (Dm / 2) ** 2
  return {
    p, k, effPct: eff * 100,
    th3Design: k * lamD / Dm * (180 / Math.PI), th3Sim: k * lamS / Dm * (180 / Math.PI),
    dirDbi: 10 * Math.log10(eff * 4 * Math.PI * A / (lamS * lamS)),
    thEdgeDeg: g.thEdge * 180 / Math.PI, edgeDb: 20 * Math.log10(p)
  }
}
// 馈源间距(WL) → 波束间距(deg)：β = s_m/(F·sec²(θc/2)) · BDF
function beamSpacingDegFromFeed({ Dm, Fm, clr, feedSpacingWl, lamD }) {
  const g = _reflGeom(Dm, Fm, clr)
  return feedSpacingWl * lamD / (Fm / (Math.cos(g.thc / 2) ** 2)) * _bdf(Dm, Fm) * 180 / Math.PI
}
// 波束间距(deg) → 馈源间距(WL)
function feedSpacingWlFromBeam({ Dm, Fm, clr, betaDeg, lamD }) {
  const g = _reflGeom(Dm, Fm, clr)
  return betaDeg * Math.PI / 180 * (Fm / (Math.cos(g.thc / 2) ** 2)) / (_bdf(Dm, Fm) * lamD)
}
// 焦距反解：馈源间距 + 波束间距 + 口径 → 焦距（θc/BDF 弱依赖 F，内迭代）
function focalFromFeedSpacing({ Dm, clr, feedSpacingWl, betaDeg, lamD }) {
  let F = 1.2 * Dm; const beta = betaDeg * Math.PI / 180, sM = feedSpacingWl * lamD
  for (let i = 0; i < 40; i++) {
    const g = _reflGeom(Dm, F, clr)
    const Fn = sM * (Math.cos(g.thc / 2) ** 2) * _bdf(Dm, F) / beta
    if (!(Fn > 0) || Math.abs(Fn - F) < 1e-7) { F = Fn > 0 ? Fn : F; break }
    F = 0.5 * F + 0.5 * Fn
  }
  return F
}
// 统一求解器：按驱动（apDriver: aperture|beamwidth，fdDriver: focal|feedspacing）反解，不动点收敛全部耦合量。
// 返回 { Dm, focM, fd, feedSpacingWl, feedDiaWl, beamSpacingDeg, th3Design, th3Sim, effPct, dirDbi, feedWl, feedCm, lamDesignCm, lamSimCm, edgeDb, p, k, ok }。
export function solveReflector({
  apDriver = 'aperture', apertureM, beamwidthDeg,
  fdDriver = 'focal', focalM, feedSpacingWl,
  offsetClr = 0.5, fDesignGHz, fSimGHz, feedModel = 'te11',
  feedDiaAuto = true, feedDiaWl, beamSpacingAuto = true, beamSpacingDeg
}) {
  const clr = Math.max(-0.5, Number.isFinite(offsetClr) ? offsetClr : 0.5)
  const fS = Number(fSimGHz) > 0 ? Number(fSimGHz) : Number(fDesignGHz)
  if (!(Number(fDesignGHz) > 0) || !(fS > 0)) return { ok: false }
  const lamD = 0.299792458 / Number(fDesignGHz), lamS = 0.299792458 / fS
  let D = apDriver === 'beamwidth' ? (Number(apertureM) > 0 ? Number(apertureM) : 1) : Number(apertureM)
  let F = fdDriver === 'feedspacing' ? (Number(focalM) > 0 ? Number(focalM) : 1.2 * (D || 1)) : Number(focalM)
  if (!(D > 0) || !(F > 0)) return { ok: false }
  let dFeed = Number(feedSpacingWl) > 0 ? Number(feedSpacingWl) : 1.4, core = null
  for (let it = 0; it < 80; it++) {
    core = _reflCore({ Dm: D, Fm: F, clr, dFeedWl: dFeed, model: feedModel, lamD, lamS })
    const Dn = apDriver === 'beamwidth' ? (core.k * lamD / (Number(beamwidthDeg) * Math.PI / 180)) : Number(apertureM)
    const beamSp = beamSpacingAuto ? core.th3Design : Number(beamSpacingDeg)
    let Fn, sFeed
    if (fdDriver === 'feedspacing') { sFeed = Number(feedSpacingWl); Fn = focalFromFeedSpacing({ Dm: Dn, clr, feedSpacingWl: sFeed, betaDeg: beamSp, lamD }) }
    else { Fn = Number(focalM); sFeed = feedSpacingWlFromBeam({ Dm: Dn, Fm: Fn, clr, betaDeg: beamSp, lamD }) }
    const dNew = feedDiaAuto ? sFeed : Number(feedDiaWl)
    const conv = Math.abs(Dn - D) < 1e-7 && Math.abs(Fn - F) < 1e-7 && Math.abs(dNew - dFeed) < 1e-7
    if (Dn > 0) D = 0.5 * D + 0.5 * Dn
    if (Fn > 0) F = 0.5 * F + 0.5 * Fn
    if (dNew > 0) dFeed = 0.5 * dFeed + 0.5 * dNew
    if (conv) break
  }
  if (!core || !(D > 0) || !(F > 0)) return { ok: false }
  const beamSp = beamSpacingAuto ? core.th3Design : Number(beamSpacingDeg)
  const feedSp = feedDiaAuto ? dFeed : feedSpacingWlFromBeam({ Dm: D, Fm: F, clr, betaDeg: beamSp, lamD })
  return {
    ok: true, Dm: D, focM: F, fd: F / D,
    feedSpacingWl: feedSp, feedDiaWl: dFeed,
    beamSpacingDeg: beamSp, th3Design: core.th3Design, th3Sim: core.th3Sim,
    effPct: core.effPct, dirDbi: core.dirDbi,
    feedWl: dFeed, feedCm: dFeed * lamD * 100,
    lamDesignCm: lamD * 100, lamSimCm: lamS * 100,
    edgeDb: core.edgeDb, p: core.p, k: core.k
  }
}

// —— 地面 Polygon → 方向空间（az/el 平面）顶点环：去重、去闭合；<3 有效点返回 null ——
function projPolyAzEl(satLon, satLat, altKm, polyPts) {
  if (!polyPts || polyPts.length < 3) return null
  const V = []
  for (const p of polyPts) {
    const ae = dirToAzEl(satLon, satLat || 0, altKm, p[0], p[1])
    const last = V[V.length - 1]
    if (!last || Math.abs(last[0] - ae.az) > 1e-9 || Math.abs(last[1] - ae.el) > 1e-9) V.push([ae.az, ae.el])
  }
  if (V.length >= 2 && Math.abs(V[0][0] - V[V.length - 1][0]) < 1e-9 && Math.abs(V[0][1] - V[V.length - 1][1]) < 1e-9) V.pop()
  return V.length >= 3 ? V : null
}

// —— 并集几何（az/el 平面）：任一 Polygon 内 = 并集内；到全体边的最近距离（符号：内正外负）。
// 重叠 Polygon 的埋没边不剔除 → 距离在重叠带偏小，只用于采样分带，无碍。
function unionGeom(polys) {
  const edges = []                                 // [ax, ay, bx, by, polyIdx]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  polys.forEach((V, pi) => {
    for (let i = 0; i < V.length; i++) {
      const a = V[i], b = V[(i + 1) % V.length]
      edges.push([a[0], a[1], b[0], b[1], pi])
      if (a[0] < x0) x0 = a[0]; if (a[0] > x1) x1 = a[0]
      if (a[1] < y0) y0 = a[1]; if (a[1] > y1) y1 = a[1]
    }
  })
  const insideOne = (V, px, py) => {
    let ins = false
    for (let i = 0; i < V.length; i++) {
      const a = V[i], b = V[(i + 1) % V.length]
      if ((a[1] > py) !== (b[1] > py) && px < a[0] + (py - a[1]) / (b[1] - a[1]) * (b[0] - a[0])) ins = !ins
    }
    return ins
  }
  const inside = (px, py) => polys.some((V) => insideOne(V, px, py))
  const insideOther = (pi, px, py) => polys.some((V, i) => i !== pi && insideOne(V, px, py))
  // 带符号距离（内正外负，并集度量）：单趟遍历全部边——同时求最近距离与【逐多边形】射线穿越奇偶
  //（用射线法必须按多边形分别计奇偶，重叠区两多边形各自 inside → 并集仍 inside；合并计奇偶会 XOR 抵消，错）。
  const par = new Int8Array(polys.length)
  const signedDist = (px, py) => {
    let d2 = Infinity
    par.fill(0)
    for (const e of edges) {
      const ax = e[0], ay = e[1], ex = e[2] - ax, ey = e[3] - ay, wx = px - ax, wy = py - ay
      const s2 = ex * ex + ey * ey
      let t = s2 > 0 ? (wx * ex + wy * ey) / s2 : 0
      if (t < 0) t = 0; else if (t > 1) t = 1
      const qx = wx - ex * t, qy = wy - ey * t
      const d = qx * qx + qy * qy
      if (d < d2) d2 = d
      if ((ay > py) !== (e[3] > py) && px < ax + (py - ay) / (e[3] - ay) * ex) par[e[4]] ^= 1
    }
    let ins = false
    for (let i = 0; i < par.length; i++) if (par[i]) { ins = true; break }
    return (ins ? 1 : -1) * Math.sqrt(d2)
  }
  return { edges, inside, insideOther, signedDist, bbox: [x0, y0, x1, y1] }
}

// 多 Polygon 并集 → 立体角 Ω（网格计数）与理想赋形上限 D0=eff·4π/Ω（UI 实时参考；
// 真实峰值由 buildShapedGrd 按合成方向图积分定标）。传 theta3 附带馈源数估计。
export function polysUnionPeak({ satLon, satLat = 0, altKm, polysPts, effPct = 55, theta3 = 0 }) {
  const polys = (polysPts || []).map((p) => projPolyAzEl(satLon, satLat, altKm, p)).filter(Boolean)
  if (!polys.length) return null
  const geo = unionGeom(polys)
  const [x0, y0, x1, y1] = geo.bbox
  const G = 140, gx = (x1 - x0) / G, gy = (y1 - y0) / G
  let cnt = 0
  for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (geo.inside(x0 + (c + 0.5) * gx, y0 + (r + 0.5) * gy)) cnt++
  const omegaDeg2 = (cnt / (G * G)) * (x1 - x0) * (y1 - y0)
  const omega = omegaDeg2 * D2R * D2R
  if (!(omega > 1e-10)) return null
  const peakDbi = 10 * Math.log10((Math.max(1, Math.min(100, effPct)) / 100) * 4 * Math.PI / omega)
  let estBeams = 0
  if (theta3 > 0) {
    const s = 0.85 * theta3
    let per = 0
    for (const e of geo.edges) per += Math.hypot(e[2] - e[0], e[3] - e[1])
    estBeams = Math.max(1, Math.round(omegaDeg2 / (0.866 * s * s) + 0.5 * per / s))
  }
  return { peakDbi, omegaDeg2, nPolys: polys.length, estBeams }
}

// TICRA/GRASP ASCII 规范场值格式：±0.DDDDDDDDDDE±NN —— 尾数归一到 [0.1,1)、10 位有效数字、大写 E、
// 2 位指数，与权威参考 300_X0*G_EIRP.grd 逐字同形（Number() 与 Fortran list-directed 皆可逆解析）。
function fexp(v, digits = 10) {
  if (!Number.isFinite(v)) v = 0
  const z = '0.' + '0'.repeat(digits) + 'E+00'
  if (v === 0) return z
  const neg = v < 0, a = Math.abs(v)
  let e = Math.floor(Math.log10(a)) + 1            // 使 0.1 ≤ a/10^e < 1
  let ms = (a / Math.pow(10, e)).toFixed(digits)   // "0.DDDDDDDDDD"
  if (ms.charAt(0) !== '0') { e += 1; ms = (a / Math.pow(10, e)).toFixed(digits) }   // 进位到 1.0 → 提指数
  else if (parseFloat(ms) < 0.1) { e -= 1; ms = (a / Math.pow(10, e)).toFixed(digits) } // 退位到 <0.1 → 降指数
  return (neg ? '-' : '') + ms + 'E' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0')
}

// GRASP ASCII 是纯 ASCII 文本格式（真实参考 .grd 表头全为 ASCII，见 300_X0*G_EIRP / to_Bj_* 样本）。
// 表头只允许可打印 ASCII（0x20–0x7E），否则 SATSOFT/GRASP/STK 再导入时可能读乱或拒绝。此处剔除
// 卫星名等非 ASCII 字符（如中文星名），保证生成的 .grd 是合规、可跨工具再导入的 GRASP ASCII 文件。
const asciiSafe = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim()

// 星下点天底姿态基底（与 antennaBasisAzEl 的天底基底同款：z=天底，x≈东，y≈北）
function nadirBasis(satLon, satLat, altKm) {
  return antennaBasis(satLon, satLon, satLat || 0, 0, satLat || 0, altKm)
}

// ================= 高斯波束群 → GRD 文本 =================
// beams: [{ az, el, thX, thY, rot }]（deg）。az/el = 波束中心相对星下点（dirToAzEl 口径）；
//   thX/thY = 3dB 全宽：X≈东西向、Y≈南北向；rot = 椭圆旋转角（°，地面上自东向北为正）。
// effPct：口径效率（%）→ 各波束峰值 = eff·4π/(θx·θy)（逐波束按各自宽度算，量纲=方向性 dBi；
//   EIRP 语义由天线级「增益偏置」叠加）。floorDb：相对峰值地板（默认 −50，避免 0 功率 NaN 点）。
export function buildGaussGrd({ satName = '', satLon, satLat = 0, altKm, effPct = 55, beams, floorDb = -50 }) {
  const n = beams.length
  if (!n) throw new Error('没有波束：请先在地图上放置波束轮廓')
  // 分辨率随波束数自适应：波束少画得细，波束多控制总量（网格是每波束局部小窗口，远小于导入 HTS 的整幅网格）。
  // 蜂窝布满不设数量上限 → 靠降档托底：上千波束时每束波束在图上本就很小，粗网格无感知；
  // 总点数 n·res² 控制在 ~2M 内，文本/解析/绘制均不失控。
  const res = n <= 4 ? 101 : n <= 16 ? 81 : n <= 48 ? 61 : n <= 120 ? 49 : n <= 400 ? 37 : n <= 1200 ? 29 : 23
  const span = 1.8                                  // 窗口半宽 = 1.8×波束宽 → 窗边相对电平约 −39 dB
  const head = []
  // GRASP ASCII 纯 ASCII 表头（对齐真实参考 .grd 表头样式；非 ASCII 星名已剔除）。SYNTHMETA 仅存
  // 精简元数据（不再逐波束展开——旧版整行可达十几 KB，超长单行对严格读取器不友好，且从不被回读）。
  const sn = asciiSafe(satName)
  head.push(`SatSim synthesized pattern (Gaussian beam model)${sn ? ' - ' + sn : ''}. Sat. lon=${(+satLon).toFixed(2)}, lat=${(+(satLat || 0)).toFixed(2)}, height=${Math.round(altKm)} km, beams=${n}`)
  head.push(`SYNTHMETA ${JSON.stringify({ kind: 'gauss', satLon: +satLon.toFixed(4), satLat: +(satLat || 0).toFixed(4), altKm: Math.round(altKm), effPct, nBeams: n })}`)
  head.push('++++')
  head.push('1')
  head.push(` ${n} 3 2 6`)
  for (let i = 0; i < n; i++) head.push('  0  0')
  const parts = [head.join('\r\n')]
  const zero = fexp(0)
  for (const b of beams) {
    const thX = b.thX, thY = b.thY
    // 峰值方向性：优先用逐波束 peakDbi（每波束按其所属设置的反射面口径方向性定 → 多波束宽各自增益正确）；
    // 否则回落 eff·4π/(θx·θy)（单一效率的旧口径）。
    const peakDbi = Number.isFinite(b.peakDbi) ? b.peakDbi : gaussDirectivityDbi(thX, thY, effPct)
    // 地面「自东向北」旋转 → 网格（igrid6 的 +Az 与东向互为镜像）取反号；宽度不受镜像影响
    const rg = -(b.rot || 0) * D2R, cr = Math.cos(rg), sr = Math.sin(rg)
    // 旋转椭圆的外接盒半宽（两轴各自适配 → 长短轴悬殊的椭圆两向都够细）
    const hx = span * Math.hypot(thX * cr, thY * sr)
    const hy = span * Math.hypot(thX * sr, thY * cr)
    const XS = b.az - hx, XE = b.az + hx, YS = b.el - hy, YE = b.el + hy
    const dx = (XE - XS) / (res - 1), dy = (YE - YS) / (res - 1)
    const L = new Array(res * res + 2)
    L[0] = ` ${fexp(XS)} ${fexp(YS)} ${fexp(XE)} ${fexp(YE)}`
    L[1] = ` ${res} ${res} 0`
    let k = 2
    for (let row = 0; row < res; row++) {
      const oy = YS + dy * row - b.el
      for (let col = 0; col < res; col++) {
        const ox = XS + dx * col - b.az
        const xp = ox * cr + oy * sr, yp = -ox * sr + oy * cr
        let rel = -GCOEF * ((xp / thX) * (xp / thX) + (yp / thY) * (yp / thY))
        if (rel < floorDb) rel = floorDb
        L[k++] = ` ${fexp(Math.pow(10, (peakDbi + rel) / 20))} ${zero} ${zero} ${zero}`
      }
    }
    parts.push(L.join('\r\n'))
  }
  return parts.join('\r\n') + '\r\n'
}

// ================= 多波束 GRD → 公共网格重打包（SATSOFT 兼容导出） =================
// 症状：多馈源合成的 .grd 导入 SATSOFT，识别到 N 个波束，但每个波束的覆盖都和「波束1」一模一样。
// 根因：buildGaussGrd 逐波束用【各自的小窗口】(XS..XE 逐 set 不同，且高斯峰值恰在各自窗口中心)。SATSOFT
//   读多 set 时按 TICRA 惯例假设【各 set 同一张网格】——它用 set1 的 XS..XE 套所有 set，于是每个 set 的
//   居中数据都被摆到 set1 的中心 = 波束1 落点 → 所有波束看起来都和波束1一样。（本平台自己的解析器逐 set 用
//   各自 XS..XE，故本平台显示正常；差异只在导出给 SATSOFT 时暴露。）
// 修法：把全部 set 重采样到一张覆盖并集包围盒的【公共网格】(所有 set 同 XS..XE)，各波束落在其【真实 az/el】
//   → SATSOFT 逐 set 定位正确。NSET 不变(=波束数，SATSOFT 仍按 N 个可分波束读取，可做频率复用/波束级分析)。
// 仅对「多 set 且各 set 网格不一致」的合成 .grd 生效；单 set(赋形)/已同网格(真实导入件) 原样返回。
// 分辨率 ptsPerBw = 每半功率宽的采样点数（高斯窗宽=3.6θ → θ≈窗宽/3.6）：太粗则 SATSOFT 提出的等值线呈多边形
//   （θ/4≈六边形 → 圆波束看着不圆），故取 8（-3dB 环≈8 格宽、半径≈4 格 → 圆滑）。总点数封顶防文本/解析失控
//   （各 set 现为全幅公共网格、波束外为地板，比原「贴身小窗口」体积大，属 SATSOFT 同网格前提下的必然代价）。
export function repackGrdCommonGrid(text, { floorDb = -50, cap = 2_000_000, ptsPerBw = 8 } = {}) {
  let g
  try { g = parseGrd(text) } catch { return text }
  const sets = (g && g.sets) || []
  if (sets.length <= 1) return text                            // 单 set：无歧义，原样返回
  const s0 = sets[0]
  const sameGrid = sets.every((s) => s.XS === s0.XS && s.YS === s0.YS && s.XE === s0.XE && s.YE === s0.YE && s.NX === s0.NX && s.NY === s0.NY)
  if (sameGrid) return text                                    // 已是公共网格（真实多波束/多频文件）→ 不动
  // 并集包围盒（支持轴递减：min/max）+ 最窄波束估计（合成高斯窗宽 = 3.6θ）
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, thMin = Infinity
  for (const s of sets) {
    x0 = Math.min(x0, s.XS, s.XE); x1 = Math.max(x1, s.XS, s.XE)
    y0 = Math.min(y0, s.YS, s.YE); y1 = Math.max(y1, s.YS, s.YE)
    const th = Math.min(Math.abs(s.XE - s.XS), Math.abs(s.YE - s.YS)) / 3.6
    if (th > 0) thMin = Math.min(thMin, th)
  }
  let step = Number.isFinite(thMin) && thMin > 0 ? thMin / ptsPerBw : (Math.max(x1 - x0, y1 - y0) / 100) || 0.1
  let NX = Math.max(2, Math.round((x1 - x0) / step) + 1)
  let NY = Math.max(2, Math.round((y1 - y0) / step) + 1)
  if (sets.length * NX * NY > cap) { const k = Math.sqrt(sets.length * NX * NY / cap); NX = Math.max(2, Math.round(NX / k)); NY = Math.max(2, Math.round(NY / k)) }
  const dx = (x1 - x0) / (NX - 1), dy = (y1 - y0) / (NY - 1)
  // 双线性采样某 set 的线性功率（窗外返回 null）；范围支持递增/递减
  const sampleP = (s, arr, x, y) => {
    const fx = s.XE === s.XS ? 0 : (x - s.XS) / (s.XE - s.XS) * (s.NX - 1)
    const fy = s.YE === s.YS ? 0 : (y - s.YS) / (s.YE - s.YS) * (s.NY - 1)
    if (fx < -1e-6 || fx > s.NX - 1 + 1e-6 || fy < -1e-6 || fy > s.NY - 1 + 1e-6) return null
    const cx = Math.min(Math.max(fx, 0), s.NX - 1), cy = Math.min(Math.max(fy, 0), s.NY - 1)
    const xa = Math.floor(cx), ya = Math.floor(cy), xb = Math.min(xa + 1, s.NX - 1), yb = Math.min(ya + 1, s.NY - 1)
    const tx = cx - xa, ty = cy - ya, at = (r, c) => arr[r * s.NX + c]
    return (at(ya, xa) * (1 - tx) + at(ya, xb) * tx) * (1 - ty) + (at(yb, xa) * (1 - tx) + at(yb, xb) * tx) * ty
  }
  // 头：保留原文本头（含 SYNTHMETA），沿用原 KTYPE/ICOMP/NCOMP/IGRID 与 NSET(=波束数)；各 set 现同公共网格
  const lines = text.split(/\r\n|\n|\r/)
  let hi = 0; while (hi < lines.length && !/^\+{4,}$/.test(lines[hi].trim())) hi++
  const head = lines.slice(0, hi)
  head.push('++++', String(g.ktype), ` ${g.nset} ${g.icomp} ${g.ncomp} ${g.igrid}`)
  for (let s = 0; s < g.nset; s++) head.push('  0  0')
  const zero = fexp(0)
  const gridLim = ` ${fexp(x0)} ${fexp(y0)} ${fexp(x1)} ${fexp(y1)}`
  const dimLine = ` ${NX} ${NY} 0`
  const parts = [head.join('\r\n')]
  const NN = NX * NY, a1buf = new Float64Array(NN), a2buf = new Float64Array(NN)
  for (const s of sets) {
    const peakAmp = Math.sqrt(Math.max(0, s.peakLin))                                  // 原始波束峰值幅度（= 本平台原生读到的峰）
    const floorAmp = peakAmp * Math.pow(10, floorDb / 20)                              // 窗外地板幅度（相对该 set 峰值 floorDb）
    // 第一趟：重采样全网格幅度，并记录重采样后的峰（波束真峰落在格点【之间】→ 网格最大值比原峰略低，约 0.1 dB）
    let aMax = 0
    for (let row = 0; row < NY; row++) {
      const y = y0 + dy * row, rb = row * NX
      for (let col = 0; col < NX; col++) {
        const idx = rb + col, x = x0 + dx * col
        const p1 = sampleP(s, s.P1, x, y)
        let v1, v2 = 0
        if (p1 == null) { v1 = floorAmp } else {
          v1 = Math.sqrt(Math.max(0, p1))
          const p2 = sampleP(s, s.P2, x, y); if (p2 != null && p2 > 0) v2 = Math.sqrt(p2)
        }
        a1buf[idx] = v1; a2buf[idx] = v2
        if (v1 > aMax) aMax = v1
      }
    }
    // 峰值守恒：整体缩放使网格峰 = 原峰 → 重导入/SATSOFT 读到的峰值与本平台原生一致（否则重采样丢 ~0.1 dB，
    // 出现「原生 47.77 / 导出 47.66」）。dB 域为平移常量：波束形状、相对等值线位置完全不变，仅补回被格点离散吃掉的峰。
    const boost = aMax > 0 ? peakAmp / aMax : 1
    const L = new Array(NN + 2)
    L[0] = gridLim; L[1] = dimLine
    for (let idx = 0; idx < NN; idx++) L[idx + 2] = ` ${fexp(a1buf[idx] * boost)} ${zero} ${fexp(a2buf[idx] * boost)} ${zero}`
    parts.push(L.join('\r\n'))
  }
  return parts.join('\r\n') + '\r\n'
}

// ================= Polygon → 赋形波束 GRD 文本（SATSOFT 式真实合成） =================
// 与 TICRA SATSOFT「Beamlet Grid + Station Grid」同构的三件套（复激励 minimax）：
//   ① 波束栅（beamlet grid ＝ 自由度）：覆盖区 az/el 平面铺【规则】六角波束栅，间距 s≈θ3、外扩
//      一圈给边缘滚降。数量由口径限死（θ3=70λ/D），不密铺不贴形 —— 有限馈源做不到完美平顶，
//      物理等纹波与真实边缘滚降由此自然浮现（口径越大 beamlet 越多、纹波越小，符合真实天线）。
//   ② 站点栅（station grid ＝ 目标点）：Polygon 内六角站点 + 边界点 + 界外抑制点。站点只定义
//      「哪里要达标」，不提供自由度（对齐 SATSOFT：station 是靶子，beamlet 才是被激励的辐射源）。
//   ③ 复激励 minimax（交替相位）：成分场幅 gᵢ=exp[−2ln2(r/θ3)²]，合成复场 f=Σ wᵢ·gᵢ（wᵢ∈ℂ）。
//      每轮以各站点当前相位 + 单位幅为目标，解复法方程（gᵢ 实 → 法矩阵 A 实对称，仅右端 b 复 →
//      同一 Cholesky 分解解 Re/Im 两路，复数只进相位）；IRLS 按缺额升权最差站点 → 逼近等纹波
//      （Chebyshev）解。不设平顶硬模板、不加大岭正则 → 纹波如实保留，不再被磨成纯净同心环。
//   ④ 定标：mode='physical' 按合成方向图积分算真实方向性 D=eff·4π·P̂max/∫P̂dΩ（dBi）；
//      mode='value' 按覆盖值反推（边界采样中位电平 = value）。峰值/纹波/角落最差值如实回报。
// polysPts: [ [[lon,lat],...], ... ]（并集为【一个】覆盖区，不再按多 Polygon 做区内能量偏向）。
// 返回 { text, value(边缘保证值), peakDbi, covMin, omegaDeg2, nBeams(beamlet 数), rippleDb, nx, ny, warn }。
const BEAMLET_SP = 1.0                             // 波束栅间距 = 3dB 波束宽（SATSOFT 手册 §8/§9.1：component beam spacing = 3dB beamwidth）
const BEAM_MARGIN = 1.0                            // 波束栅外扩量（×θ3）：手册建议「覆盖区外再铺一圈 beamlet」给边缘滚降
const NMAX_B = 360                                 // 波束栅数量上限（复 Cholesky 规模）；超限增距降档
const ST_DENS = 2.0                                // 站点密度：区内/边界步距 = θ3/ST_DENS（手册 §9.1：1.7~2 /波束宽足够）
const SUP_IN = 1.15                                // 界外抑制带起点（×θ3）
const SUP_DB = -25                                 // 界外抑制目标（相对峰值 dB）
const KF = 2 * Math.LN2                            // 场幅高斯指数：exp[−KF(r/θ3)²] ⇔ 功率 −GCOEF(r/θ3)²

// —— 均匀哈希网格：截断半径内的邻近馈源查询（高斯 −50dB 截断 → 稀疏装配/求值）——
function hashGrid(pts, cell) {
  const map = new Map()
  pts.forEach((q, i) => {
    const k = Math.floor(q[0] / cell) + ':' + Math.floor(q[1] / cell)
    let a = map.get(k); if (!a) map.set(k, a = [])
    a.push(i)
  })
  return (px, py, R) => {
    const out = []
    const i0 = Math.floor((px - R) / cell), i1 = Math.floor((px + R) / cell)
    const j0 = Math.floor((py - R) / cell), j1 = Math.floor((py + R) / cell)
    const R2 = R * R
    for (let ix = i0; ix <= i1; ix++) for (let iy = j0; iy <= j1; iy++) {
      const a = map.get(ix + ':' + iy)
      if (a) for (const i of a) {
        const dx = pts[i][0] - px, dy = pts[i][1] - py
        if (dx * dx + dy * dy <= R2) out.push(i)
      }
    }
    return out
  }
}

// —— 采样超限时等步抽稀（保持空间均匀） ——
const thin = (arr, cap) => { if (arr.length <= cap) return arr; const st = Math.ceil(arr.length / cap); return arr.filter((_, i) => i % st === 0) }

// —— Cholesky：分解与回代分离（同一 A 的 LLᵀ 可解多个右端 → 复激励 Re/Im 两路复用一次分解）——
// cholFactor：A 就地改写为下三角 L（非正定返回 false，上层加大 λ 重铺重试）。
function cholFactor(A, N) {
  for (let i = 0; i < N; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * N + j]
      for (let k = 0; k < j; k++) s -= A[i * N + k] * A[j * N + k]
      if (i === j) { if (!(s > 1e-14)) return false; A[i * N + i] = Math.sqrt(s) }
      else A[i * N + j] = s / A[j * N + j]
    }
  }
  return true
}
// cholSolveL：L 已分解，就地解 b（前代 + 回代）。返回 b。
function cholSolveL(L, b, N) {
  for (let i = 0; i < N; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * N + k] * b[k]; b[i] = s / L[i * N + i] }
  for (let i = N - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < N; k++) s -= L[k * N + i] * b[k]; b[i] = s / L[i * N + i] }
  return b
}

// —— ① 波束栅布放：规则六角格铺满【覆盖区 + 外扩 BEAM_MARGIN·θ3 一圈】，数量由口径(θ3)限死；
// 超 NMAX_B 增距降档。不贴形、不密铺 —— 有限自由度正是物理纹波与真实边缘滚降的根源。
// anchor（峰点引导）：六角格原点对齐 anchor —— 晶格相位本就是自由选择（同密度、同自由度、同物理），
// 锚上后引导点恰有一支 beamlet，场峰可精确落位（否则峰只能落在最近 beamlet 附近，偏差可达 ~0.3θ3）。——
function layoutBeamlets(geo, polys, th, anchor) {
  const [x0, y0, x1, y1] = geo.bbox
  const mo = BEAM_MARGIN * th
  let s = BEAMLET_SP * th
  const ax = anchor ? anchor.az : x0 - mo, ay = anchor ? anchor.el : y0 - mo
  for (let pass = 0; ; pass++) {
    const pts = []
    const rowH = s * Math.sqrt(3) / 2
    const j0 = Math.ceil((y0 - mo - ay) / rowH - 1e-9), j1 = Math.floor((y1 + mo - ay) / rowH + 1e-9)
    for (let j = j0; j <= j1; j++) {
      const y = ay + j * rowH
      const off = (((j % 2) + 2) % 2) ? s / 2 : 0
      const i0 = Math.ceil((x0 - mo - ax - off) / s - 1e-9), i1 = Math.floor((x1 + mo - ax - off) / s + 1e-9)
      for (let i = i0; i <= i1; i++) { const x = ax + off + i * s; if (geo.signedDist(x, y) >= -mo) pts.push([x, y]) }
    }
    if (pts.length <= NMAX_B || pass >= 5) {
      if (!pts.length) for (const V of polys) {    // 区域比 beamlet 还小 → 每个 Polygon 质心一支（退化为准单波束）
        let cx = 0, cy = 0
        for (const q of V) { cx += q[0]; cy += q[1] }
        pts.push([cx / V.length, cy / V.length])
      }
      return { centers: pts, spacing: s }
    }
    s *= Math.sqrt(pts.length / NMAX_B) * 1.03     // 降档：增距重铺直到 ≤NMAX_B
  }
}

// —— ② 站点栅：区内 contour 站点(kind0) + 边界(kind1) + 抑制(kind2，含【界内隔离区】+界外)。
// metas=[{V,value,area,iso}]（已按面积升序：最小/最具体在前 → 首个包含者胜）。每 contour 站点带【相对目标 dB】
// TDB=首个包含它的 contour 多边形 value − maxTarget（Use Polygon Labels：内圈标签更高→内强外弱锥度）。
// iso 多边形（value<base 的隔离区）内的站点 → kind2 抑制（把该区压低，做隔离/凹陷），覆盖保证里不计。
// hots=[{az,el,boost,w}]（峰点引导）：在 contour/边界站点目标上叠加 dB 域高斯坡 boost·exp[−4ln2(r/w)²]
//（r=w/2 处衰减一半 → w=坡的半高全宽）——连续目标场，抑制站点(kind2)不叠加。——
function buildStations(geo, metas, maxTarget, th, spacing, omegaDeg2, hots) {
  const X = [], Y = [], KIND = [], TDB = [], HB = []   // HB=该站点的峰点坡值（dB，自适应抬坡按此形状分摊）
  const hasT = metas.some((m) => Number.isFinite(m.value))
  const hotBump = (px, py) => {
    let t = 0
    if (hots) for (const h of hots) {
      const dx = px - h.az, dy = py - h.el
      const e = Math.exp(-4 * Math.LN2 * (dx * dx + dy * dy) / (h.w * h.w))
      if (e > 1e-3) t += h.boost * e
    }
    return t
  }
  const ptIn = (V, px, py) => {
    let ins = false
    for (let i = 0; i < V.length; i++) { const a = V[i], b = V[(i + 1) % V.length]; if ((a[1] > py) !== (b[1] > py) && px < a[0] + (py - a[1]) / (b[1] - a[1]) * (b[0] - a[0])) ins = !ins }
    return ins
  }
  const clsOf = (px, py) => {                         // 首个(最小)含它且带标签的多边形：iso→隔离；否则 contour 相对目标
    if (!hasT) return { tdb: 0, iso: false }
    for (const m of metas) if (Number.isFinite(m.value) && ptIn(m.V, px, py)) return m.iso ? { iso: true } : { tdb: m.value - maxTarget, iso: false }
    return { tdb: 0, iso: false }
  }
  const push = (x, y, k) => {                         // contour 点按 kind；若落在隔离区则改 kind2 抑制
    if (k !== 2) {
      const c = clsOf(x, y)
      if (c.iso) { X.push(x); Y.push(y); KIND.push(2); TDB.push(0); HB.push(0); return }
      const b = hotBump(x, y)
      X.push(x); Y.push(y); KIND.push(k); TDB.push(c.tdb + b); HB.push(b)
      return
    }
    X.push(x); Y.push(y); KIND.push(2); TDB.push(0); HB.push(0)
  }
  const [x0, y0, x1, y1] = geo.bbox
  // 区内站点：θ3/ST_DENS 六角格（大区按面积放粗 + 3500 封顶），离边 ≥0.3θ3（边界带交给边界站点）
  const cCov = Math.max(th / ST_DENS, Math.sqrt(Math.max(omegaDeg2, 1e-6) / (0.866 * 3500)))
  const covPts = []
  {
    const rowH = cCov * Math.sqrt(3) / 2
    let r = 0
    for (let y = y0; y <= y1 + 1e-9; y += rowH, r++) {
      const off = r % 2 ? cCov / 2 : 0
      for (let x = x0 + off; x <= x1 + 1e-9; x += cCov) if (geo.signedDist(x, y) >= 0.3 * th) covPts.push([x, y])
    }
  }
  for (const q of thin(covPts, 3500)) push(q[0], q[1], 0)
  // 边界站点：沿并集边界 θ3/ST_DENS 步进；落在其它 Polygon 内部的边段不是并集边界，跳过
  let per = 0
  for (const e of geo.edges) per += Math.hypot(e[2] - e[0], e[3] - e[1])
  const stepB = Math.max(th / ST_DENS, per / 2000)
  for (const e of geo.edges) {
    const ex = e[2] - e[0], ey = e[3] - e[1], len = Math.hypot(ex, ey)
    for (let t = 0; t < len; t += stepB) {
      const px = e[0] + ex * t / len, py = e[1] + ey * t / len
      if (!geo.insideOther(e[4], px, py)) push(px, py, 1)
    }
  }
  // 界外抑制站点：SUP_IN·θ3 起到 2.5θ3+s 止（θ3/2 六角格，3500 封顶）；再远无 beamlet 可及，天然为地板
  const far = 2.5 * th + spacing
  const supPts = []
  {
    const c = th / 2, rowH = c * Math.sqrt(3) / 2
    let r = 0
    for (let y = y0 - far; y <= y1 + far + 1e-9; y += rowH, r++) {
      const off = r % 2 ? c / 2 : 0
      for (let x = x0 - far + off; x <= x1 + far + 1e-9; x += c) {
        const d = geo.signedDist(x, y)
        if (d <= -SUP_IN * th && d >= -far) supPts.push([x, y])
      }
    }
  }
  for (const q of thin(supPts, 3500)) push(q[0], q[1], 2)
  return { X, Y, KIND, TDB, HB, n: X.length }
}

// pol 仅记入 SYNTHMETA（本引擎只算共极化功率，极化不改功率方向图——与 SATSOFT 同：极化只影响
// 交叉极化分量，此处不建模）。定标见 ⑤：物理增益恒由 ∫P̂dΩ 定（能量守恒，形状与绝对增益不可分拆），
// 'value' 模式仅在其上叠一个【显式功放偏置 paDb】把最低覆盖档抬到目标值——不动方向图形状。
// hotspots（峰点引导 = 连续目标场）：[{ lon, lat, boostDb, widthDeg }]。在分区标签目标上叠加以峰点
//   为中心的 dB 域高斯坡（半高全宽 widthDeg，物理下限 = θ3 口径分辨率；boostDb 正=热点、负=局部压低）。
//   只改【优化目标】——激励仍在口径受限的可实现集合内搜索，定标环节照旧按 ∫P̂dΩ 守恒；峰值实际
//   落点/数值由合成 argmax 如实回报（引导而非指定，超出口径能力的目标会如实欠额）。
export function buildShapedGrd({ satName = '', satLon, satLat = 0, altKm, polysPts, polyTargets = null, hotspots = null, mode = 'value', value = null, effPct = 55, theta3, floorDb = -50, pol = '', apDm = 0, fSimGHz = 0 }) {
  if (!(theta3 > 0)) throw new Error('滚降波束宽度无效：请检查频率 / 口径')
  if (mode !== 'physical' && !Number.isFinite(value)) throw new Error('覆盖值无效：请填写区域内的电平（dB）')
  // 投影 Polygon 到 az/el；每 Polygon 带目标标签（Use Polygon Labels）与面积。
  const projected = (polysPts || []).map((p, i) => ({ V: projPolyAzEl(satLon, satLat, altKm, p), t: polyTargets && Number.isFinite(Number(polyTargets[i])) ? Number(polyTargets[i]) : NaN })).filter((o) => o.V)
  if (!projected.length) throw new Error('Polygon 无效：每个至少需要 3 个顶点')
  // 分类：底覆盖 base = 最大面积多边形的标签；value≥base = 覆盖/热点(contour)，value<base = 隔离区(iso，抑制)。
  const areaOf = (V) => { let a = 0; for (let i = 0; i < V.length; i++) { const p = V[i], q = V[(i + 1) % V.length]; a += p[0] * q[1] - q[0] * p[1] } return Math.abs(a) / 2 }
  const metas = projected.map((o) => ({ V: o.V, value: o.t, area: areaOf(o.V), iso: false }))
  const finiteM = metas.filter((m) => Number.isFinite(m.value))
  const base = finiteM.length ? finiteM.reduce((a, b) => (b.area > a.area ? b : a)).value : NaN
  for (const m of metas) m.iso = Number.isFinite(base) && Number.isFinite(m.value) && m.value < base - 0.01
  metas.sort((a, b) => a.area - b.area)              // 最小/最具体在前 → 首个包含者胜
  const contourVals = metas.filter((m) => !m.iso && Number.isFinite(m.value)).map((m) => m.value)
  const maxTarget = contourVals.length ? Math.max(...contourVals) : NaN
  const covValue = contourVals.length ? Math.min(...contourVals) : value   // 覆盖保证值 = 最低 contour 标签（隔离区不计）
  const polys = metas.map((m) => m.V)                // 全部多边形（含隔离）参与并集/beamlet（隔离区也需 beamlet 造凹陷）
  const th = theta3, geo = unionGeom(polys)
  // 峰点引导 → 方向空间：宽度收紧到 ≥θ3（口径造不出更细的目标特征）；boost=0/坐标非法的行剔除
  const hots = []
  for (const h of (hotspots || [])) {
    if (!h || !Number.isFinite(h.lon) || !Number.isFinite(h.lat)) continue
    const boost = Number(h.boostDb)
    if (!Number.isFinite(boost) || boost === 0) continue
    const ae = dirToAzEl(satLon, satLat || 0, altKm, h.lon, h.lat)
    hots.push({ az: ae.az, el: ae.el, boost, w: Math.max(Number(h.widthDeg) > 0 ? Number(h.widthDeg) : th, th) })
  }
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const [bx0, by0, bx1, by1] = geo.bbox
  // 并集立体角（网格计数，重叠不重复计）：报表 + 站点密度参考
  let omegaDeg2 = 0
  {
    const G = 140, gx = (bx1 - bx0) / G, gy = (by1 - by0) / G
    let cnt = 0
    for (let r = 0; r < G; r++) for (let c = 0; c < G; c++) if (geo.inside(bx0 + (c + 0.5) * gx, by0 + (r + 0.5) * gy)) cnt++
    omegaDeg2 = (cnt / (G * G)) * (bx1 - bx0) * (by1 - by0)
  }
  // ① 波束栅（自由度，由口径限死）；峰点引导时晶格锚到最强正 boost 峰点（相位自由，物理不变）
  let hotAnchor = null
  for (const h of hots) if (h.boost > 0 && (!hotAnchor || h.boost > hotAnchor.boost)) hotAnchor = h
  const { centers, spacing } = layoutBeamlets(geo, polys, th, hotAnchor)
  const N = centers.length
  const Rcut = th * Math.sqrt(-floorDb / GCOEF)
  const near = hashGrid(centers, Rcut)
  const reach = 1.15 * th                          // 覆盖可达半径：口径分辨率外的细部剔除（如实回报）
  // ④ 出图网格几何：并集外接盒 + 滚降到地板的边距；格距 θ3/7，总量 ≤13 万点自适应放粗
  const margin = Rcut + 0.5 * spacing
  const XS = bx0 - margin, XE = bx1 + margin, YS = by0 - margin, YE = by1 + margin
  const cell = th / 7
  let NX = cl(Math.ceil((XE - XS) / cell) + 1, 61, 301), NY = cl(Math.ceil((YE - YS) / cell) + 1, 61, 301)
  if (NX * NY > 130000) { const k = Math.sqrt((NX * NY) / 130000); NX = Math.max(61, Math.round(NX / k)); NY = Math.max(61, Math.round(NY / k)) }
  const dx = (XE - XS) / (NX - 1), dy = (YE - YS) / (NY - 1)
  // ② 站点栅 → 稀疏装配（每站点只挂 −50dB 截断半径内的 beamlet）
  const smp = buildStations(geo, metas, maxTarget, th, spacing, omegaDeg2, hots)
  const nbOf = [], gOf = [], kind = [], tdb = [], hb = []
  let unreach = 0, covCnt = 0
  for (let j = 0; j < smp.n; j++) {
    const nb = near(smp.X[j], smp.Y[j], Rcut)
    if (smp.KIND[j] !== 2) {
      let ok = false
      for (const i of nb) { const dx = smp.X[j] - centers[i][0], dy = smp.Y[j] - centers[i][1]; if (dx * dx + dy * dy <= reach * reach) { ok = true; break } }
      if (!ok) { unreach++; continue }
      covCnt++
    } else if (!nb.length) continue                // 远点无 beamlet 可及 → 天然为零，无需约束
    const g = new Float64Array(nb.length)
    for (let a = 0; a < nb.length; a++) {
      const dx = smp.X[j] - centers[nb[a]][0], dy = smp.Y[j] - centers[nb[a]][1]
      g[a] = Math.exp(-KF * (dx * dx + dy * dy) / (th * th))
    }
    nbOf.push(nb); gOf.push(g); kind.push(smp.KIND[j]); tdb.push(smp.TDB[j]); hb.push(smp.HB[j])
  }
  const M = nbOf.length
  // 各站点相对目标幅 tAmp = 10^(TDB/20)（TDB≤0 → 内圈=1、外圈<1；无分区标签则全 1 = 全区统一）
  const tAmp = new Float64Array(M)
  for (let m = 0; m < M; m++) tAmp[m] = Math.pow(10, tdb[m] / 20)
  // ③ 复激励交替相位 IRLS minimax：gᵢ 实 → 法矩阵 A 实对称，仅右端复 → 同一 Cholesky 解 Re/Im 两路。
  //    每轮：目标场 = 各站点当前相位 + 单位幅（界外 0）→ 解 → 归一 → 评分留优 → IRLS 升权最差站点。
  const wRe = new Float64Array(N), wIm = new Float64Array(N)   // 初值 0 → 首轮实目标（零相位、单位幅）
  const rho = new Float64Array(M)
  for (let m = 0; m < M; m++) rho[m] = kind[m] === 0 ? 1 : kind[m] === 1 ? 2 : 0.12
  const dRe = new Float64Array(M), dIm = new Float64Array(M)
  const fld = (wr, wi, m) => {                      // 站点 m 的复场（返回 [Re, Im]）
    let fr = 0, fi = 0; const nb = nbOf[m], g = gOf[m]
    for (let a = 0; a < nb.length; a++) { const w = nb[a]; fr += wr[w] * g[a]; fi += wi[w] * g[a] }
    return [fr, fi]
  }
  let bRe = null, bIm = null, scoreBest = Infinity, rippleBest = 0
  const runIters = (iters) => {
  for (let it = 0; it < iters && M; it++) {
    // 目标场（实激励，对齐 SATSOFT Contour=「达标或超出」§9.12/§10.2）：区内/边界 d = max(当前场, tAmp)
    //   —— 已达标(f≥目标)则【保留当前值不下拉】，欠额则拉到目标。这样内圈波束的高斯尾巴把外圈抬到目标以上
    //   是被允许的(超出无罚)，无需负权去抵消 → 不产生零点/空洞；界外仍强制 d=0(压制)。
    //   （复数交替相位实际从不激活：实权×实高斯→实场→虚部恒 0；且采纳符号会把负偏锁成零点，故直接走实正投影。）
    for (let m = 0; m < M; m++) {
      if (kind[m] === 2) { dRe[m] = 0; dIm[m] = 0; continue }
      const fr = fld(wRe, wIm, m)[0]
      dRe[m] = fr > tAmp[m] ? fr : tAmp[m]
      dIm[m] = 0
    }
    // 装配实法矩阵 A0 与复右端 (BR, BI)
    const A0 = new Float64Array(N * N), BR = new Float64Array(N), BI = new Float64Array(N)
    for (let m = 0; m < M; m++) {
      // 【相对残差】站点权重 = rho / tAmp²：最小化 Σ(f/tAmp − 1)² 而非 Σ(f − tAmp)²。
      // 绝对残差会让高幅(内圈)目标主导、低幅(外圈)被忽略而塌陷 taper dB；相对残差令各档目标等权 → taper 保真、外圈不塌。
      const nb = nbOf[m], g = gOf[m], r = rho[m] / (tAmp[m] * tAmp[m]), L = nb.length
      for (let a = 0; a < L; a++) {
        const ia = nb[a], gar = g[a] * r, row = ia * N
        BR[ia] += gar * dRe[m]; BI[ia] += gar * dIm[m]
        for (let b = 0; b < L; b++) A0[row + nb[b]] += gar * g[b]
      }
    }
    let trace = 0
    for (let i = 0; i < N; i++) trace += A0[i * N + i]
    // 极小岭：仅数值稳定（1e-6·trace/N），不磨纹波；非正定则加大重铺重试
    let lam = Math.max(1e-12, 1e-6 * trace / N), Lm = null
    for (let k = 0; k < 5 && !Lm; k++, lam *= 30) {
      const C = A0.slice()
      for (let i = 0; i < N; i++) C[i * N + i] += lam
      if (cholFactor(C, N)) Lm = C
    }
    if (!Lm) break
    const xr = cholSolveL(Lm, Array.from(BR), N)
    const xi = cholSolveL(Lm, Array.from(BI), N)
    // 归一：区内+边界【余量 |f|/tAmp】的【20 分位】→ 1（meet-or-exceed：下缘≈目标、多数≥目标；避免尺度漂移）。
    // 用中位会把一半区域压到目标以下（=空洞）；用低分位让场整体坐在目标之上。vAll 存本轮余量 dB。
    const vAll = new Float64Array(M)
    const covMar = []
    for (let m = 0; m < M; m++) { const [fr, fi] = fld(xr, xi, m); vAll[m] = Math.hypot(fr, fi); if (kind[m] !== 2) covMar.push(vAll[m] / tAmp[m]) }
    covMar.sort((a, b) => a - b)
    const med = covMar.length ? covMar[Math.floor(covMar.length * 0.2)] : 1
    const sc = med > 1e-9 ? 1 / med : 1
    for (let i = 0; i < N; i++) { xr[i] *= sc; xi[i] *= sc }
    // 评分（余量 = |f|dB − 目标dB；界外取绝对 dB）：优先消除区内【欠额】(空洞 worstShort)，再压纹波/边界/界外 → 留优
    let dMax = -Infinity, dMin = Infinity, bShort = 0, sMax = -Infinity
    for (let m = 0; m < M; m++) {
      const adb = 20 * Math.log10(Math.max(vAll[m] * sc, 1e-8))
      const mar = kind[m] === 2 ? adb : adb - tdb[m]
      vAll[m] = mar
      if (kind[m] === 0) { if (mar > dMax) dMax = mar; if (mar < dMin) dMin = mar }
      else if (kind[m] === 1) { const s = Math.max(0, -mar); if (s > bShort) bShort = s }
      else if (mar - SUP_DB > sMax) sMax = mar - SUP_DB
    }
    const ripple = dMin < Infinity ? dMax - dMin : 0
    const worstShort = Math.max(0, -dMin)             // 最差区内欠额（>0 = 有空洞）
    // 【不罚 excess/纹波】：meet-or-exceed 允许内圈波束尾巴把邻近外圈抬到目标以上（物理正常）；
    // 若把 ripple 计入罚项，优化器会用负权把这些"超出"抵消掉 → 过渡带 Gibbs 下冲成空洞（正是"覆盖躲着 polygon"）。
    const score = worstShort * 3 + 0.8 * bShort + 0.5 * Math.max(0, sMax)
    if (score < scoreBest) { scoreBest = score; bRe = xr.slice(); bIm = xi.slice(); rippleBest = ripple }
    wRe.set(xr); wIm.set(xi)
    if (it === iters - 1) break
    // IRLS（meet-or-exceed，对齐 SATSOFT 最大化最小余量）：区内/边界按【欠额】升权(达标则缓降)；界外按超标升权(压低)
    for (let m = 0; m < M; m++) {
      if (kind[m] === 2) { rho[m] = cl(rho[m] * Math.exp(0.3 * (vAll[m] - SUP_DB)), 0.02, 20); continue }
      const short = Math.max(0, -vAll[m])
      rho[m] = cl(rho[m] * Math.exp(0.8 * short - 0.12), kind[m] === 1 ? 0.3 : 0.2, 90)
    }
  }
  }
  runIters(N > 250 ? 16 : 22)
  if (!bRe) { bRe = new Float64Array(N).fill(1); bIm = new Float64Array(N) }  // 数值兜底：等激励实数（正常流程不应触达）
  // ④ 出图场（峰点引导时按真实出图场闭环自适应，见下）
  const computeField = () => {
    const F = new Float64Array(NX * NY)            // 复场幅 |f|（下游只用功率 |f|²，故只写幅）
    let Fmax = 0, sumP = 0, kMax = 0
    for (let row = 0, k = 0; row < NY; row++) {
      const py = YS + dy * row
      for (let col = 0; col < NX; col++, k++) {
        const px = XS + dx * col
        let fr = 0, fi = 0
        for (const i of near(px, py, Rcut)) {
          const ax = px - centers[i][0], ay = py - centers[i][1]
          const g = Math.exp(-KF * (ax * ax + ay * ay) / (th * th))
          fr += bRe[i] * g; fi += bIm[i] * g
        }
        const mag = Math.hypot(fr, fi)
        F[k] = mag
        if (mag > Fmax) { Fmax = mag; kMax = k }
        // 立体角积分权重：igrid6 面元 dΩ = cos(az)·daz·del（az=X 网格坐标；∂/∂az 模长 1、∂/∂el 模长 cos az，正交）
        sumP += mag * mag * Math.cos(px * D2R)
      }
    }
    return { F, Fmax, sumP, kMax }
  }
  let { F, Fmax, sumP, kMax } = computeField()
  if (!(Fmax > 0)) throw new Error('合成场为空：请检查 Polygon 与参数')
  // —— 峰点引导自适应抬坡（对真实出图场闭环）：meet-or-exceed 允许区内自然超出（excess 不受罚，
  // SATSOFT 同款），静态目标坡可能被淹没（坡 +3dB、别处自然超出 +2.6dB → argmax 不在引导点）；且站点
  // 栅（θ3/2 步距）之间的细网格场还会高出站点采样。故直接量测出图场：argmax 不在任一正 boost 峰点
  // 核心（0.35w）内 → 按「全场峰 − 引导点场 + 0.4dB 保护带」抬坡重跑（≤3 轮、累计 ≤12dB、激励/权重
  // 热启动、少轮续跑）。仍然只动【优化目标】——可实现集合（口径受限激励）与 ∫P̂dΩ 守恒定标分毫未动；
  // 引导点物理上到不了（贴边/被隔离区压制/口径不足）时如实保持欠额，argmax 落点照实回报。——
  {
    let maxHB = 0
    for (let m = 0; m < M; m++) if (hb[m] > maxHB) maxHB = hb[m]
    let lifted = 0
    for (let adj = 0; adj < 3 && M && maxHB > 0.2; adj++) {
      const ax = XS + dx * (kMax % NX), ay = YS + dy * Math.floor(kMax / NX)
      let hNear = null, dNear = Infinity, fHot = 0
      for (const h of hots) {
        if (!(h.boost > 0) || h.az < XS || h.az > XE || h.el < YS || h.el > YE) continue
        const d = Math.hypot(ax - h.az, ay - h.el)
        if (d < dNear) { dNear = d; hNear = h }
        const col = cl(Math.round((h.az - XS) / dx), 0, NX - 1), row = cl(Math.round((h.el - YS) / dy), 0, NY - 1)
        if (F[row * NX + col] > fHot) fHot = F[row * NX + col]
      }
      if (!hNear || dNear <= 0.35 * hNear.w) break   // argmax 已落在引导点核心内
      const extra = Math.min(12 - lifted, 20 * Math.log10(Fmax / Math.max(fHot, 1e-12)) + 0.4)
      if (!(extra > 0.05)) break
      for (let m = 0; m < M; m++) if (hb[m] > 0) { tdb[m] += extra * (hb[m] / maxHB); tAmp[m] = Math.pow(10, tdb[m] / 20) }
      lifted += extra
      scoreBest = Infinity; rippleBest = 0           // 目标变了：留优重置（rho/激励热启动续跑，少轮即收敛）
      runIters(N > 250 ? 10 : 12)
      ;({ F, Fmax, sumP, kMax } = computeField())
    }
  }
  // ⑤ 定标（value 模式，对齐 Use Polygon Labels 绝对标签）：令各站点绝对电平 ≥ 其标签，最差覆盖点≈value。
  //   站点绝对目标 T_m = value + (tdb_m − minTdb)（minTdb=最低目标偏移，对应外圈=value）；achieved = peakDbi + rel_m。
  //   q_m = (tdb_m − minTdb) − rel_m（越大=越难达标）；peakDbi = value + q 的【高分位】→ 绝大多数站点 ≥ 各自标签。
  //   —— 关键修复：旧版锚"边界中位数"，被内圈波束尾巴抬高的近内圈边界污染 → 把远外圈顶到 value 之下成空洞。
  let relMin = Infinity, minTdb = Infinity
  for (let m = 0; m < M; m++) if (kind[m] !== 2 && tdb[m] < minTdb) minTdb = tdb[m]
  if (!Number.isFinite(minTdb)) minTdb = 0
  const qArr = [], outRel = []
  for (let m = 0; m < M; m++) {
    if (kind[m] === 2) continue
    const [fr, fi] = fld(bRe, bIm, m)
    const rel = 20 * Math.log10(Math.max(Math.hypot(fr, fi), 1e-8) / Fmax)
    if (rel < relMin) relMin = rel
    qArr.push((tdb[m] - minTdb) - rel)
    if (tdb[m] - minTdb < 0.01) outRel.push(rel)   // 最低目标(外圈/保底)站点，用于 physical 边缘值
  }
  if (!Number.isFinite(relMin)) relMin = 0
  qArr.sort((a, b) => a - b); outRel.sort((a, b) => a - b)
  // 物理增益恒先算（能量守恒锚）。定标（对齐物理，抵消高斯 beamlet 无旁瓣的高增益高估）：
  //   D = η_ap · 4πA/λ² · Ω₁/∫P̂dΩ —— Ω₁=单支高斯 beamlet 立体角=π·θ3²/(4ln2)；比值 Ω₁/∫P̂dΩ 用【同一高斯模型】
  //   度量单支 vs 赋形场，模型误差抵消 → 单支 beamlet 恰=物理笔形波束 η_ap·4πA/λ²，赋形随形张开自然降增益。
  //   η_ap（口径效率＝照射×溢出）由馈源锥度定死（shapedApertureEff，只读）。缺口径/频率信息时回退旧 4π/∫P̂dΩ 口径。
  const intP = (sumP / (Fmax * Fmax)) * dx * dy * D2R * D2R   // 合成场立体角 ∫P̂dΩ/P̂max（cos az 已入 sumP）
  const etaAp = cl(effPct, 1, 100) / 100
  const th3r = theta3 * D2R                                   // θ3 弧度
  const omega1 = Math.PI * th3r * th3r / (4 * Math.LN2)       // 单支高斯 beamlet 立体角
  const lamS = fSimGHz > 0 ? 0.299792458 / fSimGHz : 0
  const maxDir = (apDm > 0 && lamS > 0) ? 4 * Math.PI * (Math.PI * (apDm / 2) ** 2) / (lamS * lamS) : 0   // 均匀口径最大方向性 4πA/λ²
  const physPeakDbi = (maxDir > 0 && intP > 0)
    ? 10 * Math.log10(etaAp * maxDir * omega1 / intP)
    : 10 * Math.log10(etaAp * 4 * Math.PI / intP)
  let peakDbi
  if (mode === 'physical') peakDbi = physPeakDbi
  else peakDbi = covValue + (qArr.length ? qArr[Math.floor(qArr.length * 0.92)] : -relMin)
  const paDb = peakDbi - physPeakDbi               // 功放偏置（dB）：'physical' 恒 0
  const outMed = outRel.length ? outRel[Math.floor(outRel.length / 2)] : relMin
  const edgeVal = mode === 'value' ? covValue : peakDbi + outMed
  const covMin = peakDbi + relMin                  // 覆盖区（含边界）绝对最低点，如实回报
  // ⑥ 写 GRD（与高斯档同构：icomp3/ncomp2/igrid6；分量1 = 场幅 |f|·S ≥0，P1=c1²=|f|²·S² 即共极化功率）
  const S = Math.pow(10, peakDbi / 20) / Fmax
  const fAmp = Math.pow(10, (peakDbi + floorDb) / 20)
  // 真实场峰值落点（argmax，仅如实回报——峰落在哪由物理合成决定，不可指定）
  const peakAt = [XS + dx * (kMax % NX), YS + dy * Math.floor(kMax / NX)]
  const head = []
  // GRASP ASCII 纯 ASCII 表头（对齐真实参考 .grd；非 ASCII 星名已剔除）。SYNTHMETA 为精简元数据行。
  const sn = asciiSafe(satName)
  head.push(`SatSim synthesized pattern (SATSOFT-style contour shaping)${sn ? ' - ' + sn : ''}. Sat. lon=${(+satLon).toFixed(2)}, lat=${(+(satLat || 0)).toFixed(2)}, height=${Math.round(altKm)} km, beamlets=${N}`)
  head.push(`SYNTHMETA ${JSON.stringify({ kind: 'shaped', satLon: +satLon.toFixed(4), satLat: +(satLat || 0).toFixed(4), altKm: Math.round(altKm), mode, value: +edgeVal.toFixed(2), peak: +peakDbi.toFixed(2), physPeak: +physPeakDbi.toFixed(2), pa: +paDb.toFixed(2), theta3: +th.toFixed(4), nBeams: N, nPolys: polys.length, ...(hots.length ? { hot: hots.length } : {}), ...(pol ? { pol } : {}) })}`)
  head.push('++++')
  head.push('1')
  head.push(' 1 3 2 6')
  head.push('  0  0')
  head.push(` ${fexp(XS)} ${fexp(YS)} ${fexp(XE)} ${fexp(YE)}`)
  head.push(` ${NX} ${NY} 0`)
  const L = new Array(NX * NY)
  const zero = fexp(0)
  for (let k = 0; k < NX * NY; k++) {
    let c = F[k] * S
    if (c < fAmp) c = fAmp                          // 地板：避免 0 功率/−∞ dB 点
    L[k] = ` ${fexp(c)} ${zero} ${zero} ${zero}`
  }
  let warn = ''
  const dropPct = 100 * unreach / Math.max(1, covCnt + unreach)
  const cornerDip = edgeVal - covMin               // 最差覆盖点低于边缘保证值的量（dB）
  if (dropPct > 2) warn = `约 ${dropPct.toFixed(0)}% 覆盖细节小于波束分辨率 θ3=${th.toFixed(2)}°，无法贴合（加大口径可改善）`
  else if (N <= 2 && omegaDeg2 < 1.5 * 0.866 * Math.pow(BEAMLET_SP * th, 2)) warn = `区域尺度小于 θ3=${th.toFixed(2)}°，赋形退化为准单波束（加大口径方能贴合 Polygon）`
  else if (cornerDip > 2.5) warn = `个别边角凹陷至 ${covMin.toFixed(1)}（低于保证值 ${cornerDip.toFixed(1)} dB）—— 细部小于口径分辨率 θ3=${th.toFixed(2)}°，加大口径可贴合`
  const hotOut = hots.filter((h) => geo.signedDist(h.az, h.el) < 0).length
  if (hotOut) warn = (warn ? warn + '；' : '') + `${hotOut} 个峰点在覆盖区外 —— 目标场只作用于覆盖区内/边界站点，区外峰点基本无效（请移入 Polygon）`
  return { text: head.join('\r\n') + '\r\n' + L.join('\r\n') + '\r\n', value: edgeVal, peakDbi, physPeakDbi, paDb, covMin, omegaDeg2, nBeams: N, rippleDb: rippleBest / 2, nx: NX, ny: NY, warn, peakAt }
}

// ================= 草图几何（放置阶段的轮廓预览，与场合成同一几何链 → 所见即所得） =================
// 波束 3dB 椭圆草图环：在方向空间取椭圆（半轴 θx/2、θy/2，含旋转），逐点 gridDir(6)→天底 basis 投影 WGS84。
// 越地平的点被剔除 → 返回连续段数组 [[ [lon,lat],... ], ...]（全部越地平返回 []）。
export function beamSketchRing({ satLon, satLat = 0, altKm, lon, lat, thX, thY, rot = 0, n = 72 }) {
  const ae = dirToAzEl(satLon, satLat || 0, altKm, lon, lat)
  const basis = nadirBasis(satLon, satLat, altKm)
  const rg = -(rot || 0) * D2R, cr = Math.cos(rg), sr = Math.sin(rg)
  const segs = []
  let cur = null
  for (let i = 0; i <= n; i++) {
    const ps = (i % n) * 2 * Math.PI / n
    const xp = (thX / 2) * Math.cos(ps), yp = (thY / 2) * Math.sin(ps)
    const az = ae.az + (xp * cr - yp * sr), el = ae.el + (xp * sr + yp * cr)
    const p = project(gridDir(6, az, el), basis)
    if (p) { if (!cur) { cur = []; segs.push(cur) } cur.push([p.lon, p.lat]) }
    else cur = null
  }
  return segs.filter((s) => s.length >= 2)
}

// Polygon 蜂窝布满：在方向空间（az/el 平面）以间距 spacing（deg）铺六角格，取落在多边形内的
// 格心映射回地面经纬度。返回 [{lon,lat}]（按自北向南、自西向东排序，编号稳定）。
export function hexFillCenters({ satLon, satLat = 0, altKm, polyPts, spacing }) {
  if (!polyPts || polyPts.length < 3 || !(spacing > 0)) return []
  const V = polyPts.map((p) => { const ae = dirToAzEl(satLon, satLat || 0, altKm, p[0], p[1]); return [ae.az, ae.el] })
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const q of V) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1] }
  const rowH = spacing * Math.sqrt(3) / 2
  const inside = (px, py) => {
    let ins = false
    for (let i = 0; i < V.length; i++) {
      const a = V[i], b = V[(i + 1) % V.length]
      if ((a[1] > py) !== (b[1] > py) && px < a[0] + (py - a[1]) / (b[1] - a[1]) * (b[0] - a[0])) ins = !ins
    }
    return ins
  }
  const out = []
  let r = 0
  for (let ey = y0; ey <= y1 + 1e-9; ey += rowH, r++) {
    const off = (r % 2) ? spacing / 2 : 0
    for (let ax = x0 + off; ax <= x1 + 1e-9; ax += spacing) {
      if (!inside(ax, ey)) continue
      const g = azElGround(satLon, satLat || 0, altKm, ax, ey)
      if (g) out.push({ lon: +g.lon.toFixed(4), lat: +g.lat.toFixed(4), _el: ey, _az: ax })
    }
  }
  out.sort((a, b) => (b._el - a._el) || (a._az - b._az))
  return out.map(({ lon, lat }) => ({ lon, lat }))
}

// SATSOFT 式「相切吸附」（方向空间纯几何）：点击落点吸附到与已有波束边缘相切的位置。
// click=[az,el]；neighbors=[{az,el,r}]（r=波束等效半径，取 3dB 半宽）；rNew=新波束等效半径。
// 捕获圈 = 中心距 < (r+rNew)·capture 的邻居：
//   1 个 → 沿「邻居中心→点击」方向推到中心距 = r+rNew（外切）；
//   2 个 → 取两相切圆的交点中靠近点击的一个（蜂窝密堆手感，与截图的紧贴排布一致）；
//   0 个 → 原样返回点击点。返回 { az, el, snapped: 0|1|2 }。
// band（拖拽用）：改为窄带捕获 |d−R| < R·band —— 只在指针「经过相切位置」附近时轻轻帮一把，
// 深度交叠/远离时完全不干预（点击放置的宽捕获在拖拽中会粘手，故两态口径分开）。
export function snapTangentAzEl(click, neighbors, rNew, capture = 1.6, band = null) {
  const cand = (neighbors || [])
    .map((n) => ({ az: n.az, el: n.el, d: Math.hypot(click[0] - n.az, click[1] - n.el), R: n.r + rNew }))
    .filter((n) => n.d > 1e-9 && (band != null ? Math.abs(n.d - n.R) < n.R * band : n.d < n.R * capture))
    .sort((a, b) => band != null
      ? Math.abs(a.d - a.R) / a.R - Math.abs(b.d - b.R) / b.R
      : a.d / a.R - b.d / b.R)
  if (!cand.length) return { az: click[0], el: click[1], snapped: 0 }
  const n1 = cand[0]
  if (cand.length >= 2) {
    const n2 = cand[1]
    const dx = n2.az - n1.az, dy = n2.el - n1.el, D = Math.hypot(dx, dy)
    if (D > 1e-9 && D < n1.R + n2.R && D > Math.abs(n1.R - n2.R)) {   // 两相切圆相交 → 双切点存在
      const a = (n1.R * n1.R - n2.R * n2.R + D * D) / (2 * D)
      const h2 = n1.R * n1.R - a * a
      if (h2 > 0) {
        const h = Math.sqrt(h2), mx = n1.az + a * dx / D, my = n1.el + a * dy / D
        const p1 = [mx + h * dy / D, my - h * dx / D], p2 = [mx - h * dy / D, my + h * dx / D]
        const c1 = Math.hypot(click[0] - p1[0], click[1] - p1[1]), c2 = Math.hypot(click[0] - p2[0], click[1] - p2[1])
        const p = c1 <= c2 ? p1 : p2
        return { az: p[0], el: p[1], snapped: 2 }
      }
    }
  }
  const ux = (click[0] - n1.az) / n1.d, uy = (click[1] - n1.el) / n1.d
  return { az: n1.az + ux * n1.R, el: n1.el + uy * n1.R, snapped: 1 }
}

// ================= 频率计划自动配色（SATSOFT 三色/四色填充同款用途） =================
// 图着色：相邻（相切/交叠，中心距 < (ri+rj)·adjFactor）的波束不得同色，k 色内均衡使用。
// nodes=[{az,el,r}]（方向空间中心与等效半径）。返回 { colors:[0..k-1,...], conflicts }。
// 取色策略（对齐 SATSOFT 蜂窝观感）：
//   1) 扫描线次序（按行自北向南、行内自西向东）——蜂窝格上贪心即收敛为周期性规则复用图案，
//      不用 DSATUR 动态次序（其结果虽合法但呈补丁状，不像频率规划图）；
//   2) 可行色中取「全局用量最少」（并列取最小编号）——k 色都用起来（四色蜂窝呈菱形 1234 图案，
//      而非退化成三色），自由摆放时各频段负载也均衡；
//   3) 无可行色（该布局色数不足）→ 取冲突邻居最少的颜色，随后多轮局部修复压低冲突对数。
export function colorFreqPlan(nodes, k, adjFactor = 1.18) {
  const n = nodes.length
  if (!n || !(k >= 2)) return { colors: [], conflicts: 0 }
  const adj = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = Math.hypot(nodes[i].az - nodes[j].az, nodes[i].el - nodes[j].el)
    if (d < (nodes[i].r + nodes[j].r) * adjFactor) { adj[i].push(j); adj[j].push(i) }
  }
  // 行分组：按 el 降序聚类（容差 = 半径中位数×0.5，吸掉经纬取整带来的行内抖动），行内按 az 升序
  const byEl = nodes.map((q, i) => i).sort((a, b) => nodes[b].el - nodes[a].el)
  const rs = nodes.map((q) => q.r).sort((a, b) => a - b)
  const tol = (rs[rs.length >> 1] || 0.5) * 0.5
  const order = []
  for (let s = 0; s < byEl.length;) {
    let e = s + 1
    while (e < byEl.length && nodes[byEl[s]].el - nodes[byEl[e]].el < tol) e++
    order.push(...byEl.slice(s, e).sort((a, b) => nodes[a].az - nodes[b].az))
    s = e
  }
  const colors = new Array(n).fill(-1), used = new Array(k).fill(0)
  const conflictsOf = (i, c) => { let m = 0; for (const j of adj[i]) if (colors[j] === c) m++; return m }
  for (const i of order) {
    let best = -1, bestKey = Infinity
    for (let c = 0; c < k; c++) {
      const cf = conflictsOf(i, c)
      const key = cf * 1e6 + used[c] * 10 + c * 1e-3   // 先零冲突，再用量最少，再最小编号
      if (key < bestKey) { bestKey = key; best = c }
    }
    colors[i] = best; used[best]++
  }
  // 局部修复：仍有冲突的节点尝试换到冲突更少的颜色，至稳定（上限 30 轮，防振荡）
  for (let pass = 0; pass < 30; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      const cur = conflictsOf(i, colors[i])
      if (!cur) continue
      let bc = colors[i], bcf = cur
      for (let c = 0; c < k; c++) { if (c === colors[i]) continue; const cf = conflictsOf(i, c); if (cf < bcf) { bcf = cf; bc = c } }
      if (bc !== colors[i]) { used[colors[i]]--; colors[i] = bc; used[bc]++; moved = true }
    }
    if (!moved) break
  }
  let conflicts = 0
  for (let i = 0; i < n; i++) for (const j of adj[i]) if (j > i && colors[j] === colors[i]) conflicts++
  return { colors, conflicts }
}
