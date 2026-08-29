// instantAtten.js — 瞬时链路劣化（实时 / 预报分支的计算内核）
//
// 与 rainAttenuation.js 是**并列**关系，不是它的一个选项：
//   rainAttenuation.js  输入 R0.01% + 可用度 p  →  输出「年 p% 时间不超过的衰减」（气候统计量）
//   instantAtten.js     输入某一时刻的大气状态 →  输出「该时刻的衰减」（瞬时量）
// 两者共用的只有下面这层纯物理函数（P.676 气体 / P.838 系数 / P.839 雨高 / P.840 云 / 几何），
// 入口与出参结构刻意不同：本模块的结果对象里根本没有 availability / downtime 这类键，
// 界面想显示也取不到 —— 口径混用在数据结构上就被堵死。
//
// ── 算法分层（哪一步严格、哪一步是模型）─────────────────────────────────────
// 严格的那一半：
//   · 气体吸收   P.676-13，把 Ps/Ts/ρ 三个入参换成实测值即可，函数体一行不改。这一项没有口径问题。
//   · 比衰减     γ_R = k·R^α（P.838-3）。k/α 由雨滴谱与 Mie 散射拟合而来，**本来就是瞬时关系**，
//                对任意时刻的雨强都成立。统计口径从来不在这一步进来。
//   · 闪烁 σ     P.618-14 §2.4.1 步骤 1~6。N_wet 由实测 T/湿度按 P.453 算出，
//                替掉引擎里全球写死的 42（见 linkCalculator.js 的同名函数）。
// 是模型的那一半：
//   · **路径积分**。手上是地面（或一格）的雨强，要的是 ∫γ_R dl。这一步没有唯一正确答案，
//     故做成显式旋钮 pathModel，四档各自的含义写在 PATH_MODELS 里，不藏假设。
//
// ── 诚实边界 ──────────────────────────────────────────────────────────────
//   · 数值预报/融合产品给的是**地面**降水率，不是雷达反演的三维雨场；再好的路径模型也是
//     「由地面推三维」。垂直方向沿用 P.618 的老假设：雨高以下柱内雨强均匀。
//   · 栅格本身已在 0.25°~0.5°（28~55 km）上被空间平滑过，而对流雨胞尺度是 1~10 km，
//     故成图的峰值必然**低于**真实峰值。偏差方向是确定的，UI 应当照实说。
//   · 云衰这一项：常见天气 API 只给云量百分比，推不出柱液态水。故默认走 P.840 统计值，
//     云量只作读数不入算 —— 不编造。
//
// 纯 JS、无 IO、无 Vue/DOM，可离线单测。

const lc = require('./linkCalculator.js');
const { getIsothermHeight } = require('./isothermHeight.js');
const met = require('./metSnapshot.js');

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const RE_EFF = 8500;          // 等效地球半径 km（与 linkCalculator 低仰角分支同一常数）
const RE_GEOM = 6371.0;       // 球面推点用的地球半径 km
const HR_OFFSET = 0.36;       // P.618-14 §2.2.1.1 雨高 hR = h0 + 0.36 km

// 路径模型四档。default 'uniform'。
//   uniform  L_eff = L_s，整条雨层路径取本格雨强。
//            ★ 这不是「保守上界」而是格距 ≫ 路径水平投影时的自然结果：GEO 在国内仰角 30~50°，
//              雨层厚约 4 km → L_G 只有 4~7 km，而 0.5° 格约 40 km —— 整条路径就在一个格子里。
//   field    沿栅格雨场逐段积分。只有当 L_G 与格距可比（低仰角，或加密到 0.1°）时才带来新信息；
//            否则自动退化成 uniform，并在 warn 里说明，不假装更准。
//   p618     借 P.618-14 的水平/垂直折减因子（r0.01 · v0.01）。★ 那是**长期统计**下的路径缩减，
//            用在瞬时量上属口径外用，会显著压低结果。留这一档是为了与统计分支对照，须标注。
//   manual   直接给有效路径长度（有本站雷达或历史标定时用）。
const PATH_MODELS = ['uniform', 'field', 'p618', 'manual'];

// —— 通用站星几何（WGS-84）——————————————————————————————————————————
// GEO 定点走的是 lc.calculateSatelliteAngle 那条闭式（球面 + Re/(Re+h)=0.15127），与链路预算 GSO
// 那条链同源。但**任意轨道**表达不出来：LEO/MEO/HEO 与倾斜 GSO 的星下点跑到赤道以外，高度也不是
// 35786 km。故这里另给一条通用路 —— 站与星各按 WGS-84 转 ECEF，再投到站心地平坐标系。
// 与 vendor/satellite.js 的 ecfToLookAngles 逐字同式（见 instantAtten.test.js 的对拍），即与 NGSO
// 链路预算、可见性分析用的是同一套几何：平台里只有「GEO 闭式」与「WGS-84 通用」这两条，没有第三条。
const WGS84_A = 6378.137;                 // 赤道半径 km
const WGS84_E2 = 6.694379990141316e-3;    // 第一偏心率平方 e² = f(2−f)
const GEO_ALT_KM = 35786.063;             // 静止轨道高度（42164.2 − Re），仅用于把轨位折成星下点

/** 大地坐标 → 地固直角坐标（km）。高度是**椭球面以上**的大地高，与 SGP4 出参的 height 同口径 */
function geodeticToEcef(latDeg, lonDeg, altKm) {
  const lat = latDeg * D2R, lon = lonDeg * D2R;
  const s = Math.sin(lat), c = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  return {
    x: (N + altKm) * c * Math.cos(lon),
    y: (N + altKm) * c * Math.sin(lon),
    z: (N * (1 - WGS84_E2) + altKm) * s
  };
}

/**
 * 站 → 星的仰角 / 方位角 / 斜距。两端都用大地坐标给（星端＝星下点 + 轨道高度）。
 * @param {object} obs { lat, lon, altKm }
 * @param {object} satPos { lat, lon, altKm }
 * @returns { elevation, azimuth, rangeKm }；仰角为负即星在地平线以下（调用方自行判可见）
 */
function lookAngles(obs, satPos) {
  const o = geodeticToEcef(Number(obs.lat), Number(obs.lon), Number(obs.altKm) || 0);
  const s = geodeticToEcef(Number(satPos.lat), Number(satPos.lon), Number(satPos.altKm));
  const rx = s.x - o.x, ry = s.y - o.y, rz = s.z - o.z;
  const lat = Number(obs.lat) * D2R, lon = Number(obs.lon) * D2R;
  const sLat = Math.sin(lat), cLat = Math.cos(lat), sLon = Math.sin(lon), cLon = Math.cos(lon);
  const topS = sLat * cLon * rx + sLat * sLon * ry - cLat * rz;   // 南
  const topE = -sLon * rx + cLon * ry;                            // 东
  const topZ = cLat * cLon * rx + cLat * sLon * ry + sLat * rz;   // 天顶
  const rangeKm = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const elevation = rangeKm > 0 ? Math.asin(Math.max(-1, Math.min(1, topZ / rangeKm))) * R2D : 0;
  const azimuth = ((Math.atan2(-topE, topS) * R2D + 180) % 360 + 360) % 360;
  return { elevation, azimuth, rangeKm };
}

/** 星位入参规整：{lat,lon,altKm} 齐全且高度为正才算数，否则按「没给」处理（不静默当成 0 km） */
function normSatPos(v) {
  if (!v) return null;
  const lat = Number(v.lat), lon = Number(v.lon), altKm = Number(v.altKm);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altKm) || altKm <= 0) return null;
  if (lat < -90 || lat > 90) return null;
  return { lat, lon, altKm };
}

/** GEO 轨位 → 星下点。仅供斜距等读数用；仰角/方位角仍走闭式，以免与 GSO 那条链的数对不上 */
const geoSatPos = (satLon) => ({ lat: 0, lon: Number(satLon), altKm: GEO_ALT_KM });

/** 球面上从 (lat,lon) 沿方位角 brg 走 distKm 的落点 */
function destPoint(latDeg, lonDeg, brgDeg, distKm) {
  const d = distKm / RE_GEOM, br = brgDeg * D2R;
  const lat1 = latDeg * D2R, lon1 = lonDeg * D2R;
  const sinLat2 = Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * sinLat2);
  return { lat: lat2 * R2D, lon: ((lon2 * R2D + 540) % 360) - 180 };
}

/** 雨层内的斜路径长 L_s（km）。与 calculateSinglePathRainAttenuation 步骤 3 逐字同式 */
function slantRainPath(hRkm, altKm, elevDeg) {
  const dh = hRkm - altKm;
  if (!(dh > 0)) return 0;
  const el = elevDeg * D2R, s = Math.sin(el);
  if (elevDeg >= 5) return dh / s;
  return (2 * dh) / (Math.sqrt(s * s + 2 * dh / RE_EFF) + s);
}

/**
 * 瞬时链路劣化。
 *
 * @param {object} p
 *   lat, lon           站址（度）
 *   altKm              海拔（km）
 *   freq               频率（GHz）
 *   pol                'V' | 'H' | 'C'
 *   elevation          仰角（度）。给了 satLon 可缺省，由其反算
 *   azimuth            方位角（度）。field 档需要；给了 satLon 可缺省
 *   satLon             GEO 定点经度（度，选填）——走与链路预算 GSO 同源的球面闭式
 *   satPos             任意轨道的星下点与高度 { lat, lon, altKm }（选填）——走 WGS-84 通用几何
 *   met                MetSnapshot（见 metSnapshot.js）
 *   pathModel          见 PATH_MODELS，默认 'uniform'
 *   leffKm             pathModel='manual' 时的有效路径长度
 *   rainAt             pathModel='field' 时的取样器 (lat,lon) => mm/h（当前帧的栅格）
 *   gridStepDeg        栅格格距（度），用于判断 field 档是否有意义
 *   cloudMode          'none' | 'p840' | 'measured' | 'manual'，默认 'p840'
 *   cloudP             cloudMode='p840' 时的时间百分比（%），默认 1
 *   cloudLKgM2         cloudMode='measured'/'manual' 时的柱液态水（kg/m²）
 *   diameter           天线口径（m），闪烁用
 *   efficiency         天线效率（%），闪烁用
 * @returns {object} 扁平结果（number；UI/导出负责格式化），无法计算时 { error, message }
 */
function computeInstant(p) {
  p = p || {};
  const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  const lat = num(p.lat), lon = num(p.lon);
  const freq = num(p.freq);
  const altKm = num(p.altKm, 0);
  const pol = String(p.pol || 'C').toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: true, message: '缺少经纬度' };
  if (!Number.isFinite(freq) || freq <= 0) return { error: true, message: '缺少有效频率' };

  // —— 几何：三条来路，「给得越具体越优先」——
  //   ① elevation/azimuth 直接给：逐格成图时由调用方先算好回填（省掉每格重算，且可先判可见再决定跑不跑引擎）
  //   ② satPos {lat,lon,altKm}：任意轨道的星下点 + 高度 → WGS-84 通用几何（LEO/MEO/HEO/倾斜 GSO）
  //   ③ satLon：GEO 定点经度 → 与链路预算 GSO 那条链同源的闭式
  // ★ ②③ 是两套几何而不是一套的两种写法，故不互相折算：把轨位折成星下点再走 ② 会与 GSO 链路预算
  //   的仰角差出 0.1° 量级（球面 vs 椭球）。填哪个就按哪条算，出参 geomModel 里写明用的是哪条。
  let elevation = num(p.elevation), azimuth = num(p.azimuth);
  let rangeKm = num(p.rangeKm);
  const satPos = normSatPos(p.satPos);
  const satLon = num(p.satLon);
  let geomModel = Number.isFinite(elevation) ? 'given' : '';
  if (!Number.isFinite(elevation) || !Number.isFinite(azimuth)) {
    if (satPos) {
      const g = lookAngles({ lat, lon, altKm }, satPos);
      if (!Number.isFinite(elevation)) elevation = g.elevation;
      if (!Number.isFinite(azimuth)) azimuth = g.azimuth;
      if (!Number.isFinite(rangeKm)) rangeKm = g.rangeKm;
      geomModel = geomModel || 'wgs84';
    } else if (Number.isFinite(satLon)) {
      try {
        const g = lc.calculateSatelliteAngle(lat, lon, satLon);
        if (!Number.isFinite(elevation)) elevation = g.elevation;
        if (!Number.isFinite(azimuth)) azimuth = g.azimuth;
        if (!Number.isFinite(rangeKm)) rangeKm = lookAngles({ lat, lon, altKm }, geoSatPos(satLon)).rangeKm;
        geomModel = geomModel || 'geo';
      } catch (e) { /* 落到下面的缺仰角分支 */ }
    }
  }
  if (!Number.isFinite(elevation)) return { error: true, message: '缺少仰角（直接填仰角，或给出 GEO 轨位 / 星下点与轨道高度）' };
  // 星在地平线以下：这一格对该星根本没有链路，不出衰减数（画图时该留空，不该画成 0 dB）
  if (elevation <= 0) return { error: true, message: '该点对此卫星仰角 ≤ 0°（不可见）', elevation };

  // —— 气象派生量 ——
  const d = met.derive(p.met, altKm);
  const warn = d.warn.slice();

  // ① 气体吸收（P.676-13）：三个大气参数全部换成实测值
  const gasDb = lc.calculateAtmosphericAttenuation(freq, elevation, d.psHpa, d.tsK, d.rho);

  // ② 雨衰（P.838 比衰减 × 路径模型）
  const h0 = getIsothermHeight(lat, lon);
  const hR = h0 + HR_OFFSET;
  const Ls = slantRainPath(hR, altKm, elevation);
  const LG = Ls * Math.cos(elevation * D2R);
  const [kc, alpha] = lc.getCoefficients(freq, pol, elevation);
  const R0 = d.rainMmH;
  const gamma0 = R0 > 0 ? kc * Math.pow(R0, alpha) : 0;

  let pathModel = PATH_MODELS.indexOf(String(p.pathModel)) >= 0 ? String(p.pathModel) : 'uniform';
  let leff = 0, rainDb = 0;

  if (!d.rainOk) {
    rainDb = null;                       // 雪 / 冰 / 混合：不硬算（判据见 metSnapshot.rainModelApplies）
  } else if (Ls <= 0) {
    rainDb = 0;                          // 站址高于雨高（P.618-14 Step 2）
    warn.push('站址海拔高于雨高，路径不穿过雨层');
  } else if (R0 <= 0 && pathModel !== 'field') {
    rainDb = 0;                          // 本格无雨；field 档仍要扫，路径上别处可能有雨
  } else {
    if (pathModel === 'manual') {
      leff = Math.max(0, num(p.leffKm, 0));
      rainDb = gamma0 * leff;
    } else if (pathModel === 'p618') {
      // 借统计折减：r0.01（水平）与 v0.01（垂直），与 P.618-14 步骤 6~8 同式
      const el = elevation * D2R;
      const r = 1 / (1 + 0.78 * Math.sqrt(LG * gamma0 / freq) - 0.38 * (1 - Math.exp(-2 * LG)));
      const zeta = Math.atan((hR - altKm) / (LG * r));
      const LR = zeta > el ? (LG * r / Math.cos(el)) : ((hR - altKm) / Math.sin(el));
      const chi = Math.abs(lat) < 36 ? (36 - Math.abs(lat)) : 0;
      const term = 31 * (1 - Math.exp(-elevation / (1 + chi))) * Math.sqrt(LR * gamma0) / (freq * freq);
      const v = 1 / (1 + Math.sqrt(Math.sin(el)) * (term - 0.45));
      leff = LR * v;
      rainDb = gamma0 * leff;
      // ★ 实测（2026-08-29）：v0.01 在小到中雨时【大于 1】——12.5 GHz / 45° / 5 mm/h 下 L_eff 是
      //   L_s 的 1.26 倍，30 GHz / 5 mm/h 达 1.43 倍；只有大雨（Ku 约 >25 mm/h）才落到 1 以下。
      //   即这一档**在两个方向上都不是界**：它是一条按 0.01% 超越统计标定出来的拟合修正，
      //   把它套在瞬时雨强上，小雨会被抬高四成。故它不能做缺省，只能当「与统计分支对照」用。
      warn.push(`路径模型「统计折减」：r0.01/v0.01 按 0.01% 超越统计标定，用于瞬时值属口径外用（本例 L_eff/L_s = ${(leff / Ls).toFixed(2)}，>1 表示被抬高而非折减）`);
    } else if (pathModel === 'field' && typeof p.rainAt === 'function') {
      // 沿栅格雨场逐段积分。步长取 min(半个格距, Ls/8)，至少 4 段。
      const step = Math.max(0.25, Math.min(Ls / 8, Math.max(0.25, num(p.gridStepDeg, 0.5) * 111 / 2)));
      const n = Math.max(4, Math.ceil(Ls / step));
      const dl = Ls / n;
      const cosEl = Math.cos(elevation * D2R);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const l = (i + 0.5) * dl;                       // 段心
        const g = destPoint(lat, lon, azimuth, l * cosEl);
        const Ri = Math.max(0, Number(p.rainAt(g.lat, g.lon)) || 0);
        if (Ri > 0) acc += kc * Math.pow(Ri, alpha) * dl;
      }
      rainDb = acc;
      leff = gamma0 > 0 ? acc / gamma0 : 0;
      // 路径水平投影远小于半个格距时，积分结果必然等于本格值 —— 说清楚，别让人以为这一档更准
      if (LG < num(p.gridStepDeg, 0.5) * 111 / 2) {
        warn.push(`路径水平投影 ${LG.toFixed(1)} km 小于半个格距，逐段积分与「均匀」档等价`);
      }
      if (!Number.isFinite(azimuth)) warn.push('缺方位角，逐段积分退回本格取值');
    } else {
      if (pathModel === 'field') { pathModel = 'uniform'; warn.push('未提供栅格取样器，路径模型退回「均匀」'); }
      leff = Ls;
      rainDb = gamma0 * leff;
    }
  }

  // ③ 云衰
  //   p840      柱液态水取 P.840 的**统计**分布（给定超越概率 p）。数据源只给云量百分比时只能走这档。
  //   measured  柱液态水取**实测/预报值**（数值预报模式直接输出柱云水 kg/m²）。
  //   manual    同上，但 L 由调用方直接给（本站微波辐射计等）。
  //   ★ measured 与 manual 算式逐字相同，分成两个名字只为让出参 r.cloudMode 自己说清 L 从哪来 ——
  //     「统计值」与「这一时刻的实测值」是两个口径，混在一个名字里事后无从追溯。
  const cloudMode = ['none', 'p840', 'manual', 'measured'].indexOf(String(p.cloudMode)) >= 0 ? String(p.cloudMode) : 'p840';
  let cloudDb = 0;
  if (cloudMode === 'p840') {
    cloudDb = lc.calculateCloudAttenuation(freq, elevation, Math.max(1, num(p.cloudP, 1)), lat, lon);
  } else if (cloudMode === 'manual' || cloudMode === 'measured') {
    const L = Math.max(0, num(p.cloudLKgM2, 0));
    // P.840 §3：A_c = L·Kl(f, T=273.15K) / sinθ（云内温度取 0 °C，与 P.840 附注一致）
    cloudDb = L * lc.cloudSpecificAttenuation(freq, 273.15) / Math.sin(elevation * D2R);
  }

  // ④ 闪烁（P.618-14 §2.4.1）：N_wet 走实测。
  // ★ σ 才是瞬时分支该报的量 —— 闪烁是围绕平均电平的**起伏**，不是一个固定的衰减台阶。
  //   既有函数返回 a(p)·σ，而 p=1% 时 a(p)=3.0（log10(1)=0 代入式(48)），故 σ = A(p=1%)/3，
  //   不必复制步骤 1~6 的代码。深度按用户口径自取，这里同时给出 σ 与 1% 深度两个数。
  const nw = Number.isFinite(d.nWet) ? d.nWet : undefined;
  const diameter = num(p.diameter, 1), eff = num(p.efficiency, 60) / 100;
  const scintDb1 = lc.calculateScintillationFading(freq, elevation, diameter, 99, eff, nw);
  const scintSigmaDb = scintDb1 / 3;

  // 合计：气体 + 云 + 雨。闪烁是起伏不是台阶，**不并进合计**，单列。
  // （雪/冰时 rainDb 为 null —— 合计随之为 null，不拿 0 顶替。）
  const totalDb = rainDb == null ? null : (gasDb + cloudDb + rainDb);

  return {
    elevation, azimuth: Number.isFinite(azimuth) ? azimuth : null,
    rangeKm: Number.isFinite(rangeKm) ? rangeKm : null, geomModel,
    gasDb, rainDb, cloudDb, totalDb,
    scintSigmaDb, scintDb1pct: scintDb1,
    gammaR: gamma0, kCoef: kc, alphaCoef: alpha,
    rainMmH: R0, precipType: (p.met && p.met.precipType) || 'none', rainOk: d.rainOk,
    h0, hR, Ls, LG, leffKm: leff, pathModel,
    rho: d.rho, nWet: d.nWet, psHpa: d.psHpa, tsK: d.tsK, e: d.e,
    tMs: (p.met && p.met.t) || 0, kind: (p.met && p.met.kind) || 'obs', src: (p.met && p.met.src) || '',
    warn
  };
}

module.exports = {
  computeInstant, PATH_MODELS, slantRainPath, destPoint, HR_OFFSET,
  // 通用站星几何（任意轨道）。liveField 逐格成图时直接用它先判可见，再决定要不要跑整套引擎。
  lookAngles, geodeticToEcef, normSatPos, geoSatPos, GEO_ALT_KM
};
