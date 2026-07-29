// GEO 链路预算 — 完整专业参数 schema。
// 默认值严格对齐小程序 app.js 的 getDefaultSatelliteParams / getDefaultLinkParams（权威口径）。
// 字段集对齐小程序 index.wxml 的 data-field（用户真正暴露的输入）；引擎自动算的项
// （指向误差/天线罩/极化损耗/连接器损耗等）不在此暴露。
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
      { key: 'margin', label: '系统余量', unit: 'dB', type: 'num', def: '3.00', target: 'link' },
      // 计算方式（求解策略）随载波入库：链路表逐行按所选载波取用，故一个批次内不同载波可各按各的方式求解。
      // target:'op' 不进引擎参数——App 换算成求解器 opt（mode / overDb），功放功率仍按行取发端站型的 paPowerW。
      { key: 'calcMode', label: '计算方式', type: 'select', options: ['margin', 'power', 'balance', 'overbalance'], def: 'margin', target: 'op' },
      { key: 'overDb', label: '超发量', tip: '相对功带平衡点的超发量——仅「功带平衡下超发」方式生效', unit: 'dB', type: 'num', def: '0', target: 'op' }
    ]
  },
  {
    // 地球站库：每份配置 = 一种站型的收发射频参数（side:'common' 收发共用 / side:'tx' 发射链 / side:'rx' 接收链）。
    // 一份配置 = 一座站 = 一面天线：口径收发共用（side:'common'，rxKey 标注收侧引擎键名——组装时发信站的
    // 口径写 antennaDiameter、收信站的口径写 rxAntennaDiameter），天线效率随收发频段不同而分设。
    // 上/下行频率与极化在「卫星与转发器」（空间段定的载频，全链路共用）、干扰系数亦在卫星（见 sat 组）——地球站库只管站上硬件。
    // 站表（发/收信站群）只留站址信息 + 「地球站配置」选择列；字段 key 与引擎入参一致（与旧站表列同名），
    // buildParams 按行所选配置并入 linkParams，引擎口径不变。
    key: 'station', title: '地球站', icon: 'dish',
    fields: [
      { key: 'antennaDiameter', rxKey: 'rxAntennaDiameter', label: '天线口径', tip: '收发共用同一面天线：口径一致（天线效率按收发频段分设）', side: 'common', unit: 'm', type: 'num', def: '6.2', target: 'link' },
      { key: 'antennaEfficiency', label: '天线效率', side: 'tx', unit: '%', type: 'num', def: '65', target: 'link' },
      // 功放功率是发射链硬件属性，随站型入库（对齐再生式工作点 opPowerW 的归属）：
      // 「设置功放功率」计算方式逐行取所选站型的此值反推余量。target:'op' 不进引擎参数，App 换算成 opt.powerW。
      // hero:true 仅指渲染位置——与口径并列排在配置面板顶部主参数条（功放是站型的另一个定性指标），side 仍为 'tx'。
      { key: 'paPowerW', label: '功放功率', tip: '发射链高功放输出功率（W）——「设置功放功率」计算方式按行取此值反推余量', side: 'tx', hero: true, unit: 'W', type: 'num', def: '40', target: 'op' },
      { key: 'paBackoff', label: '功放回退', side: 'tx', unit: 'dB', type: 'num', def: '0', target: 'link' },
      { key: 'feederLoss', label: '馈线损耗', side: 'tx', unit: 'dB', type: 'num', def: '3.5', target: 'link' },
      { key: 'uplinkPowerControl', label: 'UPC', tip: '上行功率控制 (Uplink Power Control)', side: 'tx', type: 'select', options: ['否', '是', '自定义'], def: '否', target: 'link' },
      { key: 'upcValue', label: 'UPC值', tip: '仅「UPC = 自定义」时生效', side: 'tx', unit: 'dB', type: 'num', def: '0', target: 'link' },
      { key: 'uplinkOtherLoss', label: '其他损耗', tip: '指向/极化/天线罩/接头等未单列损耗之综合', side: 'tx', unit: 'dB', type: 'num', def: '0.3', target: 'link' },
      { key: 'rxAntennaEfficiency', label: '天线效率', side: 'rx', unit: '%', type: 'num', def: '65', target: 'link' },
      { key: 'rxAntennaNoiseTempMode', label: '天线噪温模式', tip: '自动 = 按 ITU-R P.618-14 §3 由晴空大气衰减与链路仰角实时求取天空噪温（+25 K 地面拾取常数），忽略「天线噪温」手填值；自定义 = 用「天线噪温」数值。', side: 'rx', type: 'select', options: ['自动', '自定义'], def: '自动', target: 'link' },
      { key: 'rxAntennaNoiseTemp', label: '天线噪温', tip: '天线噪声温度（K）；仅「天线噪温模式 = 自定义」时生效', side: 'rx', unit: 'K', type: 'num', def: '35', target: 'link' },
      { key: 'rxReceiverNoiseTemp', label: '接收机噪温', side: 'rx', unit: 'K', type: 'num', def: '75', target: 'link' },
      { key: 'rxFeederLoss', label: '馈线损耗', side: 'rx', unit: 'dB', type: 'num', def: '0.2', target: 'link' },
      { key: 'downlinkOtherLoss', label: '其他损耗', tip: '指向/极化/天线罩/接头等未单列损耗之综合', side: 'rx', unit: 'dB', type: 'num', def: '0.3', target: 'link' }
    ]
  },
  {
    key: 'sat', title: '卫星与转发器', icon: 'sat',
    fields: [
      { key: 'satelliteName', label: '卫星名称', type: 'text', def: 'Satellite', target: 'sat' },
      { key: 'frequencyBand', label: '工作频段', tip: '选定频段后上/下行频率按该频段预设自动填入（仍可手改）', type: 'select', options: ['L', 'S', 'X', 'ExtC', 'C', 'ExtKu', 'Ku', 'Ku-BSS', 'Ka', 'Q', 'V'], def: 'Ku', target: 'sat' },
      // 上/下行频率与极化：一颗星天然有上/下行两套载频，是空间段属性（同一颗星服务的各链路共用），故在卫星侧设定。
      // target:'link' → 组装进 linkParams（引擎口径不变，见 buildParams 的 SAT_FIELDS 分流）。
      { key: 'centerFrequency', label: '上行频率', tip: '上行中心频率（发信站→卫星）', unit: 'GHz', type: 'num', def: '14.25', target: 'link' },
      { key: 'uplinkPolarization', label: '上行极化', tip: '上行极化方式', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'V', target: 'link' },
      { key: 'rxCenterFrequency', label: '下行频率', tip: '下行中心频率（卫星→收信站）', unit: 'GHz', type: 'num', def: '12.5', target: 'link' },
      { key: 'downlinkPolarization', label: '下行极化', tip: '下行极化方式', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'H', target: 'link' },
      { key: 'orbitPosition', label: '定点轨道经度', tip: '卫星定点轨道经度', unit: '°E', type: 'num', def: '110.5', target: 'sat' },
      { key: 'sfdRef', label: 'SFDref', tip: '饱和通量密度参考值 (Saturation Flux Density)', unit: 'dBW/m²', type: 'num', def: '-84', target: 'sat' },
      { key: 'sfdGtRef', label: 'G/Tref', tip: '参考点卫星品质因数 G/T', unit: 'dB/K', type: 'num', def: '0', target: 'sat' },
      { key: 'transponderBandwidth', label: 'Tpdr.带宽', tip: '转发器带宽 (Transponder Bandwidth)', unit: 'MHz', type: 'num', def: '36', target: 'sat' },
      { key: 'BOi', label: 'Tpdr. IBO', tip: '转发器输入回退 (Input Back-Off)', unit: 'dB', type: 'num', def: '6', target: 'sat' },
      { key: 'BOo', label: 'Tpdr. OBO', tip: '转发器输出回退 (Output Back-Off)', unit: 'dB', type: 'num', def: '3', target: 'sat' },
      { key: 'xpdrIntermodFactor', label: 'Tpdr. C/IM', tip: '转发器载波/互调比 (Transponder Intermodulation)——星上转发器硬件属性，与上下行无关', unit: 'dB', type: 'num', def: '21', target: 'sat' },
      // 干扰系数（上行四项 + 下行三项）由「地球站」库迁回卫星，作卫星/系统级参数（场景内全链路共用）；仍 target:'sat' → satParams，引擎口径不变。
      // br:true 令上/下行两组各自另起一行——按上下行区分，但不做成带边框的分区（见 SatellitePanel 的 sp-break）。
      { key: 'aciUplinkFactor', label: '上行C/ACI', tip: '上行载波/邻道干扰比 (Adjacent Channel Interference)', unit: 'dB', type: 'num', def: '30', target: 'sat', br: true },
      { key: 'adjUplinkFactor', label: '上行C/ASI', tip: '上行载波/邻星干扰比 (Adjacent Satellite Interference)', unit: 'dB', type: 'num', def: '25', target: 'sat' },
      { key: 'xpolUplinkFactor', label: '上行C/XPI', tip: '上行载波/交叉极化干扰比 (Cross-Polarization Interference)', unit: 'dB', type: 'num', def: '26', target: 'sat' },
      { key: 'hpaIntermodFactor', label: 'HPA C/IM', tip: '高功放载波/互调比 (HPA Intermodulation)——发信站功放硬件属性', unit: 'dB', type: 'num', def: '24', target: 'sat' },
      { key: 'aciDownlinkFactor', label: '下行C/ACI', tip: '下行载波/邻道干扰比 (Adjacent Channel Interference)', unit: 'dB', type: 'num', def: '30', target: 'sat', br: true },
      { key: 'adjDownlinkFactor', label: '下行C/ASI', tip: '下行载波/邻星干扰比 (Adjacent Satellite Interference)', unit: 'dB', type: 'num', def: '25', target: 'sat' },
      { key: 'xpolDownlinkFactor', label: '下行C/XPI', tip: '下行载波/交叉极化干扰比 (Cross-Polarization Interference)', unit: 'dB', type: 'num', def: '26', target: 'sat' }
    ]
  },
  {
    key: 'uplink', title: '上行 · 发信站', icon: 'up',
    fields: [
      // 载波由发信站调制器产生（卫星只是弯管转发），故载波信号配置与发信站绑定而非收信站；放在表格最前一列
      // （StationGrid 把 fields[0] 当冻结的“关键列”处理）。target:'meta' 为 UI 专用字段，不进引擎参数
      // （见 buildParams 的过滤）。options 为空，实际选项由 LinkBudgetApp 按当前载波信号库动态生成并
      // 通过 StationGrid 的 select-options 注入。
      { key: 'basebandId', label: '载波信号配置', type: 'select', options: [], def: '', target: 'meta' },
      // 地球站配置（射频站型）：发射链参数由所选配置提供（见 station 组）；options 由 App 按地球站库动态注入
      { key: 'stationId', label: '地球站配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'earthStationLocation', label: '地球站位置', type: 'text', def: '北京', target: 'link', city: 'tx', lonKey: 'longitude', latKey: 'latitude' },
      { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'altitude', label: '海拔', unit: 'm', type: 'num', def: '0', target: 'link', auto: 'elev' },
      { key: 'G_Ts', label: '卫星G/T', tip: '卫星接收品质因数 G/T（随波束位置随站而异的「卫星×发信站」配对量，故留在站表；可由 GRD 天线匹配自动回填）', unit: 'dB/K', type: 'num', def: '2', target: 'link' },
      { key: 'rainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '0', target: 'link', auto: 'rain' },
      { key: 'uplinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' }
    ]
  },
  {
    key: 'downlink', title: '下行 · 收信站', icon: 'down',
    fields: [
      // 地球站配置（射频站型）：接收链参数由所选配置提供（见 station 组）。
      // 键名 rxStationId（不与发端 stationId 同键）：链路表一行 = 发端+收端合并后两侧引用共存。
      { key: 'rxStationId', label: '地球站配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'rxEarthStationLocation', label: '地球站位置', type: 'text', def: '北京', target: 'link', city: 'rx', lonKey: 'rxLongitude', latKey: 'rxLatitude' },
      { key: 'rxLongitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'rxLatitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
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
  // 数值字段（type:'num'）先归一全角→半角再入参（防中文输入法全角减号令引擎 Number() 解析失败）；文本/select 原样（勿改站名等）
  const put = (obj, f, v) => { obj[f.key] = f.type === 'num' ? halfStr(v) : v }
  // 卫星模块字段按 target 分流：'sat'（含干扰系数七项 + Tpdr.C/IM）→ satParams；'link'（上/下行频率与极化）→ linkParams
  for (const f of SAT_FIELDS) put(f.target === 'link' ? linkParams : satParams, f, satForm[f.key])
  // 载波字段：求解策略(target:'op'，计算方式/超发量)不进引擎参数，由 App 换算成求解器 opt
  for (const f of CARRIER_FIELDS) { if (f.target === 'op') continue; put(linkParams, f, carrierForm[f.key]) }
  // 收发共用字段（天线口径）：发射链取发信站所选配置、接收链取收信站所选配置（各站各自的那面天线）
  for (const f of ES_COMMON_FIELDS) { put(linkParams, f, txEs[f.key]); if (f.rxKey) put(linkParams, { ...f, key: f.rxKey }, rxEs[f.key]) }
  // 发/收链字段：工作点(target:'op'，如功放功率)不进引擎参数（App 换算成求解器 opt），其余 → linkParams
  // ——频率/极化不在此列：那是卫星侧字段（见上方 SAT_FIELDS 分流），一条链路上下行各一份，全站共用
  for (const f of ES_TX_FIELDS) { if (f.target === 'op') continue; put(f.target === 'sat' ? satParams : linkParams, f, txEs[f.key]) }
  for (const f of ES_RX_FIELDS) { if (f.target === 'op') continue; put(f.target === 'sat' ? satParams : linkParams, f, rxEs[f.key]) }
  for (const f of TX_FIELDS) if (f.target !== 'meta') put(linkParams, f, txStation[f.key])
  for (const f of RX_FIELDS) if (f.target !== 'meta') put(linkParams, f, rxStation[f.key])
  const gtRef = parseFloat(satParams.sfdGtRef)
  const sfd = parseFloat(satParams.sfdRef)
  if (gtRef && !isNaN(gtRef) && !isNaN(sfd)) satParams.sfdRef = sfd + gtRef
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
