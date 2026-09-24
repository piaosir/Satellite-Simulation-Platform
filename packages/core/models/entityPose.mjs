// 非卫星实体的姿态（DESIGN3 §0 E9、§1 P2）：飞机 / 船 / 车 / 地球站的本体基底、L 系与场景四元数、地球站对星方位俯仰。
// 纯 ESM、零 three 依赖、node 可测；热路径函数末参传 out 即无显式分配（采样堆分析：单独跑 ≈ 0 B / 次；入参形状杂到取数点
// megamorphic 时每取一个 double 装箱 16 B——单测 ⑥ 报数、宽判据）。内部函数之间 double 经暂存数组递、不当实参传。
//
// ── 轴 ──（ECEF / 场景轴 / 四元数次序与 attitude.mjs 同：场景 (x,y,z) = ECEF (X, Z, −Y)，四元数 [x,y,z,w]、v_dst = q ⊗ v_src ⊗ q*）
//   本体   飞机 / 船 / 车：FRD（+X 机头 / 船艏、+Y 右、+Z 向下）；地球站：NED（+X 北、+Y 东、+Z 向下）= 航向 0、俯仰 0、滚转 0 的 FRD。
//   L 系   x̂ = 航向（当地水平面内）、ŷ = 当地天顶、ẑ = x̂ × ŷ（航向右侧）——与卫星跟随视图同一个 L 系定义（attitude.lvlhFrameEcef）。
//          天顶取【大地天顶】：场景把大地纬直接当球面纬画（focusLanes.llaToVec），场景里一点的径向恰好等于 WGS-84 大地天顶，
//          所以 qL2S 与画面、与 WGS-84 读数三者同一个「上」。用地心径向会斜 ≤ 0.19°（scene-entity 摸底 §2.3）。
//   qL2S = attitude.lvlhQuatScene(upEcef, headingEcef)——本文件用同式的零分配复写 lvlhQuatSceneInto（Math.hypot 换 sqrt，单测对拍 ≤ 1e-15）
//   qB2L = Q_BODY2L_NADIR ⊗ q(Y_B, 俯仰) ⊗ q(X_B, 滚转)：先滚转、后俯仰、再按 nadir 律摆进 L 系（航向已在 L 系的 x̂ 里）——
//          即航空 Z-Y-X 欧拉角（ψ 航向、θ 俯仰、φ 滚转）；绕 +Y_B 转 +θ 机头抬起，绕 +X_B 转 +φ 右翼下沉。平飞恒 = Q_BODY2L_NADIR。
//   模型轴 → 本体：这三类的缺省映射是 bodyFrame.Q_YUP_ZENITH（glTF +Y ↦ 本体 −Z 天顶、+Z ↦ +X 机头、+X ↦ −Y 左侧），
//          合成 qModel2S = qL2S ⊗ qB2L ⊗ qModel2Body（单测钉住「glTF +Z = 机头方向」）。
//
// ── 地球站对星 ──
//   读数（WGS-84）：stationTrackAzEl —— 站址按 WGS-84 椭球（与 vendor satellite.js geodeticToEcf、src/viz/wgs84.js 同常数），
//          视线投到大地 ENU，方位 / 俯仰经 gimbal.solveAzEl 求（挂点系见 STATION_MOUNT）；与 satellite.js ecfToLookAngles 对拍到 1e-9°。
//   画面（场景锚点）：stationAimScene —— 「星场景锚点 − 站场景锚点」，锚点都是 llaToVec(大地纬, 经, 高) 的球面口径（星的大地坐标由
//          ECEF 按 satellite.js eciToGeodetic 同一迭代反算）。碟面按它摆才正对画出来的那颗星；与读数差 ≤ 0.2°（单测扫 GEO / LEO；
//          方位 5° 步长细扫实测最坏：LEO 300 km 0.185°、500 km 0.180°、1200 km 0.164°（都在纬度 0、仰角 5°、斜方位即 45° 的
//          奇数倍一带）、GEO 0.040°；余量约 0.015°，改锚点口径前先重扫）。
//          ★ 这个误差预算只对站锚点 r = 1 + 海拔 / 6371 成立。图层若把站模型沿天顶抬高（例如站精灵的 ×1.0012），画面指向与读数
//            之差随之变大：LEO 300 km 0.91°、500 km 0.61°、1200 km 0.34°、GEO 0.05°（纬度 0、方位 0、仰角 45° 一带最坏）。
//            做法：碟面按实际绘制的锚点求（stationAimScene 第 4 参），保证视觉上正对画出来的星；HUD 读数一律用 stationTrackAzEl。
//   STATION_MOUNT（本体 NED 下的挂点系，attitude.mountFrame 口径 z = 视轴零位、y = 方位轴 up、x = y × z）：
//          z = +X_B（北、水平）、y = −Z_B（天顶）、x = −Y_B（西）。gimbal azel 主解 a1 自北转向西为正 = −罗盘方位，a2 = 仰角（朝天为正）。
//          ★ 与卫星挂点 / 掩模 D2 口径（el = +90 为本体 +Z = 天底）正负相反，地球站不套 D2。
//   整体转方位（模型没有方位关节时的兜底）：站模型按「航向 = 罗盘方位」摆，即 entityPoseAt(lat, lon, azDeg, 0, 0)——
//          绕本体 +Z（向下）右手转 az = 俯视顺时针，正北起算。
//
// 导出：enuEcef / headingDirEcef / sceneAnchor / geodeticToEcefKm / ecefToGeodetic /
//       makeEntityPose / entityPoseAt / vehiclePoseAt / stationPoseAt / bodyQuatL / bodyBasisEcef /
//       STATION_MOUNT / makeStationLook / stationTrackAzEl / stationAimScene / 常量

import { Q_BODY2L_NADIR } from './attitude.mjs'
import { solveAzEl } from './gimbal.mjs'

const D2R = Math.PI / 180, R2D = 180 / Math.PI

/** 场景球半径（km）：与 focusLanes.RE、attitude.EARTH_RADIUS_KM 同值。 */
export const SCENE_RE_KM = 6371
/** WGS-84（km）：与 src/viz/wgs84.js、vendor satellite.js 同一对常数。 */
export const WGS84_A_KM = 6378.137
export const WGS84_B_KM = 6356.7523142
const WGS_F = (WGS84_A_KM - WGS84_B_KM) / WGS84_A_KM
const WGS_E2 = 2 * WGS_F - WGS_F * WGS_F

const fin = Number.isFinite
const norm3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z)
const set3 = (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o }

// ─────────────────────────────── 当地基底 ───────────────────────────────

/** 空 ENU 容器。 */
export function makeEnu() { return { E: [0, 0, 0], N: [0, 0, 0], U: [0, 0, 0] } }
/**
 * 大地 (lat, lon) 处的 E / N / U 单位矢量（标准 ECEF 轴）。U = 大地天顶 = 场景球面径向。极点处 N / E 按经度公式照给（不退化）。
 * @param {object} [out] makeEnu() 的容器
 */
export function enuEcef(latDeg, lonDeg, out) {
  const o = out || makeEnu()
  const p = latDeg * D2R, l = lonDeg * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l)
  set3(o.E, -sl, cl, 0)
  set3(o.N, -sp * cl, -sp * sl, cp)
  set3(o.U, cp * cl, cp * sl, sp)
  return o
}
/** 航向（度，正北起顺时针）的水平单位矢量 cosψ·N + sinψ·E（ECEF）。 */
export function headingDirEcef(latDeg, lonDeg, headingDeg, out = [0, 0, 0]) {
  const p = latDeg * D2R, l = lonDeg * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l)
  const c = Math.cos(headingDeg * D2R), s = Math.sin(headingDeg * D2R)
  return set3(out, -c * sp * cl - s * sl, -c * sp * sl + s * cl, c * cp)
}
/** 场景锚点：focusLanes.llaToVec(lat, lon, altKm) 同式同求值次序（场景单位，地球半径 = 1）。 */
export function sceneAnchor(latDeg, lonDeg, altKm, out = [0, 0, 0]) {
  const r = (SCENE_RE_KM + altKm) / SCENE_RE_KM
  const phi = (90 - latDeg) * Math.PI / 180
  const theta = (lonDeg + 180) * Math.PI / 180
  out[0] = -r * Math.sin(phi) * Math.cos(theta)
  out[1] = r * Math.cos(phi)
  out[2] = r * Math.sin(phi) * Math.sin(theta)
  return out
}
/** 大地 (lat, lon, hKm) → WGS-84 ECEF（km）。与 src/viz/wgs84.geodeticToEcef、satellite.js geodeticToEcf 同式。 */
export function geodeticToEcefKm(latDeg, lonDeg, hKm, out = [0, 0, 0]) {
  const p = latDeg * D2R, l = lonDeg * D2R, sp = Math.sin(p), cp = Math.cos(p)
  const N = WGS84_A_KM / Math.sqrt(1 - WGS_E2 * sp * sp), h = hKm || 0
  return set3(out, (N + h) * cp * Math.cos(l), (N + h) * cp * Math.sin(l), (N * (1 - WGS_E2) + h) * sp)
}
/**
 * WGS-84 ECEF（km）→ 大地 {lat, lon（度）, hKm}。与 satellite.js eciToGeodetic（gmst = 0）/ wgs84.ecefToGeodetic 同一定点迭代（20 次）。
 */
export function ecefToGeodetic(x, y, z, out = { lat: 0, lon: 0, hKm: 0 }) {
  const R = Math.sqrt(x * x + y * y)
  let lat = Math.atan2(z, R), C = 1
  for (let k = 0; k < 20; k++) {
    const s = Math.sin(lat)
    C = 1 / Math.sqrt(1 - WGS_E2 * s * s)
    lat = Math.atan2(z + WGS84_A_KM * C * WGS_E2 * s, R)
  }
  out.lat = lat * R2D; out.lon = Math.atan2(y, x) * R2D; out.hKm = R / Math.cos(lat) - WGS84_A_KM * C
  return out
}

// ─────────────────────────────── 实体姿态 ───────────────────────────────

/**
 * 空姿态容器：qL2S（L → 场景）、qB2L（本体 → L）、qB2S（本体 → 场景）、upEcef / fwdEcef（大地天顶、航向水平单位矢量）。
 * modelLayer.setIcons 的每项正好吃 {qL2S, qB2L}。
 */
export function makeEntityPose() {
  return { qL2S: [0, 0, 0, 1], qB2L: [0, 0, 0, 1], qB2S: [0, 0, 0, 1], upEcef: [0, 0, 1], fwdEcef: [1, 0, 0] }
}

/**
 * qL2S = attitude.lvlhQuatScene(up, fwd) 的零分配复写（同式、同退化口径、同 Shepperd 分支与 w ≥ 0 规范形），读 up / fwd 两个数组写 out。
 * 只把 |v| 从 Math.hypot 换成 sqrt(Σx²)：V8（Node 22 / Electron 31）的 Math.hypot 每次调用分配暂存数组，lvlhQuatScene 一次要调 5 回
 * （采样堆分析实测 entityPoseAt 因此 ≈ 600 B / 次）；attitude.mjs 的一期函数不动。数值与 lvlhQuatScene 差几个 ulp（单测钉 ≤ 1e-15）。
 * 全部标量写在一个函数里、不把 double 当实参往外传（调用边界会装箱）。
 */
function lvlhQuatSceneInto(up, fwd, out) {
  const rx = up[0], ry = up[1], rz = up[2], rl = norm3(rx, ry, rz)
  const ux = rx / rl, uy = ry / rl, uz = rz / rl
  const vx = fwd[0], vy = fwd[1], vz = fwd[2]
  const vu = vx * ux + vy * uy + vz * uz
  let tx = vx - ux * vu, ty = vy - uy * vu, tz = vz - uz * vu
  const vl = norm3(vx, vy, vz)
  if (!(norm3(tx, ty, tz) > 1e-12 * (vl > 1 ? vl : 1))) {
    tx = -uy; ty = ux; tz = 0                                                // ẑ_ecef × r̂ = 当地正东
    if (!(norm3(tx, ty, tz) > 1e-12)) { tx = 1 - ux * ux; ty = -ux * uy; tz = -ux * uz }
  }
  const tl = norm3(tx, ty, tz)
  const xx = tx / tl, xy = ty / tl, xz = tz / tl                           // x̂（ECEF）
  const zx = xy * uz - xz * uy, zy = xz * ux - xx * uz, zz = xx * uy - xy * ux   // ẑ = x̂ × ŷ
  // 列轴转场景轴后的 3×3（与 lvlhQuatScene → quatFromM 的实参次序一一对应），Shepperd 法
  const m00 = xx, m01 = ux, m02 = zx, m10 = xz, m11 = uz, m12 = zz, m20 = -xy, m21 = -uy, m22 = -zy
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
  const l = Math.sqrt(x * x + y * y + z * z + w * w) * (w < 0 ? -1 : 1)
  out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = w / l
  return out
}

// Hamilton 积 a ⊗ b：与 attitude.quatMul 同式同求值次序（逐位一致）。本地一份是为了取数点只见普通数组——attitude.quatMul 的取数点
// 被冻结常量（Q_BODY2L_NADIR 是 PACKED_FROZEN 元素）和别处的各种数组撑成 megamorphic 后每取一个 double 都装箱（实测 ≈ 250 B / 次）。
function qmul(a, b, out) {
  const x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1]
  const y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0]
  const z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3]
  const w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  out[0] = x; out[1] = y; out[2] = z; out[3] = w
  return out
}
// Q_BODY2L_NADIR 的普通数组副本（值逐位相同；不让冻结数组流进 qmul 的取数点）
const _QN = [Q_BODY2L_NADIR[0], Q_BODY2L_NADIR[1], Q_BODY2L_NADIR[2], Q_BODY2L_NADIR[3]]
const _qr = [0, 0, 0, 1]
// 姿态核心的入参暂存：[lat, lon, 航向, 俯仰, 滚转]（度；航向 / 俯仰 / 滚转非有限已折成 0）。导出函数写好再调核心——
// double 不当实参在内部函数之间传（未内联的调用边界会装箱）。lat / lon 用一元 + 存：与原来 latDeg * D2R 的 ToNumber 同一结果。
const _pp = [0, 0, 0, 0, 0]
// 本体 → L（俯仰 / 滚转取 _pp[3] / _pp[4]）
function bodyQuatLInto(out) {
  const th = _pp[3] * D2R / 2, ph = _pp[4] * D2R / 2
  if (th === 0 && ph === 0) { out[0] = _QN[0]; out[1] = _QN[1]; out[2] = _QN[2]; out[3] = _QN[3]; return out }
  // q(Y, θ) ⊗ q(X, φ) = [cosθ·sinφ, sinθ·cosφ, −sinθ·sinφ, cosθ·cosφ]（半角），再左乘常量
  const st = Math.sin(th), ct = Math.cos(th), sp = Math.sin(ph), cp = Math.cos(ph)
  _qr[0] = ct * sp; _qr[1] = st * cp; _qr[2] = -st * sp; _qr[3] = ct * cp
  return qmul(_QN, _qr, out)
}
// 实体姿态核心（入参取 _pp）
function poseInto(o) {
  const p = _pp[0] * D2R, l = _pp[1] * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l)
  const hd = _pp[2] * D2R, c = Math.cos(hd), s = Math.sin(hd)
  set3(o.upEcef, cp * cl, cp * sl, sp)
  set3(o.fwdEcef, -c * sp * cl - s * sl, -c * sp * sl + s * cl, c * cp)
  lvlhQuatSceneInto(o.upEcef, o.fwdEcef, o.qL2S)                           // = attitude.lvlhQuatScene(upEcef, fwdEcef)，零分配
  bodyQuatLInto(o.qB2L)
  qmul(o.qL2S, o.qB2L, o.qB2S)
  return o
}

/**
 * 本体 → L：Q_BODY2L_NADIR ⊗ q(Y_B, θ) ⊗ q(X_B, φ)。θ = φ = 0 时逐位等于 Q_BODY2L_NADIR。
 * @param {number} pitchDeg  抬头为正
 * @param {number} rollDeg   右翼下沉为正
 */
export function bodyQuatL(pitchDeg, rollDeg, out = [0, 0, 0, 1]) {
  _pp[3] = fin(pitchDeg) ? pitchDeg : 0; _pp[4] = fin(rollDeg) ? rollDeg : 0
  return bodyQuatLInto(out)
}

/**
 * 实体在 (lat, lon) 以航向 / 俯仰 / 滚转摆放时的姿态（DESIGN3 E9）。
 * @param {number} latDeg / lonDeg  大地纬经（度）
 * @param {number} headingDeg       航向（度，正北起顺时针）；地球站按 NED 传 0，整体转方位时传罗盘方位
 * @param {number} [pitchDeg]       俯仰（度）：航迹角，trajKinematics 给
 * @param {number} [rollDeg]        滚转（度）
 * @param {object} [out]            makeEntityPose() 的容器（零分配）
 */
export function entityPoseAt(latDeg, lonDeg, headingDeg, pitchDeg, rollDeg, out) {
  _pp[0] = +latDeg; _pp[1] = +lonDeg
  _pp[2] = fin(headingDeg) ? headingDeg : 0; _pp[3] = fin(pitchDeg) ? pitchDeg : 0; _pp[4] = fin(rollDeg) ? rollDeg : 0
  return poseInto(out || makeEntityPose())
}
/** 载具姿态：trajKinematics.trajStateAt 的结果直接喂（滚转恒 0：航段是大圆，转弯只发生在航点上、没有有限转弯率）。 */
export function vehiclePoseAt(state, out) {
  const hd = state.headingDeg, pt = state.pitchDeg
  _pp[0] = +state.lat; _pp[1] = +state.lon; _pp[2] = fin(hd) ? hd : 0; _pp[3] = fin(pt) ? pt : 0; _pp[4] = 0
  return poseInto(out || makeEntityPose())
}
/** 地球站基座姿态（NED）：entityPoseAt(lat, lon, 0, 0, 0)。 */
export function stationPoseAt(latDeg, lonDeg, out) { return entityPoseAt(latDeg, lonDeg, 0, 0, 0, out) }

/**
 * 本体三轴在标准 ECEF 下的单位矢量 {X, Y, Z}（直接由 航向 / 俯仰 / 滚转 定义式构造，不经四元数——单测拿它对拍 qB2S）：
 *   h = 航向水平单位矢量、ρ = 航向右侧 = cosψ·E − sinψ·N、U = 天顶
 *   俯仰：X₁ = cosθ·h + sinθ·U，Z₁ = sinθ·h − cosθ·U，Y₁ = ρ
 *   滚转：Y = cosφ·Y₁ + sinφ·Z₁，Z = −sinφ·Y₁ + cosφ·Z₁，X = X₁
 * 地球站（航向 0、俯仰 0、滚转 0）即 NED：X = N、Y = E、Z = −U。
 */
export function bodyBasisEcef(latDeg, lonDeg, headingDeg, pitchDeg, rollDeg, out) {
  const o = out || { X: [0, 0, 0], Y: [0, 0, 0], Z: [0, 0, 0] }
  const p = latDeg * D2R, l = lonDeg * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l)
  const Ex = -sl, Ey = cl, Ez = 0, Nx = -sp * cl, Ny = -sp * sl, Nz = cp, Ux = cp * cl, Uy = cp * sl, Uz = sp
  const hd = (fin(headingDeg) ? headingDeg : 0) * D2R, c = Math.cos(hd), s = Math.sin(hd)
  const hx = c * Nx + s * Ex, hy = c * Ny + s * Ey, hz = c * Nz + s * Ez
  const rx = c * Ex - s * Nx, ry = c * Ey - s * Ny, rz = c * Ez - s * Nz
  const th = (fin(pitchDeg) ? pitchDeg : 0) * D2R, ct = Math.cos(th), st = Math.sin(th)
  const ph = (fin(rollDeg) ? rollDeg : 0) * D2R, cph = Math.cos(ph), sph = Math.sin(ph)
  const z1x = st * hx - ct * Ux, z1y = st * hy - ct * Uy, z1z = st * hz - ct * Uz
  set3(o.X, ct * hx + st * Ux, ct * hy + st * Uy, ct * hz + st * Uz)
  set3(o.Y, cph * rx + sph * z1x, cph * ry + sph * z1y, cph * rz + sph * z1z)
  set3(o.Z, -sph * rx + cph * z1x, -sph * ry + cph * z1y, -sph * rz + cph * z1z)
  return o
}

// ─────────────────────────────── 地球站对星 ───────────────────────────────

/** 地球站挂点系（本体 NED 分量，attitude.mountFrame 口径）：z = 北（方位零位视轴）、y = 天顶（方位轴）、x = y × z = 西。 */
export const STATION_MOUNT = Object.freeze({ x: Object.freeze([0, -1, 0]), y: Object.freeze([0, 0, -1]), z: Object.freeze([1, 0, 0]) })

/**
 * 空读数容器：
 *   azDeg      罗盘方位（度，[0, 360)，正北起顺时针）
 *   elDeg      仰角（度，朝天为正）
 *   rangeKm    斜距（km；stationAimScene 里是场景距离 × 6371）
 *   a1Deg/a2Deg gimbal.solveAzEl 在 STATION_MOUNT 下的主解（a1 = −罗盘方位 折到 (−180, 180]、a2 = 仰角）；驱动方位 / 俯仰关节用
 *   singular   视线 ∥ 天顶（keyhole）：方位取上一次的 a1（复用 out 即连续）
 *   visible    elDeg ≥ 0
 *   dir        单位视线（stationTrackAzEl：ECEF；stationAimScene：场景轴）
 */
export function makeStationLook() {
  return { azDeg: 0, elDeg: 0, rangeKm: 0, a1Deg: NaN, a2Deg: 0, singular: false, visible: false, dir: [0, 0, 0] }
}
const _st = [0, 0, 0], _de = [0, 0, 0], _dm = [0, 0, 0], _sol = { a1: 0, a2: 0, singular: false }, _sa = [0, 0, 0], _ta = [0, 0, 0]
const stHKm = (st) => (fin(st.altM) ? st.altM / 1000 : 0)

// ★ 下面三个私有函数是 geodeticToEcefKm / ecefToGeodetic / sceneAnchor 的逐字复写（同式、同求值次序，结果逐位相同），只是改成
//   从对象取数、写进暂存：站 / 星的 double 不当实参往外传（未内联的调用边界会装箱，每个 16 B）。改那三个导出函数要同步改这里。
// 站址 → WGS-84 ECEF（km）
function stationEcefInto(st, out) {
  const p = st.lat * D2R, l = st.lon * D2R, sp = Math.sin(p), cp = Math.cos(p)
  const N = WGS84_A_KM / Math.sqrt(1 - WGS_E2 * sp * sp), h = stHKm(st)
  out[0] = (N + h) * cp * Math.cos(l); out[1] = (N + h) * cp * Math.sin(l); out[2] = (N * (1 - WGS_E2) + h) * sp
  return out
}
// 站址 → 场景锚点（sceneAnchor(lat, lon, altM / 1000)）
function stationAnchorInto(st, out) {
  const r = (SCENE_RE_KM + stHKm(st)) / SCENE_RE_KM
  const phi = (90 - st.lat) * Math.PI / 180
  const theta = (st.lon + 180) * Math.PI / 180
  out[0] = -r * Math.sin(phi) * Math.cos(theta)
  out[1] = r * Math.cos(phi)
  out[2] = r * Math.sin(phi) * Math.sin(theta)
  return out
}
// 目标 ECEF（km）→ 大地（ecefToGeodetic 同一迭代）→ 场景锚点（sceneAnchor 同式）
function targetAnchorInto(t, out) {
  let x, y, z
  const t0 = t.x                                                            // 取数点本地化、每个分量只取一次（共用取数器被撑开后取 double 会装箱）
  if (t0 !== undefined) { x = t0; y = t.y; z = t.z } else { x = t[0]; y = t[1]; z = t[2] }
  const R = Math.sqrt(x * x + y * y)
  let lat = Math.atan2(z, R), C = 1
  for (let k = 0; k < 20; k++) {
    const s = Math.sin(lat)
    C = 1 / Math.sqrt(1 - WGS_E2 * s * s)
    lat = Math.atan2(z + WGS84_A_KM * C * WGS_E2 * s, R)
  }
  const latDeg = lat * R2D, lonDeg = Math.atan2(y, x) * R2D, hKm = R / Math.cos(lat) - WGS84_A_KM * C
  const r = (SCENE_RE_KM + hKm) / SCENE_RE_KM
  const phi = (90 - latDeg) * Math.PI / 180
  const theta = (lonDeg + 180) * Math.PI / 180
  out[0] = -r * Math.sin(phi) * Math.cos(theta)
  out[1] = r * Math.cos(phi)
  out[2] = r * Math.sin(phi) * Math.sin(theta)
  return out
}

// 视线（ECEF 轴单位矢量，调用方先写进 _de）→ 站址 ENU → 挂点系 → solveAzEl；写 o 的角度字段
function lookFromEcefDir(st, o) {
  const p = st.lat * D2R, l = st.lon * D2R, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l)
  const dx = _de[0], dy = _de[1], dz = _de[2]
  const dE = -sl * dx + cl * dy
  const dN = -sp * cl * dx - sp * sl * dy + cp * dz
  const dU = cp * cl * dx + cp * sl * dy + sp * dz
  _dm[0] = -dE; _dm[1] = dU; _dm[2] = dN                                    // 挂点系分量：x = 西、y = 天顶、z = 北
  // keyhole 沿用上一次方位：不把 o.a1Deg 当 prevA1 实参传（double 实参会装箱），奇异时就地取——与 solveAzEl(_dm, prevA1) 同一结果
  solveAzEl(_dm, undefined, _sol)
  if (!_sol.singular) o.a1Deg = _sol.a1
  else if (!fin(o.a1Deg)) o.a1Deg = 0
  o.a2Deg = _sol.a2; o.singular = _sol.singular
  o.elDeg = _sol.a2
  // 罗盘方位 = −a1 折到 [0, 360)（wrap360 就地展开：返回 double 的小函数没内联时会装箱）；负的微小值 +360 舍入成 360 折回 0，−0 → 0
  const d = -o.a1Deg % 360, w = d < 0 ? d + 360 : d
  o.azDeg = w >= 360 || w === 0 ? 0 : w
  o.visible = o.elDeg >= 0
  return o
}

/**
 * 地球站 → 目标的 WGS-84 读数（方位 / 仰角 / 斜距），经 gimbal.solveAzEl 求角。
 * @param {{lat:number, lon:number, altM?:number}} stationLla  大地纬经（度）、海拔（m，缺省 0）
 * @param {number[]|{x,y,z}} targetEcefKm                      目标 ECEF（km）
 * @param {object} [out] makeStationLook() 的容器（复用即零分配，keyhole 时方位沿用上一次）
 */
export function stationTrackAzEl(stationLla, targetEcefKm, out) {
  const o = out || makeStationLook()
  stationEcefInto(stationLla, _st)
  // 目标分量就地取、每个只取一次（共用取数器被各种形状撑成 megamorphic 后每取一个 double 都装箱）
  const t = targetEcefKm, t0 = t.x
  let dx, dy, dz
  if (t0 !== undefined) { dx = t0 - _st[0]; dy = t.y - _st[1]; dz = t.z - _st[2] } else { dx = t[0] - _st[0]; dy = t[1] - _st[1]; dz = t[2] - _st[2] }
  const r = norm3(dx, dy, dz)
  o.rangeKm = r
  if (!(r > 0) || !fin(r)) { o.elDeg = NaN; o.azDeg = NaN; o.a2Deg = NaN; o.visible = false; o.singular = false; set3(o.dir, NaN, NaN, NaN); return o }
  set3(o.dir, dx / r, dy / r, dz / r)
  set3(_de, dx / r, dy / r, dz / r)
  return lookFromEcefDir(stationLla, o)
}

/**
 * 画面口径的站 → 星视线：星场景锚点 − 站场景锚点（都是 llaToVec(大地纬, 经, 高) 球面口径），再在站址当地 ENU 里求 az / el。
 * 碟面按这组角摆，视轴就正对画出来的那颗星；缺省锚点下角度与 stationTrackAzEl 差 ≤ 0.2°（锚点抬高后变大，见文件头）。
 * @param {{lat:number, lon:number, altM?:number}} stationLla
 * @param {number[]|{x,y,z}} targetEcefKm
 * @param {object} [out]            makeStationLook() 的容器；dir 为场景轴单位视线、rangeKm = 场景距离 × 6371
 * @param {number[]|{x,y,z}} [stationAnchor] 站的场景锚点：数组、THREE.Vector3（mesh.position）、{x,y,z} 都认；
 *                                  缺省 / 非有限 → sceneAnchor(lat, lon, altM/1000)。图层把模型沿天顶抬过的话传实际锚点
 */
export function stationAimScene(stationLla, targetEcefKm, out, stationAnchor) {
  const o = out || makeStationLook()
  let ax = NaN, ay = NaN, az = NaN
  if (stationAnchor) {                                                       // 数组 / THREE.Vector3 / {x,y,z} 都认；分量就地各取一次
    const a0 = stationAnchor.x
    if (a0 !== undefined) { ax = a0; ay = stationAnchor.y; az = stationAnchor.z } else { ax = stationAnchor[0]; ay = stationAnchor[1]; az = stationAnchor[2] }
  }
  if (!(fin(ax) && fin(ay) && fin(az))) {
    stationAnchorInto(stationLla, _sa)
    ax = _sa[0]; ay = _sa[1]; az = _sa[2]
  }
  targetAnchorInto(targetEcefKm, _ta)
  const sx = _ta[0] - ax, sy = _ta[1] - ay, sz = _ta[2] - az
  const r = norm3(sx, sy, sz)
  o.rangeKm = r * SCENE_RE_KM
  if (!(r > 0) || !fin(r)) { o.elDeg = NaN; o.azDeg = NaN; o.a2Deg = NaN; o.visible = false; o.singular = false; set3(o.dir, NaN, NaN, NaN); return o }
  set3(o.dir, sx / r, sy / r, sz / r)
  set3(_de, sx / r, -sz / r, sy / r)                                        // 场景轴 → ECEF：(x, −z, y)
  return lookFromEcefDir(stationLla, o)
}
