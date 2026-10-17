// GEO 链路预算「计算方式」求解器（自小程序 pages/index 反向/正向逻辑移植，主进程内求解）。
// 引擎 calculateLinkBudget 本身是「给定余量 → 算功放/带宽」的反向模型；本模块在其外层
// 决定喂入的余量，实现四种计算方式，全部归结为「定出余量后再算一次」：
//   margin      设置余量：直接用输入余量算功放（引擎默认行为）
//   power       设置瓦数：由目标功放功率解析反推余量（P_dBW = 余量 + K）
//   balance     功带平衡：令分配带宽 = 功率带宽 的余量（闭式解，见 findBalanceMargin）
//   overbalance 超发功带平衡：平衡余量 + 超发 x dB（功放超发 x dB ⇒ 余量同抬 x dB，自动）

const geoEngine = require('./linkCalculator.js');
const { calculateLinkBudget } = geoEngine;
// 求解器自己读的几项入参（目标余量 / 功放功率 / 超发量）与引擎同一严格口径：「40 W」不按前缀读成 40
const { strictNum } = require('./strictNum.js');
// NGSO 引擎独立加载并容错（其依赖在个别环境可能加载异常，不应连累 GEO 主链路）
let calculateLinkBudgetNGSO = null;
let boostNGSO = null;
try {
  const ngso = require('./linkCalculatorNGSO.js');
  calculateLinkBudgetNGSO = ngso.calculateLinkBudget;
  boostNGSO = ngso.setOutputPrecisionBoost || null;
}
catch (e) { /* NGSO 引擎不可用时 computeLinkModeNGSO 会返回明确报错 */ }

// 当前求解使用的引擎（GEO 默认）。所有 calcWithMargin/findBalanceMargin/findMarginByPower
// 都经此间接调用，实现「同一套四种计算方式逻辑，GEO/NGSO 共用」。
// BOOST 是同一引擎模块的出参小数位增量开关（setOutputPrecisionBoost），随 ENGINE 一起切换。
let ENGINE = calculateLinkBudget;
let BOOST = geoEngine.setOutputPrecisionBoost || null;

// 以指定余量执行一次计算（高精度字符串传 margin，保留完整精度）
function calcWithMargin(satParams, inputs, margin) {
  const m = typeof margin === 'number' ? margin.toFixed(10) : String(margin);
  return ENGINE(satParams, Object.assign({}, inputs, { margin: m }));
}

// 功带平衡：令分配带宽 = 功率带宽 的余量。
//
// 引擎里余量只从 carrierTotalCT = 载波门限 + margin 一处进入：功率占用 = 10^((carrierTotalCT − 转发器可用C/T)/10)，
// 功率带宽 = 功率占用 × 转发器带宽，分配带宽只由速率 / 调制 / 滚降定 ⇒ 功率带宽 ∝ 10^(margin/10)，平衡点闭式可解：
//     m* = m₀ + 10·lg(分配带宽 / 功率带宽(m₀))
// 高级计算（shared/advBalance.js 的「单载波平衡点」）用的是同一条标度律，两处的平衡余量由此逐位对得上。
// 落点按对数域牛顿迭代走（标度律成立时第一步即到、第二步核对），期间出参小数位临时抬 6 位：功率带宽出参只有
// 3 位小数，小载波（1 kHz 量级）上那一位就值 2e-3 dB。迭代不收敛或解落出 ±50 dB（引擎哪天改了余量的进入方式、
// 或该载波压根平衡不了）则交回原来的搜索，口径与从前一致。
// 原先只有搜索：它以 0.01 dB 步长的局部最优判停，平衡余量带 ±0.005 dB 误差（实测 |分配带宽 − 功率带宽| 达
// 0.08%～0.1%，8.7 MHz 前向载波差 7.2 kHz），一行还要跑约 30 次引擎。
function findBalanceMargin(satParams, inputs) {
  const closed = findBalanceMarginClosed(satParams, inputs);
  if (closed) return closed;
  return findBalanceMarginSearch(satParams, inputs);
}

// 闭式落点：返回 { success, margin } / 引擎报错 { success:false, message }；不收敛返回 null（交给搜索）
function findBalanceMarginClosed(satParams, inputs) {
  const m0 = strictNum(inputs && inputs.margin);
  let m = isFinite(m0) && Math.abs(m0) <= 50 ? m0 : 0;
  const prev = BOOST ? BOOST(6) : null;
  try {
    for (let i = 0; i < 8; i++) {
      const r = calcWithMargin(satParams, inputs, m);
      // ★ 引擎的报错原文一路往上带（同搜索那条路）：3GPP 载波参数越界一类的诊断要让用户看见
      if (!r.success) return { success: false, message: r.message || '计算过程出错' };
      const alloc = parseFloat(r.data.allocBandwidthResult);
      const pbw = parseFloat(r.data.PowerBWResult);
      if (!(alloc > 0) || !(pbw > 0)) return null;
      const step = 10 * Math.log10(alloc / pbw);
      if (Math.abs(step) < 1e-7) return { success: true, margin: m };
      m += step;
      if (!(Math.abs(m) <= 50)) return null;
    }
    return null;
  } finally {
    if (BOOST) BOOST(prev);
  }
}

// 搜索兜底（原「二分」实现，逐字保留）：使分配带宽与功率带宽差异最小的余量
function findBalanceMarginSearch(satParams, inputs) {
  let lo = -50, hi = 50;
  const maxIter = 300, tol = 0.001;
  // ★ 引擎的报错原文一路往上带：3GPP 载波参数越界一类的诊断（「I_TBS=10 的子帧数上限 4」）
  //   要是在这里吞成「计算过程出错」，功带平衡这条路上用户就永远不知道该改哪一格。
  const test = (m) => {
    const r = calcWithMargin(satParams, inputs, m);
    if (!r.success) return { diff: Infinity, error: true, message: r.message };
    const alloc = parseFloat(r.data.allocBandwidthResult) || 0;
    const pbw = parseFloat(r.data.PowerBWResult) || 0;
    return { diff: Math.abs(alloc - pbw), error: false };
  };
  let mid = (lo + hi) / 2;
  for (let i = 0; i < maxIter; i++) {
    mid = (lo + hi) / 2;
    const c = test(mid);
    if (c.error) return { success: false, message: c.message || '计算过程出错' };
    if (c.diff <= tol) return { success: true, margin: mid };
    const plus = test(mid + 0.01);
    if (plus.error) return { success: false, message: plus.message || '计算过程出错' };
    if (plus.diff < c.diff) {
      lo = mid; // 向更高余量搜索
    } else {
      const minus = test(mid - 0.01);
      if (minus.error) return { success: false, message: minus.message || '计算过程出错' };
      if (minus.diff < c.diff) hi = mid; // 向更低余量搜索
      else return { success: true, margin: mid }; // 局部最优
    }
  }
  return { success: true, margin: mid };
}

// 设置瓦数：解析反推余量（只需 2 次计算，全程高精度）
function findMarginByPower(satParams, inputs, targetPaPowerW) {
  const currentMargin = strictNum(inputs.margin);
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
    const final = ENGINE(satParams, inputs);
    if (!final.success) return final;
    // resolvedMargin＝真正喂进引擎的那个余量，必须全精度：本方式下它就是输入本身，别从
    // data.marginResult 回读——那是显示值（toFixed(2)），4.567 会读成 4.57。高级计算拿它做
    // 归一功率带宽 A = 功率带宽 / 10^(余量/10) 的基准，0.005 dB 的截断会让配平结果整体偏同样的量，
    // 反复应用还会在两个值之间来回跳。空余量走引擎默认（3 dB），此时才回读。
    const m = strictNum(inputs && inputs.margin);
    return {
      success: true, data: final.data, mode,
      resolvedMargin: isFinite(m) ? m : parseFloat(final.data.marginResult)
    };
  }

  let resolvedMargin;
  if (mode === 'power') {
    const w = strictNum(opt.powerW);
    if (!(w > 0)) return { success: false, message: '功放功率(W) 无效' };
    const s = findMarginByPower(satParams, inputs, w);
    if (!s.success) return s;
    resolvedMargin = s.margin;
  } else if (mode === 'balance') {
    const s = findBalanceMargin(satParams, inputs);
    if (!s.success) return s;
    resolvedMargin = s.margin;
  } else if (mode === 'overbalance') {
    const x = strictNum(opt.overDb) || 0;
    const s = findBalanceMargin(satParams, inputs);
    if (!s.success) return s;
    resolvedMargin = s.margin + x;
  } else {
    return { success: false, message: '未知计算方式：' + mode };
  }

  const final = calcWithMargin(satParams, inputs, resolvedMargin);
  if (!final.success) return final;
  return { success: true, data: final.data, resolvedMargin, mode };
}

// NGSO「计算方式」求解器：复用上面全部四种方式逻辑，仅切换引擎为 NGSO，
// 并永久将星间链路跳数强制为 0（NGSO 预算模块已删除 ISL）。
function computeLinkModeNGSO(satParams, inputs, opt) {
  if (!calculateLinkBudgetNGSO) {
    return { success: false, message: 'NGSO 引擎不可用（linkCalculatorNGSO 加载失败）' };
  }
  const sp = Object.assign({}, satParams || {}, { islHops: 0 });
  const prev = ENGINE;
  const prevBoost = BOOST;
  ENGINE = calculateLinkBudgetNGSO;
  BOOST = boostNGSO;
  try {
    return computeLinkMode(sp, inputs || {}, opt || {});
  } finally {
    ENGINE = prev; // 复位，保证 GEO 调用不受影响
    BOOST = prevBoost;
  }
}

module.exports = { computeLinkMode, computeLinkModeNGSO, findBalanceMargin, findMarginByPower };
