// 覆盖圈的两种口径（波束角 / 最低仰角），从 ConstellationMap3D 的 footprintAtEcef 抽出来。
// ★ 抽出来是因为聚焦几何 Worker 也要按同一口径算 —— 两处各写一遍，改一处忘一处就是画面上看不出来的错。
//   页面那份现在只负责把 fpMode/beam/elevMin 三个 ref 读成参数，几何本身只有这一份。
import * as W from '../wgs84.js'

const DEG = Math.PI / 180
const RE = 6371
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ecef: 卫星 ECEF(km)；hKm: 轨道高度；seg: 足迹分段数（多选时按颗数摊薄，省略取满细节 72）
// opt: { mode:'beam'|'elev', beamDeg, elevDeg }  —— beamDeg 为空/非正即取该星的对地全视场
// lim: 可选出参，回填 { bMaxDeg, clampText }（波束角档的 ε=0 上限，供页面回写占位/夹断提示）
// 返回 [{lat, lon}...] 或 null
export function footprintRing(ecef, hKm, seg, opt, lim) {
  if (!ecef || !(hKm > 0)) return null
  const n = seg > 0 ? Math.max(6, Math.round(seg / 2) * 2) : 72   // 取偶数：足迹虚线是隔段取一画一，奇数会丢掉末段
  if (opt && opt.mode === 'elev') {
    const raw = Number(opt.elevDeg)
    const el = raw >= 0 && raw < 90 ? raw : 0
    const ring = W.isoElevationContourAt(ecef, el, Math.round(n * 5 / 3))   // 等仰角环满细节 120（=72×5/3），随 seg 同比摊薄
    return ring ? ring.map(([lon, lat]) => ({ lat, lon })) : null
  }
  const etaMax = Math.asin(clamp(RE / (RE + hKm), -1, 1))
  const bMaxDeg = 2 * etaMax / DEG
  const raw = Number(opt && opt.beamDeg)
  let bDeg, clampText = null
  if (!(raw > 0)) bDeg = bMaxDeg
  else if (raw > bMaxDeg) { bDeg = bMaxDeg; clampText = bMaxDeg.toFixed(1) }
  else bDeg = raw
  if (lim) { lim.bMaxDeg = bMaxDeg; lim.clampText = clampText }
  return W.footprintEllipsoid(ecef, (bDeg / 2) * DEG, n)
}
