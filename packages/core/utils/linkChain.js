// utils/linkChain.js
// 端到端链路（多跳 / 混合转发）预算引擎。
//
// 覆盖现有三窗不覆盖的拓扑：多颗透明转发卫星 ISL 串联、透明/再生混用、双跳地面转接——
// 任意节点链「起点 → 中继节点×N → 终点」的端到端预算。
// 链端不必是地球站：起点/终点都可以是卫星（星上发起的载波、星上解调结算的载波）；端点卫星
// 一律按载荷直发 / 解调结算口径处理（见 computeLinkChain 里的端点归一）。唯一仍被拒绝的是
// 「地球站直连地球站」这种非卫星链路。
//
// ============ 只有正向计算 ============
// 多跳下「设置余量」反算欠定（目标余量可由发信站功放、任一透明星回退、任一再生星 EIRP 去凑，
// 解不唯一），故本模块没有计算方式选择器，只有一种算法——正向电平递推（power ledger）：
//   ① 从发信站 EIRP 出发（功放 W + 天线增益 − 馈线损耗，口径同现有引擎）；
//   ② 逐 hop：电平 − FSL − 大气 − 雨衰 − 云衰 − 附加损耗 → 到达下一节点，同步累计该 hop 热噪 C/N；
//   ③ 透明节点：按转发器参数（SFD/IBO/OBO）变换出发电平，干扰按弯管口径折算入账，噪声级联继续；
//   ④ 再生节点：当场结算本段 C/(N+I) 对门限 → 段余量；以该节点自己的 EIRP（手填）为新段起点；
//   ⑤ 收信站：结算末段。端到端余量 = 最弱段余量。
//
// ============ 物理量全部借现有引擎 ============
// 本模块只做级联代数与电平递推，一个传播公式都不重新实现：
//   · 星地 hop：喂一套完整占位入参跑 modeSolver.computeLinkModeNGSO，只取所需侧出参
//     （FSL / 大气 / 雨衰 / 云衰 / XPD / G/T 劣化 / 地球站 EIRP / 载波噪声带宽 / 门限 …）。
//     占位做法照 src/regen/regenParams.js 的 buildRegenParams（那边已冒烟验证：另一侧数学上相消）。
//   · 星间微波 hop：linkCalculatorRegen.computeRegenIslMode（NGSO 引擎 islMode='rf'/islHops=1），
//     取 islPerHopCN。
//   · 星间激光 hop：linkCalculatorRegen.computeRegenLaserIslMode（MathWorks 简化功率链）。
// 逐跳异参数：每个 hop 独立一份距离/频率/设备参数——这就是对现有引擎「islHops × 单值等参数跳」
// 的取代；现有引擎的等参数多跳出口保持原样不动。
//
// ============ 干扰口径（两套，各归其位，§2.4）============
// A. 透明段内（段里有透明星）——照弯管既有口径。NGSO 引擎把四路 C/I 折算到「整转发器 C/T」
//    再与热噪并联；本模块把同一套代数改写成正向可用的形式（等价变换，非新模型）：
//      引擎：aciCT = C/ACI + 10lg(B_xpdr) + k，uplinkCT = SFDs − antennaGain − BOi + G_Ts，
//            总 C/T 取倒数和，再整体折算到载波工作点。
//      正向：载波参考的 C/I_j = C/I_j(标称) − capacity + 10lg(B_xpdr / B_noise)
//            其中 capacity = SFDs − BOi − 到达通量密度 = 该载波在转发器工作点之下的回退量。
//      推导：ci_j = T + CT_th − CT_j（T=热噪 C/N，CT_th=热噪 C/T，CT_j=第 j 路干扰 C/T），
//            代入 CT_j = C/I_j + 10lg(B_xpdr) + k 与 T − CT_th = carrierTotalCN − totalCT 即得。
//            单星链上与 computeLinkModeNGSO 的 carrierTotalCN 逐位重合（见 test/linkChain.test.js）。
//    ★ 一段串【多颗】透明星时逐星入账：上行四项在进段那颗星、下行四项在出段那颗星（同单星口径），
//      中间各星（含发射端出星间跳的星）各补自己的转发器互调 C/IM——按【各自的】capacity 折算
//      （见 txpIslImCI）。ACI/ASI/XPI 不逐星重复：同一批相邻载波随信号走到底，只在边界入账一次。
// B. 再生结算点（段里没有透明星 ⇒ 必为单 hop 段）——直接合并口径，照 linkCalculatorRegen 的
//    _regenIntfLinear：Σ 10^(−C/I/10) 与热噪并联。上行段取该卫星上行四项、下行段取下行四项、
//    星间段的星地那四项一概不取（见 directMergeIntfLinear）。
// C. 星间微波跳——星间域自己的一项聚合 C/I（hop.islCI，手填，留空＝不计入）。它与 A/B 那四项
//    不是同一个物理域：真空段无雨致去极化、无地面 ASI 路径，来源是星座内邻 ISL 同频/邻道/极化
//    泄漏，且随这条链路的几何与频率复用而变，故归在【跳】上（与 islEirp/islGT 同构）不挂卫星。
//    并联在引擎单咽喉 computeRegenIslMode 里做（再生式窗口与本模块同源，见 _islIntfMerge），
//    本模块只把代价摊成台账一行。发射端为透明星时其转发器互调（见 A 的 ★）再并一次，两者
//    互不重复——一个是星座里别人的功率，一个是这台 TWTA 自己新生的噪声。
//    ★ 激光跳不走这条：背景光/串扰已含在接收灵敏度 P_req 的定义里，再并一项即双计。
// 雨致去极化并入 XPI 照现有引擎（effectiveXpolUplink/DownlinkFactorResult）。
//
// ============ 几何——引擎只吃数，不解轨道 ============
// 星地 hop：斜距 km + 仰角°；星间 hop：星间距离 km。为空即该链路报错，绝不在引擎内按轨道高度
// 兜底换算。本模块不调用任何最差工况求解器——「自动几何」由渲染端在送进来之前解好并写进
// 链描述子（口径与 NGSO / 再生式两窗同源：GSO 走静止几何、NGSO 选星走 SGP4 双站互视最差、
// 未选星走圆轨道闭式、星间走双 SGP4 最差距离，见 src/e2e/E2eLinkBudgetApp.vue 的 solveGeometry）。
// 引擎这一侧因此永远是「给什么数算什么」，手动与自动两条路逐位同源。
//
// ============ 调制 / 解调在再生节点上是两件事（v2）============
// 一个再生节点物理上是「解调器 + 编码调制器」两个盒子，中间流过的是比特流。故本模块把三件事分开：
//   ① 收侧（解调）——按【上一段】的体制解调；实际门限 = 该体制的理论门限 + 该节点的【解调实现损失】
//      （调制解调器的非理想：载波/符号同步、量化、滤波实现等，工程常用 0.5~1.5 dB；默认 0，不替用户假定）。
//   ② 中间（比特流）——信息速率穿过节点【守恒】：链上一个业务速率贯穿全链，各段体制只管
//      MODCOD / 滚降 / 帧效率，符号率与占用带宽由「业务速率 + 本段 MODCOD」推出。星上复用 / 分流 /
//      槽位固定换高阶调制这类真会改速率的情形，由节点上的【速率适配比】显式给出（渲染端换算后
//      逐段盖进 carriers[段].infoRate，本模块只按收到的数算）。
//   ③ 发侧（调制）——按【下一段】的体制重新编码调制，符号率 / 带宽 / 转发器占用随新 MODCOD 变。
// 误码：各段独立解调、比特透传，误码一旦产生下游无法恢复 ⇒ 端到端 BER = Σ 各段设计 BER
//（各段按其门限工作时的设计值；软件不建 BER-C/N 曲线，不凭空外推余量对应的实际误码率）。
//
// ============ 端到端汇总口径 ============
//   · 端到端余量 = 最弱段余量（各段独立解调，比特透传）。
//   · 系统可用度 = 各星地 hop 站址可用度之积（各站雨区独立假设）；星间 hop 不贡献可用度损失
//     （真空无雨；手动距离下也无互视统计）——占位入参算出的雨衰可用度绝不许漏进星间段。
//   · 端到端时延 = Σ hop 传播时延（距离/c）+ Σ 再生类节点处理时延。
//   · 载波体制为链级单一体制，全段同门限。

const modeSolver = require('./modeSolver.js');
// 星间链路借再生式引擎（其内部已按 islMode='rf'/islHops=1 走 NGSO 的 RF 星间预算）。容错加载。
let _regen = null;
try { _regen = require('./linkCalculatorRegen.js'); } catch (e) { /* 星间 hop 将报错 */ }

const C_LIGHT_KM_S = 299792.458;   // km/s
const BOLTZMANN = -228.6;          // dBW/K/Hz（与三引擎同一常数）

// —— 出参小数位增量 FX ——（与 linkCalculator.js / linkCalculatorNGSO.js / linkCalculatorRegen.js
// 同一机制，逐字对齐）。本模块的物理量来自那几个引擎，故扫描期间三处都要抬；默认 0，逐位与
// 从前完全相同。详细缘由（取整把小跨度的场压成直角阶梯）见 linkCalculator.js 文件头。
let FX = 0;

/**
 * 设置出参小数位增量。
 * @param {number} n 增量位数（夹到 0~8 的整数）
 * @returns {number} 改动前的值——调用方在 finally 里原样写回即可精确复位（可嵌套）
 */
function setOutputPrecisionBoost(n) {
  const prev = FX;
  const v = Math.round(Number(n) || 0);
  FX = v < 0 ? 0 : (v > 8 ? 8 : v);
  return prev;
}

// ============ 小工具 ============
function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
function numOr(v, d) { const n = parseFloat(v); return isFinite(n) ? n : d; }
function fx(v, n) { return (v === null || v === undefined || !isFinite(v)) ? '' : v.toFixed(n + FX); }
// 噪声并联：C/N = −10·lg( Σ 10^(−C/Nᵢ/10) )。空集返回 null。
function cascadeCN(list) {
  let lin = 0, any = false;
  for (const v of list) {
    if (v === null || v === undefined || !isFinite(v)) continue;
    lin += Math.pow(10, -v / 10); any = true;
  }
  if (!any || !(lin > 0)) return null;
  return -10 * Math.log10(lin);
}
// 误码率显示：3e-7 → '3×10⁻⁷'（上标数字与三引擎的 berResult 同一套写法）
const SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const sup = (s) => String(s).split('').map((c) => SUP[c] || c).join('');
function berStr(v) {
  if (v === null || v === undefined || !isFinite(v) || v <= 0) return '';
  const exp = Math.floor(Math.log10(v));
  const mant = v / Math.pow(10, exp);
  const m = Math.abs(mant - Math.round(mant)) < 5e-3 ? String(Math.round(mant)) : mant.toFixed(1);
  return `${m}×10${sup(exp)}`;
}

// 级联台账上「−k − 10·lgB」那一行的值：228.6 − 载波噪声带宽。噪声带宽取不到时整行留空，
// 绝不让 null 当 0 参与（那会把这一行印成 +228.6，比缺一行更危险）。
function kMinusBw(noiseBW) {
  return (noiseBW === null || noiseBW === undefined || !isFinite(noiseBW)) ? null : (-BOLTZMANN - noiseBW);
}

// dB 量线性求和（干扰直接合并用）
function sumLinear(list) {
  let lin = 0;
  for (const v of list) if (v !== null && v !== undefined && isFinite(v)) lin += Math.pow(10, -v / 10);
  return lin;
}

// ============ 占位入参（引擎需一套完整弯管入参才能良定求解；所取侧之外数学上相消）============
// 与 src/regen/regenParams.js 的 XPDR_PLACEHOLDER / UP_LINK_DEFAULTS / DL_LINK_DEFAULTS 同源同值。
const XPDR_PLACEHOLDER = { sfdRef: '-84', sfdGtRef: '0', transponderBandwidth: '36', BOi: '6', BOo: '3' };
const INTF_PLACEHOLDER = {
  aciUplinkFactor: '30', adjUplinkFactor: '25', xpolUplinkFactor: '26', hpaIntermodFactor: '24',
  aciDownlinkFactor: '30', adjDownlinkFactor: '25', xpolDownlinkFactor: '26', xpdrIntermodFactor: '21'
};
const UP_LINK_DEFAULTS = {
  antennaDiameter: '6.2', antennaEfficiency: '65', G_Ts: '2',
  uplinkAvailability: '99.90', uplinkPowerControl: '否', upcValue: '0',
  paBackoff: '0', feederLoss: '3.5', uplinkOtherLoss: '0.3'
};
const DL_LINK_DEFAULTS = {
  rxCenterFrequency: '12.5', downlinkPolarization: 'H',
  rxAntennaDiameter: '3.7', rxAntennaEfficiency: '65', rxEIRP: '46',
  rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxDownlinkAvailability: '99.90',
  rxFeederLoss: '0.2', downlinkOtherLoss: '0.3'
};

// 载波体制（链级单一）→ linkParams
function carrierInto(lp, c) {
  c = c || {};
  lp.infoRate = c.infoRate;
  lp.modulation = c.modulation;
  lp.fec = c.fec;
  lp.ebno = c.ebno;
  lp.ber = c.ber;
  lp.m = c.m;
  lp.bandwidthFactor = c.bandwidthFactor;
  lp.rsCode = c.rsCode;
  lp.noiseRatioMode = c.noiseRatioMode;
  // 余量只影响引擎的反解工作点；本模块一律正向取物理量，不读引擎余量。给个定值保持良定。
  lp.margin = '3';
  return lp;
}

// 卫星节点的转发器/干扰参数 → satParams（再生节点无转发器，用占位）
function satInto(sp, node) {
  node = node || {};
  Object.assign(sp, XPDR_PLACEHOLDER, INTF_PLACEHOLDER);
  sp.satelliteName = node.name || '';
  sp.frequencyBand = node.frequencyBand || 'Ku';
  const put = (k) => { if (node[k] !== undefined && node[k] !== null && node[k] !== '') sp[k] = node[k]; };
  ['aciUplinkFactor', 'adjUplinkFactor', 'xpolUplinkFactor', 'hpaIntermodFactor',
    'aciDownlinkFactor', 'adjDownlinkFactor', 'xpolDownlinkFactor', 'xpdrIntermodFactor'].forEach(put);
  if (node.kind === 'txp') {
    ['BOi', 'BOo', 'transponderBandwidth'].forEach(put);
    // 有效 sfdRef = sfdRef + sfdGtRef（与三窗一致的入口换算）
    const sfd = num(node.sfdRef), gtRef = num(node.sfdGtRef);
    if (sfd !== null) sp.sfdRef = (gtRef ? sfd + gtRef : sfd);
  }
  return sp;
}

// ============ 星地 hop：占位入参组装 ============
// 上行 hop（地球站 → 卫星）：真参数落在上行槽位，下行槽位取占位（数学上相消）。
function buildUpHopParams(chain, es, sat, hop, carrier) {
  const sp = satInto({}, sat);
  const lp = carrierInto({}, carrier || chain.carrier);
  Object.assign(lp, UP_LINK_DEFAULTS, DL_LINK_DEFAULTS);
  // 上行真参数
  lp.centerFrequency = hop.frequency;
  lp.uplinkPolarization = hop.polarization || 'V';
  lp.distanceMode = 'slantRange';
  lp.slantRange = hop.slantRange;
  lp.minElevation = hop.elevation;
  lp.earthStationLocation = es.name || '';
  lp.longitude = es.longitude;
  lp.latitude = es.latitude;
  lp.altitude = es.altitude;
  lp.rainRate = es.rainRate;
  lp.uplinkAvailability = es.availability;
  lp.antennaDiameter = es.antennaDiameter;
  lp.antennaEfficiency = es.antennaEfficiency;
  lp.feederLoss = es.feederLoss;
  lp.paBackoff = es.paBackoff;
  lp.uplinkPowerControl = es.uplinkPowerControl || '否';
  lp.upcValue = es.upcValue;
  lp.uplinkOtherLoss = hop.miscLoss;               // 附加损耗随 hop（不在站上重复计一份）
  lp.G_Ts = sat.gt;                                // 接收卫星的 G/T
  // 下行占位：地理镜像本站，使弯管引擎下行几何良定（不参与取数）
  lp.rxEarthStationLocation = es.name || '';
  lp.rxLongitude = es.longitude;
  lp.rxLatitude = es.latitude;
  lp.rxAltitude = es.altitude;
  lp.rxRainRate = es.rainRate;
  lp.rxDistanceMode = 'slantRange';
  lp.rxSlantRange = hop.slantRange;
  lp.rxMinElevation = hop.elevation;
  return { satParams: sp, linkParams: lp };
}

// 下行 hop（卫星 → 地球站）：真参数落在下行槽位，上行槽位取占位。
function buildDnHopParams(chain, sat, es, hop, carrier) {
  const sp = satInto({}, sat);
  const lp = carrierInto({}, carrier || chain.carrier);
  Object.assign(lp, UP_LINK_DEFAULTS, DL_LINK_DEFAULTS);
  // 下行真参数
  lp.rxCenterFrequency = hop.frequency;
  lp.downlinkPolarization = hop.polarization || 'H';
  lp.rxDistanceMode = 'slantRange';
  lp.rxSlantRange = hop.slantRange;
  lp.rxMinElevation = hop.elevation;
  lp.rxEarthStationLocation = es.name || '';
  lp.rxLongitude = es.longitude;
  lp.rxLatitude = es.latitude;
  lp.rxAltitude = es.altitude;
  lp.rxRainRate = es.rainRate;
  lp.rxDownlinkAvailability = es.availability;
  lp.rxAntennaDiameter = es.antennaDiameter;
  lp.rxAntennaEfficiency = es.rxAntennaEfficiency;
  lp.rxAntennaNoiseTempMode = es.rxAntennaNoiseTempMode;
  lp.rxAntennaNoiseTemp = es.rxAntennaNoiseTemp;
  lp.rxReceiverNoiseTemp = es.rxReceiverNoiseTemp;
  lp.rxFeederLoss = es.rxFeederLoss;
  lp.downlinkOtherLoss = hop.miscLoss;             // 附加损耗随 hop
  lp.rxEIRP = (sat.kind === 'txp') ? sat.eirpSat : sat.eirp;   // 透明=饱和 EIRP；再生=该载波直发 EIRP
  // 上行占位：地理镜像收信站，使弯管引擎上行几何良定（不参与取数）
  lp.earthStationLocation = es.name || '';
  lp.longitude = es.longitude;
  lp.latitude = es.latitude;
  lp.altitude = es.altitude;
  lp.rainRate = es.rainRate;
  lp.distanceMode = 'slantRange';
  lp.slantRange = hop.slantRange;
  lp.minElevation = hop.elevation;
  lp.centerFrequency = chain._upFreqPlaceholder || '14.25';
  return { satParams: sp, linkParams: lp };
}

// 星间微波 hop：占位入参（上/下行为引擎跑通所需，ISL 只读 islPerHopCN）
function buildIslHopParams(chain, hop, carrier) {
  const sp = {};
  Object.assign(sp, XPDR_PLACEHOLDER, INTF_PLACEHOLDER);
  sp.islMode = 'rf'; sp.islHops = 1;
  sp.islEirp = hop.islEirp;
  sp.islGT = hop.islGT;
  sp.islFreq = hop.frequency;
  sp.islMiscLoss = hop.miscLoss;
  sp.islHopDistance = num(hop.rangeKm);
  sp.islCI = hop.islCI;   // 星间干扰合计 C/I（留空＝不计入；并联在引擎里做，见 _islIntfMerge）
  const lp = carrierInto({}, carrier || chain.carrier);
  Object.assign(lp, UP_LINK_DEFAULTS, DL_LINK_DEFAULTS);
  lp.centerFrequency = '14.25'; lp.uplinkPolarization = 'V';
  lp.rxCenterFrequency = '12.5'; lp.downlinkPolarization = 'H';
  // 站名用 ASCII 占位串：ISL 不读它，但界面翻译层会扫到源码里的中文串并报「未覆盖」
  lp.earthStationLocation = 'PLACEHOLDER'; lp.longitude = '116.4074'; lp.latitude = '39.9042';
  lp.rxEarthStationLocation = 'PLACEHOLDER'; lp.rxLongitude = '116.4074'; lp.rxLatitude = '39.9042';
  lp.distanceMode = 'slantRange'; lp.slantRange = 2000; lp.minElevation = 10;
  lp.rxDistanceMode = 'slantRange'; lp.rxSlantRange = 2000; lp.rxMinElevation = 10;
  return { satParams: sp, linkParams: lp };
}

// ============ hop 类型推断 ============
// 由两端节点自动定：地球站→卫星=上行；卫星→地球站=下行；卫星→卫星=星间（微波/激光在 hop 上二选一）。
function hopTypeOf(a, b, hop) {
  const aEs = a.kind === 'es', bEs = b.kind === 'es';
  if (aEs && bEs) return null;                       // 地球站直连地球站：非卫星链路
  if (aEs) return 'up';
  if (bEs) return 'down';
  return (hop && hop.link === 'laser') ? 'laser' : 'isl';
}

// 再生类节点（切段）：再生卫星，以及位于链中部的地球站（地面转接站——落地解调再上星）
function isRegenClass(node, idx, n) {
  if (!node) return false;
  if (node.kind === 'regen') return true;
  if (node.kind === 'es' && idx > 0 && idx < n - 1) return true;   // 地面转接站
  return false;
}

// ============ 主入口 ============
/**
 * 端到端链路预算（正向电平递推）。
 * @param {object} chain 链描述子：{ nodes[], hops[], carrier{} }
 * @returns {object} { success, data } 或 { success:false, message }
 */
function computeLinkChain(chain) {
  chain = chain || {};
  const nodes = Array.isArray(chain.nodes) ? chain.nodes : [];
  const hopsIn = Array.isArray(chain.hops) ? chain.hops : [];
  const N = nodes.length;

  // —— 结构校验（口径硬约束，见 §2.1）——
  if (N < 2) return { success: false, message: '链最少 2 个节点' };
  if (hopsIn.length !== N - 1) return { success: false, message: `hop 数应为 ${N - 1}，实为 ${hopsIn.length}` };

  // —— 端点归一：链端的卫星节点一律按再生类（载荷直发 / 解调结算）处理 ——
  // 链首是卫星＝该载荷【自己发起】这条载波（无来波可转发），起点电平就是它手填的下行/星间 EIRP；
  // 链尾是卫星＝载波【在星上解调结算】（无下一跳可转发），段在此比门限。透明转发器的
  // SFD/IBO/OBO 在这两种位置上都没有可用的物理意义（那套变换要有「来波 → 出波」两侧），
  // 故就地归一，不按 kind 分叉——否则会出现「链首透明星拿转发器变换出一个凭空的出发电平」。
  for (const i of [0, N - 1]) {
    if (nodes[i] && nodes[i].kind !== 'es' && nodes[i].kind !== 'regen') {
      nodes[i] = Object.assign({}, nodes[i], { kind: 'regen' });
    }
  }

  // —— hop 类型推断 + 几何必填校验 ——
  const kinds = [];
  for (let i = 0; i < N - 1; i++) {
    const t = hopTypeOf(nodes[i], nodes[i + 1], hopsIn[i]);
    if (!t) return { success: false, message: `第 ${i + 1} 跳两端都是地球站（地球站只能在链两端或作为地面转接站）` };
    kinds.push(t);
    const h = hopsIn[i] || {};
    if (t === 'up' || t === 'down') {
      if (!(num(h.slantRange) > 0)) return { success: false, message: `第 ${i + 1} 跳缺斜距（km）` };
      if (num(h.elevation) === null) return { success: false, message: `第 ${i + 1} 跳缺仰角（°）` };
      if (!(num(h.frequency) > 0)) return { success: false, message: `第 ${i + 1} 跳缺频率（GHz）` };
    } else {
      if (!(num(h.rangeKm) > 0)) return { success: false, message: `第 ${i + 1} 跳缺星间链路距离（km）` };
    }
    // —— 激光跳两端都必须是再生类 ——（此处端点卫星已归一为 regen，故可就地判）
    // 发端：透明转发器只能变频放大射频，射频变光必须经星上再生；让透明星「发激光」算出来的是
    // 非物理结果——它的互调从不入账（txpIslImCI 只在微波分支调用）、转发器输出电平与手填的激光
    // 发射功率完全脱钩，两套电平各说各话。收端：激光段没有射频电平可往下递推。
    // ★ 附带效果（设计而非巧合）：两端必为再生类 ⇒ 激光跳必然独占一段，故段结算处的
    //   「纯激光段」只有单跳一种形态，不存在激光与射频跳同段级联。
    if (t === 'laser') {
      if (nodes[i].kind !== 'regen') return { success: false, message: `第 ${i + 1} 跳为星间激光，其发射端须为再生类卫星（透明转发器无法将射频变频为激光，须经星上再生）` };
      if (nodes[i + 1].kind !== 'regen') return { success: false, message: `第 ${i + 1} 跳为星间激光，其接收端须为再生类卫星（激光段无射频电平可递推）` };
    }
  }
  // 下行占位需要一个上行频率（引擎的卫星单位面积增益按上行波长算，不影响下行取数）
  const firstUp = kinds.indexOf('up');
  chain._upFreqPlaceholder = firstUp >= 0 ? hopsIn[firstUp].frequency : '14.25';

  // —— 分段切割：再生类节点把链切成段 ——
  const cuts = [0];
  for (let i = 1; i < N - 1; i++) if (isRegenClass(nodes[i], i, N)) cuts.push(i);
  cuts.push(N - 1);
  const segRanges = [];
  for (let s = 0; s < cuts.length - 1; s++) segRanges.push({ from: cuts[s], to: cuts[s + 1] });

  // —— 逐段载波体制 ——
  // 再生类节点解调-重调即可换调制：段与段之间的调制方式 / 码率 / 速率各自独立（chain.carriers[段号]），
  // 缺省回落链级 chain.carrier（老场景与单体制链因此逐位不变）。段内所有 hop 共用本段这一份体制——
  // 段内是同一条已调载波，中途没有解调点可换。
  const segCarrier = (s) => {
    const list = Array.isArray(chain.carriers) ? chain.carriers : null;
    return (list && list[s]) ? list[s] : (chain.carrier || {});
  };
  // hop 号 → 段号（段边界由再生类节点定，见上）
  const segOfHop = [];
  segRanges.forEach((rg, s) => { for (let i = rg.from; i < rg.to; i++) segOfHop[i] = s; });

  // ============ 逐 hop 取物理量 ============
  const hops = [];
  let noiseBWdB = null, thresholdCN = null, carrierEcho = null;
  const segThreshold = [], segNoiseBW = [], segEcho = [];
  for (let i = 0; i < N - 1; i++) {
    const t = kinds[i], h = hopsIn[i] || {}, a = nodes[i], b = nodes[i + 1];
    const sIdx = segOfHop[i] === undefined ? 0 : segOfHop[i];
    const carrier = segCarrier(sIdx);
    let rec;
    try {
      rec = (t === 'up') ? probeUpHop(chain, a, b, h, carrier)
        : (t === 'down') ? probeDnHop(chain, a, b, h, carrier)
          : (t === 'isl') ? probeIslHop(chain, h, carrier)
            : probeLaserHop(chain, h);
    } catch (err) {
      return { success: false, message: `计算失败（第 ${i + 1} 跳）：${(err && err.message) || err}` };
    }
    if (!rec.ok) return { success: false, message: `计算失败（第 ${i + 1} 跳）：${rec.message}` };
    rec.type = t;
    rec.index = i;
    rec.seg = sIdx;
    rec.fromName = a.name || '';
    rec.toName = b.name || '';
    // 传播时延：距离 / c
    const dist = (t === 'up' || t === 'down') ? num(h.slantRange) : num(h.rangeKm);
    rec.distanceKm = dist;
    rec.delayMs = dist / C_LIGHT_KM_S * 1000;
    hops.push(rec);
    if (noiseBWdB === null && rec.noiseBW !== null && rec.noiseBW !== undefined) noiseBWdB = rec.noiseBW;
    if (thresholdCN === null && rec.thresholdCN !== null && rec.thresholdCN !== undefined) thresholdCN = rec.thresholdCN;
    if (!carrierEcho && rec.carrier) carrierEcho = rec.carrier;
    // 本段的门限 / 噪声带宽 / 体制回显：取该段第一个射频 hop（同段同体制，取谁都一样）
    if (segThreshold[sIdx] === undefined && rec.thresholdCN !== null && rec.thresholdCN !== undefined) segThreshold[sIdx] = rec.thresholdCN;
    if (segNoiseBW[sIdx] === undefined && rec.noiseBW !== null && rec.noiseBW !== undefined) segNoiseBW[sIdx] = rec.noiseBW;
    if (!segEcho[sIdx] && rec.carrier) segEcho[sIdx] = rec.carrier;
  }
  // 全激光链（每一跳都是星间激光）本就没有射频门限可取，是合法拓扑——星间激光中继以
  // P_rx 对 P_req 独立结算（见段结算的「纯激光段」分支），故此处只在链上确有射频跳时才报错。
  if (thresholdCN === null && kinds.some((t) => t !== 'laser')) {
    return { success: false, message: '无法取得载波门限 C/N（链上没有可用的射频 hop）' };
  }
  // 段内没有自己那份时退回链级（射频段的兜底；纯激光段不用门限，走不到这里）
  const thrOfSeg = (s) => (segThreshold[s] === undefined ? thresholdCN : segThreshold[s]);
  const bwOfSeg = (s) => (segNoiseBW[s] === undefined ? noiseBWdB : segNoiseBW[s]);

  // ============ 正向电平递推 + 段内级联 ============
  const segments = [];
  const ledger = [];   // 端到端级联瀑布的机读行（供 waterfallBuilder 出表）
  // 透明星的转发器占用（逐颗一条，链上有几颗透明星就有几条）
  const txpUse = [];
  // 载波带宽按【本段】的体制取：一颗透明星占多少转发器带宽，取决于穿过它的那条载波，
  // 而那条载波是它所在段的体制（再生节点之后可能已换成另一种调制/速率）。
  const allocBWofSeg = (s) => num((segEcho[s] || carrierEcho || {}).allocBandwidthResult);
  // 透明星入账：算出该载波的转发器占用，压台账的回退算式 + 占用两行 + 出发电平那一行，
  // 返回每载波输出 EIRP。
  // 两处调用（星地上行进星 / 星间进星）共用——占用是这颗星的属性，与从哪一跳进来无关。
  //   功率占比 = 10^(−载波占转发器回退/10)   （回退 0 dB 即这一条载波吃满转发器输出功率）
  //   带宽占比 = 载波带宽 / 转发器带宽
  // 与 linkCalculatorNGSO 的 uplinkPowerRatio / bandwidthUsageRatio 同式：那边
  // eirpPerCarrier = EIRPs − BOo − transponderCapacity，代入即 10^(−capacity/10)。
  // ★ 回退这个数以前只在台账上摆一个结果（到达通量密度 / 载波占转发器回退两行并排，中间少了
  //   一整条通量密度账），读者无从知道它是「转发器工作点通量密度 − 到达通量密度」。故摊成三小段
  //   算式行，各自闭合、逐行可手算，与级联列其余段同体例：
  //     ① 来波有多强：到达载波电平 C + 卫星天线单位面积增益 = 到达通量密度
  //     ② 转发器等着多强：SFD 标称 − G/T 差 = 饱和通量密度 − IBO = 工作点通量密度
  //     ③ 差多少：工作点 − 到达 = 载波占转发器回退
  //   ① 只能落在这里、不能插进上一跳「C + G/T + k − 10lgB = 本跳 C/N」那条链的中间——级联列
  //   共用一个 running，插进去之后 G/T 就加在通量密度上，整列从上往下手算不下来（本表硬要求）。
  //   代价是「到达载波电平 C」与「到达通量密度」各重复出现一次（前者承上一跳、后者是 ③ 的减数），
  //   这是账目的转写，不是冗余行。
  function noteTxp(txp, nodeIndex, seg, cap, pfd) {
    const eirpSat = num(txp.eirpSat), boo = numOr(txp.BOo, 3);
    const outEirp = (eirpSat === null || cap === null) ? null : (eirpSat - boo - cap);
    const bwMHz = num(txp.transponderBandwidth);
    const allocBWkHz = allocBWofSeg(seg);
    const power = (cap === null || !isFinite(cap)) ? null : Math.pow(10, -cap / 10) * 100;
    const band = (allocBWkHz > 0 && bwMHz > 0) ? (allocBWkHz / (bwMHz * 1000)) * 100 : null;
    const maxCarriers = (power > 0 && band > 0) ? Math.floor(Math.min(100 / power, 100 / band)) : null;
    const op = opPointOf(txp);
    const arrivalPFD = pfd ? pfd.value : null;
    txpUse.push({
      nodeIndex, name: txp.name || '', capacity: cap, power, band, maxCarriers, outEirp, bwMHz, allocBWkHz,
      sfds: op ? op.sfds : null, opPFD: op ? op.opPFD : null, arrivalPFD
    });
    if (outEirp !== null) {
      // cap 非空 ⇒ opPointOf 必非空（capacityOf 就是拿它算的），无需再判
      ledger.push({ kind: 'txphd', seg, tag: '透明转发', name: txp.name || '' });
      // ① 来波：到达载波电平 C（各向同性口径，与上一跳末尾同一个数）除以各向同性天线的等效
      //    面积 λ²/4π —— 取对数即加 10·lg(4π/λ²)。
      ledger.push({ kind: 'base', seg, label: '到达载波电平 C', value: pfd.c, unit: 'dBW' });
      ledger.push({ kind: 'gain', seg, label: '卫星天线单位面积增益', value: pfd.uag, unit: 'dB' });
      ledger.push({ kind: 'sub', seg, label: '到达通量密度', value: arrivalPFD, unit: 'dBW/m²' });
      // ② G/T 归一为 0（参考 G/T 就是本星 G/T，或两者都没填）时不摆那一行空账：标称即饱和值，
      // 单独一行 base 起头就够。
      if (Math.abs(op.gtNorm) >= 0.005) {
        ledger.push({ kind: 'base', seg, label: '卫星 SFD（标称）', value: op.sfdRef, unit: 'dBW/m²' });
        ledger.push({ kind: 'loss', seg, label: 'G/T 差（卫星 − 参考）', value: op.gtNorm, unit: 'dB' });
        ledger.push({ kind: 'sub', seg, label: '饱和通量密度 SFD', value: op.sfds, unit: 'dBW/m²' });
      } else {
        ledger.push({ kind: 'base', seg, label: '饱和通量密度 SFD', value: op.sfds, unit: 'dBW/m²' });
      }
      ledger.push({ kind: 'loss', seg, label: '输入回退 IBO', value: op.boi, unit: 'dB' });
      ledger.push({ kind: 'sub', seg, label: '转发器工作点通量密度', value: op.opPFD, unit: 'dBW/m²' });
      // ③ 差多少（减数即 ① 算出的那个数）
      ledger.push({ kind: 'loss', seg, label: '到达通量密度', value: arrivalPFD, unit: 'dBW/m²' });
      ledger.push({ kind: 'sub', seg, label: '载波占转发器回退', value: cap, unit: 'dB' });
      // 功率 / 带宽占比不进这条电平链（它们是这台转发器的资源账、不是 dB 加减的一环），
      // 只在右侧「透明转发器占用」段出（transponders[].powerRatioResult / bandwidthRatioResult）。
      ledger.push({ kind: 'base', seg, label: '转发器输出 EIRP（每载波）', value: outEirp, unit: 'dBW' });
    }
    return outEirp;
  }
  // 透明星缺参就地报因：noteTxp 拿不出出发电平时，真凶是这颗星而不是上游的发信站——
  // 让它一路走到下一跳的「段起点电平缺失」再报，文案会张冠李戴（功放好好的却被点名）。
  //   capacity 缺（SFD / G/T / 到达通量密度算不出）⇒ 连工作点都定不下来；
  //   capacity 有值而电平仍缺 ⇒ 差的是饱和 EIRP。
  const txpLackMsg = (txp, cap) => ((cap === null || cap === undefined || !isFinite(cap))
    ? `透明星『${txp.name || ''}』缺 SFD 或 G/T，无法确定转发器工作点`
    : `透明星『${txp.name || ''}』缺饱和 EIRP，无法确定转发器输出电平`);
  for (let s = 0; s < segRanges.length; s++) {
    const { from, to } = segRanges[s];
    const startNode = nodes[from], endNode = nodes[to];
    const segHops = hops.slice(from, to);
    // 段内是否含透明星（含 ⇒ 弯管干扰口径；不含 ⇒ 必为单 hop 段，走再生直接合并口径）
    let hasTxp = false;
    for (let i = from + 1; i < to; i++) if (nodes[i].kind === 'txp') hasTxp = true;

    ledger.push({ kind: 'seghd', seg: s, tag: '段', no: s + 1, name: `${startNode.name || ''} → ${endNode.name || ''}` });

    // 段起点电平（dBW EIRP）
    let level = null;
    const segFirstHopType = segHops[0] && segHops[0].type;
    if (startNode.kind === 'es') {
      const h0 = segHops[0];
      level = h0 ? h0.txEirp : null;                    // 引擎按功放 W 算出的地球站 EIRP
      if (level !== null) {
        // 发信站 EIRP 的来处逐项摊开（口径同 GEO/NGSO/再生式三窗的发射链级联）：
        //   功放输出功率 − 功放回退 − 馈线损耗 + 发射天线增益 = 地球站 EIRP
        // 四项齐全才摊开；缺任一项（老结果 / 非常规入参）退回单行 EIRP，绝不摊出一条对不上的账。
        // ★ 级联列只留算式行：口径 / 效率 / 功放瓦数 / UPC 补偿这四个不进这条加减链的量已移到
        //   右侧「收发链参数」段（hops[].txDiameterResult 一族）——它们是设备参数，不是电平账。
        const det = h0 && [h0.paDbW, h0.paBackoffDb, h0.feederLoss, h0.txAntennaGain].every((v) => v !== null && v !== undefined && isFinite(v));
        if (det) {
          ledger.push({ kind: 'eshd', seg: s, tag: '发信站', name: startNode.name || '' });
          ledger.push({ kind: 'base', seg: s, label: '功放输出功率', value: h0.paDbW, unit: 'dBW', node: startNode.name });
          ledger.push({ kind: 'loss', seg: s, label: '功放回退', value: h0.paBackoffDb, unit: 'dB' });
          ledger.push({ kind: 'loss', seg: s, label: '馈线损耗', value: h0.feederLoss, unit: 'dB' });
          ledger.push({ kind: 'gain', seg: s, label: '发射天线增益', value: h0.txAntennaGain, unit: 'dBi' });
          ledger.push({ kind: 'sub', seg: s, label: '发信站 EIRP', value: level, unit: 'dBW', node: startNode.name });
        } else {
          ledger.push({ kind: 'base', seg: s, label: '发信站 EIRP', value: level, unit: 'dBW', node: startNode.name });
        }
      }
    } else {
      level = num(startNode.eirp);                      // 卫星起点：手填该载波直发 EIRP
      // 出段第一跳为星间跳时不记这一行：星间 EIRP/G·T 手填在跳上（口径同再生式星间），
      // 星的下行 EIRP 不进这一段的电平账——记了就是一行不进任何算式的数，级联列在它这儿断链。
      if (segFirstHopType !== 'isl' && segFirstHopType !== 'laser') {
        // 链首卫星＝载波在星上发起（区别于链中部的再生转接），标签跟着位置走
        ledger.push({ kind: 'base', seg: s, label: from === 0 ? '发射卫星 EIRP' : '再生卫星 EIRP', value: level, unit: 'dBW', node: startNode.name });
      }
    }

    const cnParts = [];
    // 「载波占转发器回退」capacity：属于透明星这一颗，不属于某一跳——由进入该星的那一跳按
    // 到达通量密度算出，随后被它的【上行侧干扰折算】与【出发电平变换】与【下行侧干扰折算】
    // 三处共用。曾在下行跳按「到达地面电平」重算过一次，那个数是地面的、与转发器无关，
    // 会把下行干扰折算整整错开二十几 dB（下行 C/N 与弯管引擎对不上即此故）。
    let curCapacity = null;
    for (let k = 0; k < segHops.length; k++) {
      const rec = segHops[k];
      const nodeIdx = from + k;
      const rxNode = nodes[nodeIdx + 1];
      if (rec.type === 'up' || rec.type === 'down') {
        // —— 电平递推 ——
        ledger.push({ kind: 'hophd', seg: s, tag: rec.type === 'up' ? '星地上行' : '星地下行', name: `${rec.fromName} → ${rec.toName}` });
        if (level === null) {
          return {
            success: false,
            message: startNode.kind === 'es'
              ? `段 ${s + 1} 起点电平缺失（发信站「${startNode.name || ''}」功放功率无效）`
              : `段 ${s + 1} 起点电平缺失（卫星「${startNode.name || ''}」须填下行 EIRP）`
          };
        }
        // 传播项三行：FSL 与雨衰各占一行（前者是几何、后者是这条链的可用度代价，都要单看），
        // 大气 / 云 / 附加三项合并成「其他传播衰减」一行——它们在工程上是同一类小额常态损耗，
        // 逐项摆开只是把级联列拉长两行，分项数值照旧在右侧「逐跳几何与时延」段逐条可查。
        // ★ 只并显示、不并计算：arrive 仍按原式逐项相减，出参逐位不变。
        ledger.push({ kind: 'loss', seg: s, label: '自由空间损耗', value: rec.fsl, unit: 'dB' });
        ledger.push({ kind: 'loss', seg: s, label: '雨衰 P.618', value: rec.rain, unit: 'dB' });
        ledger.push({ kind: 'loss', seg: s, label: '其他传播衰减', value: rec.atm + rec.cloud + rec.misc, unit: 'dB' });
        const arrive = level - rec.fsl - rec.atm - rec.rain - rec.cloud - rec.misc;
        ledger.push({ kind: 'chk', seg: s, label: '到达载波电平 C', value: arrive, unit: 'dBW' });
        // —— 接收 G/T ——
        const gtRx = (rec.type === 'up') ? rec.gtSat : (rec.gt - rec.gtDeg);
        if (rec.type === 'up') {
          ledger.push({ kind: 'gain', seg: s, label: '卫星 G/T', value: rec.gtSat, unit: 'dB/K' });
        } else {
          // 收信站段只留两行算式：G/T 与它的降雨劣化。G/T 的来处（天线增益 − 系统噪温(dB) −
          // 馈线损耗，噪温再拆成天线/接收机/雨/云四项）不进这条加减链——引擎各出参各自 toFixed(2)，
          // 三项相减与合成值可差 0.01 dB，接进级联这一列从上到下手算就会与权威检查点对不上，
          // 而「逐行可手算」是本表的硬要求（见 waterfallBuilder 的 _cascadeSingleSeg）。
          // 十项分解移到右侧「收发链参数」段（hops[].rxAntennaGainResult 一族），一个数不丢。
          ledger.push({ kind: 'eshd', seg: s, tag: '收信站', name: rec.toName || '' });
          ledger.push({ kind: 'gain', seg: s, label: '接收站 G/T', value: rec.gt, unit: 'dB/K' });
          ledger.push({ kind: 'loss', seg: s, label: 'G/T 劣化（降雨）', value: rec.gtDeg, unit: 'dB' });
        }
        // −k 与 −10·lgB 合成一行：两者都是把 C/T 换算成 C/N 的常量项，中间那个 C/N₀ 检查点本表
        // 从来不摆（摆了也只是个过路数），拆两行读者要多跟一行才走到本跳 C/N。
        ledger.push({ kind: 'gain', seg: s, label: '−k − 10·lgB', value: kMinusBw(rec.noiseBW), unit: 'dB' });
        const thermal = arrive + gtRx - BOLTZMANN - rec.noiseBW;
        rec.thermalCN = thermal;
        ledger.push({ kind: 'chk', seg: s, label: '本跳 C/N（热噪声）', value: thermal, unit: 'dB' });
        // —— 上行进透明星：先按到达通量密度定下这颗星的 capacity（本跳上行干扰与下一跳出发电平共用）——
        let pfd = null;
        if (rec.type === 'up' && rxNode && rxNode.kind === 'txp') {
          pfd = pfdOf(arrive, rec.freq);
          rec.arrivalPFD = pfd.value;
          curCapacity = capacityOf(rxNode, rec.arrivalPFD);
        }
        // —— 弯管段：本跳干扰按转发器占比折算入账（上行取接收星、下行取发射星，capacity 同一个）——
        let hopCN = thermal;
        const txp = (rec.type === 'up') ? rxNode : nodes[nodeIdx];
        if (hasTxp && txp && txp.kind === 'txp' && curCapacity !== null) {
          rec.capacity = curCapacity;
          const ci = bentPipeCI(txp, rec, curCapacity);
          rec.intfCI = ci.total;
          if (ci.total !== null) {
            hopCN = -10 * Math.log10(Math.pow(10, -thermal / 10) + Math.pow(10, -ci.total / 10));
            ledger.push({ kind: 'loss', seg: s, label: '干扰损失 ACI/ASI/XPI/IM', value: thermal - hopCN, unit: 'dB' });
            ledger.push({ kind: 'chk', seg: s, label: '本跳 C/(N+I)', value: hopCN, unit: 'dB' });
          }
        }
        rec.cn = hopCN;
        cnParts.push(hopCN);
        // —— 透明节点：转发器变换出发电平（供下一跳）——
        if (rec.type === 'up' && rxNode && rxNode.kind === 'txp') {
          level = noteTxp(rxNode, nodeIdx + 1, s, curCapacity, pfd);
          if (level === null) return { success: false, message: txpLackMsg(rxNode, curCapacity) };
        } else {
          level = null;                                   // 段在此结算（再生节点 / 收信站）
          if (rec.type === 'down') curCapacity = null;    // 已落地，上游透明星的回退量到此为止
        }
      } else {
        // —— 星间 hop：EIRP/G·T 手填，不由上游电平递推（口径同再生式窗口星间链路群）——
        ledger.push({ kind: 'hophd', seg: s, tag: rec.type === 'laser' ? '星间激光' : '星间微波', name: `${rec.fromName} → ${rec.toName}` });
        if (rec.type === 'isl') {
          ledger.push({ kind: 'base', seg: s, label: '星间发射 EIRP', value: rec.islEirp, unit: 'dBW' });
          ledger.push({ kind: 'loss', seg: s, label: '自由空间损耗', value: rec.fsl, unit: 'dB' });
          ledger.push({ kind: 'gain', seg: s, label: '星间接收 G/T', value: rec.islGT, unit: 'dB/K' });
          ledger.push({ kind: 'loss', seg: s, label: '附加损耗', value: rec.misc, unit: 'dB' });
          ledger.push({ kind: 'gain', seg: s, label: '−k − 10·lgB', value: kMinusBw(rec.noiseBW), unit: 'dB' });
          // 这一行记【热噪】：星间干扰与（发射端为透明星时的）转发器互调各自摊成「损失 + 检查点」
          // 一对接在其后，逐行可手算。两者都没有时热噪即本跳 C/N，这一行逐字与从前相同。
          ledger.push({ kind: 'chk', seg: s, label: '本跳 C/N', value: rec.thermalCN, unit: 'dB' });
          // —— 星间干扰 C/I（本跳手填的聚合项）：并联已由引擎做掉（computeRegenIslMode），这里只摊代价 ——
          if (rec.islCI !== null && rec.thermalCN !== null && rec.cn !== null) {
            ledger.push({ kind: 'loss', seg: s, label: '干扰损失 星间C/I', value: rec.thermalCN - rec.cn, unit: 'dB' });
            ledger.push({ kind: 'chk', seg: s, label: '本跳 C/(N+I)', value: rec.cn, unit: 'dB' });
          }
          // —— 本跳发射端为透明星：它的转发器互调按它自己的工作点折算入账 ——
          // 一段串多颗透明星时每颗都有自己的干扰账：ACI/ASI/XPI 是路径机制（地面路径那两套已在
          // 进星上行四项 / 出星下行四项的边界星入账，星间路径按平台口径无干扰项、不重复计同一批
          // 相邻载波），互调则是每颗透明星自己 TWTA 新生的噪声、随信号走到底——漏记即
          // 「多透明星段只按一颗星的 C/I 评估」（发射端出星间跳时它的下行四项从不入账，互调整个丢掉）。
          // curCapacity 此刻仍是【本跳发射星】的回退量（下方才被接收星的覆盖），顺序不可倒。
          const txSat = nodes[nodeIdx];
          if (txSat && txSat.kind === 'txp' && curCapacity !== null && rec.cn !== null && rec.noiseBW !== null) {
            const imCI = txpIslImCI(txSat, rec, curCapacity);
            if (imCI !== null) {
              const merged = -10 * Math.log10(Math.pow(10, -rec.cn / 10) + Math.pow(10, -imCI / 10));
              ledger.push({ kind: 'loss', seg: s, label: '干扰损失 转发器IM', value: rec.cn - merged, unit: 'dB' });
              ledger.push({ kind: 'chk', seg: s, label: '本跳 C/(N+I)', value: merged, unit: 'dB' });
              // 出参的「本跳干扰」是这一跳所有干扰源的合计：星间 C/I（若填了）与本星互调线性相加
              rec.intfCI = cascadeCN([rec.intfCI, imCI]);
              rec.cn = merged;
            }
          }
          // 后续若接透明星：到达载波电平 = 星间 EIRP − FSL − 附加损耗
          const arriveIsl = rec.islEirp - rec.fsl - rec.misc;
          const pfdIsl = pfdOf(arriveIsl, rec.freq);
          rec.arrivalPFD = pfdIsl.value;
          if (rxNode && rxNode.kind === 'txp') {
            const cap = capacityOf(rxNode, rec.arrivalPFD);
            curCapacity = cap;
            rec.capacity = cap;
            level = noteTxp(rxNode, nodeIdx + 1, s, cap, pfdIsl);
            if (level === null) return { success: false, message: txpLackMsg(rxNode, cap) };
          } else { level = null; curCapacity = null; }
        } else {
          // 激光：MathWorks 简化功率链只出「接收光功率 − 所需接收功率」的余量，没有 C/N——
          // 就以 P_rx 对 P_req 结算，不硬借射频门限造一个「等效 C/N」（曾经那样做，代价是
          // 全激光链取不到门限被整条挡掉，而门限在余量里本就严格抵消，是一个多余的中间量）。
          // 两端必为再生类由结构校验保证 ⇒ 本跳独占一段，段结算处按纯激光段走（见下）。
          ledger.push({ kind: 'base', seg: s, label: '接收光功率 P_rx', value: rec.prx, unit: 'dBm' });
          ledger.push({ kind: 'ref', seg: s, label: '所需接收功率 P_req', value: rec.preq, unit: 'dBm' });
          level = null;
        }
        cnParts.push(rec.cn);
      }
    }

    // —— 段结算 ——
    const demodLoss = numOr(endNode.demodLossDb, 0);
    // 纯激光段：段内唯一那一跳是星间激光（结构校验里「激光跳两端必为再生类」保证了只有这一种
    // 形态，激光跳不会与射频跳同段）。光链没有 C/N，直接以接收光功率对所需接收功率结算：
    //   段余量 = 光链余量(P_rx − P_req) − 解调实现损失
    // 与旧的「借射频门限造等效 C/N」在代数上恒等（(thr+LM) − (thr+demod)），门限严格抵消，
    // 故混合链里激光段的段余量逐位不变；变的只是不再为光链硬造一个 C/N 与门限。
    if (segHops.length === 1 && segHops[0].type === 'laser') {
      const rec0 = segHops[0];
      const lm = (rec0.laserMargin === null || rec0.laserMargin === undefined) ? null : rec0.laserMargin;
      const preqEff = (rec0.preq === null || rec0.preq === undefined) ? null : (rec0.preq + demodLoss);
      const margin = (lm === null) ? null : (lm - demodLoss);
      if (demodLoss) {
        ledger.push({ kind: 'eshd', seg: s, tag: '解调', name: endNode.name || '' });
        ledger.push({ kind: 'ref', seg: s, label: '解调实现损失', value: demodLoss, unit: 'dB' });
        ledger.push({ kind: 'ref', seg: s, label: '实际所需接收功率', value: preqEff, unit: 'dBm' });
      }
      ledger.push({ kind: 'margin', seg: s, label: '段余量', value: margin, unit: 'dB' });
      segments.push({
        index: s, fromIndex: from, toIndex: to,
        fromName: startNode.name || '', toName: endNode.name || '',
        hopIndexes: segHops.map((r) => r.index),
        bentPipe: false, laser: true,
        // 光链没有 C/N / 门限：这三项一律留空，不硬造数
        thermalCN: null, interferenceCN: null, cn: null, margin,
        threshold: null, thresholdEff: null, demodLoss, echo: segEcho[s] || null,
        prx: (rec0.prx === undefined ? null : rec0.prx), preq: (rec0.preq === undefined ? null : rec0.preq), preqEff,
        berExp: num(segCarrier(s).ber)
      });
      continue;
    }
    const thermalSeg = cascadeCN(cnParts);
    let segCN = thermalSeg;
    let segCI = null;
    if (!hasTxp && thermalSeg !== null) {
      // 再生结算点：直接合并口径（Σ 10^(−C/I/10) 与热噪并联），照 linkCalculatorRegen._regenIntfLinear
      const rec0 = segHops[0];
      const lin = directMergeIntfLinear(nodes, from, to, rec0);
      if (lin > 0) {
        segCI = -10 * Math.log10(lin);
        segCN = -10 * Math.log10(Math.pow(10, -thermalSeg / 10) + lin);
      }
    }
    // 门限取【本段自己的载波体制】：再生节点重新调制之后，下游段的门限本就与上游不同。
    // 实际解调门限还要加上【段末节点】那台解调器的实现损失——解调是收端的事，故它挂在收端节点上。
    const segThr = thrOfSeg(s);
    const thrEff = segThr + demodLoss;
    const margin = (segCN === null) ? null : (segCN - thrEff);
    // 多跳段：段 C/N 是各跳 C/N 的倒数和，不是最后一跳那个数——补一行「并联代价」让这一列
    // 从上到下仍能逐行手算（末跳 C/N − 并联代价 = 段 C/N）。
    const lastCN = cnParts.length ? cnParts[cnParts.length - 1] : null;
    if (cnParts.length > 1 && thermalSeg !== null && lastCN !== null) {
      ledger.push({ kind: 'loss', seg: s, label: '多跳级联损失（前序跳并联）', value: lastCN - thermalSeg, unit: 'dB' });
    }
    if (thermalSeg !== null && segCN !== null && Math.abs(thermalSeg - segCN) > 1e-9) {
      ledger.push({ kind: 'loss', seg: s, label: '段干扰损失（直接合并）', value: thermalSeg - segCN, unit: 'dB' });
    }
    ledger.push({ kind: 'sub', seg: s, label: '段 C/(N+I)', value: segCN, unit: 'dB' });
    ledger.push({ kind: 'ref', seg: s, label: '门限 C/N', value: segThr, unit: 'dB' });
    if (demodLoss) {
      ledger.push({ kind: 'eshd', seg: s, tag: '解调', name: endNode.name || '' });
      ledger.push({ kind: 'ref', seg: s, label: '解调实现损失', value: demodLoss, unit: 'dB' });
      ledger.push({ kind: 'ref', seg: s, label: '实际解调门限', value: thrEff, unit: 'dB' });
    }
    ledger.push({ kind: 'margin', seg: s, label: '段余量', value: margin, unit: 'dB' });

    segments.push({
      index: s, fromIndex: from, toIndex: to,
      fromName: startNode.name || '', toName: endNode.name || '',
      hopIndexes: segHops.map((r) => r.index),
      bentPipe: hasTxp,
      thermalCN: thermalSeg, interferenceCN: segCI, cn: segCN, margin,
      threshold: segThr, thresholdEff: thrEff, demodLoss, echo: segEcho[s] || null,
      // 本段的设计误码率（该段体制里那个 10⁻ⁿ）：端到端按各段之和累加
      berExp: num(segCarrier(s).ber)
    });
  }

  // ============ 端到端汇总 ============
  let weakest = -1, weakestMargin = null;
  for (const sg of segments) {
    if (sg.margin === null) continue;
    if (weakestMargin === null || sg.margin < weakestMargin) { weakestMargin = sg.margin; weakest = sg.index; }
  }
  // 系统可用度 = 各星地 hop 站址可用度之积（星间 hop 不参与——真空无雨，手动距离下也无互视统计）
  let availPct = null;
  for (const rec of hops) {
    if (rec.type !== 'up' && rec.type !== 'down') continue;
    if (rec.availability === null || rec.availability === undefined) continue;
    availPct = (availPct === null) ? rec.availability : (availPct * rec.availability / 100);
  }
  // 端到端 BER = Σ 各段设计 BER（各段独立解调，误码一旦产生下游无法恢复；低误码率下直接相加）。
  // 只取「设计值」不外推余量对应的实际误码率——本平台没有 BER-C/N 曲线，编一条曲线出来的数
  // 比没有更危险（编码波形的瀑布区陡峭，形状因 MODCOD 而异）。
  let berSum = 0, berAll = true;
  for (const sg of segments) {
    if (sg.berExp === null || !isFinite(sg.berExp)) { berAll = false; break; }
    berSum += Math.pow(10, -Math.abs(sg.berExp));
  }
  // 端到端时延 = Σ hop 传播时延 + Σ 再生类节点处理时延
  let delayMs = 0;
  for (const rec of hops) delayMs += rec.delayMs;
  let procMs = 0;
  for (let i = 1; i < N - 1; i++) if (isRegenClass(nodes[i], i, N)) procMs += numOr(nodes[i].procDelayMs, 0);
  delayMs += procMs;

  // ============ 出参（字符串，toFixed 口径与现有引擎一致）============
  const data = {
    linkType: 'chain',
    nodeCount: N,
    hopCount: N - 1,
    segmentCount: segments.length,
    // 链级门限取【最弱段】那一份：它与 carrierTotalCN / e2eMarginResult 同段，三者自洽
    // （余量 = C/N − 门限）。各段体制不同时，单一「链级门限」本就没有意义，故不取首段。
    thresholdCN: fx(weakest >= 0 ? segments[weakest].threshold : thresholdCN, 2),
    e2eMarginResult: fx(weakestMargin, 2),
    weakestSegment: weakest >= 0 ? (weakest + 1) : '',
    systemAvailabilityResult: fx(availPct, 5),
    e2eDelayResult: fx(delayMs, 3),
    procDelayResult: fx(procMs, 3),
    propDelayResult: fx(delayMs - procMs, 3),
    interruptionMinutes: availPct === null ? '' : fx((100 - availPct) / 100 * 365.25 * 24 * 60, 2),
    interruptionHours: availPct === null ? '' : fx((100 - availPct) / 100 * 365.25 * 24, 2),
    // 载波体制回显（首段体制，取自其射频 hop 的引擎出参；逐段体制另见 carriers[]）
    RXnoiseBW: fx(noiseBWdB, 2),
    // 端到端 BER（各段设计值之和；比特透传，误码不可恢复）
    e2eBerResult: berAll ? berStr(berSum) : '',
    segmentBerResult: berAll ? segments.map((sg) => berStr(Math.pow(10, -Math.abs(sg.berExp)))).join(' + ') : '',
    // 逐段载波体制（再生节点之后可换调制：段与段的门限 / 带宽 / 速率各不相同）
    carriers: segments.map((sg) => Object.assign({
      segIndex: sg.index, no: sg.index + 1, fromName: sg.fromName, toName: sg.toName,
      thresholdCN: fx(sg.threshold, 2), thresholdEffResult: fx(sg.thresholdEff, 2),
      demodLossResult: fx(sg.demodLoss, 2), RXnoiseBW: fx(bwOfSeg(sg.index), 2)
    }, sg.echo || null)),
    // 逐颗透明星的转发器占用（nodeIndex 指回链上的节点下标，供链路条画占比条）
    transponders: txpUse.map((t) => ({
      nodeIndex: t.nodeIndex, name: t.name,
      sfdsResult: fx(t.sfds, 2),
      opPFDResult: fx(t.opPFD, 2),
      arrivalPFDResult: fx(t.arrivalPFD, 2),
      capacityResult: fx(t.capacity, 2),
      powerRatioResult: fx(t.power, 2),
      bandwidthRatioResult: fx(t.band, 2),
      eirpPerCarrierResult: fx(t.outEirp, 2),
      transponderBandwidthResult: fx(t.bwMHz, 2),
      carrierBandwidthResult: fx(t.allocBWkHz, 3),
      maxCarrierCount: t.maxCarriers === null ? '' : String(t.maxCarriers)
    })),
    hops: hops.map((r) => ({
      index: r.index, type: r.type, fromName: r.fromName, toName: r.toName,
      frequencyResult: r.freq === null || r.freq === undefined ? '' : fx(num(r.freq), 4),
      distanceResult: fx(r.distanceKm, 2),
      delayResult: fx(r.delayMs, 3),
      fslResult: fx(r.fsl, 2),
      atmResult: fx(r.atm, 2),
      rainResult: fx(r.rain, 2),
      cloudResult: fx(r.cloud, 2),
      miscResult: fx(r.misc, 2),
      elevationResult: r.elevation === null || r.elevation === undefined ? '' : fx(num(r.elevation), 2),
      availabilityResult: fx(r.availability, 5),
      gtResult: fx(r.type === 'up' ? r.gtSat : (r.type === 'down' ? r.gt : r.islGT), 2),
      gtDegResult: fx(r.gtDeg, 2),
      capacityResult: fx(r.capacity === undefined ? null : r.capacity, 2),
      arrivalPFDResult: fx(r.arrivalPFD === undefined ? null : r.arrivalPFD, 2),
      // —— 收发链设备参数（纯回显，不进任何计算）——
      // 级联列只留算式行之后，这些量由右侧「收发链参数」段承接（waterfallBuilder.buildChain）。
      // 小数位照各自引擎出参的口径（口径/增益/噪温 2 位、效率 0 位、功放瓦数 3 位）。
      txDiameterResult: fx(r.txDiameter === undefined ? null : r.txDiameter, 2),
      txEffResult: fx(r.txEff === undefined ? null : r.txEff, 0),
      paWResult: fx(r.paW === undefined ? null : r.paW, 3),
      upcMarginResult: fx(r.upcMargin === undefined ? null : r.upcMargin, 2),
      rxDiameterResult: fx(r.rxDiameter === undefined ? null : r.rxDiameter, 2),
      rxEffResult: fx(r.rxEff === undefined ? null : r.rxEff, 0),
      rxAntennaGainResult: fx(r.rxAntennaGain === undefined ? null : r.rxAntennaGain, 2),
      rxFeederLossResult: fx(r.rxFeederLoss === undefined ? null : r.rxFeederLoss, 2),
      antennaNoiseTempResult: fx(r.antennaNoiseTemp === undefined ? null : r.antennaNoiseTemp, 2),
      receiverNoiseTempResult: fx(r.receiverNoiseTemp === undefined ? null : r.receiverNoiseTemp, 2),
      rainNoiseTempResult: fx(r.rainNoiseTemp === undefined ? null : r.rainNoiseTemp, 2),
      cloudNoiseTempResult: fx(r.cloudNoiseTemp === undefined ? null : r.cloudNoiseTemp, 2),
      sysNoiseTempKResult: fx(r.sysNoiseTempK === undefined ? null : r.sysNoiseTempK, 2),
      sysNoiseTempDbResult: fx(r.sysNoiseTempDb === undefined ? null : r.sysNoiseTempDb, 2),
      thermalCNResult: fx(r.thermalCN === undefined ? null : r.thermalCN, 2),
      interferenceCNResult: fx(r.intfCI === undefined ? null : r.intfCI, 2),
      // 激光跳：没有 C/N（cnResult 留空），出的是光功率链那三个数
      prxResult: fx(r.prx === undefined ? null : r.prx, 2),
      preqResult: fx(r.preq === undefined ? null : r.preq, 2),
      laserMarginResult: fx(r.laserMargin === undefined ? null : r.laserMargin, 2),
      cnResult: fx(r.cn, 2)
    })),
    segments: segments.map((sg) => ({
      index: sg.index, no: sg.index + 1,
      fromName: sg.fromName, toName: sg.toName,
      hopIndexes: sg.hopIndexes, bentPipe: sg.bentPipe,
      // 纯激光段：C/N / 门限 / 实际门限一律空串，出的是 P_rx 对 P_req 那一套
      laser: sg.laser === true,
      prxResult: fx(sg.prx === undefined ? null : sg.prx, 2),
      preqResult: fx(sg.preq === undefined ? null : sg.preq, 2),
      preqEffResult: fx(sg.preqEff === undefined ? null : sg.preqEff, 2),
      thermalCNResult: fx(sg.thermalCN, 2),
      interferenceCNResult: fx(sg.interferenceCN, 2),
      cnResult: fx(sg.cn, 2),
      thresholdCN: fx(sg.threshold, 2),
      demodLossResult: fx(sg.demodLoss, 2),
      thresholdEffResult: fx(sg.thresholdEff, 2),
      berResult: (sg.berExp === null || !isFinite(sg.berExp)) ? '' : berStr(Math.pow(10, -Math.abs(sg.berExp))),
      marginResult: fx(sg.margin, 2),
      weakest: sg.index === weakest
    })),
    // 端到端级联瀑布的机读行（waterfallBuilder 的 E2E 构建器消费；值为数值，展示格式在那边定）
    ledger
  };
  if (carrierEcho) Object.assign(data, carrierEcho);
  // 通用字段别名：结果列/汇总卡与三窗同名取数
  data.linkmargin = data.e2eMarginResult;
  data.marginResult = data.e2eMarginResult;
  data.carrierTotalCN = fx(weakest >= 0 ? segments[weakest].cn : null, 2);
  data.linkDelayResult = data.e2eDelayResult;
  // 注：不出「链级功率/带宽占比」。占比是【某一颗透明星】的资源账（这条载波在那台转发器上
  // 占了多少），链上有几颗星就有几份，取最大值当"链的占比"是编出来的指标，也不是端到端参数。
  // 逐颗的数在 transponders[] 里，各归各位。

  return { success: true, data };
}

// ============ 单跳物理量探针 ============
// 卫星天线单位面积增益 10·lg(4π/λ²)（与 NGSO 引擎 antennaGain 同式；把到达载波电平换算成通量密度）
function unitAreaGain(freqGHz) {
  if (!(freqGHz > 0)) return null;
  const lambda = 0.299792458 / freqGHz;
  return 10 * Math.log10(4 * Math.PI / (lambda * lambda));
}

// 到达通量密度 = 到达载波电平 C（各向同性口径，未加卫星天线增益）+ 单位面积增益。
// 等价于 EIRP − 10·lg(4πd²)，走这条路是为了把大气/雨/云/附加损耗一并带进来（当前工况，非晴空）。
// 三个数一起返回：级联台账要把这一步摊成「C + 单位面积增益 = 通量密度」三行。
// 频率取不到时整个返 null，绝不把缺失的单位面积增益当 0 dB 加进去（那会静默错四十几 dB）。
function pfdOf(levelC, freqGHz) {
  const uag = unitAreaGain(num(freqGHz));
  const ok = uag !== null && levelC !== null && levelC !== undefined && isFinite(levelC);
  return { c: ok ? levelC : null, uag, value: ok ? levelC + uag : null };
}

// 转发器工作点（这台转发器等着多强的来波）：SFD 标称值按「参考 G/T → 本星 G/T」归一成饱和
// 通量密度 SFDs，再减输入回退 IBO。逐项都要摆到级联台账上（见 noteTxp），故不只出一个数：
//   SFDs   = 有效 SFDref − 卫星 G/T = SFD标称 − (卫星 G/T − 参考 G/T)
//   工作点 = SFDs − IBO
// 有效 SFDref = SFDref + 参考 G/T 是三窗一致的入口换算（参考 G/T 为 0/空时原样）。
function opPointOf(txp) {
  const sfd = num(txp.sfdRef), gtRef = num(txp.sfdGtRef), gt = num(txp.gt);
  if (sfd === null || gt === null) return null;
  // ★ sfds 保持原式的运算次序（sfdEff − gt），别改写成 sfd − (gt − gtRef)：两式实数相等、
  //   浮点末位可差一个 ULP，而这颗回退量下游要与弯管引擎逐位对表。归一量反过来由它倒推，
  //   台账上「标称 − 归一 = 饱和」于是按构造闭合。
  const sfdEff = gtRef ? sfd + gtRef : sfd;
  const sfds = sfdEff - gt;
  const boi = numOr(txp.BOi, 6);
  return { sfdRef: sfd, gtNorm: sfd - sfds, sfds, boi, opPFD: sfds - boi };
}

// 载波在转发器工作点之下的回退量 capacity = SFDs − BOi − 到达通量密度（口径同 NGSO 引擎的
// transponderCapacity：PFDc = SFDs − BOi − capacity）。
// 入参是【到达该星的通量密度】，只由进入这颗星的那一跳算出——离开它的那一跳不得重算。
function capacityOf(txp, arrivalPFD) {
  const op = opPointOf(txp);
  if (op === null || arrivalPFD === null || !isFinite(arrivalPFD)) return null;
  return op.opPFD - arrivalPFD;
}

// 弯管口径的载波参考 C/I（四路）。见文件头 §A 的推导：
//   C/I_j(载波参考) = C/I_j(标称) − capacity + 10·lg(B_xpdr / B_noise)
// XPI 取已并入雨致去极化的 effectiveXpol*（与现有引擎同源）。
function bentPipeCI(txp, rec, capacity) {
  const out = { terms: [], total: null };
  if (capacity === null || rec.noiseBW === null) return out;
  const bwMHz = numOr(txp.transponderBandwidth, 36);
  if (!(bwMHz > 0)) return out;
  const bRatio = 10 * Math.log10(bwMHz * 1e6) - rec.noiseBW;
  const shift = -capacity + bRatio;
  const up = rec.type === 'up';
  const raw = up
    ? [num(txp.aciUplinkFactor) !== null ? num(txp.aciUplinkFactor) : 30,
      num(txp.adjUplinkFactor) !== null ? num(txp.adjUplinkFactor) : 25,
      rec.effXpol !== null && rec.effXpol !== undefined ? rec.effXpol : (num(txp.xpolUplinkFactor) !== null ? num(txp.xpolUplinkFactor) : 26),
      num(txp.hpaIntermodFactor) !== null ? num(txp.hpaIntermodFactor) : 24]
    : [num(txp.aciDownlinkFactor) !== null ? num(txp.aciDownlinkFactor) : 30,
      num(txp.adjDownlinkFactor) !== null ? num(txp.adjDownlinkFactor) : 25,
      rec.effXpol !== null && rec.effXpol !== undefined ? rec.effXpol : (num(txp.xpolDownlinkFactor) !== null ? num(txp.xpolDownlinkFactor) : 26),
      num(txp.xpdrIntermodFactor) !== null ? num(txp.xpdrIntermodFactor) : 21];
  out.terms = raw.map((v) => v + shift);
  const lin = sumLinear(out.terms);
  out.total = lin > 0 ? -10 * Math.log10(lin) : null;
  return out;
}

// 星间跳发射端为透明星时它的转发器互调 C/IM（载波参考）。折算式同 bentPipeCI 的单项：
//   C/IM(载波参考) = C/IM(标称) − 该星 capacity + 10·lg(该星 B_xpdr / B_noise)
// 只折互调这一项：它是这颗星自己 TWTA 新生的噪声（一段几颗透明星就有几份、各按各的工作点），
// ACI/ASI/XPI 是接收路径机制——地面侧已在边界星入账、星间侧按平台口径无干扰项，在此重复即双计。
function txpIslImCI(txp, rec, capacity) {
  if (capacity === null || rec.noiseBW === null || rec.noiseBW === undefined) return null;
  const bwMHz = numOr(txp.transponderBandwidth, 36);
  if (!(bwMHz > 0)) return null;
  const im = num(txp.xpdrIntermodFactor) !== null ? num(txp.xpdrIntermodFactor) : 21;
  return im - capacity + (10 * Math.log10(bwMHz * 1e6) - rec.noiseBW);
}

// 再生结算点的直接合并干扰（照 linkCalculatorRegen._regenIntfLinear）：
// 上行段取接收卫星的上行四项、下行段取发射卫星的下行四项、星间段无干扰项。
function directMergeIntfLinear(nodes, from, to, rec) {
  if (!rec) return 0;
  if (rec.type === 'up') {
    const sat = nodes[to];
    return sumLinear([
      num(sat.aciUplinkFactor), num(sat.adjUplinkFactor),
      (rec.effXpol !== null && rec.effXpol !== undefined) ? rec.effXpol : num(sat.xpolUplinkFactor),
      num(sat.hpaIntermodFactor)
    ]);
  }
  if (rec.type === 'down') {
    const sat = nodes[from];
    return sumLinear([
      num(sat.aciDownlinkFactor), num(sat.adjDownlinkFactor),
      (rec.effXpol !== null && rec.effXpol !== undefined) ? rec.effXpol : num(sat.xpolDownlinkFactor),
      num(sat.xpdrIntermodFactor)
    ]);
  }
  // 星间段：星地那四路一项不取（口径同再生式星间）。本跳自己的聚合 C/I（hop.islCI）已由引擎
  // 并联进该跳 C/N，进段时随 cnParts 一起过来，不在这里重复合并。
  return 0;
}

// 载波体制回显（从引擎结果摘出与链级体制相关的字段，供结果文档区「载波与调制」段）
function carrierEchoOf(d) {
  const keys = ['allocBandwidthResult', 'spectralEfficiencyResult', 'infoRateResult', 'carrierRateResult',
    'symbolRateResult', 'ChipRateResult', 'modulationResult', 'modulationFactorResult', 'fecResult',
    'berResult', 'ebnoResult', 'esnoResult'];
  const out = {};
  for (const k of keys) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

// 上行 hop 探针：功放 W → 引擎 power 模式 → 取上行侧全部物理量
function probeUpHop(chain, es, sat, hop, carrier) {
  const w = num(es.powerW);
  if (!(w > 0)) return { ok: false, message: `发信站「${es.name || ''}」功放功率无效` };
  const { satParams, linkParams } = buildUpHopParams(chain, es, sat, hop, carrier);
  const r = modeSolver.computeLinkModeNGSO(satParams, linkParams, { mode: 'power', powerW: w });
  if (!r || !r.success) return { ok: false, message: (r && r.message) || '引擎调用失败' };
  const d = r.data;
  return {
    ok: true,
    freq: hop.frequency, elevation: hop.elevation,
    txEirp: num(d.stationEIRPResult),
    // 发射链分解（供级联台账逐项摊开 EIRP）：功放输出 − 回退 − 馈线 + 天线增益 = EIRP
    // 回退取引擎的 totalPaBackoff（= 功放回退输入 + UPC 额外抬升），故这里按两个出参之差取，
    // 不读输入——UPC 自定义档下二者并不相等。
    txAntennaGain: num(d.txAntennaGainResult),
    txDiameter: num(d.earthAntennaDiameterResult),
    txEff: num(d.earthAntennaEfficiencyResult),
    paDbW: num(d.paRecommendationdBResult),
    paW: num(d.paRecommendation),
    paBackoffDb: (num(d.paRecommendationdBResult) === null || num(d.selectedPowerResult) === null)
      ? null : (num(d.paRecommendationdBResult) - num(d.selectedPowerResult)),
    feederLoss: num(d.feederLossResult),
    upcMargin: num(d.UPCmarginResult),
    fsl: numOr(d.uplinkFSLResult, 0),
    atm: numOr(d.uplinkAtmosphericAttenuationResult, 0),
    rain: numOr(d.uplinkRainAttenuation, 0),
    cloud: numOr(d.uplinkCloudAttenuation, 0),
    misc: numOr(d.uplinkMiscLossResult, 0),
    gtSat: numOr(d.satelliteGTResult, 0),
    gtDeg: 0,
    effXpol: num(d.effectiveXpolUplinkFactorResult),
    rainXPD: num(d.uplinkRainXPDResult),
    totalAtten: num(d.uplinkTotalAttenuationResult),
    scint: num(d.uplinkScintillationResult),
    availability: num(d.uplinkAvailabilityResult),
    noiseBW: num(d.RXnoiseBW),
    thresholdCN: num(d.thresholdCN),
    paDb: num(d.paRecommendationdBResult),
    carrier: carrierEchoOf(d)
  };
}

// 下行 hop 探针：只取下行侧物理量（工作点电平由本模块正向递推，不用引擎的反解功率）
function probeDnHop(chain, sat, es, hop, carrier) {
  const { satParams, linkParams } = buildDnHopParams(chain, sat, es, hop, carrier);
  const r = modeSolver.computeLinkModeNGSO(satParams, linkParams, { mode: 'margin' });
  if (!r || !r.success) return { ok: false, message: (r && r.message) || '引擎调用失败' };
  const d = r.data;
  return {
    ok: true,
    freq: hop.frequency, elevation: hop.elevation,
    fsl: numOr(d.downlinkFSLResult, 0),
    atm: numOr(d.downlinkAtmosphericAttenuationResult, 0),
    rain: numOr(d.downlinkRainAttenuationResult, 0),
    cloud: numOr(d.downlinkCloudAttenuation, 0),
    misc: numOr(d.downlinkMiscLossResult, 0),
    gt: numOr(d.gOverTeResult, 0),
    gtDeg: numOr(d.gOverTdegradationResult, 0),
    // 接收链分解（供级联台账逐项摊开 G/T）：G/T = 接收天线增益 − 系统噪声温度(dB) − 接收馈线损耗
    rxAntennaGain: num(d.rxAntennaGainResult),
    rxFeederLoss: num(d.rxFeederLossResult),
    rxDiameter: num(d.rxAntennaDiameterResult),
    rxEff: num(d.rxAntennaEfficiencyResult),
    sysNoiseTempK: num(d.systemNoiseTempKResult),
    sysNoiseTempDb: num(d.systemNoiseTempDbResult),
    antennaNoiseTemp: num(d.antennaNoiseTempResult),
    receiverNoiseTemp: num(d.receiverNoiseTempResult),
    rainNoiseTemp: num(d.rainNoiseTempResult),
    cloudNoiseTemp: num(d.cloudNoiseTempResult),
    effXpol: num(d.effectiveXpolDownlinkFactorResult),
    rainXPD: num(d.downlinkRainXPDResult),
    totalAtten: num(d.downlinkTotalAttenuationResult),
    scint: num(d.downlinkScintillationResult),
    availability: num(d.downlinkAvailabilityResult),
    noiseBW: num(d.RXnoiseBW),
    thresholdCN: num(d.thresholdCN),
    carrier: carrierEchoOf(d)
  };
}

// 星间微波 hop 探针：借再生式引擎（NGSO islMode='rf'/islHops=1）取单跳 C/N
function probeIslHop(chain, hop, carrier) {
  if (!_regen || !_regen.computeRegenIslMode) return { ok: false, message: '再生式引擎不可用（星间预算无法计算）' };
  const { satParams, linkParams } = buildIslHopParams(chain, hop, carrier);
  const r = _regen.computeRegenIslMode(satParams, linkParams, { visibilityPct: null });
  if (!r || !r.success) return { ok: false, message: (r && r.message) || '星间引擎调用失败' };
  const d = r.data;
  return {
    ok: true,
    freq: hop.frequency,
    islEirp: numOr(hop.islEirp, 45),
    islGT: numOr(hop.islGT, 12),
    fsl: numOr(d.islRfFslResult, 0),
    atm: 0, rain: 0, cloud: 0,
    misc: numOr(hop.miscLoss, 1),
    gtDeg: 0,
    availability: null,                 // 星间段不贡献可用度损失（手动距离下无互视统计）
    noiseBW: num(d.RXnoiseBW),
    thresholdCN: num(d.thresholdCN),
    // 星间干扰 C/I 由引擎并联进 islPerHopCN（留空即两者同值，逐位与从前相同），
    // 台账与出参要把热噪与合计分开摆，故两个数都取回来；intfCI 后续再与透明星互调合并。
    cn: num(d.islPerHopCNResult),
    thermalCN: num(d.islPerHopThermalCNResult),
    islCI: num(d.islCIResult),
    intfCI: num(d.islCIResult),
    carrier: carrierEchoOf(d)
  };
}

// 星间激光 hop 探针：借再生式光学引擎（MathWorks 简化功率链）。光链没有 C/N——只带出
// P_rx / P_req 与二者之差的光链余量，段结算处直接以它结算（见段结算的「纯激光段」分支）。
function probeLaserHop(chain, hop) {
  if (!_regen || !_regen.computeRegenLaserIslMode) return { ok: false, message: '再生式引擎不可用（激光星间无法计算）' };
  const p = Object.assign({}, hop.laser || {}, { islHopDistance: num(hop.rangeKm) });
  const r = _regen.computeRegenLaserIslMode(p, { visibilityPct: null, rangeRateKmS: null });
  if (!r || !r.success) return { ok: false, message: (r && r.message) || '激光引擎调用失败' };
  const d = r.data;
  const margin = num(d.linkmargin);
  return {
    ok: true,
    freq: null,
    prx: num(d.laserPrxResult), preq: num(d.laserPreqResult),
    fsl: num(d.laserFslResult),
    atm: 0, rain: 0, cloud: 0, misc: numOr(d.laserOtherLossResult, 0),
    gtDeg: 0,
    availability: null,
    noiseBW: null,
    thresholdCN: null,
    laserMargin: margin,
    cn: null
  };
}

module.exports = {
  computeLinkChain,
  setOutputPrecisionBoost
};
