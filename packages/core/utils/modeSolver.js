// GEO 链路预算「计算方式」求解器（自小程序 pages/index 反向/正向逻辑移植，主进程内求解）。
// 引擎 calculateLinkBudget 本身是「给定余量 → 算功放/带宽」的反向模型；本模块在其外层
// 决定喂入的余量，实现四种计算方式，全部归结为「定出余量后再算一次」：
//   margin      设置余量：直接用输入余量算功放（引擎默认行为）
//   power       设置瓦数：由目标功放功率解析反推余量（P_dBW = 余量 + K）
//   balance     功带平衡：二分搜索使 |分配带宽 − 功率带宽| 最小的余量（自动）
//   overbalance 超发功带平衡：平衡余量 + 超发 x dB（功放超发 x dB ⇒ 余量同抬 x dB，自动）

const { calculateLinkBudget } = require('./linkCalculator.js');

// 以指定余量执行一次计算（高精度字符串传 margin，保留完整精度）
function calcWithMargin(satParams, inputs, margin) {
  const m = typeof margin === 'number' ? margin.toFixed(10) : String(margin);
  return calculateLinkBudget(satParams, Object.assign({}, inputs, { margin: m }));
}

// 功带平衡：二分搜索使分配带宽与功率带宽差异最小的余量
function findBalanceMargin(satParams, inputs) {
  let lo = -50, hi = 50;
  const maxIter = 300, tol = 0.001;
  const test = (m) => {
    const r = calcWithMargin(satParams, inputs, m);
    if (!r.success) return { diff: Infinity, error: true };
    const alloc = parseFloat(r.data.allocBandwidthResult) || 0;
    const pbw = parseFloat(r.data.PowerBWResult) || 0;
    return { diff: Math.abs(alloc - pbw), error: false };
  };
  let mid = (lo + hi) / 2;
  for (let i = 0; i < maxIter; i++) {
    mid = (lo + hi) / 2;
    const c = test(mid);
    if (c.error) return { success: false, message: '计算过程出错' };
    if (c.diff <= tol) return { success: true, margin: mid };
    const plus = test(mid + 0.01);
    if (plus.error) return { success: false, message: '计算过程出错' };
    if (plus.diff < c.diff) {
      lo = mid; // 向更高余量搜索
    } else {
      const minus = test(mid - 0.01);
      if (minus.error) return { success: false, message: '计算过程出错' };
      if (minus.diff < c.diff) hi = mid; // 向更低余量搜索
      else return { success: true, margin: mid }; // 局部最优
    }
  }
  return { success: true, margin: mid };
}

// 设置瓦数：解析反推余量（只需 2 次计算，全程高精度）
function findMarginByPower(satParams, inputs, targetPaPowerW) {
  const currentMargin = parseFloat(inputs.margin);
  const baseMargin = isNaN(currentMargin) ? 3 : currentMargin;
  const base = calcWithMargin(satParams, inputs, baseMargin);
  if (!base.success) return { success: false, message: base.message || '基准计算失败' };
  // P_dBW = 余量 + K → K = P_dBW − 余量
  const K = parseFloat(base.data.paRecommendationdBResult) - baseMargin;
  const targetPaPowerdB = 10 * Math.log10(targetPaPowerW);
  return { success: true, margin: targetPaPowerdB - K };
}

// 统一入口。opt: { mode, powerW, overDb }
function computeLinkMode(satParams, inputs, opt) {
  opt = opt || {};
  const mode = opt.mode || 'margin';

  if (mode === 'margin') {
    const final = calculateLinkBudget(satParams, inputs);
    if (!final.success) return final;
    return { success: true, data: final.data, resolvedMargin: parseFloat(final.data.marginResult), mode };
  }

  let resolvedMargin;
  if (mode === 'power') {
    const w = parseFloat(opt.powerW);
    if (!(w > 0)) return { success: false, message: '请输入有效的功放功率(W)' };
    const s = findMarginByPower(satParams, inputs, w);
    if (!s.success) return s;
    resolvedMargin = s.margin;
  } else if (mode === 'balance') {
    const s = findBalanceMargin(satParams, inputs);
    if (!s.success) return s;
    resolvedMargin = s.margin;
  } else if (mode === 'overbalance') {
    const x = parseFloat(opt.overDb) || 0;
    const s = findBalanceMargin(satParams, inputs);
    if (!s.success) return s;
    resolvedMargin = s.margin + x;
  } else {
    return { success: false, message: '未知计算方式: ' + mode };
  }

  const final = calcWithMargin(satParams, inputs, resolvedMargin);
  if (!final.success) return final;
  return { success: true, data: final.data, resolvedMargin, mode };
}

module.exports = { computeLinkMode, findBalanceMargin, findMarginByPower };
