// 星地斜距 ⇄ 轨道高度 ⇄ 仰角 的闭式换算（渲染端）。两套模型并存，各有各的用处：
//
//   ① 球模型（slantFromAlt / altFromSlant / nadirAngleDeg / centralAngleDeg）
//      半径 Re=6378.137 的球、站点在球面上。与引擎 packages/core/utils/linkCalculatorNGSO.js 的
//      slantRangeFromAltitude / altitudeFromSlantRange 同一套公式、同一个半径（主进程那份是 CommonJS，
//      渲染端用不了，故镜像一份）。★ 改动必须两边同步。只在赤道 + 海平面站点上与真实椭球逐位相等。
//
//   ② WGS-84 椭球（wgs84Geometry / slantWgs84Max）—— 「斜距工具」用的就是这一套。
//      真实站点的地心距随纬度变（两极比赤道小 21.4 km），且椭球法线不过地心，于是同一 (纬度, 仰角,
//      轨道高度) 下斜距还随【方位】变，峰峰值可达 41 km。手动几何里没有方位这个量（星在动），
//      故取【绕站一圈的最大值】——与「最差工况」口径一致，也消掉了「手动比自动乐观」的系统性偏差
//      （平台的自动几何走 ngsoGeometry.js 的 geodeticToEcef，本就是椭球精确解）。
//
// 几何（三角形：地心 O、卫星 S、站点 P）：
//   球模型  sin η = Re·cos ε /(Re+h)、η+γ+ε = 90°、d = −Re·sin ε + √(Re²·sin²ε + h² + 2·Re·h)
//   椭球    局部基 (ê 东, n̂ 北, û 天顶=椭球法线) 下 P·ê = 0、P·n̂ = −N·e²·sinφ·cosφ、
//           P·û = a√(1−e²sin²φ) + h_站；视线 ŝ = cos ε(cos A·n̂ + sin A·ê) + sin ε·û；
//           由 |P + d·ŝ| = a + h 解得 d = −(P·ŝ) + √((P·ŝ)² + r² − |P|²)。
//           d 对 (P·ŝ) 单调减、而 P·ŝ 对 cos A 线性 ⇒ 最大斜距必在 cos A = ±1（北半球正北 / 南半球正南），
//           故最大值有闭式，不必扫方位。

export const RE_KM = 6378.137        // WGS-84 赤道半径 a（球模型也用它；与引擎、grdSampler 同源）
const B_KM = 6356.7523142            // WGS-84 极半径 b
const E2 = 1 - (B_KM * B_KM) / (RE_KM * RE_KM)   // 第一偏心率平方 e² = 1 − (b/a)²
const D2R = Math.PI / 180
const C_KMS = 299792.458

const clampElev = (v) => Math.max(0, Math.min(90, Number(v) || 0))

// ============ ① 球模型（引擎镜像）============

// 轨道高度 + 仰角 → 斜距（km）。高度非正返回 null。
export function slantFromAlt(altKm, elevDeg) {
  const h = Number(altKm)
  if (!(h > 0)) return null
  const s = Math.sin(clampElev(elevDeg) * D2R)
  return -RE_KM * s + Math.sqrt(RE_KM * RE_KM * s * s + h * h + 2 * RE_KM * h)
}

// 斜距 + 仰角 → 轨道高度（km）。斜距非正返回 null。
// 手动几何回填「等效轨道高度」用它（只喂链路视图作示意星位：这样画出来的星恰好落在表里那个斜距上）。
export function altFromSlant(slantKm, elevDeg) {
  const d = Number(slantKm)
  if (!(d > 0)) return null
  const s = Math.sin(clampElev(elevDeg) * D2R)
  return Math.sqrt(RE_KM * RE_KM + d * d + 2 * RE_KM * d * s) - RE_KM
}

// 轨道高度 + 仰角 → 离轴角 η（°，星看站相对天底的夹角）
export function nadirAngleDeg(altKm, elevDeg) {
  const h = Number(altKm)
  if (!(h > 0)) return null
  const sinEta = (RE_KM / (RE_KM + h)) * Math.cos(clampElev(elevDeg) * D2R)
  if (!(sinEta >= 0 && sinEta <= 1)) return null
  return Math.asin(sinEta) / D2R
}

// 轨道高度 + 仰角 → 地心角 γ（°，站点相对星下点）
export function centralAngleDeg(altKm, elevDeg) {
  const eta = nadirAngleDeg(altKm, elevDeg)
  return eta == null ? null : 90 - clampElev(elevDeg) - eta
}

// ============ ② WGS-84 椭球 ============

/**
 * 站在 (纬度, 海拔) 上、以给定仰角看轨道高度 h 的卫星 —— 绕站一圈中【斜距最大】的那个方位的完整几何。
 * @param {number} latDeg      站点大地纬度（°，南半球取负）
 * @param {number} staAltKm    站点海拔（km，缺省 0）
 * @param {number} elevDeg     仰角（°，夹到 [0,90]）
 * @param {number} orbitAltKm  轨道高度（km，相对 a=6378.137 的地心高度，与引擎/几何求解器同口径）
 * @returns {null|{slantKm:number, nadirDeg:number, centralDeg:number, azDeg:number, stationRadiusKm:number}}
 */
export function wgs84Geometry(latDeg, staAltKm, elevDeg, orbitAltKm) {
  const h = Number(orbitAltKm)
  const lat = Number(latDeg)
  if (!(h > 0) || !isFinite(lat)) return null
  const hs = Number(staAltKm) || 0
  const eps = clampElev(elevDeg) * D2R
  const sLat = Math.sin(lat * D2R), cLat = Math.cos(lat * D2R)
  const w = Math.sqrt(1 - E2 * sLat * sLat)
  const pu = RE_KM * w + hs              // P·û（天顶分量）
  const pn = -(RE_KM / w) * E2 * sLat * cLat   // P·n̂（北向分量；北半球为负——大地垂线不过地心）
  const R2 = pu * pu + pn * pn           // |P|²（站点地心距平方）
  const r = RE_KM + h                    // 卫星地心距
  const c0 = r * r - R2
  if (!(c0 > 0)) return null             // 卫星地心距不高于站点：无解
  // 取斜距最大的方位：cos A = +1（北半球，pn<0）/ −1（南半球，pn>0），使 P·ŝ 最小
  const sgn = lat >= 0 ? 1 : -1
  const sn = sgn * Math.cos(eps), su = Math.sin(eps)   // ŝ 在 (n̂, û) 下的分量（ê 分量为 0）
  const pS = sn * pn + su * pu
  const d = -pS + Math.sqrt(pS * pS + c0)
  // 卫星位置（同一平面内的 (n̂, û) 二维坐标）→ 由真实矢量算 η、γ，不套球模型的角度式
  const Sn = pn + d * sn, Su = pu + d * su
  const clamp1 = (v) => Math.max(-1, Math.min(1, v))
  const centralDeg = Math.acos(clamp1((pn * Sn + pu * Su) / (Math.sqrt(R2) * r))) / D2R
  // η = 星上「天底(−S) 与 站点方向(P−S)」的夹角
  const vn = pn - Sn, vu = pu - Su
  const nadirDeg = Math.acos(clamp1((-Sn * vn - Su * vu) / (r * d))) / D2R
  return { slantKm: d, nadirDeg, centralDeg, azDeg: sgn > 0 ? 0 : 180, stationRadiusKm: Math.sqrt(R2) }
}

// 便捷封装：只要那个最大斜距（km）。入参无效返回 null。
export function slantWgs84Max(latDeg, staAltKm, elevDeg, orbitAltKm) {
  const g = wgs84Geometry(latDeg, staAltKm, elevDeg, orbitAltKm)
  return g ? g.slantKm : null
}

/**
 * 上式的逆：给定斜距，反算轨道高度（km）—— 口径同样是「该斜距是绕站一圈的最大值」。
 * 直接由 |P + d·ŝ| 求出卫星地心距再减 a，无需迭代。
 */
export function altFromSlantWgs84(latDeg, staAltKm, elevDeg, slantKm) {
  const d = Number(slantKm), lat = Number(latDeg)
  if (!(d > 0) || !isFinite(lat)) return null
  const hs = Number(staAltKm) || 0
  const eps = clampElev(elevDeg) * D2R
  const sLat = Math.sin(lat * D2R), cLat = Math.cos(lat * D2R)
  const w = Math.sqrt(1 - E2 * sLat * sLat)
  const pu = RE_KM * w + hs
  const pn = -(RE_KM / w) * E2 * sLat * cLat
  const sgn = lat >= 0 ? 1 : -1
  const Sn = pn + d * sgn * Math.cos(eps), Su = pu + d * Math.sin(eps)
  return Math.hypot(Sn, Su) - RE_KM
}

// 斜距 → 单程传播时延（ms）
export function oneWayDelayMs(slantKm) {
  const d = Number(slantKm)
  return d > 0 ? (d / C_KMS) * 1000 : null
}
