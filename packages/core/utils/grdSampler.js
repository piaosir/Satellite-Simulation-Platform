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
function sampleBeamAt(beam, igrid, basis, lon, lat, opt) {
  const pol = (opt && opt.pol) || 'RSS', gainOffset = (opt && opt.gainOffset) || 0, pathLoss = (opt && opt.pathLoss) || 'none';
  const hNadir = (opt && opt.hNadir) || H;
  const { S, x, y, z } = basis;
  const P = geodeticToEcef(lon, lat, 0);
  const ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2];
  const rs = Math.hypot(ex, ey, ez); if (!(rs > 0)) return null;
  const e = [ex / rs, ey / rs, ez / rs];
  const clat = Math.cos(lat * D2R), up = [clat * Math.cos(lon * D2R), clat * Math.sin(lon * D2R), Math.sin(lat * D2R)];
  if (dt(e, up) > 0) return null;                                  // 卫星在测站地平线下 → 不可见
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

// ===== GRASP .grd 文本解析（src/viz/grd/parse.js 同源）=====
function parseGrd(text) {
  const L = text.split(/\r\n|\n|\r/);
  let i = 0;
  while (i < L.length && !/^\+{4,}$/.test(L[i].trim())) i++;
  if (i >= L.length) throw new Error('未找到结束标记 ++++：可能非 GRASP 网格或二进制');
  i++;
  const ktype = parseInt(L[i++].trim());
  const head = L[i++].trim().split(/\s+/).map(Number);
  const nset = head[0], icomp = head[1], ncomp = head[2], igrid = head[3];
  for (let s = 0; s < nset; s++) i++;
  const sets = [];
  for (let s = 0; s < nset; s++) {
    const xline = L[i++].trim().split(/\s+/).map(Number);
    const XS = xline[0], YS = xline[1], XE = xline[2], YE = xline[3];
    const dline = L[i++].trim().split(/\s+/).map(Number);
    const NX = dline[0], NY = dline[1], KLIMIT = dline[2];
    const N = NX * NY;
    const c1re = new Float32Array(N), c1im = new Float32Array(N), c2re = new Float32Array(N), c2im = new Float32Array(N);
    for (let row = 0; row < NY; row++) {
      let cs = 0, ce = NX;
      if (KLIMIT === 1) { const p = L[i++].trim().split(/\s+/).map(Number); cs = p[0] - 1; ce = cs + p[1]; }
      for (let col = cs; col < ce; col++) {
        const r = L[i++].trim().split(/\s+/);
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

// 多波束最大 Parameter（绝对 dB）。口径同 grdParam.ensureAntenna + maxParamAt。域外/不可见返回 null。
function sampleMax(loaded, sat, cfg, lon, lat) {
  if (!loaded || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const c = cfg || {}, s = sat || {};
  const satLon = Number(s.lon), satLat = Number(s.lat) || 0, satAlt = Number.isFinite(s.alt) ? Number(s.alt) : H;
  if (!Number.isFinite(satLon)) return null;
  const basis = (c.boreType || 'azel') === 'azel'
    ? antennaBasisAzEl(satLon, satLat, satAlt, c.boreAz || 0, c.boreEl || 0, c.yaw || 0)
    : antennaBasis(satLon, c.boreLon == null ? satLon : c.boreLon, c.boreLat || 0, c.yaw || 0, satLat, satAlt);
  const par = { pol: c.pol || 'RSS', gainOffset: Number(c.gainOffset) || 0, pathLoss: c.pathLoss || 'none' };
  let best = null;
  for (const bm of loaded.beams) {
    const db = sampleBeamAt(bm, loaded.igrid, basis, lon, lat, par);
    if (db == null) continue;
    if (best == null || db > best) best = db;
  }
  return best == null ? null : +best.toFixed(2);
}

module.exports = { parseGrd, buildBin, loadBin, sampleMax };
