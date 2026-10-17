// 对比：平台 calculateAtmosphericAttenuation（P.676-9/10 Annex 2 旧闭式 γ + P.676-13 等效高度）
//       vs P.676-13 Annex 2 正式口径（γ 由 Annex 1 逐线法算 + 同一套等效高度）
// 线表取自 ITU-Rpy data/676/v13_lines_*.txt（P.676-13 Table 1/2 转录）
const fs = require('fs');
const path = require('path');
const REPO = 'C:/Users/85256/WeChatProjects/卫星仿真平台';
const lc = require(path.join(REPO, 'packages/core/utils/linkCalculator.js'));
const { P676_PART1 } = require(path.join(REPO, 'packages/core/utils/p676Data.js'));
const DL = path.join(__dirname, 'dl_itur');

function loadTab(f) {
  const rows = fs.readFileSync(path.join(DL, f), 'utf8').trim().split(/\r?\n/).slice(1);
  return rows.map(r => r.split(',').map(Number));
}
const OX = loadTab('v13_lines_oxygen.txt');
const WV = loadTab('v13_lines_water_vapour.txt');

function gamma0Exact(f, p, rho, T) {
  const th = 300 / T, e = rho * T / 216.7;
  let N = 0;
  for (const [fi, a1, a2, a3, a4, a5, a6] of OX) {
    let df = a3 * 1e-4 * (p * Math.pow(th, 0.8 - a4) + 1.1 * e * th);
    df = Math.sqrt(df * df + 2.25e-6);
    const dl = (a5 + a6 * th) * 1e-4 * (p + e) * Math.pow(th, 0.8);
    const F = f / fi * ((df - dl * (fi - f)) / ((fi - f) ** 2 + df * df) + (df - dl * (fi + f)) / ((fi + f) ** 2 + df * df));
    const S = a1 * 1e-7 * p * th ** 3 * Math.exp(a2 * (1 - th));
    N += S * F;
  }
  const d = 5.6e-4 * (p + e) * Math.pow(th, 0.8);
  const ND = f * p * th * th * (6.14e-5 / (d * (1 + (f / d) ** 2)) + 1.4e-12 * p * Math.pow(th, 1.5) / (1 + 1.9e-5 * Math.pow(f, 1.5)));
  return 0.1820 * f * (N + ND);
}
function gammawExact(f, p, rho, T) {
  const th = 300 / T, e = rho * T / 216.7;
  let N = 0;
  for (const [fi, b1, b2, b3, b4, b5, b6] of WV) {
    let df = b3 * 1e-4 * (p * Math.pow(th, b4) + b5 * e * Math.pow(th, b6));
    df = 0.535 * df + Math.sqrt(0.217 * df * df + 2.1316e-12 * fi * fi / th);
    const F = f / fi * (df / ((fi - f) ** 2 + df * df) + df / ((fi + f) ** 2 + df * df));
    const S = b1 * 1e-1 * e * th ** 3.5 * Math.exp(b2 * (1 - th));
    N += S * F;
  }
  return 0.1820 * f * N;
}
function interpH0(f) {
  const d = P676_PART1; const n = d.length;
  if (f <= d[0][0]) return d[0].slice(1);
  if (f >= d[n - 1][0]) return d[n - 1].slice(1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m][0] <= f) lo = m; else hi = m; }
  const t = (f - d[lo][0]) / (d[hi][0] - d[lo][0]);
  return [1, 2, 3, 4].map(k => d[lo][k] + t * (d[hi][k] - d[lo][k]));
}
function hw(f) {
  return 5.6585e-5 * f + 1.8348 + 2.6846 / ((f - 22.235080) ** 2 + 2.7649) + 5.8905 / ((f - 183.310087) ** 2 + 4.9219) + 2.9810 / ((f - 325.152888) ** 2 + 3.0748);
}
// P.676-13 Annex 2 正式口径（θ≥5°）
function annex2Official(f, el, Ptot, T, rho) {
  const e = rho * T / 216.7, p = Ptot - e;
  const g0 = gamma0Exact(f, p, rho, T), gw = gammawExact(f, p, rho, T);
  const [a0, b0, c0, d0] = interpH0(f);
  const h0 = a0 + b0 * T + c0 * Ptot + d0 * rho;
  return { A: (g0 * Math.max(h0, 0) + gw * Math.max(hw(f), 0)) / Math.sin(el * Math.PI / 180), g0, gw };
}

const SITES = [
  { name: '标准大气(ValEx 伦敦口径)', P: 1009.486, T: 283.611, rho: 13.7965 },
  { name: '广州 湿热', P: 1010, T: 296.3, rho: 21.0 },
  { name: '北京', P: 1003, T: 285.5, rho: 9.5 },
  { name: '拉萨 高原干', P: 652, T: 281.5, rho: 5.0 },
];
const FREQS = [4, 6, 12, 14.25, 18, 20, 22.235, 24, 27.5, 30, 38, 40, 42, 47, 50, 51.5, 54, 57, 60, 66, 71, 76, 81, 86];
const EL = 30;
console.log('el=' + EL + '°  A_platform / A_official (dB)  Δ%');
for (const s of SITES) {
  console.log('=== ' + s.name + ` P=${s.P} T=${s.T} ρ=${s.rho}`);
  for (const f of FREQS) {
    const plat = lc.calculateAtmosphericAttenuation(f, EL, s.P, s.T, s.rho);
    const off = annex2Official(f, EL, s.P, s.T, s.rho);
    console.log(`${String(f).padStart(7)} GHz  plat ${plat.toFixed(3).padStart(8)}  off ${off.A.toFixed(3).padStart(8)}  Δ ${(plat - off.A).toFixed(3).padStart(8)} dB  ${((plat / off.A - 1) * 100).toFixed(1).padStart(6)}%`);
  }
}
// ValEx 单点（报告里那条：14.25 GHz、31.077°、1009.486 hPa、283.611 K、13.7965 g/m³；官方 P.676-12 值 0.22687 dB）
const v = annex2Official(14.25, 31.07699, 1009.486, 283.611, 13.7965);
console.log('\nValEx 单点 14.25 GHz：平台', lc.calculateAtmosphericAttenuation(14.25, 31.07699, 1009.486, 283.611, 13.7965).toFixed(5), ' 本脚本P.676-13正式口径', v.A.toFixed(5), ' 报告所引官方(P.676-12) 0.22687');
module.exports = { annex2Official, gamma0Exact, gammawExact };
