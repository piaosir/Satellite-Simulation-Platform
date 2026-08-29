// 实时/预报环境场 取栅格测试（无框架，纯断言）。
// 运行： node packages/core/test/liveField.test.js
//
// 用**合成立方体**（不联网、值可手算），验四件事：
//   ① 出参与 envField.sampleField 同构 —— 渲染端共用一套代码的前提，形状漂了就全散;
//   ② 空间双线性 / 时间就近取帧 的口径;
//   ③ 三类留白（缺格 / 星在地平线下 / 雪冰）都是 NaN，不拿 0 顶替;
//   ④ 衰减场确实随雨强与卫星几何变化，且插的是雨强不是 dB。

const fs = require('fs');
const path = require('path');
const core = require('../index.js');
const LF = require('../utils/liveField.js');

const ituDir = path.join(__dirname, '..', '..', '..', 'resources', 'itu');
const rd = (f) => { try { return fs.readFileSync(path.join(ituDir, f)); } catch (e) { return null; } };
core.loadFullPrecisionData({ rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'), vapor: rd('p836_rho_v1.bin'), cloud: rd('p840_logn_v1.bin') });

let pass = 0, fail = 0;
const ok = (n, v, extra) => { console.log((v ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '   ' + extra : '')); v ? pass++ : fail++; };
const approx = (n, g, w, tol) => { const c = Number.isFinite(g) && Math.abs(g - w) <= tol; console.log((c ? 'PASS' : 'FAIL') + '  ' + n + `  (got=${Number.isFinite(g) ? g.toFixed(4) : g}, want≈${w} ±${tol})`); c ? pass++ : fail++; };

// —— 合成立方体：5°×5°、格距 1°（6×6 节点）、3 帧 ——
const NX = 6, NY = 6, NT = 3, N = NX * NY;
const T0 = Date.parse('2026-08-29T00:00:00Z'), HR = 3600000;
function makeCube(mut) {
  const mk = (v) => { const a = new Float32Array(N * NT); a.fill(v); return a; };
  const c = {
    id: 'test', bbox: { latMin: 36, latMax: 41, lonMin: 114, lonMax: 119 },
    step: 1, nx: NX, ny: NY, nt: NT, times: [T0, T0 + HR, T0 + 2 * HR],
    vars: {
      tC: mk(24), pMsl: mk(1005), rh: mk(0.8), td: mk(20),
      rain: mk(0), cloud: mk(0.5), wind: mk(3), wdir: mk(180), ptype: mk(0)
    },
    attrib: ['https://example/attr']
  };
  if (mut) mut(c);
  return c;
}
const at = (c, k, t, ix, iy, v) => { c.vars[k][t * N + iy * NX + ix] = v; };

console.log('\n=== 出参形状（必须与 envField.sampleField 同构）===');
const cube = makeCube();
const f0 = LF.sampleField(cube, { key: 'rain', frame: 0, step: 0.5 });
const NEED = ['key', 'label', 'unit', 'rec', 'dec', 'scheme', 'contourStep', 'native', 'precision',
  'ready', 'fallback', 'maskAvail', 'bbox', 'nx', 'ny', 'step', 'values', 'land', 'stats', 'statsLand'];
ok('含 envField 的全部关键字段', NEED.every((k) => k in f0), NEED.filter((k) => !(k in f0)).join(',') || '');
ok('values 是 Float32Array', f0.values instanceof Float32Array);
ok('nx/ny 由 bbox 与 step 定', f0.nx === 10 && f0.ny === 10, `${f0.nx}×${f0.ny}`);
ok('额外带上时间与归因（ITU 场没有的两项）',
  f0.frame === 0 && f0.frameT === T0 && Array.isArray(f0.attrib) && f0.attrib.length === 1);

console.log('\n=== 栅格取样约定（行 0 = 北，取格心）===');
// 只在最北一行（iy=5，lat=41）放雨，检查它落在栅格第 0 行
const cN = makeCube((c) => { for (let ix = 0; ix < NX; ix++) at(c, 'rain', 0, ix, NY - 1, 20); });
const fN = LF.sampleField(cN, { key: 'rain', frame: 0, step: 0.5 });
const rowMean = (f, j) => { let s = 0; for (let i = 0; i < f.nx; i++) s += f.values[j * f.nx + i]; return s / f.nx; };
ok('北端的雨出现在栅格第 0 行、南端为 0',
  rowMean(fN, 0) > rowMean(fN, fN.ny - 1) && rowMean(fN, fN.ny - 1) < 0.01,
  `row0=${rowMean(fN, 0).toFixed(2)} rowLast=${rowMean(fN, fN.ny - 1).toFixed(2)}`);

console.log('\n=== 空间双线性 ===');
// 立方体节点在 lonMin + ix·step（114,115,…）；栅格取的是**格心** lonMin+(i+0.5)·dLon，
// 两套格子刻意错开半格，故格心不会落在节点上——正好用来验插值。
// 节点 ix=2(lon 116)=0、ix=3(lon 117)=10；格距 0.5° 时格心 i=4 在 116.25（tx=0.25 → 2.5），
// i=5 在 116.75（tx=0.75 → 7.5）。
const cB = makeCube((c) => { for (let iy = 0; iy < NY; iy++) { at(c, 'rain', 0, 2, iy, 0); at(c, 'rain', 0, 3, iy, 10); } });
const fB = LF.sampleField(cB, { key: 'rain', frame: 0, step: 0.5 });
const midRow = Math.floor(fB.ny / 2);
approx('节点间 1/4 处插出 2.5', fB.values[midRow * fB.nx + 4], 2.5, 1e-4);
approx('节点间 3/4 处插出 7.5', fB.values[midRow * fB.nx + 5], 7.5, 1e-4);

console.log('\n=== 时间：就近取帧、不插值 ===');
const cT = makeCube((c) => { for (let ix = 0; ix < NX; ix++) for (let iy = 0; iy < NY; iy++) { at(c, 'rain', 0, ix, iy, 0); at(c, 'rain', 1, ix, iy, 20); } });
const fr = LF.frameAt(cT, T0 + 0.4 * HR);
ok('偏 0.4 h → 取第 0 帧', fr.idx === 0 && fr.inRange);
ok('偏 0.6 h → 取第 1 帧', LF.frameAt(cT, T0 + 0.6 * HR).idx === 1);
const fMid = LF.sampleField(cT, { key: 'rain', tMs: T0 + 0.4 * HR, step: 1 });
ok('★ 取的是整帧的值(0)，没有插成 8 —— 时间上不插值', Math.abs(fMid.values[0] - 0) < 1e-6,
  `got=${fMid.values[0]}`);
ok('时刻远超已取时段 → inRange=false（界面据此灰掉图层）',
  LF.frameAt(cT, T0 + 99 * HR).inRange === false);

console.log('\n=== 三类留白都是 NaN，不拿 0 顶替 ===');
const cH = makeCube((c) => { at(c, 'tC', 0, 0, 0, NaN); });     // 取数失败的缺格
const fH = LF.sampleField(cH, { key: 'rain', frame: 0, step: 1 });
ok('① 缺格 → NaN 且计入 note',
  Number.isNaN(fH.values[(fH.ny - 1) * fH.nx + 0]) && /无数据/.test(fH.note), fH.note);

const cS = makeCube((c) => {
  for (let ix = 0; ix < NX; ix++) for (let iy = 0; iy < NY; iy++) { at(c, 'rain', 0, ix, iy, 8); at(c, 'ptype', 0, ix, iy, 2); }
});
const fS = LF.sampleField(cS, { key: 'rainAtten', frame: 0, step: 1, satLon: 110.5, freq: 20 });
ok('② 全域降雪 → 雨衰整片 NaN 且 note 点明 P.838 不适用',
  fS.values.every((v) => Number.isNaN(v)) && /P\.838/.test(fS.note), fS.note);

// 星在地平线以下：把窗口挪到 GEO 星看不见的地方
const cO = makeCube((c) => { c.bbox = { latMin: 80, latMax: 85, lonMin: 0, lonMax: 5 }; });
const fO = LF.sampleField(cO, { key: 'gasAtten', frame: 0, step: 1, satLon: 110.5, freq: 20 });
ok('③ 高纬对 GEO 不可见 → NaN 且 note 点明',
  fO.values.every((v) => Number.isNaN(v)) && /不可见/.test(fO.note), fO.note);

console.log('\n=== 衰减场 ===');
ok('衰减场缺卫星轨位时明确报错（不硬算）',
  /轨位/.test((LF.sampleField(cube, { key: 'rainAtten', frame: 0, freq: 20 }) || {}).error || ''));
ok('isSatField 分类正确',
  LF.isSatField('rainAtten') && LF.isSatField('gasAtten') && LF.isSatField('totalAtten')
  && !LF.isSatField('rain') && !LF.isSatField('cloud'));

const mkRain = (R) => makeCube((c) => {
  for (let t = 0; t < NT; t++) for (let ix = 0; ix < NX; ix++) for (let iy = 0; iy < NY; iy++) { at(c, 'rain', t, ix, iy, R); at(c, 'ptype', t, ix, iy, 1); }
});
const A = (R, f) => LF.sampleField(mkRain(R), { key: 'rainAtten', frame: 0, step: 1, satLon: 110.5, freq: f }).stats.mean;
ok('雨衰随雨强单调增', A(5, 20) < A(20, 20) && A(20, 20) < A(50, 20),
  `5→${A(5, 20).toFixed(2)}  20→${A(20, 20).toFixed(2)}  50→${A(50, 20).toFixed(2)} dB`);
ok('同雨强 Ka(20) > Ku(12.5)', A(20, 20) > A(20, 12.5),
  `Ka=${A(20, 20).toFixed(2)} Ku=${A(20, 12.5).toFixed(2)} dB`);

// ★ 插值顺序：必须「先插雨强、再算 dB」，不能「先算 dB、再插 dB」。
//   两者差别真实存在，因为 γ = k·R^α 的 α > 1（超线性）。
//   ★ 不能拿「半湿场的均值」跟「全湿场均值的一半」比 —— 那个对照被地理污染了：
//     湿的那半正好是离星更远、仰角更低、路径更长的一半，几何差异盖过插值顺序的差异。
//     故改成在**同一个点**上比：拿过渡带里的一格，看它等于哪一种算法。
const inst2 = require('../utils/instantAtten.js');
const cEdge = makeCube((c) => {
  for (let t = 0; t < NT; t++) for (let iy = 0; iy < NY; iy++) {
    for (let ix = 0; ix < NX; ix++) { at(c, 'rain', t, ix, iy, ix >= 3 ? 40 : 0); at(c, 'ptype', t, ix, iy, 1); }
  }
});
const fEdge = LF.sampleField(cEdge, { key: 'rainAtten', frame: 0, step: 0.5, satLon: 110.5, freq: 20 });
// 格心 i=4 → lon 116.25，落在节点 116(R=0) 与 117(R=40) 之间，tx=0.25 → 插出的雨强 = 10
const jj = Math.floor(fEdge.ny / 2), LATc = fEdge.bbox.latMax - (jj + 0.5) * ((fEdge.bbox.latMax - fEdge.bbox.latMin) / fEdge.ny);
const LONc = fEdge.bbox.lonMin + 4.5 * fEdge.step;
const cellVal = fEdge.values[jj * fEdge.nx + 4];
const one = (R) => inst2.computeInstant({
  lat: LATc, lon: LONc, altKm: 0, freq: 20, pol: 'C', satLon: 110.5,
  met: { t: T0, kind: 'fcst', tC: 24, pMslHpa: 1005, rh: 0.8, tdC: 20, rainMmH: R, precipType: 'rain', cloud: 0.5 }
}).rainDb;
const wayA = one(10);                       // 先插雨强(0→40 的 1/4 = 10)，再算 dB   ← 应当是这个
const wayB = 0.25 * one(40) + 0.75 * one(0); // 先算 dB 再插 dB                      ← 不该是这个
approx('★ 过渡带的值 = 先插雨强再算 dB', cellVal, wayA, 0.02);
ok('★ 且明显不等于「先算 dB 再插 dB」（α>1 使两者分开）', Math.abs(cellVal - wayB) > 0.05,
  `本格=${cellVal.toFixed(3)}  插雨强=${wayA.toFixed(3)}  插dB=${wayB.toFixed(3)} dB`);

const fTot = LF.sampleField(mkRain(20), { key: 'totalAtten', frame: 0, step: 1, satLon: 110.5, freq: 20 });
const fGas = LF.sampleField(mkRain(20), { key: 'gasAtten', frame: 0, step: 1, satLon: 110.5, freq: 20 });
ok('合计 > 单独气体（含云与雨）', fTot.stats.mean > fGas.stats.mean,
  `合计=${fTot.stats.mean.toFixed(2)} 气体=${fGas.stats.mean.toFixed(2)} dB`);

console.log('\n=== 派生场与单位 ===');
const fRho = LF.sampleField(cube, { key: 'rho', frame: 0, step: 1 });
approx('ρ 由实测 T/露点算出（24 °C / 露点 20 °C ≈ 17.3 g/m³）', fRho.stats.mean, 17.3, 0.5);
const fRh = LF.sampleField(cube, { key: 'rh', frame: 0, step: 1 });
approx('相对湿度出图按 % （0.8 → 80）', fRh.stats.mean, 80, 1e-6);
const fCloud = LF.sampleField(cube, { key: 'cloud', frame: 0, step: 1 });
approx('云量出图按 % （0.5 → 50）', fCloud.stats.mean, 50, 1e-6);

console.log('\n=== 点数上限（衰减场每格要跑一次 P.676）===');
const fCap = LF.sampleField(cube, { key: 'gasAtten', frame: 0, step: 0.005, satLon: 110.5, freq: 20 });
ok('衰减场自动放粗到 4 万点以内', fCap.nx * fCap.ny <= 40000, `${fCap.nx}×${fCap.ny}=${fCap.nx * fCap.ny}`);
const fCap2 = LF.sampleField(cube, { key: 'rain', frame: 0, step: 0.005 });
ok('非衰减场上限放宽到 25 万点', fCap2.nx * fCap2.ny > 40000 && fCap2.nx * fCap2.ny <= 250000, `${fCap2.nx * fCap2.ny}`);

console.log('\n=== 性能（时间轴拖动要跟得上）===');
const tStart = Date.now();
for (let i = 0; i < 5; i++) LF.sampleField(mkRain(10), { key: 'totalAtten', frame: i % NT, step: 0.1, satLon: 110.5, freq: 20 });
const per = (Date.now() - tStart) / 5;
const fPerf = LF.sampleField(mkRain(10), { key: 'totalAtten', frame: 0, step: 0.1, satLon: 110.5, freq: 20 });
ok('合计衰减场 ' + fPerf.nx + '×' + fPerf.ny + ' 单帧 < 400 ms', per < 400, `实测 ${per.toFixed(0)} ms/帧`);

console.log('\n=== 多站逐点读数（站点表走的那条路）===');
{
  // 只在西南角那一格下大雨，检查逐站取值确实取到了各自那一格，而不是全场一个数
  const cP = makeCube((c) => { at(c, 'rain', 0, 0, 0, 40); at(c, 'rain', 1, 0, 0, 0); });
  const PTS = [
    { id: 'sw', name: '西南角', lat: 36, lon: 114 },
    { id: 'ne', name: '东北角', lat: 41, lon: 119 },
    { id: 'out', name: '窗外', lat: 10, lon: 60 },
    { id: 'bad', name: '坏坐标', lat: NaN, lon: 1 }
  ];
  const r0 = LF.samplePoints(cP, { pts: PTS, frame: 0, satLon: 110.5, freq: 12.5, pol: 'C', minElev: 5 });
  const by = (id) => r0.rows.find((x) => x.id === id);
  ok('逐站各取各的格（不是全场一个数）', by('sw').rainMmH > 30 && by('ne').rainMmH < 0.01,
    `西南=${by('sw').rainMmH.toFixed(1)} 东北=${by('ne').rainMmH.toFixed(1)}`);
  ok('★ 窗外的点如实报错，不拿边界值顶替', by('out').err === '在取数范围外' && by('out').rainMmH === undefined, by('out').err);
  ok('★ 坏坐标如实报错', by('bad').err === '坐标无效', by('bad').err);
  ok('行序与入参一致（表格靠这个对上号）', r0.rows.map((x) => x.id).join(',') === 'sw,ne,out,bad');
  ok('给了轨位就出链路量', Number.isFinite(by('sw').elev) && Number.isFinite(by('sw').totalDb));
  ok('雨大的那站雨衰更大', by('sw').rainDb > by('ne').rainDb, `${by('sw').rainDb.toFixed(3)} vs ${by('ne').rainDb.toFixed(3)}`);

  // ★ 值跟时间轴走：同一站换一帧，读数必须跟着变
  const r1 = LF.samplePoints(cP, { pts: PTS, frame: 1, satLon: 110.5, freq: 12.5, pol: 'C', minElev: 5 });
  const sw1 = r1.rows.find((x) => x.id === 'sw');
  ok('★ 换帧后读数跟着变（不是钉在第 0 帧）', by('sw').rainDb > 0 && sw1.rainDb === 0,
    `帧0=${by('sw').rainDb.toFixed(3)} 帧1=${sw1.rainDb.toFixed(3)}`);
  ok('帧时刻如实回报', r1.frameT === T0 + HR);

  // 不给轨位 → 只出气象量，不硬算链路量
  const rNo = LF.samplePoints(cP, { pts: PTS, frame: 0 });
  const swNo = rNo.rows.find((x) => x.id === 'sw');
  ok('没给轨位就不出链路量（不硬算）', Number.isFinite(swNo.rainMmH) && swNo.totalDb === undefined && swNo.elev === undefined);

  // 低仰角闸对逐点同样生效
  const rLo = LF.samplePoints(cP, { pts: [{ id: 'a', lat: 41, lon: 119 }], frame: 0, satLon: 110.5, freq: 12.5, minElev: 89 });
  ok('低仰角闸逐点同样生效', /仰角 </.test(rLo.rows[0].err || ''), rLo.rows[0].err);

  // 云衰实测档：立方体没有柱云水时如实退回统计档
  ok('无柱云水时云衰退回统计档并标出',
    LF.samplePoints(cP, { pts: [{ id: 'a', lat: 38, lon: 116 }], frame: 0, satLon: 110.5, cloudMode: 'measured' }).cloudFellBack === true);
  const cW = makeCube((c) => { c.vars.cwat = new Float32Array(c.vars.tC.length).fill(1.2); });
  const rW = LF.samplePoints(cW, { pts: [{ id: 'a', lat: 38, lon: 116 }], frame: 0, satLon: 110.5, freq: 20, cloudMode: 'measured' });
  ok('有柱云水时走实测档，云衰随它变', rW.cloudFellBack === false && rW.rows[0].cloudDb > 0,
    `L=1.2 → ${rW.rows[0].cloudDb.toFixed(3)} dB`);

  // ★ 真正会踩的那一种：数组【在】但整片是 NaN —— 栅格 provider 的立方体是整块预分配的
  //   （gfs.js 的 mk() + fill(NaN)），源里没有 CWAT、或某个时次的报文恰好缺了它，留下的就是这个。
  //   按「数组在不在」判会走进实测档，逐格取到 NaN||0=0 → 云衰恒 0 dB，而「已退回统计档」一句不报。
  const cNaN = makeCube((c) => { c.vars.cwat = new Float32Array(c.vars.tC.length).fill(NaN); });
  const rNaN = LF.samplePoints(cNaN, { pts: [{ id: 'a', lat: 38, lon: 116 }], frame: 0, satLon: 110.5, freq: 20, cloudMode: 'measured' });
  ok('柱云水数组在但全是 NaN → 退回统计档，不是 0 dB',
    rNaN.cloudFellBack === true && rNaN.rows[0].cloudDb > 0,
    `${rNaN.rows[0].cloudDb.toFixed(3)} dB`);
  ok('该点的柱云水读数如实留空（不拿 0 顶替）', !Number.isFinite(rNaN.rows[0].cwat));

  // 逐【帧】判，不是逐立方体判：只有第 1 帧有 CWAT 时，第 0 帧必须退回统计档
  const cF1 = makeCube((c) => {
    const a = new Float32Array(c.vars.tC.length); a.fill(NaN);
    for (let i = 0; i < N; i++) a[1 * N + i] = 1.2;      // 只有 frame=1 有值
    c.vars.cwat = a;
  });
  const pt1 = [{ id: 'a', lat: 38, lon: 116 }];
  const cwF0 = LF.samplePoints(cF1, { pts: pt1, frame: 0, satLon: 110.5, freq: 20, cloudMode: 'measured' });
  const cwF1 = LF.samplePoints(cF1, { pts: pt1, frame: 1, satLon: 110.5, freq: 20, cloudMode: 'measured' });
  ok('缺 CWAT 的那一帧退回统计档、有的那一帧走实测',
    cwF0.cloudFellBack === true && cwF1.cloudFellBack === false,
    `f0=${cwF0.rows[0].cloudDb.toFixed(3)} f1=${cwF1.rows[0].cloudDb.toFixed(3)} dB`);

  // 出图那一路同一条判据：note 要说出来，「柱云水」场要留白而不是画一片 0
  const fA = LF.sampleField(cNaN, { key: 'cloudAtten', frame: 0, step: 1, satLon: 110.5, freq: 20, cloudMode: 'measured', minElev: 0 });
  ok('云衰场：全 NaN 柱云水 → 退回统计档并在 note 里说明',
    /无柱云水/.test(fA.note || '') && fA.stats && fA.stats.max > 0, fA.note);
  const fC = LF.sampleField(cNaN, { key: 'cwat', frame: 0, step: 1 });
  ok('柱云水场：整场留白 + note 说明数据源不提供',
    /不提供柱云水/.test(fC.note || '') && fC.stats === null, fC.note);

  // ★ 逐点是在**立方体原生格**上算，不是在降采样后的出图栅格上采样 ——
  //   出图那张为了跑得动会降采样，在它上面采站址等于二次插值。
  const fGrid = LF.sampleField(cP, { key: 'rain', frame: 0, step: 2 });   // 刻意出一张很粗的图
  const j = Math.min(fGrid.ny - 1, Math.floor((fGrid.bbox.latMax - 36) / ((fGrid.bbox.latMax - fGrid.bbox.latMin) / fGrid.ny)));
  const gv = fGrid.values[j * fGrid.nx];
  ok('★ 逐点不受出图降采样影响', Math.abs(by('sw').rainMmH - 40) < 1e-6 && Math.abs(gv - 40) > 1e-6,
    `逐点=${by('sw').rainMmH.toFixed(2)} 粗图同点=${gv.toFixed(2)}`);
}

// ── Polygon 裁剪 ────────────────────────────────────────────────────────────
// 取数窗永远是矩形（子集服务只吃 bbox），能做成任意形状的只有**出图那一步**。
// 判据全是「谁被留白了」：多边形内有数、多边形外一律 NaN，且统计只算多边形内。
console.log('\n=== Polygon 裁剪（区域＝多边形）===');
{
  const cQ = makeCube((c) => { c.vars.rain.fill(5); });
  // 立方体覆盖 36~41°N / 114~119°E；取其西南角那一小块正方形
  const sq = [[114.5, 36.5], [116.5, 36.5], [116.5, 38.5], [114.5, 38.5]];
  const full = LF.sampleField(cQ, { key: 'rain', frame: 0, step: 0.5 });
  const clip = LF.sampleField(cQ, { key: 'rain', frame: 0, step: 0.5, poly: sq });
  const finite = (f) => { let n = 0; for (let i = 0; i < f.values.length; i++) if (Number.isFinite(f.values[i])) n++; return n; };
  ok('裁剪不改栅格尺寸（bbox 仍是立方体的）', clip.nx === full.nx && clip.ny === full.ny, `${clip.nx}×${clip.ny}`);
  ok('多边形外一律留白（NaN），不是 0', finite(clip) > 0 && finite(clip) < finite(full),
    `裁剪后 ${finite(clip)} 格 / 全场 ${finite(full)} 格`);
  ok('留下的格数与多边形面积相称', Math.abs(finite(clip) / finite(full) - (2 * 2) / (5 * 5)) < 0.06,
    `${(finite(clip) / finite(full) * 100).toFixed(1)}% vs 面积比 16.0%`);
  ok('出参回报裁剪状态与格数', clip.clip === true && clip.inPoly === finite(clip) && full.clip === false);

  // 落点核对：多边形内一格有数、多边形外那一格必须是 NaN（配准错了这条第一个报）
  const px = (f, lat, lon) => {
    const dLat = (f.bbox.latMax - f.bbox.latMin) / f.ny, dLon = (f.bbox.lonMax - f.bbox.lonMin) / f.nx;
    const j = Math.floor((f.bbox.latMax - lat) / dLat), i = Math.floor((lon - f.bbox.lonMin) / dLon);
    return f.values[j * f.nx + i];
  };
  ok('★ 内点有数、外点留白（配准）',
    Math.abs(px(clip, 37.5, 115.5) - 5) < 1e-6 && !Number.isFinite(px(clip, 40.5, 118.5)),
    `内=${px(clip, 37.5, 115.5)} 外=${px(clip, 40.5, 118.5)}`);

  // 统计只算多边形内：把多边形外堆成一个极值，裁剪后的极大值不该被它带跑
  const cH = makeCube((c) => { c.vars.rain.fill(5); at(c, 'rain', 0, 5, 5, 90); });   // 东北角 119°E/41°N
  const cl2 = LF.sampleField(cH, { key: 'rain', frame: 0, step: 0.5, poly: sq });
  const fu2 = LF.sampleField(cH, { key: 'rain', frame: 0, step: 0.5 });
  ok('★ 统计只算多边形内（外面的极值进不来）', fu2.stats.max > 20 && cl2.stats.max < 6,
    `全场 max=${fu2.stats.max.toFixed(1)} 裁剪 max=${cl2.stats.max.toFixed(1)}`);

  // 入参两种写法都吃，点数不足 3 的按「没给多边形」处理（不静默画一片空白）
  const objForm = LF.sampleField(cQ, { key: 'rain', frame: 0, step: 0.5, poly: sq.map(([lon, lat]) => ({ lon, lat })) });
  ok('[lon,lat] 与 {lon,lat} 两种写法一致', finite(objForm) === finite(clip));
  ok('顶点不足 3 个＝不裁剪', LF.sampleField(cQ, { key: 'rain', frame: 0, step: 0.5, poly: [[114, 36], [115, 37]] }).clip === false);

  // 凹多边形：射线法必须把凹口挖掉（凸包法会把它填上，这条专防那种偷懒实现）
  const cShape = [[114.5, 36.5], [118.5, 36.5], [118.5, 40.5], [116.8, 40.5], [116.8, 37.5], [116.2, 37.5], [116.2, 40.5], [114.5, 40.5]];
  const cc = LF.sampleField(cQ, { key: 'rain', frame: 0, step: 0.25, poly: cShape });
  ok('★ 凹多边形的凹口是空的（不是凸包）',
    Number.isFinite(px(cc, 38.5, 115.5)) && Number.isFinite(px(cc, 38.5, 117.5)) && !Number.isFinite(px(cc, 39.5, 116.5)));

  // 衰减场：多边形外连引擎都不跑 —— 同一张图裁掉大半，耗时应当明显下降
  const cA = makeCube((c) => { c.vars.rain.fill(8); });
  const tf0 = Date.now(); const fA = LF.sampleField(cA, { key: 'rainAtten', frame: 0, step: 0.1, satLon: 110.5, minElev: 0 }); const msFull = Date.now() - tf0;
  const tc0 = Date.now(); const cA2 = LF.sampleField(cA, { key: 'rainAtten', frame: 0, step: 0.1, satLon: 110.5, minElev: 0, poly: sq }); const msClip = Date.now() - tc0;
  ok('★ 多边形外不跑 ITU 引擎（裁剪比全场快）', msClip < msFull, `全场 ${msFull} ms → 裁剪 ${msClip} ms`);
  ok('裁剪后的衰减场仍有值', Number.isFinite(cA2.stats && cA2.stats.max) && cA2.stats.max > 0, `max=${cA2.stats ? cA2.stats.max.toFixed(2) : '—'} dB`);
  void fA;
}

console.log('\n=== 目标星：任意轨道（普适性）===');
{
  const inst2 = require('../utils/instantAtten.js');
  const cR = makeCube((c) => { c.vars.rain.fill(8); });
  // 立方体覆盖 36~41°N / 114~119°E。把 LEO 放在窗心正上方 → 全窗高仰角、整场有值。
  const OVER = { lat: 38.5, lon: 116.5, altKm: 780 };
  const fLeo = LF.sampleField(cR, { key: 'rainAtten', frame: 0, step: 0.5, satPos: OVER, minElev: 5 });
  ok('非静止轨道目标能出图（从前只认 GEO 轨位）', !fLeo.error && fLeo.stats && fLeo.stats.max > 0,
    fLeo.error || `max=${fLeo.stats ? fLeo.stats.max.toFixed(2) : '—'} dB`);
  ok('出参标明用的是通用几何与星下点', fLeo.geomModel === 'orbit' && fLeo.satPos && fLeo.satPos.altKm === 780);

  // 同一颗星挪到地球另一侧：整场应当全是「不可见」，一格数都不该有
  const fBack = LF.sampleField(cR, { key: 'rainAtten', frame: 0, step: 0.5, satPos: { lat: -38, lon: -63, altKm: 780 }, minElev: 5 });
  ok('★ 星在地球另一侧时整场留白（不是画成 0 dB）', !fBack.stats, fBack.note);
  ok('留白如实计数到「对该星不可见」', /不可见/.test(fBack.note || ''), fBack.note);

  // ★ LEO 的衰减场 = 它此刻的足迹：一片有边界的圆盘，星越走越远，画面上的可见区单调退出。
  //   （400 km 高、最低仰角 5° 时，可见半径约 15° 大圆角；下面这串经度正好扫过窗口的边界。）
  const vis = [126, 130, 134, 136, 138, 140].map((lon) => {
    const f = LF.sampleField(cR, { key: 'rainAtten', frame: 0, step: 0.25, satPos: { lat: 38.5, lon, altKm: 400 }, minElev: 5 });
    let fin = 0; for (const v of f.values) if (Number.isFinite(v)) fin++;
    return fin;
  });
  ok('★ 低轨目标的可见区有边界（部分格有值、部分留白）', vis[3] > 0 && vis[3] < 400, `有值 ${vis[3]} / 共 400`);
  ok('★ 星越走越远，可见区单调退出画面（足迹随星走，不是一张钉死的图）',
    vis.every((n, i) => i === 0 || n <= vis[i - 1]) && vis[0] === 400 && vis[vis.length - 1] === 0,
    vis.join(' → '));

  // 手算锚点：GEO 轨位与「把该轨位折成星下点」两条路差 0.03° 量级 —— 刻意不折算，见 satGeom 的注释
  const fGeo = LF.sampleField(cR, { key: 'rainAtten', frame: 0, step: 0.5, satLon: 110.5, minElev: 0 });
  const fAsPos = LF.sampleField(cR, { key: 'rainAtten', frame: 0, step: 0.5, satPos: inst2.geoSatPos(110.5), minElev: 0 });
  const d = Math.abs(fGeo.stats.mean - fAsPos.stats.mean);
  ok('GEO 轨位档与「同一位置按通用几何」结果相近但不等（两套几何并存的证据）',
    d > 0 && d < 0.05, `Δ均值 ${d.toExponential(2)} dB`);

  // 逐点：斜距列 + 不可见站也给几何读数
  const pts = [{ id: 'a', name: '窗心', lat: 38.5, lon: 116.5 }, { id: 'b', name: '边角', lat: 36.2, lon: 114.2 }];
  const rp = LF.samplePoints(cR, { pts, frame: 0, satPos: OVER, minElev: 5 });
  ok('逐点：非静止轨道目标出链路量', Number.isFinite(rp.rows[0].totalDb));
  approx('逐点斜距与 lookAngles 一致', rp.rows[0].rangeKm,
    inst2.lookAngles({ lat: 38.5, lon: 116.5, altKm: rp.rows[0].altKm }, OVER).rangeKm, 1e-6);
  const rpFar = LF.samplePoints(cR, { pts, frame: 0, satPos: { lat: -38, lon: -63, altKm: 780 }, minElev: 5 });
  ok('★ 不可见的站也给出仰角与斜距（读表要看得出差多少才可见，不是一片空白）',
    Number.isFinite(rpFar.rows[0].elev) && rpFar.rows[0].elev < 0 && Number.isFinite(rpFar.rows[0].rangeKm),
    `elev=${rpFar.rows[0].elev.toFixed(2)}° range=${rpFar.rows[0].rangeKm.toFixed(0)} km`);
  ok('不可见的站不给衰减数', rpFar.rows[0].totalDb === undefined);

  // GEO 档也照报斜距（读数用椭球算，与 satPos 档同口径）
  const rpGeo = LF.samplePoints(cR, { pts, frame: 0, satLon: 110.5, minElev: 0 });
  ok('GEO 档同样给斜距读数', rpGeo.rows[0].rangeKm > 35000 && rpGeo.rows[0].rangeKm < 42000,
    `${rpGeo.rows[0].rangeKm.toFixed(0)} km`);

  // 两个都不给：如实报错，不默认挑一颗
  ok('两种目标都不给时衰减场报错而不是空图',
    /目标卫星/.test(LF.sampleField(cR, { key: 'rainAtten', frame: 0, step: 0.5 }).error || ''));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
