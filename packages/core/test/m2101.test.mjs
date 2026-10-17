// ITU-R M.2101-0 §5 IMT AAS 波束赋形方向图测试（无框架，纯断言）。
//   运行： node packages/core/test/m2101.test.mjs
//
// 三层（对应 utils/terrestrial/m2101.js）：
//   ① 单元方向图（表 3）—— 峰值归一 G_E,max @ (90°, 0°)、A_E,H / A_E,V 转平点（12(φ/φ3dB)² = Am、12((θ−90)/θ3dB)² = SLAv）
//      两侧连续、min{·, Am} 总封顶及其等值线两侧连续、底板、对称、单调；
//   ② 阵因子 / 合成方向图（表 4）—— 波束正指处 = A_E(θ0, φ0) + 10lg(NH·NV)；θetilt > 0 ⇒ 峰在 θ = 90° + θetilt（地平线以下）；
//      本文件独立写的逐元复数双重求和、Python 锚点、均匀阵 Dirichlet 闭式三方对拍；快算 vs 逐元 ≤ 1e-9 dB（随机方向）；
//      λ/2 间距无栅瓣、λ 间距的栅瓣出现在解析位置；N 元 λ/2 阵零点落在 cosθ = 2k/N（及 sinφ = 2k/N）；
//   ③ 机械下倾 —— β = 0 恒等、全局↔面板往返、与 F.1336-5 式 (3b)(3c) 同一变换（θ_M2101 = 90° − θ_F1336）、
//      Rodrigues 独立旋转对拍、beamTo 把峰放到目标方向、机械 + 电倾叠加。
//
// 期望值从哪来：参考式 = 本文件按 M.2101 表 3 / 表 4 原式另写（复数 [re, im] 手算），与模块互不引用；
// 锚点 = 另用 Python（cmath）按原式独立算出的字面量；零点、栅瓣位置、波束指向由解析条件现算。
// 典型参数（WP5D 风格）：G_E,max = 6.4 dBi，φ3dB = θ3dB = 65°（另测 90°），Am = SLAv = 30 dB，8×8，dH = dV = 0.5λ，
// θetilt 6° / 10°。
//
// 符号约定（由表 4 原式推出、本文件数值验证）：w·v 全同相 ⇔ cosθ = −sinθetilt 且 sinθ·sinφ = cosθetilt·sinφescan，
// 即峰在 θ = 90° + θetilt、φ = φescan——θetilt > 0 为下倾。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const M = require('../utils/terrestrial/m2101.js');
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
const D = 1e-9;
const isErr = (r) => !!(r && typeof r === 'object' && typeof r.error === 'string');
const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
const e2 = (x) => x.toExponential(2);

// 可复现的伪随机（mulberry32）与球面均匀随机方向（θ 自天顶）
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randDir = (r) => [Math.acos(1 - 2 * r()) * DEG, 360 * r() - 180];
const dirVec = (t, p) => [Math.sin(t * RAD) * Math.cos(p * RAD), Math.sin(t * RAD) * Math.sin(p * RAD), Math.cos(t * RAD)];
const angBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * DEG;
// 方位角差（模 360°）：+180° 与 −180° 是同一方向（如天顶经机械倾后落到面板正后上方，y 分量为带符号的 0）
const dAz = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

const EL65 = { GEmax: 6.4, phi3dB: 65, theta3dB: 65, Am: 30, SLAv: 30 };
const EL90 = { GEmax: 6.4, phi3dB: 90, theta3dB: 90, Am: 30, SLAv: 30 };
// 垂直转平点可达的一组：θ3dB = 40°、SLAv = 25 dB（65° / 30 dB 时转平点 |θ − 90°| = 102.8° 落在定义域外）
const EL40 = { GEmax: 5, phi3dB: 65, theta3dB: 40, Am: 30, SLAv: 25 };
const ARR = { NH: 8, NV: 8, dH: 0.5, dV: 0.5 };
const PEAK64 = 10 * lg(64);

// 参考式：表 3
function refElement(th, ph, E) {
  const AH = -Math.min(12 * (ph / E.phi3dB) ** 2, E.Am);
  const AV = -Math.min(12 * ((th - 90) / E.theta3dB) ** 2, E.SLAv);
  return E.GEmax - Math.min(-(AH + AV), E.Am);
}
// 参考式：表 4 逐元复数双重求和（复数用 [re, im]）
function refArrayDb(th, ph, A, et, es) {
  const cexp = (x) => [Math.cos(x), Math.sin(x)];
  const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const t = th * RAD, p = ph * RAD, e = et * RAD, s = es * RAD, k = 1 / Math.sqrt(A.NH * A.NV);
  let S = [0, 0];
  for (let n = 1; n <= A.NV; n++) {
    for (let m = 1; m <= A.NH; m++) {
      const v = cexp(2 * Math.PI * ((n - 1) * A.dV * Math.cos(t) + (m - 1) * A.dH * Math.sin(t) * Math.sin(p)));
      const w = cexp(2 * Math.PI * ((n - 1) * A.dV * Math.sin(e) - (m - 1) * A.dH * Math.cos(e) * Math.sin(s)));
      const wv = cmul([k * w[0], k * w[1]], v);
      S = [S[0] + wv[0], S[1] + wv[1]];
    }
  }
  return 10 * lg(S[0] ** 2 + S[1] ** 2);
}
// 参考式：均匀加权平面阵的 Dirichlet 闭式——两条线阵各自归一化的阵因子之积 × NH·NV
function refDirichletDb(th, ph, A, et, es) {
  const uV = Math.cos(th * RAD) + Math.sin(et * RAD);
  const uH = Math.sin(th * RAD) * Math.sin(ph * RAD) - Math.cos(et * RAD) * Math.sin(es * RAD);
  const af = (N, d, u) => {                     // |Σ_{n=0}^{N−1} e^{j2πn·d·u}|² / N²
    const x = Math.PI * d * u;                   // = ψ/2
    const s = Math.sin(x);
    return Math.abs(s) < 1e-12 ? 1 : (Math.sin(N * x) / (N * s)) ** 2;
  };
  return 10 * lg(A.NH * A.NV * af(A.NV, A.dV, uV) * af(A.NH, A.dH, uH));
}

// ===========================================================================
console.log('=== ① 单元方向图 表 3 ===');
// ===========================================================================

ok('峰值归一：A_E(90°, 0°) = G_E,max（φ3dB = θ3dB = 65° / 90° 两组）', M.elementGain(90, 0, EL65) === 6.4 && M.elementGain(90, 0, EL90) === 6.4);
approx('锚点：A_E(96°, 0°) = 6.4 − 12(6/65)²', M.elementGain(96, 0, EL65), 6.297751479289941, 1e-12);
approx('锚点：A_E(150°, 80°) = 6.4 − 12(80/65)² − 12(60/65)²（未封顶）', M.elementGain(150, 80, EL65), -22.00236686390533, 1e-12);
approx('锚点：A_E(150°, 90°) = 6.4 − Am（总衰减 33.2 dB > Am，封顶）', M.elementGain(150, 90, EL65), -23.6, 1e-12);
{
  let w = 0;
  for (const E of [EL65, EL90, EL40]) for (const t of linspace(0, 180, 181)) for (const p of linspace(-180, 180, 361)) {
    w = Math.max(w, Math.abs(M.elementGain(t, p, E) - refElement(t, p, E)));
  }
  ok('全角域（θ、φ 每 1°，三组参数）对参考式', w < 1e-12, `max|Δ| = ${e2(w)}`);
}
{
  const pb = 65 * Math.sqrt(30 / 12);
  const s = M.elementH(pb + D, 65, 30) - M.elementH(pb - D, 65, 30);
  ok(`A_E,H 转平点 |φ| = φ3dB·√(Am/12) = ${pb.toFixed(3)}°：两侧连续，外侧恰为 −Am，内侧为 −12(φ/φ3dB)²`,
    Math.abs(s) < 1e-6 && M.elementH(pb + 1, 65, 30) === -30 && M.elementH(-(pb + 1), 65, 30) === -30 &&
    Math.abs(M.elementH(pb - 1, 65, 30) + 12 * ((pb - 1) / 65) ** 2) < 1e-12, `Δ = ${e2(s)}`);
  const tb = 40 * Math.sqrt(25 / 12);
  let okV = true;
  for (const t0 of [90 - tb, 90 + tb]) {
    const out = t0 < 90 ? t0 - 1 : t0 + 1, inn = t0 < 90 ? t0 + 1 : t0 - 1;
    okV = okV && Math.abs(M.elementV(t0 + D, 40, 25) - M.elementV(t0 - D, 40, 25)) < 1e-6 &&
      M.elementV(out, 40, 25) === -25 && Math.abs(M.elementV(inn, 40, 25) + 12 * ((inn - 90) / 40) ** 2) < 1e-12;
  }
  ok(`A_E,V 转平点 |θ − 90°| = θ3dB·√(SLAv/12) = ${tb.toFixed(3)}°（θ3dB = 40°、SLAv = 25 dB）：两侧连续，外侧恰为 −SLAv`, okV);
  // 总封顶 min{−(A_E,H + A_E,V), Am} 的等值线：φ = 80° 时 (θ − 90°)² = (Am/12 − (80/65)²)·65²
  const dt = 65 * Math.sqrt(30 / 12 - (80 / 65) ** 2), t0 = 90 + dt;
  const sc = M.elementGain(t0 + D, 80, EL65) - M.elementGain(t0 - D, 80, EL65);
  const inner = 6.4 - 12 * (80 / 65) ** 2 - 12 * ((dt - 1) / 65) ** 2;
  ok(`总封顶等值线（φ = 80°、θ = 90° + ${dt.toFixed(3)}°）两侧连续；外侧恰为 G_E,max − Am，内侧为 G_E,max + A_E,H + A_E,V`,
    Math.abs(sc) < 1e-6 && M.elementGain(t0 + 1, 80, EL65) === 6.4 - 30 && Math.abs(M.elementGain(t0 - 1, 80, EL65) - inner) < 1e-12,
    `Δ = ${e2(sc)}`);
}
{
  let minEx = Infinity, sym = 0;
  for (const E of [EL65, EL90, EL40]) for (const t of linspace(0, 180, 181)) for (const p of linspace(-180, 180, 181)) {
    const a = M.elementGain(t, p, E);
    minEx = Math.min(minEx, a - (E.GEmax - E.Am));
    sym = Math.max(sym, Math.abs(a - M.elementGain(t, -p, E)), Math.abs(a - M.elementGain(180 - t, p, E)));
  }
  ok('底板 A_E ≥ G_E,max − Am（全网格）', minEx >= -1e-12, `min = ${minEx.toFixed(6)}`);
  ok('对称 A_E(θ, φ) = A_E(θ, −φ) = A_E(180° − θ, φ)', sym < 1e-12, `max|Δ| = ${e2(sym)}`);
  const ph = linspace(0, 180, 18001), th = linspace(90, 180, 9001);
  let mono = true;
  for (const E of [EL65, EL90, EL40]) {
    for (let i = 1; i < ph.length; i++) if (M.elementGain(90, ph[i], E) > M.elementGain(90, ph[i - 1], E) + 1e-12) mono = false;
    for (let i = 1; i < th.length; i++) if (M.elementGain(th[i], 0, E) > M.elementGain(th[i - 1], 0, E) + 1e-12) mono = false;
  }
  ok('单调：A_E(90°, φ) 随 |φ| 非增、A_E(θ, 0°) 随 |θ − 90°| 非增', mono);
}
ok('φ 折回：A_E(90°, 540°) = A_E(90°, 180°)', M.elementGain(90, 540, EL65) === M.elementGain(90, 180, EL65));
ok('非法输入一律 { error }：θ = 181° / φ3dB = 0 / Am < 0 / GEmax 非数 / elementH 的 φ3dB = 0 / elementV 的 θ = 200°',
  isErr(M.elementGain(181, 0, EL65)) && isErr(M.elementGain(90, 0, { ...EL65, phi3dB: 0 })) &&
  isErr(M.elementGain(90, 0, { ...EL65, Am: -1 })) && isErr(M.elementGain(90, 0, { ...EL65, GEmax: 'x' })) &&
  isErr(M.elementH(10, 0, 30)) && isErr(M.elementV(200, 65, 30)));

// ===========================================================================
console.log('\n=== ② 阵因子 / 合成方向图 表 4 ===');
// ===========================================================================

{
  const cfg = { ...EL65, ...ARR };
  approx('面板法向、不转向：阵因子 = 10lg(NH·NV) = 10lg64（快算）', M.arrayFactorDb(90, 0, cfg), PEAK64, 1e-12);
  approx('同上（逐元求和）', M.arrayFactorDb(90, 0, cfg, 'brute'), PEAK64, 1e-12);
  approx('合成峰值 = G_E,max + 10lg64（锚点）', M.compositeGain(90, 0, cfg), 24.461799739838874, 1e-12);
}
{
  let worst = 0, n = 0;
  for (const E of [EL65, EL90]) {
    for (const [et, es] of [[6, 0], [10, 0], [10, 30], [-5, -45], [6, 20], [0, 60], [15, -10]]) {
      const cfg = { ...E, ...ARR, etiltDeg: et, escanDeg: es };
      const t0 = 90 + et, p0 = es;
      worst = Math.max(worst, Math.abs(M.compositeGain(t0, p0, cfg) - (refElement(t0, p0, E) + PEAK64)),
        Math.abs(M.arrayFactorDb(t0, p0, cfg, 'brute') - PEAK64));
      n++;
    }
  }
  ok(`波束正指 (θ, φ) = (90° + θetilt, φescan)：合成 = A_E(θ0, φ0) + 10lg(NH·NV)（${n} 组：7 个波束 × 两种单元）`, worst < 1e-9, `max|Δ| = ${e2(worst)}`);
  const anc = [[100, 0, 10, 0, 24.17777607119982], [96, 0, 6, 0, 24.35955121912881], [100, 30, 10, 30, 21.62156305344834]];
  const ad = anc.reduce((m, [t, p, et, es, w]) => Math.max(m, Math.abs(M.compositeGain(t, p, { ...EL65, ...ARR, etiltDeg: et, escanDeg: es }) - w)), 0);
  ok('锚点：θetilt = 10° / 6° 与 (10°, 30°) 三个波束的合成峰值', ad < 1e-9, `max|Δ| = ${e2(ad)}`);
}
{
  // 指向符号：θ 每 0.01° 扫描找阵因子最大值
  const argmax = (xs, f) => xs.reduce((b, x) => { const v = f(x); return v > b.v ? { x, v } : b; }, { x: null, v: -Infinity });
  const ths = linspace(0, 180, 18001);
  for (const et of [6, 10, -8]) {
    const r = argmax(ths, (t) => M.arrayFactorDb(t, 0, { ...ARR, etiltDeg: et }));
    ok(`θetilt = ${et}°：阵因子最大值在 θ = 90° + θetilt = ${90 + et}°${et > 0 ? '（面板法向以下，即下倾）' : ''}`,
      Math.abs(r.x - (90 + et)) < 0.006 && Math.abs(r.v - PEAK64) < 1e-6, `argmax = ${r.x.toFixed(2)}°`);
  }
  const r = argmax(linspace(-90, 90, 18001), (p) => M.arrayFactorDb(100, p, { ...ARR, etiltDeg: 10, escanDeg: 30 }));
  ok('φescan = 30°（θetilt = 10°）：θ = 100° 上沿 φ 扫描，最大值在 φ = 30°', Math.abs(r.x - 30) < 0.006, `argmax = ${r.x.toFixed(2)}°`);
  const s = M.steeringFor(100, 20);
  ok('steeringFor(100°, 20°) = { θetilt: 10°, φescan: 20° }，该波束在 (100°, 20°) 的阵因子 = 10lg64',
    s.etiltDeg === 10 && s.escanDeg === 20 && Math.abs(M.arrayFactorDb(100, 20, { ...ARR, ...s }) - PEAK64) < 1e-9);
  const aas0 = M.makeAas({ ...EL65, ...ARR });
  ok('steeringFor 的波束、只有 { etiltDeg, escanDeg } 的普通对象都可直接传给 makeAas 的方法；坏波束返回 { error }',
    Math.abs(aas0.arrayFactorDb(100, 20, s) - PEAK64) < 1e-9 &&
    Math.abs(aas0.gain(100, 20, { etiltDeg: 10, escanDeg: 20 }) - (refElement(100, 20, EL65) + PEAK64)) < 1e-9 &&
    isErr(aas0.gain(100, 20, { etiltDeg: 'x', escanDeg: 0 })) && isErr(aas0.gain(100, 20, M.steeringFor(190, 0))));
}
{
  // 三方对拍：模块快算 / 模块逐元 / 本文件参考式（逐元复数）/ Python 锚点
  const anc = [[120, 30, 10, 0, -12.128820626078546], [70, -40, 6, 20, -22.146655565682124]];
  for (const [t, p, et, es, w] of anc) {
    const cfg = { ...ARR, etiltDeg: et, escanDeg: es };
    const c = M.arrayFactorDb(t, p, cfg), b = M.arrayFactorDb(t, p, cfg, 'brute'), rf = refArrayDb(t, p, ARR, et, es);
    ok(`锚点 (${t}°, ${p}°)、θetilt = ${et}°、φescan = ${es}°：快算 / 逐元 / 参考式 = ${w.toFixed(4)} dB`,
      Math.abs(c - w) < 1e-9 && Math.abs(b - w) < 1e-9 && Math.abs(rf - w) < 1e-9);
  }
  const r = rng(7);
  let wd = 0, deep = 0;
  for (let i = 0; i < 2000; i++) {
    const [t, p] = randDir(r), et = -15 + 30 * r(), es = -60 + 120 * r();
    const rf = refArrayDb(t, p, ARR, et, es);
    if (rf < PEAK64 - 100) { deep++; continue; }
    wd = Math.max(wd, Math.abs(M.arrayFactorDb(t, p, { ...ARR, etiltDeg: et, escanDeg: es }) - rf));
  }
  ok('快算 vs 本文件参考式（逐元复数双重求和）：2000 个随机方向 × 随机波束 ≤ 1e-9 dB', wd <= 1e-9, `max|Δ| = ${e2(wd)} dB，深零点跳过 ${deep}`);
}
{
  for (const [et, es] of [[0, 0], [10, 0], [6, 25]]) {
    const cfg = { ...ARR, etiltDeg: et, escanDeg: es };
    let w = 0, n = 0;
    for (const t of linspace(0, 180, 361)) for (const p of linspace(-180, 180, 361)) {
      const rf = refDirichletDb(t, p, ARR, et, es);
      if (rf < PEAK64 - 100) continue;      // 网格恰落在零点上（如 sin30°·sin30° = 1/4）的点，dB 无意义
      w = Math.max(w, Math.abs(M.arrayFactorDb(t, p, cfg) - rf), Math.abs(M.arrayFactorDb(t, p, cfg, 'brute') - rf));
      n++;
    }
    ok(`均匀阵 Dirichlet 闭式（θetilt = ${et}°、φescan = ${es}°）：${n} 个网格点，快算与逐元都一致`, w < 1e-9, `max|Δ| = ${e2(w)} dB`);
  }
}
{
  // 快算 vs 逐元：随机方向 × 随机波束。两种算法在双精度下的相对误差都随零点深度放大（相位舍入 ~1e-16 rad 在
  // |ΣΣ| → 0 处被除以一个小数），故 1e-9 dB 的判据用于阵因子在峰值以下 100 dB 以内的方向（占绝大多数），
  // 更深零点附近的方向改比线性功率的绝对误差（相对峰值功率 ≤ 1e-13）。
  const r = rng(20260917);
  for (const A of [{ NH: 8, NV: 8, dH: 0.5, dV: 0.5 }, { NH: 16, NV: 8, dH: 0.5, dV: 0.7 }, { NH: 4, NV: 12, dH: 0.6, dV: 0.9 }]) {
    const peak = 10 * lg(A.NH * A.NV);
    const N = 5000;
    let wDb = 0, wLin = 0, deep = 0;
    for (let i = 0; i < N; i++) {
      const [t, p] = randDir(r);
      const cfg = { ...A, etiltDeg: -15 + 30 * r(), escanDeg: -60 + 120 * r() };
      const c = M.arrayFactorDb(t, p, cfg), b = M.arrayFactorDb(t, p, cfg, 'brute');
      wLin = Math.max(wLin, Math.abs(10 ** (c / 10) - 10 ** (b / 10)) / (A.NH * A.NV));
      if (b < peak - 100) { deep++; continue; }
      wDb = Math.max(wDb, Math.abs(c - b));
    }
    ok(`快算（可分离 Dirichlet）= 逐元双重求和：${A.NV} 行 × ${A.NH} 列、dV = ${A.dV}λ、dH = ${A.dH}λ，${N} 个随机方向 ≤ 1e-9 dB`,
      wDb <= 1e-9, `max|Δ| = ${e2(wDb)} dB（峰值以下 100 dB 外 ${deep} 点）`);
    ok('  同上，全部方向的线性功率绝对差 ≤ 1e-13 × NH·NV', wLin <= 1e-13, `max = ${e2(wLin)}`);
  }
}
{
  // 栅瓣：只看面板前半球（|φ| ≤ 90°）——平面阵阵因子对 φ ↔ 180° − φ 前后对称，背面镜像靠单元方向图压下去，不算栅瓣。
  // λ/2：ψV = π(cosθ + sinθetilt)、ψH = π(sinθ·sinφ − cosθetilt·sinφescan)，|ψ| < 2π ⇒ 前半球只有主瓣一个同相点。
  for (const [et, es] of [[10, 0], [6, 30]]) {
    const cfg = { ...ARR, etiltDeg: et, escanDeg: es };
    const u0 = dirVec(90 + et, es);
    let maxOut = -Infinity, at = null;
    for (const t of linspace(0, 180, 361)) for (const p of linspace(-90, 90, 361)) {
      if (angBetween(dirVec(t, p), u0) < 30) continue;
      const v = M.arrayFactorDb(t, p, cfg);
      if (v > maxOut) { maxOut = v; at = [t, p]; }
    }
    ok(`dH = dV = 0.5λ、θetilt = ${et}°、φescan = ${es}°：前半球主瓣 30° 锥外阵因子 ≤ 峰值 − 12 dB（无栅瓣）`,
      maxOut <= PEAK64 - 12, `锥外最大 ${(maxOut - PEAK64).toFixed(2)} dB @ (${at[0]}°, ${at[1]}°)`);
  }
  // 对照：dV = 1λ、θetilt = 10° ⇒ 栅瓣在 cosθ = 1 − sin10°（ψV = 2π），远离主瓣 65.7°，高度与主瓣相同
  const tg = Math.acos(1 - Math.sin(10 * RAD)) * DEG;
  const g1 = M.arrayFactorDb(tg, 0, { NH: 8, NV: 8, dH: 0.5, dV: 1.0, etiltDeg: 10 });
  ok(`对照 dV = 1λ、θetilt = 10°：θ = arccos(1 − sin10°) = ${tg.toFixed(3)}° 处出现与主瓣等高的栅瓣`, Math.abs(g1 - PEAK64) < 1e-9,
    `${g1.toFixed(6)} dB`);
  const pg = Math.asin(Math.sin(30 * RAD) - 1) * DEG;
  const g2 = M.arrayFactorDb(90, pg, { NH: 8, NV: 8, dH: 1.0, dV: 0.5, escanDeg: 30 });
  ok(`对照 dH = 1λ、φescan = 30°：φ = arcsin(sin30° − 1) = ${pg.toFixed(1)}° 处出现与主瓣等高的栅瓣`, Math.abs(g2 - PEAK64) < 1e-9);
}
{
  // 零点：8 元 λ/2 线阵 NV·ψV/2 = kπ ⇒ cosθ + sinθetilt = 2k/NV；水平同理 sinθ·sinφ − cosθetilt·sinφescan = 2k/NH
  const cfg = { ...ARR };
  const ths = [1, 2, 3, -1, -2, -3].map((k) => Math.acos(k / 4) * DEG);
  const wc = Math.max(...ths.map((t) => M.arrayFactorDb(t, 0, cfg))), wb = Math.max(...ths.map((t) => M.arrayFactorDb(t, 0, cfg, 'brute')));
  ok(`8 元 λ/2 垂直阵零点 θ = arccos(k/4)（${ths.map((t) => t.toFixed(2)).join(' / ')}°）：阵因子 < −100 dB（快算 / 逐元）`,
    wc < -100 && wb < -100, `${wc.toFixed(1)} / ${wb.toFixed(1)} dB`);
  const phs = [1, 2, 3, -1, -2, -3].map((k) => Math.asin(k / 4) * DEG);
  const wh = Math.max(...phs.map((p) => M.arrayFactorDb(90, p, cfg)));
  ok(`8 元 λ/2 水平阵零点 φ = arcsin(k/4)（θ = 90°）：阵因子 < −100 dB`, wh < -100, `${wh.toFixed(1)} dB`);
  const s10 = Math.sin(10 * RAD);
  const tz = [-3, -2, -1, 1, 2, 3].map((k) => k / 4 - s10).filter((c) => Math.abs(c) <= 1).map((c) => Math.acos(c) * DEG);
  const wt = Math.max(...tz.map((t) => M.arrayFactorDb(t, 0, { ...ARR, etiltDeg: 10 })));
  ok(`转向 θetilt = 10°：零点随之平移到 cosθ = k/4 − sin10°（${tz.length} 个）`, wt < -100, `${wt.toFixed(1)} dB`);
  // 相邻零点的中点不为零：零点是孤立的
  const mids = ths.slice(0, 3).map((t, i, a) => (i ? (t + a[i - 1]) / 2 : null)).filter((x) => x != null);
  ok('相邻零点之间（中点）阵因子 > −30 dB（零点孤立，不是整片塌掉）', mids.every((t) => M.arrayFactorDb(t, 0, cfg) > -30));
}
{
  approx('16 列 × 8 行：波束正指处阵因子 = 10lg128', M.arrayFactorDb(96, 20, { NH: 16, NV: 8, dH: 0.5, dV: 0.5, etiltDeg: 6, escanDeg: 20 }), 10 * lg(128), 1e-9);
  const one = { ...EL65, NH: 1, NV: 1, dH: 0.5, dV: 0.5, etiltDeg: 7, escanDeg: 12 };
  ok('1×1 退化：阵因子恒 0 dB，合成 = 单元', [[90, 0], [30, 120], [170, -60]].every(([t, p]) =>
    M.arrayFactorDb(t, p, one) === 0 && M.compositeGain(t, p, one) === M.elementGain(t, p, EL65)));
  ok('非法输入一律 { error }：NH = 0 / NV = 2.5 / dV ≤ 0 / θ = 181° / method 不认',
    isErr(M.arrayFactorDb(90, 0, { ...ARR, NH: 0 })) && isErr(M.arrayFactorDb(90, 0, { ...ARR, NV: 2.5 })) &&
    isErr(M.arrayFactorDb(90, 0, { ...ARR, dV: 0 })) && isErr(M.arrayFactorDb(181, 0, ARR)) &&
    isErr(M.arrayFactorDb(90, 0, ARR, 'fft')) && isErr(M.makeAas({ ...EL65, ...ARR, NH: -1 })));
}

// ===========================================================================
console.log('\n=== ③ 机械下倾（表 4「Down-tilt angle」，绕面板水平 y 轴）===');
// ===========================================================================

// 独立做法：Rodrigues 公式把全局坐标系三根轴绕 +y 转 β（x 轴尖压向 −z），再取投影（θ 自天顶）
function rodrigues(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const kxv = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [0, 1, 2].map((i) => v[i] * c + kxv[i] * s + k[i] * kv * (1 - c));
}
function refPanel(t, p, b) {
  const Y = [0, 1, 0];
  const xa = rodrigues([1, 0, 0], Y, b * RAD), ya = rodrigues([0, 1, 0], Y, b * RAD), za = rodrigues([0, 0, 1], Y, b * RAD);
  const u = dirVec(t, p);
  const d = (a) => a[0] * u[0] + a[1] * u[1] + a[2] * u[2];
  const x = d(xa), y = d(ya), z = d(za);
  return { theta: Math.atan2(Math.hypot(x, y), z) * DEG, phi: Math.atan2(y, x) * DEG, axis: Math.hypot(x, y) < 1e-9 };
}
{
  const ths = linspace(0, 180, 37), phs = linspace(-175, 175, 71);
  let id = 0, rt = 0, dF = 0, dR = 0, nAxis = 0;
  for (const t of ths) for (const p of phs) {
    const z0 = M.globalToPanel(t, p, 0);
    id = Math.max(id, Math.abs(z0.thetaDeg - t), t > 0 && t < 180 ? dAz(z0.phiDeg, p) : 0);
    for (const b of [6, 10, -3, 30]) {
      const q = M.globalToPanel(t, p, b);
      const back = M.panelToGlobal(q.thetaDeg, q.phiDeg, b);
      rt = Math.max(rt, Math.abs(back.thetaDeg - t), t > 0 && t < 180 ? dAz(back.phiDeg, p) : 0);
      const R = refPanel(t, p, b);
      const f = F.tiltToAntennaFrame(90 - t, p, b);      // F.1336 口径：仰角 = 90° − 天顶角
      dF = Math.max(dF, Math.abs(q.thetaDeg - (90 - f.thetaDeg)));
      dR = Math.max(dR, Math.abs(q.thetaDeg - R.theta));
      if (R.axis) { nAxis++; continue; }                  // 正对面板 z 轴：φ 无定义
      dF = Math.max(dF, dAz(q.phiDeg, f.phiDeg));
      dR = Math.max(dR, dAz(q.phiDeg, R.phi));
    }
  }
  ok('β = 0 恒等：globalToPanel(θ, φ, 0) = (θ, φ)', id < 1e-12, `max|Δ| = ${e2(id)}°`);
  ok('往返：panelToGlobal(globalToPanel(θ, φ, β), β) = (θ, φ)（β = 6° / 10° / −3° / 30°）', rt < 1e-9, `max|Δ| = ${e2(rt)}°`);
  ok('与 F.1336-5 式 (3b)(3c)（tiltToAntennaFrame，θ_F = 90° − θ）同一变换', dF < 1e-9, `max|Δ| = ${e2(dF)}°，正对 z 轴 ${nAxis} 点只比 θ`);
  ok('与独立 Rodrigues 旋转一致', dR < 1e-9, `max|Δ| = ${e2(dR)}°`);
  const bs = M.panelToGlobal(90, 0, 6), bp = M.globalToPanel(96, 0, 6);
  ok('面板法向 (90°, 0°) 在全局里是 (90° + β, 0°)：β = 6° → θ = 96°（水平面以下 6°）',
    Math.abs(bs.thetaDeg - 96) < 1e-12 && Math.abs(bs.phiDeg) < 1e-12 && Math.abs(bp.thetaDeg - 90) < 1e-12 && Math.abs(bp.phiDeg) < 1e-12);
}
{
  const aas = M.makeAas({ ...EL65, ...ARR, mechTiltDeg: 6 });
  ok('机械下倾 6°、不转向：全局 (96°, 0°) = G_E,max + 10lg64 = peakGainDb', Math.abs(aas.gain(96, 0) - (6.4 + PEAK64)) < 1e-9 &&
    Math.abs(aas.peakGainDb - (6.4 + PEAK64)) < 1e-12);
  const aDef = M.makeAas({ ...EL65, ...ARR, etiltDeg: 10, escanDeg: 15 });
  ok('缺省波束：makeAas 给 θetilt = 10°、φescan = 15° 时 gain(100°, 15°) 不传 beam 即正指', Math.abs(aDef.arrayFactorDb(100, 15) - PEAK64) < 1e-9);
  let worst = 0, local = true;
  for (const [t, p] of [[100, 20], [110, -35], [92, 50], [80, 0], [125, 10]]) {
    const b = aas.beamTo(t, p);
    const q = aas.toPanel(t, p);
    worst = Math.max(worst, Math.abs(aas.gain(t, p, b) - (refElement(q.thetaDeg, q.phiDeg, EL65) + PEAK64)));
    const af0 = aas.arrayFactorDb(t, p, b);
    for (const [dt, dp] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) if (!(aas.arrayFactorDb(t + dt, p + dp, b) < af0)) local = false;
  }
  ok('beamTo(全局目标)：目标处合成 = A_E(面板坐标) + 10lg64（5 个目标，含面板法向以上的 80°）', worst < 1e-9, `max|Δ| = ${e2(worst)}`);
  ok('beamTo：目标是阵因子的局部极大（±0.5° 四邻都更低）', local);
  const b4 = aas.beam(4, 0);
  const r = linspace(80, 120, 4001).reduce((acc, t) => { const v = aas.arrayFactorDb(t, 0, b4); return v > acc.v ? { t, v } : acc; }, { t: null, v: -Infinity });
  ok('机械 6° + θetilt 4°：全局峰在 θ = 100°（同一竖直面内，角度直接相加）', Math.abs(r.t - 100) < 0.006, `argmax = ${r.t.toFixed(2)}°`);
  let de = 0;
  for (const t of linspace(0, 180, 61)) for (const p of linspace(-180, 180, 61)) {
    const q = aas.toPanel(t, p);
    de = Math.max(de, Math.abs(aas.elementGain(t, p) - refElement(q.thetaDeg, q.phiDeg, EL65)));
  }
  ok('elementGain（非相关发射口径）= 单元方向图在面板坐标取值', de < 1e-12, `max|Δ| = ${e2(de)}`);
  const rr = rng(99);
  let wd = 0;
  for (let i = 0; i < 2000; i++) {
    const [t, p] = randDir(rr);
    const b = aas.beam(-10 + 20 * rr(), -60 + 120 * rr());
    const br = aas.arrayFactorDb(t, p, b, 'brute');
    if (br < PEAK64 - 100) continue;
    wd = Math.max(wd, Math.abs(aas.arrayFactorDb(t, p, b) - br));
  }
  ok('倾斜面板上快算 = 逐元求和（2000 个随机方向 × 随机波束）≤ 1e-9 dB', wd <= 1e-9, `max|Δ| = ${e2(wd)} dB`);
  ok('非法输入一律 { error }：机械下倾 90° / θ = −1° / beamTo 越界',
    isErr(M.makeAas({ ...EL65, ...ARR, mechTiltDeg: 90 })) && isErr(aas.gain(-1, 0)) && isErr(aas.beamTo(200, 0)) &&
    isErr(M.globalToPanel(90, 0, 95)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
