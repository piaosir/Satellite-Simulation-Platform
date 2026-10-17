// RR 附录 7（Rev.WRC-23）地球站协调区模块测试（无框架，纯断言）。
//   运行： node packages/core/test/ap7.test.mjs
//
// 被测：utils/terrestrial/ap7.js（含 ap7Antenna.js、ap7Tables.js）。依据 RR 2024 卷 2 附录 7（PDF 第 181–270 页）。
//
// 校验内容与期望值来源（凡「独立重算」均为本文件按 AP7 原式另写的 ref* 函数，不调用模块内部）：
//   ① 正文 §4 式 (7)–(21)：βe、ζr、N0、dmin、dmax1（表 3 / 式 (19) / 混合路径规则）、X(f)、Z(f)——独立重算；
//      式 (13)–(18)、(20) 的分段连续性。
//   ② 附件 1：§1 式 (23)–(25) 场地屏蔽（含两端截断）；式 (33)(34)(55)(56) 气体比衰减；§2 式 (29)–(31)、
//      §3 式 (36)–(54)、§4 式 (58)–(61) 在给定距离的全部中间量——独立重算；迭代语义（第一个满足所需
//      损耗的网格点、截到 dmax1）；辅助等值线（式 (22)、修正为 0、以主等值线为上限）。
//   ③ 附件 2 式 (63)–(83)：降雨率五组、降雨高度、表 5 插值、Lr 各项、dmax2、圆心偏移——独立重算。
//   ④ 附件 3：式 (84)–(88) 视角与式 (89) 离轴角用三维矢量（地心直角 + 站心东北天）独立推导互验；
//      倾斜轨道 Case 2 的 φ 不大于 Case 1；式 (97) 方向图逐段取值与连续性。
//   ⑤ 附件 4 式 (5)(98)–(102)、附件 5 式 (103)–(105)、附件 6 式 (106)–(126)、附件 7 式 (127)(128)、表 6、
//      表 10 注 1——独立重算或几何闭式值。附件 5 图 8 只有曲线，取其可由几何闭式确定的特征点比对：
//      赤道站朝东 / 西地平线到静止轨道（εmin 以上）的最小夹角 = εmin，朝北 = 90°。
//   ⑥ 不变量：预测路径损耗随距离单调不减（单一区划、及不含「冷海后接暖海」的混合路径，0.1–105 GHz、
//      p = 0.001–50%）；距离落在 [dmin, dmax]；所需损耗越大距离越远；场地屏蔽、固定业务修正的方向；
//      模式 (2) 等值线为偏心圆（点到圆心距离 = dr，dmin 处截平）；f < 10 GHz 时 Lr 单调。
//   ⑦ 表转录：结构检查（每列字段齐全、频段区间有效、脚注号有对应文字）+ 逐表抽查（期望值读自 PDF
//      第 256–269 页 300–400 dpi 页面图像）+ 表中 Pr 与式 (127) 的一致性（≤ 1 dB；唯表 9a 1.670–1.675 GHz
//      non-GSO 列差 1.65 dB，原表自身不一致，作为已知项单独断言）。
//   ⑧ AP7 原文性质（不是实现缺陷，固定下来防止被「修」掉）：附件 1 §2「冷暖海并存按暖海」使损耗在暖海
//      出现处跌落；附件 2 式 (79) 在 Lar 由 0 变正处 Ab 归零使 Lr 跌落。
//   ⑨ 端到端：C 频段 3.4–4.2 GHz 接收 FSS 地球站（表 8b）与 5.725–7.075 GHz 发射 FSS 地球站（表 7b），
//      GSO 卫星、数度地平线、内陆 A2 与混合沿海路径；核量级与 AP7 描述的行为。
//
// 算例：已检索 AP7（RR 2024）与 ITU-R P.620-7 全文，二者均无可对拍的数值算例（AP7 图 6–9 为示意，
// 图 9 注明「不按比例」）；故本文件不含「与发布算例的最大偏差」一项。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const A = require('../utils/terrestrial/ap7.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
};
const approx = (name, got, want, tol) => {
  const g = Number(got);
  const c = Number.isFinite(g) && Math.abs(g - want) <= tol;
  console.log((c ? 'PASS' : 'FAIL') + `  ${name}  (got=${Number.isFinite(g) ? g.toFixed(5) : g}, want≈${want} ±${tol})`);
  c ? pass++ : fail++;
};

const lg = Math.log10;
const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

// ───────────────────────────── 独立参考实现（按 AP7 原式另写） ─────────────────────────────
const refZetaR = (z) => (Math.abs(z) > 1.8 ? Math.abs(z) - 1.8 : 0);                          // (9)(10)
const refBetaE = (z) => (refZetaR(z) <= 70 ? 10 ** (1.67 - 0.015 * refZetaR(z)) : 4.17);       // (7)(8)
const refN0 = (z) => 330 + 62.6 * Math.exp(-(((z - 2) / 32.7) ** 2));                         // (11)
function refDmin(f, z) {                                                                       // (12)–(18)
  const be = refBetaE(z), dx = 100 + (be - 40) / 2;
  if (f < 40) return 100 + (be - f) / 2;
  if (f < 54) return ((54 - f) * dx + 10 * (f - 40)) / 14;
  if (f < 66) return 10;
  if (f < 75) return (10 * (75 - f) + 45 * (f - 66)) / 9;
  if (f < 90) return 45;
  return 45 - (f - 90) / 1.5;
}
function refX(f, role) {                                                                       // (20)
  const X = role === 'tx' ? 15 : 25;
  if (f <= 0.4) return 0;
  if (f <= 0.79) return 3.3833 * X * (lg(f) + 0.3979);
  if (f <= 4.2) return X;
  if (f <= 60) return -0.8659 * X * (lg(f) - 1.7781);
  return 0;
}
function refAh(f, eh, hd) {                                                                    // (23)–(25)
  const dh = hd === undefined || hd < 0.5 ? 0.5 : Math.min(5, hd);
  const Ad = 15 * (1 - Math.exp((0.5 - dh) / 5)) * (1 - Math.exp(-eh * f ** (1 / 3)));
  let Ah;
  if (eh >= 0) Ah = 20 * lg(1 + 4.5 * eh * f ** 0.5) + eh * f ** (1 / 3) + Ad;
  else if (eh >= -0.5) Ah = 3 * ((f + 1) ** 0.5 - 0.0001 * f - 1.0487) * eh;
  else Ah = -1.5 * ((f + 1) ** 0.5 - 0.0001 * f - 1.0487);
  return Math.min(30 + eh, Math.max(-10, Ah));
}
const refGo = (f) => (f <= 56.77 ? (7.19e-3 + 6.09 / (f ** 2 + 0.227) + 4.81 / ((f - 57) ** 2 + 1.5)) * f ** 2 * 1e-3 : 10);  // (33)
const refGw = (f, r) => (0.05 + 0.0021 * r + 3.6 / ((f - 22.2) ** 2 + 8.5)) * f ** 2 * r * 1e-4;                          // (34)
const refGom = (f) => (f <= 63.26 ? 10 : (2e-4 * (1 - 1.2e-5 * f ** 1.5) + 4 / ((f - 63) ** 2 + 0.936) + 0.28 / ((f - 118.75) ** 2 + 1.771)) * f ** 2 * 6.24e-4); // (55)
const refGwm = (f) => (0.039 + 7.7e-4 * f ** 0.5) * f ** 2 * 2.369e-4;                                                    // (56)

// 附件 1 §2：给定 d、路径量、Ci、海型的 L2 + Ah
function refS2(f, p, d, dtm, Ci, sea, Ah) {
  const Lbl = 142.8 + 20 * lg(f) + 10 * lg(p) + 0.1 * d + Ci;                                                            // (29)
  const Lbs = sea === 'B'
    ? 49.91 * lg(d + 1840 * f ** 1.76) + 1.195 * f ** 0.393 * lg(p) ** 1.38 * d ** 0.597 + (0.01 * d - 70) * (f - 0.1581)
      + (0.02 - 2e-5 * p * p) * d + 9.72e-9 * d * d * p * p + 20.2                                                       // (30a)
    : 49.343 * lg(d + 1840 * f ** 1.58) + 1.266 * lg(p) ** (0.468 + 2.598 * f) * d ** 0.453 + (0.037 * d - 70) * (f - 0.1581)
      + 1.95e-10 * d * d * p ** 3 + 20.2;                                                                                  // (30b)
  const w = 1 - Math.exp(-5.5 * (dtm / d) ** 1.1);
  const L2 = Lbs + w * (Lbl - Lbs);                                                                                        // (31)
  return { Lbl, Lbs, w, L2, total: L2 + Ah };
}

// 附件 1 §3：给定 d 及路径量（dt、dlm、dtm；dlm375 = 0–375 km 段的 dlm）
function refS3(o) {
  const { f, p, lat, eh, dh, dc, d, dt, dlm, dtm, dlm375, corr, role } = o;
  const Ah = refAh(f, eh, dh), zr = refZetaR(lat), be = refBetaE(lat), N0 = refN0(lat), dmin = refDmin(f, lat);
  const go = refGo(f), gwt = refGw(f, 3), gwdl = refGw(f, 7.5), gwds = refGw(f, 10), gd = 0.05 * f ** (1 / 3);         // (33)–(36)
  const Ac = dc === null ? 0 : -6 / (1 + dc);                                                                              // (37)
  const A1 = 122.43 + 16.5 * lg(f) + Ah + Ac;                                                                              // (38)
  const Lf = 25 * lg(f) - 2.5 * lg(f / 2) ** 2;                                                                            // (40)
  const A2 = 187.36 + 10 * eh + Lf - 0.15 * N0 - 10.1 * (-lg(p / 50)) ** 0.7;                                              // (41)
  const gg = go + gwdl * dt / d + gwds * (1 - dt / d);                                                                     // (44)
  const tau = 1 - Math.exp(-(4.12e-4 * dlm ** 2.41));                                                                      // (45)
  const mu1 = Math.min(1, (10 ** (-dtm / (16 - 6.6 * tau)) + (10 ** (-(0.496 + 0.354 * tau))) ** 5) ** 0.2);             // (46)
  const sigma = Math.max(-3.4, -0.6 - 8.5e-9 * d ** 3.1 * tau);                                                            // (47)
  const mu2 = Math.min(1, (2.48e-4 * d * d) ** sigma);                                                                     // (48)
  const mu4 = zr <= 70 ? 10 ** ((-0.935 + 0.0176 * zr) * lg(mu1)) : 10 ** (0.3 * lg(mu1));                                // (49)
  const beta = be * mu1 * mu2 * mu4;                                                                                       // (50)
  const G1 = 1.076 / (2.0058 - lg(beta)) ** 1.012 * Math.exp(-(9.51 - 4.8 * lg(beta) + 0.198 * lg(beta) ** 2) * 1e-6 * d ** 1.13); // (51)
  const Z = corr ? refX(f, role) / (375 - dmin) : 0;                                                                       // (21)
  const tauC = d <= 375 ? tau : 1 - Math.exp(-(4.12e-4 * dlm375 ** 2.41));
  const C2 = Z * (Math.min(d, 375) - dmin) * tauC;                                                                         // (52)
  const L5 = (gd + gg) * d + (1.2 + 3.7e-3 * d) * lg(p / beta) + 12 * (p / beta) ** G1 + C2;                              // (53)
  const L6 = 20 * lg(d) + 5.73e-4 * (112 - 15 * Math.cos(rad(2 * lat))) * d + (go + gwt) * d + C2;                         // (54)
  return { Ah, A1, A2, Ac, Lf, gg, tau, mu1, sigma, mu2, mu4, beta, G1, C2, L5, L6, total: Math.min(A1 + L5, A2 + L6) };
}

// 附件 2
function refRain(zone, p) {
  const g = 'AB'.includes(zone) ? 0 : ('CDE'.includes(zone) ? 1 : ('FGHJK'.includes(zone) ? 2 : ('LM'.includes(zone) ? 3 : 4)));
  const R03 = [1.5, 3.5, 7.0, 9.0, 25.0][g], pc = [2, 3, 5, 7.5, 10][g];                                                   // 表 4
  if (p >= 0.3) return p >= pc ? 0 : R03 * (lg(pc / p) / lg(pc / 0.3)) ** 2;                                              // (68)
  const a = lg(p / 0.001), b = lg(0.3 / p);
  return [
    1.1 * p ** -0.465 + 0.25 * a * b ** 3 - (Math.abs(lg(p / 0.1)) + 1.1) ** -2,                                            // (63)
    2 * p ** -0.466 + 0.5 * a * b ** 3,                                                                                     // (64)
    4.17 * p ** -0.418 + 1.6 * a * b ** 3,                                                                                  // (65)
    4.9 * p ** -0.48 + 6.5 * a * b ** 2,                                                                                    // (66)
    15.6 * (p ** -0.383 + a * b ** 1.5)                                                                                     // (67)
  ][g];
}
function refLr(o) {   // (70)–(82)
  const { f, R, hR, ri, Gx, k, alpha } = o;
  const gR = k * R ** alpha, ds = 3.5 * R ** -0.08, x = gR * ds;
  const Rcv = 2.17 / x * (1 - 10 ** (-x / 5));
  const G2 = 631 * k * R ** (alpha - 0.5) * 10 ** (-((R + 1) ** 0.19));
  const gwr = (0.06575 + 3.6 / ((f - 22.2) ** 2 + 8.5)) * f ** 2 * 7.5e-4;
  const q = 6 * (ri - 50) ** 2 * 1e-5;
  const Lar = q > hR ? 6.5 * (q - hR) : 0;
  const Ab = f > 10 && f < 40.5 && Lar === 0 ? 0.005 * (f - 10) ** 1.7 * R ** 0.4 : 0;
  const dO = ri < 340 ? 0.7 * ri + 32 : 270, dV = ri < 240 ? 0.7 * ri + 32 : 200;
  const Lr = 168 + 20 * lg(ri) - 20 * lg(f) - 13.2 * lg(R) - Gx + Ab - 10 * lg(Rcv) + G2 + Lar + refGo(f) * dO + gwr * dV;
  return { gR, ds, Rcv, G2, gwr, Lar, Ab, Lr };
}

// 附件 3：三维矢量法求视角（K = 轨道半径 / 地球半径）
function vecLook(lat, i, dlon, K = 6.62) {
  const E = [Math.cos(rad(lat)), 0, Math.sin(rad(lat))];
  const S = [K * Math.cos(rad(i)) * Math.cos(rad(dlon)), K * Math.cos(rad(i)) * Math.sin(rad(dlon)), K * Math.sin(rad(i))];
  const v = S.map((s, k) => s - E[k]);
  const n = Math.hypot(...v);
  const up = E, east = [0, 1, 0], north = [-Math.sin(rad(lat)), 0, Math.cos(rad(lat))];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { elevDeg: deg(Math.asin(dot(v, up) / n)), azDeg: (deg(Math.atan2(dot(v, east), dot(v, north))) + 360) % 360 };
}
function dirVec(az, el) { return [Math.cos(rad(el)) * Math.sin(rad(az)), Math.cos(rad(el)) * Math.cos(rad(az)), Math.sin(rad(el))]; }
function angBetween(a, b) { return deg(Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))); }
function refPattern97(phi, Gmax, dl) {   // 附件 3 §3 式 (97)
  const G1 = dl >= 100 ? -1 + 15 * lg(dl) : -21 + 25 * lg(dl);
  const phiR = dl >= 100 ? 15.85 * dl ** -0.6 : 100 / dl;
  const phiM = 20 / dl * Math.sqrt(Gmax - G1);
  if (phi < phiM) return Gmax - 2.5e-3 * (dl * phi) ** 2;
  if (phi < phiR) return G1;
  if (phi < 36) return 29 - 25 * lg(phi);
  return -10;
}
const pr127 = (Te, B, NL, Ms, W) => 10 * lg(1.38e-23 * Te * B) + NL + 10 * lg(10 ** (Ms / 10) - 1) - W;   // 附件 7 式 (127)

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log('=== ① 正文 §4：无线电气候参数、dmin、dmax1、修正值 ===');
for (const z of [0, 1.8, 2.5, 30, 39.9, -45, 71.8, 75]) {
  const r = A.radioClimate(z);
  approx(`ζr(${z}°) 式(9)(10)`, r.zetaR, refZetaR(z), 1e-12);
  approx(`βe(${z}°) 式(7)(8)`, r.betaE, refBetaE(z), 1e-12);
  approx(`N0(${z}°) 式(11)`, r.N0, refN0(z), 1e-9);
}
approx('βe(39.9°) 手算 10^(1.67−0.015×38.1) = 12.5458', A.radioClimate(39.9).betaE, 12.5458, 1e-4);
approx('βe 在 ζr = 70° 处两式衔接（10^0.62 = 4.169 ≈ 4.17）', A.radioClimate(71.8).betaE, 4.1687, 1e-3);

for (const [f, z] of [[0.15, 39.9], [4, 39.9], [6.2, 25], [39.9, 10], [45, 39.9], [53, 60], [60, 39.9], [70, 0], [80, 39.9], [95, -30], [105, 39.9]]) {
  approx(`dmin(${f} GHz, ${z}°) 式(12)–(18)`, A.minCoordinationDistance(f, z).dminKm, refDmin(f, z), 1e-9);
}
approx('dmin(4 GHz, 39.9°) 手算 = 104.273 km', A.minCoordinationDistance(4, 39.9).dminKm, 104.273, 1e-3);
for (const fb of [40, 54, 66, 75, 90]) {
  const a = A.minCoordinationDistance(fb - 1e-9, 39.9).dminKm, b = A.minCoordinationDistance(fb, 39.9).dminKm;
  approx(`dmin 在 ${fb} GHz 分段处连续`, a, b, 1e-6);
}

for (const [z, want] of [['A1', 500], ['A2', 375], ['B', 900], ['C', 1200]]) {
  approx(`表 3 单一区划 ${z}：dmax1`, A.mode1MaxDistance({ fGHz: 4, p: 0.01, zones: z }).dmax1Km, want, 1e-9);
}
approx('式(19) f > 60 GHz：dmax1(p=0.001) = 80 − 10lg(0.001/50)', A.mode1MaxDistance({ fGHz: 70, p: 0.001 }).dmax1Km, 80 - 10 * lg(0.001 / 50), 1e-9);
approx('式(19) dmax1(p=50) = 80', A.mode1MaxDistance({ fGHz: 100, p: 50 }).dmax1Km, 80, 1e-12);
{
  const mx = (zones) => A.mode1MaxDistance({ fGHz: 4, p: 0.01, zones });
  const r1 = mx([{ zone: 'A1', lengthKm: 50 }, { zone: 'A2' }]);
  ok('§4.3 混合 A1 50 + A2：A2 累计到 375 → 425 km', Math.abs(r1.dmax1Km - 425) < 1e-9 && r1.limitedBy === 'A2', JSON.stringify(r1));
  const r2 = mx([{ zone: 'A2', lengthKm: 400 }, { zone: 'B' }]);
  ok('§4.3 A2 400 + B：A2 累计到 375 即停', Math.abs(r2.dmax1Km - 375) < 1e-9 && r2.limitedBy === 'A2', JSON.stringify(r2));
  const r3 = mx([{ zone: 'A2', lengthKm: 100 }, { zone: 'B' }]);
  ok('§4.3 A2 100 + B：总长受已出现区划最大值 900 限', Math.abs(r3.dmax1Km - 900) < 1e-9 && r3.limitedBy === 'overall', JSON.stringify(r3));
  const r4 = mx([{ zone: 'A2', lengthKm: 300 }, { zone: 'C', lengthKm: 50 }, { zone: 'A2' }]);
  ok('§4.3 A2 300 + C 50 + A2：A2 累计 375 于 425 km', Math.abs(r4.dmax1Km - 425) < 1e-9 && r4.limitedBy === 'A2', JSON.stringify(r4));
  const r5 = mx([{ zone: 'B', lengthKm: 950 }, { zone: 'A2' }]);
  ok('§4.3 B 950 + A2：B 累计到 900 即停', Math.abs(r5.dmax1Km - 900) < 1e-9 && r5.limitedBy === 'B', JSON.stringify(r5));
  const r6 = mx([{ zone: 'A1', lengthKm: 40 }, { zone: 'A2', lengthKm: 30 }, { zone: 'A1' }]);
  ok('§4.3 A1/A2 混合路径不超过 500 km（原文「A1 与 A2 组成的路径不得超过 500 km」）', r6.dmax1Km <= 500 + 1e-9, JSON.stringify(r6));
}

for (const f of [0.2, 0.4, 0.5, 0.6, 0.79, 1, 4.2, 5, 6.2, 14, 30, 60, 70]) {
  for (const role of ['tx', 'rx']) approx(`X(${f} GHz, ${role}) 式(20)`, A.nominalCorrection(f, role), refX(f, role), 1e-12);
}
for (const fb of [0.4, 0.79, 4.2, 60]) {
  ok(`X(f) 在 ${fb} GHz 分段处近似连续（< 0.01 dB）`, Math.abs(A.nominalCorrection(fb, 'rx') - A.nominalCorrection(fb + 1e-9, 'rx')) < 0.01);
}
approx('Z(f) 式(21) = X/(375 − dmin)，6.2 GHz 发射站', A.correctionConstant(6.2, 103.2, 'tx'), refX(6.2, 'tx') / (375 - 103.2), 1e-12);

console.log('\n=== ② 附件 1：场地屏蔽、气体衰减、三个频段模型、迭代语义 ===');
for (const [f, eh, hd] of [[0.5, 0.3, 1], [4, 1, 2], [4, 2, 2], [12, -0.3, undefined], [12, -2, 3], [105, -2, 1], [30, 3, 10], [6, 0, undefined], [2, 5, 0.2]]) {
  approx(`Ah(f=${f}, εh=${eh}°, dh=${hd}) 式(23)–(25)`, A.siteShielding({ fGHz: f, horizonElevDeg: eh, horizonDistKm: hd }).AhDb, refAh(f, eh, hd), 1e-9);
}
ok('式(25) 上限 30 + εh 生效（4 GHz、εh = 2°）', A.siteShielding({ fGHz: 4, horizonElevDeg: 2, horizonDistKm: 2 }).clamped && A.siteShielding({ fGHz: 4, horizonElevDeg: 2, horizonDistKm: 2 }).AhDb === 32);
ok('式(25) 下限 −10 生效（105 GHz、εh = −2°：式(24c) = −13.9 dB）', A.siteShielding({ fGHz: 105, horizonElevDeg: -2 }).AhDb === -10);
ok('地平线距离截断：0.2 km → 0.5 km，9 km → 5 km', A.siteShielding({ fGHz: 4, horizonElevDeg: 1, horizonDistKm: 0.2 }).dhKm === 0.5 && A.siteShielding({ fGHz: 4, horizonElevDeg: 1, horizonDistKm: 9 }).dhKm === 5);
approx('式(24b)(24c) 在 εh = −0.5° 处衔接', A.siteShielding({ fGHz: 8, horizonElevDeg: -0.5 }).AhDb, A.siteShielding({ fGHz: 8, horizonElevDeg: -0.5000001 }).AhDb, 1e-5);

for (const f of [1, 4, 22.2, 50, 56.77, 57, 59]) approx(`γo(${f}) 式(33)`, A.gammaOxygen(f), refGo(f), 1e-12);
for (const [f, r] of [[4, 3], [12, 7.5], [22.2, 10], [40, 7.5]]) approx(`γw(${f}, ρ=${r}) 式(34)`, A.gammaWater(f, r), refGw(f, r), 1e-12);
for (const f of [61, 63.26, 64, 80, 100, 105]) {
  approx(`γom(${f}) 式(55)`, A.gammaOxygenMm(f), refGom(f), 1e-12);
  approx(`γwm(${f}) 式(56)`, A.gammaWaterMm(f), refGwm(f), 1e-12);
}

// ── 附件 1 §2（100–790 MHz）
{
  const f = 0.4, p = 1, lat = 45, d = 150;
  const r = A.mode1PathLoss({ fGHz: f, p, latDeg: lat, zones: 'A2', esRole: 'tx' }, d);
  const ref = refS2(f, p, d, d, 0, 'B', 0);   // X(0.4) = 0 → Ci = 0；|ζ| ≥ 30° 纯陆路径按 B（判断 6）
  approx('§2 纯陆 0.4 GHz：Lbl 式(29)', r.terms.LblDb, ref.Lbl, 1e-9);
  approx('§2 纯陆 0.4 GHz：Lbs 式(30a)', r.terms.LbsDb, ref.Lbs, 1e-9);
  approx('§2 纯陆 0.4 GHz：预测损耗 L2 式(31)', r.lossDb, ref.total, 1e-9);
  ok('§2 纯陆路径的海型按纬度取 B', r.terms.seaZone === 'B');
}
{
  const f = 0.6, p = 10, lat = 45, eh = 0.3, dh = 1;
  const dmin = refDmin(f, lat), Z = refX(f, 'rx') / (375 - dmin), Ah = refAh(f, eh, dh);
  for (const d of [200, 450]) {
    const r = A.mode1PathLoss({ fGHz: f, p, latDeg: lat, zones: [{ zone: 'A2', lengthKm: 80 }, { zone: 'B' }], horizon: { elevDeg: eh, distKm: dh }, esRole: 'rx' }, d);
    const Ci = Z * (Math.min(d, 375) - dmin);
    const ref = refS2(f, p, d, 80, Ci, 'B', Ah);
    approx(`§2 A2 80 + B，0.6 GHz、d = ${d}：Ci 式(28b)${d > 375 ? '（375 km 外取 375 km 值）' : ''}`, r.terms.CiDb, Ci, 1e-9);
    approx(`§2 A2 80 + B，d = ${d}：预测损耗 = L2 + Ah`, r.lossDb, ref.total, 1e-9);
  }
  approx('§2 375 km 外 Ci = X(f)', A.mode1PathLoss({ fGHz: f, p, latDeg: lat, zones: 'A2', esRole: 'rx' }, 500).terms.CiDb, refX(f, 'rx'), 1e-9);
}
{
  const f = 0.15, p = 5, lat = 20, d = 260;
  const r = A.mode1PathLoss({ fGHz: f, p, latDeg: lat, zones: [{ zone: 'A1', lengthKm: 30 }, { zone: 'C' }], esRole: 'tx' }, d);
  const ref = refS2(f, p, d, 30, 0, 'C', 0);
  approx('§2 A1 30 + C，0.15 GHz：Lbs 式(30b)', r.terms.LbsDb, ref.Lbs, 1e-9);
  approx('§2 A1 30 + C：预测损耗', r.lossDb, ref.total, 1e-9);
  const rs = A.mode1PathLoss({ fGHz: 0.6, p: 10, latDeg: 45, zones: 'B', esRole: 'rx' }, 300);
  ok('§2 全海路径：陆地权重为 0，修正不起作用（§4.4「全海路径修正为 0」）', rs.terms.landWeight === 0 && Math.abs(rs.lossDb - rs.terms.LbsDb) < 1e-12);
}

// ── 附件 1 §3（790 MHz – 60 GHz）
{
  const base = { f: 4, p: 0.0017, lat: 39.9, eh: 1, dh: 2, corr: true, role: 'rx' };
  const opts = { fGHz: 4, p: 0.0017, latDeg: 39.9, zones: [{ zone: 'A2', lengthKm: 60 }, { zone: 'A1', lengthKm: 30 }, { zone: 'B' }],
    horizon: { elevDeg: 1, distKm: 2 }, esRole: 'rx' };
  const r = A.mode1PathLoss(opts, 200);
  const ref = refS3(Object.assign({ d: 200, dt: 90, dlm: 60, dtm: 90, dlm375: 60, dc: 90 }, base));
  approx('§3 A2 60 + A1 30 + B：Ac 式(37)（dc = 到第一段海 90 km）', r.constants.AcDb, ref.Ac, 1e-12);
  approx('§3 A1 式(38)', r.constants.A1Db, ref.A1, 1e-9);
  approx('§3 Lf 式(40)', r.constants.LfDb, ref.Lf, 1e-12);
  approx('§3 A2 式(41)', r.constants.A2Db, ref.A2, 1e-9);
  approx('§3 γg 式(44)', r.terms.gammaG, ref.gg, 1e-12);
  approx('§3 τ 式(45)', r.terms.tau, ref.tau, 1e-12);
  approx('§3 μ1 式(46)', r.terms.mu1, ref.mu1, 1e-12);
  approx('§3 σ 式(47)', r.terms.sigma, ref.sigma, 1e-12);
  approx('§3 μ2 式(48)', r.terms.mu2, ref.mu2, 1e-12);
  approx('§3 μ4 式(49a)', r.terms.mu4, ref.mu4, 1e-12);
  approx('§3 β 式(50)', r.terms.beta, ref.beta, 1e-12);
  approx('§3 Γ1 式(51)', r.terms.Gamma1, ref.G1, 1e-12);
  approx('§3 C2i 式(52)', r.terms.C2iDb, ref.C2, 1e-9);
  approx('§3 L5 式(53)', r.terms.L5Db, ref.L5, 1e-9);
  approx('§3 L6 式(54)', r.terms.L6Db, ref.L6, 1e-9);
  approx('§3 预测损耗 = min(A1 + L5, A2 + L6)（等价于 (32a)）', r.lossDb, ref.total, 1e-9);
}
{
  // 375 km 外 C2i 按字面取 375 km 处的值：τ 用 0–375 km 段的 dlm（此路径 15 km）而非当前 dlm（90 km）
  const opts = { fGHz: 6.2, p: 0.0025, latDeg: 30, zones: [{ zone: 'B', lengthKm: 360 }, { zone: 'A2' }], esRole: 'tx' };
  const r = A.mode1PathLoss(opts, 450);
  const ref = refS3({ f: 6.2, p: 0.0025, lat: 30, eh: 0, dh: undefined, dc: 0, d: 450, dt: 90, dlm: 90, dtm: 90, dlm375: 15, corr: true, role: 'tx' });
  approx('§3 B 360 + A2，d = 450：C2i 取 375 km 处值（τ375）', r.terms.C2iDb, ref.C2, 1e-9);
  ok('§3 τ375 与当前 τ 确实不同（该用例有区分力）', Math.abs(r.constants.tau375 - r.terms.tau) > 0.5);
  approx('§3 B 360 + A2，d = 450：预测损耗', r.lossDb, ref.total, 1e-9);
  ok('§3 站在海上（首段 B）：dc = 0，Ac = −6 dB', r.constants.dcKm === 0 && r.constants.AcDb === -6);
}
{
  const rs = A.mode1PathLoss({ fGHz: 4, p: 0.01, latDeg: 45, zones: 'B', esRole: 'rx' }, 300);
  ok('§3 全海路径：τ = 0 → C2i = 0（§4.4）', rs.terms.tau === 0 && rs.terms.C2iDb === 0);
  const rl = A.mode1PathLoss({ fGHz: 4, p: 0.01, latDeg: 45, zones: 'A2', esRole: 'rx' }, 300);
  ok('§3 全程无海：Ac = 0（判断 5）', rl.constants.AcDb === 0 && rl.constants.dcSource === 'noSea');
  const r0 = A.mode1PathLoss({ fGHz: 4, p: 0.01, latDeg: 45, zones: 'A2', esRole: 'rx', dcKm: 0 }, 300);
  ok('§3 dcKm = 0 覆盖：得字面解读 Ac = −6 dB', r0.constants.AcDb === -6);
  const r75 = A.mode1PathLoss({ fGHz: 10, p: 0.01, latDeg: 75, zones: 'A2', esRole: 'rx' }, 250);
  const ref75 = refS3({ f: 10, p: 0.01, lat: 75, eh: 0, dh: undefined, dc: null, d: 250, dt: 250, dlm: 250, dtm: 250, dlm375: 250, corr: true, role: 'rx' });
  approx('§3 ζr > 70°：μ4 按式(49b) 10^(0.3 lg μ1)（判断 2）', r75.terms.mu4, ref75.mu4, 1e-12);
  approx('§3 ζr > 70° 预测损耗', r75.lossDb, ref75.total, 1e-9);
}

// ── 附件 1 §4（60–105 GHz）
{
  const f = 80, p = 0.01, eh = 0.5, d = 50;
  const r = A.mode1PathLoss({ fGHz: f, p, latDeg: 30, horizon: { elevDeg: eh } }, d);
  const L7 = 92.5 + 20 * lg(f) + refAh(f, eh, undefined);                                                       // (58)
  const L9 = (refGom(f) + refGwm(f)) * d + 20 * lg(d) + 2.6 * (1 - Math.exp(-d / 10)) * lg(p / 50);              // (61)
  approx('§4 L7 式(58)', r.constants.L7Db, L7, 1e-9);
  approx('§4 L9 式(61)', r.terms.L9Db, L9, 1e-9);
  approx('§4 预测损耗 = L7 + L9（等价于 (54a)）', r.lossDb, L7 + L9, 1e-9);
  ok('§4 不需要区划剖面；dmax1 按式(19)', r.dmax1Km === 80 - 10 * lg(p / 50));
}

// ── 迭代语义与截断
{
  const cases = [
    { fGHz: 0.6, p: 10, latDeg: 45, zones: 'A2', esRole: 'rx', Lb: 160 },
    { fGHz: 4, p: 0.0017, latDeg: 39.9, zones: [{ zone: 'A2', lengthKm: 60 }, { zone: 'A1', lengthKm: 30 }, { zone: 'B' }], esRole: 'rx', Lb: 205 },
    { fGHz: 6.2, p: 0.0025, latDeg: 22, zones: 'C', esRole: 'tx', Lb: 175 },
    { fGHz: 14, p: 0.01, latDeg: 50, zones: 'A1', esRole: 'tx', Lb: 170, stepKm: 0.5 },
    { fGHz: 80, p: 0.001, latDeg: 10, Lb: 160 }
  ];
  for (const c of cases) {
    const r = A.mode1RequiredDistance(c);
    const s = r.stepKm;
    const inRange = r.distanceKm >= r.dminKm - 1e-9 && r.distanceKm <= r.dmax1Km + 1e-9;
    const onGrid = r.stoppedBy !== 'loss' || Math.abs(((r.distanceKm - r.dminKm) / s) - Math.round((r.distanceKm - r.dminKm) / s)) < 1e-9 || Math.abs(r.distanceKm - r.dmax1Km) < 1e-9;
    const prevLoss = r.distanceKm - s >= r.dminKm ? A.mode1PathLoss(c, r.distanceKm - s).lossDb : -Infinity;
    const firstHit = r.stoppedBy !== 'loss' || (r.lossAtDistanceDb >= c.Lb && prevLoss < c.Lb);
    ok(`迭代语义 ${c.fGHz} GHz：距离在 [dmin, dmax1]、落在网格、为第一个满足点`, inRange && onGrid && firstHit,
      `d=${r.distanceKm.toFixed(2)} km ${r.stoppedBy}`);
  }
  const big = A.mode1RequiredDistance({ fGHz: 4, p: 0.01, latDeg: 40, zones: 'A2', esRole: 'rx', Lb: 400 });
  ok('所需损耗极大：止于 dmax1（A2 = 375 km），stoppedBy = dmax', big.distanceKm === 375 && big.stoppedBy === 'dmax');
  const small = A.mode1RequiredDistance({ fGHz: 4, p: 0.01, latDeg: 40, zones: 'A2', esRole: 'rx', Lb: 100 });
  ok('所需损耗极小：等于 dmin', Math.abs(small.distanceKm - small.dminKm) < 1e-12 && small.stoppedBy === 'loss');
  const aux = A.mode1RequiredDistance({ fGHz: 4, p: 0.0017, latDeg: 39.9, zones: 'A2', esRole: 'rx', Lb: 200, Q: -10 });
  ok('辅助等值线 Q = −10：Lbq = Lb − 10（式(22)）且距离不超过主等值线', aux.auxiliary.requiredLossDb === 190 && aux.auxiliary.distanceKm <= aux.distanceKm);
  const auxCap = A.mode1RequiredDistance({ fGHz: 4, p: 0.0017, latDeg: 39.9, zones: 'A2', esRole: 'rx', Lb: 200, Q: -5 });
  ok('辅助等值线不计修正：修正大于 |Q| 时以主等值线为上限（附件 6 §3.1）', auxCap.auxiliary.stoppedBy === 'mainContour' && auxCap.auxiliary.distanceKm === auxCap.distanceKm,
    `修正≈${auxCap.correction.atDistanceDb.toFixed(1)} dB`);
  const pc = A.mode1RequiredDistance({ fGHz: 0.3, p: 0.05, latDeg: 40, zones: 'A2', esRole: 'rx', Lb: 150 });
  ok('§2 p < 1%：按 1% 计算并给警告（(log p)^1.38 无实数解）', pc.pUsed === 1 && pc.warnings.some(w => w.includes('超出附件 1 §2')));
  ok('无效输入返回 { error }', !!A.mode1RequiredDistance({ fGHz: 200, p: 1, Lb: 150, latDeg: 0, zones: 'A2' }).error
    && !!A.mode1RequiredDistance({ fGHz: 4, p: 1, Lb: 150, latDeg: 0 }).error
    && !!A.mode1RequiredDistance({ fGHz: 4, p: 1, Lb: 150, latDeg: 0, zones: 'A2' }).error   // 要修正却缺 esRole
    && !!A.mode1RequiredDistance({ fGHz: 4, p: 1, Lb: 150, latDeg: 0, zones: [{ zone: 'X', lengthKm: 10 }], esRole: 'tx' }).error);
}

console.log('\n=== ⑥ 不变量：单调、截断、方向性 ===');
{
  // 预测损耗随距离单调不减（1 km 网格）：单一区划 + 不含「冷海后接暖海」的混合路径
  const paths = { A1: 'A1', A2: 'A2', B: 'B', C: 'C',
    A2_A1_B: [{ zone: 'A2', lengthKm: 60 }, { zone: 'A1', lengthKm: 30 }, { zone: 'B' }],
    A1_C_A2: [{ zone: 'A1', lengthKm: 20 }, { zone: 'C', lengthKm: 150 }, { zone: 'A2' }],
    B_A1_A2: [{ zone: 'B', lengthKm: 100 }, { zone: 'A1', lengthKm: 40 }, { zone: 'A2' }] };
  let worst = 0, where = '', n = 0;
  for (const f of [0.15, 0.6, 0.79, 1.5, 4, 6.2, 14, 30, 59, 70, 100]) for (const p of [0.001, 0.01, 1, 10, 50]) for (const lat of [20, 50]) for (const [pn, z] of Object.entries(paths)) {
    const s = A.mode1Setup({ fGHz: f, p, latDeg: lat, zones: z, Lb: 0, esRole: 'rx', horizon: { elevDeg: 0.5 } });
    let prev = -Infinity;
    for (let d = s.dminKm; d <= s.dmax1Km; d += 1) {
      const L = s.lossAt(d, true).lossDb;
      if (!Number.isFinite(L)) { worst = Infinity; where = `${f}/${p}/${lat}/${pn} NaN@${d}`; break; }
      if (prev - L > worst) { worst = prev - L; where = `${f} GHz p=${p} lat=${lat} ${pn} @${d.toFixed(0)} km`; }
      prev = L;
    }
    n++;
  }
  ok(`预测损耗随距离单调不减（${n} 组扫描）`, worst <= 1e-9, worst > 0 ? `最大回落 ${worst} dB @ ${where}` : '');
}
{
  let mono = true, last = -Infinity, lastD = 0;
  for (let Lb = 120; Lb <= 260; Lb += 2) {
    const r = A.mode1RequiredDistance({ fGHz: 4, p: 0.0017, latDeg: 39.9, zones: [{ zone: 'A2', lengthKm: 60 }, { zone: 'B' }], esRole: 'rx', Lb });
    if (r.distanceKm < lastD - 1e-9) mono = false;
    lastD = r.distanceKm; last = Lb;
  }
  ok('所需损耗越大，模式 (1) 距离越远（单调不减）', mono, `Lb 至 ${last} dB 时 ${lastD.toFixed(1)} km`);
  const at = (eh) => A.mode1RequiredDistance({ fGHz: 6.2, p: 0.0025, latDeg: 30, zones: 'A2', esRole: 'tx', Lb: 165, horizon: { elevDeg: eh, distKm: 2 } }).distanceKm;
  ok('场地屏蔽：地平线越高距离越短（−1° ≥ 0° ≥ 0.5° ≥ 2°）', at(-1) >= at(0) && at(0) >= at(0.5) && at(0.5) >= at(2), `${at(-1)} / ${at(0)} / ${at(0.5)} / ${at(2)}`);
  const withC = A.mode1RequiredDistance({ fGHz: 6.2, p: 0.0025, latDeg: 30, zones: 'A2', esRole: 'tx', Lb: 165 }).distanceKm;
  const noC = A.mode1RequiredDistance({ fGHz: 6.2, p: 0.0025, latDeg: 30, zones: 'A2', esRole: 'tx', Lb: 165, correction: false }).distanceKm;
  ok('固定业务修正缩短陆地路径距离（不修正 ≥ 修正）', noC >= withC && noC > withC, `${noC} > ${withC}`);
  const sea = (z) => A.mode1RequiredDistance({ fGHz: 6.2, p: 0.0025, latDeg: 30, zones: z, esRole: 'tx', Lb: 175, correction: false }).distanceKm;
  ok('同一所需损耗：海路（B）远于内陆（A2）（海上波导）', sea('B') > sea('A2'), `${sea('B')} > ${sea('A2')}`);
}

// AP7 原文性质 ①：附件 1 §2 冷海后接暖海时全段按暖海，损耗在暖海出现处跌落
{
  const s = A.mode1Setup({ fGHz: 0.6, p: 10, latDeg: 32, zones: [{ zone: 'B', lengthKm: 120 }, { zone: 'C' }], Lb: 0, esRole: 'tx' });
  const before = s.lossAt(119.9, true).lossDb, after = s.lossAt(120.1, true).lossDb;
  ok('原文性质：§2「冷暖海并存按暖海」在暖海出现处损耗跌落（实现照原文）', before - after > 3, `跌落 ${(before - after).toFixed(2)} dB`);
}

console.log('\n=== ③ 附件 2：模式 (2) 雨散射 ===');
for (const zone of ['A', 'D', 'K', 'M', 'P']) {
  for (const p of [0.001, 0.003, 0.01, 0.05, 0.1, 0.3, 1, 2.5, 9]) {
    approx(`R(${p}%) 雨区 ${zone} 式(63)–(68)`, A.rainRate(zone, p).R, refRain(zone, p), 1e-9);
  }
}
approx('R(0.01%) 雨区 K 手算 4.17×0.01^−0.418 + 1.6×lg³30 = 33.7415', A.rainRate('K', 0.01).R, 33.7415, 1e-3);
ok('p ≥ pc 时 R = 0（表 4，K 区 pc = 5%）', A.rainRate('K', 5).R === 0 && A.rainRate('K', 7).R === 0);
for (const zone of ['A', 'C', 'F', 'L', 'N']) {
  const gap = A.rainRate(zone, 0.3 - 1e-9).R - A.rainRate(zone, 0.3).R;
  ok(`雨区 ${zone}：式(63)–(67) 与式(68) 在 0.3% 处的跳变 < 0.3 mm/h`, Math.abs(gap) < 0.3, `跳变 ${gap.toFixed(3)} mm/h`);
}
ok('无效雨区（I）返回 error', !!A.rainRate('I', 0.01).error);
for (const [z, reg, want] of [[39.9, 'other', 5 - 0.075 * 16.9], [10, 'other', 5], [-10, 'other', 5], [-40, 'other', 5 + 0.1 * (-19)], [-75, 'other', 0], [50, 'naEurope', 3.2 - 0.075 * 15]]) {
  approx(`hR(${z}°, ${reg}) 式(74)(75)`, A.rainHeight(z, reg).hR, want, 1e-12);
}
ok('式(74) 只定义 35°–70°：北美 30° 改用式(75a) 并给警告', A.rainHeight(30, 'naEurope').eq === '75a' && A.rainHeight(30, 'naEurope').warnings.length === 1);
ok('式(75a) 极区为负时截到 0', A.rainHeight(89.9, 'other').hR === 0);
for (const row of [[1, 0.0000352, 0.880], [4, 0.000591, 1.075], [22.4, 0.090, 1.05], [40.5, 0.318, 0.926]]) {
  const r = A.rainKAlpha(row[0]);
  ok(`表 5 节点 ${row[0]} GHz：k、α 原值`, Math.abs(r.k - row[1]) < 1e-15 && Math.abs(r.alpha - row[2]) < 1e-12);
}
{
  const t = (lg(5) - lg(4)) / (lg(6) - lg(4));
  approx('表 5 插值 5 GHz：lg k 对 lg f 线性', A.rainKAlpha(5).k, 10 ** (lg(0.000591) + t * (lg(0.00155) - lg(0.000591))), 1e-15);
  approx('表 5 插值 5 GHz：α 对 lg f 线性', A.rainKAlpha(5).alpha, 1.075 + t * (1.265 - 1.075), 1e-12);
}
{
  // 20 GHz（表 5 节点，k = 0.0691、α = 1.065）、R 由雨区 K、p = 0.01% 给出
  const f = 20, p = 0.01, lat = 39.9, Gx = 45, L = 150;
  const s = A.mode2Setup({ fGHz: f, p, L, Gx, latDeg: lat, rainZone: 'K' });
  const R = refRain('K', p), hR = 5 - 0.075 * (lat - 23);
  for (const ri of [150, 320]) {
    const ref = refLr({ f, R, hR, ri, Gx, k: 0.0691, alpha: 1.065 });
    const got = A.mode2PathLoss(s, ri);
    approx(`Lr 20 GHz ri = ${ri}：Lar 式(78)`, got.LarDb, ref.Lar, 1e-12);
    approx(`Lr 20 GHz ri = ${ri}：Ab 式(79)`, got.AbDb, ref.Ab, 1e-12);
    approx(`Lr 20 GHz ri = ${ri}：式(82)`, got.lossDb, ref.Lr, 1e-9);
  }
  const ref = refLr({ f, R, hR, ri: 100, Gx, k: 0.0691, alpha: 1.065 });
  approx('γR 式(70)', s.gammaR, ref.gR, 1e-12);
  approx('ds 式(71)', s.dsKm, ref.ds, 1e-12);
  approx('Rcv 式(72)', s.Rcv, ref.Rcv, 1e-12);
  approx('Γ2 式(73)', s.Gamma2, ref.G2, 1e-12);
  approx('γwr 式(76)', s.gammaWr, ref.gwr, 1e-12);
  approx('dmax2 = √(17 000 (hR + 3))（附件 2 §2）', s.dmax2Km, Math.sqrt(17000 * (hR + 3)), 1e-9);
  const ref4 = refLr({ f: 4, R: 50, hR, ri: 200, Gx: 42, k: 0.000591, alpha: 1.075 });
  approx('Lr 4 GHz（Ab = 0）、R = 50 mm/h 直接给定', A.mode2PathLoss(A.mode2Setup({ fGHz: 4, p: 0.01, L: 150, Gx: 42, latDeg: lat, rainRateMmH: 50 }), 200).lossDb, ref4.Lr, 1e-9);
}
{
  const o = { fGHz: 6.2, p: 0.0025, L: 133, Gx: 46, latDeg: 30, rainZone: 'K' };
  const r = A.mode2RequiredDistance(o);
  const s = r._setup;
  const prev = r.distanceKm - 1 >= r.dminKm ? A.mode2PathLoss(s, r.distanceKm - 1).lossDb : -Infinity;
  ok('模式 (2) 迭代：第一个满足 Lr ≥ L 的网格点（式(62a)(77)）', r.stoppedBy === 'loss' && r.lossAtDistanceDb >= o.L && prev < o.L, `dr = ${r.distanceKm.toFixed(1)} km`);
  const rmax = A.mode2RequiredDistance(Object.assign({}, o, { L: 250 }));
  ok('模式 (2)：所需损耗极大时 dr = dmax2（式(62b)）', rmax.stoppedBy === 'dmax' && rmax.distanceKm === rmax.dmax2Km);
  const rout = A.mode2RequiredDistance(Object.assign({}, o, { fGHz: 0.8 }));
  ok('模式 (2)：1–40.5 GHz 以外雨散射可忽略，dr = dmin（§5.1）', rout.neglected === 'frequency' && rout.distanceKm === rout.dminKm);
  const rnr = A.mode2RequiredDistance(Object.assign({}, o, { p: 6 }));
  ok('模式 (2)：p 超过 pc 时 R = 0，按可忽略处理', rnr.neglected === 'noRain' && rnr.warnings.length === 0);
  let mono = true, prevL = -Infinity;
  for (let ri = s.dminKm; ri <= s.dmax2Km; ri += 0.5) { const L = A.mode2PathLoss(s, ri).lossDb; if (L < prevL - 1e-12) mono = false; prevL = L; }
  ok('模式 (2)：f < 10 GHz（Ab ≡ 0）时 Lr 随距离单调', mono);
  // AP7 原文性质 ②：f > 10 GHz 时 Lar 起始处 Ab 归零，Lr 跌落
  const s20 = A.mode2Setup({ fGHz: 20, p: 0.01, L: 150, Gx: 45, latDeg: 39.9, rainZone: 'K' });
  const on = s20.larOnsetKm;
  const drop = A.mode2PathLoss(s20, on - 1e-6).lossDb - A.mode2PathLoss(s20, on + 1e-3).lossDb;
  ok('原文性质：式(79b) 在 Lar 起始处使 Ab 归零，Lr 跌落数 dB（实现照原文）', drop > 1, `起始 ${on.toFixed(1)} km，跌落 ${drop.toFixed(2)} dB`);
}
{
  // 等值线几何（附件 2 §4）：偏心圆，Δd = hR/(2 tan εs)，且 ≤ dr − 50
  const o = { fGHz: 6.2, p: 0.0025, L: 145, Gx: 46, latDeg: 30, rainZone: 'K', beamElevDeg: 12, beamAzDeg: 200,
    azimuthsDeg: Array.from({ length: 72 }, (_, k) => k * 5) };
  const c = A.mode2Contour(o);
  const circ = c.circles[0], dr = c.mode2.distanceKm, hR = c.mode2.hRKm;
  approx('Δd 式(83) = hR / (2 tan εs)', circ.deltaDKm, Math.min(hR / (2 * Math.tan(rad(12))), dr - 50), 1e-12);
  let geomOk = true;
  c.azimuthsDeg.forEach((a, k) => {
    const x = c.distancesKm[k] * Math.sin(rad(a)), y = c.distancesKm[k] * Math.cos(rad(a));
    const cx = circ.deltaDKm * Math.sin(rad(200)), cy = circ.deltaDKm * Math.cos(rad(200));
    const rc = Math.hypot(x - cx, y - cy);
    if (c.distancesKm[k] > c.mode2.dminKm + 1e-9 && Math.abs(rc - dr) > 1e-6) geomOk = false;
    if (c.distancesKm[k] < c.mode2.dminKm - 1e-9) geomOk = false;
  });
  ok('模式 (2) 等值线：各点到圆心距离 = dr（dmin 圆内的弧取 dmin）', geomOk);
  const i200 = c.azimuthsDeg.indexOf(200), i20 = c.azimuthsDeg.indexOf(20);
  approx('主波束方位上距离 = dr + Δd', c.distancesKm[i200], dr + circ.deltaDKm, 1e-9);
  approx('反方位上距离 = dr − Δd', c.distancesKm[i20], Math.max(c.mode2.dminKm, dr - circ.deltaDKm), 1e-9);
  const lim = A.mode2CentreOffset(4, 0.5, 120);
  ok('Δd 限于 dr − 50（低仰角时）', lim.limited && lim.deltaDKm === 70);
  const two = A.mode2Contour(Object.assign({}, o, { beams: [{ elevDeg: 12, azDeg: 200 }, { elevDeg: 5, azDeg: 195 }] }));
  ok('倾斜轨道两极端星位：雨散射区为两圆之并（逐方位取大）', two.distancesKm.every((d, k) => d >= c.distancesKm[k] - 1e-9));
}

console.log('\n=== ④ 附件 3：GSO 视角几何与参考方向图 ===');
{
  let maxE = 0, maxA = 0;
  for (const [lat, i, dl] of [[39.9, 0, -5.9], [39.9, 0, -50], [43, 0, -28], [-33.9, 0, 30], [10, 3, 70], [60, -5, 10], [0.5, 0, 0.2], [25, 8, -40]]) {
    const m = A.gsoLookAngles(lat, i, dl), v = vecLook(lat, i, dl);
    maxE = Math.max(maxE, Math.abs(m.elevDeg - v.elevDeg));
    const da = Math.abs(((m.azDeg - v.azDeg + 540) % 360) - 180);
    maxA = Math.max(maxA, da);
  }
  ok('式(84)–(88) 仰角与三维矢量法一致（< 1e-9°）', maxE < 1e-9, `max ${maxE.toExponential(2)}`);
  ok('式(84)–(88) 方位与三维矢量法一致（< 1e-7°）', maxA < 1e-7, `max ${maxA.toExponential(2)}`);
  const s = A.gsoLookAngles(43, 0, -28);
  // 手算：cos ψ = cos 43° cos 28°，εs = atan((cos ψ − 1/6.62)/sin ψ)；北半球卫星在西：αs = 180° + atan(tan 28° / sin 43°)
  approx('43°N 看 28°W 卫星（图 6 场景）：仰角', s.elevDeg, 32.9384, 1e-3);
  approx('43°N 看 28°W 卫星（图 6 场景）：方位', s.azDeg, 217.9412, 1e-3);
  let maxPhi = 0;
  for (const [a, eh, ba, be] of [[190, 2, 217.9, 32.9], [110, 0, 150, 20], [0, -1, 180, 45], [250, 5, 241, 21]]) {
    maxPhi = Math.max(maxPhi, Math.abs(A.offAxisToHorizon(a, eh, ba, be) - angBetween(dirVec(a, eh), dirVec(ba, be))));
  }
  ok('式(89) 与矢量夹角一致', maxPhi < 1e-9, `max ${maxPhi.toExponential(2)}`);
  let incOk = true;
  for (const a of [0, 60, 120, 180, 220, 300]) {
    const c1 = A.horizonOffAxisGso({ latDeg: 39.9, deltaLonDeg: -50, azDeg: a, horizonElevDeg: 1 });
    const c2 = A.horizonOffAxisGso({ latDeg: 39.9, deltaLonDeg: -50, inclinationDeg: 5, azDeg: a, horizonElevDeg: 1 });
    if (!(c2.phiDeg <= c1.phiDeg + 1e-9) || c2.case !== 2 || c1.case !== 1) incOk = false;
  }
  ok('倾斜轨道 Case 2 的 φ(α) 不大于 Case 1（式(91)–(95) 取包络最小）', incOk);
  approx('式(96) δs = (is/15)²：is = 6° → 0.16°', A.horizonOffAxisGso({ latDeg: 30, deltaLonDeg: 10, inclinationDeg: 6, azDeg: 90 }).deltaSDeg, 0.16, 1e-12);
}
{
  for (const [Gmax, dl] of [[52, 200], [45, 50], [47.7, 100]]) {
    for (const phi of [0, 0.1, 0.3, 0.5, 0.8, 1.5, 3, 10, 35.9, 36, 120]) {
      approx(`式(97) G(${phi}°)，Gamax = ${Gmax}、D/λ = ${dl}`, A.esReferencePattern(phi, { GmaxDbi: Gmax, dOverLambda: dl }), refPattern97(phi, Gmax, dl), 1e-9);
    }
  }
  const pp = A.annex3PatternParams(52, 200);
  approx('式(97) 在 φr 处连续：29 − 25 lg φr = G1（D/λ ≥ 100）', 29 - 25 * lg(pp.phiR), pp.G1, 0.01);
  const pq = A.annex3PatternParams(45, 50);
  approx('式(97) 在 φr 处连续（35 ≤ D/λ < 100）', 29 - 25 * lg(pq.phiR), pq.G1, 1e-9);
  approx('D/λ 未给时按 20 lg(D/λ) ≈ Gamax − 7.7 估算', A.annex3PatternParams(47.7).dOverLambda, 100, 1e-9);
  ok('D/λ < 35 给警告', A.annex3PatternParams(30, 20).warnings.length > 0);
  const hg = A.horizonGainGso({ latDeg: 39.9, deltaLonDeg: -50, horizon: [{ azDeg: 240, elevDeg: 2 }, { azDeg: 60, elevDeg: 0 }], antenna: { GmaxDbi: 44, dOverLambda: 60 } });
  ok('地平线增益 = G(φ(α))', hg.points.every(p => Math.abs(p.gainDbi - refPattern97(p.phiDeg, 44, 60)) < 1e-9));
}

console.log('\n=== ⑤ 附件 4 / 5 / 6、附件 7 §2、表 10 注 1 ===');
{
  for (const [gmax, gmin, want] of [[20, 5, 20], [25, 5, 25], [30, 5, 25], [34, 5, 25], [35, 5, 25], [40, 5, 30]]) {
    approx(`式(5) TIG：Gmax = ${gmax}、Gmin = ${gmin}`, A.tigHorizonGain(gmax, gmin), want, 1e-12);
  }
  const sep = A.nonGsoHorizonSeparation(10, 1);
  ok('附件 4 §1：φmin = εsys − εh、φmax = 180 − εsys − εh', sep.phiMinDeg === 9 && sep.phiMaxDeg === 169);
  ok('附件 4 §1：φmin 不小于 0', A.nonGsoHorizonSeparation(2, 5).phiMinDeg === 0);
  const cs = (lat, is, alt) => A.constellationVisibility({ latDeg: lat, inclinationDeg: is, altitudeKm: alt }).cases.join(',');
  ok('附件 4 §1.1 情形判定（is = 52°、1 414 km）：10°→1、30°→2、48°→3、60°→4、88°→无', cs(10, 52, 1414) === '1' && cs(30, 52, 1414) === '2' && cs(48, 52, 1414) === '3' && cs(60, 52, 1414) === '4' && cs(88, 52, 1414) === '');
  ok('附件 4 §1.1 情形判定（is = 10°、8 000 km）：2°→2+6、7°→3+6、40°→4+6', cs(2, 10, 8000) === '2,6' && cs(7, 10, 8000) === '3,6' && cs(40, 10, 8000) === '4,6');
  // 独立重算：40°N、is = 10°、K1 = (6378.14 + 8000)/6378.14；Case 6 正南（δ = 0、以 −is 代入）的 εv
  const K1 = (6378.14 + 8000) / 6378.14, ze = 40, is = 10;
  const cpsi = Math.sin(rad(ze)) * Math.sin(rad(-is)) + Math.cos(rad(ze)) * Math.cos(rad(-is));               // (98)
  const evS = deg(Math.asin((K1 * cpsi - 1) / Math.sqrt(1 + K1 * K1 - 2 * K1 * cpsi)));                      // (99)
  const vis = A.constellationVisibility({ latDeg: 40, inclinationDeg: 10, altitudeKm: 8000 });
  approx('附件 4 Case 6：正南最小可见仰角 = 式(98)(99) 独立值', vis.elevAt(180), evS, 1e-9);
  const psiM = deg(Math.acos(1 / K1));
  const a2 = deg(Math.acos((Math.sin(rad(is)) - Math.cos(rad(psiM)) * Math.sin(rad(ze))) / (Math.sin(rad(psiM)) * Math.cos(rad(ze)))));
  approx('附件 4 Case 4：α2 独立重算', vis.alpha2Deg, a2, 1e-9);
  ok('附件 4 Case 4：α0 < α2 的方位 90° 以下无星可见（εv = 90）', vis.elevAt(30) === 90 && vis.elevAt(330) === 90);
  const visS = A.constellationVisibility({ latDeg: -40, inclinationDeg: 10, altitudeKm: 8000 });
  approx('附件 4 式(101)：南半球按 180° − α0 镜像', visS.elevAt(0), vis.elevAt(180), 1e-12);
  const prof = Array.from({ length: 360 }, (_, k) => ({ azDeg: k, elevDeg: 10 }));
  const s102 = A.separationFromProfile({ azDeg: 35, horizonElevDeg: 1, profile: prof });
  ok('附件 4 式(102)：平剖面 εc ≡ εsys 时退化为 §1 的 φmin/φmax', Math.abs(s102.phiMinDeg - 9) < 1e-9 && Math.abs(s102.phiMaxDeg - 169) < 1e-9);
}
{
  const em = 3, z = 40;
  const db = deg(Math.acos(Math.sin(rad(em) + Math.asin(Math.cos(rad(em)) / 6.62)) / Math.cos(rad(z))));      // (103)
  approx('附件 5 式(103) δb（40°、εmin = 3°）', A.bidirectionalReceiverHorizonGain({ latDeg: z, minElevDeg: em, azDeg: 90 }).deltaBDeg, db, 1e-9);
  approx('δb 手算 = 74.681°', db, 74.681, 1e-3);
  const e90 = A.bidirectionalReceiverHorizonGain({ latDeg: 0, minElevDeg: 3, azDeg: 270 });
  const e0 = A.bidirectionalReceiverHorizonGain({ latDeg: 0, minElevDeg: 3, azDeg: 180 });
  approx('图 8 特征点：赤道站朝东地平线（αr = 90°）到 GSO 最小夹角 = εmin', e90.phiDeg, 3, 1e-9);
  approx('图 8 特征点：赤道站朝北地平线（αr = 0°）到 GSO 最小夹角 = 90°', e0.phiDeg, 90, 1e-9);
  approx('附件 5 §2.1：αr = α ± 180°', A.bidirectionalReceiverHorizonGain({ latDeg: 20, minElevDeg: 5, azDeg: 30 }).alphaRDeg, 210, 1e-12);
  approx('Gr 用附件 3 方向图（Gm 缺省 42 dBi）', e90.gainDbi, refPattern97(3, 42, 10 ** ((42 - 7.7) / 20)), 1e-9);
  const alt = A.bidirectionalReceiverHorizonGain({ latDeg: 0, minElevDeg: 3, azDeg: 270, pattern: 'alt' });
  approx('表 9b 脚注 10 替代方向图 32 − 25 lg φ', alt.gainDbi, 32 - 25 * lg(3), 1e-9);
  ok('高于 ζmax 的纬度：看不到 GSO，返回 error', !!A.bidirectionalReceiverHorizonGain({ latDeg: 80, minElevDeg: 5, azDeg: 0 }).error);

  const b = A.bidirectionalRainScatterArea({ fGHz: 11, latDeg: 40, esElevDeg: 10, esAzDeg: 254, minElevDeg: 5 });   // 图 9 的假设：40°N、εs = 10°、αs = 254°
  const hR = 5 - 0.075 * (40 - 23);
  approx('附件 5 式(104) ds', b.dsKm, 8500 * (Math.sqrt(Math.tan(rad(10)) ** 2 + hR / 4250) - Math.tan(rad(10))), 1e-9);
  approx('附件 5 §3 demax = max(130.4 √hR, dmin)', b.demaxKm, Math.max(130.4 * Math.sqrt(hR), refDmin(11, 40)), 1e-9);
  const zmax = deg(Math.acos(Math.cos(rad(5)) / 6.62)) - 5;
  approx('附件 5 式(105) ζmax', b.zetaMaxDeg, zmax, 1e-9);
  approx('附件 5 §3 αw1 = arccos(tan ζ / tan ζmax)', b.alphaW1Deg, deg(Math.acos(Math.tan(rad(40)) / Math.tan(rad(zmax)))), 1e-9);
  ok('雨散射区各方位不小于 dmin', b.distancesKm.every(d => d >= b.dminKm - 1e-9));
  const far = (aw) => Math.hypot(b.pointII.xKm + b.demaxKm * Math.sin(rad(aw)), b.pointII.yKm + b.demaxKm * Math.cos(rad(aw)));
  const maxD = Math.max(...b.distancesKm);
  ok('雨散射区最远点位于 αw2 方向的弧上（点 II 偏西南，西侧弧更远）', Math.abs(maxD - far(b.alphaW2Deg)) < 3, `${maxD.toFixed(1)} vs ${far(b.alphaW2Deg).toFixed(1)}`);
  const bc = A.bidirectionalRainScatterArea({ fGHz: 11, latDeg: 80, esElevDeg: 10, esAzDeg: 180, minElevDeg: 5 });
  ok('纬度高于 ζmax：雨散射区为 dmin 圆', bc.circleOnly && bc.distancesKm.every(d => d === bc.dminKm));
}
{
  // 附件 6 §3.2.3 视距中继天线方向图
  const rr = (phi, G, dl) => A.radioRelayReferencePattern(phi, { GmaxDbi: G, dOverLambda: dl });
  const G1a = 2 + 15 * lg(200), phiMa = 20 / 200 * Math.sqrt(45 - G1a), phiRa = 15.85 * 200 ** -0.6;
  approx('式(111) 主瓣', rr(0.2, 45, 200), 45 - 2.5e-3 * (200 * 0.2) ** 2, 1e-12);
  ok('式(111)(112) 分界 φm 在 (0.2°, 0.5°)', phiMa > 0.2 && phiMa < 0.5);
  approx('式(112) 第一旁瓣 G1 = 2 + 15 lg(D/λ)', rr((phiMa + phiRa) / 2, 45, 200), G1a, 1e-12);
  approx('式(113) 32 − 25 lg φ', rr(10, 45, 200), 32 - 25, 1e-12);
  approx('式(114) −10', rr(60, 45, 200), -10, 1e-12);
  approx('式(120) 52 − 10 lg(D/λ) − 25 lg φ（D/λ = 50）', rr(10, 40, 50), 52 - 10 * lg(50) - 25, 1e-12);
  approx('式(121) 10 − 10 lg(D/λ)', rr(100, 40, 50), 10 - 10 * lg(50), 1e-12);
  approx('式(119)(120) 在 φ = 100λ/D 处连续', rr(2 - 1e-9, 40, 50), rr(2, 40, 50), 1e-6);
  approx('式(122) D/λ 估算：Gamax = 47.7 → D/λ = 100 → (b) 分支', rr(100, 47.7), 10 - 10 * lg(100), 1e-9);

  // 附件 6 §3.2.2 模式 (2) 辅助等值线
  const m2o = { fGHz: 6.2, p: 0.0025, L: 150, Gx: 46, latDeg: 30, rainZone: 'K' };
  const main = A.mode2RequiredDistance(m2o);
  const ax = (phi) => A.mode2AuxiliaryContour({ mode2Options: m2o, beamElevDeg: 8, beamAvoidanceDeg: phi });
  const a2 = ax(2), a5 = ax(5);
  ok('辅助等值线：rb 不超过主等值线 dr、不小于 dmin 截平', a5.points.every(p => p.rbKm <= main.distanceKm + 1e-9 && (p.status === 'dmin' || p.dKm >= a5.dminKm - 1e-6)));
  ok('辅助等值线：回避角越大，rb 越小（逐 ω 不增）', a5.points.every((p, k) => p.rbKm <= a2.points[k].rbKm + 1e-9));
  const pw = a2.points[90];
  const b2 = a2.bKm, p1 = deg(Math.atan(b2 * Math.sin(rad(90)) / (2 * pw.rbKm - b2 * Math.cos(rad(90))))), p2 = deg(Math.atan(b2 * Math.sin(rad(90)) / (2 * pw.rbKm + b2 * Math.cos(rad(90)))));
  if (pw.status !== 'dmin') {
    approx('式(109) d = 0.5 b sin ω / sin ψ2（ω = 90°）', pw.dKm, 0.5 * b2 / Math.sin(rad(p2)), 1e-9);
    approx('式(110) θd = ω − ψ2', pw.thetaDeg, 90 - p2, 1e-9);
  } else ok('ω = 90° 点与 dmin 圆重合', true);
  ok('式(106)–(108) ψ = ψ1 + ψ2 为正且小于 φ 时进入递减（ω = 90°）', p1 > 0 && p2 > 0);
  ok('ω = 0°：d 取极限 rb + b/2、θd = 0', Math.abs(a2.points[0].thetaDeg) < 1e-12 && Math.abs(a2.points[0].dKm - (a2.points[0].rbKm + a2.bKm / 2)) < 1e-9 || a2.points[0].status === 'dmin');

  // 附件 6 §4 TVG：增益在 [Gmin, Gmax] 均匀分布
  const mo = { fGHz: 6.2, latDeg: 30, zones: 'A2', esRole: 'tx' };
  const tvg = A.tvgRequiredDistance({ mode1Options: mo, Pt: 10, Gx: 46, Pr: -103, p: 0.0025, GminDbi: -10, GmaxDbi: 10, gStepDb: 0.5,
    gainCcdf: (G) => Math.max(0, Math.min(100, 100 * (10 - G) / 20)) });
  const tig = A.mode1RequiredDistance(Object.assign({}, mo, { p: 0.0025, Lb: 10 + 10 + 46 + 103 }));   // TIG：Gmax − Gmin = 20 → Ge = Gmax
  ok('TVG 距离不大于 TIG 距离（附件 6 §4「通常更小」）且落在 [dmin, dmax1]', tvg.distanceKm <= tig.distanceKm && tvg.distanceKm >= tig.dminKm, `TVG ${tvg.distanceKm.toFixed(1)} / TIG ${tig.distanceKm.toFixed(1)} km`);
  ok('TVG 式(124)(125)：Gen 步进 g、pv = 100 p / pn 且只取 pn ≥ 2p', tvg.steps.every((s, k) => Math.abs(s.pv - 100 * 0.0025 / s.pn) < 1e-12 && s.pn >= 0.005) && Math.abs(tvg.steps[1].GenDbi - tvg.steps[0].GenDbi - 0.5) < 1e-12);
}
{
  approx('附件 7 式(127)：Te = 750 K、B = 1 MHz、Ms = 37、NL = W = 0', A.permissibleInterferencePower({ TeK: 750, BHz: 1e6, NLdB: 0, MsdB: 37, WdB: 0 }), pr127(750, 1e6, 0, 37, 0), 1e-12);
  approx('附件 7 式(127)：k 取原文 1.38×10⁻²³', A.K_BOLTZMANN_AP7, 1.38e-23, 0);
  approx('附件 7 式(128)：Te = Ta + (ℓt1 − 1) 290 + ℓt1 Tr', A.noiseTemperature({ TaK: 40, TrK: 60, lt1: 1.12 }), 40 + 0.12 * 290 + 1.12 * 60, 1e-12);
  approx('附件 7 式(128)：ℓt1 缺省 1.0', A.noiseTemperature({ TaK: 40, TrK: 60 }), 100, 1e-12);
  ok('附件 7 表 6：f < 10 → 75 K、10–17 → 150 K、> 17 → 300 K（端点取低值）',
    A.bidirectionalNoiseTemperature(6) === 75 && A.bidirectionalNoiseTemperature(10) === 75 && A.bidirectionalNoiseTemperature(12) === 150
    && A.bidirectionalNoiseTemperature(17) === 150 && A.bidirectionalNoiseTemperature(20) === 300);
  ok('式(127) 缺 Te 返回 error', !!A.permissibleInterferencePower({ BHz: 1e6, MsdB: 2 }).error);
  approx('§1.3 式(1) Lb = Pt + Gt + Gr − Pr', A.requiredLossMode1({ Pt: 10, Gt: 5, Gr: 46, Pr: -103 }), 164, 1e-12);
  const m2 = A.requiredLossMode2({ Pt: 13, Pr: -150, Gx: 42 });
  ok('§1.3 式(3) L = Pt − Pr、式(2) Lx = Pt + Gx − Pr', m2.L === 163 && m2.Lx === 205);
  for (const [e, want] of [[0, 582], [-2, 582], [5, 582 * (Math.sqrt(1 + (0.254 * 5) ** 2) - 0.254 * 5)], [11, 100], [15, 100]]) {
    approx(`表 10 注 1：εh = ${e}°`, A.predeterminedDistanceMetAids(e), want, 1e-9);
  }
}

console.log('\n=== ⑦ 表 7–10 转录 ===');
{
  const counts = { '7a': 16, '7b': 22, '7c': 9, '8a': 14, '8b': 14, '8c': 19, '8d': 15, '9a': 12, '9b': 12 };
  const keys = { tx: ['service', 'bandsGHz', 'bandsText', 'terrestrialServices', 'method', 'modulation', 'p0', 'n', 'p', 'NL', 'Ms', 'W', 'Gx', 'Te', 'B', 'Pr', 'fn'],
    rx: ['service', 'bandsGHz', 'bandsText', 'terrestrialServices', 'method', 'modulation', 'p0', 'n', 'p', 'NL', 'Ms', 'W', 'E', 'Pt', 'Gx', 'B', 'Pr', 'fn'],
    bidirectional: ['service', 'bandsGHz', 'bandsText', 'rxService', 'orbit', 'modulation', 'p0', 'n', 'p', 'NL', 'Ms', 'W', 'Gm', 'Gr', 'grMethod', 'epsMinDeg', 'Te', 'B', 'Pr', 'fn'] };
  const numOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
  for (const t of A.PARAMETER_TABLES) {
    let structOk = t.columns.length === counts[t.id];
    for (const c of t.columns) {
      if (!keys[t.kind].every(k => k in c)) structOk = false;
      if (!c.bandsGHz.length || !c.bandsGHz.every(b => b.length === 2 && b[0] < b[1] && b[0] >= 0.1 && b[1] <= 105)) structOk = false;
      for (const k of ['p0', 'n', 'p', 'NL', 'Ms', 'W', 'Gx', 'B', 'Pr']) if (k in c && !numOrNull(c[k])) structOk = false;
      if (c.E && !(numOrNull(c.E.A) && numOrNull(c.E.N) && numOrNull(c.Pt.A) && numOrNull(c.Pt.N))) structOk = false;
      for (const refs of Object.values(c.fn)) for (const r of refs) if (!t.footnotes[r]) structOk = false;
      // 原表 p 按两位有效数字印刷（0.005/3 印作 0.0017），按印刷值比较
      const q = c.p0 / c.n;
      if (c.p !== null && c.p0 !== null && c.n !== null && Math.abs(c.p - q) > 1e-12 && Math.abs(c.p - Number(q.toPrecision(2))) > 1e-12 && !(t.id === '7c' && c.Gx === 0)) structOk = false;
    }
    ok(`表 ${t.id}（${t.revision}，${t.page}）：列数 ${counts[t.id]}、字段齐全、频段有效、脚注有对应、p = p0/n`, structOk);
  }
  const T7b = A.TABLE_7.b.columns, T8b = A.TABLE_8.b.columns;
  const c7N = T7b.find(c => c.bandsText === '5.725-7.075' && c.modulation === 'N');
  ok('表 7b 5.725–7.075 GHz N：p0 0.005 / p 0.0025 / Ms 37 / Gx 46 / Te 750 / B 10⁶ / Pr −103',
    c7N.p0 === 0.005 && c7N.p === 0.0025 && c7N.Ms === 37 && c7N.Gx === 46 && c7N.Te === 750 && c7N.B === 1e6 && c7N.Pr === -103);
  const c7A = T7b.find(c => c.bandsText === '5.725-7.075' && c.modulation === 'A');
  ok('表 7b 5.725–7.075 GHz A：Ms 33 / B 4×10³ / Pr −131', c7A.Ms === 33 && c7A.B === 4e3 && c7A.Pr === -131);
  const c7r = T7b.find(c => c.bandsText === '13.75-14.3');
  ok('表 7b 13.75–14.3 GHz：n 1 / Ms 1 / Gx 36 / Te 2 636 / B 10⁷ / Pr −131', c7r.n === 1 && c7r.Ms === 1 && c7r.Gx === 36 && c7r.Te === 2636 && c7r.B === 1e7 && c7r.Pr === -131);
  ok('表 7b 2.655–2.690 GHz：Ms 26²、Gx 49²、Te 500²（脚注 2）', T7b[0].Ms === 26 && T7b[0].fn.Ms[0] === 2 && T7b[0].Gx === 49 && T7b[0].Te === 500);
  const c7a = A.TABLE_7.a.columns;
  ok('表 7a 148–149.9 MHz：p 1.0 / Gx 8 / B 4×10³ / Pr −153', c7a[0].p === 1 && c7a[0].Gx === 8 && c7a[0].B === 4e3 && c7a[0].Pr === -153);
  ok('表 7a 449.75–450.25 MHz：Ms 20 / Gx 16 / B 12.5×10³ / Pr −139', c7a[4].Ms === 20 && c7a[4].Gx === 16 && c7a[4].B === 12.5e3 && c7a[4].Pr === -139);
  const c7c = A.TABLE_7.c.columns;
  ok('表 7c HAPS 地面站列：Gx 0（脚注 5）/ Ms 10 / Te 350 / Pr −134', c7c[1].Gx === 0 && c7c[1].fn.Gx[0] === 5 && c7c[1].Ms === 10 && c7c[1].Te === 350 && c7c[1].Pr === -134);
  ok('表 7c 第 4 列频段为 27.5–28.6 与 29.1–29.5（脚注 3，非 29.53）', c7c[3].bandsGHz[1][1] === 29.5 && c7c[3].fn.bands[0] === 3);
  const c8N = T8b.find(c => c.bandsText === '3.400-4.200' && c.modulation === 'N');
  ok('表 8b 3.4–4.2 GHz N：p 0.0017 / n 3 / NL 1 / Ms 2 / W 0 / E 55·42 / Pt 13·0 / Gx 42 / B 10⁶ / Pr 空',
    c8N.p === 0.0017 && c8N.n === 3 && c8N.NL === 1 && c8N.Ms === 2 && c8N.W === 0 && c8N.E.A === 55 && c8N.E.N === 42
    && c8N.Pt.A === 13 && c8N.Pt.N === 0 && c8N.Gx === 42 && c8N.B === 1e6 && c8N.Pr === null);
  const c8A = T8b.find(c => c.bandsText === '3.400-4.200' && c.modulation === 'A');
  ok('表 8b 3.4–4.2 GHz A：p 0.01 / Ms 7 / W 4', c8A.p === 0.01 && c8A.Ms === 7 && c8A.W === 4);
  ok('表 8b 1.525–1.535 GHz：E 50·37、Pt 13·0、Gx 37、Pr −184', T8b[0].E.A === 50 && T8b[0].E.N === 37 && T8b[0].Pt.A === 13 && T8b[0].Gx === 37 && T8b[0].Pr === -184);
  const c8a = A.TABLE_8.a.columns;
  ok('表 8a 163–167 MHz：E 15 / Pt −1 / Gx 16 / B 10³ / Pr −173', c8a[4].E.A === 15 && c8a[4].Pt.N === -1 && c8a[4].Gx === 16 && c8a[4].B === 1e3 && c8a[4].Pr === -173);
  ok('表 8a 1 518–1 530 MHz：E(A) 37 带脚注 4、Pr −176', c8a[13].E.A === 37 && c8a[13].fn.EA[0] === 4 && c8a[13].Pr === -176);
  const c8c = A.TABLE_8.c.columns;
  ok('表 8c 4.5–4.8 GHz：E 92³·42⁴、Pt 40·0、Gx 52³ʼ⁴', c8c[0].E.A === 92 && c8c[0].E.N === 42 && c8c[0].Pt.A === 40 && c8c[0].Gx === 52 && c8c[0].fn.Gx.join() === '3,4');
  ok('表 8c 6.700–7.075 GHz：Pr −151.2；12.5–12.75 GHz：B 27×10⁶、Pr −131', c8c[3].Pr === -151.2 && c8c[14].B === 27e6 && c8c[15].Pr === -131);
  ok('表 8c 8.025–8.400 GHz（GSO）：Pr −154 带脚注 11', c8c[8].Pr === -154 && c8c[8].fn.Pr[0] === 11);
  const c8d = A.TABLE_8.d.columns;
  ok('表 8d 18.0–18.4 GHz：Ms 18.8、B 10⁷、Pr −115', c8d[0].Ms === 18.8 && c8d[0].B === 1e7 && c8d[0].Pr === -115);
  ok('表 8d 37.5–40.5 GHz non-GSO：p0 0.02、n 与 p 为空、Ms 6.8', c8d[9].p0 === 0.02 && c8d[9].n === null && c8d[9].p === null && c8d[9].Ms === 6.8);
  const c9a = A.TABLE_9.a.columns, c9b = A.TABLE_9.b.columns;
  ok('表 9a 6.700–7.075 GHz：Gm 50.7、Gr 10、εmin 3°、Te 75、Pr −151', c9a[9].Gm === 50.7 && c9a[9].Gr === 10 && c9a[9].epsMinDeg === 3 && c9a[9].Te === 75 && c9a[9].Pr === -151);
  ok('表 9a 1.670–1.675 GHz GSO：Gr 按附件 5（脚注 8）、Te 118、Pr −178', c9a[3].Gr === null && c9a[3].grMethod === 'annex5' && c9a[3].Te === 118 && c9a[3].Pr === -178);
  ok('表 9b 10.7–11.7 GHz non-GSO：Gm 51.9、Gr 10、εmin 6°', c9b[2].Gm === 51.9 && c9b[2].Gr === 10 && c9b[2].epsMinDeg === 6);
  ok('表 9b 12.5–12.75 GHz non-GSO：Gr 11（脚注 11）；19.3–19.6 GSO：附件 5 替代方向图（脚注 10）', c9b[5].Gr === 11 && c9b[5].fn.Gr[0] === 11 && c9b[9].grMethod === 'annex5-alt');
  const T10 = A.TABLE_10.rows;
  ok('表 10：12 行；飞机对飞机 1 000 km、飞机探空 1 080 km、空间研究 880 km、气象卫星行见注 1',
    T10.length === 12 && T10[2].distanceKm === 1000 && T10[4].distanceKm === 1080 && T10[10].distanceKm === 880 && T10[7].distanceKm === null && T10[7].noteRef === 1);
  ok('表 3 / 4 / 5 / 6 抽查', A.TABLE_3.C === 1200 && A.TABLE_4[3].R03 === 9.0 && A.TABLE_4[3].pc === 7.5 && A.TABLE_5[9].fGHz === 22.4 && A.TABLE_5[9].k === 0.090 && A.TABLE_6[1].TeK === 150);
  const hits = A.findColumns({ fGHz: 4.0, table: '8' });
  ok('findColumns(4 GHz, 表 8) 命中 8b 3.4–4.2 GHz A、N 两列', hits.length === 2 && hits.every(h => h.table === '8b'));

  // 表中 Pr 与式 (127) 的一致性
  const devs = [];
  for (const t of A.PARAMETER_TABLES) t.columns.forEach((c, i) => {
    if (c.Pr === null || !(c.Te > 0) || !(c.B > 0) || !(c.Ms > 0)) return;
    devs.push({ id: `${t.id}#${i}`, dev: pr127(c.Te, c.B, c.NL || 0, c.Ms, c.W || 0) - c.Pr });
  });
  const outliers = devs.filter(d => Math.abs(d.dev) > 1);
  ok(`表 7/9 共 ${devs.length} 列可由式(127) 复核：除已知 1 列外全部 ≤ 1 dB`, outliers.length === 1 && outliers[0].id === '9a#2',
    `最大其余偏差 ${Math.max(...devs.filter(d => d.id !== '9a#2').map(d => Math.abs(d.dev))).toFixed(2)} dB`);
  approx('已知项：表 9a 1.670–1.675 GHz non-GSO 列 Pr 表值 −145 与式(127)（Te 370 K）差 1.65 dB', outliers[0].dev, 1.65, 0.01);
}

console.log('\n=== ⑨ 端到端：C 频段 FSS 地球站 ===');
{
  // 站址 39.9°N 116.4°E；GSO 卫星位于站西 50°（66.4°E），仰角约 21.5°；地平线 0.5°–2°；
  // 75°–150° 方位为 A2 120 km + A1 50 km + B（向渤海），其余内陆 A2；雨气候区 K（调用方输入）。
  const lat = 39.9, lon = 116.4, dLon = -50;
  const azs = [];
  for (let a = 0; a < 360; a += 15) {
    azs.push({ azDeg: a, horizonElevDeg: a >= 180 && a <= 300 ? 2.0 : (a < 60 ? 1.0 : 0.5), horizonDistKm: 3,
      zones: a >= 75 && a <= 150 ? [{ zone: 'A2', lengthKm: 120 }, { zone: 'A1', lengthKm: 50 }, { zone: 'B' }] : 'A2' });
  }
  // (a) 3.4–4.2 GHz 接收地球站，表 8b 数字列；Te = 100 K
  const entry = A.findColumns({ fGHz: 4.0, table: '8b', modulation: 'N' })[0];
  const rl = A.requiredLoss({ entry, esTeK: 100 });
  approx('接收站 Pr 由式(127)：10lg(kTB) + 1 + 10lg(10^0.2 − 1) − 0', rl.Pr, pr127(100, 1e6, 1, 2, 0), 1e-9);
  ok('接收站：地面站 Pt 缺省取 A/N 中较大者（13 dBW）、Gx 42、p 0.0017%', rl.Pt === 13 && rl.terrestrialModulation === 'A' && rl.Gx === 42 && rl.p === 0.0017);
  const rx = A.coordinationContour({ fGHz: 4.0, p: rl.p, latDeg: lat, lonDeg: lon, esRole: 'rx', Pt: rl.Pt, Pr: rl.Pr, Gx: rl.Gx,
    azimuths: azs, esAntenna: { GmaxDbi: 44, dOverLambda: 60 }, gso: { deltaLonDeg: dLon }, mode2: { rainZone: 'K' } });
  ok('接收站等值线计算成功', !rx.error, rx.error || '');
  const look = A.gsoLookAngles(lat, 0, dLon);
  ok('等值线 = 每方位 max(模式 (1), 模式 (2))，且不小于 dmin', rx.contourKm.every((c, k) => c === Math.max(rx.mode1Km[k], rx.mode2Km[k]) && c >= rx.dminKm - 1e-9));
  ok('内陆方位模式 (1) 距离在 [dmin, 375 km]', rx.perAzimuth.filter(p => typeof azs.find(a => a.azDeg === p.azDeg).zones === 'string').every(p => p.mode1.distanceKm >= rx.dminKm && p.mode1.distanceKm <= 375));
  const iSat = rx.azimuthsDeg.reduce((b, a, k) => (Math.abs(((a - look.azDeg + 540) % 360) - 180) < Math.abs(((rx.azimuthsDeg[b] - look.azDeg + 540) % 360) - 180) ? k : b), 0);
  ok('地平线增益最大处在卫星方位附近', rx.horizonGainDbi[iSat] === Math.max(...rx.horizonGainDbi), `Ge(${rx.azimuthsDeg[iSat]}°) = ${rx.horizonGainDbi[iSat].toFixed(2)} dBi`);
  const same = (a, b) => rx.perAzimuth.find(p => p.azDeg === a).mode1.distanceKm >= rx.perAzimuth.find(p => p.azDeg === b).mode1.distanceKm;
  ok('同区划同 Ge：地平线 0.5° 的方位比 2° 的方位远（场地屏蔽）', same(345, 300), `${rx.mode1Km[23].toFixed(1)} vs ${rx.mode1Km[20].toFixed(1)} km`);
  const m2c = rx.mode2.circles[0];
  approx('模式 (2) 圆心在卫星方位、Δd = hR/(2 tan εs)', m2c.deltaDKm, (5 - 0.075 * (lat - 23)) / (2 * Math.tan(rad(look.elevDeg))), 1e-9);
  ok('模式 (2) 距离不超过 dmax2，且在本例为 AP7 描述的数百公里量级（200–340 km）', rx.mode2.distanceKm <= rx.mode2.detail.dmax2Km + 1e-9 && rx.mode2.distanceKm > 200);
  ok('接收站模式 (1) 量级：200–375 km（AP7 图 1a 示意为数百公里）', rx.mode1Km.every(d => d > 200 && d <= 400), rx.mode1Km.map(d => d.toFixed(0)).join(' '));
  const hav = (p) => { const a = Math.sin(rad(p.latDeg - lat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(p.latDeg)) * Math.sin(rad(p.lonDeg - lon) / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(a)); };
  ok('等值线经纬度点：大圆距离 = 等值线距离（球面，6371 km）', rx.points.every(p => Math.abs(hav(p) - p.distKm) < 1e-6));
  console.log('      接收站等值线（km）：' + rx.azimuthsDeg.map((a, k) => `${a}°:${rx.contourKm[k].toFixed(0)}${rx.governing[k] === 'mode2' ? '²' : ''}`).join(' '));

  // (b) 5.725–7.075 GHz（5.925–6.425）发射地球站，表 7b 数字列；地球站功率谱密度 −45 dBW/Hz
  const e2 = A.findColumns({ fGHz: 6.2, table: '7b', modulation: 'N' })[0];
  const rl2 = A.requiredLoss({ entry: e2, esPsdDbWPerHz: -45 });
  ok('发射站：Pt = −45 + 10lg(10⁶) = 15 dBW、Pr −103（表值）、Gx 46、p 0.0025%', rl2.Pt === 15 && rl2.Pr === -103 && rl2.PrSource === 'table' && rl2.Gx === 46 && rl2.p === 0.0025);
  const azs2 = azs.map(a => Object.assign({}, a, { horizonElevDeg: a.azDeg >= 180 && a.azDeg <= 300 ? 0.5 : 0 }));
  const tx = A.coordinationContour({ fGHz: 6.2, p: rl2.p, latDeg: lat, esRole: 'tx', Pt: rl2.Pt, Pr: rl2.Pr, Gx: rl2.Gx,
    azimuths: azs2, esAntenna: { GmaxDbi: 47, dOverLambda: 93 }, gso: { deltaLonDeg: dLon }, mode2: { rainZone: 'K' } });
  ok('发射站等值线计算成功', !tx.error, tx.error || '');
  approx('发射站 Lb = Pt + Ge + Gx − Pr（式(4)）', tx.lbDb[0], 15 + tx.horizonGainDbi[0] + 46 + 103, 1e-9);
  ok('发射站：地平线 0° 的方位模式 (1) 距离大于 dmin', tx.perAzimuth.filter((p, k) => azs2[k].horizonElevDeg === 0).every(p => p.mode1.distanceKm > tx.dminKm));
  ok('发射站：地平线 0.5° 的方位（Ah ≈ 17 dB）收缩到 dmin', tx.perAzimuth.filter((p, k) => azs2[k].horizonElevDeg === 0.5).every(p => p.mode1.distanceKm === tx.dminKm));
  const txMob = A.coordinationContour({ fGHz: 6.2, p: rl2.p, latDeg: lat, esRole: 'tx', Pt: rl2.Pt, Pr: rl2.Pr, Gx: rl2.Gx, correction: false,
    azimuths: azs2, esAntenna: { GmaxDbi: 47, dOverLambda: 93 }, gso: { deltaLonDeg: dLon }, mode2: false });
  ok('与移动业务协调（不计修正）的模式 (1) 距离不小于与固定业务协调', txMob.mode1Km.every((d, k) => d >= tx.mode1Km[k]) && txMob.mode1Km.some((d, k) => d > tx.mode1Km[k]));
  ok('发射站距离小于接收站（AP7：X 15 对 25 dB、且本例所需损耗低得多）', tx.contourKm.every((d, k) => d <= rx.contourKm[k]));
  console.log('      发射站等值线（km）：' + tx.azimuthsDeg.map((a, k) => `${a}°:${tx.contourKm[k].toFixed(0)}${tx.governing[k] === 'mode2' ? '²' : ''}`).join(' '));

  // 倾斜轨道（is = 3°）：地平线增益不小于无倾角，模式 (2) 为两圆之并
  const txInc = A.coordinationContour({ fGHz: 6.2, p: rl2.p, latDeg: lat, esRole: 'tx', Pt: rl2.Pt, Pr: rl2.Pr, Gx: rl2.Gx,
    azimuths: azs2, esAntenna: { GmaxDbi: 47, dOverLambda: 93 }, gso: { deltaLonDeg: dLon, inclinationDeg: 3 }, mode2: { rainZone: 'K' } });
  ok('倾斜轨道：各方位地平线增益不小于无倾角、模式 (2) 两个星位', txInc.horizonGainDbi.every((g, k) => g >= tx.horizonGainDbi[k] - 1e-9) && txInc.mode2.circles.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
