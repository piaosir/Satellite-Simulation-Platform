// 链路预算参数扫描器（GSO / NGSO / 再生式共用）——「直角坐标系可视化」的算力层。
//
// 做的事很简单：把一条已经配好的链路当成函数 y = f(x)，选定一个入参当自变量，
// 在给定区间上等分取点，逐点重跑一次真实引擎，把每点的全部可绘输出量收下来。
// 于是同一次扫描的结果可以画任意 y，前端换纵轴变量不必再算一遍。
//
// 为什么整段扫描放在主进程一次跑完、而不是渲染端逐点发 IPC：
//   实测单次 GEO 引擎调用 0.073 ms、「功带平衡」二分求解 3 ms，200 点最慢也就 0.6 s；
//   一次 IPC 往返却要毫秒级，逐点发 200 次纯属自找卡顿。这与雨衰窗口 rain:sweep 同一思路。
//
// 诚实边界（务必与界面提示保持一致）：
//   ① 扫描是在「引擎入参」这一层替换自变量，不重跑界面上的联动填值。经纬度轴默认
//      不会跟着改降雨率/海拔——要跟就显式打开 autoGeo，否则同一次扫描里雨区参数
//      前后不一致，曲线就不再是同一个模型的了。
//   ② NGSO / 再生式的站星几何（最差斜距、仰角等）由前端解算后注入 linkParams，
//      本模块不重解。故扫「频率 / 口径 / 功放」一类与几何无关的量是准的；扫经纬度
//      时斜距仍钉在原先解出的那一点，此时结果只能当趋势看。
//   ③ 但「站挪出覆盖区」与「卫星天线增益随站址变」这两件事不能当成趋势糊弄过去，
//      见下方 spec.geo（覆盖门 + 方向图联动）。

const modeSolver = require('./modeSolver.js');
const outputDefs = require('./lbOutputDefs.js');

let regen = null;
try { regen = require('./linkCalculatorRegen.js'); } catch (e) { /* 再生式不可用时该体制的扫描会明确报错 */ }

// 三个引擎的「出参小数位增量」开关（见各引擎文件头的 FX）。逐个容错取用：
// 拿不到的引擎按不支持处理，扫描照常跑，只是那一路仍是取整过的数。
const PRECISION_SETTERS = [];
for (const mod of ['./linkCalculator.js', './linkCalculatorNGSO.js', './linkCalculatorRegen.js']) {
  try {
    const f = require(mod).setOutputPrecisionBoost;
    if (typeof f === 'function') PRECISION_SETTERS.push(f);
  } catch (e) { /* 该引擎不可用 */ }
}

let rainRate = null, elevation = null;
try { rainRate = require('./rainRate.js'); } catch (e) { /* autoGeo 降级为不填 */ }
try { elevation = require('./elevation.js'); } catch (e) { /* 同上 */ }

const MAX_STEPS = 400;   // 与雨衰扫描同一上限：再密对着屏幕像素也分辨不出，纯浪费

// 合成自变量：界面上想扫、但引擎入参里并非单独一项的量。
// 每项声明「写哪些引擎键」，扫描时一并写入，避免用户手动改两处还漏一处。
const SYNTHETIC_AXES = {
  // 可用度：上下行是两个独立入参，工程上却总是一起提的同一个指标
  _availability: { label: '可用度（上下行同调）', unit: '%', keys: ['uplinkAvailability', 'rxDownlinkAvailability'], target: 'link' },
  // 降雨率：同理，收发两站一起给
  _rainRate: { label: '降雨率 R0.01%（收发同调）', unit: 'mm/h', keys: ['rainRate', 'rxRainRate'], target: 'link' },
  // 目标余量：只有「设置余量」计算方式下才是自变量（别的方式下余量是解出来的）
  _margin: { label: '目标系统余量', unit: 'dB', keys: ['margin'], target: 'link', forceMode: 'margin' }
};

function _num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// 按体制取求解器；返回 null 表示该体制不可用
function _solver(engine) {
  if (engine === 'ngso') return modeSolver.computeLinkModeNGSO;
  if (engine === 'regen-up') return regen && regen.computeRegenUplinkMode;
  if (engine === 'regen-down') return regen && regen.computeRegenDownlinkMode;
  if (engine === 'regen-isl') return regen && regen.computeRegenIslMode;
  // 再生式星间「激光」不在此列：其入口是 computeRegenLaserIslMode(params, opt) 的两参形式，
  // 与本模块「(satParams, linkParams, opt) 三参」的调用约定不同，硬套只会静默算错。
  if (engine === 'regen-laser') return null;
  return modeSolver.computeLinkMode;   // 默认 GEO
}

// 经纬度轴的联动重取（autoGeo）：改了站址就顺带把该站的降雨率与海拔按新坐标重查，
// 与界面上经纬度失焦自动填值同一口径。哪一侧的站由自变量键名决定。
function _applyAutoGeo(link, xKey) {
  const rx = xKey === 'rxLatitude' || xKey === 'rxLongitude';
  const lat = _num(rx ? link.rxLatitude : link.latitude);
  const lon = _num(rx ? link.rxLongitude : link.longitude);
  if (lat === null || lon === null) return;
  try {
    if (rainRate) {
      const r = rainRate.queryRainRate(lat, lon);
      if (r && Number.isFinite(r.rainRate)) link[rx ? 'rxRainRate' : 'rainRate'] = String(r.rainRate);
    }
  } catch (e) { /* 查不到就保持原值 */ }
  try {
    if (elevation) {
      const el = elevation.queryElevation(lat, lon);
      if (el && el.success && Number.isFinite(el.altitude)) link[rx ? 'rxAltitude' : 'altitude'] = String(el.altitude);
    }
  } catch (e) { /* 同上 */ }
}

// 经纬度轴：改了要顺带重取雨/海拔的那几个键（见 _applyAutoGeo）
const GEO_KEYS = new Set(['latitude', 'longitude', 'rxLatitude', 'rxLongitude']);

// —— 地理场的「卫星关联」（spec.geo）：覆盖门 + 方向图联动 ——
//
// 地理图把站址铺成平面，可站址一挪，卫星那一端并不是不变的：
//   ① 覆盖：站挪到卫星地平线以下（或低于该站最低工作仰角）就根本建不了链，此处再算出
//      一个 C/N 是假的。这类格整格留白，与链路表「卫星不可见」硬拦截同口径。
//   ② 方向图：接了 GRD 天线的场景，卫星 EIRP / G·T 本就是「卫星天线对该站方向的增益」，
//      站挪一格就换一个离轴角。不重采即等于把当前那一点的增益铺满全图，波束外也满增益。
//      重采还顺带给出第二重覆盖门：网格域外 / 波束背面取不到值 → 同样留白。
//
// spec.geo = {
//   sat:     { lon, lat, alt }          卫星位置（GEO=轨位/0/35786；NGSO=最差时刻 t* 星下点）；
//                                       缺省则不做几何门（如手动圆轨道，压根没有单一星下点）
//   minElev: { tx, rx }                 两端最低工作仰角（°），缺省 0（地平线）
//   pattern: { tx: {...}, rx: {...} }   已匹配的 GRD 天线，按【被扫的那一端】取用：
//                                       扫发信站→tx（写卫星 G/T）、扫收信站→rx（写卫星 EIRP）；
//                                       每项 = { key, file, sat:{lon,lat,alt}, cfg }
// }
// 方向图采样要读盘（.grdbin），核心层不碰 fs：由调用方注入 hooks.samplePattern(pattern, points)
// → (number|null)[]（与 points 等长同序）。见 electron/ipc/register.js 的 link:sweep2D。
const EARTH_R_KM = 6378.137;

// 站点 (lon,lat) 对给定卫星的仰角（度）。cosγ 为站-星地心夹角余弦，
// tan(el) = (cosγ − Re/(Re+h)) / sinγ——GEO 高度下 Re/(Re+h)=0.15127，与 GEO 引擎同式同常数。
function _elevDeg(lonDeg, latDeg, sat) {
  const alt = _num(sat.alt), sLon = _num(sat.lon), sLat = _num(sat.lat) || 0;
  if (sLon === null || alt === null || !(alt > 0)) return null;
  const d2r = Math.PI / 180;
  const la1 = latDeg * d2r, la2 = sLat * d2r;
  let cg = Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos((lonDeg - sLon) * d2r);
  cg = cg > 1 ? 1 : (cg < -1 ? -1 : cg);
  const sg = Math.sqrt(Math.max(0, 1 - cg * cg));
  return Math.atan2(cg - EARTH_R_KM / (EARTH_R_KM + alt), sg) * 180 / Math.PI;
}

// 两根轴是否构成「同一端站址的经纬平面」；是则返回 { side:'tx'|'rx', lonOnX:boolean }。
// 只有这一种组合才谈得上覆盖与方向图（扫「发信站经度 × 收信站纬度」不是一个站的位置）。
function _geoPlane(ax, ay) {
  const SIDE = { longitude: 'tx', latitude: 'tx', rxLongitude: 'rx', rxLatitude: 'rx' };
  const sx = SIDE[ax.key], sy = SIDE[ay.key];
  if (!sx || sx !== sy) return null;
  const lonOnX = ax.key === 'longitude' || ax.key === 'rxLongitude';
  const lonOnY = ay.key === 'longitude' || ay.key === 'rxLongitude';
  if (lonOnX === lonOnY) return null;    // 两轴同为经度或同为纬度：不是地理平面
  return { side: sx, lonOnX };
}

// 引擎自报的「卫星不可见」（负仰角）。GEO 引擎按轨位算仰角后给出，与链路表的硬拦截同一处判据；
// NGSO / 再生式的仰角是入参（前端解算后注入），不会触发，其覆盖门走 spec.geo 的几何判。
function _invisible(d) {
  const bad = (v) => !!(v && v.valid === false);
  return bad(d.elevationValidation) || bad(d.rxElevationValidation);
}

// 扫描期间静音引擎的逐次调试日志。
// 引擎每算一次都会打印入参与整份 170 键结果；单点计算时这是有用的排障线索，
// 批量扫描下却是几千份同样的噪声——既淹没日志窗格，又把耗时绑在 stdout 的快慢上：
// 实测同一份 21×21「功带平衡」网格，输出重定向到空设备是 1.8 ms/格，接到慢管道后
// 退化到 38.7 ms/格（21 倍）。warn / error 不静音：真出错仍要看得见。
function _quiet(fn) {
  const log = console.log, info = console.info, debug = console.debug;
  const noop = function () {};
  console.log = noop; console.info = noop; console.debug = noop;
  try { return fn(); } finally { console.log = log; console.info = info; console.debug = debug; }
}

// 扫描期间让引擎多吐 4 位小数。
//
// 引擎出参是 `数.toFixed(n)` 的字符串，故场值一律落在 10⁻ⁿ 的格子上。单点计算与报表要的
// 正是这个定位数，但扫描要的是场：跨度只有 0.3 dB 的场（上行 C/N 常如此）被 0.01 dB 的
// 取整压成台阶——21×21 网格上相邻格点同值率 64%，等值线只能沿格边走，画出来是一片直角
// 阶梯。渲染端 lbContour.dequantize 能把阶梯抹平，却抹不掉取整本身：实测等值线落点误差
// 未取整 0.01 mdB、取整后 2.0 mdB、去量化后 1.8 mdB（0.12 dB 跨度下约合图上 7 px）。
// 从源头多给 4 位，量化步降到 10⁻⁶ 量级，这条误差直接消失。
//
// 只在扫描期间生效：try/finally 是硬要求——增量漏出去，界面上的单点计算与报表就会变成
// 6 位小数。setOutputPrecisionBoost 返回改动前的值，故原样写回即可精确复位（可嵌套）。
const SWEEP_PRECISION_BOOST = 4;
function _precise(fn) {
  const prev = PRECISION_SETTERS.map((set) => set(SWEEP_PRECISION_BOOST));
  try { return fn(); } finally { PRECISION_SETTERS.forEach((set, i) => set(prev[i])); }
}

// 轴规格 → { write(sat, link, value), geoKey, forceMode, label, unit }。
// 一维与二维扫描共用同一套轴语义：合成轴一次写多个引擎键、普通轴按 target 落到
// 卫星侧或链路侧。写入与「雨/海拔联动」分开：二维时两根轴都可能是经纬度，必须
// 等两轴的值都写完再统一联动一次，否则先写的那一半会用另一半的旧值去查表。
function _axis(a) {
  a = a || {};
  const syn = SYNTHETIC_AXES[a.key] || null;
  const target = syn ? syn.target : a.target;
  const keys = syn ? syn.keys : [a.key];
  return {
    key: a.key,
    keys,
    target,
    forceMode: syn ? syn.forceMode : null,
    geoKey: (!syn && target !== 'sat' && GEO_KEYS.has(a.key)) ? a.key : null,
    label: syn ? syn.label : (a.label || a.key),
    unit: syn ? syn.unit : (a.unit || ''),
    write(sat, link, value) {
      const dst = target === 'sat' ? sat : link;
      for (const k of keys) dst[k] = String(value);
    }
  };
}

// 连续「可行裕度」：>0 可行、<0 不可行、=0 即设计边界。
// 口径与链路表的「合格」判定逐字对应（见各窗 compute()）：
//   设置余量方式——余量是给定的常数，成不成立看资源够不够，故取 100−占用的较小者（百分点）；
//   其余方式——余量是解出来的，直接就是它（dB）。
// 之所以要一个连续量而不是布尔掩码：设计空间图的可行边界靠它的 0 等值线画，
// 连续场插值出来的边界是光滑的，布尔掩码只能画出锯齿状的格子边。
function _feasMargin(d, mode) {
  if (mode === 'margin') {
    const p = _num(d.powerUsageRatio), b = _num(d.bandwidthUsageRatio);
    let m = null;
    if (p !== null) m = 100 - p;
    if (b !== null) m = (m === null) ? 100 - b : Math.min(m, 100 - b);
    return m;
  }
  return _num(d.linkmargin);
}
// 可行裕度的标签与单位（随计算方式变，界面色标/读数直接取用）
function _feasMeta(mode) {
  return mode === 'margin'
    ? { label: '资源余量（100% − 占用）', unit: '百分点', basis: '功率/带宽占用' }
    : { label: '链路余量', unit: 'dB', basis: '链路余量' };
}

// —— 钉住工作点 ——
//
// 地理场图逐格重跑引擎时，工作点**恒定**钉在当前这条链路上：把链路原样搬到每一格，只重算
// 传播与几何，看余量还剩多少 → 答案在「链路余量」，而功放恒等于当前那台。没有开关，也不该
// 有：曾并存的「随站重解」一档（每格按当前计算方式重解工作点，看维持同一目标要多大功放）
// 会让同一个「链路余量」两端不同义——发信站有功放这个自由变量，挪到哪儿求解器都补得回来，
// 图上恒定；收信站没有可调量（弯管的卫星 EIRP 是给定的），图上却是实打实的场。同名不同义，
// 读图的人只会当成程序算错。地图问的是「搬到哪儿还成立」，就只按钉住这一种口径答。
//
// 手法是「开扫前换计算方式」：基准链路解一次，取它解出的工作点，全网格改用「设置功放功率」
// 跑，扫描循环因此一个字都不用改。各体制的自由变量不同，钉法随之不同：
//   geo / ngso / regen-up   自由变量 = 发信站功放。取基准链路解出的功放瓦数，全网格照此跑。
//                           基准格因此与链路表逐字相同。
//   regen-down              自由变量 = 收信站 G/T（「设置余量」方式是反解所需 G/T）。其
//                           'power' 方式的本义就是「按实配 G/T 算可达余量」，故直接切过去即可，
//                           不需要另取工作点。
//   regen-isl / regen-laser 没有地面站，地理场图本就不出现，不会走到这里。
// 两处不钉，都是硬约束而非口径选择：已经是「设置功放功率」方式的，工作点本就钉着，原样返回；
// 基准链路算不出来的，退回逐格重解并如实回传 message（还有一处在调用点，见 sweepLink2D）。
function _pinnedOpt(engine, solve, sat, link, opt) {
  // 已经是「设置功放功率」方式的，工作点本就钉着（再生下行的 'power' 即按实配 G/T 算），原样返回
  if (opt.mode === 'power') {
    return { opt, pin: engine === 'regen-down' ? { kind: 'gt' } : { kind: 'pa', powerW: _num(opt.powerW) } };
  }
  // 基准链路解一次，取它解出的工作点。必须带上出参小数位增量（_precise）：功放瓦数按
  // toFixed(3) 出，NGSO/再生式常在 0.00x W 量级，取整后再喂回去会把基准格的余量带偏零点几 dB
  let r = null;
  try { r = _quiet(() => _precise(() => solve(sat, link, opt))); } catch (e) { r = null; }
  const okr = !!(r && r.success && r.data);
  if (engine === 'regen-down') {
    // 自由变量是收信站 G/T（「设置余量」方式反解所需 G/T）→ 钉住它解出的那个 G/T
    const gt = okr ? _num(r.resolvedGT) : null;
    if (gt === null) return { opt: Object.assign({}, opt, { mode: 'power' }), pin: { kind: 'gt' } };
    return { opt: Object.assign({}, opt, { mode: 'power', gtDb: gt }), pin: { kind: 'gt', gtDb: gt } };
  }
  const w = okr ? _num(r.data.paRecommendation) : null;
  if (!(w > 0)) {
    // 基准链路都算不出来（参数不全/卫星不可见）→ 退回逐格重解，并如实说明，
    // 免得图上明明是另一种口径却不吭声
    return { opt, pin: null, message: '取不到当前链路的功放工作点，本图按逐格重解算出' };
  }
  return { opt: Object.assign({}, opt, { mode: 'power', powerW: w }), pin: { kind: 'pa', powerW: w } };
}

/**
 * 参数扫描。
 * @param {object} spec
 *   engine     'geo' | 'ngso' | 'regen-up' | 'regen-down'
 *   satParams  卫星侧入参（基准值，逐点复制后改自变量）
 *   linkParams 链路侧入参（同上）
 *   opt        计算方式 { mode, powerW, overDb }
 *   x          { key, target:'link'|'sat'|'synthetic', min, max, steps }
 *   keys       可选：只要这些输出键（默认给全清单，便于前端换纵轴不重算）
 *   autoGeo    经纬度轴是否联动重取降雨率/海拔（默认否）
 * @returns { xs, series, ok, fail, message, axis }
 */
function sweepLink(spec) {
  spec = spec || {};
  const x = spec.x || {};
  const min = _num(x.min), max = _num(x.max);
  const steps = Math.max(2, Math.min(MAX_STEPS, Math.round(_num(x.steps) || 61)));
  if (!x.key) return { xs: [], series: {}, ok: 0, fail: 0, message: '未指定自变量' };
  if (min === null || max === null || !(max > min)) {
    return { xs: [], series: {}, ok: 0, fail: 0, message: '扫描区间无效（上限须大于下限）' };
  }

  const solve = _solver(spec.engine);
  if (typeof solve !== 'function') {
    // 分清两种情形：激光星间是「接口形式不同、本通道不支持」，其余才是「引擎没加载起来」
    const msg = spec.engine === 'regen-laser'
      ? '激光星间链路暂不支持参数扫描（其引擎入口与本通道的调用约定不同）'
      : '该体制的计算引擎不可用';
    return { xs: [], series: {}, ok: 0, fail: 0, message: msg };
  }

  const ax = _axis(x);
  const baseSat = spec.satParams || {};
  const baseLink = spec.linkParams || {};
  let baseOpt = Object.assign({}, spec.opt || {});
  // 合成轴可能强制计算方式（如「目标余量」轴只在设置余量方式下有意义）
  if (ax.forceMode) baseOpt.mode = ax.forceMode;
  // 钉住工作点：与二维同一套口径（见 _pinnedOpt），恒定生效、无开关。一维二维本是同一件事
  // 的两个切面，口径一分裂，同一条链路的曲线与场的同一行就对不上账了。
  let pin = null, pinMsg = '';
  if (!ax.forceMode) {
    const p = _pinnedOpt(spec.engine, solve, baseSat, baseLink, baseOpt);
    baseOpt = p.opt; pin = p.pin || null; pinMsg = p.message || '';
  }

  const keys = (Array.isArray(spec.keys) && spec.keys.length) ? spec.keys : outputDefs.ALL_OUTPUT_KEYS;
  const xs = [];
  const series = {};
  for (const k of keys) series[k] = [];

  let ok = 0, fail = 0, firstMsg = '';
  _quiet(() => _precise(() => {
    for (let i = 0; i < steps; i++) {
      const xv = min + (max - min) * i / (steps - 1);
      xs.push(xv);

      const sat = Object.assign({}, baseSat);
      const link = Object.assign({}, baseLink);
      ax.write(sat, link, xv);
      if (spec.autoGeo && ax.geoKey) _applyAutoGeo(link, ax.geoKey);

      let r = null;
      try { r = solve(sat, link, baseOpt); } catch (e) { r = { success: false, message: e && e.message }; }
      // 卫星不可见的点断掉，不出数字（同链路表口径）——引擎在负仰角下照样能算完一整份预算，
      // 但那是把星地距离当成穿过地球的弦长算出来的，画进曲线就是一段假的
      if (r && r.success && r.data && _invisible(r.data)) r = { success: false, message: '卫星不可见（仰角为负）' };
      if (r && r.success && r.data) {
        ok++;
        for (const k of keys) series[k].push(_num(r.data[k]));
      } else {
        fail++;
        if (!firstMsg) firstMsg = (r && r.message) || '计算失败';
        for (const k of keys) series[k].push(null);   // 断点，前端断线不连
      }
    }
  }));

  // 全程为 null 的键（该体制没有这个量）直接剔除，前端的可选纵轴列表就是实际有值的那些
  for (const k of Object.keys(series)) {
    if (!series[k].some((v) => v !== null)) delete series[k];
  }

  return {
    xs,
    series,
    // 本次扫描实际用的工作点：{kind:'pa',powerW} / {kind:'gt'} = 钉住（常态）；
    // null = 逐格重解，只在「目标余量」这类自身即在扫工作点的轴、或基准链路算不出时出现
    pin,
    ok,
    fail,
    message: fail ? ('有 ' + fail + ' 个取值点计算失败：' + firstMsg) : pinMsg,
    axis: { key: ax.key, label: ax.label, unit: ax.unit }
  };
}

// —— 二维扫描（设计空间图的算力层）——
//
// 一维扫描回答「这个参数往哪走」，二维回答「两个参数怎么配」：在 x×y 平面上逐格
// 重跑引擎，于是任一输出量成了一张场，等值线一画就是设计图——要 3 dB 余量，口径
// 与卫星 EIRP 的组合落在哪条线上，一目了然。这是表和一维曲线都给不出的东西。
//
// 网格总格数封顶 MAX_CELLS：逐格都是一次完整引擎调用（「功带平衡」还含二分求解），
// 41×41 已是 1681 次。再密对着屏幕像素也分不出，只会把界面卡住。
const MAX_CELLS = 4225;   // 65×65
const MAX_SIDE = 81;

/**
 * 二维参数扫描。
 * @param {object} spec
 *   engine / satParams / linkParams / opt   同 sweepLink
 *   x, y     { key, target, min, max, steps }：两根自变量轴
 *   keys     可选：只要这些输出键（默认全清单）
 *   autoGeo  经纬度轴是否联动重取降雨率/海拔
 *   geo      可选：地理场的卫星关联（覆盖门 + 方向图联动），见上方 spec.geo 说明
 *   工作点恒定钉在当前链路上（见 _pinnedOpt），不可选
 * @param {object} hooks  可选：{ samplePattern(pattern, points) → (number|null)[] } 方向图取值回调
 * @returns { xs, ys, nx, ny, series:{key:Float64Array}, feas:Float64Array, feasMeta,
 *            ok, fail, masked, message, axisX, axisY }
 *   网格按行主序展开：idx = j*nx + i（i 沿 x、j 沿 y）；算不出与不在覆盖内的格都为 NaN。
 *   Float64Array 直接过 IPC 的结构化克隆（不要 JSON 化，那会把它变成键值对象）。
 */
function sweepLink2D(spec, hooks) {
  spec = spec || {};
  const x = spec.x || {}, y = spec.y || {};
  const bad = (msg) => ({ xs: [], ys: [], nx: 0, ny: 0, series: {}, feas: new Float64Array(0), feasMeta: _feasMeta((spec.opt || {}).mode), ok: 0, fail: 0, masked: 0, message: msg });

  if (!x.key || !y.key) return bad('未指定两根自变量轴');
  if (x.key === y.key) return bad('两根轴不能是同一个参数');
  const x0 = _num(x.min), x1 = _num(x.max), y0 = _num(y.min), y1 = _num(y.max);
  if (x0 === null || x1 === null || !(x1 > x0)) return bad('横轴区间无效（上限须大于下限）');
  if (y0 === null || y1 === null || !(y1 > y0)) return bad('纵轴区间无效（上限须大于下限）');

  let nx = Math.max(2, Math.min(MAX_SIDE, Math.round(_num(x.steps) || 31)));
  let ny = Math.max(2, Math.min(MAX_SIDE, Math.round(_num(y.steps) || 31)));
  if (nx * ny > MAX_CELLS) {
    // 等比压到上限内，保持两边的疏密比例（用户设了 61×21 就不该被压成正方形）
    const s = Math.sqrt(MAX_CELLS / (nx * ny));
    nx = Math.max(2, Math.floor(nx * s));
    ny = Math.max(2, Math.floor(ny * s));
  }

  const solve = _solver(spec.engine);
  if (typeof solve !== 'function') {
    return bad(spec.engine === 'regen-laser'
      ? '激光星间链路暂不支持参数扫描（其引擎入口与本通道的调用约定不同）'
      : '该体制的计算引擎不可用');
  }

  const axX = _axis(x), axY = _axis(y);
  const baseSat = spec.satParams || {};
  const baseLink = spec.linkParams || {};
  let baseOpt = Object.assign({}, spec.opt || {});
  if (axX.forceMode) baseOpt.mode = axX.forceMode;
  if (axY.forceMode) baseOpt.mode = axY.forceMode;
  // 钉住工作点（恒定口径，无开关）：先解一次基准链路定出功放（或对再生下行改用实配 G/T
  // 口径），全网格照此跑。唯一的例外是合成轴强制了计算方式的（如「目标余量」轴）——那根轴
  // 本身就在扫工作点，再钉就自相矛盾。
  let pin = null, pinMsg = '';
  if (!axX.forceMode && !axY.forceMode) {
    const p = _pinnedOpt(spec.engine, solve, baseSat, baseLink, baseOpt);
    baseOpt = p.opt; pin = p.pin || null; pinMsg = p.message || '';
  }

  const keys = (Array.isArray(spec.keys) && spec.keys.length) ? spec.keys : outputDefs.ALL_OUTPUT_KEYS;
  const n = nx * ny;
  const series = {};
  for (const k of keys) series[k] = new Float64Array(n).fill(NaN);
  const feas = new Float64Array(n).fill(NaN);

  const xs = new Float64Array(nx), ys = new Float64Array(ny);
  for (let i = 0; i < nx; i++) xs[i] = x0 + (x1 - x0) * i / (nx - 1);
  for (let j = 0; j < ny; j++) ys[j] = y0 + (y1 - y0) * j / (ny - 1);

  // —— 覆盖门 + 方向图联动（仅「同一端站址的经纬平面」适用，见 spec.geo）——
  // 两件事都在进循环前一次算完：几何仰角是逐格闭式、方向图是一次批量采样（bicubic O(1)/点），
  // 比在循环里逐格发采样请求省下几千次往返；被门掉的格连引擎都不用跑（半个地球的格白算最亏）。
  const plane = _geoPlane(axX, axY);
  const geoCtx = (spec.geo && plane) ? spec.geo : null;
  const cellLon = (i, j) => (plane && plane.lonOnX ? xs[i] : ys[j]);
  const cellLat = (i, j) => (plane && plane.lonOnX ? ys[j] : xs[i]);
  let mask = null;              // Uint8Array：1 = 不在覆盖内，整格留白
  let patVals = null, patKey = '';   // 方向图逐格取值（dB）与要写的引擎入参键
  let maskGeom = 0, maskBeam = 0;    // 分别记两重门掉的格数，供界面说清是哪一种
  if (geoCtx) {
    mask = new Uint8Array(n);
    const sat = geoCtx.sat || null;
    const minEl = _num((geoCtx.minElev || {})[plane.side]) || 0;
    if (sat) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const el = _elevDeg(cellLon(i, j), cellLat(i, j), sat);
          if (el === null || el < minEl) { mask[j * nx + i] = 1; maskGeom++; }
        }
      }
    }
    const pat = (geoCtx.pattern || {})[plane.side];
    if (pat && pat.key && pat.file && hooks && typeof hooks.samplePattern === 'function') {
      const pts = new Array(n);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts[j * nx + i] = { lon: cellLon(i, j), lat: cellLat(i, j) };
      let vals = null;
      try { vals = hooks.samplePattern(pat, pts); } catch (e) { vals = null; }
      if (Array.isArray(vals) && vals.length === n) {
        patVals = vals; patKey = pat.key;
        for (let t = 0; t < n; t++) {
          if (_num(vals[t]) !== null) continue;
          if (!mask[t]) maskBeam++;      // 已被几何门掉的不重复记
          mask[t] = 1;
        }
      }
    }
  }

  let ok = 0, fail = 0, masked = 0, firstMsg = '';
  _quiet(() => _precise(() => {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const sat = Object.assign({}, baseSat);
        const link = Object.assign({}, baseLink);
        axX.write(sat, link, xs[i]);
        axY.write(sat, link, ys[j]);
        // 两轴都写完再联动，故一格最多查一次雨/海拔（两轴同为收/发同一站的经纬度时也只查一次）
        if (spec.autoGeo && (axX.geoKey || axY.geoKey)) _applyAutoGeo(link, axX.geoKey || axY.geoKey);

        const idx = j * nx + i;
        // 站址联动查得的入参也留一份：降雨率与海拔本身就是随经纬度变的地理场，
        // 画在地图上比任何计算结果都直观，也便于核对联动到底取到了什么值。
        // 哪一侧的站由轴键决定（rx* 即收信站）；没开联动时保持 NaN，图上自然留空。
        if (spec.autoGeo && (axX.geoKey || axY.geoKey)) {
          const rxSide = String(axX.geoKey || axY.geoKey).startsWith('rx');
          if (series.siteRainRate) {
            const v = _num(rxSide ? link.rxRainRate : link.rainRate);
            series.siteRainRate[idx] = (v === null) ? NaN : v;
          }
          if (series.siteAltitude) {
            const v = _num(rxSide ? link.rxAltitude : link.altitude);
            series.siteAltitude[idx] = (v === null) ? NaN : v;
          }
        }
        // 不在覆盖内：整格留白，连引擎都不跑。放在站址地理量写入之后——降雨率/海拔是纯地理场，
        // 与卫星见不见得着无关，覆盖区外照样该看得见（图上选这两个量时仍是完整的一张地图）。
        if (mask && mask[idx]) { masked++; continue; }
        // 方向图联动：卫星天线对本格站址方向的增益（多波束最大 Parameter，绝对 dB），
        // 写回卫星 EIRP / G·T——与站表回填同一口径（见各窗 refreshGrdFill），只是逐格重采
        if (patVals) link[patKey] = String(patVals[idx]);

        let r = null;
        try { r = solve(sat, link, baseOpt); } catch (e) { r = { success: false, message: e && e.message }; }
        // 引擎自报「卫星不可见」（GEO 按轨位算出负仰角）→ 与链路表同口径拦下，按不在覆盖内留白。
        // 这一重与上面的几何门互为兜底：没给 spec.geo 的旧调用点也不会再画出穿地球的 C/N。
        if (r && r.success && r.data && _invisible(r.data)) { masked++; maskGeom++; continue; }
        if (r && r.success && r.data) {
          ok++;
          for (const k of keys) {
            if (k === 'siteRainRate' || k === 'siteAltitude') continue;   // 已按联动结果写入，引擎出参里没有这两个键
            const v = _num(r.data[k]);
            series[k][idx] = (v === null) ? NaN : v;
          }
          const fm = _feasMargin(r.data, baseOpt.mode);
          feas[idx] = (fm === null) ? NaN : fm;
        } else {
          fail++;
          if (!firstMsg) firstMsg = (r && r.message) || '计算失败';
          // 该格保持 NaN：等值线遇 NaN 的格直接跳过，不会跨着无解区连出假边界
        }
      }
    }
  }));

  // 全格为 NaN 的键（该体制没有这个量）剔除，前端的可选场变量就是实际有值的那些
  for (const k of Object.keys(series)) {
    let any = false;
    const arr = series[k];
    for (let t = 0; t < n; t++) { if (arr[t] === arr[t]) { any = true; break; } }
    if (!any) delete series[k];
  }

  return {
    xs, ys, nx, ny, series, feas,
    feasMeta: _feasMeta(baseOpt.mode),
    // 本次网格实际用的工作点：{kind:'pa',powerW} / {kind:'gt'} = 钉住（常态）；null = 逐格
    // 重解（「目标余量」轴 / 基准链路算不出的兜底）。界面据此在图下明说钉在了哪儿
    pin,
    ok,
    fail,
    // 不在覆盖内的格：与「算不出」分开报，二者留白的理由完全不同（一个是物理上没有链路，
    // 一个是这一格的计算出了岔子），混成一个数会让人以为图缺了一块是程序出错
    masked,
    maskGeom,
    maskBeam,
    message: fail ? ('有 ' + fail + ' 个网格点计算失败：' + firstMsg) : pinMsg,
    axisX: { key: axX.key, label: axX.label, unit: axX.unit },
    axisY: { key: axY.key, label: axY.label, unit: axY.unit }
  };
}

module.exports = { sweepLink, sweepLink2D, SYNTHETIC_AXES, MAX_STEPS, MAX_CELLS, MAX_SIDE };
