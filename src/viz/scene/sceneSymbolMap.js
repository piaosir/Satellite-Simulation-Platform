// 应用场景仿真 · 模块 → 符号的映射（单一真值源）。
//
// ============ 为什么要有这张表 ============
// 一期的符号是手写几何（矩形 + 圆 + 折线），160 个模块共用 72 个符号 —— 光 `sensor` 一个
// 就被 7 类量纲完全不同的传感器共用（测温、舞动、渗压、GNSS 位移、裂缝、光纤 DAS、空气质量）。
// 图上七种设备长同一个样，等于这一层信息没画。二期改成成品矢量素材，同时把映射摊开成
// 【逐条】的：每个内置模块在这里各占一行，图标按【它测什么 / 它是什么】选，不再落到一个通用件上。
//
// ============ 素材来源与许可 ============
//   tabler:        Tabler Icons，MIT，6100+，24 网格 2px 描边
//   tabler-filled: 同上的实心套（同名同形）
//   lucide:        Lucide，ISC，平台 UI 图标（components/Icon.vue）已在用，风格同族
// 两个包只在 devDependencies：安装包里不带一个 SVG 字节，运行时只带构建生成的
// sceneSymbolData.js（见 scripts/build-scene-symbols.mjs）。
// ★ 刻意不用：Cisco 图标（仅许可画图、不许可进产品）、draw.io 第三方库（CC BY + 附加条款）、
//   Font Awesome（CC BY 需署名，且风格与 Tabler 不合）。
//
// ============ 形状 ============
//   SYMBOL_MAP[libId] = { icon: '<来源>:<名>', badge?: '<来源>:<名>' }
// badge 画在主图标右下角，只给【复合模块】与【同主图标但需要分辨的一族】用：
//   复合（智慧杆 / 机巢 / 叫应杆 / 气象站 / 风光互补）—— 主图标说它是什么，徽标说它还带什么；
//   一族（车载 / 船载 / 机载 / 机载无人 动中通终端）—— 主图标是同一面天线，徽标说它装在什么上。
// 徽标不是装饰：加一个就多一次视觉负担，能不加就不加。

// 老符号 id → 新图标。用户自建模块（usr: 前缀）存的 symbol 是一期那 72 个手绘 id，
// 手绘符号已整份删除，没有这张表它们会退化成兜底件。内置模块不走这条路（走 SYMBOL_MAP）。
export const LEGACY_ALIAS = {
  'satellite-geo': 'tabler:satellite', 'satellite-leo': 'lucide:satellite',
  dish: 'lucide:satellite-dish', 'dish-big': 'lucide:satellite-dish', 'dish-small': 'lucide:satellite-dish',
  flatpanel: 'tabler:device-tablet', phasedarray: 'tabler:grid-dots',
  'antenna-omni': 'lucide:antenna', 'antenna-whip': 'lucide:antenna', 'antenna-yagi': 'tabler:antenna',
  'antenna-panel': 'tabler:rss', 'antenna-helix': 'tabler:spiral', amp: 'tabler:player-play',
  'module-box': 'tabler:box', 'module-chip': 'tabler:cpu', 'edge-box': 'tabler:brain',
  switch: 'lucide:network', router: 'tabler:router', shield: 'tabler:firewall-flame',
  converter: 'tabler:arrows-exchange', gateway: 'tabler:topology-star-2', server: 'tabler:server-2',
  datacenter: 'tabler:database', command: 'tabler:presentation', cloud: 'tabler:cloud',
  basestation: 'lucide:radio-tower', wifi: 'tabler:wifi', mesh: 'tabler:topology-complex',
  manet: 'tabler:topology-full', radio: 'tabler:radio', video: 'tabler:video',
  speaker: 'tabler:speakerphone', pole: 'tabler:tower', tower: 'tabler:tower', mast: 'tabler:tower',
  cabinet: 'tabler:circuit-switch-closed', nvr: 'tabler:server-2',
  'drone-multi': 'tabler:drone', 'drone-fixed': 'tabler:plane', 'drone-vtol': 'tabler:plane-tilt',
  'drone-heli': 'tabler:helicopter', evtol: 'tabler:drone', dronenest: 'tabler:building-warehouse',
  'drone-tether': 'tabler:drone', balloon: 'tabler:air-balloon',
  'robot-dog': 'tabler:dog', 'robot-wheel': 'tabler:robot', 'robot-rail': 'tabler:trolley',
  'vehicle-car': 'tabler:car', 'vehicle-truck': 'tabler:truck', 'vehicle-ship': 'tabler:ship',
  usv: 'tabler:ship', excavator: 'tabler:backhoe', person: 'tabler:walk',
  sensor: 'tabler:ruler-measure', meter: 'tabler:gauge', camera: 'tabler:camera',
  weather: 'tabler:sun-wind', water: 'tabler:ripple', radar: 'tabler:radar-2',
  slope: 'tabler:mountain', bridge: 'tabler:building-bridge', ais: 'tabler:ship', buoy: 'tabler:lifebuoy',
  plant: 'tabler:plant-2', animal: 'tabler:paw', wellhead: 'tabler:barrel',
  windturbine: 'tabler:windmill', container: 'tabler:container', sos: 'tabler:sos',
  solar: 'tabler:solar-panel', battery: 'tabler:battery-3', genset: 'tabler:engine',
  ups: 'tabler:battery-charging', plug: 'tabler:plug'
}

// 认不出的模块落这里。★ 刻意选一个「没有含义」的件：让漏映射在图上一眼可见，
// 而不是伪装成某种设备（一期的 `sensor` 兜底就是这么把七类传感器糊成一件的）。
export const FALLBACK_ICON = 'tabler:square-dot'

const S = (icon, badge) => (badge ? { icon, badge } : { icon })

export const SYMBOL_MAP = {
  // ═══ A 空间段 ═══
  // GEO 用 Tabler 的 satellite（碟 + 帆板，静止星的通行画法）；NGSO 用 Lucide 的 satellite
  // （箱体 + 两翼帆板）—— 两档在 16px 下轮廓就分得开，读图不必先看副标。
  'sat.cs15': S('tabler:satellite'), 'sat.ap7': S('tabler:satellite'),
  'sat.cs12': S('tabler:satellite'), 'sat.cs27': S('tabler:satellite'),
  'sat.cs9c': S('tabler:satellite'), 'sat.cs11': S('tabler:satellite'),
  'sat.cs9b': S('tabler:satellite'), 'sat.cs16': S('tabler:satellite'),
  'sat.cs10r': S('tabler:satellite'), 'sat.cs6e': S('tabler:satellite'),
  'sat.cs6d': S('tabler:satellite'), 'sat.cs26': S('tabler:satellite'),
  'sat.cs6c': S('tabler:satellite'), 'sat.ap6c': S('tabler:satellite'),
  'sat.ap6e': S('tabler:satellite'), 'sat.ap6d': S('tabler:satellite'),
  'sat.ap5c': S('tabler:satellite'), 'sat.ap9': S('tabler:satellite'),
  'sat.cs19': S('tabler:satellite'),
  'sat.tq1': S('lucide:satellite'), 'sat.tq1sso': S('lucide:satellite'),
  'sat.tq2': S('lucide:satellite', 'tabler:transfer'),          // 二期带星间链路
  'sat.generic.geo': S('tabler:satellite'),
  'sat.generic.leo': S('lucide:satellite'),
  'sat.generic.regen': S('lucide:satellite', 'tabler:cpu'),     // 再生＝星上有处理

  // ═══ B 地面固定站 ═══
  // 碟形站与平板站分两个主图标：口径 0.3 m 以上基本是抛物面，0.15~0.35 的物联/便携是平板。
  'es.ka.fixed.098': S('lucide:satellite-dish'),
  'es.ka.fixed.12': S('lucide:satellite-dish', 'tabler:crosshair'),      // 自动对星
  'es.ka.unattended.045': S('lucide:satellite-dish', 'tabler:solar-panel'), // 无人值守＝光伏供电
  'es.ka.flat.035': S('tabler:device-tablet'),
  'es.ka.port.045': S('lucide:satellite-dish'),
  'es.ka.port.06': S('lucide:satellite-dish'),
  'es.ka.manpack.018': S('tabler:backpack'),
  'es.c.iot.015': S('tabler:device-tablet'),
  'es.c.iot.015.track': S('tabler:device-tablet', 'tabler:crosshair'),
  'es.c.iot.035': S('lucide:satellite-dish'),
  'es.ku.iot.03': S('lucide:satellite-dish'),
  'es.ku.iot.045': S('lucide:satellite-dish'),
  // 信关站 / 主站与终端是同一种物理设备（大口径抛物面），差别在它是一座【站】：徽标担这个。
  'es.hub.ka.9m': S('lucide:satellite-dish', 'tabler:building'),
  'es.hub.ku.13m': S('lucide:satellite-dish', 'tabler:building'),
  'es.hub.c.11m': S('lucide:satellite-dish', 'tabler:building'),
  'es.hub.ka.gw': S('lucide:satellite-dish', 'tabler:building'),
  'es.hub.tq.gs': S('lucide:satellite-dish', 'tabler:building'),
  'es.tq.zd08': S('tabler:broadcast'),
  'es.tq.zd10': S('tabler:access-point'),
  'es.tq.gm': S('tabler:cpu'),
  'es.tq.alarm': S('tabler:sos'),
  'es.tq.wx': S('tabler:sun-wind', 'lucide:satellite'),          // 复合：气象传感 + 卫星终端
  'es.tq.container': S('tabler:container'),
  'es.tq.bio': S('tabler:paw'),

  // ═══ C 移动平台 ═══
  // 动中通【终端】画的是那面天线（载体是另一个模块），徽标说它装在什么上。
  'mob.ka.veh.045': S('tabler:device-tablet', 'tabler:car'),
  'mob.ka.veh.03': S('tabler:device-tablet', 'tabler:car'),
  'mob.ka.ship.105': S('lucide:satellite-dish', 'tabler:ship'),
  'mob.ka.aero': S('tabler:device-tablet', 'tabler:plane'),
  'mob.ka.uav.pa045': S('tabler:grid-dots', 'tabler:drone'),     // 相控阵＝阵元点阵
  'mob.ka.uav.par035': S('lucide:satellite-dish', 'tabler:drone'),
  'mob.ka.uav.par02': S('lucide:satellite-dish', 'tabler:drone'),
  'mob.ka.uav.pa02': S('tabler:grid-dots', 'tabler:drone'),
  'mob.ka.uav.pa01': S('tabler:grid-dots', 'tabler:drone'),
  'veh.uav.multi': S('tabler:drone'),
  'veh.uav.vtol': S('tabler:plane-tilt'),
  'veh.uav.fixed': S('tabler:plane'),
  'veh.uav.heli': S('tabler:helicopter'),
  'veh.evtol': S('tabler:drone', 'tabler:user'),                 // 载人
  'veh.dronenest': S('tabler:building-warehouse', 'tabler:drone'),
  'veh.tether.uav': S('tabler:drone', 'tabler:plug'),            // 系留＝地面供电
  'veh.balloon': S('tabler:air-balloon'),
  'veh.robotdog': S('tabler:dog'),
  'veh.robotwheel': S('tabler:robot'),
  'veh.robotrail': S('tabler:trolley'),
  'veh.usv': S('tabler:ship', 'tabler:robot'),
  'veh.ship': S('tabler:ship'),
  'veh.car': S('tabler:car'),
  'veh.cmdcar': S('tabler:truck', 'tabler:urgent'),
  'veh.excavator': S('tabler:backhoe'),
  'veh.person': S('tabler:walk'),

  // ═══ D 感知末端 ═══
  // ★ 这一段是本次改动的重点：图标按【量纲】选，一期那个七类共用的 `sensor` 整个消失。
  'sens.meter.concentrator': S('tabler:hierarchy'),              // 多表汇聚成一路
  'sens.meter.single': S('tabler:gauge'),
  'sens.pole.tilt': S('tabler:angle'),                           // 倾斜＝角
  'sens.line.temp': S('tabler:thermometer'),                     // 温度
  'sens.line.cam': S('tabler:camera'),
  'sens.line.galloping': S('tabler:wave-sine'),                  // 舞动＝低频摆动
  'sens.dtu': S('tabler:circuit-switch-closed'),                 // 配电开关柜内装置
  'sens.wind.turbine': S('tabler:windmill'),
  'sens.oil.rtu': S('tabler:barrel'),
  'sens.pipe.das': S('tabler:pipeline'),                         // 沿管道的分布式光纤
  'sens.water.level': S('tabler:ripple'),                        // 水位＝液面
  'sens.water.rain': S('tabler:cloud-rain'),
  'sens.water.flow': S('lucide:waves'),                          // 流量＝流动
  'sens.water.quality': S('tabler:test-pipe'),                   // 水质＝取样分析
  'sens.dam.seepage': S('tabler:ruler-measure'),                 // 渗压/位移＝测量
  'sens.emg.pole': S('tabler:tower', 'tabler:speakerphone'),     // 复合：杆 + 喇叭 + 摄像
  'sens.emg.broadcast': S('tabler:speakerphone'),
  'sens.geo.gnss': S('tabler:gps'),
  'sens.geo.crack': S('tabler:ruler-2'),                         // 裂缝/倾角/泥位＝刻度量
  'sens.slope.radar': S('tabler:radar-2'),
  'sens.emg.sos': S('tabler:urgent'),
  'sens.forest.fire': S('tabler:flame'),
  'sens.forest.cam': S('tabler:device-cctv', 'tabler:flame'),    // 双光＝可见光 + 热成像找火点
  'sens.weather7': S('tabler:sun-wind'),
  'sens.soil': S('tabler:plant-2'),
  'sens.air.micro': S('tabler:wind'),
  'sens.road.slope': S('tabler:mountain'),
  'sens.bridge.health': S('tabler:building-bridge'),
  'sens.ais.classa': S('tabler:ship', 'tabler:broadcast'),       // 船位广播
  'sens.buoy': S('tabler:lifebuoy'),
  'sens.cam.ptz': S('tabler:device-cctv'),

  // ═══ E 汇聚与边缘 ═══
  'edge.lorawan.gw': S('tabler:topology-star-2'),                // 星形汇聚
  'edge.dtu': S('tabler:transfer'),                              // 串口 ⇄ 无线的数传
  'edge.rtu': S('tabler:box'),
  'edge.aibox': S('tabler:brain'),
  'edge.sw.poe8': S('lucide:network', 'tabler:plug'),            // PoE＝交换机顺带供电
  'edge.sw.ind': S('lucide:network'),
  'edge.router': S('tabler:router'),
  'edge.fw': S('tabler:firewall-flame'),
  'edge.media': S('tabler:arrows-exchange'),                     // 光 ⇄ 电 转换
  'net.smartpole': S('tabler:tower', 'lucide:satellite-dish'),   // 复合：杆 + 卫星回传
  'net.5gcpe': S('tabler:signal-5g'),
  'net.4gbs': S('tabler:signal-4g'),
  'net.wifi.ap': S('tabler:wifi'),
  'net.wifi.mesh': S('tabler:topology-complex'),
  'net.manet': S('tabler:topology-full'),
  'net.uhf.radio': S('tabler:radio'),
  'net.vhf.radio': S('tabler:radio', 'tabler:anchor'),           // 海事甚高频
  'net.video.tx': S('tabler:video'),
  'net.video.rx': S('tabler:device-desktop'),
  'net.airbs': S('lucide:radio-tower', 'tabler:drone'),          // 空中基站
  'net.pdt': S('lucide:radio-tower'),
  'net.nvr': S('tabler:server-2'),

  // ═══ F 射频器件 ═══
  // 天线按方向图分族：全向（鞭 / 共线 / 全向板）一族、定向（八木）一族、
  // 面天线（板状 / 栅格 / 抛物面）一族、螺旋与贴片各自一件。这正是这一层要读的信息。
  'ant.whip.vhf': S('lucide:antenna'),
  'ant.whip.uhf': S('lucide:antenna'),
  'ant.colinear.uhf': S('lucide:antenna'),
  'ant.yagi.uhf': S('tabler:antenna'),
  'ant.yagi.vhf': S('tabler:antenna'),
  'ant.omni.24': S('lucide:antenna'),
  'ant.omni.58': S('lucide:antenna'),
  'ant.panel.58': S('tabler:rss'),                               // 定向扇形辐射
  'ant.grid.58': S('lucide:satellite-dish', 'tabler:grid-dots'), // 栅格反射面
  'ant.dish.mw': S('lucide:satellite-dish'),
  'ant.helix.uhf': S('tabler:spiral'),
  'ant.patch.gnss': S('tabler:current-location'),
  'rf.lna': S('tabler:player-play'),                             // 三角＝放大器（电路图通行画法）
  'rf.buc': S('tabler:player-track-next'),                       // 双三角＝上变频 + 功放

  // ═══ G 供电 ═══
  'pwr.mains': S('tabler:plug'),
  'pwr.pv100': S('tabler:solar-panel'),
  'pwr.pv200': S('tabler:solar-panel'),
  'pwr.pv500': S('tabler:solar-panel'),
  // 电池的格数跟容量走：一次电池 1 格、65 Ah 2 格、100 Ah 3 格、200 Ah 4 格
  'pwr.bat.agm65': S('tabler:battery-2'),
  'pwr.bat.lfp100': S('tabler:battery-3'),
  'pwr.bat.lfp200': S('tabler:battery-4'),
  'pwr.bat.primary': S('tabler:battery-1'),
  'pwr.genset': S('tabler:engine'),
  'pwr.ups': S('tabler:battery-charging'),
  'pwr.windpv': S('tabler:solar-panel-2', 'tabler:windmill'),    // 复合：光 + 风

  // ═══ H 中心与平台 ═══
  'ctr.dc': S('tabler:database'),
  'ctr.cmd': S('tabler:presentation'),
  'ctr.platform': S('tabler:cloud'),
  'ctr.tqboss': S('tabler:cloud-data-connection'),
  'ctr.nms': S('tabler:sitemap'),
  'ctr.coreif': S('tabler:affiliate'),
  'ctr.video.platform': S('tabler:movie')
}

/** 构建脚本要抽取的图标全集（主图标 ∪ 徽标 ∪ 老符号别名 ∪ 兜底件） */
export const SYMBOL_ICONS = (() => {
  const s = new Set([FALLBACK_ICON])
  for (const v of Object.values(SYMBOL_MAP)) { s.add(v.icon); if (v.badge) s.add(v.badge) }
  for (const v of Object.values(LEGACY_ALIAS)) s.add(v)
  return s
})()

/**
 * 模块 → { icon, badge }。取值优先级：
 *   ① 条目上显式给的新式图标名（'来源:名'）—— 库编辑器里换过符号的走这条，内置条目也算数：
 *      「改写层只存差异」的口径下，换图标和换口径一样是一条差异，本表不该压过用户的改动。
 *      ★ 用户换了主图标就【不再带徽标】—— 他挑的是另一件东西，原来的徽标说的已经不是它了。
 *   ② 本表的逐条映射（内置模块的出厂图标）
 *   ③ 老手绘符号 id 的别名（一期存下来的自建条目）
 *   ④ 兜底件
 * @param {string|object} m 模块（内置条目 / effective 结果）或直接给 libId / 图标名
 * @param {string} [fallbackSymbol] 条目上的 symbol 字段（不传则从 m 上取）
 */
export function symbolSpec(m, fallbackSymbol) {
  const obj = m && typeof m === 'object'
  const id = obj ? (m.libId || m.id) : m
  const sym = fallbackSymbol != null ? fallbackSymbol : (obj ? m.symbol : null)
  if (typeof sym === 'string' && sym.indexOf(':') > 0) return { icon: sym }
  // 直接把图标名当 key 传进来的（拓扑图例、库编辑器的符号预览）
  if (!obj && typeof id === 'string' && id.indexOf(':') > 0) return { icon: id }
  const hit = SYMBOL_MAP[id]
  if (hit) return hit
  if (typeof sym === 'string' && LEGACY_ALIAS[sym]) return { icon: LEGACY_ALIAS[sym] }
  if (typeof id === 'string' && LEGACY_ALIAS[id]) return { icon: LEGACY_ALIAS[id] }
  return { icon: FALLBACK_ICON }
}

export default SYMBOL_MAP
