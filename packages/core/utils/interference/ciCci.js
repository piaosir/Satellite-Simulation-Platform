// 干扰分析 · C/CCI 同频复用干扰（多波束 / HTS）
//
// 多波束系统靠频率复用把同一段频谱用很多遍：把波束染成 N 种「颜色」，同色 = 同频同极化，
// 异色 = 换频或换极化。同色波束之间没有任何频率隔离，只能靠**方向图的空间隔离**——
// 于是某个用户点收到的干扰，就是所有同色旁瓣在他头顶叠加的结果：
//
//     C/CCI(点) = G_服务波束(点) − 10·lg( Σ_同色其他波束 10^(G_k(点)/10) )
//
// 这个数完全由方向图决定，算不出「典型值」——所以它必须走真实 GRD，不能像 C/ASI 那样
// 给个包络凑合。平台的 GRD 库正是为此存在。
//
// ─── 服务波束怎么定 ─────────────────────────────────────────────────────────
// 默认「取该点上增益最强的波束」——这是实际系统的波束选择逻辑，也与 grdSampler.sampleMax
// 的口径一致。用户也可以钉死某个波束（analyse 某一个波束的覆盖边缘时有用）。
//
// ─── 复用方案 ───────────────────────────────────────────────────────────────
// 3 / 4 / 7 / 8 / 9 / 12 / 16 色七种预设，按波束在 GRD 里的原始 set 下标轮着染（idx % N）——这是
// 没有布局信息时唯一中立的做法，用户可随时改成手工指派。
//
// 七档取的是【有效前沿】：同一个同色间距上只留最省频率的那一档，单极化与双极化各算各的 ——
//   单极化：3（1.73d，每波束 1/3 频段）· 7（2.65d，1/7）· 9（3.00d，1/9）
//   双极化：4（2.00d，2 频段×2 极化，每波束 1/2）· 8（2.65d，4×2，1/4）
//          12（3.46d，6×2，1/6）· 16（4.00d，8×2，1/8 —— 中星26 小波束那族，色 i 与色 i+8 同频段极化正交）
// ★ 3/4/7/9/12/16 是复用因子 N = i²+ij+j²，同色间距取得到理论上界 √N·d；8 不是（最远 √7·d，
//   与七色同距），但同样间距下它只切 4 段频率、每波束带宽近乎七色的两倍，故双极化系统用它。
//   10 同为 2.65d 却要切 5 段频率，被 8 支配，不列。
//
// ⚠️ 轮转染色只是缺省，不保证同色波束在**空间上**分散。真实系统的着色由波束布局决定，
//    做正经分析请手工指派或从系统设计文件导入——UI 上须标明缺省着色的这一局限。
//    （波束合成模块的「频率计划 · 自动分配」按复用距离 √N·d 着色，那份结果才是有几何依据的。）

const LOG10 = Math.log10;
const lin = (db) => Math.pow(10, db / 10);

const REUSE_PRESETS = [3, 4, 7, 8, 9, 12, 16];

/**
 * 生成缺省复用着色。
 * @param {number[]} beamIdx  各波束在原始 GRD set 顺序里的下标
 * @param {number} colors     复用色数（3 / 4 / 7）
 * @returns {Object<number,number>} 原始下标 → 颜色号(0..colors-1)
 */
function defaultColoring(beamIdx, colors) {
  const n = Math.max(1, Math.round(Number(colors) || 4));
  const map = {};
  (beamIdx || []).forEach((orig, i) => { map[orig] = i % n; });
  return map;
}

/**
 * 单点 C/CCI。
 *
 * @param {number[]} values    逐波束增益 dB（与 beamIdx 同序，null = 该波束在此点无值）
 * @param {number[]} beamIdx   各值对应的原始 GRD set 下标
 * @param {object} o
 *   coloring      {原始下标: 颜色号}，缺省用 defaultColoring
 *   colors        色数（生成缺省着色用）
 *   servingIdx    钉死服务波束的原始下标；不给则取该点最强
 *   floorDb       低于「峰值 − floorDb」的干扰波束忽略（默认 60，纯为省算力，不影响量级）
 *
 * @returns {{cciDb, servingIdx, servingGainDb, colorId, interferers:[…], coChannelCount}|null}
 *   点上无任何波束有值 → null（域外/不可见），UI 应留空而不是涂 0
 */
function cciAtPoint(values, beamIdx, o) {
  const opt = o || {};
  if (!Array.isArray(values) || !values.length) return null;
  const idx = Array.isArray(beamIdx) && beamIdx.length === values.length
    ? beamIdx : values.map((_, i) => i);
  const coloring = opt.coloring || defaultColoring(idx, opt.colors || 4);

  // 服务波束
  let sPos = -1;
  if (opt.servingIdx != null) {
    sPos = idx.indexOf(Number(opt.servingIdx));
    if (sPos < 0 || values[sPos] == null) return null;      // 钉死的波束在此点无值
  } else {
    for (let i = 0; i < values.length; i++) {
      if (values[i] == null) continue;
      if (sPos < 0 || values[i] > values[sPos]) sPos = i;
    }
    if (sPos < 0) return null;
  }
  const servingGain = values[sPos];
  const servingIdx = idx[sPos];
  const colorId = coloring[servingIdx];

  // 同色其他波束线性求和
  const floorDb = Number.isFinite(Number(opt.floorDb)) ? Number(opt.floorDb) : 60;
  let sum = 0, n = 0;
  const interferers = [];
  for (let i = 0; i < values.length; i++) {
    if (i === sPos || values[i] == null) continue;
    if (coloring[idx[i]] !== colorId) continue;             // 异色 → 有频率/极化隔离，不算同频干扰
    if (values[i] < servingGain - floorDb) continue;        // 低到无关紧要
    sum += lin(values[i]);
    n++;
    interferers.push({ beamIdx: idx[i], gainDb: values[i] });
  }
  if (!(sum > 0)) {
    // 同色里没有别的波束 → 无同频干扰。给 null 而不是 Infinity：UI 要能区分「没有干扰」
    // 和「算不出来」，前者标「无同色波束」，后者留空。
    return { cciDb: null, servingIdx, servingGainDb: servingGain, colorId, interferers: [], coChannelCount: 0, noCoChannel: true };
  }
  const iDb = 10 * LOG10(sum);
  interferers.sort((a, b) => b.gainDb - a.gainDb);
  for (const it of interferers) it.sharePct = (lin(it.gainDb) / sum) * 100;
  return {
    cciDb: servingGain - iDb,
    servingIdx, servingGainDb: servingGain, colorId,
    aggregateInterfGainDb: iDb,
    interferers, coChannelCount: n, noCoChannel: false
  };
}

/**
 * 一批点的 C/CCI。
 *
 * 【务必在主进程调用】：一张场图是几千格 × 几十波束，逐波束值搬过 IPC 会撑爆消息体
 * （5000 格 × 40 波束 = 20 万个数）。本函数在算完当场把逐波束折成一个数，
 * 只回长度 = 点数的数组。见 electron/services/grd.js 的 sampleCci。
 *
 * @param {object} sampler   { sampleAllCtx, makeSampleCtx } —— 注入以避免 core 反向依赖
 * @param {object} loaded    grdSampler.loadBin 的结果
 * @param {Array<{lon,lat}>} points
 * @returns {{cci:(number|null)[], serving:(number|null)[], coloring:object, colors:number}}
 */
function cciOverPoints(sampler, loaded, sat, cfg, points, o) {
  const opt = o || {};
  const pts = Array.isArray(points) ? points : [];
  const ctx = sampler.makeSampleCtx(loaded, sat, cfg);
  if (!ctx) return { cci: pts.map(() => null), serving: pts.map(() => null), coloring: {}, colors: opt.colors || 4 };
  const colors = Math.max(1, Math.round(Number(opt.colors) || 4));
  const coloring = opt.coloring || defaultColoring(ctx.beamIdx, colors);
  const cci = new Array(pts.length), serving = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] || {};
    const vals = sampler.sampleAllCtx(ctx, Number(p.lon), Number(p.lat));
    const r = cciAtPoint(vals, ctx.beamIdx, { ...opt, coloring, colors });
    cci[i] = r ? r.cciDb : null;
    serving[i] = r ? r.servingIdx : null;
  }
  return { cci, serving, coloring, colors, beamIdx: ctx.beamIdx.slice() };
}

module.exports = { cciAtPoint, cciOverPoints, defaultColoring, REUSE_PRESETS };
