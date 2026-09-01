// satlink-core — 卫星链路预算计算引擎（纯 JS，平台无关）
// 从微信小程序原样移植：GEO/NGSO 双引擎 + ITU-R 传播模型 + SGP4 支撑。
// 在 Electron 主进程(Node)中加载，通过 IPC 暴露给渲染进程。

const geo = require('./utils/linkCalculator.js');
const waterfall = require('./utils/waterfallBuilder.js');
const modeSolver = require('./utils/modeSolver.js');
const ngsoGeometry = require('./utils/ngsoGeometry.js');
const rainRate = require('./utils/rainRate.js');
const elevation = require('./utils/elevation.js');
const waterVaporGrid = require('./data/waterVaporGrid.js');
const cloudParamsGrid = require('./data/cloudParamsGrid.js');
const cities = require('./utils/cities.js');
const constants = require('./utils/constants.js');
const sunOutage = require('./utils/sunOutageCalculator.js');
const icsBuilder = require('./utils/icsBuilder.js');
const eventWindows = require('./utils/eventWindows.js');
const rainAttenuation = require('./utils/rainAttenuation.js');
const metSnapshot = require('./utils/metSnapshot.js');
const instantAtten = require('./utils/instantAtten.js');
const metFetchPlan = require('./utils/metFetchPlan.js');
const liveField = require('./utils/liveField.js');
const ngsoElevStats = require('./utils/ngsoElevStats.js');
const adaptiveUnits = require('./utils/adaptiveUnits.js');
const envField = require('./utils/envField.js');
const linkSweep = require('./utils/linkSweep.js');
const lbOutputDefs = require('./utils/lbOutputDefs.js');
const modcodTables = require('./utils/modcodTables.js');

// 载波信号选项（调制 / FEC / DVB 标准 / 各 MODCOD 预设表），供载波信号面板的下拉与快选用。
// store = 用户的 MODCOD 改写层（文件管理里编辑的那份，见 utils/modcodTables.js）；不传即纯内置表。
function basebandOptions(store) {
  return {
    modulation: constants.MODULATION_OPTIONS,
    fec: constants.FEC_OPTIONS,
    dvbStandards: modcodTables.standardOptions(store),
    modcod: modcodTables.modcodMap(store)
  };
}

// Node Buffer / TypedArray → 精确 ArrayBuffer 切片（直接把 Buffer 交给 TypedArray 会逐字节误读）
function _toArrayBuffer(buf) {
  if (!buf) return null;
  if (buf instanceof ArrayBuffer) return buf;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// 注入全精度 ITU 数据（降雨率 P.837 / 海拔 P.1511 / 水汽 P.836 / 云 P.840）。
// 与小程序 app.js 后台下载注入等价；桌面端从本地 resources/itu 同步加载，确保口径完全一致。
function loadFullPrecisionData(bufs) {
  bufs = bufs || {};
  const rep = {};
  try { if (bufs.rain) { rainRate.setFullPrecisionData(_toArrayBuffer(bufs.rain)); rep.rain = rainRate.isFullDataReady(); } } catch (e) { rep.rain = 'ERR:' + e.message; }
  try { if (bufs.elev) { elevation.setFullPrecisionElevation(_toArrayBuffer(bufs.elev)); rep.elev = elevation.isElevationReady(); } } catch (e) { rep.elev = 'ERR:' + e.message; }
  try { if (bufs.vapor) { waterVaporGrid.setData(_toArrayBuffer(bufs.vapor)); rep.vapor = waterVaporGrid.isReady(); } } catch (e) { rep.vapor = 'ERR:' + e.message; }
  try { if (bufs.cloud) { cloudParamsGrid.setData(_toArrayBuffer(bufs.cloud)); rep.cloud = cloudParamsGrid.isReady ? cloudParamsGrid.isReady() : true; } } catch (e) { rep.cloud = 'ERR:' + e.message; }
  return rep;
}

// 按经纬度自动取降雨率(ITU-R P.837，内嵌 0.5° 回退即可用)与海拔(P.1511，全精度数据未注入时返回 null)。
// 与小程序「经纬度失焦自动填降雨率/海拔」口径一致。
function geoAutoFill(lat, lon) {
  const out = {};
  try { out.rainRate = rainRate.queryRainRate(lat, lon).rainRate; } catch (e) { out.rainRate = null; }
  try { const el = elevation.queryElevation(lat, lon); out.altitude = (el && el.success) ? el.altitude : null; } catch (e) { out.altitude = null; }
  return out;
}

// NGSO 引擎独立加载并容错：即使其依赖（如 tleStore 的 wx.* 兜底）在某些
// 环境下加载异常，也不影响 GEO 主链路可用。
let ngso = null;
try {
  ngso = require('./utils/linkCalculatorNGSO.js');
} catch (e) {
  console.warn('[satlink-core] NGSO 引擎延迟加载：', e.message);
}

// 端到端链路（多跳 / 混合转发）引擎——正向电平递推，物理量借三引擎，只做级联代数。
let linkChain = null;
try {
  linkChain = require('./utils/linkChain.js');
} catch (e) {
  console.warn('[satlink-core] 端到端链路引擎加载失败：', e.message);
}

// 再生式链路预算引擎（v1：再生式上行）——复用 NGSO 上行物理量，把合计重标为上行 C/(N+I)。
let regen = null;
try {
  regen = require('./utils/linkCalculatorRegen.js');
} catch (e) {
  console.warn('[satlink-core] 再生式引擎加载失败：', e.message);
}

// SGP4/SDP4 轨道传播（vendored satellite-js），供星座地图/星间链路使用。
let sgp4 = null;
try {
  sgp4 = require('./vendor/satellite.js');
} catch (e) {
  console.warn('[satlink-core] SGP4 加载失败：', e.message);
}

module.exports = {
  // GEO（静止轨道）
  calculateLinkBudget: geo.calculateLinkBudget,
  calculateSatelliteAngle: geo.calculateSatelliteAngle,
  // NGSO（非静止轨道）
  calculateLinkBudgetNGSO: ngso && ngso.calculateLinkBudget,
  // 链路瀑布表数据构建（GEO/NGSO 共用，供结果区与专业版导出口径一致）
  buildWaterfallSegments: waterfall.buildWaterfallSegments,
  buildLinkSummary: waterfall.buildLinkSummary,
  // 显示单位自适应（W→mW/kW、kHz→MHz、dBW→dBm 等；报告汇总表按行共选单位用）
  adaptiveUnits,
  // 参数扫描（y = f(x)：选一个入参当自变量逐点重跑引擎）+ 可绘输出量清单
  sweepLink: linkSweep.sweepLink,
  // 二维参数扫描（设计空间图：x×y 平面上逐格重跑，出等值线与可行域）
  sweepLink2D: linkSweep.sweepLink2D,
  linkSweep,
  lbOutputDefs,
  // 计算方式求解（设置余量 / 设置瓦数 / 功带平衡 / 超发功带平衡）
  computeLinkMode: modeSolver.computeLinkMode,
  // NGSO 计算方式求解（同四种方式，切 NGSO 引擎，强制 ISL 跳数=0）
  computeLinkModeNGSO: modeSolver.computeLinkModeNGSO,
  // 再生式上行计算方式求解（设置余量 / 设置功放；合计 C/N = 上行 C/(N+I)）
  computeRegenUplinkMode: regen && regen.computeRegenUplinkMode,
  // 再生式下行计算方式求解（给定工作点 G/T / 目标余量；合计 C/N = 下行 C/(N+I)）
  computeRegenDownlinkMode: regen && regen.computeRegenDownlinkMode,
  // 再生式星间计算（发射卫星 EIRP / 接收卫星 G/T；合计 C/N = 星间单跳 C/N；几何最差距离注入）
  computeRegenIslMode: regen && regen.computeRegenIslMode,
  // 再生式星间激光计算（第一性原理光学预算：发射光功率/望远镜增益/光学FSL/指向 → P_rx；光子/bit 灵敏度 → 余量）
  computeRegenLaserIslMode: regen && regen.computeRegenLaserIslMode,
  // 端到端链路（多跳 / 混合转发）：节点链 → 分段 → 段内级联 → 逐段结算 → 端到端汇总（只有正向计算）
  computeLinkChain: linkChain && linkChain.computeLinkChain,
  // NGSO 站星几何求解（SGP4 双站互视最差几何 + 轨道根数 + 时刻/时窗），供结果几何区用平台精确几何
  ngsoGeometry,
  solveNgsoMutualWorstCase: ngsoGeometry.solveMutualWorstCase,
  // 批量：同一颗星/同一时窗下的多条链路一次求解（各站对共享 SGP4 粗扫，结果与逐条求解逐位一致）
  solveNgsoMutualWorstCaseBatch: ngsoGeometry.solveMutualWorstCaseBatch,
  // 星间链路(ISL)两星几何：双 SGP4 + 地球临边遮挡 → 最差星间距离 + 互视可见度 + 访问窗口
  solveIslWorstCase: ngsoGeometry.solveIslWorstCase,
  // 星间距离时间序列（同一套几何，逐拍出参）：供「星间链路距离」工具的时间轴取某一时刻的距离
  sampleIslRangeSeries: ngsoGeometry.sampleIslRangeSeries,
  // 单站访问窗口（满足最低仰角及以上的全部过境时间窗），供再生式几何关系区
  solveAccessWindows: ngsoGeometry.solveAccessWindows,
  // 经纬度 → 降雨率 / 海拔自动填值（与小程序口径一致）
  geoAutoFill,
  loadFullPrecisionData,
  // 城市列表（选址 → 自动填经纬度，进而联动降雨率/海拔）
  listCities: cities.getAllCities,
  // 城市关键词检索：支持 城市名 / 省份名(含别名) / 拼音首字母缩写（与小程序口径一致）
  searchCities: cities.searchCities,
  // 载波信号选项（调制/FEC/DVB/MODCOD）
  basebandOptions,
  // MODCOD 表的「内置 + 用户改写」合并层（文件管理 · 调制编码 的编辑口径）
  modcodTables,
  // 日凌预报（v5 物理恶化门限判据）+ ICS 日历构建
  calculateSunOutage: sunOutage.calculateSunOutage,
  sunOutageBands: sunOutage.BAND_PARAMS,
  buildIcs: icsBuilder.buildIcs,
  // 通用事件窗口求解器（日凌先行验证；后续 Access/ISL 复用）
  findWindows: eventWindows.findWindows,
  // 雨衰计算（通用，面向所有种类卫星；仰角直接驱动，复用 ITU-R 传播模型）
  calculateRainAttenuation: rainAttenuation.calculateRainAttenuation,
  sweepRainAttenuation: rainAttenuation.sweepRainAttenuation,
  // 可用度反解（已知可承受衰减 → 求可用度）与多站总可用度（N+P 网关分集）
  solveAvailabilityForAtten: rainAttenuation.solveAvailabilityForAtten,
  solveMultiSite: rainAttenuation.solveMultiSite,
  rainDiversity: require('./utils/rainDiversity.js'),
  rainAttenuation,
  // —— 实时 / 预报分支（与上面的 ITU 统计口径**并列**，两者永不混算）——
  // computeInstant 的出参里刻意没有 availability / downtime 这类键：口径混用在数据结构上就被堵死。
  computeInstantAtten: instantAtten.computeInstant,
  instantPathModels: instantAtten.PATH_MODELS,
  metSnapshot,      // 气象快照契约 + P.453 派生量（e / ρ / N_wet / 站点气压）
  instantAtten,
  metFetchPlan,     // 取数计划器：两级自适应加密 + 缓存复用 + 预算估算（把「场 = N 次请求」压下来）
  // 实时/预报环境场：气象立方体的某一帧 → 栅格。出参与 envField.sampleField 同构，
  // 故渲染端（上色/提线/2D·3D 两通道）与 ITU 气候场共用同一套代码。
  liveField,
  liveFieldDefs: () => liveField.FIELD_DEFS,
  sampleLiveField: liveField.sampleField,
  // 多站逐点读数（站点表）：在立方体原生格上直接算，不经过降采样的出图栅格
  sampleLivePoints: liveField.samplePoints,
  ngsoElevStats,   // ITU-R P.618-14 §8 非静止轨道长期统计（仰角分布 + 等效仰角）
  rainRate,
  elevation,
  // 环境场图层（主窗口「环境场」视图）：整张等经纬栅格一次取回，取值与上面各引擎同源
  envFieldDefs: () => envField.FIELD_DEFS,
  sampleEnvField: envField.sampleField,
  envPointValue: envField.pointValue,
  // 命名空间，便于按需取用其余导出
  geo,
  ngso,
  waterfall,
  sgp4,
};
