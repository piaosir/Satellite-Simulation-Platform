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
// AOS/LOS 边界 → 窗内三分找峰仰角。双历元：真实星用 now、合成星用 ccNow。计算量 = 星数 × (horizon/step)，
// 由调用方以 maxSats 限制卫星集大小（大集请先筛选）。

const elevMaxAt = (rec, obs, tMs) => {
  const t = new Date(tMs)
  let pv; try { pv = sat.propagate(rec, t) } catch { return -999 }
  if (!pv || !pv.position) return -999
  const ecf = sat.eciToEcf(pv.position, sat.gstime(t))
  let best = -999
  for (const o of obs) { const el = sat.ecfToLookAngles(o.gs, ecf).elevation / DEG; if (el > best) best = el }
  return best
}
// 二分找仰角穿越门限的时刻（[aMs,bMs] 端点跨越；aAbove=a 端是否在门限之上）
const bisectCross = (rec, obs, aMs, bMs, thr, aAbove) => {
  let lo = aMs, hi = bMs
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if ((elevMaxAt(rec, obs, m) >= thr) === aAbove) lo = m; else hi = m }
  return (lo + hi) / 2
}
// 窗内三分找峰仰角时刻
const peakInWindow = (rec, obs, aMs, bMs) => {
  let lo = aMs, hi = bMs
  for (let i = 0; i < 26; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (elevMaxAt(rec, obs, m1) < elevMaxAt(rec, obs, m2)) lo = m1; else hi = m2 }
  const tPeak = (lo + hi) / 2
  return { peakMs: tPeak, peakEl: elevMaxAt(rec, obs, tPeak) }
}

// entries:[{rec,name,noradId,group,_cc}] · targets:[{lat,lon}] · times:{now:Date,ccNow:Date} · horizonSec · minElevDeg
// 返回 [{noradId,name,group,windows:[{startMs,endMs,durMin,peakEl,peakMs,truncated}]}]，按首窗开始时刻排序。
export function accessWindows(entries, targets, times, horizonSec, minElevDeg, opts) {
  if (!entries || !entries.length || !targets || !targets.length) return []
  const step = ((opts && opts.coarseSec) || 90) * 1000
  const obs = []
  for (const t of targets) { if (Number.isFinite(t.lat) && Number.isFinite(t.lon)) obs.push({ gs: { longitude: t.lon * DEG, latitude: t.lat * DEG, height: 0 } }) }
  if (!obs.length) return []
  const thr = Number.isFinite(minElevDeg) ? minElevDeg : 0
  const out = []
  for (const e of entries) {
    const base = (e._cc ? times.ccNow : times.now).getTime(), end = base + horizonSec * 1000
    const windows = []
    let prevMs = base, prevAbove = elevMaxAt(e.rec, obs, base) >= thr
    let startMs = prevAbove ? base : null
    for (let ms = base + step; ms <= end; ms += step) {
      const above = elevMaxAt(e.rec, obs, ms) >= thr
      if (above && !prevAbove) startMs = bisectCross(e.rec, obs, prevMs, ms, thr, false)
      else if (!above && prevAbove && startMs != null) {
        const losMs = bisectCross(e.rec, obs, prevMs, ms, thr, true), pk = peakInWindow(e.rec, obs, startMs, losMs)
        windows.push({ startMs, endMs: losMs, startMin: (startMs - base) / 60000, endMin: (losMs - base) / 60000, durMin: (losMs - startMs) / 60000, peakEl: pk.peakEl, peakMin: (pk.peakMs - base) / 60000, truncated: false })
        startMs = null
      }
      prevMs = ms; prevAbove = above
    }
    if (prevAbove && startMs != null) { const pk = peakInWindow(e.rec, obs, startMs, end); windows.push({ startMs, endMs: end, startMin: (startMs - base) / 60000, endMin: (end - base) / 60000, durMin: (end - startMs) / 60000, peakEl: pk.peakEl, peakMin: (pk.peakMs - base) / 60000, truncated: true }) }
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
