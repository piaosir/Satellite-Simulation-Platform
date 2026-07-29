// PFD Mask · RR Article 22 限值表与「天花板」反演（Approach 2）
//
// 这个模块回答生成器原本答不了的问题：**我这份 mask 是紧还是松，离限值还有多少 dB。**
// 它不需要 EPFD 仿真器——纯一维计算，却直接服务于「mask 顶到刚好通过」这个真实目标。
//
// ─────────────────────────────────────────────────────────────────────────────
// 推导：epfd 的定义（RR 22.5C）把受扰站天线的鉴别度并进来
//
//     epfd = 10lg Σ 10^( (P_i + G_t(θ_i) − 10lg(4πd_i²) + G_r(φ_i) − G_r,max) / 10 )
//              ╰──────────── pfd_i ────────────╯   ╰──── 鉴别度 ────╯
//
// 单入、单源退化后：epfd = pfd + G_r(φ) − G_r,max，于是
//
//     PFD_allow(φ) = epfd_limit − [ G_r(φ) − G_r,max ] = epfd_limit + G_r,max − G_r(φ)
//
// ⚠ 这是 **Approach 2（反演）**，ITU 推荐的正路是 Approach 1（实算 epfd）。
//   本模块产出**参考线**，不是合规结论：假设单入单源、忽略时间统计与多星聚合。
//   用途是「排序与方向判断」，不是「判定通过」。
//
// ─────────────────────────────────────────────────────────────────────────────
// 限值表数据：**已内置** art22Limits.json（7 张表 214 个数据点）。
//   提取法：pdfplumber 词级坐标抽取（列 x 坐标硬约束 + 同基线配对），
//   并以 **2020 与 2024 两版独立排版的官方 RR PDF 逐点比对，214/214 完全一致**，
//   另做 41 条曲线单调性自检（违例 0 处）。
//   RR 每四年改版，故 loadLimitTables() 外部注入通道保留，用户可自行换表。
//
// ★ 数据里有「竖直段」——同一 percentTime 对应两个不同 epfd（如 22-1A/1.2m 的 99.997）。
//   这是 RR 原表的真实结构，不是抽取错误。**任何排序/去重都会毁掉它**，故本模块只校验
//   percentTime 非递减，绝不重排。
// ─────────────────────────────────────────────────────────────────────────────

const patterns = require('../interference/patterns.js');

/** 录入模板：一份限值表的结构。 */
const LIMIT_TABLE_TEMPLATE = Object.freeze({
  tableId: '22-1A',
  direction: 'down',                  // 'down' | 'up' | 'is'
  bands: [{ lowGhz: 10.7, highGhz: 11.7, regions: [1, 2, 3] }],
  refBwKhz: 40,
  refPattern: 'S.1428-1',
  entries: [{
    antennaDiameterM: 0.6,            // null ⇒ 受扰参考不是口径而是 GSO 空间站波束宽度（见 antennaBeamwidthDeg）
    points: [{ percentTime: 0, epfdDb: -175.4 }],
  }],
});

let TABLES = [];
let META = null;

/**
 * 注入限值表。
 * ★ 不排序、不去重 —— 竖直段依赖原始顺序。只校验 percentTime 非递减。
 */
function loadLimitTables(tables, meta) {
  const problems = [];
  const out = [];
  for (const t of (tables || [])) {
    if (!t || !t.tableId) { problems.push('缺 tableId 的表被跳过'); continue; }
    if (!Array.isArray(t.bands) || !t.bands.length) { problems.push(`${t.tableId}: 缺 bands`); continue; }
    if (!(Number(t.refBwKhz) > 0)) { problems.push(`${t.tableId}: refBwKhz 非法`); continue; }
    const entries = [];
    for (const e of (t.entries || [])) {
      const pts = (e.points || []).filter((q) => Number.isFinite(Number(q.epfdDb)) && Number.isFinite(Number(q.percentTime)));
      if (!pts.length) { problems.push(`${t.tableId}: 某 entry 无有效数据点`); continue; }
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].percentTime < pts[i - 1].percentTime) {
          problems.push(`${t.tableId}: percentTime 非升序（index ${i}），已按原序保留但请核对`);
          break;
        }
      }
      entries.push(Object.assign({}, e, { points: pts }));
    }
    if (!entries.length) { problems.push(`${t.tableId}: 无有效 entries`); continue; }
    out.push(Object.assign({}, t, { entries }));
  }
  TABLES = out;
  if (meta !== undefined) META = meta;
  return { ok: out.length > 0, count: out.length, problems };
}

// 内置表自加载。缺文件也不报错——外部注入通道仍在。
try {
  const bundled = require('./art22Limits.json');
  loadLimitTables(bundled.tables, bundled.meta);
} catch (e) { /* 无内置表则留空 */ }

function hasLimitTables() { return TABLES.length > 0; }
function clearLimitTables() { TABLES = []; META = null; }
function limitTablesMeta() { return META; }

/** 按频段查适用的限值表。一个频段可能命中多张表 / 多个参考带宽，全部返回。 */
function tablesForBand(lowGhz, highGhz, direction) {
  const lo = Number(lowGhz), hi = Number(highGhz);
  return TABLES.filter((t) => {
    if (direction && t.direction && t.direction !== direction) return false;
    return (t.bands || []).some((b) => Number(b.lowGhz) < hi && Number(b.highGhz) > lo);
  });
}

/**
 * 由频段反查该用哪个参考带宽（kHz）。
 * ★ refbw 不是可自选的输入——由 Art.22 对该频段的规定决定。
 * ★ RR No.22.5C.7：命中两个参考带宽时【两个都要满足】，故返回数组而非单值。
 */
function refBwForBand(lowGhz, highGhz, direction) {
  if (!hasLimitTables()) return { ok: false, refBwKhz: null, tableIds: [], reason: 'Art.22 限值表未录入' };
  const ts = tablesForBand(lowGhz, highGhz, direction);
  if (!ts.length) {
    return { ok: false, refBwKhz: null, tableIds: [], reason: `频段 ${lowGhz}~${highGhz} GHz 未命中任何限值表` };
  }
  const bws = Array.from(new Set(ts.map((t) => Number(t.refBwKhz)))).sort((a, b) => a - b);
  return { ok: true, refBwKhz: bws, tableIds: Array.from(new Set(ts.map((t) => t.tableId))) };
}

/**
 * 在一条 CDF 曲线上取给定时间百分比的限值。
 *
 * ★ RR No.22.5C.5：曲线是 **epfd 轴线性(dB) × 时间百分比轴对数**、数据点间直线相连。
 *   不能直接 log10(percentTime)（表里有 percentTime = 0），正确的对数轴是
 *   **超越百分比 (100 − percentTime)**。
 *
 * ⚠ 诚实边界：S.1503-2 §D.7.1.2–7.1.4 的 BR 判决【只在表列点上逐点比较】，
 *   外加 100% 时间点单独比最大值，**不做插值**。本函数的插值只服务于本平台的
 *   「天花板参考线」，不是 BR 口径。
 */
function limitAtPercent(points, percentTime) {
  const x = Number(percentTime);
  const n = points.length;
  if (x <= points[0].percentTime) return points[0].epfdDb;
  if (x >= points[n - 1].percentTime) {
    // 竖直段：同 percentTime 有多个 epfd 时，命中端点取更严（更低）的那一支
    let v = points[n - 1].epfdDb;
    for (let i = n - 1; i >= 0 && points[i].percentTime === points[n - 1].percentTime; i--) {
      v = Math.min(v, points[i].epfdDb);
    }
    return v;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].percentTime <= x) lo = m; else hi = m; }
  const EPS = 1e-12;                       // 100% 处的对数轴下限保护
  const u = (p) => Math.log10(Math.max(100 - p, EPS));
  const a = u(points[lo].percentTime), b = u(points[hi].percentTime);
  const t = (a - b) !== 0 ? (a - u(x)) / (a - b) : 0;
  return points[lo].epfdDb * (1 - t) + points[hi].epfdDb * t;
}

/**
 * RR No.22.5C.4（22-1A，所有 >60 cm 口径）与 No.22.5C.8（22-1D，180/240/300 cm BSS）
 * 的 100% 时间纬度附加限值 —— 同一条三段规则。
 * @returns {number|null} dB(W/(m²·40 kHz))，无规则时 null
 */
function additionalLatitudeLimitDb(latDeg) {
  const cfg = META && META.additionalLatitudeLimit;
  if (!cfg || !Array.isArray(cfg.rule)) return null;
  const a = Math.abs(Number(latDeg));
  for (const seg of cfg.rule) {
    const okLo = seg.lowExclusive ? a > seg.latDegLow : a >= seg.latDegLow;
    const okHi = seg.highInclusive === false ? a < seg.latDegHigh : a <= seg.latDegHigh;
    if (!(okLo && okHi)) continue;
    if (Number.isFinite(seg.epfdDb)) return seg.epfdDb;
    if (seg.formula) {
      // 中段公式：−160 + 3.4 × (57.5 − |Lat|) / 4（RR No.22.5C.4 / No.22.5C.8）
      // ★ 不对 JSON 里的 formula 字符串求值（不 eval）：RR 里这条公式只有一条，
      //   硬编码常数、用 JSON 的段边界做门控。两端连续性由单测钉住
      //   （57.5° → −160；63.75° → −165.3125，RR 表列 −165.3）。
      return -160 + 3.4 * (seg.latDegLow - a) / 4;
    }
  }
  // RR 原文写作「0 < |Lat| ≤ 57.5」，赤道恰落在开区间之外 —— 这是原文的边界写法，
  // 不是本实现的遗漏。按其显然意图归入第一段，并由调用方在报告里注明。
  if (a === 0 && cfg.rule[0] && Number.isFinite(cfg.rule[0].epfdDb)) return cfg.rule[0].epfdDb;
  return null;
}

/**
 * 受扰 GSO 地球站的相对鉴别度 G_r(φ) − G_r,max（dB，≤0）。
 * 用 S.1428-1（RR 22.5C.6 为 epfd↓ 指定的参考图）。
 */
function relativeDiscriminationDb(phiDeg, diameterM, wavelengthM) {
  const r = patterns.offAxisS1428(diameterM, wavelengthM, phiDeg);
  if (!r) return null;                      // D/λ < 20 超出 S.1428 适用范围
  return r.gain - r.gmaxRef;
}

/**
 * Approach 2 天花板曲线。
 * ★ 按 refBwKhz 分桶返回 —— RR No.22.5C.7 要求命中的每个参考带宽都要满足，
 *   把 40 kHz 与 1 MHz 混在一起取最低点会系统性选错约束（17.3–18.6 / 19.7–20.2 GHz 必踩）。
 *
 * @returns {{ok:boolean, groups:Object, skipped:string[], reason?:string}}
 *          groups: { [refBwKhz]: [{tableId, antennaDiameterM, epfdLimitDb, points:[[phi, pfdAllow]]}] }
 */
function ceilingCurves(o) {
  if (!hasLimitTables()) return { ok: false, groups: {}, skipped: [], reason: 'Art.22 限值表未录入' };
  const dir = o.direction || 'down';
  const ts = tablesForBand(o.lowGhz, o.highGhz, dir);
  if (!ts.length) return { ok: false, groups: {}, skipped: [], reason: '该频段未命中限值表' };

  const pct = o.percentTime === undefined ? 100 : Number(o.percentTime);
  const lam = Number(o.wavelengthM);
  const step = Number(o.phiStepDeg) > 0 ? Number(o.phiStepDeg) : 0.5;
  const groups = {};
  const skipped = [];

  for (const t of ts) {
    for (const e of t.entries) {
      // 22-2 / 22-3 的受扰参考是 GSO 空间站波束宽度 + S.672-4，本版未实现 ⇒ 明确跳过而非硬算
      if (e.antennaDiameterM === null || e.antennaDiameterM === undefined) {
        skipped.push(`${t.tableId}：受扰参考为 GSO 空间站波束宽度`
          + (e.antennaBeamwidthDeg ? ` ${e.antennaBeamwidthDeg}°` : '')
          + ' + ITU-R S.672-4，本版未实现，该方向天花板不可用');
        continue;
      }
      const lim = limitAtPercent(e.points, pct);
      const pts = [];
      for (let phi = 0; phi <= 180; phi += step) {
        const rel = relativeDiscriminationDb(phi, e.antennaDiameterM, lam);
        if (rel === null) continue;
        pts.push([Math.round(phi * 100) / 100, Math.round((lim - rel) * 1000) / 1000]);
      }
      if (!pts.length) {
        skipped.push(`${t.tableId}/${e.antennaDiameterM}m：S.1428 不覆盖（D/λ < 20）`);
        continue;
      }
      const k = String(t.refBwKhz);
      (groups[k] = groups[k] || []).push({
        tableId: t.tableId, refBwKhz: Number(t.refBwKhz), refPattern: t.refPattern,
        antennaDiameterM: e.antennaDiameterM, percentTime: pct, epfdLimitDb: lim, points: pts,
      });
    }
  }
  const ok = Object.keys(groups).length > 0;
  return { ok, groups, skipped, reason: ok ? undefined : (skipped[0] || '无可用曲线') };
}

/**
 * mask 峰值离天花板还有多少 dB（正=还有空间，负=已越过参考线）。
 * ★ 按 refBwKhz 分桶：每个带宽各报一个，不跨带宽取最低点。
 *
 * ─── minPhiDeg：必须把 mask 自己挖的规避坑排除掉 ─────────────────────────────
 * 天花板 ceiling(φ) = epfd_limit + G_r,max − G_r(φ) 的最低点**恒在 φ = 0**（G_r 在轴向最大），
 * 于是无脑取全域最低点等于「headroom = epfd_limit − maskPeak」，整条曲线白算。
 *
 * 但 pfd_mask 已经把 α₀ 烘焙进去了（`maskAlpha0Deg`，UI 默认 20°）：α < α₀ 的格全是 −999。
 * 而受扰 GSO 站看自己那颗 GSO 星与看这颗 NGSO 星的夹角 φ，恒 ≥ 它看 GSO **弧**的 α，
 * 故 φ < α₀ ⇒ α < α₀ ⇒ 该方向根本不发射 —— 那一段天花板不绑定，绑定点在 φ = α₀。
 *
 * 不排除的后果不是小数：22-1A / D=1.2 m @ 11 GHz 时 G_r,max − G_r(20°) ≈ 44 dB，
 * headroom 会被低报四十几 dB，工具会报「超了 40 多 dB」而实际根本没超。
 *
 * 默认 0（= 不假设任何规避，最保守）。调用方生成 pfd_mask 时应把 maskAlpha0Deg 传进来。
 *
 * @param {number|Object} maskPeakDb 数值，或 {[refBwKhz]: peakDb} —— 不同带宽的 mask 峰值不同
 * @param {object} groups ceilingCurves() 的 groups
 * @param {object} [opt] {minPhiDeg=0} 低于此角的天花板不参与取最低点
 * @returns {Object} { [refBwKhz]: {headroomDb, bindingTableId, bindingDiameterM,
 *                                  bindingCeilingDb, bindingPhiDeg, minPhiDeg} }
 */
function headroomDb(maskPeakDb, groups, opt) {
  const out = {};
  if (!groups) return out;
  const minPhi = Math.max(0, Number((opt || {}).minPhiDeg) || 0);
  for (const k of Object.keys(groups)) {
    const peak = typeof maskPeakDb === 'object' && maskPeakDb !== null
      ? Number(maskPeakDb[k]) : Number(maskPeakDb);
    if (!Number.isFinite(peak)) continue;
    let worst = Infinity, which = null, atPhi = null;
    for (const c of groups[k]) {
      let lo = Infinity, loPhi = null;
      for (const [phi, v] of c.points) {
        if (phi < minPhi) continue;                 // 该角域 mask 已填「不发射」，天花板不绑定
        if (v < lo) { lo = v; loPhi = phi; }
      }
      if (lo < worst) { worst = lo; which = c; atPhi = loPhi; }
    }
    if (!Number.isFinite(worst)) continue;          // minPhiDeg 把整条曲线滤空了
    out[k] = {
      refBwKhz: Number(k),
      headroomDb: Math.round((worst - peak) * 1000) / 1000,
      bindingTableId: which.tableId,
      bindingDiameterM: which.antennaDiameterM,
      bindingCeilingDb: Math.round(worst * 1000) / 1000,
      bindingPhiDeg: atPhi,
      minPhiDeg: minPhi,
    };
  }
  return out;
}

module.exports = {
  LIMIT_TABLE_TEMPLATE,
  loadLimitTables, hasLimitTables, clearLimitTables, limitTablesMeta,
  tablesForBand, refBwForBand, limitAtPercent, additionalLatitudeLimitDb,
  relativeDiscriminationDb, ceilingCurves, headroomDb,
};
