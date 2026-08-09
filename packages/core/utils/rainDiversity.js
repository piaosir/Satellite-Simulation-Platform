// 多站总可用度 —— 纯概率论核（2026-08-10 按最初设计重做，相关档/ITU 二元内核已整体移除）。
//
// 口径：
//   · 输入：各站不可用度 p_i（表内直接给可用度，或由「可承受衰减」经 A(p) 反解 ——
//     反解在 rainAttenuation.js，本文件不认识传播模型）+ 最少可用站数 nMin。
//   · 系统不可用 = P(同时中断的站数 S ≥ L)，L = 参与站数 − 最少可用站数 + 1。
//     S 服从 Poisson–binomial（各站 p_i 可不同），DP 卷积精确计算，禁用 2^M 枚举。
//   · 【绝不连乘】系统不可用 ≠ Π p_i。连乘只是 L=M（nMin=1，全部站同时中断）那一格；
//     nMin > 1 时两者差几个数量级（7 站各 1e−3 连乘出 1e−21，物理上不存在的数）。
//   · 各站中断按相互独立计（用户定的口径）。独立假设的偏向随 L 变：L=1（全主用，一站倒
//     即系统倒）时偏保守，L≥2（有备份）时偏乐观 —— 只作口径记录，不进结果修正。
//   · 切换不进概率模型（静态联合概率没有时间轴），只作独立可加项
//     U_sw = N_sw × T_sw / 全年分钟数，与聚合值相加成合计（见 switchBudget）。
//
// 纯 JS、无 Vue/DOM，在 Electron 主进程（Node）以 CommonJS 加载。

/**
 * 中断站数分布 P(S = j)，j = 0..M。DP 卷积 O(M²)。
 * p_i 升序卷积以压住尾部下溢。
 * @param {number[]} ps 各站不可用概率（0~1 的分数，不是百分数）
 */
function poissonBinomialPmf(ps) {
  const q = ps.slice().sort((a, b) => a - b);
  let f = [1];
  for (const p of q) {
    const g = new Array(f.length + 1).fill(0);
    for (let j = 0; j < f.length; j++) {
      g[j] += f[j] * (1 - p);
      g[j + 1] += f[j] * p;
    }
    f = g;
  }
  return f;
}

/** 尾概率 P(S ≥ L)。L ≤ 0 恒为 1；L > M 恒为 0 */
function tailAtLeast(pmf, L) {
  if (L <= 0) return 1;
  let s = 0;
  for (let j = Math.max(0, L); j < pmf.length; j++) s += pmf[j];
  return Math.min(1, Math.max(0, s));
}

/**
 * 系统聚合：给各站不可用度与「最少可用站数」，出系统不可用度。
 * @param {number[]} outagePcts 各站不可用度（%）
 * @param {number}   nMin       最少可用站数
 */
function aggregate(outagePcts, nMin) {
  const ps = outagePcts.map((v) => Math.min(1, Math.max(0, Number(v) / 100 || 0)));
  const M = ps.length;
  const L = M - Math.round(nMin) + 1;
  const pmf = poissonBinomialPmf(ps);
  return { unavail: tailAtLeast(pmf, L), pmf, L, M, nMin: Math.round(nMin) };
}

// ============================================================================
// 切换预算（时间轴以「事件计数」进入）
// ============================================================================

const MIN_PER_YEAR = 525960;   // 365.25 d × 24 h × 60 min

/**
 * 切换预算：单次切换时长 × 年切换次数 → 年不可用度；反向给不可用预算 → 一年最多切几次。
 * 纯算术、无适用域。缺输入的项不给数（不编数）。
 * @param {object} o { tSwMin, uBudgetPct, nSwPerYear }
 */
function switchBudget(o) {
  o = o || {};
  const tSw = Number(o.tSwMin);
  const uB = Number(o.uBudgetPct);
  const out = { tSwMin: tSw, uBudgetPct: uB };
  if (tSw > 0 && Number.isFinite(uB) && uB >= 0) {
    out.maxSwitchesPerYear = (uB / 100) * MIN_PER_YEAR / tSw;
  }
  const n = Number(o.nSwPerYear);
  if (Number.isFinite(n) && n >= 0) out.nSwPerYear = n;   // 回显：结果页/报表的「切换次数」行取这里
  if (tSw > 0 && Number.isFinite(n) && n >= 0) {
    out.switchUnavailPct = 100 * n * tSw / MIN_PER_YEAR;
    out.switchDowntimeH = n * tSw / 60;
  }
  return out;
}

module.exports = {
  poissonBinomialPmf, tailAtLeast, aggregate,
  switchBudget, MIN_PER_YEAR
};
