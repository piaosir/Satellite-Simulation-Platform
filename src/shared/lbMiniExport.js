// 链路预算配置 → 微信小程序配置（渲染端 ESM，GEO / NGSO 两窗共用）。
//
// 为什么这件事比想象中省事：平台的链路预算引擎是从小程序移植过来的，satParams / linkParams 的
// 字段名两边【逐字相同】（sfdRef · BOi · BOo · G_Ts · rxEIRP · rxAntennaNoiseTemp · uplinkAvailability…）。
// 所以「发送链路配置」不是造一套翻译层，而是把平台的库引用摊平回扁平表单。
//
// ★ 一份小程序配置 = 一条链路。
//   小程序 linkParams 那个 1~8 的键是【工作台上的 8 个草稿位】，不是「一份配置里有 8 条链路」；
//   存一份配置就是把当前那一条存下来。平台的一行本来就是一条自洽链路（自带发信站/收信站/载波/
//   工作点），故【逐行拆】：平台一份 N 行的配置 → N 份小程序配置，每份只写 linkParams["1"]。
//   不铺 2~8 —— 铺默认值等于凭空造 7 条假链路，铺副本更糟。
//
// ★★ 两个必须绕开的坑：
//   坑 1：sfdRef 会被折算两次。params.js 的 buildParams() 在返回前做了引擎入口换算
//         sfdRef = sfdRef + sfdGtRef，而小程序内部的 _engineSatParams 会【再折一次】。
//         故本模块不复用 buildParams，而是镜像它的 target 分流逻辑、【跳过那一步折算】，
//         并把 sfdRef 与 sfdGtRef 都原样送过去，让小程序自己折。
//   坑 2：Vue 响应式代理过不了 IPC。出口一律 JSON 深拷（见 pure()）。
//
// ★★★ 两边的数会不一样，这一条必须说清楚：平台这一年修了 14 项科学性问题（云噪入 T_sys、
//   XPD 标度、P.676 低仰角、P.618 §8 全链路…），小程序没有跟进。故本模块把【平台算出的结果】
//   一并塞进 calculationResults，小程序详情页原样显示、并由信封的 from 标注为平台计算值；
//   用户在小程序里主动点「计算」后覆盖为小程序值。不做静默对齐，也不假装一致。

import { classifyOrbit } from './orbitClass.js'

const pure = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))

// ============================================================================
// 小程序侧的默认值镜像
// ============================================================================
// 取自 miniprogram/app.js 的 getDefaultSatelliteParams / getDefaultLinkParams（权威口径）。
// ★ 为什么要在这里放一份：小程序载入配置是【整块替换】
//   （app.globalData.satelliteParams = config.satelliteParams），不做字段补全。
//   平台没有的字段若不给，小程序界面上那一格就是 undefined —— 输入框空白、选择器索引 -1。
//   故导出一律「先铺一层小程序默认值，再用平台值覆盖」，保证每个界面绑定的键都存在。
// ★★ 改这里之前先对一眼 app.js：这是一份【镜像】，漂了就是小程序界面上凭空多出的空格。

export const MINI_SAT_DEFAULTS = {
  satelliteName: 'Satellite',
  orbitPosition: 110.5,
  frequencyBand: 'Ku',
  uplinkPolarization: 'V',
  sfdRef: -84,
  sfdGtRef: 0,
  transponderBandwidth: 36,
  beamInput: '',
  BOi: 6,
  BOo: 3,
  deltaTheta: 2.5,        // 邻星间隔。平台 UI 无此字段，而两侧引擎的空值回退都是 2.5 → 无口径差
  aciUplinkFactor: 30,
  adjUplinkFactor: 25,
  xpolUplinkFactor: 26,
  hpaIntermodFactor: 24,
  aciDownlinkFactor: 30,
  adjDownlinkFactor: 25,
  xpolDownlinkFactor: 26,
  xpdrIntermodFactor: 21
}

export const MINI_LINK_DEFAULTS = {
  earthStationLocation: '北京',
  antennaDiameter: 6.2,
  longitude: 116.4074,
  latitude: 39.9042,
  centerFrequency: 14.25,
  uplinkPolarization: 'V',
  G_Ts: 2,
  altitude: 47,
  rainRate: 46.167,
  antennaEfficiency: 65,
  paBackoff: 5,
  feederLoss: 3.5,
  uplinkPowerControl: '否',
  uplinkAvailability: 99.90,
  uplinkOtherLoss: 0.3,
  minElevation: 25,
  distanceMode: 'altitude',
  orbitAltitude: 1145,
  slantRange: 2120,
  rxEarthStationLocation: '北京',
  rxAntennaDiameter: 3.7,
  rxLongitude: 116.4074,
  rxLatitude: 39.9042,
  rxCenterFrequency: 12.5,
  downlinkPolarization: 'H',
  rxEIRP: 46,
  rxAltitude: 47,
  rxRainRate: 46.167,
  rxAntennaEfficiency: 65,
  rxAntennaNoiseTemp: 35,
  rxReceiverNoiseTemp: 75,
  rxFeederLoss: 0.2,
  rxDownlinkAvailability: 99.90,
  downlinkOtherLoss: 0.3,
  rxMinElevation: 25,
  rxDistanceMode: 'altitude',
  rxOrbitAltitude: 1145,
  rxSlantRange: 2120,
  dvbStandard: 'custom',
  modcodIndex: -1,
  infoRate: 2048,
  modulation: 'QPSK',
  fec: '3/4',
  rsCode: '188/204',
  m: 1.00,
  bandwidthFactor: 1.20,
  ber: 7,
  ebno: 5.50,
  margin: 3.00,
  calcMode: 'reverse',
  inputPaPower: '',
  rateCalcMode: 'infoRate',
  symbolRate: '--'
}

// 小程序没有、平台也没有对应概念的两项：UPC 自定义值（小程序默认值里没有，但 linkCalculator 确实读它）
// 与余量模式（小程序放在页面 data 里，不在 linkParams 中；这里一并写进去，界面读不到也不碍事）。
const MINI_LINK_EXTRA = { upcValue: 0, marginMode: 'manual' }

// 计算方式的枚举翻译（平台 calcMode → 小程序 calcMode + marginMode）
const CALC_MODE_MAP = {
  margin: { calcMode: 'reverse', marginMode: 'manual' },
  power: { calcMode: 'forward', marginMode: 'manual' },
  balance: { calcMode: 'reverse', marginMode: 'balanced' },
  overbalance: { calcMode: 'reverse', marginMode: 'balanced' }
}

// ============================================================================
// 表单摊平：镜像 buildParams 的 target 分流，但【不做 sfdRef 的引擎入口换算】
// ============================================================================

/**
 * @param {object} P  params.js / ngsoParams.js 模块（提供各 *_FIELDS 常量）
 * @param {object} forms { satForm, carrierForm, txStation, rxStation, txEs, rxEs }
 * @returns {{satParams:object, linkParams:object, op:object}}
 *   op = 求解策略（target:'op'）—— 不进引擎参数，由 buildMiniConfig 翻译成小程序的 calcMode/marginMode
 */
export function toMiniParams(P, { satForm, carrierForm, txStation, rxStation, txEs, rxEs } = {}) {
  const sat = {}
  const link = {}
  const op = {}
  const sf = satForm || {}
  const cf = carrierForm || {}
  const tx = txStation || {}
  const rx = rxStation || {}
  const te = txEs || {}
  const re = rxEs || {}
  // 数值不做全角归一（平台入库时已归一），原样带走
  const put = (obj, key, v) => { if (v !== undefined) obj[key] = v }

  for (const f of P.SAT_FIELDS) put(f.target === 'link' ? link : (f.target === 'op' ? op : sat), f.key, sf[f.key])
  for (const f of P.CARRIER_FIELDS) put(f.target === 'op' ? op : link, f.key, cf[f.key])
  // 收发共用字段（天线口径）：发射链取发信站所选配置、接收链取收信站所选配置
  for (const f of P.ES_COMMON_FIELDS) { put(link, f.key, te[f.key]); if (f.rxKey) put(link, f.rxKey, re[f.key]) }
  for (const f of P.ES_TX_FIELDS) put(f.target === 'op' ? op : (f.target === 'sat' ? sat : link), f.key, te[f.key])
  for (const f of P.ES_RX_FIELDS) put(f.target === 'op' ? op : (f.target === 'sat' ? sat : link), f.key, re[f.key])
  for (const f of P.TX_FIELDS) { if (f.target !== 'meta') put(f.target === 'sat' ? sat : link, f.key, tx[f.key]) }
  for (const f of P.RX_FIELDS) { if (f.target !== 'meta') put(f.target === 'sat' ? sat : link, f.key, rx[f.key]) }
  // ★ 这里【没有】 sfdRef = sfdRef + sfdGtRef —— 小程序的 _engineSatParams 会自己折一次
  return { satParams: sat, linkParams: link, op }
}

// ============================================================================
// 一条链路 → 一份小程序配置
// ============================================================================

/**
 * @param {object} o
 *   mod          'GEO' | 'NGSO'
 *   P            params 模块（同 toMiniParams）
 *   name         配置名（调用方已拼好，形如「中星10R Ku · 北京→上海」）
 *   forms        { satForm, carrierForm, txStation, rxStation, txEs, rxEs }
 *   result       该行的引擎结果 d（可空 —— 没算过就不带结果）
 *   resolvedMargin  求解器最终喂给引擎的余量（功带平衡等方式下由它解出；可空）
 *   beamInput    波束名（小程序有、平台没有的纯文字字段；不参与计算）
 *   ngsoSat      NGSO 卫星条目的 ngsoSat（用于判轨道区制；可空）
 *   note         这一份的来源备注（进 _satsim，不进参数）
 */
export function buildMiniConfig(o = {}) {
  const { mod, P, forms, result, beamInput, ngsoSat } = o
  const isNgso = mod === 'NGSO'
  const { satParams, linkParams, op } = toMiniParams(P, forms || {})

  // —— 卫星参数 ——
  const sp = { ...MINI_SAT_DEFAULTS, ...pure(satParams) }
  sp.orbitType = isNgso ? 'NGSO' : 'GEO'
  if (beamInput) sp.beamInput = String(beamInput)
  // 上行极化在小程序里两处都有（satelliteParams 与 linkParams），引擎读 linkParams 那份；
  // satelliteParams 那份只进界面，两处写同一个值，免得界面与计算说两套。
  if (linkParams.uplinkPolarization !== undefined) sp.uplinkPolarization = linkParams.uplinkPolarization
  if (isNgso) {
    // 轨道区制：平台判五档（GEO/IGSO/MEO/LEO/HEO），小程序只有 LEO/MEO/HEO 三档 → IGSO 归 HEO。
    // 该字段在小程序里只影响轨道高度预设、不进计算，属显示性归并。
    const cls = ngsoOrbitClass(ngsoSat, linkParams.orbitAltitude)
    sp.ngsoOrbitClass = cls === 'IGSO' || cls === 'GEO' ? 'HEO' : cls
    // 平台 NGSO 无「定点轨道经度」（那是 GEO 概念）。留小程序默认值，只作显示占位，不进 NGSO 计算。
    // ★ 轨道倾角要送：小程序 NGSO 界面有这一格（index.wxml 的 satelliteParams.orbitInclination），
    //   且 linkCalculatorNGSO 用它算地球自转对多普勒的贡献分量 v_E_eff = ω_E·r·cos(i)，
    //   缺省回退 50°。平台选星后由轨道根数自动回填（NgsoLinkBudgetApp 的 sf.orbitInclination），
    //   不送就等于让对面拿一个凭空的 50° 去算多普勒，而界面上那一格还是空的。
    if (isNum(sp.orbitInclination)) sp.orbitInclination = Number(sp.orbitInclination)
    else delete sp.orbitInclination       // 手动轨道且没填：宁可空着走小程序自己的回退，不编一个数
  }

  // —— 链路参数（一条链路 → 只写 "1" 这一个槽）——
  const lp = { ...MINI_LINK_DEFAULTS, ...MINI_LINK_EXTRA, ...pure(linkParams) }
  // 小程序没有「天线噪温模式」这个开关，恒用手填的 rxAntennaNoiseTemp。平台默认走「自动」
  // （按 P.618-14 §3 由晴空衰减与仰角实时求取），故把【平台算出来的那个数】写进去；
  // 不写的话小程序按 35 K 默认算，差的那几 K 直接体现在 C/N 上。
  if (String(forms?.rxEs?.rxAntennaNoiseTempMode || '') === '自动' && result && isNum(result.antennaNoiseTempResult)) {
    lp.rxAntennaNoiseTemp = Number(result.antennaNoiseTempResult)
  }
  delete lp.rxAntennaNoiseTempMode        // 小程序引擎不认这个键，留着只会让人以为它生效了

  // 计算方式
  const cm = CALC_MODE_MAP[op.calcMode] || CALC_MODE_MAP.margin
  lp.calcMode = cm.calcMode
  lp.marginMode = cm.marginMode
  if (op.calcMode === 'power' && isNum(op.paPowerW)) lp.inputPaPower = Number(op.paPowerW)
  // 功带平衡/超发：小程序侧的平衡点由它自己的引擎解，与平台不是同一个数。把【平台解出来的余量】
  // 写进 margin，界面上先显示平台的那个工作点；用户在小程序里点「计算」后按它自己的口径重解。
  if (isNum(o.resolvedMargin)) lp.margin = Number(o.resolvedMargin)

  // —— NGSO 几何：送平台算出来的那一组，不让小程序用闭式几何重算 ——
  // 平台 NGSO 是 SGP4 双站互视 + 逐候选跑真实引擎按瓶颈侧取最差路径；小程序只有「最低仰角 +
  // 轨道高度」的闭式几何。只送轨道高度的话两边算的根本不是同一条链路。
  if (isNgso) {
    const g = ngsoGeometryOf(result, linkParams)
    Object.assign(lp, g)
  }

  const cfg = {
    configName: String(o.name || '导入配置'),
    satelliteParams: sp,
    linkParams: { 1: lp },
    calculationResults: result ? { 1: pure(result) } : {},
    noiseRatioMode: linkParams.noiseRatioMode || 'ebno',
    markedParams: [],
    highlightedRows: [],
    // 来源留痕：小程序界面不显示，但「全部信息可获取」。平台侧的计算方式与超发量在小程序里没有
    // 对应概念（见 CALC_MODE_MAP），落在这里而不是悄悄丢掉。
    _satsim: {
      mod: mod || 'GEO',
      calcMode: op.calcMode || 'margin',
      overDb: isNum(op.overDb) ? Number(op.overDb) : 0,
      resolvedMargin: isNum(o.resolvedMargin) ? Number(o.resolvedMargin) : null,
      note: String(o.note || ''),
      ts: Date.now()
    }
  }
  return cfg
}

// 轨道区制：优先按卫星条目里的轨道根数判（选星模式下有 orbit），否则按轨道高度当圆轨道判
function ngsoOrbitClass(ngsoSat, orbitAltitude) {
  const orb = ngsoSat && ngsoSat.orbit
  if (orb) {
    const c = classifyOrbit({
      aKm: orb.aKm, e: orb.e, inclDeg: orb.inclDeg,
      perigeeAltKm: orb.perigeeAltKm, apogeeAltKm: orb.apogeeAltKm, periodMin: orb.periodMin
    })
    if (c) return c
  }
  const h = Number(orbitAltitude)
  if (!Number.isFinite(h)) return 'LEO'
  return classifyOrbit({ aKm: 6378.137 + h, e: 0, inclDeg: 0 })
}

/**
 * NGSO 的几何四件套（收发各一组）。有平台结果就送「最差路径」那一组斜距 + 该时刻的实际仰角，
 * 让小程序原样用；没有结果（没算过）就退回轨道高度模式——那是平台自己的输入，诚实。
 * 轨道高度两侧都留着作显示与回退。
 */
function ngsoGeometryOf(result, linkParams) {
  const alt = Number(linkParams.orbitAltitude)
  const out = {}
  if (Number.isFinite(alt)) { out.orbitAltitude = alt; out.rxOrbitAltitude = alt }
  const up = result && Number(result.slantRangeResult)
  const dn = result && Number(result.rxSlantRangeResult)
  const upEl = result && Number(result.elevationResult)
  const dnEl = result && Number(result.rxElevationResult)
  if (Number.isFinite(up) && up > 0) {
    out.distanceMode = 'slantRange'
    out.slantRange = up
    // 小程序的大气/雨衰按仰角走，斜距与仰角必须是同一时刻的那一对，否则大气路径与几何对不上
    if (Number.isFinite(upEl)) out.minElevation = upEl
  } else {
    out.distanceMode = 'altitude'
    if (isNum(linkParams.minElevation)) out.minElevation = Number(linkParams.minElevation)
  }
  if (Number.isFinite(dn) && dn > 0) {
    out.rxDistanceMode = 'slantRange'
    out.rxSlantRange = dn
    if (Number.isFinite(dnEl)) out.rxMinElevation = dnEl
  } else {
    out.rxDistanceMode = 'altitude'
    if (isNum(linkParams.rxMinElevation)) out.rxMinElevation = Number(linkParams.rxMinElevation)
  }
  return out
}

// ============================================================================
// 配置名：<平台配置名> · <发信站>→<收信站>；同名冲突再追加行号
// ============================================================================
export function miniConfigName(base, txName, rxName, idx, taken) {
  const seg = [txName || '发', rxName || '收'].join('→')
  let nm = `${base || '配置'} · ${seg}`
  if (taken && taken.has(nm)) nm = `${nm} #${(idx || 0) + 1}`
  if (taken) taken.add(nm)
  return nm
}

/**
 * 包内一件：链路配置
 *
 * srcId = 这一条链路在平台侧的稳定身份「<体制>:<配置id>:<行下标>」。
 * ★ 只给绑定投递的【自动同步】用：小程序据它幂等覆盖，做到「平台改了第 3 行 → 手机上那一份
 *   跟着变」，而不是每同步一次就多堆一份同名配置。
 * ★★ 刻意不用配置名当身份：名字里带着发信站→收信站（见 miniConfigName），改个站名就变成
 *    另一份，而改站名恰恰是「同一条链路被改了」最常见的形态。
 * ★★★ 拿不到 id 就留空 —— 主进程退化为内容哈希（见 share.js boxSend）。宁可多出一份，
 *     也不要用不可靠的身份去覆盖掉一份其实不同的东西。
 */
export const miniConfigItem = (cfg, mod, srcId) => ({
  type: 'lb-config',
  name: cfg.configName,
  mod: mod || 'GEO',
  srcId: srcId ? String(srcId) : '',
  config: cfg
})
