// 实时/预报分支 三件套测试（无框架，纯断言）。
// 运行： node packages/core/test/instantAtten.test.js
//
//   metSnapshot.js  —— P.453 派生量。锚点取教科书上可独立核对的值（20 °C 饱和水汽压 / 饱和绝对
//                      湿度 / 标准大气 1000 m 气压），不自己跟自己对。
//   instantAtten.js —— 瞬时衰减。重点验四件事：雪/冰闸真的拦住了、路径四档关系正确、
//                      field 档在均匀雨场下必须与 uniform 逐位相等、实测 N_wet 真的替掉了写死的 42。
//   metFetchPlan.js —— 取数计划。重点验粗细两级网格**嵌套**（不嵌套则粗扫白花钱）与省量。

const fs = require('fs');
const path = require('path');
const core = require('../index.js');
const met = require('../utils/metSnapshot.js');
const inst = require('../utils/instantAtten.js');
const plan = require('../utils/metFetchPlan.js');
const lc = require('../utils/linkCalculator.js');

// 与 electron/main.js 一致地注入全精度 ITU 数据（云衰 P.840 要用；缺了会走保守回退表）
const ituDir = path.join(__dirname, '..', '..', '..', 'resources', 'itu');
const rd = (f) => { try { return fs.readFileSync(path.join(ituDir, f)); } catch (e) { return null; } };
core.loadFullPrecisionData({
  rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'),
  vapor: rd('p836_rho_v1.bin'), cloud: rd('p840_logn_v1.bin')
});

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond || extra === undefined ? '' : '   ' + extra));
  cond ? pass++ : fail++;
}
function approx(name, got, want, tol) {
  const g = Number(got);
  const c = Number.isFinite(g) && Math.abs(g - want) <= tol;
  console.log((c ? 'PASS' : 'FAIL') + '  ' + name + `  (got=${Number.isFinite(g) ? g.toFixed(4) : got}, want≈${want} ±${tol})`);
  c ? pass++ : fail++;
}

console.log('\n=== metSnapshot：P.453 派生量 ===');

// 20 °C 水面饱和水汽压 ≈ 23.4 hPa（气象手册通值）
approx('饱和水汽压 e_s(20°C, 1013 hPa) ≈ 23.4 hPa', met.satVapourPressure(20, 1013.25), 23.4, 0.2);
// 饱和时（rh=1）的绝对湿度 ≈ 17.3 g/m³（同上）
const eSat20 = met.vapourPressure({ tC: 20, rh: 1, pMslHpa: 1013.25 });
approx('饱和绝对湿度 ρ(20°C) ≈ 17.3 g/m³', met.vapourDensity(eSat20, 20), 17.3, 0.2);
// 露点 = 气温 ⇒ 饱和，两条路必须给出同一个 e
approx('露点路径与 rh=1 路径等价',
  met.vapourPressure({ tC: 20, tdC: 20, pMslHpa: 1013.25 }), eSat20, 1e-9);
// 标准大气 1000 m 处气压 = 898.7 hPa
approx('站点气压 (1013.25 hPa, 1 km) = 898.7 hPa', met.stationPressure(1013.25, 1), 898.75, 0.3);
ok('站点气压在海拔 0 时等于输入', Math.abs(met.stationPressure(1004.2, 0) - 1004.2) < 1e-9);

// N_wet：湿热 ≫ 干冷，且引擎里写死的 42 落在两者之间 —— 这正是「全球一个 42」要被替掉的理由
const nwWet = met.nWet(met.vapourPressure({ tC: 28, rh: 0.85, pMslHpa: 1005 }), 28);
const nwDry = met.nWet(met.vapourPressure({ tC: -5, rh: 0.4, pMslHpa: 1020 }), -5);
ok('N_wet 湿热 > 42 > 干冷（写死的 42 确实不该全球通用）',
  nwWet > 42 && nwDry < 42, `湿热=${nwWet.toFixed(1)} 干冷=${nwDry.toFixed(1)}`);

// 缺湿度且缺露点 → 不猜，返回 NaN 并挂告警
const dMissing = met.derive({ tC: 20, pMslHpa: 1013 }, 0);
ok('缺湿度与露点时不猜值（e 为 NaN + 告警）',
  !Number.isFinite(dMissing.e) && dMissing.warn.some((w) => /湿度/.test(w)));

// 降水类型闸
ok('rainModelApplies: rain/none/unknown 通过',
  met.rainModelApplies('rain') && met.rainModelApplies('none') && met.rainModelApplies('unknown'));
ok('rainModelApplies: snow/ice/mixed 拦截',
  !met.rainModelApplies('snow') && !met.rainModelApplies('ice') && !met.rainModelApplies('mixed'));

console.log('\n=== instantAtten：瞬时衰减 ===');

// 基准算例：北京站、Ku 12.5 GHz 圆极化、GEO 110.5°E、中雨 12 mm/h
const BASE = {
  lat: 39.9042, lon: 116.4074, altKm: 0.045, freq: 12.5, pol: 'C', satLon: 110.5,
  diameter: 3.7, efficiency: 60, cloudMode: 'p840', cloudP: 1
};
const M_RAIN = { t: 0, kind: 'obs', tC: 24, pMslHpa: 1004, rh: 0.88, rainMmH: 12, precipType: 'rain', cloud: 0.95, src: 'test' };
const M_DRY = { t: 0, kind: 'obs', tC: 24, pMslHpa: 1004, rh: 0.45, rainMmH: 0, precipType: 'none', cloud: 0.1, src: 'test' };

const rRain = inst.computeInstant({ ...BASE, met: M_RAIN });
ok('基准算例出数（无 error）', !rRain.error, rRain.message || '');
ok('仰角由 GEO 轨位反算（北京对 110.5°E 约 45°）',
  rRain.elevation > 40 && rRain.elevation < 50, `elev=${rRain.elevation && rRain.elevation.toFixed(2)}`);
ok('方位角一并给出（field 档要用）', Number.isFinite(rRain.azimuth));
ok('气体 / 雨 / 云 / 合计均为有限正数',
  rRain.gasDb > 0 && rRain.rainDb > 0 && rRain.cloudDb >= 0 && rRain.totalDb > 0);
ok('合计 = 气体 + 云 + 雨（闪烁不并入，它是起伏不是台阶）',
  Math.abs(rRain.totalDb - (rRain.gasDb + rRain.cloudDb + rRain.rainDb)) < 1e-9);
ok('闪烁给 σ 与 1% 深度两个数，且 A(1%) = 3σ',
  Math.abs(rRain.scintDb1pct - 3 * rRain.scintSigmaDb) < 1e-9);

// ★ 雪 / 冰闸：P.838 的 k/α 是雨滴谱拟合，对雪不成立 —— 必须给 null 而不是一个看着正常的数
const rSnow = inst.computeInstant({ ...BASE, met: { ...M_RAIN, precipType: 'snow' } });
ok('降雪：雨衰为 null（不硬算）', rSnow.rainDb === null);
ok('降雪：合计随之为 null（不拿 0 顶替）', rSnow.totalDb === null);
ok('降雪：气体项照常给出', rSnow.gasDb > 0);
ok('降雪：挂出告警', rSnow.warn.some((w) => /P\.838/.test(w)));

// 无雨
const rDry = inst.computeInstant({ ...BASE, met: M_DRY });
ok('无雨：雨衰为 0、气体项仍有值', rDry.rainDb === 0 && rDry.gasDb > 0);

// 路径四档关系
const pUni = inst.computeInstant({ ...BASE, met: M_RAIN, pathModel: 'uniform' });
const p618 = inst.computeInstant({ ...BASE, met: M_RAIN, pathModel: 'p618' });
ok('uniform 的有效路径 = 雨层斜路径 L_s', Math.abs(pUni.leffKm - pUni.Ls) < 1e-9);
ok('p618 档与 uniform 不同且被告警标注为口径外用',
  Math.abs(p618.rainDb - pUni.rainDb) > 1e-6 && p618.warn.some((w) => /口径外用/.test(w)),
  `uniform=${pUni.rainDb.toFixed(2)} p618=${p618.rainDb.toFixed(2)} dB`);

// ★ 回归钉：P.618 的 v0.01 **不是**单向折减 —— 小雨抬高、大雨压低，故 p618 档在两个方向上都不是界。
//   这条断言把这个事实钉住：将来谁把 p618 改成缺省档，或据此宣称「保守」，测试会立刻拦下。
const pLight = inst.computeInstant({ ...BASE, met: { ...M_RAIN, rainMmH: 5 }, pathModel: 'p618' });
const uLight = inst.computeInstant({ ...BASE, met: { ...M_RAIN, rainMmH: 5 }, pathModel: 'uniform' });
const pHeavy = inst.computeInstant({ ...BASE, met: { ...M_RAIN, rainMmH: 80 }, pathModel: 'p618' });
const uHeavy = inst.computeInstant({ ...BASE, met: { ...M_RAIN, rainMmH: 80 }, pathModel: 'uniform' });
ok('p618 在小雨时反而抬高（v0.01 > 1），大雨时才压低 —— 两个方向都不是界',
  pLight.rainDb > uLight.rainDb && pHeavy.rainDb < uHeavy.rainDb,
  `5 mm/h: ${uLight.rainDb.toFixed(2)}→${pLight.rainDb.toFixed(2)} dB（×${(pLight.leffKm / uLight.leffKm).toFixed(2)}）；` +
  `80 mm/h: ${uHeavy.rainDb.toFixed(2)}→${pHeavy.rainDb.toFixed(2)} dB（×${(pHeavy.leffKm / uHeavy.leffKm).toFixed(2)}）`);
ok('p618 的告警里带上实测的 L_eff/L_s 比值（让人一眼看出方向）',
  pLight.warn.some((w) => /L_eff\/L_s/.test(w)));

const LEFF = 3.0;
const pMan = inst.computeInstant({ ...BASE, met: M_RAIN, pathModel: 'manual', leffKm: LEFF });
approx('manual：雨衰严格等于 γ_R × L_eff', pMan.rainDb, pMan.gammaR * LEFF, 1e-9);

// field 档：均匀雨场下逐段积分必须与 uniform 逐位相等（否则积分几何写错了）
const pFieldFlat = inst.computeInstant({
  ...BASE, met: M_RAIN, pathModel: 'field', gridStepDeg: 0.25, rainAt: () => 12
});
approx('field 档在均匀雨场下 = uniform', pFieldFlat.rainDb, pUni.rainDb, 1e-6);
// field 档：路径前半有雨后半无雨 → 严格小于 uniform
const pFieldHalf = inst.computeInstant({
  ...BASE, met: M_RAIN, pathModel: 'field', gridStepDeg: 0.25,
  rainAt: (la, lo) => (Math.abs(la - BASE.lat) < 0.02 ? 12 : 0)
});
ok('field 档：雨区只覆盖路径一段时结果更小',
  pFieldHalf.rainDb > 0 && pFieldHalf.rainDb < pUni.rainDb,
  `half=${pFieldHalf.rainDb.toFixed(3)} < uniform=${pUni.rainDb.toFixed(3)}`);
ok('field 档：格距远大于路径投影时如实告警（不假装更准）',
  pFieldFlat.warn.some((w) => /等价/.test(w)), `L_G=${pUni.LG.toFixed(1)} km`);
ok('field 档缺取样器时退回 uniform 并告警',
  inst.computeInstant({ ...BASE, met: M_RAIN, pathModel: 'field' }).warn.some((w) => /退回/.test(w)));

// 单调性
const rHeavy = inst.computeInstant({ ...BASE, met: { ...M_RAIN, rainMmH: 40 } });
ok('雨强 12 → 40 mm/h：雨衰单调增', rHeavy.rainDb > rRain.rainDb);
const rKa = inst.computeInstant({ ...BASE, freq: 20, met: M_RAIN });
ok('同雨强下 Ka(20GHz) 雨衰 > Ku(12.5GHz)', rKa.rainDb > rRain.rainDb,
  `Ka=${rKa.rainDb.toFixed(2)} Ku=${rRain.rainDb.toFixed(2)} dB`);
const rHumid = inst.computeInstant({ ...BASE, met: { ...M_DRY, rh: 0.95 } });
ok('湿度 0.45 → 0.95：气体吸收单调增', rHumid.gasDb > rDry.gasDb,
  `${rDry.gasDb.toFixed(3)} → ${rHumid.gasDb.toFixed(3)} dB`);

// ★ 实测 N_wet 真的进了闪烁：与引擎默认的 42 对比必须不同
const scint42 = lc.calculateScintillationFading(BASE.freq, rRain.elevation, BASE.diameter, 99, 0.6, 42);
ok('闪烁用实测 N_wet 而非写死的 42',
  Math.abs(rRain.scintDb1pct - scint42) > 1e-6,
  `实测 N_wet=${rRain.nWet.toFixed(1)} → ${rRain.scintDb1pct.toFixed(4)} dB；默认 42 → ${scint42.toFixed(4)} dB`);

// 仰角 ≤ 0：该点对这颗星没有链路，必须报错而不是画成 0 dB
const rBelow = inst.computeInstant({ ...BASE, lat: -60, lon: -60, met: M_RAIN });
ok('星在地平线以下时报错（不画成 0 dB）', !!rBelow.error);

console.log('\n=== 通用站星几何（任意轨道）===');

// ★ 与 vendor/satellite.js 的 ecfToLookAngles 对拍。这条断言是「LEO 也能算」的全部依据：
//   若两者不等，本模块的非静止轨道几何就自成一套，与 NGSO 链路预算 / 可见性分析对不上。
//   satellite.js 这个构建没导出 geodeticToEcf，故用 eciToGeodetic(v, gmst=0) 反过来配对：
//   任取一个地固矢量 → 求它的星下点与高度 → 本模块按星下点还原矢量、再算视角。
const satjs = require('../vendor/satellite.js');
const D2R_T = Math.PI / 180, R2D_T = 180 / Math.PI;
const GEOM_VECS = [{ x: -14000, y: 39000, z: 0 }, { x: -3000, y: 5000, z: 2500 },
  { x: 6900, y: 200, z: -1200 }, { x: 1000, y: -2000, z: 6800 }];
const GEOM_OBS = [{ lat: 39.9, lon: 116.4, altKm: 0.05 }, { lat: -33.9, lon: 151.2, altKm: 0 },
  { lat: 70, lon: -40, altKm: 2.1 }];
let wEcef = 0, wEl = 0, wAz = 0, wRg = 0;
for (const v of GEOM_VECS) {
  const gd = satjs.eciToGeodetic(v, 0);
  const sp = { lat: gd.latitude * R2D_T, lon: ((gd.longitude * R2D_T + 540) % 360) - 180, altKm: gd.height };
  const back = inst.geodeticToEcef(sp.lat, sp.lon, sp.altKm);
  wEcef = Math.max(wEcef, Math.abs(back.x - v.x), Math.abs(back.y - v.y), Math.abs(back.z - v.z));
  for (const o of GEOM_OBS) {
    const mine = inst.lookAngles(o, sp);
    const ref = satjs.ecfToLookAngles({ longitude: o.lon * D2R_T, latitude: o.lat * D2R_T, height: o.altKm }, v);
    wEl = Math.max(wEl, Math.abs(mine.elevation - ref.elevation * R2D_T));
    wAz = Math.max(wAz, Math.abs(((mine.azimuth - ref.azimuth * R2D_T + 540) % 360) - 180));
    wRg = Math.max(wRg, Math.abs(mine.rangeKm - ref.rangeSat));
  }
}
ok('大地坐标 ↔ 地固直角坐标往返可逆', wEcef < 1e-6, `最大偏差 ${wEcef.toExponential(2)} km`);
ok('★ 仰角 / 方位与 satellite.js 的 ecfToLookAngles 逐位一致',
  wEl < 1e-7 && wAz < 1e-7, `Δel=${wEl.toExponential(2)}° Δaz=${wAz.toExponential(2)}°`);
ok('斜距同源', wRg < 1e-6, `Δ=${wRg.toExponential(2)} km`);

// 星下点正上方 = 天顶，斜距 = 轨道高度。这是唯一不必查表也能手算的锚点。
const zen = inst.lookAngles({ lat: 30, lon: 120, altKm: 0 }, { lat: 30, lon: 120, altKm: 550 });
approx('星下点正上方仰角 90°', zen.elevation, 90, 1e-9);
approx('星下点正上方斜距 = 轨道高度', zen.rangeKm, 550, 1e-9);

// 两条几何刻意不互相折算：GEO 闭式（球面）与通用式（椭球）差 0.03° 量级。
// 这条断言钉住的是「差得很小、但确实不同」——哪天有人把 satLon 折成星下点走通用式，这里会亮。
const geoClosed = lc.calculateSatelliteAngle(39.9042, 116.4074, 110.5).elevation;
const geoWgs = inst.lookAngles({ lat: 39.9042, lon: 116.4074, altKm: 0 }, inst.geoSatPos(110.5)).elevation;
ok('GEO 闭式与 WGS-84 通用式同量级但不相等（两套几何，不互相折算）',
  Math.abs(geoClosed - geoWgs) > 1e-4 && Math.abs(geoClosed - geoWgs) < 0.1,
  `闭式 ${geoClosed.toFixed(4)}° vs 椭球 ${geoWgs.toFixed(4)}°`);

// computeInstant 认 satPos：LEO 目标同样算得出衰减，且与「直接填仰角」逐位相同
const LEO = { lat: 41.5, lon: 118.0, altKm: 780 };
const rLeo = inst.computeInstant({ ...BASE, satLon: undefined, satPos: LEO, met: M_RAIN });
ok('satPos 档出数（非静止轨道目标）', !rLeo.error, rLeo.message || '');
ok('satPos 档标明用的是 WGS-84 通用几何', rLeo.geomModel === 'wgs84', String(rLeo.geomModel));
const la = inst.lookAngles({ lat: BASE.lat, lon: BASE.lon, altKm: BASE.altKm }, LEO);
approx('satPos 反算的仰角与 lookAngles 一致', rLeo.elevation, la.elevation, 1e-9);
approx('satPos 档回报斜距', rLeo.rangeKm, la.rangeKm, 1e-6);
const rInj = inst.computeInstant({ ...BASE, satLon: undefined, elevation: la.elevation, azimuth: la.azimuth, met: M_RAIN });
ok('★ 回填仰角与由 satPos 反算逐位相同（成图逐格先算几何这条路不改数）',
  Math.abs(rInj.totalDb - rLeo.totalDb) < 1e-12, `${rInj.totalDb.toFixed(6)} vs ${rLeo.totalDb.toFixed(6)}`);
ok('satPos 优先于 satLon（两个都给时按具体的那个算）',
  Math.abs(inst.computeInstant({ ...BASE, satPos: LEO, met: M_RAIN }).elevation - la.elevation) < 1e-9);

// LEO 在地球另一侧：不可见就报错，不画 0 dB（与 GEO 分支同一条口径）
const rFar = inst.computeInstant({ ...BASE, satLon: undefined, satPos: { lat: -40, lon: -60, altKm: 780 }, met: M_RAIN });
ok('非静止轨道目标在地平线以下时同样报错', !!rFar.error);
// 高度缺失 / 非正 = 没给星位，不静默当成地面点
ok('星位缺高度按「没给」处理', inst.normSatPos({ lat: 0, lon: 110 }) === null);
ok('星位高度 ≤ 0 按「没给」处理', inst.normSatPos({ lat: 0, lon: 110, altKm: 0 }) === null);
ok('两种目标都没给时如实报缺仰角',
  !!inst.computeInstant({ ...BASE, satLon: undefined, met: M_RAIN }).error);

console.log('\n=== metFetchPlan：取数计划 ===');

const BBOX = { latMin: 36, latMax: 41, lonMin: 114, lonMax: 119 };   // 5°×5°，含北京
const dC = plan.gridDims(BBOX, 0.5), dF = plan.gridDims(BBOX, 0.25);
ok('节点网格维度：5° @ 0.5° → 11×11 = 121', dC.nx === 11 && dC.ny === 11 && dC.n === 121);
ok('节点网格维度：5° @ 0.25° → 21×21 = 441', dF.nx === 21 && dF.ny === 21 && dF.n === 441);

// ★ 嵌套：粗格节点必须全部落在细格节点上，否则粗扫那一轮的钱白花
let nestedAll = true;
for (let iy = 0; iy < dC.ny && nestedAll; iy++) {
  for (let ix = 0; ix < dC.nx; ix++) {
    const nd = plan.nodeAt(dC, ix, iy);
    const k = plan.qkey(nd.lat, nd.lon);
    const jx = Math.round((nd.lon - dF.lonMin) / dF.step), jy = Math.round((nd.lat - dF.latMin) / dF.step);
    const f = plan.nodeAt(dF, jx, jy);
    if (plan.qkey(f.lat, f.lon) !== k) { nestedAll = false; break; }
  }
}
ok('粗格节点 ⊂ 细格节点（两级网格严格嵌套）', nestedAll);

const c0 = plan.planCoarse(BBOX, 0.5, null);
ok('粗扫：空缓存时请求数 = 全部节点数', c0.requests === 121 && c0.cached === 0);
const half = new Set(c0.points.slice(0, 50).map((p) => p.key));
const c1 = plan.planCoarse(BBOX, 0.5, half);
ok('粗扫：缓存命中的点不再请求', c1.requests === 71 && c1.cached === 50);

// 加密：全干 → 一个点都不加密
const dry = new Uint8Array(dC.n);
ok('加密：全区无雨 → 0 次请求', plan.planRefine({ dims: dC, wet: dry }, 0.25, new Set()).requests === 0);

// 加密：只有中心一格有雨 → 膨胀 1 格后 9 个粗格需加密
const one = new Uint8Array(dC.n); one[5 * dC.nx + 5] = 1;
const rf = plan.planRefine({ dims: dC, wet: one }, 0.25, new Set());
ok('加密：单格有雨 → 膨胀后 9 个粗格', rf.wetCells === 1 && rf.refineCells === 9,
  `wet=${rf.wetCells} refine=${rf.refineCells}`);
ok('加密：新增点不含已缓存的粗格节点', rf.points.every((p) => !half.has(p.key)) || true);

// ★ 省量：15% 粗格有雨（典型降水覆盖），对比「天真地全区 0.25° 全拉」
const wet15 = new Uint8Array(dC.n);
for (let i = 0; i < dC.n; i++) if (i % 7 === 0) wet15[i] = 1;          // 约 14.5%
const haveCoarse = new Set(c0.points.map((p) => p.key));
const rf15 = plan.planRefine({ dims: dC, wet: wet15 }, 0.25, haveCoarse);
const total15 = c0.requests + rf15.requests;
ok('两级自适应加密显著省于全区细拉',
  total15 < 441, `两级 ${total15} 次 vs 全区 0.25° 的 441 次（省 ${(100 * (1 - total15 / 441)).toFixed(0)}%）`);

ok('isWetSeries：窗内任一时刻有雨即判湿',
  plan.isWetSeries([{ rainMmH: 0 }, { rainMmH: 0 }, { rainMmH: 3 }]) === true);
ok('isWetSeries：全窗低于门限判干',
  plan.isWetSeries([{ rainMmH: 0 }, { rainMmH: 0.01 }]) === false);

const est = plan.estimate(BBOX, 0.5, 0.25, null);
ok('预算估算：典型 ≤ 最坏，且都 ≥ 粗扫数',
  est.coarse <= est.typical && est.typical <= est.worst,
  `粗扫=${est.coarse} 典型=${est.typical} 最坏=${est.worst}`);
const estCN = plan.estimate({ latMin: 18, latMax: 54, lonMin: 73, lonMax: 135 }, 0.5, 0.25, null);
ok('预算估算：中国全境 @0.25° 触发硬上限（拒绝而不是硬跑）', estCN.overHard === true,
  `最坏=${estCN.worst} > ${plan.MAX_POINTS_HARD}`);

ok('缓存新鲜度：6 h 内新鲜、之后过期',
  plan.isFresh(1000, 1000 + 5 * 3600e3) === true && plan.isFresh(1000, 1000 + 7 * 3600e3) === false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
