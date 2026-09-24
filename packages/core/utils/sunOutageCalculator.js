/**
 * 日凌（Sun Outage）计算器 v5
 * 第一性原理 ECEF 向量法 + 物理恶化门限定窗
 *
 * 几何（v4 原样保留，峰值时刻由它决定）：
 * - 地球站位置：WGS84 大地坐标 → ECEF
 * - GEO 卫星位置：轨道经度 → ECEF
 * - 太阳方向：太阳 RA/Dec (TT) + GAST (UT) → ECEF 单位向量
 * - 角间距：两个方向向量的点积取反余弦
 * - 无 Az/El 中间步骤，无坐标系混用风险
 *
 * 定窗判据（v5 重写）：v4 用几何锥角（半波束宽+太阳视半径，且波束宽取 ~107λ/D
 * 的经验放大值）——判据不物理，中断时长无法对标验证。v5 改为 C/N 恶化门限：
 *   θ_B  = 70λ/D（真实 3dB 波束宽）
 *   ΔT(θ) = T_sun · K(θ)   K = 太阳均匀盘 × 高斯主瓣的精确卷积（v5.1）
 *     轴上闭式：K(0) = 1 − exp(−ln2·θ_d²/θ_B²)（θ_d 当日太阳视直径；
 *               小口径极限 → (θ_d/θ_B)²·ln2 级填充因子；大口径极限 → 1 封顶）
 *     离轴：K(θ) = 2a·e^{−aθ²}∫₀^{θ_d/2} r·e^{−ar²}·I₀(2arθ)dr，a=4ln2/θ_B²
 *           （Simpson + 指数缩放 I₀，θ=0 时与闭式解一致，用作自检）
 *   D(θ) = 10·lg(1 + ΔT(θ)/T_sys)          C/N 恶化 dB
 *   窗口 = { t : D(θ(t)) ≥ D_th }，D_th 用户可选（默认 1 dB，行业预报惯例口径）
 * D 对 θ 单调递减 → 逐日二分反解门限角 θ_th，交给通用事件求根器精炼边界。
 *
 * 太阳亮温 T_sun（v5.1，替代按频段写死的静态值）：
 *   锚点用每日实测太阳射电流量指数 F10.7（2.8GHz 全日面流量，1 sfu=1e-22 W/m²/Hz，
 *   NOAA SWPC 发布）：T_b(2.8) = S·λ²/(2k·Ω_d)，Ω_d 取当日太阳视直径的立体角——
 *   与耦合计算共用同一盘径，小源区流量守恒（盘径选取误差自相抵消）。
 *   频谱外推：T_b(f) = 6000 + (T_b(2.8) − 6000)·(2.8/f)^1.8，光球层floor 6000K，
 *   指数 1.8 拟合公开静太阳测量（10.7GHz≈1e4 K、5GHz≈2e4 K、30GHz+→光球层），
 *   适用 3~50 GHz。F10.7 默认 120（周期均值；深谷~70，峰年可达 200+）。
 *   仍可传 solarTemp 直接覆盖（如需对齐第三方工具口径）。
 *   ★ v5.3 起这一套整体降为 legacy 档（solarTempLegacy，一个数字都没改），缺省档见下。
 *
 * 太阳亮温 T_sun（v5.3，缺省档 solarModel:'norp'）：
 *   病灶：v5.1 的 (2.8/f)^1.8 单一谱指数对 3~40 GHz 太陡 —— 与野边山逐日实测比（F10.7=120），
 *   3.75 GHz 偏高 9%、Ku 12.5 GHz 偏低 19%、Ka 19.45 GHz 偏低 23%、Q 40 GHz 偏低 27%；
 *   且 F10.7 恒取 120 与真实太阳活动无关（谷底~70、峰年 200+，同一副天线峰值恶化差 2 dB 量级）。
 *   改法：不再由单一锚点外推，而是【逐频各自对 F10.7 回归】——
 *     野边山射电偏振计（NoRP，国立天文台）1 / 2 / 3.75 / 9.4 / 17 GHz 逐日总流量，
 *     与 DRAO Penticton F10.7 逐日观测值按日期配对（2004-10 ~ 2026-07，7325 天），
 *     逐频稳健线性回归 S_f = a_f + b_f·F10.7（3σ 剔野点迭代 5 轮）→ SOLAR_ANCHORS。
 *     2.8 GHz 是 F10.7 自身，恒等锚点（a=0, b=1）。锚点之间按 log S – log f 线性插值。
 *   17 GHz 以上没有逐日数据：静日谱用 NoRP 自己的绝对标定常量锚定（手册 man_v04e §2：
 *     35 / 80 GHz 的流量刻度即固定为 2400 / 9000 sfu 这两个静日值），换算成光学盘亮温
 *     9 378 K / 6 731 K，与文献静太阳 8 mm ≈ 8 500~9 500 K、3.7 mm ≈ 6 500~7 500 K 相符；
 *     80 GHz 以上按光球层 floor 6000 K 收敛（T_q(f) = 6000 + 731·80/f）。活动增量在 17 GHz
 *     以上按【流量恒定】ΔS = b₁₇·(F − F_QUIET)（活动区自由-自由辐射平谱，回旋共振分量 20 GHz
 *     以上消失），换成亮温即 ∝ f⁻²，35 GHz 处峰年也只有 +2.6%。
 *   Ω_d 仍取【当日】光学盘，S 是「地球处观测流量」，两者随日地距离同比变化 —— 口径自洽，
 *     不做 1 AU 归算（>80 GHz 那一段由 T_q 反算流量时用 1 AU 盘，与 T_q 的定义域一致）。
 *   F10.7 由调用方（IPC 层）按目标日期从 NOAA SWPC 查好传进来（params.f107 / f107Meta）——
 *     引擎不碰文件系统、不联网；查不到时才落到 F107_DEFAULT = 120。
 *   精度：拟合残差 3.75 GHz σ≈2.5%、9.4 GHz 2.4%、17 GHz 2%；17 GHz 以上是锚定外推，
 *     Ka ±10%、Q ±15%。RSTN 四个独立台站交叉验证（2695/4995/8800/15400 MHz）偏差 ≤ 5%。
 *   legacy 档（solarModel:'legacy'）保留 v5.1 整套，一个数字都没改 —— 金标准
 *     test/sunOutage.test.mjs 与任何要「与改前逐位一致」的场合走它。
 *
 * v5.2：星历档与纯几何档
 * - 星历档（params.orbit）：卫星位置不再当成理想静止轨道的常量，而是经 utils/orbitSource.js
 *   的轨道源逐时刻取（SGP4/SDP4，含倾角、偏心率与漂移；不含轨道保持机动）。引擎只吃 ECEF，
 *   不建 satrec、不做坐标系转换——外部星历（.e / OEM / SP3）将来只是换一种轨道源实现。
 *   ★ 不逐秒 propagate：与 daySun 同一条原则，改为两级采样 + 日内线性插值——
 *     粗表 10 min（145 点/天）只用于「当天有没有星历」与逐日赤纬预筛；
 *     细表 60 s（1441 点/天）供事件求根逐秒取值。倾角 15° 的 GSO 在 60 s 内的弦垂 ≈ 9 m，
 *     从 38 000 km 外看 ≈ 1.4e-5°，远小于求根容差 0.5 s 对应的太阳位移 ≈ 0.002°。
 *   逐日预筛 margin = 0.05°（插值余量，与定轨档同）+ inclDeg·(2π/1436.07)·5：星下点赤纬
 *     δ = i·sin u、du/dt = 2π/P，10 min 粗采样两点之间赤纬最多走这么多，不留就会漏筛事件日。
 *   轨迹表按 (轨道, 日) 记忆化，经 ctx.satTrack 在一批站之间共用——轨迹与站无关，一颗星一季只算一次。
 * - 纯几何档（params.criterion = 'geometric'）：门限角 θ_th ≡ θ_3dB = 70λ/D（全宽，不加太阳视半径），
 *   窗口 = { t : θ(t) ≤ θ_3dB }。峰值恶化 dB 仍按上面的物理模型算出——它是物理量，与定窗判据无关。
 * - 定轨档（params.satLon）的计算路径逐位不变：satU 仍是常量，新增分支一律走 if (orbit)。
 */

var findWindows = require('./eventWindows.js').findWindows;
var orbitSourceMod = require('./orbitSource.js');

const PI = Math.PI;
const RAD = PI / 180;
const DEG = 180 / PI;
const SECONDS_PER_DAY = 86400;
const JD_SEC = 1 / 86400;
const JD_MIN = 1 / 1440;

// WGS84 椭球
const A_WGS = 6378.137;                          // 赤道半径 km
const F_WGS = 1 / 298.257223563;
const E2_WGS = 2 * F_WGS - F_WGS * F_WGS;       // 第一偏心率平方

// GEO 轨道：a = 42164.17 km（含地球自转）
const R_GEO = 42164.17;

// 同步轨道守卫（星历档拒算非 GSO）：与 src/shared/orbitClass.js 的 T_SIDEREAL_MIN /
// GSO_PERIOD_TOL_MIN 同一组数（恒星日 ±2%），两处改动须同步。
const T_SIDEREAL_MIN = 1436.07;
const GSO_PERIOD_TOL_MIN = 28.72;

// 频段参数：频率 GHz、典型系统噪温 K（晴空，天线+LNA，供未填 T_sys 时兜底——
// T_sys 本质是用户站的属性，精确计算应填实测值或由 G/T 反推）。
// solarTemp 为 v4/v5 的静态太阳遗留值，v5.1 起引擎默认改用 F10.7 连续模型，
// 仅当调用方显式传 solarTemp 时才使用外部值；此表数值保留供参考/对齐旧口径。
const BAND_PARAMS = {
  'C':     { freq: 3.95,  solarTemp: 42000, sysTemp: 65  },
  'Ku':    { freq: 12.50, solarTemp: 12000, sysTemp: 150 },
  'ExtKu': { freq: 11.75, solarTemp: 13000, sysTemp: 145 },
  'Ka':    { freq: 19.45, solarTemp: 9000,  sysTemp: 270 },
  'Q':     { freq: 40.00, solarTemp: 7500,  sysTemp: 450 }
};

/* ============================================================
 * ΔT = TT – UT1（秒）
 *
 * 2005–2025: IERS Earth Orientation Centre 实测年均值（线性内插）
 *   2018 起 ΔT = 69.184 − DUT1，DUT1 取 IERS Bulletin A 年均值
 * 2026+   : 二次外推
 *   线性项 +0.03 s/yr  — 2020–2025 近乎持平，取保守正增长
 *   二次项 +0.004 s/yr² — 长期潮汐减速 (~25.5 s/century²)
 *   预期值: 2030→69.5 | 2040→70.6 | 2050→72.5
 * ============================================================ */
function deltaT(year) {
  // IERS 实测年均值 [2005 … 2025]
  var _obs = [
    64.69, 64.85, 65.15, 65.46, 65.78,  // 2005-2009
    66.07, 66.32, 66.60, 66.91, 67.28,  // 2010-2014
    67.64, 68.10, 68.59, 69.11, 69.24,  // 2015-2019
    69.36, 69.28, 69.18, 69.16, 69.20,  // 2020-2024
    69.22                                // 2025 (preliminary)
  ];
  var Y0 = 2005;
  var YN = Y0 + _obs.length - 1; // 2025

  // 查表 + 线性内插
  if (year >= Y0 && year <= YN) {
    var idx = Math.min(Math.floor(year - Y0), _obs.length - 2);
    var frac = year - Y0 - idx;
    return _obs[idx] + frac * (_obs[idx + 1] - _obs[idx]);
  }

  // 2026+ 中长期预测
  if (year > YN) {
    var t = year - YN;
    return 69.22 + 0.03 * t + 0.004 * t * t;
  }

  // < 2005 兜底
  var t = year - 2000;
  return 63.83 + 0.24 * t + 0.005 * t * t;
}

/* ============================================================
 * 儒略日
 * ============================================================ */
function julianDay(y, m, d) {
  if (m <= 2) { y--; m += 12; }
  var A = Math.floor(y / 100);
  var B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) +
         Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

/* ============================================================
 * VSOP87 高精度太阳位置 — Bretagnon & Francou (1988)
 * 截断自 Meeus "Astronomical Algorithms" 2nd ed. Appendix II
 * 配合 IAU 1980 章动模型（63 项）
 * 黄经精度 ≈ 1″（对应时间误差 ≈ 0.4 秒）
 *
 * 输入：JDE（TT 儒略日）
 * 输出：apparent RA(°), Dec(°), R(AU), dpsi(°), eps0(°)
 * ============================================================ */

/* ── VSOP87 求和辅助 ── */
function _vS(c, tau) {
  var s = 0;
  for (var i = 0; i < c.length; i++) s += c[i][0] * Math.cos(c[i][1] + c[i][2] * tau);
  return s;
}

/* ── 地球日心黄经 L 系数 [A, B, C] ── */
var _L0 = [
  [175347046,0,0],[3341656,4.6692568,6283.07585],[34894,4.6261,12566.1517],
  [3497,2.7441,5753.3849],[3418,2.8289,3.5232],[3136,3.6277,77713.7715],
  [2676,4.4181,7860.4194],[2343,6.1352,3930.2097],[1324,0.7425,11506.7698],
  [1273,2.0371,529.691],[1199,1.1096,1577.3436],[990,5.233,5884.927],
  [902,2.045,26.298],[857,3.508,398.149],[780,1.179,5223.694],
  [753,2.533,5507.553],[505,4.583,18849.228],[492,4.205,775.523],
  [357,2.920,0.067],[317,5.849,11790.629],[284,1.899,796.298],
  [271,0.315,10977.079],[243,0.345,5486.778],[206,4.806,2544.314],
  [205,1.869,5573.143],[202,2.458,6069.777],[156,0.833,213.299],
  [132,3.411,2942.463],[126,1.083,20.775],[115,0.645,0.980],
  [103,0.636,4694.003],[99,6.21,2146.17],[98,0.68,155.42],
  [86,5.98,161000.69],[85,1.30,6275.96],[85,3.67,71430.70],[80,1.81,17260.15]
];
var _L1 = [
  [628331966747,0,0],[206059,2.678235,6283.07585],[4303,2.6351,12566.1517],
  [425,1.590,3.523],[119,5.796,26.298],[109,2.966,1577.344],
  [93,2.59,18849.23],[72,1.14,529.69],[68,1.87,398.15],
  [67,4.41,5507.55],[59,2.89,5223.69],[56,2.17,155.42],
  [45,0.40,796.30],[36,0.47,775.52],[29,2.65,7.11],
  [21,5.34,0.98],[19,1.85,5486.78],[19,4.97,213.30],
  [17,2.99,6275.96],[16,0.03,2544.31]
];
var _L2 = [
  [52919,0,0],[8720,1.0721,6283.0758],[309,0.867,12566.152],
  [27,0.05,3.52],[16,5.19,26.30],[16,3.68,155.42],
  [10,0.76,18849.23],[9,2.06,77713.77],[7,0.83,775.52],[5,4.66,1577.34]
];
var _L3 = [
  [289,5.844,6283.076],[35,0,0],[17,5.49,12566.15],
  [3,5.20,155.42],[1,4.72,3.52],[1,5.30,18849.23],[1,5.97,242.73]
];
var _L4 = [[114,3.142,0],[8,4.13,6283.08],[1,3.84,12566.15]];
var _L5 = [[1,3.14,0]];

/* ── 地球日心黄纬 B 系数 ── */
var _B0 = [[280,3.199,84334.662],[102,5.422,5507.553],[80,3.88,5223.69],[44,3.70,2352.87],[32,4.00,1577.34]];
var _B1 = [[9,3.90,5507.55],[6,1.73,5223.69]];

/* ── 地球日心距离 R 系数 ── */
var _R0 = [
  [100013989,0,0],[1670700,3.098464,6283.07585],[13956,3.05525,12566.1517],
  [3084,5.1985,77713.7715],[1628,1.1739,5753.3849],[1576,2.8469,7860.4194],
  [925,5.453,11506.770],[542,4.564,3930.210],[472,3.661,5884.927],
  [346,0.964,5507.553],[329,5.900,5223.694],[307,0.299,5573.143],
  [243,4.273,11790.629],[212,5.847,1577.344],[186,5.022,10977.079],
  [175,3.012,18849.228],[110,5.055,5486.778],[98,0.89,6069.78],
  [86,5.69,15720.84],[86,1.27,161000.69],[65,0.27,17260.15],
  [63,0.92,529.69],[57,2.01,83996.85],[56,5.24,71430.70],
  [49,3.25,2544.31],[47,2.58,775.52],[45,5.54,9437.76],
  [43,6.01,6275.96],[39,5.36,4694.00],[38,2.39,8827.39]
];
var _R1 = [
  [103019,1.10749,6283.07585],[1721,1.0644,12566.1517],[702,3.142,0],
  [32,1.02,18849.23],[31,2.84,5507.55],[25,1.32,5223.69],
  [18,1.42,1577.34],[10,5.91,10977.08]
];
var _R2 = [
  [4359,5.7846,6283.0758],[124,5.579,12566.152],[12,3.14,0],
  [9,3.63,77713.77],[6,1.87,5573.14],[3,5.47,18849.23]
];
var _R3 = [[145,4.273,6283.076],[7,3.92,12566.15]];
var _R4 = [[4,2.56,6283.08]];

/* ── IAU 1980 章动 63 项 [D,M,Mp,F,Ω, ψS,ψSt, εC,εCt] (单位 0.0001″) ── */
var _NT = [
  [0,0,0,0,1,-171996,-174.2,92025,8.9],
  [-2,0,0,2,2,-13187,-1.6,5736,-3.1],
  [0,0,0,2,2,-2274,-0.2,977,-0.5],
  [0,0,0,0,2,2062,0.2,-895,0.5],
  [0,1,0,0,0,1426,-3.4,54,-0.1],
  [0,0,1,0,0,712,0.1,-7,0],
  [-2,1,0,2,2,-517,1.2,224,-0.6],
  [0,0,0,2,1,-386,-0.4,200,0],
  [0,0,1,2,2,-301,0,129,-0.1],
  [-2,-1,0,2,2,217,-0.5,-95,0.3],
  [-2,0,1,0,0,-158,0,0,0],
  [-2,0,0,2,1,129,0.1,-70,0],
  [0,0,-1,2,2,123,0,-53,0],
  [2,0,0,0,0,63,0,0,0],
  [0,0,1,0,1,63,0.1,-33,0],
  [2,0,-1,2,2,-59,0,26,0],
  [0,0,-1,0,1,-58,-0.1,32,0],
  [0,0,1,2,1,-51,0,27,0],
  [-2,0,2,0,0,48,0,0,0],
  [0,0,-2,2,1,46,0,-24,0],
  [2,0,0,2,2,-38,0,16,0],
  [0,0,2,2,2,-31,0,13,0],
  [0,0,2,0,0,29,0,0,0],
  [-2,0,1,2,2,29,0,-12,0],
  [0,0,0,2,0,26,0,0,0],
  [-2,0,0,2,0,-22,0,0,0],
  [0,0,-1,2,1,21,0,-10,0],
  [0,2,0,0,0,17,-0.1,0,0],
  [2,0,-1,0,1,16,0,-8,0],
  [-2,2,0,2,2,-16,0.1,7,0],
  [0,1,0,0,1,-15,0,9,0],
  [-2,0,1,0,1,-13,0,7,0],
  [0,-1,0,0,1,-12,0,6,0],
  [0,0,2,-2,0,11,0,0,0],
  [2,0,-1,2,1,-10,0,5,0],
  [2,0,1,2,2,-8,0,3,0],
  [0,1,0,2,2,7,0,-3,0],
  [-2,1,1,0,0,-7,0,0,0],
  [0,-1,0,2,2,-7,0,3,0],
  [2,0,0,2,1,-7,0,3,0],
  [2,0,1,0,0,-8,0,0,0],
  [-2,0,2,2,2,6,0,-3,0],
  [-2,0,1,2,1,6,0,-3,0],
  [2,0,-2,0,1,-6,0,3,0],
  [2,0,0,0,1,-6,0,3,0],
  [0,-1,1,0,0,5,0,0,0],
  [-2,-1,0,2,1,-5,0,3,0],
  [-2,0,0,0,1,-5,0,3,0],
  [0,0,2,2,1,-5,0,3,0],
  [-2,0,2,0,1,4,0,0,0],
  [-2,1,0,2,1,4,0,0,0],
  [0,0,1,-2,0,4,0,0,0],
  [-1,0,1,0,0,-4,0,0,0],
  [-2,1,0,0,0,-4,0,0,0],
  [1,0,0,0,0,-4,0,0,0],
  [0,0,1,2,0,3,0,0,0],
  [0,0,-2,2,2,-3,0,0,0],
  [-1,-1,1,0,0,-3,0,0,0],
  [0,1,1,0,0,-3,0,0,0],
  [0,-1,1,2,2,-3,0,0,0],
  [2,-1,-1,2,2,-3,0,0,0],
  [0,0,3,2,2,-3,0,0,0],
  [2,-1,0,2,2,-3,0,0,0]
];

/* ── 章动计算 (IAU 1980) ── */
function _nutation(T) {
  var D  = (297.85036 + 445267.11148*T - 0.0019142*T*T + T*T*T/189474) * RAD;
  var Ms = (357.52772 + 35999.05034*T  - 0.0001603*T*T - T*T*T/300000) * RAD;
  var Mm = (134.96298 + 477198.86740*T + 0.0086972*T*T + T*T*T/56250)  * RAD;
  var F  = (93.27191  + 483202.01754*T - 0.0036825*T*T + T*T*T/327270) * RAD;
  var Om = (125.04452 - 1934.13626*T   + 0.0020708*T*T + T*T*T/450000) * RAD;
  var dp = 0, de = 0;
  for (var i = 0; i < _NT.length; i++) {
    var n = _NT[i];
    var a = n[0]*D + n[1]*Ms + n[2]*Mm + n[3]*F + n[4]*Om;
    dp += (n[5] + n[6]*T) * Math.sin(a);
    de += (n[7] + n[8]*T) * Math.cos(a);
  }
  // 0.0001″ → 度: ÷ (3600 × 10000)
  return { dpsi: dp / 36000000, deps: de / 36000000 };
}

/* ── 太阳视位置主函数 ── */
function solarPosition(jde) {
  var T = (jde - 2451545.0) / 36525;
  var tau = T / 10;
  var t2 = tau*tau, t3 = t2*tau, t4 = t3*tau, t5 = t4*tau;

  // 地球日心坐标 (弧度, 弧度, AU)
  var L = (_vS(_L0,tau) + tau*_vS(_L1,tau) + t2*_vS(_L2,tau)
         + t3*_vS(_L3,tau) + t4*_vS(_L4,tau) + t5*_vS(_L5,tau)) / 1e8;
  var B = (_vS(_B0,tau) + tau*_vS(_B1,tau)) / 1e8;
  var R = (_vS(_R0,tau) + tau*_vS(_R1,tau) + t2*_vS(_R2,tau)
         + t3*_vS(_R3,tau) + t4*_vS(_R4,tau)) / 1e8;

  // 日心 → 地心
  var geoL = ((L + PI) % (2*PI) + 2*PI) % (2*PI);
  var geoB = -B;

  // FK5 修正 (Meeus p.166)
  var Lp = (geoL * DEG - 1.397*T - 0.00031*T*T) * RAD;
  geoL += -0.09033 / 3600 * RAD;
  geoB +=  0.03916 / 3600 * RAD * (Math.cos(Lp) - Math.sin(Lp));

  // 章动
  var nut = _nutation(T);

  // 光行差 (κ = 20.4898″)
  var aberr = -20.4898 / 3600 / R * RAD;

  // 视黄经
  var lamApp = geoL + nut.dpsi * RAD + aberr;

  // 平均黄赤交角 (Lieske 1979, Meeus Ch.22)
  var eps0 = 23.4392911 - 0.0130042*T - 0.000000164*T*T + 0.000000504*T*T*T;

  // 真黄赤交角
  var eps = (eps0 + nut.deps) * RAD;

  // 视赤经/赤纬 (含黄纬修正)
  var sinL = Math.sin(lamApp), cosL = Math.cos(lamApp);
  var sinB = Math.sin(geoB), cosB = Math.cos(geoB), tanB = Math.tan(geoB);
  var cosE = Math.cos(eps), sinE = Math.sin(eps);

  var ra  = Math.atan2(sinL*cosE - tanB*sinE, cosL) * DEG;
  var dec = Math.asin(sinB*cosE + cosB*sinE*sinL) * DEG;

  return {
    ra: ((ra % 360) + 360) % 360,
    dec: dec,
    R: R,
    dpsi: nut.dpsi,   // 度
    eps0: eps0         // 度
  };
}

/* ============================================================
 * GMST（格林尼治平恒星时，输入 UT JD）
 * ============================================================ */
function gmst(jdUT) {
  var T = (jdUT - 2451545.0) / 36525.0;
  var g = 280.46061837
        + 360.98564736629 * (jdUT - 2451545.0)
        + 0.000387933 * T * T
        - T * T * T / 38710000;
  return ((g % 360) + 360) % 360;
}

/* ============================================================
 * ECEF 坐标计算
 * ============================================================ */

/** 地球站 WGS84 → ECEF (km) */
function stnXYZ(latD, lonD) {
  var la = latD * RAD, lo = lonD * RAD;
  var sl = Math.sin(la), cl = Math.cos(la);
  var N = A_WGS / Math.sqrt(1 - E2_WGS * sl * sl);
  return [N * cl * Math.cos(lo),
          N * cl * Math.sin(lo),
          N * (1 - E2_WGS) * sl];
}

/** GEO 卫星 → ECEF (km) */
function satXYZ(satLonD) {
  var lo = satLonD * RAD;
  return [R_GEO * Math.cos(lo), R_GEO * Math.sin(lo), 0];
}

/** 归一化向量 a→b */
function unitVec(a, b) {
  var dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
  var r = Math.sqrt(dx*dx + dy*dy + dz*dz);
  return [dx/r, dy/r, dz/r];
}

/** 两个单位向量夹角（°） */
function vecAngle(u, v) {
  var d = u[0]*v[0] + u[1]*v[1] + u[2]*v[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) * DEG;
}

/* ============================================================
 * 太阳方向 ECEF 单位向量
 *
 * 太阳 apparent RA/Dec 是在赤道惯性系（指向春分点），
 * 需旋转 GAST（视恒星时）角度才能转换到 ECEF。
 * ============================================================ */
// 一天的太阳方向（ECEF），按秒取值。
// ★ 太阳的 RA / Dec 一天只走约 1° 且近乎线性：VSOP87 + 章动只在当天 0h 与 24h 各算一次，日内按秒
//   线性插值 RA / Dec（RA 在春分附近跨 0°/360°，插值前先解卷）；GAST 仍逐秒解析算——地球自转才是
//   分秒级的量。章动项 Δψ cos ε 一天内视作常量（主周期 18.6 年，日变化远小于 0.1″）。
//   原先每 15 s 一个采样都整套算一遍 VSOP87 + 章动，一季 61 天 ≈ 35 万次，主进程被占 0.8～1.7 s；
//   现在一季约 120 次。逐日对拍（test/sunOutage.test.mjs）：窗口时刻差 ≤ 1 s＝求根容差 0.5 s 的量级，
//   峰值恶化差 ≤ 0.01 dB，天数逐日相同。
function daySun(dayJD, dT) {
  var a = solarPosition(dayJD + dT / SECONDS_PER_DAY);
  var b = solarPosition(dayJD + 1 + dT / SECONDS_PER_DAY);
  var dra = b.ra - a.ra;
  if (dra > 180) dra -= 360; else if (dra < -180) dra += 360;
  var nut = a.dpsi * Math.cos(a.eps0 * RAD);   // GAST = GMST + Δψ cos ε（与 apparent RA 配套）
  return {
    // 当天太阳赤纬的走向区间（逐日预筛用：绕极轴旋转不改变赤纬差）
    decLo: Math.min(a.dec, b.dec), decHi: Math.max(a.dec, b.dec),
    dir: function (sec) {
      var u = sec / SECONDS_PER_DAY;
      var raR = (a.ra + dra * u) * RAD;
      var decR = (a.dec + (b.dec - a.dec) * u) * RAD;
      var gastR = (gmst(dayJD + sec * JD_SEC) + nut) * RAD;
      var cd = Math.cos(decR);
      return [cd * Math.cos(raR - gastR), cd * Math.sin(raR - gastR), Math.sin(decR)];
    }
  };
}

/** 太阳是否在地平线以上（大地法线点乘太阳方向 > 0） */
function sunUp(latD, lonD, sd) {
  var la = latD * RAD, lo = lonD * RAD;
  var nx = Math.cos(la) * Math.cos(lo);
  var ny = Math.cos(la) * Math.sin(lo);
  var nz = Math.sin(la);
  return (nx*sd[0] + ny*sd[1] + nz*sd[2]) > -0.005;
}

/* ============================================================
 * 从 ECEF 向量算卫星 Az/El（仅供界面显示）
 * ENU 旋转矩阵基于大地纬度，与 WGS84 表面法线一致
 * ============================================================ */
function satAzElECEF(stn, sat, latD, lonD) {
  var la = latD * RAD, lo = lonD * RAD;
  var sl = Math.sin(la), cl = Math.cos(la);
  var sn = Math.sin(lo), cn = Math.cos(lo);
  var dx = sat[0]-stn[0], dy = sat[1]-stn[1], dz = sat[2]-stn[2];
  var e = -sn*dx + cn*dy;
  var n = -sl*cn*dx - sl*sn*dy + cl*dz;
  var u =  cl*cn*dx + cl*sn*dy + sl*dz;
  var el = Math.atan2(u, Math.sqrt(e*e + n*n)) * DEG;
  var az = Math.atan2(e, n) * DEG;
  if (az < 0) az += 360;
  return { az: az, el: el };
}

/* ============================================================
 * 分点精确 JDE（Meeus Ch.27 + Table 27.C 周期修正）
 * ============================================================ */
function equinoxJDE(year, season) {
  var Y = (year - 2000) / 1000;
  var JDE0;
  if (season === 'vernal') {
    JDE0 = 2451623.80984 + 365242.37404*Y + 0.05169*Y*Y
         - 0.00411*Y*Y*Y - 0.00057*Y*Y*Y*Y;
  } else {
    JDE0 = 2451810.21715 + 365242.01767*Y - 0.11575*Y*Y
         + 0.00337*Y*Y*Y + 0.00078*Y*Y*Y*Y;
  }
  var T = (JDE0 - 2451545.0) / 36525.0;
  var S = periodicSum(T);
  var W = 35999.373 * T - 2.47;
  var dL = 1 + 0.0334 * Math.cos(W * RAD) + 0.0007 * Math.cos(2 * W * RAD);
  return JDE0 + (0.00001 * S) / dL;
}

/**
 * 分点日（UT 日期串 'YYYY-MM-DD'）—— 与 calculateSunOutage 里用的是同一条路径。
 * IPC 层按「该季分点日」去取 F10.7 时用它，别在外面再抄一份分点公式。
 */
function equinoxDateOf(year, season) {
  var s = season === 'vernal' ? 'vernal' : 'autumnal';
  var jdut = equinoxJDE(year, s) - deltaT(year) / SECONDS_PER_DAY;
  var d = jdToDate(jdut);
  return fmtDate(d.y, d.m, d.d);
}

function periodicSum(T) {
  var terms = [
    [485,324.96,1934.136],[203,337.23,32964.467],[199,342.08,20.186],
    [182,27.85,445267.112],[156,73.14,45036.886],[136,171.52,22518.443],
    [77,222.54,65928.934],[74,296.72,3034.906],[70,243.58,9037.513],
    [58,119.81,33718.147],[52,297.17,150.678],[50,21.02,2281.226],
    [45,247.54,29929.562],[44,325.15,31555.956],[29,60.93,4443.417],
    [18,155.12,67555.328],[17,288.79,4562.452],[16,198.04,62894.029],
    [14,199.76,31436.921],[12,95.39,14577.848],[12,287.11,31931.756],
    [12,320.81,34777.259],[9,227.73,1222.114],[8,15.45,16859.074]
  ];
  var S = 0;
  for (var i = 0; i < terms.length; i++) {
    S += terms[i][0] * Math.cos((terms[i][1] + terms[i][2] * T) * RAD);
  }
  return S;
}

/* ============================================================
 * 扫描辅助
 * ============================================================ */

/** 某 UT 秒偏移处的角间距（day = daySun 出的当天太阳） */
function sepAtSec(day, sec, satU, latD, lonD) {
  var d = day.dir(sec);
  return { sep: vecAngle(satU, d), up: sunUp(latD, lonD, d) };
}

/* ============================================================
 * 恶化模型（v5.1：精确盘卷积 + F10.7 太阳亮温）
 * ============================================================ */

var LN2_4 = 4 * Math.LN2;
var KB = 1.380649e-23;      // 玻尔兹曼常数 J/K（SI 定义值）
var SFU = 1e-22;            // 1 sfu = 1e-22 W/m²/Hz
var F_REF = 2.8;            // F10.7 测量频率 GHz（10.7cm）
var T_FLOOR = 6000;         // 光球层亮温 floor K（高频极限）
var SPEC_ALPHA = 1.8;       // 频谱指数：拟合公开静太阳测量（10.7GHz≈1e4K、5GHz≈2e4K），适用 3~50GHz
var F107_DEFAULT = 120;     // F10.7 默认值（太阳周期长期均值；深谷≈70，峰年可达 200+）

/** I₀(x)·e^{−x}（Abramowitz & Stegun 9.8.1/9.8.2 多项式近似，指数缩放防溢出） */
function i0e(x) {
  var ax = Math.abs(x);
  if (ax < 3.75) {
    var t = x / 3.75; t *= t;
    var I0 = 1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))));
    return I0 * Math.exp(-ax);
  }
  var u = 3.75 / ax;
  return (0.39894228 + u * (0.01328592 + u * (0.00225319 + u * (-0.00157565 + u * (0.00916281 + u * (-0.02057706 + u * (0.02635537 + u * (-0.01647633 + u * 0.00392377)))))))) / Math.sqrt(ax);
}

/**
 * 偏轴 θ 处「太阳均匀盘 × 高斯主瓣」的精确耦合系数 K(θ)∈(0,1)：
 *   K(θ) = 2a·∫₀^{θd/2} r·exp(−a(r−θ)²)·[I₀(2arθ)e^{−2arθ}] dr，a = 4ln2/θ_B²
 * θ=0 有闭式 1−exp(−a·(θd/2)²)（积分退化，兼作数值实现的自检基准）。
 * Simpson 48 段对这种光滑核精度远超需求（<1e-6 相对误差）。
 */
function couplingAt(thetaDeg, thetaB, thetaD) {
  var a = LN2_4 / (thetaB * thetaB);
  var rd = thetaD / 2;
  if (thetaDeg === 0) return 1 - Math.exp(-a * rd * rd);
  var n = 48, h = rd / n, s = 0;
  for (var i = 0; i <= n; i++) {
    var r = i * h;
    var d = r - thetaDeg;
    var v = r * Math.exp(-a * d * d) * i0e(2 * a * r * thetaDeg);
    s += (i === 0 || i === n) ? v : (i % 2 ? 4 * v : 2 * v);
  }
  return 2 * a * s * h / 3;
}

/**
 * 太阳亮温 K（全日面均匀盘等效）· v5.1 原式，v5.3 起降为 legacy 档：
 *   T_b(2.8GHz) = F10.7·sfu·λ²/(2k·Ω_d) —— 由当日太阳视直径的立体角换算，
 *   与耦合计算共用同一盘径 → 小源区 ΔT∝流量，盘径选取误差自相抵消；
 *   T_b(f) = 6000 + (T_b(2.8)−6000)·(2.8/f)^1.8 谱外推。
 * ★ 一个数字都不许改：金标准与「与改前逐位一致」的场合靠它。
 */
function solarTempLegacy(freqGHz, f107, sunDiamDeg) {
  var th = sunDiamDeg * RAD;
  var omega = Math.PI / 4 * th * th;                 // 均匀盘立体角 sr
  var lam = 0.299792458 / F_REF;                     // 2.8GHz 波长 m
  var t28 = f107 * SFU * lam * lam / (2 * KB * omega);
  return T_FLOOR + Math.max(0, t28 - T_FLOOR) * Math.pow(F_REF / freqGHz, SPEC_ALPHA);
}

/* ------------------------------------------------------------
 * v5.3 缺省档：野边山（NoRP）1~17 GHz 逐日流量对 F10.7 的回归谱
 * 系数为终值，出处 docs/research/solar-flux-fit/（fit.mjs / coef.json），别重新拟合。
 * ---------------------------------------------------------- */
// S_f(F) = a_f + b_f·F（sfu；F 为 DRAO 观测的 F10.7）。2.8 GHz 即 F10.7 自身，恒等锚点。
var SOLAR_ANCHORS = [
  { f: 1.0,  a: -1.979,   b: 0.70334 },
  { f: 2.0,  a: -10.643,  b: 0.94073 },
  { f: 2.8,  a: 0,        b: 1       },
  { f: 3.75, a: 17.318,   b: 0.88345 },
  { f: 9.4,  a: 210.379,  b: 0.68094 },
  { f: 17.0, a: 592.284,  b: 0.45292 }
];
var F_QUIET = 67;                 // 静日 F10.7（太阳周谷底典型值）
var B_HIGH = 0.45292;             // 17 GHz 以上的活动增量斜率：沿用 17 GHz 的 b（流量恒定外推）
var SUN_DIAM_1AU = 2 * 0.26656;   // 1 AU 处太阳视直径 °（959.63″ 视半径的两倍，与扫描里同一常量）
var OMEGA_1AU = Math.PI / 4 * (SUN_DIAM_1AU * RAD) * (SUN_DIAM_1AU * RAD);   // 1 AU 光学盘立体角 sr
// 静日谱在 17 / 35 / 80 GHz 的三个锚（35 / 80 来自 NoRP 手册 man_v04e §2 的绝对标定常量）
var S_Q_HIGH = [
  { f: 17, s: SOLAR_ANCHORS[5].a + SOLAR_ANCHORS[5].b * F_QUIET },
  { f: 35, s: 2400 },
  { f: 80, s: 9000 }
];
var T_Q_80 = 9000 * SFU * (0.299792458 / 80) * (0.299792458 / 80) / (2 * KB * OMEGA_1AU);   // ≈ 6731 K

/** 两个锚点之间按 log S – log f 线性插值 */
function logInterp(f, f1, s1, f2, s2) {
  var t = Math.log(f / f1) / Math.log(f2 / f1);
  return Math.exp(Math.log(s1) + t * (Math.log(s2) - Math.log(s1)));
}

/**
 * 太阳全日面射电流量 S(f, F10.7)，单位 sfu。
 * f ≤ 17 GHz：逐频回归锚点（S = a + b·F）之间 log-log 插值；f < 1 GHz 取 1 GHz 锚点值。
 * f > 17 GHz：静日谱 S_q(f)（≤80 GHz 走 35 / 80 两个标定锚，>80 GHz 由 T_q(f) 反算）
 *             + 活动增量 b₁₇·(F − F_QUIET)（流量恒定，换成亮温即 ∝ f⁻²）。
 */
function solarFluxAt(fGHz, f107) {
  var F = Number(f107);
  if (!(F > 0)) F = F107_DEFAULT;
  var f = Number(fGHz);
  if (!(f > 0)) f = F_REF;
  var sOf = function (k) { return SOLAR_ANCHORS[k].a + SOLAR_ANCHORS[k].b * F; };
  var last = SOLAR_ANCHORS.length - 1;
  if (f <= SOLAR_ANCHORS[0].f) return Math.max(0, sOf(0));          // 1 GHz 以下：取 1 GHz 锚点值
  if (f <= SOLAR_ANCHORS[last].f) {
    for (var i = 1; i <= last; i++) {
      if (f <= SOLAR_ANCHORS[i].f) {
        return Math.max(0, logInterp(f, SOLAR_ANCHORS[i - 1].f, Math.max(1e-6, sOf(i - 1)),
                                        SOLAR_ANCHORS[i].f,     Math.max(1e-6, sOf(i))));
      }
    }
  }
  var sq;
  if (f <= S_Q_HIGH[2].f) {
    var j = f <= S_Q_HIGH[1].f ? 1 : 2;
    sq = logInterp(f, S_Q_HIGH[j - 1].f, S_Q_HIGH[j - 1].s, S_Q_HIGH[j].f, S_Q_HIGH[j].s);
  } else {
    // 80 GHz 以上：静日亮温向光球层 floor 收敛 → 反算成流量（1 AU 盘，与 T_q 的定义域一致）
    var lamQ = 0.299792458 / f;
    var tq = T_FLOOR + (T_Q_80 - T_FLOOR) * (S_Q_HIGH[2].f / f);
    sq = tq * 2 * KB * OMEGA_1AU / (lamQ * lamQ * SFU);
  }
  return Math.max(0, sq + B_HIGH * (F - F_QUIET));
}

/**
 * 太阳亮温 K（全日面均匀盘等效）：T_b = S(f, F10.7)·sfu·λ²/(2k·Ω_d)。
 * Ω_d 取【当日】太阳视直径的立体角，与耦合计算共用同一盘径（小源区流量守恒，盘径误差自相抵消）。
 * model：'legacy' 走 v5.1 原式（逐位不变），其余一律 v5.3 回归谱。
 */
function solarTempAt(freqGHz, f107, sunDiamDeg, model) {
  if (model === 'legacy') return solarTempLegacy(freqGHz, f107, sunDiamDeg);
  var th = sunDiamDeg * RAD;
  var omega = Math.PI / 4 * th * th;                 // 当日均匀盘立体角 sr
  var lam = 0.299792458 / freqGHz;                   // 观测频率波长 m
  return solarFluxAt(freqGHz, f107) * SFU * lam * lam / (2 * KB * omega);
}

/**
 * 按当日太阳视半径构建恶化模型。
 * @returns { thetaB 3dB波束宽°, thetaD 太阳视直径°, Tb 太阳亮温K,
 *            dTmax 主轴对准温升K, dTth 门限温升K, thetaTh 门限角°(≤0 表示当日峰值恶化不足门限) }
 */
function outageModel(freqGHz, diameterM, sysTemp, solarTemp, degThresholdDb, sunRadDeg, criterion) {
  var thetaB = 20.98547 / (freqGHz * diameterM);   // 70λ/D（λ=0.2998/f m）
  var thetaD = 2 * sunRadDeg;
  var dTmax = solarTemp * couplingAt(0, thetaB, thetaD);
  var dTth = sysTemp * (Math.pow(10, degThresholdDb / 10) - 1);
  var thetaTh = -1;
  if (criterion === 'geometric') {
    // 纯几何档：门限角恒等于 3dB 波束宽（全宽），与噪温、恶化门限无关——恒 > 0，天天有窗口
    thetaTh = thetaB;
  } else if (dTth < dTmax) {
    // K(θ) 单调递减 → 二分反解门限角；上界处 K 已高斯衰减到远低于任何门限
    var lo = 0, hi = 6 * thetaB + thetaD;
    while (hi - lo > 1e-5) {
      var mid = (lo + hi) / 2;
      if (solarTemp * couplingAt(mid, thetaB, thetaD) > dTth) lo = mid; else hi = mid;
    }
    thetaTh = (lo + hi) / 2;
  }
  return { thetaB: thetaB, thetaD: thetaD, Tb: solarTemp, dTmax: dTmax, dTth: dTth, thetaTh: thetaTh };
}

/** 偏轴角 sep(°) 处的 C/N 恶化 (dB) */
function degradationAt(sepDeg, model, sysTemp) {
  var dT = model.Tb * couplingAt(sepDeg, model.thetaB, model.thetaD);
  return 10 * Math.log10(1 + dT / sysTemp);
}

/* ============================================================
 * 卫星轨迹表（星历档）—— 两级采样 + 日内线性插值，见头注 v5.2
 * ============================================================ */

function makeSatTrack(src) {
  var coarseCache = new Map(), fineCache = new Map();
  function sample(dayJD, n, stepSec) {
    var arr = new Float64Array((n + 1) * 3);
    var base = orbitSourceMod.jdToMs(dayJD);
    for (var i = 0; i <= n; i++) {
      var p = src.posEcefKm(base + i * stepSec * 1000);
      if (!p) return null;                     // 区间外 / 传播失败 → 整天记为「无星历」
      arr[i * 3] = p[0]; arr[i * 3 + 1] = p[1]; arr[i * 3 + 2] = p[2];
    }
    return arr;
  }
  function memo(cache, dayJD, n, stepSec) {
    var k = Math.round(dayJD * 2);             // dayJD 恒为 X.5（UT 零时），×2 取整即唯一键
    if (!cache.has(k)) cache.set(k, sample(dayJD, n, stepSec));
    return cache.get(k);
  }
  return {
    coarse: function (dayJD) { return memo(coarseCache, dayJD, 144, 600); },   // 10 min × 145 点
    fine:   function (dayJD) { return memo(fineCache, dayJD, 1440, 60); }      // 60 s × 1441 点
  };
}

// 轨迹与地球站无关：一批站共用 ctx.satTrack（键 = 轨道 spec 串），一颗星一季只采样一次。
function satTrackFor(src, ctx, orbit) {
  var store = ctx && ctx.satTrack;
  if (!store || typeof store.get !== 'function') return makeSatTrack(src);
  var key = JSON.stringify(orbit);
  var t = store.get(key);
  if (!t) { t = makeSatTrack(src); store.set(key, t); }
  return t;
}

/** 采样表里「站→星」单位向量的赤纬区间（°）——绕极轴旋转不改变赤纬差，逐日预筛用 */
function decRange(arr, stn) {
  var lo = 91, hi = -91, n = arr.length / 3;
  for (var i = 0; i < n; i++) {
    var dx = arr[i * 3] - stn[0], dy = arr[i * 3 + 1] - stn[1], dz = arr[i * 3 + 2] - stn[2];
    var dc = Math.asin(Math.max(-1, Math.min(1, dz / Math.sqrt(dx * dx + dy * dy + dz * dz)))) * DEG;
    if (dc < lo) lo = dc;
    if (dc > hi) hi = dc;
  }
  return [lo, hi];
}

/** 60 s 细表按秒线性插值 → 站→星单位向量（★ 星历档逐秒取值的唯一出口，不逐秒 propagate） */
function satUAt(arr, stn, sec) {
  var x = sec / 60;
  var i0 = Math.floor(x);
  if (i0 < 0) i0 = 0; else if (i0 > 1439) i0 = 1439;
  var fr = x - i0, a = i0 * 3, b = a + 3;
  var dx = arr[a] + (arr[b] - arr[a]) * fr - stn[0];
  var dy = arr[a + 1] + (arr[b + 1] - arr[a + 1]) * fr - stn[1];
  var dz = arr[a + 2] + (arr[b + 2] - arr[a + 2]) * fr - stn[2];
  var r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return [dx / r, dy / r, dz / r];
}

/* ============================================================
 * 主入口
 * ============================================================ */
function calculateSunOutage(params, ctx) {
  var lat = params.lat, lon = params.lon, satLon = params.satLon;
  var diameter = params.diameter, year = params.year;
  var season = params.season, band = params.band;
  var customFreq = params.customFreq;
  // v5.2：星历档（给了 orbit 就走星历，satLon 让位）与纯几何判据
  var orbit = params.orbit || null;
  var criterion = params.criterion === 'geometric' ? 'geometric' : 'degradation';

  var bi = BAND_PARAMS[band] || BAND_PARAMS['Ku'];
  var freq = customFreq || bi.freq;
  var sysTemp = params.sysTemp > 0 ? Number(params.sysTemp) : bi.sysTemp;
  // 太阳亮温：显式 solarTemp 覆盖 > F10.7 连续模型（F10.7 由 IPC 层按目标日期查好传进来，
  // 引擎自己不知道该日该取多少 —— 没传才落到 F107_DEFAULT = 120）。
  var solarTempOverride = params.solarTemp > 0 ? Number(params.solarTemp) : null;
  var f107 = params.f107 > 0 ? Number(params.f107) : F107_DEFAULT;
  var solarModel = params.solarModel === 'legacy' ? 'legacy' : 'norp';
  var f107Meta = (params.f107Meta && typeof params.f107Meta === 'object') ? params.f107Meta : null;
  // 定窗判据：C/N 恶化门限 dB（默认 1 dB，行业预报惯例口径）。
  // 旧参数 cnThreshold 曾是"峰值恶化过滤器"，语义保留为额外过滤（通常不再需要）。
  var degTh = params.degThreshold > 0 ? Number(params.degThreshold) : 1.0;
  var cnFilter = params.cnThreshold || 0;
  var dT = deltaT(year);

  // 分点（纯函数，与卫星位置无关；星历档的汇总量要按分点日正午取，故先算）
  var eqJDE = equinoxJDE(year, season);
  var eqJDut = eqJDE - dT / SECONDS_PER_DAY;
  var seasonName = season === 'vernal' ? '春分' : '秋分';
  var equinoxDateStr = equinoxDateOf(year, season);
  var eqDayJD = Math.floor(eqJDut - 0.5) + 0.5;

  // ECEF 常量（不随时间变化）
  var stn = stnXYZ(lat, lon);
  var satU = null, ae = null, src = null, track = null;
  var satLonEff = null, preMargin = 0.05, ephemSpan = null;
  var satMeta = { noradId: null, epoch: null, epochAgeDays: null, inclDeg: 0 };

  if (orbit) {
    // 星历档：位置随时刻变，交给轨道源（utils/orbitSource.js）；引擎只吃 ECEF
    try { src = (ctx && ctx.orbitSource) || orbitSourceMod.orbitSource(orbit); }
    catch (e) { return { error: true, message: (e && e.message) || '轨道源建立失败' }; }
    var sm = src.summary || {};
    if (!(Math.abs(sm.periodMin - T_SIDEREAL_MIN) <= GSO_PERIOD_TOL_MIN)) {
      return { error: true, message: '非地球同步轨道，日凌预报只支持 GSO' };
    }
    track = satTrackFor(src, ctx, orbit);
    preMargin = 0.05 + Math.abs(Number(sm.inclDeg) || 0) * (2 * PI / T_SIDEREAL_MIN) * 5;
    ephemSpan = src.span
      ? { start: new Date(src.span.startMs).toISOString(), end: new Date(src.span.endMs).toISOString() }
      : null;
    satMeta.noradId = orbit.noradId != null ? String(orbit.noradId) : null;
    satMeta.epoch = sm.epochIso || null;
    satMeta.inclDeg = Number((Number(sm.inclDeg) || 0).toFixed(4));
    if (sm.epochIso) {
      var epJD = orbitSourceMod.msToJd(Date.parse(sm.epochIso));
      if (isFinite(epJD)) satMeta.epochAgeDays = Number((eqDayJD + 0.5 - epJD).toFixed(2));
    }
    // 汇总量（方位 / 仰角 / 星下点经度）取分点日正午（UT）那一拍；短期星历不覆盖分点日时
    // 向两边找最近的有星历的一天，别为了一个汇总读数把整季算不出来。
    var refMs = null, pRef = null;
    for (var dd = 0; dd <= 30 && !pRef; dd++) {
      var cand = dd === 0 ? [0] : [dd, -dd];
      for (var ci = 0; ci < cand.length && !pRef; ci++) {
        var m0 = orbitSourceMod.jdToMs(eqDayJD + cand[ci] + 0.5);
        var p0 = src.posEcefKm(m0);
        if (p0) { refMs = m0; pRef = p0; }
      }
    }
    if (!pRef) return { error: true, message: '星历未覆盖日凌扫描区间，无法计算' };
    ae = satAzElECEF(stn, pRef, lat, lon);
    var lonRef = src.lonAt(refMs);
    satLonEff = isFinite(lonRef) ? Number(lonRef.toFixed(3)) : null;
  } else {
    var sat = satXYZ(satLon);
    satU = unitVec(stn, sat);  // station → satellite 单位向量
    ae = satAzElECEF(stn, sat, lat, lon);
    satLonEff = Number(satLon);
  }

  // 卫星 Az/El（显示用）
  if (ae.el <= 0) {
    return { error: true, message: '卫星在地平线以下，无法计算日凌', satEl: ae.el };
  }

  // 分点日正午的模型快照（供汇总显示：3dB 波束宽 / 门限角 / 主轴对准恶化上限）
  var midSun = solarPosition(eqDayJD + 0.5 + dT / SECONDS_PER_DAY);
  var midSunRad = 0.26656 / midSun.R;
  var midTsun = solarTempOverride != null ? solarTempOverride : solarTempAt(freq, f107, 2 * midSunRad, solarModel);
  var midModel = outageModel(freq, diameter, sysTemp, midTsun, degTh, midSunRad, criterion);

  var scanDays = 30;
  var dailyResults = [];
  var peakIdx = null, maxDurSec = 0;
  // 站→星方向的赤纬：一天里太阳与它的夹角下界 = |δ_sun − δ_sat|（绕极轴旋转不改变赤纬差），
  // 太阳赤纬整天都离它超过门限角的日子不可能有事件——逐日预筛，61 天通常只剩十来天要真扫
  var decSat = orbit ? 0 : Math.asin(Math.max(-1, Math.min(1, satU[2]))) / RAD;
  var coverageDays = 0;

  for (var d = -scanDays; d <= scanDays; d++) {
    var dayJD = eqDayJD + d;

    // 星历档：当天粗表（10 min）既定「有没有星历」，又给逐日预筛的站→星赤纬区间
    var decSatLo = 0, decSatHi = 0;
    if (orbit) {
      var coarse = track.coarse(dayJD);
      if (!coarse) continue;                     // 该天无星历：跳过，且不计入 coverageDays
      var rg = decRange(coarse, stn);
      decSatLo = rg[0]; decSatHi = rg[1];
    }
    coverageDays++;

    // 每天正午太阳视半径（0.26656° = 959.63″ 为1AU处标准值，除以实际日地距离R得到当日视半径）
    var noonJDE = dayJD + 0.5 + dT / SECONDS_PER_DAY;
    var noonSun = solarPosition(noonJDE);
    var sunRad = 0.26656 / noonSun.R;       // 度
    var tSun = solarTempOverride != null ? solarTempOverride : solarTempAt(freq, f107, 2 * sunRad, solarModel);
    var model = outageModel(freq, diameter, sysTemp, tSun, degTh, sunRad, criterion);
    if (model.thetaTh <= 0) continue;   // 当日即使主轴对准，恶化也不足门限 → 无事件

    // 当天太阳（两端各一次 VSOP87，日内插值）+ 赤纬预筛（留 0.05° 给插值误差）
    var day = daySun(dayJD, dT);
    var fine = null;
    if (orbit) {
      var mg = model.thetaTh + preMargin;        // 星历档：卫星赤纬也是区间，对区间判
      if (day.decLo - decSatHi > mg || day.decHi - decSatLo < -mg) continue;
      fine = track.fine(dayJD);                  // 过了预筛才铺 60 s 细表
      if (!fine) continue;
    } else {
      if (day.decLo - decSat > model.thetaTh + 0.05 || day.decHi - decSat < -(model.thetaTh + 0.05)) continue;
    }

    // 事件求根：f(s) = θ_th − 夹角(s)，>0 在窗口内；太阳在地平线下 → NaN（窗口外）
    var fDay = orbit
      ? (function (dy, th, ft) {
          return function (s) {
            var sd = dy.dir(s);
            return sunUp(lat, lon, sd) ? th - vecAngle(satUAt(ft, stn, s), sd) : NaN;
          };
        })(day, model.thetaTh, fine)
      : (function (dy, th) {
          return function (s) {
            var r = sepAtSec(dy, s, satU, lat, lon);
            return r.up ? th - r.sep : NaN;
          };
        })(day, model.thetaTh);
    var wins = findWindows(fDay, 0, 86399, { coarseStep: 15, tol: 0.5 });
    if (!wins.length) continue;
    // GEO 日凌每天至多一个真窗口；防御性取峰值最深的那个
    var w = wins[0];
    for (var wi = 1; wi < wins.length; wi++) {
      if (wins[wi].peak && (!w.peak || wins[wi].peak.value > w.peak.value)) w = wins[wi];
    }

    var pStart = Math.round(w.start);
    var pEnd = Math.round(w.end);
    var dur = pEnd - pStart;
    if (dur <= 0) continue;
    var pkSec = w.peak ? Math.round(w.peak.t) : Math.round((pStart + pEnd) / 2);
    var pkSep = w.peak ? Math.max(0, model.thetaTh - w.peak.value) : model.thetaTh;
    var cn = degradationAt(pkSep, model, sysTemp);
    if (cn < cnFilter) continue;

    var dd = jdToDate(dayJD);
    // 北京时日期：UTC 时刻 +8h 跨日则记为次日（中国站日凌在 UTC 白天，一般不跨）
    var bjtShift = (pStart + 28800) >= SECONDS_PER_DAY ? 1 : 0;
    var bd = bjtShift ? jdToDate(dayJD + 1) : dd;

    // 强度按峰值恶化分级：≥10dB 深度中断（链路必然失锁）、3~10dB 显著、其余轻度
    var intensity, intensityClass;
    if (cn >= 10) { intensity = '高'; intensityClass = 'so-intensity-high'; }
    else if (cn >= 3) { intensity = '中'; intensityClass = 'so-intensity-mid'; }
    else { intensity = '低'; intensityClass = 'so-intensity-low'; }

    var rec = {
      date:           fmtDate(dd.y, dd.m, dd.d),
      dateBJT:        fmtDate(bd.y, bd.m, bd.d),
      startTimeUTC:   secStr(pStart),
      endTimeUTC:     secStr(pEnd),
      peakTimeUTC:    secStr(pkSec),
      startTimeBJT:   secStr(toBJT(pStart)),
      endTimeBJT:     secStr(toBJT(pEnd)),
      peakTimeBJT:    secStr(toBJT(pkSec)),
      durationSec:    dur,
      durationStr:    fmtDur(dur),
      peakSeparation: Number(pkSep.toFixed(3)),
      peakCNdeg:      Number(cn.toFixed(2)),
      thresholdDeg:   Number(model.thetaTh.toFixed(3)),
      intensity:      intensity,
      intensityClass: intensityClass,
      isPeak:         false
    };
    if (orbit) {
      var lp = src.lonAt(orbitSourceMod.jdToMs(dayJD) + pkSec * 1000);   // 峰值时刻星下点经度
      rec.satLon = isFinite(lp) ? Number(lp.toFixed(3)) : null;
    }
    dailyResults.push(rec);
    if (dur > maxDurSec) { maxDurSec = dur; peakIdx = dailyResults.length - 1; }
  }

  if (peakIdx !== null) dailyResults[peakIdx].isPeak = true;

  var total = dailyResults.length;
  return {
    error: false,
    seasonName:     seasonName,
    equinoxDate:    equinoxDateStr,
    beamWidth:      Number(midModel.thetaB.toFixed(3)),          // 真实 3dB 波束宽 70λ/D
    thresholdAngle: Number(Math.max(0, midModel.thetaTh).toFixed(3)),  // 分点日门限角
    satAz:          Number(ae.az.toFixed(2)),
    satEl:          Number(ae.el.toFixed(2)),
    frequency:      freq,
    satSource:      orbit ? 'ephemeris' : 'slot',
    satLonEff:      satLonEff,
    coverageDays:   coverageDays,
    totalDays:      total,
    startDate:      total > 0 ? dailyResults[0].date : '--',
    endDate:        total > 0 ? dailyResults[total - 1].date : '--',
    maxDurationSec: maxDurSec,
    maxDurationStr: fmtDur(maxDurSec),
    peakRecord:     peakIdx !== null ? dailyResults[peakIdx] : null,
    dailyResults:   dailyResults,
    // 模型快照（报告"模型假设"块 / UI 汇总用）
    model: {
      degThreshold:  degTh,
      sysTemp:       sysTemp,
      solarTemp:     Math.round(midTsun),                                    // 分点日实际采用的太阳亮温
      solarTempSource: solarTempOverride != null ? 'manual' : 'f107',
      f107:          solarTempOverride != null ? null : f107,
      // v5.3：太阳亮温模型档与 F10.7 的出处（IPC 层查好后原样传进来，这里只回显，供读数与报告）
      solarModel:    solarModel,
      f107Source:    (f107Meta && f107Meta.source) || 'default',
      f107At:        (f107Meta && f107Meta.at != null) ? f107Meta.at : null,
      f107FetchedAt: (f107Meta && f107Meta.fetchedAt != null) ? f107Meta.fetchedAt : null,
      f107Low:       (f107Meta && Number.isFinite(Number(f107Meta.low))) ? Number(f107Meta.low) : null,
      f107High:      (f107Meta && Number.isFinite(Number(f107Meta.high))) ? Number(f107Meta.high) : null,
      diameter:      diameter,
      beamWidth3dB:  Number(midModel.thetaB.toFixed(3)),
      sunDiameter:   Number(midModel.thetaD.toFixed(3)),
      boresightDeg:  Number(degradationAt(0, midModel, sysTemp).toFixed(2)), // 主轴对准恶化上限
      // v5.2：取星来源与定窗判据（degThreshold 在纯几何档下不参与定窗，仍原样回显）
      satSource:     orbit ? 'ephemeris' : 'slot',
      noradId:       satMeta.noradId,
      epoch:         satMeta.epoch,
      epochAgeDays:  satMeta.epochAgeDays,
      inclDeg:       satMeta.inclDeg,
      ephemSpan:     ephemSpan,
      criterion:     criterion,
      thresholdAngleSource: criterion === 'geometric' ? 'beamwidth' : 'degradation'
    }
  };
}

/**
 * 一站一星的春秋两季（批量入口）。
 * params.seasons 缺省或为空 → 两季都算；未选的季回 null（SLA 那条链路不传 seasons，行为不变）。
 * ctx 原样透传：一批站共用同一份轨道源与轨迹表，一颗星一季只采样一次。
 */
function calculateSunOutageSeasons(params, ctx) {
  var p0 = params || {};
  var want = (Array.isArray(p0.seasons) && p0.seasons.length) ? p0.seasons : ['vernal', 'autumnal'];
  var out = { vernal: null, autumnal: null };
  for (var i = 0; i < want.length; i++) {
    var s = want[i] === 'autumnal' ? 'autumnal' : (want[i] === 'vernal' ? 'vernal' : null);
    if (!s || out[s]) continue;
    var p = {};
    for (var k in p0) if (Object.prototype.hasOwnProperty.call(p0, k)) p[k] = p0[k];
    p.season = s;
    delete p.seasons;
    out[s] = calculateSunOutage(p, ctx);
  }
  return out;
}

/* ============================================================
 * 工具函数
 * ============================================================ */
function jdToDate(jd) {
  var Z = Math.floor(jd + 0.5);
  var F = jd + 0.5 - Z;
  var AA = Math.floor((Z - 1867216.25) / 36524.25);
  var B = Z + 1 + AA - Math.floor(AA / 4) + 1524;
  var C = Math.floor((B - 122.1) / 365.25);
  var D = Math.floor(365.25 * C);
  var E = Math.floor((B - D) / 30.6001);
  var day = B - D - Math.floor(30.6001 * E) + F;
  var mon = E < 14 ? E - 1 : E - 13;
  var yr  = mon > 2 ? C - 4716 : C - 4715;
  return { y: yr, m: mon, d: Math.floor(day) };
}

function toBJT(sec) {
  return ((sec + 28800) % SECONDS_PER_DAY + SECONDS_PER_DAY) % SECONDS_PER_DAY;
}

function secStr(s) {
  s = ((s % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sc = s % 60;
  return pad2(h) + ':' + pad2(m) + ':' + pad2(sc);
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function fmtDur(sec) {
  if (sec < 60) return sec + 's';
  var m = Math.floor(sec / 60), s = sec % 60;
  return s > 0 ? m + 'm' + s + 's' : m + 'm';
}

function fmtDate(y, m, d) {
  return y + '-' + pad2(m) + '-' + pad2(d);
}

/* ============================================================
 * 二期（卫星模型工具 §6.8，DESIGN2 D10–D13）：太阳噪温 · 太阳位置 · 地球遮挡 —— 地面日凌与星侧太阳侵入共用
 *
 * ★ 只追加：上面任何函数一个字不改（_nutation 也不动），这里只是把已有内核拼成共享函数：
 *   sunNoiseTemp      ΔT = T_b·K·可见比例（T_b = solarTempAt，K = couplingAt）——与 degradationAt 同输入逐位同值（单测把
 *                     本文件原样载入、取出内部 degradationAt / outageModel 对拍）
 *   sunEcefAt         与 daySun(dayJD, deltaT(year)).dir(sec) 逐位同值（同一组表达式；按 UT 日缓存两端 VSOP87）
 *   sunDiamDegAt      2·(0.26656 / R_正午)，与 calculateSunOutage 逐日取的视直径同一口径
 *   earthBlockFraction 日面被地盘挡住的比例（圆锥 + 半影，两圆盘重叠面积 / 日面面积）——与 models/attitude.mjs 的
 *                     eclipseFactor（D13 唯一实现）同一套式子的 CJS 镜像：blocked = 1 − eclipseFactor（单测对拍）
 *   satSunIntrusionSeries 星侧逐样本批量：太阳方向（含卫星处视差）→ 地球遮挡 → 偏轴角 → ΔT / ΔG/T，IPC 直接调它
 * ============================================================ */

var SUN_RADIUS_KM_NOMINAL = 695700;   // IAU 2015 B3 名义太阳半径（= attitude.mjs 的 SUN_RADIUS_KM）
var EARTH_RADIUS_KM_MEAN = 6371;      // 地影口径的球地球半径（= attitude.mjs 的 EARTH_RADIUS_KM，D13 同口径）
var AU_KM_NOMINAL = 1.495978707e8;    // 天文单位（IAU 2012 B2）
var DAY_MS = 86400000;

// 按 UT 日缓存：当天 0h / 24h 两次 VSOP87（与 daySun 同）+ 正午一次（视直径与日地距离，与 calculateSunOutage 逐日同）。
// 星侧时间序列一天几千拍，只在跨日时算 3 次 VSOP87；最多留 64 天。
var _sunDayCache = new Map();
function _sunDay(utcMs) {
  var d0 = Math.floor(utcMs / DAY_MS) * DAY_MS;
  var hit = _sunDayCache.get(d0);
  if (hit) return hit;
  var dayJD = d0 / DAY_MS + 2440587.5;                 // UT 0h 的儒略日（X.5，精确可表示，与 eqDayJD + d 同值）
  var dT = deltaT(new Date(d0).getUTCFullYear());
  var a = solarPosition(dayJD + dT / SECONDS_PER_DAY);
  var b = solarPosition(dayJD + 1 + dT / SECONDS_PER_DAY);
  var dra = b.ra - a.ra;
  if (dra > 180) dra -= 360; else if (dra < -180) dra += 360;
  var noonSun = solarPosition(dayJD + 0.5 + dT / SECONDS_PER_DAY);
  var sunRad = 0.26656 / noonSun.R;
  var rec = { d0: d0, dayJD: dayJD, a: a, b: b, dra: dra, nut: a.dpsi * Math.cos(a.eps0 * RAD), diam: 2 * sunRad, R: noonSun.R };
  _sunDayCache.set(d0, rec);
  if (_sunDayCache.size > 64) _sunDayCache.delete(_sunDayCache.keys().next().value);
  return rec;
}

/**
 * 太阳单位矢量（标准 ECEF，z 为极轴），UTC 毫秒。与日凌扫描用的 daySun(...).dir(sec) 逐位同值（VSOP87 + IAU80 章动，~1″）。
 * @param {number} utcMs
 * @param {number[]} [out]
 */
function sunEcefAt(utcMs, out) {
  var o = out || [0, 0, 0];
  var d = _sunDay(utcMs), a = d.a, b = d.b;
  var sec = (utcMs - d.d0) / 1000;
  var u = sec / SECONDS_PER_DAY;
  var raR = (a.ra + d.dra * u) * RAD;
  var decR = (a.dec + (b.dec - a.dec) * u) * RAD;
  var gastR = (gmst(d.dayJD + sec * JD_SEC) + d.nut) * RAD;
  var cd = Math.cos(decR);
  o[0] = cd * Math.cos(raR - gastR); o[1] = cd * Math.sin(raR - gastR); o[2] = Math.sin(decR);
  return o;
}

/** 当日（UT）太阳视直径（°）：2·(0.26656 / R_正午)，与 calculateSunOutage 逐日 outageModel 用的 θ_d 同值。 */
function sunDiamDegAt(utcMs) { return _sunDay(utcMs).diam; }
/** 当日（UT 正午）日地距离（AU），VSOP87。 */
function sunDistAuAt(utcMs) { return _sunDay(utcMs).R; }

/**
 * 从卫星看，日面被地球圆盘挡住的比例（0 = 不挡，1 = 全挡）。
 *   日面角半径 a = asin(R☉ / |s − r|)、地球角半径 b = asin(R⊕ / |r|)、两圆心角距 c = ∠(s − r, −r)；
 *   c ≥ a + b → 0；c ≤ b − a → 1；c ≤ a − b（环食）→ b²/a²；其余 = 两圆盘重叠面积 / πa²（弓形之和）。
 * 太阳距离缺省由视直径反推：d = R☉ / sin(θ_d / 2)（地心处看到的角半径恰为 θ_d / 2）。卫星在地球内部返回 1。
 * @param {number[]} satEcefKm
 * @param {number[]} sunDirEcef  太阳单位矢量（地心，ECEF）
 * @param {number} sunDiamDeg
 * @param {{earthRadiusKm?:number, sunDistKm?:number}} [opts]
 */
function earthBlockFraction(satEcefKm, sunDirEcef, sunDiamDeg, opts) {
  var Re = (opts && opts.earthRadiusKm > 0) ? opts.earthRadiusKm : EARTH_RADIUS_KM_MEAN;
  var Rs = SUN_RADIUS_KM_NOMINAL;
  var th = sunDiamDeg > 0 ? sunDiamDeg : SUN_DIAM_1AU;
  var sunDist = (opts && opts.sunDistKm > 0) ? opts.sunDistKm : Rs / Math.sin(th / 2 * RAD);
  var rx = satEcefKm[0], ry = satEcefKm[1], rz = satEcefKm[2];
  // ★ 用 Math.hypot 而不是 sqrt(x²+y²+z²)：与 eclipseFactor 逐运算同式。半影边缘 acos(x/a) 的 x/a 贴近 ±1，
  //   导数发散，1 ulp 的模长差会被放大到 ~1e-9；同式才能保证 blocked ≡ 1 − eclipseFactor 到 1e-16 量级。
  var rn = Math.hypot(rx, ry, rz);
  if (!(rn > Re)) return 1;
  var sl = Math.hypot(sunDirEcef[0], sunDirEcef[1], sunDirEcef[2]);
  var tx = (sunDirEcef[0] / sl) * sunDist - rx, ty = (sunDirEcef[1] / sl) * sunDist - ry, tz = (sunDirEcef[2] / sl) * sunDist - rz;
  var ds = Math.hypot(tx, ty, tz);
  var a = Math.asin(Math.min(1, Rs / ds));
  var b = Math.asin(Math.min(1, Re / rn));
  var cc = -(tx * rx + ty * ry + tz * rz) / (ds * rn);
  var c = Math.acos(Math.max(-1, Math.min(1, cc)));
  if (c >= a + b) return 0;
  if (c <= b - a) return 1;
  if (c <= a - b) return (b * b) / (a * a);
  var x = (c * c + a * a - b * b) / (2 * c);
  var y = Math.sqrt(Math.max(0, a * a - x * x));
  var A = a * a * Math.acos(Math.max(-1, Math.min(1, x / a))) + b * b * Math.acos(Math.max(-1, Math.min(1, (c - x) / b))) - c * y;
  return Math.max(0, Math.min(1, A / (Math.PI * a * a)));
}

/**
 * 太阳落在方向图里引起的噪声温升（地面日凌与星侧太阳侵入共用；亮温模型就是上面的 solarTempAt，不另造）。
 * @param {object} o
 *   freqGHz      接收频率（必填）
 *   offAxisDeg   视轴与日面中心的夹角（°）
 *   方向图三选一：thetaB3dBDeg（高斯主瓣 3 dB 全宽）| diameterM（→ 70λ/D = 20.98547/(f·D)，与 outageModel 同式）|
 *                gainLin | gainDbi（实测方向图【在日面上的平均增益】，线性 / dBi：K = Ω☉·Ḡ/(4π)，Ω☉ = π/4·θ_d²；gainLin 优先）——
 *                  只拿日面中心一个值当 Ḡ 就是小源近似，比高斯档轴上闭式 1 − e^(−x) 偏大 x/(1 − e^(−x)) 倍，x = ln2·(θd/θB)²；
 *                  窄波束（θB ≲ 3θd）要用 satSunIntrusionSeries 那样在日面上求积（SUN_DISK_RULE）
 *   sunDiamDeg | utcMs   当日视直径（°）；给 utcMs 则按 sunDiamDegAt；都没有取 1 AU 值
 *   f107 / solarModel ('norp' 缺省 | 'legacy') / solarTemp（直接覆盖 T_b）
 *   visibleFrac  日面未被遮挡的比例（1 − earthBlockFraction；缺省 1）——半遮挡按弓形面积比例缩放 ΔT
 *   sysTempK     给了就出 gtLossDb = 10·lg(1 + ΔT/T_sys)（= C/N 恶化 = 等效 G/T 损失）
 *   prescreen    true 时偏轴 > 6θ_B + θ_d 直接 K = 0（批量用；与 outageModel 二分上界同一界，缺省关以保逐位）
 * @returns {{Tb, K, dT, gtLossDb:number|null, thetaB:number|null, thetaD, visibleFrac, mode:'gauss'|'gain', f107, solarModel}|null}
 */
function sunNoiseTemp(o) {
  o = o || {};
  var f = Number(o.freqGHz);
  if (!(f > 0)) return null;
  var off = Math.abs(Number(o.offAxisDeg));
  if (!isFinite(off)) return null;
  var thetaD = o.sunDiamDeg > 0 ? Number(o.sunDiamDeg) : (isFinite(o.utcMs) && o.utcMs !== null ? sunDiamDegAt(Number(o.utcMs)) : SUN_DIAM_1AU);
  var f107 = o.f107 > 0 ? Number(o.f107) : F107_DEFAULT;
  var model = o.solarModel === 'legacy' ? 'legacy' : 'norp';
  var Tb = o.solarTemp > 0 ? Number(o.solarTemp) : solarTempAt(f, f107, thetaD, model);
  var vis = (o.visibleFrac === undefined || o.visibleFrac === null) ? 1 : Math.max(0, Math.min(1, Number(o.visibleFrac)));
  if (!(vis >= 0)) vis = 1;
  var thetaB = null, K, mode;
  var gLin = (o.gainLin !== undefined && o.gainLin !== null && Number(o.gainLin) >= 0 && isFinite(o.gainLin)) ? Number(o.gainLin)
    : ((o.gainDbi !== undefined && o.gainDbi !== null && isFinite(o.gainDbi)) ? Math.pow(10, Number(o.gainDbi) / 10) : null);
  if (gLin !== null) {
    mode = 'gain';
    var th = thetaD * RAD;
    K = (Math.PI / 4 * th * th) * gLin / (4 * Math.PI);
  } else {
    thetaB = o.thetaB3dBDeg > 0 ? Number(o.thetaB3dBDeg) : (o.diameterM > 0 ? 20.98547 / (f * Number(o.diameterM)) : null);
    if (!(thetaB > 0)) return null;
    mode = 'gauss';
    K = (o.prescreen && off > 6 * thetaB + thetaD) ? 0 : couplingAt(off, thetaB, thetaD);
  }
  var dT = Tb * K * vis;
  var sys = o.sysTempK > 0 ? Number(o.sysTempK) : null;
  return {
    Tb: Tb, K: K, dT: dT,
    gtLossDb: sys ? 10 * Math.log10(1 + dT / sys) : null,
    thetaB: thetaB, thetaD: thetaD, visibleFrac: vis, mode: mode, f107: f107, solarModel: model
  };
}

/*
 * 日面平均增益的求积点（单位圆盘上，权和 = 1）：径向在 u = r² 上取 3 点 Gauss–Legendre（圆盘面积元 dA ∝ du，所以对 u 均匀），
 * 方位 8 等分，共 24 点——对 u 的 5 次多项式、方位 7 阶三角多项式精确。以高斯主瓣回调对 couplingAt 闭式核（sunNoiseTemp 单测，
 * 差值里还含 couplingAt 自身的平面近似与 48 段 Simpson 误差）：θB = 0.58°（18 m S 频段）偏轴 ≤ 1° 最差 9.6e-4；
 * θB = 1.25°（1.2 m Ku）偏轴 ≤ 2.5° 最差 3.6e-5。只取日面中心一点（小源近似）在 θB = 0.58° 时轴上 +32 %、偏 1° 处 −77 %。
 * 每点 [x, y, 权]。
 */
var SUN_DISK_RULE = (function () {
  var gl = [[-0.7745966692414834, 5 / 18], [0, 8 / 18], [0.7745966692414834, 5 / 18]];   // [-1,1] 上权 5/9·8/9·5/9 → 映到 u∈[0,1] 权减半
  var pts = [];
  for (var i = 0; i < gl.length; i++) {
    var rf = Math.sqrt((gl[i][0] + 1) / 2);
    for (var j = 0; j < 8; j++) { var ph = Math.PI * j / 4; pts.push([rf * Math.cos(ph), rf * Math.sin(ph), gl[i][1] / 8]); }
  }
  return pts;
})();

/**
 * 星侧太阳侵入：逐样本批量（主进程 IPC sunoutage:satIntrusion 直接调它；纯函数、不联网）。
 * @param {object} o
 *   samples   Float64Array，每样本 10 个数：tMs, 卫星 ECEF xyz（km）, 视轴 ECEF xyz（单位）, up ECEF xyz（单位；只有 gain 档用）
 *   freqGHz / sysTempK / f107 / solarModel / solarTemp   同 sunNoiseTemp
 *   pattern   {kind:'gauss', thetaB3dBDeg} | {kind:'diameter', diameterM} |
 *             {kind:'gain', gainAt(dirAnt:[x,y,z]) → dBi|null, fallbackThetaB3dBDeg?}（dirAnt = 天线系单位矢量：z = 视轴、y = up、x = y × z；
 *              每拍在日面上按 SUN_DISK_RULE 取 24 个方向求线性平均增益（不是只取日面中心——窄波束下小源近似会差几十 %）；
 *              传给回调的数组每次复用（零分配），回调里要留就自己拷；
 *              GRD 网格通常只盖地球盘附近，任一点取不到（null）时整拍退回高斯主瓣 fallbackThetaB3dBDeg，再没有记 0）
 *   earthRadiusKm  地球遮挡用（缺省 6371，D13）
 * 太阳方向取「卫星 → 太阳」：地心太阳单位矢量 × 当日日地距离 − 卫星位置（GEO 处视差约 0.016°，对 0.3° 量级窄波束不可忽略）。
 * @returns {{n, dT:Float64Array, gtLossDb:Float64Array, offAxisDeg:Float64Array, visibleFrac:Float64Array,
 *            worst:{i, tMs, dT, gtLossDb, offAxisDeg}|null, counts:{gain, gauss, none, blocked}}}
 *   counts：gain = 用实测方向图的拍数、gauss = 高斯档（含 gain 退回）、none = 没有可用方向图记 0、blocked = 日面全被地球挡住
 */
function satSunIntrusionSeries(o) {
  o = o || {};
  var S = o.samples, n = S ? Math.floor(S.length / 10) : 0;
  var dTs = new Float64Array(n), gl = new Float64Array(n), offs = new Float64Array(n), viss = new Float64Array(n);
  var pat = o.pattern || {};
  var sys = o.sysTempK > 0 ? Number(o.sysTempK) : 500;
  var s = [0, 0, 0], rv = [0, 0, 0], eo = { earthRadiusKm: o.earthRadiusKm, sunDistKm: 0 }, worst = null, dir = [0, 0, 0];
  var counts = { gain: 0, gauss: 0, none: 0, blocked: 0 };
  for (var i = 0; i < n; i++) {
    var k = i * 10, t = S[k];
    var rx = S[k + 1], ry = S[k + 2], rz = S[k + 3], bx = S[k + 4], by = S[k + 5], bz = S[k + 6];
    sunEcefAt(t, s);
    var diam = sunDiamDegAt(t), dist = sunDistAuAt(t) * AU_KM_NOMINAL;
    var vx = s[0] * dist - rx, vy = s[1] * dist - ry, vz = s[2] * dist - rz, vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
    vx /= vl; vy /= vl; vz /= vl;
    var bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
    var off = Math.acos(Math.max(-1, Math.min(1, (vx * bx + vy * by + vz * bz) / bl))) * DEG;
    rv[0] = rx; rv[1] = ry; rv[2] = rz; eo.sunDistKm = dist;
    var vis = 1 - earthBlockFraction(rv, s, diam, eo);
    var r = null;
    if (vis > 0) {
      var q = { freqGHz: o.freqGHz, f107: o.f107, solarModel: o.solarModel, solarTemp: o.solarTemp, sysTempK: sys, prescreen: true,
                offAxisDeg: off, sunDiamDeg: diam, visibleFrac: vis };
      if (pat.kind === 'gain' && typeof pat.gainAt === 'function') {
        // 天线系：z = 视轴、y = up（去视轴分量）、x = y × z
        var zx = bx / bl, zy = by / bl, zz = bz / bl;
        var ux = S[k + 7], uy = S[k + 8], uz = S[k + 9], ud = ux * zx + uy * zy + uz * zz;
        ux -= ud * zx; uy -= ud * zy; uz -= ud * zz;
        var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= ul; uy /= ul; uz /= ul;
        var xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
        // 日面中心在天线系 c，再取 c 的两根正交横轴 e1 / e2（避开与 c 最平行的坐标轴）
        var cx = vx * xx + vy * xy + vz * xz, cy = vx * ux + vy * uy + vz * uz, cz = vx * zx + vy * zy + vz * zz;
        var ax = Math.abs(cx), ay = Math.abs(cy), az = Math.abs(cz);
        var e1x, e1y, e1z;                                          // e1 = c × (最不平行的坐标轴)
        if (ax <= ay && ax <= az) { e1x = 0; e1y = cz; e1z = -cy; } else if (ay <= az) { e1x = -cz; e1y = 0; e1z = cx; } else { e1x = cy; e1y = -cx; e1z = 0; }
        var el = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z); e1x /= el; e1y /= el; e1z /= el;
        var e2x = cy * e1z - cz * e1y, e2y = cz * e1x - cx * e1z, e2z = cx * e1y - cy * e1x;
        var rad = diam / 2 * RAD, gsum = 0, okAll = true;
        for (var p = 0; p < SUN_DISK_RULE.length; p++) {
          var P = SUN_DISK_RULE[p], rho = Math.hypot(P[0], P[1]) * rad;
          var cr = Math.cos(rho), sr = rho > 0 ? Math.sin(rho) / (rho / rad) : 0;  // sin(ρ)·(P/|P|) = sin(ρ)/|P|·P
          dir[0] = cr * cx + sr * (P[0] * e1x + P[1] * e2x);
          dir[1] = cr * cy + sr * (P[0] * e1y + P[1] * e2y);
          dir[2] = cr * cz + sr * (P[0] * e1z + P[1] * e2z);
          var g = pat.gainAt(dir);
          if (g === null || g === undefined || !isFinite(g)) { okAll = false; break; }
          gsum += P[2] * Math.pow(10, g / 10);
        }
        if (okAll) q.gainLin = gsum;
        else if (pat.fallbackThetaB3dBDeg > 0) q.thetaB3dBDeg = pat.fallbackThetaB3dBDeg;
      } else if (pat.kind === 'diameter') q.diameterM = pat.diameterM;
      else q.thetaB3dBDeg = pat.thetaB3dBDeg;
      r = sunNoiseTemp(q);
      if (!r) counts.none++; else if (r.mode === 'gain') counts.gain++; else counts.gauss++;
    } else counts.blocked++;
    dTs[i] = r ? r.dT : 0; gl[i] = r ? r.gtLossDb : 0; offs[i] = off; viss[i] = vis;
    if (!worst || dTs[i] > worst.dT) worst = { i: i, tMs: t, dT: dTs[i], gtLossDb: gl[i], offAxisDeg: off };
  }
  return { n: n, dT: dTs, gtLossDb: gl, offAxisDeg: offs, visibleFrac: viss, worst: worst, counts: counts };
}

module.exports = {
  calculateSunOutage: calculateSunOutage,
  calculateSunOutageSeasons: calculateSunOutageSeasons,
  BAND_PARAMS: BAND_PARAMS,
  // v5.1 模型内核单独导出（测试互验 / UI 预览用）
  solarTempAt: solarTempAt,
  // v5.3：回归谱流量与 legacy 档单独导出（测试逐位对拍 / 交叉验证用）
  solarFluxAt: solarFluxAt,
  solarTempLegacy: solarTempLegacy,
  // 分点日期（IPC 层按目标日取 F10.7 用；别在外面再抄一份分点公式）
  equinoxDateOf: equinoxDateOf,
  couplingAt: couplingAt,
  // 二期（卫星模型工具 §6.8）：太阳噪温 / 太阳位置 / 地球遮挡 / 星侧批量——只追加
  sunNoiseTemp: sunNoiseTemp,
  sunEcefAt: sunEcefAt,
  sunDiamDegAt: sunDiamDegAt,
  sunDistAuAt: sunDistAuAt,
  earthBlockFraction: earthBlockFraction,
  satSunIntrusionSeries: satSunIntrusionSeries,
  SUN_DISK_RULE: SUN_DISK_RULE
};
