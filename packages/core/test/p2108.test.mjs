// ITU-R P.2108-1 杂波损耗测试（无框架，纯断言）。
//   运行： node packages/core/test/p2108.test.mjs
//
// 两层：
//   ① 官方工作簿逐点对拍 —— ITU-R SG3「Clutter and BEL workbook_V2.xlsx」（同时实现 P.2108-1 与 P.2109-2，
//      首页写明可用于「testing other software implementations」）。各表的 Excel 缓存值由 python3 + openpyxl
//      抽成 fixtures/itu_clutter_bel_workbook_v2.json（含下载地址、xlsx 的 SHA-256、每张表的工作表与单元格
//      范围，抽取前逐格核对过公式形状），xlsx 本身不进仓库。每张表打印一行：比较点数与最大绝对偏差。
//      容差 1e-9 dB——两边的逆正态都是机器精度（Excel NORM.INV / AS241），差异只剩浮点舍入。
//        §3.1  'Clutter Sect 3-1' D2:E18    f = 1.5 GHz、h = 2 m；R 取表 3 默认 10 m 与本地 4 m 两例，
//                                           中间量 Kν、Kh2、hdif、θclut、ν、J(ν) 与 2a / 2b 两式结果
//        §3.2  'Clutter Sect 3-2' D2:D16    单点：67 GHz / 0.65 km / 99.9 %，含 2 km 封顶
//                                 F8:O73    Lctt 随频率（d = 0.65 km，p = 5/50/95/99.9 %）及 Ll、Ls、σcb
//                                 AD3:AK64  Lctt 随距离（f = 67 GHz，0.25–100 km，同四个 p）
//                                 AN1:AQ1006 Lctt 随位置百分比（0.1–99.9 %：封顶前 / 2 km / 封顶后三列）
//        §3.3  'Clutter Sect 3-3' F4:S105   Lces（f = 30 GHz，101 个 p × 13 个仰角）及 D2:D10 单点
//   ② 独立公式核对 —— 期望值按建议书原文在测试里现算或手算，不是把实现输出抄回来当基准。
//      标「手算」的数字由独立的 Python 脚本照原文公式算出（逆正态用 Python statistics.NormalDist）；
//      标「图 1」的数字是从建议书 PDF 图 1 读出的曲线值（±0.5 dB，只防量级性错误）。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const M = require('../utils/terrestrial/p2108.js');
const { knifeEdgeJ, qInv } = require('../utils/terrestrial/common.js');
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

// 工作簿对拍：rows = [[实现值, 工作簿值, 标签], …]，一张表一行结论
const TOL = 1e-9;
const summary = [];
const table = (name, cells, rows) => {
  let max = 0, worst = '', bad = 0;
  for (const [got, want, label] of rows) {
    const dev = (typeof got === 'number' && Number.isFinite(got)) ? Math.abs(got - want) : Infinity;
    if (!(dev <= TOL)) bad++;
    if (dev > max) { max = dev; worst = `${label}: got ${got}, want ${want}`; }
  }
  summary.push({ name, cells, n: rows.length, max });
  ok(`工作簿 ${name}（${cells}）：${rows.length} 点，最大偏差 ${max.toExponential(2)} dB`,
    rows.length > 0 && bad === 0, bad ? `${bad} 点超差 ${TOL}，最差 ${worst}` : '');
};

const L32 = (fGHz, dKm, pLoc, bothEnds) => M.terrestrialClutterLoss({ fGHz, dKm, pLoc, bothEnds });

console.log(`=== ① 官方工作簿对拍（${WB.source.name}，SHA-256 ${WB.source.sha256.slice(0, 12)}…） ===`);

// —— §3.1 ——
// 工作簿杂波代码（'Clutter Sect 3-1' H3:H7）→ 本模块键名
const CODE2KEY = { 1: 'water_sea', 2: 'open_rural', 3: 'suburban', 4: 'urban_trees_forest', 5: 'dense_urban' };
{
  const t3 = WB.s31.table3;
  ok('§3.1 表 3（R 与 Ah 算法）与工作簿 G3:J7 一致', t3.length === 5 && t3.every((r) => {
    const c = M.CLUTTER_TYPES[CODE2KEY[r.code]];
    return c && c.R === r.R && r.eq === `Equation (${c.method})` && c.name === r.name;
  }));

  const rows = [];
  for (const c of WB.s31.cases) {
    const base = { fGHz: c.inputs.fGHz, h: c.inputs.h, ws: c.inputs.ws, clutterType: CODE2KEY[c.clutterCode] };
    // D 列的 R 由 VLOOKUP 取表 3 默认值 → 不传 R，顺带验证缺省值；E 列为本地给定 R
    const r = M.heightGainTerminalCorrection(c.RFromTable3 ? base : { ...base, R: c.inputs.R });
    const r2a = M.heightGainTerminalCorrection({ ...base, clutterType: 'suburban', R: c.inputs.R });
    const r2b = M.heightGainTerminalCorrection({ ...base, clutterType: 'open_rural', R: c.inputs.R });
    rows.push(
      [r.R, c.inputs.R, `${c.cells} R`],
      [r.Knu, c.Knu, `${c.cells} K_nu`],
      [r.Kh2, c.Kh2, `${c.cells} K_h2`],
      [r.hdif, c.hdif, `${c.cells} h_dif`],
      [r.thetaClutDeg, c.thetaClutDeg, `${c.cells} θ_clut`],
      [r.nu, c.nu, `${c.cells} ν`],
      [knifeEdgeJ(r.nu), c.J, `${c.cells} J(ν)`],
      [r2a.Ah, c.Ah2a, `${c.cells} A_h 式(2a)`],
      [r2b.Ah, c.Ah2b, `${c.cells} A_h 式(2b)`],
      [r.Ah, c.Ah, `${c.cells} A_h（按杂波类型）`],
    );
  }
  table('§3.1', 'Clutter Sect 3-1 D2:E18', rows);
}

// —— §3.2 单点 ——
{
  const s = WB.s32Point;
  const r = L32(s.fGHz, s.dKm, s.pLoc), r2 = L32(s.fGHz, 2, s.pLoc);
  table('§3.2 单点', `${s.sheet} ${s.cells}`, [
    [r.Ll, s.Ll, 'L_l'], [r.Ls, s.Ls, 'L_s'], [r.sigmaCb, s.sigmaCb, 'σ_cb'],
    [r2.Ls, s.Ls2km, 'L_s(2 km)'], [r2.sigmaCb, s.sigmaCb2km, 'σ_cb(2 km)'],
    [r.LcttUncapped, s.LcttUncapped, 'L_ctt 封顶前'], [r.LcttMax, s.Lctt2km, 'L_ctt(2 km)'], [r.Lctt, s.Lctt, 'L_ctt'],
  ]);
  ok('§3.2 单点：99.9 % 时 0.65 km 的式 (3a) 值已超 2 km 值 → capped', r.capped === true && r.Lctt === r.LcttMax);
}

// —— §3.2 随频率 ——
{
  const t = WB.s32VsFreq, rows = [], warnedF = new Set();
  t.fGHz.forEach((f, i) => {
    const r0 = L32(f, t.dKm, 50), r2 = L32(f, 2, 50);
    rows.push([r0.Ll, t.Ll[i], `f=${f} L_l`], [r0.Ls, t.Ls[i], `f=${f} L_s`], [r0.sigmaCb, t.sigmaCb[i], `f=${f} σ_cb`],
      [r2.Ls, t.Ls2km[i], `f=${f} L_s(2 km)`], [r2.sigmaCb, t.sigmaCb2km[i], `f=${f} σ_cb(2 km)`]);
    t.pLocs.forEach((p, j) => {
      const r = L32(f, t.dKm, p);
      rows.push([r.Lctt, t.Lctt[j][i], `f=${f} p=${p}`]);
      if (r.warnings.length) warnedF.add(f);
    });
  });
  table('§3.2 随频率', `${t.sheet} ${t.cells}`, rows);
  ok('§3.2 频率表：只有工作簿那行 120 GHz 带频率越界告警（其余 2–66 GHz 在 0.5–67 GHz 内）',
    warnedF.size === 1 && warnedF.has(120), [...warnedF].join(','));
}

// —— §3.2 随距离 ——
{
  const t = WB.s32VsDist, rows = [];
  const r2 = L32(t.fGHz, 2, 50);
  rows.push([r2.Ll, t.Ll, 'L_l'], [r2.Ls, t.Ls2km, 'L_s(2 km)'], [r2.sigmaCb, t.sigmaCb2km, 'σ_cb(2 km)']);
  t.pLocs.forEach((p, j) => rows.push([L32(t.fGHz, 2, p).Lctt, t.Lctt2km[j], `2 km p=${p}`]));
  t.dKm.forEach((d, i) => {
    const r = L32(t.fGHz, d, 50);
    rows.push([r.Ls, t.Ls[i], `d=${d} L_s`], [r.sigmaCb, t.sigmaCb[i], `d=${d} σ_cb`]);
    t.pLocs.forEach((p, j) => rows.push([L32(t.fGHz, d, p).Lctt, t.Lctt[j][i], `d=${d} p=${p}`]));
  });
  table('§3.2 随距离', `${t.sheet} ${t.cells}`, rows);
}

// —— §3.2 随位置百分比 ——
{
  const t = WB.s32VsP, rows = [];
  const r0 = L32(t.fGHz, t.dKm, 50), r2 = L32(t.fGHz, 2, 50);
  rows.push([r0.Ll, t.Ll, 'L_l'], [r0.Ls, t.Ls, 'L_s'], [r0.sigmaCb, t.sigmaCb, 'σ_cb'],
    [r2.Ls, t.Ls2km, 'L_s(2 km)'], [r2.sigmaCb, t.sigmaCb2km, 'σ_cb(2 km)']);
  let flagOk = true;
  t.pLoc.forEach((p, i) => {
    const r = L32(t.fGHz, t.dKm, p);
    rows.push([r.LcttUncapped, t.LcttUncapped[i], `p=${p} 封顶前`], [r.LcttMax, t.Lctt2km[i], `p=${p} 2 km`],
      [r.Lctt, t.Lctt[i], `p=${p} L_ctt`]);
    if (r.capped !== (t.LcttUncapped[i] > t.Lctt2km[i])) flagOk = false;
  });
  table('§3.2 随位置百分比', `${t.sheet} ${t.cells}`, rows);
  ok('§3.2 capped 标志与工作簿 AO > AP 逐点一致（999 点）', flagOk);
}

// —— §3.3 ——
{
  const t = WB.s33, rows = [];
  const r = M.earthSpaceClutterLoss({ fGHz: t.fGHz, elevDeg: 45, pLoc: 50 });
  rows.push([r.K1, t.K1, 'K_1'], [r.A1, t.A1, 'A_1']);
  t.pLoc.forEach((p, i) => t.elevDeg.forEach((th, j) => {
    rows.push([M.earthSpaceClutterLoss({ fGHz: t.fGHz, elevDeg: th, pLoc: p }).Lces, t.Lces[i][j], `p=${p} θ=${th}°`]);
  }));
  const pt = t.point;
  const rp = M.earthSpaceClutterLoss({ fGHz: pt.fGHz, elevDeg: pt.elevDeg, pLoc: pt.pLoc });
  rows.push([rp.K1, pt.K1, `${pt.cells} K_1`], [rp.Lces, pt.Lces, `${pt.cells} L_ces`]);
  table('§3.3', `${t.sheet} ${t.cells} + ${pt.cells}`, rows);
}

console.log('\n=== ② 独立公式核对 ===');

// —— §3.1 ——
// 手算：f = 1.5 GHz、h = 2 m、R = 10 m、开阔（式 2b）：Ah = −(21.8 + 6.2·lg1.5)·lg(0.2) = 16.000657644780453
approx('§3.1 式 (2b) 手算点 f=1.5 GHz h=2 m R=10 m', M.heightGainTerminalCorrection({ fGHz: 1.5, h: 2, clutterType: 'open_rural' }).Ah,
  16.000657644780453, 1e-9);
// 手算：f = 0.9 GHz、h = 5 m、ws = 20 m、密集城区（R 缺省 20 m，式 2a）：
//   hdif = 15，θclut = atan(15/20) = 36.869897645844°，ν = 0.342·√0.9·√(15·θclut) = 7.630077624857742，
//   Ah = J(ν) − 6.03 = 24.46463433416625
{
  const r = M.heightGainTerminalCorrection({ fGHz: 0.9, h: 5, ws: 20, clutterType: 'dense_urban' });
  approx('§3.1 式 (2a) 手算点 f=0.9 GHz h=5 m ws=20 m 密集城区', r.Ah, 24.46463433416625, 1e-9);
  approx('§3.1 式 (2a) 手算点 ν', r.nu, 7.6300776248577415, 1e-12);
  approx('§3.1 式 (2e) θclut 为度', r.thetaClutDeg, 36.86989764584402, 1e-12);
  ok('§3.1 密集城区缺省 R = 20 m、方法 2a', r.R === 20 && r.method === '2a' && r.belowClutter === true);
}
// 手算：f = 0.1 GHz、h = 3 m、R = 15 m（城区/树木/森林缺省）：Ah = 12.31710771031669
approx('§3.1 式 (2a) 手算点 f=0.1 GHz h=3 m 城区/树木/森林',
  M.heightGainTerminalCorrection({ fGHz: 0.1, h: 3, clutterType: 'urban_trees_forest' }).Ah, 12.31710771031669, 1e-9);
// 式 (2a) 现算：ν、J(ν) 按原文逐式独立再写一遍
{
  const f = 2.4, h = 7.5, R = 18, ws = 31;
  const hd = R - h, th = Math.atan(hd / ws) * 180 / Math.PI, nu = 0.342 * Math.sqrt(f) * Math.sqrt(hd * th);
  const J = 6.9 + 20 * Math.log10(Math.sqrt((nu - 0.1) ** 2 + 1) + nu - 0.1);
  approx('§3.1 式 (2a) 现算（f=2.4 GHz h=7.5 m R=18 m ws=31 m 郊区）',
    M.heightGainTerminalCorrection({ fGHz: f, h, R, ws, clutterType: 'suburban' }).Ah, J - 6.03, 1e-12);
  const Kh2 = 21.8 + 6.2 * Math.log10(f);
  approx('§3.1 式 (2b) 现算（同参数、水域）',
    M.heightGainTerminalCorrection({ fGHz: f, h, R, ws, clutterType: 'water_sea' }).Ah, -Kh2 * Math.log10(h / R), 1e-12);
}
// h ≥ R → Ah = 0（原文「If h ≥ R then Ah = 0」），两种算法都一样
{
  const types = Object.keys(M.CLUTTER_TYPES);
  ok('§3.1 h = R → 五类杂波 Ah 均为 0', types.every((k) => {
    const r = M.heightGainTerminalCorrection({ fGHz: 1, h: M.CLUTTER_TYPES[k].R, clutterType: k });
    return r.Ah === 0 && r.belowClutter === false && r.nu === null;
  }));
  ok('§3.1 h > R（30 m 天线、密集城区）→ Ah = 0',
    M.heightGainTerminalCorrection({ fGHz: 1, h: 30, clutterType: 'dense_urban' }).Ah === 0);
  // h 从下方逼近 R：2b 趋于 0；2a 趋于 J(0) − 6.03 = 0.00285 dB（原文常数 6.03 是 J(0) = 6.0329 的取整）
  approx('§3.1 h → R⁻ 时式 (2b) → 0', M.heightGainTerminalCorrection({ fGHz: 1, h: 10 - 1e-9, clutterType: 'open_rural' }).Ah, 0, 1e-6);
  approx('§3.1 h → R⁻ 时式 (2a) → J(0) − 6.03', M.heightGainTerminalCorrection({ fGHz: 1, h: 10 - 1e-12, clutterType: 'suburban' }).Ah,
    knifeEdgeJ(0) - 6.03, 1e-4);
}
// 天线越低损耗越大（两式都单调）
{
  let mono = true;
  for (const k of ['open_rural', 'dense_urban']) {
    let prev = Infinity;
    for (let h = 0.5; h < M.CLUTTER_TYPES[k].R; h += 0.5) {
      const a = M.heightGainTerminalCorrection({ fGHz: 0.8, h, clutterType: k }).Ah;
      if (!(a < prev)) mono = false;
      prev = a;
    }
  }
  ok('§3.1 h ∈ (0, R) 内 Ah 随 h 严格递减（2a、2b 各一类）', mono);
}

// —— §3.2 ——
// 手算：f = 2 GHz、d = 1 km：Ll = 28.00752490966653，Ls = 33.88308998699194，σcb = 4.153630007401749，
//   p = 50 %：Lctt = 27.867075267555276（未封顶，2 km 值 28.002250299674756）
//   p = 5 %：Lctt = 21.034961884866036
{
  const r = L32(2, 1, 50);
  approx('§3.2 手算 f=2 GHz d=1 km：式 (4a) Ll', r.Ll, 28.00752490966653, 1e-9);
  approx('§3.2 手算 f=2 GHz d=1 km：式 (5a) Ls', r.Ls, 33.88308998699194, 1e-9);
  approx('§3.2 手算 f=2 GHz d=1 km：式 (3b) σcb', r.sigmaCb, 4.153630007401749, 1e-9);
  approx('§3.2 手算 f=2 GHz d=1 km p=50 %：Lctt', r.Lctt, 27.867075267555276, 1e-9);
  approx('§3.2 手算 f=2 GHz d=1 km：2 km 上限', r.LcttMax, 28.002250299674756, 1e-9);
  approx('§3.2 手算 f=2 GHz d=1 km p=5 %：Lctt', L32(2, 1, 5).Lctt, 21.034961884866036, 1e-9);
  // 手算：f = 30 GHz、d = 0.5 km、p = 90 %：36.8950607074024；f = 0.8 GHz、d = 3 km、p = 10 %：封顶到 18.901038415582335
  approx('§3.2 手算 f=30 GHz d=0.5 km p=90 %', L32(30, 0.5, 90).Lctt, 36.8950607074024, 1e-9);
  const c = L32(0.8, 3, 10);
  approx('§3.2 手算 f=0.8 GHz d=3 km p=10 %（封顶）', c.Lctt, 18.901038415582335, 1e-9);
  ok('§3.2 f=0.8 GHz d=3 km p=10 %：capped 且封顶前值为 18.904142694762832',
    c.capped === true && Math.abs(c.LcttUncapped - 18.904142694762832) < 1e-9);
}
// p = 50 %：Q⁻¹(0.5) = 0，Lctt 就是式 (3a) 的 −5lg(10^(−0.2Ll) + 10^(−0.2Ls)) 项
{
  let worst = 0;
  for (const f of [0.5, 1, 3.5, 10, 28, 67]) {
    for (const d of [0.25, 0.4, 0.8, 1.5, 1.99]) {
      const r = L32(f, d, 50);
      const med = -5 * Math.log10(Math.pow(10, -0.2 * r.Ll) + Math.pow(10, -0.2 * r.Ls));
      worst = Math.max(worst, Math.abs(r.Lctt - med));
    }
  }
  ok('§3.2 p = 50 % 时 Lctt = −5lg(10^(−0.2Ll) + 10^(−0.2Ls))（30 组 f × d < 2 km）', worst < 1e-12, `max ${worst.toExponential(2)}`);
}
// σcb 是 σl、σs 按两项线性功率加权：两极限 d → 0 时 → σs = 6，d → ∞ 时 → σl = 4
approx('§3.2 式 (3b) d 很小时 σcb → σs = 6', L32(10, 1e-4, 50).sigmaCb, 6, 1e-6);
approx('§3.2 式 (3b) d 很大时 σcb → σl = 4', L32(10, 1e5, 50).sigmaCb, 4, 1e-6);
// 封顶前 Lctt 随 d 单调不减：p ≤ 50 % 时中值项随 d 增、σcb 随 d 减而 −σcb·Q⁻¹ 非负项随之增，两者同向
{
  let mono = true;
  for (const f of [0.5, 2, 10, 67]) {
    for (const p of [1, 5, 20, 50]) {
      let prev = -Infinity;
      for (let d = 0.25; d <= 2.0001; d += 0.05) {
        const L = L32(f, d, p).Lctt;
        if (!(L >= prev)) mono = false;
        prev = L;
      }
    }
  }
  ok('§3.2 d ∈ [0.25, 2] km 上 Lctt 随 d 单调不减（4 个 f × p = 1/5/20/50 %）', mono);
}
// 式 (6)：任何 d 都不超过 2 km 值；p ≤ 50 % 时 d > 2 km 恰好取 2 km 值
{
  let capOk = true, flatOk = true;
  for (const f of [0.7, 6, 40]) {
    for (const p of [0.5, 10, 50, 90, 99.5]) {
      const cap = L32(f, 2, p).Lctt;
      for (const d of [0.25, 0.5, 1, 2, 3, 10, 50, 300]) {
        const r = L32(f, d, p);
        if (!(r.Lctt <= cap + 1e-12) || r.LcttMax !== cap || r.Lctt !== Math.min(r.LcttUncapped, cap)) capOk = false;
        if (p <= 50 && d > 2 && !(r.capped && r.Lctt === cap)) flatOk = false;
      }
    }
  }
  ok('§3.2 式 (6)：Lctt = min(式 (3a) 于 d, 于 2 km)，从不超过 2 km 值', capOk);
  ok('§3.2 p ≤ 50 % 时 d > 2 km 一律取 2 km 值', flatOk);
  const at2 = L32(5, 2, 50);
  ok('§3.2 d = 2 km 恰在上限、不算 capped', at2.capped === false && at2.Lctt === at2.LcttMax);
}
// p 越大损耗越大
{
  let mono = true;
  for (const d of [0.3, 1, 5]) {
    let prev = -Infinity;
    for (let p = 0.5; p < 100; p += 0.5) {
      const L = L32(12, d, p).Lctt;
      if (!(L >= prev)) mono = false;
      prev = L;
    }
  }
  ok('§3.2 Lctt 随 p 单调不减（12 GHz，d = 0.3 / 1 / 5 km）', mono);
}
// 图 1（中值，读图）：0.25 km 起点 1 GHz ≈ 18.5、67 GHz ≈ 24；远距离平台 1/2/4/67 GHz ≈ 25/28/31/33 dB
approx('§3.2 图 1 读图 1 GHz、0.25 km', L32(1, 0.25, 50).Lctt, 18.5, 0.5);
approx('§3.2 图 1 读图 67 GHz、0.25 km', L32(67, 0.25, 50).Lctt, 24, 0.5);
approx('§3.2 图 1 读图 1 GHz 平台', L32(1, 100, 50).Lctt, 25, 0.5);
approx('§3.2 图 1 读图 2 GHz 平台', L32(2, 100, 50).Lctt, 28, 0.5);
approx('§3.2 图 1 读图 4 GHz 平台', L32(4, 100, 50).Lctt, 31, 0.5);
approx('§3.2 图 1 读图 67 GHz 平台', L32(67, 100, 50).Lctt, 33, 0.5);

// —— §3.3 ——
// θ = 90° 时式 (7) 指数为 0、首项为 1：Lces = −0.6·Q⁻¹(p/100)
{
  let worst = 0;
  for (const p of [0.1, 1, 5, 25, 50, 75, 95, 99.9]) {
    worst = Math.max(worst, Math.abs(M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 90, pLoc: p }).Lces + 0.6 * qInv(p / 100)));
  }
  ok('§3.3 θ = 90° 时 Lces = −0.6·Q⁻¹(p/100)', worst < 1e-12, `max ${worst.toExponential(2)}`);
  approx('§3.3 手算 θ=90° p=5 %：−0.6·1.6448536…', M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 90, pLoc: 5 }).Lces,
    -0.9869121761708836, 1e-12);
}
// 手算：f = 30 GHz、θ = 0°、p = 50 %：(−K1·ln0.5·cot0.05)^0.5 − 1 = 47.33216514589097
approx('§3.3 手算 f=30 GHz θ=0° p=50 %', M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 0, pLoc: 50 }).Lces, 47.33216514589097, 1e-9);
// 手算：f = 20 GHz、θ = 45°、p = 80 %：3.4429972238694346
approx('§3.3 手算 f=20 GHz θ=45° p=80 %', M.earthSpaceClutterLoss({ fGHz: 20, elevDeg: 45, pLoc: 80 }).Lces, 3.4429972238694346, 1e-9);
approx('§3.3 K1 = 93·f^0.175（f = 30 GHz）', M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 10, pLoc: 50 }).K1,
  93 * Math.pow(30, 0.175), 1e-12);
// 仰角越低损耗越大（中、高 p）
{
  let mono = true;
  for (const p of [50, 80, 99]) {
    let prev = Infinity;
    for (let th = 0; th <= 90; th += 1) {
      const L = M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: th, pLoc: p }).Lces;
      if (!(L < prev)) mono = false;
      prev = L;
    }
  }
  ok('§3.3 p = 50 / 80 / 99 % 时 Lces 随仰角 0→90° 严格递减', mono);
}

// —— 告警与无效入参 ——
console.log('\n=== 告警与无效入参 ===');
{
  const w = (r) => (r.warnings || []).join('；');
  const r1 = M.heightGainTerminalCorrection({ fGHz: 5, h: 2, clutterType: 'suburban' });
  ok('§3.1 f = 5 GHz → 照算 + 告警', Number.isFinite(r1.Ah) && w(r1) === '频率 5 GHz 超出 §3.1 适用范围 0.03–3 GHz', w(r1));
  ok('§3.1 f = 1 GHz → 无告警', M.heightGainTerminalCorrection({ fGHz: 1, h: 2, clutterType: 'suburban' }).warnings.length === 0);
  ok('§3.1 h = 0 → error', !!M.heightGainTerminalCorrection({ fGHz: 1, h: 0, clutterType: 'suburban' }).error);
  ok('§3.1 h < 0 → error', !!M.heightGainTerminalCorrection({ fGHz: 1, h: -3, clutterType: 'suburban' }).error);
  ok('§3.1 f = NaN → error', !!M.heightGainTerminalCorrection({ fGHz: NaN, h: 2, clutterType: 'suburban' }).error);
  // R = 0 即无杂波（P.452-18 表 3 里水域、开阔两类的剖面加高就是 0 m）：按「h ≥ R → Ah = 0」，不报错
  ok('§3.1 R = 0 → Ah = 0', M.heightGainTerminalCorrection({ fGHz: 1, h: 2, R: 0, clutterType: 'open_rural' }).Ah === 0);
  ok('§3.1 R < 0 → error', !!M.heightGainTerminalCorrection({ fGHz: 1, h: 2, R: -1, clutterType: 'suburban' }).error);
  ok('§3.1 ws = 0 → error', !!M.heightGainTerminalCorrection({ fGHz: 1, h: 2, ws: 0, clutterType: 'suburban' }).error);
  ok('§3.1 未知杂波类型 → error', !!M.heightGainTerminalCorrection({ fGHz: 1, h: 2, clutterType: 'forest' }).error);
  ok('§3.1 原型链键名不算杂波类型', !!M.heightGainTerminalCorrection({ fGHz: 1, h: 2, clutterType: 'constructor' }).error);
  ok('§3.1 R / ws 传 null 视同缺省', M.heightGainTerminalCorrection({ fGHz: 1, h: 2, R: null, ws: null, clutterType: 'dense_urban' }).Ah ===
    M.heightGainTerminalCorrection({ fGHz: 1, h: 2, clutterType: 'dense_urban' }).Ah);

  const r2 = L32(0.3, 0.1, 50);
  ok('§3.2 f = 0.3 GHz、d = 0.1 km → 照算 + 两条告警', Number.isFinite(r2.Lctt) && r2.warnings.length === 2, w(r2));
  ok('§3.2 f = 1 GHz 在 P.2108-1 的 0.5–67 GHz 内（工作簿首页写的 2–67 GHz 是旧版范围）', L32(1, 1, 50).warnings.length === 0);
  ok('§3.2 f = 67 GHz 边界不告警、67.5 GHz 告警', L32(67, 1, 50).warnings.length === 0 && L32(67.5, 1, 50).warnings.length === 1);
  ok('§3.2 d = 0.5 km：单端修正不告警', L32(10, 0.5, 50).warnings.length === 0);
  ok('§3.2 d = 0.5 km：两端修正告警（最短 1 km）', L32(10, 0.5, 50, true).warnings.length === 1, w(L32(10, 0.5, 50, true)));
  ok('§3.2 d = 0.25 km 边界不告警', L32(10, 0.25, 50).warnings.length === 0);
  ok('§3.2 p = 0 → error', !!L32(10, 1, 0).error);
  ok('§3.2 p = 100 → error', !!L32(10, 1, 100).error);
  ok('§3.2 p = NaN → error', !!L32(10, 1, NaN).error);
  ok('§3.2 d = 0 → error', !!L32(10, 0, 50).error);
  ok('§3.2 f 缺省 → error', !!M.terrestrialClutterLoss({ dKm: 1, pLoc: 50 }).error);

  const r3 = M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: -1, pLoc: 5 });
  ok('§3.3 θ = −1° → 按 0° 计算 + 告警', r3.Lces === M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 0, pLoc: 5 }).Lces &&
    w(r3) === '仰角 -1° 低于 §3.3 适用范围 0–90°，按 0° 计算', w(r3));
  ok('§3.3 θ = 91° → error', !!M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 91, pLoc: 5 }).error);
  ok('§3.3 θ = NaN → error', !!M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: NaN, pLoc: 5 }).error);
  const r4 = M.earthSpaceClutterLoss({ fGHz: 5, elevDeg: 30, pLoc: 50 });
  ok('§3.3 f = 5 GHz → 照算 + 告警', Number.isFinite(r4.Lces) && w(r4) === '频率 5 GHz 超出 §3.3 适用范围 10–100 GHz', w(r4));
  ok('§3.3 f = 10 / 100 GHz 边界不告警', M.earthSpaceClutterLoss({ fGHz: 10, elevDeg: 30, pLoc: 50 }).warnings.length === 0 &&
    M.earthSpaceClutterLoss({ fGHz: 100, elevDeg: 30, pLoc: 50 }).warnings.length === 0);
  ok('§3.3 p = 0 / 100 → error', !!M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 30, pLoc: 0 }).error &&
    !!M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 30, pLoc: 100 }).error);
  // 极小 p 仍有限（ln(1 − p/100) 用 log1p，不会因 1 − p/100 舍入成 1 而塌成 0）
  ok('§3.3 p = 1e-9 % 仍给出有限值', Number.isFinite(M.earthSpaceClutterLoss({ fGHz: 30, elevDeg: 10, pLoc: 1e-9 }).Lces));
}

console.log('\n工作簿对拍汇总：');
for (const s of summary) console.log(`  ${String(s.n).padStart(5)} 点  最大偏差 ${s.max.toExponential(2)} dB  ${s.name}  [${s.cells}]`);
console.log(`  合计 ${summary.reduce((a, s) => a + s.n, 0)} 点`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
