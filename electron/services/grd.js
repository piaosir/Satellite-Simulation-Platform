// GRD 取值服务（主进程）。链路预算第一期：把 GRD 解析+采样放主进程，渲染端只过 IPC 收发 dB 数字。
//   · 首次取某天线 → 读原始 .grd 文本、解析一次、落盘紧凑 .grdbin（与原 .grd 并存，多占盘换性能）。
//   · 之后只读 .grdbin（typed-array 视图，无解析）；按 file 做 LRU 内存缓存。
//   · 采样为 O(1) bicubic，一次请求批量处理所有站点（每站一个 dB）。
const fs = require('fs');
const path = require('path');
const sampler = require('../../packages/core/utils/grdSampler.js');
const ciCci = require('../../packages/core/utils/interference/ciCci.js');

// saveDir：用户导入 GRD 的持久化目录（与 coverageGrd 同源，userData/coverage-grd-imported）。
module.exports = function createGrd(saveDir) {
  saveDir = saveDir ? path.resolve(saveDir) : saveDir;   // 规范化（统一分隔符），使路径前缀校验稳健
  const CACHE_CAP = 4;                 // 最多常驻 4 个天线的二进制（每个约几十 MB；性能优先）
  const cache = new Map();             // binPath → { mtimeMs, loaded, buf }

  function resolveRaw(file) {
    if (!saveDir) throw new Error('未配置导入存储目录');
    const safe = String(file || '').replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
    const fp = path.join(saveDir, safe);
    if (!fp.startsWith(saveDir)) throw new Error('非法路径');
    return fp;
  }

  // 确保 .grdbin 存在且不旧于原文件，返回其路径（首次/原文件更新时解析一次）
  function ensureBin(rawPath) {
    const binPath = rawPath + '.grdbin';
    const rawStat = fs.statSync(rawPath);            // 原文件不存在 → 抛错（上层兜底 null）
    let binStat = null; try { binStat = fs.statSync(binPath); } catch { /* 尚未生成 */ }
    if (!binStat || binStat.mtimeMs < rawStat.mtimeMs) {
      const text = fs.readFileSync(rawPath, 'latin1');
      const buf = sampler.buildBin(text);
      const tmp = binPath + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, binPath);                   // 原子落盘，避免半成品
    }
    return binPath;
  }

  // 载入 .grdbin（LRU 缓存）。注意保留 buf 引用，使 typed-array 视图有效。
  function loadCached(binPath) {
    const st = fs.statSync(binPath);
    const hit = cache.get(binPath);
    if (hit && hit.mtimeMs === st.mtimeMs) { cache.delete(binPath); cache.set(binPath, hit); return hit.loaded; }
    const buf = fs.readFileSync(binPath);
    const loaded = sampler.loadBin(buf);
    cache.set(binPath, { mtimeMs: st.mtimeMs, loaded, buf });
    while (cache.size > CACHE_CAP) { const k = cache.keys().next().value; cache.delete(k); }
    return loaded;
  }

  // 主入口：req = { file, sat:{lon,lat,alt}, cfg, points:[{lon,lat}…] } → (number|null)[]（与 points 等长同序）
  function sample(req) {
    req = req || {};
    const points = Array.isArray(req.points) ? req.points : [];
    try {
      const rawPath = resolveRaw(req.file);
      const loaded = loadCached(ensureBin(rawPath));
      return points.map((p) => {
        try { return sampler.sampleMax(loaded, req.sat || {}, req.cfg || {}, Number(p.lon), Number(p.lat)); }
        catch { return null; }
      });
    } catch (e) {
      console.warn('[GRD] 采样失败', req.file, e && e.message);
      return points.map(() => null);
    }
  }

  // 逐波束采样：req = { file, sat, cfg, points } → { beamIdx:number[], values:(number|null)[][] }
  // values[i] 对应 points[i]，内层与 beamIdx 同序。
  // ⚠️ 消息体随「点数 × 波束数」二次增长——只适合几十个站点。整张场图请走 sampleCci。
  function sampleBeams(req) {
    req = req || {};
    const points = Array.isArray(req.points) ? req.points : [];
    try {
      const loaded = loadCached(ensureBin(resolveRaw(req.file)));
      const ctx = sampler.makeSampleCtx(loaded, req.sat || {}, req.cfg || {});
      if (!ctx) return { beamIdx: [], values: points.map(() => []) };
      return {
        beamIdx: ctx.beamIdx.slice(),
        values: points.map((p) => {
          try { return sampler.sampleAllCtx(ctx, Number(p.lon), Number(p.lat)); }
          catch { return []; }
        })
      };
    } catch (e) {
      console.warn('[GRD] 逐波束采样失败', req.file, e && e.message);
      return { beamIdx: [], values: points.map(() => []) };
    }
  }

  // 逐点 XPD：共极化分量由波束峰值判定（不按 icomp 硬判），取服务波束的共/交比。
  // req = { file, sat, cfg, points } → { ok, values:[{xpdDb, servingIdx, coPolIndex, coPolDb, xPolDb}|null] }
  function sampleXpd(req) {
    req = req || {};
    const points = Array.isArray(req.points) ? req.points : [];
    try {
      const loaded = loadCached(ensureBin(resolveRaw(req.file)));
      const ctx = sampler.makeSampleCtx(loaded, req.sat || {}, req.cfg || {});
      if (!ctx) return { ok: false, error: '天线几何无效', values: points.map(() => null) };
      return {
        ok: true,
        icomp: loaded.icomp,
        values: points.map((p) => {
          try { return sampler.sampleXpdCtx(ctx, Number(p.lon), Number(p.lat)); }
          catch { return null; }
        })
      };
    } catch (e) {
      console.warn('[GRD] XPD 采样失败', req.file, e && e.message);
      return { ok: false, error: e && e.message, values: points.map(() => null) };
    }
  }

  // C/CCI 同频复用干扰：逐点算完当场折成一个数再回传。
  //
  // 为什么必须在主进程合成：一张 C/CCI 场图是几千格 × 几十波束。若把逐波束值搬过 IPC
  // （5000 格 × 40 波束 = 20 万个数）再在渲染端合成，消息体与序列化开销都是白付的——
  // 合成只需要一个标量结果。故 ciCci 的求和放这里，IPC 只回长度 = 点数的数组。
  //
  // req = { file, sat, cfg, points, colors, coloring, servingIdx, floorDb }
  function sampleCci(req) {
    req = req || {};
    const points = Array.isArray(req.points) ? req.points : [];
    try {
      const loaded = loadCached(ensureBin(resolveRaw(req.file)));
      const r = ciCci.cciOverPoints(sampler, loaded, req.sat || {}, req.cfg || {}, points, {
        colors: req.colors, coloring: req.coloring, servingIdx: req.servingIdx, floorDb: req.floorDb
      });
      return { ok: true, ...r };
    } catch (e) {
      console.warn('[GRD] C/CCI 采样失败', req.file, e && e.message);
      return { ok: false, error: e && e.message, cci: points.map(() => null), serving: points.map(() => null), coloring: {}, colors: req.colors || 4 };
    }
  }

  /**
   * NGSO 时变干扰用的「准备一次、逐次取值」采样器。
   *
   * 与 sample() 的差别在于**卫星在动**：每个时刻的天线基底都不一样（星位变、boresight 也变），
   * 所以不能像 C/CCI 场图那样把 ctx 建一次；但 .grdbin 的载入与解析可以只做一次——
   * sample() 每次调用都要 statSync + LRU 查表，放进逐时刻逐星的热路径里就太贵了。
   *
   * ─── 多波束 GRD 的口径 ─────────────────────────────────────────────────────
   * 一份 GRD 常含多个 set（多波束）。干扰算的是「与受扰载波**同频**的那一个波束」，
   * 而不是整副天线：不同波束照的是不同小区，把它们混在一起取最大，等于假设任一波束
   * 都可能同频满功率照到本站。实测（两波束、峰值差 3 dB、相隔约 11°）：同一地面点上
   * 「全部波束取最大」与「只算第 2 波束」的相对滚降差 17.5 dB。
   *
   * 故 beamIndex 显式区分两种口径：
   *   number  只用该波束（原始 GRD set 序号，0 基），峰值也按该波束归一 —— 严谨口径
   *   null    全部波束取最大，峰值取全局最大 —— 上界包络，由上层如实告警
   *
   * 返回的对象直接喂给 interference/patternsSat.js 的 mode:'grd'。
   */
  function ngsoSampler(file, cfg, beamIndex) {
    const loaded = loadCached(ensureBin(resolveRaw(file)));
    const base = cfg || {};
    const beamCount = (loaded.beams || []).length;
    const pick = Number.isInteger(beamIndex) ? beamIndex : null;
    if (pick != null && (pick < 0 || pick >= beamCount)) {
      throw new Error(`方向图只有 ${beamCount} 个波束，指定的波束序号 ${pick + 1} 越界`);
    }
    // 指定了波束就覆盖 keptSets（它本就是「原始 set 序号」的口径，见 grdSampler.makeSampleCtx）
    const c = pick == null ? base : { ...base, keptSets: [pick] };
    const peak = sampler.peakDb(loaded, c);
    if (!Number.isFinite(peak)) throw new Error('方向图里取不到峰值（文件可能是空的或全为零场）');
    return {
      peakDbi: peak,
      beamCount,
      beamPick: pick,
      // boresight 由指向模型给（星下点 / 小区中心 / 本站），故一律走 geo 型基底
      sampleDbi(satLon, satLat, altKm, boreLon, boreLat, lon, lat) {
        try {
          return sampler.sampleMax(loaded, { lon: satLon, lat: satLat, alt: altKm },
            { ...c, boreType: 'geo', boreLon, boreLat }, lon, lat);
        } catch (e) { return null; }
      }
    };
  }

  // 预编译（可选预热）：仅确保 .grdbin 生成，不采样。
  function precompile(file) {
    try { ensureBin(resolveRaw(file)); return { ok: true }; }
    catch (e) { return { ok: false, error: e && e.message }; }
  }

  // 天线概要：波束数（GRD 的 set 数）与网格类型。链路预算导入天线时用来填「N 波束」，
  // 顺带把 .grdbin 预编译出来（首次采样就不用等解析）。渲染端不必读原始文本。
  function meta(file) {
    try {
      const loaded = loadCached(ensureBin(resolveRaw(file)));
      const b0 = loaded.beams && loaded.beams[0];
      return {
        ok: true, beams: (loaded.beams || []).length,
        igrid: loaded.igrid, icomp: loaded.icomp, ncomp: loaded.ncomp,
        grid: b0 ? b0.grid : null
      };
    } catch (e) { return { ok: false, error: e && e.message }; }
  }

  return { sample, sampleBeams, sampleXpd, sampleCci, precompile, meta, ngsoSampler };
};
