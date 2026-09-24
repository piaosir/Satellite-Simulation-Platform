// 船舶领域装配组件（三期契约 DESIGN3 §1 P1b、E5、E13；A3 规格 §5）。
//
// 纯 ESM、零 three 依赖、node 可测、确定性（同参数同 IR 字节；伪随机只走 shapeKit.rng(hash32(参数))，无随机数 / 时钟）。
//
// ★ 局部坐标 = 船舶本体 FRD（+X 船艏、+Y 右舷、+Z 向下；E5，assembly.mjs DOMAIN_FRAMES.ship），组件口径见 shapeKit.mjs 文件头：
//   立在父面上的件 mount 插座 n = +Z（standSocket），件向 −Z 长高；贴甲板面时单位位姿即与船体同向。
//
// ★ 组件（登记顺序即组件库卡片顺序）：
//   sea.hull            船体（根件，massSink 'hull'，发 datum 挂点 = 水线面 ∩ 船中 ∩ 中线；龙骨 z = +吃水、主甲板 z = −(型深 − 吃水)）。
//                       逐站截面 = 水下超椭圆四分之一 + 干舷外飘段：超椭圆指数随站位变——中体按「平底 + 舭部圆弧 + 直舷」的剖面系数
//                       面积等效反推（方正带圆舭），向艏收到 U 形，向艉经 V 形去流段到空心 V 形艉鳍（桨轴从这里伸出），
//                       桨上方是扁平艉悬（艉柱后缘是一道硬边断面）；水线面半宽的丰满度按方形系数二分反解
//                       （水线下体积 ≈ cb × 0.97·LOA × 型宽 × 吃水）。前倾艏柱 + 艏部外飘 + 艏楼台阶 + 防浪墙、球鼻（独立放样）、
//                       方艉（艉封板水下 / 水上两块）或巡洋舰艉（圆艉 + 艉线后倾）、水线带、NACA 截面舵（关节 rudder）、
//                       五叶侧斜螺旋桨（按螺距扭转，关节 spin）+ 艉轴毂。水下 / 干舷 / 甲板三块材质合起来是闭合实体。
//   sea.superstructure  上层建筑：逐层圆角矩形拉伸 + 层间甲板檐 + 窗、顶层驾驶室连续窗带、翼桥（平台 + 翼端驾驶台 + 斜撑）、
//                       艉墙自由降落救生艇（滑道）、顶面空调箱。
//   sea.funnel          烟囱：后倾收分的圆角矩形拉伸 + 顶部深色带 + 排气管（随后倾角）。
//   sea.mast            雷达桅：锥形主杆 + 两根后撑腿 + 桅顶平台（护栏）+ 横桁（左红右绿舷灯）+ 桅灯 + 开放阵列雷达
//                       （托架 + 齿轮箱固定，天线条每部一条 spin 关节）。
//   sea.containers      甲板集装箱块（ISO 668）：每堆按伪随机分 1–4 段不同颜色的盒；露出的舷侧面是几何瓦楞（梯形波纹、与箱同色）+ 侧梁平带，
//                       最后一贝端面门线 / 锁杆、端面与舷侧层缝 / 角柱贴花、舱口盖（不宽于箱块）、贝间绑扎桥；每贝一个质量元。
//   sea.vsat.radome     船载 VSAT 罩：截球罩（含赤道环，总高 / 最大径逐位等于预设）+ 锥台基座 + 法兰 + 检修门；
//                       罩内主焦天线（凹面 / 背面 / 口沿 + 馈源 + 四撑杆 + 俯仰轴）与叉臂 / 转台，关节与地球站同口径
//                       （gimbal = azimuth + elevation、azimuth = 只转方位；节点系 ground.gimbalFrame('azel', +X, −Z)，挂点 boresight 在球心）。
//
// ★ 缺省参数一律示意值（source:'illustrative'，口径进悬停 title）；有出处的只有 ISO 668 集装箱尺寸与 Intellian 三款船载罩预设
//   （研究表逐字：v100NX / v130NX / v240M 的罩高、罩径、反射面、质量）。内置目录不带相关型号（用户 2026-09-24 定）。
// ★ 对称面声明都是真的：船体左右两半逐位取反生成（截面行显式取反、干舷与水线带右舷造好后整体镜像复制），
//   带螺旋桨时不声明对称面（右旋桨有手性）；集装箱颜色不对称，不声明。
// ★ 材质：船壳红 / 深蓝 / 甲板绿 / 集装箱彩色 / 舷灯 / 救生艇橙走 shapeKit.matOr（计划键落地后自动升级，今天回退到现有键）。
//
// 导出：
//   SEA_COMPONENTS   组件定义（sea.hull / sea.superstructure / sea.funnel / sea.mast / sea.containers / sea.vsat.radome）
//   SHIP_RADOMES     船载罩预设表（型号 → {H 罩高, D 罩径, reflD 反射面口径, massKg 整机质量, source}；米 / 千克）
//   hullShapeInfo(p) → 船体的派生量（p 可为补过缺省的参数）：{T, fb, fcH, xStemWL, xFc0, xFc1, pm, eMid, fullness, sectionRate, Dp, xProp,
//                      zShaft, targetVolM3, deckHalfWidth(x)}——模板 / 单测对拍用（与 build 同一套式子；xFc0 = 艏楼坡起点，
//                      deckHalfWidth = 主甲板边线半宽，模板排集装箱列数用）

import { isNum, add, sub, scl, cross, madd, clampN, IDR, MB, box, frustum, annulus, boxComp } from '../meshKit.mjs'
import {
  ISO668, num, int, bool, enm, auto, D2R, sock, standSocket, planeFace,
  grid, cap, lathe, torus, prism, tubeAlong, airfoilRing, solidCompItems, shellMass,
  stage, apLocal, put, putFramed, ISO_BOX, matOr, datumAp, superRing, loft, extrude, roundRect, decal, rng, hash32,
  smooth01, mirrorCopyY, scaleMass
} from './shapeKit.mjs'
import { STAGE, gimbalFrame, azStage } from './ground.mjs'

// ───────────────────────────── 预设 / 材质 ─────────────────────────────

const V100NX_URL = 'https://intelliantech.com/en/products/nx-maritime-vsat/v100nx'
const V130NX_URL = 'https://intelliantech.com/en/products/nx-maritime-vsat/v130nx'
const V240M_URL = 'https://intelliantech.com/en/products/2-4m-maritime-vsat/v240m-2'
/** Intellian 船载罩预设（研究表逐字：radomeHxDcm × 0.01、reflectorDiameterCm × 0.01、massKg）。 */
export const SHIP_RADOMES = Object.freeze({
  v100nx: Object.freeze({ H: 1.458, D: 1.379, reflD: 1.05, massKg: 113, source: V100NX_URL }),
  v130nx: Object.freeze({ H: 1.681, D: 1.724, reflD: 1.25, massKg: 150, source: V130NX_URL }),
  v240m: Object.freeze({ H: 4.31, D: 3.91, reflD: 2.4, massKg: 1133, source: V240M_URL })
})

const MAT = Object.freeze({
  bottom: matOr('paint_red', 'titanium'),      // 水线下防污漆（含水线带、舵、艉轴毂）
  topside: matOr('paint_navy', 'dark_metal'),  // 干舷
  deck: matOr('paint_green', 'titanium'),      // 甲板
  portLight: matOr('paint_red', 'dark_metal'),
  stbdLight: matOr('paint_green', 'titanium'),
  lifeboat: matOr('paint_orange', 'aluminum')
})
/** 集装箱调色板（计划键 → 今天的回退键轮换 white_paint / titanium / aluminum / dark_metal）。 */
const BOX_PALETTE = Object.freeze([
  matOr('paint_red', 'white_paint'), matOr('paint_blue', 'titanium'), matOr('paint_orange', 'aluminum'),
  matOr('paint_yellow', 'dark_metal'), matOr('paint_grey', 'white_paint'), matOr('paint_green', 'titanium')
])

// ───────────────────────────── 小工具（本领域私有） ─────────────────────────────

/** 对数插值（指数类量：超椭圆指数沿船长变化）。 */
const logLerp = (a, b, t) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * clampN(t, 0, 1))

/**
 * t₊^r 在 t = 0 处磨圆（C2）：半宽 h 的三角核卷积，闭式 (G(t+h) − 2G(t) + G(t−h)) / h²、G(u) = u₊^(r+2) / ((r+1)(r+2))；
 * t ∈ [2h, 4h] 用 smooth01 过渡回 t^r，此后逐位等于 t^r，t ≤ −h 为 0。卷积保单调、非负，r 凸（> 1）凹（< 1）都成立。
 * 船体肩部用：平行中体两端水线 1 − t^q（q < 2 时曲率在 t = 0 发散，网格上第一站就折 4–5°）与截面指数 t^0.8（斜率发散）在这里抹平。
 */
function roundPow(t, r, h) {
  const raw = t > 0 ? t ** r : 0
  if (!(h > 0) || t >= 4 * h) return raw
  if (t <= -h) return 0
  const k = 1 / ((r + 1) * (r + 2)), G = (u) => (u > 0 ? k * u ** (r + 2) : 0)
  const conv = (G(t + h) - 2 * G(t) + G(t - h)) / (h * h)
  return t <= 2 * h ? conv : conv + (raw - conv) * smooth01((t - 2 * h) / (2 * h))
}


/** Γ 函数（Lanczos g = 7，参数恒 ≥ 1）。 */
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
function gammaFn(z) {
  const zz = z - 1
  let x = LANCZOS[0]
  for (let i = 1; i < 9; i++) x += LANCZOS[i] / (zz + i)
  const t = zz + 7.5
  return Math.sqrt(2 * Math.PI) * t ** (zz + 0.5) * Math.exp(-t) * x
}
/** 超椭圆四分之一 |y/a|^e + |z/b|^e ≤ 1 的面积 / (a·b)。 */
const secCoef = (e) => { const g = gammaFn(1 + 1 / e); return (g * g) / gammaFn(1 + 2 / e) }

/** 截面折线（[y, z]，z 非减）在深度 z 处的半宽（线性插值，越界取端点）。 */
function yAtZ(poly, z) {
  if (z <= poly[0][1]) return poly[0][0]
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i]
    if (z <= b[1]) { const dz = b[1] - a[1]; return dz > 1e-12 ? a[0] + (b[0] - a[0]) * (z - a[1]) / dz : b[0] }
  }
  return poly[poly.length - 1][0]
}
/** 站位下标区间按断点切段：[[a, b], …]（相邻段共用断点那一行 = 硬边）。 */
function splitRanges(n, cuts) {
  const ks = [0, ...cuts.filter((i) => i > 0 && i < n - 1).sort((a, b) => a - b), n - 1]
  const out = []
  for (let k = 0; k < ks.length - 1; k++) if (ks[k + 1] > ks[k]) out.push([ks[k], ks[k + 1]])
  return out
}

// ───────────────────────────── 船体 ─────────────────────────────

const STEM_RAKE = 30 * D2R    // 艏柱水线以上前倾（示意）
const STERN_RAKE = 40 * D2R   // 巡洋舰艉艉线后倾（示意）
const SHOULDER_ROUND = 0.04   // 肩部磨圆半宽 / 总长（示意；逐站转角压到 2–2.6°，平行中体两端各让出这么长做过渡）

/** 船体主尺度与艏楼（轻量：插座 / 面也用）。 */
function hullDims(p) {
  const L = p.loaM, B = p.beamM, hb = B / 2, D = p.depthM, T = auto(p.draftM, 0.5 * D), fb = D - T
  const fcH = auto(p.forecastleHM, 0.1 * D)
  const ho = Math.min((fb + fcH) * Math.tan(STEM_RAKE), 0.06 * L)      // 艏柱水线点到总长前端
  const fcLen = 0.09 * L, xFc1 = L / 2 - fcLen
  const ramp = fcH > 0 ? clampN(0.7 * fcH, 0.002 * L, 0.25 * fcLen) : 0
  return { L, B, hb, D, T, fb, fcH, ho, xT: -L / 2, xStemWL: L / 2 - ho, fcLen, xFc0: xFc1 - ramp, xFc1, xFcC: L / 2 - 0.55 * fcLen }
}
/** 甲板线 z（主甲板平，艏楼台阶按直线坡连到艏楼甲板）。 */
const zDeckOf = (g, x) => (g.fcH > 0 ? -g.fb - g.fcH * clampN((x - g.xFc0) / (g.xFc1 - g.xFc0), 0, 1) : -g.fb)

/**
 * 船体型线（全部由参数确定；build 与 hullShapeInfo 共用）。
 * 纵向：艉封板（或圆艉）→ 桨上方艉悬 → 艉柱断面 xB → 艉鳍 → 去流段 → 平行中体 [xPMa, xPMf] → 进流段 → 艏踵 → 艏柱水线点 → 前倾艏柱。
 * 截面：水下 = 超椭圆四分之一（半宽 aW、中线深 d、指数 e），水上 = 自水线半宽 aW 外飘到甲板半宽 yD（τ^1.4）。
 * 肩部（平行中体两端）：水线收窄、截面指数、艏部外飘起步都过 roundPow 磨圆（半宽 SHOULDER_ROUND·L，不超过所在段长的 10%），
 * 平行中体真正平直的一段缩成 [xM0, xM1]；磨圆削掉的一点体积由丰满度二分自动补回（q 只动千分之几）。
 */
function hullShape(p) {
  const g = hullDims(p), { L, B, hb, T, fb, xT, xStemWL } = g
  const cruiser = p.stern === 'cruiser'
  // 平行中体长 / 总长（示意）：方形系数 0.65 的集装箱船约 0.14（中剖面近方形，中体再长就只能把进流段做成内凹来减体积，
  // 半宽式 1 − t^q 的 q 落到 1 以下、在中体端点斜率无穷大，肩部成硬折角）；cb > 0.75 的肥大船中体加长
  // （0.85 约 0.58、0.9 到上限 0.8），进流段丰满度 q 停在 2–3，不至于为凑体积把艏部做成方头
  const pm = clampN(1.6 * p.cb - 0.9 + 12 * Math.max(0, p.cb - 0.75) ** 2, 0, 0.8), xPMf = pm * L / 2, xPMa = -pm * L / 2
  // 中剖面：平底 + 舭部圆弧 + 直舷 → 面积等效的超椭圆指数（剖面系数随指数单调增）
  const rb = clampN(auto(p.bilgeRM, 0.045 * B), 0, 0.95 * Math.min(hb, T))
  const csMid = 1 - (1 - Math.PI / 4) * rb * rb / (hb * T)
  let eM = 60
  if (secCoef(60) > csMid) {
    let lo = 1.5, hi = 60
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (secCoef(m) < csMid) lo = m; else hi = m }
    eM = (lo + hi) / 2
  }
  // 艉部：圆艉的水线端点前移 hoS；桨在水线端点之前，艉柱断面 xB 紧贴桨前
  const yK = 0.55 * hb, Rk = Math.min(yK, 0.5 * (xPMa - xT))
  const hoS = cruiser ? Math.min(0.6 * Rk, fb * Math.tan(STERN_RAKE), 0.04 * L) : 0
  const xWLa = xT + hoS, xK = xT + Rk
  const Dp = Math.min(auto(p.propDM, 0.65 * T), 0.9 * T, 0.08 * L), Rp = Dp / 2
  const zSh = 0.96 * T - Rp
  const xP = xWLa + clampN(1.5 * Dp + 0.01 * L, 0.02 * L, 0.12 * L)
  const xB = Math.min(xP + 0.2 * Dp, xT + 0.17 * L)
  const eps = Math.max(0.03 * Dp, 1e-4 * L), xB0 = xB - eps
  const xCut = Math.max(Math.min(xB + 0.8 * Dp + 0.03 * L, xPMa - 0.005 * L), xB + 0.005 * L)
  const zBoss = Math.min(zSh + 0.12 * Dp, T)
  const dTr = cruiser ? 0 : 0.02 * T
  const zCtr = clampN(zSh - Rp - 0.15 * Dp, dTr, T)
  // 艉封板宽随方形系数：cb 0.65 时水线处 0.55、甲板处 0.89 × 半宽；瘦船艉封板窄（否则去流段体积降不下来）
  const aTr = cruiser ? 0 : hb * clampN(1.4 * p.cb - 0.36, 0.15, 0.62), yDTr = hb * clampN(0.5 + 0.6 * p.cb, 0.7, 0.9)
  const xFF = xStemWL - 0.035 * L
  // 肩部磨圆：艏段（水线 / 截面指数 / 外飘，段长 Lf）、艉段水线（La）、艉段截面指数（Lc，艉鳍前的去流段）各按段长归一；
  // 水线半宽与截面指数都写成「平行中体值 − 艏段项 − 艉段项」的线性组合，平行中体短到两个磨圆区重叠（cb ≲ 0.56 时 pm = 0）也连续
  const Lf = xStemWL - xPMf, La = xPMa - xWLa, Lc = xPMa - xCut, hm = SHOULDER_ROUND * L
  const hF = Math.min(hm, 0.1 * Lf), hA = Math.min(hm, 0.1 * La), hC = Lc > 0 ? Math.min(hm, 0.1 * Lc) : 0
  const phiF = (x, r) => roundPow((x - xPMf) / Lf, r, hF / Lf), phiA = (x, r) => roundPow((xPMa - x) / La, r, hA / La)
  const phiC = (x, r) => (Lc > 0 ? roundPow((xPMa - x) / Lc, r, hC / Lc) : 0)

  // 水线（或艏柱 / 艉线）高度、中线龙骨深 d、水线半宽 aW(q)、截面指数 e
  const zWof = (x) => (x > xStemWL ? -(fb + g.fcH) * (x - xStemWL) / g.ho : x < xWLa ? -fb * (xWLa - x) / hoS : 0)
  const dOf = (x) => {
    if (x > xStemWL || x < xWLa) return zWof(x)
    if (x >= xFF) { const u = (x - xFF) / (xStemWL - xFF); return T * Math.sqrt(Math.max(0, 1 - u * u)) }
    if (x >= xCut) return T
    if (x >= xB) return zBoss + (T - zBoss) * Math.sin((x - xB) / (xCut - xB) * Math.PI / 2)
    const u = clampN((x - xWLa) / (xB0 - xWLa), 0, 1)
    return dTr + (zCtr - dTr) * u ** 1.3
  }
  // 艏段 hb·(1 − t^q)、艉段 aTr + (hb − aTr)(1 − t^q)，肩部磨圆
  const aWof = (x, q) => (x > xStemWL || x < xWLa ? 0 : Math.max(0, hb - hb * phiF(x, q) - (hb - aTr) * phiA(x, q)))
  // 截面指数：中体 eM → 艏 2.2（U 形）/ 去流段 1.4 → 艉鳍 0.75（空心 V）→ 艉悬 2.2；γ 控制离开中体后变瘦的快慢
  // （艏 / 艉两段在对数域里叠加，等价于原来的 logLerp(eM, 2.2, t^0.8γ) 与 logLerp(eM, 1.4, t^γ)，肩部磨圆）
  const eAt = (x, gm, em) => {
    if (x >= xCut || x >= xPMa) return em * (2.2 / em) ** clampN(phiF(x, 0.8 * gm), 0, 1) * (1.4 / em) ** clampN(phiC(x, gm), 0, 1)
    if (x >= xB) return logLerp(1.4, 0.75, (xCut - x) / (xCut - xB))
    return 2.2
  }
  // 丰满度三个旋钮按排水体积依次二分（体积对每个都单调增）：先调水线半宽 1 − t^q 的指数 q；
  // q 到下限 1.2 仍嫌胖（小方形系数的瘦长船）再把中剖面指数往 2.2 收（瘦长船本来就是圆舭，中剖面系数降下来）；
  // 圆舭到底还嫌胖（cb ≲ 0.45）最后调 γ，让艏艉截面更快收成 U / V 形。
  // q 下限 > 1：水线在平行中体两端切向连续（q < 1 时斜率无穷大 = 肩部硬折角）；γ 放最后：γ 小了截面指数在船中附近陡变
  const K = 480, dxC = (xStemWL - xWLa) / K, cx = [], cd = []
  for (let k = 0; k < K; k++) { const x = xWLa + (k + 0.5) * dxC, d = dOf(x); if (d > 0) { cx.push(x); cd.push(2 * d * dxC) } }
  const csOf = (gm, em) => cx.map((x) => secCoef(eAt(x, gm, em)))
  const vol = (q, cs) => { let v = 0; for (let k = 0; k < cx.length; k++) v += aWof(cx[k], q) * cd[k] * cs[k]; return v }
  const bisect = (lo, hi, f, n) => { for (let i = 0; i < n; i++) { const m = (lo + hi) / 2; if (f(m) < Vt) lo = m; else hi = m } return (lo + hi) / 2 }
  const Vt = p.cb * 0.97 * L * B * T, Q_MIN = 1.2, Q_MAX = 20, G_MIN = 0.05, E_MIN = 2.2
  let q = Q_MAX, gam = 1, eMid = eM
  const cs1 = csOf(1, eM)
  if (vol(Q_MAX, cs1) > Vt) {
    if (vol(Q_MIN, cs1) < Vt) q = bisect(Q_MIN, Q_MAX, (m) => vol(m, cs1), 50)
    else {
      q = Q_MIN
      const fE = (m) => vol(Q_MIN, csOf(1, Math.exp(m)))
      if (eM > E_MIN && fE(Math.log(E_MIN)) < Vt) eMid = Math.exp(bisect(Math.log(E_MIN), Math.log(eM), fE, 40))
      else {
        eMid = Math.min(eM, E_MIN)
        const fG = (m) => vol(Q_MIN, csOf(m, eMid))
        gam = fG(G_MIN) < Vt ? bisect(G_MIN, 1, fG, 40) : G_MIN
      }
    }
  }
  const eOf = (x) => eAt(x, gam, eMid)
  // 甲板半宽：艏部按外飘角自水线半宽外扩（到艏柱顶收成一点），中体 = 半宽，艉部方艉收到 0.9 半宽 / 圆艉收成半圆
  // （艏部 = 艉部 / 中体的值 + 艏段水线收窄 + 外飘，肩部与水线同一个磨圆；外飘起步也磨圆，免得水线先收、外飘后起，
  //  甲板边线在肩部先凹进去几厘米再弹回型宽）
  const flare = Math.tan(p.flareDeg * D2R), pD = Math.max(2.5, 1.6 * q)
  const Lfl = 0.35 * (L / 2 - xPMf), hFl = Math.min(hF / Lfl, 0.2)
  const flareOn = (x) => { const u = (x - xPMf) / Lfl; return u >= 4 * hFl ? smooth01(u) : 3 * roundPow(u, 2, hFl) - 2 * roundPow(u, 3, hFl) }
  const yDof = (x, aW) => {
    let y
    if (x >= xPMa) y = hb
    else if (!cruiser) y = hb - (hb - yDTr) * ((xPMa - x) / (xPMa - xT)) ** pD
    else if (x >= xK) y = hb - (hb - yK) * ((xPMa - x) / (xPMa - xK)) ** pD
    else { const u = (xK - x) / Rk; y = yK * Math.sqrt(Math.max(0, 1 - u * u)) }
    y += Math.max(0, hb - hb * phiF(x, q)) - hb + (zWof(x) - zDeckOf(g, x)) * flare * flareOn(x)
    return clampN(Math.max(y, aW), 0, hb)
  }
  // 平行中体真正平直的一段 [xM0, xM1]（两端磨圆区之外；重叠时收成船中一点）
  const xMid = (xPMa + xPMf) / 2, xM0 = Math.min(xPMa + Math.max(hA, hC), xMid), xM1 = Math.max(xPMf - hF, xMid)
  return { g, cruiser, pm, xPMf, xPMa, xM0, xM1, eM: eMid, q, gam, Dp, Rp, zSh, xWLa, xK, xP, xB, xB0, xCut, xFF, dTr, zBoss, zCtr, Vt, zWof, dOf, aWof, eOf, yDof }
}

/** 船体派生量（模板 / 单测对拍用；与 build 同一套式子）。 */
export function hullShapeInfo(p) {
  const s = hullShape(p), g = s.g
  return {
    T: g.T, fb: g.fb, fcH: g.fcH, xStemWL: g.xStemWL, xFc0: g.xFc0, xFc1: g.xFc1, pm: s.pm, eMid: s.eM, fullness: s.q, sectionRate: s.gam, Dp: s.Dp, xProp: s.xP, zShaft: s.zSh, targetVolM3: s.Vt,
    // 主甲板半宽（与 build 的甲板边线同式）：模板按它排集装箱列数，箱块不出舷
    deckHalfWidth: (x) => s.yDof(x, s.aWof(x, s.q))
  }
}

/**
 * 船体站位：特征站（断面 / 台阶 / 平行中体两端 / 艏柱）+ 填充站；艉柱断面与艏楼台阶之间不留站（硬边）。
 * 平直段 [xM0, xM1] 截面处处相同，填充站全部按长度分给去流段 [xT, xM0] 与进流段 [xM1, L/2]（含肩部磨圆区），段内两端加密（肩部与艏艉曲率大）。
 * build 与 hullFaces 共用（贴面按站间折线的甲板边线定宽，与网格逐位一致）。
 */
function hullStations(p, s) {
  const g = s.g, L = g.L, xT = g.xT, N = p.stations
  const special = [xT, s.xWLa, s.xB0, s.xB, s.xCut, s.xM0, s.xPMa, s.xPMf, s.xM1, s.xFF, g.xStemWL, L / 2]
  if (s.cruiser) special.push(s.xK)
  if (g.fcH > 0) special.push(g.xFc0, g.xFc1)
  const sp = [...new Set(special)].sort((a, b) => a - b).filter((x, i, a) => i === 0 || x - a[i - 1] > 1e-9 * L)
  const aftLen = s.xM0 - xT, fwdLen = L / 2 - s.xM1, nA = Math.max(2, Math.round((N * aftLen) / (aftLen + fwdLen))), nF = Math.max(2, N - nA)
  const gap = (0.15 * (aftLen + fwdLen)) / N, xs = sp.slice()
  for (const [a, b, n] of [[xT, s.xM0, nA], [s.xM1, L / 2, nF]]) {
    for (let k = 1; k < n; k++) {
      const u = k / n, x = a + (b - a) * (0.5 * u + 0.25 * (1 - Math.cos(Math.PI * u)))
      if (x > s.xB0 && x < s.xB) continue
      if (g.fcH > 0 && x > g.xFc0 && x < g.xFc1) continue
      if (sp.some((y) => Math.abs(y - x) < gap)) continue
      xs.push(x)
    }
  }
  return xs.sort((a, b) => a - b)
}

/**
 * 甲板可贴面：主甲板与艏楼甲板的边线向艏艉收窄（艏部到 0.3–0.4 型宽），一块矩形盖不住又不出舷，所以按「宽度不掉太多」分块：
 *   'deck'      主甲板中段，原点在船中（uv[0] = 船中起的 x，模板按它摆驾驶楼 / 烟囱 / 箱块），前后对称伸到甲板半宽 ≥ 0.9 × 船中半宽为止；
 *   'deckFwd1…' 其前方逐块（每块宽度不低于块首的 75%）铺到艏楼坡起点前、'deckAft1…' 其后方铺到艉端；
 *   'bowdeck' / 'bowdeck2' 艏楼甲板（坡顶起向艏）。
 * 甲板边线取网格上的站间折线（与 build 同一组站位、同一个 yDof），块半宽 = 块内折线最小半宽 − 边距（max(0.3 m, 1 % 型宽)），
 * 块内任一点都在甲板网格上、不进艏楼、不出舷。
 */
function hullFaces(p) {
  const s = hullShape(p), g = s.g, L = g.L, m = Math.max(0.3, 0.01 * g.B), step = 0.0025 * L
  const xs = hullStations(p, s), ys = xs.map((x) => s.yDof(x, s.aWof(x, s.q)))
  const w = (x) => {
    let i = 1
    while (i < xs.length - 1 && xs[i] < x) i++
    const a = xs[i - 1], b = xs[i]
    return b > a ? ys[i - 1] + ((ys[i] - ys[i - 1]) * clampN((x - a) / (b - a), 0, 1)) : ys[i]
  }
  const minW = (a, b) => { let v = Math.min(w(a), w(b)); for (let i = 0; i < xs.length; i++) if (xs[i] > a && xs[i] < b) v = Math.min(v, ys[i]); return v }
  // 某方向从 x0 铺到 xEnd 的若干块（dir = ±1）：块尾取「宽度 ≥ 块首 75%」的最远点
  const tiles = (x0, xEnd, dir, idp, z, max) => {
    const out = []
    let a = x0
    while (out.length < max && dir * (xEnd - a) > 0.01 * L) {
      const w0 = w(a)
      let b = a
      while (dir * (xEnd - (b + dir * step)) >= 0 && w(b + dir * step) >= 0.75 * w0) b += dir * step
      if (out.length === max - 1 || dir * (xEnd - b) < 0.01 * L) b = xEnd
      if (dir * (b - a) < 2 * step) b = a + dir * Math.min(2 * step, dir * (xEnd - a))
      const hv = minW(Math.min(a, b), Math.max(a, b)) - m
      if (!(hv > 0.5)) break
      out.push(planeFace('top', [(a + b) / 2, 0, z], Math.abs(b - a) / 2, hv, `${idp}${out.length + 1}`))
      a = b
    }
    return out
  }
  const xA = g.xT + m, xF = g.fcH > 0 ? g.xFc0 - m : g.L / 2 - m
  let X = step
  while (X + step <= Math.min(-xA, xF) && minW(-(X + step), X + step) >= 0.9 * w(0)) X += step
  const out = [planeFace('top', [0, 0, -g.fb], X, Math.max(0.1, minW(-X, X) - m), 'deck')]
  out.push(...tiles(X, xF, 1, 'deckFwd', -g.fb, 3), ...tiles(-X, xA, -1, 'deckAft', -g.fb, 2))
  if (g.fcH > 0) {
    const bow = tiles(g.xFc1 + m, L / 2 - m, 1, 'bowdeck', -g.fb - g.fcH, 2)
    if (bow.length) bow[0].id = 'bowdeck'
    out.push(...bow)
  }
  return out
}

/** 五叶螺旋桨（局部系原点 = 桨毂中心、轴 +X；侧斜 + 纵倾 + 按几何螺距扭转的 NACA 截面放样）。 */
function propellerMesh(Dp, nBlades = 5) {
  const mb = new MB(), R = Dp / 2, rH = 0.1 * Dp, pitch = 0.95 * Dp, cm = 0.34 * Dp, nS = 8
  lathe(mb, [[0.15 * Dp, 0], [0.14 * Dp, 0.75 * rH], [0.11 * Dp, rH], [-0.1 * Dp, 0.95 * rH], [-0.17 * Dp, 0.62 * rH], [-0.23 * Dp, 0]], 24, [0, 0, 0], [1, 0, 0])
  for (let k = 0; k < nBlades; k++) {
    const ph0 = (2 * Math.PI * k) / nBlades, secs = []
    for (let i = 0; i <= nS; i++) {
      const u = i / nS, r = 0.9 * rH + (R - 0.9 * rH) * u
      const c = i === nS ? 0 : cm * (0.62 + 0.9 * u - 0.95 * u * u) * Math.sqrt(Math.max(0, 1 - u ** 2.5))
      const ph = ph0 + 0.45 * u * u                              // 侧斜（约 26° 到叶梢）
      const qr = [0, Math.sin(ph), -Math.cos(ph)], tg = [0, Math.cos(ph), Math.sin(ph)]   // 径向 / 周向（x × 径向）
      const beta = Math.atan2(pitch, 2 * Math.PI * r)
      const ch = add(scl(tg, Math.cos(beta)), [-Math.sin(beta), 0, 0])                     // 弦向（沿螺旋线）
      const nn = [ch[1] * qr[2] - ch[2] * qr[1], ch[2] * qr[0] - ch[0] * qr[2], ch[0] * qr[1] - ch[1] * qr[0]]
      const base = add(scl(qr, r), [-0.08 * (r - rH), 0, 0])                                 // 纵倾（向后）
      const tc = 0.2 * (1 - u) + 0.04
      secs.push({ pts: airfoilRing(7, tc).map(([xc, zc]) => add(add(base, scl(ch, (xc - 0.45) * c)), scl(nn, zc * c))) })
    }
    loft(mb, secs, { capStart: true })
  }
  return mb
}

const hull = {
  type: 'sea.hull', domain: ['ship'], title: 'Hull', titleZh: '船体', role: 'bus', massSink: 'hull',
  params: {
    loaM: num(300, 'm', '总长', { gt: 5, max: 500 }),
    beamM: num(48, 'm', '型宽', { gt: 1, max: 80 }),
    depthM: num(25, 'm', '型深', { gt: 0.5, max: 60, title: '基线到主甲板' }),
    draftM: num(null, 'm', '吃水', { nullable: true, gt: 0, title: '留空 = 0.5 × 型深' }),
    cb: num(0.65, '', '方形系数', { min: 0.35, max: 0.9, title: '水线下排水体积 / (0.97 × 总长 × 型宽 × 吃水)' }),
    bow: enm('bulb', ['bulb', 'plain'], '艏型', { title: 'bulb = 球鼻艏；plain = 普通前倾艏' }),
    bulbLenFrac: num(0.025, '', '球鼻长', { min: 0, max: 0.06, title: '球鼻伸出艏柱水线点的长度 / 总长；球鼻尖不超出总长' }),
    stern: enm('transom', ['transom', 'cruiser'], '艉型', { title: 'transom = 方艉；cruiser = 巡洋舰艉（圆艉）' }),
    forecastleHM: num(null, 'm', '艏楼高', { nullable: true, min: 0, title: '主甲板到艏楼甲板；留空 = 0.1 × 型深' }),
    bilgeRM: num(null, 'm', '舭部半径', { nullable: true, min: 0, title: '中剖面平底与直舷之间的圆角；留空 = 0.045 × 型宽' }),
    flareDeg: num(12, '°', '艏部外飘', { min: 0, max: 40, title: '艏部舷侧自水线到甲板的平均外倾角' }),
    bootTop: bool(true, '水线带', { title: '水线以上 0.4 m 的防污漆色带' }),
    rudder: bool(true, '舵'),
    propeller: bool(true, '螺旋桨'),
    propDM: num(null, 'm', '桨径', { nullable: true, gt: 0, title: '留空 = 0.65 × 吃水' }),
    stations: int(48, '纵向站数', { min: 16, max: 160 }),
    ringPts: int(24, '半截面点数', { min: 8, max: 64 }),
    massKg: num(null, 'kg', '船体质量', { nullable: true, gt: 0, title: '留空 = 0.25 × 1025 kg/m³ × 方形系数 × 0.97 × 总长 × 型宽 × 吃水（空船占满载的示意比例）；装配件给目标质量时由它吃余量' })
  },
  validate: (p) => {
    const e = [], T = auto(p.draftM, 0.5 * p.depthM)
    if (!(T < p.depthM)) e.push('吃水不小于型深')
    if (p.loaM < 1.5 * p.beamM) e.push('总长与型宽之比过小')
    if (p.propeller && auto(p.propDM, 0.65 * T) > 0.9 * T) e.push('桨径过大')
    return e
  },
  sockets: (p) => {
    const g = hullDims(p)
    return [
      sock('root', [0, 0, g.T], [0, 0, 1], [1, 0, 0], g.B, 90),
      sock('deck', [0, 0, -g.fb], [0, 0, -1], [1, 0, 0], 0.5 * g.B, 15),
      sock('bow', [g.xFcC, 0, -g.fb - g.fcH], [0, 0, -1], [1, 0, 0], 0.3 * g.B, 15),
      sock('stern', [-0.44 * g.L, 0, -g.fb], [0, 0, -1], [1, 0, 0], 0.4 * g.B, 15)
    ]
  },
  faces: (p) => hullFaces(p),
  // 右旋螺旋桨有手性：带桨时几何不关于中线面对称
  symmetricPlanes: (p) => (p.propeller ? [] : ['xz']),
  build(p, kit) {
    const ctx = kit.createCtx(), s = hullShape(p), g = s.g, { L, B, T, fb, xT, xStemWL } = g
    const hullPart = { id: 'hull', name: '船体', role: 'bus' }
    const xs = hullStations(p, s)
    // —— 截面
    const nU = Math.max(3, Math.round(0.62 * p.ringPts)), nT = Math.max(2, p.ringPts - nU)
    const secAt = (x) => {
      const zW = s.zWof(x), zD = zDeckOf(g, x), aW = s.aWof(x, s.q), d = Math.max(s.dOf(x), zW), e = s.eOf(x), yD = s.yDof(x, aW)
      const under = [[aW, zW]]
      for (let j = 1; j < nU; j++) { const th = (Math.PI / 2) * (j / nU); under.push([aW * Math.cos(th) ** (2 / e), zW + (d - zW) * Math.sin(th) ** (2 / e)]) }
      under.push([0, d])
      const top = []
      for (let j = 0; j <= nT; j++) { const tau = 1 - j / nT; top.push([aW + (yD - aW) * tau ** 1.4, zW + (zD - zW) * tau]) }
      return { x, zW, zD, aW, yD, d, under, top }
    }
    const S = xs.map(secAt)
    const iB0 = xs.indexOf(s.xB0), iB = xs.indexOf(s.xB)
    // —— 水下：左舷水线 → 龙骨 → 右舷水线（左右逐位取反）；艉柱断面单独一段（朝艉的硬边断面）
    const uRow = (c) => {
      const r = []
      for (let j = 0; j < c.under.length; j++) { const [y, z] = c.under[j]; r.push([c.x, y ? -y : 0, z]) }
      for (let j = c.under.length - 2; j >= 0; j--) { const [y, z] = c.under[j]; r.push([c.x, y, z]) }
      return r
    }
    const bottom = new MB(), tops = new MB(), deck = new MB()
    for (const [a, b] of splitRanges(xs.length, [iB0, iB])) {
      const wall = a === iB0 && b === iB
      grid(bottom, S.slice(a, b + 1).map(uRow), { out: wall ? [-1, 0, 0] : (c) => [0, c[1], c[2] + fb] })
    }
    // —— 干舷：右舷甲板边 → 水线，整体镜像出左舷
    { const v0 = tops.vcount, t0 = tops.tcount; grid(tops, S.map((c) => c.top.map(([y, z]) => [c.x, y, z])), { out: [0, 1, 0] }); mirrorCopyY(tops, v0, t0) }
    // —— 甲板（艏楼台阶的坡面归干舷色）
    const dRow = (c) => [[c.x, c.yD ? -c.yD : 0, c.zD], [c.x, c.yD, c.zD]]
    const iF0 = xs.indexOf(g.xFc0), iF1 = xs.indexOf(g.xFc1)
    for (const [a, b] of g.fcH > 0 ? splitRanges(xs.length, [iF0, iF1]) : [[0, xs.length - 1]]) {
      const ramp = g.fcH > 0 && a === iF0 && b === iF1
      grid(ramp ? tops : deck, S.slice(a, b + 1).map(dRow), { out: ramp ? [-1, 0, -1] : [0, 0, -1] })
    }
    // —— 艉封板（方艉：水上 / 水下各一块平面封口，共用水线弦）
    if (!s.cruiser) {
      const c0 = S[0]
      if (c0.d - c0.zW > 1e-9) cap(bottom, uRow(c0), [-1, 0, 0])
      cap(tops, [...c0.top.map(([y, z]) => [xT, y ? -y : 0, z]), ...c0.top.slice().reverse().map(([y, z]) => [xT, y, z])], [-1, 0, 0])
    }
    // —— 球鼻：独立放样（椭圆截面、半椭球鼻端），后端藏进船体
    if (p.bow === 'bulb') {
      const hB = 0.55 * T, wB = 0.12 * B, zB = 0.55 * T
      const yHull = (x, z) => {
        const d = s.dOf(x), aW = s.aWof(x, s.q), e = s.eOf(x)
        return aW > 0 && z >= 0 && z < d ? aW * Math.max(0, 1 - (z / d) ** e) ** (1 / e) : 0
      }
      let xBack = xStemWL
      for (let k = 1; k <= 60; k++) { xBack = xStemWL - k * 0.004 * L; if ([-0.4, 0, 0.4].every((f) => yHull(xBack, zB + f * hB) >= 0.55 * wB)) break }
      const xTip = Math.min(xStemWL + p.bulbLenFrac * L, L / 2 - 0.004 * L), xMax = xTip - 0.45 * (xTip - xBack)
      // 顶线在艏柱附近抬到水线下 0.12 T（与艏柱顺接，不像贴上去的鱼雷），向前随鼻端落回
      const rise = Math.max(0, zB - 0.95 * hB / 2 - 0.12 * T)
      const riseAt = (x) => (x <= xStemWL ? smooth01((x - xBack) / (xStemWL - xBack)) : 1 - smooth01((x - xStemWL) / (0.8 * (xTip - xStemWL) + 1e-9 * L)))
      const secs = [], nB = 16
      for (let i = 0; i < nB; i++) {
        const t = i / (nB - 1), x = xBack + (xTip - xBack) * (1 - (1 - t) ** 1.4)
        const k = i === nB - 1 ? 0 : x <= xMax ? 1 : Math.sqrt(Math.max(0, 1 - ((x - xMax) / (xTip - xMax)) ** 2.2))
        secs.push({ c: [x, 0, zB], ring: superRing(20, k * wB / 2, k * (0.95 * hB / 2 + rise * riseAt(x)), k * 1.05 * hB / 2, 2.4) })
      }
      loft(bottom, secs, { capStart: true })
    }
    const bIt = put(ctx, 'bottom', 'bus', hullPart, MAT.bottom, bottom)
    const tIt = put(ctx, 'topsides', 'bus', hullPart, MAT.topside, tops)
    const dIt = put(ctx, 'deck', 'bus', hullPart, MAT.deck, deck)
    solidCompItems(ctx, 'hull', [bIt, tIt, dIt].filter(Boolean), 1, auto(p.massKg, 0.25 * 1025 * p.cb * 0.97 * L * B * T))
    // —— 水线带：水线上 bt、下 bb 贴船壳浮起（右舷造好后镜像）
    if (p.bootTop) {
      const bt = Math.min(0.4, 0.25 * fb), bb = Math.min(0.1, 0.2 * T), lift = Math.max(0.02, 4e-4 * B), zs = [-bt, 0, bb]
      const band = new MB()
      let run = []
      const flush = () => { if (run.length >= 2) { const v0 = band.vcount, t0 = band.tcount; grid(band, run, { out: [0, 1, 0] }); mirrorCopyY(band, v0, t0) } run = [] }
      for (const c of S) {
        if (c.x > xStemWL - 1e-9 || c.zW !== 0 || !(c.d > 1.2 * bb) || !(c.aW > 0)) { flush(); continue }
        const poly = [...c.top, ...c.under.slice(1)]
        run.push(zs.map((z) => [c.x, yAtZ(poly, z) + lift, z]))
      }
      flush()
      put(ctx, 'boottop', 'bus', hullPart, MAT.bottom, band)
    }
    // —— 艏楼防浪墙（V 形，尖端朝艏）
    if (g.fcH > 0) {
      const bw = new MB(), xbw = g.xFc1 + 0.12 * g.fcLen, zb = zDeckOf(g, xbw)
      const ybw = 0.82 * s.yDof(xbw, s.aWof(xbw, s.q)), hw = clampN(0.5 * g.fcH + 1, 0.4, 6), tw = clampN(0.01 * B, 0.08, 0.5)
      const ax = Math.min(xbw + 0.4 * ybw, L / 2 - 0.03 * L)
      if (ybw > 2 * tw && ax > xbw) {
        for (const sg of [1, -1]) {
          const P0 = [xbw, sg * ybw], P1 = [ax, 0], dx = P1[0] - P0[0], dy = P1[1] - P0[1], l = Math.hypot(dx, dy)
          const nx = (-dy / l) * tw / 2, ny = (dx / l) * tw / 2
          const b4 = [[P0[0] - nx, P0[1] - ny, zb], [P1[0] - nx, P1[1] - ny, zb], [P1[0] + nx, P1[1] + ny, zb], [P0[0] + nx, P0[1] + ny, zb]]
          prism(bw, b4, b4.map(([x, y]) => [x, y, zb - hw]))
        }
        put(ctx, 'breakwater', 'other', hullPart, 'white_paint', bw)
      }
    }
    // —— 舵（NACA 0018 截面，顶端插进艉悬；节点原点 = 舵杆，关节 rudder）
    const propPart = { id: 'propulsion', name: '推进器', role: 'thruster' }
    if (p.rudder && s.Dp > 0) {
      const cR = 0.8 * s.Dp, xLE = s.xP - 0.35 * s.Dp, xStock = xLE - 0.25 * cR
      const zBot = Math.min(s.zSh + 0.95 * s.Rp, 0.98 * T)
      let dMin = Infinity
      for (let k = 0; k <= 8; k++) dMin = Math.min(dMin, s.dOf(xLE - (cR * k) / 8))
      const zTop = dMin - Math.max(0.05 * T, 0.02)
      if (zBot - zTop > 0.05 * s.Dp) {
        const rm = new MB(), secs = []
        for (const [z, k] of [[zTop, 1], [(zTop + zBot) / 2, 0.95], [zBot, 0.85]]) {
          const c = cR * k, le = 0.25 * c
          secs.push({ pts: airfoilRing(10, 0.18).map(([xc, zc]) => [le - xc * c, zc * c, z]) })
        }
        loft(rm, secs, { capStart: true, capEnd: true })
        if (put(ctx, 'rudder', 'other', { id: 'rudder', name: '舵', role: 'other' }, MAT.bottom, rm, IDR, [xStock, 0, 0])) {
          ctx.arts.push({ name: 'rudder', nodes: ['rudder'], stages: [stage('rudder', 'zRotate', -35, 35, 0)] })
        }
      }
    }
    // —— 螺旋桨（节点原点 = 桨毂中心，关节 spin）+ 艉轴毂（桨毂前端 → 艉鳍）
    if (p.propeller && s.Dp > 0) {
      put(ctx, 'propeller', 'thruster', propPart, 'titanium', propellerMesh(s.Dp), IDR, [s.xP, 0, s.zSh])
      ctx.arts.push({ name: 'propeller', nodes: ['propeller'], stages: [stage('spin', 'xRotate', -180, 180, 0)] })
      const bm = new MB(), rH = 0.1 * s.Dp
      frustum(bm, [s.xP + 0.14 * s.Dp, 0, s.zSh], 0.8 * rH, [s.xB + 0.25 * s.Dp, 0, s.zSh], 0.95 * rH, 24, false, true)
      put(ctx, 'boss', 'other', propPart, MAT.bottom, bm)
    }
    datumAp(ctx)
    return ctx
  }
}

// ───────────────────────────── 上层建筑 ─────────────────────────────

function ssGeom(p) {
  const hy = p.widthM / 2, N = p.tiers, h = p.tierHM, H = N * h, Ls = p.lengthM
  const hxOf = (k) => Math.max(0.3 * Ls / 2, Ls / 2 - k * p.setbackM)
  const hxTop = hxOf(N - 1), span = Math.max(p.widthM, auto(p.wingSpanM, p.widthM))
  const wings = p.bridgeWings && span > p.widthM + 0.4
  const cabL = Math.min(3.2, 1.2 * hxTop), cabW = wings ? Math.min(3, 0.6 * (span / 2 - hy)) : 0
  return { hy, N, h, H, Ls, hxOf, hxTop, span, wings, cabL, cabW, zF: -(N - 1) * h, wl: clampN(hxTop, 2.5, 2 * hxTop) }
}
/**
 * 上层建筑顶面 / 翼桥插座推荐的件：只列「立在水平顶面上、滚转 0° 与父件同向」的立件。反射面（es.refl.*，mount 贴座架的
 * 俯仰轴插座）、副面 / 馈源（贴焦点插座）直接装到顶面上会被转成视轴朝天、方位关节轴水平，所以不列——要先放座架 / 立柱。
 */
const SS_ACCEPTS = Object.freeze(['sea.mast', 'sea.vsat', 'veh.cotm', 'es.pedestal.', 'es.mast', 'es.vsat.mount', 'es.radome', 'es.shelter', 'es.tower', 'prim.'])

const superstructure = {
  type: 'sea.superstructure', domain: ['ship'], title: 'Superstructure', titleZh: '上层建筑', role: 'other',
  params: {
    lengthM: num(16, 'm', '长', { gt: 1, max: 80, title: '底层前后长' }),
    widthM: num(30, 'm', '宽', { gt: 1, max: 80 }),
    tiers: int(8, '层数', { min: 1, max: 20 }),
    tierHM: num(2.8, 'm', '层高', { gt: 1.8, max: 5 }),
    setbackM: num(0, 'm', '逐层内收', { min: 0, max: 5, title: '每升一层前后各内收' }),
    bridgeWings: bool(true, '翼桥'),
    wingSpanM: num(null, 'm', '翼桥总宽', { nullable: true, gt: 0, max: 80, title: '两翼端外缘间距；留空 = 上层建筑宽' }),
    windows: bool(true, '窗'),
    lifeboat: bool(true, '救生艇', { title: '艉墙自由降落式救生艇（层数 ≥ 3 时）' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空 = 250 kg/m² × 占地 × 层数' })
  },
  sockets: (p) => {
    const g = ssGeom(p)
    const wingPos = (sg) => (g.wings ? [g.hxTop - g.cabL / 2, sg * (g.span / 2 - g.cabW / 2), Math.min(g.zF + 0.3, 0) - 0.92 * g.h - 0.3] : [0.6 * g.hxTop, sg * 0.7 * g.hy, -g.H])
    return [
      standSocket(Math.min(p.lengthM, p.widthM), 15),
      sock('top', [0, 0, -g.H], [0, 0, -1], [1, 0, 0], 0.5 * Math.min(2 * g.hxTop, p.widthM), 15, SS_ACCEPTS),
      sock('wingP', wingPos(-1), [0, 0, -1], [1, 0, 0], Math.max(0.5, g.cabW), 15, SS_ACCEPTS),
      sock('wingS', wingPos(1), [0, 0, -1], [1, 0, 0], Math.max(0.5, g.cabW), 15, SS_ACCEPTS)
    ]
  },
  faces: (p) => { const g = ssGeom(p); return [planeFace('top', [0, 0, -g.H], Math.max(0.1, g.hxTop - 0.3), Math.max(0.1, g.hy - 0.3), 'top')] },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = ssGeom(p), part = { id: 'superstructure', name: '上层建筑', role: 'other' }
    const house = new MB(), ledges = new MB(), win = new MB(), wingM = new MB(), misc = new MB()
    const lt = Math.min(0.22, 0.1 * g.h), wh = Math.min(0.45, 0.17 * g.h)
    const bandH = Math.min(0.75, 0.3 * g.h), zBand = g.zF - 0.6 * g.h
    for (let k = 0; k < g.N; k++) {
      const hx = g.hxOf(k), rk = Math.min(0.8, 0.25 * Math.min(hx, g.hy)), za = -k * g.h, zb = -(k + 1) * g.h
      extrude(house, roundRect(hx, g.hy, rk, 4), za, zb)
      // 甲板檐：前后挑出 0.3 m；两侧只浮出 2 cm（满宽上层建筑也不超型宽）
      extrude(ledges, roundRect(hx + 0.3, g.hy + 0.02, rk, 4), zb + lt, zb)
      if (!p.windows) continue
      if (k < g.N - 1) {
        const zc = za - 0.55 * g.h, ny = Math.floor((2 * (g.hy - rk) - 0.6) / 2.2), nx = Math.floor((2 * (hx - rk) - 0.6) / 2.6)
        for (let i = 0; i < ny; i++) {
          const y = (i - (ny - 1) / 2) * 2.2
          decal(win, [hx, y, zc], [1, 0, 0], [0, 1, 0], 0.55, wh, 0.01); decal(win, [-hx, y, zc], [-1, 0, 0], [0, 1, 0], 0.55, wh, 0.01)
        }
        for (let i = 0; i < nx; i++) { const x = (i - (nx - 1) / 2) * 2.6; for (const sg of [1, -1]) decal(win, [x, sg * g.hy, zc], [0, sg, 0], [1, 0, 0], 0.5, wh, 0.01) }
      } else {
        // 驾驶室连续窗带（前 / 两侧 / 后）
        if (g.hy - rk - 0.2 > 0.05) decal(win, [hx, 0, zBand], [1, 0, 0], [0, 1, 0], g.hy - rk - 0.2, bandH, 0.01)
        if (hx - rk - 0.2 > 0.05) for (const sg of [1, -1]) decal(win, [0, sg * g.hy, zBand], [0, sg, 0], [1, 0, 0], hx - rk - 0.2, bandH, 0.01)
        if (g.hy - rk > 0.1) decal(win, [-hx, 0, zBand], [-1, 0, 0], [0, 1, 0], 0.6 * (g.hy - rk), bandH, 0.01)
      }
    }
    // 翼桥：平台（舷墙高）+ 翼端驾驶台 + 两根斜撑
    if (g.wings) {
      const x1 = g.hxTop, x0 = x1 - g.wl, yE = g.span / 2, yC = yE - g.cabW
      const zLow = Math.min(g.zF + 0.3, 0), zCab = zLow - 0.92 * g.h - 0.3
      for (const sg of [1, -1]) {
        box(wingM, [(x0 + x1) / 2, sg * (g.hy - 0.05 + yC) / 2, (zLow + zLow - 1.4) / 2], [(x1 - x0) / 2, (yC - g.hy + 0.05) / 2, 0.7])
        box(wingM, [x1 - g.cabL / 2, sg * (yC + yE) / 2, (zLow + zCab) / 2], [g.cabL / 2, g.cabW / 2, (zLow - zCab) / 2])
        const zs = Math.min(g.zF + 1.6 * g.h, -0.05)
        for (const xs of [x1 - 0.25 * g.cabL, x1 - 0.75 * g.cabL]) tubeAlong(wingM, [xs, sg * g.hy, zs], [xs, sg * (yE - 0.3), zLow], 0.16, 10)
        if (p.windows) {
          const zc = (zLow + zCab) / 2 - 0.1 * g.h
          if (g.cabW / 2 - 0.15 > 0.05) decal(win, [x1, sg * (yC + yE) / 2, zc], [1, 0, 0], [0, 1, 0], g.cabW / 2 - 0.15, bandH, 0.01)
          if (g.cabL / 2 - 0.15 > 0.05) decal(win, [x1 - g.cabL / 2, sg * yE, zc], [0, sg, 0], [1, 0, 0], g.cabL / 2 - 0.15, bandH, 0.01)
        }
      }
    }
    // 顶面空调箱（两台，靠后）
    for (const sg of [1, -1]) box(misc, [-0.45 * g.hxTop, sg * 0.45 * g.hy, -g.H - 0.35], [Math.min(0.9, 0.3 * g.hxTop), Math.min(0.7, 0.2 * g.hy), 0.35])
    // 自由降落救生艇：艉墙滑道，艇首朝艉下方 35°
    const boat = new MB(), rails = new MB()
    if (p.lifeboat && g.N >= 3) {
      const bl = clampN(0.3 * p.widthM, 4.5, 9), bw = 0.36 * bl, bh = 0.4 * bl, k = g.N - 3, hxk = g.hxOf(k), ang = 35 * D2R
      const a = [-Math.cos(ang), 0, Math.sin(ang)], up = [-Math.sin(ang), 0, -Math.cos(ang)], dn = scl(up, -1)
      const P0 = [-hxk - 0.3, 0, -k * g.h - 0.3], cen = add(add(P0, scl(a, 0.5 * bl + 0.4)), scl(up, 0.4 * bh))
      if (cen[2] + 0.5 * bl * Math.sin(ang) + 0.45 * bh < -0.2) {
        const secs = []
        for (let i = 0; i <= 12; i++) {
          const sn = -1 + (2 * i) / 12, sl = sn * bl / 2
          const wf = i === 0 || i === 12 ? 0 : sn >= 0 ? Math.sqrt(Math.max(0, 1 - sn ** 2.4)) : Math.sqrt(Math.max(0, 1 - (-sn) ** 8))
          const o = add(cen, scl(a, sl))
          secs.push({ pts: superRing(16, wf * bw / 2, wf * 0.62 * bh, wf * 0.38 * bh, 2.6).map(([ry, rz]) => add(add(o, [0, ry, 0]), scl(dn, rz))) })
        }
        loft(boat, secs)
        // 滑道：两根箱形梁沿艇底伸出艉墙，上端登乘平台，下端各一根水平撑杆回到艉墙
        const keel = (sl, y) => add(add(add(cen, scl(a, sl)), scl(dn, 0.38 * bh + 0.1)), [0, y, 0])
        const bw2 = 0.12, bh2 = 0.32
        for (const sg of [1, -1]) {
          const y = sg * 0.3 * bw, p0 = keel(-0.62 * bl, y), p1 = keel(0.45 * bl, y)
          const sec = (q) => [add(q, [0, -bw2, 0]), add(q, [0, bw2, 0]), add(add(q, [0, bw2, 0]), scl(dn, bh2)), add(add(q, [0, -bw2, 0]), scl(dn, bh2))]
          prism(rails, sec(p0), sec(p1))
          const e = add(p1, scl(dn, 0.5 * bh2)), kz = clampN(Math.floor(-e[2] / g.h), 0, g.N - 1)
          tubeAlong(rails, e, [-g.hxOf(kz) + 0.05, y, e[2]], 0.09, 8)
        }
        box(rails, [-hxk - 0.9, 0, P0[2] + 0.1], [0.9, 0.5 * bw + 0.5, 0.1])
      }
    }
    const hIt = put(ctx, 'house', 'other', part, 'white_paint', house)
    put(ctx, 'decks', 'other', part, 'white_paint', ledges)
    put(ctx, 'windows', 'other', part, 'dark_metal', win)
    put(ctx, 'wings', 'other', part, 'white_paint', wingM)
    put(ctx, 'roofunits', 'other', part, 'aluminum', misc)
    put(ctx, 'lifeboat', 'other', { id: 'lifeboat', name: '救生艇', role: 'other' }, MAT.lifeboat, boat)
    put(ctx, 'davit', 'other', { id: 'lifeboat', name: '救生艇', role: 'other' }, 'dark_metal', rails)
    solidCompItems(ctx, 'house', [hIt], 1, auto(p.massKg, 250 * p.lengthM * p.widthM * g.N))
    return ctx
  }
}

// ───────────────────────────── 烟囱 ─────────────────────────────

function funGeom(p) {
  const hx = p.lengthM / 2, hy = p.widthM / 2, H = p.heightM
  return { hx, hy, H, dxT: -H * Math.tan(p.rakeDeg * D2R), k: p.taper, r: 0.45 * Math.min(hx, hy), fb: p.band ? clampN(1.6 / H, 0.06, 0.2) : 0 }
}

const funnel = {
  type: 'sea.funnel', domain: ['ship'], title: 'Funnel', titleZh: '烟囱', role: 'other',
  params: {
    lengthM: num(10, 'm', '长', { gt: 0.3, max: 60 }),
    widthM: num(7, 'm', '宽', { gt: 0.3, max: 60 }),
    heightM: num(12, 'm', '高', { gt: 0.5, max: 60 }),
    rakeDeg: num(8, '°', '后倾角', { min: 0, max: 30 }),
    taper: num(0.85, '', '顶底比', { min: 0.5, max: 1, title: '顶面轮廓 / 底面轮廓' }),
    band: bool(true, '顶部色带'),
    pipes: int(2, '排气管', { min: 0, max: 6, title: '伸出顶面 1.5 m' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空 = 180 kg/m² × 侧面积' })
  },
  // top = 顶面前半中心（排气管都在后半）
  sockets: (p) => {
    const g = funGeom(p), hxT = g.hx * g.k, hyT = g.hy * g.k
    return [standSocket(Math.min(p.lengthM, p.widthM), 15), sock('top', [g.dxT + 0.5 * hxT, 0, -g.H], [0, 0, -1], [1, 0, 0], Math.max(0.2, Math.min(0.9 * hxT, 1.8 * hyT)), 15, Object.freeze(['sea.mast', 'sea.vsat', 'prim.']))]
  },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = funGeom(p), part = { id: 'funnel', name: '烟囱', role: 'other' }
    const O = roundRect(g.hx, g.hy, g.r, 5), body = new MB(), band = new MB()
    if (g.fb > 0) {
      // 两段拉伸：接缝环逐位相同（同一个式子算），合起来闭合
      const f0 = 1 - g.fb, s0 = 1 + (g.k - 1) * f0, d0 = g.dxT * f0, zb = -f0 * g.H
      extrude(body, O, 0, zb, { dx: d0, scale: s0, capTop: false })
      extrude(band, O.map(([x, y]) => [x * s0 + d0, y * s0]), zb, -g.H, { dx: g.dxT - (d0 * g.k) / s0, scale: g.k / s0, capBottom: false })
    } else extrude(body, O, 0, -g.H, { dx: g.dxT, scale: g.k })
    const pm = new MB()
    if (p.pipes > 0) {
      // 排气管全在顶面后半：一排（≤ 3 根）在 x = −0.45 × 顶面半长，两排在 −0.2 / −0.65；前半留给 top 插座（烟囱桅 / 罩），装上不碰管
      const hxT = g.hx * g.k, hyT = g.hy * g.k, n = p.pipes, nr = n > 3 ? 2 : 1, tr = Math.tan(p.rakeDeg * D2R), din = Math.min(0.8, 0.5 * g.H)
      const counts = nr === 2 ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n]
      counts.forEach((cnt, ri) => {
        const xr = g.dxT + (nr === 2 ? (ri ? -0.65 : -0.2) : -0.45) * hxT, rp = clampN(Math.min((nr === 2 ? 0.2 : 0.35) * hxT, (0.75 * hyT) / cnt), 0.04, 0.8)
        const step = Math.min(2.4 * rp, (1.6 * hyT) / cnt)
        for (let i = 0; i < cnt; i++) { const y = (i - (cnt - 1) / 2) * step; tubeAlong(pm, [xr + din * tr, y, -g.H + din], [xr - 1.5 * tr, y, -g.H - 1.5], rp, 16) }
      })
    }
    const bIt = put(ctx, 'casing', 'other', part, 'white_paint', body), tIt = put(ctx, 'band', 'other', part, 'carbon', band)
    put(ctx, 'pipes', 'other', part, 'dark_metal', pm)
    let per = 0
    for (let i = 0; i < O.length; i++) { const a = O[i], b = O[(i + 1) % O.length]; per += Math.hypot(b[0] - a[0], b[1] - a[1]) }
    solidCompItems(ctx, 'funnel', [bIt, tIt].filter(Boolean), 1, auto(p.massKg, 180 * per * g.H * (1 + g.k) / 2))
    return ctx
  }
}

// ───────────────────────────── 雷达桅 ─────────────────────────────

/** 开放阵列雷达（示意）：第 1 部 3.9 m 装前侧 0.5 高，第 2 部 2.4 m 装前侧 0.72 高，第 3 部 2.4 m 装后侧 0.6 高。 */
const RADARS = Object.freeze([Object.freeze({ L: 3.9, f: 0.5, sg: 1 }), Object.freeze({ L: 2.4, f: 0.72, sg: 1 }), Object.freeze({ L: 2.4, f: 0.6, sg: -1 })])
const mastGeom = (p) => ({ H: p.heightM, d: p.dM, tP: p.platform ? Math.min(0.15, 0.05 * p.heightM) : 0, zY: -0.86 * p.heightM })

const mast = {
  type: 'sea.mast', domain: ['ship'], title: 'Mast', titleZh: '桅杆', role: 'boom',
  params: {
    heightM: num(8, 'm', '高', { gt: 0.5, max: 40, title: '安装面到桅顶平台顶面' }),
    dM: num(0.45, 'm', '主杆直径', { gt: 0.05, max: 3, title: '根部直径，向上收到 0.7 倍' }),
    platform: bool(true, '桅顶平台'),
    platformWM: num(2.2, 'm', '平台直径', { gt: 0.3, max: 10 }),
    yard: bool(true, '横桁'),
    yardWM: num(6, 'm', '横桁长', { gt: 0.5, max: 30 }),
    radars: int(2, '雷达', { min: 0, max: 3, title: '开放阵列雷达：第 1 部 3.9 m，第 2、3 部 2.4 m（示意）' }),
    lights: bool(true, '号灯'),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空：钢管按 7850 kg/m³、壁厚 0.06 × 管径，另计平台、横桁与雷达（示意）' })
  },
  // 横桁两端插座只在有横桁时给（已挂上去的子件在关掉横桁后由 validateAssembly 报「父件没有插座」，与 veh.body 的 bed 同口径）
  sockets: (p) => {
    const g = mastGeom(p), acc = Object.freeze(['sea.vsat', 'veh.cotm', 'prim.'])
    const out = [
      standSocket(Math.max(2 * p.dM, 0.4), 15),
      sock('platform', [0, 0, -g.H], [0, 0, -1], [1, 0, 0], p.platform ? 0.8 * p.platformWM : p.dM, 15, Object.freeze(['sea.vsat', 'es.radome', 'veh.cotm', 'prim.']))
    ]
    if (p.yard) {
      const yy = Math.max(0.05, p.yardWM / 2 - 0.4)
      out.push(sock('yardP', [0, -yy, g.zY - 0.09], [0, 0, -1], [1, 0, 0], 0.3, 15, acc), sock('yardS', [0, yy, g.zY - 0.09], [0, 0, -1], [1, 0, 0], 0.3, 15, acc))
    }
    return out
  },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = mastGeom(p), part = { id: 'mast', name: '桅杆', role: 'boom' }, radarPart = { id: 'radar', name: '导航雷达', role: 'sensor' }
    const pole = new MB(), legs = new MB(), plat = new MB(), yard = new MB(), brk = new MB(), lampR = new MB(), lampG = new MB(), lampW = new MB()
    frustum(pole, [0, 0, 0], g.d / 2, [0, 0, -(g.H - g.tP)], 0.35 * g.d, 24, true, true)
    frustum(pole, [0, 0, 0], 0.9 * g.d, [0, 0, -0.08], 0.9 * g.d, 24, true, true)          // 底座法兰
    const sp = clampN(0.18 * g.H, 0.3, 4)
    for (const sg of [1, -1]) tubeAlong(legs, [-sp, sg * 0.75 * sp, 0], [-0.1 * g.d, sg * 0.1 * g.d, -0.6 * g.H], 0.15 * g.d, 12)
    if (p.platform) {
      const R = p.platformWM / 2, z1 = -g.H, rr = Math.min(0.03, 0.02 * R + 0.01), hr = Math.min(1.0, 0.5 * R + 0.3), Rg = Math.max(0.6 * R, R - 0.05)
      frustum(plat, [0, 0, z1 + g.tP], R, [0, 0, z1], R, 32, true, true)
      torus(plat, [0, 0, z1 - hr], [0, 0, 1], Rg, rr, 32, 6)
      for (let k = 0; k < 8; k++) { const a = (2 * Math.PI * k) / 8, c = Math.cos(a) * Rg, s = Math.sin(a) * Rg; tubeAlong(plat, [c, s, z1], [c, s, z1 - hr], rr, 6) }
      for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) tubeAlong(plat, [0.3 * g.d * Math.cos(a), 0.3 * g.d * Math.sin(a), z1 + g.tP + Math.min(0.9, 0.4 * R)], [0.8 * R * Math.cos(a), 0.8 * R * Math.sin(a), z1 + g.tP], Math.max(0.02, 0.06 * g.d), 8)
    } else frustum(pole, [0, 0, -g.H + 0.05], 0.45 * g.d, [0, 0, -g.H], 0.45 * g.d, 16, true, true)
    if (p.yard) {
      box(yard, [0, 0, g.zY], [0.09, p.yardWM / 2, 0.09])
      if (p.lights) {
        box(lampR, [0.12, -(p.yardWM / 2 - 0.15), g.zY - 0.21], [0.1, 0.1, 0.12])
        box(lampG, [0.12, p.yardWM / 2 - 0.15, g.zY - 0.21], [0.1, 0.1, 0.12])
      }
    }
    if (p.lights) box(lampW, [0.35 * g.d + 0.1, 0, -0.93 * g.H], [0.1, 0.1, 0.14])             // 桅灯
    for (let k = 0; k < p.radars; k++) {
      const R = RADARS[k], zb = -R.f * g.H, rx = R.sg * (R.L / 2 + g.d / 2 + 0.35)
      box(brk, [rx / 2, 0, zb + 0.05], [Math.abs(rx) / 2 + 0.4, 0.45, 0.05])                 // 托架平台
      box(brk, [rx, 0, zb - 0.3], [0.35, 0.28, 0.3])                                         // 齿轮箱
      const m = new MB()
      tubeAlong(m, [0, 0, 0], [0, 0, -0.18], 0.08, 12)
      box(m, [0, 0, -0.35], [0.12, R.L / 2, 0.17])
      put(ctx, `radar${k + 1}`, 'sensor', radarPart, 'white_paint', m, IDR, [rx, 0, zb - 0.6])
      ctx.arts.push({ name: `radar${k + 1}`, nodes: [`radar${k + 1}`], stages: [stage('spin', 'zRotate', -180, 180, 0)] })
    }
    const items = [put(ctx, 'pole', 'boom', part, 'white_paint', pole), put(ctx, 'legs', 'boom', part, 'white_paint', legs), put(ctx, 'platform', 'boom', part, 'aluminum', plat)]
    put(ctx, 'yard', 'boom', part, 'white_paint', yard)
    put(ctx, 'brackets', 'boom', part, 'dark_metal', brk)
    put(ctx, 'lightP', 'other', part, MAT.portLight, lampR)
    put(ctx, 'lightS', 'other', part, MAT.stbdLight, lampG)
    put(ctx, 'lightTop', 'other', part, 'white_paint', lampW)
    const m0 = 7850 * Math.PI * g.d * (0.06 * g.d) * g.H + (p.platform ? 60 * p.platformWM ** 2 : 0) + 150 * p.radars + (p.yard ? 25 * p.yardWM : 0)
    solidCompItems(ctx, 'mast', items.filter(Boolean), 1, auto(p.massKg, m0))
    return ctx
  }
}

// ───────────────────────────── 甲板集装箱 ─────────────────────────────

/**
 * 集装箱侧板瓦楞（m，示意：ISO 箱侧板梯形波的常见量级，节距 / 深与 shapeKit.containerMeshes 同值）：
 * 节距 0.278、深 0.036、外平 0.072、内平 0.068（两斜边各 0.069）；两端各留 ≥ 0.15 平段（角柱）。
 * ★ 做成几何（外侧可见的舷侧面换成梯形波纹条带，波谷往里凹、包络仍是 ISO 外形），不贴深色细线：
 *   0.278 m 的节距在整船视角（1 px ≈ 0.5 m）远低于采样率，近黑细线必出摩尔纹。几何瓦楞的明暗来自光照、与箱同色，
 *   顶点法向取相邻两段斜率的平均再 × soft（波峰—斜边—波谷之间明暗平缓过渡、只剩基频），远看是低反差的均匀细纹，
 *   近看斜边迎光 / 背光分得出凹凸，轮廓上也看得到波纹。soft 是远近两头的折中（验证台逐档出图比过）：
 *   0.7 时整船视角（单倍采样 + MSAA）白箱侧面的残余拍纹几乎看不出；≥ 1 白箱侧面出弧形拍纹，≤ 0.5 近景波纹太淡。
 * ★ 同一理由，端面锁杆 / 门缝、舷侧角柱也做成同色凸条 / 凹缝（reliefLine），不贴深色细线；只留稀疏的层缝深线（真缝）。
 */
const CORR = Object.freeze({ pitch: 0.278, depth: 0.036, crest: 0.072, trough: 0.068, post: 0.15, soft: 0.7 })
const RAIL_H = 0.1   // 上 / 下侧梁高（示意）：层缝两侧各一条与箱同色的平带盖住瓦楞，一箱一框

/**
 * 箱长 Lc 的瓦楞截面：列 x（相对箱中心，两端 ±Lc/2）、内凹深 h（≥ 0）、法向的 x 分量 k（顶点法向 = normalize(k·x̂ + sg·ŷ)）。
 * 波纹段从波峰起、到波峰止，关于箱中心对称；两端平段并入角柱。
 */
function corrProfile(Lc) {
  const { pitch: P, depth: d, crest: c, trough: w, post, soft } = CORR, f = (P - c - w) / 2
  const n = Math.max(0, Math.floor((Lc - 2 * post - c) / P)), x0 = -(n * P + c) / 2
  const X = [-Lc / 2], H = [0]
  if (n > 0) {
    X.push(x0); H.push(0)
    for (let k = 0; k < n; k++) { const a = x0 + k * P + c; X.push(a, a + f, a + f + w, x0 + (k + 1) * P); H.push(0, d, d, 0) }
    X.push(x0 + n * P + c); H.push(0)
  }
  X.push(Lc / 2); H.push(0)
  const s = X.slice(1).map((x, i) => (H[i + 1] - H[i]) / (x - X[i]))
  const K = X.map((_, i) => (soft * ((i > 0 ? s[i - 1] : 0) + (i < s.length ? s[i] : 0))) / 2)
  return { X, H, K }
}
/** 舷侧瓦楞条：箱中心 x、侧面 y = yf（朝外 sg = ±1），z ∈ [zt, zb]（zt 在上、数值小），按 corrProfile 的列建四边形条带。 */
function corrStrip(mb, pr, x, yf, sg, zt, zb) {
  const v0 = mb.vcount
  for (let i = 0; i < pr.X.length; i++) {
    const p = [x + pr.X[i], yf - sg * pr.H[i]], n = [pr.K[i], sg, 0], u = pr.X[i] - pr.X[0]
    mb.v([p[0], p[1], zt], n, u, 0)
    mb.v([p[0], p[1], zb], n, u, zb - zt)
  }
  for (let i = 0; i < pr.X.length - 1; i++) {
    const a = v0 + 2 * i, b = a + 1, c = a + 2, d = a + 3
    if (sg > 0) { mb.t(a, b, d); mb.t(a, d, c) } else { mb.t(a, d, b); mb.t(a, c, d) }
  }
}
/**
 * 与箱同色的竖向细起伏（端面锁杆 / 门缝）：一个四边形，中心 c、面外法向 n0、横向 w、横向半宽 hw、竖向（n0 × w）半长 hv、浮起 lift；
 * 两列顶点法向 n0 ∓ k·w（逐像素插值过 n0）：k > 0 是凸条（像圆杆），k < 0 是凹缝。只靠法向出明暗，远看是低反差、不出噪点。
 */
function reliefLine(mb, c, n0, w, hw, hv, k, lift) {
  const v = cross(n0, w), o = madd(c, n0, lift), W = scl(w, hw), V = scl(v, hv), nL = sub(n0, scl(w, k)), nR = add(n0, scl(w, k))
  const a = mb.v(sub(sub(o, W), V), nL, 0, 0), b = mb.v(sub(add(o, W), V), nR, 2 * hw, 0)
  const d = mb.v(add(add(o, W), V), nR, 2 * hw, 2 * hv), e = mb.v(add(sub(o, W), V), nL, 0, 2 * hv)
  mb.t(a, b, d); mb.t(a, d, e)
}

function contGeom(p) {
  const Lc = ISO_BOX[p.size].L, Wc = ISO_BOX['40ft'].W, Hc = p.highCube ? ISO_BOX['40ftHC'].H : ISO_BOX['40ft'].H
  const pitch = Lc + p.bayGapM, Lb = p.bays * Lc + (p.bays - 1) * p.bayGapM
  const rp = Wc + p.rowGapM, Wb = p.rows * Wc + (p.rows - 1) * p.rowGapM
  const tiersAt = (b, r) => {
    const fw = p.stepFwd > 0 && b < p.stepBays ? Math.round(p.stepFwd * (1 - b / p.stepBays)) : 0
    const ob = Math.max(0, p.outboardDrop - Math.min(r, p.rows - 1 - r))
    return Math.max(1, p.tiers - fw - ob)
  }
  return { Lc, Wc, Hc, pitch, Lb, rp, Wb, z0: -p.hatchHM, xOf: (b) => Lb / 2 - Lc / 2 - b * pitch, yOf: (r) => -Wb / 2 + Wc / 2 + r * rp, tiersAt }
}

const containers = {
  type: 'sea.containers', domain: ['ship', 'ground', 'vehicle'], title: 'Container stack', titleZh: '集装箱', role: 'other',
  params: {
    size: enm('40ft', ['40ft', '20ft'], '箱型', { source: ISO668, title: 'ISO 668 系列 1：40 ft 长 12.192 m、20 ft 长 6.058 m；宽 2.438 m' }),
    highCube: bool(true, '高箱', { source: ISO668, title: '高箱 2.896 m；否 = 2.591 m（ISO 668）' }),
    bays: int(4, '贝数', { min: 1, max: 40, title: '沿 +X 排列，第一贝在最前' }),
    rows: int(10, '列数', { min: 1, max: 30 }),
    tiers: int(6, '层数', { min: 1, max: 14 }),
    bayGapM: num(1.2, 'm', '贝间距', { min: 0, max: 5, title: '相邻两贝的净距（绑扎桥所在）' }),
    rowGapM: num(0.08, 'm', '列间隙', { min: 0, max: 0.5 }),
    hatchHM: num(1.8, 'm', '舱口盖高', { min: 0, max: 4, title: '安装面到舱口盖顶（含围板）' }),
    lashing: bool(true, '绑扎桥', { title: '贝间距 ≥ 0.4 m 时画' }),
    stepFwd: int(0, '前端减层', { min: 0, max: 10, title: '最前一贝少放几层，向后按贝线性回到 0' }),
    stepBays: int(3, '减层贝数', { min: 1, max: 10 }),
    outboardDrop: int(0, '舷侧减层', { min: 0, max: 6, title: '最外一列少放几层，向内每列少减一层' }),
    seed: int(1, '配色种子', { min: 0, max: 9999 }),
    palette: enm('mixed', ['mixed', 'mono'], '配色', { title: 'mixed = 多色混装；mono = 单色' }),
    loadKg: num(14000, 'kg', '单箱平均总重', { gt: 0, max: 40000, title: '箱体 + 货物' })
  },
  sockets: (p) => { const g = contGeom(p); return [standSocket(Math.min(g.Lb, g.Wb), 15)] },
  build(p, kit) {
    const ctx = kit.createCtx(), g = contGeom(p), part = { id: 'containers', name: '集装箱', role: 'other' }
    const R = rng(hash32([p.seed, p.bays, p.rows, p.tiers])), nP = BOX_PALETTE.length
    const mono = p.palette === 'mono' ? Math.floor(R() * nP) : -1
    const byMat = new Map(), mbFor = (k) => { let m = byMat.get(k); if (!m) { m = new MB(); byMat.set(k, m) } return m }
    const marks = new MB(), hatch = new MB(), lash = new MB()
    const hL = g.Lc / 2, hW = g.Wc / 2, seam = 0.03, lift = 0.006, railLift = 0.003, prof = corrProfile(g.Lc)
    const zAt = (t) => g.z0 - t * g.Hc
    for (let b = 0; b < p.bays; b++) {
      const x = g.xOf(b)
      let bayMass = 0, maxT = 0
      // 舱口盖：前后各伸出 0.12 m，横向比箱块两侧各窄 0.1 m（箱块外缘就是整件横向外缘：模板按箱块留舷边净距，盖子不会出舷）
      if (p.hatchHM > 0) box(hatch, [x, 0, g.z0 / 2], [hL + 0.12, Math.max(0.1, g.Wb / 2 - 0.1), p.hatchHM / 2])
      for (let r = 0; r < p.rows; r++) {
        const y = g.yOf(r), nT = g.tiersAt(b, r)
        maxT = Math.max(maxT, nT); bayMass += nT * p.loadKg
        // 舷侧露出的层：相邻列（sg 一侧）比本列矮的部分；最外列整堆露出
        const expo = (sg) => { const rn = r + sg; return rn < 0 || rn >= p.rows ? 0 : Math.min(nT, g.tiersAt(b, rn)) }
        // 一堆分 1–4 段、相邻段换色（段内是一个盒，段内箱缝靠端面 / 舷侧贴花）
        const nSeg = mono >= 0 ? 1 : 1 + Math.floor(R() * Math.min(4, nT)), avail = [], cuts = []
        for (let t = 1; t < nT; t++) avail.push(t)
        for (let k = 1; k < nSeg; k++) cuts.push(avail.splice(Math.floor(R() * avail.length), 1)[0])
        cuts.sort((u, v) => u - v)
        const bounds = [0, ...cuts, nT]
        let ci = mono >= 0 ? mono : Math.floor(R() * nP)
        for (let sgm = 0; sgm < bounds.length - 1; sgm++) {
          if (sgm > 0) ci = (ci + 1 + Math.floor(R() * (nP - 1))) % nP
          const t0 = bounds[sgm], t1 = bounds[sgm + 1], za = zAt(t0), zb = zAt(t1), mb = mbFor(BOX_PALETTE[ci])
          box(mb, [x, y, (za + zb) / 2], [hL, hW, (za - zb) / 2], sgm === 0 ? ['+x', '-x', '-z', '+z'] : ['+x', '-x', '-z'])
          // 两个舷侧面：被相邻列挡住的部分是平面，露出的部分是瓦楞条 + 每道层缝上下两条侧梁平带
          for (const sg of [1, -1]) {
            const yf = y + sg * hW, ta = Math.min(t1, Math.max(t0, expo(sg)))
            if (ta > t0) decal(mb, [x, yf, (za + zAt(ta)) / 2], [0, sg, 0], [1, 0, 0], hL, (za - zAt(ta)) / 2, 0)
            if (ta >= t1) continue
            corrStrip(mb, prof, x, yf, sg, zb, zAt(ta))
            for (let t = ta; t <= t1; t++) {
              const z1 = Math.max(zAt(t) - RAIL_H, zb), z2 = Math.min(zAt(t) + RAIL_H, zAt(ta))
              if (z2 - z1 > 1e-6) decal(mb, [x, yf, (z1 + z2) / 2], [0, sg, 0], [1, 0, 0], hL, (z2 - z1) / 2, railLift)
            }
            // 两端角柱（0.15 m）：同色凸条，压在侧梁上、层缝线下
            for (const ex of [1, -1]) reliefLine(mb, [x + ex * (hL - 0.075), yf, (zAt(ta) + zb) / 2], [0, sg, 0], [1, 0, 0], 0.075, (zAt(ta) - zb) / 2, 0.7, 0.005)
          }
          // 最后一贝的艉向端面：箱门中缝（凹缝）+ 四根锁杆（凸条），与箱同色、只靠法向出明暗（深色细线在整船视角是一片噪点）
          if (b === p.bays - 1) {
            for (let t = t0; t < t1; t++) {
              const c = [x - hL, y, zAt(t + 0.5)]
              reliefLine(mb, c, [-1, 0, 0], [0, 1, 0], 0.012, 0.44 * g.Hc, -2.5, 0.002)
              for (const f of [-0.62, -0.3, 0.3, 0.62]) reliefLine(mb, add(c, [0, f * hW, 0]), [-1, 0, 0], [0, 1, 0], 0.018, 0.42 * g.Hc, 3, 0.018)
            }
          }
        }
        // 最后一贝的艉向端面：层缝
        if (b === p.bays - 1) for (let t = 1; t < nT; t++) decal(marks, [x - hL, y, zAt(t)], [-1, 0, 0], [0, 1, 0], hW, seam, lift)
        if (b === 0) for (let t = 1; t < nT; t++) decal(marks, [x + hL, y, g.z0 - t * g.Hc], [1, 0, 0], [0, 1, 0], hW, seam, lift)
        // 舷侧露出的部分：层缝横线（深色，稀疏、是真缝）；瓦楞 / 角柱是同色几何与凸条（见上）
        for (const sg of [1, -1]) for (let t = Math.max(1, expo(sg)); t < nT; t++) decal(marks, [x, y + sg * hW, zAt(t)], [0, sg, 0], [1, 0, 0], hL - 0.05, seam, lift)
      }
      boxComp(ctx, `bay${b}`, bayMass, [x, 0, g.z0 - (maxT * g.Hc) / 2], [hL, g.Wb / 2, (maxT * g.Hc) / 2])
      // 绑扎桥：本贝与后一贝之间的门形框（立柱 + 两层走道），约两层箱高；最外立柱外缘与箱块外缘齐平（不出箱块横向外缘）
      if (p.lashing && b < p.bays - 1 && p.bayGapM >= 0.4) {
        const xg = x - hL - p.bayGapM / 2, zTop = g.z0 - Math.min(2, p.tiers) * g.Hc, hx = Math.min(0.35 * p.bayGapM, 0.45)
        const nPost = Math.max(2, Math.ceil(p.rows / 4) + 1), yP = g.Wb / 2 - 0.1
        for (let k = 0; k < nPost; k++) box(lash, [xg, -yP + (2 * yP * k) / (nPost - 1), zTop / 2], [Math.min(0.3 * p.bayGapM, 0.1), 0.1, -zTop / 2])
        for (let k = 1; k <= Math.min(2, p.tiers); k++) box(lash, [xg, 0, g.z0 - k * g.Hc + 0.04], [hx, g.Wb / 2, 0.04])
      }
    }
    for (const key of [...new Set(BOX_PALETTE)]) if (byMat.has(key)) put(ctx, `boxes_${key}`, 'other', part, key, byMat.get(key))
    put(ctx, 'marks', 'other', part, 'dark_metal', marks)
    put(ctx, 'hatch', 'other', part, 'titanium', hatch)
    put(ctx, 'lashing', 'other', part, 'dark_metal', lash)
    return ctx
  }
}

// ───────────────────────────── 船载 VSAT 罩 ─────────────────────────────

/**
 * 罩与天线的几何：截球（球心在罩顶下 Rs 处，最大径 = 罩径）+ 基座（高 = 基座高比 × 罩高，夹在「截面过赤道」与
 * 「球几乎整个露出」之间）；天线 = 主焦碟（f/D 0.38），顶点在俯仰轴前方，零位视轴 +X、俯仰轴过球心沿 y。
 */
function vsatGeom(p) {
  const pre = p.model !== 'custom' ? SHIP_RADOMES[p.model] : null
  const H = pre ? pre.H : p.heightM, Dm = pre ? pre.D : p.diameterM, Dr = pre ? pre.reflD : p.reflectorDM
  const Rs = Dm / 2, hb = clampN(p.baseFrac * H, Math.max(0, H - 1.98 * Rs), Math.max(0, H - Rs))
  const dP = H - Rs - hb, rt = Math.sqrt(Math.max(0, Rs * Rs - dP * dP))
  const Rr = Dr / 2, f = 0.38 * Dr, th = 0.006 * Dr + 0.004, xv = th + 0.03 * Dr
  return { pre, H, Dm, Dr, Rs, hb, zc: -(H - Rs), dP, rt, Rr, f, th, xv, xRim: xv + (Rr * Rr) / (4 * f), ya: Rr + 0.05 * Dr }
}
const RADOME_AREAL = 25, SHIP_DISH_AREAL = 15   // 罩壳 / 反射面等效面密度（kg/m²，示意）

const vsatRadome = {
  type: 'sea.vsat.radome', domain: ['ship', 'vehicle', 'ground'], title: 'Maritime VSAT radome', titleZh: '船载卫通罩', role: 'other',
  params: {
    model: enm('v130nx', ['v100nx', 'v130nx', 'v240m', 'custom'], '型号', {
      source: V130NX_URL,
      title: `v100nx = Intellian v100NX（罩高 145.8 cm、罩径 137.9 cm、反射面 105 cm、113 kg）${V100NX_URL}；v130nx = Intellian v130NX（168.1 cm、172.4 cm、125 cm、150 kg）${V130NX_URL}；v240m = Intellian v240M（431 cm、391 cm、240 cm、1133 kg）${V240M_URL}；custom = 按下面三项`
    }),
    heightM: num(1.681, 'm', '罩高', { gt: 0, max: 10, source: V130NX_URL, title: '型号 custom 时生效' }),
    diameterM: num(1.724, 'm', '罩径', { gt: 0, max: 10, source: V130NX_URL, title: '型号 custom 时生效' }),
    reflectorDM: num(1.25, 'm', '反射面口径', { gt: 0, max: 8, source: V130NX_URL, title: '型号 custom 时生效' }),
    baseFrac: num(0.18, '', '基座高比', { min: 0, max: 0.5, title: '基座高 / 罩高' }),
    antenna: bool(true, '内置天线'),
    translucent: bool(false, '半透明'),
    el0Deg: num(30, '°', '初始仰角', { min: -90, max: 180 }),
    elMinDeg: num(-15, '°', '仰角下限', { min: -90, max: 90 }),
    elMaxDeg: num(110, '°', '仰角上限', { min: -90, max: 180 }),
    azTravelDeg: num(720, '°', '方位行程', { gt: 0, max: 720, title: '≥ 360° 以北为中心；不足 360° 以南为中心' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空：预设型号取整机质量；custom = 罩 25 kg/m² + 反射面（示意）' })
  },
  validate: (p) => {
    const e = p.elMinDeg <= p.elMaxDeg ? [] : ['仰角下限大于上限']
    const g = vsatGeom(p)
    if (!(g.H >= 1.1 * g.Rs)) e.push('罩高与罩径不成截球')
    else if (p.antenna && (Math.hypot(g.xRim, g.Rr) > 0.97 * g.Rs || g.ya > 0.95 * g.Rs || g.xv + 0.5 * g.Dr > 0.95 * g.Rs)) e.push('反射面口径过大')
    return e
  },
  sockets: (p) => { const g = vsatGeom(p); return [standSocket(Math.max(0.1, 2 * g.rt), 15)] },
  // 检修门在 −X 侧：只关于 xz 面对称
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = vsatGeom(p)
    const rdPart = { id: 'radome', name: '天线罩', role: 'other' }, antPart = { id: 'antenna', name: '船载天线', role: 'reflector' }
    // 罩：自罩顶极点到截面，赤道环单独取样（sin(π/2) = 1：最大径逐位等于罩径）
    const psiT = Math.acos(clampN(-g.dP / g.Rs, -1, 1)), n1 = 18, n2 = psiT - Math.PI / 2 > 1e-6 ? Math.max(2, Math.round((18 * (psiT - Math.PI / 2)) / (Math.PI / 2))) : 0
    const prof = [[g.H, 0]]
    for (let i = 1; i <= n1; i++) { const ps = (Math.PI / 2) * (i / n1); prof.push([g.H - g.Rs + g.Rs * Math.cos(ps), g.Rs * Math.sin(ps)]) }
    for (let i = 1; i <= n2; i++) { const ps = Math.PI / 2 + (psiT - Math.PI / 2) * (i / n2); prof.push([g.H - g.Rs + g.Rs * Math.cos(ps), g.Rs * Math.sin(ps)]) }
    const dm = new MB()
    lathe(dm, prof, 96, [0, 0, 0], [0, 0, -1])
    const dome = put(ctx, 'dome', 'other', rdPart, p.translucent ? 'glass' : 'white_paint', dm)
    shellMass(ctx, 'dome', dome, RADOME_AREAL)
    // 基座（锥台）+ 法兰 + 检修门
    const bm = new MB(), door = new MB(), rb0 = 0.85 * g.rt, rb1 = 0.97 * g.rt
    if (g.hb > 1e-6) frustum(bm, [0, 0, 0], rb0, [0, 0, -g.hb], rb1, 64, true, true)
    const fh = Math.max(0.01, 0.012 * g.H), zf0 = Math.min(-g.hb + fh, 0)
    frustum(bm, [0, 0, zf0], Math.min(1.035 * g.rt, g.Rs), [0, 0, zf0 - 2 * fh], Math.min(1.035 * g.rt, g.Rs), 64, true, true)
    const base = put(ctx, 'base', 'other', rdPart, 'white_paint', bm)
    if (base) shellMass(ctx, 'base', base, RADOME_AREAL)
    if (g.hb > 0.25 && g.rt < 0.9 * g.Rs) {
      // 检修门：贴锥面的曲面片（−X 侧，浮起 6 mm）
      const zc = -0.45 * g.hb, hv = Math.min(0.3 * g.hb, 0.6), dphi = Math.min(0.35 * g.rt, 0.4) / (rb0 + (rb1 - rb0) * 0.45), rows = []
      for (const z of [zc + hv, zc - hv]) {
        const r = rb0 + ((rb1 - rb0) * -z) / g.hb + 0.006, row = []
        for (let j = 0; j <= 6; j++) { const ph = Math.PI - dphi + (2 * dphi * j) / 6; row.push([r * Math.cos(ph), r * Math.sin(ph), z]) }
        rows.push(row)
      }
      grid(door, rows, { out: (c) => [c[0], c[1], 0] })
      put(ctx, 'door', 'other', rdPart, 'titanium', door)
    }
    if (p.antenna) {
      const C = [0, 0, g.zc], ex = [1, 0, 0], D = g.Dr
      const front = new MB(), back = new MB(), feedM = new MB(), shaft = new MB(), yoke = new MB(), tt = new MB()
      // 反射面：凹面（法向朝焦点）/ 背面 / 口沿；背架托板 + 电子箱
      const fp = [], bp = []
      for (let i = 0; i <= 10; i++) { const r = (g.Rr * i) / 10, sx = g.xv + (r * r) / (4 * g.f); fp.push([sx, r]); bp.push([sx - g.th, r]) }
      lathe(front, fp, 48, C, ex, { inward: true })
      lathe(back, bp, 48, C, ex)
      lathe(back, [[g.xRim, g.Rr], [g.xRim - g.th, g.Rr]], 48, C, ex)
      box(back, add(C, [g.xv - g.th - 0.03 * D, 0, 0]), [0.03 * D, 0.12 * D, 0.12 * D])
      box(back, add(C, [-0.1 * D, 0, 0.08 * D]), [0.07 * D, 0.16 * D, 0.1 * D])
      // 馈源（喇叭口面在焦点、朝反射面）+ 高频头 + 四撑杆（口沿 45° 起）
      const F = add(C, [g.xv + g.f, 0, 0]), fa = 0.055 * D
      frustum(feedM, add(F, [0.07 * D, 0, 0]), 0.5 * fa, F, fa, 24, true, false)
      annulus(feedM, F, [-1, 0, 0], 0.82 * fa, fa, 24, [-1, 0, 0])
      box(feedM, add(F, [0.11 * D, 0, 0]), [0.04 * D, 0.045 * D, 0.045 * D])
      for (let k = 0; k < 4; k++) {
        const ph = Math.PI / 4 + (Math.PI / 2) * k, c = Math.cos(ph), s = Math.sin(ph)
        tubeAlong(feedM, add(C, [g.xRim - g.th, 0.96 * g.Rr * c, 0.96 * g.Rr * s]), add(F, [0.08 * D, 0.03 * D * c, 0.03 * D * s]), 0.006 * D + 0.003, 8)
      }
      // 俯仰轴（随俯仰转）；叉臂 + 俯仰轴承座 + 转台（只随方位转）
      tubeAlong(shaft, add(C, [0, -g.ya - 0.02 * D, 0]), add(C, [0, g.ya + 0.02 * D, 0]), 0.022 * D, 16)
      const zTT = -g.hb - 0.04 * g.H, yb = Math.min(0.45 * g.rt, 0.6 * g.ya), ax = 0.035 * D, ay = 0.025 * D, zA = g.zc - 0.05 * D
      for (const sg of [1, -1]) {
        prism(yoke, [[-ax, sg * yb - ay, zTT], [ax, sg * yb - ay, zTT], [ax, sg * yb + ay, zTT], [-ax, sg * yb + ay, zTT]],
          [[-ax, sg * g.ya - ay, zA], [ax, sg * g.ya - ay, zA], [ax, sg * g.ya + ay, zA], [-ax, sg * g.ya + ay, zA]])
        tubeAlong(yoke, [0, sg * (g.ya - 1.5 * ay), g.zc], [0, sg * (g.ya + 1.5 * ay), g.zc], 0.04 * D, 16)
      }
      frustum(tt, [0, 0, -g.hb], 0.55 * g.rt, [0, 0, zTT], 0.5 * g.rt, 48, true, true)
      const G = gimbalFrame('azel', [1, 0, 0], [0, 0, -1])
      const refl = putFramed(ctx, 'reflector', 'reflector', antPart, 'reflector', front, G, C)
      putFramed(ctx, 'dishback', 'reflector', antPart, 'white_paint', back, G, C)
      putFramed(ctx, 'feed', 'feed', antPart, 'aluminum', feedM, G, C)
      putFramed(ctx, 'elaxis', 'boom', antPart, 'dark_metal', shaft, G, C)
      putFramed(ctx, 'yoke', 'boom', antPart, 'white_paint', yoke, G, C)
      putFramed(ctx, 'turntable', 'boom', antPart, 'dark_metal', tt, G, C)
      const [mn, mx, ini] = azStage(p.azTravelDeg)
      ctx.arts.push({ name: 'gimbal', nodes: ['reflector', 'dishback', 'feed', 'elaxis'], stages: [stage(STAGE.az, 'zRotate', mn, mx, ini), stage(STAGE.el, 'xRotate', p.elMinDeg, p.elMaxDeg, p.el0Deg)] })
      ctx.arts.push({ name: 'azimuth', nodes: ['yoke', 'turntable'], stages: [stage(STAGE.az, 'zRotate', mn, mx, ini)] })
      const dishKg = shellMass(ctx, 'reflector', refl, SHIP_DISH_AREAL) * SHIP_DISH_AREAL
      boxComp(ctx, 'pedestal', 1.5 * dishKg, [0, 0, (g.zc + zTT) / 2], [0.3 * g.rt, 0.3 * g.rt, Math.max(0.01, (zTT - g.zc) / 2)])
      apLocal(ctx, 'boresight', C, [1, 0, 0], [0, 0, -1])
      ctx.parts.get('antenna').normalBody = [1, 0, 0]
    } else apLocal(ctx, 'zenith', [0, 0, -g.H], [0, 0, -1], [1, 0, 0])
    // 质量：显式质量 > 预设整机质量 > 示意估算，按质量元比例缩放
    const target = isNum(p.massKg) ? p.massKg : g.pre ? g.pre.massKg : null
    if (target) {
      scaleMass(ctx, target)
    }
    return ctx
  }
}

export const SEA_COMPONENTS = Object.freeze([hull, superstructure, funnel, mast, containers, vsatRadome])
