// ITU-R P.2109-2 建筑物进入损耗测试（无框架，纯断言）。
//   运行： node packages/core/test/p2109.test.mjs
//
// 两层：
//   ① 官方工作簿逐点对拍 —— ITU-R SG3「Clutter and BEL workbook_V2.xlsx」的 BEL 页（P.2109-2）。
//      Excel 缓存值由 python3 + openpyxl 抽成 fixtures/itu_clutter_bel_workbook_v2.json（含下载地址、
//      xlsx 的 SHA-256、单元格范围，抽取前逐格核对过公式形状），xlsx 本身不进仓库。
//        'BEL' C5:K6     表 1 系数（两类建筑）
//        'BEL' E11:L11   f = 28 GHz、θ = 0° 的 μ1、μ2、σ1、σ2
//        'BEL' C15:Q156  142 个概率（P = 1e-7 … 0.9977，工作簿按 lg(P%) 以 0.1 / 0.01 / 0.001 步长取）上的
//                        A(P)、B(P)、L_BEL(P)
//      容差 1e-9 dB——两边的逆正态都是机器精度（Excel NORMINV / AS241）。
//   ② 独立核对 —— 期望值按建议书原文在测试里现算或手算，不是把实现输出抄回来当基准。
//      标「手算」的数字由独立的 Python 脚本照式 (1)–(10) 算出（逆正态用 Python statistics.NormalDist）；
//      表 1 系数照 PDF 第 4 页手抄；标「图 1」的是从 PDF 图 1 读出的曲线值（±0.5 dB，只防量级性错误）。
//      另核：中值闭式、L(P) 严格递增、belCdf ∘ L 往返、仰角项 0.212|θ|、P → 0 的下确界 −3 dB、
//      蒙特卡洛抽样（带种子发生器）的经验分布、越界告警与无效入参。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const B = require('../utils/terrestrial/p2109.js');
const WB = require('./fixtures/itu_clutter_bel_workbook_v2.json');

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

const TOL = 1e-9;
const table = (name, cells, rows, unit = ' dB') => {
  let max = 0, worst = '', bad = 0;
  for (const [got, want, label] of rows) {
    const dev = (typeof got === 'number' && Number.isFinite(got)) ? Math.abs(got - want) : Infinity;
    if (!(dev <= TOL)) bad++;
    if (dev > max) { max = dev; worst = `${label}: got ${got}, want ${want}`; }
  }
  ok(`工作簿 ${name}（${cells}）：${rows.length} 点，最大偏差 ${max.toExponential(2)}${unit}`,
    rows.length > 0 && bad === 0, bad ? `${bad} 点超差 ${TOL}，最差 ${worst}` : '');
  return { n: rows.length, max };
};

const TYPES = ['traditional', 'thermallyEfficient'];
const bel = (fGHz, P, buildingType, elevDeg) => B.buildingEntryLoss({ fGHz, P, buildingType, elevDeg });

// Marsaglia xorshift32：带种子、可复现，输出在 (0, 1)
const xorshift32 = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
};

console.log(`=== ① 官方工作簿对拍（${WB.source.name}，SHA-256 ${WB.source.sha256.slice(0, 12)}…） ===`);
const W = WB.bel;
const tallies = [];
{
  const rows = [];
  for (const t of TYPES) for (const k of 'rstuvwxyz') rows.push([B.BEL_COEFFS[t][k], W.coeffs[t][k], `${t}.${k}`]);
  tallies.push(table('表 1 系数', `${W.sheet} C5:K6`, rows, ''));
}
{
  const rows = [];
  for (const t of TYPES) {
    const r = bel(W.fGHz, 0.5, t, W.elevDeg), p = W.params[t];
    rows.push([r.mu1, p.mu1, `${t} μ1`], [r.mu2, p.mu2, `${t} μ2`], [r.sigma1, p.sigma1, `${t} σ1`], [r.sigma2, p.sigma2, `${t} σ2`],
      [r.Le, W.params.Le, `${t} Le`]);
  }
  tallies.push(table('分布参数', `${W.sheet} E11:M11`, rows));
}
{
  const rows = [];
  let warnOk = true, nOutside = 0;
  W.P.forEach((P, i) => {
    const outside = P < 0.01 || P > 0.99;
    if (outside) nOutside++;
    for (const t of TYPES) {
      const r = bel(W.fGHz, P, t, W.elevDeg), ref = W[t];
      rows.push([r.A, ref.A[i], `${t} P=${P} A`], [r.B, ref.B[i], `${t} P=${P} B`], [r.L, ref.L[i], `${t} P=${P} L`]);
      if (r.warnings.length !== (outside ? 1 : 0)) warnOk = false;
    }
  });
  tallies.push(table('L_BEL(P)', `${W.sheet} C15:Q156`, rows));
  ok(`工作簿概率表：${nOutside}/${W.P.length} 行的 P 在 0.01–0.99 之外，恰是这些行带 P 告警`, warnOk);
}

console.log('\n=== ② 独立核对 ===');

// 表 1，照 PDF 第 4 页手抄
{
  const T1 = {
    traditional:        { r: 12.64, s: 3.72,  t: 0.96, u: 9.6,  v: 2.0, w: 9.1,  x: -3.0, y: 4.5, z: -2.0 },
    thermallyEfficient: { r: 28.19, s: -3.00, t: 8.48, u: 13.5, v: 3.8, w: 27.8, x: -2.9, y: 9.4, z: -2.1 },
  };
  ok('表 1 系数与建议书一致（两类 × 9 个）', TYPES.every((t) => Object.keys(T1[t]).every((k) => B.BEL_COEFFS[t][k] === T1[t][k])) &&
    Object.keys(B.BEL_COEFFS).length === 2);
}
// 手算点
{
  const r = bel(28, 0.5, 'traditional', 0);
  approx('手算 f=28 GHz P=0.5 传统：式 (9) Lh = μ1', r.mu1, 20.033923589564214, 1e-12);
  approx('手算 f=28 GHz P=0.5 传统：式 (6) μ2', r.mu2, 4.758525905973342, 1e-12);
  approx('手算 f=28 GHz P=0.5 传统：式 (7) σ1', r.sigma1, 12.494316062684439, 1e-12);
  approx('手算 f=28 GHz P=0.5 传统：式 (8) σ2', r.sigma2, 1.6056839373155616, 1e-12);
  approx('手算 f=28 GHz P=0.5 传统：L', r.L, 20.18186923163233, 1e-9);
  approx('手算 f=28 GHz P=0.5 热效率：L', bel(28, 0.5, 'thermallyEfficient', 0).L, 41.67627124187692, 1e-9);
  const r2 = bel(3.5, 0.9, 'thermallyEfficient', 20);
  approx('手算 f=3.5 GHz P=0.9 热效率 θ=20°：L', r2.L, 53.35564067812274, 1e-9);
  approx('手算 f=3.5 GHz P=0.9 热效率 θ=20°：A(P)', r2.A, 53.258461879769825, 1e-9);
  approx('手算 f=3.5 GHz P=0.9 热效率 θ=20°：B(P)', r2.B, 36.80455975410369, 1e-9);
  approx('手算 f=0.7 GHz P=0.1 传统 θ=−10°：L', bel(0.7, 0.1, 'traditional', -10).L, 6.422574695379531, 1e-9);
  ok('C = −3 dB（式 (4)）', r.C === -3);
}
// 中值：F⁻¹(0.5) = 0 → L = 10lg(10^(0.1μ1) + 10^(0.1μ2) + 10^(−0.3))
{
  let worst = 0;
  for (const t of TYPES) for (const f of [0.1, 0.9, 5, 28, 73]) for (const th of [0, 15, 60]) {
    const m = B.belMedian({ fGHz: f, buildingType: t, elevDeg: th });
    const want = 10 * Math.log10(Math.pow(10, 0.1 * m.mu1) + Math.pow(10, 0.1 * m.mu2) + Math.pow(10, -0.3));
    worst = Math.max(worst, Math.abs(m.L - want), Math.abs(m.A - m.mu1), Math.abs(m.B - m.mu2));
  }
  ok('中值 P = 0.5：L = 10lg(10^(0.1μ1) + 10^(0.1μ2) + 10^(0.1C))，A = μ1、B = μ2（30 组）', worst < 1e-12, `max ${worst.toExponential(2)}`);
  const m = B.belMedian({ fGHz: 28, buildingType: 'traditional' });
  const e = bel(28, 0.5, 'traditional');
  ok('belMedian ≡ buildingEntryLoss(P = 0.5)', m.L === e.L && m.mu1 === e.mu1 && m.warnings.length === 0);
}
// L(P) 严格递增
{
  let mono = true, cases = 0;
  const probs = Array.from({ length: 1999 }, (_, i) => 1 / (1 + Math.exp(-(-20.7 + 41.4 * (i + 1) / 2000))));   // logit 等距，≈1e-9 … 1−1e-9
  for (const t of TYPES) for (const f of [0.08, 0.5, 2, 28, 100]) for (const th of [0, 45]) {
    const q = B.belQuantiles({ fGHz: f, buildingType: t, elevDeg: th, probs });
    cases++;
    for (let i = 1; i < q.length; i++) if (!(q[i].L > q[i - 1].L)) { mono = false; break; }
  }
  ok(`L_BEL(P) 在 P ≈ 1e-9 … 1−1e-9 上严格递增（${cases} 组 f × θ × 建筑类型，各 1999 点）`, mono);
}
// belCdf ∘ L 往返
{
  let worst = 0;
  const Ps = [1e-10, 1e-6, 1e-3, 0.01, 0.1, 0.37, 0.5, 0.9, 0.99, 0.999, 1 - 1e-6];
  for (const t of TYPES) for (const f of [0.2, 3.5, 28, 100]) for (const th of [0, 30]) for (const P of Ps) {
    const L = bel(f, P, t, th).L;
    const c = B.belCdf({ fGHz: f, buildingType: t, elevDeg: th, L });
    worst = Math.max(worst, c.clamped ? Infinity : Math.abs(c.P - P) / Math.min(P, 1 - P));
  }
  ok('belCdf(L_BEL(P)) = P：P 从 1e-10 到 1−1e-6、相对误差 < 1e-9（176 组）', worst < 1e-9, `max ${worst.toExponential(2)}`);
  const m = B.belMedian({ fGHz: 28, buildingType: 'thermallyEfficient' }).L;
  approx('belCdf(中值) = 0.5', B.belCdf({ fGHz: 28, buildingType: 'thermallyEfficient', L: m }).P, 0.5, 1e-12);
}
// 仰角项：式 (10) Le = 0.212|θ|，只进 μ1
{
  const r0 = bel(10, 0.3, 'traditional', 0), r30 = bel(10, 0.3, 'traditional', 30), rm30 = bel(10, 0.3, 'traditional', -30);
  approx('式 (10) θ = 30° 时 Le = 6.36 dB', r30.Le, 6.36, 1e-12);
  approx('μ1(30°) − μ1(0°) = 0.212·30', r30.mu1 - r0.mu1, 0.212 * 30, 1e-12);
  ok('仰角只进 μ1：Lh、μ2、σ1、σ2 不变', r30.Lh === r0.Lh && r30.mu2 === r0.mu2 && r30.sigma1 === r0.sigma1 && r30.sigma2 === r0.sigma2);
  ok('取 |θ|：±30° 结果相同', rm30.L === r30.L && rm30.Le === r30.Le);
  ok('仰角越大损耗越大（0° < 30° < 60°）', r0.L < r30.L && r30.L < bel(10, 0.3, 'traditional', 60).L);
}
// P → 0 时只剩常数项：下确界 C = −3 dB
{
  const L = bel(28, 1e-300, 'traditional').L;
  ok('P → 0 时 L → −3 dB（P = 1e-300 时在 −3 dB 之上 1e-3 dB 内）', L > -3 && L < -3 + 1e-3, `L = ${L}`);
}
// 图 1（水平入射中值，读图）
approx('图 1 读图 传统 0.1 GHz', B.belMedian({ fGHz: 0.1, buildingType: 'traditional' }).L, 14.3, 0.5);
approx('图 1 读图 传统 100 GHz', B.belMedian({ fGHz: 100, buildingType: 'traditional' }).L, 24.0, 0.5);
approx('图 1 读图 热效率 0.1 GHz', B.belMedian({ fGHz: 0.1, buildingType: 'thermallyEfficient' }).L, 40.3, 0.5);
approx('图 1 读图 热效率 2 GHz（谷底）', B.belMedian({ fGHz: 2, buildingType: 'thermallyEfficient' }).L, 30.6, 0.5);
approx('图 1 读图 热效率 100 GHz', B.belMedian({ fGHz: 100, buildingType: 'thermallyEfficient' }).L, 56.0, 0.5);

// —— 分布形式 ——
console.log('\n=== 分布形式与抽样 ===');
{
  const q = B.belQuantiles({ fGHz: 28, buildingType: 'traditional' });
  ok('belQuantiles 缺省网格：0.01 … 0.99 共 99 点、无告警', Array.isArray(q) && q.length === 99 && q[0].P === 0.01 && q[98].P === 0.99 &&
    q[49].P === 0.5 && q.every((x) => x.warnings.length === 0));
  ok('belQuantiles 各点与 buildingEntryLoss 逐点相同', q.every((x) => x.L === bel(28, x.P, 'traditional').L));
  const q2 = B.belQuantiles({ fGHz: 28, buildingType: 'traditional', probs: new Float64Array([0.001, 0.5]) });
  ok('belQuantiles 接受 TypedArray；P = 0.001 那点单独带告警', q2.length === 2 && q2[0].warnings.length === 1 && q2[1].warnings.length === 0,
    q2[0].warnings.join('；'));
  ok('belQuantiles probs 含 1 → error', !!B.belQuantiles({ fGHz: 28, buildingType: 'traditional', probs: [0.5, 1] }).error);
  ok('belQuantiles probs 非数组 → error', !!B.belQuantiles({ fGHz: 28, buildingType: 'traditional', probs: 0.5 }).error);
}
{
  const lo = B.belCdf({ fGHz: 28, buildingType: 'traditional', L: -10 });
  ok('belCdf L = −10 dB（低于下确界 −3 dB）→ P 取下界 1e-12、clamped = low、告警', lo.P === 1e-12 && lo.clamped === 'low' && lo.warnings.length === 1,
    lo.warnings.join('；'));
  const hi = B.belCdf({ fGHz: 28, buildingType: 'traditional', L: 300 });
  ok('belCdf L = 300 dB → P 取上界、clamped = high', hi.P === 1 - 1e-12 && hi.clamped === 'high' && hi.warnings.length === 1);
  const mid = B.belCdf({ fGHz: 28, buildingType: 'traditional', L: 20 });
  ok('belCdf 区间内：clamped = null、P ∈ (0.01, 0.99) 无告警', mid.clamped === null && mid.P > 0.01 && mid.P < 0.99 && mid.warnings.length === 0);
  const tail = B.belCdf({ fGHz: 28, buildingType: 'traditional', L: 0 });
  ok('belCdf 结果 P < 0.01 → 告警', tail.P < 0.01 && tail.warnings.length === 1, tail.warnings.join('；'));
  ok('belCdf L = NaN → error', !!B.belCdf({ fGHz: 28, buildingType: 'traditional', L: NaN }).error);
}
{
  const med = B.belMedian({ fGHz: 28, buildingType: 'traditional' }).L;
  const s1 = B.belSample({ fGHz: 28, buildingType: 'traditional', rng: () => 0.5, n: 3 });
  ok('belSample rng ≡ 0.5 → 三个样本都等于中值', s1.samples.length === 3 && s1.samples.every((x) => x === med) && s1.warnings.length === 0);
  const seq = [0, 0.5];
  const s2 = B.belSample({ fGHz: 28, buildingType: 'traditional', rng: () => seq.shift() });
  ok('belSample rng 返回 0 时重抽', s2.samples.length === 1 && s2.samples[0] === med);
  const s3 = B.belSample({ fGHz: 28, buildingType: 'traditional', rng: () => 0.1, n: 2 });
  ok('belSample 样本 = 该 U 处的 L_BEL（U = 0.1）', s3.samples.every((x) => x === bel(28, 0.1, 'traditional').L));
  const s4 = B.belSample({ fGHz: 28, buildingType: 'traditional', rng: () => 0.005, n: 4 });
  ok('belSample 落在 0.01–0.99 之外的样本计数写进告警', s4.warnings.length === 1 && /^4\/4 /.test(s4.warnings[0]), s4.warnings.join('；'));
  ok('belSample rng 返回 1 → error', !!B.belSample({ fGHz: 28, buildingType: 'traditional', rng: () => 1 }).error);
  ok('belSample rng 返回 NaN → error', !!B.belSample({ fGHz: 28, buildingType: 'traditional', rng: () => NaN }).error);
  ok('belSample rng 不是函数 → error', !!B.belSample({ fGHz: 28, buildingType: 'traditional', rng: 0.3 }).error);
  ok('belSample n = 0 / 2.5 → error', !!B.belSample({ fGHz: 28, buildingType: 'traditional', n: 0 }).error &&
    !!B.belSample({ fGHz: 28, buildingType: 'traditional', n: 2.5 }).error);
  ok('belSample 缺省 rng = Math.random、n = 1', (() => { const s = B.belSample({ fGHz: 28, buildingType: 'traditional' }); return s.samples.length === 1 && Number.isFinite(s.samples[0]); })());

  const a = B.belSample({ fGHz: 28, buildingType: 'thermallyEfficient', rng: xorshift32(42), n: 50 });
  const b = B.belSample({ fGHz: 28, buildingType: 'thermallyEfficient', rng: xorshift32(42), n: 50 });
  ok('belSample 同种子可复现', a.samples.every((x, i) => x === b.samples[i]));

  // 蒙特卡洛：2 万样本的经验分布对解析分布。种子固定，结果确定；容差约为抽样标准误的 5 倍。
  const N = 20000;
  const mc = B.belSample({ fGHz: 28, buildingType: 'traditional', rng: xorshift32(20230801), n: N });
  const sorted = Float64Array.from(mc.samples).sort();
  approx('蒙特卡洛 2 万样本：经验中值 ≈ belMedian（标准误 ≈ 0.11 dB）', sorted[N / 2], med, 0.5);
  let ks = 0;
  for (const P of [0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.98]) {
    const L = bel(28, P, 'traditional').L;
    let k = 0;
    while (k < N && sorted[k] <= L) k++;
    ks = Math.max(ks, Math.abs(k / N - P));
  }
  ok('蒙特卡洛 2 万样本：9 个分位点上经验 CDF 与 P 之差 < 0.01（标准误 ≤ 0.0035）', ks < 0.01, `max ${ks.toFixed(4)}`);
  const m = /^(\d+)\/20000 /.exec(mc.warnings[0] || '');
  ok('蒙特卡洛：约 2 % 样本落在验证区间外并计入告警', !!m && Math.abs(Number(m[1]) / N - 0.02) < 0.005, mc.warnings.join('；'));
}

// —— 告警与无效入参 ——
console.log('\n=== 告警与无效入参 ===');
{
  const w = (r) => (r.warnings || []).join('；');
  ok('P = 0.01 / 0.99 边界不告警', bel(28, 0.01, 'traditional').warnings.length === 0 && bel(28, 0.99, 'traditional').warnings.length === 0);
  const r1 = bel(28, 0.005, 'traditional');
  ok('P = 0.005 → 照算 + 告警', Number.isFinite(r1.L) && w(r1) === 'P = 0.005 超出模型验证范围 0.01–0.99', w(r1));
  ok('P = 0.995 → 照算 + 告警', bel(28, 0.995, 'traditional').warnings.length === 1);
  const r2 = bel(0.05, 0.5, 'traditional');
  ok('f = 0.05 GHz → 照算 + 告警', Number.isFinite(r2.L) && w(r2) === '频率 0.05 GHz 超出适用范围约 0.08–100 GHz', w(r2));
  ok('f = 150 GHz 热效率 → 照算 + 告警', bel(150, 0.5, 'thermallyEfficient').warnings.length === 1);
  ok('f = 0.08 / 100 GHz 边界不告警', bel(0.08, 0.5, 'traditional').warnings.length === 0 && bel(100, 0.5, 'traditional').warnings.length === 0);
  const r3 = bel(200, 0.5, 'traditional');
  ok('f = 200 GHz 传统：σ2 < 0（过零点 10^2.25 ≈ 178 GHz）→ error', !!r3.error, r3.error);
  ok('P = 0 → error', !!bel(28, 0, 'traditional').error);
  ok('P = 1 → error', !!bel(28, 1, 'traditional').error);
  ok('P = NaN → error', !!bel(28, NaN, 'traditional').error);
  ok('f = 0 / NaN → error', !!bel(0, 0.5, 'traditional').error && !!bel(NaN, 0.5, 'traditional').error);
  ok('未知建筑类型 → error', !!bel(28, 0.5, 'thermally-efficient').error && !!bel(28, 0.5, 'hasOwnProperty').error);
  ok('|θ| > 90° → error', !!bel(28, 0.5, 'traditional', 95).error && !!bel(28, 0.5, 'traditional', -91).error);
  ok('θ 缺省 / null 视同 0°', bel(28, 0.5, 'traditional', undefined).L === bel(28, 0.5, 'traditional', 0).L &&
    bel(28, 0.5, 'traditional', null).L === bel(28, 0.5, 'traditional', 0).L);
  ok('无效入参在分布函数上同样报 error', !!B.belCdf({ fGHz: 28, buildingType: 'x', L: 10 }).error &&
    !!B.belSample({ fGHz: -1, buildingType: 'traditional' }).error && !!B.belMedian({ fGHz: 28 }).error);
}

console.log('\n工作簿对拍汇总：');
console.log(`  BEL 页合计 ${tallies.reduce((a, t) => a + t.n, 0)} 点，最大偏差 ${Math.max(...tallies.map((t) => t.max)).toExponential(2)} dB`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
