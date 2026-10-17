// RR 附录 8（AP8）协调触发计算 + 附录 5 表 5-1 No.9.7 协调弧
//
// 依据：ITU《无线电规则》2024 年版第 2 卷（官方合订本 PDF，SHA-256 49e283a5…3abf）
//   · 附录 8（Rev.WRC-15），AP8-1 ~ AP8-11 页：§2.1 符号、§2.2 公用约定（重叠频段的平均频率、
//     无重叠则该向 ΔT 取 0）、§2.2.1 Case I 式(1)–(7)、§2.2.1.2 独立上下行、§2.2.2 Case II 式(8)–(10)、
//     §2.2.3 极化隔离因子 Y、§2.4 两组 (T, γ) 取大、§3 门限 6%、附件 1 拓扑角、附件 2 距离与自由空间损耗、
//     附件 3 地球站方向图（patterns.ap8AnnexIIIGain）、附件 4 算例（ap8.test.mjs 的金标准）。
//   · 附录 5（Rev.WRC-23）表 5-1 No.9.7 GSO/GSO 一行（AP5-4 ~ AP5-8 页）：数据见 ap5Table51.json。
//
// ─── 两个网络、两个方向 ─────────────────────────────────────────────────────
// 原文记号：受扰链路 A（网络 R、卫星 S，不带撇）、施扰链路 A′（网络 R′、卫星 S′，带撇）。
//   ΔTs = p′e·g′1(θt)·g2(δe′) / (k·lu)     式(1)  施扰发端站旁瓣 → 受扰卫星接收机
//   ΔTe = p′s·g′3(ηe)·g4(θt) / (k·ld)      式(2)  施扰卫星（朝受扰收端站方向）→ 受扰收端站旁瓣
//   ΔT  = γ·ΔTs + ΔTe                      式(3)  折算到受扰收端站天线输出端；ΔT/T 与 6% 比
// 反方向（A 对 A′）同形，式(5)–(7)。本模块把「谁施扰、谁受扰」做成同一个函数的两个参数，正反各调一次：
//   本网 → 邻网 ＝ 式(5)–(7) 的 ΔT′/T′；邻网 → 本网 ＝ 式(1)–(3) 的 ΔT/T。
// 平台 v1.5.3 及之前只算了其中一项——本站上行旁瓣进邻星的 ΔTs/Ts（式(5) 的上行分量），却按「ΔT/T、
// 门限 6%」出数（差距分析 D-01：出厂示例 0.68%，补上下行 ΔTe 后同一对网络到 59.5%，结论相反）。
//
// ─── 几何两条口径 ───────────────────────────────────────────────────────────
//   'rule'   附件 1 / 2 原式：d = 42644·√(1 − 0.2954·cosψ)，ds = 84332·sin(θg/2)，
//            θt = arccos[(d1² + d2² − ds²)/(2·d1·d2)]，L = 20(lg f_MHz + lg d_km) + 32.45。
//            BR 的 GIBC 走这一套，要与它逐位对齐就用这条（缺省）。
//   'wgs84'  工程口径：WGS84 椭球站址 + 真实 GEO 斜距（geometry.js），与 C/ASI 同源。
// 两条都计入东西保持容差（§2.1：θt、θg「taking the longitudinal station-keeping tolerances into account」）：
// 两星各向对方挪一个容差（geometry.gsoClosestApproach）。
//
// ─── 只出数 ────────────────────────────────────────────────────────────────
// 逐分量 ΔTs / ΔTe（K）、两组 (T, γ) 的 ΔT/T、独立分支的 ΔTs/Ts 与 ΔTe/Te、Case II、轨位差与协调弧限值、
// 频谱重叠 MHz；exceeds 只供界面着色，不出「需协调」之类的文字判定。

const G = require('../interference/geometry.js');
const P = require('../interference/patterns.js');
const AP5 = require('./ap5Table51.json');

const LOG10 = Math.log10;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const lin = (db) => Math.pow(10, db / 10);
const dB = (x) => 10 * LOG10(x);
const has = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
const num = (v, d) => (has(v) ? Number(v) : d);
const C_M_S = 299792458;

// −10·lg k。附录 8 附件 4 算例的 dB 算式即用 228.6（§2.1 的 k = 1.38×10⁻²³ J/K 合 228.601，差 0.001 dB）。
const K_DB = 228.6;
// §3：ΔT/T 门限 6%（附录 30 / 30A 另有取值，见 §3 脚注 3，本模块不涉及）
const THRESHOLD_PCT = 6;

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

/** 经度差折回 (−180, 180] 后取绝对值。 */
function lonSepDeg(a, b) {
  let d = (Number(b) - Number(a)) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
}

/** 附件 2 a)：地球站 → GSO 卫星的距离（km）；cosψ < 0.151 ⇒ 卫星在该站水平面以下。 */
function ruleSlantRangeKm(st, satLonDeg) {
  const cosPsi = Math.cos(num(st && st.lat, 0) * DEG) * Math.cos((num(st && st.lon, 0) - Number(satLonDeg)) * DEG);
  return { km: 42644 * Math.sqrt(1 - 0.2954 * cosPsi), visible: cosPsi >= 0.151, cosPsi };
}

/** 附件 2 b)：两颗 GSO 卫星之间的距离（km）。 */
function ruleInterSatKm(thetaGDeg) {
  return 84332 * Math.sin(Number(thetaGDeg) / 2 * DEG);
}

/** 附件 1：地球站看两颗 GSO 卫星的拓扑角（°）。d1、d2 按附件 2 a)，θg 为两星地心角。 */
function ruleTopocentricDeg(st, lonADeg, lonBDeg) {
  const d1 = ruleSlantRangeKm(st, lonADeg).km;
  const d2 = ruleSlantRangeKm(st, lonBDeg).km;
  const ds = ruleInterSatKm(lonSepDeg(lonADeg, lonBDeg));
  const c = (d1 * d1 + d2 * d2 - ds * ds) / (2 * d1 * d2);
  return Math.acos(Math.max(-1, Math.min(1, c))) * RAD;
}

/** 附件 2：L = 20(lg f + lg d) + 32.45 dB，f 单位 MHz、d 单位 km。 */
function ruleFslDb(fGHz, dKm) {
  return 20 * (LOG10(Number(fGHz) * 1000) + LOG10(Number(dKm))) + 32.45;
}

const GEOMETRY = {
  rule: {
    id: 'rule',
    range: (st, lon) => ruleSlantRangeKm(st, lon),
    interSatKm: (thetaG) => ruleInterSatKm(thetaG),
    topo: (st, lonMain, lonOther) => ruleTopocentricDeg(st, lonMain, lonOther),
    fsl: (fGHz, dKm) => ruleFslDb(fGHz, dKm)
  },
  wgs84: {
    id: 'wgs84',
    range: (st, lon) => { const lk = G.lookAngles(st, G.gsoEcef(lon)); return { km: lk.rangeKm, visible: lk.elevDeg > 0 }; },
    interSatKm: (thetaG) => 2 * G.GSO_RADIUS_KM * Math.sin(Number(thetaG) / 2 * DEG),
    topo: (st, lonMain, lonOther) => G.topocentricAngle(st, G.gsoEcef(lonMain), G.gsoEcef(lonOther)),
    fsl: (fGHz, dKm) => G.fsl(dKm, fGHz)
  }
};

// ---------------------------------------------------------------------------
// 频段、极化、地球站增益
// ---------------------------------------------------------------------------

/** 两段指配频段 [lo, hi]（GHz）的公共部分：{loGHz, hiGHz, mhz, fGHz(平均频率)} 或 null（无重叠）。 */
function bandOverlap(a, b) {
  if (!a || !b) return null;
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
  if (!(hi > lo)) return null;
  return { loGHz: lo, hiGHz: hi, mhz: (hi - lo) * 1000, fGHz: (lo + hi) / 2 };
}

// 平台的极化记号 → 附录 8 §2.2.3 表里的三类。★ 平台的 L 是左旋圆极化（LHC），附录 8 表里的 L 是线极化。
const POL_CLASS = { H: 'LIN', V: 'LIN', LIN: 'LIN', L: 'LHC', LHC: 'LHC', LHCP: 'LHC', R: 'RHC', RHC: 'RHC', RHCP: 'RHC' };

/**
 * §2.2.3 极化隔离因子 Y（数值比）：LHC/RHC → 4；圆/线 → 1.4；同旋向圆、线/线 → 1。
 * 原表六行按「网络 R / 网络 R′」列出（LHC–RHC、LHC–L、RHC–L、LHC–LHC、RHC–RHC、L–L），两网对调同值。
 * 注意线/线一律 1：附录 8 不认线极化的正交隔离（H 对 V 也是 1）。极化不明 → 1（不折减）。
 */
function polarizationIsolationY(polR, polRp) {
  const a = POL_CLASS[String(polR || '').trim().toUpperCase()];
  const b = POL_CLASS[String(polRp || '').trim().toUpperCase()];
  if (!a || !b) return { y: 1, known: false };
  if (a === b) return { y: 1, known: true };
  if (a === 'LIN' || b === 'LIN') return { y: 1.4, known: true };
  return { y: 4, known: true };
}

/** 地球站在 φ 方向的增益（dBi），恒按 RR 附录 8 附件 3（口径 + 效率，或只给主瓣增益）。 */
function stationGain(stn, fGHz, phiDeg) {
  const lam = C_M_S / (Number(fGHz) * 1e9);
  const pat = P.makeEsPattern(P.AP8_PATTERN, num(stn.diameterM, NaN), lam, num(stn.efficiency, 0.65), { gainDbi: stn.gainDbi });
  if (!pat) return null;
  return { gainDbi: pat.gain(phiDeg), gmaxDbi: pat.gmaxDbi, dOverLambda: pat.dOverLambda, dOverLambdaEstimated: pat.dOverLambdaEstimated };
}

// ---------------------------------------------------------------------------
// 式(1) / (2) / (8) 与 §2.2.1.1 合成 —— 纯 dB 算式，附件 4 算例直接核这几个
// ---------------------------------------------------------------------------

/** 式(1)：ΔTs = p′e·g′1·g2 / (k·lu)。入参全是 dB 量，返回 K。 */
function deltaTsK(peDbWPerHz, g1Dbi, g2Dbi, luDb) {
  return lin(peDbWPerHz + g1Dbi + g2Dbi - luDb + K_DB);
}

/** 式(2)：ΔTe = p′s·g′3·g4 / (k·ld)。eirpDensity = p′s·g′3（卫星朝该收端站方向的最大 EIRP 密度）。 */
function deltaTeK(satEirpDensityDbWPerHz, g4Dbi, ldDb) {
  return lin(satEirpDensityDbWPerHz + g4Dbi - ldDb + K_DB);
}

/** 式(8)：Case II ΔTs = p′s·g′3(ηs)·g2(δs′) / (k·ls)。 */
function deltaTsCaseIIK(satEirpToSatDbWPerHz, g2ToSatDbi, lsDb) {
  return lin(satEirpToSatDbWPerHz + g2ToSatDbi - lsDb + K_DB);
}

/**
 * §2.2.1.1 式(3) + §2.2.3：ΔT = γ·ΔTs/Yu + ΔTe/Yd，返回 {deltaTK, pct}。
 * 某向频段无重叠时该向 ΔT 按 §2.2 取 0（调用方传 0）。
 */
function combineDeltaT(dTsK, dTeK, gammaDb, tK, yu, yd) {
  const dT = lin(gammaDb) * dTsK / (yu || 1) + dTeK / (yd || 1);
  return { deltaTK: dT, pct: tK > 0 ? dT / tK * 100 : null };
}

// ---------------------------------------------------------------------------
// 附录 5 表 5-1 No.9.7：协调弧
// ---------------------------------------------------------------------------

const inRegion = (band, region) => region == null || (band.regions || []).includes(Number(region));

function servicesMatch(row, proposed, other) {
  const s = row.services || {};
  if (Array.isArray(s.pairs)) return s.pairs.some(([a, b]) => a === proposed && b === other);
  if (!(s.proposed || []).includes(proposed) || !(s.other || []).includes(other)) return false;
  if (Array.isArray(s.excludePairs) && s.excludePairs.some(([a, b]) => a === proposed && b === other)) return false;
  return true;
}

/** 区间集合减去一个区间（MHz）。 */
function subtractSeg(segs, cut) {
  const out = [];
  for (const [lo, hi] of segs) {
    if (cut[1] <= lo || cut[0] >= hi) { out.push([lo, hi]); continue; }
    if (cut[0] > lo) out.push([lo, cut[0]]);
    if (cut[1] < hi) out.push([cut[1], hi]);
  }
  return out;
}

/** 某行在指定区域里实际覆盖的频段（MHz）。「17.3 GHz 以上、除第 x 项」一类按区域逐段扣除。 */
function rowSegments(row, region) {
  if (Array.isArray(row.bands)) return row.bands.filter((b) => inRegion(b, region)).map((b) => [b.loMHz, b.hiMHz]);
  if (row.above) {
    let segs = [[row.above.loMHz, Infinity]];
    for (const it of (row.above.exceptItems || [])) {
      const ex = AP5.rows.find((r) => r.item === it);
      for (const b of ((ex && ex.bands) || [])) if (inRegion(b, region)) segs = subtractSeg(segs, [b.loMHz, b.hiMHz]);
    }
    return segs;
  }
  return [];
}

/**
 * 某段频率（GHz）落在表 5-1 No.9.7 的哪几行、协调弧多大。
 * @param {object} [opt] { region: 1|2|3（拟议网络服务区所在区域；不给则不按区域筛），
 *                         service: 拟议网络业务（缺省 'FSS'），otherService: 对方业务（缺省 'FSS'）}
 * @returns {{arcDeg:number|null, item:string|null, hits:Array<{item, arcDeg, loMHz, hiMHz}>}}
 *   arcDeg 取命中各行中的最大值；一行都不中 → null（按第 9) 项：只看 ΔT/T > 6%）
 */
function coordinationArc(loGHz, hiGHz, opt) {
  const o = opt || {};
  const lo = Math.min(Number(loGHz), Number(hiGHz)) * 1000, hi = Math.max(Number(loGHz), Number(hiGHz)) * 1000;
  const region = has(o.region) ? Number(o.region) : null;
  const sp = o.service || 'FSS', so = o.otherService || 'FSS';
  const hits = [];
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    for (const row of AP5.rows) {
      if (!servicesMatch(row, sp, so)) continue;
      for (const [a, b] of rowSegments(row, region)) {
        const oLo = Math.max(lo, a), oHi = Math.min(hi, b);
        if (oHi > oLo || (lo === hi && lo >= a && lo <= b)) hits.push({ item: row.item, arcDeg: row.arcDeg, loMHz: oLo, hiMHz: oHi });
      }
    }
  }
  let best = null;
  for (const h of hits) if (!best || h.arcDeg > best.arcDeg) best = h;
  return { arcDeg: best ? best.arcDeg : null, item: best ? best.item : null, hits };
}

// ---------------------------------------------------------------------------
// 网络入参归一
// ---------------------------------------------------------------------------

function bandOf(band, centerGHz, bwHz) {
  if (Array.isArray(band) && has(band[0]) && has(band[1])) {
    const a = Number(band[0]), b = Number(band[1]);
    return a <= b ? [a, b] : [b, a];
  }
  if (has(centerGHz) && Number(bwHz) > 0) return [Number(centerGHz) - bwHz / 2e9, Number(centerGHz) + bwHz / 2e9];
  return null;
}

function stationOf(s) {
  const x = s || {};
  return {
    lon: num(x.lon, 0), lat: num(x.lat, 0), alt: num(x.alt, 0),
    diameterM: num(x.diameterM, NaN), efficiency: num(x.efficiency, 0.65),
    gainDbi: has(x.gainDbi) ? Number(x.gainDbi) : undefined,
    noiseTempK: num(x.noiseTempK, NaN)
  };
}

/**
 * 一个网络的入参 → 计算用的规范形。缺省推导（都在结果里标出来源）：
 *   pe     AP4 最大功率密度（天线输入端，15 GHz 以下最坏 4 kHz、以上最坏 1 MHz 平均）；
 *          缺 → 功放 − 馈损 − 10lg(带宽)（载波功率在带宽内均匀分布；真实载波的最坏 4 kHz / 1 MHz 峰值密度更高）
 *   ps·g3  卫星朝对方收端站方向的最大 EIRP 密度；缺 → 载波 EIRP − 10lg(带宽)
 *   Ts     卫星接收系统噪温；缺 → 由接收增益与 G/T 反解 10^((G − G/T)/10)
 *   频段   缺 → 中心频率 ± 带宽/2
 */
function normNet(n, label) {
  const x = n || {};
  const bw = num(x.bandwidthHz, NaN);
  let pe = num(x.txPowerDensityDbWPerHz, NaN), peSource = 'ap4';
  if (!Number.isFinite(pe)) {
    peSource = null;
    if (num(x.txPowerW, 0) > 0 && bw > 0) { pe = dB(Number(x.txPowerW)) - num(x.txFeederLossDb, 0) - dB(bw); peSource = 'carrier'; }
  }
  let satEirp = num(x.satEirpDensityDbWPerHz, NaN), satEirpSource = 'given';
  if (!Number.isFinite(satEirp)) {
    satEirpSource = null;
    if (has(x.satEirpDbW) && bw > 0) { satEirp = Number(x.satEirpDbW) - dB(bw); satEirpSource = 'carrier'; }
  }
  let ts = num(x.satRxNoiseTempK, NaN), tsSource = 'given';
  if (!(ts > 0)) {
    tsSource = null; ts = NaN;
    if (has(x.satGtDbPerK) && has(x.satRxGainDbi)) { ts = lin(Number(x.satRxGainDbi) - Number(x.satGtDbPerK)); tsSource = 'gt'; }
  }
  const links = (Array.isArray(x.links) ? x.links : [])
    .map((l, i) => ({ idx: i + 1, gammaDb: num(l && l.gammaDb, NaN), noiseTempK: num(l && l.noiseTempK, NaN) }))
    .filter((l) => Number.isFinite(l.gammaDb));
  return {
    label: label || '',
    lonDeg: num(x.lonDeg, 0),
    ewTolDeg: Math.max(0, num(x.ewTolDeg, 0)),
    service: x.service || 'FSS',
    region: has(x.region) ? Number(x.region) : null,
    upBand: bandOf(x.upBandGHz, x.upCenterGHz, bw),
    dnBand: bandOf(x.dnBandGHz, x.dnCenterGHz, bw),
    upPol: x.upPol || '', dnPol: x.dnPol || '',
    tx: stationOf(x.txStation), rx: stationOf(x.rxStation),
    pe, peSource,
    satRxGainDbi: num(x.satRxGainDbi, NaN), ts, tsSource,
    satEirp, satEirpSource,
    satEirpToSat: num(x.satEirpDensityToSatDbWPerHz, NaN),
    satRxGainToSat: num(x.satRxGainToSatDbi, NaN),
    links,
    regenerative: !!x.regenerative
  };
}

// ---------------------------------------------------------------------------
// 一个方向：X 施扰、V 受扰
// ---------------------------------------------------------------------------

const fin = (v) => Number.isFinite(v);

function direction(X, V, ctx) {
  const geom = ctx.geom;
  const xLon = ctx.lonOf(X), vLon = ctx.lonOf(V);
  const missing = [];
  const need = (ok, what) => { if (!ok && !missing.includes(what)) missing.push(what); return ok; };

  // ---- Case I 上行：X 上行 ∩ V 上行 —— X 的发端站旁瓣进 V 星接收机（式(1)）----
  const ovUp = bandOverlap(X.upBand, V.upBand);
  let up = null;
  if (ovUp) {
    const st = X.tx;
    const path = geom.range(st, vLon);
    const theta = geom.topo(st, xLon, vLon);          // X 发端站：主轴指 X 星，旁瓣朝 V 星
    const g1 = stationGain(st, ovUp.fGHz, theta);
    const lu = geom.fsl(ovUp.fGHz, path.km);
    up = {
      overlapMHz: ovUp.mhz, loGHz: ovUp.loGHz, hiGHz: ovUp.hiGHz, fGHz: ovUp.fGHz,
      thetaTDeg: theta, peDbWPerHz: fin(X.pe) ? X.pe : null, peSource: X.peSource,
      g1Dbi: g1 ? g1.gainDbi : null, gmaxDbi: g1 ? g1.gmaxDbi : null, dOverLambda: g1 ? g1.dOverLambda : null,
      slantKm: path.km, luDb: lu, visible: path.visible,
      g2Dbi: fin(V.satRxGainDbi) ? V.satRxGainDbi : null,
      tsK: fin(V.ts) ? V.ts : null, tsSource: V.tsSource,
      deltaTsK: null, pct: null
    };
    if (!path.visible) { up.deltaTsK = 0; up.pct = 0; }
    else {
      const okPe = need(fin(X.pe), `${X.label} · 发端功率密度`);
      const okAnt = need(!!g1, `${X.label} · 发端站天线`);
      const okG2 = need(fin(V.satRxGainDbi), `${V.label} · 卫星接收增益`);
      if (okPe && okAnt && okG2) up.deltaTsK = deltaTsK(X.pe, g1.gainDbi, V.satRxGainDbi, lu);
    }
    if (up.deltaTsK != null && up.pct == null && need(fin(V.ts) && V.ts > 0, `${V.label} · 卫星噪温`)) up.pct = up.deltaTsK / V.ts * 100;
  }

  // ---- Case I 下行：X 下行 ∩ V 下行 —— X 星朝 V 收端站方向的 EIRP 进 V 收端站旁瓣（式(2)）----
  const ovDn = bandOverlap(X.dnBand, V.dnBand);
  let dn = null;
  if (ovDn) {
    const st = V.rx;
    const path = geom.range(st, xLon);
    const theta = geom.topo(st, vLon, xLon);          // V 收端站：主轴指 V 星，旁瓣朝 X 星
    const g4 = stationGain(st, ovDn.fGHz, theta);
    const ld = geom.fsl(ovDn.fGHz, path.km);
    dn = {
      overlapMHz: ovDn.mhz, loGHz: ovDn.loGHz, hiGHz: ovDn.hiGHz, fGHz: ovDn.fGHz,
      thetaTDeg: theta, satEirpDbWPerHz: fin(X.satEirp) ? X.satEirp : null, satEirpSource: X.satEirpSource,
      g4Dbi: g4 ? g4.gainDbi : null, gmaxDbi: g4 ? g4.gmaxDbi : null, dOverLambda: g4 ? g4.dOverLambda : null,
      slantKm: path.km, ldDb: ld, visible: path.visible,
      teK: fin(V.rx.noiseTempK) ? V.rx.noiseTempK : null,
      deltaTeK: null, pct: null
    };
    if (!path.visible) { dn.deltaTeK = 0; dn.pct = 0; }
    else {
      const okEirp = need(fin(X.satEirp), `${X.label} · 卫星 EIRP 密度`);
      const okAnt = need(!!g4, `${V.label} · 收端站天线`);
      if (okEirp && okAnt) dn.deltaTeK = deltaTeK(X.satEirp, g4.gainDbi, ld);
    }
    if (dn.deltaTeK != null && dn.pct == null && need(fin(V.rx.noiseTempK) && V.rx.noiseTempK > 0, `${V.label} · 收端站噪温`)) dn.pct = dn.deltaTeK / V.rx.noiseTempK * 100;
  }

  // ---- §2.2.3 极化隔离（双方同意才计）----
  const yu = ctx.applyPol ? polarizationIsolationY(V.upPol, X.upPol).y : 1;
  const yd = ctx.applyPol ? polarizationIsolationY(V.dnPol, X.dnPol).y : 1;

  // 无重叠的那一向按 §2.2 取 0；有重叠却缺输入 → null（不拿 0 冒充）
  const dTs = up ? up.deltaTsK : 0;
  const dTe = dn ? dn.deltaTeK : 0;

  // ---- §2.2.1.2 / §3.2 独立分支：ΔTs/Ts、ΔTe/Te 各自与 6% 比 ----
  const independent = {
    dTsOverTsPct: up && up.pct != null ? up.pct / yu : (up ? null : 0),
    dTeOverTePct: dn && dn.pct != null ? dn.pct / yd : (dn ? null : 0)
  };

  // ---- §2.2.1.1 式(3) + §2.4 两组 (T, γ) 取大 ----
  // 再生（星上变调制）或没给 γ → 只能走独立分支（§2.2.1.2）
  const method = (V.regenerative || !V.links.length) ? 'independent' : 'combined';
  const links = [];
  if (method === 'combined' && (up || dn)) {
    for (const L of V.links) {
      let T = L.noiseTempK, tDerived = false;
      // 只给了 γ 没给 T：按定义 T = Te + γ·Ts（附录 8 §2.1，透明转发器，折算到收端站天线输出端）
      if (!(T > 0) && fin(V.rx.noiseTempK) && fin(V.ts)) { T = V.rx.noiseTempK + lin(L.gammaDb) * V.ts; tDerived = true; }
      const ok = dTs != null && dTe != null && T > 0;
      const c = ok ? combineDeltaT(dTs, dTe, L.gammaDb, T, yu, yd) : null;
      links.push({ idx: L.idx, gammaDb: L.gammaDb, noiseTempK: T > 0 ? T : null, tDerived, deltaTK: c ? c.deltaTK : null, pct: c ? c.pct : null });
      if (!(T > 0)) need(false, `${V.label} · 链路噪温 T`);
    }
  }
  const linkPcts = links.map((l) => l.pct).filter(fin);
  const combinedPct = linkPcts.length ? Math.max(...linkPcts) : null;
  const worstLink = combinedPct == null ? null : links.find((l) => l.pct === combinedPct).idx;

  // ---- Case II：X 下行 ∩ V 上行 —— X 星的发射进 V 星的接收机（式(8)，用地心角 θg 与星间损耗 ls）----
  const ovII = bandOverlap(X.dnBand, V.upBand);
  let caseII = null;
  if (ovII) {
    const thetaG = ctx.thetaGDeg;
    const ds = geom.interSatKm(thetaG);
    const ls = ds > 0 ? geom.fsl(ovII.fGHz, ds) : null;
    const yss = ctx.applyPol ? polarizationIsolationY(V.upPol, X.dnPol).y : 1;
    caseII = {
      overlapMHz: ovII.mhz, loGHz: ovII.loGHz, hiGHz: ovII.hiGHz, fGHz: ovII.fGHz,
      thetaGDeg: thetaG, interSatKm: ds, lsDb: ls,
      satEirpToSatDbWPerHz: fin(X.satEirpToSat) ? X.satEirpToSat : null,
      g2ToSatDbi: fin(V.satRxGainToSat) ? V.satRxGainToSat : null,
      yss, tsK: fin(V.ts) ? V.ts : null,
      deltaTsK: null, dTsOverTsPct: null, links: [], combinedPct: null
    };
    const okE = need(fin(X.satEirpToSat), `${X.label} · 卫星朝对方卫星的 EIRP 密度`);
    const okG = need(fin(V.satRxGainToSat), `${V.label} · 卫星朝对方卫星的接收增益`);
    if (!(ds > 0)) ctx.warnings.push(`计入保持容差后两星重合，Case II 星间损耗无定义（${X.label} → ${V.label}）`);
    else if (okE && okG) {
      caseII.deltaTsK = deltaTsCaseIIK(X.satEirpToSat, V.satRxGainToSat, ls);
      if (fin(V.ts) && V.ts > 0) caseII.dTsOverTsPct = caseII.deltaTsK / yss / V.ts * 100;
      else need(false, `${V.label} · 卫星噪温`);
      if (method === 'combined') {
        for (const L of V.links) {
          let T = L.noiseTempK;
          if (!(T > 0) && fin(V.rx.noiseTempK) && fin(V.ts)) T = V.rx.noiseTempK + lin(L.gammaDb) * V.ts;
          const dT = lin(L.gammaDb) * caseII.deltaTsK / yss;      // 式(9)：ΔT = γ·ΔTs
          caseII.links.push({ idx: L.idx, gammaDb: L.gammaDb, noiseTempK: T > 0 ? T : null, deltaTK: dT, pct: T > 0 ? dT / T * 100 : null });
        }
        const ps = caseII.links.map((l) => l.pct).filter(fin);
        caseII.combinedPct = ps.length ? Math.max(...ps) : null;
      }
    }
  }

  // 反向的地对地（X 上行 ∩ V 下行）：§2.2.2 明文不在本方法内（按地球站与地面台站的协调程序办），只报重叠
  const ovEE = bandOverlap(X.upBand, V.dnBand);

  // 与 6% 比的那个数：合成分支取两组中大的；独立分支取 ΔTs/Ts 与 ΔTe/Te 中大的；Case II 并入取大
  const cands = [];
  if (method === 'combined') { if (combinedPct != null) cands.push(combinedPct); }
  else { for (const v of [independent.dTsOverTsPct, independent.dTeOverTePct]) if (fin(v)) cands.push(v); }
  if (caseII) {
    const v = method === 'combined' ? caseII.combinedPct : caseII.dTsOverTsPct;
    if (fin(v)) cands.push(v);
  }
  const headlinePct = cands.length ? Math.max(...cands) : (!up && !dn && !caseII ? 0 : null);

  return {
    from: X.label, to: V.label,
    method,
    up, dn, yu, yd, polarizationApplied: !!ctx.applyPol,
    independent,
    links, combinedPct, worstLink,
    caseII,
    esToEsOverlapMHz: ovEE ? ovEE.mhz : 0,
    headlinePct,
    exceeds: headlinePct != null && headlinePct > THRESHOLD_PCT,
    missing
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * RR 附录 8 协调触发（GSO/GSO），双向。
 *
 * @param {object} o
 *   geometry           'rule'（附件 1/2 公式，缺省）| 'wgs84'
 *   applyPolarization  §2.2.3 极化隔离因子（双方主管部门同意才计），缺省 false
 *   own / other        两个网络，同形：
 *     lonDeg, ewTolDeg           标称轨位（°E）、东西保持容差（±°）
 *     service, region            业务（'FSS' 等）、服务区所在 ITU 区域（查协调弧用，取拟议方 = own）
 *     upBandGHz / dnBandGHz      上 / 下行指配频段 [lo, hi]；或 upCenterGHz / dnCenterGHz + bandwidthHz
 *     upPol / dnPol              'H' | 'V' | 'L'（左旋圆）| 'R'（右旋圆）
 *     txStation                  发端站 {lon, lat, alt(m), diameterM, efficiency(0–1), gainDbi?}
 *     rxStation                  收端站 {…同上, noiseTempK(Te)}
 *     txPowerDensityDbWPerHz     pe：AP4 最大功率密度；或 txPowerW + txFeederLossDb + bandwidthHz
 *     satRxGainDbi               g2：本网卫星朝**对方发端站**方向的接收增益
 *     satRxNoiseTempK            Ts；或 satGtDbPerK（与 satRxGainDbi 反解）
 *     satEirpDensityDbWPerHz     ps·g3：本网卫星朝**对方收端站**方向的最大 EIRP 密度；或 satEirpDbW + bandwidthHz
 *     satEirpDensityToSatDbWPerHz / satRxGainToSatDbi    Case II：朝对方卫星方向的 EIRP 密度 / 接收增益
 *     links                      [{noiseTempK: T, gammaDb: γ}] AP4 给的两组（§2.4 取大）；只给 γ 时 T = Te + γ·Ts
 *     regenerative               星上再生（变调制）→ §2.2.1.2 上下行分开比
 * @returns {object} { geometry, patternId, thresholdPct, lonDiffDeg, thetaGDeg, arc, ownToOther, otherToOwn, warnings }
 */
function ap8Coordination(o) {
  const opt = o || {};
  const warnings = [];
  const geom = GEOMETRY[opt.geometry === 'wgs84' ? 'wgs84' : 'rule'];
  const own = normNet(opt.own, '本网');
  const other = normNet(opt.other, '邻网');

  // 计入保持容差：两星各向对方挪一个容差
  const ap = G.gsoClosestApproach(own.lonDeg, other.lonDeg, own.ewTolDeg, other.ewTolDeg);
  const lonOf = (n) => (n === own ? ap.lonA : ap.lonB);
  const ctx = { geom, lonOf, thetaGDeg: ap.thetaGDeg, applyPol: !!opt.applyPolarization, warnings };

  // 各站看不见自家卫星：这条链路本身就不成立，照算但如实报
  for (const [n, s, k] of [[own, own.tx, '发端站'], [own, own.rx, '收端站'], [other, other.tx, '发端站'], [other, other.rx, '收端站']]) {
    if (!geom.range(s, lonOf(n)).visible) warnings.push(`${n.label} · ${k}看不见己方卫星`);
  }

  const ownToOther = direction(own, other, ctx);
  const otherToOwn = direction(other, own, ctx);

  // 附录 5 表 5-1 No.9.7：同向重叠的频段逐段查协调弧，与标称轨位差比（协调弧以标称轨位计，不计保持容差）
  const arcBands = [];
  for (const [key, a, b] of [['up', own.upBand, other.upBand], ['dn', own.dnBand, other.dnBand]]) {
    const ov = bandOverlap(a, b);
    if (!ov) { arcBands.push({ key, overlapMHz: 0, arcDeg: null, item: null, within: false }); continue; }
    const m = coordinationArc(ov.loGHz, ov.hiGHz, { region: own.region, service: own.service, otherService: other.service });
    arcBands.push({
      key, overlapMHz: ov.mhz, loGHz: ov.loGHz, hiGHz: ov.hiGHz,
      arcDeg: m.arcDeg, item: m.item,
      within: m.arcDeg != null && ap.nominalDeg <= m.arcDeg + 1e-9
    });
  }
  const arcs = arcBands.map((b) => b.arcDeg).filter(fin);

  return {
    geometry: geom.id,
    patternId: P.AP8_PATTERN,
    pattern: { id: P.AP8_PATTERN, name: P.ES_PATTERNS[P.AP8_PATTERN].name, edition: P.ES_PATTERNS[P.AP8_PATTERN].edition },
    thresholdPct: THRESHOLD_PCT,
    lonDiffDeg: ap.nominalDeg,
    thetaGDeg: ap.thetaGDeg,
    lonEffDeg: { own: ap.lonA, other: ap.lonB },
    arc: { bands: arcBands, maxArcDeg: arcs.length ? Math.max(...arcs) : null, within: arcBands.some((b) => b.within) },
    ownToOther,
    otherToOwn,
    warnings
  };
}

module.exports = {
  ap8Coordination,
  // 分项（测试与报告用）
  deltaTsK, deltaTeK, deltaTsCaseIIK, combineDeltaT,
  polarizationIsolationY, coordinationArc, bandOverlap,
  ruleSlantRangeKm, ruleInterSatKm, ruleTopocentricDeg, ruleFslDb,
  K_DB, THRESHOLD_PCT, AP5_TABLE: AP5
};
