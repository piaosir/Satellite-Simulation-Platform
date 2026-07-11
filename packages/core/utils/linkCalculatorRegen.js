// utils/linkCalculatorRegen.js
// 再生式链路预算引擎（v1：再生式上行）。
//
// 物理口径：再生式载荷在星上解调 / 再生比特流，上行与下行彻底解耦——端到端不再是弯管的
// 「上行 C/N ⊕ 下行 C/N」噪声级联。对「再生式上行」而言，链路总 C/N 就是上行 C/(N+I)，
// 门限余量据此判定；转发器（SFD/IBO/OBO/带宽）与下行一概不参与。
//
// 实现：复用已对标小程序、经 ITU-R 全精度校验的 NGSO 引擎算出上行「功率链」全部物理量
// （几何/EIRP/各项衰减/到达卫星热噪声 C/N），干扰部分则改用「直接合并」——
//   · NGSO/GEO 引擎的上行干扰走弯管口径：把四路 C/I 折算到转发器 SFD·带宽·回退再与整转发器
//     载波 C/T 线性合成（uplinkCT − uplinkTotalCT）。那套是为「整转发器内多载波 + 转发器噪声」
//     而设，对再生式星上单载波接收并不适用，会高估干扰损失。
//   · 再生式直接合并：四路 C/I（C/ACI·C/ASI·C/XPI·C/IM，皆为固定 dB，与功放无关；rain 去极化
//     已并入 effectiveXpolUplinkFactor）在线性域功率相加得总 C/I，再与到达卫星热噪声 C/N 并联
//     得上行 C/(N+I)：  C/(N+I) = −10·lg( 10^(−C/N_th/10) + Σ 10^(−C/I_i/10) )。
//
// 关键性质：干扰各路与功放无关，热噪声 C/N 随功放输出严格 1:1（dB 域线性）。因此：
//   · 设置功放(power)：给定功放 W → 引擎算出该功率下热噪声 C/N → 直接合并干扰得 C/(N+I) →
//     余量 = C/(N+I) − 门限 C/N。
//   · 设置余量(margin)：先跑一次拿到 (热噪声 C/N₀, 干扰线性和, 门限, 功放 dBW₀)，由「目标
//     C/(N+I)=门限+余量」反解所需热噪声线性份额 = 目标线性 − 干扰线性 → 所需热噪声 C/N →
//     所需功放 W（热噪声与功放 1:1），再以 power 模式重算得到完全自洽的结果。
//
// 下行 / 转发器参数在再生口径下数学上相消，但引擎需要一套完整入参才能良定求解——由渲染层
// buildRegenParams 提供 NGSO 默认占位值（本模块不重复内置默认，保持职责单一）。

const modeSolver = require('./modeSolver.js');
// 星间链路(ISL)需 islHops=1 走 NGSO 引擎的 RF 星间预算，而 modeSolver.computeLinkModeNGSO 会强制 islHops=0，
// 故直接引原始 NGSO 引擎（容错加载）。
let _calcNGSO = null;
try { _calcNGSO = require('./linkCalculatorNGSO.js').calculateLinkBudget; } catch (e) { /* 不可用时 computeRegenIslMode 报错 */ }

function _num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

// 再生式上行干扰的「直接合并」：四路 C/I（dB）在线性域功率相加，返回 Σ 10^(−C/I_i/10)。
// XPI 取已并入 rain 去极化的 effectiveXpolUplinkFactor（ITU-R P.618-14 §4.1）；缺失时回退设备 XPI。
// 干扰项均为固定 dB、与功放无关。无有效干扰项时返回 0（视为无干扰）。
function _regenIntfLinear(d, sat) {
  sat = sat || {};
  const xpiEff = _num(d.effectiveXpolUplinkFactorResult);
  const terms = [
    _num(sat.aciUplinkFactor),                              // C/ACI 邻道
    _num(sat.adjUplinkFactor),                              // C/ASI 邻星
    xpiEff != null ? xpiEff : _num(sat.xpolUplinkFactor),   // C/XPI 交叉极化（含 rain 去极化）
    _num(sat.hpaIntermodFactor),                            // C/IM  高功放互调
  ];
  let lin = 0;
  for (const v of terms) if (v != null && isFinite(v)) lin += Math.pow(10, -v / 10);
  return lin;
}

// 再生式上行 C/(N+I)（dB）：到达卫星热噪声 C/N 与直接合并干扰并联。热噪声缺失时返回 null。
function _regenUplinkCN(d, sat) {
  const thermal = _num(d.uplinkThermalCN);
  if (thermal == null) return null;
  const totalLin = Math.pow(10, -thermal / 10) + _regenIntfLinear(d, sat);
  return -10 * Math.log10(totalLin);
}

// 把结果对象重标为再生式上行专属（合计 C/N = 直接合并的上行 C/(N+I)）。就地改写并返回。
function _reframeUplinkOnly(d, sat) {
  const thr = _num(d.thresholdCN);
  // 上行 C/(N+I)：直接合并干扰口径重算，覆盖引擎原弯管口径 uplinkCN。热噪声缺失时兜底用引擎值。
  let upCN = _regenUplinkCN(d, sat);
  if (upCN == null) upCN = _num(d.uplinkCN);
  if (upCN != null) {
    d.uplinkCN = upCN.toFixed(2);
    d.uplinkWithIslCN = upCN.toFixed(2);   // 再生无 ISL：含 ISL 值退化为 uplinkCN
    d.carrierTotalCN = upCN.toFixed(2);
    // 上行干扰等效 C/I（= 直接合并总 C/I），供瀑布「干扰损失」与详情展示
    const intfLin = _regenIntfLinear(d, sat);
    d.uplinkInterferenceCN = intfLin > 0 ? (-10 * Math.log10(intfLin)).toFixed(2) : '';
    if (thr != null) {
      const m = upCN - thr;
      d.linkmargin = m.toFixed(2);
      d.marginResult = m.toFixed(2);
    }
  }
  // 再生式：上行与下行彻底解耦，系统可用度就是上行可用度——弯管的「上行×下行」联合可用度
  // （NGSO 引擎默认口径）在再生下不成立，会低估真实可用度，须重标为上行专属并同步中断时长。
  const upAvail = _num(d.uplinkAvailabilityResult);
  if (upAvail != null) {
    d.systemAvailabilityResult = upAvail.toFixed(5);
    const unavail = (100 - upAvail) / 100;
    const interruptionMinutes = unavail * 365.25 * 24 * 60;
    d.interruptionMinutes = interruptionMinutes.toFixed(2);
    d.interruptionHours = (interruptionMinutes / 60).toFixed(2);
  }
  // 下行/转发器在再生口径下不参与——清空展示字段，避免瀑布/汇总误读弯管量
  d.downlinkCN = '';
  d.regenerative = true;
  d.linkType = 'uplink';
  return d;
}

// 计算方式求解（再生式上行）。opt: { mode:'margin'|'power', powerW }
// 返回 { success, data, mode, resolvedMargin } 或 { success:false, message }
function computeRegenUplinkMode(satParams, inputs, opt) {
  opt = opt || {};
  const mode = opt.mode === 'power' ? 'power' : 'margin';
  const sp = satParams || {};
  const inp = inputs || {};

  if (mode === 'power') {
    const w = parseFloat(opt.powerW);
    if (!(w > 0)) return { success: false, message: '请输入有效的功放功率(W)' };
    const r = modeSolver.computeLinkModeNGSO(sp, inp, { mode: 'power', powerW: w });
    if (!r || !r.success) return r;
    const d = _reframeUplinkOnly(r.data, sp);
    return { success: true, data: d, mode: 'power', resolvedMargin: _num(d.linkmargin) };
  }

  // margin：目标上行余量 M → 反解所需热噪声 C/N → 求所需功放 W → 以 power 模式重算得到自洽结果
  const M = parseFloat(inp.margin);
  const targetMargin = isNaN(M) ? 3 : M;
  const base = modeSolver.computeLinkModeNGSO(sp, inp, { mode: 'margin' });
  if (!base || !base.success) return base;
  const d0 = base.data;
  const thermal0 = _num(d0.uplinkThermalCN);         // 基准热噪声 C/N（随功放 1:1 平移）
  const thr0 = _num(d0.thresholdCN);
  const paDb0 = _num(d0.paRecommendationdBResult);   // 基准功放建议功率(dBW)
  if (thermal0 == null || thr0 == null || paDb0 == null) {
    // 兜底：基准量无法解析 → 直接把基准结果按再生口径重标（几何/参数异常时不致崩）
    const dd = _reframeUplinkOnly(d0, sp);
    return { success: true, data: dd, mode: 'margin', resolvedMargin: _num(dd.linkmargin) };
  }
  // 直接合并反解：目标 C/(N+I) = 门限 + 余量 → 所需热噪声线性份额 = 目标线性 − 干扰线性
  const intfLin = _regenIntfLinear(d0, sp);
  const targetCN = thr0 + targetMargin;
  const thermalLinNeeded = Math.pow(10, -targetCN / 10) - intfLin;
  if (!(thermalLinNeeded > 0)) {
    // 目标 C/(N+I) 高于干扰底噪 C/I（增益再大也够不到）——回退到基准并如实反标可达余量
    const dd = _reframeUplinkOnly(d0, sp);
    return { success: true, data: dd, mode: 'margin', resolvedMargin: _num(dd.linkmargin) };
  }
  const thermalCNNeeded = -10 * Math.log10(thermalLinNeeded);
  const deltaDb = thermalCNNeeded - thermal0;        // 热噪声需平移量 = 功放需平移量(dB，1:1)
  const reqW = Math.pow(10, (paDb0 + deltaDb) / 10);
  if (!(reqW > 0) || !isFinite(reqW)) {
    const dd = _reframeUplinkOnly(d0, sp);
    return { success: true, data: dd, mode: 'margin', resolvedMargin: _num(dd.linkmargin) };
  }
  const r = modeSolver.computeLinkModeNGSO(sp, inp, { mode: 'power', powerW: reqW });
  if (!r || !r.success) return r;
  const d = _reframeUplinkOnly(r.data, sp);
  return { success: true, data: d, mode: 'margin', resolvedMargin: _num(d.linkmargin) };
}

// ==================== 再生式下行（广播）====================
// 物理口径：星上再生 → 地面站接收。下行与上行彻底解耦——链路总 C/N 就是下行 C/(N+I)，门限余量据此判定；
// 上行一概不参与。收信站工作点 G/T 由天线口径/效率 + 天线噪温 + 接收机噪温 + 馈线损耗按引擎口径算得
// （不再支持「直接输入设备 G/T」——设备 G/T 的系统噪温未知，无法自洽推出雨致 G/T 劣化）。
//
// 实现：复用 NGSO 引擎跑一次拿「下行功率链」全部损耗与几何中间量（EIRPs/下行FSL/大气/雨/云/综合损耗/
// 引擎 gOverTe/雨致 G/T 劣化/载波噪声带宽），再按再生口径自行重算下行热噪声 C/N：
//   downlinkThermalCN = 卫星下行 EIRP − 下行FSL − 大气 − 雨衰 − 云衰 − 综合损耗 + G/T − 雨致G/T劣化 + 228.6 − 10lgB
// 与 NGSO 弯管的下行热噪声相比有两处关键差异（再生式必须的）：
//   · 用卫星 EIRP（EIRPs）直发，去掉转发器 OBO/容量回退（弯管 cLevelAtGround 用 transponderOutputEIRP——
//     再生无转发器，卫星下行 EIRP 就是单载波直发电平）；
//   · 永远计下行自身雨衰与 G/T 劣化（弯管在「上行雨衰占主导」时会把下行雨衰置 0——再生下行无上行，不成立）。
// 有效 G/T：取引擎 gOverTe（由天线/噪温/馈线算得，含精确雨致 G/T 劣化）。
// 干扰：四路下行 C/I（C/ACI·C/ASI·C/XPI·C/IM，固定 dB）线性域功率相加得总 C/I，与热噪声并联得下行 C/(N+I)。

// 再生式下行干扰「直接合并」：四路下行 C/I（dB）线性域功率相加，返回 Σ 10^(−C/I_i/10)。
// XPI 取已并入 rain 去极化的 effectiveXpolDownlinkFactorResult（ITU-R P.618-14 §4.1）；缺失时回退设备 XPI。
function _regenDnIntfLinear(d, sat) {
  sat = sat || {};
  const xpiEff = _num(d.effectiveXpolDownlinkFactorResult);
  const terms = [
    _num(sat.aciDownlinkFactor),                              // C/ACI 邻道
    _num(sat.adjDownlinkFactor),                              // C/ASI 邻星
    xpiEff != null ? xpiEff : _num(sat.xpolDownlinkFactor),   // C/XPI 交叉极化（含 rain 去极化）
    _num(sat.xpdrIntermodFactor),                             // C/IM  互调
  ];
  let lin = 0;
  for (const v of terms) if (v != null && isFinite(v)) lin += Math.pow(10, -v / 10);
  return lin;
}

// 再生式下行热噪声 C/N（dB）：从引擎结果重算（卫星下行 EIRP 直发，永远计下行雨衰与 G/T 劣化）。
// gtEff：有效 G/T（引擎 gOverTe）。关键量缺失时返回 null。
function _regenDownlinkThermalCN(d, gtEff) {
  const eirp = _num(d.EIRPsResult);
  const fsl = _num(d.downlinkFSLResult);
  const noiseBW = _num(d.RXnoiseBW);
  if (eirp == null || fsl == null || noiseBW == null || gtEff == null || !isFinite(gtEff)) return null;
  const atm = _num(d.downlinkAtmosphericAttenuationResult) || 0;
  const rain = _num(d.downlinkRainAttenuationResult) || 0;
  const cloud = _num(d.downlinkCloudAttenuation) || 0;
  const misc = _num(d.downlinkMiscLossResult) || 0;
  const gtDeg = _num(d.gOverTdegradationResult) || 0;             // 雨致 G/T 劣化（噪温模式恒计入）
  const cLevelAtGround = eirp - fsl - atm - rain - cloud - misc;  // 卫星下行 EIRP 到地面载波电平
  return cLevelAtGround + gtEff - gtDeg + 228.6 - noiseBW;        // −k = +228.6 (dBW/K/Hz)
}

// 再生式下行「卫星功率谱密度」与「到达地面 PFD」（再生口径：卫星下行 EIRP 直发，永远计下行雨衰）。
// 与弯管口径的关键差异：用卫星下行 EIRP(EIRPsResult)直发，不走转发器输出 EIRP。返回 { psd, pfd }（缺量则该项为 null）。
//   · 卫星功率谱密度(dBW/Hz) = 卫星下行 EIRP − 10·lg(载波分配带宽 Hz)         —— 与引擎 satellitePSD 同口径，仅换 EIRP 源
//   · 到达地面 PFD(dBW/m²)   = 到达地面载波电平 C + 10·lg(4π/λ²)             —— 与下行功率链自洽（λ 取下行波长）
function _regenDownlinkPsdPfd(d) {
  const eirp = _num(d.EIRPsResult);
  const out = { psd: null, pfd: null };
  // 卫星功率谱密度：卫星下行 EIRP 摊到载波分配带宽（allocBandwidthResult 单位 kHz → ×1000 得 Hz）
  const bwKHz = _num(d.allocBandwidthResult);
  if (eirp != null && bwKHz != null && bwKHz > 0) {
    out.psd = eirp - 10 * Math.log10(bwKHz * 1000);
  }
  // 到达地面 PFD：到达地面载波电平 + 下行单位面积增益 10·lg(4π/λ²)
  const fsl = _num(d.downlinkFSLResult);
  const lambda = _num(d.rxWavelengthResult);
  if (eirp != null && fsl != null && lambda != null && lambda > 0) {
    const atm = _num(d.downlinkAtmosphericAttenuationResult) || 0;
    const rain = _num(d.downlinkRainAttenuationResult) || 0;   // 再生下行永远计下行雨衰
    const cloud = _num(d.downlinkCloudAttenuation) || 0;
    const misc = _num(d.downlinkMiscLossResult) || 0;
    const cLevelAtGround = eirp - fsl - atm - rain - cloud - misc;
    const unitAreaGain = 10 * Math.log10(4 * Math.PI / (lambda * lambda));
    out.pfd = cLevelAtGround + unitAreaGain;
  }
  return out;
}

// 把结果对象重标为再生式下行专属（合计 C/N = 直接合并的下行 C/(N+I)）。就地改写并返回。
function _reframeDownlinkOnly(d, sat, gtEff) {
  const thr = _num(d.thresholdCN);
  // 有效 G/T：引擎 gOverTe（由天线/噪温/馈线算得；gtEff 缺失时兜底用引擎值）
  const gt = (gtEff != null && isFinite(gtEff)) ? gtEff : _num(d.gOverTeResult);
  if (gt != null) d.gOverTeResult = gt.toFixed(2);   // 回填「实际所用 G/T」，供瀑布/详情展示
  // 下行热噪声 C/N（再生口径重算）。缺关键量时兜底用引擎值。
  let thermal = _regenDownlinkThermalCN(d, gt);
  if (thermal == null) thermal = _num(d.downlinkThermalCN);
  if (thermal != null) {
    const intfLin = _regenDnIntfLinear(d, sat);
    const dnCN = -10 * Math.log10(Math.pow(10, -thermal / 10) + intfLin);
    d.downlinkThermalCN = thermal.toFixed(2);
    d.downlinkInterferenceCN = intfLin > 0 ? (-10 * Math.log10(intfLin)).toFixed(2) : '';
    d.downlinkCN = dnCN.toFixed(2);
    d.carrierTotalCN = dnCN.toFixed(2);
    d.uplinkWithIslCN = dnCN.toFixed(2);   // 再生无上行/ISL：退化字段对齐下行合计
    if (thr != null) {
      const m = dnCN - thr;
      d.linkmargin = m.toFixed(2);
      d.marginResult = m.toFixed(2);
    }
  }
  // 卫星功率谱密度 / 到达地面 PFD（再生口径：卫星下行 EIRP 直发）——就地覆盖引擎弯管值（用转发器输出 EIRP 算得，再生不适用）
  const pp = _regenDownlinkPsdPfd(d);
  if (pp.psd != null && isFinite(pp.psd)) d.satellitePSDResult = pp.psd.toFixed(2);
  if (pp.pfd != null && isFinite(pp.pfd)) d.arrivalPFDAtGroundResult = pp.pfd.toFixed(2);
  // 再生式：上行与下行彻底解耦，系统可用度就是下行可用度（弯管的「上行×下行」联合可用度不成立）。
  const dnAvail = _num(d.downlinkAvailabilityResult);
  if (dnAvail != null) {
    d.systemAvailabilityResult = dnAvail.toFixed(5);
    const unavail = (100 - dnAvail) / 100;
    const interruptionMinutes = unavail * 365.25 * 24 * 60;
    d.interruptionMinutes = interruptionMinutes.toFixed(2);
    d.interruptionHours = (interruptionMinutes / 60).toFixed(2);
  }
  // 上行在再生下行口径下不参与——清空展示字段，避免瀑布/汇总误读弯管量
  d.uplinkCN = '';
  d.regenerative = true;
  d.linkType = 'downlink';
  return d;
}

// 计算方式求解（再生式下行）。opt: { mode:'power'|'margin' }
//   有效 G/T 恒取引擎 gOverTe（由收信站天线/噪温/馈线算得，含精确雨致 G/T 劣化）。
//   power  ：给定收信站（天线/噪温）+ 卫星下行 EIRP → 求下行余量。
//   margin ：目标下行余量 → 反解所需有效 G/T（热噪声与 G/T 1:1）。
// 返回 { success, data, mode, resolvedMargin, resolvedGT } 或 { success:false, message }。
function computeRegenDownlinkMode(satParams, inputs, opt) {
  opt = opt || {};
  const sp = satParams || {};
  const inp = inputs || {};

  // 跑一次 NGSO 引擎拿下行损耗/几何中间量（上行 PA 自动解，不参与）
  const base = modeSolver.computeLinkModeNGSO(sp, inp, { mode: 'margin' });
  if (!base || !base.success) return base;
  const d0 = base.data;
  const gtEff = _num(d0.gOverTeResult);          // 噪温模式：引擎 gOverTe（天线/噪温/馈线算得）

  const mode = opt.mode === 'margin' ? 'margin' : 'power';
  if (mode === 'power') {
    const d = _reframeDownlinkOnly(d0, sp, gtEff);
    return { success: true, data: d, mode: 'power', resolvedMargin: _num(d.linkmargin), resolvedGT: gtEff };
  }

  // margin：目标下行余量 M → 反解所需有效 G/T
  const M = parseFloat(inp.margin);
  const targetMargin = isNaN(M) ? 3 : M;
  const thr0 = _num(d0.thresholdCN);
  const thermal0 = _regenDownlinkThermalCN(d0, gtEff);
  if (thr0 == null || thermal0 == null || gtEff == null) {
    const dd = _reframeDownlinkOnly(d0, sp, gtEff);
    return { success: true, data: dd, mode: 'margin', resolvedMargin: _num(dd.linkmargin), resolvedGT: gtEff };
  }
  // 直接合并反解：目标 C/(N+I) = 门限 + 余量 → 所需热噪声线性份额 = 目标线性 − 干扰线性
  const intfLin = _regenDnIntfLinear(d0, sp);
  const targetCN = thr0 + targetMargin;
  const thermalLinNeeded = Math.pow(10, -targetCN / 10) - intfLin;
  if (!(thermalLinNeeded > 0)) {
    // 目标高于干扰底噪 C/I（G/T 再大也够不到）——回退基准并如实反标可达余量
    const dd = _reframeDownlinkOnly(d0, sp, gtEff);
    return { success: true, data: dd, mode: 'margin', resolvedMargin: _num(dd.linkmargin), resolvedGT: gtEff };
  }
  const thermalNeeded = -10 * Math.log10(thermalLinNeeded);
  const gtNeeded = gtEff + (thermalNeeded - thermal0);   // 热噪声需平移量 = G/T 需平移量（dB，1:1）
  const d = _reframeDownlinkOnly(d0, sp, gtNeeded);
  return { success: true, data: d, mode: 'margin', resolvedMargin: _num(d.linkmargin), resolvedGT: gtNeeded };
}

// ==================== 再生式星间链路（微波 ISL）====================
// 物理口径：发射卫星 → 接收卫星，两星微波直连（无地面、无大气/雨衰）。链路总 C/N = 星间 C/N。
// 几何为核心（另由 ngsoGeometry.solveIslWorstCase 严格求解）：双 SGP4 传播 + 地球临边遮挡 →
// 互视样本中最大星间距离（最差 FSL）注入 satParams.islHopDistance；系统可用度 = 互视可见度占比。
// 链路预算复用 NGSO 引擎已对标的 RF 星间预算（islMode='rf'/islHops=1）：
//   cIsl_CT = islEirp − FSL(dist,freq) + islGT − islMiscLoss；islPerHopCN = cIsl_CT + 228.6 − 载波噪声带宽。
// 门限、载波带宽仍由引擎按载波信号算；余量 = islPerHopCN − 门限。发射 EIRP / 接收 G/T 分别是发射卫星 / 接收卫星的输入。

// 把结果重标为再生式星间专属（合计 C/N = ISL 单跳 C/N）。availPct：互视可见度(%)，作系统可用度。
function _reframeIslOnly(d, availPct) {
  const thr = _num(d.thresholdCN);
  const islCN = _num(d.islPerHopCNResult);   // 引擎 rf 口径 ISL 单跳 C/N
  if (islCN != null) {
    d.carrierTotalCN = islCN.toFixed(2);
    d.uplinkWithIslCN = islCN.toFixed(2);
    if (thr != null) {
      const m = islCN - thr;
      d.linkmargin = m.toFixed(2);
      d.marginResult = m.toFixed(2);
    }
  }
  // 上/下行在星间口径下不参与——清空展示字段
  d.uplinkCN = '';
  d.downlinkCN = '';
  // 系统可用度 = 互视可见度（ISL 无雨衰，唯一中断来自 LOS 丢失/被地球遮挡）
  if (availPct != null && isFinite(availPct)) {
    const a = Math.max(0, Math.min(100, availPct));
    d.systemAvailabilityResult = a.toFixed(5);
    d.uplinkAvailabilityResult = a.toFixed(5);
    d.downlinkAvailabilityResult = a.toFixed(5);
    const unavail = (100 - a) / 100;
    const interruptionMinutes = unavail * 365.25 * 24 * 60;
    d.interruptionMinutes = interruptionMinutes.toFixed(2);
    d.interruptionHours = (interruptionMinutes / 60).toFixed(2);
  }
  d.regenerative = true;
  d.linkType = 'isl';
  return d;
}

// 再生式星间计算。satParams 需含 islEirp/islGT/islFreq/islMiscLoss/islHopDistance(几何最差距离)；
// opt: { visibilityPct }（互视可见度%，来自几何）。返回 { success, data, mode:'isl', resolvedMargin }。
function computeRegenIslMode(satParams, inputs, opt) {
  opt = opt || {};
  if (!_calcNGSO) return { success: false, message: 'NGSO 引擎不可用（linkCalculatorNGSO 加载失败）' };
  // 强制 ISL RF 单跳（islHopDistance 已由几何最差距离注入 satParams）
  const sp = Object.assign({}, satParams || {}, { islMode: 'rf', islHops: 1 });
  const r = _calcNGSO(sp, inputs || {});
  if (!r || !r.success) return r || { success: false, message: 'ISL 计算失败' };
  const d = _reframeIslOnly(r.data, _num(opt.visibilityPct));
  return { success: true, data: d, mode: 'isl', resolvedMargin: _num(d.linkmargin) };
}

module.exports = { computeRegenUplinkMode, computeRegenDownlinkMode, computeRegenIslMode };
