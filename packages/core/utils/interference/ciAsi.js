// 干扰分析 · C/ASI 邻星干扰（GEO）
//
// 对标 SATSOFT「Edit GEO Link Budget Parameters › Interfering Downlinks」：给几颗干扰星的
// 轨位与 EIRP 密度，算出本条链路受到的邻星干扰。本模块把上行也一并做了，并顺带给出施扰
// 方向的 ΔT/T（协调判据）。
//
// ─── 为什么下行只要「轨位 + EIRP 密度」三个输入 ───────────────────────────────
// 期望载波与干扰载波进的是同一副天线、同一台低噪放、同一部解调器。写成比值时，接收系统
// 的一切（G/T、系统噪温、馈线损耗、解调门限）在分子分母上逐项抵消，只剩两样东西：
//     ① 两者的发射谱密度之差
//     ② 这副天线在两个方向上的增益之差（= 鉴别度）
// 这就是那个对话框只有三行输入的原因，也是本模块不需要用户填 G/T 的原因。
//
// ─── 三个容易算错的地方 ──────────────────────────────────────────────────────
//   ① 角度：必须是拓扑角，不是经度差（详见 geometry.js 的文件头）。
//   ② 包络：GEO 两颗星都不动 → 峰值包络 AP8/S.580，不是 S.1428（那是给动态场景的）。
//   ③ 合成：多干扰源在**线性域**功率相加，不是 dB 相加，也不是取最大。
//
// ─── 带宽口径 ────────────────────────────────────────────────────────────────
// 全程走谱密度（dBW/Hz）。当干扰源与被扰载波谱形一致时 C/I 与参考带宽无关，所以算出来的
// 数可以直接与链路预算引擎那套「转发器参考口径」的 C/I 对话——这正是本计算器与引擎解耦
// 却仍对得上账的物理依据。若干扰载波带宽小于被扰载波、只压住一部分频谱，由 overlapFactor
// 显式给出重叠比例，不做隐式假设。

const G = require('./geometry.js');
const P = require('./patterns.js');

const LOG10 = Math.log10;
const lin = (db) => Math.pow(10, db / 10);
const dB = (x) => 10 * LOG10(x);
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

const C_M_S = 299792458;
/** 频率(GHz) → 波长(m) */
const lambdaOf = (fGHz) => (fGHz > 0 ? C_M_S / (Number(fGHz) * 1e9) : null);

// ---------------------------------------------------------------------------
// 极化折减
// ---------------------------------------------------------------------------
//
// 干扰星与本星同极化 → 无折减；反极化 → 干扰要打掉一个 XPD 才落进来。
// 默认值 25 dB 是工程惯例的地球站极化鉴别度量级；用户给了实测/规格值就用给的。
// 圆极化（L/R）与线极化（H/V）混用时不存在稳定的鉴别度（理论上 3 dB），故按 3 dB 处理并
// 标记 mixed，让 UI 有机会提示。
const DEFAULT_XPD_DB = 25;

function polarizationDiscrimination(wantedPol, interfererPol, xpdDb) {
  const w = String(wantedPol || '').trim().toUpperCase();
  const i = String(interfererPol || '').trim().toUpperCase();
  if (!w || !i) return { db: 0, relation: 'unknown', mixed: false };
  if (w === i) return { db: 0, relation: 'co', mixed: false };
  const isLinear = (p) => p === 'H' || p === 'V';
  const isCirc = (p) => p === 'L' || p === 'R';
  if (isLinear(w) !== isLinear(i) && (isCirc(w) || isCirc(i))) {
    // 线 ↔ 圆：理论上只有 3 dB
    return { db: 3, relation: 'mixed', mixed: true };
  }
  return { db: num(xpdDb, DEFAULT_XPD_DB), relation: 'cross', mixed: false };
}

// ---------------------------------------------------------------------------
// 下行 C/ASI
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 *   station        {lon, lat, alt}          收信站站址（alt 单位 m）
 *   wanted         {lonDeg, eirpDbW, bandwidthHz, eirpDensityDbWPerHz?, polarization}
 *                  期望星：给 EIRP+带宽 或直接给谱密度
 *   rx             {diameterM, efficiency, freqGHz}   收信站天线（下行频率）
 *   interferers    [{ id, name, lonDeg, eirpDensityDbWPerHz, polarization?, xpdDb?,
 *                     overlapFactor?, enabled? }]
 *   applyPolarization  是否计入极化折减（默认 true）
 *
 * @returns {{ciDb, sources:[…], geometry:{…}, warnings:[…] }}
 *   ciDb 为 null 表示无有效干扰源（不是 0，也不是 Infinity——UI 应显示「—」）
 */
function downlinkCAsi(o) {
  const warnings = [];
  const st = o.station || {};
  const rx = o.rx || {};
  const wanted = o.wanted || {};
  const applyPol = o.applyPolarization !== false;

  const fGHz = num(rx.freqGHz, 0);
  const lam = lambdaOf(fGHz);
  const D = num(rx.diameterM, 0);
  const eff = num(rx.efficiency, 0.65);
  if (!(lam > 0)) { warnings.push('缺下行频率'); return { ciDb: null, sources: [], geometry: null, warnings }; }
  if (!(D > 0)) { warnings.push('缺收信站天线口径'); return { ciDb: null, sources: [], geometry: null, warnings }; }

  const gMax = P.peakGainDbi(D, lam, eff);

  // 期望载波谱密度
  let wantedDensity = num(wanted.eirpDensityDbWPerHz, NaN);
  if (!Number.isFinite(wantedDensity)) {
    const e = num(wanted.eirpDbW, NaN), b = num(wanted.bandwidthHz, NaN);
    if (Number.isFinite(e) && b > 0) wantedDensity = e - 10 * LOG10(b);
  }
  if (!Number.isFinite(wantedDensity)) {
    warnings.push('缺期望载波 EIRP 密度（给 EIRP + 占用带宽，或直接给 dBW/Hz）');
    return { ciDb: null, sources: [], geometry: null, warnings };
  }

  const wantedLook = G.lookAngles(st, G.gsoEcef(num(wanted.lonDeg, 0)));
  if (!(wantedLook.elevDeg > 0)) warnings.push('期望星在该站地平线以下');
  const fslWanted = G.fsl(wantedLook.rangeKm, fGHz);

  const sources = [];
  let sumLin = 0;

  for (const it of (o.interferers || [])) {
    if (!it || it.enabled === false) continue;
    const eDen = num(it.eirpDensityDbWPerHz, NaN);
    if (!Number.isFinite(eDen)) { warnings.push(`干扰星「${it.name || it.id || '?'}」缺 EIRP 密度，已跳过`); continue; }

    const sep = G.gsoSeparation(st, num(wanted.lonDeg, 0), num(it.lonDeg, 0));
    if (!sep.visible) {
      // lonDeg 与算得出的那一支同样带上：结果表在星名后标轨位，看不见的这几条更要标出来是哪一颗
      sources.push({ id: it.id, name: it.name, lonDeg: num(it.lonDeg, 0), thetaDeg: sep.thetaDeg, lonDiffDeg: sep.lonDiffDeg, skipped: '干扰星在地平线以下', ciDb: null, shareDb: null });
      continue;
    }

    const gOff = P.offAxisAP8(D, lam, eff, sep.thetaDeg);
    const discrimDb = gMax - gOff;                       // 天线鉴别度
    const fslInt = G.fsl(sep.interferer.rangeKm, fGHz);
    const pathDeltaDb = fslWanted - fslInt;              // 斜距差（通常 <0.2 dB，仍照算）

    const pol = applyPol
      ? polarizationDiscrimination(wanted.polarization, it.polarization, it.xpdDb)
      : { db: 0, relation: 'off', mixed: false };
    if (pol.mixed) warnings.push(`干扰星「${it.name || it.id}」与本星线/圆极化混用，鉴别度按 3 dB 计`);

    // 频谱重叠：干扰只压住被扰载波的一部分时，落进带内的干扰功率按比例折减
    const ov = num(it.overlapFactor, 1);
    const overlapDb = ov > 0 && ov <= 1 ? 10 * LOG10(ov) : 0;
    if (!(ov > 0 && ov <= 1) && it.overlapFactor !== undefined) warnings.push(`干扰星「${it.name || it.id}」重叠系数应在 (0,1]，已按 1 处理`);

    // (C/I₀)ⱼ = [期望谱密度 − 干扰谱密度] + 鉴别度 + 斜距差 + 极化折减 − 重叠
    const ciJ = (wantedDensity - eDen) + discrimDb + pathDeltaDb + pol.db - overlapDb;

    sumLin += lin(-ciJ);
    sources.push({
      id: it.id, name: it.name,
      lonDeg: num(it.lonDeg, 0),
      thetaDeg: sep.thetaDeg,
      lonDiffDeg: sep.lonDiffDeg,
      elevDeg: sep.interferer.elevDeg,
      azDeg: sep.interferer.azDeg,
      rangeKm: sep.interferer.rangeKm,
      offAxisGainDbi: gOff,
      discrimDb,
      pathDeltaDb,
      polDb: pol.db, polRelation: pol.relation,
      overlapDb,
      eirpDensityDbWPerHz: eDen,
      ciDb: ciJ,
      skipped: null
    });
  }

  const ciDb = sumLin > 0 ? -dB(sumLin) : null;
  // 逐源占比：这一路占总干扰功率的百分之多少（找主犯用）
  for (const s of sources) {
    s.shareDb = s.ciDb == null ? null : s.ciDb;
    s.sharePct = (s.ciDb == null || !(sumLin > 0)) ? null : (lin(-s.ciDb) / sumLin) * 100;
  }
  sources.sort((a, b) => (b.sharePct || -1) - (a.sharePct || -1));

  return {
    ciDb,
    sources,
    geometry: {
      wantedLonDeg: num(wanted.lonDeg, 0),
      wantedElevDeg: wantedLook.elevDeg,
      wantedAzDeg: wantedLook.azDeg,
      wantedRangeKm: wantedLook.rangeKm,
      peakGainDbi: gMax,
      beamwidth3dBDeg: P.beamwidth3dB(D, lam),
      wantedDensityDbWPerHz: wantedDensity,
      // 方向图分段环：供「聚焦主轴」视图画等离轴角环并**逐环标出该处的增益与鉴别度**。
      // 这是把「θ 是多少」翻译成「鉴别度是多少」的那一步——干扰星落在哪两环之间，
      // 它吃到多少鉴别度就一目了然，不必再去查表或反推。
      patternRings: patternRings(D, lam, eff, gMax, sources),
      // 方向图本身：对数角度轴上采样出的 G(φ) 曲线，供「方向图切面图」画成一条真实曲线。
      // 这才是天线工程师看的那张图（MATLAB antenna toolbox / ITU 建议书里的标准画法）——
      // 干扰星落在曲线上哪一点、离峰值掉了多少，一眼可读；环图只能表达角度，表达不了增益形状。
      patternCurve: patternCurve(D, lam, eff),
      // AP8 的结构角，供图上标注分段
      patternMarks: patternMarks(D, lam, eff, gMax)
    },
    warnings
  };
}

// 对数角度轴采样：0.01°–180°。主瓣区变化极快（抛物线），对数轴才能既看清主瓣又装下远旁瓣。
function patternCurve(D, lam, eff) {
  const out = [];
  const lo = Math.log10(0.01), hi = Math.log10(180);
  const N = 400;
  for (let i = 0; i <= N; i++) {
    const deg = Math.pow(10, lo + (hi - lo) * i / N);
    const g = P.offAxisAP8(D, lam, eff, deg);
    if (Number.isFinite(g)) out.push({ deg: +deg.toFixed(5), gainDbi: +g.toFixed(3) });
  }
  return out;
}

// AP8 的分段结构角：主瓣半宽 / φ₁（主瓣-旁瓣交界）/ φr（第一旁瓣平台外沿）/ 29−25lgφ 段终点
function patternMarks(D, lam, eff, gMax) {
  const ratio = D / lam;
  const bw = P.beamwidth3dB(D, lam);
  const out = [];
  if (bw > 0) out.push({ deg: +(bw / 2).toFixed(4), key: 'hpbw', label: '主瓣半宽' });
  if (ratio >= 100) {
    const G1 = 2 + 15 * LOG10(ratio);
    out.push({ deg: +((20 * lam / D) * Math.sqrt(Math.max(0, gMax - G1))).toFixed(4), key: 'phi1', label: 'φ₁ 主瓣边界' });
    out.push({ deg: +(15.85 * Math.pow(ratio, -0.6)).toFixed(4), key: 'phir', label: 'φr 旁瓣平台外沿' });
    out.push({ deg: 36.31, key: 'far', label: '远旁瓣 −10 dBi' });
  } else if (ratio >= 50) {
    out.push({ deg: 48, key: 'far', label: '远场底板' });
  } else {
    out.push({ deg: 48, key: 'far', label: '远场底板' });
  }
  for (const m of out) m.gainDbi = +P.offAxisAP8(D, lam, eff, m.deg).toFixed(2);
  return out.filter((m) => m.deg > 0).sort((a, b) => a.deg - b.deg);
}

// 环的档位：主瓣半宽 + AP8 的两个结构角（φ₁ 主瓣/旁瓣交界、φr 旁瓣平台外沿）+ 工程刻度。
// 只保留落在实际干扰源角度范围内的那几档，免得画一堆用不上的环把图挤满。
function patternRings(D, lam, eff, gMax, sources) {
  const bw = P.beamwidth3dB(D, lam);
  const ratio = D / lam;
  const cand = [];
  if (bw > 0) cand.push({ deg: bw / 2, kind: 'main', label: '主瓣边缘' });
  if (ratio >= 100) {
    const G1 = 2 + 15 * LOG10(ratio);
    cand.push({ deg: (20 * lam / D) * Math.sqrt(Math.max(0, gMax - G1)), kind: 'phi1', label: 'φ₁' });
    cand.push({ deg: 15.85 * Math.pow(ratio, -0.6), kind: 'phir', label: 'φr' });
  }
  for (const d of [0.5, 1, 2, 3, 5, 8, 12, 20, 30]) cand.push({ deg: d, kind: 'tick', label: d + '°' });

  const maxTheta = sources.reduce((m, s) => (Number.isFinite(s.thetaDeg) && s.thetaDeg > m ? s.thetaDeg : m), 0);
  const lim = maxTheta > 0 ? maxTheta * 1.35 : 5;
  const out = [];
  for (const c of cand) {
    if (!(c.deg > 0) || c.deg > lim) continue;
    if (out.some((o) => Math.abs(o.deg - c.deg) < lim * 0.04)) continue;   // 太近的档并掉
    const g = P.offAxisAP8(D, lam, eff, c.deg);
    out.push({ ...c, deg: +c.deg.toFixed(4), gainDbi: +g.toFixed(2), discrimDb: +(gMax - g).toFixed(2) });
  }
  out.sort((a, b) => a.deg - b.deg);
  return out;
}

// ---------------------------------------------------------------------------
// 上行几何图：离轴 EIRP 密度 vs 离轴角
// ---------------------------------------------------------------------------
//
// 下行那张图画的是**本站接收天线**的方向图 —— 干扰漏进来多少，由「我这面天线在那个角度上
// 给多少增益」决定。上行反过来：干扰是**邻网的发射站**朝它自己的星发、旁瓣泼进本星，
// 决定量的是「那座站在那个角度上往外泼多少 EIRP 密度」。既不是同一条曲线，也不是同一个
// 角度（非共址时干扰站看到的夹角与本站看到的不同），所以必须单独画一张，不能拿下行那张凑。
//
// 纵轴取 dBW/Hz 而不是 dBi：三种干扰源模型只有在「离轴 EIRP 密度」这个量上才对得起来 ——
// 掩模模式根本没有天线，建议书给的就是密度上限。于是同一张图上：
//   · S.524 掩模      监管天花板
//   · 对等站曲线      按一副真天线算出来的实际泼洒 —— 两者的落差就是那 27 dB（见 §9.3）
//   · 本站上行密度    一条水平线，它到干扰点的垂直距离**就是**该源的 C/I
// 三者共一根纵轴，前两者的关系与「这个数是硬上界还是预期值」于是成了图上一眼可读的事。

const UP_CURVE_LO_DEG = 0.05;
const UP_CURVE_HI_DEG = 180;
const UP_CURVE_N = 320;

/** 对数角度轴采样点（度）。跨 0.05°–180° 三个多数量级，线性轴会把近轴段整个压没。 */
function logAngleAxis(loDeg, hiDeg, n) {
  const lo = LOG10(loDeg), hi = LOG10(hiDeg);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(Math.pow(10, lo + (hi - lo) * i / n));
  return out;
}

/**
 * S.524 离轴 EIRP 密度掩模曲线。
 * φ < φ₀ 段建议书**不设限**（这里按 φ₀ 处连续钳住，见 patterns.js 的 §S524 注释），
 * 逐点带 belowScope 标出，由 UI 虚化——画成实线会让人以为主瓣区也有这么一条限值。
 */
function s524Curve(fGHz, angles) {
  const out = [];
  for (const deg of angles) {
    const m = P.s524OffAxisEirpDensity(deg, fGHz);
    if (!m) return [];
    out.push({ deg: +deg.toFixed(5), densityDbWPerHz: +m.densityDbWPerHz.toFixed(3), belowScope: !!m.belowScope });
  }
  return out;
}

/** S.524 的分段结构角，供图上标注：φ₀ / 7° 平台起 / 9.2° 平台止 / 48° 底板。 */
function s524Marks(fGHz) {
  const probe = P.s524OffAxisEirpDensity(10, fGHz);
  if (!probe) return [];
  const out = [
    { deg: probe.phi0, key: 'phi0', label: `φ₀ ${probe.phi0}°` },
    { deg: 7, key: 'plateau', label: '7° 平台' },
    { deg: 48, key: 'floor', label: '48° 底板' }
  ];
  for (const m of out) {
    const v = P.s524OffAxisEirpDensity(m.deg, fGHz);
    m.densityDbWPerHz = v ? +v.densityDbWPerHz.toFixed(2) : null;
  }
  return out.filter((m) => m.deg > 0);
}

/** 对等站的离轴 EIRP 密度曲线：主轴密度 − Gmax + G(φ)，即把那副天线的方向图搬到密度轴上。 */
function peerDensityCurve(cfg, lam, angles) {
  const gMax = P.peakGainDbi(cfg.diameterM, lam, cfg.efficiency);
  if (!Number.isFinite(gMax) || !(cfg.bandwidthHz > 0)) return [];
  const base = cfg.eirpDbW - gMax - 10 * LOG10(cfg.bandwidthHz);
  const out = [];
  for (const deg of angles) {
    const g = P.offAxisAP8(cfg.diameterM, lam, cfg.efficiency, deg);
    if (Number.isFinite(g)) out.push({ deg: +deg.toFixed(5), densityDbWPerHz: +(base + g).toFixed(3) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 上行 C/ASI
// ---------------------------------------------------------------------------

/**
 * 受扰方向：邻网的地球站朝它自己的星发射，旁瓣落进**本星**。
 *
 * ─── 干扰源模型三选一，选哪个决定了这个数是什么意思 ─────────────────────────
 *
 *   'peer'（默认）—— 把干扰站按一副具体的天线来建模（口径/功率/带宽/馈损），用同一条
 *                    AP8 包络算它朝本星方向的旁瓣 EIRP 密度。**这是工程估算该用的模式**。
 *
 *   'mask'        —— 按 ITU-R S.524-9 离轴 EIRP 密度上限，假设邻网每座站都顶着限值、
 *                    在整个重叠带内满发。这是**监管硬上界**，不是运行值。
 *                    实测：北京 4.5 m 站、110.5°E 对 113°E（θ=2.81°），
 *                      掩模模式 C/ASI ≈ 6.9 dB；同类站对打 ≈ 36.9 dB——差 27 dB。
 *                    因为真实站的离轴密度离限值还差得远（+0.76 vs +27.78 dBW/40kHz）。
 *                    用它来卡协调门限、做最坏情形包络是对的；当作预期值会严重吓人。
 *
 *   'explicit'    —— 用户直接给干扰站朝本星方向的离轴 EIRP 密度（拿到对方实测数据时）。
 *
 * satDiscrimDb：本星接收天线在「本站方向」与「干扰站方向」上的增益差。
 *   干扰站与本站共址（最坏）时为 0——这是默认。有 GRD 方向图时由调用方采样后传入。
 */
function uplinkCAsi(o) {
  const warnings = [];
  const st = o.station || {};
  const tx = o.tx || {};
  const wanted = o.wanted || {};
  const applyPol = o.applyPolarization !== false;
  const mode = (o.sourceMode === 'explicit' || o.sourceMode === 'mask') ? o.sourceMode : 'peer';

  const fGHz = num(tx.freqGHz, 0);
  const lam = lambdaOf(fGHz);
  const D = num(tx.diameterM, 0);
  const eff = num(tx.efficiency, 0.65);
  if (!(lam > 0)) { warnings.push('缺上行频率'); return { ciDb: null, sources: [], geometry: null, warnings }; }
  if (!(D > 0)) { warnings.push('缺发信站天线口径'); return { ciDb: null, sources: [], geometry: null, warnings }; }

  const gMax = P.peakGainDbi(D, lam, eff);

  // 本站上行谱密度：给 EIRP+带宽，或功放功率 + 增益 − 馈损
  let ownDensity = num(tx.eirpDensityDbWPerHz, NaN);
  if (!Number.isFinite(ownDensity)) {
    let eirp = num(tx.eirpDbW, NaN);
    if (!Number.isFinite(eirp)) {
      const pw = num(tx.powerW, NaN), fl = num(tx.feederLossDb, 0);
      if (pw > 0) eirp = 10 * LOG10(pw) + gMax - fl;
    }
    const b = num(tx.bandwidthHz, NaN);
    if (Number.isFinite(eirp) && b > 0) ownDensity = eirp - 10 * LOG10(b);
  }
  if (!Number.isFinite(ownDensity)) {
    warnings.push('缺本站上行 EIRP 密度（给 EIRP + 占用带宽，或功放功率 + 带宽）');
    return { ciDb: null, sources: [], geometry: null, warnings };
  }

  const sources = [];
  const peerCfgs = new Map();          // 几何图用：同参数的对等站合成一条曲线，不逐源重画
  let sumLin = 0;

  for (const it of (o.interferers || [])) {
    if (!it || it.enabled === false) continue;
    const sep = G.gsoSeparation(st, num(wanted.lonDeg, 0), num(it.lonDeg, 0));

    let intDensity, maskInfo = null, peerInfo = null, curveKey = null;
    if (mode === 'explicit') {
      intDensity = num(it.offAxisEirpDensityDbWPerHz, NaN);
      if (!Number.isFinite(intDensity)) { warnings.push(`干扰站「${it.name || it.id || '?'}」缺离轴 EIRP 密度，已跳过`); continue; }
    } else if (mode === 'peer') {
      // 干扰站的几何：默认与本站共址（最坏——两站看同步弧的夹角相同）；
      // 给了 station.lon/lat 就按它自己的站址算，此时它朝本星的离轴角与本站看到的不同。
      const iSt = (Number.isFinite(Number(it.stationLon)) && Number.isFinite(Number(it.stationLat)))
        ? { lon: Number(it.stationLon), lat: Number(it.stationLat), alt: num(it.stationAlt, 0) }
        : st;
      const coLocated = iSt === st;
      // 干扰站主轴指向它自己的星（it.lonDeg），离轴角 = 它看「本星 ↔ 它的星」的夹角
      const iTheta = G.topocentricAngle(iSt, G.gsoEcef(num(wanted.lonDeg, 0)), G.gsoEcef(num(it.lonDeg, 0)));
      const iD = num(it.diameterM, num(tx.diameterM, 0));
      const iEff = num(it.efficiency, num(tx.efficiency, 0.65));
      const iLam = lam;                                   // 同一上行频段
      if (!(iD > 0)) { warnings.push(`干扰站「${it.name || it.id || '?'}」缺口径，已跳过`); continue; }
      const iGmax = P.peakGainDbi(iD, iLam, iEff);
      const iGoff = P.offAxisAP8(iD, iLam, iEff, iTheta);

      let iEirp = num(it.eirpDbW, NaN);
      if (!Number.isFinite(iEirp)) {
        const pw = num(it.powerW, NaN), fl = num(it.feederLossDb, num(tx.feederLossDb, 0));
        if (pw > 0) iEirp = 10 * LOG10(pw) + iGmax - fl;
      }
      const iBw = num(it.bandwidthHz, NaN);
      if (!Number.isFinite(iEirp) || !(iBw > 0)) {
        warnings.push(`干扰站「${it.name || it.id || '?'}」缺功率或占用带宽（对等站模式需要），已跳过`);
        continue;
      }
      // 主轴 EIRP 密度 → 换成旁瓣方向的密度
      intDensity = iEirp - iGmax + iGoff - 10 * LOG10(iBw);
      peerInfo = { thetaDeg: iTheta, diameterM: iD, peakGainDbi: iGmax, offAxisGainDbi: iGoff, eirpDbW: iEirp, bandwidthHz: iBw, coLocated };
      curveKey = `${iD}|${iEff}|${iEirp.toFixed(4)}|${iBw}`;
      if (!peerCfgs.has(curveKey)) {
        peerCfgs.set(curveKey, { key: curveKey, diameterM: iD, efficiency: iEff, eirpDbW: iEirp, bandwidthHz: iBw, peakGainDbi: iGmax });
      }

      // 顺带核一下这座假想的干扰站自己合不合规——超了说明这个假设本身不成立
      const chk = P.s524OffAxisEirpDensity(iTheta, fGHz);
      if (chk && intDensity > chk.densityDbWPerHz) {
        warnings.push(`干扰站「${it.name || it.id}」的离轴密度 ${intDensity.toFixed(1)} dBW/Hz 已超 S.524 限值 ${chk.densityDbWPerHz.toFixed(1)}——该站本身不合规，结果仅供参考`);
      }
    } else {
      maskInfo = P.s524OffAxisEirpDensity(sep.thetaDeg, fGHz);
      if (!maskInfo) { warnings.push(`频率 ${fGHz} GHz 无 S.524 掩模数据，上行干扰无法估计`); continue; }
      if (maskInfo.fallback) warnings.push(`频率 ${fGHz} GHz 不在 S.524 明列频段，掩模按「${maskInfo.band}」近似`);
      // φ < φ₀：建议书在主瓣区**根本不设限**，这里取的是 φ₀ 处的钳位值（见 patterns.js §S524）。
      // 不出声的话，轨位挨得近的几颗星会得到**一模一样**的干扰密度、一模一样的 C/I，看着像算错了
      // ——其实是掩模模型本身在这个角上失效。这一句必须说出来。
      if (maskInfo.belowScope) {
        warnings.push(`干扰源「${it.name || it.id || '?'}」离轴角 ${sep.thetaDeg.toFixed(3)}° 在 S.524 的 φ₀=${maskInfo.phi0}° 以内，`
          + '建议书对该角不设限、此处取 φ₀ 处的钳位值 —— 掩模模式对这一源不成立，请改用对等站或逐站给定');
      }
      intDensity = maskInfo.densityDbWPerHz;
    }

    const pol = applyPol
      ? polarizationDiscrimination(wanted.polarization, it.polarization, it.xpdDb)
      : { db: 0, relation: 'off', mixed: false };

    const ov = num(it.overlapFactor, 1);
    const overlapDb = ov > 0 && ov <= 1 ? 10 * LOG10(ov) : 0;

    // 本站相对干扰站在本星处的天线增益差（共址最坏 = 0）
    const satDiscrimDb = num(it.satDiscrimDb, num(o.satDiscrimDb, 0));

    const ciJ = (ownDensity - intDensity) + satDiscrimDb + pol.db - overlapDb;

    sumLin += lin(-ciJ);
    sources.push({
      id: it.id, name: it.name,
      lonDeg: num(it.lonDeg, 0),
      thetaDeg: sep.thetaDeg,
      lonDiffDeg: sep.lonDiffDeg,
      // 几何图的横坐标：这一源实际吃的那个离轴角。对等站非共址时它与本站看到的 thetaDeg
      // 不是一个数——画错了曲线上的落点就错，鉴别度也就跟着错。
      offAxisDeg: peerInfo ? peerInfo.thetaDeg : sep.thetaDeg,
      interfererDensityDbWPerHz: intDensity,
      // 折算掉卫星鉴别/极化/重叠之后的等效密度：ciDb ≡ ownDensity − effectiveDensity。
      // 图上从曲线落点垂直落到这个高度的那一段，就是这三项一共给了多少。
      effectiveDensityDbWPerHz: intDensity - satDiscrimDb - pol.db + overlapDb,
      curveKey,
      maskBand: maskInfo ? maskInfo.band : null,
      maskLimitDb: maskInfo ? maskInfo.limitDb : null,
      maskRefBwHz: maskInfo ? maskInfo.refBwHz : null,
      maskBelowScope: maskInfo ? !!maskInfo.belowScope : false,
      peer: peerInfo,
      satDiscrimDb,
      polDb: pol.db, polRelation: pol.relation,
      overlapDb,
      ciDb: ciJ,
      skipped: null
    });
  }

  const ciDb = sumLin > 0 ? -dB(sumLin) : null;
  for (const s of sources) s.sharePct = !(sumLin > 0) ? null : (lin(-s.ciDb) / sumLin) * 100;
  sources.sort((a, b) => (b.sharePct || -1) - (a.sharePct || -1));

  // 几何图的曲线：掩模始终给（哪种模式下它都是那条监管天花板），对等站曲线只有 peer 模式有
  const angles = logAngleAxis(UP_CURVE_LO_DEG, UP_CURVE_HI_DEG, UP_CURVE_N);
  const maskRef = P.s524OffAxisEirpDensity(10, fGHz);
  const peerCurves = [...peerCfgs.values()].map((c) => ({
    key: c.key,
    diameterM: c.diameterM,
    efficiency: c.efficiency,
    eirpDbW: c.eirpDbW,
    bandwidthHz: c.bandwidthHz,
    peakGainDbi: c.peakGainDbi,
    // 主瓣半宽：落点若在这以内，「旁瓣泼洒」这套模型本身就不成立，UI 据此提示
    mainLobeDeg: P.beamwidth3dB(c.diameterM, lam) / 2,
    curve: peerDensityCurve(c, lam, angles)
  }));

  return {
    ciDb,
    sources,
    geometry: {
      peakGainDbi: gMax,
      ownDensityDbWPerHz: ownDensity,
      sourceMode: mode,
      freqGHz: fGHz,
      // 上行几何图（离轴 EIRP 密度 vs 离轴角）。渲染端不复算任何一条——复算必与引擎漂移。
      maskCurve: s524Curve(fGHz, angles),
      maskMarks: s524Marks(fGHz),
      maskBand: maskRef ? maskRef.band : null,
      maskAuthoritative: maskRef ? maskRef.authoritative : false,
      maskPhi0Deg: maskRef ? maskRef.phi0 : null,
      peerCurves
    },
    warnings
  };
}

// ---------------------------------------------------------------------------
// 施扰侧：ΔT/T（RR 附录 8）
// ---------------------------------------------------------------------------

/**
 * 本网对邻网的干扰增量：ΔT/T = (ΔT / T_邻网) ，超过门限即触发协调。
 *
 * ΔT = 本站旁瓣 EIRP 密度 落到邻星接收天线上，折算成等效噪温升。
 *   ΔT = Pt·Gt(θ) · Gr / (k · 4πd² ) · (λ²/4π) ... 在 dB 域整理为：
 *   ΔT(dBK) = 本站旁瓣EIRP密度(dBW/Hz) − FSL(dB) + 邻星G/T(dB/K) − 邻星G(dBi) + 邻星G(dBi) ...
 *
 * 工程上更直接的写法（AP8 口径）：
 *   ΔT/T (dB) = 旁瓣EIRP密度 − FSL + 邻星G_r − 10lg(k) − 10lg(T_邻网)
 *             = 旁瓣EIRP密度 − FSL + 邻星(G/T) + 228.6 − 10lg(T) − 10lg(T)  ← 易错
 * 为免歧义，本函数直接吃邻星的 G/T：
 *   ΔT/T = 10^[(旁瓣EIRP密度 − FSL + G/T_邻星 + 228.6)/10] / T_邻星 … 仍需 T
 * 故实现取最不易错的形式：由 G/T 与 G 反解 T_邻星，再算 ΔT。
 *
 * 门限：RR AP8 常用 6%（ΔT/T ≤ 6% 视为不需协调）。
 *
 * @param {object} o
 *   station {lon,lat,alt} 本站；tx {diameterM, efficiency, freqGHz, powerW|eirpDbW, bandwidthHz, feederLossDb}
 *   wanted {lonDeg}；victim {lonDeg, gOverTDbPerK, rxGainDbi}
 * @returns {{deltaTOverTPct, deltaTK, victimTk, thetaDeg, sidelobeEirpDensity, exceeds6pct}|null}
 */
function deltaTOverT(o) {
  const st = o.station || {}, tx = o.tx || {}, wanted = o.wanted || {}, victim = o.victim || {};
  const fGHz = num(tx.freqGHz, 0);
  const lam = lambdaOf(fGHz);
  const D = num(tx.diameterM, 0), eff = num(tx.efficiency, 0.65);
  if (!(lam > 0) || !(D > 0)) return null;

  const gOverT = num(victim.gOverTDbPerK, NaN);
  const gRx = num(victim.rxGainDbi, NaN);
  if (!Number.isFinite(gOverT) || !Number.isFinite(gRx)) return null;

  const sep = G.gsoSeparation(st, num(wanted.lonDeg, 0), num(victim.lonDeg, 0));
  const gMax = P.peakGainDbi(D, lam, eff);

  // 本站朝邻星方向的旁瓣 EIRP 密度
  let eirp = num(tx.eirpDbW, NaN);
  if (!Number.isFinite(eirp)) {
    const pw = num(tx.powerW, NaN), fl = num(tx.feederLossDb, 0);
    if (pw > 0) eirp = 10 * LOG10(pw) + gMax - fl;
  }
  const bw = num(tx.bandwidthHz, NaN);
  if (!Number.isFinite(eirp) || !(bw > 0)) return null;
  const sidelobeGain = P.offAxisAP8(D, lam, eff, sep.thetaDeg);
  // EIRP 密度里的增益换成旁瓣增益
  const sidelobeEirpDensity = eirp - gMax + sidelobeGain - 10 * LOG10(bw);

  const fslDb = G.fsl(sep.interferer.rangeKm, fGHz);
  // 落到邻星接收机输入端的干扰功率谱密度（dBW/Hz）
  const iDensity = sidelobeEirpDensity - fslDb + gRx;
  // ΔT = I₀ / k
  const deltaTK = lin(iDensity + 228.6);          // 228.6 = −10lg(k)
  const victimTk = lin(gRx - gOverT);             // T = G / (G/T)
  if (!(victimTk > 0)) return null;

  const pct = (deltaTK / victimTk) * 100;
  return {
    thetaDeg: sep.thetaDeg,
    lonDiffDeg: sep.lonDiffDeg,
    sidelobeGainDbi: sidelobeGain,
    sidelobeEirpDensityDbWPerHz: sidelobeEirpDensity,
    fslDb,
    deltaTK,
    victimTk,
    deltaTOverTPct: pct,
    exceeds6pct: pct > 6
  };
}

module.exports = { downlinkCAsi, uplinkCAsi, deltaTOverT, polarizationDiscrimination, DEFAULT_XPD_DB, lambdaOf };
