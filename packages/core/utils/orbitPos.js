// 位置访问器：全平台取卫星位置的【单一入口】（纯 CommonJS）。
//
// 传播类型两种，返回形状完全一样，调用方不必分支：
//   satrec（SGP4/SDP4，来自 OMM / TLE / 六根数）-> vendor/satellite.js 的 propagate
//   ephem 表（时间标签位置序列，来自 STK .e / CCSDS OEM / SP3）-> ephemInterp 的插值
// 两者都返 { position:{x,y,z}, velocity:{x,y,z} }（TEME，km / km·s⁻¹）或 null。
//   satrec 的 null = SGP4 报错 / 位置非有限；ephem 的 null = 查询时刻【落在采样时段之外】
//   （口径：不外推、不钉端点，该星此刻不画、不参与几何）。
//
// core 内凡取卫星位置一律走本模块，不再直接调 sat.propagate —— 否则新加的 ephem 星会静默出 NaN。

'use strict'

const sat = require('../vendor/satellite.js')
const EI = require('./ephemInterp.js')

const isEphem = (o) => !!(o && o.__ephem)
const toMs = (d) => (d instanceof Date ? d.getTime() : Number(d))

// obj: satrec | ephem 表；dateOrMs: Date | UTC 毫秒
function positionAt(obj, dateOrMs) {
  if (!obj) return null
  if (isEphem(obj)) {
    const r = EI.evalTable(obj, toMs(dateOrMs))
    if (!r) return null
    return { position: { x: r.x, y: r.y, z: r.z }, velocity: { x: r.vx, y: r.vy, z: r.vz } }
  }
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(toMs(dateOrMs))
  const pv = sat.propagate(obj, d)
  if (!pv || !pv.position || (obj.error && obj.error !== 0)) return null
  const p = pv.position
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
  return pv
}

// 传播器标注：SGP4 / SDP4 / 星历点序列
function propagatorLabel(obj) {
  if (isEphem(obj)) return '星历点序列'
  return obj && obj.method === 'd' ? 'SDP4' : 'SGP4'
}

// 该传播体的有效时段（UTC 毫秒）；satrec 无限制返回 null。
function validSpan(obj) {
  return isEphem(obj) ? { t0: obj.t0, t1: obj.t1 } : null
}

module.exports = { positionAt, propagatorLabel, isEphem, validSpan }
