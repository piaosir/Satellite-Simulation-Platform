// 干扰分析（C/I）引擎测试（无框架，纯断言）。
//   运行： node packages/core/test/interference.test.mjs
//
// 三层：
//   ① 几何 —— 拓扑角对解析解、仰角/斜距/FSL 对已知量；
//   ② 方向图 —— S.1428-1 逐段边界连续性与官方原文的关键系数、AP8 与引擎逐位一致、S.524 掩模形状；
//   ③ C/ASI —— 下行逐项可手算、上行三模式的量级关系、ΔT/T 的物理自洽。
//
// 本文件里的期望值凡带「解析」二字的，都是由独立公式在测试里现算的，不是把实现的输出抄回来当基准。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const G = require('../utils/interference/geometry.js');
const P = require('../utils/interference/patterns.js');
const A = require('../utils/interference/ciAsi.js');

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

const BJ = { lon: 116.4074, lat: 39.9042, alt: 0 };
const GZ = { lon: 113.26, lat: 23.13, alt: 0 };

console.log('=== ① 几何 ===');

// 拓扑角严格解析解（站在赤道、期望星正下方）：
//   站 → 期望星 矢量 = (r − Re, 0, 0)
//   站 → 干扰星 矢量 = (r·cosΔλ − Re, r·sinΔλ, 0)
//   ⇒ cosθ = (r·cosΔλ − Re) / √(r² + Re² − 2·r·Re·cosΔλ)
// 注意不能按等腰三角形近似（即假设站到两星等距）——干扰星斜距略大，那样会偏 0.3 mdeg。
{
  const r = G.GSO_RADIUS_KM, Re = 6378.137;      // 赤道、alt=0 处 WGS84 地心距 = 长半轴
  const dLon = 2.5 * G.DEG;
  const cosT = (r * Math.cos(dLon) - Re) / Math.sqrt(r * r + Re * Re - 2 * r * Re * Math.cos(dLon));
  const want = Math.acos(cosT) * G.RAD;
  const got = G.gsoSeparation({ lon: 110.5, lat: 0, alt: 0 }, 110.5, 113).thetaDeg;
  approx('星下点拓扑角 = 严格解析解', got, want, 1e-9);
}

// 拓扑角恒 > 经度差，且纬度越高放大越小
{
  const bj = G.gsoSeparation(BJ, 110.5, 113);
  const gz = G.gsoSeparation(GZ, 110.5, 113);
  const sub = G.gsoSeparation({ lon: 110.5, lat: 0, alt: 0 }, 110.5, 113);
  ok('拓扑角 > 经度差', bj.thetaDeg > bj.lonDiffDeg, `${bj.thetaDeg.toFixed(4)} > ${bj.lonDiffDeg}`);
  ok('放大倍率 星下点 > 广州 > 北京', sub.thetaDeg > gz.thetaDeg && gz.thetaDeg > bj.thetaDeg,
    `${sub.thetaDeg.toFixed(4)} > ${gz.thetaDeg.toFixed(4)} > ${bj.thetaDeg.toFixed(4)}`);
  ok('星下点放大倍率 ≈ r/(r−Re) = 1.1782', Math.abs(sub.thetaDeg / sub.lonDiffDeg - 1.1782) < 2e-3,
    `${(sub.thetaDeg / sub.lonDiffDeg).toFixed(5)}`);
}

// 对称性：干扰星在期望星东侧 / 西侧，同经度差应给出近乎相同的拓扑角
{
  const e = G.gsoSeparation(BJ, 110.5, 113).thetaDeg;
  const w = G.gsoSeparation(BJ, 110.5, 108).thetaDeg;
  ok('东西对称（同经度差）', Math.abs(e - w) < 0.01, `东 ${e.toFixed(4)} / 西 ${w.toFixed(4)}`);
}

// 仰角/斜距：站在星下点 → 仰角 90°、斜距 = r − Re
{
  const lk = G.lookAngles({ lon: 110.5, lat: 0, alt: 0 }, G.gsoEcef(110.5));
  approx('星下点仰角 = 90°', lk.elevDeg, 90, 1e-6);
  approx('星下点斜距 = r − Re', lk.rangeKm, G.GSO_RADIUS_KM - 6378.137, 1e-3);
}
{
  const lk = G.lookAngles(BJ, G.gsoEcef(110.5));
  ok('北京→110.5°E 仰角在 40–47°', lk.elevDeg > 40 && lk.elevDeg < 47, lk.elevDeg.toFixed(3) + '°');
  ok('北京→110.5°E 方位偏南偏西', lk.azDeg > 180 && lk.azDeg < 200, lk.azDeg.toFixed(3) + '°');
}

// FSL 解析：20lg(d) + 20lg(f) + 92.44778
approx('FSL 解析核对', G.fsl(38000, 12.5), 20 * Math.log10(38000) + 20 * Math.log10(12.5) + 92.44778322, 1e-9);

// 地平线以下的干扰星必须被标记不可见
{
  const s = G.gsoSeparation(BJ, 110.5, -60);     // 大西洋上空，北京看不见
  ok('地平线以下的干扰星标记 visible=false', s.visible === false, `仰角 ${s.interferer.elevDeg.toFixed(2)}°`);
}

console.log('\n=== ② 方向图 ===');

// AP8 必须与链路预算引擎逐位一致（同一副天线在两处显示的旁瓣增益不能不同）
{
  const engine = require('../utils/linkCalculator.js');
  // 引擎未导出该函数 → 用引擎出参里的「接收旁瓣增益」交叉验证：rxSidelobeGainResult = Gmax − ISO = G(φ)
  // 这里退而用同结构的独立复算：AP8 的三档分支各取一个点，与手写公式比对
  const lam = A.lambdaOf(12.5);
  // 大天线档 D/λ ≥ 100
  const D1 = 4.5, r1 = D1 / lam;
  ok('AP8 大天线档 D/λ ≥ 100', r1 >= 100, `D/λ=${r1.toFixed(1)}`);
  approx('AP8 旁瓣段 = 29 − 25lgφ', P.offAxisAP8(D1, lam, 0.65, 3), 29 - 25 * Math.log10(3), 1e-9);
  approx('AP8 远旁瓣 = −10 dBi', P.offAxisAP8(D1, lam, 0.65, 40), -10, 1e-9);
  // 主瓣抛物线
  approx('AP8 主瓣抛物线', P.offAxisAP8(D1, lam, 0.65, 0.1),
    P.peakGainDbi(D1, lam, 0.65) - 0.0025 * Math.pow(r1 * 0.1, 2), 1e-9);
  ok('引擎模块可加载（口径同源检查）', typeof engine.calculateLinkBudget === 'function');
}

// S.1428-1：官方原文关键系数
{
  const lam = A.lambdaOf(12.5);
  // D/λ > 100 档：Gmax = 20lg(D/λ) + 8.4，G1 = −1 + 15lg(D/λ)
  const Dbig = 4.5, rb = Dbig / lam;
  const sb = P.offAxisS1428(Dbig, lam, 1);
  approx('S.1428 大档 Gmax = 20lg(D/λ)+8.4', sb.gmaxRef, 20 * Math.log10(rb) + 8.4, 1e-9);
  approx('S.1428 大档 G1 = −1+15lg(D/λ)', sb.g1, -1 + 15 * Math.log10(rb), 1e-9);
  approx('S.1428 大档 φr = 15.85(D/λ)^−0.6', sb.phiR, 15.85 * Math.pow(rb, -0.6), 1e-9);
  approx('S.1428 大档 10–34.1° 段 = 34 − 30lgφ', P.offAxisS1428(Dbig, lam, 20).gain, 34 - 30 * Math.log10(20), 1e-9);
  approx('S.1428 大档 34.1–80° = −12', P.offAxisS1428(Dbig, lam, 50).gain, -12, 1e-9);
  approx('S.1428 大档 80–120° = −7', P.offAxisS1428(Dbig, lam, 100).gain, -7, 1e-9);
  approx('S.1428 大档 120–180° = −12', P.offAxisS1428(Dbig, lam, 150).gain, -12, 1e-9);

  // 25 < D/λ ≤ 100 档：Gmax 常数是 7.7（与大档的 8.4 不同），远旁瓣 −9/−4/−9
  const Dmid = 1.2, rm = Dmid / lam;
  ok('S.1428 中档 25 < D/λ ≤ 100', rm > 25 && rm <= 100, `D/λ=${rm.toFixed(2)}`);
  const sm = P.offAxisS1428(Dmid, lam, 1);
  approx('S.1428 中档 Gmax = 20lg(D/λ)+7.7', sm.gmaxRef, 20 * Math.log10(rm) + 7.7, 1e-9);
  approx('S.1428 中档 G1 = 29 − 25lg(95λ/D)', sm.g1, 29 - 25 * Math.log10(95 / rm), 1e-9);
  approx('S.1428 中档 33.1–80° = −9', P.offAxisS1428(Dmid, lam, 50).gain, -9, 1e-9);
  approx('S.1428 中档 80–120° = −4', P.offAxisS1428(Dmid, lam, 100).gain, -4, 1e-9);
  approx('S.1428 中档 120–180° = −9', P.offAxisS1428(Dmid, lam, 150).gain, -9, 1e-9);

  // 20 ≤ D/λ ≤ 25 档：远旁瓣末段是 −5（与中档的 −9 不同，易抄错）
  const lamS = A.lambdaOf(11);            // λ≈0.02726 m
  const Dsm = 0.6, rs = Dsm / lamS;
  ok('S.1428 小档 20 ≤ D/λ ≤ 25', rs >= 20 && rs <= 25, `D/λ=${rs.toFixed(2)}`);
  approx('S.1428 小档 >80° = −5（非 −4/−9）', P.offAxisS1428(Dsm, lamS, 120).gain, -5, 1e-9);

  // 适用范围外返回 null（由调用方回退 AP8）
  ok('S.1428 D/λ < 20 返回 null', P.offAxisS1428(0.3, lamS, 5) === null);
  ok('earthStationOffAxis 在 D/λ<20 时回退 AP8',
    P.earthStationOffAxis('average', 0.3, lamS, 0.65, 5) === P.offAxisAP8(0.3, lamS, 0.65, 5));

  // 主瓣→G1 边界连续
  const eps = 1e-7;
  const lft = P.offAxisS1428(Dmid, lam, sm.phiM - eps).gain;
  const rgt = P.offAxisS1428(Dmid, lam, sm.phiM + eps).gain;
  ok('S.1428 φm 处连续', Math.abs(lft - rgt) < 1e-4, `Δ=${(rgt - lft).toExponential(2)}`);
}

// S.1428 与 AP8 的方向性差异：同一副天线，平均包络在旁瓣区应低于峰值包络
{
  const lam = A.lambdaOf(12.5), D = 4.5;
  const peak = P.offAxisAP8(D, lam, 0.65, 20);
  const avg = P.offAxisS1428(D, lam, 20).gain;
  ok('20° 处 S.1428(平均) < AP8(峰值)', avg < peak, `${avg.toFixed(2)} < ${peak.toFixed(2)}`);
}

// S.524 掩模：分段形状 + 连续性 + 频段命中
{
  const ku = P.s524OffAxisEirpDensity(3, 14.25);
  ok('S.524 命中 Ku 频段且标为建议书正文', ku && /rec\.3\.1/.test(ku.band) && ku.refBwHz === 4e4 && ku.authoritative === true, ku && ku.band);
  approx('S.524 Ku 斜段 = 39 − 25lgφ', ku.limitDb, 39 - 25 * Math.log10(3), 1e-9);
  approx('S.524 密度换算 = limit − 10lg(refBW)', ku.densityDbWPerHz, ku.limitDb - 10 * Math.log10(4e4), 1e-9);
  approx('S.524 Ku 平台段(7–9.2°) = 18', P.s524OffAxisEirpDensity(8, 14.25).limitDb, 18, 1e-9);
  approx('S.524 Ku 第二斜段 = 42 − 25lgφ', P.s524OffAxisEirpDensity(20, 14.25).limitDb, 42 - 25 * Math.log10(20), 1e-9);
  approx('S.524 Ku 底板(>48°) = 0', P.s524OffAxisEirpDensity(90, 14.25).limitDb, 0, 1e-9);
  // 钳位段按 A − 25lg(φ0) 构造 → φ0 处连续（与引擎侧 4 kHz 频段的已知分歧见 patterns.js 注释）
  const eps = 1e-7;
  const l = P.s524OffAxisEirpDensity(2.5 - eps, 14.25).limitDb;
  const r = P.s524OffAxisEirpDensity(2.5 + eps, 14.25).limitDb;
  ok('S.524 φ0 处连续', Math.abs(l - r) < 1e-5, `Δ=${(r - l).toExponential(2)}`);
  // 掩模随离轴角基本单调不增，但 φ=7° 处**建议书自身**有约 0.13 dB 的台阶：
  // 斜段在 7° 处是 39−25lg7 = 17.87，而 7°–9.2° 的平台被取整成 18。三个频段同样有这个台阶，
  // 是平台值取整数造成的，不是实现错。故容差放到 0.15 dB，另单独把这个台阶钉住。
  let maxRise = 0, prev = Infinity;
  for (let p = 1; p <= 90; p += 0.5) { const v = P.s524OffAxisEirpDensity(p, 14.25).limitDb; if (v - prev > maxRise) maxRise = v - prev; prev = v; }
  ok('S.524 掩模随 φ 基本单调不增（除 7° 处建议书自身的取整台阶）', maxRise <= 0.15, `最大上跳 ${maxRise.toFixed(4)} dB`);
  for (const [f, A, Pl] of [[6.0, 32, 11], [14.25, 39, 18], [29, 19, -2]]) {
    const atLo = P.s524OffAxisEirpDensity(7, f).limitDb;
    approx(`S.524 ${f}GHz φ=7° 走斜段 A−25lg7`, atLo, A - 25 * Math.log10(7), 1e-9);
    approx(`S.524 ${f}GHz φ=7.5° 走平台`, P.s524OffAxisEirpDensity(7.5, f).limitDb, Pl, 1e-9);
    ok(`S.524 ${f}GHz 7° 台阶 ≈ 0.13 dB（建议书取整所致）`, Math.abs((Pl - atLo) - 0.13) < 0.01, `${(Pl - atLo).toFixed(4)} dB`);
  }
  ok('S.524 频段外走兜底并标记', P.s524OffAxisEirpDensity(22, 22).fallback === true);

  // ★ 统一后的权威值（ITU-R S.524-9 正文逐条核对）
  {
    const chk = (f, phi, want, bw, auth) => {
      const r = P.s524OffAxisEirpDensity(phi, f);
      approx(`S.524 ${f}GHz φ=${phi}° = ${want}`, r.limitDb, want, 1e-9);
      ok(`S.524 ${f}GHz 参考带宽 ${bw}`, r.refBwHz === bw);
      ok(`S.524 ${f}GHz 权威标记 ${auth}`, r.authoritative === auth);
    };
    // recommends 2：C 5.725–7.075 GHz，32/11/35/−7 @4kHz —— 引擎旧值 26/5/29 低 6 dB，已订正
    chk(6.0, 5, 32 - 25 * Math.log10(5), 4e3, true);
    chk(6.0, 8, 11, 4e3, true);
    chk(6.0, 20, 35 - 25 * Math.log10(20), 4e3, true);
    chk(6.0, 60, -7, 4e3, true);
    // recommends 3.1：Ku 12.75–13.25 与 13.75–14.5 GHz，39/18/42/0 @40kHz
    chk(14.25, 5, 39 - 25 * Math.log10(5), 4e4, true);
    chk(13.0, 5, 39 - 25 * Math.log10(5), 4e4, true);
    chk(14.25, 60, 0, 4e4, true);
    // recommends 4：Ka 27.5–30 GHz，19/−2/22/−10 @40kHz，φ₀=2.0
    chk(29, 5, 19 - 25 * Math.log10(5), 4e4, true);
    chk(29, 60, -10, 4e4, true);
    ok('S.524 Ka 的 φ₀ 是 2.0°（其余是 2.5°）', P.s524OffAxisEirpDensity(3, 29).phi0 === 2.0 && P.s524OffAxisEirpDensity(3, 14.25).phi0 === 2.5);
    // 建议书未覆盖的频段必须标 authoritative=false，不得冒充 S.524
    for (const f of [8.0, 11.0, 17.8, 43.0, 48.0, 5.15]) {
      ok(`S.524 未覆盖的 ${f}GHz 标为外推`, P.s524OffAxisEirpDensity(5, f).authoritative === false, P.s524OffAxisEirpDensity(5, f).band);
    }
    // φ < φ₀：建议书在主瓣内不设限 → 置 belowScope 并按 φ₀ 处连续钳住
    const below = P.s524OffAxisEirpDensity(1.0, 14.25);
    ok('φ < φ₀ 置 belowScope', below.belowScope === true);
    approx('φ < φ₀ 按 φ₀ 处连续钳住', below.limitDb, 39 - 25 * Math.log10(2.5), 1e-9);
  }

  // 两个链路预算引擎必须与本表同源（统一后不得再各存一份）
  {
    const eng = require('../utils/linkCalculator.js');
    const engN = require('../utils/linkCalculatorNGSO.js');
    ok('GSO 引擎已改为共用 patterns.js 的掩模', /interference\/patterns/.test(require('fs').readFileSync(new URL('../utils/linkCalculator.js', import.meta.url), 'utf8')));
    ok('NGSO 引擎已改为共用 patterns.js 的掩模', /interference\/patterns/.test(require('fs').readFileSync(new URL('../utils/linkCalculatorNGSO.js', import.meta.url), 'utf8')));
    ok('两个引擎均可正常加载', typeof eng.calculateLinkBudget === 'function' && typeof engN.calculateLinkBudget === 'function');
  }
}

console.log('\n=== ③ C/ASI ===');

const RX = { diameterM: 4.5, efficiency: 0.65, freqGHz: 12.5 };
const TX = { diameterM: 4.5, efficiency: 0.65, freqGHz: 14.25, powerW: 40, feederLossDb: 3.5, bandwidthHz: 36e6 };

// 下行：逐项可手算
{
  const r = A.downlinkCAsi({
    station: BJ,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
    rx: RX,
    interferers: [{ id: 's1', name: 'A', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'H' }]
  });
  const s = r.sources[0];
  const wd = r.geometry.wantedDensityDbWPerHz;
  approx('下行 期望谱密度 = EIRP − 10lg(B)', wd, 50 - 10 * Math.log10(36e6), 1e-9);
  approx('下行 单源 C/I 逐项可手算', s.ciDb,
    (wd - (-45)) + s.discrimDb + s.pathDeltaDb + s.polDb - s.overlapDb, 1e-9);
  approx('下行 单源时 合成 = 单源', r.ciDb, s.ciDb, 1e-9);
  approx('下行 鉴别度 = Gmax − G(θ)', s.discrimDb, r.geometry.peakGainDbi - s.offAxisGainDbi, 1e-9);
}

// 多源必须线性域功率相加：两个等强源 → 恰好比单源差 3.0103 dB
{
  const mk = (n) => A.downlinkCAsi({
    station: BJ, rx: RX,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
    interferers: Array.from({ length: n }, (_, i) => ({ id: 'x' + i, lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'H' }))
  }).ciDb;
  approx('两个等强干扰源 = 单源 − 3.0103 dB', mk(2), mk(1) - 10 * Math.log10(2), 1e-9);
  approx('四个等强干扰源 = 单源 − 6.0206 dB', mk(4), mk(1) - 10 * Math.log10(4), 1e-9);
}

// 极化：反极化必须比同极化好出恰好一个 XPD
{
  const mk = (pol, xpd) => A.downlinkCAsi({
    station: BJ, rx: RX,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
    interferers: [{ id: 'a', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: pol, xpdDb: xpd }]
  }).ciDb;
  approx('反极化 C/ASI = 同极化 + XPD', mk('V', 25), mk('H') + 25, 1e-9);
  approx('极化折减默认 25 dB', mk('V'), mk('H') + A.DEFAULT_XPD_DB, 1e-9);
  const off = A.downlinkCAsi({
    station: BJ, rx: RX, applyPolarization: false,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
    interferers: [{ id: 'a', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'V' }]
  }).ciDb;
  approx('关闭极化折减后回到同极化值', off, mk('H'), 1e-9);
}

// 线/圆混用只给 3 dB，并告警
{
  const r = A.downlinkCAsi({
    station: BJ, rx: RX,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
    interferers: [{ id: 'a', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'R' }]
  });
  approx('线/圆混用极化折减 = 3 dB', r.sources[0].polDb, 3, 1e-9);
  ok('线/圆混用给出告警', r.warnings.some((w) => w.includes('极化')));
}

// 轨位越远 C/ASI 越好（单调性）
{
  const at = (lon) => A.downlinkCAsi({
    station: BJ, rx: RX,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
    interferers: [{ id: 'a', lonDeg: lon, eirpDensityDbWPerHz: -45, polarization: 'H' }]
  }).ciDb;
  const seq = [111.5, 112, 113, 115, 120].map(at);
  let mono = true;
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) mono = false;
  ok('C/ASI 随轨位间隔单调改善', mono, seq.map((v) => v.toFixed(1)).join(' → '));
}

// 地平线以下的干扰星必须被剔除、不进合成
{
  const r = A.downlinkCAsi({
    station: BJ, rx: RX,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
    interferers: [
      { id: 'a', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'H' },
      { id: 'b', lonDeg: -60, eirpDensityDbWPerHz: -20, polarization: 'H' }
    ]
  });
  const only = A.downlinkCAsi({
    station: BJ, rx: RX,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6, polarization: 'H' },
    interferers: [{ id: 'a', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'H' }]
  });
  approx('地平线以下的强干扰星不影响结果', r.ciDb, only.ciDb, 1e-9);
  ok('被剔除的源仍列出并注明原因', r.sources.some((s) => s.skipped));
}

// 无有效干扰源 → null（不是 0、不是 Infinity）
{
  const r = A.downlinkCAsi({
    station: BJ, rx: RX,
    wanted: { lonDeg: 110.5, eirpDbW: 50, bandwidthHz: 36e6 }, interferers: []
  });
  ok('无干扰源时 C/ASI = null', r.ciDb === null);
}

// 上行三模式的量级关系：mask(监管上界) 必须显著差于 peer(工程估算)
{
  const ints = [{ id: 'u1', lonDeg: 113, polarization: 'V', diameterM: 4.5, powerW: 40, bandwidthHz: 36e6, feederLossDb: 3.5 }];
  const base = { station: BJ, wanted: { lonDeg: 110.5, polarization: 'V' }, tx: TX, interferers: ints };
  const peer = A.uplinkCAsi({ ...base, sourceMode: 'peer' }).ciDb;
  const mask = A.uplinkCAsi({ ...base, sourceMode: 'mask' }).ciDb;
  ok('上行 mask 模式远差于 peer 模式（监管上界 vs 工程值）', mask < peer - 20,
    `mask=${mask.toFixed(2)} peer=${peer.toFixed(2)} 差 ${(peer - mask).toFixed(1)} dB`);
  ok('peer 模式给出工程量级 C/ASI（>25 dB）', peer > 25, peer.toFixed(2) + ' dB');
  ok('默认模式 = peer', A.uplinkCAsi(base).ciDb === peer);

  // 对等站共址时，其离轴角应与本站看到的拓扑角相同
  const r = A.uplinkCAsi({ ...base, sourceMode: 'peer' });
  approx('共址对等站离轴角 = 本站拓扑角', r.sources[0].peer.thetaDeg, r.sources[0].thetaDeg, 1e-9);
  ok('共址标记正确', r.sources[0].peer.coLocated === true);

  // 非共址：低纬站看同步弧夹角更大
  const rg = A.uplinkCAsi({
    ...base, sourceMode: 'peer',
    interferers: [{ ...ints[0], stationLon: GZ.lon, stationLat: GZ.lat }]
  });
  ok('非共址时用干扰站自己的几何', rg.sources[0].peer.coLocated === false
    && rg.sources[0].peer.thetaDeg > r.sources[0].peer.thetaDeg,
    `广州 ${rg.sources[0].peer.thetaDeg.toFixed(3)}° > 北京 ${r.sources[0].peer.thetaDeg.toFixed(3)}°`);

  // 顶着限值发的干扰站会被标记不合规
  const bad = A.uplinkCAsi({
    ...base, sourceMode: 'peer',
    interferers: [{ id: 'x', lonDeg: 113, diameterM: 1.2, powerW: 400, bandwidthHz: 2e5, feederLossDb: 1 }]
  });
  ok('超 S.524 限值的干扰站被告警', bad.warnings.some((w) => w.includes('S.524')));
}

// 上行几何图的出参：三条线 + 落点，图上「读得出的东西」必须与逐源明细是同一个数
console.log('\n--- 上行干扰几何（离轴 EIRP 密度切面）---');
{
  const ints = [{ id: 'u1', lonDeg: 113, polarization: 'V', diameterM: 4.5, powerW: 40, bandwidthHz: 36e6, feederLossDb: 3.5 }];
  const base = { station: BJ, wanted: { lonDeg: 110.5, polarization: 'V' }, tx: TX, interferers: ints };
  const rp = A.uplinkCAsi({ ...base, sourceMode: 'peer' });
  const rm = A.uplinkCAsi({ ...base, sourceMode: 'mask' });
  const gp = rp.geometry, gm = rm.geometry;

  // ★ 图的核心不变式：水平线到落点的垂直距离 === 该源的 C/I。
  //   这一条钉死了「右侧副轴直接读 C/I」这个读图方式——不成立的话那根副轴就是骗人的。
  for (const r of [rp, rm]) {
    for (const s of r.sources) {
      approx(`C/I ≡ 本站密度 − 等效密度（${r.geometry.sourceMode}）`,
        r.geometry.ownDensityDbWPerHz - s.effectiveDensityDbWPerHz, s.ciDb, 1e-12);
    }
  }

  // 掩模模式下，落点必须**恰好落在掩模曲线上**（干扰源模型就是那条线）
  {
    const s = rm.sources[0];
    const m = P.s524OffAxisEirpDensity(s.offAxisDeg, TX.freqGHz);
    approx('掩模模式落点在掩模线上', s.interfererDensityDbWPerHz, m.densityDbWPerHz, 1e-12);
  }

  // 对等站曲线 = 主轴密度 − Gmax + G(φ)，逐点可手算（抽三点核）
  {
    const c = gp.peerCurves[0];
    const lam = A.lambdaOf(TX.freqGHz);
    let worst = 0;
    for (const i of [40, 160, 300]) {
      const p = c.curve[i];
      const want = c.eirpDbW - c.peakGainDbi + P.offAxisAP8(c.diameterM, lam, c.efficiency, p.deg) - 10 * Math.log10(c.bandwidthHz);
      worst = Math.max(worst, Math.abs(p.densityDbWPerHz - want));
    }
    ok('对等站曲线逐点 = 主轴密度 − Gmax + G(φ)', worst < 2e-3, `最大偏差 ${worst.toExponential(1)} dB（出参保留 3 位小数）`);
  }

  // 横坐标必须是**干扰站自己看到的**离轴角：共址时与本站拓扑角同，异地时不同
  {
    approx('共址：落点横坐标 = 本站拓扑角', rp.sources[0].offAxisDeg, rp.sources[0].thetaDeg, 1e-12);
    const rg = A.uplinkCAsi({
      ...base, sourceMode: 'peer',
      interferers: [{ ...ints[0], stationLon: GZ.lon, stationLat: GZ.lat }]
    });
    ok('异地：落点横坐标跟干扰站走，不是本站拓扑角',
      Math.abs(rg.sources[0].offAxisDeg - rg.sources[0].peer.thetaDeg) < 1e-12
      && rg.sources[0].offAxisDeg > rg.sources[0].thetaDeg,
      `${rg.sources[0].offAxisDeg.toFixed(4)}° vs 本站 ${rg.sources[0].thetaDeg.toFixed(4)}°`);
  }

  // 极化折减那一段竖线的长度 = XPD
  {
    const rx = A.uplinkCAsi({ ...base, sourceMode: 'peer', wanted: { lonDeg: 110.5, polarization: 'H' } });
    const s = rx.sources[0];
    approx('反极化时 原始密度 − 等效密度 = XPD', s.interfererDensityDbWPerHz - s.effectiveDensityDbWPerHz, A.DEFAULT_XPD_DB, 1e-12);
  }

  // 掩模曲线形状：单调不升（容建议书自身在 7° 平台处的 0.13 dB 取整台阶）
  {
    let up = 0;
    for (let i = 1; i < gp.maskCurve.length; i++) {
      const d = gp.maskCurve[i].densityDbWPerHz - gp.maskCurve[i - 1].densityDbWPerHz;
      if (d > up) up = d;
    }
    ok('掩模曲线单调不升（≤ 建议书自身的取整台阶）', up < 0.15, `最大上跳 ${up.toFixed(3)} dB`);
    ok('φ < φ₀ 段被标为「建议书不设限」', gp.maskCurve.some((p) => p.belowScope) && gp.maskCurve.some((p) => !p.belowScope));
    ok('掩模标为建议书正文（Ku 14 GHz）', gp.maskAuthoritative === true && /S\.524-9/.test(gp.maskBand), gp.maskBand);
  }

  // 曲线只在该有的模式下出现；同参数的对等站合成一条曲线，不逐源重画
  {
    ok('掩模/逐站给定模式无对等站曲线', gm.peerCurves.length === 0);
    ok('掩模曲线三种模式都给（它是那条监管天花板）', gm.maskCurve.length > 0 && gp.maskCurve.length > 0);
    const two = A.uplinkCAsi({
      ...base, sourceMode: 'peer',
      interferers: [ints[0], { ...ints[0], id: 'u2', lonDeg: 108 }, { ...ints[0], id: 'u3', lonDeg: 105, diameterM: 9 }]
    });
    ok('同参数对等站共用一条曲线、异参数各一条', two.geometry.peerCurves.length === 2,
      `3 源 → ${two.geometry.peerCurves.length} 条曲线`);
    ok('每个对等站源都指得到自己那条曲线',
      two.sources.every((s) => two.geometry.peerCurves.some((c) => c.key === s.curveKey)));
  }
}

// ΔT/T：物理自洽（T 由 G 与 G/T 反解；ΔT 随旁瓣 EIRP 线性）
{
  const v = { lonDeg: 113, gOverTDbPerK: 2, rxGainDbi: 30 };
  const d = A.deltaTOverT({ station: BJ, tx: TX, wanted: { lonDeg: 110.5 }, victim: v });
  approx('ΔT/T 中的 T = 10^((G − G/T)/10)', d.victimTk, Math.pow(10, (30 - 2) / 10), 1e-6);
  // 本站功率翻倍 → ΔT 翻倍、ΔT/T 翻倍
  const d2 = A.deltaTOverT({ station: BJ, tx: { ...TX, powerW: 80 }, wanted: { lonDeg: 110.5 }, victim: v });
  approx('功率翻倍 → ΔT/T 翻倍', d2.deltaTOverTPct / d.deltaTOverTPct, 2, 1e-6);
  // 轨位拉远 → 旁瓣增益下降 → ΔT/T 下降
  const dFar = A.deltaTOverT({ station: BJ, tx: TX, wanted: { lonDeg: 110.5 }, victim: { ...v, lonDeg: 130 } });
  ok('轨位拉远 → ΔT/T 下降', dFar.deltaTOverTPct < d.deltaTOverTPct,
    `${d.deltaTOverTPct.toFixed(3)}% → ${dFar.deltaTOverTPct.toFixed(3)}%`);
  ok('6% 门限标记与数值一致', d.exceeds6pct === (d.deltaTOverTPct > 6));
}

console.log('\n=== ④ C/CCI 同频复用 ===');

const X = require('../utils/interference/ciCci.js');

// 缺省着色按原始 set 下标轮转
{
  ok('复用预设 = 3/4/7 色', JSON.stringify(X.REUSE_PRESETS) === JSON.stringify([3, 4, 7]));
  const c = X.defaultColoring([0, 1, 2, 3, 4, 5, 6], 3);
  ok('3 色轮转着色', c[0] === 0 && c[3] === 0 && c[6] === 0 && c[1] === 1 && c[2] === 2);
  const c7 = X.defaultColoring([0, 1, 2, 3, 4, 5, 6], 7);
  ok('7 色时 7 个波束各自一色', new Set(Object.values(c7)).size === 7);
}

// 逐点合成可手算
{
  const vals = [50, 44, 42, 38, 35, 30, 28], idx = [0, 1, 2, 3, 4, 5, 6];
  const r = X.cciAtPoint(vals, idx, { colors: 3 });
  // 3 色下服务波束0(色0)的同色伙伴 = 波束3(38) 与 波束6(28)
  approx('C/CCI = G_服务 − 10lg(Σ同色)', r.cciDb,
    50 - 10 * Math.log10(Math.pow(10, 3.8) + Math.pow(10, 2.8)), 1e-9);
  ok('同色干扰计数正确', r.coChannelCount === 2, String(r.coChannelCount));
  ok('服务波束取该点最强', r.servingIdx === 0);
  approx('逐源占比之和 = 100%', r.interferers.reduce((a, b) => a + b.sharePct, 0), 100, 1e-9);
  ok('逐源占比按强弱降序', r.interferers[0].gainDb > r.interferers[1].gainDb);

  // 色数越多 → 同色越少 → C/CCI 越好
  const c3 = X.cciAtPoint(vals, idx, { colors: 3 }).cciDb;
  const c4 = X.cciAtPoint(vals, idx, { colors: 4 }).cciDb;
  ok('4 色优于 3 色', c4 > c3, `${c4.toFixed(2)} > ${c3.toFixed(2)}`);
  const c7 = X.cciAtPoint(vals, idx, { colors: 7 });
  ok('7 色 / 7 波束 → 无同色干扰', c7.noCoChannel === true && c7.cciDb === null);
}

// 钉死服务波束 / 域外 / 单波束
{
  const vals = [50, 44, 42, 38], idx = [0, 1, 2, 3];
  const r = X.cciAtPoint(vals, idx, { colors: 2, servingIdx: 1 });
  ok('可钉死服务波束', r.servingIdx === 1 && r.servingGainDb === 44);
  ok('全 null（点在域外）→ 返回 null', X.cciAtPoint([null, null], [0, 1], { colors: 2 }) === null);
  ok('钉死的波束在此点无值 → null', X.cciAtPoint([50, null], [0, 1], { colors: 2, servingIdx: 1 }) === null);
  ok('单波束 → noCoChannel', X.cciAtPoint([50], [0], { colors: 4 }).noCoChannel === true);
}

// floorDb 只剔无关紧要的弱源，不该改变量级
{
  const vals = [50, 30, -40, -80], idx = [0, 1, 2, 3];
  const a = X.cciAtPoint(vals, idx, { colors: 1, floorDb: 60 }).cciDb;
  const b = X.cciAtPoint(vals, idx, { colors: 1, floorDb: 200 }).cciDb;
  ok('floorDb 剔除弱源对结果影响 < 0.01 dB', Math.abs(a - b) < 0.01, `${a.toFixed(4)} vs ${b.toFixed(4)}`);
}

console.log('\n=== ⑤ C/XPI 三源合成 ===');

const XP = require('../utils/interference/ciXpi.js');

{
  const r = XP.xpiFromSources(31.5, null, 30, 22);
  approx('总 XPI = −10lg(Σ 10^(−XPIᵢ/10))', r.xpiDb,
    -10 * Math.log10(Math.pow(10, -3.15) + Math.pow(10, -3.0) + Math.pow(10, -2.2)), 1e-9);
  ok('卫星侧走 GRD 时标记 grdBacked', r.grdBacked === true);
  ok('三段都列出', r.terms.length === 3);
  approx('占比之和 = 100%', r.terms.reduce((a, b) => a + b.sharePct, 0), 100, 1e-9);
  ok('最弱那一段占比最大（雨 22 dB 是瓶颈）', r.terms[0].key === 'rain');
  ok('总 XPI 必劣于任一单项', r.xpiDb < 22, `${r.xpiDb.toFixed(3)} < 22`);
}
{
  ok('无 GRD 时退手填且不标 grdBacked', XP.xpiFromSources(null, 26, 30, 22).grdBacked === false);
  ok('GRD 比值 ≤ 0（波束零点区）视为无效', XP.xpdFromGrdRatio(-3) === null && XP.xpdFromGrdRatio(0) === null);
  ok('GRD 比值有效时标 source=grd', XP.xpdFromGrdRatio(28).source === 'grd');
  const one = XP.xpiFromSources(null, null, null, 22);
  approx('只有一段时总 XPI = 该段', one.xpiDb, 22, 1e-9);
  ok('缺失段被记录', one.missing.includes('satellite') && one.missing.includes('earthStation'));
  ok('三段全缺 → null', XP.xpiFromSources(null, null, null, null) === null);
}

// —— 极化纯度的几种等价给法（轴比 / 实测共交电平 / 对准误差）——
// 期望值一律由解析式在测试里现算，不抄实现的输出。
{
  // 轴比：XPD = 20lg((r+1)/(r−1))，r = 10^(AR/20)
  const arXpd = (ar) => { const r = Math.pow(10, ar / 20); return 20 * Math.log10((r + 1) / (r - 1)); };
  approx('轴比 1.0 dB → 解析 XPD', XP.xpdFromAxialRatio(1).db, arXpd(1), 1e-9);
  approx('轴比 0.55 dB ≈ 30 dB（对应「主瓣内 XPD ≥ 30 dB」那条常见入网要求）',
    XP.xpdFromAxialRatio(0.55).db, 30, 0.02);
  ok('轴比越大 XPD 越差', XP.xpdFromAxialRatio(0.5).db > XP.xpdFromAxialRatio(1).db
    && XP.xpdFromAxialRatio(1).db > XP.xpdFromAxialRatio(2).db);
  ok('轴比 ≤ 0（理想圆极化）→ null，按无劣化处理',
    XP.xpdFromAxialRatio(0) === null && XP.xpdFromAxialRatio(-1) === null && XP.xpdFromAxialRatio('') === null);
  ok('轴比换算标 source=axialRatio', XP.xpdFromAxialRatio(0.8).source === 'axialRatio');

  // 实测共/交电平：差值即 XPD，与两者的绝对口径无关
  approx('共 −0.5 / 交 −31.2 → 30.7 dB', XP.xpdFromLevels(-0.5, -31.2).db, 30.7, 1e-9);
  approx('两个电平同加 12 dB 差值不变', XP.xpdFromLevels(11.5, -19.2).db, 30.7, 1e-9);
  ok('交叉不弱于共极化 → 无效（读错曲线或读在零点区）',
    XP.xpdFromLevels(-30, -30) === null && XP.xpdFromLevels(-40, -30) === null);

  // 对准误差：XPD = −20lg(tanτ)
  const alXpd = (t) => -20 * Math.log10(Math.tan(t * Math.PI / 180));
  approx('对准误差 1° → 解析 35.2 dB', XP.xpdFromAlignment(1).db, alXpd(1), 1e-9);
  approx('对准误差 2° → 解析 29.1 dB', XP.xpdFromAlignment(2).db, alXpd(2), 1e-9);
  approx('对准误差 45° → 0 dB（共/交对半）', XP.xpdFromAlignment(45).db, 0, 1e-9);
  ok('τ ≤ 0（完全对准）或 ≥ 90（无物理意义）→ null',
    XP.xpdFromAlignment(0) === null && XP.xpdFromAlignment(90) === null && XP.xpdFromAlignment(-2) === null);
}
{
  // resolveXpd：三种形状一视同仁
  approx('数字直入', XP.resolveXpd(30).db, 30, 1e-12);
  ok('数字直入标 manual', XP.resolveXpd(30).source === 'manual');
  ok('{db,source} 原样收下（GRD / P.618 走这条）', XP.resolveXpd({ db: 22, source: 'p618' }).source === 'p618');
  approx('mode:axialRatio', XP.resolveXpd({ mode: 'axialRatio', axialRatioDb: 1 }).db, XP.xpdFromAxialRatio(1).db, 1e-12);
  approx('mode:levels', XP.resolveXpd({ mode: 'levels', coPolDb: 0, xPolDb: -28 }).db, 28, 1e-12);
  ok('空值 → null', XP.resolveXpd(null) === null && XP.resolveXpd('') === null
    && XP.resolveXpd({ mode: 'manual', db: null }) === null);

  // 对准误差与天线极化纯度是两项独立劣化 → 功率合成，且逐项留痕
  const both = XP.resolveXpd({ mode: 'axialRatio', axialRatioDb: 0.8, alignDeg: 1 });
  const wantBoth = -10 * Math.log10(Math.pow(10, -XP.xpdFromAxialRatio(0.8).db / 10)
    + Math.pow(10, -XP.xpdFromAlignment(1).db / 10));
  approx('轴比 ⊕ 对准误差 = 功率合成', both.db, wantBoth, 1e-9);
  ok('合成必劣于两项中的任一项', both.db < XP.xpdFromAxialRatio(0.8).db && both.db < XP.xpdFromAlignment(1).db);
  ok('合成后 parts 里逐项留痕', both.parts.length === 2 && both.parts[0].key === 'antenna' && both.parts[1].key === 'align');
  ok('只勾对准误差、天线那项空着 → 仍算得出（只剩一项，不合成）',
    Math.abs(XP.resolveXpd({ mode: 'manual', db: null, alignDeg: 1 }).db - XP.xpdFromAlignment(1).db) < 1e-12);
  ok('对准误差为 0 时不影响本项', XP.resolveXpd({ mode: 'manual', db: 30, alignDeg: 0 }).db === 30);
}
{
  // 描述子能一路走到三段合成（UI 就是这么传的）
  const r = XP.combineXpi({
    satellite: { db: 31.5, source: 'grd' },
    earthStation: { mode: 'axialRatio', axialRatioDb: 0.8, alignDeg: 1 },
    rain: { db: 22, source: 'p618' }
  });
  const es = XP.resolveXpd({ mode: 'axialRatio', axialRatioDb: 0.8, alignDeg: 1 });
  approx('描述子入三段合成 = 先解析再合成', r.xpiDb,
    -10 * Math.log10(Math.pow(10, -3.15) + Math.pow(10, -es.db / 10) + Math.pow(10, -2.2)), 1e-9);
  const t = r.terms.find((x) => x.key === 'earthStation');
  ok('地球站段带回来源与算式', t.source === 'axialRatio' && /轴比/.test(t.note) && /对准误差/.test(t.note));
  ok('轴比给到 0（理想圆极化）且不勾对准 → 该段判缺',
    XP.combineXpi({ earthStation: { mode: 'axialRatio', axialRatioDb: 0 }, rain: 22 }).missing.includes('earthStation'));
}

console.log('\n=== ⑥ NGSO 时变 C/I ===');

const N = require('../utils/interference/ciNgso.js');
const ngGeom = require('../utils/ngsoGeometry.js');
const EPOCH = '2026-07-26T00:00:00.000Z';
const T0 = Date.parse(EPOCH);
const walker = (alt, inc, planes, per, tag, phase) => {
  const o = [];
  for (let p = 0; p < planes; p++) for (let k = 0; k < per; k++) {
    o.push({ id: `${tag}${p}${k}`, name: `${tag} ${p}/${k}`, rec: ngGeom.buildSatrec({ type: 'elements', altKm: alt, incl: inc, raan: 360 * p / planes, ma: 360 * k / per + (phase || 0), ecc: 0, argp: 0, epoch: EPOCH }) });
  }
  return o;
};
const MINE = walker(8000, 45, 4, 4, 'M', 0);
const OTHER = walker(1200, 53, 6, 6, 'S', 17);

// 轨道粗筛：倾角够不到的纬度必须剔除
{
  ok('53° 倾角 LEO 够不到 85°N', N.orbitCanReach(OTHER[0].rec, 85, 5) === false);
  ok('53° 倾角 LEO 够得到北京 39.9°N', N.orbitCanReach(OTHER[0].rec, 39.9, 5) === true);
  ok('45° 倾角 MEO(8000km) 因高轨可见范围大，够得到 85°N', N.orbitCanReach(MINE[0].rec, 85, 5) === true);
}

// 采样步长防混叠
{
  const bwNarrow = P.beamwidth3dB(4.5, A.lambdaOf(12.5));
  const req = N.requiredStepSec(OTHER.map((s) => s.rec), bwNarrow, 5);
  ok('LEO 视角速度在 0.1–1 °/s 量级', req.rateDegPerSec > 0.1 && req.rateDegPerSec < 1, req.rateDegPerSec.toFixed(4) + '°/s');
  ok('4.5 m 天线穿越时长 ≈ 1 s 量级', req.crossingSec > 0.3 && req.crossingSec < 3, req.crossingSec.toFixed(3) + 's');
  ok('建议步长 = 穿越时长/5', Math.abs(req.stepSec - req.crossingSec / 5) < 1e-12);
}

const runNgso = (o) => {
  const r = N.createNgsoCiRun({
    station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
    wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
    interferers: [{ id: 'g', name: 'S', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
    minElevDeg: 10, startMs: T0, horizonSec: 2 * 3600, stepSec: 20, ...o
  });
  while (r.stepBatch(1000) < r.T);
  return r.finalize();
};

// 线性不变式：干扰密度 +10 dB → C/I −10 dB；反极化 → 恰好 +XPD
{
  const a = runNgso({}).medianCiDb;
  const b = runNgso({ interferers: [{ id: 'g', sats: OTHER, eirpDensityDbWPerHz: -38, polarization: 'H' }] }).medianCiDb;
  approx('干扰密度 +10 dB → C/I −10 dB', a - b, 10, 1e-9);
  const c = runNgso({ interferers: [{ id: 'g', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'V', xpdDb: 25 }] }).medianCiDb;
  approx('反极化 → C/I 改善恰好一个 XPD', c - a, 25, 1e-9);
}

// CDF 单调 + 分位定义（p 越小越差）
{
  const s = runNgso({});
  const ps = N.DEFAULT_PCTS.filter((p) => s.percentiles[p] != null);
  let mono = true;
  for (let i = 1; i < ps.length; i++) if (s.percentiles[ps[i]] < s.percentiles[ps[i - 1]]) mono = false;
  ok('C/I(p%) 随 p 增大而改善', mono, ps.map((p) => `${p}%:${s.percentiles[p].toFixed(1)}`).join(' '));
  ok('worst ≤ C/I(0.001%) ≤ 中位 ≤ best',
    s.worstCiDb <= s.percentiles[0.001] + 1e-9 && s.percentiles[0.001] <= s.medianCiDb + 1e-9 && s.medianCiDb <= s.bestCiDb + 1e-9);
  approx('中位 = C/I(50%)', s.medianCiDb, s.percentiles[50], 1e-9);
  ok('CDF 采样点非空且首尾覆盖 0–100%', s.cdf.length > 1 && s.cdf[0].pct === 0 && Math.abs(s.cdf[s.cdf.length - 1].pct - 100) < 1e-9);
  ok('样本数 + 无服务星样本数 = T', s.samples + s.noServingSamples === Math.floor(2 * 3600 / 20) + 1);
}

// 包络选择：远区 S.1428 高于 AP8 → 大星座聚合后 C/I 反而更低（反直觉，务必锁住）
{
  const avg = runNgso({ patternKind: 'average' }).medianCiDb;
  const peak = runNgso({ patternKind: 'peak' }).medianCiDb;
  ok('S.1428(平均) 聚合 C/I 低于 AP8(峰值)', avg < peak, `S.1428 ${avg.toFixed(2)} < AP8 ${peak.toFixed(2)}`);
  ok('默认走 S.1428', runNgso({}).patternKind === 'average');
}

// in-line 细化：窄主瓣在粗步下会被漏采，细化后必须能检出且时长 ≈ 理论穿越时长
{
  const narrow = {
    station: BJ, rx: { diameterM: 4.5, efficiency: 0.65, freqGHz: 12.5 },
    wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
    interferers: [{ id: 'g', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
    minElevDeg: 10, startMs: T0, horizonSec: 24 * 3600, stepSec: 5
  };
  const r = N.createNgsoCiRun(narrow);
  while (r.stepBatch(3000) < r.T);
  const s = r.finalize();
  ok('窄主瓣 + 粗步 → 标记 CDF 混叠风险', s.cdfAliasRisk === true);
  ok('给出建议步长', s.recommendedStepSec > 0 && s.recommendedStepSec < 5, s.recommendedStepSec.toFixed(3) + 's');
  ok('给出步长过粗的告警', s.warnings.some((w) => w.includes('步长')));
  ok('in-line 走细化重扫', s.inlineRefined === true && s.inlineFineStepSec < 5);
  ok('细化后能检出穿越（粗步会漏成 0 次）', s.inlineCount > 0, `${s.inlineCount} 次/24h`);
  if (s.inlineEvents.length) {
    const e = s.inlineEvents[0];
    ok('穿越时长与理论值同量级（0.3–5 s）', e.durationSec > 0.3 && e.durationSec < 5, e.durationSec.toFixed(2) + 's');
    ok('穿越最近点在主瓣内', e.minThetaDeg < s.beamwidth3dBDeg);
    ok('穿越期间 C/I 显著劣于中位', e.worstCiDb < s.medianCiDb - 10, `${e.worstCiDb.toFixed(1)} vs 中位 ${s.medianCiDb.toFixed(1)}`);
  }
  // 分母用 s.horizonSec（= T×stepSec，比标称 24 h 多出不足一步），不要拿 24*3600 硬凑
  approx('占时比 = 事件总时长 / 实际时窗', s.inlineDutyPct, s.inlineTotalSec / s.horizonSec * 100, 1e-9);
}

// 粗筛拦截与告警
{
  let threw = false;
  try {
    N.createNgsoCiRun({
      station: { lon: 0, lat: 88, alt: 0 }, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
      wanted: { sats: OTHER, eirpDbW: 40, bandwidthHz: 20e6 }, interferers: [], minElevDeg: 10, startMs: T0, horizonSec: 600, stepSec: 60
    });
  } catch (e) { threw = /轨道能覆盖/.test(e.message); }
  ok('本星座轨道够不到站纬 → 明确报错', threw);
  ok('estimateWork = 星数 × 样本数', N.estimateWork(10, 3600, 10) === 10 * (360 + 1));
}

console.log('\n=== ⑦ NGSO 性能优化（掩码 / 细化预算）===');

// 可见性掩码不得改变任何结果 —— 这是优化的第一条红线，故做真 A/B（_noScreen 关掉掩码）
{
  const cfg = {
    station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
    wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
    interferers: [{ id: 'g', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
    minElevDeg: 10, startMs: T0, horizonSec: 4 * 3600, stepSec: 10
  };
  const runIt = (extra) => { const r = N.createNgsoCiRun({ ...cfg, ...extra }); while (r.stepBatch(3000) < r.T); return r.finalize(); };
  const on = runIt({}), off = runIt({ _noScreen: true });
  ok('掩码开/关 样本数一致', on.samples === off.samples, `${on.samples} vs ${off.samples}`);
  approx('掩码开/关 中位 C/I 一致', on.medianCiDb, off.medianCiDb, 1e-5);
  approx('掩码开/关 最差 C/I 一致', on.worstCiDb, off.worstCiDb, 1e-5);
  for (const p of [0.1, 1, 10, 50]) approx(`掩码开/关 C/I(${p}%) 一致`, on.percentiles[p], off.percentiles[p], 1e-5);
  ok('掩码确实生效（保留率 < 60%）', on.perf.screenKeptPct < 60, on.perf.screenKeptPct.toFixed(1) + '%');
  ok('掩码粗步显著大于主步长', on.perf.coarseSec >= 2 * cfg.stepSec, `${on.perf.coarseSec.toFixed(0)}s vs ${cfg.stepSec}s`);
}

// 步长过粗时 in-line 细化必须被预算兜住（曾因候选门限随步长线性放大而卡死）
{
  const mk = (step) => {
    const r = N.createNgsoCiRun({
      station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
      wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
      interferers: [{ id: 'g', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
      minElevDeg: 10, startMs: T0, horizonSec: 6 * 3600, stepSec: step
    });
    const t0 = Date.now();
    while (r.stepBatch(3000) < r.T);
    const s = r.finalize();
    return { s, ms: Date.now() - t0 };
  };
  const big = mk(100);
  ok('步长 100s 能在合理时间内完成（曾卡死）', big.ms < 20000, big.ms + 'ms');
  ok('步长过粗时标记粗扫已退化', big.s.inlineDegenerate === true);
  ok('被预算丢弃的候选如实上报', Number.isFinite(big.s.inlineDroppedWindows));
  ok('步长过粗时给出降步长的告警', big.s.warnings.some((w) => /步长/.test(w)));
  const small = mk(10);
  ok('细步下 in-line 检出数不少于粗步（粗步只会漏、不会多报）',
    small.s.inlineCount >= big.s.inlineCount, `10s:${small.s.inlineCount} vs 100s:${big.s.inlineCount}`);
}

// perf 摘要齐备（UI 要据此提示算力）
{
  const r = N.createNgsoCiRun({
    station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
    wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
    interferers: [{ id: 'g', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
    minElevDeg: 10, startMs: T0, horizonSec: 1800, stepSec: 30
  });
  while (r.stepBatch(500) < r.T);
  const s = r.finalize();
  ok('perf 摘要齐备', !!(s.perf && s.perf.coarseSec > 0 && s.perf.screenKeptPct >= 0 && s.perf.totalPropagations > 0));
}

// ---------------------------------------------------------------------------
// 干扰几何图的标签排布（src/ci/ciPlotLabels.js）
// ---------------------------------------------------------------------------
// 「逐站给定」模式下每座站可以填成同一个密度 → 落点严丝合缝叠在同一高度。首版只会一路往下
// 推，整叠压到横轴刻度与轴名上（用户截图即此）。下面这几条把「不出框」钉死。
console.log('\n=== ⑧ 干扰几何图标签排布 ===');
{
  const L = await import('../../../src/ci/ciPlotLabels.js');
  const BOX = { top: 19, bottom: 210, left: 50, right: 412 };
  const inBox = (arr) => arr.every((p) => p.labelY >= BOX.top - 1e-9 && p.labelY <= BOX.bottom + 1e-9);

  // ★ 五点同高（用户实测那一幕）：必须全部留在框内，且两两至少隔开一个行距
  {
    const items = [0.284, 0.717, 2.23, 2.41, 2.51].map((d, i) => ({ x: 100 + i * 40, y: 205, text: `SAT-${i} · ${d}° · C/I 39.6dB` }));
    const out = L.layoutLabels(items, BOX);
    ok('五点同高 标签全部留在绘图区内', inBox(out), out.map((p) => p.labelY.toFixed(1)).join(' '));
    let minGap = Infinity;
    for (let i = 1; i < out.length; i++) minGap = Math.min(minGap, out[i].labelY - out[i - 1].labelY);
    ok('五点同高 标签两两不重叠', minGap >= 10.99, `最小间距 ${minGap.toFixed(2)}`);
    ok('同高时按横坐标排序（引线不交叉）', out.every((p, i) => i === 0 || p.x >= out[i - 1].x));
  }

  // 点贴着下边界：整叠要上移，不能溢出
  {
    const items = Array.from({ length: 4 }, (_, i) => ({ x: 120 + i, y: BOX.bottom - 1, text: 'x' }));
    const out = L.layoutLabels(items, BOX);
    ok('贴下边界时整叠上移回框内', inBox(out), out.map((p) => p.labelY.toFixed(1)).join(' '));
  }
  // 点贴着上边界：不能被推到框上沿之外
  {
    const items = Array.from({ length: 3 }, (_, i) => ({ x: 120 + i, y: BOX.top - 30, text: 'x' }));
    const out = L.layoutLabels(items, BOX);
    ok('贴上边界时整叠下移回框内', inBox(out), out.map((p) => p.labelY.toFixed(1)).join(' '));
  }
  // 点多到压不下：均分而不是溢出（宁可挤也不出框）
  {
    const n = 40;
    const items = Array.from({ length: n }, (_, i) => ({ x: 120, y: 100, text: 'x' }));
    const out = L.layoutLabels(items, BOX);
    ok(`${n} 个点也不出框（行距自动压缩）`, inBox(out),
      `跨度 ${(out[n - 1].labelY - out[0].labelY).toFixed(1)} ≤ ${(BOX.bottom - BOX.top)}`);
  }

  // 标签不出右边界：靠右的孤点翻到左侧
  {
    const long = '某颗名字很长的邻星 (PROTOSTAR 2) · 2.51° · C/I 39.6dB';
    const one = L.layoutLabels([{ x: BOX.right - 8, y: 100, text: long }], BOX)[0];
    ok('靠右的孤点标签翻到左侧', one.anchor === 'end' && one.labelX < BOX.right, `anchor=${one.anchor} x=${one.labelX.toFixed(1)}`);
    const left = L.layoutLabels([{ x: BOX.left + 5, y: 100, text: long }], BOX)[0];
    ok('靠左的孤点标签仍在右侧', left.anchor === 'start');
  }
  // 被推开的多个标签排成一列，且最宽的一条不越右边界
  {
    const items = [0, 1, 2].map((i) => ({ x: 300 + i * 20, y: 100, text: '邻星 ' + i + ' · 2.51° · C/I 39.6dB' }));
    const out = L.layoutLabels(items, BOX);
    const col = out[0].labelX;
    ok('被推开的标签排成一列', out.every((p) => p.labelX === col));
    const w = L.textWidth(items[0].text, 7.4);
    ok('最宽标签不越右边界', col + w <= BOX.right + 1e-9, `${(col + w).toFixed(1)} ≤ ${BOX.right}`);
  }
  // 单点不被无谓位移
  {
    const one = L.layoutLabels([{ x: 200, y: 120, text: 'A' }], BOX)[0];
    ok('单点标签不位移', one.labelY === 120 && one.displaced === false);
  }
}

// ============================================================================
// ⑨ 星座来源解析（electron/services/interference.js 的 resolveSats）
// ============================================================================
//
// 这一层是「下拉里选的东西 → 一串 satrec」的唯一入口，四类来源（编目组 / 自定义星历 /
// 我的卫星组 / 自定义星座）全从这里过。此处只测不需要星历文件的那两支：
// 'elements'（星座页 Walker 生成器建的自定义星座，逐颗六根数）与来源缺失时的报错。
// ⚠️ 期望值不抄实现：24/6/1 的放置由 walker.js 现算，周期由 √(a³/μ) 现算。
console.log('\n=== ⑨ 星座来源解析（自定义星座 → satrec）===');
{
  const createInterference = require('../../../electron/services/interference.js');
  const { generateConstellation } = await import('../../../src/viz/constellation/walker.js');
  // 三个依赖都给 null：'elements' 这支不碰星历库，正是它「无需载入」的意义
  const S = createInterference(null, null, null);

  const params = { pattern: 'delta', T: 24, P: 6, F: 1, incl: 53, shape: 'circ', perigeeKm: 550, apogeeKm: 550, argp: 0, raan0: 0, m0: 0, name: 'CC' };
  const epoch = '2026-07-26T00:00:00.000Z';
  const gen = generateConstellation(params);
  const sats = gen.map((s, i) => ({ noradId: 1020000 + i, name: s.name, elements: s.elements, epoch }));
  ok('walker 展开 24/6/1 得 24 颗', gen.length === 24, `${gen.length} 颗`);

  const got = S.resolveSats({ source: 'elements', sats, epoch });
  ok('elements 来源全部建成 satrec', !got.error && got.sats.length === 24, got.error || `${got.sats.length} 颗`);
  ok('星名与编目号原样带过来', got.sats[0].name === gen[0].name && got.sats[0].id === '1020000');

  // 平均运动对解析解：a=(RE+550)/(1−0)，T=2π√(a³/μ) —— satrec.no 单位 rad/min
  {
    const RE = 6378.137, MU = 398600.4418;
    const a = RE + 550;
    const periodMin = 2 * Math.PI * Math.sqrt((a * a * a) / MU) / 60;
    const rec = got.sats[0].rec;
    const n = Number(rec.no != null ? rec.no : rec.no_kozai);   // rad/min
    approx('轨道周期对解析解（550 km 圆轨道）', 2 * Math.PI / n, periodMin, 0.02);
    approx('倾角原样进 satrec', rec.inclo * 180 / Math.PI, 53, 1e-6);
  }
  // RAAN 展布：Delta 360°/6 面 = 60° 一档（第 5 颗是第 2 面第 1 颗，S=4）
  approx('第 2 轨道面 RAAN = 60°', got.sats[4].rec.nodeo * 180 / Math.PI, 60, 1e-6);

  // 抽样上限：等间隔取，不是取前 N 条
  {
    const cut = S.resolveSats({ source: 'elements', sats, limit: 6 });
    ok('limit 生效且按等间隔抽', cut.sats.length === 6 && cut.sats[1].id === '1020004', `${cut.sats.length} 颗，第 2 颗 ${cut.sats[1] && cut.sats[1].id}`);
    ok('抽样倍率如实上报', Math.abs(cut.samplingFactor - 4) < 1e-9, String(cut.samplingFactor));
  }
  // 空座 / 无来源都要给出人话，不能静默回空
  ok('空的自定义星座报错', !!S.resolveSats({ source: 'elements', sats: [] }).error);
  ok('无来源报错', !!S.resolveSats({}).error);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

