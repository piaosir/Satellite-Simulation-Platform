// RR 附录 7（Rev.WRC-23）· 地球站地平线天线增益与相关几何
//
// 依据：ITU《无线电规则》2024 年版第 2 卷附录 7（来源与校验和见 ap7Tables.js / ap7.js 头注）。
// 本文件覆盖：
//   · 附件 3  GSO 地球站：主波束与物理地平线的最小夹角 φ(α)（§2 式 (84)–(96)，含倾斜轨道 Case 2）
//             与参考方向图（§3 式 (97)），据此得每个方位的地平线增益；
//   · 正文 §2.2 式 (5)  TIG（时不变增益）取值规则；
//   · 附件 4  non-GSO 地球站：§1 最小/最大分离角、§1.1 星座可见性下限（Case 1–6，式 (98)–(101)）、
//             §1.2 由最小合成仰角剖面求 φmin/φmax（式 (102)）；
//   · 附件 5 §2.1  双向频段中未知 GSO 接收地球站在各方位的地平线增益（式 (103) + 附件 3 Case 1）；
//   · 附件 6 §3.2.3  视距中继天线参考方向图（式 (111)–(122)，供模式 (2) 辅助等值线用）。
//
// 坐标约定（全文件一致）：
//   方位角 α：自北顺时针 0–360°；纬度 ζ：北正南负；δ：卫星（或星下点）经度 − 地球站经度，东正西负；
//   仰角、离轴角均以度计；所有反三角函数的自变量先截断到 [−1, 1]，避免舍入误差产生 NaN。
//
// 判断与取舍（均在对应函数处再注一次）：
//   · 附件 3 Case 2 的 i、δ 步长按原文「0.5°–1.0°，含端点」，缺省 0.5°；δs = (is/15)² 往往远小于
//     步长，此时区间只取两端点——这正是原文「含端点」的效果。
//   · 参考方向图 (97) 若 φm > φr（Gamax 与 D/λ 不自洽时可能出现），按分段先后取值，G1 段为空。
//   · 附件 6 式 (119) 用到的 G1 原文只在 a) 小节式 (115) 定义（2 + 15 lg D/λ），b) 小节沿用之
//     （与 ITU-R F.699 一致，且在 φ = 100λ/D 处与 (120) 连续）。
//   · 表 9b 脚注 10 的替代方向图只定义了 1° ≤ φ < 180°；φ < 1° 时取 1° 处的值 32 dBi（附件 5 中
//     φ ≥ εmin ≥ 3°，实际不会用到）。
//
// 纯函数、无依赖，CommonJS。

'use strict';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const LOG10 = Math.log10;

/** 附件 3 §2 / 附件 5 式 (103)(105)：GSO 轨道半径 / 地球半径，原文取 6.62。 */
const K_GSO = 6.62;
/** 附件 4 §1.1：K1 定义中的地球半径（km）。 */
const EARTH_RADIUS_ANNEX4_KM = 6378.14;

function clampUnit(x) { return x > 1 ? 1 : (x < -1 ? -1 : x); }
function sind(a) { return Math.sin(a * D2R); }
function cosd(a) { return Math.cos(a * D2R); }
function tand(a) { return Math.tan(a * D2R); }
function acosd(x) { return Math.acos(clampUnit(x)) * R2D; }
function asind(x) { return Math.asin(clampUnit(x)) * R2D; }
function wrap360(a) { const x = a % 360; return x < 0 ? x + 360 : x; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/** [a, b] 上间距不超过 step 的等距采样，含两端点（附件 3 §2、附件 4 §1.1、附件 5 §2.1 均要求含端点）。 */
function sampleClosed(a, b, step) {
  if (!(b > a)) return [a];
  const n = Math.max(1, Math.ceil((b - a) / step - 1e-12));
  const out = new Array(n + 1);
  for (let k = 0; k <= n; k++) out[k] = a + (b - a) * k / n;
  return out;
}

// ===========================================================================
// 附件 3 §2：GSO 卫星（含倾斜轨道星下点）的视角几何
// ===========================================================================

/**
 * 地球站看星下点纬度 i、经差 δ 的卫星：大圆角 ψs、仰角 εs、方位 αs。
 * @param {number} latDeg      地球站纬度 ζ（°）
 * @param {number} subSatLatDeg 星下点纬度 i（°），静止轨道无倾角时为 0
 * @param {number} deltaLonDeg  δ = 卫星经度 − 地球站经度（°，东正）
 * @param {number} [K=6.62]    轨道半径 / 地球半径
 * @returns {{psiDeg:number, elevDeg:number, azDeg:number}}
 */
function gsoLookAngles(latDeg, subSatLatDeg, deltaLonDeg, K) {
  const k = isNum(K) ? K : K_GSO;
  const z = latDeg, i = subSatLatDeg, d = deltaLonDeg;
  // RR AP7 附件 3 §2 式 (84)：ψs(i,δ) = arccos(sin ζ sin i + cos ζ cos i cos δ)
  const cpsi = clampUnit(sind(z) * sind(i) + cosd(z) * cosd(i) * cosd(d));
  const psi = Math.acos(cpsi) * R2D;
  // RR AP7 附件 3 §2 式 (85)：εs = arcsin[(K cos ψs − 1) / (1 + K² − 2K cos ψs)^½]
  const elev = asind((k * cpsi - 1) / Math.sqrt(1 + k * k - 2 * k * cpsi));
  // RR AP7 附件 3 §2 式 (86)：α0s = arccos[(sin i − cos ψs sin ζ) / (sin ψs cos ζ)]
  const den = Math.sin(psi * D2R) * cosd(z);
  const a0 = Math.abs(den) < 1e-12 ? 0 : acosd((sind(i) - cpsi * sind(z)) / den);   // 星下点即站址时方位无意义，取 0
  // RR AP7 附件 3 §2 式 (87)(88)：δ ≥ 0（星在站东）αs = α0s；δ ≤ 0（站西）αs = 360° − α0s
  const az = d >= 0 ? a0 : wrap360(360 - a0);
  return { psiDeg: psi, elevDeg: elev, azDeg: az };
}

/**
 * 主波束指向（仰角 εs、方位 αs）与方位 α 处物理地平线（仰角 εh）之间的夹角 φ。
 * RR AP7 附件 3 §2 式 (89)；附件 4 式 (102) 是同一球面余弦关系。
 */
function offAxisToHorizon(azDeg, horizonElevDeg, beamAzDeg, beamElevDeg) {
  // RR AP7 附件 3 §2 式 (89)：φ = arccos[cos εh cos εs cos(α − αs) + sin εh sin εs]
  return acosd(cosd(horizonElevDeg) * cosd(beamElevDeg) * cosd(azDeg - beamAzDeg)
    + sind(horizonElevDeg) * sind(beamElevDeg));
}

/**
 * 附件 3 §2：方位 α 处的 φ(α)。is = 0 走 Case 1（式 (90)），is > 0 走 Case 2（式 (91)–(96)）。
 * @param {object} o
 * @param {number} o.latDeg          地球站纬度 ζ
 * @param {number} o.deltaLonDeg     名义经差 δ0（卫星 − 站，东正）
 * @param {number} [o.inclinationDeg=0] 最大工作轨道倾角 is
 * @param {number} o.azDeg           所考虑方位 α
 * @param {number} [o.horizonElevDeg=0] 该方位物理地平线仰角 εh
 * @param {number} [o.stepDeg=0.5]   Case 2 中 i、δ 的步长（原文 0.5°–1.0°）
 * @returns {{phiDeg:number, case:1|2, deltaSDeg:number, phiParts:number[]|null,
 *            at:{subSatLatDeg:number, deltaLonDeg:number, elevDeg:number, azDeg:number}, minSatElevDeg:number}}
 */
function horizonOffAxisGso(o) {
  const z = o.latDeg, d0 = o.deltaLonDeg, a = o.azDeg;
  const eh = isNum(o.horizonElevDeg) ? o.horizonElevDeg : 0;
  const is = isNum(o.inclinationDeg) ? Math.abs(o.inclinationDeg) : 0;
  const step = o.stepDeg > 0 ? o.stepDeg : 0.5;
  let best = null, minElev = Infinity;
  const consider = (i, d) => {
    const s = gsoLookAngles(z, i, d);
    const phi = offAxisToHorizon(a, eh, s.azDeg, s.elevDeg);
    if (s.elevDeg < minElev) minElev = s.elevDeg;
    if (!best || phi < best.phi) best = { phi, i, d, s };
    return phi;
  };
  if (!(is > 0)) {
    // RR AP7 附件 3 §2 Case 1 式 (90)：φ(α) = φ(α, 0, δ0)
    consider(0, d0);
    return { phiDeg: best.phi, case: 1, deltaSDeg: 0, phiParts: null,
      at: { subSatLatDeg: 0, deltaLonDeg: d0, elevDeg: best.s.elevDeg, azDeg: best.s.azDeg }, minSatElevDeg: minElev };
  }
  // RR AP7 附件 3 §2 式 (96)：δs = (is / 15)²
  const ds = Math.pow(is / 15, 2);
  const dRange = sampleClosed(d0 - ds, d0 + ds, step);
  const iRange = sampleClosed(-is, is, step);
  const minOver = (pairs) => pairs.reduce((m, [i, d]) => Math.min(m, consider(i, d)), Infinity);
  // RR AP7 附件 3 §2 式 (92)：φ1 = min φ(α, −is, δ)，δ0 − δs ≤ δ ≤ δ0 + δs
  const p1 = minOver(dRange.map(d => [-is, d]));
  // RR AP7 附件 3 §2 式 (93)：φ2 = min φ(α, +is, δ)
  const p2 = minOver(dRange.map(d => [is, d]));
  // RR AP7 附件 3 §2 式 (94)：φ3 = min φ(α, i, δ0 − δs)，−is ≤ i ≤ is
  const p3 = minOver(iRange.map(i => [i, d0 - ds]));
  // RR AP7 附件 3 §2 式 (95)：φ4 = min φ(α, i, δ0 + δs)
  const p4 = minOver(iRange.map(i => [i, d0 + ds]));
  // RR AP7 附件 3 §2 式 (91)：φ(α) = min φn(α)，n = 1…4
  return { phiDeg: Math.min(p1, p2, p3, p4), case: 2, deltaSDeg: ds, phiParts: [p1, p2, p3, p4],
    at: { subSatLatDeg: best.i, deltaLonDeg: best.d, elevDeg: best.s.elevDeg, azDeg: best.s.azDeg }, minSatElevDeg: minElev };
}

// ===========================================================================
// 附件 3 §3：地球站参考方向图（D/λ ≥ 35）
// ===========================================================================

/**
 * 参考方向图 (97) 的派生参数。
 * @param {number} GmaxDbi      主波束轴向增益 Gamax（dBi）
 * @param {number} [dOverLambda] D/λ；缺省按「20 lg(D/λ) ≈ Gamax − 7.7」估算
 * @returns {{GmaxDbi:number, dOverLambda:number, dOverLambdaEstimated:boolean, G1:number, phiM:number, phiR:number, warnings:string[]}}
 */
function annex3PatternParams(GmaxDbi, dOverLambda) {
  const warnings = [];
  let dl = Number(dOverLambda), estimated = false;
  if (!(dl > 0)) {
    // RR AP7 附件 3 §3：D/λ 未给时 20 lg(D/λ) ≈ Gamax − 7.7
    dl = Math.pow(10, (GmaxDbi - 7.7) / 20);
    estimated = true;
  }
  if (dl < 35) warnings.push(`D/λ = ${dl.toFixed(1)}，低于附件 3 §3 参考方向图适用下限 35`);
  // RR AP7 附件 3 §3 式 (97)：G1 = −1 + 15 lg(D/λ)（D/λ ≥ 100）；−21 + 25 lg(D/λ)（35 ≤ D/λ < 100）
  const G1 = dl >= 100 ? -1 + 15 * LOG10(dl) : -21 + 25 * LOG10(dl);
  // RR AP7 附件 3 §3 式 (97)：φr = 15.85 (D/λ)^−0.6（D/λ ≥ 100）；100 λ/D（35 ≤ D/λ < 100）
  const phiR = dl >= 100 ? 15.85 * Math.pow(dl, -0.6) : 100 / dl;
  const diff = GmaxDbi - G1;
  if (!(diff > 0)) warnings.push(`Gamax = ${GmaxDbi} dBi 不高于第一旁瓣 G1 = ${G1.toFixed(2)} dBi，主瓣段为空`);
  // RR AP7 附件 3 §3 式 (97)：φm = (20 λ / D) √(Gamax − G1)
  const phiM = diff > 0 ? (20 / dl) * Math.sqrt(diff) : 0;
  return { GmaxDbi, dOverLambda: dl, dOverLambdaEstimated: estimated, G1, phiM, phiR, warnings };
}

/**
 * 附件 3 §3 式 (97) 参考方向图 G(φ)（dBi）。
 * @param {number} phiDeg 离轴角（°），取绝对值，0–180
 * @param {object} params annex3PatternParams 的返回值，或 { GmaxDbi, dOverLambda? }
 */
function esReferencePattern(phiDeg, params) {
  const pp = params && isNum(params.G1) ? params : annex3PatternParams(params.GmaxDbi, params.dOverLambda);
  const phi = Math.min(180, Math.abs(phiDeg));
  // RR AP7 附件 3 §3 式 (97) 第 1 段：Gamax − 2.5×10⁻³ (D φ / λ)²，0 < φ < φm
  if (phi < pp.phiM) return pp.GmaxDbi - 2.5e-3 * Math.pow(pp.dOverLambda * phi, 2);
  // 第 2 段：G1，φm ≤ φ < φr
  if (phi < pp.phiR) return pp.G1;
  // 第 3 段：29 − 25 lg φ，φr ≤ φ < 36°
  if (phi < 36) return 29 - 25 * LOG10(phi);
  // 第 4 段：−10，36° ≤ φ ≤ 180°
  return -10;
}

/**
 * 附件 3 全流程：给地平线剖面，求每个方位的 φ(α) 与地平线增益 G(φ(α))。
 * @param {object} o
 * @param {number} o.latDeg, o.deltaLonDeg, [o.inclinationDeg=0], [o.stepDeg=0.5]
 * @param {Array<{azDeg:number, elevDeg?:number}>} o.horizon 各方位的地平线仰角（原文要求方位步长 ≤ 5°）
 * @param {{GmaxDbi:number, dOverLambda?:number, pattern?:function(number):number}} o.antenna
 *        pattern 若给出则作为「实测/更好的方向图」替代 (97)（附件 3 §3 允许）
 * @returns {{points:Array<{azDeg, horizonElevDeg, phiDeg, gainDbi, case}>, pattern:object|null,
 *            nominal:{elevDeg, azDeg}, warnings:string[]} | {error:string}}
 */
function horizonGainGso(o) {
  if (!o || !isNum(o.latDeg) || !isNum(o.deltaLonDeg)) return { error: '缺地球站纬度或卫星经差' };
  if (!Array.isArray(o.horizon) || !o.horizon.length) return { error: '缺地平线剖面' };
  const ant = o.antenna || {};
  const custom = typeof ant.pattern === 'function' ? ant.pattern : null;
  if (!custom && !isNum(ant.GmaxDbi)) return { error: '缺地球站天线轴向增益 GmaxDbi' };
  const pp = custom ? null : annex3PatternParams(ant.GmaxDbi, ant.dOverLambda);
  const warnings = pp ? pp.warnings.slice() : [];
  const nominal = gsoLookAngles(o.latDeg, 0, o.deltaLonDeg);
  if (!(nominal.elevDeg > 0)) warnings.push(`名义星位仰角 ${nominal.elevDeg.toFixed(2)}°，不在地平线以上`);
  let minElev = Infinity;
  const points = o.horizon.map(h => {
    const r = horizonOffAxisGso({ latDeg: o.latDeg, deltaLonDeg: o.deltaLonDeg, inclinationDeg: o.inclinationDeg,
      azDeg: h.azDeg, horizonElevDeg: isNum(h.elevDeg) ? h.elevDeg : 0, stepDeg: o.stepDeg });
    if (r.minSatElevDeg < minElev) minElev = r.minSatElevDeg;
    const g = custom ? custom(r.phiDeg) : esReferencePattern(r.phiDeg, pp);
    return { azDeg: h.azDeg, horizonElevDeg: isNum(h.elevDeg) ? h.elevDeg : 0, phiDeg: r.phiDeg, gainDbi: g, case: r.case };
  });
  if (o.inclinationDeg > 0 && minElev < 0) warnings.push(`倾斜轨道包络最低点仰角 ${minElev.toFixed(2)}°，低于地平线`);
  return { points, pattern: pp, nominal: { elevDeg: nominal.elevDeg, azDeg: nominal.azDeg }, warnings };
}

/**
 * 模式 (2) 所用的地球站主波束指向。正文 §2.1.2：倾斜轨道时分别对卫星「两个最极端的轨道位置」作雨散射等值线，
 * 取两者之并。这里取星下点纬度 +is、−is、经差 δ0 两点（仰角的两个极端）；is = 0 时只返回名义星位。
 */
function gsoExtremeBeams(latDeg, deltaLonDeg, inclinationDeg) {
  const is = isNum(inclinationDeg) ? Math.abs(inclinationDeg) : 0;
  const pts = is > 0 ? [is, -is] : [0];
  return pts.map(i => {
    const s = gsoLookAngles(latDeg, i, deltaLonDeg);
    return { subSatLatDeg: i, deltaLonDeg, elevDeg: s.elevDeg, azDeg: s.azDeg };
  });
}

// ===========================================================================
// 正文 §2.2 式 (5) 与附件 4：non-GSO 地球站的地平线增益
// ===========================================================================

/**
 * TIG 法地平线增益 Ge（dBi）。RR AP7 正文 §2.2 式 (5)。
 * @param {number} GmaxDbi 该方位地平线增益最大值
 * @param {number} GminDbi 该方位地平线增益最小值
 */
function tigHorizonGain(GmaxDbi, GminDbi) {
  const diff = GmaxDbi - GminDbi;
  // RR AP7 §2.2 式 (5)：Ge = Gmax（差 ≤ 20 dB）；Gmin + 20（20 < 差 < 30 dB）；Gmax − 10（差 ≥ 30 dB）
  if (diff <= 20) return GmaxDbi;
  if (diff < 30) return GminDbi + 20;
  return GmaxDbi - 10;
}

/**
 * 附件 4 §1 最简形式：系统最低仰角 εsys 在所有方位相同时，方位 α 的最小 / 最大分离角。
 * φmin = max(0, εsys − εh)；φmax = 180 − εsys − εh（上限 180°）。
 */
function nonGsoHorizonSeparation(minElevDeg, horizonElevDeg) {
  const eh = isNum(horizonElevDeg) ? horizonElevDeg : 0;
  // RR AP7 附件 4 §1：φmin = εsys − εh，但不小于 0°；φmax = 180° − εsys − εh
  return { phiMinDeg: Math.max(0, minElevDeg - eh), phiMaxDeg: Math.min(180, 180 - minElevDeg - eh) };
}

/**
 * 附件 4 §1.1：星座可见性下限 εv(α)。
 * @param {object} o
 * @param {number} o.latDeg          地球站纬度
 * @param {number} o.inclinationDeg  星座最大轨道倾角 is（0–90°）
 * @param {number} [o.K1]            最低卫星轨道半径 / 地球半径；或给 altitudeKm（地球半径 6 378.14 km）
 * @param {number} [o.altitudeKm]
 * @param {number} [o.stepDeg=1]     参数曲线的 δ 步长（原文 ≤ 1°，含端点）
 * @returns {{cases:number[], psiMDeg:number, K1:number, elevAt:function(number):number,
 *            curves:object, alpha2Deg:number|null, warnings:string[]} | {error:string}}
 *   elevAt(azDeg) 返回该方位的最小卫星可见仰角 εv（°）；90 表示该方位 90° 以下无星可见。
 */
function constellationVisibility(o) {
  if (!o || !isNum(o.latDeg) || !isNum(o.inclinationDeg)) return { error: '缺纬度或轨道倾角' };
  const is = Math.abs(o.inclinationDeg);
  if (is > 90) return { error: '轨道倾角应在 0–90°' };
  const K1 = isNum(o.K1) ? o.K1 : (isNum(o.altitudeKm) ? (EARTH_RADIUS_ANNEX4_KM + o.altitudeKm) / EARTH_RADIUS_ANNEX4_KM : NaN);
  if (!(K1 > 1)) return { error: '缺轨道高度（K1 须大于 1）' };
  const step = o.stepDeg > 0 ? Math.min(1, o.stepDeg) : 1;
  const ze = Math.abs(o.latDeg);
  const north = o.latDeg >= 0;
  const warnings = [];
  // RR AP7 附件 4 §1.1：ψm = arccos(1/K1)
  const psiM = acosd(1 / K1);

  // RR AP7 附件 4 §1.1 式 (98)–(100)：轨道壳边缘上经差 δ 的点（倾角符号由 incl 给出；Case 6 以 −is 代入）
  const edge = (delta, incl) => {
    const cpsi = clampUnit(sind(ze) * sind(incl) + cosd(ze) * cosd(incl) * cosd(delta));          // 式 (98)
    const psi = Math.acos(cpsi) * R2D;
    const ev = asind((K1 * cpsi - 1) / Math.sqrt(1 + K1 * K1 - 2 * K1 * cpsi));                 // 式 (99)
    const den = Math.sin(psi * D2R) * cosd(ze);
    const a0 = Math.abs(den) < 1e-12 ? (incl >= 0 ? 0 : 180) : acosd((sind(incl) - cpsi * sind(ze)) / den);   // 式 (100)
    return { delta, alpha0: a0, elev: ev };
  };
  const curve = (dEnd, incl) => sampleClosed(0, dEnd, step).map(d => edge(d, incl));

  const tAsin = asind(sind(is) * cosd(psiM));
  let main;
  if (ze <= is - psiM) main = 1;                                         // Case 1
  else if (ze >= 180 - is - psiM && ze <= 90) main = 5;                   // Case 5
  else if (ze <= tAsin) main = 2;                                         // Case 2：is − ψm < ζe ≤ arcsin(sin is cos ψm)
  else if (ze < is && ze < 180 - psiM - is) main = 3;                     // Case 3
  else if (ze >= is && ze < is + psiM && ze < 180 - is - psiM) main = 4;  // Case 4
  else main = 0;                                                          // 未列情形：任何方位 90° 以下无星可见
  const case6 = ze < psiM - is;                                           // Case 6（可与 2、3、4 并存）

  const curves = {};
  let alpha2 = null;
  if (main === 2) {
    // RR AP7 附件 4 §1.1 Case 2：δ1 = arccos[(cos ψm − sin ζe sin is) / (cos ζe cos is)]
    const d1 = acosd((cosd(psiM) - sind(ze) * sind(is)) / (cosd(ze) * cosd(is)));
    curves.main = curve(d1, is);
  } else if (main === 3) {
    const d1 = acosd((cosd(psiM) - sind(ze) * sind(is)) / (cosd(ze) * cosd(is)));
    // RR AP7 附件 4 §1.1 Case 3：δ2 = 2 arctan[√(sin²ψm − cos²is sin²δ1) / (sin ζe cos is sin δ1)] − δ1
    const num = Math.sqrt(Math.max(0, Math.pow(sind(psiM), 2) - Math.pow(cosd(is) * sind(d1), 2)));
    const d2 = 2 * Math.atan2(num, sind(ze) * cosd(is) * sind(d1)) * R2D - d1;
    curves.main = curve(Math.max(0, d2), is);
  } else if (main === 4) {
    // RR AP7 附件 4 §1.1 Case 4：α2 = arccos[(sin is − cos ψm sin ζe) / (sin ψm cos ζe)]
    alpha2 = acosd((sind(is) - cosd(psiM) * sind(ze)) / (sind(psiM) * cosd(ze)));
  }
  if (case6) {
    // RR AP7 附件 4 §1.1 Case 6：δ3 = arccos[(cos ψm + sin ζe sin is) / (cos ζe cos is)]，并以 −is 代入式 (98)–(101)
    const d3 = acosd((cosd(psiM) + sind(ze) * sind(is)) / (cosd(ze) * cosd(is)));
    curves.case6 = curve(d3, -is);
  }

  // 参数曲线 → 按主方位 α0 线性插值的函数；曲线覆盖范围外取 0（原文「not included in the set … is zero」）
  const toInterp = (pts) => {
    const s = pts.slice().sort((p, q) => p.alpha0 - q.alpha0);
    // δ 递增时主方位应单调（Case 3 的 δ2 恰是方位折返点）；若出现折返只记一条警告，按排序后插值
    const dir = Math.sign(pts[pts.length - 1].alpha0 - pts[0].alpha0);
    if (pts.some((q, k) => k > 0 && (q.alpha0 - pts[k - 1].alpha0) * dir < -1e-9)) warnings.push('可见性参数曲线的方位非单调，按排序后插值');
    const lo = s[0].alpha0, hi = s[s.length - 1].alpha0;
    // δ = 0 的端点理论上正好是 0° 或 180°，arccos 在 ±1 附近有 1e-6° 量级的舍入，容差取 1e-4°
    const TOL = 1e-4;
    return (a0) => {
      if (a0 < lo - TOL || a0 > hi + TOL) return 0;
      if (s.length === 1) return s[0].elev;
      const x = Math.min(hi, Math.max(lo, a0));
      let k = 1;
      while (k < s.length - 1 && s[k].alpha0 < x) k++;
      const p = s[k - 1], q = s[k];
      const t = q.alpha0 > p.alpha0 ? (x - p.alpha0) / (q.alpha0 - p.alpha0) : 0;
      return Math.max(0, p.elev + t * (q.elev - p.elev));
    };
  };
  const fMain = curves.main ? toInterp(curves.main) : null;
  const f6 = curves.case6 ? toInterp(curves.case6) : null;

  const principal = (azDeg) => {
    const a = wrap360(azDeg);
    // RR AP7 附件 4 §1.1 式 (101)：北半球 α = α0 与 360° − α0；南半球 α = 180° − α0 与 180° + α0
    if (north) return a <= 180 ? a : 360 - a;
    return a <= 180 ? 180 - a : a - 180;
  };
  const elevAt = (azDeg) => {
    const a0 = principal(azDeg);
    let e;
    if (main === 1 || main === 5) e = 0;
    else if (main === 0) e = 90;
    else if (main === 4) e = a0 < alpha2 ? 90 : 0;
    else e = fMain ? fMain(a0) : 0;
    if (f6) e = Math.max(e, f6(a0));
    return e;
  };
  const cases = main ? [main] : [];
  if (case6) cases.push(6);
  return { cases, mainCase: main, psiMDeg: psiM, K1, elevAt, curves, alpha2Deg: alpha2, warnings };
}

/**
 * 附件 4 §1.2 式 (102)：方位 α（地平线仰角 εh）与最小合成仰角剖面 εc(αc) 之间分离角的最小 / 最大值。
 * @param {object} o
 * @param {number} o.azDeg, [o.horizonElevDeg=0]
 * @param {Array<{azDeg:number, elevDeg:number}>} o.profile 最小合成仰角剖面（原文要求方位间隔 ≤ 1°；
 *        更稀时按原文允许的线性插值加密到 1°）
 * @returns {{phiMinDeg:number, phiMaxDeg:number, atMin:object, atMax:object}}
 */
function separationFromProfile(o) {
  const eh = isNum(o.horizonElevDeg) ? o.horizonElevDeg : 0;
  const prof = densifyProfile(o.profile, 1);
  let mn = Infinity, mx = -Infinity, atMin = null, atMax = null;
  for (const p of prof) {
    // RR AP7 附件 4 §1.2 式 (102)：φ(α,αc) = arccos[sin εh sin εc + cos εh cos εc cos(α − αc)]
    const phi = acosd(sind(eh) * sind(p.elevDeg) + cosd(eh) * cosd(p.elevDeg) * cosd(o.azDeg - p.azDeg));
    if (phi < mn) { mn = phi; atMin = p; }
    if (phi > mx) { mx = phi; atMax = p; }
  }
  return { phiMinDeg: mn, phiMaxDeg: mx, atMin, atMax };
}

/** 环形方位剖面线性加密到间隔 ≤ maxStep（附件 4 §1.2 允许线性插值）。 */
function densifyProfile(profile, maxStep) {
  const s = profile.map(p => ({ azDeg: wrap360(p.azDeg), elevDeg: p.elevDeg })).sort((p, q) => p.azDeg - q.azDeg);
  if (s.length < 2) return s;
  const out = [];
  for (let k = 0; k < s.length; k++) {
    const p = s[k], q = s[(k + 1) % s.length];
    let span = q.azDeg - p.azDeg;
    if (k === s.length - 1) span += 360;
    const n = Math.max(1, Math.ceil(span / maxStep - 1e-12));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      out.push({ azDeg: wrap360(p.azDeg + t * span), elevDeg: p.elevDeg + t * (q.elevDeg - p.elevDeg) });
    }
  }
  return out;
}

/**
 * 附件 4 全流程（§1、§1.1、§1.2）+ 正文 §2.2 式 (5)：non-GSO 跟踪天线在方位 α 的 TIG 地平线增益。
 * @param {object} o
 * @param {number} o.minElevDeg       地球站最低工作仰角 εsys
 * @param {number} o.azDeg, [o.horizonElevDeg=0]
 * @param {{GmaxDbi:number, dOverLambda?:number, pattern?:function}} o.antenna
 * @param {object} [o.visibility]     constellationVisibility 的返回值；缺省则只用 εsys（附件 4 §1 最简形式）
 * @returns {{phiMinDeg, phiMaxDeg, GmaxDbi, GminDbi, GeDbi}}
 */
function nonGsoHorizonGain(o) {
  const ant = o.antenna || {};
  const custom = typeof ant.pattern === 'function' ? ant.pattern : null;
  const pp = custom ? null : annex3PatternParams(ant.GmaxDbi, ant.dOverLambda);
  const G = (phi) => (custom ? custom(phi) : esReferencePattern(phi, pp));
  let sep;
  if (o.visibility && typeof o.visibility.elevAt === 'function') {
    const prof = [];
    for (let a = 0; a < 360; a += 1) {
      // RR AP7 附件 4 §1.2：εc = max(εv, εsys)
      prof.push({ azDeg: a, elevDeg: Math.max(o.visibility.elevAt(a), o.minElevDeg) });
    }
    sep = separationFromProfile({ azDeg: o.azDeg, horizonElevDeg: o.horizonElevDeg, profile: prof });
  } else {
    sep = nonGsoHorizonSeparation(o.minElevDeg, o.horizonElevDeg);
  }
  const Gmax = G(sep.phiMinDeg), Gmin = G(sep.phiMaxDeg);
  return { phiMinDeg: sep.phiMinDeg, phiMaxDeg: sep.phiMaxDeg, GmaxDbi: Gmax, GminDbi: Gmin, GeDbi: tigHorizonGain(Gmax, Gmin) };
}

// ===========================================================================
// 附件 5 §2.1：未知 GSO 接收地球站的地平线增益（双向频段）
// ===========================================================================

/** 表 9b 脚注 10 的替代方向图：G = 32 − 25 lg φ（1° ≤ φ < 48°）；−10（48° ≤ φ < 180°）。φ < 1° 取 32。 */
function table9bAltPattern(phiDeg) {
  const phi = Math.abs(phiDeg);
  if (phi < 1) return 32;
  if (phi < 48) return 32 - 25 * LOG10(phi);
  return -10;
}

/**
 * 附件 5 §2.1：发射站方位 α 上未知 GSO 接收地球站朝发射站的地平线增益 Gr。
 * @param {object} o
 * @param {number} o.latDeg        纬度 ζ（假定收发两站相同）
 * @param {number} o.minElevDeg    接收站最低工作仰角 εmin（表 9）
 * @param {number} o.azDeg         发射地球站处的方位 α
 * @param {number} [o.GmDbi=42]    接收站轴向增益（表 9 未给时按脚注取 42 dBi）
 * @param {number} [o.dOverLambda]
 * @param {'annex3'|'alt'|function} [o.pattern='annex3']  'alt' = 表 9b 脚注 10 的 32−25lgφ 方向图
 * @param {number} [o.stepDeg=1]   δ0 步长（原文 ≤ 1°，含端点）
 * @returns {{alphaRDeg, deltaBDeg, phiDeg, gainDbi, at:{deltaLonDeg, elevDeg, azDeg}} | {error:string}}
 */
function bidirectionalReceiverHorizonGain(o) {
  if (!o || !isNum(o.latDeg) || !isNum(o.minElevDeg) || !isNum(o.azDeg)) return { error: '缺纬度、最低仰角或方位' };
  const em = o.minElevDeg;
  // RR AP7 附件 5 §2.1 式 (103)：δb = arccos{ sin[εmin + arcsin(cos εmin / K)] / cos ζ }
  const arg = sind(em + asind(cosd(em) / K_GSO)) / cosd(o.latDeg);
  if (!(arg <= 1)) return { error: `纬度 ${o.latDeg}° 处在仰角 ${em}° 以上看不到静止轨道` };
  const db = acosd(arg);
  // RR AP7 附件 5 §2.1 Step 2：αr = α + 180°（α < 180°）；α − 180°（α ≥ 180°）
  const a = wrap360(o.azDeg);
  const ar = a < 180 ? a + 180 : a - 180;
  const step = o.stepDeg > 0 ? Math.min(1, o.stepDeg) : 1;
  let best = null;
  for (const d of sampleClosed(-db, db, step)) {
    // 附件 3 Case 1，εh = 0（附件 5 §3.1.1 假定接收站地平线仰角为 0）
    const s = gsoLookAngles(o.latDeg, 0, d);
    const phi = offAxisToHorizon(ar, 0, s.azDeg, s.elevDeg);
    if (!best || phi < best.phi) best = { phi, d, s };
  }
  let g;
  if (typeof o.pattern === 'function') g = o.pattern(best.phi);
  else if (o.pattern === 'alt') g = table9bAltPattern(best.phi);
  else g = esReferencePattern(best.phi, annex3PatternParams(isNum(o.GmDbi) ? o.GmDbi : 42, o.dOverLambda));
  return { alphaRDeg: ar, deltaBDeg: db, phiDeg: best.phi, gainDbi: g,
    at: { deltaLonDeg: best.d, elevDeg: best.s.elevDeg, azDeg: best.s.azDeg } };
}

// ===========================================================================
// 附件 6 §3.2.3：视距中继系统天线参考方向图（模式 (2) 辅助等值线用）
// ===========================================================================

/**
 * @param {number} phiDeg 离轴角（°）
 * @param {{GmaxDbi:number, dOverLambda?:number}} o  D/λ 缺省按式 (122) 估算
 * @returns {number} G(φ)（dBi）
 */
function radioRelayReferencePattern(phiDeg, o) {
  const Gmax = o.GmaxDbi;
  // RR AP7 附件 6 §3.2.3 式 (122)：20 lg(D/λ) ≈ Gamax − 7.7
  const dl = o.dOverLambda > 0 ? o.dOverLambda : Math.pow(10, (Gmax - 7.7) / 20);
  const phi = Math.min(180, Math.abs(phiDeg));
  // RR AP7 附件 6 式 (115)：G1 = 2 + 15 lg(D/λ)（b 小节沿用，见头注）
  const G1 = 2 + 15 * LOG10(dl);
  // RR AP7 附件 6 式 (116)：φm = (20 λ / D) √(Gamax − G1)
  const phiM = Gmax > G1 ? (20 / dl) * Math.sqrt(Gmax - G1) : 0;
  if (dl > 100) {
    // RR AP7 附件 6 式 (117)：φr = 15.85 (D/λ)^−0.6
    const phiR = 15.85 * Math.pow(dl, -0.6);
    if (phi < phiM) return Gmax - 2.5e-3 * Math.pow(dl * phi, 2);   // 式 (111)
    if (phi < phiR) return G1;                                       // 式 (112)
    if (phi < 48) return 32 - 25 * LOG10(phi);                       // 式 (113)
    return -10;                                                      // 式 (114)
  }
  if (phi < phiM) return Gmax - 2.5e-3 * Math.pow(dl * phi, 2);     // 式 (118)
  if (phi < 100 / dl) return G1;                                     // 式 (119)
  if (phi < 48) return 52 - 10 * LOG10(dl) - 25 * LOG10(phi);        // 式 (120)
  return 10 - 10 * LOG10(dl);                                        // 式 (121)
}

module.exports = {
  K_GSO, EARTH_RADIUS_ANNEX4_KM,
  gsoLookAngles, offAxisToHorizon, horizonOffAxisGso,
  annex3PatternParams, esReferencePattern, horizonGainGso, gsoExtremeBeams,
  tigHorizonGain, nonGsoHorizonSeparation, constellationVisibility, separationFromProfile, nonGsoHorizonGain,
  table9bAltPattern, bidirectionalReceiverHorizonGain,
  radioRelayReferencePattern,
  // 内部小工具，测试与主模块共用
  _internal: { sampleClosed, densifyProfile, wrap360 }
};
