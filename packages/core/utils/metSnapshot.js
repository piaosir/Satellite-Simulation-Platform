// metSnapshot.js — 气象快照：实时分支与数据源之间的唯一契约
//
// 平台里已有的传播链全部是 ITU 气候统计口径（R0.01% + 可用度 p，出「年 p% 时间不超过」）。
// 实时分支要的是另一件事：**某一时刻**的大气状态 → **该时刻**的链路劣化。两者永不混算，
// 这个文件就是实时那一侧的入口数据结构。
//
// ★ 为什么要有这层结构，而不是让引擎直接吃和风的 JSON：
//   和风只是「当前选的那个 provider」。CMA 雷达 QPE、GFS/ECMWF 栅格、地球站现场的雨量计，
//   物理量是同一批，出参形状各不相同。引擎只认下面这个 MetSnapshot，换源只换一个 adapter，
//   引擎与界面一行不改。手工填的一组气象参数产出的也是同一个结构（src:'manual'），
//   于是「没网 / 没凭据」时整条分支照样能用 —— API 是填值器，不是功能的前提。
//
// 派生量一律按 ITU-R P.453-14（水汽压 / 湿项折射率）与 P.835（气压随高度）算，不另立经验式：
// 这些数最终要喂进 P.676 与 P.618 的既有函数，口径必须和它们对齐。
//
// 纯函数、无 IO、无 Vue/DOM，可离线单测。

/**
 * @typedef {object} MetSnapshot   一个站址在一个时刻的大气状态
 * @property {number} t            时刻（UNIX ms，UTC）
 * @property {'obs'|'fcst'} kind   实况 / 预报 —— 结果里要如实标出来，两者可信度差一个量级
 * @property {number} tC           气温（°C）
 * @property {number} pMslHpa      海平面气压（hPa）。注意不是站点气压，须经 stationPressure 折算
 * @property {number} [rh]         相对湿度（0~1，不是百分数）
 * @property {number} [tdC]        露点温度（°C）。给了就优先于 rh —— 露点直接定水汽压，少一次乘法误差
 * @property {number} rainMmH      降水强度（mm/h）
 * @property {string} precipType   rain | snow | ice | mixed | none | unknown
 * @property {number} [cloud]      云量（0~1）。只作读数，推不出柱液态水，故不入算
 * @property {number} [windMs]     地面风速（m/s）—— 合成风暴技术(SST)的输入
 * @property {number} [windDeg]    风向（度，气象约定：风的来向）
 * @property {string} src          数据源标识：'qweather' | 'manual' | …
 * @property {string[]} [attrib]   归因串（许可要求随数据一同显示）
 */

// ITU-R P.453-14 §1 饱和水汽压（水面）：e_s = EF · a · exp[(b − t/d)·t/(t + c)]
// 适用 −40 ~ +50 °C。P.453 另给了冰面系数（a=6.1115, b=23.036, c=279.82, d=333.7），
// 本模块**一律用水面式**，理由是输入本身就是水面参照的：气象业务的相对湿度与露点都按水面定义，
// 混用冰面式会与输入口径打架（负温下 e 会偏低约 10%，N_wet 与 ρ 跟着一起错）。
const ES_A = 6.1121, ES_B = 18.678, ES_C = 257.14, ES_D = 234.5;

/**
 * 饱和水汽压（hPa）。
 * @param {number} tC     温度 °C
 * @param {number} pHpa   环境气压 hPa（只进增强因子 EF，量级影响 <0.5%）
 */
function satVapourPressure(tC, pHpa) {
  if (!Number.isFinite(tC)) return NaN;
  const p = Number.isFinite(pHpa) && pHpa > 0 ? pHpa : 1013.25;
  const EF = 1 + 1e-4 * (7.2 + p * (0.0320 + 5.9e-6 * tC * tC));
  return EF * ES_A * Math.exp((ES_B - tC / ES_D) * tC / (tC + ES_C));
}

/**
 * 水汽压 e（hPa）。有露点走露点（e = e_s(t_d)，无需湿度）；否则 e = rh · e_s(t)。
 * @param {MetSnapshot} met
 * @returns {number} hPa，输入不足时 NaN
 */
function vapourPressure(met) {
  if (!met) return NaN;
  const p = Number.isFinite(met.pMslHpa) ? met.pMslHpa : 1013.25;
  if (Number.isFinite(met.tdC)) return satVapourPressure(met.tdC, p);
  if (Number.isFinite(met.tC) && Number.isFinite(met.rh)) {
    // 湿度按 0~1 收；万一 provider 给的是百分数（0~100），这里不猜、不静默换算 ——
    // 猜错会让 ρ 差 100 倍而结果仍「像个数」，是最坏的一类错。adapter 负责归一化。
    return Math.max(0, Math.min(1, met.rh)) * satVapourPressure(met.tC, p);
  }
  return NaN;
}

/** 地面水汽密度 ρ（g/m³）—— 喂 P.676 气体吸收，替掉 P.836 地图值。ρ = 216.7·e/T */
function vapourDensity(eHpa, tC) {
  if (!Number.isFinite(eHpa) || !Number.isFinite(tC)) return NaN;
  return 216.7 * eHpa / (tC + 273.15);
}

/** 湿项折射率 N_wet —— 喂 P.618 §2.4.1 闪烁，替掉引擎里写死的 42。P.453-14 式(9) */
function nWet(eHpa, tC) {
  if (!Number.isFinite(eHpa) || !Number.isFinite(tC)) return NaN;
  const T = tC + 273.15;
  return 72 * eHpa / T + 3.75e5 * eHpa / (T * T);
}

/**
 * 海平面气压 → 站点气压（hPa）。与 linkCalculator.js 里 uplinkPs 同一式（P.835-6 标准大气
 * 的位势高度关系），差别仅在基准由写死的 1013.25 换成实测海平面值。
 * @param {number} pMslHpa 海平面气压 hPa
 * @param {number} altKm   站址海拔 km
 */
function stationPressure(pMslHpa, altKm) {
  const p0 = Number.isFinite(pMslHpa) && pMslHpa > 0 ? pMslHpa : 1013.25;
  const h = Number.isFinite(altKm) ? altKm : 0;
  return p0 * Math.pow(Math.max(0.01, 1 - 6.5 * h / 288.15), 5.2561);
}

/**
 * 站点气温（K）。和风给的是 2 m 气温，站址就是那个点，不再做海拔递减
 * （统计分支那套「纬度分区参考大气 − 6.5 K/km」是因为它没有实测值可用）。
 */
function stationTempK(tC) {
  return Number.isFinite(tC) ? tC + 273.15 : NaN;
}

// 降水类型 → 雨衰模型是否适用。
// ★ P.838 的 k/α 由**雨滴**谱与 Mie 散射拟合而来，对雪 / 冰粒 / 冻雨不成立（干雪的衰减比同
//   等效降水率的雨低一到两个量级，湿雪反而可能更高，且没有可用的工程公式）。这几档一律不硬算：
//   给 null + 告警，而不是套一个看着正常的假数。这是本模块最该守住的一道闸。
const RAIN_TYPES = new Set(['rain', 'none', 'unknown', '']);
function rainModelApplies(precipType) {
  return RAIN_TYPES.has(String(precipType == null ? '' : precipType).toLowerCase());
}

/**
 * 由快照算出全部派生量，一次算完供引擎取用。
 * @param {MetSnapshot} met
 * @param {number} altKm 站址海拔（km）
 * @returns {{ e:number, rho:number, nWet:number, psHpa:number, tsK:number,
 *             rainMmH:number, rainOk:boolean, warn:string[] }}
 */
function derive(met, altKm) {
  const warn = [];
  const m = met || {};
  const e = vapourPressure(m);
  const tsK = stationTempK(m.tC);
  const psHpa = stationPressure(m.pMslHpa, altKm);
  const rho = vapourDensity(e, m.tC);
  const nw = nWet(e, m.tC);

  if (!Number.isFinite(tsK)) warn.push('缺气温：气体吸收退回标准大气');
  if (!Number.isFinite(e)) warn.push('缺湿度与露点：水汽项退回标准大气');

  const rainOk = rainModelApplies(m.precipType);
  let rainMmH = Number.isFinite(m.rainMmH) ? Math.max(0, m.rainMmH) : 0;
  if (!rainOk) {
    warn.push(`降水类型「${m.precipType}」不适用 P.838（k/α 按雨滴谱拟合），雨衰不计算`);
    rainMmH = 0;
  }
  return { e, rho, nWet: nw, psHpa, tsK, rainMmH, rainOk, warn };
}

/**
 * 手工填一组气象参数 → 同构的 MetSnapshot。实时分支离线可用的那条路。
 * @param {object} f { tC, pMslHpa, rh, tdC, rainMmH, precipType, cloud, windMs, windDeg, t }
 */
function manualSnapshot(f) {
  const o = f || {};
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };
  return {
    t: Number.isFinite(o.t) ? o.t : 0,
    kind: 'obs',
    tC: num(o.tC), pMslHpa: num(o.pMslHpa), rh: num(o.rh), tdC: num(o.tdC),
    rainMmH: Number.isFinite(Number(o.rainMmH)) ? Math.max(0, Number(o.rainMmH)) : 0,
    precipType: o.precipType || (Number(o.rainMmH) > 0 ? 'rain' : 'none'),
    cloud: num(o.cloud), windMs: num(o.windMs), windDeg: num(o.windDeg),
    src: 'manual', attrib: []
  };
}

module.exports = {
  satVapourPressure, vapourPressure, vapourDensity, nWet,
  stationPressure, stationTempK, rainModelApplies, derive, manualSnapshot
};
