// 环境场取数测试（主窗口「环境场」图层的数据源）。运行：npm test
//
// 关键不变式：
//   ① 栅格上的值 === 引擎逐点查表的值（同一套 query*）——图上的颜色必须就是预算表里那个数；
//   ② 行 0 = 北、格心取样（贴图/位图约定），错了整张图会上下翻或半格错位；
//   ③ 数据未就绪时如实报（ready/precision/fallback），不拿回退值冒充全精度；
//   ④ 面积加权均值按 cos φ（等经纬格在高纬代表的面积小得多，不加权会把极区权重放大数倍）。
const fs = require('fs');
const path = require('path');
const core = require('../index.js');
const envField = require('../utils/envField.js');
const rainRate = require('../utils/rainRate.js');
const elevation = require('../utils/elevation.js');
const { getIsothermHeight } = require('../utils/isothermHeight.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''));
  cond ? pass++ : fail++;
}

console.log('=== 环境场取数测试 ===\n');

// 与 electron/main.js 同一条加载路径：本地 resources/itu 注入全精度数据
const ituDir = path.join(__dirname, '../../../resources/itu');
const rd = (f) => { try { return fs.readFileSync(path.join(ituDir, f)); } catch (e) { return null; } };
const rep = core.loadFullPrecisionData({
  rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'),
  vapor: rd('p836_rho_v1.bin'), cloud: rd('p840_logn_v1.bin')
});
const fullRain = rainRate.isFullDataReady(), fullElev = elevation.isElevationReady();
console.log('全精度数据：' + JSON.stringify(rep) + '\n');

// ① 注册表
{
  const defs = envField.FIELD_DEFS;
  ok('字段注册表 6 项', defs.length === 6, defs.map((d) => d.key).join(','));
  ok('每项都有 label/unit/rec/native', defs.every((d) => d.label && d.unit !== undefined && d.rec && d.native > 0));
  ok('未知字段返回 error', !!envField.sampleField('nope', {}).error);
}

// ② 栅格几何：行 0 = 北、格心取样
{
  const f = envField.sampleField('h0', { step: 2 });
  ok('全球 2° → 180×90', f.nx === 180 && f.ny === 90, `${f.nx}×${f.ny}`);
  ok('bbox 全球', f.bbox.latMax === 90 && f.bbox.lonMin === -180);
  // 行 0 应对应北纬 89（格心 = 90 − 0.5×2），h0 在极区最低、赤道最高 → 第一行必然小于中间行
  const north = f.values[0], equator = f.values[Math.floor(f.ny / 2) * f.nx];
  ok('行 0 = 北（极区 h0 低于赤道）', north < equator, `${north.toFixed(2)} < ${equator.toFixed(2)} km`);
  // 格心取样：values[j][i] 必须等于该格心处直接查表的值
  const j = 20, i = 33;
  const lat = 90 - (j + 0.5) * 2, lon = -180 + (i + 0.5) * 2;
  ok('格心取样与逐点查表一致', Math.abs(f.values[j * f.nx + i] - getIsothermHeight(lat, lon)) < 1e-6);
}

// ③ 取值口径 = 引擎口径（随机抽点比对，误差必须是 0）
{
  const f = envField.sampleField('rain', { step: 1 });
  // 栅格按 Float32 存（4 MB vs 8 MB，走 IPC 的是它）→ 比对要在 float32 上做：
  // 允许的差别只有这一次存储取整，不允许有别的
  let bad = 0, worst = 0;
  for (let n = 0; n < 200; n++) {
    const j = (n * 37) % f.ny, i = (n * 53) % f.nx;
    const lat = 90 - (j + 0.5) * 1, lon = -180 + (i + 0.5) * 1;
    const want = rainRate.queryRainRate(lat, lon).rainRate;
    if (f.values[j * f.nx + i] !== Math.fround(want)) bad++;
    worst = Math.max(worst, Math.abs(f.values[j * f.nx + i] - want));
  }
  ok('降雨率栅格 === queryRainRate（200 点，float32 精确相等）', bad === 0, `绝对差 ≤ ${worst.toExponential(1)}`);
  ok('降雨率精度标注', fullRain ? f.precision === '0.125°' : /回退/.test(f.precision), f.precision);
  ok('降雨率非负且有量级', f.stats.max > 20 && f.stats.min >= 0, `${f.stats.min}~${f.stats.max} mm/h`);
}

// ④ 派生量：雨高 = h0 + 0.36
{
  const h0 = envField.sampleField('h0', { step: 4 });
  const hr = envField.sampleField('hr', { step: 4 });
  let worst = 0;
  for (let i = 0; i < h0.values.length; i += 7) worst = Math.max(worst, Math.abs(hr.values[i] - h0.values[i] - envField.HR_OFFSET));
  ok('雨高 hR = h0 + 0.36 km', worst < 1e-6, `最大差 ${worst.toExponential(1)}`);
}

// ⑤ 海拔 + 陆海掩膜
{
  const f = envField.sampleField('elev', { step: 1, mask: true });
  ok('海拔就绪标志与内核一致', f.ready === fullElev && f.maskAvail === fullElev);
  if (fullElev) {
    ok('海拔栅格 === queryElevation', f.values[100 * f.nx + 200] === elevation.queryElevation(90 - 100.5, -180 + 200.5).altitude);
    ok('掩膜已生成', !!f.land && f.land.length === f.values.length);
    ok('陆地统计与全域不同（陆地最低值高于洋底）', f.statsLand && f.statsLand.min > f.stats.min, `${f.stats.min} → ${f.statsLand.min} m`);
    ok('陆地面积占比 25%~35%', f.statsLand.count / f.values.length > 0.2 && f.statsLand.count / f.values.length < 0.4,
      (100 * f.statsLand.count / f.values.length).toFixed(1) + '%');
    // 珠峰所在格（27.99N, 86.93E）应为陆地且高于 5000 m
    const g = envField.sampleField('elev', { latMin: 27, latMax: 29, lonMin: 86, lonMax: 88, step: 0.1 });
    ok('局部取数（珠峰片区）峰值 > 5000 m', g.stats.max > 5000, `${g.stats.max} m`);
    ok('局部 bbox 生效', g.bbox.latMin === 27 && g.nx === 20 && g.ny === 20, `${g.nx}×${g.ny}`);
  } else {
    ok('海拔数据缺失时值全 NaN 且如实标注', f.stats === null && /未就绪/.test(f.precision), f.precision);
  }
}

// ⑥ 面积加权均值：cos φ 加权（与算术平均必须不同，且落在极值之间）
{
  const f = envField.sampleField('rain', { step: 2 });
  let sum = 0, n = 0;
  for (let i = 0; i < f.values.length; i++) { if (f.values[i] === f.values[i]) { sum += f.values[i]; n++; } }
  const plain = sum / n;
  ok('均值在极值之间', f.stats.mean > f.stats.min && f.stats.mean < f.stats.max, f.stats.mean.toFixed(2));
  ok('面积加权 ≠ 算术平均', Math.abs(f.stats.mean - plain) > 1e-3, `${f.stats.mean.toFixed(3)} vs ${plain.toFixed(3)}`);
  ok('分位数有序 p2 ≤ p50 ≤ p98', f.stats.p2 <= f.stats.p50 && f.stats.p50 <= f.stats.p98, `${f.stats.p2}/${f.stats.p50}/${f.stats.p98}`);
}

// ⑦ 口径参数：水汽晴天/雨天、云的超越概率
{
  const dry = envField.sampleField('rho', { step: 4, rainy: 0 });
  const wet = envField.sampleField('rho', { step: 4, rainy: 1 });
  ok('水汽晴天 ≠ 雨天', Math.abs(dry.stats.mean - wet.stats.mean) > 1e-3, `${dry.stats.mean.toFixed(2)} vs ${wet.stats.mean.toFixed(2)} g/m³`);
  const c1 = envField.sampleField('cloud', { step: 4, p: 1 });
  const c20 = envField.sampleField('cloud', { step: 4, p: 20 });
  if (c1.ready) {
    ok('云液态水随超越概率递减（p=1% 更湿）', c1.stats.mean > c20.stats.mean, `${c1.stats.mean.toFixed(3)} > ${c20.stats.mean.toFixed(3)} kg/m²`);
    ok('云口径与引擎同源（对数正态 Lred）', Math.abs(envField.pointValue('cloud', 22.5, 114, { p: 1 })
      - require('../utils/linkCalculator.js').cloudLWCFromLognormal(1, require('../data/cloudParamsGrid.js').getParams(22.5, 114))) < 1e-12);
  } else {
    ok('云数据缺失时如实标注', /未就绪/.test(c1.precision), c1.precision);
  }
}

// ⑧ 上限保护与非法入参
{
  const f = envField.sampleField('h0', { step: 0.01 });   // 全球 0.01° = 6.4 亿点，必须被压回上限内
  ok('总点数上限保护', f.nx * f.ny <= 4e6, `${f.nx}×${f.ny}`);
  ok('非法范围报错', !!envField.sampleField('h0', { latMin: 10, latMax: 10 }).error);
}

// ⑩ 地理配准哨兵 —— 每张 ITU 图的经纬基准必须对得上地面。
//
// 这条是补上来的：P.836 水汽密度的 .bin 是 ITU 的 0…360° 排布，代码却按 −180…180 读，整张图偏了
// 180°——撒哈拉的干区被搬到太平洋，查一个站点拿到的是地球对面的水汽。数值本身「看着合理」
// （2~20 g/m³ 都在量程内），逐点比对也发现不了，是把它画成图才看出来的。故这里用**物理签名**做判据：
// 干点必须比湿点干，且把经度整体推 180° 之后这个分离必须垮掉——垮不掉说明判据没抓住配准。
{
  const vapor = require('../data/waterVaporGrid.js');
  const cloudGrid = require('../data/cloudParamsGrid.js');
  const sep = (fn, dry, wet, shift) => {
    const d = dry.reduce((s, p) => s + fn(p[0], p[1] + (shift || 0)), 0) / dry.length;
    const w = wet.reduce((s, p) => s + fn(p[0], p[1] + (shift || 0)), 0) / wet.length;
    return w - d;   // 湿 − 干，正得越多说明配准越对
  };
  // 干：撒哈拉 / 阿拉伯 / 青藏 / 澳洲中部；湿：刚果 / 亚马逊 / 印尼 / 西太
  const DRY = [[23, 13], [22, 45], [30, 90], [-24, 133]];
  const WET = [[0, 20], [-3, -60], [0, 120], [5, 150]];

  if (vapor.isReady()) {
    const rho = (lat, lon) => vapor.getRhoWs(lat, lon, false);
    const s0 = sep(rho, DRY, WET), s180 = sep(rho, DRY, WET, 180);
    ok('P.836 水汽：干湿分离成立', s0 > 8, `湿−干 = ${s0.toFixed(1)} g/m³`);
    ok('P.836 水汽：推 180° 后分离垮掉（判据有效）', s180 < s0 / 2, `偏 180° 时 ${s180.toFixed(1)} g/m³`);
    ok('P.836 水汽：青藏高原极干（<3 g/m³）', rho(30, 90) < 3, rho(30, 90).toFixed(1));
    ok('P.836 水汽：赤道洋面湿（>15 g/m³）', rho(0, -160) > 15, rho(0, -160).toFixed(1));
  } else {
    ok('P.836 数据缺失，跳过配准哨兵', true);
  }

  const rr = (lat, lon) => rainRate.queryRainRate(lat, lon).rainRate;
  const r0 = sep(rr, DRY, WET), r180 = sep(rr, DRY, WET, 180);
  ok('P.837 降雨率：干湿分离成立', r0 > 40, `湿−干 = ${r0.toFixed(1)} mm/h`);
  ok('P.837 降雨率：推 180° 后分离垮掉', r180 < r0 / 2, `偏 180° 时 ${r180.toFixed(1)} mm/h`);

  if (cloudGrid.isReady()) {
    const pclw = (lat, lon) => { const p = cloudGrid.getParams(lat, lon); return p ? p.Pclw : NaN; };
    const c0 = sep(pclw, DRY, WET), c180 = sep(pclw, DRY, WET, 180);
    ok('P.840 云概率：干湿分离成立', c0 > 20, `湿−干 = ${c0.toFixed(1)}%`);
    ok('P.840 云概率：推 180° 后分离垮掉', c180 < c0 / 2, `偏 180° 时 ${c180.toFixed(1)}%`);
  } else {
    ok('P.840 数据缺失，跳过配准哨兵', true);
  }

  // P.839 h0：赤道高、两极低（纬向签名），且经度推 180° 不该改变这个关系（h0 主要随纬度）
  ok('P.839 零度等温线：赤道高于两极', getIsothermHeight(0, 20) > getIsothermHeight(80, 20) + 2,
    `${getIsothermHeight(0, 20).toFixed(2)} vs ${getIsothermHeight(80, 20).toFixed(2)} km`);
  // 经向签名：同纬度上青藏（干热高原）应高于同纬度的北大西洋
  ok('P.839 零度等温线：青藏高于同纬度大西洋', getIsothermHeight(30, 90) > getIsothermHeight(30, -40),
    `${getIsothermHeight(30, 90).toFixed(2)} vs ${getIsothermHeight(30, -40).toFixed(2)} km`);

  // P.1511 地形：珠峰一带 > 5000 m、马里亚纳一带 ≤ 0
  if (elevation.isElevationReady()) {
    ok('P.1511 地形：喜马拉雅 > 5000 m', elevation.queryElevation(28, 86.9).altitude > 5000);
    ok('P.1511 地形：西太平洋洋面 ≤ 0 m', elevation.queryElevation(15, 145).altitude <= 0);
  }
}

// ⑨ 出图耗时（默认 0.25° 全球 = 104 万点）：交互能接受的量级
{
  const t = Date.now();
  const f = envField.sampleField('rain', { step: 0.25 });
  const ms = Date.now() - t;
  ok('0.25° 全球取数 < 3000 ms', ms < 3000, `${ms} ms / ${(f.values.length / 1e4).toFixed(0)} 万点`);
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
if (fail) process.exit(1);
