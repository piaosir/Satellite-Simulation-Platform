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
// ★ 边缘与瞬时覆盖圈严格同源，不是球近似：最低仰角档走 wgs84.isoElevationSolver（等仰角环逐方位用的就是它），
//   波束角档走 wgs84.footprintHitDir（足迹圈逐方位用的就是它）—— 于是任一时刻的覆盖圈都与带的两缘相切于断面端点。
//   球近似只用来定网格密度（swathK）、求根初值与两臂倾角。
// ★ 纯计算、不碰 DOM：主线程（对星聚焦特效）与 Worker（聚焦选中集）跑同一份。
import { Vector3 } from 'three'
import * as W from '../wgs84.js'
import { beamHalfAngle, elevOf, coverHalfAngleSph, footprintRing } from './focusFootprint.js'
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

// 两臂的包络倾角 cosθ（θ 自航向起量）：覆盖半径 λ 随高度变（偏心轨道）时，扫过区域的侧边界不在「垂直航向」的两点上，
// 而在 cosθ = −λ'/v 的方位上（λ' = dλ/dh·ḣ，v = 星下点地面角速度）—— λ 在涨时两臂后倾、在缩时前倾。
// 推导：p 深入覆盖区的量 λ(t) − dist(p, c(t)) 对 t 取极值 ⇔ λ' + v·cosθ_p = 0。圆轨道 λ'≈0 → θ=90°，即垂直横断面。
// 实测量级：GPS（e=0.012）|cosθ| ≈ 0.003，与垂直无异；Molniya 近地点后 ≈ 0.37，两臂后倾 22°，垂直断面的两缘整段落在
// 下一时刻的覆盖区里（带在变宽处漏填、轮廓被裁掉）。
// 缺速度信息（手搓的点）取垂直；夹在 ±TILT_MAX：|λ'| ≥ v 时覆盖区在原地膨胀、侧边界退化，那几步由圆盘兜。
const TILT_MAX = 0.9
function tiltCos(pt, fpOpt) {
  const gs = pt.gs, hd = pt.hd
  if (!(gs > 1e-9) || !Number.isFinite(hd) || !(pt.h > 1)) return 0
  const dl = coverHalfAngleSph(pt.h + 0.5, fpOpt) - coverHalfAngleSph(pt.h - 0.5, fpOpt)   // rad/km（±0.5 km 中心差分）
  return clamp(-dl * hd / gs, -TILT_MAX, TILT_MAX)
}

// 一个采样点的横向几何框架：卫星 ECEF、地心方向 u、航向 d、左法向 n = u × d（面朝航向、天顶朝上的左手边，均在 u 的切平面内）、
// 两臂倾角 ct/st。无从下笔（高度非正 / 位置无效）返回 null。pt = { lat, lon, h, az, gs?, hd? }
function motionFrame(pt, fpOpt) {
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
  const ct = tiltCos(pt, fpOpt), st = Math.sqrt(1 - ct * ct)
  return { S, ux, uy, uz, dx, dy, dz, nx, ny, nz, ct, st }
}
// motionFrame + 「沿切向单位方向 w 取覆盖边缘点」edgeAt(wx, wy, wz) → [lat, lon]（大地 °）—— 与瞬时覆盖圈逐方位同一份解算。
// 最低仰角档逐次拿上一个根作初值（沿方位连续取样时收敛最快），首次用球近似。卫星在地表之下时返回 null。
function sectionFrame(pt, fpOpt) {
  const F = motionFrame(pt, fpOpt)
  if (!F) return null
  const { S, ux, uy, uz } = F
  let edgeAt
  if (fpOpt && fpOpt.mode === 'elev') {
    const sol = W.isoElevationSolver(S, elevOf(fpOpt.elevDeg))
    if (!sol) return null
    let guess = coverHalfAngleSph(pt.h, fpOpt)   // 球近似作初值：与椭球解相差不到千分之三，落在求根器的窄窗之内
    edgeAt = (wx, wy, wz) => { guess = sol.solve(wx, wy, wz, guess); const g = sol.geoOn(sol.surfAt(wx, wy, wz, guess)); return [g[1], g[0]] }
  } else {
    const eta = beamHalfAngle(pt.h, fpOpt && fpOpt.beamDeg)
    const ce = Math.cos(eta), se = Math.sin(eta)
    edgeAt = (wx, wy, wz) => {
      const hit = W.footprintHitDir(S, [-ce * ux + se * wx, -ce * uy + se * wy, -ce * uz + se * wz])
      const gd = W.ecefToGeodetic(hit[0], hit[1], hit[2])
      return [gd.lat, gd.lon]
    }
  }
  F.edgeAt = edgeAt
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
// fpOpt 同 footprintRing 的 opt。返回 Float32Array((K+1)·3)：渲染球面上的单位矢量（与 llaToVec 同一套坐标，Y 是极轴），
// 左缘在前、右缘在后、第 K/2 个恰是星下点 —— 左臂 左缘→星下点、右臂 星下点→右缘，各沿大圆等分。无从下笔返回 null。
export function sectionOf(pt, fpOpt, K) {
  if (!(K >= 1)) return null
  const F = sectionFrame(pt, fpOpt)
  if (!F) return null
  const L = F.edgeAt(F.ct * F.dx + F.st * F.nx, F.ct * F.dy + F.st * F.ny, F.ct * F.dz + F.st * F.nz)
  const R = F.edgeAt(F.ct * F.dx - F.st * F.nx, F.ct * F.dy - F.st * F.ny, F.ct * F.dz - F.st * F.nz)
  const a = llaToVec(L[0], L[1], 0), b = llaToVec(R[0], R[1], 0), c = llaToVec(pt.lat, pt.lon, 0)
  const out = new Float32Array((K + 1) * 3)
  const half = K >> 1
  if (!half) { for (let j = 0; j <= K; j++) slerpInto(out, j * 3, a.x, a.y, a.z, b.x, b.y, b.z, j / K); return out }
  for (let j = 0; j <= half; j++) slerpInto(out, j * 3, a.x, a.y, a.z, c.x, c.y, c.z, j / half)
  for (let j = half + 1; j <= K; j++) slerpInto(out, j * 3, c.x, c.y, c.z, b.x, b.y, b.z, (j - half) / (K - half))
  return out
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
// secs: 每个采样点一条横断面（sectionOf 产出，可为 null）。
// 返回 { n, K, secs(定向后), rev, kind, spans, runs, allStill }
//  kind[i]：步 i→i+1 的性质，1＝平移、2＝转弯、3＝原地、0＝断面缺失；spans / runs：连续平移步 / 非平移步覆盖的断面下标区间 [a, b]
export function swathLayout(secs, K) {
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
    if (!a || !b) continue
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
  const near = (s) => {                  // 已有盘里离这条断面的星下点不到 DISC_DUP×半宽的
    const w = halfWidthOf(s, c)
    for (const d of discs) if (Math.acos(clamp(s[c] * d.cx + s[c + 1] * d.cy + s[c + 2] * d.cz, -1, 1)) <= DISC_DUP * w) return true
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
    discs.push({ i, lat: q.lat, lon: q.lon, ring, cap, cx: s[c], cy: s[c + 1], cz: s[c + 2] })
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
  // 端帽：每段连续断面的首尾 —— 窗口起点（当前时刻）与终点的覆盖圈
  for (let i = 0; i < n;) {
    if (!secs[i]) { i++; continue }
    let j = i
    while (j + 1 < n && secs[j + 1]) j++
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
const CUT_ITERS = 18                   // 交界点二分次数：区间 ≤ 几度 → 收到 1e-5 度量级
// 覆盖判据（与断面边缘同一份椭球口径）：inside(x, y, z) —— 渲染球面单位矢量处的地面点是否在某个采样时刻的覆盖区里。
// 采样取轨迹点本身；相邻两点间隔超过 λ/2 时插点（多选降采样档 LEO 一步 15°，只拿原点的话盘都接不上）。
// ★ 查询是沿候选折线连续走的：离上一个锚点 NEAR_R 以内就共用一张「可能盖到它的样本」邻域表，走远了才重建 ——
//   否则每个候选点都要把整条轨迹扫一遍（LEO 一圈 121 个样本 × 几百个候选点，每拍每颗 0.3 ms）。
//   样本上千（多圈 LEO）时邻域表经空间网格建，不做全表扫。
function coverTester(pts, fpOpt) {
  const elev = !!(fpOpt && fpOpt.mode === 'elev')
  const e0 = elev ? elevOf(fpOpt.elevDeg) * Math.PI / 180 : 0
  const beamDeg = fpOpt && fpOpt.beamDeg
  // 每个样本 10 个数：卫星 ECEF（S）、|S|、星下点渲染单位矢量（C）、粗筛余弦、判据阈值、邻域表余弦 —— 平铺在一块定长数组里
  const buf = []
  let lamMax = 0
  const add = (lat, lon, h, lam) => {
    const S = W.geodeticToEcef(lon, lat, h), c = llaToVec(lat, lon, 0), rho = RE / (RE + h)
    // 地面裕度 OUT_TOL 按球近似折成该口径的量：最低仰角档折成仰角、波束角档折成离天底角，加到判据上
    let thr
    if (elev) {
      const el = (psi) => Math.atan2(Math.cos(psi) - rho, Math.sin(psi))
      thr = Math.sin(e0 + Math.max(0, el(Math.max(0, lam - OUT_TOL)) - el(lam)))
    } else {
      const off = (psi) => Math.atan2(Math.sin(psi), 1 / rho - Math.cos(psi))
      const eta = beamHalfAngle(h, beamDeg)
      thr = Math.cos(Math.max(0, eta - Math.max(0, off(lam) - off(Math.max(0, lam - OUT_TOL)))))
    }
    buf.push(S[0], S[1], S[2], Math.sqrt(S[0] * S[0] + S[1] * S[1] + S[2] * S[2]), c.x, c.y, c.z,
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
  const D = Float64Array.from(buf), n = D.length / 10
  // 空间网格（样本上千才建）：格宽 = 邻域表半径的弦长，重建邻域表只看锚点所在格与周围 26 格
  const g = 2 * Math.sin(Math.min(Math.PI, lamMax + REJ_PAD + NEAR_R) / 2)
  let grid = null
  if (n > 600 && g < 0.6) {
    grid = new Map()
    for (let j = 0; j < n; j++) {
      const o = j * 10
      const key = ((Math.floor(D[o + 4] / g) + 1024) * 2048 + (Math.floor(D[o + 5] / g) + 1024)) * 2048 + (Math.floor(D[o + 6] / g) + 1024)
      let a = grid.get(key); if (!a) grid.set(key, a = []); a.push(j)
    }
  }
  const near = new Int32Array(Math.max(1, n))
  let nNear = 0, ax = 0, ay = 0, az = 0, anchored = false
  const cosNear = Math.cos(NEAR_R)
  const pick = (j) => { const o = j * 10; if (ax * D[o + 4] + ay * D[o + 5] + az * D[o + 6] >= D[o + 9]) near[nNear++] = j }
  function rebuild(x, y, z) {
    ax = x; ay = y; az = z; nNear = 0; anchored = true
    if (!grid) { for (let j = 0; j < n; j++) pick(j); return }
    const ix = Math.floor(x / g), iy = Math.floor(y / g), iz = Math.floor(z / g)
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const js = grid.get(((ix + a + 1024) * 2048 + (iy + b + 1024)) * 2048 + (iz + d + 1024))
      if (js) for (const j of js) pick(j)
    }
  }
  // 地面点（渲染球面单位矢量 x,y,z；其纬经就是大地纬经）：大地天顶 N = (x, −z, y)（ECEF 轴序），
  // 椭球面点 P = (Nc·x, −Nc·z, Nc(1−e²)·y)，Nc＝卯酉圈曲率半径 —— 与 geodeticToEcef / geodeticUp 恒等，免三角函数
  function inside(x, y, z) {
    if (!anchored || x * ax + y * ay + z * az < cosNear) rebuild(x, y, z)
    const Nc = W.A / Math.sqrt(1 - W.E2 * y * y)
    const Px = Nc * x, Py = -Nc * z, Pz = Nc * (1 - W.E2) * y
    for (let k = 0; k < nNear; k++) {
      const o = near[k] * 10
      if (x * D[o + 4] + y * D[o + 5] + z * D[o + 6] < D[o + 7]) continue
      const dx = D[o] - Px, dy = D[o + 1] - Py, dz = D[o + 2] - Pz
      const dd = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
      const up = dx * x - dy * z + dz * y
      if (elev ? up > D[o + 8] * dd : up > 0 && (dx * D[o] + dy * D[o + 1] + dz * D[o + 2]) > D[o + 8] * dd * D[o + 3]) return true   // 波束角档：可见、且离天底角小于锥半角（扣裕度）
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
// 端帽弧：pt 处覆盖圈被两臂（方向 ±θ）分成的两段里、背离相邻断面 nb 的那段 —— 起点取背向前进的半边，终点取朝向前进的半边。
// 外侧按【实际位移】（相邻断面的星下点在哪边）判，不单信瞬时航向：轨迹恰在窗口端点处掉头时两者相反。
// 弧上的点直接取该处端帽圆盘的环（ring，与瞬时覆盖圈同一份解算、同一档方位密度）里落在外侧的那一串，不再另行求根；
// 首尾补上该点（定向后）断面 sec 的两个端点 —— 与两缘严丝合缝。
function capArc(pt, fpOpt, ring, sec, nb, K) {
  const F = motionFrame(pt, fpOpt)
  if (!F || !ring || ring.length < 4) return null
  const c = (K >> 1) * 3, k3 = K * 3
  // 航向 d 是 ECEF 分量；渲染坐标 = (X, Z, −Y)（llaToVec 的轴序）
  const back = F.dx * (nb[c] - sec[c]) + F.dz * (nb[c + 1] - sec[c + 1]) - F.dy * (nb[c + 2] - sec[c + 2]) > 0
  const m = ring.length - 1                      // 环首尾同点
  const keep = new Uint8Array(m)
  let nk = 0
  for (let k = 0; k < m; k++) {
    const p = W.geodeticToEcef(ring[k].lon, ring[k].lat, 0)
    const pu = p[0] * F.ux + p[1] * F.uy + p[2] * F.uz
    const wx = p[0] - pu * F.ux, wy = p[1] - pu * F.uy, wz = p[2] - pu * F.uz   // 切平面内的方位矢量
    const cosA = (wx * F.dx + wy * F.dy + wz * F.dz) / (Math.sqrt(wx * wx + wy * wy + wz * wz) || 1)
    if (back ? cosA < F.ct : cosA > F.ct) { keep[k] = 1; nk++ }
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
  // ① 两缘：连续有效断面连成左缘 / 右缘，遇原地步断开
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
    if (i + 1 < n && kind[i] === 3) flush(i)
  }
  flush(n - 1)
  // ②③ 端帽弧：每段连续断面的首尾；首 / 尾那一步原地时航向不可信，交给下面的整圈
  for (let i = 0; i < n;) {
    if (!secs[i]) { i++; continue }
    let j = i
    while (j + 1 < n && secs[j + 1]) j++
    if (j > i) {
      if (kind[i] !== 3 && !(fpOn && i === 0)) { const P = capArc(pts[i], fpOpt, ringAt(i), secs[i], secs[i + 1], K); if (P) cands.push([P, false]) }
      if (kind[j - 1] !== 3) { const P = capArc(pts[j], fpOpt, ringAt(j), secs[j], secs[j - 1], K); if (P) cands.push([P, false]) }
    }
    i = j + 1
  }
  // ④ 原地步两侧的圆盘整圈（含只有一条断面的孤段：它的首尾端帽就是这只盘）
  for (const d of (discs || [])) {
    const i = d.i
    const still = (i + 1 < n && kind[i] === 3) || (i > 0 && kind[i - 1] === 3)
    const lone = (i === 0 || !secs[i - 1]) && (i + 1 >= n || !secs[i + 1])
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

// 一颗星一拍的轨迹面：定向分段 + 圆盘 + 轮廓。pts / secs 同下标（secs[i] = sectionOf(pts[i], fpOpt, K)，可为 null）。
// seg：覆盖圈环的分段数（与瞬时覆盖圈同档）；opt.fpOn：覆盖圈层是否开着（见 swathOutline）。
export function buildSwath(pts, secs, K, fpOpt, seg, opt) {
  const layout = swathLayout(secs, K)
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
