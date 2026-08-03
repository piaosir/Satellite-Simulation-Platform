// PFD Mask 纯核测试（无框架，纯断言）。运行： node packages/core/test/pfdMask.test.js
//
// 分两类，标签必须分清——这决定了一条断言值多少钱：
//   [他证] 期望值来自 ITU 原文自带的算例或公认数学常数，错了就是我们错。
//   [自洽] 期望值由本实现自己算出，只能锁住回归、不能证明正确。
//
// S.1528 的 golden 全部取自建议书自带的 Annex 1（MEO/LEO/S.672 三例）与 Annex 2（A、σ、μ）。
// 那份 PDF 已在本轮侦察中逐段核对，不凭记忆。

const units = require('../utils/pfdmask/units.js');
const s1528 = require('../utils/pfdmask/s1528.js');

let pass = 0, fail = 0;
function approx(name, got, want, tol) {
  const g = Number(got);
  const okk = Number.isFinite(g) && Math.abs(g - want) <= tol;
  console.log((okk ? 'PASS' : 'FAIL') + '  ' + name + `  (got=${g}, want≈${want} ±${tol})`);
  okk ? pass++ : fail++;
}
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  ${extra}` : ''));
  cond ? pass++ : fail++;
}
function throws(name, fn, reMatch) {
  let threw = false, msg = '';
  try { fn(); } catch (e) { threw = true; msg = String(e && e.message || e); }
  const okk = threw && (!reMatch || reMatch.test(msg));
  console.log((okk ? 'PASS' : 'FAIL') + '  ' + name + (threw ? `  (threw: ${msg.slice(0, 70)}…)` : '  (未抛异常)'));
  okk ? pass++ : fail++;
}

console.log('=== PFD Mask · units + S.1528 ===\n');

// ---------------------------------------------------------------------------
console.log('--- U 组：单位与量纲守卫 ---');
// ---------------------------------------------------------------------------

// [他证] 10·lg(1000²) = 60.000000，km→m 的量纲差是确定的数学常数
approx('U1 [他证] GRD absolute→PFD 的常数差 = −60.000000 dB',
  units.GRD_ABSOLUTE_TO_PFD_DB, -60, 1e-12);
approx('U2 [他证] grdAbsoluteToPfdPerHz(0, 0) = −60',
  units.grdAbsoluteToPfdPerHz(0, 0), -60, 1e-12);
approx('U3 [自洽] grdAbsoluteToPfdPerHz 线性叠加 EIRP',
  units.grdAbsoluteToPfdPerHz(-100, -5), -165, 1e-12);

// [他证] 扩散损耗 10·lg(4πd²)，d = 1000 km = 1e6 m
approx('U4 [他证] spreadingLossDb(1e6 m) = 10·lg(4π·1e12)',
  units.spreadingLossDb(1e6), 10 * Math.log10(4 * Math.PI * 1e12), 1e-12);
throws('U5 [守卫] spreadingLossDb(900) 抛异常（900 m 不是合法斜距，防 km 误传）',
  () => units.spreadingLossDb(900), /小于下界|米/);
throws('U6 [守卫] spreadingLossDb 拒绝非有限数', () => units.spreadingLossDb(NaN));

// [他证] 40 kHz → 1 MHz 的换算是 10·lg(25) = 13.9794 dB
approx('U7 [他证] refBwScaleDb(40 kHz → 1 MHz) = 10·lg(25)',
  units.refBwScaleDb(40e3, 1e6), 10 * Math.log10(25), 1e-12);
approx('U8 [他证] refBwScaleDb(40 kHz → 4 kHz) = −10 dB',
  units.refBwScaleDb(40e3, 4e3), -10, 1e-12);

// {dbw,bwHz} 往返
{
  const s = units.spec(-5, 40e3);
  approx('U9  [自洽] perHz 往返一致', units.perHz(units.fromPerHz(units.perHz(s), 40e3)), units.perHz(s), 1e-12);
  approx('U10 [自洽] rescale 到 1 MHz 再回 40 kHz 复原', units.rescale(units.rescale(s, 1e6), 40e3).dbw, -5, 1e-12);
  throws('U11 [守卫] spec 拒绝缺省带宽', () => units.spec(-5, 0));
}

// ③号坑：eirp_mask_ss 无 refbw_khz
{
  const a = units.checkEirpSsRefBw(40e3, 'report');
  ok('U12 [自洽] eirp_mask_ss @40 kHz 放行', a.ok === true && a.errorDb === 0);
  const b = units.checkEirpSsRefBw(1e6, 'report');
  ok('U13 [他证] eirp_mask_ss @1 MHz 判不合规', b.ok === false);
  approx('U14 [他证] 其静默偏差 = 13.979 dB', b.errorDb, 10 * Math.log10(25), 1e-9);
  throws('U15 [守卫] mode=throw 时非 40 kHz 直接抛', () => units.checkEirpSsRefBw(1e6, 'throw'), /refbw_khz/);
}

// XML 频率格式：六位小数，且浮点必须不漏
ok('U16 [他证] ghzToMhzXml(10.7) = "10700.000000"', units.ghzToMhzXml(10.7) === '10700.000000',
  `got="${units.ghzToMhzXml(10.7)}"`);
ok('U17 [他证] ghzToMhzXml(12.75) = "12750.000000"', units.ghzToMhzXml(12.75) === '12750.000000',
  `got="${units.ghzToMhzXml(12.75)}"`);
approx('U18 [自洽] mhzXmlToGhz 往返', units.mhzXmlToGhz(units.ghzToMhzXml(10.7)), 10.7, 1e-12);

// 功率域求和（§C2.3.1 明写求和，取 max 会低估 → 不安全 mask）
approx('U19 [他证] 两个等值 PFD 相加 = +3.0103 dB', units.sumDb([-150, -150]), -150 + 10 * Math.log10(2), 1e-12);
approx('U20 [他证] 50 个等值相加 = +10·lg(50)', units.sumDb(new Array(50).fill(-150)), -150 + 10 * Math.log10(50), 1e-12);

// ---------------------------------------------------------------------------
console.log('\n--- B 组：Bessel 函数（§1.4 的地基） ---');
// ---------------------------------------------------------------------------

// [他证] 公认高精度值
// 容差统一 1e-7：Numerical Recipes 的 bessj0/bessj1 多项式标称绝对精度 ~1e-8，
// x=0 处残差实测 2.8e-9。方向图取 20·lg，1e-7 的幅度误差 ≈ 4e-7 dB，远低于任何工程需求。
approx('B1 [他证] J₀(0) = 1', s1528.besselJ0(0), 1, 1e-7);
approx('B2 [他证] J₀(1) = 0.7651976866', s1528.besselJ0(1), 0.7651976865579666, 1e-7);
approx('B3 [他证] J₀(4) = −0.3971498099', s1528.besselJ0(4), -0.3971498098638474, 1e-7);
approx('B4 [他证] J₀(10) = −0.2459357645', s1528.besselJ0(10), -0.24593576445134832, 1e-7);
approx('B5 [他证] J₁(0) = 0', s1528.besselJ1(0), 0, 1e-9);
approx('B6 [他证] J₁(1) = 0.4400505857', s1528.besselJ1(1), 0.4400505857449335, 1e-7);
approx('B7 [他证] J₁(4) = −0.0660433280', s1528.besselJ1(4), -0.06604332802354914, 1e-7);
approx('B8 [他证] J₁(10) = 0.0434727462', s1528.besselJ1(10), 0.04347274616886144, 1e-7);

// [他证] μᵢ = J₁ 的第 i 个非零根 / π，必须让 J₁(π·μᵢ) ≈ 0
for (let i = 0; i < 4; i++) {
  approx(`B9.${i + 1} [他证] J₁(π·μ${i + 1}) = 0（μ 确为 J₁ 零点/π）`,
    s1528.besselJ1(Math.PI * s1528.MU[i]), 0, 1e-7);
}
// [他证] 与 S.1528 Annex 2 印的 μ₁=1.2 / μ₂=2.233 / μ₃=3.238 对齐
approx('B10 [他证] μ₁ 对齐 Annex 2 的 1.2', s1528.MU[0], 1.2, 0.02);
approx('B11 [他证] μ₂ 对齐 Annex 2 的 2.233', s1528.MU[1], 2.233, 5e-4);
approx('B12 [他证] μ₃ 对齐 Annex 2 的 3.238', s1528.MU[2], 3.238, 5e-4);

// ---------------------------------------------------------------------------
console.log('\n--- G12 组：S.1528 §1.2（LN 型包络） ---');
// ---------------------------------------------------------------------------

// PMGT 屏3 那组参数。ψb 取 1°（把 "Beamwidth 1 = 2°" 读作 3 dB 全宽）。
// ⚠ 这组读法与 Peak Gain = 32 dBi 并不自洽（见 s1528.js 头注），此处只用来锁住分段代数。
{
  const p = { peakGainDbi: 32, psibDeg: 1, Ln: -25, axisRatioZ: 1 };
  const d = s1528.derivedS1528_12(p);

  // [他证] Table 1：z=1 ⇒ a = 2.58·√1 = 2.58；b = 6.32；α = 1.5
  approx('G12-1 [他证] a = 2.58（z=1）', d.a, 2.58, 1e-12);
  approx('G12-2 [他证] b = 6.32', d.b, 6.32, 1e-12);
  approx('G12-3 [他证] α = 1.5', d.alpha, 1.5, 1e-12);

  // [他证] X = Gm + LN + 25·lg(b·ψb)；Y = b·ψb·10^(0.04(Gm+LN−LF))
  approx('G12-4 [他证] X = 7 + 25·lg(6.32)', d.X, 7 + 25 * Math.log10(6.32), 1e-12);
  approx('G12-5 [他证] Y = 6.32·10^0.28', d.Y, 6.32 * Math.pow(10, 0.28), 1e-12);
  // [他证] LB = max(15 + LN + 0.25Gm + 5lg z, 0) = max(15−25+8+0, 0) = 0
  approx('G12-6 [他证] LB = max(−2, 0) = 0', d.LB, 0, 1e-12);

  // [他证] a·ψb 处的垂直跌落 —— 规范本意，禁止平滑
  approx('G12-7 [他证] ψ=a·ψb 处跌落 = 12.5677 dB', d.stepAtA, 12.5677195, 1e-6);

  // 分段连续性（除 a·ψb 那一处外，其余接缝必须严格连续）
  const eps = 1e-9;
  approx('G12-8 [自洽] b·ψb 接缝连续（(2b)↔(3)）',
    s1528.gainDbS1528_12(d.seg2bEnd, p, d) - s1528.gainDbS1528_12(d.seg2bEnd + eps, p, d), 0, 1e-7);
  approx('G12-9 [自洽] Y 接缝连续（(3)↔LF）',
    s1528.gainDbS1528_12(d.Y, p, d) - d.LF, 0, 1e-9);
  approx('G12-10 [自洽] (3) 段在 Y 处恰落到 LF=0', s1528.gainDbS1528_12(d.Y, p, d), 0, 1e-9);

  // 逐点自查表（[自洽]，作为回归基准）
  const table = [
    [0, 32], [0.5, 32 - 3 * Math.pow(0.5, 1.5)], [1, 29], [2, 32 - 3 * Math.pow(2, 1.5)],
    [2.58, 32 - 3 * Math.pow(2.58, 1.5)], [3, 7], [5, 7], [6.32, 7],
    [8, d.X - 25 * Math.log10(8)], [12, d.X - 25 * Math.log10(12)],
    [30, 0], [90, 0], [120, 0], [180, 0],
  ];
  let tableOk = true;
  for (const [psi, want] of table) {
    const got = s1528.gainDbS1528_12(psi, p, d);
    if (!(Math.abs(got - want) < 1e-9)) { tableOk = false; console.log(`   ψ=${psi}: got=${got} want=${want}`); }
  }
  ok('G12-11 [自洽] 14 点自查表全对', tableOk);

  // 单调不增（LN 型在 z=1 时应处处不上翘）
  let mono = true, prev = Infinity;
  for (let psi = 0; psi <= 180; psi += 0.05) {
    const g = s1528.gainDbS1528_12(psi, p, d);
    if (g > prev + 1e-9) { mono = false; console.log(`   在 ψ=${psi.toFixed(2)}° 上翘: ${prev} → ${g}`); break; }
    prev = g;
  }
  ok('G12-12 [自洽] z=1 时方向图单调不增', mono);

  ok('G12-13 [自洽] z=1 且 Ln=−25 无 provisional 告警', d.warnings.length === 0, `warnings=${d.warnings.length}`);
}

// [他证] Table 1 的四档 c 值：1.4 / 1.0 / 0.6 / 0.4
{
  const want = { '-15': 1.4, '-20': 1.0, '-25': 0.6, '-30': 0.4 };
  let allOk = true;
  for (const k of Object.keys(want)) {
    if (Math.abs(s1528.LN_TABLE[k].c - want[k]) > 1e-12) allOk = false;
    if (Math.abs(s1528.LN_TABLE[k].b - 6.32) > 1e-12) allOk = false;
    if (Math.abs(s1528.LN_TABLE[k].alpha - 1.5) > 1e-12) allOk = false;
  }
  ok('G12-14 [他证] Table 1 四档 (c, b, α) 全对', allOk);
  ok('G12-15 [他证] Ln=−30 标记为 provisional（原文 "require further study"）',
    s1528.LN_TABLE['-30'].provisional === true);
}

// 椭圆波束的 provisional 告警与 z 上界守卫
{
  const d = s1528.derivedS1528_12({ peakGainDbi: 32, psibDeg: 1, Ln: -25, axisRatioZ: 2 });
  approx('G12-16 [他证] z=2, Ln=−25 ⇒ a = 2.58·√(1−0.6·lg2)', d.a, 2.58 * Math.sqrt(1 - 0.6 * Math.log10(2)), 1e-12);
  ok('G12-17 [自洽] z≠1 触发 NOTE 1 的 provisional 告警', d.warnings.some((w) => /实验验证|provisional|暂定/.test(w)));
  // z 上界：Ln=−25 ⇒ 1−0.6·lg z ≤ 0 ⇔ z ≥ 10^(1/0.6) ≈ 46.42
  throws('G12-18 [他证] z 超上界（46.42）时 a 无定义 → 抛',
    () => s1528.derivedS1528_12({ peakGainDbi: 32, psibDeg: 1, Ln: -25, axisRatioZ: 50 }), /无定义|上界/);
}
throws('G12-19 [守卫] Ln 非 Table 1 四档 → 抛（插值无依据）',
  () => s1528.derivedS1528_12({ peakGainDbi: 32, psibDeg: 1, Ln: -22 }), /Table 1|四档|只能取/);

// ---------------------------------------------------------------------------
console.log('\n--- G13 组：S.1528 §1.3（LEO/MEO）—— 全部对 Annex 1 原文算例 ---');
// ---------------------------------------------------------------------------

// [他证] Annex 1 · MEO：ψb=1.6°, Gm=35, Ls=−12, Y=2ψb=3.2°, LF=3, 原文化简式 35.6 − 25lgψ
{
  const p = { peakGainDbi: 35, psibDeg: 1.6, mode: 'MEO', dOverLambda: 22.6, farOutDbi: 3 };
  const d = s1528.derivedS1528_13(p);
  approx('G13-1 [他证] MEO Ls = −12', d.Ls, -12, 1e-12);
  approx('G13-2 [他证] MEO Y = 2ψb = 3.2°', d.Y, 3.2, 1e-12);
  // 原文印 Z = 20.0°，精确值 3.2·10^0.8 = 20.1906（原文取整）
  approx('G13-3 [他证] MEO Z = 3.2·10^0.8（原文印 20.0 为取整）', d.Z, 3.2 * Math.pow(10, 0.8), 1e-9);
  ok('G13-4 [他证] MEO Z 与原文印的 20.0 相差 < 0.2', Math.abs(d.Z - 20.0) < 0.2, `Z=${d.Z.toFixed(4)}`);

  // 原文化简：G(ψ) = 35.6 − 25·lg ψ。取 ψ=10° 验一点
  const wantAt10 = (35 - 12 + 25 * Math.log10(3.2)) - 25 * Math.log10(10);
  approx('G13-5 [他证] MEO G(10°) 对齐原文化简式 35.63−25lgψ',
    s1528.gainDbS1528_13(10, p, d), wantAt10, 1e-9);
  approx('G13-6 [他证] MEO 化简式常数 = 35.63（原文印 35.6）',
    35 - 12 + 25 * Math.log10(3.2), 35.6, 0.05);

  // 主瓣段：ψ=ψb 处应恰为 Gm−3
  approx('G13-7 [他证] MEO G(ψb) = Gm − 3', s1528.gainDbS1528_13(1.6, p, d), 32, 1e-12);
  approx('G13-8 [他证] MEO G(Y) 两段接缝连续', s1528.gainDbS1528_13(3.2, p, d), 35 - 3 * Math.pow(2, 2), 1e-12);
  approx('G13-9 [他证] MEO G(>Z) = LF = 3', s1528.gainDbS1528_13(40, p, d), 3, 1e-12);

  // 与 MEO 分支的等价式对照：两者一致 ⇔ Gm = 20lg(D/λ) + 7.974
  const alt = s1528.gainDbS1528_13Alt(10, p, d);
  const gmImplied = 20 * Math.log10(22.6) + 7.974;
  approx('G13-10 [他证] MEO 等价式与主式之差 = Gm 的偏离量',
    alt - s1528.gainDbS1528_13(10, p, d), gmImplied - 35, 0.01);
}

// [他证] Annex 1 · LEO：Ls=−6.75, Y=1.5ψb=2.4°, LF=5, Z=20.4°, 化简式 37.76 − 25lgψ
{
  const p = { peakGainDbi: 35, psibDeg: 1.6, mode: 'LEO', dOverLambda: 22.6, farOutDbi: 5 };
  const d = s1528.derivedS1528_13(p);
  approx('G13-11 [他证] LEO Ls = −6.75', d.Ls, -6.75, 1e-12);
  approx('G13-12 [他证] LEO Y = 1.5ψb = 2.4°', d.Y, 2.4, 1e-12);
  approx('G13-13 [他证] LEO Z 对齐原文印的 20.4°', d.Z, 20.4, 0.05);
  approx('G13-14 [他证] LEO 化简式常数 = 37.755（原文印 37.76）',
    35 - 6.75 + 25 * Math.log10(2.4), 37.76, 0.01);
  approx('G13-15 [他证] LEO G(10°) 对齐原文化简式',
    s1528.gainDbS1528_13(10, p, d), (35 - 6.75 + 25 * Math.log10(2.4)) - 25, 1e-9);
}

// [他证] Y = ψb·√(−Ls/3) 与原文分支写法 (2ψb / 1.5ψb) 必须自洽
approx('G13-16 [他证] √(12/3) = 2（MEO 两种写法自洽）', Math.sqrt(12 / 3), 2, 1e-12);
approx('G13-17 [他证] √(6.75/3) = 1.5（LEO 两种写法自洽）', Math.sqrt(6.75 / 3), 1.5, 1e-12);

// D/λ ≥ 35 是【规范本身】的空缺
throws('G13-18 [他证] D/λ ≥ 35 默认抛异常（原文只给了 <35 的形式）',
  () => s1528.derivedS1528_13({ peakGainDbi: 35, psibDeg: 1.6, mode: 'MEO', dOverLambda: 40 }),
  /D\/λ < 35|定义域|空缺/);
{
  const d = s1528.derivedS1528_13({ peakGainDbi: 35, psibDeg: 1.6, mode: 'MEO', dOverLambda: 40, outOfDomain: 'extrapolate' });
  ok('G13-19 [自洽] 显式 extrapolate 放行并留下无依据告警',
    d.warnings.length > 0 && /无 ITU 依据/.test(d.warnings.join('')));
}
throws('G13-20 [守卫] mode 只能是 LEO/MEO',
  () => s1528.derivedS1528_13({ peakGainDbi: 35, psibDeg: 1.6, mode: 'GEO', dOverLambda: 22.6 }));

// ---------------------------------------------------------------------------
console.log('\n--- G14 组：S.1528 §1.4（Taylor）—— ★ 原文 σ 印刷错误的双向验证 ---');
// ---------------------------------------------------------------------------

// [他证] Annex 2：SLR = 20 dB、l = 4 ⇒ 原文印 A = 0.95277、σ = 1.1692
{
  const d = s1528.derivedS1528_14({ slrDb: 20, nSideLobes: 4 });
  approx('G14-1 [他证] A = (1/π)·arccosh(10^(SLR/20)) = 0.95277', d.A, 0.95277, 5e-6);
  approx('G14-2 [他证] σ = μ₄/√(A²+3.5²) = 1.1692', d.sigma, 1.1692, 5e-5);

  // ★ 反向证伪：照抄原文的 J₀(l) 得到的是完全错误的值
  const denom = Math.sqrt(d.A * d.A + Math.pow(4 - 0.5, 2));
  const sigmaIfJ0 = s1528.besselJ0(4) / denom;
  // 精确值 J₀(4)/√(A²+3.5²) = −0.3971498099/3.6273648 = −0.1094871
  approx('G14-3 [他证] 若照抄原文 J₀(l)：σ = −0.1094871（与 ITU 印的 1.1692 完全不符）',
    sigmaIfJ0, -0.1094871, 1e-6);
  ok('G14-4 [他证] J₀ 读法与 ITU 自带数据相差一个数量级且反号 ⇒ 原文为笔误',
    Math.abs(sigmaIfJ0 - 1.1692) > 1.0 && sigmaIfJ0 < 0,
    `μ 读法=${d.sigma.toFixed(6)}  J₀ 读法=${sigmaIfJ0.toFixed(6)}`);

  // 主瓣峰值：u→0 时 2J₁(u)/u → 1，∏ → 1 ⇒ G = Gmax
  const p14 = { gmaxDbi: 35, slrDb: 20, nSideLobes: 4, nullFloorDb: -60 };
  approx('G14-5 [他证] u→0 时 G = Gmax（2J₁(u)/u 的极限为 1）',
    s1528.gainDbS1528_14FromU(0, p14, d), 35, 1e-9);
  approx('G14-6 [自洽] u=1e-6 与 u=0 连续', s1528.gainDbS1528_14FromU(1e-6, p14, d), 35, 1e-6);

  // 零点下界必须被钳住，不能到 −∞
  let allFinite = true, minV = Infinity;
  for (let u = 0; u <= 60; u += 0.01) {
    const g = s1528.gainDbS1528_14FromU(u, p14, d);
    if (!Number.isFinite(g)) { allFinite = false; break; }
    if (g < minV) minV = g;
  }
  ok('G14-7 [自洽] u∈[0,60] 全程有限（零点被 nullFloorDb 钳住）', allFinite);
  ok('G14-8 [自洽] 最低值不低于 Gmax + nullFloorDb', minV >= 35 - 60 - 1e-9, `min=${minV.toFixed(4)}`);

  throws('G14-9 [守卫] nullFloorDb 必填（原文自认零点下界 needs further study）',
    () => s1528.gainDbS1528_14FromU(1, { gmaxDbi: 35, slrDb: 20, nSideLobes: 4 }, d), /nullFloorDb/);
}

// u 的定义：u = (π/λ)·√[(Lr·sinθ·cosφ)² + (Lt·sinθ·sinφ)²]
{
  const p = { LrM: 0.5, LtM: 0.5, lambdaM: 0.025 };   // 12 GHz ⇒ λ = 0.024983 m，取 0.025 便于手算
  approx('G14-10 [他证] θ=0 ⇒ u=0', s1528.uOf(0, 0, p), 0, 1e-12);
  // Lr=Lt 时 u 与 φ 无关，= (π/λ)·L·sinθ
  const want = (Math.PI / 0.025) * 0.5 * Math.sin(10 * Math.PI / 180);
  approx('G14-11 [他证] Lr=Lt 时 u = (π/λ)·L·sinθ（与 φ 无关）', s1528.uOf(10, 37, p), want, 1e-12);
}

// ---------------------------------------------------------------------------
console.log('\n--- P 组：ψb 的两种来源 ---');
// ---------------------------------------------------------------------------

// [他证] ψb = √1200/(D/λ)。√1200 = 34.641，与经典 3dB 半宽 ≈ 35λ/D 吻合
approx('P1 [他证] √1200 = 34.6410', Math.sqrt(1200), 34.64101615137755, 1e-12);
approx('P2 [他证] psibFromAperture(17.3205) = 2.0°', s1528.psibFromAperture(Math.sqrt(1200) / 2), 2, 1e-12);
approx('P3 [他证] 椭圆 major axis 的 ψb = z × minor 的 ψb', s1528.psibFromAperture(20, 2), 2 * s1528.psibFromAperture(20), 1e-12);
approx('P4 [自洽] psibFromFullBeamwidth(2) = 1', s1528.psibFromFullBeamwidth(2), 1, 1e-12);

// ★ 截图那组默认值的自洽性检验（记录事实，不做判定）
{
  // 若 "Beamwidth 1 = 2°" 读作【半波束宽 ψb】：D/λ = √1200/2 = 17.3205
  const rHalf = Math.sqrt(1200) / 2;
  const gmHalf65 = 20 * Math.log10(Math.PI * rHalf) + 10 * Math.log10(0.65);
  // 若读作【3 dB 全宽】（ψb = 1°）：D/λ = 34.641
  const rFull = Math.sqrt(1200) / 1;
  const gmFull65 = 20 * Math.log10(Math.PI * rFull) + 10 * Math.log10(0.65);
  console.log(`   ψb 读法 → D/λ=${rHalf.toFixed(4)}, Gm(η=.65)=${gmHalf65.toFixed(2)} dBi`);
  console.log(`   全宽读法 → D/λ=${rFull.toFixed(4)}, Gm(η=.65)=${gmFull65.toFixed(2)} dBi`);
  ok('P5 [他证] "Beamwidth1=2°" 读作 ψb 时与 "Peak Gain=32 dBi" 相差 < 1 dB',
    Math.abs(gmHalf65 - 32) < 1, `|Δ|=${Math.abs(gmHalf65 - 32).toFixed(2)} dB`);
  ok('P6 [他证] 读作 3 dB 全宽时与 32 dBi 相差 > 6 dB（两种读法不可能都对）',
    Math.abs(gmFull65 - 32) > 6, `|Δ|=${Math.abs(gmFull65 - 32).toFixed(2)} dB`);
}

// ---------------------------------------------------------------------------
console.log('\n--- M 组：统一入口 ---');
// ---------------------------------------------------------------------------
{
  const a = s1528.makePattern('1.2', { peakGainDbi: 32, psibDeg: 1, Ln: -25 });
  ok('M1 [自洽] makePattern("1.2") 可用', typeof a.gainDb === 'function' && Math.abs(a.gainDb(0) - 32) < 1e-12);
  const b = s1528.makePattern('1.3', { peakGainDbi: 35, psibDeg: 1.6, mode: 'MEO', dOverLambda: 22.6, farOutDbi: 3 });
  ok('M2 [自洽] makePattern("1.3") 可用', typeof b.gainDb === 'function' && Math.abs(b.gainDb(1.6) - 32) < 1e-12);
  const c = s1528.makePattern('1.4', { gmaxDbi: 35, slrDb: 20, nSideLobes: 4, nullFloorDb: -60 });
  ok('M3 [自洽] makePattern("1.4") 可用', typeof c.gainDbFromU === 'function' && Math.abs(c.gainDbFromU(0) - 35) < 1e-9);
  throws('M4 [守卫] 未知 section 抛', () => s1528.makePattern('9.9', {}));
}

// ---------------------------------------------------------------------------
console.log('\n--- E 组：引擎端到端 + XML 往返 + EIRP mask ---');
// ---------------------------------------------------------------------------

const eng = require('../utils/pfdmask/maskEngine.js');
const io = require('../utils/pfdmask/maskIO.js');

const BASE = {
  satName: 'Test Ku', ntcId: 1, pfdMaskId: 2, eirpMaskId: 3,
  lowFreqGhz: 10.7, highFreqGhz: 12.75, refBwKhz: 40,
  satHeightKm: 900, incDeg: 55, minElevDeg: 20,
  maxEirpDbwPerRefBw: -5, usePowerControl: true, powerControlKappa: 1,
  srsAlpha0Deg: 15, maskAlpha0Deg: 20, nBeams: 50, minAngleDeg: 5, beamLayout: 'hex-ring',
  pattern: { section: '1.2', peakGainDbi: 32, psibDeg: 1, Ln: -25 },
  nAzElPoints: 15, latStepDeg: 15, sepAngleStepDeg: 5, conservativeMarginDb: 1,
};
const mk = (over) => eng.generatePfdMask(Object.assign({}, BASE, over || {}));

{
  const { doc, meta } = mk();
  const v = io.validateMaskDoc(doc);
  ok('E1 [他证] 端到端文档通过官方 XSD 校验', v.ok, `${v.errors.length} 错 / ${v.warnings.length} 警`);
  ok('E2 [自洽] 同时产出 pfd_mask 与 eirp_mask_ss',
    v.counts.pfdMasks === 1 && v.counts.eirpMaskSs === 1);

  // [他证] ρ₀ = asin(Re·cosε₀/(Re+h))
  const Re = 6378.137;
  approx('E3 [他证] ρ₀ = asin(Re·cos20°/(Re+900))',
    meta.rho0Deg, Math.asin(Re * Math.cos(20 * Math.PI / 180) / (Re + 900)) * 180 / Math.PI, 1e-9);

  // [他证] 功控全补偿的落差 = 20lg(d_max/h)
  approx('E4 [他证] 功控落差 = 20·lg(d_max/h)',
    meta.powerControlSpanDb, 20 * Math.log10(meta.dMaxKm / 900), 1e-12);

  // [他证] 功控全补偿 ⇒ 活跃区 PFD 恒定
  approx('E5 [他证] κ=1 时活跃区 PFD 跨度为 0（地面 PFD 平坦）',
    meta.maxValueDb - meta.minValueDb, 0, 1e-9);

  // [他证] 手算：PFD = maxEIRP + 聚合抬升 − 10lg(4πd_max²) + 裕量
  const spread = 10 * Math.log10(4 * Math.PI * Math.pow(meta.dMaxKm * 1000, 2));
  approx('E6 [他证] 活跃区 PFD 与手算逐位一致（★ 曾在此双计 32 dB 天线增益）',
    meta.minValueDb, -5 + meta.aggregateGainOverPeakDb - spread + 1, 1e-9);

  // [他证] EIRP mask 的 separation angle 语义（§B4.3：顶点在卫星、天底方向 ↔ GSO 弧点）
  const cells = doc.eirpMaskSs[0].slices[0].cells;
  approx('E7 [他证] d=0（天底）⇒ 波束可直接对准 ⇒ 满功率',
    cells[0].v, -5 + meta.aggregateGainOverPeakDb + 1, 1e-3);
  // ★ d=180（反天底）：任一波束的离轴角恒为 180 − 它自己的天底角 ∈ [180−ρ₀, 180]，
  //   §1.2 在 90° 之外是【背瓣平台 LB】（(4b) 段），不是远旁瓣平台 LF（(4a) 段只到 90°）。
  //   两段都是常数 ⇒ 聚合 = 该段电平 + 10lg(Nco)，严格等式。
  //   曾把 d=0 处的聚合抬升当常数平移整条曲线，此处低估 10lg(50) − 0.2 ≈ 16.8 dB，掩模在
  //   LEO 看 GSO 弧的整个受用角域（d ∈ [ρ₀,180]）都不再是包络。
  const D12 = s1528.derivedS1528_12(BASE.pattern);
  const gAt180 = s1528.gainDbS1528_12(180 - meta.rho0Deg, BASE.pattern);
  approx('E8 [他证] d=180 ⇒ 全部波束落到背瓣平台 ⇒ LB + 10lg(Nco)',
    cells[cells.length - 1].v, -5 - 32 + D12.LB + 10 * Math.log10(50) + 1, 1e-3);
  ok('E8a [他证] d=180 时各波束离轴角全在 (4b) 段内（> 90°，取 LB）',
    180 - meta.rho0Deg > 90 && Math.abs(gAt180 - D12.LB) < 1e-12,
    `离轴 ∈ [${(180 - meta.rho0Deg).toFixed(1)}°,180°]，LB=${D12.LB} LF=${D12.LF}`);
  ok('E8a2 [自省] 本例 LB 与 LF 恰好都是 0 dBi（LB = max(15+LN+0.25Gm, 0) = max(−2,0)）'
    + '——两者不可区分，故另有 E8f 用 LB ≠ LF 的方向图把它们分开',
    Math.abs(D12.LB - D12.LF) < 1e-12, `LB=${D12.LB} LF=${D12.LF}`);

  // 平台段（d ≤ ρ₀）逐位不变：那里最近合法指向就是 d 本身，新旧模型必须同值
  {
    const g = eng.makeGainLut(BASE.pattern, 900);
    const old = eng.aggregateGainDb(g, 50, 5, 'hex-ring');
    for (const d of [0, 10, 30, meta.rho0Deg]) {
      approx(`E8b [自洽] d=${d.toFixed(2)}° ≤ ρ₀ 的聚合与 aggregateGainDb 逐位一致（下行掩模不受影响）`,
        eng.aggregateGainTowardDb(g, 50, 5, 'hex-ring', meta.rho0Deg, d), old, 1e-12);
    }
    approx('E8c [他证] d=180 的聚合 = LB + 10lg(Nco)',
      eng.aggregateGainTowardDb(g, 50, 5, 'hex-ring', meta.rho0Deg, 180), D12.LB + 10 * Math.log10(50), 1e-9);
    approx('E8d [他证] worst-case-uniform 在任意 d 都是「最近合法离轴增益 + 10lg(Nco)」',
      eng.aggregateGainTowardDb(g, 50, 5, 'worst-case-uniform', meta.rho0Deg, 90),
      s1528.gainDbS1528_12(90 - meta.rho0Deg, BASE.pattern) + 10 * Math.log10(50), 1e-9);
    // 「聚合抬升」= 聚合增益 − 该方向单波束能给出的最大增益。天底处波束彼此错开 ⇒ 抬升微弱；
    // 远区所有波束同落一个常数平台 ⇒ 抬升吃满 10lg(Nco)。两者差 ~16.8 dB，正是曾被平移法抹掉的量。
    const liftNadir = eng.aggregateGainTowardDb(g, 50, 5, 'hex-ring', meta.rho0Deg, 0) - 32;
    const liftFar = eng.aggregateGainTowardDb(g, 50, 5, 'hex-ring', meta.rho0Deg, 180) - gAt180;
    ok('E8e [他证] 远区聚合抬升吃满 10lg(Nco)，天底处不足 1 dB',
      Math.abs(liftFar - 10 * Math.log10(50)) < 1e-9 && liftNadir < 1,
      `天底 +${liftNadir.toFixed(2)} dB → 远区 +${liftFar.toFixed(2)} dB`);
  }

  // ★ 非退化例：LB ≠ LF，把「背瓣平台」与「远旁瓣平台」真正分开。
  //   LB = max(15 + LN + 0.25·Gm + 5·lg z, 0)；Gm=45、LN=−15 ⇒ LB = 11.25 dBi 而 LF = 0 dBi。
  //   §1.2 的 LB 可以【高于】LF（原文 "or 0 dBi, whichever is higher"），此时星间掩模的远端
  //   由背瓣决定，误用 LF 会低 11.25 dB。BASE 那组恰好 LB = LF = 0，单靠它查不出这个错。
  {
    const pat = { section: '1.2', peakGainDbi: 45, psibDeg: 0.5, Ln: -15 };
    const Dx = s1528.derivedS1528_12(pat);
    approx('E8f.1 [他证] LB = max(15 + LN + 0.25·Gm + 5·lg z, 0)',
      Dx.LB, Math.max(15 - 15 + 0.25 * 45, 0), 1e-12);
    ok('E8f.2 [他证] 该方向图的 LB 高于 LF（背瓣平台反而更高，是原文本意）',
      Dx.LB - Dx.LF > 11, `LB=${Dx.LB} LF=${Dx.LF}`);
    const { doc: d2, meta: m2 } = eng.generateMasks(Object.assign({}, BASE, {
      pattern: pat, sepAngleStepDeg: 2, directions: { down: false, is: true, up: false },
    }));
    const c2 = d2.eirpMaskSs[0].slices[0].cells;
    approx('E8f.3 [他证] d=180 取 LB 而不是 LF（差 11.25 dB，退化例查不出）',
      c2[c2.length - 1].v, -5 - 45 + Dx.LB + 10 * Math.log10(50) + 1, 1e-3);
    // 90° 跨界处方向图向上跳 ⇒ 原始曲线非单调 ⇒ §B5.3 包络把中段整体抬到背瓣电平
    approx('E8f.4 [他证] §B5.3 单调化把中段抬升量 = LB − LF',
      m2.eirpSs.monotoneLift.maxDb, Dx.LB - Dx.LF, 1e-9);
    ok('E8f.5 [自洽] 被抬升的点数可观（背瓣平台反噬整个中段）',
      m2.eirpSs.monotoneLift.count > 20,
      `${m2.eirpSs.monotoneLift.count} / ${m2.eirpSs.axisCount} 点抬升 ${m2.eirpSs.monotoneLift.maxDb.toFixed(2)} dB`);
  }

  // XML 往返
  const xml = io.buildMaskXml(doc);
  const back = io.parseMaskXml(xml);
  ok('E9 [自洽] 读回文档仍通过 XSD 校验', io.validateMaskDoc(back).ok);
  ok('E10 [自洽] 读回的纬度表数一致',
    back.pfdMasks[0].slices.length === doc.pfdMasks[0].slices.length
    && back.eirpMaskSs[0].slices.length === doc.eirpMaskSs[0].slices.length);

  // ★ eirp_mask_ss 在 XSD 里没有 refbw_khz，写了就是非法文档
  const ssTag = xml.match(/<eirp_mask_ss[^>]*>/)[0];
  ok('E11 [他证] eirp_mask_ss 标签不含 refbw_khz（XSD 无此属性）', !/refbw_khz/.test(ssTag));
  ok('E12 [他证] eirp_mask_ss 的 d_name = "separation angle"', /d_name="separation angle"/.test(ssTag));
  ok('E13 [他证] pfd_mask 三轴命名与 type 自洽',
    /type="azimuth_elevation"/.test(xml) && /b_name="azimuth"/.test(xml) && /c_name="elevation"/.test(xml));
  ok('E14 [他证] 频率按 XSD 的 6 位小数写成 MHz', /low_freq_mhz="10700\.000000"/.test(xml));

  // lookupPfd 与落盘值逐点一致（纬度最近邻 + 双线性，与 ITU Viewer 的 calculate 框同口径）
  let worst = 0;
  for (const s of doc.pfdMasks[0].slices) {
    for (const r of s.rows) for (const c of r.cells) {
      const got = io.lookupPfd(back.pfdMasks[0], s.a, r.b, c.c);
      worst = Math.max(worst, Math.abs(got.value - c.v));
    }
  }
  approx('E15 [自洽] 写→读→查表往返逐点无损', worst, 0, 1e-12);
}

// 守卫：三类 mask 共享编号空间；EIRP mask 的带宽只能 40 kHz
throws('E16 [他证] EIRP Mask ID 与 PFD Mask ID 撞号 → 抛（XSD xs:unique）',
  () => mk({ eirpMaskId: 2 }), /撞号|unique/);
throws('E17 [他证] 生成 eirp_mask_ss 时非 40 kHz → 抛（带宽信息会静默丢失）',
  () => mk({ refBwKhz: 1000 }), /refbw_khz/);
throws('E18 [守卫] 保守裕量为负 → 抛（那是在放松包络）',
  () => mk({ conservativeMarginDb: -1 }), /不得为负/);

// 不给 eirpMaskId 时只出 pfd_mask
{
  const { doc } = mk({ eirpMaskId: null });
  ok('E19 [自洽] 不给 EIRP Mask ID 时只产出 pfd_mask',
    doc.pfdMasks.length === 1 && doc.eirpMaskSs.length === 0);
}

// 关掉功控 ⇒ 活跃区出现 20lg(d_max/h) 的落差
{
  const { meta } = mk({ usePowerControl: false });
  const span = meta.maxValueDb - meta.minValueDb;
  ok('E20 [他证] 关功控后活跃区落差趋近 20lg(d_max/h)=6.705 dB',
    Math.abs(span - 20 * Math.log10(meta.dMaxKm / 900)) < 0.15, `实测 ${span.toFixed(3)} dB`);
}

// α 几何的退化算例
{
  const geo = require('../utils/pfdmask/alphaGeometry.js');
  // 赤道站正上方的 GSO：卫星与 GSO 点同经度同赤道 ⇒ α = 0
  const satEq = geo.geodeticToEcefKm(0, 0, 900);
  const a0 = geo.alphaAndDeltaLong({ lonDeg: 0, latDeg: 0, altKm: 0 }, satEq, { coarseStepDeg: 1, tolDeg: 1e-7 });
  approx('E21 [他证] 赤道点正上方的卫星：α = 0（视线与 GSO 弧重合）', Math.abs(a0.alphaDeg), 0, 1e-3);

  // 星心 az/el 往返
  const sat = geo.geodeticToEcefKm(0, 30, 900);
  const hit = geo.groundPointFromAzEl(sat, 12, -7);
  const rt = geo.satCentricAzEl(sat, hit.ecef);
  approx('E22 [自洽] 星心 az/el → 地面落点 → 反解 az 往返一致', rt.azDeg, 12, 1e-6);
  approx('E23 [自洽] 同上 el 往返一致', rt.elDeg, -7, 1e-6);
  // (0,0) 必须是天底。
  // ★ §D6.4.5 把天底定义为【指向地心】，所以判据是「落点‑卫星‑地心三点共线」，
  //   而不是「落点大地纬度 = 卫星大地纬度」——椭球法线与地心方向本就不同向（差最多约 0.19°）。
  //   这条差别同时意味着：「星下点纬度」取大地纬度还是地心纬度，是 S.1503 未明说的口径自由度。
  const nadirHit = geo.groundPointFromAzEl(sat, 0, 0);
  const n1 = Math.hypot(sat[0], sat[1], sat[2]);
  const n2 = Math.hypot(nadirHit.ecef[0], nadirHit.ecef[1], nadirHit.ecef[2]);
  const cr = Math.hypot(
    sat[1] * nadirHit.ecef[2] - sat[2] * nadirHit.ecef[1],
    sat[2] * nadirHit.ecef[0] - sat[0] * nadirHit.ecef[2],
    sat[0] * nadirHit.ecef[1] - sat[1] * nadirHit.ecef[0]
  ) / (n1 * n2);
  approx('E24 [他证] (az,el)=(0,0) 落点与卫星、地心三点共线（§D6.4.5：天底 = 指向地心）', cr, 0, 1e-12);
  approx('E25 [他证] 同上：星下点经度 = 卫星经度（地心方向在同一经度面内）', nadirHit.lonDeg, 0, 1e-9);
  ok('E26 [他证] 落点【大地】纬度与卫星大地纬度不等，差约 0.02°（椭球固有，非误差）',
    Math.abs(nadirHit.latDeg - 30) > 1e-3 && Math.abs(nadirHit.latDeg - 30) < 0.1,
    `Δ=${(nadirHit.latDeg - 30).toFixed(6)}°`);
  // 纬度上限对逆行轨道
  approx('E27 [他证] 逆行轨道 i=98° 的纬度上限 = 82°', geo.latMaxFromInclination(98), 82, 1e-12);
  approx('E28 [他证] 顺行轨道 i=55° 的纬度上限 = 55°', geo.latMaxFromInclination(55), 55, 1e-12);
}

// ---------------------------------------------------------------------------
console.log('\n--- W 组：三种 mask · 哨兵分档 · 单调化 · 天花板框架 ---');
// ---------------------------------------------------------------------------

const esPat = require('../utils/pfdmask/esPatterns.js');
const art22 = require('../utils/pfdmask/art22.js');

const W = {
  satName: 'Test Ku', ntcId: 1,
  pfdMaskId: 1, eirpMaskId: 2, eirpEsMaskId: 3,
  lowFreqGhz: 10.7, highFreqGhz: 12.75, refBwKhz: 40,
  satHeightKm: 900, incDeg: 55, minElevDeg: 20,
  maxEirpDbwPerRefBw: -5, usePowerControl: true, powerControlKappa: 1,
  srsAlpha0Deg: 15, maskAlpha0Deg: 20, nBeams: 50, minAngleDeg: 5, beamLayout: 'hex-ring',
  pattern: { section: '1.2', peakGainDbi: 32, psibDeg: 1, Ln: -25 },
  // 分离角步长取 2°：48° 落在采样点上，W8 的他证断言才成立。
  // 步长 5° 时 48° 不被采到，跳变发生在 45°→50°，量值是 2.33 dB 而非 3.03 —— 那是分辨率效应，不是错误。
  nAzElPoints: 15, latStepDeg: 15, sepAngleStepDeg: 2, conservativeMarginDb: 1,
  esId: -1,
  terminal: { kind: 'S.580-6', diameterM: 1.2, wavelengthM: 0.0256, efficiency: 0.65, maxEirpDbwPerRefBw: 20 },
  directions: { down: true, is: true, up: true },
};
const mkW = (over) => eng.generateMasks(Object.assign({}, W, over || {}));

{
  const { doc, meta } = mkW();
  const v = io.validateMaskDoc(doc);
  ok('W1 [他证] 三种 mask 同出且通过 XSD', v.ok
    && v.counts.pfdMasks === 1 && v.counts.eirpMaskEs === 1 && v.counts.eirpMaskSs === 1,
    `${v.errors.length} 错 · ${JSON.stringify(v.counts)}`);

  const xml = io.buildMaskXml(doc);
  ok('W2 [他证] eirp_mask_es 带 refbw_khz / min_elev / es_id / d_name',
    /<eirp_mask_es[^>]*refbw_khz="40"[^>]*min_elev="20\.00"[^>]*d_name="separation angle"[^>]*es_id="-1"/.test(xml));
  ok('W3 [他证] eirp_mask_ss 仍不带 refbw_khz', !/refbw_khz/.test(xml.match(/<eirp_mask_ss[^>]*>/)[0]));

  // 哨兵分两档
  const vals = doc.pfdMasks[0].slices.flatMap((s) => s.rows.flatMap((r) => r.cells.map((c) => c.v)));
  ok('W4 [他证] 真不发射区填 −999（§C1 的极低值约定，XSD 下界）', vals.includes(-999));
  ok('W5 [他证] 几何算不出填 −170 并与不发射区分开', vals.includes(-170));
  ok('W6 [自洽] 两档计数与格数自洽',
    meta.stat.computed + meta.stat.sentinelAlpha + meta.stat.sentinelLowElev + meta.stat.sentinelOutOfView === meta.stat.cells);

  // 单调性：两种 EIRP mask 都是 §B5.3 的硬要求
  for (const [name, cells] of [['eirp_ss', doc.eirpMaskSs[0].slices[0].cells], ['eirp_es', doc.eirpMaskEs[0].slices[0].cells]]) {
    const a = cells.map((c) => c.v);
    let mono = true;
    for (let i = 1; i < a.length; i++) if (a[i] > a[i - 1] + 1e-9) mono = false;
    ok(`W7.${name} [他证] ${name} 单调不增（§B5.3）`, mono);
  }

  // S.580-6 在 48° 处从 29−25lg48 跳到 −10 dBi，是真实的不单调，必须被单调化抬平
  approx('W8 [他证] S.580-6 在 48° 的跳变量 = −10 − (29 − 25·lg48)',
    meta.eirpEs.monotoneLift.maxDb, -10 - (29 - 25 * Math.log10(48)), 1e-6);
  ok('W9 [自洽] 该跳变确实触发了单调化', meta.eirpEs.monotoneLift.count > 0,
    `抬升 ${meta.eirpEs.monotoneLift.count} 点 / 最大 ${meta.eirpEs.monotoneLift.maxDb.toFixed(3)} dB`);

  // 上行 mask 不按 α₀ 截断——规避角进 SRS 不进 mask
  const esCells = doc.eirpMaskEs[0].slices[0].cells;
  ok('W10 [他证] 上行 mask 在 θ < α₀ 处【不挖坑】（规避角另交 MIN_EXCLUDE）',
    esCells.filter((c) => c.d < W.maskAlpha0Deg).every((c) => c.v > -900));
}

// 三类共享编号空间：任意两者撞号都要拦
throws('W11 [他证] pfd 与 eirp_es 撞号 → 抛', () => mkW({ eirpEsMaskId: 1 }), /撞号/);
throws('W12 [他证] eirp_ss 与 eirp_es 撞号 → 抛', () => mkW({ eirpEsMaskId: 2 }), /撞号/);
throws('W13 [他证] 不发射哨兵低于 XSD 下界 −999 → 抛', () => mkW({ sentinelNoEmissionDb: -1000 }), /下界/);

// 只出上行（不需要卫星载荷）
{
  const { doc, meta } = mkW({ directions: { down: false, is: false, up: true } });
  ok('W14 [自洽] 可单独生成上行 mask',
    doc.eirpMaskEs.length === 1 && doc.pfdMasks.length === 0 && doc.eirpMaskSs.length === 0);
  ok('W15 [自洽] 上行 meta 报告方向图牌号与峰值增益',
    meta.eirpEs.patternKind === 'S.580-6' && meta.eirpEs.peakGainDbi > 30);
}

// 赤道星座（i=0）：latMax=0，纬度轴不得铺成三张同 a=0 的切片（@a 是 by_a 的键）
{
  const { doc, meta } = mkW({ incDeg: 0 });
  ok('W15b [自洽] i=0 时纬度轴退化为单张切片',
    meta.latCount === 1 && doc.pfdMasks[0].slices.length === 1 && doc.pfdMasks[0].slices[0].a === 0,
    `latCount=${meta.latCount}, a=[${doc.pfdMasks[0].slices.map((s) => s.a)}]`);
  const v = io.validateMaskDoc(doc);
  ok('W15c [他证] i=0 的三份 mask 仍通过 XSD（曾因 by_a/@a 重复被整次拒绝）', v.ok,
    `${v.errors.length} 错：${v.errors.slice(0, 2).map((e) => e.path).join(' ')}`);
  // ★ eirp_mask_* 走两层校验，早先没查 @a 重复 ⇒ 同一批重复切片在 pfd 侧被拒、在 eirp 侧静默落盘
  const dup = Object.assign({}, doc.eirpMaskEs[0], { slices: [doc.eirpMaskEs[0].slices[0], doc.eirpMaskEs[0].slices[0]] });
  ok('W15d [他证] eirp_mask_es 的 by_a/@a 同样查重',
    io.validateMaskDoc({ ntcId: 1, satName: 'T', pfdMasks: [], eirpMaskEs: [dup], eirpMaskSs: [] })
      .errors.some((e) => /by_a\/@a 重复/.test(e.message)));
}

// 相控阵降维
{
  const term = (scan) => Object.assign({}, W.terminal, { kind: 'M.2101', arrayElements: 64, scanAnglesDeg: scan });
  const dirs = { down: false, is: false, up: true };
  const one = mkW({ directions: dirs, terminal: term([0]) });
  const fam = mkW({ directions: dirs, terminal: term([0, 15, 30, 45]) });
  ok('W16 [自洽] 扫描角族被降维到二维 T 型并报告损失',
    fam.meta.eirpEs.scanCount === 4 && fam.meta.eirpEs.dimReductionLossDb > 0,
    `${fam.meta.eirpEs.scanCount} 个扫描角 · 降维损失 ${fam.meta.eirpEs.dimReductionLossDb.toFixed(3)} dB`);
  approx('W16b [自洽] 单一扫描角时降维不吃 dB', one.meta.eirpEs.dimReductionLossDb, 0, 1e-12);
  // 逐点取最大 ⇒ 族包络处处 ≥ 单角；主瓣按 1/cosθs 展宽 ⇒ 肩部必有严格更高的点
  const vOne = one.doc.eirpMaskEs[0].slices[0].cells.map((c) => c.v);
  const vFam = fam.doc.eirpMaskEs[0].slices[0].cells.map((c) => c.v);
  ok('W16c [自洽] 扫描族包络处处 ≥ 单角，且至少一点严格更高（降维不是空转）',
    vFam.every((v, i) => v >= vOne[i] - 1e-9) && vFam.some((v, i) => v > vOne[i] + 1e-9));
}

// esPatterns
{
  // [他证] S.580-6 与 S.465-6 只差 3 dB 常数项
  const p = { kind: 'S.580-6', diameterM: 1.2, wavelengthM: 0.0256, efficiency: 0.65 };
  const a = esPat.makeEsPattern(p), b = esPat.makeEsPattern(Object.assign({}, p, { kind: 'S.465-6' }));
  approx('W17 [他证] S.465 比 S.580 高 3 dB（32 vs 29 − 25lgφ）', b.gainDb(10) - a.gainDb(10), 3, 1e-9);
  approx('W18 [他证] S.580-6 在 10° 处 = 29 − 25·lg10 = 4 dBi', a.gainDb(10), 4, 1e-9);
  approx('W19 [他证] φ_min = max(1°, 100λ/D)', esPat.phiMinDeg(1.2, 0.0256), Math.max(1, 100 * 0.0256 / 1.2), 1e-12);

  // 单调包络：处处 ≥ 原值，且是最紧的单调上包络
  const raw = [10, 6, 8, 3, 5, 1];
  const m = esPat.monotoneEnvelope(raw);
  ok('W20 [自洽] 后缀取最大给出单调不增序列', esPat.assertMonotonicDecreasing(m.values).ok);
  ok('W21 [他证] 单调包络处处 ≥ 原值（安全）', m.values.every((v, i) => v >= raw[i] - 1e-12));
  ok('W22 [他证] 且等于逐点后缀最大（最紧）',
    m.values.every((v, i) => Math.abs(v - Math.max.apply(null, raw.slice(i))) < 1e-12));

  // ★ M.2101 旁瓣底板：不给 floorDbi 时取 −10 dBi。若底板算成 NaN，主瓣外全 NaN，
  //   经逐点取最大（NaN 比较恒 false）塌成 −Infinity，再被 clamp 成 −999「永不发射」，
  //   而 XSD 校验照样放行 —— 一份全哑的 mask 能一路落盘。
  const m2 = { kind: 'M.2101', diameterM: 0.6, wavelengthM: 0.0104, arrayElements: 256 };
  const pa = esPat.makeEsPattern(m2);
  const gs = [0, 1, 2, 4, 10, 30, 90, 180].map((x) => pa.gainDb(x));
  ok('W22b [自洽] M.2101 主瓣外全程有限', gs.every(Number.isFinite), `G(4°)=${gs[3]}`);
  ok('W22c [自洽] M.2101 随角度单调滚降', gs.every((v, i) => i === 0 || v <= gs[i - 1] + 1e-9));
  approx('W22d [自洽] 缺省底板 = −10 dBi', pa.gainDb(180), -10, 1e-12);
  approx('W22e [自洽] 显式 floorDbi 覆盖缺省底板',
    esPat.makeEsPattern(Object.assign({}, m2, { floorDbi: 0 })).gainDb(180), 0, 1e-12);

  // 扫描角（M.2101 §5「单元方向图 + 阵因子」）：峰值损失出自单元图、展宽出自阵因子
  approx('W22f [他证] 扫描 45° 的峰值损失 = −min(12(45/65)², 30)',
    esPat.makeEsPattern(Object.assign({}, m2, { scanAngleDeg: 45 })).gainDb(0) - pa.gainDb(0),
    -12 * Math.pow(45 / 65, 2), 1e-12);
  const rel = (scan, x) => {
    const q = esPat.makeEsPattern(Object.assign({}, m2, { scanAngleDeg: scan }));
    return q.gainDb(x) - q.gainDb(0);
  };
  approx('W22g [他证] 主瓣按 1/cosθs 展宽：φ 与 φ/cosθs 处相对电平相同',
    rel(45, 2 / Math.cos(45 * Math.PI / 180)), rel(0, 2), 1e-9);
  throws('W22h [守卫] 扫描角 ≥ 90°（cosθs→0，主瓣宽发散）→ 抛',
    () => esPat.makeEsPattern(Object.assign({}, m2, { scanAngleDeg: 90 })).gainDb(1), /扫描角/);
}

// Art.22 限值表：内置 7 张表 214 点（2020/2024 两版官方 RR PDF 逐点比对一致）
{
  ok('W23 [他证] 内置限值表自加载', art22.hasLimitTables());
  const meta = art22.limitTablesMeta();
  ok('W24 [他证] 表来源标注到 RR 版次与页码', !!(meta && /Radio Regulations/.test(meta.source)), meta && meta.source);

  // 频段 → 参考带宽是【反查】不是自由输入；RR No.22.5C.7 命中两个带宽时两个都要满足
  const ku = art22.refBwForBand(10.7, 12.75, 'down');
  ok('W25 [他证] Ku 下行反查到 40 kHz', ku.ok && ku.refBwKhz.length === 1 && ku.refBwKhz[0] === 40);
  const ka = art22.refBwForBand(17.8, 18.5, 'down');
  ok('W26 [他证] 17.8–18.5 GHz 同时命中 40 kHz 与 1 MHz（22-1B）',
    ka.ok && ka.refBwKhz.length === 2 && ka.refBwKhz.includes(40) && ka.refBwKhz.includes(1000));

  // ★ 竖直段：同一 percentTime 两个 epfd，是 RR 原表结构，排序/去重会毁掉
  const t1a = art22.tablesForBand(10.7, 12.75, 'down').find((t) => t.tableId === '22-1A');
  const e12 = t1a.entries.find((e) => e.antennaDiameterM === 1.2);
  const vert = e12.points.filter((p, i, a) => a.some((q, j) => j !== i && q.percentTime === p.percentTime));
  ok('W27 [他证] 22-1A/1.2m 保留了 99.997 处的竖直段（两个 epfd）',
    vert.length === 2 && vert[0].percentTime === 99.997, JSON.stringify(vert));
  approx('W28 [他证] 命中竖直段端点时取更严的那一支', art22.limitAtPercent(e12.points, 99.997), -160.5, 1e-12);

  // ★ RR No.22.5C.5：epfd 线性(dB) × 时间百分比【对数】。轴取超越百分比 (100 − pct)
  {
    const pts = [{ percentTime: 0, epfdDb: -180 }, { percentTime: 99, epfdDb: -160 }];
    // 超越百分比：0% → 100，99% → 1。取 90%（超越 10）应落在对数中点 ⇒ epfd 中点 −170
    approx('W29 [他证] 对数时间轴：90% 恰在 log 中点 ⇒ epfd 取中点',
      art22.limitAtPercent(pts, 90), -170, 1e-9);
    // 若误用线性轴，90% 会给 −180 + (90/99)×20 ≈ −161.8，差 8 dB 以上
    ok('W30 [他证] 与线性轴口径显著不同（误用会差 8 dB 以上）',
      Math.abs(art22.limitAtPercent(pts, 90) - (-180 + (90 / 99) * 20)) > 8);
  }

  // 纬度附加限值三段（RR No.22.5C.4 / No.22.5C.8），两端必须连续
  approx('W31 [他证] |lat| ≤ 57.5 ⇒ −160', art22.additionalLatitudeLimitDb(30), -160, 1e-12);
  approx('W32 [他证] 中段公式 −160 + 3.4(57.5−|lat|)/4，60° ⇒ −162.125',
    art22.additionalLatitudeLimitDb(60), -162.125, 1e-12);
  approx('W33 [他证] 63.75° 处 = −165.3125（RR 表列 −165.3）',
    art22.additionalLatitudeLimitDb(63.75), -165.3125, 1e-12);
  approx('W34 [他证] |lat| > 63.75 ⇒ −165.3', art22.additionalLatitudeLimitDb(80), -165.3, 1e-12);
  approx('W35 [他证] 57.5° 两侧连续', art22.additionalLatitudeLimitDb(57.5),
    art22.additionalLatitudeLimitDb(57.5001), 1e-3);

  // 天花板：按 refBwKhz 分桶（No.22.5C.7），不跨带宽取最低点
  const c = art22.ceilingCurves({ lowGhz: 17.8, highGhz: 18.5, wavelengthM: 0.0167, percentTime: 100, phiStepDeg: 5 });
  ok('W36 [他证] 天花板按参考带宽分桶', c.ok && Object.keys(c.groups).length === 2
    && c.groups['40'] && c.groups['1000']);
  const g40 = c.groups['40'][0];
  const p0 = g40.points.find((q) => q[0] === 0);
  approx('W37 [他证] φ=0 时天花板 = epfd 限值（鉴别度为 0）', p0[1], g40.epfdLimitDb, 0.05);
  ok('W38 [他证] 远轴天花板高于主轴（干扰源越偏，允许 PFD 越高）',
    g40.points[g40.points.length - 1][1] > p0[1]);
  const hr = art22.headroomDb(-140, c.groups);
  ok('W39 [自洽] headroom 逐带宽各报一个，不混算',
    Object.keys(hr).length === 2 && hr['40'].refBwKhz === 40 && hr['1000'].refBwKhz === 1000,
    JSON.stringify(Object.keys(hr)));
  ok('W40 [他证] 两个带宽的天花板不同 ⇒ 混算必然选错约束',
    Math.abs(hr['40'].bindingCeilingDb - hr['1000'].bindingCeilingDb) > 1);

  // ★ 天花板的最低点恒在 φ=0，而 pfd_mask 已把 α₀ 烘焙进去（α<α₀ 的格全是 −999）。
  //   受扰 GSO 站看自己那颗星与看该 NGSO 星的夹角 φ，恒 ≥ 它看 GSO **弧** 的 α，
  //   故 φ<α₀ ⇒ 该方向根本不发射，那一段天花板不绑定。不排除会把 headroom 低报几十 dB。
  ok('W40b [自洽] 不给 minPhiDeg 时绑定点在 φ=0（= 假设无任何规避，最保守）',
    hr['40'].bindingPhiDeg === 0 && hr['40'].minPhiDeg === 0);
  const hr20 = art22.headroomDb(-140, c.groups, { minPhiDeg: 20 });
  ok('W40c [自洽] 给了 α₀=20° 后绑定点移到 φ≥20°，headroom 相应放开',
    hr20['40'].bindingPhiDeg >= 20 && hr20['40'].headroomDb > hr['40'].headroomDb,
    `φ=${hr['40'].bindingPhiDeg}° → ${hr20['40'].bindingPhiDeg}°，headroom ${hr['40'].headroomDb.toFixed(1)} → ${hr20['40'].headroomDb.toFixed(1)} dB`);
  ok('W40d [量化] 忽略 α₀ 的低报量 = 受扰站在 α₀ 处的鉴别度，量级几十 dB',
    hr20['40'].headroomDb - hr['40'].headroomDb > 20,
    `低报 ${(hr20['40'].headroomDb - hr['40'].headroomDb).toFixed(1)} dB`);
  ok('W40e [守卫] minPhiDeg 大到滤空整条曲线时不给数，而不是给个假的',
    Object.keys(art22.headroomDb(-140, c.groups, { minPhiDeg: 500 })).length === 0);

  // ★ 22-2 / 22-3 的受扰参考是 GSO 空间站波束宽度 + S.672-4，本版未实现 ⇒ 必须明确跳过而非硬算
  const up = art22.ceilingCurves({ lowGhz: 12.8, highGhz: 14.5, wavelengthM: 0.021, direction: 'up' });
  ok('W41 [守卫] 上行天花板被 S.672 门控挡住，不拿 S.1428 硬算',
    up.ok === false && /S\.672/.test(up.skipped.join(' ') + up.reason));

  // 未录入表时必须明确拒绝
  art22.clearLimitTables();
  ok('W42 [守卫] 清空后 hasLimitTables() = false', art22.hasLimitTables() === false);
  const r = art22.ceilingCurves({ lowGhz: 10.7, highGhz: 12.75, wavelengthM: 0.0256 });
  ok('W43 [守卫] 未录入时天花板明确报错而不是给错数', r.ok === false && /未录入/.test(r.reason));
  ok('W44 [守卫] 未录入时参考带宽反查也明确报错', art22.refBwForBand(10.7, 12.75, 'down').ok === false);
  // 恢复内置表，避免影响后续
  const bundled = require('../utils/pfdmask/art22Limits.json');
  art22.loadLimitTables(bundled.tables, bundled.meta);
  ok('W45 [自洽] 外部注入通道可用（RR 改版时换表）', art22.hasLimitTables());
}

// ---------------------------------------------------------------------------
console.log('\n--- F 组：出包粒度（分文件） ---');
// ---------------------------------------------------------------------------
{
  const { doc } = mkW();
  const modes = { single: 1, 'per-kind': 3, 'per-mask': 3 };
  for (const [mode, want] of Object.entries(modes)) {
    const fs = io.buildMaskFiles(doc, { mode });
    ok(`F1.${mode} [自洽] ${mode} 切出 ${want} 个文件`, fs.length === want,
      fs.map((f) => f.filename).join(' '));
    // ★ 每个文件都必须是一份【独立完整】的 satellite_system，能单独读回并通过校验
    let allOk = true;
    for (const f of fs) {
      if (!/^<\?xml/.test(f.xml)) allOk = false;
      if (!/<satellite_system /.test(f.xml)) allOk = false;
      const back = io.parseMaskXml(f.xml);
      if (!io.validateMaskDoc(back).ok) allOk = false;
    }
    ok(`F2.${mode} [他证] 每个文件独立完整且通过 XSD`, allOk);
  }

  // per-kind：三个文件各只含一种 mask 元素
  const pk = io.buildMaskFiles(doc, { mode: 'per-kind' });
  const pfdF = pk.find((f) => f.kind === 'pfd_mask');
  ok('F3 [他证] pfd 文件只含 pfd_mask，不含另两种',
    /<pfd_mask /.test(pfdF.xml) && !/<eirp_mask_es /.test(pfdF.xml) && !/<eirp_mask_ss /.test(pfdF.xml));

  // 切分不放宽 mask_id 唯一性：撞号的文档在任何粒度下都出不来
  const bad = JSON.parse(JSON.stringify(doc));
  bad.eirpMaskSs[0].maskId = bad.pfdMasks[0].maskId;
  throws('F4 [他证] 撞号文档在分文件模式下同样被拒（切分不是放宽约束的借口）',
    () => io.buildMaskFiles(bad, { mode: 'per-kind' }), /撞号|unique|XSD/);

  throws('F5 [守卫] 未知出包粒度 → 抛', () => io.buildMaskFiles(doc, { mode: 'per-planet' }), /未知 mode/);

  // 合并模式与分文件模式的内容必须一致（同样的 mask，只是装法不同）
  const one = io.buildMaskFiles(doc, { mode: 'single' })[0];
  const oneBack = io.parseMaskXml(one.xml);
  const merged = { pfd: 0, es: 0, ss: 0 };
  for (const f of pk) {
    const b = io.parseMaskXml(f.xml);
    merged.pfd += b.pfdMasks.length; merged.es += b.eirpMaskEs.length; merged.ss += b.eirpMaskSs.length;
  }
  ok('F6 [自洽] 分文件与合并模式装的是同一批 mask',
    merged.pfd === oneBack.pfdMasks.length && merged.es === oneBack.eirpMaskEs.length
    && merged.ss === oneBack.eirpMaskSs.length);
}

// ---------------------------------------------------------------------------
console.log('\n--- O 组：运行参数（第四份交付物）+ per-mask 命名 ---');
// ---------------------------------------------------------------------------
{
  const opm = require('../utils/pfdmask/operatingParams.js');
  const sc = {
    alpha0Deg: 15, minElevDeg: 20, maxCoFreq: 1, maxCoFreqSat: 1,
    esDensityPerKm2: 1e-5, esDistanceKm: 200, minDurationSec: 400,
  };
  const p = opm.scenarioToOperatingParams(sc, { paramId: 1, lowFreqMhz: 10700, highFreqMhz: 12750 });
  const v = opm.validateOperatingParams(p);
  ok('O1 [自洽] 场景标量升表后通过 §B5.2 校验', v.ok, `${v.errors.length} 错`);

  const xml = opm.buildOperatingParamsXml({ satName: 'Test Ku', ntcId: 1 }, p);
  // ★ 按【字段表】写，不照抄 §B3.3 示例——示例本身有多处笔误
  ok('O2 [他证] 属性名是 min_angle_at_es（示例里丢了 min_ 前缀）', /min_angle_at_es="/.test(xml));
  ok('O3 [他证] min_exclude 用 c= 不是 oc=（示例笔误）', /<min_exclude c="/.test(xml) && !/oc="/.test(xml));
  ok('O4 [他证] 所有属性值都加引号（示例里有裸值）', !/=\s*[^"'\s>][^\s>]*/.test(xml.replace(/="[^"]*"/g, '')));
  ok('O5 [他证] 方位角不超出字段表自述的 000–360（示例写过 370）',
    (xml.match(/elev_angle b="([\d.]+)"/g) || []).every((s) => Number(s.match(/"([\d.]+)"/)[1]) <= 360));
  ok('O6 [他证] 三种维度各就各位：min_exclude 带 c、max_co_freq/min_duration 只带 a、min_elev 嵌 b',
    /<min_exclude c=/.test(xml) && /<max_co_freq a=/.test(xml)
    && /<min_duration a=/.test(xml) && /<min_elev a=[^>]*>\s*<elev_angle b=/.test(xml));
  ok('O7 [他证] 该元素不进 mask 文件（Mask-schema.xsd 的 satellite_system 不含它）',
    !/non_gso_operating_parameters/.test(io.buildMaskXml(mkW().doc)));

  // §B5.2 门槛必须真拦
  const guards = [['esDensity', 0], ['esDistanceKm', -1], ['esLatMax', -95], ['minAngleAtEsDeg', -1], ['maxCoFreqSat', -1]];
  let allGuarded = true;
  for (const [k, bad] of guards) {
    if (opm.validateOperatingParams(Object.assign({}, p, { [k]: bad })).ok) allGuarded = false;
  }
  ok('O8 [他证] §B5.2 的五条取值门槛全部真拦', allGuarded);
  ok('O9 [他证] MIN_DURATION 非零时 MIN_ANGLE_AT_ES 不适用 → 告警',
    opm.validateOperatingParams(Object.assign({}, p, { minAngleAtEsDeg: 5 })).warnings.length > 0);
  ok('O10 [他证] specific 地球站时 ES_DENSITY/DISTANCE 不使用 → 告警',
    opm.validateOperatingParams(Object.assign({}, p, { esType: 'specific' })).warnings.length > 0);
  ok('O11 [守卫] 校验不过时 build 直接抛，不产出非法文件',
    (() => { try { opm.buildOperatingParamsXml({ satName: 'T', ntcId: 1 }, Object.assign({}, p, { esDensity: 0 })); return false; } catch (e) { return /B5\.2/.test(e.message); } })());

  // per-mask 命名：文件名里的 id 必须与文件内部一致（真实件 O3BNEXT1 踩过这个坑）
  const { doc } = mkW();
  const pm = io.buildMaskFiles(doc, { mode: 'per-mask' });
  let idOk = true, tagOk = true;
  for (const f of pm) {
    const inner = (f.xml.match(/mask_id="(\d+)"/) || [])[1];
    const named = (f.filename.match(/Mask_id_(\d+)_/) || [])[1];
    if (inner !== named) idOk = false;
    if (!/_(PFD|EIRP_ES|EIRP_SS)_/.test(f.filename)) tagOk = false;
  }
  ok('O12 [他证] per-mask 文件名里的 mask_id 与文件内部一致', idOk, pm.map((f) => f.filename).join(' '));
  ok('O13 [自洽] 文件名带类型标记 PFD / EIRP_ES / EIRP_SS', tagOk);
}

// ---------------------------------------------------------------------------
console.log('\n--- X 组：星上方向图（对齐 PMGT 屏3 的下拉） ---');
// ---------------------------------------------------------------------------
{
  const satPat = require('../utils/pfdmask/satPatterns.js');
  const H = 900;

  // ★ 防漂移：UI 清单在 src/viz/pfd/useMaskWorkbench.js（ESM，引擎侧 require 不到），
  //   两处的 kind 集合必须一致。这里直接读 UI 文件的源码比对——两份实现漂移会被当场抓到。
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../../src/viz/pfd/useMaskWorkbench.js'), 'utf8');
    const block = src.slice(src.indexOf('export const SAT_PATTERNS'), src.indexOf('export const ES_PATTERNS'));
    const uiKinds = Array.from(block.matchAll(/\{\s*v:\s*'([\w-]+)'/g)).map((m) => m[1]);
    const engineKinds = satPat.SUPPORTED_KINDS.slice();
    ok('X1 [自洽] UI 清单与引擎的方向图集合一致（防两份实现漂移）',
      uiKinds.length === engineKinds.length && uiKinds.every((k) => engineKinds.includes(k)),
      `UI=[${uiKinds}] 引擎=[${engineKinds}]`);
  }

  // ── isoflux：§C2.3.1 的两条规则
  {
    const iso = satPat.makeSatPattern({ kind: 'isoflux', peakGainDbi: 20, satHeightKm: H });
    ok('X2 [他证] isoflux 标记为固定指向且 d≡卫星高度（§C2.3.1）',
      iso.steerable === false && iso.fixedRangeIsAltitude === true);
    // ★ 等效形式：增益不随天底角变（物理上的抬升已被 d≡h 抵消）
    ok('X3 [他证] 等效形式下增益与天底角无关',
      Math.abs(iso.gainDb(0) - iso.gainDb(30)) < 1e-12 && Math.abs(iso.gainDb(0) - 20) < 1e-12);
    // 记录下被等效形式吃掉的物理抬升量，供报告说明
    const Re = 6378.137, r = Re + H;
    const rho0 = Math.asin(Re / r) * 180 / Math.PI;
    approx('X4 [他证] 视场半张角 = asin(Re/(Re+h))', iso.derived.earthHalfAngleDeg, rho0, 1e-9);
    ok('X5 [自洽] 物理边缘抬升被记录下来（不是丢掉）',
      iso.derived.physicalEdgeLiftDb > 10 && iso.derived.physicalEdgeLiftDb < 13,
      `${iso.derived.physicalEdgeLiftDb.toFixed(3)} dB`);

    // ★ 端到端：isoflux 的地面 PFD 必须与天底角无关 —— 这是该类天线的定义
    const base = {
      satName: 'T', ntcId: 1, lowFreqGhz: 10.7, highFreqGhz: 12.75, refBwKhz: 40,
      satHeightKm: H, incDeg: 55, minElevDeg: 20, srsAlpha0Deg: 15, maskAlpha0Deg: 20,
      nAzElPoints: 21, latStepDeg: 15, sepAngleStepDeg: 5, conservativeMarginDb: 1,
      nBeams: 1, minAngleDeg: 5, beamLayout: 'single', maxEirpDbwPerRefBw: -5,
      usePowerControl: false, directions: { down: true }, pfdMaskId: 1,
    };
    const rIso = eng.generateMasks(Object.assign({}, base, { pattern: { kind: 'isoflux', peakGainDbi: 20 } }));
    approx('X6 [他证] isoflux 的地面 PFD 跨度为 0（该类天线的定义）',
      rIso.meta.maxValueDb - rIso.meta.minValueDb, 0, 1e-9);
    // 手算：maxEIRP 已含天线增益 ⇒ 只减扩散损耗（d≡h）再加裕量
    const spreadH = 10 * Math.log10(4 * Math.PI * Math.pow(H * 1000, 2));
    approx('X7 [他证] isoflux PFD = maxEIRP − 10lg(4πh²) + 裕量',
      rIso.meta.minValueDb, -5 - spreadH + 1, 1e-9);

    // 对照：omni 用真实斜距 ⇒ 跨度恰为 20lg(d_max/h)
    const rOmni = eng.generateMasks(Object.assign({}, base, { pattern: { kind: 'omni', peakGainDbi: 5 } }));
    approx('X8 [他证] omni（真实斜距）跨度 = 20lg(d_max/h)',
      rOmni.meta.maxValueDb - rOmni.meta.minValueDb,
      20 * Math.log10(rOmni.meta.dMaxKm / H), 5e-3);
    // 容差 1e-3 而非 1e-9：卫星在大地纬度 55°、大地高 900 km 时，沿【指向地心】的射线
    // 打到 WGS84 椭球的距离不精确等于 900 km（差约 3 m ⇒ 3e-5 dB）。这是椭球法线与地心
    // 方向不同向的固有结果，不是误差——与 E24/E26 记的是同一件事。
    approx('X9 [他证] omni 的最大值（天底处 d≈h）= isoflux 的恒定值',
      rOmni.meta.maxValueDb, rIso.meta.minValueDb, 1e-3);
  }

  // ── omni：各向同性
  {
    const o = satPat.makeSatPattern({ kind: 'omni', peakGainDbi: 5 });
    ok('X10 [他证] omni 各方向增益相同且不改斜距口径',
      o.gainDb(0) === 5 && o.gainDb(90) === 5 && o.steerable === false && o.fixedRangeIsAltitude === false);
  }

  // ── 理论抛物面：Gmax 与滚降
  {
    const D = 0.6, lam = 0.0256, eff = 0.6;
    const par = satPat.makeSatPattern({ kind: 'parabolic', diameterM: D, wavelengthM: lam, efficiency: eff, nullFloorDb: -40 });
    approx('X11 [他证] 抛物面 Gmax = 10lg(η(πD/λ)²)',
      par.peakGainDbi, 10 * Math.log10(eff * Math.pow(Math.PI * D / lam, 2)), 1e-12);
    approx('X12 [他证] 轴向 2J₁(u)/u → 1 ⇒ G(0) = Gmax', par.gainDb(0), par.peakGainDbi, 1e-9);
    ok('X13 [自洽] 零点被 nullFloorDb 钳住，全程有限', (() => {
      for (let a = 0; a <= 180; a += 0.05) {
        const v = par.gainDb(a);
        if (!Number.isFinite(v) || v < par.peakGainDbi - 40 - 1e-9) return false;
      }
      return true;
    })());
    throws('X14 [守卫] 抛物面缺 nullFloorDb → 抛（零点会掉到 −∞）',
      () => satPat.makeSatPattern({ kind: 'parabolic', diameterM: D, wavelengthM: lam, efficiency: eff }), /nullFloorDb/);
  }

  // ── 两级带底
  {
    const tl = satPat.makeSatPattern({
      kind: 'two-level', peakGainDbi: 32, beamwidth1Deg: 2, gainFloor1Db: -30, beamwidth2Deg: 20, gainFloor2Db: -40,
    });
    approx('X15 [自洽] 轴向 = 主轴增益', tl.gainDb(0), 32, 1e-12);
    approx('X16 [自洽] 主瓣在半宽处降 3 dB', tl.gainDb(1), 29, 1e-12);
    approx('X17 [自洽] 主瓣与第一级底之间取 max ⇒ 第一级平台 = 32−30', tl.gainDb(5), 2, 1e-12);
    approx('X18 [自洽] 第二级起始宽度之外 = 32−40', tl.gainDb(30), -8, 1e-12);
    ok('X19 [自洽] 单调不增', (() => {
      let prev = Infinity;
      for (let a = 0; a <= 180; a += 0.1) { const v = tl.gainDb(a); if (v > prev + 1e-9) return false; prev = v }
      return true;
    })());
    ok('X20 [守卫] 第二级底高于第一级时告警（方向图在外层反而抬升）',
      satPat.makeSatPattern({
        kind: 'two-level', peakGainDbi: 32, beamwidth1Deg: 2, gainFloor1Db: -40, beamwidth2Deg: 20, gainFloor2Db: -30,
      }).warnings.length > 0);
  }

  // ── S.1528 分派：必须带上 §1.1「实测优先」的声明
  {
    const p = satPat.makeSatPattern({ kind: 's1528', section: '1.2', peakGainDbi: 32, psibDeg: 1, Ln: -25 });
    ok('X21 [他证] S.1528 走可转向分支', p.steerable === true && p.fixedRangeIsAltitude === false);
    ok('X22 [他证] 带出 §1.1「有实测图应优先用实测图」的声明',
      p.warnings.some((w) => /§1\.1/.test(w) && /实测/.test(w)));
    approx('X23 [自洽] 与直接调 s1528 的结果一致',
      p.gainDb(3), s1528.gainDbS1528_12(3, { peakGainDbi: 32, psibDeg: 1, Ln: -25 }), 1e-12);
  }

  throws('X24 [守卫] 未知方向图 → 抛', () => satPat.makeSatPattern({ kind: 'no-such' }), /未知方向图/);

  // 五种方向图都要能端到端出合规 mask
  {
    const base = {
      satName: 'T', ntcId: 1, lowFreqGhz: 10.7, highFreqGhz: 12.75, refBwKhz: 40,
      satHeightKm: H, incDeg: 55, minElevDeg: 20, srsAlpha0Deg: 15, maskAlpha0Deg: 20,
      nAzElPoints: 11, latStepDeg: 25, sepAngleStepDeg: 10, conservativeMarginDb: 1,
      nBeams: 1, minAngleDeg: 5, beamLayout: 'single', maxEirpDbwPerRefBw: -5,
      usePowerControl: false, directions: { down: true }, pfdMaskId: 1,
    };
    const pats = [
      { kind: 's1528', section: '1.2', peakGainDbi: 32, psibDeg: 1, Ln: -25 },
      { kind: 'isoflux', peakGainDbi: 20 },
      { kind: 'omni', peakGainDbi: 5 },
      { kind: 'parabolic', diameterM: 0.6, efficiency: 0.6, wavelengthM: 0.0256, nullFloorDb: -40 },
      { kind: 'two-level', peakGainDbi: 32, beamwidth1Deg: 2, gainFloor1Db: -30, beamwidth2Deg: 20, gainFloor2Db: -40 },
    ];
    let allOk = true;
    for (const pat of pats) {
      const r = eng.generateMasks(Object.assign({}, base, { pattern: pat }));
      if (!io.validateMaskDoc(r.doc).ok) { allOk = false; console.log(`   ${pat.kind} 未通过 XSD`) }
    }
    ok('X25 [他证] 五种方向图端到端都出合规 mask', allOk);
  }
}

console.log(`\n=== 合计 ${pass + fail} 条：PASS ${pass} / FAIL ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
