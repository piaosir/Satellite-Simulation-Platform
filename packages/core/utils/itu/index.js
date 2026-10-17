// itu/ — ITU-R 传播物理函数单一真值源（C-16，2026-10-17）
//
// GSO 引擎 linkCalculator.js 与 NGSO 引擎 linkCalculatorNGSO.js 原各有一份全量拷贝（去注释后只差注释
// 与一个形参名），雨衰页 / 瞬时衰减 / 环境场 / 实时气象场经 linkCalculator 的再导出引用 GSO 那份，
// 再生式与端到端委托 NGSO。现统一在这里，按建议书分文件；两引擎与其余模块只 require，不再各写一份。
//
//   p838.js       P.838-3 降雨比衰减系数
//   p618rain.js   P.618-14 §2.2.1.1 雨衰（P.839-4 雨高）
//   p618xpd.js    P.618-14 §4.1 雨致 XPD + GEO 极化偏转角
//   p618scint.js  P.618-14 §2.4.1 对流层闪烁
//   p618sky.js    P.618-14 §3 天空噪温（式 69/70）
//   p840.js       P.840-9 云衰（K_L 式 12/14/16）
//   p676.js       P.676-13 气体吸收（Annex 1 逐线 / 分层射线，Annex 2 斜路径）
//   p676Lines.js  P.676-13 Table 1 / Table 2 谱线数据
//   p835.js       P.835-7 参考大气 + 平台地面气压 / 温度估算
//   p2041.js      P.2041-1 机载终端（云柱削减 / 闪烁闸）
//   gasSite.js    按站址取统计气象参数的斜路径气体衰减（P.676 Annex 2 统计法 + P.836-6 + P.618 §2.5 + P.2041）
//
// ★ 小程序仓里那份手工镜像不从这里取（另行同步）。

const p838 = require('./p838.js');
const p618rain = require('./p618rain.js');
const p618xpd = require('./p618xpd.js');
const p618scint = require('./p618scint.js');
const p618sky = require('./p618sky.js');
const p840 = require('./p840.js');
const p676 = require('./p676.js');
const p835 = require('./p835.js');
const p2041 = require('./p2041.js');
const gasSite = require('./gasSite.js');

module.exports = Object.assign({}, p838, p618rain, p618xpd, p618scint, p618sky, p840, p676, p835, p2041, gasSite);
