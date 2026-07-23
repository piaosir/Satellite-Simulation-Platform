// 再生式链路预算（v1：再生式上行）参数 schema。
// 由 NGSO 参数集裁剪而来（见 ../ngso/ngsoParams.js）：
//   · 删除「收信站群」整组（星上再生解调，无弯管收信站）；
//   · 卫星改为「卫星群」——像载波信号库一样多份配置，发信站按「卫星」列各自选用一份；
//     卫星配置为纯参数表单（手动轨道高度+倾角，v1 不含 SGP4 选星），删除
//     SFD / G/Tref / IBO / OBO / 转发器带宽 及全部下行/转发器项；
//   · 全部干扰项删除；其中「上行干扰项」(C/ACI · C/ASI · C/XPI · HPA C/IM) 移入发信站列表逐站配置。
//   · 卫星 G/T 从卫星移到发信站——G/T 随波束位置随站而异，是「卫星×发信站」配对量，由各发信站手填（见 uplink 组 G_Ts）。
// 默认值 = MEO Ku 预设（2026-07 起，替换原「GEO Ku 弯管大站」失真口径——那套全默认会跑出 C/N≈58 dB）：
//   轨道 8000 km/45°；卫星点波束 G/T 10 dB/K；再生上/下行地面端统一 2.4 m 用户站（工作点 EIRP 42 dBW
//   ≈0.2W 功放@2.4m）；下行「卫星EIRP」25 dBW 为**该载波**的下行 EIRP（再生直发口径，非整波束饱和值）。
//   只影响新建配置初始值；已保存配置不受影响。
// 每个字段 target：'sat'→satParams，'link'→linkParams，'meta'→仅 UI（载波信号/卫星 id，不进引擎）。

import { defaultsFor } from '../ngso/ngsoParams.js'
import { halfStr, pf } from '../shared/num.js'   // 全角减号/数字归一到半角，避免负数（经纬度/EIRP/SFDref 等）被引擎 Number()/parseFloat() 吞掉
// 数值字段（type:'num'）先归一全角→半角再入参；文本/select 原样（勿改站名等）
const putNum = (obj, f, v) => { obj[f.key] = f.type === 'num' ? halfStr(v) : v }

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
      { key: 'orbitAltitude', label: '轨道高度', tip: '圆轨道高度；选星（搜索/天线树）后由所选卫星轨道自动确定', unit: 'km', type: 'num', def: '8000', target: 'link', pair: 'orbit' },
      { key: 'orbitInclination', label: '轨道倾角', tip: '轨道倾角；选星后由所选卫星轨道根数自动确定', unit: '°', type: 'num', def: '45', target: 'sat', pair: 'orbit' }
    ]
  },
  {
    // 地球站库：每份配置 = 一种站型的收发射频参数（side:'common' 收发共用 / side:'tx' 发射链 / side:'rx' 接收链），
    // 再生式的逐站干扰项（intf:true）随站型走：C/ACI·C/ASI·C/XPI·C/IM 本质由站的天线旁瓣/极化性能
    // 与所处干扰环境决定，同一站型可复用。target:'sat' 的干扰字段组装时送 satParams（与旧站表口径一致）。
    // 一份配置 = 一座站 = 一面天线：口径收发共用（rxKey 标注收侧引擎键名），效率随收发频段分设。
    // 站表（发/收信站群）只留站址信息 + 「地球站配置」选择列。
    key: 'station', title: '地球站', icon: 'dish',
    fields: [
      { key: 'antennaDiameter', rxKey: 'rxAntennaDiameter', label: '天线口径', tip: '收发共用同一面天线：口径一致（天线效率按收发频段分设）。MEO 预设 2.4 m：用户/物联站典型口径（关口站另配 4.5~7.3 m 并相应上调工作点）', side: 'common', unit: 'm', type: 'num', def: '2.4', target: 'link' },
      { key: 'antennaEfficiency', label: '天线效率', side: 'tx', unit: '%', type: 'num', def: '65', target: 'link' },
      { key: 'paBackoff', label: '功放回退', side: 'tx', unit: 'dB', type: 'num', def: '0', target: 'link' },
      { key: 'feederLoss', label: '馈线损耗', tip: 'MEO 预设 0.5 dB：2.4 m 用户站短馈线（大关口站长波导才是 3 dB 量级）', side: 'tx', unit: 'dB', type: 'num', def: '0.5', target: 'link' },
      { key: 'uplinkPowerControl', label: 'UPC', tip: '上行功率控制 (Uplink Power Control)', side: 'tx', type: 'select', options: ['否', '是', '自定义'], def: '否', target: 'link' },
      { key: 'upcValue', label: 'UPC值', tip: '仅「UPC = 自定义」时生效', side: 'tx', unit: 'dB', type: 'num', def: '0', target: 'link' },
      { key: 'uplinkOtherLoss', label: '综合损耗', tip: '综合损耗：指向/极化/天线罩/接头等未单列损耗之综合', side: 'tx', unit: 'dB', type: 'num', def: '0.3', target: 'link' },
      // —— 工作点（再生上行的功放与余量，随站型入库；target:'op' 不进 linkParams，由 App 按模式送引擎）——
      //   设置功放：给定功放功率(W) → 引擎 power 模式算上行余量；
      //   设置余量：给定系统余量(dB) → 引擎 margin 模式反解所需功放（结果见「功放功率」指标）。
      //   showIf 按模式只显示对应数值框（EarthStationPanel 通用支持）。
      { key: 'opCalcMode', label: '工作点', tip: '设置功放 = 给定功放功率算上行余量；设置余量 = 给定目标余量反解所需功放（功放建议见结果）', side: 'tx', type: 'select', options: ['设置功放', '设置余量'], def: '设置功放', target: 'op' },
      { key: 'opPowerW', label: '功放功率', tip: '功放输出功率（W）；MEO 预设 0.2 W ≈ 2.4 m 站工作点 EIRP 42 dBW（馈线 0.5 dB）。仅「工作点 = 设置功放」时生效', side: 'tx', unit: 'W', type: 'num', def: '0.2', target: 'op', showIf: (f) => f.opCalcMode !== '设置余量' },
      { key: 'opMargin', label: '系统余量', tip: '目标上行链路余量（dB）；仅「工作点 = 设置余量」时生效，引擎按之反解所需功放', side: 'tx', unit: 'dB', type: 'num', def: '3.00', target: 'op', showIf: (f) => f.opCalcMode === '设置余量' },
      // 上行干扰四项（原逐发信站列，现随站型入库；target:'sat' → 送 satParams）
      { key: 'aciUplinkFactor', label: '上行C/ACI', tip: '上行载波/邻道干扰比 (Adjacent Channel Interference)', side: 'tx', unit: 'dB', type: 'num', def: '30', target: 'sat', intf: true },
      { key: 'adjUplinkFactor', label: '上行C/ASI', tip: '上行载波/邻星干扰比 (Adjacent Satellite Interference)', side: 'tx', unit: 'dB', type: 'num', def: '25', target: 'sat', intf: true },
      { key: 'xpolUplinkFactor', label: '上行C/XPI', tip: '上行载波/交叉极化干扰比 (Cross-Polarization Interference)', side: 'tx', unit: 'dB', type: 'num', def: '26', target: 'sat', intf: true },
      { key: 'hpaIntermodFactor', label: 'HPA C/IM', tip: '高功放载波/互调比 (HPA Intermodulation)', side: 'tx', unit: 'dB', type: 'num', def: '24', target: 'sat', intf: true },
      // —— 接收链（工作点 G/T 的构成量）：天线（口径共用公共字段）+ 噪温 + 馈线 → 引擎按 gOverTe = 天线增益 − 系统噪温dB − 馈线损耗 算 G/T（含精确雨致 G/T 劣化）——
      { key: 'rxAntennaEfficiency', label: '天线效率', side: 'rx', unit: '%', type: 'num', def: '65', target: 'link' },
      { key: 'rxAntennaNoiseTempMode', label: '天线噪温模式', tip: '自动 = 按 ITU-R P.618-14 §3 由晴空大气衰减与链路仰角实时求取天空噪温（+25 K 地面拾取常数；NGSO §8 口径下随等效仰角变化），忽略「天线噪温」手填值；自定义 = 用「天线噪温」数值。', side: 'rx', type: 'select', options: ['自动', '自定义'], def: '自动', target: 'link' },
      { key: 'rxAntennaNoiseTemp', label: '天线噪温', tip: '天线噪声温度（K）；仅「天线噪温模式 = 自定义」时生效', side: 'rx', unit: 'K', type: 'num', def: '35', target: 'link' },
      { key: 'rxReceiverNoiseTemp', label: '接收机噪温', side: 'rx', unit: 'K', type: 'num', def: '75', target: 'link' },
      { key: 'rxFeederLoss', label: '馈线损耗', side: 'rx', unit: 'dB', type: 'num', def: '0.2', target: 'link' },
      { key: 'downlinkOtherLoss', label: '综合损耗', tip: '综合损耗：指向/极化/天线罩/接头等未单列损耗之综合', side: 'rx', unit: 'dB', type: 'num', def: '0.3', target: 'link' },
      // 下行干扰四项（原逐收信站列，现随站型入库；target:'sat' → 送 satParams）
      { key: 'aciDownlinkFactor', label: '下行C/ACI', tip: '下行载波/邻道干扰比 (Adjacent Channel Interference)', side: 'rx', unit: 'dB', type: 'num', def: '30', target: 'sat', intf: true },
      { key: 'adjDownlinkFactor', label: '下行C/ASI', tip: '下行载波/邻星干扰比 (Adjacent Satellite Interference)', side: 'rx', unit: 'dB', type: 'num', def: '25', target: 'sat', intf: true },
      { key: 'xpolDownlinkFactor', label: '下行C/XPI', tip: '下行载波/交叉极化干扰比 (Cross-Polarization Interference)', side: 'rx', unit: 'dB', type: 'num', def: '26', target: 'sat', intf: true },
      { key: 'xpdrIntermodFactor', label: '下行C/IM', tip: '卫星下行载波/互调比 (Intermodulation)', side: 'rx', unit: 'dB', type: 'num', def: '21', target: 'sat', intf: true }
    ]
  },
  {
    // 发信站群：站址列 + 「载波信号 / 地球站配置 / 卫星」三个选择列 + 工作点 + 卫星G/T（逐站手填）。
    // 发射链射频参数（天线/功放/馈线/UPC/干扰）由所选「地球站配置」提供（见 station 组）。
    key: 'uplink', title: '发信站群', icon: 'up',
    fields: [
      // 冻结列（frozen:true）：载波信号配置 · 地球站配置 · 地球站位置 · 卫星 四列固定不随横向滚动。
      { key: 'basebandId', label: '载波信号配置', type: 'select', options: [], def: '', target: 'meta', frozen: true },
      { key: 'stationId', label: '地球站配置', type: 'select', options: [], def: '', target: 'meta', frozen: true },
      { key: 'earthStationLocation', label: '地球站位置', type: 'text', def: '北京', target: 'link', city: 'tx', frozen: true },
      { key: 'satelliteId', label: '卫星', type: 'select', options: [], def: '', target: 'meta', frozen: true },
      { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'minElevation', label: '最低仰角', tip: '发信站对卫星的最低工作仰角，决定最差几何（斜距最大）', unit: '°', type: 'num', def: '10', target: 'link' },
      { key: 'altitude', label: '海拔', unit: 'm', type: 'num', def: '0', target: 'link', auto: 'elev' },
      // 工作点（功放/余量）已随站型移入「地球站配置」发射参数（opCalcMode/opPowerW/opMargin，见 station 组）
      { key: 'rainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '0', target: 'link', auto: 'rain' },
      { key: 'uplinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' },
      // 卫星 G/T（再生式逐发信站取值）：同一颗星服务不同站因波束位置不同而 G/T 各异——「卫星×发信站」
      // 配对量，故留在站表逐站手填（不入地球站库）。
      { key: 'G_Ts', label: '卫星G/T', tip: '卫星接收品质因数 G/T（dB/K），按本站对该卫星的波束位置手动输入。MEO 预设 10 dB/K（MEO Ku 点波束量级）。', unit: 'dB/K', type: 'num', def: '10', target: 'link' }
    ]
  },
  {
    // 收信站群（再生式下行）：站址列 + 三个选择列 + 卫星EIRP（逐站手填）。
    // 接收链射频参数（天线/噪温/馈线/干扰）由所选「地球站配置」提供，工作点 G/T 由其按引擎口径算出
    // （不再支持「直接输入设备 G/T」——设备 G/T 系统噪温未知，无法自洽推出雨致 G/T 劣化）。
    key: 'downlink', title: '收信站群', icon: 'down',
    fields: [
      { key: 'basebandId', label: '载波信号配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'stationId', label: '地球站配置', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'satelliteId', label: '卫星', type: 'select', options: [], def: '', target: 'meta' },
      { key: 'rxEarthStationLocation', label: '地球站位置', type: 'text', def: '北京', target: 'link', city: 'rx' },
      { key: 'rxLongitude', label: '经度', unit: '°E', type: 'num', def: '116.4074', target: 'link' },
      { key: 'rxLatitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042', target: 'link' },
      { key: 'rxMinElevation', label: '最低仰角', tip: '收信站对卫星的最低工作仰角，决定最差几何（斜距最大）', unit: '°', type: 'num', def: '10', target: 'link' },
      { key: 'rxAltitude', label: '海拔', unit: 'm', type: 'num', def: '0', target: 'link', auto: 'elev' },
      { key: 'rxRainRate', label: 'R0.01%', unit: 'mm/h', type: 'num', def: '0', target: 'link', auto: 'rain' },
      { key: 'rxDownlinkAvailability', label: '可用度', unit: '%', type: 'num', def: '99.90', target: 'link' },
      // 卫星下行 EIRP（再生式逐收信站取值）：同一颗星服务不同站因波束位置不同而 EIRP 各异——
      // 「卫星×收信站」配对量，故留在站表逐站手填。
      { key: 'rxEIRP', label: '卫星EIRP', tip: '该载波的卫星下行 EIRP（dBW，再生直发口径），按本站对该卫星的波束位置手动输入。MEO 预设 25 dBW（2 Mbps 级载波量级；整波束饱和值填此处会把 C/N 推到 50+ dB 的不物理区）。', unit: 'dBW', type: 'num', def: '25', target: 'link' }
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
  },
  {
    // 星间激光链路群（简化版，按 MathWorks Satcom Toolbox 官方光学 ISL 示例重构）：发射卫星 → 接收卫星，两星均选自「卫星群」。
    //   接收光功率  P_rx[dBm] = P_tx + OE_tx + OE_rx + G_tx + G_rx − LP_tx − LP_rx − L_PS − L_other
    //     望远镜增益 G  = 10·lg((π·D/λ)²)；光学效率 OE = 10·lg(η)；指向损耗 LP = 4.3429·(π·D/λ)²·θ²（θ=rad）；
    //     自由空间损耗 L_PS = 20·lg(4π·d/λ)（d = 几何最差星间距离，真空段无大气/雨/云）。
    //   链路余量 LM = P_rx − P_req（P_req = 接收机灵敏度/所需接收功率，用户输入）。
    //   软件只套用上式，各输入值由用户给定；不做 C/N₀·Eb/N₀·光子/bit·指向抖动衰落等派生。
    //   几何复用 solveIslWorstCase（双 SGP4 + 地球临边遮挡）；可用度 = 几何互视占比（空间对空间无雨）。
    //   除 meta（选星）与 geom（大气余量，仅喂几何）外，所有字段扁平进 laserParams 交光学引擎。
    //   依据：https://www.mathworks.com/help/satcom/ug/optical_satellite_communication_link_budget_analysis.html
    key: 'laser', title: '星间激光链路群', icon: 'laser',
    fields: [
      { key: 'txSatelliteId', label: '发射卫星', type: 'select', options: [], def: '', target: 'meta', frozen: true },
      { key: 'rxSatelliteId', label: '接收卫星', type: 'select', options: [], def: '', target: 'meta', frozen: true },
      // —— MathWorks 功率链输入项（软件只套公式，值由用户给定）——
      { key: 'txPowerDbm', label: '发射光功率 P_tx', tip: '发射光功率 P_tx（dBm；30=1W、33=2W、36=4W）', unit: 'dBm', type: 'num', def: '30', target: 'laser' },
      { key: 'wavelengthNm', label: '波长 λ', tip: '工作波长 λ（nm）；决定望远镜增益与自由空间损耗', unit: 'nm', type: 'num', def: '1550', target: 'laser' },
      { key: 'txApertureMm', label: '发射口径 D_tx', tip: '发射望远镜口径 D_tx（mm）；增益 G_tx = 10·lg((π·D/λ)²)', unit: 'mm', type: 'num', def: '80', target: 'laser' },
      { key: 'rxApertureMm', label: '接收口径 D_rx', tip: '接收望远镜口径 D_rx（mm）；增益 G_rx = 10·lg((π·D/λ)²)', unit: 'mm', type: 'num', def: '80', target: 'laser' },
      { key: 'txOpticsEff', label: '发射光学效率 η_tx', tip: '发射光学效率 η_tx ∈ (0,1]；OE_tx = 10·lg(η)。MathWorks 缺省 0.8（=−0.97dB）', unit: '', type: 'num', def: '0.8', target: 'laser' },
      { key: 'rxOpticsEff', label: '接收光学效率 η_rx', tip: '接收光学效率 η_rx ∈ (0,1]；OE_rx = 10·lg(η)。MathWorks 缺省 0.8', unit: '', type: 'num', def: '0.8', target: 'laser' },
      { key: 'txPointingErrUrad', label: '发射指向误差', tip: '发射静态指向误差 θ（µrad）；指向损耗 LP_tx = 4.3429·(π·D/λ)²·θ²。MathWorks 缺省 1µrad', unit: 'µrad', type: 'num', def: '1', target: 'laser' },
      { key: 'rxPointingErrUrad', label: '接收指向误差', tip: '接收静态指向误差 θ（µrad）；指向损耗 LP_rx = 4.3429·(π·D/λ)²·θ²', unit: 'µrad', type: 'num', def: '1', target: 'laser' },
      { key: 'rxSensitivityDbm', label: '接收机灵敏度 P_req', tip: '所需接收功率 P_req（dBm）；链路余量 = P_rx − P_req。MathWorks 示例：−35.5dBm@10Gbps OOK BER 1e-12', unit: 'dBm', type: 'num', def: '-35.5', target: 'laser' },
      { key: 'otherLossDb', label: '其他损耗 L', tip: '附加/未细分损耗 L（dB，正值，可选；截图公式末的 −L 项）', unit: 'dB', type: 'num', def: '0', target: 'laser' },
      // —— 几何（仅喂几何求解，不进功率链）——
      { key: 'islAtmMargin', label: '大气余量', tip: 'LOS 视线须高出地表的余量（km）：激光光路须清过大气（湍流/吸收）；0=纯几何视线（仅避开固体地球）。仅喂几何求解，判两星互视遮挡', unit: 'km', type: 'num', def: '100', target: 'geom' }
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
export const LASER_FIELDS = _grp('laser')
export const ES_FIELDS = _grp('station')  // 地球站库：一份配置的全部收发射频字段
export const ES_COMMON_FIELDS = ES_FIELDS.filter((f) => f.side === 'common')   // 收发共用（天线口径；rxKey=收侧引擎键）
export const ES_TX_FIELDS = ES_FIELDS.filter((f) => f.side === 'tx')   // 发射链（发信站引用，含工作点 target:'op'）
export const ES_RX_FIELDS = ES_FIELDS.filter((f) => f.side === 'rx')   // 接收链（收信站引用）

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

// 组装单条再生式上行链路的 { satParams, linkParams }：某颗卫星(satForm) + 某份载波信号(carrierForm)
// + 某发信站(txStation) + 该站所选地球站配置(esForm，发射链射频参数；缺省用库默认值)。
export function buildRegenParams(satForm, carrierForm, txStation, esForm) {
  if (!esForm) esForm = { ...defaultsFor(ES_COMMON_FIELDS), ...defaultsFor(ES_TX_FIELDS) }
  const satParams = {}
  const linkParams = {}
  // 卫星群字段按 target 分流
  for (const f of SAT_FIELDS) putNum(f.target === 'link' ? linkParams : satParams, f, satForm[f.key])
  // 载波
  for (const f of CARRIER_FIELDS) putNum(linkParams, f, carrierForm[f.key])
  // 地球站配置：公共（天线口径）+ 发射链（效率/功放/馈线/UPC）→ linkParams；上行干扰(target:'sat') → satParams；
  // 工作点(target:'op'，opCalcMode/opPowerW/opMargin) 不进引擎——App 按模式换成 power/margin 计算方式
  for (const f of ES_COMMON_FIELDS) putNum(linkParams, f, esForm[f.key])
  for (const f of ES_TX_FIELDS) {
    if (f.target === 'op') continue
    putNum(f.target === 'sat' ? satParams : linkParams, f, esForm[f.key])
  }
  // 发信站：站址等 uplink 链路字段 → linkParams；
  // meta(载波信号/地球站配置/卫星 id) 与 op(工作点) 不进引擎（工作点由 UI 换算成功放 W 后走 power 模式）
  for (const f of TX_FIELDS) {
    if (f.target === 'meta' || f.target === 'op') continue
    putNum(f.target === 'sat' ? satParams : linkParams, f, txStation[f.key])
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
// 频率取该发信站所选卫星的上行中心频率；station 参数传该站所选「地球站配置」表单
// （antennaDiameter/antennaEfficiency/feederLoss/paBackoff 均已移入地球站库）。
const _C_LIGHT = 0.299792458   // GHz·m（λ = c/f）
export function txAntennaGainDbi(diameterM, effPct, freqGHz) {
  const D = pf(diameterM); const eff = pf(effPct); const f = pf(freqGHz)
  if (!(D > 0) || !(eff > 0) || !(f > 0)) return NaN
  const lambda = _C_LIGHT / f
  return 20 * Math.log10(Math.PI * D / lambda) + 10 * Math.log10(eff / 100)
}
// 工作点EIRP(dBW) → 功放大小(W)。station 提供 antennaDiameter/antennaEfficiency/feederLoss/paBackoff，satForm 提供 centerFrequency。
export function eirpToPowerW(eirpDbw, station, satForm) {
  const eirp = pf(eirpDbw); if (isNaN(eirp)) return NaN
  const g = txAntennaGainDbi(station.antennaDiameter, station.antennaEfficiency, satForm.centerFrequency)
  const feeder = pf(station.feederLoss) || 0
  const backoff = pf(station.paBackoff) || 0
  if (isNaN(g)) return NaN
  const paDbw = (eirp - g + feeder) + backoff       // 功放建议功率(dBW)
  return Math.pow(10, paDbw / 10)
}
// 功放大小(W) → 工作点EIRP(dBW)
export function powerWToEirp(powerW, station, satForm) {
  const w = pf(powerW); if (!(w > 0)) return NaN
  const g = txAntennaGainDbi(station.antennaDiameter, station.antennaEfficiency, satForm.centerFrequency)
  const feeder = pf(station.feederLoss) || 0
  const backoff = pf(station.paBackoff) || 0
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
  paBackoff: '0', feederLoss: '3.5', uplinkOtherLoss: '0.3'
}

// 组装单条再生式下行链路的 { satParams, linkParams }：某颗卫星(satForm) + 某份载波信号(carrierForm)
// + 某收信站(rxStation) + 该站所选地球站配置(esForm，接收链射频参数；缺省用库默认值)。
// 收信站 G/T 由配置的天线/噪温/馈线走引擎原生 gOverTe（含精确雨致 G/T 劣化）；卫星下行 EIRP(rxEIRP,target:'link') 直发（再生无转发器回退）。
export function buildRegenDownlinkParams(satForm, carrierForm, rxStation, esForm) {
  if (!esForm) esForm = { ...defaultsFor(ES_COMMON_FIELDS), ...defaultsFor(ES_RX_FIELDS) }
  const satParams = {}
  const linkParams = {}
  // 卫星群字段按 target 分流（含上/下行频率极化、轨道）
  for (const f of SAT_FIELDS) putNum(f.target === 'link' ? linkParams : satParams, f, satForm[f.key])
  // 载波
  for (const f of CARRIER_FIELDS) putNum(linkParams, f, carrierForm[f.key])
  // 地球站配置：公共（天线口径 → 收侧引擎键 rxKey）+ 接收链（效率/噪温/馈线）→ linkParams；下行干扰(target:'sat') → satParams
  for (const f of ES_COMMON_FIELDS) if (f.rxKey) putNum(linkParams, { ...f, key: f.rxKey }, esForm[f.key])
  for (const f of ES_RX_FIELDS) {
    if (f.target === 'op') continue
    putNum(f.target === 'sat' ? satParams : linkParams, f, esForm[f.key])
  }
  // 收信站：站址等下行链路字段 → linkParams；meta 不进引擎
  for (const f of RX_FIELDS) {
    if (f.target === 'meta' || f.target === 'op') continue
    putNum(f.target === 'sat' ? satParams : linkParams, f, rxStation[f.key])
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

// —— 收信站工作点换算：G/T ⇄ 噪温模式（与引擎 gOverTe 同口径，下行频率取该站所选卫星的下行频率；
//    station 参数传该站所选「地球站配置」表单——接收链天线/噪温/馈线字段均已移入地球站库）——
// 下行接收天线增益（dBi）
export function rxAntennaGainDbi(diameterM, effPct, freqGHz) {
  const D = pf(diameterM); const eff = pf(effPct); const f = pf(freqGHz)
  if (!(D > 0) || !(eff > 0) || !(f > 0)) return NaN
  const lambda = _C_LIGHT / f
  return 20 * Math.log10(Math.PI * D / lambda) + 10 * Math.log10(eff / 100)
}
// 接收系统等效噪声温度 → dBK（与引擎 systemNoiseTempK 同口径：含馈线损耗噪声贡献）
export function rxSystemNoiseTempDb(antTempK, rxTempK, feederLossDb) {
  const at = pf(antTempK); const rt = pf(rxTempK); const fl = pf(feederLossDb) || 0
  if (isNaN(at) || isNaN(rt)) return NaN
  const fLin = Math.pow(10, fl / 10)
  const Tsys = at / fLin + 290 * (1 - 1 / fLin) + rt
  return Tsys > 0 ? 10 * Math.log10(Tsys) : NaN
}
// 噪温模式 → 设备 G/T（dB/K）：G/T = 天线增益 − 系统噪温dB − 馈线损耗（严格对齐引擎 gOverTe）。
// 收信站群「收信站 G/T」只读列的实时预览取值即由此算得。
// 口径取公共字段 antennaDiameter（收发共用一面天线）；旧调用兜底读 rxAntennaDiameter。
export function rxGtFromNoise(station, satForm) {
  const dia = (station.antennaDiameter !== undefined && station.antennaDiameter !== '') ? station.antennaDiameter : station.rxAntennaDiameter
  const g = rxAntennaGainDbi(dia, station.rxAntennaEfficiency, satForm && satForm.rxCenterFrequency)
  const tdb = rxSystemNoiseTempDb(station.rxAntennaNoiseTemp, station.rxReceiverNoiseTemp, station.rxFeederLoss)
  const fl = pf(station.rxFeederLoss) || 0
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
  for (const f of CARRIER_FIELDS) putNum(linkParams, f, carrierForm[f.key])
  // ISL 四项（target:'sat'）；islAtmMargin(target:'geom') 只喂几何，不进引擎
  for (const f of ISL_FIELDS) if (f.target === 'sat') putNum(satParams, f, islLink[f.key])
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

// ==================== 再生式星间激光链路（相干 DP-QPSK）====================
// 组装单条激光星间链路的扁平入参 laserParams（交自研光学引擎 computeRegenLaserIslMode）。
// 与微波 ISL 不同：不复用 NGSO RF 引擎，无 satParams/linkParams 之分——所有光学/调制/指向字段扁平入参。
// 星间激光无速率/带宽概念，灵敏度直接由接收机灵敏度 P_req(dBm) 给定（不挂 RF 载波信号库）。
// islHopDistance（几何最差距离）由主计算按几何求解后注入。
export function buildRegenLaserParams(txSatForm, laserLink) {
  const lp = {}
  // 激光字段：除 meta（选星）与 geom（大气余量，仅喂几何）外全部扁平入参（P_tx/口径/光学效率/指向误差/灵敏度 P_req 等）
  for (const f of LASER_FIELDS) {
    if (f.target === 'meta' || f.target === 'geom') continue
    putNum(lp, f, laserLink[f.key])
  }
  // 发射卫星标注（仅展示）
  if (txSatForm) lp.satelliteName = txSatForm.satelliteName
  return JSON.parse(JSON.stringify(lp))
}
