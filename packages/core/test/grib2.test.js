// GRIB2 最小解码器测试（无框架，纯断言）。
// 运行： node packages/core/test/grib2.test.js
//
// ★ 全部离线：报文在测试里**现合成**，不下载。理由有二 ——
//   ① npm test 不许依赖网络；
//   ② 真实报文只能验「解出来的数看着合理」，合成报文能验「解出来的数逐位等于放进去的数」，
//      而扫描模式翻行这类错误恰恰只有后者抓得住（上下颠倒的降水场看着依然像张正常天气图）。
//
// 与真实数据的配准另有一道验证：scripts 侧的实测已用地形高度当标尺核对过
// （那曲 4604 m / 珠峰附近 5918 m / 石家庄 75 m / 东海 0 m），这里只钉住不变量。

const G = require('../utils/grib2.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// ─────────────────────────────────────────────────────────────────────────
// GRIB2 合成器：只造本解码器支持的那一档（Grid 3.0 + DRS 5.0 + 无位图）
// ─────────────────────────────────────────────────────────────────────────
function wU32(b, p, v) { b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255; b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255; }
function wU16(b, p, v) { b[p] = (v >>> 8) & 255; b[p + 1] = v & 255; }
/** 符号—幅值 32 位（GRIB2 的经纬度就是这么存的，不是补码） */
function wSM32(b, p, v) { const m = Math.abs(v) >>> 0; wU32(b, p, v < 0 ? (m | 0x80000000) >>> 0 : m); }
function wSM16(b, p, v) { const m = Math.abs(v) & 0x7fff; wU16(b, p, v < 0 ? (m | 0x8000) : m); }
function wF32(b, p, v) {
  const f = new Float32Array(1); f[0] = v;
  const u = new Uint8Array(f.buffer);
  // 合成端按大端写；Node 在 x86 上是小端，故逐字节倒序
  b[p] = u[3]; b[p + 1] = u[2]; b[p + 2] = u[1]; b[p + 3] = u[0];
}

/**
 * @param o { ni, nj, lat1, lon1, di, dj, scan, bits, R, E, D, ints:[…], cat, param, surfType, fcstH, disc }
 *   ints 是**打包后的整数**（按扫描顺序），值 = (R + X·2^E)·10^−D
 */
function buildGrib(o) {
  const ni = o.ni, nj = o.nj, n = ni * nj, bits = o.bits;
  const s3 = 72, s4 = 34, s5 = 21, s6 = 6;
  const s7 = 5 + Math.ceil(n * bits / 8);
  const tot = 16 + s3 + s4 + s5 + s6 + s7 + 4;
  const b = Buffer.alloc(tot);

  // §0
  b.write('GRIB', 0, 'latin1'); b[6] = o.disc || 0; b[7] = 2;
  wU32(b, 8, 0); wU32(b, 12, tot);
  let p = 16;

  // §3 网格定义（模板 3.0）
  wU32(b, p, s3); b[p + 4] = 3; b[p + 5] = 0;
  wU32(b, p + 6, n); b[p + 10] = 0; b[p + 11] = 0; wU16(b, p + 12, 0);
  b[p + 14] = 6;                                              // 地球形状
  wU32(b, p + 30, ni); wU32(b, p + 34, nj);
  wSM32(b, p + 46, Math.round(o.lat1 * 1e6)); wU32(b, p + 50, Math.round(o.lon1 * 1e6));
  wSM32(b, p + 55, Math.round((o.lat1 + (o.scan & 0x40 ? 1 : -1) * (nj - 1) * o.dj) * 1e6));
  wU32(b, p + 59, Math.round((o.lon1 + (ni - 1) * o.di) * 1e6));
  wU32(b, p + 63, Math.round(o.di * 1e6)); wU32(b, p + 67, Math.round(o.dj * 1e6));
  b[p + 71] = o.scan;
  p += s3;

  // §4 产品定义（模板 4.0）
  wU32(b, p, s4); b[p + 4] = 4; wU16(b, p + 5, 0); wU16(b, p + 7, 0);
  b[p + 9] = o.cat; b[p + 10] = o.param;
  b[p + 17] = 1;                                              // 时间单位 = 小时
  wU32(b, p + 18, o.fcstH || 0);
  b[p + 22] = o.surfType == null ? 1 : o.surfType;
  b[p + 23] = 0; wU32(b, p + 24, 0);
  p += s4;

  // §5 数据表示（模板 5.0 简单打包）
  wU32(b, p, s5); b[p + 4] = 5; wU32(b, p + 5, n); wU16(b, p + 9, 0);
  wF32(b, p + 11, o.R); wSM16(b, p + 15, o.E); wSM16(b, p + 17, o.D); b[p + 19] = bits; b[p + 20] = 0;
  p += s5;

  // §6 位图（255 = 无）
  wU32(b, p, s6); b[p + 4] = 6; b[p + 5] = 255;
  p += s6;

  // §7 数据：定长位串
  wU32(b, p, s7); b[p + 4] = 7;
  let bitPos = 0; const base = p + 5;
  for (let i = 0; i < n; i++) {
    let need = bits, x = o.ints[i] >>> 0;
    while (need > 0) {
      const avail = 8 - (bitPos & 7);
      const take = Math.min(avail, need);
      const chunk = (x >>> (need - take)) & ((1 << take) - 1);
      b[base + (bitPos >> 3)] |= chunk << (avail - take);
      bitPos += take; need -= take;
    }
  }
  p += s7;
  b.write('7777', p, 'latin1');
  return b;
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n【1】简单打包解包：值 = (R + X·2^E)·10^−D 逐位复现');
{
  // 3×2 网格，bits=12，R=0，E=0，D=1 → 值 = X/10
  const ints = [1, 25, 400, 4095, 0, 137];
  const b = buildGrib({ ni: 3, nj: 2, lat1: 40, lon1: 100, di: 0.25, dj: 0.25, scan: 0, bits: 12, R: 0, E: 0, D: 1, ints, cat: 1, param: 7, fcstH: 3 });
  const r = G.decode(G.messages(b).next().value);
  ok('网格尺寸 3×2', r.ni === 3 && r.nj === 2);
  ok('参数号 cat=1 param=7', r.cat === 1 && r.param === 7);
  ok('预报时效 3 h → 10800 s', r.forecastSec === 10800);
  const want = ints.map((x) => x / 10);
  ok('六个值逐位相等', want.every((v, i) => near(r.values[i], v, 1e-6)), Array.from(r.values).join(','));
}

console.log('\n【2】R / E / D 三个标度都真的参与运算');
{
  // R=2.5, E=3 (×8), D=2 (÷100) → 值 = (2.5 + X·8)/100
  const ints = [0, 1, 100];
  const b = buildGrib({ ni: 3, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 10, R: 2.5, E: 3, D: 2, ints, cat: 0, param: 0 });
  const r = G.decode(G.messages(b).next().value);
  const want = ints.map((x) => (2.5 + x * 8) / 100);
  ok('(R + X·2^E)·10^−D', want.every((v, i) => near(r.values[i], v, 1e-6)), Array.from(r.values).join(','));
}
{
  // 负的 E / D 走符号—幅值，补码解法在这里会炸成天文数字
  const b = buildGrib({ ni: 2, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 8, R: 0, E: -2, D: -1, ints: [4, 8], cat: 0, param: 0 });
  const r = G.decode(G.messages(b).next().value);
  ok('E=−2, D=−1 → X/4×10', near(r.values[0], 10, 1e-6) && near(r.values[1], 20, 1e-6), Array.from(r.values).join(','));
}

console.log('\n【3】扫描模式归一化：出口一律「第 0 行 = 北、行内西→东」');
{
  // 2 行 3 列，内容按「北行 = 0,1,2 / 南行 = 10,11,12」
  const north = [0, 1, 2], south = [10, 11, 12];
  const mk = (scan, ints, lat1) => {
    const b = buildGrib({ ni: 3, nj: 2, lat1, lon1: 100, di: 1, dj: 1, scan, bits: 8, R: 0, E: 0, D: 0, ints, cat: 0, param: 0 });
    return G.decode(G.messages(b).next().value);
  };
  // scan 0x00：北→南、西→东。源序 = 北行在前
  ok('0x00 北→南西→东', mk(0x00, [...north, ...south], 40).values.join(',') === '0,1,2,10,11,12');
  // scan 0x40（GFS 实际用的）：南→北。源序 = 南行在前，出口必须翻回来
  ok('0x40 南→北（GFS）翻行', mk(0x40, [...south, ...north], 39).values.join(',') === '0,1,2,10,11,12');
  // scan 0x80：东→西，每行内要倒序
  ok('0x80 东→西翻列', mk(0x80, [2, 1, 0, 12, 11, 10], 40).values.join(',') === '0,1,2,10,11,12');
  // scan 0x20：列优先（相邻点沿 j 连续）
  ok('0x20 列优先转行优先', mk(0x20, [0, 10, 1, 11, 2, 12], 40).values.join(',') === '0,1,2,10,11,12');
  // scan 0x40 时 lat1 是南边界，出口的 lat1 必须是北边界
  const r = mk(0x40, [...south, ...north], 39);
  ok('0x40 出口 lat1=北边界 40', near(r.lat1, 40, 1e-6) && near(r.lat2, 39, 1e-6), r.lat1 + '/' + r.lat2);
}

console.log('\n【4】南半球 / 西半球：符号—幅值经纬度 + 0..360 归一');
{
  const b = buildGrib({ ni: 2, nj: 2, lat1: -20, lon1: 280, di: 0.5, dj: 0.5, scan: 0x40, bits: 8, R: 0, E: 0, D: 0, ints: [1, 2, 3, 4], cat: 0, param: 0 });
  const r = G.decode(G.messages(b).next().value);
  ok('南纬 −20 → 北边界 −19.5', near(r.lat1, -19.5, 1e-6) && near(r.lat2, -20, 1e-6), r.lat1 + '/' + r.lat2);
  ok('经度 280 → −80', near(r.lon1, -80, 1e-6), String(r.lon1));
}
{
  // 补码解法在这里会得到 −2147483628，用它算行号会把整张图索引到界外
  const raw = Buffer.alloc(4); raw[0] = 0x80; raw[1] = 0x00; raw[2] = 0x00; raw[3] = 0x14;
  ok('sm32(0x80000014) = −20 而非 −2147483628', G.sm32(raw, 0) === -20, String(G.sm32(raw, 0)));
}

console.log('\n【5】多报文串接：一次请求返回的是若干条首尾相接的报文');
{
  const a = buildGrib({ ni: 2, nj: 1, lat1: 10, lon1: 100, di: 1, dj: 1, scan: 0, bits: 8, R: 0, E: 0, D: 0, ints: [1, 2], cat: 0, param: 0, fcstH: 3 });
  const c = buildGrib({ ni: 2, nj: 1, lat1: 10, lon1: 100, di: 1, dj: 1, scan: 0, bits: 8, R: 0, E: 0, D: 0, ints: [7, 8], cat: 1, param: 7, fcstH: 6 });
  const all = G.decodeAll(Buffer.concat([a, c]));
  ok('两条都解出来', all.length === 2, String(all.length));
  ok('各自的参数号与时效不串', all[0].cat === 0 && all[0].forecastSec === 10800 && all[1].cat === 1 && all[1].forecastSec === 21600);
  ok('各自的值不串', all[0].values.join(',') === '1,2' && all[1].values.join(',') === '7,8');
}

console.log('\n【6】不支持的模板必须显式抛错（不许静默返回垃圾数组）');
{
  const b = buildGrib({ ni: 2, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 8, R: 0, E: 0, D: 0, ints: [1, 2], cat: 0, param: 0 });
  // 把 §5 的模板号改成 5.3（复杂打包 + 空间差分）
  const p5 = 16 + 72 + 34;
  b[p5 + 9] = 0; b[p5 + 10] = 3;
  let threw = '';
  try { G.decode(G.messages(b).next().value); } catch (e) { threw = e.message; }
  ok('DRS 5.3 抛错且报出模板号', /5\.3/.test(threw), threw || '（没抛）');
}
{
  const b = buildGrib({ ni: 2, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 8, R: 0, E: 0, D: 0, ints: [1, 2], cat: 0, param: 0 });
  b[16 + 12] = 0; b[16 + 13] = 30;                            // §3 模板号 → 3.30（兰勃特）
  let threw = '';
  try { G.decode(G.messages(b).next().value); } catch (e) { threw = e.message; }
  ok('网格 3.30 抛错', /3\.30/.test(threw), threw || '（没抛）');
}
{
  const b = buildGrib({ ni: 2, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0x10, bits: 8, R: 0, E: 0, D: 0, ints: [1, 2], cat: 0, param: 0 });
  let threw = '';
  try { G.decode(G.messages(b).next().value); } catch (e) { threw = e.message; }
  ok('蛇形扫描抛错', /蛇形/.test(threw), threw || '（没抛）');
}
{
  // decodeAll 遇到解不动的那条要跳过并回调，不能整批崩掉
  const good = buildGrib({ ni: 2, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 8, R: 0, E: 0, D: 0, ints: [5, 6], cat: 0, param: 0 });
  const bad = buildGrib({ ni: 2, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 8, R: 0, E: 0, D: 0, ints: [1, 2], cat: 0, param: 0 });
  bad[16 + 72 + 34 + 10] = 3;                                 // 坏掉第二条的 DRS 模板号
  const errs = [];
  const all = G.decodeAll(Buffer.concat([good, bad]), (e) => errs.push(e.message));
  ok('坏报文跳过、好报文照出', all.length === 1 && all[0].values.join(',') === '5,6' && errs.length === 1);
}

console.log('\n【7】位宽边界：bits=0（常数场）与跨字节的奇数位宽');
{
  const b = buildGrib({ ni: 4, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 0, R: 7.5, E: 0, D: 0, ints: [0, 0, 0, 0], cat: 0, param: 0 });
  const r = G.decode(G.messages(b).next().value);
  ok('bits=0 → 全场等于 R', Array.from(r.values).every((v) => near(v, 7.5, 1e-6)), Array.from(r.values).join(','));
}
{
  // 17 位跨三个字节，且 17 > 16 —— 快路径（32 位窗口）在这里最容易错一位
  const ints = [0, 1, 65535, 131071, 70000, 12345];
  const b = buildGrib({ ni: 6, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 17, R: 0, E: 0, D: 0, ints, cat: 0, param: 0 });
  const r = G.decode(G.messages(b).next().value);
  ok('bits=17 跨字节解包', ints.every((v, i) => near(r.values[i], v, 1e-6)), Array.from(r.values).join(','));
}
{
  // 27 位走慢路径（bits > 25），两条路径必须给出同一个答案
  const ints = [0, 134217727, 100000000, 7];
  const b = buildGrib({ ni: 4, nj: 1, lat1: 0, lon1: 0, di: 1, dj: 1, scan: 0, bits: 27, R: 0, E: 0, D: 0, ints, cat: 0, param: 0 });
  const r = G.decode(G.messages(b).next().value);
  ok('bits=27 慢路径解包', ints.every((v, i) => near(r.values[i], v, 1)), Array.from(r.values).join(','));
}

console.log('\n【8】Di/Dj 缺失时由端点反推（GFS 偶有不填）');
{
  const b = buildGrib({ ni: 5, nj: 3, lat1: 40, lon1: 100, di: 0.25, dj: 0.25, scan: 0, bits: 8, R: 0, E: 0, D: 0, ints: new Array(15).fill(0), cat: 0, param: 0 });
  const p3 = 16;
  wU32(b, p3 + 63, 0xffffffff); wU32(b, p3 + 67, 0xffffffff);
  const r = G.decode(G.messages(b).next().value);
  ok('di 由 (lon2−lon1)/(ni−1) 反推 = 0.25', near(r.di, 0.25, 1e-9), String(r.di));
  ok('dj 由 (lat1−lat2)/(nj−1) 反推 = 0.25', near(r.dj, 0.25, 1e-9), String(r.dj));
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
