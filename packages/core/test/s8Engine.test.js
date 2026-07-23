// NGSO / 再生式链路预算引擎的 ITU-R P.618-14 §8 统计口径测试（无框架，纯断言）。运行：npm test
// 覆盖：① 默认关闭=原单仰角口径（向后兼容）② 开启后与独立雨衰计算器同源一致（bit 级等效仰角）
//      ③ FSL/斜距等确定几何量不受影响（几何与统计正交）④ 各退化/出域路径静默回退
//      ⑤ 再生式上行/下行经 s8 参数同样生效 ⑥ 渲染层 s8LinkParams 门控（近圆/同步周期/快照/偏心）
const path = require('path');
const { pathToFileURL } = require('url');
const ngso = require('../utils/linkCalculatorNGSO.js');
const regen = require('../utils/linkCalculatorRegen.js');
const rainTool = require('../utils/rainAttenuation.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''));
  cond ? pass++ : fail++;
}
function approx(name, got, want, tol) {
  const g = parseFloat(got);
  ok(name, Number.isFinite(g) && Math.abs(g - want) <= tol, `got=${g}, want≈${want} ±${tol}`);
}

console.log('=== §8 统计口径（引擎接入）测试 ===\n');

// 广州站 MEO 8000km/45°，Ku 14.25/12.5 GHz，最低仰角 10°，可用度 99.9%（双重最坏高估最典型的算例）
const satParams = { frequencyBand: 'Ku', satelliteName: 'S8TEST' };
const base = {
  centerFrequency: '14.25', rxCenterFrequency: '12.5', uplinkPolarization: 'V',
  longitude: '113.26', latitude: '23.13', rxLongitude: '113.26', rxLatitude: '23.13',
  minElevation: '10', rxMinElevation: '10',
  distanceMode: 'altitude', orbitAltitude: '8000', rxOrbitAltitude: '8000',
  uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9',
  rainRate: '83', rxRainRate: '83', margin: '3'
};
const s8On = Object.assign({}, base, {
  s8Mode: '1', s8OrbitAltKm: '8000', s8InclDeg: '45', s8MinElevUp: '10', s8MinElevDn: '10'
});

// ① 默认关闭：无 s8 诊断，雨衰为单仰角(10°)口径
const dOff = ngso.calculateLinkBudget(satParams, Object.assign({}, base)).data;
ok('默认关闭：无 s8 诊断字段', dOff.s8Mode === false && dOff.uplinkS8 === null && dOff.downlinkS8 === null);
approx('默认关闭：上行雨衰=单仰角口径(回归锁定)', dOff.uplinkRainAttenuation, 26.09, 0.05);

// ② 开启：与独立雨衰计算器（§8 已落地）同源一致
const dOn = ngso.calculateLinkBudget(satParams, s8On).data;
ok('开启：上/下行诊断 applied', dOn.uplinkS8 && dOn.uplinkS8.applied === true && dOn.downlinkS8 && dOn.downlinkS8.applied === true);
const ref = rainTool.calculateRainAttenuation({
  lat: 23.13, lon: 113.26, freq: 14.25, pol: 'V', availability: 99.9, rainRate: 83,
  ngsoStat: true, orbitAltKm: 8000, inclDeg: 45, minElevDeg: 10, direction: 'up'
});
approx('开启：等效仰角与雨衰计算器 bit 级一致', dOn.uplinkS8.elevEq, ref.s8.elevEq, 1e-9);
approx('开启：上行雨衰 = 计算器 §8 雨衰', dOn.uplinkRainAttenuation, ref.rainAtten, 0.01);
ok('开启：§8 雨衰显著低于单仰角口径', parseFloat(dOn.uplinkRainAttenuation) < parseFloat(dOff.uplinkRainAttenuation) - 10,
  `${dOff.uplinkRainAttenuation} → ${dOn.uplinkRainAttenuation} dB`);
ok('开启：展示字段就位', dOn.uplinkS8ElevResult !== '' && dOn.downlinkS8ElevResult !== '');

// ③ 几何与统计正交：FSL/斜距/仰角显示不因 §8 改变
ok('FSL/斜距不变', dOn.uplinkFSLResult === dOff.uplinkFSLResult && dOn.slantRangeResult === dOff.slantRangeResult
  && dOn.downlinkFSLResult === dOff.downlinkFSLResult && dOn.elevationResult === dOff.elevationResult);

// ④ 退化/出域路径：静默回退单仰角口径
const dNoRain = ngso.calculateLinkBudget(satParams, Object.assign({}, s8On, { rainRate: '0', rxRainRate: '0' })).data;
const dNoRainOff = ngso.calculateLinkBudget(satParams, Object.assign({}, base, { rainRate: '0', rxRainRate: '0' })).data;
ok('无雨退化：不覆盖统计仰角、输出与关闭一致', dNoRain.uplinkS8.applied === false
  && dNoRain.uplinkAtmosphericAttenuationResult === dNoRainOff.uplinkAtmosphericAttenuationResult);
const rLow = ngso.calculateLinkBudget(satParams, Object.assign({}, s8On, { uplinkAvailability: '90', rxDownlinkAvailability: '90' }));
ok('可用度<95%（p>5 出 ITU 域）：回退且不崩', rLow.success && rLow.data.uplinkS8.applied === false);
const rInvis = ngso.calculateLinkBudget(satParams, Object.assign({}, s8On, { latitude: '65', rxLatitude: '65', s8InclDeg: '0', s8OrbitAltKm: '550' }));
ok('轨道对站不可见：回退且不崩', rInvis.success && rInvis.data.uplinkS8.applied === false);
const dMiss = ngso.calculateLinkBudget(satParams, Object.assign({}, base, { s8Mode: '1', s8OrbitAltKm: '8000' })).data;
ok('缺倾角：完全等同关闭', dMiss.uplinkS8 === null && dMiss.uplinkRainAttenuation === dOff.uplinkRainAttenuation);

// ⑤ 再生式：上行（s8MinElevUp）与下行（s8MinElevDn）各自生效
const regenUpOff = regen.computeRegenUplinkMode(satParams, Object.assign({}, base), { mode: 'power', powerW: 100 });
const regenUpOn = regen.computeRegenUplinkMode(satParams, Object.assign({}, base, {
  s8Mode: '1', s8OrbitAltKm: '8000', s8InclDeg: '45', s8MinElevUp: '10'
}), { mode: 'power', powerW: 100 });
ok('再生上行：计算成功', regenUpOff.success && regenUpOn.success);
// 热噪声 C/N 的改善应严格等于功率链衰减（雨+气+云，§8 后仰角同步抬高）的改善；
// 合成余量的改善小于它（固定干扰 C/I 底噪压缩热噪声收益——LEO 特征，非误差）。
const upThermalGain = parseFloat(regenUpOn.data.uplinkThermalCN) - parseFloat(regenUpOff.data.uplinkThermalCN);
const upAttenSaved = (parseFloat(regenUpOff.data.uplinkRainAttenuation) - parseFloat(regenUpOn.data.uplinkRainAttenuation))
  + (parseFloat(regenUpOff.data.uplinkAtmosphericAttenuationResult) - parseFloat(regenUpOn.data.uplinkAtmosphericAttenuationResult))
  + (parseFloat(regenUpOff.data.uplinkCloudAttenuation) - parseFloat(regenUpOn.data.uplinkCloudAttenuation));
approx('再生上行：热噪声 C/N 改善 = Σ(雨+气+云)衰减改善', upThermalGain, upAttenSaved, 0.05);
ok('再生上行：余量改善为正且 ≤ 热噪声改善（干扰底噪压缩）',
  parseFloat(regenUpOn.data.linkmargin) > parseFloat(regenUpOff.data.linkmargin)
  && (parseFloat(regenUpOn.data.linkmargin) - parseFloat(regenUpOff.data.linkmargin)) <= upThermalGain + 0.05,
  `余量 ${regenUpOff.data.linkmargin} → ${regenUpOn.data.linkmargin}, 热噪声 +${upThermalGain.toFixed(2)}`);
ok('再生上行：仅上行侧 §8（下行未传不求解）', regenUpOn.data.uplinkS8 && regenUpOn.data.uplinkS8.applied === true
  && regenUpOn.data.downlinkS8 === null);

const regenDnOff = regen.computeRegenDownlinkMode(satParams, Object.assign({}, base), { mode: 'power' });
const regenDnOn = regen.computeRegenDownlinkMode(satParams, Object.assign({}, base, {
  s8Mode: '1', s8OrbitAltKm: '8000', s8InclDeg: '45', s8MinElevDn: '10'
}), { mode: 'power' });
ok('再生下行：计算成功', regenDnOff.success && regenDnOn.success);
ok('再生下行：§8 生效且雨衰下降', regenDnOn.data.downlinkS8 && regenDnOn.data.downlinkS8.applied === true
  && parseFloat(regenDnOn.data.downlinkRainAttenuationResult) < parseFloat(regenDnOff.data.downlinkRainAttenuationResult) - 10,
  `${regenDnOff.data.downlinkRainAttenuationResult} → ${regenDnOn.data.downlinkRainAttenuationResult} dB`);
ok('再生下行：余量随之改善', parseFloat(regenDnOn.data.linkmargin) > parseFloat(regenDnOff.data.linkmargin) + 5);

// ⑥ 渲染层 s8LinkParams 门控（ESM 动态导入）
(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '../../../src/shared/s8Params.js')).href);
  const s8LinkParams = mod.s8LinkParams;
  const leo = { elements: { a: 6378.137 + 550, e: 0.0001, iDeg: 53, periodMin: 95.6 } };
  const geoSync = { elements: { a: 42164, e: 0.0002, iDeg: 0.05, periodMin: 1436.1 } };
  const inclGeoSync = { elements: { a: 42164, e: 0.001, iDeg: 60, periodMin: 1436.1 } };
  const heo = { elements: { a: 26562, e: 0.72, iDeg: 63.4, periodMin: 717.8 } };
  const snap = { static: true, elements: { a: 42164, e: 0, iDeg: 20, periodMin: 1436.1 } };
  const p1 = s8LinkParams(leo, { minElevUp: '25', minElevDn: '10' });
  ok('门控：近圆 LEO 启用（双侧）', p1.s8Mode === '1' && Math.abs(p1.s8OrbitAltKm - 550) < 0.01
    && p1.s8InclDeg === 53 && p1.s8MinElevUp === 25 && p1.s8MinElevDn === 10);
  ok('门控：单侧最低仰角仅注该侧', s8LinkParams(leo, { minElevUp: '25' }).s8MinElevDn === undefined);
  ok('门控：GEO 周期跳过', Object.keys(s8LinkParams(geoSync, { minElevUp: '10' })).length === 0);
  ok('门控：倾斜 GEO 同步周期跳过', Object.keys(s8LinkParams(inclGeoSync, { minElevUp: '10' })).length === 0);
  ok('门控：大偏心 HEO 跳过', Object.keys(s8LinkParams(heo, { minElevUp: '10' })).length === 0);
  ok('门控：快照/静止星跳过', Object.keys(s8LinkParams(snap, { minElevUp: '10' })).length === 0);
  ok('门控：无最低仰角跳过', Object.keys(s8LinkParams(leo, {})).length === 0);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
