// utils/sceneMedia.js
// 应用场景仿真 —— 传输介质目录（纯数据 + 常数，平台无关）。
//
// 这份表是「场景里一条边到底是什么」的唯一真值源：端口能不能连、这条边归哪个计算器算、
// 算出来的数是什么形状，全从这里派生。渲染端不另存一份镜像（经 IPC 取一次缓存进 store），
// 避免「两份表手工同步」那类必然走样的东西。
//
// ============ 三档判据（★核心口径，不许混）============
// 每种介质带一个 tier，出参形状各不相同：
//   · 'power'    —— 功率预算档：与射频段同构的 dB 账，能给出真余量。光纤 / 视距微波 / 图传 /
//                   LoRa / WiFi / UHF-VHF 数传。出参含 marginDb。
//   · 'constraint' —— 约束校验档：没有 dB 余量这回事，只有过不过线。铜缆 / RS485 / IFL 中频
//                   电缆 / PoE。出参是「实际值 vs 上限」一对数，【绝不】折算成一个 marginDb。
//   · 'contract' —— 契约档：运营商专线 / 公网蜂窝 / 互联网宽带。它们的「性能」是合同条款不是
//                   物理量。软件只转录、参与汇总、并在出参里标 quoted:true。★绝不能拿 Hata 之类
//                   假装算出公网覆盖 —— 那是编数。
//   · 'satellite' —— 卫星段，不由本模块算，整段交给 linkChain。
//   · 'supply'   —— 供电边，走能量账（sceneEnergy.js），不进 dB 账。
//
// ============ 端口匹配 ============
// 每种介质给一个 conn（连接器/接口族）。两个端口能连上的充要条件是 conn 相同且方向相容。
// 这条规则本身就是物理层校验：RJ45 插不进 SFP 光口，UHF 终端接不上 Ka 馈源。
//
// ============ 出处 ============
// 每条常数都带 src 字段写明出处（ITU-R / IEEE / TIA / IEC / ISO / 厂商公开手册）。没有出处的
// 数一律不写进这张表 —— 宁可留 null 让上层报「缺参数」，也不编一个看起来合理的值。

'use strict';

// ── 物理常数 ──
const C_LIGHT = 299792458;          // m/s（CODATA 定义值）
const RE_KM = 6371.0;               // km，平均地球半径（IUGG 平均半径 R1）
const K_EFF = 4 / 3;                // 有效地球半径因子（ITU-R P.310 标准大气折射）

// 铜导体直流电阻（20 ℃，实心退火铜，IEC 60228 / TIA-568.2-D 表）
// 单位 Ω/m，单根导体。AWG24 是 Cat5e/Cat6 的常见规格，AWG23 是 Cat6/6A。
const CU_R_PER_M = { 22: 0.0530, 23: 0.0668, 24: 0.0842, 26: 0.1339 };

// ─────────────────────────────────────────────────────────────────────────────
// 连接器/接口族（端口匹配用）
// ─────────────────────────────────────────────────────────────────────────────
const CONNECTORS = [
  { key: 'rj45', zh: 'RJ45 以太网口', en: 'RJ45 Ethernet' },
  { key: 'sfp', zh: '光模块口 (SFP/SFP+)', en: 'SFP/SFP+ optical' },
  { key: 'fiber', zh: '光纤端面 (LC/SC/FC)', en: 'Fiber endface' },
  { key: 'coax_if', zh: 'L 波段中频口 (F/N)', en: 'L-band IF port' },
  { key: 'coax_rf', zh: '射频同轴口 (SMA/N/TNC)', en: 'RF coax port' },
  { key: 'waveguide', zh: '波导法兰', en: 'Waveguide flange' },
  { key: 'serial', zh: '串行口 (RS485/232)', en: 'Serial port' },
  { key: 'can', zh: 'CAN 总线口', en: 'CAN bus' },
  { key: 'powerline', zh: '电力线载波耦合', en: 'Power-line coupling' },
  { key: 'air', zh: '空口（无线）', en: 'Air interface' },
  { key: 'wan', zh: '广域网交付口', en: 'WAN handoff' },
  { key: 'dc', zh: '直流供电口', en: 'DC power' },
  { key: 'ac', zh: '交流供电口', en: 'AC power' },
  { key: 'usb', zh: 'USB', en: 'USB' },
  { key: 'gpio', zh: '数字/模拟 IO', en: 'GPIO / analog IO' }
];

// ─────────────────────────────────────────────────────────────────────────────
// 频段（射频端口与卫星段共用；GHz）
// ─────────────────────────────────────────────────────────────────────────────
const BANDS = [
  { key: 'VHF', zh: 'VHF', lo: 0.030, hi: 0.300 },
  { key: 'UHF', zh: 'UHF', lo: 0.300, hi: 3.000 },
  { key: 'L', zh: 'L', lo: 1.0, hi: 2.0 },
  { key: 'S', zh: 'S', lo: 2.0, hi: 4.0 },
  { key: 'C', zh: 'C', lo: 4.0, hi: 8.0 },
  { key: 'X', zh: 'X', lo: 8.0, hi: 12.0 },
  { key: 'Ku', zh: 'Ku', lo: 12.0, hi: 18.0 },
  { key: 'K', zh: 'K', lo: 18.0, hi: 27.0 },
  { key: 'Ka', zh: 'Ka', lo: 27.0, hi: 40.0 },
  { key: 'Q', zh: 'Q', lo: 33.0, hi: 50.0 },
  { key: 'V', zh: 'V', lo: 40.0, hi: 75.0 },
  { key: 'W', zh: 'W', lo: 75.0, hi: 110.0 },
  { key: 'OPT', zh: '光', lo: 190000, hi: 400000 }
];

// ─────────────────────────────────────────────────────────────────────────────
// LoRa 接收灵敏度（Semtech SX1276/8 数据手册 Table 13，125 kHz 带宽，@868/915 MHz）
// 250/500 kHz 带宽下各档灵敏度约 +2.5 / +5 dB（同表）。
// ─────────────────────────────────────────────────────────────────────────────
const LORA_SENS = { 7: -123, 8: -126, 9: -129, 10: -132, 11: -134.5, 12: -137 };
const LORA_BW_ADJ = { 125: 0, 250: 2.5, 500: 5.0 };
// LoRa 符号速率与数据率：Rb = SF · BW / 2^SF · CR（Semtech AN1200.22 式 (2)）
function loraBitrate(sf, bwKHz, crDen) {
  const cr = 4 / (crDen || 5);          // 4/5 … 4/8
  return sf * (bwKHz * 1000) / Math.pow(2, sf) * cr;   // bps
}

// ─────────────────────────────────────────────────────────────────────────────
// IEEE 802.11 接收灵敏度（最小灵敏度，20 MHz 信道）
// 出处：IEEE Std 802.11-2020 Table 17-18 (OFDM/11a-g) 与 802.11ax-2021 Table 27-53。
// 标准给的是「最低要求」，实际芯片普遍好 3–6 dB；这里取标准值＝保守侧。
// 40/80/160 MHz 信道各再加 3/6/9 dB（热噪带宽翻倍即 +3 dB）。
// ─────────────────────────────────────────────────────────────────────────────
const WIFI_SENS_20M = {
  // MCS: [11a/g/n/ac 传统档, 11ax 档]；索引即 MCS 号
  0: -82, 1: -79, 2: -77, 3: -74, 4: -70, 5: -66, 6: -65, 7: -64,
  8: -59, 9: -57, 10: -54, 11: -52
};
// 各 MCS 在 20 MHz / 800 ns GI / 1 空间流下的 PHY 速率（Mbps）
// 出处：IEEE 802.11ax-2021 Table 27-58（HE-MCS 0…11, NSS=1, 20 MHz, 0.8 µs GI）
const WIFI_RATE_20M_1SS = {
  0: 8.6, 1: 17.2, 2: 25.8, 3: 34.4, 4: 51.6, 5: 68.8,
  6: 77.4, 7: 86.0, 8: 103.2, 9: 114.7, 10: 129.0, 11: 143.4
};

// ─────────────────────────────────────────────────────────────────────────────
// 介质目录
// 字段：
//   key/zh/en          标识与显示名
//   cat                归类（UI 分组用）
//   tier               三档判据之一 + satellite/supply
//   conn               连接器族（端口匹配）
//   duplex             'full' | 'half' | 'sim'（单工，如广播）
//   defaults           这条边的缺省参数（用户可逐条覆盖）
//   limits             硬上限（constraint 档的判据）
//   propMs             传播速度（km 换算成 ms）：铜 ~0.66c、光纤 ~0.67c、空气 ~1.0c
//   rateMaxBps         该介质的物理速率天花板（null＝由参数算出，不设常数上限）
//   src                出处
// ─────────────────────────────────────────────────────────────────────────────
const MEDIA = [
  // ══════════ 铜缆以太网（约束校验档）══════════
  {
    key: 'cat5e', zh: '双绞线 Cat5e', en: 'Cat5e twisted pair', cat: 'copper', tier: 'constraint',
    conn: 'rj45', duplex: 'full', vf: 0.64,
    defaults: { lengthM: 30, awg: 24, ratePreset: '1000BASE-T', poe: 'none' },
    limits: {
      // TIA-568.2-D 永久链路 90 m + 两端跳线各 5 m = 信道 100 m
      channelM: 100,
      rates: [
        { key: '100BASE-TX', bps: 100e6, maxM: 100, src: 'IEEE 802.3 Clause 25' },
        { key: '1000BASE-T', bps: 1000e6, maxM: 100, src: 'IEEE 802.3 Clause 40' },
        { key: '2.5GBASE-T', bps: 2500e6, maxM: 100, src: 'IEEE 802.3bz-2016' },
        { key: '5GBASE-T', bps: 5000e6, maxM: 100, src: 'IEEE 802.3bz-2016' }
      ]
    },
    src: 'TIA-568.2-D / IEEE 802.3'
  },
  {
    key: 'cat6', zh: '双绞线 Cat6', en: 'Cat6 twisted pair', cat: 'copper', tier: 'constraint',
    conn: 'rj45', duplex: 'full', vf: 0.65,
    defaults: { lengthM: 30, awg: 23, ratePreset: '1000BASE-T', poe: 'none' },
    limits: {
      channelM: 100,
      rates: [
        { key: '1000BASE-T', bps: 1000e6, maxM: 100, src: 'IEEE 802.3 Clause 40' },
        { key: '2.5GBASE-T', bps: 2500e6, maxM: 100, src: 'IEEE 802.3bz-2016' },
        { key: '5GBASE-T', bps: 5000e6, maxM: 100, src: 'IEEE 802.3bz-2016' },
        // ★ Cat6 上的 10GBASE-T 受外部串扰 (ANEXT) 限制，标准只保证 55 m
        { key: '10GBASE-T', bps: 10000e6, maxM: 55, src: 'IEEE 802.3an / TIA TSB-155-A' }
      ]
    },
    src: 'TIA-568.2-D / IEEE 802.3an'
  },
  {
    key: 'cat6a', zh: '双绞线 Cat6A', en: 'Cat6A twisted pair', cat: 'copper', tier: 'constraint',
    conn: 'rj45', duplex: 'full', vf: 0.65,
    defaults: { lengthM: 30, awg: 23, ratePreset: '10GBASE-T', poe: 'none' },
    limits: {
      channelM: 100,
      rates: [
        { key: '1000BASE-T', bps: 1000e6, maxM: 100, src: 'IEEE 802.3 Clause 40' },
        { key: '5GBASE-T', bps: 5000e6, maxM: 100, src: 'IEEE 802.3bz-2016' },
        { key: '10GBASE-T', bps: 10000e6, maxM: 100, src: 'IEEE 802.3an-2006' }
      ]
    },
    src: 'TIA-568.2-D / IEEE 802.3an'
  },
  {
    key: 'cat8', zh: '双绞线 Cat8', en: 'Cat8 twisted pair', cat: 'copper', tier: 'constraint',
    conn: 'rj45', duplex: 'full', vf: 0.65,
    defaults: { lengthM: 20, awg: 22, ratePreset: '25GBASE-T', poe: 'none' },
    limits: {
      channelM: 30,
      rates: [
        { key: '10GBASE-T', bps: 10000e6, maxM: 30, src: 'IEEE 802.3an' },
        { key: '25GBASE-T', bps: 25000e6, maxM: 30, src: 'IEEE 802.3bq-2016' },
        { key: '40GBASE-T', bps: 40000e6, maxM: 30, src: 'IEEE 802.3bq-2016' }
      ]
    },
    src: 'TIA-568.2-D Cat8 / IEEE 802.3bq'
  },

  // ══════════ 中频电缆（★卫星站落地最常见的现场问题）══════════
  {
    key: 'ifl_l', zh: 'L 波段中频电缆 (IFL)', en: 'L-band IFL coax', cat: 'coax', tier: 'constraint',
    conn: 'coax_if', duplex: 'full', vf: 0.82,
    // ODU↔IDU 之间那根同轴：同时跑 950–2150 MHz 中频信号、10 MHz 基准、BUC/LNB 直流供电。
    // 三条约束任何一条不过都不通，而它在任何链路预算软件里都不出现。
    defaults: { lengthM: 30, cable: 'LMR-400', buсVdc: 24, bucAmps: 3.0, ifMaxLossDb: 25 },
    limits: {
      // 同轴衰减走厂商原始系数式（Times Microwave 公开的拟合式，别自己按 √f 外推）：
      //   Atten(dB/100 ft) = k1·√f(MHz) + k2·f(MHz)
      // k1 是趋肤效应导体损耗、k2 是介质损耗；只有两项都带上，950 MHz 与 2150 MHz
      // 两端才都对得上（单 √f 在 Ka 站常用的高端会偏乐观 0.5 dB 以上）。
      // rLoop：内导体 + 屏蔽层的直流环路电阻（Ω/100 m），BUC 供电压降算它。
      cables: [
        { key: 'RG-6', k1: 0.2087, k2: 0, rLoop100m: 2.95, src: 'Belden 1694A（k1 由 1000/1500 MHz published 值拟合，k2≈0）' },
        { key: 'RG-11', k1: 0.1360, k2: 0, rLoop100m: 1.28, src: 'Belden 7731A（同上拟合）' },
        { key: 'LMR-195', k1: 0.316120, k2: 0.000606, rLoop100m: 5.28, src: 'Times Microwave LMR-195 datasheet' },
        { key: 'LMR-240', k1: 0.242080, k2: 0.000330, rLoop100m: 2.00, src: 'Times Microwave LMR-240 datasheet' },
        { key: 'LMR-400', k1: 0.122290, k2: 0.000260, rLoop100m: 0.67, src: 'Times Microwave LMR-400 datasheet' },
        { key: 'LMR-600', k1: 0.078854, k2: 0.000199, rLoop100m: 0.38, src: 'Times Microwave LMR-600 datasheet' },
        { key: 'LMR-900', k1: 0.052641, k2: 0.000187, rLoop100m: 0.20, src: 'Times Microwave LMR-900 datasheet' }
      ],
      // BUC 允许的输入电压下限占标称的比例（厂商普遍口径：标称 24 V 允许 20–30 V）
      bucVminFrac: 0.83,
      // 中频信号占用 950–2150 MHz；衰减校验按【高端】算——低端过了高端不一定过
      ifBandMHz: [950, 2150]
    },
    src: 'Times Microwave / Belden 手册；BUC-LNB 供电规范'
  },
  {
    key: 'coax_rf', zh: '射频同轴跳线', en: 'RF coax jumper', cat: 'coax', tier: 'power',
    conn: 'coax_rf', duplex: 'full', vf: 0.82,
    // 天线口 ↔ 收发信机之间那根跳线：只算插损（它直接进射频端的馈线损耗）。
    // 电缆型号表与 ifl_l 共用一份（见 mediaOf('ifl_l').limits.cables）。
    defaults: { lengthM: 3, cable: 'LMR-400', freqGHz: 2.0, connectors: 2, connLossDb: 0.15 },
    src: 'Times Microwave / Belden 手册'
  },

  // ══════════ 光纤（功率预算档）══════════
  {
    key: 'smf_1310', zh: '单模光纤 1310 nm', en: 'SMF G.652 @1310 nm', cat: 'fiber', tier: 'power',
    conn: 'fiber', duplex: 'full', vf: 0.68,
    defaults: {
      lengthKm: 2, attnDbKm: 0.35, connectors: 2, connLossDb: 0.35, splices: 2, spliceLossDb: 0.08,
      txDbm: -3, rxSensDbm: -23, marginDb: 3
    },
    limits: {
      // ITU-T G.652.D 上限 0.4 dB/km @1310 nm；典型成缆 0.32–0.36
      attnMaxDbKm: 0.4,
      // 色散系数上限（G.652.D）：1288–1339 nm 区间 |D| ≤ 3.5 ps/(nm·km)
      dispPsNmKm: 3.5
    },
    src: 'ITU-T G.652 (11/2016) Table 1；IEC 61753-1 连接器等级'
  },
  {
    key: 'smf_1550', zh: '单模光纤 1550 nm', en: 'SMF G.652 @1550 nm', cat: 'fiber', tier: 'power',
    conn: 'fiber', duplex: 'full', vf: 0.68,
    defaults: {
      lengthKm: 20, attnDbKm: 0.22, connectors: 2, connLossDb: 0.35, splices: 4, spliceLossDb: 0.08,
      txDbm: 0, rxSensDbm: -28, marginDb: 3
    },
    limits: { attnMaxDbKm: 0.3, dispPsNmKm: 18.0 },
    src: 'ITU-T G.652 (11/2016) Table 1'
  },
  {
    key: 'mmf_om3', zh: '多模光纤 OM3', en: 'MMF OM3 @850 nm', cat: 'fiber', tier: 'power',
    conn: 'fiber', duplex: 'full', vf: 0.66,
    defaults: {
      lengthKm: 0.15, attnDbKm: 3.5, connectors: 2, connLossDb: 0.5, splices: 0, spliceLossDb: 0.1,
      txDbm: -5, rxSensDbm: -17, marginDb: 2
    },
    // OM3 的限制通常不是功率而是模式带宽：10GBASE-SR 300 m（EMB 2000 MHz·km）
    limits: { attnMaxDbKm: 3.5, reachM: { '10GBASE-SR': 300, '1000BASE-SX': 550 } },
    src: 'IEC 60793-2-10 A1a.2；IEEE 802.3ae Clause 52'
  },
  {
    key: 'mmf_om4', zh: '多模光纤 OM4', en: 'MMF OM4 @850 nm', cat: 'fiber', tier: 'power',
    conn: 'fiber', duplex: 'full', vf: 0.66,
    defaults: {
      lengthKm: 0.3, attnDbKm: 3.0, connectors: 2, connLossDb: 0.5, splices: 0, spliceLossDb: 0.1,
      txDbm: -5, rxSensDbm: -17, marginDb: 2
    },
    limits: { attnMaxDbKm: 3.0, reachM: { '10GBASE-SR': 400, '1000BASE-SX': 1000 } },
    src: 'IEC 60793-2-10 A1a.3；IEEE 802.3ae'
  },

  // ══════════ 串行 / 现场总线（约束校验档）══════════
  {
    key: 'rs485', zh: 'RS-485 总线', en: 'RS-485 bus', cat: 'serial', tier: 'constraint',
    conn: 'serial', duplex: 'half', vf: 0.66,
    defaults: { lengthM: 200, baud: 9600, nodes: 8 },
    limits: {
      // TIA/EIA-485-A 本身不规定速率-距离曲线；业界通行经验判据是速率×距离积
      // ≈1e8 bps·m（10 Mbps@12 m ↔ 100 kbps@1200 m）。1200 m 是电缆直流压降与
      // 共模范围下的常用工程上限。节点数 32 是标准负载单位（1 UL）下的上限。
      rateDistProduct: 1.0e8, maxM: 1200, maxNodes: 32
    },
    src: 'TIA/EIA-485-A；TI SLLA070D 应用手册'
  },
  {
    key: 'rs232', zh: 'RS-232 串口', en: 'RS-232 serial', cat: 'serial', tier: 'constraint',
    conn: 'serial', duplex: 'full', vf: 0.66,
    defaults: { lengthM: 10, baud: 9600 },
    // TIA-232-F 以「负载电容 ≤2500 pF」定界，不直接给米数；典型电缆 50–100 pF/m
    limits: { maxCapPf: 2500, cablePfPerM: 50, maxBaud: 20000 },
    src: 'TIA/EIA-232-F'
  },
  {
    key: 'can', zh: 'CAN 总线', en: 'CAN 2.0B bus', cat: 'serial', tier: 'constraint',
    conn: 'can', duplex: 'half', vf: 0.66,
    defaults: { lengthM: 100, baud: 500000, nodes: 10 },
    limits: {
      // ISO 11898-2 位定时决定的速率-距离对照（信号往返 + 采样点约束）
      pairs: [[1000000, 40], [800000, 50], [500000, 100], [250000, 250],
        [125000, 500], [50000, 1000], [20000, 2500], [10000, 5000]],
      maxNodes: 110
    },
    src: 'ISO 11898-2:2016；CiA 301'
  },
  {
    key: 'mbus', zh: 'M-Bus 仪表总线', en: 'M-Bus (EN 13757)', cat: 'serial', tier: 'constraint',
    conn: 'serial', duplex: 'half', vf: 0.66,
    defaults: { lengthM: 350, baud: 2400, nodes: 20 },
    limits: { maxM: 1000, maxNodes: 250, maxBaud: 9600 },
    src: 'EN 13757-2/-3'
  },

  // ══════════ 电力线载波（电表场景的本地通信主力）══════════
  {
    key: 'hplc', zh: '高速电力线载波 HPLC', en: 'HPLC power-line carrier', cat: 'powerline', tier: 'constraint',
    conn: 'powerline', duplex: 'half', vf: 0.6,
    // 国网/南网台区抄表主力。2–12 MHz OFDM，物理层速率高但受台区拓扑与噪声影响极大，
    // 工程上按「跨表箱跳数 + 台区户数」判可达性，不做点对点 dB 预算 —— 故归约束档。
    defaults: { lengthM: 300, meters: 200, hops: 3 },
    limits: { maxMeters: 1000, maxHops: 8, bandMHz: [2, 12], phyBps: 1e6 },
    src: 'Q/GDW 11612《低压电力线宽带载波通信互联互通技术规范》'
  },
  {
    key: 'plc_nb', zh: '窄带电力线载波', en: 'Narrowband PLC (G3/PRIME)', cat: 'powerline', tier: 'constraint',
    conn: 'powerline', duplex: 'half', vf: 0.6,
    defaults: { lengthM: 500, meters: 100, hops: 4 },
    limits: { maxMeters: 500, maxHops: 10, bandKHz: [35, 91], phyBps: 234000 },
    src: 'IEC 61334-5-1；ITU-T G.9903 (G3-PLC)；ITU-T G.9904 (PRIME)'
  },

  // ══════════ 地面无线（功率预算档）══════════
  {
    key: 'wifi_2g4', zh: 'WiFi 2.4 GHz', en: 'WiFi 2.4 GHz', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    defaults: {
      freqGHz: 2.437, bwMHz: 20, mcs: 5, txDbm: 20, gTxDbi: 3, gRxDbi: 3,
      lossTxDb: 1, lossRxDb: 1, distM: 100, model: 'p1238', floors: 0, walls: 2, marginDb: 10
    },
    limits: {
      // 中国 2.4 GHz ISM 等效全向辐射功率上限 20 dBm（工信部 [2002]353 号）
      eirpMaxDbm: 20, sens: WIFI_SENS_20M, rate20: WIFI_RATE_20M_1SS
    },
    src: 'IEEE 802.11ax-2021 Table 27-53/27-58；ITU-R P.1238-11；工信部 [2002]353 号'
  },
  {
    key: 'wifi_5g', zh: 'WiFi 5 GHz', en: 'WiFi 5 GHz', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    defaults: {
      freqGHz: 5.5, bwMHz: 80, mcs: 5, txDbm: 23, gTxDbi: 5, gRxDbi: 5,
      lossTxDb: 1, lossRxDb: 1, distM: 80, model: 'p1238', floors: 0, walls: 2, marginDb: 10
    },
    limits: { eirpMaxDbm: 30, sens: WIFI_SENS_20M, rate20: WIFI_RATE_20M_1SS },
    src: 'IEEE 802.11ax-2021；ITU-R P.1238-11'
  },
  {
    key: 'wifi_mesh', zh: 'WiFi Mesh 自组网', en: 'WiFi mesh (802.11s)', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    // ★ Mesh 的物理层与点对点 WiFi 完全相同；它多出来的是【多跳吞吐折减】：
    //   同频同信道链式转发是半双工共享媒质，n 跳端到端吞吐上界 ≈ R_link/n。
    //   异频（多射频背靠背）不折减。见 sceneTerrestrial.meshDerate()。
    defaults: {
      freqGHz: 5.5, bwMHz: 40, mcs: 4, txDbm: 23, gTxDbi: 6, gRxDbi: 6,
      lossTxDb: 1, lossRxDb: 1, distM: 500, model: 'two-ray', hops: 3, sameChannel: true,
      hTxM: 5, hRxM: 5, marginDb: 12
    },
    limits: { eirpMaxDbm: 30, sens: WIFI_SENS_20M, rate20: WIFI_RATE_20M_1SS, maxHops: 16 },
    src: 'IEEE 802.11s-2011；Gupta & Kumar, IEEE Trans. Inf. Theory 46(2), 2000（容量随跳数衰减）'
  },
  {
    key: 'manet', zh: '宽带自组网电台 (MANET)', en: 'Broadband MANET radio', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    // 应急/单兵/无人系统常用的自组网电台（1.4 GHz / 800 MHz / 350 MHz 等专用频段）。
    // 物理层按 OFDM 链路预算算，多跳折减同 mesh。
    defaults: {
      freqGHz: 1.43, bwMHz: 10, txDbm: 33, gTxDbi: 2, gRxDbi: 2, sensDbm: -95,
      lossTxDb: 1.5, lossRxDb: 1.5, distM: 3000, model: 'two-ray', hops: 3, sameChannel: true,
      hTxM: 2, hRxM: 10, marginDb: 12, rateBps: 4e6
    },
    limits: { maxHops: 16 },
    src: 'ITU-R P.1546-6（点对面地面传播）；厂商公开指标'
  },
  {
    key: 'lora', zh: 'LoRa', en: 'LoRa', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    defaults: {
      freqGHz: 0.470, bwKHz: 125, sf: 10, crDen: 5, txDbm: 17, gTxDbi: 2, gRxDbi: 5,
      lossTxDb: 0.5, lossRxDb: 0.5, distM: 5000, model: 'hata-rural', hTxM: 2, hRxM: 20, marginDb: 10
    },
    limits: {
      sens: LORA_SENS, bwAdj: LORA_BW_ADJ,
      // 中国 470–510 MHz 微功率短距离设备：ERP ≤ 50 mW（17 dBm）
      erpMaxDbm: 17
    },
    src: 'Semtech SX1276 datasheet Table 13；AN1200.22；工信部 [2019]52 号'
  },
  {
    key: 'zigbee', zh: 'ZigBee / 802.15.4', en: 'ZigBee / IEEE 802.15.4', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    defaults: {
      freqGHz: 2.405, txDbm: 8, gTxDbi: 2, gRxDbi: 2, sensDbm: -100,
      lossTxDb: 0.5, lossRxDb: 0.5, distM: 100, model: 'p1238', walls: 1, floors: 0, marginDb: 8, rateBps: 250000
    },
    limits: { eirpMaxDbm: 20 },
    src: 'IEEE 802.15.4-2020（-85 dBm 最低要求，典型芯片 -100 dBm）'
  },
  {
    key: 'ble', zh: '蓝牙 LE', en: 'Bluetooth LE', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    defaults: {
      freqGHz: 2.44, txDbm: 4, gTxDbi: 0, gRxDbi: 0, sensDbm: -95,
      lossTxDb: 0.5, lossRxDb: 0.5, distM: 30, model: 'p1238', walls: 1, floors: 0, marginDb: 6, rateBps: 1e6
    },
    src: 'Bluetooth Core Spec 5.4（LE 1M PHY 最低灵敏度 -70 dBm，典型 -95）'
  },
  {
    key: 'uhf_data', zh: 'UHF 数传电台', en: 'UHF data radio', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    // 中国电力无线专网 223–235 MHz、水利/环保常用 400–470 MHz、公安 350 MHz。
    defaults: {
      freqGHz: 0.433, bwKHz: 25, txDbm: 37, gTxDbi: 2, gRxDbi: 8, sensDbm: -110,
      lossTxDb: 2, lossRxDb: 2, distM: 15000, model: 'hata-rural', hTxM: 3, hRxM: 30, marginDb: 12, rateBps: 19200
    },
    src: 'ITU-R P.1546-6；ETSI EN 300 113（12.5/25 kHz 窄带数传）'
  },
  {
    key: 'vhf_data', zh: 'VHF 数传 / 海事 VHF', en: 'VHF data / marine VHF', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    // 海事 VHF 156–174 MHz；AIS 161.975 / 162.025 MHz（ITU-R M.1371）。
    defaults: {
      freqGHz: 0.162, bwKHz: 25, txDbm: 37, gTxDbi: 3, gRxDbi: 6, sensDbm: -112,
      lossTxDb: 2, lossRxDb: 2, distM: 30000, model: 'los-sea', hTxM: 4, hRxM: 25, marginDb: 10, rateBps: 9600
    },
    src: 'ITU-R M.1371-5 (AIS)；ITU-R P.1546-6'
  },
  {
    key: 'hf_ssb', zh: '短波电台 (HF)', en: 'HF SSB radio', cat: 'wireless', tier: 'contract',
    conn: 'air', duplex: 'half', vf: 1.0,   // 短波仍是空口（两台电台对打），只是不可算
    // ★ 短波靠电离层天波，可通性随昼夜/季节/太阳活动大幅变化，逐时可通率要跑 ITU-R P.533
    //   （完整的 HF 传播预测程序，含 F2 层临界频率图）。本平台没有 P.533，故不算：
    //   归契约档，用户给「可通时段占比」，出参标 quoted。绝不拿自由空间损耗假装算短波。
    defaults: { distKm: 800, availPct: 70, rateBps: 2400 },
    src: '不计算。逐时可通性需 ITU-R P.533 电离层预测，本平台未实现'
  },
  {
    key: 'microwave_ptp', zh: '点对点微波', en: 'Point-to-point microwave', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'full', vf: 1.0,
    defaults: {
      freqGHz: 7.0, bwMHz: 28, txDbm: 25, gTxDbi: 34, gRxDbi: 34, sensDbm: -80,
      lossTxDb: 1.5, lossRxDb: 1.5, distKm: 20, hTxM: 40, hRxM: 40,
      model: 'los', rainMmH: 42, dN1: -300, availPct: 99.99, terrainKind: 'inland', marginDb: 0
    },
    src: 'ITU-R P.530-18（多径衰落 §2.3、雨衰 §2.4）；ITU-R P.838-3（雨比衰减）'
  },
  {
    key: 'video_58', zh: '图传 5.8 GHz', en: 'Video downlink 5.8 GHz', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    defaults: {
      freqGHz: 5.8, bwMHz: 20, txDbm: 27, gTxDbi: 2, gRxDbi: 12, sensDbm: -92,
      lossTxDb: 1, lossRxDb: 1, distM: 8000, model: 'los-air', hTxM: 120, hRxM: 10, marginDb: 12, rateBps: 12e6
    },
    src: 'ITU-R P.525-4（自由空间）；ITU-R P.526-15（绕射/菲涅尔净空）'
  },
  {
    key: 'video_14', zh: '图传 1.4 GHz', en: 'Video downlink 1.4 GHz', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    defaults: {
      freqGHz: 1.43, bwMHz: 10, txDbm: 30, gTxDbi: 2, gRxDbi: 10, sensDbm: -96,
      lossTxDb: 1, lossRxDb: 1, distM: 20000, model: 'los-air', hTxM: 300, hRxM: 15, marginDb: 12, rateBps: 6e6
    },
    src: 'ITU-R P.525-4；ITU-R P.526-15'
  },
  {
    key: 'ism_433', zh: '433 MHz 短距无线', en: '433 MHz ISM link', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'half', vf: 1.0,
    defaults: {
      freqGHz: 0.433, bwKHz: 100, txDbm: 10, gTxDbi: 0, gRxDbi: 2, sensDbm: -105,
      lossTxDb: 0.5, lossRxDb: 0.5, distM: 800, model: 'two-ray', hTxM: 1.5, hRxM: 5, marginDb: 8, rateBps: 9600
    },
    limits: { erpMaxDbm: 10 },
    src: '工信部 [2019]52 号（微功率短距离）'
  },
  {
    key: 'fso', zh: '大气激光 (FSO)', en: 'Free-space optics', cat: 'wireless', tier: 'power',
    conn: 'air', duplex: 'full', vf: 1.0,
    defaults: {
      wavelengthNm: 1550, txDbm: 20, divMrad: 2.0, apertureM: 0.08, distM: 1000,
      rxSensDbm: -36, visibilityKm: 10, pointingLossDb: 3, marginDb: 10
    },
    src: 'ITU-R P.1817-1（自由空间光链路传播）；Kim 模型（气溶胶消光）'
  },

  // ══════════ 契约档 ══════════
  {
    key: 'leased_mstp', zh: '运营商专线 (MSTP/OTN)', en: 'Carrier leased line', cat: 'contract', tier: 'contract',
    conn: 'wan', duplex: 'full', vf: 0.68,
    defaults: { rateBps: 10e6, latencyMs: 15, availPct: 99.9, distKm: 50 },
    src: '契约值：由运营商 SLA 给定，不计算'
  },
  {
    key: 'internet_bb', zh: '互联网宽带', en: 'Internet broadband', cat: 'contract', tier: 'contract',
    conn: 'wan', duplex: 'full', vf: 0.68,
    defaults: { rateBps: 100e6, rateUpBps: 30e6, latencyMs: 25, availPct: 99.5 },
    src: '契约值：由运营商 SLA 给定，不计算'
  },
  {
    key: 'cellular_4g', zh: '4G 公网', en: '4G public cellular', cat: 'contract', tier: 'contract',
    // ★ conn 取 'wan' 不是 'air'：契约链路不是本平台建模的空口，是一段【服务交付】。
    //   设备侧那个「4G 口」是服务的落地点，对端是平台的广域网交付口 —— 两者同族才连得上。
    //   写成 'air' 会让「终端 4G ↔ 平台互联网」这种再正常不过的边连不上。
    conn: 'wan', duplex: 'full', vf: 1.0,
    // ★ 归契约档而非功率档：公网覆盖是运营商的既成事实（基站位置/功率/天线倾角都不公开），
    //   拿 Hata/COST-231 反推「这里有没有信号」是伪计算。用户断言有无覆盖 + 给速率。
    defaults: { rateBps: 20e6, rateUpBps: 5e6, latencyMs: 50, availPct: 99.0, covered: true },
    src: '契约值：公网覆盖不计算'
  },
  {
    key: 'cellular_5g', zh: '5G 公网', en: '5G public cellular', cat: 'contract', tier: 'contract',
    conn: 'wan', duplex: 'full', vf: 1.0,
    defaults: { rateBps: 300e6, rateUpBps: 60e6, latencyMs: 20, availPct: 99.0, covered: true },
    src: '契约值：公网覆盖不计算'
  },
  {
    key: 'nbiot', zh: 'NB-IoT 公网', en: 'NB-IoT public', cat: 'contract', tier: 'contract',
    conn: 'wan', duplex: 'half', vf: 1.0,
    defaults: { rateBps: 60000, rateUpBps: 60000, latencyMs: 1500, availPct: 99.0, covered: true },
    src: '契约值；速率上限见 3GPP TS 36.306（NB1 下行 26 kbps / 上行 62 kbps 单载波）'
  },

  // ══════════ 卫星段（交给 linkChain，本模块不算）══════════
  {
    key: 'sat_uhf', zh: '卫星 UHF', en: 'Satellite UHF', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'UHF', duplex: 'half' },
  { key: 'sat_l', zh: '卫星 L', en: 'Satellite L', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'L', duplex: 'full' },
  { key: 'sat_s', zh: '卫星 S', en: 'Satellite S', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'S', duplex: 'full' },
  { key: 'sat_c', zh: '卫星 C', en: 'Satellite C', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'C', duplex: 'full' },
  { key: 'sat_x', zh: '卫星 X', en: 'Satellite X', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'X', duplex: 'full' },
  { key: 'sat_ku', zh: '卫星 Ku', en: 'Satellite Ku', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'Ku', duplex: 'full' },
  { key: 'sat_ka', zh: '卫星 Ka', en: 'Satellite Ka', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'Ka', duplex: 'full' },
  { key: 'sat_q', zh: '卫星 Q', en: 'Satellite Q', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'Q', duplex: 'full' },
  { key: 'sat_v', zh: '卫星 V', en: 'Satellite V', cat: 'satellite', tier: 'satellite', conn: 'air', band: 'V', duplex: 'full' },
  { key: 'isl_rf', zh: '星间微波', en: 'ISL (RF)', cat: 'satellite', tier: 'satellite', conn: 'air', duplex: 'full' },
  { key: 'isl_laser', zh: '星间激光', en: 'ISL (laser)', cat: 'satellite', tier: 'satellite', conn: 'air', duplex: 'full' },

  // ══════════ 供电边 ══════════
  { key: 'ac_mains', zh: '市电 AC', en: 'AC mains', cat: 'supply', tier: 'supply', conn: 'ac', defaults: { vac: 220, availPct: 99.5 }, src: '—' },
  { key: 'dc_12', zh: '直流 12 V', en: 'DC 12 V', cat: 'supply', tier: 'supply', conn: 'dc', defaults: { vdc: 12 }, src: '—' },
  { key: 'dc_24', zh: '直流 24 V', en: 'DC 24 V', cat: 'supply', tier: 'supply', conn: 'dc', defaults: { vdc: 24 }, src: '—' },
  { key: 'dc_48', zh: '直流 48 V', en: 'DC 48 V', cat: 'supply', tier: 'supply', conn: 'dc', defaults: { vdc: 48 }, src: '—' },
  {
    key: 'poe', zh: 'PoE 以太网供电', en: 'Power over Ethernet', cat: 'supply', tier: 'constraint',
    conn: 'rj45', duplex: 'full', vf: 0.65,
    defaults: { lengthM: 40, awg: 24, type: '802.3at' },
    limits: {
      // IEEE 802.3-2022 Clause 33（af/at）与 802.3bt-2018（Type 3/4）
      // psePw：PSE 端口输出功率；pdPw：PD 端保证可得功率；pairs：参与供电的线对数
      // vPseMin：PSE 最低输出电压；vPdMin：PD 最低工作电压；rChMax：标准允许的信道回路电阻
      types: [
        { key: '802.3af', psePw: 15.4, pdPw: 12.95, pairs: 2, vPseMin: 44.0, vPdMin: 37.0, rChMax: 20.0 },
        { key: '802.3at', psePw: 30.0, pdPw: 25.5, pairs: 2, vPseMin: 50.0, vPdMin: 42.5, rChMax: 12.5 },
        { key: '802.3bt-T3', psePw: 60.0, pdPw: 51.0, pairs: 4, vPseMin: 50.0, vPdMin: 42.5, rChMax: 12.5 },
        { key: '802.3bt-T4', psePw: 90.0, pdPw: 71.3, pairs: 4, vPseMin: 52.0, vPdMin: 41.1, rChMax: 12.5 }
      ]
    },
    src: 'IEEE 802.3-2022 Clause 33；IEEE 802.3bt-2018 Table 145-16'
  },
  { key: 'battery', zh: '电池组', en: 'Battery pack', cat: 'supply', tier: 'supply', conn: 'dc', defaults: { vdc: 12, ah: 65, chem: 'lifepo4' }, src: '—' },
  { key: 'solar', zh: '太阳能', en: 'Solar PV', cat: 'supply', tier: 'supply', conn: 'dc', defaults: { wp: 100, psh: 3.5, etaSys: 0.75 }, src: 'IEC 61215（STC 标定）；PSH 需查当地辐照数据' }
];

// 索引
const MEDIA_BY_KEY = Object.create(null);
for (const m of MEDIA) MEDIA_BY_KEY[m.key] = m;

const mediaOf = (key) => MEDIA_BY_KEY[key] || null;
const tierOf = (key) => { const m = mediaOf(key); return m ? m.tier : null; };

// 介质分组（UI 下拉与拓扑图图例用）
const MEDIA_CATS = [
  { key: 'satellite', zh: '卫星', en: 'Satellite' },
  { key: 'wireless', zh: '地面无线', en: 'Terrestrial radio' },
  { key: 'fiber', zh: '光纤', en: 'Fiber' },
  { key: 'copper', zh: '铜缆以太网', en: 'Copper Ethernet' },
  { key: 'coax', zh: '同轴', en: 'Coax' },
  { key: 'serial', zh: '串行总线', en: 'Serial bus' },
  { key: 'powerline', zh: '电力线载波', en: 'Power-line carrier' },
  { key: 'contract', zh: '契约链路', en: 'Contracted link' },
  { key: 'supply', zh: '供电', en: 'Power supply' }
];

// ── 端口方向与匹配 ──
// dir: 'tx' 只发 | 'rx' 只收 | 'trx' 收发。两个端口能连的条件：
//   ① 连接器族相同；② 方向相容（trx↔trx / trx↔tx / trx↔rx / tx↔rx）；③ 不是同一个模块的两个口。
function dirCompatible(a, b) {
  if (a === 'trx' || b === 'trx') return true;
  return (a === 'tx' && b === 'rx') || (a === 'rx' && b === 'tx');
}
// 两个端口是否可连；返回 { ok, reason }
function portsCompatible(pa, pb) {
  if (!pa || !pb) return { ok: false, reason: 'missing-port' };
  const ma = mediaOf(pa.medium), mb = mediaOf(pb.medium);
  if (!ma || !mb) return { ok: false, reason: 'unknown-medium' };
  if (ma.conn !== mb.conn) return { ok: false, reason: 'connector-mismatch' };
  if (!dirCompatible(pa.dir || 'trx', pb.dir || 'trx')) return { ok: false, reason: 'direction-mismatch' };
  // 射频空口还要频段相容（UHF 终端接不上 Ka 馈源）
  if (ma.conn === 'air') {
    const ba = pa.band || ma.band, bb = pb.band || mb.band;
    if (ba && bb && ba !== bb) return { ok: false, reason: 'band-mismatch' };
  }
  return { ok: true, reason: '' };
}

// ── 频率工具 ──
const bandOf = (fGHz) => {
  for (const b of BANDS) if (fGHz >= b.lo && fGHz < b.hi) return b.key;
  return null;
};
const bandDef = (key) => BANDS.find((b) => b.key === key) || null;

module.exports = {
  C_LIGHT, RE_KM, K_EFF, CU_R_PER_M,
  CONNECTORS, BANDS, MEDIA, MEDIA_CATS,
  LORA_SENS, LORA_BW_ADJ, WIFI_SENS_20M, WIFI_RATE_20M_1SS,
  loraBitrate, mediaOf, tierOf, dirCompatible, portsCompatible, bandOf, bandDef
};
