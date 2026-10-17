// 地面业务干扰传播库 —— 统一出口。
//
// 用途：地面业务（5G / IMT、固定业务）与卫星地球站之间的干扰计算内核，供「站址评估 / 地面业务干扰」功能调用。
//   p452   ITU-R P.452-18  地面站间干扰传播（视距、绕射、对流层散射、波导 / 层反射、剖面杂波、各机制合成）
//   p676   ITU-R P.676-13  附件 1 逐线法气体比衰减（P.452 式 (9) 的口径）
//   p2108  ITU-R P.2108-1  杂波损耗（§3.1 终端高度增益修正、§3.2 地面路径、§3.3 地空路径）
//   p2109  ITU-R P.2109-2  建筑物穿透损耗（传统 / 热效率两类，概率分布）
//   f1336  ITU-R F.1336-5  全向 / 扇区 / 低增益天线参考方向图（峰值与平均旁瓣）
//   m2101  ITU-R M.2101-0  IMT 有源天线（AAS）单元方向图与合成波束方向图
//   ap7    RR 附录 7（Rev.WRC-23）地球站协调区：模式 (1) 大圆机制、模式 (2) 雨散射、附表参数
// 各模块均为纯函数、只出数；界面与入库不在本库。

const common = require('./common.js');
const p676 = require('./p676.js');
const p452 = require('./p452.js');
const p2108 = require('./p2108.js');
const p2109 = require('./p2109.js');
const f1336 = require('./f1336.js');
const m2101 = require('./m2101.js');
const ap7 = require('./ap7.js');

module.exports = {
  common, p676, p452, p2108, p2109, f1336, m2101, ap7,
  // 常用入口平铺
  basicTransmissionLoss: p452.basicTransmissionLoss,
  radioMetAt: p452.radioMetAt
};
