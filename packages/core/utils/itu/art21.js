// RR Article 21 Table 21-4 —— 空间电台在地球表面产生的功率通量密度限值（RR 2024，Rev.WRC-23）
//
// 数据：art21Table214.json（从 RR 2024 Vol.1 官方 PDF 逐行抽取，抽法与复核见该文件 meta）。
// 本模块只做两件事：
//   limitAt(fGHz, δ, ctx)   查表：给定频率、到达角、业务 / 轨道 / 区域等条件，返回 RR 的限值；RR 没有限值返回 null
//   assessPfd({...})        按 No.21.16 的口径（自由空间传播条件）算参考带宽内的到达 PFD，与限值相减得余量
//
// 口径要点（都出自 RR 原文，不是本平台的取舍）：
//   · No.21.16：限值对应「假定自由空间传播条件下」的 pfd —— 不扣大气、雨、云衰减；
//   · 限值以参考带宽（4 kHz / 1 MHz / 1.5 MHz）计；载波按均匀谱处理时，任一参考带宽内的功率
//     = 载波功率 × min(B_ref, B_occ) / B_occ（占用带宽比参考带宽窄时，整个载波落在一个参考带宽里）；
//   · 同一行可有两组限值（6 825-7 075 MHz 的 4 kHz 与 1 MHz）须同时满足；频率恰在两行分界上时两行都算——
//     取余量最小者为约束；
//   · 区域 / 国家限定（如 12.2-12.75 GHz 只在 Region 3）按评估点（收信站）所在位置判，见 ituRegion.js；
//   · 非静止轨道的 X（No.21.16.6，WRC-23 版，按 N 与 Nv）与 Y（No.21.16.15，按 NN、NS）按原文分支实现；
//     缺参时不猜：返回 limit = null 并在 missing 里列出缺的参数。
//
// ctx 字段：
//   orbit      'GSO' | 'NGSO'（缺省 'GSO'）
//   service    业务代号，缺省 'FSS'（FSS / MSS / BSS / RDSS / ISS / MetSat / EESS / EESS-active / SR / SO）
//   region     1 | 2 | 3；不给则按 latDeg / lonDeg 判（只在该频段的行有区域限定时才判）
//   country    ISO 3166-1 alpha-3；不给则按 latDeg / lonDeg 判（只认 ituRegionGeo.json 收录的国家）
//   latDeg, lonDeg   评估点（收信站）经纬度
//   hio        非静止轨道是否为「高倾角轨道」（远地点高度 > 18 000 km 且倾角 35°–145°，Nos. 21.16.6B/6C/17）；
//              不给则按 apogeeKm + inclinationDeg 判
//   apogeeKm, inclinationDeg
//   res147     高倾角轨道是否适用 Resolution 147 (WRC-07)（缺省 false）
//   pre1995    18.8-19.3 GHz 非静止 FSS 是否为 1995-11-17 前已收到资料或已投入运行的系统（缺省 false）
//   N, Nv      No.21.16.6 的星座颗数与最大可见颗数
//   NN, NS     No.21.16.15 的南北半球同频同时发射颗数（或直接给 NcoMax = max(NN, NS)）

const TABLE = require('./art21Table214.json');
// 区域 / 国家面（约 400 KB）只在频段行带区域或国家限定时才用到——首次用时再载，不拖引擎冷启动
let _ituRegion = null;
const IR = () => _ituRegion || (_ituRegion = require('./ituRegion.js'));

const SOURCE = 'RR Art.21 Table 21-4（RR 2024）';
const SOURCE_EN = 'RR Art.21 Table 21-4 (RR 2024)';

const num = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// —— No.21.16.6（WRC-23）——
// N 为整数；288 < N ≤ 999 与 1 000 ≤ N ≤ 6 000 两支之间的非整数缝按 N < 1000 归前一支。
function X(N, Nv) {
  const n = num(N);
  if (!Number.isFinite(n) || n < 0) return { value: null, missing: ['N'] };
  if (n <= 50) return { value: 0, missing: [] };
  if (n <= 288) return { value: (5 / 119) * (n - 50), missing: [] };
  if (n < 1000) return { value: (1 / 69) * (n + 402), missing: [] };
  const nv = num(Nv);
  if (!Number.isFinite(nv) || nv < 1) return { value: null, missing: ['Nv'] };
  if (n <= 6000) return { value: Math.max(20.3, 10 * Math.log10(nv)), missing: [] };
  return { value: 10 * Math.log10(nv) + 1, missing: [] };
}

// —— No.21.16.15（WRC-03）——
function Y(NN, NS, NcoMax) {
  let m = num(NcoMax);
  if (!Number.isFinite(m)) {
    const a = num(NN), b = num(NS);
    const miss = [];
    if (!Number.isFinite(a)) miss.push('NN');
    if (!Number.isFinite(b)) miss.push('NS');
    if (miss.length) return { value: null, missing: miss };
    m = Math.max(a, b);
  }
  if (m < 0) return { value: null, missing: ['NN', 'NS'] };
  return { value: m <= 2 ? 0 : 5 * Math.log10(m), missing: [] };
}

// 段内取值：a + slope·(δ−d0) + logK·lg(δ−logD0) + F·(funcCoef + funcSlope·(δ−d0))
function evalSegment(sg, d, F) {
  const d0 = sg.d0 || 0;
  let v = sg.a + (sg.slope || 0) * (d - d0);
  if (sg.logK) v += sg.logK * Math.log10(d - (sg.logD0 || 0));
  if (sg.func) v += F * ((sg.funcCoef || 0) + (sg.funcSlope || 0) * (d - d0));
  return v;
}
function segmentAt(segments, d) {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if ((i === 0 ? d >= s.from : d > s.from) && d <= s.to) return s;
  }
  return segments[segments.length - 1];
}

const lists = TABLE.countryLists || {};
const listIso = (names) => [].concat(...(names || []).map((k) => (lists[k] && lists[k].iso3) || []));

// 三值逻辑：true / false / { missing: [...] }
const isMiss = (r) => r && typeof r === 'object';
function and3(parts) {
  const miss = [];
  for (const p of parts) {
    if (p === false) return false;
    if (isMiss(p)) miss.push(...p.missing);
  }
  return miss.length ? { missing: miss } : true;
}
function or3(parts) {
  const miss = [];
  for (const p of parts) {
    if (p === true) return true;
    if (isMiss(p)) miss.push(...p.missing);
  }
  return miss.length ? { missing: miss } : false;
}

function makeResolver(ctx) {
  const c = ctx || {};
  const orbit = String(c.orbit || 'GSO').toUpperCase() === 'NGSO' ? 'NGSO' : 'GSO';
  const lat = num(c.latDeg), lon = num(c.lonDeg);
  const hasLL = Number.isFinite(lat) && Number.isFinite(lon);
  let region = num(c.region);
  let regionDone = Number.isFinite(region);
  const getRegion = () => {
    if (!regionDone) { region = hasLL ? IR().ituRegionOf(lat, lon) : NaN; regionDone = true; }
    return Number.isFinite(region) ? region : null;
  };
  const country = c.country ? String(c.country).toUpperCase() : null;
  const inCountries = (isoList) => {
    if (country) return isoList.includes(country);
    if (!hasLL) return { missing: ['country'] };
    return !!IR().countryIn(lat, lon, isoList);
  };
  let hio = null;
  if (orbit === 'GSO') hio = false;
  else if (typeof c.hio === 'boolean') hio = c.hio;
  else {
    const apo = num(c.apogeeKm), inc = num(c.inclinationDeg);
    if (Number.isFinite(apo) && apo <= 18000) hio = false;
    else if (Number.isFinite(apo) && Number.isFinite(inc)) hio = inc >= 35 && inc <= 145;
  }
  return {
    orbit,
    service: String(c.service || 'FSS'),
    region: getRegion,
    inCountries,
    lon, hasLon: Number.isFinite(lon),
    hio,
    res147: c.res147 === true,
    pre1995: c.pre1995 === true,
    N: c.N, Nv: c.Nv, NN: c.NN, NS: c.NS, NcoMax: c.NcoMax
  };
}

// 频段条目是否覆盖评估点
function bandApplies(b, fMHz, R) {
  if (fMHz < b.lowMHz || fMHz > b.highMHz) return false;
  const parts = [];
  if (b.regions) {
    const r = R.region();
    if (r === null) return { missing: ['region'] };   // 区域都判不了（没有经纬度），国家更判不了，只报区域
    if (!b.regions.includes(r)) return false;
  }
  if (b.countryLists) parts.push(R.inCountries(listIso(b.countryLists)));
  if (b.countries) parts.push(R.inCountries(b.countries));
  if (b.lonWestWithin || b.lonWestOutside) {
    if (!R.hasLon) parts.push({ missing: ['lonDeg'] });
    else {
      const w = -R.lon;   // 西经度数
      const [lo, hi] = b.lonWestWithin || b.lonWestOutside;
      const within = w >= lo && w <= hi;
      parts.push(b.lonWestWithin ? within : !within);
    }
  }
  return and3(parts);
}

// 「when」里的一个备选条件
function altApplies(a, fMHz, R) {
  const parts = [];
  if (a.services) parts.push(a.services.includes(R.service));
  if (a.orbit) parts.push(a.orbit === R.orbit);
  if (a.lowMHz !== undefined) parts.push(fMHz >= a.lowMHz);
  if (a.highMHz !== undefined) parts.push(fMHz <= a.highMHz);
  if (a.hio !== undefined) parts.push(R.hio === null ? { missing: ['hio'] } : R.hio === a.hio);
  if (a.res147 !== undefined) parts.push(R.res147 === a.res147);
  if (a.pre1995 !== undefined) parts.push(R.pre1995 === a.pre1995);
  if (a.nMax !== undefined) {
    const n = num(R.N);
    parts.push(Number.isFinite(n) ? n <= a.nMax : { missing: ['N'] });
  }
  return and3(parts);
}

function uniq(arr) { return Array.from(new Set(arr)); }

/**
 * 查 RR Table 21-4。
 * @returns {null|{limit:number|null, refBwHz:number, rowId:string, footnotes:string[], limits:object[], missing:string[], ...}}
 *   null = RR 在该频段对该业务 / 轨道 / 位置没有限值。
 *   limit 为 null 且 missing 非空 = 有适用（或可能适用）的行，但缺判定 / 计算所需的参数。
 */
function limitAt(fGHz, deltaDeg, ctx) {
  const f = num(fGHz);
  if (!Number.isFinite(f) || f <= 0) return null;
  const fMHz = f * 1000;
  const dRaw = num(deltaDeg);
  const d = Number.isFinite(dRaw) ? Math.max(0, Math.min(90, dRaw)) : NaN;
  const R = makeResolver(ctx);
  const hits = [];
  const maybeMissing = [];
  for (const row of TABLE.rows) {
    if (!row.services.includes(R.service)) continue;
    if (row.orbit && row.orbit !== R.orbit) continue;
    const bandHits = row.bands.map((b) => ({ b, ok: bandApplies(b, fMHz, R) }));
    const bandOk = or3(bandHits.map((x) => x.ok));
    if (bandOk === false) continue;
    const whenOk = row.when ? or3(row.when.map((a) => altApplies(a, fMHz, R))) : true;
    const ok = and3([bandOk, whenOk]);
    if (ok === false) continue;
    if (isMiss(ok)) { maybeMissing.push({ row, missing: ok.missing }); continue; }
    hits.push({ row, bands: bandHits.filter((x) => x.ok === true).map((x) => x.b) });
  }
  if (!hits.length && !maybeMissing.length) return null;

  const limits = [];
  const missing = [];
  for (const m of maybeMissing) missing.push(...m.missing);
  for (const { row, bands } of hits) {
    const notesBand = [].concat(...bands.map((b) => b.footnotes || []));
    for (const L of row.limits) {
      if (!Number.isFinite(d)) { missing.push('delta'); continue; }
      const sg = segmentAt(L.segments, d);
      let F = 0;
      if (sg.func === 'X') {
        const x = X(R.N, R.Nv);
        if (x.value === null) { missing.push(...x.missing); limits.push({ limit: null, refBwHz: L.refBwHz, rowId: row.id, row, footnotes: uniq([...(row.footnotes || []), ...notesBand, ...(sg.notes || [])]) }); continue; }
        F = x.value;
      } else if (sg.func === 'Y') {
        const y = Y(R.NN, R.NS, R.NcoMax);
        if (y.value === null) { missing.push(...y.missing); limits.push({ limit: null, refBwHz: L.refBwHz, rowId: row.id, row, footnotes: uniq([...(row.footnotes || []), ...notesBand, ...(sg.notes || [])]) }); continue; }
        F = y.value;
      }
      limits.push({
        limit: evalSegment(sg, d, F),
        refBwHz: L.refBwHz,
        rowId: row.id,
        row,
        segment: { from: sg.from, to: sg.to },
        F: sg.func ? { name: sg.func, value: F } : null,
        footnotes: uniq([...(row.footnotes || []), ...notesBand, ...(sg.notes || [])])
      });
    }
  }
  const rowOf = (row) => ({ limit: null, refBwHz: row.limits[0].refBwHz, rowId: row.id, row, footnotes: row.footnotes || [] });
  const first = limits[0] || (hits[0] && rowOf(hits[0].row)) || rowOf(maybeMissing[0].row);
  const miss = uniq(missing);
  // 18.6-18.8 GHz 的附加限值（No.21.16.2）：另一个参考带宽（整个 200 MHz）与时间百分比口径，单列返回
  const additional = [];
  for (const [prov, fn] of Object.entries(TABLE.footnotes || {})) {
    const al = fn.additionalLimit;
    if (al && fMHz >= al.lowMHz && fMHz <= al.highMHz && (!al.services || al.services.includes(R.service))) {
      additional.push(Object.assign({ provision: prov }, al));
    }
  }
  return {
    limit: miss.length ? null : first.limit,
    refBwHz: first.refBwHz,
    rowId: first.rowId,
    footnotes: uniq([].concat(...limits.map((l) => l.footnotes || []), ...(maybeMissing.map((m) => m.row.footnotes || [])))),
    limits,
    missing: miss,
    additional,
    bandText: first.row.bandText,
    serviceText: first.row.serviceText,
    page: first.row.page,
    source: SOURCE
  };
}

const log10 = Math.log10;

/**
 * 自由空间口径的到达 PFD 与 Art.21 余量。
 * @param {object} p
 * @param {number} p.fGHz         载波中心频率
 * @param {number} p.deltaDeg     到达角（评估点仰角）
 * @param {object} p.ctx          见 limitAt
 * @param {number} p.eirpDbw      指向评估点的载波 EIRP（dBW）
 * @param {number} p.slantRangeKm 星地距离（km）
 * @param {number} p.occBwHz      载波占用带宽（Hz），按均匀谱
 * @returns {{pfdTotal:number|null, pfdRef:number|null, limit:number|null, margin:number|null, refBwHz:number|null,
 *            limitCarrierBw:number|null, rowId:string|null, footnotes:string[], missing:string[], source:string|null, table:object|null}}
 */
function assessPfd(p) {
  const eirp = num(p && p.eirpDbw), dKm = num(p && p.slantRangeKm), B = num(p && p.occBwHz);
  const pfdTotal = (Number.isFinite(eirp) && dKm > 0) ? eirp - 10 * log10(4 * Math.PI * Math.pow(dKm * 1000, 2)) : null;
  const res = limitAt(p && p.fGHz, p && p.deltaDeg, p && p.ctx);
  const out = { pfdTotal, pfdRef: null, limit: null, margin: null, refBwHz: null, limitCarrierBw: null, rowId: null, footnotes: [], missing: [], source: null, table: res };
  if (!res) return out;
  out.rowId = res.rowId;
  out.footnotes = res.footnotes;
  out.missing = res.missing;
  out.source = res.source;
  const inRef = (refBw) => (pfdTotal === null || !(B > 0)) ? null : pfdTotal + 10 * log10(Math.min(refBw, B) / B);
  if (res.missing.length || !res.limits.some((l) => Number.isFinite(l.limit))) {
    out.refBwHz = res.refBwHz;
    out.pfdRef = inRef(res.refBwHz);
    return out;
  }
  let best = null;
  for (const l of res.limits) {
    if (!Number.isFinite(l.limit)) continue;
    const pr = inRef(l.refBwHz);
    const m = pr === null ? null : l.limit - pr;
    if (!best || (m !== null && (best.m === null || m < best.m))) best = { l, pr, m };
  }
  out.refBwHz = best.l.refBwHz;
  out.rowId = best.l.rowId;
  out.limit = best.l.limit;
  out.pfdRef = best.pr;
  out.margin = best.m;
  out.limitCarrierBw = (B > 0) ? best.l.limit + 10 * log10(Math.max(B, best.l.refBwHz) / best.l.refBwHz) : null;
  return out;
}

module.exports = { limitAt, assessPfd, X, Y, evalSegment, segmentAt, TABLE, SOURCE, SOURCE_EN };
