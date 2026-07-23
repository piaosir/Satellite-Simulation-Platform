// NGSO（非地球静止轨道）链路预算 — 完整专业参数 schema。
// 由 GEO 参数集改造：删除 GEO 专属（定点轨道经度 / 邻星离轴角），改为 NGSO 的轨道高度 / 轨道倾角，
// 每个发/收信站增加「最低仰角」（最差几何依据），「其他损耗」改名「综合损耗」。星间链路(ISL)已删除
// （NGSO 预算模块永久将 ISL 跳数置 0）。
// 默认值 = MEO Ku 预设（2026-07 起）：轨道 8000 km/45°（平台 MEO 基准工况）+ 卫星点波束 G/T 10 dB/K；
// 站型/转发器/干扰系数沿用小程序 NGSO 口径（6.2m 关口站 + 3.7m 干线站对 MEO 弯管仍属合理站型）。
// 只影响新建配置的初始值；已保存配置存的是具体数值，不受影响。引擎空值回退常数另有一套，不随此变。
// 每个字段标注 target：'sat' → satParams，'link' → inputs。auto：'rain'|'elev' 为按经纬度自动填。

import { halfStr } from '../shared/num.js'   // 全角减号/数字归一到半角，避免负数（经纬度/门限/SFDref 等）被引擎 Number() 吞掉

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
    // 地球站库：每份配置 = 一种站型的收发射频参数（side:'common' 收发共用 / side:'tx' 发射链 / side:'rx' 接收链）。
    // 一份配置 = 一座站 = 一面天线：口径收发共用（side:'common'，rxKey 标注收侧引擎键名——组装时发信站的
    // 口径写 antennaDiameter、收信站的口径写 rxAntennaDiameter），天线效率随收发频段不同而分设。
    // 站表（发/收信站群）只留站址信息 + 「地球站配置」选择列；字段 key 与引擎入参一致（与旧站表列同名），
    // buildParams 按行所选配置并入 linkParams，引擎口径不变。
    key: 'station', title: '地球站', icon: 'dish',
    fields: [
      { key: 'antennaDiameter', rxKey: 'rxAntennaDiameter', label: '天线口径', tip: '收发共用同一面天线：口径一致（天线效率按收发频段分设）', side: 'common', unit: 'm', type: 'num', def: '6.2', target: 'link' },
      { key: 'antennaEfficiency', label: '天线效率', side: 'tx', unit: '%', type: 'num', def: '65', target: 'link' },
      { key: 'paBackoff', label: '功放回退', side: 'tx', unit: 'dB', type: 'num', def: '0', target: 'link' },
      { key: 'feederLoss', label: '馈线损耗', side: 'tx', unit: 'dB', type: 'num', def: '3.5', target: 'link' },
      { key: 'uplinkPowerControl', label: 'UPC', tip: '上行功率控制 (Uplink Power Control)', side: 'tx', type: 'select', options: ['否', '是', '自定义'], def: '否', target: 'link' },
      { key: 'upcValue', label: 'UPC值', tip: '仅「UPC = 自定义」时生效', side: 'tx', unit: 'dB', type: 'num', def: '0', target: 'link' },
      { key: 'uplinkOtherLoss', label: '综合损耗', tip: '综合损耗：指向/极化/天线罩/接头等未单列损耗之综合（原「其他损耗」）', side: 'tx', unit: 'dB', type: 'num', def: '0.3', target: 'link' },
      // 上行干扰四项（原在「卫星与转发器」，随站型入库：取决于站的天线旁瓣/极化性能与所处干扰环境；
      // target:'sat' → 组装时仍送 satParams，引擎口径不变）
      { key: 'aciUplinkFactor', label: '上行C/ACI', tip: '上行载波/邻道干扰比 (Adjacent Channel Interference)', side: 'tx', unit: 'dB', type: 'num', def: '30', target: 'sat', intf: true },
      { key: 'adjUplinkFactor', label: '上行C/ASI', tip: '上行载波/邻星干扰比 (Adjacent Satellite Interference)', side: 'tx', unit: 'dB', type: 'num', def: '25', target: 'sat', intf: true },
      { key: 'xpolUplinkFactor', label: '上行C/XPI', tip: '上行载波/交叉极化干扰比 (Cross-Polarization Interference)', side: 'tx', unit: 'dB', type: 'num', def: '26', target: 'sat', intf: true },
      { key: 'hpaIntermodFactor', label: 'HPA C/IM', tip: '高功放载波/互调比 (HPA Intermodulation)——发信站功放硬件属性', side: 'tx', unit: 'dB', type: 'num', def: '24', target: 'sat', intf: true },
      { key: 'rxAntennaEfficiency', label: '天线效率', side: 'rx', unit: '%', type: 'num', def: '65', target: 'link' },
      { key: 'rxAntennaNoiseTempMode', label: '天线噪温模式', tip: '自动 = 按 ITU-R P.618-14 §3 由晴空大气衰减与链路仰角实时求取天空噪温（+25 K 地面拾取常数；NGSO §8 口径下随等效仰角变化），忽略「天线噪温」手填值；自定义 = 用「天线噪温」数值。', side: 'rx', type: 'select', options: ['自动', '自定义'], def: '自动', target: 'link' },
      { key: 'rxAntennaNoiseTemp', label: '天线噪温', tip: '天线噪声温度（K）；仅「天线噪温模式 = 自定义」时生效', side: 'rx', unit: 'K', type: 'num', def: '35', target: 'link' },
      { key: 'rxReceiverNoiseTemp', label: '接收机噪温', side: 'rx', unit: 'K', type: 'num', def: '75', target: 'link' },
      { key: 'rxFeederLoss', label: '馈线损耗', side: 'rx', unit: 'dB', type: 'num', def: '0.2', target: 'link' },
      { key: 'downlinkOtherLoss', label: '综合损耗', tip: '综合损耗：指向/极化/天线罩/接头等未单列损耗之综合（原「其他损耗」）', side: 'rx', unit: 'dB', type: 'num', def: '0.3', target: 'link' },
      // 下行干扰三项（原在「卫星与转发器」，随站型入库；Tpdr. C/IM 为转发器硬件属性仍留卫星侧）
      { key: 'aciDownlinkFactor', label: '下行C/ACI', tip: '下行载波/邻道干扰比 (Adjacent Channel Interference)', side: 'rx', unit: 'dB', type: 'num', def: '30', target: 'sat', intf: true },
      { key: 'adjDownlinkFactor', label: '下行C/ASI', tip: '下行载波/邻星干扰比 (Adjacent Satellite Interference)', side: 'rx', unit: 'dB', type: 'num', def: '25', target: 'sat', intf: true },
      { key: 'xpolDownlinkFactor', label: '下行C/XPI', tip: '下行载波/交叉极化干扰比 (Cross-Polarization Interference)', side: 'rx', unit: 'dB', type: 'num', def: '26', target: 'sat', intf: true }
    ]
  },
  {
    key: 'sat', title: '卫星与转发器', icon: 'sat',
    fields: [
      { key: 'satelliteName', label: '卫星名称', type: 'text', def: 'Satellite', target: 'sat' },
      { key: 'frequencyBand', label: '工作频段', type: 'select', options: ['L', 'S', 'X', 'ExtC', 'C', 'ExtKu', 'Ku', 'Ku-BSS', 'Ka', 'Q', 'V'], def: 'Ku', target: 'sat' },
      { key: 'centerFrequency', label: '上行频率', tip: '上行中心频率', unit: 'GHz', type: 'num', def: '14.25', target: 'link', pair: 'up' },
      { key: 'uplinkPolarization', label: '上行极化', tip: '上行极化方式', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'V', target: 'link', pair: 'up' },
      { key: 'rxCenterFrequency', label: '下行频率', tip: '下行中心频率', unit: 'GHz', type: 'num', def: '12.5', target: 'link', pair: 'dn' },
      { key: 'downlinkPolarization', label: '下行极化', tip: '下行极化方式', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'H', target: 'link', pair: 'dn' },
      // NGSO 轨道：轨道高度（圆轨道高度）+ 轨道倾角。手动模式可编辑；选星后由所选卫星轨道自动确定（只读显示「自动」）。
      { key: 'orbitAltitude', label: '轨道高度', tip: '圆轨道高度；选星（天线树导入/搜索）后由所选卫星轨道自动确定，只读', unit: 'km', type: 'num', def: '8000', target: 'link', pair: 'orbit' },
      { key: 'orbitInclination', label: '轨道倾角', tip: '轨道倾角；选星后由所选卫星轨道根数自动确定，只读', unit: '°', type: 'num', def: '45', target: 'sat', pair: 'orbit' },
      { key: 'sfdRef', label: 'SFDref', tip: '饱和通量密度参考值 (Saturation Flux Density)', unit: 'dBW/m²', type: 'num', def: '-84', target: 'sat' },
      { key: 'sfdGtRef', label: 'G/Tref', tip: '参考点卫星品质因数 G/T', unit: 'dB/K', type: 'num', def: '0', target: 'sat' },
      { key: 'transponderBandwidth', label: 'Tpdr.带宽', tip: '转发器带宽 (Transponder Bandwidth)', unit: 'MHz', type: 'num', def: '36', target: 'sat' },
      { key: 'BOi', label: 'Tpdr. IBO', tip: '转发器输入回退 (Input Back-Off)', unit: 'dB', type: 'num', def: '6', target: 'sat' },
      { key: 'BOo', label: 'Tpdr. OBO', tip: '转发器输出回退 (Output Back-Off)', unit: 'dB', type: 'num', def: '3', target: 'sat' },
      // 干扰系数已随站型迁入「地球站」库（上行四项入发射链、下行三项入接收链，见 station 组）；
      // 仅转发器互调留此——它是星上转发器的硬件属性，不随地球站走。
      { key: 'xpdrIntermodFactor', label: 'Tpdr. C/IM', tip: '转发器载波/互调比 (Transponder Intermodulation)', unit: 'dB', type: 'num', def: '21', target: 'sat', pair: 'im' }
    ]
  },
  {
    key: 'uplink', title: '上行 · 发信站', icon: 'up',
    fields: [
      // 载波由发信站调制器产生（卫星只是弯管转发），故载波信号配置与发信站绑定而非收信站；放在表格最前一列
      // （StationGrid 把 fields[0] 当冻结的“关键列”处理）。target:'meta' 为 UI 专用字段，不进引擎参数
      // （见 buildParams 的过滤）。options 为空，实际选项由 LinkBudgetApp 按当前载波信号配置库动态生成并
      // 通过 StationGrid 的 select-options 注入。
      { key: 'basebandId', label: '载波信号配置', type: 'select', options: [], def: '', target: 'meta' },
      // 地球站配置（射频站型）：发射链参数由所选配置提供（见 station 组）；options 由 App 按地球站库动态注入
      { key: 'stationId', label: '地球站配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'earthStationLocation', label: '地球站位置', type: 'text', def: '北京', target: 'link', city: 'tx' },
      { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'minElevation', label: '最低仰角', tip: '发信站对卫星的最低工作仰角，决定最差几何（斜距最大）', unit: '°', type: 'num', def: '10', target: 'link' },
      { key: 'altitude', label: '海拔', unit: 'm', type: 'num', def: '0', target: 'link', auto: 'elev' },
      { key: 'G_Ts', label: '卫星G/T', tip: '卫星接收品质因数 G/T（随波束位置随站而异的「卫星×发信站」配对量，故留在站表；可由 GRD 天线匹配自动回填）。MEO 预设 10 dB/K：MEO Ku 点波束量级（GEO 宽波束才是 0~2 dB/K 量级）', unit: 'dB/K', type: 'num', def: '10', target: 'link' },
      { key: 'rainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '0', target: 'link', auto: 'rain' },
      { key: 'uplinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' }
    ]
  },
  {
    key: 'downlink', title: '下行 · 收信站', icon: 'down',
    fields: [
      // 地球站配置（射频站型）：接收链参数由所选配置提供（见 station 组）
      { key: 'stationId', label: '地球站配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'rxEarthStationLocation', label: '地球站位置', type: 'text', def: '北京', target: 'link', city: 'rx' },
      { key: 'rxLongitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'rxLatitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'rxMinElevation', label: '最低仰角', tip: '收信站对卫星的最低工作仰角，决定最差几何（斜距最大）', unit: '°', type: 'num', def: '10', target: 'link' },
      { key: 'rxAltitude', label: '海拔', unit: 'm', type: 'num', def: '0', target: 'link', auto: 'elev' },
      { key: 'rxEIRP', label: '卫星EIRP', tip: '卫星下行 EIRP（随波束位置随站而异的「卫星×收信站」配对量，故留在站表；可由 GRD 天线匹配自动回填）', unit: 'dBW', type: 'num', def: '46', target: 'link' },
      { key: 'rxRainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '0', target: 'link', auto: 'rain' },
      { key: 'rxDownlinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' }
    ]
  }
]

// 扁平字段表
export const ALL_FIELDS = FIELD_GROUPS.flatMap((g) => g.fields)

// 按模块取字段：5 模块 = 载波信号(carrier) / 地球站库(station) / 发信站群(uplink) / 卫星(sat) / 收信站群(downlink)
const _grp = (k) => FIELD_GROUPS.find((g) => g.key === k).fields
export const CARRIER_FIELDS = _grp('carrier')
export const SAT_FIELDS = _grp('sat')
export const TX_FIELDS = _grp('uplink')   // 每个发信站一行（站址 + 配置选择列）
export const RX_FIELDS = _grp('downlink') // 每个收信站一行（站址 + 配置选择列）
export const ES_FIELDS = _grp('station')  // 地球站库：一份配置的全部收发射频字段
export const ES_COMMON_FIELDS = ES_FIELDS.filter((f) => f.side === 'common')   // 收发共用（天线口径；rxKey=收侧引擎键）
export const ES_TX_FIELDS = ES_FIELDS.filter((f) => f.side === 'tx')   // 发射链（发信站引用）
export const ES_RX_FIELDS = ES_FIELDS.filter((f) => f.side === 'rx')   // 接收链（收信站引用）

// 给定字段集生成默认对象
export function defaultsFor(fields) {
  const o = {}
  for (const f of fields) o[f.key] = f.def
  return o
}

// 组装单条链路的 { satParams, linkParams }：卫星+载波共享，叠加某发信站(tx)与某收信站(rx)，
// 以及两行各自选用的地球站配置表单（txEs 供发射链字段、rxEs 供接收链字段；缺省用库默认值）。
// 引擎入口换算 有效sfdRef = sfdRef + sfdGtRef（与小程序 _engineSatParams 一致）。
export function buildParams(satForm, carrierForm, txStation, rxStation, txEs, rxEs) {
  if (!txEs) txEs = { ...defaultsFor(ES_COMMON_FIELDS), ...defaultsFor(ES_TX_FIELDS) }
  if (!rxEs) rxEs = { ...defaultsFor(ES_COMMON_FIELDS), ...defaultsFor(ES_RX_FIELDS) }
  const satParams = {}
  const linkParams = {}
  // 数值字段（type:'num'）先归一全角→半角再入参（防中文输入法全角减号令引擎 Number() 解析失败）；文本/select 原样
  const put = (obj, f, v) => { obj[f.key] = f.type === 'num' ? halfStr(v) : v }
  // 卫星模块字段按 target 分流：'sat' → satParams；'link'（如上/下行频率，全站共享）→ linkParams
  for (const f of SAT_FIELDS) put(f.target === 'link' ? linkParams : satParams, f, satForm[f.key])
  for (const f of CARRIER_FIELDS) put(linkParams, f, carrierForm[f.key])
  // 收发共用字段（天线口径）：发射链取发信站所选配置、接收链取收信站所选配置（各站各自的那面天线）
  for (const f of ES_COMMON_FIELDS) { put(linkParams, f, txEs[f.key]); if (f.rxKey) put(linkParams, { ...f, key: f.rxKey }, rxEs[f.key]) }
  // 发/收链字段按 target 分流：干扰项(target:'sat') → satParams，其余 → linkParams
  for (const f of ES_TX_FIELDS) put(f.target === 'sat' ? satParams : linkParams, f, txEs[f.key])
  for (const f of ES_RX_FIELDS) put(f.target === 'sat' ? satParams : linkParams, f, rxEs[f.key])
  for (const f of TX_FIELDS) if (f.target !== 'meta') put(linkParams, f, txStation[f.key])
  for (const f of RX_FIELDS) if (f.target !== 'meta') put(linkParams, f, rxStation[f.key])
  const gtRef = parseFloat(satParams.sfdGtRef)
  const sfd = parseFloat(satParams.sfdRef)
  if (gtRef && !isNaN(gtRef) && !isNaN(sfd)) satParams.sfdRef = sfd + gtRef
  // 单颗弯管卫星只有一个轨道高度：镜像给收信站侧（引擎 up/down 分设 orbitAltitude / rxOrbitAltitude）。
  // 只读列 EIRP/G-T 走闭式几何（altitude 模式）时，收信站才有高度可解斜距；否则引擎 RX 侧无高度可用而抛错。
  // 主计算随后用注入的 rxSlantRange（slantRange 模式）覆盖，此镜像值被忽略，互不影响。
  if (linkParams.orbitAltitude != null && linkParams.rxOrbitAltitude == null) linkParams.rxOrbitAltitude = linkParams.orbitAltitude
  // 返回纯对象（剥离任何 Vue 响应式代理，否则经 Electron IPC 结构化克隆会报 “could not be cloned”）
  return { satParams: JSON.parse(JSON.stringify(satParams)), linkParams: JSON.parse(JSON.stringify(linkParams)) }
}

// 默认表单（key → 默认值）
export function defaultForm() {
  const f = {}
  for (const fld of ALL_FIELDS) f[fld.key] = fld.def
  return f
}

// 表单 → { satParams, linkParams }。引擎入口换算：有效 sfdRef = sfdRef + sfdGtRef
// （与小程序 _engineSatParams 一致；sfdGtRef 为 0/空时原样）。
export function splitForm(form) {
  const satParams = {}
  const linkParams = {}
  for (const fld of ALL_FIELDS) {
    const v = fld.type === 'num' ? halfStr(form[fld.key]) : form[fld.key]   // 数值字段归一全角→半角
    if (fld.target === 'sat') satParams[fld.key] = v
    else linkParams[fld.key] = v
  }
  const gtRef = parseFloat(satParams.sfdGtRef)
  const sfd = parseFloat(satParams.sfdRef)
  if (gtRef && !isNaN(gtRef) && !isNaN(sfd)) satParams.sfdRef = sfd + gtRef
  return { satParams, linkParams }
}
