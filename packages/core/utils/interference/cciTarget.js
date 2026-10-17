// 干扰分析 · C/CCI 目标波束口径（多波束天线工具 C/I 分析的通行算法，TICRA POS / SATSOFT 同式）
//
//     C/CCI(P) = G_t(P) − 10·lg Σ_k 10^(G_k(P)/10)        P ∈ 覆盖区
//     覆盖区   = { P : G_t(P) ≥ G_t,max − X }               X = 覆盖电平（缺省 4 dB，与复用方案页 eocDb 同值）
//
//   G_t  目标波束、G_k 用户勾选的同频同极化波束，一律取各自的【共极化分量】（峰值处占优的那一路，
//        polKernel.coPolIndexOf —— 不按 icomp 硬判，理由见 grdSampler.coPolIndexOf）；
//   各波束等功率（谱密度相同），故 P_k/P_t = 1、比值里只剩方向图；路径损耗逐点对所有波束相同，约掉；
//   报数 = 覆盖区内最小值（最差点）· 5% 分位 · 中位 · 峰值点，另给最差点上的逐源分解与逐源单项最差。
//
// 与复用方案页（htsCoupling.createCciRun）的关系：那里的二值耦合、服务波束钉死为目标时，算的是同一个数。
// 区别只在取值范围：本文件只取目标 + 所选波束（不扫与本次无关的几十上百个波束），网格铺在目标覆盖区的
// 外接框上、按最长边 res 个节点细化（不是整副天线窗口并集的原节距——覆盖区只占窗口一小块，原节距下
// 覆盖区里只剩十几个节点，最差点就落在格子缝里）。
//
// 窗外：某干扰波束在该点落到它自己的 GRD 网格窗外（采样为 null）时，取其网格自身的共极化最小电平作地板
// 计入并计数（floorPts），与 htsCoupling 的 E-01 口径一致 —— 不当作零干扰丢掉。
//
// 足迹（beamFootprints）：逐波束「峰值 − X」那条等值线（经纬折线）+ 峰值落点，给界面画波束图、点选波束用；
// 目标波束那一圈就是上面的覆盖区边界（同一个 X、同一份共极化网格）。
'use strict';

const H = require('./htsCoupling.js');

const LOG10 = Math.log10;
const lin = (db) => Math.pow(10, db / 10);
const DEFAULT_RES = 161;                 // 覆盖区外接框最长边的节点数（≈ 2.6 万节点封顶）
const MAX_RES = 401;

const numOr = (v, d) => { if (v === null || v === undefined || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };

// ===== 共极化网格 =====
/** 一个波束的共极化分量：节点 dB 读取器、峰值（dB）与峰值节点、网格最小电平（窗外地板） */
function coPolScan(bm, sampler, off) {
  const g = bm.grid, N = g.NX * g.NY;
  const coIdx = sampler.coPolIndexOf(bm);
  let pw;
  if (bm.c1re) {
    const re = coIdx === 2 ? bm.c2re : bm.c1re, im = coIdx === 2 ? bm.c2im : bm.c1im;
    pw = (i) => re[i] * re[i] + im[i] * im[i];
  } else {
    const P = coIdx === 2 ? bm.P2 : bm.P1;
    pw = (i) => (P ? P[i] : 0);
  }
  let pMax = 0, iMax = -1, pMin = Infinity;
  for (let i = 0; i < N; i++) {
    const p = pw(i);
    if (p > pMax) { pMax = p; iMax = i; }
    if (p > 0 && p < pMin) pMin = p;
  }
  const db = (i) => { const p = pw(i); return p > 0 ? 10 * LOG10(p) + off : -Infinity; };
  // 解析波束：峰值走闭式 g0（与 htsCoupling.beamScan 的 coPeak 同口径），节点上铺的那份只用来找位置与画线
  const peakDb = bm.an ? bm.an.g0 + off : (pMax > 0 ? 10 * LOG10(pMax) + off : null);
  return {
    coIdx, db, peakDb, peakNode: iMax,
    floorDb: pMin < Infinity ? 10 * LOG10(pMin) + off : null,
    par: { pol: coIdx === 2 ? 'P2' : 'P1', gainOffset: off, pathLoss: 'none' }
  };
}

// ===== 几何：天线网格坐标 → 地面经纬 =====
function makeProjector(ctx, sat) {
  const S = ctx.basis.S, bx = ctx.basis.x, by = ctx.basis.y, bz = ctx.basis.z;
  const satLon = Number(sat && sat.lon) || 0;
  const wrap = (x) => { let v = ((x + 180) % 360 + 360) % 360 - 180; if (v === -180 && x > 0) v = 180; return v; };
  return function toGround(X, Y) {
    const d = H.gridDir(ctx.igrid, X, Y);
    if (!(d[2] > 0)) return null;
    const D = [
      bx[0] * d[0] + by[0] * d[1] + bz[0] * d[2],
      bx[1] * d[0] + by[1] * d[1] + bz[1] * d[2],
      bx[2] * d[0] + by[2] * d[1] + bz[2] * d[2]
    ];
    const P = H.rayEarth(S, D);
    if (!P) return null;
    const gd = H.ecefToGeodetic(P[0], P[1], P[2]);
    return { lon: satLon + wrap(gd.lon - satLon), lat: gd.lat };
  };
}
/** 地面经纬 → 天线网格坐标（地平线下 / 背半球 → null） */
function makeUnprojector(ctx) {
  const S = ctx.basis.S, bx = ctx.basis.x, by = ctx.basis.y, bz = ctx.basis.z;
  const D2R = Math.PI / 180;
  return function toGrid(lon, lat) {
    const P = H.geodeticToEcef(lon, lat, 0);
    let ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2];
    const rs = Math.hypot(ex, ey, ez);
    if (!(rs > 0)) return null;
    ex /= rs; ey /= rs; ez /= rs;
    const cl = Math.cos(lat * D2R);
    if (ex * cl * Math.cos(lon * D2R) + ey * cl * Math.sin(lon * D2R) + ez * Math.sin(lat * D2R) > 0) return null;
    return H.invGridDir(ctx.igrid,
      ex * bx[0] + ey * bx[1] + ez * bx[2], ex * by[0] + ey * by[1] + ez * by[2], ex * bz[0] + ey * bz[1] + ez * bz[2]);
  };
}

// ===== 等值线（marching squares，节点场 → 节点坐标折线）=====
// 交点按边编号去重拼链：横边 (r,c)→(r,c+1) 编 2·(r·NX+c)，竖边 (r,c)→(r+1,c) 编 2·(r·NX+c)+1。
// 鞍点（对角同侧）按四角均值判中心落哪边。开口链（顶到网格边）与闭合环都原样给出。
function isoLines(val, NX, NY, t) {
  const above = (r, c) => val(r * NX + c) >= t;
  const pt = new Map();                         // 边号 → [c, r]（节点坐标）
  const link = new Map();                       // 边号 → 相邻边号（至多两个）
  const cross = (key, r0, c0, r1, c1) => {
    if (!pt.has(key)) {
      const a = val(r0 * NX + c0), b = val(r1 * NX + c1);
      let f = Number.isFinite(a) && Number.isFinite(b) && b !== a ? (t - a) / (b - a) : 0.5;
      f = Math.max(0, Math.min(1, f));
      pt.set(key, [c0 + (c1 - c0) * f, r0 + (r1 - r0) * f]);
    }
    return key;
  };
  const join = (a, b) => {
    if (!link.has(a)) link.set(a, []);
    if (!link.has(b)) link.set(b, []);
    link.get(a).push(b); link.get(b).push(a);
  };
  for (let r = 0; r < NY - 1; r++) {
    for (let c = 0; c < NX - 1; c++) {
      const tl = above(r, c), tr = above(r, c + 1), br = above(r + 1, c + 1), bl = above(r + 1, c);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = () => cross(2 * (r * NX + c), r, c, r, c + 1);
      const B = () => cross(2 * ((r + 1) * NX + c), r + 1, c, r + 1, c + 1);
      const L = () => cross(2 * (r * NX + c) + 1, r, c, r + 1, c);
      const R = () => cross(2 * (r * NX + c + 1) + 1, r, c + 1, r + 1, c + 1);
      switch (code) {
        case 1: case 14: join(L(), B()); break;
        case 2: case 13: join(B(), R()); break;
        case 3: case 12: join(L(), R()); break;
        case 4: case 11: join(T(), R()); break;
        case 6: case 9: join(T(), B()); break;
        case 7: case 8: join(L(), T()); break;
        case 5: case 10: {
          const m = (val(r * NX + c) + val(r * NX + c + 1) + val((r + 1) * NX + c + 1) + val((r + 1) * NX + c)) / 4;
          const centerAbove = Number.isFinite(m) && m >= t;
          // 5 = tr、bl 在上；10 = tl、br 在上。中心与在上的一对同侧 → 两段把在下的两角各自切开
          if ((code === 5) === centerAbove) { join(L(), T()); join(B(), R()); } else { join(T(), R()); join(L(), B()); }
          break;
        }
      }
    }
  }
  // 拼链：先从度为 1 的端点走开口链，剩下的都是闭合环
  const used = new Set(), lines = [];
  const walk = (start) => {
    const out = [start]; used.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const nb = (link.get(cur) || []).filter((x) => x !== prev && !used.has(x));
      if (!nb.length) {
        const back = (link.get(cur) || []).includes(start) && out.length > 2;
        if (back) out.push(start);
        break;
      }
      prev = cur; cur = nb[0]; used.add(cur); out.push(cur);
    }
    return out.map((k) => pt.get(k));
  };
  for (const [k, nb] of link) if (nb.length === 1 && !used.has(k)) lines.push(walk(k));
  for (const k of link.keys()) if (!used.has(k)) lines.push(walk(k));
  return lines;
}
/** Douglas–Peucker（节点坐标，容差单位 = 节点）。闭合环（首尾同点）先在离起点最远处劈成两段各抽各的——
 *  不劈的话首尾那条「弦」长度为 0，所有点到它的距离都算成 0，整环会被抽成两个点。 */
function simplify(pts, tol) {
  const n = pts.length;
  if (n <= 3) return pts;
  if (pts[0][0] === pts[n - 1][0] && pts[0][1] === pts[n - 1][1]) {
    let m = 1, dm = -1;
    for (let i = 1; i < n - 1; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > dm) { dm = d; m = i; } }
    return simplify(pts.slice(0, m + 1), tol).concat(simplify(pts.slice(m), tol).slice(1));
  }
  const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x0, y0] = pts[a], [x1, y1] = pts[b];
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    let dm = -1, im = -1;
    for (let i = a + 1; i < b; i++) {
      const d = L > 1e-12 ? Math.abs((pts[i][0] - x0) * dy - (pts[i][1] - y0) * dx) / L : Math.hypot(pts[i][0] - x0, pts[i][1] - y0);
      if (d > dm) { dm = d; im = i; }
    }
    if (dm > tol && im > 0) { keep[im] = 1; stack.push([a, im], [im, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** 峰值节点的亚节点落点（两轴各做一次抛物线拟合，dB 域） */
function refinePeak(sc, NX, NY) {
  const i = sc.peakNode;
  if (i < 0) return null;
  const r = Math.floor(i / NX), c = i - r * NX;
  const at = (rr, cc) => sc.db(rr * NX + cc);
  const fit = (m, z, p) => { const d = m - 2 * z + p; return Number.isFinite(d) && d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (m - p) / d)) : 0; };
  const fc = c > 0 && c < NX - 1 ? fit(at(r, c - 1), at(r, c), at(r, c + 1)) : 0;
  const fr = r > 0 && r < NY - 1 ? fit(at(r - 1, c), at(r, c), at(r + 1, c)) : 0;
  return [c + fc, r + fr];
}

/**
 * 逐波束足迹：峰值 − levelDb 那条共极化等值线（经纬折线）+ 峰值落点。
 * @returns {{ beams: [{ idx, peakDb, peak:{lon,lat}|null, rings:number[][] }], level }}
 *   rings 每条一串 [lon0,lat0,lon1,lat1,…]（4 位小数），落到地球外的那段断开
 */
function beamFootprints(o) {
  const opt = o || {};
  const sampler = opt.sampler;
  const ctx = sampler.makeSampleCtx(opt.loaded, opt.sat || {}, { ...(opt.cfg || {}), pathLoss: 'none' });
  if (!ctx) throw new Error('天线几何无效（对星指向或卫星位置缺失）');
  const level = Math.max(0.1, numOr(opt.levelDb, H.DEFAULT_EOC_DB));
  const toGround = makeProjector(ctx, opt.sat);
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const beams = ctx.beams.map((bm, k) => {
    const g = bm.grid, NX = g.NX, NY = g.NY;
    const dx = (g.XE - g.XS) / (NX - 1), dy = (g.YE - g.YS) / (NY - 1);
    const sc = coPolScan(bm, sampler, Number(ctx.par.gainOffset) || 0);
    const out = { idx: ctx.beamIdx[k], peakDb: sc.peakDb == null ? null : +sc.peakDb.toFixed(2), peak: null, rings: [] };
    if (sc.peakDb == null) return out;
    const pk = refinePeak(sc, NX, NY);
    if (pk) { const p = toGround(g.XS + pk[0] * dx, g.YS + pk[1] * dy); if (p) out.peak = { lon: r4(p.lon), lat: r4(p.lat) }; }
    const N = NX * NY, arr = new Float32Array(N);
    for (let i = 0; i < N; i++) arr[i] = sc.db(i);
    const lines = isoLines((i) => arr[i], NX, NY, sc.peakDb - level);
    for (const ln of lines) {
      let cur = [];
      for (const q of simplify(ln, 0.05)) {
        const p = toGround(g.XS + q[0] * dx, g.YS + q[1] * dy);
        if (!p) { if (cur.length >= 4) out.rings.push(cur); cur = []; continue; }
        cur.push(r4(p.lon), r4(p.lat));
      }
      if (cur.length >= 4) out.rings.push(cur);
    }
    return out;
  });
  return { beams, level };
}

/**
 * 目标波束 C/CCI 作业（主进程分帧推进，与 htsCoupling.createCciRun 同一套 stepBatch / finalize 接口）。
 *   o = { sampler, loaded, sat, cfg, target: 原始下标, cochannel: [原始下标], eocDb, res }
 * 单位 = 覆盖区外接框上的一个节点。
 */
function createTargetRun(o) {
  const opt = o || {};
  const sampler = opt.sampler;
  if (!sampler || typeof sampler.makeSampleCtx !== 'function') throw new Error('缺少 GRD 采样器');
  const ctx = sampler.makeSampleCtx(opt.loaded, opt.sat || {}, { ...(opt.cfg || {}), pathLoss: 'none' });
  if (!ctx) throw new Error('天线几何无效（对星指向或卫星位置缺失）');
  const off = Number(ctx.par.gainOffset) || 0;
  const tPos = ctx.beamIdx.indexOf(Number(opt.target));
  if (tPos < 0) throw new Error('目标波束不在方向图的存活波束里');
  const tBm = ctx.beams[tPos];
  const tSc = coPolScan(tBm, sampler, off);
  if (tSc.peakDb == null) throw new Error('目标波束共极化分量全为零');
  const missing = [];
  const seen = new Set([Number(opt.target)]);
  const intf = [];
  for (const v of Array.isArray(opt.cochannel) ? opt.cochannel : []) {
    const idx = Number(v);
    if (!Number.isInteger(idx) || seen.has(idx)) continue;
    seen.add(idx);
    const p = ctx.beamIdx.indexOf(idx);
    if (p < 0) { missing.push(idx); continue; }
    const sc = coPolScan(ctx.beams[p], sampler, off);
    intf.push({ idx, bm: ctx.beams[p], par: sc.par, floorDb: sc.floorDb });
  }
  if (!intf.length) throw new Error('未选同频波束');
  const K = intf.length;
  const eocDb = Math.max(0.1, numOr(opt.eocDb, H.DEFAULT_EOC_DB));
  const thr = tSc.peakDb - eocDb;

  // 覆盖区外接框（目标网格节点）
  const g = tBm.grid, NX = g.NX, NY = g.NY;
  const gdx = (g.XE - g.XS) / (NX - 1), gdy = (g.YE - g.YS) / (NY - 1);
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity, clipped = false;
  for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) {
    if (!(tSc.db(r * NX + c) >= thr)) continue;
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
    if (c === 0 || r === 0 || c === NX - 1 || r === NY - 1) clipped = true;
  }
  if (!(c1 >= c0)) throw new Error('目标波束网格上没有达到覆盖电平的节点');
  c0 = Math.max(0, c0 - 1); r0 = Math.max(0, r0 - 1); c1 = Math.min(NX - 1, c1 + 1); r1 = Math.min(NY - 1, r1 + 1);
  const X0 = g.XS + c0 * gdx, Y0 = g.YS + r0 * gdy;
  const spanX = (c1 - c0) * gdx, spanY = (r1 - r0) * gdy;
  const res = Math.max(21, Math.min(MAX_RES, Math.round(numOr(opt.res, DEFAULT_RES))));
  const h = Math.max(Math.abs(spanX), Math.abs(spanY)) / (res - 1) || Math.abs(gdx) || 1e-3;
  const nx = Math.max(2, Math.round(Math.abs(spanX) / h) + 1), ny = Math.max(2, Math.round(Math.abs(spanY) / h) + 1);
  const sx = spanX / (nx - 1), sy = spanY / (ny - 1);
  const T = nx * ny;

  const toGround = makeProjector(ctx, opt.sat);
  const lonA = new Float64Array(T).fill(NaN), latA = new Float64Array(T).fill(NaN);
  const zv = new Float32Array(T).fill(NaN);           // 覆盖区内的 C/CCI，区外 NaN
  const gtA = new Float32Array(T).fill(NaN);          // 目标增益（找峰值点）
  const minSingle = new Float64Array(K).fill(Infinity), minSingleAt = new Int32Array(K).fill(-1);
  const gk = new Float64Array(K), flk = new Uint8Array(K);
  let floorPts = 0, cover = 0, gi = 0;
  const t0 = Date.now();

  function stepNode(k) {
    const i = k % nx, j = (k - i) / nx;
    const p = toGround(X0 + i * sx, Y0 + j * sy);
    if (!p) return;
    lonA[k] = p.lon; latA[k] = p.lat;
    const gt = sampler.sampleBeamAt(tBm, ctx.igrid, ctx.basis, p.lon, p.lat, tSc.par);
    if (gt == null) return;
    gtA[k] = gt;
    if (!(gt >= thr)) return;
    cover++;
    let sum = 0, fl = false;
    for (let m = 0; m < K; m++) {
      const it = intf[m];
      let v = sampler.sampleBeamAt(it.bm, ctx.igrid, ctx.basis, p.lon, p.lat, it.par);
      if (v == null) { v = it.floorDb; fl = true; }
      if (v == null) continue;
      sum += lin(v);
      const single = gt - v;
      if (single < minSingle[m]) { minSingle[m] = single; minSingleAt[m] = k; }
    }
    if (fl) floorPts++;
    zv[k] = sum > 0 ? gt - 10 * LOG10(sum) : Infinity;
  }
  function stepBatch(units) {
    const end = Math.min(T, gi + Math.max(1, Math.floor(units) || 1));
    for (; gi < end; gi++) stepNode(gi);
    return gi;
  }

  // 一点上的逐源分解（最差点 / 峰值点）
  function breakdown(k) {
    const lon = lonA[k], lat = latA[k];
    const gt = gtA[k];
    let sum = 0;
    for (let m = 0; m < K; m++) {
      let v = sampler.sampleBeamAt(intf[m].bm, ctx.igrid, ctx.basis, lon, lat, intf[m].par);
      flk[m] = 0;
      if (v == null) { v = intf[m].floorDb; flk[m] = 1; }
      gk[m] = v == null ? -Infinity : v;
      if (v != null) sum += lin(v);
    }
    const items = intf.map((it, m) => ({
      idx: it.idx,
      gainDb: Number.isFinite(gk[m]) ? gk[m] : null,
      ciDb: Number.isFinite(gk[m]) ? gt - gk[m] : null,
      sharePct: sum > 0 && Number.isFinite(gk[m]) ? lin(gk[m]) / sum * 100 : 0,
      floored: !!flk[m]
    })).sort((a, b) => b.sharePct - a.sharePct);
    return { lon, lat, gainDb: gt, cciDb: sum > 0 ? gt - 10 * LOG10(sum) : null, items };
  }

  function finalize() {
    while (gi < T) stepBatch(1e9);
    const vals = [];
    let wk = -1, pk = -1;
    for (let k = 0; k < T; k++) {
      const v = zv[k];
      if (v !== v) continue;
      vals.push(v);
      if (wk < 0 || v < zv[wk]) wk = k;
      if (pk < 0 || gtA[k] > gtA[pk]) pk = k;
    }
    const st = H.statsOf(vals, null);
    const singles = intf.map((it, m) => ({
      idx: it.idx,
      minDb: minSingle[m] < Infinity ? minSingle[m] : null,
      at: minSingleAt[m] >= 0 ? { lon: lonA[minSingleAt[m]], lat: latA[minSingleAt[m]] } : null
    }));
    return {
      target: Number(opt.target), cochannel: intf.map((x) => x.idx), missing,
      eocDb, peakDb: tSc.peakDb, coverDb: thr,
      grid: { nx, ny, step: h }, nodes: T, cover, floorPts, clipped,
      stats: st,
      worst: wk >= 0 ? breakdown(wk) : null,
      peak: pk >= 0 ? breakdown(pk) : null,
      singles,
      field: fieldOf(),
      elapsedMs: Date.now() - t0
    };
  }

  // 天线网格 → 经纬栅格（显示用）：逐格反算到外接框的网格坐标，四邻双线性（缺角取最近的有值节点）
  function fieldOf() {
    let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity, m = 0;
    for (let k = 0; k < T; k++) {
      if (zv[k] !== zv[k]) continue;
      m++;
      if (lonA[k] < lo0) lo0 = lonA[k]; if (lonA[k] > lo1) lo1 = lonA[k];
      if (latA[k] < la0) la0 = latA[k]; if (latA[k] > la1) la1 = latA[k];
    }
    if (!m || !(lo1 > lo0) || !(la1 > la0)) return null;
    const CAP = 600;
    const step = Math.max(Math.sqrt((lo1 - lo0) * (la1 - la0) / m), (lo1 - lo0) / (CAP - 1), (la1 - la0) / (CAP - 1), 1e-5);
    const fx = Math.max(2, Math.floor((lo1 - lo0) / step) + 1), fy = Math.max(2, Math.floor((la1 - la0) / step) + 1);
    const xs = new Float64Array(fx), ys = new Float64Array(fy);
    for (let i = 0; i < fx; i++) xs[i] = lo0 + i * step;
    for (let j = 0; j < fy; j++) ys[j] = la0 + j * step;
    const z = new Float32Array(fx * fy).fill(NaN);
    const toGrid = makeUnprojector(ctx);
    const node = (i, j) => { const v = zv[j * nx + i]; return Number.isFinite(v) ? v : NaN; };
    let valid = 0, lo = Infinity, hi = -Infinity;
    for (let j = 0; j < fy; j++) {
      for (let i = 0; i < fx; i++) {
        const xy = toGrid(xs[i], ys[j]);
        if (!xy) continue;
        const u = (xy[0] - X0) / sx, w = (xy[1] - Y0) / sy;
        if (!(u >= 0 && w >= 0 && u <= nx - 1 && w <= ny - 1)) continue;
        const i0 = Math.min(nx - 2, Math.floor(u)), j0 = Math.min(ny - 2, Math.floor(w));
        const tx = u - i0, ty = w - j0;
        const a = node(i0, j0), b = node(i0 + 1, j0), c = node(i0, j0 + 1), d = node(i0 + 1, j0 + 1);
        let v;
        if (a === a && b === b && c === c && d === d) v = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
        else v = node(tx < 0.5 ? i0 : i0 + 1, ty < 0.5 ? j0 : j0 + 1);
        if (v === v) { z[j * fx + i] = v; valid++; if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    return { xs, ys, nx: fx, ny: fy, z, valid, min: valid ? lo : null, max: valid ? hi : null };
  }

  return { T, n: K + 1, nodes: T, grid: { kind: 'target', nx, ny }, stepBatch, finalize };
}

module.exports = { beamFootprints, createTargetRun, isoLines, DEFAULT_RES };
