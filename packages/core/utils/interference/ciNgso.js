// 干扰分析 · NGSO 时变 C/I → CDF
//
// NGSO 的干扰和 GEO 是两个物理问题。GEO 两颗星都不动，C/ASI 是一个数；NGSO 的干扰星在天上
// 跑，离轴角每秒都在变，C/I 是一条随机过程。报一个「最差值」既吓人又没用（in-line 穿越
// 那一瞬可以差到没法看，但它一年只占几分钟），所以口径必须是**时间百分比**：
//
//     报 C/I(p%) = 有 p% 的时间，C/I 比这个值更差
//
// 与雨衰的 p% 不是一回事：那是传播统计（雨下多大），这是几何统计（星走到哪）。两者物理
// 独立，不能相加。本模块只出干扰这一支的 CDF，合成留给使用者判断，UI 上须分开标注。
//
// ─── 用哪条包络：S.1428，不是 AP8 ───────────────────────────────────────────
// AP8/S.580 是**峰值**包络，为「单个不动的干扰源」设计；S.1428 是为「干扰源在动且不止一个」
// 制定的平均包络（见其 considering c)、e)），且明确覆盖 0°–180° 全角域以供计算机仿真。
//
// ⚠️ 两者的差别不是「S.1428 一律更低」——实测（D=1.2 m @ 12.5 GHz，D/λ=50）交叉点在约 37°：
//        角度      AP8(峰值)   S.1428(平均)     差
//        2–35°      更高        低 1.5 dB      近区：峰值包络确实偏保守
//        40–60°     −11.50      −9.00        +2.5 dB
//        80–120°    −11.50      −4.00        +7.5 dB  ← 溢出区，S.1428 显著更高
// 近区 S.1428 低（平均 vs 峰值，符合直觉），**远区反而高**——AP8 的远场底板（−3−5lg(D/λ)）
// 是设计目标值，而 S.1428 的溢出平台是实测统计出来的，真实天线在大角度上漏得比设计目标多。
//
// 后果：大星座的干扰星散布全天，多数落在 40° 以外的远区，于是**S.1428 给出的聚合 C/I 反而
// 比 AP8 更低（更保守）**。本模块实测：16 星本座 + 36 星干扰座，中位 C/I 47.85（S.1428）
// vs 51.86（AP8），差 4 dB。别想当然以为换成平均包络结果一定更宽松。
// patternKind 两条都留着，就是为了让使用者能亲眼比一次。
//
// ─── in-line 事件 ───────────────────────────────────────────────────────────
// 干扰星穿过接收天线主瓣的那几秒，是整条 CDF 的尾巴所在。单独识别出来列成事件表：
// 用户要知道的不只是「有 0.1% 的时间很差」，而是「每天发生几次、每次多久」——那决定了
// 是靠 ACM 扛过去还是必须切星。
//
// ─── 性能 ───────────────────────────────────────────────────────────────────
// 大星座逐时刻逐星是算不动的（Starlink 量级 × 86400 秒）。三级把量级压下来：
//   ① 轨道粗筛：轨道根本到不了本站纬度的星，一次都不传播（orbitCanReach，复用可见性分析的思路）
//   ② 仰角门限：每个时刻只对地平线以上的星算角度
//   ③ 分帧：createRun/stepBatch/finalize 三段式，可给进度、可取消（口径同 coverageGrid.createCoverageRun）
// 调用方务必先用 estimateWork 拦一道，别让用户点下去就卡死。

const satlib = require('../../vendor/satellite.js');
const G = require('./geometry.js');
const P = require('./patterns.js');
const PS = require('./patternsSat.js');

const LOG10 = Math.log10;
const lin = (db) => Math.pow(10, db / 10);
const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

// ---------------------------------------------------------------------------
// 粗筛：这颗星的轨道有没有可能被这个站看见
// ---------------------------------------------------------------------------

/**
 * 不传播、只看轨道倾角与高度：星下点纬度绝对值上限 = 倾角（顺行）或 180−倾角（逆行），
 * 再加上以最小仰角能看到的地心半角，就是这条轨道能服务的最高纬度。
 * 站纬超出即永不可见 → 整颗星在本次扫描里一次都不用传播。
 */
function orbitCanReach(satrec, stationLatDeg, minElevDeg) {
  if (!satrec) return false;
  const RE = 6378.137;
  const incl = Math.abs((satrec.inclo || 0) * G.RAD);
  const maxSubLat = incl > 90 ? 180 - incl : incl;
  // 由平均运动反推半长轴：n(rad/min) → a
  const n = Number(satrec.no) || Number(satrec.no_kozai);
  if (!(n > 0)) return true;                      // 拿不到轨道 → 不敢剔，照算
  const nRadS = n / 60;
  const a = Math.pow(398600.4418 / (nRadS * nRadS), 1 / 3);
  const rMax = a * (1 + (Number(satrec.ecco) || 0));
  if (!(rMax > RE)) return true;
  // 最小仰角 ε 下，站与星下点的地心夹角上限
  const eps = Math.max(0, Number(minElevDeg) || 0) * G.DEG;
  const cosEps = Math.cos(eps);
  const arg = Math.max(-1, Math.min(1, (RE / rMax) * cosEps));
  const centralHalfAngle = (Math.PI / 2 - eps - Math.asin(arg)) * G.RAD;
  return Math.abs(Number(stationLatDeg) || 0) <= maxSubLat + centralHalfAngle + 1e-9;
}

/**
 * 卫星身份指纹（自系统排除用）。
 *
 * 同一颗星在「本星座」与「勾了同星座的干扰座」里是解析层各解一遍的**两个对象**，
 * 引用不等；但两次都由同一份根数建 satrec，六根数与历元是 bit 级相同的，可作身份键。
 * id 单独取并集是因为 walker 源的 id 里带着组名（两组组名不同 → id 不同），
 * 而编目源（OMM/卫星组）的 id 才是 NORAD 号。两者取并集，各种来源都对得上。
 */
function satIdentity(s) {
  const r = (s && s.rec) || {};
  const n = r.no_kozai != null ? r.no_kozai : r.no;
  return `${r.inclo}|${r.nodeo}|${r.ecco}|${r.argpo}|${r.mo}|${n}|${r.jdsatepoch}|${r.jdsatepochF || 0}`;
}

/** 计算量估算：可见候选星数 × 时间样本数。调用方据此拦截。 */
function estimateWork(candidateSatCount, horizonSec, stepSec) {
  const T = Math.floor(Math.max(1, horizonSec) / Math.max(1, stepSec)) + 1;
  return Math.max(0, candidateSatCount) * T;
}

// ---------------------------------------------------------------------------
// 采样步长与 in-line 混叠
// ---------------------------------------------------------------------------
//
// 这是本模块最容易出「假结果」的地方，且假得毫无征兆：步长比穿越时长还长时，
// in-line 事件一次都采不到，程序会安安静静地报「0 次」——看上去像个好消息。
//
// 实测：1200 km LEO 过顶时的视角速度约 0.33°/s；4.5 m Ku 天线主瓣 0.373°，
// 穿越只需 ~1.1 s。用 5 s 步长扫 24 h，报出来的是 in-line 0 次、最差 C/I 19.8 dB；
// 换 1.2 m 天线（主瓣 1.399°、穿越 ~4 s）同样 5 s 步长则能采到，报每天 5 次、最差 2.5 dB。
// 前者不是「大天线更抗干扰」，是根本没采着。

// ─── in-line 事件的判据：规避角，不是波束宽度 ──────────────────────────────────
// 首版两处不自洽：判定用 θ < bw3（把 3 dB **全宽**当成了半径，多算 4 倍立体角），
// 而穿越时长又用 crossingSec = bw3 / rate（把它当直径）。同一个 bw3 一处当半径一处当直径。
// 现统一到**规避角** inlineGuardDeg：工程上 in-line 事件本就该由显式规避角定义
// （如 ±10°），而不是由波束宽度定义——规避角是系统设计参数，波束宽度只是天线参数。
//   判定：θ < guard          穿越时长：2 × guard / rate
// 默认 guard = bw3 / 2（半功率半角），此时 crossingSec 与首版逐位一致，变的只有判定阈值。

/**
 * 卫星过顶时的最大视角速度（度/秒），取天顶最坏。
 *
 * ─── 依据：ITU-R S.1325-3 §2.7.2 ────────────────────────────────────────────
 * 地固系里的卫星角速度不是「ω − ω_地」这个标量差，那只在赤道顺行时才对；
 * 建议书给的是两个角速度**矢量**之差的模：
 *     ω_a = √[ (ω·cos I − ω_e)² + (ω·sin I)² ]
 * 倾角越大差得越多：53° 倾角、1200 km 时比标量差高约 3%（步长要求随之更严一点）。
 * ω_e = 7.29×10⁻⁵ rad/s（建议书原文取值）。
 *
 * 天顶时视角速度被站址放大 r/(r−Re)（站比地心更近），取这一最坏值。
 * 建议书同节还规定主瓣内的采样点数 Nhits ≥ 5 —— 本模块的 requiredStepSec 正是按 5 取的。
 */
const OMEGA_E_RAD_S = 7.29e-5;                             // S.1325-3 §2.7.2 原文取值

function maxAngularRateDegPerSec(satrec) {
  const n = Number(satrec && (satrec.no != null ? satrec.no : satrec.no_kozai));
  if (!(n > 0)) return null;
  const nRadS = n / 60;                                    // rad/min → rad/s
  const a = Math.pow(398600.4418 / (nRadS * nRadS), 1 / 3);
  const RE = 6378.137;
  const incl = Math.abs(Number(satrec.inclo) || 0);        // rad
  const wx = nRadS * Math.cos(incl) - OMEGA_E_RAD_S;
  const wy = nRadS * Math.sin(incl);
  const rel = Math.max(1e-9, Math.hypot(wx, wy));
  const h = a - RE;
  if (!(h > 0)) return null;
  return (rel * a / h) * G.RAD;
}

/**
 * 星座的**回归周期**（秒）—— ITU-R S.1325-3 §2.7.3 的四步法，逐段照抄：
 *
 *   Step 1  一个轨道周期 T 内星下点沿经度的漂移：Δφ₀ = 2π·T/Te（Te = 地球自转周期）
 *   Step 2  j 圈之后的漂移：Δφⱼ = j·Δφ₀
 *   Step 3  取满足 mod(Δφⱼ, 2π) ≤ ΔPT 的最小整数 j（ΔPT = 要求的回归精度，rad）
 *   Step 4  回归周期 T_NOB = jmin · T
 *
 * 原文按「忽略升交点经度漂移」写（即不含 J2 进动），本实现照办。
 *
 * ⚠️ 一处刻意不改的地方：Step 3 的判据原文写作 mod(Δφ, 2π) ≤ ΔPT，
 *    而 mod 落在 2π−ΔPT 一侧（星下点从另一边差同样多）在物理上是同一件事。
 *    照原文实现会给出**更长**的回归周期——对「该跑多久」这个用途来说偏保守，
 *    与建议书一致，故不擅自改成对称判据。要对称的口径请显式传 symmetric:true。
 *
 * @param {object[]} satrecs
 * @param {object} [opt] { accuracyDeg=1, maxOrbits=20000, symmetric=false }
 * @returns {{sec:number, orbits:number, periodSec:number, accuracyDeg:number, exhausted:boolean}|null}
 */
function constellationRepeatPeriodSec(satrecs, opt) {
  const o = opt || {};
  const accDeg = Number(o.accuracyDeg) > 0 ? Number(o.accuracyDeg) : 1;
  const accRad = accDeg * G.DEG;
  const maxOrbits = Math.max(1, Math.round(Number(o.maxOrbits) || 20000));
  const TE = 86164.0905;                                   // 地球自转周期（恒星日，s）
  let best = null;
  for (const rec of (satrecs || [])) {
    const n = Number(rec && (rec.no != null ? rec.no : rec.no_kozai));
    if (!(n > 0)) continue;
    const periodSec = (2 * Math.PI) / (n / 60);
    const d0 = 2 * Math.PI * periodSec / TE;               // Step 1
    let jmin = 0;
    for (let j = 1; j <= maxOrbits; j++) {                 // Step 2 + 3
      let m = (j * d0) % (2 * Math.PI);
      if (m < 0) m += 2 * Math.PI;
      if (m <= accRad || (o.symmetric && (2 * Math.PI - m) <= accRad)) { jmin = j; break; }
    }
    const exhausted = jmin === 0;
    const orbits = exhausted ? maxOrbits : jmin;
    const sec = orbits * periodSec;                        // Step 4
    // 多壳层星座取最长的那个：整座回归要等最慢的一层
    if (!best || sec > best.sec) best = { sec, orbits, periodSec, accuracyDeg: accDeg, exhausted };
  }
  return best;
}

/**
 * 为「每次 in-line 穿越至少采到 minSamples 个点」所需的步长（秒）。
 *
 * @param {number} guardDeg in-line 规避**半角**（θ < guard 即算穿越）。穿越弦长是 2×guard。
 * @returns {{stepSec:number, rateDegPerSec:number, crossingSec:number}|null}
 */
function requiredStepSec(satrecs, guardDeg, minSamples) {
  const guard = Number(guardDeg);
  if (!(guard > 0)) return null;
  let rate = 0;
  for (const r of (satrecs || [])) {
    const v = maxAngularRateDegPerSec(r);
    if (v != null && v > rate) rate = v;
  }
  if (!(rate > 0)) return null;
  const crossingSec = 2 * guard / rate;             // 判定阈值与时长同源，不再各算各的
  return { stepSec: crossingSec / Math.max(1, Number(minSamples) || 3), rateDegPerSec: rate, crossingSec };
}

// ---------------------------------------------------------------------------
// 逐时刻求解
// ---------------------------------------------------------------------------

let _propCount = 0;
function ecefAt(rec, date, gmst) {
  _propCount++;
  const pv = satlib.propagate(rec, date);
  if (!pv || !pv.position || (rec.error && rec.error !== 0)) return null;
  const e = satlib.eciToEcf(pv.position, gmst);
  return [e.x, e.y, e.z];
}

/**
 * 建一次扫描。
 *
 * @param {object} o
 *   station    {lon, lat, alt}                     本站（alt 单位 m）
 *   rx         {diameterM, efficiency, freqGHz}    收信站天线
 *   wanted     {sats:[{rec,name,id}], eirpDbW?, bandwidthHz?, eirpDensityDbWPerHz?, polarization}
 *              本星座；服务星按每时刻最高仰角选
 *   interferers[{sats:[{rec,name,id}], eirpDensityDbWPerHz, polarization?, xpdDb?, name, id}]
 *              一组 = 一个干扰星座（同座内各星共用 EIRP 密度与极化）
 *   minElevDeg 仰角门限（本站可用的最低仰角）
 *   startMs    起始时刻（ms）——本模块不调用 Date.now()，时刻一律由调用方给，便于复现
 *   horizonSec 时窗（秒）
 *   stepSec    采样步长（秒）
 *   patternKind 'average'（默认，S.1428）| 'peak'（AP8，要对比保守口径时用）
 */
function createNgsoCiRun(o) {
  const opt = o || {};
  const st = opt.station || {};
  const rx = opt.rx || {};
  const warnings = [];

  const fGHz = num(rx.freqGHz, 0);
  const D = num(rx.diameterM, 0);
  const eff = num(rx.efficiency, 0.65);
  const lam = fGHz > 0 ? 299792458 / (fGHz * 1e9) : null;
  if (!(lam > 0) || !(D > 0)) throw new Error('缺收信站天线口径或下行频率');

  const kind = opt.patternKind === 'peak' ? 'peak' : 'average';
  const gPeak = P.peakGainDbi(D, lam, eff);
  const bw3 = P.beamwidth3dB(D, lam);
  const minElev = num(opt.minElevDeg, 5);

  // 地球站离轴包络：包络选择与鉴别度偏置只与 (kind, D, λ, η, f) 有关，提到扫描循环外。
  // 这里同时拿到「有没有退回 AP8」，退回是有出处的保守选择，但必须让使用者知道。
  const esPat = P.makeEarthStationOffAxis(kind, D, lam, eff, fGHz);
  const esGain = esPat.gain;
  if (esPat.info.fellBack) {
    warnings.push(`收信站离轴包络已由 S.1428 退回 AP8/S.580：${esPat.info.reason}。AP8 为峰值包络，用于动态多干扰源场景偏保守`);
  }

  // 期望载波谱密度
  let wantedDen = num((opt.wanted || {}).eirpDensityDbWPerHz, null);
  if (wantedDen == null) {
    const e = num((opt.wanted || {}).eirpDbW, null), b = num((opt.wanted || {}).bandwidthHz, null);
    if (e != null && b > 0) wantedDen = e - 10 * LOG10(b);
  }
  if (wantedDen == null) throw new Error('缺期望载波 EIRP 密度');

  // ① 轨道粗筛
  const wantedSats = ((opt.wanted || {}).sats || []).filter((s) => s && s.rec);
  const wantedUse = wantedSats.filter((s) => orbitCanReach(s.rec, st.lat, minElev));
  if (!wantedUse.length) throw new Error('本星座里没有轨道能覆盖该站纬度的星');
  if (wantedUse.length < wantedSats.length) {
    warnings.push(`本星座 ${wantedSats.length} 颗中 ${wantedSats.length - wantedUse.length} 颗的轨道无法覆盖本站纬度，已剔除`);
  }

  // 自系统排除用的身份表：指纹 / id → wantedUse 下标（见 satIdentity 头注）
  const wantedIdent = new Map();
  wantedUse.forEach((s, i) => {
    wantedIdent.set(satIdentity(s), i);
    if (s.id != null && s.id !== '') wantedIdent.set('id:' + String(s.id), i);
  });

  const groups = [];
  for (const g of (opt.interferers || [])) {
    if (!g) continue;
    const den = num(g.eirpDensityDbWPerHz, null);
    if (den == null) { warnings.push(`干扰星座「${g.name || g.id || '?'}」缺 EIRP 密度，已跳过`); continue; }
    const all = (g.sats || []).filter((s) => s && s.rec);
    // ★ 干扰侧的粗筛门限是 0°（地平线），不是本站的工作仰角 minElev——干扰从旁瓣打进来，
    //   与本站愿不愿意在这个仰角上工作无关。主循环判据（地平线以上就计）与 buildScreen(g.sats, 0)
    //   一直是 0°，这里曾误传 minElev：站纬落在 [i+γ(minElev), i+γ(0)] 带内时（如 30° 倾角
    //   1200 km 干扰座对 58~63°N 的站）整座星座会被静默剔掉、报成「无干扰」。
    const use = all.filter((s) => orbitCanReach(s.rec, st.lat, 0));
    if (!use.length) { warnings.push(`干扰星座「${g.name || g.id}」的轨道无法覆盖本站纬度，已跳过`); continue; }
    if (use.length < all.length) warnings.push(`干扰星座「${g.name || g.id}」${all.length} 颗中 ${all.length - use.length} 颗被轨道粗筛剔除`);
    // 自系统：逐颗对出「它就是本星座的第几颗」，服务星那一颗在主循环里跳过。
    // 原判据是 acos 后的离轴角 < 1e-6°，而 acos 在 1 附近病态：自点乘因归一化舍入落到
    // 1−2ulp 时 acos 得 1.2e-6° > 1e-6°，约 14% 的时刻漏判、服务星以满增益进干扰和、
    // C/I 当场坍到 ≈0 dB。改按身份排除，与浮点无关。
    let selfIdx = null;
    if (g.selfSystem) {
      selfIdx = new Int32Array(use.length).fill(-1);
      let matched = 0;
      for (let i = 0; i < use.length; i++) {
        const byElem = wantedIdent.get(satIdentity(use[i]));
        const byId = use[i].id != null && use[i].id !== '' ? wantedIdent.get('id:' + String(use[i].id)) : undefined;
        const k = byElem !== undefined ? byElem : (byId !== undefined ? byId : -1);
        selfIdx[i] = k;
        if (k >= 0) matched++;
      }
      if (!matched) warnings.push(`干扰星座「${g.name || g.id}」勾了「同星座」，但没有一颗星与本星座对得上，服务星不会被排除`);
    }
    // 极化折减（同座内一致）
    const ciAsi = require('./ciAsi.js');
    const pol = opt.applyPolarization === false
      ? { db: 0, relation: 'off' }
      : ciAsi.polarizationDiscrimination((opt.wanted || {}).polarization, g.polarization, g.xpdDb);
    groups.push({
      id: g.id, name: g.name || g.id, den, pol, sats: use, selfSystem: !!g.selfSystem, selfIdx,
      // 抽样倍率由解析层（electron/services/interference.js 的 applyLimit）带下来：
      // 抽了样就意味着少算了 (K−1)/K 的干扰源，结果偏乐观 ≈ 10lg K dB。
      // 这件事必须一路跟到每一个分位数上（见 summarize 的 sampled 标），不许只在告警里说一句。
      samplingFactor: num(g.samplingFactor, 1),
      satPatternCfg: g.satPattern || null            // 逐座可覆盖全局的卫星方向图设置
    });
  }
  if (!groups.length) warnings.push('无可用干扰星座，结果为纯热噪声场景');

  const samplingFactorMax = groups.reduce((a, g) => Math.max(a, g.samplingFactor || 1), 1);

  // ---- 卫星侧发射方向图与波束指向（A1）----
  //
  // 缺省 mode:'none' = v1.3.6 行为（各向同性满 EIRP），是刻意的：旧的持久化面板态原样读回，
  // 只是会多一条「结果为上界」的告警。逐座可覆盖全局设置——真实场景里本星座与各干扰座
  // 的星上天线本就不是一副。
  //
  // ★ C 侧同步过一遍方向图：服务星的 EIRP 密度也按「本站相对其波束中心的离轴角」修正，
  //   否则 C 用满功率、I 用滚降后的值，等于给 C/I 白送几个 dB。
  //   服务星按定义把一个波束给了本站所在小区（不然它就不是服务星），故 cells 模式下
  //   服务星不做「本站小区有没有被照到」的判定，干扰星才做。
  const patCtx = { stationLonDeg: Number(st.lon) || 0, stationLatDeg: Number(st.lat) || 0 };
  const mkPat = (cfg, who) => {
    try {
      const p = PS.makeSatPattern(cfg, patCtx);
      for (const w of p.warnings) warnings.push(`${who}：${w}`);
      return p;
    } catch (e) {
      throw new Error(`${who}的卫星方向图配置有问题：${(e && e.message) || e}`);
    }
  };
  const satPatDefault = opt.satPattern || null;
  const satPatW = mkPat((opt.wanted || {}).satPattern || satPatDefault, '本星座');
  for (const g of groups) {
    g.satPat = mkPat(g.satPatternCfg || satPatDefault, `干扰星座「${g.name}」`);
    g.coFreqLin = Math.pow(10, g.satPat.coFreqDb / 10);
  }
  const anySatPattern = satPatW.active || groups.some((g) => g.satPat.active);

  const stepSec = Math.max(0.1, num(opt.stepSec, 10));
  const horizonSec = Math.max(stepSec, num(opt.horizonSec, 86400));
  const T = Math.floor(horizonSec / stepSec) + 1;
  const startMs = num(opt.startMs, 0);

  // ---- 分位数的样本门禁（算之前先说）----
  // 报 C/I(0.001%) 需要至少 1/0.001% = 100 000 个样本才谈得上「有 1 个样本落在该分位」。
  // 6 h / 10 s = 2161 个样本时，这一档拿到的其实就是最小值，只是贴了个百分比标签。
  // 事后在 summarize 里返回 null 是兜底；此处在**点计算之前**就把所需时窗算给用户。
  // ⚠️ 多历元下这条由外层按**合并后**的样本数发（见 createNgsoCiMultiRun）：
  //    单个历元撑不起 0.1%，8 个历元合起来可能就撑得起了，逐历元各喊一遍是误导。
  if (!opt._multiEpoch) {
    const short = DEFAULT_PCTS.filter((p) => (p / 100) * T < 1);
    if (short.length) {
      const need = Math.ceil(100 / Math.min(...short));
      warnings.push(`时窗 ${(horizonSec / 3600).toFixed(1)} h、步长 ${stepSec} s 共 ${T} 个样本，不足以支撑 ${short.map((p) => p + '%').join(' / ')} 分位（最细一档需 ≥ ${need.toLocaleString()} 个样本，约 ${(need * stepSec / 3600).toFixed(1)} h），该几档将标记为样本不足`);
    }
  }

  // 结果累积
  const ci = new Float32Array(T).fill(NaN);       // 每样本的 C/I（dB），无服务星 → NaN
  // C 与 I 各自留一份（P4）：I/N、C/(N+I)、ΔT/T 都要单独的 C 或 I，只留差值 C/I 是推不回去的。
  // 单位都是 dBW/Hz（谱密度），与入参的 eirpDensity 同口径。
  const cDbArr = new Float32Array(T).fill(NaN);
  const iDbArr = new Float32Array(T).fill(NaN);   // 无干扰源可见 → −∞
  const servingElev = new Float32Array(T).fill(NaN);
  const minTheta = new Float32Array(T).fill(NaN); // 该时刻最近的干扰星离轴角（识别 in-line 用）
  let done = 0;
  let noServing = 0;

  // ---- 系统噪声（P4）----
  // 给了才算 I/N、C/(N+I)、ΔT/T；没给就只出 C/I（= v1.3.6）。
  // 两种给法：直接给 T_sys，或给 G/T 由本站峰值增益反推 T_sys = 10^((G − G/T)/10)。
  const noise = (() => {
    const nz = opt.noise || {};
    let tSysK = num(nz.tSysK, null);
    let from = 'tSysK';
    if (tSysK == null) {
      const got = num(nz.gOverTdBK, null);
      if (got != null && gPeak != null) { tSysK = Math.pow(10, (gPeak - got) / 10); from = 'gOverTdBK'; }
    }
    if (!(tSysK > 0)) return null;
    // −228.6 dBW/K/Hz：与链路预算引擎（utils/linkCalculator.js 的 CONSTANTS.BOLTZMANN）同一个常数，
    // 两处必须一致，否则同一副天线在两个模块里算出的噪声底不一样。
    return { tSysK, n0DbWPerHz: -228.6 + 10 * LOG10(tSysK), from };
  })();
  if (!noise && (opt.criteria || opt.rain)) {
    warnings.push('已设定干扰门限或雨衰分布，但未给出系统噪声温度：I/N、C/(N+I)、ΔT/T 与可用度均无法计算，本次仅输出 C/I');
  }

  // in-line 规避角（B4）。默认取半功率半角 bw3/2 —— 此时穿越时长与首版逐位一致。
  const guardDeg = num(opt.inlineGuardDeg, bw3 > 0 ? bw3 / 2 : null);
  if (guardDeg != null && !(guardDeg > 0)) throw new Error('in-line 规避角须为正');

  // 干扰星的最大视角速度 / 所需步长（粗筛与 in-line 细化都要用，故先算）
  const allIntfRecs = groups.reduce((a, g) => a.concat(g.sats.map((s) => s.rec)), []);
  const req = requiredStepSec(allIntfRecs, guardDeg, 5);
  if (req && stepSec > req.stepSec) {
    warnings.push(`步长 ${stepSec} s 大于 in-line 穿越时长 ${req.crossingSec.toFixed(2)} s（干扰星视角速度 ${req.rateDegPerSec.toFixed(3)}°/s，规避角 ±${guardDeg.toFixed(3)}°），CDF 尾部可能漏采穿越事件；事件表已另按细步重扫，若需 CDF 一并覆盖请将步长降至 ${req.stepSec.toFixed(2)} s 以下`);
  }

  // ---- 回归周期（S.1325-3 §2.7.3）----
  // 「这次跑的时窗覆盖了整个几何循环的百分之几」是读任何一个分位数之前都该先看的数：
  // 覆盖率很低时，尾部统计量与其说是星座的性质，不如说是这一段时间恰好碰上了什么。
  const repeatPeriod = constellationRepeatPeriodSec(allIntfRecs, opt.repeatAccuracyDeg != null ? { accuracyDeg: opt.repeatAccuracyDeg } : undefined);
  if (repeatPeriod && repeatPeriod.sec > 0 && !opt._multiEpoch) {
    const cov = (horizonSec / repeatPeriod.sec) * 100;
    if (cov < 20) {
      warnings.push(`本次时窗 ${(horizonSec / 3600).toFixed(1)} h 仅覆盖星座回归周期（${(repeatPeriod.sec / 86400).toFixed(2)} 天，S.1325-3 §2.7.3 口径，精度 ${repeatPeriod.accuracyDeg}°）的 ${cov.toFixed(1)}%；尾部统计量对起始历元敏感，建议改用多历元蒙特卡洛以覆盖更分散的几何`);
    }
  }

  // 站址常量：站是不动的，ECEF 与当地天顶只算一次
  const stLon = Number(st.lon) || 0, stLat = Number(st.lat) || 0;
  const stP = G.geodeticToEcef(stLon, stLat, (Number(st.alt) || 0) / 1000);
  const SPX = stP[0], SPY = stP[1], SPZ = stP[2];
  const stUp = G.upVector(stLon, stLat);
  const UPX = stUp[0], UPY = stUp[1], UPZ = stUp[2];
  const sinMinElev = Math.sin(minElev * G.DEG);
  // FSL 里与频率有关的部分是常数，别每次重算两个 log10
  const FSL_C = 20 * LOG10(fGHz) + 92.44778322;

  // ---- 可见性粗筛：不可见的星连传播都免了 ----
  //
  // 一个站在任一时刻只看得见 LEO 星座的百分之几；其余的星传播出来只是为了发现「在地平线下」。
  // 先用一遍粗步给每颗星标出「这一时段有没有可能露头」，主循环据此跳过——省的是 SGP4 传播
  // 本身（实测 667 ns/次，热路径里最贵的一项）。
  //
  // ★ 判据必须建在**地心系**上，不能用拓扑角速度。
  //   первый版用「拓扑角速度 × 粗步」当余量：LEO 过顶时拓扑角速度可达 0.68°/s，逼得粗步只能取
  //   37 s，掩码自身的传播量（NC = 时窗/37s）就吃掉了全部收益——实测反而比不筛还慢。
  //   症结是拓扑角速度是**被站址放大过**的量；卫星在地心系里只以轨道角速度移动（Starlink 约
  //   0.063 °/s，慢一个数量级），站在 ECEF 里更是不动。故：
  //       可见 ⟺ 地心张角(站, 星) < γ(ε)，  γ(ε) = acos((Re/r)·cosε) − ε
  //   一个粗步内该张角最多变 (轨道角速度 + 地球自转) × Δt，把它当余量即得保守判据。
  //   余量小 ⇒ 粗步可以取得很大（数百秒），掩码成本降到主扫的百分之几。
  const RE_KM = 6378.137;
  const OMEGA_E_DEG_S = 7.2921150e-5 * G.RAD;      // 地球自转 ≈ 0.0042 °/s

  /** 卫星的地心角速度（度/秒）——由平均运动直接得，与站址无关。 */
  function orbitRateDegPerSec(rec) {
    const n = Number(rec && (rec.no != null ? rec.no : rec.no_kozai));
    return n > 0 ? (n / 60) * G.RAD : 0.07;        // rad/min → deg/s
  }
  /** 该卫星以仰角 ε 可见时，站与星下点的地心张角上限 γ。 */
  function centralAngleDeg(rec, elevDeg) {
    const n = Number(rec && (rec.no != null ? rec.no : rec.no_kozai));
    if (!(n > 0)) return 180;
    const nRadS = n / 60;
    const r = Math.pow(398600.4418 / (nRadS * nRadS), 1 / 3) * (1 + (Number(rec.ecco) || 0));
    if (!(r > RE_KM)) return 180;
    const eps = Math.max(0, Number(elevDeg) || 0) * G.DEG;
    const arg = Math.max(-1, Math.min(1, (RE_KM / r) * Math.cos(eps)));
    return (Math.acos(arg) - eps) * G.RAD;
  }

  // 粗步：取到「余量 ≈ 20°」为止，且不小于主步长的 2 倍——否则掩码比它省下的还贵。
  const _orbRate = 0.07;                            // 先用典型值定粗步，逐星再按各自速率给余量
  const coarseSec = Math.max(2 * stepSec, Math.min(900, 20 / (_orbRate + OMEGA_E_DEG_S)));
  const NC = Math.floor(horizonSec / coarseSec) + 3;
  // 掩码只在真能省的时候建：粗步必须显著大于主步长（NC 远小于 T）
  // opt._noScreen：仅供测试做 A/B（关掉掩码逐字比对结果），生产路径不用
  const screenPays = !opt._noScreen && coarseSec >= 2 * stepSec && NC < T * 0.5;
  const visSlot = (tMs) => {
    const i = Math.floor((tMs - startMs) / 1000 / coarseSec);
    return i < 0 ? 0 : (i >= NC ? NC - 1 : i);
  };
  const screenHas = (screen, satIdx, slot) => !screen || screen[satIdx * NC + slot] === 1;

  // 站址在 ECEF 里是不动的，其地心方向一次算好
  const _stEcef = G.geodeticToEcef(Number(st.lon) || 0, Number(st.lat) || 0, (Number(st.alt) || 0) / 1000);
  const _stN = Math.hypot(_stEcef[0], _stEcef[1], _stEcef[2]) || 1;
  const PHX = _stEcef[0] / _stN, PHY = _stEcef[1] / _stN, PHZ = _stEcef[2] / _stN;

  /** 建一组星的可见性掩码。elevDeg = 该组适用的仰角门限（本星座用 minElev，干扰源用 0）。 */
  function buildScreen(sats, elevDeg) {
    if (!screenPays) return { screen: null, propagations: 0, keptPct: 100 };
    const screen = new Uint8Array(sats.length * NC);
    let prop = 0, kept = 0;
    const dates = new Array(NC), gmsts = new Array(NC);
    for (let c = 0; c < NC; c++) { dates[c] = new Date(startMs + c * coarseSec * 1000); gmsts[c] = satlib.gstime(dates[c]); }
    for (let i = 0; i < sats.length; i++) {
      const rec = sats[i].rec, base = i * NC;
      // 逐星的保守门限：地心张角上限 + 一个粗步内该张角最多的变化量
      const cosThr = Math.cos(Math.min(180, centralAngleDeg(rec, elevDeg) + (orbitRateDegPerSec(rec) + OMEGA_E_DEG_S) * coarseSec) * G.DEG);
      const raw = new Uint8Array(NC);
      for (let c = 0; c < NC; c++) {
        const e = ecefAt(rec, dates[c], gmsts[c]);
        prop++;
        if (!e) { raw[c] = 1; continue; }             // 传播失败 → 不敢剔
        const n = Math.hypot(e[0], e[1], e[2]);
        if (!(n > 0)) { raw[c] = 1; continue; }
        if ((e[0] * PHX + e[1] * PHY + e[2] * PHZ) / n >= cosThr) raw[c] = 1;
      }
      // 向两侧各膨胀一格：不漏掉刚好跨格的那次升起
      for (let c = 0; c < NC; c++) {
        if (raw[c] || (c > 0 && raw[c - 1]) || (c + 1 < NC && raw[c + 1])) { screen[base + c] = 1; kept++; }
      }
    }
    return { screen, propagations: prop, keptPct: sats.length ? (kept / (sats.length * NC)) * 100 : 0 };
  }

  // ---- 建可见性掩码 ----
  // 原实现每颗星每时刻都调 G.lookAngles / G.topocentricAngle，那两个函数内部都在重算站址 ECEF、
  // 重建当地 ENU 基、并分配一串临时数组——站不动，全是白算。实测（200 星 × 300 时刻）几何层
  // 24 ms，已达 SGP4 传播（40 ms）的 60%。现内层改写成无分配的标量运算，见 solveAt。
  const wScreenR = buildScreen(wantedUse, minElev);
  const wScreen = wScreenR.screen;
  const wantedVisible = (i, slot) => !wScreen || wScreen[i * NC + slot] === 1;
  let screenProp = wScreenR.propagations;
  for (const g of groups) {
    const r = buildScreen(g.sats, 0);
    g.screen = r.screen;
    screenProp += r.propagations;
    g.keptPct = r.keptPct;
  }

  const screenKeptPct = (wScreenR.keptPct * wantedUse.length + groups.reduce((a, g) => a + (g.keptPct || 0) * g.sats.length, 0))
    / Math.max(1, wantedUse.length + groups.reduce((a, g) => a + g.sats.length, 0));

  // 复用的 LOS 单位矢量缓冲（干扰星逐颗写入，不分配）
  let sux = 0, suy = 0, suz = 0;          // 服务星 LOS 单位矢量

  // 远区（地球站离轴 > 40°）贡献占比与「接上卫星方向图后聚合干扰降了多少」的功率累计。
  //
  // 两套并行累：base = 不过卫星方向图、不计同频占空（= v1.3.6 的上界包络），
  //            act  = 实际口径。两者之比就是本次源模型改动一共改了多少 dB，
  //            这是比任何单一分位数都更直白的「A1 到底影响多大」。
  // ⚠️ 只在**粗扫**里累（CDF 那一遍，时间上等权）；in-line 细化会把同一段时间重采多次，
  //    混进来就把占比往穿越时刻拉偏了。故 refineInlineEvents 期间置 farAccum=false。
  const FAR_DEG = PS.FAR_OFF_AXIS_DEG;
  let farAccum = true;
  let sumActAll = 0, sumActFar = 0, sumBaseAll = 0, sumBaseFar = 0;

  // 逐座的干扰功率累计（P4 的单源分解）：本时刻值 / 全时窗累加 / 单入最坏及其时刻。
  // ITU 的单入与聚合是两个门限，不能拿一个去顶另一个，故两套都留。
  const gSumHere = new Float64Array(groups.length);
  const gSumAll = new Float64Array(groups.length);
  const gWorst = new Float64Array(groups.length);
  const gWorstAt = new Float64Array(groups.length);

  // 任一时刻求解：返回 {ciDb, minThetaDeg, servingElevDeg} 或 null（无服务星）。
  // 粗扫与 in-line 细化共用同一段逻辑，保证两处口径一致。
  function solveAt(tMs) {
    const date = new Date(tMs);
    const gmst = satlib.gstime(date);
    const slot = visSlot(tMs);

    // 服务星 = 门限以上仰角最高者。比较用 sinEl 而非 asin 后的度数——单调等价，省一次 asin。
    let bestSin = -2, bestRange = 0, bestI = -1;
    let bx = 0, by = 0, bz = 0, hasBest = false;
    let bex = 0, bey = 0, bez = 0;                         // 服务星的 ECEF（卫星侧方向图要用）
    for (let i = 0; i < wantedUse.length; i++) {
      if (!wantedVisible(i, slot)) continue;               // 粗筛：该时段整段在地平线下 → 连传播都免了
      const e = ecefAt(wantedUse[i].rec, date, gmst);
      if (!e) continue;
      const dx = e[0] - SPX, dy = e[1] - SPY, dz = e[2] - SPZ;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(r > 0)) continue;
      const ux = dx / r, uy = dy / r, uz = dz / r;
      const sinEl = ux * UPX + uy * UPY + uz * UPZ;
      if (sinEl < sinMinElev) continue;
      if (sinEl > bestSin) { bestSin = sinEl; bestRange = r; bestI = i; bx = ux; by = uy; bz = uz; bex = e[0]; bey = e[1]; bez = e[2]; hasBest = true; }
    }
    if (!hasBest) return null;
    sux = bx; suy = by; suz = bz;

    let cDb = wantedDen + gPeak - (20 * LOG10(bestRange) + FSL_C);
    let servingOffAxis = 0;
    if (satPatW.active) {
      cDb += satPatW.evalAt(bex, bey, bez, sux, suy, suz, true);
      servingOffAxis = satPatW.out.offAxisDeg;
    }
    let sum = 0, cosThMax = -2;                            // 记录最大 cosθ ≡ 最小 θ
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      gSumHere[gi] = 0;
      const gden = g.den - g.pol.db;
      const sats = g.sats, screen = g.screen, selfIdx = g.selfIdx;
      for (let i = 0; i < sats.length; i++) {
        if (selfIdx && selfIdx[i] === bestI) continue;      // 自系统：服务星自己不算干扰源（按身份，见 satIdentity）
        if (screen && !screenHas(screen, i, slot)) continue;
        const e = ecefAt(sats[i].rec, date, gmst);
        if (!e) continue;
        const dx = e[0] - SPX, dy = e[1] - SPY, dz = e[2] - SPZ;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!(r > 0)) continue;
        const ux = dx / r, uy = dy / r, uz = dz / r;
        if (ux * UPX + uy * UPY + uz * UPZ < 0) continue;   // 地平线以下打不进来
        // 离轴角直接由两条已归一化的 LOS 点乘得出——原来还要再调一次 topocentricAngle
        // （那里会把站址 ECEF、两个 sub、两个 unit 全重算一遍）
        let c = ux * sux + uy * suy + uz * suz;
        if (c > 1) c = 1; else if (c < -1) c = -1;
        const th = Math.acos(c) * G.RAD;
        if (c > cosThMax) cosThMax = c;
        const gOff = esGain(th);
        // base = 各向同性满 EIRP（v1.3.6 口径）；act = 再过一遍卫星侧方向图与同频占空
        const pwBase = lin(gden + gOff - (20 * LOG10(r) + FSL_C));
        let pw = pwBase;
        if (g.satPat.active) {
          // 卫星侧：波束此刻指着哪儿（滚降 ≤ 0）+ 同频复用系数 × 时隙占空
          pw = pwBase * lin(g.satPat.evalAt(e[0], e[1], e[2], ux, uy, uz, false) + g.satPat.coFreqDb);
        } else if (g.coFreqLin !== 1) {
          pw = pwBase * g.coFreqLin;                        // 'none' 也认同频占空（与方向图彼此独立）
        }
        sum += pw;
        gSumHere[gi] += pw;                                 // 逐座的本时刻贡献（单入 / 聚合双口径要用）
        if (farAccum) {
          sumActAll += pw; sumBaseAll += pwBase;
          if (th > FAR_DEG) { sumActFar += pw; sumBaseFar += pwBase; }
        }
      }
    }
    return {
      ciDb: sum > 0 ? cDb - 10 * LOG10(sum) : Infinity,     // 无干扰源可见 → C/I 无穷大
      cDb,
      iDb: sum > 0 ? 10 * LOG10(sum) : -Infinity,
      minThetaDeg: cosThMax <= -2 ? NaN : Math.acos(Math.min(1, cosThMax)) * G.RAD,
      servingElevDeg: Math.asin(Math.max(-1, Math.min(1, bestSin))) * G.RAD,
      servingOffAxisDeg: servingOffAxis
    };
  }

  function stepOne(k) {
    const r = solveAt(startMs + k * stepSec * 1000);
    if (!r) { noServing++; return; }
    servingElev[k] = r.servingElevDeg;
    minTheta[k] = r.minThetaDeg;
    ci[k] = r.ciDb;
    cDbArr[k] = r.cDb;
    iDbArr[k] = r.iDb;
    // 逐座累计：时间平均用 sum，单入最坏用 max（两个门限是两件事，不能互相代替）
    for (let gi = 0; gi < groups.length; gi++) {
      const p = gSumHere[gi];
      gSumAll[gi] += p;
      if (p > gWorst[gi]) { gWorst[gi] = p; gWorstAt[gi] = startMs + k * stepSec * 1000; }
    }
  }

  // ---- in-line 事件的细化扫描 ----
  // 粗步只用于 CDF（CDF 要求时间上等权采样，混入非均匀的细采样会把分布往细化区带偏）。
  // in-line 事件另做一遍：粗扫里凡「最近干扰星已进到一个粗步能走的角距之内」的时刻都是候选，
  // 在其邻域按细步重扫，定出真实的最近点与持续时长。事件是按「时长」报的，不进 CDF 样本池，
  // 故两套采样率并存不影响统计口径。
  // in-line 细化的**硬预算**。没有它会卡死：候选门限是 max(主瓣, 视角速度×步长)，
  // 步长 100 s 时 = 0.33×100×1.2 ≈ 40°，于是几乎每个时刻都成候选、窗口并成整条时间轴，
  // 再按 0.87 s 细步重扫 24 h ≈ 10 万样本 × 全部卫星，而 finalize() 是同步的 → 界面锁死。
  // 现按预算取「最有希望的那些候选」（minTheta 最小者优先），并把丢弃量如实上报。
  // 预算按**传播次数**给，不按样本数——每个样本要传播的星数随星座规模变化，
  // 按样本数定预算的话，星多时墙钟时间会成倍膨胀（1200 星时实测细化占了总耗时的 78%）。
  // 1.2e6 次传播 ≈ 0.8 s，是可接受的收尾开销。
  const MAX_REFINE_PROPAGATIONS = 1.2e6;

  function refineInlineEvents() {
    if (!(guardDeg > 0) || !req) return null;
    farAccum = false;                     // 细化重扫不进「远区占比」的统计（见 farAccum 头注）
    // 每个细化样本的传播量 ≈ 掩码保留下来的星数
    const perSample = Math.max(1, Math.round(
      (wantedUse.length + groups.reduce((a, g) => a + g.sats.length, 0)) * (screenKeptPct / 100)
    ));
    const MAX_REFINE_SAMPLES = Math.max(600, Math.floor(MAX_REFINE_PROPAGATIONS / perSample));
    const fine = Math.max(0.05, Math.min(stepSec, req.stepSec));
    // 候选门限：一个粗步内干扰星最多走过的角距（再留两成余量）
    const candThr = Math.max(guardDeg, req.rateDegPerSec * stepSec) * 1.2;

    // 先收候选并**按最近离轴角升序**排——预算不够时优先细化最可能真穿越的时刻，
    // 而不是听天由命地按时间先后砍掉后半段。
    const cand = [];
    for (let k = 0; k < T; k++) {
      const th = minTheta[k];
      if (Number.isFinite(th) && th <= candThr) cand.push({ k, th });
    }
    if (!cand.length) return { events: [], fineStepSec: fine, candidateWindows: 0, droppedWindows: 0, requiredStepSec: req.stepSec, crossingSec: req.crossingSec, rateDegPerSec: req.rateDegPerSec, degenerate: false };

    const perWin = Math.ceil((2 * stepSec) / fine) + 1;             // 每个候选窗口（±1 粗步）的细采样数
    const maxWin = Math.max(1, Math.floor(MAX_REFINE_SAMPLES / Math.max(1, perWin)));
    cand.sort((a, b) => a.th - b.th);
    const used = cand.slice(0, maxWin);
    const dropped = cand.length - used.length;
    // 粗扫已经分辨不出「哪里可能有穿越」时（门限远大于规避角），排序本身就没多少信息量——
    // 这一点必须让使用者知道，否则会把「细化过的那几处」误当成全部。
    // ×40 而不是 ×20：判据从 bw3 换成 guard(=bw3/2) 后，写 ×40 才是原来那个绝对触发点。
    const degenerate = candThr > guardDeg * 40;

    used.sort((a, b) => a.k - b.k);
    const windows = [];
    for (const c of used) {
      const t0 = startMs + Math.max(0, c.k - 1) * stepSec * 1000;
      const t1 = startMs + Math.min(T - 1, c.k + 1) * stepSec * 1000;
      const last = windows[windows.length - 1];
      if (last && t0 <= last.t1) last.t1 = Math.max(last.t1, t1);   // 相邻候选合并
      else windows.push({ t0, t1 });
    }

    const events = [];
    let samples = 0;
    for (const w of windows) {
      let cur = null;
      for (let t = w.t0; t <= w.t1 + 1e-6; t += fine * 1000) {
        if (++samples > MAX_REFINE_SAMPLES * 1.5) break;            // 二道保险：合并后仍超预算即停
        const r = solveAt(t);
        const inl = r && Number.isFinite(r.minThetaDeg) && r.minThetaDeg < guardDeg;
        if (inl) {
          if (!cur) cur = { startMs: t, endMs: t, minThetaDeg: r.minThetaDeg, worstCiDb: r.ciDb };
          else {
            cur.endMs = t;
            if (r.minThetaDeg < cur.minThetaDeg) cur.minThetaDeg = r.minThetaDeg;
            if (Number.isFinite(r.ciDb) && r.ciDb < cur.worstCiDb) cur.worstCiDb = r.ciDb;
          }
        } else if (cur) { cur.durationSec = (cur.endMs - cur.startMs) / 1000 + fine; events.push(cur); cur = null; }
      }
      if (cur) { cur.durationSec = (cur.endMs - cur.startMs) / 1000 + fine; events.push(cur); }
    }
    events.sort((a, b) => a.startMs - b.startMs);
    return {
      events, fineStepSec: fine, candidateWindows: windows.length, droppedWindows: dropped,
      refinedSamples: samples, degenerate,
      requiredStepSec: req.stepSec, crossingSec: req.crossingSec, rateDegPerSec: req.rateDegPerSec
    };
  }

  const _propAfterScreen = _propCount;

  return {
    T,
    activeCount: wantedUse.length + groups.reduce((a, g) => a + g.sats.length, 0),
    // 性能透明度：粗筛掉了多少传播、建掩码本身花了多少次传播
    perf: { screenPropagations: screenProp, screenKeptPct, coarseSec },
    warnings,
    recommendedStepSec: req ? req.stepSec : null,
    stepBatch(n) {
      const end = Math.min(T, done + Math.max(1, n | 0));
      for (; done < end; done++) stepOne(done);
      return done;
    },
    /**
     * 汇总前的原始料。多历元跑法（createNgsoCiMultiRun）要把各历元的样本池合并成一条 CDF，
     * 故把「收料」与「出统计」拆开：单历元 finalize() = collect() + summarize()。
     */
    collect() {
      const refined = refineInlineEvents();
      if (refined && refined.droppedWindows > 0) {
        warnings.push(`in-line 细化受算力预算限制：${refined.candidateWindows + refined.droppedWindows} 处候选中仅细化了最可能的 ${refined.candidateWindows} 处，其余 ${refined.droppedWindows} 处未查，故事件次数为下界；将步长降至 ${refined.requiredStepSec.toFixed(2)} s 以下可显著减少候选数`);
      }
      if (refined && refined.degenerate) {
        warnings.push(`步长 ${stepSec} s 相对主瓣 ${bw3.toFixed(3)}° 过粗（单步内干扰星移动 ${(refined.rateDegPerSec * stepSec).toFixed(0)}°），粗扫已无法分辨穿越发生的位置，in-line 事件表仅供参考；建议将步长降至 ${refined.requiredStepSec.toFixed(2)} s 附近重算`);
      }
      return {
        ci, servingElev, minTheta, T, stepSec, startMs, bw3, guardDeg, noServing, warnings, kind, refined,
        samplingFactorMax, esPattern: esPat.info,
        satPattern: satPatW.info, satPatternActive: anySatPattern,
        farOffAxisDeg: FAR_DEG,
        farSharePct: sumActAll > 0 ? (sumActFar / sumActAll) * 100 : null,
        farShareNoPatternPct: sumBaseAll > 0 ? (sumBaseFar / sumBaseAll) * 100 : null,
        satPatternReductionDb: (sumActAll > 0 && sumBaseAll > 0) ? 10 * LOG10(sumBaseAll / sumActAll) : null,
        perf: { screenPropagations: screenProp, screenKeptPct, coarseSec, totalPropagations: _propCount - _propAfterScreen + screenProp },
        repeatPeriod: repeatPeriod,
        cDbArr, iDbArr, noise, criteria: opt.criteria || null, rain: opt.rain || null,
        seriesMaxPoints: num(opt.seriesMaxPoints, 2000),
        groups: groups.map((g, gi) => ({
          id: g.id, name: g.name, count: g.sats.length, polDb: g.pol.db, keptPct: g.keptPct,
          samplingFactor: g.samplingFactor, satPattern: g.satPat.info,
          _sumLin: gSumAll[gi], _worstLin: gWorst[gi], _worstAtMs: gWorstAt[gi]
        }))
      };
    },
    finalize() { return summarize(this.collect()); }
  };
}

// ---------------------------------------------------------------------------
// 多历元蒙特卡洛（P3）
// ---------------------------------------------------------------------------
//
// 为什么要它：同一场景、起点相差 0 / 3 / 12 h，实测中位稳在 40.5~40.9 dB，**worst 摆 1.2 dB、
// in-line 次数摆 ±12%**。理想 Walker 尚且如此，真实星历（多壳层 + J2 进动）只会更散。
// 单历元长跑与多历元短跑花同样的算力，后者覆盖到的几何分散得多，尾部估计更稳；
// 而且它天然能给**置信区间**——有误差棒的数才是能报送的数。
//
// S.1325-3 §2.7.3 也是这个意思：「若回归周期短到过顶次数不够，就对若干个初始升交点赤经
// 分别跑一遍」；§2.3.1.3 则要求「给一个初始随机种子，使仿真可在同样条件下重跑」。
//
// ★ 引擎不碰 Date.now()：历元列表由调用方按 seed 生成后传进来，本层只负责合并样本池。

/**
 * bootstrap 区间可信所需的最少块（历元）数。低于它区间只是分辨率伪影，见 bootstrapPercentiles。
 * 取 8：nB=8 时 2.5/97.5 分位已能落在足够多的块组合上；再少（nB≤4）实测宽度会随 nB 剧烈跳动。
 */
const BOOTSTRAP_MIN_BLOCKS = 8;

/** mulberry32：小而稳的确定性 PRNG。同一 seed 永远同一串，bootstrap 才可复现。 */
function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由 seed 在 [0, spanMs) 上确定性地抽 count 个起始历元（升序，供渲染端调用）。 */
function makeEpochs(startMs, spanMs, count, seed) {
  const n = Math.max(1, Math.round(Number(count) || 1));
  const span = Math.max(0, Number(spanMs) || 0);
  const t0 = Number(startMs) || 0;
  if (n === 1 || span <= 0) return [t0];
  const rng = makeRng(seed == null ? 20260728 : seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(t0 + Math.floor(rng() * span));
  out.sort((a, b) => a - b);
  return out;
}

/**
 * bootstrap 置信区间：有放回重采样 B 次，取各目标分位估计的 2.5 / 97.5 分位。
 *
 * ★ 重采样单位是【历元块】，不是单个样本 —— 这一条是整个区间有没有意义的前提。
 *
 * 合并样本池不是 n 个独立观测，而是若干段**连续时序**拼起来的：段内 C/I 高度自相关
 * （相关尺度 = 卫星过顶与服务星切换，几十到几百个样本）。对它逐样本 i.i.d. 重采样，
 * 等于宣称有 n 份独立信息，而真实的独立信息量只有「块数 × 每块的独立段数」。
 * 实测（8 历元 × 2000 样本、AR(1) φ=0.98）：i.i.d. 给 0.272 dB，真实 95% 散布 2.763 dB
 * ——**窄 10 倍**。而这个数是要写进报送材料的误差棒，窄了比没有更糟。
 *
 * 按块重采样（cluster bootstrap）不需要估计相关长度：块内结构原样搬走，块间才是独立的。
 * 代价是分辨率受块数限制——2 个块只有 4 种组合，区间粗但不会假。
 *
 * 单块（单历元）时无从判断块间散布，退化为 i.i.d. 并置 iid:true，由调用方决定要不要显示。
 *
 * 一次重采样把**所有**目标分位一起取出来（而不是每个分位各重采一遍）——排序是这里的大头。
 * 非有限样本（+∞）照常参与：它们本就是样本池的一部分（见 B3），排除掉等于又偷偷换了分母。
 *
 * @param {Array<number[]|Float64Array>} blocks 每个元素 = 一个历元的样本（时间序，不必排序）
 * @returns {{[p:string]: {mean, lo, hi, resamples}}} 另在每项上带 blocks / iid
 */
function bootstrapPercentiles(blocks, pList, opt) {
  const o = opt || {};
  const blks = (blocks || []).filter((b) => b && b.length);
  if (!blks.length || !pList || !pList.length) return {};
  const nB = blks.length;
  const total = blks.reduce((a, b) => a + b.length, 0);
  // 每块先各自排好：重采样后拼起来再排时，V8 的 TimSort 只需归并已有的 run，不是从零排
  const sorted = blks.map((b) => Float64Array.from(b).sort());
  const maxLen = sorted.reduce((a, b) => Math.max(a, b.length), 0);
  const B = Math.max(20, Math.round(Number(o.resamples) || (total > 20000 ? 100 : 200)));
  const rng = makeRng(o.seed == null ? 20260728 : o.seed);
  const ests = {};
  for (const p of pList) ests[p] = [];
  const buf = new Float64Array(nB * maxLen);
  for (let b = 0; b < B; b++) {
    let off = 0;
    for (let k = 0; k < nB; k++) {
      const blk = sorted[(rng() * nB) | 0];
      buf.set(blk, off); off += blk.length;
    }
    const arr = buf.slice(0, off).sort();          // TypedArray.sort 是数值序
    for (const p of pList) {
      const v = percentileWorst(arr, p);
      if (v != null) ests[p].push(v);
    }
  }
  const out = {};
  for (const p of pList) {
    const e = ests[p];
    if (!e.length) continue;
    e.sort((a, b) => a - b);
    const q = (f) => e[Math.max(0, Math.min(e.length - 1, Math.round(f * (e.length - 1))))];
    const finite = e.filter(Number.isFinite);
    out[p] = {
      mean: finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : Infinity,
      lo: q(0.025), hi: q(0.975), resamples: e.length,
      blocks: nB, iid: nB === 1,
      // 块数太少时 2.5 / 97.5 分位只能落在少数几种块组合上（nB=2 只有 4 种），
      // 区间窄不是「更准」而是分辨率不够 —— 实测 nB=2 给 1.06 dB、nB=3 给 5.22 dB。
      // 另：cluster bootstrap 在小 nB 下本就系统性偏窄（nB=8 实测仍窄约 2.9 倍），
      // 故块数不足时 UI 应打灰，并改看 epochStats.perEpoch 的原始散布。
      lowResolution: nB < BOOTSTRAP_MIN_BLOCKS
    };
  }
  return out;
}

/** 把逐样本时序按历元块切开（NaN = 无服务星，不入池）。bootstrap 的入参。 */
function splitBlocks(ci, blocks, T) {
  const bs = (blocks && blocks.length) ? blocks : [{ i0: 0, T }];
  return bs.map((b) => {
    const out = [];
    const end = Math.min(T, b.i0 + b.T);
    for (let i = b.i0; i < end; i++) { const v = ci[i]; if (!Number.isNaN(v)) out.push(v); }
    return out;
  });
}

/**
 * 多历元跑法：逐个历元建 run、顺序推进，最后把各历元的样本池合并成一条 CDF。
 * 对外接口与 createNgsoCiRun 一致（T / stepBatch / finalize），调用方不必分两条路写。
 *
 * @param {object} o  createNgsoCiRun 的全部入参，另加：
 *   epochs        number[]  各历元的起始时刻（ms）。长度 1 时退化为单历元
 *   epochSpanDays number    历元抽样基线的跨度（只为出参说明，不参与计算）
 *   epochMode     'monte-carlo' | 'repeat'
 *   seed          number    生成历元与 bootstrap 用的种子（可复现的关键）
 *   convergeTolDb number    收敛判据：目标分位连续两次变化小于它即认为收敛（默认 0.2 dB）
 *   convergePct   number    收敛判据盯哪一档分位（默认 0.1）
 */
function createNgsoCiMultiRun(o) {
  const opt = o || {};
  const epochs = (opt.epochs || []).map(Number).filter((x) => Number.isFinite(x));
  if (epochs.length <= 1) {
    return createNgsoCiRun(epochs.length === 1 ? { ...opt, startMs: epochs[0] } : opt);
  }

  const runs = epochs.map((ms) => createNgsoCiRun({ ...opt, startMs: ms, _multiEpoch: true }));
  const T = runs.reduce((a, r) => a + r.T, 0);

  // 「样本够不够」「覆盖了回归周期多少」这两件事都要按**合并后**的量说一次——
  // 逐历元各喊一遍会把「单段撑不起 0.1%」误传成「这次算不出 0.1%」，而合起来往往是够的。
  {
    const w = runs[0].warnings;
    const short = DEFAULT_PCTS.filter((p) => (p / 100) * T < 1);
    if (short.length) {
      const need = Math.ceil(100 / Math.min(...short));
      w.push(`${epochs.length} 个历元合计 ${T} 个样本，仍不足以支撑 ${short.map((p) => p + '%').join(' / ')} 分位（最细一档需 ≥ ${need.toLocaleString()} 个），需增加历元数、延长各段时窗或减小步长`);
    }
  }
  const perRunDone = runs.map(() => 0);
  let idx = 0;

  return {
    T,
    epochCount: epochs.length,
    activeCount: runs[0].activeCount,
    perf: runs[0].perf,
    warnings: runs[0].warnings,
    recommendedStepSec: runs[0].recommendedStepSec,
    stepBatch(n) {
      let budget = Math.max(1, n | 0);
      while (budget > 0 && idx < runs.length) {
        const prev = perRunDone[idx];
        const after = runs[idx].stepBatch(budget);
        perRunDone[idx] = after;
        budget -= (after - prev);
        if (after >= runs[idx].T) idx++;
        else if (after === prev) break;                   // 一步都没走动 → 防死循环
      }
      let total = 0;
      for (const d of perRunDone) total += d;
      return total;
    },
    finalize() {
      const parts = runs.map((r) => r.collect());
      return summarizeMerged(parts, {
        mode: opt.epochMode || 'monte-carlo',
        epochs, spanDays: opt.epochSpanDays, seed: opt.seed,
        convergeTolDb: opt.convergeTolDb, convergePct: opt.convergePct
      });
    }
  };
}

/** 把若干历元的 collect() 结果合成一份统计。 */
function summarizeMerged(parts, epochOpt) {
  const eo = epochOpt || {};
  const first = parts[0];
  const totalT = parts.reduce((a, p) => a + p.T, 0);
  const ci = new Float32Array(totalT);
  let off = 0, noServing = 0;
  const events = [];
  const warnings = [];
  const seenWarn = new Set();
  for (const p of parts) {
    ci.set(p.ci, off); off += p.T;
    noServing += p.noServing;
    if (p.refined) for (const e of p.refined.events) events.push(e);
    for (const w of p.warnings) if (!seenWarn.has(w)) { seenWarn.add(w); warnings.push(w); }
  }
  events.sort((a, b) => a.startMs - b.startMs);

  // 各历元合并后的 refined 摘要：细化口径逐历元一致，取第一份的参数即可
  const refined = first.refined ? {
    ...first.refined,
    events,
    droppedWindows: parts.reduce((a, p) => a + (p.refined ? p.refined.droppedWindows : 0), 0),
    candidateWindows: parts.reduce((a, p) => a + (p.refined ? p.refined.candidateWindows : 0), 0),
    degenerate: parts.some((p) => p.refined && p.refined.degenerate)
  } : null;

  const pTarget = Number(eo.convergePct) > 0 ? Number(eo.convergePct) : 0.1;
  const tol = Number(eo.convergeTolDb) > 0 ? Number(eo.convergeTolDb) : 0.2;

  // ─── 收敛判据：盯逐历元估计之间的散布，不盯累积池的相邻差 ──────────────────
  //
  // 首版判「累积池的目标分位连续两次变化 < tol」。那是**必然会触发**的：累积量的相邻差
  // 天然 O(1/k) 递减，分母一大就自己不动了，与各历元之间差多少无关。
  // 实测反例：8 个历元的 C/I(1%) 在 30 / 40 dB 之间交替（摆 10 dB，物理上完全没收敛），
  // 累积轨迹的相邻差是 0.077 / 0.073 / 0.037 / 0.012 / … → 旧判据报「已收敛于第 3 个历元」。
  //
  // 现按「再加历元还能把结论挪动多少」判：把每个历元**各自独立**估的目标分位当成 k 个观测，
  // 其均值的 95% 区间宽度 = 2 × 1.96 × s/√k，宽度 < tol 即认为收敛。
  // 同一个反例下 s = 5 dB、k = 8 ⇒ 宽度 6.9 dB ≫ 0.2 dB，正确地报未收敛。
  const perEpoch = [];
  for (const p of parts) {
    const v = [];
    for (let i = 0; i < p.T; i++) { const x = p.ci[i]; if (!Number.isNaN(x)) v.push(x); }
    v.sort((a, b) => a - b);
    const sup = percentileSupport(pTarget, v.length);
    perEpoch.push(sup.enough ? percentileWorst(v, pTarget) : null);
  }
  // trail 保留累积轨迹（看点估计怎么走，展示用），converged 不再由它决定
  const trail = [];
  {
    const pool = [];
    for (const p of parts) {
      for (let i = 0; i < p.T; i++) { const v = p.ci[i]; if (!Number.isNaN(v)) pool.push(v); }
      const sorted = pool.slice().sort((a, b) => a - b);
      const sup = percentileSupport(pTarget, sorted.length);
      trail.push(sup.enough ? percentileWorst(sorted, pTarget) : null);
    }
  }
  // ciWidthTrail[k] = 用前 k+1 个历元时，目标分位均值的 95% 区间宽度（dB）
  const ciWidthTrail = [];
  let converged = false, convergedAt = null;
  {
    const acc = [];
    for (let k = 0; k < perEpoch.length; k++) {
      const v = perEpoch[k];
      if (v != null && Number.isFinite(v)) acc.push(v);
      if (acc.length < 2) { ciWidthTrail.push(null); continue; }
      let mean = 0;
      for (const x of acc) mean += x;
      mean /= acc.length;
      let ss = 0;
      for (const x of acc) ss += (x - mean) * (x - mean);
      const width = 2 * 1.96 * Math.sqrt(ss / (acc.length - 1) / acc.length);
      ciWidthTrail.push(width);
      if (!converged && width < tol) { converged = true; convergedAt = k + 1; }
    }
  }

  // C 与 I 的逐样本值也要跟着合并（P4 的 I/N、C/(N+I)、可用度都吃它们），
  // 否则多历元下这几项只会拿到第一个历元的数——那是最难发现的那种错：不报错，只是数不对。
  const cDbArr = new Float32Array(totalT);
  const iDbArr = new Float32Array(totalT);
  const servingElev = new Float32Array(totalT);
  const minTheta = new Float32Array(totalT);
  {
    let k = 0;
    for (const p of parts) {
      cDbArr.set(p.cDbArr, k); iDbArr.set(p.iDbArr, k);
      servingElev.set(p.servingElev, k); minTheta.set(p.minTheta, k);
      k += p.T;
    }
  }
  // 逐座累计也要相加（单入最坏取各历元中最狠的那一刻）
  const groups = first.groups.map((g0, gi) => {
    let sum = 0, worst = 0, worstAt = 0;
    for (const p of parts) {
      const g = p.groups[gi];
      sum += g._sumLin || 0;
      if ((g._worstLin || 0) > worst) { worst = g._worstLin; worstAt = g._worstAtMs; }
    }
    return { ...g0, _sumLin: sum, _worstLin: worst, _worstAtMs: worstAt };
  });

  // 样本 i 属于哪个历元、对应哪个绝对时刻——时序曲线要用。
  // 少了它，多历元的时序会把所有样本都按第一个历元的起点排，画出来是一条时间错乱的线。
  const blocks = [];
  { let k = 0; for (const p of parts) { blocks.push({ i0: k, T: p.T, startMs: p.startMs }); k += p.T; } }

  const merged = {
    ...first,
    ci, cDbArr, iDbArr, servingElev, minTheta, groups, blocks,
    T: totalT, noServing, warnings, refined,
    epochs: {
      mode: eo.mode || 'monte-carlo',
      count: parts.length,
      startMsList: (eo.epochs || []).slice(),
      spanDays: eo.spanDays == null ? null : Number(eo.spanDays),
      seed: eo.seed == null ? null : Number(eo.seed),
      convergeTolDb: tol, convergePct: pTarget,
      converged, convergedAtEpoch: convergedAt,
      trail,
      // 逐历元各自独立估的目标分位，以及据此算出的均值 95% 区间宽度轨迹（收敛判据的依据）
      perEpoch, ciWidthTrail,
      ciWidthDb: ciWidthTrail.length ? ciWidthTrail[ciWidthTrail.length - 1] : null
    }
  };
  if (!converged && parts.length >= 3) {
    const w = ciWidthTrail[ciWidthTrail.length - 1];
    warnings.push(`多历元未收敛：${parts.length} 个历元各自估出的 C/I(${pTarget}%) 之间散布过大，`
      + `其均值的 95% 区间宽 ${w == null ? '无法估计' : w.toFixed(2) + ' dB'}，未达判据 ${tol} dB；`
      + '需增加历元数或延长各段时窗');
  }
  // 覆盖率按**合计仿真时长**说（各历元加起来），不是按单段
  if (first.repeatPeriod && first.repeatPeriod.sec > 0) {
    const cov = (totalT * first.stepSec / first.repeatPeriod.sec) * 100;
    if (cov < 20) {
      warnings.push(`${parts.length} 个历元合计 ${(totalT * first.stepSec / 3600).toFixed(1)} h，占星座回归周期（${(first.repeatPeriod.sec / 86400).toFixed(2)} 天，S.1325-3 §2.7.3）的 ${cov.toFixed(1)}%；历元分散于长基线上，几何覆盖优于等长的单段仿真，但仍未覆盖完整周期`);
    }
  }
  return summarize(merged);
}

// ---------------------------------------------------------------------------
// 汇总：CDF / 分位数 / in-line 事件
// ---------------------------------------------------------------------------

/**
 * 由已排序的样本取「有 p% 的时间比它更差」的值 —— 即第 p 百分位（升序取）。
 *
 * 样本池里允许有 +Infinity（该时刻一颗干扰星都看不见，见 B3 的说明）。两个相邻样本里
 * 只要有一个非有限，就直接取低的那个（更差的一侧）——不做插值：Infinity 参与线性插值会
 * 出 NaN（∞ + (∞−∞)·f），而「取更差的一侧」对超越型分位数本就是保守且正确的读法。
 */
function percentileWorst(sortedAsc, pPct) {
  if (!sortedAsc.length) return null;
  const p = Math.max(0, Math.min(100, Number(pPct)));
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const a = sortedAsc[lo], b = sortedAsc[hi];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a;
  return a + (b - a) * (idx - lo);
}

/**
 * 「更差」在**高**的那一侧的量（I/N、ΔT/T）的第 p 百分位。
 * C/I 与 C/(N+I) 是越小越差，用 percentileWorst；I/N 是越大越差，读的是同一条分布的另一头。
 * 把方向写成一个显式参数，而不是让调用方各自去 100−p —— 那种地方最容易一处写反。
 */
function percentileWorstHigh(sortedAsc, pPct) {
  if (!sortedAsc.length) return null;
  const p = Math.max(0, Math.min(100, Number(pPct)));
  const idx = (1 - p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const a = sortedAsc[lo], b = sortedAsc[hi];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return b;      // 取更差（更高）的一侧
  return a + (b - a) * (idx - lo);
}

const DEFAULT_PCTS = [0.001, 0.01, 0.1, 1, 5, 10, 50];

/**
 * 干扰 CDF 与雨衰 CDF 的**卷积** —— 计入干扰后的可用度损失。
 *
 * 为什么是卷积而不是相加：两条分布物理独立（一条是几何统计——星走到哪；一条是传播统计——
 * 雨下多大），把两个 p% 相加是把两件独立的事当成同一件事。卷积不违反 ciNgso 头注里
 * 「两者不能相加」那条告诫，相加才违反。
 *
 * 口径与刻意的取舍：
 *   · 雨衰打在 C 上（下行载波穿过雨区）。干扰星与本站的路径不同、仰角不同，默认**不**给
 *     干扰衰减（保守：干扰不被雨压低），要按同路径处理请显式给 applyToInterference:'same'。
 *   · **雨致噪温抬升**：下行它常与衰减本身同量级，不能默认丢掉。两条路：分布里逐档带
 *     noiseTempK（雨衰引擎本就逐档算了这个数，首选），或给一个介质温度 mediumTempK 由
 *     T_rain = Tm(1 − 10^(−A/10)) 现推。两者都没有就不计，并在出参里明写
 *     noiseRiseIncluded:false —— 不算可以，不说不行。
 *
 * @param {object} o
 *   cDb[] / iDb[]  逐样本的 C 与 I 谱密度（dBW/Hz），与样本池同序（NaN 表示无服务星，跳过）
 *   n0Db           噪声谱密度（dBW/Hz）
 *   rainCdf        [{pct, attenDb, noiseTempK?}]  有 pct% 的时间衰减 ≥ attenDb（升序 pct）
 *   thresholdDb    C/(N+I) 门限
 *   applyToInterference 'none'（默认）| 'same'
 *   mediumTempK    分布里没带 noiseTempK 时的兜底介质温度
 * @returns {{thresholdDb, noInterferencePct, withInterferencePct, lossPct, extraMarginDb,
 *            noiseRiseIncluded, rainBins}}
 */
function availabilityWithRain(o) {
  const cDb = o.cDb, iDb = o.iDb, n0 = Number(o.n0Db), thr = Number(o.thresholdDb);
  if (!cDb || !cDb.length || !Number.isFinite(n0) || !Number.isFinite(thr)) return null;
  const raw = (o.rainCdf || []).filter((d) => d && Number.isFinite(Number(d.pct)) && Number.isFinite(Number(d.attenDb)));
  if (!raw.length) return null;
  raw.sort((a, b) => Number(a.pct) - Number(b.pct));

  // 雨衰 CDF → 离散概率块：pct 是「≥ 该衰减的时间百分比」，相邻两档之差就是落在这一档的概率。
  // 最后补一块「不下雨」（其余时间，衰减取最小档之下，按 0 计）。
  //
  // ★ 每一档必须再细分，否则中断概率被系统性低估。
  //   CDF 给的只是若干个 (pct, A) 点，相邻两点之间衰减是**连续变化**的：(0.001%, 20 dB) 与
  //   (0.01%, 12 dB) 之间那 0.009% 的时间里 A 从 20 连续降到 12。首版整档取区间右端点
  //   （A = 12，即该档里**最小**的衰减），于是门限恰好落在档内时，整档要么全中断要么全不中断——
  //   实测该例在「A > 13 dB 即中断」的门限下报 0.001%，真值约 0.005%（低估 5 倍，上限是一个
  //   完整档宽即 10 倍）。改取中点也只是把偏差减半，仍是量化误差；按 SUB 份细分才把它降到 1/SUB。
  //
  //   两条轴不是同一条，这是最容易做反的地方：
  //     · **概率**在 pct 上均匀（pct 本身就是累积概率）⇒ 按 pct **线性**等分、权重均分
  //     · **衰减**在 log10(pct) 上近似线性（P.618 雨衰 CDF 的自然形状）⇒ 代表值按**对数**轴插值
  //   拿线性轴插衰减会在低 pct 端偏低（那正是尾部所在），拿对数轴分概率则会把权重整体搬错。
  //
  //   最严的那一档 (0, p₀] 无法插值：p → 0 时 A → ∞，而表列不给。只能取表列最大衰减 A₀，
  //   这是**乐观**的边界，故在出参里以 firstBinTruncatedPct 明示，不藏起来。
  const SUB = Math.max(1, Math.round(num(o.subBins, 8)));
  const bins = [];
  let acc = 0;
  for (let i = 0; i < raw.length; i++) {
    const p1 = Number(raw[i].pct);
    const p0 = i === 0 ? 0 : Number(raw[i - 1].pct);
    const wTot = p1 - p0;
    if (!(wTot > 0)) continue;
    const a1 = Number(raw[i].attenDb);
    const tk1 = Number(raw[i].noiseTempK);
    acc += wTot;
    if (i === 0) {
      // (0, p₀]：无从插值，按表列最大衰减计（见上）
      bins.push({ w: wTot / 100, a: a1, tk: Number.isFinite(tk1) ? tk1 : null });
      continue;
    }
    const a0 = Number(raw[i - 1].attenDb);
    const tk0 = Number(raw[i - 1].noiseTempK);
    const lg0 = LOG10(p0), lg1 = LOG10(p1), dLg = lg1 - lg0;
    const bothTk = Number.isFinite(tk0) && Number.isFinite(tk1);
    for (let s = 0; s < SUB; s++) {
      // 子档 (ps, pe]：概率按 pct 线性均分，代表衰减取子档中点在 log10(pct) 轴上的插值
      const pm = p0 + wTot * ((s + 0.5) / SUB);
      const t = dLg !== 0 ? (LOG10(pm) - lg0) / dLg : 1;
      bins.push({
        w: (wTot / SUB) / 100,
        a: a0 + (a1 - a0) * t,
        tk: bothTk ? tk0 + (tk1 - tk0) * t : (Number.isFinite(tk1) ? tk1 : null),
      });
    }
  }
  // 其余时间无雨：tk 留 null 而不是 0 —— 写 0 会让「分布里有没有带噪温」这一判断永远为真，
  // 于是没带噪温的分布也被当成带了，噪声抬升就被静默地按 0 计而不是如实报「未计入」。
  // 无雨档的雨致噪温本来就是 0（tRainOf 两条路都给 0），不必也不能靠这里去表达。
  if (acc < 100) bins.push({ w: (100 - acc) / 100, a: 0, tk: null });

  const tm = Number(o.mediumTempK);
  const hasTm = Number.isFinite(tm) && tm > 0;
  const hasPerBinT = bins.some((b) => b.tk != null);
  const noiseRise = hasPerBinT || hasTm;
  const tSys = Math.pow(10, (n0 + 228.6) / 10);                   // 反推 T_sys（与 n0 同源）
  const n0Lin0 = Math.pow(10, n0 / 10);                           // 不计雨致噪温抬升时的 N₀（线性）
  const applyI = o.applyToInterference === 'same';
  const tRainOf = (b) => (b.tk != null ? b.tk : (hasTm ? tm * (1 - Math.pow(10, -b.a / 10)) : 0));

  // ---- 预解算：把内层的 pow / log10 全部提到循环外 ----
  //
  // 细分把档数乘了 SUB 倍，而 outagePct 是 档数 × 样本数、还要被二分调 40 次——原样细分会
  // 从 428 ms 涨到 3.4 s。所以同时把判定式改写成不含超越函数的形式：
  //     (C − A_c + m) − 10lg(N + I) < thr
  //   ⟺ 10^((C − A_c + m − thr)/10) < N + I
  //   ⟺ X[k]·K_b < N_b + I[k]·J_b        X = 10^(C/10)，I = 10^(iDb/10)
  // K_b / J_b / N_b 每档只算一次，内层只剩两乘一加一比较。等价变形（10^x 严格单调），
  // 唯一差别是极边界样本的浮点舍入方向，量级 1e-15 dB。
  const nSamp = cDb.length;
  const X = new Float64Array(nSamp);       // 10^(C/10)；无服务星的样本置 −1 作跳过标记
  const IL = new Float64Array(nSamp);      // 10^(I/10)，无干扰源可见（−∞）时为 0
  let valid = 0;
  for (let k = 0; k < nSamp; k++) {
    const c = cDb[k];
    if (Number.isNaN(c)) { X[k] = -1; continue; }                 // 无服务星：不属于本口径的统计域
    X[k] = Math.pow(10, c / 10);
    IL[k] = Number.isFinite(iDb[k]) ? Math.pow(10, iDb[k] / 10) : 0;
    valid++;
  }
  if (!valid) return null;
  // 无干扰对照那一路判定式退化成 X[k] < N_b/K_b，与样本无关的一维阈值 ⇒ 预排序 + 二分，
  // 档数再多也只是 O(档 · lg n)。
  const Xsorted = X.filter((v) => v >= 0).sort();                 // TypedArray.sort 是数值序，不是字典序
  const countBelow = (thrX) => {                                  // #{ X < thrX }
    let lo = 0, hi = Xsorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (Xsorted[m] < thrX) lo = m + 1; else hi = m; }
    return lo;
  };
  const nLinOf = (b) => (noiseRise ? Math.pow(10, (-228.6 + 10 * LOG10(tSys + tRainOf(b))) / 10) : n0Lin0);

  // 给定附加余量 m（dB），算 C/(N+I) 低于门限的时间占比
  function outagePct(marginDb) {
    let bad = 0, tot = 0;
    const Km = Math.pow(10, (marginDb - thr) / 10);
    for (const b of bins) {
      const att = Math.pow(10, -b.a / 10);
      const K = Km * att, J = applyI ? att : 1, NB = nLinOf(b), w = b.w;
      let cnt = 0;
      for (let k = 0; k < nSamp; k++) {
        const x = X[k];
        if (x < 0) continue;
        if (x * K < NB + IL[k] * J) cnt++;
      }
      bad += cnt * w; tot += valid * w;
    }
    return tot > 0 ? (bad / tot) * 100 : null;
  }

  // 无干扰对照：把 I 整个拿掉
  function outageNoIntfPct(marginDb) {
    let bad = 0, tot = 0;
    const Km = Math.pow(10, (marginDb - thr) / 10);
    for (const b of bins) {
      const K = Km * Math.pow(10, -b.a / 10);
      bad += countBelow(nLinOf(b) / K) * b.w;
      tot += valid * b.w;
    }
    return tot > 0 ? (bad / tot) * 100 : null;
  }

  const outWith = outagePct(0);
  const outNo = outageNoIntfPct(0);
  if (outWith == null || outNo == null) return null;

  // 需补多少 dB 余量，才能把「计入干扰」的可用度拉回「无干扰」的水平
  let extra = null;
  if (outWith > outNo + 1e-12) {
    let lo = 0, hi = 30;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (outagePct(mid) <= outNo) hi = mid; else lo = mid;
    }
    extra = hi;
  } else extra = 0;

  return {
    thresholdDb: thr,
    noInterferencePct: 100 - outNo,
    withInterferencePct: 100 - outWith,
    lossPct: outWith - outNo,
    extraMarginDb: extra,
    noiseRiseIncluded: noiseRise,
    applyToInterference: applyI ? 'same' : 'none',
    rainBins: bins.length,
    // 细分参数与它带来的量化上界：门限落在档内时，中断概率的残余误差 ≤ 一个子档宽
    rainSubBins: SUB,
    quantizationPctBound: bins.length > 1 ? Math.max(...bins.map((b) => b.w)) * 100 : null,
    // 最严的那一档 (0, p₀] 只能按表列最大衰减计（p→0 时 A→∞，表不给）——乐观边界，须随结果一起报
    firstBinTruncatedPct: Number(raw[0].pct),
    firstBinAttenDb: Number(raw[0].attenDb)
  };
}

// 分位数的样本门禁（A2）。nEff = p/100 × 样本数 = 「有多少个样本真的落在该分位以下」。
//   nEff < 1   → 该档拿到的就是最小值，只是贴了个百分比标签 ⇒ 不出数
//   nEff < 10  → 出数但标 weak，UI 打灰
const PCT_WEAK_SAMPLES = 10;

/** 某分位在给定样本数下的支撑度。 */
function percentileSupport(pPct, sampleCount) {
  const p = Number(pPct);
  const n = Math.max(0, Number(sampleCount) || 0);
  const nEff = (p / 100) * n;
  return {
    nEff,
    needSamples: Math.ceil(100 / p),
    enough: nEff >= 1,
    weak: nEff >= 1 && nEff < PCT_WEAK_SAMPLES
  };
}

function summarize(s) {
  // ─── B3：无干扰源可见的样本必须留在池子里 ─────────────────────────────────
  // 首版按 Number.isFinite 过滤，把 C/I = +∞（该时刻地平线以上一颗干扰星都没有）的样本
  // 整个丢出统计池，于是 p% 的分母悄悄变成了「有干扰的时间」而不是「全部时间」——
  // 星座越稀、丢得越多，报出来的 C/I(0.1%) 越乐观。现按「有服务星就是一个样本」计：
  //     NaN  = 没有服务星（服务中断，另计入 noServing，不属于 C/I 的统计域）
  //     +∞   = 有服务星、无干扰源 → 是货真价实的「这一刻干扰为零」，必须计入
  // 改完 samples + noServing === T 恒成立，是不变式而非巧合。
  const vals = [];
  let noInterferer = 0;
  for (let i = 0; i < s.T; i++) {
    const v = s.ci[i];
    if (Number.isNaN(v)) continue;                 // 无服务星
    if (!Number.isFinite(v)) noInterferer++;       // +∞：无干扰源可见
    vals.push(v);
  }
  vals.sort((a, b) => a - b);

  const sampled = (s.samplingFactorMax || 1) > 1.001;
  const pct = {};
  const support = {};
  for (const p of DEFAULT_PCTS) {
    const sup = percentileSupport(p, vals.length);
    if (sampled) { sup.sampled = true; sup.samplingFactor = s.samplingFactorMax; }
    support[p] = sup;
    pct[p] = sup.enough ? percentileWorst(vals, p) : null;
  }
  // ─── P4：I/N · C/(N+I) · ΔT/T · 单源分解 · 时序 · 越限统计 ────────────────
  //
  // 规划口径的干扰判据（S.1323）是 I/N 或 ΔT/T，链路口径要的是 C/(N+I)——只报 C/I
  // 三种人都不够用。三者与 C/I 同源同样本，故一起算、一起出。
  //   N₀ = k·T_sys          （dBW/Hz，k = −228.6 dBW/K/Hz，与链路预算引擎同一个常数）
  //   I/N = I₀ − N₀
  //   C/(N+I) = C₀ − 10lg(n₀ + i₀)
  //   ΔT/T = I₀/(k·T) —— 与 I/N 是同一个比值，只是写成百分数
  let iOverN = null, cOverNI = null, deltaTOverT = null, breach = null, availability = null;
  const nz = s.noise;
  if (nz && s.cDbArr && s.iDbArr) {
    const n0 = nz.n0DbWPerHz, n0Lin = Math.pow(10, n0 / 10);
    const inArr = [], cniArr = [];
    for (let i = 0; i < s.T; i++) {
      const c = s.cDbArr[i];
      if (Number.isNaN(c)) continue;
      const iDb = s.iDbArr[i];
      inArr.push(Number.isFinite(iDb) ? iDb - n0 : -Infinity);
      const iLin = Number.isFinite(iDb) ? Math.pow(10, iDb / 10) : 0;
      cniArr.push(c - 10 * LOG10(n0Lin + iLin));
    }
    inArr.sort((a, b) => a - b);
    cniArr.sort((a, b) => a - b);
    iOverN = {}; cOverNI = {}; deltaTOverT = {};
    for (const p of DEFAULT_PCTS) {
      if (!support[p].enough) { iOverN[p] = null; cOverNI[p] = null; deltaTOverT[p] = null; continue; }
      const v = percentileWorstHigh(inArr, p);        // I/N 越大越差 → 读分布的另一头
      iOverN[p] = v;
      deltaTOverT[p] = v == null ? null : (Number.isFinite(v) ? 100 * Math.pow(10, v / 10) : 0);
      cOverNI[p] = percentileWorst(cniArr, p);        // C/(N+I) 越小越差，与 C/I 同向
    }
    // 越限统计：门限是可填的，没填的那一项就不算（不编一个默认门限出来当结论）
    const cr = s.criteria || {};
    const thrCi = num(cr.ciDb, null), thrIn = num(cr.iOverNDb, null), thrDt = num(cr.deltaTOverTPct, null);
    breach = { ciPct: null, iOverNPct: null, deltaTPct: null, criteria: { ciDb: thrCi, iOverNDb: thrIn, deltaTOverTPct: thrDt } };
    if (vals.length) {
      if (thrCi != null) breach.ciPct = vals.filter((v) => v < thrCi).length / vals.length * 100;
      if (thrIn != null) breach.iOverNPct = inArr.filter((v) => v > thrIn).length / inArr.length * 100;
      if (thrDt != null) {
        const lim = 10 * LOG10(thrDt / 100);           // ΔT/T(%) → I/N(dB)，同一个比值
        breach.deltaTPct = inArr.filter((v) => v > lim).length / inArr.length * 100;
      }
    }
    // 可用度损失：干扰 CDF ⊗ 雨衰 CDF
    if (s.rain && s.rain.cdf && s.rain.cdf.length && num(s.rain.thresholdDb, null) != null) {
      availability = availabilityWithRain({
        cDb: s.cDbArr, iDb: s.iDbArr, n0Db: n0,
        rainCdf: s.rain.cdf, thresholdDb: num(s.rain.thresholdDb, null),
        applyToInterference: s.rain.applyToInterference,
        mediumTempK: s.rain.mediumTempK
      });
      if (availability && !availability.noiseRiseIncluded) {
        s.warnings.push('可用度合成未计入雨致噪温抬升（下行链路中该项常与衰减本身同量级）；如需计入，请提供介质温度 Tm');
      }
    }
  }

  // 单源分解：ITU 的单入 / 聚合是两个门限，两套数都给
  let perGroup = null;
  if (s.groups && s.groups.length && s.groups[0]._sumLin !== undefined) {
    const tot = s.groups.reduce((a, g) => a + (g._sumLin || 0), 0);
    perGroup = s.groups.map((g) => ({
      id: g.id, name: g.name, count: g.count,
      // 时间平均的聚合贡献（dBW/Hz）
      iAggDbW: g._sumLin > 0 && s.T > 0 ? 10 * LOG10(g._sumLin / s.T) : null,
      sharePct: tot > 0 ? (g._sumLin / tot) * 100 : null,
      // 单入最坏：这一座自己最狠的那一刻
      worstSingleEntryDbW: g._worstLin > 0 ? 10 * LOG10(g._worstLin) : null,
      worstAtMs: g._worstLin > 0 ? g._worstAtMs : null
    }));
  }

  // 时序曲线：抽稀到 seriesMaxPoints（够画图，不撑爆 IPC）
  let series = null;
  {
    const maxPts = Math.max(10, Math.round(s.seriesMaxPoints || 2000));
    const stride = Math.max(1, Math.ceil(s.T / maxPts));
    series = [];
    const n0 = nz ? nz.n0DbWPerHz : null;
    // 多历元时样本来自若干段不连续的时间，索引 → 绝对时刻要按段查（见 summarizeMerged 的 blocks）
    const tAt = s.blocks
      ? (i) => { for (let b = s.blocks.length - 1; b >= 0; b--) if (i >= s.blocks[b].i0) return s.blocks[b].startMs + (i - s.blocks[b].i0) * s.stepSec * 1000; return s.startMs; }
      : (i) => s.startMs + i * s.stepSec * 1000;
    for (let i = 0; i < s.T; i += stride) {
      const v = s.ci[i];
      if (Number.isNaN(v)) { series.push({ tMs: tAt(i), ciDb: null, iOverNDb: null, servingElevDeg: null, minThetaDeg: null }); continue; }
      const iDb = s.iDbArr ? s.iDbArr[i] : NaN;
      series.push({
        tMs: tAt(i),
        ciDb: Number.isFinite(v) ? +v.toFixed(3) : null,
        iOverNDb: (n0 != null && Number.isFinite(iDb)) ? +(iDb - n0).toFixed(3) : null,
        servingElevDeg: Number.isFinite(s.servingElev[i]) ? +s.servingElev[i].toFixed(2) : null,
        minThetaDeg: Number.isFinite(s.minTheta[i]) ? +s.minTheta[i].toFixed(3) : null
      });
    }
  }

  // ─── 多历元：bootstrap 置信区间（P3）─────────────────────────────────────
  // 「11.3 dB」与「11.3 dB ±0.6」是两种东西，后者才是能报送的数。区间只在多历元下给：
  // 单历元长跑的样本在时间上高度相关，对它做 bootstrap 会把区间报得比真实窄得多。
  //
  // ★ 重采样单位是历元块（见 bootstrapPercentiles 的头注）。同样的道理也适用于合并池——
  //   它一样是若干段连续时序，只是段更多；逐样本 i.i.d. 会把区间窄一个数量级。
  //   故这里传的是**按历元切开的块**，不是排好序的合并池。
  let epochStats = null;
  if (s.epochs) {
    const targets = DEFAULT_PCTS.filter((p) => support[p].enough);
    const ciP = bootstrapPercentiles(splitBlocks(s.ci, s.blocks, s.T), targets,
      { seed: s.epochs.seed, resamples: s.bootstrapResamples });
    epochStats = { ...s.epochs, ciP };
    const nB = (s.blocks || []).length || 1;
    if (nB < BOOTSTRAP_MIN_BLOCKS) {
      s.warnings.push(`历元数 ${nB} 少于 ${BOOTSTRAP_MIN_BLOCKS}：置信区间按历元整块重采样得出，`
        + `块数这么少时区间宽度主要取决于块组合的种数而非真实不确定度（会偏窄），仅供参考；`
        + `请改看逐历元各自估出的分位值（epochStats.perEpoch）判断散布，或增加历元数`);
    }
  }

  {
    const weak = DEFAULT_PCTS.filter((p) => support[p].weak);
    if (weak.length) s.warnings.push(`${weak.map((p) => p + '%').join(' / ')} 档有效样本不足 ${PCT_WEAK_SAMPLES} 个（分别为 ${weak.map((p) => support[p].nEff.toFixed(2)).join(' / ')} 个），数值仅供参考`);
    const none = DEFAULT_PCTS.filter((p) => !support[p].enough);
    if (none.length) s.warnings.push(`${none.map((p) => p + '%').join(' / ')} 档样本不足（各需 ≥ ${none.map((p) => support[p].needSamples.toLocaleString()).join(' / ')} 个，现有 ${vals.length.toLocaleString()} 个），已按无数据处理`);
    if (sampled) s.warnings.push(`干扰星座按 1/${s.samplingFactorMax.toFixed(1)} 抽样，全部分位数已标记 sampled；聚合干扰因此偏低约 ${(10 * LOG10(s.samplingFactorMax)).toFixed(1)} dB`);
  }

  // CDF 采样点（供画图；等概率间隔取值，避免上万点全丢给渲染端）
  const N = Math.min(400, vals.length);
  const cdf = [];
  for (let i = 0; i < N; i++) {
    const q = N === 1 ? 0 : i / (N - 1);
    cdf.push({ pct: q * 100, ciDb: percentileWorst(vals, q * 100) });
  }

  // in-line 事件：取细化重扫的结果（粗步会漏掉窄主瓣的快速穿越，见 refineInlineEvents 的说明）。
  // 细化不可用时（拿不到干扰星轨道速率）退回粗步逐样本判定，并在 inlineAliasRisk 上标明。
  let events = [];
  const thr = s.guardDeg || 0;                     // 判定阈值 = 规避角（B4），不是 3 dB 全宽
  if (s.refined) {
    events = s.refined.events;
  } else {
    let run = null;
    for (let i = 0; i < s.T; i++) {
      const th = s.minTheta[i];
      const inl = Number.isFinite(th) && thr > 0 && th < thr;
      if (inl && !run) run = { startMs: s.startMs + i * s.stepSec * 1000, _i0: i, minThetaDeg: th, worstCiDb: s.ci[i] };
      else if (inl && run) {
        if (th < run.minThetaDeg) run.minThetaDeg = th;
        if (Number.isFinite(s.ci[i]) && s.ci[i] < run.worstCiDb) run.worstCiDb = s.ci[i];
      } else if (!inl && run) { run.durationSec = (i - run._i0) * s.stepSec; delete run._i0; events.push(run); run = null; }
    }
    if (run) { run.durationSec = (s.T - run._i0) * s.stepSec; delete run._i0; events.push(run); }
  }

  const horizonH = (s.T * s.stepSec) / 3600;
  const inlineSec = events.reduce((a, e) => a + e.durationSec, 0);

  return {
    samples: vals.length,
    noServingSamples: s.noServing,
    // 有服务星、但地平线以上一颗干扰星都没有的样本数（C/I = +∞，已计入样本池，见 B3）
    noInterfererSamples: noInterferer,
    availabilityPct: s.T > 0 ? ((s.T - s.noServing) / s.T) * 100 : 0,
    stepSec: s.stepSec,
    horizonSec: s.T * s.stepSec,
    patternKind: s.kind,
    // 实际走的是哪条包络（S.1428 还是退回了 AP8）——退回时 fellBack 为真
    esPattern: s.esPattern || null,
    // 卫星侧方向图与指向（本星座的；各干扰座的在 groups[].satPattern）。
    // satPatternActive=false 即 mode:'none' —— 结果是上界包络，不是实际 C/I
    satPattern: s.satPattern || null,
    satPatternActive: !!s.satPatternActive,
    // 聚合干扰里有多大比例来自「地球站离轴 > farOffAxisDeg」的干扰星（按功率、全时窗累计）。
    // NoPattern 那条是同一次扫描里并行累出来的「各向同性满 EIRP」基线（= v1.3.6 口径），
    // 两条并列摆着，才看得出源模型这一改到底动了什么；ReductionDb 是聚合干扰总共降了多少 dB。
    farOffAxisDeg: s.farOffAxisDeg,
    farSharePct: s.farSharePct,
    farShareNoPatternPct: s.farShareNoPatternPct,
    satPatternReductionDb: s.satPatternReductionDb,
    beamwidth3dBDeg: s.bw3,
    inlineGuardDeg: s.guardDeg,
    // 下划线开头的是逐座功率累计的中间量，只服务于 perGroup，不出 IPC
    groups: s.groups.map((g) => {
      const o = {};
      for (const k of Object.keys(g)) if (k[0] !== '_') o[k] = g[k];
      return o;
    }),
    perf: s.perf,
    warnings: s.warnings,
    // 统计量
    worstCiDb: vals.length ? vals[0] : null,
    medianCiDb: percentileWorst(vals, 50),
    bestCiDb: vals.length ? vals[vals.length - 1] : null,
    percentiles: pct,
    // 逐档的样本支撑度：{nEff, needSamples, enough, weak, sampled?}
    percentileSupport: support,
    sampled,
    samplingFactorMax: s.samplingFactorMax || 1,
    // 多历元：{mode, count, spanDays, seed, converged, convergedAtEpoch, trail, ciP:{p:{mean,lo,hi}}}
    epochStats,
    // ── P4 报告量（给了 noise 才有）──────────────────────────────────────
    noise: nz ? { tSysK: nz.tSysK, n0DbWPerHz: nz.n0DbWPerHz, from: nz.from } : null,
    iOverN,            // 逐分位，I/N（dB）——越大越差，取的是分布的高端
    cOverNI,           // 逐分位，C/(N+I)（dB）
    deltaTOverT,       // 逐分位，ΔT/T（%）
    breach,            // 门限越限时间占比（门限没填的那项为 null）
    perGroup,          // 单源分解：单入最坏 + 聚合份额
    series,            // 抽稀后的时序
    availability,      // 干扰 CDF ⊗ 雨衰 CDF 的可用度损失
    // 星座回归周期（ITU-R S.1325-3 §2.7.3）与本次时窗对它的覆盖率
    repeatPeriodSec: s.repeatPeriod ? s.repeatPeriod.sec : null,
    repeatPeriodOrbits: s.repeatPeriod ? s.repeatPeriod.orbits : null,
    repeatPeriodAccuracyDeg: s.repeatPeriod ? s.repeatPeriod.accuracyDeg : null,
    repeatCoveragePct: (s.repeatPeriod && s.repeatPeriod.sec > 0)
      ? ((s.T * s.stepSec) / s.repeatPeriod.sec) * 100 : null,
    cdf,
    // in-line（走细化重扫；细化不可用时退回粗步，此时 inlineRefined=false 表示可能漏采）
    inlineEvents: events,
    inlineCount: events.length,
    inlineTotalSec: inlineSec,
    inlineDutyPct: s.T > 0 ? (inlineSec / (s.T * s.stepSec)) * 100 : 0,
    inlinePerDay: horizonH > 0 ? events.length * (24 / horizonH) : 0,
    inlineRefined: !!s.refined,
    inlineFineStepSec: s.refined ? s.refined.fineStepSec : null,
    inlineDroppedWindows: s.refined ? s.refined.droppedWindows : 0,
    inlineDegenerate: !!(s.refined && s.refined.degenerate),
    // CDF 尾部是否可能因步长过粗而漏采穿越（事件表已细化，但 CDF 本身仍是粗步的）
    cdfAliasRisk: !!(s.refined && s.stepSec > s.refined.requiredStepSec),
    crossingSec: s.refined ? s.refined.crossingSec : null,
    interfererRateDegPerSec: s.refined ? s.refined.rateDegPerSec : null,
    recommendedStepSec: s.refined ? s.refined.requiredStepSec : null
  };
}

module.exports = {
  createNgsoCiRun, createNgsoCiMultiRun,
  orbitCanReach, estimateWork, percentileWorst, percentileSupport,
  DEFAULT_PCTS, PCT_WEAK_SAMPLES,
  maxAngularRateDegPerSec, requiredStepSec, percentileWorstHigh,
  constellationRepeatPeriodSec, makeEpochs, makeRng, bootstrapPercentiles, splitBlocks,
  availabilityWithRain
};
