// 地面业务干扰传播库 · 联调冒烟测试（无框架，纯断言）。
//   运行： node packages/core/test/terrestrial.test.mjs
//
// 各模块的数值正确性由各自单测对官方数据负责（p452 / p676 / p2108 / p2109 / f1336 / m2101 / ap7）。
// 本文件只管两件事：
//   ① 统一出口 utils/terrestrial/index.js 能一次加载全部模块；
//   ② 「IMT 基站 → C 频段接收地球站」一条典型链路能从头串到尾，且各模块之间的口径接得上：
//      P.452-18 剖面损耗 → §4.6 两端离轴角 → M.2101 AAS / F.1336 扇区基站增益 → RR AP7 附件 3 地球站增益
//      → I/N；同一站址再按 AP7 求协调距离。断言只查一致性与量级关系，不另造基准值。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const T = require('../utils/terrestrial/index.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
};
const finite = (...xs) => xs.every((x) => typeof x === 'number' && Number.isFinite(x));
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const wrap = (a) => ((a + 540) % 360) - 180;

console.log('=== ① 统一出口 ===');
for (const k of ['common', 'p676', 'p452', 'p2108', 'p2109', 'f1336', 'm2101', 'ap7']) ok(`index.${k} 已加载`, !!T[k] && typeof T[k] === 'object');
ok('平铺入口 basicTransmissionLoss / radioMetAt', typeof T.basicTransmissionLoss === 'function' && typeof T.radioMetAt === 'function');

console.log('\n=== ② IMT 基站 → C 频段接收地球站 ===');
// 地球站：北京附近，天线中心离地 5 m，指向 125°E 静止卫星；主轴增益 42.7 dBi（约 4.5 m 口面 @ 3.6 GHz）
const ES = { lat: 39.9, lon: 116.4, hag: 5, GmaxDbi: 42.7, satLon: 125 };
const look = T.ap7.gsoLookAngles(ES.lat, 0, ES.satLon - ES.lon);
ok('地球站对星仰角 / 方位（附件 3 式 (84)–(88)）', finite(look.elevDeg, look.azDeg) && look.elevDeg > 40 && look.elevDeg < 46 && look.azDeg > 160 && look.azDeg < 175,
  `仰角 ${look.elevDeg.toFixed(2)}°、方位 ${look.azDeg.toFixed(2)}°`);

// 基站：在地球站方位 45° 方向 12 km，天线中心离地 30 m；剖面自基站（干扰源 t）到地球站（被干扰 r）
const dKm = 12, brgEsToBs = 45;
const dl = dKm / 6371, b = brgEsToBs * D2R, la = ES.lat * D2R;
const bsLat = Math.asin(Math.sin(la) * Math.cos(dl) + Math.cos(la) * Math.sin(dl) * Math.cos(b)) * R2D;
const bsLon = ES.lon + Math.atan2(Math.sin(b) * Math.sin(dl) * Math.cos(la), Math.cos(dl) - Math.sin(la) * Math.sin(bsLat * D2R)) * R2D;
const d = [], h = [];
for (let i = 0; i <= 120; i++) { d.push(i * dKm / 120); h.push(48 + 12 * Math.sin(i / 9) + 6 * Math.sin(i / 3.7)); }
const path = { fGHz: 3.6, d, h, zone: d.map(() => 'A2'), htg: 30, hrg: ES.hag, txLat: bsLat, txLon: bsLon, rxLat: ES.lat, rxLon: ES.lon };
const r20 = T.basicTransmissionLoss(Object.assign({ p: 20 }, path));
const r001 = T.basicTransmissionLoss(Object.assign({ p: 0.01 }, path));
ok('P.452-18：两种时间百分比都出数', !r20.error && !r001.error && finite(r20.Lb, r001.Lb), `Lb(20%) ${r20.Lb.toFixed(2)} dB，Lb(0.01%) ${r001.Lb.toFixed(2)} dB`);
ok('P.452-18：Lb(0.01%) < Lb(20%)', r001.Lb < r20.Lb);
ok('P.452-18：Lb 不低于自由空间 + 气体（12 km、3.6 GHz 约 125 dB）的数个 dB 以内', r001.Lb > r20.Lbfsg - 10, `Lbfsg ${r20.Lbfsg.toFixed(2)} dB`);

// §4.6：两端离轴角。基站面板方位 200°、机械下倾 6°；地球站主轴（仰角、方位）即对星方向
const pa = r20.path;
const geo = T.p452.offBoresightAngles({ txLat: bsLat, txLon: bsLon, rxLat: ES.lat, rxLon: ES.lon,
  htKm: pa.hts / 1000, hrKm: pa.hrs / 1000, ae: pa.ae, pathType: pa.pathType, thetaT: pa.thetaT, thetaR: pa.thetaR,
  txBoresight: { elevDeg: -6, azDeg: 200 }, rxBoresight: { elevDeg: look.elevDeg, azDeg: look.azDeg } });
ok('§4.6：基站→地球站方位 ≈ 225°（反方位）', Math.abs(geo.bearingTrDeg - 225) < 0.2, `${geo.bearingTrDeg.toFixed(3)}°`);
ok('§4.6：两端离轴角有限', finite(geo.chiTDeg, geo.chiRDeg), `χt ${geo.chiTDeg.toFixed(2)}°、χr ${geo.chiRDeg.toFixed(2)}°`);

// 基站方向图：M.2101 AAS（8×8，WP5D 风格参数），波束指向近处用户；另算 F.1336 扇区（IMT 改进型）对照
const aas = T.m2101.makeAas({ GEmax: 6.4, phi3dB: 65, theta3dB: 65, Am: 30, SLAv: 30, NH: 8, NV: 8, dH: 0.5, dV: 0.5, mechTiltDeg: 6 });
const beam = aas.beamTo(97, -15);
const thG = 90 - geo.epsPtDeg, phG = wrap(geo.bearingTrDeg - 200);
const gAas = aas.gain(thG, phG, beam);
ok('M.2101：朝地球站方向的合成增益有限且不超过峰值', finite(gAas) && gAas <= aas.peakGainDb + 1e-9, `${gAas.toFixed(2)} dBi（峰值 ${aas.peakGainDb.toFixed(2)}）`);
const gSec = T.f1336.sectoral({ band: 'low', G0: 17, phi3: 65, type: 'imt', mode: 'peak', mechTiltDeg: 6, phiDeg: phG, thetaDeg: geo.epsPtDeg });
ok('F.1336：扇区天线朝地球站增益有限且 ≤ G0', finite(gSec) && gSec <= 17 + 1e-9, `${gSec.toFixed(2)} dBi`);

// 地球站方向图：AP7 附件 3 式 (97)（D/λ 由 Gamax 估算）
const esPat = T.ap7.annex3PatternParams(ES.GmaxDbi);
const gEs = T.ap7.esReferencePattern(geo.chiRDeg, esPat);
ok('AP7 附件 3：地球站朝基站增益在 [−10, Gamax]', finite(gEs) && gEs >= -10 - 1e-9 && gEs <= ES.GmaxDbi, `${gEs.toFixed(2)} dBi`);

// I/N（参考带宽 1 MHz）：基站 3 dBW/MHz，地球站系统噪温 100 K
const N = 10 * Math.log10(1.380649e-23 * 100 * 1e6);
const inr = (Lb) => 3 + gAas - Lb + gEs - N;
ok('I/N：短期（0.01%）高于长期（20%）', inr(r001.Lb) > inr(r20.Lb), `I/N(20%) ${inr(r20.Lb).toFixed(1)} dB，I/N(0.01%) ${inr(r001.Lb).toFixed(1)} dB`);

console.log('\n=== ③ 同一站址的 AP7 协调距离 ===');
const cols = T.ap7.findColumns({ fGHz: 3.6, table: '8', modulation: 'N', service: 'Fixed-satellite' });
ok('表 8b：3.6 GHz FSS 接收（数字）列唯一', cols.length === 1, cols.map((c) => c.table + ' ' + c.column.bandsText).join('；'));
const rq = T.ap7.requiredLoss({ entry: cols[0], esTeK: 100 });
ok('附件 7 §2：Pr(p) 由式 (127) 算出，p 取表列', !rq.error && rq.PrSource === 'eq127' && finite(rq.Pr) && rq.p === 0.0017,
  `Pt ${rq.Pt} dBW、Gx ${rq.Gx} dBi、Pr ${rq.Pr && rq.Pr.toFixed(2)} dBW、p ${rq.p}%`);
const az = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => ({ azDeg: a, horizonElevDeg: 0.5, horizonDistKm: 1, zones: 'A2' }));
const ct = T.ap7.coordinationContour({ fGHz: 3.6, p: rq.p, latDeg: ES.lat, lonDeg: ES.lon, esRole: 'rx', Pt: rq.Pt, Pr: rq.Pr, Gx: rq.Gx,
  azimuths: az, esAntenna: { GmaxDbi: ES.GmaxDbi }, gso: { deltaLonDeg: ES.satLon - ES.lon }, mode2: { rainZone: 'K' } });
ok('协调等值线：8 个方位都出数', !ct.error && ct.contourKm.length === 8 && ct.contourKm.every((x) => finite(x)), ct.error || ct.contourKm.map((x) => x.toFixed(0)).join(' / ') + ' km');
ok('协调等值线：每个方位 ≥ dmin，且 = max(模式 (1), 模式 (2))', !ct.error && ct.contourKm.every((x, i) => x >= ct.dminKm - 1e-9 && Math.abs(x - Math.max(ct.mode1Km[i], ct.mode2Km[i])) < 1e-9),
  `dmin ${ct.dminKm && ct.dminKm.toFixed(1)} km`);
const m45 = T.ap7.mode1RequiredDistance({ fGHz: 3.6, p: rq.p, Lb: ct.lbDb[1], latDeg: ES.lat, zones: 'A2',
  horizon: { elevDeg: 0.5, distKm: 1 }, esRole: 'rx' });
ok('方位 45° 的模式 (1) 距离与单独调用一致', !m45.error && Math.abs(m45.distanceKm - ct.mode1Km[1]) < 1e-9, `${m45.distanceKm.toFixed(1)} km`);
// 仰角 43°、地平线 0.5° 时各方位主轴与地平线的夹角都 ≥ 36°，式 (97) 落在 −10 dBi 底板
ok('对星仰角 43°：各方位地平线增益均为 −10 dBi 底板', !ct.error && ct.horizonGainDbi.every((g) => Math.abs(g + 10) < 1e-9),
  ct.horizonGainDbi && ct.horizonGainDbi.map((g) => g.toFixed(1)).join(' / ') + ' dBi');
// 低仰角卫星（经差 60°）：离对星方位最近的方位地平线增益最大
const lowLook = T.ap7.gsoLookAngles(ES.lat, 0, 60);
const azLow = Array.from({ length: 36 }, (_, i) => ({ azDeg: i * 10, horizonElevDeg: 0.5, horizonDistKm: 1, zones: 'A2' }));
const ctLow = T.ap7.coordinationContour({ fGHz: 3.6, p: rq.p, latDeg: ES.lat, esRole: 'rx', Pt: rq.Pt, Pr: rq.Pr, Gx: rq.Gx,
  azimuths: azLow, esAntenna: { GmaxDbi: ES.GmaxDbi }, gso: { deltaLonDeg: 60 }, mode2: false });
const iMax = ctLow.error ? -1 : ctLow.horizonGainDbi.indexOf(Math.max(...ctLow.horizonGainDbi));
const iNear = Math.round(lowLook.azDeg / 10) % 36;
ok('对星仰角低时：对星方位的地平线增益最大，且模式 (1) 距离也最大', !ctLow.error && iMax === iNear &&
  ctLow.mode1Km.indexOf(Math.max(...ctLow.mode1Km)) === iNear,
  `仰角 ${lowLook.elevDeg.toFixed(1)}°、方位 ${lowLook.azDeg.toFixed(1)}°；最大增益 ${ctLow.horizonGainDbi && ctLow.horizonGainDbi[iMax].toFixed(1)} dBi @ ${iMax * 10}°`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
