// PFD Mask · α 角 / ΔLong / 星心方位仰角 —— 纯几何
//
// 这一层是整个 mask 里【最容易静默出错】的地方。三类错都不会报错、图看着正常、数值全错：
//   ① α 符号写反        → mask 左右镜像
//   ② 拓扑角当地心角     → α 量级整体不对（低轨时差几倍）
//   ③ 星心 az/el 轴搞混  → mask 整体旋转 90°
// 所以本模块的每个量都配了退化算例（见 test/pfdMask.test.js 的 A 组），
// 并且把「地面落点」单独导出——铺到世界地图上肉眼查，是 ③ 唯一的探测器。
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据：ITU-R S.1503-4 正文逐段核对
//   §D6.4.4.1  α 的定义（GSO 弧上未被地球遮挡的测试点中夹角最小者）与符号规则
//   §D6.4.4.1  ΔLong = Long_Alpha − Long_NGSO；平局取 |ΔLong| 最小，再平局取正
//   §D6.4.4.2  α 搜索范围（可见弧段）
//   §D6.4.5    星心与站心方位仰角的坐标轴指向
//
// ★ 一处原文缺图导致的推断（必须由 ITU Mask Viewer 对拍定音）：
//   §D6.4.5 用文字给了卫星系三轴（X=东、Y=地心、Z=北）和 u=cos(el)cos(az)、v=cos(el)sin(az)，
//   但 az / el 各自从哪个轴量起，只画在 Figure 60 里，而该图在文本中不可得。
//   本实现按 AZEL_NADIR_CENTRED 约定：(az,el)=(0,0) 指天底、az 正向朝东、el 正向朝北。
//   依据是 ITU Mask Viewer 截图的轴范围——el 与 az 都是 ±68°，而 h=900 km 的地球边缘
//   天底半角 ρ₀ ≈ 55°，只有「两角都自天底量起」才能解释这个对称范围。
//   若日后对拍发现不符，改 AZEL_CONVENTION 一处即可，不必动其余代码。
// ─────────────────────────────────────────────────────────────────────────────

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// WGS84（与 packages/core/utils/interference/geometry.js 同源，避免引入第二套地球）
const A_KM = 6378.137;
const B_KM = 6356.7523142;
const F = (A_KM - B_KM) / A_KM;
const E2 = 2 * F - F * F;

/** GSO 轨道半径（km）。PMGT 界面 "a (km)" 的默认值即 42164.2。 */
const GSO_RADIUS_KM = 42164.2;

/** 星心 az/el 约定。见文件头注 ★。 */
const AZEL_CONVENTION = 'nadir-centred';

// ---------------------------------------------------------------------------
// 向量工具（局部，避免跨模块耦合）
// ---------------------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
function unit(a) { const n = norm(a); if (!(n > 0)) throw new RangeError('零矢量无法归一化'); return scale(a, 1 / n); }

// ---------------------------------------------------------------------------
// 基本坐标
// ---------------------------------------------------------------------------

/**
 * 大地坐标 → ECEF（km）。WGS84 椭球（D6 决策：不引入第二套地球模型）。
 * @param {number} lonDeg 经度（度，东正）
 * @param {number} latDeg 大地纬度（度，北正）
 * @param {number} [altKm=0] 海拔（**km**）
 */
function geodeticToEcefKm(lonDeg, latDeg, altKm) {
  const h = Number(altKm) || 0;
  const lat = Number(latDeg) * D2R, lon = Number(lonDeg) * D2R;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const N = A_KM / Math.sqrt(1 - E2 * sl * sl);
  return [(N + h) * cl * Math.cos(lon), (N + h) * cl * Math.sin(lon), (N * (1 - E2) + h) * sl];
}

/** ECEF（km）→ 大地坐标。Bowring 迭代，5 次足以收敛到 1e-9 度。 */
function ecefToGeodetic(p) {
  const x = p[0], y = p[1], z = p[2];
  const lon = Math.atan2(y, x);
  const r = Math.hypot(x, y);
  let lat = Math.atan2(z, r * (1 - E2));
  for (let i = 0; i < 5; i++) {
    const sl = Math.sin(lat);
    const N = A_KM / Math.sqrt(1 - E2 * sl * sl);
    lat = Math.atan2(z + E2 * N * sl, r);
  }
  const sl = Math.sin(lat);
  const N = A_KM / Math.sqrt(1 - E2 * sl * sl);
  const alt = Math.abs(Math.cos(lat)) > 1e-9 ? r / Math.cos(lat) - N : Math.abs(z) / Math.abs(sl) - N * (1 - E2);
  return { lonDeg: lon * R2D, latDeg: lat * R2D, altKm: alt };
}

/** 地表点的天顶单位矢量（椭球法线，非地心方向——两者在非赤道处差最多 0.19°）。 */
function upVector(lonDeg, latDeg) {
  const lat = Number(latDeg) * D2R, lon = Number(lonDeg) * D2R;
  const cl = Math.cos(lat);
  return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

/** GSO 弧上给定经度处的点（ECEF km）。GSO 恒在赤道面，z = 0。 */
function gsoPointEcef(lonDeg, radiusKm) {
  const R = radiusKm === undefined ? GSO_RADIUS_KM : Number(radiusKm);
  const lon = Number(lonDeg) * D2R;
  return [R * Math.cos(lon), R * Math.sin(lon), 0];
}

/**
 * 地表点看某目标的仰角（度）。用椭球法线作天顶，与 §D6.4.5 的站心 Z 轴一致。
 * @returns {number} 仰角（度），负值表示在地平线以下
 */
function elevationFrom(lonDeg, latDeg, altKm, targetEcef) {
  const es = geodeticToEcefKm(lonDeg, latDeg, altKm);
  const up = upVector(lonDeg, latDeg);
  const los = sub(targetEcef, es);
  const n = norm(los);
  if (!(n > 0)) return 90;
  return Math.asin(Math.max(-1, Math.min(1, dot(los, up) / n))) * R2D;
}

// ---------------------------------------------------------------------------
// §D6.4.4.2 —— 可见 GSO 弧范围
// ---------------------------------------------------------------------------

/**
 * 地表点能看到的 GSO 弧经度范围（仰角 ≥ minElevDeg 的那一段）。
 *
 * 原文 §D6.4.4.2 给了闭式，但该处公式在可得文本中残缺（希腊字母与上下标丢失），
 * 故此处按定义二分求解仰角零点——结果与闭式等价，代价是每次 ~40 次求值。
 *
 * @returns {{lonMinDeg:number, lonMaxDeg:number}|null} 完全不可见时返回 null
 */
function gsoVisibleArcRange(esLonDeg, esLatDeg, esAltKm, minElevDeg) {
  const minEl = minElevDeg === undefined ? 0 : Number(minElevDeg);
  const lat = Number(esLatDeg);
  // 纬度过高时 GSO 弧整体在地平线下
  if (Math.abs(lat) >= 90) return null;

  const elAt = (dLon) => elevationFrom(esLonDeg, esLatDeg, esAltKm, gsoPointEcef(Number(esLonDeg) + dLon)) - minEl;

  // 同经度处（dLon = 0）仰角最高；若这里都看不到，整条弧都看不到
  if (elAt(0) < 0) return null;

  // 向东、向西各二分找零点。GSO 弧的可见半宽 < 90°（几何上限）
  const bisect = (sign) => {
    let lo = 0, hi = 89.999;
    if (elAt(sign * hi) >= 0) return hi;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (elAt(sign * mid) >= 0) lo = mid; else hi = mid;
    }
    return lo;
  };
  const west = bisect(-1), east = bisect(+1);
  return { lonMinDeg: Number(esLonDeg) - west, lonMaxDeg: Number(esLonDeg) + east };
}

// ---------------------------------------------------------------------------
// §D6.4.4.1 —— α 的符号
// ---------------------------------------------------------------------------

/**
 * α 的符号（§D6.4.4.1 逐条实现）。
 *
 * 构造 R(t) = R_ES + t·R_EN，R_EN = R_NS − R_ES。
 * 该线穿 z = 0 平面于 t₀ = −R_ES.z / R_EN.z，交点 R₀ = R_ES + t₀·R_EN。
 *
 *   t₀ < 0                  ⇒ 视 |R₀| = ∞
 *   北半球： |R₀| < Rgeo ⇒ +1 ；= Rgeo ⇒ 0 ；> Rgeo 或 t₀ ≤ 0 ⇒ −1
 *   南半球： |R₀| > Rgeo ⇒ +1 ；= Rgeo ⇒ 0 ；< Rgeo 或 t₀ ≤ 0 ⇒ −1
 *   赤道：   取 R_EN.z 符号的【相反数】
 *
 * @param {number[]} esEcef  地球站/考察点 ECEF（km）
 * @param {number[]} satEcef 非 GSO 卫星 ECEF（km）
 * @param {number} esLatDeg  考察点纬度（判半球用）
 * @returns {-1|0|1}
 */
function alphaSign(esEcef, satEcef, esLatDeg, radiusKm) {
  const Rgeo = radiusKm === undefined ? GSO_RADIUS_KM : Number(radiusKm);
  const lat = Number(esLatDeg);
  const REN = sub(satEcef, esEcef);

  // 赤道特例：R_ES.z ≈ 0，t₀ 退化，原文单列一条规则
  const EQ_TOL_DEG = 1e-9;
  if (Math.abs(lat) < EQ_TOL_DEG) {
    if (Math.abs(REN[2]) < 1e-12) return 0;
    return REN[2] > 0 ? -1 : 1;          // “the negative of the sign of R_EN.z”
  }

  if (Math.abs(REN[2]) < 1e-12) return -1;   // 线与 z=0 平行且 ES 不在赤道 ⇒ 永不相交 ⇒ 视同 t₀≤0
  const t0 = -esEcef[2] / REN[2];
  if (!(t0 > 0)) return -1;

  const R0 = norm([esEcef[0] + t0 * REN[0], esEcef[1] + t0 * REN[1], 0]);
  const TOL = 1e-6;                          // km，判「恰在 GSO 半径上」
  if (Math.abs(R0 - Rgeo) < TOL) return 0;

  if (lat > 0) return R0 < Rgeo ? 1 : -1;
  return R0 > Rgeo ? 1 : -1;
}

// ---------------------------------------------------------------------------
// §D6.4.4.1 —— α 与 ΔLong
// ---------------------------------------------------------------------------

/**
 * α 角与 ΔLong。
 *
 * α = min over GSO 弧上【未被地球遮挡】的测试点 Pi 之（考察点→Pi 与 考察点→NGSO 星）夹角。
 * ★ 顶点在**地表考察点**，是【拓扑角】不是地心角——低轨时两者能差几倍。
 *
 * 求最小值：α(λ) 在可见弧段内单峰，故粗扫定位 + 黄金分割细化。
 * 精度默认 1e-6 度，远高于 mask 落盘的 0.01 度分辨率。
 *
 * @param {{lonDeg:number, latDeg:number, altKm?:number}} M 地表考察点
 * @param {number[]} satEcef 非 GSO 卫星 ECEF（km）
 * @param {object} [opt] {minElevDeg=0, coarseStepDeg=1, tolDeg=1e-6, radiusKm}
 * @returns {{alphaDeg:number, deltaLongDeg:number, gsoLonDeg:number, visible:boolean}|null}
 *          可见 GSO 弧为空时返回 null（该考察点看不到 GSO，α 无定义）
 */
function alphaAndDeltaLong(M, satEcef, opt) {
  const o = opt || {};
  const minEl = o.minElevDeg === undefined ? 0 : Number(o.minElevDeg);
  const coarse = o.coarseStepDeg === undefined ? 1 : Number(o.coarseStepDeg);
  const tol = o.tolDeg === undefined ? 1e-6 : Number(o.tolDeg);
  const Rgeo = o.radiusKm === undefined ? GSO_RADIUS_KM : Number(o.radiusKm);

  const lon = Number(M.lonDeg), lat = Number(M.latDeg), alt = Number(M.altKm) || 0;
  const range = gsoVisibleArcRange(lon, lat, alt, minEl);
  if (!range) return null;

  const es = geodeticToEcefKm(lon, lat, alt);
  const toSat = sub(satEcef, es);
  const nSat = norm(toSat);
  if (!(nSat > 0)) return null;
  const uSat = scale(toSat, 1 / nSat);

  // 考察点 → GSO(λ) 与 考察点 → NGSO 的夹角（度）
  const angAt = (gsoLon) => {
    const d = sub(gsoPointEcef(gsoLon, Rgeo), es);
    const n = norm(d);
    if (!(n > 0)) return 180;
    return Math.acos(Math.max(-1, Math.min(1, dot(d, uSat) / n))) * R2D;
  };

  // ── 粗扫：在可见弧段内找最小值所在的格
  let bestLon = range.lonMinDeg, bestAng = angAt(range.lonMinDeg);
  const span = range.lonMaxDeg - range.lonMinDeg;
  const nStep = Math.max(2, Math.ceil(span / coarse));
  for (let i = 1; i <= nStep; i++) {
    const L = range.lonMinDeg + span * (i / nStep);
    const a = angAt(L);
    if (a < bestAng) { bestAng = a; bestLon = L; }
  }

  // ── 黄金分割细化（单峰假设；区间取最小格的左右各一格，并夹在可见段内）
  const half = span / nStep;
  let lo = Math.max(range.lonMinDeg, bestLon - half);
  let hi = Math.min(range.lonMaxDeg, bestLon + half);
  const PHI = (Math.sqrt(5) - 1) / 2;
  let c = hi - PHI * (hi - lo), d2 = lo + PHI * (hi - lo);
  let fc = angAt(c), fd = angAt(d2);
  let guard = 0;
  while (hi - lo > tol && guard++ < 200) {
    if (fc < fd) { hi = d2; d2 = c; fd = fc; c = hi - PHI * (hi - lo); fc = angAt(c); }
    else { lo = c; c = d2; fc = fd; d2 = lo + PHI * (hi - lo); fd = angAt(d2); }
  }
  let lonAlpha = 0.5 * (lo + hi);
  let alphaMag = angAt(lonAlpha);
  // 端点可能就是最小（弧被地平线截断时），补比一次
  for (const L of [range.lonMinDeg, range.lonMaxDeg]) {
    const a = angAt(L);
    if (a < alphaMag) { alphaMag = a; lonAlpha = L; }
  }

  // ── ΔLong：§D6.4.4.1「Long = LongAlpha − LongNGSO」
  const sub2 = ecefToGeodetic(satEcef);
  let dLong = wrap180(lonAlpha - sub2.lonDeg);

  // 平局规则：同 α 取 |ΔLong| 最小；绝对值也相同则取正
  const twin = wrap180(-dLong);
  if (Math.abs(Math.abs(twin) - Math.abs(dLong)) < 1e-9 && twin > dLong) {
    const alt2 = wrap180(sub2.lonDeg + twin);
    if (Math.abs(angAt(alt2) - alphaMag) < 1e-9) dLong = twin;
  }

  const sign = alphaSign(es, satEcef, lat, Rgeo);
  return {
    alphaDeg: sign === 0 ? 0 : sign * alphaMag,
    deltaLongDeg: dLong,
    gsoLonDeg: wrap180(lonAlpha),
    visible: true,
  };
}

/** 归一到 (−180, 180]。 */
function wrap180(deg) {
  let d = Number(deg) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// ---------------------------------------------------------------------------
// §D6.4.5 —— 星心方位仰角
// ---------------------------------------------------------------------------

/**
 * 卫星本地正交基（ECEF 表示）。§D6.4.5：X=东、Y=地心(天底)、Z=北。
 * @returns {{east:number[], nadir:number[], north:number[]}}
 */
function satelliteBasis(satEcef) {
  const nadir = unit(scale(satEcef, -1));               // 指向地心
  const zAxis = [0, 0, 1];
  // 东 = ẑ × r̂（r̂ 为地心指向卫星的方向）；极点上方退化，回退到 X 轴
  const rHat = unit(satEcef);
  let east = [zAxis[1] * rHat[2] - zAxis[2] * rHat[1],
               zAxis[2] * rHat[0] - zAxis[0] * rHat[2],
               zAxis[0] * rHat[1] - zAxis[1] * rHat[0]];
  if (norm(east) < 1e-12) east = [1, 0, 0]; else east = unit(east);
  // 北 = 天底 × 东 的右手补全：north = east × nadir
  const north = unit([
    east[1] * nadir[2] - east[2] * nadir[1],
    east[2] * nadir[0] - east[0] * nadir[2],
    east[0] * nadir[1] - east[1] * nadir[0],
  ]);
  return { east, nadir, north };
}

/**
 * 星心方位仰角（§D6.4.5）。
 *
 * ★ 约定见文件头注：(az,el)=(0,0) 指天底，az 正向朝东，el 正向朝北。
 *   方向余弦： 天底分量 = cos(el)·cos(az)
 *              东分量   = cos(el)·sin(az)
 *              北分量   = sin(el)
 *   与原文给出的 u = cos(el)cos(az)、v = cos(el)sin(az) 一致（u≡天底、v≡东）。
 *
 * @returns {{azDeg:number, elDeg:number, u:number, v:number, offNadirDeg:number}}
 */
function satCentricAzEl(satEcef, targetEcef) {
  const B = satelliteBasis(satEcef);
  const los = unit(sub(targetEcef, satEcef));
  const cN = dot(los, B.nadir);      // 天底分量
  const cE = dot(los, B.east);       // 东分量
  const cZ = dot(los, B.north);      // 北分量
  const elRad = Math.asin(Math.max(-1, Math.min(1, cZ)));
  const azRad = Math.atan2(cE, cN);
  return {
    azDeg: azRad * R2D,
    elDeg: elRad * R2D,
    u: Math.cos(elRad) * Math.cos(azRad),
    v: Math.cos(elRad) * Math.sin(azRad),
    offNadirDeg: Math.acos(Math.max(-1, Math.min(1, cN))) * R2D,
  };
}

/** 由星心 (az, el) 造出该方向的单位矢量（ECEF）。satCentricAzEl 的逆。 */
function dirFromSatAzEl(satEcef, azDeg, elDeg) {
  const B = satelliteBasis(satEcef);
  const az = Number(azDeg) * D2R, el = Number(elDeg) * D2R;
  const cN = Math.cos(el) * Math.cos(az), cE = Math.cos(el) * Math.sin(az), cZ = Math.sin(el);
  return unit([
    B.nadir[0] * cN + B.east[0] * cE + B.north[0] * cZ,
    B.nadir[1] * cN + B.east[1] * cE + B.north[1] * cZ,
    B.nadir[2] * cN + B.east[2] * cE + B.north[2] * cZ,
  ]);
}

/**
 * 星心 (az, el) 方向射线与 WGS84 椭球的**近端**交点。视场外返回 null。
 *
 * 闭式：把射线代入椭球方程得关于 t 的二次式（对 z 分量按 (A/B)² 缩放化成球问题）。
 * @returns {{ecef:number[], lonDeg:number, latDeg:number, rangeKm:number, elevDeg:number}|null}
 */
function groundPointFromAzEl(satEcef, azDeg, elDeg) {
  const d = dirFromSatAzEl(satEcef, azDeg, elDeg);
  return rayEllipsoidHit(satEcef, d);
}

/** 射线（起点 o、单位方向 d）与 WGS84 的近端交点。 */
function rayEllipsoidHit(o, d) {
  const k = A_KM / B_KM;                 // 把 z 缩放成球
  const ox = o[0], oy = o[1], oz = o[2] * k;
  const dx = d[0], dy = d[1], dz = d[2] * k;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - A_KM * A_KM;
  const disc = b * b - 4 * a * c;
  if (!(disc >= 0)) return null;         // 射线不与地球相交（指向天空）
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  const t = t1 > 0 ? t1 : (t2 > 0 ? t2 : null);
  if (t === null) return null;
  const p = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
  const g = ecefToGeodetic(p);
  return {
    ecef: p, lonDeg: g.lonDeg, latDeg: g.latDeg, rangeKm: t,
    elevDeg: elevationFrom(g.lonDeg, g.latDeg, 0, o),
  };
}

/**
 * 由地面最小仰角 ε₀ 反推星上最大天底半角 ρ₀（度）。
 *   sin ρ₀ = (Re·cos ε₀) / (Re + h)
 * 用球半径 A_KM——mask 的角轴范围只需这个量级的精度，且与椭球版差 < 0.03°。
 */
function nadirHalfAngle(satAltKm, minElevDeg) {
  const h = Number(satAltKm), e0 = Number(minElevDeg) * D2R;
  if (!(h > 0)) throw new RangeError(`nadirHalfAngle: 卫星高度必须为正（${satAltKm}）`);
  const s = (A_KM * Math.cos(e0)) / (A_KM + h);
  if (!(s >= -1 && s <= 1)) throw new RangeError('nadirHalfAngle: 几何无解');
  return Math.asin(s) * R2D;
}

/** 由卫星高度与倾角定 mask 纬度轴上限。逆行轨道（i>90°）时真实纬度上限是 180−i。 */
function latMaxFromInclination(incDeg) {
  const i = Math.abs(Number(incDeg)) % 360;
  const ii = i > 180 ? 360 - i : i;
  return Math.min(ii, 180 - ii);
}

module.exports = {
  A_KM, B_KM, E2, GSO_RADIUS_KM, AZEL_CONVENTION,
  geodeticToEcefKm, ecefToGeodetic, upVector, gsoPointEcef, elevationFrom, wrap180,
  gsoVisibleArcRange, alphaSign, alphaAndDeltaLong,
  satelliteBasis, satCentricAzEl, dirFromSatAzEl, groundPointFromAzEl, rayEllipsoidHit,
  nadirHalfAngle, latMaxFromInclination,
};
