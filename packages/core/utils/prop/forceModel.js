// 力模型组装（纯 CommonJS）：把各项摄动合成一个 acceleration(tMs, r, v)，交给 numProp.propagate。
//
// 各分量共用同一个地球自转对象（J2000↔地固矩阵按时刻缓存）与同一个日月星历（分段 Chebyshev 缓存），
// 一次力模型求值里重力 / 大气 / 潮汐取到的是同一个矩阵、光压 / 第三体取到的是同一个太阳位置。
//
// createForceModel(cfg) → { acceleration(tMs, r, v) → [ax,ay,az]（km/s²，J2000）, parts, earthRotation, ephemeris,
//   discontinuities: [g(tMs, r, v)]（地影边界等不光滑点）, breakpoints(t0Ms, t1Ms) → [UTC 毫秒]（空间天气跳变） }
//   cfg.gravity    { degree, order, tideSystem }；缺省阶次：cfg.r0Km（或 state0 的 |r|）≥ 20000 km 取 8×8，否则 21×21；
//                  degree: 0 即二体（只有中心引力）。false 则连中心引力都不要（仅测试用）。
//   cfg.thirdBody  true | { bodies: ['sun','moon'] } | false（缺省 true）
//   cfg.srp        { cr, areaToMass(m²/kg), shadow: 'conical' | 'cylindrical' | 'none' } | false（缺省 false）
//   cfg.drag       { cd, areaToMass(m²/kg), spaceWeather（createSpaceWeather 的结果或 SW-All.csv 文本）, lstMode, apMode,
//                    maxAltitudeKm } | false（缺省 false）
//   cfg.tides      true | { centralTideSystem } | false（缺省 false；centralTideSystem 缺省取重力场的 tideSystem）
//   cfg.ephemeris  星历提供者（缺省 analyticEphemeris()；可换 tabulated / chebyshev，即将来的 DE440 子集）
//   cfg.earthRotation  缺省 createEarthRotation()
//
// 精度与适用范围见各分量文件头注：forces/gravity.js、thirdBody.js（../ephemeris.js）、srp.js、drag.js、tides.js。

'use strict'

const ER = require('./earthRotation.js')
const EPH = require('./ephemeris.js')
const G = require('./forces/gravity.js')
const TB = require('./forces/thirdBody.js')
const SRP = require('./forces/srp.js')
const DRAG = require('./forces/drag.js')
const SW = require('./forces/spaceWeather.js')
const TIDES = require('./forces/tides.js')

function createForceModel(cfgIn, state0) {
  const cfg = cfgIn || {}
  const er = cfg.earthRotation || ER.createEarthRotation()
  const eph = cfg.ephemeris || EPH.analyticEphemeris()
  const parts = []
  let field = null

  if (cfg.gravity !== false) {
    const g = cfg.gravity || {}
    let r0 = cfg.r0Km
    if (!(r0 > 0) && state0 && state0.r) {
      const r = state0.r
      r0 = Array.isArray(r) || ArrayBuffer.isView(r) ? Math.hypot(r[0], r[1], r[2]) : Math.hypot(r.x, r.y, r.z)
    }
    const degree = g.degree == null ? (r0 > 0 ? G.defaultDegree(r0) : 21) : g.degree
    const order = g.order == null ? degree : g.order
    const grav = G.createGravity({ degree, order, tideSystem: g.tideSystem, earthRotation: er })
    field = grav.field
    parts.push({ name: 'gravity', degree, order, acc: grav.acceleration })
  }
  if (cfg.thirdBody !== false) {
    const t = cfg.thirdBody && typeof cfg.thirdBody === 'object' ? cfg.thirdBody : {}
    const tb = TB.createThirdBody({ bodies: t.bodies, gm: t.gm, ephemeris: eph })
    parts.push({ name: 'thirdBody', acc: tb.acceleration })
  }
  if (cfg.srp) {
    const s = SRP.createSrp(Object.assign({}, cfg.srp, { ephemeris: eph }))
    parts.push({ name: 'srp', acc: s.acceleration, lighting: s.lighting, discontinuities: s.discontinuities })
  }
  if (cfg.drag) {
    const d = cfg.drag
    const sw = typeof d.spaceWeather === 'string' ? SW.createSpaceWeather(d.spaceWeather) : d.spaceWeather
    const dr = DRAG.createDrag(Object.assign({}, d, { spaceWeather: sw, earthRotation: er, ephemeris: eph }))
    parts.push({ name: 'drag', acc: dr.acceleration, density: dr.density, breakpoints: dr.breakpoints, discontinuities: dr.discontinuities })
  }
  if (cfg.tides) {
    const t = typeof cfg.tides === 'object' ? cfg.tides : {}
    const td = TIDES.createSolidTides({
      ephemeris: eph, earthRotation: er,
      gm: field ? field.gm : undefined, ae: field ? field.ae : undefined,
      centralTideSystem: t.centralTideSystem || (field ? field.tideSystem : 'zero-tide')
    })
    parts.push({ name: 'tides', acc: td.acceleration })
  }

  const n = parts.length
  // 各分量的不光滑点（开关函数）与跳变时刻，numProp.propagate 会取走交给积分器
  const discontinuities = [].concat(...parts.map((p) => p.discontinuities || []))
  function breakpoints(t0Ms, t1Ms) {
    const set = new Set()
    for (const p of parts) if (p.breakpoints) for (const b of p.breakpoints(t0Ms, t1Ms)) set.add(b)
    return [...set].sort((a, b) => a - b)
  }
  return {
    parts, earthRotation: er, ephemeris: eph, gravityField: field, discontinuities, breakpoints,
    acceleration(tMs, r, v) {
      let ax = 0, ay = 0, az = 0
      for (let i = 0; i < n; i++) {
        const a = parts[i].acc(tMs, r, v)
        ax += a[0]; ay += a[1]; az += a[2]
      }
      return [ax, ay, az]
    }
  }
}

module.exports = { createForceModel }
