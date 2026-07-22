// 可见性分析（复刻 STK Access / Coverage）—— 纯几何计算核，无 Vue / DOM 依赖，可离线单测。
// 输入：卫星集(satrec) × 目标点集 × 时刻 × 仰角门限 → 该时刻对目标可见的卫星清单。
// 判据与 ConstellationMap3D.vue 的 satElevAt(:2757) 同源（sat.ecfToLookAngles 仰角），
// 此处扩展为「遍历整个卫星集 × 多目标点、取最可见点」，并附星下点/斜距供地图叠加与清单展示。
//
// 双历元约定：真实星按墙钟 now/gmst 解算，自定义/合成星按固定场景历元 ccNow/ccGmst 解算——
// 由调用方在 entry 上打好 _cc 标记并预备两套时刻（见 useVisibility.recompute）。
import sat from '../constellation/satellite.js'

const DEG = Math.PI / 180

// 环质心（P1 Polygon 目标用代表点）：顶点 [[lon,lat],...] 或 [{lat,lon}] → {lat,lon}。
// 简单算术平均；跨 ±180° 未做展开（P1 目标点粗定位足够，精确网格采样在 P3 Coverage 阶段实现）。
export function ringCentroid(pts) {
  if (!Array.isArray(pts) || !pts.length) return null
  let sx = 0, sy = 0, n = 0
  for (const q of pts) {
    const lon = Array.isArray(q) ? q[0] : q.lon
    const lat = Array.isArray(q) ? q[1] : q.lat
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    sx += lon; sy += lat; n++
  }
  return n ? { lon: sx / n, lat: sy / n } : null
}

// 单时刻可见性：
//   entries    — [{rec, name, noradId, group, _cc}]，_cc=true 表示按场景历元解算（自定义/合成星）
//   targets    — [{lat, lon}]，评估点集（站/点=1 个；航迹=点串；Polygon=质心），至少 1 个
//   times      — {now, gmst, ccNow, ccGmst}，调用方按双历元预备（真实星 now/gmst；_cc 星 ccNow/ccGmst）
//   minElevDeg — 仰角门限（度）
// 返回：仅可见卫星，按仰角降序
//   [{name, noradId, group, elevDeg, azDeg, rangeKm, atLat, atLon, subLon, subLat, altKm}]
//   其中 elev/az/range/at* 取「该星最可见的那个目标点」（区域可见 = 对区域内至少一点可见，展示最可见者）。
export function computeVisibility(entries, targets, times, minElevDeg) {
  if (!entries || !entries.length || !targets || !targets.length) return []
  // 预建各目标点的观测者（弧度）：一颗星传播一次得 ECEF 后，对所有目标点复用 look-angle（廉价）
  const obs = []
  for (const t of targets) {
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue
    obs.push({ lat: t.lat, lon: t.lon, gs: { longitude: t.lon * DEG, latitude: t.lat * DEG, height: 0 } })
  }
  if (!obs.length) return []
  const thr = Number.isFinite(minElevDeg) ? minElevDeg : 0
  const out = []
  for (const e of entries) {
    const cc = e._cc
    const t = cc ? times.ccNow : times.now
    const g = cc ? times.ccGmst : times.gmst
    let pv
    try { pv = sat.propagate(e.rec, t) } catch { continue }
    if (!pv || !pv.position) continue
    const ecf = sat.eciToEcf(pv.position, g)
    let best = null
    for (const o of obs) {
      const la = sat.ecfToLookAngles(o.gs, ecf)
      const elev = la.elevation / DEG
      if (!best || elev > best.elevDeg) best = { elevDeg: elev, azDeg: la.azimuth / DEG, rangeKm: la.rangeSat, atLat: o.lat, atLon: o.lon }
    }
    if (!best || best.elevDeg < thr) continue
    const gd = sat.eciToGeodetic(pv.position, g)
    // 升/降：+30s 再传播、对最可见点算仰角变化符号（只对已通过门限的星，成本小）；|Δ|≈0（GEO/静止）→ null
    let rising = null
    try {
      const t2 = new Date(t.getTime() + 30000)
      const pv2 = sat.propagate(e.rec, t2)
      if (pv2 && pv2.position) {
        const gs2 = { longitude: best.atLon * DEG, latitude: best.atLat * DEG, height: 0 }
        const el2 = sat.ecfToLookAngles(gs2, sat.eciToEcf(pv2.position, sat.gstime(t2))).elevation / DEG
        rising = Math.abs(el2 - best.elevDeg) < 0.02 ? null : el2 > best.elevDeg
      }
    } catch { /* ignore */ }
    out.push({
      name: e.name, noradId: e.noradId, group: e.group,
      elevDeg: best.elevDeg, azDeg: best.azDeg < 0 ? best.azDeg + 360 : best.azDeg, rangeKm: best.rangeKm, rising,
      atLat: best.atLat, atLon: best.atLon,
      subLon: sat.degreesLong(gd.longitude), subLat: sat.degreesLat(gd.latitude), altKm: gd.height
    })
  }
  out.sort((a, b) => b.elevDeg - a.elevDeg)
  return out
}

// ==================== ACCESS 时段过境（P2）====================
// 对每颗星在 [base, base+horizon] 扫描仰角 ≥ 门限的过境窗口：粗扫(step)符号翻转找窗 → 二分精炼
// AOS/LOS 边界 → 窗内黄金分割找峰仰角。双历元：真实星用 now、合成星用 ccNow。计算量 = 星数 × (horizon/step)，
// 由调用方以 maxSats 限制卫星集大小（大集请先筛选）。
//
// 性能：仰角内核 elevMaxAt 是全流程热点（粗扫每星 horizon/step 次 + 每窗精炼数十次）。三处提速，均不改物理、数值等价：
//   ① 观测者基（buildObservers）：固定目标点的 ECEF + 天顶方向余弦一次性预算，每采样只剩「向量差·天顶 → asin」，
//      免去 ecfToLookAngles 内每次重建 geodeticToEcf(sqrt+三角) 与站点 sin/cos；access 不需方位/斜距，故只算仰角。
//   ② SGP4 直核：ms→JD→tsince 直接调 sat.sgp4，省去 new Date 分配与 propagate/gstime 各算一遍 jday（jday 只算 1 次）。
//      vendored 库未导出 sgp4 时回退 propagate(Date)，数值一致仅略慢。
//   ③ 峰值黄金分割：单峰区间搜索每步仅新增 1 次传播（旧三分法每步 2 次）。

// WGS84 地球（与 satellite.js geodeticToEcf 同参），预建观测者基：ox/oy/oz=站点 ECEF(h=0)；ux/uy/uz=当地天顶方向余弦。
// 仰角判据 El=asin( (satEcf−obsEcf)·ẑ_up / |satEcf−obsEcf| )，与 ecfToLookAngles 的 topZ/rangeSat 逐式等价。
const WGS_A = 6378.137, WGS_B = 6356.7523142
function buildObservers(targets) {
  const f = (WGS_A - WGS_B) / WGS_A, e2 = 2 * f - f * f, obs = []
  for (const t of targets || []) {
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue
    const lat = t.lat * DEG, lon = t.lon * DEG
    const sLat = Math.sin(lat), cLat = Math.cos(lat), sLon = Math.sin(lon), cLon = Math.cos(lon)
    const N = WGS_A / Math.sqrt(1 - e2 * sLat * sLat)
    obs.push({ ox: N * cLat * cLon, oy: N * cLat * sLon, oz: N * (1 - e2) * sLat, ux: cLat * cLon, uy: cLat * sLon, uz: sLat })
  }
  return obs
}

const _sgp4 = (typeof sat.sgp4 === 'function') ? sat.sgp4 : null   // 直核；缺失则走 propagate 回退
const JD_UNIX = 2440587.5, MS_PER_DAY = 864e5, MIN_PER_DAY = 1440, RAD2DEG = 180 / Math.PI
// 某时刻该星对 obs 各点的最大仰角（度）；obs = buildObservers 产物。返回 -999 表示传播失败。
const elevMaxAt = (rec, obs, tMs) => {
  const jd = tMs / MS_PER_DAY + JD_UNIX
  let pv
  try { pv = _sgp4 ? _sgp4(rec, (jd - rec.jdsatepoch) * MIN_PER_DAY) : sat.propagate(rec, new Date(tMs)) } catch { return -999 }
  if (!pv || !pv.position) return -999
  const g = sat.gstime(jd), cg = Math.cos(g), sg = Math.sin(g), p = pv.position
  const ex = p.x * cg + p.y * sg, ey = p.y * cg - p.x * sg, ez = p.z   // ECI→ECEF
  let best = -999
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i], rx = ex - o.ox, ry = ey - o.oy, rz = ez - o.oz
    const rng = Math.sqrt(rx * rx + ry * ry + rz * rz)
    if (rng <= 0) continue
    const el = Math.asin((rx * o.ux + ry * o.uy + rz * o.uz) / rng) * RAD2DEG
    if (el > best) best = el
  }
  return best
}
// 二分找仰角穿越门限的时刻（[aMs,bMs] 端点跨越；aAbove=a 端是否在门限之上）。18 次≈门限时刻精确到 90s/2¹⁸≈0.3ms。
const bisectCross = (rec, obs, aMs, bMs, thr, aAbove) => {
  let lo = aMs, hi = bMs
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if ((elevMaxAt(rec, obs, m) >= thr) === aAbove) lo = m; else hi = m }
  return (lo + hi) / 2
}
// 窗内峰仰角时刻（AOS→LOS 间仰角单峰）：黄金分割搜索，每步仅新增 1 次传播；收敛到 ~0.25s 或 40 步止。
const GR = (Math.sqrt(5) - 1) / 2   // 0.6180339…
const peakInWindow = (rec, obs, aMs, bMs) => {
  let lo = aMs, hi = bMs
  let x1 = hi - GR * (hi - lo), x2 = lo + GR * (hi - lo)
  let f1 = elevMaxAt(rec, obs, x1), f2 = elevMaxAt(rec, obs, x2)
  for (let i = 0; i < 40 && (hi - lo) > 250; i++) {
    if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + GR * (hi - lo); f2 = elevMaxAt(rec, obs, x2) }
    else { hi = x2; x2 = x1; f2 = f1; x1 = hi - GR * (hi - lo); f1 = elevMaxAt(rec, obs, x1) }
  }
  const tPeak = (lo + hi) / 2
  return { peakMs: tPeak, peakEl: elevMaxAt(rec, obs, tPeak) }
}

// entries:[{rec,name,noradId,group,_cc}] · targets:[{lat,lon}] · times:{now:Date,ccNow:Date} · horizonSec · minElevDeg
// 返回 [{noradId,name,group,windows:[{startMs,endMs,durMin,peakEl,peakMs,truncated}]}]，按首窗开始时刻排序。
export function accessWindows(entries, targets, times, horizonSec, minElevDeg, opts) {
  if (!entries || !entries.length || !targets || !targets.length) return []
  const step = ((opts && opts.coarseSec) || 90) * 1000
  const obs = buildObservers(targets)
  if (!obs.length) return []
  const thr = Number.isFinite(minElevDeg) ? minElevDeg : 0
  const out = []
  // 峰值种子 = 窗内粗采样最高的那格：黄金分割只在 [种子±step] 内精炼。多点目标「取各点最大仰角」在合并窗口内
  // 可能双峰（先掠一点顶、再掠另一点顶），全窗单峰搜索会锁错峰；以粗扫全局最高格为种子则稳取真峰，且精炼区间更窄更快。
  const seededPeak = (rec, seedMs, aMs, bMs) => peakInWindow(rec, obs, Math.max(aMs, seedMs - step), Math.min(bMs, seedMs + step))
  for (const e of entries) {
    const base = (e._cc ? times.ccNow : times.now).getTime(), end = base + horizonSec * 1000
    const windows = []
    const el0 = elevMaxAt(e.rec, obs, base)
    let prevMs = base, prevAbove = el0 >= thr
    let startMs = prevAbove ? base : null, pkMs = base, pkEl = el0   // pkMs/pkEl：当前开窗内最高粗采样格
    for (let ms = base + step; ms <= end; ms += step) {
      const el = elevMaxAt(e.rec, obs, ms), above = el >= thr
      if (above && !prevAbove) { startMs = bisectCross(e.rec, obs, prevMs, ms, thr, false); pkMs = ms; pkEl = el }
      else if (above && prevAbove) { if (el > pkEl) { pkEl = el; pkMs = ms } }
      else if (!above && prevAbove && startMs != null) {
        const losMs = bisectCross(e.rec, obs, prevMs, ms, thr, true), pk = seededPeak(e.rec, pkMs, startMs, losMs)
        windows.push({ startMs, endMs: losMs, startMin: (startMs - base) / 60000, endMin: (losMs - base) / 60000, durMin: (losMs - startMs) / 60000, peakEl: pk.peakEl, peakMin: (pk.peakMs - base) / 60000, truncated: false })
        startMs = null
      }
      prevMs = ms; prevAbove = above
    }
    if (prevAbove && startMs != null) { const pk = seededPeak(e.rec, pkMs, startMs, end); windows.push({ startMs, endMs: end, startMin: (startMs - base) / 60000, endMin: (end - base) / 60000, durMin: (end - startMs) / 60000, peakEl: pk.peakEl, peakMin: (pk.peakMs - base) / 60000, truncated: true }) }
    if (windows.length) out.push({ noradId: e.noradId, name: e.name, group: e.group, windows })
  }
  out.sort((a, b) => a.windows[0].startMs - b.windows[0].startMs)
  return out
}

// ACCESS 几何粗筛（不传播，纯轨道要素）：星的轨道能否让目标纬度达到 minElev？剔除倾角/高度到不了目标纬度的星。
// 对密集同倾角星座（Starlink）在中纬目标剔除有限，但对高纬/异倾角目标能砍掉大批，是大集能算的关键第一刀。
const RE_ORB = 6378.137
export function orbitCanReach(rec, targetLatDeg, minElevDeg) {
  if (!rec) return true
  const inclDeg = (rec.inclo || 0) * 180 / Math.PI
  const maxSubLat = inclDeg > 90 ? 180 - inclDeg : inclDeg              // 星下点可达最高纬度 ≈ 倾角
  const aKm = (rec.a || 0) * RE_ORB                                     // satrec.a 以地球半径为单位
  if (!(aKm > RE_ORB)) return true                                     // 异常 → 保守不剔除
  const h = aKm - RE_ORB, eps = (Number(minElevDeg) || 0) * Math.PI / 180
  const lam = Math.acos(Math.max(-1, Math.min(1, RE_ORB / (RE_ORB + h) * Math.cos(eps)))) - eps   // 覆盖地心半角 rad
  return Math.abs(Number(targetLatDeg) || 0) <= maxSubLat + Math.max(0, lam) * 180 / Math.PI + 2  // +2° 余量
}
