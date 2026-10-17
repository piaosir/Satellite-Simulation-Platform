// ITU-R F.1336-5 参考方向图测试（无框架，纯断言）。
//   运行： node packages/core/test/f1336.test.mjs
//
// 四层（对应 utils/terrestrial/f1336.js 的四类方向图）：
//   ① 全向 recommends 2 —— (1a)–(1e)：逐点、峰值归一、θ4 / θ3 处连续、(1d) 在 θ3 / θ5 处的固有台阶、单调、对称、电倾；
//   ② 扇区 0.4–6 GHz recommends 3.1 —— 表 4 缺省 k、(2a1)–(2c3) 逐点、各断点连续 / xk 处固有台阶、G ≥ G0 + G180、
//      R 的端点、方位单调与宽波束例外、Note 3 拦截、机械倾 (3b)(3c) 与独立矢量旋转对拍、倾角主瓣落点与组合次序；
//   ③ 扇区 6–70 GHz recommends 3.2 —— (2d1)–(2f) 逐点、x = 1 连续 / x = 1.152 固有台阶、φ3m 在 φth 处连续、
//      ψα 在 ψ = 90° 处连续（附件 6 式 (50)）与正文字面 (2d3) 的断开量、FBR 式 (47)、主平面与天顶；
//   ④ 低增益 recommends 4.1 —— (4) 逐点、1.08φ3 处固有台阶、φ1 / φ2 连续、单调、−8 dBi 底板、G0 < 6 拦截。
//
// 期望值从哪来：
//   · 参考式：本文件按建议书原文另写的一套（ref* 函数），与模块代码互不引用。其中 6–70 GHz 的 ψ、α 刻意用原文字面的
//     arccos / arctan 形式（模块用等价的 atan2 形式），机械倾用 Rodrigues 旋转矢量（模块用式 (41)）。
//   · 锚点：另用 Python 按建议书原文独立算出、抄成字面量的数值——守住参考式本身没抄错。
//   · 台阶量：一律由解析式在测试里现算（如 (1d) θ3 处 = −3 + 10lg(k+1)），不是把实现输出抄回来。
//
// 建议书自身的不连续 / 非单调（实现照原文、不修，下面逐一钉住台阶量；「台阶」= 外侧值 − 内侧值）：
//   (1d) θ3：−3 + 10lg(k+1)            k = 0 → −3 dB，k = 0.7 → −0.696 dB
//   (1d) θ5：10lg((θ5/θ3)^−1.5 + k) − 10lg(k+1)   k = 0 → −0.727 dB，k = 0.7 → −0.107 dB
//   (2b3) xk：−12 + 10lg(xk^−1.5 + kv) + 12xk²     kv = 0.3 → +0.133 dB（向上），kv = 0.7 → −0.139 dB
//   (2c3) xk：−15 + 10lg(xk^−1.5 + kv) + 12xk²     kv = 0.3 → +0.400 dB（向上），kv = 0.7 → +0.314 dB（向上）
//   (2f) x = 1.152：−15 − 15lg1.152 + 12·1.152² = +0.0035 dB（向上）
//   (4) 1.08φ3：12·1.08² − 14 = −0.0032 dB
//   连续（断言两侧差 < 1e-6 dB）：(1a) θ4 / θ3；(2b2)(2c2) xh = 0.5 与触底点；(2b3)(2c3) xv = 4 与 90°/θ3；
//   (2e) x = 1；(2d6)(2d7) φ3m 在 φth；附件 6 式 (50)(52) ψα 在 ψ = 90°；(4) φ1 / φ2。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const F = require('../utils/terrestrial/f1336.js');

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
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const D = 1e-9;                                   // 断点两侧取样偏移（度，或归一化角）
const isErr = (r) => !!(r && typeof r === 'object' && typeof r.error === 'string');
const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
const e2 = (x) => x.toExponential(2);
// 方位角差（模 360°）：+180° 与 −180° 是同一方向
const dAz = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
// 逐点最大偏差
const maxDiff = (xs, f, g) => xs.reduce((m, x) => Math.max(m, Math.abs(f(x) - g(x))), 0);
// 非增检查：返回第一处上升（> tol）的位置，没有返回 null
function firstRise(xs, f, tol = 1e-12) {
  let prev = f(xs[0]);
  for (let i = 1; i < xs.length; i++) {
    const v = f(xs[i]);
    if (v > prev + tol) return { at: xs[i - 1], to: xs[i], rise: v - prev };
    prev = v;
  }
  return null;
}
// 二维网格（φ, θ）上的最大偏差
function gridMax(phis, thetas, f, g) {
  let m = 0;
  for (const p of phis) for (const t of thetas) m = Math.max(m, Math.abs(f(p, t) - g(p, t)));
  return m;
}

// ===========================================================================
console.log('=== ① 全向 recommends 2 ===');
// ===========================================================================

// 参考式：recommends 2.1 式 (1a)(1b)(1c)、2.2 式 (1d)
function refOmni(G0, th, k, avg, th3) {
  const t3 = th3 != null ? th3 : 107.6 * Math.pow(10, -G0 / 10);
  const a = Math.abs(th);
  if (!avg) {
    const t4 = t3 * Math.sqrt(1 - lg(k + 1) / 1.2);
    if (a < t4) return G0 - 12 * (a / t3) ** 2;
    if (a < t3) return G0 - 12 + 10 * lg(k + 1);
    return G0 - 12 + 10 * lg((a / t3) ** -1.5 + k);
  }
  const t5 = t3 * Math.sqrt(1.25 - lg(k + 1) / 1.2);
  if (a < t3) return G0 - 12 * (a / t3) ** 2;
  if (a < t5) return G0 - 15 + 10 * lg(k + 1);
  return G0 - 15 + 10 * lg((a / t3) ** -1.5 + k);
}
// 参考式：recommends 2.5 式 (1e)
const refTe = (th, b) => (th + b >= 0 ? 90 * (th + b) / (90 + b) : 90 * (th + b) / (90 - b));

approx('θ3 式 (1b)：G0 = 10 dBi → 107.6 × 10^−1 = 10.76°', F.omniTheta3(10), 10.76, 1e-12);
{
  const p = F.makeOmni({ G0: 10, k: 0.7 });
  const a = F.makeOmni({ G0: 10, k: 0.7, mode: 'average' });
  approx('θ4 式 (1c)：G0 = 10、k = 0.7 → 10.76·√(1 − lg1.7/1.2)（锚点）', p.theta4, 9.671793049905256, 1e-10);
  approx('θ5 recommends 2.2：G0 = 10、k = 0.7 → 10.76·√(1.25 − lg1.7/1.2)（锚点）', a.theta5, 11.06742882516963, 1e-10);
}
ok('k 参数 2.3 / 2.4：0.9 / 2 GHz 一般型 0.7；2 GHz 改进型 0；3.5 GHz 0；3 GHz 整点归 2.4',
  F.omniK(0.9) === 0.7 && F.omniK(2, 'typical') === 0.7 && F.omniK(2, 'improved') === 0 &&
  F.omniK(3.5, 'typical') === 0 && F.omniK(3, 'typical') === 0);
ok('k 缺省：给 fGHz = 2 → 0.7；不给 fGHz → 0（3–70 GHz 口径）；显式 k 优先',
  F.makeOmni({ G0: 10, fGHz: 2 }).k === 0.7 && F.makeOmni({ G0: 10 }).k === 0 && F.makeOmni({ G0: 10, fGHz: 2, k: 0.2 }).k === 0.2);

// 峰值归一
{
  let worst = 0, n = 0;
  for (const G0 of [2, 5, 8, 10, 13, 16]) for (const k of [0, 0.5, 0.7]) for (const mode of ['peak', 'average']) {
    for (const tilt of [0, 3, 6, 12, -4]) {
      const m = F.makeOmni({ G0, k, mode, tiltDeg: tilt });
      worst = Math.max(worst, Math.abs(m.gain(-tilt) - G0));
      n++;
    }
  }
  ok(`峰值归一：G(θh = −β) = G0（${n} 组：G0 × k × 峰值/平均 × 电倾）`, worst < 1e-12, `max|Δ| = ${e2(worst)}`);
}

// 逐点：G0 = 10 dBi、k = 0.7（Python 锚点）
{
  const peak = [[0, 10], [5, 7.408825195892815], [10, 0.3044892137827393], [20, -1.6073866827563215],
    [45, -2.87818921337626], [90, -3.2998344899802077]];
  const avg = [[0, 10], [5, 7.408825195892815], [10, -0.3646992164287397], [20, -4.607386682756322],
    [45, -5.87818921337626], [90, -6.299834489980208]];
  for (const [t, want] of peak) approx(`峰值 (1a) G0 = 10、k = 0.7：G(${t}°)（锚点）`, F.omni({ G0: 10, k: 0.7, thetaDeg: t }), want, 1e-9);
  for (const [t, want] of avg) approx(`平均 (1d) G0 = 10、k = 0.7：G(${t}°)（锚点）`, F.omni({ G0: 10, k: 0.7, thetaDeg: t, mode: 'average' }), want, 1e-9);
}

// 全角域对参考式
{
  const ths = linspace(-90, 90, 3601);
  let worst = 0;
  for (const G0 of [8, 10, 13]) for (const k of [0, 0.7]) for (const avg of [false, true]) {
    const m = F.makeOmni({ G0, k, mode: avg ? 'average' : 'peak' });
    worst = Math.max(worst, maxDiff(ths, (t) => m.gain(t), (t) => refOmni(G0, t, k, avg)));
  }
  const m3 = F.makeOmni({ G0: 9, k: 0.7, theta3: 14 });
  worst = Math.max(worst, maxDiff(ths, (t) => m3.gain(t), (t) => refOmni(9, t, 0.7, false, 14)));
  ok('全向 vs 参考式：θ 每 0.05°（3 种 G0 × 2 种 k × 峰值/平均，另加给定 θ3 = 14°）', worst < 1e-12, `max|Δ| = ${e2(worst)}`);
}

// 断点：峰值 (1a) 连续
{
  const t3 = 10.76, k = 0.7, t4 = t3 * Math.sqrt(1 - lg(k + 1) / 1.2);
  const m = F.makeOmni({ G0: 10, k });
  approx('峰值 (1a) 在 θ4 处连续（两侧差）', m.gain(t4 + D) - m.gain(t4 - D), 0, 1e-6);
  approx('峰值 (1a) 在 θ3 处连续（两侧差）', m.gain(t3 + D) - m.gain(t3 - D), 0, 1e-6);
  const m0 = F.makeOmni({ G0: 10, k: 0 });
  approx('峰值 (1a) k = 0（θ4 = θ3，平台为空）在 θ3 处连续', m0.gain(t3 + D) - m0.gain(t3 - D), 0, 1e-6);
}
// 断点：平均 (1d) 的固有台阶
{
  const t3 = 10.76;
  const anchor = { 0: [-3, -0.7268250975604231], 0.7: [-0.6955107862172607, -0.10700974560303989] };
  for (const k of [0, 0.7]) {
    const t5 = t3 * Math.sqrt(1.25 - lg(k + 1) / 1.2);
    const m = F.makeOmni({ G0: 10, k, mode: 'average' });
    const s3 = m.gain(t3 + D) - m.gain(t3 - D);
    const s5 = m.gain(t5 + D) - m.gain(t5 - D);
    approx(`平均 (1d) k = ${k}：θ3 处台阶 = −3 + 10lg(k+1)`, s3, -3 + 10 * lg(k + 1), 1e-6);
    approx(`平均 (1d) k = ${k}：θ5 处台阶 = 10lg((θ5/θ3)^−1.5 + k) − 10lg(k+1)`, s5, 10 * lg((t5 / t3) ** -1.5 + k) - 10 * lg(k + 1), 1e-6);
    ok(`平均 (1d) k = ${k}：两处台阶与锚点一致（${anchor[k][0].toFixed(4)} / ${anchor[k][1].toFixed(4)} dB）`,
      Math.abs(s3 - anchor[k][0]) < 1e-6 && Math.abs(s5 - anchor[k][1]) < 1e-6);
  }
}

// 单调与对称
{
  const ths = linspace(0, 90, 90001);
  const rises = [];
  for (const k of [0, 0.7]) for (const mode of ['peak', 'average']) {
    const m = F.makeOmni({ G0: 10, k, mode });
    const r = firstRise(ths, (t) => m.gain(t));
    if (r) rises.push(`${mode}/k=${k}@${r.at}`);
  }
  ok('全向单调：|θ| ∈ [0°, 90°] 每 0.001° 非增（峰值连续；平均的两处台阶都向下）', rises.length === 0, rises.join(' '));
  const m = F.makeOmni({ G0: 10, k: 0.7, mode: 'average' });
  const sym = maxDiff(linspace(0, 90, 1801), (t) => m.gain(t), (t) => m.gain(-t));
  ok('全向对称：G(θ) = G(−θ)', sym === 0, `max|Δ| = ${e2(sym)}`);
}

// 电倾 recommends 2.5 式 (1e)
{
  const ths = linspace(-90, 90, 721);
  ok('电倾 (1e) β = 0 恒等：θe = θh', ths.every((t) => F.electricalTiltElevation(t, 0) === t));
  ok('电倾 (1e)：θh = −β 落在主瓣（θe = 0）', [2, 6, 10, 15, -4].every((b) => Math.abs(F.electricalTiltElevation(-b, b)) < 1e-12));
  ok('电倾 (1e)：天顶 / 天底不动', [3, 6, 10, -5].every((b) => F.electricalTiltElevation(90, b) === 90 && F.electricalTiltElevation(-90, b) === -90));
  approx('电倾 (1e)：θh = 10°、β = 6° → 90·16/96 = 15°', F.electricalTiltElevation(10, 6), 15, 1e-12);
  approx('电倾 (1e)：θh = −30°、β = 6° → 90·(−24)/84', F.electricalTiltElevation(-30, 6), 90 * -24 / 84, 1e-12);
  const inc = ths.every((t, i) => i === 0 || F.electricalTiltElevation(t, 6) > F.electricalTiltElevation(ths[i - 1], 6));
  ok('电倾 (1e)：θe 随 θh 严格递增，两支在 θh = −β 处相接', inc &&
    Math.abs(F.electricalTiltElevation(-6 + D, 6) - F.electricalTiltElevation(-6 - D, 6)) < 1e-8);
  for (const mode of ['peak', 'average']) {
    const m = F.makeOmni({ G0: 10, k: 0.7, mode, tiltDeg: 6 });
    const w = maxDiff(ths, (t) => m.gain(t), (t) => refOmni(10, refTe(t, 6), 0.7, mode === 'average'));
    ok(`带电倾 6° 的全向图（${mode}）= 参考式在 θe 处取值`, w < 1e-12, `max|Δ| = ${e2(w)}`);
  }
}

ok('非法输入一律 { error }：G0 非数 / θ = 91° / mode 不认 / k < 0 / 电倾 90° / omniK 频率 ≤ 0 / θ4 的 θ3 ≤ 0 / k 过大 θ4 无实数解',
  isErr(F.omni({ G0: 'x', thetaDeg: 0 })) && isErr(F.omni({ G0: 10, thetaDeg: 91 })) &&
  isErr(F.omni({ G0: 10, thetaDeg: 0, mode: 'mean' })) && isErr(F.omni({ G0: 10, thetaDeg: 0, k: -0.1 })) &&
  isErr(F.omni({ G0: 10, thetaDeg: 0, tiltDeg: 90 })) && isErr(F.omniK(0)) &&
  isErr(F.omniTheta4(-1, 0)) && isErr(F.omniTheta4(10, 20)) && isErr(F.omni({ G0: 10, thetaDeg: 0, k: 20 })));
ok('容差内越界按边界钳住：θ = 90° + 1e-12 与 90° 同值', F.omni({ G0: 10, thetaDeg: 90 + 1e-12 }) === F.omni({ G0: 10, thetaDeg: 90 }));

// ===========================================================================
console.log('\n=== ② 扇区 0.4–6 GHz recommends 3.1 ===');
// ===========================================================================

// 参考式：recommends 3.1.1 / 3.1.2 式 (2a1)(2a2)(2b1)–(2b3)(2c1)–(2c3)，θ3 缺省按式 (3a)
function refLow(G0, phi3, th3In, kh, kv, kpa, avg) {
  const t3 = th3In != null ? th3In : 31000 * 10 ** (-G0 / 10) / phi3;
  const G180 = (avg ? -15 : -12) + 10 * lg(1 + 8 * kpa) - 15 * lg(180 / t3);
  const lkh = 3 * (1 - 0.5 ** -kh);
  const C = 10 * lg(((180 / t3) ** 1.5) * (4 ** -1.5 + kv) / (1 + 8 * kpa)) / lg(22.5 / t3);
  const lkv = 12 - C * lg(4) - 10 * lg(4 ** -1.5 + kv);
  const xk = avg ? Math.sqrt(1.33 - 0.33 * kv) : Math.sqrt(1 - 0.36 * kv);
  const ghr = (xh) => Math.max(xh <= 0.5 ? -12 * xh * xh : -12 * xh ** (2 - kh) - lkh, G180);
  const gvr = (xv) => {
    if (xv < xk) return -12 * xv * xv;
    if (xv < 4) return (avg ? -15 : -12) + 10 * lg(xv ** -1.5 + kv);
    if (xv < 90 / t3) return -lkv - (avg ? 3 : 0) - C * lg(xv);
    return G180;
  };
  const gb = ghr(180 / phi3);
  const R = (xh) => (ghr(xh) - gb) / (ghr(0) - gb);
  const G = (phi, th) => {
    const xh = Math.abs(phi) / phi3;
    return G0 + ghr(xh) + R(xh) * gvr(Math.abs(th) / t3);
  };
  return { t3, G180, lkh, C, lkv, xk, ghr, gvr, gb, R, G };
}

// 4 种组合：[标签, type, mode, kh, kv, kp/ka, Python 锚点]
const LOW_PTS = [[0, 0], [30, 0], [60, 5], [0, 10], [90, 20], [150, 3], [180, 0], [45, 60], [0, 90]];
const LOW = [
  ['IMT/改进型·峰值', 'improved', 'peak', 0.7, 0.3, 0.7, {
    g180: -24.456923163259646, lkh: -1.8735143781374128, C: 18.450879872735722, lkv: 4.607574123324339, xk: 0.9444575162494075,
    G: [18, 15.44378698224852, 5.728125439811647, 5.809854918237999, -3.273416832995551, -6.4569231632596455,
      -6.4569231632596455, -3.9473713020910957, -6.4569231632596455], step: 0.1325786474471844 }],
  ['IMT/改进型·平均', 'improved', 'average', 0.7, 0.3, 0.7, {
    g180: -27.456923163259646, lkh: -1.8735143781374128, C: 18.450879872735722, lkv: 4.607574123324339, xk: 1.1095043938624127,
    G: [18, 15.44378698224852, 5.518396545418836, 2.809854918237999, -5.559353950757202, -9.456923163259646,
      -9.456923163259646, -6.866573449916295, -9.456923163259646], step: 0.4003395399251062 }],
  ['一般型·峰值', 'typical', 'peak', 0.8, 0.7, 0.7, {
    g180: -24.456923163259646, lkh: -2.2233033797767447, C: 24.53161101061181, lkv: -1.9340409978091446, xk: 0.8648699324175861,
    G: [18, 15.44378698224852, 5.9345683872714865, 7.326317216317149, -2.01091389333184, -6.4569231632596455,
      -6.4569231632596455, -3.1077550626616226, -6.4569231632596455], step: -0.13861513386782143 }],
  ['一般型·平均', 'typical', 'average', 0.8, 0.7, 0.7, {
    g180: -27.456923163259646, lkh: -2.2233033797767447, C: 24.53161101061181, lkv: -1.9340409978091446, xk: 1.0483320084782302,
    G: [18, 15.44378698224852, 5.731006210513316, 4.326317216317149, -4.168867702478009, -9.456923163259646,
      -9.456923163259646, -6.0017015733664, -9.456923163259646], step: 0.3142640140816564 }]
];

approx('θ3 式 (3a)：G0 = 18 dBi、φ3 = 65° → 31000·10^−1.8/65（锚点）', F.sectoralTheta3(18, 65), 7.558721379429926, 1e-12);
{
  const t = F.sectoralK('typical'), i = F.sectoralK('improved'), m = F.sectoralK('imt');
  ok('表 4 缺省 k：一般型 kh/kv/kp/ka = 0.8/0.7/0.7/0.7；改进型 = IMT 基站 = 0.7/0.3/0.7/0.7',
    t.kh === 0.8 && t.kv === 0.7 && t.kp === 0.7 && t.ka === 0.7 &&
    i.kh === 0.7 && i.kv === 0.3 && i.kp === 0.7 && i.ka === 0.7 &&
    m.kh === 0.7 && m.kv === 0.3 && isErr(F.sectoralK('better')));
}

const PHIS = linspace(-180, 180, 241), THS = linspace(-90, 90, 361);
for (const [label, type, mode, kh, kv, kpa, A] of LOW) {
  const avg = mode === 'average';
  const m = F.makeSectoral({ band: 'low', G0: 18, phi3: 65, type, mode });
  const ref = refLow(18, 65, null, kh, kv, kpa, avg);
  const pd = Math.max(Math.abs(m.g180 - A.g180), Math.abs(m.lambdaKh - A.lkh), Math.abs(m.C - A.C),
    Math.abs(m.lambdaKv - A.lkv), Math.abs(m.xk - A.xk));
  ok(`${label}：G180 / λkh / C / λkv / xk 与锚点一致`, pd < 1e-9,
    `G180=${m.g180.toFixed(4)} λkh=${m.lambdaKh.toFixed(4)} C=${m.C.toFixed(4)} λkv=${m.lambdaKv.toFixed(4)} xk=${m.xk.toFixed(4)}`);
  const sd = LOW_PTS.reduce((mx, [p, t], j) => Math.max(mx, Math.abs(m.gain(p, t) - A.G[j])), 0);
  ok(`${label}：9 个 (φ, θ) 逐点与锚点一致（G0 = 18、φ3 = 65°）`, sd < 1e-9, `max|Δ| = ${e2(sd)}`);
  const gd = gridMax(PHIS, THS, (p, t) => m.gain(p, t), (p, t) => ref.G(p, t));
  ok(`${label}：全角域网格（φ 每 1.5°、θ 每 0.5°）对参考式`, gd < 1e-12, `max|Δ| = ${e2(gd)}`);
}
{
  // 另一组参数：G0 = 16 dBi、φ3 = 90°、θ3 给定 12°（Note 5：已知 θ3 直接用）
  const m = F.makeSectoral({ band: 'low', G0: 16, phi3: 90, theta3: 12, type: 'improved', mode: 'average' });
  const ref = refLow(16, 90, 12, 0.7, 0.3, 0.7, true);
  const gd = gridMax(PHIS, THS, (p, t) => m.gain(p, t), (p, t) => ref.G(p, t));
  ok('给定 θ3 = 12°（G0 = 16、φ3 = 90°、改进型·平均）：全角域对参考式', m.theta3Source === 'input' && gd < 1e-12, `max|Δ| = ${e2(gd)}`);
}

// 峰值归一
{
  let worst = 0, n = 0, skipped = 0;
  for (const G0 of [14, 16, 18, 21]) for (const phi3 of [33, 65, 90, 120]) for (const type of ['typical', 'improved']) {
    for (const mode of ['peak', 'average']) {
      const m = F.makeSectoral({ band: 'low', G0, phi3, type, mode });
      if (m.error) { skipped++; continue; }      // θ3 ≥ 20° 的组合由 Note 3 拦下，下文单测
      worst = Math.max(worst, Math.abs(m.gain(0, 0) - G0));
      n++;
    }
  }
  ok(`峰值归一：G(0°, 0°) = G0（${n} 组；${skipped} 组 θ3 ≥ 20° 被 Note 3 拦下）`, worst === 0, `max|Δ| = ${e2(worst)}`);
}

// 断点连续 / 固有台阶 / 单调（用模块的积木 Ghr、Gvr，期望值由解析式现算）
for (const [label, type, mode, kh, kv, kpa, A] of LOW) {
  const avg = mode === 'average';
  const P = F.sectoralLowParams({ G0: 18, phi3: 65, type, mode });
  const t3 = 31000 * 10 ** (-1.8) / 65;
  const g180 = (avg ? -15 : -12) + 10 * lg(1 + 8 * kpa) - 15 * lg(180 / t3);
  const lkh = 3 * (1 - 0.5 ** -kh);
  const xf = ((-g180 - lkh) / 12) ** (1 / (2 - kh));          // −12xh^(2−kh) − λkh = G180 的触底点
  const s05 = F.Ghr(0.5 + D, P) - F.Ghr(0.5 - D, P);
  const sf = F.Ghr(xf + D, P) - F.Ghr(xf - D, P);
  ok(`${label}：Ghr 在 xh = 0.5 与触底点 xh = ${xf.toFixed(3)} 处连续`, Math.abs(s05) < 1e-6 && Math.abs(sf) < 1e-6,
    `Δ = ${e2(s05)} / ${e2(sf)}`);
  const s4 = F.Gvr(4 + D, P) - F.Gvr(4 - D, P);
  const s90 = F.Gvr(90 / t3 + D, P) - F.Gvr(90 / t3 - D, P);
  ok(`${label}：Gvr 在 xv = 4 与 xv = 90°/θ3 处连续`, Math.abs(s4) < 1e-6 && Math.abs(s90) < 1e-6, `Δ = ${e2(s4)} / ${e2(s90)}`);
  const xk = avg ? Math.sqrt(1.33 - 0.33 * kv) : Math.sqrt(1 - 0.36 * kv);
  const want = (avg ? -15 : -12) + 10 * lg(xk ** -1.5 + kv) + 12 * xk * xk;
  const sk = F.Gvr(xk + D, P) - F.Gvr(xk - D, P);
  approx(`${label}：Gvr 在 xk 处固有台阶 = ${avg ? '−15' : '−12'} + 10lg(xk^−1.5 + kv) + 12xk²${want > 0 ? '（向上）' : ''}`, sk, want, 1e-6);
  ok(`${label}：xk 台阶与锚点一致（${A.step.toFixed(4)} dB）`, Math.abs(sk - A.step) < 1e-6);
  // 合成增益里：φ = 0 时 R = 1，台阶原样出现在 G(0, θ) 上
  const skG = P.G0 + 0 + F.Gvr(xk + D, P) - (P.G0 + F.Gvr(xk - D, P));
  const m = F.makeSectoral({ band: 'low', G0: 18, phi3: 65, type, mode });
  const skGain = m.gain(0, xk * t3 + D) - m.gain(0, xk * t3 - D);
  approx(`${label}：G(0°, θ) 在 θ = xk·θ3 处台阶同上（R = 1）`, skGain, skG, 1e-6);
  // 单调：Ghr 全程非增；Gvr 在 [0, xk) 与 [xk, 90°/θ3] 各自非增；全程只在 xk 处可能上升
  const xs = linspace(0, 180 / 65, 20001);
  const rh = firstRise(xs, (x) => F.Ghr(x, P));
  const left = linspace(0, xk - 1e-12, 5001), right = linspace(xk, 90 / t3, 20001);
  const rl = firstRise(left, (x) => F.Gvr(x, P)), rr = firstRise(right, (x) => F.Gvr(x, P));
  ok(`${label}：Ghr 全程非增；Gvr 在 xk 两侧各自非增`, !rh && !rl && !rr);
  const all = linspace(0, 90 / t3, 40001);
  const rAll = firstRise(all, (x) => F.Gvr(x, P));
  if (want > 0) {
    ok(`${label}：Gvr 全程唯一的上升就在 xk 处（台阶 ${want.toFixed(4)} dB）`, !!rAll && rAll.at <= xk && rAll.to >= xk &&
      !firstRise(all.filter((x) => x > rAll.to), (x) => F.Gvr(x, P)), rAll ? `@[${rAll.at.toFixed(5)}, ${rAll.to.toFixed(5)}]` : '');
  } else {
    ok(`${label}：Gvr 全程非增（xk 台阶向下）`, !rAll);
  }
}

// G ≥ G0 + G180、对称、R 端点、正后方与仰角无关
for (const [label, type, mode] of LOW) {
  const m = F.makeSectoral({ band: 'low', G0: 18, phi3: 65, type, mode });
  let minEx = Infinity, symD = 0, rOut = 0, back = 0;
  for (const p of PHIS) for (const t of THS) {
    const g = m.gain(p, t);
    minEx = Math.min(minEx, g - (18 + m.g180));
    symD = Math.max(symD, Math.abs(g - m.gain(-p, t)), Math.abs(g - m.gain(p, -t)));
    const R = F.compressionRatio(Math.abs(p) / 65, m);
    if (R < 0 || R > 1) rOut++;
  }
  for (const t of THS) back = Math.max(back, Math.abs(m.gain(180, t) - (18 + m.ghrBack)), Math.abs(m.gain(-180, t) - (18 + m.ghrBack)));
  ok(`${label}：G ≥ G0 + G180（全网格）`, minEx >= -1e-12, `min(G − G0 − G180) = ${minEx.toFixed(6)}`);
  ok(`${label}：对称 G(φ, θ) = G(−φ, θ) = G(φ, −θ)`, symD === 0, `max|Δ| = ${e2(symD)}`);
  ok(`${label}：R(0) = 1、R(180°/φ3) = 0、R ∈ [0, 1]；正后方 G(±180°, θ) = G0 + Ghr(180°/φ3) 与 θ 无关`,
    F.compressionRatio(0, m) === 1 && F.compressionRatio(180 / 65, m) === 0 && rOut === 0 && back < 1e-12);
}

// 方位单调（φ3 = 65°：Ghr 在 180° 前已触底）与宽波束例外（代数性质，见模块头注）
{
  const rises = [];
  for (const [label, type, mode] of LOW) {
    const m = F.makeSectoral({ band: 'low', G0: 18, phi3: 65, type, mode });
    for (const t of [0, 3, 8, 20, 45, 90]) {
      const r = firstRise(linspace(0, 180, 3601), (p) => m.gain(p, t));
      if (r) rises.push(`${label}@θ=${t}`);
    }
    if (m.ghrBack !== m.g180) rises.push(`${label}: Ghr(180°/φ3) 未触底`);
  }
  ok('φ3 = 65°：Ghr(180°/φ3) = G180，G 随 |φ| 单调不增（6 个仰角 × 4 组合）', rises.length === 0, rises.join(' '));
  let zen = 0;
  for (const [, type, mode] of LOW) {
    const m = F.makeSectoral({ band: 'low', G0: 18, phi3: 65, type, mode });
    for (const p of PHIS) zen = Math.max(zen, Math.abs(m.gain(p, 90) - (18 + m.g180)), Math.abs(m.gain(p, -90) - (18 + m.g180)));
  }
  ok('φ3 = 65°（已触底）：天顶 / 天底 G(φ, ±90°) = G0 + G180，与 φ 无关', zen < 1e-12, `max|Δ| = ${e2(zen)}`);
  const w = F.makeSectoral({ band: 'low', G0: 15, phi3: 120, type: 'improved', mode: 'peak' });
  let idD = 0;
  for (const p of PHIS) for (const t of THS) {
    const gh = F.Ghr(Math.abs(p) / 120, w), gv = F.Gvr(Math.abs(t) / w.theta3, w);
    idD = Math.max(idD, Math.abs((w.gain(p, t) - 15) - (gh * (1 - gv / w.ghrBack) + gv)));
  }
  ok('宽波束 φ3 = 120°、G0 = 15：Ghr(180°/φ3) > G180（未触底），恒等式 G − G0 = Ghr·(1 − Gvr/Ghr(180°/φ3)) + Gvr 成立',
    w.ghrBack > w.g180 && idD < 1e-12, `Ghr(1.5) = ${w.ghrBack.toFixed(3)}，G180 = ${w.g180.toFixed(3)}`);
  ok('宽波束：天顶处 G(180°, 90°) > G(0°, 90°)——Gvr = G180 < Ghr(180°/φ3) 时 G 随 |φ| 上升（建议书合成式的性质）',
    w.gain(180, 90) > w.gain(0, 90), `${w.gain(0, 90).toFixed(3)} → ${w.gain(180, 90).toFixed(3)} dBi`);
}

// 适用范围
{
  const e = F.makeSectoral({ band: 'low', G0: 13, phi3: 65 });
  ok('Note 3：G0 = 13、φ3 = 65° → θ3 = 23.9° ≥ 20°，返回 { error }', isErr(e), e.error);
  ok('Note 3：给定 θ3 = 19.9° 可算；θ3 = 20° 拦下', !isErr(F.makeSectoral({ band: 'low', G0: 13, phi3: 65, theta3: 19.9 })) &&
    isErr(F.makeSectoral({ band: 'low', G0: 13, phi3: 65, theta3: 20 })));
  const w = F.makeSectoral({ band: 'low', G0: 18, phi3: 130 });
  ok('recommends 3.3：φ3 = 130° 用 (3a) 推 θ3 → 可算但记 warning', !isErr(w) && w.warnings.length === 1, w.warnings[0]);
  ok('非法输入一律 { error }：缺 band 与 fGHz / band 不认 / kv = 1.5 / φ3 ≤ 0 / mode 不认',
    isErr(F.makeSectoral({ G0: 18, phi3: 65 })) && isErr(F.makeSectoral({ band: 'mid', G0: 18, phi3: 65 })) &&
    isErr(F.makeSectoral({ band: 'low', G0: 18, phi3: 65, params: { kv: 1.5 } })) &&
    isErr(F.makeSectoral({ band: 'low', G0: 18, phi3: 0 })) && isErr(F.makeSectoral({ band: 'low', G0: 18, phi3: 65, mode: 'x' })));
  ok('按频率选段：fGHz = 3.5 → low（3.1），fGHz = 6 → high（3.2）',
    F.makeSectoral({ fGHz: 3.5, G0: 18, phi3: 65 }).band === 'low' && F.makeSectoral({ fGHz: 6, G0: 18, phi3: 65 }).band === 'high');
  const pr = F.makeSectoral({ band: 'low', G0: 18, phi3: 65, type: 'improved', params: { kv: 0.5 } });
  ok('params 逐项覆盖表 4：improved + kv = 0.5 → kh 仍 0.7、kv = 0.5', pr.kh === 0.7 && pr.kv === 0.5 && pr.kpa === 0.7);
}

// 机械下倾 recommends 3.4 式 (3b)(3c) —— 对字面式与独立矢量旋转
// 参考式：式 (3b)(3c) 字面（arcsin / arccos，φ ∈ [0°, 180°]）
function refTilt3b3c(thh, phh, b) {
  const t = thh * RAD, p = phh * RAD, bb = b * RAD;
  const th = Math.asin(Math.sin(t) * Math.cos(bb) + Math.cos(t) * Math.cos(p) * Math.sin(bb));
  const c = (-Math.sin(t) * Math.sin(bb) + Math.cos(t) * Math.cos(p) * Math.cos(bb)) / Math.cos(th);
  return { theta: th * DEG, phiAbs: Math.acos(Math.max(-1, Math.min(1, c))) * DEG };
}
// 独立做法：Rodrigues 公式把水平坐标系三根轴绕 +y 转 β（x 轴尖压向 −z，即主瓣下倾），再取投影
function rodrigues(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const kxv = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [0, 1, 2].map((i) => v[i] * c + kxv[i] * s + k[i] * kv * (1 - c));
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function tiltBasis(b) {
  const Y = [0, 1, 0];
  return [rodrigues([1, 0, 0], Y, b * RAD), rodrigues([0, 1, 0], Y, b * RAD), rodrigues([0, 0, 1], Y, b * RAD)];
}
function refTiltVec(thh, phh, b) {
  const t = thh * RAD, p = phh * RAD;
  const u = [Math.cos(t) * Math.cos(p), Math.cos(t) * Math.sin(p), Math.sin(t)];
  const [xa, ya, za] = tiltBasis(b);
  const x = dot3(u, xa), y = dot3(u, ya), z = dot3(u, za);
  return { theta: Math.atan2(z, Math.hypot(x, y)) * DEG, phi: Math.atan2(y, x) * DEG };
}
{
  // 网格含正对天线 z 轴的方向（如 θh = 65°、φh = 0、β = 25° ⇒ θ = 90°）：那里 φ 无定义，只比 θ，φ 不比（计数打印）。
  // 字面式用 arcsin / arccos，在 |θ| → 90°、|c| → 1（φ → 0° / 180°）处是 √ 型病态：1e-14 量级的舍入被放大到
  // ~1e-7 rad。故字面 (3b) 容差 2e-6°、字面 (3c) 容差 1e-4°（公式写错会是度量级的偏差，仍能抓到）；
  // 精确对拍交给下面的 Rodrigues 独立旋转（atan2，容差 1e-9°）。
  const thhs = linspace(-85, 85, 35), phhs = linspace(-175, 175, 71);
  let id = 0, d3b = 0, d3c = 0, sgn = 0, dv = 0, rt = 0, nAxis = 0;
  for (const thh of thhs) for (const phh of phhs) {
    const a0 = F.tiltToAntennaFrame(thh, phh, 0);
    id = Math.max(id, Math.abs(a0.thetaDeg - thh), dAz(a0.phiDeg, phh));
    for (const b of [3, 10, -5, 25]) {
      const a = F.tiltToAntennaFrame(thh, phh, b);
      const L = refTilt3b3c(thh, phh, b);
      const V = refTiltVec(thh, phh, b);
      const onAxis = Math.cos(V.theta * RAD) < 1e-9;
      d3b = Math.max(d3b, Math.abs(a.thetaDeg - L.theta));
      dv = Math.max(dv, Math.abs(a.thetaDeg - V.theta));
      // 往返：把天线系方向用独立基底拼回水平系（正对 z 轴时 φ 任取都拼得回，照比）
      const [xa, ya, za] = tiltBasis(b);
      const ct = Math.cos(a.thetaDeg * RAD);
      const ua = [ct * Math.cos(a.phiDeg * RAD), ct * Math.sin(a.phiDeg * RAD), Math.sin(a.thetaDeg * RAD)];
      const uh = [0, 1, 2].map((i) => ua[0] * xa[i] + ua[1] * ya[i] + ua[2] * za[i]);
      rt = Math.max(rt, Math.abs(Math.atan2(uh[2], Math.hypot(uh[0], uh[1])) * DEG - thh), dAz(Math.atan2(uh[1], uh[0]) * DEG, phh));
      if (onAxis) { nAxis++; continue; }
      d3c = Math.max(d3c, Math.abs(Math.abs(a.phiDeg) - L.phiAbs));
      // y = yh = cosθh·sinφh ⇒ φ 与 φh 同号（φh = 0 时 φ 只能是 0 或 180°，不比符号）
      if (phh !== 0 && Math.sign(a.phiDeg) !== Math.sign(phh)) sgn++;
      dv = Math.max(dv, dAz(a.phiDeg, V.phi));
    }
  }
  ok('机械倾 β = 0 恒等：(θ, φ) = (θh, φh)', id < 1e-12, `max|Δ| = ${e2(id)}°`);
  ok('机械倾 vs 式 (3b) 字面：θ 一致（容差 2e-6°，arcsin 近 ±90° 的舍入放大）', d3b < 2e-6, `max|Δ| = ${e2(d3b)}°`);
  ok('机械倾 vs 式 (3c) 字面：|φ| 一致（容差 1e-4°，arccos 近 ±1 的舍入放大）；φ 与 φh 同号', d3c < 1e-4 && sgn === 0,
    `max|Δ| = ${e2(d3c)}°，异号 ${sgn}，正对 z 轴跳过 ${nAxis} 点`);
  ok('机械倾 vs 独立 Rodrigues 旋转：θ、φ（带符号）一致', dv < 1e-9, `max|Δ| = ${e2(dv)}°`);
  ok('机械倾往返：天线系方向经独立基底拼回水平系 = 原方向', rt < 1e-9, `max|Δ| = ${e2(rt)}°`);
}

// 倾角下的主瓣落点与组合次序（两个频段都测）
for (const band of ['low', 'high']) {
  const base = { band, G0: 18, phi3: 65, type: 'improved' };
  const u = F.makeSectoral(base);
  const mM = F.makeSectoral({ ...base, mechTiltDeg: 8 });
  const mE = F.makeSectoral({ ...base, elecTiltDeg: 6 });
  const mME = F.makeSectoral({ ...base, mechTiltDeg: 4, elecTiltDeg: 6 });
  ok(`${band}：主瓣落点——机械 8° → G(0, −8°)、电倾 6° → G(0, −6°)、机械 4° + 电倾 6° → G(0, −10°) 均 = G0`,
    Math.abs(mM.gain(0, -8) - 18) < 1e-9 && Math.abs(mE.gain(0, -6) - 18) < 1e-9 && Math.abs(mME.gain(0, -10) - 18) < 1e-9);
  const z = F.makeSectoral({ ...base, mechTiltDeg: 0, elecTiltDeg: 0 });
  let d0 = 0, dM = 0, dE = 0, dME = 0;
  for (const p of linspace(-180, 180, 73)) for (const t of linspace(-90, 90, 73)) {
    d0 = Math.max(d0, Math.abs(z.gain(p, t) - u.gain(p, t)));
    const a = F.tiltToAntennaFrame(t, p, 8);
    dM = Math.max(dM, Math.abs(mM.gain(p, t) - u.gain(a.phiDeg, a.thetaDeg)));
    dE = Math.max(dE, Math.abs(mE.gain(p, t) - u.gain(p, refTe(t, 6))));
    const b = F.tiltToAntennaFrame(t, p, 4);
    dME = Math.max(dME, Math.abs(mME.gain(p, t) - u.gain(b.phiDeg, refTe(b.thetaDeg, 6))));
  }
  ok(`${band}：β = 0 与不倾一致；机械倾 = 不倾图在 (3b)(3c) 坐标取值；电倾 = 不倾图在 θe 取值`, d0 === 0 && dM < 1e-9 && dE < 1e-12,
    `${e2(d0)} / ${e2(dM)} / ${e2(dE)}`);
  ok(`${band}：机械 + 电倾 = 先 (3b)(3c) 换到天线系、再在天线系做 (1e)`, dME < 1e-9, `max|Δ| = ${e2(dME)}`);
}

// ===========================================================================
console.log('\n=== ③ 扇区 6–70 GHz recommends 3.2 ===');
// ===========================================================================

// 参考式：recommends 3.2 式 (2d1)–(2f)、附件 6 式 (46)–(52)；ψ、α 按原文字面的 arccos / arctan
function refHigh(G0, phi3, th3In, avg, p180In, rule) {
  const t3 = th3In != null ? th3In : 31000 * 10 ** (-G0 / 10) / phi3;
  const p180 = p180In != null ? p180In : t3;                    // 式 (46)
  const pth = avg ? 1.152 * phi3 : phi3;                          // 式 (48a)(48b)
  const p3m = (ap) => {                                           // 式 (2d6)(2d7) / (49)
    if (ap <= pth) return phi3;
    const u = (ap - pth) / (180 - pth) * 90 * RAD;
    return 1 / Math.sqrt((Math.cos(u) / phi3) ** 2 + (Math.sin(u) / p180) ** 2);
  };
  const X = (phi, th) => {
    const psi = Math.acos(Math.cos(phi * RAD) * Math.cos(th * RAD)) * DEG;    // 式 (2d4)
    if (psi === 0) return 0;
    let pa;
    if (psi <= 90) {
      const alpha = Math.atan(Math.tan(th * RAD) / Math.sin(phi * RAD));       // 式 (2d2)
      const pp = rule === 'mainText' ? phi3 : p3m(Math.abs(phi));
      pa = 1 / Math.sqrt((Math.cos(alpha) / pp) ** 2 + (Math.sin(alpha) / t3) ** 2);   // 式 (2d3) / (50)
    } else {
      pa = 1 / Math.sqrt((Math.cos(th * RAD) / p3m(Math.abs(phi))) ** 2 + (Math.sin(th * RAD) / t3) ** 2);  // 式 (52)
    }
    return psi / pa;                                                            // 式 (2d5)
  };
  const Gref = (x) => (avg ? (x < 1.152 ? G0 - 12 * x * x : G0 - 15 - 15 * lg(x)) : (x < 1 ? G0 - 12 * x * x : G0 - 12 - 15 * lg(x)));
  return { t3, pth, p180, p3m, X, Gref, G: (p, t) => Gref(X(p, t)) };
}

approx('θ3 式 (3a)：G0 = 20 dBi、φ3 = 90° → 31000·10^−2/90', F.sectoralTheta3(20, 90), 3.4444444444444446, 1e-12);
{
  const pts = [[0, 0], [45, 2], [0, 3], [120, 10], [180, 0], [100, -30], [60, 60], [170, 45]];
  const anc = {
    peak: [20, 12.011733703216162, 10.896982310093383, -10.882991216324857, -17.772299810625373, -9.63394448570034,
      -11.388723956079705, -15.806984572663023],
    average: [20, 12.011733703216162, 10.896982310093383, -11.62403310313444, -20.772299810625373, -12.353444809970998,
      -14.388723956079705, -18.787755261556445]
  };
  for (const mode of ['peak', 'average']) {
    const m = F.makeSectoral({ band: 'high', G0: 20, phi3: 90, mode });
    const ref = refHigh(20, 90, null, mode === 'average');
    const sd = pts.reduce((mx, [p, t], j) => Math.max(mx, Math.abs(m.gain(p, t) - anc[mode][j])), 0);
    // 锚点里 (0°, 3°) 一点由 Python 的 arccos 在 ψ = 3° 处求得，与 atan2 形式差 2.7e-13 dB 量级
    ok(`${mode}：8 个 (φ, θ) 逐点与锚点一致（G0 = 20、φ3 = 90°）`, sd < 1e-9, `max|Δ| = ${e2(sd)}`);
    const gd = gridMax(PHIS, THS, (p, t) => m.gain(p, t), (p, t) => ref.G(p, t));
    ok(`${mode}：全角域网格对参考式（arccos / arctan 字面形式）`, gd < 1e-9, `max|Δ| = ${e2(gd)}`);
    ok(`${mode}：峰值归一 G(0°, 0°) = G0`, m.gain(0, 0) === 20);
  }
  // φ3 = 65°（φth < 90°，附件 6 与正文字面在 φth < |φ| ≤ 90° 有别）+ FBR、平均
  for (const [mode, extra] of [['peak', {}], ['average', {}], ['peak', { fbr: 28 }], ['average', { fbr: 33 }]]) {
    const m = F.makeSectoral({ band: 'high', G0: 20, phi3: 65, mode, ...extra });
    const p180 = extra.fbr != null ? 180 / 10 ** ((extra.fbr - (mode === 'average' ? 15 : 12)) / 15) : null;
    const ref = refHigh(20, 65, null, mode === 'average', p180);
    const gd = gridMax(PHIS, THS, (p, t) => m.gain(p, t), (p, t) => ref.G(p, t));
    ok(`φ3 = 65°、${mode}${extra.fbr != null ? `、FBR = ${extra.fbr} dB` : ''}：全角域对参考式`, gd < 1e-9, `max|Δ| = ${e2(gd)}`);
  }
}

// Gref 断点
{
  approx('峰值 (2e) 在 x = 1 处连续', F.Gref(1 + D, 20, 'peak') - F.Gref(1 - D, 20, 'peak'), 0, 1e-6);
  const want = -15 - 15 * lg(1.152) + 12 * 1.152 ** 2;
  const s = F.Gref(1.152 + D, 20, 'average') - F.Gref(1.152 - D, 20, 'average');
  approx('平均 (2f) 在 x = 1.152 处固有台阶 = −15 − 15lg1.152 + 12·1.152²（向上）', s, want, 1e-6);
  ok('平均 (2f) 台阶与锚点一致（+0.0034608 dB）', Math.abs(s - 0.0034608136920990518) < 1e-6);
  // 合成图里：方位面 θ = 0、|φ| = φth = 1.152φ3 处 x = 1.152，台阶原样出现
  const m = F.makeSectoral({ band: 'high', G0: 20, phi3: 65, mode: 'average' });
  approx('平均：方位面 |φ| = 1.152φ3 处 G 的台阶同上', m.gain(1.152 * 65 + D, 0) - m.gain(1.152 * 65 - D, 0), want, 1e-6);
  const xs = linspace(0, 60, 60001);
  ok('Gref 随 x 非增（峰值全程；平均除 1.152 处 +0.0035 dB 外）', !firstRise(xs, (x) => F.Gref(x, 20, 'peak')) &&
    !firstRise(xs.filter((x) => x < 1.152), (x) => F.Gref(x, 20, 'average')) && !firstRise(xs.filter((x) => x >= 1.152), (x) => F.Gref(x, 20, 'average')));
}

// φ3m 与 ψα 的连续性
{
  for (const [mode, extra] of [['peak', {}], ['average', {}], ['peak', { fbr: 28 }]]) {
    const P = F.sectoralHighParams({ G0: 20, phi3: 65, mode, ...extra });
    const pth = mode === 'average' ? 1.152 * 65 : 65;
    const want180 = extra.fbr != null ? 180 / 10 ** ((extra.fbr - 12) / 15) : P.theta3;
    ok(`${mode}${extra.fbr ? '/FBR' : ''}：φ3m 在 φth = ${pth.toFixed(2)}° 处连续、φ3m(180°) = φ3(180)（${want180.toFixed(4)}°）`,
      Math.abs(F.phi3m(pth + D, P) - F.phi3m(pth - D, P)) < 1e-6 && Math.abs(F.phi3m(180, P) - want180) < 1e-12 && P.phiTh === pth);
    // 附件 6 式 (51)：背面俯仰面 θ3m 从 θ3（ψ = 90°）渐变到 φ3(180)（ψ = 180°）；式 (52) 在 |φ| = 180° 时就是它
    const t3 = P.theta3;
    const ref51 = (t) => 1 / Math.sqrt((Math.cos(t * RAD) / want180) ** 2 + (Math.sin(t * RAD) / t3) ** 2);
    const d51 = Math.max(...linspace(-89, 89, 179).map((t) => Math.max(Math.abs(F.theta3m(t, P) - ref51(t)),
      Math.abs(F.sectoralHighX(180, t, P).psiAlpha - ref51(t)))));
    ok(`${mode}${extra.fbr ? '/FBR' : ''}：式 (51) θ3m(90°) = θ3、θ3m(0°) = φ3(180)；|φ| = 180° 处式 (52) 的 ψα = θ3m`,
      Math.abs(F.theta3m(90, P) - t3) < 1e-9 && Math.abs(F.theta3m(0, P) - want180) < 1e-12 && d51 < 1e-12, `max|Δ| = ${e2(d51)}°`);
  }
  // ψ = 90° 即 |φ| = 90°：附件 6 式 (50)(52) 两支在此相接
  const am = F.makeSectoral({ band: 'high', G0: 20, phi3: 65 });
  let worst = 0;
  for (const t of [0, 5, 20, 45, 80, -30]) for (const s of [1, -1]) {
    worst = Math.max(worst, Math.abs(am.gain(s * (90 + D), t) - am.gain(s * (90 - D), t)));
  }
  ok('附件 6 式 (50)(52)：ψ = 90°（|φ| = 90°）两侧连续（6 个仰角 × ±φ）', worst < 1e-6, `max|Δ| = ${e2(worst)}`);
  // 正文字面 (2d3)（第一支用 φ3）：方位面 ψ = 90° 处断开 Gref(90/φ3m(90°)) − Gref(90/φ3)
  const mt = F.makeSectoral({ band: 'high', G0: 20, phi3: 65, psiAlphaRule: 'mainText' });
  const ref = refHigh(20, 65, null, false);
  const want = ref.Gref(90 / ref.p3m(90)) - ref.Gref(90 / 65);
  const got = mt.gain(90 + D, 0) - mt.gain(90 - D, 0);
  approx('正文字面 (2d3)：方位面 ψ = 90° 处断开 = Gref(90/φ3m(90°)) − Gref(90/φ3)（φ3 = 65°、θ3 = 4.77°）', got, want, 1e-6);
  const mtRef = refHigh(20, 65, null, false, null, 'mainText');
  const gd = gridMax(PHIS, THS, (p, t) => mt.gain(p, t), (p, t) => mtRef.G(p, t));
  ok('正文字面 (2d3) 选项：全角域对参考式（同一字面）', gd < 1e-9, `max|Δ| = ${e2(gd)}`);
}

// FBR 式 (47)
{
  approx('式 (47)：FBR = 30 dB、峰值 → φ3(180) = 180/10^((30 − 12)/15)（锚点）', F.phi3At180FromFbr(30, 'peak'), 11.35723220064348, 1e-10);
  const p = F.makeSectoral({ band: 'high', G0: 20, phi3: 90, fbr: 30 });
  const a = F.makeSectoral({ band: 'high', G0: 20, phi3: 90, fbr: 30, mode: 'average' });
  approx('FBR = 30 dB、峰值：G(180°, 0°) = G0 − FBR', p.gain(180, 0), -10, 1e-9);
  approx('FBR = 30 dB、平均（λk 取 15）：G(180°, 0°) = G0 − FBR', a.gain(180, 0), -10, 1e-9);
  ok('FBR < λk（峰值 12 dB）返回 { error }；phi3At180 显式给定优先于 fbr；Gref 的 x < 0 / mode 不认返回 { error }',
    isErr(F.makeSectoral({ band: 'high', G0: 20, phi3: 90, fbr: 11 })) &&
    F.makeSectoral({ band: 'high', G0: 20, phi3: 90, fbr: 30, phi3At180: 7 }).phi3At180 === 7 &&
    isErr(F.Gref(-1, 20)) && isErr(F.Gref(1, 20, 'avg')));
}

// 主平面、天顶、单调、对称
{
  for (const mode of ['peak', 'average']) {
    const m = F.makeSectoral({ band: 'high', G0: 20, phi3: 65, mode });
    const t3 = m.theta3;
    const Gr = (x) => F.Gref(x, 20, mode);
    const el = maxDiff(THS, (t) => m.gain(0, t), (t) => Gr(Math.abs(t) / t3));
    const ze = maxDiff(PHIS, (p) => m.gain(p, 90), () => Gr(90 / t3));
    const bk = maxDiff(THS, (t) => m.gain(180, t), (t) => Gr((180 - Math.abs(t)) / t3));
    ok(`${mode}：俯仰面 G(0, θ) = Gref(|θ|/θ3)；天顶 G(φ, 90°) 与 φ 无关；背面俯仰面 G(180°, θ) = Gref((180° − |θ|)/θ3)`,
      el < 1e-9 && ze < 1e-9 && bk < 1e-9, `${e2(el)} / ${e2(ze)} / ${e2(bk)}`);
    const az = linspace(0, 180, 36001);
    const r = firstRise(az, (p) => m.gain(p, 0));
    const okAz = mode === 'peak' ? !r : (!!r && Math.abs(r.at - 1.152 * 65) < 0.01 && !firstRise(az.filter((p) => p > r.to), (p) => m.gain(p, 0)));
    ok(`${mode}：方位面 G(φ, 0) 随 |φ| 非增${mode === 'peak' ? '' : '（唯一上升在 |φ| = 1.152φ3，即 (2f) 台阶）'}`, okAz, r ? `rise@${r.at.toFixed(3)}°` : '');
    let symD = 0;
    for (const p of PHIS) for (const t of THS) symD = Math.max(symD, Math.abs(m.gain(p, t) - m.gain(-p, t)), Math.abs(m.gain(p, t) - m.gain(p, -t)));
    ok(`${mode}：对称 G(φ, θ) = G(−φ, θ) = G(φ, −θ)`, symD < 1e-12, `max|Δ| = ${e2(symD)}`);
  }
}

// ===========================================================================
console.log('\n=== ④ 低增益 recommends 4.1 ===');
// ===========================================================================

// 参考式：recommends 4.1 式 (4)
function refLowGain(G0, t) {
  const p3 = Math.sqrt(27000 * 10 ** (-G0 / 10)), p1 = 1.9 * p3, p2 = p1 * 10 ** ((G0 - 6) / 32);
  const a = Math.abs(t);
  if (a < 1.08 * p3) return G0 - 12 * (a / p3) ** 2;
  if (a < p1) return G0 - 14;
  if (a < p2) return G0 - 14 - 32 * lg(a / p1);
  return -8;
}
{
  const b = F.lowGainBeamwidths(15);
  ok('式 (4) 角度：G0 = 15 → φ3 = √(27000·10^−1.5)、φ1 = 1.9φ3、φ2 = φ1·10^(9/32)（锚点）',
    Math.abs(b.phi3 - 29.220112392758903) < 1e-10 && Math.abs(b.phi1 - 55.51821354624191) < 1e-10 && Math.abs(b.phi2 - 106.09269534123518) < 1e-10,
    `φ3 = ${b.phi3.toFixed(4)}°、φ1 = ${b.phi1.toFixed(4)}°、φ2 = ${b.phi2.toFixed(4)}°`);
  const anc = [[0, 15], [10, 13.594543262147386], [31, 1.4935607492363907], [40, 1], [80, -4.076944126707873], [120, -8], [180, -8]];
  const sd = anc.reduce((m, [t, w]) => Math.max(m, Math.abs(F.lowGain({ G0: 15, offAxisDeg: t }) - w)), 0);
  ok('G0 = 15：7 个离轴角逐点与锚点一致', sd < 1e-9, `max|Δ| = ${e2(sd)}`);
  const ths = linspace(0, 180, 18001);
  let gd = 0, n0 = 0;
  for (const G0 of [6, 8, 12, 15, 18, 20]) {
    const m = F.makeLowGain({ G0 });
    gd = Math.max(gd, maxDiff(ths, (t) => m.gain(t), (t) => refLowGain(G0, t)));
    if (m.gain(0) === G0) n0++;
  }
  ok('6 种 G0（6…20 dBi）：全程对参考式；峰值归一 G(0) = G0', gd < 1e-12 && n0 === 6, `max|Δ| = ${e2(gd)}`);
  for (const G0 of [10, 15]) {
    const m = F.makeLowGain({ G0 });
    const s = m.gain(1.08 * m.phi3 + D) - m.gain(1.08 * m.phi3 - D);
    approx(`G0 = ${G0}：1.08φ3 处固有台阶 = 12·1.08² − 14`, s, 12 * 1.08 ** 2 - 14, 1e-6);
    ok(`G0 = ${G0}：φ1、φ2 处连续`, Math.abs(m.gain(m.phi1 + D) - m.gain(m.phi1 - D)) < 1e-6 && Math.abs(m.gain(m.phi2 + D) - m.gain(m.phi2 - D)) < 1e-6);
    ok(`G0 = ${G0}：全程非增（三处断点都不向上）、G ≥ −8 dBi 且 θ ≥ φ2 时恰为 −8`,
      !firstRise(ths, (t) => m.gain(t)) && ths.every((t) => m.gain(t) >= -8 && (t < m.phi2 || m.gain(t) === -8)));
  }
  const m6 = F.makeLowGain({ G0: 6 });
  ok('G0 = 6：φ2 = φ1（第三段退化为空），φ1 处仍连续（G0 − 14 = −8）', Math.abs(m6.phi2 - m6.phi1) < 1e-12 &&
    Math.abs(m6.gain(m6.phi1 + D) - m6.gain(m6.phi1 - D)) < 1e-6);
  const e5 = F.makeLowGain({ G0: 5 });
  ok('G0 = 5 dBi < 6：φ2 < φ1、分段失序 → { error }', isErr(e5), e5.error);
  const w = F.makeLowGain({ G0: 22 });
  ok('G0 = 22 dBi > 20：可算但记 warning（recommends 4 / Note 7）', !isErr(w) && w.warnings.length === 1, w.warnings[0]);
  ok('离轴角负值按绝对值、> 180° 报错', F.lowGain({ G0: 15, offAxisDeg: -40 }) === F.lowGain({ G0: 15, offAxisDeg: 40 }) &&
    isErr(F.lowGain({ G0: 15, offAxisDeg: 181 })));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
