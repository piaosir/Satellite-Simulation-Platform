// waterVaporGrid.js — ITU-R P.836-6 水汽数字图（地面水汽密度 ρ 与柱水汽 V）
//
// 两套数据，各有一个注入口：
//   ① p836_v2.bin（2026-10-17 起，setDataV2）：年统计 18 个概率档 × (ρ, V, VSCH) + 格点海拔，
//      由 scripts/build-itu-p836.mjs 从 ITU 官方 ZIP 打包（来源 URL 与 SHA-256 见该脚本）。
//      getRhoP / getVP 按 P.836-6 Annex 1/2 步骤 a)~g) 取值：四格点按 VSCH 标高换算到站高 → 双线性 → 对 log p 线性插值。
//      P.676-13 Annex 2 统计法（气体吸收）与 P.2041-1（机载）都从这里取。
//   ② p836_rho_v1.bin（旧，setData）：只有 RHO_90 / RHO_10 两张图，作 v2 缺失时的兜底（getRhoWs 的读法原样保留）。
// 两套都未注入时回退 ITU-R P.835 纬度带估算值。
//
// ── 以下是 ② 旧图的说明 ──
// 数据放云存储（p836_rho_v1.bin），由 app.js 启动时后台下载并通过 setData() 注入。
// 注入前 getRhoWs() 回退到 ITU-R P.835 纬度带估算值，不影响出数。
//
// .bin 格式：两张 Int16LE 图按 [晴天 RHO_90_v4.txt][雨天 RHO_10_v4.txt] 顺序拼接，各 161×321。
//   值 × 100 存储（精度 0.01 g/m³）。
// 网格：行 r → 纬度 = 90 − r×1.125（行0=90°N），**列 c → 经度 = c×1.125（列0=0°E，0…360）**。
//
// ★ 2026-07-25 修正：经度基准原按 −180 解读，整张图因此偏了 180°——撒哈拉的干区被搬到了太平洋，
//   查一个站点拿到的是地球对面的水汽密度。P.836 与 P.839 一样是 ITU 的 0…360 排布（见
//   isothermHeight.js 同款归一化），改回 0 基准。
//   证据（原始 bin，22.5°N 那一行）：按「列0=0°E」解读时最干的几列落在 5.6°E（撒哈拉，2.0 g/m³），
//   太平洋/大西洋 11~14 g/m³，与物理一致；按「列0=−180°」解读则撒哈拉落在 174°W 的洋面上。
//   另与 P.1511 地形做互相关（山高则干，应为负相关）：0 基准 r=−0.32，−180 基准仅 r=−0.09。
//   影响面：P.676 气体吸收（三套链路预算 + 雨衰计算器）的 ρ 取值，回归基线随之重锁。
//   行方向经同法核对无误（40°N 纬向方差 2.06 ≫ 40°S 的 0.55；南极 0.01 < 北极 0.23 g/m³）。

const ROWS     = 161;
const COLS     = 321;
const STEP     = 1.125;
const LAT_TOP  = 90;
const BLOCK    = ROWS * COLS;
const EXPECTED_SIZE = BLOCK * 2 * 2;

let _clear = null, _rainy = null;

function setData(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength !== EXPECTED_SIZE) {
    console.warn('[P.836] 数据大小不匹配: 期望', EXPECTED_SIZE, '实际', arrayBuffer ? arrayBuffer.byteLength : 0);
    return false;
  }
  const all = new Int16Array(arrayBuffer);
  _clear = all.slice(0, BLOCK);
  _rainy = all.slice(BLOCK, BLOCK * 2);
  console.log('[P.836] 水汽密度数据已注入:', ROWS, '×', COLS, '× 2图');
  return true;
}

function isReady() { return _clear !== null; }

// P.835 纬度带兜底（云数据未加载时使用）
function _p835(lat) {
  const a = Math.abs(lat);
  if (a < 22) return 19.0;
  if (a < 45) return 8.9;
  return 5.2;
}

// 对数空间双线性插值。经度先归一化到 [0,360)——数据即按此排布（列0=0°E、列320=360°E 与列0 同经线）
function _bilinear(arr, lat, lon) {
  const rf = (LAT_TOP - lat) / STEP;
  const cf = (((lon % 360) + 360) % 360) / STEP;
  const r0 = Math.max(0, Math.min(ROWS - 2, Math.floor(rf)));
  const c0 = Math.max(0, Math.min(COLS - 2, Math.floor(cf)));
  const r1 = r0 + 1, c1 = c0 + 1;
  const dy = rf - r0, dx = cf - c0;
  const get = (r, c) => { const v = arr[r * COLS + c]; return v > 0 ? v / 100 : _p835(LAT_TOP - r * STEP); };
  const lv00 = Math.log(get(r0, c0)), lv10 = Math.log(get(r0, c1));
  const lv01 = Math.log(get(r1, c0)), lv11 = Math.log(get(r1, c1));
  return Math.exp(lv00 + (lv10 - lv00) * dx + (lv01 - lv00) * dy + (lv11 - lv10 - lv01 + lv00) * dx * dy);
}

function getRhoWs(lat, lon, rainy) {
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) {
    return rainy ? 20.0 : _p835(lat || 0);
  }
  const arr = rainy ? _rainy : _clear;
  if (!arr) return _p835(lat);  // 云数据未加载，回退 P.835
  return _bilinear(arr, lat, lon);
}

// ═══════════════════ ① p836_v2.bin：年统计全概率档 ρ / V / VSCH + 格点海拔 ═══════════════════
// 格式见 scripts/build-itu-p836.mjs 文件头；网格与 ② 相同（行 0 = 90°N，列 0 = 0°E，0…360 排布）。

const P836_PS = [0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 10, 20, 30, 50, 60, 70, 80, 90, 95, 99];
let _v2 = null;   // { rho: Float32Array[nP], v: [...], vsch: [...], alt: Float32Array }

function setDataV2(arrayBuffer) {
  try {
    if (!arrayBuffer || arrayBuffer.byteLength < 128) throw new Error('数据为空');
    const dv = new DataView(arrayBuffer);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    const ver = dv.getUint16(4, true), nP = dv.getUint16(6, true), rows = dv.getUint16(8, true), cols = dv.getUint16(10, true);
    if (magic !== 'P836' || ver !== 2 || nP !== P836_PS.length || rows !== ROWS || cols !== COLS) {
      throw new Error(`格式不符（${magic} v${ver} ${nP}档 ${rows}×${cols}）`);
    }
    if (dv.getFloat32(12, true) !== LAT_TOP || dv.getFloat32(16, true) !== 0 || dv.getFloat32(20, true) !== STEP) {
      throw new Error('网格原点 / 格距与约定不符');   // 列 0 必须是 0°E —— 防经度基准再错一次
    }
    for (let i = 0; i < nP; i++) {
      if (Math.abs(dv.getFloat32(40 + 4 * i, true) - P836_PS[i]) > 1e-6) throw new Error('概率档不符');
    }
    const sRho = dv.getFloat32(24, true), sV = dv.getFloat32(28, true), sVs = dv.getFloat32(32, true), sAlt = dv.getFloat32(36, true);
    const N = ROWS * COLS;
    if (arrayBuffer.byteLength !== 128 + (nP * 3 * N + N) * 2) throw new Error('长度不符：' + arrayBuffer.byteLength);
    const u16 = new Uint16Array(arrayBuffer, 128, nP * 3 * N);
    const i16 = new Int16Array(arrayBuffer, 128 + nP * 3 * N * 2, N);
    const deq = (src, off, scale) => {
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) { const q = src[off + i]; out[i] = q === 0xFFFF ? NaN : q / scale; }
      return out;
    };
    const rho = [], v = [], vsch = [];
    for (let k = 0; k < nP; k++) {
      rho.push(deq(u16, (3 * k) * N, sRho));
      v.push(deq(u16, (3 * k + 1) * N, sV));
      vsch.push(deq(u16, (3 * k + 2) * N, sVs));
    }
    const alt = new Float32Array(N);
    for (let i = 0; i < N; i++) alt[i] = i16[i] === -32768 ? NaN : i16[i] / sAlt;
    _v2 = { rho, v, vsch, alt };
    console.log('[P.836] v2 年统计数据已注入:', nP, '档 × (ρ, V, VSCH) +格点海拔');
    return true;
  } catch (e) {
    console.warn('[P.836] v2 数据无效：', e.message);
    _v2 = null;
    return false;
  }
}

function isReadyV2() { return _v2 !== null; }

// 站点所在格：四个最近格点（行 R/R+1、列 C/C+1）与格内分数位置
function _cell(lat, lon) {
  const r = (LAT_TOP - lat) / STEP;
  const c = (((lon % 360) + 360) % 360) / STEP;
  const R = Math.max(0, Math.min(ROWS - 2, Math.floor(r)));
  const C = Math.max(0, Math.min(COLS - 2, Math.floor(c)));
  return { R, C, dr: r - R, dc: c - C };
}

// 单个概率档：四格点值按 VSCH 换算到站高（P.836-6 式 (1)/(2)）后做 P.1144 双线性；缺测格（官方原件行 1）跳过并重新归一权重
function _atIndex(maps, k, cell, altKm) {
  const { R, C, dr, dc } = cell;
  const idx = [R * COLS + C, (R + 1) * COLS + C, R * COLS + C + 1, (R + 1) * COLS + C + 1];
  const w = [(1 - dr) * (1 - dc), dr * (1 - dc), (1 - dr) * dc, dr * dc];
  const val = maps[k], vsch = _v2.vsch[k], alt = _v2.alt;
  let acc = 0, wsum = 0;
  for (let i = 0; i < 4; i++) {
    let x = val[idx[i]];
    if (!Number.isFinite(x)) continue;
    if (Number.isFinite(altKm)) {
      const hs = vsch[idx[i]];
      if (Number.isFinite(hs) && hs > 0 && Number.isFinite(alt[idx[i]])) x *= Math.exp(-(altKm - alt[idx[i]]) / hs);
    }
    acc += w[i] * x; wsum += w[i];
  }
  return wsum > 0 ? acc / wsum : NaN;
}

// P.836-6 步骤 a)~g)：相邻两概率档各自求值，再对 log p 线性插值；p 夹到 [0.1, 99]
function _interpP(maps, lat, lon, p, altKm) {
  if (!_v2 || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(p)) return NaN;
  const pp = Math.max(P836_PS[0], Math.min(P836_PS[P836_PS.length - 1], p));
  const cell = _cell(lat, lon);
  let hi = P836_PS.findIndex((x) => x >= pp);
  if (P836_PS[hi] === pp) return _atIndex(maps, hi, cell, altKm);
  const lo = hi - 1;
  const xLo = _atIndex(maps, lo, cell, altKm), xHi = _atIndex(maps, hi, cell, altKm);
  const t = (Math.log(pp) - Math.log(P836_PS[lo])) / (Math.log(P836_PS[hi]) - Math.log(P836_PS[lo]));
  return xLo + (xHi - xLo) * t;
}

/**
 * 地面水汽密度 ρ(p)，g/m³（P.836-6 Annex 1）
 * @param {number} lat  纬度（度）
 * @param {number} lon  经度（度，任意范围，内部归一到 0…360）
 * @param {number} p    年超越概率 %（夹到 0.1~99）
 * @param {number} [altKm] 站点海拔 km（缺省 = 不做标高换算，即取各格点自身海拔处的值）
 * @returns {number} v2 未注入时 NaN
 */
function getRhoP(lat, lon, p, altKm) { return _v2 ? _interpP(_v2.rho, lat, lon, p, altKm) : NaN; }

/** 柱水汽总量 V(p)，kg/m²（P.836-6 Annex 2），参数同 getRhoP */
function getVP(lat, lon, p, altKm) { return _v2 ? _interpP(_v2.v, lat, lon, p, altKm) : NaN; }

/** 格点海拔（TOPO_0DOT5 双三次到 1.125° 格点）的双线性值，km；v2 未注入时 NaN */
function gridAltitude(lat, lon) {
  if (!_v2 || !Number.isFinite(lat) || !Number.isFinite(lon)) return NaN;
  const { R, C, dr, dc } = _cell(lat, lon);
  const a = _v2.alt;
  return a[R * COLS + C] * (1 - dr) * (1 - dc) + a[(R + 1) * COLS + C] * dr * (1 - dc)
       + a[R * COLS + C + 1] * (1 - dr) * dc + a[(R + 1) * COLS + C + 1] * dr * dc;
}

/**
 * 年均地面水汽密度（g/m³）：对 P.836 年 CCDF 积分，E[ρ] = ∫ρ(p) dp / 100（梯形，两端按 0.1% / 99% 档外延）。
 * P.676-13 Annex 2 统计法的 γ_o / K_w 要的是「年均地面气象参数」，P.836 只给分位，故由分位积分得均值。
 */
function getRhoMean(lat, lon, altKm) {
  if (!_v2) return NaN;
  const cell = _cell(lat, lon);
  const xs = P836_PS.map((p, k) => _atIndex(_v2.rho, k, cell, altKm));
  if (xs.some((x) => !Number.isFinite(x))) return NaN;
  let acc = xs[0] * P836_PS[0];
  for (let k = 0; k < xs.length - 1; k++) acc += 0.5 * (xs[k] + xs[k + 1]) * (P836_PS[k + 1] - P836_PS[k]);
  acc += xs[xs.length - 1] * (100 - P836_PS[P836_PS.length - 1]);
  return acc / 100;
}

/**
 * 统一取 ρ(p)：v2 → 旧图（RHO_10 / RHO_90 两档对 log p 线性插值，p 夹到 10~90）→ P.835 纬度带
 * @returns {{rho:number, src:'p836v2'|'p836v1'|'p835'}}
 */
function rhoAt(lat, lon, p, altKm) {
  const v = getRhoP(lat, lon, p, altKm);
  if (Number.isFinite(v)) return { rho: v, src: 'p836v2' };
  if (_clear && _rainy && Number.isFinite(lat) && Number.isFinite(lon)) {
    const pp = Math.max(10, Math.min(90, Number.isFinite(p) ? p : 50));
    const r10 = _bilinear(_rainy, lat, lon), r90 = _bilinear(_clear, lat, lon);
    const t = (Math.log(pp) - Math.log(10)) / (Math.log(90) - Math.log(10));
    return { rho: r10 + (r90 - r10) * t, src: 'p836v1' };
  }
  return { rho: _p835(Number.isFinite(lat) ? lat : 0), src: 'p835' };
}

module.exports = {
  setData, isReady, getRhoWs, EXPECTED_SIZE,
  setDataV2, isReadyV2, P836_PS, getRhoP, getVP, getRhoMean, gridAltitude, rhoAt
};
