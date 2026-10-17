// 地面业务干扰传播库 · ITU-R P.2109-2（08/2023）建筑物进入损耗（Building entry loss, BEL）
//
// 附件 1 §3：不超过概率 P 的进入损耗由两条对数正态分布与一个常数项按功率相加（式 (1)–(10)，表 1 系数），
// 不区分外墙穿透与楼内衰减，也不针对具体建筑——为共用/兼容性研究的统计口径。
// 两类建筑（§2.1，只按建材热效率分，不看年代/层数）：
//   'traditional'         传统建筑
//   'thermallyEfficient'  热效率型（金属化玻璃、箔衬保温板等），损耗明显更高
// 出口损耗与进入损耗数值相同（附件 2 §3.5，互易），室内↔室外两个方向用同一套函数。
// 原文按全向室内天线定义；楼内定向天线会更高（附件 1 §2 举例 32 GHz、10° 波束宽 +5.3 dB），不在本模型内。
//
// 「概率分布形式」：σ1、σ2 > 0 时式 (2)(3) 两项都随 F⁻¹(P) 单调增，故 L(P) 关于 P 严格递增；
// P → 0 时只剩常数项，下确界为 C = −3 dB；P → 1 时趋于 +∞。据此给出：
//   buildingEntryLoss  给定 P 求 L（式 (1)）
//   belQuantiles       一组 P 求 L（缺省取 0.01…0.99 每 0.01 一点，即实测验证区间）
//   belCdf             给定 L 求 P：在 P ∈ [1e-12, 1 − 1e-12] 内二分求逆
//   belMedian          P = 0.5
//   belSample          逆变换抽样 L = L(U)，U 取自调用方的 rng()，供蒙特卡洛（原文 §1 明确允许）
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据
//   公式与表 1 逐条对照 ITU 官方 PDF（R-REC-P.2109-2-202308-I）第 3–4 页，未凭记忆。
//   数值与 ITU-R SG3 官方工作簿「Clutter and BEL workbook_V2.xlsx」BEL 页逐点对拍（test/p2109.test.mjs）。
//
// 口径取舍
//   ① 适用范围：频率约 0.08–100 GHz（§2）；P 只在 0.01–0.99 内经实测验证（§1）。越界照算并写 warnings。
//      P ∉ (0, 1)（Scope 写 0.0 < P < 1.0；P = 1 时 L 为无穷）、|θ| > 90°、未知建筑类型返回 { error }。
//   ② σ1 = u + v·lg f、σ2 = y + z·lg f 在远超适用范围的频率上会过零（传统建筑 σ2 在 f ≥ 10^2.25 ≈ 178 GHz
//      处 ≤ 0），此时 L(P) 不再是合法的分布函数，返回 { error } 而不是给出一条非单调的「分布」。
//   ③ 仰角修正按式 (10) 取 |θ|。官方工作簿 BEL 页写作 θ·0.212（未取绝对值），只在 θ < 0 时有别；
//      其基准表取 θ = 0，对拍不受影响。
//   ④ F⁻¹ 取 common.js 的 invNormal（AS241，机器精度）。工作簿用 Excel NORMINV，同为高精度。
//
// 纯函数、仅依赖 ./common.js，CommonJS。

const { invNormal } = require('./common.js');

const LOG10 = Math.log10;

function num(v) {
  return (v === undefined || v === null || v === '') ? NaN : Number(v);
}
function numOr(v, d) {
  return (v === undefined || v === null || v === '') ? d : Number(v);
}
// 告警里的数值：6 位有效数字、去掉尾零。
function fmt(x) {
  return String(Number(Number(x).toPrecision(6)));
}
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/**
 * 表 1：模型系数。r、s、t → μ1（经 Lh）；u、v → σ1；w、x → μ2；y、z → σ2。
 */
const BEL_COEFFS = Object.freeze({
  traditional:        Object.freeze({ r: 12.64, s: 3.72,  t: 0.96, u: 9.6,  v: 2.0, w: 9.1,  x: -3.0, y: 4.5, z: -2.0 }),
  thermallyEfficient: Object.freeze({ r: 28.19, s: -3.00, t: 8.48, u: 13.5, v: 3.8, w: 27.8, x: -2.9, y: 9.4, z: -2.1 }),
});

const C_DB = -3.0;                 // 式 (4)
const LIN_C = Math.pow(10, 0.1 * C_DB);
const P_VALID_LO = 0.01;           // §1：实测验证的概率区间
const P_VALID_HI = 0.99;
const P_SOLVE_LO = 1e-12;          // belCdf 求逆区间
const P_SOLVE_HI = 1 - 1e-12;

const pWarn = (P) => `P = ${fmt(P)} 超出模型验证范围 0.01–0.99`;

// 校验 f / 建筑类型 / 仰角，并算出与 P 无关的分布参数（式 (5)–(10)）。
function prepare(q) {
  const f = num(q.fGHz), th = numOr(q.elevDeg, 0);
  if (!(f > 0)) return { error: '频率须为正数（GHz）' };
  if (!has(BEL_COEFFS, q.buildingType)) {
    return { error: `未知建筑类型「${q.buildingType}」，可选：${Object.keys(BEL_COEFFS).join(' / ')}` };
  }
  if (!(Math.abs(th) <= 90)) return { error: '仰角须在 −90°–90° 之间' };

  const k = BEL_COEFFS[q.buildingType];
  const lf = LOG10(f);
  const Lh = k.r + k.s * lf + k.t * lf * lf;      // P.2109-2 附件 1 §3 式 (9)：水平路径中值损耗
  const Le = 0.212 * Math.abs(th);                // 式 (10)：外立面处路径仰角修正
  const mu1 = Lh + Le;                            // 式 (5)
  const mu2 = k.w + k.x * lf;                     // 式 (6)
  const sigma1 = k.u + k.v * lf;                  // 式 (7)
  const sigma2 = k.y + k.z * lf;                  // 式 (8)
  if (!(sigma1 > 0 && sigma2 > 0)) {
    return { error: `频率 ${fmt(f)} GHz 处 σ1 = ${fmt(sigma1)} dB、σ2 = ${fmt(sigma2)} dB，须均为正` };
  }

  const warnings = [];
  if (f < 0.08 || f > 100) warnings.push(`频率 ${fmt(f)} GHz 超出适用范围约 0.08–100 GHz`);
  return { m: { mu1, mu2, sigma1, sigma2, Lh, Le }, warnings };
}

// 式 (1)–(3)：z = F⁻¹(P)。
function lossAt(m, z) {
  const A = z * m.sigma1 + m.mu1;                 // 式 (2)
  const B = z * m.sigma2 + m.mu2;                 // 式 (3)
  const L = 10 * LOG10(Math.pow(10, 0.1 * A) + Math.pow(10, 0.1 * B) + LIN_C);   // 式 (1)
  return { L, A, B };
}

// logit 的反函数，两支写法分别在 u ≥ 0 / u < 0 时不丢有效位。
function logistic(u) {
  if (u >= 0) return 1 / (1 + Math.exp(-u));
  const e = Math.exp(u);
  return e / (1 + e);
}

/**
 * 不超过概率 P 的建筑物进入损耗 L_BEL(P)（dB），式 (1)。
 *
 * @param {object} q
 *   fGHz          频率（GHz），适用约 0.08–100
 *   P             损耗不被超过的概率，0 < P < 1（0.01–0.99 为实测验证区间）
 *   buildingType  'traditional' | 'thermallyEfficient'
 *   elevDeg       外立面处路径仰角（度，相对水平面），缺省 0；按 |θ| 计
 * @returns {object} { L, A, B, C, mu1, mu2, sigma1, sigma2, Lh, Le, warnings }；入参无效时返回 { error }
 */
function buildingEntryLoss(q) {
  q = q || {};
  const pr = prepare(q);
  if (pr.error) return { error: pr.error };
  const P = num(q.P);
  if (!(P > 0 && P < 1)) return { error: '概率 P 须在 (0, 1) 内' };

  const warnings = pr.warnings.slice();
  if (P < P_VALID_LO || P > P_VALID_HI) warnings.push(pWarn(P));
  const { L, A, B } = lossAt(pr.m, invNormal(P));
  return { L, A, B, C: C_DB, ...pr.m, warnings };
}

/**
 * 一组概率上的 L_BEL —— 画累积分布用。
 *
 * @param {object} q  { fGHz, buildingType, elevDeg = 0, probs }
 *   probs 缺省为 0.01, 0.02, …, 0.99（实测验证区间，99 点）
 * @returns {Array<{P, L, warnings}>|{error}}
 *   每点的 warnings 与对该 P 调用 buildingEntryLoss 所得相同（频率越界会在每点重复出现）。
 */
function belQuantiles(q) {
  q = q || {};
  const pr = prepare(q);
  if (pr.error) return { error: pr.error };
  let probs = q.probs;
  if (probs === undefined || probs === null) {
    probs = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
  } else if (!Array.isArray(probs) && !ArrayBuffer.isView(probs)) {
    return { error: 'probs 须为概率数组' };
  }

  const out = new Array(probs.length);
  for (let i = 0; i < probs.length; i++) {
    const P = num(probs[i]);
    if (!(P > 0 && P < 1)) return { error: `probs[${i}] = ${probs[i]}，概率须在 (0, 1) 内` };
    const warnings = pr.warnings.slice();
    if (P < P_VALID_LO || P > P_VALID_HI) warnings.push(pWarn(P));
    out[i] = { P, L: lossAt(pr.m, invNormal(P)).L, warnings };
  }
  return out;
}

/**
 * 累积分布函数：给定损耗 L（dB），求 P 使 L_BEL(P) = L，即「进入损耗不超过 L」的概率。
 *
 * L(P) 严格递增，在 P ∈ [1e-12, 1 − 1e-12] 上二分。二分变量取 logit(P) = ln(P/(1−P)) 而非 P 本身：
 * 两端尾部的相对精度一致（P 在 1e-12 附近也能收敛到双精度分辨率），约 60 次迭代。
 * L 不高于 L(1e-12) 或不低于 L(1 − 1e-12) 时返回对应端点并置 clamped（注意 L ≤ −3 dB 时真值为 0）。
 *
 * @param {object} q  { fGHz, buildingType, elevDeg = 0, L }
 * @returns {object} { P, clamped: null|'low'|'high', warnings }；入参无效时返回 { error }
 */
function belCdf(q) {
  q = q || {};
  const pr = prepare(q);
  if (pr.error) return { error: pr.error };
  const Lt = num(q.L);
  if (!Number.isFinite(Lt)) return { error: '损耗 L 须为有限数（dB）' };

  const warnings = pr.warnings.slice();
  const at = (P) => lossAt(pr.m, invNormal(P)).L;
  const Llo = at(P_SOLVE_LO), Lhi = at(P_SOLVE_HI);
  if (Lt <= Llo) {
    warnings.push(`L = ${fmt(Lt)} dB 不高于 P = 1e-12 处的 ${fmt(Llo)} dB，P 取下界`);
    return { P: P_SOLVE_LO, clamped: 'low', warnings };
  }
  if (Lt >= Lhi) {
    warnings.push(`L = ${fmt(Lt)} dB 不低于 P = 1 − 1e-12 处的 ${fmt(Lhi)} dB，P 取上界`);
    return { P: P_SOLVE_HI, clamped: 'high', warnings };
  }

  let lo = Math.log(P_SOLVE_LO / (1 - P_SOLVE_LO)), hi = -lo;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid <= lo || mid >= hi) break;            // 区间已到双精度分辨率
    if (at(logistic(mid)) < Lt) lo = mid; else hi = mid;
  }
  const P = logistic(0.5 * (lo + hi));
  if (P < P_VALID_LO || P > P_VALID_HI) warnings.push(pWarn(P));
  return { P, clamped: null, warnings };
}

/**
 * 中值损耗（P = 0.5）。此时 F⁻¹ = 0，L = 10lg(10^(0.1μ1) + 10^(0.1μ2) + 10^(0.1C))。
 * @param {object} q  { fGHz, buildingType, elevDeg = 0 }
 * @returns {object} 同 buildingEntryLoss
 */
function belMedian(q) {
  return buildingEntryLoss(Object.assign({}, q, { P: 0.5 }));
}

/**
 * 蒙特卡洛抽样：逆变换法 L = L_BEL(U)，U ~ U(0,1) 由调用方的 rng() 提供（可传入带种子的发生器以复现）。
 * rng() 约定返回 [0, 1)；恰为 0 时重抽（P = 0 对应下确界 −3 dB，测度为零）。
 * 原文 §1 指出模型只在 P ∈ [0.01, 0.99] 内经实测验证——抽样必然覆盖两端，落在区间外的样本数写进 warnings。
 *
 * @param {object} q  { fGHz, buildingType, elevDeg = 0, rng = Math.random, n = 1 }
 * @returns {object} { samples: number[]（长度 n）, warnings }；入参无效时返回 { error }
 */
function belSample(q) {
  q = q || {};
  const pr = prepare(q);
  if (pr.error) return { error: pr.error };
  const rng = (q.rng === undefined || q.rng === null) ? Math.random : q.rng;
  if (typeof rng !== 'function') return { error: 'rng 须为返回 [0, 1) 的函数' };
  const n = numOr(q.n, 1);
  if (!(Number.isInteger(n) && n >= 1)) return { error: '样本数 n 须为正整数' };

  const samples = new Array(n);
  let outside = 0;
  for (let i = 0; i < n; i++) {
    let u = rng();
    for (let k = 0; u === 0 && k < 8; k++) u = rng();
    if (!(u > 0 && u < 1)) return { error: `rng() 返回 ${u}，不在 (0, 1) 内` };
    if (u < P_VALID_LO || u > P_VALID_HI) outside++;
    samples[i] = lossAt(pr.m, invNormal(u)).L;
  }
  const warnings = pr.warnings.slice();
  if (outside) warnings.push(`${outside}/${n} 个样本的 P 落在模型验证范围 0.01–0.99 之外`);
  return { samples, warnings };
}

module.exports = {
  BEL_COEFFS,
  buildingEntryLoss,
  belQuantiles,
  belCdf,
  belMedian,
  belSample,
};
