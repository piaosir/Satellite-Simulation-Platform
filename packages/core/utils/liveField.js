// liveField.js — 实时/预报环境场：时空立方体的某一帧 → 一张等经纬栅格
//
// 与 envField.js 是**同构**的：出参形状逐字段对齐（values/nx/ny/bbox/stats/land…），
// 所以渲染端（上色 envRaster / 提线 envContour / 2D·3D 两个通道）一行都不用改，
// 直接把 ITU 气候场那套完整搬过来用。三处不同：
//   ① 数据源不是随包分发的 ITU 地图，而是主进程刚拉回的气象立方体（weather.js）；
//   ② 多一个**时间**维度 —— frame 选哪一帧，由全局仿真时钟驱动；
//   ③ 衰减类字段**依赖卫星**（每一格仰角不同），故必须给目标星（satLon 或 satPos）与 freq / pol。
//      这是与 ITU 气候场最根本的差别：那边是纯气候量，与看哪颗星无关。
//      ★ 目标星两种给法 = 两套几何：satLon 走 GEO 闭式（与 GSO 链路预算同源），satPos
//        {星下点, 轨道高度} 走 WGS-84 通用几何（与 NGSO / 可见性分析同源），故 LEO/MEO/HEO
//        与倾斜 GSO 一样算得出来 —— 这张图不再是「只对静止轨道成立」的图。
//
// ★ 时间上**就近取帧、不做插值**：降水场在时间上不连续（雨区会突然生成/消散），
//   线性插值会造出「半强度的雨区」这种物理上不存在的东西。空间上则做双线性 ——
//   降水场在空间上是连续的，且插的是**雨强**再算 γ=k·R^α，不是插算完的 dB
//   （衰减对雨强非线性，先插 dB 会系统性偏高）。
//
// ★ 缺格（取数失败的点）一律 NaN 往下传，不用 0 顶替：图上留白比画一片假的无雨区诚实。
//
// 纯 JS、无 IO、无 Vue/DOM，可离线单测。

const inst = require('./instantAtten.js');
const met = require('./metSnapshot.js');
const elevation = require('./elevation.js');
const lc = require('./linkCalculator.js');

const PTYPE = ['none', 'rain', 'snow', 'ice', 'mixed', 'unknown'];

// 字段注册表。形状与 envField.FIELD_DEFS 一致，界面按同一套代码渲染下拉与图例。
//   sat:true    该字段依赖卫星几何（要 satLon/freq/pol），界面据此决定要不要显示链路那一组输入
//   raw:true    直接来自气象源（非本平台算出）→ rec 由立方体的 model 名填，不写死数据源名字
//   levels[]    气象业务色标的**锚点**：值轴不等距、色轴等距。给了就不走分位拉伸。
//               ★ 这一项是「云图观感」的核心：降水是极长尾的量，线性铺色会把 90% 的格
//                 压成同一个颜色，再好的配色也救不回来。锚点把常见量级摊开在色带上。
//   band        该字段属于哪一族（'met' 气象量 / 'link' 链路量），界面按族分组下拉
const FIELD_DEFS = [
  // —— 链路量：本模块存在的理由。这几张图上的每一格都跑过一次 ITU 引擎 ——
  { key: 'rainAtten', label: '雨衰', short: 'A_rain', unit: 'dB', rec: 'ITU-R P.838 · 瞬时雨强', dec: 2, scheme: 'atten', step: 1, sat: true, band: 'link', levels: [0, 0.1, 0.3, 0.6, 1, 2, 4, 8, 16, 32] },
  { key: 'totalAtten', label: '合计衰减（气体+云+雨）', short: 'A_tot', unit: 'dB', rec: 'ITU-R P.676 + P.840 + P.838', dec: 2, scheme: 'atten', step: 1, sat: true, band: 'link', levels: [0, 0.2, 0.5, 1, 2, 4, 8, 16, 32] },
  { key: 'cloudAtten', label: '云衰', short: 'A_cloud', unit: 'dB', rec: 'ITU-R P.840 · 柱液态水', dec: 3, scheme: 'atten', step: 0.1, sat: true, band: 'link', levels: [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6] },
  { key: 'gasAtten', label: '气体吸收', short: 'A_gas', unit: 'dB', rec: 'ITU-R P.676 · 实测 T / P / ρ', dec: 3, scheme: 'viridis', step: 0.1, sat: true, band: 'link' },
  // —— 气象量：数据源直接给的，或由它按 P.453 派生的 ——
  { key: 'rain', label: '降水强度', short: 'R', unit: 'mm/h', dec: 2, scheme: 'precip', step: 2, raw: true, band: 'met', levels: [0, 0.1, 0.5, 1, 2, 4, 8, 16, 32, 64] },
  { key: 'cloud', label: '云量', short: 'CC', unit: '%', dec: 0, scheme: 'cloudy', step: 20, raw: true, band: 'met', levels: [0, 10, 25, 40, 55, 70, 85, 95, 100] },
  { key: 'cwat', label: '柱云水', short: 'L', unit: 'kg/m²', dec: 3, scheme: 'cloudIr', step: 0.2, raw: true, band: 'met', levels: [0, 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2] },
  { key: 'temp', label: '气温', short: 'T', unit: '°C', dec: 1, scheme: 'turbo', step: 5, raw: true, band: 'met' },
  { key: 'rh', label: '相对湿度', short: 'RH', unit: '%', dec: 0, scheme: 'viridis', step: 10, raw: true, band: 'met' },
  { key: 'rho', label: '水汽密度 ρ', short: 'ρ', unit: 'g/m³', rec: 'ITU-R P.453 · 由实测 T / 湿度导出', dec: 1, scheme: 'viridis', step: 2, band: 'met' },
  { key: 'nwet', label: '湿项折射率 N_wet', short: 'N_wet', unit: '', rec: 'ITU-R P.453', dec: 0, scheme: 'viridis', step: 10, band: 'met' },
  { key: 'pMsl', label: '海平面气压', short: 'P', unit: 'hPa', dec: 1, scheme: 'jet', step: 2, raw: true, band: 'met' },
  { key: 'wind', label: '风速', short: 'V', unit: 'm/s', dec: 1, scheme: 'viridis', step: 2, raw: true, band: 'met' }
];
const fieldDef = (k) => FIELD_DEFS.find((f) => f.key === k) || null;
const isSatField = (k) => { const d = fieldDef(k); return !!(d && d.sat); };

/** 立方体某一帧的双线性取值。落在缺格上返回 NaN（NaN 会自然传染，正是想要的） */
function bilinear(arr, base, nx, ny, fx, fy) {
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x0 > nx - 2) x0 = Math.max(0, nx - 2);
  if (y0 > ny - 2) y0 = Math.max(0, ny - 2);
  const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  const v00 = arr[base + y0 * nx + x0], v10 = arr[base + y0 * nx + x1];
  const v01 = arr[base + y1 * nx + x0], v11 = arr[base + y1 * nx + x1];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}
/**
 * 这一帧里某个量到底有没有值。
 *
 * ★ 判据必须是「有没有有限值」，不能是「数组在不在」：立方体的各量是**整块预分配**的
 *   （见 gfs.js 的 mk() + fill(NaN)），源里没有该要素、或这一时次的报文里恰好缺了它，
 *   留下的是一整片 NaN，而数组照样在。按数组判会让「实测柱云水」这类可选量静默退化成 0
 *   （NaN || 0 → 0 → 云衰恒 0 dB），而该报的「数据源无柱云水，改用统计值」一句都不报 ——
 *   算错了还看着很正常，是最坏的一类错。
 *
 * ★ 全扫不抽样：有值时第一格就命中、直接返回；只有真缺的那一帧才走满一遍 N（几万到几十万格的
 *   一趟空循环，相较逐格跑 ITU 引擎的主循环可以忽略）。抽样会在「只有边角有值」时判错。
 */
function frameHasVar(arr, base, n) {
  if (!arr) return false;
  for (let i = 0; i < n; i++) if (Number.isFinite(arr[base + i])) return true;
  return false;
}

/** 分类量（降水类型）用最近邻 —— 「雨和雪之间」没有物理意义 */
function nearest(arr, base, nx, ny, fx, fy) {
  const x = Math.max(0, Math.min(nx - 1, Math.round(fx)));
  const y = Math.max(0, Math.min(ny - 1, Math.round(fy)));
  return arr[base + y * nx + x];
}

/**
 * 取数窗永远是矩形（子集服务只吃 bbox），但**看图的范围**可以是任意多边形。
 * 故多边形不是另一种取数范围，而是一道**出图裁剪**：窗外的格一律 NaN（= 留白），
 * 与「缺格」「不可见」走同一条路，上色、提线、统计三处自动跟着走，不必各改一遍。
 * ★ 裁剪放在逐格循环的最前面：衰减场每格要跑一次 ITU 引擎，多边形外的格连算都不算。
 *
 * 入参容得下两种写法：[[lon,lat],…] 与 [{lon,lat},…]。首尾点重不重复都行（闭合自理）。
 */
function normPoly(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return null;
  const out = new Float64Array(poly.length * 2);
  let n = 0;
  for (const p of poly) {
    const lon = Array.isArray(p) ? Number(p[0]) : Number(p && p.lon);
    const lat = Array.isArray(p) ? Number(p[1]) : Number(p && p.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out[n * 2] = lon; out[n * 2 + 1] = lat; n++;
  }
  return n >= 3 ? out.subarray(0, n * 2) : null;
}
/** 射线法。边界上算内（多一格少一格不影响读图，但少一格会在边上啃出锯齿） */
function pointInPoly(lon, lat, ring) {
  const n = ring.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1];
    const xj = ring[j * 2], yj = ring[j * 2 + 1];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 目标星几何：把「GEO 轨位」与「任意轨道的星下点」两种给法合成同一个取角函数。
 *
 * ★ 这是本模块**普适性**的落点：从前只认 satLon，等于只能算静止轨道；LEO/MEO/HEO 与倾斜 GSO 的
 *   星下点在赤道以外、高度也不是 35786 km，那条闭式表达不出来。给了 satPos 就走 WGS-84 通用几何
 *   （与 NGSO 链路预算 / 可见性分析同一套）；只给 satLon 仍走闭式，与 GSO 链路预算逐位一致。
 *
 * ★ 几何在**逐格循环里先算**、算完才决定要不要跑引擎：LEO 的可见区只占全球图的百分之几，
 *   先判可见就把高程查询与整套 ITU 引擎一起省了（LEO 全球图实测快一个量级以上）。
 *
 * @returns null 表示没给目标星；否则 { mode, angles(lat,lon,altKm), range(lat,lon,altKm), satPos|satLon }
 */
function satGeom(o) {
  const satPos = inst.normSatPos(o && o.satPos);
  if (satPos) {
    return {
      mode: 'orbit', satPos,
      angles: (lat, lon, altKm) => inst.lookAngles({ lat, lon, altKm }, satPos),
      range: (lat, lon, altKm) => inst.lookAngles({ lat, lon, altKm }, satPos).rangeKm
    };
  }
  const satLon = Number(o && o.satLon);
  if (Number.isFinite(satLon)) {
    const gp = inst.geoSatPos(satLon);
    return {
      mode: 'geo', satLon,
      angles: (lat, lon) => lc.calculateSatelliteAngle(lat, lon, satLon),
      // 斜距只是读数，不进衰减算式；用椭球算比再造一条球面式子准，且与 satPos 档同口径
      range: (lat, lon, altKm) => inst.lookAngles({ lat, lon, altKm }, gp).rangeKm
    };
  }
  return null;
}

/** 由时刻找最近的一帧。返回索引与实际帧时刻（界面要如实显示用的是哪一帧） */
function frameAt(cube, tMs) {
  const T = cube && cube.times;
  if (!T || !T.length) return { idx: -1, t: 0, inRange: false };
  if (!Number.isFinite(tMs)) return { idx: 0, t: T[0], inRange: true };
  let best = 0, bd = Infinity;
  for (let i = 0; i < T.length; i++) { const d = Math.abs(T[i] - tMs); if (d < bd) { bd = d; best = i; } }
  const stepMs = T.length > 1 ? Math.abs(T[1] - T[0]) : 3600000;
  return { idx: best, t: T[best], inRange: bd <= stepMs, offMs: T[best] - tMs };
}

// 面积加权统计（cos φ）。与 envField.statsOf 同口径，含分位数。
function statsOf(values, nx, ny, latMax, dLat, mask) {
  let min = Infinity, max = -Infinity, wsum = 0, vsum = 0, count = 0;
  const finite = [];
  for (let j = 0; j < ny; j++) {
    const w = Math.cos((latMax - (j + 0.5) * dLat) * Math.PI / 180);
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (mask && !mask[k]) continue;
      const v = values[k];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      wsum += w; vsum += v * w; count++; finite.push(v);
    }
  }
  if (!count) return null;
  finite.sort((a, b) => a - b);
  const q = (p) => finite[Math.max(0, Math.min(finite.length - 1, Math.round(p * (finite.length - 1))))];
  return { min, max, mean: wsum > 0 ? vsum / wsum : NaN, count, p2: q(0.02), p50: q(0.5), p98: q(0.98) };
}

/**
 * 取一张实时/预报场栅格。
 * @param {object} cube  weather.js 的立方体（含 vars 各 Float32Array(nt*ny*nx)）
 * @param {object} o     { key, tMs|frame, step, satLon, freq, pol, cloudMode, cloudP, pathModel, mask }
 * @returns 与 envField.sampleField 同构的对象
 */
function sampleField(cube, o) {
  o = o || {};
  const def = fieldDef(o.key);
  if (!def) return { error: '未知字段：' + o.key };
  if (!cube || !cube.nt) return { error: '尚未取气象数据' };

  const fr = Number.isFinite(o.frame) ? { idx: o.frame, t: cube.times[o.frame], inRange: true } : frameAt(cube, o.tMs);
  if (fr.idx < 0 || fr.idx >= cube.nt) return { error: '该时刻不在已取数据的时段内' };

  const B = cube.bbox;
  const latMin = B.latMin, latMax = B.latMax, lonMin = B.lonMin, lonMax = B.lonMax;
  // 出图格距：默认取立方体格距的 1/2（既平滑又不至于把每格的 computeInstant 算爆）
  let step = Number(o.step) > 0 ? Number(o.step) : cube.step / 2;
  let nx = Math.max(2, Math.round((lonMax - lonMin) / step));
  let ny = Math.max(2, Math.round((latMax - latMin) / step));
  // 点数上限：衰减场每格要跑一次 P.676/P.838，成本比纯气象场高一个量级，故两族分开设。
  // ★ 做成入参而不是常数：拖时间轴要跟得上（帧一换就整场重算）与出图要够细，是一对取舍，
  //   该由用它的人按机器决定，不该由本文件替他定死。
  const CAP = Math.max(2500, Math.min(1e6, Number(o.cap) || (isSatField(o.key) ? 40000 : 250000)));
  if (nx * ny > CAP) { const f = Math.sqrt(nx * ny / CAP); nx = Math.max(2, Math.round(nx / f)); ny = Math.max(2, Math.round(ny / f)); }
  const dLon = (lonMax - lonMin) / nx, dLat = (latMax - latMin) / ny;

  const N = cube.nx * cube.ny, base = fr.idx * N;
  const V = cube.vars;
  const sat = isSatField(o.key);
  const geom = satGeom(o);
  const freq = Number(o.freq) || 12.5;
  const pol = String(o.pol || 'C').toUpperCase();
  if (sat && !geom) return { error: '衰减场需要目标卫星（每一格仰角不同）：填 GEO 轨位，或给出星下点与轨道高度' };

  // 云衰口径。'measured' 要的是逐格柱液态水，只有栅格源给得出；点源（只有云量百分比）
  // 推不出柱液态水，故这里**如实退回统计档并留话**，不拿云量硬凑一个数出来。
  // ★ 「给不给得出」按 frameHasVar 判这一帧有没有有限值，不是判数组在不在（见该函数注释）。
  const hasCwat = frameHasVar(V.cwat, base, N);
  let cloudMode = o.cloudMode || 'p840';
  const wantMeasured = cloudMode === 'measured';
  const cloudMeasured = wantMeasured && hasCwat;
  if (wantMeasured && !cloudMeasured) cloudMode = 'p840';

  const values = new Float32Array(nx * ny);
  const wantMask = !!o.mask && elevation.isElevationReady();
  const land = wantMask ? new Uint8Array(nx * ny) : null;
  // 最低仰角：低于此值一律留白（见下方低仰角闸）。默认 5°，与 P.618 §2.2 的适用下界一致。
  const minElev = Number.isFinite(Number(o.minElev)) ? Math.max(0, Number(o.minElev)) : 5;
  const ring = normPoly(o.poly);
  const t0 = Date.now();
  let snowCells = 0, offEarth = 0, holes = 0, lowElev = 0, inPoly = 0;

  for (let j = 0; j < ny; j++) {
    const lat = latMax - (j + 0.5) * dLat;
    const fy = (lat - latMin) / cube.step;
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const lon = lonMin + (i + 0.5) * dLon;
      const fx = (lon - lonMin) / cube.step;
      const k = row + i;
      // 多边形裁剪先于一切：窗外的格既不查高程也不跑引擎
      if (ring && !pointInPoly(lon, lat, ring)) { values[k] = NaN; continue; }
      if (ring) inPoly++;
      // 几何闸紧随其后（衰减场）：不可见 / 低仰角的格，高程查询与 ITU 引擎全部免跑。
      // ★ LEO 的可见区只是全球图上的一小片圆，这一闸决定了这张图跑不跑得动。
      let elDeg = 0, azDeg = 0;
      if (sat) {
        const g = geom.angles(lat, lon, 0);
        elDeg = g.elevation; azDeg = g.azimuth;
        if (!(elDeg > 0)) { values[k] = NaN; offEarth++; continue; }              // 星在地平线下：留白，不画 0 dB
        // ★ 低仰角闸。擦地几何下斜路径长度趋于发散，一格能算出 150 dB —— 数字「没错」，
        //   但 P.618/P.676 的路径近似在 5° 以下本就不成立，且一个孤立的极值会毁掉整条色带。
        //   故如实留白并计数，不画一个自己都不信的数。GEO 的全球图上这一片相当大，必须点明。
        if (elDeg < minElev) { values[k] = NaN; lowElev++; continue; }
      }
      if (land) { const e = elevation.queryElevation(lat, lon); land[k] = (e.success && e.altitude > 0) ? 1 : 0; }

      const tC = bilinear(V.tC, base, cube.nx, cube.ny, fx, fy);
      if (!Number.isFinite(tC)) { values[k] = NaN; holes++; continue; }   // 缺格：留白，不填 0

      // 不依赖卫星的场：直接出，省掉 computeInstant
      if (!sat) {
        let v = NaN;
        switch (o.key) {
          case 'rain': v = bilinear(V.rain, base, cube.nx, cube.ny, fx, fy); break;
          case 'cloud': v = bilinear(V.cloud, base, cube.nx, cube.ny, fx, fy) * 100; break;
          // 柱云水只有栅格源给得出（按点的天气 API 只给云量百分比）。源里没有就整场留白，不编。
          case 'cwat': v = hasCwat ? bilinear(V.cwat, base, cube.nx, cube.ny, fx, fy) : NaN; break;
          case 'temp': v = tC; break;
          case 'rh': v = bilinear(V.rh, base, cube.nx, cube.ny, fx, fy) * 100; break;
          case 'pMsl': v = bilinear(V.pMsl, base, cube.nx, cube.ny, fx, fy); break;
          case 'wind': v = bilinear(V.wind, base, cube.nx, cube.ny, fx, fy); break;
          case 'rho': case 'nwet': {
            const rh = bilinear(V.rh, base, cube.nx, cube.ny, fx, fy);
            const td = bilinear(V.td, base, cube.nx, cube.ny, fx, fy);
            const p = bilinear(V.pMsl, base, cube.nx, cube.ny, fx, fy);
            const e = met.vapourPressure({ tC, rh, tdC: td, pMslHpa: p });
            v = o.key === 'rho' ? met.vapourDensity(e, tC) : met.nWet(e, tC);
            break;
          }
        }
        values[k] = Number.isFinite(v) ? v : NaN;
        continue;
      }

      // 衰减场：每格造一份快照跑引擎
      const altM = elevation.isElevationReady() ? (elevation.queryElevation(lat, lon).altitude || 0) : 0;
      // 过了闸才拿站址海拔把仰角重算一遍：闸上那次按海平面算（免掉不可见格的高程查询），
      // 而衰减对 1/sinθ 敏感，低仰角时几公里海拔值零点几度。GEO 闭式无海拔项，这一步对它是恒等。
      if (altM > 0) { const g2 = geom.angles(lat, lon, Math.max(0, altM) / 1000); elDeg = g2.elevation; azDeg = g2.azimuth; }
      const snap = {
        t: fr.t, kind: 'fcst', tC,
        pMslHpa: bilinear(V.pMsl, base, cube.nx, cube.ny, fx, fy),
        rh: bilinear(V.rh, base, cube.nx, cube.ny, fx, fy),
        tdC: bilinear(V.td, base, cube.nx, cube.ny, fx, fy),
        rainMmH: Math.max(0, bilinear(V.rain, base, cube.nx, cube.ny, fx, fy) || 0),
        precipType: PTYPE[Math.round(nearest(V.ptype, base, cube.nx, cube.ny, fx, fy)) || 0] || 'none',
        cloud: bilinear(V.cloud, base, cube.nx, cube.ny, fx, fy),
        src: 'qweather'
      };
      const r = inst.computeInstant({
        // 仰角/方位角上面已按目标星算好，直接回填 —— 引擎不再自己解几何（两处算等于两套口径）
        lat, lon, altKm: Math.max(0, altM) / 1000, freq, pol,
        elevation: elDeg, azimuth: azDeg, met: snap,
        pathModel: o.pathModel || 'uniform',
        cloudMode, cloudP: o.cloudP,
        // 实测档：柱液态水逐格从立方体取（栅格源直接输出这一项），不是全场一个数
        cloudLKgM2: cloudMeasured ? Math.max(0, bilinear(V.cwat, base, cube.nx, cube.ny, fx, fy) || 0) : undefined,
        diameter: 1, efficiency: 60
      });
      if (r.error) { values[k] = NaN; offEarth++; continue; }             // 兜底：几何闸已在前面拦过
      const v = o.key === 'rainAtten' ? r.rainDb : o.key === 'gasAtten' ? r.gasDb
        : o.key === 'cloudAtten' ? r.cloudDb : r.totalDb;
      if (v == null) { values[k] = NaN; snowCells++; continue; }          // 雪/冰：P.838 不适用
      values[k] = Number.isFinite(v) ? v : NaN;
    }
  }

  const notes = [];
  if (ring) notes.push(`Polygon 内 ${inPoly} 格`);
  if (holes) notes.push(`${holes} 格无数据`);
  if (offEarth) notes.push(`${offEarth} 格对该星不可见`);
  if (lowElev) notes.push(`${lowElev} 格仰角 < ${minElev}°（模型不适用，已留白）`);
  if (snowCells) notes.push(`${snowCells} 格为雪 / 冰（ITU-R P.838 不适用，未计雨衰）`);
  if (wantMeasured && !cloudMeasured) notes.push('数据源无柱云水，云衰改用 ITU-R P.840 统计值');
  if (o.key === 'cwat' && !hasCwat) notes.push('数据源不提供柱云水');

  // 数据源名字不写死在字段表里：同一张「降水强度」既可能来自数值预报栅格，也可能来自按点的实况 API，
  // 图上必须显示的是**这一份**是谁给的。
  const srcName = cube.model || cube.src || '气象源';
  return {
    key: o.key, label: def.label, short: def.short, unit: def.unit,
    rec: def.raw ? srcName : def.rec, levels: def.levels || null, band: def.band || 'met',
    dec: def.dec, scheme: def.scheme, contourStep: def.step, seaHint: true,
    native: cube.step, precision: `格距 ${cube.step}°`, ready: true, fallback: false,
    maskAvail: elevation.isElevationReady(),
    bbox: { latMin, latMax, lonMin, lonMax },
    nx, ny, step: dLon, values, land,
    stats: statsOf(values, nx, ny, latMax, dLat, null),
    statsLand: land ? statsOf(values, nx, ny, latMax, dLat, land) : null,
    frame: fr.idx, frameT: fr.t, inRange: fr.inRange, offMs: fr.offMs || 0, minElev,
    // 这张图用的是哪套几何、对着哪颗星 —— 图上看不出来，出参里必须留得下（LEO 与 GEO 的场长得完全不同）
    geomModel: geom ? geom.mode : null,
    satPos: geom && geom.satPos ? { ...geom.satPos } : null,
    satLon: geom && geom.mode === 'geo' ? geom.satLon : null,
    clip: !!ring, inPoly: ring ? inPoly : null,
    attrib: cube.attrib || [], note: notes.join(' · '), ms: Date.now() - t0
  };
}

/** 单点读数（状态栏兜底通道；常规读数由渲染端就近读已缓存栅格） */
function pointValue(cube, o) {
  const r = sampleField(cube, { ...o, step: undefined, mask: false });
  return r && !r.error ? r : null;
}

/**
 * 多站逐点读数 —— 站点表用的那条路。
 *
 * ★ 与 sampleField 的关系：出图是「先铺一整张栅格再上色」，站点表是「只在这 N 个点上算」。
 *   N 个点直接算比先出图再采样准得多 —— 出图那张栅格为了跑得动是**降过采样**的
 *   （衰减场默认压到 4 万点，中国区约 0.26°），在它上面采样等于二次插值；这里直接在
 *   立方体的原生格上双线性取值再跑一次引擎，站址的读数就是站址的读数。
 *
 * ★ 值随**时间轴**走，不是「现在的实况」：站点表的每一行都是 tMs 那一刻的预报值。
 *   实况另有来路（和风按点，只能给"现在"），两者口径不同，别混。
 *
 * @param {object} o { pts:[{id,lat,lon,name}], frame|tMs, satLon|satPos, freq, pol,
 *                     pathModel, cloudMode, cloudP, minElev, diameter, efficiency }
 * @returns { frame, frameT, inRange, model, rows:[…] }；越界/不可见的行带 err 而不是假数字
 */
function samplePoints(cube, o) {
  o = o || {};
  if (!cube || !cube.nt) return { error: '尚未取气象数据' };
  const pts = Array.isArray(o.pts) ? o.pts : [];
  const fr = Number.isFinite(o.frame) ? { idx: o.frame, t: cube.times[o.frame], inRange: true } : frameAt(cube, o.tMs);
  if (fr.idx < 0 || fr.idx >= cube.nt) return { error: '该时刻不在已取数据的时段内' };

  const B = cube.bbox, V = cube.vars;
  const N = cube.nx * cube.ny, base = fr.idx * N;
  const geom = satGeom(o);
  const wantLink = !!geom;
  const freq = Number(o.freq) || 12.5;
  const pol = String(o.pol || 'C').toUpperCase();
  const minElev = Number.isFinite(Number(o.minElev)) ? Math.max(0, Number(o.minElev)) : 5;
  // 「实测柱云水」这一档能不能走，按这一帧有没有有限值判（见 frameHasVar），不是判数组在不在
  const hasCwat = frameHasVar(V.cwat, base, N);
  let cloudMode = o.cloudMode || 'p840';
  const wantMeasured = cloudMode === 'measured';
  const cloudMeasured = wantMeasured && hasCwat;
  if (wantMeasured && !cloudMeasured) cloudMode = 'p840';

  const t0 = Date.now();
  const rows = pts.map((p) => {
    const lat = Number(p.lat), lon = Number(p.lon);
    const row = { id: p.id, name: p.name, lat, lon };
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { row.err = '坐标无效'; return row; }
    // 越界不外推：立方体只覆盖取数窗，窗外一律如实报，不拿边界值顶替
    if (lat < B.latMin || lat > B.latMax || lon < B.lonMin || lon > B.lonMax) { row.err = '在取数范围外'; return row; }
    const fx = (lon - B.lonMin) / cube.step, fy = (lat - B.latMin) / cube.step;
    const g = (a) => (a ? bilinear(a, base, cube.nx, cube.ny, fx, fy) : NaN);

    row.tC = g(V.tC);
    if (!Number.isFinite(row.tC)) { row.err = '该点无数据'; return row; }
    row.tdC = g(V.td); row.rh = g(V.rh); row.pMslHpa = g(V.pMsl);
    row.rainMmH = Math.max(0, g(V.rain) || 0);
    row.cloud = g(V.cloud); row.cwat = hasCwat ? g(V.cwat) : NaN; row.wind = g(V.wind);
    row.ptype = PTYPE[Math.round(nearest(V.ptype, base, cube.nx, cube.ny, fx, fy)) || 0] || 'none';
    const e = met.vapourPressure({ tC: row.tC, rh: row.rh, tdC: row.tdC, pMslHpa: row.pMslHpa });
    row.rho = met.vapourDensity(e, row.tC); row.nwet = met.nWet(e, row.tC);
    const altM = elevation.isElevationReady() ? (elevation.queryElevation(lat, lon).altitude || 0) : 0;
    row.altKm = Math.max(0, altM) / 1000;
    if (!wantLink) return row;

    // 几何先算：仰角/方位/斜距三项对不可见的站也照报（读表的人要看到「差多少才可见」，不是一片空白）
    const ga = geom.angles(lat, lon, row.altKm);
    row.elev = ga.elevation; row.az = ga.azimuth;
    row.rangeKm = Number.isFinite(ga.rangeKm) ? ga.rangeKm : geom.range(lat, lon, row.altKm);
    if (!(row.elev > 0)) { row.err = '该点对此卫星不可见'; return row; }
    if (row.elev < minElev) { row.err = `仰角 < ${minElev}°`; return row; }

    const r = inst.computeInstant({
      lat, lon, altKm: row.altKm, freq, pol, elevation: row.elev, azimuth: row.az,
      met: { t: fr.t, kind: 'fcst', tC: row.tC, pMslHpa: row.pMslHpa, rh: row.rh, tdC: row.tdC,
        rainMmH: row.rainMmH, precipType: row.ptype, cloud: row.cloud, src: cube.src || 'model' },
      pathModel: o.pathModel || 'uniform',
      cloudMode, cloudP: o.cloudP,
      cloudLKgM2: cloudMeasured ? Math.max(0, row.cwat || 0) : undefined,
      diameter: Number(o.diameter) || 1, efficiency: Number(o.efficiency) || 60
    });
    if (r.error) { row.err = r.message || '不可见'; return row; }
    row.gasDb = r.gasDb; row.rainDb = r.rainDb; row.cloudDb = r.cloudDb;
    row.totalDb = r.totalDb; row.scintDb = r.scintSigmaDb;
    if (r.rainDb == null) row.note = '雪 / 冰（ITU-R P.838 不适用）';
    return row;
  });

  return {
    frame: fr.idx, frameT: fr.t, inRange: fr.inRange, offMs: fr.offMs || 0,
    model: cube.model || cube.src || '气象源', cycle: cube.cycle || null,
    step: cube.step, cloudMode, cloudFellBack: wantMeasured && !cloudMeasured,
    geomModel: geom ? geom.mode : null,
    satPos: geom && geom.satPos ? { ...geom.satPos } : null,
    satLon: geom && geom.mode === 'geo' ? geom.satLon : null,
    minElev, rows, ms: Date.now() - t0
  };
}

module.exports = { FIELD_DEFS, fieldDef, isSatField, sampleField, samplePoints, pointValue, frameAt, PTYPE, bilinear, statsOf, normPoly, pointInPoly, satGeom };
