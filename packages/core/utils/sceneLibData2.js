// utils/sceneLibData2.js
// 内置模块库 · 第二部分：C 移动平台 / D 感知末端 / E 汇聚边缘 / F 射频器件 / G 供电 / H 中心平台。
// （A 空间段 与 B 地面固定站 在 sceneLibData.js；字段说明见那个文件的头注）
//
// 分两个文件纯粹是为了单文件别太长：sceneLibrary.js 把两份拼成一张表，对外只有一个库。

'use strict';

const { p, PORT_RJ45, PORT_DC, PORT_AC, PORT_485, es } = require('./sceneLibData.js');

// 通用构造器：给一份缺省壳，各类再覆盖
const mk = (cat, id, zh, o) => Object.assign({
  id, cat, group: o.group || 'misc', zh, en: o.en || zh, symbol: o.symbol || 'sensor',
  ports: o.ports || [PORT_DC(12)],
  place: o.place || { modes: ['fixed'], mountable: false, hostCats: [] },
  typical: o.typical !== false,
  tags: o.tags || [],
  src: o.src || '[类型] 该类设备行业通行典型值'
}, {
  rf: o.rf, sat: o.sat, phy: o.phy, power: o.power, env: o.env,
  antenna: o.antenna, sense: o.sense, children: o.children, radio: o.radio, supply: o.supply
});

// ═══════════════════════════════════════════════════════════════════════════
// C 移动平台（会动的载体：几何跟航迹 / 轨道；射频终端可挂在它上面）
// ═══════════════════════════════════════════════════════════════════════════
const MOBILE_PLACE = { modes: ['traj', 'fixed'], mountable: false, hostCats: [] };
const AIR_PLACE = { modes: ['traj', 'fixed'], mountable: false, hostCats: [] };

const PLATFORMS = [
  // ── 卫通动中通终端（本身是终端，但装在载体上）──
  mk('C', 'mob.ka.veh.045', 'Ka 车载动中通 0.45 m', {
    group: 'satcom-mobile', symbol: 'flatpanel',
    rf: es(0.45, 6, { antennaEfficiency: 55, feederLoss: 0.8 }),
    phy: { rateDnBps: 40e6, rateUpBps: 6e6 },
    power: { alwaysW: 180, supply: 'dc_24' },
    env: { ip: 'IP65', tempMin: -30, tempMax: 55, massKg: 46 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(2), PORT_DC(24)],
    place: { modes: ['traj', 'mounted', 'fixed'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '政企', '动中通'], typical: false,
    src: '[卫通] 政企互联：0.45 m 车载动中通，下行 40 / 上行 6 Mbps，≤46 kg'
  }),
  mk('C', 'mob.ka.veh.03', 'Ka 消费级车载动中通 0.3 m', {
    group: 'satcom-mobile', symbol: 'flatpanel',
    rf: es(0.3, 4, { antennaEfficiency: 52 }),
    phy: { rateDnBps: 40e6, rateUpBps: 6e6 },
    power: { alwaysW: 110, supply: 'dc_12' },
    env: { ip: 'IP65', tempMin: -30, tempMax: 55, massKg: 13 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(1), p('wifi', 'wifi_5g', 'trx', 'data', 'WiFi 热点'), PORT_DC(12)],
    place: { modes: ['traj', 'mounted', 'fixed'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '移动数据', '动中通'], typical: false,
    src: '[卫通] 移动数据：等效 0.3 m，≤13 kg（含底座）'
  }),
  mk('C', 'mob.ka.ship.105', 'Ka 高性能船载动中通 1.05 m', {
    group: 'satcom-mobile', symbol: 'dish',
    rf: es(1.05, 25, { antennaEfficiency: 62, feederLoss: 1.2 }),
    phy: { rateDnBps: 100e6, rateUpBps: 10e6 },
    power: { alwaysW: 900, supply: 'ac_mains' },
    env: { ip: 'IP66', tempMin: -30, tempMax: 55, massKg: 130 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(2), PORT_AC()],
    place: { modes: ['traj', 'mounted', 'fixed'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '海洋', '动中通'], typical: false,
    src: '[卫通] 移动数据：等效 1.05 m，下行 100 / 上行 10 Mbps，≤130 kg（含罩）'
  }),
  mk('C', 'mob.ka.aero', '航空 Ka 机载终端', {
    group: 'satcom-mobile', symbol: 'flatpanel',
    rf: es(0.6, 40, { antennaEfficiency: 55, feederLoss: 1.5 }),
    phy: { rateDnBps: 188e6, rateUpBps: 12e6 },
    power: { alwaysW: 1200, supply: 'ac_mains' },
    env: { tempMin: -55, tempMax: 70, massKg: 120 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(2), p('wifi', 'wifi_5g', 'trx', 'data', '客舱 WiFi'), PORT_AC()],
    place: { modes: ['traj', 'mounted'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '航空'], src: '[卫通] 航空互联网：实测下载 188 Mbps（青岛航空首航）'
  }),

  // ── 低空无人终端（卫通五档，产品册原文）──
  mk('C', 'mob.ka.uav.pa045', 'Ka 无人及低空高速相控阵 0.45 m', {
    group: 'lowalt', symbol: 'phasedarray',
    rf: es(0.45, 10, { antennaEfficiency: 50, feederLoss: 1.0 }),
    phy: { rateDnBps: 60e6, rateUpBps: 20e6 },
    power: { alwaysW: 250, supply: 'dc_28' },
    env: { tempMin: -45, tempMax: 70, massKg: 15 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(1), PORT_DC(24)],
    place: { modes: ['mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '低空', '无人机'], typical: false,
    src: '[卫通] 低空无人：等效 0.45 m 相控阵，上行 20 / 下行 60 Mbps，≤15 kg（含罩）'
  }),
  mk('C', 'mob.ka.uav.par035', 'Ka 无人及低空高速抛物面 0.35 m', {
    group: 'lowalt', symbol: 'dish',
    rf: es(0.35, 8, { antennaEfficiency: 58 }),
    phy: { rateDnBps: 90e6, rateUpBps: 10e6 },
    power: { alwaysW: 150, supply: 'dc_24' },
    env: { tempMin: -45, tempMax: 70, massKg: 6 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(1), PORT_DC(24)],
    place: { modes: ['mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '低空', '无人机'], typical: false,
    src: '[卫通] 低空无人：等效 0.35 m，上行 10 / 下行 90 Mbps，≤6 kg（不含罩）'
  }),
  mk('C', 'mob.ka.uav.par02', 'Ka 无人及低空中速抛物面 0.2 m', {
    group: 'lowalt', symbol: 'dish',
    rf: es(0.2, 4, { antennaEfficiency: 55 }),
    phy: { rateDnBps: 2e6, rateUpBps: 2e6 },
    power: { alwaysW: 70, supply: 'dc_24' },
    env: { tempMin: -45, tempMax: 70, massKg: 4 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(1), PORT_DC(24)],
    place: { modes: ['mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '低空', '无人机'], typical: false,
    src: '[卫通] 低空无人：等效 0.2 m，2 Mbps 双向，≤4 kg'
  }),
  mk('C', 'mob.ka.uav.pa02', 'Ka 无人及低空中速一维相控阵 0.2 m', {
    group: 'lowalt', symbol: 'phasedarray',
    rf: es(0.2, 4, { antennaEfficiency: 45 }),
    phy: { rateDnBps: 1e6, rateUpBps: 1e6 },
    power: { alwaysW: 80, supply: 'dc_24' },
    env: { tempMin: -45, tempMax: 70, massKg: 5 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(1), PORT_DC(24)],
    place: { modes: ['mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '低空', '无人机'], typical: false,
    src: '[卫通] 低空无人：一维相控阵，1 Mbps 双向，≤5 kg'
  }),
  mk('C', 'mob.ka.uav.pa01', 'Ka 无人及低空低速二维相控阵 0.1 m', {
    group: 'lowalt', symbol: 'phasedarray',
    rf: es(0.1, 2, { antennaEfficiency: 40 }),
    phy: { rateDnBps: 128e3, rateUpBps: 128e3 },
    power: { alwaysW: 40, supply: 'dc_12' },
    env: { tempMin: -45, tempMax: 70, massKg: 3 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), ...PORT_RJ45(1), PORT_DC(12)],
    place: { modes: ['mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['卫通', '低空', '无人机'], typical: false,
    src: '[卫通] 低空无人：二维相控阵，128 kbps 双向，≤3 kg（含罩）'
  }),

  // ── 载体本身（不带射频，射频终端挂上去）──
  mk('C', 'veh.uav.multi', '多旋翼无人机', {
    group: 'uav', symbol: 'drone-multi',
    phy: { payloadKg: 5, enduranceMin: 45, ceilingM: 500, cruiseMs: 15 },
    power: { alwaysW: 0, supply: 'battery' },
    env: { tempMin: -20, tempMax: 50, massKg: 12 },
    ports: [p('pay', 'cat6', 'trx', 'data', '载荷仓网口'), PORT_DC(24)],
    place: AIR_PLACE, tags: ['低空', '无人机', '应急', '电力', '林草'],
    src: '[低空] 城市管理/巡检类多旋翼典型：续航 >30 min，作业高度 ~100 m'
  }),
  mk('C', 'veh.uav.vtol', '复合翼（垂起固定翼）无人机', {
    group: 'uav', symbol: 'drone-vtol',
    phy: { payloadKg: 10, enduranceMin: 240, ceilingM: 3000, cruiseMs: 28 },
    env: { tempMin: -30, tempMax: 50, massKg: 45 },
    ports: [p('pay', 'cat6', 'trx', 'data', '载荷仓网口'), PORT_DC(24)],
    place: AIR_PLACE, tags: ['低空', '无人机', '测绘', '应急'],
    src: '[低空] 中型复合翼：续航 4 h 量级，测绘/长航时巡检'
  }),
  mk('C', 'veh.uav.fixed', '大型固定翼无人机', {
    group: 'uav', symbol: 'drone-fixed',
    phy: { payloadKg: 200, enduranceMin: 1200, ceilingM: 7000, cruiseMs: 50 },
    env: { tempMin: -50, tempMax: 50, massKg: 1500 },
    ports: [p('pay', 'cat6', 'trx', 'data', '任务载荷网口'), PORT_AC()],
    place: AIR_PLACE, tags: ['低空', '无人机', '应急'],
    src: '[卫通] 翼龙-Ⅱ / 彩虹-4 一类：曾用于挂载 LTE 基站做应急空中覆盖'
  }),
  mk('C', 'veh.uav.heli', '无人直升机', {
    group: 'uav', symbol: 'drone-heli',
    phy: { payloadKg: 80, enduranceMin: 300, ceilingM: 4000, cruiseMs: 35 },
    env: { massKg: 500 },
    ports: [p('pay', 'cat6', 'trx', 'data', '任务载荷网口'), PORT_DC(28)],
    place: AIR_PLACE, tags: ['低空', '无人机', '应急'],
    src: '[卫通] 航空应急无人机型谱之一'
  }),
  mk('C', 'veh.evtol', 'eVTOL 载人航空器', {
    group: 'uav', symbol: 'evtol',
    phy: { payloadKg: 220, enduranceMin: 30, ceilingM: 600, cruiseMs: 36 },
    env: { massKg: 650 },
    ports: [p('pay', 'cat6', 'trx', 'data', '航电网口'), PORT_DC(48)],
    place: AIR_PLACE, tags: ['低空', 'eVTOL'],
    src: '[低空] 交通文旅（载人）：飞行高度 300–600 m，控制可靠性 >99.999%、时延 <10 ms'
  }),
  mk('C', 'veh.dronenest', '无人机机巢', {
    group: 'uav', symbol: 'dronenest',
    // ★ 复合模块的样板：机巢是个壳，里面装固定站 + 边缘盒 + 备份链路 + 供电，
    //   向外暴露一组端口。子模块清单见 children。
    // ★ 复合模块只要对外暴露射频口，就必须自带 rf —— 引擎从这个节点取发信参数，
    //   它不会自己去翻 children。这里的值取自主射频子模块（Ka 无人值守站 0.45 m + 4 W）。
    rf: es(0.45, 4, { antennaEfficiency: 60, feederLoss: 0.8, rxAntennaEfficiency: 62, rxReceiverNoiseTemp: 90 }),
    power: { alwaysW: 350, supply: 'ac_mains' },
    env: { ip: 'IP55', tempMin: -30, tempMax: 55, massKg: 400, sizeMm: '2200×2200×1800' },
    ports: [
      p('sat', 'sat_ka', 'trx', 'data', '卫星回传'),
      p('cell', 'cellular_5g', 'trx', 'data', '5G 备份'),
      p('video', 'video_58', 'trx', 'data', '图传对空'),
      ...PORT_RJ45(4), PORT_AC()
    ],
    children: ['es.ka.unattended.045', 'edge.aibox', 'edge.sw.poe8', 'net.5gcpe'],
    place: { modes: ['fixed'], mountable: false },
    tags: ['低空', '无人机', '机巢', '电力', '应急'],
    src: '[低空] 无人机自动机巢：起降 + 换电 + 边缘计算 + 双链路回传'
  }),
  mk('C', 'veh.tether.uav', '系留无人机（空中基站）', {
    group: 'uav', symbol: 'drone-tether',
    phy: { ceilingM: 150, enduranceMin: 1440 },
    power: { alwaysW: 2000, supply: 'ac_mains' },
    env: { massKg: 30 },
    ports: [p('pay', 'cat6', 'trx', 'data', '载荷网口（随系留缆）'), p('tether', 'ac_mains', 'rx', 'power', '系留供电')],
    place: { modes: ['fixed'], mountable: false },
    tags: ['低空', '应急', '空中基站'],
    src: '[低空] 系留升空 100–150 m，地面供电，长时驻空；应急通信覆盖常用'
  }),
  mk('C', 'veh.balloon', '系留气球 / 浮空器', {
    group: 'uav', symbol: 'balloon',
    phy: { ceilingM: 1000, enduranceMin: 43200 },
    env: { massKg: 200 },
    ports: [p('pay', 'cat6', 'trx', 'data', '载荷网口'), p('tether', 'ac_mains', 'rx', 'power', '系留供电')],
    place: { modes: ['fixed'], mountable: false }, tags: ['应急', '空中基站'],
    src: '[类型] 系留浮空平台：长时驻空广域覆盖'
  }),
  mk('C', 'veh.robotdog', '四足机器人（机器狗）', {
    group: 'robot', symbol: 'robot-dog',
    phy: { payloadKg: 10, enduranceMin: 120, cruiseMs: 1.5 },
    power: { alwaysW: 0, supply: 'battery' },
    env: { ip: 'IP54', tempMin: -20, tempMax: 55, massKg: 50 },
    ports: [p('pay', 'cat6', 'trx', 'data', '载荷网口'), p('wifi', 'wifi_5g', 'trx', 'data', 'WiFi'), p('cell', 'cellular_5g', 'trx', 'data', '5G'), PORT_DC(24)],
    place: { modes: ['traj', 'fixed'], mountable: false },
    tags: ['电力', '应急', '巡检', '机器人'],
    src: '[类型] 变电站/管廊/矿山巡检四足平台：全景相机 + 双光云台 + 气体传感，现有回传以 5G/WiFi 为主'
  }),
  mk('C', 'veh.robotwheel', '轮式巡检机器人', {
    group: 'robot', symbol: 'robot-wheel',
    phy: { payloadKg: 30, enduranceMin: 480, cruiseMs: 1.0 },
    env: { ip: 'IP66', tempMin: -25, tempMax: 55, massKg: 120 },
    ports: [p('pay', 'cat6', 'trx', 'data', '载荷网口'), p('wifi', 'wifi_5g', 'trx', 'data', 'WiFi'), PORT_DC(24)],
    place: { modes: ['traj', 'fixed'], mountable: false }, tags: ['电力', '巡检', '机器人'],
    src: '[类型] 户外变电站轮式巡检平台'
  }),
  mk('C', 'veh.robotrail', '挂轨巡检机器人', {
    group: 'robot', symbol: 'robot-rail',
    phy: { cruiseMs: 1.5 }, env: { ip: 'IP65', massKg: 40 },
    ports: [p('pay', 'cat6', 'trx', 'data', '载荷网口'), PORT_DC(48)],
    place: { modes: ['traj', 'fixed'], mountable: false }, tags: ['电力', '管廊', '巡检', '机器人'],
    src: '[类型] 综合管廊 / 电缆隧道挂轨平台，沿轨供电'
  }),
  mk('C', 'veh.usv', '无人船 (USV)', {
    group: 'marine', symbol: 'usv',
    phy: { payloadKg: 100, enduranceMin: 1440, cruiseMs: 5 },
    env: { ip: 'IP67', massKg: 800 },
    ports: [p('pay', 'cat6', 'trx', 'data', '载荷网口'), p('vhf', 'vhf_data', 'trx', 'data', 'VHF'), PORT_DC(24)],
    place: { modes: ['traj', 'fixed'], mountable: false }, tags: ['海洋', '水利', '机器人'],
    src: '[类型] 水面无人测量/巡检平台'
  }),
  mk('C', 'veh.ship', '船舶', {
    group: 'marine', symbol: 'vehicle-ship',
    env: { massKg: 5000000 },
    ports: [p('deck', 'cat6', 'trx', 'data', '甲板网口'), PORT_AC()],
    place: { modes: ['traj', 'fixed'], mountable: false }, tags: ['海洋'],
    src: '[卫通] 在网服务船舶超 28000 艘，覆盖 95% 以上全球主要航线'
  }),
  mk('C', 'veh.car', '车辆', {
    group: 'vehicle', symbol: 'vehicle-car',
    ports: [p('obd', 'can', 'trx', 'data', 'CAN 总线'), PORT_DC(12)],
    place: { modes: ['traj', 'fixed'], mountable: false }, tags: ['交通'],
    src: '[类型] 通用车辆载体'
  }),
  mk('C', 'veh.cmdcar', '应急指挥车', {
    group: 'vehicle', symbol: 'vehicle-truck',
    power: { alwaysW: 3000, supply: 'genset' },
    env: { massKg: 8000 },
    ports: [p('sat', 'sat_ka', 'trx', 'data', '车载卫通'), ...PORT_RJ45(4), p('manet', 'manet', 'trx', 'data', '自组网'), p('gen', 'ac_mains', 'rx', 'power', '发电机')],
    children: ['mob.ka.veh.045', 'net.manet', 'edge.sw.poe8'],
    place: { modes: ['traj', 'fixed'], mountable: false }, tags: ['应急', '指挥'],
    src: '[类型] 应急通信指挥车：卫通 + 自组网 + 图传接收 + 发电'
  }),
  mk('C', 'veh.excavator', '工程机械', {
    group: 'vehicle', symbol: 'excavator',
    ports: [p('can', 'can', 'trx', 'data', 'CAN 总线'), PORT_DC(24)],
    place: { modes: ['traj', 'fixed'], mountable: false }, tags: ['交通', '工程机械'],
    src: '[天启] 交通行业应用：工程机械位置与运行状态监测'
  }),
  mk('C', 'veh.person', '人员 / 单兵', {
    group: 'person', symbol: 'person',
    ports: [p('bt', 'ble', 'trx', 'data', '蓝牙')],
    place: { modes: ['traj', 'fixed'], mountable: false }, tags: ['应急', 'ToC', '林草'],
    src: '[天启] 应急 · 人员管理：搜救与巡检人员实时定位、轨迹跟踪与紧急报警'
  })
];

// ═══════════════════════════════════════════════════════════════════════════
// D 感知末端（业务流的源头；多数不带射频，靠 E 类汇聚上星）
// ═══════════════════════════════════════════════════════════════════════════
// sense：{ kind, bytesPerSample, samplesPerDay } —— 业务流速率就是从这三个数推出来的：
//   平均速率 = bytesPerSample × 8 × samplesPerDay / 86400
const sens = (kind, bytes, perDay) => ({ kind, bytesPerSample: bytes, samplesPerDay: perDay });

const D = (id, zh, o) => mk('D', 'sens.' + id, zh, o);

const SENSORS = [
  // ── 电力 ──
  D('meter.concentrator', '电表集中器（台区集中器）', {
    group: 'power', symbol: 'meter',
    sense: sens('meter', 220, 96),          // 每 15 min 一次冻结量，一条 ~220 B
    power: { alwaysW: 5, supply: 'ac_mains' },
    env: { ip: 'IP54', tempMin: -25, tempMax: 60 },
    ports: [p('hplc', 'hplc', 'trx', 'data', 'HPLC 载波（下行抄表）'), ...PORT_RJ45(1), PORT_485(), PORT_AC()],
    tags: ['电力', '营销计量'],
    src: '[卫通] 电力应用：偏远地区营销计量。载波抄表 15 min 冻结，Q/GDW 11612'
  }),
  D('meter.single', '智能电表', {
    group: 'power', symbol: 'meter', sense: sens('meter', 64, 96),
    power: { alwaysW: 1, supply: 'ac_mains' },
    ports: [p('hplc', 'hplc', 'trx', 'data', 'HPLC 载波'), PORT_485(), PORT_AC()],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['D', 'E'] },
    tags: ['电力', '营销计量'], src: '[类型] 单/三相智能电表，DL/T 645 规约'
  }),
  D('pole.tilt', '杆塔倾斜监测装置', {
    group: 'power', symbol: 'tower', sense: sens('tilt', 48, 24),
    power: { txW: 0.5, sleepW: 0.001, supply: 'solar' },
    env: { ip: 'IP67', tempMin: -40, tempMax: 70 },
    ports: [PORT_485(), PORT_DC(12)],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['D', 'E'] },
    tags: ['电力', '输电'], src: '[天启] 能源行业：输电线路电压、电流及杆塔倾斜的远程监测'
  }),
  D('line.temp', '导线测温装置', {
    group: 'power', symbol: 'sensor', sense: sens('temp', 32, 144),
    power: { txW: 0.3, sleepW: 0.0005, supply: 'battery' },
    env: { ip: 'IP67', tempMin: -40, tempMax: 125 },
    ports: [p('rf', 'ism_433', 'tx', 'data', '433 MHz 上传')],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['D'] },
    tags: ['电力', '输电'], src: '[类型] 导线温度在线监测（取能式）'
  }),
  D('line.cam', '输电线路可视化装置', {
    group: 'power', symbol: 'camera', sense: sens('image', 180 * 1024, 24),
    power: { txW: 4, idleW: 0.3, sleepW: 0.002, supply: 'solar' },
    env: { ip: 'IP66', tempMin: -40, tempMax: 70 },
    ports: [p('cell', 'cellular_4g', 'trx', 'data', '4G'), PORT_485(), PORT_DC(12)],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['D', 'E'] },
    tags: ['电力', '输电'], src: '[类型] 输电通道微拍装置：定时抓拍 + 图片回传'
  }),
  D('line.galloping', '导线舞动监测', {
    group: 'power', symbol: 'sensor', sense: sens('vib', 2048, 48),
    power: { txW: 1.2, sleepW: 0.002, supply: 'solar' },
    ports: [PORT_485(), PORT_DC(12)], tags: ['电力', '输电'],
    src: '[类型] 舞动/覆冰在线监测'
  }),
  D('dtu', '配电终端 DTU/FTU/TTU', {
    group: 'power', symbol: 'cabinet', sense: sens('scada', 512, 2880),
    power: { alwaysW: 15, supply: 'ac_mains' },
    env: { ip: 'IP54', tempMin: -40, tempMax: 70 },
    ports: [...PORT_RJ45(2), PORT_485(), PORT_AC()],
    tags: ['电力', '配电', '三遥'],
    src: '[卫通] 电力应用：无网区域配电三遥（遥测/遥信/遥控）'
  }),
  D('wind.turbine', '风机状态监测', {
    group: 'power', symbol: 'windturbine', sense: sens('scada', 1024, 1440),
    power: { alwaysW: 20, supply: 'ac_mains' },
    ports: [...PORT_RJ45(1), PORT_485(), PORT_AC()], tags: ['能源', '风电'],
    src: '[天启] 能源行业 · 风机监测：风机周边环境与发电机运行状态'
  }),
  D('oil.rtu', '油井 RTU', {
    group: 'power', symbol: 'wellhead', sense: sens('scada', 256, 288),
    power: { alwaysW: 6, supply: 'solar' },
    env: { ip: 'IP66', tempMin: -40, tempMax: 70 },
    ports: [PORT_485(), PORT_DC(12)], tags: ['能源', '油气'],
    src: '[天启] 能源行业 · 油井监测：采油机运行状态与井场环境参数'
  }),
  D('pipe.das', '管道泄漏监测（光纤 DAS）', {
    group: 'power', symbol: 'sensor', sense: sens('das', 4 * 1024 * 1024, 1440),
    power: { alwaysW: 120, supply: 'ac_mains' },
    ports: [p('fib', 'smf_1550', 'trx', 'data', '传感光缆'), ...PORT_RJ45(1), PORT_AC()],
    tags: ['能源', '油气'], src: '[类型] 分布式声波传感：数据量大，须本地处理后再回传'
  }),

  // ── 水利 ──
  D('water.level', '水位计（雷达 / 超声 / 压力）', {
    group: 'water', symbol: 'water', sense: sens('level', 32, 288),
    power: { txW: 0.8, sleepW: 0.0005, supply: 'solar' },
    env: { ip: 'IP68', tempMin: -30, tempMax: 70 },
    ports: [PORT_485(), PORT_DC(12)],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['D', 'E'] },
    tags: ['水利', '应急'], src: '[天启] 水利行业：河道水位、雨量、水质等多维环境数据'
  }),
  D('water.rain', '雨量计（翻斗式）', {
    group: 'water', symbol: 'water', sense: sens('rain', 24, 288),
    power: { sleepW: 0.0002, supply: 'battery' },
    env: { ip: 'IP66' }, ports: [PORT_485(), PORT_DC(12)],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['D', 'E'] },
    tags: ['水利', '气象'], src: '[天启] 天启气象监测站雨量要素：量程 0–999.9 mm，分辨率 0.2 mm'
  }),
  D('water.flow', '流量计', {
    group: 'water', symbol: 'water', sense: sens('flow', 48, 288),
    power: { alwaysW: 2, supply: 'solar' }, ports: [PORT_485(), PORT_DC(12)],
    tags: ['水利'], src: '[天启] 水网监测：水流量、水质等关键数据'
  }),
  D('water.quality', '水质多参数监测', {
    group: 'water', symbol: 'water', sense: sens('wq', 128, 96),
    power: { alwaysW: 8, supply: 'solar' }, ports: [PORT_485(), PORT_DC(12)],
    tags: ['水利', '生态'], src: '[天启] 水利/林草：水质多参数在线监测'
  }),
  D('dam.seepage', '大坝渗压 / 位移监测', {
    group: 'water', symbol: 'sensor', sense: sens('struct', 96, 24),
    power: { txW: 0.6, sleepW: 0.0005, supply: 'solar' },
    ports: [PORT_485(), PORT_DC(12)], tags: ['水利'],
    src: '[天启] 水利工程监测：水库大坝等关键参数实时远程监测'
  }),

  // ── 应急 / 地灾 ──
  D('emg.pole', '应急叫应杆', {
    group: 'emergency', symbol: 'pole',
    // 「叫应」＝双向：上行一键呼叫/对讲，下行预警广播。故 dir 是 trx 不是 tx。
    sense: sens('voice', 8000, 86400),      // 对讲按 8 kB/s 计（G.711 一路 64 kbps）
    // ★ 对外有卫星口 ⇒ 自带 rf。杆上是螺旋/玻璃钢天线，没有口径，故给增益由引擎折等效口径
    rf: { antennaDiameter: 0, gainTxDbi: 4, gainRxDbi: 4, opPowerW: 2.5, antennaEfficiency: 50, paBackoff: 0, feederLoss: 1.0, uplinkPowerControl: '否', upcValue: 0, rxAntennaEfficiency: 50, rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 150, rxReceiverNoiseTemp: 300, rxFeederLoss: 1.0 },
    power: { alwaysW: 12, txW: 25, supply: 'solar' },
    env: { ip: 'IP66', tempMin: -30, tempMax: 60 },
    ports: [p('sat', 'sat_uhf', 'trx', 'data', '卫星报文'), p('cell', 'cellular_4g', 'trx', 'data', '4G'),
      p('spk', 'ac_mains', 'tx', 'power', '扩音'), ...PORT_RJ45(1), p('pv', 'solar', 'rx', 'power', '太阳能')],
    children: ['pwr.pv100', 'pwr.bat.agm65'],
    tags: ['应急', '预警', '基层'],
    src: '[类型] 基层应急「叫应」终端：一键呼叫 + 定向广播；卫星与公网双通道'
  }),
  D('emg.broadcast', '应急广播终端（大喇叭）', {
    group: 'emergency', symbol: 'speaker',
    sense: sens('audio', 8000, 3600),
    // 只收不发的广播终端：0.6 m 偏馈天线收 C 频段广播下行
    rf: es(0.6, 1, { antennaEfficiency: 55, rxAntennaEfficiency: 58, rxReceiverNoiseTemp: 90, rxFeederLoss: 0.5 }),
    power: { alwaysW: 8, txW: 60, supply: 'ac_mains' },
    env: { ip: 'IP66' },
    ports: [p('sat', 'sat_c', 'rx', 'data', '卫星广播下行'), p('cell', 'cellular_4g', 'trx', 'data', '4G 回执'), PORT_AC()],
    tags: ['应急', '广播', '预警'],
    src: '国家广电总局《应急广播系统总体技术规范》系列行业标准：卫星为覆盖通道之一'
  }),
  D('geo.gnss', 'GNSS 位移监测站', {
    group: 'emergency', symbol: 'sensor', sense: sens('gnss', 512, 288),
    power: { alwaysW: 3.5, supply: 'solar' },
    env: { ip: 'IP67', tempMin: -40, tempMax: 70 },
    ports: [PORT_485(), ...PORT_RJ45(1), PORT_DC(12)],
    tags: ['应急', '地灾', '交通'],
    src: '[卫通] 陆地信息服务：地质灾害 / 冰川监测预警（墨脱）'
  }),
  D('geo.crack', '裂缝计 / 倾角计 / 泥位计', {
    group: 'emergency', symbol: 'sensor', sense: sens('geo', 32, 288),
    power: { txW: 0.4, sleepW: 0.0003, supply: 'battery' },
    ports: [PORT_485(), PORT_DC(12)],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['D', 'E'] },
    tags: ['应急', '地灾'], src: '[类型] 群测群防地灾专用传感'
  }),
  D('slope.radar', '边坡雷达（地基干涉/真实孔径）', {
    group: 'emergency', symbol: 'radar',
    // ★ 地基合成孔径/真实孔径雷达（GB-SAR / RAR），Ku 或 X 波段。它是【数据源】不是通信设备：
    //   一次扫描产出一幅形变图，数据量大到必须本地成图后再回传，故 sense 给的是「成果」量级。
    sense: sens('radar-image', 8 * 1024 * 1024, 144),   // 每 10 min 一次扫描，成果图 ~8 MB
    power: { alwaysW: 400, supply: 'genset' },
    env: { ip: 'IP65', tempMin: -20, tempMax: 50, massKg: 180 },
    ports: [...PORT_RJ45(2), p('fib', 'smf_1310', 'trx', 'data', '光纤回传'), PORT_AC()],
    place: { modes: ['fixed', 'traj'], mountable: false },
    tags: ['应急', '地灾', '矿山', '交通'],
    src: '[类型] 露天矿/边坡形变雷达：视线向精度 0.1 mm 量级，作用距离 0.05–3.5 km，扫描周期分钟级'
  }),
  D('emg.sos', '人员求救 / 定位终端', {
    group: 'emergency', symbol: 'sos', sense: sens('position', 40, 288),
    power: { txW: 4, sleepW: 0.001, supply: 'battery' },
    env: { ip: 'IP67', massKg: 0.2 },
    ports: [p('sat', 'sat_uhf', 'tx', 'data', '卫星上行'), p('bt', 'ble', 'trx', 'data', '蓝牙')],
    place: { modes: ['fixed', 'traj', 'mounted'], mountable: true, hostCats: ['C'] },
    tags: ['应急', 'ToC'], src: '[天启] Alarm 系列一类：位置 + 报警报文'
  }),

  // ── 林草 / 生态 / 气象 ──
  D('forest.fire', '火险因子监测站', {
    group: 'eco', symbol: 'weather', sense: sens('weather', 160, 288),
    power: { alwaysW: 2.5, supply: 'solar' },
    ports: [PORT_485(), PORT_DC(12)], tags: ['林草', '防火'],
    src: '[天启] 林草行业：火险因子、气象数据实时稳定回传'
  }),
  D('forest.cam', '森林火点监测相机（双光云台）', {
    group: 'eco', symbol: 'camera', sense: sens('video', 2 * 1024 * 1024, 8640),
    power: { alwaysW: 45, supply: 'solar' },
    env: { ip: 'IP66', tempMin: -40, tempMax: 60 },
    ports: [...PORT_RJ45(1), PORT_DC(24)], tags: ['林草', '防火', '应急'],
    src: '[类型] 可见光 + 热成像双光云台，塔上安装，视频与火点告警'
  }),
  D('weather7', '气象站（七要素）', {
    group: 'eco', symbol: 'weather', sense: sens('weather', 200, 288),
    power: { alwaysW: 1.2, supply: 'solar' },
    env: { ip: 'IP66', tempMin: -40, tempMax: 60 },
    ports: [PORT_485(), PORT_DC(12)],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['D', 'E'] },
    tags: ['气象', '水利', '林草'],
    src: '[天启] 天启气象监测站传感器：PM2.5/PM10、风向、风速、温度、湿度、雨量、日照、大气压'
  }),
  D('soil', '土壤墒情监测', {
    group: 'eco', symbol: 'plant', sense: sens('soil', 96, 96),
    power: { txW: 0.4, sleepW: 0.0003, supply: 'solar' },
    ports: [PORT_485(), PORT_DC(12)], tags: ['农业', '林草'],
    src: '[天启] 林草生态：土壤质地与水质等要素实时监测'
  }),
  D('air.micro', '空气质量微站', {
    group: 'eco', symbol: 'sensor', sense: sens('air', 128, 288),
    power: { alwaysW: 6, supply: 'solar' }, ports: [PORT_485(), PORT_DC(12)],
    tags: ['生态', '环保'], src: '[天启] 林草生态：空气质量实时监测'
  }),

  // ── 交通 / 海洋 ──
  D('road.slope', '公路边坡监测装置', {
    group: 'transport', symbol: 'slope', sense: sens('geo', 64, 288),
    power: { txW: 0.6, sleepW: 0.0005, supply: 'solar' },
    ports: [PORT_485(), PORT_DC(12)], tags: ['交通', '地灾'],
    src: '[天启] 交通行业 · 公路边坡监测：边坡倾斜、雨量、水位监测设备'
  }),
  D('bridge.health', '桥梁健康监测', {
    group: 'transport', symbol: 'bridge', sense: sens('struct', 4096, 1440),
    power: { alwaysW: 12, supply: 'ac_mains' },
    ports: [...PORT_RJ45(1), PORT_485(), PORT_AC()], tags: ['交通'],
    src: '[类型] 索力/挠度/加速度/温度多测点采集'
  }),
  D('ais.classa', 'AIS 船台 (Class A)', {
    group: 'marine', symbol: 'ais', sense: sens('ais', 32, 8640),
    power: { txW: 12.5, rxW: 3, supply: 'dc_24' },
    env: { ip: 'IP56' },
    ports: [p('vhf', 'vhf_data', 'trx', 'data', 'AIS VHF 161.975/162.025 MHz'), PORT_DC(24)],
    place: { modes: ['mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['海洋', '交通'],
    src: 'ITU-R M.1371-5：AIS 报文，Class A 发射 12.5 W，报告周期 2–10 s（航行中）'
  }),
  D('buoy', '海洋浮标', {
    group: 'marine', symbol: 'buoy', sense: sens('ocean', 256, 144),
    power: { alwaysW: 4, supply: 'solar' },
    env: { ip: 'IP68' },
    ports: [p('sat', 'sat_uhf', 'trx', 'data', '卫星上行'), PORT_485(), p('pv', 'solar', 'rx', 'power', '太阳能')],
    place: { modes: ['fixed', 'traj'], mountable: false },
    tags: ['海洋', '气象'], src: '[天启] 海洋感知网：海上气象信息与海水参数实时监测'
  }),
  D('cam.ptz', '摄像机（枪机 / 球机 / 热成像）', {
    group: 'video', symbol: 'camera',
    sense: sens('video', 4 * 1024 * 1024, 21600),   // 4 Mbps 主码流 ≈ 每秒 0.5 MB
    phy: { rateUpBps: 4e6 },
    power: { alwaysW: 12, supply: 'poe' },
    env: { ip: 'IP67', tempMin: -40, tempMax: 60 },
    ports: [p('lan', 'cat6', 'trx', 'data', '网口（PoE 受电）')],
    place: { modes: ['fixed', 'mounted'], mountable: true, hostCats: ['C', 'D', 'E'] },
    tags: ['安防', '电力', '林草', '应急'],
    src: '[类型] 1080p H.265 主码流 2–4 Mbps；4K 约 8–12 Mbps'
  })
];

// ═══════════════════════════════════════════════════════════════════════════
// E 汇聚 / 边缘
// ═══════════════════════════════════════════════════════════════════════════
const E = (id, zh, o) => mk('E', id, zh, o);

const EDGE = [
  E('edge.lorawan.gw', 'LoRaWAN 网关', {
    group: 'gateway', symbol: 'gateway',
    radio: { medium: 'lora', txDbm: 27, gainDbi: 5, sensDbm: -137 },
    power: { alwaysW: 8, supply: 'poe' },
    env: { ip: 'IP67', tempMin: -40, tempMax: 70 },
    ports: [p('lora', 'lora', 'trx', 'data', 'LoRa 空口'), ...PORT_RJ45(1), p('cell', 'cellular_4g', 'trx', 'data', '4G 回传'), PORT_DC(12)],
    tags: ['物联', '水利', '林草', '电力'],
    src: '[类型] 8 通道 LoRaWAN 网关：SX1301/1302，接收灵敏度 −137 dBm @SF12'
  }),
  E('edge.dtu', 'DTU 数传终端', {
    group: 'gateway', symbol: 'module-box',
    power: { alwaysW: 2, sleepW: 0.02, supply: 'dc_12' },
    env: { ip: 'IP30', tempMin: -35, tempMax: 75 },
    ports: [PORT_485(), p('cell', 'cellular_4g', 'trx', 'data', '4G'), PORT_DC(12)],
    tags: ['物联', '电力', '水利'], src: '[类型] RS485 转公网/卫星的透传终端'
  }),
  E('edge.rtu', 'RTU 远程终端单元', {
    group: 'gateway', symbol: 'cabinet',
    power: { alwaysW: 6, supply: 'dc_24' },
    env: { ip: 'IP54', tempMin: -40, tempMax: 70 },
    // 现场 RTU 通常是多路 485 汇聚：给三口，否则一条总线上的传感器全得串一条线
    ports: [p('rs485a', 'rs485', 'trx', 'data', 'RS-485 ①'), p('rs485b', 'rs485', 'trx', 'data', 'RS-485 ②'),
      p('rs485c', 'rs485', 'trx', 'data', 'RS-485 ③'), ...PORT_RJ45(2),
      p('io', 'rs232', 'trx', 'sense', '模拟/数字 IO'), PORT_DC(24)],
    tags: ['电力', '水利', '能源'], src: '[类型] 多路 IO + 规约转换 + 本地存储'
  }),
  E('edge.aibox', '边缘计算盒（AI）', {
    group: 'edge', symbol: 'edge-box',
    phy: { rateUpBps: 100e6 },
    power: { alwaysW: 25, supply: 'dc_12' },
    env: { ip: 'IP40', tempMin: -20, tempMax: 60 },
    ports: [...PORT_RJ45(3), p('usb', 'rs232', 'trx', 'data', 'USB'), PORT_DC(12)],
    tags: ['边缘', '安防', '林草', '低空'],
    src: '[卫通] 陆地信息服务：「高通量卫星 + 智能边端系统」，AI 驱动的本地研判后再回传'
  }),
  E('edge.sw.poe8', '工业 PoE 交换机（8 口）', {
    group: 'net', symbol: 'switch',
    power: { alwaysW: 15, supply: 'dc_48' },
    env: { ip: 'IP40', tempMin: -40, tempMax: 75 },
    ports: [...PORT_RJ45(8), p('sfp1', 'smf_1310', 'trx', 'data', '光口 SFP'), PORT_DC(48)],
    tags: ['网络'], src: '[类型] 8×10/100/1000 PoE+ ＋ 1×SFP，IEEE 802.3af/at'
  }),
  E('edge.sw.ind', '工业以太网交换机', {
    group: 'net', symbol: 'switch',
    power: { alwaysW: 8, supply: 'dc_24' },
    ports: [...PORT_RJ45(5), p('sfp1', 'smf_1310', 'trx', 'data', '光口 SFP'), PORT_DC(24)],
    tags: ['网络'], src: '[类型] 导轨式工业交换机'
  }),
  E('edge.router', '路由器 / 工业网关', {
    group: 'net', symbol: 'router',
    power: { alwaysW: 10, supply: 'dc_12' },
    ports: [...PORT_RJ45(4), p('wan', 'internet_bb', 'trx', 'data', 'WAN'), p('cell', 'cellular_5g', 'trx', 'data', '5G'), PORT_DC(12)],
    tags: ['网络'], src: '[类型] 多 WAN 工业路由，支持链路备份'
  }),
  E('edge.fw', '防火墙 / 网闸', {
    group: 'net', symbol: 'shield',
    power: { alwaysW: 30, supply: 'ac_mains' },
    ports: [...PORT_RJ45(4), PORT_AC()], tags: ['网络', '安全'],
    src: '[类型] 边界安全设备；物理层上只贡献时延与端口'
  }),
  E('edge.media', '光纤收发器', {
    group: 'net', symbol: 'converter',
    power: { alwaysW: 3, supply: 'dc_12' },
    ports: [...PORT_RJ45(1), p('fib', 'smf_1310', 'trx', 'data', '光口'), PORT_DC(12)],
    tags: ['网络'], src: '[类型] 电↔光转换'
  }),
  E('net.smartpole', '卫星智慧杆', {
    group: 'pole', symbol: 'pole',
    // 复合模块：杆体 + 卫星终端 + 边缘盒 + 摄像机 + 供电。
    // ★ 对外有射频口 ⇒ 自带 rf（取自杆上那台 Ka 无人值守站）
    rf: es(0.45, 4, { antennaEfficiency: 60, feederLoss: 0.8, rxAntennaEfficiency: 62, rxReceiverNoiseTemp: 90 }),
    power: { alwaysW: 120, supply: 'solar' },
    env: { ip: 'IP66', tempMin: -40, tempMax: 60, massKg: 300 },
    ports: [p('sat', 'sat_ka', 'trx', 'data', '卫星回传'), ...PORT_RJ45(4),
      p('rs485', 'rs485', 'trx', 'data', 'RS-485'),
      p('wifi', 'wifi_5g', 'trx', 'data', 'WiFi'), p('pv', 'solar', 'rx', 'power', '太阳能')],
    children: ['es.ka.unattended.045', 'edge.aibox', 'sens.cam.ptz', 'pwr.pv500', 'pwr.bat.lfp200'],
    tags: ['林草', '生态', '应急', '智慧杆'],
    src: '[卫通] 陆地信息服务：卫星智慧杆（北京松山国家级自然保护区 · 林草生物多样性监测）'
  }),
  E('net.5gcpe', '5G CPE / 微基站', {
    group: 'access', symbol: 'basestation',
    phy: { rateDnBps: 300e6, rateUpBps: 60e6 },
    power: { alwaysW: 45, supply: 'ac_mains' },
    env: { ip: 'IP66' },
    ports: [p('cell', 'cellular_5g', 'trx', 'data', '5G 空口'), ...PORT_RJ45(2), PORT_AC()],
    tags: ['网络', '村通'], src: '[卫通] 村通工程：与三大运营商核心网对接，支持 4G 基站与 WiFi'
  }),
  E('net.4gbs', '4G 一体化基站', {
    group: 'access', symbol: 'basestation',
    phy: { rateDnBps: 100e6, rateUpBps: 50e6 },
    power: { alwaysW: 120, supply: 'ac_mains' },
    env: { ip: 'IP66' },
    ports: [p('cell', 'cellular_4g', 'trx', 'data', 'LTE 空口'), ...PORT_RJ45(2), PORT_AC()],
    tags: ['网络', '村通', '应急'],
    src: '[卫通] 陆地网络服务：「卫星 + 4G」为 600 余个村通站点提供移动信号覆盖'
  }),
  E('net.wifi.ap', 'WiFi AP（室外）', {
    group: 'access', symbol: 'wifi',
    radio: { medium: 'wifi_5g', txDbm: 27, gainDbi: 8 },
    phy: { rateDnBps: 600e6, rateUpBps: 600e6 },
    power: { alwaysW: 15, supply: 'poe' },
    env: { ip: 'IP66', tempMin: -40, tempMax: 65 },
    ports: [p('wifi', 'wifi_5g', 'trx', 'data', 'WiFi 空口'), ...PORT_RJ45(1)],
    tags: ['网络', '村通'], src: '[卫通] 村通：「卫星 + WiFi」服务模式'
  }),
  E('net.wifi.mesh', 'WiFi Mesh 自组网节点', {
    group: 'access', symbol: 'mesh',
    radio: { medium: 'wifi_mesh', txDbm: 27, gainDbi: 6 },
    phy: { rateDnBps: 300e6, rateUpBps: 300e6 },
    power: { alwaysW: 18, supply: 'poe' },
    env: { ip: 'IP66', tempMin: -30, tempMax: 60 },
    ports: [p('mesh', 'wifi_mesh', 'trx', 'data', 'Mesh 空口'), ...PORT_RJ45(1)],
    place: { modes: ['fixed', 'mounted', 'traj'], mountable: true, hostCats: ['C', 'E'] },
    tags: ['网络', '应急', 'Mesh'],
    src: 'IEEE 802.11s；★ 同频链式多跳端到端吞吐 ≈ 单跳/跳数（见 sceneTerrestrial.meshDerate）'
  }),
  E('net.manet', '宽带自组网电台 (MANET)', {
    group: 'access', symbol: 'manet',
    radio: { medium: 'manet', txDbm: 33, gainDbi: 2, sensDbm: -95 },
    phy: { rateDnBps: 4e6, rateUpBps: 4e6 },
    power: { alwaysW: 25, txW: 40, supply: 'dc_12' },
    env: { ip: 'IP67', tempMin: -30, tempMax: 60, massKg: 1.2 },
    ports: [p('air', 'manet', 'trx', 'data', '自组网空口'), ...PORT_RJ45(1), PORT_DC(12)],
    place: { modes: ['fixed', 'mounted', 'traj'], mountable: true, hostCats: ['C', 'E'] },
    tags: ['应急', '单兵', 'Mesh'],
    src: '[类型] 1.4 GHz / 800 MHz 宽带自组网电台：无中心多跳，应急与无人系统常用'
  }),
  E('net.uhf.radio', 'UHF 数传电台', {
    group: 'access', symbol: 'radio',
    radio: { medium: 'uhf_data', txDbm: 37, gainDbi: 2, sensDbm: -110 },
    phy: { rateDnBps: 19200, rateUpBps: 19200 },
    power: { txW: 10, rxW: 0.8, idleW: 0.3, supply: 'dc_12' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 70, massKg: 0.5 },
    ports: [p('air', 'uhf_data', 'trx', 'data', 'UHF 空口'), p('ant', 'coax_rf', 'tx', 'if', '天线口 N/SMA'), PORT_485(), PORT_DC(12)],
    place: { modes: ['fixed', 'mounted', 'traj'], mountable: true, hostCats: ['C', 'D', 'E'] },
    tags: ['电力', '水利', '应急'],
    src: '[类型] 230 MHz 电力专网 / 400–470 MHz 通用数传；ETSI EN 300 113 窄带'
  }),
  E('net.vhf.radio', 'VHF 电台 / 海事甚高频', {
    group: 'access', symbol: 'radio',
    radio: { medium: 'vhf_data', txDbm: 37, gainDbi: 3, sensDbm: -112 },
    phy: { rateDnBps: 9600, rateUpBps: 9600 },
    power: { txW: 25, rxW: 1, idleW: 0.5, supply: 'dc_24' },
    env: { ip: 'IP66' },
    ports: [p('air', 'vhf_data', 'trx', 'data', 'VHF 空口'), p('ant', 'coax_rf', 'tx', 'if', '天线口'), PORT_DC(24)],
    place: { modes: ['fixed', 'mounted', 'traj'], mountable: true, hostCats: ['C', 'E'] },
    tags: ['海洋', '应急'], src: '[类型] 156–174 MHz 海事频段；AIS 161.975/162.025 MHz'
  }),
  E('net.video.tx', '图传发射机', {
    group: 'access', symbol: 'video',
    radio: { medium: 'video_58', txDbm: 27, gainDbi: 2 },
    phy: { rateUpBps: 12e6 },
    power: { txW: 12, supply: 'dc_12' },
    env: { massKg: 0.3 },
    ports: [p('air', 'video_58', 'tx', 'data', '图传空口'), ...PORT_RJ45(1), PORT_DC(12)],
    place: { modes: ['mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['低空', '无人机'], src: '[类型] 5.8 GHz / 1.4 GHz COFDM 图传'
  }),
  E('net.video.rx', '图传地面站', {
    group: 'access', symbol: 'video',
    radio: { medium: 'video_58', gainDbi: 12, sensDbm: -92 },
    power: { alwaysW: 30, supply: 'dc_24' },
    ports: [p('air', 'video_58', 'rx', 'data', '图传空口'), ...PORT_RJ45(1), PORT_DC(24)],
    tags: ['低空', '无人机'], src: '[类型] 定向天线 + 解码，配合图传发射机'
  }),
  E('net.airbs', '空中基站（机载 LTE）', {
    group: 'access', symbol: 'basestation',
    phy: { rateDnBps: 50e6, rateUpBps: 20e6 },
    power: { alwaysW: 200, supply: 'dc_28' },
    env: { massKg: 25 },
    ports: [p('cell', 'cellular_4g', 'trx', 'data', 'LTE 空口（对地）'), p('bh', 'sat_ka', 'trx', 'data', '卫星回传'), ...PORT_RJ45(1), PORT_DC(48)],
    place: { modes: ['mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['应急', '低空', '空中基站'],
    src: '[卫通] 低空网络服务：翼龙-Ⅱ / 彩虹-4 / 滕盾无人机上做 LTE 基站与视频回传实测'
  }),
  E('net.pdt', '集群基站 (PDT/DMR)', {
    group: 'access', symbol: 'radio',
    radio: { medium: 'uhf_data', txDbm: 44, gainDbi: 9, sensDbm: -116 },
    phy: { rateDnBps: 9600, rateUpBps: 9600 },
    power: { alwaysW: 150, supply: 'ac_mains' },
    ports: [p('air', 'uhf_data', 'trx', 'data', '集群空口'), ...PORT_RJ45(1), PORT_AC()],
    tags: ['应急', '公安'], src: '[类型] 350 MHz PDT 数字集群；GA/T 1056'
  }),
  E('net.nvr', 'NVR / 视频存储', {
    group: 'edge', symbol: 'server',
    power: { alwaysW: 60, supply: 'ac_mains' },
    ports: [...PORT_RJ45(2), PORT_AC()], tags: ['安防'], src: '[类型] 本地录像与转发'
  })
];

// ═══════════════════════════════════════════════════════════════════════════
// F 射频器件（天线 / 馈线：挂在别的模块的射频口上，改变它的增益与损耗）
// ═══════════════════════════════════════════════════════════════════════════
// ★ 天线不是独立节点，是【某个射频端口的属性】。挂上去之后：
//   G_tx / G_rx 用天线的 gainDbi，馈线插损并进 lossTxDb / lossRxDb。
const ANT = (id, zh, band, gain, o) => mk('F', 'ant.' + id, zh, Object.assign({
  group: 'antenna', symbol: o && o.symbol || 'antenna-omni',
  antenna: Object.assign({ gainDbi: gain, band, pol: 'V' }, (o && o.antenna) || {}),
  ports: [p('rf', 'coax_rf', 'trx', 'if', '同轴接口')],
  place: { modes: ['mounted'], mountable: true, hostCats: ['B', 'C', 'D', 'E'] },
  tags: (o && o.tags) || ['射频']
}, o || {}));

const RFPARTS = [
  ANT('whip.vhf', 'VHF 鞭状天线', 'VHF', 2.15, { symbol: 'antenna-whip', antenna: { beamwidthDeg: 360, pol: 'V' }, src: '[类型] λ/4 或 λ/2 鞭：全向，2.15 dBi（半波振子）' }),
  ANT('whip.uhf', 'UHF 鞭状天线', 'UHF', 2.15, { symbol: 'antenna-whip', antenna: { beamwidthDeg: 360 }, src: '[类型] 车载/手持通用鞭状' }),
  ANT('colinear.uhf', 'UHF 同轴共线全向天线', 'UHF', 8.0, { symbol: 'antenna-whip', antenna: { beamwidthDeg: 360, elevBwDeg: 14 }, src: '[类型] 4~8 单元共线：8 dBi，垂直面波束压窄' }),
  ANT('yagi.uhf', 'UHF 八木天线', 'UHF', 12.0, { symbol: 'antenna-yagi', antenna: { beamwidthDeg: 40, fbDb: 18 }, src: '[类型] 9 单元八木：≈12 dBi，半功率波束 ~40°' }),
  ANT('yagi.vhf', 'VHF 八木天线', 'VHF', 9.5, { symbol: 'antenna-yagi', antenna: { beamwidthDeg: 55, fbDb: 15 }, src: '[类型] 5 单元八木' }),
  ANT('omni.24', '2.4 GHz 全向天线', 'S', 8.0, { symbol: 'antenna-omni', antenna: { beamwidthDeg: 360, elevBwDeg: 15 }, src: '[类型] 玻璃钢全向' }),
  ANT('omni.58', '5.8 GHz 全向天线', 'C', 10.0, { symbol: 'antenna-omni', antenna: { beamwidthDeg: 360, elevBwDeg: 10 }, src: '[类型] 玻璃钢全向' }),
  ANT('panel.58', '5.8 GHz 定向板状天线', 'C', 19.0, { symbol: 'antenna-panel', antenna: { beamwidthDeg: 18 }, src: '[类型] 平板阵：19 dBi，波束 ~18°' }),
  ANT('grid.58', '5.8 GHz 栅格抛物面', 'C', 27.0, { symbol: 'antenna-panel', antenna: { beamwidthDeg: 7 }, src: '[类型] 栅格反射面：27 dBi' }),
  ANT('dish.mw', '微波中继抛物面 0.6 m', 'X', 34.0, { symbol: 'dish', antenna: { beamwidthDeg: 3.5 }, src: '[类型] 0.6 m @7 GHz，η=0.55 → ≈34 dBi' }),
  ANT('helix.uhf', 'UHF 螺旋天线（卫星）', 'UHF', 6.0, { symbol: 'antenna-helix', antenna: { beamwidthDeg: 70, pol: 'RHCP' }, src: '[类型] 低轨窄带终端常用四臂螺旋/微带' }),
  ANT('patch.gnss', 'GNSS 有源天线', 'L', 3.0, { symbol: 'antenna-omni', antenna: { beamwidthDeg: 180, pol: 'RHCP' }, tags: ['定位'], src: '[类型] 陶瓷贴片 + LNA' }),
  mk('F', 'rf.lna', '低噪声放大器 (LNA/LNB)', {
    group: 'rfpart', symbol: 'amp',
    ports: [p('in', 'coax_rf', 'rx', 'if', '射频输入'), p('out', 'ifl_l', 'tx', 'if', '中频输出'), PORT_DC(12)],
    power: { alwaysW: 3, supply: 'dc_12' },
    place: { modes: ['mounted'], mountable: true, hostCats: ['B', 'C'] },
    tags: ['射频'], src: '[类型] 下变频 + 低噪放；噪温进地球站库的接收机噪温'
  }),
  mk('F', 'rf.buc', '上变频功放 (BUC)', {
    group: 'rfpart', symbol: 'amp',
    ports: [p('in', 'ifl_l', 'rx', 'if', '中频输入'), p('out', 'coax_rf', 'tx', 'if', '射频输出'), PORT_DC(24)],
    power: { txW: 120, idleW: 15, supply: 'dc_24' },
    place: { modes: ['mounted'], mountable: true, hostCats: ['B', 'C'] },
    tags: ['射频'], src: '[类型] BUC 直流经中频电缆馈送 —— 压降校验见 sceneTerrestrial 的 ifl_l'
  })
];

// ═══════════════════════════════════════════════════════════════════════════
// G 供电
// ═══════════════════════════════════════════════════════════════════════════
const G = (id, zh, o) => mk('G', 'pwr.' + id, zh, Object.assign({ group: 'power', symbol: 'battery', tags: ['供电'] }, o));

const POWER = [
  G('mains', '市电接入', { symbol: 'plug', supply: { kind: 'mains', availPct: 99.5 }, ports: [p('out', 'ac_mains', 'tx', 'power', '交流输出')], src: '[类型] 市电可用度按当地供电质量给' }),
  G('pv100', '太阳能板 100 Wp', { symbol: 'solar', supply: { kind: 'solar', wp: 100 }, ports: [p('out', 'solar', 'tx', 'power', '直流输出')], env: { massKg: 8 }, src: '[天启] 天启气象监测站配置：100 W 光伏 + 65 Ah 蓄电池' }),
  G('pv200', '太阳能板 200 Wp', { symbol: 'solar', supply: { kind: 'solar', wp: 200 }, ports: [p('out', 'solar', 'tx', 'power', '直流输出')], env: { massKg: 15 }, src: '[类型]' }),
  G('pv500', '太阳能板 500 Wp', { symbol: 'solar', supply: { kind: 'solar', wp: 500 }, ports: [p('out', 'solar', 'tx', 'power', '直流输出')], env: { massKg: 32 }, src: '[类型]' }),
  G('bat.agm65', '铅酸蓄电池 12 V / 65 Ah', { supply: { kind: 'battery', chem: 'agm', vdc: 12, ah: 65 }, ports: [p('io', 'dc_12', 'trx', 'power', '直流')], env: { massKg: 20 }, src: '[天启] 气象站配置；IEEE 1013 离网定容 DoD 50%' }),
  G('bat.lfp100', '磷酸铁锂 12 V / 100 Ah', { supply: { kind: 'battery', chem: 'lifepo4', vdc: 12, ah: 100 }, ports: [p('io', 'dc_12', 'trx', 'power', '直流')], env: { massKg: 12 }, src: '[类型] DoD 80%' }),
  G('bat.lfp200', '磷酸铁锂 24 V / 200 Ah', { supply: { kind: 'battery', chem: 'lifepo4', vdc: 24, ah: 200 }, ports: [p('io', 'dc_24', 'trx', 'power', '直流')], env: { massKg: 45 }, src: '[类型]' }),
  G('bat.primary', '一次锂电池组', { supply: { kind: 'battery', chem: 'primary_li', vdc: 3.6, ah: 19 }, ports: [p('out', 'dc_12', 'tx', 'power', '直流')], env: { massKg: 0.3 }, src: '[类型] ER34615 × N；不可充，按可支撑天数算' }),
  G('genset', '柴油发电机', { symbol: 'genset', supply: { kind: 'genset' }, ports: [p('out', 'ac_mains', 'tx', 'power', '交流输出')], src: '[类型] 应急/无市电场景' }),
  G('ups', 'UPS 不间断电源', { symbol: 'ups', supply: { kind: 'battery', chem: 'agm', vdc: 48, ah: 100 }, ports: [p('in', 'ac_mains', 'rx', 'power', '市电输入'), p('out', 'ac_mains', 'tx', 'power', '交流输出')], src: '[类型] 市电中断时的保持时间由容量与负载算' }),
  G('windpv', '风光互补供电', { symbol: 'solar', supply: { kind: 'solar', wp: 300 }, ports: [p('out', 'dc_24', 'tx', 'power', '直流输出')], src: '[类型] 风机出力受当地风资源支配，本平台不计算风电部分' })
];

// ═══════════════════════════════════════════════════════════════════════════
// H 中心 / 平台（链路的落地终点）
// ═══════════════════════════════════════════════════════════════════════════
const H = (id, zh, o) => mk('H', 'ctr.' + id, zh, Object.assign({ group: 'center', symbol: 'datacenter', tags: ['中心'] }, o));

const CENTER = [
  H('dc', '数据中心', {
    ports: [p('wan1', 'leased_mstp', 'trx', 'data', '专线'), p('wan2', 'internet_bb', 'trx', 'data', '互联网'), ...PORT_RJ45(4), PORT_AC()],
    src: '[类型] 业务落地终点'
  }),
  H('cmd', '指挥调度中心', {
    symbol: 'command',
    ports: [p('wan', 'leased_mstp', 'trx', 'data', '专线'), p('wan1', 'leased_mstp', 'trx', 'data', '专线 ②'),
      p('wan2', 'internet_bb', 'trx', 'data', '互联网'), ...PORT_RJ45(4), PORT_AC()],
    tags: ['应急', '中心'], src: '[类型] 应急指挥大厅'
  }),
  H('platform', '行业客户平台', {
    symbol: 'cloud',
    ports: [p('wan', 'leased_mstp', 'trx', 'data', '专线'), p('wan1', 'leased_mstp', 'trx', 'data', '专线 ②'),
      p('wan2', 'internet_bb', 'trx', 'data', '互联网'), p('vpn', 'leased_mstp', 'trx', 'data', 'VPN')],
    src: '[天启] 用户段：行业客户；数据经分包处理后分发'
  }),
  H('tqboss', 'TQBOSS 业务支撑系统', {
    symbol: 'cloud',
    ports: [p('wan', 'leased_mstp', 'trx', 'data', '专线')],
    tags: ['天启', '中心'], src: '[天启] 融合天启卫星通信业务与运营商地面通信业务的综合业务运营管理平台'
  }),
  H('nms', '网管系统', {
    symbol: 'server', ports: [...PORT_RJ45(2), PORT_AC()], src: '[类型] 网络管理与监控'
  }),
  H('coreif', '运营商核心网对接点', {
    symbol: 'cloud',
    ports: [p('wan', 'leased_mstp', 'trx', 'data', '对接专线')],
    tags: ['村通', '中心'], src: '[卫通] 与电信/移动/联通核心网对接，支持 4G 基站与 WiFi 业务'
  }),
  H('video.platform', '视频监控平台', {
    symbol: 'server', ports: [p('wan', 'leased_mstp', 'trx', 'data', '专线'), ...PORT_RJ45(2), PORT_AC()],
    tags: ['安防', '中心'], src: '[类型] GB/T 28181 联网平台'
  })
];

module.exports = { PLATFORMS, SENSORS, EDGE, RFPARTS, POWER, CENTER };
