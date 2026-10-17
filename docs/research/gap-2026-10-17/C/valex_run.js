// 用 ITU-R SG3 官方验证算例 CG-3M3J-13-ValEx-Rev8.3.0（2024-12）逐表对拍平台纯函数。
// 只读：从仓库 require 生产代码，全精度 ITU 数据按 electron/main.js 同法注入。
const fs = require('fs');
const path = require('path');
const Module = require('module');
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台';
const core = require(path.join(REPO, 'packages/core/index.js'));
const lc = require(path.join(REPO, 'packages/core/utils/linkCalculator.js'));
const { getIsothermHeight } = require(path.join(REPO, 'packages/core/utils/isothermHeight.js'));
const rainRate = require(path.join(REPO, 'packages/core/utils/rainRate.js'));
const elevation = require(path.join(REPO, 'packages/core/utils/elevation.js'));
const vapor = require(path.join(REPO, 'packages/core/data/waterVaporGrid.js'));
const cloudGrid = require(path.join(REPO, 'packages/core/data/cloudParamsGrid.js'));

const ituDir = path.join(REPO, 'resources', 'itu');
const rd = (f) => { try { return fs.readFileSync(path.join(ituDir, f)); } catch (e) { return null; } };
const rep = core.loadFullPrecisionData({ rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'), vapor: rd('p836_rho_v1.bin'), cloud: rd('p840_logn_v1.bin') });

// 取 linkCalculator.js 的内部函数（不改仓库：读源码 + 追加导出，在原路径下编译，require 相对路径照常解析）
function loadInternal(file, names) {
  const src = fs.readFileSync(file, 'utf8') + '\n;module.exports.__int = {' + names.join(',') + '};';
  const m = new Module(file, null);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src, file);
  return m.exports.__int;
}
const LCI = loadInternal(path.join(REPO, 'packages/core/utils/linkCalculator.js'),
  ['calcSpecificAttenOxygen', 'calcSpecificAttenWaterVapor', 'calcEquivHeightOxygen', 'calcEquivHeightWaterVapor']);

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'valex.json'), 'utf8'));
const polOf = (tau) => (Math.abs(tau) < 1e-9 ? 'H' : Math.abs(tau - 90) < 1e-9 ? 'V' : Math.abs(tau - 45) < 1e-9 ? 'C' : null);
function stats(name, rows, unit) {
  const d = rows.map(r => r.d).filter(Number.isFinite);
  const ad = d.map(Math.abs);
  const rel = rows.map(r => r.rel).filter(Number.isFinite).map(Math.abs);
  const max = ad.length ? Math.max(...ad) : NaN;
  const mean = d.length ? d.reduce((a, b) => a + b, 0) / d.length : NaN;
  const relMax = rel.length ? Math.max(...rel) : NaN;
  console.log(`${name.padEnd(46)} n=${String(rows.length).padStart(3)}  max|Δ|=${max.toExponential(3)} ${unit}  meanΔ=${mean.toExponential(3)}  max|rel|=${(relMax * 100).toFixed(3)}%`);
}
const out = {};
console.log('全精度数据注入：', JSON.stringify(rep));

// ① P.838-3：k、α、γR（按 H/V/C 三档；任意 τ 平台不支持）
{
  const rows = [], skipped = [];
  for (const r of V['P.838-3 Sp.Att']) {
    const pol = polOf(r.I);
    if (!pol) { skipped.push(r.I); continue; }
    const [k, a] = lc.getCoefficients(r.G, pol, r.F);
    const g = k * Math.pow(r.H, a);
    rows.push({ d: g - r.P, rel: g / r.P - 1, k, kv: r.N });
  }
  stats('P.838-3 γR (dB/km)', rows, 'dB/km');
  if (skipped.length) console.log('   跳过（平台无法表达的 τ）：', [...new Set(skipped)]);
}
// ② P.839-4 雨高
{
  const rows = V['P.839-4 Rain_Height'].map(r => { const h = getIsothermHeight(r.C, r.D) + 0.36; return { d: h - r.G, rel: h / r.G - 1 }; });
  stats('P.839-4 hR (km)', rows, 'km');
}
// ③ P.837-7 R0.01（只比 p=0.01 行；平台没有 Rp(p) 全方法）
{
  const all = V['P.837-7 Rp'];
  const r001 = all.filter(r => Math.abs(r.E - 0.01) < 1e-12);
  const rows = r001.map(r => { const q = rainRate.queryRainRate(r.C, r.D).rainRate; return { d: q - r.AQ, rel: r.AQ > 0 ? q / r.AQ - 1 : NaN }; });
  stats('P.837-7 R0.01 (mm/h)', rows, 'mm/h');
  console.log(`   ValEx Rp 共 ${all.length} 行（p=${[...new Set(all.map(r => r.E))].join('/')}%），平台只能算 p=0.01% 的 ${r001.length} 行`);
}
// ④ P.618-14 雨衰：A0.01 与 Ap（R0.01 用算例给定值，hR 用平台自己的 P.839 图）
{
  const rowsA = [], rowsP = [], rowsH = [];
  for (const r of V['P.618-14 A_Rain']) {
    const pol = polOf(r.I);
    const { A001, hR } = lc.calculateSinglePathRainAttenuation(r.L, r.G, pol, r.C, r.D, null, r.F, r.H);
    const Ap = lc.scaleRainAttenP618_14(A001, r.J, r.C, r.H);
    rowsA.push({ d: A001 - r.S, rel: A001 / r.S - 1 });
    rowsP.push({ d: Ap - r.U, rel: Ap / r.U - 1 });
    rowsH.push({ d: hR - r.K });
  }
  stats('P.618-14 A0.01 (dB)', rowsA, 'dB');
  stats('P.618-14 Ap (dB)', rowsP, 'dB');
  stats('   其中 hR 与算例差 (km)', rowsH, 'km');
}
// ⑤ P.618-14 闪烁：ValEx 的 Nwet（P.453 中值） vs 平台写死的 42
{
  const rowsV = [], rows42 = [];
  for (const r of V['P.618-14 A_Scint']) {
    const a = lc.calculateScintillationFading(r.G, r.H, r.I, 100 - r.K, r.J, r.L);
    const b = lc.calculateScintillationFading(r.G, r.H, r.I, 100 - r.K, r.J);
    rowsV.push({ d: a - r.R, rel: a / r.R - 1 });
    rows42.push({ d: b - r.R, rel: b / r.R - 1 });
  }
  stats('P.618-14 AS（喂算例 Nwet）(dB)', rowsV, 'dB');
  stats('P.618-14 AS（平台 Nwet=42）(dB)', rows42, 'dB');
}
// ⑥ P.618-14 XPD
{
  const rows = [];
  for (const r of V['P.618-14 XPD']) {
    const x = lc.calculateRainXPD_P618_14(r.K, r.H, r.J, r.I, r.G);
    rows.push({ d: x - r.T, rel: x / r.T - 1, el: r.I });
  }
  stats('P.618-14 XPD (dB)', rows, 'dB');
  const hi = rows.filter(r => r.el > 60);
  if (hi.length) stats('   其中 θ>60°（平台钳到 60°）', hi, 'dB');
}
// ⑦ P.840-9 云衰（Annex 1 L 图法 与 对数正态法 两种）
{
  const rowsL = [], rowsLN = [], rowsCap = [];
  for (const r of V['P.840-9 A_Clouds']) {
    const plat = lc.calculateCloudAttenuation(r.F, r.G, r.E, r.C, r.D);
    rowsL.push({ d: plat - r.M, rel: plat / r.M - 1 });
    if (Number.isFinite(r.Z)) rowsLN.push({ d: plat - r.Z, rel: plat / r.Z - 1, p: r.E });
  }
  stats('P.840-9 AC 对 L(p) 图法 (dB)', rowsL, 'dB');
  stats('P.840-9 AC 对 对数正态法 (dB)', rowsLN, 'dB');
  stats('   其中 p<1%（平台封顶 1%）', rowsLN.filter(r => r.p < 1), 'dB');
  stats('   其中 p≥1%（只剩 KL 差）', rowsLN.filter(r => r.p >= 1), 'dB');
}
// ⑧ P.840-9 Lred（年统计，平台对数正态参数图）
{
  const rows = [];
  for (const r of V['P840_9_L']) {
    if (!Number.isFinite(r.G)) continue;
    const pp = cloudGrid.getParams(r.C, r.D);
    const L = pp ? lc.cloudLWCFromLognormal(r.E, pp) : NaN;
    rows.push({ d: L - r.G, rel: L / r.G - 1 });
  }
  stats('P.840-9 L(p)（平台对数正态 vs 算例 L 图）', rows, 'kg/m²');
}
// ⑨ P.676-13 Annex 2 瞬时斜路径（A_Gas_A2_INST）
{
  const rows = [], rowsG0 = [], rowsGw = [];
  for (const r of V['P.676-13 A_Gas_A2_INST']) {
    const Ps = r.C, Ts = r.E, f = r.F, rho = r.I, el = r.J;
    const A = lc.calculateAtmosphericAttenuation(f, el, Ps, Ts, rho);
    rows.push({ d: A - r.AG, rel: A / r.AG - 1 });
    const g0 = LCI.calcSpecificAttenOxygen(f, Ps / 1013.25, 288.15 / Ts);
    const gw = LCI.calcSpecificAttenWaterVapor(f, Ps / 1013.25, 288.15 / Ts, rho);
    rowsG0.push({ d: g0 - r.K, rel: g0 / r.K - 1 });
    rowsGw.push({ d: gw - r.AB, rel: gw / r.AB - 1 });
  }
  stats('P.676-13 A_gas 瞬时斜路径 (dB)', rows, 'dB');
  stats('   γo（旧闭式 vs 逐线法）(dB/km)', rowsG0, 'dB/km');
  stats('   γw（旧闭式 vs 逐线法）(dB/km)', rowsGw, 'dB/km');
}
// ⑩ P.453-14 Nwet：平台无此图（闪烁写死 42）
{
  const rows = V['P.453-14 Nwet'].map(r => ({ d: 42 - r.F, rel: 42 / r.F - 1 }));
  stats('P.453-14 Nwet（平台常数 42）', rows, 'N');
}
// ⑪ P.836-6 ρ(p)：平台只有 RHO_90（晴）/ RHO_10（雨）两张、无高度订正
{
  const rows = [];
  for (const r of V['P.836-6 WV']) {
    if (!Number.isFinite(r.I)) continue;
    const plat = vapor.getRhoWs(r.C, r.D, true);   // 平台雨天口径 = RHO_10
    rows.push({ d: plat - r.I, rel: plat / r.I - 1, p: r.G });
  }
  stats('P.836-6 ρ(p)（平台恒取 ρ(10%)）', rows, 'g/m³');
  console.log('   ValEx p 档：', [...new Set(V['P.836-6 WV'].map(r => r.G))].join('/'), '%');
}
// ⑫ P.1511-3 地形高度
{
  const rows = [];
  for (const r of V['P.1511 TOPO']) {
    if (!Number.isFinite(r.E)) continue;
    const q = elevation.queryElevation(r.C, r.D);
    const h = q && q.success ? q.altitude : NaN;
    rows.push({ d: h - r.E });
  }
  stats('P.1511-3 地形高度 (m)', rows, 'm');
}
