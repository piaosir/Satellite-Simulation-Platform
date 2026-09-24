// 姿态 / 光照几何（设计契约 §6.2；任务书 §6.2 nadir 定义）。纯数学、double、无依赖，node / Worker / 渲染端共用。
//
// 三套轴，别混：
//   ECEF    地固系（km）。satellite.js 的 eciToEcf 输出就是它：X 指 0°经、Z 指北极。
//   场景轴   3D 球的 three 坐标：Y 是极轴 —— 场景 (x,y,z) = ECEF (X, Z, −Y)。与 focusLanes.llaToVec 同一映射
//           （llaToVec 展开后正是 r·(cosφcosλ, sinφ, −cosφsinλ)），是真旋转（det=+1），右手系不变。
//   L 系    跟随视图的局部系：x̂ = 沿迹（惯性速度去掉径向分量后归一）、ŷ = 径向向上 r̂、ẑ = x̂ × ŷ。
//           本体（nadir 律）在 L 中恒为 X_B = x̂、Y_B = ẑ、Z_B = −ŷ——+Z 精确指地心、+X 沿速度在水平面的投影、
//           +Y 补全右手系（= 负轨道法向；赤道顺行轨道上即指南）。与 STK「Nadir alignment with ECF velocity constraint」
//           的区别只在速度取惯性还是地固：★ GEO 的地固速度≈0、方向随机，必须用惯性速度（ECEF 轴向）定沿迹方向。
//
// 四元数一律 [x, y, z, w]（与 three / glTF / bodyFrame.mjs 同序），q 把「源系坐标」转到「目标系坐标」：v_dst = q ⊗ v_src ⊗ q*。
//
// 导出：
//   sceneFromEcef(v) / ecefFromScene(v)
//   lvlhFrameEcef(rEcef, vInertialEcefAxes) → {x, y, z}（ECEF 下三根单位轴）
//   lvlhQuatScene(rEcef, vInertialEcefAxes) → qL2S
//   Q_BODY2L_NADIR                          → 本体 → L（nadir 律，常量）
//   bodyQuatSceneNadir(rEcef, vInertialEcefAxes) → qB2S = qL2S ⊗ Q_BODY2L_NADIR
//   quatMul / quatRotate / quatConj / quatFromBasis / matFromQuat
//   ★ 热路径：lvlhQuatScene / bodyQuatSceneNadir / quatMul / quatRotate / quatFromBasis 末参可传 out 数组（零分配），
//     eclipseFactor 本身不分配；入参接受 [x,y,z] 或 satellite.js 的 {x,y,z}
//   sunDirEcef(subLatDeg, subLonDeg) / sunDirScene(subLatDeg, subLonDeg)
//   eclipseFactor(rEcefKm, sunDirUnitEcef, opts) → 受照比例 0..1（圆锥 + 半影，两圆盘重叠面积）
//   EARTH_RADIUS_KM, SUN_RADIUS_KM, AU_KM
//
// 二期（DESIGN2 §1，文件后半）：
//   attitudeBasisEcef(law, params, ctx, out)  五种姿态律 → 本体三轴在标准 ECEF（Z 极轴）下的单位矢量 {X, Y, Z}
//   makeBasis / ATT_LAWS / ATT_SECONDARY / OMEGA_EARTH_RAD_S
//   yawFromNadir(nadirBasis, yawDeg, out)      nadir 基底绕 +Z 偏航
//   limitYawRate(yawDeg[], tMs[], maxRateDegS) 偏航角速率限幅（正午 / 午夜翻转的执行机构近似）
//   basisToQuat / quatToBasis / basisToQuatScene / ecefToScene / sceneToEcef（带 out）
//   losToBody / bodyToEcef                      视线 ECEF ↔ 本体
//   mountFrame / mountBasisEcef / dirBodyToMount / dirMountToBody / azElInMount   挂点系（z = 视轴、y = up 投影、x = y × z）
//   articulationSunAngle / rotateAboutAxis      单轴对日转角
//   gmstRadAt(utcMs)                            与 satellite.js gstime 逐位一致
//   sunEcefApprox(utcMs, out) / sunDistanceAu(utcMs)   与 terminator.solarGeometry 同一套 Meeus 低精度解

import { defaultUpBody } from './bodyFrame.mjs'

export const EARTH_RADIUS_KM = 6371          // 与 focusLanes.RE 同值：场景把地球当 6371 km 的球
export const SUN_RADIUS_KM = 695700          // IAU 2015 B3 名义太阳半径
export const AU_KM = 1.495978707e8           // 天文单位（IAU 2012 B2）

const D2R = Math.PI / 180
// 入参既可以是 [x,y,z] 也可以是 satellite.js 的 {x,y,z}
const v3 = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z])
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const nrm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }

/** ECEF → 场景轴：(X, Y, Z) → (X, Z, −Y)。 */
export function sceneFromEcef(v) { const a = v3(v); return [a[0], a[2], -a[1]] }
/** 场景轴 → ECEF：(x, y, z) → (x, −z, y)。 */
export function ecefFromScene(v) { const a = v3(v); return [a[0], -a[2], a[1]] }

/**
 * L 系三根轴（ECEF 下的单位向量）。
 * 退化处理：速度与径向平行（纯径向运动 / 零速度）时，沿迹方向改取「当地正东」ẑ_ecef × r̂；
 * 在极点正东也无定义，再退到 ECEF +X 去径向分量。只是为了不出 NaN，正常轨道碰不到。
 */
export function lvlhFrameEcef(rEcef, vInertialEcefAxes) {
  const r = v3(rEcef), up = nrm(r)
  const v = v3(vInertialEcefAxes)
  let t = [v[0] - up[0] * dot(v, up), v[1] - up[1] * dot(v, up), v[2] - up[2] * dot(v, up)]
  if (!(len(t) > 1e-12 * Math.max(1, len(v)))) {
    t = cross([0, 0, 1], up)
    if (!(len(t) > 1e-12)) t = [1 - up[0] * up[0], -up[0] * up[1], -up[0] * up[2]]
  }
  const x = nrm(t)
  return { x, y: up, z: cross(x, up) }
}

// 读分量不建临时数组（热路径：3D 页每个时钟拍对主选星与 ≤ 32 颗图标星各调一次）
const gx = (v) => (v.x !== undefined ? v.x : v[0]), gy = (v) => (v.y !== undefined ? v.y : v[1]), gz = (v) => (v.z !== undefined ? v.z : v[2])

/** 3×3（按列轴给出）→ 四元数，Shepperd 法（数值稳定）；写进 out，w ≥ 0 规范形。 */
function quatFromM(m00, m01, m02, m10, m11, m12, m20, m21, m22, out) {
  const tr = m00 + m11 + m22
  let x, y, z, w
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s
  }
  const l = Math.hypot(x, y, z, w) * (w < 0 ? -1 : 1)
  out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = w / l
  return out
}

/**
 * 以三根列轴（目标系下）构造「源 → 目标」四元数。列轴须正交归一且右手；返回 w ≥ 0 的规范形。
 * @param {number[]} [out] 给了就写进它（免分配）
 */
export function quatFromBasis(xAxis, yAxis, zAxis, out = [0, 0, 0, 0]) {
  return quatFromM(xAxis[0], yAxis[0], zAxis[0], xAxis[1], yAxis[1], zAxis[1], xAxis[2], yAxis[2], zAxis[2], out)
}

/** 四元数 → 3×3 旋转矩阵（行主序 [[..],[..],[..]]），列 = 源系三轴在目标系下的像。 */
export function matFromQuat(q) {
  const [x, y, z, w] = q
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
  ]
}
/** Hamilton 积 a ⊗ b（先 b 后 a）；out 可与 a / b 同一个数组。 */
export function quatMul(a, b, out = [0, 0, 0, 0]) {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1]
  const y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0]
  const z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3]
  const w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  out[0] = x; out[1] = y; out[2] = z; out[3] = w
  return out
}
export const quatConj = (q) => [-q[0], -q[1], -q[2], q[3]]
/** 用 q 旋转向量 v；out 可与 v 同一个数组。 */
export function quatRotate(q, v, out = [0, 0, 0]) {
  const x = q[0], y = q[1], z = q[2], w = q[3], a0 = gx(v), a1 = gy(v), a2 = gz(v)
  // t = 2·(q.xyz × v)；v' = v + w·t + q.xyz × t
  const tx = 2 * (y * a2 - z * a1), ty = 2 * (z * a0 - x * a2), tz = 2 * (x * a1 - y * a0)
  out[0] = a0 + w * tx + (y * tz - z * ty); out[1] = a1 + w * ty + (z * tx - x * tz); out[2] = a2 + w * tz + (x * ty - y * tx)
  return out
}

/**
 * L → 场景的四元数 qL2S（契约 §6.2）。全标量计算、不建临时数组（给了 out 就零分配）；轴向与退化口径同 lvlhFrameEcef。
 * @param {number[]|{x,y,z}} rEcef              卫星位置（ECEF，任意长度单位）
 * @param {number[]|{x,y,z}} vInertialEcefAxes  惯性速度转到 ECEF 轴向（satellite.js：eciToEcf(pv.velocity, gmst)，不加 ω×r）
 * @param {number[]} [out]
 */
export function lvlhQuatScene(rEcef, vInertialEcefAxes, out = [0, 0, 0, 0]) {
  const rx = gx(rEcef), ry = gy(rEcef), rz = gz(rEcef), rl = Math.hypot(rx, ry, rz)
  const ux = rx / rl, uy = ry / rl, uz = rz / rl
  const vx = gx(vInertialEcefAxes), vy = gy(vInertialEcefAxes), vz = gz(vInertialEcefAxes)
  const vu = vx * ux + vy * uy + vz * uz
  let tx = vx - ux * vu, ty = vy - uy * vu, tz = vz - uz * vu
  if (!(Math.hypot(tx, ty, tz) > 1e-12 * Math.max(1, Math.hypot(vx, vy, vz)))) {
    tx = -uy; ty = ux; tz = 0                                  // ẑ_ecef × r̂ = 当地正东
    if (!(Math.hypot(tx, ty, tz) > 1e-12)) { tx = 1 - ux * ux; ty = -ux * uy; tz = -ux * uz }
  }
  const tl = Math.hypot(tx, ty, tz)
  const xx = tx / tl, xy = ty / tl, xz = tz / tl                // x̂（ECEF）
  const zx = xy * uz - xz * uy, zy = xz * ux - xx * uz, zz = xx * uy - xy * ux   // ẑ = x̂ × ŷ
  // 列轴转场景轴：(X, Y, Z) → (X, Z, −Y)
  return quatFromM(xx, ux, zx, xz, uz, zz, -xy, -uy, -zy, out)
}

/** 本体 → L（nadir 律）：X_B→x̂、Y_B→ẑ、Z_B→−ŷ，即绕 x̂ 转 +90°。 */
export const Q_BODY2L_NADIR = Object.freeze([Math.SQRT1_2, 0, 0, Math.SQRT1_2])

/** 本体 → 场景（nadir 律）：qL2S ⊗ Q_BODY2L_NADIR；给了 out 就零分配。 */
export function bodyQuatSceneNadir(rEcef, vInertialEcefAxes, out = [0, 0, 0, 0]) {
  return quatMul(lvlhQuatScene(rEcef, vInertialEcefAxes, out), Q_BODY2L_NADIR, out)
}

/** 日下点 → ECEF 太阳单位矢量（日下点纬度即太阳赤纬，地心纬度口径）。 */
export function sunDirEcef(subLatDeg, subLonDeg) {
  const p = subLatDeg * D2R, l = subLonDeg * D2R
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]
}
/** 日下点 → 场景轴太阳单位矢量；与 llaToVec(subLat, subLon, 0).normalize() 同值（terminator.solarGeometry().sub 直接喂进来）。 */
export function sunDirScene(subLatDeg, subLonDeg) { return sceneFromEcef(sunDirEcef(subLatDeg, subLonDeg)) }

/**
 * 受照比例（地影因子）：圆锥模型 + 半影。卫星处看到的日面圆盘与地球圆盘的角半径分别为
 *   a = asin(R☉ / |s − r|)，b = asin(R⊕ / |r|)，两圆心角距 c = ∠(s − r, −r)；
 * 按平面两圆盘的重叠面积 A 求被遮比例：受照 = 1 − A / (π a²)（Montenbruck & Gill《Satellite Orbits》§3.4.2 的锥形阴影函数）。
 *   c ≥ a + b → 1（全日照）；c ≤ b − a → 0（本影）；c ≤ a − b → 1 − b²/a²（环食；近地轨道不会出现，照算）；其余为半影。
 * 太阳位置取「方向 × 日地距离」：方向用日下点（terminator.js 的 Meeus 低精度解），距离缺省 1 AU——
 * 距离年变 ±1.7 % 只让半影宽度差同量级，对 0..1 的光照强度无感。
 * @param {number[]} rEcefKm           卫星 ECEF 位置（km）
 * @param {number[]} sunDirUnitEcef    太阳单位矢量（ECEF）
 * @param {{sunDistKm?:number, earthRadiusKm?:number, sunRadiusKm?:number}} [opts]
 * @returns {number} 0（本影）..1（全日照）；卫星在地球内部返回 0
 */
export function eclipseFactor(rEcefKm, sunDirUnitEcef, opts) {
  const sunDist = (opts && opts.sunDistKm) ?? 1.496e8
  const Re = (opts && opts.earthRadiusKm) ?? EARTH_RADIUS_KM
  const Rs = (opts && opts.sunRadiusKm) ?? SUN_RADIUS_KM
  const rx = gx(rEcefKm), ry = gy(rEcefKm), rz = gz(rEcefKm)
  const rn = Math.hypot(rx, ry, rz)
  if (!(rn > Re)) return 0
  const sx0 = gx(sunDirUnitEcef), sy0 = gy(sunDirUnitEcef), sz0 = gz(sunDirUnitEcef), sl = Math.hypot(sx0, sy0, sz0)
  const tx = (sx0 / sl) * sunDist - rx, ty = (sy0 / sl) * sunDist - ry, tz = (sz0 / sl) * sunDist - rz   // 卫星 → 太阳
  const ds = Math.hypot(tx, ty, tz)
  const a = Math.asin(Math.min(1, Rs / ds))     // 日面角半径
  const b = Math.asin(Math.min(1, Re / rn))     // 地球角半径
  const cc = -(tx * rx + ty * ry + tz * rz) / (ds * rn)
  const c = Math.acos(Math.max(-1, Math.min(1, cc)))
  if (c >= a + b) return 1
  if (c <= b - a) return 0
  if (c <= a - b) return 1 - (b * b) / (a * a)
  // 两圆部分重叠：A = a²·acos(x/a) + b²·acos((c−x)/b) − c·y，x = (c² + a² − b²)/(2c)，y = √(a² − x²)
  const x = (c * c + a * a - b * b) / (2 * c)
  const y = Math.sqrt(Math.max(0, a * a - x * x))
  const A = a * a * Math.acos(Math.max(-1, Math.min(1, x / a))) + b * b * Math.acos(Math.max(-1, Math.min(1, (c - x) / b))) - c * y
  return Math.max(0, Math.min(1, 1 - A / (Math.PI * a * a)))
}

// ══════════════════════════════ 二期：五种姿态律（DESIGN2 §1、任务书 §6.2）══════════════════════════════
//
// 输出一律是「本体三轴在标准 ECEF（Z 极轴，与 src/viz/grd/coverage.js、日凌核同一套）下的单位矢量」{X, Y, Z}，
// 不是场景轴——覆盖 / 可见性 / 日凌都在标准 ECEF 里算，场景轴只在画图时换（basisToQuatScene）。
//
// ctx（所有律共用）：
//   rEcef         卫星位置（ECEF，km）
//   vInertialEcef 惯性速度转到 ECEF 轴向（TEME 速度经 gstime 旋转、【不减】ω×r；satellite.js 的 eciToEcf(pv.velocity, gmst)）。
//                 缺省（快照 / 定点星）按 ω⊕ẑ × r 合成——赤道 GEO 上即正东，与 3D 页 grd-pointing 摸底 §4-3 同口径。
//   sunEcef       太阳单位矢量（ECEF）；yawSteer / sun 律与「次约束 = 太阳」时必需
//   targetEcef    目标 ECEF（km；地球站或另一颗星）；target 律必需
//   gmstRad / tMs inertial 律把 TEME 转到 ECEF 用；给了 gmstRad 就不再按 tMs 现算
//   prevYawDeg    yawSteer 在奇点（太阳恰在 ±Z 上）取上一拍的偏航，保证连续；缺省 0
//
// 各律（本体系：+X 速度、+Z 天底、+Y 补全）：
//   nadir     +Z 指地心、+X = 惯性速度 ⟂Z 的投影、+Y = Z × X（赤道顺行 = 南）。params.yawBiasDeg 可加固定偏航。
//   yawSteer  nadir 再绕 +Z 偏航 ψ，使太阳翼轴（±Y）⟂ 太阳：推导见 yawSteerPsi 头注。
//   sun       params.axis（本体，缺省 −Z）精确指太阳；次约束 params.secondary（缺省：axis ∥ ±Z 时 'velocity'，否则 'nadir'）。
//   inertial  params.q（本体 → TEME 惯性系，[x,y,z,w]）或 params.eulerDeg {yaw, pitch, roll}（3-2-1）。
//             ★ TEME 不是 J2000：两者差岁差 + 章动，2026 年约 0.36°；手里是 J2000 的四元数要先经 utils/frames.js 转 TEME。
//   target    params.axis（缺省 +Z）精确指目标；次约束缺省 'sun'（+X 朝太阳一侧 ⇒ ±Y 翼轴 ⟂ 太阳）。
// 次约束（TRIAD：主轴精确对准，次轴落在「主方向–次方向」平面内且朝次方向一侧，这是约束下离次方向最近的解）：
//   'nadir'（世界 −r̂，本体缺省 +Z）· 'velocity'（世界 v，本体缺省 +X）· 'sun'（世界 太阳，本体缺省 +X）·
//   'orbitNormal'（世界 +ĥ = r × v，本体缺省 −Y，即 nadir 律下的 −Y）。params.secondaryAxis 改本体轴。
//   主次退化（本体轴平行或世界方向平行）时依次退到 velocity → nadir → orbitNormal，out.fallback 置 true。
//
// ★ 热路径（可见性窗内子扫描、功率 / ΔT 时间序列、3D 页逐拍）：out 复用即无显式分配——五种律、gmstRadAt、sunEcefApprox、
//   sunDistanceAu 都不建对象 / 数组 / Date（缺省轴直接写分量、次约束退链与空 params 是模块级冻结常量、GMST 按整数日历现算、
//   欧拉角四元数与惯性系三轴标量展开、|v| 不走 Math.hypot）。剩下的只有 V8 在未内联调用边界 / megamorphic 取数点对 double 的
//   装箱（16 B / 个，随 JIT 反馈浮动）；量法与数字见 modelAttitudeLaws 单测 ⑦（采样堆分析，报数不判）。

export const OMEGA_EARTH_RAD_S = 7.292115e-5     // 地球自转角速度（IERS Conventions 2010 名义值）
export const ATT_LAWS = Object.freeze(['nadir', 'yawSteer', 'sun', 'inertial', 'target'])
export const ATT_SECONDARY = Object.freeze(['nadir', 'velocity', 'sun', 'orbitNormal'])
// 次约束本体缺省轴（nadir +Z、velocity / sun +X、orbitNormal −Y）与律的缺省主轴（sun −Z、target +Z）不做成常量数组，
// 由 secAxisInto / set3 把分量直接写进暂存：冻结数组（另一种 elements kind）一旦流进取数器（getX / unitInto）的取数点，会把那里的
// 属性访问撑成 megamorphic，之后每取一个 double 都要装箱分配（采样堆分析实测，改前 sun / target 律每次调用 ≈ 400 B）。
const SEC_FALLBACK = Object.freeze(['velocity', 'nadir', 'orbitNormal'])   // 次约束退链（首选之后依次试）
const EMPTY_PARAMS = Object.freeze({})
const R2D = 180 / Math.PI
// |(x,y,z)| / |(x,y)|：常规量级走 sqrt(Σx²)；平方和越出 (1e-290, 1e290)（上下溢）或非有限时才退回 Math.hypot。
// ★ V8（Node 22 / Electron 31）的 Math.hypot 每次调用都分配一个 FixedDoubleArray 暂存绝对值（实测 1e6 次三参调用 ≈ 100 次
//   minor GC，sqrt 式 ≈ 0），二期热路径一律用这两个；一期函数（lvlhFrameEcef / eclipseFactor 等）不动。
const norm3 = (x, y, z) => { const s = x * x + y * y + z * z; return s > 1e-290 && s < 1e290 ? Math.sqrt(s) : Math.hypot(x, y, z) }
const norm2 = (x, y) => { const s = x * x + y * y; return s > 1e-290 && s < 1e290 ? Math.sqrt(s) : Math.hypot(x, y) }
// 二期专用取数器（语义同 gx / gy / gz，[x,y,z] 或 {x,y,z}）：单独一份，免得一期函数（3D 页拿 satellite.js 的 {x,y,z} 调）
// 把同一个取数点的类型反馈撑成 megamorphic——那样之后每取一个 double 都要装箱分配
const getX = (v) => (v.x !== undefined ? v.x : v[0]), getY = (v) => (v.y !== undefined ? v.y : v[1]), getZ = (v) => (v.z !== undefined ? v.z : v[2])

/** 空基底（out 容器）：{X, Y, Z, yawDeg, law, fallback}。yawDeg 只对 nadir / yawSteer 有意义，其余为 NaN。 */
export function makeBasis() {
  return { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], yawDeg: 0, law: 'nadir', fallback: false }
}
function ensureBasis(out) {
  if (!out || typeof out !== 'object') return makeBasis()
  if (!out.X) out.X = [0, 0, 0]
  if (!out.Y) out.Y = [0, 0, 0]
  if (!out.Z) out.Z = [0, 0, 0]
  return out
}
const set3 = (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o }
const finite3 = (v) => v != null && Number.isFinite(getX(v)) && Number.isFinite(getY(v)) && Number.isFinite(getZ(v))

/**
 * nadir 基底写进 out（标量计算，零分配）。与 lvlhFrameEcef 同一退化口径：
 * 速度 ∥ 径向 → 沿迹改取当地正东 ẑ × r̂；极点正东也无定义 → ECEF +X 去径向分量。
 */
function nadirInto(r, v, out) {
  const rx = getX(r), ry = getY(r), rz = getZ(r), rl = norm3(rx, ry, rz)
  const ux = rx / rl, uy = ry / rl, uz = rz / rl
  let vx, vy, vz
  if (finite3(v)) { vx = getX(v); vy = getY(v); vz = getZ(v) } else { vx = -OMEGA_EARTH_RAD_S * ry; vy = OMEGA_EARTH_RAD_S * rx; vz = 0 }
  const vu = vx * ux + vy * uy + vz * uz
  let tx = vx - ux * vu, ty = vy - uy * vu, tz = vz - uz * vu
  if (!(norm3(tx, ty, tz) > 1e-12 * Math.max(1, norm3(vx, vy, vz)))) {
    tx = -uy; ty = ux; tz = 0
    if (!(norm3(tx, ty, tz) > 1e-12)) { tx = 1 - ux * ux; ty = -ux * uy; tz = -ux * uz }
  }
  const tl = norm3(tx, ty, tz)
  const Xx = tx / tl, Xy = ty / tl, Xz = tz / tl
  const Zx = -ux, Zy = -uy, Zz = -uz
  set3(out.X, Xx, Xy, Xz)
  set3(out.Z, Zx, Zy, Zz)
  set3(out.Y, Zy * Xz - Zz * Xy, Zz * Xx - Zx * Xz, Zx * Xy - Zy * Xx)      // Y = Z × X
  return out
}

/** 就地绕本体 +Z 偏航 ψ（度，右手）：X' = cosψ X + sinψ Y，Y' = −sinψ X + cosψ Y，Z 不变。 */
function yawInPlace(out, yawDeg) {
  if (!yawDeg) return out
  const c = Math.cos(yawDeg * D2R), s = Math.sin(yawDeg * D2R), X = out.X, Y = out.Y
  const x0 = X[0], x1 = X[1], x2 = X[2], y0 = Y[0], y1 = Y[1], y2 = Y[2]
  X[0] = c * x0 + s * y0; X[1] = c * x1 + s * y1; X[2] = c * x2 + s * y2
  Y[0] = c * y0 - s * x0; Y[1] = c * y1 - s * x1; Y[2] = c * y2 - s * x2
  return out
}

/**
 * nadir 基底绕本体 +Z 偏航 yawDeg 后的基底（右手、度）。offline 的偏航序列（如 limitYawRate 的结果）用它还原本体轴。
 * @param {{X,Y,Z}} nadirBasis
 * @param {number} yawDeg
 * @param {object} [out]
 */
export function yawFromNadir(nadirBasis, yawDeg, out) {
  const o = ensureBasis(out)
  set3(o.X, nadirBasis.X[0], nadirBasis.X[1], nadirBasis.X[2])
  set3(o.Y, nadirBasis.Y[0], nadirBasis.Y[1], nadirBasis.Y[2])
  set3(o.Z, nadirBasis.Z[0], nadirBasis.Z[1], nadirBasis.Z[2])
  yawInPlace(o, yawDeg)
  o.yawDeg = yawDeg; o.law = 'yawSteer'; o.fallback = false
  return o
}

/**
 * yawSteer 的偏航角 ψ（度，(−180, 180]）——按本平台轴向重新推导（DESIGN2 §1 要求核对任务书 §6.2 的式子）：
 *
 *   设太阳单位矢量在 nadir 本体系的分量 s = (s_x, s_y, s_z)。本体绕 +Z 右手转 ψ 后，新 Y 轴在旧系为 (−sinψ, cosψ, 0)，
 *   翼轴 ⟂ 太阳 ⇔ Y'·s = −sinψ·s_x + cosψ·s_y = 0 ⇔ tanψ = s_y / s_x。两个根差 180°：
 *     ψ = atan2( s_y,  s_x) → X'·s = √(s_x²+s_y²) ≥ 0，太阳在 +X' 半平面（params.sunSide 缺省 '+X'，与 IGS / Kouba 对 GPS 的约定同侧）
 *     ψ = atan2(−s_y, −s_x) → 太阳在 −X' 半平面（params.sunSide '-X'）
 *   【DESIGN2 草稿写的 atan2(−s_y, s_x)】是把偏航当成「参考系转、本体不动」的反号约定，本平台的四元数是主动旋转，不用它。
 *
 *   换成 β / μ（圆轨道）：β = 太阳相对轨道面的仰角（朝 +ĥ = r × v 为正），μ = 卫星自【轨道正午】沿运动方向转过的角。
 *   太阳在轨道系 = cosβ·cosμ·r̂ − cosβ·sinμ·x̂ + sinβ·ĥ；本体 X = x̂、Y = −ĥ、Z = −r̂ ⇒ s_x = −cosβ·sinμ、s_y = −sinβ，
 *     ψ = atan2(−tanβ, −sin μ)（除以 cosβ > 0 不改象限）。
 *   任务书的 ψ = atan2(−tanβ, sin μ) 在【μ 自轨道午夜起算】时与此逐位同式（Kouba 2009 GPS 名义偏航的口径）；
 *   照任务书字面「μ 自正午起算」代入，翼轴与太阳的点积会留下 ±sin 2β 量级的残差（单测把这一点钉住了）。
 *
 *   奇点：s_x = s_y = 0（太阳恰在 ±Z：β = 0 且在正午 / 午夜）ψ 无定义，任何 ψ 都满足 ⟂；取 ctx.prevYawDeg（缺省 0）。
 *   奇点附近 ψ 在 ~2|β|/ω 的时间里翻 180°，瞬时角速率 ≈ ω/tanβ——执行机构跟不上的那一段用 limitYawRate 近似。
 */
function yawSteerPsi(sx, sy, sunSide, prevYawDeg) {
  if (!(norm2(sx, sy) > 1e-12)) return Number.isFinite(prevYawDeg) ? prevYawDeg : 0
  return (sunSide === '-X' ? Math.atan2(-sy, -sx) : Math.atan2(sy, sx)) * R2D
}

function unitInto(v, o) {
  const x = getX(v), y = getY(v), z = getZ(v), l = norm3(x, y, z)
  if (!(l > 0) || !Number.isFinite(l)) return null
  o[0] = x / l; o[1] = y / l; o[2] = z / l
  return o
}
// 次约束的世界方向（写进 o；不可用返回 null）
function secondaryWorld(kind, ctx, o) {
  const r = ctx.rEcef
  if (kind === 'nadir') { const u = unitInto(r, o); if (!u) return null; o[0] = -o[0]; o[1] = -o[1]; o[2] = -o[2]; return o }
  if (kind === 'sun') return finite3(ctx.sunEcef) ? unitInto(ctx.sunEcef, o) : null
  const rx = getX(r), ry = getY(r), rz = getZ(r)
  let vx, vy, vz
  if (finite3(ctx.vInertialEcef)) { vx = getX(ctx.vInertialEcef); vy = getY(ctx.vInertialEcef); vz = getZ(ctx.vInertialEcef) } else { vx = -OMEGA_EARTH_RAD_S * ry; vy = OMEGA_EARTH_RAD_S * rx; vz = 0 }
  if (kind === 'velocity') { o[0] = vx; o[1] = vy; o[2] = vz; return unitInto(o, o) }
  if (kind === 'orbitNormal') { o[0] = ry * vz - rz * vy; o[1] = rz * vx - rx * vz; o[2] = rx * vy - ry * vx; return unitInto(o, o) }
  return null
}
const _pb = [0, 0, 0], _sb = [0, 0, 0], _dp = [0, 0, 0], _ds = [0, 0, 0]
const crossLen = (a, b) => norm3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])

/**
 * TRIAD：本体主轴 pb 精确对准世界 dp，本体次轴 sb 尽量靠近世界 ds（落在 dp–ds 平面内、朝 ds 一侧）。
 * 本体三元组 t1 = pb、t2 = pb × sb / |…|、t3 = t1 × t2；世界同式 w1、w2、w3；R = W·Tᵀ，本体轴 e_k 的像 = Σ w_i·t_i[k]。
 * 入参已单位化；返回 out。
 */
function triadInto(pb, dp, sb, ds, out) {
  let t2x = pb[1] * sb[2] - pb[2] * sb[1], t2y = pb[2] * sb[0] - pb[0] * sb[2], t2z = pb[0] * sb[1] - pb[1] * sb[0]
  const tl = norm3(t2x, t2y, t2z); t2x /= tl; t2y /= tl; t2z /= tl
  const t3x = pb[1] * t2z - pb[2] * t2y, t3y = pb[2] * t2x - pb[0] * t2z, t3z = pb[0] * t2y - pb[1] * t2x
  let w2x = dp[1] * ds[2] - dp[2] * ds[1], w2y = dp[2] * ds[0] - dp[0] * ds[2], w2z = dp[0] * ds[1] - dp[1] * ds[0]
  const wl = norm3(w2x, w2y, w2z); w2x /= wl; w2y /= wl; w2z /= wl
  const w3x = dp[1] * w2z - dp[2] * w2y, w3y = dp[2] * w2x - dp[0] * w2z, w3z = dp[0] * w2y - dp[1] * w2x
  // 本体 X = W·(t1x, t2x, t3x)，Y、Z 同理
  set3(out.X, dp[0] * pb[0] + w2x * t2x + w3x * t3x, dp[1] * pb[0] + w2y * t2x + w3y * t3x, dp[2] * pb[0] + w2z * t2x + w3z * t3x)
  set3(out.Y, dp[0] * pb[1] + w2x * t2y + w3x * t3y, dp[1] * pb[1] + w2y * t2y + w3y * t3y, dp[2] * pb[1] + w2z * t2y + w3z * t3y)
  set3(out.Z, dp[0] * pb[2] + w2x * t2z + w3x * t3z, dp[1] * pb[2] + w2y * t2z + w3y * t3z, dp[2] * pb[2] + w2z * t2z + w3z * t3z)
  return out
}

// 次约束的本体缺省轴：分量直接写进 o（常量数组不进取数器，见 SEC_FALLBACK 处注释）
function secAxisInto(k, o) {
  if (k === 'nadir') return set3(o, 0, 0, 1)
  if (k === 'orbitNormal') return set3(o, 0, -1, 0)
  return set3(o, 1, 0, 0)                                          // velocity / sun
}
const isSecondary = (k) => k === 'nadir' || k === 'velocity' || k === 'sun' || k === 'orbitNormal'

/** 主轴（已单位化、在 _pb 里）对准 + 次约束链（退化就往下退）。成功返回 true；全部退化返回 false（调用方退回 nadir）。 */
function alignInto(primaryWorld, secondary, secondaryAxis, ctx, out) {
  for (let i = 0; i <= SEC_FALLBACK.length; i++) {
    const k = i === 0 ? secondary : SEC_FALLBACK[i - 1]
    if (!isSecondary(k)) continue
    const okAx = i === 0 && finite3(secondaryAxis) ? unitInto(secondaryAxis, _sb) : secAxisInto(k, _sb)
    if (!okAx || !(crossLen(_pb, _sb) > 1e-6)) continue
    if (!secondaryWorld(k, ctx, _ds) || !(crossLen(primaryWorld, _ds) > 1e-9)) continue
    triadInto(_pb, primaryWorld, _sb, _ds, out)
    out.fallback = i > 0
    return true
  }
  return false
}

const _q = [0, 0, 0, 1]
/**
 * q = qz(yaw) ⊗ qy(pitch) ⊗ qx(roll)（与 bodyFrame.fineRotate 同序），标量展开写进 out。
 * 与「两次 quatMul」逐位相同（乘零、加零都是精确运算，求值次序照 quatMul 排）；不调一期 quatMul：那是一期 / 3D 页共用的
 * 函数，数组取数点被各种调用方撑成 megamorphic 后每取一个 double 都装箱（测试进程里实测 ≈ 256 B / 次）。
 */
function quatFromEulerZYX(e, out) {
  const yaw = Array.isArray(e) ? e[0] : e.yaw, pitch = Array.isArray(e) ? e[1] : e.pitch, roll = Array.isArray(e) ? e[2] : e.roll
  const hz = (Number(yaw) || 0) * D2R / 2, hy = (Number(pitch) || 0) * D2R / 2, hx = (Number(roll) || 0) * D2R / 2
  const sz = Math.sin(hz), cz = Math.cos(hz), sy = Math.sin(hy), cy = Math.cos(hy), sx = Math.sin(hx), cx = Math.cos(hx)
  const x1 = -(sz * sy), y1 = cz * sy, z1 = sz * cy, w1 = cz * cy      // qz ⊗ qy
  out[0] = w1 * sx + x1 * cx
  out[1] = y1 * cx + z1 * sx
  out[2] = -(y1 * sx) + z1 * cx
  out[3] = w1 * cx - x1 * sx
  return out
}

/**
 * 五种姿态律 → 本体三轴（标准 ECEF 单位矢量）。坏输入（r 缺失 / 零长）返回 null。
 * @param {'nadir'|'yawSteer'|'sun'|'inertial'|'target'} law  未知律按 nadir
 * @param {object} [params]
 * @param {{rEcef, vInertialEcef?, sunEcef?, targetEcef?, gmstRad?, tMs?, prevYawDeg?}} ctx
 * @param {object} [out]  makeBasis() 的容器，复用即零分配
 * @returns {{X:number[], Y:number[], Z:number[], yawDeg:number, law:string, fallback:boolean}|null}
 */
export function attitudeBasisEcef(law, params, ctx, out) {
  if (!ctx || !finite3(ctx.rEcef) || !(norm3(getX(ctx.rEcef), getY(ctx.rEcef), getZ(ctx.rEcef)) > 0)) return null
  const p = params || EMPTY_PARAMS
  const o = ensureBasis(out)
  o.fallback = false
  // 每种律一个小函数、分派函数保持很小：各律各自拿 TurboFan 的内联预算（小工具函数内联不进去时，double 返回值在调用边界装箱）
  if (law === 'yawSteer') return lawYawSteer(p, ctx, o)
  if (law === 'sun') return lawSun(p, ctx, o) ? alignedDone(o, 'sun') : nadirFallback(ctx, o)
  if (law === 'target') return lawTarget(p, ctx, o) ? alignedDone(o, 'target') : nadirFallback(ctx, o)
  if (law === 'inertial') return lawInertial(p, ctx, o) ? o : nadirFallback(ctx, o)
  return lawNadir(law, p, ctx, o)
}
function alignedDone(o, law) { o.law = law; o.yawDeg = NaN; return o }
function nadirFallback(ctx, o) {
  nadirInto(ctx.rEcef, ctx.vInertialEcef, o)
  o.law = 'nadir'; o.yawDeg = 0; o.fallback = true
  return o
}
function lawNadir(law, p, ctx, o) {
  nadirInto(ctx.rEcef, ctx.vInertialEcef, o)
  const bias = Number(p.yawBiasDeg) || 0
  if (bias) yawInPlace(o, bias)
  o.law = 'nadir'; o.yawDeg = bias; o.fallback = law !== 'nadir' && law != null && !ATT_LAWS.includes(law)
  return o
}
function lawYawSteer(p, ctx, o) {
  nadirInto(ctx.rEcef, ctx.vInertialEcef, o)
  if (!finite3(ctx.sunEcef)) { o.law = 'nadir'; o.yawDeg = 0; o.fallback = true; return o }
  const s = ctx.sunEcef, sx = getX(s) * o.X[0] + getY(s) * o.X[1] + getZ(s) * o.X[2], sy = getX(s) * o.Y[0] + getY(s) * o.Y[1] + getZ(s) * o.Y[2]
  const psi = yawSteerPsi(sx, sy, p.sunSide, ctx.prevYawDeg)
  yawInPlace(o, psi)
  o.yawDeg = psi; o.law = 'yawSteer'
  return o
}
function lawSun(p, ctx, o) {
  if (!finite3(ctx.sunEcef) || !unitInto(ctx.sunEcef, _dp)) return false
  const okAx = finite3(p.axis) ? unitInto(p.axis, _pb) : set3(_pb, 0, 0, -1)       // 缺省本体 −Z 指太阳
  if (!okAx) return false
  const alongZ = Math.abs(_pb[2]) > 1 - 1e-9
  const sec = isSecondary(p.secondary) ? p.secondary : (alongZ ? 'velocity' : 'nadir')
  return alignInto(_dp, sec, p.secondaryAxis, ctx, o)
}
function lawTarget(p, ctx, o) {
  if (!finite3(ctx.targetEcef)) return false
  _dp[0] = getX(ctx.targetEcef) - getX(ctx.rEcef); _dp[1] = getY(ctx.targetEcef) - getY(ctx.rEcef); _dp[2] = getZ(ctx.targetEcef) - getZ(ctx.rEcef)
  if (!unitInto(_dp, _dp)) return false
  const sec = isSecondary(p.secondary) ? p.secondary : 'sun'
  const okAx = finite3(p.axis) ? unitInto(p.axis, _pb) : set3(_pb, 0, 0, 1)        // 缺省本体 +Z 指目标
  return okAx ? alignInto(_dp, sec, p.secondaryAxis, ctx, o) : false
}
function lawInertial(p, ctx, o) {
  let q = null
  const pq = p.q
  if (Array.isArray(pq) && pq.length === 4 && Number.isFinite(pq[0]) && Number.isFinite(pq[1]) && Number.isFinite(pq[2]) && Number.isFinite(pq[3])) {
    const q0 = pq[0], q1 = pq[1], q2 = pq[2], q3 = pq[3], qs = q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3
    const l = qs > 1e-290 && qs < 1e290 ? Math.sqrt(qs) : Math.hypot(q0, q1, q2, q3)
    if (l > 0) { _q[0] = q0 / l; _q[1] = q1 / l; _q[2] = q2 / l; _q[3] = q3 / l; q = _q }
  } else if (p.eulerDeg && typeof p.eulerDeg === 'object') q = quatFromEulerZYX(p.eulerDeg, _q)
  else { _q[0] = 0; _q[1] = 0; _q[2] = 0; _q[3] = 1; q = _q }
  const g = Number.isFinite(ctx.gmstRad) ? ctx.gmstRad : (Number.isFinite(ctx.tMs) ? gmstRadAt(ctx.tMs) : NaN)
  if (!q || !Number.isFinite(g)) return false
  const c = Math.cos(g), sn = Math.sin(g)
  // TEME 下的本体三轴 = R(q) 的三列（与 quatToBasis 同式，就地算、不经 quatRotate / 取数器）；再绕极轴转 −GMST 到 ECEF
  // （与 satellite.js eciToEcf 同一转动）。c / sn 不当实参传给别的函数：传出去会在调用边界装箱分配
  const x = q[0], y = q[1], z = q[2], w = q[3]
  let tx = 1 - 2 * (y * y + z * z), ty = 2 * (x * y + z * w), tz = 2 * (x * z - y * w)
  o.X[0] = tx * c + ty * sn; o.X[1] = -tx * sn + ty * c; o.X[2] = tz
  tx = 2 * (x * y - z * w); ty = 1 - 2 * (x * x + z * z); tz = 2 * (y * z + x * w)
  o.Y[0] = tx * c + ty * sn; o.Y[1] = -tx * sn + ty * c; o.Y[2] = tz
  tx = 2 * (x * z + y * w); ty = 2 * (y * z - x * w); tz = 1 - 2 * (x * x + y * y)
  o.Z[0] = tx * c + ty * sn; o.Z[1] = -tx * sn + ty * c; o.Z[2] = tz
  o.law = 'inertial'; o.yawDeg = NaN
  return true
}

/**
 * 偏航角速率限幅：逐步把 ψ 往目标 ψ_n 追，单步最多转 maxRate·Δt（沿最短角差方向）。给正午 / 午夜翻转一个执行机构近似，
 * 翻转期间翼轴与太阳的夹角偏离 90° 的量由调用方从结果里算。maxRateDegS ≤ 0 或非数 → 原样拷贝。
 * 坏拍（yawDeg[i] 非有限：星历缺拍、非偏航律）输出 NaN，但执行机构状态停在上一个有限拍、不被污染；
 * 下一个有限拍从那里接着追，可转角度按「距上一个有限拍的时长」算（缺拍期间执行机构保持、不知道往哪转）。
 * 全部有限时与逐拍递推逐位相同。
 * @returns {Float64Array}
 */
export function limitYawRate(yawDeg, tMs, maxRateDegS, out) {
  const n = yawDeg.length
  const o = out && out.length >= n ? out : new Float64Array(n)
  if (!n) return o
  const lim = Number(maxRateDegS)
  let last = NaN, lastT = NaN                                   // 执行机构状态：上一个有限拍的输出与时刻
  for (let i = 0; i < n; i++) {
    const y = yawDeg[i]
    if (!Number.isFinite(y)) { o[i] = NaN; continue }
    if (!(lim > 0) || !Number.isFinite(last)) { o[i] = y; last = y; lastT = tMs[i]; continue }
    const dt = (tMs[i] - lastT) / 1000
    let d = y - last
    d = ((d % 360) + 540) % 360 - 180                         // 最短角差 (−180, 180]
    const step = lim * (dt > 0 ? dt : 0)
    let v = last + (Math.abs(d) <= step ? d : Math.sign(d) * step)
    v = ((v % 360) + 540) % 360 - 180
    o[i] = v === -180 ? 180 : v
    last = o[i]; lastT = tMs[i]
  }
  return o
}

// ─────────────────────────────── 基底 ↔ 四元数 / 场景轴 ───────────────────────────────

/** 本体 → ECEF 的四元数 [x,y,z,w]（v_ecef = q ⊗ v_body ⊗ q*）；w ≥ 0 规范形。 */
export function basisToQuat(basis, out = [0, 0, 0, 0]) {
  const X = basis.X, Y = basis.Y, Z = basis.Z
  return quatFromM(X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2], out)
}
/** 四元数（本体 → 目标系）→ 三轴 {X, Y, Z}。 */
export function quatToBasis(q, out) {
  const o = ensureBasis(out)
  const x = q[0], y = q[1], z = q[2], w = q[3]
  set3(o.X, 1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w))
  set3(o.Y, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w))
  set3(o.Z, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y))
  return o
}
/** 本体 → 场景轴（(x,y,z) = ECEF(X, Z, −Y)）的四元数，给 3D 页 modelLayer / 工作台直接用。 */
export function basisToQuatScene(basis, out = [0, 0, 0, 0]) {
  const X = basis.X, Y = basis.Y, Z = basis.Z
  return quatFromM(X[0], Y[0], Z[0], X[2], Y[2], Z[2], -X[1], -Y[1], -Z[1], out)
}
/** ECEF → 场景轴（带 out；sceneFromEcef 的零分配版）。 */
export function ecefToScene(v, out = [0, 0, 0]) { const x = getX(v), y = getY(v), z = getZ(v); out[0] = x; out[1] = z; out[2] = -y; return out }
/** 场景轴 → ECEF（带 out）。 */
export function sceneToEcef(v, out = [0, 0, 0]) { const x = getX(v), y = getY(v), z = getZ(v); out[0] = x; out[1] = -z; out[2] = y; return out }

/** 视线（ECEF 方向，任意长度）→ 本体系分量：[l·X, l·Y, l·Z]（旋转不改长度；要单位矢量就传单位矢量）。 */
export function losToBody(losEcef, basis, out = [0, 0, 0]) {
  const x = getX(losEcef), y = getY(losEcef), z = getZ(losEcef), X = basis.X, Y = basis.Y, Z = basis.Z
  out[0] = x * X[0] + y * X[1] + z * X[2]
  out[1] = x * Y[0] + y * Y[1] + z * Y[2]
  out[2] = x * Z[0] + y * Z[1] + z * Z[2]
  return out
}
/** 本体系矢量 → ECEF：X·v₀ + Y·v₁ + Z·v₂。 */
export function bodyToEcef(vBody, basis, out = [0, 0, 0]) {
  const a = getX(vBody), b = getY(vBody), c = getZ(vBody), X = basis.X, Y = basis.Y, Z = basis.Z
  out[0] = X[0] * a + Y[0] * b + Z[0] * c
  out[1] = X[1] * a + Y[1] * b + Z[1] * c
  out[2] = X[2] * a + Y[2] * b + Z[2] * c
  return out
}

// ─────────────────────────────── 挂点系（DESIGN2 D1） ───────────────────────────────
//
// 挂点系 = 天线系：z = 视轴、y = up 在视轴法平面的投影、x = y × z（右手）。与 coverage.js 天线基底 {x, y, z} 同构：
// 「up ↔ 天线 +y」。视轴字段认 boresightBody（任务书 §4.2）或 dirBody（attach point 口径）；up 缺失 / 与视轴平行时
// 按 D1 取 bodyFrame.defaultUpBody（本体 −Y 在视轴法平面的投影，退化取 +X）——对地挂点 up = −Y，GEO 顺行即正北，
// 「姿态律 nadir + 视轴 +Z」与手动天底档逐位相等（单测）。

const _mb = [0, 0, 1], _mu = [0, -1, 0]
function mountVec(v) {
  return v != null && (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]) && Math.hypot(v[0], v[1], v[2]) > 1e-12 ? v : null
}

/**
 * 挂点系三轴（本体系坐标）。
 * @param {{boresightBody?:number[], dirBody?:number[], upBody?:number[]}} mount
 * @param {{x:number[], y:number[], z:number[]}} [out]
 */
export function mountFrame(mount, out) {
  const o = out && out.x && out.y && out.z ? out : { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] }
  const m = mount || {}
  const b = mountVec(m.boresightBody) || mountVec(m.dirBody) || [0, 0, 1]
  unitInto(b, _mb)
  let up = mountVec(m.upBody)
  let ux = 0, uy = 0, uz = 0
  if (up) {
    const l = Math.hypot(up[0], up[1], up[2]); ux = up[0] / l; uy = up[1] / l; uz = up[2] / l
    const k = ux * _mb[0] + uy * _mb[1] + uz * _mb[2]
    ux -= k * _mb[0]; uy -= k * _mb[1]; uz -= k * _mb[2]
    if (!(Math.hypot(ux, uy, uz) > 1e-6)) up = null            // 与视轴平行（同 bodyFrame.isUpDegenerate 的 1e-6）
  }
  if (!up) {
    const d = defaultUpBody([_mb[0], _mb[1], _mb[2]])
    ux = d[0]; uy = d[1]; uz = d[2]
  }
  const ul = Math.hypot(ux, uy, uz)
  set3(o.y, ux / ul, uy / ul, uz / ul)
  set3(o.z, _mb[0], _mb[1], _mb[2])
  const y = o.y, z = o.z
  set3(o.x, y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0])   // x = y × z
  return o
}
/** 本体系方向 → 挂点系分量 [d·x, d·y, d·z]。 */
export function dirBodyToMount(dirBody, frame, out = [0, 0, 0]) {
  const a = getX(dirBody), b = getY(dirBody), c = getZ(dirBody), x = frame.x, y = frame.y, z = frame.z
  out[0] = a * x[0] + b * x[1] + c * x[2]
  out[1] = a * y[0] + b * y[1] + c * y[2]
  out[2] = a * z[0] + b * z[1] + c * z[2]
  return out
}
/** 挂点系分量 → 本体系方向：x·d₀ + y·d₁ + z·d₂。 */
export function dirMountToBody(dirMount, frame, out = [0, 0, 0]) {
  const a = getX(dirMount), b = getY(dirMount), c = getZ(dirMount), x = frame.x, y = frame.y, z = frame.z
  out[0] = x[0] * a + y[0] * b + z[0] * c
  out[1] = x[1] * a + y[1] * b + z[1] * c
  out[2] = x[2] * a + y[2] * b + z[2] * c
  return out
}
/**
 * 挂点系（天线系）三轴在 ECEF 下：coverage.js 的天线基底 {x, y, z}（z = 视轴）。bodyBasis 来自 attitudeBasisEcef。
 * @returns {{x:number[], y:number[], z:number[]}}
 */
export function mountBasisEcef(bodyBasis, frame, out) {
  const o = out && out.x && out.y && out.z ? out : { x: [0, 0, 0], y: [0, 0, 0], z: [0, 0, 0] }
  bodyToEcef(frame.x, bodyBasis, o.x)
  bodyToEcef(frame.y, bodyBasis, o.y)
  bodyToEcef(frame.z, bodyBasis, o.z)
  return o
}
/**
 * 挂点系方向 → 读数（度）：
 *   az / el    与 gimbal.solveAzEl 同一口径：方位轴 = 挂点 +y（up），az 自 +z 转向 +x、el 朝 +y 为正；视轴 = (0, 0)
 *   offAxisDeg 与视轴夹角；phiDeg 绕视轴自 +x 转向 +y 的方位
 */
export function azElInMount(dirMount, out) {
  const o = out || { az: 0, el: 0, offAxisDeg: 0, phiDeg: 0 }
  const x = getX(dirMount), y = getY(dirMount), z = getZ(dirMount), l = norm3(x, y, z) || 1
  o.az = Math.atan2(x, z) * R2D
  o.el = Math.asin(Math.max(-1, Math.min(1, y / l))) * R2D
  o.offAxisDeg = Math.acos(Math.max(-1, Math.min(1, z / l))) * R2D
  o.phiDeg = Math.atan2(y, x) * R2D
  return o
}

// ─────────────────────────────── 单轴对日（太阳翼 articulation） ───────────────────────────────

/** v 绕单位轴 axis 右手转 deg（Rodrigues）；axis 不必单位长。 */
export function rotateAboutAxis(v, axis, deg, out = [0, 0, 0]) {
  const al = norm3(getX(axis), getY(axis), getZ(axis))
  const kx = getX(axis) / al, ky = getY(axis) / al, kz = getZ(axis) / al
  const vx = getX(v), vy = getY(v), vz = getZ(v), c = Math.cos(deg * D2R), s = Math.sin(deg * D2R)
  const kv = kx * vx + ky * vy + kz * vz
  const cx = ky * vz - kz * vy, cy = kz * vx - kx * vz, cz = kx * vy - ky * vx
  out[0] = vx * c + cx * s + kx * kv * (1 - c)
  out[1] = vy * c + cy * s + ky * kv * (1 - c)
  out[2] = vz * c + cz * s + kz * kv * (1 - c)
  return out
}

/**
 * 单轴对日转角（度，(−180, 180]）：把 pointingVector 绕 axis 右手转 θ，使它与太阳夹角最小。
 *   p(θ) = p∥ + cosθ·p⊥ + sinθ·(â × p⊥) ⇒ p(θ)·s 在 θ = atan2((â × p⊥)·s, p⊥·s) 取最大。
 * p ∥ axis（转了也没用）或太阳 ∥ axis（转到哪都一样）返回 0。三个矢量都在本体系（STK 的 pointingVector 在节点局部系，
 * 调用方先转到本体系）。关节限位由调用方夹。
 */
export function articulationSunAngle(pointingVectorBody, axisBody, sunBody) {
  const al = norm3(getX(axisBody), getY(axisBody), getZ(axisBody))
  if (!(al > 0)) return 0
  const ax = getX(axisBody) / al, ay = getY(axisBody) / al, az = getZ(axisBody) / al
  const px = getX(pointingVectorBody), py = getY(pointingVectorBody), pz = getZ(pointingVectorBody)
  const k = px * ax + py * ay + pz * az
  const qx = px - k * ax, qy = py - k * ay, qz = pz - k * az                     // p⊥
  if (!(norm3(qx, qy, qz) > 1e-12 * Math.max(1, norm3(px, py, pz)))) return 0
  const wx = ay * qz - az * qy, wy = az * qx - ax * qz, wz = ax * qy - ay * qx   // â × p⊥
  const sx = getX(sunBody), sy = getY(sunBody), sz = getZ(sunBody)
  const cs = qx * sx + qy * sy + qz * sz, sn = wx * sx + wy * sy + wz * sz
  if (!(norm2(cs, sn) > 1e-15)) return 0
  const th = Math.atan2(sn, cs) * R2D
  return th === -180 ? 180 : th
}

// ─────────────────────────────── 时间 / 太阳（渲染端之外也能用的一份） ───────────────────────────────

/**
 * GMST（弧度，[0, 2π)）——与 satellite.js gstime(new Date(utcMs)) 逐位一致（jday 与 gstimeInternal 原样照抄，单测对拍）。
 * 3D 页每拍已有 gmst 的，直接传 ctx.gmstRad，别重复算。
 * 不经 Date（热路径零分配）：先照 Date 的 TimeClip 取整毫秒（向零截断、|t| > 8.64e15 为 NaN），再按 Hinnant civil_from_days
 * 拆出与 getUTCFullYear / Month / Date / Hours / Minutes / Seconds / Milliseconds 相同的七个整数——全程整数运算，jday 输入逐位相同。
 */
export function gmstRadAt(utcMs) {
  let ms = Number(utcMs)
  if (!(Math.abs(ms) <= 8.64e15)) return NaN                   // Date 的 TimeClip：非有限 / 越界 → Invalid Date → gstime 得 NaN
  ms = Math.trunc(ms) + 0                                       // + 0：−0 → +0
  const days = Math.floor(ms / 86400000), msd = ms - days * 86400000
  const hr = Math.floor(msd / 3600000), minute = Math.floor((msd % 3600000) / 60000)
  const sec = Math.floor((msd % 60000) / 1000), msec = msd % 1000
  // civil_from_days（proleptic 公历，与 ECMAScript Date 同历法）
  const z = days + 719468, era = Math.floor(z / 146097), doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const mon = mp < 10 ? mp + 3 : mp - 9
  const year = yoe + era * 400 + (mon <= 2 ? 1 : 0)
  const jd = 367 * year - Math.floor(7 * (year + Math.floor((mon + 9) / 12)) * 0.25) + Math.floor(275 * mon / 9) + day + 17210135e-1 + ((msec / 6e4 + sec / 60 + minute) / 60 + hr) / 24
  const tut1 = (jd - 2451545) / 36525
  let temp = -62e-7 * tut1 * tut1 * tut1 + 0.093104 * tut1 * tut1 + (876600 * 3600 + 8640184812866e-6) * tut1 + 67310.54841
  temp = temp * (Math.PI / 180) / 240 % (Math.PI * 2)
  if (temp < 0) temp += Math.PI * 2
  return temp
}

// Meeus《Astronomical Algorithms》第 25 章低精度解——与 src/viz/terminator.js 的 sunRaDec 逐式相同（那份没导出，
// 且 core 不能 import src/）。视黄经误差约 0.01°，给姿态律、功率、显示用；星侧 ΔT 用日凌核的高精度 sunEcefAt（D12）。
// ★ sunEcefApprox 与晨昏线一样用 GMST（不是 GAST），对 VSOP87 + GAST 的日凌核再多一项 |Δψ·cos ε| ≤ 17.3″：
//   2020–2032 实测同 GAST 最差 32″、原始最差 46″（sunNoiseTemp 单测拆开量）。为与画面晨昏线同源，刻意不改。
const _sm = { T: 0, M: 0, C: 0, L0: 0 }                        // sunMeeus 的暂存（零分配；取完即用，不跨调用保留）
function sunMeeus(utcMs) {
  const jd = utcMs / 86400000 + 2440587.5
  const T = (jd - 2451545.0) / 36525
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T
  const Mr = M * D2R
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr)
    + 0.000289 * Math.sin(3 * Mr)
  _sm.T = T; _sm.M = M; _sm.C = C; _sm.L0 = L0
  return _sm
}
/**
 * 太阳单位矢量（标准 ECEF，Z 极轴）：terminator.solarGeometry 的日下点换成矢量（同一 GMST）。
 * @param {number} utcMs
 * @param {number[]} [out]
 * @param {number} [gmstRad]  已有就传，省一次 Date
 */
export function sunEcefApprox(utcMs, out = [0, 0, 0], gmstRad) {
  const sm = sunMeeus(utcMs), T = sm.T, C = sm.C, L0 = sm.L0
  const omega = (125.04 - 1934.136 * T) * D2R
  const lamApp = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * D2R
  const eps0 = 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * D2R
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lamApp), Math.cos(lamApp))
  const dec = Math.asin(Math.sin(eps) * Math.sin(lamApp))
  const g = Number.isFinite(gmstRad) ? gmstRad : gmstRadAt(utcMs)
  const lon = ra - g, cd = Math.cos(dec)
  out[0] = cd * Math.cos(lon); out[1] = cd * Math.sin(lon); out[2] = Math.sin(dec)
  return out
}
/**
 * 日地距离（AU）：Meeus 式 25.5，R = 1.000001018(1 − e²)/(1 + e·cos ν)。二体椭圆，不含月球（地月质心偏 ≈ 3.1e-5 AU）与
 * 金星 / 木星摄动，对日凌核 VSOP87 最差 8e-5 AU（sunNoiseTemp 单测 2020–2032 实测）→ 功率 1/R² 修正误差 < 0.02 %。
 * 功率的 1 AU 距离修正与 eclipseFactor 的 sunDistKm 用它。
 */
export function sunDistanceAu(utcMs) {
  const sm = sunMeeus(utcMs), T = sm.T, M = sm.M, C = sm.C
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T
  const nu = (M + C) * D2R
  return 1.000001018 * (1 - e * e) / (1 + e * Math.cos(nu))
}
