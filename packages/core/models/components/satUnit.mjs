// 卫星领域装配组件 · 有效载荷与星上设备（2026-10-08 补全）：光学相机、仪器箱、激光角反射器、推进剂贮箱、磁强计、对接与分离机构、
// 电推力器指向臂、遮阳板。
//
// 造型件在 ../antennas.mjs；局部坐标同 sat.mjs（原点 = 安装基准点、局部 −Z 贴父面、局部 +X = 滚转零位、几何朝 +Z 长）。
// 质量：光学相机 opticsAreal × 入瞳面积、角反射器 lraAreal × 托板面积、贮箱 tankAreal × 壳面积 + 推进剂（充填率 × 容积 × 密度）、
// 磁强计 magMass、仪器箱 0.8 × 平台体等效体密度 × 箱体积、对接与分离机构按铝 / 钛结构量级、电推力器指向臂 epJointMass × 关节数 +
// boomLinear × 臂长 + epMass × 推力器台数、遮阳板 visorAreal × 板面积——都是示意值（推进剂密度为物性常数）。
// 缺省参数为示意值，不取具体型号尺寸。
//
// 导出：SAT_UNIT_COMPONENTS（sat.camera / sat.instrument / sat.lra / sat.tank / sat.sensor.mag / sat.dock / sat.ep.arm / sat.visor）

import { isNum, comp, pointComp, plateComp, rodComp, IDR, z0, dot, sub, cross, madd } from '../meshKit.mjs'
import { addHw } from '../paramBus.mjs'
import { num, int, bool, enm, sock, apLocal, stage } from './shapeKit.mjs'
import { telescope, retroArray, propTank, magnetometerHead, instrumentBox, dockMechanism, epArmDims, epArmRoot, epArmSegment, epThrusterHead, visorPanels } from '../antennas.mjs'
import { obox } from '../fleet/kit.mjs'

const SAT = ['spacecraft']
const ROOT = (size, roll = 15) => sock('root', [0, 0, 0], [0, 0, -1], [1, 0, 0], size, roll)
/** 实心圆柱（轴 z、半径 r、长 h、质心 c）的质量元 */
const cylMass = (ctx, name, m, c, r, h) => { const it = m * (3 * r * r + h * h) / 12; comp(ctx, name, 'cylinder', m, c, [it, 0, 0, 0, it, 0, 0, 0, m * r * r / 2]) }

// ───────────────────────────── 光学相机 ─────────────────────────────

const CAM_FIN = Object.freeze({ mli_black: '黑色 MLI', mli_gold: '金色 MLI', mli_silver: '银色 MLI', white_paint: '白漆', black_paint: '黑色阳极化' })
const camLen = (p) => (isNum(p.lengthM) ? p.lengthM : p.type === 'box' ? 2.2 * p.apertureM : 3.6 * p.apertureM)

const camera = {
  type: 'sat.camera', domain: SAT, title: 'Optical camera', titleZh: '光学相机', role: 'sensor', category: 'payload',
  aliases: ['相机', '望远镜', '遥感', '光学载荷', '成像', 'camera', 'telescope', '载荷'],
  presets: [
    { id: 'box', titleZh: '箱式相机', title: 'Box camera', aliases: ['小卫星相机', '微纳'], params: { type: 'box', apertureM: 0.1 } }
  ],
  params: {
    type: enm('tube', ['tube', 'box'], '型式', { optionLabels: { tube: '筒式（同轴卡塞格伦）', box: '箱式' }, title: '筒式：焦面箱 + 镜筒 + 斜切遮光罩（对地遥感主载荷）；箱式：电子箱 + 镜头（小卫星相机）' }),
    apertureM: num(0.3, 'm', '通光口径', { gt: 0, title: '入瞳直径：亚米级对地遥感 0.5–1.1 m、小卫星相机 0.05–0.35 m' }),
    lengthM: num(null, 'm', '总长', { nullable: true, gt: 0, title: '安装面到遮光罩口的长度；留空：筒式 3.6 × 口径、箱式 2.2 × 口径' }),
    cutDeg: num(30, '°', '遮光罩斜切角', { min: 0, max: 60, title: '遮光罩端面的斜切角（挡太阳与地气杂光，高边朝局部 +X）；0 = 平口' }),
    finish: enm('mli_black', ['mli_black', 'mli_gold', 'mli_silver', 'white_paint', 'black_paint'], '外表面', { optionLabels: CAM_FIN }),
    secondary: bool(true, '次镜与支撑', { title: '筒内可见的次镜与三翼片支撑' }),
    seg: int(40, '分段', { min: 16, max: 96 })
  },
  validate: (p) => (camLen(p) > 1.2 * p.apertureM ? [] : ['总长过短（须大于 1.2 × 口径）']),
  sockets: (p) => [ROOT(Math.max(0.05, 1.2 * p.apertureM))],
  // 斜切高边在 +X、次镜翼片在 0° / 120° / 240°：关于 xz 面对称；箱式两面都对称
  symmetricPlanes: (p) => (p.type === 'box' ? ['yz', 'xz'] : ['xz']),
  build(p, kit) {
    const ctx = kit.createCtx()
    const D = p.apertureM, L = camLen(p)
    const part = { id: 'camera', name: '光学相机', role: 'sensor' }
    let r = null
    addHw(ctx, 'camera', part, 'sensor', p.finish, (put) => { r = telescope(put, { type: p.type, D, L, cutDeg: p.cutDeg, finish: p.finish, secondary: p.secondary, seg: p.seg }) })
    cylMass(ctx, 'camera', ctx.dens.opticsAreal * Math.PI * D * D / 4, [0, 0, 0.42 * L], 0.6 * D, L)
    ctx.parts.get('camera').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', r.aperture, [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 激光角反射器 ─────────────────────────────

const lraPitch = (p) => (isNum(p.pitchM) ? p.pitchM : 1.25 * p.cubeDM)
const lra = {
  type: 'sat.lra', domain: SAT, title: 'Laser retroreflector array', titleZh: '激光角反射器', role: 'sensor', category: 'payload',
  aliases: ['角反射器', '角锥棱镜', 'LRA', 'SLR', '激光测距', '反射器'],
  presets: [
    { id: 'grid', titleZh: '行列交错角反射器', title: 'Staggered retroreflector array', aliases: ['交错'], params: { layout: 'grid' } },
    { id: 'ring', titleZh: '环形角反射器', title: 'Ring retroreflector array', aliases: ['环形', '格洛纳斯'], params: { layout: 'ring' } }
  ],
  params: {
    layout: enm('hex', ['hex', 'grid', 'ring'], '排布', { optionLabels: { hex: '六边形密排', grid: '行列交错', ring: '环形' }, title: '环形：一圈棱镜环绕导航天线（格洛纳斯）' }),
    rings: int(2, '环数', { min: 0, max: 8, title: '六边形密排环数：棱镜数 = 3r(r+1)+1' }),
    cols: int(6, '列数', { min: 1, max: 24 }),
    rows: int(8, '行数', { min: 1, max: 24 }),
    ringN: int(36, '环形棱镜数', { min: 3, max: 200 }),
    ringRM: num(null, 'm', '环形中径', { nullable: true, gt: 0, title: '棱镜所在圆的半径；留空 = 按间距排满一圈' }),
    cubeDM: num(0.033, 'm', '棱镜口径', { gt: 0, title: '角锥棱镜通光口径（导航星 LRA 约 27–38 mm）' }),
    pitchM: num(null, 'm', '棱镜间距', { nullable: true, gt: 0, title: '留空 = 1.25 × 棱镜口径' }),
    mat: enm('aluminum', ['aluminum', 'gold_metal', 'black_paint'], '托板外表面', { optionLabels: { aluminum: '本色铝', gold_metal: '镀金', black_paint: '黑色阳极化' } })
  },
  sockets: (p) => { const n = p.layout === 'grid' ? Math.max(p.cols, p.rows) : p.layout === 'ring' ? 2 : 2 * p.rings + 1; return [ROOT(Math.max(0.04, n * lraPitch(p)))] },
  // 环形：棱镜 0°、360°/n…均布，n 为偶数时两面对称、奇数只关于 xz
  symmetricPlanes: (p) => (p.layout === 'grid' ? [] : p.layout === 'ring' ? (p.ringN % 2 === 0 ? ['yz', 'xz'] : ['xz']) : ['yz', 'xz']),
  build(p, kit) {
    const ctx = kit.createCtx()
    const d = p.cubeDM, pitch = lraPitch(p)
    const part = { id: 'lra', name: '激光角反射器', role: 'sensor' }
    let r = null
    addHw(ctx, 'lra', part, 'sensor', p.mat, (put) => { r = retroArray(put, { layout: p.layout, rings: p.rings, nx: p.cols, ny: p.rows, ringN: p.ringN, ringR: p.ringRM, d, pitch, plateT: Math.max(0.004, 0.25 * d), h: 0.3 * d, mat: p.mat }) })
    const w = Math.sqrt(r.plateArea)
    plateComp(ctx, 'lra', ctx.dens.lraAreal * r.plateArea, [0, 0, 0.5 * r.top], IDR, w, w)
    ctx.parts.get('lra').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', [0, 0, r.top], [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 推进剂贮箱 ─────────────────────────────

/** 推进剂密度（kg/m³，物性常数）：无水肼 1004（25 °C）、MON-3 1440、甲基肼 875、超临界氙约 1600（约 15 MPa 贮存） */
export const PROPELLANT_DENSITY = Object.freeze({ n2h4: 1004, mon: 1440, mmh: 875, xe: 1600, none: 0 })
const tankLen = (p) => (p.shape === 'capsule' ? Math.max(p.diameterM, isNum(p.lengthM) ? p.lengthM : 1.8 * p.diameterM) : p.diameterM)
/** 贮箱几何量：容积、壳面积 */
function tankGeom(p) {
  const R = p.diameterM / 2, Lc = p.shape === 'capsule' ? tankLen(p) - p.diameterM : 0
  return { R, Lc, V: (4 / 3) * Math.PI * R ** 3 + Math.PI * R * R * Lc, A: 4 * Math.PI * R * R + 2 * Math.PI * R * Lc }
}

const tank = {
  type: 'sat.tank', domain: SAT, title: 'Propellant tank', titleZh: '推进剂贮箱', role: 'other', category: 'propulsion',
  aliases: ['贮箱', '储箱', '燃料箱', '气瓶', '氙气瓶', '推进剂', 'tank'],
  presets: [
    { id: 'capsule', titleZh: '柱形贮箱', title: 'Cylindrical propellant tank', aliases: ['柱形', '胶囊'], params: { shape: 'capsule', diameterM: 1.1 } },
    { id: 'xenon', titleZh: '氙气瓶', title: 'Xenon tank', aliases: ['氙', '电推进', '复合材料气瓶', 'COPV'], params: { shape: 'capsule', diameterM: 0.6, propellant: 'xe', finish: 'carbon' } }
  ],
  params: {
    shape: enm('sphere', ['sphere', 'capsule'], '外形', { optionLabels: { sphere: '球形', capsule: '柱段 + 半球封头' } }),
    diameterM: num(0.6, 'm', '直径', { gt: 0, title: '外径（GEO 平台双组元贮箱 0.9–1.2 m、小卫星肼贮箱 0.2–0.5 m）' }),
    lengthM: num(null, 'm', '总长', { nullable: true, gt: 0, title: '柱段 + 半球封头的总长；留空 = 1.8 × 直径（球形不用）' }),
    propellant: enm('n2h4', ['n2h4', 'mon', 'mmh', 'xe', 'none'], '推进剂', { optionLabels: { n2h4: '无水肼', mon: '四氧化二氮（MON-3）', mmh: '甲基肼', xe: '氙（超临界）', none: '空箱' }, title: '密度：无水肼 1004、MON-3 1440、甲基肼 875、超临界氙约 1600 kg/m³' }),
    fill: num(0.8, '', '充填率', { min: 0, max: 1, title: '推进剂体积 / 贮箱容积（寿命初期 0.8–0.95，寿命末期接近 0）' }),
    finish: enm('titanium', ['titanium', 'carbon', 'mli_gold', 'aluminum', 'white_paint'], '外表面', { optionLabels: { titanium: '钛合金', carbon: '碳纤维缠绕', mli_gold: '金色 MLI', aluminum: '本色铝', white_paint: '白漆' } }),
    seg: int(48, '分段', { min: 16, max: 96 })
  },
  sockets: (p) => [ROOT(p.shape === 'capsule' ? 0.96 * p.diameterM : 0.62 * p.diameterM)],
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const g = tankGeom(p)
    const part = { id: 'tank', name: '推进剂贮箱', role: 'other' }
    let r = null
    addHw(ctx, 'tank', part, 'other', p.finish, (put) => { r = propTank(put, { shape: p.shape, D: p.diameterM, L: tankLen(p), finish: p.finish, seg: p.seg }) })
    const c = r.center, R = g.R
    // 壳体：薄壁（球壳 2/3·mR²；柱段按薄壁圆筒近似并进同一元）；推进剂：按满箱实体（球 2/5·mR²、柱 mR²/2）× 充填率——冻结液体近似
    const ms = ctx.dens.tankAreal * g.A
    const Lt = tankLen(p)
    if (p.shape === 'capsule') {
      const ia = ms * R * R, it = ms * (R * R / 2 + Lt * Lt / 12)
      comp(ctx, 'tank_shell', 'shell', ms, c, [it, 0, 0, 0, it, 0, 0, 0, ia])
    } else {
      const i = (2 / 3) * ms * R * R
      comp(ctx, 'tank_shell', 'shell', ms, c, [i, 0, 0, 0, i, 0, 0, 0, i])
    }
    const mp = (PROPELLANT_DENSITY[p.propellant] || 0) * g.V * p.fill
    if (mp > 0) {
      if (p.shape === 'capsule') cylMass(ctx, 'tank_propellant', mp, c, R, Lt - 0.4 * p.diameterM)
      else { const i = 0.4 * mp * R * R; comp(ctx, 'tank_propellant', 'solid', mp, c, [i, 0, 0, 0, i, 0, 0, 0, i]) }
    }
    return ctx
  }
}

// ───────────────────────────── 磁强计 ─────────────────────────────

const magnetometer = {
  type: 'sat.sensor.mag', domain: SAT, title: 'Magnetometer', titleZh: '磁强计', role: 'sensor', category: 'aocs',
  aliases: ['磁强计', '磁通门', '磁场', 'magnetometer'],
  presets: [
    { id: 'cube', titleZh: '方形磁强计', title: 'Cube magnetometer', aliases: ['方形'], params: { type: 'cube' } }
  ],
  params: {
    type: enm('cyl', ['cyl', 'cube'], '探头', { optionLabels: { cyl: '圆柱形', cube: '方形' }, title: '三轴磁通门探头（多装在伸展臂端部，远离星体剩磁）' }),
    scale: num(1, '', '尺寸比例', { gt: 0, title: '缺省 1 = Ø0.04 × 0.095 m 圆柱探头 / 0.05 m 方形探头' }),
    finish: enm('white_paint', ['white_paint', 'black_paint', 'mli_gold', 'aluminum'], '外表面', { optionLabels: { white_paint: '白漆', black_paint: '黑色阳极化', mli_gold: '金色 MLI', aluminum: '本色铝' } })
  },
  sockets: (p) => [ROOT(0.064 * p.scale)],
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'sensor', name: '磁强计', role: 'sensor' }
    let r = null
    addHw(ctx, 'sensor', part, 'sensor', p.finish, (put) => { r = magnetometerHead(put, { type: p.type, scale: p.scale, finish: p.finish }) })
    pointComp(ctx, 'sensor', ctx.dens.magMass * p.scale ** 3, [0, 0, 0.5 * r.top])
    ctx.parts.get('sensor').normalBody = [0, 0, 1]
    return ctx
  }
}

// ───────────────────────────── 仪器箱 ─────────────────────────────

/** 盒（底面中心在原点、高 Z）的五个可安装面（底面是安装面）：侧面 u = +Z、顶面 u = +X（sat.mjs FACE_FRAMES 同一约定） */
function boxFacesUp(X, Y, Z) {
  const F = (id, origin, n, u, halfU, halfV) => { const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]; return { id, kind: 'plane', origin, n, u, v, halfU, halfV } }
  return [
    F('+X', [X / 2, 0, Z / 2], [1, 0, 0], [0, 0, 1], Z / 2, Y / 2), F('-X', [-X / 2, 0, Z / 2], [-1, 0, 0], [0, 0, 1], Z / 2, Y / 2),
    F('+Y', [0, Y / 2, Z / 2], [0, 1, 0], [0, 0, 1], Z / 2, X / 2), F('-Y', [0, -Y / 2, Z / 2], [0, -1, 0], [0, 0, 1], Z / 2, X / 2),
    F('+Z', [0, 0, Z], [0, 0, 1], [1, 0, 0], X / 2, Y / 2)
  ]
}
const instWin = (p) => {
  const side = p.window === 'side'
  const a = side ? Math.min(p.yM, p.zM) : Math.min(p.xM, p.yM)
  const w = isNum(p.windowWM) ? p.windowWM : 0.45 * a
  return { w, h: isNum(p.windowHM) ? p.windowHM : 0.7 * w }
}

const instrument = {
  type: 'sat.instrument', domain: SAT, title: 'Instrument box', titleZh: '仪器箱', role: 'sensor', category: 'payload',
  aliases: ['仪器', '成像仪', '探测仪', '光谱仪', '载荷舱', '辐射制冷', '气象载荷', 'instrument'],
  presets: [
    { id: 'side', titleZh: '侧窗仪器箱', title: 'Side-window instrument', aliases: ['扫描', '成像仪'], params: { window: 'side', cooler: '-y', finish: 'white_paint' } }
  ],
  params: {
    xM: num(0.8, 'm', '长', { gt: 0 }), yM: num(0.6, 'm', '宽', { gt: 0 }), zM: num(0.5, 'm', '高', { gt: 0 }),
    window: enm('top', ['top', 'side'], '观测窗', { optionLabels: { top: '顶面（+Z）', side: '侧面（+X）' }, title: '对地观测窗开在顶面（装在对地板上）或侧面（扫描镜朝外）' }),
    windowWM: num(null, 'm', '窗宽', { nullable: true, gt: 0, title: '留空 = 0.45 × 所在面短边' }),
    windowHM: num(null, 'm', '窗高', { nullable: true, gt: 0, title: '留空 = 0.7 × 窗宽' }),
    shadeM: num(0.12, 'm', '遮光檐长', { min: 0, title: '观测窗四周外张 15° 的遮光檐；0 = 无' }),
    cooler: enm('+y', ['none', '+y', '-y'], '辐射制冷器', { optionLabels: { none: '无', '+y': '+Y 面', '-y': '−Y 面' }, title: '红外探测器的被动辐射制冷板（OSR），多开在背阳的北面' }),
    finish: enm('mli_silver', ['mli_silver', 'mli_gold', 'mli_black', 'white_paint'], '外表面', { optionLabels: { mli_silver: '银色 MLI', mli_gold: '金色 MLI', mli_black: '黑色 MLI', white_paint: '白漆' } })
  },
  validate: (p) => { const w = instWin(p), side = p.window === 'side'; return w.w < (side ? p.yM : p.xM) && w.h < (side ? p.zM : p.yM) ? [] : ['观测窗大于所在面'] },
  sockets: (p) => [ROOT(Math.min(p.xM, p.yM), 90), ...boxFacesUp(p.xM, p.yM, p.zM).map((f) => sock(f.id, f.origin, f.n, f.u, 2 * Math.min(f.halfU, f.halfV)))],
  faces: (p) => boxFacesUp(p.xM, p.yM, p.zM),
  // 顶面观测窗居中、侧面观测窗在 +X；辐冷板在 ±Y 面打破 xz 对称
  symmetricPlanes: (p) => (p.cooler === 'none' ? (p.window === 'side' ? ['xz'] : ['yz', 'xz']) : (p.window === 'side' ? [] : ['yz'])),
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'instrument', name: '仪器箱', role: 'sensor' }
    const w = instWin(p)
    let r = null
    addHw(ctx, 'instrument', part, 'sensor', p.finish, (put) => { r = instrumentBox(put, { X: p.xM, Y: p.yM, Z: p.zM, win: p.window, ww: w.w, wh: w.h, shade: p.shadeM, cooler: p.cooler, finish: p.finish }) })
    // 质量：箱体按平台体等效体密度 × 0.8（光机结构比星体疏）
    const m = 0.8 * ctx.dens.busVolume * p.xM * p.yM * p.zM, hx = p.xM / 2, hy = p.yM / 2, hz = p.zM / 2
    comp(ctx, 'instrument', 'box', m, [0, 0, hz], [m * (4 * hy * hy + 4 * hz * hz) / 12, 0, 0, 0, m * (4 * hx * hx + 4 * hz * hz) / 12, 0, 0, 0, m * (4 * hx * hx + 4 * hy * hy) / 12])
    ctx.parts.get('instrument').normalBody = r.dir.slice()
    apLocal(ctx, 'boresight', r.aperture, r.dir)
    return ctx
  }
}

// ───────────────────────────── 对接与分离机构 ─────────────────────────────

const DOCK_SIZE = Object.freeze({ lvring: [1.194, 0.1], probe: [0.9, 1.1], grapple: [0.1, 0.04] })
const dockDims = (p) => { const d = DOCK_SIZE[p.type] || DOCK_SIZE.lvring; return { D: isNum(p.sizeM) ? p.sizeM : d[0], L: isNum(p.lengthM) ? p.lengthM : d[1] } }
const dock = {
  type: 'sat.dock', domain: SAT, title: 'Docking / separation interface', titleZh: '对接与分离机构', role: 'other', category: 'structure',
  aliases: ['对接环', '星箭对接', '分离环', '包带', '探杆', '对接机构', '抓捕', '靶标', '在轨服务', 'docking', 'adapter'],
  presets: [
    { id: 'probe', titleZh: '探杆式对接机构', title: 'Probe docking mechanism', aliases: ['MEV', '在轨服务'], params: { type: 'probe' } },
    { id: 'grapple', titleZh: '抓捕靶标', title: 'Grapple fixture', aliases: ['DogTag', '离轨'], params: { type: 'grapple' } }
  ],
  params: {
    type: enm('lvring', ['lvring', 'probe', 'grapple'], '型式', { optionLabels: { lvring: '星箭对接环', probe: '探杆式对接机构', grapple: '抓捕靶标' }, title: '星箭对接环：包带式分离接口（937 / 1194 / 1666 mm 档）；探杆式对接机构：在轨服务飞行器插入目标星发动机喷管的探杆；抓捕靶标：在轨服务 / 离轨捕获用的识别与抓捕接口' }),
    sizeM: num(null, 'm', '直径', { nullable: true, gt: 0, title: '对接环直径 / 探杆机构底座直径 / 靶标边长；留空：1.194 / 0.9 / 0.1 m' }),
    lengthM: num(null, 'm', '高', { nullable: true, gt: 0, title: '对接环高 / 探杆长 / 靶标厚；留空：0.1 / 1.1 / 0.04 m' })
  },
  sockets: (p) => { const d = dockDims(p); return [ROOT(p.type === 'grapple' ? d.D : 0.6 * d.D)] },
  symmetricPlanes: (p) => (p.type === 'grapple' ? [] : p.type === 'probe' ? ['yz'] : ['yz', 'xz']),
  build(p, kit) {
    const ctx = kit.createCtx()
    const d = dockDims(p)
    const part = { id: 'dock', name: '对接与分离机构', role: 'other' }
    let r = null
    addHw(ctx, 'dock', part, 'other', p.type === 'grapple' ? 'black_paint' : 'aluminum', (put) => { r = dockMechanism(put, { type: p.type, D: d.D, L: d.L }) })
    pointComp(ctx, 'dock', r.massKg, [0, 0, 0.45 * r.tip[2]])
    if (p.type !== 'lvring') apLocal(ctx, 'tip', r.tip, [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 电推力器指向臂 ─────────────────────────────
//
// 节点与关节（「烘焙构型 + 增量关节」，同 satAntenna.mjs 的指向机构口径：编辑态 / 缩略图看到的就是设定构型，stage 值是相对它的增量）：
//   base 根部支座（静止）；seg1 / seg2 / head 三组节点共用节点系 N（原点 = 根部铰链轴心、y = 铰链轴 = 局部 Y、z = 第一节臂向），
//   几何按设定构型画在 N 里。无臂型 head 的节点系原点 = 转动中心、轴同局部系。
//   deploy  [yRotate 根部]                                   → seg1
//   elbow   [yRotate 根部, +L1, yRotate 肘部, −L1]            → seg2
//   pointing[根部…走到转动中心（定值平移 / 肘部定值转角）, 定值 ZYZ 转到指向系, xRotate 第一轴, yRotate 第二轴, 定值原路撤回] → head
//   静止位姿下全部定值级成对抵消（Π stage = I）；转动中心、各铰链轴都是真实的运动学位置，导出给 STK 照样能驱动展开 / 指向。
// 对称：臂在局部 xz 面内、推力器沿第一转轴（喷流方位 0° / 180° 时即局部 Y）并排，喷流方位 ≡ 0（mod 180°）时关于 xz 面对称。

const EP_FIN = Object.freeze({ mli_gold: '金色 MLI', mli_silver: '银色 MLI', white_paint: '白漆', carbon: '碳纤维', titanium: '钛合金' })
const DEG = Math.PI / 180
const LOCAL_F = Object.freeze({ o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] })
/** 一组造型件按材质分桶登记，再整体放进节点系 (R, t)（几何已按节点系坐标画） */
function addHwAt(ctx, name, part, role, mainMat, R, t, build) {
  const r = addHw(ctx, name, part, role, mainMat, build)
  for (const it of r.items) { it.R = R; it.t = t.slice() }
  return r
}
/** 局部向量 → 节点系坐标（R 的三列为节点系三轴） */
const toNodeV = (R, v) => [dot(R[0], v), dot(R[1], v), dot(R[2], v)].map(z0)
/** 局部系里的 kit 系 → 节点系 (R, t) 坐标里的同一个系 */
const inNode = (R, t, F) => ({ o: toNodeV(R, sub(F.o, t)), x: toNodeV(R, F.x), y: toNodeV(R, F.y), z: toNodeV(R, F.z) })
/** 指向（方位 φ、偏角 θ：自局部 +Z 向 φ 方向倾 θ）→ 单位向量 */
const pointDir = (phiDeg, thDeg) => { const p = phiDeg * DEG, t = thDeg * DEG; return [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)].map(z0) }
/** 行主序 3×3 Q → ZYZ 欧拉角（度）：Q = Rz(α)·Ry(β)·Rz(γ)；β = 0 / 180° 时 γ 取 0 */
function zyz(Q) {
  const b = Math.acos(Math.max(-1, Math.min(1, Q[2][2])))
  if (Math.sin(b) > 1e-9) return [Math.atan2(Q[1][2], Q[0][2]), b, Math.atan2(Q[2][1], -Q[2][0])].map((x) => z0(x / DEG))
  if (Q[2][2] > 0) return [z0(Math.atan2(Q[1][0], Q[0][0]) / DEG), 0, 0]
  return [z0(Math.atan2(-Q[1][0], -Q[0][0]) / DEG), 180, 0]
}
/** 指向臂的几何关键点（组件局部系）：segs 节数、R0 根部铰链轴心、d1 / d2 两节臂向、T 转动中心、N 节点系、j 肘部转角（度）、A 指向系 */
function epArmGeo(p) {
  const g = epArmDims(p.armDM, p.thrusterDM, p.thrusters)
  const segs = p.arm === 'two' ? 2 : p.arm === 'one' ? 1 : 0
  const r1 = p.rootDeg * DEG, r2 = (segs === 2 ? p.elbowDeg : p.rootDeg) * DEG
  const d1 = [Math.cos(r1), 0, Math.sin(r1)].map(z0), d2 = [Math.cos(r2), 0, Math.sin(r2)].map(z0)
  const R0 = [0, 0, g.h0], L1 = p.seg1M, L2 = segs === 2 ? p.seg2M : 0
  const T = segs === 0 ? [0, 0, g.hp] : madd(madd(R0, d1, L1), d2, L2).map(z0)
  const RN = segs === 0 ? IDR : [[Math.sin(r1), 0, -Math.cos(r1)].map(z0), [0, 1, 0], d1]
  const tN = segs === 0 ? T : R0
  const b = pointDir(p.azDeg, p.tiltDeg), ax = [-Math.sin(p.azDeg * DEG), Math.cos(p.azDeg * DEG), 0].map(z0)
  const A = { o: T, x: ax, y: cross(b, ax).map(z0), z: b }
  return { g, segs, R0, d1, d2, L1, L2, T, RN, tN, j: segs === 2 ? p.rootDeg - p.elbowDeg : 0, A }
}

const epArm = {
  type: 'sat.ep.arm', domain: SAT, title: 'Electric propulsion pointing arm', titleZh: '电推力器指向臂', role: 'thruster', category: 'propulsion',
  aliases: ['电推', '电推进', '全电推', '霍尔', '指向机构', '展开臂', '推力器臂', '电推臂', 'EPPM', 'SPT', 'PPS', 'XIPS', 'Hall', 'EP arm', 'thruster arm'],
  presets: [
    { id: 'one', titleZh: '单节电推臂', title: 'Single-segment EP arm', aliases: ['MEV', '单节'], params: { arm: 'one', seg1M: 1.0, rootDeg: 35, thrusters: 1, tiltDeg: 20 } },
    { id: 'gimbal', titleZh: '电推力器指向机构', title: 'EP thruster pointing mechanism', aliases: ['702SP', 'SSL', '无臂'], params: { arm: 'none', tiltDeg: 0 } }
  ],
  params: {
    arm: enm('two', ['two', 'one', 'none'], '臂型', { optionLabels: { two: '两节展开臂', one: '单节展开臂', none: '无臂' }, title: '两节展开臂：根部铰链 + 肘部铰链 + 末端两轴指向机构（欧洲星 E3000e / Neo、空间客车 Neo 全电推平台）；单节展开臂：根部铰链 + 末端指向机构（在轨延寿飞行器 MEV）；无臂：两轴指向机构直接装在面上（波音 702SP、SSL 1300）' }),
    seg1M: num(1.1, 'm', '第一节长', { gt: 0, title: '根部铰链轴到肘部铰链轴（单节臂为到末端指向机构转动中心）' }),
    seg2M: num(1.0, 'm', '第二节长', { gt: 0, title: '肘部铰链轴到末端指向机构转动中心' }),
    rootDeg: num(55, '°', '第一节仰角', { min: 0, max: 180, title: '第一节与安装面的夹角：0 = 收拢贴面（沿局部 +X）、90 = 垂直安装面' }),
    elbowDeg: num(30, '°', '第二节仰角', { min: -90, max: 180, title: '第二节与安装面的夹角（与第一节同一口径，不是肘部相对转角）' }),
    armDM: num(0.08, 'm', '臂杆直径', { gt: 0 }),
    finish: enm('mli_gold', ['mli_gold', 'mli_silver', 'white_paint', 'carbon', 'titanium'], '臂杆外表面', { optionLabels: EP_FIN }),
    thrusters: int(2, '推力器台数', { options: [1, 2] }),
    thrusterDM: num(0.14, 'm', '放电通道直径', { gt: 0, title: '霍尔推力器放电通道外径：SPT-100 约 0.1 m、SPT-140 / PPS-5000 约 0.14 m' }),
    azDeg: num(0, '°', '喷流方位', { min: -180, max: 180, title: '喷流方向在安装面内的方位角：自局部 +X 起、绕安装面法向逆时针' }),
    tiltDeg: num(30, '°', '喷流偏角', { min: 0, max: 90, title: '喷流方向偏离安装面法向的角度（推力沿喷流反方向，由指向机构对准整星质心）' }),
    articulate: bool(true, '转动关节', { title: 'AGI 关节（STK 可驱动）：根部展开、肘部、末端两轴指向；零位 = 设定构型，stage 值为相对设定构型的转角' }),
    seg: int(24, '分段', { min: 8, max: 64 })
  },
  sockets: (p) => [ROOT(Math.max(0.08, 3.2 * epArmDims(p.armDM, p.thrusterDM, p.thrusters).rj))],
  symmetricPlanes: (p) => (Math.abs(Math.sin(p.azDeg * DEG)) < 1e-12 ? ['xz'] : []),
  build(p, kit) {
    const ctx = kit.createCtx()
    const q = epArmGeo(p), g = q.g, n = p.thrusters, mat = p.finish
    const part = { id: 'arm', name: '电推力器指向臂', role: 'thruster' }
    addHw(ctx, 'base', part, 'thruster', mat, (put) => epArmRoot(put, { g, mat, pedestal: q.segs === 0, seg: p.seg }))
    const r = p.armDM / 2
    let s1 = null, s2 = null
    if (q.segs >= 1) s1 = addHwAt(ctx, 'seg1', part, 'thruster', mat, q.RN, q.tN, (put) => epArmSegment(put, LOCAL_F, { L: q.L1, r, g, mat, end: q.segs === 2 ? 'elbow' : 'wrist', seg: p.seg }))
    if (q.segs === 2) {
      const jr = q.j * DEG
      const F2 = { o: [0, 0, q.L1], x: [Math.cos(jr), 0, -Math.sin(jr)].map(z0), y: [0, 1, 0], z: [Math.sin(jr), 0, Math.cos(jr)].map(z0) }
      s2 = addHwAt(ctx, 'seg2', part, 'thruster', mat, q.RN, q.tN, (put) => epArmSegment(put, F2, { L: q.L2, r, g, mat, end: 'wrist', seg: p.seg }))
    }
    const AN = inNode(q.RN, q.tN, q.A)
    let hd = null
    const head = addHwAt(ctx, 'head', part, 'thruster', mat, q.RN, q.tN, (put) => { hd = epThrusterHead(put, AN, { g, n, Dch: p.thrusterDM, podMat: mat, seg: p.seg }) })
    if (p.articulate !== false) {
      const T = (nm, v) => stage(nm, 'zTranslate', v, v, v), FZ = (nm, v) => stage(nm, 'zRotate', v, v, v), FY = (nm, v) => stage(nm, 'yRotate', v, v, v)
      const pre = [], back = []
      if (q.segs >= 1) {
        const dep = stage('deploy', 'yRotate', p.rootDeg - 180, p.rootDeg, 0)
        ctx.arts.push({ name: 'deploy', nodes: s1.items.map((it) => it.name), stages: [dep] })
        pre.push(dep, T('toSeg1End', q.L1)); back.unshift(T('fromSeg1End', -q.L1))
        if (q.segs === 2) {
          const elb = stage('elbow', 'yRotate', -170 - q.j, 170 - q.j, 0)
          ctx.arts.push({ name: 'elbow', nodes: s2.items.map((it) => it.name), stages: [dep, T('toElbow', q.L1), elb, T('fromElbow', -q.L1)] })
          pre.push(elb, FY('elbowSet', q.j), T('toSeg2End', q.L2)); back.unshift(T('fromSeg2End', -q.L2), FY('elbowUnset', -q.j))
        }
      }
      // 转动中心处的系 S（节点系坐标；两节臂 = 绕 y 转肘部角）→ 指向系 A：Q[i][k] = S_i · A_k
      const jr = q.j * DEG
      const S = q.segs === 2 ? [[Math.cos(jr), 0, -Math.sin(jr)], [0, 1, 0], [Math.sin(jr), 0, Math.cos(jr)]] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
      const Q = S.map((si) => [AN.x, AN.y, AN.z].map((ak) => dot(si, ak)))
      const [al, be, ga] = zyz(Q)
      ctx.arts.push({ name: 'pointing', nodes: head.items.map((it) => it.name), stages: [...pre, FZ('alignA', al), FY('alignB', be), FZ('alignC', ga), stage('pointX', 'xRotate', -30, 30, 0), stage('pointY', 'yRotate', -30, 30, 0), FZ('unalignC', -ga), FY('unalignB', -be), FZ('unalignA', -al), ...back] })
    }
    // 质量：各转动关节 epJointMass（根部 / 肘部各一、指向机构两轴）+ 臂杆 boomLinear + 推力器 epMass × 台数
    if (q.segs >= 1) { pointComp(ctx, 'arm_root', ctx.dens.epJointMass, q.R0); rodComp(ctx, 'arm_seg1', q.R0, madd(q.R0, q.d1, q.L1)) }
    if (q.segs === 2) { pointComp(ctx, 'arm_elbow', ctx.dens.epJointMass, madd(q.R0, q.d1, q.L1)); rodComp(ctx, 'arm_seg2', madd(q.R0, q.d1, q.L1), q.T) }
    pointComp(ctx, 'arm_gimbal', 2 * ctx.dens.epJointMass, q.T)
    pointComp(ctx, 'arm_thrusters', n * ctx.dens.epMass, madd(q.T, q.A.z, g.zp + g.pod.t + 0.5 * g.Lb))
    ctx.parts.get('arm').normalBody = q.A.z.slice()
    return ctx
  }
}

// ───────────────────────────── 遮阳板 ─────────────────────────────
//
// 铰接平板：铰链轴 = 局部 Y（离安装面 hingeHM）、板面自铰链向局部 +X 收拢（展开角 0）→ 立起（90°）→ 向 −X 平伸（180°）。
// 星链 VisorSat：沿本体长边铰接的两块黑色泡沫板，入轨后展开斜挡在相控阵下方，挡住照到对地面的阳光、降低地面所见亮度；
// 热控遮光板（辐冷器 / 光学窗口旁）多为膜式，张在钛管框上。关节：板组绕铰链轴转（零位 = 设定展开角）。

const VISOR_FIN = Object.freeze({ kapton_black: '黑色泡沫板', black_paint: '消光黑漆', mli_black: '黑色 MLI', mli_silver: '银色 MLI', mli_gold: '金色 MLI', white_paint: '白漆', sunshield: '锗膜' })

const visor = {
  type: 'sat.visor', domain: SAT, title: 'Sunshade / visor', titleZh: '遮阳板', role: 'other', category: 'thermal',
  aliases: ['遮光板', '遮阳', '挡光板', '降亮度', '展开遮阳板', 'VisorSat', 'visor', 'sunshade', 'baffle'],
  presets: [
    { id: 'film', titleZh: '膜式遮光板', title: 'Film sunshade', aliases: ['遮光板', '热控', '辐冷器'], params: { panels: 1, widthM: 0.8, depthM: 0.6, thicknessM: 0.004, deployDeg: 90, finish: 'mli_silver', frame: true } }
  ],
  params: {
    widthM: num(2.7, 'm', '总宽', { gt: 0, title: '沿铰链轴（局部 Y）的总宽（分块时含块间缝）' }),
    depthM: num(0.9, 'm', '展开长', { gt: 0, title: '铰链轴到板外缘的距离' }),
    panels: int(2, '分块数', { min: 1, max: 8, title: '沿铰链轴分块（星链 VisorSat 两块）' }),
    gapM: num(0.04, 'm', '块间缝', { min: 0 }),
    thicknessM: num(0.02, 'm', '板厚', { gt: 0, title: '泡沫芯板 15–25 mm；膜式遮光板 2–5 mm，配边框' }),
    deployDeg: num(70, '°', '展开角', { min: 0, max: 180, title: '板面与安装面的夹角：0 = 收拢贴在安装面上（向局部 +X 折）、90 = 垂直安装面、180 = 向局部 −X 平伸' }),
    hingeHM: num(0.03, 'm', '铰链高', { min: 0, title: '铰链轴离安装面的高度' }),
    finish: enm('kapton_black', ['kapton_black', 'black_paint', 'mli_black', 'mli_silver', 'mli_gold', 'white_paint', 'sunshield'], '外表面', { optionLabels: VISOR_FIN, title: '星链 VisorSat 为黑色泡沫板；热控遮光板多为银色 / 金色 MLI 或锗膜' }),
    frame: bool(false, '边框', { title: '板四周的钛细管边框（膜式遮光板张在框上）' }),
    articulate: bool(true, '展开铰链', { title: 'AGI 关节：板组绕铰链轴（局部 Y）转动，零位 = 设定展开角；stage 正值朝收拢方向' })
  },
  validate: (p) => (p.panels > 1 && (p.panels - 1) * p.gapM >= p.widthM ? ['块间缝总和超过总宽'] : []),
  sockets: (p) => [ROOT(Math.min(p.widthM, 0.6), 90)],
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'visor', name: '遮阳板', role: 'other' }
    const d = p.deployDeg * DEG, c = Math.cos(d), s = Math.sin(d)
    // 铰链系（节点系）：原点 = 铰链轴中点、x = 展开方向、y = 铰链轴、z = 板面法向
    const RN = [[c, 0, s].map(z0), [0, 1, 0], [-s, 0, c].map(z0)], tN = [0, 0, p.hingeHM]
    let r = null
    const pan = addHwAt(ctx, 'panel', part, 'other', p.finish, RN, tN, (put) => {
      r = visorPanels(put, LOCAL_F, { W: p.widthM, Ld: p.depthM, n: p.panels, gap: p.gapM, t: p.thicknessM, mat: p.finish, frame: p.frame })
    })
    // 铰链座（静止）：每个铰链节下一枚钛座，托住铰链轴
    addHw(ctx, 'hinge', part, 'other', 'titanium', (put) => {
      const hz = p.hingeHM + r.rp
      for (const y of r.knuckles) obox(put('titanium'), LOCAL_F, [0, y, hz / 2], [1.3 * r.rp + 0.004, 0.012, hz / 2], ['+x', '-x', '+y', '-y', '+z'])
    })
    if (p.articulate !== false) ctx.arts.push({ name: 'hinge', nodes: pan.items.map((it) => it.name), stages: [stage('deploy', 'yRotate', p.deployDeg - 180, p.deployDeg, 0)] })
    // 质量：板面 visorAreal（边框加 25 %），薄板质量元在板面中心
    const x0 = 1.8 * r.rp, xc = (x0 + p.depthM) / 2
    plateComp(ctx, 'visor', ctx.dens.visorAreal * r.area * (p.frame ? 1.25 : 1), [tN[0] + RN[0][0] * xc, 0, tN[2] + RN[0][2] * xc].map(z0), RN, p.depthM - x0, p.widthM)
    const pp = ctx.parts.get('visor')
    pp.areaM2 = r.area; pp.normalBody = RN[2].slice()
    return ctx
  }
}

export const SAT_UNIT_COMPONENTS = Object.freeze([camera, instrument, lra, tank, magnetometer, dock, epArm, visor])
