// 多站总可用度 精度/回归测试（无框架，纯断言）。运行： node packages/core/test/rainDiversity.test.js
//
// 覆盖两件事：
//   ① 可用度反解 solveAvailabilityForAtten —— A(p) 的数值反函数
//   ② 多站聚合 rainDiversity —— 纯概率论（Poisson–binomial 尾概率 + 切换可加项）
//      与编排层 solveMultiSite（两种输入方式：直接给可用度 / 由可承受衰减反解）
const fs = require('fs');
const path = require('path');
const core = require('../index.js');
const D = require('../utils/rainDiversity.js');
const RA = require('../utils/rainAttenuation.js');

// 注入全精度 ITU 数据（与 electron/main.js 一致），否则降雨率/云/气体走内嵌回退，与真机不符
const ituDir = path.join(__dirname, '..', '..', '..', 'resources', 'itu');
const rd = (f) => { try { return fs.readFileSync(path.join(ituDir, f)); } catch (e) { return null; } };
core.loadFullPrecisionData({
  rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'),
  vapor: rd('p836_rho_v1.bin'), cloud: rd('p840_logn_v1.bin')
});

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}
function approx(name, got, want, tol) {
  const g = parseFloat(got);
  const c = Number.isFinite(g) && Math.abs(g - want) <= tol;
  ok(name, c, `(got=${g}, want≈${want} ±${tol})`);
}
function rel(name, got, want, tolRel) {
  const r = Math.abs(got - want) / Math.max(Math.abs(want), 1e-300);
  ok(name, r <= tolRel, `(got=${got.toExponential(6)}, want=${want.toExponential(6)}, rel=${r.toExponential(2)} ≤ ${tolRel})`);
}

console.log('=== 多站总可用度 测试 ===\n');

// ---------------------------------------------------------------- Poisson–binomial
console.log('-- Poisson–binomial（各站不可用度可不同）--');
const PS = [0.001, 0.02, 0.3, 0.05, 0.4, 0.11, 0.008];
const pmf = D.poissonBinomialPmf(PS);
const M0 = PS.length;
const brute = new Array(M0 + 1).fill(0);
for (let m = 0; m < (1 << M0); m++) {
  let pr = 1, c = 0;
  for (let i = 0; i < M0; i++) { if (m & (1 << i)) { pr *= PS[i]; c++; } else pr *= 1 - PS[i]; }
  brute[c] += pr;
}
ok('DP 卷积 = 2^M 暴力枚举（逐项 1e-12）', pmf.every((v, j) => Math.abs(v - brute[j]) < 1e-12));
approx('分布归一 Σ P(S=j) = 1', pmf.reduce((a, b) => a + b, 0), 1, 1e-14);
// 全相等时必须退化为二项分布
const pEq = 0.07, Meq = 8;
const pmfEq = D.poissonBinomialPmf(new Array(Meq).fill(pEq));
const binom = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c; };
ok('p_i 全相等时退化为二项分布', pmfEq.every((v, j) =>
  Math.abs(v - binom(Meq, j) * Math.pow(pEq, j) * Math.pow(1 - pEq, Meq - j)) < 1e-12));
// 尾概率与 L 的定义
const agg = D.aggregate([1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => 0.1), 7);   // 9 站 7 主（各 0.1%）
ok('L = M − N_min + 1', agg.L === 3 && agg.M === 9);
approx('P(S≥0) = 1', D.tailAtLeast(pmf, 0), 1, 1e-15);
approx('P(S≥M+1) = 0', D.tailAtLeast(pmf, M0 + 1), 0, 1e-15);
ok('★ 绝不是连乘：9 站各 0.1% 取 L=3 的系统不可用度远大于 1e-27',
  agg.unavail > 1e-8, `(得 ${agg.unavail.toExponential(3)}，连乘会给 ${Math.pow(1e-3, 9).toExponential(1)})`);
// 两个手算可核对的端点
rel('nMin=1（L=M）就是连乘：P(全断) = p²', D.aggregate([10, 10], 1).unavail, 0.01, 1e-12);
rel('nMin=M（L=1）就是并集：P(任一断) = 1−(1−p)²', D.aggregate([10, 10], 2).unavail, 0.19, 1e-12);
rel('异构三站 L=2 手算核对', D.aggregate([1, 0.5, 0.1], 2).unavail,
  0.01 * 0.005 + 0.01 * 0.001 + 0.005 * 0.001 - 2 * 0.01 * 0.005 * 0.001, 1e-12);

// ---------------------------------------------------------------- 切换预算
console.log('\n-- 切换预算（时间轴以事件计数进入）--');
approx('U=0.01%, T_sw=1 s → 3155.76 次/年', D.switchBudget({ uBudgetPct: 0.01, tSwMin: 1 / 60 }).maxSwitchesPerYear, 3155.76, 0.01);
approx('U=0.01%, T_sw=30 s → 105.192 次/年', D.switchBudget({ uBudgetPct: 0.01, tSwMin: 0.5 }).maxSwitchesPerYear, 105.192, 1e-3);
approx('U=0.01%, T_sw=30 min → 1.7532 次/年', D.switchBudget({ uBudgetPct: 0.01, tSwMin: 30 }).maxSwitchesPerYear, 1.7532, 1e-4);
approx('U=0.1%,  T_sw=30 min → 17.532 次/年', D.switchBudget({ uBudgetPct: 0.1, tSwMin: 30 }).maxSwitchesPerYear, 17.532, 1e-3);
approx('反向：813 次/年 × 30 min → 4.637% 不可用',
  D.switchBudget({ tSwMin: 30, nSwPerYear: 813 }).switchUnavailPct, 4.6372, 1e-3);
ok('缺预算时不给 maxSwitches（不编数）', D.switchBudget({ tSwMin: 30 }).maxSwitchesPerYear === undefined);
ok('缺切换次数时不给 U_sw（不编数）', D.switchBudget({ uBudgetPct: 0.01, tSwMin: 30 }).switchUnavailPct === undefined);
ok('回显 nSwPerYear（结果页「切换次数」行取它）', D.switchBudget({ tSwMin: 30, nSwPerYear: 813 }).nSwPerYear === 813);

// ---------------------------------------------------------------- 可用度反解
console.log('\n-- 可用度反解 solveAvailabilityForAtten --');
const SITE = {
  lat: 39.9042, lon: 116.4074, freq: 12.5, pol: 'C', satLon: 110.5,
  rainRate: 63, systemNoiseTemp: 120, feederLoss: 0.2, direction: 'down',
  diameter: 3.7, efficiency: 60
};
// ① round-trip 主不变式（守门测试）
{
  let worst = 0, n = 0;
  for (const tgt of ['rainAtten', 'totalAtten', 'dnd']) {
    for (const A of [0.4, 0.8, 1.5, 3, 6, 10, 15, 22]) {
      const s = RA.solveAvailabilityForAtten(SITE, A, { target: tgt });
      if (s.state !== 'ok') continue;
      const r = core.calculateRainAttenuation(Object.assign({}, SITE, { availability: s.availability }));
      const back = { rainAtten: r.rainAtten, totalAtten: r.totalAtten, dnd: r.dnd }[tgt];
      worst = Math.max(worst, Math.abs(back - A)); n++;
    }
  }
  ok(`★ round-trip：${n} 组（三种目标量）回代误差 ≤ 1e-6 dB`, worst <= 1e-6, `(最差 ${worst.toExponential(2)} dB)`);
}
// ② 与正算自洽：把某可用度下算出的雨衰当门限反解，必须解回原可用度
//    ★ 容差按 dB 定不按 p 定（求解器的收敛判据就是 |ΔA| ≤ 1e-6 dB；p 域的残差还要再除以
//    dA/dp，在 p→0.001% 一端 A 很陡，同样的 dB 误差换算成 p 会看着更小、另一端更大，
//    按 p 立断言等于在拿一个随工作点漂移的尺子量）。这里 p 域只做一个宽松的合理性上界。
{
  let worstP = 0, worstDb = 0;
  for (const av of [96, 99, 99.5, 99.9, 99.99, 99.999]) {
    const r = core.calculateRainAttenuation(Object.assign({}, SITE, { availability: av }));
    const s = RA.solveAvailabilityForAtten(SITE, r.rainAtten);
    if (s.state !== 'ok') continue;
    worstP = Math.max(worstP, Math.abs(s.availability - av));
    const back = core.calculateRainAttenuation(Object.assign({}, SITE, { availability: s.availability }));
    worstDb = Math.max(worstDb, Math.abs(back.rainAtten - r.rainAtten));
  }
  ok('★ 反解与既有正算钉死（同一条 A(p) 曲线，dB 域）', worstDb <= 1e-6, `(最差 ${worstDb.toExponential(2)} dB)`);
  ok('反解回到的可用度与原值一致（p 域宽松上界）', worstP < 1e-5, `(最差 ${worstP.toExponential(2)} %)`);
}
// ③ 定义域硬钳（blocking：引擎在 p>5% 处 return 0，不是缓慢衰减）
{
  const a5 = core.calculateRainAttenuation(Object.assign({}, SITE, { availability: 95 })).rainAtten;
  const below = RA.solveAvailabilityForAtten(SITE, a5 * 0.5);
  ok('★ 目标低于 A(5%) → state=below 并钳到 95%（不在 p>5 段找假根）',
    below.state === 'below' && Math.abs(below.availability - 95) < 1e-12,
    `(A(5%)=${a5.toFixed(4)} dB)`);
  const a0 = core.calculateRainAttenuation(Object.assign({}, SITE, { availability: 99.999 })).rainAtten;
  const above = RA.solveAvailabilityForAtten(SITE, a0 * 2);
  ok('目标高于 A(0.001%) → state=above 并钳到 99.999%',
    above.state === 'above' && Math.abs(above.availability - 99.999) < 1e-12);
  ok('钳位时如实标 warn', below.warn.includes('clampedLow') && above.warn.includes('clampedHigh'));
}
// ④ A(p) 在定义域内单调（GEO 路径），且反解不越出 [0.001, 5]
{
  let mono = true, prev = Infinity;
  for (let i = 0; i <= 200; i++) {
    const pct = 0.001 * Math.pow(5000, i / 200);
    const a = core.calculateRainAttenuation(Object.assign({}, SITE, { availability: 100 - pct })).rainAtten;
    if (a > prev + 1e-12) mono = false;
    prev = a;
  }
  ok('GEO 路径 A(p) 在 [0.001%, 5%] 上单调递减', mono);
  ok('PCT 定义域常数与 P.618-14 式(8) 一致', RA.PCT_MIN === 0.001 && RA.PCT_MAX === 5);
}
// ⑤ 无雨算例：A(p) 是平的，不能给一个假的可用度
{
  const dry = RA.solveAvailabilityForAtten(Object.assign({}, SITE, { rainRate: 0, rainRateExact: true }), 3);
  ok('无雨算例 → state=flat（不编一个可用度出来）', dry.state === 'flat');
}
// ⑥ NGSO §8 路径：等效仰角随 p 变，可能多根，必须回报根数
{
  const ng = {
    lat: 23.1, lon: 113.3, freq: 20, pol: 'C', ngsoStat: true,
    orbitAltKm: 1200, inclDeg: 53, minElevDeg: 25,
    rainRate: 0, systemNoiseTemp: 150, feederLoss: 0.2, direction: 'down', diameter: 1.2, efficiency: 60
  };
  let worst = 0, cnt = 0;
  for (const A of [2, 5, 10]) {
    const s = RA.solveAvailabilityForAtten(ng, A);
    if (s.state !== 'ok') continue;
    const r = core.calculateRainAttenuation(Object.assign({}, ng, { availability: s.availability }));
    worst = Math.max(worst, Math.abs(r.rainAtten - A)); cnt++;
    ok(`NGSO §8 反解 A=${A} dB 回报根数`, Number.isFinite(s.rootCount) && s.rootCount >= 1);
  }
  ok(`NGSO §8 round-trip（${cnt} 组）≤ 1e-6 dB`, worst <= 1e-6, `(最差 ${worst.toExponential(2)} dB)`);
}
// ⑦ 性能
{
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) RA.solveAvailabilityForAtten(SITE, 3 + i * 0.1);
  const dt = Date.now() - t0;
  ok('GEO 反解 50 次 < 500 ms', dt < 500, `(${dt} ms)`);
}

// ---------------------------------------------------------------- solveMultiSite 编排
console.log('\n-- solveMultiSite（编排：站表 → 系统聚合）--');
// ① 直接给可用度：聚合值必须逐位等于本地 Poisson–binomial
{
  const cases = [
    Object.assign({}, SITE, { stationName: '甲', availability: 99 }),
    Object.assign({}, SITE, { stationName: '乙', availability: 99.5 }),
    Object.assign({}, SITE, { stationName: '丙', availability: 99.9 })
  ];
  const r = RA.solveMultiSite(cases, { inputMode: 'avail', nMin: 2, tSwMin: 30, nSwPerYear: 10 });
  ok('三站全部参与，nMin=2 → L=2', r.activeCount === 3 && r.nMin === 2 && r.system.L === 2);
  ok('直接给可用度 → solve.state=given', r.sites.every((s) => s.solve && s.solve.state === 'given'));
  const want = D.tailAtLeast(D.poissonBinomialPmf([0.01, 0.005, 0.001]), 2);
  rel('★ 系统不可用度 = P(S≥2)（逐位）', r.system.unavail, want, 1e-12);
  ok('逐站给出该可用度上的三档衰减', r.sites.every((s) => s.atten && s.atten.rain > 0 && s.atten.total > s.atten.rain));
  rel('切换 U_sw = 10 × 30 / 525960', r.switch.unavail, 10 * 30 / 525960, 1e-12);
  rel('合计 = 站点中断 + 切换', r.switch.total, r.system.unavail + r.switch.unavail, 1e-15);
  // nMin 留空 → 默认全部站都要求可用（L=1，并集）
  const rDef = RA.solveMultiSite(cases, { inputMode: 'avail' });
  ok('nMin 留空默认 = 全部参与站数（L=1）', rDef.nMin === 3 && rDef.system.L === 1);
  rel('默认口径 = 并集 P(S≥1)', rDef.system.unavail, D.tailAtLeast(D.poissonBinomialPmf([0.01, 0.005, 0.001]), 1), 1e-12);
}
// ② nMin 边界：nMin=1（L=M，全断才断）与 nMin=M（L=1，一断即断）
{
  const cases = [
    Object.assign({}, SITE, { stationName: '甲', availability: 99 }),
    Object.assign({}, SITE, { stationName: '乙', availability: 99 })
  ];
  rel('nMin=1 → P(全断) = 1e-4', RA.solveMultiSite(cases, { inputMode: 'avail', nMin: 1 }).system.unavail, 1e-4, 1e-9);
  rel('nMin=2 → P(任一断) = 0.0199', RA.solveMultiSite(cases, { inputMode: 'avail', nMin: 2 }).system.unavail, 0.0199, 1e-9);
}
// ③ 缺输入：可用度留空的站标 noAvail、不进聚合
{
  const cases = [
    Object.assign({}, SITE, { stationName: '甲', availability: 99 }),
    Object.assign({}, SITE, { stationName: '丙' })   // 无 availability
  ];
  const r = RA.solveMultiSite(cases, { inputMode: 'avail' });
  ok('缺输入的站不进聚合', r.activeCount === 1 && r.system.M === 1);
  ok('缺可用度如实标 warn', r.sites[1].warn.includes('noAvail'));
}
// ④ 可承受衰减反解：逐站结果与直接调反解器一致，聚合与逐站反解自洽
{
  const cases = [
    Object.assign({}, SITE, { stationName: '甲', attenBudgetDb: 6 }),
    Object.assign({}, SITE, { stationName: '乙', lat: 31.2304, lon: 121.4737, rainRate: 43, attenBudgetDb: 8 })
  ];
  const r = RA.solveMultiSite(cases, { nMin: 1 });
  ok('两站都解出 ok', r.inputMode === 'atten' && r.sites.every((s) => s.solve && s.solve.state === 'ok'));
  const direct0 = RA.solveAvailabilityForAtten(cases[0], 6, { target: 'rainAtten' });
  rel('逐站反解 = 直接调用反解器', r.sites[0].solve.availability, direct0.availability, 1e-12);
  const want = D.aggregate(r.sites.map((s) => s.solve.outagePct), 1);
  rel('聚合值与逐站反解自洽', r.system.unavail, want.unavail, 1e-12);
  ok('反解模式下工作点雨衰 ≈ 门限（对标 rainAtten）',
    Math.abs(r.sites[0].atten.rain - 6) < 1e-4 && Math.abs(r.sites[1].atten.rain - 8) < 1e-4,
    `(${r.sites[0].atten.rain.toFixed(6)} / ${r.sites[1].atten.rain.toFixed(6)} dB)`);
}
// ⑤ 不给切换输入 → 不出切换项（不编数）
{
  const cases = [Object.assign({}, SITE, { stationName: '甲', availability: 99 })];
  const r = RA.solveMultiSite(cases, { inputMode: 'avail' });
  ok('无切换输入时 result.switch 不存在', r.switch === undefined);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
