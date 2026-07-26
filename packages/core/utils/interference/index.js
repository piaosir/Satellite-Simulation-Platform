// 干扰分析（C/I）引擎 —— 统一出口。
//
// 方案与决策见 docs/干扰分析模块调研.md。四路：
//   ciAsi   C/ASI 邻星（GEO，上下行 + ΔT/T 协调判据）
//   ciXpi   C/XPI 交叉极化（GRD P1/P2 ⊕ 地球站 ⊕ 雨致 XPD 三源合成）
//   ciCci   C/CCI 同频复用（多波束，走 GRD 逐波束）
//   ciNgso  NGSO 时变 C/I（逐时刻扫描 → CDF + in-line 事件）
//
// 本引擎只出数、不写库：链路预算三窗口那 8 个手填 C/I 字段一概不动（「只看不回填」）。
// 物理上对得上账的依据：干扰源与载波谱密度形状一致时，C/I 与参考带宽无关，故这里算出的
// 数与引擎那套「转发器参考口径」的 C/I 是同一个量。C/ACI 与 C/IM 不满足该条件，本期不做。

const geometry = require('./geometry.js');
const patterns = require('./patterns.js');
const ciAsi = require('./ciAsi.js');
const ciXpi = require('./ciXpi.js');
const ciCci = require('./ciCci.js');
const ciNgso = require('./ciNgso.js');

module.exports = {
  geometry, patterns,
  ciAsi, ciXpi, ciCci, ciNgso,
  // 常用入口平铺，免得调用方层层点
  gsoSeparation: geometry.gsoSeparation,
  topocentricAngle: geometry.topocentricAngle,
  downlinkCAsi: ciAsi.downlinkCAsi,
  uplinkCAsi: ciAsi.uplinkCAsi,
  deltaTOverT: ciAsi.deltaTOverT,
  combineXpi: ciXpi.combineXpi,
  xpiFromSources: ciXpi.xpiFromSources,
  resolveXpd: ciXpi.resolveXpd,
  cciAtPoint: ciCci.cciAtPoint,
  cciOverPoints: ciCci.cciOverPoints,
  createNgsoCiRun: ciNgso.createNgsoCiRun
};
