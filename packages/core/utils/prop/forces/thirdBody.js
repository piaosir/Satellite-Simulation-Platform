// 日月引力摄动（点质量第三体，纯 CommonJS）。
//
// 【公式】地心惯性系里第三体 b 对卫星的摄动加速度（Montenbruck & Gill《Satellite Orbits》式 3.37）：
//   a = GM_b · ( (r_b − r)/|r_b − r|³ − r_b/|r_b|³ )
//   第二项是第三体对地心的「间接项」（地心本身被 b 拉着走）。卫星—地心距离远小于 |r_b|，两项量级相近，
//   直接相减在双精度下损失约 3 位（太阳对 GEO：两项 ~5.9e-6、差 ~3.3e-9 km/s²），剩余精度仍 ~1e-19 km/s²，不需 Battin f(q)。
// 【常数】取 JPL DE440 头文件常数（与 Orekit 读 DE440 时的 getGM() 逐位一致）：
//   GM☉ = 1.3271244004127946e11 km³/s²（GMS），GM☾ = 4902.800118457551 km³/s²（GMB / (1 + EMRAT)）。
// 【星历】ephemeris provider（见 ../ephemeris.js）：缺省解析历表（ERFA epv00 / moon98，精度见该文件头注）；
//   可换 tabulatedEphemeris / chebyshevEphemeris（DE440 子集）。
//
// 接口：createThirdBody({ bodies: ['sun','moon'], ephemeris, gm: { sun, moon } }) → { acceleration(tMs, r) → [ax,ay,az] }
//   另导出 pointMass(r, rb, gm)（单个第三体）、GM_SUN、GM_MOON。

'use strict'

const EPH = require('../ephemeris.js')

const GM_SUN = 1.3271244004127946e11      // km³/s²（DE440）
const GM_MOON = 4902.800118457551         // km³/s²（DE440）

function pointMass(r, rb, gm) {
  const dx = rb[0] - r[0], dy = rb[1] - r[1], dz = rb[2] - r[2]
  const d2 = dx * dx + dy * dy + dz * dz, d3 = d2 * Math.sqrt(d2)
  const b2 = rb[0] * rb[0] + rb[1] * rb[1] + rb[2] * rb[2], b3 = b2 * Math.sqrt(b2)
  return [gm * (dx / d3 - rb[0] / b3), gm * (dy / d3 - rb[1] / b3), gm * (dz / d3 - rb[2] / b3)]
}

function createThirdBody(opts) {
  const o = opts || {}
  const eph = o.ephemeris || EPH.analyticEphemeris()
  const bodies = Array.isArray(o.bodies) ? o.bodies : ['sun', 'moon']
  const gm = Object.assign({ sun: GM_SUN, moon: GM_MOON }, o.gm || {})
  for (const b of bodies) if (!(b in gm) || typeof eph[b] !== 'function') throw new Error('第三体只支持 sun / moon：' + b)
  return {
    ephemeris: eph, bodies, gm,
    acceleration(tMs, r) {
      let ax = 0, ay = 0, az = 0
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]
        const a = pointMass(r, eph[b](tMs), gm[b])
        ax += a[0]; ay += a[1]; az += a[2]
      }
      return [ax, ay, az]
    }
  }
}

module.exports = { createThirdBody, pointMass, GM_SUN, GM_MOON }
