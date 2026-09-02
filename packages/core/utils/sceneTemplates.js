// utils/sceneTemplates.js
// 应用场景仿真 —— 内置场景模板（纯数据 + 构造器）。
//
// 模板的作用不是好看，是把「打开这个功能后第一分钟做什么」变成「双击一个模板、改两个坐标」。
// 每个模板 = 一套模块 + 边 + 业务流，落进场景后即可直接算。
//
// ============ ★ 关于电平类数值 ============
// 模板里的卫星 G/T / EIRP / 干扰四项是【该类业务的起算值】，不是某颗星某个波束的实测值。
// 真正的数要由工程师做完对地覆盖分析后手填（平台既定口径）。模板把它们放在实例 ov 上而不是
// 改库，正是为了让「这是这一个场景的假设」与「这是那台设备的属性」分得开。
//
// ============ ★ 转发器带宽要填【这项业务实际占的那一片】 ============
// 弯管引擎的四路 C/I 是转发器级的口径：载波参考的 C/I = C/I(标称) − 载波回退 + 10lg(B_xpdr/B_noise)。
// 把 32 kbps 的窄带载波塞进整个 36 MHz 转发器去算，载波回退就有 50 dB，折算出来的 C/I 惨不忍睹，
// 而那并不是物理事实 —— 邻星那条同频窄带载波本来也只有几十 kHz 宽。
// 正确做法：transponderBandwidth 填【该业务分到的那一片】（几百 kHz / 几 MHz），
// 于是两项互相抵消，载波参考的 C/I 回到与输入值同量级。这条一错，所有窄带场景都算成不可行。

'use strict';

const SAT = require('./sceneSat.js');

// ── 速写 ──
const mod = (id, libId, name, place, ov) => ({ id, libId, name, place, ov });
// ★ 卫星节点写的是【预置 key】不是模块库 id：二期起卫星引用平台卫星库（library.json 的
//   'e2e'.sat，与端到端窗口共用一份）。这里同时把预置展开成可算的节点（sat / ports / symbol），
//   于是「模板 → 计算」这条路不依赖任何库，单测与验证台照旧跑得通；渲染端 applyTemplate 另有
//   一步：按 preset 在卫星库里找条目、找不到就建一条，把 satId 填上，参数真值从此跟着库走。
const satMod = (id, preset, name, ov) => Object.assign(
  SAT.satNodeFromPreset(preset, { id, name, ov }) || { id, kind: 'sat', name, sat: {} },
  { preset, ov: ov || {} }
);
const at = (lat, lon, altM, extra) => Object.assign({ mode: 'fixed', lat, lon, altM: altM || 0 }, extra || {});
const on = (hostId) => ({ mode: 'mounted', hostId });
const link = (id, aM, aP, bM, bP, medium, params, role) => ({ id, a: { modId: aM, portKey: aP }, b: { modId: bM, portKey: bP }, medium, params: params || {}, role: role || 'main' });
const flow = (id, name, aId, bId, o) => Object.assign({ id, name, aId, bId, dir: 'bidir' }, o || {});

// 窄带物联业务的卫星实例覆盖：分到的那一片带宽 + 起算 G/T + 整星 EIRP + ★转发器增益档 SFD。
// ★ SFD 是运营商可调的（转发器增益步进衰减器）：给小口径终端做窄带业务时必须开【高增益档】，
//   否则 0.15 m + 2 W 的终端到星通量密度比转发器工作点低几十 dB，四路 C/I 折算到载波上会
//   全部塌掉 —— 表现为「这个产品明明在卖，软件却算成完全不可行」。标称档 −85 是给大载波用的。
const IOT_SLICE = (bwMHz, gt, eirp, sfd) => ({ sat: { transponderBandwidth: bwMHz, gt, eirpSat: eirp, sfdRef: sfd == null ? -115 : sfd } });
// 宽带业务：Ka 高通量点波束的起算值
const HTS_BEAM = (bwMHz, gt, eirp) => ({ sat: { transponderBandwidth: bwMHz, gt, eirpSat: eirp } });

// C 频段星地边：6 GHz 上 / 4 GHz 下
const C_AIR = (o) => Object.assign({ freqUpGHz: 6.15, freqDnGHz: 3.925, pol: 'V' }, o || {});
// Ku：14 GHz 上 / 12.25 GHz 下
const KU_AIR = (o) => Object.assign({ freqUpGHz: 14.0, freqDnGHz: 12.25, pol: 'H' }, o || {});
// Ka：29.5 GHz 上 / 19.7 GHz 下
const KA_AIR = (o) => Object.assign({ freqUpGHz: 29.5, freqDnGHz: 19.7, pol: 'H' }, o || {});
// 天启 UHF：上下行同在 UHF 段
const UHF_AIR = (o) => Object.assign({ freqUpGHz: 0.4, freqDnGHz: 0.4, pol: 'V', minElevDeg: 15 }, o || {});

// 常用站址（经纬度取行政中心，用户落地后自行改）
const P = {
  urumqi: [43.83, 87.62, 900], beijing: [39.90, 116.40, 50], huailai: [40.42, 115.52, 550],
  lhasa: [29.65, 91.14, 3650], motuo: [29.33, 95.33, 1100], linzhi: [29.65, 94.36, 3000],
  songshan: [40.50, 115.80, 900], huairou: [40.32, 116.63, 300], kashi: [39.47, 75.99, 1290],
  golmud: [36.40, 94.90, 2800], daqing: [46.59, 125.10, 150], zhoushan: [30.02, 122.11, 10],
  sanya: [18.25, 109.51, 10], liangshan: [27.89, 102.26, 1500], hulunbuir: [49.21, 119.74, 610],
  shenzhen: [22.54, 114.06, 20], chengdu: [30.57, 104.07, 500], nanhai: [16.0, 112.0, 0]
};
const pt = (k, extra) => at(P[k][0], P[k][1], P[k][2], extra);

// ═══════════════════════════════════════════════════════════════════════════
// 模板
// ═══════════════════════════════════════════════════════════════════════════
const TEMPLATES = [

  // ── 电力 ──
  {
    id: 'tpl.power.dtu', zh: '电力 · 无网区域配电三遥', industry: '电力', tags: ['电力', '配电', '三遥', 'C频段'],
    hint: '配电终端 → C 频段物联固定站 → 中星 6C → 北京信关站 → 专线 → 地区调度主站',
    build: () => ({
      modules: [
        mod('dtu', 'sens.dtu', '10 kV 线路 DTU', pt('kashi')),
        mod('es', 'es.c.iot.015', 'C 频段物联站', pt('kashi', { rainRate: 12, availPct: 99.5 })),
        satMod('sat', 'cs6c', '中星 6C', IOT_SLICE(0.5, 2.5, 44)),
        mod('hub', 'es.hub.c.11m', '北京信关站', pt('beijing', { rainRate: 42, availPct: 99.9 })),
        mod('ctr', 'ctr.dc', '地区调度主站', pt('beijing'))
      ],
      links: [
        link('l1', 'dtu', 'lan1', 'es', 'lan1', 'cat6', { lengthM: 25, ratePreset: '100BASE-TX' }),
        link('l2', 'es', 'rf', 'sat', 'rf', 'sat_c', C_AIR()),
        link('l3', 'sat', 'rf', 'hub', 'rf', 'sat_c', C_AIR()),
        link('l4', 'hub', 'wan', 'ctr', 'wan1', 'leased_mstp', { rateBps: 100e6, latencyMs: 6, availPct: 99.95 })
      ],
      flows: [flow('f1', '配电三遥', 'dtu', 'ctr', { rateAbBps: 19200, rateBaBps: 9600, availReqPct: 99.0, latReqMs: 3000 })]
    })
  },
  {
    id: 'tpl.power.meter', zh: '电力 · 偏远营销计量', industry: '电力', tags: ['电力', '营销计量', 'HPLC'],
    hint: '智能电表 —HPLC→ 台区集中器 —RJ45→ C 频段站 → 中星 6C → 信关站 → 专线 → 省公司',
    build: () => ({
      modules: [
        mod('mtr', 'sens.meter.single', '台区智能电表（×200）', pt('golmud')),
        mod('con', 'sens.meter.concentrator', '台区集中器', pt('golmud')),
        mod('es', 'es.c.iot.015', 'C 频段物联站', pt('golmud', { rainRate: 8, availPct: 99.5 })),
        satMod('sat', 'cs6c', '中星 6C', IOT_SLICE(0.2, 2.5, 44)),
        mod('hub', 'es.hub.c.11m', '怀来信关站', pt('huailai', { rainRate: 40, availPct: 99.9 })),
        mod('ctr', 'ctr.dc', '省公司营销系统', pt('beijing'))
      ],
      links: [
        link('l0', 'mtr', 'hplc', 'con', 'hplc', 'hplc', { meters: 200, hops: 3 }),
        link('l1', 'con', 'lan1', 'es', 'lan1', 'cat6', { lengthM: 15, ratePreset: '100BASE-TX' }),
        link('l2', 'es', 'rf', 'sat', 'rf', 'sat_c', C_AIR()),
        link('l3', 'sat', 'rf', 'hub', 'rf', 'sat_c', C_AIR()),
        link('l4', 'hub', 'wan', 'ctr', 'wan1', 'leased_mstp', { rateBps: 1e9, latencyMs: 8, availPct: 99.95 })
      ],
      flows: [flow('f1', '集中抄表', 'con', 'ctr', { rateAbBps: 9600, rateBaBps: 4800, availReqPct: 98.0 })]
    })
  },
  {
    id: 'tpl.power.line', zh: '电力 · 无人区输电线路监测', industry: '电力', tags: ['电力', '输电', '天启', '低轨'],
    hint: '杆塔倾斜 + 导线测温 → 天启 UHF 终端 → 天启星座 → 天启地面站 → 专线 → 运维平台',
    build: () => ({
      modules: [
        mod('tilt', 'sens.pole.tilt', '杆塔倾斜监测', pt('hulunbuir')),
        mod('tmp', 'sens.line.temp', '导线测温', pt('hulunbuir')),
        mod('tq', 'es.tq.zd08', '天启 TQZD-08', pt('hulunbuir', { availPct: 99.0 })),
        mod('pv', 'pwr.pv100', '太阳能 100 Wp', on('tq')),
        satMod('sat', 'tq1', '天启一期', { sat: { gt: -12, eirp: 12 } }),
        mod('gs', 'es.hub.tq.gs', '天启地面站', pt('beijing', { availPct: 99.5 })),
        mod('ctr', 'ctr.platform', '输电运维平台', pt('beijing'))
      ],
      links: [
        link('l0', 'tilt', 'rs485', 'tq', 'rs485', 'rs485', { lengthM: 60, baud: 9600, nodes: 6 }),
        link('l0b', 'tmp', 'rf', 'tq', 'rf', 'sat_uhf', UHF_AIR()),
        link('l1', 'tq', 'rf', 'sat', 'rf', 'sat_uhf', UHF_AIR()),
        link('l2', 'sat', 'rf', 'gs', 'rf', 'sat_uhf', UHF_AIR()),
        link('l3', 'gs', 'wan', 'ctr', 'wan', 'leased_mstp', { rateBps: 100e6, latencyMs: 10, availPct: 99.9 })
      ],
      flows: [flow('f1', '状态量上报', 'tq', 'ctr', { dir: 'ab', rateAbBps: 600, availReqPct: 95.0 })]
    })
  },

  // ── 水利 ──
  {
    id: 'tpl.water.dam', zh: '水利 · 水库大坝安全监测', industry: '水利', tags: ['水利', '大坝', '天启'],
    hint: '水位 + 雨量 + 渗压 —RS485→ 天启终端 → 天启星座；本地 4G 为主、卫星为备',
    build: () => ({
      modules: [
        mod('lvl', 'sens.water.level', '坝前水位计', pt('linzhi')),
        mod('rain', 'sens.water.rain', '雨量计', pt('linzhi')),
        mod('see', 'sens.dam.seepage', '渗压计组', pt('linzhi')),
        mod('rtu', 'edge.rtu', '遥测 RTU', pt('linzhi')),
        mod('tq', 'es.tq.zd08', '天启 TQZD-08', pt('linzhi', { availPct: 99.0 })),
        mod('pv', 'pwr.pv100', '太阳能 100 Wp', on('tq')),
        satMod('sat', 'tq1', '天启一期', { sat: { gt: -12, eirp: 12 } }),
        mod('gs', 'es.hub.tq.gs', '天启地面站', pt('beijing', { availPct: 99.5 })),
        mod('ctr', 'ctr.platform', '水情平台', pt('beijing'))
      ],
      links: [
        link('l0', 'lvl', 'rs485', 'rtu', 'rs485a', 'rs485', { lengthM: 150, baud: 9600, nodes: 3 }),
        link('l0b', 'rain', 'rs485', 'rtu', 'rs485b', 'rs485', { lengthM: 30, baud: 9600, nodes: 3 }),
        link('l0c', 'see', 'rs485', 'rtu', 'rs485c', 'rs485', { lengthM: 400, baud: 4800, nodes: 12 }),
        link('l1', 'rtu', 'rs485a', 'tq', 'rs485', 'rs485', { lengthM: 5, baud: 115200, nodes: 2 }),
        link('l2', 'tq', 'rf', 'sat', 'rf', 'sat_uhf', UHF_AIR()),
        link('l3', 'sat', 'rf', 'gs', 'rf', 'sat_uhf', UHF_AIR()),
        link('l4', 'gs', 'wan', 'ctr', 'wan', 'leased_mstp', { rateBps: 100e6, latencyMs: 10, availPct: 99.9 })
      ],
      flows: [flow('f1', '水情上报', 'rtu', 'ctr', { dir: 'ab', rateAbBps: 1200, availReqPct: 98.0 })]
    })
  },

  // ── 林草 ──
  {
    id: 'tpl.forest.pole', zh: '林草 · 森林防火（卫星智慧杆）', industry: '林草', tags: ['林草', '防火', '智慧杆', 'Ka'],
    hint: '双光云台 + 火险因子站 → 智慧杆边缘盒（本地研判）→ Ka 无人值守站 → 中星 26 → 信关站',
    build: () => ({
      modules: [
        mod('cam', 'sens.forest.cam', '火点双光云台', pt('songshan')),
        mod('fac', 'sens.forest.fire', '火险因子站', pt('songshan')),
        mod('pole', 'net.smartpole', '卫星智慧杆', pt('songshan', { rainRate: 38, availPct: 99.0 })),
        satMod('sat', 'cs26', '中星 26 号', HTS_BEAM(40, 13, 61)),
        mod('hub', 'es.hub.ka.gw', 'Ka 信关站', pt('beijing', { rainRate: 42, availPct: 99.9 })),
        mod('ctr', 'ctr.video.platform', '林草监测平台', pt('beijing'))
      ],
      links: [
        link('l0', 'cam', 'lan1', 'pole', 'lan1', 'cat6', { lengthM: 20, ratePreset: '1000BASE-T', poe: '802.3at', poeLoadW: 12 }),
        link('l0b', 'fac', 'rs485', 'pole', 'rs485', 'rs485', { lengthM: 80, baud: 9600, nodes: 4 }),
        link('l1', 'pole', 'sat', 'sat', 'rf', 'sat_ka', KA_AIR()),
        link('l2', 'sat', 'rf', 'hub', 'rf', 'sat_ka', KA_AIR()),
        link('l3', 'hub', 'wan', 'ctr', 'wan', 'leased_mstp', { rateBps: 1e9, latencyMs: 6, availPct: 99.95 })
      ],
      flows: [
        flow('f1', '火点视频回传', 'pole', 'ctr', { dir: 'ab', rateAbBps: 2e6, availReqPct: 99.0 }),
        flow('f2', '云台控制与配置下发', 'ctr', 'pole', { dir: 'ab', rateAbBps: 64000, latReqMs: 2000 })
      ]
    })
  },

  // ── 应急 ──
  {
    id: 'tpl.emg.uav', zh: '应急 · 三断场景无人机救援', industry: '应急', tags: ['应急', '低空', '无人机', 'Ka'],
    hint: '灾区断路断网断电：无人机挂 Ka 相控阵 + LTE 空中基站，卫星回传指挥中心',
    build: () => ({
      modules: [
        mod('uav', 'veh.uav.fixed', '中型固定翼无人机', at(P.liangshan[0], P.liangshan[1], 3000)),
        mod('ka', 'mob.ka.uav.pa045', 'Ka 相控阵 0.45 m', on('uav')),
        mod('abs', 'net.airbs', 'LTE 空中基站', on('uav')),
        satMod('sat', 'cs16', '中星 16 号', HTS_BEAM(30, 12, 60)),
        mod('hub', 'es.hub.ka.gw', 'Ka 信关站', pt('beijing', { rainRate: 42, availPct: 99.9 })),
        mod('cmd', 'ctr.cmd', '应急指挥中心', pt('chengdu')),
        mod('veh', 'veh.cmdcar', '前突指挥车', pt('liangshan')),
        mod('manet', 'net.manet', '自组网电台', on('veh'))
      ],
      links: [
        link('l0', 'abs', 'lan1', 'ka', 'lan1', 'cat6', { lengthM: 3, ratePreset: '1000BASE-T' }),
        link('l1', 'ka', 'rf', 'sat', 'rf', 'sat_ka', KA_AIR()),
        link('l2', 'sat', 'rf', 'hub', 'rf', 'sat_ka', KA_AIR()),
        link('l3', 'hub', 'wan', 'cmd', 'wan', 'leased_mstp', { rateBps: 1e9, latencyMs: 12, availPct: 99.9 })
      ],
      flows: [
        flow('f1', '灾情视频与话音', 'abs', 'cmd', { rateAbBps: 4e6, rateBaBps: 2e6, availReqPct: 99.0, latReqMs: 500 })
      ]
    })
  },
  {
    id: 'tpl.emg.pole', zh: '应急 · 叫应杆与应急广播', industry: '应急', tags: ['应急', '预警', '基层', '天启'],
    hint: '★ 一上一下两条不同形态的链：卫星广播单向下发（预警），天启报文双向（叫应回执）',
    build: () => ({
      modules: [
        mod('pole', 'sens.emg.pole', '村口应急叫应杆', pt('motuo', { availPct: 99.0 })),
        mod('spk', 'sens.emg.broadcast', '应急广播大喇叭', pt('motuo')),
        mod('pv', 'pwr.pv200', '太阳能 200 Wp', on('pole')),
        satMod('tq', 'tq1', '天启一期', { sat: { gt: -12, eirp: 12 } }),
        mod('gs', 'es.hub.tq.gs', '天启地面站', pt('beijing', { availPct: 99.5 })),
        satMod('cs', 'cs6c', '中星 6C（广播）', IOT_SLICE(2, 2.5, 46)),
        mod('bhub', 'es.hub.c.11m', '广播上行站', pt('beijing', { rainRate: 42, availPct: 99.9 })),
        mod('cmd', 'ctr.cmd', '县应急指挥中心', pt('lhasa'))
      ],
      links: [
        link('l0', 'spk', 'sat', 'cs', 'rf', 'sat_c', C_AIR()),
        link('l1', 'cs', 'rf', 'bhub', 'rf', 'sat_c', C_AIR()),
        link('l2', 'bhub', 'wan', 'cmd', 'wan', 'leased_mstp', { rateBps: 100e6, latencyMs: 8, availPct: 99.95 }),
        link('l3', 'pole', 'sat', 'tq', 'rf', 'sat_uhf', UHF_AIR()),
        link('l4', 'tq', 'rf', 'gs', 'rf', 'sat_uhf', UHF_AIR()),
        link('l5', 'gs', 'wan', 'cmd', 'wan', 'leased_mstp', { rateBps: 100e6, latencyMs: 10, availPct: 99.9 })
      ],
      flows: [
        // ★ 广播是单向的：只有下发，没有返向
        flow('f1', '预警广播下发', 'cmd', 'spk', { dir: 'ab', rateAbBps: 64000, availReqPct: 99.5, latReqMs: 5000 }),
        // 叫应是双向的：上行呼叫 + 下行应答
        flow('f2', '叫应报文', 'pole', 'cmd', { dir: 'bidir', rateAbBps: 1200, rateBaBps: 1200, availReqPct: 95.0 })
      ]
    })
  },
  {
    id: 'tpl.emg.robotdog', zh: '应急 · 机器狗管廊巡检', industry: '应急', tags: ['应急', '机器人', 'Mesh', '巡检'],
    hint: '机器狗 —WiFi Mesh 多跳→ 洞口边缘盒 —光纤→ 值班室；地面网中断时切卫星',
    build: () => ({
      modules: [
        mod('dog', 'veh.robotdog', '四足巡检机器人', pt('shenzhen')),
        mod('cam', 'sens.cam.ptz', '双光云台', on('dog')),
        mod('mesh1', 'net.wifi.mesh', '廊内 Mesh 节点 ×4', pt('shenzhen')),
        mod('edge', 'edge.aibox', '洞口边缘盒', pt('shenzhen')),
        mod('sw', 'edge.sw.poe8', 'PoE 交换机', pt('shenzhen')),
        mod('ctr', 'ctr.video.platform', '值班室监控平台', pt('shenzhen'))
      ],
      links: [
        link('l0', 'cam', 'lan', 'dog', 'pay', 'cat6', { lengthM: 1, ratePreset: '1000BASE-T', poe: '802.3at', poeLoadW: 12 }),
        link('l1', 'dog', 'wifi', 'mesh1', 'mesh', 'wifi_mesh', { distM: 120, hops: 4, sameChannel: true, mcs: 3, bwMHz: 40, hTxM: 1, hRxM: 3 }),
        link('l2', 'mesh1', 'lan1', 'sw', 'lan1', 'cat6', { lengthM: 60, ratePreset: '1000BASE-T', poe: '802.3at', poeLoadW: 15 }),
        link('l3', 'sw', 'lan2', 'edge', 'lan1', 'cat6', { lengthM: 5, ratePreset: '1000BASE-T' }),
        link('l4', 'edge', 'lan2', 'ctr', 'lan1', 'smf_1310', { lengthKm: 3.2, txDbm: -3, rxSensDbm: -23, connectors: 4, splices: 2 })
      ],
      flows: [flow('f1', '巡检视频与遥控', 'dog', 'ctr', { rateAbBps: 8e6, rateBaBps: 512000, latReqMs: 200 })]
    })
  },

  // ── 低空 ──
  {
    id: 'tpl.lowalt.nest', zh: '低空 · 无人机机巢常态化巡检', industry: '低空', tags: ['低空', '机巢', '无人机', 'Ka'],
    hint: '★ 复合模块样板：机巢内含固定站 + 边缘盒 + 5G 备份；对空图传、对天卫星、主备双链路',
    build: () => ({
      modules: [
        mod('nest', 'veh.dronenest', '无人机机巢', pt('daqing', { rainRate: 35, availPct: 99.0 })),
        mod('uav', 'veh.uav.multi', '巡检多旋翼', at(P.daqing[0] + 0.05, P.daqing[1], 250)),
        mod('cam', 'sens.cam.ptz', '机载云台', on('uav')),
        mod('vtx', 'net.video.tx', '图传发射机', on('uav')),
        satMod('sat', 'cs26', '中星 26 号', HTS_BEAM(40, 13, 61)),
        mod('hub', 'es.hub.ka.gw', 'Ka 信关站', pt('beijing', { rainRate: 42, availPct: 99.9 })),
        mod('ctr', 'ctr.dc', '巡检运营平台', pt('beijing'))
      ],
      links: [
        link('l0', 'cam', 'lan', 'vtx', 'lan1', 'cat6', { lengthM: 1, ratePreset: '1000BASE-T' }),
        link('l1', 'vtx', 'air', 'nest', 'video', 'video_58', { distM: 6000, hTxM: 250, hRxM: 12, txDbm: 27, gRxDbi: 12, sensDbm: -92 }),
        link('l2', 'nest', 'sat', 'sat', 'rf', 'sat_ka', KA_AIR()),
        link('l3', 'sat', 'rf', 'hub', 'rf', 'sat_ka', KA_AIR()),
        link('l4', 'hub', 'wan', 'ctr', 'wan1', 'leased_mstp', { rateBps: 1e9, latencyMs: 6, availPct: 99.95 }),
        // 主备：机巢的 5G 是备份通道（role='backup'，路径求解优先走主路）
        link('l5', 'nest', 'cell', 'ctr', 'wan2', 'cellular_5g', { rateBps: 100e6, rateUpBps: 30e6, latencyMs: 25, availPct: 99.0, covered: true }, 'backup')
      ],
      flows: [
        flow('f1', '巡检视频回传', 'vtx', 'ctr', { dir: 'ab', rateAbBps: 4e6, availReqPct: 99.0 }),
        flow('f2', '机巢遥测与任务下发', 'nest', 'ctr', { rateAbBps: 512000, rateBaBps: 512000, latReqMs: 500 })
      ]
    })
  },

  // ── 交通 ──
  {
    id: 'tpl.road.slope', zh: '交通 · 公路边坡监测（含边坡雷达）', industry: '交通', tags: ['交通', '地灾', '边坡雷达'],
    hint: '★ 边坡雷达是数据源不是通信设备：分钟级一幅形变图（MB 级），本地成图后再回传',
    build: () => ({
      modules: [
        mod('radar', 'sens.slope.radar', '地基边坡雷达', pt('liangshan')),
        mod('gnss', 'sens.geo.gnss', 'GNSS 位移站 ×6', pt('liangshan')),
        mod('crack', 'sens.geo.crack', '裂缝计 / 泥位计', pt('liangshan')),
        mod('rtu', 'edge.rtu', '现场 RTU', pt('liangshan')),
        mod('edge', 'edge.aibox', '现场边缘盒', pt('liangshan')),
        mod('es', 'es.ka.unattended.045', 'Ka 无人值守站', pt('liangshan', { rainRate: 45, availPct: 99.0 })),
        mod('gen', 'pwr.genset', '柴油发电机', on('radar')),
        satMod('sat', 'cs16', '中星 16 号', HTS_BEAM(20, 12, 60)),
        mod('hub', 'es.hub.ka.gw', 'Ka 信关站', pt('chengdu', { rainRate: 48, availPct: 99.9 })),
        mod('ctr', 'ctr.cmd', '公路应急指挥中心', pt('chengdu'))
      ],
      links: [
        link('l0', 'radar', 'lan1', 'edge', 'lan1', 'cat6a', { lengthM: 60, ratePreset: '1000BASE-T' }),
        link('l0b', 'gnss', 'lan1', 'edge', 'lan2', 'cat6', { lengthM: 90, ratePreset: '100BASE-TX', poe: '802.3af', poeLoadW: 6 }),
        link('l0c', 'crack', 'rs485', 'rtu', 'rs485a', 'rs485', { lengthM: 350, baud: 4800, nodes: 10 }),
        link('l0d', 'rtu', 'lan1', 'edge', 'lan3', 'cat6', { lengthM: 3, ratePreset: '100BASE-TX' }),
        link('l1', 'edge', 'lan2', 'es', 'lan1', 'cat6', { lengthM: 8, ratePreset: '1000BASE-T' }),
        link('l2', 'es', 'rf', 'sat', 'rf', 'sat_ka', KA_AIR()),
        link('l3', 'sat', 'rf', 'hub', 'rf', 'sat_ka', KA_AIR()),
        link('l4', 'hub', 'wan', 'ctr', 'wan', 'leased_mstp', { rateBps: 1e9, latencyMs: 5, availPct: 99.95 })
      ],
      flows: [
        flow('f1', '形变成果回传', 'edge', 'ctr', { dir: 'ab', rateAbBps: 1.2e6, availReqPct: 99.5 }),
        flow('f2', '告警与远程配置', 'edge', 'ctr', { rateAbBps: 32000, rateBaBps: 32000, latReqMs: 3000 })
      ]
    })
  },
  {
    id: 'tpl.cold.container', zh: '交通 · 冷链集装箱全程监控', industry: '交通', tags: ['交通', '冷链', '天启', '海洋'],
    hint: '集装箱终端：陆上走 4G、海上自动切天启卫星（双通道，主备并联）',
    build: () => ({
      modules: [
        mod('box', 'es.tq.container', '冷箱终端', at(25.0, 125.0, 0, { availPct: 99.0 })),
        satMod('sat', 'tq1', '天启一期', { sat: { gt: -12, eirp: 12 } }),
        mod('gs', 'es.hub.tq.gs', '天启地面站', pt('beijing', { availPct: 99.5 })),
        mod('ctr', 'ctr.platform', '冷链监控平台', pt('shenzhen'))
      ],
      links: [
        link('l1', 'box', 'rf', 'sat', 'rf', 'sat_uhf', UHF_AIR()),
        link('l2', 'sat', 'rf', 'gs', 'rf', 'sat_uhf', UHF_AIR()),
        link('l3', 'gs', 'wan', 'ctr', 'wan', 'leased_mstp', { rateBps: 100e6, latencyMs: 12, availPct: 99.9 }),
        link('l4', 'box', 'cell', 'ctr', 'wan2', 'cellular_4g', { rateBps: 10e6, rateUpBps: 2e6, latencyMs: 60, availPct: 95.0, covered: true }, 'backup')
      ],
      flows: [flow('f1', '箱温与位置上报', 'box', 'ctr', { dir: 'ab', rateAbBps: 300, availReqPct: 90.0 })]
    })
  },

  // ── 海洋 ──
  {
    id: 'tpl.marine.ship', zh: '海洋 · 船联网与船岸宽带', industry: '海洋', tags: ['海洋', '动中通', 'AIS', 'Ka'],
    hint: '船载动中通 1.05 m 上宽带、AIS 报位、天启终端做窄带兜底',
    build: () => ({
      modules: [
        mod('ship', 'veh.ship', '远洋货轮', at(20.0, 118.0, 0)),
        mod('vsat', 'mob.ka.ship.105', 'Ka 船载动中通 1.05 m', on('ship')),
        mod('ais', 'sens.ais.classa', 'AIS Class A', on('ship')),
        mod('sw', 'edge.sw.ind', '船载交换机', on('ship')),
        mod('cam', 'sens.cam.ptz', '甲板摄像机 ×4', on('ship')),
        satMod('sat', 'cs19', '中星 19 号', HTS_BEAM(40, 10, 58)),
        mod('hub', 'es.hub.ka.gw', 'Ka 信关站', pt('shenzhen', { rainRate: 65, availPct: 99.7 })),
        mod('ctr', 'ctr.platform', '海星通平台', pt('beijing'))
      ],
      links: [
        link('l0', 'cam', 'lan', 'sw', 'lan1', 'cat6', { lengthM: 70, ratePreset: '1000BASE-T', poe: '802.3at', poeLoadW: 12 }),
        link('l0b', 'sw', 'lan2', 'vsat', 'lan1', 'cat6', { lengthM: 25, ratePreset: '1000BASE-T' }),
        link('l1', 'vsat', 'rf', 'sat', 'rf', 'sat_ka', KA_AIR()),
        link('l2', 'sat', 'rf', 'hub', 'rf', 'sat_ka', KA_AIR()),
        link('l3', 'hub', 'wan', 'ctr', 'wan', 'leased_mstp', { rateBps: 1e9, latencyMs: 15, availPct: 99.95 })
      ],
      flows: [
        flow('f1', '船岸宽带（监控 + 办公）', 'sw', 'ctr', { rateAbBps: 6e6, rateBaBps: 20e6, availReqPct: 99.0 })
      ]
    })
  },

  // ── 村通 ──
  {
    id: 'tpl.village', zh: '村通 · 卫星 + 4G/WiFi 覆盖', industry: '村通', tags: ['村通', '普遍服务', 'Ka'],
    hint: 'Ka 高通量固定站落地后经 RJ45 分给 4G 一体化基站与室外 AP —— 「最后一百米」全在图上',
    build: () => ({
      modules: [
        mod('es', 'es.ka.fixed.098', 'Ka 固定站 0.98 m', pt('motuo', { rainRate: 60, availPct: 99.0 })),
        mod('buc', 'rf.buc', 'BUC 上变频功放', on('es')),
        mod('sw', 'edge.sw.poe8', 'PoE 交换机', pt('motuo')),
        mod('bs', 'net.4gbs', '4G 一体化基站', pt('motuo')),
        mod('ap', 'net.wifi.ap', '室外 WiFi AP', pt('motuo')),
        satMod('sat', 'cs26', '中星 26 号', HTS_BEAM(50, 13, 61)),
        mod('hub', 'es.hub.ka.gw', 'Ka 信关站', pt('chengdu', { rainRate: 48, availPct: 99.9 })),
        mod('core', 'ctr.coreif', '运营商核心网对接点', pt('chengdu'))
      ],
      links: [
        link('l0', 'es', 'ifl', 'buc', 'in', 'ifl_l', { lengthM: 45, cable: 'LMR-400', bucVdc: 24, bucAmps: 3.5, ifMaxLossDb: 25 }),
        link('l1', 'es', 'lan1', 'sw', 'lan1', 'cat6', { lengthM: 30, ratePreset: '1000BASE-T' }),
        link('l2', 'sw', 'lan2', 'bs', 'lan1', 'cat6', { lengthM: 45, ratePreset: '1000BASE-T' }),
        link('l3', 'sw', 'lan3', 'ap', 'lan1', 'cat6', { lengthM: 85, ratePreset: '1000BASE-T', poe: '802.3at', poeLoadW: 15 }),
        link('l4', 'es', 'rf', 'sat', 'rf', 'sat_ka', KA_AIR()),
        link('l5', 'sat', 'rf', 'hub', 'rf', 'sat_ka', KA_AIR()),
        link('l6', 'hub', 'wan', 'core', 'wan', 'leased_mstp', { rateBps: 1e9, latencyMs: 8, availPct: 99.95 })
      ],
      flows: [
        flow('f1', '村内 4G 业务', 'bs', 'core', { rateAbBps: 4e6, rateBaBps: 20e6, availReqPct: 99.0 }),
        flow('f2', 'WiFi 上网', 'ap', 'core', { rateAbBps: 2e6, rateBaBps: 15e6, availReqPct: 98.0 })
      ]
    })
  },

  // ── ToC ──
  {
    id: 'tpl.toc.sos', zh: 'ToC · 户外探险求救', industry: 'ToC', tags: ['ToC', '应急', '天启'],
    hint: '★ 只有上行的单向流：求救报文发出去即可，没有返向业务',
    build: () => ({
      modules: [
        mod('who', 'veh.person', '探险人员', at(35.0, 90.0, 4500)),
        mod('sos', 'es.tq.alarm', '天启 Alarm 求救终端', on('who')),
        satMod('sat', 'tq1', '天启一期', { sat: { gt: -12, eirp: 12 } }),
        mod('gs', 'es.hub.tq.gs', '天启地面站', pt('beijing', { availPct: 99.5 })),
        mod('ctr', 'ctr.cmd', '救援调度中心', pt('beijing'))
      ],
      links: [
        link('l1', 'sos', 'rf', 'sat', 'rf', 'sat_uhf', UHF_AIR({ minElevDeg: 10 })),
        link('l2', 'sat', 'rf', 'gs', 'rf', 'sat_uhf', UHF_AIR()),
        link('l3', 'gs', 'wan', 'ctr', 'wan', 'leased_mstp', { rateBps: 100e6, latencyMs: 10, availPct: 99.9 })
      ],
      flows: [flow('f1', '求救报文', 'sos', 'ctr', { dir: 'ab', rateAbBps: 300, availReqPct: 90.0 })]
    })
  },

  // ── 能源 ──
  {
    id: 'tpl.energy.oil', zh: '能源 · 偏远油井远程监管', industry: '能源', tags: ['能源', '油气', '天启'],
    hint: '油井 RTU —RS485→ 天启终端；井场太阳能供电，能量账与链路账并列',
    build: () => ({
      modules: [
        mod('rtu', 'sens.oil.rtu', '油井 RTU', pt('golmud')),
        mod('tq', 'es.tq.zd10', '天启 TQZD-10', pt('golmud', { availPct: 99.0 })),
        mod('pv', 'pwr.pv100', '太阳能 100 Wp', on('tq')),
        mod('bat', 'pwr.bat.agm65', '铅酸 12 V/65 Ah', on('tq')),
        satMod('sat', 'tq1', '天启一期', { sat: { gt: -12, eirp: 12 } }),
        mod('gs', 'es.hub.tq.gs', '天启地面站', pt('beijing', { availPct: 99.5 })),
        mod('ctr', 'ctr.platform', '油田生产平台', pt('daqing'))
      ],
      links: [
        link('l0', 'rtu', 'rs485', 'tq', 'rs485', 'rs485', { lengthM: 200, baud: 9600, nodes: 4 }),
        link('l1', 'tq', 'rf', 'sat', 'rf', 'sat_uhf', UHF_AIR()),
        link('l2', 'sat', 'rf', 'gs', 'rf', 'sat_uhf', UHF_AIR()),
        link('l3', 'gs', 'wan', 'ctr', 'wan', 'leased_mstp', { rateBps: 100e6, latencyMs: 12, availPct: 99.9 })
      ],
      flows: [flow('f1', '井场工况上报', 'rtu', 'ctr', { dir: 'ab', rateAbBps: 600, availReqPct: 95.0 })]
    })
  }
];

// ═══════════════════════════════════════════════════════════════════════════
// 「按图施工」：模板 → 角色骨架
// ═══════════════════════════════════════════════════════════════════════════
// 一期模板是「整包套用」：双击一下，8 个模块连边带流全落下来 —— 对着改还行，
// 但它没有回答「我这个项目该选哪一款终端」。二期把同一份模板拆成【骨架 + 逐槽选型】：
// 每个模块变成一张【虚线占位卡】（角色 + 该角色能放什么 + 推荐型号），边与流照旧先连好，
// 用户逐槽挑型号、挑完骨架消失。★ 不必先想坐标 —— 那是最后一步，不是第一步。
//
// ★ 骨架是从 build() 【推】出来的，不是另写一份 15 个模板的 blueprint：
//   两份手写数据必然分叉，而「这一槽该放什么」本来就等于「模板在这里放了什么」。
const ROLE_OF = {
  A: { key: 'sat', zh: '卫星' },
  B: { key: 'access', zh: '接入站' },
  C: { key: 'veh', zh: '载体' },
  D: { key: 'end', zh: '感知末端' },
  E: { key: 'edge', zh: '汇聚与边缘' },
  F: { key: 'rf', zh: '射频件' },
  G: { key: 'power', zh: '供电' },
  H: { key: 'core', zh: '中心平台' }
};
// 信关站 / 主站在 B 类里自成一档：它与终端是同一种设备，但在图上是另一个角色
const roleOf = (mod) => {
  if (!mod) return { key: 'end', zh: '感知末端' };
  if (mod.cat === 'B' && mod.group === 'hub') return { key: 'hub', zh: '信关站' };
  return ROLE_OF[mod.cat] || { key: 'end', zh: '感知末端' };
};

/**
 * 模板 → 骨架。出参与 buildTemplate 同构（modules / links / flows 直接可用），
 * 差别是每个模块带 slot 元信息且 pending:true —— 渲染端据此画成虚线占位卡。
 * @param libList 模块库清单（sceneLibrary.listModules 的结果）：用来算每一槽的候选型号
 */
function blueprintOf(id, libList) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  const s = t.build();
  const lib = libList || [];
  const byId = new Map(lib.map((m) => [m.id, m]));
  const modules = s.modules.map((m, i) => {
    if (m.kind === 'sat') {
      // 卫星槽：候选来自平台卫星库（渲染端那份），core 这里只给角色与预置 key
      return Object.assign({}, m, {
        pending: true,
        slot: { key: 'slot' + i, role: 'sat', zh: '卫星', accept: { kind: 'sat' }, recommend: [], preset: m.preset }
      });
    }
    const base = byId.get(m.libId) || null;
    const r = roleOf(base);
    // 候选＝同类同组的全部条目（同组是最贴的一档；同组只有它自己就放宽到同类）
    let rec = lib.filter((x) => base && x.cat === base.cat && x.group === base.group).map((x) => x.id);
    if (rec.length < 2 && base) rec = lib.filter((x) => x.cat === base.cat).map((x) => x.id);
    return Object.assign({}, m, {
      pending: true,
      slot: {
        key: 'slot' + i, role: r.key, zh: r.zh,
        accept: { cats: base ? [base.cat] : [], group: base ? base.group : '' },
        recommend: rec.slice(0, 40)
      }
    });
  });
  return { name: t.zh, tplId: t.id, industry: t.industry, hint: t.hint, modules, links: s.links, flows: s.flows };
}

/** 步进条：骨架里出现过的角色，按「末端 → 接入 → 卫星 → 信关 → 中心」的读图序 */
const ROLE_ORDER = ['end', 'veh', 'rf', 'power', 'edge', 'access', 'sat', 'hub', 'core'];
function blueprintSteps(bp) {
  if (!bp) return [];
  const seen = new Map();
  for (const m of bp.modules || []) {
    const r = (m.slot && m.slot.role) || 'end';
    if (!seen.has(r)) seen.set(r, { role: r, zh: (m.slot && m.slot.zh) || r, n: 0 });
    seen.get(r).n++;
  }
  return [...seen.values()].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
}

const listTemplates = () => TEMPLATES.map((t) => ({ id: t.id, zh: t.zh, industry: t.industry, tags: t.tags, hint: t.hint }));
const industries = () => [...new Set(TEMPLATES.map((t) => t.industry))];
function buildTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  const s = t.build();
  return { name: t.zh, tplId: t.id, industry: t.industry, hint: t.hint, modules: s.modules, links: s.links, flows: s.flows };
}

module.exports = { TEMPLATES, listTemplates, industries, buildTemplate, blueprintOf, blueprintSteps, roleOf, ROLE_ORDER };
