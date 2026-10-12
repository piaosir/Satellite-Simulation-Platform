// 卫星状态的几种表示 —— 信息栏「状态矢量 / 密切根数 / 同步轨道 / 相对状态」与视频叠加共用的单一真值源（纯数学）。
//
// 输入一律是取位入口（渲染端 satPos.posAt）给出的 TEME 位置 / 速度（km、km/s）。本模块不传播轨道、不碰 satrec
// （唯一例外 kozaiMeanMotion：只读 satrec 的三项初值），换帧全走 refFrames.js（core frames.js 的逐位镜像）。
//
//   stateVector(pv, frame, ctx)        直角状态矢量：FIXED（地固 ECEF）/ J2000 / TEME（/ TOD / MOD）
//   oscElements(r, v)                  密切根数（二体，r / v 所在惯性系）：经典六根数 + 纬度幅角 + 真经度 + 平经度 + 两个矢量
//   syncElements(sample, tMs, span)    同步轨道参数：一个恒星日窗口内的平均 —— 平经度 / 漂移率 / 偏心率矢量 / 倾角矢量
//   relState(rp, vp, rs, vs)           相对状态：目标相对参考星，参考星的 RIC 系（R 径向 / I 沿迹 / C 轨道面法向）
//   kozaiMeanMotion(rec)               satrec.no（SGP4 初始化后的 Brouwer 平均运动）→ TLE / OMM 原文里的 Kozai 平均运动
//
// 【角度口径】全部 atan2 取值（acos 在 0 / π 附近丢精度），区间 [0, 2π)；倾角 [0, π]。
//   奇异处不编数：近赤道（sin i < SING）升交点赤经 / 纬度幅角为 NaN，近圆（e < SING）近地点幅角 / 真近点角为 NaN；
//   真经度、平经度、两个矢量在奇异处照样有定义（GEO 读的就是它们）。
// 【同步轨道参数口径】对标 STK「GEO Station Keeping Elements」：轴系取赤道 of date（这里是 TEME —— 与平台
//   TEME→ECEF 只转 GMST 的口径配套，平经度减 GMST 即与地图上的星下点经度同一参考）；偏心率矢量
//   (eₓ, e_y) = e·(cos ϖ, sin ϖ)，ϖ = Ω + ω；倾角矢量 (iₓ, i_y) = i·(cos Ω, sin Ω)（沿交线指向升交点，模 = 倾角）。
//   与 STK 的差别：STK 报的是此刻的密切值；这里取一个恒星日窗口的平均 —— GEO 密切偏心率里有一个 J₂ 引起、
//   随卫星绕转的 3.7e-5 分量（与受控 GEO 的 1e-4 同量级），平均掉才是位置保持关心的那个矢量；漂移率同理
//   由窗口内平经度的最小二乘斜率给出（含 J₂ 长期项与共振项，比二体公式 −1.5·Δa/a·ω⊕ 准）。

import * as F from './refFrames.js'
import { ecefToGeodetic } from '../viz/wgs84.js'

export const MU = 398600.4418           // 地心引力常数 km³/s²（与 shared/orbitClass.js、viz/wgs84.js 同源）
export const RE = 6378.137
const TWO_PI = 2 * Math.PI
const DEG = Math.PI / 180
const SING = 1e-11                      // 奇异判据（sin i 与 e）：只挡真奇异，近奇异照算（GEO e~1e-4、i~0.05° 都有确定值）
// 恒星日（ms）：satellite.js gstime 的恒星时速率 1.00273790935 圈 / 太阳日 —— 窗口取整一个恒星日，GEO 的日周期项正好平均掉
export const SIDEREAL_DAY_MS = 86400000 / 1.00273790935

export const SV_FRAMES = ['FIXED', 'J2000', 'TEME']   // 信息栏「状态矢量」可选参考系（显示名 ECEF / J2000 / TEME）
export const OSC_FRAMES = ['J2000', 'TEME']           // 「密切根数」只认惯性系（地固系里的二体根数没有意义）

const wrap2pi = (a) => { const r = a % TWO_PI; return r < 0 ? r + TWO_PI : r }
const wrapPi = (a) => wrap2pi(a + Math.PI) - Math.PI
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const norm = (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const fin3 = (a) => !!a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)

// 换帧上下文（同一时刻的 TT 世纪数 / GMST / 章动只算一次）。gstime 由调用方注入（渲染端 / core 各有一份 satellite.js）。
// ★ 必须用 jdFromMs 起 GMST（refFrames.contextAt 就是这么做的）—— 与导出引擎 convertSat 同一条路，读数才与导出文件逐位一致
export const frameContext = (utcMs, gstime) => F.contextAt(utcMs, gstime)

/* ===================== 直角状态矢量 ===================== */
// pv：{ position, velocity }（TEME）。返回 { frame, r, v }（目标帧，km / km·s⁻¹）；地固系速度是相对地球的速度（扣了 ω⊕ × r）
export function stateVector(pv, frame, ctx) {
  if (!pv || !fin3(pv.position) || !fin3(pv.velocity) || !ctx) return null
  const f = F.normFrame(frame) || 'TEME'
  const r = F.fromTeme(pv.position, f, ctx.t, ctx.gmst, ctx.nu)
  const v = F.velFromTeme(pv.velocity, pv.position, f, ctx.t, ctx.gmst, ctx.nu)
  return { frame: f, r, v }
}

// J2000 三根坐标轴此刻在地固系（ECEF）里的方向：3D「参考系」J2000 三轴的逐拍朝向。
// 与卫星位置同一条链（J2000 → MOD → TOD → TEME → GMST → ECEF），轴与星位不会差出一个岁差 / 章动
const BASIS = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]
export function j2000AxesInEcef(ctx) {
  if (!ctx) return null
  return BASIS.map((b) => F.fromTeme(F.toTeme(b, 'J2000', ctx.t, ctx.gmst, ctx.nu), 'FIXED', ctx.t, ctx.gmst, ctx.nu))
}

/* ===================== 密切根数（Vallado rv2coe，角度改 atan2） ===================== */
// r / v 同一惯性系（km、km/s）。返回弧度制；取不到（r × v = 0）返回 null。
//   a 半长轴（抛物线 Infinity、双曲线为负）· e · i · raan Ω · argp ω · nu 真近点角 · u 纬度幅角 · M 平近点角
//   L 真经度（Ω + ω + ν，自 x 轴量）· lamM 平经度（ϖ + M）· lonPeri ϖ · ex/ey 偏心率矢量 · ix/iy 倾角矢量
//   p 半通径 · n 平均运动（rad/s）· T 周期（s）· rp / ra 近 / 远地点地心距 · flags circ / equat
export function oscElements(r, v, mu = MU) {
  if (!fin3(r) || !fin3(v)) return null
  const rm = norm(r), vm = norm(v)
  const h = cross(r, v), hm = norm(h)
  if (!(rm > 0) || !(hm > 0)) return null
  const hu = scale(h, 1 / hm)
  const rdotv = dot(r, v)
  const ev = scale(sub(scale(r, vm * vm - mu / rm), scale(v, rdotv)), 1 / mu)   // 偏心率矢量（指向近地点）
  const e = norm(ev)
  const energy = vm * vm / 2 - mu / rm
  const a = Math.abs(energy) > 1e-14 ? -mu / (2 * energy) : Infinity
  const p = hm * hm / mu
  const sinI = Math.hypot(hu.x, hu.y)
  const i = Math.atan2(sinI, hu.z)
  const circ = e < SING, equat = sinI < SING
  // 交线方向 n̂ = ẑ × ĥ（指向升交点）
  const nu_ = equat ? null : { x: -hu.y / sinI, y: hu.x / sinI, z: 0 }
  const ang = (from, to) => wrap2pi(Math.atan2(dot(hu, cross(from, to)), dot(from, to)))   // 轨道面内自 from 量到 to（沿运动方向为正）
  const rhat = scale(r, 1 / rm)
  const ehat = circ ? null : scale(ev, 1 / e)
  const raan = equat ? NaN : wrap2pi(Math.atan2(hu.x, -hu.y))
  const argp = circ || equat ? NaN : ang(nu_, ehat)
  const nu = circ ? NaN : ang(ehat, rhat)
  const u = equat ? NaN : ang(nu_, rhat)
  // 春分点方向基矢 f̂ / ĝ（Walker 1985：k = tan(i/2)·sinΩ、h = tan(i/2)·cosΩ）—— i→0 时就是 x̂ / ŷ，GEO 的矢量量都在这上面取
  let ex = NaN, ey = NaN, L = NaN
  if (hu.z > -1 + 1e-9) {
    const kq = hu.x / (1 + hu.z), hq = -hu.y / (1 + hu.z), s2 = 1 + kq * kq + hq * hq
    const fh = { x: (1 - kq * kq + hq * hq) / s2, y: 2 * kq * hq / s2, z: -2 * kq / s2 }
    const gh = { x: 2 * kq * hq / s2, y: (1 + kq * kq - hq * hq) / s2, z: 2 * hq / s2 }
    ex = dot(ev, fh); ey = dot(ev, gh)
    L = wrap2pi(Math.atan2(dot(r, gh), dot(r, fh)))
  }
  const lonPeri = circ || !Number.isFinite(ex) ? NaN : wrap2pi(Math.atan2(ey, ex))
  // 平近点角：椭圆走偏近点角，双曲走双曲近点角；近圆按 Vallado 约定取纬度幅角（近赤道取真经度）—— 自交点 / x 轴量的「平」相位
  let M = NaN
  if (circ) M = equat ? L : u
  else if (e < 1) { const E = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu)); M = wrap2pi(E - e * Math.sin(E)) }
  else if (e > 1) { const Fh = Math.asinh(Math.sqrt(e * e - 1) * Math.sin(nu) / (1 + e * Math.cos(nu))); M = e * Math.sinh(Fh) - Fh }
  const lamM = circ ? L : (Number.isFinite(lonPeri) && Number.isFinite(M) && e < 1 ? wrap2pi(lonPeri + M) : NaN)
  // 倾角矢量 i·(cos Ω, sin Ω)：ĥ = (sin i·sinΩ, −sin i·cosΩ, cos i)；i→0 时 i / sin i → 1，不经过 Ω
  const fac = sinI > 1e-15 ? i / sinI : 1
  const ix = -hu.y * fac, iy = hu.x * fac
  const n = a > 0 && Number.isFinite(a) ? Math.sqrt(mu / (a * a * a)) : NaN
  return {
    a, e, i, raan, argp, nu, u, M, L, lamM, lonPeri, ex, ey, ix, iy, p,
    n, T: n > 0 ? TWO_PI / n : NaN,
    rp: e < 1 ? a * (1 - e) : p / (1 + e), ra: e < 1 ? a * (1 + e) : Infinity,
    circ, equat
  }
}

/* ===================== 同步轨道参数（GEO / IGSO） ===================== */
// sample(ms) → { r, v, gmst }（TEME + 同一时刻的 GMST）或 null（该刻取不到位置）。
// 窗口 = 以 tMs 为中心的一个恒星日；span（{t0, t1}，星历点序列星的有效时段）给了就把窗口整段平移进时段，
// 时段不足一个恒星日返回 null（平均不出来，不编数）。窗口内 N 点等间隔（中点法，左右对称）。
// 返回：lonMean 平经度（°，东正，±180）· drift 漂移率（°/d，东漂为正）· e / ex / ey · i / ix / iy（°）·
//       track 窗口内逐点星下点 [{ lon, lat }]（°，大地）· t0 / t1 窗口
export function syncElements(sample, tMs, span, N = 72) {
  if (typeof sample !== 'function' || !Number.isFinite(tMs)) return null
  const W = SIDEREAL_DAY_MS
  let a = tMs - W / 2
  if (span && Number.isFinite(span.t0) && Number.isFinite(span.t1)) {
    if (span.t1 - span.t0 < W) return null
    if (a < span.t0) a = span.t0
    if (a + W > span.t1) a = span.t1 - W
  }
  const dt = W / N
  const xs = new Float64Array(N), ys = new Float64Array(N)
  let sx = 0, sy = 0, sex = 0, sey = 0, six = 0, siy = 0, prev = NaN, acc = 0
  const track = []
  for (let k = 0; k < N; k++) {
    const ms = a + (k + 0.5) * dt
    const s = sample(ms)
    if (!s || !fin3(s.r) || !fin3(s.v) || !Number.isFinite(s.gmst)) return null
    const el = oscElements(s.r, s.v)
    if (!el || !(el.e < 1) || !Number.isFinite(el.lamM) || !Number.isFinite(el.ex)) return null
    // 大地平经度 = 平经度 − GMST，逐点解缠（漂移的星一天可能跨 ±180）
    let lam = wrapPi(el.lamM - s.gmst)
    if (Number.isFinite(prev)) { const d = wrapPi(lam - prev); acc += d } else acc = lam
    prev = lam
    const x = (ms - tMs) / 864e5, y = acc / DEG
    xs[k] = x; ys[k] = y; sx += x; sy += y
    sex += el.ex; sey += el.ey; six += el.ix; siy += el.iy
    const re = F.temeToEcef(s.r, s.gmst), gd = ecefToGeodetic(re.x, re.y, re.z)
    track.push({ lon: gd.lon, lat: gd.lat })
  }
  const mx = sx / N, my = sy / N
  let sxx = 0, sxy = 0
  for (let k = 0; k < N; k++) { const dx = xs[k] - mx; sxx += dx * dx; sxy += dx * (ys[k] - my) }
  const drift = sxx > 0 ? sxy / sxx : 0
  const lon0 = my - drift * mx                      // 回归线在 tMs 处的值
  const ex = sex / N, ey = sey / N, ix = six / N / DEG, iy = siy / N / DEG
  return {
    lonMean: wrapPi(lon0 * DEG) / DEG, drift,
    ex, ey, e: Math.hypot(ex, ey),
    ix, iy, i: Math.hypot(ix, iy),
    track, t0: a, t1: a + W
  }
}

/* ===================== 相对状态（RIC） ===================== */
// rp / vp：参考星（主选），rs / vs：目标星；同一惯性系（TEME）。RIC 基：R̂ = r̂ₚ、Ĉ = ĥₚ（r × v）、Î = Ĉ × R̂。
// 相对速度取【RIC 转动系】里的变化率（扣掉 ω × Δr，ω = hₚ / |rₚ|²）—— Hill / CW 相对运动的口径；距离变化率与帧无关。
// 返回 { range, rate, R, I, C, dR, dI, dC, theta }（km、km/s、地心张角 rad）
export function relState(rp, vp, rs, vs) {
  if (!fin3(rp) || !fin3(vp) || !fin3(rs) || !fin3(vs)) return null
  const rm = norm(rp), h = cross(rp, vp), hm = norm(h)
  if (!(rm > 0) || !(hm > 0)) return null
  const R = scale(rp, 1 / rm), C = scale(h, 1 / hm), I = cross(C, R)
  const dr = sub(rs, rp), dv = sub(vs, vp)
  const w = scale(h, 1 / (rm * rm))
  const dvr = sub(dv, cross(w, dr))
  const range = norm(dr)
  const rsm = norm(rs)
  return {
    range, rate: range > 0 ? dot(dr, dv) / range : 0,
    R: dot(dr, R), I: dot(dr, I), C: dot(dr, C),
    dR: dot(dvr, R), dI: dot(dvr, I), dC: dot(dvr, C),
    theta: rsm > 0 ? Math.atan2(norm(cross(rp, rs)), dot(rp, rs)) : NaN
  }
}

/* ===================== Kozai 平均运动 ===================== */
// satellite.js 的 sgp4init 把 satrec.no 改写成 Brouwer 平均运动（rad/min）；TLE / OMM 原文写的是 Kozai 值。
// 由 initl 的正算式 n_B = n_K / (1 + δ(n_K)) 定点迭代反解（δ ~ 1e-3，三四步收敛到机器精度）。常量与 initl 同（WGS-72）。
const SGP4_RE = 6378.135, SGP4_MU = 398600.8, SGP4_J2 = 1082616e-9
const SGP4_XKE = 60 / Math.sqrt(SGP4_RE * SGP4_RE * SGP4_RE / SGP4_MU)
export function kozaiMeanMotion(rec) {
  const nb = Number(rec && rec.no), e = Number(rec && rec.ecco), inc = Number(rec && rec.inclo)
  if (!(nb > 0) || !Number.isFinite(e) || !Number.isFinite(inc) || !(e < 1)) return null
  const omeosq = 1 - e * e, rteosq = Math.sqrt(omeosq), c = Math.cos(inc)
  const d1 = 0.75 * SGP4_J2 * (3 * c * c - 1) / (rteosq * omeosq)
  let nk = nb
  for (let k = 0; k < 12; k++) {
    const ak = (SGP4_XKE / nk) ** (2 / 3)
    let del = d1 / (ak * ak)
    const adel = ak * (1 - del * del - del * (1 / 3 + 134 * del * del / 81))
    del = d1 / (adel * adel)
    const next = nb * (1 + del)
    const done = Math.abs(next - nk) <= 1e-15 * nk
    nk = next
    if (done) break
  }
  return nk   // rad/min
}
export const RAD_MIN_TO_REV_DAY = 1440 / TWO_PI

export default { MU, RE, SIDEREAL_DAY_MS, SV_FRAMES, OSC_FRAMES, frameContext, stateVector, j2000AxesInEcef, oscElements, syncElements, relState, kozaiMeanMotion, RAD_MIN_TO_REV_DAY }
