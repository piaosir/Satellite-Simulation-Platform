// 覆盖圈的两种口径（波束角 / 最低仰角），从 ConstellationMap3D 的 footprintAtEcef 抽出来。
// ★ 抽出来是因为聚焦几何 Worker 也要按同一口径算 —— 两处各写一遍，改一处忘一处就是画面上看不出来的错。
//   页面那份现在只负责把 fpMode/beam/elevMin 三个 ref 读成参数，几何本身只有这一份。
//
// ★ 两种口径画的是【同一族曲线】：WGS84 等仰角线；波束全锥角 B 只是它的另一种读数（2026-10-21 用户拍板：切换口径画面不变、
//   最大波束角与 0° 仰角重合）。换算式 sin(B/2) = sin η̄ · cos ε，η̄＝该星视角下 WGS84 地平张角的方位平均（wgs84.limbHalfAngleMean）。
//   球形地球上等仰角线就是绕天底的正圆锥、此式精确；椭球上等仰角线不是正圆锥（GEO ε=5° 离天底角沿圈 8.638°~8.667°），
//   任何单一锥角都只能近似它。曾按真圆锥（锥轴＝地心天底）画波束角档：GEO ε=5° 换算过去圈上仰角落在 3.5°~5.8°、偏 160 km，
//   切换口径画面就变；最大波束角与 0° 仰角也是两套采样（72 / 120 段），叠在一起对不齐。
//   此式给出的 B 与圈上平均离天底角 ×2 相差 ≤0.011°（Molniya 远地点 ε=60°；GEO 低仰角 ≤0.001°），在等仰角线自身的离天底角起伏之内。
//   固定 B 时 ε 随星位走（高度 / 纬度一变 η̄ 就变）：逐星逐拍各自换算，波束角档仍是「星上张角固定」的语义。
import * as W from '../wgs84.js'

const DEG = Math.PI / 180
const RE = 6371
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 最低仰角口径的取值归一：越界（负数 / ≥90 / 非数）取 0°＝地平线
export const elevOf = (elevDeg) => { const raw = Number(elevDeg); return raw >= 0 && raw < 90 ? raw : 0 }

// sin(B/2) = sin η̄ · cos ε 解 ε（°），eta＝η̄（rad）。B 空 / 非正 / 达到 2η̄ 以上 → 0（对地全视场＝地平）；B → 0 时 ε → 90° 但恒小于 90°
// ★ 上限按角度比、不按 c ≥ 1 比：B 恰为 2η̄ 时度↔弧度来回一趟 c 会落在 1 − 1e-16，acos 放大成 1e-6° 的仰角，圈就不是逐点地平了
function elevForBeam(eta, beamDeg) {
  const b = Number(beamDeg)
  if (!(b > 0) || b >= 2 * eta / DEG) return 0
  const c = Math.sin(b / 2 * DEG) / Math.sin(eta)
  return c >= 1 || !(c >= 0) ? 0 : Math.acos(c) / DEG
}

// 波束全锥角上限（°）：B 达到它圈就整圈落在地平（ε=0）上
export const beamMaxDeg = (ecef) => 2 * W.limbHalfAngleMean(ecef) / DEG

// 波束全锥角上限（°）的显示文本（输入框 placeholder）：向上取到 0.01° —— 照抄这个数填回去，此刻仍是整圈地平。
// 超限时页面回写空值（＝全视场）而不是这个数：上限随星位变，写死的快照下一刻就可能小于新上限（见 ConstellationMap3D applyBeamLimit）
export const beamLimitText = (bMaxDeg) => (Math.ceil(bMaxDeg * 100 - 1e-9) / 100).toFixed(2)

// 波束全锥角 → 最低仰角（°），按该星此刻的位置。空值 / 达到上限 → 0
export function beamToElevDeg(ecef, beamDeg) {
  return elevForBeam(W.limbHalfAngleMean(ecef), beamDeg)
}
// 最低仰角 → 波束全锥角（°），按该星此刻的位置。ε ≤ 0 → null（＝对地全视场，输入框留空）
export function elevToBeamDeg(ecef, elevDeg) {
  const e = elevOf(elevDeg)
  if (!(e > 0)) return null
  return 2 * Math.asin(clamp(Math.sin(W.limbHalfAngleMean(ecef)) * Math.cos(e * DEG), 0, 1)) / DEG
}
// 该口径此刻对这颗星画的那条等仰角线的仰角（°）—— 覆盖圈、轨迹面的断面与覆盖判据都从这里取
export function coverElevDeg(ecef, opt) {
  return opt && opt.mode === 'elev' ? elevOf(opt.elevDeg) : beamToElevDeg(ecef, opt && opt.beamDeg)
}

// 覆盖半角的【球近似】（地心角 λ，rad）：只用来定网格密度、求根初值与两臂倾角，不用来画。
// 球上 η̄ = asin(RE/r)，波束角按同一式折成仰角，两档在球上本就是同一条圈。
export function coverHalfAngleSph(hKm, opt) {
  if (!(hKm > 0)) return 0
  const rho = RE / (RE + hKm)
  const e = (opt && opt.mode === 'elev' ? elevOf(opt.elevDeg) : elevForBeam(Math.asin(rho), opt && opt.beamDeg)) * DEG
  return Math.acos(clamp(rho * Math.cos(e), -1, 1)) - e
}

// ecef: 卫星 ECEF(km)；hKm: 轨道高度；seg: 足迹分段数（多选时按颗数摊薄，省略取满细节 72）
// opt: { mode:'beam'|'elev', beamDeg, elevDeg }  —— beamDeg 为空/非正即取该星的对地全视场
// lim: 可选出参，回填 { bMaxDeg, clampText }（波束角档：整圈落到地平的全锥角，超出时的回写文本；供页面写占位/夹断）
// 返回 [{lat, lon}...] 或 null
export function footprintRing(ecef, hKm, seg, opt, lim) {
  if (!ecef || !(hKm > 0)) return null
  const n = seg > 0 ? Math.max(6, Math.round(seg / 2) * 2) : 72
  let e
  if (opt && opt.mode === 'elev') e = elevOf(opt.elevDeg)
  else {
    const eta = W.limbHalfAngleMean(ecef)
    if (lim) {
      const bMaxDeg = 2 * eta / DEG
      lim.bMaxDeg = bMaxDeg
      lim.clampText = Number(opt && opt.beamDeg) > bMaxDeg ? beamLimitText(bMaxDeg) : null
    }
    e = elevForBeam(eta, opt && opt.beamDeg)
  }
  const ring = W.isoElevationContourAt(ecef, e, Math.round(n * 5 / 3))   // 满细节 120（=72×5/3），随 seg 同比摊薄；两档同一采样
  return ring ? ring.map(([lon, lat]) => ({ lat, lon })) : null
}
