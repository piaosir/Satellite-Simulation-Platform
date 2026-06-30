// GEO 链路预算 — 完整专业参数 schema。
// 默认值严格对齐小程序 app.js 的 getDefaultSatelliteParams / getDefaultLinkParams（权威口径）。
// 字段集对齐小程序 index.wxml 的 data-field（用户真正暴露的输入）；引擎自动算的项
// （指向误差/天线罩/极化损耗/连接器损耗等）不在此暴露。
// 每个字段标注 target：'sat' → satParams，'link' → inputs。auto：'rain'|'elev' 为按经纬度自动填。

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
    key: 'sat', title: '卫星与转发器', icon: 'sat',
    fields: [
      { key: 'satelliteName', label: '卫星名称', type: 'text', def: 'Satellite', target: 'sat' },
      { key: 'frequencyBand', label: '工作频段', type: 'select', options: ['L', 'S', 'X', 'ExtC', 'C', 'ExtKu', 'Ku', 'Ku-BSS', 'Ka', 'Q', 'V'], def: 'Ku', target: 'sat' },
      { key: 'centerFrequency', label: '上行频率', tip: '上行中心频率', unit: 'GHz', type: 'num', def: '14.25', target: 'link', pair: 'up' },
      { key: 'uplinkPolarization', label: '上行极化', tip: '上行极化方式', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'V', target: 'link', pair: 'up' },
      { key: 'rxCenterFrequency', label: '下行频率', tip: '下行中心频率', unit: 'GHz', type: 'num', def: '12.5', target: 'link', pair: 'dn' },
      { key: 'downlinkPolarization', label: '下行极化', tip: '下行极化方式', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'H', target: 'link', pair: 'dn' },
      { key: 'orbitPosition', label: '定点轨道经度', tip: '卫星定点轨道经度', unit: '°E', type: 'num', def: '110.5', target: 'sat' },
      { key: 'sfdRef', label: 'SFDref', tip: '饱和通量密度参考值 (Saturation Flux Density)', unit: 'dBW/m²', type: 'num', def: '-84', target: 'sat' },
      { key: 'sfdGtRef', label: 'G/Tref', tip: '参考点卫星品质因数 G/T', unit: 'dB/K', type: 'num', def: '0', target: 'sat' },
      { key: 'transponderBandwidth', label: 'Tpdr.带宽', tip: '转发器带宽 (Transponder Bandwidth)', unit: 'MHz', type: 'num', def: '36', target: 'sat' },
      { key: 'deltaTheta', label: '邻星离轴角', tip: '相邻卫星离轴角', unit: '°', type: 'num', def: '2.5', target: 'sat' },
      { key: 'BOi', label: 'Tpdr. IBO', tip: '转发器输入回退 (Input Back-Off)', unit: 'dB', type: 'num', def: '6', target: 'sat' },
      { key: 'BOo', label: 'Tpdr. OBO', tip: '转发器输出回退 (Output Back-Off)', unit: 'dB', type: 'num', def: '3', target: 'sat' },
      // 干扰系数：按上下行分左右各四组（上行在左、下行在右），逐行成对显示
      { key: 'aciUplinkFactor', label: '上行C/ACI', tip: '上行载波/邻道干扰比 (Adjacent Channel Interference)', unit: 'dB', type: 'num', def: '30', target: 'sat', pair: 'aci' },
      { key: 'aciDownlinkFactor', label: '下行C/ACI', tip: '下行载波/邻道干扰比', unit: 'dB', type: 'num', def: '30', target: 'sat', pair: 'aci' },
      { key: 'adjUplinkFactor', label: '上行C/ASI', tip: '上行载波/邻星干扰比 (Adjacent Satellite Interference)', unit: 'dB', type: 'num', def: '25', target: 'sat', pair: 'asi' },
      { key: 'adjDownlinkFactor', label: '下行C/ASI', tip: '下行载波/邻星干扰比', unit: 'dB', type: 'num', def: '25', target: 'sat', pair: 'asi' },
      { key: 'xpolUplinkFactor', label: '上行C/XPI', tip: '上行载波/交叉极化干扰比 (Cross-Polarization Interference)', unit: 'dB', type: 'num', def: '26', target: 'sat', pair: 'xpi' },
      { key: 'xpolDownlinkFactor', label: '下行C/XPI', tip: '下行载波/交叉极化干扰比', unit: 'dB', type: 'num', def: '26', target: 'sat', pair: 'xpi' },
      { key: 'hpaIntermodFactor', label: 'HPA C/IM', tip: '高功放载波/互调比 (HPA Intermodulation)', unit: 'dB', type: 'num', def: '24', target: 'sat', pair: 'im' },
      { key: 'xpdrIntermodFactor', label: 'Tpdr. C/IM', tip: '转发器载波/互调比 (Transponder Intermodulation)', unit: 'dB', type: 'num', def: '21', target: 'sat', pair: 'im' }
    ]
  },
  {
    key: 'uplink', title: '上行 · 发信站', icon: 'up',
    fields: [
      // 载波由发信站调制器产生（卫星只是弯管转发），故基带配置与发信站绑定而非收信站；放在表格最前一列
      // （StationGrid 把 fields[0] 当冻结的“关键列”处理）。target:'meta' 为 UI 专用字段，不进引擎参数
      // （见 buildParams 的过滤）。options 为空，实际选项由 LinkBudgetApp 按当前基带配置库动态生成并
      // 通过 StationGrid 的 select-options 注入。
      { key: 'basebandId', label: '基带配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'earthStationLocation', label: '地面站位置', type: 'text', def: '北京', target: 'link', city: 'tx' },
      { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'altitude', label: '海拔', unit: 'm', type: 'num', def: '47', target: 'link', auto: 'elev' },
      { key: 'antennaDiameter', label: '天线口径', unit: 'm', type: 'num', def: '6.2', target: 'link' },
      { key: 'antennaEfficiency', label: '天线效率', unit: '%', type: 'num', def: '65', target: 'link' },
      { key: 'G_Ts', label: '卫星G/T', unit: 'dB/K', type: 'num', def: '2', target: 'link' },
      { key: 'rainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '46.167', target: 'link', auto: 'rain' },
      { key: 'uplinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' },
      { key: 'uplinkPowerControl', label: 'UPC', type: 'select', options: ['否', '是', '自定义'], def: '否', target: 'link' },
      { key: 'upcValue', label: 'UPC值', unit: 'dB', type: 'num', def: '0', target: 'link' },
      { key: 'paBackoff', label: '功放回退', unit: 'dB', type: 'num', def: '5', target: 'link' },
      { key: 'feederLoss', label: '馈线损耗', unit: 'dB', type: 'num', def: '3.5', target: 'link' },
      { key: 'uplinkOtherLoss', label: '其他损耗', unit: 'dB', type: 'num', def: '0.3', target: 'link' }
    ]
  },
  {
    key: 'downlink', title: '下行 · 收信站', icon: 'down',
    fields: [
      { key: 'rxEarthStationLocation', label: '地面站位置', type: 'text', def: '北京', target: 'link', city: 'rx' },
      { key: 'rxLongitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'rxLatitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'rxAltitude', label: '海拔', unit: 'm', type: 'num', def: '47', target: 'link', auto: 'elev' },
      { key: 'rxAntennaDiameter', label: '天线口径', unit: 'm', type: 'num', def: '3.7', target: 'link' },
      { key: 'rxAntennaEfficiency', label: '天线效率', unit: '%', type: 'num', def: '65', target: 'link' },
      { key: 'rxEIRP', label: '卫星EIRP', unit: 'dBW', type: 'num', def: '46', target: 'link' },
      { key: 'rxAntennaNoiseTemp', label: '天线噪温', unit: 'K', type: 'num', def: '35', target: 'link' },
      { key: 'rxReceiverNoiseTemp', label: '接收机噪温', unit: 'K', type: 'num', def: '75', target: 'link' },
      { key: 'rxRainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '46.167', target: 'link', auto: 'rain' },
      { key: 'rxDownlinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' },
      { key: 'rxFeederLoss', label: '馈线损耗', unit: 'dB', type: 'num', def: '0.2', target: 'link' },
      { key: 'downlinkOtherLoss', label: '其他损耗', unit: 'dB', type: 'num', def: '0.3', target: 'link' }
    ]
  }
]

// 扁平字段表
export const ALL_FIELDS = FIELD_GROUPS.flatMap((g) => g.fields)

// 按模块取字段：4 模块 = 发信站群(uplink) / 卫星(sat) / 收信站群(downlink) / 基带(carrier)
const _grp = (k) => FIELD_GROUPS.find((g) => g.key === k).fields
export const CARRIER_FIELDS = _grp('carrier')
export const SAT_FIELDS = _grp('sat')
export const TX_FIELDS = _grp('uplink')   // 每个发信站一行（含上行链路参数）
export const RX_FIELDS = _grp('downlink') // 每个收信站一行（含下行链路参数）

// 给定字段集生成默认对象
export function defaultsFor(fields) {
  const o = {}
  for (const f of fields) o[f.key] = f.def
  return o
}

// 组装单条链路的 { satParams, linkParams }：卫星+载波共享，叠加某发信站(tx)与某收信站(rx)。
// 引擎入口换算 有效sfdRef = sfdRef + sfdGtRef（与小程序 _engineSatParams 一致）。
export function buildParams(satForm, carrierForm, txStation, rxStation) {
  const satParams = {}
  const linkParams = {}
  // 卫星模块字段按 target 分流：'sat' → satParams；'link'（如上/下行频率，全站共享）→ linkParams
  for (const f of SAT_FIELDS) (f.target === 'link' ? linkParams : satParams)[f.key] = satForm[f.key]
  for (const f of CARRIER_FIELDS) linkParams[f.key] = carrierForm[f.key]
  for (const f of TX_FIELDS) if (f.target !== 'meta') linkParams[f.key] = txStation[f.key]
  for (const f of RX_FIELDS) linkParams[f.key] = rxStation[f.key]
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
    const v = form[fld.key]
    if (fld.target === 'sat') satParams[fld.key] = v
    else linkParams[fld.key] = v
  }
  const gtRef = parseFloat(satParams.sfdGtRef)
  const sfd = parseFloat(satParams.sfdRef)
  if (gtRef && !isNaN(gtRef) && !isNaN(sfd)) satParams.sfdRef = sfd + gtRef
  return { satParams, linkParams }
}
