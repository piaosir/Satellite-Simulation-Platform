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

const D2R = Math.PI / 180;
const HOURS_PER_YEAR = 8766;   // 365.25 d × 24 h（与 SatMaster「Link downtime」口径一致）
const TMR = 275;               // 介质辐射温度 Tmr (K)，ITU-R P.618 降雨天空噪声

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : (d === undefined ? NaN : d); }

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

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: true, message: '缺少经纬度' };
  if (!Number.isFinite(freq) || freq <= 0) return { error: true, message: '缺少有效频率' };

  // —— 仰角：优先直接输入；否则由 GEO satLon 反算。方位/斜距仅 GEO 便捷路径给出 ——
  let elevation = num(p.elevation);
  let azimuth = null, slantRange = null;
  if (hasGeo) {
    try { azimuth = geo.calculateSatelliteAngle(lat, lon, satLon).azimuth; } catch (e) { azimuth = null; }
    if (!Number.isFinite(elevation)) elevation = geoElevation(lat, lon, satLon);
    slantRange = geoSlantRange(lat, lon, satLon);
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

  // —— 降雨率 R0.01%（mm/h）：0/空 → 按 ITU-R P.837 查表；扫描降雨率轴时原样使用 ——
  let R001 = num(p.rainRate);
  let rainAuto = false;
  if (p.rainRateExact) {
    R001 = Math.max(0, Number.isFinite(R001) ? R001 : 0);
  } else if (!Number.isFinite(R001) || R001 <= 0) {
    try { R001 = rainRate.queryRainRate(lat, lon).rainRate; rainAuto = true; } catch (e) { R001 = 0; }
  }

  const pct = 100 - availability;   // 时间百分比 p(%)
  const unavail = pct / 100;

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
    // 回显输入 / 几何
    lat, lon, elevation, azimuth, slantRange, satLon: hasGeo ? satLon : null,
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
    else if (axis === 'elevation') q.elevation = x;   // 直接扫仰角（GEO 也用 x 覆盖轨位反算值）
    const r = calculateRainAttenuation(q);
    const y = (r && !r.error && Number.isFinite(r.rainAtten)) ? r.rainAtten : null;
    points.push({ x, y });
  }
  return { axis, points };
}

module.exports = { calculateRainAttenuation, sweepRainAttenuation };
