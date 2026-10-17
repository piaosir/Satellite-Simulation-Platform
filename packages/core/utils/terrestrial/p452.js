// ITU-R P.452-18（08/2023）地面站间干扰预测 · 晴空传播
//
// 覆盖的机制（附件 1 §4）：
//   §4.1 视距：自由空间 + 气体吸收（三维距离），多径 / 聚焦增强 Esp、Esβ
//   §4.2 绕射：Bullington + 球面地球（delta-Bullington），k50 与 kβ = 3 两次计算后按逆正态内插到 p%
//   §4.3 对流层散射
//   §4.4 波导 / 层反射（含站址遮蔽、海面波导耦合、路径几何与地形起伏修正）
//   §4.5 各机制合成（Fj / Fk 内插 + 功率和）
//   §4.6 传输损耗与离轴角（几何辅助函数）
// 输入路径剖面 d_i / h_i / 代表性杂波高度 / 区域类型（A1 沿海陆地、A2 内陆、B 海），时间百分比 p。
//
// ── 关于「两端杂波的高度增益修正」──────────────────────────────────────────────────────
// P.452-16/17 有 §4.5「附加杂波损耗」：终端埋在地物里时，按表 4 名义高度 ha / 距离 dk 抬高天线、截短路径，
// 再在结果上加 Aht + Ahr（式 (57)(57a)）。P.452-18 删除了这一节，改为「分布式杂波」：把代表性杂波高度
// 加到剖面上（式 (6e)、表 3），离终端 50 m 以内不加——终端周边的地物遮挡由剖面绕射本身体现。
// 因此本模块的缺省口径就是 P.452-18 原文（剖面杂波），并经官方验证数据逐例对拍。
// 另提供两种【可选】终端修正，缺省关闭，只应在剖面不含终端附近杂波（裸地形剖面）时使用，否则重复计入：
//   · model 'p2108'   —— ITU-R P.2108-1 §3.1 终端高度增益修正（现行建议书；天线抬到代表性杂波高度 R
//                        计算基本传输损耗，再加 Ah；适用 0.03–3 GHz）
//   · model 'p452-17' —— P.452-17 §4.5（已被 P.452-18 取代，只为复现旧口径的研究结论）
// ────────────────────────────────────────────────────────────────────────────────────────
//
// 实现口径（与 ITU-R 第 3 研究组 P.452-18 官方实现 Ver 18.0（OFCOM，版权放弃声明）一致，
// 以便与官方验证数据逐位对拍；凡建议书未写死的数值都在此列明）：
//   · 气体比衰减 γo、γw 用 P.676-13 附件 1 逐线法（见 p676.js），干空气压强 / 气温为输入（缺省 1013.25 hPa / 15 °C）。
//   · 波长 λ = 0.2998 / f（m，c = 2.998e8 m/s，同 P.2001）。
//   · ΔN、N0 取路径中点值（附件 1 §3.2 Step 3）：中点 = 自发射端沿大圆朝接收端走剖面全长一半处；
//     地图双线性内插按 P.1144（数据见 data/p452_dn50_n050.bin，scripts/build-itu-p452.mjs 生成）。
//   · 区域分界取相邻异区点的中点（表 2 下注），据此求 dtm、dlm、ω。
//   · dct、dcr（终端到海岸的陆上距离）缺省由区域剖面推出：终端点本身为海 → 0；剖面上无海 → 视为无穷远。
//   · 视距路径的 dlt/dlr 取 Bullington 点（附录 2 式 (141a)），ilr = ilt。
// 未实现：§5 水凝物散射（降雨散射）——见交付说明；地球站协调用的雨散射在 ap7.js 的模式 (2)。
//
// 纯函数（除首次惰性读取随包的 ΔN/N0 地图外无副作用），CommonJS。

const { specificAttenuation } = require('./p676.js');
const { knifeEdgeJ } = require('./common.js');

const LOG10 = Math.log10;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const A_EARTH = 6371;        // 平均地球半径 a（km），式 (6a)
const K_BETA = 3;            // kβ：β0% 时间被超过的等效地球半径因子，式 (6b)

// 表 3：缺省代表性杂波高度（m），加到式 (6e) 的 i = 1 … n−1 点上
const CLUTTER_HEIGHTS = { water_sea: 0, open_rural: 0, suburban: 10, urban_trees_forest: 15, dense_urban: 20 };

// P.452-17 表 4：名义杂波高度 ha（m）与名义距离 dk（km）——仅供 model 'p452-17' 旧口径使用
const LEGACY_CLUTTER_P452_17 = {
  high_crop_fields: { ha: 4, dk: 0.1 }, park_land: { ha: 4, dk: 0.1 }, irregular_sparse_trees: { ha: 4, dk: 0.1 },
  orchard: { ha: 4, dk: 0.1 }, sparse_houses: { ha: 4, dk: 0.1 },
  village_centre: { ha: 5, dk: 0.07 },
  deciduous_trees_irregular: { ha: 15, dk: 0.05 }, deciduous_trees_regular: { ha: 15, dk: 0.05 }, mixed_tree_forest: { ha: 15, dk: 0.05 },
  coniferous_trees_irregular: { ha: 20, dk: 0.05 }, coniferous_trees_regular: { ha: 20, dk: 0.05 },
  tropical_rain_forest: { ha: 20, dk: 0.03 },
  suburban: { ha: 9, dk: 0.025 }, dense_suburban: { ha: 12, dk: 0.02 }, urban: { ha: 20, dk: 0.02 },
  dense_urban: { ha: 25, dk: 0.02 }, high_rise_urban: { ha: 35, dk: 0.02 }, industrial_zone: { ha: 20, dk: 0.05 }
};

// ---------------------------------------------------------------------------
// 无线电气象地图（附录 1 §2）：ΔN（N 单位/km）、N0（N 单位），1.5° 网格
// ---------------------------------------------------------------------------

const MAP_FILE = 'p452_dn50_n050.bin';
let _maps = null;

/** 注入地图数据（.bin 的 Buffer / ArrayBuffer / Uint8Array）。主进程以外的环境读不到文件时用它。 */
function setRadioMetMaps(bin) {
  const u8 = bin instanceof ArrayBuffer ? new Uint8Array(bin)
    : (ArrayBuffer.isView(bin) ? new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength) : null);
  if (!u8 || u8.length < 40) throw new Error('P.452 地图数据为空或过短');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(u8[i]);
  const nLat = dv.getUint16(10, true), nLon = dv.getUint16(12, true), scale = dv.getInt32(32, true);
  if (magic !== 'P452RM18' || dv.getUint16(8, true) !== 1 || nLat !== 121 || nLon !== 241 || scale !== 1000 ||
      u8.length !== 40 + 8 * nLat * nLon) throw new Error('P.452 地图数据格式不符');
  const n = nLat * nLon, dn = new Float64Array(n), n0 = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    dn[k] = dv.getInt32(40 + 4 * k, true) / scale;
    n0[k] = dv.getInt32(40 + 4 * (n + k), true) / scale;
  }
  _maps = { nLat, nLon, step: 1.5, dn, n0 };
  return true;
}

function maps() {
  if (_maps) return _maps;
  let buf = null;
  try {
    // 运行在 Node / Electron 主进程时直读随包文件；打包进渲染端时 fs 不可用，走 setRadioMetMaps 注入
    const fs = require('fs'), path = require('path');
    buf = fs.readFileSync(path.join(__dirname, 'data', MAP_FILE));
  } catch (e) { buf = null; }
  if (!buf) return null;
  setRadioMetMaps(buf);
  return _maps;
}

/**
 * 地图双线性内插（P.1144），与官方实现 get_interp2 同法：行自北纬 90° 起、列自经度 0° 起，越界端点钳到边。
 * @returns {{DN:number, N0:number}|null} 地图不可用时 null
 */
function radioMetAt(latDeg, lonDeg) {
  const m = maps();
  if (!m) return null;
  let lon = lonDeg % 360;
  if (lon < 0) lon += 360;
  const latOff = 90 - latDeg;
  const li = Math.min(Math.max(Math.floor(latOff / m.step), 0), m.nLat - 1);
  const lj = Math.min(Math.max(Math.floor(lon / m.step), 0), m.nLon - 1);
  const fr = latOff / m.step - li, fc = lon / m.step - lj;
  const li2 = Math.min(li + 1, m.nLat - 1), lj2 = Math.min(lj + 1, m.nLon - 1);
  const at = (arr) => {
    const ul = arr[li * m.nLon + lj], ur = arr[li * m.nLon + lj2];
    const ll = arr[li2 * m.nLon + lj], lr = arr[li2 * m.nLon + lj2];
    const y1 = fc * (ur - ul) + ul, y2 = fc * (lr - ll) + ll;
    return fr * (y2 - y1) + y1;
  };
  return { DN: at(m.dn), N0: at(m.n0) };
}

/**
 * 自发射端沿大圆朝接收端走 dKm 处的经纬度（球半径 6 371 km）——用于取路径中点的 ΔN、N0、β0。
 * 与官方实现 great_circle_path 同式（其退化判据漏了 abs，这里补上；只在两站重合 / 极点附近才有差别）。
 */
function pathPoint(txLat, txLon, rxLat, rxLon, dKm) {
  const t = txLat * D2R, r = rxLat * D2R, dLon = (rxLon - txLon) * D2R;
  const cosD = Math.sin(t) * Math.sin(r) + Math.cos(t) * Math.cos(r) * Math.cos(dLon);
  const x1 = Math.sin(r) - cosD * Math.sin(t), y1 = Math.cos(t) * Math.cos(r) * Math.sin(dLon);
  const brg = (Math.abs(x1) < 1e-9 && Math.abs(y1) < 1e-9) ? 0 : Math.atan2(y1, x1);   // 发射端处朝接收端的方位
  const phi = dKm / A_EARTH;
  const s = Math.sin(t) * Math.cos(phi) + Math.cos(t) * Math.sin(phi) * Math.cos(brg);
  const lat = Math.asin(Math.max(-1, Math.min(1, s)));
  const x2 = Math.cos(phi) - s * Math.sin(t), y2 = Math.cos(t) * Math.sin(phi) * Math.sin(brg);
  let lon = (Math.abs(x2) < 1e-9 && Math.abs(y2) < 1e-9) ? txLon : txLon + Math.atan2(y2, x2) * R2D;
  lon = ((lon % 360) + 540) % 360 - 180;
  return { lat: lat * R2D, lon };
}

// ---------------------------------------------------------------------------
// 无线电气象参数（附件 1 §3.2 Step 2–3）
// ---------------------------------------------------------------------------

/** 式 (5)(6a)(6b)：k50、ae、aβ（km）。 */
function effectiveEarthRadius(DN) {
  const k50 = 157 / (157 - DN);
  return { k50, ae: A_EARTH * k50, ab: A_EARTH * K_BETA };
}

/** 式 (3a)：τ = 1 − exp(−4.12e−4 · dlm^2.41) */
function tauOf(dlm) {
  return 1 - Math.exp(-(4.12e-4 * Math.pow(dlm, 2.41)));
}

/**
 * 式 (2)(3)(4)：异常传播点发生率 β0（%）。
 * @param {number} phiDeg 路径中点纬度 @param {number} dtm 最长连续陆地段（km） @param {number} dlm 最长连续内陆段（km）
 */
function beta0(phiDeg, dtm, dlm) {
  const tau = tauOf(dlm);
  let mu1 = Math.pow(Math.pow(10, -dtm / (16 - 6.6 * tau)) + Math.pow(10, -5 * (0.496 + 0.354 * tau)), 0.2);   // 式 (3)
  if (mu1 > 1) mu1 = 1;
  const ap = Math.abs(phiDeg);
  if (ap <= 70) {
    const mu4 = Math.pow(10, (-0.935 + 0.0176 * ap) * LOG10(mu1));                     // 式 (4)
    return Math.pow(10, -0.015 * ap + 1.67) * mu1 * mu4;                               // 式 (2)
  }
  const mu4 = Math.pow(10, 0.3 * LOG10(mu1));
  return 4.17 * mu1 * mu4;
}

/**
 * 式 (1)(1a)：最坏月时间百分比 pw → 年等效时间百分比 p，且限制 12p ≥ pw。
 * @param {number} pw 最坏月百分比 @param {number} phiDeg 路径中点纬度 @param {number} omega 海上路径比例
 */
function worstMonthToAnnual(pw, phiDeg, omega) {
  const c = Math.pow(Math.abs(Math.cos(2 * phiDeg * D2R)), 0.7);
  const GL = Math.abs(phiDeg) <= 45 ? Math.sqrt(1.1 + c) : Math.sqrt(1.1 - c);           // 式 (1a)
  const p = Math.pow(10, (LOG10(pw) + LOG10(GL) - 0.186 * omega - 0.444) / (0.816 + 0.078 * omega));   // 式 (1)
  return Math.max(p, pw / 12);
}

/**
 * 附录 3 式 (158)：P.452 规定的逆累积正态近似 I(x)，x ≤ 0.5 适用，误差 ≤ 0.00054；x < 1e−6 时取 1e−6。
 * 数值上是 F⁻¹(x)（x < 0.5 为负）；§4.2.4 称之为「逆互补累积正态」，与 F⁻¹ 只差符号，式 (41a) 取比值不受影响。
 * 内插因子 Fi 必须用它（不是高精度逆正态），才能与官方验证数据一致。
 */
function invCumNormP452(x) {
  if (x < 0.000001) x = 0.000001;
  const t = Math.sqrt(-2 * Math.log(x));                                                // 式 (158a)
  const xi = ((0.010328 * t + 0.802853) * t + 2.515516698) /
    (((0.001308 * t + 0.189269) * t + 1.432788) * t + 1);                               // 式 (158b)–(158h)
  return xi - t;                                                                        // 式 (158)
}

// ---------------------------------------------------------------------------
// 剖面分析（附录 2）
// ---------------------------------------------------------------------------

function zoneCode(z) {
  if (z === 1 || z === 2 || z === 3) return z;
  const s = String(z).trim().toUpperCase();
  if (s === 'A1' || s === '1') return 1;
  if (s === 'A2' || s === '2') return 2;
  if (s === 'B' || s === '3') return 3;
  return 0;
}

// 区域分段：zone 变化发生在相邻异区点的中点（表 2 下注）。返回各连续段 [起点下标, 终点下标]。
function runs(zone, pred) {
  const out = [];
  let s = -1;
  for (let i = 0; i < zone.length; i++) {
    if (pred(zone[i])) { if (s < 0) s = i; } else if (s >= 0) { out.push([s, i - 1]); s = -1; }
  }
  if (s >= 0) out.push([s, zone.length - 1]);
  return out;
}

function runLength(d, a, b) {
  let L = d[b] - d[a];
  if (b < d.length - 1) L += (d[b + 1] - d[b]) / 2;
  if (a > 0) L += (d[a] - d[a - 1]) / 2;
  return L;
}

/** dtm（陆地 = A1+A2）、dlm（内陆 A2）、ω（海 B 的比例，式 (7)）。 */
function zoneStats(d, zone) {
  let dtm = 0, dlm = 0, db = 0;
  for (const [a, b] of runs(zone, (z) => z === 1 || z === 2)) dtm = Math.max(dtm, runLength(d, a, b));
  for (const [a, b] of runs(zone, (z) => z === 2)) dlm = Math.max(dlm, runLength(d, a, b));
  for (const [a, b] of runs(zone, (z) => z === 3)) db += runLength(d, a, b);
  return { dtm, dlm, omega: db / (d[d.length - 1] - d[0]) };
}

// 缺省 dct / dcr：终端到海岸（陆 / 海分界中点）的陆上距离，km
function coastDistances(d, zone) {
  const n = d.length, dtot = d[n - 1];
  let dct = Infinity, dcr = Infinity;
  if (zone[0] === 3) dct = 0;
  else for (let i = 1; i < n; i++) if (zone[i] === 3) { dct = (d[i - 1] + d[i]) / 2; break; }
  if (zone[n - 1] === 3) dcr = 0;
  else for (let i = n - 2; i >= 0; i--) if (zone[i] === 3) { dcr = dtot - (d[i] + d[i + 1]) / 2; break; }
  return { dct, dcr };
}

/**
 * 附录 2 §4–§5：路径分类、视界角 / 视界距离、角距离、光滑地球高度、有效天线高度、地形起伏。
 * h 为裸地形高度（不含杂波），与官方实现一致。
 * @returns 各量见代码；pathType 'los' | 'transhorizon'
 */
function smoothEarthAnalysis(d, h, htg, hrg, ae, fGHz) {
  const n = d.length, dtot = d[n - 1];
  const hts = h[0] + htg, hrs = h[n - 1] + hrg;

  // §5.1.6.2 最小二乘直线：式 (147)–(150)
  let v1 = 0, v2 = 0;
  for (let i = 1; i < n; i++) {
    v1 += (d[i] - d[i - 1]) * (h[i] + h[i - 1]);
    v2 += (d[i] - d[i - 1]) * (h[i] * (2 * d[i] + d[i - 1]) + h[i - 1] * (d[i] + 2 * d[i - 1]));
  }
  let hst = (2 * v1 * dtot - v2) / (dtot * dtot);
  let hsr = (v2 - v1 * dtot) / (dtot * dtot);

  // §5.1.6.3 绕射模型用光滑地球高度：式 (151a)–(153d)
  let hobs = -Infinity, aobt = -Infinity, aobr = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const H = h[i] - (hts * (dtot - d[i]) + hrs * d[i]) / dtot;                          // 式 (151d)
    if (H > hobs) hobs = H;
    if (H / d[i] > aobt) aobt = H / d[i];
    if (H / (dtot - d[i]) > aobr) aobr = H / (dtot - d[i]);
  }
  let hstp = hst, hsrp = hsr;
  if (hobs > 0) {
    const gt = aobt / (aobt + aobr), gr = aobr / (aobt + aobr);                          // 式 (152e)(152f)
    hstp = hst - hobs * gt;                                                              // 式 (152c)
    hsrp = hsr - hobs * gr;                                                              // 式 (152d)
  }
  const hstd = hstp >= h[0] ? h[0] : hstp;                                               // 式 (153a)(153b)
  const hsrd = hsrp > h[n - 1] ? h[n - 1] : hsrp;                                        // 式 (153c)(153d)

  // §4 路径分类与 §5.1.1–5.1.4 视界角、视界距离：式 (136)–(144a)
  const thetaTd = 1000 * Math.atan((hrs - hts) / (1000 * dtot) - dtot / (2 * ae));       // 式 (139)
  const thetaRd = 1000 * Math.atan((hts - hrs) / (1000 * dtot) - dtot / (2 * ae));       // 式 (142a)
  let thMaxT = -Infinity, lt = 1;
  for (let i = 1; i < n - 1; i++) {
    const th = 1000 * Math.atan((h[i] - hts) / (1000 * d[i]) - d[i] / (2 * ae));         // 式 (138)
    if (th > thMaxT) { thMaxT = th; lt = i; }                                            // 取最小距离者
  }
  let thetaT = Math.max(thMaxT, thetaTd);                                                // 式 (140)
  const pathType = thetaT > thetaTd ? 'transhorizon' : 'los';                            // 式 (136)
  let dlt = d[lt];                                                                       // 式 (141)
  let thMaxR = -Infinity, lr = n - 2;
  for (let i = 1; i < n - 1; i++) {
    const th = 1000 * Math.atan((h[i] - hrs) / (1000 * (dtot - d[i])) - (dtot - d[i]) / (2 * ae));   // 式 (143)
    if (th >= thMaxR) { thMaxR = th; lr = i; }                                           // 取离接收端最近者
  }
  let thetaR = Math.max(thMaxR, thetaRd);                                                // 式 (142b)
  let dlr = dtot - d[lr];                                                                // 式 (144)

  if (pathType === 'los') {
    thetaT = thetaTd;
    thetaR = thetaRd;
    // 式 (141a)：视距路径取绕射参数 ν 最大的点（Bullington 点）。运算次序照官方实现，确保并列点的取舍一致。
    const lambda = 0.2998 / fGHz, Ce = 1 / ae;
    let numax = -Infinity, kmax = 1;
    for (let i = 1; i < n - 1; i++) {
      const di = d[i];
      const nu = (h[i] + 500 * Ce * di * (dtot - di) - (hts * (dtot - di) + hrs * di) / dtot) *
        Math.sqrt(0.002 * dtot / (lambda * di * (dtot - di)));
      if (nu >= numax) { numax = nu; kmax = i; }
    }
    lt = kmax;
    dlt = d[lt];
    dlr = dtot - dlt;                                                                    // 式 (144a)
    lr = lt;
  }
  const theta = 1e3 * dtot / ae + thetaT + thetaR;                                       // 式 (145)

  // §5.1.6.4 波导 / 层反射模型用参数：式 (154a)–(157)
  hst = Math.min(hst, h[0]);
  hsr = Math.min(hsr, h[n - 1]);
  const m = (hsr - hst) / dtot;                                                          // 式 (155)
  const hte = htg + h[0] - hst, hre = hrg + h[n - 1] - hsr;                              // 式 (156)
  let hm = -Infinity;
  for (let i = lt; i <= lr; i++) hm = Math.max(hm, h[i] - (hst + m * d[i]));             // 式 (157)
  if (!Number.isFinite(hm)) hm = 0;

  return { dtot, hts, hrs, hst, hsr, hstd, hsrd, hte, hre, hm, dlt, dlr, ilt: lt, ilr: lr, thetaT, thetaR, theta, pathType };
}

// ---------------------------------------------------------------------------
// §4.1 视距
// ---------------------------------------------------------------------------

/** 式 (9)(9a)：路径 dKm 上的气体吸收 Ag（dB）。 */
function gasLoss(fGHz, dKm, rho, pressHPa, tempC) {
  const g = specificAttenuation(fGHz, pressHPa, rho, tempC + 273.15);
  return (g.gammaO + g.gammaW) * dKm;
}

/**
 * 式 (8)–(12)：Lbfsg、Lb0p、Lb0β。d3D 为两天线间三维距离（式 (8a)）。
 */
function losLoss({ fGHz, p, b0, omega, d3D, dlt, dlr, pressHPa, tempC }) {
  const Ag = gasLoss(fGHz, d3D, 7.5 + 2.5 * omega, pressHPa, tempC);
  const Lbfsg = 92.4 + 20 * LOG10(fGHz) + 20 * LOG10(d3D) + Ag;                          // 式 (8)
  const k = 2.6 * (1 - Math.exp(-0.1 * (dlt + dlr)));
  const Esp = k * LOG10(p / 50);                                                         // 式 (10a)
  const Esb = k * LOG10(b0 / 50);                                                        // 式 (10b)
  return { Lbfsg, Lb0p: Lbfsg + Esp, Lb0b: Lbfsg + Esb, Esp, Esb, Ag };                   // 式 (11)(12)
}

// ---------------------------------------------------------------------------
// §4.2 绕射
// ---------------------------------------------------------------------------

/**
 * §4.2.1 Bullington 部分，式 (14)–(22)。g 为含代表性杂波的剖面高度（m amsl），hts/hrs 为天线海拔。
 */
function bullingtonLoss(d, g, hts, hrs, ap, fGHz) {
  const n = d.length, dtot = d[n - 1] - d[0];
  const Ce = 1 / ap, lambda = 0.2998 / fGHz;
  let Stim = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const s = (g[i] + 500 * Ce * d[i] * (dtot - d[i]) - hts) / d[i];                    // 式 (14)
    if (s > Stim) Stim = s;
  }
  const Str = (hrs - hts) / dtot;                                                        // 式 (15)
  let Luc;
  if (Stim < Str) {
    // 情形 1：视距。式 (16)(17)
    let numax = -Infinity;
    for (let i = 1; i < n - 1; i++) {
      const di = d[i];
      const nu = (g[i] + 500 * Ce * di * (dtot - di) - (hts * (dtot - di) + hrs * di) / dtot) *
        Math.sqrt(0.002 * dtot / (lambda * di * (dtot - di)));
      if (nu > numax) numax = nu;
    }
    Luc = knifeEdgeJ(numax);
  } else {
    // 情形 2：超视距。式 (18)–(21)
    let Srim = -Infinity;
    for (let i = 1; i < n - 1; i++) {
      const s = (g[i] + 500 * Ce * d[i] * (dtot - d[i]) - hrs) / (dtot - d[i]);          // 式 (18)
      if (s > Srim) Srim = s;
    }
    const dbp = (hrs - hts + Srim * dtot) / (Stim + Srim);                               // 式 (19)
    const nub = (hts + Stim * dbp - (hts * (dtot - dbp) + hrs * dbp) / dtot) *
      Math.sqrt(0.002 * dtot / (lambda * dbp * (dtot - dbp)));                           // 式 (20)
    Luc = knifeEdgeJ(nub);                                                               // 式 (21)
  }
  return Luc + (1 - Math.exp(-Luc / 6.0)) * (10 + 0.02 * dtot);                          // 式 (22)
}

// §4.2.2.1 一阶残差项球面绕射（单一地面电参数），式 (30)–(37)
function firstTermInner(epsr, sigma, d, hte, hre, adft, fGHz, pol) {
  const f = fGHz;
  let K = 0.036 * Math.pow(adft * f, -1 / 3) * Math.pow((epsr - 1) * (epsr - 1) + (18 * sigma / f) * (18 * sigma / f), -1 / 4);   // 式 (30a)
  if (pol === 'v') K = K * Math.pow(epsr * epsr + (18 * sigma / f) * (18 * sigma / f), 1 / 2);                                   // 式 (30b)
  const K2 = K * K, K4 = K2 * K2;
  const bdft = (1 + 1.6 * K2 + 0.67 * K4) / (1 + 4.5 * K2 + 1.53 * K4);                // 式 (31)
  const X = 21.88 * bdft * Math.pow(f / (adft * adft), 1 / 3) * d;                       // 式 (32)
  const Yt = 0.9575 * bdft * Math.pow(f * f / adft, 1 / 3) * hte;                        // 式 (33a)
  const Yr = 0.9575 * bdft * Math.pow(f * f / adft, 1 / 3) * hre;                        // 式 (33b)
  const FX = X >= 1.6 ? 11 + 10 * LOG10(X) - 17.6 * X : -20 * LOG10(X) - 5.6488 * Math.pow(X, 1.425);   // 式 (34)
  const Gmin = 2 + 20 * LOG10(K);
  const G = (B) => {
    const v = B > 2 ? 17.6 * Math.pow(B - 1.1, 0.5) - 5 * LOG10(B - 1.1) - 8 : 20 * LOG10(B + 0.1 * B * B * B);   // 式 (35)
    return v < Gmin ? Gmin : v;                                                          // G(Y) ≥ 2 + 20lgK
  };
  return -FX - G(bdft * Yt) - G(bdft * Yr);                                              // 式 (36a)(36b)(37)
}

/** §4.2.2.1：Ldft = ω·Ldft,sea + (1−ω)·Ldft,land（式 (29)），陆地 εr = 22、σ = 0.003 S/m，海 εr = 80、σ = 5 S/m。 */
function firstTermLoss(d, hte, hre, adft, fGHz, omega, pol) {
  const land = firstTermInner(22, 0.003, d, hte, hre, adft, fGHz, pol);
  const sea = firstTermInner(80, 5, d, hte, hre, adft, fGHz, pol);
  return omega * sea + (1 - omega) * land;
}

/** §4.2.2 球面地球绕射损耗 Ldsph，式 (23)–(28)。hte/hre 为式 (39a)(39b) 的有效天线高度。 */
function sphericalEarthLoss(d, hte, hre, ap, fGHz, omega, pol) {
  const lambda = 0.2998 / fGHz;
  const dlos = Math.sqrt(2 * ap) * (Math.sqrt(0.001 * hte) + Math.sqrt(0.001 * hre));    // 式 (23)
  if (d >= dlos) return firstTermLoss(d, hte, hre, ap, fGHz, omega, pol);
  const c = (hte - hre) / (hte + hre);                                                   // 式 (25d)
  const m = 250 * d * d / (ap * (hte + hre));                                            // 式 (25e)
  const b = 2 * Math.sqrt((m + 1) / (3 * m)) *
    Math.cos(Math.PI / 3 + 1 / 3 * Math.acos(3 * c / 2 * Math.sqrt(3 * m / Math.pow(m + 1, 3))));   // 式 (25c)
  const dse1 = d / 2 * (1 + b), dse2 = d - dse1;                                         // 式 (25a)(25b)
  const hse = ((hte - 500 * dse1 * dse1 / ap) * dse2 + (hre - 500 * dse2 * dse2 / ap) * dse1) / d;   // 式 (24)
  const hreq = 17.456 * Math.sqrt(dse1 * dse2 * lambda / d);                             // 式 (26)
  if (hse > hreq) return 0;
  const aem = 500 * Math.pow(d / (Math.sqrt(hte) + Math.sqrt(hre)), 2);                  // 式 (27)
  const Ldft = firstTermLoss(d, hte, hre, aem, fGHz, omega, pol);
  if (Ldft < 0) return 0;
  return (1 - hse / hreq) * Ldft;                                                        // 式 (28)
}

/**
 * §4.2.3 delta-Bullington：Ld = Lbulla + max(Ldsph − Lbulls, 0)，式 (38a)–(40)。
 * @returns {{Ld:number, Lbulla:number, Lbulls:number, Ldsph:number}}
 */
function deltaBullington(d, g, hts, hrs, hstd, hsrd, ap, fGHz, omega, pol) {
  const Lbulla = bullingtonLoss(d, g, hts, hrs, ap, fGHz);
  const hts1 = hts - hstd, hrs1 = hrs - hsrd;                                            // 式 (38a)(38b)
  const zeros = new Array(d.length).fill(0);
  const Lbulls = bullingtonLoss(d, zeros, hts1, hrs1, ap, fGHz);
  const Ldsph = sphericalEarthLoss(d[d.length - 1] - d[0], hts1, hrs1, ap, fGHz, omega, pol);   // 式 (39a)(39b)
  return { Ld: Lbulla + Math.max(Ldsph - Lbulls, 0), Lbulla, Lbulls, Ldsph };
}

/**
 * §4.2.4 p% 时间不被超过的绕射损耗：Ld50（ap = ae）、Ldβ（ap = aβ），式 (41a)(41b)(42) 内插。
 */
function diffractionLoss({ d, g, hts, hrs, hstd, hsrd, fGHz, omega, p, b0, ae, ab, pol }) {
  const r50 = deltaBullington(d, g, hts, hrs, hstd, hsrd, ae, fGHz, omega, pol);
  const out = { Ld50: r50.Ld, Ldp: r50.Ld, Ldb: null, Fi: 0, Ldsph50: r50.Ldsph, Lbulla50: r50.Lbulla, Lbulls50: r50.Lbulls };
  if (p >= 50) return out;
  const rb = deltaBullington(d, g, hts, hrs, hstd, hsrd, ab, fGHz, omega, pol);
  const Fi = p > b0 ? invCumNormP452(p / 100) / invCumNormP452(b0 / 100) : 1;            // 式 (41a)(41b)
  out.Ldb = rb.Ld;
  out.Fi = Fi;
  out.Ldp = r50.Ld + Fi * (rb.Ld - r50.Ld);                                              // 式 (42)
  return out;
}

// ---------------------------------------------------------------------------
// §4.3 对流层散射
// ---------------------------------------------------------------------------

/** 式 (45)(45a)(45b)：Lbs；气体吸收按全程 ρ = 3 g/m³。theta 为角距离（mrad）。 */
function troposcatterLoss({ fGHz, p, dtot, theta, N0, Gt, Gr, pressHPa, tempC }) {
  const Lf = 25 * LOG10(fGHz) - 2.5 * Math.pow(LOG10(fGHz / 2), 2);                     // 式 (45a)
  const Lc = 0.051 * Math.exp(0.055 * (Gt + Gr));                                        // 式 (45b)
  const Ag = gasLoss(fGHz, dtot, 3, pressHPa, tempC);
  return 190 + Lf + 20 * LOG10(dtot) + 0.573 * theta - 0.15 * N0 + Lc + Ag -
    10.1 * Math.pow(-LOG10(p / 50), 0.7);                                                // 式 (45)
}

// ---------------------------------------------------------------------------
// §4.4 波导 / 层反射
// ---------------------------------------------------------------------------

/** 式 (46)–(57)：Lba。 */
function ductingLoss({ fGHz, p, dtot, dlt, dlr, dct, dcr, dlm, hts, hrs, hte, hre, hm, thetaT, thetaR, omega, ae, b0, pressHPa, tempC }) {
  const f = fGHz;
  const Alf = f < 0.5 ? 45.375 - 137.0 * f + 92.5 * f * f : 0;                          // 式 (47a)
  const tt2 = thetaT - 0.1 * dlt, tr2 = thetaR - 0.1 * dlr;                              // 式 (48a)
  const Ast = tt2 > 0 ? 20 * LOG10(1 + 0.361 * tt2 * Math.sqrt(f * dlt)) + 0.264 * tt2 * Math.pow(f, 1 / 3) : 0;   // 式 (48)
  const Asr = tr2 > 0 ? 20 * LOG10(1 + 0.361 * tr2 * Math.sqrt(f * dlr)) + 0.264 * tr2 * Math.pow(f, 1 / 3) : 0;
  const Act = (omega >= 0.75 && dct <= dlt && dct <= 5) ? -3 * Math.exp(-0.25 * dct * dct) * (1 + Math.tanh(0.07 * (50 - hts))) : 0;   // 式 (49)(49a)
  const Acr = (omega >= 0.75 && dcr <= dlr && dcr <= 5) ? -3 * Math.exp(-0.25 * dcr * dcr) * (1 + Math.tanh(0.07 * (50 - hrs))) : 0;
  const Af = 102.45 + 20 * LOG10(f) + 20 * LOG10(dlt + dlr) + Alf + Ast + Asr + Act + Acr;   // 式 (47)

  const gammaD = 5e-5 * ae * Math.pow(f, 1 / 3);                                         // 式 (51)
  const tt1 = thetaT <= 0.1 * dlt ? thetaT : 0.1 * dlt;                                  // 式 (52a)
  const tr1 = thetaR <= 0.1 * dlr ? thetaR : 0.1 * dlr;
  const theta1 = 1e3 * dtot / ae + tt1 + tr1;                                            // 式 (52)
  const dI = Math.min(dtot - dlt - dlr, 40);                                             // 式 (57)
  const mu3 = hm > 10 ? Math.exp(-4.6e-5 * (hm - 10) * (43 + 6 * dI)) : 1;               // 式 (56)
  let alpha = -0.6 - 3.5 * 1e-9 * Math.pow(dtot, 3.1) * tauOf(dlm);                     // 式 (55a)，ε = 3.5
  if (alpha < -3.4) alpha = -3.4;
  let mu2 = Math.pow(500 / ae * dtot * dtot / Math.pow(Math.sqrt(hte) + Math.sqrt(hre), 2), alpha);   // 式 (55)
  if (mu2 > 1) mu2 = 1;
  const beta = b0 * mu2 * mu3;                                                           // 式 (54)
  const lb = LOG10(beta);
  const Gamma = 1.076 / Math.pow(2.0058 - lb, 1.012) *
    Math.exp(-(9.51 - 4.8 * lb + 0.198 * lb * lb) * 1e-6 * Math.pow(dtot, 1.13));       // 式 (53a)
  const Ap = -12 + (1.2 + 3.7e-3 * dtot) * LOG10(p / beta) + 12 * Math.pow(p / beta, Gamma);   // 式 (53)
  const Ad = gammaD * theta1 + Ap;                                                       // 式 (50)
  const Ag = gasLoss(f, dtot, 7.5 + 2.5 * omega, pressHPa, tempC);
  return { Lba: Af + Ad + Ag, Af, Ad, Ag, Ast, Asr, Act, Acr, Alf, beta, mu2, mu3, Gamma, Ap, gammaD, theta1 };   // 式 (46)
}

// ---------------------------------------------------------------------------
// 输入整理
// ---------------------------------------------------------------------------

function num(v) { return v === undefined || v === null || v === '' ? NaN : Number(v); }

// 式 (6e) 与其下注：终端点及距任一终端 50 m 以内的点不加代表性杂波高度
function withClutter(d, h, R) {
  const n = d.length, dtot = d[n - 1];
  return h.map((hi, i) => (i === 0 || i === n - 1 || d[i] < 0.05 || d[i] > dtot - 0.05) ? hi : hi + R[i]);
}

function prepareProfile(o) {
  const d = (o.d || []).map(Number), h = (o.h || []).map(Number);
  const n = d.length;
  if (n < 3 || h.length !== n) return { error: '路径剖面至少 3 点（式 (6c)–(6e) 要求 n ≥ 2），且 d、h 等长' };
  if (d[0] !== 0) return { error: '剖面首点须在发射端（d0 = 0）' };
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(d[i]) || !Number.isFinite(h[i])) return { error: `剖面第 ${i} 点不是有效数` };
    if (i > 0 && !(d[i] > d[i - 1])) return { error: `剖面距离须严格递增（第 ${i} 点）` };
  }
  const dtot = d[n - 1];
  let R = null;
  if (Array.isArray(o.g)) {
    if (o.g.length !== n) return { error: 'g 与 d 不等长' };
    R = o.g.map((gi, i) => Number(gi) - h[i]);
  } else if (Array.isArray(o.R)) {
    if (o.R.length !== n) return { error: 'R（代表性杂波高度）与 d 不等长' };
    R = o.R.map(Number);
  } else R = new Array(n).fill(0);
  if (R.some((x) => !Number.isFinite(x))) return { error: '代表性杂波高度含无效数' };
  const g = withClutter(d, h, R);
  let zone;
  if (Array.isArray(o.zone)) {
    if (o.zone.length !== n) return { error: 'zone 与 d 不等长' };
    zone = o.zone.map(zoneCode);
    if (zone.some((z) => z === 0)) return { error: 'zone 只认 A1 / A2 / B（或 1 / 2 / 3）' };
  } else zone = new Array(n).fill(2);   // 表 2 下注：无登记信息时陆地一律按 A2
  return { d, h, g, R, zone, n, dtot, hasClutter: R.some((x, i) => x !== 0 && i > 0 && i < n - 1) };
}

// P.452-17 §4.5.4 Step 1：路径长取 d − dk——截去终端一侧 dk 以内的剖面点，新端点 50 m 规则重算
function trimForLegacyClutter(prof, side, dk) {
  const { d, h, R, zone, n } = prof;
  let a = 0, b = n - 1;
  if (side === 'tx') { a = d.findIndex((x) => x >= dk); if (a < 0) a = n - 1; }
  else { for (let i = n - 1; i >= 0; i--) if (d[i] <= d[n - 1] - dk) { b = i; break; } }
  if (b - a < 2) return null;
  const d0 = d[a];
  const dd = d.slice(a, b + 1).map((x) => x - d0), hh = h.slice(a, b + 1), RR = R.slice(a, b + 1);
  return { d: dd, h: hh, R: RR, g: withClutter(dd, hh, RR), zone: zone.slice(a, b + 1), n: dd.length, dtot: dd[dd.length - 1] };
}

// 终端修正：返回 { htgEff（计算用天线高度）, Ah, trimKm?（旧口径截短距离）, info } 或 { error }
function terminalCorrection(spec, fGHz, hAntenna, warnings, label) {
  if (!spec) return { htgEff: hAntenna, Ah: 0 };
  const model = spec.model || 'p2108';
  if (model === 'p2108') {
    let p2108;
    try { p2108 = require('./p2108.js'); } catch (e) { return { error: '缺少 p2108.js，无法做 P.2108 终端修正' }; }
    const r = p2108.heightGainTerminalCorrection({ fGHz, h: hAntenna, R: spec.R, ws: spec.ws, clutterType: spec.clutterType });
    if (!r || r.error) return { error: `${label}终端修正：${(r && r.error) || 'P.2108 计算失败'}` };
    for (const w of r.warnings || []) warnings.push(`${label}终端修正：${w}`);
    if (!(r.Ah > 0) && hAntenna >= r.R) return { htgEff: hAntenna, Ah: 0, info: Object.assign({ model }, r) };
    // P.2108-1 §3.1：基本传输损耗算到代表性杂波高度 R，再加 Ah
    return { htgEff: r.R, Ah: r.Ah, info: Object.assign({ model }, r) };
  }
  if (model === 'p452-17') {
    const nominal = spec.category ? LEGACY_CLUTTER_P452_17[spec.category] : null;
    const ha = num(spec.ha !== undefined ? spec.ha : nominal && nominal.ha);
    const dk = num(spec.dk !== undefined ? spec.dk : nominal && nominal.dk);
    if (!(ha > 0) || !(dk >= 0)) return { error: `${label}终端修正：P.452-17 口径需要 ha、dk 或表 4 类别` };
    if (!(ha > hAntenna)) return { htgEff: hAntenna, Ah: 0, info: { model, ha, dk, Ah: 0 } };
    const Ffc = 0.25 + 0.375 * (1 + Math.tanh(7.5 * (fGHz - 0.5)));                    // P.452-17 式 (57a)
    const Ah = 10.25 * Ffc * Math.exp(-dk) * (1 - Math.tanh(6 * (hAntenna / ha - 0.625))) - 0.33;   // P.452-17 式 (57)
    return { htgEff: ha, Ah, trimKm: dk, info: { model, ha, dk, Ffc, Ah } };
  }
  return { error: `${label}终端修正：未知 model「${model}」` };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * P.452-18 晴空基本传输损耗 Lb（dB），p% 时间不被超过。
 *
 * @param {object} o
 *   fGHz            频率（GHz，建议书适用约 0.1–50）
 *   p               时间百分比（%，0.001–50）；worstMonth 为真时视为最坏月百分比 pw，按式 (1) 折算
 *   d, h            剖面距离（km，d[0] = 0，严格递增）与地形海拔（m）
 *   R | g           可选：各点代表性杂波高度（m，表 3），或「地形 + 杂波」高度 g（m）；缺省无杂波
 *   zone            可选：各点区域 'A1'|'A2'|'B'（或 1|2|3）；缺省全 A2
 *   htg, hrg        天线离地高度（m）
 *   txLat, txLon, rxLat, rxLon   站址经纬度（度）——取路径中点 ΔN、N0、β0 纬度用
 *   DN, N0          可选：直接给定（覆盖地图）；centreLat 可选：直接给路径中点纬度
 *   Gt, Gr          沿大圆路径朝视界方向的天线增益（dBi），用于对流层散射式 (45b)
 *   pol             'h' | 'v'（缺省 'h'）
 *   dct, dcr        可选：终端到海岸的陆上距离（km）；缺省由区域剖面推出
 *   pressHPa, tempC 干空气压强（缺省 1013.25 hPa）、气温（缺省 15 °C），用于气体吸收
 *   terminalClutter 可选：{ tx, rx }，每端 { model: 'p2108', clutterType, R?, ws? } 或
 *                   { model: 'p452-17', category | ha+dk }——见文件头说明，缺省不做
 * @returns {object} { Lb, 各机制分量与中间量, path: 剖面分析量, warnings } 或 { error }
 */
function basicTransmissionLoss(o) {
  o = o || {};
  const fGHz = num(o.fGHz), p0 = num(o.p);
  const htg0 = num(o.htg), hrg0 = num(o.hrg);
  if (!(fGHz > 0)) return { error: '频率须为正数（GHz）' };
  if (!(p0 > 0 && p0 <= 50)) return { error: '时间百分比 p 须在 (0, 50] 内' };
  if (!(htg0 > 0) || !(hrg0 > 0)) return { error: '天线离地高度 htg、hrg 须为正数（m）' };
  const pol = String(o.pol || 'h').toLowerCase().startsWith('v') ? 'v' : 'h';
  const pressHPa = Number.isFinite(num(o.pressHPa)) ? num(o.pressHPa) : 1013.25;
  const tempC = Number.isFinite(num(o.tempC)) ? num(o.tempC) : 15;
  const Gt = Number.isFinite(num(o.Gt)) ? num(o.Gt) : 0, Gr = Number.isFinite(num(o.Gr)) ? num(o.Gr) : 0;
  const warnings = [];
  if (fGHz < 0.1 || fGHz > 50) warnings.push(`频率 ${fGHz} GHz 超出 P.452-18 的验证范围 0.1–50 GHz`);
  if (p0 < 0.001) warnings.push(`时间百分比 ${p0}% 低于 P.452-18 的适用下限 0.001%`);

  const prof = prepareProfile(o);
  if (prof.error) return prof;
  if (prof.dtot > 10000) warnings.push(`路径长 ${prof.dtot.toFixed(1)} km 超过 P.452-18 的 10 000 km 上限`);

  // 路径中点与无线电气象参数
  const fullStats = zoneStats(prof.d, prof.zone);
  let centreLat = num(o.centreLat), centreLon = num(o.centreLon);
  const haveCoords = [o.txLat, o.txLon, o.rxLat, o.rxLon].every((v) => Number.isFinite(num(v)));
  if (!Number.isFinite(centreLat) && haveCoords) {
    const c = pathPoint(num(o.txLat), num(o.txLon), num(o.rxLat), num(o.rxLon), 0.5 * prof.dtot);
    centreLat = c.lat; centreLon = c.lon;
  }
  let DN = num(o.DN), N0 = num(o.N0);
  if ((!Number.isFinite(DN) || !Number.isFinite(N0)) && Number.isFinite(centreLat) && Number.isFinite(centreLon)) {
    const met = radioMetAt(centreLat, centreLon);
    if (met) { if (!Number.isFinite(DN)) DN = met.DN; if (!Number.isFinite(N0)) N0 = met.N0; }
  }
  if (!Number.isFinite(DN) || !Number.isFinite(N0)) return { error: '缺 ΔN / N0：请给站址经纬度（取地图）或直接给 DN、N0' };
  if (!Number.isFinite(centreLat)) return { error: '缺路径中点纬度：请给站址经纬度或 centreLat' };

  // 最坏月 → 年（式 (1)），ω 用全路径
  let p = p0, pw = null;
  if (o.worstMonth) { pw = p0; p = worstMonthToAnnual(pw, centreLat, fullStats.omega); }

  // 可选终端修正（文件头说明）
  const tc = o.terminalClutter || {};
  const ct = terminalCorrection(tc.tx, fGHz, htg0, warnings, '发射端');
  if (ct.error) return { error: ct.error };
  const cr = terminalCorrection(tc.rx, fGHz, hrg0, warnings, '接收端');
  if (cr.error) return { error: cr.error };
  if ((ct.Ah || cr.Ah) && prof.hasClutter) warnings.push('剖面已含代表性杂波高度，再加终端杂波修正可能重复计入');
  let profCalc = prof;
  if (ct.trimKm) { const t = trimForLegacyClutter(profCalc, 'tx', ct.trimKm); if (!t) return { error: '杂波名义距离之和超过路径长度' }; profCalc = Object.assign({}, profCalc, t); }
  if (cr.trimKm) { const t = trimForLegacyClutter(profCalc, 'rx', cr.trimKm); if (!t) return { error: '杂波名义距离之和超过路径长度' }; profCalc = Object.assign({}, profCalc, t); }
  const htg = ct.htgEff, hrg = cr.htgEff;

  const core = coreLoss({ fGHz, p, pol, Gt, Gr, pressHPa, tempC, DN, N0, centreLat, htg, hrg, prof: profCalc,
    dct: num(o.dct), dcr: num(o.dcr) });
  const Aht = ct.Ah || 0, Ahr = cr.Ah || 0;
  return Object.assign(core, {
    Lb: core.Lb + Aht + Ahr,
    LbClearAir: core.Lb,
    Aht, Ahr,
    terminalClutter: (ct.info || cr.info) ? { tx: ct.info || null, rx: cr.info || null } : null,
    fGHz, p, pw, pol,
    warnings
  });
}

// P.452-18 §4 主体（不含终端修正）
function coreLoss({ fGHz, p, pol, Gt, Gr, pressHPa, tempC, DN, N0, centreLat, htg, hrg, prof, dct, dcr }) {
  const { d, h, g, zone, dtot } = prof;
  const { dtm, dlm, omega } = zoneStats(d, zone);
  const b0 = beta0(centreLat, dtm, dlm);
  const { ae, ab } = effectiveEarthRadius(DN);
  const se = smoothEarthAnalysis(d, h, htg, hrg, ae, fGHz);
  const coast = coastDistances(d, zone);
  if (!Number.isFinite(dct)) dct = coast.dct;
  if (!Number.isFinite(dcr)) dcr = coast.dcr;
  const { hts, hrs } = se;

  // §4.5 式 (58) 用的斜率：Stim 以裸地形 hi 代替 gi
  const Ce = 1 / ae;
  let StimH = -Infinity;
  for (let i = 1; i < d.length - 1; i++) StimH = Math.max(StimH, (h[i] + 500 * Ce * d[i] * (dtot - d[i]) - hts) / d[i]);
  const Str = (hrs - hts) / dtot;
  const Fj = 1.0 - 0.5 * (1.0 + Math.tanh(3.0 * 0.8 * (StimH - Str) / 0.3));            // 式 (58)，ξ = 0.8、Θ = 0.3 mrad
  const Fk = 1.0 - 0.5 * (1.0 + Math.tanh(3.0 * 0.5 * (dtot - 20) / 20));                // 式 (59)，dsw = 20、κ = 0.5

  const d3D = Math.sqrt(dtot * dtot + Math.pow((hts - hrs) / 1000.0, 2));                // 式 (8a)
  const los = losLoss({ fGHz, p, b0, omega, d3D, dlt: se.dlt, dlr: se.dlr, pressHPa, tempC });
  const dif = diffractionLoss({ d, g, hts, hrs, hstd: se.hstd, hsrd: se.hsrd, fGHz, omega, p, b0, ae, ab, pol });
  const Lbd50 = los.Lbfsg + dif.Ld50;                                                    // 式 (43)
  const Lbd = los.Lb0p + dif.Ldp;                                                        // 式 (44)

  // 式 (60)：视距与海上子路径绕射的名义最小损耗
  let Lminb0p = los.Lb0p + (1 - omega) * dif.Ldp;
  if (p >= b0) {
    const Fi = invCumNormP452(p / 100) / invCumNormP452(b0 / 100);                       // 式 (41a)
    Lminb0p = Lbd50 + (los.Lb0b + (1 - omega) * dif.Ldp - Lbd50) * Fi;
  }
  const duct = ductingLoss({ fGHz, p, dtot, dlt: se.dlt, dlr: se.dlr, dct, dcr, dlm, hts, hrs, hte: se.hte, hre: se.hre,
    hm: se.hm, thetaT: se.thetaT, thetaR: se.thetaR, omega, ae, b0, pressHPa, tempC });
  const eta = 2.5;
  const Lminbap = eta * Math.log(Math.exp(duct.Lba / eta) + Math.exp(los.Lb0p / eta));   // 式 (61)
  const Lbda = Lminbap <= Lbd ? Lminbap + (Lbd - Lminbap) * Fk : Lbd;                    // 式 (62)
  const Lbam = Lbda + (Lminb0p - Lbda) * Fj;                                             // 式 (63)
  const Lbs = troposcatterLoss({ fGHz, p, dtot, theta: se.theta, N0, Gt, Gr, pressHPa, tempC });
  const Lb = -5 * LOG10(Math.pow(10, -0.2 * Lbs) + Math.pow(10, -0.2 * Lbam));           // 式 (64)

  return {
    Lb, Lbfsg: los.Lbfsg, Lb0p: los.Lb0p, Lb0b: los.Lb0b, Esp: los.Esp, Esb: los.Esb,
    Ld50: dif.Ld50, Ldp: dif.Ldp, Ldb: dif.Ldb, Ldsph: dif.Ldsph50, Fi: dif.Fi,
    Lbd50, Lbd, Lbs, Lba: duct.Lba, Lminb0p, Lminbap, Lbda, Lbam, Fj, Fk,
    ducting: duct,
    path: Object.assign({}, se, { d3D, dtm, dlm, omega, b0, DN, N0, ae, ab, centreLat, dct, dcr, StimH, Str, nPoints: d.length })
  };
}

/**
 * 只做剖面分析（不算损耗）：返回附录 2 各量与 dtm、dlm、ω、β0、ΔN、N0、ae——给界面展示与排查用。
 * 入参同 basicTransmissionLoss（fGHz 只用于视距路径找 Bullington 点）。
 */
function analyzeProfile(o) {
  o = o || {};
  if (!(num(o.htg) > 0) || !(num(o.hrg) > 0)) return { error: '天线离地高度 htg、hrg 须为正数（m）' };
  const prof = prepareProfile(o);
  if (prof.error) return prof;
  const { dtm, dlm, omega } = zoneStats(prof.d, prof.zone);
  let centreLat = num(o.centreLat), centreLon = num(o.centreLon);
  if (!Number.isFinite(centreLat) && [o.txLat, o.txLon, o.rxLat, o.rxLon].every((v) => Number.isFinite(num(v)))) {
    const c = pathPoint(num(o.txLat), num(o.txLon), num(o.rxLat), num(o.rxLon), 0.5 * prof.dtot);
    centreLat = c.lat; centreLon = c.lon;
  }
  let DN = num(o.DN), N0 = num(o.N0);
  if ((!Number.isFinite(DN) || !Number.isFinite(N0)) && Number.isFinite(centreLat) && Number.isFinite(centreLon)) {
    const met = radioMetAt(centreLat, centreLon);
    if (met) { if (!Number.isFinite(DN)) DN = met.DN; if (!Number.isFinite(N0)) N0 = met.N0; }
  }
  if (!Number.isFinite(DN)) return { error: '缺 ΔN：请给站址经纬度或 DN' };
  const { ae, ab } = effectiveEarthRadius(DN);
  const fGHz = num(o.fGHz) > 0 ? num(o.fGHz) : 1;
  const se = smoothEarthAnalysis(prof.d, prof.h, num(o.htg), num(o.hrg), ae, fGHz);
  const b0 = Number.isFinite(centreLat) ? beta0(centreLat, dtm, dlm) : null;
  return Object.assign({}, se, { dtm, dlm, omega, b0, DN, N0, ae, ab, centreLat, centreLon }, coastDistances(prof.d, prof.zone));
}

// ---------------------------------------------------------------------------
// §4.6 传输损耗与离轴角
// ---------------------------------------------------------------------------

/**
 * 式 (65)–(68)：大圆距离与两端方位（自正北顺时针，度）。
 */
function greatCircle(txLat, txLon, rxLat, rxLon) {
  const t = txLat * D2R, r = rxLat * D2R, dl = (txLon - rxLon) * D2R;
  const delta = Math.acos(Math.max(-1, Math.min(1, Math.sin(t) * Math.sin(r) + Math.cos(t) * Math.cos(r) * Math.cos(dl))));   // 式 (65)
  const brg = (a, b, dlon) => {
    let x = Math.acos(Math.max(-1, Math.min(1, (Math.sin(b) - Math.sin(a) * Math.cos(delta)) / (Math.sin(delta) * Math.cos(a)))));   // 式 (67)
    if (dlon > 0) x = 2 * Math.PI - x;                                                   // 式 (68)
    return x * R2D;
  };
  return { deltaRad: delta, dKm: A_EARTH * delta, bearingTrDeg: brg(t, r, dl), bearingRtDeg: brg(r, t, -dl) };   // 式 (66)
}

/**
 * 式 (69a)–(71b)：干扰路径在两端的仰角与两端天线的离轴角（度）。
 * @param {object} o { txLat, txLon, rxLat, rxLon, htKm, hrKm（海拔 km）, ae, pathType, thetaT, thetaR（mrad，超视距用）,
 *                     txBoresight: {elevDeg, azDeg}, rxBoresight: {elevDeg, azDeg} }
 */
function offBoresightAngles(o) {
  const gc = greatCircle(o.txLat, o.txLon, o.rxLat, o.rxLon);
  let ept, epr;
  if (o.pathType === 'transhorizon') {
    ept = o.thetaT / 1000; epr = o.thetaR / 1000;                                        // 式 (70a)(70b)
  } else {
    ept = (o.hrKm - o.htKm) / gc.dKm - gc.dKm / (2 * o.ae);                              // 式 (69a)
    epr = (o.htKm - o.hrKm) / gc.dKm - gc.dKm / (2 * o.ae);                              // 式 (69b)
  }
  const chi = (bs, eps, brg) => {
    if (!bs) return null;
    const e = bs.elevDeg * D2R, a = bs.azDeg * D2R;
    return Math.acos(Math.max(-1, Math.min(1, Math.cos(e) * Math.cos(eps) * Math.cos(brg * D2R - a) + Math.sin(e) * Math.sin(eps)))) * R2D;   // 式 (71a)(71b)
  };
  return Object.assign(gc, {
    epsPtDeg: ept * R2D, epsPrDeg: epr * R2D,
    chiTDeg: chi(o.txBoresight, ept, gc.bearingTrDeg), chiRDeg: chi(o.rxBoresight, epr, gc.bearingRtDeg)
  });
}

/** 式 (72)：传输损耗 L = Lb(p) − Gt − Gr。 */
function transmissionLoss(Lb, Gt, Gr) {
  return Lb - Gt - Gr;
}

module.exports = {
  basicTransmissionLoss, analyzeProfile,
  // 分机制（供界面分项展示 / 测试）
  losLoss, bullingtonLoss, sphericalEarthLoss, deltaBullington, diffractionLoss, troposcatterLoss, ductingLoss,
  // 无线电气象与剖面辅助
  radioMetAt, setRadioMetMaps, pathPoint, effectiveEarthRadius, beta0, worstMonthToAnnual, invCumNormP452,
  zoneStats, smoothEarthAnalysis,
  // §4.6
  greatCircle, offBoresightAngles, transmissionLoss,
  CLUTTER_HEIGHTS, LEGACY_CLUTTER_P452_17
};
