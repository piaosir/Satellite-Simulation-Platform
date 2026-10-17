// RR 附录 7（Rev.WRC-23）· 地球站协调区计算（100 MHz – 105 GHz）
//
// 用途：地球站与地面业务（固定 / IMT 等）共用频段时的协调区。典型场景是 C 频段 FSS：
// 3.4–4.2 GHz 接收地球站、5.925–6.425 GHz 发射地球站。本模块只做计算，不碰界面。
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据（以 RR 2024 原文为准，未凭记忆）
//   ITU《无线电规则》2024 年版 第 2 卷（附录），附录 7（Rev.WRC-23），PDF 第 181–270 页（AP7-1 … AP7-90）。
//   官方合订本 https://www.itu.int/dms_pub/itu-r/opb/reg/R-REG-RR-2024-ZPF-E.zip
//     zip SHA-256      ae59067722362d7059d16561abcaa646dca501d642e414faa1f5f6411cb99d8e
//     卷 2 PDF SHA-256 49e283a5c22e57b44b5e0220eee94df4a7d2055418662bf83c125475d98f3abf
//   每一个式子都对照 300 dpi 页面图像核过（文本抽取里的公式大多残缺，不能直接用）。
//   辅助参考（只用来理解意图，不覆盖 AP7）：ITU-R P.620-7（2017），与 AP7 的差异见下文。
//
// 覆盖范围（式号即 AP7 原文式号）
//   正文 §1.3 式 (1)–(3)、§2.1 式 (4)、§2.2 式 (5)（在 ap7Antenna.js）、§3.1.1 式 (6)
//   正文 §4.1 式 (7)–(11) 无线电气候参数；§4.2 式 (12)–(18) dmin；§4.3 表 3 + 式 (19) dmax1；
//        §4.4 式 (20)–(22) 固定业务修正与辅助等值线
//   附件 1 §1 式 (23)–(25) 场地屏蔽；§2 式 (26)–(31)（100–790 MHz）；§3 式 (32)–(54)（790 MHz–60 GHz）；
//          §4 式 (54a)–(61)（60–105 GHz）
//   附件 2 式 (62)–(83) 雨散射（模式 (2)）与圆心偏移等值线
//   附件 3 / 附件 4 / 附件 5 §2.1 / 附件 6 §3.2.3：地平线增益与方向图（ap7Antenna.js）
//   附件 5 §3 式 (104)(105) 双向频段雨散射区几何作图
//   附件 6 §3.1 模式 (1) 辅助等值线、§3.2 式 (106)–(110) 模式 (2) 辅助等值线、§4 式 (123)–(126) TVG 补充等值线
//   附件 7 §2 式 (127)(128)、表 6；表 7a–7c、8a–8d、9a–9b、10（ap7Tables.js）
//
// 判断与取舍（原文含糊或有误之处；每处在代码里再注一次）
//   1. 模型频段边界：f ≤ 0.79 GHz 用附件 1 §2，0.79 < f ≤ 60 GHz 用 §3，f > 60 GHz 用 §4
//      （与式 (20) 的分段、§4.3「≤ 60 GHz 用表 3 / > 60 GHz 用式 (19)」一致）。
//   2. 式 (49b) 原文印作「ζr ≤ 70°」，与 (49a) 条件相同——按 (7)(8) 的分界与 P.620-7 理解为 ζr > 70°。
//   3. 附件 1 §3 正文说「迭代式 (43)–(53)」，但停止条件 (32a) 需要式 (54) 的 L6——按 (43)–(54) 迭代。
//   4. 「375 km 以外取 375 km 处的修正值」：Ci = Z·(min(d,375) − dmin)；C2i 按字面取 375 km 处的值，
//      即 Z·(375 − dmin)·τ(375 km)，τ 用 0–375 km 路径段的 dlm。
//   5. 式 (37) 的 dc：「陆上地球站到该方向海岸的距离，其他情形为零」。由区划剖面推出：站在陆上且
//      剖面上有海 → 到第一段海的距离；站在海上（首段为 B/C）→ 0；全程无海 → 不存在「海岸」，
//      取 Ac = 0（按字面「其他情形 dc = 0」会对纯内陆路径给 Ac = −6 dB 的最大入海波导耦合，物理上不通）。
//      调用方可用 dcKm 显式覆盖（传 0 即得字面解读）。
//   6. 附件 1 §2 纯陆路径也要算 Lbs：原文只规定「冷暖海并存按暖海」，未规定无海时取哪种海。按地球站
//      纬度取（|ζ| ≥ 30° → B，否则 C；地中海、黑海属 C 时可用 seaZoneIfNoSea 覆盖）。纯陆路径上 Lbs 的
//      权重只有 exp(−5.5) ≈ 0.4%。
//   7. 时间百分比越出模型范围（§2：1–50%；§3/§4：0.001–50%；附件 2：0.001–10%）时截到端点并给警告。
//      §2 的 (log p)^1.38 在 p < 1% 时无实数解，无法外推。
//   8. 混合路径的 dmax1（§4.3）：任一区划累计距离达到表 3 值即停；总距离不超过「已出现区划中表 3 的
//      最大值」。迭代步长与 dmax1 不对齐时，结果截到 dmax1（§1.5.3「必须位于 dmin 与最大计算距离之间」）。
//   9. 附件 2 式 (74)「北美与 60°E 以西的欧洲」只定义了 35° ≤ ζ ≤ 70°；该地区在此纬度范围外改用式 (75)
//      并给警告。式 (75a) 在 ζ > 89.67° 时为负，下限截到 0。区域由调用方用 rainHeightRegion 指明。
//  10. 式 (79a) 写「10 GHz < f < 40.5 GHz」，(79b) 写「f < 10 GHz 或 Lar ≠ 0」，f = 40.5 GHz 两式都不覆盖；
//      按 (79a) 处理（连续）。
//  11. 附件 2 降雨率：原文按雨气候区 A–Q（图 2–4 地图）给 R(p)。地图未数字化，由调用方给雨区字母；
//      也可直接给 rainRateMmH（偏离 AP7，供与 P.837 对比）。表 4 的 pc 以上 R = 0。
//  12. 附件 2 §4 模式 (2) 等值线按平面几何画圆（原文「在地图上以 Δd 处为圆心、dr 为半径画圆」）；
//      与球面几何相差 < 0.01 km（dr ≤ 370 km）。频率不在 1–40.5 GHz 或 R(p) = 0 时雨散射可忽略，
//      模式 (2) 等值线取以地球站为圆心、半径 dmin 的圆（不做圆心偏移）。
//  13. 倾斜轨道（正文 §2.1.2）：两个「最极端星位」取星下点纬度 ±is、经差 δ0；雨散射区为两圆之并。
//  14. 表 6 的分档 f < 10、10 < f < 17、f > 17 在 10 与 17 GHz 处未定义；端点取较低的 Te（较保守）。
//  15. 附件 5 §3 双向雨散射区：两段 6° 宽弧各自与 dmin 圆取凸包（弧端向圆的北 / 南缘作切线即凸包的
//      支撑线），雨散射区 = 两个凸包之并；原文「切点之间的圆弧」与两切线交叉时的情形都由此自动给出。
//
// 与 P.620-7 的差异（按 AP7）：P.620-7 的模式 (2) 已换成双基雷达新模型、dmin = 55 km 且自 dmax2 递减迭代、
//   dmax1 = 1 200 km、§3 气体衰减取 P.836 实测水汽；AP7 2024 仍沿用旧模型与正文 §4.3 的表 3。
//
// 已知的原文性质（不是实现错误，测试里有专门用例）：
//   · 附件 2 式 (79)：Lar 由 0 变正的那一步 Ab 归零，f > 10 GHz 时 Lr(ri) 在该处下跌数 dB（非单调）；
//     按原文第一次满足 (62a) 即停止。
//   · 附件 1 §2 混合路径：海段上 dtm/di 变小使式 (31) 的陆地权重下降，L2 可能随距离回落；同样按
//     第一次满足 (26a) 停止。单一区划路径的预测损耗是单调的。
//
// 纯函数、无依赖（仅本目录 ap7Tables.js / ap7Antenna.js），CommonJS。

'use strict';

const T = require('./ap7Tables.js');
const ANT = require('./ap7Antenna.js');

const LOG10 = Math.log10;
const D2R = Math.PI / 180;

/** 附件 7 §2 式 (127)：玻尔兹曼常数，原文取 1.38 × 10⁻²³ J/K。 */
const K_BOLTZMANN_AP7 = 1.38e-23;
/** 附件 1 / 正文 §4.4：修正值满额所对应的名义距离（km）。 */
const CORRECTION_FULL_KM = 375;
/** contourToLatLon 用的球面平均地球半径（km）——AP7 不涉及，仅用于把等值线点落到地图上。 */
const MEAN_EARTH_RADIUS_KM = 6371.0;

const ZONES = ['A1', 'A2', 'B', 'C'];
const RAIN_ZONES = 'ABCDEFGHJKLMNPQ';

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function fmt(v, n) { return Number(v).toFixed(n === undefined ? 3 : n).replace(/\.?0+$/, ''); }

// ===========================================================================
// 正文 §4.1–§4.4：无线电气候参数、距离限值、固定业务修正
// ===========================================================================

/**
 * 无线电气候参数。RR AP7 正文 §4.1 式 (7)–(11)。
 * @param {number} latDeg 地球站纬度 ζ（°，北正）
 * @returns {{zetaR:number, betaE:number, N0:number}} ζr（°）、βe（%）、路径中心海平面折射率 N0（N 单位）
 */
function radioClimate(latDeg) {
  const z = Number(latDeg);
  // RR AP7 §4.1 式 (9)(10)：ζr = |ζ| − 1.8（|ζ| > 1.8°）；0（|ζ| ≤ 1.8°）
  const zetaR = Math.abs(z) > 1.8 ? Math.abs(z) - 1.8 : 0;
  // RR AP7 §4.1 式 (7)(8)：βe = 10^(1.67 − 0.015 ζr)（ζr ≤ 70°）；4.17（ζr > 70°）
  const betaE = zetaR <= 70 ? Math.pow(10, 1.67 - 0.015 * zetaR) : 4.17;
  // RR AP7 §4.1 式 (11)：N0 = 330 + 62.6 exp{−[(ζ − 2)/32.7]²}
  const N0 = 330 + 62.6 * Math.exp(-Math.pow((z - 2) / 32.7, 2));
  return { zetaR, betaE, N0 };
}

/**
 * 最小协调距离 dmin（km），模式 (1)(2) 共用。RR AP7 正文 §4.2 式 (12)–(18)。
 * @returns {{dminKm:number, dxKm:number, betaE:number}}
 */
function minCoordinationDistance(fGHz, latDeg) {
  const f = Number(fGHz);
  const { betaE } = radioClimate(latDeg);
  // RR AP7 §4.2 式 (12)：dx = 100 + (βe − 40)/2
  const dx = 100 + (betaE - 40) / 2;
  let d;
  if (f < 40) d = 100 + (betaE - f) / 2;                          // 式 (13)
  else if (f < 54) d = ((54 - f) * dx + 10 * (f - 40)) / 14;       // 式 (14)
  else if (f < 66) d = 10;                                         // 式 (15)
  else if (f < 75) d = (10 * (75 - f) + 45 * (f - 66)) / 9;        // 式 (16)
  else if (f < 90) d = 45;                                         // 式 (17)
  else d = 45 - (f - 90) / 1.5;                                    // 式 (18)
  return { dminKm: d, dxKm: dx, betaE };
}

/**
 * 名义修正值 X(f)（dB）。RR AP7 正文 §4.4 式 (20)。
 * @param {'tx'|'rx'} esRole 发射地球站 X = 15 dB；接收地球站 X = 25 dB
 */
function nominalCorrection(fGHz, esRole) {
  const X = esRole === 'tx' ? 15 : (esRole === 'rx' ? 25 : NaN);
  const f = Number(fGHz);
  if (f <= 0.4) return 0;                                          // 式 (20) 第 1 段
  if (f <= 0.79) return 3.3833 * X * (LOG10(f) + 0.3979);          // 第 2 段
  if (f <= 4.2) return X;                                          // 第 3 段
  if (f <= 60) return -0.8659 * X * (LOG10(f) - 1.7781);           // 第 4 段
  return 0;                                                        // 第 5 段
}

/** 修正常数 Z(f)（dB/km）。RR AP7 正文 §4.4 式 (21)：Z = X(f) / (375 − dmin)。 */
function correctionConstant(fGHz, dminKm, esRole) {
  return nominalCorrection(fGHz, esRole) / (CORRECTION_FULL_KM - dminKm);
}

// ---------------------------------------------------------------------------
// 区划剖面（A1/A2/B/C）
// ---------------------------------------------------------------------------

/**
 * 规整区划剖面：'A2' 或 [{zone, lengthKm}]（自地球站向外，最后一段可省略长度表示一直延伸）。
 * @returns {{segments:Array<{zone,startKm,endKm}>, suppliedKm:number, extended:boolean} | {error:string}}
 */
function normalizeZones(zones) {
  if (typeof zones === 'string') {
    const z = zones.toUpperCase();
    if (!ZONES.includes(z)) return { error: `无效区划「${zones}」，应为 A1/A2/B/C` };
    return { segments: [{ zone: z, startKm: 0, endKm: Infinity }], suppliedKm: Infinity, extended: false };
  }
  if (!Array.isArray(zones) || !zones.length) return { error: '缺区划剖面（zones）' };
  const segs = [];
  let s = 0;
  for (let k = 0; k < zones.length; k++) {
    const it = zones[k] || {};
    const z = String(it.zone || '').toUpperCase();
    if (!ZONES.includes(z)) return { error: `第 ${k + 1} 段区划「${it.zone}」无效，应为 A1/A2/B/C` };
    const last = k === zones.length - 1;
    let len = it.lengthKm;
    if (len === undefined || len === null) {
      if (!last) return { error: `第 ${k + 1} 段缺长度` };
      len = Infinity;
    }
    len = Number(len);
    if (!(len > 0)) return { error: `第 ${k + 1} 段长度应为正数` };
    segs.push({ zone: z, startKm: s, endKm: s + len });
    s += len;
  }
  const suppliedKm = s;
  let extended = false;
  if (Number.isFinite(s)) { segs[segs.length - 1].endKm = Infinity; extended = true; }   // 末段按原区划延伸
  return { segments: segs, suppliedKm, extended };
}

/**
 * 路径 [0, d] 上的区划统计（附件 1 §2/§3 的 dt、dlm、dtm 及各区划累计距离）。
 * @returns {{dt:number, dlm:number, dtm:number, agg:{A1,A2,B,C}, hasB:boolean, hasC:boolean}}
 */
function pathStats(segs, d) {
  const agg = { A1: 0, A2: 0, B: 0, C: 0 };
  let land = 0, inland = 0, dtm = 0, dlm = 0;
  for (const sg of segs) {
    if (sg.startKm >= d) break;
    const len = Math.min(sg.endKm, d) - sg.startKm;
    if (!(len > 0)) continue;
    agg[sg.zone] += len;
    if (sg.zone === 'A1' || sg.zone === 'A2') { land += len; if (land > dtm) dtm = land; } else land = 0;
    if (sg.zone === 'A2') { inland += len; if (inland > dlm) dlm = inland; } else inland = 0;
  }
  return { dt: agg.A1 + agg.A2, dlm, dtm, agg, hasB: agg.B > 0, hasC: agg.C > 0 };
}

/**
 * 模式 (1) 最大计算距离 dmax1。RR AP7 正文 §4.3（表 3）与式 (19)。
 * @param {object} o { fGHz, p, zones|segments }
 * @returns {{dmax1Km:number, limitedBy:string}} limitedBy：'eq19' | 某区划代码（该区划累计达到表 3）| 'overall'
 */
function mode1MaxDistance(o) {
  const f = Number(o.fGHz);
  if (f > 60) {
    // RR AP7 §4.3 式 (19)：dmax1 = 80 − 10 lg(p/50)（f > 60 GHz）
    return { dmax1Km: 80 - 10 * LOG10(o.p / 50), limitedBy: 'eq19' };
  }
  let segs = o.segments;
  if (!segs) {
    const nz = normalizeZones(o.zones);
    if (nz.error) return { error: nz.error };
    segs = nz.segments;
  }
  // RR AP7 §4.3：各区划累计距离不得超过表 3；总距离不得超过路径上已出现区划中表 3 的最大值
  let best = Infinity, by = null;
  const acc = { A1: 0, A2: 0, B: 0, C: 0 };
  let lim = 0;
  for (const sg of segs) {
    const z = sg.zone, cap = T.TABLE_3[z];
    lim = Math.max(lim, cap);
    // 该区划累计在本段内达到上限
    const need = cap - acc[z];
    const reach = sg.startKm + need;
    if (reach <= sg.endKm && reach < best) { best = reach; by = z; }
    // 总距离在本段内达到「已出现区划」上限
    if (lim >= sg.startKm && lim <= sg.endKm && lim < best) { best = lim; by = 'overall'; }
    acc[z] += sg.endKm - sg.startKm;
    if (sg.endKm >= best) break;
  }
  return { dmax1Km: best, limitedBy: by };
}

// ===========================================================================
// 附件 1 §1：场地屏蔽
// ===========================================================================

/**
 * 地平线引起的场地屏蔽衰减 Ah（dB）。RR AP7 附件 1 §1 式 (23)–(25)。
 * @param {object} o { fGHz, horizonElevDeg = 0, horizonDistKm（缺省按 0.5 km）}
 * @returns {{AhDb:number, AhRawDb:number, AdDb:number, dhKm:number, clamped:boolean}}
 */
function siteShielding(o) {
  const f = Number(o.fGHz);
  const eh = isNum(o.horizonElevDeg) ? o.horizonElevDeg : 0;
  // RR AP7 附件 1 §1：dh = 0.5 km（无信息或 < 0.5 km）；地平线距离（0.5–5 km）；5 km（> 5 km）
  const hd = o.horizonDistKm;
  const dh = !isNum(hd) || hd < 0.5 ? 0.5 : (hd > 5 ? 5 : hd);
  // RR AP7 附件 1 §1 式 (23)：Ad = 15 [1 − exp((0.5 − dh)/5)] [1 − exp(−εh f^⅓)]
  const Ad = 15 * (1 - Math.exp((0.5 - dh) / 5)) * (1 - Math.exp(-eh * Math.cbrt(f)));
  let Ah;
  if (eh >= 0) {
    // 式 (24a)：20 lg(1 + 4.5 εh f^½) + εh f^⅓ + Ad，εh ≥ 0°
    Ah = 20 * LOG10(1 + 4.5 * eh * Math.sqrt(f)) + eh * Math.cbrt(f) + Ad;
  } else if (eh >= -0.5) {
    // 式 (24b)：3 [(f + 1)^½ − 0.0001 f − 1.0487] εh，0° > εh ≥ −0.5°
    Ah = 3 * (Math.sqrt(f + 1) - 0.0001 * f - 1.0487) * eh;
  } else {
    // 式 (24c)：−1.5 [(f + 1)^½ − 0.0001 f − 1.0487]，εh < −0.5°
    Ah = -1.5 * (Math.sqrt(f + 1) - 0.0001 * f - 1.0487);
  }
  // RR AP7 附件 1 §1 式 (25)：−10 ≤ Ah ≤ 30 + εh
  const AhRaw = Ah;
  Ah = Math.min(30 + eh, Math.max(-10, Ah));
  return { AhDb: Ah, AhRawDb: AhRaw, AdDb: Ad, dhKm: dh, clamped: Ah !== AhRaw };
}

// ===========================================================================
// 气体比衰减（附件 1 §3、§4 的保守近似式）
// ===========================================================================

/** 干空气比衰减 γo（dB/km）。RR AP7 附件 1 §3 式 (33)。附件 2 式 (82) 亦引用。 */
function gammaOxygen(fGHz) {
  const f = Number(fGHz);
  // 式 (33a)：[7.19×10⁻³ + 6.09/(f² + 0.227) + 4.81/((f − 57)² + 1.50)] f² × 10⁻³，f ≤ 56.77 GHz
  if (f <= 56.77) return (7.19e-3 + 6.09 / (f * f + 0.227) + 4.81 / (Math.pow(f - 57, 2) + 1.50)) * f * f * 1e-3;
  return 10;                                                       // 式 (33b)：f > 56.77 GHz
}

/** 水汽比衰减 γw(ρ)（dB/km）。RR AP7 附件 1 §3 式 (34)。 */
function gammaWater(fGHz, rho) {
  const f = Number(fGHz);
  // 式 (34)：[0.050 + 0.0021 ρ + 3.6/((f − 22.2)² + 8.5)] f² ρ × 10⁻⁴
  return (0.050 + 0.0021 * rho + 3.6 / (Math.pow(f - 22.2, 2) + 8.5)) * f * f * rho * 1e-4;
}

/** 60–105 GHz 干空气比衰减 γom（dB/km）。RR AP7 附件 1 §4 式 (55)。 */
function gammaOxygenMm(fGHz) {
  const f = Number(fGHz);
  if (f <= 63.26) return 10;                                       // 式 (55b)
  // 式 (55a)：[2×10⁻⁴(1 − 1.2×10⁻⁵ f^1.5) + 4/((f − 63)² + 0.936) + 0.28/((f − 118.75)² + 1.771)] f² 6.24×10⁻⁴
  return (2e-4 * (1 - 1.2e-5 * Math.pow(f, 1.5)) + 4 / (Math.pow(f - 63, 2) + 0.936)
    + 0.28 / (Math.pow(f - 118.75, 2) + 1.771)) * f * f * 6.24e-4;
}

/** 60–105 GHz、水汽密度 3 g/m³ 的比衰减 γwm（dB/km）。RR AP7 附件 1 §4 式 (56)。 */
function gammaWaterMm(fGHz) {
  const f = Number(fGHz);
  // 式 (56)：(0.039 + 7.7×10⁻⁴ f^0.5) f² 2.369×10⁻⁴
  return (0.039 + 7.7e-4 * Math.sqrt(f)) * f * f * 2.369e-4;
}

// ===========================================================================
// 附件 1：模式 (1) 所需距离
// ===========================================================================

/** 频率对应的附件 1 小节（判断 1）。 */
function mode1Model(fGHz) {
  const f = Number(fGHz);
  if (f <= 0.79) return 'annex1-s2';
  if (f <= 60) return 'annex1-s3';
  return 'annex1-s4';
}

/**
 * 模式 (1) 预计算：验证输入、算与距离无关的量，返回带 lossAt(d, withCorrection) 的 setup。
 * 参数含义见 mode1RequiredDistance。逐距离扫描（画损耗曲线、单调性检查）时直接用 setup.lossAt，
 * 免得每个距离点都重做一遍验证与常数计算。
 * @returns {object} setup：{ fGHz, p, model, dminKm, dmax1Km, AhDb, correction, terms, lossAt(dKm, withCorrection) → {lossDb, terms} }
 */
function mode1Setup(o) {
  if (!o) return { error: '缺参数' };
  const f = Number(o.fGHz);
  if (!isNum(f) || !(f > 0)) return { error: '频率无效' };
  if (f < 0.1 || f > 105) return { error: `频率 ${f} GHz 不在附录 7 适用范围 0.1–105 GHz` };
  const pIn = Number(o.p);
  if (!(pIn > 0)) return { error: '时间百分比 p 无效' };
  const Lb = Number(o.Lb);
  if (!isNum(Lb)) return { error: '缺所需最小损耗 Lb' };
  if (!isNum(o.latDeg) || Math.abs(o.latDeg) > 90) return { error: '缺地球站纬度' };
  const step = o.stepKm === undefined ? 1 : Number(o.stepKm);
  if (!(step > 0)) return { error: '迭代步长应为正数' };
  const model = mode1Model(f);
  const warnings = [];

  // 时间百分比的模型范围（判断 7）
  const pLo = model === 'annex1-s2' ? 1 : 0.001;
  let p = pIn;
  if (p < pLo || p > 50) {
    p = Math.min(50, Math.max(pLo, p));
    warnings.push(`p = ${fmt(pIn, 4)}% 超出附件 1 ${model === 'annex1-s2' ? '§2（1%–50%）' : (model === 'annex1-s3' ? '§3（0.001%–50%）' : '§4（0.001%–50%）')} 适用范围，按 ${fmt(p, 4)}% 计算`);
  }

  // 区划剖面（§4 不需要）
  let segs = null, zoneInfo = null;
  if (model !== 'annex1-s4' || o.zones !== undefined) {
    zoneInfo = normalizeZones(o.zones);
    if (zoneInfo.error) return { error: zoneInfo.error };
    segs = zoneInfo.segments;
  }

  const rc = radioClimate(o.latDeg);
  const { dminKm } = minCoordinationDistance(f, o.latDeg);
  const dmaxInfo = model === 'annex1-s4' ? mode1MaxDistance({ fGHz: f, p }) : mode1MaxDistance({ fGHz: f, p, segments: segs });
  if (zoneInfo && zoneInfo.extended && zoneInfo.suppliedKm < dmaxInfo.dmax1Km) {
    warnings.push(`区划剖面只给到 ${fmt(zoneInfo.suppliedKm, 1)} km，其外按最后一段区划延伸`);
  }

  // 场地屏蔽：§1.4.5 / §1.4.6 规定不计地平线保护时 εh 与 Ah 一律按 0
  const shield = o.siteShielding !== false;
  const hz = o.horizon || {};
  const eh = shield && isNum(hz.elevDeg) ? hz.elevDeg : 0;
  const site = siteShielding({ fGHz: f, horizonElevDeg: eh, horizonDistKm: hz.distKm });
  const Ah = shield ? site.AhDb : 0;

  // 固定业务修正（§4.4）：只对与固定业务的协调；移动业务、双向频段、辅助等值线不用
  const corrWanted = o.correction !== false;
  let X = 0, Z = 0;
  // 式 (20) 在 f ≤ 400 MHz 与 f > 60 GHz 两段恒为 0，这两段不需要 esRole
  if (corrWanted && f > 0.4 && f <= 60) {
    if (o.esRole !== 'tx' && o.esRole !== 'rx') return { error: "应用固定业务修正时须给 esRole：'tx' 或 'rx'" };
    // RR AP7 §4.4 式 (20)(21)
    X = nominalCorrection(f, o.esRole);
    Z = X / (CORRECTION_FULL_KM - dminKm);
  }

  const s = {
    fGHz: f, p, pInput: pIn, Lb, latDeg: o.latDeg, model, stepKm: step, warnings,
    radioClimate: rc, dminKm, dmax1Km: dmaxInfo.dmax1Km, dmax1LimitedBy: dmaxInfo.limitedBy,
    segments: segs, horizonElevDeg: eh, siteShielding: shield ? site : null, AhDb: Ah,
    correction: { applied: corrWanted && X !== 0, XDb: X, ZDbPerKm: Z, esRole: o.esRole || null }
  };

  if (model === 'annex1-s2') {
    // 判断 6：纯陆路径的 Lbs 海型
    const def = o.seaZoneIfNoSea === 'B' || o.seaZoneIfNoSea === 'C' ? o.seaZoneIfNoSea : (Math.abs(o.latDeg) >= 30 ? 'B' : 'C');
    s.seaZoneIfNoSea = def;
    // RR AP7 附件 1 §2 式 (27a)：L1(p) = Lb(p) − Ah
    s.terms = { L1Db: Lb - Ah };
  } else if (model === 'annex1-s3') {
    const gO = gammaOxygen(f);                                     // 式 (33)
    const gWt = gammaWater(f, 3.0);                                // 式 (35a)：对流层散射，ρ = 3.0 g/m³
    const gWdl = gammaWater(f, 7.5);                               // 式 (35b)：陆上波导，ρ = 7.5 g/m³
    const gWds = gammaWater(f, 10.0);                              // 式 (35c)：海上波导，ρ = 10.0 g/m³
    const gD = 0.05 * Math.cbrt(f);                                // 式 (36)：γd = 0.05 f^⅓
    // 式 (37) 的 dc（判断 5）
    let dc = null, dcSource;
    if (isNum(o.dcKm)) { dc = Math.max(0, o.dcKm); dcSource = 'input'; } else {
      const first = segs[0].zone;
      const sea = segs.find(sg => sg.zone === 'B' || sg.zone === 'C');
      if (first === 'B' || first === 'C') { dc = 0; dcSource = 'esAtSea'; } else if (sea) { dc = sea.startKm; dcSource = 'profile'; } else { dc = null; dcSource = 'noSea'; }
    }
    // RR AP7 附件 1 §3 式 (37)：Ac = −6 / (1 + dc)
    const Ac = dc === null ? 0 : -6 / (1 + dc);
    // RR AP7 附件 1 §3 式 (38)：A1 = 122.43 + 16.5 lg f + Ah + Ac
    const A1 = 122.43 + 16.5 * LOG10(f) + Ah + Ac;
    // RR AP7 附件 1 §3 式 (40)：Lf = 25 lg f − 2.5 [lg(f/2)]²
    const Lf = 25 * LOG10(f) - 2.5 * Math.pow(LOG10(f / 2), 2);
    // RR AP7 附件 1 §3 式 (41)：A2 = 187.36 + 10 εh + Lf − 0.15 N0 − 10.1 [−lg(p/50)]^0.7
    const A2 = 187.36 + 10 * eh + Lf - 0.15 * rc.N0 - 10.1 * Math.pow(-LOG10(p / 50), 0.7);
    // 判断 4：C2i 在 375 km 外取 375 km 处的值，需 0–375 km 段的 τ
    const st375 = pathStats(segs, CORRECTION_FULL_KM);
    const tau375 = 1 - Math.exp(-4.12e-4 * Math.pow(st375.dlm, 2.41));
    s.terms = {
      gammaO: gO, gammaWt: gWt, gammaWdl: gWdl, gammaWds: gWds, gammaD: gD,
      dcKm: dc, dcSource, AcDb: Ac, A1Db: A1, LfDb: Lf, A2Db: A2,
      L3Db: Lb - A1,                                               // 式 (39a)：L3(p) = Lb(p) − A1
      L4Db: Lb - A2,                                               // 式 (42a)：L4(p) = Lb(p) − A2
      tau375
    };
  } else {
    const gOm = gammaOxygenMm(f);                                  // 式 (55)
    const gWm = gammaWaterMm(f);                                   // 式 (56)
    const gGm = gOm + gWm;                                         // 式 (57)：γgm = γom + γwm
    // RR AP7 附件 1 §4 式 (58)：L7(p) = 92.5 + 20 lg f + Ah
    const L7 = 92.5 + 20 * LOG10(f) + Ah;
    s.terms = { gammaOm: gOm, gammaWm: gWm, gammaGm: gGm, L7Db: L7, L8Db: Lb - L7 };   // 式 (59a)
  }
  s.lossAt = (d, withCorrection) => mode1LossAt(s, d, withCorrection);
  return s;
}

/**
 * 距离 d 处的模式 (1) 预测路径损耗（与 Lb 同口径：已含 Ah、修正值）。
 * §2：L2(p) + Ah；§3：min(A1 + L5, A2 + L6)；§4：L7 + L9。三者的「≥ Lb」与原文 (26a)(32a)(54a) 等价。
 */
function mode1LossAt(s, d, withCorrection) {
  const f = s.fGHz, p = s.p;
  const useC = withCorrection && s.correction.applied;
  if (s.model === 'annex1-s2') {
    const st = pathStats(s.segments, d);
    // RR AP7 附件 1 §2 式 (28b)：Ci = Z(f)(di − dmin)；375 km 外取 375 km 处的值
    const Ci = useC ? s.correction.ZDbPerKm * (Math.min(d, CORRECTION_FULL_KM) - s.dminKm) : 0;
    // RR AP7 附件 1 §2 式 (29)：Lbl(p) = 142.8 + 20 lg f + 10 lg p + 0.1 di + Ci
    const Lbl = 142.8 + 20 * LOG10(f) + 10 * LOG10(p) + 0.1 * d + Ci;
    // 冷暖海并存时全部按暖海（附件 1 §2）；无海时见判断 6
    const sea = st.hasC ? 'C' : (st.hasB ? 'B' : s.seaZoneIfNoSea);
    const lp = LOG10(p);
    let Lbs;
    if (sea === 'B') {
      // RR AP7 附件 1 §2 式 (30a)（B 区）
      Lbs = 49.91 * LOG10(d + 1840 * Math.pow(f, 1.76)) + 1.195 * Math.pow(f, 0.393) * Math.pow(lp, 1.38) * Math.pow(d, 0.597)
        + (0.01 * d - 70) * (f - 0.1581) + (0.02 - 2e-5 * p * p) * d + 9.72e-9 * d * d * p * p + 20.2;
    } else {
      // RR AP7 附件 1 §2 式 (30b)（C 区）
      Lbs = 49.343 * LOG10(d + 1840 * Math.pow(f, 1.58)) + 1.266 * Math.pow(lp, 0.468 + 2.598 * f) * Math.pow(d, 0.453)
        + (0.037 * d - 70) * (f - 0.1581) + 1.95e-10 * d * d * p * p * p + 20.2;
    }
    // RR AP7 附件 1 §2 式 (31)：L2 = Lbs + [1 − exp(−5.5 (dtm/di)^1.1)] (Lbl − Lbs)
    const w = 1 - Math.exp(-5.5 * Math.pow(st.dtm / d, 1.1));
    const L2 = Lbs + w * (Lbl - Lbs);
    return { lossDb: L2 + s.AhDb, terms: { CiDb: Ci, LblDb: Lbl, LbsDb: Lbs, seaZone: sea, dtmKm: st.dtm, landWeight: w, L2Db: L2 } };
  }
  if (s.model === 'annex1-s3') {
    const t = s.terms, rc = s.radioClimate;
    const st = pathStats(s.segments, d);
    // RR AP7 附件 1 §3 式 (44)：γg = γo + γwdl (dt/di) + γwds (1 − dt/di)
    const gg = t.gammaO + t.gammaWdl * (st.dt / d) + t.gammaWds * (1 - st.dt / d);
    // RR AP7 附件 1 §3 式 (45)：τ = 1 − exp[−(4.12×10⁻⁴ dlm^2.41)]
    const tau = 1 - Math.exp(-4.12e-4 * Math.pow(st.dlm, 2.41));
    // RR AP7 附件 1 §3 式 (46)：μ1 = [10^(−dtm/(16 − 6.6τ)) + (10^(−(0.496 + 0.354τ)))^5]^0.2，μ1 ≤ 1
    const mu1 = Math.min(1, Math.pow(Math.pow(10, -st.dtm / (16 - 6.6 * tau)) + Math.pow(10, -5 * (0.496 + 0.354 * tau)), 0.2));
    // RR AP7 附件 1 §3 式 (47)：σ = −0.6 − 8.5×10⁻⁹ di^3.1 τ，σ ≥ −3.4
    const sigma = Math.max(-3.4, -0.6 - 8.5e-9 * Math.pow(d, 3.1) * tau);
    // RR AP7 附件 1 §3 式 (48)：μ2 = (2.48×10⁻⁴ di²)^σ，μ2 ≤ 1
    const mu2 = Math.min(1, Math.pow(2.48e-4 * d * d, sigma));
    // RR AP7 附件 1 §3 式 (49a)/(49b)：μ4 = 10^((−0.935 + 0.0176 ζr) lg μ1)（ζr ≤ 70°）；10^(0.3 lg μ1)（ζr > 70°，判断 2）
    const mu4 = rc.zetaR <= 70 ? Math.pow(10, (-0.935 + 0.0176 * rc.zetaR) * LOG10(mu1)) : Math.pow(10, 0.3 * LOG10(mu1));
    // RR AP7 附件 1 §3 式 (50)：β = βe μ1 μ2 μ4
    const beta = rc.betaE * mu1 * mu2 * mu4;
    const lb = LOG10(beta);
    // RR AP7 附件 1 §3 式 (51)：Γ1 = 1.076/(2.0058 − lg β)^1.012 × exp[−(9.51 − 4.8 lg β + 0.198 (lg β)²) × 10⁻⁶ di^1.13]
    const Gamma1 = 1.076 / Math.pow(2.0058 - lb, 1.012) * Math.exp(-(9.51 - 4.8 * lb + 0.198 * lb * lb) * 1e-6 * Math.pow(d, 1.13));
    // RR AP7 附件 1 §3 式 (52)：C2i = Z(f)(di − dmin) τ；375 km 外取 375 km 处的值（判断 4）
    let C2i = 0;
    if (useC) {
      C2i = d <= CORRECTION_FULL_KM ? s.correction.ZDbPerKm * (d - s.dminKm) * tau
        : s.correction.ZDbPerKm * (CORRECTION_FULL_KM - s.dminKm) * t.tau375;
    }
    const pb = p / beta;
    // RR AP7 附件 1 §3 式 (53)：L5 = (γd + γg) di + (1.2 + 3.7×10⁻³ di) lg(p/β) + 12 (p/β)^Γ1 + C2i
    const L5 = (t.gammaD + gg) * d + (1.2 + 3.7e-3 * d) * LOG10(pb) + 12 * Math.pow(pb, Gamma1) + C2i;
    // RR AP7 附件 1 §3 式 (54)：L6 = 20 lg di + 5.73×10⁻⁴ (112 − 15 cos 2ζ) di + (γo + γwt) di + C2i
    const L6 = 20 * LOG10(d) + 5.73e-4 * (112 - 15 * Math.cos(2 * s.latDeg * D2R)) * d + (t.gammaO + t.gammaWt) * d + C2i;
    const duct = t.A1Db + L5, tropo = t.A2Db + L6;
    return { lossDb: Math.min(duct, tropo), terms: {
      dtKm: st.dt, dlmKm: st.dlm, dtmKm: st.dtm, gammaG: gg, tau, mu1, sigma, mu2, mu4, beta, Gamma1, C2iDb: C2i,
      L5Db: L5, L6Db: L6, ductingLossDb: duct, troposcatterLossDb: tropo, dominant: duct <= tropo ? 'ducting' : 'troposcatter' } };
  }
  // RR AP7 附件 1 §4 式 (61)：L9 = γgm di + 20 lg di + 2.6 [1 − exp(−di/10)] lg(p/50)（> 60 GHz 无修正项）
  const L9 = s.terms.gammaGm * d + 20 * LOG10(d) + 2.6 * (1 - Math.exp(-d / 10)) * LOG10(p / 50);
  return { lossDb: s.terms.L7Db + L9, terms: { L9Db: L9 } };
}

/** 迭代：di = dmin + i·s，直到预测损耗 ≥ Lreq 或 di ≥ dLimit（结果截到 dLimit）。 */
function iterateMode1(s, Lreq, withCorrection, dLimit, limitTag) {
  for (let i = 0; ; i++) {
    // RR AP7 附件 1 式 (28a)/(43)/(60)：di = dmin + i·s
    const di = s.dminKm + i * s.stepKm;
    if (di >= dLimit - 1e-9) {
      const r = s.lossAt(dLimit, withCorrection);
      return { distanceKm: dLimit, stoppedBy: r.lossDb >= Lreq ? 'loss' : limitTag, lossAtDistanceDb: r.lossDb, terms: r.terms, iterations: i + 1 };
    }
    const r = s.lossAt(di, withCorrection);
    // RR AP7 附件 1 式 (26a)/(32a)/(54a)：预测损耗达到所需损耗即停（式 (26c)/(32c)/(54c)：d1 = di）
    if (r.lossDb >= Lreq) return { distanceKm: di, stoppedBy: 'loss', lossAtDistanceDb: r.lossDb, terms: r.terms, iterations: i + 1 };
  }
}

/**
 * 模式 (1)（大圆传播机理）所需距离。RR AP7 正文 §4 + 附件 1。
 *
 * @param {object} o
 * @param {number} o.fGHz            频率（GHz，0.1–105）
 * @param {number} o.p               时间百分比 p（%）
 * @param {number} o.Lb              所需最小损耗 Lb(p)（dB，式 (1)/(4)/(6)）
 * @param {number} o.latDeg          地球站纬度（°）
 * @param {string|Array<{zone:'A1'|'A2'|'B'|'C', lengthKm?:number}>} o.zones 该方位的无线电气候区划剖面（自站向外，
 *        末段可省略长度表示一直延伸）；60 GHz 以上不需要
 * @param {{elevDeg?:number, distKm?:number}} [o.horizon] 该方位地平线仰角 εh（°）与地平线距离（km）
 * @param {number} [o.dcKm]          到海岸距离覆盖值（判断 5）
 * @param {'tx'|'rx'} [o.esRole]     地球站发射 / 接收（决定式 (20) 的 X）
 * @param {boolean} [o.correction=true] 是否施加固定业务修正 Ci/C2i（与移动业务、双向频段协调时传 false）
 * @param {number} [o.Q]             辅助等值线值（dB，负值）：另算 Lbq = Lb + Q（式 (22)）、修正为 0、
 *                                   上限为主等值线距离（式 (26b)/(32b)/(54b)，附件 6 §3.1）
 * @param {number} [o.stepKm=1]      迭代步长 s（§1.3 推荐 1 km）
 * @param {boolean} [o.siteShielding=true] false = §1.4.5/§1.4.6 情形（不计地平线保护，εh、Ah 按 0）
 * @param {'B'|'C'} [o.seaZoneIfNoSea] 附件 1 §2 纯陆路径 Lbs 的海型（判断 6）
 * @returns {object} { distanceKm, stoppedBy:'loss'|'dmax', dminKm, dmax1Km, dmax1LimitedBy, requiredLossDb,
 *          lossAtDistanceDb, model, pUsed, AhDb, siteShielding, correction, constants, atDistance, iterations,
 *          auxiliary?, warnings } 或 { error }
 */
function mode1RequiredDistance(o) {
  const s = mode1Setup(o);
  if (s.error) return s;
  const main = iterateMode1(s, s.Lb, true, s.dmax1Km, 'dmax');
  const out = {
    distanceKm: main.distanceKm, stoppedBy: main.stoppedBy,
    dminKm: s.dminKm, dmax1Km: s.dmax1Km, dmax1LimitedBy: s.dmax1LimitedBy, stepKm: s.stepKm,
    requiredLossDb: s.Lb, lossAtDistanceDb: main.lossAtDistanceDb,
    model: s.model, pUsed: s.p, radioClimate: s.radioClimate,
    horizonElevDeg: s.horizonElevDeg, AhDb: s.AhDb, siteShielding: s.siteShielding,
    correction: Object.assign({}, s.correction, {
      atDistanceDb: main.terms.CiDb !== undefined ? main.terms.CiDb : (main.terms.C2iDb !== undefined ? main.terms.C2iDb : 0)
    }),
    constants: s.terms, atDistance: main.terms, iterations: main.iterations,
    warnings: s.warnings.slice()
  };
  if (isNum(o.Q)) {
    // RR AP7 §4.4 式 (22)：Lbq(p) = Lb(p) + Q；附件 1 式 (28b)/(52)：辅助等值线修正为 0
    const aux = iterateMode1(s, s.Lb + o.Q, false, main.distanceKm, 'mainContour');
    out.auxiliary = { Q: o.Q, requiredLossDb: s.Lb + o.Q, distanceKm: aux.distanceKm, stoppedBy: aux.stoppedBy,
      lossAtDistanceDb: aux.lossAtDistanceDb, iterations: aux.iterations };
    if (o.Q > 0) out.warnings.push(`辅助等值线值 Q = ${o.Q} dB 为正（原文约定为负值）`);
  }
  return out;
}

/**
 * 距离 d 处的模式 (1) 预测路径损耗（不迭代），用于追溯与单调性检查。
 * @param {object} o 同 mode1RequiredDistance（Lb 可省略）
 * @param {number} dKm
 * @param {{correction?:boolean}} [opt] correction=false 时不计 Ci/C2i
 */
function mode1PathLoss(o, dKm, opt) {
  const s = mode1Setup(Object.assign({ Lb: 0 }, o));
  if (s.error) return s;
  if (!(dKm > 0)) return { error: '距离应为正数' };
  const r = s.lossAt(dKm, !(opt && opt.correction === false));
  return { lossDb: r.lossDb, terms: r.terms, constants: s.terms, AhDb: s.AhDb, dminKm: s.dminKm, dmax1Km: s.dmax1Km,
    model: s.model, pUsed: s.p, correction: s.correction, warnings: s.warnings };
}

// ===========================================================================
// 附件 2：模式 (2) 雨散射
// ===========================================================================

/**
 * 雨气候区 A–Q 的降雨率 R(p)（mm/h）。RR AP7 附件 2 §3 式 (63)–(68) 与表 4。
 * @returns {{R:number, eq:number, group:string[], pc:number, R03:number} | {error:string}}
 */
function rainRate(rainZone, p) {
  const z = String(rainZone || '').toUpperCase();
  if (z.length !== 1 || !RAIN_ZONES.includes(z)) return { error: `无效雨气候区「${rainZone}」，应为 A–Q（无 I、O）` };
  const g = T.TABLE_4.find(r => r.zones.includes(z));
  const pp = Number(p);
  if (!(pp > 0)) return { error: '时间百分比 p 无效' };
  if (pp >= 0.3) {
    // RR AP7 附件 2 表 4：p > pc 时 R(p) 取 0；式 (68)：R(p) = R(0.3%) [lg(pc/p) / lg(pc/0.3)]²
    const R = pp >= g.pc ? 0 : g.R03 * Math.pow(LOG10(g.pc / pp) / LOG10(g.pc / 0.3), 2);
    return { R, eq: 68, group: g.zones, pc: g.pc, R03: g.R03 };
  }
  const L1 = LOG10(pp / 0.001), L3 = LOG10(0.3 / pp);
  let R;
  switch (g.eq) {
    case 63: // 式 (63)（A、B）：1.1 p^−0.465 + 0.25 [lg(p/0.001) lg³(0.3/p)] − [|lg(p/0.1)| + 1.1]^−2
      R = 1.1 * Math.pow(pp, -0.465) + 0.25 * (L1 * Math.pow(L3, 3)) - Math.pow(Math.abs(LOG10(pp / 0.1)) + 1.1, -2);
      break;
    case 64: // 式 (64)（C、D、E）：2 p^−0.466 + 0.5 [lg(p/0.001) lg³(0.3/p)]
      R = 2 * Math.pow(pp, -0.466) + 0.5 * (L1 * Math.pow(L3, 3));
      break;
    case 65: // 式 (65)（F、G、H、J、K）：4.17 p^−0.418 + 1.6 [lg(p/0.001) lg³(0.3/p)]
      R = 4.17 * Math.pow(pp, -0.418) + 1.6 * (L1 * Math.pow(L3, 3));
      break;
    case 66: // 式 (66)（L、M）：4.9 p^−0.48 + 6.5 [lg(p/0.001) lg²(0.3/p)]
      R = 4.9 * Math.pow(pp, -0.48) + 6.5 * (L1 * Math.pow(L3, 2));
      break;
    default: // 式 (67)（N、P、Q）：15.6 (p^−0.383 + [lg(p/0.001) lg^1.5(0.3/p)])
      R = 15.6 * (Math.pow(pp, -0.383) + L1 * Math.pow(L3, 1.5));
  }
  return { R, eq: g.eq, group: g.zones, pc: g.pc, R03: g.R03 };
}

/**
 * 降雨高度 hR（km）。RR AP7 附件 2 §3 式 (74)(75)。
 * @param {number} latDeg
 * @param {'naEurope'|'other'} [region='other'] 'naEurope' = 北美及 60°E 以西的欧洲
 * @returns {{hR:number, eq:string, warnings:string[]}}
 */
function rainHeight(latDeg, region) {
  const z = Number(latDeg);
  const warnings = [];
  if (region === 'naEurope') {
    // RR AP7 附件 2 式 (74)：hR = 3.2 − 0.075 (ζ − 35)，35 ≤ ζ ≤ 70
    if (z >= 35 && z <= 70) return { hR: 3.2 - 0.075 * (z - 35), eq: '74', warnings };
    warnings.push(`式 (74) 只定义 35°–70°，纬度 ${z}° 改用式 (75)`);
  }
  let h, eq;
  if (z > 23) { h = 5 - 0.075 * (z - 23); eq = '75a'; }            // 式 (75a)
  else if (z >= 0) { h = 5; eq = '75b'; }                          // 式 (75b)
  else if (z >= -21) { h = 5; eq = '75c'; }                        // 式 (75c)
  else if (z >= -71) { h = 5 + 0.1 * (z + 21); eq = '75d'; }       // 式 (75d)
  else { h = 0; eq = '75e'; }                                      // 式 (75e)
  return { hR: Math.max(0, h), eq, warnings };
}

/**
 * 垂直极化雨衰系数 k、α。RR AP7 附件 2 表 5：频率与 k 取对数、α 线性插值。
 * @returns {{k:number, alpha:number}}
 */
function rainKAlpha(fGHz) {
  const tb = T.TABLE_5;
  const f = Math.min(tb[tb.length - 1].fGHz, Math.max(tb[0].fGHz, Number(fGHz)));
  let j = 1;
  while (j < tb.length - 1 && tb[j].fGHz < f) j++;
  const a = tb[j - 1], b = tb[j];
  const t = (LOG10(f) - LOG10(a.fGHz)) / (LOG10(b.fGHz) - LOG10(a.fGHz));
  return { k: Math.pow(10, LOG10(a.k) + t * (LOG10(b.k) - LOG10(a.k))), alpha: a.alpha + t * (b.alpha - a.alpha) };
}

/**
 * 模式 (2) 预计算（与距离无关的量）。参数见 mode2RequiredDistance。
 */
function mode2Setup(o) {
  if (!o) return { error: '缺参数' };
  const f = Number(o.fGHz);
  if (!isNum(f) || !(f > 0)) return { error: '频率无效' };
  if (f < 0.1 || f > 105) return { error: `频率 ${f} GHz 不在附录 7 适用范围 0.1–105 GHz` };
  if (!isNum(o.latDeg) || Math.abs(o.latDeg) > 90) return { error: '缺地球站纬度' };
  const pIn = Number(o.p);
  if (!(pIn > 0)) return { error: '时间百分比 p 无效' };
  const L = Number(o.L);
  if (!isNum(L)) return { error: '缺模式 (2) 所需最小损耗 L(p)' };
  const Gx = Number(o.Gx);
  if (!isNum(Gx)) return { error: '缺地面站天线增益 Gx' };
  const step = o.stepKm === undefined ? 1 : Number(o.stepKm);
  if (!(step > 0)) return { error: '迭代步长应为正数' };
  const warnings = [];
  const { dminKm } = minCoordinationDistance(f, o.latDeg);
  const hr = isNum(o.rainHeightKm) ? { hR: Math.max(0, o.rainHeightKm), eq: 'input', warnings: [] } : rainHeight(o.latDeg, o.rainHeightRegion);
  warnings.push(...hr.warnings);
  const hR = hr.hR;
  // RR AP7 附件 2 §2：dmax2 = √(17 000 (hR + 3))
  const dmax2 = Math.sqrt(17000 * (hR + 3));
  const s = { fGHz: f, pInput: pIn, p: pIn, L, Gx, latDeg: o.latDeg, stepKm: step, dminKm, hRKm: hR, hREq: hr.eq,
    dmax2Km: dmax2, warnings, neglected: null };
  // RR AP7 §5.1 / 附件 2：只需在 1 000 MHz – 40.5 GHz 计算；范围外雨散射可忽略，所需距离取 dmin
  if (f < 1 || f > 40.5) { s.neglected = 'frequency'; return s; }
  let p = pIn;
  if (p < 0.001) { p = 0.001; warnings.push(`p = ${fmt(pIn, 5)}% 低于附件 2 适用范围下限 0.001%，按 0.001% 计算`); }
  if (pIn > 10) warnings.push(`p = ${fmt(pIn, 3)}% 高于附件 2 适用范围上限 10%`);
  s.p = p;
  let R, rr = null;
  if (isNum(o.rainRateMmH)) { R = o.rainRateMmH; } else {
    rr = rainRate(o.rainZone, p);
    if (rr.error) return { error: rr.error };
    R = rr.R;
  }
  s.rainRateMmH = R;
  s.rainRateSource = rr ? { zone: String(o.rainZone).toUpperCase(), eq: rr.eq, pc: rr.pc } : { input: true };
  if (!(R > 0)) { s.neglected = 'noRain'; return s; }
  const ka = rainKAlpha(f);
  // RR AP7 附件 2 式 (69)(70)：R = R(p)；γR = k R^α
  const gR = ka.k * Math.pow(R, ka.alpha);
  // RR AP7 附件 2 式 (71)：ds = 3.5 R^−0.08
  const ds = 3.5 * Math.pow(R, -0.08);
  // RR AP7 附件 2 式 (72)：Rcv = (2.17 / (γR ds)) (1 − 10^(−γR ds / 5))；γR ds → 0 时取极限 2.17 ln10 / 5
  const x = gR * ds;
  const Rcv = x > 1e-9 ? (2.17 / x) * (1 - Math.pow(10, -x / 5)) : 2.17 * Math.LN10 / 5;
  // RR AP7 附件 2 式 (73)：Γ2 = 631 k R^(α − 0.5) × 10^(−(R + 1)^0.19)
  const G2 = 631 * ka.k * Math.pow(R, ka.alpha - 0.5) * Math.pow(10, -Math.pow(R + 1, 0.19));
  // RR AP7 附件 2 式 (76)：γwr = [0.06575 + 3.6/((f − 22.2)² + 8.5)] f² 7.5×10⁻⁴
  const gWr = (0.06575 + 3.6 / (Math.pow(f - 22.2, 2) + 8.5)) * f * f * 7.5e-4;
  Object.assign(s, { k: ka.k, alpha: ka.alpha, gammaR: gR, dsKm: ds, Rcv, Gamma2: G2, gammaO: gammaOxygen(f), gammaWr: gWr,
    // 式 (78) 中 Lar 由 0 变正的距离：6 (ri − 50)² × 10⁻⁵ = hR
    larOnsetKm: 50 + Math.sqrt(hR / 6e-5) });
  return s;
}

/**
 * 模式 (2) 路径损耗 Lr（dB）。RR AP7 附件 2 §3.1 式 (78)–(82)。
 * @param {object} s     mode2Setup 的返回值（未被判定为可忽略）
 * @param {number} ri    雨散射最大处到地面站的距离（km）
 * @param {number} [GxDbi] 地面站天线增益；缺省用 s.Gx（附件 6 §3.2.2 i) 以 G(υ) 代替）
 */
function mode2PathLoss(s, ri, GxDbi) {
  const f = s.fGHz, R = s.rainRateMmH, hR = s.hRKm;
  const Gx = isNum(GxDbi) ? GxDbi : s.Gx;
  // RR AP7 附件 2 式 (78a)(78b)：Lar = 6.5 [6 (ri − 50)² × 10⁻⁵ − hR]，若 6 (ri − 50)² × 10⁻⁵ > hR，否则 0
  const q = 6 * Math.pow(ri - 50, 2) * 1e-5;
  const Lar = q > hR ? 6.5 * (q - hR) : 0;
  // RR AP7 附件 2 式 (79a)(79b)：Ab = 0.005 (f − 10)^1.7 R^0.4（10 < f < 40.5 GHz）；f < 10 GHz 或 Lar ≠ 0 时为 0（判断 10）
  const Ab = (f > 10 && f <= 40.5 && Lar === 0) ? 0.005 * Math.pow(f - 10, 1.7) * Math.pow(R, 0.4) : 0;
  // RR AP7 附件 2 式 (80a)(80b)：do = 0.7 ri + 32（ri < 340 km）；270（ri ≥ 340 km）
  const dO = ri < 340 ? 0.7 * ri + 32 : 270;
  // RR AP7 附件 2 式 (81a)(81b)：dv = 0.7 ri + 32（ri < 240 km）；200（ri ≥ 240 km）
  const dV = ri < 240 ? 0.7 * ri + 32 : 200;
  // RR AP7 附件 2 式 (82)：Lr = 168 + 20 lg ri − 20 lg f − 13.2 lg R − Gx + Ab − 10 lg Rcv + Γ2 + Lar + γo do + γwr dv
  const Lr = 168 + 20 * LOG10(ri) - 20 * LOG10(f) - 13.2 * LOG10(R) - Gx + Ab - 10 * LOG10(s.Rcv) + s.Gamma2 + Lar
    + s.gammaO * dO + s.gammaWr * dV;
  return { lossDb: Lr, LarDb: Lar, AbDb: Ab, doKm: dO, dvKm: dV };
}

/**
 * 模式 (2)（水凝物散射）所需距离 dr。RR AP7 正文 §5 + 附件 2 §1–§3。
 * @param {object} o
 * @param {number} o.fGHz, o.p, o.latDeg
 * @param {number} o.L               模式 (2) 所需最小损耗 L(p) = Pt − Pr(p)（式 (3)）
 * @param {number} o.Gx              地面站天线增益 Gx（dBi，表 7/8），在迭代式 (82) 内
 * @param {string} [o.rainZone]      ITU 雨气候区 A–Q（附件 2 图 2–4）；或直接给
 * @param {number} [o.rainRateMmH]   R(p)（mm/h），覆盖 rainZone（偏离 AP7 时使用，判断 11）
 * @param {number} [o.rainHeightKm]  hR 覆盖值；缺省按式 (74)(75)
 * @param {'naEurope'|'other'} [o.rainHeightRegion='other']
 * @param {number} [o.stepKm=1]
 * @returns {object} { distanceKm, stoppedBy:'loss'|'dmax'|'neglected', dminKm, dmax2Km, hRKm, rainRateMmH, k, alpha,
 *          gammaR, dsKm, Rcv, Gamma2, gammaO, gammaWr, lossAtDistanceDb, requiredLossDb, larOnsetKm, warnings, neglected } 或 { error }
 */
function mode2RequiredDistance(o) {
  const s = mode2Setup(o);
  if (s.error) return s;
  const base = { dminKm: s.dminKm, dmax2Km: s.dmax2Km, hRKm: s.hRKm, hREq: s.hREq, requiredLossDb: s.L, pUsed: s.p,
    Gx: s.Gx, warnings: s.warnings.slice(), _setup: s };
  if (s.neglected) {
    return Object.assign(base, { distanceKm: s.dminKm, stoppedBy: 'neglected', neglected: s.neglected,
      rainRateMmH: s.rainRateMmH === undefined ? null : s.rainRateMmH, lossAtDistanceDb: null });
  }
  let res = null;
  for (let i = 0; ; i++) {
    // RR AP7 附件 2 式 (77)：ri = dmin + i·s
    const ri = s.dminKm + i * s.stepKm;
    if (ri >= s.dmax2Km - 1e-9) {
      // RR AP7 附件 2 式 (62b)：ri ≥ dmax2 时终止，dr = dmax2
      const r = mode2PathLoss(s, s.dmax2Km);
      res = { distanceKm: s.dmax2Km, stoppedBy: r.lossDb >= s.L ? 'loss' : 'dmax', r, iterations: i + 1 };
      break;
    }
    const r = mode2PathLoss(s, ri);
    // RR AP7 附件 2 式 (62a)：Lr(p) ≥ L(p) 时终止，dr = ri
    if (r.lossDb >= s.L) { res = { distanceKm: ri, stoppedBy: 'loss', r, iterations: i + 1 }; break; }
  }
  return Object.assign(base, {
    distanceKm: res.distanceKm, stoppedBy: res.stoppedBy, neglected: null, iterations: res.iterations,
    lossAtDistanceDb: res.r.lossDb, atDistance: { LarDb: res.r.LarDb, AbDb: res.r.AbDb, doKm: res.r.doKm, dvKm: res.r.dvKm },
    rainRateMmH: s.rainRateMmH, rainRateSource: s.rainRateSource, k: s.k, alpha: s.alpha, gammaR: s.gammaR, dsKm: s.dsKm,
    Rcv: s.Rcv, Gamma2: s.Gamma2, gammaO: s.gammaO, gammaWr: s.gammaWr, larOnsetKm: s.larOnsetKm
  });
}

/**
 * 模式 (2) 等值线的圆心偏移。RR AP7 附件 2 §4 式 (83)：Δd = hR / (2 tan εs)，且不超过 dr − 50 km。
 * @returns {{deltaDKm:number, deltaDUnlimitedKm:number, limited:boolean}}
 */
function mode2CentreOffset(hRKm, beamElevDeg, drKm) {
  const raw = hRKm / (2 * Math.tan(beamElevDeg * D2R));
  const cap = drKm - 50;
  return { deltaDKm: Math.max(0, Math.min(raw, cap)), deltaDUnlimitedKm: raw, limited: raw > cap };
}

/**
 * 自地球站沿方位 az 到模式 (2) 圆的距离（平面几何，判断 12），不小于 dmin。RR AP7 附件 2 §4。
 */
function mode2DistanceAtAzimuth(azDeg, centre) {
  const phi = (azDeg - centre.azDeg) * D2R;
  const dd = centre.deltaDKm, r = centre.radiusKm;
  const t = dd * Math.cos(phi) + Math.sqrt(Math.max(0, r * r - dd * dd * Math.sin(phi) * Math.sin(phi)));
  // RR AP7 附件 2 §4：落在 dmin 圆以内的弧段改取 dmin 圆
  return Math.max(centre.dminKm, t);
}

/**
 * 模式 (2) 等值线（每个方位到地球站的距离）。RR AP7 附件 2 §1 d) 与 §4。
 * @param {object} o mode2RequiredDistance 的参数，另加：
 * @param {Array<{elevDeg:number, azDeg:number}>} o.beams 地球站主波束指向（倾斜轨道给两个极端星位，判断 13）；
 *        也可给单个 o.beamElevDeg / o.beamAzDeg
 * @param {number[]} o.azimuthsDeg   要输出的方位
 * @returns {{distancesKm:number[], azimuthsDeg:number[], mode2:object, circles:Array<object>, warnings:string[]} | {error}}
 */
function mode2Contour(o) {
  const m2 = mode2RequiredDistance(o);
  if (m2.error) return m2;
  const beams = Array.isArray(o.beams) && o.beams.length ? o.beams
    : (isNum(o.beamElevDeg) && isNum(o.beamAzDeg) ? [{ elevDeg: o.beamElevDeg, azDeg: o.beamAzDeg }] : null);
  if (!m2.neglected && !beams) return { error: '缺地球站主波束仰角 / 方位' };
  if (beams && beams.some(b => !(b.elevDeg > 0))) return { error: '主波束仰角应大于 0°' };
  const az = Array.isArray(o.azimuthsDeg) ? o.azimuthsDeg : [];
  const circles = m2.neglected ? [{ azDeg: 0, deltaDKm: 0, radiusKm: m2.dminKm, dminKm: m2.dminKm, beam: null }]
    : beams.map(b => {
      const c = mode2CentreOffset(m2.hRKm, b.elevDeg, m2.distanceKm);
      return { azDeg: b.azDeg, beamElevDeg: b.elevDeg, deltaDKm: c.deltaDKm, deltaDUnlimitedKm: c.deltaDUnlimitedKm,
        deltaDLimited: c.limited, radiusKm: m2.distanceKm, dminKm: m2.dminKm };
    });
  // 多个星位（倾斜轨道）：雨散射区为各圆之并——每个圆都含地球站，按方位取最大距离即为并集边界
  const distancesKm = az.map(a => Math.max(...circles.map(c => mode2DistanceAtAzimuth(a, c))));
  return { azimuthsDeg: az.slice(), distancesKm, circles, mode2: stripSetup(m2), warnings: m2.warnings };
}

function stripSetup(m) { const c = Object.assign({}, m); delete c._setup; return c; }

// ===========================================================================
// 附件 7 §2：容许干扰功率与噪声温度；正文 §1.3 所需损耗
// ===========================================================================

/** 接收系统噪声温度 Te（K）。RR AP7 附件 7 §2.1 式 (128)：Te = Ta + (ℓt1 − 1) 290 + ℓt1 Tr；ℓt1 缺省 1.0。 */
function noiseTemperature(o) {
  const lt1 = isNum(o.lt1) ? o.lt1 : 1.0;
  return o.TaK + (lt1 - 1) * 290 + lt1 * o.TrK;
}

/**
 * 双向频段接收地球站 Te 缺省值（K）。RR AP7 附件 7 §2.1 表 6（端点 10、17 GHz 取较低值，判断 14）。
 */
function bidirectionalNoiseTemperature(fGHz) {
  const f = Number(fGHz);
  if (f <= 10) return 75;
  if (f <= 17) return 150;
  return 300;
}

/**
 * 单一干扰源的容许干扰功率 Pr(p)（dBW，在参考带宽 B 内）。RR AP7 附件 7 §2 式 (127)。
 * @param {object} o { TeK（或 TaK/TrK/lt1）, BHz, NLdB, MsdB, WdB }
 * @returns {number|{error:string}}
 */
function permissibleInterferencePower(o) {
  if (!o) return { error: '缺参数' };
  const Te = isNum(o.TeK) ? o.TeK : (isNum(o.TaK) && isNum(o.TrK) ? noiseTemperature(o) : NaN);
  if (!(Te > 0)) return { error: '缺接收系统噪声温度 Te' };
  if (!(o.BHz > 0)) return { error: '缺参考带宽 B' };
  if (!isNum(o.MsdB) || !(o.MsdB > 0)) return { error: '缺链路性能余量 Ms（须为正）' };
  const NL = isNum(o.NLdB) ? o.NLdB : 0;
  const W = isNum(o.WdB) ? o.WdB : 0;
  // RR AP7 附件 7 §2 式 (127)：Pr(p) = 10 lg(k Te B) + NL + 10 lg(10^(Ms/10) − 1) − W，k = 1.38×10⁻²³ J/K
  return 10 * LOG10(K_BOLTZMANN_AP7 * Te * o.BHz) + NL + 10 * LOG10(Math.pow(10, o.MsdB / 10) - 1) - W;
}

/** 模式 (1) 所需最小损耗。RR AP7 正文 §1.3 式 (1)（§2.1 式 (4)、§3.1.1 式 (6) 同式）：Lb = Pt + Gt + Gr − Pr。 */
function requiredLossMode1(o) { return o.Pt + o.Gt + o.Gr - o.Pr; }

/**
 * 模式 (2) 所需最小损耗。RR AP7 正文 §1.3 式 (2)：Lx = Pt + Gx − Pr；式 (3)：L = Pt − Pr（Gx 移入式 (82)）。
 */
function requiredLossMode2(o) {
  return { L: o.Pt - o.Pr, Lx: isNum(o.Gx) ? o.Pt + o.Gx - o.Pr : null };
}

/**
 * 由表 7/8/9 的一列 + 地球站参数构造 Pt、Pr(p)、Gx、p 与所需损耗。RR AP7 正文 §1.3、§2.1、§3.1.1，附件 7 §2。
 *
 * @param {object} o
 * @param {{table:string, column:object}} [o.entry] findColumns() 的一项；或分别给 o.table、o.column
 * @param {number} [o.esPtDbW]         发射地球站（表 7/9）在该列参考带宽 B 内的最大功率（dBW）
 * @param {number} [o.esPsdDbWPerHz]   或给功率谱密度（dBW/Hz），Pt = psd + 10 lg B
 * @param {number} [o.esTeK]           接收地球站（表 8）系统噪声温度（K）；或给 esTaK/esTrK/esLt1（式 (128)）
 * @param {'A'|'N'} [o.terrestrialModulation] 表 8：取哪一行地面站 E/Pt；缺省取两者中 Pt 较大者（保守）
 * @param {number} [o.p]               覆盖列中的 p（列中 p 为空时必须给）
 * @param {number} [o.Ge]              本方位地球站地平线增益（给出则直接算出 Lb）
 * @param {number} [o.Gr]              表 9：接收地球站地平线增益（GSO 列须由附件 5 逐方位计算后给出）
 * @returns {object} { kind:'tx'|'rx'|'bidirectional', Pt, Pr, PrSource:'table'|'eq127', Gx, Gr, p, B, LbDb?, L, Lx,
 *          lb(Ge, Gr?) , warnings } 或 { error }
 */
function requiredLoss(o) {
  if (!o) return { error: '缺参数' };
  const table = String((o.entry && o.entry.table) || o.table || '');
  const col = (o.entry && o.entry.column) || o.column;
  if (!col || !table) return { error: '缺表列（entry 或 table + column）' };
  const kind = table.charAt(0) === '7' ? 'tx' : (table.charAt(0) === '8' ? 'rx' : (table.charAt(0) === '9' ? 'bidirectional' : null));
  if (!kind) return { error: `无效表号「${table}」` };
  const warnings = [];
  const B = col.B;
  if (!(B > 0)) return { error: `表 ${table} 该列无参考带宽 B` };
  let p = isNum(o.p) ? o.p : col.p;
  if (!(p > 0)) return { error: `表 ${table} 该列无时间百分比 p，须由调用方给出` };

  let Pt, Pr, PrSource, Gx = null, Gr = null;
  if (kind === 'rx') {
    // 表 8：干扰源是地面站，Pt、Gx 取自表；Pr 用表值，空格时由地球站 Te 按式 (127) 计算
    const pa = col.Pt.A, pn = col.Pt.N;
    let mod = o.terrestrialModulation;
    if (mod !== 'A' && mod !== 'N') mod = (isNum(pa) && (!isNum(pn) || pa >= pn)) ? 'A' : 'N';
    Pt = col.Pt[mod];
    if (!isNum(Pt)) return { error: `表 ${table} 该列无地面站 ${mod} 调制的 Pt` };
    Gx = col.Gx;
    if (!isNum(Gx)) return { error: `表 ${table} 该列无 Gx` };
    if (isNum(col.Pr)) { Pr = col.Pr; PrSource = 'table'; } else {
      const Te = isNum(o.esTeK) ? o.esTeK : (isNum(o.esTaK) && isNum(o.esTrK) ? noiseTemperature({ TaK: o.esTaK, TrK: o.esTrK, lt1: o.esLt1 }) : NaN);
      if (!(Te > 0)) return { error: '该列无 Pr，须给接收地球站噪声温度 esTeK' };
      // 附件 7 §2.2：无表值时 NL 对卫星链路取 1 dB
      const r = permissibleInterferencePower({ TeK: Te, BHz: B, NLdB: isNum(col.NL) ? col.NL : 1, MsdB: col.Ms, WdB: isNum(col.W) ? col.W : 0 });
      if (!isNum(r)) return { error: r.error };
      Pr = r; PrSource = 'eq127';
    }
    return finish({ terrestrialModulation: mod });
  }
  // 表 7 / 9：干扰源是本地球站
  if (isNum(o.esPtDbW)) Pt = o.esPtDbW;
  else if (isNum(o.esPsdDbWPerHz)) Pt = o.esPsdDbWPerHz + 10 * LOG10(B);
  else return { error: '缺发射地球站功率（esPtDbW 或 esPsdDbWPerHz）' };
  if (isNum(col.Pr)) { Pr = col.Pr; PrSource = 'table'; } else {
    let Te = col.Te;
    if (!isNum(Te) && kind === 'bidirectional') { Te = bidirectionalNoiseTemperature(o.fGHz || col.bandsGHz[0][0]); warnings.push(`Te 缺值，按附件 7 表 6 取 ${Te} K`); }
    const r = permissibleInterferencePower({ TeK: Te, BHz: B, NLdB: col.NL, MsdB: col.Ms, WdB: col.W });
    if (!isNum(r)) return { error: `表 ${table} 该列无 Pr，且无法按式 (127) 计算：${r.error}` };
    Pr = r; PrSource = 'eq127';
  }
  if (kind === 'tx') {
    Gx = col.Gx;
    if (!isNum(Gx)) return { error: `表 ${table} 该列无 Gx` };
  } else {
    Gr = isNum(o.Gr) ? o.Gr : (isNum(col.Gr) ? col.Gr : null);
    if (Gr === null && col.grMethod) warnings.push('接收地球站为 GSO，Gr 须按附件 5 §2.1 逐方位计算');
  }
  return finish({});

  function finish(extra) {
    // RR AP7 §1.3 式 (1)/(4)/(6)：Lb = Pt + Gt + Gr − Pr；式 (3)：L = Pt − Pr；式 (2)：Lx = Pt + Gx − Pr
    const lb = (Ge, GrOverride) => {
      if (kind === 'bidirectional') {
        const g = isNum(GrOverride) ? GrOverride : Gr;
        return isNum(g) ? Pt + Ge + g - Pr : NaN;
      }
      return Pt + Ge + Gx - Pr;
    };
    const out = Object.assign({ kind, table, Pt, Pr, PrSource, Gx, Gr, p, B, L: Pt - Pr, Lx: isNum(Gx) ? Pt + Gx - Pr : null, lb, warnings }, extra);
    if (isNum(o.Ge)) out.LbDb = lb(o.Ge, o.Gr);
    return out;
  }
}

// ===========================================================================
// 正文 §1.6 / §2.1：协调等值线组装
// ===========================================================================

/**
 * 协调等值线：每个方位取模式 (1) 与模式 (2) 所需距离的较大者。RR AP7 正文 §1.6、§2.1（GSO）、§2.2（non-GSO TIG）。
 *
 * @param {object} o
 * @param {number} o.fGHz, o.p, o.latDeg
 * @param {number} [o.lonDeg]         给出则另输出等值线各点经纬度（球面，平均地球半径）
 * @param {'tx'|'rx'} o.esRole
 * @param {number} o.Pt               干扰发射机在参考带宽内的功率（dBW）：发射地球站为其自身功率，接收地球站为表 8 地面站 Pt
 * @param {number} o.Pr               容许干扰功率 Pr(p)（dBW，同一参考带宽）
 * @param {number} o.Gx               地面站天线增益（dBi）
 * @param {boolean} [o.correction=true] 固定业务修正（与移动业务协调时 false）
 * @param {Array<object>} o.azimuths  每个方位 { azDeg, horizonElevDeg?, horizonDistKm?, zones|zone, dcKm?, horizonGainDbi? }
 * @param {object} [o.esAntenna]      { GmaxDbi, dOverLambda?, pattern? }，用于附件 3 / 附件 4 地平线增益
 * @param {object} [o.gso]            { deltaLonDeg, inclinationDeg?=0, stepDeg? }：GSO 地球站，附件 3 求 Ge，并给模式 (2) 波束
 * @param {object} [o.nonGso]         { minElevDeg, visibility? }：non-GSO 跟踪天线，附件 4 + 式 (5) 求 Ge；模式 (2) 不算（§1.4.2）
 * @param {object|false} [o.mode2]    { rainZone|rainRateMmH, rainHeightKm?, rainHeightRegion?, beams? }；false 表示不需模式 (2)
 * @param {number} [o.stepKm=1]
 * @param {boolean} [o.siteShielding=true]
 * @returns {object} { azimuthsDeg, horizonGainDbi, lbDb, mode1Km, mode2Km, contourKm, governing, perAzimuth,
 *          mode2, dminKm, points?, warnings } 或 { error }
 */
function coordinationContour(o) {
  if (!o) return { error: '缺参数' };
  if (!Array.isArray(o.azimuths) || !o.azimuths.length) return { error: '缺方位列表 azimuths' };
  for (const k of ['fGHz', 'p', 'latDeg', 'Pt', 'Pr', 'Gx']) if (!isNum(o[k])) return { error: `缺 ${k}` };
  const warnings = [];
  const wset = new Set();
  const addW = (w) => { if (!wset.has(w)) { wset.add(w); warnings.push(w); } };

  // 1) 地平线增益 Ge(α)
  let Ge;
  const az = o.azimuths;
  if (az.every(a => isNum(a.horizonGainDbi))) {
    Ge = az.map(a => a.horizonGainDbi);
  } else if (o.gso) {
    const hg = ANT.horizonGainGso({ latDeg: o.latDeg, deltaLonDeg: o.gso.deltaLonDeg, inclinationDeg: o.gso.inclinationDeg,
      stepDeg: o.gso.stepDeg, antenna: o.esAntenna, horizon: az.map(a => ({ azDeg: a.azDeg, elevDeg: a.horizonElevDeg })) });
    if (hg.error) return { error: hg.error };
    hg.warnings.forEach(addW);
    Ge = hg.points.map((pt, k) => (isNum(az[k].horizonGainDbi) ? az[k].horizonGainDbi : pt.gainDbi));
  } else if (o.nonGso) {
    if (!isNum(o.nonGso.minElevDeg)) return { error: 'nonGso 缺 minElevDeg' };
    Ge = az.map(a => (isNum(a.horizonGainDbi) ? a.horizonGainDbi
      : ANT.nonGsoHorizonGain({ minElevDeg: o.nonGso.minElevDeg, azDeg: a.azDeg, horizonElevDeg: a.horizonElevDeg,
        antenna: o.esAntenna, visibility: o.nonGso.visibility }).GeDbi));
  } else {
    return { error: '缺地平线增益：每个方位给 horizonGainDbi，或给 gso / nonGso 配置' };
  }

  // 2) 模式 (1)：每方位 Lb = Pt + Ge + Gx − Pr（式 (4)）
  const perAzimuth = [];
  const lbDb = [], mode1Km = [];
  for (let k = 0; k < az.length; k++) {
    const a = az[k];
    const Lb = o.Pt + Ge[k] + o.Gx - o.Pr;
    const r = mode1RequiredDistance({ fGHz: o.fGHz, p: o.p, Lb, latDeg: o.latDeg, zones: a.zones !== undefined ? a.zones : a.zone,
      horizon: { elevDeg: a.horizonElevDeg, distKm: a.horizonDistKm }, dcKm: a.dcKm, esRole: o.esRole,
      correction: o.correction, stepKm: o.stepKm, siteShielding: o.siteShielding, seaZoneIfNoSea: o.seaZoneIfNoSea });
    if (r.error) return { error: `方位 ${a.azDeg}°：${r.error}` };
    r.warnings.forEach(addW);
    lbDb.push(Lb);
    mode1Km.push(r.distanceKm);
    perAzimuth.push({ azDeg: a.azDeg, horizonGainDbi: Ge[k], lbDb: Lb, mode1: r });
  }
  const dminKm = perAzimuth[0].mode1.dminKm;

  // 3) 模式 (2)：L = Pt − Pr（式 (3)），Gx 在式 (82) 内；non-GSO 跟踪天线不算（§1.4.2）
  let mode2 = null, mode2Km = az.map(() => dminKm);
  if (o.mode2 && !o.nonGso) {
    let beams = o.mode2.beams;
    if (!beams && o.gso) beams = ANT.gsoExtremeBeams(o.latDeg, o.gso.deltaLonDeg, o.gso.inclinationDeg);
    const c = mode2Contour(Object.assign({}, o.mode2, { fGHz: o.fGHz, p: o.p, latDeg: o.latDeg, L: o.Pt - o.Pr, Gx: o.Gx,
      beams, azimuthsDeg: az.map(a => a.azDeg), stepKm: o.stepKm }));
    if (c.error) return { error: `模式 (2)：${c.error}` };
    c.warnings.forEach(addW);
    mode2 = { distanceKm: c.mode2.distanceKm, stoppedBy: c.mode2.stoppedBy, circles: c.circles, detail: c.mode2 };
    mode2Km = c.distancesKm;
  }

  // 4) 等值线 = 两者较大者（§1.6、§2.1）
  const contourKm = mode1Km.map((d1, k) => Math.max(d1, mode2Km[k]));
  const governing = mode1Km.map((d1, k) => (d1 >= mode2Km[k] ? 'mode1' : 'mode2'));
  perAzimuth.forEach((pa, k) => { pa.mode2Km = mode2Km[k]; pa.contourKm = contourKm[k]; pa.governing = governing[k]; });
  const out = { azimuthsDeg: az.map(a => a.azDeg), horizonGainDbi: Ge, lbDb, mode1Km, mode2Km, contourKm, governing,
    perAzimuth, mode2, dminKm, L: o.Pt - o.Pr, warnings };
  if (isNum(o.lonDeg)) out.points = contourToLatLon(o.latDeg, o.lonDeg, out.azimuthsDeg, contourKm);
  return out;
}

/**
 * 把「方位—距离」等值线换成经纬度点（球面大圆，平均地球半径 6371 km）。AP7 本身不规定，仅供落图。
 */
function contourToLatLon(latDeg, lonDeg, azimuthsDeg, distancesKm) {
  const p1 = latDeg * D2R, l1 = lonDeg * D2R;
  return azimuthsDeg.map((a, k) => {
    const dr = distancesKm[k] / MEAN_EARTH_RADIUS_KM, th = a * D2R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
    return { azDeg: a, distKm: distancesKm[k], latDeg: p2 / D2R, lonDeg: ((l2 / D2R + 540) % 360) - 180 };
  });
}

// ===========================================================================
// 附件 5 §3：双向频段雨散射区（几何作图）
// ===========================================================================

/** 平面点集凸包（Andrew 单调链），逆时针。 */
function convexHull(pts) {
  const s = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  if (s.length < 3) return s;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const p of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let k = s.length - 1; k >= 0; k--) { const p = s[k]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/** 自原点沿单位向量 (ux, uy) 的射线与凸多边形边界的交点距离（原点须在多边形内）。 */
function rayExitDistance(poly, ux, uy) {
  let best = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (a.x * ey - a.y * ex) / den;          // 射线参数
    const u = (a.x * uy - a.y * ux) / den;          // 边参数
    if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && t > best) best = t;
  }
  return best;
}

/**
 * 双向频段 GSO–GSO 情形的模式 (2) 雨散射区。RR AP7 正文 §3.1.2 + 附件 5 §3（判断 15）。
 * @param {object} o
 * @param {number} o.fGHz, o.latDeg
 * @param {number} o.esElevDeg      发射地球站最低仰角 εs
 * @param {number} o.esAzDeg        对应方位 αs
 * @param {number} o.minElevDeg     未知接收地球站最低仰角 εmin（表 9）
 * @param {number} [o.rainHeightKm], [o.rainHeightRegion]
 * @param {number[]} [o.azimuthsDeg] 输出方位，缺省 0–355 步长 5°
 * @param {number} [o.arcStepDeg=0.05] 弧与圆的折线化步长
 * @returns {{azimuthsDeg, distancesKm, circleOnly:boolean, dminKm, hRKm, dsKm, demaxKm, zetaMaxDeg, alphaW1Deg, alphaW2Deg,
 *            pointII:{xKm,yKm}, warnings}}
 */
function bidirectionalRainScatterArea(o) {
  if (!o || !isNum(o.fGHz) || !isNum(o.latDeg) || !isNum(o.esElevDeg) || !isNum(o.esAzDeg) || !isNum(o.minElevDeg)) {
    return { error: '缺频率、纬度、发射站仰角 / 方位或接收站最低仰角' };
  }
  if (!(o.esElevDeg > 0)) return { error: '发射站仰角应大于 0°' };
  const warnings = [];
  const azs = Array.isArray(o.azimuthsDeg) ? o.azimuthsDeg : Array.from({ length: 72 }, (_, k) => k * 5);
  const { dminKm } = minCoordinationDistance(o.fGHz, o.latDeg);
  const hr = isNum(o.rainHeightKm) ? { hR: Math.max(0, o.rainHeightKm), warnings: [] } : rainHeight(o.latDeg, o.rainHeightRegion);
  warnings.push(...hr.warnings);
  const hR = hr.hR;
  const te = Math.tan(o.esElevDeg * D2R);
  // RR AP7 附件 5 §3 式 (104)：ds = 8 500 (√(tan²εs + hR/4 250) − tan εs)
  const ds = 8500 * (Math.sqrt(te * te + hR / 4250) - te);
  // RR AP7 附件 5 §3：demax = 130.4 √hR 与 dmin 的较大者
  const demaxRaw = 130.4 * Math.sqrt(hR);
  const demax = Math.max(demaxRaw, dminKm);
  // RR AP7 附件 5 §3 式 (105)：ζmax = arccos(cos εmin / K) − εmin
  const zmax = Math.acos(Math.cos(o.minElevDeg * D2R) / ANT.K_GSO) / D2R - o.minElevDeg;
  const base = { dminKm, hRKm: hR, dsKm: ds, demaxKm: demax, demaxRawKm: demaxRaw, zetaMaxDeg: zmax, azimuthsDeg: azs.slice(), warnings };
  const z = o.latDeg;
  // 圆形情形：demax 不大于 dmin；北半球 ζ > ζmax；南半球 ζ < −ζmax 或 < −71°
  if (!(demaxRaw > dminKm) || z > zmax || z < -zmax || z < -71) {
    return Object.assign(base, { circleOnly: true, distancesKm: azs.map(() => dminKm), alphaW1Deg: null, alphaW2Deg: null, pointII: null });
  }
  // RR AP7 附件 5 §3 Step 1：αw1 = arccos(tan ζ / tan ζmax)，αw2 = 360° − αw1
  const aw1 = Math.acos(Math.tan(z * D2R) / Math.tan(zmax * D2R)) / D2R;
  const aw2 = 360 - aw1;
  // Step 2：点 II 在地球站方位 αs、距离 ds 处（x 东、y 北，km）
  const II = { x: ds * Math.sin(o.esAzDeg * D2R), y: ds * Math.cos(o.esAzDeg * D2R) };
  const step = o.arcStepDeg > 0 ? o.arcStepDeg : 0.05;
  const disc = [];
  for (let a = 0; a < 360; a += step * 10) disc.push({ x: dminKm * Math.sin(a * D2R), y: dminKm * Math.cos(a * D2R) });
  // Step 3/4：以 II 为圆心、demax 为半径、αw ± 3° 的两段弧；各自与 dmin 圆取凸包
  const hulls = [aw1, aw2].map(aw => {
    const pts = disc.slice();
    for (const a of ANT._internal.sampleClosed(aw - 3, aw + 3, step)) pts.push({ x: II.x + demax * Math.sin(a * D2R), y: II.y + demax * Math.cos(a * D2R) });
    return convexHull(pts);
  });
  const distancesKm = azs.map(a => {
    const ux = Math.sin(a * D2R), uy = Math.cos(a * D2R);
    return Math.max(dminKm, ...hulls.map(h => rayExitDistance(h, ux, uy)));
  });
  return Object.assign(base, { circleOnly: false, distancesKm, alphaW1Deg: aw1, alphaW2Deg: aw2, pointII: { xKm: II.x, yKm: II.y } });
}

// ===========================================================================
// 附件 6：辅助等值线与 TVG 补充等值线
// ===========================================================================

/**
 * 模式 (2) 辅助等值线（给定地面站主波束回避角 φ）。RR AP7 附件 6 §3.2.2 式 (106)–(110)。
 * @param {object} o
 * @param {object} o.mode2Options     mode2RequiredDistance 的参数（主或补充等值线）
 * @param {number} o.beamElevDeg      地球站主波束仰角 εs（求 b/2 = Δd）
 * @param {number} o.beamAvoidanceDeg 回避角 φ（°）
 * @param {object|function} [o.terrestrialAntenna] { GmaxDbi = Gx, dOverLambda? } 用附件 6 §3.2.3 方向图，或函数 G(υ)
 * @param {number} [o.rbStepKm=0.2]   rb 步长（原文 0.2 km）
 * @param {number} [o.omegaStepDeg=1]
 * @returns {{points:Array<{omegaDeg, rbKm, dKm, thetaDeg, status}>, bKm, drKm, dminKm, warnings} | {error}}
 *   thetaDeg = 自地球站、相对主波束方位的角度 θd（对称：ω 与 360° − ω 相同）
 */
function mode2AuxiliaryContour(o) {
  if (!o || !o.mode2Options || !isNum(o.beamElevDeg) || !isNum(o.beamAvoidanceDeg)) return { error: '缺模式 (2) 参数、波束仰角或回避角' };
  const m2 = mode2RequiredDistance(o.mode2Options);
  if (m2.error) return m2;
  const s = m2._setup;
  if (m2.neglected) return { error: '本例雨散射可忽略，无辅助等值线' };
  const dr = m2.distanceKm, dmin = m2.dminKm;
  // RR AP7 附件 6 §3.2.2：b/2 = Δd（附件 2 式 (83)）
  const b = 2 * mode2CentreOffset(m2.hRKm, o.beamElevDeg, dr).deltaDKm;
  const phi = o.beamAvoidanceDeg;
  const ta = o.terrestrialAntenna;
  const G = typeof ta === 'function' ? ta : (u) => ANT.radioRelayReferencePattern(u, { GmaxDbi: (ta && isNum(ta.GmaxDbi)) ? ta.GmaxDbi : s.Gx, dOverLambda: ta && ta.dOverLambda });
  const rStep = o.rbStepKm > 0 ? o.rbStepKm : 0.2;
  const wStep = o.omegaStepDeg > 0 ? o.omegaStepDeg : 1;
  const psiOf = (rb, w) => {
    const sw = Math.sin(w * D2R), cw = Math.cos(w * D2R);
    // RR AP7 附件 6 式 (106)(107)(108)：ψ1 = arctan[b sin ω / (2rb − b cos ω)]，ψ2 = arctan[b sin ω / (2rb + b cos ω)]，ψ = ψ1 + ψ2
    const p1 = Math.atan2(b * sw, 2 * rb - b * cw) / D2R;
    const p2 = Math.atan2(b * sw, 2 * rb + b * cw) / D2R;
    return { p1, p2, psi: p1 + p2 };
  };
  // RR AP7 附件 6 式 (109)(110)：d = 0.5 b sin ω / sin ψ2，θd = ω − ψ2；ω = 0°/180° 时取极限 rb ± b/2
  const dTheta = (rb, w, p2) => {
    if (Math.abs(Math.sin(w * D2R)) < 1e-12 || b === 0) return { d: rb + (Math.cos(w * D2R) >= 0 ? 0.5 * b : -0.5 * b), theta: Math.cos(w * D2R) >= 0 ? 0 : 180 };
    return { d: 0.5 * b * Math.sin(w * D2R) / Math.sin(p2 * D2R), theta: w - p2 };
  };
  const points = [];
  for (let w = 0; w <= 180 + 1e-9; w += wStep) {
    let rb = dr;                                                   // 步骤 a)
    let ang = psiOf(rb, w);                                        // 步骤 b)
    let status;
    if (ang.psi > phi) status = 'main';                            // 步骤 c)：与主（补充）等值线重合
    else {
      for (;;) {
        rb -= rStep;                                               // 步骤 d)
        ang = psiOf(rb, w);                                        // 步骤 e)
        const dt = dTheta(rb, w, ang.p2);
        if (dt.d < dmin) { status = 'dmin'; break; }               // 步骤 f)：与 dmin 圆重合
        const u = phi - ang.psi;                                   // 步骤 g)：保护角 υ = φ − ψ
        const Lr = mode2PathLoss(s, rb, G(u)).lossDb;              // 步骤 h)(i)：G(υ) 代替 Gx、rb 代替 ri
        if (Lr < s.L) { rb += rStep; ang = psiOf(rb, w); status = 'loss'; break; }
      }
    }
    const dt = status === 'dmin' ? { d: dmin, theta: dTheta(rb, w, ang.p2).theta } : dTheta(rb, w, ang.p2);
    points.push({ omegaDeg: w, rbKm: rb, dKm: dt.d, thetaDeg: dt.theta, status });   // 步骤 j)
  }
  return { points, bKm: b, drKm: dr, dminKm: dmin, beamAvoidanceDeg: phi, warnings: m2.warnings };
}

/**
 * TVG 法补充等值线距离（non-GSO 地球站的时变地平线增益）。RR AP7 附件 6 §4.2 式 (123)–(126)。
 * @param {object} o
 * @param {object} o.mode1Options    mode1RequiredDistance 的参数（Lb、p 会被逐档替换）
 * @param {number} o.Pt, o.Gx, o.Pr  式 (126) 的 Pt、Gx、Pr(p)
 * @param {number} o.p               Pr(p) 对应的时间百分比
 * @param {function(number):number|Array<{gainDbi:number, pPercent:number}>} o.gainCcdf 地平线增益超过 G 的时间百分比 pn(G)
 * @param {number} o.GminDbi, o.GmaxDbi 该方位地平线增益最小 / 最大值
 * @param {number} [o.gStepDb=0.5]   增益步长 g（原文推荐 0.1–0.5 dB）
 * @returns {{distanceKm, governedBy, steps:Array<{GenDbi, pn, pv, LbnDb, dnKm}>, warnings} | {error}}
 */
function tvgRequiredDistance(o) {
  if (!o || !o.mode1Options) return { error: '缺模式 (1) 参数' };
  for (const k of ['Pt', 'Gx', 'Pr', 'p', 'GminDbi', 'GmaxDbi']) if (!isNum(o[k])) return { error: `缺 ${k}` };
  const g = o.gStepDb > 0 ? o.gStepDb : 0.5;
  const ccdf = typeof o.gainCcdf === 'function' ? o.gainCcdf : interpCcdf(o.gainCcdf);
  if (!ccdf) return { error: '缺地平线增益互补累积分布 gainCcdf' };
  const steps = [], warnings = [];
  const run = (Lb, pv) => mode1RequiredDistance(Object.assign({}, o.mode1Options, { Lb, p: pv }));
  for (let n = 1; ; n++) {
    // RR AP7 附件 6 式 (124)：Gen = Gmin + (n − 1) g
    const Gen = o.GminDbi + (n - 1) * g;
    if (Gen > o.GmaxDbi + 1e-9) break;
    const pn = ccdf(Gen);
    if (!(pn >= 2 * o.p)) continue;                                // 步骤 2：只取 pn ≥ 2p
    // RR AP7 附件 6 式 (125)：pv = 100 p / pn（%）
    const pv = 100 * o.p / pn;
    // RR AP7 附件 6 式 (126)：Lbn(pv) = Pt + Gen + Gx − Pr(p)
    const Lbn = o.Pt + Gen + o.Gx - o.Pr;
    const r = run(Lbn, pv);
    if (r.error) return r;
    r.warnings.forEach(w => { if (!warnings.includes(w)) warnings.push(w); });
    steps.push({ GenDbi: Gen, pn, pv, LbnDb: Lbn, dnKm: r.distanceKm, dminKm: r.dminKm, dmax1Km: r.dmax1Km });
  }
  if (!steps.length) return { error: '没有满足 pn ≥ 2p 的增益档' };
  // 步骤 3：取最大 dn；若最大者出现在满足 pn ≥ 2p 的最小 pn 处，改用 Gen = Gmax、pv = 50% 的距离
  let iMax = 0;
  steps.forEach((st, k) => { if (st.dnKm > steps[iMax].dnKm) iMax = k; });
  let iMinPn = 0;
  steps.forEach((st, k) => { if (st.pn < steps[iMinPn].pn) iMinPn = k; });
  let distanceKm = steps[iMax].dnKm, governedBy = 'max-dn';
  if (iMax === iMinPn) {
    const r = run(o.Pt + o.GmaxDbi + o.Gx - o.Pr, 50);
    if (r.error) return r;
    distanceKm = r.distanceKm; governedBy = 'gmax-p50';
  }
  // 步骤 4：限定在 [dmin, dmax1]（模式 (1) 迭代本身已保证）
  return { distanceKm, governedBy, steps, warnings };
}

function interpCcdf(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const s = arr.slice().sort((a, b) => a.gainDbi - b.gainDbi);
  return (G) => {
    if (G <= s[0].gainDbi) return s[0].pPercent;
    if (G >= s[s.length - 1].gainDbi) return s[s.length - 1].pPercent;
    let k = 1;
    while (s[k].gainDbi < G) k++;
    const a = s[k - 1], b = s[k];
    return a.pPercent + (G - a.gainDbi) / (b.gainDbi - a.gainDbi) * (b.pPercent - a.pPercent);
  };
}

// ===========================================================================
// 表 10 注 1：气象卫星接收地球站对无线电探空仪的预定协调距离
// ===========================================================================

/** RR AP7 附件 7 表 10 注 1：d = 100（εh ≥ 11°）；582[√(1 + (0.254 εh)²) − 0.254 εh]（0° < εh < 11°）；582（εh ≤ 0°）。 */
function predeterminedDistanceMetAids(horizonElevDeg) {
  const e = Number(horizonElevDeg);
  if (e >= 11) return 100;
  if (e <= 0) return 582;
  const x = 0.254 * e;
  return 582 * (Math.sqrt(1 + x * x) - x);
}

module.exports = {
  // 常数
  K_BOLTZMANN_AP7, CORRECTION_FULL_KM,
  // 正文 §4
  radioClimate, minCoordinationDistance, mode1MaxDistance, nominalCorrection, correctionConstant,
  // 附件 1
  siteShielding, gammaOxygen, gammaWater, gammaOxygenMm, gammaWaterMm, mode1Model,
  mode1Setup, mode1RequiredDistance, mode1PathLoss, normalizeZones, pathStats,
  // 附件 2
  rainRate, rainHeight, rainKAlpha, mode2Setup, mode2PathLoss, mode2RequiredDistance, mode2CentreOffset,
  mode2DistanceAtAzimuth, mode2Contour,
  // 附件 3/4/5/6 天线（转出）
  gsoLookAngles: ANT.gsoLookAngles, offAxisToHorizon: ANT.offAxisToHorizon, horizonOffAxisGso: ANT.horizonOffAxisGso,
  annex3PatternParams: ANT.annex3PatternParams, esReferencePattern: ANT.esReferencePattern, horizonGainGso: ANT.horizonGainGso,
  gsoExtremeBeams: ANT.gsoExtremeBeams, tigHorizonGain: ANT.tigHorizonGain, nonGsoHorizonSeparation: ANT.nonGsoHorizonSeparation,
  constellationVisibility: ANT.constellationVisibility, separationFromProfile: ANT.separationFromProfile,
  nonGsoHorizonGain: ANT.nonGsoHorizonGain, bidirectionalReceiverHorizonGain: ANT.bidirectionalReceiverHorizonGain,
  table9bAltPattern: ANT.table9bAltPattern, radioRelayReferencePattern: ANT.radioRelayReferencePattern,
  // 附件 5 §3、附件 6
  bidirectionalRainScatterArea, mode2AuxiliaryContour, tvgRequiredDistance,
  // 附件 7 §2、正文 §1.3
  noiseTemperature, bidirectionalNoiseTemperature, permissibleInterferencePower,
  requiredLossMode1, requiredLossMode2, requiredLoss,
  // 组装与工具
  coordinationContour, contourToLatLon, predeterminedDistanceMetAids,
  // 表（转出）
  TABLE_3: T.TABLE_3, TABLE_4: T.TABLE_4, TABLE_5: T.TABLE_5, TABLE_6: T.TABLE_6,
  TABLE_7: T.TABLE_7, TABLE_8: T.TABLE_8, TABLE_9: T.TABLE_9, TABLE_10: T.TABLE_10,
  PARAMETER_TABLES: T.PARAMETER_TABLES, findColumns: T.findColumns
};
