// ITU-R P.452-18 晴空传播测试（无框架，纯断言）。
//   运行： node packages/core/test/p452.test.mjs
//
// 三层：
//   ① 官方验证例逐例对拍 —— ITU-R 第 3 研究组「Validation examples for Recommendation ITU-R P.452-18 -
//      Ver 18.0」（OFCOM，版权放弃声明）：17 条剖面 × 35 组 = 595 例。每例比 Lb 与 8 个分机制损耗
//      （Lbfsg、Lb0p、Lb0β、Ldsph、Ld50、Ldp、Lbs、Lba），每剖面比 20 个剖面分析中间量与路径类型。
//      容差取官方 validate_p452.m 的 1e−6；CSV 损耗列打印到 8 位小数、中间量 6 位小数，故预期最大偏差
//      分别 ≈ 5e−9 dB、≈ 5e−7（打印舍入）。夹具由 scripts/build-itu-p452.mjs --validation 从官方 zip 生成。
//   ② 无线电气象地图 —— 随包 .bin 与网格节点原值、双线性内插、注入接口。
//   ③ 独立公式核对 —— 期望值在测试里按建议书原文现算，不抄实现的输出：附录 3 逆正态近似的误差界、
//      式 (1) 最坏月换算、式 (2)–(4) β0、J(ν)、§4.6 几何、旧口径 / P.2108 终端杂波修正的叠加关系、边界与报错。

import { createRequire } from 'module';
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const P = require('../utils/terrestrial/p452.js');
const C = require('../utils/terrestrial/common.js');

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

console.log('=== ① 官方验证例（P.452-18 Ver 18.0）===');

const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'p452_18_validation.json.gz'))));
const LOSS = ['Lb', 'Lbfsg', 'Lb0p', 'Lb0b', 'Ldsph', 'Ld50', 'Ldp', 'Lbs', 'Lba'];
const MID = { ae: 'ae', dtot: 'dtot', hts: 'hts', hrs: 'hrs', theta_t: 'thetaT', theta_r: 'thetaR', theta: 'theta', hm: 'hm',
  hte: 'hte', hre: 'hre', hstd: 'hstd', hsrd: 'hsrd', dlt: 'dlt', dlr: 'dlr', dtm: 'dtm', dlm: 'dlm', b0: 'b0', omega: 'omega', DN: 'DN', N0: 'N0' };
const TOL = 1e-6;
const maxAll = {};
let nCases = 0;
for (const pf of fx.profiles) {
  const inp = pf.inputs;
  const base = {
    d: pf.d, h: pf.h, R: pf.R, zone: pf.zone, htg: inp.htg, hrg: inp.hrg,
    txLon: inp.phit_e, txLat: inp.phit_n, rxLon: inp.phir_e, rxLat: inp.phir_n,
    Gt: inp.Gt, Gr: inp.Gr, pol: inp.pol === 2 ? 'v' : 'h', dct: inp.dct, dcr: inp.dcr, pressHPa: inp.press, tempC: inp.temp
  };
  const maxP = {};
  let midDev = 0, midWorst = '', pathOk = true, errs = 0;
  for (const row of pf.rows) {
    const r = P.basicTransmissionLoss(Object.assign({ fGHz: row[0], p: row[1] }, base));
    if (r.error) { errs++; continue; }
    nCases++;
    LOSS.forEach((k, i) => {
      const dev = Math.abs(r[k] - row[2 + i]);
      maxP[k] = Math.max(maxP[k] || 0, dev);
      maxAll[k] = Math.max(maxAll[k] || 0, dev);
    });
    for (const [ck, rk] of Object.entries(MID)) {
      const dev = Math.abs(r.path[rk] - pf.mid[ck]);
      if (dev > midDev) { midDev = dev; midWorst = ck; }
      maxAll['mid:' + ck] = Math.max(maxAll['mid:' + ck] || 0, dev);
    }
    if ((pf.mid.path.startsWith('Line') ? 'los' : 'transhorizon') !== r.path.pathType) pathOk = false;
  }
  const lossDev = Math.max(...LOSS.map((k) => maxP[k] || 0));
  ok(`${pf.profile.replace(/^test_profile_|\.csv$/g, '')}：${pf.rows.length} 例损耗最大偏差 ≤ 1e−6 dB`,
    errs === 0 && lossDev <= TOL, `最大 ${lossDev.toExponential(2)} dB`);
  ok(`${pf.profile.replace(/^test_profile_|\.csv$/g, '')}：剖面中间量 ≤ 1e−6、路径类型一致（${pf.mid.path}）`,
    errs === 0 && midDev <= TOL && pathOk, `最大 ${midDev.toExponential(2)}（${midWorst}）`);
}
ok('对拍例数 = 595', nCases === 595, String(nCases));
for (const k of LOSS) ok(`全集 ${k} 最大偏差 ≤ 1e−8 dB（CSV 8 位小数的舍入量级）`, maxAll[k] <= 1e-8, maxAll[k].toExponential(2) + ' dB');

console.log('\n=== ② 无线电气象地图 ===');
{
  // DN50.TXT / N050.TXT 首行首值（北纬 90°、经度 0°）与网格内部若干节点：值取自源文件原文
  const a = P.radioMetAt(90, 0);
  approx('ΔN(90°N, 0°) = 40.726（DN50.TXT 首值）', a.DN, 40.726, 1e-12);
  // 节点上内插应退化为原值：取验证例 cebreros 路径中点附近的整网格点，检查四邻点组合的线性性
  const g00 = P.radioMetAt(40.5, 4.5), g01 = P.radioMetAt(40.5, 6.0), g10 = P.radioMetAt(39.0, 4.5), g11 = P.radioMetAt(39.0, 6.0);
  const mid = P.radioMetAt(39.75, 5.25);
  approx('网格中心 = 四角平均（双线性内插）ΔN', mid.DN, (g00.DN + g01.DN + g10.DN + g11.DN) / 4, 1e-12);
  approx('网格中心 = 四角平均（双线性内插）N0', mid.N0, (g00.N0 + g01.N0 + g10.N0 + g11.N0) / 4, 1e-12);
  const w = P.radioMetAt(40, -3), e = P.radioMetAt(40, 357);
  approx('经度 −3° 与 357° 同值', w.DN, e.DN, 1e-12);
  const all = [];
  for (let lat = -90; lat <= 90; lat += 7.3) for (let lon = -180; lon < 180; lon += 11.1) all.push(P.radioMetAt(lat, lon));
  ok('全球取样 ΔN ∈ [24.579, 79.898]、N0 ∈ [294.251, 389.136]（源数据极值）',
    all.every((x) => x.DN >= 24.579 - 1e-9 && x.DN <= 79.898 + 1e-9 && x.N0 >= 294.251 - 1e-9 && x.N0 <= 389.136 + 1e-9));
  // 注入接口：同一份 .bin 注入后结果不变
  const bin = fs.readFileSync(path.join(__dirname, '..', 'utils', 'terrestrial', 'data', 'p452_dn50_n050.bin'));
  P.setRadioMetMaps(new Uint8Array(bin));
  approx('setRadioMetMaps 注入后取值不变', P.radioMetAt(39.75, 5.25).DN, mid.DN, 0);
  let threw = false;
  try { P.setRadioMetMaps(new Uint8Array(100)); } catch (e2) { threw = true; }
  ok('格式不符的数据注入时报错', threw);
}

console.log('\n=== ③ 公式核对 ===');

// 附录 3：逆正态近似的最大误差 0.00054（x ∈ [1e−6, 0.5]）。式 (158) 算出的是 F⁻¹(x)（x < 0.5 为负），
// 正文 §4.2.4 称其为「逆互补累积正态」——两者只差符号，式 (41a) 取比值不受影响。
{
  let maxErr = 0;
  for (let k = 0; k <= 2000; k++) {
    const x = Math.pow(10, -6 + k * (Math.log10(0.5) + 6) / 2000);
    maxErr = Math.max(maxErr, Math.abs(P.invCumNormP452(x) - C.invNormal(x)));
  }
  ok('附录 3 式 (158) 与精确 F⁻¹ 之差 ≤ 0.00054（建议书声明的误差界）', maxErr <= 0.00054, maxErr.toExponential(3));
  approx('x < 1e−6 时按 1e−6 取值', P.invCumNormP452(1e-9), P.invCumNormP452(1e-6), 0);
}

// 式 (1)(1a)：最坏月 → 年
{
  const pw = 0.1, phi = 40, om = 0.3;
  const GL = Math.sqrt(1.1 + Math.pow(Math.abs(Math.cos(2 * phi * Math.PI / 180)), 0.7));
  const want = Math.pow(10, (Math.log10(pw) + Math.log10(GL) - 0.186 * om - 0.444) / (0.816 + 0.078 * om));
  approx('式 (1) pw = 0.1%、φ = 40°、ω = 0.3', P.worstMonthToAnnual(pw, phi, om), want, 1e-12);
  const GL2 = Math.sqrt(1.1 - Math.pow(Math.abs(Math.cos(2 * 60 * Math.PI / 180)), 0.7));
  approx('式 (1a) |φ| > 45° 分支', P.worstMonthToAnnual(1, 60, 0), Math.pow(10, (0 + Math.log10(GL2) - 0.444) / 0.816), 1e-12);
  // 12p ≥ pw 的下限：大 pw 时折算值会被钳到 pw/12
  const pwBig = 40;
  ok('式 (1) 下注 12p ≥ pw', P.worstMonthToAnnual(pwBig, 50, 0) >= pwBig / 12 - 1e-12);
}

// 式 (2)–(4)：β0
{
  // dtm = dlm = 0 → τ = 0，μ1 = (1 + 10^−2.48)^0.2 > 1 → 钳到 1 → μ4 = 1 → β0 = 10^(−0.015|φ| + 1.67)
  approx('β0(φ = 0, 全海) = 10^1.67', P.beta0(0, 0, 0), Math.pow(10, 1.67), 1e-9);
  approx('β0(φ = 30°, 全海)', P.beta0(30, 0, 0), Math.pow(10, -0.45 + 1.67), 1e-9);
  approx('β0(φ = 75°, 全海) = 4.17（|φ| > 70° 分支）', P.beta0(75, 0, 0), 4.17, 1e-12);
  // 全内陆长路径：dtm = dlm = 200 km
  const dtm = 200, dlm = 200, phi = 45;
  const tau = 1 - Math.exp(-4.12e-4 * Math.pow(dlm, 2.41));
  const mu1 = Math.min(1, Math.pow(Math.pow(10, -dtm / (16 - 6.6 * tau)) + Math.pow(10, -5 * (0.496 + 0.354 * tau)), 0.2));
  const mu4 = Math.pow(10, (-0.935 + 0.0176 * phi) * Math.log10(mu1));
  approx('β0(φ = 45°, dtm = dlm = 200 km)', P.beta0(phi, dtm, dlm), Math.pow(10, -0.015 * phi + 1.67) * mu1 * mu4, 1e-12);
}

// 式 (13)：J(0) ≈ 6.03 dB（掠射），ν ≤ −0.78 取 0
approx('J(0) = 6.9 + 20lg(√1.01 − 0.1)', C.knifeEdgeJ(0), 6.9 + 20 * Math.log10(Math.sqrt(1.01) - 0.1), 1e-12);
ok('J(−0.78) = 0、J(−1) = 0', C.knifeEdgeJ(-0.78) === 0 && C.knifeEdgeJ(-1) === 0);

// §4.6 式 (65)–(72)
{
  const g = P.greatCircle(0, 0, 0, 1);
  approx('赤道上经差 1° 的大圆距离 = 6371·π/180 km', g.dKm, 6371 * Math.PI / 180, 1e-9);
  approx('自西向东方位 = 90°', g.bearingTrDeg, 90, 1e-9);
  approx('反向方位 = 270°', g.bearingRtDeg, 270, 1e-9);
  const n = P.greatCircle(30, 110, 31, 110);
  approx('正北方位 = 0°', n.bearingTrDeg, 0, 1e-6);
  const ob = P.offBoresightAngles({ txLat: 0, txLon: 0, rxLat: 0, rxLon: 0.5, htKm: 0.1, hrKm: 0.1, ae: 8500, pathType: 'los',
    txBoresight: { elevDeg: -0.5 * 6371 * Math.PI / 360 / 8500 * 180 / Math.PI, azDeg: 90 }, rxBoresight: { elevDeg: 30, azDeg: 270 } });
  approx('发射天线正对干扰路径时离轴角 ≈ 0°', ob.chiTDeg, 0, 1e-3);
  approx('接收天线仰 30° 对准方位：离轴角 = 30° − 路径仰角', ob.chiRDeg, 30 - ob.epsPrDeg, 1e-9);
  approx('式 (72) L = Lb − Gt − Gr', P.transmissionLoss(180, 20, 35), 125, 0);
}

// 时间百分比单调性：同一路径 Lb(p) 随 p 增大不减（p 越小越多异常增强）
{
  const pf = fx.profiles.find((x) => x.profile.includes('mixed_109km'));
  const inp = pf.inputs;
  const base = { d: pf.d, h: pf.h, R: pf.R, zone: pf.zone, htg: inp.htg, hrg: inp.hrg, txLon: inp.phit_e, txLat: inp.phit_n,
    rxLon: inp.phir_e, rxLat: inp.phir_n, Gt: inp.Gt, Gr: inp.Gr, fGHz: 4, dct: inp.dct, dcr: inp.dcr };
  const ps = [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 20, 30, 40, 50];
  const lbs = ps.map((p) => P.basicTransmissionLoss(Object.assign({ p }, base)).Lb);
  ok('mixed_109km @4 GHz：Lb(p) 随 p 单调不减', lbs.every((v, i) => i === 0 || v >= lbs[i - 1] - 1e-9), lbs.map((v) => v.toFixed(2)).join(' '));
  // 最坏月：r.p 应等于式 (1) 折算值，并据此出数
  const wm = P.basicTransmissionLoss(Object.assign({ p: 0.05, worstMonth: true }, base));
  approx('worstMonth：内部 p = 式 (1) 折算值', wm.p, P.worstMonthToAnnual(0.05, wm.path.centreLat, wm.path.omega), 1e-12);
  approx('worstMonth：结果等于用折算 p 直接算', wm.Lb, P.basicTransmissionLoss(Object.assign({ p: wm.p }, base)).Lb, 1e-12);
}

// 缺省区域 / 海岸距离：dct、dcr 由区域剖面推出（陆 / 海分界取中点）
{
  const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const zone = ['A1', 'A1', 'A1', 'B', 'B', 'B', 'B', 'B', 'A1', 'A1', 'A2'];
  const a = P.analyzeProfile({ d, h: d.map(() => 0), zone, htg: 10, hrg: 10, DN: 45, centreLat: 30, fGHz: 2 });
  approx('dct = 2.5 km（A1→B 分界中点）', a.dct, 2.5, 1e-12);
  approx('dcr = 10 − 7.5 = 2.5 km', a.dcr, 2.5, 1e-12);
  approx('ω = 5/10（海段 2.5–7.5 km）', a.omega, 0.5, 1e-12);
  approx('dtm = 2.5 km（最长连续陆地段：两端各 2.5 km）', a.dtm, 2.5, 1e-12);
  approx('dlm = 0.5 km（末点 A2 只占半个间隔）', a.dlm, 0.5, 1e-12);
  const b = P.analyzeProfile({ d, h: d.map(() => 0), htg: 10, hrg: 10, DN: 45, centreLat: 30, fGHz: 2 });
  ok('缺省 zone 全 A2：ω = 0、dct = dcr = ∞', b.omega === 0 && b.dct === Infinity && b.dcr === Infinity);
}

// 终端杂波修正（可选，缺省关闭）
{
  const d = [], h = [];
  for (let i = 0; i <= 200; i++) { d.push(i * 0.1); h.push(50 + 20 * Math.sin(i / 15)); }
  const base = { fGHz: 2, p: 10, d, h, htg: 10, hrg: 8, DN: 45, N0: 320, centreLat: 30, Gt: 15, Gr: 0 };
  const plain = P.basicTransmissionLoss(base);
  ok('缺省不做终端修正：Aht = Ahr = 0', plain.Aht === 0 && plain.Ahr === 0 && plain.terminalClutter === null);

  // P.452-17 §4.5（旧口径）：Ah 按式 (57)(57a) 现算；基本损耗按天线抬到 ha、路径截去 dk 计算
  const ha = 20, dk = 0.02, hAnt = 10, f = 2;
  const Ffc = 0.25 + 0.375 * (1 + Math.tanh(7.5 * (f - 0.5)));
  const AhWant = 10.25 * Ffc * Math.exp(-dk) * (1 - Math.tanh(6 * (hAnt / ha - 0.625))) - 0.33;
  const leg = P.basicTransmissionLoss(Object.assign({ terminalClutter: { tx: { model: 'p452-17', category: 'urban' } } }, base));
  approx('P.452-17 式 (57)：urban（ha 20 m、dk 0.02 km）、h = 10 m、2 GHz', leg.Aht, AhWant, 1e-12);
  const i0 = d.findIndex((x) => x >= dk);
  const trimmed = P.basicTransmissionLoss(Object.assign({}, base, { d: d.slice(i0).map((x) => x - d[i0]), h: h.slice(i0), htg: ha }));
  approx('P.452-17：Lb = Lb(天线抬到 ha、截去 dk) + Aht', leg.Lb, trimmed.Lb + AhWant, 1e-9);
  const tall = P.basicTransmissionLoss(Object.assign({ terminalClutter: { tx: { model: 'p452-17', ha: 5, dk: 0.05 } } }, base));
  ok('P.452-17：天线高于 ha 时不修正', tall.Aht === 0 && Math.abs(tall.Lb - plain.Lb) < 1e-12);

  // P.2108-1 §3.1：基本损耗算到代表性杂波高度 R，再加 Ah。urban/trees/forest 缺省 R = 15 m、走式 (2a)，
  // ws = 27 m；Ah 按式 (2a)(2c)(2d)(2e)(2g) 在此现算
  const R15 = 15, h8 = 8, ws = 27;
  const hdif = R15 - h8, thClut = Math.atan(hdif / ws) * 180 / Math.PI, nu = 0.342 * Math.sqrt(2) * Math.sqrt(hdif * thClut);
  const AhP2108 = C.knifeEdgeJ(nu) - 6.03;
  const mod = P.basicTransmissionLoss(Object.assign({ terminalClutter: { rx: { model: 'p2108', clutterType: 'urban_trees_forest' } } }, base));
  const raised = P.basicTransmissionLoss(Object.assign({}, base, { hrg: R15 }));
  approx('P.2108-1 §3.1 式 (2a)：Ahr（2 GHz、h = 8 m、R = 15 m）', mod.Ahr, AhP2108, 1e-9);
  approx('P.2108-1 §3.1：Lb = Lb(天线抬到 R) + Ah', mod.Lb, raised.Lb + AhP2108, 1e-9);
  const withR = P.basicTransmissionLoss(Object.assign({ R: d.map(() => 10), terminalClutter: { rx: { model: 'p2108', clutterType: 'suburban' } } }, base));
  ok('剖面已含杂波再加终端修正 → 提示可能重复计入', withR.warnings.some((w) => w.includes('重复')));
}

// 剖面杂波的 50 m 规则（式 (6e) 下注）：离终端 < 50 m 的点不加杂波
{
  const d = [0, 0.03, 0.06, 0.5, 1, 1.94, 1.97, 2];
  const h = d.map(() => 0);
  const base = { fGHz: 3, p: 50, d, h, htg: 5, hrg: 5, DN: 45, N0: 320, centreLat: 30 };
  const near = P.basicTransmissionLoss(Object.assign({ R: [0, 30, 0, 0, 0, 0, 30, 0] }, base));
  const none = P.basicTransmissionLoss(base);
  approx('50 m 内的杂波被忽略（与无杂波同值）', near.Lb, none.Lb, 1e-12);
  const far = P.basicTransmissionLoss(Object.assign({ R: [0, 0, 30, 0, 0, 0, 0, 0] }, base));
  ok('60 m 处的杂波计入（损耗增大）', far.Ld50 > none.Ld50 + 1, `${far.Ld50.toFixed(2)} > ${none.Ld50.toFixed(2)} dB`);
}

// 报错与告警
{
  const d = [0, 1, 2], h = [0, 0, 0];
  const base = { fGHz: 2, p: 10, d, h, htg: 10, hrg: 10, DN: 45, N0: 320, centreLat: 30 };
  ok('p > 50 报错', !!P.basicTransmissionLoss(Object.assign({}, base, { p: 60 })).error);
  ok('剖面少于 3 点报错', !!P.basicTransmissionLoss(Object.assign({}, base, { d: [0, 1], h: [0, 0] })).error);
  ok('距离不递增报错', !!P.basicTransmissionLoss(Object.assign({}, base, { d: [0, 2, 1] })).error);
  ok('缺 ΔN 且无坐标报错', !!P.basicTransmissionLoss({ fGHz: 2, p: 10, d, h, htg: 10, hrg: 10 }).error);
  ok('未知区域代码报错', !!P.basicTransmissionLoss(Object.assign({}, base, { zone: ['A1', 'X', 'B'] })).error);
  const hi = P.basicTransmissionLoss(Object.assign({}, base, { fGHz: 60 }));
  ok('60 GHz：照算并告警超出验证范围', Number.isFinite(hi.Lb) && hi.warnings.some((w) => w.includes('0.1–50 GHz')));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
