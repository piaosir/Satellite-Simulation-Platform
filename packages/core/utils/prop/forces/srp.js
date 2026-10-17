// 太阳光压（球形 / 炮弹模型）+ 锥形地影（本影 / 半影），纯 CommonJS。
//
// 【加速度】a = ν · C_R · (A/m) · P☉ · (AU / |r − r☉|)² · (r − r☉)/|r − r☉|
//   P☉ = 4.56e-6 N/m²（1 AU 处的太阳辐射压，Montenbruck & Gill 式 3.69），AU 取 149 597 870 km（与 Orekit
//   SolarRadiationPressure 的 D_REF = 149597870000 m 同值），C_R 为光压系数（1 = 全吸收，2 = 全镜面反射），
//   A/m 单位 m²/kg；结果换算到 km/s²（÷1000）。
// 【地影因子 ν】Montenbruck & Gill §3.4.2（式 3.85–3.88，图 3.8）的锥形模型：从卫星看
//   a = asin(R☉/|r☉ − r|)（太阳视半径），b = asin(R⊕/|r|)（地球视半径），c = 两圆心角距；
//   c ≥ a + b → ν = 1（全照）；c + a ≤ b → ν = 0（本影）；c + b ≤ a → ν = 1 − b²/a²（环食）；
//   否则（半影）ν = 1 − [a²·acos(x/a) + b²·acos((c − x)/b) − c·y]/(π a²)，x = (c² + a² − b²)/(2c)，y = √(a² − x²)。
//   这里用与 Orekit ConicallyShadowedLightFluxModel 相同的等价写法（atan2 与海伦公式），半影内连续。
//   R☉ = 695 700 km（IAU 2015 B3 名义太阳半径），R⊕ = 6378.137 km（WGS-84 赤道半径；地球当球处理）。
//   不含月影（GEO 每年 0–数次、每次 ≤ 数小时）、地球扁率与大气折射对影界的修正（影界时刻误差 ~ 秒级）。
//
// 【积分】半影外沿与本影边界处 ν 只有一阶连续，高阶积分器跨过去会失准：discontinuities 把这两条边界交给
//   numProp 作开关函数，积分步停在边界上再重启（Orekit 用事件探测做同样的事）。
//
// 接口：createSrp({ cr, areaToMass, ephemeris, shadow: 'conical' | 'cylindrical' | 'none' }) → {
//   acceleration(tMs, r) → [ax,ay,az]（km/s²）, lighting(tMs, r) → ν, discontinuities: [g(tMs, r)]
// }
//   另导出 shadowAngles(r, rSun) → { a, b, c }（半影事件 g = c − (a + b)，本影事件 g = c − |b − a|）、
//   conicalShadow(r, rSun)、cylindricalShadow(r, rSun)、P_SUN、AU_KM、R_SUN、R_EARTH。

'use strict'

const EPH = require('../ephemeris.js')

const P_SUN = 4.56e-6          // N/m²，1 AU 处
const AU_KM = 149597870        // km（光压参考距离，Orekit D_REF 同值）
const R_SUN = 695700           // km
const R_EARTH = 6378.137       // km

// 从卫星看：a = 太阳视半径，b = 地球视半径，c = 日心与地心的角距（弧度）
function shadowAngles(r, rSun, rEarth, rSunBody) {
  const Re = rEarth || R_EARTH, Rs = rSunBody || R_SUN
  const sx = rSun[0] - r[0], sy = rSun[1] - r[1], sz = rSun[2] - r[2]
  const ds = Math.sqrt(sx * sx + sy * sy + sz * sz)
  const rr = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2])
  // c = ∠(−(r☉ − r), r)。小角处 acos 损精度，用 atan2(|u×v|, u·v)
  const cx = sy * r[2] - sz * r[1], cy = sz * r[0] - sx * r[2], cz = sx * r[1] - sy * r[0]
  return {
    a: Math.asin(Rs / ds),
    b: Math.asin(Math.min(1, Re / rr)),
    c: Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), -(sx * r[0] + sy * r[1] + sz * r[2]))
  }
}

function conicalShadow(r, rSun, rEarth, rSunBody) {
  const { a, b, c } = shadowAngles(r, rSun, rEarth, rSunBody)
  if (a + b <= c) return 1
  if (a <= b && c + a <= b) return 0
  if (a >= b && c + b <= a) return 1 - (b * b) / (a * a)
  const a2 = a * a, b2 = b * b, c2 = c * c
  const x = (c2 + a2 - b2) / (2 * c)
  const cmx = (c2 + b2 - a2) / (2 * c)
  const y = Math.sqrt(Math.max(0, a2 - x * x))
  const alpha = Math.atan2(y, x), beta = Math.atan2(y, cmx)
  const area = Math.sqrt(Math.max(0, (-c + a + b) * (c + a - b) * (c - a + b) * (c + a + b))) / 2
  return 1 - (alpha + (b2 * beta - area) / a2) / Math.PI
}

// 圆柱影（对照用）：卫星在背日半空间且到日地连线的距离 < R⊕ 即全影
function cylindricalShadow(r, rSun, rEarth) {
  const Re = rEarth || R_EARTH
  const sn = Math.hypot(rSun[0], rSun[1], rSun[2])
  const u = [rSun[0] / sn, rSun[1] / sn, rSun[2] / sn]
  const p = r[0] * u[0] + r[1] * u[1] + r[2] * u[2]
  if (p >= 0) return 1
  const perp = Math.hypot(r[0] - p * u[0], r[1] - p * u[1], r[2] - p * u[2])
  return perp < Re ? 0 : 1
}

function createSrp(opts) {
  const o = opts || {}
  const cr = Number(o.cr == null ? 1.3 : o.cr)
  const am = Number(o.areaToMass)
  if (!(am >= 0) || !(cr >= 0)) throw new Error('光压需要 areaToMass（m²/kg）与 cr')
  const eph = o.ephemeris || EPH.analyticEphemeris()
  const mode = o.shadow || 'conical'
  const k = cr * am * P_SUN * AU_KM * AU_KM / 1000      // km/s² · km²
  const light = mode === 'none' ? () => 1 : (mode === 'cylindrical' ? cylindricalShadow : conicalShadow)
  // 光照因子不光滑的地方（锥形：半影外沿 c = a + b、本影 / 环食边界 c = |b − a|；柱形：影界本身），交给积分器
  // 作开关函数，步不跨过（见 numProp.integrate 的 discontinuities）
  const discontinuities = mode === 'conical'
    ? [(tMs, r) => { const g = shadowAngles(r, eph.sun(tMs)); return g.c - (g.a + g.b) },
      (tMs, r) => { const g = shadowAngles(r, eph.sun(tMs)); return g.c - Math.abs(g.b - g.a) }]
    : mode === 'cylindrical'
      ? [(tMs, r) => {
          const s = eph.sun(tMs), sn = Math.hypot(s[0], s[1], s[2])
          const p = (r[0] * s[0] + r[1] * s[1] + r[2] * s[2]) / sn
          if (p >= 0) return R_EARTH
          return Math.hypot(r[0] - p * s[0] / sn, r[1] - p * s[1] / sn, r[2] - p * s[2] / sn) - R_EARTH
        }]
      : []
  return {
    ephemeris: eph,
    discontinuities,
    lighting: (tMs, r) => light(r, eph.sun(tMs)),
    acceleration(tMs, r) {
      const s = eph.sun(tMs)
      const nu = light(r, s)
      if (nu === 0) return [0, 0, 0]
      const dx = r[0] - s[0], dy = r[1] - s[1], dz = r[2] - s[2]
      const d2 = dx * dx + dy * dy + dz * dz
      const f = nu * k / (d2 * Math.sqrt(d2))
      return [f * dx, f * dy, f * dz]
    }
  }
}

module.exports = { createSrp, shadowAngles, conicalShadow, cylindricalShadow, P_SUN, AU_KM, R_SUN, R_EARTH }
