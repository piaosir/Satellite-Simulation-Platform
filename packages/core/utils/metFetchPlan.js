// metFetchPlan.js — 气象取数计划器（把「一张场要多少次请求」压到最低）
//
// 为什么需要这个文件：和风天气（以及所有面向 App 的天气 API）只有**按点查询**，没有栅格接口。
// 一张场天真地做就是「格点数 = 请求数」，中国全境 0.25° 要 35712 次 —— 一次就吃掉月免费额度
// 的 71%。本模块把这个数压下来，靠四件事：
//
//   ① 时间维度免费。逐小时接口一次返回最多 240 h，所以**请求数只与格点数有关，与时间轴长度无关**。
//      拉一次管十天：同一区域在 REFRESH_MS 内不重拉，而不是每小时拉一遍。
//   ② 字段维度免费。一次请求返回全部要素（温/湿/压/降水/云/风），所以界面上换字段（雨强↔雨衰↔
//      云量↔气温）一次请求都不花。花钱的只有「换范围」和「换格距」——UI 必须让人感觉得到这个区别。
//   ③ 两级自适应加密。降水在空间上极稀疏：多数格、多数时刻没有雨，而没有雨的地方雨衰恒等于 0，
//      不必细拉。先按粗格扫一遍，只在**有雨的粗格及其邻域**按细格加密。典型省 70~85%。
//   ④ 空间缓存复用。键按两位小数量化（正好是 API 的坐标精度上限），窗口挪一点只补新增格点。
//
// ★ 网格用**节点约定** lat = latMin + j·step（不是 envField 的格心约定）。两个理由：
//   · 粗格与细格必须**嵌套**——细格距整除粗格距时，粗格节点恰好是细格节点的子集，第 ① 步拉到的
//     点在第 ② 步全部可复用。格心约定下两级网格互相错开半格，粗扫的点一个都用不上。
//   · 节点网格做双线性取样（沿路径积分要在任意经纬度取雨强）是自然的，格心还得先做半格偏移。
//
// 纯函数、无 IO、无网络，可离线单测。

// 坐标量化：和风文档明确「十进制，最多支持小数点后两位」。两位小数 ≈ 1.1 km，
// 与数据本身 1 km 的分辨率同量级，所以这既是 API 上限也是天然的缓存键粒度。
const QUANT = 2;
const QSTEP = 0.01;

// 判「这一格要不要加密」的雨强门限（mm/h）。取 0.05：20 GHz 下 γ ≈ 0.09×0.05^1.06 ≈ 0.004 dB/km，
// 6 km 路径合计 0.025 dB —— 在任何工程口径下都读不出来，不值得为它多花一次请求。
const RAIN_EPS = 0.05;

// 加密时把「有雨粗格」向外膨胀几格。1 格是必需的：粗格 0.5° ≈ 55 km，而对流单体只有 10 km 量级，
// 「粗格自身无雨」不等于格内处处无雨；把邻域一并加密，边界上漏掉一整块雨区的概率才降得下来。
const DILATE = 1;

// 硬上限：再怎么确认也不许单次超过这个请求数（跑起来要几十分钟，且一次吃掉大半月额度）。
const MAX_POINTS_HARD = 4000;
// 软阈值：超过要二次确认
const MAX_POINTS_WARN = 800;
// 同一批数据的复用时长：源侧逐小时预报 60 min 更新一次，取 6 h 是「不浪费请求」与
// 「预报别太陈」的折中；实况另有更短的 TTL，不走这里。
const REFRESH_MS = 6 * 3600 * 1000;

/** 量化到 API 支持的精度。返回 number，避免 '39.90' / '39.9' 两种写法产生两个缓存键 */
function q(v) { return Math.round(v / QSTEP) * QSTEP; }
/** 缓存键：量化后的 "lat,lon"，固定两位小数 */
function qkey(lat, lon) { return q(lat).toFixed(QUANT) + ',' + q(lon).toFixed(QUANT); }

/**
 * 节点网格的维度。lat = latMin + j·step（j = 0..ny-1），lon = lonMin + i·step。
 * 末端不足一格时仍收一个节点，保证 bbox 被完全覆盖。
 */
function gridDims(bbox, step) {
  const b = bbox || {};
  const latMin = Number(b.latMin), latMax = Number(b.latMax);
  const lonMin = Number(b.lonMin), lonMax = Number(b.lonMax);
  if (!(latMax > latMin) || !(lonMax > lonMin) || !(step > 0)) return null;
  const nx = Math.floor((lonMax - lonMin) / step + 1e-9) + 1;
  const ny = Math.floor((latMax - latMin) / step + 1e-9) + 1;
  return { latMin, latMax, lonMin, lonMax, step, nx, ny, n: nx * ny };
}

/** 节点索引 → 经纬度 */
function nodeAt(dims, ix, iy) {
  return { lat: dims.latMin + iy * dims.step, lon: dims.lonMin + ix * dims.step };
}

/**
 * 粗扫计划：整片 bbox 按 coarseStep 铺节点，去掉缓存里已有的。
 * @param {object} bbox   { latMin, latMax, lonMin, lonMax }
 * @param {number} coarseStep 粗格距（度）
 * @param {Set<string>} have  已有缓存的 qkey 集合（可空）
 * @returns {{ dims, points:Array<{lat,lon,key,ix,iy}>, total:number, cached:number, requests:number }}
 */
function planCoarse(bbox, coarseStep, have) {
  const dims = gridDims(bbox, coarseStep);
  if (!dims) return { dims: null, points: [], total: 0, cached: 0, requests: 0, error: '无效的取数范围' };
  const H = have || new Set();
  const points = [];
  let cached = 0;
  for (let iy = 0; iy < dims.ny; iy++) {
    for (let ix = 0; ix < dims.nx; ix++) {
      const nd = nodeAt(dims, ix, iy);
      const key = qkey(nd.lat, nd.lon);
      if (H.has(key)) { cached++; continue; }
      points.push({ lat: q(nd.lat), lon: q(nd.lon), key, ix, iy });
    }
  }
  return { dims, points, total: dims.n, cached, requests: points.length };
}

/**
 * 加密计划：在「粗格有雨」及其邻域内按 fineStep 补节点。
 *
 * @param {object} coarse  { dims, wet } —— wet 为长度 nx*ny 的数组/TypedArray，
 *                         wet[iy*nx+ix] 真值表示该粗格**在整个时间窗内任一时刻**降水 ≥ RAIN_EPS。
 *                         （判据必须跨整个时间窗：一次请求拿回 240 h，而雨区会在窗内移动，
 *                           只按当前帧判会让时间轴往后拖时突然出现没数据的空洞。）
 * @param {number} fineStep 细格距（度），须能整除粗格距，否则嵌套失效（会告警但仍执行）
 * @param {Set<string>} have 已有缓存的 qkey 集合（含刚拉回的粗格点）
 * @param {object} [opt]     { dilate }
 * @returns {{ points, requests, wetCells, refineCells, nested:boolean }}
 */
function planRefine(coarse, fineStep, have, opt) {
  const o = opt || {};
  const dims = coarse && coarse.dims;
  const wet = coarse && coarse.wet;
  if (!dims || !wet) return { points: [], requests: 0, wetCells: 0, refineCells: 0, nested: true };
  if (!(fineStep > 0) || fineStep >= dims.step) return { points: [], requests: 0, wetCells: 0, refineCells: 0, nested: true };

  const ratio = dims.step / fineStep;
  const nested = Math.abs(ratio - Math.round(ratio)) < 1e-6;
  const dil = Number.isFinite(o.dilate) ? o.dilate : DILATE;
  const H = have || new Set();

  // 膨胀：wet 的 Chebyshev 邻域内的粗格都要加密
  const need = new Uint8Array(dims.nx * dims.ny);
  let wetCells = 0;
  for (let iy = 0; iy < dims.ny; iy++) {
    for (let ix = 0; ix < dims.nx; ix++) {
      if (!wet[iy * dims.nx + ix]) continue;
      wetCells++;
      for (let dy = -dil; dy <= dil; dy++) {
        for (let dx = -dil; dx <= dil; dx++) {
          const jy = iy + dy, jx = ix + dx;
          if (jy < 0 || jy >= dims.ny || jx < 0 || jx >= dims.nx) continue;
          need[jy * dims.nx + jx] = 1;
        }
      }
    }
  }

  // 需加密的粗格 → 其覆盖范围内的细格节点（含右/上边界，故相邻粗格的公共边只算一次靠 have 去重）
  const seen = new Set();
  const points = [];
  let refineCells = 0;
  const sub = Math.max(1, Math.round(ratio));
  for (let iy = 0; iy < dims.ny; iy++) {
    for (let ix = 0; ix < dims.nx; ix++) {
      if (!need[iy * dims.nx + ix]) continue;
      refineCells++;
      const base = nodeAt(dims, ix, iy);
      for (let sy = 0; sy <= sub; sy++) {
        for (let sx = 0; sx <= sub; sx++) {
          const lat = base.lat + sy * fineStep, lon = base.lon + sx * fineStep;
          if (lat > dims.latMax + 1e-9 || lon > dims.lonMax + 1e-9) continue;
          const key = qkey(lat, lon);
          if (H.has(key) || seen.has(key)) continue;
          seen.add(key);
          points.push({ lat: q(lat), lon: q(lon), key });
        }
      }
    }
  }
  return { points, requests: points.length, wetCells, refineCells, nested };
}

/**
 * 由一批时间序列判「这个粗格在窗内是否有过雨」。
 * @param {Array<{rainMmH:number}>} series 该点的逐时刻快照
 * @param {number} [eps]
 */
function isWetSeries(series, eps) {
  const e = Number.isFinite(eps) ? eps : RAIN_EPS;
  if (!series || !series.length) return false;
  for (let i = 0; i < series.length; i++) {
    const r = Number(series[i] && series[i].rainMmH);
    if (Number.isFinite(r) && r >= e) return true;
  }
  return false;
}

/**
 * 给界面用的预算估算：不联网，只算「这个范围 + 这两级格距，最坏 / 典型要多少次请求」。
 * 典型值按经验降水面积占比 15% 估（连同 1 格膨胀后约占 40% 的粗格需要加密）。
 * ★ 只报区间，不报一个精确数 —— 真实值取决于当时雨区分布，取数前谁也不知道。
 */
function estimate(bbox, coarseStep, fineStep, have) {
  const c = planCoarse(bbox, coarseStep, have);
  if (!c.dims) return { error: c.error || '无效的取数范围' };
  const ratio = fineStep > 0 && fineStep < coarseStep ? Math.round(coarseStep / fineStep) : 1;
  const perCell = ratio > 1 ? (ratio + 1) * (ratio + 1) - 1 : 0;   // 每个粗格加密新增的细点（角点已有）
  const worst = c.requests + c.dims.n * perCell;
  const typical = c.requests + Math.round(c.dims.n * 0.4) * perCell;
  return {
    coarse: c.requests, coarseTotal: c.dims.n, cached: c.cached,
    nx: c.dims.nx, ny: c.dims.ny,
    typical, worst,
    overWarn: typical > MAX_POINTS_WARN,
    overHard: worst > MAX_POINTS_HARD
  };
}

/** 缓存条目是否还能用（同一区域 REFRESH_MS 内不重拉） */
function isFresh(savedAtMs, nowMs, ttlMs) {
  const ttl = Number.isFinite(ttlMs) ? ttlMs : REFRESH_MS;
  return Number.isFinite(savedAtMs) && (nowMs - savedAtMs) < ttl;
}

// ── 站点值跟时间轴：这一刻该问哪个接口 ──────────────────────────────────────
// 按点的天气 API 只有两样东西：**当前实况**与**未来逐小时预报**，没有历史。
// 故「拖时间轴取该时刻的站点值」不是一个接口的事，是一个三分支的判定：
//   本小时 → 实况观测；未来且在时效内 → 逐小时预报；再往前/再往后 → 没有，如实留白。
// ★ 判定必须是纯函数并单测：三个边界（本小时、时效末尾、过去一小时）在真实时钟下极难复现，
//   而错一格的表现是「表上有数但那个数不是这一刻的」—— 比报错难发现得多。
const HOUR_MS = 3600000;
const HOUR_BUCKETS = [24, 72, 168, 240];

/**
 * @param {number} tMs       想看的时刻（时间轴当前帧）
 * @param {number} nowMs     现在
 * @param {number} horizonMs 想一次买下的时间轴长度（相对现在），用于把请求档抬到够用的那一档
 * @returns {{mode:'obs'|'fcst'|'past'|'far', tgt:number, want:number|null, aheadH:number}}
 *          tgt = 就近的整点（取值一律对齐整点，逐小时产品本来就只给整点）
 */
function pointSourceAt(tMs, nowMs, horizonMs, buckets) {
  const B = Array.isArray(buckets) && buckets.length ? buckets : HOUR_BUCKETS;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowH = Math.floor(now / HOUR_MS) * HOUR_MS;
  const tgt = Number.isFinite(tMs) ? Math.round(tMs / HOUR_MS) * HOUR_MS : nowH;
  // ★ 「算不算现在」按 tgt 与**真实此刻**的距离判，不能按 tgt 与整点 nowH 的先后判：
  //   11:37 就近对齐到 12:00，按后者会判成「未来」—— 一打开界面（时钟就是此刻）就去买一次预报，
  //   而人要的只是"现在"的实况。容差取 1 h：逐小时产品的分辨率本来就是 1 h。
  const d = tgt - now;
  if (d <= HOUR_MS) return { mode: d < -HOUR_MS ? 'past' : 'obs', tgt, want: null, aheadH: 0 };
  const reach = Math.max(tgt, nowH + Math.max(0, Number(horizonMs) || 0));
  const aheadH = Math.ceil((reach - nowH) / HOUR_MS) + 1;
  const cap = B[B.length - 1];
  if (Math.ceil((tgt - nowH) / HOUR_MS) > cap) return { mode: 'far', tgt, want: null, aheadH };
  return { mode: 'fcst', tgt, want: B.find((h) => h >= aheadH) || cap, aheadH };
}

module.exports = {
  QUANT, QSTEP, RAIN_EPS, DILATE, MAX_POINTS_HARD, MAX_POINTS_WARN, REFRESH_MS, HOUR_BUCKETS,
  q, qkey, gridDims, nodeAt, planCoarse, planRefine, isWetSeries, estimate, isFresh, pointSourceAt
};
