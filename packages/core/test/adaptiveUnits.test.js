// 显示单位自适应测试（W/Hz/bps 线性换档 + dBW→dBm + 瀑布 segments 后处理）。运行：npm test
// 关键不变式：级联算式行（base/gain/loss/sub/chk/margin）的 dBW 一律不动——瀑布「逐行可手算」
// 依赖整条 dB 功率链同基准；只有独立参考/指标行（ref/kpi）允许 dBW→dBm。
// ★ 换档要显式开：adaptSegments / pickColumn 的最后一参、buildWaterfallSegments 的 ctx.adaptUnits，
//   不给一律【锁定】（＝留在引擎基准单位）——与四窗功能区「单位」档的出厂值一致，见 ⑧。
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
  ok('4000 W 不换档（无 kW 档）', au.pickUnit(4000, 'W') === null);
  ok('0.999 W→mW（门限 1 W）', (() => { const p = au.pickUnit(0.999, 'W'); return p && p.unit === 'mW' && Math.abs(0.999 * p.factor - 999) < 1e-9; })());
  ok('1 W 不换档（门限含等号）', au.pickUnit(1, 'W') === null);
  const hz = au.pickUnit(0.06, 'kHz');
  ok('0.06 kHz→Hz', hz && hz.unit === 'Hz' && Math.abs(0.06 * hz.factor - 60) < 1e-9);
  const uw = au.pickUnit(0.00001404, 'W');
  ok('1.4e-5 W→mW（不再下探 µW）', uw && uw.unit === 'mW' && Math.abs(0.00001404 * uw.factor - 0.01404) < 1e-12);
  const gb = au.pickUnit(2048000, 'kbps');
  ok('2048000 kbps→Gbps', gb && gb.unit === 'Gbps' && Math.abs(2048000 * gb.factor - 2.048) < 1e-9);
  ok('未知单位不动', au.pickUnit(123, 'dB') === null);
  ok('0 值不动', au.pickUnit(0, 'kHz') === null);
}

// ② pickColumn：整列共选（含 dBW 全负才转 dBm）
{
  const p = au.pickColumn([350, 1200, NaN], 'kHz', true);
  ok('列按最大值挑档（1200 kHz→MHz）', p && p.unit === 'MHz' && Math.abs(p.conv(350) - 0.35) < 1e-9);
  const d1 = au.pickColumn([-3.01, -12.5], 'dBW', true);
  ok('dBW 全负→dBm(+30)', d1 && d1.unit === 'dBm' && Math.abs(d1.conv(-3.01) - 26.99) < 1e-9);
  ok('dBW 有正值不转', au.pickColumn([-3.01, 12], 'dBW', true) === null);
  ok('全 NaN 不动', au.pickColumn([NaN, NaN], 'W', true) === null);
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
  au.adaptSegments(segs, true);
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
    lang: 'zh', orbitType: 'GEO', adaptUnits: true
  });
  const rows = [];
  for (const s of segs) for (const row of s.rows) rows.push(row);
  const bw = rows.find((row) => row.key === '载波带宽');
  ok('GEO 瀑布载波带宽 36000 kHz→36 MHz', bw && bw.unit === 'MHz' && bw.up === '36', bw && `${bw.up} ${bw.unit}`);
  // v1.4.6 段重整：旧「功率谱·增益与噪声」里的『功放建议功率(W)』与「可用度与资源」里的
  // 『功放建议值(W)』本是同一个字段（paRecommendation）列了两遍，已合并进 §9 资源占用这一处。
  const pa = rows.find((row) => row.key === '功放建议值(W)');
  ok('GEO 瀑布功放 0.5 W→500 mW（标签同步）', pa && pa.unit === 'mW' && pa.up === '500' && pa.label === '功放建议值(mW)');
}

// ⑤ 引擎小功率精度回归：微瓦级功放不得被 toFixed(3) 舍成 '0.000'（线性值与 dB 侧一致，
// 瀑布自适应据此换 mW 档）——对应实际用户场景（16 m 站 + 1 kbps 低速率载波）。
// 档位只到 mW，故这一档写作 0.0145 mW（fmtScaled 保 4 位小数，仍留 3 位有效数字，不塌成 0）。
{
  const geo = require('../utils/linkCalculator.js');
  const r = geo.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: 'D' },
    { infoRate: '1', antennaDiameter: '16', ebno: '1', margin: '0' }).data;
  const w = parseFloat(r.paRecommendation);
  const fromDb = Math.pow(10, parseFloat(r.paRecommendationdBResult) / 10);
  ok('引擎微瓦级功放线性值非零', isFinite(w) && w > 0, `paRecommendation=${r.paRecommendation}`);
  ok('线性值与 dB 侧一致（<1% 相对误差）', Math.abs(w - fromDb) / fromDb < 0.01, `W=${w}, 10^(dB/10)=${fromDb}`);
  const segs = buildWaterfallSegments({ results: r, lang: 'zh', orbitType: 'GEO', adaptUnits: true });
  const rows = [];
  for (const s of segs) for (const row of s.rows) rows.push(row);
  const pa = rows.find((row) => row.key === '功放建议值(W)');
  ok('微瓦级功放瀑布换 mW 档且未塌成 0', pa && pa.unit === 'mW' && parseFloat(pa.up) > 0, pa && `${pa.up} ${pa.unit}`);
  const paDbm = rows.find((row) => row.key === '功放实际输出');
  ok('独立行功放实际输出 dBW→dBm', paDbm && paDbm.unit === 'dBm', paDbm && `${paDbm.up} ${paDbm.unit}`);

  // ⑥ 机读数值不变式（报表铺路层）：屏幕显示串与行上挂的 num 必须永远是同一个数。
  // 这条一挂就说明有人只改了显示层没改 num（换档、回填、格式化都是嫌疑），
  // 后果是屏幕上核对过的数字与导出的 Excel 对不上——链路预算里这是致命的。
  const NUMF = { up: 'num', down: 'numDown', total: 'numTotal' };
  const COLS = { 1: ['up'], 2: ['up', 'down'], 3: ['up', 'down', 'total'] };
  let bad = null, checked = 0;
  for (const s of segs) {
    for (const row of s.rows) {
      for (const c of (COLS[s.cols] || ['up'])) {
        const f = NUMF[c];
        if (!Object.prototype.hasOwnProperty.call(row, f)) continue;
        const shown = String(row[c] === undefined || row[c] === null ? '' : row[c]).trim();
        const n = Number(shown);
        const expect = (shown === '' || shown === '—' || shown === '-' || !Number.isFinite(n)) ? null : n;
        checked++;
        if (row[f] !== expect && !bad) bad = `§${s.no} ${s.titleZh} / ${row.key} / ${c}: 显示 "${shown}" vs num ${row[f]}`;
      }
    }
  }
  ok('显示串与机读 num 逐格一致', !bad, bad || `${checked} 格全对`);

  // ⑦ 工况对照段（晴空 / 降雨 / 雨致代价）——引擎只算降雨一档，晴空档由 builder 按 dB 反推。
  // 用构造数据精确核对：上行只加雨衰，下行加雨衰 + G/T 劣化，合成以引擎的 carrierTotalCN 为锚、
  // 只叠加并联式算出的增量（直接拿并联绝对值会与引擎差个舍入尾数，无雨时显示成假台阶 −0.01）。
  {
    const par = (a, bb) => -10 * Math.log10(Math.pow(10, -a / 10) + Math.pow(10, -bb / 10));
    // 下行功率链字段要配齐：GEO 构建器要靠它们反解「转嫁到下行的上行残余雨衰」
    // （dnResidualRain = 下行热噪声C/N − G/T劣化 − 下行C/N − 下行干扰损失）。缺字段时 null 按 0 参与
    // 算术，会反解出一个上百 dB 的假残余量。此处配成残余量恰为 0 的一组。
    const segsW = buildWaterfallSegments({
      results: {
        linkmargin: '3.00', thresholdCN: '4.50', RXnoiseBW: '65.00',
        uplinkCN: '12.00', downlinkCN: '10.00', carrierTotalCN: '7.50',
        uplinkRainAttenuation: '3.50', downlinkRainAttenuationResult: '7.60',
        gOverTdegradationResult: '2.90',
        uplinkPowerRatioResult: '10', downlinkPowerRatioResult: '20',  // 下行主导 → 下行雨衰/劣化计入
        transponderOutputEIRP: '50.00', downlinkFSLResult: '206.00', gOverTeResult: '12.90',
        downlinkInterferenceLossResult: '0.00'
      },
      lang: 'zh', orbitType: 'GEO', adaptUnits: true
    });
    const w = segsW.find((s) => s.id === 'weather');
    const row = (label) => w && w.rows.find((x) => x.key === label);
    ok('工况对照段存在且为双列', !!w && w.cols === 2 && w.heads.join('/') === '晴空/降雨',
      w && w.cols + ' 列 ' + (w.heads || []).join('/'));
    const up = row('上行 C/(N+I)'), dn = row('下行 C/(N+I)'), tot = row('合成 C/(N+I)');
    ok('上行晴空 = 降雨 + 上行雨衰', up && up.up === '15.5' && up.down === '12',
      up && `${up.up} / ${up.down}`);
    ok('下行晴空 = 降雨 + 下行雨衰 + G/T 劣化', dn && dn.up === '20.5' && dn.down === '10',
      dn && `${dn.up} / ${dn.down}`);
    // 代价明细行落在「降雨」列
    const cost = (label) => { const x = row(label); return x ? x.down : null; };
    ok('代价明细逐条列出（上行雨衰 / 下行雨衰 / G-T 劣化）',
      cost('上行雨衰') === '3.5' && cost('下行雨衰') === '7.6' && cost('G/T 劣化（降雨）') === '2.9',
      `${cost('上行雨衰')} / ${cost('下行雨衰')} / ${cost('G/T 劣化（降雨）')}`);
    const expClear = Math.round((7.5 + (par(15.5, 20.5) - par(12, 10))) * 100) / 100;
    ok('合成晴空以引擎值为锚 + 并联增量', tot && Math.abs(parseFloat(tot.up) - expClear) < 0.011,
      tot && `${tot.up} vs 期望 ${expClear}`);
    // 无雨时不得出现「雨致代价 −0.01」这种舍入假台阶
    const segsDry = buildWaterfallSegments({
      results: {
        linkmargin: '3.00', thresholdCN: '4.50', RXnoiseBW: '65.00',
        uplinkCN: '12.80', downlinkCN: '13.03', carrierTotalCN: '9.91',
        uplinkRainAttenuation: '0.00', downlinkRainAttenuationResult: '0.00', gOverTdegradationResult: '0.00',
        uplinkPowerRatioResult: '10', downlinkPowerRatioResult: '20',
        transponderOutputEIRP: '50.00', downlinkFSLResult: '206.00', gOverTeResult: '5.43',
        downlinkInterferenceLossResult: '0.00'
      },
      lang: 'zh', orbitType: 'GEO', adaptUnits: true
    });
    const wd = segsDry.find((s) => s.id === 'weather');
    // 无雨：晴空档与降雨档必须逐行相等（并联式重算若不以引擎值为锚，这里会差出 0.01 的假台阶）
    const bad = wd && wd.rows.filter((x) => x.up !== '' && x.down !== '' && x.up !== x.down);
    ok('无雨时晴空档与降雨档逐行相等（无舍入假台阶）', bad && bad.length === 0,
      bad && bad.map((x) => `${x.key}: ${x.up} vs ${x.down}`).join(', '));
  }

  // 段元数据：报表端按 id / no 认段，不受 lang 影响
  const ids = segs.map((s) => s.id).join(',');
  ok('GEO 段序齐全且编号连续',
    ids === 'carrier,geometry,propagation,satellite,psd,noise,cascade,performance,weather,interference,resources' &&
    segs.every((s, i) => s.no === i + 1), ids);
  const en = buildWaterfallSegments({ results: r, lang: 'en', orbitType: 'GEO', adaptUnits: true });
  ok('英文报表段 id / 号不变（只有 title 变）',
    en.map((s) => s.id).join(',') === ids && en[0].title === 'Carrier & Modulation' && en[0].titleZh === '载波与调制参数',
    en[0].title);
}

// ⑧ 锁定档（缺省）：一律留在引擎基准单位。四窗功能区「单位」出厂就是这一档，
// 且本文件不认识 localStorage——默认值一旦漂到「自适应」，就会出现「屏幕锁定、报告却换了档」。
{
  ok('pickColumn 不给档位 = 不换', au.pickColumn([350, 1200], 'kHz') === null);
  ok('pickColumn 显式 false = 不换', au.pickColumn([350, 1200], 'kHz', false) === null);
  ok('pickColumn 锁定时 dBW 也不转 dBm', au.pickColumn([-3.01, -12.5], 'dBW') === null);
  const segs = [{
    title: 't', cols: 1, rows: [
      { kind: 'ref', label: '载波带宽', up: '2457.60', num: 2457.6, unit: 'kHz' },
      { kind: 'ref', label: '功放建议值(W)', up: '0.50', num: 0.5, unit: 'W' },
      { kind: 'ref', label: '功放实际输出', up: '-3.01', num: -3.01, unit: 'dBW' }
    ]
  }];
  au.adaptSegments(segs);
  const r = segs[0].rows;
  ok('锁定：kHz 不换 MHz', r[0].unit === 'kHz' && r[0].up === '2457.60' && r[0].num === 2457.6);
  ok('锁定：W 不换 mW，标签(W) 原样', r[1].unit === 'W' && r[1].up === '0.50' && r[1].label === '功放建议值(W)');
  ok('锁定：独立行 dBW 不转 dBm', r[2].unit === 'dBW' && r[2].up === '-3.01');
  // 走一遍真构建器：出口不给 ctx.adaptUnits 时，36000 kHz 就该原样是 36000 kHz
  const wf = buildWaterfallSegments({
    results: { linkmargin: '3.00', allocBandwidthResult: '36000.00', paRecommendation: '0.50' },
    lang: 'zh', orbitType: 'GEO'
  });
  const rows = [];
  for (const sg of wf) for (const row of sg.rows) rows.push(row);
  const bw = rows.find((row) => row.key === '载波带宽');
  ok('GEO 瀑布缺省锁定：36000 kHz 原样', bw && bw.unit === 'kHz' && bw.up === '36000.00', bw && (bw.up + ' ' + bw.unit));
  const pa = rows.find((row) => row.key === '功放建议值(W)');
  ok('GEO 瀑布缺省锁定：0.5 W 原样、标签不改', pa && pa.unit === 'W' && pa.label === '功放建议值(W)', pa && (pa.up + ' ' + pa.unit));
}

console.log(`\n共 ${pass + fail} 项：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
