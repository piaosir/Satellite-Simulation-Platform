// 晨昏线（Terminator）几何 —— 由 UTC 时刻算日下点，再出两样东西：
//   ① 晨昏分界线：太阳几何中心仰角 h=0 的那条大圆
//   ② 夜区：以「反日下点」为心、张角 90° 的球冠（即 h<0 的那半个球）
//
// ── 时刻口径 ──
// 全程 UTC。Date 对象内部本就是 UTC 毫秒数，时区只在格式化时介入，故本机时区设错
// 不影响本模块任何输出（与 SGP4 同理：两份 satellite.js 取时间全程 getUTC*）。
//
// ── 为什么 GMST 复用 sat.gstime() ──
// 刻意与卫星星位用同一个函数、同一个自转相位。这比「绝对角秒精度」更要紧：晨昏线与星下点
// 必须落在同一个旋转参考系里，否则两者之间会有一个恒定相对偏移，叠在一张图上就对不上。
//
// ── 太阳位置精度的诚实边界 ──
// 用 Meeus《Astronomical Algorithms》2nd ed. 第 25 章「低精度」解法，赤经/赤纬误差约 0.01°(36″)
// → 晨昏线位置误差约 1.1 km。对照：全球视图下 1 屏幕像素约 20 km，故不可见。
// 高精度版（VSOP87 截断 + IAU1980 章动，1″）在 packages/core/utils/sunOutageCalculator.js —— 那里
// 需要角秒级，是因为日凌要定「太阳落进波束主瓣」的分秒级窗口；晨昏线不需要，故刻意不把那 150 行
// 系数表镜像过来（渲染端进不了 packages/core 的 CJS，镜像=双份维护）。
// 另：太阳历元参数本应取 TT，这里用 UT（差 ΔT≈69 s）。太阳黄经日行 0.041°，69 s 只错 3.3e-5°，
// 比模型自身的 0.01° 低两个数量级，可忽略。地球自转那一头走 gstime(UT)，口径是对的。
import sat from './constellation/satellite.js'

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

// 春秋分前后 φs→0，tan φs→0 会把 lat(lon) 顶到 ±90° 并让夜区多边形退化。
// 一年只有两个瞬间落在这个邻域（|φs|<0.006° 约持续十几秒），夹一个下限即可，视觉无差别。
const MIN_DEC = 1e-4   // rad，约 0.006°

/**
 * 太阳视赤经/赤纬（Meeus Ch.25 低精度）。
 * @param {Date} date UTC 时刻
 * @returns {{raDeg:number, decDeg:number}}
 */
function sunRaDec(date) {
  const jd = date.getTime() / 86400000 + 2440587.5     // Unix ms → 儒略日
  const T = (jd - 2451545.0) / 36525                   // J2000 起算儒略世纪
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T          // 几何平黄经
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T           // 平近点角
  const Mr = M * RAD
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr)   // 中心差
    + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr)
    + 0.000289 * Math.sin(3 * Mr)
  const omega = (125.04 - 1934.136 * T) * RAD          // 月球升交点：章动+光行差的低阶合并项
  const lamApp = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * RAD   // 视黄经
  const eps0 = 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD // 真黄赤交角（含章动主项）
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lamApp), Math.cos(lamApp)) * DEG
  const dec = Math.asin(Math.sin(eps) * Math.sin(lamApp)) * DEG
  return { raDeg: ((ra % 360) + 360) % 360, decDeg: dec }
}

// 经度归一到 (-180, 180]
const wrapLon = (v) => ((v + 180) % 360 + 360) % 360 - 180

/**
 * 日下点（subsolar point）＋反日下点（夜区中心）。
 * @param {Date} date UTC 时刻
 * @returns {{sub:{lat:number,lon:number}, anti:{lat:number,lon:number}}}
 */
export function solarGeometry(date) {
  const { raDeg, decDeg } = sunRaDec(date)
  const gmstDeg = sat.gstime(date) * DEG               // 与卫星星位同一自转相位（gstime 返回弧度）
  const lon = wrapLon(raDeg - gmstDeg)
  return {
    sub: { lat: decDeg, lon },
    anti: { lat: -decDeg, lon: wrapLon(lon + 180) }
  }
}

/**
 * 晨昏大圆的球面采样（3D 画线用）。
 * 以日下点为心、角距 90° 处按方位角 θ 绕一圈：
 *   sin φ = cos φs · cos θ
 *   λ = λs + atan2(sin θ · cos φs, −sin φs · sin φ)
 * 用方位角做参数（而非经度）→ 春秋分 φs→0 时也不退化，且天然闭合。
 * 已验证两个已知点：夏至 θ=0 → (66.56°N, 反日经度)=北极圈子夜太阳边界；
 * θ=π → (66.56°S, 日下经度)=南极圈正午太阳边界。
 * @param {Date} date UTC 时刻
 * @param {number} steps 采样点数
 * @returns {Array<{lat:number, lon:number}>} 闭合环（首尾不重复）
 */
export function terminatorRing(date, steps = 360) {
  const { sub } = solarGeometry(date)
  const phis = sub.lat * RAD, lams = sub.lon * RAD
  const sinPhis = Math.sin(phis), cosPhis = Math.cos(phis)
  const out = new Array(steps)
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * 2 * Math.PI
    const sinPhi = cosPhis * Math.cos(th)
    const phi = Math.asin(Math.max(-1, Math.min(1, sinPhi)))
    const lam = lams + Math.atan2(Math.sin(th) * cosPhis, -sinPhis * sinPhi)
    out[i] = { lat: phi * DEG, lon: wrapLon(lam * DEG) }
  }
  return out
}

/**
 * 等距圆柱（2D 平面图）下的晨昏线与夜区。
 * 由 sin h = sin φ·sin φs + cos φ·cos φs·cos(λ−λs)，令 h=0 得
 *   tan φ = −cos(λ−λs) / tan φs
 * 即晨昏线纬度是经度的【单值函数】—— 用经度做参数天然不跨日期线、无需断线拼接。
 * 夜区＝曲线朝「暗极」那一侧：φs>0（太阳在北）→ 南极圈一带极夜 → 沿 lat=−90 封口；反之沿 +90。
 * ★ lon0 = 采样起点经度，必须取【地图自己的接缝经度】。平面图的世界横坐标是 x=lon−LON0
 * （flatCoverage.js 的 LON0=−30，即左边缘在西经 30°），若仍从 −180 起采，多边形会正好横跨接缝、
 * 填充时被撕成两半。从接缝起采 → 世界 X 单调 0→360，天然无缝、也不用做断线拼接。
 *
 * @param {Date} date UTC 时刻
 * @param {{steps?:number, lon0?:number}} opts steps=经度采样段数；lon0=采样起点（地图接缝经度）
 * @returns {{line:Array<[number,number]>, night:Array<[number,number]>, sub:{lat,lon}, darkPole:number}}
 *          line/night 均为 [lon, lat] 序列（lon 自 lon0 单调递增至 lon0+360，未做 ±180 归一）；
 *          night 为闭合多边形（含沿暗极的封口边）
 */
export function terminatorFlat(date, opts = {}) {
  const steps = opts.steps || 720
  const lon0 = opts.lon0 != null ? opts.lon0 : -180
  const { sub } = solarGeometry(date)
  let phis = sub.lat * RAD
  if (Math.abs(phis) < MIN_DEC) phis = phis >= 0 ? MIN_DEC : -MIN_DEC   // 分点夹持，防退化
  const tanPhis = Math.tan(phis)
  const lams = sub.lon * RAD
  const darkPole = phis > 0 ? -90 : 90                                   // 太阳在北 → 南极极夜

  const line = new Array(steps + 1)
  for (let i = 0; i <= steps; i++) {
    const lon = lon0 + (360 * i) / steps
    const lat = Math.atan(-Math.cos(lon * RAD - lams) / tanPhis) * DEG
    line[i] = [lon, lat]
  }
  // 夜区多边形：晨昏线（自 lon0 向东扫满一圈）+ 沿暗极那条边回来封口
  const night = line.slice()
  night.push([lon0 + 360, darkPole], [lon0, darkPole])
  return { line, night, sub, darkPole }
}
