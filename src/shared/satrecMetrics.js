// 卫星几何量的单一真值源：satrec / 星历采样表 → { incl, periodMin, meanMotion, ecc, apogeeKm, perigeeKm }。
//
// 【为什么单拆一个文件】信息卡（ConstellationMap3D.cardFor）与「查找卫星」筛选器（shared/satFilter.js
//   的 metricsOf）原来各写一份算式：前者只认 satrec，后者只认一种【搜索池里根本不存在】的扁平形状
//   （{ incl, meanMotion, ecc, apogeeKm, perigeeKm }）—— 于是同一颗星在卡片上有倾角、在筛选里却没有，
//   没下载编目时按倾角筛一颗都命中不了。两处改走本文件同一份算式，谁也不再自己换算单位。
//
// 【口径】
//   近 / 远地点一律是【高度】（km，地心距减赤道半径），与 SATCAT 的 PERIGEE / APOGEE 同口径，不是地心距。
//   倾角 [0,180]（逆行保留不折叠；折叠由 orbitClass.foldInclination 在需要时做）。
//   取不到的量一律 null —— 不拿整段时长冒充周期、不拿不足一圈的端点冒充近远地点。
// 【satrec 侧单位】（viz/constellation/satellite.js）：no = rad/min、inclo = rad、
//   alta / altp = 高度 ÷ 地球半径（satrec.a 以地球半径为单位，两者都已减 1）。

import { estimatePeriodMin } from '../viz/constellation/ephemTable.js'

// satrec 内部基准是 WGS72 的 6378.135，这里沿用信息卡既有取值 6378.137（差 2 m，是既有口径差）
const RE = 6378.137
const DEG = Math.PI / 180
const TWO_PI = Math.PI * 2
const num = (v) => (Number.isFinite(v) ? v : null)

// 平均运动（rad/min）→ 周期（min）。satPos.periodMinOf 的热路径也用它，别再写第二份。
export const periodMinFromNo = (no) => (Number(no) > 0 ? TWO_PI / Number(no) : null)

// satrec（SGP4 平根数）→ 六项；不是 satrec / 根数不可用返回 null。
export function metricsFromSatrec(s) {
  if (!s || !(Number(s.no) > 0) || !Number.isFinite(Number(s.inclo))) return null
  const periodMin = periodMinFromNo(s.no)
  return {
    incl: num(Number(s.inclo) / DEG),
    periodMin: num(periodMin),
    meanMotion: periodMin > 0 ? num(1440 / periodMin) : null,
    ecc: num(Number(s.ecco)),
    apogeeKm: num(Number(s.alta) * RE),
    perigeeKm: num(Number(s.altp) * RE)
  }
}

// 表内轨道面法向 → 倾角（°）。有速度用 r×v；没有就找一个与首点夹角够大的位置点做 r0×r1
// （夹角太小时叉乘会被舍入吃掉）。取不到返回 null。
function inclFromTable(tab) {
  const p = tab.p, v = tab.v, n = tab.n
  const r0 = [p[0], p[1], p[2]], n0 = Math.hypot(r0[0], r0[1], r0[2])
  if (!(n0 > 0)) return null
  let b = null
  if (v && (v[0] || v[1] || v[2])) b = [v[0], v[1], v[2]]
  else {
    for (let i = 1; i < n; i++) {
      const c = [p[3 * i], p[3 * i + 1], p[3 * i + 2]]
      const nc = Math.hypot(c[0], c[1], c[2])
      if (nc > 0 && (r0[0] * c[0] + r0[1] * c[1] + r0[2] * c[2]) / (n0 * nc) < 0.996) { b = c; break }   // 夹角 > 5°
    }
  }
  if (!b) return null
  const hx = r0[1] * b[2] - r0[2] * b[1], hy = r0[2] * b[0] - r0[0] * b[2], hz = r0[0] * b[1] - r0[1] * b[0]
  const h = Math.hypot(hx, hy, hz)
  if (!(h > 0)) return null
  return Math.acos(Math.max(-1, Math.min(1, hz / h))) / DEG
}

// 星历采样表 → 六项：周期由表内相邻两次升交点估（ephemTable.estimatePeriodMin，与主进程
// ephemInterp.js 那一份逐字相同），近远地点高度由【整表地心距极值】减 RE，倾角由轨道面法向。
// 结果缓存在表上（表一经 tableFrom 建好就不再变），逐拍筛选 / 逐拍取周期不重复扫全表。
export function metricsFromEphem(tab) {
  if (!tab || !tab.__ephem || !(tab.n >= 2)) return null
  if (tab._metrics) return tab._metrics
  const t = tab.t, p = tab.p, n = tab.n
  const periodMin = estimatePeriodMin(tab)
  let apogeeKm = null, perigeeKm = null
  // 只有整表跨过至少一整圈才敢说极值就是近远地点（不足一圈的极值只是那一段的端点）
  if (periodMin != null && periodMin > 0 && t[n - 1] - t[0] >= periodMin * 60000) {
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(p[3 * i], p[3 * i + 1], p[3 * i + 2])
      if (r < lo) lo = r
      if (r > hi) hi = r
    }
    if (Number.isFinite(lo) && Number.isFinite(hi)) { apogeeKm = hi - RE; perigeeKm = lo - RE }
  }
  const out = {
    incl: num(inclFromTable(tab)),
    periodMin: num(periodMin),
    meanMotion: periodMin != null && periodMin > 0 ? num(1440 / periodMin) : null,
    ecc: null,                                   // 偏心率由调用方按近远地点反算（见 satFilter.metricsOf）
    apogeeKm: num(apogeeKm),
    perigeeKm: num(perigeeKm)
  }
  try { tab._metrics = out } catch { /* 冻结的表：不缓存也照样对 */ }
  return out
}

// entry / 裸传播体 → 六项。{ rec: satrec } / { eph: 表 } / 裸 satrec / 裸表 四种都收；认不出返回 null。
// 判形顺序与 viz/constellation/satPos.js 的 propOf 一致（星历表优先），别在调用方各写一份分支。
export function metricsFromEntry(x) {
  if (!x) return null
  if (x.__ephem) return metricsFromEphem(x)
  if (x.eph) return metricsFromEphem(x.eph)
  if (x.rec) return metricsFromSatrec(x.rec)
  if (x.no !== undefined && x.inclo !== undefined) return metricsFromSatrec(x)
  return null
}

export default { metricsFromSatrec, metricsFromEphem, metricsFromEntry, periodMinFromNo, RE }
