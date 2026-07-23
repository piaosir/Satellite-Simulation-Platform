// ITU-R P.618-14 §8 非静止轨道长期统计 精度/回归测试（无框架，纯断言）。
// 运行： node packages/core/test/ngsoElevStats.test.js
//
// 覆盖三层：
//   ① 解析仰角分布 —— 与「ψ×Δλ 二维暴力采样」交叉验证（验 Δλ 方向的解析积分 acos(X)/π）；
//   ② §8 求和 + 等效仰角反解 —— 单调性/边界/非单调陷阱；
//   ③ calculateRainAttenuation 的 NGSO 统计口径接线 —— 含退化情形与 GEO 路径不回归。
const fs = require('fs');
const path = require('path');
const core = require('../index.js');
const stats = require('../utils/ngsoElevStats.js');
const geo = require('../utils/linkCalculator.js');

const ituDir = path.join(__dirname, '..', '..', '..', 'resources', 'itu');
const rd = (f) => { try { return fs.readFileSync(path.join(ituDir, f)); } catch (e) { return null; } };
const rep = core.loadFullPrecisionData({
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
  console.log((c ? 'PASS' : 'FAIL') + '  ' + name + `  (got=${Number.isFinite(g) ? g.toFixed(4) : g}, want≈${want} ±${tol})`);
  c ? pass++ : fail++;
}

console.log('=== ITU-R P.618-14 §8 测试 ===\n');
ok('ITU 全精度数据注入', !!(rep && rep.rain === true));

// ───────────────────────── ① 解析仰角分布 vs 二维暴力采样 ─────────────────────────
const D2R = Math.PI / 180, RE = 6378.137;
// 暴力：对 (u, Δλ) 二维等间隔采样，直接按几何算仰角再分箱。与解析式独立实现，用于交叉验证。
function bruteDistribution(latDeg, altKm, inclDeg, minElevDeg, nu, nl) {
  const rho = RE / (RE + altKm), phi = latDeg * D2R, si = Math.abs(Math.sin(inclDeg * D2R));
  let vis = 0, tot = 0; const acc = new Map();
  for (let a = 0; a < nu; a++) {
    const u = 2 * Math.PI * (a + 0.5) / nu, psi = Math.asin(si * Math.sin(u));
    const sp = Math.sin(psi), cp = Math.cos(psi);
    for (let b = 0; b < nl; b++) {
      const dl = 2 * Math.PI * (b + 0.5) / nl;
      const cosG = Math.max(-1, Math.min(1, sp * Math.sin(phi) + cp * Math.cos(phi) * Math.cos(dl)));
      const el = Math.atan2(cosG - rho, Math.sin(Math.acos(cosG))) / D2R;
      tot++;
      if (el >= minElevDeg) { vis++; const k = Math.floor(el); acc.set(k, (acc.get(k) || 0) + 1); }
    }
  }
  return { visFrac: vis / tot, binOf: (loDeg) => (acc.get(loDeg) || 0) / tot };
}

console.log('\n-- ① 解析仰角分布 vs 二维暴力采样 --');
for (const c of [
  { n: '北京 LEO550/53°', lat: 39.9042, alt: 550, inc: 53, min: 10 },
  { n: '广州 MEO8000/45°', lat: 23.1291, alt: 8000, inc: 45, min: 10 },
  { n: '喀什 LEO1200/87°', lat: 39.4704, alt: 1200, inc: 87, min: 10 }
]) {
  const d = stats.circularElevDistribution({ latDeg: c.lat, altKm: c.alt, inclDeg: c.inc, minElevDeg: c.min, binDeg: 1 });
  const b = bruteDistribution(c.lat, c.alt, c.inc, c.min, 1200, 1200);
  approx(`${c.n} 可见时间占比`, d.visFrac * 100, b.visFrac * 100, 0.05);
  // 逐箱最大偏差（百分点）
  let maxDev = 0;
  for (const bin of d.bins) { const lo = Math.floor(bin.elDeg); maxDev = Math.max(maxDev, Math.abs(bin.w - b.binOf(lo)) * 100); }
  ok(`${c.n} 逐箱最大偏差 < 0.05 个百分点`, maxDev < 0.05, `(max=${maxDev.toFixed(4)})`);
  // 权重之和 = 可见占比
  const sum = d.bins.reduce((s, x) => s + x.w, 0);
  approx(`${c.n} Σw = visFrac`, sum, d.visFrac, 1e-9);
}

// 几何自洽：仰角 90° ⇒ 地心夹角 0；仰角 0° ⇒ 覆盖半角 arccos(ρ)
{
  const rho = RE / (RE + 550);
  approx('γ(90°) = 0°', stats.centralAngleDeg(90, rho), 0, 1e-9);
  approx('γ(0°) = arccos(ρ)', stats.centralAngleDeg(0, rho), Math.acos(rho) / D2R, 1e-9);
}
// 站纬远超轨道覆盖带 → 不可见
{
  const d = stats.circularElevDistribution({ latDeg: 78, altKm: 550, inclDeg: 5, minElevDeg: 10 });
  ok('高纬站 + 近赤道低轨 → 不可见（visFrac≈0）', d.visFrac < 1e-9 && d.bins.length === 0);
}
// 顺行 / 逆行同倾角带等价
{
  const a = stats.circularElevDistribution({ latDeg: 30, altKm: 800, inclDeg: 60, minElevDeg: 10 });
  const b = stats.circularElevDistribution({ latDeg: 30, altKm: 800, inclDeg: 120, minElevDeg: 10 });
  approx('i 与 180−i 分布一致', a.visFrac, b.visFrac, 1e-12);
}

// ───────────────────────── ② §8 求和 + 等效仰角 ─────────────────────────
console.log('\n-- ② §8 求和 + 等效仰角反解 --');
function mkAttenAt(lat, lon, freq, pol, R001) {
  const cache = new Map();
  return (elevDeg, pPct) => {
    const k = Math.round(elevDeg * 1000);
    let a = cache.get(k);
    if (a === undefined) { a = geo.calculateSinglePathRainAttenuation(R001, freq, pol, lat, lon, null, 0, elevDeg).A001; cache.set(k, a); }
    return geo.scaleRainAttenP618_14(a, pPct, lat, elevDeg);
  };
}

// 非单调性：广州高雨强站，雨衰在 ~60° 触底后回升 —— 等效仰角求解必须避开这个陷阱
{
  const R001 = core.rainRate.queryRainRate(23.1291, 113.2644).rainRate;
  const f = mkAttenAt(23.1291, 113.2644, 14.25, 'V', R001);
  const at = (e) => f(e, 0.1);
  ok('广州 A_R(p=0.1%) 对仰角非单调（60° 触底后回升）', at(90) > at(60) && at(60) < at(40), `(40°=${at(40).toFixed(2)} 60°=${at(60).toFixed(2)} 90°=${at(90).toFixed(2)})`);
}

const S8CASES = [
  // 锚点：与独立复算脚本一致（14.25 GHz / V / 海拔 0）
  { n: '北京 LEO550/53° θmin=25°', lat: 39.9042, lon: 116.4074, alt: 550, inc: 53, min: 25, av: 99.9, wantA: 4.151, wantEq: 34.4 },
  { n: '北京 LEO550/53° θmin=10°', lat: 39.9042, lon: 116.4074, alt: 550, inc: 53, min: 10, av: 99.9, wantA: 6.169, wantEq: 17.0 },
  { n: '广州 MEO8000/45° θmin=10°', lat: 23.1291, lon: 113.2644, alt: 8000, inc: 45, min: 10, av: 99.9, wantA: 12.216, wantEq: 21.7 },
  { n: '三亚 MEO8000/45° θmin=10°', lat: 18.2528, lon: 109.5119, alt: 8000, inc: 45, min: 10, av: 99.9, wantA: 13.045, wantEq: 21.7 }
];
for (const c of S8CASES) {
  const R001 = core.rainRate.queryRainRate(c.lat, c.lon).rainRate;
  const attenAt = mkAttenAt(c.lat, c.lon, 14.25, 'V', R001);
  const d = stats.circularElevDistribution({ latDeg: c.lat, altKm: c.alt, inclDeg: c.inc, minElevDeg: c.min, binDeg: 1 });
  const s = stats.solveP618S8({ bins: d.bins, p: 100 - c.av, minElevDeg: c.min, attenAt });
  approx(`${c.n} §8 雨衰`, s.atten, c.wantA, 0.05);
  approx(`${c.n} 等效仰角`, s.elevEq, c.wantEq, 0.2);
  ok(`${c.n} §8 ≤ 最低仰角口径（不再双重最坏）`, s.atten < s.attenAtMinElev, `(${s.atten.toFixed(2)} < ${s.attenAtMinElev.toFixed(2)} dB)`);
  ok(`${c.n} 等效仰角落在 [θmin, argmin]`, s.elevEq >= c.min - 1e-6 && s.elevEq <= s.argminDeg + 1e-6);
  // 一致性：等效仰角处的单仰角雨衰 == §8 结果（这正是「等效」的定义）
  approx(`${c.n} A(elevEq, p) == §8 值`, attenAt(s.elevEq, 100 - c.av), s.atten, 1e-3);
}

// 可用度越高，双重最坏的高估越大
{
  const lat = 39.9042, lon = 116.4074;
  const R001 = core.rainRate.queryRainRate(lat, lon).rainRate;
  const attenAt = mkAttenAt(lat, lon, 14.25, 'V', R001);
  const d = stats.circularElevDistribution({ latDeg: lat, altKm: 550, inclDeg: 53, minElevDeg: 10, binDeg: 1 });
  const gap = [99, 99.9, 99.99].map((av) => { const s = stats.solveP618S8({ bins: d.bins, p: 100 - av, minElevDeg: 10, attenAt }); return s.attenAtMinElev - s.atten; });
  ok('高估随可用度要求单调增大', gap[0] < gap[1] && gap[1] < gap[2], `(${gap.map((g) => g.toFixed(2)).join(' < ')} dB)`);
}
// 箱宽敏感性：ITU 原文示例 5° 与本实现默认 1° 应收敛到同一结果
{
  const lat = 23.1291, lon = 113.2644;
  const R001 = core.rainRate.queryRainRate(lat, lon).rainRate;
  const attenAt = mkAttenAt(lat, lon, 14.25, 'V', R001);
  const r = [5, 2, 1, 0.5].map((bd) => {
    const d = stats.circularElevDistribution({ latDeg: lat, altKm: 8000, inclDeg: 45, minElevDeg: 10, binDeg: bd });
    return stats.solveP618S8({ bins: d.bins, p: 0.1, minElevDeg: 10, attenAt }).atten;
  });
  ok('箱宽 5°/2°/1°/0.5° 结果收敛（极差 < 0.3 dB）', Math.max.apply(null, r) - Math.min.apply(null, r) < 0.3, `(${r.map((x) => x.toFixed(3)).join(' / ')})`);
}
// 域外保护
{
  const d = stats.circularElevDistribution({ latDeg: 30, altKm: 550, inclDeg: 53, minElevDeg: 10 });
  const f = mkAttenAt(30, 114, 14.25, 'V', 50);
  ok('可用度 90%（p=10%>5%）被拒', !!stats.solveP618S8({ bins: d.bins, p: 10, minElevDeg: 10, attenAt: f }).error);
  ok('p=0 被拒', !!stats.solveP618S8({ bins: d.bins, p: 0, minElevDeg: 10, attenAt: f }).error);
  ok('空分布被拒', !!stats.solveP618S8({ bins: [], p: 0.1, minElevDeg: 10, attenAt: f }).error);
}

// ───────────────────────── ③ calculateRainAttenuation 接线 ─────────────────────────
console.log('\n-- ③ 雨衰计算器 NGSO 统计口径接线 --');
const NG = {
  lat: 23.1291, lon: 113.2644, altitude: 0, freq: 14.25, pol: 'V', diameter: 1.2, efficiency: 60,
  availability: 99.9, rainRate: 0, systemNoiseTemp: 150, feederLoss: 0.2, direction: 'down',
  ngsoStat: true, orbitAltKm: 8000, inclDeg: 45, minElevDeg: 10
};
const rn = core.calculateRainAttenuation(NG);
ok('NGSO 统计口径计算无错误', !rn.error, rn.message || '');
ok('返回 s8 诊断块', !!(rn.s8 && Number.isFinite(rn.s8.elevEq)));
approx('elevation == §8 等效仰角', rn.elevation, rn.s8.elevEq, 1e-9);
approx('rainAtten == §8 雨衰', rn.rainAtten, rn.s8.atten, 1e-3);
ok('高估量记录正确', Math.abs(rn.s8.overestimateAtMinElev - (rn.s8.attenAtMinElev - rn.s8.atten)) < 1e-9);
ok('可见时间占比合理 (0,1]', rn.s8.visFrac > 0 && rn.s8.visFrac <= 1, `(${(rn.s8.visFrac * 100).toFixed(2)}%)`);

// 与「按最低仰角填」的旧口径对照：所有雨衰派生量都应松一口气
const old = core.calculateRainAttenuation(Object.assign({}, NG, { ngsoStat: false, elevation: 10 }));
ok('旧口径（最低仰角）雨衰更大', old.rainAtten > rn.rainAtten, `(${old.rainAtten.toFixed(2)} → ${rn.rainAtten.toFixed(2)} dB)`);
ok('派生量同向：G/T 衰减更小', rn.gtDegradation < old.gtDegradation, `(${old.gtDegradation.toFixed(2)} → ${rn.gtDegradation.toFixed(2)} dB)`);
ok('派生量同向：DND 更小', rn.dnd < old.dnd, `(${old.dnd.toFixed(2)} → ${rn.dnd.toFixed(2)} dB)`);
ok('派生量同向：雨致 XPD 更高', rn.rainXPD > old.rainXPD, `(${old.rainXPD.toFixed(2)} → ${rn.rainXPD.toFixed(2)} dB)`);
ok('派生量同向：气体吸收更小（仰角抬高）', rn.gasAtten < old.gasAtten);

// 退化情形
{
  const noRain = core.calculateRainAttenuation(Object.assign({}, NG, { rainRate: 0, rainRateExact: true }));
  ok('R0.01%=0 → 退化标记 norain + 仰角取最低仰角', !noRain.error && noRain.s8.degenerate === 'norain' && Math.abs(noRain.elevation - 10) < 1e-9);
  // 极小但非零的降雨率：正常走求解分支，得到近零雨衰（不应报错、也不该被当成退化）
  const tiny = core.calculateRainAttenuation(Object.assign({}, NG, { rainRate: 1e-7, rainRateExact: true }));
  ok('R0.01%≈0（极小非零）→ 正常求解、雨衰近零', !tiny.error && tiny.s8.degenerate == null && tiny.rainAtten < 1e-4, tiny.message || '');
  // 站址高于雨高（P.618-14 Step 2 判 A=0）：各仰角衰减恒 0 → 优雅退化 noatten，不报错
  const aloft = core.calculateRainAttenuation(Object.assign({}, NG, { altitude: 9000 }));
  ok('站址高于雨高 → 优雅退化 noatten，不报错', !aloft.error && aloft.s8.degenerate === 'noatten' && aloft.rainAtten === 0, aloft.message || '');
  const clear = core.calculateRainAttenuation(Object.assign({}, NG, { availability: 100 }));
  ok('可用度 100% → 退化标记 clearsky + 雨衰 0', !clear.error && clear.s8.degenerate === 'clearsky' && clear.rainAtten === 0);
}
// 缺参 / 不可见
{
  const m1 = core.calculateRainAttenuation(Object.assign({}, NG, { orbitAltKm: undefined }));
  ok('缺轨道高度 → 明确报错', m1.error && /轨道高度/.test(m1.message), m1.message);
  const m2 = core.calculateRainAttenuation(Object.assign({}, NG, { lat: 78, lon: 20, orbitAltKm: 550, inclDeg: 5 }));
  ok('轨道对本站不可见 → 明确报错', m2.error && /不可见/.test(m2.message), m2.message);
}
// 曲线扫描：仰角轴必须回落到单仰角口径（否则 x 被等效仰角盖掉，曲线变成常数）
{
  const sw = core.sweepRainAttenuation(NG, 'elevation', { min: 10, max: 80, steps: 15 });
  const ys = sw.points.map((q) => q.y).filter((y) => y != null);
  ok('仰角轴扫描不被 §8 覆盖（曲线非常数）', ys.length > 10 && (Math.max.apply(null, ys) - Math.min.apply(null, ys)) > 1);
  const sa = core.sweepRainAttenuation(NG, 'availability', { min: 99, max: 99.99, steps: 12 });
  const ya = sa.points.map((q) => q.y).filter((y) => y != null);
  ok('可用度轴扫描在 §8 口径下单调递增', ya.length > 8 && ya.every((v, i) => i === 0 || v >= ya[i - 1] - 1e-9));
}

// GEO 路径不回归（§8 分支必须完全不介入）
{
  const g = core.calculateRainAttenuation({
    lat: 11, lon: 111, satLon: 125, freq: 14.5, pol: 'C', diameter: 13, efficiency: 60,
    availability: 99, rainRate: 0, systemNoiseTemp: 121, direction: 'down', altitude: 0, feederLoss: 0
  });
  ok('GEO 锚点不受影响（s8 = null）', !g.error && g.s8 === null);
  approx('GEO 锚点仰角 ≈ 69.19°', g.elevation, 69.19, 0.2);
  approx('GEO 锚点雨衰 ≈ 2.05 dB', g.rainAtten, 2.05, 0.15);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exitCode = fail ? 1 : 0;
