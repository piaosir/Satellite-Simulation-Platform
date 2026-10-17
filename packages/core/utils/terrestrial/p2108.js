// 地面业务干扰传播库 · ITU-R P.2108-1（09/2021）杂波损耗（Prediction of clutter loss）
//
// 建议书附件 1 第 3 节给了三个互不替代的模型，按终端环境与路径类型选用（表 1）：
//
//   §3.1 高度增益终端修正（0.03–3 GHz）       heightGainTerminalCorrection
//        天线低于「代表杂波高度 R」时的中值附加损耗 Ah。主路径的基本传输损耗按天线位于 R 处来算，
//        再在收、发两端各加一次 Ah。本库 P.452-18 模块把它当可选的两端终端修正调用；P.452-18 正文并未
//        引用 P.2108（它把代表杂波高度加进剖面，-17 版 §4.5 的高度增益式已删去），这一组合是工程取舍。
//   §3.2 地面路径统计杂波损耗（0.5–67 GHz）   terrestrialClutterLoss
//        城区/郊区终端在杂波内，位置百分比 p 下不超过的 Lctt；可加在路径一端或两端。
//   §3.3 地-空 / 航空统计杂波损耗（10–100 GHz）earthSpaceClutterLoss
//        一端在杂波内、另一端是卫星或航空器，位置百分比 p 下不超过的 Lces。
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据
//   公式逐条对照 ITU 官方 PDF（R-REC-P.2108-1-202109-I）第 4–7 页，未凭记忆。
//   数值与 ITU-R SG3 官方工作簿「Clutter and BEL workbook_V2.xlsx」逐点对拍（test/p2108.test.mjs，
//   基准抽成 test/fixtures/itu_clutter_bel_workbook_v2.json），三节全部基准点偏差 ≤ 2e-13 dB。
//
// 口径取舍
//   ① §3.2 式 (6) 封顶取 Lctt = min(Lctt(d), Lctt(d = 2 km))，f、p 相同。原文是「must not exceed」，
//      官方工作簿也用 MIN。高 p 时封顶在 2 km 以内就会生效：σcb 随 d 增大由 σs = 6 dB 向 σl = 4 dB 收缩，
//      近距离的展宽项反而更大（67 GHz、p = 99.9 % 时 d 约 0.34 km 起即取 2 km 值）；d > 2 km 时公式值也可能
//      略低于 2 km 值（同例 100 km 处 45.361 dB < 45.377 dB），此时按 min 取公式值，不另做「d > 2 km 一律
//      取 2 km」的替换——与工作簿逐点一致。
//   ② 适用范围之外（频率、§3.2 最短路径、§3.3 仰角）照算，并在 warnings 里写明越界事实；只有算不出
//      或无意义的输入（NaN、p ∉ (0,100)、h ≤ 0、未知杂波类型等）才返回 { error }。
//   ③ §3.2 最短路径：只修正一端 0.25 km，两端都修正 1 km。函数本身不知道调用方修几端，由可选参数
//      bothEnds 告知（缺省按一端）。
//   ④ §3.2 频率范围按 P.2108-1 取 0.5–67 GHz。官方工作簿首页仍写「2 - 67 GHz」（P.2108-0 的旧范围），
//      其频率表另有一行 120 GHz——那是工作簿的取样点，不代表适用范围扩大，本模块对它照算并告警。
//   ⑤ §3.3 仰角 < 0° 按 0° 计算并告警：式 (7) 余切的宗量 A1(1 − θ/90) + πθ/180 在 θ ≈ −2.96° 过零，
//      再往下底数变负、无实数解，没有可外推的公式值。θ > 90° 不是仰角，报错。
//   ⑥ Q⁻¹ 取 common.js 的 qInv（AS241，机器精度）。工作簿用 Excel NORM.INV，同为高精度。
//
// 纯函数、仅依赖 ./common.js，CommonJS。

const { knifeEdgeJ, qInv } = require('./common.js');

const LOG10 = Math.log10;
const DEG = 180 / Math.PI;

// 入参转数：undefined / null / '' 视为缺省（num 记 NaN 交给校验，numOr 取默认值），其余按 Number 转。
function num(v) {
  return (v === undefined || v === null || v === '') ? NaN : Number(v);
}
function numOr(v, d) {
  return (v === undefined || v === null || v === '') ? d : Number(v);
}
// 告警里的数值：6 位有效数字、去掉尾零，避免把 0.30000000000000004 原样印出来。
function fmt(x) {
  return String(Number(Number(x).toPrecision(6)));
}
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// §3.1 高度增益终端修正
// ---------------------------------------------------------------------------

/**
 * 表 3：缺少本地资料时的代表杂波高度 R 与 Ah 算法。
 * 2a（式 (2a)，杂波顶绕射）用于建筑/树木类；2b（式 (2b)，近地高度增益）用于开阔类。
 * 别与 P.452-18 表 3 混用：那里的 0/0/10/15/20 m 是「加到剖面上的高度」，水域、开阔两类为 0；
 * 这里是 §3.1 的 R，五类依次 10/10/10/15/20 m。
 */
const CLUTTER_TYPES = Object.freeze({
  water_sea:          Object.freeze({ R: 10, method: '2b', name: 'Water/sea',          label: '水域/海面' }),
  open_rural:         Object.freeze({ R: 10, method: '2b', name: 'Open/rural',         label: '开阔/乡村' }),
  suburban:           Object.freeze({ R: 10, method: '2a', name: 'Suburban',           label: '郊区' }),
  urban_trees_forest: Object.freeze({ R: 15, method: '2a', name: 'Urban/trees/forest', label: '城区/树木/森林' }),
  dense_urban:        Object.freeze({ R: 20, method: '2a', name: 'Dense urban',        label: '密集城区' }),
});

/**
 * §3.1 高度增益终端修正 Ah（dB，中值）。收、发两端模型相同，各调用一次。
 *
 * @param {object} q
 *   fGHz         频率（GHz），适用 0.03–3
 *   h            天线离地高度（m），> 0
 *   R            代表杂波高度（m），≥ 0；缺省取表 3 中该杂波类型的默认值（R = 0 即无杂波，按 h ≥ R 得 Ah = 0）
 *   ws           街道宽度（m），缺省 27（表 2）
 *   clutterType  'water_sea' | 'open_rural' | 'suburban' | 'urban_trees_forest' | 'dense_urban'
 * @returns {object}
 *   { Ah, method: '2a'|'2b', belowClutter, nu, Kh2, Knu, hdif, thetaClutDeg, R, warnings }
 *   method 是该杂波类型按表 3 应用的式子；h ≥ R 时 belowClutter = false、Ah = 0，ν 与 θclut 无定义记 null。
 *   入参无效时返回 { error }。
 */
function heightGainTerminalCorrection(q) {
  q = q || {};
  const f = num(q.fGHz), h = num(q.h), ws = numOr(q.ws, 27);
  if (!(f > 0)) return { error: '频率须为正数（GHz）' };
  if (!(h > 0)) return { error: '天线高度 h 须为正数（m）' };
  if (!(ws > 0)) return { error: '街道宽度 ws 须为正数（m）' };
  if (!has(CLUTTER_TYPES, q.clutterType)) {
    return { error: `未知杂波类型「${q.clutterType}」，可选：${Object.keys(CLUTTER_TYPES).join(' / ')}` };
  }
  const ct = CLUTTER_TYPES[q.clutterType];
  const R = numOr(q.R, ct.R);                      // 表 2：R 缺省见表 3
  if (!(R >= 0)) return { error: '代表杂波高度 R 不能为负（m）' };

  const warnings = [];
  if (f < 0.03 || f > 3) warnings.push(`频率 ${fmt(f)} GHz 超出 §3.1 适用范围 0.03–3 GHz`);

  const Knu = 0.342 * Math.sqrt(f);                // P.2108-1 §3.1.2 式 (2g)
  const Kh2 = 21.8 + 6.2 * LOG10(f);               // 式 (2f)
  const hdif = R - h;                              // 式 (2d)

  // 「If h ≥ R then Ah = 0」
  if (!(h < R)) {
    return { Ah: 0, method: ct.method, belowClutter: false, nu: null, Kh2, Knu, hdif, thetaClutDeg: null, R, warnings };
  }

  const thetaClutDeg = Math.atan(hdif / ws) * DEG; // 式 (2e)，单位为度
  const nu = Knu * Math.sqrt(hdif * thetaClutDeg); // 式 (2c)：θclut 以「度」代入（原文如此，官方工作簿同）
  // h < R 时 hdif > 0、θclut > 0，ν 恒为正，knifeEdgeJ 的 ν ≤ −0.78 置零分支到不了。
  // 注：J(0) = 6.0329 dB，故 h 由下方逼近 R 时 2a 式给出约 +0.003 dB 而非 0——常数 6.03 是原文取的整。
  const Ah = ct.method === '2a'
    ? knifeEdgeJ(nu) - 6.03                        // 式 (2a)，J(ν) 为式 (1)
    : -Kh2 * LOG10(h / R);                         // 式 (2b)
  return { Ah, method: ct.method, belowClutter: true, nu, Kh2, Knu, hdif, thetaClutDeg, R, warnings };
}

// ---------------------------------------------------------------------------
// §3.2 地面路径统计杂波损耗
// ---------------------------------------------------------------------------

const SIGMA_L = 4;   // 式 (4b)，dB
const SIGMA_S = 6;   // 式 (5b)，dB
const D_CAP_KM = 2;  // 式 (6)：以 d = 2 km 处的值为上限

/**
 * §3.2 地面—地面路径的统计杂波损耗 Lctt（dB）：p % 的位置上不超过的值。
 * 可加在传输损耗或基本传输损耗上；若主路径模型本身已计全程杂波（如 P.1411），不应再叠加。
 *
 * @param {object} q
 *   fGHz      频率（GHz），适用 0.5–67
 *   dKm       路径总长（km）；最短 0.25（单端修正）/ 1（两端修正）
 *   pLoc      位置百分比（%），0 < p < 100
 *   bothEnds  可选，true 表示两端都加本修正（只影响最短路径告警），缺省 false
 * @returns {object}
 *   { Lctt, Ll, Ls, sigmaCb, LcttMax, capped, LcttUncapped, warnings }
 *   Ls、sigmaCb、LcttUncapped 为距离 d 处的值；LcttMax = 2 km 处的 Lctt（式 (6)）；
 *   capped 表示 d 处的式 (3a) 值超过上限、已取 LcttMax。入参无效时返回 { error }。
 */
function terrestrialClutterLoss(q) {
  q = q || {};
  const f = num(q.fGHz), d = num(q.dKm), p = num(q.pLoc);
  if (!(f > 0)) return { error: '频率须为正数（GHz）' };
  if (!(d > 0)) return { error: '路径长度须为正数（km）' };
  if (!(p > 0 && p < 100)) return { error: '位置百分比 p 须在 (0, 100) 内' };
  const bothEnds = !!q.bothEnds;

  const warnings = [];
  if (f < 0.5 || f > 67) warnings.push(`频率 ${fmt(f)} GHz 超出 §3.2 适用范围 0.5–67 GHz`);
  const dMin = bothEnds ? 1 : 0.25;
  if (d < dMin) warnings.push(`路径长度 ${fmt(d)} km 短于 §3.2 ${bothEnds ? '两端' : '单端'}修正的最短路径 ${dMin} km`);

  const lf = LOG10(f);
  const Ll = -2 * LOG10(Math.pow(10, -5 * lf - 12.5) + Math.pow(10, -16.5));   // 式 (4a)
  const wl = Math.pow(10, -0.2 * Ll);
  const qi = qInv(p / 100);                        // Q⁻¹(p/100)，逆互补正态

  const at = (dk) => {
    const Ls = 32.98 + 23.9 * LOG10(dk) + 3 * lf;                                 // 式 (5a)
    const ws = Math.pow(10, -0.2 * Ls);
    const sigmaCb = Math.sqrt((SIGMA_L * SIGMA_L * wl + SIGMA_S * SIGMA_S * ws) / (wl + ws));   // 式 (3b)
    const L = -5 * LOG10(wl + ws) - sigmaCb * qi;                                 // 式 (3a)
    return { Ls, sigmaCb, L };
  };

  const cur = at(d);
  const LcttMax = at(D_CAP_KM).L;                  // 式 (6)：同 f、p 下 d = 2 km 的 Lctt
  const capped = cur.L > LcttMax;
  return {
    Lctt: capped ? LcttMax : cur.L,
    Ll, Ls: cur.Ls, sigmaCb: cur.sigmaCb,
    LcttMax, capped, LcttUncapped: cur.L,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// §3.3 地-空 / 航空统计杂波损耗
// ---------------------------------------------------------------------------

const A1 = 0.05;     // 式 (7) 附式

/**
 * §3.3 地-空（或航空）路径的统计杂波损耗 Lces（dB）：p % 的位置上不超过的值。
 * 适用城区、郊区环境，一端在杂波内、另一端为卫星/航空器等地面以上平台。
 *
 * @param {object} q
 *   fGHz     频率（GHz），适用 10–100
 *   elevDeg  从终端看平台的仰角（度），适用 0–90；负仰角按 0° 计算并告警
 *   pLoc     位置百分比（%），0 < p < 100
 * @returns {object} { Lces, K1, A1, warnings }；入参无效时返回 { error }
 */
function earthSpaceClutterLoss(q) {
  q = q || {};
  const f = num(q.fGHz), th0 = num(q.elevDeg), p = num(q.pLoc);
  if (!(f > 0)) return { error: '频率须为正数（GHz）' };
  if (!(th0 >= -90 && th0 <= 90)) return { error: '仰角须在 −90°–90° 之间' };
  if (!(p > 0 && p < 100)) return { error: '位置百分比 p 须在 (0, 100) 内' };

  const warnings = [];
  if (f < 10 || f > 100) warnings.push(`频率 ${fmt(f)} GHz 超出 §3.3 适用范围 10–100 GHz`);
  let th = th0;
  if (th < 0) {
    th = 0;
    warnings.push(`仰角 ${fmt(th0)}° 低于 §3.3 适用范围 0–90°，按 0° 计算`);
  }

  const K1 = 93 * Math.pow(f, 0.175);              // 式 (7) 附式 K1 = 93·f^0.175
  // 式 (7)：{−K1·ln(1 − p/100)·cot[A1(1 − θ/90) + πθ/180]}^[0.5(90 − θ)/90] − 1 − 0.6·Q⁻¹(p/100)
  // 余切宗量为弧度；θ ∈ [0°, 90°] 时落在 [0.05, π/2]，底数为正。θ = 90° 时指数为 0、首项恒为 1，
  // Lces 退化为 −0.6·Q⁻¹(p/100)。ln(1 − p/100) 用 log1p 求，小 p 时不丢精度。
  const arg = A1 * (1 - th / 90) + Math.PI * th / 180;
  const base = -K1 * Math.log1p(-p / 100) / Math.tan(arg);
  const Lces = Math.pow(base, 0.5 * (90 - th) / 90) - 1 - 0.6 * qInv(p / 100);
  return { Lces, K1, A1, warnings };
}

module.exports = {
  CLUTTER_TYPES,
  heightGainTerminalCorrection,
  terrestrialClutterLoss,
  earthSpaceClutterLoss,
};
