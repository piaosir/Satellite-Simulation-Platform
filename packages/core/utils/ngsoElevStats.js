// ITU-R P.618-14 §8「Calculation of long-term statistics for non-GSO paths」
//
// 为什么需要这一层：P.618-14 §2.2.1.1 给的是**单条固定仰角路径**的长期雨衰统计（GEO 天然适用）。
// 非静止轨道的仰角随时间变化，§1 h) 与 §2 明确要求 "For non-GSO systems, the variation in
// elevation angle should be included in the calculations, as described in § 8"。§8 的做法是：
//   a) 求系统最小/最大工作仰角；
//   b) 把仰角范围切成小增量（原文 "e.g. 5 degrees wide"，本实现默认 1° 更细，属原文允许的细化）；
//   c) 算卫星落在各增量内的**可见时间百分比** f_i；
//   d) 对给定损伤电平 A，求各增量仰角下该电平被超越的时间百分比 q_i；
//   e) 各增量取 f_i × q_i / 100；
//   f) 求和 → 系统总的超越时间百分比。
// 直接拿「最低仰角」当唯一仰角（GEO 式用法）等价于假设卫星永远停在最低仰角，是「最坏几何 ×
// 最坏气象」的双重最坏叠加，会显著高估（低纬多雨站 + 低仰角门限 + 高可用度要求下可达十几 dB）。
//
// 本模块只做两件事，与具体损伤类型解耦（雨/云/气体都能用）：
//   ① circularElevDistribution —— 近圆轨道的**长期**仰角分布（解析，不需要 TLE/历元）；
//   ② solveP618S8              —— §8 的 e)+f) 求和，反解出「等效仰角」供既有单仰角链路复用。
//
// 纯 JS、无 Vue/DOM，在 Electron 主进程（Node）以 CommonJS 加载。

const D2R = Math.PI / 180;
const RE_KM = 6378.137;          // WGS-84 赤道半径（与 constants.EARTH_RADIUS 同口径）

// ITU-R P.618-14 式(8) 的有效时间百分比区间
const P_MIN = 0.001;
const P_MAX = 5;

/**
 * 仰角 θ → 站-星地心夹角 γ（度）。由 cos(γ + θ) = ρ·cos θ 解出，ρ = Re/(Re+h)。
 * 校验：θ=90° → γ=0；θ=0° → γ=arccos(ρ)（即覆盖半角）。
 */
function centralAngleDeg(elevDeg, rho) {
  const th = elevDeg * D2R;
  const x = Math.max(-1, Math.min(1, rho * Math.cos(th)));
  return (Math.acos(x) - th) / D2R;
}

/**
 * 近圆轨道对某地球站的**长期**仰角分布（§8 步骤 a~c）。
 *
 * 解析依据（不需要 TLE / 不需要数值传播）：
 *   · 星下点纬度 ψ 的长期密度 f(ψ) ∝ cosψ / √(sin²i − sin²ψ)，|ψ| ≤ i。换元 sinψ = sin i · sin u
 *     后对 u 均匀（奇点解析消去），故直接对 u 等间隔采样即得正确的纬度分布。
 *   · 站-星经差 Δλ 的长期分布均匀（地球自转 + RAAN 进动充分混合）。
 *     ★ 这正是「不能用 24h SGP4 时窗做统计」的原因：LEO 一天只十几圈、RAAN 进动周期几十天，
 *       数值时窗远未混合，代表不了 long-term；解析式直接给出混合后的极限分布。
 *   · 给定 ψ，仰角 ≥ θ_b ⟺ cos γ ≥ cos γ_b ⟺ cos Δλ ≥ (cos γ_b − sinψ sinφ)/(cosψ cosφ)，
 *     Δλ 均匀 ⇒ 该条件的时间占比 = arccos(X)/π（X 夹到 [-1,1] 外则为 1 或 0）。
 *     Δλ 方向解析积分，只对 ψ 采样 → 快且无蒙特卡洛噪声。
 *
 * 适用边界：**近圆轨道**。大偏心率轨道（HEO/Molniya）高度随真近点角变化，本式不成立。
 * 倾角 i 与 180−i 的星下点纬度带相同（用 |sin i|），顺/逆行轨道结果一致。
 *
 * @param {object} opt
 *   latDeg      地球站纬度（度）
 *   altKm       轨道高度（km，圆轨道）
 *   inclDeg     轨道倾角（度）
 *   minElevDeg  最低工作仰角（度）
 *   binDeg      仰角增量宽度（度，默认 1；ITU 原文示例 5）
 *   uSamples    ψ 方向采样数（默认 4096）
 * @returns {object} { visFrac, bins:[{elDeg,w}], edges, minElevDeg, maxElevDeg, binDeg }
 *   visFrac —— 全年内仰角 ≥ minElev 的时间占比（0~1）；bins.w 之和 = visFrac（未归一化）
 */
function circularElevDistribution(opt) {
  opt = opt || {};
  const latDeg = Number(opt.latDeg);
  const altKm = Number(opt.altKm);
  const inclDeg = Number(opt.inclDeg);
  const binDeg = Number(opt.binDeg) > 0 ? Number(opt.binDeg) : 1;
  const nu = Number(opt.uSamples) > 0 ? Math.round(Number(opt.uSamples)) : 4096;

  if (!Number.isFinite(latDeg) || Math.abs(latDeg) > 90) return { error: true, message: '站址纬度无效' };
  if (!Number.isFinite(altKm) || altKm <= 0) return { error: true, message: '轨道高度需大于 0 km' };
  if (!Number.isFinite(inclDeg) || inclDeg < 0 || inclDeg > 180) return { error: true, message: '轨道倾角需在 0~180° 之间' };
  const minElevDeg = Math.max(0, Math.min(89, Number(opt.minElevDeg) || 0));

  const rho = RE_KM / (RE_KM + altKm);
  const phi = latDeg * D2R;
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
  const sinI = Math.abs(Math.sin(inclDeg * D2R));

  // 仰角增量边界：[minElev, minElev+bin, …, 90]
  const edges = [];
  for (let e = minElevDeg; e < 90 - 1e-9; e += binDeg) edges.push(e);
  edges.push(90);
  const nE = edges.length;
  const cosGamma = edges.map((e) => Math.cos(centralAngleDeg(e, rho) * D2R));

  // S[k] = P(仰角 ≥ edges[k])，在 ψ 上取平均（Δλ 已解析积分）
  const S = new Float64Array(nE);
  for (let a = 0; a < nu; a++) {
    const u = 2 * Math.PI * (a + 0.5) / nu;
    const psi = Math.asin(Math.max(-1, Math.min(1, sinI * Math.sin(u))));
    const sp = Math.sin(psi), cp = Math.cos(psi);
    const den = cp * cosPhi;
    for (let k = 0; k < nE; k++) {
      const need = cosGamma[k] - sp * sinPhi;
      let frac;
      if (Math.abs(den) < 1e-12) {
        frac = (need <= 0) ? 1 : 0;                       // 与 Δλ 无关（极点站 / 星过极点）
      } else {
        const X = need / den;
        frac = X <= -1 ? 1 : (X >= 1 ? 0 : Math.acos(X) / Math.PI);
      }
      S[k] += frac;
    }
  }
  for (let k = 0; k < nE; k++) S[k] /= nu;

  const visFrac = S[0];
  const bins = [];
  for (let k = 0; k < nE - 1; k++) {
    const w = S[k] - S[k + 1];
    if (w > 1e-12) bins.push({ elDeg: (edges[k] + edges[k + 1]) / 2, w });
  }
  // 实际可达的最高仰角（最后一个有权重的增量的上沿）
  let maxElevDeg = minElevDeg;
  for (let k = nE - 1; k >= 1; k--) { if (S[k - 1] - S[k] > 1e-9) { maxElevDeg = edges[k]; break; } }

  return { visFrac, bins, edges, minElevDeg, maxElevDeg, binDeg };
}

/**
 * ITU-R P.618-14 §8 步骤 d)~f) + 等效仰角反解。
 *
 * 口径 = **可见期口径**（卫星可服务期间）：权重按 Σf_i 归一到 100%，目标超越概率 p 即
 * 「服务期内损伤超过该电平的时间占比」= 100 − 可用度。连续覆盖星座下这正是工程要的口径；
 * visFrac 一并返回，单星系统据此可自行换算到全年口径（两口径线性差 100/Σf_i 的比例）。
 *
 * 等效仰角 = 「使**单仰角** ITU 方法在同一 p 下给出同样衰减」的那个仰角。把它注回既有单仰角
 * 链路，雨衰严格等于 §8 结果，且下游（气体/云/闪烁/XPD/降雨噪温/G-T 衰减）也一并摆脱
 * 「钉在最低仰角」的双重最坏——注意这些量是按**雨衰等效**的仰角求值，属工程近似而非各自的 §8 解。
 *
 * 性能：§8 反解是三层嵌套（反解 A 的二分 × 仰角箱 × 各箱反解 q 的二分），直接逐点调 attenAt
 * 是 ~40 万次求值/次（曲线扫 120 点时把 Electron 主进程冻十几秒）。故先给每个仰角箱建一张
 * ln A–ln p 插值表（A(p) 近幂律，log-log 下近直线，64 点插值误差 ≪0.01 dB），内层反解退化为
 * 6 步二分 + 线性插值；调用方可传 opt.cache（同一几何+气象复用的空对象）让表跨调用复用——
 * 可用度轴扫描时表完全不变，逐点近零成本。
 *
 * @param {object} opt
 *   bins        circularElevDistribution 的仰角增量（w 未归一亦可）
 *   p           目标超越时间百分比（%），= 100 − 可用度
 *   minElevDeg  最低工作仰角（度），等效仰角的下界
 *   attenAt     (elevDeg, pPct) => 衰减 dB —— 单仰角 ITU 方法（调用方注入，含 A0.01 缓存）
 *   cache       可选：跨调用复用的表缓存（调用方按「几何+气象」键持有的空对象，内容本模块管理）
 * @returns {object} { atten, elevEq, clamped, argminDeg, attenAtMinElev, p } 或 { error, message }
 */
const TAB_NP = 64;   // 每箱 p 网格点数（log 均匀，覆盖式(8) 全域 0.001%~5%）

function solveP618S8(opt) {
  opt = opt || {};
  const bins = opt.bins || [];
  const p = Number(opt.p);
  const attenAt = opt.attenAt;
  const minElevDeg = Math.max(0, Math.min(89, Number(opt.minElevDeg) || 0));

  if (typeof attenAt !== 'function') return { error: true, message: '缺少单仰角衰减函数' };
  if (!bins.length) return { error: true, message: '仰角分布为空（该轨道对本站始终不可见）' };
  if (!(p > 0)) return { error: true, message: '目标超越概率需大于 0（可用度须小于 100%）' };
  if (p > P_MAX) return { error: true, message: `可用度低于 95% 超出 ITU-R P.618-14 式(8) 有效域（p ≤ ${P_MAX}%）` };

  const wSum = bins.reduce((s, b) => s + b.w, 0);
  if (!(wSum > 0)) return { error: true, message: '仰角分布权重为 0' };
  const W = bins.map((b) => b.w / wSum);           // 可见期口径归一
  const EL = bins.map((b) => b.elDeg);

  // —— 每箱 ln A–ln p 插值表：tab[i][j] = ln A(EL_i, p_j)，p_j 在 [P_MIN, P_MAX] 上 log 均匀 ——
  // A(p) 随 p 单调递减 ⇒ 行内严格递减。表只依赖（几何箱 + A0.01 + 站纬），与目标 p 无关，可缓存。
  const cache = (opt.cache && typeof opt.cache === 'object') ? opt.cache : null;
  let lnP, tab;
  if (cache && cache.tab && cache.np === TAB_NP && cache.nBins === EL.length) {
    lnP = cache.lnP; tab = cache.tab;
  } else {
    const lnPmin = Math.log(P_MIN), lnPmax = Math.log(P_MAX);
    lnP = new Float64Array(TAB_NP);
    for (let j = 0; j < TAB_NP; j++) lnP[j] = lnPmin + (lnPmax - lnPmin) * j / (TAB_NP - 1);
    tab = EL.map((e) => {
      const row = new Float64Array(TAB_NP);
      for (let j = 0; j < TAB_NP; j++) row[j] = Math.log(Math.max(attenAt(e, Math.exp(lnP[j])), 1e-300));
      return row;
    });
    if (cache) { cache.lnP = lnP; cache.tab = tab; cache.np = TAB_NP; cache.nBins = EL.length; }
  }

  // §8 步骤 d)：给定损伤电平 A（以 lnA 传入），第 i 个仰角增量下该电平被超越的时间百分比 q_i。
  // 表内二分定位 + ln-ln 线性插值，替代原先每次 60 步的 attenAt 二分（性能瓶颈所在）。
  const qOf = (i, lnA) => {
    const row = tab[i];
    if (lnA >= row[0]) return 0;                   // 比 0.001% 处的值还大 → 有效域内视为不超越
    if (lnA <= row[TAB_NP - 1]) return P_MAX;      // 比 5% 处的值还小 → 封顶在有效域上界
    let lo = 0, hi = TAB_NP - 1;                   // 不变量：row[lo] > lnA ≥ row[hi]
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (row[m] > lnA) lo = m; else hi = m; }
    const t = (row[lo] - lnA) / (row[lo] - row[hi]);
    return Math.exp(lnP[lo] + (lnP[hi] - lnP[lo]) * t);
  };
  // §8 步骤 e)+f)：Σ 时间占比 × 超越占比（W 已归一，故不再除 100）
  const totalExceed = (lnA) => { let s = 0; for (let i = 0; i < W.length; i++) s += W[i] * qOf(i, lnA); return s; };

  // 反解损伤电平 A：使系统总超越时间百分比 = p。totalExceed 关于 A 单调不增。
  let aLo = 0, aHi = 0;
  for (let i = 0; i < tab.length; i++) { const v = Math.exp(tab[i][0]); if (v > aHi) aHi = v; }
  // 各仰角衰减恒为 0（无降雨 / 降雨率小到不产生衰减）：§8 加权没有对象，等效仰角无从定义。
  // 优雅退化到最低仰角并标记，而不是报错——衰减本来就是 0，其余项按最低仰角取保守值即可。
  if (!(aHi > 1e-12)) {
    return { atten: 0, elevEq: minElevDeg, clamped: false, argminDeg: minElevDeg, attenAtMinElev: 0, p, degenerate: 'noatten' };
  }
  for (let k = 0; k < 60; k++) { const m = (aLo + aHi) / 2; if (totalExceed(Math.log(Math.max(m, 1e-300))) > p) aLo = m; else aHi = m; }
  const atten = (aLo + aHi) / 2;

  // —— 等效仰角 ——
  // ★ A(p, ε) 对 ε **并非全程单调**：气/云/闪烁随仰角单调递减，但雨衰在高仰角回升——式(8) 的
  //   −β(1−p)·sinθ 项随仰角抬高缩放系数，与 A0.01 随仰角减小的趋势竞争，高雨强站在 ~60° 翻转。
  //   直接对 ε 二分会把这类站的等效仰角恒判成 90°。正解：粗扫定位极小点，只在递减段内二分。
  let argminDeg = minElevDeg, aMin = Infinity;
  for (let e = minElevDeg; e <= 90 + 1e-9; e += 1) {
    const v = attenAt(e, p);
    if (v < aMin) { aMin = v; argminDeg = e; }
  }
  const attenAtMinElev = attenAt(minElevDeg, p);

  let elevEq, clamped = false;
  if (atten >= attenAtMinElev) {
    elevEq = minElevDeg;                           // §8 结果不应高于最低仰角处的值；兜底
  } else if (atten <= aMin) {
    elevEq = argminDeg; clamped = true;            // 落在递减段之下 → 钳到极小点并标记
  } else {
    let lo = minElevDeg, hi = argminDeg;
    for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (attenAt(m, p) > atten) lo = m; else hi = m; }
    elevEq = (lo + hi) / 2;
  }

  return { atten, elevEq, clamped, argminDeg, attenAtMinElev, p };
}

module.exports = { circularElevDistribution, solveP618S8, centralAngleDeg, P_MIN, P_MAX };
