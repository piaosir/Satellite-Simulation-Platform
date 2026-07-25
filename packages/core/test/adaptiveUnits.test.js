// 显示单位自适应测试（W/Hz/bps 线性换档 + dBW→dBm + 瀑布 segments 后处理）。运行：npm test
// 关键不变式：级联算式行（base/gain/loss/sub/chk/margin）的 dBW 一律不动——瀑布「逐行可手算」
// 依赖整条 dB 功率链同基准；只有独立参考/指标行（ref/kpi）允许 dBW→dBm。
const au = require('../utils/adaptiveUnits.js');
const { buildWaterfallSegments } = require('../utils/waterfallBuilder.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''));
  cond ? pass++ : fail++;
}

console.log('=== 显示单位自适应测试 ===\n');

// ① pickUnit：线性族换档（尾数落 [1,1000)）
{
  const p = au.pickUnit(2457.6, 'kHz');
  ok('kHz→MHz 换档', p && p.unit === 'MHz' && Math.abs(2457.6 * p.factor - 2.4576) < 1e-9, p && `${p.unit}`);
  ok('36 MHz 不换档', au.pickUnit(36, 'MHz') === null);
  const w = au.pickUnit(0.5, 'W');
  ok('0.5 W→mW', w && w.unit === 'mW' && Math.abs(0.5 * w.factor - 500) < 1e-9);
  const kw = au.pickUnit(4000, 'W');
  ok('4000 W→kW', kw && kw.unit === 'kW' && Math.abs(4000 * kw.factor - 4) < 1e-9);
  const hz = au.pickUnit(0.06, 'kHz');
  ok('0.06 kHz→Hz', hz && hz.unit === 'Hz' && Math.abs(0.06 * hz.factor - 60) < 1e-9);
  const uw = au.pickUnit(0.00001404, 'W');
  ok('1.4e-5 W→µW', uw && uw.unit === 'µW' && Math.abs(0.00001404 * uw.factor - 14.04) < 1e-9);
  const gb = au.pickUnit(2048000, 'kbps');
  ok('2048000 kbps→Gbps', gb && gb.unit === 'Gbps' && Math.abs(2048000 * gb.factor - 2.048) < 1e-9);
  ok('未知单位不动', au.pickUnit(123, 'dB') === null);
  ok('0 值不动', au.pickUnit(0, 'kHz') === null);
}

// ② pickColumn：整列共选（含 dBW 全负才转 dBm）
{
  const p = au.pickColumn([350, 1200, NaN], 'kHz');
  ok('列按最大值挑档（1200 kHz→MHz）', p && p.unit === 'MHz' && Math.abs(p.conv(350) - 0.35) < 1e-9);
  const d1 = au.pickColumn([-3.01, -12.5], 'dBW');
  ok('dBW 全负→dBm(+30)', d1 && d1.unit === 'dBm' && Math.abs(d1.conv(-3.01) - 26.99) < 1e-9);
  ok('dBW 有正值不转', au.pickColumn([-3.01, 12], 'dBW') === null);
  ok('全 NaN 不动', au.pickColumn([NaN, NaN], 'W') === null);
}

// ③ adaptSegments：瀑布行后处理（多列共档 / 标签(W)同步 / 级联行保护）
{
  const segs = [{
    title: 't', cols: 3, rows: [
      { kind: 'ref', label: '载波带宽', up: '2457.60', down: '', total: '', unit: 'kHz' },
      { kind: 'ref', label: '功放建议值(W)', up: '0.50', down: '', total: '', unit: 'W' },
      { kind: 'ref', label: '功放实际输出', up: '-3.01', down: '', total: '', unit: 'dBW' },
      { kind: 'base', label: '功放建议功率', up: '-3.01', down: '', total: '', unit: 'dBW' },
      { kind: 'sub', label: '到达卫星载波电平 C', up: '', down: '-120.55', total: '', unit: 'dBW' },
      { kind: 'ref', label: '最大多普勒', up: '350.00', down: '1200.00', total: '', unit: 'kHz' },
      { kind: 'ref', label: '调制方式', up: 'QPSK', down: '8PSK', total: '', unit: '' },
      { kind: 'kpi', label: '卫星饱和 EIRP', up: '', down: '46.00', total: '', unit: 'dBW' }
    ]
  }];
  au.adaptSegments(segs);
  const r = segs[0].rows;
  ok('kHz→MHz（2457.60→2.4576）', r[0].unit === 'MHz' && r[0].up === '2.4576');
  ok('W→mW + 标签(W)→(mW)', r[1].unit === 'mW' && r[1].up === '500' && r[1].label === '功放建议值(mW)');
  ok('独立行 dBW→dBm', r[2].unit === 'dBm' && r[2].up === '26.99');
  ok('级联 base 行 dBW 不动', r[3].unit === 'dBW' && r[3].up === '-3.01');
  ok('级联 sub 检查点 dBW 不动', r[4].unit === 'dBW' && r[4].down === '-120.55');
  ok('双列共档（按最大 1200 kHz→MHz）', r[5].unit === 'MHz' && r[5].up === '0.35' && r[5].down === '1.2');
  ok('文本行不动', r[6].up === 'QPSK' && r[6].unit === '');
  ok('正值 dBW 不转 dBm', r[7].unit === 'dBW' && r[7].down === '46.00');
}

// ④ 集成：buildWaterfallSegments 出口已接自适应（GEO 构建器，最小合成结果）
{
  const segs = buildWaterfallSegments({
    results: { linkmargin: '3.00', allocBandwidthResult: '36000.00', paRecommendation: '0.50' },
    lang: 'zh', orbitType: 'GEO'
  });
  const rows = [];
  for (const s of segs) for (const row of s.rows) rows.push(row);
  const bw = rows.find((row) => row.key === '载波带宽');
  ok('GEO 瀑布载波带宽 36000 kHz→36 MHz', bw && bw.unit === 'MHz' && bw.up === '36', bw && `${bw.up} ${bw.unit}`);
  const pa = rows.find((row) => row.key === '功放建议功率(W)');
  ok('GEO 瀑布功放 0.5 W→500 mW（标签同步）', pa && pa.unit === 'mW' && pa.up === '500' && pa.label === '功放建议功率(mW)');
}

// ⑤ 引擎小功率精度回归：微瓦级功放不得被 toFixed(3) 舍成 '0.000'（线性值与 dB 侧一致，
// 瀑布自适应据此换 µW 档）——对应实际用户场景（16 m 站 + 1 kbps 低速率载波）
{
  const geo = require('../utils/linkCalculator.js');
  const r = geo.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: 'D' },
    { infoRate: '1', antennaDiameter: '16', ebno: '1', margin: '0' }).data;
  const w = parseFloat(r.paRecommendation);
  const fromDb = Math.pow(10, parseFloat(r.paRecommendationdBResult) / 10);
  ok('引擎微瓦级功放线性值非零', isFinite(w) && w > 0, `paRecommendation=${r.paRecommendation}`);
  ok('线性值与 dB 侧一致（<1% 相对误差）', Math.abs(w - fromDb) / fromDb < 0.01, `W=${w}, 10^(dB/10)=${fromDb}`);
  const segs = buildWaterfallSegments({ results: r, lang: 'zh', orbitType: 'GEO' });
  const rows = [];
  for (const s of segs) for (const row of s.rows) rows.push(row);
  const pa = rows.find((row) => row.key === '功放建议功率(W)');
  ok('微瓦级功放瀑布换 µW 档', pa && pa.unit === 'µW' && parseFloat(pa.up) > 1, pa && `${pa.up} ${pa.unit}`);
  const paDbm = rows.find((row) => row.key === '功放实际输出');
  ok('独立行功放实际输出 dBW→dBm', paDbm && paDbm.unit === 'dBm', paDbm && `${paDbm.up} ${paDbm.unit}`);
}

console.log(`\n共 ${pass + fail} 项：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
