// gfs.js — NCEP GFS 栅格 provider（主进程）
//
// 与 weather.js（和风，按点查询）是**并列的两个 provider**，不是替代关系：
//   gfs.js      栅格源 —— 一次 HTTP 拿一整块 0.25° 网格。做「场」用（云图、雨衰场）。
//   weather.js  点源   —— 一次 HTTP 拿一个点的逐小时序列。做「站点实况」用。
// 出参的立方体结构逐字段相同，故 liveField.js 无论拿到哪一份都一行不用改。
//
// ── 请求模型与和风**正好相反**，界面必须让人感觉到这个区别 ──────────────────
//   和风：请求数 = 格点数。换范围 / 换格距花钱，换时长 / 换字段免费。
//   GFS ：请求数 = 帧数。  换范围 / 换格距 / 换字段全免费，只有拉长时间轴才多花请求。
//   实测：东亚全境 15~55°N 70~140°E（281×161 = 45241 格）一次请求 821 KB / 2.1 s。
//         同一件事和风要 45241 次 HTTP —— 这就是「做不出云图」与「做得出」的分界。
//
// ── 授权 ──────────────────────────────────────────────────────────────────
// GFS 是美国政府作品，属公共领域（17 U.S.C. §105），无版权、可商用、无需密钥。
// 这对本平台（按 license 售卖）是硬指标：和风那条线要按量计费，栅格这条线不要。
// 仍在界面标注来源 —— 那是学术惯例与可追溯性，不是许可要求。
//
// ── 诚实边界 ──────────────────────────────────────────────────────────────
//   · GFS 是**数值预报**，不是观测。f000 是分析场（最接近实况），其后逐小时都是预报。
//     界面显示的「起报时次」不是装饰：同一个钟点，00z 起报的 f012 与 12z 起报的 f000 是两回事。
//   · 0.25° ≈ 28 km，而对流雨胞尺度 1~10 km，故成图峰值必然**低于**真实峰值。
//     偏差方向是确定的（偏低），instantAtten.js 的文件头已写明，UI 照实说。
//   · NOMADS 未公布硬限流阈值，其使用规约建议不超过 ~120 次/分。故本模块自带发令间隔闸
//     （REQ_SPACING_MS），宁可慢一点也不去撞人家的封禁线。
//
// ★ 缓存存的是**原始 GRIB2 字节**而不是解码后的数组：一帧几十~几百 KB，解码只要几毫秒，
//   存字节既省磁盘又让「换范围重取」时能命中同一份文件。

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const grib2 = require('../../packages/core/utils/grib2.js');

const HOST = 'nomads.ncep.noaa.gov';
const TIMEOUT_MS = 60000;
const CONCURRENCY = 3;
const REQ_SPACING_MS = 600;          // 发令间隔：≤100 次/分，留足余量不去撞 NOMADS 的限流线
const CYCLE_TTL_MS = 10 * 60 * 1000; // 起报时次探测结果的复用时长
// 立方体内存硬上限。★ 这不是保守估计而是**拒绝线**：超过就不去让人等到 OOM。
// 2.5 GB 的依据：TypedArray 走的是外部 ArrayBuffer 不占 V8 堆上限，真正的约束是物理内存；
// 主进程还要留出 GRIB 解码的临时缓冲（一帧约 1~40 MB）与其余业务的余量。
const MAX_BYTES = 2560 * 1024 * 1024;
// 磁盘缓存：★ 存的是原始 GRIB2 字节，删了就要重下，而重下要走 NOMADS 的限流闸（600 ms/次）。
// 故缓存策略取「大胆」一侧 —— 保留最近若干个起报时次，按总容量 LRU 淘汰，而不是一换时次就清空。
// 好处：回看昨天那场雨、对比 00Z 与 12Z 两份预报，都不用重下。
const CACHE_KEEP_CYCLES = 8;               // 最近 8 个时次 = 48 h
const CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024;  // 8 GB 总量上限，超了按时次由旧到新删

// 三个数据集。**格距不是「取回来再抽稀」，是三个不同的产品** —— 这件事直接决定全球云图跑不跑得动：
// 全球一帧全要素，0.25° 约 38 MB，1° 只要 2.3 MB。抽稀省不了带宽，换数据集才省。
// 代价是逐小时只有 0.25° 有（f000~f120）；0.5°/1° 一律逐 3 小时，实测已确认 f001/f002 不存在。
const DATASETS = {
  '0p25': { key: '0p25', res: 0.25, script: 'filter_gfs_0p25_1hr.pl', file: 'pgrb2.0p25', stepMin: 1, hourlyMax: 120, label: '0.25°（逐小时）' },
  '0p50': { key: '0p50', res: 0.5, script: 'filter_gfs_0p50.pl', file: 'pgrb2full.0p50', stepMin: 3, hourlyMax: 0, label: '0.5°（逐 3 小时）' },
  '1p00': { key: '1p00', res: 1.0, script: 'filter_gfs_1p00.pl', file: 'pgrb2.1p00', stepMin: 3, hourlyMax: 0, label: '1°（逐 3 小时）' }
};
const MAX_FH = 384;                  // 全部数据集都出到 f384（16 天）
const dsOf = (res) => (Number(res) >= 1 ? DATASETS['1p00'] : Number(res) >= 0.5 ? DATASETS['0p50'] : DATASETS['0p25']);

// 取哪些要素 / 哪些层。二者是**叉乘**关系（NOMADS 的 filter 就这么工作），
// 故会顺带回来一些用不上的报文（TMP:surface、RH:整层…）—— 用 surfType 严格挑，别按名字猜。
const VARS = ['TMP', 'DPT', 'RH', 'PRATE', 'PRMSL', 'TCDC', 'CWAT', 'UGRD', 'VGRD', 'CRAIN', 'CSNOW', 'CICEP', 'CFRZR'];
const LEVS = ['surface', '2_m_above_ground', '10_m_above_ground', 'mean_sea_level',
  'entire_atmosphere', 'entire_atmosphere_%5C%28considered_as_a_single_layer%5C%29'];

// GRIB2 参数号 → 本平台的量。键是 "cat.param/surfType"。
//   ★ surfType 必须进键：TMP 同时以 s1（地表）与 s103（2 m）返回，RH 同时以 s103 与 s200（整层）返回，
//     只按 cat.param 挑会随报文顺序随机拿到其中一个 —— 这种错做出来的图完全「看着正常」。
const PICK = {
  '0.0/103': { v: 'tC', f: (x) => x - 273.15 },        // 2 m 气温 K → °C
  '0.6/103': { v: 'td', f: (x) => x - 273.15 },        // 2 m 露点 K → °C
  '1.1/103': { v: 'rh', f: (x) => x / 100 },           // 2 m 相对湿度 % → 0~1（metSnapshot 要分数）
  '3.1/101': { v: 'pMsl', f: (x) => x / 100 },         // 海平面气压 Pa → hPa
  '1.7/1': { v: 'rain', f: (x) => x * 3600 },          // 降水率 kg/m²/s → mm/h
  '6.1/10': { v: 'cloud', f: (x) => x / 100 },         // 总云量 % → 0~1
  '6.1/200': { v: 'cloud', f: (x) => x / 100 },        // 同上（层码两种写法都见过）
  '6.6/200': { v: 'cwat', f: (x) => x },               // 柱云水 kg/m² —— 这一项让云衰从统计值升级成实测值
  '2.2/103': { v: '_u', f: (x) => x },                 // 10 m 风 U
  '2.3/103': { v: '_v', f: (x) => x },                 // 10 m 风 V
  '1.192/1': { v: '_crain', f: (x) => x },             // 降水相态四个 0/1 标志（NCEP 本地参数号）
  '1.193/1': { v: '_cfrzr', f: (x) => x },
  '1.194/1': { v: '_cicep', f: (x) => x },
  '1.195/1': { v: '_csnow', f: (x) => x }
};
// liveField.PTYPE = ['none','rain','snow','ice','mixed','unknown']
const PT_NONE = 0, PT_RAIN = 1, PT_SNOW = 2, PT_ICE = 3, PT_MIXED = 4;

const ATTRIB = [{ name: 'NOAA / NCEP GFS · NOMADS', url: 'https://nomads.ncep.noaa.gov/' }];

const pad3 = (n) => String(n).padStart(3, '0');
const pad2 = (n) => String(n).padStart(2, '0');
const ymdOf = (ms) => { const d = new Date(ms); return '' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()); };

module.exports = function createGfs(userDataDir) {
  const cacheDir = path.join(userDataDir || path.join(require('os').tmpdir(), 'satsim'), 'gfs-cache');
  let cube = null;
  let cycleProbe = { at: 0, cycle: null };
  let lastSend = 0;

  // ---- 发令间隔闸：串行化「请求起跑线」，并发数仍是 CONCURRENCY ----
  function slot() {
    const now = Date.now();
    const wait = Math.max(0, lastSend + REQ_SPACING_MS - now);
    lastSend = now + wait;
    return wait ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
  }

  function httpGet(reqPath) {
    return new Promise((resolve, reject) => {
      const r = https.request({ host: HOST, method: 'GET', path: reqPath, timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'satsim-platform' } }, (rs) => {
        const chunks = [];
        rs.on('data', (c) => chunks.push(c));
        rs.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (rs.statusCode !== 200) return reject(new Error('HTTP ' + rs.statusCode));
          // NOMADS 出错时回的是 200 + 一段 HTML，不是 4xx —— 只认 GRIB 魔数
          if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'GRIB') {
            const t = buf.toString('utf8', 0, 400).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            return reject(new Error(t.slice(0, 120) || '返回内容不是 GRIB2'));
          }
          resolve(buf);
        });
      });
      r.on('timeout', () => { r.destroy(); reject(new Error('请求超时 ' + (TIMEOUT_MS / 1000) + ' s')); });
      r.on('error', (e) => reject(new Error(e.message)));
      r.end();
    });
  }

  /** 一帧的子集请求路径。box = {latMin,latMax,lonMin,lonMax}，vars 缺省为全套 */
  function framePath(cycleMs, fh, box, vars, ds) {
    const D = ds || DATASETS['0p25'];
    const ymd = ymdOf(cycleMs), cyc = pad2(new Date(cycleMs).getUTCHours());
    const V = (vars || VARS).map((v) => '&var_' + v + '=on').join('');
    const L = LEVS.map((l) => '&lev_' + l + '=on').join('');
    return '/cgi-bin/' + D.script + '?dir=%2Fgfs.' + ymd + '%2F' + cyc + '%2Fatmos'
      + '&file=gfs.t' + cyc + 'z.' + D.file + '.f' + pad3(fh) + V + L
      + '&subregion=&toplat=' + box.latMax + '&leftlon=' + box.lonMin
      + '&rightlon=' + box.lonMax + '&bottomlat=' + box.latMin;
  }

  // ---- 起报时次探测 ----
  // GFS 每 6 h 一次（00/06/12/18Z），发布滞后约 3.5~5 h。故不能按钟点硬算，必须探。
  // 从「现在往前推 3 h」所在的时次起，逐个往回退最多 5 档（30 h）——再退就说明源站真的挂了。
  async function latestCycle(force, ds) {
    const now = Date.now();
    if (!force && cycleProbe.cycle && now - cycleProbe.at < CYCLE_TTL_MS) return cycleProbe.cycle;
    const base = Math.floor((now - 3 * 3600e3) / (6 * 3600e3)) * 6 * 3600e3;
    const tiny = { latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 };
    const errs = [];
    for (let k = 0; k < 5; k++) {
      const c = base - k * 6 * 3600e3;
      try {
        await slot();
        await httpGet(framePath(c, 0, tiny, ['PRATE'], ds));
        cycleProbe = { at: now, cycle: c };
        return c;
      } catch (e) { errs.push(pad2(new Date(c).getUTCHours()) + 'z:' + e.message); }
    }
    throw new Error('未找到可用的 GFS 起报时次（' + errs.slice(0, 2).join('；') + '）');
  }

  // ---- 缓存（原始 GRIB2 字节，按起报时次分目录）----
  const boxKey = (b) => [b.latMin, b.latMax, b.lonMin, b.lonMax].map((v) => Number(v).toFixed(2)).join('_');
  const cycDir = (c) => path.join(cacheDir, ymdOf(c) + pad2(new Date(c).getUTCHours()) + 'z');
  const frameFile = (c, fh, box, ds) => path.join(cycDir(c), ds.key + '_f' + pad3(fh) + '_' + boxKey(box) + '.grb2');

  function cacheRead(c, fh, box, ds) {
    try { const b = fs.readFileSync(frameFile(c, fh, box, ds)); return b.length > 16 ? b : null; } catch { return null; }
  }
  function cacheWrite(c, fh, box, ds, buf) {
    try {
      fs.mkdirSync(cycDir(c), { recursive: true });
      const f = frameFile(c, fh, box, ds), tmp = f + '.tmp';
      fs.writeFileSync(tmp, buf); fs.renameSync(tmp, f);
    } catch { /* 磁盘满/只读：不影响本次出图，下次重取即可 */ }
  }
  /** 缓存目录的现状：逐时次的帧数与占用（目录名是 YYYYMMDDHHz，天然按时间可排序） */
  function cacheScan() {
    const out = [];
    try {
      for (const d of fs.readdirSync(cacheDir)) {
        const p = path.join(cacheDir, d);
        try {
          if (!fs.statSync(p).isDirectory() || !/^\d{10}z$/.test(d)) continue;
          let bytes = 0, files = 0;
          for (const f of fs.readdirSync(p)) { try { bytes += fs.statSync(path.join(p, f)).size; files++; } catch { /* 单个读不到就不计 */ } }
          out.push({ dir: d, path: p, bytes, files });
        } catch { /* 该项读不动，跳过 */ }
      }
    } catch { /* 目录还不存在 */ }
    return out.sort((a, b) => (a.dir < b.dir ? 1 : -1));   // 新→旧
  }

  /**
   * 缓存修剪。★ 与「一换时次就清空」不同：这里**保留最近若干个起报时次**，
   * 只有超出条数或总容量才由旧到新删。理由是删了就要重下，而重下要过 600 ms/次的限流闸 ——
   * 磁盘比等待便宜得多，且用户随时可以手动清。
   */
  function prune(keepDir) {
    const list = cacheScan();
    let total = list.reduce((a, x) => a + x.bytes, 0);
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {           // 从最旧的一端开始
      const x = list[i];
      if (keepDir && x.dir === keepDir) continue;          // 本次正在用的那一份永远留着
      const overCount = (list.length - n) > CACHE_KEEP_CYCLES;
      const overBytes = total > CACHE_MAX_BYTES;
      if (!overCount && !overBytes) break;
      try { fs.rmSync(x.path, { recursive: true, force: true }); total -= x.bytes; n++; } catch { /* 被占用则下次再清 */ }
    }
    return n;
  }

  // ---- 并发池（带发令间隔）----
  async function pool(items, worker, onProgress) {
    const out = new Array(items.length);
    const errs = [];
    let idx = 0, done = 0;
    async function run() {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        try { out[i] = await worker(items[i], i); }
        catch (e) { out[i] = null; errs.push({ i, msg: e.message }); }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
    return { out, errs };
  }

  // ---- 一帧的 GRIB2 → 按量归位 ----
  // 返回 { grid, get(v) }，其中 grid 是网格几何（首帧定基准，其余帧必须与它一致）
  function parseFrame(buf) {
    const bad = [];
    const msgs = grib2.decodeAll(buf, (e) => bad.push(e.message));
    if (!msgs.length) throw new Error('该帧无可解析报文' + (bad[0] ? '（' + bad[0] + '）' : ''));
    const byVar = new Map();
    let grid = null;
    for (const m of msgs) {
      const p = PICK[m.cat + '.' + m.param + '/' + m.surfType];
      if (!p) continue;
      // 同一量可能既有瞬时（模板 4.0）又有时段统计（4.8）。瞬时衰减要的是瞬时值，
      // 故 4.0 优先；只有 4.0 缺席（极少数时次）才退而用 4.8。
      const prev = byVar.get(p.v);
      if (prev && prev.tmpl === 0 && m.prodTmpl !== 0) continue;
      if (!grid) grid = { ni: m.ni, nj: m.nj, lat1: m.lat1, lat2: m.lat2, lon1: m.lon1, lon2: m.lon2, di: m.di, dj: m.dj };
      byVar.set(p.v, { tmpl: m.prodTmpl, values: m.values, f: p.f });
    }
    if (!grid) throw new Error('该帧不含所需要素');
    return { grid, byVar };
  }

  const sameGrid = (a, b) => a.ni === b.ni && a.nj === b.nj
    && Math.abs(a.lat1 - b.lat1) < 1e-6 && Math.abs(a.lon1 - b.lon1) < 1e-6;

  // ---- 对外 ----

  function configured() { return { ok: true, host: HOST, note: '公有领域数据，无需凭据' }; }

  async function test() {
    try {
      const c = await latestCycle(true, DATASETS['0p25']);
      await slot();
      const buf = await httpGet(framePath(c, 0, { latMin: 39, latMax: 41, lonMin: 116, lonMax: 118 }, ['TMP'], DATASETS['0p25']));
      const { byVar } = parseFrame(buf);
      const t = byVar.get('tC');
      if (!t) return { ok: false, message: '连接成功，但未解析出 2 m 气温' };
      const d = new Date(c);
      let s = 0, n = 0;
      for (const v of t.values) { s += t.f(v); n++; }
      return { ok: true, cycle: c, temp: +(s / n).toFixed(1),
        text: '起报 ' + ymdOf(c) + ' ' + pad2(d.getUTCHours()) + 'Z' };
    } catch (e) { return { ok: false, message: e.message }; }
  }

  /** 规整取数范围：夹到合法域、对齐数据集网格、拒绝跨 ±180° */
  function normBox(bbox, res) {
    const b = bbox || {};
    const r = (res || 0.25);
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
    const g = (v) => Math.round(v / r) * r;                    // 对齐网格，免得子集边界半格错位
    const latMin = g(cl(b.latMin, -90, 90)), latMax = g(cl(b.latMax, -90, 90));
    const lonMin = g(cl(b.lonMin, -180, 180)), lonMax = g(cl(b.lonMax, -180, 180));
    if (!(latMax > latMin) || !(lonMax > lonMin)) return null; // 跨 ±180° 的窗口落在这里，如实拒绝
    return { latMin: +latMin.toFixed(4), latMax: +latMax.toFixed(4), lonMin: +lonMin.toFixed(4), lonMax: +lonMax.toFixed(4) };
  }

  /**
   * 取数预算（不联网）。★ 这里给的是**帧数、内存、下载量与等待时间**，不是「请求配额」——
   * GFS 无配额可言。界面上的读数必须是这几样，摆一个「本月已用 N/50000」在这儿是错的。
   */
  function estimate(o) {
    o = o || {};
    const ds = dsOf(o.res);
    const box = normBox(o.bbox, ds.res);
    if (!box) return { error: '取数范围无效（不支持跨 ±180° 的窗口）' };
    // 帧间隔必须是该数据集的整数倍：0.5°/1° 只有逐 3 小时的产品，填 1 会一半的帧 404
    let stepH = Math.max(ds.stepMin, Math.min(24, Math.round(Number(o.stepH) || 3)));
    stepH = Math.max(ds.stepMin, Math.round(stepH / ds.stepMin) * ds.stepMin);
    let hours = Math.max(stepH, Math.min(MAX_FH, Math.round(Number(o.hours) || 72)));
    // 0.25° 只有 f000~f120 是逐小时；再往后一律逐 3 小时，故 stepH<3 时把时段截到 120 h
    const hourlyCap = (stepH < 3 && ds.hourlyMax) ? ds.hourlyMax : MAX_FH;
    const clipped = hours > hourlyCap;
    hours = Math.min(hours, hourlyCap);

    const nx = Math.round((box.lonMax - box.lonMin) / ds.res) + 1;
    const ny = Math.round((box.latMax - box.latMin) / ds.res) + 1;
    const nt = Math.floor(hours / stepH) + 1;
    const bytes = nx * ny * nt * (8 * 4 + 2 + 1);               // 8 个 Float32 + wdir(Uint16) + ptype(Uint8)
    // 下载量：实测每格每要素约 1.6 字节（9~16 位打包 + 头），13 个要素叉乘层后约 20 条报文
    const dlBytes = Math.round(nx * ny * 20 * 1.6 * nt);
    let cached = 0;
    if (cycleProbe.cycle) {                                     // 命中要真的探盘：时次未知时按 0 报，别编
      for (let i = 0; i < nt; i++) if (cacheRead(cycleProbe.cycle, i * stepH, box, ds)) cached++;
    }
    const need = nt - cached;
    return {
      bbox: box, res: ds.res, dsLabel: ds.label, step: ds.res, nx, ny, nt, stepH, hours,
      need, cached, bytes, dlBytes, clipped, hourlyCap,
      overHard: bytes > MAX_BYTES, hardBytes: MAX_BYTES,
      // 单帧耗时 ≈ max(发令间隔, 下载时间)；并发 3 摊薄，但发令间隔是串行闸，摊不掉
      etaSec: Math.max(Math.round(need * REQ_SPACING_MS / 1000),
        Math.round(need * (dlBytes / Math.max(1, nt)) / (2.5 * 1024 * 1024) / CONCURRENCY))
    };
  }

  /**
   * 拉一片区域的时空立方体。
   * @param {object} o { bbox, hours, stepH, res }
   * @returns 立方体**元信息**（数据留在主进程，渲染端按帧取栅格）
   */
  async function loadCube(o, onProgress) {
    const est = estimate(o || {});
    if (est.error) return { error: est.error };
    if (est.overHard) {
      return { error: `本次数据体约 ${(est.bytes / 1048576).toFixed(0)} MB，超过上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB。`
        + '请缩小范围、放粗格距或拉长帧间隔。' };
    }
    const ds = dsOf(est.res);
    const box = est.bbox, stepH = est.stepH;

    let cycle;
    try { cycle = await latestCycle(false, ds); }
    catch (e) { return { error: e.message }; }

    const fhs = [];
    for (let i = 0; i < est.nt; i++) fhs.push(i * stepH);
    if (onProgress) onProgress(0, fhs.length);

    let hit = 0;
    const { out, errs } = await pool(fhs, async (fh) => {
      let buf = cacheRead(cycle, fh, box, ds);
      if (buf) hit++;
      else {
        await slot();
        buf = await httpGet(framePath(cycle, fh, box, null, ds));
        cacheWrite(cycle, fh, box, ds, buf);
      }
      return { fh, ...parseFrame(buf) };
    }, onProgress);

    const good = out.filter(Boolean);
    if (!good.length) return { error: '数据获取失败：' + (errs[0] ? errs[0].msg : '未知') };

    // 网格基准取首帧；后续帧几何不符的直接丢（同一子集请求不该发生，但丢掉比错位安全）
    const g0 = good[0].grid;
    const frames = good.filter((f) => sameGrid(g0, f.grid));
    frames.sort((a, b) => a.fh - b.fh);                        // 并发回来的顺序不保证，时间轴必须单调
    const nx = g0.ni, ny = g0.nj, nt = frames.length;
    const N = nx * ny;

    const mk = () => new Float32Array(N * nt);
    // ★ ptype 与 wdir 不用 Float32：前者是 0~5 的分类码，后者是 0~359 的整度，
    //   降到 Uint8 / Uint16 把每格从 40 B 压到 35 B（省 12.5%），且**一位信息都不损失**
    //   （分类码本就是整数；风向的 1° 分辨率远细于 0.25° 格上的风场本身）。
    //   TypedArray 对下游是透明的：bilinear / nearest 都只是 arr[i]。
    const V = { tC: mk(), pMsl: mk(), rh: mk(), td: mk(), rain: mk(), cloud: mk(), wind: mk(), cwat: mk(),
      wdir: new Uint16Array(N * nt), ptype: new Uint8Array(N * nt) };
    // 缺格一律 NaN，不用 0 顶替 —— 图上留白比画一片假的无雨区诚实
    for (const k of ['tC', 'pMsl', 'rh', 'td', 'cloud', 'wind', 'cwat']) V[k].fill(NaN);

    const times = new Array(nt);
    for (let t = 0; t < nt; t++) {
      const fr = frames[t];
      times[t] = cycle + fr.fh * 3600e3;
      const base = t * N;
      const u10 = fr.byVar.get('_u'), v10 = fr.byVar.get('_v');
      const cr = fr.byVar.get('_crain'), cs = fr.byVar.get('_csnow'),
        ci = fr.byVar.get('_cicep'), cf = fr.byVar.get('_cfrzr');
      // ★ 行序翻转：GRIB 出口第 0 行是**北**，而本平台立方体的约定是第 0 行 = latMin（南），
      //   见 liveField.sampleField 的 fy = (lat − latMin)/step。不翻则整张图上下颠倒。
      for (let jy = 0; jy < ny; jy++) {
        const srcJ = ny - 1 - jy;
        for (let ix = 0; ix < nx; ix++) {
          const src = srcJ * nx + ix;
          const dst = base + jy * nx + ix;
          for (const key of ['tC', 'td', 'rh', 'pMsl', 'rain', 'cloud', 'cwat']) {
            const m = fr.byVar.get(key);
            if (m) V[key][dst] = m.f(m.values[src]);
          }
          if (u10 && v10) {
            const uu = u10.values[src], vv = v10.values[src];
            V.wind[dst] = Math.sqrt(uu * uu + vv * vv);
            V.wdir[dst] = (Math.atan2(-uu, -vv) * 180 / Math.PI + 360) % 360;   // 气象风向 = 风的来向
          }
          // 相态：四个标志同时为 1 的格记作「混合」，全 0 记作「无降水」。
          // ★ 这一项直接决定 P.838 用不用得上（雪/冰不适用），必须逐格判，不能按气温猜。
          const nS = cs ? cs.values[src] : 0, nI = ci ? ci.values[src] : 0,
            nF = cf ? cf.values[src] : 0, nR = cr ? cr.values[src] : 0;
          const cnt = (nR > 0.5 ? 1 : 0) + (nS > 0.5 ? 1 : 0) + (nI > 0.5 ? 1 : 0) + (nF > 0.5 ? 1 : 0);
          V.ptype[dst] = cnt === 0 ? PT_NONE : cnt > 1 ? PT_MIXED
            : nR > 0.5 ? PT_RAIN : nS > 0.5 ? PT_SNOW : PT_ICE;    // 冻雨归到 ice：P.838 同样不适用
          if (!(V.rain[dst] >= 0)) V.rain[dst] = 0;
        }
      }
    }

    prune(path.basename(cycDir(cycle)));
    const step = ds.res;
    cube = {
      id: 'gfs-' + cycle + '-' + Date.now(),
      src: 'gfs', model: 'NCEP GFS ' + (ds.res === 1 ? '1°' : ds.res + '°'), cycle, ds: ds.key,
      bbox: { latMin: g0.lat2, latMax: g0.lat2 + (ny - 1) * step, lonMin: g0.lon1, lonMax: g0.lon1 + (nx - 1) * step },
      step, nx, ny, nt, times, vars: V, attrib: ATTRIB,
      fetched: frames.length - hit, cached: hit, failed: errs.length + (good.length - frames.length),
      failMsg: errs.length ? errs[0].msg : '',
      filled: N, builtAt: Date.now(), hours: est.hours, stepH, bytes: N * nt * (8 * 4 + 2 + 1)
    };
    return meta();
  }

  function meta() {
    if (!cube) return null;
    const { vars, ...rest } = cube;                              // vars 是几十 MB，绝不过 IPC
    return rest;
  }
  function getCube() { return cube; }
  function dropCube() { cube = null; }

  function clearCache() {
    dropCube();
    cycleProbe = { at: 0, cycle: null };
    let n = 0;
    try {
      for (const d of fs.readdirSync(cacheDir)) {
        const p = path.join(cacheDir, d);
        try {
          if (fs.statSync(p).isDirectory()) { n += fs.readdirSync(p).length; fs.rmSync(p, { recursive: true, force: true }); }
          else { fs.unlinkSync(p); n++; }
        } catch { /* 被占用则跳过 */ }
      }
    } catch { /* 目录不存在 */ }
    return { ok: true, removed: n };
  }

  function usage() {
    const list = cacheScan();
    return {
      files: list.reduce((a, x) => a + x.files, 0),
      bytes: list.reduce((a, x) => a + x.bytes, 0),
      cycles: list.length, keepCycles: CACHE_KEEP_CYCLES, maxBytes: CACHE_MAX_BYTES,
      newest: list[0] ? list[0].dir : '', free: true
    };
  }

  return { configured, test, estimate, loadCube, meta, getCube, dropCube, clearCache, usage, latestCycle, normBox, ATTRIB };
};
