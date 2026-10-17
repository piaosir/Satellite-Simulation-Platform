// 数值轨道传播器与力模型核心库的入口（纯 CommonJS）。
//
// 典型用法：
//   const P = require('./utils/prop')
//   const sw = P.spaceWeather.createSpaceWeather(fs.readFileSync('SW-All.csv', 'utf8'))
//   const fm = P.createForceModel({ gravity: { degree: 21 }, srp: { cr: 1.3, areaToMass: 0.01 },
//                                   drag: { cd: 2.2, areaToMass: 0.01, spaceWeather: sw } }, state0)
//   const states = P.propagate(state0, fm, { tEndMs, outStepSec: 60 })   // → [{ tMs, r, v }]（J2000，km，km/s）
//
// 各文件头注写明公式出处、数据来源与精度：
//   numProp.js（DOP853 / RKF78、稠密输出、事件）  earthRotation.js（J2000 ↔ 地固，复用 frames.js）
//   ephemeris.js（日月解析历表 / 表格 / Chebyshev） forceModel.js（组装）  elements.js（根数）
//   forces/gravity.js（EGM2008）thirdBody.js  srp.js  drag.js  nrlmsise00.js  spaceWeather.js  tides.js

'use strict'

const numProp = require('./numProp.js')
const forceModel = require('./forceModel.js')

module.exports = {
  propagate: numProp.propagate,
  integrate: numProp.integrate,
  toEphemSpec: numProp.toEphemSpec,
  createForceModel: forceModel.createForceModel,
  numProp,
  earthRotation: require('./earthRotation.js'),
  ephemeris: require('./ephemeris.js'),
  elements: require('./elements.js'),
  gravity: require('./forces/gravity.js'),
  thirdBody: require('./forces/thirdBody.js'),
  srp: require('./forces/srp.js'),
  drag: require('./forces/drag.js'),
  nrlmsise00: require('./forces/nrlmsise00.js'),
  spaceWeather: require('./forces/spaceWeather.js'),
  tides: require('./forces/tides.js')
}
