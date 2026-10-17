// NTN 与移动终端信道核心库的统一出口（CommonJS，纯函数）。
//
//   tr38811  3GPP TR 38.811 V15.4.0 §6.6：LOS 概率、杂波损耗 / 阴影衰落、位置覆盖概率、闪烁参考量
//   p681     ITU-R P.681-11：陆地移动卫星二状态衰落余量（Annex 2 参数表）、路边树木 / 建筑遮挡、清晰视距多径
//   p682     ITU-R P.682-4：航空移动海面反射多径衰落（含 P.527-6 海水介电常数）
//   p372     ITU-R P.372-18：人为 / 银河噪声、天空亮温、室内人为噪声、手持终端天线噪温与 G/T
//   numeric  上面几个共用的数值底座（erf / 正态 / 莱斯 CDF / 求积 / 求根）
//
// P.2108 / P.2109（地物杂波、建筑物进入损耗）在 packages/core/utils/terrestrial/，这里不重复实现；
// tr38811.coverageProbability 留了 extraLossDb / extraLossQuantile / nlosClutterDb 三个接口参数接它们。

module.exports = {
  tr38811: require('./tr38811.js'),
  p681: require('./p681.js'),
  p682: require('./p682.js'),
  p372: require('./p372.js'),
  numeric: require('./numeric.js')
}
