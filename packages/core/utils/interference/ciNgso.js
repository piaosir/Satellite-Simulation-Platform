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

/** 卫星过顶时的最大视角速度（度/秒）：(ω_轨 − ω_地)·r / (r − Re)，取天顶最坏。 */
function maxAngularRateDegPerSec(satrec) {
  const n = Number(satrec && (satrec.no != null ? satrec.no : satrec.no_kozai));
  if (!(n > 0)) return null;
  const nRadS = n / 60;                                    // rad/min → rad/s
  const a = Math.pow(398600.4418 / (nRadS * nRadS), 1 / 3);
  const RE = 6378.137;
  const rel = Math.max(1e-9, nRadS - 7.2921150e-5);        // 扣掉地球自转（同向最坏取顺行）
  const h = a - RE;
  if (!(h > 0)) return null;
  return (rel * a / h) * G.RAD;
}

/**
 * 为「每次 in-line 穿越至少采到 minSamples 个点」所需的步长（秒）。
 * @returns {{stepSec:number, rateDegPerSec:number, crossingSec:number}|null}
 */
function requiredStepSec(satrecs, beamwidth3dBDeg, minSamples) {
  const bw = Number(beamwidth3dBDeg);
  if (!(bw > 0)) return null;
  let rate = 0;
  for (const r of (satrecs || [])) {
    const v = maxAngularRateDegPerSec(r);
    if (v != null && v > rate) rate = v;
  }
  if (!(rate > 0)) return null;
  const crossingSec = bw / rate;
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
    warnings.push(`本星座 ${wantedSats.length} 颗中 ${wantedSats.length - wantedUse.length} 颗轨道够不到本站纬度，已剔除`);
  }

  const groups = [];
  for (const g of (opt.interferers || [])) {
    if (!g) continue;
    const den = num(g.eirpDensityDbWPerHz, null);
    if (den == null) { warnings.push(`干扰星座「${g.name || g.id || '?'}」缺 EIRP 密度，已跳过`); continue; }
    const all = (g.sats || []).filter((s) => s && s.rec);
    const use = all.filter((s) => orbitCanReach(s.rec, st.lat, minElev));
    if (!use.length) { warnings.push(`干扰星座「${g.name || g.id}」的轨道够不到本站纬度，已跳过`); continue; }
    if (use.length < all.length) warnings.push(`干扰星座「${g.name || g.id}」${all.length} 颗中 ${all.length - use.length} 颗被轨道粗筛剔除`);
    // 极化折减（同座内一致）
    const ciAsi = require('./ciAsi.js');
    const pol = opt.applyPolarization === false
      ? { db: 0, relation: 'off' }
      : ciAsi.polarizationDiscrimination((opt.wanted || {}).polarization, g.polarization, g.xpdDb);
    groups.push({ id: g.id, name: g.name || g.id, den, pol, sats: use, selfSystem: !!g.selfSystem });
  }
  if (!groups.length) warnings.push('没有可用的干扰星座——结果只会是纯热噪声场景');

  const stepSec = Math.max(0.1, num(opt.stepSec, 10));
  const horizonSec = Math.max(stepSec, num(opt.horizonSec, 86400));
  const T = Math.floor(horizonSec / stepSec) + 1;
  const startMs = num(opt.startMs, 0);

  // 结果累积
  const ci = new Float32Array(T).fill(NaN);       // 每样本的 C/I（dB），无服务星 → NaN
  const servingElev = new Float32Array(T).fill(NaN);
  const minTheta = new Float32Array(T).fill(NaN); // 该时刻最近的干扰星离轴角（识别 in-line 用）
  let done = 0;
  let noServing = 0;

  // 干扰星的最大视角速度 / 所需步长（粗筛与 in-line 细化都要用，故先算）
  const allIntfRecs = groups.reduce((a, g) => a.concat(g.sats.map((s) => s.rec)), []);
  const req = requiredStepSec(allIntfRecs, bw3, 5);
  if (req && stepSec > req.stepSec) {
    warnings.push(`步长 ${stepSec}s 大于 in-line 穿越时长 ${req.crossingSec.toFixed(2)}s（干扰星视角速度 ${req.rateDegPerSec.toFixed(3)}°/s，主瓣 ${bw3.toFixed(3)}°）——CDF 的尾部可能采不到穿越；事件表另按细步重扫，要让 CDF 本身也覆盖请把步长降到 ${req.stepSec.toFixed(2)}s 以下`);
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

  // 任一时刻求解：返回 {ciDb, minThetaDeg, servingElevDeg} 或 null（无服务星）。
  // 粗扫与 in-line 细化共用同一段逻辑，保证两处口径一致。
  function solveAt(tMs) {
    const date = new Date(tMs);
    const gmst = satlib.gstime(date);
    const slot = visSlot(tMs);

    // 服务星 = 门限以上仰角最高者。比较用 sinEl 而非 asin 后的度数——单调等价，省一次 asin。
    let bestSin = -2, bestRange = 0;
    let bx = 0, by = 0, bz = 0, hasBest = false;
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
      if (sinEl > bestSin) { bestSin = sinEl; bestRange = r; bx = ux; by = uy; bz = uz; hasBest = true; }
    }
    if (!hasBest) return null;
    sux = bx; suy = by; suz = bz;

    const cDb = wantedDen + gPeak - (20 * LOG10(bestRange) + FSL_C);
    let sum = 0, cosThMax = -2;                            // 记录最大 cosθ ≡ 最小 θ
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const gden = g.den - g.pol.db;
      const sats = g.sats, screen = g.screen;
      for (let i = 0; i < sats.length; i++) {
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
        if (g.selfSystem && th < 1e-6) continue;            // 自系统：服务星自己不算干扰
        if (c > cosThMax) cosThMax = c;
        const gOff = P.earthStationOffAxis(kind, D, lam, eff, th);
        sum += lin(gden + gOff - (20 * LOG10(r) + FSL_C));
      }
    }
    return {
      ciDb: sum > 0 ? cDb - 10 * LOG10(sum) : Infinity,     // 无干扰源可见 → C/I 无穷大
      minThetaDeg: cosThMax <= -2 ? NaN : Math.acos(Math.min(1, cosThMax)) * G.RAD,
      servingElevDeg: Math.asin(Math.max(-1, Math.min(1, bestSin))) * G.RAD
    };
  }

  function stepOne(k) {
    const r = solveAt(startMs + k * stepSec * 1000);
    if (!r) { noServing++; return; }
    servingElev[k] = r.servingElevDeg;
    minTheta[k] = r.minThetaDeg;
    ci[k] = r.ciDb;
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
    if (!(bw3 > 0) || !req) return null;
    // 每个细化样本的传播量 ≈ 掩码保留下来的星数
    const perSample = Math.max(1, Math.round(
      (wantedUse.length + groups.reduce((a, g) => a + g.sats.length, 0)) * (screenKeptPct / 100)
    ));
    const MAX_REFINE_SAMPLES = Math.max(600, Math.floor(MAX_REFINE_PROPAGATIONS / perSample));
    const fine = Math.max(0.05, Math.min(stepSec, req.stepSec));
    // 候选门限：一个粗步内干扰星最多走过的角距（再留两成余量）
    const candThr = Math.max(bw3, req.rateDegPerSec * stepSec) * 1.2;

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
    // 粗扫已经分辨不出「哪里可能有穿越」时（门限远大于主瓣），排序本身就没多少信息量——
    // 这一点必须让使用者知道，否则会把「细化过的那几处」误当成全部。
    const degenerate = candThr > bw3 * 20;

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
        const inl = r && Number.isFinite(r.minThetaDeg) && r.minThetaDeg < bw3;
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
    finalize() {
      const refined = refineInlineEvents();
      if (refined && refined.droppedWindows > 0) {
        warnings.push(`in-line 细化受算力预算限制：${refined.candidateWindows + refined.droppedWindows} 处候选只细化了最可能的 ${refined.candidateWindows} 处，另 ${refined.droppedWindows} 处未查——事件次数是**下界**，不是全部。把步长降到 ${refined.requiredStepSec.toFixed(2)}s 以下可让候选大幅减少`);
      }
      if (refined && refined.degenerate) {
        warnings.push(`⚠ 步长 ${stepSec}s 相对主瓣 ${bw3.toFixed(3)}° 过粗（一个步长里干扰星走 ${(refined.rateDegPerSec * stepSec).toFixed(0)}°），粗扫已分辨不出穿越可能发生在哪 —— 此时 in-line 事件表仅供参考，请把步长降到 ${refined.requiredStepSec.toFixed(2)}s 附近重算`);
      }
      return summarize({
        ci, servingElev, minTheta, T, stepSec, startMs, bw3, noServing, warnings, kind, refined,
        perf: { screenPropagations: screenProp, screenKeptPct, coarseSec, totalPropagations: _propCount - _propAfterScreen + screenProp },
        groups: groups.map((g) => ({ id: g.id, name: g.name, count: g.sats.length, polDb: g.pol.db, keptPct: g.keptPct }))
      });
    }
  };
}

// ---------------------------------------------------------------------------
// 汇总：CDF / 分位数 / in-line 事件
// ---------------------------------------------------------------------------

/** 由已排序的样本取「有 p% 的时间比它更差」的值 —— 即第 p 百分位（升序取）。 */
function percentileWorst(sortedAsc, pPct) {
  if (!sortedAsc.length) return null;
  const p = Math.max(0, Math.min(100, Number(pPct)));
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

const DEFAULT_PCTS = [0.001, 0.01, 0.1, 1, 5, 10, 50];

function summarize(s) {
  const vals = [];
  for (let i = 0; i < s.T; i++) {
    const v = s.ci[i];
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);

  const pct = {};
  for (const p of DEFAULT_PCTS) pct[p] = percentileWorst(vals, p);

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
  const thr = s.bw3 || 0;
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
    availabilityPct: s.T > 0 ? ((s.T - s.noServing) / s.T) * 100 : 0,
    stepSec: s.stepSec,
    horizonSec: s.T * s.stepSec,
    patternKind: s.kind,
    beamwidth3dBDeg: s.bw3,
    groups: s.groups,
    perf: s.perf,
    warnings: s.warnings,
    // 统计量
    worstCiDb: vals.length ? vals[0] : null,
    medianCiDb: percentileWorst(vals, 50),
    bestCiDb: vals.length ? vals[vals.length - 1] : null,
    percentiles: pct,
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
  createNgsoCiRun, orbitCanReach, estimateWork, percentileWorst, DEFAULT_PCTS,
  maxAngularRateDegPerSec, requiredStepSec
};
