// PFD Mask · 生成引擎（三种 mask）
//
// 把「系统模型」变成「三份可提交的表」。核心是求上确界，不是求某一时刻的值：
// mask 是运营方对 ITU 的承诺——星座在【整个寿命期的任意时刻】都不得超过它。
//
// 三份 mask 的输入依赖是不对称的（这决定了模块的架构）：
//   卫星侧参数（壳层 + 载荷） ──→ pfd_mask（下行）
//                            └─→ eirp_mask_ss（星间）
//   地球站侧参数（终端）      ──→ eirp_mask_es（上行）
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据
//   S.1503-4 §C2.3.1  pfd = 10lg(Σ_Nco 10^(pfd_co/10) + Σ_Ncross 10^(pfd_cross/10))
//                     pfd_co_i = P_i + G_i − 10lg(4πd²)   ← 是【求和】不是取 max
//   S.1503-4 §C2.2    非工作区两种口径：cell-wide / cell-centre
//   S.1503-4 §B4.2    eirp_mask_es 的角 = 地球站主瓣指向 与 站→GSO弧点 的夹角（即 α）
//   S.1503-4 §B4.3    eirp_mask_ss 的角 = 从卫星看，天底方向 与 GSO弧点 的夹角（天底角）
//   S.1503-4 §B5.3    e.i.r.p. mask 必须单调不增
//   S.1503-4 §C1      不发射的角域填极低值（原文 −1000 dBW；XSD 下界 −999）
//
// ★ 三处【无 ITU 依据】的自定口径（S 级，随 mask 一并打印，不得伪装成标准）：
//   [S1] 波束排布规则——§C2.4.1 Step 4 只说数量受星上物理限制约束，不规范排布
//   [S2] 功率控制模型——S.1503 全文检索 "power control" 零命中，是 Transfinite 自家口径
//   [S3] 保守裕量——包络最大性无法自证时的唯一缓解
//
// ★ 一处规范本身的归属差异，极易做反：
//   GSO 弧规避角 α₀ 在 pfd_mask 里【烘焙进 mask】（挖坑），
//   在 eirp_mask_es 里【不进 mask】（另交 SRS 的 MIN_EXCLUDE）。
//   两边都挖会被 §D3.2 的最坏几何搜索重复使用，行为不可预期。
// ─────────────────────────────────────────────────────────────────────────────

const geo = require('./alphaGeometry.js');
const s1528 = require('./s1528.js');
const satPat = require('./satPatterns.js');
const esPat = require('./esPatterns.js');
const units = require('./units.js');

const LOG10 = Math.log10;

/**
 * 哨兵电平分两档 —— 这两者混用是实质错误：
 *   NO_EMISSION  真正「该角域永不发射」。§C1 说填 −1000 dBW，XSD 的下界是 −999，取 −999。
 *                填 −170 会被读方当成真实辐射累加进 EPFD，白白让自己更难通过。
 *   UNRESOLVED   本次几何算不出（射线打不到地球等）。保持一个可辨识的值并计数告警，
 *                填 −999 是在声称「这里永不发射」，那是撒谎。
 */
const SENTINEL_NO_EMISSION_DB = -999;
const SENTINEL_UNRESOLVED_DB = -170;

// ---------------------------------------------------------------------------
// 参数规范化
// ---------------------------------------------------------------------------

function normalize(p) {
  const q = Object.assign({}, p);
  q.nAzElPoints = q.nAzElPoints === undefined ? 60 : Math.round(Number(q.nAzElPoints));
  q.latStepDeg = q.latStepDeg === undefined ? 5 : Number(q.latStepDeg);
  q.conservativeMarginDb = q.conservativeMarginDb === undefined ? 1 : Number(q.conservativeMarginDb);
  q.sentinelNoEmissionDb = q.sentinelNoEmissionDb === undefined ? SENTINEL_NO_EMISSION_DB : Number(q.sentinelNoEmissionDb);
  q.sentinelUnresolvedDb = q.sentinelUnresolvedDb === undefined ? SENTINEL_UNRESOLVED_DB : Number(q.sentinelUnresolvedDb);
  q.beamLayout = q.beamLayout || 'hex-ring';
  q.powerControlKappa = q.powerControlKappa === undefined ? 1 : Number(q.powerControlKappa);
  q.exclusionObservance = q.exclusionObservance || 'cell-centre';
  q.sepAngleStepDeg = q.sepAngleStepDeg === undefined ? 2 : Number(q.sepAngleStepDeg);
  q.refBwKhz = Number(q.refBwKhz);

  if (!(q.satHeightKm > 0)) throw new RangeError(`maskEngine: satHeightKm 必须为正（${p.satHeightKm}）`);
  if (!(q.nAzElPoints >= 2 && q.nAzElPoints <= 1000)) {
    throw new RangeError(`maskEngine: nAzElPoints 须在 [2,1000]（${p.nAzElPoints}）`);
  }
  if (!(q.latStepDeg > 0)) throw new RangeError(`maskEngine: latStepDeg 必须为正（${p.latStepDeg}）`);
  if (!(q.minElevDeg >= 0 && q.minElevDeg < 90)) {
    throw new RangeError(`maskEngine: minElevDeg 须在 [0,90)（${p.minElevDeg}）`);
  }
  if (q.conservativeMarginDb < 0) throw new RangeError('maskEngine: conservativeMarginDb 不得为负（那是在放松包络）');
  if (!(q.sepAngleStepDeg > 0 && q.sepAngleStepDeg <= 30)) {
    throw new RangeError(`maskEngine: sepAngleStepDeg 须在 (0,30]（${p.sepAngleStepDeg}）`);
  }
  if (q.sentinelNoEmissionDb < -999) {
    throw new RangeError(`maskEngine: 不发射哨兵不得低于 XSD 下界 −999（${q.sentinelNoEmissionDb}）`);
  }
  return q;
}

/**
 * 纬度轴：对称覆盖 ±latMax 且含 0。
 * ★ 落到 2 位小数后相同的相邻点必须并成一个 —— @a 是 by_a 的键，重复即非法文档。
 *   赤道星座（latMax=0）因此退化为单张切片，而不是三张 a=0。
 */
function buildLatAxis(latMaxDeg, stepDeg) {
  const n = Math.max(1, Math.round(latMaxDeg / stepDeg));
  const out = [];
  for (let i = -n; i <= n; i++) {
    const v = round2((i * latMaxDeg) / n) || 0;   // −0 归一，否则写成 "-0.00" 与 "0.00" 并存
    if (!out.length || v !== out[out.length - 1]) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 方向图与波束聚合（卫星侧）
// ---------------------------------------------------------------------------

/**
 * 造星上方向图求值器 + 0.01° 步长 LUT（内循环全走查表）。
 *
 * 入参两种形态都收：
 *   {kind:'isoflux'|'omni'|'s1528'|'parabolic'|'two-level', ...}  ← 完整形态
 *   {section:'1.2'|'1.3'|'1.4', ...}                              ← 旧形态，等价于 kind='s1528'
 *
 * ★ 返回值带 steerable / fixedRangeIsAltitude 两个标志，引擎据此走不同算法分支：
 *   steerable=false（isoflux/omni）—— 波束焊死朝天底，每个方向的增益由【天底角】决定，
 *   不能像可动点波束那样一律按峰值算，否则整整抬高一个主瓣-旁瓣落差。
 */
function makeGainLut(patternParams, satHeightKm) {
  const cfg = Object.assign({}, patternParams);
  if (!cfg.kind) cfg.kind = 's1528';
  if (satHeightKm !== undefined && cfg.satHeightKm === undefined) cfg.satHeightKm = satHeightKm;
  const pat = satPat.makeSatPattern(cfg);

  const STEP = 0.01, N = Math.round(180 / STEP) + 1;
  const lut = new Float64Array(N);
  for (let i = 0; i < N; i++) lut[i] = pat.gainDb(i * STEP);

  // 可动点波束的「峰值」= 轴向；固定指向天线的最大增益未必在天底（isoflux 在视场边缘）
  const peakDb = pat.steerable ? lut[0] : pat.peakGainDbi;
  return {
    peakDb,
    nadirDb: lut[0],
    steerable: pat.steerable,
    fixedRangeIsAltitude: !!pat.fixedRangeIsAltitude,
    kind: pat.kind,
    derived: pat.derived || {},
    warnings: pat.warnings || [],
    at(offAxisDeg) {
      const x = Math.abs(offAxisDeg);
      if (!(x >= 0)) return lut[0];
      if (x >= 180) return lut[N - 1];
      const f = x / STEP, i = f | 0, t = f - i;
      return lut[i] * (1 - t) + lut[i + 1] * t;
    },
  };
}

/**
 * Nco 个波束对【波束可正对的方向】的聚合增益（dBi），按 §C2.3.1 在功率域求和。
 * ★ [S1] 排布规则无 ITU 依据，三种口径差别可达 10 dB 量级。
 *
 * 这是 aggregateGainTowardDb 在 d ≤ ρ₀ 时的特例（那时最近合法指向就是 d 本身）。
 * 下行 pfd_mask 只用得到这一档：地面每一格都在视场内，波束总能对准。
 */
function aggregateGainDb(gain, nBeams, minAngleDeg, layout) {
  const peak = gain.at(0);
  if (layout === 'single' || nBeams <= 1) return peak;
  if (layout === 'worst-case-uniform') return peak + 10 * LOG10(nBeams);

  let acc = Math.pow(10, peak / 10);
  let placed = 1, ring = 1;
  while (placed < nBeams && ring < 200) {
    const cap = 6 * ring;
    const take = Math.min(cap, nBeams - placed);
    acc += take * Math.pow(10, gain.at(ring * minAngleDeg) / 10);
    placed += take; ring++;
  }
  return 10 * LOG10(acc);
}

/**
 * Nco 个波束朝【天底角 d】方向的聚合增益（dBi）。eirp_mask_ss 逐角度调用。
 *
 * ★ 必须逐角度算，不能把 d=0 处的聚合抬升当常数平移整条曲线：
 *   远区各波束的离轴角都落进方向图的【常数平台段】，聚合就是「该平台电平 + 10lg(Nco)」
 *   （50 波束即 +17 dB），而常数平移只给了六角环在峰值方向那点抬升（< 1 dB）。
 *   d ∈ [180−ρ₀, 180] 时是严格等式：任一波束的离轴角恒为 180 − 它自己的天底角。
 *   而 LEO 看 GSO 弧的天底角本来就落在 [ρ₀, 180]，正是这一段 —— 平移法在整个受用角域都不是包络。
 *
 * ⚠ 平台段有两个，别混：S.1528 §1.2 的 (4a) G = LF 只管 Y < ψ ≤ 90°，(4b) G = LB 管 90° < ψ ≤ 180°，
 *   而 LB = max(15 + LN + 0.25·Gm + 5·lg z, 0) 可以【高于】LF。星间掩模 d 接近 180° 时离轴角
 *   全在 (4b)，定值的是 LB 不是 LF（Gm=45/LN=−15 时差 11.25 dB）。本函数逐环查方向图，
 *   两段自动区分；需要手算对拍时才要留意取哪一个。
 *
 * 几何：波束只能指向地面（天底角 ≤ ρ₀）。离 d 最近的合法指向 p₀ 天底角 = min(d, ρ₀)，
 * 与 d 相距 a₀ = max(0, d − ρ₀)。第 k 环波束绕 p₀ 张角 β = k·minAngle，其中离 d 最近的
 * 合法位置受 θ ≤ ρ₀ 约束，取 cos φ* = max(−1, −cot ρ₀ · tan(β/2))；该环 6k 个波束一律按
 * 这个最近距离计——保守（实际只有一两个能占到最近位），且 a₀ = 0 时精确退化为 ψ = β，
 * 与 aggregateGainDb 逐位一致，下行掩模的数值不受本函数影响。
 */
function aggregateGainTowardDb(gain, nBeams, minAngleDeg, layout, rho0Deg, dDeg) {
  const N = Math.max(1, Math.round(nBeams));
  // 固定指向天线转不了：Nco 个同频波束共用同一张方向图、同一个指向，聚合就是 +10lg(Nco)
  if (!gain.steerable) return gain.at(dDeg) + 10 * LOG10(N);

  const a0 = Math.max(0, dDeg - rho0Deg);
  const g0 = gain.at(a0);
  if (layout === 'single' || N <= 1) return g0;
  if (layout === 'worst-case-uniform') return g0 + 10 * LOG10(N);

  const D2R = Math.PI / 180;
  const ca0 = Math.cos(a0 * D2R), sa0 = Math.sin(a0 * D2R);
  const cotRho = 1 / Math.tan(Math.max(1e-9, rho0Deg) * D2R);
  const betaMaxDeg = 2 * rho0Deg;          // 环半径不可能超过视场锥的直径

  let acc = Math.pow(10, g0 / 10);
  let placed = 1, ring = 1;
  while (placed < N && ring < 200) {
    const beta = Math.min(ring * minAngleDeg, betaMaxDeg) * D2R;
    const cosPhi = Math.max(-1, -cotRho * Math.tan(beta / 2));
    const psi = Math.acos(Math.max(-1, Math.min(1,
      ca0 * Math.cos(beta) + sa0 * Math.sin(beta) * cosPhi))) / D2R;
    const take = Math.min(6 * ring, N - placed);
    acc += take * Math.pow(10, gain.at(psi) / 10);
    placed += take; ring++;
  }
  return 10 * LOG10(acc);
}

// ---------------------------------------------------------------------------
// ① 下行 pfd_mask
// ---------------------------------------------------------------------------

function buildPfdSlices(p, gain, rho0, latAxis, aggOverPeakDb, hooks) {
  const H = hooks || {};
  const N = p.nAzElPoints;
  const axis = [];
  for (let i = 0; i < N; i++) axis.push(round2(-rho0 + (2 * rho0 * i) / (N - 1)));

  const dMaxKm = slantRangeAtEdge(p.satHeightKm, p.minElevDeg);
  const refBwHz = p.refBwKhz * 1e3;
  const slices = [];
  const stat = { cells: 0, computed: 0, sentinelOutOfView: 0, sentinelLowElev: 0, sentinelAlpha: 0 };
  let minV = Infinity, maxV = -Infinity;
  const total = latAxis.length * N * N;
  let done = 0;

  for (const latSat of latAxis) {
    if (H.shouldCancel && H.shouldCancel()) throw new Error('已取消');
    const satEcef = geo.geodeticToEcefKm(0, latSat, p.satHeightKm);
    const rows = [];
    for (const az of axis) {
      const cells = [];
      for (const el of axis) {
        done++; stat.cells++;
        let v;
        const hit = geo.groundPointFromAzEl(satEcef, az, el);
        if (!hit) {
          v = p.sentinelUnresolvedDb; stat.sentinelOutOfView++;      // 几何算不出，非「承诺不发射」
        } else if (hit.elevDeg < p.minElevDeg) {
          v = p.sentinelNoEmissionDb; stat.sentinelLowElev++;        // 系统不在此仰角工作 ⇒ 真不发射
        } else {
          const a = geo.alphaAndDeltaLong(
            { lonDeg: hit.lonDeg, latDeg: hit.latDeg, altKm: 0 }, satEcef,
            { minElevDeg: 0, coarseStepDeg: 2, tolDeg: 0.01 }
          );
          if (a && Math.abs(a.alphaDeg) < p.maskAlpha0Deg) {
            v = p.sentinelNoEmissionDb; stat.sentinelAlpha++;        // GSO 弧规避 ⇒ 真不发射
          } else {
            // ★ isoflux：§C2.3.1 规定其 pfd 计算中 d ≡ 卫星高度（该类天线的设计目的
            //   就是让地面 PFD 与天底角无关，规范因此把斜距钉死）
            const dM = (gain.fixedRangeIsAltitude ? p.satHeightKm : hit.rangeKm) * 1000;
            let eirp = p.maxEirpDbwPerRefBw;
            if (p.usePowerControl) eirp -= p.powerControlKappa * 20 * LOG10(dMaxKm / hit.rangeKm);
            // ★ 两类天线的分支：
            //   可动点波束 —— 波束可正对此处，用峰值（方向图只通过多波束聚合起作用）
            //   固定指向   —— 波束转不了，本方向的增益由天底角决定
            let toward = eirp + aggOverPeakDb;
            if (!gain.steerable) {
              const offNadir = Math.acos(Math.max(-1, Math.min(1,
                Math.cos(el * Math.PI / 180) * Math.cos(az * Math.PI / 180)))) * 180 / Math.PI;
              toward += gain.at(offNadir) - gain.peakDb;
            }
            // maxEirp 已含 G_peak；只叠加「聚合相对单波束峰值的抬升」，否则双计整个天线增益
            const eirpPerHz = units.perHz(units.spec(toward, refBwHz));
            v = units.perRefBw(units.fromPerHz(units.pfdPerHz(eirpPerHz, 0, dM), refBwHz), refBwHz)
              + p.conservativeMarginDb;                              // [S3] 裕量只加计算格
            stat.computed++;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
          }
        }
        cells.push({ c: round2(el), v: clampValue(v) });
      }
      rows.push({ b: round2(az), cells });
    }
    slices.push({ a: round2(latSat), rows });
    if (H.onProgress) H.onProgress(done, total);
  }
  return {
    slices, axis, stat, dMaxKm,
    minValueDb: Number.isFinite(minV) ? minV : null,
    maxValueDb: Number.isFinite(maxV) ? maxV : null,
  };
}

// ---------------------------------------------------------------------------
// ② 星间 eirp_mask_ss
// ---------------------------------------------------------------------------

/**
 * §B4.3：separation angle 顶点在【卫星】，一边天底方向、一边指向 GSO 弧点 ⇒ 天底角。
 *
 * ⚠ 版本二义（必须知道）：S.1503-**2** 把这个角定义为 boresight 离轴角，
 *   -3/-4 改成天底角。本实现按 -4 建模。若目标 BR 软件按 -2 解释，同一张表含义不同。
 *   specVersion 会写进 XML 注释头，且在 meta.discretion 里显式列出。
 *
 * 取值：波束只能指向地面（天底角 ≤ ρ₀）
 *   d ≤ ρ₀ ⇒ 主瓣可对准 ⇒ 满功率
 *   d > ρ₀ ⇒ 最近合法指向是 ρ₀，离轴 (d − ρ₀) ⇒ 按方向图滚降
 *
 * ★ 聚合逐角度算（aggregateGainTowardDb），不是拿 d=0 的抬升平移整条曲线。
 *   maxEirp 已含单波束峰值增益 G_peak，所以这里减 peak 再加当前方向的聚合增益。
 */
function buildEirpSsSlices(p, gain, rho0, latAxis) {
  const step = p.sepAngleStepDeg;
  const axis = [];
  for (let d = 0; d <= 180 - 1e-9; d += step) axis.push(round2(d));
  axis.push(180);

  const peak = gain.peakDb;
  const agg = axis.map((d) =>
    aggregateGainTowardDb(gain, p.nBeams, p.minAngleDeg, p.beamLayout, rho0, d));
  // 同方向【单波束】能给出的最大增益——聚合抬升的基准，只用于报表
  const one = axis.map((d) => gain.at(gain.steerable ? Math.max(0, d - rho0) : d));
  const raw = agg.map((a) => p.maxEirpDbwPerRefBw - peak + a + p.conservativeMarginDb);
  // §B5.3 单调不增：星上方向图理论上单调，但 §1.4 Taylor 有零点起伏，统一过一次包络
  const mono = esPat.monotoneEnvelope(raw);

  const slices = latAxis.map((lat) => ({
    a: round2(lat),
    cells: axis.map((d, i) => ({ d: round2(d), v: clampValue(mono.values[i]) })),
  }));
  return {
    slices, axisCount: axis.length,
    minValueDb: Math.min.apply(null, mono.values),
    maxValueDb: Math.max.apply(null, mono.values),
    monotoneLift: { count: mono.liftedCount, maxDb: mono.maxLiftDb },
    // 多波束聚合相对同方向单波束的抬升，两端各报一个：
    // 天底（波束彼此错开，抬升微弱）与远区（全部落进同一个常数平台段，抬升吃满 10lg Nco）
    aggLiftNadirDb: agg[0] - one[0],
    aggLiftFarDb: agg[agg.length - 1] - one[one.length - 1],
  };
}

// ---------------------------------------------------------------------------
// ③ 上行 eirp_mask_es
// ---------------------------------------------------------------------------

/**
 * §B4.2 的 T 型（LatitudeAndAngleGSOArc）：
 *   ES_e.i.r.p.[Lat][θ]，θ = 地球站主瓣指向 与 站→GSO弧点 的夹角（即 α 角）。
 *
 * ★ 规避角【不进这份 mask】。S.1503 把它放在 non_gso_operating_parameters 的
 *   MIN_EXCLUDE[lat][orb_id] 里。若在此处再挖一次坑，会与 §D3.2 的最坏几何搜索重复作用。
 *   ⇒ 本函数【不】按 α₀ 截断，θ 从 0 铺到 180 全程给值。
 *
 * ★ 相控阵降维：M.2101 的方向图随扫描角变，是四维的；XSD 只承载 T 型（二维）。
 *   做法是对扫描角族逐点取最大再降维，并报告降维吃掉了多少 dB —— 这个数本身是有价值的输出。
 */
function buildEirpEsSlices(p, latAxis) {
  const t = p.terminal || {};
  const step = p.sepAngleStepDeg;
  const axis = [];
  for (let d = 0; d <= 180 - 1e-9; d += step) axis.push(round2(d));
  axis.push(180);

  const scanAngles = Array.isArray(t.scanAnglesDeg) && t.scanAnglesDeg.length ? t.scanAnglesDeg : [0];
  const patterns = scanAngles.map((sa) => esPat.makeEsPattern(Object.assign({}, t, { scanAngleDeg: sa })));
  const peak = patterns[0].peakGainDbi;

  // 逐扫描角算一族曲线，出口逐点取最大（降维）
  const family = patterns.map((pt) => axis.map((th) => t.maxEirpDbwPerRefBw - peak + pt.gainDb(th)));
  const merged = axis.map((_, i) => {
    let m = -Infinity;
    for (const f of family) if (f[i] > m) m = f[i];
    return m + p.conservativeMarginDb;
  });
  // 降维损失：合并曲线相对单一（首个）扫描角曲线被抬高了多少
  let dimLoss = 0;
  if (family.length > 1) {
    for (let i = 0; i < axis.length; i++) {
      const d = merged[i] - (family[0][i] + p.conservativeMarginDb);
      if (d > dimLoss) dimLoss = d;
    }
  }

  const mono = esPat.monotoneEnvelope(merged);
  const chk = esPat.assertMonotonicDecreasing(mono.values);
  if (!chk.ok) throw new Error(`maskEngine: eirp_mask_es 单调化后仍不单调（index ${chk.index}）`);

  const slices = latAxis.map((lat) => ({
    a: round2(lat),
    cells: axis.map((d, i) => ({ d: round2(d), v: clampValue(mono.values[i]) })),
  }));
  return {
    slices, axisCount: axis.length,
    patternKind: patterns[0].kind, peakGainDbi: peak,
    minValueDb: Math.min.apply(null, mono.values),
    maxValueDb: Math.max.apply(null, mono.values),
    monotoneLift: { count: mono.liftedCount, maxDb: mono.maxLiftDb },
    scanCount: scanAngles.length, dimReductionLossDb: dimLoss,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * 生成一份或多份 mask。
 * @param {object} params 见各 builder；directions 决定出哪几种
 *        directions: {down?:boolean, is?:boolean, up?:boolean}
 * @param {object} [hooks] {onProgress, shouldCancel}
 */
function generateMasks(params, hooks) {
  const p = normalize(params);
  const dirs = p.directions || { down: true, is: !!p.eirpMaskId, up: !!p.eirpEsMaskId };

  const rho0 = geo.nadirHalfAngle(p.satHeightKm, p.minElevDeg);
  const latMax = geo.latMaxFromInclination(p.incDeg);
  const latAxis = buildLatAxis(latMax, p.latStepDeg);

  let gain = null, aggPeakDb = null, aggOverPeakDb = 0;
  if (dirs.down || dirs.is) {
    gain = makeGainLut(p.pattern, p.satHeightKm);
    aggPeakDb = aggregateGainDb(gain, p.nBeams, p.minAngleDeg, p.beamLayout);
    aggOverPeakDb = aggPeakDb - gain.peakDb;
  }

  const doc = {
    ntcId: p.ntcId,
    satName: String(p.satName || '').slice(0, 20),
    pfdMasks: [], eirpMaskEs: [], eirpMaskSs: [],
  };
  const meta = {
    rho0Deg: rho0, latMaxDeg: latMax, latCount: latAxis.length,
    refBwKhz: p.refBwKhz,   // 本次落盘用的参考带宽：调用方据此标注数值口径，不必回看输入
    specVersion: p.specVersion || 'S.1503-4 (出口 XSD v4.0.0.0)',
    discretion: buildDiscretion(p, dirs),
  };

  // mask_id 跨三类唯一，先收集再校验
  const ids = [];
  const useId = (id, who) => {
    const n = Number(id);
    if (ids.some((x) => x.id === n)) {
      throw new RangeError(`maskEngine: mask_id ${n} 撞号（${who} 与 ${ids.find((x) => x.id === n).who}）。`
        + 'XSD 的 xs:unique 让三类 mask 共享 1..999 编号空间。');
    }
    ids.push({ id: n, who });
    return n;
  };

  if (dirs.down) {
    const r = buildPfdSlices(p, gain, rho0, latAxis, aggOverPeakDb, hooks);
    doc.pfdMasks.push({
      maskId: useId(p.pfdMaskId, 'pfd_mask'),
      lowFreqGhz: p.lowFreqGhz, highFreqGhz: p.highFreqGhz, refBwKhz: p.refBwKhz,
      type: 'azimuth_elevation', bName: 'azimuth', cName: 'elevation',
      slices: r.slices,
    });
    meta.gridN = p.nAzElPoints;
    meta.dMaxKm = r.dMaxKm;
    meta.dMinKm = p.satHeightKm;
    meta.powerControlSpanDb = p.usePowerControl ? p.powerControlKappa * 20 * LOG10(r.dMaxKm / p.satHeightKm) : 0;
    meta.stat = r.stat;
    meta.minValueDb = r.minValueDb;
    meta.maxValueDb = r.maxValueDb;
    meta.peakGainDb = gain.peakDb;
    meta.aggregateGainDb = aggPeakDb;
    meta.aggregateGainOverPeakDb = aggOverPeakDb;
    meta.patternWarnings = gain.warnings;
    meta.preview = buildPreview(gain, r.slices, latAxis);
  }

  if (dirs.is) {
    units.checkEirpSsRefBw(p.refBwKhz * 1e3, 'throw');   // XSD 无 refbw_khz ⇒ 只能 40 kHz
    const r = buildEirpSsSlices(p, gain, rho0, latAxis);
    doc.eirpMaskSs.push({
      maskId: useId(p.eirpMaskId, 'eirp_mask_ss'),
      lowFreqGhz: p.lowFreqGhz, highFreqGhz: p.highFreqGhz,
      slices: r.slices,
    });
    meta.eirpSs = {
      axisCount: r.axisCount, minValueDb: r.minValueDb, maxValueDb: r.maxValueDb,
      sepAngleStepDeg: p.sepAngleStepDeg, monotoneLift: r.monotoneLift,
      nBeams: p.nBeams, peakGainDb: gain.peakDb,
      aggLiftNadirDb: r.aggLiftNadirDb, aggLiftFarDb: r.aggLiftFarDb,
    };
  }

  if (dirs.up) {
    const r = buildEirpEsSlices(p, latAxis);
    doc.eirpMaskEs.push({
      maskId: useId(p.eirpEsMaskId, 'eirp_mask_es'),
      lowFreqGhz: p.lowFreqGhz, highFreqGhz: p.highFreqGhz,
      refBwKhz: p.refBwKhz,
      minElevDeg: p.minElevDeg,
      esId: p.esId === undefined || p.esId === null ? -1 : Number(p.esId),
      slices: r.slices,
    });
    meta.eirpEs = {
      axisCount: r.axisCount, minValueDb: r.minValueDb, maxValueDb: r.maxValueDb,
      patternKind: r.patternKind, peakGainDbi: r.peakGainDbi,
      sepAngleStepDeg: p.sepAngleStepDeg, monotoneLift: r.monotoneLift,
      scanCount: r.scanCount, dimReductionLossDb: r.dimReductionLossDb,
      esId: doc.eirpMaskEs[0].esId,
    };
  }

  return { doc, meta };
}

/** 向后兼容的旧入口。 */
function generatePfdMask(params, hooks) {
  return generateMasks(Object.assign({}, params, {
    directions: { down: true, is: !!params.eirpMaskId, up: false },
  }), hooks);
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** ε=ε₀ 处的斜距（km）。球模型，与 nadirHalfAngle 同口径。 */
function slantRangeAtEdge(hKm, minElevDeg) {
  const Re = geo.A_KM, D2R = Math.PI / 180;
  const rho0 = geo.nadirHalfAngle(hKm, minElevDeg) * D2R;
  const gamma = Math.PI / 2 - minElevDeg * D2R - rho0;
  return Math.sqrt(Re * Re + (Re + hKm) * (Re + hKm) - 2 * Re * (Re + hKm) * Math.cos(gamma));
}

const round2 = (x) => Math.round(x * 100) / 100;
/** 钳到 XSD 的值域并定到 3 位小数。 */
const clampValue = (v) => Math.max(-999, Math.min(999, Math.round(v * 1000) / 1000));

/** 侧栏小图数据：方向图 + 最靠近赤道那张表的 az≈0 剖面。 */
function buildPreview(gain, slices, latAxis) {
  const pattern = [];
  for (let x = 0; x <= 180; x += 0.5) pattern.push([x, Math.round(gain.at(x) * 1000) / 1000]);
  let k = 0, best = Infinity;
  latAxis.forEach((v, i) => { if (Math.abs(v) < best) { best = Math.abs(v); k = i; } });
  const s = slices[k];
  let r = s.rows[0], rb = Infinity;
  for (const row of s.rows) { if (Math.abs(row.b) < rb) { rb = Math.abs(row.b); r = row; } }
  return { pattern, profile: r.cells.map((c) => [c.c, c.v]), profileLat: s.a, profileAz: r.b };
}

/** 自定口径清单——随 mask 一并交付，不得省略（§E3 要求提交软件说明）。 */
function buildDiscretion(p, dirs) {
  const d = [];
  if (dirs.down || dirs.is) {
    d.push({
      field: 'beamLayout', value: p.beamLayout, evidence: 'S',
      why: 'S.1503 §C2.4.1 Step 4 只约束波束数量，不规范排布规则；PMGT 的规则未公开。',
      impact: p.beamLayout === 'single'
        ? '★ single 只算主波束，会低估聚合 ⇒ 产出的 mask 可能不安全，仅供对照'
        : (p.beamLayout === 'worst-case-uniform' ? '最保守的合法上界（+10lg Nco）' : '六角环排布，物理合理但非标准'),
    });
    if (p.usePowerControl) {
      d.push({
        field: 'usePowerControl / κ', value: `on, κ=${p.powerControlKappa}`, evidence: 'S',
        why: 'S.1503 全文检索 "power control" 零命中；该机制来自 Transfinite 口径。',
        impact: '按保持地面 PFD 平坦的全补偿实现；κ 缩放补偿量。',
      });
    }
  }
  if (dirs.is) {
    d.push({
      field: 'eirp_ss separationAngle', value: '天底角（按 S.1503-4）', evidence: 'T',
      why: '★ 版本二义：S.1503-2 定义为 boresight 离轴角，-3/-4 改为天底角；'
        + '而出口 XSD v4.0.0.0 自述对应 -2，BR 现役验证软件亦为 -2。',
      impact: '同一张数字表在两版下含义不同。若对拍发现不符，改 buildEirpSsSlices 的角定义一处即可。',
    });
    d.push({
      field: 'eirp_ss 多波束聚合', value: `逐角度求和（${p.beamLayout}）`, evidence: 'S',
      why: '与 [S1] 同源：§C2.3.1 只规定功率域求和，不规范排布，逐角度的最坏排布须自定。',
      impact: '每环按「离目标方向最近的合法位置」整环计，保守；远区各波束同落方向图的常数平台段'
        + '（§1.2 在 ψ>90° 是背瓣 LB，非远旁瓣 LF），聚合趋近该电平 +10lg(Nco)。'
        + '两端抬升见 meta.eirpSs.aggLift{Nadir,Far}Db。',
    });
  }
  if (dirs.up) {
    d.push({
      field: 'eirp_es 规避角归属', value: '不进 mask（另交 MIN_EXCLUDE）', evidence: 'R',
      why: 'S.1503 把上行规避角放在 non_gso_operating_parameters，不在 mask 里挖坑。',
      impact: '本 mask 的 θ 从 0 铺到 180 全程给值；规避由运行参数文件承载。两边都挖会重复作用。',
    });
    d.push({
      field: 'eirp_es 出口维度', value: 'T 型（降维自扫描族）', evidence: 'T',
      why: 'XSD 只承载二维 T 型；相控阵终端本身是四维的（lat, az, el, ΔLongES）。',
      impact: '按扫描角族逐点取最大降维，降维损失见 meta.eirpEs.dimReductionLossDb。',
    });
  }
  d.push({
    field: 'sentinel', value: `不发射 ${p.sentinelNoEmissionDb} / 算不出 ${p.sentinelUnresolvedDb}`, evidence: 'R',
    why: '§C1 规定不发射区填极低值（原文 −1000 dBW，XSD 下界 −999）。',
    impact: '两档必须分开：把「算不出」也填 −999 是在声称永不发射；把「不发射」填 −170 会被读方当真实辐射累加。',
  });
  d.push({
    field: 'conservativeMarginDb', value: p.conservativeMarginDb, evidence: 'S',
    why: '包络最大性无法自证（无法穷举所有波束组合），裕量是唯一不依赖该证明的缓解。',
    impact: '只加计算格，不加哨兵格。',
  });
  d.push({
    field: 'subSatelliteLatitude', value: 'geodetic', evidence: 'S',
    why: 'S.1503 未明说星下点纬度取大地纬度还是地心纬度；而 §D6.4.5 把天底定义为指向地心。',
    impact: '本实现按大地纬度铺纬度轴、按指向地心定天底。改用地心纬度会使各表整体错位不到 0.2°。',
  });
  d.push({
    field: 'azElConvention', value: geo.AZEL_CONVENTION, evidence: 'T',
    why: '§D6.4.5 的 Figure 60 在可得文本中缺失，az/el 各自量起轴由 Viewer 轴范围反推。',
    impact: '若与 ITU Mask Viewer 对拍不符，mask 会整体旋转——首要对拍项。',
  });
  return d;
}

module.exports = {
  SENTINEL_NO_EMISSION_DB, SENTINEL_UNRESOLVED_DB,
  normalize, buildLatAxis, makeGainLut, aggregateGainDb, aggregateGainTowardDb,
  buildPfdSlices, buildEirpSsSlices, buildEirpEsSlices,
  generateMasks, generatePfdMask, slantRangeAtEdge, buildPreview,
};
