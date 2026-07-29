// 干扰分析 · 空间站（卫星侧）发射方向图与波束指向
//
// 与地球站的 patterns.js 并列。NGSO 时变 C/I 的首版缺的就是这一层：地平线以上的每一颗
// 干扰星都按满 EIRP 谱密度计入，不问它的波束此刻指向哪里。于是算出来的量准确的说法是
// 「若所有干扰星在任意方向都满功率发射时的聚合 C/I」——一个有意义的上界包络，
// 但不能不加限定地叫「NGSO C/I」。实测（1584 颗 Walker @ 北京，1.2 m/12.5 GHz）：
// 89 颗可见星里，46.5% 的聚合干扰来自离轴 40° 以外的星，真实系统里那些波束照着别的大洲。
//
// ─── 两个半独立的量：方向图形状 × 波束指向 ─────────────────────────────────────
// 指向比方向图本身更要紧：同一副天线，波束盯着本站（worst）与指着星下点（nadir）差出的
// 是整个主瓣-旁瓣落差。故 mode 与 pointing 分开给，互不耦合。
//
//   mode      形状          何时用
//   none      各向同性      = v1.3.6 行为。保留做上界包络与回归对比（active=false，引擎整条跳过）
//   s1528     ITU-R S.1528  默认。只有设计参数时
//   grd       GRD 实测图    有干扰星实测方向图时（增益由调用方注入的采样器给）
//   gaussian  高斯主瓣      兜底，approx=true，只主瓣内可信
//
// ★ 多波束 GRD：一份 GRD 常含多个 set。干扰算的是与受扰载波**同频**的那一个波束，
//   不是整副天线——不同波束照的是不同小区。不指定波束时按「全部波束取最大」计，那是
//   上界不是实际值（实测两波束、峰值差 3 dB、相隔约 11°：同一地面点两种口径的相对滚降
//   差 17.5 dB），此时必出告警。波束由 grd.beamPick 指定，采样与峰值归一同时跟着走。
//
//   pointing  波束轴        适用
//   nadir     星下点        固定天线 / 粗估
//   cells     地面小区网格  相控阵星座，最接近真实
//   worst     始终照本站    上界（= 现状的等效，离轴恒为 0）
//
// ─── 系数出处 ───────────────────────────────────────────────────────────────
// S.1528 的分段与全部系数**不在本文件里**：直接复用 utils/pfdmask/s1528.js —— 那份是按
// ITU-R S.1528 (2001) 正文逐段核对写的，三个 recommends 全实现，原文 Annex 1/2 的算例
// 已作 golden test（含两处原文问题的处置说明：§1.4 的 J₀(l) 笔误、§1.3 缺 D/λ≥35 的形式）。
// 一份系数只存一处，本文件只做「分派 + 指向几何 + 相对滚降」。
//
// ─── 为什么返回**相对**滚降而不是绝对增益 ────────────────────────────────────
// 干扰源的入参是 eirpDensityDbWPerHz —— 满 EIRP 谱密度，里头已经含了卫星天线的峰值增益。
// 故方向图在这里的作用是一条修正：EIRP(θ) = EIRP_peak + [G(θ) − G(0)]，恒 ≤ 0。
// 这样 mode:'none' 天然等价于「修正为 0」，回归锁不需要任何特判；也不必逼用户把 EIRP
// 拆成 Ptx + Gpeak（那个拆分工程上常常拿不到）。

const S1528 = require('../pfdmask/s1528.js');
const P = require('./patterns.js');
const G = require('./geometry.js');

const LOG10 = Math.log10;
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

// 由 ψb 反推峰值增益时用的常数：Gm ≈ 20lg(D/λ) + 7.974。
// 出处不是记忆，是 S.1528 §1.3 的 MEO/LEO 等价式与主式相等所要求的那个常数
// （见 utils/pfdmask/s1528.js 的 altConst 注释）。它隐含 η ≈ 63%。
const GM_FROM_APERTURE_CONST = 7.974;

/** 「远区」的定义：地球站离轴 40° 以外。评审基线里 46.5% 的聚合干扰来自这一区。 */
const FAR_OFF_AXIS_DEG = 40;

// ---------------------------------------------------------------------------
// 地面小区网格（pointing = 'cells'）
// ---------------------------------------------------------------------------
//
// 最小实现，刻意不做成完整的等面积球面剖分：
//   · 纬度按 Δlat = 小区间距 / 每度公里数 分带，带内经度步长按 Δlat/cos(带中心纬度) 取，
//     使小区大致成方——量化是确定性的 O(1) 映射，同一入参两次跑逐位一致（可复现是硬要求）。
//   · 「本站的小区有没有被这颗星照到」不去枚举小区，而是按面积密度反推：
//     卫星服务离星下点最近的 beamsPerSat 个小区 ⇒ 覆盖一个角半径 γ 的球冠，
//     2πR²(1−cos γ) / 小区面积 = beamsPerSat。本站小区落在 γ 内即被照到。
//   · γ 还要被卫星的地平半角截住——波束照不到地平线以下。
// 这套模型的取舍写在这里：小区中心的量化误差与 R 的球近似，合计给指向角带来 ~0.02° 的
// 不确定度，相对波束宽度（度量级）可忽略；它不是精确的星上资源调度模型，也不打算是。

const KM_PER_DEG = Math.PI * G.A_KM / 180;      // 子午线上每度的公里数 ≈ 111.195

/** 把任一经纬度量化到它所属小区的中心。 */
function cellCenter(lonDeg, latDeg, spacingKm) {
  const dLat = spacingKm / KM_PER_DEG;
  let latC = Math.round(Number(latDeg) / dLat) * dLat;
  if (latC > 90) latC = 90; else if (latC < -90) latC = -90;
  const cosLat = Math.max(Math.cos(latC * G.DEG), 1e-3);       // 极区不让步长发散
  const dLon = dLat / cosLat;
  let lonC = Math.round(Number(lonDeg) / dLon) * dLon;
  // 规整到 (−180, 180]
  lonC = ((lonC + 180) % 360 + 360) % 360 - 180;
  return { lonDeg: lonC, latDeg: latC, dLatDeg: dLat, dLonDeg: dLon };
}

/** 服务 n 个最近小区所覆盖的球冠角半径 cos γ（间距 s km，地球半径 R km）。 */
function cellCapCosGamma(beamsPerSat, spacingKm) {
  const n = Math.max(1, Number(beamsPerSat) || 1);
  const s = Math.max(1e-6, Number(spacingKm) || 1);
  const c = 1 - (n * s * s) / (2 * Math.PI * G.A_KM * G.A_KM);
  return Math.max(-1, Math.min(1, c));
}

// ---------------------------------------------------------------------------
// 形状：相对滚降 G(θ) − G(0)
// ---------------------------------------------------------------------------

/**
 * 建形状求值器。返回 { relDb(thetaDeg), info, warnings }，relDb ≤ 0。
 * grd 模式不吃角度、吃地面点，故这里返回 null，由 makeSatPattern 走另一条路。
 */
function makeShape(cfg) {
  const mode = cfg.mode;
  const warnings = [];
  const bw = num(cfg.beamwidth3dBDeg, null);

  if (mode === 'gaussian') {
    if (!(bw > 0)) throw new Error('卫星方向图（高斯）缺 3 dB 波束宽度');
    const floorRel = num(cfg.sidelobeFloorDb, -30);          // 相对峰值的旁瓣底板
    warnings.push('卫星方向图采用高斯近似，仅主瓣内有效；离轴较大时应改用 S.1528 或导入 GRD');
    return {
      relDb: (th) => P.gaussianSatBeam(0, bw, th, floorRel).gain,
      info: { mode, shape: '高斯主瓣近似', approx: true, beamwidth3dBDeg: bw, sidelobeFloorDb: floorRel },
      warnings
    };
  }

  if (mode === 's1528') {
    const section = String(cfg.s1528Section || '1.2');
    // ψb = 半个 3 dB 波束宽（S.1528 的定义），UI 给的是全宽 → 折半，别在引擎里猜
    const psib = num(cfg.psibDeg, null) != null ? num(cfg.psibDeg, null)
      : (bw > 0 ? S1528.psibFromFullBeamwidth(bw) : null);
    if (!(psib > 0)) throw new Error('卫星方向图（S.1528）缺 3 dB 波束宽度或 ψb');
    // Gm 缺省时由 ψb 反推（D/λ = √1200/ψb），并如实标出这是推的不是填的
    let Gm = num(cfg.peakGainDbi, null);
    let gmDerived = false;
    const dOverLam = num(cfg.dOverLambda, null) != null ? num(cfg.dOverLambda, null) : Math.sqrt(1200) / psib;
    if (Gm == null) {
      Gm = 20 * LOG10(dOverLam) + GM_FROM_APERTURE_CONST;
      gmDerived = true;
      warnings.push(`未给出卫星峰值增益，已由 ψb=${psib.toFixed(3)}° 反推为 ${Gm.toFixed(2)} dBi（D/λ=${dOverLam.toFixed(1)}，隐含 η≈63%）；如有实测或星表数值，应直接填入`);
    }

    if (section === '1.3') {
      const p = {
        peakGainDbi: Gm, psibDeg: psib, mode: String(cfg.satMode || 'LEO').toUpperCase(),
        dOverLambda: dOverLam, farOutDbi: num(cfg.farOutDbi, 0),
        outOfDomain: cfg.outOfDomain || 'throw'
      };
      const d = S1528.derivedS1528_13(p);
      for (const w of d.warnings) warnings.push('S.1528 §1.3：' + w);
      return {
        relDb: (th) => S1528.gainDbS1528_13(Math.min(180, th), p, d) - Gm,
        info: { mode, shape: 'ITU-R S.1528 §1.3', section: '1.3', satMode: p.mode, peakGainDbi: Gm, peakGainDerived: gmDerived, psibDeg: psib, dOverLambda: dOverLam, farOutDbi: p.farOutDbi },
        warnings
      };
    }

    const p = {
      peakGainDbi: Gm, psibDeg: psib, Ln: num(cfg.Ln, -25),
      axisRatioZ: num(cfg.axisRatioZ, 1), farOutDbi: num(cfg.farOutDbi, 0)
    };
    const d = S1528.derivedS1528_12(p);
    for (const w of d.warnings) warnings.push('S.1528 §1.2：' + w);
    return {
      relDb: (th) => S1528.gainDbS1528_12(Math.min(180, th), p, d) - Gm,
      info: { mode, shape: 'ITU-R S.1528 §1.2', section: '1.2', peakGainDbi: Gm, peakGainDerived: gmDerived, psibDeg: psib, Ln: p.Ln, axisRatioZ: p.axisRatioZ, farOutDbi: p.farOutDbi, provisional: d.provisional },
      warnings
    };
  }

  throw new Error(`未知的卫星方向图模式：${mode}`);
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/**
 * 建一个卫星侧方向图 + 指向的求值器。
 *
 * @param {object} cfg
 *   mode 'none'|'s1528'|'grd'|'gaussian'，pointing 'nadir'|'cells'|'worst'
 *   beamwidth3dBDeg / psibDeg / peakGainDbi / s1528Section / Ln / farOutDbi / satMode / dOverLambda
 *   sidelobeFloorDb                     gaussian 用
 *   beamsPerSat / cellSpacingKm         pointing='cells' 用
 *   coFreqFactor                        0–1，同频复用系数 × 波束时隙占空，线性乘在干扰功率上
 *   grd { sampleDbi(satLon,satLat,altKm,boreLon,boreLat,lon,lat)→dBi|null, peakDbi }
 * @param {object} ctx { stationLonDeg, stationLatDeg }
 *
 * @returns {{active, mode, pointing, coFreqDb, info, warnings, out,
 *            evalAt(ex,ey,ez,ux,uy,uz,serving):number}}
 *   evalAt 返回相对滚降 dB（≤0），并把本次的离轴角写进 out.offAxisDeg（复用同一个对象，
 *   热路径里每时刻每颗星调一次，不能每次分配）。
 *   ⚠️ (ux,uy,uz) 是**站 → 星**的单位矢量（与引擎主循环里那组同名量一致）。
 */
function makeSatPattern(cfg, ctx) {
  const c = cfg || {};
  const mode = c.mode || 'none';
  const pointing = c.pointing || 'nadir';
  const coFreq = num(c.coFreqFactor, 1);
  const warnings = [];

  if (!(coFreq > 0 && coFreq <= 1)) throw new Error(`同频占空系数须在 (0, 1] 内（收到 ${c.coFreqFactor}）`);
  const coFreqDb = 10 * LOG10(coFreq);
  // 与方向图彼此独立的一项，故告警在分派之前发——mode:'none' 也照样要提示
  if (coFreq < 1) {
    warnings.push(`同频占空系数 ${coFreq}（干扰功率 ${coFreqDb.toFixed(2)} dB）已计入；该项对结果的影响常大于方向图本身，报表须原样列出`);
  }

  if (mode === 'none') {
    // 同频占空是与方向图彼此独立的一项（复用系数 × 时隙占空），故 'none' 也照样生效：
    // coFreqFactor 留默认 1 时 coFreqDb = 0，于是 'none' 仍严格等价于 v1.3.6（回归锁）。
    warnings.push('未计入卫星发射方向图与波束指向，每颗可见干扰星均按满 EIRP 计入，结果为上界包络而非实际 C/I');
    return {
      active: false, mode, pointing: null, coFreqDb,
      info: { mode: 'none', shape: '各向同性满 EIRP（上界包络）', coFreqFactor: coFreq, coFreqDb },
      warnings,
      out: { offAxisDeg: 0 },
      evalAt: () => 0
    };
  }

  // ---- 指向几何的常量 ----
  const stLon = Number((ctx || {}).stationLonDeg) || 0;
  const stLat = Number((ctx || {}).stationLatDeg) || 0;
  let cell = null, cosGammaCells = 1, cellEcef = null, cellR = G.A_KM;
  if (pointing === 'cells') {
    const spacing = num(c.cellSpacingKm, 50);
    const beams = Math.max(1, Math.round(num(c.beamsPerSat, 8)));
    if (!(spacing > 0)) throw new Error('小区间距须为正');
    cell = cellCenter(stLon, stLat, spacing);
    cellEcef = G.geodeticToEcef(cell.lonDeg, cell.latDeg, 0);
    cellR = G.norm(cellEcef);
    cosGammaCells = cellCapCosGamma(beams, spacing);
    cell.beamsPerSat = beams;
    cell.spacingKm = spacing;
    cell.capGammaDeg = Math.acos(cosGammaCells) * G.RAD;
  } else if (pointing !== 'nadir' && pointing !== 'worst') {
    throw new Error(`未知的波束指向模型：${pointing}`);
  }

  const out = { offAxisDeg: 0 };

  // ---- 形状 ----
  let shape = null, grd = null;
  if (mode === 'grd') {
    grd = c.grd || null;
    if (!grd || typeof grd.sampleDbi !== 'function' || !Number.isFinite(Number(grd.peakDbi))) {
      throw new Error('卫星方向图选了 GRD 实测图，但没有可用的方向图数据（需要 sampleDbi 与 peakDbi）');
    }
    if (pointing === 'worst') warnings.push('GRD 方向图配合「始终指向本站」将恒取峰值方向，方向图不产生实际作用');

    // ─── 多波束 GRD：口径必须由使用者指定，不能默认 ─────────────────────────
    // 干扰算的是与受扰载波**同频**的那一个波束，不是整副天线。多波束混在一起取最大，
    // 等于假设任一波束都可能同频满功率照到本站——是上界，不是实际值。
    // 实测（两波束、峰值差 3 dB、相隔约 11°）：同一地面点两种口径的相对滚降差 17.5 dB。
    const nBeam = Number(grd.beamCount);
    if (nBeam > 1 && grd.beamPick == null) {
      warnings.push(`卫星方向图含 ${nBeam} 个波束，当前按**全部波束取最大**计算：这假设任一波束都可能与本站同频且满功率发射，结果是上界而非实际值（实测两波束场景两种口径可差十余 dB）。请指定与受扰载波同频的那个波束`);
    }
    // cells 指向会把整簇波束整体重指到小区中心，而多波束 GRD 自身已含波束排布 —— 排布被用了两遍
    if (nBeam > 1 && pointing === 'cells') {
      warnings.push('多波束 GRD 与「地面小区网格」指向叠加使用：方向图自身已含波束排布，小区模型又整体重指一次，等于把排布用了两遍；多波束 GRD 建议配「星下点」指向');
    }
  } else {
    shape = makeShape(c);
    for (const w of shape.warnings) warnings.push(w);
  }

  if (pointing === 'worst') {
    warnings.push('波束指向取「始终指向本站」，属上界口径：每颗干扰星均按正对本站发射计入');
  }

  // ---- 指向：给定卫星位置，算本站相对该星波束中心的离轴角（度）----
  // scratch：波束中心的 ECEF，复用不分配
  const bp = [0, 0, 0];

  function beamPointEcef(ex, ey, ez, serving) {
    if (pointing === 'nadir') { bp[0] = 0; bp[1] = 0; bp[2] = 0; return null; }   // 由 evalAt 特判
    // cells
    const rSat = Math.hypot(ex, ey, ez) || 1;
    const sx = ex / rSat, sy = ey / rSat, sz = ez / rSat;                          // 星下点方向
    if (serving) { bp[0] = cellEcef[0]; bp[1] = cellEcef[1]; bp[2] = cellEcef[2]; return bp; }
    const cx = cellEcef[0] / cellR, cy = cellEcef[1] / cellR, cz = cellEcef[2] / cellR;
    let cosD = sx * cx + sy * cy + sz * cz;
    if (cosD > 1) cosD = 1; else if (cosD < -1) cosD = -1;
    // 波束照不到地平线以下：球冠再被地平半角截一次
    const cosHorizon = Math.min(1, G.A_KM / rSat);
    const cosG = Math.max(cosGammaCells, cosHorizon);                              // cos 越大角越小 ⇒ 取 max = 取更小的角
    if (cosD >= cosG) { bp[0] = cellEcef[0]; bp[1] = cellEcef[1]; bp[2] = cellEcef[2]; return bp; }
    // 本站小区没被照到：最近的激活小区在星下点 → 本站小区这条大圆弧上、距星下点 γ 处
    let tx = cx - sx * cosD, ty = cy - sy * cosD, tz = cz - sz * cosD;
    const tn = Math.hypot(tx, ty, tz);
    if (!(tn > 1e-12)) { bp[0] = cellEcef[0]; bp[1] = cellEcef[1]; bp[2] = cellEcef[2]; return bp; }
    tx /= tn; ty /= tn; tz /= tn;
    const sg = Math.sqrt(Math.max(0, 1 - cosG * cosG));
    bp[0] = (sx * cosG + tx * sg) * cellR;
    bp[1] = (sy * cosG + ty * sg) * cellR;
    bp[2] = (sz * cosG + tz * sg) * cellR;
    return bp;
  }

  /** 本站相对该星波束轴的离轴角（度）。 */
  function offAxisDeg(ex, ey, ez, ux, uy, uz, serving) {
    if (pointing === 'worst') return 0;
    if (pointing === 'nadir') {
      // 波束轴 = 星→地心；本站方向 = 星→站 = −u。
      // cos(离轴) = (−u)·(−ŝ) = u·ŝ
      const rSat = Math.hypot(ex, ey, ez) || 1;
      let cs = (ux * ex + uy * ey + uz * ez) / rSat;
      if (cs > 1) cs = 1; else if (cs < -1) cs = -1;
      return Math.acos(cs) * G.RAD;
    }
    const b = beamPointEcef(ex, ey, ez, serving);
    let bx = b[0] - ex, by = b[1] - ey, bz = b[2] - ez;
    const bn = Math.hypot(bx, by, bz);
    if (!(bn > 0)) return 0;
    bx /= bn; by /= bn; bz /= bn;
    let cs = -(ux * bx + uy * by + uz * bz);          // (−u)·b̂
    if (cs > 1) cs = 1; else if (cs < -1) cs = -1;
    return Math.acos(cs) * G.RAD;
  }

  // ---- GRD 路：增益不是离轴角的函数，得拿真地面点去采 ----
  let evalAt;
  if (mode === 'grd') {
    const peak = Number(grd.peakDbi);
    evalAt = (ex, ey, ez, ux, uy, uz, serving) => {
      out.offAxisDeg = offAxisDeg(ex, ey, ez, ux, uy, uz, serving);
      const rSat = Math.hypot(ex, ey, ez) || 1;
      const satLat = Math.asin(Math.max(-1, Math.min(1, ez / rSat))) * G.RAD;
      const satLon = Math.atan2(ey, ex) * G.RAD;
      const altKm = rSat - G.A_KM;
      let boreLon = satLon, boreLat = satLat;
      if (pointing === 'worst') { boreLon = stLon; boreLat = stLat; }
      else if (pointing === 'cells') {
        const b = beamPointEcef(ex, ey, ez, serving);
        const bn = Math.hypot(b[0], b[1], b[2]) || 1;
        boreLat = Math.asin(Math.max(-1, Math.min(1, b[2] / bn))) * G.RAD;
        boreLon = Math.atan2(b[1], b[0]) * G.RAD;
      }
      const g = grd.sampleDbi(satLon, satLat, altKm, boreLon, boreLat, stLon, stLat);
      if (g == null || !Number.isFinite(g)) return -100;   // 落在方向图之外：视作可忽略的溢出
      const rel = g - peak;
      return rel > 0 ? 0 : rel;                            // 采到比峰值还高说明 peakDbi 给小了，钳住
    };
  } else {
    evalAt = (ex, ey, ez, ux, uy, uz, serving) => {
      const th = offAxisDeg(ex, ey, ez, ux, uy, uz, serving);
      out.offAxisDeg = th;
      return shape.relDb(th);
    };
  }

  const info = {
    ...(shape ? shape.info : {
      mode: 'grd', shape: 'GRD 实测方向图', peakGainDbi: Number(grd.peakDbi),
      // 多波束时这两项决定了结果是「实际值」还是「上界」，必须随结果一起出，报表照列
      beamCount: Number(grd.beamCount) || 1,
      beamPick: grd.beamPick == null ? null : Number(grd.beamPick),
      allBeamsMax: (Number(grd.beamCount) || 1) > 1 && grd.beamPick == null
    }),
    pointing,
    coFreqFactor: coFreq,
    coFreqDb
  };
  if (cell) {
    info.cellSpacingKm = cell.spacingKm;
    info.beamsPerSat = cell.beamsPerSat;
    info.cellCapGammaDeg = cell.capGammaDeg;
    info.stationCell = { lonDeg: cell.lonDeg, latDeg: cell.latDeg };
  }

  return { active: true, mode, pointing, coFreqDb, info, warnings, out, evalAt, offAxisDeg };
}

module.exports = {
  makeSatPattern, makeShape, cellCenter, cellCapCosGamma,
  KM_PER_DEG, GM_FROM_APERTURE_CONST, FAR_OFF_AXIS_DEG
};
