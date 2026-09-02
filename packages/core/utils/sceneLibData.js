// utils/sceneLibData.js
// 应用场景仿真 —— 内置模块库（纯数据）。
//
// ★ 核心约束：模块【绝不复制】射频参数的真值。场景里一个射频模块用的是「地球站库/卫星库里的
//   某一条」，本表的 rf / sat 字段只是【新建那条库条目时的出厂值】。库建好之后改参数改的是库，
//   模块不跟着变也不该变 —— 平台已经把三库全局化了，模块库要是自带一套并行的射频参数，
//   同一面天线就会有两个真值源。
//
// ============ 字段 ============
//   id        稳定标识（改名不变，配置里存的就是它）
//   cat       B 地面固定站 / C 移动平台 / D 感知末端 / E 汇聚边缘 /
//             （A 空间段已不在模块库里：卫星改为引用平台卫星库，见 sceneSat.js）
//             F 射频器件（天线·馈线，挂在别的模块上）/ G 供电 / H 中心平台
//   group     二级分组（库树的第二层）
//   zh/en     显示名。★ 型号名是数据不是界面语汇，中英一律照厂商原文，不做「翻译」
//   symbol    符号 id（见 src/viz/scene/sceneSymbols.js，2D/3D 共用同一支画笔）
//   ports[]   端口清单：{ key, zh, medium, dir, role }
//               dir  'tx'|'rx'|'trx'；role 'data'|'if'|'power'|'mgmt'|'sense'
//   rf        地球站库字段的出厂值（键名与 e2eParams.ES_FIELDS 逐字一致）
//   typical   true = rf/sat 里的电平类数值是【该类设备的典型值】而非该型号的实测值。
//             ★ 波束 EIRP / G_T 只有做过对地覆盖分析才知道，本表不冒充；UI 据此打标。
//   phy       { rateDnBps, rateUpBps }：厂商标称的接入速率上限（速率账用）
//   power     { txW, rxW, idleW, sleepW, alwaysW, supply }
//   env       { ip, tempMin, tempMax, massKg, sizeMm }
//   place     { modes:[...], mountable, hostCats:[...] }  放置方式与可挂载性
//   children  复合模块的默认子模块 id 列表
//   antenna   仅 cat 'F'：{ gainDbi, band, beamwidthDeg, pol }
//   sense     仅 cat 'D'：{ bytesPerSample, samplesPerDay, kind }  —— 业务流速率的来源
//   tags      行业标签（场景模板与库检索用）
//   src       出处。★ 没有出处的数不写进这张表：宁可留 null 让上层报「缺参数」
//
// ============ 出处缩写 ============
//   [卫通]  《中国卫通基本情况介绍（公开）》产品册（终端型谱四表 + 卫星资源表）
//   [天启]  《天启卫星宣传册 26 年二季度》（星座构成 + 七类终端参数表）
//   [低空]  《低空经济场景应用与通信需求白皮书》数字低空工作组 2025.4
//   [类型]  该类设备的行业通行典型值（非某一型号实测），已在 typical 标出

'use strict';

// 端口速写：p(key, 介质, 方向, 角色, 中文名)
const p = (key, medium, dir, role, zh) => ({ key, medium, dir: dir || 'trx', role: role || 'data', zh: zh || key });

// 常用端口组合
const PORT_RJ45 = (n) => Array.from({ length: n || 1 }, (_, i) => p('lan' + (i + 1), 'cat6', 'trx', 'data', `网口 ${i + 1}`));
const PORT_DC = (v) => p('pwr', v === 12 ? 'dc_12' : v === 48 ? 'dc_48' : 'dc_24', 'rx', 'power', '供电');
const PORT_AC = () => p('pwr', 'ac_mains', 'rx', 'power', '市电');
const PORT_485 = () => p('rs485', 'rs485', 'trx', 'data', 'RS-485');

// 地球站库出厂值速写。
// ★ opPowerW 是【这条载波的功放输出功率】，不是整站 HPA 的额定值 —— 端到端只有正向递推，
//   这个数就是本段链路的起点电平。信关站的 HPA 可能有几百瓦，但那是全部载波共用的；
//   给一条 9.6 kbps 的窄带载波填 600 W，引擎会算出它把整个转发器打到饱和以上。
const es = (dia, w, o) => Object.assign({
  antennaDiameter: dia, opPowerW: w,
  antennaEfficiency: 65, paBackoff: 0, feederLoss: 0.5, uplinkPowerControl: '否', upcValue: 0,
  rxAntennaEfficiency: 65, rxAntennaNoiseTempMode: '自动', rxAntennaNoiseTemp: 35,
  rxReceiverNoiseTemp: 75, rxFeederLoss: 0.3
}, o || {});

// ═══════════════════════════════════════════════════════════════════════════
// 预置卫星（★ 不是模块库条目）
// ═══════════════════════════════════════════════════════════════════════════
// 二期起，场景里的卫星【引用平台卫星库】（library.json 命名空间 'e2e' 的 sat[]，与端到端
// 链路预算窗口共用同一份），不再是模块库的一类条目 —— 一期那种写死 20 颗星的做法，
// 等于用户想用 AsiaSat 7 / Starlink / 北斗 / 自己导入的星就没辙。
//
// 这张表因此改成「一键建库条目」的出厂预置：点一下在卫星库里生成一条，之后它与用户
// 自己建的条目没有任何区别（可改名、改参数、换轨道来源）。数据一条没删。
//
// 字段：key 稳定标识 / zh 中文名 / en 英文编目名（★ 轨位目录搜「中星 26」要能命中
// CHINASAT 26，靠的就是这一列）/ group 分组 / typical 电平类数值是否为该类典型值 /
// sat 卫星库字段出厂值（键名与 e2eParams.SAT_FIELDS 逐字一致，迁移零成本）/ src 出处。
const GEO = (key, zh, en, lonE, band, o) => ({
  key, zh, en, group: (o && o.group) || 'geo-cn', typical: true,
  sat: Object.assign({
    satelliteName: zh, frequencyBand: band, orbitClass: 'GSO', orbitLongitude: lonE,
    gt: 0, sfdRef: -85, sfdGtRef: 0, BOi: 6, BOo: 3, transponderBandwidth: 36, eirpSat: 48, eirp: 30, procDelayMs: 0,
    aciUplinkFactor: 30, adjUplinkFactor: 25, xpolUplinkFactor: 26, hpaIntermodFactor: 24,
    aciDownlinkFactor: 30, adjDownlinkFactor: 25, xpolDownlinkFactor: 26, xpdrIntermodFactor: 21
  }, (o && o.sat) || {}),
  tags: (o && o.tags) || ['卫通'],
  src: (o && o.src) || '[卫通] 空间段资源表（轨位与频段为公开事实；转发器电平为该类典型值）'
});

const SAT_PRESETS_SCENE = [
  GEO('cs15', '中星 15 号', 'CHINASAT 15', 51.5, 'C', { sat: { transponderBandwidth: 36, eirpSat: 44 }, src: '[卫通] 轨位 51.5°E；C/Ku' }),
  GEO('ap7', '亚太 7 号', 'APSTAR 7', 76.5, 'C', { tags: ['卫通', '亚太'] }),
  GEO('cs12', '中星 12 号', 'CHINASAT 12', 87.5, 'C'),
  GEO('cs27', '中星 27 号', 'CHINASAT 27', 87.5, 'Ka', {
    sat: { transponderBandwidth: 250, eirpSat: 62, gt: 14 },
    tags: ['卫通', '高通量', '在建'], src: '[卫通] 在建，容量 300 Gbps，四洲两洋；数字化处理载荷'
  }),
  GEO('cs9c', '中星 9C', 'CHINASAT 9C', 92.2, 'Ku-BSS', { tags: ['卫通', '广电'] }),
  GEO('cs11', '中星 11 号', 'CHINASAT 11', 98.0, 'C', { tags: ['卫通', '物联'], src: '[卫通] 窄带物联网近期拓展载体（亚太，北京/香港站网）' }),
  GEO('cs9b', '中星 9B', 'CHINASAT 9B', 101.4, 'Ku-BSS', { tags: ['卫通', '广电'] }),
  GEO('cs16', '中星 16 号', 'CHINASAT 16', 110.5, 'Ka', {
    sat: { transponderBandwidth: 250, eirpSat: 60, gt: 12 }, tags: ['卫通', '高通量'],
    src: '[卫通] 我国首颗高轨 Ka 高通量卫星（20 Gbps）'
  }),
  GEO('cs10r', '中星 10R', 'CHINASAT 10R', 110.5, 'C'),
  GEO('cs6e', '中星 6E', 'CHINASAT 6E', 115.5, 'C', { tags: ['卫通', '广电'] }),
  GEO('cs6d', '中星 6D', 'CHINASAT 6D', 125.0, 'C', { tags: ['卫通', '广电'] }),
  GEO('cs26', '中星 26 号', 'CHINASAT 26', 125.0, 'Ka', {
    sat: { transponderBandwidth: 250, eirpSat: 61, gt: 13 }, tags: ['卫通', '高通量'],
    src: '[卫通] 高通量 100 Gbps；94 波束'
  }),
  GEO('cs6c', '中星 6C', 'CHINASAT 6C', 130.0, 'C', {
    tags: ['卫通', '广电', '物联'],
    src: '[卫通] 窄带卫星物联网当前载体（覆盖中国境内及中亚，北京/怀来站网）'
  }),
  GEO('ap6c', '亚太 6C', 'APSTAR 6C', 134.0, 'C', { tags: ['卫通', '亚太'] }),
  GEO('ap6e', '亚太 6E', 'APSTAR 6E', 134.0, 'Ku', { sat: { eirpSat: 55, gt: 8 }, tags: ['卫通', '亚太', '高通量'] }),
  GEO('ap6d', '亚太 6D', 'APSTAR 6D', 134.0, 'Ku', { sat: { transponderBandwidth: 250, eirpSat: 58, gt: 10 }, tags: ['卫通', '亚太', '高通量'] }),
  GEO('ap5c', '亚太 5C', 'APSTAR 5C', 138.0, 'C', { tags: ['卫通', '亚太'] }),
  GEO('ap9', '亚太 9 号', 'APSTAR 9', 142.0, 'C', { tags: ['卫通', '亚太'] }),
  GEO('cs19', '中星 19 号', 'CHINASAT 19', 163.0, 'Ka', { sat: { transponderBandwidth: 250, eirpSat: 58, gt: 10 }, tags: ['卫通', '高通量'] }),

  // ── 天启星座（低轨窄带物联网）──
  {
    key: 'tq1', zh: '天启星座（一期 · 低倾角）', en: 'Tianqi Phase-1 (45 deg plane)', group: 'leo-iot', typical: true,
    sat: {
      // ★ 频段是 UHF 不是 L：模板与终端的星地链路频率是 0.4 GHz（UHF 段 0.3–3.0 GHz）。
      //   一期这里写着 L、端口却写死 sat_uhf，两者不一致被硬编码的端口盖住了；二期端口按
      //   frequencyBand 现算，写错就是「C 站接不上 C 星」那类连不上。
      satelliteName: '天启一期', frequencyBand: 'UHF', orbitClass: 'NGSO', orbitAltitude: 900, orbitInclination: 45,
      gt: -18, eirp: 10, procDelayMs: 0,
      aciUplinkFactor: 25, adjUplinkFactor: 22, xpolUplinkFactor: 20, hpaIntermodFactor: 25,
      aciDownlinkFactor: 25, adjDownlinkFactor: 22, xpolDownlinkFactor: 20, xpdrIntermodFactor: 25
    },
    tags: ['天启', '物联', '低轨'],
    src: '[天启] 36 颗 900 km / 45°（六轨道面 × 6）；UHF；准实时。载荷 G/T 与 EIRP 为该类窄带低轨典型值'
  },
  {
    key: 'tq1sso', zh: '天启星座（一期 · 太阳同步）', en: 'Tianqi Phase-1 (SSO)', group: 'leo-iot', typical: true,
    sat: {
      satelliteName: '天启一期SSO', frequencyBand: 'UHF', orbitClass: 'NGSO', orbitAltitude: 900, orbitInclination: 97,
      gt: -18, eirp: 10, procDelayMs: 0
    },
    tags: ['天启', '物联', '低轨'],
    src: '[天启] 2 颗 97° 倾角太阳同步轨道'
  },
  {
    key: 'tq2', zh: '天启星座（二期 · IOT-NTN）', en: 'Tianqi Phase-2 (IoT-NTN)', group: 'leo-iot', typical: true,
    sat: {
      satelliteName: '天启二期', frequencyBand: 'S', orbitClass: 'NGSO', orbitAltitude: 900, orbitInclination: 45,
      gt: -14, eirp: 14, procDelayMs: 5
    },
    tags: ['天启', '物联', '低轨', 'NTN'],
    src: '[天启] 48 星，900 km，UHF/L/S，IOT-NTN 体制，支持星间链路，实时'
  },

  // ── 通用占位星（用户自填 / 从星历取）──
  {
    key: 'generic.geo', zh: '通用 GEO 透明转发星', en: 'Generic GEO bent-pipe', group: 'generic',
    sat: {
      satelliteName: 'GEO 卫星', frequencyBand: 'Ku', orbitClass: 'GSO', orbitLongitude: 110.5,
      gt: 2, sfdRef: -84, sfdGtRef: 0, BOi: 6, BOo: 3, transponderBandwidth: 36, eirpSat: 46, eirp: 28, procDelayMs: 0
    },
    tags: ['通用'], src: '空白模板：轨位/频段/电平全部自填'
  },
  {
    key: 'generic.leo', zh: '通用 NGSO 卫星', en: 'Generic NGSO satellite', group: 'generic',
    sat: {
      satelliteName: 'NGSO 卫星', frequencyBand: 'Ka', orbitClass: 'NGSO', orbitAltitude: 1200, orbitInclination: 53,
      gt: 5, eirp: 30, procDelayMs: 2
    },
    tags: ['通用'], src: '空白模板'
  },
  {
    key: 'generic.regen', zh: '再生式处理载荷星', en: 'Regenerative payload satellite', group: 'generic',
    sat: {
      satelliteName: '再生式卫星', frequencyBand: 'Ka', orbitClass: 'NGSO', orbitAltitude: 1200, orbitInclination: 53,
      gt: 8, eirp: 32, procDelayMs: 5
    },
    tags: ['通用', '再生'], src: '空白模板：星上解调-重调，链上按再生节点切段'
  }
];

// ═══════════════════════════════════════════════════════════════════════════
// B 地面固定站（卫星终端）
// ═══════════════════════════════════════════════════════════════════════════
// 速率与重量照产品册原文；口径→天线增益由引擎按面积法算，本表只给口径与功放。
const B = (id, zh, o) => Object.assign({
  id: 'es.' + id, cat: 'B', group: o.group || 'vsat', zh, en: o.en || zh, symbol: o.symbol || 'dish',
  ports: o.ports || [p('rf', o.satMedium || 'sat_ka', 'trx', 'data', '卫星空口'), p('ifl', 'ifl_l', 'trx', 'if', 'ODU↔IDU 中频'), ...PORT_RJ45(1), PORT_AC()],
  place: { modes: ['fixed'], mountable: o.mountable || false, hostCats: o.hostCats || [] },
  typical: o.typical !== false,
  tags: o.tags || ['卫通'],
  src: o.src || '[卫通] 终端型谱'
}, o.extra || {}, { rf: o.rf, phy: o.phy, power: o.power, env: o.env, children: o.children });

const STATIONS = [
  // ── 政企互联（Ka 宽带）──
  B('ka.fixed.098', 'Ka 固定站 0.98 m', {
    rf: es(0.98, 4, { antennaEfficiency: 65, feederLoss: 0.5 }),
    phy: { rateDnBps: 140e6, rateUpBps: 15e6 },
    power: { alwaysW: 90, supply: 'ac_mains' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 55, massKg: 40 },
    tags: ['卫通', '政企', '宽带'],
    src: '[卫通] 政企互联/物联：0.98 m + 4 W，下行 140 Mbps / 上行 15 Mbps，≤40 kg'
  }),
  B('ka.fixed.12', 'Ka 高性能固定站 1.2 m（自动对星）', {
    rf: es(1.2, 4, { antennaEfficiency: 66 }),
    phy: { rateDnBps: 140e6, rateUpBps: 15e6 },
    power: { alwaysW: 120, supply: 'ac_mains' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 55, massKg: 55 },
    tags: ['卫通', '物联', '宽带'], src: '[卫通] 物联产品：1.2 m + 4 W，支持自动对星'
  }),
  B('ka.unattended.045', 'Ka 无人值守固定站 0.45 m', {
    rf: es(0.45, 4), phy: { rateDnBps: 110e6, rateUpBps: 8e6 },
    power: { alwaysW: 60, supply: 'solar' },
    env: { ip: 'IP66', tempMin: -40, tempMax: 55, massKg: 40 },
    tags: ['卫通', '物联', '无人值守'], src: '[卫通] 物联产品：0.45 m + 4 W，上行 8 Mbps / 下行 110 Mbps'
  }),
  B('ka.flat.035', 'Ka 平板便携站 0.35 m', {
    symbol: 'flatpanel', rf: es(0.35, 4, { antennaEfficiency: 55 }),
    phy: { rateDnBps: 100e6, rateUpBps: 12e6 },
    power: { alwaysW: 65, supply: 'dc_24' },
    env: { ip: 'IP65', tempMin: -30, tempMax: 55, massKg: 13.6 },
    tags: ['卫通', '政企', '便携'], src: '[卫通] 政企互联：0.35 m 平板，13.6 kg'
  }),
  B('ka.port.045', 'Ka 超轻便携站 0.45 m', {
    rf: es(0.45, 4), phy: { rateDnBps: 60e6, rateUpBps: 12e6 },
    power: { alwaysW: 55, supply: 'dc_24' },
    env: { ip: 'IP65', tempMin: -30, tempMax: 55, massKg: 7.5 },
    tags: ['卫通', '政企', '便携', '应急'], src: '[卫通] 政企互联：7.5 kg'
  }),
  B('ka.port.06', 'Ka 高性能便携站 0.6 m', {
    rf: es(0.6, 6), phy: { rateDnBps: 100e6, rateUpBps: 10e6 },
    power: { alwaysW: 80, supply: 'dc_24' },
    env: { ip: 'IP65', tempMin: -30, tempMax: 55, massKg: 12 },
    tags: ['卫通', '政企', '便携', '应急'], src: '[卫通] 政企互联：12 kg'
  }),
  B('ka.manpack.018', 'Ka 背负式卫通终端 0.18 m', {
    symbol: 'flatpanel', rf: es(0.18, 2, { antennaEfficiency: 50 }),
    phy: { rateDnBps: 1e6, rateUpBps: 500e3 },
    power: { alwaysW: 25, supply: 'battery' },
    env: { ip: 'IP66', tempMin: -30, tempMax: 55, massKg: 10 },
    tags: ['卫通', '政企', '单兵', '应急'], src: '[卫通] 政企互联：≤10 kg，下行 1 Mbps / 上行 500 kbps'
  }),

  // ── 物联（C / Ku 低中速）──
  B('c.iot.015', 'C 卫星物联网低成本固定站 0.15 m', {
    symbol: 'flatpanel', satMedium: 'sat_c', rf: es(0.15, 2, { antennaEfficiency: 50, feederLoss: 0.3 }),
    phy: { rateDnBps: 750e3, rateUpBps: 30e3 },
    power: { txW: 12, rxW: 3, idleW: 2, supply: 'dc_12' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 60, massKg: 2.5, sizeMm: '221×183×60' },
    ports: [p('rf', 'sat_c', 'trx', 'data', 'C 空口'), ...PORT_RJ45(1), PORT_485(), PORT_DC(12)],
    tags: ['卫通', '物联', '能源', '应急'],
    src: '[卫通] 物联产品：0.15 m + 2 W，上行 30 kbps / 下行 750 kbps，1.5–2.5 kg'
  }),
  B('c.iot.015.track', 'C 卫星物联网固定站 0.15 m（自动跟踪）', {
    symbol: 'flatpanel', satMedium: 'sat_c', rf: es(0.15, 2, { antennaEfficiency: 50 }),
    phy: { rateDnBps: 700e3, rateUpBps: 40e3 },
    power: { txW: 15, rxW: 5, idleW: 3, supply: 'dc_12' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 60, massKg: 5, sizeMm: '300×300×350' },
    ports: [p('rf', 'sat_c', 'trx', 'data', 'C 空口'), ...PORT_RJ45(1), PORT_485(), PORT_DC(12)],
    tags: ['卫通', '物联'], src: '[卫通] 终端型谱：C 频段低速固定站（自动跟踪），≤5 kg'
  }),
  B('c.iot.035', 'C 卫星物联网固定站 0.35 m', {
    satMedium: 'sat_c', rf: es(0.35, 4, { antennaEfficiency: 60 }),
    phy: { rateDnBps: 2e6, rateUpBps: 100e3 },
    power: { txW: 25, rxW: 6, idleW: 4, supply: 'dc_24' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 60, massKg: 4, sizeMm: '380×340×50' },
    ports: [p('rf', 'sat_c', 'trx', 'data', 'C 空口'), ...PORT_RJ45(1), PORT_485(), PORT_DC(24)],
    tags: ['卫通', '物联'], src: '[卫通] 终端型谱：前向 ≥2 Mbps（共享）/ 反向 ≥100 kbps'
  }),
  B('ku.iot.03', 'Ku 中速物联网固定站 0.3 m', {
    satMedium: 'sat_ku', rf: es(0.3, 4, { antennaEfficiency: 58 }),
    phy: { rateDnBps: 500e3, rateUpBps: 500e3 },
    power: { alwaysW: 30, supply: 'dc_24' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 60, massKg: 4.5, sizeMm: '317×243×100' },
    ports: [p('rf', 'sat_ku', 'trx', 'data', 'Ku 空口'), ...PORT_RJ45(1), PORT_485(), PORT_DC(24)],
    tags: ['卫通', '物联'], src: '[卫通] 终端型谱：Ku 中速固定站，≥500 kbps 双向'
  }),
  B('ku.iot.045', 'Ku 中速物联网固定站 0.45 m', {
    satMedium: 'sat_ku', rf: es(0.45, 4, { antennaEfficiency: 60 }),
    phy: { rateDnBps: 1e6, rateUpBps: 1e6 },
    power: { alwaysW: 40, supply: 'dc_24' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 60, massKg: 9, sizeMm: '450×350×75' },
    ports: [p('rf', 'sat_ku', 'trx', 'data', 'Ku 空口'), ...PORT_RJ45(1), PORT_485(), PORT_DC(24)],
    tags: ['卫通', '物联'], src: '[卫通] 终端型谱：≥1 Mbps 双向，≤9 kg'
  }),

  // ── 主站 / 信关站 ──
  B('hub.ka.9m', 'Ka 信关站 9 m', {
    group: 'hub', symbol: 'dish-big', rf: es(9.0, 10, { antennaEfficiency: 68, feederLoss: 1.5, rxAntennaEfficiency: 70, rxReceiverNoiseTemp: 60 }),
    phy: { rateDnBps: 1e9, rateUpBps: 1e9 },
    power: { alwaysW: 8000, supply: 'ac_mains' },
    env: { ip: 'IP65', tempMin: -40, tempMax: 55, massKg: 4500 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), p('ifl', 'ifl_l', 'trx', 'if', 'ODU↔IDU'),
      p('wan', 'leased_mstp', 'trx', 'data', '骨干专线'), ...PORT_RJ45(2), PORT_AC()],
    tags: ['卫通', '信关站'], src: '[类型] 高通量信关站典型口径与功率'
  }),
  B('hub.ku.13m', 'Ku/C 主站 13 m', {
    group: 'hub', symbol: 'dish-big', satMedium: 'sat_ku',
    rf: es(13.0, 20, { antennaEfficiency: 68, feederLoss: 2.0, rxAntennaEfficiency: 70, rxReceiverNoiseTemp: 55 }),
    phy: { rateDnBps: 500e6, rateUpBps: 500e6 },
    power: { alwaysW: 12000, supply: 'ac_mains' },
    env: { massKg: 9000 },
    ports: [p('rf', 'sat_ku', 'trx', 'data', 'Ku 空口'), p('ifl', 'ifl_l', 'trx', 'if', 'ODU↔IDU'),
      p('wan', 'leased_mstp', 'trx', 'data', '骨干专线'), ...PORT_RJ45(2), PORT_AC()],
    tags: ['卫通', '信关站'], src: '[类型] VSAT 主站典型口径'
  }),
  B('hub.c.11m', 'C 频段信关站 11 m', {
    group: 'hub', symbol: 'dish-big', satMedium: 'sat_c',
    rf: es(11.0, 20, { antennaEfficiency: 68, feederLoss: 1.8, rxAntennaEfficiency: 70, rxReceiverNoiseTemp: 50 }),
    phy: { rateDnBps: 200e6, rateUpBps: 200e6 },
    power: { alwaysW: 10000, supply: 'ac_mains' },
    env: { massKg: 7000 },
    ports: [p('rf', 'sat_c', 'trx', 'data', 'C 空口'), p('ifl', 'ifl_l', 'trx', 'if', 'ODU↔IDU'),
      p('wan', 'leased_mstp', 'trx', 'data', '骨干专线'), ...PORT_RJ45(2), PORT_AC()],
    tags: ['卫通', '信关站', '物联'],
    src: '[卫通] 窄带卫星物联网地面站网（北京 / 怀来）；C 频段大波束'
  }),
  B('hub.ka.gw', 'Ka 高通量信关站（多波束）', {
    group: 'hub', symbol: 'dish-big',
    rf: es(7.3, 10, { antennaEfficiency: 68, feederLoss: 1.5, rxAntennaEfficiency: 70, rxReceiverNoiseTemp: 60 }),
    phy: { rateDnBps: 2e9, rateUpBps: 2e9 },
    power: { alwaysW: 15000, supply: 'ac_mains' },
    env: { massKg: 3000 },
    ports: [p('rf', 'sat_ka', 'trx', 'data', 'Ka 空口'), p('ifl', 'ifl_l', 'trx', 'if', 'ODU↔IDU'),
      p('wan', 'leased_mstp', 'trx', 'data', '骨干专线'), ...PORT_RJ45(4), PORT_AC()],
    tags: ['卫通', '信关站', '高通量'], src: '[类型] 高通量多波束信关站（Q/V 或 Ka 馈电）'
  }),
  B('hub.tq.gs', '天启卫星地面站', {
    group: 'hub', symbol: 'dish-big', satMedium: 'sat_uhf',
    rf: es(3.0, 5, { antennaEfficiency: 60 }),
    phy: { rateDnBps: 2e6, rateUpBps: 2e6 },
    power: { alwaysW: 3000, supply: 'ac_mains' },
    ports: [p('rf', 'sat_uhf', 'trx', 'data', 'UHF/S 空口'), p('wan', 'leased_mstp', 'trx', 'data', '回传专线'), PORT_AC()],
    tags: ['天启', '信关站'], src: '[天启] 地面段：卫星地面站 + 高速站 + 数据中心 + TQBOSS'
  }),

  // ── 天启终端（UHF 窄带）──
  B('tq.zd08', '天启 TQZD-08 通信终端', {
    group: 'iot-leo', symbol: 'module-box', satMedium: 'sat_uhf', typical: false,
    rf: { antennaDiameter: 0, gainTxDbi: 3.0, gainRxDbi: 3.0, opPowerW: 1.0, antennaEfficiency: 50, paBackoff: 0, feederLoss: 1.0, uplinkPowerControl: '否', upcValue: 0, rxAntennaEfficiency: 50, rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 150, rxReceiverNoiseTemp: 300, rxFeederLoss: 1.0, txDbm: 30, rxSensDbm: -132 },
    phy: { rateDnBps: 1200, rateUpBps: 1200 },
    power: { txW: 9.6, rxW: 0.1, idleW: 0.04, sleepW: 0.036, supply: 'dc_12' },
    env: { ip: 'IP65', tempMin: -20, tempMax: 80, massKg: 0.5, sizeMm: '135×117×35' },
    ports: [p('rf', 'sat_uhf', 'trx', 'data', '天启 UHF'), p('ant', 'coax_rf', 'tx', 'if', '外接天线 SMA'), PORT_485(), PORT_DC(12)],
    tags: ['天启', '物联', '水利', '林草', '能源'],
    src: '[天启] TQZD-08：≥30 dBm，灵敏度 −132 dBm，RS485，6–38 V，IP65，发射≤9.6 W，500 g'
  }),
  B('tq.zd10', '天启 TQZD-10 通信终端', {
    group: 'iot-leo', symbol: 'module-box', satMedium: 'sat_uhf', typical: false,
    rf: { antennaDiameter: 0, gainTxDbi: 0.0, gainRxDbi: 0.0, opPowerW: 1.0, antennaEfficiency: 45, paBackoff: 0, feederLoss: 0.3, uplinkPowerControl: '否', upcValue: 0, rxAntennaEfficiency: 45, rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 150, rxReceiverNoiseTemp: 300, rxFeederLoss: 0.3, txDbm: 30, rxSensDbm: -125 },
    phy: { rateDnBps: 1200, rateUpBps: 1200 },
    power: { txW: 4.8, rxW: 0.2, idleW: 0.04, sleepW: 0.018, supply: 'dc_12' },
    env: { ip: 'IP67', tempMin: -30, tempMax: 80, massKg: 0.2, sizeMm: 'Φ80×21' },
    ports: [p('rf', 'sat_uhf', 'trx', 'data', '天启 UHF（一体天线）'), PORT_485(), PORT_DC(12)],
    tags: ['天启', '物联', '交通', '海洋'],
    src: '[天启] TQZD-10：一体化天线，灵敏度 −125 dBm，IP67，发射≤4.8 W，≤200 g'
  }),
  B('tq.gm', '天启 400-GM 系列通信模组', {
    group: 'iot-leo', symbol: 'module-chip', satMedium: 'sat_uhf', typical: false,
    rf: { antennaDiameter: 0, gainTxDbi: 2.0, gainRxDbi: 2.0, opPowerW: 0.8, antennaEfficiency: 40, feederLoss: 1.0, rxAntennaEfficiency: 40, rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 200, rxReceiverNoiseTemp: 350, rxFeederLoss: 1.0, paBackoff: 0, uplinkPowerControl: '否', upcValue: 0, txDbm: 33, rxSensDbm: -129 },
    phy: { rateDnBps: 1200, rateUpBps: 1200 },
    power: { txW: 5.6, rxW: 0.09, idleW: 0.045, sleepW: 0.00005, supply: 'dc_12' },
    env: { tempMin: -40, tempMax: 85, massKg: 0.005, sizeMm: '30×20×3.5' },
    ports: [p('rf', 'sat_uhf', 'trx', 'data', '天启 UHF'), p('ttl', 'rs232', 'trx', 'data', 'TTL 串口'), PORT_DC(12)],
    tags: ['天启', '物联', '模组'],
    src: '[天启] 400-GM10/12/20：268–1200 bps，30.2–34.5 dBm，灵敏度 −125…−133 dBm，睡眠 7–15 μA'
  }),
  B('tq.alarm', '天启 Alarm 应急求救终端', {
    group: 'iot-leo', symbol: 'sos', satMedium: 'sat_uhf', typical: false,
    rf: { antennaDiameter: 0, gainTxDbi: 0.0, gainRxDbi: 0.0, opPowerW: 1.0, antennaEfficiency: 35, feederLoss: 0.5, rxAntennaEfficiency: 35, rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 200, rxReceiverNoiseTemp: 350, rxFeederLoss: 0.5, paBackoff: 0, uplinkPowerControl: '否', upcValue: 0, txDbm: 30 },
    phy: { rateUpBps: 1200, rateDnBps: 0 },
    power: { txW: 4.0, idleW: 0.4, sleepW: 0.01, supply: 'battery' },
    env: { ip: 'IP67', tempMin: -20, tempMax: 55, massKg: 0.2, sizeMm: '125×50×30' },
    ports: [p('rf', 'sat_uhf', 'tx', 'data', '天启 UHF 上行'), p('ais', 'vhf_data', 'tx', 'data', 'AIS 161.975/162.025 MHz')],
    tags: ['天启', 'ToC', '应急', '海洋'],
    src: '[天启] Alarm-01/02/03：6 V/1400 mAh 一次锂锰，工作 72 h，发射功耗 ≤4 W；-02/-03 带 AIS（>4 海里）'
  }),
  B('tq.wx', '天启气象监测站', {
    group: 'iot-leo', symbol: 'weather', satMedium: 'sat_uhf', typical: false,
    rf: { antennaDiameter: 0, gainTxDbi: 3.0, gainRxDbi: 3.0, opPowerW: 1.0, antennaEfficiency: 50, feederLoss: 1.0, rxAntennaEfficiency: 50, rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 150, rxReceiverNoiseTemp: 300, rxFeederLoss: 1.0, paBackoff: 0, uplinkPowerControl: '否', upcValue: 0, txDbm: 30 },
    phy: { rateUpBps: 1200, rateDnBps: 1200 },
    power: { txW: 9.6, rxW: 0.1, alwaysW: 1.2, sleepW: 0.04, supply: 'solar' },
    env: { ip: 'IP66', tempMin: -40, tempMax: 60 },
    ports: [p('rf', 'sat_uhf', 'trx', 'data', '天启 UHF'), p('cell', 'cellular_4g', 'trx', 'data', '4G 全网通'), PORT_485(), p('pv', 'solar', 'rx', 'power', '太阳能')],
    children: ['sens.weather7', 'pwr.pv100', 'pwr.bat.agm65'],
    tags: ['天启', '气象', '水利', '林草', '应急'],
    src: '[天启] 传感器 + 采集器 + 天启终端 + 4G + 100 W 光伏 / 65 Ah + 3 m 立杆 + 防护箱'
  }),
  B('tq.container', '天启集装箱终端', {
    group: 'iot-leo', symbol: 'container', satMedium: 'sat_uhf', typical: false,
    rf: { antennaDiameter: 0, gainTxDbi: 0.0, gainRxDbi: 0.0, opPowerW: 1.0, antennaEfficiency: 40, feederLoss: 0.5, rxAntennaEfficiency: 40, rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 200, rxReceiverNoiseTemp: 350, rxFeederLoss: 0.5, paBackoff: 0, uplinkPowerControl: '否', upcValue: 0, txDbm: 30 },
    phy: { rateUpBps: 1200, rateDnBps: 1200 },
    power: { txW: 4.8, idleW: 0.05, sleepW: 0.00014, supply: 'dc_24' },
    env: { tempMin: -20, tempMax: 60, massKg: 0.35, sizeMm: '182×80×37' },
    ports: [p('rf', 'sat_uhf', 'trx', 'data', '天启 UHF'), p('cell', 'cellular_4g', 'trx', 'data', '4G 全球通'), p('ble', 'ble', 'trx', 'data', '蓝牙 5.1'), PORT_485(), PORT_DC(24)],
    place: { modes: ['fixed', 'mounted', 'traj'], mountable: true, hostCats: ['C'] },
    tags: ['天启', '交通', '海洋', '冷链'],
    src: '[天启] 集装箱终端：卫星 + 4G 全球通，MQTT，BLE 5.1，AC/DC 24 V，兼容 CARRIER/DAIKIN/THERMOKING/STARCOOL'
  }),
  B('tq.bio', '天启 TQBIO Mini 动物追踪器', {
    group: 'iot-leo', symbol: 'animal', satMedium: 'sat_uhf', typical: false,
    rf: { antennaDiameter: 0, gainTxDbi: -2.0, gainRxDbi: -2.0, opPowerW: 0.5, antennaEfficiency: 30, feederLoss: 0.5, rxAntennaEfficiency: 30, rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 250, rxReceiverNoiseTemp: 400, rxFeederLoss: 0.5, paBackoff: 0, uplinkPowerControl: '否', upcValue: 0 },
    phy: { rateUpBps: 300, rateDnBps: 0 },
    power: { txW: 1.5, sleepW: 0.00002, supply: 'solar' },
    env: { ip: 'IP68', tempMin: -20, tempMax: 60, massKg: 0.006, sizeMm: '20.6×20.6×11.5' },
    ports: [p('rf', 'sat_uhf', 'tx', 'data', '卫星上行'), p('lora', 'lora', 'tx', 'data', 'LoRa'), p('cell', 'cellular_4g', 'trx', 'data', '2G/4G/5G')],
    place: { modes: ['fixed', 'traj'], mountable: false },
    tags: ['天启', '林草', '生态'],
    src: '[天启] TQBIO MINI：5–6 g，砷化镓光伏，300 mAh，蜂窝/LoRa/卫星多传输'
  })
];

module.exports = { SAT_PRESETS_SCENE, STATIONS, p, PORT_RJ45, PORT_DC, PORT_AC, PORT_485, es, B };
