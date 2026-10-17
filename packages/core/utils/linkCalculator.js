// linkCalculator.js
// 卫星链路本地计算模块

const validator = require('./validator.js');
// 离轴 EIRP 密度掩模（ITU-R S.524-9）单一出处——本文件与 NGSO 引擎共用，勿再各自内联频段表

// ITU-R 传播物理函数单一真值源（P.838 / P.618 雨衰·XPD·闪烁·天空噪温 / P.840 云 / P.676 气体 / P.2041 机载），
// 与 NGSO 引擎同一份。下方 module.exports 里同名函数原样再导出——雨衰页 / 瞬时衰减 / 环境场照旧经本模块取用。
const {
  getCoefficients, scaleRainAttenP618_14, calculateSinglePathRainAttenuation, rainHeightKm,
  calculatePolarizationAngle, calculateRainXPD_P618_14, calculateScintillationFading,
  cloudLWCFromLognormal, cloudSpecificAttenuation, calculateCloudAttenuation,
  calculateAtmosphericAttenuation, gaseousAttenuationSite, surfaceTemperature,
  cloudLiquidFraction, scintillationApplies, skyNoise
} = require('./itu/index.js');

// —— 出参小数位增量 FX ——
//
// 本模块的出参一律是 `数.toFixed(n)` 的**字符串**，故每个量都被钉在 10⁻ⁿ 的格子上。
// 单点计算与报表要的正是这个定位数（可手算、可对表、逐位可复核），但参数扫描要的是场：
// 跨度只有 0.3 dB 的场（上行 C/N 常如此）被 0.01 dB 的取整压成台阶，等值线只能沿格边走，
// 画出来是一片直角阶梯——那些直角不是物理，是取整留下的痕迹。
//
// 故留一个模块级增量：全文 toFixed(n) 实际按 n + FX 位输出。默认 0，逐位与从前完全相同；
// 扫描期间由 utils/linkSweep.js 临时置 4，算完立刻复位（try/finally 是硬要求，漏出去会让
// 界面上的数变成 6 位小数）。它只改出参的位数，不碰任何一步计算。
let FX = 0;

// —— 调试日志开关 ——
//
// 引擎每次调用曾无条件 `console.log('收到的参数:', JSON.stringify(...))` + `console.log('计算完成，结果:', ...)`，
// 两次全对象序列化（结果对象 172 键 / 5.2 KB）+ 一次 stdout 写 ≈ 0.028 ms/次，占单次引擎调用 0.084 ms 的
// 三分之一；而「功带平衡」一行要跑 33 次引擎、批量一次上百行 —— 纯打日志就吃掉近半计算时间。
// 故改为按需开启：设环境变量 SATLINK_DEBUG=1 时才打（且 JSON.stringify 也只在那时才求值）。
// 只影响日志，不碰任何一步计算。
const DEBUG_LOG = !!(typeof process !== 'undefined' && process.env && process.env.SATLINK_DEBUG);

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

/**
 * 出参收位（最多 d 位小数，随 FX 增位），保持数值类型、不补尾零。
 * 给「一半是表单原值、一半是算出来的」那类出参用：toFixed 出串会把 2048 写成 "2048.000"，
 * 原样透传又会把 392 bit ÷ 3 子帧 = 130.66666666666666 这种无限小数整串印到界面上。
 * ★ 出的是 Number 不是串：这类字段历来存数值，改成串会让端到端链的出参指纹（JSON.stringify
 *   区分 2048 与 "2048"）整体漂一遍，把「计算被碰了」这条警报冲掉。
 * @param {number} n 数值
 * @param {number} d 小数位上限
 * @returns {number} 非有限值原样返回，否则返回收位后的数
 */
function roundOut(n, d) {
  return isFinite(n) ? +n.toFixed(d + FX) : n;
}

/**
 * 解析FEC码率字符串，支持任意形式的分数和小数
 * @param {string|number} fecInput - FEC码率输入（如 "3/4", "11/55", "0.75"）
 * @param {number} defaultValue - 默认值
 * @returns {number} 解析后的数值
 */
function parseFecForCalculation(fecInput, defaultValue = 0.75) {
  if (fecInput === '' || fecInput === null || fecInput === undefined) {
    return defaultValue;
  }
  
  const fecStr = String(fecInput).trim();
  
  // 如果包含/，说明是分数格式
  if (fecStr.includes('/')) {
    const parts = fecStr.split('/');
    if (parts.length === 2) {
      const numerator = parseFloat(parts[0].trim());
      const denominator = parseFloat(parts[1].trim());
      if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
        return numerator / denominator;
      }
    }
    return defaultValue;
  }
  
  // 小数格式
  const value = parseFloat(fecStr);
  return isNaN(value) ? defaultValue : value;
}

/**
 * 解析RS编码码率字符串，支持任意形式的分数和小数
 * @param {string|number} rsCodeInput - RS编码码率输入（如 "188/204", "0.92"）
 * @param {number} defaultValue - 默认值 (188/204 ≈ 0.9216)
 * @returns {number} 解析后的数值
 */
function parseRsCodeForCalculation(rsCodeInput, defaultValue = 188/204) {
  if (rsCodeInput === '' || rsCodeInput === null || rsCodeInput === undefined) {
    return defaultValue;
  }
  
  const rsCodeStr = String(rsCodeInput).trim();
  
  // 如果包含/，说明是分数格式
  if (rsCodeStr.includes('/')) {
    const parts = rsCodeStr.split('/');
    if (parts.length === 2) {
      const numerator = parseFloat(parts[0].trim());
      const denominator = parseFloat(parts[1].trim());
      if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
        return numerator / denominator;
      }
    }
    return defaultValue;
  }
  
  // 小数格式
  const value = parseFloat(rsCodeStr);
  return isNaN(value) ? defaultValue : value;
}

// 物理常量
const CONSTANTS = {
  LIGHT_SPEED: 299792.458, // 光速 km/s
  EARTH_RADIUS: 6378.137, // 地球平均半径 km
  SATELLITE_ALTITUDE: 35786, // 地球同步卫星高度 km
  PI: Math.PI,
  BOLTZMANN: -228.6 // 玻尔兹曼常数 dBW/K/Hz
};

// 调制因子 —— 取 modulation.js 那份单一出处：内置名查表 + 「M + 族后缀」按 log2(M) 解析，
// 面板下拉、MODCOD 预设表、用户自建的调制方式全走它（引擎再抄一份就会漂：曾漏 '64QAM'
// 致其静默回退 QPSK，符号率/带宽错 3 倍）
const { modFactorOf } = require('./modulation.js');
const ntnPhy = require('./ntnPhy.js'); // 3GPP NTN 物理层口径（占用带宽 / TBS / 信息速率 / 含重复的门限）
const { DEFAULT_SITE } = require('./defaultSite.js'); // 站址经纬度留空时的默认站址（渲染端按同一组数查降雨率 / 海拔）
const strictNumMod = require('./strictNum.js'); // 数值入参严格口径（「36 MHz」「12,5」不再按前缀读成 36 / 12）
const art21 = require('./itu/art21.js'); // RR Art.21 Table 21-4（RR 2024）PFD 限值查表 + 自由空间口径余量，与 NGSO 引擎同一份

// （P.838 降雨衰减系数表已移至 itu/p838.js，两引擎共用一份）

/**
 * 极化显示值 → 计算值。圆极化在界面上有两套写法：链路预算三窗的下拉存 'L'/'R'，
 * 早期配置与雨衰页存 'LHCP'/'RHCP'，两套都必须归一到 'C'，否则会掉进线极化分支
 * 拿到 τ=0°（等同水平极化），P.618-14 §4.1 的雨致 XPD 被抬高十几 dB。
 * 显示值本身不在这里改写（报表照原样显示 L/R/LHCP/RHCP）。
 * @param {string} display 极化显示值
 * @returns {string} 圆极化返回 'C'，其余（'V'/'H'）原样返回
 */
function toCalcPolarization(display) {
  const s = String(display || '').toUpperCase();
  return (s === 'L' || s === 'R' || s === 'LHCP' || s === 'RHCP') ? 'C' : display;
}

/**
 * 卫星链路预算计算主函数
 */
function calculateLinkBudget(satParams, linkParams) {
  try {
    if (DEBUG_LOG) console.log('收到的参数:', JSON.stringify({ satParams, linkParams }));

    // 参数验证
    if (!satParams || !linkParams) {
      throw new Error('缺少必需的参数：satParams 或 linkParams');
    }

    if (DEBUG_LOG) console.log('参数验证通过，开始计算');

    // 执行链路计算 - 使用完整算法
    const results = performCalculations(satParams, linkParams);

    if (DEBUG_LOG) console.log('计算完成，结果:', JSON.stringify(results));

    return {
      success: true,
      data: results
    };
  } catch (error) {
    console.error('计算错误:', error);
    console.error('错误堆栈:', error.stack);
    return {
      success: false,
      message: error.message || '计算失败',
      error: error.toString(),
      stack: error.stack
    };
  }
}

/**
 * 主计算函数 - 严格遵循 index.html 的 performCalculations 算法
 */
function performCalculations(satParams, inputs) {
  // 数值入参先过严格口径：非法串（「36 MHz」「12,5」「1.2.3」）按留空取该项缺省，全角数字转半角；
  // 合法值原样放行（连对象都不换），下游 parseFloat 读到的仍是同一个串 → 合法输入逐位不变。见 strictNum.js
  satParams = strictNumMod.strictInputs(satParams, strictNumMod.LINK_SAT_NUM_KEYS);
  inputs = strictNumMod.strictInputs(inputs, strictNumMod.LINK_INPUT_NUM_KEYS);
  const results = {};
  // 取数助手：仅当为空('' / null / undefined)或非法时回退默认；输入了什么合法数(含 0)就如实取值，
  // 不再用 `parseFloat(x) || 默认` 的二次兜底（那会把用户输入的 0 当成默认值，导致输入与计算结果对不上）
  const pickNum = strictNumMod.pickNum;

  // ============ 基础参数提取 ============
  const satelliteName = satParams.satelliteName || satParams.name || "未命名卫星";
  const frequencyBand = satParams.frequencyBand;
  const transponderStatus = satParams.transponderStatus || 'single';
  // 修复：优先从 inputs 读取极化参数，如果没有则从 satParams 读取
  // 保存原始极化显示值（L/R/LHCP/RHCP/V/H），并转换为计算用的值（C/V/H）
  const uplinkPolarizationDisplay = inputs.uplinkPolarization || satParams.uplinkPolarization || 'V';
  const uplinkPolarization = toCalcPolarization(uplinkPolarizationDisplay);
  const transponderBandwidth = pickNum(satParams.transponderBandwidth, 36); // MHz
  const _orbitPosRaw = satParams.orbitPosition !== undefined && satParams.orbitPosition !== '' && satParams.orbitPosition !== null
    ? satParams.orbitPosition : (satParams.position !== undefined && satParams.position !== '' && satParams.position !== null ? satParams.position : null);
  const orbitPosition = _orbitPosRaw !== null ? parseFloat(_orbitPosRaw) : 110.5;
  const EIRPs = pickNum(inputs.rxEIRP, 46); // dBW - 卫星下行EIRP
  const G_Ts = pickNum(inputs.G_Ts, 2); // dB/K - 卫星G/T
  const SFDref = (satParams.sfdRef !== '' && satParams.sfdRef !== null && satParams.sfdRef !== undefined)
    ? parseFloat(satParams.sfdRef) : -84; // dBW/m² - SFD参考值（空回退对齐字段默认 -84）
  
  // ============ 通信参数 ============
  // 3GPP NTN 的 snr 行会在下方「调制与带宽计算」处被 phy 算出来的值顶掉（故不是 const）
  let infoRate = pickNum(inputs.infoRate, 2048); // kbps - 信息速率
  const modulation = inputs.modulation || "QPSK";
  // FEC码率：支持分数和小数格式，保留原始输入用于显示
  const fecOriginal = String(inputs.fec || '0.75').trim();
  const fec = parseFecForCalculation(fecOriginal, 0.75); // FEC码率（数值）
  // RS编码码率：支持分数和小数格式，保留原始输入用于显示
  const rsCodeOriginal = String(inputs.rsCode || '188/204').trim();
  const rsCode = parseRsCodeForCalculation(rsCodeOriginal, 188/204); // RS码效率（数值）
  const bandwidthFactor = pickNum(inputs.bandwidthFactor, 1.2); // 带宽系数(默认与应用预填/实时预览统一为 1.2)
  const berExponent = ((inputs.ber !== '' && inputs.ber !== null && inputs.ber !== undefined)
    ? parseFloat(inputs.ber) : 7) * -1; // 误码率指数
  
  // 噪声比模式：'ebno' / 'esno' / 'snr'（3GPP NTN 的每 RE 信噪比，噪声带宽 = 占用带宽）
  const noiseRatioMode = inputs.noiseRatioMode || 'ebno';
  const inputNoiseRatio = inputs.ebno !== '' && inputs.ebno !== null && inputs.ebno !== undefined
    ? parseFloat(inputs.ebno) : 5.5; // dB - 输入的噪声比值（空回退对齐字段默认 5.50）
  
  // 修复：正确处理 margin = 0 的情况
  const margin = (inputs.margin !== '' && inputs.margin !== null && inputs.margin !== undefined)
    ? parseFloat(inputs.margin) : 3; // dB - 链路余量
  const m = pickNum(inputs.m, 1.0); // 扩频增益
  
  // ============ 上行站参数 ============
  const earthLon = (inputs.longitude !== '' && inputs.longitude !== null && inputs.longitude !== undefined)
    ? parseFloat(inputs.longitude) : DEFAULT_SITE.lon;
  const earthLat = (inputs.latitude !== '' && inputs.latitude !== null && inputs.latitude !== undefined)
    ? parseFloat(inputs.latitude) : DEFAULT_SITE.lat;
  const antennaDiameter = pickNum(inputs.antennaDiameter, 6.2); // meters（空回退对齐字段默认 6.2）
  const antennaEfficiency = pickNum(inputs.antennaEfficiency, 65) / 100;
  const feederLoss = inputs.feederLoss !== undefined && inputs.feederLoss !== '' && inputs.feederLoss !== null
    ? parseFloat(inputs.feederLoss)
    : 3.5; // dB (支持输入0；空回退对齐字段默认 3.5)
  const uplinkAvailability = (inputs.uplinkAvailability !== '' && inputs.uplinkAvailability !== null && inputs.uplinkAvailability !== undefined)
    ? parseFloat(inputs.uplinkAvailability) : 100; // %（留空按出厂 100%＝晴天）
  const rainRate = parseFloat(inputs.rainRate) || 0; // mm/h
  const altitude = (parseFloat(inputs.altitude) || 0) / 1000; // km
  const earthStationLocation = inputs.earthStationLocation || "上行站";
  
  // ============ 接收站参数 ============
  const rxLongitude = (inputs.rxLongitude !== '' && inputs.rxLongitude !== null && inputs.rxLongitude !== undefined)
    ? parseFloat(inputs.rxLongitude) : DEFAULT_SITE.lon;
  const rxLatitude = (inputs.rxLatitude !== '' && inputs.rxLatitude !== null && inputs.rxLatitude !== undefined)
    ? parseFloat(inputs.rxLatitude) : DEFAULT_SITE.lat;
  const rxAntennaDiameter = pickNum(inputs.rxAntennaDiameter, 3.7); // meters（空回退对齐字段默认 3.7）
  const rxAntennaEfficiency = pickNum(inputs.rxAntennaEfficiency, 65) / 100;
  const rxFeederLoss = inputs.rxFeederLoss !== undefined && inputs.rxFeederLoss !== '' && inputs.rxFeederLoss !== null
    ? parseFloat(inputs.rxFeederLoss) 
    : 0.2; // dB (支持输入0)
  const rxDownlinkAvailability = ((inputs.rxDownlinkAvailability !== '' && inputs.rxDownlinkAvailability !== null && inputs.rxDownlinkAvailability !== undefined)
    ? parseFloat(inputs.rxDownlinkAvailability) : 100) / 100;
  const rxRainRate = parseFloat(inputs.rxRainRate) || 0; // mm/h
  const rxAltitude = (parseFloat(inputs.rxAltitude) || 0) / 1000; // km
  
  // 噪声温度参数 (支持输入0)
  const antennaNoiseTemp = (inputs.rxAntennaNoiseTemp !== undefined && inputs.rxAntennaNoiseTemp !== '' && inputs.rxAntennaNoiseTemp !== null)
    ? parseFloat(inputs.rxAntennaNoiseTemp)
    : ((frequencyBand === 'C' || frequencyBand === 'ExtC') ? 30 : 35); // K
  const receiverNoiseTemp = (inputs.rxReceiverNoiseTemp !== undefined && inputs.rxReceiverNoiseTemp !== '' && inputs.rxReceiverNoiseTemp !== null)
    ? parseFloat(inputs.rxReceiverNoiseTemp)
    : ((frequencyBand === 'C' || frequencyBand === 'ExtC') ? 40 : 75); // K
    const aciUplinkFactor = satParams.aciUplinkFactor !== undefined && satParams.aciUplinkFactor !== '' && satParams.aciUplinkFactor !== null
    ? parseFloat(satParams.aciUplinkFactor) 
    : 30; // dB
  const adjUplinkFactor = satParams.adjUplinkFactor !== undefined && satParams.adjUplinkFactor !== '' && satParams.adjUplinkFactor !== null
    ? parseFloat(satParams.adjUplinkFactor) 
    : 25; // dB
  const adjDownlinkFactor = satParams.adjDownlinkFactor !== undefined && satParams.adjDownlinkFactor !== '' && satParams.adjDownlinkFactor !== null
    ? parseFloat(satParams.adjDownlinkFactor) 
    : 25; // dB
  const xpolUplinkFactor = satParams.xpolUplinkFactor !== undefined && satParams.xpolUplinkFactor !== '' && satParams.xpolUplinkFactor !== null
    ? parseFloat(satParams.xpolUplinkFactor) 
    : 26; // dB
  const xpolDownlinkFactor = satParams.xpolDownlinkFactor !== undefined && satParams.xpolDownlinkFactor !== '' && satParams.xpolDownlinkFactor !== null
    ? parseFloat(satParams.xpolDownlinkFactor) 
    : 26; // dB
  const hpaIntermodFactor = satParams.hpaIntermodFactor !== undefined && satParams.hpaIntermodFactor !== '' && satParams.hpaIntermodFactor !== null
    ? parseFloat(satParams.hpaIntermodFactor) 
    : 24; // dB
  const aciDownlinkFactor = satParams.aciDownlinkFactor !== undefined && satParams.aciDownlinkFactor !== '' && satParams.aciDownlinkFactor !== null
    ? parseFloat(satParams.aciDownlinkFactor) 
    : 30; // dB
  const xpdrIntermodFactor = satParams.xpdrIntermodFactor !== undefined && satParams.xpdrIntermodFactor !== '' && satParams.xpdrIntermodFactor !== null
    ? parseFloat(satParams.xpdrIntermodFactor) 
    : 21; // dB
  
  // UPC参数
  const uplinkPowerControl = inputs.uplinkPowerControl || '否';
  const paBackoff = inputs.paBackoff !== undefined && inputs.paBackoff !== '' && inputs.paBackoff !== null
    ? parseFloat(inputs.paBackoff) 
    : 0; // dB - 功放回退 (支持输入0)
  
  // （原「精细化损耗参数」pointingError/polarizationLoss/radomeLoss/connectorLoss 已删除：
  //   四项仅读入并回显、从未参与任何链路计算，前端也无输入 UI，保留会误导使用者以为已计入。
  //   实际链路中的杂项损耗统一由用户输入的 uplinkOtherLoss/downlinkOtherLoss 承载。）

  // ============ 频率参数 ============
  const uplinkFrequency = (inputs.centerFrequency !== '' && inputs.centerFrequency !== null && inputs.centerFrequency !== undefined)
    ? parseFloat(inputs.centerFrequency) : 14.25; // GHz
  const downlinkFrequency = (inputs.rxCenterFrequency !== '' && inputs.rxCenterFrequency !== null && inputs.rxCenterFrequency !== undefined)
    ? parseFloat(inputs.rxCenterFrequency) : 12.5; // GHz
  
  // ============ 计算波长和天线增益 ============
  const wavelength = 0.299792458 / uplinkFrequency; // 上行波长 (米)
  const rxWavelength = 0.299792458 / downlinkFrequency; // 下行波长 (米)
  
  // 卫星天线每平方米增益
  const antennaGain = 10 * Math.log10(4 * CONSTANTS.PI / (wavelength ** 2));
  
  // 转发器回退参数 - 从卫星参数中读取 (支持输入0)
  const BOi = satParams.BOi !== undefined && satParams.BOi !== '' && satParams.BOi !== null
    ? parseFloat(satParams.BOi) 
    : 6; // 转发器IBO (dB)
  const BOo = satParams.BOo !== undefined && satParams.BOo !== '' && satParams.BOo !== null
    ? parseFloat(satParams.BOo) 
    : 3; // 转发器OBO (dB)
  
  // SFDs计算
  const SFDs = SFDref - G_Ts;
  
  // 下行极化方式 - 修复：优先从 inputs 读取，如果没有则根据上行极化自动推导
  // 保存原始极化显示值（L/R/LHCP/RHCP/V/H），并转换为计算用的值（C/V/H）
  const downlinkPolarizationDisplay = inputs.downlinkPolarization ||
                               (uplinkPolarization === 'C' ? uplinkPolarizationDisplay :
                               (uplinkPolarization === 'V' ? 'H' : 'V'));
  const downlinkPolarization = toCalcPolarization(downlinkPolarizationDisplay);
  
  // 系统可用度
  const rxdownlinkAvailability = rxDownlinkAvailability * 100;
  const systemAvailability = (uplinkAvailability * rxDownlinkAvailability).toFixed(5 + FX);
  
  // ============ 调制与带宽计算 ============
  const modulationFactor = modFactorOf(modulation) || 2;
  // ★ 3GPP NTN 的 snr 行不走下面这条 DVB 链。物理层描述子 phy 给了 PRB 数与子载波间隔，
  //   占用带宽 B_occ = N_RB×12×SCS（NB-IoT 上行 = 音数×SCS）本身就是噪声带宽，信息速率由 TBS 算出
  //   （表单里那个 infoRate 忽略），帧效率 / 滚降 / 扩频增益三项不参与。于是下方那行
  //   thresholdCN = ebno + 10lg(infoRate / noiseBW) 恒等于门限 SNR —— 恒等式一个字不用改。
  //   口径推导与出处见 utils/ntnPhy.js 的文件头。
  const snrChain = noiseRatioMode === 'snr'
    ? ntnPhy.engineChain(inputs.phy, inputNoiseRatio, modulationFactor, fec)
    : null;
  if (snrChain && snrChain.error) throw new Error('3GPP 载波参数无效：' + snrChain.error);
  if (snrChain) infoRate = snrChain.infoRate;
  const carrierRate = snrChain ? null : infoRate / rsCode / fec; // 传输速率 (kbps)
  const ChipRate = snrChain ? null : carrierRate * m; // 码片速率 (kbps)
  // ★ snr 行这里放的是【占用带宽】而不是符号率：下游 noiseBW = symbolRate 就是噪声带宽。
  //   OFDM 的真符号率是 B_occ×14/15（每秒 RE 数），故这三个 DVB 读数对 snr 行一律不出参。
  const symbolRate = snrChain ? snrChain.symbolRate : ChipRate / modulationFactor; // 符号速率 (ksps)
  // 分配带宽计算：保留三位小数
  const allocBandwidth = snrChain ? snrChain.allocBandwidth : Math.round(bandwidthFactor * symbolRate * 1000) / 1000; // 分配带宽 (kHz)
  const k = snrChain ? snrChain.k : (fec * rsCode * modulationFactor) / m; // 组合效率
  // 功率谱密度的参考带宽：snr 行按占用带宽（信道带宽含保护带，拿它算会把 PSD 低报 0.18~0.46 dB）
  const psdBandwidth = snrChain ? snrChain.symbolRate : allocBandwidth; // kHz
  
  // 根据噪声比模式计算 ebno 和 esno
  let ebno, esno;
  if (snrChain) {
    // 门限值 = 每 RE SNR（已按 N_rep 折算）；Eb/N₀ 由占用带宽上的频谱效率反折，
    // 于是 CP / DMRS / 系统开销 / 重复全都自动算进 Eb/N₀ 里，不必再乘经验系数。
    esno = snrChain.esno;
    ebno = snrChain.ebno;
  } else if (noiseRatioMode === 'esno' || noiseRatioMode === 'snr') {
    // 如果输入的是 Es/N0，需要转换为 Eb/N0
    // ★ 标了 snr 却没有 phy（老档、或用户只改了口径还没填物理层参数）也走这一支：
    //   每 RE SNR 与 Es/N₀ 在数值上是同一个量，按 Es/N₀ 解读只是丢了「噪声带宽按分配算」这件事；
    //   掉进下面的 Eb/N₀ 分支才是真错 —— 那会把厂家给的门限当成每比特信噪比，整条链错好几 dB。
    esno = inputNoiseRatio;
    ebno = esno - 10 * Math.log10(k);
  } else {
    // 如果输入的是 Eb/N0（默认）
    ebno = inputNoiseRatio;
    esno = ebno + 10 * Math.log10(k);
  }
  
  // ============ 上行站几何计算 ============
  const earthLatRad = earthLat * CONSTANTS.PI / 180;
  
  // 仰角计算
  const deltaLonRad_elev = (orbitPosition - earthLon) * CONSTANTS.PI / 180;
  const cosTerm_elev = Math.cos(earthLatRad) * Math.cos(deltaLonRad_elev);
  const elevationRad = Math.atan(
    (cosTerm_elev - 0.15127) / Math.sqrt(1 - Math.pow(cosTerm_elev, 2))
  );
  const elevation = elevationRad * 180 / CONSTANTS.PI;
  
  // 验证发信站仰角
  const txElevationValidation = validator.validateElevation(elevation, '发信站');
  
  // 方位角计算
  let azimuth;
  if (earthLat > 0) {
    const temp = Math.abs(Math.atan(
      Math.tan((earthLon - orbitPosition) * CONSTANTS.PI / 180) / Math.sin(earthLatRad)
    ) * 180 / CONSTANTS.PI);
    azimuth = (orbitPosition > earthLon) ? 180 - temp : 180 + temp;
  } else {
    const temp = Math.abs(Math.atan(
      Math.tan((earthLon - orbitPosition) * CONSTANTS.PI / 180) / Math.sin(earthLatRad)
    ) * 180 / CONSTANTS.PI);
    azimuth = (orbitPosition > earthLon) ? temp : 360 - temp;
  }
  
  // 极化角计算
  const uplinkPolarizationAngle = calculatePolarizationAngle(earthLon, earthLat, orbitPosition);
  
  // 波束宽度
  const beamWidth = (70 * wavelength) / antennaDiameter;
  
  // 上行天线增益
  const txAntennaGain = 20 * Math.log10((CONSTANTS.PI * antennaDiameter) / wavelength) + 
                        10 * Math.log10(antennaEfficiency);
  
  // 上行站星地距离
  const deltaLonRad_dist = (earthLon - orbitPosition) * CONSTANTS.PI / 180;
  const cosTerm_dist = Math.cos(earthLatRad) * Math.cos(deltaLonRad_dist);
  
  // 使用余弦定理精确计算星地距离
  const earthRadius = CONSTANTS.EARTH_RADIUS;
  const orbitRadius = CONSTANTS.EARTH_RADIUS + CONSTANTS.SATELLITE_ALTITUDE;
  const slantRange = Math.sqrt(Math.pow(earthRadius, 2) + Math.pow(orbitRadius, 2) - 2 * earthRadius * orbitRadius * cosTerm_dist);
  
  // 上行自由空间损耗
  const uplinkFSL = 20 * (Math.log10(uplinkFrequency) + Math.log10(slantRange * 1000)) + 
                    20 * Math.log10((4 * CONSTANTS.PI) / 0.299792458);
  
  // ============ 接收站几何计算 ============
  const rxDeltaLonRad = (orbitPosition - rxLongitude) * CONSTANTS.PI / 180;
  const rxEarthLatRad = rxLatitude * CONSTANTS.PI / 180;
  const rxCosTerm = Math.cos(rxEarthLatRad) * Math.cos(rxDeltaLonRad);
  const rxElevationRad = Math.atan(
    (rxCosTerm - 0.15127) / Math.sqrt(1 - Math.pow(rxCosTerm, 2))
  );
  const rxElevation = rxElevationRad * 180 / CONSTANTS.PI;
  
  // 验证收信站仰角
  const rxElevationValidation = validator.validateElevation(rxElevation, '收信站');
  
  // 接收站方位角
  let rxAzimuth;
  if (rxLatitude > 0) {
    const temp = Math.abs(Math.atan(
      Math.tan(rxDeltaLonRad) / Math.sin(rxEarthLatRad)
    ) * 180 / CONSTANTS.PI);
    rxAzimuth = (orbitPosition > rxLongitude) ? 180 - temp : 180 + temp;
  } else {
    const temp = Math.abs(Math.atan(
      Math.tan(rxDeltaLonRad) / Math.sin(rxEarthLatRad)
    ) * 180 / CONSTANTS.PI);
    rxAzimuth = (orbitPosition > rxLongitude) ? temp : 360 - temp;
  }
  
  // 接收站极化角
  const downlinkPolarizationAngle = calculatePolarizationAngle(rxLongitude, rxLatitude, orbitPosition);
  
  // 接收站星地距离
  const rxDeltaLonRad_dist = (rxLongitude - orbitPosition) * CONSTANTS.PI / 180;
  const rxCosTerm_dist = Math.cos(rxLatitude * CONSTANTS.PI / 180) * Math.cos(rxDeltaLonRad_dist);
  
  // 使用余弦定理精确计算星地距离
  const rxSlantRange = Math.sqrt(Math.pow(earthRadius, 2) + Math.pow(orbitRadius, 2) - 2 * earthRadius * orbitRadius * rxCosTerm_dist);
  
  // 下行自由空间损耗
  const downlinkFSL = 20 * (Math.log10(downlinkFrequency) + Math.log10(rxSlantRange * 1000)) + 
                      20 * Math.log10((4 * CONSTANTS.PI) / 0.299792458);
  
  // 接收天线增益
  const rxAntennaGain = 20 * Math.log10((CONSTANTS.PI * rxAntennaDiameter) / rxWavelength) + 
                        10 * Math.log10(rxAntennaEfficiency);
  
  // 接收天线半功率波束宽度
  const theta3 = 70 * rxWavelength / rxAntennaDiameter;

  // ============ 大气气体衰减（ITU-R P.676-13 + P.836-6 + P.618-14 §2.5 + P.2041-1）============
  // 统一入口 itu/gasSite.js（与 NGSO 引擎、雨衰页同一函数），口径见该文件头：
  //   p = 100 − 可用度；p ≥ 5% 用 A_G(p)，p < 5% 取 A_G(5%)（P.618-14 式 68），可用度 100%（晴空）取中值 50%；
  //   θ ≥ 5° 走 Annex 2 统计法（γ 逐线、h_o Part 1、水汽 K_w·V(p)），θ < 5° 走 Annex 1 分层射线；
  //   ρ(p) / V(p) 取 P.836-6 年统计图并按 VSCH 换算到站高；站高高于地形（机载）按 P.2041-1 §4.2 折减。
  // 地面温度 Ts（P.835 纬度带 − 6.5 K/km）另供天空噪温的 T_mr（式 70）。
  const uplinkGas = gaseousAttenuationSite({
    f: uplinkFrequency, el: elevation, lat: earthLat, lon: earthLon, hsKm: altitude, pPct: 100 - uplinkAvailability
  });
  const downlinkGas = gaseousAttenuationSite({
    f: downlinkFrequency, el: rxElevation, lat: rxLatitude, lon: rxLongitude, hsKm: rxAltitude, pPct: 100 - rxdownlinkAvailability
  });
  const uplinkAtmosphericAttenuation   = uplinkGas.A;
  const downlinkAtmosphericAttenuation = downlinkGas.A;
  const downlinkTs = surfaceTemperature(rxLatitude, rxAltitude);

  // 雨高（P.839-4 + 0.36 km，与降雨率无关）：机载终端（P.2041-1 §4.3/§4.5）判云柱削减与闪烁闸用
  const uplinkRainHeightKm = rainHeightKm(earthLat, earthLon);
  const downlinkRainHeightKm = rainHeightKm(rxLatitude, rxLongitude);
  
  // ============ 降雨衰减计算 ============
  // 上行降雨衰减
  const uplinkUnavailability = uplinkAvailability / 100;
  const { A001, hR: uplinkRainHeight } = calculateSinglePathRainAttenuation(
    rainRate, uplinkFrequency, uplinkPolarization, earthLat, earthLon, orbitPosition, altitude
  );
  
  // ITU-R P.618-14 公式(8) 换算到目标可用度（p=0 即可用度100% 返回0，即晴天）
  const uplinkRainAttenuation = scaleRainAttenP618_14(
    A001, (1 - uplinkUnavailability) * 100, earthLat, elevation
  );
  
  // 下行降雨衰减
  const { A001: downlinkA001, hR: downlinkRainHeight } = calculateSinglePathRainAttenuation(
    rxRainRate, downlinkFrequency, downlinkPolarization,
    rxLatitude, rxLongitude, orbitPosition, rxAltitude
  );
  
  const downlinkRainAttenuation = scaleRainAttenP618_14(
    downlinkA001, (1 - rxDownlinkAvailability) * 100, rxLatitude, rxElevation
  );

  // ============ 降雨去极化 XPD 计算 (ITU-R P.618-14 §4.1) ============
  // 倾斜角 τ：线极化电场矢量相对当地水平的倾角。考虑卫星几何引起的极化偏转角，
  //   水平极化 H → τ = 极化偏转角；垂直极化 V → τ = 极化偏转角 + 90°；圆极化 C → τ = 45°
  const uplinkXpdTau = uplinkPolarization === 'C'
    ? 45
    : (uplinkPolarization === 'V' ? uplinkPolarizationAngle + 90 : uplinkPolarizationAngle);
  const downlinkXpdTau = downlinkPolarization === 'C'
    ? 45
    : (downlinkPolarization === 'V' ? downlinkPolarizationAngle + 90 : downlinkPolarizationAngle);

  // 雨致 XPD（与同极化降雨衰减取同一时间百分比 p = 100 - 可用度）
  // 第 6 参是 4~6 GHz 专用的雨衰上下文：C 频段要按 6 GHz 重算雨衰再标度，见函数头注
  const uplinkRainXPD = calculateRainXPD_P618_14(
    uplinkRainAttenuation, uplinkFrequency, uplinkXpdTau, elevation, (1 - uplinkUnavailability) * 100,
    { R001: rainRate, pol: uplinkPolarization, lat: earthLat, lon: earthLon, orbitPos: orbitPosition, altitude }
  );
  const downlinkRainXPD = calculateRainXPD_P618_14(
    downlinkRainAttenuation, downlinkFrequency, downlinkXpdTau, rxElevation, (1 - rxDownlinkAvailability) * 100,
    { R001: rxRainRate, pol: downlinkPolarization, lat: rxLatitude, lon: rxLongitude, orbitPos: orbitPosition, altitude: rxAltitude }
  );

  // ============ 云衰减计算 (ITU-R P.840-9) ============
  // 第三参数为超越概率 p（=100-可用度）；p<1% 时 L 封顶在 1% 值，p=0(可用度100%)按晴天返回0。
  // 第六参：终端高于雨高时按 P.2041-1 §4.3 线性削减柱液态水（雨高以下 100%，6 km 以上 0）。
  const uplinkCloudAttenuation = calculateCloudAttenuation(uplinkFrequency, elevation, 100 - uplinkAvailability, earthLat, earthLon,
    cloudLiquidFraction(altitude, uplinkRainHeightKm));
  const downlinkCloudAttenuation = calculateCloudAttenuation(downlinkFrequency, rxElevation, 100 - rxdownlinkAvailability, rxLatitude, rxLongitude,
    cloudLiquidFraction(rxAltitude, downlinkRainHeightKm));

  // ============ 闪烁衰减计算 (ITU-R P.618-14 §2.4.1) ============
  // 终端高于雨高时忽略（P.2041-1 §4.5）
  const uplinkScintillation = scintillationApplies(altitude, uplinkRainHeightKm)
    ? calculateScintillationFading(uplinkFrequency, elevation, antennaDiameter, uplinkAvailability, antennaEfficiency) : 0;
  const downlinkScintillation = scintillationApplies(rxAltitude, downlinkRainHeightKm)
    ? calculateScintillationFading(downlinkFrequency, rxElevation, rxAntennaDiameter, rxdownlinkAvailability, rxAntennaEfficiency) : 0;

  // ============ 总衰减合并 (ITU-R P.618-14 §2.5 公式65/66/67/68) ============
  // p = 超越概率（不可用概率），%
  // 公式 65/66 在 p=5% 分界（p>5% 丢弃雨衰项）；
  // 云衰 AC(p) 取旧版口径：p<1% 封顶在 1% 值（见 calculateCloudAttenuation 内 pEff）
  const uplinkP = 100 - uplinkAvailability;       // 上行超越概率 (%)
  const downlinkP = 100 - rxdownlinkAvailability; // 下行超越概率 (%)

  // 上行总衰减 AT(p)：公式(65) p≤5%；公式(66) p>5%
  let uplinkTotalAttenuation;
  if (uplinkP <= 5) {
    // AT = AG_eff + sqrt((AR + AC_eff)^2 + AS^2)
    uplinkTotalAttenuation = uplinkAtmosphericAttenuation +
      Math.sqrt(Math.pow(uplinkRainAttenuation + uplinkCloudAttenuation, 2) + Math.pow(uplinkScintillation, 2));
  } else {
    // AT = AG_eff + sqrt(AC_eff^2 + AS^2)
    uplinkTotalAttenuation = uplinkAtmosphericAttenuation +
      Math.sqrt(Math.pow(uplinkCloudAttenuation, 2) + Math.pow(uplinkScintillation, 2));
  }

  // 下行总衰减 AT(p)：公式(65) p≤5%；公式(66) p>5%
  let downlinkTotalAttenuation;
  if (downlinkP <= 5) {
    // AT = AG_eff + sqrt((AR + AC_eff)^2 + AS^2)
    downlinkTotalAttenuation = downlinkAtmosphericAttenuation +
      Math.sqrt(Math.pow(downlinkRainAttenuation + downlinkCloudAttenuation, 2) + Math.pow(downlinkScintillation, 2));
  } else {
    // AT = AG_eff + sqrt(AC_eff^2 + AS^2)
    downlinkTotalAttenuation = downlinkAtmosphericAttenuation +
      Math.sqrt(Math.pow(downlinkCloudAttenuation, 2) + Math.pow(downlinkScintillation, 2));
  }

  // ============ 噪声温度计算 ============
  // 天空噪温统一走 itu/p618sky.js（ITU-R P.618-14 §3 式(69)(70)，与 NGSO 引擎、雨衰页同一函数）：
  //   T_sky(A) = T_mr·(1−10^(−A/10)) + 2.7·10^(−A/10)，T_mr = 37.34 + 0.81·Ts（Ts 即上方 P.676 用的地表温度）
  //   A 为除闪烁外的总衰减——气体、云、雨是串联介质，必须先合成衰减再代入（分项相加会算出超过 T_mr 的亮温）。
  // —— 天线噪声温度：'自动' = T_sky(A_G) + 25 K（25 K = 地面溢出/旁瓣拾取工程常数，令自动值在 GEO 典型仰角
  //   落在传统缺省 35/30 K 附近）；'自定义' = 手填值，视为晴空天线噪温。模式缺省/未传 = 自定义。
  // —— 云 / 雨的噪温只取增量：ΔT_云 = T_sky(A_G+A_C) − T_sky(A_G)（云衰常态计入功率链，其噪温常态计入系统噪温）；
  //   ΔT_雨 = T_sky(A_G+A_C+A_R) − T_sky(A_G+A_C)（只在下方「雨致 G/T 劣化」里计入）。可用度 100% 时二者恒为 0。
  const antennaNoiseTempAuto = inputs.rxAntennaNoiseTempMode === '自动' || inputs.rxAntennaNoiseTempMode === 'auto';
  const downlinkSky = skyNoise({
    A_G: downlinkAtmosphericAttenuation, A_C: downlinkCloudAttenuation, A_R: downlinkRainAttenuation, Ts: downlinkTs
  });
  const autoAntennaNoiseTemp = downlinkSky.clear + 25;
  const antennaNoiseTempEff = antennaNoiseTempAuto ? autoAntennaNoiseTemp : antennaNoiseTemp;

  // 雨噪声温度：在气体 + 云之上再叠雨的天空亮温增量
  const rainNoiseTemp = downlinkSky.rain;

  // 云噪声温度：在气体之上叠云的天空亮温增量（云衰已常态计入下行功率链，按吸收/辐射自洽同步计入系统噪温）
  const cloudNoiseTemp = downlinkSky.cloud;

  // 接收系统等效噪声温度（云噪经馈线折算，与天线噪温同参考面）
  const feederLossLinear = Math.pow(10, rxFeederLoss / 10);
  const systemNoiseTempK = (antennaNoiseTempEff / feederLossLinear) +
                           (cloudNoiseTemp / feederLossLinear) +
                           290 * (1 - 1 / feederLossLinear) +
                           receiverNoiseTemp;
  const systemNoiseTempDb = 10 * Math.log10(systemNoiseTempK);
  
  // 地球站G/Te
  const gOverTe = rxAntennaGain - systemNoiseTempDb - rxFeederLoss;
  
  // 降雨衰减引起的G/T下降
  const numerator = systemNoiseTempK + (rainNoiseTemp / feederLossLinear);
  const gOverTdegradation = 10 * Math.log10(numerator / systemNoiseTempK);
  
  // ============ 载波与带宽计算 ============
  const noiseBW = symbolRate * 1; // kHz
  const RXnoiseBW = 10 * Math.log10(noiseBW * 1000); // dBHz
  
  // 载波门限值C/T
  const carrierThreshold = ebno + CONSTANTS.BOLTZMANN + 10 * Math.log10(infoRate * 1000);
  
  // 载波总C/T, C/N
  const carrierTotalCT = carrierThreshold + margin;
  const carrierTotalCN = carrierTotalCT - CONSTANTS.BOLTZMANN - RXnoiseBW;

  // 门限C/N
  const thresholdCN = ebno + 10 * Math.log10(infoRate / noiseBW);
  
  // ============ 其他损耗（用户输入，上下行分别设置）============
  const uplinkMiscLoss = inputs.uplinkOtherLoss !== undefined && inputs.uplinkOtherLoss !== '' && inputs.uplinkOtherLoss !== null
    ? parseFloat(inputs.uplinkOtherLoss)
    : 0.3; // 上行其他损耗 (dB) 默认值0.3dB
  const downlinkMiscLoss = inputs.downlinkOtherLoss !== undefined && inputs.downlinkOtherLoss !== '' && inputs.downlinkOtherLoss !== null
    ? parseFloat(inputs.downlinkOtherLoss)
    : 0.3; // 下行其他损耗 (dB) 默认值0.3dB
  
  // 各项C/T值计算
  const uplinkCT = SFDs - antennaGain - BOi + G_Ts;
  const aciUplinkCT = 10 * Math.log10(transponderBandwidth * 1e6) + 
                      CONSTANTS.BOLTZMANN + aciUplinkFactor;
  const adjUplinkCT = 10 * Math.log10(transponderBandwidth * 1e6) + 
                      CONSTANTS.BOLTZMANN + adjUplinkFactor;
  // 交叉极化隔离度：晴空设备 XPI 与降雨去极化 XPD（ITU-R P.618-14 §4.1）功率合成
  const effectiveXpolUplinkFactor = -10 * Math.log10(
    Math.pow(10, -xpolUplinkFactor / 10) + Math.pow(10, -uplinkRainXPD / 10)
  );
  const xpolUplinkCT = 10 * Math.log10(transponderBandwidth * 1e6) + 
                       CONSTANTS.BOLTZMANN + effectiveXpolUplinkFactor;
  const hpaIntermodCT = 10 * Math.log10(transponderBandwidth * 1e6) + 
                        CONSTANTS.BOLTZMANN + hpaIntermodFactor;
  const downlinkCT = EIRPs - BOo - downlinkFSL - downlinkCloudAttenuation - 
                     downlinkAtmosphericAttenuation + gOverTe - downlinkMiscLoss;
  const aciDownlinkCT = 10 * Math.log10(transponderBandwidth * 1e6) + 
                        CONSTANTS.BOLTZMANN + aciDownlinkFactor;
  const adjDownlinkCT = 10 * Math.log10(transponderBandwidth * 1e6) + 
                        CONSTANTS.BOLTZMANN + adjDownlinkFactor;
  // 交叉极化隔离度：晴空设备 XPI 与降雨去极化 XPD（ITU-R P.618-14 §4.1）功率合成
  const effectiveXpolDownlinkFactor = -10 * Math.log10(
    Math.pow(10, -xpolDownlinkFactor / 10) + Math.pow(10, -downlinkRainXPD / 10)
  );
  const xpolDownlinkCT = 10 * Math.log10(transponderBandwidth * 1e6) + 
                         CONSTANTS.BOLTZMANN + effectiveXpolDownlinkFactor;
  const xpdrIntermodCT = 10 * Math.log10(transponderBandwidth * 1e6) + 
                         CONSTANTS.BOLTZMANN + xpdrIntermodFactor;
  
  // 计算总C/T（对数运算）
  // 先计算上行总C/T
  const uplinkTotalCTLinear = 1 / (
    Math.pow(10, -uplinkCT / 10) +
    Math.pow(10, -aciUplinkCT / 10) +
    Math.pow(10, -adjUplinkCT / 10) +
    Math.pow(10, -xpolUplinkCT / 10) +
    Math.pow(10, -hpaIntermodCT / 10)
  );
  const uplinkTotalCT = 10 * Math.log10(uplinkTotalCTLinear);
  
  // 再计算下行总C/T（含Xpdr互调）
  const downlinkTotalCTLinear = 1 / (
    Math.pow(10, -downlinkCT / 10) +
    Math.pow(10, -aciDownlinkCT / 10) +
    Math.pow(10, -adjDownlinkCT / 10) +
    Math.pow(10, -xpolDownlinkCT / 10) +
    Math.pow(10, -xpdrIntermodCT / 10)
  );
  const downlinkTotalCT = 10 * Math.log10(downlinkTotalCTLinear);
  
  // 最后合并上下行得到总C/T
  const totalCTLinear = 1 / (
    Math.pow(10, -uplinkTotalCT / 10) +
    Math.pow(10, -downlinkTotalCT / 10)
  );
  const totalCT = 10 * Math.log10(totalCTLinear);
  
  // ============ UPC补偿计算 ============
  let upcMargin = 0;
  const upcRawValue = (uplinkPowerControl || '').toString().trim();
  
  if (upcRawValue === '是' || upcRawValue.toLowerCase() === 'yes') {
    // UPC开启：补偿所有上行降雨衰减
    upcMargin = uplinkRainAttenuation;
  } else if (upcRawValue === '自定义') {
    // UPC自定义：使用用户输入的UPC数值作为UPC余量
    const customUpcValue = parseFloat(inputs.upcValue);
    if (!isNaN(customUpcValue) && isFinite(customUpcValue)) {
      upcMargin = Math.max(0, customUpcValue);
    }
  }
  
  const residualRainLoss = Math.max(0, uplinkRainAttenuation - upcMargin);
  const extraUPCGain = Math.max(0, upcMargin - uplinkRainAttenuation);
  const totalCTRain = totalCT - residualRainLoss;
  
  // ============ C/N计算 ============
  // 载波上行C/T（目标分配，仅用于详情的载波上行C/T·C/N₀展示）
  const actualUplinkCT = uplinkTotalCT - totalCT + carrierTotalCT;
  

  
  // ============ 链路余量计算 ============
  const linkmargin = carrierTotalCN - thresholdCN;
  
  // ============ 转发器容量计算 ============
  // 转发器容量 - 上行降雨
  const transponderCapacity = totalCTRain - carrierTotalCT;
  
  // 每载波占卫星EIRPs - 上行降雨
  const eirpPerCarrier = EIRPs - BOo - transponderCapacity;
  
  // 上行雨天功率占比
  const uplinkPowerRatio = Math.pow(10, (eirpPerCarrier - EIRPs + BOo) / 10) * 100;
  
  // 下行降雨干扰计算
  // 先计算上行总C/T（上行部分不变）
  const rainUplinkTotalCTLinear = 1 / (
    Math.pow(10, -uplinkCT / 10) +
    Math.pow(10, -aciUplinkCT / 10) +
    Math.pow(10, -adjUplinkCT / 10) +
    Math.pow(10, -xpolUplinkCT / 10) +
    Math.pow(10, -hpaIntermodCT / 10)
  );
  const rainUplinkTotalCT = 10 * Math.log10(rainUplinkTotalCTLinear);
  
  // 再计算下行总C/T（考虑下行降雨衰减和G/T恶化，含Xpdr互调）
  const rainDownlinkTotalCTLinear = 1 / (
    Math.pow(10, -(downlinkCT - downlinkRainAttenuation - gOverTdegradation) / 10) +
    Math.pow(10, -aciDownlinkCT / 10) +
    Math.pow(10, -adjDownlinkCT / 10) +
    Math.pow(10, -xpolDownlinkCT / 10) +
    Math.pow(10, -xpdrIntermodCT / 10)
  );
  const rainDownlinkTotalCT = 10 * Math.log10(rainDownlinkTotalCTLinear);
  
  // 合并上下行得到下行雨卫星总C/T
  const totalInterferenceLinear = 1 / (
    Math.pow(10, -rainUplinkTotalCT / 10) +
    Math.pow(10, -rainDownlinkTotalCT / 10)
  );
  
  // 下行雨卫星总C/T
  const downlinkComponent = 10 * Math.log10(totalInterferenceLinear);
  const downlinkPowerRatio = Math.pow(10, (EIRPs - BOo - downlinkComponent + 
                                           carrierTotalCT - EIRPs + BOo) / 10) * 100;
  
  // 转发器容量 - 下行降雨
  const RXtransponderCapacity = downlinkComponent - carrierTotalCT;
    // 载波下行C/T（目标分配，仅用于详情的载波下行C/T·C/N₀展示）
  const actualDownlinkCT = downlinkTotalCT - totalCT + carrierTotalCT;
  // 下行降雨 - 载波占有卫星有效全向辐射功率
  const RXeirpPerCarrier = EIRPs - BOo - RXtransponderCapacity;
  
  // ============ 带宽和功率占用 ============
  const bandwidthUsageRatio = (allocBandwidth / (transponderBandwidth * 1000)) * 100;
  const powerUsageRatio = Math.max(uplinkPowerRatio, downlinkPowerRatio);
  const PowerBW = powerUsageRatio * transponderBandwidth * 10;
  
  // 转发器资源受限判断和最大载波数计算
  const transponderLimitedBy = bandwidthUsageRatio >= powerUsageRatio ? '带宽' : '功率';
  const maxCarrierByBandwidth = Math.floor(100 / bandwidthUsageRatio);
  const maxCarrierByPower = Math.floor(100 / powerUsageRatio);
  const maxCarrierCount = Math.min(maxCarrierByBandwidth, maxCarrierByPower);
  
  // ============ 功放计算 ============
  const basePaBackoff = paBackoff;
  const totalPaBackoff = basePaBackoff + extraUPCGain;
  

  
  // 上行功率计算（使用精细化损耗替代0.6dB）
  const UPPOWER = (SFDs - BOi + uplinkFSL - antennaGain - transponderCapacity + 
                  totalCTRain - totalCT + uplinkRainAttenuation + uplinkMiscLoss + uplinkCloudAttenuation) - 
                  txAntennaGain + feederLoss + uplinkAtmosphericAttenuation;
  
  // 下行功率计算
  const totalInterference = Math.pow(10, -uplinkCT / 10) +
    Math.pow(10, -aciUplinkCT / 10) +
    Math.pow(10, -adjUplinkCT / 10) +
    Math.pow(10, -xpolUplinkCT / 10) +
    Math.pow(10, -hpaIntermodCT / 10) +
    Math.pow(10, -downlinkCT / 10) +
    Math.pow(10, -aciDownlinkCT / 10) +
    Math.pow(10, -adjDownlinkCT / 10) +
    Math.pow(10, -xpolDownlinkCT / 10) +
    Math.pow(10, -xpdrIntermodCT / 10);
  const interferenceTerm = 10 * Math.log10(totalInterferenceLinear);
  
  // 下行功率计算（使用精细化损耗替代0.6dB）
  const DOWNPOWER = (SFDs - BOi + uplinkFSL - antennaGain - interferenceTerm + 
                    carrierTotalCT) - 
                    txAntennaGain + feederLoss + uplinkRainAttenuation + uplinkAtmosphericAttenuation  + uplinkMiscLoss + uplinkCloudAttenuation;
  
  // 选择功率类型 - 使用高精度计算
  const selectedPower = (uplinkPowerRatio > downlinkPowerRatio) ? UPPOWER : DOWNPOWER;
  // 保持完整精度，仅在最终显示时四舍五入
  const selectedPowerW = Math.pow(10, selectedPower / 10);
  
  // 功放最大输出功率 - 使用高精度计算
  const paRecommendationdB = selectedPower + totalPaBackoff;
  const paRecommendation = Math.pow(10, paRecommendationdB / 10);
  
  // ============ EIRP和通量密度 ============
  const stationEIRP = selectedPower + txAntennaGain - feederLoss;
  // 根据上下行功率占比选择实际转发器回退
  const actualTransponderCapacity = (uplinkPowerRatio > downlinkPowerRatio) ? transponderCapacity : RXtransponderCapacity;
  const PFDc = SFDs - BOi - actualTransponderCapacity;

  // 转发器输出EIRP（每载波）：卫星饱和EIRP - 输出回退 - 转发器工作区回退
  const transponderOutputEIRP = EIRPs - BOo - actualTransponderCapacity;

  // ============ 上/下行 C/N 评估（按主导降雨场景分别计算）============
  // 与链路瀑布功率链一致：先沿功率链得到“热噪声 C/N”，再与干扰 C/I 噪声并联合成实际 C/N，
  // 干扰损失 = 热噪声 C/N − 实际 C/N（反算）。
  // 主导场景：上行降雨占主导时，下行按晴空（下行雨衰与 G/T 劣化不参与）；
  //          下行降雨占主导时，下行计入雨衰与 G/T 劣化，上行雨衰按实际值参与。
  const uplinkRainDominant = uplinkPowerRatio > downlinkPowerRatio;

  // 下行干扰损失（真实四路 ACI/ASI/XPI/IM 并联代价，按主导场景取口径）：
  //   上行主导（下行按晴空）= downlinkCT − downlinkTotalCT；
  //   下行主导（下行计雨衰与 G/T 劣化；干扰项 C/I 同路径同衰减、不随雨变）= 雨口径热噪 C/T − 雨口径总 C/T。
  // 供瀑布行级取数——此前瀑布该行由反解 downlinkCN 取残差，会把上行残余雨衰错计入干扰行（标签失真可达数 dB）。
  const downlinkInterferenceLoss = uplinkRainDominant
    ? (downlinkCT - downlinkTotalCT)
    : ((downlinkCT - downlinkRainAttenuation - gOverTdegradation) - rainDownlinkTotalCT);

  // 上行：到达卫星载波电平 → 热噪声 C/N（始终含上行雨衰）
  const cLevelAtSatellite = stationEIRP - uplinkFSL - uplinkAtmosphericAttenuation -
                            uplinkRainAttenuation - uplinkCloudAttenuation - uplinkMiscLoss;
  // 实际到达卫星通量密度：到达卫星载波电平 + 卫星单位面积增益（与级联自洽，含实际上行雨衰）
  const arrivalPFDAtSatellite = cLevelAtSatellite + antennaGain;
  const uplinkThermalCN = cLevelAtSatellite + G_Ts - CONSTANTS.BOLTZMANN - RXnoiseBW;
  // 上行干扰损失（dB）：纯干扰造成的 C/N 退化 = 仅热噪声上行 C/T − 含干扰上行总 C/T
  // EIRP、雨衰、带宽、k 等热噪声项在差值中抵消，结果只反映 ACI/ASI/XPI/IM 干扰，与降雨解耦
  const uplinkInterferenceLoss = uplinkCT - uplinkTotalCT;
  // 上行 C/N = 热噪声 C/N − 干扰损失
  const uplinkCN = uplinkThermalCN - uplinkInterferenceLoss;
  // 上行干扰等效 C/I（仅展示，由热噪声与实际 C/N 反推）
  const uplinkInterferenceCN = -10 * Math.log10(
    Math.max(Math.pow(10, -uplinkCN / 10) - Math.pow(10, -uplinkThermalCN / 10), 1e-30)
  );

  // 下行：到达地面载波电平 → 热噪声 C/N（仅下行降雨占主导时计入下行雨衰与 G/T 劣化）
  const downlinkRainEff = uplinkRainDominant ? 0 : downlinkRainAttenuation;
  const downlinkGtDegEff = uplinkRainDominant ? 0 : gOverTdegradation;
  const cLevelAtGround = transponderOutputEIRP - downlinkFSL - downlinkAtmosphericAttenuation -
                         downlinkRainEff - downlinkCloudAttenuation - downlinkMiscLoss;
  // 实际到达地面通量密度：到达地面载波电平 + 下行单位面积增益（与级联自洽，含实际下行雨衰/其他损耗）
  const rxAntennaUnitAreaGain = 10 * Math.log10(4 * CONSTANTS.PI / (rxWavelength ** 2));
  const arrivalPFDAtGround = cLevelAtGround + rxAntennaUnitAreaGain;
  const downlinkThermalCN = cLevelAtGround + gOverTe - downlinkGtDegEff - CONSTANTS.BOLTZMANN - RXnoiseBW;
  // 下行 C/N 反算：上行 C/N ⊕ 下行 C/N = 合计 C/N，故由合计与上行反算下行（取负真值相减再取负）
  // 下行 C/N = -10·log10( 10^(-合计C/N/10) - 10^(-上行C/N/10) )
  const downlinkCN = -10 * Math.log10(
    Math.pow(10, -carrierTotalCN / 10) - Math.pow(10, -uplinkCN / 10)
  );
  // 下行干扰等效 C/I（仅展示）：由真实四路干扰损失正推 ⊖(热噪−干扰损失, 热噪)，与级联「下行干扰损失」行同源。
  // 不再由反解 downlinkCN 取残差——上行主导 + UPC 未全补偿时残差含上行残余雨衰，会把本行低报数 dB。
  const downlinkInterferenceCN = -10 * Math.log10(
    Math.max(Math.pow(10, -(downlinkThermalCN - downlinkInterferenceLoss) / 10) - Math.pow(10, -downlinkThermalCN / 10), 1e-30)
  );

  // 地球站功率谱密度：EIRP - 10*log10(带宽Hz)
  const stationPSD = stationEIRP - 10 * Math.log10(psdBandwidth * 1000);
  
  // ============ 邻星离轴口径（2026-08-07 移除）============
  // 旁瓣增益/旁瓣 EIRP/旁瓣 PSD、接收旁瓣增益、离轴鉴别度与 ITU-R S.524 的 PSD 门限，
  // 全部由「邻星轨位差 deltaTheta」这一个角度派生。该入参是当年从小程序移植过来的，
  // 平台三窗从来没有它的输入框 —— 引擎只能靠空值回退（GEO 2.5° / NGSO 3°）硬造一个角度，
  // 于是这几项读数全是「基于一个凭空数字」的假合规量，还与真正做邻星协调的干扰分析模块
  // （utils/interference/，有真实站址几何与 UI）各说一套。故整组删除，不留半吊子出参。
  // 要看离轴 EIRP 密度与 S.524 门限，去干扰分析模块 —— 那里的离轴角是真几何算出来的。

  // 卫星功率谱密度：转发器输出EIRP - 10*log10(载波带宽Hz)
  const satellitePSD = transponderOutputEIRP - 10 * Math.log10(psdBandwidth * 1000);
  
  // ============ 卫星到地面 PFD ============
  // 「实际到达 PFD」arrivalPFDAtGround 由级联段给出（= 到达地面载波电平 C + 10·lg(4π/λ²)，整载波，
  // 含大气、雨、云衰减与其他损耗），与下行功率链逐行自洽，只作工作点读数——不拿它去比 RR 限值。

  // ============ RR Art.21 Table 21-4 PFD 限值（RR 2024）============
  // 限值一律查 itu/art21.js（数据 art21Table214.json 从 RR 2024 官方 PDF 逐行抽取）。原手写 if 链已删：
  // 它有 RR 里不存在的 11.7-12.2 / 19.7-21.2 GHz 两行、表外按量级外推、37.5-42.5 GHz 一律 −115 起、
  // 把 1 MHz 限值折成 4 kHz，注释还引用了 RR 里没有的「Table 21-4A / 4A-1 / 4A-2 / 4B」。
  // 比较对象按 No.21.16 取「自由空间传播条件」口径、在该行的参考带宽内：
  //   PFD_ref = EIRP − 10·lg(4π d²) + 10·lg(min(B_ref, B_occ) / B_occ)   （载波均匀谱；B_occ < B_ref 时整个载波落在一个参考带宽里）
  // 评估点 = 收信站：到达角 δ = 收信站仰角，区域 / 国家限定（如 12.2-12.75 GHz 只在 Region 3）按收信站经纬度判。
  // RR 在该频段对 GSO FSS 没有限值（如 19.7-20.2 GHz、11.7-12.2 GHz）时，限值 / 余量出 null。
  // B_occ 取 psdBandwidth（占用带宽，与两个 PSD 同一把尺；DVB 行 ≡ allocBandwidth）。
  const art21Pfd = art21.assessPfd({
    fGHz: downlinkFrequency,
    deltaDeg: rxElevation,
    ctx: { orbit: 'GSO', service: 'FSS', latDeg: rxLatitude, lonDeg: rxLongitude },
    eirpDbw: transponderOutputEIRP,
    slantRangeKm: rxSlantRange,
    occBwHz: psdBandwidth * 1000
  });
  
  // ============ 填充结果对象 ============
  // 误码率显示
  const superscriptMap = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻'
  };
  const berExponentStr = berExponent.toString();
  const superscriptExp = berExponentStr.split('').map(c => superscriptMap[c] || c).join('');
  
  // 极化方式显示映射
  const polarizationDisplayMap = {
    'V': 'V',
    'H': 'H',
    'LHCP': 'LHCP',
    'RHCP': 'RHCP'
  };
  
  // 上行站结果
  results.earthAntennaDiameterResult = antennaDiameter.toFixed(2 + FX);
  results.earthLongitudeResult = earthLon.toFixed(4 + FX);
  results.earthLatitudeResult = earthLat.toFixed(4 + FX);
  results.uplinkPolarizationResult = polarizationDisplayMap[uplinkPolarizationDisplay] || uplinkPolarizationDisplay; // 上行极化方式显示值
  results.elevationResult = elevation.toFixed(2 + FX);
  results.elevationValidation = txElevationValidation;
  results.azimuthResult = azimuth.toFixed(2 + FX);
  // 圆极化时极化角显示为'-'
  results.uplinkPolarizationAngleResult = uplinkPolarization === 'C' ? '-' : uplinkPolarizationAngle.toFixed(2 + FX);
  results.earthAntennaEfficiencyResult = (antennaEfficiency * 100).toFixed(0 + FX); // 回显实际参与计算的效率(对齐下行 rxAntennaEfficiencyResult)
  results.wavelengthResult = wavelength.toFixed(4 + FX);
  results.beamWidthResult = beamWidth.toFixed(2 + FX);
  results.txAntennaGainResult = txAntennaGain.toFixed(2 + FX);  results.feederLossResult = feederLoss.toFixed(2 + FX);
  results.slantRangeResult = slantRange.toFixed(2 + FX);
  results.uplinkFSLResult = uplinkFSL.toFixed(2 + FX);
  results.uplinkRainAttenuation = uplinkRainAttenuation.toFixed(2 + FX);
  results.uplinkRainHeightResult = uplinkRainHeight.toFixed(3 + FX);
  // 上行降雨去极化 XPD (ITU-R P.618-14 §4.1)，无降雨时显示'-'
  results.uplinkRainXPDResult = isFinite(uplinkRainXPD) ? uplinkRainXPD.toFixed(2 + FX) : '-';
  results.effectiveXpolUplinkFactorResult = effectiveXpolUplinkFactor.toFixed(2 + FX);
  results.uplinkCloudAttenuation = uplinkCloudAttenuation.toFixed(2 + FX);
  results.uplinkAtmosphericAttenuationResult = uplinkAtmosphericAttenuation.toFixed(2 + FX);
  results.uplinkAglResult = uplinkGas.agl.toFixed(3 + FX); // 发信站离地高度(km)：> 0 即按 P.2041-1 机载修正（报告据此列 P.2041-1）
  results.uplinkScintillationResult = uplinkScintillation.toFixed(2 + FX); // 上行闪烁衰减 AS(p) (dB)
  results.uplinkTotalAttenuationResult = uplinkTotalAttenuation.toFixed(2 + FX); // 上行总衰减 AT(p) ITU-R P.618-14 §2.5
  results.uplinkCN = uplinkCN.toFixed(2 + FX);
  results.uplinkThermalCN = uplinkThermalCN.toFixed(2 + FX); // 上行热噪声 C/N
  results.uplinkInterferenceCN = uplinkInterferenceCN.toFixed(2 + FX); // 上行干扰 C/I（表达为 C/N）
  results.uplinkRainDominant = uplinkRainDominant; // 上行降雨是否占主导
  results.actualUplinkCT = actualUplinkCT.toFixed(2 + FX); // 载波上行C/T
  results.actualUplinkCN0 = (actualUplinkCT + 228.6).toFixed(2 + FX); // 载波上行C/N₀
  
  // 其他损耗（用户输入，实际参与链路计算）
  results.uplinkMiscLossResult = uplinkMiscLoss.toFixed(3 + FX); // 上行链路其他损耗(dB) = 其他损耗
  results.downlinkMiscLossResult = downlinkMiscLoss.toFixed(3 + FX); // 下行链路其他损耗(dB) = 其他损耗
  
  // 接收站结果
  results.rxAntennaDiameterResult = rxAntennaDiameter.toFixed(2 + FX);
  results.rxLongitudeResult = rxLongitude.toFixed(4 + FX);
  results.rxLatitudeResult = rxLatitude.toFixed(4 + FX);
  results.downlinkPolarizationResult = polarizationDisplayMap[downlinkPolarizationDisplay] || downlinkPolarizationDisplay; // 下行极化方式显示值
  results.rxElevationResult = rxElevation.toFixed(2 + FX);
  results.rxElevationValidation = rxElevationValidation;
  results.rxAzimuthResult = rxAzimuth.toFixed(2 + FX);
  // 圆极化时极化角显示为'-'
  results.downlinkPolarizationAngleResult = downlinkPolarization === 'C' ? '-' : downlinkPolarizationAngle.toFixed(2 + FX);
  results.rxAntennaEfficiencyResult = (rxAntennaEfficiency * 100).toFixed(0 + FX);
  results.rxWavelengthResult = rxWavelength.toFixed(4 + FX); // 下行波长
  results.rxAntennaGainResult = rxAntennaGain.toFixed(2 + FX);
  results.theta3 = theta3.toFixed(2 + FX);
  results.rxSlantRangeResult = rxSlantRange.toFixed(2 + FX);
  results.downlinkFSLResult = downlinkFSL.toFixed(2 + FX);
  results.downlinkRainAttenuationResult = downlinkRainAttenuation.toFixed(2 + FX);
  results.downlinkRainHeightResult = downlinkRainHeight.toFixed(3 + FX);
  // 下行降雨去极化 XPD (ITU-R P.618-14 §4.1)，无降雨时显示'-'
  results.downlinkRainXPDResult = isFinite(downlinkRainXPD) ? downlinkRainXPD.toFixed(2 + FX) : '-';
  results.effectiveXpolDownlinkFactorResult = effectiveXpolDownlinkFactor.toFixed(2 + FX);
  results.downlinkCloudAttenuation = downlinkCloudAttenuation.toFixed(2 + FX);
  results.downlinkAtmosphericAttenuationResult = downlinkAtmosphericAttenuation.toFixed(2 + FX);
  results.downlinkAglResult = downlinkGas.agl.toFixed(3 + FX); // 收信站离地高度(km)：> 0 即按 P.2041-1 机载修正
  results.downlinkScintillationResult = downlinkScintillation.toFixed(2 + FX); // 下行闪烁衰减 AS(p) (dB)
  results.downlinkTotalAttenuationResult = downlinkTotalAttenuation.toFixed(2 + FX); // 下行总衰减 AT(p) ITU-R P.618-14 §2.5
  results.downlinkCN = downlinkCN.toFixed(2 + FX);
  results.downlinkThermalCN = downlinkThermalCN.toFixed(2 + FX); // 下行热噪声 C/N
  results.downlinkInterferenceCN = downlinkInterferenceCN.toFixed(2 + FX); // 下行干扰 C/I（表达为 C/N）
  results.actualDownlinkCT = actualDownlinkCT.toFixed(2 + FX); // 载波下行C/T
  results.actualDownlinkCN0 = (actualDownlinkCT + 228.6).toFixed(2 + FX); // 载波下行C/N₀
  results.arrivalPFDAtGroundResult = arrivalPFDAtGround.toFixed(2 + FX); // 卫星到地面 PFD（实际到达，含衰减，整载波）：到达地面载波电平 + 10·lg(4π/λ²)，与下行功率链自洽
  // RR Art.21 Table 21-4（RR 2024）：自由空间口径、参考带宽内的到达 PFD 与限值 / 余量。RR 无限值或缺参时为 null（界面显示「—」）
  const a21 = (v) => (v === null || v === undefined || !isFinite(v)) ? null : v.toFixed(2 + FX);
  results.pfdFreeSpaceRefBwResult = a21(art21Pfd.pfdRef); // 自由空间到达 PFD（参考带宽内）dB(W/m²)：EIRP − 10·lg(4πd²) + 10·lg(min(B_ref,B_occ)/B_occ)
  results.ituPfdLimitResult = a21(art21Pfd.limit); // RR 限值（参考带宽内）dB(W/m²)
  results.ituPfdMarginResult = a21(art21Pfd.margin); // 余量 = 限值 − 自由空间到达 PFD（参考带宽内）
  results.ituPfdLimitPerM2 = a21(art21Pfd.limitCarrierBw); // 限值折算到载波占用带宽：限值 + 10·lg(max(B_occ,B_ref)/B_ref)
  results.ituPfdRefBandwidth = art21Pfd.refBwHz ? String(art21Pfd.refBwHz / 1000) : null; // 参考带宽（kHz）：4 / 1000 / 1500
  results.ituPfdRowResult = art21Pfd.rowId || ''; // 适用的 Table 21-4 行（art21Table214.json 的 id）
  results.ituPfdMissingResult = art21Pfd.missing.join(', '); // 判定 / 计算所缺参数
  // 噪声温度
  // 天线噪温：自动模式回报实际所用值（§3 算得），并附模式标注供瀑布/详情区分
  results.antennaNoiseTempResult = antennaNoiseTempAuto ? +antennaNoiseTempEff.toFixed(2 + FX) : antennaNoiseTemp;
  results.antennaNoiseTempModeResult = antennaNoiseTempAuto ? '自动' : '自定义';
  results.receiverNoiseTempResult = receiverNoiseTemp;
  results.rainNoiseTempResult = rainNoiseTemp.toFixed(2 + FX);
  results.cloudNoiseTempResult = cloudNoiseTemp.toFixed(2 + FX); // 云噪声温度(K)，随云衰常态计入系统噪温
  results.systemNoiseTempKResult = systemNoiseTempK.toFixed(2 + FX);
  results.systemNoiseTempDbResult = systemNoiseTempDb.toFixed(2 + FX);
  results.gOverTeResult = gOverTe.toFixed(2 + FX);
  results.gOverTdegradationResult = gOverTdegradation.toFixed(2 + FX);
  results.rxFeederLossResult = rxFeederLoss.toFixed(2 + FX);  
  // 卫星参数
  results.orbitPositionResult = orbitPosition;
  results.EIRPsResult = EIRPs.toFixed(2 + FX);
  results.satellitePSDResult = satellitePSD.toFixed(3 + FX);
  results.SFDsResult = SFDs.toFixed(2 + FX);
  results.satelliteGTResult = G_Ts.toFixed(2 + FX); // 卫星接收 G/T (dB/K)，上行 C/T 转换用
  results.BOiResult = BOi;
  results.BOoResult = BOo;
  results.antennaGainResult = antennaGain.toFixed(2 + FX);
  results.transponderBandwidthResult = transponderBandwidth;
  // 轨道高度（GEO 地球静止轨道固定：35786 km）
  results.orbitAltitudeResult = CONSTANTS.SATELLITE_ALTITUDE.toFixed(0 + FX);
  // 链路时延（GEO单程端到端传播时延）
  // τ = (d_up + d_down) / c，d_up/d_down 为上/下行星地斜距(km)，c = 299792.458 km/s
  // 参考：ITU-R S.1711 / Roddy "Satellite Communications" Ch.2
  const linkDelay = (slantRange + rxSlantRange) / 299792.458 * 1000; // ms
  results.linkDelayResult = linkDelay.toFixed(1 + FX);
  
  // 通信参数
  results.uplinkFrequencyResult = uplinkFrequency.toFixed(2 + FX);
  results.downlinkFrequencyResult = downlinkFrequency.toFixed(2 + FX);
  // 极化方式显示值已在上方设置（使用 polarizationDisplayMap），此处不再重复赋值
  // 信息速率两个来源：DVB 行是表单里那个数（2048 一类），3GPP NTN 行由 TBS ÷ 时长算出来，
  // 常是无限小数。收到 3 位并去尾零——与载波面板写回 form.infoRate 的口径同一把尺（面板与
  // 详细预算不许出现同名两个数），DVB 的整数也照旧不长出小数尾。参与计算的 infoRate 不动。
  results.infoRateResult = roundOut(infoRate, 3);
  results.modulationResult = modulation;
  results.modulationFactorResult = modulationFactor;
  // ★ 3GPP 各表的门限是按【BLER 10% 首传】给的，误码率这一行对它既无意义又误导（值来自 DVB 的
  //   表单缺省），故 snr 行改出「目标 BLER」那一项，这一行留空。DVB 行照旧。
  results.berResult = snrChain ? '' : `1×10${superscriptExp}`;
  results.ebnoResult = ebno.toFixed(2 + FX);
  results.esnoResult = esno.toFixed(2 + FX);
  // 实际 Eb/N₀ / Es/N₀：由实际合成 C/N 折算（门限值 + 链路余量）
  results.ebnoActualResult = (ebno + linkmargin).toFixed(2 + FX);
  results.esnoActualResult = (esno + linkmargin).toFixed(2 + FX);
  // ===== 3GPP NTN（snr 口径）专有出参 =====
  // 每 RE SNR ≡ Es/N₀ ≡ 占用带宽内的 C/N，故 snrThresholdEff 与 esno 恒同数、snrActual 与 esnoActual 恒同数；
  // 两套都出是为了让链路表 / 报表能按体制用对名字，不必在渲染端再判一次口径。DVB 行这几项留空。
  results.snrThresholdResult = snrChain ? snrChain.thresholdTable.toFixed(2 + FX) : '';       // 表值（不含重复折算）
  results.snrThresholdEffResult = snrChain ? snrChain.esno.toFixed(2 + FX) : '';              // 含 N_rep 与合并损失
  results.snrActualResult = snrChain ? (snrChain.esno + linkmargin).toFixed(2 + FX) : '';
  results.noiseBwResult = snrChain ? snrChain.symbolRate.toFixed(3 + FX) : '';                // kHz，= 占用带宽
  results.phyRepResult = snrChain ? String(snrChain.nRep) : '';
  results.phyTbsResult = (snrChain && snrChain.tbsReported != null) ? String(snrChain.tbsReported) : '';   // bit / 时隙(NR) 或 传输块(NB)
  results.phyTbsUnitResult = snrChain ? snrChain.tbsUnit : '';
  // 描述串是数据不是界面文案，中英两版都由引擎现造，渲染端按当前语言挑一份（自动名不许在呈现层翻译）。
  // ★ 这一串只给【链路表】那种一行一条链路的紧凑视图用；纵向的详细计算结果拆成下面逐项出参——
  //   压成「NB-IoT 下行 · 12 子载波 × 15 kHz · I_TBS 4 · ×1」一句，读者得自己拆开才对得上面板。
  results.phyDescResult = snrChain ? ntnPhy.describe(snrChain.phy, 'zh') : '';
  results.phyDescEnResult = snrChain ? ntnPhy.describe(snrChain.phy, 'en') : '';
  // 物理层参数逐项：只出数据，标签由级联表按当前语言给（NR 叫「PRB 数」、NB-IoT 叫「子载波数」）
  results.phyKindResult = snrChain ? snrChain.phy.kind : '';                      // 'nr' | 'nbiot'
  results.phyDirResult = snrChain ? snrChain.phy.dir : '';                        // 'dl' | 'ul'（标签选择用）
  results.phyDirTextResult = snrChain ? ntnPhy.dirLabel(snrChain.phy, 'zh') : '';  // 给人看的那一份，中英
  results.phyDirTextEnResult = snrChain ? ntnPhy.dirLabel(snrChain.phy, 'en') : '';
  results.phyScsResult = snrChain ? String(snrChain.phy.scs) : '';                // 子载波间隔 kHz
  results.phyUnitsResult = snrChain                                               // PRB 数 / 子载波数
    ? String(snrChain.phy.kind === 'nr' ? snrChain.phy.nRb : snrChain.phy.nTones) : '';
  results.phySpanResult = snrChain                                                // NB-IoT 的子帧数 / RU 数
    ? (ntnPhy.nbUnitCount(snrChain.phy) == null ? '' : String(ntnPhy.nbUnitCount(snrChain.phy))) : '';
  results.phyMcsResult = snrChain ? ntnPhy.mcsLabel(snrChain.phy, 'zh') : '';      // NR「表1 · MCS 7」/ NB「4」
  results.phyMcsEnResult = snrChain ? ntnPhy.mcsLabel(snrChain.phy, 'en') : '';
  // NTN 频段（NR 才有；空串 = 老配置没指定频段）。它决定可选的信道带宽档，故要能在结果里看见。
  results.phyBandResult = (snrChain && snrChain.phy.kind === 'nr') ? (snrChain.phy.band || '') : '';
  // 门限那一列的目标 BLER，百分数。3GPP 各表恒 10% 首传；用户在 MODCOD 编辑页改过 meta.bler 后
  // 重新选一次 MODCOD 才生效 —— 与门限同一个不静默口径。
  results.phyBlerResult = snrChain ? (snrChain.blerTarget * 100).toFixed(0) : '';
  // NB-IoT 的有效码率 = (TBS + 24 bit CRC) / 每传输块编码比特数，按【当前】I_SF/I_RU 与部署模式现算
  //（MODCOD 表那一列只是 I_SF/I_RU = 0 的值）。NR 行照旧回显表里的 R，这一项留空。
  results.phyCodeRateResult = (snrChain && snrChain.codeRate != null)
    ? snrChain.codeRate.toFixed(4 + FX) : '';
  // 帧效率显示：保持原始输入格式（分数或小数）
  results.rsCodeResult = rsCodeOriginal;
  // FEC码率显示：保持原始输入格式（分数或小数）
  results.fecResult = fecOriginal;
  // DVB 换算链的三个读数：snr 行没有这三个量（见上方 symbolRate 那段注释），一律留空不报假数
  results.carrierRateResult = snrChain ? '' : carrierRate.toFixed(2 + FX);
  results.ChipRateResult = snrChain ? '' : ChipRate.toFixed(2 + FX);
  results.symbolRateResult = snrChain ? '' : symbolRate.toFixed(2 + FX);
  results.allocBandwidthResult = allocBandwidth;
  // 频谱效率 η = R_info(bps) / B_alloc(Hz) = infoRate(kbps) / allocBandwidth(kHz)
  // 参考：ITU-R S.524 、 Pratt 《Satellite Communications》
  const spectralEfficiency = (allocBandwidth > 0) ? (infoRate / allocBandwidth) : 0; // bps/Hz
  results.spectralEfficiencyResult = spectralEfficiency.toFixed(3 + FX);
  results.noiseBW = noiseBW.toFixed(2 + FX);
  results.RXnoiseBW = RXnoiseBW.toFixed(2 + FX);
  results.marginResult = margin.toFixed(2 + FX);
  
  // 可用度
  results.uplinkAvailabilityResult = uplinkAvailability.toFixed(5 + FX);
  results.downlinkAvailabilityResult = rxdownlinkAvailability.toFixed(5 + FX);
  results.systemAvailabilityResult = systemAvailability;
  // 预计中断时长（基于系统可用度，按年计算）
  const systemUnavailability = (100 - parseFloat(systemAvailability)) / 100;
  const interruptionMinutes = systemUnavailability * 365.25 * 24 * 60;
  const interruptionHours = interruptionMinutes / 60;
  results.interruptionMinutes = interruptionMinutes.toFixed(2 + FX);
  results.interruptionHours = interruptionHours.toFixed(2 + FX);
  
  // C/T和C/N
  results.uplinkCTResult = uplinkCT.toFixed(2 + FX);
  results.uplinkCN0Result = (uplinkCT + 228.6).toFixed(2 + FX);
  results.aciUplinkCTResult = aciUplinkCT.toFixed(2 + FX);
  results.aciUplinkCN0Result = (aciUplinkCT + 228.6).toFixed(2 + FX);
  results.adjUplinkCTResult = adjUplinkCT.toFixed(2 + FX);
  results.adjUplinkCN0Result = (adjUplinkCT + 228.6).toFixed(2 + FX);
  results.xpolUplinkCTResult = xpolUplinkCT.toFixed(2 + FX);
  results.xpolUplinkCN0Result = (xpolUplinkCT + 228.6).toFixed(2 + FX);
  results.hpaIntermodCTResult = hpaIntermodCT.toFixed(2 + FX);
  results.hpaIntermodCN0Result = (hpaIntermodCT + 228.6).toFixed(2 + FX);
  results.downlinkCTResult = downlinkCT.toFixed(2 + FX);
  results.downlinkCN0Result = (downlinkCT + 228.6).toFixed(2 + FX);
  results.aciDownlinkCTResult = aciDownlinkCT.toFixed(2 + FX);
  results.aciDownlinkCN0Result = (aciDownlinkCT + 228.6).toFixed(2 + FX);
  results.adjDownlinkCTResult = adjDownlinkCT.toFixed(2 + FX);
  results.adjDownlinkCN0Result = (adjDownlinkCT + 228.6).toFixed(2 + FX);
  results.xpolDownlinkCTResult = xpolDownlinkCT.toFixed(2 + FX);
  results.xpolDownlinkCN0Result = (xpolDownlinkCT + 228.6).toFixed(2 + FX);
  results.xpdrIntermodCTResult = xpdrIntermodCT.toFixed(2 + FX);
  results.xpdrIntermodCN0Result = (xpdrIntermodCT + 228.6).toFixed(2 + FX);
  results.downlinkTotalCTResult = downlinkTotalCT.toFixed(2 + FX); // 下行总C/T（热噪+四路干扰并联）
  results.downlinkInterferenceLossResult = downlinkInterferenceLoss.toFixed(2 + FX); // 下行真实干扰损失(dB)，按主导场景口径，供瀑布行级取数
  results.totalCTResult = totalCT.toFixed(2 + FX);
  results.totalCN0Result = (totalCT + 228.6).toFixed(2 + FX);
  results.totalCTRainResult = totalCTRain.toFixed(2 + FX);
  results.totalCN0RainResult = (totalCTRain + 228.6).toFixed(2 + FX);
  results.carrierThresholdCT = carrierThreshold.toFixed(2 + FX);
  results.carrierThresholdCN0 = (carrierThreshold + 228.6).toFixed(2 + FX);
  results.carrierTotalCT = carrierTotalCT.toFixed(2 + FX);
  results.carrierTotalCN0 = (carrierTotalCT + 228.6).toFixed(2 + FX);
  results.carrierTotalCN = carrierTotalCN.toFixed(2 + FX);
  results.thresholdCN = thresholdCN.toFixed(2 + FX);
  results.linkmargin = linkmargin.toFixed(2 + FX);
  
  
  
  // 链路计算结果
  
  results.bandwidthUsageRatio = bandwidthUsageRatio.toFixed(3 + FX);
  results.powerUsageRatio = powerUsageRatio.toFixed(3 + FX);
  results.transponderLimitedBy = transponderLimitedBy;
  results.maxCarrierCount = maxCarrierCount;
  results.PowerBWResult = PowerBW.toFixed(3 + FX);
  results.selectedPowerResult = selectedPower.toFixed(3 + FX);
  // 线性瓦数显示：常规值维持 3 位小数；毫瓦级以下改保 4 位有效数字的定点格式（不出科学计数法），
  // 避免小功率被 toFixed(3) 舍成 0.000（显示单位自适应要靠它换 mW/µW 档）
  const fmtW = (w) => (!isFinite(w) || w === 0 || Math.abs(w) >= 0.001)
    ? w.toFixed(3 + FX)
    : w.toFixed(Math.min(12, 3 - Math.floor(Math.log10(Math.abs(w)))) + FX);
  results.selectedPowerWResult = fmtW(selectedPowerW);
  results.paRecommendationdBResult = paRecommendationdB.toFixed(3 + FX);
  results.paRecommendation = fmtW(paRecommendation);
  results.UPCmarginResult = upcMargin.toFixed(2 + FX);
  results.stationEIRPResult = stationEIRP.toFixed(3 + FX);
  results.PFDcResult = PFDc.toFixed(3 + FX);
  results.arrivalPFDAtSatelliteResult = arrivalPFDAtSatellite.toFixed(3 + FX); // 实际到达卫星通量密度（载波电平+单位面积增益）
  results.stationPSDResult = stationPSD.toFixed(3 + FX);
  results.satellitePSDResult = satellitePSD.toFixed(3 + FX);  results.transponderCapacity = transponderCapacity.toFixed(3 + FX);
  results.eirpPerCarrier = eirpPerCarrier.toFixed(3 + FX);
  results.uplinkPowerRatioResult = uplinkPowerRatio.toFixed(3 + FX);
  results.downlinkPowerRatioResult = downlinkPowerRatio.toFixed(3 + FX);
  results.downlinkComponentResult = downlinkComponent.toFixed(3 + FX);
  results.RXtransponderCapacityResult = RXtransponderCapacity.toFixed(3 + FX);
  results.RXeirpPerCarrierResult = RXeirpPerCarrier.toFixed(3 + FX);
  results.actualTransponderCapacityResult = actualTransponderCapacity.toFixed(3 + FX);
  results.transponderOutputEIRP = transponderOutputEIRP.toFixed(3 + FX);
  
  // 转发器回退 (Transponder Backoff) = 卫星的EIRP - 载波占有的EIRP
  // 使用上行雨情况下的载波占有EIRP
  const transponderBackoff = EIRPs - eirpPerCarrier -BOo;
  results.transponderBackoffResult = transponderBackoff.toFixed(3 + FX);

  
  return results;
}

// getDefaultRadomeLoss / calculatePointingLoss 已随「精细化损耗参数」一并删除（定义后从未被调用，
// 对应输入从未参与链路计算）；calculateMiscLossByFrequency 更早已移除。
// 上下行杂项损耗统一使用用户输入的"其他损耗"参数。

// 传播物理函数（闪烁 / 极化偏转角 / P.676 气体 / P.840 云 / P.618 雨衰与 XPD / P.838 系数）
// 已整体移至 ./itu/（C-16 单一真值源，与 NGSO 引擎共用），见文件头的 require。

/**
 * 计算卫星方位角和仰角
 * @param {number} userLat - 用户纬度（度）
 * @param {number} userLon - 用户经度（度）
 * @param {number} satLon - 卫星轨位经度（度）
 * @returns {object} 包含 azimuth（方位角）和 elevation（仰角）的对象
 */
function calculateSatelliteAngle(userLat, userLon, satLon) {
  const earthLatRad = userLat * CONSTANTS.PI / 180;

  // 仰角计算（不取 |cos| —— cosψ<0.1513 时应返回负仰角表示卫星在地平线以下，
  // 原 Math.abs 会把 |Δlon|>90° 的不可见卫星错报为正仰角；与文内雨衰路径同式一致）
  const deltaLonRad_elev = (satLon - userLon) * CONSTANTS.PI / 180;
  const cosTerm_elev = Math.cos(earthLatRad) * Math.cos(deltaLonRad_elev);
  const elevationRad = Math.atan(
    (cosTerm_elev - 0.15127) / Math.sqrt(1 - Math.pow(cosTerm_elev, 2))
  );
  const elevation = elevationRad * 180 / CONSTANTS.PI;
  
  // 方位角计算
  let azimuth;
  if (userLat > 0) {
    const temp = Math.abs(Math.atan(
      Math.tan((userLon - satLon) * CONSTANTS.PI / 180) / Math.sin(earthLatRad)
    ) * 180 / CONSTANTS.PI);
    azimuth = (satLon > userLon) ? 180 - temp : 180 + temp;
  } else {
    const temp = Math.abs(Math.atan(
      Math.tan((userLon - satLon) * CONSTANTS.PI / 180) / Math.sin(earthLatRad)
    ) * 180 / CONSTANTS.PI);
    azimuth = (satLon > userLon) ? temp : 360 - temp;
  }
  
  return {
    azimuth: azimuth,
    elevation: elevation
  };
}

module.exports = {
  calculateLinkBudget,
  calculateSatelliteAngle,
  setOutputPrecisionBoost,            // 出参小数位增量（见文件头 FX），仅参数扫描期间临时抬高
  // ↓ 雨衰计算工具（通用，面向所有种类卫星）复用的纯物理函数——实体在 ./itu/，这里只是再导出。
  calculateSinglePathRainAttenuation, // P.618-14 单路径雨衰 A(0.01%)（第8参 elevOverride 可注入仰角）
  getCoefficients,                    // P.838-3 比衰减系数 k/α（含极化与仰角修正）——实时分支按瞬时雨强逐点求 γ_R 用
  scaleRainAttenP618_14,              // A(0.01%) → 目标时间百分比 p 的雨衰
  calculateRainXPD_P618_14,           // 雨致去极化 XPD
  calculateAtmosphericAttenuation,    // P.676 大气气体吸收
  calculateCloudAttenuation,          // P.840-9 云衰减
  cloudLWCFromLognormal,              // P.840-9 对数正态 Lred(p)（环境场图层取同一口径）
  cloudSpecificAttenuation,           // P.840-9 式(2) 云比衰减系数 Kl(f,T)（介电模型本体；K_L 见 itu/p840.js）
  calculateScintillationFading,       // 对流层闪烁衰落
  calculatePolarizationAngle          // 极化偏转角（供 XPD 的 τ 计算）
};
