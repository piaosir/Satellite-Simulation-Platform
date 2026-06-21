// satlink-core — 卫星链路预算计算引擎（纯 JS，平台无关）
// 从微信小程序原样移植：GEO/NGSO 双引擎 + ITU-R 传播模型 + SGP4 支撑。
// 在 Electron 主进程(Node)中加载，通过 IPC 暴露给渲染进程。

const geo = require('./utils/linkCalculator.js');

// NGSO 引擎独立加载并容错：即使其依赖（如 tleStore 的 wx.* 兜底）在某些
// 环境下加载异常，也不影响 GEO 主链路可用。
let ngso = null;
try {
  ngso = require('./utils/linkCalculatorNGSO.js');
} catch (e) {
  console.warn('[satlink-core] NGSO 引擎延迟加载：', e.message);
}

// SGP4/SDP4 轨道传播（vendored satellite-js），供星座地图/星间链路使用。
let sgp4 = null;
try {
  sgp4 = require('./vendor/satellite.js');
} catch (e) {
  console.warn('[satlink-core] SGP4 加载失败：', e.message);
}

module.exports = {
  // GEO（静止轨道）
  calculateLinkBudget: geo.calculateLinkBudget,
  calculateSatelliteAngle: geo.calculateSatelliteAngle,
  // NGSO（非静止轨道）
  calculateLinkBudgetNGSO: ngso && ngso.calculateLinkBudget,
  // 命名空间，便于按需取用其余导出
  geo,
  ngso,
  sgp4,
};
