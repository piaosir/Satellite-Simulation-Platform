// 可见性分析（复刻 STK Access / Coverage）—— 纯几何计算核，无 Vue / DOM 依赖，可离线单测。
// 输入：卫星集(satrec) × 目标点集 × 时刻 × 仰角门限 → 该时刻对目标可见的卫星清单。
// 判据与 ConstellationMap3D.vue 的 satElevAt(:2757) 同源（sat.ecfToLookAngles 仰角），
// 此处扩展为「遍历整个卫星集 × 多目标点、取最可见点」，并附星下点/斜距供地图叠加与清单展示。
//
// 双历元约定：真实星按墙钟 now/gmst 解算，自定义/合成星按固定场景历元 ccNow/ccGmst 解算——
// 由调用方在 entry 上打好 _cc 标记并预备两套时刻（见 useVisibility.recompute）。
//
// 星历点序列星（entry = {eph: 表}，没有 rec）：一律经 satPos.propOf(entry) 取传播体——只认 e.rec 的旧写法会让
// 这类星 posAtMs(undefined) 恒为 null、仰角恒 −999，在过境里静默缺席（单测 modelVisEph）。
import sat from '../constellation/satellite.js'
import { posAt, posAtMs, propOf, periodMinOf, overlaysOf } from '../constellation/satPos.js'   // 取位的唯一入口
// 唯一访问引擎（极值夹逼 + 自适应步长；主进程 solveAccessWindows 用同一份的 CJS 镜像）。相对路径：node 单测直接 import 本文件也解析得到
import { elevWindows, observerOf, temeToEcef, satSpeedBound, minDetectMs } from '../../../packages/core/utils/access/accessCore.mjs'
// 球面多边形（建链模块同一份口径：边按经纬度线性、跨日界线展开、面积质心）
import { pgRing, pgCentroid } from '../../../packages/core/models/mapLinkPoints.mjs'

const DEG = Math.PI / 180

// Polygon 目标的代表点：顶点 [[lon,lat],...] 或 [{lat,lon}] → {lat,lon}。
// 与建链模块同一口径（mapLinkPoints.pgCentroid）：画出来那块区域的球面面积质心，跨 ±180° 照常成立；
// 凹多边形质心落在区外时改取区内距边界最远的点。不足 3 个有效顶点返回 null。
export function ringCentroid(pts) {
  if (!Array.isArray(pts) || !pts.length) return null
  const ll = []
  for (const q of pts) {
    const lon = Array.isArray(q) ? q[0] : (q && q.lon)
    const lat = Array.isArray(q) ? q[1] : (q && q.lat)
    if (Number.isFinite(lon) && Number.isFinite(lat)) ll.push([lon, lat])
  }
  const c = pgCentroid(pgRing(ll))
  return c ? { lat: c.lat, lon: c.lon } : null
}

// 单时刻可见性：
//   entries    — [{rec, name, noradId, group, slot?, _cc}]，_cc=true 表示按场景历元解算（自定义/合成星）；
//                slot=GEO 定点标注（'110.5°E'，调用方预置，本核只透传）
//   targets    — [{lat, lon, altKm?}]，评估点集（站/点=1 个；航迹=点串，排得出时刻的航迹 = 此刻载具那一点、飞行带实际高度；
//                Polygon=质心），至少 1 个。altKm = 观测者大地高（缺省 0）
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
    const h = Number.isFinite(t.altKm) ? t.altKm : 0
    obs.push({ lat: t.lat, lon: t.lon, h, gs: { longitude: t.lon * DEG, latitude: t.lat * DEG, height: h } })
  }
  if (!obs.length) return []
  const thr = Number.isFinite(minElevDeg) ? minElevDeg : 0
  const out = []
  for (const e of entries) {
    const cc = e._cc
    const t = cc ? times.ccNow : times.now
    const g = cc ? times.ccGmst : times.gmst
    const pv = posAt(e, t)
    if (!pv || !pv.position) continue
    const ecf = sat.eciToEcf(pv.position, g)
    let best = null
    for (const o of obs) {
      const la = sat.ecfToLookAngles(o.gs, ecf)
      const elev = la.elevation / DEG
      if (!best || elev > best.elevDeg) best = { elevDeg: elev, azDeg: la.azimuth / DEG, rangeKm: la.rangeSat, atLat: o.lat, atLon: o.lon, atH: o.h }
    }
    if (!best || best.elevDeg < thr) continue
    const gd = sat.eciToGeodetic(pv.position, g)
    // 升/降：+30s 再传播、对最可见点算仰角变化符号（只对已通过门限的星，成本小）；|Δ|≈0（GEO/静止）→ null
    let rising = null
    try {
      const t2 = new Date(t.getTime() + 30000)
      const pv2 = posAt(e, t2)
      if (pv2 && pv2.position) {
        const gs2 = { longitude: best.atLon * DEG, latitude: best.atLat * DEG, height: best.atH || 0 }
        const el2 = sat.ecfToLookAngles(gs2, sat.eciToEcf(pv2.position, sat.gstime(t2))).elevation / DEG
        rising = Math.abs(el2 - best.elevDeg) < 0.02 ? null : el2 > best.elevDeg
      }
    } catch { /* ignore */ }
    out.push({
      name: e.name, noradId: e.noradId, group: e.group, slot: e.slot || '',   // slot=GEO 定点标注（调用方预置，纯透传）
      elevDeg: best.elevDeg, azDeg: best.azDeg < 0 ? best.azDeg + 360 : best.azDeg, rangeKm: best.rangeKm, rising,
      atLat: best.atLat, atLon: best.atLon,
      subLon: sat.degreesLong(gd.longitude), subLat: sat.degreesLat(gd.latitude), altKm: gd.height
    })
  }
  out.sort((a, b) => b.elevDeg - a.elevDeg)
  return out
}

// ==================== ACCESS 时段过境（P2；2026-10-17 改走唯一访问引擎）====================
// 每颗星在 [base, base+horizon] 内仰角 ≥ 门限的全部过境窗口，交给 packages/core/utils/access/accessCore.mjs 的
// elevWindows：「仰角极值夹逼 + 自适应步长」——步长 = clamp(仰角不可能翻过门限的时长, Δ = min(P/16, 5 min), …)，
// 贴近门限的区间里靠导数由正转负夹出极大、Brent 精炼到 0.1 s，峰值 ≥ 门限才成窗，AOS / LOS 在单调段上求到 1 ms。
// 旧版固定 90 s 粗扫 + 二分：完整落在两个粗扫格之间的短过境整段丢失（稠密星座高门限下漏 2–6%，最长中断错到 3.4 倍）。
// 现在最短可检出过境 = 2 × 峰值精炼精度 = 0.2 s（accessMinDetectMs）。双历元：真实星用 now、合成星用 ccNow。
//
// 仰角口径不变：El = asin((satEcf − obsEcf)·ẑ_up / |satEcf − obsEcf|)，WGS-84 观测者基（引擎 observerOf，与 ecfToLookAngles 逐式等价）；
// 星位经 satPos.posAtMs（SGP4 直核 / 星历点序列插值 / 叠加星历）。

const JD_UNIX = 2440587.5, MS_PER_DAY = 864e5

/** 过境检测的最短可检出过境时长（ms）：由引擎的峰值精炼精度决定，与星座、门限、时窗无关。 */
export const accessMinDetectMs = () => minDetectMs()

// 目标点 → 引擎观测者基（WGS-84，大地高 altKm 缺省 0）
function observersOf(targets) {
  const obs = []
  for (const t of targets || []) {
    if (!t || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue
    obs.push(observerOf(t.lat, t.lon, Number.isFinite(t.altKm) ? t.altKm : 0))
  }
  return obs
}
// 卫星地固系速度上界：本体（satrec 根数 / 星历表采样）与叠加星历取大
function speedBoundOf(rec) {
  let v = satSpeedBound(rec)
  const ov = rec && !rec.__ephem ? overlaysOf(rec) : null
  if (ov) for (const tab of ov) { const u = satSpeedBound(tab); if (u > v) v = u }
  return v
}
// 移动目标（航迹载具）的观测者：取 tReal 时刻那一点，速度按 +1 s 差分（km/s）。
// 移动目标的扫描步长恒 60 s、格点人人相同（base = now），按真实时刻缓存、全批复用；满了整盘清掉。
function movingObservers(targetsAt, cache) {
  return (tReal) => {
    let o = cache.get(tReal)
    if (o !== undefined) return o
    const p = targetsAt(tReal), q = p && p[0]
    o = null
    if (q && Number.isFinite(q.lat) && Number.isFinite(q.lon)) {
      const a = observerOf(q.lat, q.lon, Number.isFinite(q.altKm) ? q.altKm : 0)
      const p2 = targetsAt(tReal + 1000), q2 = p2 && p2[0]
      if (q2 && Number.isFinite(q2.lat) && Number.isFinite(q2.lon)) {
        const b = observerOf(q2.lat, q2.lon, Number.isFinite(q2.altKm) ? q2.altKm : 0)
        a.vx = b.ox - a.ox; a.vy = b.oy - a.oy; a.vz = b.oz - a.oz
      }
      o = [a]
    }
    if (cache.size > 8192) cache.clear()
    cache.set(tReal, o)
    return o
  }
}

// entries:[{rec|eph,name,noradId,group,slot?,_cc}] · targets:[{lat,lon,altKm?}] · times:{now:Date,ccNow:Date} · horizonSec · minElevDeg
// opts.targetsAt(tMs) → [{lat,lon,altKm?}]：目标随时刻移动（航迹载具，排得出时刻的航迹）时给，tMs 为真实时刻（UTC ms）；
//   合成星按场景历元轴扫描，取目标时换回真实时刻（减 ccNow − now）。给了它 targets 可空
// 多点目标（排不出时刻的航迹 = 航点串）：任一点可见即算，窗口 = 各点窗口的并，峰值取并窗内最高。
// opts.coarseSec 已作废（引擎自适应步长，没有固定粗扫步长了），传了也不看。
// 返回 [{noradId,name,group,slot,windows:[{startMs,endMs,durMin,peakEl,peakMs,truncated}]}]，按首窗开始时刻排序。
//   truncated = 到时窗末仍在过境（窗口被时窗截断）；时窗起点前就已开着的窗 startMs = 起点。
export function accessWindows(entries, targets, times, horizonSec, minElevDeg, opts) {
  const targetsAt = opts && typeof opts.targetsAt === 'function' ? opts.targetsAt : null
  if (!entries || !entries.length || (!targetsAt && (!targets || !targets.length))) return []
  const obs = targetsAt ? null : observersOf(targets)
  if (obs && !obs.length) return []
  const obsCache = targetsAt ? new Map() : null
  const obsReal = targetsAt ? movingObservers(targetsAt, obsCache) : null
  const ccOff = times.ccNow && times.now ? times.ccNow.getTime() - times.now.getTime() : 0
  const thr = Number.isFinite(minElevDeg) ? minElevDeg : 0
  const out = []
  for (const e of entries) {
    const base = (e._cc ? times.ccNow : times.now).getTime(), end = base + horizonSec * 1000
    const rec = propOf(e)   // satrec 或星历点序列表
    const off = e._cc ? ccOff : 0
    const stateAt = (tMs, s) => {
      const jd = tMs / MS_PER_DAY + JD_UNIX
      const pv = posAtMs(rec, tMs, jd)
      if (!pv || !pv.position) return false
      temeToEcef(pv.position, pv.velocity, sat.gstime(jd), s)
      return true
    }
    const r = elevWindows({
      stateAt, obs, obsAt: obsReal ? (tMs) => obsReal(tMs - off) : null,
      thrDeg: thr, t0: base, t1: end, periodMin: periodMinOf(rec), vSat: speedBoundOf(rec)
    })
    const windows = r.windows.map((w) => ({
      startMs: w.startMs, endMs: w.endMs, startMin: (w.startMs - base) / 60000, endMin: (w.endMs - base) / 60000, durMin: (w.endMs - w.startMs) / 60000,
      peakEl: w.peakEl, peakMs: w.peakMs, peakMin: (w.peakMs - base) / 60000, truncated: !!w.truncEnd
    }))
    if (windows.length) out.push({ noradId: e.noradId, name: e.name, group: e.group, slot: e.slot || '', windows })   // slot=GEO 定点标注（调用方预置，纯透传）
  }
  out.sort((a, b) => a.windows[0].startMs - b.windows[0].startMs)
  return out
}

// ==================== 时间覆盖（ACCESS 严口径）====================
// 把 accessWindows 产出的全部过境窗口在【相对时间轴】上合并去重 → 可见总时长 ÷ 时窗 = 时间覆盖百分比。
// 「严」体现在三条，缺一条数就虚：
//   ① 合并重叠：多星（或同星多窗）同时可见只计一次。直接把 durMin 求和会重复计数、可以超 100%，那不是覆盖率。
//   ② 边界取 accessWindows 精炼后的 AOS/LOS（1 ms），不用采样格点凑。
//   ③ 分母取【实际使用的时窗】（调用方 clamp 后的值），窗口一律夹到 [0, horizonMin]——被时窗切断的
//      过境（truncated）只按落在窗内的那一段计入。
// 双历元：真实星按 now、合成星按 ccNow 解算，两者的 startMin/endMin 都是「相对各自基准的分钟」，
// 故在相对轴上合并（与甘特图同一根轴），不混用绝对时刻。
// 中断（gap）含首尾——与 coverageGrid 的 revisit FOM 同口径：时窗开头/末尾没覆盖也算一段中断。
// 窗口来自唯一访问引擎（极值夹逼，不依赖过境长短）：短于 accessMinDetectMs（0.2 s）的过境才可能检不出，与过境清单同一份窗口。
// 返回 { pct, coveredMin, horizonMin, maxGapMin, gapCount }
export function timeCoverage(results, horizonMin) {
  const H = Number(horizonMin)
  if (!(H > 0)) return { pct: 0, coveredMin: 0, horizonMin: 0, maxGapMin: 0, gapCount: 0 }
  const iv = []
  for (const s of results || []) {
    for (const w of (s && s.windows) || []) {
      let a = Number(w.startMin), b = Number(w.endMin)
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      if (a < 0) a = 0
      if (b > H) b = H
      if (b > a) iv.push([a, b])
    }
  }
  iv.sort((p, q) => p[0] - q[0])
  let cov = 0, maxGap = 0, gapCount = 0, cur = 0   // cur = 已合并到的右端（时间游标）
  for (let i = 0; i < iv.length; i++) {
    const a = iv[i][0], b = iv[i][1]
    if (a > cur) { const g = a - cur; if (g > maxGap) maxGap = g; gapCount++; cur = a }   // (cur,a) 为一段中断
    if (b > cur) { cov += b - cur; cur = b }                                             // 重叠部分不重复计入
  }
  if (cur < H) { const g = H - cur; if (g > maxGap) maxGap = g; gapCount++ }              // 尾段中断
  const pct = Math.max(0, Math.min(100, cov / H * 100))
  return { pct, coveredMin: cov, horizonMin: H, maxGapMin: maxGap, gapCount }
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
