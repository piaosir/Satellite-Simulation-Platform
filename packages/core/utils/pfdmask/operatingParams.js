// PFD Mask · non_gso_operating_parameters（运行参数）XML
//
// 这是 mask 之外的【第四份交付物】。规避角、跟踪约束、地球站密度全在这里——
// 它们【不进 mask XML】，混进去会被 §D3.2 的最坏几何搜索重复使用。
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据：Rec. ITU-R S.1503-4 §B3.3（字段表 + 完整示例）与 §B5.2/§B5.3（校验）。
//   ⚠ ITU **未发布**此元素的 XSD（官方只发了 mask 的 Mask-schema.xsd），
//     故本文件按建议书正文生成，不能用 Mask-schema.xsd 校验。
//   ⚠ 该元素【绝不能】塞进 mask 文件：Mask-schema.xsd 的 satellite_system 是
//     xs:sequence 且不含此元素，塞进去会打破 mask 文件「通过官方 XSD 校验」的状态。
//     故旁挂成独立文件 Mask_param_id_{N}_OP.xml。
//
// ★ 建议书 §B3.3 的示例本身有多处笔误（已逐字核对 PDF），本实现按【字段表】写，不照抄示例：
//     angle_at_es="5"        → 应为 min_angle_at_es="5"（丢了 min_ 前缀）
//     min_angle_at_sat = 5>  → 值未加引号
//     <min_exclude oc="2">   → 应为 c="2"
//     <elev_angle b="370">   → 370° 超出字段表自述的 000–360
//     -4 版字段类型表整体错位一行 → 按 S.1503-3 同名表读（排版正确）
//
// 维度约定（建议书原文）：
//   MIN_EXCLUDE 随 orb_id × latitude；MIN_DURATION / MAX_CO_FREQ 只随 latitude；
//   MIN_ELEV 随 latitude × azimuth。c="0" 表示适用于所有轨道面。
//   纬度间线性插值；方位角线性插值、纬度取最近点不插值。
// ─────────────────────────────────────────────────────────────────────────────

const { fixed, escapeXml } = require('./maskIO.js');

/** §B5.2 的取值门槛，逐条对应建议书。 */
function validateOperatingParams(p) {
  const errors = [];
  const E = (m) => errors.push(m);

  if (!(Number(p.paramId) >= 1)) E('param_id 须 ≥ 1');
  if (!(Number(p.lowFreqMhz) > 0) || !(Number(p.highFreqMhz) > Number(p.lowFreqMhz))) {
    E('频段非法：须 0 < low_freq_mhz < high_freq_mhz');
  }
  const latMin = Number(p.esLatMin), latMax = Number(p.esLatMax);
  if (!(latMin >= -90 && latMin < 90)) E('ES_LAT_MIN 须满足 +90 > ES_LAT_MIN ≥ −90');
  if (!(latMax > -90 && latMax <= 90)) E('ES_LAT_MAX 须满足 +90 ≥ ES_LAT_MAX > −90');
  if (!(latMax > latMin)) E('ES_LAT_MAX 必须大于 ES_LAT_MIN');

  // ES_DISTANCE = 0 表示 GSO 足迹内只放 1 个地球站（NUM_ES = 1）
  if (!(Number(p.esDensity) > 0)) E('ES_DENSITY 须 > 0');
  if (!(Number(p.esDistanceKm) >= 0)) E('ES_DISTANCE 须 ≥ 0');
  for (const k of ['minAngleAtEsDeg', 'minAngleAtSatDeg']) {
    if (!(Number(p[k]) >= 0)) E(`${k} 须 ≥ 0`);
  }
  if (!(Number(p.maxCoFreqSat) >= 0)) E('MAX_CO_FREQ_SAT 须 ≥ 0');

  for (const z of (p.minExclude || [])) {
    for (const a of (z.byLat || [])) {
      if (!(Number(a.value) >= 0)) E(`MIN_EXCLUDE 须 ≥ 0（lat ${a.lat}）`);
      if (!(Math.abs(Number(a.lat)) <= 90)) E(`MIN_EXCLUDE 的纬度越界（${a.lat}）`);
    }
  }
  for (const a of (p.minElev || [])) {
    for (const b of (a.byAz || [])) {
      if (!(Number(b.value) >= 0)) E(`MIN_ELEV 须 ≥ 0（lat ${a.lat}, az ${b.az}）`);
      if (!(Number(b.az) >= 0 && Number(b.az) <= 360)) E(`MIN_ELEV 的方位角须在 000–360（${b.az}）`);
    }
  }
  for (const a of (p.minDuration || [])) {
    if (!(Number(a.value) >= 1)) E(`MIN_DURATION 须 ≥ 1 s（lat ${a.lat}）`);
  }
  for (const a of (p.maxCoFreq || [])) {
    if (!(Number(a.value) >= 0)) E(`MAX_CO_FREQ 须 ≥ 0（lat ${a.lat}）`);
  }

  // §B5.3 的互斥关系
  const warnings = [];
  if ((p.minDuration || []).some((a) => Number(a.value) > 0) && Number(p.minAngleAtEsDeg) > 0) {
    warnings.push('MIN_DURATION 非零时 MIN_ANGLE_AT_ES 不适用（§B5.3），二者同时给值时读方行为未规定');
  }
  if (p.esType === 'specific' && (Number(p.esDensity) > 0 || Number(p.esDistanceKm) > 0)) {
    warnings.push('地球站类型为 specific 时 ES_DENSITY / ES_DISTANCE 不使用，此处的取值会被读方忽略');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 生成 non_gso_operating_parameters XML。
 *
 * @param {object} doc {satName, ntcId}
 * @param {object} p   运行参数（见 validateOperatingParams）
 * @param {object} [opt] {indent, header:string[], validate}
 */
function buildOperatingParamsXml(doc, p, opt) {
  const o = opt || {};
  if (o.validate !== false) {
    const v = validateOperatingParams(p);
    if (!v.ok) {
      throw new RangeError(`operatingParams: 未通过 §B5.2 校验，共 ${v.errors.length} 处：\n`
        + v.errors.slice(0, 5).map((x) => `  · ${x}`).join('\n'));
    }
  }
  const I = o.indent === undefined ? '  ' : o.indent;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  for (const line of (o.header || [])) out.push(`<!-- ${String(line).replace(/--/g, '- -')} -->`);
  out.push(`<satellite_system ntc_id="${Number(doc.ntcId)}" sat_name="${escapeXml(doc.satName)}">`);

  out.push(`${I}<non_gso_operating_parameters param_id="${Number(p.paramId)}"`
    + ` low_freq_mhz="${fixed(p.lowFreqMhz, 6)}" high_freq_mhz="${fixed(p.highFreqMhz, 6)}"`
    + ` a_name="latitude" b_name="azimuth" c_name="orb_id"`
    + ` es_lat_min="${fixed(p.esLatMin, 2)}" es_lat_max="${fixed(p.esLatMax, 2)}"`
    + ` es_density="${Number(p.esDensity)}" es_distance="${fixed(p.esDistanceKm, 2)}"`
    + ` min_angle_at_es="${fixed(p.minAngleAtEsDeg, 2)}" min_angle_at_sat="${fixed(p.minAngleAtSatDeg, 2)}"`
    + ` max_co_freq_sat="${Number(p.maxCoFreqSat)}">`);

  // MIN_EXCLUDE：随 orb_id × latitude（c="0" = 所有轨道面）
  for (const z of (p.minExclude || [])) {
    out.push(`${I}${I}<min_exclude c="${Number(z.orbId) || 0}">`);
    for (const a of z.byLat) {
      out.push(`${I}${I}${I}<exclusion_zone_angle a="${fixed(a.lat, 2)}">${fixed(a.value, 2)}</exclusion_zone_angle>`);
    }
    out.push(`${I}${I}</min_exclude>`);
  }
  // MAX_CO_FREQ / MIN_DURATION：只随 latitude
  for (const a of (p.maxCoFreq || [])) {
    out.push(`${I}${I}<max_co_freq a="${fixed(a.lat, 2)}">${Number(a.value)}</max_co_freq>`);
  }
  for (const a of (p.minDuration || [])) {
    out.push(`${I}${I}<min_duration a="${fixed(a.lat, 2)}">${Number(a.value)}</min_duration>`);
  }
  // MIN_ELEV：随 latitude × azimuth
  for (const a of (p.minElev || [])) {
    out.push(`${I}${I}<min_elev a="${fixed(a.lat, 2)}">`);
    for (const b of a.byAz) {
      out.push(`${I}${I}${I}<elev_angle b="${fixed(b.az, 2)}">${fixed(b.value, 2)}</elev_angle>`);
    }
    out.push(`${I}${I}</min_elev>`);
  }

  out.push(`${I}</non_gso_operating_parameters>`);
  out.push('</satellite_system>');
  return out.join('\n') + '\n';
}

/**
 * 由「运行场景库的标量字段」升成 §B3.3 需要的一维/二维表。
 * 标量 ⇒ 在纬度两端各放一个同值点（读方按纬度线性插值，等价于常量）。
 */
function scenarioToOperatingParams(sc, o) {
  const q = o || {};
  const latLo = Number(q.esLatMin === undefined ? -90 : q.esLatMin);
  const latHi = Number(q.esLatMax === undefined ? 90 : q.esLatMax);
  const flat2 = (v) => [{ lat: latLo, value: v }, { lat: latHi, value: v }];
  return {
    paramId: Number(q.paramId || 1),
    lowFreqMhz: Number(q.lowFreqMhz), highFreqMhz: Number(q.highFreqMhz),
    esLatMin: latLo, esLatMax: latHi,
    esDensity: Number(sc.esDensityPerKm2 > 0 ? sc.esDensityPerKm2 : 1e-5),
    esDistanceKm: Number(sc.esDistanceKm >= 0 ? sc.esDistanceKm : 0),
    minAngleAtEsDeg: Number(sc.minAngleAtEsDeg || 0),
    minAngleAtSatDeg: Number(sc.minAngleAtSatDeg || 0),
    maxCoFreqSat: Number(sc.maxCoFreqSat || 1),
    esType: q.esType || 'typical',
    minExclude: Array.isArray(sc.minExcludeTable) && sc.minExcludeTable.length
      ? sc.minExcludeTable
      : [{ orbId: 0, byLat: flat2(Number(sc.alpha0Deg) || 0) }],
    minElev: Array.isArray(sc.minElevTable) && sc.minElevTable.length
      ? sc.minElevTable
      : [{ lat: latLo, byAz: [{ az: 0, value: Number(sc.minElevDeg) || 0 }, { az: 360, value: Number(sc.minElevDeg) || 0 }] },
         { lat: latHi, byAz: [{ az: 0, value: Number(sc.minElevDeg) || 0 }, { az: 360, value: Number(sc.minElevDeg) || 0 }] }],
    maxCoFreq: flat2(Number(sc.maxCoFreq || 1)),
    // MIN_DURATION 在 epfd(up) 情形不使用（§D5.2.4.2）；未填则整段省略
    minDuration: Number(sc.minDurationSec) >= 1 ? flat2(Number(sc.minDurationSec)) : [],
  };
}

module.exports = { validateOperatingParams, buildOperatingParamsXml, scenarioToOperatingParams };
