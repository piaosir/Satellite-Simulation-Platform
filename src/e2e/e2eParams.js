// 端到端链路（多跳 / 混合转发）参数 schema。
//
// 与三窗的关系：
//   · 载波体制库 / 地球站库 / 卫星库三库照旧（本窗口自己的命名空间 'e2e'），字段集按本窗口需要裁剪；
//   · 载波库【没有「计算方式」栏】——端到端只有正向电平递推一种算法（见 utils/linkChain.js 文件头），
//     多跳下反算欠定，选择器本身就是错的；
//   · 卫星库一份条目同时带「透明转发器组」与「再生组」，节点是透明还是再生由链上的节点类型定
//     （链路条右键可切换），检查器只显示对应那组；行内可覆盖。
//   · 几何全部手填：星地 hop 给斜距 km + 仰角°，星间 hop 给星间距离 km。留空即报错，不按轨道高度兜底。
//
// 每个字段 target：'sat'/'link' 只用于三窗的引擎入参分流，本窗口不走那条路——链描述子由
// buildChain() 直接按语义组装（见文件末），故此处字段声明只管 UI 渲染与默认值。

import { halfStr } from '../shared/num.js'   // 全角减号/数字归一到半角，避免负数被 parseFloat 吞掉
import { RE_KM } from '../shared/slantRange.js'
import { rateFactors } from '../shared/carrierRate.js'   // 调制因子/FEC/帧效率/扩频：与引擎同一套换算链
import { byLang } from '../shared/i18n/lang.js'          // 出厂占位站名按平台语言出字（名字是数据，呈现层翻不到）

export function defaultsFor(fields) {
  const o = {}
  for (const f of fields) o[f.key] = f.def
  return o
}
// 数值字段先归一全角→半角再出参；文本/select 原样（勿改站名等）
const val = (f, v) => (f.type === 'num' ? halfStr(v) : v)
// 取有效数值（全角归一后 parseFloat），拿不到返回 null
const pnum = (v) => { const n = parseFloat(halfStr(v)); return isFinite(n) ? n : null }

// ============ 载波体制（不设库，参数直接下放到节点）============
// 体制不是可复用的资产，它是「这条链的哪一段用什么」——故没有载波库，参数落在【段起点节点】上：
//   · 链首节点（源）＝这条业务的发起点，填完整一套（含信息速率）；
//   · 下游段起点（再生节点）＝重新编码调制，建节点时默认整套照抄链首那份（「和第一跳一致」），之后各改各的；
//   · ★ 信息速率全程不能动：只有链首那份算数，各段一律用它（守恒，见 buildChain）。
export const CARRIER_FIELDS = [
  { key: 'infoRate', label: '信息速率', unit: 'kbps', type: 'num', def: '2048' },
  { key: 'modulation', label: '调制方式', type: 'select', options: ['BPSK', 'QPSK', '8PSK', '16APSK', '32APSK'], def: 'QPSK' },
  { key: 'fec', label: 'FEC 码率', type: 'text', def: '3/4' },
  { key: 'ebno', label: '门限', unit: 'dB', type: 'num', def: '5.50' },
  { key: 'ber', label: '误码率 10⁻ⁿ', unit: 'n', type: 'num', def: '7' },
  { key: 'm', label: '扩频增益', type: 'num', def: '1.00' },
  { key: 'bandwidthFactor', label: '滚降系数 (1+α)', type: 'num', def: '1.20' },
  { key: 'rsCode', label: '帧效率', type: 'text', def: '188/204' },
  { key: 'noiseRatioMode', label: '门限模式', def: 'ebno' }
]
// 节点上那份体制的完整初值：CARRIER_FIELDS 之外还有 BasebandPanel 自己的几个呈现态
// （帧效率/频谱效率视角、DVB 标准与 MODCOD 选择、速率换算链的锚点）。
export const defaultCarrier = () => ({
  ...defaultsFor(CARRIER_FIELDS),
  rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, rateAnchor: 'info', rateAnchorValue: null
})

// ============ 地球站库（一份配置 = 一种站型的收发射频参数）============
// 一座站 = 一面天线：口径收发共用（side:'common'），效率按收发频段分设。
// 频率 / 极化在 hop 上（一条链每一跳频率各异），干扰在卫星上——与平台既定归属一致。
export const ES_FIELDS = [
  { key: 'antennaDiameter', label: '天线口径', tip: '收发共用同一面天线：口径一致（天线效率按收发频段分设）', side: 'common', unit: 'm', type: 'num', def: '9.0' },
  { key: 'opPowerW', label: '功放功率预设', tip: '功放输出功率（W）。端到端只有正向计算：这个数就是这一段链路的起点电平，不反算', side: 'tx', hero: true, unit: 'W', type: 'num', def: '120' },
  { key: 'antennaEfficiency', label: '天线效率', side: 'tx', unit: '%', type: 'num', def: '65' },
  { key: 'paBackoff', label: '功放回退', side: 'tx', unit: 'dB', type: 'num', def: '0' },
  { key: 'feederLoss', label: '馈线损耗', side: 'tx', unit: 'dB', type: 'num', def: '3.5' },
  { key: 'uplinkPowerControl', label: 'UPC', tip: '上行功率控制 (Uplink Power Control)', side: 'tx', type: 'select', options: ['否', '是', '自定义'], def: '否' },
  { key: 'upcValue', label: 'UPC值', tip: '仅「UPC = 自定义」时生效', side: 'tx', unit: 'dB', type: 'num', def: '0' },
  { key: 'rxAntennaEfficiency', label: '天线效率', side: 'rx', unit: '%', type: 'num', def: '68' },
  { key: 'rxAntennaNoiseTempMode', label: '天线噪温模式', tip: '自动 = 按 ITU-R P.618-14 §3 由晴空大气衰减与链路仰角实时求取天空噪温（+25 K 地面拾取常数）；自定义 = 用「天线噪温」数值', side: 'rx', type: 'select', options: ['自动', '自定义'], def: '自动' },
  { key: 'rxAntennaNoiseTemp', label: '天线噪温', tip: '天线噪声温度（K）；仅「天线噪温模式 = 自定义」时生效', side: 'rx', unit: 'K', type: 'num', def: '35' },
  { key: 'rxReceiverNoiseTemp', label: '接收机噪温', side: 'rx', unit: 'K', type: 'num', def: '75' },
  { key: 'rxFeederLoss', label: '馈线损耗', side: 'rx', unit: 'dB', type: 'num', def: '0.2' }
]
export const ES_COMMON_FIELDS = ES_FIELDS.filter((f) => f.side === 'common')
export const ES_TX_FIELDS = ES_FIELDS.filter((f) => f.side === 'tx')
export const ES_RX_FIELDS = ES_FIELDS.filter((f) => f.side === 'rx')

// ============ 卫星库（一份条目 = 一颗星，轨道 + 透明组 + 再生组 + 干扰八项）============
// grp 标记供检查器按节点类型挑组显示：'id' 身份 / 'orbit' 轨道 / 'txp' 透明转发器 / 'regen' 再生 /
// 'rx' 接收 / 'intfUp' 上行干扰 / 'intfDn' 下行干扰。
// 轨道组只出现在资源库编辑器里（它是这颗星的属性，不是某一跳的），链上节点不可覆盖。
export const SAT_FIELDS = [
  { key: 'satelliteName', label: '卫星名称', type: 'text', def: 'Satellite', grp: 'id' },
  { key: 'frequencyBand', label: '工作频段', type: 'select', options: ['L', 'S', 'X', 'ExtC', 'C', 'ExtKu', 'Ku', 'Ku-BSS', 'Ka', 'Q', 'V'], def: 'Ku', grp: 'id' },
  { key: 'orbitClass', label: '轨道类型', tip: 'GSO＝地球静止轨道（定点经度即可定几何）；NGSO＝非静止轨道（手填轨道高度/倾角，或从星历搜索一颗真星取轨道根数）', type: 'select', options: ['GSO', 'NGSO'], def: 'GSO', grp: 'orbit' },
  { key: 'orbitLongitude', label: '定点经度', tip: '静止星的定点经度（°E，西经取负）：自动几何按站址与它算斜距/仰角', unit: '°E', type: 'num', def: '110.5', grp: 'orbit' },
  { key: 'orbitAltitude', label: '轨道高度', tip: '圆轨道高度（km）。选星后由所选卫星轨道自动确定', unit: 'km', type: 'num', def: '1200', grp: 'orbit' },
  { key: 'orbitInclination', label: '轨道倾角', tip: '轨道倾角（°）。选星后由所选卫星轨道自动确定', unit: '°', type: 'num', def: '53', grp: 'orbit' },
  { key: 'gt', label: '卫星 G/T', tip: '卫星接收品质因数 G/T（dB/K）：按该站对本星的波束位置手动输入（平台既定：不做方向图自动取值）', unit: 'dB/K', type: 'num', def: '2', grp: 'rx' },
  { key: 'sfdRef', label: '卫星 SFD', tip: '饱和通量密度 SFD（dBW/m²，参考 G/T）', unit: 'dBW/m²', type: 'num', def: '-84', grp: 'txp' },
  { key: 'sfdGtRef', label: 'SFD 参考 G/T', tip: 'SFD 标称所依据的参考 G/T（dB/K）；引擎入口按 有效SFD = SFD + 参考G/T 换算', unit: 'dB/K', type: 'num', def: '0', grp: 'txp' },
  { key: 'BOi', label: '输入回退 IBO', unit: 'dB', type: 'num', def: '6', grp: 'txp' },
  { key: 'BOo', label: '输出回退 OBO', unit: 'dB', type: 'num', def: '3', grp: 'txp' },
  { key: 'transponderBandwidth', label: '转发器带宽', unit: 'MHz', type: 'num', def: '36', grp: 'txp' },
  { key: 'eirpSat', label: '卫星饱和 EIRP', tip: '透明转发器整星饱和下行 EIRP（dBW）；每载波输出 EIRP = 饱和 EIRP − OBO − 该载波占转发器回退', unit: 'dBW', type: 'num', def: '46', grp: 'txp' },
  { key: 'eirp', label: '再生下行 EIRP', tip: '再生载荷该载波的下行 EIRP（dBW，直发口径，非整波束饱和值）：手动输入', unit: 'dBW', type: 'num', def: '28', grp: 'regen' },
  { key: 'procDelayMs', label: '处理时延', tip: '再生载荷解调-重调的处理时延（ms），计入端到端时延', unit: 'ms', type: 'num', def: '0', grp: 'regen' },
  { key: 'aciUplinkFactor', label: '上行C/ACI', tip: '上行载波/邻道干扰比 (Adjacent Channel Interference)', unit: 'dB', type: 'num', def: '30', grp: 'intfUp' },
  { key: 'adjUplinkFactor', label: '上行C/ASI', tip: '上行载波/邻星干扰比 (Adjacent Satellite Interference)', unit: 'dB', type: 'num', def: '25', grp: 'intfUp' },
  { key: 'xpolUplinkFactor', label: '上行C/XPI', tip: '上行载波/交叉极化干扰比；雨致去极化由引擎并入', unit: 'dB', type: 'num', def: '26', grp: 'intfUp' },
  { key: 'hpaIntermodFactor', label: 'HPA C/IM', tip: '高功放载波/互调比 (HPA Intermodulation)', unit: 'dB', type: 'num', def: '24', grp: 'intfUp' },
  { key: 'aciDownlinkFactor', label: '下行C/ACI', unit: 'dB', type: 'num', def: '30', grp: 'intfDn' },
  { key: 'adjDownlinkFactor', label: '下行C/ASI', unit: 'dB', type: 'num', def: '25', grp: 'intfDn' },
  { key: 'xpolDownlinkFactor', label: '下行C/XPI', unit: 'dB', type: 'num', def: '26', grp: 'intfDn' },
  { key: 'xpdrIntermodFactor', label: '下行C/IM', tip: '卫星下行载波/互调比 (Intermodulation)。透明星出星间跳时同一标称值按其工作点折算入账（同一台功放）；ISL 走独立功放链时此近似偏保守或偏乐观，请按实际功放口径填写。再生式单载波 TDM 下行无多载波互调，清空此格＝不计入（单载波非线性失真计入解调实现损失）；多载波共用功放时按实际填写', unit: 'dB', type: 'num', def: '21', grp: 'intfDn' }
]
const satGrp = (...g) => SAT_FIELDS.filter((f) => g.includes(f.grp))
export const SAT_TXP_FIELDS = satGrp('rx', 'txp')      // 透明节点检查器：接收 G/T + 转发器组
export const SAT_REGEN_FIELDS = satGrp('rx', 'regen')  // 再生节点检查器：接收 G/T + 再生组
export const SAT_INTF_UP_FIELDS = satGrp('intfUp')
export const SAT_INTF_DN_FIELDS = satGrp('intfDn')
export const SAT_ID_FIELDS = satGrp('id')
export const SAT_ORBIT_FIELDS = satGrp('orbit')

// 卫星条目的轨道来源（与 NGSO / 再生式两窗同结构、同语义，几何求解器吃的就是 orbit 这个 spec）：
//   mode: 'manual' 手填轨道 | 'tree' 卫星/天线树选的星 | 'search' 星历搜索到的星
//   orbit: 主进程 buildSatrec 的 spec（omm / elements / snapshot），manual 档为 null
export const blankNgsoSat = () => ({ mode: 'manual', orbit: null, name: '', noradId: null, folder: '' })
export function normNgsoSat(ns) {
  return ns
    ? { mode: ns.mode || 'manual', orbit: ns.orbit ? JSON.parse(JSON.stringify(ns.orbit)) : null, name: ns.name || '', noradId: ns.noradId || null, folder: ns.folder || '' }
    : blankNgsoSat()
}
// 该条目最终交给几何求解器的轨道 spec：
//   · GSO —— 定点经度 → 赤道面上的静止星（snapshot 静止几何，与三窗 GEO 口径一致）；
//   · NGSO 选星 —— 真实轨道根数（SGP4/SDP4）；
//   · NGSO 手填 —— 圆轨道高度 + 倾角（闭式最差几何，无相位）。
// 返回 null＝这颗星没有可用轨道，自动几何对涉及它的跳无解（由调用方报因，绝不兜底编数）。
export function orbitSpecOf(cfg) {
  if (!cfg) return null
  const f = cfg.form || {}
  if ((f.orbitClass || 'GSO') === 'GSO') {
    const lon = parseFloat(halfStr(f.orbitLongitude))
    return isFinite(lon) ? { type: 'snapshot', lonDeg: lon, latDeg: 0, altKm: 35786 } : null
  }
  const ns = cfg.ngsoSat
  if (ns && ns.mode !== 'manual' && ns.orbit && ns.orbit.type !== 'unresolved') return JSON.parse(JSON.stringify(ns.orbit))
  const alt = parseFloat(halfStr(f.orbitAltitude))
  if (!(alt > 0)) return null
  return { type: 'circular', altKm: alt, inclDeg: parseFloat(halfStr(f.orbitInclination)) || 0 }
}

// ============ 节点（地球站）站址字段 ============
export const NODE_ES_FIELDS = [
  { key: 'name', label: '站名', type: 'text', def: '地球站' },
  { key: 'longitude', label: '经度', unit: '°E', type: 'num', def: '116.4074' },
  { key: 'latitude', label: '纬度', unit: '°N', type: 'num', def: '39.9042' },
  { key: 'altitude', label: '海拔', unit: 'm', type: 'num', def: '0' },
  { key: 'rainRate', label: 'R0.01%', tip: '站址年 0.01% 时间降雨率（mm/h）', unit: 'mm/h', type: 'num', def: '54' },
  { key: 'availability', label: '可用度', tip: '本站的链路可用度（%）。系统可用度 = 各星地 hop 站址可用度之积；星间段不参与', unit: '%', type: 'num', def: '99.90' }
]
// 段起点电平的快调入口：功放功率可在【节点上】覆盖库条目（空＝跟随库）。
// 只在该站作为段起点（发信站 / 地面转接站的上行侧）时有物理意义，检查器按此显示。
export const NODE_ES_TX_FIELDS = [
  { key: 'opPowerW', label: '功放功率', tip: '本站功放输出功率（W）＝这一段正向递推的起点电平。留空＝跟随地球站库条目', unit: 'W', type: 'num', def: '' }
]

// ============ 节点上的调制解调（再生节点＝解调器 + 编码调制器两个盒子）============
// 收侧：按【上一段】体制解调，实际门限 = 理论门限 + 本节点解调器的实现损失。
// 发侧：按【下一段】体制重新编码调制；信息速率默认穿过节点守恒，真要变（星上复用/分流、
//       槽位固定换高阶调制）就在这里给适配比，账面上看得见。
export const NODE_DEMOD_FIELDS = [
  { key: 'demodLossDb', label: '解调实现损失', tip: '本节点解调器的实现损失（dB）：载波/符号同步、量化、滤波等非理想因素，工程常用 0.5~1.5 dB。实际解调门限 = 体制理论门限 + 本项', unit: 'dB', type: 'num', def: '0' }
]
// ============ hop 字段 ============
export const HOP_GS_FIELDS = [
  { key: 'frequency', label: '频率', unit: 'GHz', type: 'num', def: '14.25' },
  { key: 'polarization', label: '极化', type: 'select', options: ['V', 'H', 'L', 'R'], def: 'V' },
  { key: 'slantRange', label: '斜距', tip: '本跳的星地斜距（km）。留空即报错——端到端窗口不按轨道高度兜底换算（几何全部手填）。可用「斜距工具」按站址纬度/海拔/仰角/轨道高度算出后填入', unit: 'km', type: 'num', def: '' },
  { key: 'elevation', label: '仰角', tip: '本跳对卫星的仰角（°）：直接送进引擎，不解算轨道。GSO 跳选星后斜距/仰角为真几何联动回填；手改仰角后斜距不再联动，按所填值计算', unit: '°', type: 'num', def: '25' },
  { key: 'miscLoss', label: '附加损耗', tip: '指向/极化/天线罩/接头等未单列损耗之综合（dB）', unit: 'dB', type: 'num', def: '0.3' }
]
// 星地跳的【侧向】默认频率/极化：上行一套、下行一套。频率与极化是有向量——改拓扑时新跳与
// 来源跳方向相反（链首接卫星把上行跳变成下行跳这类），承接过来就是串味，此时取本侧默认。
// 几何量（斜距/仰角/附加损耗）与方向无关，照旧承接。见 E2eLinkBudgetApp 的 reseedHop。
export const GS_SIDE_DEFAULTS = {
  up: { frequency: '14.25', polarization: 'V' },
  down: { frequency: '12.50', polarization: 'H' }
}
export const HOP_ISL_FIELDS = [
  { key: 'rangeKm', label: '星间链路距离', tip: '本跳的星间距离（km），直接送进引擎算自由空间损耗。留空即报错。可用「距离工具」按两星轨道在时间轴上算出后填入', unit: 'km', type: 'num', def: '' },
  { key: 'frequency', label: '星间频率', unit: 'GHz', type: 'num', def: '23' },
  { key: 'islEirp', label: '发射EIRP', tip: '发射卫星星间发射 EIRP（dBW，手填）', unit: 'dBW', type: 'num', def: '45' },
  { key: 'islGT', label: '接收G/T', tip: '接收卫星星间接收品质因数 G/T（dB/K，手填）', unit: 'dB/K', type: 'num', def: '12' },
  // 星间干扰：与星地那四项不是同一个物理域（真空段无雨致去极化、无地面 ASI 路径），且随这条
  // 链路的几何与频率复用而变，故聚合成一项挂在跳上（与 islEirp/islGT 同构），不挂卫星。
  { key: 'islCI', label: '星间C/I', tip: '本跳星间干扰合计载噪比（dB）：星座内邻 ISL 同频、邻道、极化泄漏等之合计，经工程分析后手填；留空＝不计入。发射端为透明星时其转发器互调另按该星工作点折算入账，与本项不重复', unit: 'dB', type: 'num', def: '' },
  { key: 'miscLoss', label: '附加损耗', unit: 'dB', type: 'num', def: '1' }
]
export const HOP_LASER_FIELDS = [
  { key: 'rangeKm', label: '星间链路距离', tip: '本跳的星间距离（km）。留空即报错', unit: 'km', type: 'num', def: '' },
  { key: 'txPowerDbm', label: '发射光功率 P_tx', unit: 'dBm', type: 'num', def: '30' },
  { key: 'wavelengthNm', label: '波长 λ', unit: 'nm', type: 'num', def: '1550' },
  { key: 'txApertureMm', label: '发射口径 D_tx', unit: 'mm', type: 'num', def: '80' },
  { key: 'rxApertureMm', label: '接收口径 D_rx', unit: 'mm', type: 'num', def: '80' },
  { key: 'txOpticsEff', label: '发射光学效率 η_tx', tip: '∈ (0,1]；OE = 10·lg(η)', type: 'num', def: '0.8' },
  { key: 'rxOpticsEff', label: '接收光学效率 η_rx', tip: '∈ (0,1]', type: 'num', def: '0.8' },
  { key: 'txPointingErrUrad', label: '发射指向误差', unit: 'µrad', type: 'num', def: '1' },
  { key: 'rxPointingErrUrad', label: '接收指向误差', unit: 'µrad', type: 'num', def: '1' },
  { key: 'rxSensitivityDbm', label: '接收机灵敏度 P_req', tip: '所需接收功率（dBm）；本跳余量 = P_rx − P_req。灵敏度应与本段体制的设计 BER 取同一定义点', unit: 'dBm', type: 'num', def: '-35.5' },
  { key: 'otherLossDb', label: '其他损耗 L', unit: 'dB', type: 'num', def: '0' }
]
const LASER_KEYS = HOP_LASER_FIELDS.map((f) => f.key).filter((k) => k !== 'rangeKm')

// ============ 新建节点 / hop ============
let _uid = 1
export const uid = (p) => p + (_uid++)
export function newEsNode(name) {
  return { _id: uid('n'), kind: 'es', esId: '', ...defaultsFor(NODE_ES_FIELDS), ...defaultsFor(NODE_ES_TX_FIELDS), ...defaultsFor(NODE_DEMOD_FIELDS), name: name || byLang('地球站', 'Earth Station') }
}
export function newSatNode(kind, name) {
  return { _id: uid('n'), kind: kind === 'regen' ? 'regen' : 'txp', satId: '', name: name || '', ov: {}, ...defaultsFor(NODE_DEMOD_FIELDS) }
}
export function newHop(link) {
  const h = { _id: uid('h'), link: link === 'laser' ? 'laser' : 'rf' };
  Object.assign(h, defaultsFor(HOP_GS_FIELDS), defaultsFor(HOP_ISL_FIELDS), defaultsFor(HOP_LASER_FIELDS))
  h.frequency = '14.25'; h.miscLoss = '0.3'
  return h
}

// hop 类型推断：两端节点定死（地球站→卫星=上行，卫星→地球站=下行，卫星→卫星=星间）
export function hopTypeOf(a, b, hop) {
  if (!a || !b) return null
  const aEs = a.kind === 'es', bEs = b.kind === 'es'
  if (aEs && bEs) return null
  if (aEs) return 'up'
  if (bEs) return 'down'
  return (hop && hop.link === 'laser') ? 'laser' : 'isl'
}
export const isSpaceHop = (t) => t === 'isl' || t === 'laser'

// 这颗星【在这条链的这个位置上】真正入账的干扰项（检查器据此只显示生效的那几项）。
// 逐条对齐引擎口径（见 utils/linkChain.js §干扰口径 A/B/C）：
//   · 上行四项 —— 只在「接住一条星地上行」的那颗星上入账（进段星：透明走 bentPipeCI、
//     再生走 directMergeIntfLinear，取的都是接收星那一份）；
//   · 下行四项 —— 只在「发出一条星地下行」的那颗星上入账（出段星，同上两条路）；
//   · 下行 C/IM —— 透明星【出星间跳】时另按它自己的工作点折算一次（txpIslImCI）；同组另三项
//     不逐星重复（同一批相邻载波随信号走到底，只在边界入账一次）。链首那颗按载荷直发归一
//     （无来波可转发 ⇒ 不做转发器变换，也就没有互调账），故 i>0 才算；
//   · 星间那一路的干扰是【跳】的属性（星间C/I 填在跳上），不在这里。
// 一项都不生效就返回空数组（只中转星间跳的那颗中间星即如此），检查器整组不出。
export function intfKeysFor(nodes, hops, i) {
  const nd = (nodes || [])[i]
  if (!nd || nd.kind === 'es') return []
  const tIn = i > 0 ? hopTypeOf(nodes[i - 1], nd, (hops || [])[i - 1]) : null
  const tOut = i < nodes.length - 1 ? hopTypeOf(nd, nodes[i + 1], (hops || [])[i]) : null
  const keys = []
  if (tIn === 'up') keys.push(...SAT_INTF_UP_FIELDS.map((f) => f.key))
  if (tOut === 'down') keys.push(...SAT_INTF_DN_FIELDS.map((f) => f.key))
  else if (tOut === 'isl' && nd.kind === 'txp' && i > 0) keys.push('xpdrIntermodFactor')
  return keys
}

// 再生类节点（切段）：再生卫星 + 位于链中部的地球站（地面转接站）
export function isRegenClass(node, i, n) {
  if (!node) return false
  if (node.kind === 'regen') return true
  return node.kind === 'es' && i > 0 && i < n - 1
}

/**
 * 体制的门限 C/N（dB）——只由载波体制定，与几何/功率/干扰无关，故渲染端就能算，不必等引擎。
 *
 * ★ 门限 C/N 与门限 Es/N₀ 是同一个数：引擎的噪声带宽取符号率（noiseBW = symbolRate，见
 *   linkCalculatorNGSO），代进 thresholdCN = Eb/N₀ + 10·lg(信息速率/噪声带宽) 即得
 *   thresholdCN ≡ Eb/N₀ + 10·lg(k) ≡ Es/N₀，k = FEC×帧效率×调制因子 ÷ 扩频增益。
 *   「门限模式 = esno」时用户填的那个数本身就是 Es/N₀，直接就是门限 C/N。
 * @param {object} carrier 一段的载波体制（ebno / noiseRatioMode / modulation / fec / rsCode / m）
 * @returns {number|null} 门限 C/N（dB）；体制不全返回 null
 */
export function thresholdCNOf(carrier) {
  const c = carrier || {}
  const v = pnum(c.ebno)
  if (v === null) return null
  if (c.noiseRatioMode === 'esno') return v
  const { mf, fec, rs, m } = rateFactors(c)
  const k = (fec * rs * mf) / m
  return k > 0 ? v + 10 * Math.log10(k) : null
}

/**
 * 收侧解调器的「实际门限 C/N」＝ 本段体制的门限 C/N + 本节点的解调实现损失
 * （口径同引擎 thresholdEffResult：thrEff = 段门限 + 该节点 demodLossDb）。
 *
 * ★ 全程就地算、不读引擎出参：这两项都只由检查器上看得见的输入定（体制 + 实现损失），
 *   读出参就得先点一次计算才看得见，而换体制/填损失时这一格本就该当场跟上。
 * @param {object} carrier 入段那份体制
 * @param {*} demodLossDb 该节点填的解调实现损失（留空当 0，口径同引擎 numOr(demodLossDb, 0)）
 * @returns {string|null} 两位小数字符串；体制不全返回 null（纯激光段没有 C/N 门限，由调用方拦）
 */
export function thresholdEffLive(carrier, demodLossDb) {
  const thr = thresholdCNOf(carrier)
  if (thr === null) return null
  return (thr + (pnum(demodLossDb) || 0)).toFixed(2)
}

// 段切割（与引擎 utils/linkChain.js 同一口径，前端只为画段标尺）：返回 [{from,to}]
export function segmentsOf(nodes) {
  const n = nodes.length
  if (n < 2) return []
  const cuts = [0]
  for (let i = 1; i < n - 1; i++) if (isRegenClass(nodes[i], i, n)) cuts.push(i)
  cuts.push(n - 1)
  const out = []
  for (let s = 0; s < cuts.length - 1; s++) out.push({ from: cuts[s], to: cuts[s + 1] })
  return out
}

// ============ 链描述子组装（交 IPC → utils/linkChain.js）============
// 库条目解析走确定性 id；引用悬空（条目被删）时回退库中第一份，与三窗口径一致。
// ★ 出 IPC 前一律 JSON 深拷贝成纯数据：Vue 的响应式 Proxy 过不了结构化克隆，invoke 当场抛且静默。
export function buildChain(row, resolve) {
  const { es: resolveEs, sat: resolveSat } = resolve
  // 链首那份体制＝这条业务的定义（含信息速率）；缺项一律回落出厂默认，不让某一格为空把引擎带偏
  const headCarrier = { ...defaultCarrier(), ...(((row.nodes || [])[0] || {}).carrier || null) }
  const carrierOut = (c) => {
    const o = {}
    for (const f of CARRIER_FIELDS) o[f.key] = val(f, c[f.key])
    return o
  }
  const carrier = carrierOut(headCarrier)

  const nodes = (row.nodes || []).map((nd) => {
    if (nd.kind === 'es') {
      const esf = (resolveEs(nd.esId) || {}).form || {}
      const o = { kind: 'es', name: nd.name || '' }
      for (const f of NODE_ES_FIELDS) if (f.key !== 'name') o[f.key] = val(f, nd[f.key])
      for (const f of ES_FIELDS) o[f.key] = val(f, esf[f.key])
      for (const f of NODE_DEMOD_FIELDS) o[f.key] = val(f, nd[f.key])   // 收侧解调器：实现损失
      // 功放功率：节点覆盖优先（快调段起点电平），空即跟随库条目
      const ovW = nd.opPowerW
      o.powerW = val({ type: 'num' }, (ovW !== undefined && ovW !== null && ovW !== '') ? ovW : esf.opPowerW)
      return o
    }
    const entry = resolveSat(nd.satId) || {}
    const sf = entry.form || {}
    const ov = nd.ov || {}
    const o = { kind: nd.kind }
    for (const f of SAT_FIELDS) {
      const raw = (ov[f.key] !== undefined && ov[f.key] !== '') ? ov[f.key] : sf[f.key]
      o[f.key] = val(f, raw)
    }
    for (const f of NODE_DEMOD_FIELDS) o[f.key] = val(f, nd[f.key])     // 收侧解调器：实现损失
    // 节点显示名的优先级：节点自己起的名 > 库条目名（链路条上画的就是它）> 表单里的卫星名称。
    // 三者必须同一个口径——否则链路条上写着「卫星1」，瀑布的段/跳标题里却是表单默认值「Satellite」。
    o.name = nd.name || entry.name || o.satelliteName || ''
    return o
  })

  const hops = (row.hops || []).map((h, i) => {
    const t = hopTypeOf(row.nodes[i], row.nodes[i + 1], h)
    const o = { link: h.link || 'rf' }
    if (t === 'up' || t === 'down') {
      for (const f of HOP_GS_FIELDS) o[f.key] = val(f, h[f.key])
    } else if (t === 'laser') {
      o.rangeKm = val({ type: 'num' }, h.rangeKm)
      o.laser = {}
      for (const k of LASER_KEYS) o.laser[k] = halfStr(h[k])
    } else {
      for (const f of HOP_ISL_FIELDS) o[f.key] = val(f, h[f.key])
    }
    return o
  })

  // 逐段载波体制：段起点节点（再生卫星 / 地面转接站）自己那份；没有就照抄链首（＝和第一跳一致）。
  // ★ 信息速率一律取链首那份：一条业务流穿过再生节点守恒，段与段之间只换 MODCOD / 滚降 / 帧效率，
  //   符号率与占用带宽由「链首的信息速率 + 本段 MODCOD」推出。
  const carriers = segmentsOf(row.nodes || []).map((sg) => {
    const nd = (row.nodes || [])[sg.from]
    return carrierOut({ ...headCarrier, ...((nd && nd.carrier) || null), infoRate: headCarrier.infoRate })
  })
  return JSON.parse(JSON.stringify({ nodes, hops, carrier, carriers }))
}

// 这条链的业务信息速率（kbps）＝链首节点那份体制里的信息速率；拿不到返回 null
export function chainInfoRate(row) {
  return pnum(((((row || {}).nodes || [])[0] || {}).carrier || {}).infoRate)
}

// ============ 场景序列化（交 IPC → store.saveConfig / 指纹 / localStorage）============
// ★ 与 buildChain 同一条纪律：出口一律【现造纯数据】。
// 本窗口的节点上挂着两个【嵌套对象】——链首/段起点的 carrier（那份体制）与卫星节点的 ov
// （行内覆盖）。只剥一层 _id 的浅拷会把嵌套那层原样带出去，而那层是 Vue 的响应式 Proxy：
// 它过不了 IPC 的结构化克隆（DataCloneError: could not be cloned），saveConfig 当场抛。
// 三窗的行是纯扁平的（一层全是字符串），故只有本窗口会踩这个坑。
const stripId = (o) => { const r = {}; for (const k of Object.keys(o)) if (k !== '_id') r[k] = o[k]; return r }
export function serializeChainsState(chains, geoMode) {
  return JSON.parse(JSON.stringify({
    orbitType: 'E2E', v: 1,
    // 几何模式入场景（它决定这份场景的结果是怎么算出来的）；时窗只是搜索策略，留 localStorage
    geoMode: geoMode === 'auto' ? 'auto' : 'manual',
    chains: (chains || []).map((c) => ({
      name: c.name, nameAuto: !!c.nameAuto,
      nodes: (c.nodes || []).map(stripId), hops: (c.hops || []).map(stripId)
    }))
  }))
}

// ============ 手动几何的派生建议值（纯闭式，渲染端就地算）============
// 口径（2026-08-15 用户定）：手动档下斜距/星间距离是【由几何输入推出的建议值】——换卫星（轨道变）、
// 改仰角、改站址纬度/海拔时自动重算；星间跳按两星轨道给建议距离。用户手改过的格子在下一次
// 几何输入变化前保持不动（重算的触发指纹不含斜距/距离本身）。求解式一律闭式，不走 IPC。

const B_KM = 6356.7523142                          // WGS-84 极半径
const E2_WGS = 1 - (B_KM * B_KM) / (RE_KM * RE_KM) // 第一偏心率平方
const D2R = Math.PI / 180

// 轨道 spec → 代表高度（km）：快照/圆轨道直接读，真实星历由平均运动反推（同斜距工具的初值口径）
export function orbitAltKmOf(spec) {
  if (!spec) return null
  if (spec.type === 'snapshot' || spec.type === 'circular') return Number(spec.altKm) || null
  const MU = 398600.4418
  if (spec.type === 'omm') {
    const n = (Number(spec.meanMotion) || 0) * 2 * Math.PI / 86400
    return n > 0 ? Math.cbrt(MU / (n * n)) - RE_KM : null
  }
  if (spec.type === 'elements') return Number(spec.altKm) || null
  return null
}

/**
 * GSO 真实指向几何（WGS-84 椭球站址 + 赤道面静止星）：站址与定点经度都定了，仰角与斜距就都定了。
 * @returns {null|{slantKm:number, elevDeg:number}} 星在地平线下（纬度过高/经度差过大）返回 null，不编数。
 */
export function gsoLookAngles(staLonDeg, staLatDeg, staAltKm, satLonDeg) {
  const lon = Number(staLonDeg), lat = Number(staLatDeg), slon = Number(satLonDeg)
  if (!isFinite(lon) || !isFinite(lat) || !isFinite(slon)) return null
  const hs = Number(staAltKm) || 0
  const sLat = Math.sin(lat * D2R), cLat = Math.cos(lat * D2R)
  const sLon = Math.sin(lon * D2R), cLon = Math.cos(lon * D2R)
  const Nrad = RE_KM / Math.sqrt(1 - E2_WGS * sLat * sLat)
  const px = (Nrad + hs) * cLat * cLon
  const py = (Nrad + hs) * cLat * sLon
  const pz = (Nrad * (1 - E2_WGS) + hs) * sLat
  const r = RE_KM + 35786                            // 静止轨道地心距（与 orbitSpecOf 的 altKm 同口径）
  const sx = r * Math.cos(slon * D2R), sy = r * Math.sin(slon * D2R)
  const dx = sx - px, dy = sy - py, dz = -pz
  const d = Math.hypot(dx, dy, dz)
  if (!(d > 0)) return null
  // 仰角 = 视线与大地水平面的夹角（û 为椭球法线）
  const ux = cLat * cLon, uy = cLat * sLon, uz = sLat
  const elev = Math.asin((dx * ux + dy * uy + dz * uz) / d) / D2R
  if (!(elev > 0)) return null                       // 不可见：不给建议值
  return { slantKm: d, elevDeg: elev }
}

/**
 * 星间链路距离建议值（km）：
 *   · 双 GSO —— 两定点经度间的弦长（余弦定理，几何精确）；同一定点（弦长 < 1 km）返回 null。
 *   · 其余 —— 擦地球临边的最大互视距离 √((R+h₁)²−R²)+√((R+h₂)²−R²)（最差工况上界；
 *     精确的时间轴最差距离仍用「距离工具」/ 自动几何求解，这里只做手动档的建议初值）。
 */
export function suggestIslRangeKm(specA, specB) {
  if (!specA || !specB) return null
  if (specA.type === 'snapshot' && specB.type === 'snapshot') {
    const r1 = RE_KM + (Number(specA.altKm) || 35786), r2 = RE_KM + (Number(specB.altKm) || 35786)
    const dl = (Math.abs((Number(specA.lonDeg) - Number(specB.lonDeg)) % 360 + 360) % 360)
    const ang = (dl > 180 ? 360 - dl : dl) * D2R
    const d = Math.sqrt(r1 * r1 + r2 * r2 - 2 * r1 * r2 * Math.cos(ang))
    return d >= 1 ? d : null
  }
  const h1 = orbitAltKmOf(specA), h2 = orbitAltKmOf(specB)
  if (!(h1 > 0) || !(h2 > 0)) return null
  const t1 = Math.sqrt((RE_KM + h1) * (RE_KM + h1) - RE_KM * RE_KM)
  const t2 = Math.sqrt((RE_KM + h2) * (RE_KM + h2) - RE_KM * RE_KM)
  return t1 + t2
}
