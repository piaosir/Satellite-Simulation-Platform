// 轨迹面（覆盖带）：覆盖圈口径（波束角 / 最低仰角）沿星下点轨迹扫过的区域 —— 对标 STK 的 swath。
//
// 每个轨迹采样点出一条【横断面】：过星下点、垂直于地面航向的大圆弧，两端是该口径下的椭球覆盖边缘，
// 中间按格边长等分；相邻横断面之间连成三角网就是带面（见 globe3d/focusLanes.js 的 swathFill）。
// ★ 边缘与瞬时覆盖圈严格同源，不是球近似：最低仰角档走 wgs84.isoElevationSolver（等仰角环逐方位用的就是它），
//   波束角档走 wgs84.footprintHitDir（足迹圈逐方位用的就是它）—— 于是任一时刻的覆盖圈横向两个极点都恰好落在
//   带的两条边上。球近似只用来定网格密度（swathK）与求根初值。
// ★ 纯计算、不碰 DOM：主线程（对星聚焦特效）与 Worker（聚焦选中集）跑同一份。
import * as W from '../wgs84.js'
import { beamHalfAngle, elevOf, coverHalfAngleSph, footprintRing } from './focusFootprint.js'
import { llaToVec, vecToLatLon, pushDashed, densifyArc, footprintFill, swathFill, swathEdges, FILL_CELL, LIFT } from '../globe3d/focusLanes.js'

const WE = 7.2921159e-5     // 地球自转角速度 rad/s（与信息卡的对地速度同一常数）
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 地面航向（rad，北起顺时针）：星下点相对【地球】的运动方向。
// pv = satPos.posAt 结果（ECI，km / km·s⁻¹），gmst = 该时刻恒星时。相对速度 v − ω×r 先在 ECI 轴上减掉
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

// ===================== 横断面序列 → 可画的带（三处消费方共用） =====================
// 消费方：computeTick（聚焦选中集，Worker/主线程同一份）、对星覆盖的聚焦特效（页面 focusGeomOfRec →
// scene.setSelectionSet）、2D 平面图（经 swathFlatGeom 出的数据）。逐条横断面直接连四边形有两种退化：
//  ① 航向掉头（星下点轨迹折返处、GEO 原地抖动）：sectionOf 的左右缘随航向互换，相邻断面「左→右」反向，
//     边线在带两侧跳来跳去、四边形自交。→ 相邻断面按「本条左缘更靠近前一条的左缘还是右缘」翻回来（rev）。
//  ② 原地打转：星下点位移抵不过航向转动（GEO 全程如此、Molniya 远地点环、图-8 折返点），相邻两断面围成的
//     四边形是蝴蝶结、逐步叠加把带内涂深（GEO 上那道赤道横带就是它）；而覆盖圈沿轨扫过的并集在这里就是
//     覆盖圈本身。→ 判据：星下点位移不足半宽的 STILL_FRAC（原地）、或沿前进方向左右两缘任一缘没有前进
//     （pL ≤ 0 / pR ≤ 0，四边形自交）即为打转步；连续打转步成一段 run，整段用覆盖圆盘代替四边形（圆心每挪
//     DISC_STEP×半宽补一个盘），边线在 run 处断开。原地那一档是为了 GEO 抖动：逐步位移随机，光看两缘进退会把
//     一整段抖动切成许多小段、每段各落一个盘、段间冒出零长的小边线；按位移量判则整段稳稳归为一个 run。
//     整条轨迹都在打转（GEO）时带面就是一个圆盘，轮廓按轨迹线样式描；覆盖圈层开着时轮廓与它重合，
//     由调用方（outlineOn=false）关掉；带面本身由渲染端压在覆盖圈填充之下不叠色（3D 模板缓冲、2D evenodd 裁剪）。
const DISC_STEP = 0.1
const STILL_FRAC = 1e-3      // 星下点一步挪不到半宽的千分之一（GEO 45° 口径≈0.04°）就算原地；LEO 一步走 3° 以上，碰不到
const reversedSection = (s, K) => {
  const o = new Float32Array(s.length)
  for (let j = 0; j <= K; j++) { const a = j * 3, b = (K - j) * 3; o[a] = s[b]; o[a + 1] = s[b + 1]; o[a + 2] = s[b + 2] }
  return o
}
// secs: 每个采样点一条横断面（sectionOf 产出，可为 null）。返回 { n, K, secs(定向后), rev, kind, spans, runs, allRot }
//  kind[i]：步 i→i+1 的性质，1＝平移、2＝打转、0＝断面缺失；spans / runs：连续平移步 / 打转步覆盖的断面下标区间 [a, b]
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
  let nT = 0, nR = 0
  for (let i = 0; i + 1 < n; i++) {
    const a = out[i], b = out[i + 1]
    if (!a || !b) continue
    const fx = b[c] - a[c], fy = b[c + 1] - a[c + 1], fz = b[c + 2] - a[c + 2]
    const w = Math.acos(clamp(a[c] * a[0] + a[c + 1] * a[1] + a[c + 2] * a[2], -1, 1))   // 半宽（弧度；单位球上弦长≈弧长）
    let r = Math.sqrt(fx * fx + fy * fy + fz * fz) < STILL_FRAC * w   // 原地
    if (!r) {
      const pL = (b[0] - a[0]) * fx + (b[1] - a[1]) * fy + (b[2] - a[2]) * fz
      const pR = (b[k3] - a[k3]) * fx + (b[k3 + 1] - a[k3 + 1]) * fy + (b[k3 + 2] - a[k3 + 2]) * fz
      r = pL <= 0 || pR <= 0
    }
    kind[i] = r ? 2 : 1
    if (r) nR++; else nT++
  }
  const spans = [], runs = []
  for (let i = 0; i + 1 < n;) {
    const kd = kind[i]
    if (!kd) { i++; continue }
    let j = i
    while (j + 1 < n && kind[j] === kd) j++
    ;(kd === 1 ? spans : runs).push([i, j])
    i = j
  }
  return { n, K, secs: out, rev, kind, spans, runs, allRot: nT === 0 && nR > 0 }
}
// 打转段的覆盖圆盘：pts[i] = { lat, lon, h }（与 secs 同下标的采样点），fpOpt 同 footprintRing，seg 为环的分段数。
// 每段从首点起落一个盘，圆心每挪 DISC_STEP×半宽再补一个。返回 [{ i, lat, lon, ring:[{lat,lon}...](闭合) }]
export function swathDiscs(layout, pts, fpOpt, seg) {
  const discs = []
  if (!layout || !layout.runs.length || !pts) return discs
  const K = layout.K, c = (K >> 1) * 3
  for (const [a, b] of layout.runs) {
    let lx = 0, ly = 0, lz = 0, has = false
    for (let i = a; i <= b; i++) {
      const s = layout.secs[i], q = pts[i]
      if (!s || !q) continue
      const mx = s[c], my = s[c + 1], mz = s[c + 2]
      if (has) {
        const w = Math.acos(clamp(mx * s[0] + my * s[1] + mz * s[2], -1, 1))        // 半宽：中点到左缘的角
        const d = Math.acos(clamp(mx * lx + my * ly + mz * lz, -1, 1))
        if (d <= DISC_STEP * w) continue
      }
      const h = q.h != null ? q.h : (q.gd ? q.gd.height : NaN)
      if (!(h > 0) || !Number.isFinite(q.lat) || !Number.isFinite(q.lon)) continue
      const ring = footprintRing(W.geodeticToEcef(q.lon, q.lat, h), h, seg > 0 ? seg : 72, fpOpt)
      if (!ring || ring.length < 3) continue
      const f = ring[0], l = ring[ring.length - 1]
      if (Math.abs(f.lat - l.lat) > 1e-9 || Math.abs(f.lon - l.lon) > 1e-9) ring.push({ lat: f.lat, lon: f.lon })
      discs.push({ i, lat: q.lat, lon: q.lon, ring })
      lx = mx; ly = my; lz = mz; has = true
    }
  }
  return discs
}
// 3D：平移段两缘描边 + 四边形带面；打转段圆盘填充（+ 轮廓，仅 outlineOn）。o = { edge, fill, dash, outlineOn }，sink 可为 null
export function emitSwath3D(layout, discs, o) {
  if (!layout || !(layout.K >= 1)) return
  const K = layout.K
  for (const [a, b] of layout.spans) {
    const part = layout.secs.slice(a, b + 1)
    if (o.edge) {
      const [L, R] = swathEdges(part, K)
      if (L.length > 1) pushDashed(o.edge, densifyArc(L), o.dash)
      if (R.length > 1) pushDashed(o.edge, densifyArc(R), o.dash)
    }
    if (o.fill) swathFill(part, K, o.fill)
  }
  for (const d of (discs || [])) {
    const rv = d.ring.map((q) => llaToVec(q.lat, q.lon, LIFT))
    if (o.fill) footprintFill(rv, { lat: d.lat, lon: d.lon }, o.fill)
    if (o.edge && o.outlineOn) pushDashed(o.edge, densifyArc(rv), o.dash)
  }
}
// 2D 平面图要的形态：swath.ll＝定向后的横断面经纬（每条 K+1 对 lat/lon，缺失为 NaN）、swath.skip＝步 i 不是平移步，
// swL / swR＝两缘折线按平移段切开（[[{lat,lon}...]...]）、swRings＝圆盘环、swOutline＝整轨打转且要描轮廓
export function swathFlatGeom(layout, discs, outlineOn) {
  const K = layout.K, m = K + 1, n = layout.n
  const ll = new Float32Array(n * m * 2)
  for (let i = 0; i < n; i++) {
    const s = layout.secs[i], o = i * m * 2
    if (!s) { ll.fill(NaN, o, o + m * 2); continue }
    for (let a = 0; a < m; a++) { const ge = vecToLatLon(s[a * 3], s[a * 3 + 1], s[a * 3 + 2]); ll[o + a * 2] = ge[0]; ll[o + a * 2 + 1] = ge[1] }
  }
  const skip = new Uint8Array(Math.max(0, n - 1))
  for (let i = 0; i + 1 < n; i++) skip[i] = layout.kind[i] === 1 ? 0 : 1
  const [swL, swR] = swathEdgePolylines(ll, K, skip)
  return { swath: { K, ll, skip }, swL, swR, swRings: (discs || []).map((d) => d.ring), swOutline: !!outlineOn }
}
// 两缘折线：沿断面序列走，skip[i] 为真处断开（打转段不横穿圆盘）。只留 ≥2 点的折线
export function swathEdgePolylines(ll, K, skip) {
  const m = K + 1, n = Math.floor(ll.length / (m * 2))
  const L = [], R = []
  let curL = null, curR = null
  for (let i = 0; i < n; i++) {
    const o = i * m * 2
    if (Number.isFinite(ll[o]) && Number.isFinite(ll[o + 1])) {
      if (!curL) { curL = []; curR = []; L.push(curL); R.push(curR) }
      curL.push({ lat: ll[o], lon: ll[o + 1] }); curR.push({ lat: ll[o + K * 2], lon: ll[o + K * 2 + 1] })
    } else { curL = null; curR = null }
    if (i + 1 < n && skip && skip[i]) { curL = null; curR = null }
  }
  return [L.filter((p) => p.length > 1), R.filter((p) => p.length > 1)]
}
