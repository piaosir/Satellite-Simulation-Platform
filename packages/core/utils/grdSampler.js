// GRD 点采样（主进程 / CommonJS）—— 把「243MB 文本读取 + 整文件解析」彻底移出渲染进程。
//
// 设计（链路预算第一期）：
//   · 文本 GRD 只在【首次取值时】解析一次 → 落盘紧凑二进制 .grdbin（每点 4 个 Float32 复分量），
//     之后永不再碰文本；启动只读二进制（typed-array 视图，无解析）。
//   · 取值在主进程内做，渲染端只通过 IPC 收发「经纬度 → dB 数字」，大数据永不跨 IPC。
//
// 数学口径与渲染端 src/viz/grd/{parse,coverage}.js + src/viz/wgs84.js 完全一致（逐函数移植）。
// 仅服务链路预算的「多波束最大 Parameter」点取值；3D 覆盖页仍用其原渲染路径，互不影响。

// ===== WGS84（src/viz/wgs84.js 同源）=====
const A = 6378.137, B = 6356.7523142, F = (A - B) / A, E2 = 2 * F - F * F, RS_GEO = 42164.17;
const D2R = Math.PI / 180, H = RS_GEO - A;
function geodeticToEcef(lonDeg, latDeg, hKm) {
  hKm = hKm || 0;
  const lat = latDeg * D2R, lon = lonDeg * D2R, sl = Math.sin(lat), cl = Math.cos(lat);
  const N = A / Math.sqrt(1 - E2 * sl * sl);
  return [(N + hKm) * cl * Math.cos(lon), (N + hKm) * cl * Math.sin(lon), (N * (1 - E2) + hKm) * sl];
}

// ===== 向量工具（src/viz/grd/coverage.js 同源）=====
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => sc(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// 网格坐标 → 天线系单位矢量（GRD说明 §5）
function gridDir(igrid, X, Y) {
  if (igrid === 1) { const u = X, v = Y; return [u, v, Math.sqrt(Math.max(0, 1 - u * u - v * v))]; }
  if (igrid === 7) { const ph = X * D2R, th = Y * D2R; return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)]; }
  const az = X * D2R, el = Y * D2R, ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  switch (igrid) {
    case 4: return [-sa * ce, se, ca * ce];
    case 6: return [-sa, ca * se, ca * ce];
    case 9: return [sa * ce, se, ca * ce];
    case 10: return [sa, ca * se, ca * ce];
    case 5: { const th = Math.hypot(az, el), ph = Math.atan2(el, -az); return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)]; }
    default: throw new Error('未支持的 igrid=' + igrid);
  }
}
// gridDir 的逆：天线系单位矢量 → 网格坐标 [X,Y]；c<=0（boresight 背面）返回 null。
function invGridDir(igrid, a, b, c) {
  if (!(c > 0)) return null;
  if (igrid === 1) return (a * a + b * b <= 1) ? [a, b] : null;
  if (igrid === 7) { const th = Math.acos(Math.max(-1, Math.min(1, c))), ph = Math.atan2(b, a); return [ph / D2R, th / D2R]; }
  if (igrid === 5) { const th = Math.acos(Math.max(-1, Math.min(1, c))), ph = Math.atan2(b, a); return [(-th * Math.cos(ph)) / D2R, (th * Math.sin(ph)) / D2R]; }
  let az, el;
  switch (igrid) {
    case 4: el = Math.asin(Math.max(-1, Math.min(1, b))); az = Math.atan2(-a, c); break;
    case 9: el = Math.asin(Math.max(-1, Math.min(1, b))); az = Math.atan2(a, c); break;
    case 6: el = Math.atan2(b, c); az = Math.atan2(-a, Math.hypot(b, c)); break;
    case 10: el = Math.atan2(b, c); az = Math.atan2(a, Math.hypot(b, c)); break;
    default: return null;
  }
  return [az / D2R, el / D2R];
}
// 天线姿态基底（geo 模式：boresight 指地表目标点）
function antennaBasis(satLon, boreLon, boreLat, yawDeg, satLat, altKm) {
  if (boreLon === undefined) boreLon = satLon;
  boreLat = boreLat || 0; yawDeg = yawDeg || 0; satLat = satLat || 0; altKm = altKm === undefined ? H : altKm;
  const S = geodeticToEcef(satLon, satLat, altKm);
  const T = geodeticToEcef(boreLon, boreLat, 0);
  const z = nrm(sub(T, S));
  let x = nrm(crs([0, 0, 1], z)), y = crs(z, x);
  if (yawDeg) { const c = Math.cos(yawDeg * D2R), sn = Math.sin(yawDeg * D2R); const x2 = add(sc(x, c), sc(y, sn)), y2 = add(sc(y, c), sc(x, -sn)); x = x2; y = y2; }
  return { S, x, y, z };
}
// 方向式天线姿态（azel 模式：boresight 由相对天底的 az/el 给定，导入天线默认）
function antennaBasisAzEl(satLon, satLat, altKm, azDeg, elDeg, yawDeg) {
  satLat = satLat || 0; altKm = altKm === undefined ? H : altKm; azDeg = azDeg || 0; elDeg = elDeg || 0; yawDeg = yawDeg || 0;
  const nb = antennaBasis(satLon, satLon, satLat, 0, satLat, altKm);
  const dir = gridDir(6, azDeg, elDeg);
  const z = nrm([
    nb.x[0] * dir[0] + nb.y[0] * dir[1] + nb.z[0] * dir[2],
    nb.x[1] * dir[0] + nb.y[1] * dir[1] + nb.z[1] * dir[2],
    nb.x[2] * dir[0] + nb.y[2] * dir[1] + nb.z[2] * dir[2]
  ]);
  let x = nrm(crs([0, 0, 1], z)), y = crs(z, x);
  if (yawDeg) { const c = Math.cos(yawDeg * D2R), sn = Math.sin(yawDeg * D2R); const x2 = add(sc(x, c), sc(y, sn)), y2 = add(sc(y, c), sc(x, -sn)); x = x2; y = y2; }
  return { S: nb.S, x, y, z };
}

// ===== 双三次/双线性插值（coverage.js 同源）=====
const keysW = (s) => { s = Math.abs(s); const a = -0.5; return s <= 1 ? ((a + 2) * s - (a + 3)) * s * s + 1 : (s < 2 ? ((a * s - 5 * a) * s + 8 * a) * s - 4 * a : 0); };
const clampI = (v, n) => (v < 0 ? 0 : (v > n - 1 ? n - 1 : v));
function bicubicAt(arr, NX, NY, fc, fr) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr), tx = fc - c0, ty = fr - r0;
  const wx = [keysW(1 + tx), keysW(tx), keysW(1 - tx), keysW(2 - tx)];
  const wy = [keysW(1 + ty), keysW(ty), keysW(1 - ty), keysW(2 - ty)];
  let acc = 0;
  for (let j = 0; j < 4; j++) {
    const rr = clampI(r0 - 1 + j, NY) * NX;
    let row = 0;
    for (let i = 0; i < 4; i++) row += wx[i] * arr[rr + clampI(c0 - 1 + i, NX)];
    acc += wy[j] * row;
  }
  return acc;
}
function bilinearAt(arr, NX, NY, fc, fr) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr), c1 = Math.min(c0 + 1, NX - 1), r1 = Math.min(r0 + 1, NY - 1), tx = fc - c0, ty = fr - r0;
  return arr[r0 * NX + c0] * (1 - tx) * (1 - ty) + arr[r0 * NX + c1] * tx * (1 - ty) + arr[r1 * NX + c0] * (1 - tx) * ty + arr[r1 * NX + c1] * tx * ty;
}

// 在 (lon,lat) 上对单波束采 Parameter（dB）。口径同 coverage.sampleBeamAt（复场域 bicubic）。
//
// tgtAltKm > 0 = 目标点在【空间】而非地表（星间链路：另一颗星的位置）。此时不走地平线闸——
// 那一闸判的是「卫星在地面测站的地平线之下」，对空间目标没有意义（互视与否由星间几何求解器
// 的地球临边遮挡判定，见 ngsoGeometry.solveIslWorstCase，取值只在它判定互视的那一刻发生）。
function sampleBeamAt(beam, igrid, basis, lon, lat, opt, tgtAltKm) {
  const pol = (opt && opt.pol) || 'RSS', gainOffset = (opt && opt.gainOffset) || 0, pathLoss = (opt && opt.pathLoss) || 'none';
  const hNadir = (opt && opt.hNadir) || H;
  const hT = Number(tgtAltKm) > 0 ? Number(tgtAltKm) : 0;
  const { S, x, y, z } = basis;
  const P = geodeticToEcef(lon, lat, hT);
  const ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2];
  const rs = Math.hypot(ex, ey, ez); if (!(rs > 0)) return null;
  const e = [ex / rs, ey / rs, ez / rs];
  if (!hT) {
    const clat = Math.cos(lat * D2R), up = [clat * Math.cos(lon * D2R), clat * Math.sin(lon * D2R), Math.sin(lat * D2R)];
    if (dt(e, up) > 0) return null;                                // 卫星在测站地平线下 → 不可见
  }
  const a = dt(e, x), b = dt(e, y), c = dt(e, z);
  const xy = invGridDir(igrid, a, b, c); if (!xy) return null;
  const g = beam.grid, NX = g.NX, NY = g.NY;
  const fc = (xy[0] - g.XS) / ((g.XE - g.XS) / (NX - 1));
  const fr = (xy[1] - g.YS) / ((g.YE - g.YS) / (NY - 1));
  if (fc < 0 || fc > NX - 1 || fr < 0 || fr > NY - 1) return null;  // 站点在方向图网格域外
  let p1, p2;
  if (beam.c1re) {
    const re1 = bicubicAt(beam.c1re, NX, NY, fc, fr), im1 = bicubicAt(beam.c1im, NX, NY, fc, fr);
    const re2 = bicubicAt(beam.c2re, NX, NY, fc, fr), im2 = bicubicAt(beam.c2im, NX, NY, fc, fr);
    p1 = re1 * re1 + im1 * im1; p2 = re2 * re2 + im2 * im2;
  } else {
    const samp = (arr) => { const v = bicubicAt(arr, NX, NY, fc, fr); return v > 0 ? v : bilinearAt(arr, NX, NY, fc, fr); };
    p1 = samp(beam.P1); p2 = samp(beam.P2);
  }
  let Pw;
  if (pol === 'P1') Pw = p1;
  else if (pol === 'P2') Pw = p2;
  else if (pol === 'RSS') Pw = p1 + p2;
  else if (pol === 'P1/P2') Pw = p2 > 0 ? p1 / p2 : 0;
  else if (pol === 'P2/P1') Pw = p1 > 0 ? p2 / p1 : 0;
  else Pw = p1;
  if (!(Pw > 0)) return null;
  let v = 10 * Math.log10(Pw) + gainOffset;
  if (pathLoss !== 'none') v += pathLoss === 'relative' ? 20 * Math.log10(hNadir / rs) : -10 * Math.log10(4 * Math.PI * rs * rs);
  return v;
}

// ===== GRASP .grd 文本解析（src/viz/grd/parse.js 同源，改动请两处对照）=====
// '++++' 判据、多候选重试、可读报错三项与那边逐条同源，理由见其头注：
// '++++NNNN'（SATSOFT 文件 ID）与文本头里的装饰行同样满足官方 TEXT(1:4) 判据，故按候选逐个试读头部。
function readHead(L, at) {
  if (at + 1 >= L.length) return null;
  const ktype = parseInt(L[at].trim());
  if (!Number.isFinite(ktype)) return null;
  const head = L[at + 1].trim().split(/\s+/).map(Number);
  if (head.length < 4 || !head.slice(0, 4).every(Number.isFinite)) return null;
  const nset = head[0], ncomp = head[2];
  if (!(nset >= 1) || !(ncomp >= 1)) return null;
  if (at + 2 + nset + 1 >= L.length) return null;
  const b = L[at + 2 + nset].trim().split(/\s+/).map(Number);
  const g = L[at + 3 + nset].trim().split(/\s+/).map(Number);
  if (b.length < 4 || !b.slice(0, 4).every(Number.isFinite)) return null;
  if (!(g[0] >= 2) || !(g[1] >= 2)) return null;
  return { ktype: ktype, nset: nset, icomp: head[1], ncomp: ncomp, igrid: head[3], next: at + 2 };
}
function parseGrd(text) {
  const L = text.split(/\r\n|\n|\r/);
  let h = null, i = 0, marks = 0;
  for (let k = 0; k < L.length; k++) {
    if (!/^\+{4}/.test(L[k].trim())) continue;   // 官方判据 TEXT(1:4)=='++++'：行首 4 个 '+'，其后可跟任意内容
    marks++;
    h = readHead(L, k + 1);
    if (h) { i = h.next; break; }
  }
  if (!marks) throw new Error('未找到结束标记 ++++：可能非 GRASP 网格或二进制');
  if (!h) throw new Error('找到了 ++++ 但其后不是 GRASP 网格头（应为 KTYPE 与 NSET ICOMP NCOMP IGRID）：可能是 SATSOFT ++++NNNN 一类的同标记异格式文件');
  const ktype = h.ktype, nset = h.nset, icomp = h.icomp, ncomp = h.ncomp, igrid = h.igrid;
  for (let s = 0; s < nset; s++) i++;
  const sets = [];
  const line = (n) => { const v = L[n]; if (v === undefined) throw new Error('文件在第 ' + (n + 1) + ' 行处提前结束：网格数据不完整（可能被截断或非 GRASP 网格）'); return v; };
  for (let s = 0; s < nset; s++) {
    const xline = line(i++).trim().split(/\s+/).map(Number);
    const XS = xline[0], YS = xline[1], XE = xline[2], YE = xline[3];
    const dline = line(i++).trim().split(/\s+/).map(Number);
    const NX = dline[0], NY = dline[1], KLIMIT = dline[2];
    if (!(NX >= 2) || !(NY >= 2)) throw new Error('波束 ' + (s + 1) + ' 的网格点数无效（NX=' + NX + ', NY=' + NY + '）');
    const N = NX * NY;
    const c1re = new Float32Array(N), c1im = new Float32Array(N), c2re = new Float32Array(N), c2im = new Float32Array(N);
    for (let row = 0; row < NY; row++) {
      let cs = 0, ce = NX;
      if (KLIMIT === 1) { const p = line(i++).trim().split(/\s+/).map(Number); cs = p[0] - 1; ce = cs + p[1]; }
      for (let col = cs; col < ce; col++) {
        const r = line(i++).trim().split(/\s+/);
        const a = +r[0], b = +r[1], c = ncomp >= 2 ? +r[2] : 0, d = ncomp >= 2 ? +r[3] : 0;
        const idx = row * NX + col;
        c1re[idx] = a; c1im[idx] = b; c2re[idx] = c; c2im[idx] = d;
      }
    }
    sets.push({ XS, YS, XE, YE, NX, NY, c1re, c1im, c2re, c2im });
  }
  return { ktype, nset, icomp, ncomp, igrid, sets };
}

// ===== 紧凑二进制 .grdbin =====
// 布局: [4 'GRDB'][u32 ver=1][u32 headerLen][header JSON][pad→4][数据区: 每 set 连续 c1re,c1im,c2re,c2im(Float32LE)]
const MAGIC = 'GRDB';
function buildBin(text) {
  const g = parseGrd(text);
  const header = { v: 1, igrid: g.igrid, icomp: g.icomp, ncomp: g.ncomp, sets: [] };
  let dataBytes = 0;
  for (const s of g.sets) { const n = s.NX * s.NY; header.sets.push({ XS: s.XS, YS: s.YS, XE: s.XE, YE: s.YE, NX: s.NX, NY: s.NY, off: dataBytes, n }); dataBytes += n * 4 * 4; }
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headEnd = 12 + headerJson.length;
  const pad = (4 - (headEnd % 4)) % 4;
  const dataStart = headEnd + pad;
  const buf = Buffer.allocUnsafe(dataStart + dataBytes);
  buf.write(MAGIC, 0, 'ascii'); buf.writeUInt32LE(1, 4); buf.writeUInt32LE(headerJson.length, 8);
  headerJson.copy(buf, 12);
  for (let p = 0; p < pad; p++) buf[headEnd + p] = 0;
  for (let si = 0; si < g.sets.length; si++) {
    const s = g.sets[si], n = s.NX * s.NY, base = dataStart + header.sets[si].off;
    // Float32Array 为本机字节序（Windows x86 = LE，与 Float32LE 一致）→ 直接拷字节
    Buffer.from(s.c1re.buffer, s.c1re.byteOffset, n * 4).copy(buf, base);
    Buffer.from(s.c1im.buffer, s.c1im.byteOffset, n * 4).copy(buf, base + n * 4);
    Buffer.from(s.c2re.buffer, s.c2re.byteOffset, n * 4).copy(buf, base + 2 * n * 4);
    Buffer.from(s.c2im.buffer, s.c2im.byteOffset, n * 4).copy(buf, base + 3 * n * 4);
  }
  return buf;
}
function loadBin(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('非法 .grdbin');
  const headerLen = buf.readUInt32LE(8);
  const header = JSON.parse(buf.toString('utf8', 12, 12 + headerLen));
  const headEnd = 12 + headerLen, pad = (4 - (headEnd % 4)) % 4, dataStart = headEnd + pad;
  const ab = buf.buffer, abOff = buf.byteOffset;
  const view = (off, n) => {
    const base = abOff + dataStart + off;
    if (base % 4 === 0) return new Float32Array(ab, base, n);
    return new Float32Array(ab.slice(base, base + n * 4));   // 对齐兜底（极少触发）
  };
  const beams = header.sets.map((s) => ({
    grid: { XS: s.XS, YS: s.YS, XE: s.XE, YE: s.YE, NX: s.NX, NY: s.NY },
    c1re: view(s.off, s.n), c1im: view(s.off + s.n * 4, s.n), c2re: view(s.off + 2 * s.n * 4, s.n), c2im: view(s.off + 3 * s.n * 4, s.n)
  }));
  return { igrid: header.igrid, icomp: header.icomp, ncomp: header.ncomp, beams };
}

// 采样上下文：把「天线基底 + 取值口径 + 存活波束集」这三件一次算好，供 sampleMax / sampleAll 共用。
// 逐格采样时（C/CCI 场图动辄几千格）不重复建基底，是这层拆分的全部意义。
// 波束删除对齐：cfg.keptSets = 存活波束在【原始 GRD set 顺序】里的下标（升序）。本模块 loaded.beams 由
// buildBin 按原始 set 顺序落盘，故下标一一对应 → 与「星座3D 性能指标表」一致（其 ctx.beams 已按 keptSets 裁剪）。
// 无删除记录（keptSets 非数组或已覆盖全部）→ 用全部波束（旧行为）。
function makeSampleCtx(loaded, sat, cfg) {
  if (!loaded) return null;
  const c = cfg || {}, s = sat || {};
  const satLon = Number(s.lon), satLat = Number(s.lat) || 0, satAlt = Number.isFinite(s.alt) ? Number(s.alt) : H;
  if (!Number.isFinite(satLon)) return null;
  const basis = (c.boreType || 'azel') === 'azel'
    ? antennaBasisAzEl(satLon, satLat, satAlt, c.boreAz || 0, c.boreEl || 0, c.yaw || 0)
    : antennaBasis(satLon, c.boreLon == null ? satLon : c.boreLon, c.boreLat || 0, c.yaw || 0, satLat, satAlt);
  const par = { pol: c.pol || 'RSS', gainOffset: Number(c.gainOffset) || 0, pathLoss: c.pathLoss || 'none' };
  const all = loaded.beams;
  const keep = Array.isArray(c.keptSets) ? c.keptSets : null;
  const useIdx = (keep && keep.length < all.length) ? keep.filter((i) => all[i]) : all.map((_, i) => i);
  return { igrid: loaded.igrid, basis, par, beams: useIdx.map((i) => all[i]), beamIdx: useIdx };
}

// 多波束最大 Parameter（绝对 dB）。口径同 grdParam.ensureAntenna + maxParamAt。域外/不可见返回 null。
// tgtAltKm > 0 → 目标点在空间（星间链路对另一颗星取值），见 sampleBeamAt。
function sampleMax(loaded, sat, cfg, lon, lat, tgtAltKm) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const ctx = makeSampleCtx(loaded, sat, cfg);
  if (!ctx) return null;
  return sampleMaxCtx(ctx, lon, lat, tgtAltKm);
}

/**
 * 方向图峰值（dB，与 sampleMax 同口径）：取**网格节点**上的最大值，不插值、不看几何。
 *
 * NGSO 时变干扰要的是「相对滚降」= 采样值 − 峰值：干扰源的入参是满 EIRP 谱密度，
 * 里头已含卫星天线峰值增益，方向图在那里只作一条 ≤0 的修正（见 interference/patternsSat.js）。
 * 峰值必须与采样值同口径（同 pol 组合、同 gainOffset），否则修正量会整体平移。
 * 节点最大值与插值后的真峰相差不超过一个网格的曲率，对滚降口径可忽略。
 */
function peakDb(loaded, cfg) {
  if (!loaded || !loaded.beams || !loaded.beams.length) return null;
  const c = cfg || {};
  const pol = c.pol || 'RSS', gainOffset = Number(c.gainOffset) || 0;
  const keep = Array.isArray(c.keptSets) ? c.keptSets : null;
  const beams = (keep && keep.length < loaded.beams.length)
    ? keep.map((i) => loaded.beams[i]).filter(Boolean) : loaded.beams;
  let best = null;
  for (const bm of beams) {
    const n = bm.grid.NX * bm.grid.NY;
    for (let i = 0; i < n; i++) {
      let p1, p2;
      if (bm.c1re) { p1 = bm.c1re[i] * bm.c1re[i] + bm.c1im[i] * bm.c1im[i]; p2 = bm.c2re[i] * bm.c2re[i] + bm.c2im[i] * bm.c2im[i]; }
      else { p1 = bm.P1[i]; p2 = bm.P2[i]; }
      let Pw;
      if (pol === 'P1') Pw = p1;
      else if (pol === 'P2') Pw = p2;
      else if (pol === 'RSS') Pw = p1 + p2;
      else if (pol === 'P1/P2') Pw = p2 > 0 ? p1 / p2 : 0;
      else if (pol === 'P2/P1') Pw = p1 > 0 ? p2 / p1 : 0;
      else Pw = p1;
      if (Pw > 0 && (best === null || Pw > best)) best = Pw;
    }
  }
  return best === null ? null : 10 * Math.log10(best) + gainOffset;
}

function sampleMaxCtx(ctx, lon, lat, tgtAltKm) {
  let best = null;
  for (const bm of ctx.beams) {
    const db = sampleBeamAt(bm, ctx.igrid, ctx.basis, lon, lat, ctx.par, tgtAltKm);
    if (db == null) continue;
    if (best == null || db > best) best = db;
  }
  return best == null ? null : +best.toFixed(2);
}

/**
 * 【逐波束】Parameter（绝对 dB），与存活波束一一对应、同序。
 *
 * 为什么需要它而 sampleMax 不够：干扰算的是「服务波束 vs 其余同频波束」的比值，
 * 一个最大值把分母整个丢掉了。C/CCI（同频复用干扰）与逐波束 XPD 都要这份明细。
 *
 * 返回 { values:(number|null)[], beamIdx:number[] }——beamIdx 是各值在【原始 GRD set 顺序】
 * 里的下标，频率复用着色按它索引，别用数组下标（存活波束可能已被裁剪过）。
 * 整点域外/不可见 → values 全 null。
 */
function sampleAll(loaded, sat, cfg, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { values: [], beamIdx: [] };
  const ctx = makeSampleCtx(loaded, sat, cfg);
  if (!ctx) return { values: [], beamIdx: [] };
  return { values: sampleAllCtx(ctx, lon, lat), beamIdx: ctx.beamIdx.slice() };
}

function sampleAllCtx(ctx, lon, lat) {
  const out = new Array(ctx.beams.length);
  for (let i = 0; i < ctx.beams.length; i++) {
    const db = sampleBeamAt(ctx.beams[i], ctx.igrid, ctx.basis, lon, lat, ctx.par);
    out[i] = db == null ? null : +db.toFixed(2);
  }
  return out;
}

// ===== 共极化分量判定 =====
//
// 【别按 icomp 硬判哪个分量是共极化】。实测三份真实 GRD（CS10R 300_X02G icomp=3、
// EIRP_OK1 icomp=2、to_Bj icomp=2），在各自波束峰值处都是 **P2 远强于 P1**：
//     300_X02G  10lg(P1)=21.94  10lg(P2)=52.87   → P1/P2 = −30.93 dB
//     EIRP_OK1  10lg(P1)=23.97  10lg(P2)=67.42   → P1/P2 = −43.45 dB
// 即这些文件里**第二个分量才是共极化**，与「icomp=3 时分量1=co、分量2=cx」的常见理解相反。
// 各家工具（TICRA / SATSOFT / 自研导出）写入顺序并不统一，硬按 icomp 判必然踩坑——
// 表现就是 XPD 取出来是个负数（曾把 −31.35 当成「取值不对」，其实是共极化认反了）。
//
// 稳妥判据只有一个：**波束峰值处占优的那个分量就是共极化**。这在物理上无可争议
// （峰值处交叉极化必远弱于共极化），且与文件怎么写、icomp 标几都无关。
function coPolIndexOf(beam) {
  if (beam._coPol === 1 || beam._coPol === 2) return beam._coPol;
  const n = beam.grid.NX * beam.grid.NY;
  let best = -1, bi = 0;
  for (let i = 0; i < n; i++) {
    const p1 = beam.c1re[i] * beam.c1re[i] + beam.c1im[i] * beam.c1im[i];
    const p2 = beam.c2re[i] * beam.c2re[i] + beam.c2im[i] * beam.c2im[i];
    const t = p1 + p2;
    if (t > best) { best = t; bi = i; }
  }
  const p1 = beam.c1re[bi] * beam.c1re[bi] + beam.c1im[bi] * beam.c1im[bi];
  const p2 = beam.c2re[bi] * beam.c2re[bi] + beam.c2im[bi] * beam.c2im[bi];
  try { Object.defineProperty(beam, '_coPol', { value: p2 > p1 ? 2 : 1, writable: true, enumerable: false }); }
  catch (e) { /* 冻结对象：不缓存也能用，只是每次重算 */ }
  return p2 > p1 ? 2 : 1;
}

/**
 * 逐点 XPD（dB）—— 共极化对交叉极化的功率比。
 *
 * 与「pol:'P1/P2' 走 sampleMax」的两处关键差别（那条路是错的，已弃用）：
 *   ① 共极化分量由峰值判定，不假设是 P1（见 coPolIndexOf）；
 *   ② 取**服务波束**（该点共极化最强的那个）的 XPD，而不是在各波束的比值里取最大——
 *      后者会挑出一个跟该点实际收哪个波束毫无关系的数。
 *
 * @returns {{xpdDb, servingIdx, coPolIndex, coPolDb, xPolDb}|null}
 *   点在域外 / 卫星不可见 / 交叉极化为 0 → null
 */
function sampleXpd(loaded, sat, cfg, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const ctx = makeSampleCtx(loaded, sat, cfg);
  if (!ctx) return null;
  return sampleXpdCtx(ctx, lon, lat);
}

function sampleXpdCtx(ctx, lon, lat) {
  let best = null;
  for (let i = 0; i < ctx.beams.length; i++) {
    const bm = ctx.beams[i];
    const ci = coPolIndexOf(bm);
    const co = sampleBeamAt(bm, ctx.igrid, ctx.basis, lon, lat, { ...ctx.par, pol: ci === 2 ? 'P2' : 'P1' });
    if (co == null) continue;
    if (!best || co > best.coPolDb) {
      const cx = sampleBeamAt(bm, ctx.igrid, ctx.basis, lon, lat, { ...ctx.par, pol: ci === 2 ? 'P1' : 'P2' });
      best = { servingIdx: ctx.beamIdx[i], coPolIndex: ci, coPolDb: co, xPolDb: cx };
    }
  }
  if (!best || best.xPolDb == null) return null;
  return { ...best, xpdDb: +(best.coPolDb - best.xPolDb).toFixed(2) };
}

module.exports = {
  parseGrd, buildBin, loadBin,
  sampleMax, sampleAll, sampleXpd,
  makeSampleCtx, sampleMaxCtx, sampleAllCtx, sampleXpdCtx, coPolIndexOf, peakDb
};
