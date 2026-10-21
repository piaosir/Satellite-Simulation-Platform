// 轨迹面（覆盖带）：覆盖圈口径（波束角 / 最低仰角）沿星下点轨迹扫过的区域 —— 对标 STK 的 swath。
//
// 扫过区域 = 窗口内每一时刻覆盖区的并集，它恰好等于「每一时刻那条横断面扫过的面」∪「起点覆盖圈」∪「终点覆盖圈」：
//   点 p 在并集里 ⇔ 某时刻 p 在覆盖区内。取 p 最深入覆盖区的那一刻 t*（λ(t) − dist(p, c(t)) 最大）：t* 在窗口内部时
//   对 t 求导为零 ⇔ p 落在 t* 那条横断面上（两臂方向见 tiltCos）；t* 落在窗口端点时 p 在起点 / 终点覆盖圈里。
//   ★ 所以带面必须带两只【端帽】：只连横断面的话，当前时刻的覆盖圈被首条断面切掉一半、轨迹末端同理；而末端一进打转段
//     又整盘冒出来 —— 带的形状随时间忽窄忽宽（2026-09 实拍：GPS 25° 仰角同一颗星隔 30 min，一张是窄条、一张是半个地球）。
//
// 每个轨迹采样点出一条【横断面】：从星下点向两侧各伸一臂到该口径下的椭球覆盖边缘（圆轨道＝垂直航向），臂上按格边长等分；
// 相邻横断面之间连成三角网就是带面（见 globe3d/focusLanes.js 的 swathFill）。
// ★ 边缘与瞬时覆盖圈严格同源，不是球近似：两种口径都走 wgs84.isoElevationSolver（等仰角环逐方位用的就是它），
//   波束角档按采样点自己的星位折成仰角（focusFootprint.coverElevDeg）—— 于是任一时刻的覆盖圈都与带的两缘相切于断面端点。
//   球近似只用来定网格密度（swathK）、求根初值与两臂倾角。
// ★ 纯计算、不碰 DOM：主线程（对星聚焦特效）与 Worker（聚焦选中集）跑同一份。
import { Vector3 } from 'three'
import * as W from '../wgs84.js'
import { elevOf, coverElevDeg, coverHalfAngleSph, footprintRing } from './focusFootprint.js'
import { llaToVec, vecToLatLon, pushDashed, densifyArc, footprintFill, swathFill, FILL_CELL, LIFT, RE } from '../globe3d/focusLanes.js'

const WE = 7.2921159e-5     // 地球自转角速度 rad/s（与信息卡的对地速度同一常数）
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 星下点相对【地球】的运动：航向 az（rad，北起顺时针）、地面角速度 gs（rad/s，地心方向扫过的角）、径向速度 hd（km/s，≈高度变化率）。
// pv = satPos.posAt 结果（ECI，km / km·s⁻¹），gmst = 该时刻恒星时。相对速度 v − ω×r 先在 ECI 轴上减掉
// 自转分量，再绕 z 轴转到 ECEF（与 satellite.js 的 eciToEcf 同一旋转），最后投到地心方向的本地东/北/天。
export function groundMotion(pv, gmst) {
  const r = pv && pv.position, v = pv && pv.velocity
  if (!r || !v) return { az: 0, gs: 0, hd: 0 }
  const vx = v.x + WE * r.y, vy = v.y - WE * r.x, vz = v.z
  const c = Math.cos(gmst), s = Math.sin(gmst)
  const rx = c * r.x + s * r.y, ry = -s * r.x + c * r.y, rz = r.z
  const ex = c * vx + s * vy, ey = -s * vx + c * vy, ez = vz
  const rn = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
  const ux = rx / rn, uy = ry / rn, uz = rz / rn
  const en = Math.sqrt(ux * ux + uy * uy)
  const Ex = en > 1e-9 ? -uy / en : 1, Ey = en > 1e-9 ? ux / en : 0   // 东 = ẑ × u；正对极点时东向不定，任取
  const Nx = -uz * Ey, Ny = uz * Ex, Nz = ux * Ey - uy * Ex           // 北 = u × 东
  const ve = ex * Ex + ey * Ey, vn = ex * Nx + ey * Ny + ez * Nz
  return { az: Math.atan2(ve, vn), gs: Math.sqrt(ve * ve + vn * vn) / rn, hd: ex * ux + ey * uy + ez * uz }
}

// 横断面分段数 K（偶数）：按格边长 FILL_CELL 等分覆盖带全宽 2λ。一颗星一个 K —— 横断面点数必须一致才能逐格连成网；
// λ 取【远地点】高度的球近似，即带最宽处，保证沿轨任何位置都不欠密（椭圆轨道近地点处只是略密一点）。
export function swathK(hMaxKm, fpOpt) {
  const lam = coverHalfAngleSph(hMaxKm, fpOpt)
  return clamp(2 * Math.ceil(lam / FILL_CELL), 2, 80)
}
// 横断面缓存签名：口径 / 取值 / K 任一变了，缓存在采样点上的横断面就得重算
export function swathSig(fpOpt, K) {
  const elev = fpOpt && fpOpt.mode === 'elev'
  const v = elev ? elevOf(fpOpt.elevDeg) : (Number(fpOpt && fpOpt.beamDeg) > 0 ? Number(fpOpt.beamDeg) : 0)
  return (elev ? 'e' : 'b') + v + '|' + K
}

// 两臂的包络倾角 cosθ（θ 自航向起量，左右两臂各一）：覆盖半宽 λ 随时间变时，扫过区域的侧边界不在「垂直航向」的两点上，
// 而在 cosθ = −λ'/v 的方位上（v = 星下点地面角速度）—— λ 在涨时两臂后倾、在缩时前倾。
// 推导：p 深入覆盖区的量 λ(t) − dist(p, c(t)) 对 t 取极值 ⇔ λ' + v·cosθ_p = 0。λ' ≡ 0 → θ=90°，即垂直横断面。
// 画图走 swathSections：λ'/v 取【相邻两个采样点】的割线 −Δλ/Δc（两邻点星下点的地心角距），与轮廓 / 覆盖判据用的离散采样同一尺度 ——
//   平面上两圆外公切线的法向恰是 cosθ = −(λ₂−λ₁)/D，于是断面端点落在相邻采样覆盖圈并集的边界上，不被它们盖进去。
// ★ 曾只按球近似对高度求导（dλ/dh·ḣ）：漏了纬度项 —— 椭球上地平张角随纬度变，波束角档贴近上限时折算仰角沿轨在 0°~1.5° 间摆
//   （近上限处仰角对锥角极敏感），半宽变化率远大于高度项；两臂仍按垂直航向取，端点不在包络上，被相邻时刻的覆盖区盖进 OUT_TOL
//   以上裁掉、又没有别的曲线补上 → 轮廓开口（LEO 550 km 锥角离上限 0.02°~1° 时断成 6~8 段，最大开口 40°）。
// ★ 也不能取瞬时导数：折算仰角落到 0°（整圈地平）那一刻 λ(t) 是根号型拐点，导数趋于无穷 —— 拐点前一个采样点的两臂按瞬时导数
//   倾到夹限、几乎朝正后方，端点埋进前一个采样的覆盖圈；而按一个采样步长量，那一步半宽只涨 0.3°、星下点挪了 2.9°。
// 单点调 sectionOf（无邻点）时退回瞬时导数（tiltPair，推前 / 推后 TILT_DT 秒中心差分）。
// 实测量级：GPS（e=0.012）|cosθ| ≈ 0.003，与垂直无异；Molniya 近地点后 ≈ 0.37，两臂后倾 22°。
// 缺速度信息（手搓的点）取垂直；夹在 ±TILT_MAX：|λ'| ≥ v 时覆盖区在原地膨胀、侧边界退化，那几步由圆盘兜。
const TILT_MAX = 0.9
const TILT_DT = 2                      // s：LEO 一步挪 0.03°，求根容差 1.5e-11 rad 折成导数误差远小于 v 的千万分之一
// 该点左右两侧的覆盖半宽（地心角 rad，沿 ±n 即垂直航向量）。卫星在地表之下返回 null
function halfWidths(F, pt, fpOpt) {
  const sol = W.isoElevationSolver(F.S, coverElevDeg(F.S, fpOpt))
  if (!sol) return null
  const g = coverHalfAngleSph(pt.h, fpOpt)
  return [sol.solve(F.nx, F.ny, F.nz, g), sol.solve(-F.nx, -F.ny, -F.nz, g)]
}
function tiltPair(F, pt, fpOpt) {
  const gs = pt.gs, hd = pt.hd
  if (!(gs > 1e-9) || !Number.isFinite(hd)) return [0, 0]
  const r = Math.sqrt(F.S[0] * F.S[0] + F.S[1] * F.S[1] + F.S[2] * F.S[2])
  const at = (sg) => {                   // t + sg·TILT_DT 时刻的星位（地心方向沿航向挪、地心距按径向速度变）；n 与 u、d 都正交 → 也与推移后的 u′ 正交
    const a = sg * gs * TILT_DT, c = Math.cos(a), sn = Math.sin(a), rr = r + sg * hd * TILT_DT
    const S2 = [rr * (c * F.ux + sn * F.dx), rr * (c * F.uy + sn * F.dy), rr * (c * F.uz + sn * F.dz)]
    return halfWidths({ S: S2, nx: F.nx, ny: F.ny, nz: F.nz }, pt, fpOpt)
  }
  const p = at(1), m = at(-1)
  if (!p || !m) return [0, 0]
  const k = -1 / (2 * TILT_DT * gs)
  return [clamp((p[0] - m[0]) * k, -TILT_MAX, TILT_MAX), clamp((p[1] - m[1]) * k, -TILT_MAX, TILT_MAX)]
}

// 一个采样点的横向几何框架：卫星 ECEF、地心方向 u、航向 d、左法向 n = u × d（面朝航向、天顶朝上的左手边，均在 u 的切平面内）。
// 无从下笔（高度非正 / 位置无效）返回 null。pt = { lat, lon, h, az, gs?, hd? }
function baseFrame(pt) {
  if (!pt || !(pt.h > 0) || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lon)) return null
  const S = W.geodeticToEcef(pt.lon, pt.lat, pt.h)
  const r = Math.sqrt(S[0] * S[0] + S[1] * S[1] + S[2] * S[2]) || 1
  const ux = S[0] / r, uy = S[1] / r, uz = S[2] / r
  const en = Math.sqrt(ux * ux + uy * uy)
  const Ex = en > 1e-9 ? -uy / en : 1, Ey = en > 1e-9 ? ux / en : 0
  const Nx = -uz * Ey, Ny = uz * Ex, Nz = ux * Ey - uy * Ex
  const ca = Math.cos(pt.az || 0), sa = Math.sin(pt.az || 0)
  const dx = ca * Nx + sa * Ex, dy = ca * Ny + sa * Ey, dz = ca * Nz
  let nx = uy * dz - uz * dy, ny = uz * dx - ux * dz, nz = ux * dy - uy * dx
  const nn = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
  nx /= nn; ny /= nn; nz /= nn
  return { S, ux, uy, uz, dx, dy, dz, nx, ny, nz }
}
// baseFrame + 「沿切向单位方向 w 取覆盖边缘点」edgeAt(wx, wy, wz) → [lat, lon]（大地 °）—— 与瞬时覆盖圈逐方位同一份解算。
// 逐次拿上一个根作初值（沿方位连续取样时收敛最快），首次用球近似。卫星在地表之下时返回 null。
function sectionFrame(pt, fpOpt) {
  const F = baseFrame(pt)
  if (!F) return null
  const sol = W.isoElevationSolver(F.S, coverElevDeg(F.S, fpOpt))
  if (!sol) return null
  let guess = coverHalfAngleSph(pt.h, fpOpt)   // 球近似作初值：与椭球解相差不到千分之三，落在求根器的窄窗之内
  F.edgeAt = (wx, wy, wz) => { guess = sol.solve(wx, wy, wz, guess); const g = sol.geoOn(sol.surfAt(wx, wy, wz, guess)); return [g[1], g[0]] }
  return F
}

// 单位矢量 a→b 的大圆插值写进 out[o..o+2]
function slerpInto(out, o, ax, ay, az, bx, by, bz, t) {
  const d = clamp(ax * bx + ay * by + az * bz, -1, 1)
  const th = Math.acos(d), sn = Math.sin(th)
  let x, y, z
  if (sn < 1e-6) { x = ax + (bx - ax) * t; y = ay + (by - ay) * t; z = az + (bz - az) * t }
  else { const w0 = Math.sin((1 - t) * th) / sn, w1 = Math.sin(t * th) / sn; x = ax * w0 + bx * w1; y = ay * w0 + by * w1; z = az * w0 + bz * w1 }
  const m = Math.sqrt(x * x + y * y + z * z) || 1
  out[o] = x / m; out[o + 1] = y / m; out[o + 2] = z / m
}

// 一个采样点的横断面。pt = { lat, lon, h, az, gs?, hd? }（大地经纬 °、高度 km、航向 rad、地面角速度 rad/s、径向速度 km/s），
// fpOpt 同 footprintRing 的 opt；tilt＝[左, 右] 两臂的 cosθ（省略＝按瞬时导数现算，见 tiltPair）。
// 返回 Float32Array((K+1)·3)：渲染球面上的单位矢量（与 llaToVec 同一套坐标，Y 是极轴），
// 左缘在前、右缘在后、第 K/2 个恰是星下点 —— 左臂 左缘→星下点、右臂 星下点→右缘，各沿大圆等分。无从下笔返回 null。
export function sectionOf(pt, fpOpt, K, tilt) {
  if (!(K >= 1)) return null
  const F = sectionFrame(pt, fpOpt)
  if (!F) return null
  const [cL, cR] = tilt || tiltPair(F, pt, fpOpt), sL = Math.sqrt(1 - cL * cL), sR = Math.sqrt(1 - cR * cR)
  const L = F.edgeAt(cL * F.dx + sL * F.nx, cL * F.dy + sL * F.ny, cL * F.dz + sL * F.nz)
  const R = F.edgeAt(cR * F.dx - sR * F.nx, cR * F.dy - sR * F.ny, cR * F.dz - sR * F.nz)
  const a = llaToVec(L[0], L[1], 0), b = llaToVec(R[0], R[1], 0), c = llaToVec(pt.lat, pt.lon, 0)
  const out = new Float32Array((K + 1) * 3)
  const half = K >> 1
  if (!half) { for (let j = 0; j <= K; j++) slerpInto(out, j * 3, a.x, a.y, a.z, b.x, b.y, b.z, j / K); return out }
  for (let j = 0; j <= half; j++) slerpInto(out, j * 3, a.x, a.y, a.z, c.x, c.y, c.z, j / half)
  for (let j = half + 1; j <= K; j++) slerpInto(out, j * 3, c.x, c.y, c.z, b.x, b.y, b.z, (j - half) / (K - half))
  return out
}

// 一整条轨迹的采样点 + 横断面（画图用这个）：两臂倾角取相邻采样点的割线（见 tiltPair 上方的注）。
// 返回 { pts, secs, brk }：pts 可能比入参多出补的点（buildSwath 要用这一份 pts），brk＝断开的步（交给 buildSwath 的 opt.brk）。
// 缓存挂在采样点对象上（聚焦几何的轨迹环形缓冲里网格点原样复用）：swHw＝两侧垂直半宽、swE＝折算仰角、swSig＝口径签名、
// swTilt＝上次用的倾角、sw＝横断面、swIns＝它与下一个点之间补的拐点。半宽只随口径变；断面只在口径或倾角变了才重算 ——
// 内部点的邻点不变，倾角逐位相同；每拍新建的首尾点（head / tail）与它们的紧邻点才会重算。
//
// ★ 根号拐点：波束角档折算仰角在 0°（整圈地平）处起落时 λ(t) 是根号型拐点，拐点一侧覆盖圈胀缩得比挪得快（|λ'| > v），
//   扫过区域在那里的边界是【拐点时刻那只最大的覆盖圈】的一段弧 —— 不在任何断面端点上，两缘的弦从它里面切过去被裁掉 → 开口。
//   这里沿插值星位二分出拐点时刻、补成一个真采样点（最大的那只圈），并把它与仰角 > 0 那侧邻点之间那一步断开：
//   断开处两侧按段首 / 段尾落端帽圆盘、端帽弧接两缘（与窗口首尾同一套），角上那段弧就由端帽弧补上。
//   在拐点上加密采样没用：步子越密割线越逼近那个趋于无穷的瞬时导数，两臂又倒回去（实测更糟）。
const STILL_D = 1e-4                   // rad：两邻点星下点挪不到 0.006°（GEO 原地）就不按割线算倾角，取垂直
const ONSET_ITERS = 30                 // 拐点二分次数：一步 2.9° → 收到 1e-9 步长
const angU = (a, b) => Math.acos(clamp(a.ux * b.ux + a.uy * b.uy + a.uz * b.uz, -1, 1))
// 点 → baseFrame（半宽、折算仰角按口径签名缓存在点上）；无从下笔返回 null
function prepPoint(q, fpOpt, sig) {
  const F = baseFrame(q)
  if (!F) return null
  if (q.swSig !== sig || !q.swHw) { q.swHw = halfWidths(F, q, fpOpt); q.swE = coverElevDeg(F.S, fpOpt); q.swSig = sig; q.sw = null; q.swTilt = null; q.swIns = null }
  return q.swHw ? F : null
}
// 一列点的两臂倾角（cosθ，[左, 右]）：两侧有邻点取中心割线，否则单侧；单侧那一点贴得太近（每拍新建的首点离下一个网格点
// 可以只差零点几秒）就再往外取一个。brk[i]＝步 i→i+1 断开，不跨它取邻点
function tiltsOf(P, fr, brk) {
  const n = P.length, out = new Array(n)
  const ok = (i, j) => fr[j] && !(brk && brk[Math.min(i, j)])
  for (let i = 0; i < n; i++) {
    if (!fr[i]) { out[i] = null; continue }
    let a = i > 0 && ok(i, i - 1) ? i - 1 : i, b = i + 1 < n && ok(i, i + 1) ? i + 1 : i
    if (a === i && b > i && b + 1 < n && ok(b, b + 1) && angU(fr[i], fr[b]) < 0.25 * angU(fr[b], fr[b + 1])) b++
    if (b === i && a < i && a > 0 && ok(a, a - 1) && angU(fr[i], fr[a]) < 0.25 * angU(fr[a - 1], fr[a])) a--
    const D = a < b ? angU(fr[a], fr[b]) : 0
    if (!(D > STILL_D)) { out[i] = [0, 0]; continue }
    const ha = P[a].swHw, hb = P[b].swHw
    out[i] = [clamp(-(hb[0] - ha[0]) / D, -TILT_MAX, TILT_MAX), clamp(-(hb[1] - ha[1]) / D, -TILT_MAX, TILT_MAX)]
  }
  return out
}
// a、b 之间 f 处的插值采样点（星下点在渲染球面上走大圆 —— 与 coverTester 的插点同一口径；高度 / 航向 / 速度线性）
function lerpPoint(a, b, f) {
  const va = llaToVec(a.lat, a.lon, 0), vb = llaToVec(b.lat, b.lon, 0), tmp = new Float64Array(3)
  slerpInto(tmp, 0, va.x, va.y, va.z, vb.x, vb.y, vb.z, f)
  const g = vecToLatLon(tmp[0], tmp[1], tmp[2])
  let dz = (b.az || 0) - (a.az || 0)
  dz -= Math.round(dz / (2 * Math.PI)) * 2 * Math.PI
  const L = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? x + (y - x) * f : x)
  return { lat: g[0], lon: g[1], h: a.h + (b.h - a.h) * f, az: (a.az || 0) + dz * f, gs: L(a.gs, b.gs), hd: L(a.hd, b.hd), tMs: L(a.tMs, b.tMs) }
}
// 步 a→b 里折算仰角落到 0° 的那一刻（a、b 恰一侧为 0）：返回仰角为 0 那一侧紧贴拐点的插值点
function onsetPoint(a, b, fpOpt) {
  const zeroA = !(a.swE > 0)
  let lo = 0, hi = 1                     // 不变式：lo 端与 a 同侧、hi 端与 b 同侧
  for (let it = 0; it < ONSET_ITERS; it++) {
    const f = (lo + hi) / 2, q = lerpPoint(a, b, f)
    const z = !(coverElevDeg(W.geodeticToEcef(q.lon, q.lat, q.h), fpOpt) > 0)
    if (z === zeroA) lo = f; else hi = f
  }
  return lerpPoint(a, b, zeroA ? lo : hi)
}
export function swathSamples(pts, fpOpt, K) {
  const n = pts ? pts.length : 0, sig = swathSig(fpOpt, K)
  const fr0 = new Array(n)
  for (let i = 0; i < n; i++) fr0[i] = prepPoint(pts[i], fpOpt, sig)
  // 根号拐点：补拐点采样（缓存在步首点上，按下一个点的对象同一性判还能不能用），断开它与仰角 > 0 那侧邻点之间的一步
  const onset = (i) => i + 1 < n && fr0[i] && fr0[i + 1] && (pts[i].swE > 0) !== (pts[i + 1].swE > 0)
  let P = pts, brkArr = null
  if (!(fpOpt && fpOpt.mode === 'elev') && pts.some((_, i) => onset(i))) {
    P = []
    const brk = []
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      P.push(a)
      if (!onset(i)) continue
      const b = pts[i + 1], pos = a.swE > 0
      if (!a.swIns || a.swIns.b !== b) a.swIns = { b, q: onsetPoint(a, b, fpOpt) }
      brk[P.length - 1] = pos ? 1 : 0              // 步 a→拐点：a 在仰角 > 0 一侧才断
      P.push(a.swIns.q)
      brk[P.length - 1] = pos ? 0 : 1              // 步 拐点→b：b 在仰角 > 0 一侧才断
    }
    brkArr = new Uint8Array(Math.max(0, P.length - 1))
    for (let i = 0; i < brkArr.length; i++) brkArr[i] = brk[i] || 0
  }
  const fr = P === pts ? fr0 : P.map((q) => prepPoint(q, fpOpt, sig))
  const tl = tiltsOf(P, fr, brkArr)
  const secs = new Array(P.length)
  for (let i = 0; i < P.length; i++) {
    const q = P[i], t = tl[i]
    if (!t) { secs[i] = null; continue }
    if (!q.sw || !q.swTilt || q.swTilt[0] !== t[0] || q.swTilt[1] !== t[1]) { q.sw = sectionOf(q, fpOpt, K, t); q.swTilt = t }
    secs[i] = q.sw
  }
  return { pts: P, secs, brk: brkArr }
}

// ===================== 横断面序列 → 可画的带（三处消费方共用） =====================
// 消费方：computeTick（聚焦选中集，Worker/主线程同一份）、对星覆盖的聚焦特效（页面 focusGeomOfRec →
// scene.setSelectionSet）、2D 平面图（经 swathFlatGeom 出的数据）。逐条横断面直接连四边形有三种退化：
//  ① 航向掉头（星下点轨迹折返处、GEO 原地抖动）：sectionOf 的左右缘随航向互换，相邻断面「左→右」反向。
//     → 相邻断面按「本条左缘更靠近前一条的左缘还是右缘」翻回来（rev）。
//  ② 转弯（kind 2）：沿前进方向左右两缘任一缘没有前进（pL ≤ 0 / pR ≤ 0）—— 大口径 MEO 在最高纬处过极（内缘绕到极点
//     另一侧反着走）、Molniya 远地点环、图-8 折返点。相邻断面在内侧交叉、四边形自交。3D 靠模板缓冲按像素只涂一次，
//     自交照连不叠色；2D 的 nonzero 一次 fill 碰上自交片会正负相消抠出洞，故 2D 不围这种切片、改由覆盖圆盘兜。
//  ③ 原地（kind 3）：星下点一步挪不到半宽的 STILL_FRAC（GEO 全程如此）。航向是噪声，断面方向乱跳，按它连什么都不对；
//     这里的扫过区域就是覆盖圈本身 → 只落圆盘。原地那一档按位移量判而不按两缘进退，是为了让一整段抖动稳稳归为一段。
//  连续的非平移步（kind 2/3）成一段 run，整段落覆盖圆盘：段首一个、圆心每挪 DISC_STEP×半宽补一个、段尾再补一个。
//  带的首尾各再落一只覆盖圆盘（端帽，理由见文件头）。整条轨迹都原地（GEO）时带面就是一个圆盘。
//  重叠不叠色：3D 模板缓冲、2D 同一条路径 nonzero 一次 fill（切片与圆盘统一绕向）。
const DISC_STEP = 0.1
const DISC_DUP = 1e-3        // 新盘圆心离已有盘不到半宽的千分之一就算同一只（GEO 段尾 / 端帽不重复落盘）
const STILL_FRAC = 1e-3      // 星下点一步挪不到半宽的千分之一（GEO 45° 口径≈0.04°）就算原地；LEO 一步走 3° 以上，碰不到
const reversedSection = (s, K) => {
  const o = new Float32Array(s.length)
  for (let j = 0; j <= K; j++) { const a = j * 3, b = (K - j) * 3; o[a] = s[b]; o[a + 1] = s[b + 1]; o[a + 2] = s[b + 2] }
  return o
}
const halfWidthOf = (s, c) => Math.acos(clamp(s[c] * s[0] + s[c + 1] * s[1] + s[c + 2] * s[2], -1, 1))   // 星下点到左缘的角（rad）
// secs: 每个采样点一条横断面（sectionOf 产出，可为 null）；brk: 可选，brk[i]＝步 i→i+1 断开（见 swathSamples 的根号拐点）。
// 返回 { n, K, secs(定向后), rev, kind, spans, runs, allStill }
//  kind[i]：步 i→i+1 的性质，1＝平移、2＝转弯、3＝原地、0＝断面缺失或断开；spans / runs：连续平移步 / 非平移步覆盖的断面下标区间 [a, b]
//  ★ 「一段连续断面」一律按 kind[i] ≠ 0 判（圆盘端帽、两缘、端帽弧都是），断开与断面缺失同一待遇
export function swathLayout(secs, K, brk) {
  const n = secs ? secs.length : 0
  const out = new Array(n), rev = new Uint8Array(n), kind = new Int8Array(Math.max(0, n - 1))
  const c = (K >> 1) * 3, k3 = K * 3
  let p = null
  for (let i = 0; i < n; i++) {
    const s = secs[i]
    if (!s) { out[i] = null; continue }
    let o = s
    if (p) {
      const dL = s[0] * p[0] + s[1] * p[1] + s[2] * p[2], dR = s[0] * p[k3] + s[1] * p[k3 + 1] + s[2] * p[k3 + 2]
      if (dR > dL) { o = reversedSection(s, K); rev[i] = 1 }
    }
    out[i] = o; p = o
  }
  let nT = 0, nR = 0, nS = 0
  for (let i = 0; i + 1 < n; i++) {
    const a = out[i], b = out[i + 1]
    if (!a || !b || (brk && brk[i])) continue
    const fx = b[c] - a[c], fy = b[c + 1] - a[c + 1], fz = b[c + 2] - a[c + 2]
    let kd
    if (Math.sqrt(fx * fx + fy * fy + fz * fz) < STILL_FRAC * halfWidthOf(a, c)) kd = 3   // 原地（单位球上弦长≈弧长）
    else {
      const pL = (b[0] - a[0]) * fx + (b[1] - a[1]) * fy + (b[2] - a[2]) * fz
      const pR = (b[k3] - a[k3]) * fx + (b[k3 + 1] - a[k3 + 1]) * fy + (b[k3 + 2] - a[k3 + 2]) * fz
      kd = pL <= 0 || pR <= 0 ? 2 : 1
    }
    kind[i] = kd
    if (kd === 1) nT++; else if (kd === 2) nR++; else nS++
  }
  const spans = [], runs = []
  for (let i = 0; i + 1 < n;) {
    const kd = kind[i]
    if (!kd) { i++; continue }
    const tr = kd === 1
    let j = i
    while (j + 1 < n && kind[j] && (kind[j] === 1) === tr) j++
    ;(tr ? spans : runs).push([i, j])
    i = j
  }
  return { n, K, secs: out, rev, kind, spans, runs, allStill: nT === 0 && nR === 0 && nS > 0 }
}
// 覆盖圆盘：打转段（段首、圆心每挪 DISC_STEP×半宽、段尾）+ 每段连续断面的首尾（端帽）。
// pts[i] = { lat, lon, h }（与 secs 同下标的采样点），fpOpt 同 footprintRing，seg 为环的分段数。
// 返回 [{ i, lat, lon, ring:[{lat,lon}...](闭合), cap }]
export function swathDiscs(layout, pts, fpOpt, seg) {
  const discs = []
  if (!layout || !pts) return discs
  const K = layout.K, c = (K >> 1) * 3, secs = layout.secs, n = layout.n
  // 已有盘里圆心离这条断面的星下点、半宽与它都差不到 DISC_DUP×半宽的（同一只圈）。半宽也要比：根号拐点补的点可以紧贴
  // 前一个采样点，两只圈却不一样大，端帽弧必须从自己那只圈上截（见 swathSamples）
  const near = (s) => {
    const w = halfWidthOf(s, c)
    for (const d of discs) if (Math.abs(d.w - w) <= DISC_DUP * w && Math.acos(clamp(s[c] * d.cx + s[c + 1] * d.cy + s[c + 2] * d.cz, -1, 1)) <= DISC_DUP * w) return true
    return false
  }
  const put = (i, cap) => {
    const s = secs[i], q = pts[i]
    if (!s || !q || near(s)) return false
    const h = q.h != null ? q.h : (q.gd ? q.gd.height : NaN)
    if (!(h > 0) || !Number.isFinite(q.lat) || !Number.isFinite(q.lon)) return false
    const ring = footprintRing(W.geodeticToEcef(q.lon, q.lat, h), h, seg > 0 ? seg : 72, fpOpt)
    if (!ring || ring.length < 3) return false
    const f = ring[0], l = ring[ring.length - 1]
    if (Math.abs(f.lat - l.lat) > 1e-9 || Math.abs(f.lon - l.lon) > 1e-9) ring.push({ lat: f.lat, lon: f.lon })
    discs.push({ i, lat: q.lat, lon: q.lon, ring, cap, cx: s[c], cy: s[c + 1], cz: s[c + 2], w: halfWidthOf(s, c) })
    return true
  }
  for (const [a, b] of layout.runs) {
    let lx = 0, ly = 0, lz = 0, has = false
    for (let i = a; i <= b; i++) {
      const s = secs[i]
      if (!s) continue
      if (has && i < b) {
        const d = Math.acos(clamp(s[c] * lx + s[c + 1] * ly + s[c + 2] * lz, -1, 1))
        if (d <= DISC_STEP * halfWidthOf(s, c)) continue
      }
      if (put(i, false) || !has) { lx = s[c]; ly = s[c + 1]; lz = s[c + 2]; has = true }
    }
  }
  // 端帽：每段连续断面的首尾 —— 窗口起点（当前时刻）与终点的覆盖圈、根号拐点断开处两侧
  for (let i = 0; i < n;) {
    if (!secs[i]) { i++; continue }
    let j = i
    while (j + 1 < n && layout.kind[j]) j++
    put(i, true); put(j, true)
    i = j + 1
  }
  return discs
}

// ===================== 轮廓：扫过区域的真实外边界 =====================
// 并集的边界只可能出在三类曲线上（理由同文件头的推导）：① 各断面的两缘端点连成的左缘 / 右缘；② 起点覆盖圈背向航向
// 的那段弧；③ 终点覆盖圈朝向航向的那段弧。候选曲线逐点验「是否被窗口内某一时刻的覆盖区盖住、且深入 OUT_TOL 以上」，
// 盖住的段剪掉、交界点沿大圆二分到位 —— 转弯内缘的燕尾、多圈轨迹彼此压住的缘线都在这一步自然消失，
// 剩下的就是填充区域的轮廓（带面与轮廓同一个定义，不会一边有一边没有）。
// 原地步（kind 3）的航向是噪声，两缘按它连线只会满圈乱跳 → 两缘在原地步处断开，改拿那几只圆盘的整圈当候选。
const OUT_TOL = 0.05 * Math.PI / 180   // 地面裕度（rad）：深入某时刻覆盖区不足这么多的点仍算边界（吸收椭球 / 倾角的近似误差）
const REJ_PAD = 0.05                   // 粗筛半径裕度（rad，≈2.9°）：盖过球近似与椭球、渲染映射之间的差
const NEAR_R = 0.15                    // 邻域表半径（rad）：候选点沿折线连续走，离锚点这么远以内共用一张「可能盖到它的样本」表
const SW = 9                           // coverTester 每个样本占的数（布局见 add）
const FINE_G = 0.6                     // 细格档的格宽上限（弦长）：再粗细格就不比锚点邻域表小了
const CUT_ITERS = 18                   // 交界点二分次数：区间 ≤ 几度 → 收到 1e-5 度量级
// 覆盖判据（与断面边缘同一份椭球口径）：inside(x, y, z) —— 渲染球面单位矢量处的地面点是否在某个采样时刻的覆盖区里。
// 采样取轨迹点本身；相邻两点间隔超过 λ/2 时插点（多选降采样档 LEO 一步 15°，只拿原点的话盘都接不上）。
// ★ 查询是沿候选折线连续走的：离上一个锚点 NEAR_R 以内就共用一张「可能盖到它的样本」邻域表，走远了才重建 ——
//   否则每个候选点都要把整条轨迹扫一遍（LEO 一圈 121 个样本 × 几百个候选点，每拍每颗 0.3 ms）。
//   样本上千（多圈 LEO）时邻域表经空间网格建，不做全表扫。
function coverTester(pts, fpOpt) {
  // 每个样本 SW 个数：卫星 ECEF（S）、星下点渲染单位矢量（C）、粗筛余弦、判据阈值、邻域表余弦 —— 平铺在一块定长数组里
  const buf = []
  let lamMax = 0
  const add = (lat, lon, h, lam) => {
    const S = W.geodeticToEcef(lon, lat, h), c = llaToVec(lat, lon, 0), rho = RE / (RE + h)
    // 判据＝该样本时刻的那条等仰角线（波束角档按样本自己的星位折成仰角）；地面裕度 OUT_TOL 按球近似折成仰角加上去
    const el = (psi) => Math.atan2(Math.cos(psi) - rho, Math.sin(psi))
    const thr = Math.sin(coverElevDeg(S, fpOpt) * Math.PI / 180 + Math.max(0, el(Math.max(0, lam - OUT_TOL)) - el(lam)))
    buf.push(S[0], S[1], S[2], c.x, c.y, c.z,
      Math.cos(Math.min(Math.PI, lam + REJ_PAD)), thr, Math.cos(Math.min(Math.PI, lam + REJ_PAD + NEAR_R)))
    if (lam > lamMax) lamMax = lam
  }
  let prev = null
  const tmp = new Float64Array(3)
  for (const q of pts) {
    const h = q ? (q.h != null ? q.h : (q.gd ? q.gd.height : NaN)) : NaN
    if (!(h > 0) || !Number.isFinite(q.lat) || !Number.isFinite(q.lon)) { prev = null; continue }
    const cur = { lat: q.lat, lon: q.lon, h, lam: coverHalfAngleSph(h, fpOpt), v: llaToVec(q.lat, q.lon, 0) }
    if (prev) {
      const gap = Math.acos(clamp(prev.v.x * cur.v.x + prev.v.y * cur.v.y + prev.v.z * cur.v.z, -1, 1))
      const lim = 0.5 * Math.min(prev.lam, cur.lam)
      if (lim > 0 && gap > lim && gap < Math.PI - 1e-3) {
        const k = Math.min(64, Math.ceil(gap / lim))
        for (let s = 1; s < k; s++) {
          const t = s / k, hh = prev.h + (h - prev.h) * t
          slerpInto(tmp, 0, prev.v.x, prev.v.y, prev.v.z, cur.v.x, cur.v.y, cur.v.z, t)
          const g = vecToLatLon(tmp[0], tmp[1], tmp[2])
          add(g[0], g[1], hh, coverHalfAngleSph(hh, fpOpt))
        }
      }
    }
    add(cur.lat, cur.lon, h, cur.lam)
    prev = cur
  }
  const D = Float64Array.from(buf), n = D.length / SW
  // 空间网格（样本上千才建）。两档：
  //  · 细格（格宽 = 粗筛半径 lamMax + REJ_PAD 的弦长）：过粗筛的样本，圆心离查询点不超过这个弦长 → 每个分量差不过一格，
  //    必在查询点所在格与周围 26 格里。邻域表＝这 27 格的并，只随【查询点换格】重建 —— 与锚点无关，故不带 NEAR_R 那圈余量。
  //    ★ 窄波束 / 多圈时这是唯一跑得动的档：波束 3° 的 LEO 覆盖半角只有 0.002 rad，样本按半角的一半插点（一步 64 个），
  //      老档的邻域半径却被 REJ_PAD + NEAR_R（0.2 rad）撑着，每个候选点要扫几千个样本（50 圈 1.2 s/拍）。
  //  · 粗格（格宽 = 邻域表半径的弦长，按锚点建表）：覆盖半角大时细格并不更小，保留原路
  const gF = 2 * Math.sin(Math.min(Math.PI, lamMax + REJ_PAD) / 2)
  const fine = n > 600 && gF < FINE_G
  const g = fine ? gF : 2 * Math.sin(Math.min(Math.PI, lamMax + REJ_PAD + NEAR_R) / 2)
  let grid = null
  if (fine || (n > 600 && g < 0.6)) {
    grid = new Map()
    for (let j = 0; j < n; j++) {
      const o = j * SW
      const key = ((Math.floor(D[o + 3] / g) + 1024) * 2048 + (Math.floor(D[o + 4] / g) + 1024)) * 2048 + (Math.floor(D[o + 5] / g) + 1024)
      let a = grid.get(key); if (!a) grid.set(key, a = []); a.push(j)
    }
  }
  const near = new Int32Array(Math.max(1, n))
  let nNear = 0, ax = 0, ay = 0, az = 0, anchored = false
  const cosNear = Math.cos(NEAR_R)
  const pick = (j) => { const o = j * SW; if (ax * D[o + 3] + ay * D[o + 4] + az * D[o + 5] >= D[o + 8]) near[nNear++] = j }
  let cx = NaN, cy = NaN, cz = NaN       // 细格档：邻域表当前对应的格
  function rebuild(x, y, z) {
    ax = x; ay = y; az = z; nNear = 0; anchored = true
    if (!grid) { for (let j = 0; j < n; j++) pick(j); return }
    const ix = Math.floor(x / g), iy = Math.floor(y / g), iz = Math.floor(z / g)
    cx = ix; cy = iy; cz = iz
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const js = grid.get(((ix + a + 1024) * 2048 + (iy + b + 1024)) * 2048 + (iz + d + 1024))
      if (!js) continue
      if (fine) for (const j of js) near[nNear++] = j
      else for (const j of js) pick(j)
    }
  }
  const stale = fine
    ? (x, y, z) => !anchored || Math.floor(x / g) !== cx || Math.floor(y / g) !== cy || Math.floor(z / g) !== cz
    : (x, y, z) => !anchored || x * ax + y * ay + z * az < cosNear
  // 地面点（渲染球面单位矢量 x,y,z；其纬经就是大地纬经）：大地天顶 N = (x, −z, y)（ECEF 轴序），
  // 椭球面点 P = (Nc·x, −Nc·z, Nc(1−e²)·y)，Nc＝卯酉圈曲率半径 —— 与 geodeticToEcef / geodeticUp 恒等，免三角函数
  // 样本 j 是否盖住地面点（粗筛 + 等仰角判据；与邻域表里的逐个判定同一式子）
  const covers = (j, x, y, z, Px, Py, Pz) => {
    const o = j * SW
    if (x * D[o + 3] + y * D[o + 4] + z * D[o + 5] < D[o + 6]) return false
    const dx = D[o] - Px, dy = D[o + 1] - Py, dz = D[o + 2] - Pz
    const dd = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
    return dx * x - dy * z + dz * y > D[o + 7] * dd
  }
  // ★ 上一次盖住的那个样本先试：候选点沿折线连续走，盖住上一点的样本九成也盖住这一点 —— 命中就连邻域表都不必重建。
  //   多圈轨迹（几十上百圈）里绝大多数缘线点都被别的圈压着，原先每点都要把邻域表（随圈数线性涨）扫到命中为止，
  //   整体是圈数的平方（LEO 100 圈 140 ms/拍、400 圈 2 s/拍）。结果不变：命中意味着它过了粗筛与判据，
  //   必在当前点的邻域表里，扫表也会判 true；没命中照旧扫表。
  let hit = -1
  function inside(x, y, z) {
    const Nc = W.A / Math.sqrt(1 - W.E2 * y * y)
    const Px = Nc * x, Py = -Nc * z, Pz = Nc * (1 - W.E2) * y
    if (hit >= 0 && covers(hit, x, y, z, Px, Py, Pz)) return true
    if (stale(x, y, z)) rebuild(x, y, z)
    for (let k = 0; k < nNear; k++) {
      const j = near[k]
      if (covers(j, x, y, z, Px, Py, Pz)) { hit = j; return true }
    }
    return false
  }
  return { inside, n }
}
// 候选折线（Float64Array 平铺 xyz 单位矢量；closed＝首尾同点的整圈）按覆盖判据剪成若干段，追加进 out（Float32Array）
function clipOutside(P, closed, T, out) {
  const m = P.length / 3
  if (m < 2) return
  const flag = new Uint8Array(m)
  for (let i = 0; i < m; i++) flag[i] = T.inside(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) ? 1 : 0
  const tmp = new Float64Array(3)
  // 相邻两点一里一外：沿大圆二分到交界处（lo 端在外）
  const cut = (iOut, iIn, dst) => {
    const ax = P[iOut * 3], ay = P[iOut * 3 + 1], az = P[iOut * 3 + 2], bx = P[iIn * 3], by = P[iIn * 3 + 1], bz = P[iIn * 3 + 2]
    let lo = 0, hi = 1
    for (let it = 0; it < CUT_ITERS; it++) {
      const t = (lo + hi) / 2
      slerpInto(tmp, 0, ax, ay, az, bx, by, bz, t)
      if (T.inside(tmp[0], tmp[1], tmp[2])) hi = t; else lo = t
    }
    slerpInto(tmp, 0, ax, ay, az, bx, by, bz, lo)
    dst.push(tmp[0], tmp[1], tmp[2])
  }
  const pieces = []
  let cur = null
  for (let i = 0; i < m; i++) {
    if (!flag[i]) {
      if (!cur) { cur = []; if (i > 0) cut(i, i - 1, cur) }
      cur.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])
    } else if (cur) { cut(i - 1, i, cur); pieces.push(cur); cur = null }
  }
  if (cur) pieces.push(cur)
  // 整圈：首尾两段在接缝处本是同一段 → 接起来（末段 + 首段去掉重复的首点）
  if (closed && pieces.length > 1 && !flag[0] && !flag[m - 1]) {
    const first = pieces.shift(), last = pieces.pop()
    pieces.push(last.concat(first.slice(3)))
  }
  for (const p of pieces) {
    if (p.length < 6) continue
    let len = 0
    for (let k = 3; k < p.length; k += 3) len += Math.acos(clamp(p[k - 3] * p[k] + p[k - 2] * p[k + 1] + p[k - 1] * p[k + 2], -1, 1))
    if (len > 1e-5) out.push(Float32Array.from(p))
  }
}
// 端帽弧：pt 处覆盖圈被左右两臂分成的两段里、背离相邻断面 nb 的那段 —— 起点取背向前进的半边，终点取朝向前进的半边。
// 外侧按【实际位移】（相邻断面的星下点在哪边）判，不单信瞬时航向：轨迹恰在窗口端点处掉头时两者相反。
// 弧上的点直接取该处端帽圆盘的环（ring，与瞬时覆盖圈同一份解算、同一档方位密度）里落在外侧的那一串，不再另行求根；
// 首尾补上该点（定向后）断面 sec 的两个端点 —— 与两缘严丝合缝。两臂方位直接从 sec 的两个端点量（不重算倾角），与断面一定一致。
function capArc(pt, ring, sec, nb, K) {
  const F = baseFrame(pt)
  if (!F || !ring || ring.length < 4) return null
  const c = (K >> 1) * 3, k3 = K * 3
  // 切平面内某地面点（ECEF）的方位：与航向夹角的余弦、在左法向哪一侧
  const azOf = (p) => {
    const pu = p[0] * F.ux + p[1] * F.uy + p[2] * F.uz
    const wx = p[0] - pu * F.ux, wy = p[1] - pu * F.uy, wz = p[2] - pu * F.uz
    return [(wx * F.dx + wy * F.dy + wz * F.dz) / (Math.sqrt(wx * wx + wy * wy + wz * wz) || 1), wx * F.nx + wy * F.ny + wz * F.nz >= 0]
  }
  const armOf = (o) => { const g = vecToLatLon(sec[o], sec[o + 1], sec[o + 2]); return azOf(W.geodeticToEcef(g[1], g[0], 0)) }
  const a0 = armOf(0), a1 = armOf(k3)
  const cLeft = a0[1] ? a0[0] : a1[0], cRight = a0[1] ? a1[0] : a0[0]
  // 航向 d 是 ECEF 分量；渲染坐标 = (X, Z, −Y)（llaToVec 的轴序）
  const back = F.dx * (nb[c] - sec[c]) + F.dz * (nb[c + 1] - sec[c + 1]) - F.dy * (nb[c + 2] - sec[c + 2]) > 0
  const m = ring.length - 1                      // 环首尾同点
  const keep = new Uint8Array(m)
  let nk = 0
  for (let k = 0; k < m; k++) {
    const [cosA, left] = azOf(W.geodeticToEcef(ring[k].lon, ring[k].lat, 0))
    const ct = left ? cLeft : cRight                // 左半边比左臂、右半边比右臂
    if (back ? cosA < ct : cosA > ct) { keep[k] = 1; nk++ }
  }
  if (!nk || nk === m) return null
  let s0 = 0
  while (!(keep[s0] && !keep[(s0 + m - 1) % m])) s0++   // 外侧那一串的起点
  const P = new Float64Array((nk + 2) * 3)
  for (let q = 0; q < nk; q++) {
    const r = ring[(s0 + q) % m], v = llaToVec(r.lat, r.lon, 0), o = (q + 1) * 3
    P[o] = v.x; P[o + 1] = v.y; P[o + 2] = v.z
  }
  const d0 = P[3] * sec[0] + P[4] * sec[1] + P[5] * sec[2], d1 = P[3] * sec[k3] + P[4] * sec[k3 + 1] + P[5] * sec[k3 + 2]
  const [f, l] = d0 >= d1 ? [0, k3] : [k3, 0], e = (nk + 1) * 3
  P[0] = sec[f]; P[1] = sec[f + 1]; P[2] = sec[f + 2]
  P[e] = sec[l]; P[e + 1] = sec[l + 1]; P[e + 2] = sec[l + 2]
  return P
}
// 轮廓折线组：[Float32Array(平铺 xyz 单位矢量)...]。opt.fpOn＝覆盖圈层开着：当前时刻的覆盖圈就是起点端帽，
// 它那段弧由覆盖圈线自己描（与整轨原地时「盘轮廓不描」同一口径），这里不重描。
export function swathOutline(layout, pts, fpOpt, discs, opt) {
  const lines = []
  if (!layout || !(layout.K >= 1) || !pts || !layout.n) return lines
  const fpOn = !!(opt && opt.fpOn)
  if (layout.allStill && fpOn) return lines
  const K = layout.K, n = layout.n, secs = layout.secs, kind = layout.kind, k3 = K * 3
  const cands = []
  // 下标 i 处的圆盘环：端帽都落了盘（与已有盘重合被去重时取圆心最近的那只，二者相距不到半宽的千分之一）
  const ringAt = (i) => {
    let best = null, bd = Infinity
    const s = secs[i], c = (K >> 1) * 3
    for (const d of (discs || [])) {
      if (d.i === i) return d.ring
      const a = Math.acos(clamp(s[c] * d.cx + s[c + 1] * d.cy + s[c + 2] * d.cz, -1, 1))
      if (a < bd) { bd = a; best = d }
    }
    return best ? best.ring : null
  }
  // ① 两缘：连续有效断面连成左缘 / 右缘，遇原地步 / 断开处断开
  let a = -1
  const flush = (b) => {
    if (a >= 0 && b > a) {
      const L = new Float64Array((b - a + 1) * 3), R = new Float64Array((b - a + 1) * 3)
      for (let i = a; i <= b; i++) { const s = secs[i], o = (i - a) * 3; L[o] = s[0]; L[o + 1] = s[1]; L[o + 2] = s[2]; R[o] = s[k3]; R[o + 1] = s[k3 + 1]; R[o + 2] = s[k3 + 2] }
      cands.push([L, false], [R, false])
    }
    a = -1
  }
  for (let i = 0; i < n; i++) {
    if (!secs[i]) { flush(i - 1); continue }
    if (a < 0) a = i
    if (i + 1 < n && (kind[i] === 3 || !kind[i])) flush(i)
  }
  flush(n - 1)
  // ②③ 端帽弧：每段连续断面的首尾；首 / 尾那一步原地时航向不可信，交给下面的整圈
  for (let i = 0; i < n;) {
    if (!secs[i]) { i++; continue }
    let j = i
    while (j + 1 < n && kind[j]) j++
    if (j > i) {
      if (kind[i] !== 3 && !(fpOn && i === 0)) { const P = capArc(pts[i], ringAt(i), secs[i], secs[i + 1], K); if (P) cands.push([P, false]) }
      if (kind[j - 1] !== 3) { const P = capArc(pts[j], ringAt(j), secs[j], secs[j - 1], K); if (P) cands.push([P, false]) }
    }
    i = j + 1
  }
  // ④ 原地步两侧的圆盘整圈（含只有一条断面的孤段：它的首尾端帽就是这只盘）
  for (const d of (discs || [])) {
    const i = d.i
    const still = (i + 1 < n && kind[i] === 3) || (i > 0 && kind[i - 1] === 3)
    const lone = (i === 0 || !kind[i - 1]) && (i + 1 >= n || !kind[i])
    if (!still && !lone) continue
    if (fpOn && i === 0) continue
    const P = new Float64Array(d.ring.length * 3)
    d.ring.forEach((q, k) => { const v = llaToVec(q.lat, q.lon, 0); P[k * 3] = v.x; P[k * 3 + 1] = v.y; P[k * 3 + 2] = v.z })
    cands.push([P, true])
  }
  if (!cands.length) return lines
  const T = coverTester(pts, fpOpt)
  for (const [P, closed] of cands) clipOutside(P, closed, T, lines)
  return lines
}

// 一颗星一拍的轨迹面：定向分段 + 圆盘 + 轮廓。pts / secs 同下标（画图取 swathSamples 的产出；secs[i] 可为 null）。
// seg：覆盖圈环的分段数（与瞬时覆盖圈同档）；opt.fpOn：覆盖圈层是否开着（见 swathOutline）；opt.brk：断开的步（swathSamples 给）。
export function buildSwath(pts, secs, K, fpOpt, seg, opt) {
  const layout = swathLayout(secs, K, opt && opt.brk)
  const discs = swathDiscs(layout, pts, fpOpt, seg)
  const lines = swathOutline(layout, pts, fpOpt, discs, opt)
  return { K, layout, discs, lines }
}
// 3D：带面（平移步 + 转弯步连四边形，原地步不连）+ 圆盘填充；轮廓按轨迹线样式描。o = { edge, fill, dash }，sink 可为 null
export function emitSwath3D(sw, o) {
  const layout = sw && sw.layout
  if (!layout || !(layout.K >= 1)) return
  const K = layout.K, kind = layout.kind
  if (o.fill) {
    for (let i = 0; i + 1 < layout.n;) {
      if (kind[i] !== 1 && kind[i] !== 2) { i++; continue }
      let j = i
      while (j + 1 < layout.n && (kind[j] === 1 || kind[j] === 2)) j++
      swathFill(layout.secs.slice(i, j + 1), K, o.fill)
      i = j
    }
    for (const d of (sw.discs || [])) footprintFill(d.ring.map((q) => llaToVec(q.lat, q.lon, LIFT)), { lat: d.lat, lon: d.lon }, o.fill)
  }
  if (o.edge) {
    const rr = (RE + LIFT) / RE
    for (const ln of (sw.lines || [])) {
      const pts = []
      for (let k = 0; k < ln.length; k += 3) pts.push(new Vector3(ln[k] * rr, ln[k + 1] * rr, ln[k + 2] * rr))
      if (pts.length > 1) pushDashed(o.edge, densifyArc(pts), o.dash)
    }
  }
}
// 2D 平面图要的形态：swath.ll＝定向后的横断面经纬（每条 K+1 对 lat/lon，缺失为 NaN）、swath.skip＝步 i 不是平移步
// （平面图只围平移步的切片，其余由圆盘兜，见 swathLayout 的②）；swLines＝轮廓折线组 [[{lat,lon}...]...]、swRings＝圆盘环
export function swathFlatGeom(sw) {
  const layout = sw.layout, K = layout.K, m = K + 1, n = layout.n
  const ll = new Float32Array(n * m * 2)
  for (let i = 0; i < n; i++) {
    const s = layout.secs[i], o = i * m * 2
    if (!s) { ll.fill(NaN, o, o + m * 2); continue }
    for (let a = 0; a < m; a++) { const ge = vecToLatLon(s[a * 3], s[a * 3 + 1], s[a * 3 + 2]); ll[o + a * 2] = ge[0]; ll[o + a * 2 + 1] = ge[1] }
  }
  const skip = new Uint8Array(Math.max(0, n - 1))
  for (let i = 0; i + 1 < n; i++) skip[i] = layout.kind[i] === 1 ? 0 : 1
  const swLines = (sw.lines || []).map((ln) => {
    const pl = []
    for (let k = 0; k < ln.length; k += 3) { const ge = vecToLatLon(ln[k], ln[k + 1], ln[k + 2]); pl.push({ lat: ge[0], lon: ge[1] }) }
    return pl
  })
  return { swath: { K, ll, skip }, swLines, swRings: (sw.discs || []).map((d) => d.ring) }
}
