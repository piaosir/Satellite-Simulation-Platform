// PFD Mask · 单位与量纲守卫
//
// 这个模块存在的唯一理由：**mask 里的单位错，全都是静默的**。
//
// 三处已知的静默坑，每一处都「通过 schema 校验、看不出形状异常、只是整体平移」：
//   ① grdSampler 的 pathLoss:'absolute' 用 km 算扩散损耗且不含发射功率 → 直接当 PFD 用偏高 60.000 dB
//   ② 改参考带宽时 EIRP / PFD 数值不跟着换算 → C 段错 10 dB、Q/V 段错 13.979 dB
//   ③ eirp_mask_ss 在官方 XSD 里【没有 refbw_khz 属性】→ 非 40 kHz 时带宽信息丢失，读方按 40 kHz 解释
//
// 对策不是「小心一点」，是让裸数字没法在模块之间流动：
//   · 功率一律用 {dbw, bwHz} 二元组（绝对功率 + 它所在的带宽），换算只能走本模块
//   · 距离一律用米，且 spreadingLossDb 对「像是 km 的数」直接抛异常——传错宁可炸，不许算
//   · GRD 的绝对值只能过 grdAbsoluteToPfdPerHz 这一个口，配套 lint 禁止别处引用
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据
//   ITU-R S.1503-4 §C2.3.1   pfd_co_i = P_i + G_i − 10 lg(4πd²)，聚合按功率相加
//   ITU-R S.1503-4 §C4.1     读方在 mask 未声明参考带宽时的默认口径
//   官方 maskSchema (v4.0.0.0)  pfd_mask 有 refbw_khz；eirp_mask_ss【无】该属性
//   RR Art.22                参考带宽随频段：Ku 常用 40 kHz，Ka/Q/V 部分档 1 MHz
// ─────────────────────────────────────────────────────────────────────────────

const LOG10 = Math.log10;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** XSD 与 §C4.1 的默认参考带宽（Hz）。mask 没写 refbw 时读方就按这个解释。 */
const DEFAULT_REF_BW_HZ = 40e3;

/**
 * spreadingLossDb 的距离合理性下界（m）。
 * 取 100 km：最低的 LEO 也在 160 km 以上，而斜距恒 ≥ 轨道高度，所以任何合法输入都远超它。
 * 传了 900（本意 900 km）这类数会落在下界以内 → 抛异常。这是 ① 号坑的第一道闸。
 */
const MIN_SLANT_RANGE_M = 1e5;

/** 同上的上界（m）：GSO 斜距最大约 41 679 km，留一倍余量。HEO 远地点另行放宽。 */
const MAX_SLANT_RANGE_M = 1e9;

// ---------------------------------------------------------------------------
// {dbw, bwHz} 二元组
// ---------------------------------------------------------------------------

/**
 * 造一个「带宽标注的功率」。
 * @param {number} dbw   绝对功率或功率密度的数值（dBW，或 dBW/m² —— 本模块不区分面密度，
 *                       因为除以面积不影响带宽换算，两者的带宽代数完全相同）
 * @param {number} bwHz  该数值所在的带宽（Hz）。**必须显式给**，没有默认值。
 */
function spec(dbw, bwHz) {
  const p = Number(dbw), b = Number(bwHz);
  if (!Number.isFinite(p)) throw new TypeError(`units.spec: dbw 非有限数（${dbw}）`);
  if (!(b > 0) || !Number.isFinite(b)) throw new TypeError(`units.spec: bwHz 必须为正有限数（${bwHz}）`);
  return { dbw: p, bwHz: b };
}

/** 是不是一个合法的 {dbw, bwHz}。用于函数入口断言。 */
function isSpec(s) {
  return !!s && typeof s === 'object'
    && Number.isFinite(s.dbw) && Number.isFinite(s.bwHz) && s.bwHz > 0;
}

function assertSpec(s, where) {
  if (!isSpec(s)) throw new TypeError(`${where || 'units'}: 期望 {dbw,bwHz} 二元组，收到 ${JSON.stringify(s)}`);
  return s;
}

/**
 * 换到另一个带宽，**保持总功率不变**（谱密度平坦假设）。
 * 这是「同一份功率换个带宽口径表达」，不是「改了发射功率」。
 */
function rescale(s, toBwHz) {
  assertSpec(s, 'units.rescale');
  const to = Number(toBwHz);
  if (!(to > 0)) throw new TypeError(`units.rescale: toBwHz 必须为正（${toBwHz}）`);
  return { dbw: s.dbw + 10 * LOG10(to / s.bwHz), bwHz: to };
}

/** 取每 Hz 的值（dBW/Hz）。 */
function perHz(s) {
  assertSpec(s, 'units.perHz');
  return s.dbw - 10 * LOG10(s.bwHz);
}

/** 由每 Hz 的值造二元组。 */
function fromPerHz(dbwPerHz, bwHz) {
  const v = Number(dbwPerHz), b = Number(bwHz);
  if (!Number.isFinite(v)) throw new TypeError(`units.fromPerHz: 非有限数（${dbwPerHz}）`);
  if (!(b > 0)) throw new TypeError(`units.fromPerHz: bwHz 必须为正（${bwHz}）`);
  return { dbw: v + 10 * LOG10(b), bwHz: b };
}

/** 取「每参考带宽」的值（dBW/refBW）——落盘与出图用的口径。 */
function perRefBw(s, refBwHz) {
  return rescale(s, refBwHz === undefined ? DEFAULT_REF_BW_HZ : refBwHz).dbw;
}

/**
 * 换参考带宽时数值该动多少（dB）。
 * 显式导出是为了让 UI 能把这个数【打给用户看】——②号坑的显式化：
 * 用户把 40 kHz 改成 1 MHz 时，界面要当场告诉他「电平将 +13.979 dB」，而不是悄悄换个单位标签。
 */
function refBwScaleDb(fromBwHz, toBwHz) {
  const a = Number(fromBwHz), b = Number(toBwHz);
  if (!(a > 0) || !(b > 0)) throw new TypeError('units.refBwScaleDb: 带宽必须为正');
  return 10 * LOG10(b / a);
}

// ---------------------------------------------------------------------------
// 扩散损耗 —— ①号坑的正门
// ---------------------------------------------------------------------------

/**
 * 自由空间扩散损耗 10·lg(4πd²)，**d 必须是米**（S.1503-4 §C2.3.1）。
 *
 * 对「看起来像 km 的数」直接抛异常，不做单位猜测：
 * 猜错的代价是 60 dB 且完全静默，而抛异常的代价只是改一行调用。
 *
 * @param {number} dMeters 斜距（m）
 * @returns {number} dB（正数，需从 EIRP 里减去）
 */
function spreadingLossDb(dMeters) {
  const d = Number(dMeters);
  if (!Number.isFinite(d)) throw new TypeError(`units.spreadingLossDb: 非有限数（${dMeters}）`);
  if (d < MIN_SLANT_RANGE_M) {
    throw new RangeError(
      `units.spreadingLossDb: 距离 ${d} m 小于下界 ${MIN_SLANT_RANGE_M} m。` +
      `本函数只收【米】——若你手上是 km，乘 1000 再传。` +
      `（用 km 直接算会让 PFD 偏高 60.000 dB，且完全静默）`
    );
  }
  if (d > MAX_SLANT_RANGE_M) {
    throw new RangeError(`units.spreadingLossDb: 距离 ${d} m 超过上界 ${MAX_SLANT_RANGE_M} m`);
  }
  return 10 * LOG10(4 * Math.PI * d * d);
}

/**
 * PFD（每 Hz）：pfd = eirpDensity + gain − 10lg(4πd²)   —— S.1503-4 §C2.3.1 的 pfd_co_i
 * @param {number} eirpDbwPerHz 该波束朝该方向的 EIRP 谱密度（dBW/Hz）
 * @param {number} gainDbi      —— 注意：若 eirp 已含天线增益，这里传 0，别重复计
 * @param {number} dMeters      斜距（m）
 * @returns {number} dBW/m²/Hz
 */
function pfdPerHz(eirpDbwPerHz, gainDbi, dMeters) {
  const e = Number(eirpDbwPerHz), g = Number(gainDbi) || 0;
  if (!Number.isFinite(e)) throw new TypeError(`units.pfdPerHz: eirp 非有限数（${eirpDbwPerHz}）`);
  return e + g - spreadingLossDb(dMeters);
}

/**
 * 功率域聚合：多个 PFD 贡献相加（S.1503-4 §C2.3.1 的 Σ over Nco + Σ over Ncross）。
 * 取 max 是错的——§C2.3.1 明写求和。在 50 波束下取 max 会低估，产出**不安全**的 mask。
 * @param {number[]} pfdsDb 同一口径下的 PFD 值（dB）
 */
function sumDb(pfdsDb) {
  if (!Array.isArray(pfdsDb) || pfdsDb.length === 0) return null;
  let acc = 0;
  for (const v of pfdsDb) {
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    acc += Math.pow(10, x / 10);
  }
  return acc > 0 ? 10 * LOG10(acc) : null;
}

// ---------------------------------------------------------------------------
// GRD 绝对值的唯一转换口 —— ①号坑的正门之二
// ---------------------------------------------------------------------------

/**
 * grdSampler 的 pathLoss:'absolute' 与 PFD 的差额（dB）。
 *
 * grdSampler.js:141 走的是 `-10·log10(4π·rs²)`，而 rs 的单位是 **km**
 * （常量 A = 6378.137 在 grdSampler.js:12，整套几何都是 km）。
 * 用米算应该低 10·lg(1000²) = 60.000 dB。
 *
 * 所以 GRD 的 absolute 值不是 PFD，两者差这个常数——而且它还**不含发射功率**。
 */
const GRD_ABSOLUTE_TO_PFD_DB = -10 * LOG10(1e6);   // = −60.000000

/**
 * 把 grdSampler(pathLoss:'absolute') 的返回值转成 PFD 谱密度。
 *
 * ★ 全仓库只有这一个函数可以碰 GRD 的 absolute 值。别处直接引用一律由 lint 拦下
 *   （见 test/pfdUnitsLint.test.mjs）。
 *
 * @param {number} grdAbsoluteDb   grdSampler 返回值（dB(W/km²)，且不含发射功率）
 * @param {number} eirpDbwPerHz    该波束的 EIRP 谱密度（dBW/Hz）——GRD 只给方向性，功率要外部补
 * @returns {number} dBW/m²/Hz
 */
function grdAbsoluteToPfdPerHz(grdAbsoluteDb, eirpDbwPerHz) {
  const v = Number(grdAbsoluteDb), e = Number(eirpDbwPerHz);
  if (!Number.isFinite(v)) throw new TypeError(`units.grdAbsoluteToPfdPerHz: grd 值非有限数（${grdAbsoluteDb}）`);
  if (!Number.isFinite(e)) throw new TypeError(`units.grdAbsoluteToPfdPerHz: eirp 非有限数（${eirpDbwPerHz}）`);
  return v + GRD_ABSOLUTE_TO_PFD_DB + e;
}

// ---------------------------------------------------------------------------
// XML 落盘格式 —— ③号坑与 Viewer 的大小写/精度要求
// ---------------------------------------------------------------------------

/**
 * 频率 GHz → XML 的 MHz 字符串，固定六位小数。
 * XSD 的频率字段是 MHz，而界面按从业者习惯用 GHz —— 这一步换算错了不会报错，
 * 只会让整份 mask 挂到错误的频段上。
 * @example ghzToMhzXml(10.7) === '10700.000000'
 */
function ghzToMhzXml(ghz) {
  const g = Number(ghz);
  if (!Number.isFinite(g) || g <= 0) throw new RangeError(`units.ghzToMhzXml: 频率必须为正有限数（${ghz}）`);
  return (g * 1000).toFixed(6);
}

/** 反向：XML 的 MHz 字符串 → GHz 数值。 */
function mhzXmlToGhz(mhzStr) {
  const m = Number(mhzStr);
  if (!Number.isFinite(m) || m <= 0) throw new RangeError(`units.mhzXmlToGhz: 非法频率（${mhzStr}）`);
  return m / 1000;
}

/**
 * ③号坑的闸门：eirp_mask_ss 落盘前的参考带宽检查。
 *
 * 官方 XSD 里 eirp_mask_ss【没有 refbw_khz 属性】，所以非默认带宽的信息在落盘时会丢失，
 * 读方一律按 §C4.1 的默认 40 kHz 解释 —— 静默错 refBwScaleDb(40k, 实际) 那么多 dB。
 *
 * @param {number} refBwHz 当前使用的参考带宽
 * @param {'throw'|'report'} mode
 * @returns {{ok:boolean, errorDb:number, message:string}}
 */
function checkEirpSsRefBw(refBwHz, mode) {
  const b = Number(refBwHz);
  if (!(b > 0)) throw new TypeError(`units.checkEirpSsRefBw: 带宽必须为正（${refBwHz}）`);
  const ok = Math.abs(b - DEFAULT_REF_BW_HZ) < 1e-9;
  const errorDb = ok ? 0 : refBwScaleDb(DEFAULT_REF_BW_HZ, b);
  const message = ok ? ''
    : `eirp_mask_ss 在官方 XSD 中没有 refbw_khz 属性：参考带宽 ${b / 1e3} kHz 的信息落盘后会丢失，`
      + `读方将按默认 40 kHz 解释，静默偏差 ${errorDb.toFixed(3)} dB。`
      + `请改用 40 kHz，或只输出 pfd_mask（它有 refbw_khz）。`;
  if (!ok && mode === 'throw') throw new RangeError(message);
  return { ok, errorDb, message };
}

module.exports = {
  DEFAULT_REF_BW_HZ, MIN_SLANT_RANGE_M, MAX_SLANT_RANGE_M, GRD_ABSOLUTE_TO_PFD_DB,
  spec, isSpec, assertSpec, rescale, perHz, fromPerHz, perRefBw, refBwScaleDb,
  spreadingLossDb, pfdPerHz, sumDb,
  grdAbsoluteToPfdPerHz,
  ghzToMhzXml, mhzXmlToGhz, checkEirpSsRefBw,
};
