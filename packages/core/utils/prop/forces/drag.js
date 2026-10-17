// 大气阻力（球形 / 炮弹模型）+ NRLMSISE-00 密度（纯 CommonJS）。
//
// 【加速度】a = −½ · ρ · C_D · (A/m) · |v_rel| · v_rel，v_rel = v − ω⊕ × r（大气随地球刚性共转）
//   ρ：NRLMSISE-00 gtd7d 的「拖曳用有效总质量密度」（含异常氧，kg/m³），见 ./nrlmsise00.js（许可见其文件头）。
//   ω⊕ = 7.292115146706979e-5 rad/s：地球相对惯性空间的自转角速度（IERS Conventions 2010 的 ERA 速率
//     2π·1.00273781191135448/86400），方向取真天极（earthRotation.omegaJ2000 的方向）。
//     注意 frames.js 的 OMEGA_E = 7.2921158553e-5 是 GMST 相对「瞬时春分点」的速率，两者差一个岁差速率
//     7e-12 rad/s，对 v_rel 的影响 < 5e-5 m/s，可略；这里取物理上对的那个。
//   单位：ρ kg/m³ × (A/m) m²/kg × v² (m/s)² = m/s²，内部按 km/s 计：a(km/s²) = ½ρ C_D (A/m)·|v|·v·1000。
// 【NRLMSISE-00 输入】
//   大地纬度 / 经度 / 高度：地固位置（earthRotation：J2000 → frames.js FIXED）在 WGS-84 椭球（a = 6378.137 km，
//     1/f = 298.257223563）上的精确换算（Bowring 1976 迭代至收敛，≤ 1e-15 rad）。
//   doy、sec：UTC 的年积日与日内秒（UT1 取 UTC，frames.js 口径）。
//   lst（地方太阳时）：缺省「平太阳时」sec/3600 + λ/15 —— NRLMSISE-00 参考驱动程序的定义，模型系数按它拟合；
//     lstMode = 'apparent' 时取真太阳时角（卫星与太阳在地固系的方位差 + 12 h），含时差（±16 min）。
//   f107 / f107A / ap / ap_a：spaceWeather 提供者（SW-All.csv，见 ./spaceWeather.js）或 constantSpaceWeather。
//   开关：缺省 NRL 标准（全 1）；apMode = 'array' 时 switch 9 = −1（用 3 小时 ap 历史）。
// 【范围】高度 > maxAltitudeKm（缺省 2500 km）直接返回 0（NRLMSISE-00 只标定到 1000 km，再往上密度 < 1e-15
//   kg/m³，对轨道无可见影响）。
//
// 【积分】空间天气输入按 UTC 日（ap 数组模式按 3 小时）阶跃，密度在这些时刻跳变：breakpoints 把它们交给 numProp，
//   积分步不跨过（缺省的常数空间天气没有跳变）。模型自身的两类小跳变作为开关函数 discontinuities 交给积分器：
//   地方太阳时 24 h → 0 h 回绕（模型常数 hr = 0.2618 ≠ π/12 所致），以及 gts7 的高度门限 altl
//   （160 / 200 / 240 / 250 / 300 / 320 / 450 km，越过即关掉某成分的混合 / 化学修正）。不处理的话，轨道高度
//   恰在门限附近时（如 450 km）7 天沿迹会积出米级误差。
//
// 接口：createDrag({ cd, areaToMass, spaceWeather, earthRotation, ephemeris, lstMode, apMode, maxAltitudeKm }) → {
//   acceleration(tMs, r, v) → [ax,ay,az]（km/s²），density(tMs, r) → kg/m³，breakpoints(t0Ms, t1Ms) → [UTC 毫秒]，
//   discontinuities: [g(tMs, r)]
// }
//   另导出 ecefToGeodetic(rFixed) → { lat, lon（rad）, h（km） }、msisInput(...)、OMEGA_EARTH、WGS84。

'use strict'

const ER = require('../earthRotation.js')
const MSIS = require('./nrlmsise00.js')
const SW = require('./spaceWeather.js')

const OMEGA_EARTH = 7.292115146706979e-5
const WGS84 = { a: 6378.137, f: 1 / 298.257223563 }
const DAY_MS = 86400000
const RAD2DEG = 180 / Math.PI

// 地固直角 → WGS-84 大地坐标（Bowring 迭代；h 用 Vermeille 式避免极区 / 赤道的除零）
function ecefToGeodetic(r) {
  const a = WGS84.a, f = WGS84.f
  const b = a * (1 - f), e2 = f * (2 - f), ep2 = e2 / (1 - e2)
  const x = r[0], y = r[1], z = r[2]
  const p = Math.hypot(x, y)
  const lon = Math.atan2(y, x)
  if (p < 1e-9) return { lat: z >= 0 ? Math.PI / 2 : -Math.PI / 2, lon, h: Math.abs(z) - b }
  let beta = Math.atan2(z, (1 - f) * p)
  let lat = 0
  for (let k = 0; k < 10; k++) {
    const sb = Math.sin(beta), cb = Math.cos(beta)
    const latNew = Math.atan2(z + ep2 * b * sb * sb * sb, p - e2 * a * cb * cb * cb)
    const done = Math.abs(latNew - lat) < 1e-15
    lat = latNew
    beta = Math.atan2((1 - f) * Math.sin(lat), Math.cos(lat))
    if (done) break
  }
  const sl = Math.sin(lat), cl = Math.cos(lat)
  const N = a / Math.sqrt(1 - e2 * sl * sl)
  const h = p * cl + z * sl - a * a / N
  return { lat, lon, h }
}

// 组 NRLMSISE-00 的输入。rFixed 地固位置（km）；sunFixed 仅 lstMode = 'apparent' 时用。
function msisInput(tMs, rFixed, wx, lstMode, sunFixed) {
  const g = ecefToGeodetic(rFixed)
  const d = new Date(Math.floor(tMs / DAY_MS) * DAY_MS)
  const y0 = Date.UTC(d.getUTCFullYear(), 0, 1)
  const doy = Math.round((d.getTime() - y0) / DAY_MS) + 1
  const sec = (tMs - d.getTime()) / 1000
  const lonDeg = g.lon * RAD2DEG
  let lst
  if (lstMode === 'apparent' && sunFixed) {
    const hl = Math.PI + Math.atan2(sunFixed[0] * rFixed[1] - sunFixed[1] * rFixed[0], sunFixed[0] * rFixed[0] + sunFixed[1] * rFixed[1])
    lst = hl * 12 / Math.PI
  } else {
    lst = sec / 3600 + lonDeg / 15
    lst = lst - 24 * Math.floor(lst / 24)
  }
  return { doy, sec, alt: g.h, g_lat: g.lat * RAD2DEG, g_long: lonDeg, lst, f107A: wx.f107A, f107: wx.f107, ap: wx.ap, ap_a: wx.ap_a }
}

function createDrag(opts) {
  const o = opts || {}
  const cd = Number(o.cd == null ? 2.2 : o.cd)
  const am = Number(o.areaToMass)
  if (!(am >= 0) || !(cd >= 0)) throw new Error('阻力需要 areaToMass（m²/kg）与 cd')
  const er = o.earthRotation || ER.createEarthRotation()
  const sw = o.spaceWeather || SW.constantSpaceWeather()
  const lstMode = o.lstMode === 'apparent' ? 'apparent' : 'mean'
  if (lstMode === 'apparent' && !o.ephemeris) throw new Error("lstMode = 'apparent' 需要 ephemeris（太阳位置）")
  const switches = MSIS.DEFAULT_SWITCHES.slice()
  switches[0] = 1
  if (o.apMode === 'array') switches[9] = -1
  const hMax = o.maxAltitudeKm > 0 ? o.maxAltitudeKm : 2500

  function density(tMs, r) {
    const M = er.m(tMs)
    const rf = ER.mulMV(M, r)
    const sunF = lstMode === 'apparent' ? ER.mulMV(M, o.ephemeris.sun(tMs)) : null
    const inp = msisInput(tMs, rf, sw.msisInputs(tMs), lstMode, sunF)
    if (inp.alt > hMax) return 0
    return MSIS.gtd7d(inp, switches).d[5]
  }

  // 空间天气输入在 UTC 日界（f107 / f107A / 日 Ap）与 3 小时界（ap 数组模式）上阶跃，密度随之跳变：
  // 交给积分器作跳变时刻，步不跨过（见 numProp.integrate 的 breakpoints）
  function breakpoints(t0Ms, t1Ms) {
    if (sw.constant) return []
    const stepMs = o.apMode === 'array' ? 10800000 : DAY_MS
    const out = []
    for (let k = Math.floor(Math.min(t0Ms, t1Ms) / stepMs) + 1; k * stepMs <= Math.max(t0Ms, t1Ms); k++) out.push(k * stepMs)
    return out
  }
  // 地方太阳时的 24 h → 0 h 回绕：模型里 hr = 0.2618（≠ π/12），cos / sin(hr·lst) 在回绕处不连续，密度每圈
  // 同向跳 ~4e-6（相对）。g = cos(π·lst/24) 在回绕处由 −1 跳到 +1（另在地方正午平滑过零，多截一步，无害），
  // 交给积分器作开关函数；不处理的话 LEO 7 天沿迹积出约 1 m 的系统误差（Orekit 对拍实测）。
  const lstSwitch = (tMs, r) => {
    const rf = ER.mulMV(er.m(tMs), r)
    let lst
    if (lstMode === 'apparent') {
      const sf = ER.mulMV(er.m(tMs), o.ephemeris.sun(tMs))
      lst = (Math.PI + Math.atan2(sf[0] * rf[1] - sf[1] * rf[0], sf[0] * rf[0] + sf[1] * rf[1])) * 12 / Math.PI
    } else {
      const sec = (tMs - Math.floor(tMs / DAY_MS) * DAY_MS) / 1000
      lst = sec / 3600 + Math.atan2(rf[1], rf[0]) * RAD2DEG / 15
      lst = lst - 24 * Math.floor(lst / 24)
    }
    return Math.cos(Math.PI * lst / 24)
  }
  // 高度门限：gts7 里各成分「偏离扩散平衡」修正只在 z ≤ altl[i]（He 为 <）时启用，越过门限密度跳变
  // （实测 450 km 处 3e-5、300 km 处 1e-4，相对值；C 版与 NRL Fortran 同）。七个门限合成一个开关函数
  // g = Π(h − h_k)，h 为大地高，任一门限被穿越 g 即变号。
  const ALT_STEPS = [160, 200, 240, 250, 300, 320, 450]
  const altSwitch = (tMs, r) => {
    const h = ecefToGeodetic(ER.mulMV(er.m(tMs), r)).h
    let g = 1
    for (let k = 0; k < ALT_STEPS.length; k++) g *= (h - ALT_STEPS[k]) / 100
    return g
  }
  return {
    density,
    breakpoints,
    discontinuities: [lstSwitch, altSwitch],
    acceleration(tMs, r, v) {
      const rho = density(tMs, r)
      if (!(rho > 0)) return [0, 0, 0]
      // ω⊕ 方向：真天极（Q 的第三行），量值 OMEGA_EARTH
      const Q = er.q(tMs)
      const wx = OMEGA_EARTH * Q[6], wy = OMEGA_EARTH * Q[7], wz = OMEGA_EARTH * Q[8]
      const vx = v[0] - (wy * r[2] - wz * r[1])
      const vy = v[1] - (wz * r[0] - wx * r[2])
      const vz = v[2] - (wx * r[1] - wy * r[0])
      const vn = Math.sqrt(vx * vx + vy * vy + vz * vz)
      const k = -0.5 * rho * cd * am * vn * 1000
      return [k * vx, k * vy, k * vz]
    }
  }
}

module.exports = { createDrag, ecefToGeodetic, msisInput, OMEGA_EARTH, WGS84 }
