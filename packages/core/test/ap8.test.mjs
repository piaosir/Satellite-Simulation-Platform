// RR 附录 8 协调触发 + 地球站参考方向图库 + C/XPI 雨致 XPD 来源（2026-10-17「18 条会算错」修复轮 · D-01 / D-02 / D-12）
//   运行： node packages/core/test/ap8.test.mjs
//
// 外部金标准（原文均已取得、逐条核对）：
//   · ITU《无线电规则》2024 年版第 2 卷（PDF SHA-256 49e283a5c22e57b44b5e0220eee94df4a7d2055418662bf83c125475d98f3abf）
//       附录 8（Rev.WRC-15）：附件 3 地球站方向图、附件 4 算例（ΔTs 145 K / ΔTe 3.6 K / ΔT/T 7.8%）、§2.2.3 极化隔离因子表、
//       附件 1 / 2 几何式；附录 5（Rev.WRC-23）表 5-1 No.9.7 GSO/GSO 一行（协调弧逐行）。
//   · ITU-R S.465-6（01/2010）recommends 2 与 Note 5；ITU-R S.580-6（01/2004）recommends 1/2 与 Note 3/5
//     （PDF SHA-256 529186072dad7c8fad2e5df3f5d242832d84a9e2297ac82985f2230f086f7bec）。
// 期望值凡带「原文」二字的，都是照建议书 / 规则原文在测试里现算，不是把实现的输出抄回来。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const P = require('../utils/interference/patterns.js');
const G = require('../utils/interference/geometry.js');
const A = require('../utils/interference/ciAsi.js');
const XP = require('../utils/interference/ciXpi.js');
const AP8 = require('../utils/itu/ap8.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
};
const approx = (name, got, want, tol) => {
  const g = Number(got);
  const c = Number.isFinite(g) && Math.abs(g - want) <= tol;
  console.log((c ? 'PASS' : 'FAIL') + `  ${name}  (got=${Number.isFinite(g) ? g.toFixed(6) : g}, want≈${want} ±${tol})`);
  c ? pass++ : fail++;
};
const lg = Math.log10;
const lamOf = (f) => 299792458 / (f * 1e9);
const BJ = { lon: 116.4074, lat: 39.9042, alt: 0 };

// ═══ ① RR 附录 8 附件 4 算例（金标准）═══
console.log('=== ① 附录 8 附件 4 算例 ===');
{
  // 原文输入（dB）：上行 6175 MHz  P′e −37 dB(W/Hz)、G′1(θt) 14.5、G2(δe′) 15.5、Lu 200；
  //               下行 3950 MHz  P′s −57 dB(W/Hz)、G′3(ηe) 15.5、G4(θt) 14.5、Ld 196；10lgγ −15 dB；T 105 K；θt 5°
  const dTs = AP8.deltaTsK(-37, 14.5, 15.5, 200);
  const dTe = AP8.deltaTeK(-57 + 15.5, 14.5, 196);          // 式(2) 的 p′s·g′3 合成一个 EIRP 密度
  const c = AP8.combineDeltaT(dTs, dTe, -15, 105, 1, 1);
  approx('ΔTs = 10^((−37+14.5+15.5+228.6−200)/10) = 144.54 K（原文 145 K）', dTs, Math.pow(10, 21.6 / 10), 1e-9);
  ok('ΔTs 按原文精度取整 = 145 K', Math.round(dTs) === 145, dTs.toFixed(2));
  approx('ΔTe = 10^((−57+15.5+14.5+228.6−196)/10) = 3.631 K（原文 3.6 K）', dTe, Math.pow(10, 5.6 / 10), 1e-9);
  ok('ΔTe 按原文精度 = 3.6 K', dTe.toFixed(1) === '3.6', dTe.toFixed(3));
  approx('ΔT = γΔTs + ΔTe = 8.20 K（原文 0.032×145 + 3.6 = 8.2 K）', c.deltaTK, Math.pow(10, -1.5) * dTs + dTe, 1e-12);
  ok('ΔT 按原文精度 = 8.2 K', c.deltaTK.toFixed(1) === '8.2', c.deltaTK.toFixed(3));
  approx('ΔT/T = 7.81%（原文 7.8%，超 6%）', c.pct, 7.811, 0.001);
  ok('ΔT/T 按原文精度 = 7.8%', c.pct.toFixed(1) === '7.8');
  // 原文：「D/λ > 100 的参考方向图 (32 − 25 log θt) 在 5° 给出 14.5 dBi」
  approx('附件 3 a) 在 θt = 5° = 32 − 25lg5 = 14.5 dBi', P.ap8AnnexIIIGain(55, 150, 5), 32 - 25 * lg(5), 1e-12);
  ok('…按原文精度 = 14.5 dBi', P.ap8AnnexIIIGain(55, 150, 5).toFixed(1) === '14.5');
  approx('K_DB = 228.6（附件 4 的 dB 算式）', AP8.K_DB, 228.6, 1e-12);
}

// ═══ ② 地球站方向图库 ═══
console.log('\n=== ② 方向图：RR 附录 8 附件 3 ===');
{
  // a) D/λ ≥ 100（4.5 m @ 12.5 GHz，D/λ = 187.6）
  const lam = lamOf(12.5), D = 4.5, r = D / lam, gmax = P.peakGainDbi(D, lam, 0.65);
  const g1 = 2 + 15 * lg(r), phiM = (20 / r) * Math.sqrt(gmax - g1), phiR = 15.85 * Math.pow(r, -0.6);
  ok('构造：D/λ ≥ 100 且 φm < φr', r >= 100 && phiM < phiR, `D/λ=${r.toFixed(1)} φm=${phiM.toFixed(4)} φr=${phiR.toFixed(4)}`);
  approx('主瓣 = Gmax − 2.5e−3(Dφ/λ)²（原文）', P.offAxisAP8AnnexIII(D, lam, 0.65, phiM * 0.5), gmax - 2.5e-3 * Math.pow(r * phiM * 0.5, 2), 1e-9);
  approx('G1 = 2 + 15lg(D/λ)（原文）', P.offAxisAP8AnnexIII(D, lam, 0.65, (phiM + phiR) / 2), g1, 1e-9);
  approx('φr ≤ φ < 48°：32 − 25lgφ（原文）', P.offAxisAP8AnnexIII(D, lam, 0.65, 2.81), 32 - 25 * lg(2.81), 1e-9);
  approx('48° ≤ φ：−10 dBi（原文）', P.offAxisAP8AnnexIII(D, lam, 0.65, 60), -10, 1e-12);
  approx('φm 处主瓣与 G1 相接', P.offAxisAP8AnnexIII(D, lam, 0.65, phiM - 1e-9), g1, 1e-6);
  // 15.85 ≈ 10^1.2：φr 处 32 − 25lgφr = 2 + 15lg(D/λ) − 0.0007 dB，原文常数取整所致
  approx('φr 处 G1 与 32 − 25lgφ 相接（差 < 0.001 dB，原文 15.85 取整）', 32 - 25 * lg(phiR), g1, 1e-3);
  // b) D/λ < 100（1.2 m @ 12.5 GHz，D/λ = 50.0）
  const D2 = 1.2, r2 = D2 / lam, gm2 = P.peakGainDbi(D2, lam, 0.65), g12 = 2 + 15 * lg(r2);
  ok('构造：D/λ < 100', r2 < 100, `D/λ=${r2.toFixed(2)}`);
  approx('100λ/D ≤ φ < 48°：52 − 10lg(D/λ) − 25lgφ（原文）', P.offAxisAP8AnnexIII(D2, lam, 0.65, 5), 52 - 10 * lg(r2) - 25 * lg(5), 1e-9);
  approx('48° ≤ φ：10 − 10lg(D/λ)（原文）', P.offAxisAP8AnnexIII(D2, lam, 0.65, 90), 10 - 10 * lg(r2), 1e-9);
  approx('100λ/D 处旁瓣段与 G1 天然相接', 52 - 10 * lg(r2) - 25 * lg(100 / r2), g12, 1e-9);
  approx('φm ≤ φ < 100λ/D：G1', P.offAxisAP8AnnexIII(D2, lam, 0.65, 1.9), g12, 1e-9);
  ok('增益不超过 Gmax', P.offAxisAP8AnnexIII(D2, lam, 0.65, 0.01) <= gm2 + 1e-12);
  // 脚注 4：只给主瓣增益时 20lg(D/λ) ≈ Gmax − 7.7
  approx('脚注 4：D/λ = 10^((Gmax − 7.7)/20)', P.dOverLambdaFromGain(47.7), 100, 1e-9);
  const pg = P.makeEsPattern('RR-AP8-A3', undefined, lam, undefined, { gainDbi: 47.7 });
  ok('只给增益也能出方向图，并标 D/λ 为估计', !!pg && pg.dOverLambdaEstimated === true && Math.abs(pg.dOverLambda - 100) < 1e-9);
  // 差距分析 D-02 量级（旧版 − 附件 3）：0.75 m Ku 5° 处 −8.05 dB；1.8 m C 5° 处 −9.19 dB
  approx('旧版比附件 3 低：0.75 m Ku（D/λ≈31）5° → 8.05 dB', P.offAxisAP8AnnexIII(0.75, lam, 0.65, 5) - P.offAxisS580Hybrid(0.75, lam, 0.65, 5), 8.05, 0.01);
  approx('旧版比附件 3 低：1.8 m C 4 GHz（D/λ≈24）5° → 9.19 dB', P.offAxisAP8AnnexIII(1.8, lamOf(4), 0.65, 5) - P.offAxisS580Hybrid(1.8, lamOf(4), 0.65, 5), 9.19, 0.01);
  approx('旧版比附件 3 低：D/λ ≥ 100 → 3.00 dB', P.offAxisAP8AnnexIII(D, lam, 0.65, 3) - P.offAxisS580Hybrid(D, lam, 0.65, 3), 3, 1e-9);
}

console.log('\n=== ② 方向图：ITU-R S.465-6 ===');
{
  const lam = lamOf(12.5);
  // φmin：D/λ ≥ 50 → max(1°, 100λ/D)；D/λ < 50 → max(2°, 114(D/λ)^−1.09)；接收且 D/λ < 33.3 → 2.5°（Note 5）
  approx('φmin（D/λ = 200）= 1°', P.s465PhiMin(200), 1, 1e-12);
  approx('φmin（D/λ = 60）= 100/60', P.s465PhiMin(60), 100 / 60, 1e-12);
  approx('φmin（D/λ = 40）= max(2, 114·40^−1.09)', P.s465PhiMin(40), Math.max(2, 114 * Math.pow(40, -1.09)), 1e-12);
  approx('φmin（D/λ = 20）= 114·20^−1.09 = 4.10°', P.s465PhiMin(20), 114 * Math.pow(20, -1.09), 1e-12);
  approx('Note 5：接收天线 D/λ = 20 → 2.5°', P.s465PhiMin(20, true), 2.5, 1e-12);
  approx('Note 5 只管 D/λ < 33.3：接收 D/λ = 40 照常', P.s465PhiMin(40, true), P.s465PhiMin(40), 1e-12);
  approx('D/λ = 50 两档在边界处相接（= 2°）', P.s465PhiMin(50), 2, 1e-12);
  approx('φmin ≤ φ < 48°：32 − 25lgφ（原文）', P.offAxisS465_6(4.5, lam, 0.65, 3), 32 - 25 * lg(3), 1e-9);
  approx('48° ≤ φ ≤ 180°：−10 dBi（原文）', P.offAxisS465_6(0.75, lam, 0.65, 100), -10, 1e-12);
  approx('D/λ < 50 的旁瓣也是 32 − 25lgφ（与附件 3 b) 不同）', P.offAxisS465_6(0.75, lam, 0.65, 10), 32 - 25 * lg(10), 1e-9);
  // φ < φmin 建议书不设定：主瓣抛物线、以 φmin 处包络值封底
  const r = 4.5 / lam, gmax = P.peakGainDbi(4.5, lam, 0.65);
  approx('φ < φmin：主瓣抛物线', P.offAxisS465_6(4.5, lam, 0.65, 0.1), gmax - 2.5e-3 * Math.pow(r * 0.1, 2), 1e-9);
  approx('φ < φmin：抛物线跌破包络后以 φmin 处包络值封底', P.offAxisS465_6(4.5, lam, 0.65, 0.9), 32 - 25 * lg(1), 1e-9);
  let mono = true, prev = Infinity;
  for (let phi = 0.05; phi <= 170; phi *= 1.03) { const g = P.offAxisS465_6(4.5, lam, 0.65, phi); if (g > prev + 1e-9) { mono = false; break; } prev = g; }
  ok('4.5 m Ku 全角域单调不增（φmin 处连续）', mono);
}

console.log('\n=== ② 方向图：ITU-R S.580-6（设计目标）===');
{
  const lam = lamOf(12.5);
  approx('φmin ≤ φ ≤ 20°：29 − 25lgφ（recommends 1）', P.offAxisS580_6(4.5, lam, 0.65, 10), 29 - 25 * lg(10), 1e-9);
  approx('20° < φ ≤ 26.3°：−3.5 dBi（Note 5）', P.offAxisS580_6(4.5, lam, 0.65, 23), -3.5, 1e-12);
  approx('26.3° < φ < 48°：32 − 25lgφ（recommends 2 → S.465）', P.offAxisS580_6(4.5, lam, 0.65, 30), 32 - 25 * lg(30), 1e-9);
  approx('48° ≤ φ：−10 dBi', P.offAxisS580_6(4.5, lam, 0.65, 70), -10, 1e-12);
  ok('Note 3：D/λ < 50 不适用 → null', P.offAxisS580_6(0.75, lam, 0.65, 5) === null);
  const fb = P.makeEsPattern('S.580-6', 0.75, lam, 0.65, { receive: true });
  ok('选 S.580-6 遇 D/λ < 50：退回 S.465-6 并如实上报', fb.id === 'S.580-6' && fb.applied === 'S.465-6' && fb.fellBack && /Note 3/.test(fb.reason), fb.reason);
  approx('退回后的值 = S.465-6（接收）', fb.gain(5), P.offAxisS465_6(0.75, lam, 0.65, 5, { receive: true }), 1e-12);
}

console.log('\n=== ② 方向图库：ID、缺省与旧版 ===');
{
  const lam = lamOf(12.5);
  ok('四条 ID 齐全', ['S.465-6', 'RR-AP8-A3', 'S.580-6', 'S580-HYB'].every((k) => P.ES_PATTERNS[k] && P.ES_PATTERNS[k].name && P.ES_PATTERNS[k].edition));
  ok('C/ASI 缺省 = S.465-6，AP8 恒用 RR-AP8-A3', P.DEFAULT_ASI_PATTERN === 'S.465-6' && P.AP8_PATTERN === 'RR-AP8-A3');
  ok('未知 / 缺省 ID → S.465-6', P.makeEsPattern(undefined, 4.5, lam, 0.65).applied === 'S.465-6' && P.makeEsPattern('xyz', 4.5, lam, 0.65).applied === 'S.465-6');
  ok('旧名 offAxisAP8 已不存在（只留如实命名的 offAxisS580Hybrid）', P.offAxisAP8 === undefined && typeof P.offAxisS580Hybrid === 'function');
  // 旧版包络行为一位不改（v1.5.3 的三档：29−25lgφ 到 36.31° / 39−5lg(D/λ)−25lgφ / 29−25lgφ 接 10−10lg(D/λ)）
  approx('旧版 大档 29 − 25lgφ', P.offAxisS580Hybrid(4.5, lam, 0.65, 3), 29 - 25 * lg(3), 1e-12);
  approx('旧版 中档 39 − 5lg(D/λ) − 25lgφ', P.offAxisS580Hybrid(1.2, lam, 0.65, 10), 39 - 5 * lg(1.2 / lam) - 25 * lg(10), 1e-12);
  approx('旧版 小档底板 10 − 10lg(D/λ)', P.offAxisS580Hybrid(0.75, lam, 0.65, 60), 10 - 10 * lg(0.75 / lam), 1e-12);
  const hyb = P.makeEsPattern('S580-HYB', 4.5, lam, 0.65);
  let same = true;
  for (let phi = 0.01; phi < 180; phi *= 1.05) if (hyb.gain(phi) !== P.offAxisS580Hybrid(4.5, lam, 0.65, phi)) { same = false; break; }
  ok('makeEsPattern(S580-HYB) 与 offAxisS580Hybrid 全角域逐位一致', same);
  ok('结构角带名称（供图上标注）', P.makeEsPattern('S.465-6', 4.5, lam, 0.65).marks.some((m) => m.key === 'phir' && Math.abs(m.deg - 1) < 1e-12));
  ok('esPatternInfo 无函数、可过 IPC', (() => { try { structuredClone(P.esPatternInfo(hyb)); return true; } catch (e) { return false; } })());
}

// ═══ ③ C/ASI 按所选方向图算（D-02 的订正量）═══
console.log('\n=== ③ C/ASI 订正量 ===');
{
  const run = (D, esPattern) => {
    const d = A.downlinkCAsi({
      station: BJ, rx: { diameterM: D, efficiency: 0.65, freqGHz: 12.5 }, esPattern,
      wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
      interferers: [113, 108].map((lon, i) => ({ id: 's' + i, lonDeg: lon, eirpDensityDbWPerHz: -45, polarization: 'H' }))
    });
    return d;
  };
  for (const D of [4.5, 0.75]) {
    const a = run(D, 'S580-HYB'), b = run(D);
    ok(`下行 ${D} m：缺省 S.465-6 比旧版恰低 3 dB（两源都在旁瓣段）`, Math.abs((a.ciDb - b.ciDb) - 3) < 1e-9, `${a.ciDb.toFixed(3)} → ${b.ciDb.toFixed(3)}`);
    ok(`下行 ${D} m：结果写明所用方向图 ID 与版本`, b.geometry.esPattern.applied === 'S.465-6' && b.geometry.esPattern.edition === '01/2010');
  }
  const c = run(1.2), h = run(1.2, 'S580-HYB'), a8 = run(1.2, 'RR-AP8-A3');
  ok('1.2 m Ku：旧版 > S.465-6 > 附件 3（C/ASI，dB）', h.ciDb > c.ciDb && c.ciDb > a8.ciDb, `${h.ciDb.toFixed(3)} / ${c.ciDb.toFixed(3)} / ${a8.ciDb.toFixed(3)}`);
  const s580 = run(0.75, 'S.580-6');
  ok('0.75 m 选 S.580-6 → 告警并按 S.465-6 计', s580.geometry.esPattern.applied === 'S.465-6' && s580.warnings.some((w) => /S\.580-6/.test(w)));
  // 曲线与标注用的是同一条方向图
  const g = run(4.5).geometry;
  const at = g.patternCurve.find((p) => p.deg > 3);
  approx('方向图切面曲线 = 所选方向图', at.gainDbi, +P.offAxisS465_6(4.5, lamOf(12.5), 0.65, at.deg, { receive: true }).toFixed(3), 1e-9);
}

// ═══ ④ 极化隔离因子 Y（附录 8 §2.2.3 表）═══
console.log('\n=== ④ 极化隔离因子 Y ===');
{
  const Y = (a, b) => AP8.polarizationIsolationY(a, b).y;
  ok('LHC / RHC → 4（平台 L / R 即左 / 右旋圆）', Y('L', 'R') === 4 && Y('R', 'L') === 4 && Y('LHC', 'RHC') === 4);
  ok('圆 / 线 → 1.4（两网对调同值）', Y('L', 'H') === 1.4 && Y('V', 'R') === 1.4 && Y('LIN', 'LHC') === 1.4);
  ok('同旋向圆、线 / 线 → 1（附录 8 不认线极化正交隔离：H 对 V 也是 1）', Y('L', 'L') === 1 && Y('R', 'R') === 1 && Y('H', 'V') === 1 && Y('H', 'H') === 1);
  ok('极化不明 → 1', Y('', 'H') === 1 && Y('X', 'R') === 1);
}

// ═══ ⑤ 附录 5 表 5-1 No.9.7 协调弧（逐行）═══
console.log('\n=== ⑤ 附录 5 表 5-1 No.9.7 协调弧 ===');
{
  const arc = (f, region, sp, so) => AP8.coordinationArc(f - 0.001, f + 0.001, { region, service: sp, otherService: so });
  const CASES = [
    // [GHz, 区域, 拟议业务, 对方业务, 弧 ±°, 命中项]
    [3.7, 3, 'FSS', 'FSS', 7, '1)'], [5.8, 1, 'FSS', 'FSS', 7, '1)'], [5.8, 3, 'FSS', 'FSS', null, null],
    [6.4, 3, 'FSS', 'FSS', 7, '1)'], [7.05, 2, 'FSS', 'FSS', 7, '1)'],
    [11.0, 3, 'FSS', 'FSS', 6, '2)'], [11.6, 1, 'FSS', 'FSS', 6, '2)'], [11.9, 2, 'FSS', 'FSS', 6, '2)'], [11.9, 3, 'FSS', 'FSS', null, null],
    [12.3, 3, 'FSS', 'FSS', 6, '2)'], [12.3, 1, 'FSS', 'FSS', null, null], [12.6, 1, 'FSS', 'FSS', 6, '2)'], [12.6, 2, 'FSS', 'FSS', null, null],
    [12.72, 2, 'FSS', 'FSS', 6, '2)'], [14.25, 3, 'FSS', 'FSS', 6, '2)'], [14.6, 3, 'SRS', 'FSS', 6, '2) iii)'],
    [13.5, 1, 'FSS', 'FSS', 6, '2bis)'], [13.5, 3, 'FSS', 'FSS', null, null],
    [18.5, 3, 'FSS', 'FSS', 8, '3)'], [17.5, 1, 'FSS', 'FSS', 8, '3)'], [17.5, 3, 'FSS', 'FSS', 8, '7)'], [28.0, 3, 'FSS', 'FSS', 8, '3)'],
    [19.9, 3, 'FSS', 'FSS', 8, '3bis)'], [29.7, 3, 'MSS', 'FSS', 8, '3bis)'],
    [17.5, 1, 'BSS', 'FSS', 8, '4)'], [17.75, 3, 'FSS', 'BSS', 8, '5)'], [18.2, 2, 'MetSat', 'FSS', 8, '6)'], [18.2, 3, 'MetSat', 'FSS', 8, '6)'],
    [21.7, 3, 'BSS', 'BSS', 12, '6bis)'], [21.7, 2, 'BSS', 'BSS', 16, '8)'], [21.7, 3, 'FSS', 'FSS', 8, '7)'],
    [40.0, 3, 'FSS', 'FSS', 8, '7)'], [40.0, 3, 'FSS', 'BSS', 16, '8)'],
    [2.2, 3, 'FSS', 'FSS', null, null], [8.0, 3, 'FSS', 'FSS', null, null]
  ];
  for (const [f, rg, sp, so, want, item] of CASES) {
    const m = arc(f, rg, sp, so);
    ok(`${f} GHz · 区域 ${rg} · ${sp}/${so} → ${want == null ? '无弧（第 9) 项：ΔT/T > 6%）' : '±' + want + '°（' + item + '）'}`,
      m.arcDeg === want && (want == null || m.item === item), `got ${m.arcDeg} ${m.item}`);
  }
  // 跨两行的频段：中国 Ku 下行 12.25–12.75（12.2–12.5 区域 3 与 12.5–12.75 区域 1/3 两行）
  const ku = AP8.coordinationArc(12.25, 12.75, { region: 3 });
  ok('12.25–12.75 GHz（区域 3）命中两段、弧 ±6°', ku.arcDeg === 6 && ku.hits.length === 2);
  ok('数据带出处（RR 2024 Vol.2 PDF SHA-256）', /49e283a5/.test(AP8.AP5_TABLE.sourceSha256) && AP8.AP5_TABLE.rows.length === 12);
}

// ═══ ⑥ 附件 1 / 2 几何（规则口径）对 WGS84 ═══
console.log('\n=== ⑥ 附件 1 / 2 几何 ===');
{
  approx('附件 2 a)：星下点 d = 42644·√(1 − 0.2954) km（原文）', AP8.ruleSlantRangeKm({ lat: 0, lon: 110.5 }, 110.5).km, 42644 * Math.sqrt(1 - 0.2954), 1e-9);
  const dr = AP8.ruleSlantRangeKm(BJ, 110.5).km, dw = G.lookAngles(BJ, G.gsoEcef(110.5)).rangeKm;
  ok('北京 → 110.5°E：附件 2 a) 与 WGS84 斜距差 < 0.15%', Math.abs(dr - dw) / dw < 1.5e-3, `${dr.toFixed(1)} vs ${dw.toFixed(1)} km`);
  ok('cosψ < 0.151 ⇒ 卫星在水平面以下（原文）', AP8.ruleSlantRangeKm(BJ, -60).visible === false && AP8.ruleSlantRangeKm(BJ, 110.5).visible === true);
  approx('附件 2 b)：ds = 84332·sin(θg/2)（原文）', AP8.ruleInterSatKm(2.5), 84332 * Math.sin(1.25 * Math.PI / 180), 1e-9);
  const tr = AP8.ruleTopocentricDeg(BJ, 110.5, 113), tw = G.topocentricAngle(BJ, G.gsoEcef(110.5), G.gsoEcef(113));
  ok('附件 1 拓扑角与 WGS84 差 < 0.01°（北京 110.5 / 113°E）', Math.abs(tr - tw) < 0.01, `${tr.toFixed(4)} vs ${tw.toFixed(4)}`);
  approx('附件 2：L = 20(lg f_MHz + lg d) + 32.45（原文）', AP8.ruleFslDb(12.5, 38000), 20 * (lg(12500) + lg(38000)) + 32.45, 1e-9);
  // 保持容差：两星各向对方挪一个容差
  const ap = G.gsoClosestApproach(110.5, 113, 0.1, 0.05);
  ok('保持容差：θg = |Δλ| − 容差之和', Math.abs(ap.thetaGDeg - 2.35) < 1e-12 && Math.abs(ap.lonA - 110.6) < 1e-12 && Math.abs(ap.lonB - 112.95) < 1e-12);
  const ov = G.gsoClosestApproach(110.5, 110.55, 0.1, 0.1);
  ok('容差之和 ≥ 标称间隔 → 两星可重合，θg = 0', ov.thetaGDeg === 0 && ov.lonA === ov.lonB);
  const wrap = G.gsoClosestApproach(179, -179, 0.1, 0.1);
  ok('跨 180° 经线也按最近方向挪', Math.abs(wrap.thetaGDeg - 1.8) < 1e-9 && Math.abs(wrap.nominalDeg - 2) < 1e-9);
}

// ═══ ⑦ 双向 ΔT/T（式 (1)–(7)、§2.2.1.2、§2.4、Case II）═══
console.log('\n=== ⑦ 双向 ΔT/T ===');
const NET = {
  lonDeg: 110.5, ewTolDeg: 0, region: 3, service: 'FSS', bandwidthHz: 36e6, upCenterGHz: 14.25, dnCenterGHz: 12.5, upPol: 'V', dnPol: 'H',
  txStation: { ...BJ, diameterM: 4.5, efficiency: 0.65 }, rxStation: { ...BJ, diameterM: 4.5, efficiency: 0.65, noiseTempK: 150 },
  txPowerW: 40, txFeederLossDb: 3.5, satEirpDbW: 50, satRxGainDbi: 30, satGtDbPerK: 2, links: []
};
{
  // 与旧函数（本站上行旁瓣进邻星，改用附件 3 后）逐位一致：WGS84、无保持容差、均匀谱折算功率密度
  const leg = A.deltaTOverT({ station: BJ, tx: { diameterM: 4.5, efficiency: 0.65, freqGHz: 14.25, powerW: 40, feederLossDb: 3.5, bandwidthHz: 36e6 }, wanted: { lonDeg: 110.5 }, victim: { lonDeg: 113, gOverTDbPerK: 2, rxGainDbi: 30 } });
  const r0 = AP8.ap8Coordination({ geometry: 'wgs84', own: NET, other: { ...NET, lonDeg: 113, satEirpDensityDbWPerHz: -45 } });
  approx('ΔTs/Ts（上行分量）与旧入口逐位一致（同几何、同方向图）', r0.ownToOther.independent.dTsOverTsPct, leg.deltaTOverTPct, 1e-12);
  ok('旧入口改用附件 3：出参标明是上行分量与方向图 ID', leg.component === 'uplink' && leg.patternId === 'RR-AP8-A3');
  // 逐项可手算：本网 → 邻网 的上行与下行分量
  const u = r0.ownToOther.up, d = r0.ownToOther.dn;
  approx('ΔTs = pe + g1 + g2 − lu + 228.6（dBK）', 10 * lg(u.deltaTsK), u.peDbWPerHz + u.g1Dbi + u.g2Dbi - u.luDb + 228.6, 1e-9);
  approx('pe 缺省 = 10lg P − 馈损 − 10lg B', u.peDbWPerHz, 10 * lg(40) - 3.5 - 10 * lg(36e6), 1e-12);
  approx('g1(θt) = 附件 3（发端站在重叠频段平均频率上）', u.g1Dbi, P.offAxisAP8AnnexIII(4.5, lamOf(14.25), 0.65, u.thetaTDeg), 1e-9);
  approx('ΔTe = ps·g3 + g4 − ld + 228.6（dBK）', 10 * lg(d.deltaTeK), d.satEirpDbWPerHz + d.g4Dbi - d.ldDb + 228.6, 1e-9);
  approx('ps·g3 缺省 = 载波 EIRP − 10lg B', d.satEirpDbWPerHz, 50 - 10 * lg(36e6), 1e-12);
  approx('Ts = 10^((G − G/T)/10)', u.tsK, Math.pow(10, 2.8), 1e-9);
  ok('无 γ → 走 §2.2.1.2 独立分支，headline = max(ΔTs/Ts, ΔTe/Te)', r0.ownToOther.method === 'independent'
    && Math.abs(r0.ownToOther.headlinePct - Math.max(r0.ownToOther.independent.dTsOverTsPct, r0.ownToOther.independent.dTeOverTePct)) < 1e-12);
  ok('出厂示例下行分量远大于上行分量（D-01：只算上行就漏掉了大头）', r0.ownToOther.independent.dTeOverTePct > 10 * r0.ownToOther.independent.dTsOverTsPct,
    `ΔTs/Ts ${r0.ownToOther.independent.dTsOverTsPct.toFixed(3)}% · ΔTe/Te ${r0.ownToOther.independent.dTeOverTePct.toFixed(2)}%`);
  ok('超 6% 只给 exceeds 布尔（着色用），不出文字判定', r0.ownToOther.exceeds === true && typeof r0.ownToOther.exceeds === 'boolean');

  // 两网同构 → 两个方向的上行分量相同（下行分量随各自卫星 EIRP 密度不同而不同）
  const sym = AP8.ap8Coordination({ geometry: 'wgs84', own: NET, other: { ...NET, lonDeg: 113 } });
  approx('两网同构：ΔT′s/T′s 与 ΔTs/Ts 几乎相等（只差站看两星的几何）', sym.ownToOther.independent.dTsOverTsPct, sym.otherToOwn.independent.dTsOverTsPct, 0.01);
  approx('两网同构：ΔT′e/T′e 与 ΔTe/Te 几乎相等', sym.ownToOther.independent.dTeOverTePct, sym.otherToOwn.independent.dTeOverTePct, 0.1);

  // §2.2.1.1 式(3) 与 §2.4 两组取大；只给 γ 时 T = Te + γ·Ts
  const two = AP8.ap8Coordination({ geometry: 'wgs84', own: NET, other: { ...NET, lonDeg: 113, satEirpDensityDbWPerHz: -45, links: [{ gammaDb: -10 }, { gammaDb: -20, noiseTempK: 120 }] } });
  const o = two.ownToOther;
  const L1 = o.links[0], L2 = o.links[1];
  approx('第 1 组只给 γ：T = Te + γ·Ts', L1.noiseTempK, 150 + 0.1 * o.up.tsK, 1e-9);
  ok('…并标 tDerived', L1.tDerived === true && L2.tDerived === false);
  approx('式(3)：ΔT = γΔTs + ΔTe', L1.deltaTK, 0.1 * o.up.deltaTsK + o.dn.deltaTeK, 1e-9);
  approx('§2.4：取两组中大的', o.combinedPct, Math.max(L1.pct, L2.pct), 1e-12);
  ok('给了 γ → 走合成分支', o.method === 'combined' && o.headlinePct === o.combinedPct);
  // 差距分析 D-01 示例（邻网 1.2 m、Te 150 K、Ts 600 K、γ −10 dB，本星下行 50 dBW/36 MHz）：D 路 59.5%
  const dp = AP8.ap8Coordination({ geometry: 'wgs84', own: NET, other: { ...NET, lonDeg: 113, rxStation: { ...BJ, diameterM: 1.2, efficiency: 0.65, noiseTempK: 150 }, satRxNoiseTempK: 600, links: [{ gammaDb: -10 }] } });
  ok('D 路示例 ΔT′/T′ ≈ 59.5%（D 路上行分量用的是旧版包络，差在 0.5 个百分点以内）', Math.abs(dp.ownToOther.combinedPct - 59.5) < 0.5, dp.ownToOther.combinedPct.toFixed(2) + '%');

  // 再生：上下行分开比
  const rg = AP8.ap8Coordination({ geometry: 'wgs84', own: NET, other: { ...NET, lonDeg: 113, links: [{ gammaDb: -10 }], regenerative: true } });
  ok('受扰方星上再生 → 不出合成值、走独立分支', rg.ownToOther.method === 'independent' && rg.ownToOther.links.length === 0);

  // 保持容差让 ΔT/T 变大
  const tol = AP8.ap8Coordination({ geometry: 'wgs84', own: { ...NET, ewTolDeg: 0.1 }, other: { ...NET, lonDeg: 113, ewTolDeg: 0.1 } });
  ok('计入 ±0.1° 保持容差 → θg 2.3°、上行分量变大', Math.abs(tol.thetaGDeg - 2.3) < 1e-12 && tol.ownToOther.independent.dTsOverTsPct > sym.ownToOther.independent.dTsOverTsPct);

  // 无重叠 → 该向取 0（§2.2）；有重叠却缺输入 → null 并列出
  const noOv = AP8.ap8Coordination({ geometry: 'wgs84', own: NET, other: { ...NET, lonDeg: 113, upCenterGHz: 14.4, dnCenterGHz: 12.7 } });
  ok('上下行都不重叠 → ΔT/T 取 0', noOv.ownToOther.headlinePct === 0 && noOv.ownToOther.up === null && noOv.ownToOther.dn === null);
  const miss = AP8.ap8Coordination({ geometry: 'wgs84', own: { ...NET, satEirpDbW: undefined }, other: { ...NET, lonDeg: 113 } });
  ok('缺本星 EIRP 密度 → ΔT′e 为 null（不拿 0 冒充），并列出缺项', miss.ownToOther.dn.deltaTeK === null && miss.ownToOther.missing.includes('本网 · 卫星 EIRP 密度'), miss.ownToOther.missing.join('、'));

  // §2.2.3 极化隔离：Yu、Yd 进合成
  const pol = AP8.ap8Coordination({ geometry: 'wgs84', applyPolarization: true, own: { ...NET, upPol: 'L', dnPol: 'L' }, other: { ...NET, lonDeg: 113, upPol: 'R', dnPol: 'H', links: [{ gammaDb: -10, noiseTempK: 300 }] } });
  const pp = pol.ownToOther;
  ok('Yu = 4（L/R）、Yd = 1.4（圆/线）', pp.yu === 4 && pp.yd === 1.4);
  approx('ΔT = γΔTs/Yu + ΔTe/Yd', pp.links[0].deltaTK, 0.1 * pp.up.deltaTsK / 4 + pp.dn.deltaTeK / 1.4, 1e-9);

  // Case II：本网下行与邻网上行同频（反向频段）——用地心角与星间损耗
  const c2 = AP8.ap8Coordination({
    geometry: 'rule',
    own: { ...NET, satEirpDensityToSatDbWPerHz: -50, satRxGainToSatDbi: -5 },
    other: { ...NET, lonDeg: 113, upCenterGHz: 12.5, dnCenterGHz: 14.25, satEirpDensityToSatDbWPerHz: -50, satRxGainToSatDbi: -5, links: [{ gammaDb: -10, noiseTempK: 300 }] }
  });
  const cc = c2.ownToOther.caseII;
  ok('Case II：本网下行 ∩ 邻网上行 有重叠即计算', !!cc && cc.overlapMHz > 0);
  approx('式(8)：ΔTs = p′s·g′3(ηs) + g2(δs′) − ls + 228.6（dBK）', 10 * lg(cc.deltaTsK), -50 + -5 - cc.lsDb + 228.6, 1e-9);
  approx('ls 用附件 2 b) 星间距离', cc.interSatKm, 84332 * Math.sin(2.5 / 2 * Math.PI / 180), 1e-9);
  approx('式(9)：ΔT = γ·ΔTs', cc.links[0].deltaTK, 0.1 * cc.deltaTsK, 1e-12);
  ok('Case I 同向重叠因频段对调而为 0（本网上行 14.25 ∩ 邻网上行 12.5 无重叠）', c2.ownToOther.up === null);
  ok('地对地反向重叠只报 MHz、不算 ΔT（§2.2.2 明文不在本方法内）', c2.ownToOther.esToEsOverlapMHz > 0);

  // 协调弧
  ok('出厂两网（Ku，区域 3）：上 / 下行都在 ±6° 弧内', r0.arc.within === true && r0.arc.bands.every((b) => b.arcDeg === 6 && b.within));
  const far = AP8.ap8Coordination({ own: NET, other: { ...NET, lonDeg: 120 } });
  ok('轨位差 9.5° > 6° → 弧外（按 No.9.41 看 ΔT/T）', far.arc.within === false && far.arc.maxArcDeg === 6 && Math.abs(far.lonDiffDeg - 9.5) < 1e-12);
  ok('结果写明方向图 ID 与版本、几何口径、门限', two.patternId === 'RR-AP8-A3' && /Rev\.WRC-15/.test(two.pattern.edition) && two.geometry === 'wgs84' && two.thresholdPct === 6);
  ok('规则口径为缺省', AP8.ap8Coordination({ own: NET, other: { ...NET, lonDeg: 113 } }).geometry === 'rule');
  ok('出参可过 IPC（纯数据）', (() => { try { structuredClone(two); return true; } catch (e) { return false; } })());
}

// ═══ ⑧ C/XPI 雨致 XPD：两种来源分开标（D-12）═══
console.log('\n=== ⑧ C/XPI 雨致 XPD 来源 ===');
{
  const R = require('../utils/rainAttenuation.js');
  const spec = { mode: 'p618', lat: 39.9042, lon: 116.4074, alt: 0, satLonDeg: 110.5, freqGHz: 12.5, pol: 'H', pPct: 0.01 };
  const r = XP.combineXpiWithRain({ satellite: { db: 31.9, source: 'grd' }, earthStation: 30, rain: spec });
  const ref = R.calculateRainAttenuation({ lat: 39.9042, lon: 116.4074, altitude: 0, satLon: 110.5, freq: 12.5, pol: 'H', availability: 99.99, direction: 'down' });
  const rain = r.result.terms.find((t) => t.key === 'rain');
  approx('计算值 = 雨衰页同一条链（rainAttenuation → P.618-14 §4.1）', rain.db, ref.rainXPD, 1e-12);
  ok('计算来源标 p618、段名不再写死出处', rain.source === 'p618' && rain.label === '降雨去极化' && /p 0\.01%/.test(rain.note), rain.note);
  ok('回显取值明细（仰角 / τ / R0.01 / Ap）', r.rain && r.rain.elevationDeg > 40 && Number.isFinite(r.rain.tauDeg) && r.rain.rainRateMmH > 0 && r.rain.rainAttenDb > 0);
  ok('XPI 随时间百分比：12 档，p 越大雨致 XPD 越好', r.curve.length === XP.RAIN_XPD_PCTS.length && r.curve.every((c, i) => i === 0 || c.rainXpdDb > r.curve[i - 1].rainXpdDb));
  ok('曲线上 p = 0.01% 那一点就是本次结果', Math.abs(r.curve.find((c) => c.pct === 0.01).xpiDb - r.result.xpiDb) < 1e-12);
  const m = XP.combineXpiWithRain({ satellite: 31.9, rain: { mode: 'manual', db: 22 } });
  ok('手填 → 标 manual（v1.5.3 及之前一律标 p618，来源失实）', m.result.terms.find((t) => t.key === 'rain').source === 'manual' && m.curve === null);
  ok('旧调用方传数字 → 也按手填标', XP.xpiFromSources(null, 26, 30, 22).terms.find((t) => t.key === 'rain').source === 'manual');
  ok('p 超出 0–5% → 报错不出数', !!XP.combineXpiWithRain({ rain: { ...spec, pPct: 0 } }).error);
  // 主进程服务（ci:xpi）回 rain / curve
  const S = require('../../../electron/services/interference.js')(null, null, null);
  const sv = S.xpi({ satellite: { db: 31.9, source: 'grd' }, earthStation: 30, rain: spec });
  ok('ci:xpi 服务：result 形状不变，另回 rain 与 curve', sv.ok && Math.abs(sv.result.xpiDb - r.result.xpiDb) < 1e-12 && sv.rain.source === 'p618' && sv.curve.length === 12);
  const sa = S.asi({ downlink: false, ap8: { own: NET, other: { ...NET, lonDeg: 113 } } });
  ok('ci:asi 服务：带 ap8 就回 ap8（不另开 IPC 通道）', sa.ok && !!sa.ap8 && !sa.downlink && sa.ap8.ownToOther.headlinePct > 0);
}

// ═══ ⑧b 协调触发页引擎：interference/ap8Formula.ap8CaseI（附录 8 式(1)–(3) 原式，同频段、同传输方向）═══
console.log('\n=== ⑧b 协调触发原式 ===');
{
  const F = require('../utils/interference/ap8Formula.js');
  // 附件 4 算例的十个量（dB 值，T 用 K）
  const X = { PeDb: -37, G1Dbi: 14.5, G2Dbi: 15.5, LuDb: 200, PsDb: -57, G3Dbi: 15.5, G4Dbi: 14.5, LdDb: 196, gammaDb: -15, TK: 105 };
  const r = F.ap8CaseI(X);
  // 原文：ΔTs[dBK] = P′e + G′1 + G2 − Lu + 228.6，ΔTe 同理；ΔT = γ·ΔTs + ΔTe
  const dTs = Math.pow(10, (-37 + 14.5 + 15.5 - 200 + 228.6) / 10);
  const dTe = Math.pow(10, (-57 + 15.5 + 14.5 - 196 + 228.6) / 10);
  const dT = Math.pow(10, -15 / 10) * dTs + dTe;
  approx('式(1) ΔTs（原文 dB 式现算）', r.deltaTsK, dTs, 1e-9);
  approx('式(2) ΔTe', r.deltaTeK, dTe, 1e-9);
  approx('式(3) ΔT = γ·ΔTs + ΔTe', r.deltaTK, dT, 1e-9);
  approx('ΔT/T', r.pct, dT / 105 * 100, 1e-9);
  approx('附件 4 原文：ΔTs ≈ 145 K', r.deltaTsK, 145, 0.5);
  approx('附件 4 原文：ΔTe ≈ 3.6 K', r.deltaTeK, 3.6, 0.05);
  approx('附件 4 原文：ΔT/T ≈ 7.8%', r.pct, 7.8, 0.05);
  approx('dB 读数：ΔTs = 21.60 dBK', r.deltaTsDbK, -37 + 14.5 + 15.5 - 200 + 228.6, 1e-9);
  ok('超 6% 只给 exceeds 供着色；k 与门限取 itu/ap8.js 同一份', r.ok && r.exceeds === true && r.kDb === AP8.K_DB && r.thresholdPct === AP8.THRESHOLD_PCT);
  ok('T = 200 K → 4.1%，exceeds = false', F.ap8CaseI({ ...X, TK: 200 }).exceeds === false);
  ok('输入框送来的字符串数字照收', F.ap8CaseI(Object.fromEntries(Object.entries(X).map(([k, v]) => [k, String(v)]))).pct === r.pct);
  const m = F.ap8CaseI({ ...X, LuDb: '', TK: 0 });
  ok('缺项 / T ≤ 0 → ok:false，按原式符号列出', m.ok === false && m.missing.join() === 'Lu,T' && m.pct === undefined);
  ok('经 interference/index.js 导出', require('../utils/interference/index.js').ap8CaseI === F.ap8CaseI);
  const S = require('../../../electron/services/interference.js')(null, null, null);
  const sa = S.asi({ downlink: false, ap8Formula: X });
  ok('ci:asi 服务：带 ap8Formula 就回 ap8Formula（不另开 IPC 通道）', sa.ok && !!sa.ap8Formula && sa.ap8Formula.pct === r.pct && !sa.downlink && !sa.ap8);
}

// ═══ ⑨ 窗口层：协调触发页与 C/XPI 雨致 XPD（真服务 + 真引擎，structuredClone 模拟 IPC）═══
console.log('\n=== ⑨ 窗口层 ===');
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const S = require('../../../electron/services/interference.js')(null, null, null);
  const F = require('../utils/interference/ap8Formula.js');
  let sent = null;
  globalThis.window = {
    addEventListener: () => {},
    api: {
      interference: {
        asi: async (p) => { sent = structuredClone(p); return S.asi(sent); },
        xpi: async (p) => S.xpi(structuredClone(p)),
        xpiTerm: async () => ({ ok: true, term: { db: 30 } })
      }
    }
  };
  const { useInterference, MODES, ES_PATTERN_IDS } = await import('../../../src/ci/useInterference.js?ap8-window');
  const I = useInterference();
  const keys = MODES.map((m) => m.key);
  ok('页签：协调触发（本网 → 邻网）排在 NGSO 之后、最后一页', keys.join() === 'asi,cci,xpi,ngso,ap8', keys.join());
  ok('C/ASI 方向图可选四条、出厂 S.465-6', ES_PATTERN_IDS.length === 4 && I.asi.esPattern === 'S.465-6');
  const X = { PeDb: -37, G1Dbi: 14.5, G2Dbi: 15.5, LuDb: 200, PsDb: -57, G3Dbi: 15.5, G4Dbi: 14.5, LdDb: 196, gammaDb: -15, TK: 105 };
  ok('出厂 = 附件 4 算例的十个原式量', Object.entries(X).every(([k, v]) => I.ap8[k] === v));
  await I.computeAp8();
  const r = I.ap8.result;
  ok('payload 只有原式十个量，走 ci:asi { downlink:false, ap8Formula }', !!sent && sent.downlink === false && !sent.ap8 && !sent.uplink
    && Object.keys(sent.ap8Formula).sort().join() === [...F.AP8_CASE_I_KEYS].sort().join());
  approx('出厂 ΔT/T = 附件 4 的 7.8%', r.pct, 7.8, 0.05);
  {
    const before = JSON.stringify(sent.ap8Formula);
    const keep = { pw: I.site.txPowerW, lon: I.site.lon, eirp: I.carrier.eirpDbW };
    I.site.txPowerW = 999; I.site.lon = 0; I.carrier.eirpDbW = 1;
    await I.computeAp8();
    ok('不取「本站与本链路」：改本站 / 载波，payload 与结果不变', JSON.stringify(sent.ap8Formula) === before && I.ap8.result.pct === r.pct);
    I.site.txPowerW = keep.pw; I.site.lon = keep.lon; I.carrier.eirpDbW = keep.eirp;
  }
  ok('算完不亮「输入已变」', !I.stale.value.ap8);
  I.ap8.TK = 200;
  ok('改 T → 亮', I.stale.value.ap8);
  I.ap8.TK = 105;
  ok('改回 → 灭', !I.stale.value.ap8);
  I.ap8.G1Dbi = '';
  await I.computeAp8();
  ok('留空一格 → 不出数，读数行列出缺的原式符号', I.ap8.result.ok === false && I.msg.value === '缺少输入：G′1(θt)');
  I.ap8.G1Dbi = 14.5;
  // 本页开着时改一格即重算
  I.mode.value = 'ap8';
  I.ap8.gammaDb = -10;
  await new Promise((res) => setTimeout(res, 300));
  const dTs = Math.pow(10, (-37 + 14.5 + 15.5 - 200 + 228.6) / 10), dTe = Math.pow(10, (-57 + 15.5 + 14.5 - 196 + 228.6) / 10);
  approx('改 γ 即重算：(0.1·ΔTs + ΔTe) / T', I.ap8.result && I.ap8.result.pct, (0.1 * dTs + dTe) / 105 * 100, 1e-9);
  I.ap8.gammaDb = -15;
  await new Promise((res) => setTimeout(res, 300));
  I.mode.value = 'asi';
  // 配置读写：十个原式量进快照；旧版协调触发段（站 / 星 / 载波推算口径）的键不认
  I.ap8.TK = 150;
  const snap = I.snapshot();
  ok('快照带十个原式量（不带结果）', snap.ap8 && snap.ap8.TK === 150 && Object.keys(snap.ap8).sort().join() === [...F.AP8_CASE_I_KEYS].sort().join());
  I.applySnapshot(I.blankSnapshot()); I.applySnapshot(snap);
  ok('读回', I.ap8.TK === 150 && I.ap8.PeDb === -37);
  const old = I.snapshot(); old.ap8 = { ownTeK: 200, ownTolDeg: 0.05, geometry: 'wgs84', ownG1: 3 };
  I.applySnapshot(I.blankSnapshot()); I.applySnapshot(old);
  ok('旧版协调触发段的键不认 → 原式量回出厂', I.ap8.TK === 105 && !('ownTeK' in I.ap8) && !('geometry' in I.ap8));
  const old2 = I.snapshot(); delete old2.ap8;
  I.ap8.TK = 300;
  I.applySnapshot(I.blankSnapshot()); I.applySnapshot(old2);
  ok('老配置没有 ap8 段 → 回出厂', I.ap8.TK === 105);
  I.clearResults();
  ok('切配置清掉协调触发结果', I.ap8.result === null && !I.stale.value.ap8);

  // C/XPI：出厂按 P.618-14 §4.1 计算；老配置雨致 XPD 恰为旧出厂 22 dB → 改为计算，其余数保留手填
  ok('C/XPI 雨致 XPD 出厂 = P.618 计算、p = 0.01%', I.xpi.rainSource === 'p618' && I.xpi.rainPct === 0.01);
  await I.computeXpi();
  const rain = I.xpi.result && I.xpi.result.terms.find((t) => t.key === 'rain');
  ok('算完：雨致 XPD 来源 = p618，带曲线与取值明细', !!rain && rain.source === 'p618' && I.xpi.curve.length === 12 && I.xpi.rainInfo.source === 'p618');
  const o2 = I.snapshot(); delete o2.xpi.rainSource; o2.xpi.rainXpdDb = 22;
  I.applySnapshot(I.blankSnapshot()); I.applySnapshot(o2);
  ok('老配置 22 dB（旧出厂值）→ 改走计算', I.xpi.rainSource === 'p618');
  const o3 = I.snapshot(); delete o3.xpi.rainSource; o3.xpi.rainXpdDb = 18.5;
  I.applySnapshot(I.blankSnapshot()); I.applySnapshot(o3);
  ok('老配置用户填过别的数 → 保留手填', I.xpi.rainSource === 'manual' && I.xpi.rainXpdDb === 18.5);
  await I.computeXpi();
  ok('手填 → 结果标 manual，不出曲线', I.xpi.result.terms.find((t) => t.key === 'rain').source === 'manual' && I.xpi.curve === null);
  delete globalThis.window;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
