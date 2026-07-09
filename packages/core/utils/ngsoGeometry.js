// NGSO 站星几何求解器（主进程 / Node）。
// 严格对齐「本软件建模体系」：SGP4/SDP4 轨道传播（vendor/satellite.js，vendored satellite-js）
// + WGS84 椭球（ecfToLookAngles 内部用 a=6378.137, b=6356.7523142）。
//
// 核心能力 —— 双站互视最差几何（solveMutualWorstCase）：
//   在参考时刻 t0 起的搜索时窗内用 SGP4 传播选定卫星，逐时刻对「发信站」求上行仰角、
//   对「收信站」求下行仰角；取两站「同时」满足各自最低仰角的互视窗口（排除
//   发✓收✗ / 发✗收✓ / 发✗收✗ 三种，只留发✓收✓），在窗口内取「上行+下行总自由空间
//   损耗最大」的最差时刻 t*（该时刻必落在互视窗口某个边界——某站正好压在自己的最低仰角上），
//   把 t* 时刻的上/下行斜距与仰角回喂链路预算引擎，并报告最近的最差时刻 t* 与互视窗口 [AOS, LOS]。
//
// 手动模式（未选星）：无时间维度，用球形闭式 d_max = √((Re+h)²−Re²cos²ε)−Re·sinε 取最差斜距。

const sat = require('../vendor/satellite.js');

// —— 几何权威常量（与 wgs84.js / walker.js / useCustomConstellations 同源；勿用 SGP4 私有 6378.135）——
const RE_KM = 6378.137;          // WGS84 赤道半径 Re
const MU = 398600.4418;          // 地心引力常数 μ (km³/s²)
const OMEGA_E = 7.2921150e-5;    // 地球自转角速度 (rad/s)
const C_KM_S = 299792.458;       // 光速 (km/s)
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const XPDOTP = 1440 / (2 * Math.PI); // rev/day ↔ rad/min

// ============================================================================
// 1. satrec 构建：支持 OMM 记录 / TLE 双行 / 经典六根数 三种来源
// ============================================================================
// spec 形式：
//   { type:'omm', noradId, epoch, meanMotion(rev/day), ecc, incl, raan, argp, ma, bstar?, mdot?, mddot? }
//   { type:'tle', line1, line2 }
//   { type:'elements', altKm(近地点高度 km), ecc, incl, raan, argp, ma, epoch?, noradId? }
function buildSatrec(spec) {
  if (!spec || !spec.type) throw new Error('缺少轨道来源 orbit.type');
  if (spec.type === 'tle') {
    return sat.twoline2satrec(String(spec.line1), String(spec.line2));
  }
  if (spec.type === 'omm') {
    return sat.omm2satrec({
      noradId: spec.noradId != null ? spec.noradId : 'NGSO',
      epoch: spec.epoch || new Date().toISOString(),
      meanMotion: Number(spec.meanMotion),
      ecc: Number(spec.ecc) || 0,
      incl: Number(spec.incl) || 0,
      raan: Number(spec.raan) || 0,
      argp: Number(spec.argp) || 0,
      ma: Number(spec.ma) || 0,
      bstar: Number(spec.bstar) || 0,
      mdot: Number(spec.mdot) || 0,
      mddot: Number(spec.mddot) || 0
    });
  }
  if (spec.type === 'elements') {
    // 经典六根数 → OMM：a=(Re+近地点高度)/(1−e)，n=√(μ/a³)，与 walker.js/useCustomConstellations 完全一致
    const ecc = Math.max(0, Math.min(0.999, Number(spec.ecc) || 0));
    const a = (RE_KM + (Number(spec.altKm) || 0)) / (1 - ecc);
    const nRadS = Math.sqrt(MU / (a * a * a));
    const meanMotion = 86400 * nRadS / (2 * Math.PI); // rev/day
    return sat.omm2satrec({
      noradId: spec.noradId != null ? spec.noradId : 'NGSO',
      epoch: spec.epoch || new Date().toISOString(),
      meanMotion, ecc,
      incl: Number(spec.incl) || 0,
      raan: Number(spec.raan) || 0,
      argp: Number(spec.argp) || 0,
      ma: Number(spec.ma) || 0,
      bstar: 0, mdot: 0, mddot: 0
    });
  }
  throw new Error('未知轨道来源 orbit.type: ' + spec.type);
}

// ============================================================================
// 2. 单点站星视角（斜距 / 仰角 / 方位角），全部走平台权威函数
// ============================================================================
// station: { lonDeg, latDeg, altKm }
function propagateAt(satrec, date) {
  const pv = sat.propagate(satrec, date);
  if (!pv || !pv.position || (satrec.error && satrec.error !== 0)) return null;
  return pv;
}

function lookAnglesFromPv(pv, station, date) {
  const gmst = sat.gstime(date);
  const ecf = sat.eciToEcf(pv.position, gmst);
  const obs = { longitude: station.lonDeg * DEG, latitude: station.latDeg * DEG, height: Number(station.altKm) || 0 };
  const la = sat.ecfToLookAngles(obs, ecf);
  return {
    elevDeg: la.elevation * RAD,
    azDeg: ((la.azimuth * RAD) % 360 + 360) % 360,
    slantKm: la.rangeSat
  };
}

function lookAngles(satrec, station, date) {
  const pv = propagateAt(satrec, date);
  if (!pv) return null;
  return lookAnglesFromPv(pv, station, date);
}

// 星下点（经纬高），用 eciToGeodetic
function subPoint(satrec, date) {
  const pv = propagateAt(satrec, date);
  if (!pv) return null;
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(date));
  return {
    lonDeg: sat.degreesLong(gd.longitude),
    latDeg: sat.degreesLat(gd.latitude),
    altKm: gd.height
  };
}

// ============================================================================
// 3. 轨道根数（历元静态根数 + 派生量）
// ============================================================================
function staticElements(satrec) {
  const nRadMin = satrec.no;              // rad/min
  const nRadS = nRadMin / 60;             // rad/s
  const a = Math.cbrt(MU / (nRadS * nRadS)); // km（用几何 μ 重算，避免 SGP4 私有半径）
  const e = satrec.ecco;
  const periodMin = (2 * Math.PI) / nRadMin;
  return {
    a,                                     // 半长轴 km
    e,                                     // 偏心率
    iDeg: satrec.inclo * RAD,              // 倾角 °
    raanDeg: satrec.nodeo * RAD,           // 升交点赤经 °
    argpDeg: satrec.argpo * RAD,           // 近地点幅角 °
    maDeg: satrec.mo * RAD,                // 平近点角 °
    meanMotionRevDay: nRadMin * XPDOTP,    // 平均运动 rev/day
    periodMin,                             // 轨道周期 min
    apogeeAltKm: a * (1 + e) - RE_KM,      // 远地点高度 km
    perigeeAltKm: a * (1 - e) - RE_KM,     // 近地点高度 km
    epochJd: satrec.jdsatepoch,            // 历元儒略日
    satnum: satrec.satnum
  };
}

// 瞬时平根数（当前时刻，随传播变化）
function instantElements(satrec, date) {
  const pv = propagateAt(satrec, date);
  if (!pv || !pv.meanElements) return null;
  const m = pv.meanElements;
  const nRadMin = m.nm;
  return {
    aKm: m.am * RE_KM,                     // am 为 Earth radii（SGP4 单位），此处仅作展示换 km
    e: m.em,
    iDeg: m.im * RAD,
    raanDeg: ((m.Om * RAD) % 360 + 360) % 360,
    argpDeg: ((m.om * RAD) % 360 + 360) % 360,
    maDeg: ((m.mm * RAD) % 360 + 360) % 360,
    meanMotionRevDay: nRadMin * XPDOTP,
    periodMin: (2 * Math.PI) / nRadMin
  };
}

// 惯性系速度 / 相对地面速度（Earth-relative）
function velocities(pv) {
  const v = pv.velocity, r = pv.position;
  const speedInertial = Math.hypot(v.x, v.y, v.z);
  // v_rel = v − ω×r，ω=[0,0,OMEGA_E]，ω×r = [−ω·r.y, ω·r.x, 0]
  const vrx = v.x + OMEGA_E * r.y;
  const vry = v.y - OMEGA_E * r.x;
  const vrz = v.z;
  const speedGroundRel = Math.hypot(vrx, vry, vrz);
  return { speedInertial, speedGroundRel };
}

// 多普勒：range-rate 中心差分（ECEF 斜距对时间导数，已含地球自转），f 单位 GHz
function dopplerHz(satrec, station, date, freqGHz, dtSec) {
  dtSec = dtSec || 1;
  const dtMs = dtSec * 1000;
  const a = lookAngles(satrec, station, new Date(date.getTime() - dtMs));
  const b = lookAngles(satrec, station, new Date(date.getTime() + dtMs));
  if (!a || !b) return null;
  const rangeRate = (b.slantKm - a.slantKm) / (2 * dtSec); // km/s，正=远离
  const fHz = (Number(freqGHz) || 0) * 1e9;
  return -fHz * (rangeRate / C_KM_S); // 远离→负多普勒
}

// ============================================================================
// 4. 手动模式：球形闭式最差斜距（给定轨道高度 + 最低仰角）
// ============================================================================
// d_max = √((Re+h)² − Re²·cos²ε) − Re·sinε；ε=90°→d=h，ε=0°→d=√(r²−Re²)。
function closedFormWorstSlant(altKm, minElevDeg) {
  const h = Math.max(0, Number(altKm) || 0);
  const e = Math.max(0, Math.min(90, Number(minElevDeg) || 0)) * DEG;
  const r = RE_KM + h;
  const ce = Math.cos(e), se = Math.sin(e);
  return Math.sqrt(r * r - RE_KM * RE_KM * ce * ce) - RE_KM * se;
}

// WGS84 大地坐标 → ECEF（与 satellite.js geodeticToEcf 同式）；用于静止/快照星几何。
function geodeticToEcef(lonDeg, latDeg, altKm) {
  const a = 6378.137, b = 6356.7523142;
  const f = (a - b) / a, e2 = 2 * f - f * f;
  const lon = (Number(lonDeg) || 0) * DEG, lat = (Number(latDeg) || 0) * DEG, h = Number(altKm) || 0;
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
  return {
    x: (N + h) * Math.cos(lat) * Math.cos(lon),
    y: (N + h) * Math.cos(lat) * Math.sin(lon),
    z: (N * (1 - e2) + h) * Math.sin(lat)
  };
}

// 静止/快照星几何（orbit.type==='snapshot'，仅有当前星下点 lon/lat/altKm，无完整轨道根数）：
// 卫星视为固定于该星下点（对 GEO/静止轨道严格成立，对快照即取该时刻），几何时不变、恒可见——
// 不做时窗搜索。用于天线树导入的 GEO 预置星（保留其真实经度，不用假圆轨道反推错经度）。
function solveStaticGeometry(opts) {
  const s = opts.orbit || {}, tx = opts.tx || {}, rx = opts.rx || {};
  const txMin = Number(tx.minElevDeg) || 0, rxMin = Number(rx.minElevDeg) || 0;
  const lonDeg = Number(s.lonDeg) || 0, latDeg = Number(s.latDeg) || 0, altKm = Math.max(0, Number(s.altKm) || 0);
  const satEcef = geodeticToEcef(lonDeg, latDeg, altKm);
  const look = (st) => {
    const obs = { longitude: (Number(st.lonDeg) || 0) * DEG, latitude: (Number(st.latDeg) || 0) * DEG, height: Number(st.altKm) || 0 };
    const la = sat.ecfToLookAngles(obs, satEcef);
    return { elevDeg: la.elevation * RAD, azDeg: ((la.azimuth * RAD) % 360 + 360) % 360, slantKm: la.rangeSat };
  };
  const up = look(tx), dn = look(rx);
  const r = RE_KM + altKm, nRadS = Math.sqrt(MU / (r * r * r));
  const elements = {
    a: r, e: 0, iDeg: Math.abs(latDeg), raanDeg: 0, argpDeg: 0, maDeg: 0,
    meanMotionRevDay: 86400 * nRadS / (2 * Math.PI), periodMin: (2 * Math.PI) / (nRadS * 60),
    apogeeAltKm: altKm, perigeeAltKm: altKm, epochJd: null, satnum: s.noradId || null
  };
  const t0 = opts.t0ISO ? new Date(opts.t0ISO) : new Date();
  if (up.elevDeg < txMin - 1e-6 || dn.elevDeg < rxMin - 1e-6) {
    return { feasible: false, reason: `所选卫星（星下点 ${lonDeg.toFixed(1)}°E）对两站中至少一站低于最低仰角（上行 ${up.elevDeg.toFixed(1)}° / 下行 ${dn.elevDeg.toFixed(1)}°）`, elements, search: { t0ISO: t0.toISOString(), static: true } };
  }
  return {
    feasible: true, static: true,
    worst: {
      timeISO: t0.toISOString(),
      up: { elevDeg: up.elevDeg, azDeg: up.azDeg, slantKm: up.slantKm },
      dn: { elevDeg: dn.elevDeg, azDeg: dn.azDeg, slantKm: dn.slantKm },
      subPoint: { lonDeg, latDeg, altKm },
      speedInertialKmS: nRadS * r, speedGroundRelKmS: 0,
      dopplerUpHz: 0, dopplerDnHz: 0, maxDopplerUpHz: 0, maxDopplerDnHz: 0,
      oneWayDelayMs: (up.slantKm + dn.slantKm) / C_KM_S * 1000
    },
    window: { aosISO: null, losISO: null, durationMin: null, continuous: true },
    elements, instantElements: null,
    search: { t0ISO: t0.toISOString(), static: true }
  };
}

// 由「轨道高度 + 倾角」合成虚拟圆轨道根数（e=0，近=远地点=高度）。35786km/0° 即标准 GEO（a≈42164、周期≈1436min）。
function virtualElements(altKm, inclDeg) {
  const h = Math.max(0, Number(altKm) || 0), a = RE_KM + h;
  const nRadS = Math.sqrt(MU / (a * a * a));
  return {
    a, e: 0, iDeg: Number(inclDeg) || 0, raanDeg: 0, argpDeg: 0, maDeg: 0,
    meanMotionRevDay: 86400 * nRadS / (2 * Math.PI), periodMin: (2 * Math.PI) / (nRadS * 60),
    apogeeAltKm: h, perigeeAltKm: h, epochJd: null, satnum: null
  };
}

// 手动模式几何（orbit.type==='circular'，仅给轨道高度+倾角，无具体星历/相位）：
// 无法做双站互视时窗，改用球形闭式最差几何——每站按【自身最低仰角】取最大斜距（各自最坏、最保守），
// 并给出虚拟圆轨道根数。方位角/多普勒/星下点/相对地面速度因缺相位而不定，置 null。
function solveCircularWorstCase(opts) {
  const s = opts.orbit || {}, tx = opts.tx || {}, rx = opts.rx || {};
  const altKm = Math.max(0, Number(s.altKm) || 0), inclDeg = Number(s.inclDeg) || 0;
  const txMin = Number(tx.minElevDeg) || 0, rxMin = Number(rx.minElevDeg) || 0;
  const txFreq = Number(tx.freqGHz) > 0 ? Number(tx.freqGHz) : 14;
  const rxFreq = Number(rx.freqGHz) > 0 ? Number(rx.freqGHz) : 12;
  const upSlant = closedFormWorstSlant(altKm, txMin), dnSlant = closedFormWorstSlant(altKm, rxMin);
  const a = RE_KM + altKm;
  // 多普勒/速度统一在几何层出（单一口径，避免与引擎闭式各算一套）。手动圆轨道无相位/无时序，
  // 无法做 SGP4 range-rate，只能给闭式「估算」：f_d = f·v_radial/c，
  //   v_radial = |v_sat − ω_E·r·cos i|·Re·cos(ε_min)/r，v_sat=√(μ/r)。dopplerEstimate 标记供 UI 标注。
  const vSat = Math.sqrt(MU / a);
  const vGround = Math.abs(vSat - OMEGA_E * a * Math.cos(inclDeg * DEG));
  const dopEst = (elevDeg, freqGHz) => (vGround * RE_KM * Math.cos(elevDeg * DEG) / a) / C_KM_S * (freqGHz * 1e9); // Hz
  return {
    feasible: true, manual: true, dopplerEstimate: true,
    worst: {
      timeISO: null,
      up: { elevDeg: txMin, azDeg: null, slantKm: upSlant },
      dn: { elevDeg: rxMin, azDeg: null, slantKm: dnSlant },
      subPoint: null,
      speedInertialKmS: vSat, speedGroundRelKmS: vGround,
      dopplerUpHz: null, dopplerDnHz: null, maxDopplerUpHz: dopEst(txMin, txFreq), maxDopplerDnHz: dopEst(rxMin, rxFreq),
      oneWayDelayMs: (upSlant + dnSlant) / C_KM_S * 1000
    },
    window: { aosISO: null, losISO: null, durationMin: null, continuous: null, manual: true },
    elements: virtualElements(altKm, inclDeg), instantElements: null,
    search: { manual: true }
  };
}

// ============================================================================
// 5. 双站互视最差几何主入口
// ============================================================================
// opts = {
//   orbit,                                  // buildSatrec 的 spec
//   tx: { lonDeg, latDeg, altKm, minElevDeg, freqGHz },
//   rx: { lonDeg, latDeg, altKm, minElevDeg, freqGHz },
//   t0ISO?, horizonHours=24, coarseStepSec=15, fineStepSec=1
// }
function fsl(slantKm, freqGHz) {
  // 20·log10(f) + 20·log10(d·1000) + const；const 与频率/斜距无关，比大小时可略，但保留以便直读 dB
  const d = Math.max(1e-6, slantKm);
  const f = Math.max(1e-6, freqGHz);
  return 20 * (Math.log10(f) + Math.log10(d * 1000)) + 20 * Math.log10((4 * Math.PI) / 0.299792458);
}

function solveMutualWorstCase(opts) {
  opts = opts || {};
  // 手动虚拟圆轨道（仅高度+倾角）：球形闭式最差几何 + 虚拟轨道根数
  if (opts.orbit && opts.orbit.type === 'circular') return solveCircularWorstCase(opts);
  // 静止/快照星（无完整轨道根数）走静态几何，不做时窗搜索
  if (opts.orbit && opts.orbit.type === 'snapshot') return solveStaticGeometry(opts);
  const tx = opts.tx || {}, rx = opts.rx || {};
  const txMin = Number(tx.minElevDeg) || 0;
  const rxMin = Number(rx.minElevDeg) || 0;
  const txFreq = Number(tx.freqGHz) > 0 ? Number(tx.freqGHz) : 14;
  const rxFreq = Number(rx.freqGHz) > 0 ? Number(rx.freqGHz) : 12;
  const horizonHours = Number(opts.horizonHours) > 0 ? Number(opts.horizonHours) : 24;
  const coarseStepSec = Number(opts.coarseStepSec) > 0 ? Number(opts.coarseStepSec) : 15;
  const fineStepSec = Number(opts.fineStepSec) > 0 ? Number(opts.fineStepSec) : 1;

  let satrec;
  try { satrec = buildSatrec(opts.orbit); }
  catch (e) { return { feasible: false, reason: '轨道根数无效：' + e.message }; }
  if (satrec.error && satrec.error !== 0) {
    return { feasible: false, reason: 'SGP4 初始化失败（error=' + satrec.error + '）' };
  }

  const stat = staticElements(satrec);
  const t0 = opts.t0ISO ? new Date(opts.t0ISO) : new Date();
  // 向前回溯一个轨道周期，以捕获 t0 时刻可能正在进行中的互视窗口
  const backMs = Math.min(stat.periodMin * 60 * 1000, horizonHours * 3600 * 1000);
  const startMs = t0.getTime() - backMs;
  const endMs = t0.getTime() + horizonHours * 3600 * 1000;
  // 慢速轨道（GEO/高 MEO，周期>600min）：星下点移动慢、可见性变化以小时计 → 粗采样步长放宽到 5 分钟，
  // 大幅减少 SDP4 深空传播次数（否则 48h@15s 需上万次深空传播，单条链路数秒）；LEO/低轨保持精细步长以免漏短过境。
  const stepMs = stat.periodMin > 600 ? Math.max(coarseStepSec * 1000, 300000) : coarseStepSec * 1000;

  // —— 粗采样：检测互视窗口（发✓且收✓），并记录每个互视样本的 FSL 度量（供全时段最差定位）——
  function mutualMargin(date) {
    const up = lookAngles(satrec, tx, date);
    const dn = lookAngles(satrec, rx, date);
    if (!up || !dn) return { ok: false, up, dn };
    return { ok: (up.elevDeg >= txMin) && (dn.elevDeg >= rxMin), up, dn };
  }

  const windows = [];
  const coarse = [];   // { tms, ok, metric } —— metric = 上行FSL+下行FSL（互视样本才有）
  let prevOk = false, winStart = null, prevDate = null;
  for (let tms = startMs; tms <= endMs; tms += stepMs) {
    const d = new Date(tms);
    const mm = mutualMargin(d);
    const metric = mm.ok ? fsl(mm.up.slantKm, txFreq) + fsl(mm.dn.slantKm, rxFreq) : -Infinity;
    coarse.push({ tms, ok: mm.ok, metric });
    if (mm.ok && !prevOk) winStart = prevDate ? prevDate : d;        // 上升沿
    if (!mm.ok && prevOk && winStart) { windows.push([winStart, d]); winStart = null; } // 下降沿
    prevOk = mm.ok; prevDate = d;
  }
  if (prevOk && winStart) windows.push([winStart, new Date(endMs)]); // 收尾（时窗末仍可见）

  // 仅保留「未完全过去」（LOS ≥ t0）的窗口
  const upcoming = windows.filter((w) => w[1].getTime() >= t0.getTime());
  if (!upcoming.length) {
    return {
      feasible: false,
      reason: `搜索时窗 ${horizonHours}h 内两站不同时可见（单星无法同时建链）`,
      elements: stat,
      search: { t0ISO: t0.toISOString(), horizonHours, coarseStepSec }
    };
  }
  upcoming.sort((a, b) => a[0] - b[0]);
  // —— 全时段最差工况：在所有 upcoming 窗口的粗样本里取 FSL 最大者，定位其所在窗口（而非只取最近一个窗口）。
  //    HEO 等不同远地点过顶经度不同 → 各次过境仰角/斜距差异大，最坏那次未必是最近那次；取全时段最坏最保守。
  const gate = upcoming[0][0].getTime();  // 最早 upcoming 窗口起点：此后所有 ok 样本必属某个 upcoming 窗口（窗口间隙为非 ok）
  let worstTms = null, worstMetric = -Infinity;
  for (const c of coarse) { if (c.ok && c.tms >= gate && c.metric > worstMetric) { worstMetric = c.metric; worstTms = c.tms; } }
  const worstWin = (worstTms != null && upcoming.find((w) => worstTms >= w[0].getTime() && worstTms <= w[1].getTime())) || upcoming[0];
  let [aos, los] = worstWin;

  // —— 二分细化 AOS / LOS（mutualMargin 由 <0 → ≥0 的过零点）——
  function refineEdge(tLo, tHi) {
    // 约定 tLo 处 margin<0、tHi 处 margin≥0（AOS）；LOS 反之，调用前排好
    for (let i = 0; i < 40 && (tHi - tLo) > 200; i++) {
      const mid = (tLo + tHi) / 2;
      if (mutualMargin(new Date(mid)).ok) tHi = mid; else tLo = mid;
    }
    return new Date(tHi);
  }
  // AOS：[aos−step, aos] 内细化（若 aos 已被钳到 startMs 则不细化）
  if (aos.getTime() > startMs) aos = refineEdge(aos.getTime() - stepMs, aos.getTime());
  // LOS：[los−step, los]，但 los 端 margin<0，需反向：找最后一个 ok 时刻
  if (los.getTime() < endMs) {
    let tLo = los.getTime() - stepMs, tHi = los.getTime();
    for (let i = 0; i < 40 && (tHi - tLo) > 200; i++) {
      const mid = (tLo + tHi) / 2;
      if (mutualMargin(new Date(mid)).ok) tLo = mid; else tHi = mid;
    }
    los = new Date(tLo);
  }

  // 「持续可见」判定：互视窗口铺满整个搜索范围（如 GEO/静止轨道，两站恒可见）→ 非真正过境窗口，
  // AOS/LOS 只是搜索边界，UI/导出应表述为「持续可见」，最差时刻取窗口内仰角最低（斜距最大）之处。
  const continuous = (aos.getTime() <= startMs + stepMs) && (los.getTime() >= endMs - stepMs);

  // —— 窗口内细扫最差时刻 t*：最大化 上行FSL+下行FSL（等价总路径损耗最大），约束两站均 ≥ 各自最低仰角 ——
  // 细扫步长自适应：样本数封顶（无论窗口多长）——避免 GEO 等超长互视窗口把 1s 步进放大成数十万次 SGP4 传播。
  // NGSO 过境窗口仅几分钟 → 步长退回 fineStepSec（1s）；GEO 连续可见窗口 → 步长自动放大到几十秒。
  // 慢速轨道（GEO/高 MEO）仰角变化平缓、最差点很宽 → 更少样本即可定位；LEO 过境快、需更密样本。
  const MAX_FINE_SAMPLES = stat.periodMin > 600 ? 800 : 3000;
  const winLenMs = Math.max(0, los.getTime() - aos.getTime());
  let best = null;
  const fineMs = Math.max(fineStepSec * 1000, Math.ceil(winLenMs / MAX_FINE_SAMPLES) || 1);
  for (let tms = aos.getTime(); tms <= los.getTime() + 1; tms += fineMs) {
    const d = new Date(Math.min(tms, los.getTime()));
    const up = lookAngles(satrec, tx, d);
    const dn = lookAngles(satrec, rx, d);
    if (!up || !dn) continue;
    if (up.elevDeg < txMin - 1e-6 || dn.elevDeg < rxMin - 1e-6) continue;
    const metric = fsl(up.slantKm, txFreq) + fsl(dn.slantKm, rxFreq);
    if (!best || metric > best.metric) best = { metric, date: d, up, dn };
    if (tms >= los.getTime()) break;
  }
  if (!best) {
    return {
      feasible: false,
      reason: '互视窗口内未取到有效最差几何（采样过疏或窗口过短）',
      elements: stat,
      window: { aosISO: aos.toISOString(), losISO: los.toISOString(), durationMin: (los - aos) / 60000 },
      search: { t0ISO: t0.toISOString(), horizonHours, coarseStepSec }
    };
  }

  // —— t* 时刻完整状态 ——
  const tStar = best.date;
  const pvStar = propagateAt(satrec, tStar);
  const vel = pvStar ? velocities(pvStar) : { speedInertial: null, speedGroundRel: null };
  const sp = subPoint(satrec, tStar);
  const dopUp = dopplerHz(satrec, tx, tStar, txFreq);
  const dopDn = dopplerHz(satrec, rx, tStar, rxFreq);
  const oneWayDelayMs = (best.up.slantKm + best.dn.slantKm) / C_KM_S * 1000;

  // 互视窗口内最大多普勒（幅值），供展示
  let maxDopUp = 0, maxDopDn = 0;
  for (let tms = aos.getTime(); tms <= los.getTime(); tms += Math.max(fineMs, 2000)) {
    const d = new Date(tms);
    const du = dopplerHz(satrec, tx, d, txFreq);
    const dd = dopplerHz(satrec, rx, d, rxFreq);
    if (du != null) maxDopUp = Math.max(maxDopUp, Math.abs(du));
    if (dd != null) maxDopDn = Math.max(maxDopDn, Math.abs(dd));
  }

  return {
    feasible: true,
    worst: {
      timeISO: tStar.toISOString(),
      up: { elevDeg: best.up.elevDeg, azDeg: best.up.azDeg, slantKm: best.up.slantKm },
      dn: { elevDeg: best.dn.elevDeg, azDeg: best.dn.azDeg, slantKm: best.dn.slantKm },
      subPoint: sp,
      speedInertialKmS: vel.speedInertial,
      speedGroundRelKmS: vel.speedGroundRel,
      dopplerUpHz: dopUp,
      dopplerDnHz: dopDn,
      maxDopplerUpHz: maxDopUp,
      maxDopplerDnHz: maxDopDn,
      oneWayDelayMs
    },
    window: { aosISO: aos.toISOString(), losISO: los.toISOString(), durationMin: (los - aos) / 60000, continuous },
    elements: stat,
    instantElements: instantElements(satrec, tStar),
    search: { t0ISO: t0.toISOString(), horizonHours, coarseStepSec, fineStepSec }
  };
}

module.exports = {
  RE_KM, MU, OMEGA_E, C_KM_S,
  buildSatrec,
  lookAngles,
  subPoint,
  staticElements,
  instantElements,
  virtualElements,
  closedFormWorstSlant,
  solveCircularWorstCase,
  solveStaticGeometry,
  solveMutualWorstCase
};
