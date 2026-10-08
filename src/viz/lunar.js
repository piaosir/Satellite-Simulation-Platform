// 月球几何（地图设置 · 宇宙空间 · 月球）：地心视位置、月面自转姿态（含天平动）、照亮比例、地影 —— 渲染端 ESM。
// 与 terminator.js 同一套口径：时刻全程 UTC（Date 内部本就是 UTC 毫秒，时区不介入）、地球自转相位复用 sat.gstime()
// —— 与卫星星位、日下点、星空同一个函数，月球与轨道圈 / 晨昏线叠在一张图上才对得上。
//
// ── 位置：Meeus《Astronomical Algorithms》2nd ed. 第 47 章（ELP-2000/82 截断，黄经 60 项 + 黄纬 60 项）──
// Meeus 给的精度是黄经约 10″、黄纬约 4″；对 JPL Horizons（DE441）实测见 packages/core/test/lunar.test.mjs。
// 渲染端不能镜像 packages/core 的 CJS，且要随时间轴每拍重算、不能走 IPC —— 与太阳（terminator.js）同一理由自带一份。
// ★ 月球必须用 TT（太阳那边用 UT 只错 3e-5°，月球不行）：月球视运动 0.55″/s，TT − UTC ≈ 69 s 不加就错 38″
//   ≈ 月面直径的 2%。这里取 TT − UTC = 32.184 s + 闰秒 37 s（2017-01-01 起至今无新增）；2017 年以前的时刻差几秒、位置差 ≤ 3″。
// 视位置 = 几何黄经 + 章动 Δψ（Meeus 第 22 章低精度式，0.5″）；光行时与光行差合计不到 1″（月球随地球一起走），不做。
//
// ── 地固系与场景 ──
// 真赤道真春分点（of date）→ 地固：绕 z 转 GAST = GMST + Δψ·cos ε。GMST 取 sat.gstime(UT)（UT1 ≈ UTC，差 ≤ 0.9 s）。
// 场景轴（scene.js）= ECEF (X, Z, −Y)、单位 = 地球平均半径 6371 km —— 转换在调用方（spaceFx / scene），本模块只出 ECEF km。
//
// ── 姿态：IAU WGCCRE 2009 月球自转模型（Archinal et al. 2011, Table 2）──
// 给出月面「平均地球 / 极轴」(ME) 系在 ICRF 中的极向 α0、δ0 与本初子午线角 W —— 与 LRO 全部制图产品（含本平台的月面贴图）同一个系，
// 与 DE 星历的 ME 系相差约 150 m（≈ 0.005°）。光学天平动（经向 ±7.9°、纬向 ±6.7°）就是它与轨道几何合成出来的，不另算。
// ICRF → 真赤道真春分点：IAU 1976 岁差（Lieske）+ 低精度章动；26 年岁差约 0.36°（月面上 11 km），不能省。
// 星空（spaceFx）的星位也在 ICRF，走同一条链（icrfToEcef）：整天球偏 0.36° 单看星空看不出，但月球是按真赤道 of date 摆的，
// 两边不同链时月掩星（月掩昴星团 / 毕宿五 / 轩辕十四）会错开大半个月面（月面直径才 0.52°）。
import sat from './constellation/satellite.js'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI
export const MOON_R_KM = 1737.4            // LRO 参考球（贴图 / 高程同一个）
export const EARTH_EQ_KM = 6378.137
export const SUN_R_KM = 695700             // IAU 2015 B3 名义太阳半径
export const AU_KM = 149597870.7
export const TT_MINUS_UTC_S = 69.184
// 地影：地球半径按 Danjon（1951）放大 1/85 计入大气层（NASA 月食表同一口径），本影 / 半影边界都由它定
export const EARTH_SHADOW_KM = EARTH_EQ_KM * (1 + 1 / 85)

const norm360 = (x) => ((x % 360) + 360) % 360
const wrap180 = (x) => ((x + 180) % 360 + 360) % 360 - 180

/** UTC 时刻 → { jd (UT), jde (TT), T (TT 儒略世纪) } */
export function timeArgs(date) {
  const ms = date instanceof Date ? date.getTime() : Number(date)
  const jd = ms / 86400000 + 2440587.5
  const jde = jd + TT_MINUS_UTC_S / 86400
  return { jd, jde, T: (jde - 2451545.0) / 36525 }
}

// Meeus 表 47.A：D, M, M′, F 的倍数，Σl 系数（1e-6°，正弦），Σr 系数（1e-3 km，余弦）
const LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149], [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733], [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210], [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056], [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0], [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897], [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0], [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0], [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0], [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165], [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752]
]
// Meeus 表 47.B：D, M, M′, F 的倍数，Σb 系数（1e-6°，正弦）
const BT = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283], [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185], [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166], [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107]
]

/**
 * 月心几何黄经 / 黄纬（平黄道、平春分点 of date）与地月距离 —— Meeus 47 原式，未加章动。
 * @param {number} T TT 儒略世纪（J2000 起）
 * @returns {{lambda:number, beta:number, distKm:number, sl:number, sb:number, sr:number, Lp:number, D:number, M:number, Mp:number, F:number, E:number}}
 */
export function moonEcliptic(T) {
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T
  const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000)
  const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000)
  const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000)
  const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000)
  const F = norm360(93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000)
  const A1 = 119.75 + 131.849 * T, A2 = 53.09 + 479264.290 * T, A3 = 313.45 + 481266.484 * T
  const E = 1 - 0.002516 * T - 0.0000074 * T2
  const ecc = [1, E, E * E]
  let sl = 0, sr = 0, sb = 0
  for (let i = 0; i < LR.length; i++) {
    const t = LR[i], a = (t[0] * D + t[1] * M + t[2] * Mp + t[3] * F) * D2R, e = ecc[Math.abs(t[1])]
    sl += t[4] * e * Math.sin(a)
    sr += t[5] * e * Math.cos(a)
  }
  for (let i = 0; i < BT.length; i++) {
    const t = BT[i], a = (t[0] * D + t[1] * M + t[2] * Mp + t[3] * F) * D2R
    sb += t[4] * ecc[Math.abs(t[1])] * Math.sin(a)
  }
  sl += 3958 * Math.sin(A1 * D2R) + 1962 * Math.sin((Lp - F) * D2R) + 318 * Math.sin(A2 * D2R)
  sb += -2235 * Math.sin(Lp * D2R) + 382 * Math.sin(A3 * D2R) + 175 * Math.sin((A1 - F) * D2R) + 175 * Math.sin((A1 + F) * D2R) +
    127 * Math.sin((Lp - Mp) * D2R) - 115 * Math.sin((Lp + Mp) * D2R)
  return { lambda: norm360(Lp + sl / 1e6), beta: sb / 1e6, distKm: 385000.56 + sr / 1000, sl, sb, sr, Lp, D, M, Mp, F, E }
}

/** 章动（Meeus 第 22 章低精度式：Δψ 0.5″、Δε 0.1″）与黄赤交角，单位度 */
export function nutation(T) {
  const Om = (125.04452 - 1934.136261 * T + 0.0020708 * T * T + T * T * T / 450000) * D2R
  const L = (280.4665 + 36000.7698 * T) * D2R, Lm = (218.3165 + 481267.8813 * T) * D2R
  const dpsi = (-17.20 * Math.sin(Om) - 1.32 * Math.sin(2 * L) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * Om)) / 3600
  const deps = (9.20 * Math.cos(Om) + 0.57 * Math.cos(2 * L) + 0.10 * Math.cos(2 * Lm) - 0.09 * Math.cos(2 * Om)) / 3600
  const eps0 = 23 + 26 / 60 + (21.448 - 46.8150 * T - 0.00059 * T * T + 0.001813 * T * T * T) / 3600
  return { dpsi, deps, eps0, eps: eps0 + deps }
}

/**
 * 月球地心视位置（真赤道、真春分点 of date）与地固坐标。
 * @param {Date|number} date UTC 时刻
 * @returns {{raDeg:number, decDeg:number, distKm:number, gast:number, ecef:number[], sub:{lat:number, lon:number}, T:number, nut:object}}
 *   gast：格林尼治视恒星时（rad）；ecef：地固系 km（x 指本初子午线、z 指北极）；sub：月下点（地心纬度 / 经度，°）
 */
export function moonPosition(date) {
  const d = date instanceof Date ? date : new Date(date)
  const { T } = timeArgs(d)
  const m = moonEcliptic(T)
  const nut = nutation(T)
  const lam = (m.lambda + nut.dpsi) * D2R, bet = m.beta * D2R, eps = nut.eps * D2R
  const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam))
  const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam))
  const gast = sat.gstime(d) + nut.dpsi * D2R * Math.cos(eps)
  const xt = m.distKm * Math.cos(dec) * Math.cos(ra), yt = m.distKm * Math.cos(dec) * Math.sin(ra), zt = m.distKm * Math.sin(dec)
  const cg = Math.cos(gast), sg = Math.sin(gast)
  return {
    raDeg: norm360(ra * R2D), decDeg: dec * R2D, distKm: m.distKm, gast,
    ecef: [cg * xt + sg * yt, -sg * xt + cg * yt, zt],
    sub: { lat: dec * R2D, lon: wrap180((ra - gast) * R2D) },
    T, nut
  }
}

// ── 3×3 矩阵（行主序，长度 9 的数组）与主动旋转 ──
const mul = (a, b) => {
  const o = new Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return o
}
const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c] }
const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c] }
const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1] }

/** IAU WGCCRE 2009 月球自转参数（°）：d = TT 起算日数（J2000），T = 儒略世纪 */
export function moonIauAngles(d, T) {
  const E = (a, b) => (a + b * d) * D2R
  const E1 = E(125.045, -0.0529921), E2 = E(250.089, -0.1059842), E3 = E(260.008, 13.0120009), E4 = E(176.625, 13.3407154)
  const E5 = E(357.529, 0.9856003), E6 = E(311.589, 26.4057084), E7 = E(134.963, 13.0649930), E8 = E(276.617, 0.3287146)
  const E9 = E(34.226, 1.7484877), E10 = E(15.134, -0.1589763), E11 = E(119.743, 0.0036096), E12 = E(239.961, 0.1643573)
  const E13 = E(25.053, 12.9590088)
  const s = Math.sin, c = Math.cos
  const a0 = 269.9949 + 0.0031 * T - 3.8787 * s(E1) - 0.1204 * s(E2) + 0.0700 * s(E3) - 0.0172 * s(E4) + 0.0072 * s(E6) - 0.0052 * s(E10) + 0.0043 * s(E13)
  const d0 = 66.5392 + 0.0130 * T + 1.5419 * c(E1) + 0.0239 * c(E2) - 0.0278 * c(E3) + 0.0068 * c(E4) - 0.0029 * c(E6) + 0.0009 * c(E7) + 0.0008 * c(E10) - 0.0009 * c(E13)
  const W = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * s(E1) + 0.1208 * s(E2) - 0.0642 * s(E3) + 0.0158 * s(E4) + 0.0252 * s(E5) -
    0.0066 * s(E6) - 0.0047 * s(E7) - 0.0046 * s(E8) + 0.0028 * s(E9) + 0.0052 * s(E10) + 0.0040 * s(E11) + 0.0019 * s(E12) - 0.0044 * s(E13)
  return { a0, d0, W }
}

/**
 * 月面固连系（ME：x 指本初子午线 0°、y 指东经 90°、z 指北极）→ 地固系（ECEF）的旋转矩阵（行主序 3×3）。
 * 链路：月面 → ICRF（IAU 极向 + W）→ 平赤道 of date（IAU 1976 岁差）→ 真赤道（章动）→ 地固（GAST）。
 * @param {Date|number} date UTC 时刻
 * @param {{T:number, nut:object, gast:number}} [pos] 同一时刻 moonPosition 的结果（给了就不重算章动 / 恒星时）
 */
export function moonBodyToEcef(date, pos) {
  const p = pos || moonPosition(date)
  const T = p.T, d = T * 36525
  const { a0, d0, W } = moonIauAngles(d, T)
  const body2icrf = mul(rotZ((a0 + 90) * D2R), mul(rotX((90 - d0) * D2R), rotZ(W * D2R)))
  return mul(rotZ(-p.gast), mul(nutationMatrix(p.nut), mul(precessionMatrix(T), body2icrf)))
}

/** IAU 1976 岁差（Lieske 1977）：J2000 平赤道 → 平赤道 of date（行主序 3×3）。T = TT 儒略世纪 */
export function precessionMatrix(T) {
  const as = (x) => x / 3600 * D2R
  const zeta = as(2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T)
  const z = as(2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T)
  const th = as(2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T)
  return mul(rotZ(z), mul(rotY(-th), rotZ(zeta)))
}
/** 章动（nutation(T) 的结果）：平赤道 → 真赤道 of date（行主序 3×3） */
export function nutationMatrix(nut) {
  return mul(rotX(nut.eps * D2R), mul(rotZ(nut.dpsi * D2R), rotX(-nut.eps0 * D2R)))
}
/**
 * ICRF → 地固系（ECEF）的旋转矩阵（行主序 3×3）：岁差 + 章动 + GAST —— 就是 moonBodyToEcef 那条链去掉月面姿态那一节。
 * 星空（spaceFx）用它把 ICRF 星位转进地固系：恒星、月球、卫星同一个时刻、同一套地球指向，月掩星的时刻与位置才对得上。
 * @param {Date|number} date UTC 时刻
 * @param {number} [gmst] 同一时刻的 sat.gstime（调用方已算过就传进来，不重算）
 */
export function icrfToEcef(date, gmst) {
  const d = date instanceof Date ? date : new Date(date)
  const { T } = timeArgs(d)
  const nut = nutation(T)
  const gast = (Number.isFinite(gmst) ? gmst : sat.gstime(d)) + nut.dpsi * D2R * Math.cos(nut.eps * D2R)
  return mul(rotZ(-gast), mul(nutationMatrix(nut), precessionMatrix(T)))
}

/** 地固系里一个方向（从月心出发）→ 月面经纬度（°，东经为正） */
export function ecefDirToSeleno(M, v) {
  // M 是正交阵：body = Mᵀ · ecef
  const x = M[0] * v[0] + M[3] * v[1] + M[6] * v[2]
  const y = M[1] * v[0] + M[4] * v[1] + M[7] * v[2]
  const zz = M[2] * v[0] + M[5] * v[1] + M[8] * v[2]
  const r = Math.hypot(x, y, zz)
  return { lon: Math.atan2(y, x) * R2D, lat: Math.asin(zz / r) * R2D }
}

/**
 * 月相：日月角距 ψ（地心看）、相位角 i（月心看日地夹角，Meeus 48.3）、照亮比例 k = (1 + cos i) / 2、是否上半月（盈）。
 * @param {number[]} moonEcef 月心地固坐标 km
 * @param {number[]} sunDir 太阳方向（地固系单位矢量）
 * @param {number} [sunKm] 日地距离 km（缺省 1 AU；±1.7% 的出入对相位角的影响 < 0.003°）
 */
export function moonPhase(moonEcef, sunDir, sunKm = AU_KM) {
  const dm = Math.hypot(moonEcef[0], moonEcef[1], moonEcef[2])
  const cpsi = Math.max(-1, Math.min(1, (moonEcef[0] * sunDir[0] + moonEcef[1] * sunDir[1] + moonEcef[2] * sunDir[2]) / dm))
  const psi = Math.acos(cpsi)
  const i = Math.atan2(sunKm * Math.sin(psi), dm - sunKm * cpsi)
  // 盈亏：月球在太阳以东（沿地球自转 / 公转正向领先）为盈。地固系里看「太阳 × 月球」与北极 z 同向即月在日东（赤经更大）
  const cz = sunDir[0] * moonEcef[1] - sunDir[1] * moonEcef[0]
  return { elongDeg: psi * R2D, phaseDeg: i * R2D, illum: (1 + Math.cos(i)) / 2, waxing: cz > 0 }
}

/** 两个小圆（角半径 r1、r2，圆心角距 d，弧度）重叠面积（平面近似，半径都在 1° 量级，误差 < 1e-4） */
export function discOverlap(r1, r2, d) {
  if (d >= r1 + r2) return 0
  const rmin = Math.min(r1, r2)
  if (d <= Math.abs(r1 - r2)) return Math.PI * rmin * rmin
  const a1 = Math.acos(Math.max(-1, Math.min(1, (d * d + r1 * r1 - r2 * r2) / (2 * d * r1))))
  const a2 = Math.acos(Math.max(-1, Math.min(1, (d * d + r2 * r2 - r1 * r1) / (2 * d * r2))))
  const k = Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
  return r1 * r1 * a1 + r2 * r2 * a2 - 0.5 * Math.sqrt(k)
}

/**
 * 地影：空间一点看太阳，日面还露出多少（1 = 全露 … 0 = 全被地球挡住，即本影）。
 * 地球按 EARTH_SHADOW_KM（Danjon 放大）算；太阳方向取地心方向（从月球处看偏 0.15°，对本影位置的影响只是它的 1/390）。
 * ★ spaceFx.js 月球着色器里的 earthShadow() 是同一个式子的 GLSL 版，两边改动要同步（测试只能钉 JS 这份）。
 * @param {number[]} p 该点地固坐标 km
 * @param {number[]} sunDir 太阳方向（单位矢量）
 * @param {number} [sunKm] 日地距离 km
 */
export function earthShadowFraction(p, sunDir, sunKm = AU_KM) {
  const d = Math.hypot(p[0], p[1], p[2])
  if (!(d > EARTH_SHADOW_KM)) return 0
  const rE = Math.asin(EARTH_SHADOW_KM / d), rS = Math.asin(SUN_R_KM / sunKm)
  const ce = -(p[0] * sunDir[0] + p[1] * sunDir[1] + p[2] * sunDir[2]) / d   // 该点看地心方向（−p̂）与太阳方向夹角的余弦
  const gam = Math.acos(Math.max(-1, Math.min(1, ce)))
  return 1 - discOverlap(rS, rE, gam) / (Math.PI * rS * rS)
}

/** 日地距离（km，Meeus 第 25 章低精度：真近点角 + 偏心率），给地影与相位角用 */
export function sunDistanceKm(date) {
  const { T } = timeArgs(date instanceof Date ? date : new Date(date))
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * D2R
  const C = ((1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M)) * D2R
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T
  return 1.000001018 * (1 - e * e) / (1 + e * Math.cos(M + C)) * AU_KM
}
