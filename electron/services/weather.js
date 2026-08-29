// weather.js — 和风天气 provider（主进程）
//
// 职责边界：本文件是**唯一**知道「和风」这三个字的地方。出口一律是与数据源无关的结构
// （MetSnapshot 时间序列 / 时空立方体），换成 CMA 雷达 QPE、GFS 栅格、地球站现场雨量计，
// 只换这一个文件，引擎与界面一行不改。
//
// ── 为什么要有取数计划这一层 ────────────────────────────────────────────────
// 和风（以及所有面向 App 的天气 API）只有**按点查询**，没有栅格接口。一张场天真地做就是
// 「格点数 = 请求数」。压请求靠四件事，见 packages/core/utils/metFetchPlan.js 的文件头：
//   ① 时间维度免费 —— 逐小时接口一次回最多 240 h，故请求数只与格点数有关，与时间轴长度无关；
//   ② 字段维度免费 —— 一次请求回全部要素，界面上换字段（雨强↔雨衰↔云量↔气温）零请求；
//   ③ 两级自适应加密（可选）—— 只在有雨的粗格及邻域加密；
//   ④ 空间缓存复用 —— 键按两位小数量化（正好是 API 坐标精度上限），窗口挪一点只补新增点。
//
// ── 缓存 ──────────────────────────────────────────────────────────────────
// 落盘按 1°×1° 分片（userData/weather-cache/<lat>_<lon>.json），一个区域几十个文件，
// 既能点级复用又不会攒成一个几十 MB 的巨型 JSON。和风《缓存你的数据》建议逐小时预报缓存
// 30~60 min、源侧 60 min 更新一次；这里取 6 h，因为本平台的用法是「拉一次看一片时段」，
// 不是「每次打开都要最新一帧」——用户想要新的随时可以手动刷新。
//
// ★ 条款要求：用到数据的界面必须显示归因。故每份出参都带 attrib，界面不许丢。

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
// electron 只用来兜底取 userData 路径；调用方（main.js）总是显式传入，
// 故这里做成可选 require —— 少了它本模块就能在纯 Node 下单测/脚本化跑通（.wxharness 验证台靠这个）。
let _app = null;
try { _app = require('electron').app; } catch { /* 纯 Node 环境 */ }
const { signJwt, createTokenCache } = require('./qweatherJwt.js');
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore.js');

const plan = require('../../packages/core/utils/metFetchPlan.js');

const TIMEOUT_MS = 15000;
const CONCURRENCY = 4;            // 并发上限。和风没有公布硬限流阈值，4 是「够快又不像攻击」的折中
const CACHE_TTL_MS = 6 * 3600 * 1000;
const PTYPE = ['none', 'rain', 'snow', 'ice', 'mixed', 'unknown'];
const ptypeIdx = (s) => { const i = PTYPE.indexOf(String(s || 'none').toLowerCase()); return i < 0 ? 5 : i; };

module.exports = function createWeather(userDataDir) {
  const cacheDir = path.join(userDataDir || (_app && _app.getPath('userData')) || path.join(require('os').tmpdir(), 'satsim-weather'), 'weather-cache');
  const getToken = createTokenCache();
  let cfg = null, cfgErr = '';
  // 本地用量计数（控制台才是权威，这里只为界面上有个即时读数）
  const usageFile = path.join(cacheDir, '_usage.json');
  let usage = readJsonSafe(usageFile, { month: '', count: 0, cacheHit: 0 });
  // 最近一次拉回的立方体留在主进程（渲染端只按帧取栅格，不整块过 IPC）
  let cube = null;

  function loadConfig() {
    if (cfg || cfgErr) return;
    try {
      cfg = require('./weatherConfig.js');
      signJwt(cfg);                                   // 早失败：私钥格式不对现在就报，别等到发请求
    } catch (e) {
      cfg = null;
      cfgErr = /Cannot find module/.test(e.message)
        ? '未配置和风天气凭据（执行 node scripts/setup-weather-config.mjs 生成）'
        : ('凭据不可用：' + e.message);
    }
  }

  function bumpUsage(n, hit) {
    const m = new Date().toISOString().slice(0, 7);
    if (usage.month !== m) usage = { month: m, count: 0, cacheHit: 0 };
    usage.count += n || 0; usage.cacheHit += hit || 0;
    try { fs.mkdirSync(cacheDir, { recursive: true }); writeJsonAtomic(usageFile, usage); } catch { /* 只是计数，写不进不影响取数 */ }
  }

  // ---- HTTP ----
  function get(reqPath) {
    loadConfig();
    if (!cfg) return Promise.reject(new Error(cfgErr));
    const token = getToken(cfg);
    return new Promise((resolve, reject) => {
      const r = https.request({
        host: cfg.apiHost, method: 'GET', path: reqPath, timeout: TIMEOUT_MS,
        headers: { Authorization: 'Bearer ' + token, 'Accept-Encoding': 'gzip' }
      }, (rs) => {
        const chunks = [];
        rs.on('data', (c) => chunks.push(c));
        rs.on('end', () => {
          let buf = Buffer.concat(chunks);
          if (/gzip/i.test(rs.headers['content-encoding'] || '')) {
            try { buf = zlib.gunzipSync(buf); } catch (e) { return reject(new Error('gzip 解压失败')); }
          }
          const body = buf.toString('utf8');
          if (rs.statusCode !== 200) {
            // 这几种错的修法完全不同，分因报出来，否则只看到一个 401 无从下手
            const why = rs.statusCode === 401 ? '身份认证失败（kid/iss/sub 或公私钥不成对）'
              : rs.statusCode === 403 ? '无权限（控制台未启用「天气预报」，或凭据的 API 限制不允许）'
                : rs.statusCode === 404 ? '请求路径或 API Host 有误'
                  : rs.statusCode === 429 ? '已触发限流，请稍后重试' : '';
            return reject(new Error(`HTTP ${rs.statusCode}${why ? '：' + why : ''}`));
          }
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('返回内容不是 JSON')); }
        });
      });
      r.on('timeout', () => { r.destroy(); reject(new Error('请求超时 ' + (TIMEOUT_MS / 1000) + ' s')); });
      r.on('error', (e) => reject(new Error(e.message)));
      r.end();
    });
  }

  const val = (o) => (o && typeof o === 'object' && 'value' in o ? o.value : o);

  /** 和风 hours[] → 本平台的紧凑序列（数值型数组，便于落盘与逐帧取用） */
  function packHourly(j) {
    const hs = (j && j.hours) || [];
    const n = hs.length;
    const out = {
      t0: n ? Date.parse(hs[0].forecastTime) : 0,
      stepMs: n > 1 ? (Date.parse(hs[1].forecastTime) - Date.parse(hs[0].forecastTime)) : 3600000,
      n,
      time: new Array(n), tC: new Array(n), pMsl: new Array(n), rh: new Array(n), td: new Array(n),
      rain: new Array(n), cloud: new Array(n), wind: new Array(n), wdir: new Array(n), ptype: new Array(n),
      text: new Array(n)
    };
    for (let i = 0; i < n; i++) {
      const h = hs[i];
      out.time[i] = Date.parse(h.forecastTime);
      out.text[i] = (h.condition && h.condition.text) || h.text || '';
      out.tC[i] = val(h.temperature);
      out.pMsl[i] = val(h.pressure);
      out.rh[i] = h.humidity;
      out.td[i] = val(h.dewPoint);
      out.rain[i] = val(h.precipitation && h.precipitation.intensity) || 0;
      out.cloud[i] = h.cloudCover;
      out.wind[i] = val(h.wind && h.wind.speed);
      out.wdir[i] = (h.wind && h.wind.direction && h.wind.direction.degree) || 0;
      out.ptype[i] = ptypeIdx(h.precipitation && h.precipitation.type);
    }
    out.attrib = (j && j.metadata && j.metadata.attributions) || [];
    return out;
  }

  // ---- 落盘缓存（按 1°×1° 分片）----
  const tileFile = (lat, lon) => path.join(cacheDir, `${Math.floor(lat)}_${Math.floor(lon)}.json`);
  const tileCacheMem = new Map();
  function readTile(lat, lon) {
    const f = tileFile(lat, lon);
    if (tileCacheMem.has(f)) return tileCacheMem.get(f);
    const t = readJsonSafe(f, {});
    tileCacheMem.set(f, t);
    return t;
  }
  function cacheGet(lat, lon, hours, now) {
    const t = readTile(lat, lon);
    const e = t[plan.qkey(lat, lon)];
    if (!e || !plan.isFresh(e.savedAt, now, CACHE_TTL_MS)) return null;
    if (e.n < hours) return null;                    // 上次拉得比这次要的短，不能凑合
    return e;
  }
  const dirtyTiles = new Set();
  function cachePut(lat, lon, ser, now) {
    const f = tileFile(lat, lon);
    const t = readTile(lat, lon);
    t[plan.qkey(lat, lon)] = { ...ser, savedAt: now };
    dirtyTiles.add(f);
  }
  function flushTiles() {
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* 目录已存在 */ }
    for (const f of dirtyTiles) { try { writeJsonAtomic(f, tileCacheMem.get(f)); } catch { /* 单片写失败不影响本次出图 */ } }
    dirtyTiles.clear();
  }

  /** 取一个点的逐小时序列（先查缓存） */
  async function fetchPoint(lat, lon, hours, now) {
    const hit = cacheGet(lat, lon, hours, now);
    if (hit) { bumpUsage(0, 1); return { ser: hit, cached: true }; }
    const j = await get(`/weather/v1/hourly/${lat.toFixed(2)}/${lon.toFixed(2)}?hours=${hours}`);
    const ser = packHourly(j);
    if (!ser.n) throw new Error('该点无逐小时数据');
    cachePut(lat, lon, ser, now);
    bumpUsage(1, 0);
    return { ser, cached: false };
  }

  /** 并发闸：同时最多 CONCURRENCY 个在飞，出错记下但不中断整批 */
  async function pool(items, worker, onProgress) {
    const out = new Array(items.length);
    let idx = 0, done = 0;
    const errs = [];
    async function run() {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        try { out[i] = await worker(items[i], i); }
        catch (e) { out[i] = null; errs.push({ i, msg: e.message }); }
        done++;
        if (onProgress && (done % 8 === 0 || done === items.length)) onProgress(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
    return { out, errs };
  }

  // ---- 对外 ----

  function configured() {
    loadConfig();
    return cfg ? { ok: true, apiHost: cfg.apiHost } : { ok: false, message: cfgErr };
  }

  async function test() {
    try {
      const j = await get('/weather/v1/current/39.92/116.41');
      bumpUsage(1, 0);
      return { ok: true, temp: val(j.temperature), text: j.condition && j.condition.text,
        attrib: (j.metadata && j.metadata.attributions) || [] };
    } catch (e) { return { ok: false, message: e.message }; }
  }

  /**
   * 单点**实况**（不是预报）。这是本 provider 在换用栅格源之后剩下的职责：
   * 数值预报格距 0.25° ≈ 28 km，格值是一片区域的平均；地球站站址要的是那一个点此刻的实测。
   * 两者并列显示才有意义 —— 差多少本身就是信息（模式偏差 / 地形 / 局地对流）。
   * @returns MetSnapshot 形状（与 packHourly 的逐时序列同口径），可直接喂 instantAtten
   */
  async function point(lat, lon) {
    const la = Math.max(-90, Math.min(90, Number(lat))), lo = Math.max(-180, Math.min(180, Number(lon)));
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return { ok: false, message: '坐标无效' };
    const mk = obsKey(la, lo), hit = obsMem.get(mk);
    if (hit && (Date.now() - hit.at) < OBS_TTL_MS) { bumpUsage(0, 1); return hit.row; }
    try {
      const j = await get(`/weather/v1/current/${la.toFixed(2)}/${lo.toFixed(2)}`);
      bumpUsage(1, 0);
      const row = {
        ok: true, lat: la, lon: lo, t: Date.now(), kind: 'obs', src: 'qweather',
        tC: val(j.temperature), tdC: val(j.dewPoint),
        rh: j.humidity, cloud: j.cloudCover,                    // 二者本就是 0~1 分数，不再除 100
        pMslHpa: val(j.pressure),
        rainMmH: val(j.precipitation && j.precipitation.intensity) || 0,
        precipType: (j.precipitation && j.precipitation.type) || 'none',
        windMs: val(j.wind && j.wind.speed),
        windDeg: (j.wind && j.wind.direction && j.wind.direction.degree) || 0,
        visM: val(j.visibility),
        text: j.condition && j.condition.text,
        attrib: (j.metadata && j.metadata.attributions) || []
      };
      obsMem.set(mk, { row, at: Date.now() });
      return row;
    } catch (e) { return { ok: false, message: e.message }; }
  }

  // ── 站点值随时间轴走 ─────────────────────────────────────────────────────
  // 和风按点源只有两样东西：**当前实况**（/current，观测）与**未来逐小时预报**（/hourly，最长 240 h）。
  // 没有历史接口，故时间轴退到「本小时之前」就只能如实留白，不拿"现在"的观测冒充过去那一刻。
  //
  // ★ 请求经济学是这一段的全部设计依据：计费按**请求数**，而逐小时接口一次回一整条时间轴。
  //   所以「拖时间轴」应当是免费的 —— 取一次就把整条轴买下来，之后逐帧取值只是查数组。
  //   allowFetch=false 即「只查已买到的，不许再发请求」，时间轴联动走的正是这一档。
  const OBS_TTL_MS = 10 * 60 * 1000;                 // 实况在内存里的保鲜期：拖时间轴来回切不该重买
  const obsMem = new Map();                          // qkey → { row, at }
  // ★ 序列另存一份在内存里，判据是「这条序列盖不盖得住要取的那一刻」，而不是磁盘缓存那条
  //   「条数 ≥ 这次要的档」的严口径。源真回少了小时数时严口径永远不命中，界面就会是
  //   「点一下有数 → 拖一帧没了 → 再点又有」的来回，而那明明是同一条已经买到手的序列。
  const serMem = new Map();                          // qkey → { ser, at }
  const obsKey = (lat, lon) => plan.qkey(lat, lon);         // qkey 自带两位小数量化
  const serCovers = (ser, t) => !!(ser && ser.n && t >= ser.time[0] - 1800000 && t <= ser.time[ser.n - 1] + 1800000);

  /**
   * 一个点在 tMs 那一刻的气象。
   * @param {boolean} allowFetch 允许发 HTTP（点按钮时为 true；时间轴联动为 false，只查缓存）
   */
  async function pointAt(lat, lon, tMs, allowFetch, horizonMs) {
    const la = Math.max(-90, Math.min(90, Number(lat))), lo = Math.max(-180, Math.min(180, Number(lon)));
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return { ok: false, message: '坐标无效' };
    const now = Date.now();
    const src = plan.pointSourceAt(tMs, now, horizonMs);
    const tgt = src.tgt;

    // 本小时（含刚过去的一小时）→ 观测。再往前就没有了。
    if (src.mode === 'past') return { ok: false, kind: 'past', t: tgt, message: '早于当前时刻，和风按点源无历史数据' };
    if (src.mode === 'obs') {
      const hit = obsMem.get(obsKey(la, lo));
      if (hit && (now - hit.at) < OBS_TTL_MS) { bumpUsage(0, 1); return { ...hit.row, tTarget: tgt }; }
      if (!allowFetch) return { ok: false, kind: 'need', t: tgt, message: '尚未获取该站数据' };
      const r = await point(la, lo);
      return r.ok ? { ...r, tTarget: tgt } : r;
    }
    // 未来 → 逐小时预报。取数窗按档取整，且一次买够整条时间轴（horizonMs 由调用方给）
    if (src.mode === 'far') {
      const cap = plan.HOUR_BUCKETS[plan.HOUR_BUCKETS.length - 1];
      return { ok: false, kind: 'far', t: tgt, message: `超出和风逐小时预报时效（最长 ${cap} 小时）` };
    }
    const want = src.want;
    const qla = plan.q(la), qlo = plan.q(lo);
    const mk2 = obsKey(la, lo);
    const memo = serMem.get(mk2);
    let ser = (memo && plan.isFresh(memo.at, now, CACHE_TTL_MS) && serCovers(memo.ser, tgt)) ? memo.ser : null;
    if (ser) bumpUsage(0, 1);
    else {
      ser = cacheGet(qla, qlo, want, now);
      if (!ser) {
        if (!allowFetch) return { ok: false, kind: 'need', t: tgt, message: '尚未获取该站数据' };
        const r = await fetchPoint(qla, qlo, want, now);
        flushTiles();
        ser = r.ser;
      } else bumpUsage(0, 1);
      serMem.set(mk2, { ser, at: now });
    }

    // 就近取帧，不插值：与栅格场同一条口径（降水在时间上不连续，插出来的是不存在的东西）
    let bi = -1, bd = Infinity;
    for (let i = 0; i < ser.n; i++) { const d = Math.abs(ser.time[i] - tgt); if (d < bd) { bd = d; bi = i; } }
    if (bi < 0 || bd > 3600000) return { ok: false, kind: 'far', t: tgt, message: '该时刻不在和风逐小时预报时段内' };
    return {
      ok: true, lat: la, lon: lo, t: ser.time[bi], tTarget: tgt, kind: 'fcst', src: 'qweather',
      tC: ser.tC[bi], tdC: ser.td[bi], rh: ser.rh[bi], cloud: ser.cloud[bi],
      pMslHpa: ser.pMsl[bi], rainMmH: ser.rain[bi] || 0,
      precipType: PTYPE[ser.ptype[bi]] || 'none',
      windMs: ser.wind[bi], windDeg: ser.wdir[bi],
      text: (ser.text && ser.text[bi]) || '',
      attrib: ser.attrib || []
    };
  }

  /** 取数预算（不联网）：告诉界面这一次要花多少请求 */
  function estimate(o) {
    const now = Date.now();
    const dims = plan.gridDims(o.bbox, o.step);
    if (!dims) return { error: '无效的取数范围' };
    let need = 0, cached = 0;
    for (let iy = 0; iy < dims.ny; iy++) {
      for (let ix = 0; ix < dims.nx; ix++) {
        const nd = plan.nodeAt(dims, ix, iy);
        if (cacheGet(nd.lat, nd.lon, o.hours || 72, now)) cached++; else need++;
      }
    }
    return { nx: dims.nx, ny: dims.ny, total: dims.n, need, cached,
      overWarn: need > plan.MAX_POINTS_WARN, overHard: need > plan.MAX_POINTS_HARD,
      hardLimit: plan.MAX_POINTS_HARD };
  }

  /**
   * 拉一片区域的时空立方体。
   * @param {object} o { bbox, step, hours, refine, fineStep, onProgress }
   * @returns 立方体的**元信息**（数据留在主进程，渲染端按帧取栅格，见 field()）
   */
  async function loadCube(o, onProgress) {
    const now = Date.now();
    const hours = Math.max(1, Math.min(240, Number(o.hours) || 72));
    const dims = plan.gridDims(o.bbox, o.step);
    if (!dims) return { error: '无效的取数范围' };

    const est = estimate({ bbox: o.bbox, step: o.step, hours });
    if (est.overHard) return { error: `本次需请求 ${est.need} 次，超过硬上限 ${plan.MAX_POINTS_HARD}。请缩小范围或放粗格距。` };

    // 主网格逐点取
    const nodes = [];
    for (let iy = 0; iy < dims.ny; iy++) for (let ix = 0; ix < dims.nx; ix++) nodes.push({ ...plan.nodeAt(dims, ix, iy), ix, iy });
    const { out, errs } = await pool(nodes, (nd) => fetchPoint(plan.q(nd.lat), plan.q(nd.lon), hours, now), onProgress);
    flushTiles();

    const good = out.filter(Boolean);
    if (!good.length) return { error: '全部取数失败：' + (errs[0] ? errs[0].msg : '未知') };

    // 时间轴以第一个成功点为准（同一次请求各点的 forecastTime 一致）
    const ref = good[0].ser;
    const nt = Math.min(hours, ref.n);
    const times = ref.time.slice(0, nt);

    const N = dims.nx * dims.ny, T = nt;
    const mk = () => new Float32Array(N * T);
    const V = { tC: mk(), pMsl: mk(), rh: mk(), td: mk(), rain: mk(), cloud: mk(), wind: mk(), wdir: mk(), ptype: mk() };
    for (let k = 0; k < N * T; k++) V.tC[k] = NaN;            // 缺格用 NaN，不用 0 顶替
    const KEYS = ['tC', 'pMsl', 'rh', 'td', 'rain', 'cloud', 'wind', 'wdir', 'ptype'];
    let filled = 0, attrib = [];
    for (let i = 0; i < nodes.length; i++) {
      const r = out[i]; if (!r) continue;
      const nd = nodes[i], s = r.ser;
      const cell = nd.iy * dims.nx + nd.ix;
      for (let t = 0; t < T; t++) {
        const b = t * N + cell;
        for (const k of KEYS) { const a = s[k]; V[k][b] = (a && Number.isFinite(a[t])) ? a[t] : (k === 'rain' || k === 'ptype' ? 0 : NaN); }
      }
      filled++;
      if (!attrib.length && s.attrib && s.attrib.length) attrib = s.attrib;
    }

    const hitCount = out.filter((r) => r && r.cached).length;
    cube = {
      id: 'cube-' + now, bbox: { ...dims }, step: dims.step, nx: dims.nx, ny: dims.ny,
      nt: T, times, vars: V, attrib,
      fetched: good.length - hitCount, cached: hitCount, failed: errs.length, filled,
      builtAt: now, hours
    };
    return meta();
  }

  function meta() {
    if (!cube) return null;
    return {
      id: cube.id,
      bbox: { latMin: cube.bbox.latMin, latMax: cube.bbox.latMax, lonMin: cube.bbox.lonMin, lonMax: cube.bbox.lonMax },
      step: cube.step, nx: cube.nx, ny: cube.ny, nt: cube.nt, times: cube.times,
      attrib: cube.attrib, fetched: cube.fetched, cached: cube.cached, failed: cube.failed,
      filled: cube.filled, builtAt: cube.builtAt, hours: cube.hours
    };
  }

  function getCube() { return cube; }
  function dropCube() { cube = null; }

  function clearCache() {
    tileCacheMem.clear(); dirtyTiles.clear(); obsMem.clear(); serMem.clear();
    let n = 0;
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        if (f === '_usage.json') continue;
        try { fs.unlinkSync(path.join(cacheDir, f)); n++; } catch { /* 被占用则跳过 */ }
      }
    } catch { /* 目录不存在 */ }
    return { ok: true, removed: n };
  }

  function getUsage() {
    const m = new Date().toISOString().slice(0, 7);
    if (usage.month !== m) usage = { month: m, count: 0, cacheHit: 0 };
    return { ...usage, freeQuota: 50000 };
  }

  /**
   * 一批站点在 tMs 那一刻的气象（气象指标表的「和风」列组走这条）。
   * ★ 这里**一站一次 HTTP**，与栅格源那条「一次一整块」正好相反 —— 和风只有按点查询。
   *   故必须走并发闸；allowFetch=false 时一次 HTTP 都不发，只在已买到的数据里查
   *   （时间轴联动走的就是这一档，拖多远都不花钱）。
   * 单站失败不中断整批：那一行带 message 回去，其余照出。
   */
  async function points(pts, opt) {
    const list = Array.isArray(pts) ? pts : [];
    const o = opt || {};
    const tgt = plan.pointSourceAt(Number(o.tMs), Date.now(), o.horizonMs).tgt;   // 与逐点判定同一口径
    if (!list.length) return { rows: [], t: tgt };
    const { out } = await pool(list, async (p) => {
      const r = await pointAt(p.lat, p.lon, o.tMs, o.allowFetch !== false, o.horizonMs);
      return { id: p.id, ...r };
    });
    return { rows: out.map((r, i) => r || { id: list[i].id, ok: false, message: '获取失败' }), t: tgt };
  }

  return { configured, test, point, pointAt, points, estimate, loadCube, meta, getCube, dropCube, clearCache, usage: getUsage, PTYPE };
};
