// 图上链路的跳几何（仰角 / 斜距 / 视线遮挡）：「链路」视图每拍的读数与渲染（useMapLinks.compute）、
// 节点选择器的候选排序与读数（linkPickSource）共用这一份口径。
//
// 端点 p = { ground: bool, lat, lon, ecef: [x, y, z], altKm? }：地面端（站 / 点 / Polygon / 航迹的代表点）lat / lon 为大地坐标、
// 高度 altKm（缺省 0；飞行航迹的代表点在空中，仰角按该高度处的当地水平面算、ecef 也带高度）；卫星 ecef 为此刻位置（km）。

import * as W from '../wgs84.js'

const RE_LOS = W.A   // 星间视线遮挡判据：线段到地心的最近距离 ≥ 赤道半径（几何遮挡，不另加大气余量）
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len3 = (a) => Math.sqrt(dot3(a, a))

/** 线段 a → b 到地心的最近距离（km） */
export function segCenterDist(a, b) {
  const d = sub3(b, a), dd = dot3(d, d)
  if (!(dd > 0)) return len3(a)
  let t = -dot3(a, d) / dd
  t = t < 0 ? 0 : (t > 1 ? 1 : t)
  return len3([a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t])
}

/**
 * 一跳 a → b：{ el, rangeKm, vis }。
 *   地面端 ↔ 星：el = 星在地面端处的仰角（°），vis = el ≥ minEl；
 *   星 ↔ 星：el = null，vis = 视线不擦地球；地面端 ↔ 地面端：非法跳，vis = false。
 */
export function hopGeom(a, b, minEl) {
  const rangeKm = len3(sub3(b.ecef, a.ecef))
  const th = Number(minEl) || 0
  if (a.ground && !b.ground) { const el = W.elevationDeg(a.lon, a.lat, b.ecef, a.altKm > 0 ? a.altKm : 0); return { el, rangeKm, vis: el >= th } }
  if (!a.ground && b.ground) { const el = W.elevationDeg(b.lon, b.lat, a.ecef, b.altKm > 0 ? b.altKm : 0); return { el, rangeKm, vis: el >= th } }
  if (!a.ground && !b.ground) return { el: null, rangeKm, vis: segCenterDist(a.ecef, b.ecef) >= RE_LOS }
  return { el: null, rangeKm, vis: false }
}

/**
 * 候选 cand 放进插入位后与前后邻各成一跳（邻居没给 / 位置解析不到的那一侧不算）：
 *   { el, rangeKm, vis, n }
 *   el      = 站星跳里最低的那个仰角（没有站星跳为 null）——两跳都要过门限，读数报短板；
 *   rangeKm = 星间跳的距离，两跳都是星间时取较远的（没有星间跳为 null）；
 *   vis     = 算到的跳全部可见；n = 算到几跳（0 = 没有可比的邻居：不排序、不出读数）。
 */
export function slotFit(prev, cand, next, minEl) {
  let el = null, rangeKm = null, vis = true, n = 0
  if (!cand) return { el, rangeKm, vis: false, n }
  for (const [a, b] of [[prev, cand], [cand, next]]) {
    if (!a || !b) continue
    const h = hopGeom(a, b, minEl)
    n++
    if (!h.vis) vis = false
    if (h.el != null) el = el == null ? h.el : Math.min(el, h.el)
    else if (!a.ground && !b.ground) rangeKm = rangeKm == null ? h.rangeKm : Math.max(rangeKm, h.rangeKm)
  }
  return { el, rangeKm, vis: n > 0 && vis, n }
}

/**
 * 候选排序（稳定排序配合使用）：算得出几何的在前；其中可见的在前；同档按仰角降序（有站星跳）、否则按星间距离升序。
 * 两边都算不出几何（没有邻居）返回 0 —— 保持来源顺序。
 */
export function cmpFit(fa, fb) {
  const ha = !!(fa && fa.n), hb = !!(fb && fb.n)
  if (ha !== hb) return ha ? -1 : 1
  if (!ha) return 0
  if (fa.vis !== fb.vis) return fa.vis ? -1 : 1
  if (fa.el != null && fb.el != null && fa.el !== fb.el) return fb.el - fa.el
  if (fa.rangeKm != null && fb.rangeKm != null && fa.rangeKm !== fb.rangeKm) return fa.rangeKm - fb.rangeKm
  return 0
}
/** 只分可见 / 不可见两档、档内保持来源顺序（检索结果用：命中顺序本身就是相关度）。 */
export function cmpVis(fa, fb) {
  const va = !!(fa && fa.n && fa.vis), vb = !!(fb && fb.n && fb.vis)
  return va === vb ? 0 : (va ? -1 : 1)
}

/** 距离读数：≥ 1 万 km 千分位取整、≥ 1000 km 取整、其余一位小数 */
export const fmtKm = (v) => (v >= 10000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 1000 ? 0 : 1)) + ' km'
