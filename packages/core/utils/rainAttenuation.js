// 雨衰计算纯核 —— 通用，面向所有种类卫星（GEO / LEO / MEO / HEO 一视同仁）。
//
// 设计要点：雨衰的物理本质只取决于「仰角」（斜路径穿过雨区的长度）+ 频率 / 极化 / 降雨率 /
// 站址纬度 / 海拔，与轨道类型无关。因此本核以「仰角」为直接输入，对任意卫星通用；若额外给出
// GEO 定点经度 satLon，则作为便捷项反算仰角，并附带方位角 / 斜距等纯信息量。不引入轨道传播。
//
// 物理实现全部复用 linkCalculator.js 中已验证的 ITU-R 模型（P.618-14 雨衰 / P.838 系数 /
// P.840-9 云衰 / P.676 气体 / 闪烁 / 雨致 XPD），不重写，保证与链路预算口径一致。
// 纯 JS、无 Vue/DOM，在 Electron 主进程（Node）以 CommonJS 加载。

const geo = require('./linkCalculator.js');
const { CONSTANTS } = require('./constants.js');
const { getRhoWs } = require('../data/waterVaporGrid.js');   // ITU-R P.836-6 地面水汽密度
const rainRate = require('./rainRate.js');                    // ITU-R P.837 降雨率查表（0.01%）
const s8 = require('./ngsoElevStats.js');                     // ITU-R P.618-14 §8 非静止轨道长期统计

const D2R = Math.PI / 180;
const HOURS_PER_YEAR = 8766;   // 365.25 d × 24 h（与 SatMaster「Link downtime」口径一致）
const TMR = 275;               // 介质辐射温度 Tmr (K)，ITU-R P.618 降雨天空噪声

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? NaN : d); }

// —— A(0.01%) 记忆表 ——
// §8 求和要对几十个仰角增量反复取值，而 A(0.01%) 只跟（站址/频率/极化/海拔/R0.01/仰角）有关、
// 与时间百分比 p 无关。缓存它，可用度/频率轴扫描时只有首点付全价。
const _a001Memo = new Map();
function a001At(st, elevDeg) {
  const key = st.memoKey + '|' + Math.round(elevDeg * 1000);
  let v = _a001Memo.get(key);
  if (v === undefined) {
    v = geo.calculateSinglePathRainAttenuation(st.R001, st.freq, st.pol, st.lat, st.lon, null, st.altKm, elevDeg).A001;
    if (_a001Memo.size > 50000) _a001Memo.clear();
    _a001Memo.set(key, v);
  }
  return v;
}

// —— §8 两级缓存 ——
// 曲线扫描（可用度/频率/降雨率轴，120 点）逐点几何完全相同：
//   _distMemo  仰角分布（4096×~80 次 acos，~4ms/次）按「站纬+轨道三要素+箱宽」缓存；
//   _s8CtxMemo 求解插值表（每箱 64 点 ln A–ln p）按「气象 memoKey + 几何」缓存——表与目标 p 无关，
//              可用度轴扫描时 120 个点共用同一张表。
const _distMemo = new Map();
const _s8CtxMemo = new Map();

/**
 * NGSO 统计口径：由圆轨道几何按 ITU-R P.618-14 §8 求「等效仰角」。
 * @returns {object} { elevEq, info } 或 { error, message }
 */
function ngsoEquivalentElevation(st, opt) {
  const dKey = [st.lat, opt.orbitAltKm, opt.inclDeg, opt.minElevDeg, opt.binDeg || 1].join(',');
  let dist = _distMemo.get(dKey);
  if (!dist) {
    dist = s8.circularElevDistribution({
      latDeg: st.lat, altKm: opt.orbitAltKm, inclDeg: opt.inclDeg,
      minElevDeg: opt.minElevDeg, binDeg: opt.binDeg
    });
    if (_distMemo.size > 200) _distMemo.clear();
    _distMemo.set(dKey, dist);
  }
  if (dist.error) return { error: true, message: dist.message };
  if (!(dist.visFrac > 0) || !dist.bins.length) {
    return { error: true, message: `轨道（高度 ${opt.orbitAltKm} km / 倾角 ${opt.inclDeg}°）对本站在最低仰角 ${opt.minElevDeg}° 上始终不可见` };
  }

  const base = {
    visFrac: dist.visFrac, minElevDeg: dist.minElevDeg, maxElevDeg: dist.maxElevDeg,
    binDeg: dist.binDeg, binCount: dist.bins.length,
    orbitAltKm: opt.orbitAltKm, inclDeg: opt.inclDeg
  };

  // 退化情形：无降雨（R0.01%=0）或可用度 100%（p=0）时，§8 加权无对象可加权 —— 退回最低仰角并
  // 标记，避免静默给出一个凭空的仰角（雨衰本来就是 0，其余项按最低仰角取保守值）。
  if (!(st.R001 > 0) || !(opt.p > 0)) {
    const why = !(st.R001 > 0) ? 'norain' : 'clearsky';
    return { elevEq: dist.minElevDeg, info: Object.assign({ degenerate: why, elevEq: dist.minElevDeg, atten: 0, attenAtMinElev: 0, clamped: false }, base) };
  }

  const cKey = st.memoKey + '||' + dKey;
  let ctx = _s8CtxMemo.get(cKey);
  if (!ctx) { ctx = {}; if (_s8CtxMemo.size > 300) _s8CtxMemo.clear(); _s8CtxMemo.set(cKey, ctx); }

  const sol = s8.solveP618S8({
    bins: dist.bins, p: opt.p, minElevDeg: dist.minElevDeg, cache: ctx,
    attenAt: (elevDeg, pPct) => geo.scaleRainAttenP618_14(a001At(st, elevDeg), pPct, st.lat, elevDeg)
  });
  if (sol.error) return { error: true, message: sol.message };

  return {
    elevEq: sol.elevEq,
    info: Object.assign({
      elevEq: sol.elevEq, atten: sol.atten, attenAtMinElev: sol.attenAtMinElev,
      overestimateAtMinElev: sol.attenAtMinElev - sol.atten,
      clamped: sol.clamped, argminDeg: sol.argminDeg, degenerate: sol.degenerate || null
    }, base)
  };
}

// GEO 定点经度 → 站心仰角（signed，与 calculateSinglePathRainAttenuation 内部同式）
function geoElevation(lat, lon, satLon) {
  const latR = lat * D2R;
  const dLon = (satLon - lon) * D2R;
  const cosT = Math.cos(latR) * Math.cos(dLon);
  const denom = Math.sqrt(Math.max(1e-10, 1 - cosT * cosT));
  return Math.atan((cosT - 0.15127) / denom) / D2R;
}

// GEO 站星斜距（余弦定理，km）——纯信息量，供详情「Path distance to satellite」显示
function geoSlantRange(lat, lon, satLon) {
  const latR = lat * D2R;
  const dLon = (lon - satLon) * D2R;
  const cosT = Math.cos(latR) * Math.cos(dLon);
  const Re = CONSTANTS.EARTH_RADIUS;
  const Ro = CONSTANTS.EARTH_RADIUS + CONSTANTS.SATELLITE_ALTITUDE;
  return Math.sqrt(Re * Re + Ro * Ro - 2 * Re * Ro * cosT);
}

/**
 * §8 等效仰角求解 —— 供链路预算引擎（linkCalculatorNGSO / 再生式）复用的独立入口。
 * 与本模块 NGSO 统计口径完全同源（同一套解析仰角分布 + §8 求和 + 记忆表），保证
 * 「雨衰计算器」与「链路预算」两处算出的等效仰角 bit 级一致。
 * 注：内部衰减函数取自 linkCalculator.js（GEO 引擎），与 linkCalculatorNGSO.js 的同名
 * 函数逐字一致（已 diff 核对），故等效仰角注回 NGSO 引擎后单仰角复算严格自洽。
 *
 * @param {object} q  { lat, lon, freq(GHz), pol('V'|'H'|'C'), altKm(站址海拔km),
 *                      R001(mm/h), orbitAltKm, inclDeg, minElevDeg, p(超越概率%), binDeg? }
 * @returns {object} { elevEq, info } 或 { error, message }
 */
function s8EquivalentElevation(q) {
  q = q || {};
  const altKm = Number.isFinite(q.altKm) ? q.altKm : 0;
  const R001 = Number.isFinite(q.R001) ? Math.max(0, q.R001) : 0;
  const st = {
    lat: q.lat, lon: q.lon, freq: q.freq, pol: String(q.pol || 'C').toUpperCase(), altKm, R001,
    memoKey: [q.lat, q.lon, q.freq, String(q.pol || 'C').toUpperCase(), altKm, R001].join(',')
  };
  if (!Number.isFinite(st.lat) || !Number.isFinite(st.freq) || st.freq <= 0) {
    return { error: true, message: '缺少站址纬度或有效频率' };
  }
  return ngsoEquivalentElevation(st, {
    orbitAltKm: q.orbitAltKm, inclDeg: q.inclDeg, minElevDeg: q.minElevDeg,
    p: q.p, binDeg: q.binDeg
  });
}

/**
 * 单算例雨衰及配套传播量。
 * @param {object} p 入参：
 *   lat, lon            地球站纬/经度（度）
 *   elevation           链路仰角（度，主几何输入；给了 satLon 可缺省由其反算）
 *   satLon              GEO 定点经度（度，选填，仅便捷换算仰角 + 出方位/斜距）
 *   freq                频率（GHz）
 *   pol                 极化 'V' | 'H' | 'C'
 *   diameter            天线口径（m）
 *   efficiency          天线效率（%）
 *   availability        年可用度（%）
 *   rainRate            R0.01% 降雨率（mm/h，0/空 → 按 P.837 查表；rainRateExact=true 则原样用）
 *   rainRateExact       曲线扫描时置真：rainRate 原样使用（含 0），不走自动查表
 *   systemNoiseTemp     晴空系统噪温（K，仅下行 G/T 衰减需要）
 *   direction           'up' | 'down'（G/T 衰减 / DND 为下行专属）
 * @returns {object} 扁平结果（number，UI/Excel 负责格式化）；仰角缺失时 { error, message }
 */
function calculateRainAttenuation(p) {
  p = p || {};
  const lat = num(p.lat), lon = num(p.lon);
  const freq = num(p.freq);
  const pol = String(p.pol || 'C').toUpperCase();
  const polDisplay = p.polDisplay ? String(p.polDisplay).toUpperCase() : pol;   // 原始极化标识（RHCP/LHCP 等），供显示
  const diameter = num(p.diameter, 1);
  const efficiency = num(p.efficiency, 60);       // %
  const availability = num(p.availability, 99);   // %
  const systemNoiseTemp = num(p.systemNoiseTemp, 0);
  const feederLoss = Math.max(0, num(p.feederLoss, 0));   // dB：天空噪声折算到接收机参考点用
  const direction = (p.direction === 'up') ? 'up' : 'down';
  const altM = num(p.altitude, 0);
  const altKm = (Number.isFinite(altM) ? altM : 0) / 1000;
  const satLon = (p.satLon === '' || p.satLon === null || p.satLon === undefined) ? null : num(p.satLon);
  const hasGeo = satLon !== null && Number.isFinite(satLon);

  // NGSO 统计口径（ITU-R P.618-14 §8）：仰角不再是一个输入数，而是由「轨道高度 + 倾角 + 最低仰角」
  // 的长期仰角分布加权反解出的等效仰角。
  const ngsoStat = !!p.ngsoStat;
  const orbitAltKm = num(p.orbitAltKm);
  const inclDeg = num(p.inclDeg);
  const minElevDeg = num(p.minElevDeg);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: true, message: '缺少经纬度' };
  if (!Number.isFinite(freq) || freq <= 0) return { error: true, message: '缺少有效频率' };

  // —— 降雨率 R0.01%（mm/h）：0/空 → 按 ITU-R P.837 查表；扫描降雨率轴时原样使用 ——
  // 前置于仰角求解：§8 加权要先知道降雨率才能算各仰角增量的衰减。
  let R001 = num(p.rainRate);
  let rainAuto = false;
  if (p.rainRateExact) {
    R001 = Math.max(0, Number.isFinite(R001) ? R001 : 0);
  } else if (!Number.isFinite(R001) || R001 <= 0) {
    try { R001 = rainRate.queryRainRate(lat, lon).rainRate; rainAuto = true; } catch (e) { R001 = 0; }
  }

  const pct = 100 - availability;   // 时间百分比 p(%)
  const unavail = pct / 100;

  // —— 仰角：优先直接输入；否则由 GEO satLon 反算。方位/斜距仅 GEO 便捷路径给出 ——
  let elevation = num(p.elevation);
  let azimuth = null, slantRange = null;
  if (hasGeo) {
    try { azimuth = geo.calculateSatelliteAngle(lat, lon, satLon).azimuth; } catch (e) { azimuth = null; }
    if (!Number.isFinite(elevation)) elevation = geoElevation(lat, lon, satLon);
    slantRange = geoSlantRange(lat, lon, satLon);
  }

  // —— NGSO：§8 等效仰角覆盖直接输入的仰角 ——
  let s8Info = null;
  if (ngsoStat) {
    const miss = !Number.isFinite(orbitAltKm) || orbitAltKm <= 0 ? '轨道高度'
      : !Number.isFinite(inclDeg) ? '轨道倾角'
      : !Number.isFinite(minElevDeg) ? '最低仰角' : null;
    if (miss) return { error: true, message: `缺少${miss}（NGSO 统计口径需要 轨道高度 / 轨道倾角 / 最低仰角）` };
    const st = { lat, lon, freq, pol, altKm, R001, memoKey: [lat, lon, freq, pol, altKm, R001].join(',') };
    const r8 = ngsoEquivalentElevation(st, {
      orbitAltKm, inclDeg, minElevDeg, p: pct, binDeg: num(p.s8BinDeg, 1)
    });
    if (r8.error) return { error: true, message: r8.message };
    elevation = r8.elevEq;
    s8Info = r8.info;
  }

  if (!Number.isFinite(elevation)) {
    return { error: true, message: '缺少仰角（直接填仰角，或填 GEO 轨位自动换算）' };
  }
  if (elevation <= 0) {
    return { error: true, message: '卫星在地平线以下（仰角 ' + elevation.toFixed(1) + '°）', elevation };
  }
  if (elevation > 90) {
    return { error: true, message: '仰角需在 0~90° 之间（当前 ' + elevation.toFixed(1) + '°）', elevation };
  }

  // —— 雨衰：A(0.01%) → 目标 p%（第 8 参注入仰角，几何与轨道类型解耦）——
  const rp = geo.calculateSinglePathRainAttenuation(R001, freq, pol, lat, lon, null, altKm, elevation);
  const A001 = rp.A001;
  const rainHeight = rp.hR;
  const rainAtten = geo.scaleRainAttenP618_14(A001, pct, lat, elevation);

  // —— 大气气体吸收 P.676：Ps/Ts（P.835）+ rhoWs（P.836）——
  const Ps = 1013.25 * Math.pow(Math.max(0.01, 1 - 6.5 * altKm / 288.15), 5.2561);
  const Ts = Math.max(200, (Math.abs(lat) < 22 ? 300.4 : Math.abs(lat) < 45 ? 283.1 : 272.4) - 6.5 * altKm);
  let rhoWs; try { rhoWs = getRhoWs(lat, lon, availability < 100); } catch (e) { rhoWs = undefined; }
  const gasAtten = geo.calculateAtmosphericAttenuation(freq, elevation, Ps, Ts, rhoWs);

  // —— 云衰 P.840-9、对流层闪烁 ——
  const cloudAtten = geo.calculateCloudAttenuation(freq, elevation, pct, lat, lon);
  const scintillation = geo.calculateScintillationFading(freq, elevation, diameter, availability, efficiency / 100);

  // —— 合计衰减：SatMaster 口径 = 气体 + 云 + 雨（简单和，闪烁不计入）；另存 ITU §2.5 严谨式对照 ——
  const totalAtten = gasAtten + cloudAtten + rainAtten;
  const totalAttenItu = gasAtten + Math.sqrt(Math.pow(rainAtten + cloudAtten, 2) + Math.pow(scintillation, 2));

  // —— 降雨噪声 / 下行 G/T 衰减（下行专属）——
  // 统一口径（只此一个噪声量，避免同一物理量出现两个不同基数的数）：
  //   ① 基数取「雨衰 + 云衰」——云与雨同为吸收介质，凡吸收必辐射（基尔霍夫定律），只算雨会低估；
  //      气体不计入：它晴空也在，已含在晴空 T_sys 基线里，不构成「劣化」。闪烁也不计（折射，不吸收不辐射）。
  //   ② T_mr = 275 K：ITU-R P.618 默认值（亦即 1.12·T_地面 − 50，T_地面≈290K）。
  //   ③ 天空噪声须经馈线衰减才到接收机参考点，故 ÷ 馈线线性损耗——与晴空 T_sys 的折算口径自洽。
  //      馈线损耗填 0 即退化为 SatMaster 口径（其「System noise (clear)」不做馈线折算）。
  const precipAtten = rainAtten + cloudAtten;
  let gtDegradation = null, noiseIncrease = null, dnd = null, rainNoiseTemp = null;
  if (direction === 'down') {
    const Tsys = systemNoiseTemp > 0 ? systemNoiseTemp : 120;               // 兜底晴空噪温
    const feedLin = Math.pow(10, feederLoss / 10);
    rainNoiseTemp = TMR * (1 - Math.pow(10, -precipAtten / 10));            // 雨+云致降雨噪温（天线口）
    gtDegradation = 10 * Math.log10((Tsys + rainNoiseTemp / feedLin) / Tsys);
    noiseIncrease = gtDegradation;                                          // 同一物理量（保留字段兼容）
    dnd = precipAtten + gtDegradation;                                      // 下行劣化 = 信号损失 + 噪声抬升
  }

  // —— 雨致去极化 XPD（P.618-14）：极化倾角 τ ——
  let tau;
  if (pol === 'C') tau = 45;
  else {
    const polAngle = hasGeo ? geo.calculatePolarizationAngle(lon, lat, satLon) : 0;
    tau = (pol === 'V') ? polAngle + 90 : polAngle;
  }
  const rawXpd = geo.calculateRainXPD_P618_14(rainAtten, freq, tau, elevation, pct);
  const rainXPD = Number.isFinite(rawXpd) ? rawXpd : null;

  // —— 可用度 / 不可用时长（年 + 最坏月 ITU-R P.841）——
  const downtimeYear = unavail * HOURS_PER_YEAR;
  const pw = pct > 0 ? Math.min(100, Math.pow(pct / 0.30, 1 / 1.15)) : 0;   // 年 → 最坏月时间百分比
  const worstMonthAvail = 100 - pw;
  const downtimeWorstMonth = (pw / 100) * (HOURS_PER_YEAR / 12);

  return {
    // 回显输入 / 几何（NGSO 统计口径下 elevation = §8 等效仰角，s8 给出其来源与诊断量）
    lat, lon, elevation, azimuth, slantRange, satLon: hasGeo ? satLon : null,
    s8: s8Info,
    freq, pol, polDisplay, diameter, efficiency, availability, systemNoiseTemp, feederLoss, direction,
    rainRate: R001, rainRateAuto: rainAuto, rainHeight, tau,
    // 传播结果
    gasAtten, scintillation, cloudAtten, rainAtten, precipAtten, totalAtten, totalAttenItu,
    rainNoiseTemp, noiseIncrease, dnd, gtDegradation, rainXPD,
    // 可用度 / 停时
    unavailPct: pct, downtimeYear, worstMonthAvail, downtimeWorstMonth
  };
}

/**
 * 曲线扫描：固定其余参数，扫某一自变量 → [{x, y=雨衰(dB)}]，供交互式坐标系绘制。
 * @param {object} p     基准算例参数（同 calculateRainAttenuation）
 * @param {string} axis  'availability' | 'frequency' | 'rainRate'
 * @param {object} range { min, max, steps }
 */
function sweepRainAttenuation(p, axis, range) {
  range = range || {};
  const steps = Math.max(2, Math.min(400, Math.round(num(range.steps, 120))));
  const min = num(range.min), max = num(range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { axis, points: [] };
  const points = [];
  for (let i = 0; i < steps; i++) {
    const x = min + (max - min) * i / (steps - 1);
    const q = Object.assign({}, p);
    if (axis === 'availability') q.availability = x;
    else if (axis === 'frequency') q.freq = x;
    else if (axis === 'rainRate') { q.rainRate = x; q.rainRateExact = true; }
    else if (axis === 'elevation') {
      // 直接扫仰角（GEO 也用 x 覆盖轨位反算值）。仰角轴与 §8 等效仰角互斥——扫的就是「单仰角下
      // 雨衰随仰角怎么变」，故本轴关掉 NGSO 统计口径，否则 x 会被 §8 解出的等效仰角原样盖掉。
      q.elevation = x; q.ngsoStat = false; q.satLon = undefined;
    }
    const r = calculateRainAttenuation(q);
    const y = (r && !r.error && Number.isFinite(r.rainAtten)) ? r.rainAtten : null;
    points.push({ x, y });
  }
  return { axis, points };
}

module.exports = { calculateRainAttenuation, sweepRainAttenuation, s8EquivalentElevation };
