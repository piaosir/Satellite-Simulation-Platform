// utils/strictNum.js
// 引擎侧的严格数值解析 —— 与渲染端 src/shared/num.js 的 numStrict（及 src/shared/lbValidate.js 的校验）
// 同一套语法；引擎在 packages/core 里不能 import src，故各存一份，改一处务必改另一处。
//
// 为什么：parseFloat 按前缀解析——从 Excel 贴来的「36 MHz」读成 36、「12,5」读成 12、「1.2.3」读成 1.2，
// 引擎静默算出错数。严格口径：整串（去首尾空白、全角转半角之后）必须是一个十进制数——可带正负号、
// 小数点、科学计数（1e3 / 1.2E-4），别的一概不认。
//
// 不认的串按该字段的缺省算（与留空同一条路），不再把前缀数、也不再把「abc」解出来的 NaN 往下传；
// 界面侧另有逐格标红与计算前预校验（src/shared/lbValidate.js）。
//
// ★ 逐位不变：合法串交给 parseFloat 取值（同一套十进制 → 双精度舍入），number 型照旧 parseFloat(v)，
//   所以对合法输入，严格解析与旧的 parseFloat 结果 Object.is 相等；strictInputs 对合法值原样放行、
//   连对象都不换，引擎下游读到的还是同一个串。证据见 packages/core/test/strictNum.test.mjs
//   （另用快照台把 GEO / NGSO / 再生式 / 端到端 × 计算方式 × 随机合法串的全部出参比过 SHA-256）。
// ★ 求解器内部算出的 NaN（number 型，或 String() 过的 'NaN'）不是用户输入，照旧传，结果里照旧显形——
//   不能拿缺省把它抹成一个像样的数（不可见几何下「设置瓦数」反推出 NaN 余量就是这条路）。

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
// 引擎内部自己造出来的非有限值记号（求解器把 NaN 余量 String() 后再喂回引擎，见 modeSolver.calcWithMargin）：
// 不是用户输入，照旧交给 parseFloat（NaN 照旧往下传、在结果里显形），不能被当成「非法 → 缺省」抹成一个像样的数。
const SPECIAL_RE = /^[+-]?(?:NaN|Infinity)$/;

// 全角 / Unicode 数字变体 → 半角（与 src/shared/num.js 的 toHalf 逐字同口径）
function toHalf(s) {
  return String(s == null ? '' : s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[－−–—―﹣]/g, '-')
    .replace(/＋/g, '+')
    .replace(/[．。]/g, '.');
}

// 整串是否为一个合法十进制数（已去首尾空白、已转半角的串）
function isNumText(s) { return NUM_RE.test(s); }

/**
 * 严格取数：整串是一个十进制数 → 取值（与 parseFloat 逐位同）；空 / 非法 → NaN（与 parseFloat 失败时同形，便于原地替换）。
 * number 型、以及引擎内部的 NaN / Infinity 记号照旧走 parseFloat（旧路径怎么传就怎么传，不在这里改变）。
 * @param {*} v 字符串或 number
 * @returns {number}
 */
function strictNum(v) {
  if (typeof v === 'number') return parseFloat(v);   // 与旧路径同（-0 → 0，NaN 仍是 NaN）
  if (typeof v !== 'string') return NaN;
  let s = v.trim();
  if (!NUM_RE.test(s) && !SPECIAL_RE.test(s)) {
    s = toHalf(s).trim();
    if (!NUM_RE.test(s)) return NaN;
  }
  return parseFloat(s);
}

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * 取数助手：空（'' / null / undefined / 纯空白）或非法 → def；合法 → 数值。
 * 「输入 0 就是 0」不变（不走 `|| def` 那种把 0 当缺省的兜底）。
 */
function pickNum(v, def) {
  if (isBlank(v)) return def;
  if (typeof v === 'number') return parseFloat(v);   // number 型（含内部 NaN）照旧
  if (typeof v !== 'string') return def;
  const t = v.trim();
  if (NUM_RE.test(t) || SPECIAL_RE.test(t)) return parseFloat(t);
  const h = toHalf(t).trim();
  return NUM_RE.test(h) ? parseFloat(h) : def;
}

/**
 * 入参对象的数值键严格化：非法串 → ''（引擎随后按留空取缺省），全角数字 → 半角串；
 * 合法串、number 型（含求解器内部算出来的 NaN）、NaN / Infinity 记号一律原样不动——旧路径怎么读还怎么读。
 * 一个键都没动就原样返回同一个对象（不复制）；动了才浅拷贝，绝不改调用方的对象。
 * @param {object} obj   satParams / linkParams
 * @param {string[]} keys 该对象里按数值解析的键
 */
function strictInputs(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  let out = null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = obj[k];
    if (v === undefined || v === null || v === '' || typeof v === 'number') continue;
    let nv;
    if (typeof v === 'string') {
      const t = v.trim();
      if (NUM_RE.test(t) || SPECIAL_RE.test(t)) continue;   // 合法：原样保留（下游 parseFloat 读到的还是这个串）
      const h = toHalf(t).trim();
      nv = (h !== '' && NUM_RE.test(h)) ? h : '';
    } else {
      nv = '';
    }
    if (!out) out = Object.assign({}, obj);
    out[k] = nv;
  }
  return out || obj;
}

// GEO / NGSO 弯管引擎（及以之为底的再生式）按数值解析的入参键——即 performCalculations 里
// pickNum / parseFloat / islNum / resolveNgsoSlantRange 读的那些（两引擎并集；文本键如 fec「3/4」、
// rsCode「188/204」、站名、极化、模式开关一律不在此列，它们另有各自的解析）。
const LINK_INPUT_NUM_KEYS = [
  'infoRate', 'bandwidthFactor', 'ber', 'ebno', 'margin', 'm',
  'longitude', 'latitude', 'altitude', 'rainRate', 'uplinkAvailability', 'G_Ts',
  'rxLongitude', 'rxLatitude', 'rxAltitude', 'rxRainRate', 'rxDownlinkAvailability', 'rxEIRP',
  'antennaDiameter', 'antennaEfficiency', 'feederLoss', 'paBackoff', 'upcValue', 'uplinkOtherLoss',
  'rxAntennaDiameter', 'rxAntennaEfficiency', 'rxFeederLoss', 'rxAntennaNoiseTemp', 'rxReceiverNoiseTemp', 'downlinkOtherLoss',
  'centerFrequency', 'rxCenterFrequency',
  'minElevation', 'rxMinElevation', 'slantRange', 'rxSlantRange', 'orbitAltitude', 'rxOrbitAltitude',
  's8InclDeg', 's8MinElevUp', 's8MinElevDn', 's8OrbitAltKm'
];
const LINK_SAT_NUM_KEYS = [
  'transponderBandwidth', 'orbitPosition', 'position', 'sfdRef', 'BOi', 'BOo',
  'aciUplinkFactor', 'adjUplinkFactor', 'xpolUplinkFactor', 'hpaIntermodFactor',
  'aciDownlinkFactor', 'adjDownlinkFactor', 'xpolDownlinkFactor', 'xpdrIntermodFactor',
  'cIsl', 'islHops', 'islHopDistance', 'islEirp', 'islGT', 'islFreq', 'islMiscLoss', 'islCI',
  'islOptTxPower', 'islOptTxAperture', 'islOptRxAperture', 'islOptWavelength', 'islOptPointingLoss',
  'islOptSensitivity', 'islOptSensRate', 'islOptSensEbN0'
];

module.exports = { NUM_RE, toHalf, isNumText, strictNum, pickNum, strictInputs, LINK_INPUT_NUM_KEYS, LINK_SAT_NUM_KEYS };
