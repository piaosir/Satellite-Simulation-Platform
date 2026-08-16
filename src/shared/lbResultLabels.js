// 引擎出参的中文名与单位（自定义列的字段池用；GEO / NGSO / 再生式三体制共用一张表）。
//
// 为什么要有这张表：引擎结果是个 160+ 项的扁平对象，键名是 ASCII 驼峰（xpdrIntermodCTResult）。
// 自定义列要让用户按名字挑字段，就不能把裸键名端上去——那既读不懂也标不出单位（单位是量纲演算
// 的输入，缺了整列口径就成「无量纲」）。lbOutputDefs 那份是【策展短名单】（可绘的、进图表的），
// 这份是【全量词表】：凡引擎出的数值键都要有名有单位。
//
// 命名与详细预算/报表同源（术语取自 utils/waterfallBuilder.js 的行标签）：同一个量在瀑布里叫什么，
// 这里就叫什么，不另起一套。单位一律写引擎出参本身的口径（不做 W↔mW 那套显示自适应）。
//
// 分组即「插入字段」下拉里的分组，次序即组内次序。
// ★ 新增引擎出参时这里要跟着加：packages/core/test/lbCustomCols.test.mjs 钉死了三体制 100% 覆盖，
//   漏了会直接测试失败（那条断言就是防止裸键名重新漏进界面）。

const G = (title, items) => items.map(([key, label, unit]) => ({ key, label, unit, group: title }))

const RESULT_LABEL_LIST = [
  ...G('载波与调制', [
    ['infoRateResult', '信息速率', 'kbps'],
    ['carrierRateResult', '载波速率', 'kbps'],
    ['symbolRateResult', '符号速率', 'ksps'],
    ['ChipRateResult', '码片速率', 'kcps'],
    ['allocBandwidthResult', '载波带宽', 'kHz'],
    ['PowerBWResult', '功率带宽', 'kHz'],
    ['noiseBW', '噪声带宽', 'kHz'],
    ['RXnoiseBW', '载波噪声带宽 10·lgB', 'dB'],
    ['spectralEfficiencyResult', '频谱效率', 'bps/Hz'],
    ['modulationFactorResult', '调制因子', ''],
    ['fecResult', 'FEC 码率', ''],
    ['rsCodeResult', 'RS 码率', ''],
    ['berResult', '误码率', ''],
    ['ebnoResult', '门限 Eb/N₀', 'dB'],
    ['esnoResult', '门限 Es/N₀', 'dB'],
    ['ebnoActualResult', 'Eb/N₀（实际）', 'dB'],
    ['esnoActualResult', 'Es/N₀（实际）', 'dB'],
    ['marginResult', '系统余量（输入）', 'dB']
  ]),
  ...G('链路质量', [
    ['linkmargin', '链路余量', 'dB'],
    ['carrierTotalCN', '合计 C/(N+I)', 'dB'],
    ['thresholdCN', '门限 C/N', 'dB'],
    ['uplinkCN', '上行 C/(N+I)', 'dB'],
    ['downlinkCN', '下行 C/(N+I)', 'dB'],
    ['uplinkThermalCN', '上行 C/N（热噪声）', 'dB'],
    ['downlinkThermalCN', '下行 C/N（热噪声）', 'dB'],
    ['uplinkInterferenceCN', '上行 C/I', 'dB'],
    ['downlinkInterferenceCN', '下行 C/I', 'dB'],
    ['uplinkWithIslCN', '上行 C/N（含 ISL）', 'dB'],
    ['carrierTotalCN0', '合计 C/N₀', 'dBHz'],
    ['carrierTotalCT', '合计 C/T', 'dBW/K'],
    ['carrierThresholdCN0', '门限 C/N₀', 'dBHz'],
    ['carrierThresholdCT', '门限 C/T', 'dBW/K'],
    ['actualUplinkCT', '载波上行 C/T', 'dBW/K'],
    ['actualUplinkCN0', '载波上行 C/N₀', 'dBHz'],
    ['actualDownlinkCT', '载波下行 C/T', 'dBW/K'],
    ['actualDownlinkCN0', '载波下行 C/N₀', 'dBHz']
  ]),
  ...G('C/T · C/N₀ 分项（转发器参考口径）', [
    ['uplinkCTResult', '上行热噪声 C/T', 'dBW/K'],
    ['uplinkCN0Result', '上行热噪声 C/N₀', 'dBHz'],
    ['downlinkCTResult', '下行热噪声 C/T', 'dBW/K'],
    ['downlinkCN0Result', '下行热噪声 C/N₀', 'dBHz'],
    ['downlinkTotalCTResult', '下行总 C/T（含干扰）', 'dBW/K'],
    ['totalCTResult', '总 C/T（含干扰）', 'dBW/K'],
    ['totalCN0Result', '总 C/N₀（含干扰）', 'dBHz'],
    ['totalCTRainResult', '总 C/T（含干扰·降雨）', 'dBW/K'],
    ['totalCN0RainResult', '总 C/N₀（含干扰·降雨）', 'dBHz']
  ]),
  ...G('干扰分项', [
    ['downlinkInterferenceLossResult', '下行干扰损失 ACI/ASI/XPI/IM', 'dB'],
    ['aciUplinkCTResult', '上行邻道干扰 C/T', 'dBW/K'],
    ['aciUplinkCN0Result', '上行邻道干扰 C/N₀', 'dBHz'],
    ['adjUplinkCTResult', '上行邻星干扰 C/T', 'dBW/K'],
    ['adjUplinkCN0Result', '上行邻星干扰 C/N₀', 'dBHz'],
    ['xpolUplinkCTResult', '上行交叉极化 C/T', 'dBW/K'],
    ['xpolUplinkCN0Result', '上行交叉极化 C/N₀', 'dBHz'],
    ['hpaIntermodCTResult', '功放互调 C/T', 'dBW/K'],
    ['hpaIntermodCN0Result', '功放互调 C/N₀', 'dBHz'],
    ['aciDownlinkCTResult', '下行邻道干扰 C/T', 'dBW/K'],
    ['aciDownlinkCN0Result', '下行邻道干扰 C/N₀', 'dBHz'],
    ['adjDownlinkCTResult', '下行邻星干扰 C/T', 'dBW/K'],
    ['adjDownlinkCN0Result', '下行邻星干扰 C/N₀', 'dBHz'],
    ['xpolDownlinkCTResult', '下行交叉极化 C/T', 'dBW/K'],
    ['xpolDownlinkCN0Result', '下行交叉极化 C/N₀', 'dBHz'],
    ['xpdrIntermodCTResult', '转发器互调 C/T', 'dBW/K'],
    ['xpdrIntermodCN0Result', '转发器互调 C/N₀', 'dBHz'],
    ['effectiveXpolUplinkFactorResult', '上行有效 XPI（含雨致 XPD）', 'dB'],
    ['effectiveXpolDownlinkFactorResult', '下行有效 XPI（含雨致 XPD）', 'dB']
    // 离轴鉴别度 deltagain 随邻星离轴口径整组移除（2026-08-07，见 linkCalculator.js 同日注释）
  ]),
  ...G('功率与电平', [
    ['paRecommendation', '功放建议功率', 'W'],
    ['paRecommendationdBResult', '功放建议功率电平', 'dBW'],
    ['selectedPowerResult', '功放实际输出电平', 'dBW'],
    ['selectedPowerWResult', '功放实际输出', 'W'],
    ['UPCmarginResult', 'UPC 上行功控余量', 'dB'],
    ['stationEIRPResult', '发信站 EIRP', 'dBW'],
    ['stationPSDResult', '发信站功率谱密度', 'dBW/Hz'],
    // 旁瓣增益/EIRP/PSD 与 ITU-R S.524 的 PSD 门限随邻星离轴口径整组移除（2026-08-07）：
    // 它们全由 deltaTheta 派生，而平台无该输入框；离轴 EIRP 密度与协调门限看干扰分析模块。
    ['arrivalPFDAtSatelliteResult', '到达卫星通量密度', 'dBW/m²'],
    ['arrivalPFDAtGroundResult', '到达地面通量密度', 'dBW/m²'],
    ['PFDcResult', '每载波到达通量密度', 'dBW/m²'],
    ['ituPfdLimit4kHz', 'ITU PFD 限值（4 kHz）', 'dBW/m²'],
    ['ituPfdLimitPerM2', 'ITU PFD 限值（载波带宽）', 'dBW/m²'],
    ['ituPfdRefBandwidth', 'ITU PFD 参考带宽', 'kHz'],
    ['satellitePSDResult', '卫星功率谱密度', 'dBW/Hz'],
    ['transponderOutputEIRP', '转发器输出 EIRP', 'dBW'],
    ['eirpPerCarrier', '每载波 EIRP（上行雨）', 'dBW'],
    ['RXeirpPerCarrierResult', '每载波 EIRP（下行雨）', 'dBW']
  ]),
  ...G('转发器资源', [
    ['powerUsageRatio', '功率占用', '%'],
    ['bandwidthUsageRatio', '带宽占用', '%'],
    ['maxCarrierCount', '最大载波数', ''],
    ['uplinkPowerRatioResult', '上行雨功率占用', '%'],
    ['downlinkPowerRatioResult', '下行雨功率占用', '%'],
    ['transponderCapacity', '转发器工作区回退（上行雨）', 'dB'],
    ['RXtransponderCapacityResult', '转发器工作区回退（下行雨）', 'dB'],
    ['actualTransponderCapacityResult', '转发器工作区回退', 'dB'],
    ['transponderBackoffResult', '转发器工作区回退（总）', 'dB'],
    ['downlinkComponentResult', '下行雨卫星总 C/T', 'dBW/K'],
    ['EIRPsResult', '卫星饱和 EIRP', 'dBW'],
    ['SFDsResult', '卫星 SFD', 'dBW/m²'],
    ['satelliteGTResult', '卫星 G/T', 'dB/K'],
    ['antennaGainResult', '卫星天线单位面积增益', 'dBi'],
    ['BOiResult', 'IBO 输入回退', 'dB'],
    ['BOoResult', 'OBO 输出回退', 'dB'],
    ['transponderBandwidthResult', '转发器带宽', 'MHz'],
    ['orbitPositionResult', '卫星轨道位置', '°E'],
    ['orbitAltitudeResult', '轨道高度', 'km']
  ]),
  ...G('传播', [
    ['uplinkFSLResult', '上行自由空间损耗', 'dB'],
    ['downlinkFSLResult', '下行自由空间损耗', 'dB'],
    ['uplinkRainAttenuation', '上行雨衰 P.618', 'dB'],
    ['downlinkRainAttenuationResult', '下行雨衰 P.618', 'dB'],
    ['uplinkRainHeightResult', '上行雨高 P.839', 'km'],
    ['downlinkRainHeightResult', '下行雨高 P.839', 'km'],
    ['uplinkCloudAttenuation', '上行云衰 P.840', 'dB'],
    ['downlinkCloudAttenuation', '下行云衰 P.840', 'dB'],
    ['uplinkAtmosphericAttenuationResult', '上行大气衰减 P.676', 'dB'],
    ['downlinkAtmosphericAttenuationResult', '下行大气衰减 P.676', 'dB'],
    ['uplinkScintillationResult', '上行闪烁 P.618', 'dB'],
    ['downlinkScintillationResult', '下行闪烁 P.618', 'dB'],
    ['uplinkTotalAttenuationResult', '上行总衰减 AT(p)', 'dB'],
    ['downlinkTotalAttenuationResult', '下行总衰减 AT(p)', 'dB'],
    ['uplinkMiscLossResult', '上行其他损耗', 'dB'],
    ['downlinkMiscLossResult', '下行其他损耗', 'dB']
  ]),
  ...G('噪声与天线', [
    ['systemNoiseTempKResult', '收信站系统噪温', 'K'],
    ['systemNoiseTempDbResult', '收信站系统噪温电平', 'dBK'],
    ['antennaNoiseTempResult', '收信站天线噪温', 'K'],
    ['receiverNoiseTempResult', '接收机噪温', 'K'],
    ['rainNoiseTempResult', '雨噪声温度', 'K'],
    ['cloudNoiseTempResult', '云噪声温度', 'K'],
    ['gOverTeResult', '收信站 G/T', 'dB/K'],
    ['gOverTdegradationResult', 'G/T 劣化（降雨）', 'dB'],
    ['txAntennaGainResult', '发信站天线增益', 'dBi'],
    ['rxAntennaGainResult', '收信站天线增益', 'dBi'],
    ['beamWidthResult', '发信站波束宽度', '°'],
    ['theta3', '收信站波束宽度', '°'],
    ['feederLossResult', '发信站馈线损耗', 'dB'],
    ['rxFeederLossResult', '收信站馈线损耗', 'dB'],
    ['earthAntennaDiameterResult', '发信站天线口径', 'm'],
    ['rxAntennaDiameterResult', '收信站天线口径', 'm'],
    ['earthAntennaEfficiencyResult', '发信站天线效率', '%'],
    ['rxAntennaEfficiencyResult', '收信站天线效率', '%'],
    ['wavelengthResult', '上行波长', 'm'],
    ['rxWavelengthResult', '下行波长', 'm']
  ]),
  ...G('几何', [
    ['elevationResult', '发信站仰角', '°'],
    ['rxElevationResult', '收信站仰角', '°'],
    ['azimuthResult', '发信站方位角', '°'],
    ['rxAzimuthResult', '收信站方位角', '°'],
    ['slantRangeResult', '上行斜距', 'km'],
    ['rxSlantRangeResult', '下行斜距', 'km'],
    ['linkDelayResult', '单跳时延', 'ms'],
    ['linkDelayUpResult', '上行时延', 'ms'],
    ['linkDelayDownResult', '下行时延', 'ms'],
    ['earthLongitudeResult', '发信站经度', '°E'],
    ['earthLatitudeResult', '发信站纬度', '°'],
    ['rxLongitudeResult', '收信站经度', '°E'],
    ['rxLatitudeResult', '收信站纬度', '°'],
    ['uplinkFrequencyResult', '上行频率', 'GHz'],
    ['downlinkFrequencyResult', '下行频率', 'GHz'],
    ['uplinkPolarizationAngleResult', '上行极化角', '°'],
    ['downlinkPolarizationAngleResult', '下行极化角', '°']
  ]),
  ...G('可用度', [
    ['systemAvailabilityResult', '系统可用度', '%'],
    ['uplinkAvailabilityResult', '上行可用度', '%'],
    ['downlinkAvailabilityResult', '下行可用度', '%'],
    ['interruptionMinutes', '年中断时长', 'min'],
    ['interruptionHours', '年中断时长（小时）', 'h']
  ]),
  ...G('星间链路', [
    ['islHopsResult', 'ISL 跳数', ''],
    ['islPerHopCTResult', 'ISL 单跳 C/T', 'dBW/K'],
    ['islPerHopCNResult', 'ISL 单跳 C/N', 'dB'],
    ['islPerHopThermalCNResult', 'ISL 单跳 C/N（热噪声）', 'dB'],
    ['islCIResult', 'ISL 星间 C/I', 'dB'],
    ['islTotalCTResult', 'ISL 多跳等效 C/T', 'dBW/K'],
    ['islTotalCNResult', 'ISL 多跳等效 C/N', 'dB'],
    ['islCascadeCNResult', 'ISL 级联 C/N', 'dB'],
    ['islImpactResult', 'ISL 对上行的代价', 'dB'],
    ['islRfEirpResult', 'ISL 发射 EIRP', 'dBW'],
    ['islRfFreqResult', 'ISL 频率', 'GHz'],
    ['islRfDistResult', 'ISL 星间距离', 'km'],
    ['islRfFslResult', 'ISL 自由空间损耗', 'dB'],
    ['islRfGtResult', 'ISL 接收 G/T', 'dB/K'],
    ['islRfMiscLossResult', 'ISL 其他损耗', 'dB']
  ])
]

const RESULT_LABELS = {}
for (const it of RESULT_LABEL_LIST) RESULT_LABELS[it.key] = it

/**
 * 引擎结果对象 → 有名有单位的字段池条目（只出该结果里真有的键，故天然分体制）。
 * keys＝要收的键集合（调用方已按数值/黑名单过滤）；未收录的键由调用方兜底成裸键名。
 */
export function labeledResultPool(keys) {
  const out = []
  for (const it of RESULT_LABEL_LIST) if (keys.has(it.key)) out.push({ key: it.key, label: it.label, unit: it.unit, group: it.group })
  return out
}

export { RESULT_LABELS, RESULT_LABEL_LIST }
