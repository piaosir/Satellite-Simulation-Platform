// 轨迹面（覆盖带）：覆盖圈口径（波束角 / 最低仰角）沿星下点轨迹扫过的区域 —— 对标 STK 的 swath。
//
// 每个轨迹采样点出一条【横断面】：过星下点、垂直于地面航向的大圆弧，两端是该口径下的椭球覆盖边缘，
// 中间按格边长等分；相邻横断面之间连成三角网就是带面（见 globe3d/focusLanes.js 的 swathFill）。
// ★ 边缘与瞬时覆盖圈严格同源，不是球近似：最低仰角档走 wgs84.isoElevationSolver（等仰角环逐方位用的就是它），
//   波束角档走 wgs84.footprintHitDir（足迹圈逐方位用的就是它）—— 于是任一时刻的覆盖圈横向两个极点都恰好落在
//   带的两条边上。球近似只用来定网格密度（swathK）与求根初值。
// ★ 纯计算、不碰 DOM：主线程（对星聚焦特效）与 Worker（聚焦选中集）跑同一份。
import * as W from '../wgs84.js'
import { beamHalfAngle, elevOf, coverHalfAngleSph } from './focusFootprint.js'
import { llaToVec, FILL_CELL } from '../globe3d/focusLanes.js'

const WE = 7.2921159e-5     // 地球自转角速度 rad/s（与信息卡的对地速度同一常数）
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 地面航向（rad，北起顺时针）：星下点相对【地球】的运动方向。
// pv = sat.propagate 结果（ECI，km / km·s⁻¹），gmst = 该时刻恒星时。相对速度 v − ω×r 先在 ECI 轴上减掉
// 自转分量，再绕 z 轴转到 ECEF（与 satellite.js 的 eciToEcf 同一旋转），最后投到地心方向的本地东/北。
export function headingAz(pv, gmst) {
  const r = pv && pv.position, v = pv && pv.velocity
  if (!r || !v) return 0
  const vx = v.x + WE * r.y, vy = v.y - WE * r.x, vz = v.z
  const c = Math.cos(gmst), s = Math.sin(gmst)
  const rx = c * r.x + s * r.y, ry = -s * r.x + c * r.y, rz = r.z
  const ex = c * vx + s * vy, ey = -s * vx + c * vy, ez = vz
  const rn = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1
  const ux = rx / rn, uy = ry / rn, uz = rz / rn
  const en = Math.sqrt(ux * ux + uy * uy)
  const Ex = en > 1e-9 ? -uy / en : 1, Ey = en > 1e-9 ? ux / en : 0   // 东 = ẑ × u；正对极点时东向不定，任取
  const Nx = -uz * Ey, Ny = uz * Ex, Nz = ux * Ey - uy * Ex           // 北 = u × 东
  return Math.atan2(ex * Ex + ey * Ey, ex * Nx + ey * Ny + ez * Nz)
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

// 一个采样点的横断面。pt = { lat, lon, h, az }（大地经纬 °、高度 km、航向 rad），fpOpt 同 footprintRing 的 opt。
// 返回 Float32Array((K+1)·3)：渲染球面上的单位矢量（与 llaToVec 同一套坐标，Y 是极轴），左缘在前、右缘在后、
// 第 K/2 个在星下点附近。无从下笔（高度非正 / 位置无效）返回 null。
export function sectionOf(pt, fpOpt, K) {
  if (!pt || !(pt.h > 0) || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lon) || !(K >= 1)) return null
  const S = W.geodeticToEcef(pt.lon, pt.lat, pt.h)
  const r = Math.sqrt(S[0] * S[0] + S[1] * S[1] + S[2] * S[2]) || 1
  const ux = S[0] / r, uy = S[1] / r, uz = S[2] / r
  // 地心方向上的本地东/北 → 航向 d → 左法向 n = u × d（面朝航向、天顶朝上，左手边）
  const en = Math.sqrt(ux * ux + uy * uy)
  const Ex = en > 1e-9 ? -uy / en : 1, Ey = en > 1e-9 ? ux / en : 0
  const Nx = -uz * Ey, Ny = uz * Ex, Nz = ux * Ey - uy * Ex
  const ca = Math.cos(pt.az || 0), sa = Math.sin(pt.az || 0)
  const dx = ca * Nx + sa * Ex, dy = ca * Ny + sa * Ey, dz = ca * Nz
  let nx = uy * dz - uz * dy, ny = uz * dx - ux * dz, nz = ux * dy - uy * dx
  const nn = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
  nx /= nn; ny /= nn; nz /= nn
  const elev = fpOpt && fpOpt.mode === 'elev'
  let edge
  if (elev) {
    const sol = W.isoElevationSolver(S, elevOf(fpOpt.elevDeg))
    if (!sol) return null
    const rho0 = coverHalfAngleSph(pt.h, fpOpt)   // 球近似作初值：与椭球解相差不到千分之三，落在求根器的窄窗之内
    edge = (sg) => { const p = sol.surfAt(sg * nx, sg * ny, sg * nz, sol.solve(sg * nx, sg * ny, sg * nz, rho0)); const g = sol.geoOn(p); return [g[1], g[0]] }
  } else {
    const eta = beamHalfAngle(pt.h, fpOpt && fpOpt.beamDeg)
    const ce = Math.cos(eta), se = Math.sin(eta)
    edge = (sg) => {
      const hit = W.footprintHitDir(S, [-ce * ux + se * sg * nx, -ce * uy + se * sg * ny, -ce * uz + se * sg * nz])
      const gd = W.ecefToGeodetic(hit[0], hit[1], hit[2])
      return [gd.lat, gd.lon]
    }
  }
  const L = edge(1), R = edge(-1)
  const a = llaToVec(L[0], L[1], 0), b = llaToVec(R[0], R[1], 0)
  const out = new Float32Array((K + 1) * 3)
  // 左缘 → 右缘沿渲染球面大圆等分（slerp）。两缘同在过星下点、垂直航向的那条大圆上，中点即星下点附近。
  const d = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1)
  const th = Math.acos(d), sn = Math.sin(th)
  for (let j = 0; j <= K; j++) {
    const t = j / K
    let x, y, z
    if (sn < 1e-6) { x = a.x + (b.x - a.x) * t; y = a.y + (b.y - a.y) * t; z = a.z + (b.z - a.z) * t }
    else { const w0 = Math.sin((1 - t) * th) / sn, w1 = Math.sin(t * th) / sn; x = a.x * w0 + b.x * w1; y = a.y * w0 + b.y * w1; z = a.z * w0 + b.z * w1 }
    const m = Math.sqrt(x * x + y * y + z * z) || 1
    out[j * 3] = x / m; out[j * 3 + 1] = y / m; out[j * 3 + 2] = z / m
  }
  return out
}
