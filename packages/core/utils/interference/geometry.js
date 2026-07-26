// 干扰分析 · 几何层
//
// 干扰计算里几乎所有的错，都错在角度上——把「邻星轨位差」当成了地球站看两颗星的夹角。
// 拓扑角恒大于经度差，且永远不相等——因为站点比地心离同步弧更近，看过去被放大了。
// 放大倍率在星下点最大（42164/35786 ≈ 1.178），随离轴变远而减小：
//     北京(39.9°N,116.4°E) 看 110.5°E 与 113°E：经度差 2.500° → 拓扑角 2.810°（×1.124）
//     赤道 110.5°E 正下方 看同样两颗星：             2.500° → 拓扑角 2.945°（×1.178）
// 而地球站离轴增益是 25·lgφ 量级的斜率——2.5° 处 0.31° 的角度误差就是 1.2 dB 的鉴别度误差，
// 直接落进 C/ASI。拿经度差当角度用，C/ASI 会系统性偏乐观。
//
// 故本模块的第一职责：把「站 + 两颗星」变成一个可信的角度。链路预算引擎里那个默认 2.5°
// 且无 UI 的 deltaTheta 是经度差近似，本模块一概不用。
//
// 坐标口径：WGS84 椭球 + ECEF，与 src/viz/wgs84.js、utils/grdSampler.js 同源（GRD 方向图
// 的投影几何已按这套校验到 boresight 完全一致，见 docs/GRD格式解析说明.txt）。GEO 星按
// 赤道面圆轨道处理（r = 42164.17 km），不含摄动——邻星轨位本就是标称值，给到 0.01° 已远
// 超输入精度。

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// WGS84
const A_KM = 6378.137;                 // 长半轴
const B_KM = 6356.7523142;             // 短半轴
const F = (A_KM - B_KM) / A_KM;
const E2 = 2 * F - F * F;

// 同步轨道半径：μ = 398600.4418 km³/s²，恒星日 86164.0905 s → a = (μT²/4π²)^(1/3)
const GSO_RADIUS_KM = 42164.17;

const C_KM_S = 299792.458;

// ---------------------------------------------------------------------------
// 基础矢量
// ---------------------------------------------------------------------------
const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const norm = (p) => Math.hypot(p[0], p[1], p[2]);
function unit(p) {
  const n = norm(p);
  return n > 0 ? [p[0] / n, p[1] / n, p[2] / n] : [0, 0, 0];
}

// ---------------------------------------------------------------------------
// 坐标变换
// ---------------------------------------------------------------------------

/** WGS84 大地坐标 → ECEF（km）。altKm 为椭球面以上高度。 */
function geodeticToEcef(lonDeg, latDeg, altKm) {
  const lon = (Number(lonDeg) || 0) * DEG;
  const lat = (Number(latDeg) || 0) * DEG;
  const h = Number(altKm) || 0;
  const N = A_KM / Math.sqrt(1 - E2 * Math.sin(lat) * Math.sin(lat));
  return [
    (N + h) * Math.cos(lat) * Math.cos(lon),
    (N + h) * Math.cos(lat) * Math.sin(lon),
    (N * (1 - E2) + h) * Math.sin(lat)
  ];
}

/**
 * GEO 卫星 ECEF（km）。赤道面圆轨道，只由定点经度决定。
 * 倾斜同步轨道（IGSO / 有倾角残余的老星）请走 satEcefFromSubPoint。
 */
function gsoEcef(lonDeg) {
  const lon = (Number(lonDeg) || 0) * DEG;
  return [GSO_RADIUS_KM * Math.cos(lon), GSO_RADIUS_KM * Math.sin(lon), 0];
}

/** 由星下点 + 轨道高度给卫星 ECEF（km）——供 IGSO / 快照星 / NGSO 瞬时位置共用。 */
function satEcefFromSubPoint(lonDeg, latDeg, altKm) {
  // 卫星在星下点的天顶方向上，故用地心距而非椭球高：取星下点椭球面点的地心距 + 高度。
  const surf = geodeticToEcef(lonDeg, latDeg, 0);
  const r = norm(surf) + (Number(altKm) || 0);
  return unit(surf).map((c) => c * r);
}

/** 站点处的当地天顶单位矢量（ECEF）。 */
function upVector(lonDeg, latDeg) {
  const lon = (Number(lonDeg) || 0) * DEG;
  const lat = (Number(latDeg) || 0) * DEG;
  const cl = Math.cos(lat);
  return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

// ---------------------------------------------------------------------------
// 视线角
// ---------------------------------------------------------------------------

/**
 * 站 → 星 的仰角 / 方位角 / 斜距。
 * @param {{lon:number,lat:number,alt?:number}} st 站址（alt 单位 m，与链路预算入参一致）
 * @param {number[]} satEcef 卫星 ECEF（km）
 * @returns {{elevDeg:number, azDeg:number, rangeKm:number}}
 */
function lookAngles(st, satEcef) {
  const lon = Number(st.lon) || 0, lat = Number(st.lat) || 0;
  const P = geodeticToEcef(lon, lat, (Number(st.alt) || 0) / 1000);
  const los = sub(satEcef, P);
  const rangeKm = norm(los);
  if (!(rangeKm > 0)) return { elevDeg: 0, azDeg: 0, rangeKm: 0 };
  const e = unit(los);
  const up = upVector(lon, lat);
  // 当地东/北（右手系：东 = 天顶 × 北极方向的投影）
  const lonR = lon * DEG, latR = lat * DEG;
  const east = [-Math.sin(lonR), Math.cos(lonR), 0];
  const north = [-Math.sin(latR) * Math.cos(lonR), -Math.sin(latR) * Math.sin(lonR), Math.cos(latR)];
  const sinEl = dot(e, up);
  const elevDeg = Math.asin(Math.max(-1, Math.min(1, sinEl))) * RAD;
  let azDeg = Math.atan2(dot(e, east), dot(e, north)) * RAD;
  if (azDeg < 0) azDeg += 360;
  return { elevDeg, azDeg, rangeKm };
}

/**
 * 拓扑角：站点视角下两颗星的真实夹角（度）。
 * 这就是地球站离轴方向图该吃的那个 φ——不是经度差。
 */
function topocentricAngle(st, satEcefA, satEcefB) {
  const P = geodeticToEcef(Number(st.lon) || 0, Number(st.lat) || 0, (Number(st.alt) || 0) / 1000);
  const a = unit(sub(satEcefA, P));
  const b = unit(sub(satEcefB, P));
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  return Math.acos(c) * RAD;
}

// 注：曾有一个 boresightOffset()（主轴切平面 gnomonic 投影，给「绕主轴的极坐标视图」用）。
// 该视图与全天半球图已于 2026-07-26 删除——两张图都只表达角度、表达不了增益，而 C/ASI 的
// 物理全在增益上；干扰几何一律走方向图切面（下行）与离轴 EIRP 密度曲线（上行）。函数随之删去。

// ---------------------------------------------------------------------------
// GEO 专用便捷封装
// ---------------------------------------------------------------------------

/**
 * 「站 + 期望星轨位 + 干扰星轨位」→ 一次给齐 C/ASI 需要的全部几何。
 *
 * lonDiffDeg 一并回传，纯为在 UI 上与 thetaDeg 并列显示——让使用者看见这两个数不一样，
 * 而不是继续拿经度差当角度用。
 *
 * @returns {{thetaDeg, lonDiffDeg, wanted:{elevDeg,azDeg,rangeKm}, interferer:{...}, visible:boolean}}
 */
function gsoSeparation(st, lonWantedDeg, lonInterfererDeg) {
  const sw = gsoEcef(lonWantedDeg);
  const si = gsoEcef(lonInterfererDeg);
  const wanted = lookAngles(st, sw);
  const interferer = lookAngles(st, si);
  let d = Math.abs((Number(lonInterfererDeg) || 0) - (Number(lonWantedDeg) || 0)) % 360;
  if (d > 180) d = 360 - d;
  return {
    thetaDeg: topocentricAngle(st, sw, si),
    lonDiffDeg: d,
    wanted,
    interferer,
    // 干扰星在地平线以下就打不到这面天线——整条干扰路径应当整个剔除，而不是照算一个数。
    visible: interferer.elevDeg > 0
  };
}

// ---------------------------------------------------------------------------
// 传播
// ---------------------------------------------------------------------------

/** 自由空间损耗（dB）。freqGHz、rangeKm。 */
function fsl(rangeKm, freqGHz) {
  const d = Number(rangeKm), f = Number(freqGHz);
  if (!(d > 0) || !(f > 0)) return 0;
  // 32.44778 = 20·lg(4π/c) 以 km·GHz 为单位时的常数（c = 299792.458 km/s）
  return 20 * Math.log10(d) + 20 * Math.log10(f) + 92.44778322;
}

module.exports = {
  DEG, RAD, A_KM, B_KM, E2, GSO_RADIUS_KM, C_KM_S,
  sub, dot, norm, unit,
  geodeticToEcef, gsoEcef, satEcefFromSubPoint, upVector,
  lookAngles, topocentricAngle, gsoSeparation, fsl
};
