// utils/waterfallBuilder.js
// 链路瀑布表数据构建器（自 pages/results-detail 抽取共享）。
// 供结果详情页、历史记录/配置管理「专业版」导出共同使用，保证页面与报告口径完全一致。
//
// buildWaterfallSegments(ctx) → segments[]
//   ctx: {
//     results,            // 计算引擎输出（linkCalculator/linkCalculatorNGSO 的 results）
//     lang,               // 'zh' | 'en'
//     txLocation,         // 发信站城市
//     rxLocation,         // 收信站城市
//     orbitType,          // 'GEO' | 'NGSO'
//     satelliteGT         // 可选：linkParams.G_Ts，用于旧记录 satelliteGTResult 缺失时回填
//   }
// buildLinkSummary(results, meta) → 链路总览关键指标（供多链路专业版报告首页对比表）

const adaptiveUnits = require('./adaptiveUnits.js');

// ============ 链路瀑布表中英文翻译字典 ============
// 标题、参数标签、特殊单位的中→英映射；未命中的键原样返回（如 dB、GHz 等通用单位）
const WF_DICT = {
  // —— 段标题 ——
  '载波与调制参数': 'Carrier & Modulation',
  '几何与天线（上行 / 下行）': 'Geometry & Antenna (Up / Down)',
  '传播损耗（上行 / 下行）': 'Propagation Loss (Up / Down)',
  '卫星与转发器': 'Satellite & Transponder',
  '功率谱·增益与噪声': 'PSD · Gain & Noise',
  '功率谱与通量密度（上行 / 下行）': 'PSD & Flux Density (Up / Down)',
  '接收增益与噪声（地球站）': 'Rx Gain & Noise (Earth Station)',
  '链路预算级联（上行 / 下行 / 合计）': 'Link Budget Cascade (Up / Down / Total)',
  '性能与余量': 'Performance & Margin',
  '资源占用': 'Resource Usage',
  // —— 干扰分项与工况对照（v1.4.7）——
  '干扰分项与极化（转发器参考口径）': 'Interference Breakdown & Polarization (Transponder Reference)',
  '工况对照（晴空 / 降雨）': 'Clear-Sky vs Rain Comparison',
  '工况对照（晴空 / 降雨，上行）': 'Clear-Sky vs Rain (Uplink)',
  '工况对照（晴空 / 降雨，下行）': 'Clear-Sky vs Rain (Downlink)',
  '晴空': 'Clear Sky',
  '降雨': 'Rain',
  '雨致代价': 'Rain Cost',
  '合成 C/(N+I)': 'Combined C/(N+I)',
  'C/(N+I)': 'C/(N+I)',
  '合成 C/N₀': 'Combined C/N₀',
  '门限 C/N₀': 'Threshold C/N₀',
  '上行 ACI C/N₀': 'Uplink ACI C/N₀',
  '上行 ASI C/N₀': 'Uplink ASI C/N₀',
  '上行 XPI C/N₀': 'Uplink XPI C/N₀',
  '下行 ACI C/N₀': 'Downlink ACI C/N₀',
  '下行 ASI C/N₀': 'Downlink ASI C/N₀',
  '下行 XPI C/N₀': 'Downlink XPI C/N₀',
  '功放互调 C/N₀': 'HPA Intermod C/N₀',
  '转发器互调 C/N₀': 'Transponder Intermod C/N₀',
  '上行雨致 XPD': 'Uplink Rain XPD',
  '下行雨致 XPD': 'Downlink Rain XPD',
  '雨致 XPD': 'Rain XPD',
  '上行雨衰（转嫁下行）': 'Uplink Rain (Charged to Downlink)',
  '上行 C/N（热噪声）': 'Uplink C/N (Thermal)',
  '下行 C/N（热噪声）': 'Downlink C/N (Thermal)',
  '链路时延(往返 RTT)': 'Link Delay (Round-trip RTT)',
  'G/T 劣化（降雨）': 'G/T Degradation (Rain)',
  '雨衰': 'Rain Attenuation',
  '可用度与资源': 'Availability & Resources',
  // —— 载波与调制 ——
  '载波带宽': 'Allocated Bandwidth',
  '功率带宽': 'Power Bandwidth',
  '频谱效率': 'Spectral Efficiency',
  '信息速率': 'Information Rate',
  '载波速率': 'Carrier Rate',
  '符号速率': 'Symbol Rate',
  '码片速率': 'Chip Rate',
  '调制方式': 'Modulation',
  '调制因子': 'Modulation Factor',
  'FEC 码率': 'FEC Code Rate',
  '误码率': 'BER',
  '门限 Eb/N₀': 'Threshold Eb/N₀',
  '门限 Es/N₀': 'Threshold Es/N₀',
  '载波噪声带宽': 'Carrier Noise Bandwidth',
  '系统余量': 'System Margin',
  // —— 几何与天线 ——
  '城市': 'City',
  '频率': 'Frequency',
  '极化方式': 'Polarization',
  '极化角': 'Polarization Angle',
  '地球站天线口径': 'Earth Station Antenna Diameter',
  '地球站经度': 'Earth Station Longitude',
  '地球站纬度': 'Earth Station Latitude',
  '对卫星仰角': 'Elevation to Satellite',
  '对卫星方位角': 'Azimuth to Satellite',
  '天线效率': 'Antenna Efficiency',
  '波长': 'Wavelength',
  '3dB 波束宽度': '3dB Beamwidth',
  '天线增益': 'Antenna Gain',
  '星地距离': 'Slant Range',
  // —— 传播损耗 ——
  '自由空间损耗': 'Free Space Loss',
  '等效仰角 P.618§8': 'Equivalent Elevation P.618 §8',
  '大气衰减 P.676': 'Atmospheric Attenuation P.676',
  '雨衰 P.618': 'Rain Attenuation P.618',
  '上行雨衰': 'Uplink Rain Attenuation',   // 主导降雨场景下计入下行列的那笔残余上行雨衰
  '云衰 P.840': 'Cloud Attenuation P.840',
  '其他损耗': 'Other Losses',
  '总衰减': 'Total Attenuation',
  '雨层高度 P.839': 'Rain Height P.839',
  // —— 卫星与转发器 ——
  '卫星轨道位置': 'Satellite Orbital Position',
  '轨道高度': 'Orbital Altitude',
  '轨道速度': 'Orbital Velocity',
  '轨道速度(惯性系)': 'Orbital Velocity (Inertial)',
  '相对地面运动速度': 'Ground-relative Velocity',
  '链路时延(单程)': 'Link Delay (One-way)',
  '链路时延(单程·分段)': 'Link Delay (One-way, per-leg)',
  '链路时延(单程·端到端)': 'Link Delay (One-way, end-to-end)',
  '上行最大多普勒': 'Max Uplink Doppler',
  '下行最大多普勒': 'Max Downlink Doppler',
  '卫星饱和 EIRP': 'Satellite Saturated EIRP',
  '卫星天线增益': 'Satellite Antenna Gain',
  '卫星天线单位面积增益': 'Satellite Antenna Gain per Unit Area',
  '卫星 SFD': 'Satellite SFD',
  'IBO': 'IBO',
  '转发器带宽': 'Transponder Bandwidth',
  '卫星功率谱密度': 'Satellite PSD',
  // —— 功率谱·增益与噪声 ——
  '功放建议功率(W)': 'Recommended PA Power (W)',
  '地球站功率谱密度': 'Earth Station PSD',
  '发射端功率谱密度': 'Tx-side PSD',
  '到达端通量密度': 'PFD at Rx Side',
  '到达通量密度（晴天）': 'PFD, Clear Sky',
  '到达卫星通量密度': 'PFD at Satellite',
  '到达卫星通量密度（晴天）': 'PFD at Satellite (Clear Sky)',
  '卫星到地面 PFD': 'Satellite-to-Ground PFD',
  'ITU PFD 限值': 'ITU PFD Limit',
  '接收馈线损耗': 'Rx Feeder Loss',
  'G/T 劣化': 'G/T Degradation',
  '天线噪声温度': 'Antenna Noise Temperature',
  '接收机噪声温度': 'Receiver Noise Temperature',
  '雨噪声温度': 'Rain Noise Temperature',
  '云噪声温度': 'Cloud Noise Temperature',
  '系统噪声温度': 'System Noise Temperature',
  '系统噪声温度(dB)': 'System Noise Temperature (dB)',
  // —— 链路预算级联 ——
  '功放建议功率': 'Recommended PA Power',
  '功放回退': 'PA Backoff',
  '馈线损耗': 'Feeder Loss',
  '发射天线增益': 'Tx Antenna Gain',
  '地球站 EIRP': 'Earth Station EIRP',
  '到达卫星载波电平 C': 'Carrier Level at Satellite C',
  '卫星 G/T': 'Satellite G/T',
  '上行 C/T': 'Uplink C/T',
  '−玻尔兹曼常数 k': '−Boltzmann Constant k',
  '上行 C/N₀': 'Uplink C/N₀',
  '载波噪声带宽 10·lgB': 'Noise Bandwidth 10·lgB',
  '上行 C/N（热噪声）': 'Uplink C/N (Thermal)',
  '上行干扰损失 ACI/ASI/XPI/IM': 'Uplink Interference Loss ACI/ASI/XPI/IM',
  '上行 C/N': 'Uplink C/N',
  '上行 C/(N+I)': 'Uplink C/(N+I)',
  '上行 C/I': 'Uplink C/I',
  'OBO': 'OBO',
  '转发器工作区回退': 'Transponder Operating Backoff',
  '转发器输出 EIRP': 'Transponder Output EIRP',
  '每载波占卫星 EIRP': 'EIRP per Carrier',
  '到达地面载波电平 C': 'Carrier Level at Ground C',
  '接收天线增益': 'Rx Antenna Gain',
  '地球站 G/T': 'Earth Station G/T',
  'G/T 劣化（降雨）': 'G/T Degradation (Rain)',
  '下行 C/T': 'Downlink C/T',
  '下行 C/N₀': 'Downlink C/N₀',
  '下行 C/N（热噪声）': 'Downlink C/N (Thermal)',
  '下行干扰损失 ACI/ASI/XPI/IM': 'Downlink Interference Loss ACI/ASI/XPI/IM',
  '下行 C/N': 'Downlink C/N',
  '下行 C/(N+I)': 'Downlink C/(N+I)',
  '下行 C/I': 'Downlink C/I',
  'C/(N+I)（合成）': 'C/(N+I) (Combined)',
  '门限 C/N': 'Threshold C/N',
  '链路余量': 'Link Margin',
  // —— 可用度与资源 ——
  '系统可用度': 'System Availability',
  '上行可用度': 'Uplink Availability',
  '下行可用度': 'Downlink Availability',
  '年中断(分钟)': 'Annual Outage (min)',
  '年中断(小时)': 'Annual Outage (h)',
  '最大载波数': 'Max Carrier Count',
  '带宽占用比': 'Bandwidth Usage Ratio',
  '功率占用比': 'Power Usage Ratio',
  '上行功率占比': 'Uplink Power Ratio',
  '下行功率占比': 'Downlink Power Ratio',
  '功放实际输出': 'Actual PA Output',
  '功放实际输出(W)': 'Actual PA Output (W)',
  '功放建议值': 'Recommended PA Value',
  '功放建议值(W)': 'Recommended PA Value (W)',
  'UPC 上行功控余量': 'UPC Uplink Power Control Margin',
  // —— NGSO 专属 ——
  '卫星参数': 'Satellite Parameters',
  '卫星参数（上行 / 下行）': 'Satellite Parameters (Up / Down)',
  '最大多普勒': 'Max Doppler Shift',
  '星间链路 ISL（性能评估）': 'Inter-Satellite Link ISL (Performance)',
  'ISL 跳数': 'ISL Hops',
  'ISL 单跳 C/T': 'ISL C/T per Hop',
  'ISL 单跳 C/N': 'ISL C/N per Hop',
  'ISL 等效 C/T（并联）': 'ISL Equivalent C/T (Combined)',
  'ISL 等效 C/N（并联）': 'ISL Equivalent C/N (Combined)',
  'ISL 等效 C/N（计入总C/T）': 'ISL Equivalent C/N (into Total C/T)',
  'ISL 对上行 C/N 代价': 'ISL Cost to Uplink C/N',
  '上行 C/(N+I)（含 ISL）': 'Uplink C/(N+I) (incl. ISL)',
  '跳': 'hops',
  // —— ISL 分链路展示（按 islMode）——
  '星间链路 ISL（经验值）': 'Inter-Satellite Link ISL (Empirical)',
  '星间链路 ISL（微波链路）': 'Inter-Satellite Link ISL (Microwave)',
  '星间链路 ISL（激光链路）': 'Inter-Satellite Link ISL (Laser)',
  'ISL 频率': 'ISL Frequency',
  '单跳距离': 'Per-Hop Distance',
  'ISL EIRP': 'ISL EIRP',
  'ISL 自由空间损耗': 'ISL Free Space Loss',
  'ISL G/T': 'ISL G/T',
  '发射口径': 'Tx Aperture',
  '接收口径': 'Rx Aperture',
  '发射光功率': 'Tx Optical Power',
  '发射望远镜增益': 'Tx Telescope Gain',
  '光学自由空间损耗': 'Optical Free Space Loss',
  '指向+光学损耗': 'Pointing + Optical Loss',
  '接收望远镜增益': 'Rx Telescope Gain',
  '接收光功率': 'Rx Optical Power',
  '接收灵敏度': 'Rx Sensitivity',
  '灵敏度参考速率': 'Sensitivity Ref. Rate',
  '灵敏度 Eb/N₀': 'Sensitivity Eb/N₀',
  '等效噪声谱密度 N₀': 'Equiv. Noise PSD N₀',
  '单跳 C/N₀': 'C/N₀ per Hop',
  '输入 SNR': 'Input SNR',
  '参考带宽': 'Reference Bandwidth',
  // —— 可见性几何 / NGSO 干扰适配 ——
  '可见性几何': 'Visibility Geometry',
  '轨道周期': 'Orbital Period',
  '覆盖地心半角': 'Earth-Central Coverage Half-Angle',
  '地面覆盖半径': 'Ground Coverage Radius',
  '最大过境时长(天顶)': 'Max Pass Duration (Zenith)',
  '功率谱·PFD·增益与噪声': 'PSD · PFD · Gain & Noise',
  'ITU PFD 限值(Art.21)': 'ITU PFD Limit (Art.21)',
  // —— 再生式上行专属段标题 ——
  '几何与天线（上行）': 'Geometry & Antenna (Uplink)',
  '传播损耗（上行）': 'Propagation Loss (Uplink)',
  '卫星（上行接收）': 'Satellite (Uplink Rx)',
  '功率谱·增益与噪声（上行）': 'PSD · Gain & Noise (Uplink)',
  '功率谱与噪声（上行）': 'PSD & Noise (Uplink)',
  '链路预算级联（再生式上行）': 'Link Budget Cascade (Regenerative Uplink)',
  '可用度与资源（上行）': 'Availability & Resources (Uplink)',
  '性能与余量（上行）': 'Performance & Margin (Uplink)',
  '资源占用（上行）': 'Resource Usage (Uplink)',
  '上行 C/(N+I)（再生·合计）': 'Uplink C/(N+I) (Regenerative Total)',
  // —— 再生式下行专属 ——
  '卫星（下行发射）': 'Satellite (Downlink Tx)',
  '卫星下行 EIRP': 'Satellite Downlink EIRP',
  '链路预算级联（再生式下行）': 'Link Budget Cascade (Regenerative Downlink)',
  '几何与天线（下行）': 'Geometry & Antenna (Downlink)',
  '传播损耗（下行）': 'Propagation Loss (Downlink)',
  '增益与噪声（下行）': 'Gain & Noise (Downlink)',
  '功率谱与通量密度（下行）': 'PSD & Flux Density (Downlink)',
  '接收增益与噪声（收信站）': 'Rx Gain & Noise (Rx Station)',
  '可用度与资源（下行）': 'Availability & Resources (Downlink)',
  '性能与余量（下行）': 'Performance & Margin (Downlink)',
  '资源占用（下行）': 'Resource Usage (Downlink)',
  '收信站天线口径': 'Rx Antenna Diameter',
  '收信站经度': 'Rx Longitude',
  '收信站纬度': 'Rx Latitude',
  '收信站 G/T': 'Rx Station G/T',
  '雨致 G/T 劣化': 'Rain-induced G/T Degradation',
  '天线噪温': 'Antenna Noise Temp',
  '接收机噪温': 'Receiver Noise Temp',
  '下行 C/(N+I)（再生·合计）': 'Downlink C/(N+I) (Regenerative Total)',
  // —— 再生式星间（微波 ISL）——
  '星间几何（最差工况）': 'Inter-Satellite Geometry (Worst Case)',
  // 手动几何：星间距离由用户逐条给定，没有轨道解算 → 段名/行名不说「最差工况」
  '星间距离（手动给定）': 'ISL Range (Manual Input)',
  '星间链路距离': 'ISL Range',
  '星间频率': 'ISL Frequency',
  '星间距离(最差)': 'ISL Distance (Worst Case)',
  '发射卫星高度': 'Tx Satellite Altitude',
  '接收卫星高度': 'Rx Satellite Altitude',
  '地心夹角': 'Earth-Central Angle',
  'LOS 掠地高度': 'LOS Grazing Altitude',
  '单程时延': 'One-way Delay',
  '最大距离变化率': 'Max Range Rate',
  '互视可见度': 'Mutual Visibility',
  '链路预算级联（再生式星间）': 'Link Budget Cascade (Regenerative ISL)',
  '发射卫星 EIRP': 'Tx Satellite EIRP',
  '接收卫星 G/T': 'Rx Satellite G/T',
  '综合损耗': 'Miscellaneous Loss',
  '星间 C/T': 'ISL C/T',
  '星间 C/N₀': 'ISL C/N₀',
  '星间 C/N': 'ISL C/N',
  '星间 C/N（热噪声）': 'ISL C/N (Thermal)',
  '星间 C/(N+I)': 'ISL C/(N+I)',
  '星间C/I': 'ISL C/I',
  '可用度与资源（星间）': 'Availability & Resources (ISL)',
  '性能与余量（星间）': 'Performance & Margin (ISL)',
  '资源占用（星间）': 'Resource Usage (ISL)',
  '性能与余量（激光星间）': 'Performance & Margin (Laser ISL)',
  // —— 再生式星间（激光 ISL，MathWorks 简化功率链）——
  '激光终端参数': 'Laser Terminal Parameters',
  '波长 λ': 'Wavelength λ',
  '发射光功率 P_tx': 'Tx Optical Power P_tx',
  '发射口径 D_tx': 'Tx Aperture D_tx',
  '接收口径 D_rx': 'Rx Aperture D_rx',
  '发射指向误差': 'Tx Pointing Error',
  '接收指向误差': 'Rx Pointing Error',
  '接收机灵敏度 P_req': 'Receiver Sensitivity P_req',
  '相干多普勒 Δf': 'Coherent Doppler Δf',
  '激光链路预算级联（MathWorks 简化）': 'Laser Link Budget Cascade (MathWorks Simplified)',
  '发射光学效率损耗 OE_tx': 'Tx Optical Efficiency Loss OE_tx',
  '接收光学效率损耗 OE_rx': 'Rx Optical Efficiency Loss OE_rx',
  '发射望远镜增益 G_tx': 'Tx Telescope Gain G_tx',
  '接收望远镜增益 G_rx': 'Rx Telescope Gain G_rx',
  '发射指向损耗 LP_tx': 'Tx Pointing Loss LP_tx',
  '接收指向损耗 LP_rx': 'Rx Pointing Loss LP_rx',
  '自由空间损耗 L_PS': 'Free Space Loss L_PS',
  '其他损耗 L': 'Other Losses L',
  '接收光功率 P_rx': 'Rx Optical Power P_rx',
  '所需接收功率 P_req': 'Required Rx Power P_req',
  '可用度（激光星间）': 'Availability (Laser ISL)',
  // —— 端到端链路（多跳 / 混合转发）——
  '端到端链路级联（正向电平递推）': 'End-to-End Cascade (Forward Power Ledger)',
  '逐跳几何与时延': 'Per-Hop Geometry & Delay',
  '收发链参数': 'Tx/Rx Chain Parameters',
  '其他传播衰减': 'Other Propagation Losses',
  '−k − 10·lgB': '−k − 10·lgB',
  '逐段汇总': 'Per-Segment Summary',
  '端到端汇总': 'End-to-End Summary',
  '段': 'Segment',
  '段余量': 'Segment Margin',
  '段 C/(N+I)': 'Segment C/(N+I)',
  '星地上行': 'Uplink',
  '星地下行': 'Downlink',
  '星间微波': 'ISL (RF)',
  '星间激光': 'ISL (Optical)',
  '透明转发': 'Bent Pipe',
  '发信站': 'Tx Station',
  '收信站': 'Rx Station',
  '发信站 EIRP': 'Tx Station EIRP',
  '再生卫星 EIRP': 'Regenerative Satellite EIRP',
  '发射卫星 EIRP': 'Transmit Satellite EIRP',
  '功放输出功率': 'PA Output Power',
  '功放输出功率(W)': 'PA Output Power (W)',
  'UPC 补偿': 'UPC Compensation',
  '天线口径': 'Antenna Diameter',
  '转发器功率占比': 'Transponder Power Utilization',
  '转发器带宽占比': 'Transponder Bandwidth Utilization',
  '透明转发器占用': 'Bent-Pipe Transponder Utilization',
  '逐段解调结算': 'Per-Segment Demodulation',
  '解调': 'Demodulation',
  '解调实现损失': 'Demodulator Implementation Loss',
  '实际解调门限': 'Effective Demodulation Threshold',
  '实际所需接收功率': 'Effective Required Rx Power',
  '设计 BER': 'Design BER',
  '端到端 BER': 'End-to-End BER',
  '每载波输出 EIRP': 'Output EIRP per Carrier',
  '可容纳同类载波数': 'Max Carriers of This Type',
  '到达载波电平 C': 'Received Carrier Level C',
  '卫星 SFD（标称）': 'Satellite SFD (Nominal)',
  'G/T 差（卫星 − 参考）': 'G/T Offset (Satellite − Reference)',
  '饱和通量密度 SFD': 'Saturation Flux Density SFD',
  '输入回退 IBO': 'Input Backoff IBO',
  '转发器工作点通量密度': 'Transponder Operating-Point Flux Density',
  '到达通量密度': 'Received Flux Density',
  '载波占转发器回退': 'Carrier Transponder Backoff',
  '转发器输出 EIRP（每载波）': 'Transponder Output EIRP (per Carrier)',
  '接收站 G/T': 'Rx Station G/T',
  '星间发射 EIRP': 'ISL Tx EIRP',
  '星间接收 G/T': 'ISL Rx G/T',
  '附加损耗': 'Additional Losses',
  '本跳 C/N': 'Hop C/N',
  '本跳 C/N（热噪声）': 'Hop C/N (Thermal)',
  '本跳 C/(N+I)': 'Hop C/(N+I)',
  '本跳等效 C/N': 'Hop Equivalent C/N',
  '干扰损失 ACI/ASI/XPI/IM': 'Interference Loss ACI/ASI/XPI/IM',
  '干扰损失 转发器IM': 'Interference Loss Transponder IM',
  '干扰损失 星间C/I': 'Interference Loss ISL C/I',
  '段干扰损失（直接合并）': 'Segment Interference Loss (Direct Merge)',
  '多跳级联损失（前序跳并联）': 'Multi-Hop Cascade Loss (Prior Hops Combined)',
  '星地距离': 'Slant Range',
  '星间距离': 'ISL Range',
  '节点数': 'Nodes',
  '跳数': 'Hops',
  '段数': 'Segments',
  '最弱段': 'Weakest Segment',
  '端到端余量': 'End-to-End Margin',
  '端到端时延': 'End-to-End Delay',
  '传播时延合计': 'Total Propagation Delay',
  '处理时延合计': 'Total Processing Delay',
  // —— 特殊单位 ——
  '米': 'm'
};

// ============ 构建器（每次调用创建一个独立上下文） ============
function createBuilder(ctx) {
  const lang = ctx.lang === 'en' ? 'en' : 'zh';
  const txLocation = ctx.txLocation || '';
  const rxLocation = ctx.rxLocation || '';

  // 卫星 G/T 回填：部分（尤其是较早保存的）记录 calculationResults 中可能缺少
  // satelliteGTResult，此处用链路参数中的卫星 G/T 输入值（linkParams.G_Ts）补齐，
  // 与计算引擎 results.satelliteGTResult = G_Ts 的取值一致。
  const results = Object.assign({}, ctx.results || {});
  if (results.satelliteGTResult === undefined || results.satelliteGTResult === null || results.satelliteGTResult === '') {
    const gt = parseFloat(ctx.satelliteGT);
    if (!isNaN(gt)) results.satelliteGTResult = gt.toFixed(2);
  }

  const b = {};

  // 按语言翻译标签/标题/特殊单位；中文或未命中则原样返回
  b._t = function (s) {
    if (lang !== 'en') return s;
    return (s && WF_DICT[s] !== undefined) ? WF_DICT[s] : s;
  };

  // 解析结果字符串为数值，非数值返回 null（宽松：parseFloat 语义，取前缀数字）。
  // 级联累加走这条——那些值都是引擎出的纯数字串，宽松与严格同解。
  b._num = function (v) {
    if (v === undefined || v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  // 严格数值：整串是一个合法数字才认，否则 null。行上的机读 num 一律走这条——
  // parseFloat 会把误码率 '1×10⁻⁷' 截成 1、FEC 码率 '3/4' 截成 3，
  // 这种值进了 Excel 数值单元格就是错数，宁可退回文本。
  // ※ num 一律从「最终显示串」解析，不从 results 原值解析：级联的 gain/loss 行显示走 _fmt
  // （两位小数）、检查点行显示是 running 回填值，若 num 另取全精度原值，就会出现屏幕 12.99、
  // Excel 12.994999 的两套数——屏幕上核对的和交出去的报表必须是同一份东西。
  b._numStrict = function (v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (s === '' || s === '—' || s === '-') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  // 格式化（最多保留 2 位小数）
  b._fmt = function (n) {
    if (n === null) return '—';
    return '' + (Math.round(n * 100) / 100);
  };

  // 透传引擎已格式化字符串（无值显示破折号；避免科学计数法被四舍五入）
  b._disp = function (raw) {
    return (raw === undefined || raw === null || raw === '' || raw === '-') ? '—' : ('' + raw);
  };

  // ============ 稳定标识与原始数值（报表铺路层，v1.4.6） ============
  // 屏幕、Excel、PDF 三处消费同一份 segments[]，但 title/label/unit 都会随 lang 翻译，
  // 报表端若按中文字符串认段/认行，切到 English 就全认不出。故每段/每行额外带一组
  // 与语言无关的标识与数值，翻译层只影响给人看的那几个字段：
  //   段  id      稳定英文 slug（'carrier'/'geometry'/…），报表端据此排章节、挑内容
  //       titleZh 中文原题（未翻译），id 缺失时的兜底键
  //       no      章节号，由 _number 按最终段序统一编（增删段不必手改号）
  //       cls     语义类 'param'（输入回显）/ 'result'（算出来的），报表分区用
  //   行  id      结果字段名（'uplinkFSLResult' 一类，天然稳定）；字面量行为 '#'+中文标签
  //       num     原始数值（非数值为 null）—— Excel 写数值单元格用它，
  //               不必再去反解 up/down/total 里那串已格式化、可能带单位的显示字符串
  //       unitKey 未翻译的单位原文，数值格式/单位换算按它判定
  const slugOf = (label) => '#' + label;
  // 显示列 → 该列的机读数值字段。级联行只有 _col 那一列有值，另两列是空格子，
  // 对应的 num 必须留 null，不能把值挂到固定的 num 上（否则 down 列的数字挂在 up 列的字段上）。
  const NUM_FIELD = { up: 'num', down: 'numDown', total: 'numTotal' };

  // 构建单值行（单列段）。kind: base|gain|loss|sub|ref|kpi|margin
  // src 为结果字段名（默认从 results 取）；若 isLiteral 为 true 则 src 直接作为原始值
  b._wfRow = function (kind, label, src, unit, isLiteral) {
    const raw = isLiteral ? src : results[src];
    const isCalc = (kind === 'base' || kind === 'gain' || kind === 'loss' || kind === 'sub');
    const value = isCalc ? b._fmt(b._num(raw)) : b._disp(raw);
    const signMap = { base: '', gain: '+', loss: '−', sub: '=', ref: '', kpi: '', margin: '=' };
    return {
      key: label, id: isLiteral ? slugOf(label) : src, kind, sign: signMap[kind], label: b._t(label),
      up: value, down: '', total: '', unit: b._t(unit) || '', unitKey: unit || '', cum: '',
      num: b._numStrict(value), _raw: raw
    };
  };

  // 双列行（上行 / 下行）。key 为 '_none' 表示该侧不适用（留空，不画横杠）。
  // isLiteral 为真时 upKey/downKey 直接是值本身（供 RTT 这类当场算出、引擎无对应字段的量）。
  b._dualRow = function (label, upKey, downKey, unit, kind, isLiteral) {
    const cell = (k) => (k === '_none' || k === null || k === undefined) ? '' : b._disp(isLiteral ? k : results[k]);
    const nm = (k) => b._numStrict(cell(k));
    const idOf = () => {
      if (isLiteral) return slugOf(label);
      if (upKey && upKey !== '_none') return upKey;
      return (downKey && downKey !== '_none') ? downKey : slugOf(label);
    };
    return {
      key: label, id: idOf(),
      kind: kind || 'ref', sign: '', label: b._t(label),
      up: cell(upKey), down: cell(downKey), total: '', unit: b._t(unit) || '', unitKey: unit || '', cum: '',
      num: nm(upKey), numDown: nm(downKey)
    };
  };

  // 段封装：把标题翻译、列数、稳定标识收在一处，六个 builder 的段一律经此出厂
  b._seg = function (title, cols, rows, meta) {
    const m = meta || {};
    const seg = { id: m.id || '', title: b._t(title), titleZh: title, cols, rows };
    if (m.cls) seg.cls = m.cls;
    if (m.role) seg.role = m.role;
    return seg;
  };

  // 章节编号：按最终段序统一编（1 起），增删段不必手改号。
  // 号只挂在 seg.no 上、不并进 title——渲染端与报表端各自决定画成「§3」还是「3.」。
  // 先剔掉一行不剩的空段：各段的行会按有无值自动过滤（_refSeg / _dualSeg），
  // 体制之间出参不同（如再生式没有干扰分项那几个字段），整段落空时只剩一个孤零零的题注。
  b._number = function (segs) {
    const kept = (segs || []).filter((seg) => seg && Array.isArray(seg.rows) && seg.rows.length);
    kept.forEach((seg, i) => { seg.no = i + 1; });
    return kept;
  };

  // 纯参考段（单列）：list 为 [label, key, unit] 数组，自动剔除无值行。
  // 第 4 项为真时 key 直接当字面量原始值用（供 RTT 这类由现有出参当场算出、引擎无对应字段的量）。
  b._refSeg = function (title, list, meta) {
    const rows = list
      .map((t) => b._wfRow('ref', t[0], t[1], t[2], t[3]))
      .filter((row) => row.up !== '—');
    return b._seg(title, 1, rows, meta);
  };

  // 级联单值行（三列布局）：value 路由到指定列 col（'up'|'down'|'total'）。
  // key 为 null 表示该格为计算检查点，值由 _cascadeTriSeg 沿链路累加后回填；
  // key 为数值时作为字面量原始值（用于 +228.6、噪声带宽、干扰损失等链路桥接项）。
  b._cRow = function (kind, label, key, unit, col) {
    const calc = (kind === 'base' || kind === 'gain' || kind === 'loss' || kind === 'sub' || kind === 'chk');
    const isLit = typeof key === 'number';
    const raw = key === null ? null : (isLit ? key : results[key]);
    const val = key === null ? '' : (calc ? b._fmt(b._num(raw)) : b._disp(raw));
    const signMap = { base: '', gain: '+', loss: '−', sub: '=', chk: '=', ref: '', kpi: '', margin: '=' };
    // id：字段名行取字段名；字面量行（+228.6、噪声带宽等）与检查点行（key===null，值靠 running
    // 回填）都没有字段名可依，取 '#列·中文标签'——同一标签在上/下行各出现一次（自由空间损耗等），
    // 带上列名才唯一。
    const row = {
      key: col + '·' + label, id: (key !== null && !isLit) ? key : slugOf(col + '·' + label),
      kind, sign: signMap[kind], label: b._t(label),
      up: '', down: '', total: '', unit: b._t(unit) || '', unitKey: unit || '', cum: '',
      num: null, numDown: null, numTotal: null, _raw: raw, _col: col
    };
    row[col] = val;
    row[NUM_FIELD[col] || 'num'] = b._numStrict(val);
    return row;
  };

  // 级联三列行：上行 / 下行 / 合计 同行展示（缺列传 null → 留空）
  b._cTri = function (kind, label, upKey, downKey, totalKey, unit) {
    const d = (k) => (k === null || k === undefined) ? '' : b._disp(results[k]);
    const nm = (k) => b._numStrict(d(k));
    const signMap = { base: '', gain: '+', loss: '−', sub: '=', chk: '=', ref: '', kpi: '', margin: '=' };
    return {
      key: label, id: totalKey || upKey || downKey || slugOf(label),
      kind, sign: signMap[kind], label: b._t(label),
      up: d(upKey), down: d(downKey), total: d(totalKey), unit: b._t(unit) || '', unitKey: unit || '', cum: '',
      num: nm(upKey), numDown: nm(downKey), numTotal: nm(totalKey), _raw: null, _col: null
    };
  };

  // 级联段（三列：上行 / 下行 / 合计）：沿功率链单一 running 累加，
  // 回填无引擎字段的计算检查点（到达卫星 / 转发器输出 / 到达地面电平），再剔除空 ref/kpi 行。
  // 出参带 role:'cascade' —— 段的语义标记（不影响 title/cols/rows 口径，报表导出忽略之）：
  // 前端「详细预算」据此把级联主段单独提到文档顶部与图表区并排，其余段铺底（WaterfallTable 的 pick）。
  b._cascadeTriSeg = function (title, rows, meta) {
    let running = null;
    rows.forEach((row) => {
      const k = row.kind;
      if (k !== 'base' && k !== 'gain' && k !== 'loss' && k !== 'sub' && k !== 'chk') return;
      const n = b._num(row._raw);
      if (k === 'base') {
        running = n;
      } else if (k === 'gain') {
        if (running !== null && n !== null) running += n;
      } else if (k === 'loss') {
        if (running !== null && n !== null) running -= n;
      } else if (k === 'sub' || k === 'chk') {
        if (n !== null) running = n; // 引擎权威检查点
        else if (running !== null && row._col) {   // 计算检查点回填（num 取回填后的显示值，两边同一个数）
          row[row._col] = b._fmt(running);
          row[NUM_FIELD[row._col] || 'num'] = b._numStrict(row[row._col]);
        }
      }
    });
    const hasVal = (v) => v !== '' && v !== '—';
    const kept = rows.filter((row) =>
      (row.kind !== 'ref' && row.kind !== 'kpi') || hasVal(row.up) || hasVal(row.down) || hasVal(row.total));
    return b._seg(title, 3, kept, Object.assign({ id: 'cascade', cls: 'result' }, meta, { role: 'cascade' }));
  };

  // 单列级联段（再生式上行：仅上行链，无下行/合计）：沿功率链单一 running 累加，
  // 回填无引擎字段的计算检查点（到达卫星电平 / C/T / C/N₀ / C/N），再剔除空 ref/kpi 行。
  // 复用 _cRow(kind,label,key,unit,'up') 生成的行（值写在 up 列，cols:1 时 WaterfallTable 只读 up）。
  b._cascadeSingleSeg = function (title, rows, meta) {
    let running = null;
    rows.forEach((row) => {
      const k = row.kind;
      if (k !== 'base' && k !== 'gain' && k !== 'loss' && k !== 'sub' && k !== 'chk') return;
      const n = b._num(row._raw);
      if (k === 'base') running = n;
      else if (k === 'gain') { if (running !== null && n !== null) running += n; }
      else if (k === 'loss') { if (running !== null && n !== null) running -= n; }
      else { // sub | chk
        if (n !== null) running = n;                                             // 引擎权威检查点
        else if (running !== null) { row.up = b._fmt(running); row.num = b._numStrict(row.up); } // 计算检查点回填（num 取回填后的显示值，两边同一个数）
      }
    });
    const hasVal = (v) => v !== '' && v !== '—';
    const kept = rows.filter((row) => (row.kind !== 'ref' && row.kind !== 'kpi') || hasVal(row.up));
    return b._seg(title, 1, kept, Object.assign({ id: 'cascade', cls: 'result' }, meta, { role: 'cascade' }));   // role 同 _cascadeTriSeg
  };

  // ============ 晴空 / 降雨双工况对照（v1.4.7） ============
  // 引擎是单工况计算：按目标可用度对应的雨衰算一遍，出参里只有「降雨工况」这一档，
  // 晴空档从来没算过（totalCN0Result / totalCN0RainResult 不是这个——那两个是转发器容量账，
  // 差的是「残余上行雨衰」，且为转发器参考口径，与本载波工作点不同源）。
  // 这里在 builder 层按 dB 反推补出晴空档，不动引擎：
  //   上行 C/(N+I) 晴空 = 降雨档 + 上行雨衰      （雨只衰减信号；卫星接收噪温不受地面降雨影响）
  //   下行 C/(N+I) 晴空 = 降雨档 + 下行雨衰 + G/T 劣化 + 转嫁到下行的上行残余雨衰
  //                                            （信号衰减 + 雨噪温抬高 T_sys，后者已折算进 G/T 劣化）
  //   合成 = 两者噪声并联（非线性，故本段不做成逐行加减的级联，只做三列对照）
  // 干扰项按晴空/降雨不变处理（干扰源经历同量级衰落，工程惯例）。
  b._parallelCN = function (upCN, dnCN) {
    if (upCN === null || dnCN === null || !isFinite(upCN) || !isFinite(dnCN)) return null;
    return -10 * Math.log10(Math.pow(10, -upCN / 10) + Math.pow(10, -dnCN / 10));
  };

  // 双列对照行：晴空 / 降雨（缺项传 null → 留空）。
  // 不做第三列「雨致代价」：参考段带的栏宽按单/双列段定（28em），三列段要 34.6em 装不下，
  // 会把列挤乱并让整带横向溢出；两列之差读者一眼可减，各项代价另有明细行逐条列出。
  b._cmpRow = function (label, clear, rain, unit) {
    const f = (v) => (v === null || v === undefined || !isFinite(v)) ? '' : b._fmt(v);
    const up = f(clear), down = f(rain);
    return {
      key: label, id: slugOf(label), kind: 'ref', sign: '', label: b._t(label),
      up, down, total: '', unit: b._t(unit) || '', unitKey: unit || '', cum: '',
      num: b._numStrict(up), numDown: b._numStrict(down)
    };
  };

  // 代价明细行（雨衰 / G/T 劣化各自吃掉多少 dB）：值落在「降雨」列——它们本就是降雨工况下的损失
  b._costRow = function (label, cost, unit) {
    const down = (cost === null || cost === undefined || !isFinite(cost)) ? '' : b._fmt(cost);
    return {
      key: label, id: slugOf(label), kind: 'ref', sign: '', label: b._t(label),
      up: '', down, total: '', unit: b._t(unit) || '', unitKey: unit || '', cum: '',
      num: null, numDown: b._numStrict(down)
    };
  };

  // 工况对照段（三列：晴空 / 降雨 / 雨致代价）。upRain/dnRain/dnGtDeg 为该链路实际计入的雨致损失，
  // 由各构建器按自己的主导降雨口径传入（GEO 弯管有「上行主导时下行按晴空」的分支）。
  // dnResidRain＝经弯管转嫁到下行账的上行残余雨衰（UPC 未补偿部分），晴空档同样归零，故一并加回。
  b._weatherSeg = function (title, upCNRain, dnCNRain, totalCNRain, upRain, dnRain, dnGtDeg, dnResidRain, meta) {
    const add = (base, ...deltas) => {
      if (base === null || !isFinite(base)) return null;
      let v = base;
      for (const d of deltas) if (d !== null && isFinite(d)) v += d;
      return v;
    };
    const resid = (dnResidRain !== null && dnResidRain !== undefined && isFinite(dnResidRain) && dnResidRain > 0.005)
      ? dnResidRain : null;
    const upClear = add(upCNRain, upRain);
    const dnClear = add(dnCNRain, dnRain, dnGtDeg, resid);
    // 合成档以引擎的 carrierTotalCN 为锚，只把「晴空 − 降雨」这个增量用并联式算出来叠上去。
    // 直接拿 _parallelCN(upClear, dnClear) 当绝对值会与引擎值差个舍入尾数（引擎的合成不是拿
    // 这两个已取整的量并联出来的），无雨时就会显示成「雨致代价 −0.01」这种假台阶。
    const clearCalc = b._parallelCN(upClear, dnClear);
    const rainCalc = b._parallelCN(upCNRain, dnCNRain);
    const totalClear = (totalCNRain !== null && isFinite(totalCNRain) && clearCalc !== null && rainCalc !== null)
      ? totalCNRain + (clearCalc - rainCalc)
      : clearCalc;
    const rows = [
      b._cmpRow('上行 C/(N+I)', upClear, upCNRain, 'dB'),
      b._cmpRow('下行 C/(N+I)', dnClear, dnCNRain, 'dB'),
      b._cmpRow('合成 C/(N+I)', totalClear, totalCNRain, 'dB'),
      b._costRow('上行雨衰', upRain, 'dB'),
      b._costRow('下行雨衰', dnRain, 'dB'),
      b._costRow('G/T 劣化（降雨）', dnGtDeg, 'dB'),
      b._costRow('上行雨衰（转嫁下行）', resid, 'dB')
    ].filter((row) => row.up !== '' || row.down !== '');
    const seg = b._seg(title, 2, rows, meta);
    seg.heads = ['晴空', '降雨'];   // 覆盖默认的「上行/下行」列头
    return seg;
  };

  // 单向链路（再生式）的工况对照：只有一条链，两列＝晴空 / 降雨，第三列仍是雨致代价
  b._weatherSegSingle = function (title, cnRain, rain, gtDeg, meta) {
    const clear = (cnRain === null || !isFinite(cnRain)) ? null
      : cnRain + ((rain !== null && isFinite(rain)) ? rain : 0) + ((gtDeg !== null && isFinite(gtDeg)) ? gtDeg : 0);
    const rows = [
      b._cmpRow('C/(N+I)', clear, cnRain, 'dB'),
      b._costRow('雨衰', rain, 'dB'),
      b._costRow('G/T 劣化（降雨）', gtDeg, 'dB')
    ].filter((row) => row.up !== '' || row.down !== '');
    const seg = b._seg(title, 2, rows, meta);
    seg.heads = ['晴空', '降雨'];
    return seg;
  };

  // 双列段（上行 / 下行）：list 为 [label, upKey, downKey, unit]，上下行皆空则剔除。
  // 第 5 项为真时两侧的 key 当字面量用（见 _dualRow）。
  b._dualSeg = function (title, list, meta) {
    const rows = list
      .map((t) => b._dualRow(t[0], t[1], t[2], t[3], undefined, t[4]))
      .filter((row) => !((row.up === '—' || row.up === '') && (row.down === '—' || row.down === '')));
    return b._seg(title, 2, rows, meta);
  };

  // ============ GEO 链路瀑布（弯管转发器模型） ============
  b.buildGEO = function () {
    const r = results;
    if (r.linkmargin === undefined) return [];
    const segs = [];
    // 往返时延 RTT ＝ 单程 ×2（引擎只出单程）。TCP 吞吐、话音质量按 RTT 判，故在卫星段一并给出。
    const rttMs = (b._num(r.linkDelayResult) === null) ? null : (b._num(r.linkDelayResult) * 2).toFixed(1);

    // ① 载波与调制参数（链路级，单列）——只留「定义这条载波」的参数。
    // 实际 Eb/N₀ / Es/N₀ 与系统余量是算出来的结果，已移入 ⑧「性能与余量」：
    // 参数段里混着结果，读者分不清哪些是自己填的、哪些是平台算的。
    segs.push(b._refSeg('载波与调制参数', [
      ['载波带宽', 'allocBandwidthResult', 'kHz'],
      ['功率带宽', 'PowerBWResult', 'kHz'],
      ['频谱效率', 'spectralEfficiencyResult', 'bit/s/Hz'],
      ['信息速率', 'infoRateResult', 'kbps'],
      ['载波速率', 'carrierRateResult', 'kbps'],
      ['符号速率', 'symbolRateResult', 'ksps'],
      ['码片速率', 'ChipRateResult', 'kcps'],
      ['调制方式', 'modulationResult', ''],
      ['调制因子', 'modulationFactorResult', ''],
      ['FEC 码率', 'fecResult', ''],
      ['误码率', 'berResult', ''],
      ['门限 Eb/N₀', 'ebnoResult', 'dB'],
      ['门限 Es/N₀', 'esnoResult', 'dB'],
      ['载波噪声带宽', 'RXnoiseBW', 'dB-Hz']
    ], { id: 'carrier', cls: 'param' }));

    // ② 几何与天线（上行 / 下行 双列）
    const geoSeg = b._dualSeg('几何与天线（上行 / 下行）', [
      ['频率', 'uplinkFrequencyResult', 'downlinkFrequencyResult', 'GHz'],
      ['极化方式', 'uplinkPolarizationResult', 'downlinkPolarizationResult', ''],
      ['极化角', 'uplinkPolarizationAngleResult', 'downlinkPolarizationAngleResult', '°'],
      ['地球站天线口径', 'earthAntennaDiameterResult', 'rxAntennaDiameterResult', '米'],
      ['地球站经度', 'earthLongitudeResult', 'rxLongitudeResult', '°E'],
      ['地球站纬度', 'earthLatitudeResult', 'rxLatitudeResult', '°N'],
      ['对卫星仰角', 'elevationResult', 'rxElevationResult', '°'],
      ['对卫星方位角', 'azimuthResult', 'rxAzimuthResult', '°'],
      ['天线效率', 'earthAntennaEfficiencyResult', 'rxAntennaEfficiencyResult', '%'],
      ['波长', 'wavelengthResult', 'rxWavelengthResult', 'm'],
      ['3dB 波束宽度', 'beamWidthResult', 'theta3', '°'],
      ['天线增益', 'txAntennaGainResult', 'rxAntennaGainResult', 'dBi'],
      ['星地距离', 'slantRangeResult', 'rxSlantRangeResult', 'km']
    ], { id: 'geometry', cls: 'param' });
    // 在频率行上方插入「城市」行（上行=发信站城市，下行=收信站城市）
    geoSeg.rows.unshift({
      key: '城市', id: '#城市', kind: 'ref', sign: '', label: b._t('城市'),
      up: b._disp(txLocation), down: b._disp(rxLocation),
      total: '', unit: '', unitKey: '', cum: '', num: null, numDown: null
    });
    segs.push(geoSeg);

    // ③ 传播损耗（上行 / 下行 双列）
    segs.push(b._dualSeg('传播损耗（上行 / 下行）', [
      ['自由空间损耗', 'uplinkFSLResult', 'downlinkFSLResult', 'dB'],
      ['大气衰减 P.676', 'uplinkAtmosphericAttenuationResult', 'downlinkAtmosphericAttenuationResult', 'dB'],
      ['雨衰 P.618', 'uplinkRainAttenuation', 'downlinkRainAttenuationResult', 'dB'],
      ['云衰 P.840', 'uplinkCloudAttenuation', 'downlinkCloudAttenuation', 'dB'],
      ['其他损耗', 'uplinkMiscLossResult', 'downlinkMiscLossResult', 'dB'],
      ['总衰减', 'uplinkTotalAttenuationResult', 'downlinkTotalAttenuationResult', 'dB'],
      ['雨层高度 P.839', 'uplinkRainHeightResult', 'downlinkRainHeightResult', 'km']
    ], { id: 'propagation', cls: 'param' }));

    // ④ 卫星与转发器（单列）——卫星侧的全部规格收在这一段：轨道、时延、功率、天线、转发器。
    // 卫星 G/T 从原「功率谱·增益与噪声」并入（它是卫星规格，不是地球站接收链的噪声分解）；
    // 卫星功率谱密度移入 ⑤，与地球站 PSD 上下行对位。
    segs.push(b._refSeg('卫星与转发器', [
      ['卫星轨道位置', 'orbitPositionResult', '°E'],
      ['轨道高度', 'orbitAltitudeResult', 'km'],
      ['轨道速度', 'orbitVelocityResult', 'km/s'],
      ['链路时延(单程)', 'linkDelayResult', 'ms'],
      ['链路时延(往返 RTT)', rttMs, 'ms', true],
      ['上行最大多普勒', 'maxDopplerUplinkResult', 'kHz'],
      ['下行最大多普勒', 'maxDopplerDownlinkResult', 'kHz'],
      ['卫星饱和 EIRP', 'EIRPsResult', 'dBW'],
      ['卫星天线增益', 'antennaGainResult', 'dBi'],
      ['卫星 G/T', 'satelliteGTResult', 'dB/K'],
      ['卫星 SFD', 'SFDsResult', 'dBW/m²'],
      ['IBO', 'BOiResult', 'dB'],
      ['OBO', 'BOoResult', 'dB'],
      ['转发器带宽', 'transponderBandwidthResult', 'MHz']
    ], { id: 'satellite', cls: 'param' }));

    // ⑤ 功率谱与通量密度（上行 / 下行 双列）——每行一个物理量，两列＝两个方向的发射端/到达端。
    // 上行发射端＝地球站、到达端＝卫星；下行发射端＝卫星、到达端＝地面。
    // 「到达端通量密度」两列同取实际值（含雨衰）才是同一口径；晴天口径（PFDc，ITU 协调用）
    // 只有上行有对应量，单列一行，下行留空不硬凑。
    // 邻星旁瓣/离轴各行（旁瓣发射增益·EIRP·PSD、ITU 旁瓣 PSD 建议、接收旁瓣增益）已整组移除：
    // 它们全由「邻星轨位差 deltaTheta」派生，而平台三窗从来没有这个输入框，引擎只能靠空值回退
    // 硬造一个角度——2026-08-07 起该入参与派生量在两个引擎里一并删除（见 linkCalculator.js 同日注释）。
    // 留下的这四行与邻星无关：功率谱密度、到达通量密度、RR Art.21 落地 PFD 限值（仰角驱动）。
    segs.push(b._dualSeg('功率谱与通量密度（上行 / 下行）', [
      ['发射端功率谱密度', 'stationPSDResult', 'satellitePSDResult', 'dBW/Hz'],
      ['到达端通量密度', 'arrivalPFDAtSatelliteResult', 'arrivalPFDAtGroundResult', 'dBW/m²'],
      ['到达通量密度（晴天）', 'PFDcResult', '_none', 'dBW/m²'],
      ['ITU PFD 限值', '_none', 'ituPfdLimitPerM2', 'dBW/m²']
    ], { id: 'psd', cls: 'result' }));

    // ⑥ 接收增益与噪声（地球站，单列）——G/T 的完整分解：增益侧 + 噪温侧。
    // 这一段刻意不做上行/下行双列：GEO 引擎的卫星接收侧只给一个 G/T 总值（输入量，已列在 ④），
    // 没有卫星侧的天线/接收机/雨/云噪温分解，硬拆双列就是空掉一整列。
    segs.push(b._refSeg('接收增益与噪声（地球站）', [
      ['接收天线增益', 'rxAntennaGainResult', 'dBi'],
      ['接收馈线损耗', 'rxFeederLossResult', 'dB'],
      ['G/T', 'gOverTeResult', 'dB/K'],
      ['G/T 劣化', 'gOverTdegradationResult', 'dB'],
      ['天线噪声温度', 'antennaNoiseTempResult', 'K'],
      ['接收机噪声温度', 'receiverNoiseTempResult', 'K'],
      ['雨噪声温度', 'rainNoiseTempResult', 'K'],
      ['云噪声温度', 'cloudNoiseTempResult', 'K'],
      ['系统噪声温度', 'systemNoiseTempKResult', 'K'],
      ['系统噪声温度(dB)', 'systemNoiseTempDbResult', 'dBK']
    ], { id: 'noise', cls: 'result' }));

    // ⑥ 链路预算级联（上行 / 下行 / 合计 三列）
    // 设计目标：整张表「从上往下逐行可算通」。每个 `=` 是一个累加检查点，
    // 每个 `+ / −` 是一步可手算的加减；干扰则汇总为单行「干扰损失」桥接热噪声与实际值。
    // 转换链：到达载波电平 C(dBW) ──+G/T──▶ C/T(dBW/K) ──+228.6(−玻尔兹曼常数k)──▶ C/N₀(dBHz) ──−噪声带宽──▶ C/N(热)──−干扰损失──▶ C/N(实际)
    // 合计：上行C/N ⊕ 下行C/N（噪声并联）= 合计C/N；链路余量 = 合计C/N − 门限C/N。
    const C = b._cRow;
    const T = b._cTri;
    const num = (k) => b._num(r[k]);
    const KB = 228.6; // −玻尔兹曼常数 k（dB）
    const noiseBW = num('RXnoiseBW');
    // 功放回退：功放建议功率 − 回退 = 实际输出（selectedPower）
    const paBackoffDb = num('paRecommendationdBResult') - num('selectedPowerResult');
    // 上行：沿功率链得到到达卫星热噪声 C/N，再扣除上行干扰损失 → 引擎实际上行 C/N
    const cUp = num('stationEIRPResult') - num('uplinkFSLResult') - num('uplinkAtmosphericAttenuationResult')
      - num('uplinkRainAttenuation') - num('uplinkCloudAttenuation') - num('uplinkMiscLossResult');
    const upThermalCN = cUp + num('satelliteGTResult') + KB - noiseBW;
    const upIntfLoss = upThermalCN - num('uplinkCN');
    // 主导降雨场景：上行降雨占主导时，下行按晴空（下行雨衰与 G/T 劣化不参与）
    const uplinkRainDominant = num('uplinkPowerRatioResult') > num('downlinkPowerRatioResult');
    const dnRainEff = uplinkRainDominant ? 0 : num('downlinkRainAttenuationResult');
    const dnGtDegEff = uplinkRainDominant ? 0 : num('gOverTdegradationResult');
    // 下行：沿功率链得到到达地面热噪声 C/N，扣除 G/T 劣化（降雨）与下行干扰损失 → 引擎实际下行 C/N
    const cDn = num('transponderOutputEIRP') - num('downlinkFSLResult') - num('downlinkAtmosphericAttenuationResult')
      - dnRainEff - num('downlinkCloudAttenuation') - num('downlinkMiscLossResult');
    const dnThermalCN = cDn + num('gOverTeResult') + KB - noiseBW;
    // 下行干扰损失：取引擎真实四路干扰并联值（按主导场景口径），不再从反解 downlinkCN 取残差——
    // 残差在「上行主导 + UPC 未全补偿」时会把上行残余雨衰错计入本行（ACI/ASI/XPI/IM 标签失真可达数 dB）。
    const dnIntfLoss = num('downlinkInterferenceLossResult');
    // 残差扣除真实干扰后的剩余 = 经弯管转嫁到下行侧资源账的上行残余雨衰（UPC 未补偿部分；
    // 下行主导 / UPC 全补偿时 ≈ 0）。按构造闭合，保证「下行 C/N」检查点逐行加得通。
    const dnResidualRain = (dnThermalCN - dnGtDegEff - num('downlinkCN')) - dnIntfLoss;
    segs.push(b._cascadeTriSeg('链路预算级联（上行 / 下行 / 合计）', [
      // —— 上行：地球站 → 到达卫星 → C/T → C/N₀ → C/N ——
      C('base', '功放建议功率', 'paRecommendationdBResult', 'dBW', 'up'),
      C('loss', '功放回退', paBackoffDb, 'dB', 'up'),
      C('loss', '馈线损耗', 'feederLossResult', 'dB', 'up'),
      C('gain', '发射天线增益', 'txAntennaGainResult', 'dBi', 'up'),
      C('sub', '地球站 EIRP', 'stationEIRPResult', 'dBW', 'up'),
      C('loss', '自由空间损耗', 'uplinkFSLResult', 'dB', 'up'),
      C('loss', '大气衰减 P.676', 'uplinkAtmosphericAttenuationResult', 'dB', 'up'),
      C('loss', '雨衰 P.618', 'uplinkRainAttenuation', 'dB', 'up'),
      C('loss', '云衰 P.840', 'uplinkCloudAttenuation', 'dB', 'up'),
      C('loss', '其他损耗', 'uplinkMiscLossResult', 'dB', 'up'),
      C('sub', '到达卫星载波电平 C', null, 'dBW', 'up'),
      C('ref', '到达卫星通量密度', 'arrivalPFDAtSatelliteResult', 'dBW/m²', 'up'),
      C('gain', '卫星 G/T', 'satelliteGTResult', 'dB/K', 'up'),
      C('chk', '上行 C/T', null, 'dBW/K', 'up'),
      C('gain', '−玻尔兹曼常数 k', KB, 'dB', 'up'),
      C('chk', '上行 C/N₀', null, 'dBHz', 'up'),
      C('loss', '载波噪声带宽 10·lgB', noiseBW, 'dB', 'up'),
      C('chk', '上行 C/N（热噪声）', null, 'dB', 'up'),
      C('loss', '上行干扰损失 ACI/ASI/XPI/IM', upIntfLoss, 'dB', 'up'),
      C('sub', '上行 C/(N+I)', null, 'dB', 'up'),
      // —— 下行：卫星转发器 → 到达地面 → C/T → C/N₀ → C/N ——
      C('base', '卫星饱和 EIRP', 'EIRPsResult', 'dBW', 'down'),
      C('loss', 'OBO', 'BOoResult', 'dB', 'down'),
      C('loss', '转发器工作区回退', 'actualTransponderCapacityResult', 'dB', 'down'),
      C('sub', '转发器输出 EIRP', 'transponderOutputEIRP', 'dBW', 'down'),
      C('ref', '卫星功率谱密度', 'satellitePSDResult', 'dBW/Hz', 'down'),
      C('loss', '自由空间损耗', 'downlinkFSLResult', 'dB', 'down'),
      C('loss', '大气衰减 P.676', 'downlinkAtmosphericAttenuationResult', 'dB', 'down'),
      C('loss', '雨衰 P.618', dnRainEff, 'dB', 'down'),
      C('loss', '云衰 P.840', 'downlinkCloudAttenuation', 'dB', 'down'),
      C('loss', '其他损耗', 'downlinkMiscLossResult', 'dB', 'down'),
      C('sub', '到达地面载波电平 C', null, 'dBW', 'down'),
      C('ref', '卫星到地面 PFD', 'arrivalPFDAtGroundResult', 'dBW/m²', 'down'),
      C('ref', '接收天线增益', 'rxAntennaGainResult', 'dBi', 'down'),
      C('gain', '地球站 G/T', 'gOverTeResult', 'dB/K', 'down'),
      C('loss', 'G/T 劣化（降雨）', dnGtDegEff, 'dB', 'down'),
      C('chk', '下行 C/T', null, 'dBW/K', 'down'),
      C('gain', '−玻尔兹曼常数 k', KB, 'dB', 'down'),
      C('chk', '下行 C/N₀', null, 'dBHz', 'down'),
      C('loss', '载波噪声带宽 10·lgB', noiseBW, 'dB', 'down'),
      C('chk', '下行 C/N（热噪声）', null, 'dB', 'down'),
      C('loss', '下行干扰损失 ACI/ASI/XPI/IM', dnIntfLoss, 'dB', 'down'),
      // 「确有上行雨衰」门槛：残余由十余个 toFixed(2) 出参相加，量化噪声可越过 0.005，
      // 晴空也会冒出一行 0.01~0.02 的假「上行雨衰」；上行雨衰 <0.05 dB 时本行无物理意义，不列。
      ...(isFinite(dnResidualRain) && Math.abs(dnResidualRain) >= 0.005 && num('uplinkRainAttenuation') >= 0.05
        ? [C('loss', '上行雨衰', dnResidualRain, 'dB', 'down')]
        : []),
      C('sub', '下行 C/(N+I)', null, 'dB', 'down'),
      // —— 合成与余量：上行 ⊕ 下行（噪声并联）= 合计 ——
      T('kpi', 'C/(N+I)（合成）', 'uplinkCN', 'downlinkCN', 'carrierTotalCN', 'dB'),
      T('ref', '门限 C/N', null, null, 'thresholdCN', 'dB'),
      T('margin', '链路余量', null, null, 'linkmargin', 'dB')
    ], { id: 'cascade', cls: 'result' }));

    // ⑧ 性能与余量（单列）——这条链路「成不成」的结论汇总，一律本载波工作点口径。
    // C/N 族与余量在 ⑦ 级联里也出现过：⑦ 是逐行可手算的推演过程，本段是拿去写报告首页的结论，
    // 两者刻意重复。实际 Eb/N₀ / Es/N₀ 与系统余量自 ①「载波与调制参数」移入。
    // 热噪声档（uplinkThermalCN）与等效 C/I（uplinkInterferenceCN，引擎由热噪声与实际 C/N 反推）
    // 分开列：余量不够时，是该加功率还是该治干扰，全看这两个数的相对大小。
    // C/N₀ 只列合成与门限两档——都取引擎现成的本载波字段（carrierTotalCN0 / carrierThresholdCN0）；
    // 上下行分项的 C/N₀ 引擎另有一套「转发器参考口径」的同名量（uplinkCN0Result 等，自 SFD 起算），
    // 与本段口径不同源，混列会让读者拿两套基准相减，故不放进来。
    segs.push(b._refSeg('性能与余量', [
      ['Eb/N₀', 'ebnoActualResult', 'dB'],
      ['Es/N₀', 'esnoActualResult', 'dB'],
      ['上行 C/N（热噪声）', 'uplinkThermalCN', 'dB'],
      ['上行 C/I', 'uplinkInterferenceCN', 'dB'],
      ['上行 C/(N+I)', 'uplinkCN', 'dB'],
      ['下行 C/N（热噪声）', 'downlinkThermalCN', 'dB'],
      ['下行 C/I', 'downlinkInterferenceCN', 'dB'],
      ['下行 C/(N+I)', 'downlinkCN', 'dB'],
      ['C/(N+I)（合成）', 'carrierTotalCN', 'dB'],
      ['合成 C/N₀', 'carrierTotalCN0', 'dBHz'],
      ['门限 C/N', 'thresholdCN', 'dB'],
      ['门限 C/N₀', 'carrierThresholdCN0', 'dBHz'],
      ['链路余量', 'linkmargin', 'dB'],
      ['系统余量', 'marginResult', 'dB'],
      ['系统可用度', 'systemAvailabilityResult', '%'],
      ['上行可用度', 'uplinkAvailabilityResult', '%'],
      ['下行可用度', 'downlinkAvailabilityResult', '%'],
      ['年中断(分钟)', 'interruptionMinutes', 'min'],
      ['年中断(小时)', 'interruptionHours', 'h']
    ], { id: 'performance', cls: 'result' }));

    // ⑨ 工况对照（晴空 / 降雨 / 雨致代价）——引擎只算降雨这一档，晴空档在 builder 层按 dB 反推补出
    // （口径与做法见 _weatherSeg）。这是链路预算最核心的对照之一：余量被雨吃掉多少，一眼可见。
    segs.push(b._weatherSeg('工况对照（晴空 / 降雨）',
      num('uplinkCN'), num('downlinkCN'), num('carrierTotalCN'),
      num('uplinkRainAttenuation'), dnRainEff, dnGtDegEff, dnResidualRain,
      { id: 'weather', cls: 'result' }));

    // ⑩ 干扰分项与极化（单列）——⑦ 级联把四路干扰压成「干扰损失」一行，这里摊开成明细账，
    // 看是哪一路在吃余量。※ 口径：这几个量自转发器带宽与饱和工作点起算（aciUplinkCT =
    // 10·lg(转发器带宽) + k + 因子），是转发器参考口径，与 ⑧ 的本载波 C/(N+I) 不同源，
    // 只可组内横比、不可与 ⑧ 直接相减，故口径写进段名。
    segs.push(b._refSeg('干扰分项与极化（转发器参考口径）', [
      ['上行 ACI C/N₀', 'aciUplinkCN0Result', 'dBHz'],
      ['上行 ASI C/N₀', 'adjUplinkCN0Result', 'dBHz'],
      ['上行 XPI C/N₀', 'xpolUplinkCN0Result', 'dBHz'],
      ['功放互调 C/N₀', 'hpaIntermodCN0Result', 'dBHz'],
      ['下行 ACI C/N₀', 'aciDownlinkCN0Result', 'dBHz'],
      ['下行 ASI C/N₀', 'adjDownlinkCN0Result', 'dBHz'],
      ['下行 XPI C/N₀', 'xpolDownlinkCN0Result', 'dBHz'],
      ['转发器互调 C/N₀', 'xpdrIntermodCN0Result', 'dBHz'],
      ['上行雨致 XPD', 'uplinkRainXPDResult', 'dB'],
      ['下行雨致 XPD', 'downlinkRainXPDResult', 'dB']
    ], { id: 'interference', cls: 'result' }));

    // ⑨ 资源占用（单列）——这条链路吃掉多少转发器资源、功放要开多大。
    // 原「可用度与资源」里「功放建议值(W)」与旧 ⑤ 段的「功放建议功率(W)」是同一个字段
    // （paRecommendation）出现了两次，此处合并为一处。
    segs.push(b._refSeg('资源占用', [
      ['最大载波数', 'maxCarrierCount', ''],
      ['带宽占用比', 'bandwidthUsageRatio', '%'],
      ['功率占用比', 'powerUsageRatio', '%'],
      ['功放建议值', 'paRecommendationdBResult', 'dBW'],
      ['功放建议值(W)', 'paRecommendation', 'W'],
      ['功放实际输出', 'selectedPowerResult', 'dBW'],
      ['功放实际输出(W)', 'selectedPowerWResult', 'W'],
      ['UPC 上行功控余量', 'UPCmarginResult', 'dB']
    ], { id: 'resources', cls: 'result' }));

    return b._number(segs);
  };

  // ============ NGSO 链路瀑布（透明弯管 + 星间链路 ISL 模型） ============
  // 与 GEO 构建器完全独立：卫星段改为「卫星参数」（无轨道位置）、级联引入 ISL、
  // 合成为 上行 ⊕ ISL ⊕ 下行，并新增 ISL 性能评估段。改动本函数不影响 GEO。
  b.buildNGSO = function () {
    // 往返时延 RTT ＝ 单程 ×2（引擎只出单程）；TCP 吞吐与话音质量按 RTT 判
    const rttMs = (parseFloat(results.linkDelayResult) > 0) ? (parseFloat(results.linkDelayResult) * 2).toFixed(1) : null;
    const r = results;
    if (r.linkmargin === undefined) return [];
    const segs = [];
    const hasIsl = b._num(r.islHopsResult) > 0;

    // ① 载波与调制参数（链路级，单列）
    segs.push(b._refSeg('载波与调制参数', [
      ['载波带宽', 'allocBandwidthResult', 'kHz'],
      ['功率带宽', 'PowerBWResult', 'kHz'],
      ['频谱效率', 'spectralEfficiencyResult', 'bit/s/Hz'],
      ['信息速率', 'infoRateResult', 'kbps'],
      ['载波速率', 'carrierRateResult', 'kbps'],
      ['符号速率', 'symbolRateResult', 'ksps'],
      ['码片速率', 'ChipRateResult', 'kcps'],
      ['调制方式', 'modulationResult', ''],
      ['调制因子', 'modulationFactorResult', ''],
      ['FEC 码率', 'fecResult', ''],
      ['误码率', 'berResult', ''],
      ['门限 Eb/N₀', 'ebnoResult', 'dB'],
      ['门限 Es/N₀', 'esnoResult', 'dB'],
      ['载波噪声带宽', 'RXnoiseBW', 'dB-Hz']
    ], { id: 'carrier', cls: 'param' }));   // 实际 Eb/N₀ / Es/N₀ 与系统余量移入「性能与余量」，同 GEO

    // ② 几何与天线（上行 / 下行 双列）。NGSO「对卫星仰角」为最低仰角
    // 注：NGSO 不含「极化角」——卫星位置时变，GEO 式极化偏转/方位反算不适用（恒为 0，已移除）
    const geoSeg = b._dualSeg('几何与天线（上行 / 下行）', [
      ['频率', 'uplinkFrequencyResult', 'downlinkFrequencyResult', 'GHz'],
      ['极化方式', 'uplinkPolarizationResult', 'downlinkPolarizationResult', ''],
      ['地球站天线口径', 'earthAntennaDiameterResult', 'rxAntennaDiameterResult', '米'],
      ['地球站经度', 'earthLongitudeResult', 'rxLongitudeResult', '°E'],
      ['地球站纬度', 'earthLatitudeResult', 'rxLatitudeResult', '°N'],
      ['对卫星仰角', 'elevationResult', 'rxElevationResult', '°'],
      ['天线效率', 'earthAntennaEfficiencyResult', 'rxAntennaEfficiencyResult', '%'],
      ['波长', 'wavelengthResult', 'rxWavelengthResult', 'm'],
      ['3dB 波束宽度', 'beamWidthResult', 'theta3', '°'],
      ['天线增益', 'txAntennaGainResult', 'rxAntennaGainResult', 'dBi'],
      ['星地距离', 'slantRangeResult', 'rxSlantRangeResult', 'km']
    ], { id: 'geometry', cls: 'param' });
    geoSeg.rows.unshift({
      key: '城市', id: '#城市', kind: 'ref', sign: '', label: b._t('城市'),
      up: b._disp(txLocation), down: b._disp(rxLocation),
      total: '', unit: '', unitKey: '', cum: '', num: null, numDown: null
    });
    // 可见性几何（并入几何天线段，上行/下行双列——上下行轨道高度/仰角可不同，结果可不同）
    // 纯轨道几何，依据 Maral&Bousquet/Wertz：周期 P=2π√(r³/μ)、覆盖地心半角 λ=arccos((Re/r)cosε)−ε、
    // 地面覆盖半径 Re·λ、最大过境时长 λ·P/π。重访/可见星数需星座规模，工具无输入，故不展示。
    const visRow = (label, upKey, downKey, unit) => ({
      key: label, id: upKey, kind: 'ref', sign: '', label: b._t(label),
      up: b._disp(r[upKey]), down: b._disp(r[downKey]), total: '', unit: b._t(unit) || '', unitKey: unit || '', cum: '',
      num: b._numStrict(r[upKey]), numDown: b._numStrict(r[downKey])
    });
    geoSeg.rows.push(
      visRow('轨道周期', 'orbitPeriodUpResult', 'orbitPeriodDownResult', 'min'),
      visRow('覆盖地心半角', 'coverageHalfAngleUpResult', 'coverageHalfAngleDownResult', '°'),
      visRow('地面覆盖半径', 'coverageRadiusUpResult', 'coverageRadiusDownResult', 'km'),
      visRow('最大过境时长(天顶)', 'maxPassDurationUpResult', 'maxPassDurationDownResult', 'min')
    );
    segs.push(geoSeg);

    // ③ 传播损耗（上行 / 下行 双列）
    // 「等效仰角 P.618§8」：§8 统计口径启用侧显示雨/气/云/闪烁所用的等效仰角（FSL 仍为最差瞬时
    // 几何仰角，见「对卫星仰角」行）；未启用时字段为空串，_dualSeg 自动滤行。
    segs.push(b._dualSeg('传播损耗（上行 / 下行）', [
      ['自由空间损耗', 'uplinkFSLResult', 'downlinkFSLResult', 'dB'],
      ['等效仰角 P.618§8', 'uplinkS8ElevResult', 'downlinkS8ElevResult', '°'],
      ['大气衰减 P.676', 'uplinkAtmosphericAttenuationResult', 'downlinkAtmosphericAttenuationResult', 'dB'],
      ['雨衰 P.618', 'uplinkRainAttenuation', 'downlinkRainAttenuationResult', 'dB'],
      ['云衰 P.840', 'uplinkCloudAttenuation', 'downlinkCloudAttenuation', 'dB'],
      ['其他损耗', 'uplinkMiscLossResult', 'downlinkMiscLossResult', 'dB'],
      ['总衰减', 'uplinkTotalAttenuationResult', 'downlinkTotalAttenuationResult', 'dB'],
      ['雨层高度 P.839', 'uplinkRainHeightResult', 'downlinkRainHeightResult', 'km']
    ], { id: 'propagation', cls: 'param' }));

    // ④ 卫星参数（NGSO：无轨道位置；上下行轨道高度/速度/时延/多普勒可不同 → 双列；
    //    卫星载荷参数按收发侧归列：单位面积增益/SFD/IBO/GT 为上行接收侧，EIRP/OBO 为下行发射侧）
    //    卫星功率谱密度移入 ⑤，与地球站 PSD 上下行对位（同 GEO）。
    segs.push(b._dualSeg('卫星参数（上行 / 下行）', [
      ['轨道高度', 'orbitAltitudeUpResult', 'orbitAltitudeResult', 'km'],
      ['轨道速度(惯性系)', 'orbitVelocityUpResult', 'orbitVelocityResult', 'km/s'],
      ['相对地面运动速度', 'groundRelVelUpResult', 'groundRelVelResult', 'km/s'],
      ['链路时延(单程·端到端)', 'linkDelayResult', '_none', 'ms'],
      ['链路时延(往返 RTT)', rttMs, '_none', 'ms', true],
      ['最大多普勒', 'maxDopplerUplinkResult', 'maxDopplerDownlinkResult', 'kHz'],
      ['卫星天线单位面积增益', 'antennaGainResult', '_none', 'dBi/m²'],
      ['卫星 G/T', 'satelliteGTResult', '_none', 'dB/K'],
      ['卫星 SFD', 'SFDsResult', '_none', 'dBW/m²'],
      ['IBO', 'BOiResult', '_none', 'dB'],
      ['卫星饱和 EIRP', '_none', 'EIRPsResult', 'dBW'],
      ['OBO', '_none', 'BOoResult', 'dB'],
      ['转发器带宽', 'transponderBandwidthResult', 'transponderBandwidthResult', 'MHz']
    ], { id: 'satellite', cls: 'param' }));

    // ⑤ 功率谱与通量密度（上行 / 下行 双列）——口径同 GEO：每行一个物理量，两列＝两个方向的
    // 发射端 / 到达端；「到达端通量密度」两列同取实际值（含雨衰），晴天口径只有上行有对应量。
    // 「邻星旁瓣/隔离」相关行（旁瓣增益/EIRP/PSD、ITU 旁瓣 PSD 建议值、接收旁瓣增益）本段没有：
    // 它们是 GEO 静止弧概念，对 NGSO 本就不适配；2026-08-07 起该口径连同 deltaTheta 入参
    // 在 GEO/NGSO 两个引擎里都已删除（平台无此输入框，见 linkCalculator.js 同日注释）。
    // 保留落地 PFD vs ITU Article 21 限值（仰角驱动，对 NGSO 下行有效）。
    segs.push(b._dualSeg('功率谱与通量密度（上行 / 下行）', [
      ['发射端功率谱密度', 'stationPSDResult', 'satellitePSDResult', 'dBW/Hz'],
      ['到达端通量密度', 'arrivalPFDAtSatelliteResult', 'arrivalPFDAtGroundResult', 'dBW/m²'],
      ['到达通量密度（晴天）', 'PFDcResult', '_none', 'dBW/m²'],
      ['ITU PFD 限值(Art.21)', '_none', 'ituPfdLimitPerM2', 'dBW/m²']
    ], { id: 'psd', cls: 'result' }));

    // ⑥ 接收增益与噪声（地球站，单列）——G/T 的完整分解。同 GEO：不拆双列，
    // 因为卫星接收侧只给一个 G/T 总值（已列在 ④），没有卫星侧噪温分解。
    segs.push(b._refSeg('接收增益与噪声（地球站）', [
      ['接收天线增益', 'rxAntennaGainResult', 'dBi'],
      ['接收馈线损耗', 'rxFeederLossResult', 'dB'],
      ['G/T', 'gOverTeResult', 'dB/K'],
      ['G/T 劣化', 'gOverTdegradationResult', 'dB'],
      ['天线噪声温度', 'antennaNoiseTempResult', 'K'],
      ['接收机噪声温度', 'receiverNoiseTempResult', 'K'],
      ['雨噪声温度', 'rainNoiseTempResult', 'K'],
      ['云噪声温度', 'cloudNoiseTempResult', 'K'],
      ['系统噪声温度', 'systemNoiseTempKResult', 'K'],
      ['系统噪声温度(dB)', 'systemNoiseTempDbResult', 'dBK']
    ], { id: 'noise', cls: 'result' }));

    // ⑥ 链路预算级联（上行 / 下行 / ISL / 合计 三列）
    // NGSO 合成：上行 C/N ⊕ ISL 等效 C/N ⊕ 下行 C/N（噪声并联）= 合计 C/N。
    // ISL 段折算到载波噪声带宽后并入合成，使整表「逐行可算通」。
    const C = b._cRow;
    const T = b._cTri;
    const num = (k) => b._num(r[k]);
    const KB = 228.6;
    const noiseBW = num('RXnoiseBW');
    const paBackoffDb = num('paRecommendationdBResult') - num('selectedPowerResult');
    const cUp = num('stationEIRPResult') - num('uplinkFSLResult') - num('uplinkAtmosphericAttenuationResult')
      - num('uplinkRainAttenuation') - num('uplinkCloudAttenuation') - num('uplinkMiscLossResult');
    const upThermalCN = cUp + num('satelliteGTResult') + KB - noiseBW;
    const upIntfLoss = upThermalCN - num('uplinkCN');
    const uplinkRainDominant = num('uplinkPowerRatioResult') > num('downlinkPowerRatioResult');
    const dnRainEff = uplinkRainDominant ? 0 : num('downlinkRainAttenuationResult');
    const dnGtDegEff = uplinkRainDominant ? 0 : num('gOverTdegradationResult');
    const cDn = num('transponderOutputEIRP') - num('downlinkFSLResult') - num('downlinkAtmosphericAttenuationResult')
      - dnRainEff - num('downlinkCloudAttenuation') - num('downlinkMiscLossResult');
    const dnThermalCN = cDn + num('gOverTeResult') + KB - noiseBW;
    // 下行干扰损失：取引擎真实四路干扰并联值（按主导场景口径），不再从反解 downlinkCN 取残差——
    // 残差在「上行主导 + UPC 未全补偿」时会把上行残余雨衰错计入本行（ACI/ASI/XPI/IM 标签失真可达数 dB）。
    const dnIntfLoss = num('downlinkInterferenceLossResult');
    // 残差扣除真实干扰后的剩余 = 经弯管转嫁到下行侧资源账的上行残余雨衰（UPC 未补偿部分；
    // 下行主导 / UPC 全补偿时 ≈ 0）。按构造闭合，保证「下行 C/N」检查点逐行加得通（含 ISL 场景）。
    const dnResidualRain = (dnThermalCN - dnGtDegEff - num('downlinkCN')) - dnIntfLoss;

    const cascadeRows = [
      // —— 上行：地球站 → 到达卫星 → C/T → C/N₀ → C/N ——
      C('base', '功放建议功率', 'paRecommendationdBResult', 'dBW', 'up'),
      C('loss', '功放回退', paBackoffDb, 'dB', 'up'),
      C('loss', '馈线损耗', 'feederLossResult', 'dB', 'up'),
      C('gain', '发射天线增益', 'txAntennaGainResult', 'dBi', 'up'),
      C('sub', '地球站 EIRP', 'stationEIRPResult', 'dBW', 'up'),
      C('loss', '自由空间损耗', 'uplinkFSLResult', 'dB', 'up'),
      C('loss', '大气衰减 P.676', 'uplinkAtmosphericAttenuationResult', 'dB', 'up'),
      C('loss', '雨衰 P.618', 'uplinkRainAttenuation', 'dB', 'up'),
      C('loss', '云衰 P.840', 'uplinkCloudAttenuation', 'dB', 'up'),
      C('loss', '其他损耗', 'uplinkMiscLossResult', 'dB', 'up'),
      C('sub', '到达卫星载波电平 C', null, 'dBW', 'up'),
      C('ref', '到达卫星通量密度', 'arrivalPFDAtSatelliteResult', 'dBW/m²', 'up'),
      C('gain', '卫星 G/T', 'satelliteGTResult', 'dB/K', 'up'),
      C('chk', '上行 C/T', null, 'dBW/K', 'up'),
      C('gain', '−玻尔兹曼常数 k', KB, 'dB', 'up'),
      C('chk', '上行 C/N₀', null, 'dBHz', 'up'),
      C('loss', '载波噪声带宽 10·lgB', noiseBW, 'dB', 'up'),
      C('chk', '上行 C/N（热噪声）', null, 'dB', 'up'),
      C('loss', '上行干扰损失 ACI/ASI/XPI/IM', upIntfLoss, 'dB', 'up'),
      C('sub', '上行 C/(N+I)', null, 'dB', 'up'),
      // —— 下行：卫星转发器 → 到达地面 → C/T → C/N₀ → C/N ——
      C('base', '卫星饱和 EIRP', 'EIRPsResult', 'dBW', 'down'),
      C('loss', 'OBO', 'BOoResult', 'dB', 'down'),
      C('loss', '转发器工作区回退', 'actualTransponderCapacityResult', 'dB', 'down'),
      C('sub', '转发器输出 EIRP', 'transponderOutputEIRP', 'dBW', 'down'),
      C('ref', '卫星功率谱密度', 'satellitePSDResult', 'dBW/Hz', 'down'),
      C('loss', '自由空间损耗', 'downlinkFSLResult', 'dB', 'down'),
      C('loss', '大气衰减 P.676', 'downlinkAtmosphericAttenuationResult', 'dB', 'down'),
      C('loss', '雨衰 P.618', dnRainEff, 'dB', 'down'),
      C('loss', '云衰 P.840', 'downlinkCloudAttenuation', 'dB', 'down'),
      C('loss', '其他损耗', 'downlinkMiscLossResult', 'dB', 'down'),
      C('sub', '到达地面载波电平 C', null, 'dBW', 'down'),
      C('ref', '卫星到地面 PFD', 'arrivalPFDAtGroundResult', 'dBW/m²', 'down'),
      C('ref', '接收天线增益', 'rxAntennaGainResult', 'dBi', 'down'),
      C('gain', '地球站 G/T', 'gOverTeResult', 'dB/K', 'down'),
      C('loss', 'G/T 劣化（降雨）', dnGtDegEff, 'dB', 'down'),
      C('chk', '下行 C/T', null, 'dBW/K', 'down'),
      C('gain', '−玻尔兹曼常数 k', KB, 'dB', 'down'),
      C('chk', '下行 C/N₀', null, 'dBHz', 'down'),
      C('loss', '载波噪声带宽 10·lgB', noiseBW, 'dB', 'down'),
      C('chk', '下行 C/N（热噪声）', null, 'dB', 'down'),
      C('loss', '下行干扰损失 ACI/ASI/XPI/IM', dnIntfLoss, 'dB', 'down'),
      // 「确有上行雨衰」门槛：残余由十余个 toFixed(2) 出参相加，量化噪声可越过 0.005，
      // 晴空也会冒出一行 0.01~0.02 的假「上行雨衰」；上行雨衰 <0.05 dB 时本行无物理意义，不列。
      ...(isFinite(dnResidualRain) && Math.abs(dnResidualRain) >= 0.005 && num('uplinkRainAttenuation') >= 0.05
        ? [C('loss', '上行雨衰', dnResidualRain, 'dB', 'down')]
        : []),
      C('sub', '下行 C/N', null, 'dB', 'down')
    ];
    // —— 星间链路 ISL 并入「上行侧」：弯管端到端落地前噪声逐段累加，上行 C/N ⊕ ISL = 有效上行 C/N ——
    // 插在「上行 C/N」之后、下行段之前，得到「上行 C/N（含 ISL）」，使合成 上行(含ISL)⊕下行=合计 逐行算得通
    if (hasIsl) {
      const islUpRows = [
        C('ref', 'ISL 跳数', 'islHopsResult', '跳', 'up'),
        C('ref', 'ISL 单跳 C/T', 'islPerHopCTResult', 'dBW/K', 'up'),
        // 折算入总 C/T 的 ISL 等效 C/N：上行 C/N ⊕ 该值 = 上行 C/N（含 ISL），逐行算得通
        C('ref', 'ISL 等效 C/N（计入总C/T）', 'islCascadeCNResult', 'dB', 'up'),
        C('sub', '上行 C/(N+I)（含 ISL）', 'uplinkWithIslCN', 'dB', 'up')
      ];
      const idx = cascadeRows.findIndex((row) => row.key === 'up·上行 C/N');
      if (idx >= 0) cascadeRows.splice(idx + 1, 0, ...islUpRows);
      else cascadeRows.push(...islUpRows);
    }
    // —— 合成与余量：有效上行（含 ISL）⊕ 下行（噪声并联）= 合计 ——
    cascadeRows.push(
      T('kpi', 'C/(N+I)（合成）', hasIsl ? 'uplinkWithIslCN' : 'uplinkCN', 'downlinkCN', 'carrierTotalCN', 'dB'),
      T('ref', '门限 C/N', null, null, 'thresholdCN', 'dB'),
      T('margin', '链路余量', null, null, 'linkmargin', 'dB')
    );
    segs.push(b._cascadeTriSeg('链路预算级联（上行 / 下行 / 合计）', cascadeRows, { id: 'cascade', cls: 'result' }));

    // ⑥-b 星间链路 ISL（性能评估，单列；按 islMode 分链路展示，逐行可算通）
    // 经验值(manual)：仅展示输入 SNR → 折算单跳 C/T；
    // 微波(rf)：EIRP − FSL(频率/距离) + G/T − 其他损耗 = 单跳 C/T；
    // 激光(optical)：发射光功率 + 发射增益 − 光学FSL − 指向损耗 + 接收增益 = 接收光功率，−N₀ = C/N₀，+k = 单跳 C/T。
    if (hasIsl) {
      const islMode = r.islModeResult || 'manual';
      const islRows = [['ISL 跳数', 'islHopsResult', '跳']];
      if (islMode === 'rf') {
        islRows.push(
          ['ISL 频率', 'islRfFreqResult', 'GHz'],
          ['单跳距离', 'islRfDistResult', 'km'],
          ['ISL EIRP', 'islRfEirpResult', 'dBW'],
          ['ISL 自由空间损耗', 'islRfFslResult', 'dB'],
          ['ISL G/T', 'islRfGtResult', 'dB/K'],
          ['其他损耗', 'islRfMiscLossResult', 'dB']
        );
      } else if (islMode === 'optical') {
        islRows.push(
          ['波长', 'islOptWavelengthResult', 'nm'],
          ['发射口径', 'islOptTxApertureResult', 'm'],
          ['接收口径', 'islOptRxApertureResult', 'm'],
          ['单跳距离', 'islOptDistResult', 'km'],
          ['发射光功率', 'islOptTxPowerResult', 'dBm'],
          ['发射望远镜增益', 'islOptGTxResult', 'dBi'],
          ['光学自由空间损耗', 'islOptFslResult', 'dB'],
          ['指向+光学损耗', 'islOptPointLossResult', 'dB'],
          ['接收望远镜增益', 'islOptGRxResult', 'dBi'],
          ['接收光功率', 'islOptPRxResult', 'dBm'],
          ['接收灵敏度', 'islOptSensResult', 'dBm'],
          ['灵敏度参考速率', 'islOptSensRateResult', 'Mbps'],
          ['灵敏度 Eb/N₀', 'islOptSensEbN0Result', 'dB'],
          ['等效噪声谱密度 N₀', 'islOptN0Result', 'dBm/Hz'],
          ['单跳 C/N₀', 'islOptCN0Result', 'dBHz']
        );
      } else {
        islRows.push(
          ['输入 SNR', 'islManualSnrResult', 'dB'],
          ['参考带宽', 'islManualRefBwResult', 'MHz']
        );
      }
      islRows.push(
        ['ISL 单跳 C/T', 'islPerHopCTResult', 'dBW/K'],
        ['ISL 单跳 C/N', 'islPerHopCNResult', 'dB'],
        ['ISL 等效 C/T（并联）', 'islTotalCTResult', 'dBW/K'],
        ['ISL 等效 C/N（并联）', 'islTotalCNResult', 'dB'],
        ['ISL 对上行 C/N 代价', 'islImpactResult', 'dB']
      );
      const modeLabel = islMode === 'rf' ? '微波链路' : (islMode === 'optical' ? '激光链路' : '经验值');
      segs.push(b._refSeg('星间链路 ISL（' + modeLabel + '）', islRows, { id: 'isl', cls: 'result' }));
    }

    // ⑧ 性能与余量（单列）——结论汇总，口径同 GEO（本载波工作点；热噪声档与等效 C/I 分列）。
    // NGSO 多一行「上行 C/(N+I)（含 ISL）」，有星间跳时合成用的是它而不是裸上行值（与级联表合成行一致）。
    segs.push(b._refSeg('性能与余量', [
      ['Eb/N₀', 'ebnoActualResult', 'dB'],
      ['Es/N₀', 'esnoActualResult', 'dB'],
      ['上行 C/N（热噪声）', 'uplinkThermalCN', 'dB'],
      ['上行 C/I', 'uplinkInterferenceCN', 'dB'],
      ['上行 C/(N+I)', 'uplinkCN', 'dB'],
      ...(hasIsl ? [['上行 C/(N+I)（含 ISL）', 'uplinkWithIslCN', 'dB']] : []),
      ['下行 C/N（热噪声）', 'downlinkThermalCN', 'dB'],
      ['下行 C/I', 'downlinkInterferenceCN', 'dB'],
      ['下行 C/(N+I)', 'downlinkCN', 'dB'],
      ['C/(N+I)（合成）', 'carrierTotalCN', 'dB'],
      ['合成 C/N₀', 'carrierTotalCN0', 'dBHz'],
      ['门限 C/N', 'thresholdCN', 'dB'],
      ['门限 C/N₀', 'carrierThresholdCN0', 'dBHz'],
      ['链路余量', 'linkmargin', 'dB'],
      ['系统余量', 'marginResult', 'dB'],
      ['系统可用度', 'systemAvailabilityResult', '%'],
      ['上行可用度', 'uplinkAvailabilityResult', '%'],
      ['下行可用度', 'downlinkAvailabilityResult', '%'],
      ['年中断(分钟)', 'interruptionMinutes', 'min'],
      ['年中断(小时)', 'interruptionHours', 'h']
    ], { id: 'performance', cls: 'result' }));

    // ⑨ 工况对照（晴空 / 降雨 / 雨致代价）——口径与做法同 GEO，见 _weatherSeg
    segs.push(b._weatherSeg('工况对照（晴空 / 降雨）',
      num('uplinkCN'), num('downlinkCN'), num('carrierTotalCN'),
      num('uplinkRainAttenuation'), dnRainEff, dnGtDegEff, dnResidualRain,
      { id: 'weather', cls: 'result' }));

    // ⑩ 干扰分项与极化（转发器参考口径，同 GEO）——把级联里压成一行的「干扰损失」摊成明细账
    segs.push(b._refSeg('干扰分项与极化（转发器参考口径）', [
      ['上行 ACI C/N₀', 'aciUplinkCN0Result', 'dBHz'],
      ['上行 ASI C/N₀', 'adjUplinkCN0Result', 'dBHz'],
      ['上行 XPI C/N₀', 'xpolUplinkCN0Result', 'dBHz'],
      ['功放互调 C/N₀', 'hpaIntermodCN0Result', 'dBHz'],
      ['下行 ACI C/N₀', 'aciDownlinkCN0Result', 'dBHz'],
      ['下行 ASI C/N₀', 'adjDownlinkCN0Result', 'dBHz'],
      ['下行 XPI C/N₀', 'xpolDownlinkCN0Result', 'dBHz'],
      ['转发器互调 C/N₀', 'xpdrIntermodCN0Result', 'dBHz'],
      ['上行雨致 XPD', 'uplinkRainXPDResult', 'dB'],
      ['下行雨致 XPD', 'downlinkRainXPDResult', 'dB']
    ], { id: 'interference', cls: 'result' }));

    // ⑪ 资源占用（单列）——「功放建议值(W)」与旧 ⑤ 段的「功放建议功率(W)」是同一字段
    // （paRecommendation）列了两遍，此处合并为一处（同 GEO）。
    segs.push(b._refSeg('资源占用', [
      ['最大载波数', 'maxCarrierCount', ''],
      ['带宽占用比', 'bandwidthUsageRatio', '%'],
      ['功率占用比', 'powerUsageRatio', '%'],
      ['功放建议值', 'paRecommendationdBResult', 'dBW'],
      ['功放建议值(W)', 'paRecommendation', 'W'],
      ['功放实际输出', 'selectedPowerResult', 'dBW'],
      ['功放实际输出(W)', 'selectedPowerWResult', 'W'],
      ['UPC 上行功控余量', 'UPCmarginResult', 'dB']
    ], { id: 'resources', cls: 'result' }));

    return b._number(segs);
  };

  // ============ 再生式链路瀑布（按 linkType 分派上/下行） ============
  // 结果 d 由 computeRegenUplinkMode / computeRegenDownlinkMode 产出，已把 carrierTotalCN/linkmargin
  // 重标为对应单向口径；此处按 d.linkType 选上行或下行构建器。
  b.buildRegen = function () {
    if (results && results.linkType === 'downlink') return b.buildRegenDownlink();
    if (results && results.linkType === 'laser') return b.buildRegenLaser();
    if (results && results.linkType === 'isl') return b.buildRegenIsl();
    return b.buildRegenUplink();
  };

  // ============ 再生式上行链路瀑布（星上再生：仅上行链，合计 C/N = 上行 C/(N+I)） ============
  // 与 NGSO 弯管构建器独立：删除转发器段、下行段与三列合成，只保留上行链，末尾接门限 C/N 与链路余量。
  // 读取的结果 d 由 computeRegenUplinkMode 产出并已把 carrierTotalCN/linkmargin 重标为上行口径。
  b.buildRegenUplink = function () {
    // 往返时延 RTT ＝ 单程 ×2（引擎只出单程）；TCP 吞吐与话音质量按 RTT 判
    const rttMs = (parseFloat(results.linkDelayResult) > 0) ? (parseFloat(results.linkDelayResult) * 2).toFixed(1) : null;
    const r = results;
    if (r.linkmargin === undefined) return [];
    const segs = [];

    // ① 载波与调制参数（链路级，单列）
    segs.push(b._refSeg('载波与调制参数', [
      ['载波带宽', 'allocBandwidthResult', 'kHz'],
      ['频谱效率', 'spectralEfficiencyResult', 'bit/s/Hz'],
      ['信息速率', 'infoRateResult', 'kbps'],
      ['载波速率', 'carrierRateResult', 'kbps'],
      ['符号速率', 'symbolRateResult', 'ksps'],
      ['码片速率', 'ChipRateResult', 'kcps'],
      ['调制方式', 'modulationResult', ''],
      ['调制因子', 'modulationFactorResult', ''],
      ['FEC 码率', 'fecResult', ''],
      ['误码率', 'berResult', ''],
      ['门限 Eb/N₀', 'ebnoResult', 'dB'],
      ['门限 Es/N₀', 'esnoResult', 'dB'],
      ['载波噪声带宽', 'RXnoiseBW', 'dB-Hz']
    ], { id: 'carrier', cls: 'param' }));   // 实际 Eb/N₀ / Es/N₀ 与系统余量移入「性能与余量」，同 GEO

    // ② 几何与天线（上行，单列）+ 可见性几何
    const geoSeg = b._refSeg('几何与天线（上行）', [
      ['频率', 'uplinkFrequencyResult', 'GHz'],
      ['极化方式', 'uplinkPolarizationResult', ''],
      ['地球站天线口径', 'earthAntennaDiameterResult', '米'],
      ['地球站经度', 'earthLongitudeResult', '°E'],
      ['地球站纬度', 'earthLatitudeResult', '°N'],
      ['对卫星仰角', 'elevationResult', '°'],
      ['天线效率', 'earthAntennaEfficiencyResult', '%'],
      ['波长', 'wavelengthResult', 'm'],
      ['3dB 波束宽度', 'beamWidthResult', '°'],
      ['天线增益', 'txAntennaGainResult', 'dBi'],
      ['星地距离', 'slantRangeResult', 'km'],
      ['轨道周期', 'orbitPeriodUpResult', 'min'],
      ['覆盖地心半角', 'coverageHalfAngleUpResult', '°'],
      ['地面覆盖半径', 'coverageRadiusUpResult', 'km'],
      ['最大过境时长(天顶)', 'maxPassDurationUpResult', 'min']
    ], { id: 'geometry', cls: 'param' });
    geoSeg.rows.unshift({ key: '城市', id: '#城市', kind: 'ref', sign: '', label: b._t('城市'), up: b._disp(txLocation), down: '', total: '', unit: '', unitKey: '', cum: '', num: null });
    segs.push(geoSeg);

    // ③ 传播损耗（上行，单列）。「等效仰角 P.618§8」仅 §8 统计口径启用时出现（空串自动滤行）
    segs.push(b._refSeg('传播损耗（上行）', [
      ['自由空间损耗', 'uplinkFSLResult', 'dB'],
      ['等效仰角 P.618§8', 'uplinkS8ElevResult', '°'],
      ['大气衰减 P.676', 'uplinkAtmosphericAttenuationResult', 'dB'],
      ['雨衰 P.618', 'uplinkRainAttenuation', 'dB'],
      ['云衰 P.840', 'uplinkCloudAttenuation', 'dB'],
      ['其他损耗', 'uplinkMiscLossResult', 'dB'],
      ['总衰减', 'uplinkTotalAttenuationResult', 'dB'],
      ['雨层高度 P.839', 'uplinkRainHeightResult', 'km']
    ], { id: 'propagation', cls: 'param' }));

    // ④ 卫星（上行接收侧，单列）——再生无转发器：只列轨道运动与卫星接收 G/T
    segs.push(b._refSeg('卫星（上行接收）', [
      ['轨道高度', 'orbitAltitudeUpResult', 'km'],
      ['轨道速度(惯性系)', 'orbitVelocityUpResult', 'km/s'],
      ['相对地面运动速度', 'groundRelVelUpResult', 'km/s'],
      ['链路时延(单程·端到端)', 'linkDelayResult', 'ms'],
      ['链路时延(往返 RTT)', rttMs, 'ms', true],
      ['最大多普勒', 'maxDopplerUplinkResult', 'kHz'],
      ['卫星 G/T', 'satelliteGTResult', 'dB/K']
    ], { id: 'satellite', cls: 'param' }));

    // ⑤ 功率谱与噪声（上行，单列）——功放建议功率移入「资源占用」（同 GEO，功放类归一处）。
    // 再生式上行的接收端在星上，故这里的系统噪温是卫星接收系统的，不另立地球站噪声段。
    segs.push(b._refSeg('功率谱与噪声（上行）', [
      ['地球站功率谱密度', 'stationPSDResult', 'dBW/Hz'],
      ['到达卫星通量密度', 'arrivalPFDAtSatelliteResult', 'dBW/m²'],
      ['到达通量密度（晴天）', 'PFDcResult', 'dBW/m²'],
      ['系统噪声温度', 'systemNoiseTempKResult', 'K'],
      ['系统噪声温度(dB)', 'systemNoiseTempDbResult', 'dBK']
    ], { id: 'psd', cls: 'result' }));

    // ⑥ 链路预算级联（再生式上行，单列）：地球站 → 到达卫星 → C/T → C/N₀ → C/N → 门限 → 余量
    const C = b._cRow;
    const num = (k) => b._num(r[k]);
    const KB = 228.6;
    const noiseBW = num('RXnoiseBW');
    const paBackoffDb = num('paRecommendationdBResult') - num('selectedPowerResult');
    const cUp = num('stationEIRPResult') - num('uplinkFSLResult') - num('uplinkAtmosphericAttenuationResult')
      - num('uplinkRainAttenuation') - num('uplinkCloudAttenuation') - num('uplinkMiscLossResult');
    const upThermalCN = cUp + num('satelliteGTResult') + KB - noiseBW;
    const upIntfLoss = upThermalCN - num('uplinkCN');
    segs.push(b._cascadeSingleSeg('链路预算级联（再生式上行）', [
      C('base', '功放建议功率', 'paRecommendationdBResult', 'dBW', 'up'),
      C('loss', '功放回退', paBackoffDb, 'dB', 'up'),
      C('loss', '馈线损耗', 'feederLossResult', 'dB', 'up'),
      C('gain', '发射天线增益', 'txAntennaGainResult', 'dBi', 'up'),
      C('sub', '地球站 EIRP', 'stationEIRPResult', 'dBW', 'up'),
      C('loss', '自由空间损耗', 'uplinkFSLResult', 'dB', 'up'),
      C('loss', '大气衰减 P.676', 'uplinkAtmosphericAttenuationResult', 'dB', 'up'),
      C('loss', '雨衰 P.618', 'uplinkRainAttenuation', 'dB', 'up'),
      C('loss', '云衰 P.840', 'uplinkCloudAttenuation', 'dB', 'up'),
      C('loss', '其他损耗', 'uplinkMiscLossResult', 'dB', 'up'),
      C('sub', '到达卫星载波电平 C', null, 'dBW', 'up'),
      C('ref', '到达卫星通量密度', 'arrivalPFDAtSatelliteResult', 'dBW/m²', 'up'),
      C('gain', '卫星 G/T', 'satelliteGTResult', 'dB/K', 'up'),
      C('chk', '上行 C/T', null, 'dBW/K', 'up'),
      C('gain', '−玻尔兹曼常数 k', KB, 'dB', 'up'),
      C('chk', '上行 C/N₀', null, 'dBHz', 'up'),
      C('loss', '载波噪声带宽 10·lgB', noiseBW, 'dB', 'up'),
      C('chk', '上行 C/N（热噪声）', null, 'dB', 'up'),
      C('loss', '上行干扰损失 ACI/ASI/XPI/IM', upIntfLoss, 'dB', 'up'),
      C('sub', '上行 C/(N+I)（再生·合计）', null, 'dB', 'up'),
      C('ref', '门限 C/N', 'thresholdCN', 'dB', 'up'),
      C('margin', '链路余量', 'linkmargin', 'dB', 'up')
    ], { id: 'cascade', cls: 'result' }));

    // ⑦ 性能与余量（上行，单列）——结论汇总。再生式上下行解耦：只列上行可用度
    //（＝该向的系统可用度），不重复列联合可用度。
    segs.push(b._refSeg('性能与余量（上行）', [
      ['Eb/N₀', 'ebnoActualResult', 'dB'],
      ['Es/N₀', 'esnoActualResult', 'dB'],
      ['上行 C/N（热噪声）', 'uplinkThermalCN', 'dB'],
      ['上行 C/I', 'uplinkInterferenceCN', 'dB'],
      ['上行 C/(N+I)（再生·合计）', 'uplinkCN', 'dB'],
      ['门限 C/N', 'thresholdCN', 'dB'],
      ['链路余量', 'linkmargin', 'dB'],
      ['系统余量', 'marginResult', 'dB'],
      ['上行可用度', 'uplinkAvailabilityResult', '%'],
      ['年中断(分钟)', 'interruptionMinutes', 'min'],
      ['年中断(小时)', 'interruptionHours', 'h']
    ], { id: 'performance', cls: 'result' }));

    // 工况对照（晴空 / 降雨 / 雨致代价）——单向链路只有一条链，做法见 _weatherSegSingle。
    // 再生式上行的接收端在星上，地面降雨只衰减信号、不抬高星上噪温，故无 G/T 劣化项。
    segs.push(b._weatherSegSingle('工况对照（晴空 / 降雨，上行）',
      b._num(r.uplinkCN), b._num(r.uplinkRainAttenuation), null,
      { id: 'weather', cls: 'result' }));

    // ⑨ 资源占用（上行，单列）
    segs.push(b._refSeg('资源占用（上行）', [
      ['功放建议值', 'paRecommendationdBResult', 'dBW'],
      ['功放建议值(W)', 'paRecommendation', 'W'],
      ['功放实际输出', 'selectedPowerResult', 'dBW'],
      ['功放实际输出(W)', 'selectedPowerWResult', 'W'],
      ['UPC 上行功控余量', 'UPCmarginResult', 'dB']
    ], { id: 'resources', cls: 'result' }));

    return b._number(segs);
  };

  // ============ 再生式下行链路瀑布（星上再生 → 地面站：仅下行链，合计 C/N = 下行 C/(N+I)） ============
  // 与上行构建器对称：删除转发器段、上行段与三列合成，只保留下行链，末尾接门限 C/N 与链路余量。
  // 读取的结果 d 由 computeRegenDownlinkMode 产出：gOverTeResult 已回填「实际所用 G/T」，
  // downlinkThermalCN/downlinkCN/carrierTotalCN 已按再生下行口径（卫星直发 EIRP、永远计下行雨衰）重算。
  b.buildRegenDownlink = function () {
    // 往返时延 RTT ＝ 单程 ×2（引擎只出单程）；TCP 吞吐与话音质量按 RTT 判
    const rttMs = (parseFloat(results.linkDelayResult) > 0) ? (parseFloat(results.linkDelayResult) * 2).toFixed(1) : null;
    const r = results;
    if (r.linkmargin === undefined) return [];
    const segs = [];

    // ① 载波与调制参数（链路级，单列）
    segs.push(b._refSeg('载波与调制参数', [
      ['载波带宽', 'allocBandwidthResult', 'kHz'],
      ['频谱效率', 'spectralEfficiencyResult', 'bit/s/Hz'],
      ['信息速率', 'infoRateResult', 'kbps'],
      ['载波速率', 'carrierRateResult', 'kbps'],
      ['符号速率', 'symbolRateResult', 'ksps'],
      ['码片速率', 'ChipRateResult', 'kcps'],
      ['调制方式', 'modulationResult', ''],
      ['调制因子', 'modulationFactorResult', ''],
      ['FEC 码率', 'fecResult', ''],
      ['误码率', 'berResult', ''],
      ['门限 Eb/N₀', 'ebnoResult', 'dB'],
      ['门限 Es/N₀', 'esnoResult', 'dB'],
      ['载波噪声带宽', 'RXnoiseBW', 'dB-Hz']
    ], { id: 'carrier', cls: 'param' }));   // 实际 Eb/N₀ / Es/N₀ 与系统余量移入「性能与余量」，同 GEO

    // ② 几何与天线（下行，单列）+ 可见性几何
    const geoSeg = b._refSeg('几何与天线（下行）', [
      ['频率', 'downlinkFrequencyResult', 'GHz'],
      ['极化方式', 'downlinkPolarizationResult', ''],
      ['收信站天线口径', 'rxAntennaDiameterResult', '米'],
      ['收信站经度', 'rxLongitudeResult', '°E'],
      ['收信站纬度', 'rxLatitudeResult', '°N'],
      ['对卫星仰角', 'rxElevationResult', '°'],
      ['天线效率', 'rxAntennaEfficiencyResult', '%'],
      ['波长', 'rxWavelengthResult', 'm'],
      ['接收天线增益', 'rxAntennaGainResult', 'dBi'],
      ['星地距离', 'rxSlantRangeResult', 'km'],
      ['轨道周期', 'orbitPeriodDownResult', 'min'],
      ['覆盖地心半角', 'coverageHalfAngleDownResult', '°'],
      ['地面覆盖半径', 'coverageRadiusDownResult', 'km'],
      ['最大过境时长(天顶)', 'maxPassDurationDownResult', 'min']
    ], { id: 'geometry', cls: 'param' });
    geoSeg.rows.unshift({ key: '城市', id: '#城市', kind: 'ref', sign: '', label: b._t('城市'), up: b._disp(txLocation), down: '', total: '', unit: '', unitKey: '', cum: '', num: null });
    segs.push(geoSeg);

    // ③ 传播损耗（下行，单列）。「等效仰角 P.618§8」仅 §8 统计口径启用时出现（空串自动滤行）
    segs.push(b._refSeg('传播损耗（下行）', [
      ['自由空间损耗', 'downlinkFSLResult', 'dB'],
      ['等效仰角 P.618§8', 'downlinkS8ElevResult', '°'],
      ['大气衰减 P.676', 'downlinkAtmosphericAttenuationResult', 'dB'],
      ['雨衰 P.618', 'downlinkRainAttenuationResult', 'dB'],
      ['云衰 P.840', 'downlinkCloudAttenuation', 'dB'],
      ['其他损耗', 'downlinkMiscLossResult', 'dB'],
      ['总衰减', 'downlinkTotalAttenuationResult', 'dB'],
      ['雨层高度 P.839', 'downlinkRainHeightResult', 'km']
    ], { id: 'propagation', cls: 'param' }));

    // ④ 卫星（下行发射侧，单列）——再生无转发器：只列轨道运动与卫星下行 EIRP。
    // 卫星功率谱密度移入 ⑤，与到达地面 PFD 同列一段（同 GEO 的分区口径）。
    segs.push(b._refSeg('卫星（下行发射）', [
      ['轨道高度', 'orbitAltitudeResult', 'km'],
      ['轨道速度(惯性系)', 'orbitVelocityResult', 'km/s'],
      ['相对地面运动速度', 'groundRelVelResult', 'km/s'],
      ['链路时延(单程·端到端)', 'linkDelayResult', 'ms'],
      ['链路时延(往返 RTT)', rttMs, 'ms', true],
      ['最大多普勒', 'maxDopplerDownlinkResult', 'kHz'],
      ['卫星下行 EIRP', 'EIRPsResult', 'dBW']
    ], { id: 'satellite', cls: 'param' }));

    // ⑤ 功率谱与通量密度（下行，单列）——发射端 PSD 与到达端 PFD
    segs.push(b._refSeg('功率谱与通量密度（下行）', [
      ['卫星功率谱密度', 'satellitePSDResult', 'dBW/Hz'],
      ['卫星到地面 PFD', 'arrivalPFDAtGroundResult', 'dBW/m²']
    ], { id: 'psd', cls: 'result' }));

    // ⑥ 接收增益与噪声（收信站，单列）——G/T 的完整分解
    segs.push(b._refSeg('接收增益与噪声（收信站）', [
      ['收信站 G/T', 'gOverTeResult', 'dB/K'],
      ['雨致 G/T 劣化', 'gOverTdegradationResult', 'dB'],
      ['天线噪温', 'antennaNoiseTempResult', 'K'],
      ['接收机噪温', 'receiverNoiseTempResult', 'K'],
      ['馈线损耗', 'rxFeederLossResult', 'dB'],
      ['系统噪声温度', 'systemNoiseTempKResult', 'K'],
      ['系统噪声温度(dB)', 'systemNoiseTempDbResult', 'dBK']
    ], { id: 'noise', cls: 'result' }));

    // ⑥ 链路预算级联（再生式下行，单列）：卫星EIRP → 到达地面 → C/T → C/N₀ → C/N → 门限 → 余量
    const C = b._cRow;
    const num = (k) => b._num(r[k]);
    const KB = 228.6;
    const noiseBW = num('RXnoiseBW');
    const dnIntfLoss = num('downlinkThermalCN') - num('downlinkCN');
    segs.push(b._cascadeSingleSeg('链路预算级联（再生式下行）', [
      C('base', '卫星下行 EIRP', 'EIRPsResult', 'dBW', 'up'),
      C('ref', '卫星功率谱密度', 'satellitePSDResult', 'dBW/Hz', 'up'),
      C('loss', '自由空间损耗', 'downlinkFSLResult', 'dB', 'up'),
      C('loss', '大气衰减 P.676', 'downlinkAtmosphericAttenuationResult', 'dB', 'up'),
      C('loss', '雨衰 P.618', 'downlinkRainAttenuationResult', 'dB', 'up'),
      C('loss', '云衰 P.840', 'downlinkCloudAttenuation', 'dB', 'up'),
      C('loss', '其他损耗', 'downlinkMiscLossResult', 'dB', 'up'),
      C('sub', '到达地面载波电平 C', null, 'dBW', 'up'),
      C('ref', '卫星到地面 PFD', 'arrivalPFDAtGroundResult', 'dBW/m²', 'up'),
      C('gain', '收信站 G/T', 'gOverTeResult', 'dB/K', 'up'),
      C('loss', '雨致 G/T 劣化', 'gOverTdegradationResult', 'dB', 'up'),
      C('chk', '下行 C/T', null, 'dBW/K', 'up'),
      C('gain', '−玻尔兹曼常数 k', KB, 'dB', 'up'),
      C('chk', '下行 C/N₀', null, 'dBHz', 'up'),
      C('loss', '载波噪声带宽 10·lgB', noiseBW, 'dB', 'up'),
      C('chk', '下行 C/N（热噪声）', null, 'dB', 'up'),
      C('loss', '下行干扰损失 ACI/ASI/XPI/IM', dnIntfLoss, 'dB', 'up'),
      C('sub', '下行 C/(N+I)（再生·合计）', null, 'dB', 'up'),
      C('ref', '门限 C/N', 'thresholdCN', 'dB', 'up'),
      C('margin', '链路余量', 'linkmargin', 'dB', 'up')
    ], { id: 'cascade', cls: 'result' }));

    // ⑧ 性能与余量（下行，单列）——结论汇总。再生式上下行解耦：只列下行可用度（＝该向的系统可用度）
    segs.push(b._refSeg('性能与余量（下行）', [
      ['Eb/N₀', 'ebnoActualResult', 'dB'],
      ['Es/N₀', 'esnoActualResult', 'dB'],
      ['下行 C/N（热噪声）', 'downlinkThermalCN', 'dB'],
      ['下行 C/I', 'downlinkInterferenceCN', 'dB'],
      ['下行 C/(N+I)（再生·合计）', 'downlinkCN', 'dB'],
      ['门限 C/N', 'thresholdCN', 'dB'],
      ['链路余量', 'linkmargin', 'dB'],
      ['系统余量', 'marginResult', 'dB'],
      ['下行可用度', 'downlinkAvailabilityResult', '%'],
      ['年中断(分钟)', 'interruptionMinutes', 'min'],
      ['年中断(小时)', 'interruptionHours', 'h']
    ], { id: 'performance', cls: 'result' }));

    // 工况对照（晴空 / 降雨 / 雨致代价）——下行接收端在地面，雨衰与雨噪温（已折算进 G/T 劣化）都计入
    segs.push(b._weatherSegSingle('工况对照（晴空 / 降雨，下行）',
      b._num(r.downlinkCN), b._num(r.downlinkRainAttenuationResult), b._num(r.gOverTdegradationResult),
      { id: 'weather', cls: 'result' }));

    // ⑩ 资源占用（下行，单列）——再生下行无地面功放账，两端的收发能力就是这一向的资源口径
    segs.push(b._refSeg('资源占用（下行）', [
      ['卫星下行 EIRP', 'EIRPsResult', 'dBW'],
      ['收信站 G/T', 'gOverTeResult', 'dB/K']
    ], { id: 'resources', cls: 'result' }));

    return b._number(segs);
  };

  // ============ 再生式星间链路瀑布（微波 ISL：发射卫星 → 接收卫星，仅星间链，合计 C/N = 星间单跳 C/N） ============
  // 结果 d 由 computeRegenIslMode 产出（islMode='rf'）：islRf*Result 为 RF 星间预算中间量，
  // 几何量（星间距离/两星高度/夹角/掠地/多普勒/时延/可见度）由 UI 的 mergeIslGeometry 注入 isl*Result。
  b.buildRegenIsl = function () {
    const r = results;
    if (r.linkmargin === undefined) return [];
    const segs = [];
    const manualGeo = String(r.islManualGeomResult || '') === '1';   // 手动几何：星间距离由用户逐条给定

    // ① 载波与调制参数（链路级，单列）
    segs.push(b._refSeg('载波与调制参数', [
      ['载波带宽', 'allocBandwidthResult', 'kHz'],
      ['频谱效率', 'spectralEfficiencyResult', 'bit/s/Hz'],
      ['信息速率', 'infoRateResult', 'kbps'],
      ['载波速率', 'carrierRateResult', 'kbps'],
      ['符号速率', 'symbolRateResult', 'ksps'],
      ['码片速率', 'ChipRateResult', 'kcps'],
      ['调制方式', 'modulationResult', ''],
      ['调制因子', 'modulationFactorResult', ''],
      ['FEC 码率', 'fecResult', ''],
      ['误码率', 'berResult', ''],
      ['门限 Eb/N₀', 'ebnoResult', 'dB'],
      ['门限 Es/N₀', 'esnoResult', 'dB'],
      ['载波噪声带宽', 'RXnoiseBW', 'dB-Hz']
    ], { id: 'carrier', cls: 'param' }));   // 实际 Eb/N₀ / Es/N₀ 与系统余量移入「性能与余量」，同 GEO

    // ② 星间几何（最差工况，单列）——双 SGP4 + 地球临边遮挡。
    // 手动几何（islManualGeomResult）下星间距离是用户给的一个数，没有轨道解算：段名与行名都不说
    // 「最差工况」，其余几何行本就无值、自动被 _refSeg 剔掉。
    segs.push(b._refSeg(manualGeo ? '星间距离（手动给定）' : '星间几何（最差工况）', [
      ['星间频率', 'islRfFreqResult', 'GHz'],
      [manualGeo ? '星间链路距离' : '星间距离(最差)', 'islRfDistResult', 'km'],
      ['发射卫星高度', 'islTxAltResult', 'km'],
      ['接收卫星高度', 'islRxAltResult', 'km'],
      ['地心夹角', 'islCentralAngleResult', '°'],
      ['LOS 掠地高度', 'islGrazAltResult', 'km'],
      ['单程时延', 'islDelayResult', 'ms'],
      ['最大距离变化率', 'islRangeRateResult', 'km/s'],
      ['最大多普勒', 'islDopplerResult', 'kHz'],
      ['互视可见度', 'islVisibleFracResult', '%']
    ], { id: 'geometry', cls: 'param' }));

    // ③ 链路预算级联（再生式星间，单列）：发射EIRP → FSL → 接收G/T → C/T → C/N₀ → C/N → 门限 → 余量
    // 星间干扰 C/I（islCI，手填、留空即不计入）填了才出那三行：热噪检查点 → 干扰损失 → C/(N+I)，
    // 与 GEO/NGSO 上下行级联同体例（干扰以一行 loss 桥接热噪与实际值，级联列仍逐行可手算）。
    // 没填时只有原来那一行「星间 C/N」，逐字与从前相同。
    const C = b._cRow;
    const KB = 228.6;
    const noiseBW = b._num(r.RXnoiseBW);
    const islThermal = b._num(r.islPerHopThermalCNResult);
    const islTotal = b._num(r.islPerHopCNResult);
    const islCI = b._num(r.islCIResult);
    const islIntfRows = (islCI !== null && islThermal !== null && islTotal !== null) ? [
      C('chk', '星间 C/N（热噪声）', 'islPerHopThermalCNResult', 'dB', 'up'),
      C('ref', '星间C/I', 'islCIResult', 'dB', 'up'),
      C('loss', '干扰损失 星间C/I', islThermal - islTotal, 'dB', 'up'),
      C('sub', '星间 C/(N+I)', 'islPerHopCNResult', 'dB', 'up')
    ] : [
      C('chk', '星间 C/N', 'islPerHopCNResult', 'dB', 'up')
    ];
    segs.push(b._cascadeSingleSeg('链路预算级联（再生式星间）', [
      C('base', '发射卫星 EIRP', 'islRfEirpResult', 'dBW', 'up'),
      C('loss', '自由空间损耗', 'islRfFslResult', 'dB', 'up'),
      C('gain', '接收卫星 G/T', 'islRfGtResult', 'dB/K', 'up'),
      C('loss', '综合损耗', 'islRfMiscLossResult', 'dB', 'up'),
      C('chk', '星间 C/T', 'islPerHopCTResult', 'dBW/K', 'up'),
      C('gain', '−玻尔兹曼常数 k', KB, 'dB', 'up'),
      C('chk', '星间 C/N₀', null, 'dBHz', 'up'),
      C('loss', '载波噪声带宽 10·lgB', noiseBW, 'dB', 'up'),
      ...islIntfRows,
      C('ref', '门限 C/N', 'thresholdCN', 'dB', 'up'),
      C('margin', '链路余量', 'linkmargin', 'dB', 'up')
    ], { id: 'cascade', cls: 'result' }));

    // ④ 性能与余量（星间，单列）——结论汇总。ISL 无雨衰：系统可用度 = 互视可见度
    segs.push(b._refSeg('性能与余量（星间）', [
      ['Eb/N₀', 'ebnoActualResult', 'dB'],
      ['Es/N₀', 'esnoActualResult', 'dB'],
      // 填了星间 C/I 时这个数已是 C/(N+I)，行名跟着口径走（没填时仍是那一行「星间 C/N」）
      [islCI !== null ? '星间 C/(N+I)' : '星间 C/N', 'islPerHopCNResult', 'dB'],
      ['门限 C/N', 'thresholdCN', 'dB'],
      ['链路余量', 'linkmargin', 'dB'],
      ['系统余量', 'marginResult', 'dB'],
      ['互视可见度', 'islVisibleFracResult', '%'],
      ['系统可用度', 'systemAvailabilityResult', '%'],
      ['年中断(分钟)', 'interruptionMinutes', 'min'],
      ['年中断(小时)', 'interruptionHours', 'h']
    ], { id: 'performance', cls: 'result' }));

    // ⑤ 资源占用（星间，单列）——星间无地面功放/带宽账，只列两端的收发能力
    segs.push(b._refSeg('资源占用（星间）', [
      ['发射卫星 EIRP', 'islRfEirpResult', 'dBW'],
      ['接收卫星 G/T', 'islRfGtResult', 'dB/K']
    ], { id: 'resources', cls: 'result' }));

    return b._number(segs);
  };

  // 再生式星间激光（MathWorks 简化功率链）瀑布：终端参数 → 星间几何 → 光学功率链级联 → 可用度（无雨=互视）。
  //   P_rx = P_tx + OE_tx + OE_rx + G_tx + G_rx − LP_tx − LP_rx − L_PS − L_other；余量 = P_rx − P_req。
  b.buildRegenLaser = function () {
    const r = results;
    if (r.linkmargin === undefined) return [];
    const segs = [];
    const manualGeo = String(r.islManualGeomResult || '') === '1';   // 手动几何：星间距离由用户逐条给定

    // ① 激光终端参数（链路级，单列）
    segs.push(b._refSeg('激光终端参数', [
      ['波长 λ', 'laserWavelengthResult', 'nm'],
      ['发射光功率 P_tx', 'laserTxPowerResult', 'dBm'],
      ['发射口径 D_tx', 'laserTxApertureResult', 'mm'],
      ['接收口径 D_rx', 'laserRxApertureResult', 'mm'],
      ['发射指向误差', 'laserPointErrTxResult', 'µrad'],
      ['接收指向误差', 'laserPointErrRxResult', 'µrad'],
      ['接收机灵敏度 P_req', 'laserPreqResult', 'dBm']
    ], { id: 'carrier', cls: 'param' }));

    // ② 星间几何（最差工况，单列）——双 SGP4 + 地球临边遮挡；手动几何同微波侧，只报用户给的那个距离
    segs.push(b._refSeg(manualGeo ? '星间距离（手动给定）' : '星间几何（最差工况）', [
      [manualGeo ? '星间链路距离' : '星间距离(最差)', 'laserDistResult', 'km'],
      ['发射卫星高度', 'islTxAltResult', 'km'],
      ['接收卫星高度', 'islRxAltResult', 'km'],
      ['地心夹角', 'islCentralAngleResult', '°'],
      ['LOS 掠地高度', 'islGrazAltResult', 'km'],
      ['单程时延', 'islDelayResult', 'ms'],
      ['最大距离变化率', 'islRangeRateResult', 'km/s'],
      ['相干多普勒 Δf', 'laserDopplerResult', 'GHz'],
      ['互视可见度', 'islVisibleFracResult', '%']
    ], { id: 'geometry', cls: 'param' }));

    // ③ 激光链路预算级联（MathWorks 简化，单列）：P_tx + OE + G − LP − L_PS = P_rx；− P_req = 余量
    const C = b._cRow;
    segs.push(b._cascadeSingleSeg('激光链路预算级联（MathWorks 简化）', [
      C('base', '发射光功率 P_tx', 'laserTxPowerResult', 'dBm', 'up'),
      C('loss', '发射光学效率损耗 OE_tx', 'laserOpticsLossTxResult', 'dB', 'up'),
      C('loss', '接收光学效率损耗 OE_rx', 'laserOpticsLossRxResult', 'dB', 'up'),
      C('gain', '发射望远镜增益 G_tx', 'laserGTxResult', 'dB', 'up'),
      C('gain', '接收望远镜增益 G_rx', 'laserGRxResult', 'dB', 'up'),
      C('loss', '发射指向损耗 LP_tx', 'laserPointLossTxResult', 'dB', 'up'),
      C('loss', '接收指向损耗 LP_rx', 'laserPointLossRxResult', 'dB', 'up'),
      C('loss', '自由空间损耗 L_PS', 'laserFslResult', 'dB', 'up'),
      C('loss', '其他损耗 L', 'laserOtherLossResult', 'dB', 'up'),
      C('chk', '接收光功率 P_rx', 'laserPrxResult', 'dBm', 'up'),
      C('ref', '所需接收功率 P_req', 'laserPreqResult', 'dBm', 'up'),
      C('margin', '链路余量', 'linkmargin', 'dB', 'up')
    ], { id: 'cascade', cls: 'result' }));

    // ④ 性能与余量（激光星间，单列）——结论汇总。激光走的是收光功率链，没有 C/N 与 Eb/N₀：
    // 判据是「收到的光功率 P_rx 比灵敏度 P_req 高多少」。无雨：系统可用度 = 互视可见度。
    segs.push(b._refSeg('性能与余量（激光星间）', [
      ['接收光功率 P_rx', 'laserPrxResult', 'dBm'],
      ['所需接收功率 P_req', 'laserPreqResult', 'dBm'],
      ['链路余量', 'linkmargin', 'dB'],
      ['互视可见度', 'islVisibleFracResult', '%'],
      ['系统可用度', 'systemAvailabilityResult', '%'],
      ['年中断(分钟)', 'interruptionMinutes', 'min'],
      ['年中断(小时)', 'interruptionHours', 'h']
    ], { id: 'performance', cls: 'result' }));

    return b._number(segs);
  };

  // ============ 端到端链路（多跳 / 混合转发）瀑布 ============
  // 读的是 utils/linkChain.js 的出参（linkType:'chain'）——它自带一份机读的正向电平递推台账
  // （results.ledger），这里只负责翻成三线表的行：一条从「发信站 EIRP」到「末段余量」的完整
  // 级联，段边界处插段结算行（段 C/(N+I)、门限、段余量）。
  // 与三窗一致的分工：左＝级联主表（role:'cascade'），右＝几何 / 逐段汇总 / 端到端汇总参考段。
  b.buildChain = function () {
    const r = results;
    if (!Array.isArray(r.ledger)) return [];
    const segs = [];
    const fmt = (v, n) => (v === null || v === undefined || !isFinite(v)) ? '' : ('' + (Math.round(v * Math.pow(10, n)) / Math.pow(10, n)));
    const sep = (lang === 'en') ? ': ' : '：';

    // —— 逐项分组的参考段（逐段体制 / 逐跳几何 / 逐颗透明星 / 逐段解调）——
    // 每项一个小标题行（k-shead），标题下的读数行只留短标签。行行重复「1·星间微波 」这种前缀会把
    // 标签挤到折行，一屏下来全是同一个前缀，反倒看不出分组——标题挑出来一行，表才读得动。
    const groupOf = (out, title, list, idPre) => {
      const rows = [];
      for (const [label, val, unit] of list) {
        if (val === '' || val === null || val === undefined) continue;
        rows.push({
          key: idPre + title + label, id: '#' + idPre + title + label, kind: 'ref', sign: '', label: b._t(label),
          up: '' + val, down: '', total: '', unit: b._t(unit) || '', unitKey: unit || '', cum: '',
          num: b._numStrict(val)
        });
      }
      if (!rows.length) return;
      out.push({
        key: idPre + title, id: '#' + idPre + title, kind: 'shead', sign: '', label: title,
        up: '', down: '', total: '', unit: '', unitKey: '', cum: '', num: null
      });
      out.push(...rows);
    };
    // 组标题里的「起点 → 终点」：节点名一个字不动（平台既定：用户自命名不翻）
    const endsOf = (o) => ((o.fromName || o.toName) ? sep + ((o.fromName || '') + ' → ' + (o.toName || '')) : '');

    // ① 载波与调制参数。再生节点解调-重调后可换体制，故这一段按【段】给：各段体制完全相同时
    // 仍收成一组（绝大多数链就是这样），只要有一段不同就逐段列开——否则表上只剩首段那一份，
    // 读者会拿它去对后面几段的门限。
    const CARR_ROWS = [
      ['载波带宽', 'allocBandwidthResult', 'kHz'],
      ['频谱效率', 'spectralEfficiencyResult', 'bit/s/Hz'],
      ['信息速率', 'infoRateResult', 'kbps'],
      ['载波速率', 'carrierRateResult', 'kbps'],
      ['符号速率', 'symbolRateResult', 'ksps'],
      ['调制方式', 'modulationResult', ''],
      ['FEC 码率', 'fecResult', ''],
      ['误码率', 'berResult', ''],
      ['门限 Eb/N₀', 'ebnoResult', 'dB'],
      ['门限 Es/N₀', 'esnoResult', 'dB'],
      ['载波噪声带宽', 'RXnoiseBW', 'dB-Hz'],
      ['门限 C/N', 'thresholdCN', 'dB']
    ];
    const carrs = Array.isArray(r.carriers) ? r.carriers : [];
    const sig = (c) => CARR_ROWS.map((t) => c[t[1]]).join('|');
    const oneCarrier = carrs.length <= 1 || carrs.every((c) => sig(c) === sig(carrs[0]));
    if (oneCarrier) {
      segs.push(b._refSeg('载波与调制参数', CARR_ROWS, { id: 'carrier', cls: 'param' }));
    } else {
      const cRows = [];
      carrs.forEach((c) => {
        groupOf(cRows, b._t('段') + ' ' + c.no + endsOf(c), CARR_ROWS.map((t) => [t[0], c[t[1]], t[2]]), 'carr');
      });
      segs.push(b._seg('载波与调制参数', 1, cRows, { id: 'carrier', cls: 'param' }));
    }

    // ② 端到端级联（正向电平递推，单列）——主角段
    // 台账行 kind 直接对应瀑布行 kind；三种标题行（段 / 跳 / 透明转发）另立 head/shead，
    // 排版在 lbworkbench.css 的 .lbx-doc .wf-row.k-head / .k-shead（带 .lbx-doc 前缀，不影响三窗）。
    const HEAD = { seghd: 'head', hophd: 'shead', txphd: 'shead', eshd: 'shead' };
    const rows = r.ledger.map((it) => {
      const hk = HEAD[it.kind];
      if (hk) {
        // 标题行＝「可译的类型词 + 用户自命名的节点名」：只译前半段，节点名一个字不动
        // （平台既定：用户自命名不翻）。故台账里 tag / name 分开存，此处才拼。
        const label = b._t(it.tag) + (it.no ? ' ' + it.no : '') + (it.name ? sep + it.name : '');
        return {
          key: label, id: '#' + label, kind: hk, sign: '', label,
          up: '', down: '', total: '', unit: '', unitKey: '', cum: '', num: null, _raw: null, _col: null
        };
      }
      // 算式行（base/gain/loss/sub/chk）交给 _cascadeSingleSeg 沿链累加，值必须保持全精度，
      // 显示由 _fmt 收成 2 位；非算式行（ref/margin）走 _disp 原样透传，故这里先按引擎口径
      // toFixed(2) 成串再写回——不收就会把 12.804620941514187 这种浮点尾巴印在表上。
      const calc = (it.kind === 'base' || it.kind === 'gain' || it.kind === 'loss' || it.kind === 'sub' || it.kind === 'chk');
      const v = (it.value === null || it.value === undefined || !isFinite(it.value)) ? null : it.value;
      const row = b._cRow(it.kind, it.label, v, it.unit || '', 'up');
      if (!calc && v !== null) { row.up = v.toFixed(2); row.num = b._numStrict(row.up); }
      return row;
    });
    const casc = b._cascadeSingleSeg('端到端链路级联（正向电平递推）', rows, { id: 'cascade', cls: 'result' });
    // 级联列数值统一定两位小数（0 → 0.00、60.7 → 60.70）：_fmt 全局是「最多两位、去尾零」
    //（四窗共用，不动），但本窗级联是单列密排，参差的小数尾会让右对齐的数值列只剩个位对齐、
    // 小数点排不成列。只在本构建器内把纯数值显示串收成定两位（QPSK / 3×10⁻⁷ 等非数值串原样），
    // 屏幕 / TSV / 报表同源生效。
    for (const row of casc.rows) {
      if (row.up && /^-?\d+(\.\d+)?$/.test(row.up)) { row.up = (+row.up).toFixed(2); row.num = b._numStrict(row.up); }
    }
    segs.push(casc);

    // ③ 逐跳几何与时延（单列，逐跳一组）
    // 传播分项也在这里逐条出：级联列把「大气 + 云 + 附加」并成了一行「其他传播衰减」，
    // 三个分项的数值不能因此丢掉（那是雨衰之外的全部常态损耗，报告要能逐条查）。
    const geoRows = [];
    const HOP_T = { up: '星地上行', down: '星地下行', isl: '星间微波', laser: '星间激光' };
    (r.hops || []).forEach((h, i) => {
      // 大气 / 雨 / 云只对星地跳有意义：星间是真空段，引擎那三个数恒为 0，摆出来是三行假账
      const air = (h.type === 'up' || h.type === 'down');
      groupOf(geoRows, (i + 1) + ' ' + b._t(HOP_T[h.type] || h.type) + endsOf(h), [
        ['频率', h.frequencyResult, 'GHz'],
        [air ? '星地距离' : '星间距离', h.distanceResult, 'km'],
        ['对卫星仰角', h.elevationResult, '°'],
        ['链路时延(单程·分段)', h.delayResult, 'ms'],
        ['自由空间损耗', h.fslResult, 'dB'],
        ['大气衰减 P.676', air ? h.atmResult : '', 'dB'],
        ['雨衰 P.618', air ? h.rainResult : '', 'dB'],
        ['云衰 P.840', air ? h.cloudResult : '', 'dB'],
        ['附加损耗', h.miscResult, 'dB'],
        ['本跳 C/N', h.cnResult, 'dB']
      ], 'geo');
    });
    segs.push(b._seg('逐跳几何与时延', 1, geoRows, { id: 'geometry', cls: 'param' }));

    // ③⁻ 收发链参数（单列，逐跳一组）——级联列只留算式行之后，被摘出去的设备参数在这里落地，
    // 一个数不丢：上行跳出发信站那四项，下行跳出收信站 G/T 的十项分解（增益 / 馈线 / 四路噪温 /
    // 系统噪温 K 与 dB）。星间微波与激光跳没有地面收发链，整组不出（groupOf 无行即不成组）。
    const rfRows = [];
    (r.hops || []).forEach((h, i) => {
      const title = (i + 1) + ' ' + b._t(HOP_T[h.type] || h.type) + endsOf(h);
      if (h.type === 'up') {
        groupOf(rfRows, title, [
          ['天线口径', h.txDiameterResult, 'm'],
          ['天线效率', h.txEffResult, '%'],
          ['功放输出功率(W)', h.paWResult, 'W'],
          // UPC 补偿为 0（没开上行功率控制）时不占一行——原级联列也是有值才摆
          ['UPC 补偿', b._num(h.upcMarginResult) ? h.upcMarginResult : '', 'dB']
        ], 'rfc');
      } else if (h.type === 'down') {
        groupOf(rfRows, title, [
          ['天线口径', h.rxDiameterResult, 'm'],
          ['天线效率', h.rxEffResult, '%'],
          ['接收天线增益', h.rxAntennaGainResult, 'dBi'],
          ['接收馈线损耗', h.rxFeederLossResult, 'dB'],
          ['天线噪声温度', h.antennaNoiseTempResult, 'K'],
          ['接收机噪声温度', h.receiverNoiseTempResult, 'K'],
          ['雨噪声温度', h.rainNoiseTempResult, 'K'],
          ['云噪声温度', h.cloudNoiseTempResult, 'K'],
          ['系统噪声温度', h.sysNoiseTempKResult, 'K'],
          ['系统噪声温度(dB)', h.sysNoiseTempDbResult, 'dBK']
        ], 'rfc');
      }
    });
    segs.push(b._seg('收发链参数', 1, rfRows, { id: 'rfchain', cls: 'param' }));

    // ③′ 透明转发器占用（单列，逐颗透明星一组行）——弯管星的资源账：
    // 这一条载波在该转发器上占了多少功率、多少带宽。功率占比由载波占转发器回退换算
    // （回退 0 dB 即吃满转发器输出功率），带宽占比 = 载波带宽 / 转发器带宽。
    const txpRows = [];
    (r.transponders || []).forEach((t, i) => {
      groupOf(txpRows, (i + 1) + ' ' + (t.name || ''), [
        ['转发器带宽', t.transponderBandwidthResult, 'MHz'],
        ['载波带宽', t.carrierBandwidthResult, 'kHz'],
        ['转发器带宽占比', t.bandwidthRatioResult, '%'],
        ['饱和通量密度 SFD', t.sfdsResult, 'dBW/m²'],
        ['转发器工作点通量密度', t.opPFDResult, 'dBW/m²'],
        ['到达通量密度', t.arrivalPFDResult, 'dBW/m²'],
        ['载波占转发器回退', t.capacityResult, 'dB'],
        ['转发器功率占比', t.powerRatioResult, '%'],
        ['每载波输出 EIRP', t.eirpPerCarrierResult, 'dBW'],
        ['可容纳同类载波数', t.maxCarrierCount, '']
      ], 'txp');
    });
    segs.push(b._seg('透明转发器占用', 1, txpRows, { id: 'transponder', cls: 'result' }));

    // ③″ 逐段解调结算（单列，逐段一组行）——收侧那台解调器的账：
    // 实际门限 = 体制的理论门限 + 该段收端的解调实现损失；设计 BER 是这一段按门限工作时的误码率，
    // 各段独立解调、误码不可恢复，故端到端按各段之和（见 §端到端汇总的「端到端 BER」）。
    // 纯激光段没有 C/N 也就没有门限：判据是「收到的光功率比所需接收功率高多少」，
    // 实现损失照样抬高所需接收功率（P_req + 实现损失 = 实际所需接收功率）。
    const demRows = [];
    (r.segments || []).forEach((sg) => {
      groupOf(demRows, b._t('段') + ' ' + sg.no + endsOf(sg), sg.laser ? [
        ['所需接收功率 P_req', sg.preqResult, 'dBm'],
        ['解调实现损失', sg.demodLossResult, 'dB'],
        ['实际所需接收功率', sg.preqEffResult, 'dBm'],
        ['接收光功率 P_rx', sg.prxResult, 'dBm'],
        ['设计 BER', sg.berResult, ''],
        ['段余量', sg.marginResult, 'dB']
      ] : [
        ['门限 C/N', sg.thresholdCN, 'dB'],
        ['解调实现损失', sg.demodLossResult, 'dB'],
        ['实际解调门限', sg.thresholdEffResult, 'dB'],
        ['设计 BER', sg.berResult, ''],
        ['段余量', sg.marginResult, 'dB']
      ], 'dem');
    });
    segs.push(b._seg('逐段解调结算', 1, demRows, { id: 'demod', cls: 'result' }));

    // ④ 逐段汇总（双列：段 C/(N+I) / 段余量）
    const segRows = (r.segments || []).map((sg) => ({
      key: 'seg' + sg.no, id: '#seg' + sg.no, kind: 'ref', sign: '',
      label: `${b._t('段')} ${sg.no}　${sg.fromName} → ${sg.toName}`,
      up: sg.cnResult, down: sg.marginResult, total: '', unit: 'dB', unitKey: 'dB', cum: '',
      num: b._numStrict(sg.cnResult), numDown: b._numStrict(sg.marginResult)
    }));
    const segSeg = b._seg('逐段汇总', 2, segRows, { id: 'segments', cls: 'result' });
    segSeg.heads = [b._t('C/(N+I)'), b._t('段余量')];
    segs.push(segSeg);

    // ⑤ 端到端汇总（单列）
    segs.push(b._refSeg('端到端汇总', [
      ['节点数', r.nodeCount, '', true],
      ['跳数', r.hopCount, '', true],
      ['段数', r.segmentCount, '', true],
      ['最弱段', r.weakestSegment, '', true],
      ['门限 C/N', 'thresholdCN', 'dB'],
      ['端到端余量', 'e2eMarginResult', 'dB'],
      ['系统可用度', 'systemAvailabilityResult', '%'],
      ['年中断(分钟)', 'interruptionMinutes', 'min'],
      ['年中断(小时)', 'interruptionHours', 'h'],
      ['端到端 BER', 'e2eBerResult', ''],
      ['传播时延合计', 'propDelayResult', 'ms'],
      ['处理时延合计', 'procDelayResult', 'ms'],
      ['端到端时延', 'e2eDelayResult', 'ms'],
      ['链路时延(往返 RTT)', (parseFloat(r.e2eDelayResult) > 0) ? fmt(parseFloat(r.e2eDelayResult) * 2, 3) : null, 'ms', true]
    ], { id: 'performance', cls: 'result' }));

    return b._number(segs);
  };

  return b;
}

// 构建链路瀑布 segments（路由：按轨道/体制类型分派到 GEO / NGSO / 再生式 / 端到端 专属构建器）。
// 出口统一过显示单位自适应（W→mW、kHz→MHz、独立行 dBW→dBm 等；级联算式行不动），
// UI 瀑布 / TSV 复制 / Excel 详表同源同口径。
function buildWaterfallSegments(ctx) {
  const builder = createBuilder(ctx || {});
  let segs;
  if (ctx && ctx.orbitType === 'E2E') segs = builder.buildChain();
  else if (ctx && ctx.orbitType === 'REGEN') segs = builder.buildRegen();
  else segs = (ctx && ctx.orbitType === 'NGSO') ? builder.buildNGSO() : builder.buildGEO();
  return adaptiveUnits.adaptSegments(segs);
}

// 链路总览关键指标（多链路专业版报告首页对比表用）：值为引擎展示字符串，单位由报告端补
function buildLinkSummary(results, meta) {
  const r = results || {};
  const m = meta || {};
  const d = (v) => (v === undefined || v === null || v === '' || v === '-') ? '—' : ('' + v);
  // NGSO 含 ISL 时，上行侧口径取「上行 C/N（含 ISL）」，与级联表合成行一致
  const hasIsl = parseFloat(r.islHopsResult) > 0;
  const upCN = (hasIsl && r.uplinkWithIslCN !== undefined) ? r.uplinkWithIslCN : r.uplinkCN;
  return {
    satellite: d(m.satelliteName),
    orbit: d(m.orbitLabel),
    band: d(m.frequencyBand),
    infoRate: d(r.infoRateResult),
    modulation: d(r.modulationResult),
    fec: d(r.fecResult),
    carrierBW: d(r.allocBandwidthResult),
    powerBW: d(r.PowerBWResult),
    upCN: d(upCN),
    downCN: d(r.downlinkCN),
    totalCN: d(r.carrierTotalCN),
    thresholdCN: d(r.thresholdCN),
    linkMargin: d(r.linkmargin),
    availability: d(r.systemAvailabilityResult),
    bwUsage: d(r.bandwidthUsageRatio),
    pwrUsage: d(r.powerUsageRatio),
    paPower: d(r.paRecommendation),
    paPowerDb: d(r.paRecommendationdBResult)
  };
}

module.exports = {
  WF_DICT,
  buildWaterfallSegments,
  buildLinkSummary
};
