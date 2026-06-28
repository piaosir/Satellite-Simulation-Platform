// GRD 取值服务（主进程）。链路预算第一期：把 GRD 解析+采样放主进程，渲染端只过 IPC 收发 dB 数字。
//   · 首次取某天线 → 读原始 .grd 文本、解析一次、落盘紧凑 .grdbin（与原 .grd 并存，多占盘换性能）。
//   · 之后只读 .grdbin（typed-array 视图，无解析）；按 file 做 LRU 内存缓存。
//   · 采样为 O(1) bicubic，一次请求批量处理所有站点（每站一个 dB）。
const fs = require('fs');
const path = require('path');
const sampler = require('../../packages/core/utils/grdSampler.js');

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

  // 预编译（可选预热）：仅确保 .grdbin 生成，不采样。
  function precompile(file) {
    try { ensureBin(resolveRaw(file)); return { ok: true }; }
    catch (e) { return { ok: false, error: e && e.message }; }
  }

  return { sample, precompile };
};
