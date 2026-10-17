// 干扰分析 · HTS 多波束「复用方案」与同频耦合（C/CCI 的频率 / 极化 / 功率口径）
//
// ★ 2026-10-17 起 C/CCI 页只剩「目标波束」口径（cciTarget.js）；本文件不再有界面入口，留作参照实现：
//   目标波束引擎用这里的几何（gridDir / invGridDir / rayEarth …）与统计（statsOf），并与这里的二值耦合逐点对账（cciTarget.test ②）。
//
// ciCci.cciAtPoint 只认「颜色」：同色 = 完全同频同极化（权重 1），异色 = 完全隔离（权重 0）。
// 真实 HTS 这两条都不成立（中星26 实例见 docs 与记忆 hts-freq-plan-design）：
//   · 宽波束的色与窄波束的色在频率上重叠（19260~19700 的色1 与 19260~19467 的色1_1）——单一色数表达不了；
//   · 4 色双极化 = 2 频段 × 2 极化：异极化不是 0，而是漏过交叉极化那一截；
//   · 各波束功率（转发器 OBO）不同，同频干扰也跟着差。
// 故把复用方案落成「每个波束占哪几段频率、什么极化、功率偏置多少」，耦合系数按物理算：
//
//     w_jk = Σ_{a∈j, b∈k} P_b · overlap(a,b) · pol(a,b)  /  ( P_j · B_j )
//
//   B_j = 受扰波束 j 占的总带宽；P = 谱密度（线性；各段 dB 偏置 + 逐波束偏置 → 10^(x/10)）；
//   pol = 同极化 1 · 正交极化走交叉极化分量（GRD 逐点值，取不到才用规格 XPD）· 线 / 圆混用 1/2。
//   前向：C/I(点) = G_s / Σ_k w_sk · G_k              （P_s 已在 w 的分母里归一）
//   返向：C/I_s   = 1 / Σ_k w_sk · G_s(x_k) / G_k(x_k)  （功控到等接收谱密度；x_k = 干扰波束覆盖区内的终端位置）
// G 一律线性；正交那一项的 G_k 换成 G_k 的交叉极化分量（返向是受扰波束 s 的交叉极化分量）。
//
// 着色来源（优先级从高到低；「自动」取第一个有数据的，结果里写回实际用的那一个）：
//   ① freqPlan  频率计划：渲染端由 freqPlanModel 的波束占段推出逐波束段 + 极化（+ 转发器 OBO → 段功率偏置），
//               GRD 波束 ↔ 计划波束按号 / 按名自动匹配（渲染端那一半随 C/CCI「复用方案」页一并撤掉，2026-10-17）；
//   ② synth     波束合成色号：生成天线时写进 GRD 元数据的逐波束 fc（SYNTHMETA 行 / 解析记录，见 synthFcFromText）；
//   ③ excel     Excel 导入：逐波束色号 / 频段 / 极化表（中星26 那种）；
//   ④ manual    手工网格：逐波束色号（ciCci 的 coloringOverride）；
//   ⑤ rotation  轮转 idx % N —— 只作兜底：不保证同色波束在空间上分散，物理上没有依据。
// 只有色号、没有「色号 → 频段 × 极化」定义时退化成二值耦合（同色 1、异色 0），此时 fwdAtPoint 与
// cciAtPoint 逐位一致（htsCoupling.test.mjs 钉住）。
//
// 窗外（E-01 的消费侧）：某点上一个波束的采样为 null（该点落在它的 GRD 网格窗外），而同一点别的波束有值，
// 就取该波束网格自身的最小电平作地板计入，并计数（「窗外计入点数」）——不再静默当作 0 干扰丢掉。
// 全部波束都取不到值 = 卫星不可见 / 全在窗外，该点无值。
//
// 场图（createCciRun）：在 GRD 自身天线网格（各波束窗口的并集、取最细节距）或用户经纬网格上逐节点算；
// 分批推进（stepBatch），由主进程按帧调度、带进度与取消；另出逐波束统计（服务区内最小 = EOC 最差、5% 分位、中位）。
'use strict';

const ciCci = require('./ciCci.js');

const LOG10 = Math.log10;
const lin = (db) => Math.pow(10, db / 10);          // 与 ciCci 的 lin 同式（退化口径逐位一致依赖它）
const D2R = Math.PI / 180;
const MIX_FACTOR = 0.5;                             // 线 / 圆极化混用：极化失配恒 3 dB
const DEFAULT_XPD_DB = 25;
const DEFAULT_EOC_DB = 4;
const MAX_POINTS = 4000000;                         // 内存护栏（不是格数上限）：每点约 30 B 常驻

// ===== 极化 =====
function normPol(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s || s === '—' || s === '-') return '';
  if (s === 'H' || s === 'HOR' || s === 'HORIZONTAL' || s.includes('水平')) return 'H';
  if (s === 'V' || s === 'VER' || s === 'VERTICAL' || s.includes('垂直')) return 'V';
  if (s === 'R' || s === 'RHCP' || s === 'RHC' || s.includes('右旋')) return 'R';
  if (s === 'L' || s === 'LHCP' || s === 'LHC' || s.includes('左旋')) return 'L';
  return '';
}
const isLinear = (p) => p === 'H' || p === 'V';
/** 两极化的关系：'co' 同极化（含未知 —— 不知道就按最坏算）· 'x' 正交 · 'mix' 线 / 圆混用 */
function polRelation(a, b) {
  if (!a || !b || a === b) return 'co';
  if (isLinear(a) === isLinear(b)) return 'x';
  return 'mix';
}

// ===== 频段 =====
const numOr = (v, d) => { if (v === null || v === undefined || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
/** 段表归一：[{ f1, f2, pol, pDb }]（MHz，f2 > f1，按 f1 升序）；pol 缺省取 defPol */
function normSegs(list, defPol) {
  const out = [];
  for (const s of (Array.isArray(list) ? list : [])) {
    if (!s) continue;
    const f1 = numOr(Array.isArray(s) ? s[0] : s.f1, null), f2 = numOr(Array.isArray(s) ? s[1] : s.f2, null);
    if (f1 == null || f2 == null || !(f2 > f1)) continue;
    out.push({ f1, f2, pol: normPol(Array.isArray(s) ? s[2] : s.pol) || defPol || '', pDb: numOr(Array.isArray(s) ? s[3] : s.pDb, 0) });
  }
  out.sort((a, b) => a.f1 - b.f1);
  return out;
}
/** 段的并集长度（MHz）：同一波束两段压在一起时不重复计带宽 */
function unionLen(segs) {
  let len = 0, lo = -Infinity, hi = -Infinity;
  for (const s of segs) {
    if (s.f1 > hi) { if (hi > lo) len += hi - lo; lo = s.f1; hi = s.f2; } else if (s.f2 > hi) hi = s.f2;
  }
  if (hi > lo) len += hi - lo;
  return len;
}
const overlapLen = (a, b) => Math.max(0, Math.min(a.f2, b.f2) - Math.max(a.f1, b.f1));

// ===== 波束合成色号（GRD 元数据）=====
// 生成天线时（波束合成「频率计划 · 自动分配」之后）逐波束的色号 fc（0 基）随文件写下来。认三种落点：
//   GRASP 文本头的 SYNTHMETA 行：{ fc:[…] } / { fcs:[…] } / { beams:[{ fc }] }；
//   解析天线记录（*.gauss.json）：{ beams:[{ fc }] } 或顶层 fc:[…]。
// 下标 = 原始 GRD set 序号；取不到的波束为 null。一个都取不到 → null（来源不可用，不编）。
function fcListOf(o) {
  if (!o || typeof o !== 'object') return null;
  const pick = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; };
  for (const k of ['fc', 'fcs', 'beamFc']) if (Array.isArray(o[k])) return o[k].map(pick);
  if (Array.isArray(o.beams)) return o.beams.map((b) => (b && typeof b === 'object' ? pick(b.fc) : null));
  return null;
}
function synthFcFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  let arr = null;
  if (text.trimStart().charAt(0) === '{') {
    try { arr = fcListOf(JSON.parse(text)); } catch (e) { arr = null; }
  } else {
    const m = /^SYNTHMETA\s+(\{.*\})\s*$/m.exec(text);
    if (m) { try { arr = fcListOf(JSON.parse(m[1])); } catch (e) { arr = null; } }
  }
  return arr && arr.some((v) => v != null) ? arr : null;
}

// ===== 复用方案 =====
const SOURCES = ['freqPlan', 'synth', 'excel', 'manual', 'rotation'];
const DIRS = ['fwd', 'rtn'];

// 色号定义：{ 色号: { fwd:{f1,f2,pol}, rtn:{…} } } → 每色每向一段（可多段：数组）
function normColorDefs(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    const e = {};
    for (const d of DIRS) {
      const x = v[d];
      if (!x) continue;
      const segs = normSegs(Array.isArray(x) ? x : [x], normPol(!Array.isArray(x) && x.pol));
      if (segs.length) e[d] = segs;
    }
    if (e.fwd || e.rtn) out.set(String(k), e);
  }
  return out;
}

/**
 * 原始方案（渲染端组装的纯数据 + 主进程补的 fc）→ 按存活波束对齐的解析结果。
 *
 * raw = {
 *   source: 'auto' | 'freqPlan' | 'synth' | 'excel' | 'manual' | 'rotation',
 *   colors: 4,                                  // 轮转色数
 *   xpdDb: 25,                                  // 正交极化、GRD 无交叉极化分量时用的规格 XPD
 *   plan:  { label, beams: { [原始下标]: { fwd:{segs:[{f1,f2,pol,pDb}]}, rtn:{…} } } },
 *   excel: { beams: { [原始下标]: { fwd:{segs,color,pol}, rtn:{…} } } },
 *   manual:{ coloring: { [原始下标]: 色号 } },  // 老字段 coloringOverride
 *   fc:    [ 原始下标 → 色号 | null ],           // 主进程从 GRD 元数据读
 *   colorDefs: { [色号]: { fwd:{f1,f2,pol}, rtn:{…} } },
 *   powerDb: { [原始下标]: dB }                 // 逐波束功率偏置（手填），叠在段偏置上
 * }
 * 返回 { ok, source, requested, label, colors, xpdDb, n, beamIdx, dirs:{fwd,rtn}, powerDb, unassigned:{fwd,rtn} }
 *   dirs[d] = { mode:'segs'|'color'|'none', segs:[段表|null], color:[色号串|null] }
 * 指定了来源却没有数据 → { ok:false, error }（不偷偷换成别的来源）。
 * dir（'fwd' | 'rtn'，可省）：给了就按这个方向判「有没有数据」——自动挑来源时，只给了返向段的计划不该挡住前向的下一级来源。
 */
function normalizeScheme(raw, beamIdx, dir) {
  const r = raw || {};
  const idx = Array.isArray(beamIdx) ? beamIdx.slice() : [];
  const n = idx.length;
  const want = SOURCES.includes(r.source) ? r.source : 'auto';
  const colors = Math.max(1, Math.round(Number(r.colors) || 4));
  const xpdDb = numOr(r.xpdDb, DEFAULT_XPD_DB);
  const defs = normColorDefs(r.colorDefs);
  const powerDb = new Float64Array(n);
  const pw = r.powerDb && typeof r.powerDb === 'object' ? r.powerDb : {};
  for (let i = 0; i < n; i++) powerDb[i] = numOr(pw[idx[i]], 0);
  const at = (obj, orig) => (obj && typeof obj === 'object' ? (obj[orig] !== undefined ? obj[orig] : obj[String(orig)]) : undefined);

  // 一个方向的解析：有任何波束给了频段 → segs 模式（只有色号、没频段的波束记为未指派）；
  // 否则有色号 → color 模式（二值）；都没有 → none。
  function finishDir(segs, color) {
    const anySeg = segs.some((s) => s && s.length);
    const anyColor = color.some((c) => c != null);
    if (anySeg) return { mode: 'segs', segs: segs.map((s) => (s && s.length ? s : null)), color };
    if (anyColor) return { mode: 'color', segs: segs.map(() => null), color };
    return { mode: 'none', segs: segs.map(() => null), color };
  }
  const colorSegs = (label, d) => { const e = label == null ? null : defs.get(label); return e && e[d] ? e[d] : null; };

  // 逐波束表类（频率计划 / Excel）
  function fromBeams(beams) {
    if (!beams || typeof beams !== 'object') return null;
    const out = {};
    for (const d of DIRS) {
      const segs = [], color = [];
      for (let i = 0; i < n; i++) {
        const b = at(beams, idx[i]);
        const x = b && b[d];
        const pol = normPol(x && x.pol);
        const c = x && x.color != null && String(x.color).trim() !== '' ? String(x.color).trim() : null;
        let s = normSegs(x && x.segs, pol);
        if (!s.length && c != null) s = colorSegs(c, d) || [];
        segs.push(s); color.push(c);
      }
      out[d] = finishDir(segs, color);
    }
    return out;
  }
  // 色号类（波束合成 / 手工 / 轮转）：一个波束一个色，上下行同色
  function fromColors(getColor) {
    const out = {};
    const labels = idx.map((orig) => { const c = getColor(orig); return c == null || c === '' ? null : String(c); });
    for (const d of DIRS) out[d] = finishDir(labels.map((c) => colorSegs(c, d) || []), labels.slice());
    return out;
  }
  const builders = {
    freqPlan: () => fromBeams(r.plan && r.plan.beams),
    excel: () => fromBeams(r.excel && r.excel.beams),
    synth: () => (Array.isArray(r.fc) ? fromColors((orig) => (r.fc[orig] == null ? null : r.fc[orig])) : null),
    manual: () => (r.manual && r.manual.coloring && typeof r.manual.coloring === 'object'
      ? fromColors((orig) => { const v = at(r.manual.coloring, orig); return v == null || v === '' ? null : v; }) : null),
    rotation: () => { const m = ciCci.defaultColoring(idx, colors); return fromColors((orig) => m[orig]); }
  };
  const usable = (res) => !!res && (DIRS.includes(dir) ? res[dir].mode !== 'none' : DIRS.some((d) => res[d].mode !== 'none'));
  const order = want === 'auto' ? SOURCES : [want];
  let source = null, dirs = null;
  for (const s of order) {
    const res = builders[s]();
    if (usable(res)) { source = s; dirs = res; break; }
  }
  if (!source) {
    const why = { freqPlan: '频率计划未指派任何波束', synth: '方向图未带波束合成色号', excel: '逐波束表为空', manual: '手工着色为空' };
    return { ok: false, error: why[want] || '复用方案无可用数据', requested: want };
  }
  const unassigned = {};
  for (const d of DIRS) {
    const x = dirs[d];
    unassigned[d] = x.mode === 'segs' ? x.segs.filter((s) => !s).length : (x.mode === 'color' ? x.color.filter((c) => c == null).length : n);
  }
  const label = source === 'freqPlan' ? String((r.plan && r.plan.label) || '') : (source === 'rotation' ? `${colors}` : '');
  return { ok: true, source, requested: want, label, colors, xpdDb, n, beamIdx: idx, dirs, powerDb, unassigned };
}

/**
 * 一个方向的耦合矩阵（行 = 受扰 j，列 = 施扰 k，均按存活波束次序）：
 *   wCo  同极化（含未知、线 / 圆混用 ×1/2）那一份
 *   wX   正交极化那一份 —— 乘的是施扰波束的交叉极化分量（前向）/ 受扰波束的交叉极化分量（返向）
 *   pDb  逐波束平均谱密度偏置（dB），选服务波束时与增益相加
 *   assigned  该波束在这个方向上有没有频率指派
 * 二值退化：color 模式、功率偏置全 0 → wCo ∈ {0, 1} 精确、wX ≡ 0。
 */
function couplingOf(scheme, dir) {
  const n = scheme.n;
  const d = scheme.dirs[dir === 'rtn' ? 'rtn' : 'fwd'];
  const wCo = new Float64Array(n * n), wX = new Float64Array(n * n);
  const pDb = new Float64Array(n), assigned = new Uint8Array(n);
  const pw = scheme.powerDb;
  let anyX = false, anyMix = false;
  if (d.mode === 'segs') {
    const B = new Float64Array(n), Pm = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const s = d.segs[j];
      if (!s) continue;
      assigned[j] = 1;
      B[j] = unionLen(s);
      let acc = 0, len = 0;
      for (const a of s) { const l = a.f2 - a.f1; acc += lin(a.pDb + pw[j]) * l; len += l; }
      Pm[j] = len > 0 ? acc / len : 1;
      pDb[j] = 10 * LOG10(Pm[j]);
    }
    for (let j = 0; j < n; j++) {
      if (!assigned[j] || !(B[j] > 0)) continue;
      const den = Pm[j] * B[j];
      for (let k = 0; k < n; k++) {
        if (k === j || !assigned[k]) continue;
        let co = 0, x = 0;
        for (const a of d.segs[j]) {
          for (const b of d.segs[k]) {
            const ov = overlapLen(a, b);
            if (!(ov > 0)) continue;
            const c = lin(b.pDb + pw[k]) * ov / den;
            const rel = polRelation(a.pol, b.pol);
            if (rel === 'x') x += c;
            else if (rel === 'mix') { co += MIX_FACTOR * c; anyMix = true; }
            else co += c;
          }
        }
        wCo[j * n + k] = co; wX[j * n + k] = x;
        if (x > 0) anyX = true;
      }
    }
  } else if (d.mode === 'color') {
    for (let j = 0; j < n; j++) { if (d.color[j] != null) { assigned[j] = 1; pDb[j] = pw[j]; } }
    for (let j = 0; j < n; j++) {
      if (!assigned[j]) continue;
      for (let k = 0; k < n; k++) {
        if (k === j || !assigned[k] || d.color[k] !== d.color[j]) continue;
        wCo[j * n + k] = pw[k] === pw[j] ? 1 : lin(pw[k] - pw[j]);
      }
    }
  }
  return { n, dir: dir === 'rtn' ? 'rtn' : 'fwd', mode: d.mode, wCo, wX, pDb, assigned, anyX, anyMix };
}

/**
 * 单点前向 C/I（一般耦合）。values / cxValues 与存活波束同序（dB，null = 该点无值）。
 *   opt.beamIdx    原始下标（出参的 servingIdx / interferers 用）
 *   opt.floored    Uint8Array：该项是窗外地板（不参与选服务波束，计入时计数）
 *   opt.servingIdx 钉死服务波束（原始下标）
 *   opt.floorDb    比服务波束低这么多以上的干扰项忽略（默认 60，与 cciAtPoint 同口径）
 *   opt.xpdDb      正交项取不到交叉极化分量时的规格 XPD
 *   opt.colorOf    逐波束色号（出参 colorId 用）
 *   opt.detail     出逐源明细（场图逐格算时关掉，省分配）
 * 二值耦合、功率偏置全 0 时，与 cciAtPoint(values, beamIdx, {coloring}) 的 cciDb / interferers / 计数逐位相同。
 */
function fwdAtPoint(values, cxValues, cpl, o) {
  const opt = o || {};
  if (!values || !values.length) return null;
  const n = values.length;
  const idx = opt.beamIdx && opt.beamIdx.length === n ? opt.beamIdx : null;
  const idxOf = (i) => (idx ? idx[i] : i);
  const floored = opt.floored || null;
  const pDb = cpl.pDb;
  let sPos = -1;
  if (opt.servingIdx != null) {
    for (let i = 0; i < n; i++) if (idxOf(i) === Number(opt.servingIdx)) { sPos = i; break; }
    if (sPos < 0 || values[sPos] == null || (floored && floored[sPos])) return null;
  } else {
    for (let i = 0; i < n; i++) {
      if (values[i] == null || (floored && floored[i])) continue;
      if (sPos < 0 || values[i] + pDb[i] > values[sPos] + pDb[sPos]) sPos = i;
    }
    if (sPos < 0) return null;
  }
  const servingGain = values[sPos];
  const servingIdx = idxOf(sPos);
  const colorId = opt.colorOf ? opt.colorOf[sPos] : undefined;
  if (!cpl.assigned[sPos]) {
    return { cciDb: null, servingPos: sPos, servingIdx, servingGainDb: servingGain, colorId, interferers: [], coChannelCount: 0, noCoChannel: false, unassigned: true, floorUsed: 0 };
  }
  const floorDb = Number.isFinite(Number(opt.floorDb)) ? Number(opt.floorDb) : 60;
  const xpd = Number.isFinite(Number(opt.xpdDb)) ? Number(opt.xpdDb) : DEFAULT_XPD_DB;
  const row = sPos * n;
  let sum = 0, cnt = 0, floorUsed = 0;
  const interferers = opt.detail === false ? null : [];
  for (let i = 0; i < n; i++) {
    if (i === sPos || values[i] == null) continue;
    const wc = cpl.wCo[row + i], wx = cpl.wX[row + i];
    if (!(wc > 0) && !(wx > 0)) continue;
    let part = 0, used = false;
    if (wc > 0) {
      const g = values[i];
      const eff = wc === 1 ? g : g + 10 * LOG10(wc);
      if (!(eff < servingGain - floorDb)) { part += wc === 1 ? lin(g) : wc * lin(g); used = true; }
    }
    if (wx > 0) {
      const gx = cxValues && cxValues[i] != null ? cxValues[i] : values[i] - xpd;
      if (!(gx + 10 * LOG10(wx) < servingGain - floorDb)) { part += wx * lin(gx); used = true; }
    }
    if (!used) continue;
    sum += part;
    cnt++;
    const fl = !!(floored && floored[i]);
    if (fl) floorUsed++;
    if (interferers) interferers.push(fl ? { beamIdx: idxOf(i), gainDb: (wc === 1 && !(wx > 0)) ? values[i] : 10 * LOG10(part), floored: true }
      : { beamIdx: idxOf(i), gainDb: (wc === 1 && !(wx > 0)) ? values[i] : 10 * LOG10(part) });
  }
  if (!(sum > 0)) {
    return { cciDb: null, servingPos: sPos, servingIdx, servingGainDb: servingGain, colorId, interferers: [], coChannelCount: 0, noCoChannel: true, floorUsed: 0 };
  }
  const iDb = 10 * LOG10(sum);
  if (interferers) {
    interferers.sort((a, b) => b.gainDb - a.gainDb);
    for (const it of interferers) it.sharePct = (lin(it.gainDb) / sum) * 100;
  }
  return {
    cciDb: servingGain - iDb,
    servingPos: sPos, servingIdx, servingGainDb: servingGain, colorId,
    aggregateInterfGainDb: iDb,
    interferers: interferers || [], coChannelCount: cnt, noCoChannel: false, floorUsed
  };
}

// ===== 加权分位（服务区统计）=====
// vals 升序；w 同序权重（null = 等权）。取第一个累计权重 ≥ p·W 的值（下侧分位，p=0 即最小值）。
function weightedQuantile(vals, w, p) {
  const m = vals.length;
  if (!m) return null;
  if (!w) return vals[Math.max(0, Math.min(m - 1, Math.ceil(p * m) - 1))];
  let W = 0;
  for (let i = 0; i < m; i++) W += w[i];
  const tgt = p * W;
  let acc = 0;
  for (let i = 0; i < m; i++) { acc += w[i]; if (acc >= tgt - 1e-12 * W) return vals[i]; }
  return vals[m - 1];
}
function sortWithWeights(vals, w) {
  const m = vals.length;
  const ord = Array.from({ length: m }, (_, i) => i).sort((a, b) => vals[a] - vals[b]);
  return { v: ord.map((i) => vals[i]), w: w ? ord.map((i) => w[i]) : null };
}
function statsOf(vals, w) {
  if (!vals.length) return null;
  const s = sortWithWeights(vals, w);
  return { n: vals.length, min: s.v[0], p5: weightedQuantile(s.v, s.w, 0.05), p50: weightedQuantile(s.v, s.w, 0.5) };
}

// ===== 几何（与 grdSampler.js 逐字同源：GRASP 网格定义 + WGS84；那边不导出，这里只用来定「点在哪个网格位置」，
//        取值本身一律交给 grdSampler.sampleBeamAt，免得两份取值口径漂开）=====
const WA = 6378.137, WB = 6356.7523142, WF = (WA - WB) / WA, WE2 = 2 * WF - WF * WF;
function geodeticToEcef(lonDeg, latDeg, hKm) {
  hKm = hKm || 0;
  const lat = latDeg * D2R, lon = lonDeg * D2R, sl = Math.sin(lat), cl = Math.cos(lat);
  const N = WA / Math.sqrt(1 - WE2 * sl * sl);
  return [(N + hKm) * cl * Math.cos(lon), (N + hKm) * cl * Math.sin(lon), (N * (1 - WE2) + hKm) * sl];
}
function ecefToGeodetic(x, y, z) {
  const lon = Math.atan2(y, x), p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WE2));
  for (let k = 0; k < 6; k++) {
    const sl = Math.sin(lat), N = WA / Math.sqrt(1 - WE2 * sl * sl);
    const h = Math.abs(Math.cos(lat)) > 1e-12 ? p / Math.cos(lat) - N : Math.abs(z) / Math.abs(sl) - N * (1 - WE2);
    lat = Math.atan2(z, p * (1 - WE2 * N / (N + h)));
  }
  return { lon: lon / D2R, lat: lat / D2R };
}
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
/** 射线 S + t·d（ECEF km，d 单位矢量）与 WGS84 椭球的近交点；不相交 → null */
function rayEarth(S, d) {
  const k = WA / WB;
  const sx = S[0], sy = S[1], sz = S[2] * k, dx = d[0], dy = d[1], dz = d[2] * k;
  const qa = dx * dx + dy * dy + dz * dz, qb = 2 * (sx * dx + sy * dy + sz * dz), qc = sx * sx + sy * sy + sz * sz - WA * WA;
  const disc = qb * qb - 4 * qa * qc;
  if (!(disc >= 0)) return null;
  const t = (-qb - Math.sqrt(disc)) / (2 * qa);
  if (!(t > 0)) return null;
  return [S[0] + t * d[0], S[1] + t * d[1], S[2] + t * d[2]];
}
const wrap180 = (x) => { let v = ((x + 180) % 360 + 360) % 360 - 180; if (v === -180 && x > 0) v = 180; return v; };

// ===== 采样环境：一次算好基底、逐波束窗口 / 地板 / 峰值 / 极化分量 =====
function polParOf(par, comp) { return { pol: comp === 2 ? 'P2' : 'P1', gainOffset: par.gainOffset, pathLoss: 'none' }; }
// 逐波束扫一遍节点：legacy 口径（cfg.pol 组合）与共 / 交分量的最小（> 0）与最大
function beamScan(bm, par, sampler, polMode) {
  const g = bm.grid, N = g.NX * g.NY;
  const off = Number(par.gainOffset) || 0;
  const pol = par.pol || 'RSS';
  let lmin = Infinity, lmax = 0, c1min = Infinity, c1max = 0, c2min = Infinity, c2max = 0;
  for (let i = 0; i < N; i++) {
    let p1, p2;
    if (bm.c1re) { p1 = bm.c1re[i] * bm.c1re[i] + bm.c1im[i] * bm.c1im[i]; p2 = bm.c2re[i] * bm.c2re[i] + bm.c2im[i] * bm.c2im[i]; }
    else { p1 = bm.P1[i]; p2 = bm.P2[i]; }
    const pw = pol === 'P1' ? p1 : (pol === 'P2' ? p2 : p1 + p2);
    if (pw > 0) { if (pw < lmin) lmin = pw; if (pw > lmax) lmax = pw; }
    if (p1 > 0) { if (p1 < c1min) c1min = p1; if (p1 > c1max) c1max = p1; }
    if (p2 > 0) { if (p2 < c2min) c2min = p2; if (p2 > c2max) c2max = p2; }
  }
  const db = (v) => (v > 0 && v < Infinity ? 10 * LOG10(v) + off : null);
  const out = {
    legacyFloor: lmin < Infinity ? +db(lmin).toFixed(2) : null,
    legacyPeak: bm.an && pol !== 'P2' ? bm.an.g0 + off : db(lmax)
  };
  if (polMode) {
    const coIdx = sampler.coPolIndexOf(bm);
    out.coIdx = coIdx;
    const coMin = coIdx === 2 ? c2min : c1min, coMax = coIdx === 2 ? c2max : c1max;
    const cxMin = coIdx === 2 ? c1min : c2min, cxMax = coIdx === 2 ? c1max : c2max;
    out.coFloor = db(coMin);
    out.coPeak = bm.an ? bm.an.g0 + off : db(coMax);
    // 解析波束：交叉极化有没有由闭式说了算（采样器取不到即为 null → 走规格 XPD），网格上铺出来的那份不作数
    out.hasCx = bm.an ? true : cxMax > 0;
    out.cxFloor = !bm.an && cxMax > 0 ? db(cxMin) : null;
  }
  return out;
}

function prepEnv(o) {
  const sampler = o.sampler;
  if (!sampler || typeof sampler.makeSampleCtx !== 'function') throw new Error('缺少 GRD 采样器');
  const cfg = { ...(o.cfg || {}), pathLoss: 'none' };      // C/I 是比值：路径损耗逐点对所有波束相同，约掉
  if (cfg.pol === 'P1/P2' || cfg.pol === 'P2/P1') cfg.pol = 'RSS';
  const ctx = sampler.makeSampleCtx(o.loaded, o.sat || {}, cfg);
  if (!ctx) throw new Error('天线几何无效（对星指向或卫星位置缺失）');
  const n = ctx.beams.length;
  const scheme = o.scheme && o.scheme.ok ? o.scheme : normalizeScheme(o.scheme || { source: 'rotation', colors: 4 }, ctx.beamIdx);
  if (!scheme.ok) throw new Error(scheme.error || '复用方案无可用数据');
  if (scheme.n !== n) throw new Error('复用方案与方向图波束数不一致');
  const dir = o.dir === 'rtn' ? 'rtn' : 'fwd';
  const cpl = couplingOf(scheme, dir);
  const polMode = cpl.anyX || cpl.anyMix;
  const info = ctx.beams.map((bm) => {
    const g = bm.grid;
    const s = beamScan(bm, ctx.par, sampler, polMode);
    return {
      XS: g.XS, YS: g.YS, NX: g.NX, NY: g.NY,
      dx: (g.XE - g.XS) / (g.NX - 1), dy: (g.YE - g.YS) / (g.NY - 1),
      floorCo: polMode ? s.coFloor : s.legacyFloor,
      peakCo: polMode ? s.coPeak : s.legacyPeak,
      floorCx: polMode ? s.cxFloor : null,
      hasCx: polMode ? s.hasCx : false,
      parCo: polMode ? polParOf(ctx.par, s.coIdx) : null,
      parCx: polMode && s.hasCx ? polParOf(ctx.par, s.coIdx === 2 ? 1 : 2) : null
    };
  });
  const colorOf = scheme.dirs[dir].color;
  const xpdDb = scheme.xpdDb;
  const floorDb = Number.isFinite(Number(o.floorDb)) ? Number(o.floorDb) : 60;
  const eocDb = numOr(o.eocDb, DEFAULT_EOC_DB);
  const S = ctx.basis.S, bx = ctx.basis.x, by = ctx.basis.y, bz = ctx.basis.z;

  // 一点上的逐波束取值。XY 给了（天线网格节点）就不再反算。
  // 出：co / cx / floored 填进 scratch，返回 false = 该点无值（不可见或全在窗外）。
  const co = new Array(n), cx = new Array(n), floored = new Uint8Array(n);
  const EPS = 1e-7;
  function evalAt(lon, lat, X, Y) {
    const P = geodeticToEcef(lon, lat, 0);
    let ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2];
    const rs = Math.hypot(ex, ey, ez);
    if (!(rs > 0)) return false;
    ex /= rs; ey /= rs; ez /= rs;
    const clat = Math.cos(lat * D2R);
    if (ex * clat * Math.cos(lon * D2R) + ey * clat * Math.sin(lon * D2R) + ez * Math.sin(lat * D2R) > 0) return false;   // 地平线下
    const a = ex * bx[0] + ey * bx[1] + ez * bx[2], b = ex * by[0] + ey * by[1] + ez * by[2], c = ex * bz[0] + ey * bz[1] + ez * bz[2];
    if (X == null) {
      const xy = invGridDir(ctx.igrid, a, b, c);
      if (!xy) return false;
      X = xy[0]; Y = xy[1];
    } else if (!(c > 0)) return false;
    let any = false;
    for (let i = 0; i < n; i++) {
      const f = info[i];
      const fc = (X - f.XS) / f.dx, fr = (Y - f.YS) / f.dy;
      let v = null, vx = null;
      const bm = ctx.beams[i];
      // 网格窗外的直接记地板、不再调采样器（多波束合成件一点上大半波束在窗外，省掉的是大头）；
      // 解析波束不预筛 —— 取值域由采样器按闭式定（不截窗的解析模型在窗外照样有值）
      if (bm.an || !(fc < -EPS || fc > f.NX - 1 + EPS || fr < -EPS || fr > f.NY - 1 + EPS)) {
        if (polMode) {
          v = sampler.sampleBeamAt(bm, ctx.igrid, ctx.basis, lon, lat, f.parCo);
          if (v != null && f.parCx) vx = sampler.sampleBeamAt(bm, ctx.igrid, ctx.basis, lon, lat, f.parCx);
        } else {
          v = sampler.sampleBeamAt(bm, ctx.igrid, ctx.basis, lon, lat, ctx.par);
          if (v != null) v = +v.toFixed(2);                 // 与 sampleAllCtx 同口径（老场图逐位可比）
        }
      }
      if (v != null) { any = true; co[i] = v; cx[i] = vx; floored[i] = 0; }
      else { co[i] = null; cx[i] = null; floored[i] = 1; }
    }
    if (!any) return false;
    // 窗外地板：同一点别的波束有值（可见、在前半球）→ 取不到的那几个按各自网格最小电平计入。
    // 整个网格都是零场的波束没有地板可取（floorCo = null），照旧不计。
    for (let i = 0; i < n; i++) {
      if (!floored[i]) continue;
      co[i] = info[i].floorCo;
      cx[i] = info[i].floorCx;
    }
    return true;
  }
  return { sampler, ctx, n, scheme, dir, cpl, polMode, info, colorOf, xpdDb, floorDb, eocDb, co, cx, floored, evalAt, S, bx, by, bz };
}

// ===== 逐点前向（取值点表）=====
function cciPoints(o) {
  const env = prepEnv({ ...o, dir: 'fwd' });
  const pts = Array.isArray(o.points) ? o.points : [];
  let floorPts = 0;
  const rows = pts.map((p) => {
    const lon = Number(p && p.lon), lat = Number(p && p.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !env.evalAt(lon, lat)) return null;
    const r = fwdAtPoint(env.co, env.polMode ? env.cx : null, env.cpl, {
      beamIdx: env.ctx.beamIdx, floored: env.floored, servingIdx: o.servingIdx, floorDb: env.floorDb, xpdDb: env.xpdDb, colorOf: env.colorOf, detail: true
    });
    if (r && r.floorUsed) floorPts++;
    return r;
  });
  return { rows, summary: summaryOf(env, { floorPts }) };
}

// 读数：实际用的来源、存活波束与逐波束指派（色号 / 段，按存活波束次序），窗外计入点数等由调用方补
function summaryOf(env, extra) {
  const s = env.scheme;
  const d = s.dirs[env.dir];
  return {
    source: s.source, requested: s.requested, label: s.label, colors: s.colors, dir: env.dir,
    beamIdx: env.ctx.beamIdx.slice(), polMode: env.polMode, xpdDb: env.xpdDb,
    unassigned: s.unassigned[env.dir],
    assign: env.ctx.beamIdx.map((_, i) => ({ color: d.color[i], segs: (d.segs[i] || []).map((x) => ({ f1: x.f1, f2: x.f2, pol: x.pol })) })),
    ...(extra || {})
  };
}

// ===== 场图作业 =====
const mkRng = (seed) => {           // mulberry32，与 ciNgso.makeRng 同一串（种子写进结果，可复现）
  let a = (Number(seed) >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * 网格：
 *   { kind:'antenna' }  GRD 自身天线网格 = 存活波束窗口的并集，节距取各波束最细的那个（公共网格的 GRD 即原网格逐节点）
 *   { kind:'user', lonMin, lonMax, latMin, latMax, step }  经纬网格
 * 超过内存护栏 MAX_POINTS 时等比放宽节距（结果里如实给出实际节距）。
 */
function buildGrid(env, g) {
  const gg = g || {};
  if (gg.kind === 'user') {
    const step = Math.max(1e-4, numOr(gg.step, 1));
    const lon0 = numOr(gg.lonMin, 70), lon1 = numOr(gg.lonMax, 140), lat0 = numOr(gg.latMin, 15), lat1 = numOr(gg.latMax, 55);
    const nx = Math.floor((lon1 - lon0) / step + 1e-9) + 1, ny = Math.floor((lat1 - lat0) / step + 1e-9) + 1;
    if (!(nx > 1 && ny > 1)) throw new Error('经纬范围不合法');
    if (nx * ny > MAX_POINTS) throw new Error(`网格 ${nx}×${ny} 超出内存护栏 ${MAX_POINTS.toLocaleString('en-US')} 点`);
    return { kind: 'user', nx, ny, count: nx * ny, lon0, lat0, step };
  }
  let XS = Infinity, XE = -Infinity, YS = Infinity, YE = -Infinity, dx = Infinity, dy = Infinity;
  for (const f of env.info) {
    XS = Math.min(XS, f.XS); YS = Math.min(YS, f.YS);
    XE = Math.max(XE, f.XS + f.dx * (f.NX - 1)); YE = Math.max(YE, f.YS + f.dy * (f.NY - 1));
    if (f.dx > 0) dx = Math.min(dx, f.dx);
    if (f.dy > 0) dy = Math.min(dy, f.dy);
  }
  if (!(dx < Infinity) || !(dy < Infinity)) throw new Error('方向图网格无效');
  let nx = Math.round((XE - XS) / dx) + 1, ny = Math.round((YE - YS) / dy) + 1;
  let coarsen = 1;
  if (nx * ny > MAX_POINTS) {
    coarsen = Math.sqrt(nx * ny / MAX_POINTS);
    dx *= coarsen; dy *= coarsen;
    nx = Math.floor((XE - XS) / dx) + 1; ny = Math.floor((YE - YS) / dy) + 1;
  }
  // 首末节点向内收 1e-6 个节距：节点正落在窗口边沿时，经纬往返的末位误差会把它判到窗外（整圈边节点丢值）
  const ix = 1e-6 * dx, iy = 1e-6 * dy;
  const sx = nx > 1 ? (XE - XS - 2 * ix) / (nx - 1) : dx, sy = ny > 1 ? (YE - YS - 2 * iy) / (ny - 1) : dy;
  return { kind: 'antenna', nx, ny, count: nx * ny, X0: XS + ix, Y0: YS + iy, dx: sx, dy: sy, coarsen };
}

/**
 * 场图作业（主进程分帧推进）：
 *   o = { sampler, loaded, sat, cfg, scheme(原始或已解析), dir:'fwd'|'rtn', grid, points:[{lon,lat,name}],
 *         floorDb, eocDb, servingIdx, rtn:{ mode:'worst'|'mc', trials, seed } }
 * 返回 { T, stepBatch(units) → 已完成单位数, finalize() → 结果 }
 * 单位 = 一个点上把全部波束取一遍（网格点 / 取值点 / 蒙特卡洛的一次终端落点）。
 */
function createCciRun(o) {
  const env = prepEnv(o);
  const { n, cpl, info } = env;
  const grid = buildGrid(env, o.grid);
  const N = grid.count;
  const dir = env.dir;
  const rtnMode = o.rtn && o.rtn.mode === 'mc' ? 'mc' : 'worst';
  // 试验次数护栏 2 万：每次试验要在每个同频波束的服务区里各取一点、各取一遍全部波束，再多就是几十分钟的作业
  const trials = dir === 'rtn' && rtnMode === 'mc' ? Math.max(1, Math.min(20000, Math.round(numOr(o.rtn.trials, 200)))) : 0;
  const seed = numOr(o.rtn && o.rtn.seed, 20261017) >>> 0;
  const tablePts = Array.isArray(o.points) ? o.points : [];
  const lonA = new Float64Array(N), latA = new Float64Array(N);
  const zv = new Float32Array(N).fill(NaN);
  const srv = new Int32Array(N).fill(-1);
  const cov = new Uint8Array(N);
  const okPt = new Uint8Array(N);
  const satLon = Number(env.ctx && o.sat && o.sat.lon) || 0;
  let floorPts = 0;
  // 返向最坏点：worst[j*n+k] = max_{x∈cell_k} G_j(x)/G_k(x)（dB），正交那一份另记
  const worstCo = dir === 'rtn' ? new Float64Array(n * n).fill(-Infinity) : null;
  const worstX = dir === 'rtn' ? new Float64Array(n * n).fill(-Infinity) : null;
  const cellCount = new Int32Array(n);
  // 每个施扰波束 k 的受扰者名单（w_jk > 0 的 j），逐点只扫这些
  const victimsOf = [];
  for (let k = 0; k < n; k++) {
    const l = [];
    for (let j = 0; j < n; j++) if (j !== k && (cpl.wCo[j * n + k] > 0 || cpl.wX[j * n + k] > 0)) l.push(j);
    victimsOf.push(l);
  }
  const tableRes = new Array(tablePts.length).fill(null);
  const T = N + tablePts.length + trials * n;
  let phase = 0;                 // 0 网格 · 1 取值点 · 2 蒙特卡洛 · 3 完成
  let gi = 0, ti = 0;
  // 蒙特卡洛状态
  let cells = null, cellW = null, mcK = null, mcT = 0, mcKi = 0, Itr = null, ciMc = null, mcFloor = 0;
  let rng = null;
  const t0 = Date.now();

  function pointCoord(k) {
    if (grid.kind === 'user') {
      const i = k % grid.nx, j = (k - i) / grid.nx;
      return { lon: grid.lon0 + i * grid.step, lat: grid.lat0 + j * grid.step, X: null, Y: null };
    }
    const i = k % grid.nx, j = (k - i) / grid.nx;
    const X = grid.X0 + i * grid.dx, Y = grid.Y0 + j * grid.dy;
    const d = gridDir(env.ctx.igrid, X, Y);
    if (!(d[2] > 0)) return null;
    const D = [
      env.bx[0] * d[0] + env.by[0] * d[1] + env.bz[0] * d[2],
      env.bx[1] * d[0] + env.by[1] * d[1] + env.bz[1] * d[2],
      env.bx[2] * d[0] + env.by[2] * d[1] + env.bz[2] * d[2]
    ];
    const P = rayEarth(env.S, D);
    if (!P) return null;
    const gd = ecefToGeodetic(P[0], P[1], P[2]);
    return { lon: satLon + wrap180(gd.lon - satLon), lat: gd.lat, X, Y };
  }
  // 服务波束：前向取 fwdAtPoint 的；返向取接收增益最强（不含窗外地板）
  function bestPos() {
    let s = -1;
    for (let i = 0; i < n; i++) {
      if (env.co[i] == null || env.floored[i]) continue;
      if (s < 0 || env.co[i] + cpl.pDb[i] > env.co[s] + cpl.pDb[s]) s = i;
    }
    return s;
  }
  const cxEff = (j) => (env.cx[j] != null ? env.cx[j] : env.co[j] - env.xpdDb);

  function stepGrid(k) {
    const pc = pointCoord(k);
    if (!pc) return;
    lonA[k] = pc.lon; latA[k] = pc.lat;
    if (!env.evalAt(pc.lon, pc.lat, pc.X, pc.Y)) return;
    okPt[k] = 1;
    if (dir === 'fwd') {
      const r = fwdAtPoint(env.co, env.polMode ? env.cx : null, cpl, {
        beamIdx: env.ctx.beamIdx, floored: env.floored, servingIdx: o.servingIdx, floorDb: env.floorDb, xpdDb: env.xpdDb, detail: false
      });
      if (!r) return;
      srv[k] = r.servingPos;
      if (r.floorUsed) floorPts++;
      zv[k] = r.unassigned ? NaN : (r.noCoChannel ? Infinity : r.cciDb);
      const pk = info[r.servingPos].peakCo;
      if (!r.unassigned && pk != null && env.co[r.servingPos] >= pk - env.eocDb) { cov[k] = 1; cellCount[r.servingPos]++; }
      return;
    }
    const s = bestPos();
    if (s < 0) return;
    srv[k] = s;
    const pk = info[s].peakCo;
    if (!cpl.assigned[s] || pk == null || env.co[s] < pk - env.eocDb) return;
    cov[k] = 1; cellCount[s]++;
    const gs = env.co[s];
    let usedFloor = false;
    for (const j of victimsOf[s]) {
      const at = j * n + s;
      if (cpl.wCo[at] > 0) { const r = env.co[j] - gs; if (r > worstCo[at]) worstCo[at] = r; }
      if (cpl.wX[at] > 0) { const r = cxEff(j) - gs; if (r > worstX[at]) worstX[at] = r; }
      if (env.floored[j]) usedFloor = true;
    }
    if (usedFloor) floorPts++;
  }
  function stepTable(i) {
    const p = tablePts[i] || {};
    const lon = Number(p.lon), lat = Number(p.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !env.evalAt(lon, lat)) { tableRes[i] = null; return; }
    if (dir === 'fwd') {
      tableRes[i] = fwdAtPoint(env.co, env.polMode ? env.cx : null, cpl, {
        beamIdx: env.ctx.beamIdx, floored: env.floored, servingIdx: o.servingIdx, floorDb: env.floorDb, xpdDb: env.xpdDb, colorOf: env.colorOf, detail: true
      });
      return;
    }
    const s = bestPos();
    tableRes[i] = s < 0 ? null : { servingPos: s, servingIdx: env.ctx.beamIdx[s], servingGainDb: env.co[s], colorId: env.colorOf[s] };
  }
  function mcInit() {
    // 各波束服务区（覆盖内）节点表；经纬网格按 cos(纬度) 加权（等面积），天线网格等权（等立体角）
    const cnt = new Int32Array(n);
    for (let k = 0; k < N; k++) if (cov[k]) cnt[srv[k]]++;
    cells = []; cellW = [];
    for (let i = 0; i < n; i++) { cells.push(new Int32Array(cnt[i])); cellW.push(grid.kind === 'user' ? new Float32Array(cnt[i]) : null); }
    const fill = new Int32Array(n);
    for (let k = 0; k < N; k++) {
      if (!cov[k]) continue;
      const s = srv[k];
      cells[s][fill[s]] = k;
      if (cellW[s]) cellW[s][fill[s]] = Math.cos(latA[k] * D2R);
      fill[s]++;
    }
    mcK = [];
    for (let i = 0; i < n; i++) if (cells[i].length && cpl.assigned[i]) mcK.push(i);
    Itr = new Float64Array(n);
    ciMc = new Float64Array(n * trials).fill(NaN);
    rng = mkRng(seed);
  }
  function pickNode(k) {
    const list = cells[k], w = cellW[k];
    for (let guard = 0; guard < 64; guard++) {
      const i = Math.min(list.length - 1, Math.floor(rng() * list.length));
      if (!w || rng() <= w[i]) return list[i];
    }
    return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  }
  // 一次终端落点：干扰波束 k 的终端落在 x_k，把它对所有同频受扰波束的贡献加进本次试验
  function mcPick(k) {
    const node = pickNode(k);
    const X = grid.kind === 'user' ? null : grid.X0 + (node % grid.nx) * grid.dx;
    const Y = grid.kind === 'user' ? null : grid.Y0 + Math.floor(node / grid.nx) * grid.dy;
    if (!env.evalAt(lonA[node], latA[node], X, Y)) return;
    const gk = env.co[k];
    if (gk == null || env.floored[k]) return;
    let usedFloor = false;
    for (const j of victimsOf[k]) {
      if (env.co[j] == null) continue;
      const at = j * n + k;
      let add = 0;
      if (cpl.wCo[at] > 0) add += cpl.wCo[at] * lin(env.co[j] - gk);
      if (cpl.wX[at] > 0) add += cpl.wX[at] * lin(cxEff(j) - gk);
      Itr[j] += add;
      if (env.floored[j]) usedFloor = true;
    }
    if (usedFloor) mcFloor++;
  }
  function mcCloseTrial(t) {
    for (let j = 0; j < n; j++) {
      if (!cpl.assigned[j]) continue;
      ciMc[j * trials + t] = Itr[j] > 0 ? -10 * LOG10(Itr[j]) : Infinity;
      Itr[j] = 0;
    }
  }

  function doneUnits() {
    if (phase >= 3) return T;
    if (phase === 0) return gi;
    if (phase === 1) return N + ti;
    const K = mcK && mcK.length ? mcK.length : 1;
    return N + tablePts.length + Math.floor((mcT * K + mcKi) / (trials * K) * trials * n);
  }
  function stepBatch(units) {
    let left = Math.max(1, Math.floor(units) || 1);
    while (left > 0 && phase < 3) {
      if (phase === 0) {
        const end = Math.min(N, gi + left);
        left -= end - gi;
        for (; gi < end; gi++) stepGrid(gi);
        if (gi >= N) phase = 1;
      } else if (phase === 1) {
        const end = Math.min(tablePts.length, ti + left);
        left -= end - ti;
        for (; ti < end; ti++) stepTable(ti);
        if (ti >= tablePts.length) { phase = trials > 0 ? 2 : 3; if (phase === 2) mcInit(); }
      } else {
        if (!mcK.length) { phase = 3; break; }
        while (left > 0 && mcT < trials) {
          mcPick(mcK[mcKi]);
          mcKi++; left--;
          if (mcKi >= mcK.length) { mcCloseTrial(mcT); mcT++; mcKi = 0; }
        }
        if (mcT >= trials) phase = 3;
      }
    }
    return doneUnits();
  }

  function finalize() {
    while (phase < 3) stepBatch(1e9);
    // ---- 逐波束 ----
    const beams = [];
    const rtnVal = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      let partners = 0;                                    // 以 i 为受扰者、耦合非零的施扰波束数
      for (let k = 0; k < n; k++) if (k !== i && (cpl.wCo[i * n + k] > 0 || cpl.wX[i * n + k] > 0)) partners++;
      const row = {
        idx: env.ctx.beamIdx[i], color: env.colorOf[i], segs: (env.scheme.dirs[dir].segs[i] || []).map((s) => ({ f1: s.f1, f2: s.f2, pol: s.pol })),
        assigned: !!cpl.assigned[i], partners, cells: cellCount[i]
      };
      beams.push(row);
    }
    if (dir === 'fwd') {
      // 服务区统计：覆盖内（服务波束且不低于其峰值 eocDb）的格点；无同频干扰的格计 +∞
      const vals = Array.from({ length: n }, () => []), ws = grid.kind === 'user' ? Array.from({ length: n }, () => []) : null;
      for (let k = 0; k < N; k++) {
        if (!cov[k]) continue;
        const v = zv[k];
        if (v !== v) continue;
        vals[srv[k]].push(v);
        if (ws) ws[srv[k]].push(Math.cos(latA[k] * D2R));
      }
      for (let i = 0; i < n; i++) beams[i].fwd = statsOf(vals[i], ws ? ws[i] : null);
    } else {
      for (let j = 0; j < n; j++) {
        if (!cpl.assigned[j]) continue;
        let I = 0, m = 0;
        for (let k = 0; k < n; k++) {
          if (k === j || !cellCount[k]) continue;
          const at = j * n + k;
          let add = 0;
          if (cpl.wCo[at] > 0 && worstCo[at] > -Infinity) add += cpl.wCo[at] * lin(worstCo[at]);
          if (cpl.wX[at] > 0 && worstX[at] > -Infinity) add += cpl.wX[at] * lin(worstX[at]);
          if (add > 0) { I += add; m++; }
        }
        beams[j].rtnWorst = I > 0 ? -10 * LOG10(I) : Infinity;
        beams[j].rtnSources = m;
        if (trials) {
          const v = [];
          for (let t = 0; t < trials; t++) { const x = ciMc[j * trials + t]; if (x === x) v.push(x); }
          beams[j].rtnMc = statsOf(v, null);
          if (beams[j].rtnMc) {
            let s = 0, c = 0;
            for (const x of v) if (x < Infinity) { s += x; c++; }
            beams[j].rtnMc.mean = c ? s / c : Infinity;
          }
        }
        rtnVal[j] = trials ? (beams[j].rtnMc ? beams[j].rtnMc.p50 : NaN) : beams[j].rtnWorst;
      }
      for (let k = 0; k < N; k++) zv[k] = cov[k] ? rtnVal[srv[k]] : NaN;
    }
    // ---- 取值点 ----
    const points = tableRes.map((r) => {
      if (!r) return null;
      if (dir === 'fwd') return r;
      const v = rtnVal[r.servingPos];
      return { ...r, cciDb: Number.isFinite(v) ? v : null, noCoChannel: v === Infinity };
    });
    // ---- 显示用经纬栅格 ----
    const field = grid.kind === 'user' ? userField() : antennaField();
    return {
      ...summaryOf(env, { floorPts: floorPts + (trials ? mcFloor : 0) }),
      grid: grid.kind === 'user'
        ? { kind: 'user', nx: grid.nx, ny: grid.ny, step: grid.step }
        : { kind: 'antenna', nx: grid.nx, ny: grid.ny, dx: grid.dx, dy: grid.dy, coarsen: grid.coarsen },
      nodes: N, valid: okPt.reduce((a, v) => a + v, 0), eocDb: env.eocDb,
      rtnMode: dir === 'rtn' ? rtnMode : null, trials, seed: trials ? seed : null,
      beams, points, field,
      elapsedMs: Date.now() - t0
    };
  }
  // 显示值：+∞（无同频）与无值一律留空
  const disp = (v) => (Number.isFinite(v) ? v : NaN);
  function userField() {
    const xs = new Float64Array(grid.nx), ys = new Float64Array(grid.ny);
    for (let i = 0; i < grid.nx; i++) xs[i] = grid.lon0 + i * grid.step;
    for (let j = 0; j < grid.ny; j++) ys[j] = grid.lat0 + j * grid.step;
    const z = new Float32Array(N);
    let valid = 0;
    for (let k = 0; k < N; k++) { z[k] = disp(zv[k]); if (z[k] === z[k]) valid++; }
    return { xs, ys, nx: grid.nx, ny: grid.ny, z, valid };
  }
  // 天线网格 → 经纬栅格：逐格反算到天线网格坐标，取四邻节点双线性（缺角取最近的有值节点）。
  // 栅格节距按「有值节点数 ≈ 栅格数」定，每边封顶 1200。
  function antennaField() {
    let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity, m = 0;
    for (let k = 0; k < N; k++) {
      if (!okPt[k]) continue;
      m++;
      if (lonA[k] < lo0) lo0 = lonA[k]; if (lonA[k] > lo1) lo1 = lonA[k];
      if (latA[k] < la0) la0 = latA[k]; if (latA[k] > la1) la1 = latA[k];
    }
    if (!m || !(lo1 > lo0) || !(la1 > la0)) return null;
    let step = Math.sqrt((lo1 - lo0) * (la1 - la0) / m);
    const CAP = 1200;
    step = Math.max(step, (lo1 - lo0) / (CAP - 1), (la1 - la0) / (CAP - 1), 1e-4);
    const nx = Math.max(2, Math.floor((lo1 - lo0) / step) + 1), ny = Math.max(2, Math.floor((la1 - la0) / step) + 1);
    const xs = new Float64Array(nx), ys = new Float64Array(ny);
    for (let i = 0; i < nx; i++) xs[i] = lo0 + i * step;
    for (let j = 0; j < ny; j++) ys[j] = la0 + j * step;
    const z = new Float32Array(nx * ny).fill(NaN);
    const gnx = grid.nx, gny = grid.ny;
    const nodeV = (i, j) => disp(zv[j * gnx + i]);
    let valid = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const lon = xs[i], lat = ys[j];
        const P = geodeticToEcef(lon, lat, 0);
        let ex = P[0] - env.S[0], ey = P[1] - env.S[1], ez = P[2] - env.S[2];
        const rs = Math.hypot(ex, ey, ez);
        ex /= rs; ey /= rs; ez /= rs;
        const clat = Math.cos(lat * D2R);
        if (ex * clat * Math.cos(lon * D2R) + ey * clat * Math.sin(lon * D2R) + ez * Math.sin(lat * D2R) > 0) continue;
        const a = ex * env.bx[0] + ey * env.bx[1] + ez * env.bx[2], b = ex * env.by[0] + ey * env.by[1] + ez * env.by[2], c = ex * env.bz[0] + ey * env.bz[1] + ez * env.bz[2];
        const xy = invGridDir(env.ctx.igrid, a, b, c);
        if (!xy) continue;
        const fx = (xy[0] - grid.X0) / grid.dx, fy = (xy[1] - grid.Y0) / grid.dy;
        if (fx < 0 || fy < 0 || fx > gnx - 1 || fy > gny - 1) continue;
        const i0 = Math.min(gnx - 2, Math.floor(fx)), j0 = Math.min(gny - 2, Math.floor(fy));
        const tx = fx - i0, ty = fy - j0;
        const v00 = nodeV(i0, j0), v10 = nodeV(i0 + 1, j0), v01 = nodeV(i0, j0 + 1), v11 = nodeV(i0 + 1, j0 + 1);
        let v;
        if (v00 === v00 && v10 === v10 && v01 === v01 && v11 === v11) v = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
        else v = nodeV(tx < 0.5 ? i0 : i0 + 1, ty < 0.5 ? j0 : j0 + 1);
        if (v === v) { z[j * nx + i] = v; valid++; }
      }
    }
    return { xs, ys, nx, ny, z, valid };
  }

  return { T, n, nodes: N, grid: { kind: grid.kind, nx: grid.nx, ny: grid.ny }, stepBatch, finalize, summary: () => summaryOf(env) };
}

module.exports = {
  SOURCES, MIX_FACTOR, DEFAULT_XPD_DB, DEFAULT_EOC_DB, MAX_POINTS,
  normPol, polRelation, normSegs, unionLen, overlapLen,
  synthFcFromText, normalizeScheme, couplingOf, fwdAtPoint,
  weightedQuantile, statsOf,
  geodeticToEcef, ecefToGeodetic, gridDir, invGridDir, rayEarth,
  cciPoints, createCciRun
};
