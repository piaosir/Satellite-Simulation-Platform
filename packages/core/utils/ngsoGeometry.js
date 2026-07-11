// NGSO 站星几何求解器（主进程 / Node）。
// 建模体系：SGP4/SDP4 轨道传播（vendor/satellite.js）+ WGS84 椭球（ecfToLookAngles 内部 a=6378.137）。
//
// 几何口径（两类，按轨道来源分派）：
//   ① 选星（真实星历 omm/elements，含近圆）→「单一典型时刻」t*：SGP4/SDP4 在搜索时窗内传播，
//      取【同一物理瞬间】——两站同时可见（各自仰角≥最低）、且两站仰角相对各自最低仰角的超出量之和最小者。
//      bent-pipe 中继上下行本就同刻发生，故所有几何（上/下斜距·高度·速度·多普勒·时延）全部取自这一刻 t*。
//      通常 t* 落在互视窗边缘：一站正压最低仰角、另一站略高（用户口径：尽量贴近最低仰角，达不到就算了）。
//      时窗内两站从不曾同时可见 → 单星无法中继（infeasible）。SGP4/SDP4 由周期自动选（<225min / ≥225min）。
//   ② 手动虚拟圆轨道（type:'circular'，仅高度+倾角，无相位）→ 闭式球面：无从定义共同时刻，退回
//      每站各自「≥ 自身最低仰角」的最大斜距 closedFormWorstSlant(高度, 最低仰角)，与历元/RAAN 无关、
//      可复现、与星座3D 页一致；可见性由「纬度 vs 倾角」闭式判定。
//
// 静止/快照星（orbit.type==='snapshot'，仅星下点）→ 固定点静态几何。
//
// ★ 本模块是 NGSO 全部轨道几何量的【单一真值源】：斜距/仰角/高度/速度/多普勒/时延/周期/覆盖半角/
//   覆盖半径/过境时长 一律在此算好，经 mergePlatformGeometry 覆盖进链路结果。linkCalculatorNGSO
//   只消费斜距(→FSL)与仰角(→大气/雨衰路径)，不再自行重算轨道力学（避免两套引擎、口径不一致）。
// 严谨性口径：圆轨道闭式用【站址 WGS84 地心半径(含海拔)】而非赤道半径当球，与 SGP4 椭球路径同源；
//   多普勒（选星）取 t* 该刻 |range-rate|（含地球自转）；无 t0ISO 时锚星历元(可复现)。

const sat = require('../vendor/satellite.js');
const { findWindows } = require('./eventWindows.js');

// —— 几何权威常量（与 wgs84.js / walker.js / useCustomConstellations 同源）——
const RE_KM = 6378.137;          // WGS84 赤道半径 Re
const MU = 398600.4418;          // 地心引力常数 μ (km³/s²)
const OMEGA_E = 7.2921150e-5;    // 地球自转角速度 (rad/s)
const C_KM_S = 299792.458;       // 光速 (km/s)
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const XPDOTP = 1440 / (2 * Math.PI); // rev/day ↔ rad/min
const ECC_CIRCULAR_TOL = 1e-3;   // e < 此值视为圆轨道 → 走闭式球面（与时间/历元无关）

// ============================================================================
// 1. satrec 构建：OMM 记录 / TLE 双行 / 经典六根数 三种来源
// ============================================================================
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
    // 经典六根数 → OMM：a=(Re+近地点高度)/(1−e)，n=√(μ/a³)，与 walker.js/useCustomConstellations 完全一致。
    // epoch 为自定义星座的场景历元 scenarioEpoch（由上游透传）；缺省才退回当前时刻（仅兜底）。
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

// satrec 传播器标注：'d' 深空(SDP4) / 'n' 近地(SGP4)
function propagatorLabel(satrec) {
  return satrec && satrec.method === 'd' ? 'SDP4' : 'SGP4';
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
  const a = Math.cbrt(MU / (nRadS * nRadS)); // km
  const e = satrec.ecco;
  const periodMin = (2 * Math.PI) / nRadMin;
  return {
    a, e,
    iDeg: satrec.inclo * RAD,
    raanDeg: satrec.nodeo * RAD,
    argpDeg: satrec.argpo * RAD,
    maDeg: satrec.mo * RAD,
    meanMotionRevDay: nRadMin * XPDOTP,
    periodMin,
    apogeeAltKm: a * (1 + e) - RE_KM,
    perigeeAltKm: a * (1 - e) - RE_KM,
    epochJd: satrec.jdsatepoch,
    satnum: satrec.satnum
  };
}

// 惯性系速度 / 相对地面速度（Earth-relative）
function velocities(pv) {
  const v = pv.velocity, r = pv.position;
  const speedInertial = Math.hypot(v.x, v.y, v.z);
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
  return -fHz * (rangeRate / C_KM_S);
}

// 视线斜距变化率 range-rate（km/s，+ = 远离）：由 ECEF 状态矢量解析求得，含地球自转，
// 复用 propagate 返回的 velocity，无需额外传播 → 可在扫描循环里逐样本求真正的最大多普勒。
// v_ecef = R(gmst)·v_eci − ω×r_ecef；range-rate = (Δr·v_ecef)/|Δr|，Δr = 卫星ECEF − 站址ECEF。
function rangeRateKmS(pv, obsEcf, date) {
  const gmst = sat.gstime(date);
  const r = sat.eciToEcf(pv.position, gmst);
  const v = sat.eciToEcf(pv.velocity, gmst);
  const vx = v.x + OMEGA_E * r.y;   // −ω×r 的 x 分量为 +ω·r_y
  const vy = v.y - OMEGA_E * r.x;   // −ω×r 的 y 分量为 −ω·r_x
  const vz = v.z;
  const dx = r.x - obsEcf.x, dy = r.y - obsEcf.y, dz = r.z - obsEcf.z;
  const dist = Math.hypot(dx, dy, dz) || 1;
  return (dx * vx + dy * vy + dz * vz) / dist;
}

// 站址 WGS84 地心半径（含海拔，km）——让圆轨道闭式与 SGP4 椭球路径同源，
// 消除「用赤道半径当球半径」在高纬处的单向偏置与 e=ECC_CIRCULAR_TOL 分派边界的跳变。
function stationGeoRadiusKm(latDeg, altKm) {
  const a = RE_KM, b = 6356.7523142;
  const lat = (Number(latDeg) || 0) * DEG;
  const cl = Math.cos(lat), sl = Math.sin(lat);
  const num = (a * a * cl) * (a * a * cl) + (b * b * sl) * (b * b * sl);
  const den = (a * cl) * (a * cl) + (b * sl) * (b * sl);
  return Math.sqrt(num / den) + Math.max(0, Number(altKm) || 0);
}

// 大地纬度 → 地心纬度（deg）：倾角是地心/惯性参照，做「纬度 vs 倾角」覆盖带判定前须换算。
function geocentricLatDeg(latDeg) {
  const f2 = (6356.7523142 / RE_KM) * (6356.7523142 / RE_KM); // (1−e²)=(b/a)²
  return Math.atan(f2 * Math.tan((Number(latDeg) || 0) * DEG)) * RAD;
}

// 可见性/过境几何（覆盖地心半角 λ、地面覆盖半径、天顶过境最大时长）——单一真值源。
// 用真实倾角 inclDeg 与半长轴 aKm（周期一致），替代 linkCalculatorNGSO 里用 50° 默认倾角的重复实现。
//   λ = arccos((Re/r)·cosε) − ε；地面半径 = Re·λ；过境 = 2λ/|ω_s − ω_E·cos i|
function visMetricsFor(rKm, minElevDeg, inclDeg, aKm) {
  const eps = Math.max(0, Number(minElevDeg) || 0) * DEG;
  const ratio = Math.min(1, Math.max(-1, (RE_KM / rKm) * Math.cos(eps)));
  const lam = Math.max(0, Math.acos(ratio) - eps);                 // 覆盖地心半角 (rad)
  const omegaS = Math.sqrt(MU / (aKm * aKm * aKm));                // 轨道角速度 (rad/s)
  const omegaRel = Math.abs(omegaS - OMEGA_E * Math.cos((Number(inclDeg) || 0) * DEG));  // 星下点相对地面漂移率
  // 常驻可见（∞）判据：ω_rel < 2% 地球自转率 → 地面轨迹漂移极慢（GEO/近静止/低倾角 GSO），对可见站等效常驻。
  // 用「同步性比例」而非绝对小量（旧 1e-9 太紧，真实 GEO 因不完全同步残留 ω_rel≈1e-8 会被误判为~9 年的有限过境）。
  // cos i 项已让高倾角同步轨道（如 Tundra/QZSS i≈63°：纬度大幅摆动、确会落下）获得大 ω_rel → 仍为有限过境。
  const SYNC_TOL = 0.02 * OMEGA_E;
  const passMin = omegaRel > SYNC_TOL ? (2 * lam / omegaRel) / 60 : Infinity;
  return {
    coverageHalfAngleDeg: lam * RAD,
    coverageRadiusKm: RE_KM * lam,
    maxPassMin: isFinite(passMin) ? passMin : null   // null = 常驻可见(∞)
  };
}

// ============================================================================
// 4. 闭式球面几何（圆轨道）
// ============================================================================
// 最差斜距（站址地心半径 Rs、轨道地心半径 r=Re+h）：d = √(r² − Rs²·cos²ε) − Rs·sinε。
//   由余弦定理 r²=Rs²+d²+2·Rs·d·sinε 的正根化简而来；ε=90°→d=r−Rs，ε=0°→d=√(r²−Rs²)。
//   Rs 缺省用赤道半径 RE_KM（向后兼容）；传入站址地心半径即与 SGP4 椭球路径同源。
function closedFormWorstSlant(altKm, minElevDeg, stationRadiusKm) {
  const h = Math.max(0, Number(altKm) || 0);
  const e = Math.max(0, Math.min(90, Number(minElevDeg) || 0)) * DEG;
  const r = RE_KM + h;
  const Rs = Number(stationRadiusKm) > 0 ? Number(stationRadiusKm) : RE_KM;
  const ce = Math.cos(e), se = Math.sin(e);
  return Math.sqrt(r * r - Rs * Rs * ce * ce) - Rs * se;
}

// 站址对某高度圆轨道能达到的最大仰角（几何上界，与历元/经度无关）：
//   卫星星下点纬度可达 ±iEff（iEff=min(i,180−i)）；星下点扫过所有经度 → 站星最小中心角
//   γ_min = max(0, |lat| − iEff)。仰角 el 满足 tan(el)=(cosγ − Re/r)/sinγ，γ=0 → el=90°。
// 用于判定该站能否见到卫星过其最低仰角（|lat| 超出轨道覆盖带则永不可见）。
function maxElevForCircular(latDeg, inclDeg, altKm, stationRadiusKm) {
  const r = RE_KM + Math.max(0, Number(altKm) || 0);
  const Rs = Number(stationRadiusKm) > 0 ? Number(stationRadiusKm) : RE_KM;
  const i = Math.abs(Number(inclDeg) || 0);
  const iEff = Math.min(i, 180 - i);
  // 站址大地纬度 → 地心纬度后再与倾角（地心参照）比较覆盖带，消除 ≤0.19° 参照系错配
  const latGc = Math.abs(geocentricLatDeg(latDeg));
  const gamma = Math.max(0, latGc - iEff) * DEG;
  if (gamma <= 1e-9) return 90;
  return Math.atan2(Math.cos(gamma) - Rs / r, Math.sin(gamma)) * RAD;
}

// WGS84 大地坐标 → ECEF；用于静止/快照星几何。
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

// 由「轨道高度 + 倾角」合成虚拟圆轨道根数（e=0）。
function virtualElements(altKm, inclDeg) {
  const h = Math.max(0, Number(altKm) || 0), a = RE_KM + h;
  const nRadS = Math.sqrt(MU / (a * a * a));
  return {
    a, e: 0, iDeg: Number(inclDeg) || 0, raanDeg: 0, argpDeg: 0, maDeg: 0,
    meanMotionRevDay: 86400 * nRadS / (2 * Math.PI), periodMin: (2 * Math.PI) / (nRadS * 60),
    apogeeAltKm: h, perigeeAltKm: h, epochJd: null, satnum: null
  };
}

// ============================================================================
// 5. 静止/快照星（orbit.type==='snapshot'）：固定于星下点，仰角/斜距时不变。
// ============================================================================
function solveStaticGeometry(opts) {
  const s = opts.orbit || {}, tx = opts.tx || {}, rx = opts.rx || {};
  const txMin = Number(tx.minElevDeg) || 0, rxMin = Number(rx.minElevDeg) || 0;
  const lonDeg = Number(s.lonDeg) || 0, latDeg = Number(s.latDeg) || 0, altKm = Math.max(0, Number(s.altKm) || 0);
  const satEcef = geodeticToEcef(lonDeg, latDeg, altKm);
  const look = (st) => {
    const obs = { longitude: (Number(st.lonDeg) || 0) * DEG, latitude: (Number(st.latDeg) || 0) * DEG, height: Number(st.altKm) || 0 };
    const la = sat.ecfToLookAngles(obs, satEcef);
    return { elevDeg: la.elevation * RAD, slantKm: la.rangeSat };
  };
  const up = look(tx), dn = look(rx);
  const r = RE_KM + altKm, nRadS = Math.sqrt(MU / (r * r * r));
  const elements = {
    a: r, e: 0, iDeg: Math.abs(latDeg), raanDeg: 0, argpDeg: 0, maDeg: 0,
    meanMotionRevDay: 86400 * nRadS / (2 * Math.PI), periodMin: (2 * Math.PI) / (nRadS * 60),
    apogeeAltKm: altKm, perigeeAltKm: altKm, epochJd: null, satnum: s.noradId || null
  };
  const method = '静态几何';
  if (up.elevDeg < txMin - 1e-6 || dn.elevDeg < rxMin - 1e-6) {
    return { feasible: false, method, reason: `所选卫星（星下点 ${lonDeg.toFixed(1)}°E）对两站中至少一站低于最低仰角（上行 ${up.elevDeg.toFixed(1)}° / 下行 ${dn.elevDeg.toFixed(1)}°）`, elements };
  }
  const visU = visMetricsFor(r, txMin, Math.abs(latDeg), r);
  const visD = visMetricsFor(r, rxMin, Math.abs(latDeg), r);
  return {
    feasible: true, method, static: true, dopplerEstimate: false,
    // 静止/快照星的星下点恒定 → 天线增益采样即用此固定位置（与静态几何同刻，无时变）。
    subSat: { lonDeg, latDeg, altKm },
    worst: {
      up: { elevDeg: up.elevDeg, slantKm: up.slantKm, altKm, ...visU },
      dn: { elevDeg: dn.elevDeg, slantKm: dn.slantKm, altKm, ...visD },
      speedInertialKmS: nRadS * r, speedGroundRelKmS: 0,
      maxDopplerUpHz: 0, maxDopplerDnHz: 0,
      oneWayDelayMs: (up.slantKm + dn.slantKm) / C_KM_S * 1000
    },
    elements
  };
}

// ============================================================================
// 6. 闭式球面最差（圆轨道 / 手动虚拟圆轨道）—— 每站去耦，最差 = 各站最低仰角处的最大斜距
// ============================================================================
// altKm/inclDeg 定轨道；tx/rx 含 minElevDeg、freqGHz，若带 latDeg 则做「纬度 vs 倾角」可见性判定。
function closedFormWorst(altKm, inclDeg, tx, rx, elements, opts) {
  const h = Math.max(0, Number(altKm) || 0);
  if (!(h > 0)) return { feasible: false, method: '闭式球面', reason: '轨道高度无效（需 > 0 km）', elements };
  const a = RE_KM + h;
  const stn = (st) => {
    const minEl = Math.max(0, Number(st.minElevDeg) || 0);
    // 站址地心半径（含海拔）——与 SGP4 椭球路径同源，消除高纬赤道半径偏置
    const Rs = stationGeoRadiusKm(st.latDeg, st.altKm);
    // 有站址纬度时判可见（|lat| 超覆盖带则永不可见）；无纬度（旧手动调用）则不设限
    const maxEl = (st.latDeg != null && st.latDeg !== '') ? maxElevForCircular(st.latDeg, inclDeg, h, Rs) : 90;
    return { minEl, maxEl, feasible: maxEl >= minEl - 1e-6, slantKm: closedFormWorstSlant(h, minEl, Rs) };
  };
  const up = stn(tx), dn = stn(rx);
  if (!up.feasible || !dn.feasible) {
    const who = !up.feasible ? `发信站(纬度${Number(tx.latDeg).toFixed(1)}°，最大可见仰角${up.maxEl.toFixed(1)}°<最低${up.minEl}°)`
                             : `收信站(纬度${Number(rx.latDeg).toFixed(1)}°，最大可见仰角${dn.maxEl.toFixed(1)}°<最低${dn.minEl}°)`;
    return { feasible: false, method: '闭式球面', reason: `轨道倾角 ${Number(inclDeg).toFixed(1)}° / 高度 ${h.toFixed(0)}km 下，${who} 永不可见`, elements };
  }
  // 速度 / 多普勒：圆轨道闭式估算（无相位无法做真 range-rate）
  const txFreq = Number(tx.freqGHz) > 0 ? Number(tx.freqGHz) : 14;
  const rxFreq = Number(rx.freqGHz) > 0 ? Number(rx.freqGHz) : 12;
  const vSat = Math.sqrt(MU / a);
  const vGround = Math.abs(vSat - OMEGA_E * a * Math.cos((Number(inclDeg) || 0) * DEG));
  const dopEst = (elevDeg, freqGHz) => (vGround * RE_KM * Math.cos(elevDeg * DEG) / a) / C_KM_S * (freqGHz * 1e9);
  // 可见性/过境几何（单一真值源，用真实倾角）——供瀑布表覆盖半角/半径/过境时长
  const visU = visMetricsFor(a, up.minEl, inclDeg, a);
  const visD = visMetricsFor(a, dn.minEl, inclDeg, a);
  return {
    feasible: true, method: '闭式球面', dopplerEstimate: true,
    worst: {
      up: { elevDeg: up.minEl, slantKm: up.slantKm, altKm: h, ...visU },
      dn: { elevDeg: dn.minEl, slantKm: dn.slantKm, altKm: h, ...visD },
      speedInertialKmS: vSat, speedGroundRelKmS: vGround,
      maxDopplerUpHz: dopEst(up.minEl, txFreq), maxDopplerDnHz: dopEst(dn.minEl, rxFreq),
      oneWayDelayMs: (up.slantKm + dn.slantKm) / C_KM_S * 1000
    },
    elements
  };
}

// ============================================================================
// 7. 真实星历「单一典型时刻」求解（SGP4 / SDP4）—— 同一物理瞬间 t*，两站仰角尽量贴近各自最低仰角
// ============================================================================
// 用户口径：链路预算取【一个】典型时刻，令发/收两站在该刻同时可见、且两站仰角都尽量接近各自最低仰角
//（bent-pipe 中继上下行本就同刻发生）。所有几何——上/下斜距、卫星高度、速度、多普勒、时延——全部取自 t*。
// 选取：时窗内扫描，取「两站同时可见（各自仰角≥最低）」样本中，两站仰角相对各自最低仰角的超出量之和
//   cost = (elTx−minTx)+(elRx−minRx) 最小者（越贴近双站最低仰角越好；单次过境仰角单峰，最小值必落在
//   互视窗边缘——一站正压最低仰角、另一站略高，与用户描述一致）。粗解后在 ±1 步内细扫精化到窗边。
//   若时窗内两站从不曾同时可见 → 单星无法中继此链路（infeasible）。
function coupledTypicalMoment(satrec, tx, rx, opts) {
  const stat = staticElements(satrec);
  const method = propagatorLabel(satrec);
  const txMin = Math.max(0, Number(tx.minElevDeg) || 0);
  const rxMin = Math.max(0, Number(rx.minElevDeg) || 0);
  // 无显式 t0 时锚到星历元（确定性、可复现；且 TLE 在历元附近精度最高），而非非确定性的 wall-clock now()
  const t0 = opts.t0ISO ? new Date(opts.t0ISO)
    : new Date((satrec.jdsatepoch + (satrec.jdsatepochF || 0) - 2440587.5) * 86400000);
  const horizonHours = Number(opts.horizonHours) > 0 ? Number(opts.horizonHours) : 24;
  const startMs = t0.getTime();
  const endMs = startMs + horizonHours * 3600 * 1000;
  // 采样步长：周期的 1/3000 与「时窗均分 2 万点」取较大（既密采近地点快段、又封顶总传播次数）
  const periodSec = stat.periodMin * 60;
  const stepMs = Math.max(1000, Math.min(periodSec / 3000, horizonHours * 3600 / 20000) * 1000);

  // 站址 ECEF（求 range-rate 用，含地球自转），一次算好复用
  const txEcf = geodeticToEcef(tx.lonDeg, tx.latDeg, tx.altKm);
  const rxEcf = geodeticToEcef(rx.lonDeg, rx.latDeg, rx.altKm);
  const EPS = 1e-6;
  // 单刻采样：两站仰角/斜距；null 表示传播失败
  const sampleAt = (tms) => {
    const d = new Date(tms);
    const pv = propagateAt(satrec, d);
    if (!pv) return null;
    return { tms, d, pv, u: lookAnglesFromPv(pv, tx, d), v: lookAnglesFromPv(pv, rx, d) };
  };
  // 代价：两站同时可见时 = 两站仰角超出各自最低仰角之和（越小越贴近双站最低仰角）；否则 +∞（不可用）
  const costOf = (s) => {
    if (!s || s.u.elevDeg < txMin - EPS || s.v.elevDeg < rxMin - EPS) return Infinity;
    return (s.u.elevDeg - txMin) + (s.v.elevDeg - rxMin);
  };

  // 粗扫全时窗：取代价最小（最贴近双站最低仰角）的同一时刻 t*；同时 track 各站【全窗口峰值 |range-rate|】
  //   → 稳定可复现的最大多普勒（峰值径向速率是轨道周期性复现量，与搜索起点 t0 无关，多次计算复现）。
  let best = null, bestCost = Infinity;
  let maxRRUp = 0, maxRRDn = 0;
  for (let tms = startMs; tms <= endMs; tms += stepMs) {
    const s = sampleAt(tms);
    const c = costOf(s);
    if (c < bestCost) { bestCost = c; best = s; }
    if (s) {
      if (s.u.elevDeg >= txMin - EPS) { const rr = Math.abs(rangeRateKmS(s.pv, txEcf, s.d)); if (rr > maxRRUp) maxRRUp = rr; }
      if (s.v.elevDeg >= rxMin - EPS) { const rr = Math.abs(rangeRateKmS(s.pv, rxEcf, s.d)); if (rr > maxRRDn) maxRRDn = rr; }
    }
  }
  if (!best) {
    return { feasible: false, method, reason: `搜索时窗 ${horizonHours}h 内发信站与收信站从不曾同时可见（单星无法中继此链路，可增大搜索时窗或改选卫星）`, elements: stat, search: { t0ISO: t0.toISOString(), horizonHours } };
  }
  // 局部细化：粗解 ±1 步内以 stepMs/60 细扫，把 t* 精化到互视窗边（正压最低仰角那一刻）
  const fine = Math.max(200, stepMs / 60);
  for (let tms = best.tms - stepMs; tms <= best.tms + stepMs; tms += fine) {
    if (tms < startMs || tms > endMs) continue;
    const s = sampleAt(tms);
    const c = costOf(s);
    if (c < bestCost) { bestCost = c; best = s; }
  }

  // 满足两站最低仰角的互视时间窗（含 t* 的那次过境）：t* 落在窗边，向两侧扩展至任一站跌破最低仰角，
  // 再二分细化边界到 ~0.5s。供几何卡展示「发/收两站同时满足最低仰角的时段范围」。
  const bothVisible = (tms) => {
    const s = sampleAt(tms);
    return !!(s && s.u.elevDeg >= txMin - EPS && s.v.elevDeg >= rxMin - EPS);
  };
  // 二分：inMs（窗内可见）↔ outMs（窗外不可见）之间逼近跌破边界
  const refineEdge = (inMs, outMs) => {
    let lo = inMs, hi = outMs;
    for (let k = 0; k < 30 && Math.abs(hi - lo) > 500; k++) {
      const mid = (lo + hi) / 2;
      if (bothVisible(mid)) lo = mid; else hi = mid;
    }
    return lo;
  };
  let winStart = best.tms, winEnd = best.tms, winClipped = false;
  { let t = best.tms; while (t - stepMs >= startMs && bothVisible(t - stepMs)) t -= stepMs;
    if (t - stepMs >= startMs) winStart = refineEdge(t, t - stepMs); else { winStart = startMs; winClipped = true; } }
  { let t = best.tms; while (t + stepMs <= endMs && bothVisible(t + stepMs)) t += stepMs;
    if (t + stepMs <= endMs) winEnd = refineEdge(t, t + stepMs); else { winEnd = endMs; winClipped = true; } }
  const mutualWindow = {
    startISO: new Date(winStart).toISOString(), endISO: new Date(winEnd).toISOString(),
    durationMin: (winEnd - winStart) / 60000, clipped: winClipped
  };

  // t* 该刻的完整状态：同一瞬间两站高度相同；速度/多普勒取该刻真值
  const d = best.d, pv = best.pv;
  const sp = subPoint(satrec, d);
  const altKm = sp ? sp.altKm : stat.apogeeAltKm;
  const rKm = RE_KM + altKm;
  const vel = velocities(pv);
  const txFreq = Number(tx.freqGHz) > 0 ? Number(tx.freqGHz) : 14;
  const rxFreq = Number(rx.freqGHz) > 0 ? Number(rx.freqGHz) : 12;
  // 多普勒取【全时窗内该站峰值 |range-rate|】× f/c（含地球自转）：峰值径向速率是轨道周期性复现量，
  // 与搜索起点 t0 无关、多次计算复现；且是该链路会遇到的最大多普勒（设计最坏值），比单取 t* 该刻稳定。
  const dopUpHz = maxRRUp / C_KM_S * (txFreq * 1e9);
  const dopDnHz = maxRRDn / C_KM_S * (rxFreq * 1e9);
  // 可见性/过境几何（t* 高度处地心半径、真实倾角与半长轴）——单一真值源
  const visU = visMetricsFor(rKm, txMin, stat.iDeg, stat.a);
  const visD = visMetricsFor(rKm, rxMin, stat.iDeg, stat.a);
  return {
    feasible: true, method, dopplerEstimate: false, coupled: true,
    // t* 该刻的星下点（经纬高）——链路预算把卫星置于此位置采样天线增益(EIRP/G·T)，
    // 使导入的卫星 EIRP/G·T 与本行斜距/FSL/C·N 取自同一物理瞬间（对齐性能指标表）。
    subSat: sp ? { lonDeg: sp.lonDeg, latDeg: sp.latDeg, altKm: sp.altKm } : null,
    worst: {
      up: { elevDeg: best.u.elevDeg, slantKm: best.u.slantKm, altKm, ...visU },
      dn: { elevDeg: best.v.elevDeg, slantKm: best.v.slantKm, altKm, ...visD },
      speedInertialKmS: vel.speedInertial, speedGroundRelKmS: vel.speedGroundRel,
      maxDopplerUpHz: dopUpHz, maxDopplerDnHz: dopDnHz,
      oneWayDelayMs: (best.u.slantKm + best.v.slantKm) / C_KM_S * 1000
    },
    elements: stat,
    search: {
      t0ISO: t0.toISOString(), horizonHours, stepSec: stepMs / 1000,
      t0Source: opts.t0ISO ? 'explicit' : 'epoch',
      typicalISO: d.toISOString(),
      subSatLonDeg: sp ? sp.lonDeg : null, subSatLatDeg: sp ? sp.latDeg : null,
      txElevExcessDeg: best.u.elevDeg - txMin, rxElevExcessDeg: best.v.elevDeg - rxMin,
      mutualWindow
    }
  };
}

// ============================================================================
// 8. 主入口：按轨道类型 / 偏心率分派
// ============================================================================
// opts = { orbit, tx:{lonDeg,latDeg,altKm,minElevDeg,freqGHz}, rx:{...}, t0ISO?, horizonHours? }
function solveMutualWorstCase(opts) {
  opts = opts || {};
  const o = opts.orbit || {};
  const tx = opts.tx || {}, rx = opts.rx || {};

  // 轨道未解析（天线树 linked 星离线查不到 / 缺根数）——原样上报选星时给出的原因，不兜底
  if (o.type === 'unresolved') return { feasible: false, reason: o.reason || '所选卫星轨道未能解析，无法确定其几何' };

  // 静止/快照星
  if (o.type === 'snapshot') return solveStaticGeometry(opts);

  // 手动虚拟圆轨道（仅高度+倾角）
  if (o.type === 'circular') {
    const altKm = Math.max(0, Number(o.altKm) || 0), inclDeg = Number(o.inclDeg) || 0;
    return closedFormWorst(altKm, inclDeg, tx, rx, virtualElements(altKm, inclDeg), opts);
  }

  // 选星（elements / omm）：建 satrec → 单一典型时刻耦合扫描（SGP4/SDP4 由周期自动选）
  let satrec;
  try { satrec = buildSatrec(o); }
  catch (e) { return { feasible: false, reason: '轨道根数无效：' + e.message }; }
  if (satrec.error && satrec.error !== 0) {
    return { feasible: false, reason: 'SGP4 初始化失败（error=' + satrec.error + '）' };
  }
  // 选星（真实星历，含近圆）一律走「单一典型时刻」耦合扫描：同一物理瞬间 t*、两站仰角尽量贴近各自最低仰角。
  // 近圆真实星不再走历元无关闭式（那是两站各自最低仰角、非同一瞬间）——用户口径为单一共同时刻。
  return coupledTypicalMoment(satrec, tx, rx, opts);
}

// ============================================================================
// 9. 单站访问窗口（Access）——时窗内满足最低仰角及以上的【全部】过境时间窗
// ============================================================================
// 对「满足最低仰角及以上」用通用窗口求解器 findWindows：f(t)=仰角−最低仰角，>0 即在窗口内。
// 选星（真实星历 omm/elements/tle）→ 逐个真实过境；手动圆轨道（circular）→ 合成虚拟 OMM 传播，
// 得示意过境（节律/时长真实，绝对时刻因 RAAN/MA/历元取默认而仅供示意，representative=true）；
// 静止/快照星（snapshot）→ 可见则整时窗为一个常驻窗口。
// opts = { orbit, station:{lonDeg,latDeg,altKm,minElevDeg,freqGHz}, t0ISO?, horizonHours? }
function solveAccessWindows(opts) {
  opts = opts || {};
  const o = opts.orbit || {};
  const st = opts.station || {};
  const minEl = Math.max(0, Number(st.minElevDeg) || 0);
  const station = { lonDeg: Number(st.lonDeg) || 0, latDeg: Number(st.latDeg) || 0, altKm: Number(st.altKm) || 0 };
  const horizonHours = Number(opts.horizonHours) > 0 ? Number(opts.horizonHours) : 24;

  if (o.type === 'unresolved') return { feasible: false, reason: o.reason || '所选卫星轨道未能解析，无法确定其几何', windows: [] };

  // 快照/静止星：仰角恒定 → 可见则整时窗为一个常驻窗口
  if (o.type === 'snapshot') {
    const satEcef = geodeticToEcef(Number(o.lonDeg) || 0, Number(o.latDeg) || 0, Math.max(0, Number(o.altKm) || 0));
    const obs = { longitude: station.lonDeg * DEG, latitude: station.latDeg * DEG, height: station.altKm };
    const la = sat.ecfToLookAngles(obs, satEcef);
    const el = la.elevation * RAD;
    const t0 = opts.t0ISO ? new Date(opts.t0ISO) : new Date();
    if (el < minEl - 1e-6) return { feasible: false, method: '静态几何', reason: `星下点(${Number(o.lonDeg).toFixed(1)}°E) 对该站仰角 ${el.toFixed(1)}° < 最低 ${minEl}°`, windows: [] };
    return {
      feasible: true, method: '静态几何', persistent: true,
      windows: [{ startISO: t0.toISOString(), endISO: new Date(t0.getTime() + horizonHours * 3600000).toISOString(), durationMin: horizonHours * 60, peakElevDeg: el, peakISO: t0.toISOString(), peakSlantKm: la.rangeSat, maxSlantKm: la.rangeSat, clipped: true }],
      totalWindows: 1, totalDurationMin: horizonHours * 60,
      search: { t0ISO: t0.toISOString(), horizonHours, minElevDeg: minEl }
    };
  }

  // 建 satrec：circular 合成虚拟 OMM；elements/omm/tle 直接建
  let satrec, method, representative = false;
  if (o.type === 'circular') {
    const altKm = Math.max(0, Number(o.altKm) || 0), inclDeg = Number(o.inclDeg) || 0;
    if (!(altKm > 0)) return { feasible: false, method: '闭式球面', reason: '轨道高度无效（需 > 0 km）', windows: [] };
    const a = RE_KM + altKm;
    const meanMotion = 86400 * Math.sqrt(MU / (a * a * a)) / (2 * Math.PI);
    try { satrec = buildSatrec({ type: 'omm', meanMotion, ecc: 0, incl: inclDeg, raan: 0, argp: 0, ma: 0, epoch: opts.t0ISO || new Date().toISOString() }); }
    catch (e) { return { feasible: false, reason: '虚拟圆轨道构建失败：' + e.message, windows: [] }; }
    method = '闭式球面'; representative = true;
  } else {
    try { satrec = buildSatrec(o); } catch (e) { return { feasible: false, reason: '轨道根数无效：' + e.message, windows: [] }; }
    if (satrec.error && satrec.error !== 0) return { feasible: false, reason: 'SGP4 初始化失败（error=' + satrec.error + '）', windows: [] };
    method = propagatorLabel(satrec);
  }

  const stat = staticElements(satrec);
  const t0 = opts.t0ISO ? new Date(opts.t0ISO)
    : new Date((satrec.jdsatepoch + (satrec.jdsatepochF || 0) - 2440587.5) * 86400000);
  const startS = t0.getTime() / 1000, endS = startS + horizonHours * 3600;
  const elAt = (ts) => { const la = lookAngles(satrec, station, new Date(ts * 1000)); return la ? la.elevDeg : NaN; };
  const f = (ts) => { const e = elAt(ts); return isFinite(e) ? e - minEl : NaN; };
  // 粗扫步长：周期 1/200 与 60s 取较小（既能抓住 LEO 短过境、又封顶总传播次数）
  const periodSec = stat.periodMin * 60;
  const coarse = Math.max(5, Math.min(periodSec / 200, 60));
  const raw = findWindows(f, startS, endS, { coarseStep: coarse, tol: 1, findPeak: true });
  const windows = raw.map((w) => {
    const peakT = w.peak ? w.peak.t : (w.start + w.end) / 2;
    const peakLa = lookAngles(satrec, station, new Date(peakT * 1000));
    const startLa = lookAngles(satrec, station, new Date(w.start * 1000));
    const endLa = lookAngles(satrec, station, new Date(w.end * 1000));
    const edgeSlant = Math.max(startLa ? startLa.slantKm : 0, endLa ? endLa.slantKm : 0);
    const clipped = (w.start <= startS + 1e-3) || (w.end >= endS - 1e-3);
    return {
      startISO: new Date(w.start * 1000).toISOString(),
      endISO: new Date(w.end * 1000).toISOString(),
      durationMin: (w.end - w.start) / 60,
      peakElevDeg: peakLa ? peakLa.elevDeg : (w.peak ? w.peak.value + minEl : null),
      peakISO: new Date(peakT * 1000).toISOString(),
      peakSlantKm: peakLa ? peakLa.slantKm : null,
      maxSlantKm: edgeSlant || null,
      clipped
    };
  });
  const totalDurationMin = windows.reduce((s, w) => s + w.durationMin, 0);
  return {
    feasible: windows.length > 0, method, representative,
    reason: windows.length ? '' : `搜索时窗 ${horizonHours}h 内该站对卫星始终低于最低仰角 ${minEl}°（|纬度| 可能超出轨道覆盖带，或需增大搜索时窗）`,
    windows, totalWindows: windows.length, totalDurationMin,
    elements: stat,
    search: { t0ISO: t0.toISOString(), horizonHours, minElevDeg: minEl, representative }
  };
}

// ============================================================================
// 10. 星间链路(ISL)两星几何：双 SGP4 传播 → ECEF，地球临边遮挡 + 最差星间距离 + 互视窗口
// ============================================================================
// 严谨口径：两星位置全在 ECEF（地心）系算——星间距离/遮挡/掠地高度与惯性系严格等价（刚性旋转保距），
// 距离变化率用中心差分（帧无关）。可见性 = LOS 线段最近地心距 ≥ RE + 大气余量（微波须清过大气）。
// 最差工况 = 互视样本中【最大星间距离】（最大 FSL → 最差 C/N）。系统可用度 = 互视样本占比。
// 手动圆轨道相位缺省 = 0：两同参数星退化为重合（星间距离≈0），明确报因，引导选真实卫星。
// opts = { orbitA(发射), orbitB(接收), t0ISO?, horizonHours?, freqGHz?(多普勒), atmMarginKm? }

// 某端点在 date 的 ECEF 位置（km）。node: { kind:'sat', satrec } | { kind:'snapshot', ecef(时不变) }
function _islPosEcefAt(node, date) {
  if (node.kind === 'snapshot') return node.ecef;
  const pv = propagateAt(node.satrec, date);
  if (!pv) return null;
  const ecf = sat.eciToEcf(pv.position, sat.gstime(date));
  return { x: ecf.x, y: ecf.y, z: ecf.z };
}

// LOS 段几何（ECEF，km）：星间距离 + 线段对地心最近距离。遮挡 ⇔ 最近点落在两星之间(0<t<1)且离地心 < R_block。
function _islLos(pA, pB, blockRadiusKm) {
  const dx = pB.x - pA.x, dy = pB.y - pA.y, dz = pB.z - pA.z;
  const seg2 = dx * dx + dy * dy + dz * dz;
  const rangeKm = Math.sqrt(seg2);
  const t = seg2 > 0 ? -(pA.x * dx + pA.y * dy + pA.z * dz) / seg2 : -1;
  let minCenterKm;
  if (t > 0 && t < 1) {
    const cx = pA.x + t * dx, cy = pA.y + t * dy, cz = pA.z + t * dz;
    minCenterKm = Math.sqrt(cx * cx + cy * cy + cz * cz);   // 垂足离地心
  } else {
    minCenterKm = Math.min(Math.hypot(pA.x, pA.y, pA.z), Math.hypot(pB.x, pB.y, pB.z)); // 垂足在段外 → 取端点（卫星本身，远高于地面）
  }
  return { rangeKm, minCenterKm, visible: minCenterKm >= blockRadiusKm };
}

// 建 ISL 端点：satrec（elements/omm/tle/circular 合成）或 snapshot（固定 ECEF）。失败带 reason。
function _islNode(orbit) {
  const o = orbit || {};
  if (o.type === 'unresolved') return { reason: o.reason || '所选卫星轨道未能解析，无法确定其几何' };
  if (o.type === 'snapshot') {
    const ecef = geodeticToEcef(Number(o.lonDeg) || 0, Number(o.latDeg) || 0, Math.max(0, Number(o.altKm) || 0));
    return { node: { kind: 'snapshot', ecef }, method: '静态几何', representative: false, elements: null };
  }
  if (o.type === 'circular') {
    const altKm = Math.max(0, Number(o.altKm) || 0), inclDeg = Number(o.inclDeg) || 0;
    if (!(altKm > 0)) return { reason: '轨道高度无效（需 > 0 km）' };
    const a = RE_KM + altKm;
    const meanMotion = 86400 * Math.sqrt(MU / (a * a * a)) / (2 * Math.PI);
    let satrec;
    try { satrec = buildSatrec({ type: 'omm', meanMotion, ecc: 0, incl: inclDeg, raan: Number(o.raanDeg) || 0, argp: 0, ma: Number(o.maDeg) || 0, epoch: o.epoch || new Date().toISOString() }); }
    catch (e) { return { reason: '虚拟圆轨道构建失败：' + e.message }; }
    return { node: { kind: 'sat', satrec }, method: '闭式球面', representative: true, elements: staticElements(satrec) };
  }
  let satrec;
  try { satrec = buildSatrec(o); } catch (e) { return { reason: '轨道根数无效：' + e.message }; }
  if (satrec.error && satrec.error !== 0) return { reason: 'SGP4 初始化失败（error=' + satrec.error + '）' };
  return { node: { kind: 'sat', satrec }, method: propagatorLabel(satrec), representative: false, elements: staticElements(satrec) };
}

function solveIslWorstCase(opts) {
  opts = opts || {};
  const A = _islNode(opts.orbitA), B = _islNode(opts.orbitB);
  if (A.reason) return { feasible: false, reason: '发射卫星：' + A.reason };
  if (B.reason) return { feasible: false, reason: '接收卫星：' + B.reason };
  const horizonHours = Number(opts.horizonHours) > 0 ? Number(opts.horizonHours) : 24;
  const atmMarginKm = Number(opts.atmMarginKm) >= 0 ? Number(opts.atmMarginKm) : 100;
  const blockRadiusKm = RE_KM + atmMarginKm;
  const freqGHz = Number(opts.freqGHz) > 0 ? Number(opts.freqGHz) : 23;
  const representative = A.representative || B.representative;
  const method = representative ? '闭式球面·示意' : (A.method + '↔' + B.method);

  const epochOf = (nd) => (nd.node.kind === 'sat' && nd.node.satrec) ? new Date((nd.node.satrec.jdsatepoch + (nd.node.satrec.jdsatepochF || 0) - 2440587.5) * 86400000) : null;
  const t0 = opts.t0ISO ? new Date(opts.t0ISO) : (epochOf(A) || epochOf(B) || new Date());
  const startS = t0.getTime() / 1000, endS = startS + horizonHours * 3600;
  const perMin = Math.min(A.elements ? A.elements.periodMin : 1440, B.elements ? B.elements.periodMin : 1440);
  const stepSec = Math.max(2, Math.min((perMin * 60) / 200, 30));

  const sampleAt = (ts) => {
    const d = new Date(ts * 1000);
    const pA = _islPosEcefAt(A.node, d), pB = _islPosEcefAt(B.node, d);
    if (!pA || !pB) return null;
    const los = _islLos(pA, pB, blockRadiusKm);
    return { pA, pB, ...los };
  };

  // 扫描：互视样本取【最大 range】为最差 FSL；同时 track 全窗口峰值径向速率（相邻可见样本有限差分）
  //   → 稳定可复现的最大多普勒。峰值径向速率是轨道周期性复现量，与搜索起点 t0 无关，多次计算复现。
  let worst = null, minR = Infinity, nVis = 0, nTot = 0;
  let maxAbsRR = 0, rrAtPeak = 0, prevVis = null;
  for (let ts = startS; ts <= endS + 1e-6; ts += stepSec) {
    const s = sampleAt(ts);
    if (!s) { prevVis = null; continue; }
    nTot++;
    if (!s.visible) { prevVis = null; continue; }
    nVis++;
    if (s.rangeKm < minR) minR = s.rangeKm;
    if (!worst || s.rangeKm > worst.s.rangeKm) worst = { s, ts };   // ← 修复：原误写 worst.rangeKm(undefined) 致锁定首个可见样本
    if (prevVis) {
      const dt = ts - prevVis.ts;                                    // 仅相邻可见样本（跨可见性间隙时 prevVis 置空）
      if (dt > 0) { const rr = (s.rangeKm - prevVis.rangeKm) / dt; if (Math.abs(rr) > maxAbsRR) { maxAbsRR = Math.abs(rr); rrAtPeak = rr; } }
    }
    prevVis = { ts, rangeKm: s.rangeKm };
  }
  const windowMinutes = horizonHours * 60;
  const visibleFrac = nTot > 0 ? nVis / nTot : 0;

  if (!worst) {
    return {
      feasible: false, method, representative,
      reason: `搜索时窗 ${horizonHours}h 内两星从不互视（LOS 始终被地球遮挡；可增大搜索时窗、调整轨道或减小大气余量 ${atmMarginKm}km）`,
      visibility: { visibleFrac: 0, visibleMinutes: 0, windowMinutes },
      search: { t0ISO: t0.toISOString(), horizonHours, stepSec, atmMarginKm, blockRadiusKm, freqGHz }
    };
  }
  if (worst.s.rangeKm < 1) {
    return {
      feasible: false, method: '闭式球面·示意', representative: true,
      reason: '两星几何重合（星间距离≈0）：手动圆轨道相位缺省相同。请改选两颗真实卫星，或使两星轨道（相位/升交点/高度）不同。',
      visibility: { visibleFrac, visibleMinutes: visibleFrac * windowMinutes, windowMinutes },
      search: { t0ISO: t0.toISOString(), horizonHours, stepSec, atmMarginKm, blockRadiusKm, freqGHz }
    };
  }

  // 地心夹角/两星高度/掠地高度/时延取自【最大 range】刻；距离变化率/多普勒取【全窗口峰值径向速率】——
  // 最大 range 处恰是径向距离驻点(dρ/dt≈0)，不能在该刻取多普勒（会近零且随采样漂移）；峰值径向速率稳定可复现。
  const W = worst.s;
  const rangeRateKmS = rrAtPeak;                              // 窗口内峰值径向速率(km/s，带符号)
  const maxDopplerHz = maxAbsRR / C_KM_S * (freqGHz * 1e9);   // 峰值多普勒(Hz)
  const rA = Math.hypot(W.pA.x, W.pA.y, W.pA.z), rB = Math.hypot(W.pB.x, W.pB.y, W.pB.z);
  const cosC = Math.max(-1, Math.min(1, (W.pA.x * W.pB.x + W.pA.y * W.pB.y + W.pA.z * W.pB.z) / (rA * rB)));
  // 各星速度（worst 刻）：惯性系 + 相对地面（Earth-relative），复用 velocities(pv)；snapshot 无 satrec → null
  const worstDate = new Date(worst.ts * 1000);
  const _spd = (nd) => {
    if (!(nd.node.kind === 'sat' && nd.node.satrec)) return { speedInertial: null, speedGroundRel: null };
    const pv = propagateAt(nd.node.satrec, worstDate);
    return pv ? velocities(pv) : { speedInertial: null, speedGroundRel: null };
  };
  const spdA = _spd(A), spdB = _spd(B);
  const worstMetrics = {
    rangeKm: W.rangeKm, minRangeKm: (minR === Infinity ? null : minR),
    txAltKm: rA - RE_KM, rxAltKm: rB - RE_KM,
    txSpeedKmS: spdA.speedInertial, rxSpeedKmS: spdB.speedInertial,
    txGroundSpeedKmS: spdA.speedGroundRel, rxGroundSpeedKmS: spdB.speedGroundRel,
    grazAltKm: W.minCenterKm - RE_KM,
    centralAngleDeg: Math.acos(cosC) * RAD,
    rangeRateKmS, maxDopplerHz,
    oneWayDelayMs: W.rangeKm / C_KM_S * 1000,
    worstISO: worstDate.toISOString()
  };

  // 互视访问窗口：f(t) = 最近点离地心 − R_block（>0 可见）
  const fVis = (ts) => { const s = sampleAt(ts); return s ? (s.minCenterKm - blockRadiusKm) : NaN; };
  const raw = findWindows(fVis, startS, endS, { coarseStep: stepSec, tol: 1, findPeak: false });
  const windows = raw.map((w) => {
    let wMax = 0;
    for (let ts = w.start; ts <= w.end; ts += stepSec) { const s = sampleAt(ts); if (s && s.visible && s.rangeKm > wMax) wMax = s.rangeKm; }
    return {
      startISO: new Date(w.start * 1000).toISOString(), endISO: new Date(w.end * 1000).toISOString(),
      durationMin: (w.end - w.start) / 60, maxRangeKm: wMax || null,
      clipped: (w.start <= startS + 1e-3) || (w.end >= endS - 1e-3)
    };
  });
  const totalVisibleMin = windows.reduce((s, w) => s + w.durationMin, 0);

  return {
    feasible: true, method, representative,
    worst: worstMetrics,
    visibility: { visibleFrac, visibleMinutes: visibleFrac * windowMinutes, windowMinutes, totalWindows: windows.length, totalVisibleMin, windows, persistent: windows.length === 1 && windows[0].clipped && visibleFrac > 0.999 },
    elements: { tx: A.elements, rx: B.elements },
    search: { t0ISO: t0.toISOString(), horizonHours, stepSec, atmMarginKm, blockRadiusKm, freqGHz, t0Source: opts.t0ISO ? 'explicit' : 'epoch', representative }
  };
}

module.exports = {
  RE_KM, MU, OMEGA_E, C_KM_S, ECC_CIRCULAR_TOL,
  buildSatrec,
  solveAccessWindows,
  solveIslWorstCase,
  propagatorLabel,
  lookAngles,
  subPoint,
  staticElements,
  virtualElements,
  closedFormWorstSlant,
  maxElevForCircular,
  stationGeoRadiusKm,
  geocentricLatDeg,
  visMetricsFor,
  rangeRateKmS,
  closedFormWorst,
  coupledTypicalMoment,
  solveStaticGeometry,
  solveMutualWorstCase
};
