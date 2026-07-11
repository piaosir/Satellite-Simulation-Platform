// 再生式链路预算（v1：再生式上行）参数 schema。
// 由 NGSO 参数集裁剪而来（见 ../ngso/ngsoParams.js）：
//   · 删除「收信站群」整组（星上再生解调，无弯管收信站）；
//   · 卫星改为「卫星群」——像载波信号库一样多份配置，发信站按「卫星」列各自选用一份；
//     卫星配置为纯参数表单（手动轨道高度+倾角，v1 不含 SGP4 选星），删除
//     SFD / G/Tref / IBO / OBO / 转发器带宽 及全部下行/转发器项；
//   · 全部干扰项删除；其中「上行干扰项」(C/ACI · C/ASI · C/XPI · HPA C/IM) 移入发信站列表逐站配置。
//   · 卫星 G/T 从卫星移到发信站——G/T 随波束位置随站而异，是「卫星×发信站」配对量，由各发信站手填（见 uplink 组 G_Ts）。
// 每个字段 target：'sat'→satParams，'link'→linkParams，'meta'→仅 UI（载波信号/卫星 id，不进引擎）。

import { defaultsFor } from '../ngso/ngsoParams.js'

export const FIELD_GROUPS = [
  {
    key: 'carrier', title: '载波与调制', icon: 'wave',
    fields: [
      { key: 'infoRate', label: '信息速率', unit: 'kbps', type: 'num', def: '2048', target: 'link' },
      { key: 'modulation', label: '调制方式', type: 'select', options: ['BPSK', 'QPSK', '8PSK', '16APSK', '32APSK'], def: 'QPSK', target: 'link' },
      { key: 'fec', label: 'FEC 码率', type: 'text', def: '3/4', target: 'link' },
      { key: 'ebno', label: '门限', unit: 'dB', type: 'num', def: '5.50', target: 'link' },
      { key: 'ber', label: '误码率 10⁻ⁿ', unit: 'n', type: 'num', def: '7', target: 'link' },
      { key: 'm', label: '扩频增益', type: 'num', def: '1.00', target: 'link' },
      { key: 'bandwidthFactor', label: '滚降系数 (1+α)', type: 'num', def: '1.20', target: 'link' },
      { key: 'rsCode', label: '帧效率', type: 'text', def: '188/204', target: 'link' },
      { key: 'noiseRatioMode', label: '门限模式', def: 'ebno', target: 'link' },
      { key: 'margin', label: '系统余量', unit: 'dB', type: 'num', def: '3.00', target: 'link' }
    ]
  },
  {
    // 卫星群：每份配置一份表单（手动轨道），发信站「卫星」列选用。删除 SFD/GTref/IBO/OBO/转发器带宽/干扰。
    key: 'sat', title: '卫星群', icon: 'sat',
    fields: [
      { key: 'satelliteName', label: '卫星名称', type: 'text', def: 'Satellite', target: 'sat' },
      { key: 'frequencyBand', label: '工作频段', type: 'select', options: ['L', 'S', 'X', 'ExtC', 'C', 'ExtKu', 'Ku', 'Ku-BSS', 'Ka', 'Q', 'V'], def: 'Ku', target: 'sat' },
      { key: 'centerFrequency', label: '上行频率', tip: '上行中心频率', unit: 'GHz', type: 'num', def: '14.25', target: 'link', pair: 'up' },
      { key: 'uplinkPolarization', label: '上行极化', tip: '上行极化方式', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'V', target: 'link', pair: 'up' },
      // 下行频率/极化：再生式下行模式用（上行模式忽略）。一颗星天然有上/下行两套频率极化，故并入卫星群。
      { key: 'rxCenterFrequency', label: '下行频率', tip: '下行中心频率（再生式下行用）', unit: 'GHz', type: 'num', def: '12.5', target: 'link', pair: 'dn' },
      { key: 'downlinkPolarization', label: '下行极化', tip: '下行极化方式（再生式下行用）', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'H', target: 'link', pair: 'dn' },
      { key: 'orbitAltitude', label: '轨道高度', tip: '圆轨道高度；选星（搜索/天线树）后由所选卫星轨道自动确定', unit: 'km', type: 'num', def: '1145', target: 'link', pair: 'orbit' },
      { key: 'orbitInclination', label: '轨道倾角', tip: '轨道倾角；选星后由所选卫星轨道根数自动确定', unit: '°', type: 'num', def: '53', target: 'sat', pair: 'orbit' }
    ]
  },
  {
    // 发信站群：NGSO 上行站字段 + 「卫星」列（选用哪颗星）+ 卫星G/T（逐站手填）
    // + 上行干扰四项（原在卫星侧，现逐站配置）。
    key: 'uplink', title: '发信站群', icon: 'up',
    fields: [
      // 冻结列（frozen:true）：载波信号配置 · 地面站位置 · 卫星 三列固定不随横向滚动。
      // 地面站位置在前、卫星在后（收信站群仍为旧序），三列均显式冻结，故与城市字段位置无关，恒冻结三列。
      { key: 'basebandId', label: '载波信号配置', type: 'select', options: [], def: '', target: 'meta', frozen: true },
      { key: 'earthStationLocation', label: '地面站位置', type: 'text', def: '北京', target: 'link', city: 'tx', frozen: true },
      { key: 'satelliteId', label: '卫星', type: 'select', options: [], def: '', target: 'meta', frozen: true },
      { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'minElevation', label: '最低仰角', tip: '发信站对卫星的最低工作仰角，决定最差几何（斜距最大）', unit: '°', type: 'num', def: '10', target: 'link' },
      { key: 'altitude', label: '海拔', unit: 'm', type: 'num', def: '47', target: 'link', auto: 'elev' },
      { key: 'antennaDiameter', label: '天线口径', unit: 'm', type: 'num', def: '6.2', target: 'link' },
      { key: 'antennaEfficiency', label: '天线效率', unit: '%', type: 'num', def: '65', target: 'link' },
      // 工作点：可编辑，可在「工作点EIRP(dBW)」与「功放大小(W)」间切换换算（label/unit 由 UI 按 opMode 动态改；
      // target:'op' 不直接进引擎——UI 换算成功放 W 后走 power 模式）。
      { key: 'opPoint', label: '工作点EIRP', unit: 'dBW', type: 'num', def: '50', target: 'op' },
      { key: 'rainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '46.167', target: 'link', auto: 'rain' },
      { key: 'uplinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' },
      { key: 'uplinkPowerControl', label: 'UPC', type: 'select', options: ['否', '是', '自定义'], def: '否', target: 'link' },
      { key: 'upcValue', label: 'UPC值', unit: 'dB', type: 'num', def: '0', target: 'link' },
      { key: 'paBackoff', label: '功放回退', unit: 'dB', type: 'num', def: '5', target: 'link' },
      { key: 'feederLoss', label: '馈线损耗', unit: 'dB', type: 'num', def: '3.5', target: 'link' },
      { key: 'uplinkOtherLoss', label: '综合损耗', tip: '综合损耗：指向/极化/天线罩/接头等未单列损耗之综合', unit: 'dB', type: 'num', def: '0.3', target: 'link' },
      // 上行干扰四项（原在「卫星与转发器」，再生式移入发信站逐站配置；target:'sat' → 送 satParams）
      { key: 'aciUplinkFactor', label: '上行C/ACI', tip: '上行载波/邻道干扰比 (Adjacent Channel Interference)', unit: 'dB', type: 'num', def: '30', target: 'sat', intf: true },
      { key: 'adjUplinkFactor', label: '上行C/ASI', tip: '上行载波/邻星干扰比 (Adjacent Satellite Interference)', unit: 'dB', type: 'num', def: '25', target: 'sat', intf: true },
      { key: 'xpolUplinkFactor', label: '上行C/XPI', tip: '上行载波/交叉极化干扰比 (Cross-Polarization Interference)', unit: 'dB', type: 'num', def: '26', target: 'sat', intf: true },
      { key: 'hpaIntermodFactor', label: 'HPA C/IM', tip: '高功放载波/互调比 (HPA Intermodulation)', unit: 'dB', type: 'num', def: '24', target: 'sat', intf: true },
      // 卫星 G/T（再生式改为逐发信站取值）：同一颗星服务不同站因波束位置不同而 G/T 各异——故 G/T 是
      // 「卫星×发信站」配对量，落在发信站逐站手填。
      { key: 'G_Ts', label: '卫星G/T', tip: '卫星接收品质因数 G/T（dB/K），按本站对该卫星的波束位置手填。', unit: 'dB/K', type: 'num', def: '2', target: 'link' }
    ]
  },
  {
    // 收信站群（再生式下行）：星上再生 → 地面站接收。发信站群的下行镜像：
    //   · 工作点=「收信站 G/T」，由天线口径/效率 + 天线噪温 + 接收机噪温 + 馈线损耗按引擎口径算出
    //     （不再支持「直接输入设备 G/T」——设备 G/T 系统噪温未知，无法自洽推出雨致 G/T 劣化）。
    //   · 上行干扰四项换成下行干扰四项（C/ACI·C/ASI·C/XPI·C/IM，target:'sat'）。
    //   · 「卫星G/T」换成「卫星EIRP」（下行直发，再生无转发器回退）——同一颗星服务不同站因波束位置不同而 EIRP 各异，逐站手填（target:'link'）。
    key: 'downlink', title: '收信站群', icon: 'down',
    fields: [
      { key: 'basebandId', label: '载波信号配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'satelliteId', label: '卫星', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'rxEarthStationLocation', label: '地面站位置', type: 'text', def: '北京', target: 'link', city: 'rx' },
      { key: 'rxLongitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'rxLatitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'rxMinElevation', label: '最低仰角', tip: '收信站对卫星的最低工作仰角，决定最差几何（斜距最大）', unit: '°', type: 'num', def: '10', target: 'link' },
      { key: 'rxAltitude', label: '海拔', unit: 'm', type: 'num', def: '47', target: 'link', auto: 'elev' },
      // —— 工作点 G/T：天线 + 噪温 + 馈线 → 引擎按 gOverTe = 天线增益 − 系统噪温dB − 馈线损耗 算 G/T（含精确雨致 G/T 劣化）——
      { key: 'rxAntennaDiameter', label: '天线口径', unit: 'm', type: 'num', def: '3.7', target: 'link' },
      { key: 'rxAntennaEfficiency', label: '天线效率', unit: '%', type: 'num', def: '65', target: 'link' },
      { key: 'rxAntennaNoiseTemp', label: '天线噪温', unit: 'K', type: 'num', def: '35', target: 'link' },
      { key: 'rxReceiverNoiseTemp', label: '接收机噪温', unit: 'K', type: 'num', def: '75', target: 'link' },
      { key: 'rxFeederLoss', label: '馈线损耗', unit: 'dB', type: 'num', def: '0.2', target: 'link' },
      { key: 'rxRainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '46.167', target: 'link', auto: 'rain' },
      { key: 'rxDownlinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' },
      { key: 'downlinkOtherLoss', label: '综合损耗', tip: '综合损耗：指向/极化/天线罩/接头等未单列损耗之综合', unit: 'dB', type: 'num', def: '0.3', target: 'link' },
      // 下行干扰四项（原在「卫星与转发器」，再生式移入收信站逐站配置；target:'sat' → 送 satParams）
      { key: 'aciDownlinkFactor', label: '下行C/ACI', tip: '下行载波/邻道干扰比 (Adjacent Channel Interference)', unit: 'dB', type: 'num', def: '30', target: 'sat', intf: true },
      { key: 'adjDownlinkFactor', label: '下行C/ASI', tip: '下行载波/邻星干扰比 (Adjacent Satellite Interference)', unit: 'dB', type: 'num', def: '25', target: 'sat', intf: true },
      { key: 'xpolDownlinkFactor', label: '下行C/XPI', tip: '下行载波/交叉极化干扰比 (Cross-Polarization Interference)', unit: 'dB', type: 'num', def: '26', target: 'sat', intf: true },
      { key: 'xpdrIntermodFactor', label: '下行C/IM', tip: '卫星下行载波/互调比 (Intermodulation)', unit: 'dB', type: 'num', def: '21', target: 'sat', intf: true },
      // 卫星下行 EIRP（再生式改为逐收信站取值）：同一颗星服务不同站因波束位置不同而 EIRP 各异——故是
      // 「卫星×收信站」配对量，落在收信站逐站手填。
      { key: 'rxEIRP', label: '卫星EIRP', tip: '卫星下行 EIRP（dBW），按本站对该卫星的波束位置手填。', unit: 'dBW', type: 'num', def: '46', target: 'link' }
    ]
  },
  {
    // 星间链路群（再生式微波 ISL）：发射卫星 → 接收卫星，两星均选自「卫星群」。
    //   · 几何为核心：由两星轨道经 ngsoGeometry.solveIslWorstCase 严格求最差星间距离与互视可见度（另在 UI 计算）。
    //   · 链路预算复用 NGSO 引擎 RF 星间预算：发射 EIRP(islEirp) 在发射卫星、接收 G/T(islGT) 在接收卫星。
    //   · 无地面/大气/雨衰；四项 target:'sat' → satParams；islAtmMargin(target:'geom') 只喂几何求解器，不进链路引擎。
    key: 'isl', title: '星间链路群', icon: 'isl',
    fields: [
      { key: 'basebandId', label: '载波信号配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'txSatelliteId', label: '发射卫星', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'rxSatelliteId', label: '接收卫星', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'islEirp', label: '发射EIRP', tip: '发射卫星星间发射 EIRP（dBW）', unit: 'dBW', type: 'num', def: '45', target: 'sat' },
      { key: 'islGT', label: '接收G/T', tip: '接收卫星星间接收品质因数 G/T（dB/K）', unit: 'dB/K', type: 'num', def: '12', target: 'sat' },
      { key: 'islFreq', label: '星间频率', tip: '星间链路频率（GHz，典型 Ka/V 频段星间）', unit: 'GHz', type: 'num', def: '23', target: 'sat' },
      { key: 'islMiscLoss', label: '综合损耗', tip: '指向/极化/馈线等未单列损耗之综合（dB）', unit: 'dB', type: 'num', def: '1', target: 'sat' },
      { key: 'islAtmMargin', label: '大气余量', tip: 'LOS 视线须高出地表的余量（km）：微波须清过大气；0=纯几何视线（仅避开固体地球）', unit: 'km', type: 'num', def: '100', target: 'geom' }
    ]
  }
]

export const ALL_FIELDS = FIELD_GROUPS.flatMap((g) => g.fields)
const _grp = (k) => FIELD_GROUPS.find((g) => g.key === k).fields
export const CARRIER_FIELDS = _grp('carrier')
export const SAT_FIELDS = _grp('sat')
export const TX_FIELDS = _grp('uplink')
export const RX_FIELDS = _grp('downlink')
export const ISL_FIELDS = _grp('isl')

export { defaultsFor }

// 引擎需要一套完整的 NGSO 弯管入参才能良定求解；再生口径下这些下行/转发器量数学上相消（已冒烟验证）。
// 此处提供占位默认，仅为让引擎跑通，绝不影响再生式上行结果。
const DL_SAT_DEFAULTS = {
  sfdRef: '-84', sfdGtRef: '0', transponderBandwidth: '36', BOi: '6', BOo: '3',
  aciDownlinkFactor: '30', adjDownlinkFactor: '25', xpolDownlinkFactor: '26', xpdrIntermodFactor: '21'
}
const DL_LINK_DEFAULTS = {
  rxCenterFrequency: '12.5', downlinkPolarization: 'H',
  rxAntennaDiameter: '3.7', rxAntennaEfficiency: '65', rxEIRP: '46',
  rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxDownlinkAvailability: '99.90',
  rxFeederLoss: '0.2', downlinkOtherLoss: '0.3'
}

// 组装单条再生式上行链路的 { satParams, linkParams }：某颗卫星(satForm) + 某份载波信号(carrierForm) + 某发信站(txStation)。
export function buildRegenParams(satForm, carrierForm, txStation) {
  const satParams = {}
  const linkParams = {}
  // 卫星群字段按 target 分流
  for (const f of SAT_FIELDS) (f.target === 'link' ? linkParams : satParams)[f.key] = satForm[f.key]
  // 载波
  for (const f of CARRIER_FIELDS) linkParams[f.key] = carrierForm[f.key]
  // 发信站：uplink 链路字段 → linkParams；上行干扰(target:'sat') → satParams；
  // meta(载波信号/卫星 id) 与 op(工作点) 不进引擎（工作点由 UI 换算成功放 W 后走 power 模式）
  for (const f of TX_FIELDS) {
    if (f.target === 'meta' || f.target === 'op') continue
    if (f.target === 'sat') satParams[f.key] = txStation[f.key]
    else linkParams[f.key] = txStation[f.key]
  }
  // 下行/转发器占位（引擎需完整入参；再生口径相消）
  Object.assign(satParams, DL_SAT_DEFAULTS)
  Object.assign(linkParams, DL_LINK_DEFAULTS)
  // 下行地理镜像发信站，使弯管引擎下行几何良定（再生不参与；主计算另注入 rxSlantRange 覆盖）
  linkParams.rxEarthStationLocation = txStation.earthStationLocation
  linkParams.rxLongitude = txStation.longitude
  linkParams.rxLatitude = txStation.latitude
  linkParams.rxMinElevation = txStation.minElevation
  linkParams.rxAltitude = txStation.altitude
  linkParams.rxRainRate = txStation.rainRate
  linkParams.rxOrbitAltitude = linkParams.orbitAltitude
  // 引擎入口换算：有效 sfdRef = sfdRef + sfdGtRef（与 NGSO 一致；此处 sfdGtRef=0 原样）
  const gtRef = parseFloat(satParams.sfdGtRef)
  const sfd = parseFloat(satParams.sfdRef)
  if (gtRef && !isNaN(gtRef) && !isNaN(sfd)) satParams.sfdRef = sfd + gtRef
  // 剥离 Vue 响应式代理，避免经 Electron IPC 结构化克隆报错
  return { satParams: JSON.parse(JSON.stringify(satParams)), linkParams: JSON.parse(JSON.stringify(linkParams)) }
}

// —— 工作点换算：工作点EIRP(dBW) ⇄ 功放大小(W)（与引擎口径一致，已对表验证）——
// 引擎：txAntennaGain = 20lg(πD/λ) + 10lg(η)，stationEIRP = 功放dBW − 功放回退 + 天线增益 − 馈线损耗。
// 频率取该发信站所选卫星的上行中心频率。
const _C_LIGHT = 0.299792458   // GHz·m（λ = c/f）
export function txAntennaGainDbi(diameterM, effPct, freqGHz) {
  const D = parseFloat(diameterM); const eff = parseFloat(effPct); const f = parseFloat(freqGHz)
  if (!(D > 0) || !(eff > 0) || !(f > 0)) return NaN
  const lambda = _C_LIGHT / f
  return 20 * Math.log10(Math.PI * D / lambda) + 10 * Math.log10(eff / 100)
}
// 工作点EIRP(dBW) → 功放大小(W)。station 提供 antennaDiameter/antennaEfficiency/feederLoss/paBackoff，satForm 提供 centerFrequency。
export function eirpToPowerW(eirpDbw, station, satForm) {
  const eirp = parseFloat(eirpDbw); if (isNaN(eirp)) return NaN
  const g = txAntennaGainDbi(station.antennaDiameter, station.antennaEfficiency, satForm.centerFrequency)
  const feeder = parseFloat(station.feederLoss) || 0
  const backoff = parseFloat(station.paBackoff) || 0
  if (isNaN(g)) return NaN
  const paDbw = (eirp - g + feeder) + backoff       // 功放建议功率(dBW)
  return Math.pow(10, paDbw / 10)
}
// 功放大小(W) → 工作点EIRP(dBW)
export function powerWToEirp(powerW, station, satForm) {
  const w = parseFloat(powerW); if (!(w > 0)) return NaN
  const g = txAntennaGainDbi(station.antennaDiameter, station.antennaEfficiency, satForm.centerFrequency)
  const feeder = parseFloat(station.feederLoss) || 0
  const backoff = parseFloat(station.paBackoff) || 0
  if (isNaN(g)) return NaN
  const selectedPower = 10 * Math.log10(w) - backoff
  return selectedPower + g - feeder
}

// ==================== 再生式下行（广播）====================
// 收信站群按弯管口径给引擎喂一套完整入参才能良定求解——再生下行只读引擎的下行损耗/几何中间量，
// 上行侧数学上不参与（引擎跑一次即可）。此处给上行占位默认，仅让引擎跑通，绝不影响再生下行结果。
const UP_SAT_DEFAULTS = {
  sfdRef: '-84', sfdGtRef: '0', transponderBandwidth: '36', BOi: '6', BOo: '3',
  aciUplinkFactor: '30', adjUplinkFactor: '25', xpolUplinkFactor: '26', hpaIntermodFactor: '24'
}
// 上行站占位（不含 centerFrequency/uplinkPolarization——那两项由卫星群供给 linkParams）
const UP_LINK_DEFAULTS = {
  antennaDiameter: '6.2', antennaEfficiency: '65', G_Ts: '2',
  uplinkAvailability: '99.90', uplinkPowerControl: '否', upcValue: '0',
  paBackoff: '5', feederLoss: '3.5', uplinkOtherLoss: '0.3'
}

// 组装单条再生式下行链路的 { satParams, linkParams }：某颗卫星(satForm) + 某份载波信号(carrierForm) + 某收信站(rxStation)。
// 收信站 G/T 由天线/噪温/馈线走引擎原生 gOverTe（含精确雨致 G/T 劣化）；卫星下行 EIRP(rxEIRP,target:'link') 直发（再生无转发器回退）。
export function buildRegenDownlinkParams(satForm, carrierForm, rxStation) {
  const satParams = {}
  const linkParams = {}
  // 卫星群字段按 target 分流（含上/下行频率极化、轨道）
  for (const f of SAT_FIELDS) (f.target === 'link' ? linkParams : satParams)[f.key] = satForm[f.key]
  // 载波
  for (const f of CARRIER_FIELDS) linkParams[f.key] = carrierForm[f.key]
  // 收信站：下行链路字段 → linkParams；下行干扰(target:'sat') → satParams；meta/op 不进引擎
  for (const f of RX_FIELDS) {
    if (f.target === 'meta' || f.target === 'op') continue
    if (f.target === 'sat') satParams[f.key] = rxStation[f.key]
    else linkParams[f.key] = rxStation[f.key]
  }
  // 上行占位（引擎需完整入参；再生下行只读下行结果，上行相消）
  Object.assign(satParams, UP_SAT_DEFAULTS)
  Object.assign(linkParams, UP_LINK_DEFAULTS)
  // 上行地理镜像收信站，使弯管引擎上行几何良定（再生不参与；主计算另注入 slantRange 覆盖）
  linkParams.earthStationLocation = rxStation.rxEarthStationLocation
  linkParams.longitude = rxStation.rxLongitude
  linkParams.latitude = rxStation.rxLatitude
  linkParams.minElevation = rxStation.rxMinElevation
  linkParams.altitude = rxStation.rxAltitude
  linkParams.rainRate = rxStation.rxRainRate
  linkParams.rxOrbitAltitude = linkParams.orbitAltitude
  // 引擎入口换算：有效 sfdRef = sfdRef + sfdGtRef（与 NGSO 一致；此处 sfdGtRef=0 原样）
  const gtRef = parseFloat(satParams.sfdGtRef)
  const sfd = parseFloat(satParams.sfdRef)
  if (gtRef && !isNaN(gtRef) && !isNaN(sfd)) satParams.sfdRef = sfd + gtRef
  return { satParams: JSON.parse(JSON.stringify(satParams)), linkParams: JSON.parse(JSON.stringify(linkParams)) }
}

// —— 收信站工作点换算：G/T ⇄ 噪温模式（与引擎 gOverTe 同口径，下行频率取该站所选卫星的下行频率）——
// 下行接收天线增益（dBi）
export function rxAntennaGainDbi(diameterM, effPct, freqGHz) {
  const D = parseFloat(diameterM); const eff = parseFloat(effPct); const f = parseFloat(freqGHz)
  if (!(D > 0) || !(eff > 0) || !(f > 0)) return NaN
  const lambda = _C_LIGHT / f
  return 20 * Math.log10(Math.PI * D / lambda) + 10 * Math.log10(eff / 100)
}
// 接收系统等效噪声温度 → dBK（与引擎 systemNoiseTempK 同口径：含馈线损耗噪声贡献）
export function rxSystemNoiseTempDb(antTempK, rxTempK, feederLossDb) {
  const at = parseFloat(antTempK); const rt = parseFloat(rxTempK); const fl = parseFloat(feederLossDb) || 0
  if (isNaN(at) || isNaN(rt)) return NaN
  const fLin = Math.pow(10, fl / 10)
  const Tsys = at / fLin + 290 * (1 - 1 / fLin) + rt
  return Tsys > 0 ? 10 * Math.log10(Tsys) : NaN
}
// 噪温模式 → 设备 G/T（dB/K）：G/T = 天线增益 − 系统噪温dB − 馈线损耗（严格对齐引擎 gOverTe）。
// 收信站群「收信站 G/T」只读列的实时预览取值即由此算得。
export function rxGtFromNoise(station, satForm) {
  const g = rxAntennaGainDbi(station.rxAntennaDiameter, station.rxAntennaEfficiency, satForm && satForm.rxCenterFrequency)
  const tdb = rxSystemNoiseTempDb(station.rxAntennaNoiseTemp, station.rxReceiverNoiseTemp, station.rxFeederLoss)
  const fl = parseFloat(station.rxFeederLoss) || 0
  if (isNaN(g) || isNaN(tdb)) return NaN
  return g - tdb - fl
}

// ==================== 再生式星间链路（微波 ISL）====================
// 组装单条星间链路的 { satParams, linkParams }：发射卫星(txSatForm) + 某份载波信号(carrierForm) + 星间链路配置(islLink)。
// islHopDistance（星间最差距离）由主计算按几何求解后另行注入 satParams（此处不含）。
// 上/下行为引擎跑通所需占位，ISL 只读 islPerHopCN，数学上不参与。
export function buildRegenIslParams(txSatForm, carrierForm, islLink) {
  const satParams = {}
  const linkParams = {}
  // 卫星身份取发射卫星（频段等；ISL RF 预算不依赖，仅标注）
  satParams.satelliteName = txSatForm.satelliteName
  satParams.frequencyBand = txSatForm.frequencyBand
  // 载波（门限/带宽）
  for (const f of CARRIER_FIELDS) linkParams[f.key] = carrierForm[f.key]
  // ISL 四项（target:'sat'）；islAtmMargin(target:'geom') 只喂几何，不进引擎
  for (const f of ISL_FIELDS) if (f.target === 'sat') satParams[f.key] = islLink[f.key]
  satParams.islMode = 'rf'; satParams.islHops = 1
  // 上下行占位（引擎需完整入参才能良定；ISL 只读 islPerHopCN）
  Object.assign(satParams, UP_SAT_DEFAULTS, DL_SAT_DEFAULTS)
  Object.assign(linkParams, UP_LINK_DEFAULTS, DL_LINK_DEFAULTS)
  // 占位频率/极化/几何（引擎上下行需斜距；ISL 不读，取固定占位）
  linkParams.centerFrequency = txSatForm.centerFrequency || '14.25'
  linkParams.rxCenterFrequency = txSatForm.rxCenterFrequency || '12.5'
  linkParams.uplinkPolarization = 'V'; linkParams.downlinkPolarization = 'H'
  linkParams.orbitAltitude = txSatForm.orbitAltitude || '1145'
  linkParams.rxOrbitAltitude = linkParams.orbitAltitude
  linkParams.earthStationLocation = '发'; linkParams.longitude = '116.4074'; linkParams.latitude = '39.9042'
  linkParams.rxEarthStationLocation = '收'; linkParams.rxLongitude = '116.4074'; linkParams.rxLatitude = '39.9042'
  linkParams.distanceMode = 'slantRange'; linkParams.slantRange = 2000; linkParams.minElevation = 10
  linkParams.rxDistanceMode = 'slantRange'; linkParams.rxSlantRange = 2000; linkParams.rxMinElevation = 10
  // 有效 sfdRef 换算（与其余口径一致）
  const gtRef = parseFloat(satParams.sfdGtRef); const sfd = parseFloat(satParams.sfdRef)
  if (gtRef && !isNaN(gtRef) && !isNaN(sfd)) satParams.sfdRef = sfd + gtRef
  return { satParams: JSON.parse(JSON.stringify(satParams)), linkParams: JSON.parse(JSON.stringify(linkParams)) }
}
