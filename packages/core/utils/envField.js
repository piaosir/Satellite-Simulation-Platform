// envField.js — ITU 环境场取数（主窗口「环境场」图层的数据源）
//
// 五个实测场 + 一个派生量，取值一律走**链路预算引擎在用的同一套查询函数**（queryRainRate /
// getIsothermHeight / queryElevation / getRhoWs / cloudLWCFromLognormal），不另写插值：
// 图上那个颜色和预算表里那个数字必须是同一个数，否则这张图对工程没有意义。
//
// 逐点取值做整张图不可行（百万次 IPC 往返），故这里一次生成一张等经纬栅格交给渲染端：
//   values[j*nx+i] ← (lat = latMax − (j+0.5)·step, lon = lonMin + (i+0.5)·step)
// 行 0 = 北（latMax），与位图/等经纬贴图的约定一致，渲染端直接 drawImage / 贴球，不必翻转。
// 取样点用**格心**而非格点：这张栅格是要被当作像素画出去的，格心才是那个像素代表的位置。
//
// 数据未就绪（全精度 bin 缺失）时不静默糊弄：值给 NaN、ready=false、precision 如实标注回退档，
// 由界面把「0.5° 回退」写在图例上——图不能看起来比数据准。
//
// 纯 JS、无 Vue/DOM，在 Electron 主进程（Node）以 CommonJS 加载，可离线单测。

const rainRate = require('./rainRate.js');
const elevation = require('./elevation.js');
const { getIsothermHeight } = require('./isothermHeight.js');
const vapor = require('../data/waterVaporGrid.js');
const cloudGrid = require('../data/cloudParamsGrid.js');
const lc = require('./linkCalculator.js');

// P.618-14 §2.2.1.1：雨高 hR = h0 + 0.36 km
const HR_OFFSET = 0.36;

// 云衰口径（与 linkCalculator.calculateCloudAttenuation 一致）：p<1% 一律封顶在 1% 值。
// 故界面只放 p≥1 的档位，避免图上出现引擎不会用到的数。
const CLOUD_P_MIN = 1;

// ==================== 字段注册表 ====================
// key      渲染端与 IPC 的标识
// native   原生分辨率（度）——界面据此提示「再细也无新信息」
// dec      读数小数位
// seaHint  海面上是否有物理意义（false → 界面默认勾上「海洋透明」）
// scheme   默认配色
// step     等值线默认级差（null = 按值域自动定级）
const FIELD_DEFS = [
  {
    key: 'rain', label: 'R0.01% 降雨率', short: 'R₀.₀₁', unit: 'mm/h',
    rec: 'ITU-R P.837-7', native: 0.125, dec: 1, seaHint: true, scheme: 'turbo', step: 10
  },
  {
    key: 'h0', label: '0°C 等温线高度', short: 'h₀', unit: 'km',
    rec: 'ITU-R P.839-4', native: 1.5, dec: 2, seaHint: true, scheme: 'viridis', step: 0.5
  },
  {
    key: 'hr', label: '雨高 hR（h₀＋0.36）', short: 'h_R', unit: 'km',
    rec: 'ITU-R P.618-14 §2.2.1.1', native: 1.5, dec: 2, seaHint: true, scheme: 'viridis', step: 0.5,
    derived: true
  },
  {
    key: 'elev', label: '地面海拔', short: 'h_s', unit: 'm',
    rec: 'ITU-R P.1511（Earth2014）', native: 1 / 12, dec: 0, seaHint: false, scheme: 'gray', step: 500
  },
  {
    key: 'rho', label: '地面水汽密度 ρ', short: 'ρ', unit: 'g/m³',
    rec: 'ITU-R P.836-6', native: 1.125, dec: 1, seaHint: true, scheme: 'viridis', step: 2,
    opt: { name: 'rainy', label: '口径', kind: 'enum', values: [
      { v: 0, label: '晴天（RHO 90%）' }, { v: 1, label: '雨天（RHO 10%）' }
    ] }
  },
  {
    key: 'cloud', label: '云液态水柱含量 L_red', short: 'L', unit: 'kg/m²',
    rec: 'ITU-R P.840-9', native: 0.25, dec: 2, seaHint: true, scheme: 'inferno', step: null,
    opt: { name: 'p', label: '超越概率', kind: 'enum', values: [
      { v: 1, label: 'p = 1%' }, { v: 2, label: 'p = 2%' }, { v: 3, label: 'p = 3%' },
      { v: 5, label: 'p = 5%' }, { v: 10, label: 'p = 10%' }, { v: 20, label: 'p = 20%' },
      { v: 30, label: 'p = 30%' }, { v: 50, label: 'p = 50%' }
    ] }
  }
];

const fieldDef = (key) => FIELD_DEFS.find((f) => f.key === key) || null;

// 取数器：返回 { fn(lat, lon)→值或 NaN, ready, precision, note }
function makeSampler(key, opt) {
  switch (key) {
    case 'rain': {
      const full = rainRate.isFullDataReady();
      return {
        fn: (lat, lon) => rainRate.queryRainRate(lat, lon).rainRate,
        ready: true,
        precision: full ? '0.125°' : '4°（内嵌回退）',
        fallback: !full
      };
    }
    case 'h0':
      return { fn: (lat, lon) => getIsothermHeight(lat, lon), ready: true, precision: '1.5°', fallback: false };
    case 'hr':
      return { fn: (lat, lon) => getIsothermHeight(lat, lon) + HR_OFFSET, ready: true, precision: '1.5°', fallback: false };
    case 'elev': {
      const ok = elevation.isElevationReady();
      return {
        fn: ok ? ((lat, lon) => { const r = elevation.queryElevation(lat, lon); return r.success ? r.altitude : NaN; }) : (() => NaN),
        ready: ok,
        precision: ok ? '0.0833°（5′）' : '数据未就绪',
        fallback: false
      };
    }
    case 'rho': {
      const ok = vapor.isReady();
      const rainy = !!(opt && Number(opt.rainy));
      return {
        fn: (lat, lon) => vapor.getRhoWs(lat, lon, rainy),
        ready: true,
        precision: ok ? '1.125°' : 'P.835 纬度带回退',
        fallback: !ok
      };
    }
    case 'cloud': {
      const ok = cloudGrid.isReady();
      const p = Math.max(CLOUD_P_MIN, Number(opt && opt.p) || CLOUD_P_MIN);
      return {
        fn: ok
          ? ((lat, lon) => { const pr = cloudGrid.getParams(lat, lon); return pr ? lc.cloudLWCFromLognormal(p, pr) : NaN; })
          : (() => NaN),
        ready: ok,
        precision: ok ? '0.25°' : '数据未就绪',
        fallback: false,
        note: 'p<1% 按 P.840 旧版口径封顶在 1% 值（与链路预算一致）'
      };
    }
    default:
      return null;
  }
}

// 分位数（供渲染端「自动值域」用）：全量排序太贵，等距抽样到 ≤4 万个再排——
// 分位点本来就是统计量，抽样带来的偏差远小于配色档位本身的粒度。
const QUANTS = [0.02, 0.5, 0.98];
function quantiles(values, keep) {
  const n = values.length;
  const want = 40000;
  const stride = Math.max(1, Math.floor((keep ? keep.count : n) / want));
  const buf = [];
  for (let i = 0, k = 0; i < n; i++) {
    if (keep && !keep.mask[i]) continue;
    if ((k++ % stride) !== 0) continue;
    const v = values[i];
    if (v === v) buf.push(v);
  }
  if (!buf.length) return null;
  buf.sort((a, b) => a - b);
  const at = (q) => buf[Math.min(buf.length - 1, Math.max(0, Math.round(q * (buf.length - 1))))];
  return { p2: at(QUANTS[0]), p50: at(QUANTS[1]), p98: at(QUANTS[2]) };
}

// 统计：极值 + 面积加权（cos φ）均值 + 分位数。mask 非空时只统计掩膜内（陆地）。
function statsOf(values, nx, ny, latMax, step, mask) {
  let min = Infinity, max = -Infinity, wsum = 0, vsum = 0, count = 0;
  for (let j = 0; j < ny; j++) {
    const w = Math.cos((latMax - (j + 0.5) * step) * Math.PI / 180);
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const idx = row + i;
      if (mask && !mask[idx]) continue;
      const v = values[idx];
      if (v !== v) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      wsum += w; vsum += v * w; count++;
    }
  }
  if (!count) return null;
  const q = quantiles(values, mask ? { mask, count } : null);
  return { min, max, mean: wsum > 0 ? vsum / wsum : NaN, count, p2: q ? q.p2 : min, p50: q ? q.p50 : min, p98: q ? q.p98 : max };
}

/**
 * 取一张等经纬环境场栅格。
 * @param {string} key   字段 key（见 FIELD_DEFS）
 * @param {object} opt   { latMin, latMax, lonMin, lonMax, step, mask, rainy, p }
 *   step  格距（度），默认 0.25；nx/ny 由 bbox 与 step 定，总点数上限 400 万
 *   mask  true 且海拔数据就绪时，附带陆海掩膜（P.1511 地形 >0 判陆）与陆地统计
 * @returns {object} { key, label, unit, rec, precision, ready, fallback, bbox, nx, ny, step,
 *                     values:Float32Array, land:Uint8Array|null, stats, statsLand, ms }
 */
function sampleField(key, opt) {
  const o = opt || {};
  const def = fieldDef(key);
  if (!def) return { error: '未知字段：' + key };

  const latMin = Math.max(-90, Number.isFinite(o.latMin) ? o.latMin : -90);
  const latMax = Math.min(90, Number.isFinite(o.latMax) ? o.latMax : 90);
  const lonMin = Number.isFinite(o.lonMin) ? o.lonMin : -180;
  const lonMax = Number.isFinite(o.lonMax) ? o.lonMax : 180;
  if (!(latMax > latMin) || !(lonMax > lonMin)) return { error: '无效的取数范围' };

  let step = Number(o.step) > 0 ? Number(o.step) : 0.25;
  let nx = Math.max(2, Math.round((lonMax - lonMin) / step));
  let ny = Math.max(2, Math.round((latMax - latMin) / step));
  if (nx * ny > 4e6) {                    // 上限保护：按面积等比放粗
    const f = Math.sqrt(nx * ny / 4e6);
    nx = Math.max(2, Math.round(nx / f)); ny = Math.max(2, Math.round(ny / f));
    step = (lonMax - lonMin) / nx;
  }
  const dLon = (lonMax - lonMin) / nx, dLat = (latMax - latMin) / ny;

  const S = makeSampler(key, o);
  const t0 = Date.now();
  const values = new Float32Array(nx * ny);
  const wantMask = !!o.mask && elevation.isElevationReady();
  const land = wantMask ? new Uint8Array(nx * ny) : null;

  for (let j = 0; j < ny; j++) {
    const lat = latMax - (j + 0.5) * dLat;
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      let lon = lonMin + (i + 0.5) * dLon;
      if (lon > 180) lon -= 360; else if (lon < -180) lon += 360;
      const v = S.fn(lat, lon);
      values[row + i] = Number.isFinite(v) ? v : NaN;
      if (land) { const e = elevation.queryElevation(lat, lon); land[row + i] = (e.success && e.altitude > 0) ? 1 : 0; }
    }
  }

  return {
    key, label: def.label, short: def.short, unit: def.unit, rec: def.rec,
    native: def.native, dec: def.dec, seaHint: def.seaHint, scheme: def.scheme, contourStep: def.step,
    precision: S.precision, ready: S.ready, fallback: !!S.fallback, note: S.note || '',
    maskAvail: elevation.isElevationReady(),   // 陆海掩膜靠 P.1511 地形，未就绪时界面把该项置灰
    bbox: { latMin, latMax, lonMin, lonMax },
    nx, ny, step: dLon,
    values, land,
    stats: statsOf(values, nx, ny, latMax, dLat, null),
    statsLand: land ? statsOf(values, nx, ny, latMax, dLat, land) : null,
    ms: Date.now() - t0
  };
}

// 单点取值（状态栏读数的兜底通道；常规读数由渲染端就近读已缓存栅格，不走 IPC）
function pointValue(key, lat, lon, opt) {
  const S = makeSampler(key, opt || {});
  if (!S) return null;
  const v = S.fn(lat, lon);
  return Number.isFinite(v) ? v : null;
}

module.exports = { FIELD_DEFS, fieldDef, sampleField, pointValue, HR_OFFSET };
