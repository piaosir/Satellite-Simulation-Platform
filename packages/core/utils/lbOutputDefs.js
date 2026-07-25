// 链路预算「可绘输出量」清单 —— 参数扫描器的因变量池。
//
// 引擎出参是个 170 项上下的扁平对象，里面混着回显值（把入参原样抄回去）、
// 文本判定值（极化名、限制项名）和真正的计算量。全丢给用户勾选只会淹没重点，
// 故此处按物理意义挑出可绘者并分组，附上标签与「引擎原生单位」。
//
// 单位口径：一律用引擎出参本身的单位，不走 adaptiveUnits 的显示自适应
//（W↔mW、kHz↔MHz 那套）。曲线的纵轴要在整段扫描里保持同一把尺子，
// 而自适应是按单点量级选档的，扫描中途换档会让曲线出现假台阶。
//
// 三体制共用一张表：GEO / NGSO / 再生式的引擎键名大面积同名，各体制不存在的键
// 在扫描结果里自然缺席（前端按实际返回的键过滤），不必各维护一份。
//
// crit / good：该量的工程临界值与「哪一侧算好」。只有真正存在硬临界的量才写
//（余量跨 0 即链路不成立、占用越过 100% 即资源不够），是客观门限不是主观评价。
// 设计空间图据此给这些量配发散色标（临界值为中性灰中点、两侧异色），其余量配
// 单色顺序色标——色标中点因此永远落在有物理含义的地方，而不是数据的中位数上。

// labelEn / titleEn：功能区「语言」切到 English 时图表区取的英文名（场变量下拉、轴名、
// 色标名、导出的 CSV 表头）。译法与 utils/waterfallBuilder.js 的 WF_DICT 及
// electron/services/report.js 的英文列头对齐——同一条链路的表、图、导出不能各说一套。
//
// geoSide / geoField：地理场图（站址经纬度铺成平面）专用的两项声明，各管一件事。
//
// geoSide = 这个量随哪一端的站址变，实测口径（见 test/linkSweep2D.test.js 的按端归属用例）：
//   'tx'     只由发信站站址决定——收信站挪到哪儿它都纹丝不动（上行传播、上行几何）
//   'rx'     只由收信站站址决定（下行传播、下行几何、收信站噪声与 G/T）
//   'both'   两端都影响：要么本就是全链路量（余量、合计 C/N），要么经求解方式间接耦合
//            ——「设置余量」下挪动收信站会改下行 C/N，求解器随即改发信站功放，于是
//            上行 C/N 跟着变。名字里的「上行」说的是它属于哪一段链路，不是只随哪一端变。
//   'either' 站址地理量本身：扫哪一端就是哪一端的值（降雨率、海拔）
//   未声明   与站址无关，扫站址平面时恒为常数（门限 C/N、符号速率、天线增益、可用度组全部）
// 扫某一端的站址时，另一端专属的量（geoSide 为对端）整组不列——它们在这次扫描里逐格同值，
// 列出来只是让人白点一遍；'both' 与 'either' 则始终可选。
//
// geoField = 是否列进地理场图的「场」下拉。geoSide 讲的是物理事实，这一项是策展：
// 中间量（云噪温、旁瓣 EIRP、功率带宽）、同一个量的另一种记法（Es/N₀ 与 Eb/N₀、功放建议
// 功率的 W 与 dBW）与只在转发器账本上有意义的量（资源占用整组）有值也不列，免得下拉长到
// 没人看。反过来，「与别的量差一个常数」本身不是剔除的理由——功率谱密度是对着协调门限看的，
// 要的正是这条线自己落在哪。分组与组内次序即下拉里的分组与次序。
const OUTPUT_GROUPS = [
  {
    key: 'quality', title: '链路质量', titleEn: 'Link Quality',
    items: [
      { key: 'linkmargin', label: '链路余量', labelEn: 'Link Margin', unit: 'dB', crit: 0, good: 'above', geoSide: 'both', geoField: true },
      { key: 'carrierTotalCN', label: '合计 C/N', labelEn: 'Combined C/N', unit: 'dB', geoSide: 'both', geoField: true },
      { key: 'thresholdCN', label: '门限 C/N', labelEn: 'Threshold C/N', unit: 'dB' },
      { key: 'uplinkCN', label: '上行 C/N', labelEn: 'Uplink C/N', unit: 'dB', geoSide: 'both', geoField: true },
      { key: 'downlinkCN', label: '下行 C/N', labelEn: 'Downlink C/N', unit: 'dB', geoSide: 'both', geoField: true },
      { key: 'uplinkThermalCN', label: '上行 C/N（热噪声）', labelEn: 'Uplink C/N (Thermal)', unit: 'dB', geoSide: 'both' },
      { key: 'downlinkThermalCN', label: '下行 C/N（热噪声）', labelEn: 'Downlink C/N (Thermal)', unit: 'dB', geoSide: 'both' },
      { key: 'uplinkInterferenceCN', label: '上行 C/I', labelEn: 'Uplink C/I', unit: 'dB', geoSide: 'both' },
      { key: 'downlinkInterferenceCN', label: '下行 C/I', labelEn: 'Downlink C/I', unit: 'dB', geoSide: 'both' },
      { key: 'ebnoActualResult', label: 'Eb/N₀（实际）', labelEn: 'Eb/N₀ (Actual)', unit: 'dB', geoSide: 'both', geoField: true },
      { key: 'esnoActualResult', label: 'Es/N₀（实际）', labelEn: 'Es/N₀ (Actual)', unit: 'dB', geoSide: 'both' },
      { key: 'carrierTotalCN0', label: '合计 C/N₀', labelEn: 'Combined C/N₀', unit: 'dBHz', geoSide: 'both' },
      { key: 'totalCN0Result', label: '总 C/N₀（含干扰）', labelEn: 'Total C/N₀ (incl. Interference)', unit: 'dBHz', geoSide: 'both' }
    ]
  },
  {
    // 资源占用整组不进地理场图（geoField 一个不给）：这些量确实随站址变，但变的是同一件事
    // ——站挪到雨大的地方功放得顶上去，功率占用与转发器回退跟着走，铺成平面就是「功放建议
    // 功率」那张图换把尺子重画一遍。占用是转发器账本上的数，看本条链路自己那一格就够。
    // 表里照常逐行给，只是不列进「场」下拉。
    key: 'resource', title: '资源占用', titleEn: 'Resource Usage',
    items: [
      { key: 'powerUsageRatio', label: '功率占用', labelEn: 'Power Usage', unit: '%', crit: 100, good: 'below', geoSide: 'both' },
      { key: 'bandwidthUsageRatio', label: '带宽占用', labelEn: 'Bandwidth Usage', unit: '%', crit: 100, good: 'below' },
      { key: 'allocBandwidthResult', label: '分配带宽', labelEn: 'Allocated Bandwidth', unit: 'kHz' },
      { key: 'PowerBWResult', label: '功率带宽', labelEn: 'Power Bandwidth', unit: 'kHz', geoSide: 'both' },
      { key: 'maxCarrierCount', label: '最大载波数', labelEn: 'Max Carrier Count', unit: '', geoSide: 'both' },
      { key: 'spectralEfficiencyResult', label: '频谱效率', labelEn: 'Spectral Efficiency', unit: 'bps/Hz' },
      { key: 'symbolRateResult', label: '符号速率', labelEn: 'Symbol Rate', unit: 'kBaud' },
      { key: 'transponderBackoffResult', label: '转发器工作区回退', labelEn: 'Transponder Operating Backoff', unit: 'dB', geoSide: 'both' }
    ]
  },
  {
    key: 'power', title: '功率与电平', titleEn: 'Power & Levels',
    items: [
      // 功放建议功率的 W 与 dBW 是同一个量的两种记法，下拉里只列 dBW 的那条：两条并排就是
      // 一模一样的名字挨着出现两遍，只有括号里的单位不同；等值线也该画在 dB 上，画在 W 上
      // 同样的功率差在高低端会摊出宽窄不一的间距。W 那条留在表里。
      { key: 'paRecommendation', label: '功放建议功率', labelEn: 'Recommended PA Power', unit: 'W', geoSide: 'both' },
      { key: 'paRecommendationdBResult', label: '功放建议功率', labelEn: 'Recommended PA Power', unit: 'dBW', geoSide: 'both', geoField: true },
      { key: 'stationEIRPResult', label: '发信站 EIRP', labelEn: 'Tx Station EIRP', unit: 'dBW', geoSide: 'both', geoField: true },
      // 功率谱密度上下行各列一条：它俩是协调门限直接卡的量（上行对 ITU RR Art.21 / S.524-9
      // 的 PSD 门限，下行与到达地面通量密度同属落地约束），「这条链路搬到哪儿还合规」问的
      // 就是它——铺成平面看得见哪片站址会顶到门限。上行那条在固定带宽下是发信站 EIRP 平移
      // 一个常数（同形），照列不误：合不合规看的是这条线本身落在哪，不是它的形状。
      { key: 'stationPSDResult', label: '发信站功率谱密度', labelEn: 'Tx Station PSD', unit: 'dBW/Hz', geoSide: 'both', geoField: true },
      { key: 'arrivalPFDAtSatelliteResult', label: '到达卫星通量密度', labelEn: 'PFD at Satellite', unit: 'dBW/m²', geoSide: 'both', geoField: true },
      { key: 'arrivalPFDAtGroundResult', label: '到达地面通量密度', labelEn: 'PFD at Ground', unit: 'dBW/m²', geoSide: 'both', geoField: true },
      { key: 'transponderOutputEIRP', label: '转发器输出 EIRP', labelEn: 'Transponder Output EIRP', unit: 'dBW', geoSide: 'both' },
      { key: 'satellitePSDResult', label: '卫星功率谱密度', labelEn: 'Satellite PSD', unit: 'dBW/Hz', geoSide: 'both', geoField: true },
      { key: 'txSidelobeEIRPResult', label: '旁瓣 EIRP', labelEn: 'Sidelobe EIRP', unit: 'dBW', geoSide: 'both' }
    ]
  },
  {
    key: 'propagation', title: '传播', titleEn: 'Propagation',
    items: [
      { key: 'uplinkFSLResult', label: '上行自由空间损耗', labelEn: 'Uplink Free Space Loss', unit: 'dB', geoSide: 'tx', geoField: true },
      { key: 'downlinkFSLResult', label: '下行自由空间损耗', labelEn: 'Downlink Free Space Loss', unit: 'dB', geoSide: 'rx', geoField: true },
      { key: 'uplinkRainAttenuation', label: '上行雨衰 P.618', labelEn: 'Uplink Rain Attenuation P.618', unit: 'dB', geoSide: 'tx', geoField: true },
      { key: 'downlinkRainAttenuationResult', label: '下行雨衰 P.618', labelEn: 'Downlink Rain Attenuation P.618', unit: 'dB', geoSide: 'rx', geoField: true },
      { key: 'uplinkRainHeightResult', label: '上行雨高', labelEn: 'Uplink Rain Height', unit: 'km', geoSide: 'tx', geoField: true },
      { key: 'downlinkRainHeightResult', label: '下行雨高', labelEn: 'Downlink Rain Height', unit: 'km', geoSide: 'rx', geoField: true },
      { key: 'uplinkCloudAttenuation', label: '上行云衰 P.840', labelEn: 'Uplink Cloud Attenuation P.840', unit: 'dB', geoSide: 'tx', geoField: true },
      { key: 'downlinkCloudAttenuation', label: '下行云衰 P.840', labelEn: 'Downlink Cloud Attenuation P.840', unit: 'dB', geoSide: 'rx', geoField: true },
      { key: 'uplinkAtmosphericAttenuationResult', label: '上行大气衰减 P.676', labelEn: 'Uplink Atmospheric Attenuation P.676', unit: 'dB', geoSide: 'tx', geoField: true },
      { key: 'downlinkAtmosphericAttenuationResult', label: '下行大气衰减 P.676', labelEn: 'Downlink Atmospheric Attenuation P.676', unit: 'dB', geoSide: 'rx', geoField: true },
      { key: 'uplinkScintillationResult', label: '上行闪烁 P.618', labelEn: 'Uplink Scintillation P.618', unit: 'dB', geoSide: 'tx', geoField: true },
      { key: 'downlinkScintillationResult', label: '下行闪烁 P.618', labelEn: 'Downlink Scintillation P.618', unit: 'dB', geoSide: 'rx', geoField: true },
      // 「总衰减 AT(p)」= ITU-R P.618-14 §2.5 式(65)：AG + √((AR+AC)² + AS²)，含雨衰在内。
      // 曾标作「晴空总衰减」是错的——雨衰常是其中最大的一项（Ku 频段 99.9% 可用度下可占九成）。
      { key: 'uplinkTotalAttenuationResult', label: '上行总衰减 AT(p)', labelEn: 'Uplink Total Attenuation AT(p)', unit: 'dB', geoSide: 'tx', geoField: true },
      { key: 'downlinkTotalAttenuationResult', label: '下行总衰减 AT(p)', labelEn: 'Downlink Total Attenuation AT(p)', unit: 'dB', geoSide: 'rx', geoField: true }
    ]
  },
  {
    // 噪声与 G/T 全在收信站一端：系统噪温、天线噪温、雨致劣化算的都是接收系统。
    key: 'noise', title: '噪声与天线', titleEn: 'Noise & Antenna',
    items: [
      { key: 'systemNoiseTempKResult', label: '收信站系统噪温', labelEn: 'Rx System Noise Temperature', unit: 'K', geoSide: 'rx', geoField: true },
      { key: 'antennaNoiseTempResult', label: '收信站天线噪温', labelEn: 'Rx Antenna Noise Temperature', unit: 'K', geoSide: 'rx', geoField: true },
      { key: 'cloudNoiseTempResult', label: '云噪声温度', labelEn: 'Cloud Noise Temperature', unit: 'K', geoSide: 'rx' },
      { key: 'rainNoiseTempResult', label: '雨噪声温度', labelEn: 'Rain Noise Temperature', unit: 'K', geoSide: 'rx' },
      { key: 'gOverTeResult', label: '收信站 G/T', labelEn: 'Rx Station G/T', unit: 'dB/K', geoSide: 'rx', geoField: true },
      { key: 'gOverTdegradationResult', label: 'G/T 劣化（降雨）', labelEn: 'G/T Degradation (Rain)', unit: 'dB', geoSide: 'rx', geoField: true },
      { key: 'txAntennaGainResult', label: '发信站天线增益', labelEn: 'Tx Station Antenna Gain', unit: 'dBi' },
      { key: 'rxAntennaGainResult', label: '收信站天线增益', labelEn: 'Rx Station Antenna Gain', unit: 'dBi' },
      { key: 'beamWidthResult', label: '发信站天线波束宽度', labelEn: 'Tx Station Antenna Beamwidth', unit: '°' }
    ]
  },
  {
    key: 'geometry', title: '几何', titleEn: 'Geometry',
    items: [
      { key: 'elevationResult', label: '发信站仰角', labelEn: 'Tx Station Elevation', unit: '°', geoSide: 'tx', geoField: true },
      { key: 'rxElevationResult', label: '收信站仰角', labelEn: 'Rx Station Elevation', unit: '°', geoSide: 'rx', geoField: true },
      { key: 'azimuthResult', label: '发信站方位角', labelEn: 'Tx Station Azimuth', unit: '°', geoSide: 'tx', geoField: true },
      { key: 'rxAzimuthResult', label: '收信站方位角', labelEn: 'Rx Station Azimuth', unit: '°', geoSide: 'rx', geoField: true },
      { key: 'slantRangeResult', label: '上行斜距', labelEn: 'Uplink Slant Range', unit: 'km', geoSide: 'tx', geoField: true },
      { key: 'rxSlantRangeResult', label: '下行斜距', labelEn: 'Downlink Slant Range', unit: 'km', geoSide: 'rx', geoField: true },
      { key: 'linkDelayResult', label: '单跳时延', labelEn: 'One-hop Delay', unit: 'ms', geoSide: 'both', geoField: true }
    ]
  },
  {
    // 站址地理量：不是引擎算出来的，是「站址联动」按每个格点的经纬度查表得到的入参。
    // 之所以也当输出量收下来：它们本身就是随经纬度变的地理场，画在地图上比任何
    // 计算结果都直观（降雨率场就是一张雨区分布图），也便于核对联动到底取到了什么值。
    key: 'site', title: '站址地理量', titleEn: 'Site Geography',
    items: [
      { key: 'siteRainRate', label: '降雨率 R0.01%', labelEn: 'Rain Rate R0.01%', unit: 'mm/h', geoSide: 'either', geoField: true },
      { key: 'siteAltitude', label: '站点海拔', labelEn: 'Site Altitude', unit: 'm', geoSide: 'either', geoField: true }
    ]
  },
  {
    // 可用度整组不给 geoSide：四项都是可用度入参的回显或其换算（年中断时长 = 由系统可用度
    // 折算），站挪到哪儿都不变。曾把「年中断时长」列进地理场图，那张图必然是一片纯色。
    key: 'availability', title: '可用度', titleEn: 'Availability',
    items: [
      { key: 'systemAvailabilityResult', label: '系统可用度', labelEn: 'System Availability', unit: '%' },
      { key: 'uplinkAvailabilityResult', label: '上行可用度', labelEn: 'Uplink Availability', unit: '%' },
      { key: 'downlinkAvailabilityResult', label: '下行可用度', labelEn: 'Downlink Availability', unit: '%' },
      { key: 'interruptionMinutes', label: '年中断时长', labelEn: 'Annual Outage Time', unit: 'min' }
    ]
  }
];

// 扁平索引：key → { key, label, unit, group }
const OUTPUT_INDEX = {};
for (const g of OUTPUT_GROUPS) {
  for (const it of g.items) OUTPUT_INDEX[it.key] = { ...it, group: g.key, groupTitle: g.title };
}

// 扫描默认返回的键集（= 清单里的全部）。扫描一次就把这些键全算出来，
// 前端换 y 变量时直接改画，不必重跑引擎。
const ALL_OUTPUT_KEYS = Object.keys(OUTPUT_INDEX);

module.exports = { OUTPUT_GROUPS, OUTPUT_INDEX, ALL_OUTPUT_KEYS };
