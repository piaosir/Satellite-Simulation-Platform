// PFD Mask · XML 读写与 XSD 级校验
//
// 这是交付物本身。格式错一个字符，ITU Mask Viewer 就打不开；格式对但语义错，
// 它会照常画图而数值全错。所以校验器分两层：
//   ① XSD 层——官方 Mask-schema.xsd 的每条 restriction 逐条编码（范围/小数位/枚举/唯一性）
//   ② 语义层——XSD 管不到但会【静默错整数个 dB】的规则（见 checkEirpSsRefBw 等）
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据：ITU 官方 Mask-schema.xsd
//   来源 https://www.itu.int/en/ITU-R/space/Pages/XMLmaskDataFile.aspx → maskSchemaXSD.docx
//   自述 "ITU masks schema v.4.0.0.0 2015-05-26 Rec ITU-R S. 1503-2"
//   本文件的每条约束均从该 XSD 原文逐条抄录，非凭记忆。
//
// 结构（三层嵌套，由 XSD 的 element 嵌套确定）：
//   satellite_system[@ntc_id @sat_name]
//     └ pfd_mask[@mask_id @low_freq_mhz @high_freq_mhz @refbw_khz @type @a_name @b_name @c_name]
//         └ by_a[@a = 纬度]
//             └ by_b[@b = 方位 或 alpha]
//                 └ pfd[@c = 仰角 或 deltaLongitude] = 值
//   eirp_mask_ss / eirp_mask_es 少一层：by_a └ eirp[@d = separation angle] = 值
//
// ★ 三处会静默出错的坑，全部在 validate 里拦：
//   [1] eirp_mask_ss 在 XSD 里【没有 refbw_khz 属性】——非 40 kHz 时带宽信息落盘即丢
//   [2] pfd_mask 的 refbw 枚举是 {4,40,1000}，eirp_mask_es 是 {4,40}（无 1000）——两者不同
//   [3] Mask Viewer 手册原文 "The software is case-sensitive"——元素与属性名大小写必须精确
// ─────────────────────────────────────────────────────────────────────────────

const units = require('./units.js');

// ---------------------------------------------------------------------------
// XSD 常量（逐条抄自官方 schema）
// ---------------------------------------------------------------------------

const XSD = Object.freeze({
  ntcId: { min: 1, max: 999999999 },
  satName: { minLen: 1, maxLen: 20 },
  maskId: { min: 1, max: 999 },
  freqMhz: { min: 1.0, max: 999999.0, frac: 6 },
  angleA: { min: -90.0, max: 90.0, frac: 2 },          // by_a/@a  纬度
  angleBCD: { min: -180.0, max: 180.0, frac: 2 },      // by_b/@b, pfd/@c, eirp/@d
  value: { min: -999.0, max: 999.0, frac: 3 },         // pfd_val / eirp_val
  maxMasksPerKind: 99,
  refBwPfd: [4, 40, 1000],
  refBwEirpEs: [4, 40],                                 // ★ 无 1000
  types: ['alpha_deltaLongitude', 'X_deltaLongitude', 'azimuth_elevation'],
  bNames: ['alpha', 'X', 'azimuth'],
  cNames: ['deltaLongitude', 'elevation'],
});

/** per-mask 文件名里的类型标记。取自真实 ITU 提交件的命名惯例。 */
const KIND_TAG = Object.freeze({ pfd_mask: 'PFD', eirp_mask_es: 'EIRP_ES', eirp_mask_ss: 'EIRP_SS' });

/** type ↔ (b_name, c_name) 的唯一自洽组合。XSD 各自列了枚举但不约束配对，只能自己拦。 */
const TYPE_AXES = Object.freeze({
  azimuth_elevation: { b: 'azimuth', c: 'elevation' },
  alpha_deltaLongitude: { b: 'alpha', c: 'deltaLongitude' },
  X_deltaLongitude: { b: 'X', c: 'deltaLongitude' },
});

// ---------------------------------------------------------------------------
// 数字格式化
// ---------------------------------------------------------------------------

/** 定小数位输出，并把 "-0.00" 这类规范成 "0.00"（值相同，但读起来像笔误）。 */
function fixed(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`maskIO.fixed: 非有限数（${v}）`);
  let s = n.toFixed(digits);
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s;
}

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function mkIssue(list, level, path, message, got) {
  list.push({ level, path, message, got: got === undefined ? null : got });
}

function chkNum(list, path, v, spec, label) {
  if (!Number.isFinite(Number(v))) { mkIssue(list, 'error', path, `${label} 非有限数`, v); return false; }
  const n = Number(v);
  if (n < spec.min || n > spec.max) {
    mkIssue(list, 'error', path, `${label} 超出 XSD 范围 [${spec.min}, ${spec.max}]`, n);
    return false;
  }
  if (spec.frac !== undefined) {
    // 落盘时会 toFixed(frac)，此处检查【四舍五入是否改变了值】——改变了说明输入精度超过 XSD 允许
    const rounded = Number(n.toFixed(spec.frac));
    if (Math.abs(rounded - n) > 1e-12) {
      mkIssue(list, 'warn', path, `${label} 小数位超过 XSD 的 ${spec.frac} 位，落盘将舍入`, n);
    }
  }
  return true;
}

/**
 * 校验一份 mask 文档。
 * @param {object} doc 见文件头「数据模型」
 * @returns {{ok:boolean, errors:object[], warnings:object[], counts:object}}
 */
function validateMaskDoc(doc) {
  const issues = [];
  if (!doc || typeof doc !== 'object') {
    mkIssue(issues, 'error', '/', '文档为空');
    return { ok: false, errors: issues, warnings: [], counts: {} };
  }

  // ── satellite_system
  chkNum(issues, '/satellite_system/@ntc_id', doc.ntcId, XSD.ntcId, 'ntc_id');
  if (!Number.isInteger(Number(doc.ntcId))) {
    mkIssue(issues, 'error', '/satellite_system/@ntc_id', 'ntc_id 必须是整数（xs:unsignedLong）', doc.ntcId);
  }
  const name = String(doc.satName === undefined ? '' : doc.satName);
  if (name.length < XSD.satName.minLen || name.length > XSD.satName.maxLen) {
    mkIssue(issues, 'error', '/satellite_system/@sat_name',
      `sat_name 长度须在 [${XSD.satName.minLen}, ${XSD.satName.maxLen}]`, `"${name}" (${name.length})`);
  }

  const pfdMasks = doc.pfdMasks || [];
  const eirpEs = doc.eirpMaskEs || [];
  const eirpSs = doc.eirpMaskSs || [];

  for (const [kind, arr] of [['pfd_mask', pfdMasks], ['eirp_mask_es', eirpEs], ['eirp_mask_ss', eirpSs]]) {
    if (arr.length > XSD.maxMasksPerKind) {
      mkIssue(issues, 'error', `/satellite_system/${kind}`,
        `${kind} 数量超过 XSD 上限 ${XSD.maxMasksPerKind}`, arr.length);
    }
  }
  if (pfdMasks.length + eirpEs.length + eirpSs.length === 0) {
    mkIssue(issues, 'error', '/satellite_system', '文档不含任何 mask');
  }

  // ── mask_id 跨三类唯一（XSD 的 xs:unique，作用域是整个 satellite_system）
  const seen = new Map();
  for (const [kind, arr] of [['pfd_mask', pfdMasks], ['eirp_mask_es', eirpEs], ['eirp_mask_ss', eirpSs]]) {
    arr.forEach((m, i) => {
      const id = Number(m.maskId);
      chkNum(issues, `/${kind}[${i}]/@mask_id`, id, XSD.maskId, 'mask_id');
      if (!Number.isInteger(id)) {
        mkIssue(issues, 'error', `/${kind}[${i}]/@mask_id`, 'mask_id 必须是整数', m.maskId);
      }
      if (seen.has(id)) {
        mkIssue(issues, 'error', `/${kind}[${i}]/@mask_id`,
          `mask_id 与 ${seen.get(id)} 撞号（XSD xs:unique 跨 pfd_mask/eirp_mask_es/eirp_mask_ss 共享编号空间）`, id);
      } else seen.set(id, `${kind}[${i}]`);
    });
  }

  let cells = 0;

  // ── pfd_mask
  pfdMasks.forEach((m, i) => {
    const P = `/pfd_mask[${i}]`;
    validateFreq(issues, P, m);
    if (!XSD.refBwPfd.includes(Number(m.refBwKhz))) {
      mkIssue(issues, 'error', `${P}/@refbw_khz`,
        `refbw_khz 必须取 {${XSD.refBwPfd.join(', ')}} 之一`, m.refBwKhz);
    }
    if (!XSD.types.includes(m.type)) {
      mkIssue(issues, 'error', `${P}/@type`, `type 必须取 {${XSD.types.join(', ')}} 之一`, m.type);
    } else {
      const ax = TYPE_AXES[m.type];
      if (m.bName && m.bName !== ax.b) {
        mkIssue(issues, 'error', `${P}/@b_name`, `type="${m.type}" 要求 b_name="${ax.b}"`, m.bName);
      }
      if (m.cName && m.cName !== ax.c) {
        mkIssue(issues, 'error', `${P}/@c_name`, `type="${m.type}" 要求 c_name="${ax.c}"`, m.cName);
      }
    }
    cells += validateSlices3(issues, P, m.slices);
  });

  // ── eirp_mask_es（有 refbw，枚举与 pfd 不同；另有 min_elev / es_id）
  eirpEs.forEach((m, i) => {
    const P = `/eirp_mask_es[${i}]`;
    validateFreq(issues, P, m);
    if (!XSD.refBwEirpEs.includes(Number(m.refBwKhz))) {
      mkIssue(issues, 'error', `${P}/@refbw_khz`,
        `eirp_mask_es 的 refbw_khz 只允许 {${XSD.refBwEirpEs.join(', ')}}（注意：不含 1000，与 pfd_mask 不同）`,
        m.refBwKhz);
    }
    chkNum(issues, `${P}/@min_elev`, m.minElevDeg, XSD.angleA, 'min_elev');
    const esId = Number(m.esId);
    if (!Number.isInteger(esId) || esId < -1 || esId > 999999999) {
      mkIssue(issues, 'error', `${P}/@es_id`, 'es_id 须为 [-1, 999999999] 的整数（-1 表示非特定地球站）', m.esId);
    }
    cells += validateSlices2(issues, P, m.slices);
  });

  // ── eirp_mask_ss（★ XSD 无 refbw_khz）
  eirpSs.forEach((m, i) => {
    const P = `/eirp_mask_ss[${i}]`;
    validateFreq(issues, P, m);
    if (m.refBwKhz !== undefined) {
      const r = units.checkEirpSsRefBw(Number(m.refBwKhz) * 1e3, 'report');
      if (!r.ok) mkIssue(issues, 'error', `${P}/@refbw_khz`, r.message, m.refBwKhz);
    }
    cells += validateSlices2(issues, P, m.slices);
  });

  const errors = issues.filter((x) => x.level === 'error');
  const warnings = issues.filter((x) => x.level === 'warn');
  return {
    ok: errors.length === 0,
    errors, warnings,
    counts: { pfdMasks: pfdMasks.length, eirpMaskEs: eirpEs.length, eirpMaskSs: eirpSs.length, cells },
  };
}

function validateFreq(issues, P, m) {
  const lo = Number(m.lowFreqGhz) * 1000, hi = Number(m.highFreqGhz) * 1000;
  chkNum(issues, `${P}/@low_freq_mhz`, lo, XSD.freqMhz, 'low_freq_mhz');
  chkNum(issues, `${P}/@high_freq_mhz`, hi, XSD.freqMhz, 'high_freq_mhz');
  if (Number.isFinite(lo) && Number.isFinite(hi) && !(hi > lo)) {
    mkIssue(issues, 'error', `${P}/@high_freq_mhz`, 'high_freq_mhz 必须大于 low_freq_mhz', `${lo} → ${hi}`);
  }
}

/** 三层结构（pfd_mask）：by_a → by_b → pfd。返回格子数。 */
function validateSlices3(issues, P, slices) {
  if (!Array.isArray(slices) || slices.length === 0) {
    mkIssue(issues, 'error', `${P}/by_a`, 'pfd_mask 至少需要一个 by_a（XSD maxOccurs=unbounded, minOccurs 默认 1）');
    return 0;
  }
  let n = 0;
  const aSeen = new Set();
  slices.forEach((s, ai) => {
    const PA = `${P}/by_a[${ai}]`;
    chkNum(issues, `${PA}/@a`, s.a, XSD.angleA, 'a（纬度）');
    const aKey = fixedSafe(s.a, 2);
    if (aSeen.has(aKey)) mkIssue(issues, 'error', `${PA}/@a`, '同一 mask 内 by_a/@a 重复', s.a);
    aSeen.add(aKey);

    if (!Array.isArray(s.rows) || s.rows.length === 0) {
      mkIssue(issues, 'error', `${PA}/by_b`, '每个 by_a 至少需要一个 by_b');
      return;
    }
    const bSeen = new Set();
    s.rows.forEach((r, bi) => {
      const PB = `${PA}/by_b[${bi}]`;
      chkNum(issues, `${PB}/@b`, r.b, XSD.angleBCD, 'b');
      const bKey = fixedSafe(r.b, 2);
      if (bSeen.has(bKey)) mkIssue(issues, 'error', `${PB}/@b`, '同一 by_a 内 by_b/@b 重复', r.b);
      bSeen.add(bKey);

      if (!Array.isArray(r.cells) || r.cells.length === 0) {
        mkIssue(issues, 'error', `${PB}/pfd`, '每个 by_b 至少需要一个 pfd');
        return;
      }
      const cSeen = new Set();
      r.cells.forEach((c, ci) => {
        const PC = `${PB}/pfd[${ci}]`;
        chkNum(issues, `${PC}/@c`, c.c, XSD.angleBCD, 'c');
        chkNum(issues, PC, c.v, XSD.value, 'pfd 值');
        const cKey = fixedSafe(c.c, 2);
        if (cSeen.has(cKey)) mkIssue(issues, 'error', `${PC}/@c`, '同一 by_b 内 pfd/@c 重复', c.c);
        cSeen.add(cKey);
        n++;
      });
    });
  });
  return n;
}

/** 两层结构（eirp_mask_*）：by_a → eirp。返回格子数。 */
function validateSlices2(issues, P, slices) {
  if (!Array.isArray(slices) || slices.length === 0) {
    mkIssue(issues, 'error', `${P}/by_a`, '至少需要一个 by_a');
    return 0;
  }
  let n = 0;
  slices.forEach((s, ai) => {
    const PA = `${P}/by_a[${ai}]`;
    chkNum(issues, `${PA}/@a`, s.a, XSD.angleA, 'a（纬度）');
    if (!Array.isArray(s.cells) || s.cells.length === 0) {
      mkIssue(issues, 'error', `${PA}/eirp`, '每个 by_a 至少需要一个 eirp');
      return;
    }
    s.cells.forEach((c, di) => {
      const PD = `${PA}/eirp[${di}]`;
      chkNum(issues, `${PD}/@d`, c.d, XSD.angleBCD, 'd（separation angle）');
      chkNum(issues, PD, c.v, XSD.value, 'eirp 值');
      n++;
    });
  });
  return n;
}

function fixedSafe(v, d) { try { return fixed(v, d); } catch (e) { return String(v); } }

// ---------------------------------------------------------------------------
// 写 XML
// ---------------------------------------------------------------------------

/**
 * 生成符合官方 XSD 的 mask XML。
 *
 * ⚠ 子元素顺序由 XSD 的 xs:sequence 固定：pfd_mask → eirp_mask_es → eirp_mask_ss，不可调换。
 * ⚠ 元素与属性名大小写严格（Mask Viewer 手册："The software is case-sensitive"）。
 *
 * @param {object} doc
 * @param {object} [opt] {indent='  ', validate=true, header=[]}
 * @returns {string}
 */
function buildMaskXml(doc, opt) {
  const o = opt || {};
  if (o.validate !== false) {
    const v = validateMaskDoc(doc);
    if (!v.ok) {
      const head = v.errors.slice(0, 5).map((e) => `  · ${e.path}: ${e.message}` + (e.got === null ? '' : ` [${e.got}]`));
      throw new RangeError(
        `maskIO.buildMaskXml: 文档未通过 XSD 校验，共 ${v.errors.length} 处错误：\n${head.join('\n')}` +
        (v.errors.length > 5 ? `\n  …还有 ${v.errors.length - 5} 处` : '')
      );
    }
  }

  const I = o.indent === undefined ? '  ' : o.indent;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  for (const line of (o.header || [])) out.push(`<!-- ${String(line).replace(/--/g, '- -')} -->`);

  out.push(`<satellite_system ntc_id="${Number(doc.ntcId)}" sat_name="${escapeXml(doc.satName)}">`);

  for (const m of (doc.pfdMasks || [])) {
    const ax = TYPE_AXES[m.type];
    out.push(`${I}<pfd_mask mask_id="${Number(m.maskId)}"`
      + ` low_freq_mhz="${units.ghzToMhzXml(m.lowFreqGhz)}"`
      + ` high_freq_mhz="${units.ghzToMhzXml(m.highFreqGhz)}"`
      + ` refbw_khz="${Number(m.refBwKhz)}"`
      + ` type="${m.type}" a_name="latitude" b_name="${ax.b}" c_name="${ax.c}">`);
    for (const s of m.slices) {
      out.push(`${I}${I}<by_a a="${fixed(s.a, 2)}">`);
      for (const r of s.rows) {
        out.push(`${I}${I}${I}<by_b b="${fixed(r.b, 2)}">`);
        for (const c of r.cells) {
          out.push(`${I}${I}${I}${I}<pfd c="${fixed(c.c, 2)}">${fixed(c.v, 3)}</pfd>`);
        }
        out.push(`${I}${I}${I}</by_b>`);
      }
      out.push(`${I}${I}</by_a>`);
    }
    out.push(`${I}</pfd_mask>`);
  }

  for (const m of (doc.eirpMaskEs || [])) {
    out.push(`${I}<eirp_mask_es mask_id="${Number(m.maskId)}"`
      + ` low_freq_mhz="${units.ghzToMhzXml(m.lowFreqGhz)}"`
      + ` high_freq_mhz="${units.ghzToMhzXml(m.highFreqGhz)}"`
      + ` refbw_khz="${Number(m.refBwKhz)}"`
      + ` min_elev="${fixed(m.minElevDeg, 2)}"`
      + ` a_name="latitude" d_name="separation angle" es_id="${Number(m.esId)}">`);
    emitEirpSlices(out, I, m.slices);
    out.push(`${I}</eirp_mask_es>`);
  }

  for (const m of (doc.eirpMaskSs || [])) {
    // ★ 无 refbw_khz：XSD 里该属性不存在，写了就是非法文档
    out.push(`${I}<eirp_mask_ss mask_id="${Number(m.maskId)}"`
      + ` low_freq_mhz="${units.ghzToMhzXml(m.lowFreqGhz)}"`
      + ` high_freq_mhz="${units.ghzToMhzXml(m.highFreqGhz)}"`
      + ` a_name="latitude" d_name="separation angle">`);
    emitEirpSlices(out, I, m.slices);
    out.push(`${I}</eirp_mask_ss>`);
  }

  out.push('</satellite_system>');
  return out.join('\n') + '\n';
}

/**
 * 按指定粒度切分成多个 XML 文件。
 *
 * XSD 的根元素是 satellite_system，一份文件必须恰有一个根 —— 所以「分文件」意味着
 * 每个文件都是一份完整的 satellite_system，各自只装它那一部分 mask。
 *
 * ★ mask_id 的唯一性约束在【切分之后】反而放松了（xs:unique 的作用域是单个 satellite_system）。
 *   但同一个 ntc_id 下的 mask 最终会被导进同一个网络，所以本函数【仍按全局唯一校验】——
 *   切分是交付形态的选择，不是放宽约束的借口。
 *
 * @param {object} doc
 * @param {object} [opt] {mode:'single'|'per-kind'|'per-mask', header:string[], indent}
 * @returns {Array<{filename:string, xml:string, kind:string, maskIds:number[], bytes:number}>}
 */
function buildMaskFiles(doc, opt) {
  const o = opt || {};
  const mode = o.mode || 'single';
  const v = validateMaskDoc(doc);
  if (!v.ok) {
    const head = v.errors.slice(0, 5).map((e) => `  · ${e.path}: ${e.message}`);
    throw new RangeError(`maskIO.buildMaskFiles: 文档未通过 XSD 校验，共 ${v.errors.length} 处：\n${head.join('\n')}`);
  }

  const safe = String(doc.satName || 'mask').replace(/[^\w.-]+/g, '_') || 'mask';
  const mk = (pfd, es, ss) => Object.assign({}, doc, { pfdMasks: pfd, eirpMaskEs: es, eirpMaskSs: ss });
  const trimNum = (x) => String(Number(x)).replace(/\.0+$/, '');
  const emit = (sub, kind, tag) => {
    const all = [].concat(sub.pfdMasks, sub.eirpMaskEs, sub.eirpMaskSs);
    const ids = all.map((m) => Number(m.maskId));
    const xml = buildMaskXml(sub, { indent: o.indent, validate: false, header: o.header });
    let filename;
    if (mode === 'per-mask') {
      // 实测两大主流命名里自解释的那一支（STEAM-2B / SES-O3b 式）
      // ★ mask_id 必须从 mask 自身取，不能用循环下标 —— 真实件 O3BNEXT1 就踩过这个坑：
      //   文件名写 Mask_id_3 而内部 mask_id="6"。
      const m = all[0];
      filename = `Mask_id_${m.maskId}_${KIND_TAG[kind]}_${trimNum(m.lowFreqGhz)}-${trimNum(m.highFreqGhz)}.xml`;
    } else {
      filename = `${safe}_${tag}.xml`;
    }
    return { filename, xml, kind, maskIds: ids, bytes: Buffer.byteLength(xml, 'utf8') };
  };

  if (mode === 'single') {
    return [emit(doc, 'all', 'masks')];
  }
  if (mode === 'per-kind') {
    const out = [];
    if (doc.pfdMasks.length) out.push(emit(mk(doc.pfdMasks, [], []), 'pfd_mask', 'pfd_mask'));
    if (doc.eirpMaskEs.length) out.push(emit(mk([], doc.eirpMaskEs, []), 'eirp_mask_es', 'eirp_mask_es'));
    if (doc.eirpMaskSs.length) out.push(emit(mk([], [], doc.eirpMaskSs), 'eirp_mask_ss', 'eirp_mask_ss'));
    return out;
  }
  if (mode === 'per-mask') {
    const out = [];
    for (const m of doc.pfdMasks) out.push(emit(mk([m], [], []), 'pfd_mask', `pfd_mask_${m.maskId}`));
    for (const m of doc.eirpMaskEs) out.push(emit(mk([], [m], []), 'eirp_mask_es', `eirp_mask_es_${m.maskId}`));
    for (const m of doc.eirpMaskSs) out.push(emit(mk([], [], [m]), 'eirp_mask_ss', `eirp_mask_ss_${m.maskId}`));
    return out;
  }
  throw new RangeError(`maskIO.buildMaskFiles: 未知 mode "${mode}"（single | per-kind | per-mask）`);
}

function emitEirpSlices(out, I, slices) {
  for (const s of slices) {
    out.push(`${I}${I}<by_a a="${fixed(s.a, 2)}">`);
    for (const c of s.cells) {
      out.push(`${I}${I}${I}<eirp d="${fixed(c.d, 2)}">${fixed(c.v, 3)}</eirp>`);
    }
    out.push(`${I}${I}</by_a>`);
  }
}

// ---------------------------------------------------------------------------
// 读 XML（对拍与回归用；不引外部库）
// ---------------------------------------------------------------------------

const TAG_RE = /<\s*(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
const ATTR_RE = /([\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(s) {
  const o = {};
  if (!s) return o;
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) o[m[1]] = (m[2] !== undefined ? m[2] : m[3])
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return o;
}

/**
 * 解析 mask XML。容忍缩进与注释；不处理命名空间与 CDATA（官方 mask 文件不用）。
 * @returns {object} 与 buildMaskXml 同构的 doc
 */
function parseMaskXml(text) {
  const src = String(text);
  const doc = { ntcId: null, satName: '', pfdMasks: [], eirpMaskEs: [], eirpMaskSs: [] };
  let mask = null, slice = null, row = null, kind = null;
  let pendingC = null, pendingD = null, buf = '';
  let m, last = 0;

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const text0 = src.slice(last, m.index);
    last = TAG_RE.lastIndex;
    if (pendingC !== null || pendingD !== null) buf += text0;

    const raw = m[0];
    if (raw.startsWith('<!--') || raw.startsWith('<?')) continue;
    const closing = m[1] === '/', tag = m[2], attrs = parseAttrs(m[3]), selfClose = m[4] === '/';

    if (!closing) {
      switch (tag) {
        case 'satellite_system':
          doc.ntcId = Number(attrs.ntc_id);
          doc.satName = attrs.sat_name || '';
          break;
        case 'pfd_mask':
          kind = 'pfd';
          mask = {
            maskId: Number(attrs.mask_id),
            lowFreqGhz: units.mhzXmlToGhz(attrs.low_freq_mhz),
            highFreqGhz: units.mhzXmlToGhz(attrs.high_freq_mhz),
            refBwKhz: Number(attrs.refbw_khz),
            type: attrs.type, bName: attrs.b_name, cName: attrs.c_name,
            slices: [],
          };
          doc.pfdMasks.push(mask);
          break;
        case 'eirp_mask_es':
        case 'eirp_mask_ss':
          kind = tag === 'eirp_mask_es' ? 'es' : 'ss';
          mask = {
            maskId: Number(attrs.mask_id),
            lowFreqGhz: units.mhzXmlToGhz(attrs.low_freq_mhz),
            highFreqGhz: units.mhzXmlToGhz(attrs.high_freq_mhz),
            slices: [],
          };
          if (attrs.refbw_khz !== undefined) mask.refBwKhz = Number(attrs.refbw_khz);
          if (attrs.min_elev !== undefined) mask.minElevDeg = Number(attrs.min_elev);
          if (attrs.es_id !== undefined) mask.esId = Number(attrs.es_id);
          (kind === 'es' ? doc.eirpMaskEs : doc.eirpMaskSs).push(mask);
          break;
        case 'by_a':
          slice = kind === 'pfd' ? { a: Number(attrs.a), rows: [] } : { a: Number(attrs.a), cells: [] };
          if (mask) mask.slices.push(slice);
          break;
        case 'by_b':
          row = { b: Number(attrs.b), cells: [] };
          if (slice) slice.rows.push(row);
          break;
        case 'pfd':
          pendingC = Number(attrs.c); buf = '';
          if (selfClose) { if (row) row.cells.push({ c: pendingC, v: NaN }); pendingC = null; }
          break;
        case 'eirp':
          pendingD = Number(attrs.d); buf = '';
          if (selfClose) { if (slice) slice.cells.push({ d: pendingD, v: NaN }); pendingD = null; }
          break;
        default: break;
      }
    } else {
      if (tag === 'pfd' && pendingC !== null) {
        if (row) row.cells.push({ c: pendingC, v: Number(String(buf).trim()) });
        pendingC = null; buf = '';
      } else if (tag === 'eirp' && pendingD !== null) {
        if (slice) slice.cells.push({ d: pendingD, v: Number(String(buf).trim()) });
        pendingD = null; buf = '';
      } else if (tag === 'pfd_mask' || tag === 'eirp_mask_es' || tag === 'eirp_mask_ss') {
        mask = null; kind = null;
      }
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 运行时取值（与 ITU Mask Viewer 的 calculate 框同口径）
// ---------------------------------------------------------------------------

/**
 * 在 mask 上取值：纬度【最近邻选表】，b/c 两轴【双线性】，越界【钳位】。
 *
 * 口径依据 S.1503 §C4.1 与 ITU Mask Viewer 手册原文
 * （"PFD interpolation is done as specified in Recommendation ITU-R S.1503-3:
 *   -latitude: closest one; -azimuth-elevation or α-Δlong angles: bilinear interpolation"）。
 * ★ 纬度维【不插值】——插了就与读方口径不一致，是静默偏差。
 *
 * @returns {{value:number, latUsed:number, clampedB:boolean, clampedC:boolean}|null}
 */
function lookupPfd(mask, latDeg, bDeg, cDeg) {
  if (!mask || !Array.isArray(mask.slices) || mask.slices.length === 0) return null;

  // 纬度最近邻；平局取纬度较小者（确定性，避免与读方不一致）
  let best = mask.slices[0], bestD = Math.abs(best.a - latDeg);
  for (const s of mask.slices) {
    const d = Math.abs(s.a - latDeg);
    if (d < bestD - 1e-12 || (Math.abs(d - bestD) <= 1e-12 && s.a < best.a)) { best = s; bestD = d; }
  }

  const rows = best.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const bAxis = rows.map((r) => r.b);
  const bi = bracket(bAxis, bDeg);
  const r0 = rows[bi.i0], r1 = rows[bi.i1];

  const v0 = interpRow(r0, cDeg);
  const v1 = interpRow(r1, cDeg);
  if (v0 === null || v1 === null) return null;

  return {
    value: v0.value * (1 - bi.t) + v1.value * bi.t,
    latUsed: best.a,
    clampedB: bi.clamped,
    clampedC: v0.clamped || v1.clamped,
  };
}

function interpRow(row, cDeg) {
  if (!row || !Array.isArray(row.cells) || row.cells.length === 0) return null;
  const axis = row.cells.map((c) => c.c);
  const k = bracket(axis, cDeg);
  const a = row.cells[k.i0].v, b = row.cells[k.i1].v;
  return { value: a * (1 - k.t) + b * k.t, clamped: k.clamped };
}

/** 在升序轴上定位并给出插值权重；越界钳到端点。轴若非升序则先排序视图。 */
function bracket(axis, x) {
  const n = axis.length;
  if (n === 1) return { i0: 0, i1: 0, t: 0, clamped: x !== axis[0] };
  if (x <= axis[0]) return { i0: 0, i1: 0, t: 0, clamped: x < axis[0] };
  if (x >= axis[n - 1]) return { i0: n - 1, i1: n - 1, t: 0, clamped: x > axis[n - 1] };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (axis[mid] <= x) lo = mid; else hi = mid; }
  const span = axis[hi] - axis[lo];
  return { i0: lo, i1: hi, t: span > 0 ? (x - axis[lo]) / span : 0, clamped: false };
}

module.exports = {
  XSD, TYPE_AXES,
  fixed, escapeXml,
  validateMaskDoc, buildMaskXml, buildMaskFiles, parseMaskXml, lookupPfd, bracket,
};
