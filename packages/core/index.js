// satlink-core — 卫星链路预算计算引擎（纯 JS，平台无关）
// 从微信小程序原样移植：GEO/NGSO 双引擎 + ITU-R 传播模型 + SGP4 支撑。
// 在 Electron 主进程(Node)中加载，通过 IPC 暴露给渲染进程。

const geo = require('./utils/linkCalculator.js');
const waterfall = require('./utils/waterfallBuilder.js');
const modeSolver = require('./utils/modeSolver.js');
const rainRate = require('./utils/rainRate.js');
const elevation = require('./utils/elevation.js');
const waterVaporGrid = require('./data/waterVaporGrid.js');
const cloudParamsGrid = require('./data/cloudParamsGrid.js');
const cities = require('./utils/cities.js');
const constants = require('./utils/constants.js');

// 基带选项（调制 / FEC / DVB 标准 / 各 MODCOD 预设表），供基带面板的下拉与快选用。
function basebandOptions() {
  return {
    modulation: constants.MODULATION_OPTIONS,
    fec: constants.FEC_OPTIONS,
    dvbStandards: constants.DVB_STANDARD_OPTIONS,
    modcod: {
      'DVB-S': constants.DVBS_MODCOD_TABLE,
      'DVB-S2': constants.DVBS2_MODCOD_TABLE,
      'DVB-S2X': constants.DVBS2X_MODCOD_TABLE,
      'DVB-RCS2': constants.DVB_RCS2_MODCOD_TABLE,
      '3GPP NR-NTN': constants.NR_NTN_MODCOD_TABLE,
      '3GPP NB-IoT NTN': constants.NB_IOT_NTN_MODCOD_TABLE
    }
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
  // 计算方式求解（设置余量 / 设置瓦数 / 功带平衡 / 超发功带平衡）
  computeLinkMode: modeSolver.computeLinkMode,
  // 经纬度 → 降雨率 / 海拔自动填值（与小程序口径一致）
  geoAutoFill,
  loadFullPrecisionData,
  // 城市列表（选址 → 自动填经纬度，进而联动降雨率/海拔）
  listCities: cities.getAllCities,
  // 城市关键词检索：支持 城市名 / 省份名(含别名) / 拼音首字母缩写（与小程序口径一致）
  searchCities: cities.searchCities,
  // 基带选项（调制/FEC/DVB/MODCOD）
  basebandOptions,
  rainRate,
  elevation,
  // 命名空间，便于按需取用其余导出
  geo,
  ngso,
  waterfall,
  sgp4,
};
