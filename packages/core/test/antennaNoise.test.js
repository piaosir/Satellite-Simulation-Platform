// 天线噪声温度「自动/自定义」模式测试（GEO + NGSO 引擎）。运行：npm test
// 自动 = ITU-R P.618-14 §3 式(69)(70)：T_ant = 275·(1−10^(−Ag/10)) + 2.7·10^(−Ag/10) + 25(地面拾取)，
// Ag 取下行大气气体衰减（NGSO §8 统计口径下即等效仰角处的值）。
// 关键不变式：模式缺省/未传 = 自定义（手填）——既有配置与 GEO 回归基线不受影响。
const geo = require('../utils/linkCalculator.js');
const ngso = require('../utils/linkCalculatorNGSO.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''));
  cond ? pass++ : fail++;
}
function approx(name, got, want, tol) {
  const g = parseFloat(got);
  ok(name, Number.isFinite(g) && Math.abs(g - want) <= tol, `got=${g}, want≈${want} ±${tol}`);
}

console.log('=== 天线噪温 自动/自定义 模式测试 ===\n');

// ① GEO：模式未传 = 自定义，输出与旧口径完全一致（回归锁定由 accuracy.test.js 承担，这里做直接对照）
const gOff = geo.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: 'D' }, {}).data;
ok('GEO 未传模式 = 自定义（35 K 原值）', gOff.antennaNoiseTempResult === 35 && gOff.antennaNoiseTempModeResult === '自定义');

// ② GEO 自动：北京→110.5°E（仰角 43.4°），Ku 下行 12.5 GHz——自动值应落在传统缺省 35 K 附近（新旧连续）
const gAuto = geo.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: 'D' }, { rxAntennaNoiseTempMode: '自动' }).data;
const tAutoGeo = parseFloat(gAuto.antennaNoiseTempResult);
ok('GEO 自动：T_ant 在传统缺省附近（30~42 K）', tAutoGeo >= 30 && tAutoGeo <= 42, `T=${tAutoGeo} K, Ag=${gAuto.downlinkAtmosphericAttenuationResult} dB`);
ok('GEO 自动：模式标注', gAuto.antennaNoiseTempModeResult === '自动');
// 手算核对：T = 275·(1−L) + 2.7·L + 25，L = 10^(−Ag/10)。
// Ag 取自结果字段（已四舍五入到 2 位小数），±0.005 dB 舍入经 275 K 系数放大 ≈ ±0.32 K → 容差 0.35。
{
  const L = Math.pow(10, -parseFloat(gAuto.downlinkAtmosphericAttenuationResult) / 10);
  approx('GEO 自动：公式核对', tAutoGeo, 275 * (1 - L) + 2.7 * L + 25, 0.35);
}

// ③ NGSO：自动模式的仰角依赖——10° vs 60°（大气路径厚度差 → 天空噪温差）
const base = {
  centerFrequency: '14.25', rxCenterFrequency: '12.5', uplinkPolarization: 'V',
  longitude: '113.26', latitude: '23.13', rxLongitude: '113.26', rxLatitude: '23.13',
  distanceMode: 'altitude', orbitAltitude: '8000', rxOrbitAltitude: '8000',
  uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9', rainRate: '38', rxRainRate: '38', margin: '3',
  rxAntennaNoiseTempMode: '自动'
};
const nLow = ngso.calculateLinkBudget({ frequencyBand: 'Ku' }, Object.assign({}, base, { minElevation: '10', rxMinElevation: '10' })).data;
const nHigh = ngso.calculateLinkBudget({ frequencyBand: 'Ku' }, Object.assign({}, base, { minElevation: '60', rxMinElevation: '60' })).data;
const tLow = parseFloat(nLow.antennaNoiseTempResult), tHigh = parseFloat(nHigh.antennaNoiseTempResult);
ok('NGSO 自动：低仰角天空更亮（T(10°) > T(60°) + 5 K）', tLow > tHigh + 5, `T(10°)=${tLow}, T(60°)=${tHigh} K`);
ok('NGSO 自动：G/T 随之变化', parseFloat(nLow.gOverTeResult) < parseFloat(nHigh.gOverTeResult),
  `G/T ${nLow.gOverTeResult} → ${nHigh.gOverTeResult} dB/K`);

// ④ NGSO + §8：自动噪温取等效仰角处的大气衰减（比钉在最低仰角的天空噪温低）
const s8On = Object.assign({}, base, {
  minElevation: '10', rxMinElevation: '10',
  s8Mode: '1', s8OrbitAltKm: '8000', s8InclDeg: '45', s8MinElevUp: '10', s8MinElevDn: '10'
});
const nS8 = ngso.calculateLinkBudget({ frequencyBand: 'Ku' }, s8On).data;
ok('NGSO 自动+§8：噪温低于最低仰角口径', parseFloat(nS8.antennaNoiseTempResult) < tLow,
  `§8 T=${nS8.antennaNoiseTempResult} K（等效仰角 ${nS8.downlinkS8ElevResult}°） vs 10° T=${tLow} K`);

// ⑤ 自定义模式：数值原样生效
const nMan = ngso.calculateLinkBudget({ frequencyBand: 'Ku' }, Object.assign({}, base, {
  minElevation: '10', rxMinElevation: '10', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '50'
})).data;
ok('自定义：手填 50 K 原样生效', nMan.antennaNoiseTempResult === 50 && nMan.antennaNoiseTempModeResult === '自定义');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
