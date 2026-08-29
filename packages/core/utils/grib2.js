// grib2.js — GRIB2 最小解码器（只覆盖 NCEP NOMADS 子集服务实际吐出的那一档）
//
// 为什么自己写而不是拿 npm 上的库：GRIB2 是个「一百种打包方式」的容器格式，通用库为了覆盖
// JPEG2000 / PNG / 复杂打包会拖进几 MB 的依赖，而 NOMADS 的 grib_filter 子集**只用三种模板**：
//   · 网格定义 3.0    等经纬（regular lat/lon）
//   · 数据表示 5.0    简单打包 —— 值 = (R + X·2^E)·10^−D，X 是定长无符号位串
//   · 位图    255     无位图（等经纬子集里每一格都有值）
// 三者都极简，合起来不到两百行。★ 遇到别的模板一律**显式抛错**，不猜、不静默返回垃圾数组 ——
// 气象场一旦解错，图上是一片看起来很合理的假雨区，比报错难查一个量级。
//
// ── 两个必须处理、错了就整张图翻转的细节 ──────────────────────────────────
//   ① 扫描模式（§3 第 72 字节）。GFS 用 0x40 = 「西→东、**南→北**、行优先」，即数据第 0 行是
//      最南那一行；而本平台的栅格约定是**第 0 行为北**（envField / liveField 全线如此）。
//      不翻行的话整张图上下颠倒 —— 而且颠倒后的降水场看着依然像个正常天气图，不会自己暴露。
//   ② 经纬度是**符号—幅值**编码，不是补码：负值把最高位置 1，其余位仍是绝对值。
//      readInt32BE 在北半球恰好对，一到南半球就成了 −2147483628 这种数。
//
// ── 经度域 ────────────────────────────────────────────────────────────────
// GFS 原生网格经度是 [0, 360)；本平台一律用 [−180, 180]。归一化放在出口做，
// 且**只动 lon1/lon2 两个标量，不动 values 的排列** —— 子集若跨了 0° 或 180°，
// 由调用方按 lon1 递增的顺序自行解释，本模块不做环绕拼接（NOMADS 也不跨接缝返回）。
//
// 纯 JS、无 IO、无 Node 专有 API（Buffer 只当 Uint8Array 用），可离线单测。

'use strict';

const SUPPORTED = { grid: 0, drs: 0 };

/** 符号—幅值解码：GRIB2 的经纬度/比例因子用最高位表示负号，不是补码 */
function sm32(b, p) {
  const raw = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  const mag = raw & 0x7fffffff;
  return (raw & 0x80000000) ? -mag : mag;
}
function sm16(b, p) {
  const raw = ((b[p] << 8) | b[p + 1]) & 0xffff;
  const mag = raw & 0x7fff;
  return (raw & 0x8000) ? -mag : mag;
}
function u32(b, p) { return (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0); }
function u16(b, p) { return ((b[p] << 8) | b[p + 1]) & 0xffff; }
function f32(b, p) {
  // IEEE-754 单精度。不用 DataView 是为了让入参可以是任意 Uint8Array 视图而无需关心 byteOffset。
  const bits = u32(b, p);
  const s = (bits >>> 31) ? -1 : 1;
  const e = (bits >>> 23) & 0xff;
  const m = bits & 0x7fffff;
  if (e === 0) return s * m * Math.pow(2, -149);
  if (e === 255) return m ? NaN : s * Infinity;
  return s * (m + 0x800000) * Math.pow(2, e - 150);
}

/**
 * 逐条枚举缓冲区里的 GRIB2 报文。
 * 一次 grib_filter 请求返回的是**多条报文首尾相接**（一个要素一条），故必须走这一层。
 * 报文头不一定紧贴前一条的尾（NOMADS 偶有填充），所以找不到 'GRIB' 时逐字节前移。
 */
function* messages(buf) {
  let off = 0;
  const n = buf.length;
  while (off + 16 <= n) {
    if (!(buf[off] === 0x47 && buf[off + 1] === 0x52 && buf[off + 2] === 0x49 && buf[off + 3] === 0x42)) { off++; continue; }
    if (buf[off + 7] !== 2) { off++; continue; }                 // 只认 GRIB2，GRIB1 直接跳过
    // 总长是 8 字节；实际远不到 2^53，故拆成高低 32 位读，避开 BigInt
    const tot = u32(buf, off + 8) * 4294967296 + u32(buf, off + 12);
    if (!(tot > 16) || off + tot > n) break;                      // 截断的尾巴：停，不猜
    yield { buf, off, tot, discipline: buf[off + 6] };
    off += tot;
  }
}

/** 位串解包：定长 bits 位无符号整数 × n 个。bits ≤ 25 走 32 位窗口快路径 */
function unpack(d, base, n, bits, out, R, sc, dsc) {
  if (bits === 0) { const v = R * dsc; for (let i = 0; i < n; i++) out[i] = v; return; }
  if (bits <= 25) {
    const mask = (1 << bits) - 1;
    let bitPos = 0;
    for (let i = 0; i < n; i++) {
      const q = base + (bitPos >> 3);
      // 越界读出 undefined → 位运算里当 0，正是尾部该有的行为
      const acc = ((d[q] << 24) | (d[q + 1] << 16) | (d[q + 2] << 8) | d[q + 3]) >>> 0;
      const x = (acc >>> (32 - bits - (bitPos & 7))) & mask;
      out[i] = (R + x * sc) * dsc;
      bitPos += bits;
    }
    return;
  }
  let bitPos = 0;
  for (let i = 0; i < n; i++) {
    let x = 0, need = bits;
    while (need > 0) {
      const avail = 8 - (bitPos & 7);
      const take = avail < need ? avail : need;
      x = x * (1 << take) + ((d[base + (bitPos >> 3)] >> (avail - take)) & ((1 << take) - 1));
      bitPos += take; need -= take;
    }
    out[i] = (R + x * sc) * dsc;
  }
}

/**
 * 解一条报文 → { discipline, cat, param, surfType, surfVal, prodTmpl, forecastSec,
 *                ni, nj, lat1, lat2, lon1, lon2, di, dj, values }
 * values 已按「第 0 行 = 北、行内西→东」重排。
 * @throws 模板不受支持 / 结构不自洽时抛错（含实际模板号，便于定位）
 */
function decode(m) {
  const b = m.buf;
  let p = m.off + 16;
  const end = m.off + m.tot - 4;
  const r = { discipline: m.discipline };
  let dataOff = -1;

  while (p < end) {
    const sl = u32(b, p), sn = b[p + 4];
    if (!(sl > 4)) throw new Error('GRIB2 节长非法（第 ' + sn + ' 节）');
    switch (sn) {
      case 3: {
        r.gridTmpl = u16(b, p + 12);
        if (r.gridTmpl !== SUPPORTED.grid) throw new Error('不支持的网格模板 3.' + r.gridTmpl + '（只支持 3.0 等经纬）');
        r.nPoints = u32(b, p + 6);
        r.ni = u32(b, p + 30); r.nj = u32(b, p + 34);
        r.lat1 = sm32(b, p + 46) / 1e6; r.lon1 = u32(b, p + 50) / 1e6;
        r.lat2 = sm32(b, p + 55) / 1e6; r.lon2 = u32(b, p + 59) / 1e6;
        r.di = u32(b, p + 63) / 1e6; r.dj = u32(b, p + 67) / 1e6;
        r.scan = b[p + 71];
        break;
      }
      case 4: {
        r.prodTmpl = u16(b, p + 7);
        r.cat = b[p + 9]; r.param = b[p + 10];
        // 时间单位码表 4.4：0=分 1=时 2=日 …。GFS 用 1（小时）
        const unit = b[p + 17], ft = u32(b, p + 18);
        r.forecastSec = ft * (unit === 0 ? 60 : unit === 1 ? 3600 : unit === 2 ? 86400 : unit === 13 ? 1 : 3600);
        r.surfType = b[p + 22];
        const sf = b[p + 23], sv = u32(b, p + 24);
        r.surfVal = (sf === 255 || sv === 0xffffffff) ? null : sv / Math.pow(10, sf > 127 ? -(sf - 128) : sf);
        break;
      }
      case 5: {
        r.drTmpl = u16(b, p + 9);
        if (r.drTmpl !== SUPPORTED.drs) throw new Error('不支持的数据表示模板 5.' + r.drTmpl + '（只支持 5.0 简单打包）');
        r.nValues = u32(b, p + 5);
        r.R = f32(b, p + 11); r.E = sm16(b, p + 15); r.D = sm16(b, p + 17); r.bits = b[p + 19];
        break;
      }
      case 6:
        r.bitmap = b[p + 5];
        if (r.bitmap !== 255) throw new Error('本解码器不处理位图（指示码 ' + r.bitmap + '）');
        break;
      case 7:
        dataOff = p + 5;
        break;
      default: break;                                            // 1/2 节（标识/本地）不需要
    }
    p += sl;
  }

  if (r.gridTmpl == null || r.drTmpl == null || dataOff < 0) throw new Error('GRIB2 报文缺节');
  const n = r.ni * r.nj;
  if (r.nValues !== n) throw new Error(`点数不符：网格 ${n}，数据 ${r.nValues}`);

  const raw = new Float32Array(n);
  unpack(b, dataOff, n, r.bits, raw, r.R, Math.pow(2, r.E), Math.pow(10, -r.D));

  // ---- 扫描模式归一化：目标是「第 0 行 = 北、行内西→东、行优先」----
  const iNeg = !!(r.scan & 0x80);        // bit1: i 方向负（东→西）
  const jPos = !!(r.scan & 0x40);        // bit2: j 方向正（南→北）
  const jFirst = !!(r.scan & 0x20);      // bit3: 相邻点沿 j 连续（列优先）
  const alt = !!(r.scan & 0x10);         // bit4: 隔行反向（蛇形）
  if (alt) throw new Error('不支持蛇形扫描（scanMode 0x' + r.scan.toString(16) + '）');

  let values = raw;
  if (iNeg || jPos || jFirst) {
    values = new Float32Array(n);
    const ni = r.ni, nj = r.nj;
    for (let jj = 0; jj < nj; jj++) {
      const srcJ = jPos ? (nj - 1 - jj) : jj;                    // jPos：源第 0 行在最南 → 目标第 0 行取源末行
      for (let ii = 0; ii < ni; ii++) {
        const srcI = iNeg ? (ni - 1 - ii) : ii;
        values[jj * ni + ii] = raw[jFirst ? (srcI * nj + srcJ) : (srcJ * ni + srcI)];
      }
    }
  }
  r.values = values;

  // 出口统一成「lat1 = 北边界、lat2 = 南边界」，与重排后的行序一致
  if (r.lat1 < r.lat2) { const t = r.lat1; r.lat1 = r.lat2; r.lat2 = t; }
  // 经度 [0,360) → [−180,180]
  if (r.lon1 > 180) r.lon1 -= 360;
  if (r.lon2 > 180) r.lon2 -= 360;
  // Di/Dj 缺失（0xFFFFFFFF/1e6）时由端点反推
  if (!(r.di > 0) || r.di > 1e3) r.di = r.ni > 1 ? Math.abs(r.lon2 - r.lon1) / (r.ni - 1) : 0;
  if (!(r.dj > 0) || r.dj > 1e3) r.dj = r.nj > 1 ? Math.abs(r.lat1 - r.lat2) / (r.nj - 1) : 0;

  return r;
}

/** 一个缓冲区里的全部报文，解不动的那条按 onError 处置（默认跳过并记下原因） */
function decodeAll(buf, onError) {
  const out = [];
  for (const m of messages(buf)) {
    try { out.push(decode(m)); }
    catch (e) { if (onError) onError(e, m); }
  }
  return out;
}

module.exports = { messages, decode, decodeAll, sm16, sm32, f32 };
