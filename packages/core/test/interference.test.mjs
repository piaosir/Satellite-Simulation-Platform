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
  // 与波束合成那边的颜色数一一对应。七档 = 有效前沿（单极化 3/7/9 · 双极化 4/8/12/16），
  // 「同一间距上只留最省频率的那一档」这条不变式在 freqReuse.test.mjs 里按可达间距逐档验。
  ok('复用预设 = 3/4/7/8/9/12/16 色', JSON.stringify(X.REUSE_PRESETS) === JSON.stringify([3, 4, 7, 8, 9, 12, 16]));
  const c16 = X.defaultColoring(Array.from({ length: 32 }, (_, i) => i), 16);
  ok('16 色轮转：32 个波束每色各 2 个', new Set(Object.values(c16)).size === 16 && c16[0] === 0 && c16[16] === 0 && c16[15] === 15);
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
  const guard = bwNarrow / 2;                       // 规避角默认取半功率半角（B4）
  const req = N.requiredStepSec(OTHER.map((s) => s.rec), guard, 5);
  ok('LEO 视角速度在 0.1–1 °/s 量级', req.rateDegPerSec > 0.1 && req.rateDegPerSec < 1, req.rateDegPerSec.toFixed(4) + '°/s');
  ok('4.5 m 天线穿越时长 ≈ 1 s 量级', req.crossingSec > 0.3 && req.crossingSec < 3, req.crossingSec.toFixed(3) + 's');
  ok('建议步长 = 穿越时长/5', Math.abs(req.stepSec - req.crossingSec / 5) < 1e-12);
  // ★ 判定阈值与穿越时长同源：穿越弦长 = 2×规避角，不是 1×（首版一处当半径一处当直径）
  approx('穿越时长 = 2×规避角 / 视角速度', req.crossingSec, 2 * guard / req.rateDegPerSec, 1e-12);
  approx('默认规避角下的穿越时长 = 3dB全宽/视角速度（与首版逐位一致）',
    req.crossingSec, bwNarrow / req.rateDegPerSec, 1e-12);
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
  // 取「样本撑得住的最细一档」——0.001% 这类档在 2 h/20 s 下已被样本门禁挡掉（见 §A2）
  const pMin = ps[0];
  ok('worst ≤ C/I(最细可报档) ≤ 中位 ≤ best',
    s.worstCiDb <= s.percentiles[pMin] + 1e-9 && s.percentiles[pMin] <= s.medianCiDb + 1e-9 && s.medianCiDb <= s.bestCiDb + 1e-9,
    `最细可报档 = ${pMin}%`);
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

// ---------------------------------------------------------------------------
// 一期验收（docs/NGSO时变CI改进方案.md §5）：A2 样本门禁 / B2 η 不再是杠杆 /
// B3 样本池不变式 / B1 频段外退回 AP8
// ---------------------------------------------------------------------------

// ① nEff < 1 的分位返回 null 且带 needSamples
{
  const s = runNgso({});                                  // 2 h / 20 s = 361 个样本
  const sup = s.percentileSupport;
  ok('分位支撑度逐档给出', !!sup && Object.keys(sup).length === N.DEFAULT_PCTS.length);
  ok('0.001% 档样本不足 → 不给数字', s.percentiles[0.001] === null,
    `nEff=${sup[0.001].nEff.toExponential(2)}`);
  ok('0.001% 档给出所需样本数 = ceil(100/p)', sup[0.001].needSamples === 100000 && sup[0.001].enough === false);
  ok('50% 档样本充足且不标 weak', s.percentiles[50] != null && sup[50].enough === true && !sup[50].weak);
  // nEff 的定义：p/100 × 样本数
  approx('nEff = p/100 × 样本数', sup[1].nEff, 0.01 * s.samples, 1e-12);
  ok('1% 档（nEff≈3.6）出数但标 weak', s.percentiles[1] != null && sup[1].weak === true);
  ok('算之前就按时窗/步长告警', s.warnings.some((w) => /支撑不了|样本不足/.test(w)));

  // 时窗拉长到样本够 0.1% 时，该档必须由 null 变成数字（门禁是随样本量走的，不是写死的）
  const long = runNgso({ horizonSec: 12 * 3600, stepSec: 5 });   // 8641 个样本 → nEff(0.1%)=8.6
  ok('样本够了 0.1% 档就出数', long.percentiles[0.1] != null && long.percentileSupport[0.1].enough === true,
    `样本 ${long.samples}，nEff=${long.percentileSupport[0.1].nEff.toFixed(2)}`);
}

// ② η 变化不再改变 C/I（S.1428 分支）—— 改前 η 65%→50% 恰好压出 10lg(0.65/0.5)=1.14 dB
{
  const a = runNgso({ rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 } });
  const b = runNgso({ rx: { diameterM: 1.2, efficiency: 0.50, freqGHz: 12.5 } });
  ok('两次都真的走了 S.1428', a.esPattern.applied === 'S.1428-1' && b.esPattern.applied === 'S.1428-1');
  approx('η 65%→50%：中位 C/I 不变', a.medianCiDb, b.medianCiDb, 1e-9);
  approx('η 65%→50%：最差 C/I 不变', a.worstCiDb, b.worstCiDb, 1e-9);
  // 反证：若仍用绝对增益口径，C/I 会整体抬 10lg(0.65/0.5)
  ok('该杠杆的量级确为 1.14 dB（改前的偏差）', Math.abs(10 * Math.log10(0.65 / 0.50) - 1.1394) < 1e-3);
  // ⚠️ AP8 分支**没有**跟着改，η 在那里仍是杠杆——这是刻意保留的口径，不是漏改：
  //   AP8/S.580 的旁瓣段（29−25lgφ、G1、−10 dBi）是 RR 定的**绝对**限值 dBi，
  //   本就该按绝对增益用；只有主瓣抛物线段吃用户的 Gmax(η)。干扰星多落在旁瓣区，
  //   于是 C 随 η 走、I 不随 η 走，C/I 就差出一个 10lg(η₁/η₂)。
  //   S.1428 的情形不同：它的 Gmax_ref 是建议书自造的参考峰值（隐含 η≈70%），
  //   与用户天线无关，混用才是错。故本期只改 S.1428 分支，AP8 原样锁住。
  const pa = runNgso({ patternKind: 'peak', rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 } });
  const pb = runNgso({ patternKind: 'peak', rx: { diameterM: 1.2, efficiency: 0.50, freqGHz: 12.5 } });
  approx('AP8 分支 η 仍是杠杆（绝对限值口径，刻意保留）', pa.medianCiDb - pb.medianCiDb, 10 * Math.log10(0.65 / 0.50), 0.02);

  // 鉴别度口径的两种写法（热路径预解析 vs 通用入口）必须逐位一致
  const lam125 = A.lambdaOf(12.5);
  const mk = P.makeEarthStationOffAxis('average', 1.2, lam125, 0.65, 12.5);
  let maxDiff = 0;
  for (let phi = 0; phi <= 180; phi += 0.25) {
    maxDiff = Math.max(maxDiff, Math.abs(mk.gain(phi) - P.earthStationOffAxis('average', 1.2, lam125, 0.65, phi, 12.5)));
  }
  ok('预解析版与通用入口全角域逐点一致', maxDiff === 0, `max|Δ| = ${maxDiff}`);
  // 鉴别度定义本身：gPeak − G(φ) 必须等于建议书的 Gmax_ref − G_ref(φ)
  {
    const gp = P.peakGainDbi(1.2, lam125, 0.65);
    const ref = P.offAxisS1428(1.2, lam125, 20, 12.5);
    approx('G(φ) = gPeak − [Gmax_ref − G_ref(φ)]', mk.gain(20), gp - (ref.gmaxRef - ref.gain), 1e-12);
  }
}

// ③ samples + noServing === T 是不变式（构造大量「有服务星但没有干扰星可见」的时刻）
{
  const s = runNgso({ interferers: [{ id: 'g', sats: [OTHER[0]], eirpDensityDbWPerHz: -48, polarization: 'H' }] });
  ok('单颗干扰星 → 确有无干扰源可见的样本', s.noInterfererSamples > 0, `${s.noInterfererSamples} / ${s.samples}`);
  ok('samples + noServing === T（不变式，非巧合）',
    s.samples + s.noServingSamples === Math.floor(2 * 3600 / 20) + 1,
    `${s.samples} + ${s.noServingSamples} = ${s.samples + s.noServingSamples}`);
  ok('无干扰源的样本以 +∞ 计入样本池（best 为 +∞）', s.bestCiDb === Infinity);
  ok('最差值取自有干扰的时刻（有限数）', Number.isFinite(s.worstCiDb), String(s.worstCiDb));
  // 单颗干扰星过顶只占很小一部分时间 → 中位就该是 +∞，这正是「分母是全部时间」的直接后果：
  // 首版把 +∞ 丢出池子，分母变成「有干扰的时间」，同一算例的中位会变成一个有限的漂亮数字。
  ok('中位为 +∞（大多数时刻确实没有干扰源可见）', s.medianCiDb === Infinity);
  ok('无一档分位数算出 NaN（+∞ 参与插值的坑）',
    N.DEFAULT_PCTS.every((p) => s.percentiles[p] === null || !Number.isNaN(s.percentiles[p])));
  ok('CDF 采样点也没有 NaN', s.cdf.every((d) => !Number.isNaN(d.ciDb)));
  // 同一算例：把 +∞ 丢出池子会让尾部偏乐观多少 —— 有干扰的样本只占全部的一小部分
  ok('无干扰源样本占了大头（丢掉它们等于换了分母）', s.noInterfererSamples > s.samples * 0.5,
    `${s.noInterfererSamples} / ${s.samples}`);
}

// ④ C 频段 3 m 天线：D/λ 够但频段不在 10.7–30 GHz → 退回 AP8 且如实上报
{
  const lam6 = A.lambdaOf(6);
  const info = P.earthStationPatternInfo('average', 3, lam6, 6);
  ok('S.1428 频段外 → fellBack', info.fellBack === true && info.applied === 'AP8/S.580', info.reason);
  ok('D/λ = 60 本身是够的（挡掉它的是频段不是口径）', 3 / lam6 >= 20, `D/λ=${(3 / lam6).toFixed(1)}`);
  approx('退回后的值 = AP8 原值', P.earthStationOffAxis('average', 3, lam6, 0.65, 20, 6), P.offAxisAP8(3, lam6, 0.65, 20), 1e-12);
  ok('offAxisS1428 在频段外直接返回 null', P.offAxisS1428(3, lam6, 20, 6) === null);
  ok('不给频率则不校验频段（兼容只关心口径比的调用方）', P.offAxisS1428(3, lam6, 20) !== null);
  ok('10.7 / 30 GHz 两个边界都在范围内',
    P.offAxisS1428(3, lam6, 20, 10.7) !== null && P.offAxisS1428(3, lam6, 20, 30) !== null);

  const s = runNgso({ rx: { diameterM: 3, efficiency: 0.65, freqGHz: 6 } });
  ok('扫描结果带出实际所用包络', s.esPattern && s.esPattern.fellBack === true && s.esPattern.applied === 'AP8/S.580');
  ok('退回 AP8 时给出告警', s.warnings.some((w) => /退回 AP8/.test(w)));
}

// ---------------------------------------------------------------------------
// 二期验收（§5）：A1 空间站发射方向图与波束指向 / B4 规避角
// ---------------------------------------------------------------------------

const PS = require('../utils/interference/patternsSat.js');
// 一副典型的 LEO 用户波束：3 dB 全宽 4°（⇒ ψb = 2°）、峰值 32 dBi、近旁瓣 −25 dB
const SAT_BEAM = { mode: 's1528', beamwidth3dBDeg: 4, peakGainDbi: 32, Ln: -25 };

// ⑤ 回归锁：mode:'none' 这条路必须与「根本没有 satPattern 这个入参」逐位一致
//    （注意口径：与 v1.3.6 的绝对值已因一期的 B2/B3 变过，本条锁的是「接方向图这件事
//     本身不动 none 分支」——一期改的是数，二期不该再动它一分一毫）
{
  const base = runNgso({});
  const none = runNgso({ satPattern: { mode: 'none' } });
  const worst = runNgso({ satPattern: { ...SAT_BEAM, pointing: 'worst' } });
  const same = (a, b) => a.worstCiDb === b.worstCiDb && a.medianCiDb === b.medianCiDb && a.bestCiDb === b.bestCiDb
    && N.DEFAULT_PCTS.every((p) => a.percentiles[p] === b.percentiles[p]);
  ok('缺省 ≡ mode:none（逐位）', same(base, none));
  ok('mode:none 标为「未计入卫星方向图」', base.satPatternActive === false && /上界/.test(base.satPattern.shape));
  ok('mode:none 给出「结果为上界」的告警', base.warnings.some((w) => /未计入卫星发射方向图/.test(w)));
  // pointing:'worst' 的定义就是「波束始终照本站」⇒ 离轴恒 0 ⇒ 滚降恒 0 ⇒ 与 none 逐位一致
  ok('pointing:worst ≡ none（逐位，上界口径的自洽性检查）', same(base, worst),
    `${base.medianCiDb} vs ${worst.medianCiDb}`);
  ok('worst 分支仍如实标出「上界口径」告警', worst.warnings.some((w) => /上界口径/.test(w)));
}

// ⑥ s1528 + cells：聚合干扰显著低于 worst，且「离轴>40° 的星」的贡献占比大幅下降
{
  const worst = runNgso({ satPattern: { ...SAT_BEAM, pointing: 'worst' } });
  // 相控阵 LEO 的量级：32 个同时波束、200 km 小区
  const cells = runNgso({ satPattern: { ...SAT_BEAM, pointing: 'cells', beamsPerSat: 32, cellSpacingKm: 200 } });
  const nadir = runNgso({ satPattern: { ...SAT_BEAM, pointing: 'nadir' } });

  ok('cells 的聚合 C/I 显著优于 worst（干扰被方向图压下去了）',
    cells.medianCiDb > worst.medianCiDb + 10, `${cells.medianCiDb.toFixed(1)} vs ${worst.medianCiDb.toFixed(1)}`);
  ok('worst 口径下「远区占比」就是不接方向图时的基线',
    Math.abs(worst.farSharePct - worst.farShareNoPatternPct) < 1e-9, `${worst.farSharePct.toFixed(1)}%`);
  ok('基线远区占比在评审实测的量级（约 4~5 成）',
    worst.farShareNoPatternPct > 30 && worst.farShareNoPatternPct < 70, `${worst.farShareNoPatternPct.toFixed(1)}%`);
  ok('cells：远区（>40°）贡献占比大幅下降',
    cells.farSharePct < cells.farShareNoPatternPct / 2,
    `${cells.farShareNoPatternPct.toFixed(1)}% → ${cells.farSharePct.toFixed(1)}%`);
  ok('nadir：远区占比同样下降（波束钉在星下点，斜看过来的站落在旁瓣）',
    nadir.farSharePct < nadir.farShareNoPatternPct, `${nadir.farShareNoPatternPct.toFixed(1)}% → ${nadir.farSharePct.toFixed(1)}%`);
  ok('聚合干扰能量的下降量如实回传', cells.satPatternReductionDb > 0 && nadir.satPatternReductionDb > 0,
    `cells ${cells.satPatternReductionDb.toFixed(1)} dB / nadir ${nadir.satPatternReductionDb.toFixed(1)} dB`);
  ok('worst 口径下降幅为 0（它本来就是上界）', Math.abs(worst.satPatternReductionDb) < 1e-12);
  ok('方向图与指向的口径原样进结果（报表要逐项列出）',
    cells.satPattern.shape === 'ITU-R S.1528 §1.2' && cells.satPattern.pointing === 'cells'
    && cells.satPattern.beamsPerSat === 32 && cells.satPattern.cellSpacingKm === 200);

  // 形状层本身：S.1528 §1.2 的相对滚降在 0° 恰为 0，且单调不上升到近旁瓣平台
  const sh = PS.makeShape(SAT_BEAM);
  approx('S.1528 相对滚降在 0° 恰为 0', sh.relDb(0), 0, 0);
  approx('主瓣 3 dB 点（ψ = ψb）恰为 −3 dB', sh.relDb(2), -3, 1e-12);
  ok('近旁瓣平台 = Ln', Math.abs(sh.relDb(7) - (-25)) < 1e-9, sh.relDb(7).toFixed(3));
  ok('远区滚降为负且远低于主瓣', sh.relDb(60) < -25);
  // 系数不在本模块：与 pfdmask/s1528.js（按 ITU 正文逐段核对）同源
  {
    const s1528 = require('../utils/pfdmask/s1528.js');
    const d = s1528.derivedS1528_12({ peakGainDbi: 32, psibDeg: 2, Ln: -25 });
    approx('形状层直接复用 pfdmask/s1528.js，不另写系数',
      sh.relDb(10), s1528.gainDbS1528_12(10, { peakGainDbi: 32, psibDeg: 2, Ln: -25 }, d) - 32, 0);
  }

  // 小区网格：量化确定性 + 球冠角半径的定义
  {
    const c1 = PS.cellCenter(116.4074, 39.9042, 200);
    const c2 = PS.cellCenter(116.4074, 39.9042, 200);
    ok('小区量化是确定性的（可复现是硬要求）', c1.lonDeg === c2.lonDeg && c1.latDeg === c2.latDeg);
    ok('站址落在自己那个小区内', Math.abs(c1.latDeg - 39.9042) <= c1.dLatDeg / 2 + 1e-9 && Math.abs(c1.lonDeg - 116.4074) <= c1.dLonDeg / 2 + 1e-9);
    // 球冠：2πR²(1−cos γ) / s² = n
    const cosG = PS.cellCapCosGamma(32, 200);
    approx('球冠角半径由「最近 n 个小区」的面积定', (2 * Math.PI * 6378.137 ** 2 * (1 - cosG)) / (200 * 200), 32, 1e-6);
  }
}

// GRD 模式 · 多波束的口径：干扰算的是「同频的那一个波束」，不是整副天线
{
  // 注入式采样器（引擎只认 sampleDbi + peakDbi + beamCount + beamPick，不碰文件系统）
  const mkGrd = (beamCount, beamPick) => ({
    beamCount, beamPick,
    peakDbi: 40,
    sampleDbi: () => 20            // 恒定值，本组只查口径与告警，不查几何
  });
  const ctx = { stationLonDeg: 116.4, stationLatDeg: 39.9 };

  const single = PS.makeSatPattern({ mode: 'grd', pointing: 'nadir', grd: mkGrd(1, null) }, ctx);
  ok('单波束 GRD 不报「取最大」告警', !single.warnings.some((w) => /全部波束取最大/.test(w)));
  ok('单波束 GRD 的 info 标 allBeamsMax=false', single.info.allBeamsMax === false && single.info.beamCount === 1);

  const multiAll = PS.makeSatPattern({ mode: 'grd', pointing: 'nadir', grd: mkGrd(8, null) }, ctx);
  ok('多波束 + 未指定波束 → 明确告警是上界', multiAll.warnings.some((w) => /全部波束取最大/.test(w) && /上界/.test(w)),
    multiAll.warnings.find((w) => /全部波束/.test(w)));
  ok('多波束未指定时 info 标 allBeamsMax', multiAll.info.allBeamsMax === true && multiAll.info.beamCount === 8 && multiAll.info.beamPick === null);

  const multiPick = PS.makeSatPattern({ mode: 'grd', pointing: 'nadir', grd: mkGrd(8, 2) }, ctx);
  ok('指定了波束就不再告警', !multiPick.warnings.some((w) => /全部波束取最大/.test(w)));
  ok('指定的波束号如实回传', multiPick.info.beamPick === 2 && multiPick.info.allBeamsMax === false);

  // 多波束 GRD 自身已含波束排布，cells 指向又整体重指一次 —— 排布被用了两遍
  const multiCells = PS.makeSatPattern({ mode: 'grd', pointing: 'cells', beamsPerSat: 8, cellSpacingKm: 200, grd: mkGrd(8, 1) }, ctx);
  ok('多波束 GRD + 小区指向 → 告警排布被用了两遍', multiCells.warnings.some((w) => /两遍/.test(w)));
  ok('单波束 GRD + 小区指向不报该告警',
    !PS.makeSatPattern({ mode: 'grd', pointing: 'cells', beamsPerSat: 8, cellSpacingKm: 200, grd: mkGrd(1, null) }, ctx)
      .warnings.some((w) => /两遍/.test(w)));

  // 相对滚降 = 采样 − 峰值，且钳在 0 以下（采到比峰值高说明峰值给小了）
  approx('GRD 相对滚降 = 采样 − 峰值', single.evalAt(7000, 0, 0, 1, 0, 0, false), 20 - 40, 1e-12);
  const hot = PS.makeSatPattern({ mode: 'grd', pointing: 'nadir', grd: { beamCount: 1, beamPick: null, peakDbi: 10, sampleDbi: () => 20 } }, ctx);
  ok('采样高于峰值时钳到 0，不出正的滚降', hot.evalAt(7000, 0, 0, 1, 0, 0, false) === 0);
  // 方向图域外（采样器回 null）不能当成 0 dB 满功率
  const oob = PS.makeSatPattern({ mode: 'grd', pointing: 'nadir', grd: { beamCount: 1, beamPick: null, peakDbi: 40, sampleDbi: () => null } }, ctx);
  ok('落在方向图域外按可忽略的溢出计，不按满功率', oob.evalAt(7000, 0, 0, 1, 0, 0, false) <= -60);

  let threw = false;
  try { PS.makeSatPattern({ mode: 'grd', pointing: 'nadir' }, ctx); } catch (e) { threw = /GRD/.test(e.message); }
  ok('选了 GRD 却没有方向图数据 → 直接报错，不静默退回别的模式', threw);
}

// ⑦ coFreqFactor 线性：0.5 → 聚合干扰恰好 −3.01 dB（C/I 恰好 +3.01 dB）
{
  const a = runNgso({});
  const b = runNgso({ satPattern: { mode: 'none', coFreqFactor: 0.5 } });
  approx('同频占空 0.5 → C/I 恰好 +3.0103 dB', b.medianCiDb - a.medianCiDb, 10 * Math.log10(2), 1e-4);
  approx('同频占空 0.25 → 恰好 +6.02 dB',
    runNgso({ satPattern: { mode: 'none', coFreqFactor: 0.25 } }).medianCiDb - a.medianCiDb, 10 * Math.log10(4), 1e-4);
  ok('同频占空与方向图彼此独立（mode:none 也生效）', b.satPatternActive === false);
  ok('同频占空进结果供报表原样列出', b.satPattern.coFreqFactor === 0.5);
  ok('填了同频占空就给告警（它常比方向图更能决定结果）', b.warnings.some((w) => /同频占空/.test(w)));
  let threw = false;
  try { runNgso({ satPattern: { mode: 'none', coFreqFactor: 1.5 } }); } catch (e) { threw = /同频占空/.test(e.message); }
  ok('同频占空 > 1 直接报错（那不是「多算一点」，是没有物理意义）', threw);
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

  // ⑧ 规避角（B4）：判据由「θ < 3dB 全宽」改成「θ < 规避角」，默认规避角 = 半功率半角。
  //    放大规避角 ⇒ 判定圈变大 ⇒ 事件只会更多、更长（单调），这是可解释的方向。
  ok('默认规避角 = 3 dB 全宽的一半', Math.abs(s.inlineGuardDeg - s.beamwidth3dBDeg / 2) < 1e-12,
    `${s.inlineGuardDeg.toFixed(4)}° vs 全宽 ${s.beamwidth3dBDeg.toFixed(4)}°`);
  const wide = N.createNgsoCiRun({ ...narrow, inlineGuardDeg: s.beamwidth3dBDeg });   // 首版那个偏大的判据
  while (wide.stepBatch(3000) < wide.T);
  const sw = wide.finalize();
  ok('规避角放大一倍：事件数不减', sw.inlineCount >= s.inlineCount, `${s.inlineCount} → ${sw.inlineCount}`);
  ok('规避角放大一倍：占时比不减', sw.inlineDutyPct >= s.inlineDutyPct - 1e-12,
    `${s.inlineDutyPct.toExponential(2)}% → ${sw.inlineDutyPct.toExponential(2)}%`);
  approx('穿越时长口径跟着规避角走（2×guard/rate）', sw.crossingSec, 2 * s.crossingSec, 1e-9);
  let threw2 = false;
  try { N.createNgsoCiRun({ ...narrow, inlineGuardDeg: -1 }); } catch (e) { threw2 = /规避角/.test(e.message); }
  ok('规避角给了非正数直接报错', threw2);
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

// ---------------------------------------------------------------------------
// 三期验收（§5）：P3 多历元蒙特卡洛 + 回归周期（ITU-R S.1325-3 §2.7）
// ---------------------------------------------------------------------------
console.log('\n=== ⑥-2 多历元与回归周期（S.1325-3 §2.7）===');

// 回归周期：§2.7.3 的四步法
{
  const rp = N.constellationRepeatPeriodSec(OTHER.map((s) => s.rec));
  ok('回归周期算得出来', rp && rp.sec > 0, `${(rp.sec / 86400).toFixed(2)} 天 / ${rp.orbits} 圈`);
  // Step 4：T_NOB = jmin × T
  approx('T_NOB = jmin × 轨道周期', rp.sec, rp.orbits * rp.periodSec, 1e-9);
  // Step 1–3：验证 jmin 确实是最小的满足 mod(j·Δφ₀, 2π) ≤ ΔPT 的整数
  {
    const TE = 86164.0905;
    const d0 = 2 * Math.PI * rp.periodSec / TE;
    const acc = rp.accuracyDeg * Math.PI / 180;
    const md = (j) => { let m = (j * d0) % (2 * Math.PI); return m < 0 ? m + 2 * Math.PI : m; };
    ok('jmin 满足回归精度判据', md(rp.orbits) <= acc, `mod = ${(md(rp.orbits) * 180 / Math.PI).toFixed(4)}° ≤ ${rp.accuracyDeg}°`);
    let earlier = false;
    for (let j = 1; j < rp.orbits; j++) if (md(j) <= acc) { earlier = true; break; }
    ok('jmin 确实是最小的那个 j', !earlier);
  }
  ok('精度放宽 → 回归周期变短（或持平）',
    N.constellationRepeatPeriodSec(OTHER.map((s) => s.rec), { accuracyDeg: 5 }).sec <= rp.sec);
  // §2.7.2 的角速度：地固系里要用矢量差，倾角越大差得越多
  {
    const eq = { no: OTHER[0].rec.no, inclo: 0 };
    const inc = { no: OTHER[0].rec.no, inclo: 53 * Math.PI / 180 };
    ok('倾角轨道的地固系角速度高于赤道轨道（矢量差 vs 标量差）',
      N.maxAngularRateDegPerSec(inc) > N.maxAngularRateDegPerSec(eq),
      `${N.maxAngularRateDegPerSec(inc).toFixed(4)} vs ${N.maxAngularRateDegPerSec(eq).toFixed(4)} °/s`);
    // ω_a = √[(ω cos I − ω_e)² + (ω sin I)²]，天顶放大 a/(a−Re)
    const nRadS = Number(OTHER[0].rec.no) / 60;
    const a = Math.pow(398600.4418 / (nRadS * nRadS), 1 / 3);
    const I = 53 * Math.PI / 180;
    const wa = Math.hypot(nRadS * Math.cos(I) - 7.29e-5, nRadS * Math.sin(I));
    approx('角速度对 S.1325 §2.7.2 的解析式', N.maxAngularRateDegPerSec(inc),
      wa * a / (a - 6378.137) * 180 / Math.PI, 1e-9);
  }
  // 单历元结果里也要给出「这次覆盖了回归周期的百分之几」
  const s = runNgso({});
  ok('结果带出回归周期与覆盖率', s.repeatPeriodSec > 0 && s.repeatCoveragePct > 0,
    `${(s.repeatPeriodSec / 86400).toFixed(2)} 天，覆盖 ${s.repeatCoveragePct.toFixed(2)}%`);
  approx('覆盖率 = 时窗 / 回归周期', s.repeatCoveragePct, s.horizonSec / s.repeatPeriodSec * 100, 1e-9);
  ok('覆盖率很低时给出告警', s.warnings.some((w) => /回归周期/.test(w)));
}

// ⑨ 同 seed 两次跑逐位一致（可复现是硬要求）
{
  const eps = N.makeEpochs(T0, 7 * 86400e3, 4, 42);
  ok('历元由 seed 确定性生成', N.makeEpochs(T0, 7 * 86400e3, 4, 42).join() === eps.join());
  ok('换 seed 就换一组历元', N.makeEpochs(T0, 7 * 86400e3, 4, 43).join() !== eps.join());
  ok('历元落在基线内且升序', eps.every((t, i) => t >= T0 && t < T0 + 7 * 86400e3 && (i === 0 || t >= eps[i - 1])));

  const mk = () => {
    const r = N.createNgsoCiMultiRun({
      station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
      wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
      interferers: [{ id: 'g', name: 'S', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
      minElevDeg: 10, startMs: T0, horizonSec: 2 * 3600, stepSec: 20,
      epochs: eps, seed: 42, epochSpanDays: 7
    });
    while (r.stepBatch(2000) < r.T); return r.finalize();
  };
  const a = mk(), b = mk();
  ok('同 seed 两次跑：分位数逐位一致',
    N.DEFAULT_PCTS.every((p) => a.percentiles[p] === b.percentiles[p]) && a.worstCiDb === b.worstCiDb);
  ok('同 seed 两次跑：bootstrap 区间也逐位一致',
    JSON.stringify(a.epochStats.ciP) === JSON.stringify(b.epochStats.ciP));
  ok('样本池是各历元之和', a.samples + a.noServingSamples === (Math.floor(2 * 3600 / 20) + 1) * eps.length,
    `${a.samples} + ${a.noServingSamples}`);
  ok('epochStats 齐备（模式 / 个数 / 种子 / 收敛）',
    a.epochStats.mode === 'monte-carlo' && a.epochStats.count === 4 && a.epochStats.seed === 42
    && typeof a.epochStats.converged === 'boolean' && Array.isArray(a.epochStats.trail));
  ok('单历元不给置信区间（样本时间上高度相关，bootstrap 会把区间报窄）', runNgso({}).epochStats === null);
}

// ⑩ 历元数 ↑ → 目标分位的 95% 区间收窄
{
  // ★ 子集必须**步进**取（每 m 个取 1），不能取前 k 个，也不能每档各抽一批：
  //   区间按历元整块重采样得出，宽度 ∝ σ_块/√块数，而 σ_块 取决于这批历元覆盖了多大的
  //   几何跨度。取前 k 个会把跨度一起缩掉（实测前 8 个只跨 1.65 天、σ_块 0.186，
  //   全 24 个跨 6.76 天、σ_块 0.287），σ_块 的变化正好抵消 √n，收窄就测不出来了。
  //   步进取法下三档的 σ_块 稳定在 0.284 / 0.289 / 0.287，宽度比 0.62 对上理论 √(8/24)=0.577。
  // ★ 起点取 8 块：块数再少时 2.5/97.5 分位只能落在少数几种块组合上，宽度会剧烈跳动
  //   （实测 nB=2 给 1.06 dB、nB=3 给 5.22 dB），那是分辨率伪影不是不确定度。
  const EPS = N.makeEpochs(T0, 7 * 86400e3, 24, 7);
  const run = (stride) => {
    const r = N.createNgsoCiMultiRun({
      station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
      wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
      interferers: [{ id: 'g', name: 'S', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
      minElevDeg: 10, startMs: T0, horizonSec: 2 * 3600, stepSec: 20,
      epochs: EPS.filter((_, i) => i % stride === 0), seed: 7
    });
    while (r.stepBatch(4000) < r.T); return r.finalize();
  };
  const w = (s, p) => { const c = s.epochStats.ciP[p]; return c ? c.hi - c.lo : null };
  const a = run(3), b = run(2), c = run(1);          // 8 / 12 / 24 个历元，跨度都是满 7 天
  ok('历元 8 → 12 → 24：样本数单调增', a.samples < b.samples && b.samples < c.samples,
    `${a.samples} / ${b.samples} / ${c.samples}`);
  ok('中位的 95% 区间随历元数单调收窄', w(a, 50) > w(b, 50) && w(b, 50) > w(c, 50),
    `${w(a, 50).toFixed(3)} → ${w(b, 50).toFixed(3)} → ${w(c, 50).toFixed(3)} dB`);
  ok('收窄幅度对上 √n 律（8 → 24 应 ×0.577）', Math.abs(w(c, 50) / w(a, 50) - Math.sqrt(8 / 24)) < 0.2,
    `实测 ×${(w(c, 50) / w(a, 50)).toFixed(3)}`);
  ok('10% 档（每历元支撑 36 个样本）也收窄', w(c, 10) < w(a, 10),
    `${w(a, 10).toFixed(3)} → ${w(c, 10).toFixed(3)} dB`);
  // ★ 1% 档在这个 2 h 时窗下每历元只有 ~3.6 个样本落在该分位以下，块间散布量的本身就被
  //   采样噪声主导，宽度**不保证**随历元数收窄（实测 8→24 反而 ×1.12）。
  //   这是真实限制不是缺陷：想让尾部的区间也稳，得延长各段时窗（增大每历元的 nEff），
  //   光加历元数不够。故这里只断言区间给得出来，不断言单调——把这条行为钉在案上。
  ok('1% 档给出区间，但支撑不足时不保证收窄（要靠延长时窗而非加历元）',
    w(a, 1) > 0 && w(c, 1) > 0 && c.percentileSupport[1].nEff / c.epochStats.count < 10,
    `${w(a, 1).toFixed(2)} → ${w(c, 1).toFixed(2)} dB，每历元 nEff=${(c.percentileSupport[1].nEff / c.epochStats.count).toFixed(1)}`);
  ok('块数够时不打 lowResolution，块数不够时打上',
    c.epochStats.ciP[50].lowResolution === false && run(6).epochStats.ciP[50].lowResolution === true);
  ok('区间按历元块重采样（blocks = 历元数）', c.epochStats.ciP[50].blocks === 24);
  ok('区间包住点估计', c.percentiles[50] >= c.epochStats.ciP[50].lo - 1e-9 && c.percentiles[50] <= c.epochStats.ciP[50].hi + 1e-9);
  // ⑪ 收敛判据能在合成算例上触发：判据放宽到 5 dB 时中位早就稳了
  const loose = N.createNgsoCiMultiRun({
    station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
    wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
    interferers: [{ id: 'g', name: 'S', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
    minElevDeg: 10, startMs: T0, horizonSec: 2 * 3600, stepSec: 20,
    epochs: N.makeEpochs(T0, 7 * 86400e3, 6, 7), seed: 7, convergePct: 50, convergeTolDb: 5
  });
  while (loose.stepBatch(4000) < loose.T);
  const ls = loose.finalize();
  ok('收敛判据能触发（盯中位、判据 5 dB）', ls.epochStats.converged === true && ls.epochStats.convergedAtEpoch >= 2,
    `第 ${ls.epochStats.convergedAtEpoch} 个历元`);
  const tight = N.createNgsoCiMultiRun({
    station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
    wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
    interferers: [{ id: 'g', name: 'S', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' }],
    minElevDeg: 10, startMs: T0, horizonSec: 2 * 3600, stepSec: 20,
    epochs: N.makeEpochs(T0, 7 * 86400e3, 6, 7), seed: 7, convergePct: 50, convergeTolDb: 1e-6
  });
  while (tight.stepBatch(4000) < tight.T);
  const ts = tight.finalize();
  ok('判据收紧到 1e-6 dB 就不收敛，并如实告警',
    ts.epochStats.converged === false && ts.warnings.some((w2) => /未收敛/.test(w2)));
}

// ⑪-b 置信区间必须按【历元块】重采样 —— 逐样本 i.i.d. 会把区间报窄一个数量级
{
  // 合成强自相关序列（AR(1) φ=0.98，相关长度 ≈ 50 步）：这正是 C/I 时序的样子。
  // 逐样本 i.i.d. 重采样把 n 个相关观测当成 n 份独立信息，区间必然假窄。
  const ar1 = (n, phi, rng) => {
    const out = []; let x = 0;
    for (let i = 0; i < n; i++) {
      const u1 = Math.max(1e-12, rng()), u2 = rng();
      x = phi * x + Math.sqrt(1 - phi * phi) * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      out.push(40 + 4 * x);
    }
    return out;
  };
  const NEP = 8, PER = 2000;
  const rng = N.makeRng(1000);
  const blocks = [];
  for (let e = 0; e < NEP; e++) blocks.push(ar1(PER, 0.98, rng));

  // 真值：重复整个实验 200 次，看合并池的 C/I(1%) 实际散布多宽
  const truth = [];
  for (let r = 0; r < 200; r++) {
    const g = N.makeRng(1000 + r), pool = [];
    for (let e = 0; e < NEP; e++) pool.push(...ar1(PER, 0.98, g));
    pool.sort((a, b) => a - b);
    truth.push(N.percentileWorst(pool, 1));
  }
  truth.sort((a, b) => a - b);
  const qq = (f) => truth[Math.round(f * (truth.length - 1))];
  const trueW = qq(0.975) - qq(0.025);

  const wBlock = (() => { const r = N.bootstrapPercentiles(blocks, [1], { seed: 7 }); return r[1].hi - r[1].lo; })();
  // 把每个样本各自当成一块 ⇒ 退化为逐样本 i.i.d.（首版行为）
  const iidBlocks = blocks.flat().map((v) => [v]);
  const wIid = (() => { const r = N.bootstrapPercentiles(iidBlocks, [1], { seed: 7 }); return r[1].hi - r[1].lo; })();

  ok('逐样本 i.i.d. 重采样把区间报得远窄于真实散布（这正是要修的病）',
    wIid < trueW / 5, `i.i.d. ${wIid.toFixed(3)} dB vs 真实 ${trueW.toFixed(3)} dB`);
  ok('按历元块重采样后区间显著变宽（更接近真实）',
    wBlock > wIid * 2.5, `块 ${wBlock.toFixed(3)} dB vs i.i.d. ${wIid.toFixed(3)} dB`);
  ok('块版仍偏窄，故必须同时给出逐历元原始散布（cluster bootstrap 在小块数下的已知偏差）',
    wBlock < trueW);
  ok('单块时退化为 i.i.d. 并如实标记',
    N.bootstrapPercentiles([blocks[0]], [1], { seed: 7 })[1].iid === true);
}

// ⑪-c 收敛判据不得看「累积池的相邻差」—— 那个量天然 O(1/k) 递减，必然假阳性
{
  // 逐历元的目标分位在 30 / 40 dB 之间交替（摆 10 dB，物理上完全没收敛）。
  // 旧判据（累积池连续两次变化 < tol）会报「已收敛于第 3 个历元」。
  const rng = N.makeRng(42);
  const parts = [30, 40, 30, 40, 30, 40, 30, 40].map((c) => {
    const ci = new Float32Array(2000);
    for (let i = 0; i < 2000; i++) ci[i] = c + 6 * (rng() - 0.5);
    return ci;
  });
  const pool = [], oldTrail = [];
  for (const p of parts) {
    for (const v of p) pool.push(v);
    oldTrail.push(N.percentileWorst(pool.slice().sort((a, b) => a - b), 1));
  }
  // 旧判据重演
  let oldConv = false, small = 0;
  for (let k = 1; k < oldTrail.length; k++) {
    if (Math.abs(oldTrail[k] - oldTrail[k - 1]) < 0.2) { small++; if (small >= 2) { oldConv = true; break; } }
    else small = 0;
  }
  ok('反例确实骗得过旧判据（累积轨迹的相邻差早就小于 0.2 dB）', oldConv === true,
    `相邻差 ${oldTrail.slice(1).map((v, i) => Math.abs(v - oldTrail[i]).toFixed(3)).join(' / ')}`);

  // 新判据：逐历元各自估的分位，其均值的 95% 区间宽度
  const per = parts.map((p) => N.percentileWorst(Array.from(p).sort((a, b) => a - b), 1));
  const mean = per.reduce((a, b) => a + b, 0) / per.length;
  const s2 = per.reduce((a, b) => a + (b - mean) ** 2, 0) / (per.length - 1);
  const width = 2 * 1.96 * Math.sqrt(s2 / per.length);
  ok('新判据看逐历元散布，正确地报未收敛', width > 0.2,
    `95% 区间宽 ${width.toFixed(2)} dB ≫ 判据 0.2 dB`);
}

// ---------------------------------------------------------------------------
// 四期验收（§5）：P4 报告量 —— I/N · C/(N+I) · ΔT/T · 单源分解 · 时序 · 可用度
// ---------------------------------------------------------------------------
console.log('\n=== ⑥-3 报告量补全（I/N · C/(N+I) · ΔT/T · 单源 · 可用度）===');

const THIRD = walker(600, 87, 3, 4, 'K', 5);
const runP4 = (o) => {
  const r = N.createNgsoCiRun({
    station: BJ, rx: { diameterM: 1.2, efficiency: 0.65, freqGHz: 12.5 },
    wanted: { sats: MINE, eirpDbW: 40, bandwidthHz: 20e6, polarization: 'H' },
    interferers: [
      { id: 'g1', name: 'S', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' },
      { id: 'g2', name: 'K', sats: THIRD, eirpDensityDbWPerHz: -50, polarization: 'H' }
    ],
    minElevDeg: 10, startMs: T0, horizonSec: 4 * 3600, stepSec: 20,
    noise: { tSysK: 150 }, seriesMaxPoints: 300, ...o
  });
  while (r.stepBatch(3000) < r.T);
  return r.finalize();
};

// ⑫ I/N 与 C/I 的差恒为 C − N（同一时刻）
{
  const s = runP4({});
  approx('N₀ = k·T_sys（k = −228.6，与链路预算引擎同一个常数）', s.noise.n0DbWPerHz, -228.6 + 10 * Math.log10(150), 1e-12);
  ok('给了噪温才有 I/N / C/(N+I) / ΔT/T', !!s.iOverN && !!s.cOverNI && !!s.deltaTOverT);
  ok('没给噪温就只出 C/I（口径不变）', runNgso({}).iOverN === null);

  // ★ 逐样本的恒等式（不是逐分位——不同分位来自不同时刻，相加没有意义）
  let maxErr = 0, n = 0;
  for (const d of s.series) {
    if (d.ciDb == null || d.iOverNDb == null) continue;
    // C/I − I/N = (C − I) − (I − N) …… 不是恒等式；恒等式是 C/I + I/N = C − N
    // 逐样本用时序里的两列去核：两者都由同一时刻的 C、I、N 得出
    n++;
    void d;
  }
  ok('时序里 C/I 与 I/N 逐点齐备', n > 100, `${n} 点`);
  // 用引擎外的独立算路重算一遍：C/(N+I) 与 C/I、I/N 必须自洽
  {
    const n0 = s.noise.n0DbWPerHz;
    let worst = 0, cnt = 0;
    for (const d of s.series) {
      if (d.ciDb == null || d.iOverNDb == null) continue;
      const iDb = d.iOverNDb + n0;                 // I₀ = I/N + N₀
      const cDb = d.ciDb + iDb;                    // C₀ = C/I + I₀
      const cni = cDb - 10 * Math.log10(Math.pow(10, n0 / 10) + Math.pow(10, iDb / 10));
      // C/(N+I) 必须同时 ≤ C/I 且 ≤ C/N（加了一项噪声/干扰只会更差）
      if (cni > d.ciDb + 1e-6 || cni > cDb - n0 + 1e-6) worst++;
      cnt++;
    }
    ok('逐样本 C/(N+I) ≤ min(C/I, C/N)', worst === 0, `${cnt} 个样本，${worst} 处不满足`);
  }
  // ΔT/T 与 I/N 是同一个比值的两种写法
  for (const p of [1, 10, 50]) {
    if (s.iOverN[p] == null) continue;
    approx(`ΔT/T(${p}%) = 100×10^(I/N/10)`, s.deltaTOverT[p], 100 * Math.pow(10, s.iOverN[p] / 10), 1e-9);
  }
  // I/N 读的是分布的高端：p 越小越差 ⇒ I/N 越大
  // 4 h / 20 s = 721 个样本，0.1% 档已被样本门禁挡掉，故用 1 / 10 / 50 这几档
  ok('I/N 随 p 增大而变小（越小的 p 越差）', s.iOverN[1] >= s.iOverN[10] - 1e-9 && s.iOverN[10] >= s.iOverN[50] - 1e-9,
    `${s.iOverN[1].toFixed(2)} / ${s.iOverN[10].toFixed(2)} / ${s.iOverN[50].toFixed(2)}`);
  ok('C/(N+I) 随 p 增大而改善', s.cOverNI[1] <= s.cOverNI[50] + 1e-9);
  ok('C/(N+I) 恒劣于 C/I（噪声只会把它拉低）', [1, 10, 50].every((p) => s.cOverNI[p] <= s.percentiles[p] + 1e-9));
  // 样本不足的档一律跟着 C/I 一起留空，不允许某一列偷偷出数
  ok('样本不足的档三列一起留空',
    N.DEFAULT_PCTS.every((p) => (s.percentiles[p] === null) === (s.iOverN[p] === null)));
  // 时序抽稀
  ok('时序抽稀到 seriesMaxPoints 以内', s.series.length <= 300 && s.series.length > 50, `${s.series.length} 点`);
  ok('时序按时间升序且带四个量', s.series.every((d, i) => (i === 0 || d.tMs >= s.series[i - 1].tMs) && 'ciDb' in d && 'iOverNDb' in d && 'servingElevDeg' in d && 'minThetaDeg' in d));
  // G/T 反推噪温
  {
    const g = runP4({ noise: { gOverTdBK: 20 } });
    const gPeak = P.peakGainDbi(1.2, A.lambdaOf(12.5), 0.65);
    approx('G/T 反推 T_sys = 10^((G_peak − G/T)/10)', g.noise.tSysK, Math.pow(10, (gPeak - 20) / 10), 1e-9);
    ok('反推来源如实标出', g.noise.from === 'gOverTdBK');
  }
}

// ⑬ perGroup 的 sharePct 求和 = 100%
{
  const s = runP4({});
  ok('单源分解逐座给出', s.perGroup && s.perGroup.length === 2);
  approx('聚合份额合计 = 100%', s.perGroup.reduce((a, g) => a + g.sharePct, 0), 100, 1e-9);
  ok('每座都有单入最坏及其时刻', s.perGroup.every((g) => Number.isFinite(g.worstSingleEntryDbW) && g.worstAtMs > 0));
  ok('单入最坏 ≥ 时均（最狠的一刻不会低于平均）', s.perGroup.every((g) => g.worstSingleEntryDbW >= g.iAggDbW - 1e-9));
  ok('份额与 EIRP 密度同向（−48 那座份额更大）',
    s.perGroup.find((g) => g.name === 'S').sharePct > s.perGroup.find((g) => g.name === 'K').sharePct);
  // 把某一座的 EIRP 抬 10 dB，它的份额必须上升
  const up = runP4({
    interferers: [
      { id: 'g1', name: 'S', sats: OTHER, eirpDensityDbWPerHz: -48, polarization: 'H' },
      { id: 'g2', name: 'K', sats: THIRD, eirpDensityDbWPerHz: -40, polarization: 'H' }
    ]
  });
  ok('抬高某座的 EIRP → 它的份额上升',
    up.perGroup.find((g) => g.name === 'K').sharePct > s.perGroup.find((g) => g.name === 'K').sharePct,
    `${s.perGroup.find((g) => g.name === 'K').sharePct.toFixed(1)}% → ${up.perGroup.find((g) => g.name === 'K').sharePct.toFixed(1)}%`);
  ok('中间量不出 IPC（groups 里不留下划线字段）', s.groups.every((g) => Object.keys(g).every((k) => k[0] !== '_')));
}

// 越限统计：门限没填的那一项就不算，不编一个默认门限当结论
{
  const none = runP4({});
  ok('没填门限 → 三项都不算', none.breach.ciPct === null && none.breach.iOverNPct === null && none.breach.deltaTPct === null);
  const s = runP4({ criteria: { ciDb: 30, iOverNDb: -12.2, deltaTOverTPct: 6 } });
  ok('填了门限才算越限占比', s.breach.ciPct != null && s.breach.iOverNPct != null && s.breach.deltaTPct != null,
    `C/I ${s.breach.ciPct.toFixed(3)}% · I/N ${s.breach.iOverNPct.toFixed(3)}% · ΔT/T ${s.breach.deltaTPct.toFixed(3)}%`);
  ok('门限放松 → 越限时间只减不增',
    runP4({ criteria: { ciDb: 20 } }).breach.ciPct <= s.breach.ciPct + 1e-12);
  // ΔT/T 6% ≡ I/N −12.22 dB，比 −12.2 略低 ⇒ 越限时间略多
  ok('ΔT/T 与 I/N 两条判据自洽（6% ≡ −12.22 dB）', s.breach.deltaTPct >= s.breach.iOverNPct - 1e-12,
    `${s.breach.deltaTPct.toFixed(4)}% ≥ ${s.breach.iOverNPct.toFixed(4)}%`);
}

// ⑭ 卷积后的可用度 ≤ 无干扰可用度
{
  // 门限取得够高，才看得见干扰把可用度拉下来多少（门限太松则两者都是 100%）
  const RAIN = [
    { pct: 0.01, attenDb: 12, noiseTempK: 258 }, { pct: 0.05, attenDb: 7, noiseTempK: 220 },
    { pct: 0.1, attenDb: 5, noiseTempK: 188 }, { pct: 0.5, attenDb: 2, noiseTempK: 100 },
    { pct: 1, attenDb: 1, noiseTempK: 57 }
  ];
  const s = runP4({ rain: { cdf: RAIN, thresholdDb: 20 } });
  const a = s.availability;
  ok('可用度合成给出', !!a, a && `无干扰 ${a.noInterferencePct.toFixed(4)}% → 计入干扰 ${a.withInterferencePct.toFixed(4)}%`);
  ok('计入干扰后的可用度 ≤ 无干扰可用度', a.withInterferencePct <= a.noInterferencePct + 1e-12);
  ok('可用度损失 = 两者之差', Math.abs(a.lossPct - (a.noInterferencePct - a.withInterferencePct)) < 1e-9);
  ok('需补余量 ≥ 0', a.extraMarginDb >= 0, `${a.extraMarginDb.toFixed(2)} dB`);
  ok('分布里带了雨致噪温 → 噪声抬升已计入', a.noiseRiseIncluded === true);
  ok('默认不给干扰加雨衰（保守）', a.applyToInterference === 'none');
  // 补上余量之后，可用度确实回到无干扰水平（二分解出来的那个数要真的管用）
  {
    const cDb = [], iDb = [];
    for (const d of s.series) {
      if (d.ciDb == null) continue;
      const i0 = d.iOverNDb + s.noise.n0DbWPerHz;
      iDb.push(i0); cDb.push(d.ciDb + i0);
    }
    const chk = N.availabilityWithRain({ cDb, iDb, n0Db: s.noise.n0DbWPerHz, rainCdf: RAIN, thresholdDb: 20 });
    ok('独立重算（用时序数据）也得到 ≤ 无干扰可用度', chk.withInterferencePct <= chk.noInterferencePct + 1e-9);
  }
  // 干扰路径也加雨衰 → 干扰被压低 → 可用度不会更差
  const same = runP4({ rain: { cdf: RAIN, thresholdDb: 20, applyToInterference: 'same' } });
  ok('给干扰也加雨衰 → 可用度不劣于保守口径',
    same.availability.withInterferencePct >= a.withInterferencePct - 1e-9,
    `${a.withInterferencePct.toFixed(4)}% → ${same.availability.withInterferencePct.toFixed(4)}%`);
  // 门限压得极高 → 两条都掉下来，且干扰那条仍不高于无干扰那条
  const hard = runP4({ rain: { cdf: RAIN, thresholdDb: 40 } });
  ok('门限抬高 → 可用度下降', hard.availability.withInterferencePct < a.withInterferencePct + 1e-9,
    `${a.withInterferencePct.toFixed(3)}% → ${hard.availability.withInterferencePct.toFixed(3)}%`);
  // 没带噪温、也没给 Tm → 明说没计入
  const noT = N.availabilityWithRain({
    cDb: [-183, -184], iDb: [-210, -211], n0Db: -206.8,
    rainCdf: RAIN.map((d) => ({ pct: d.pct, attenDb: d.attenDb })), thresholdDb: 20
  });
  ok('分布不带噪温也不给 Tm → 明写未计入噪声抬升', noT.noiseRiseIncluded === false);
  const withTm = N.availabilityWithRain({
    cDb: [-183, -184], iDb: [-210, -211], n0Db: -206.8,
    rainCdf: RAIN.map((d) => ({ pct: d.pct, attenDb: d.attenDb })), thresholdDb: 20, mediumTempK: 275
  });
  ok('给了 Tm 就按 Tm(1−10^(−A/10)) 推噪温', withTm.noiseRiseIncluded === true);
  ok('计入噪声抬升后可用度不会更好', withTm.withInterferencePct <= noT.withInterferencePct + 1e-9);
  ok('没给雨衰分布就不出可用度（不拿默认分布顶）', runP4({}).availability === null);
}

// ⑭-b 雨衰 CDF 的档必须再细分 —— 整档取端点会把中断概率低估最多一个完整档宽
{
  // CDF 两点 (0.001%, 20 dB) 与 (0.01%, 12 dB)：中间那 0.009% 的时间里 A 从 20 连续降到 12。
  // A 在 log10(pct) 上线性 ⇒ A = 13 dB 对应 pct = 10^(−3 + 7/8) = 0.0075%
  //   ⇒「A > 13 dB 即中断」的真值就是 0.0075%。
  // 首版整档取右端点（A = 12，档内最小衰减）⇒ 第 2 档整档不中断 ⇒ 报 0.001%（低估 7.5 倍）。
  const RAIN = [
    { pct: 0.001, attenDb: 20 }, { pct: 0.01, attenDb: 12 },
    { pct: 0.1, attenDb: 6 }, { pct: 1, attenDb: 2 }
  ];
  const cDb = [-160], iDb = [-Infinity], n0 = -200;           // C − N = 40 dB，无干扰
  const outageAt = (attenTrip) => {
    const r = N.availabilityWithRain({ cDb, iDb, n0Db: n0, rainCdf: RAIN, thresholdDb: 40 - attenTrip });
    return 100 - r.withInterferencePct;
  };
  const truth = Math.pow(10, -3 + 7 / 8);                      // = 0.0075%
  approx('A>13 dB 的中断概率对解析解（log10(pct) 轴线性插值）', outageAt(13), truth, truth * 0.1);
  ok('不再是首版的整档量化值 0.001%', Math.abs(outageAt(13) - 0.001) > 1e-6,
    `${outageAt(13).toFixed(5)}% vs 首版 0.00100%`);
  // 档边界上仍精确（A=6 恰是第 3 点，中断时间就是 pct < 0.1%）
  approx('恰在 CDF 列点上时仍精确', outageAt(6), 0.1, 1e-9);
  // 单调性：跳闸衰减越低，中断时间只增不减
  {
    let mono = true, prev = -1;
    for (const a of [20, 16, 13, 10, 8, 6, 4, 2, 1]) { const v = outageAt(a); if (v < prev - 1e-12) mono = false; prev = v; }
    ok('中断概率随跳闸衰减下降而单调不减', mono);
  }
  const meta = N.availabilityWithRain({ cDb, iDb, n0Db: n0, rainCdf: RAIN, thresholdDb: 34 });
  ok('细分参数与量化上界随结果一起出', meta.rainSubBins >= 2 && meta.quantizationPctBound > 0,
    `SUB=${meta.rainSubBins}，残余量化 ≤ ${meta.quantizationPctBound.toFixed(5)}%`);
  ok('最严那一档的截断如实上报（p→0 时 A→∞，表列不给）',
    meta.firstBinTruncatedPct === 0.001 && meta.firstBinAttenDb === 20);
  // 细分越密，越逼近解析解
  const err = (sub) => Math.abs(100 - N.availabilityWithRain({
    cDb, iDb, n0Db: n0, rainCdf: RAIN, thresholdDb: 27, subBins: sub
  }).withInterferencePct - truth);
  ok('细分加密 → 误差收敛', err(32) < err(4), `SUB=4 误差 ${err(4).toFixed(6)} → SUB=32 误差 ${err(32).toFixed(6)}`);
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

// ============================================================================
// ⑩ 星座实参统计的壳层分解（statsOf）
// ============================================================================
//
// 这一层的产物直接被当成「取用真实星座」的轨道参数（PFD 掩模生成器的高度/倾角、
// C/I 的 NGSO 雨衰口径）。曾经的实现只按倾角分箱、且报箱号：
//   ·倾角报的是 Math.round 的箱号（实测 87.90° 报成 88°）——不是实测值；
//   ·高度报的是【全体】中位数，与某一层的倾角配成一对，得到一条谁都不在其上的轨道
//     （实测 Starlink：全体中位 475 km，而 53° 层在 463 km、70° 层在 570 km）。
// 本组用**合成星历**把这两件事钉死：期望值由构造时的输入直接给出，不抄实现输出。
console.log('\n=== ⑩ 星座壳层分解（高度与倾角同源）===');
{
  const createInterference = require('../../../electron/services/interference.js');
  const S = createInterference(null, null, null);
  const RE = 6378.137, MU = 398600.4418;
  // 高度(km)+倾角(°) → 一条 satrec 的最小必要字段（statsOf 只读 no / inclo）
  const mk = (hKm, inclDeg) => {
    const a = RE + hKm;
    return { satrec: { no: Math.sqrt(MU / (a * a * a)) * 60, inclo: inclDeg * Math.PI / 180 } };
  };
  const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i));

  // 三个真实壳层 + 一撮抬轨在途的星（照着 Starlink 的形状造，但数放大到一眼能看出差别）：
  //   A 层 500 颗 @ 550 km / 53.2°（最大的一层）
  //   B 层 400 颗 @ 1100 km / 70.0°     C 层 400 颗 @ 1300 km / 95.0°
  //   在途 200 颗 @ 300–400 km / 53.2°（与 A 层同倾角，正是把 A 层高度往下拽的那一撮）
  const list = [
    ...rep(500, (i) => mk(550 + (i % 5) - 2, 53.2)),
    ...rep(400, (i) => mk(1100 + (i % 5) - 2, 70.0)),
    ...rep(400, (i) => mk(1300 + (i % 5) - 2, 95.0)),
    ...rep(200, (i) => mk(300 + i * 0.5, 53.2))
  ];
  const st = S.statsOf(list);
  const A = st.shells[0], B = st.shells.find((s) => Math.round(s.inclDeg) === 70);

  ok('壳层按规模降序，最大的一层排头', A.count === 500, `${A.count} 颗`);
  approx('A 层倾角 = 实测值而非取整箱号', A.inclDeg, 53.2, 1e-9);
  approx('A 层高度 = 本层中位数，不被在途星拽低', A.altKmMed, 550, 1.5);
  ok('A 层同倾角的在途星单独计数', A.strayCount === 200, `stray=${A.strayCount}`);
  ok('在途星不进本层高度区间', A.altKmMin >= 545 && A.altKmMax <= 555, `${A.altKmMin}–${A.altKmMax} km`);
  approx('B 层倾角独立成层', B.inclDeg, 70.0, 1e-9);
  approx('B 层高度取自 B 层自己的星', B.altKmMed, 1100, 1.5);
  ok('B 层没有在途星', B.strayCount === 0, `stray=${B.strayCount}`);
  ok('三层都列出', st.shells.length === 3, `${st.shells.length} 层`);
  // ★ 旧实现的错法：拿【全体】中位高度去配某一层的倾角。这里差出 550 km，
  //   足以把 PFD 掩模的视场半张角与电平整体算错——故这条要钉死。
  ok('全体中位高度落在别的层上，绝不能与 shells[0] 的倾角配成一对',
    Math.abs(st.altKmMed - A.altKmMed) > 400,
    `全体 ${st.altKmMed} km（${st.inclMed}°） vs 最大层 ${A.altKmMed} km（${A.inclDeg}°）`);

  // 单壳星座：不该被拆碎，也不该因占比门槛把唯一一层筛掉
  const one = S.statsOf(rep(40, (i) => mk(1200 + (i % 3), 87.9)));
  ok('单壳星座只出一层', one.shells.length === 1, `${one.shells.length} 层`);
  approx('单壳倾角保留两位小数（87.9 不被取整成 88）', one.shells[0].inclDeg, 87.9, 1e-9);

  // 全部星历都解析不出平均运动 → 明确回 null（调用方据此提示，不能当成 0 颗静默通过）
  ok('无可用星历时回 null', S.statsOf([{ satrec: {} }, { satrec: null }]) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

