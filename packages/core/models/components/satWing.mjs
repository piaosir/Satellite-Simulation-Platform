// 卫星领域装配组件 · 太阳翼（2026-10-08「太阳翼种类补全」）：铰接式太阳板（星链单翼 / 立方星展开板）、柔性太阳翼（伸展杆 + 两张折叠帆，
// 国际空间站 / 天宫）、卷展式太阳翼（ROSA）、圆形太阳翼（UltraFlex）。刚性板式翼仍是 sat.mjs 的 sat.wing（与整星 paramBus 同式）。
// 造型件在 ../solarArrays.mjs；这里只管参数 / 接口 / 节点系 / 关节 / 质量 / 太阳翼组。
//
// ★ 局部系与刚性翼一致：原点 = 翼根（安装点，局部 −Z 贴父面）、翼展 = 局部 +Z、翼宽 = 局部 Y、电池面朝局部 −X（绕翼轴转角 0°）。
//   翼根驱动机构（SADA 护套，hardware.sadaBoot）不随翼转；其余放进翼节点系 N（x = −Y、y = +Z 翼展、z = −X 电池面法向，
//   再绕 y 转「绕翼轴转角」），关节 wing [yRotate rotate]、pointingVector = +z——3D 页 / STK 单轴对日，与刚性翼同一口径。
//   铰接式太阳板的转轴是根部铰链（局部 Y）：节点系 = 铰链系（同 sat.visor：x = 板面方向、z = 电池面法向），展开角烘焙进几何，
//   关节 wing [yRotate rotate]（星链单翼正是绕铰链对日；立方星展开板关掉关节即固定）。
// ★ 镜像：几何关于局部 xz 面（翼宽方向）逐点对称（造型库保证），唯一手性参数是绕翼轴转角 → 镜像钩子取反（同刚性翼）；铰接式没有这个参数，
//   直接声明 xz 对称面。
// ★ 质量（paramBus.DENSITY 示意值，装配件「密度」节可改）：柔性帆 flexAreal × 帆面积、伸展杆 / 卷展杆 / 连接架 boomLinear × 长度、
//   收纳箱 / 卷筒 / 毂按 towerAreal × 表面积估；铰接板 (panelAreal + cellAreal) × 板面积。SADA 不计（同刚性翼：sadaMassKg 才计）。
//
// 导出：SAT_WING_COMPONENTS（sat.wing.hinged / sat.wing.flex / sat.wing.rosa / sat.wing.circular）

import { z0, rotAboutLocalY, rApply, plateComp, pointComp, rodComp, comp, len, sub, nrm, add, scl } from '../meshKit.mjs'
import { addHw, SOLAR_EFFICIENCY_DEFAULT } from '../paramBus.mjs'
import { DETAIL_PRESETS } from '../paramTemplates.mjs'
import { sadaBoot } from '../hardware.mjs'
import { obox, cyl } from '../fleet/kit.mjs'
import { num, int, bool, enm, sock, apLocal } from './shapeKit.mjs'
import { CELL_MATS, solarYoke, flexBlanketWing, rosaWing, circularWing, hingedPanels } from '../solarArrays.mjs'

const SAT = ['spacecraft']
const G = DETAIL_PRESETS.geo
const DEG = Math.PI / 180
const LOCAL_F = Object.freeze({ o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] })
const ROOT = (size, roll = 90) => sock('root', [0, 0, 0], [0, 0, -1], [1, 0, 0], size, roll)
/** 翼节点系（列 = x / y / z）：x = −Y、y = +Z 翼展、z = −X 电池面法向；再绕 y 转绕翼轴转角 */
const WING_R0 = Object.freeze([Object.freeze([0, -1, 0]), Object.freeze([0, 0, 1]), Object.freeze([-1, 0, 0])])
const wingR = (tiltDeg) => rotAboutLocalY(WING_R0, tiltDeg).map((c) => c.map(z0))

// ───────────────────────────── 共用参数 ─────────────────────────────

const CELL = enm('gaas', ['gaas', 'si'], '电池片', { optionLabels: { gaas: '三结砷化镓', si: '硅' }, title: '三结砷化镓：深蓝近黑（现役主流）；硅：亮蓝、带白色汇流条（东三平台、北斗二号、早期卫星）' })
const TILT = num(0, '°', '绕翼轴转角', { min: -180, max: 180, title: '0° 电池面朝安装面滚转零位的反方向' })
const EFF = num(SOLAR_EFFICIENCY_DEFAULT, '%', '电池片效率', { min: 0, max: 100, title: '电池片光电转换效率（AGI 太阳翼组 efficiency，百分数）' })
const ART = bool(true, '转动关节', { title: 'AGI 关节：绕翼展轴单轴对日（零位 = 设定转角，pointingVector = 电池面法向）' })
const SADA_P = {
  sadaLenM: num(G.sadaLenM, 'm', 'SADA 长', { min: 0, title: '翼根驱动机构（SADA）外露段长；0 = 无（翼根直接铰在面上）' }),
  sadaDM: num(G.sadaDM, 'm', 'SADA 直径', { min: 0 })
}
const YOKE_STYLE = enm('v', ['v', 'trap', 'rod'], '连接架形式', { optionLabels: { v: 'V 形', trap: '梯形', rod: '单杆' } })
/** 镜像钩子：关于局部 xz 面镜像 = 绕翼轴转角取反（几何其余部分关于该面对称） */
const mirrorTilt = (p, plane) => (plane === 'xz' ? { ...p, tiltDeg: p.tiltDeg === 0 ? 0 : -p.tiltDeg } : null)

/** 驱动机构护套（静止，组件局部系；sadaLenM = 0 不画） */
function addSada(ctx, p) {
  if (!(p.sadaLenM > 0)) return
  addHw(ctx, 'wing_sada', { id: 'wing_sada', name: '太阳翼驱动机构', role: 'bus' }, 'bus', 'aluminum', (put) => sadaBoot(put, { root: [0, 0, 0], dir: [0, 0, 1], up: [0, 1, 0], kz: p.sadaLenM / 0.25, kr: (p.sadaDM > 0 ? p.sadaDM : G.sadaDM) / 0.26 }))
}
/** 随翼转的造型件：在翼节点系里画（R, t 写进节点），返回节点名与电池节点名 */
function addWingHw(ctx, R, t, part, mainMat, build) {
  const r = addHw(ctx, 'wing', part, 'solarArray', mainMat, build)
  for (const it of r.items) { it.R = R; it.t = t.slice() }
  const cellKeys = new Set(Object.values(CELL_MATS))
  return { ret: r.ret, nodes: r.items.map((it) => it.name), cellNodes: r.items.filter((it) => cellKeys.has(it.mat)).map((it) => it.name) }
}
/** 关节 / 太阳翼组 / 部件面积 / 翼轴挂点（各翼共用的收尾） */
function finishWing(ctx, p, R, w, cellArea, stage) {
  if (p.articulate !== false) ctx.arts.push({ name: 'wing', nodes: w.nodes, stages: [stage || { name: 'rotate', type: 'yRotate', minimumValue: -180, maximumValue: 180, initialValue: 0 }], pointingVector: [0, 0, 1] })
  ctx.spg.push({ name: 'wing', nodes: w.cellNodes, efficiency: p.efficiency })
  const pp = ctx.parts.get('wing')
  pp.areaM2 = cellArea; pp.normalBody = R[2].slice()
}
/** 翼节点系里的点 → 组件局部系 */
const inL = (R, t, q) => rApply(R, q).map((v, i) => z0(v + t[i]))
/** 细杆质量元（线密度 kgPerM，绕杆轴细杆惯量）：端点在组件局部系 */
function rodMass(ctx, name, p0, p1, kgPerM) {
  const L = len(sub(p1, p0))
  if (!(L > 0)) return
  const m = kgPerM * L, d = nrm(sub(p1, p0)), k = m * L * L / 12
  comp(ctx, name, 'rod', m, scl(add(p0, p1), 0.5), [k * (1 - d[0] * d[0]), -k * d[0] * d[1], -k * d[0] * d[2], -k * d[1] * d[0], k * (1 - d[1] * d[1]), -k * d[1] * d[2], -k * d[2] * d[0], -k * d[2] * d[1], k * (1 - d[2] * d[2])])
}
/** 连接架杆质量（线密度 boomLinear）：端点在翼节点系 */
function yokeMass(ctx, R, segs) { segs.forEach(([a, b], i) => rodComp(ctx, `wing_yoke_${i + 1}`, inL(R, [0, 0, 0], a), inL(R, [0, 0, 0], b))) }

// ───────────────────────────── 铰接式太阳板 ─────────────────────────────

const BACK_FIN = Object.freeze({ solar_substrate: '基板本色', white_paint: '白漆', carbon: '碳纤维' })

const hingedWing = {
  type: 'sat.wing.hinged', domain: SAT, title: 'Hinged solar panel', titleZh: '铰接式太阳板', role: 'solarArray', category: 'power',
  aliases: ['太阳板', '展开帆板', '铰接', '星链', 'Starlink', '立方星', 'CubeSat', '鲨鱼鳍', '展书', 'solar panel', 'deployable panel'],
  presets: [
    { id: 'starlink', titleZh: '星链式单翼', title: 'Starlink-style single wing', aliases: ['星链', '鲨鱼鳍', '展书'], params: { lengthM: 8.1, widthM: 2.8, rows: 14, cols: 2, deployDeg: 90, thicknessM: 0.02, gapM: 0.012, back: 'white_paint' } },
    { id: 'cubesat', titleZh: '立方星展开太阳板', title: 'CubeSat deployable solar panel', aliases: ['立方星', 'CubeSat', '3U'], params: { lengthM: 0.3, widthM: 0.1, rows: 1, cols: 1, thicknessM: 0.002, deployDeg: 90, hingeHM: 0.004, articulate: false } },
    { id: 'double', titleZh: '双联展开太阳板', title: 'Double deployable solar panel', aliases: ['双联', '立方星', '小卫星'], params: { lengthM: 0.65, widthM: 0.3, rows: 2, cols: 1, thicknessM: 0.004, gapM: 0.005, deployDeg: 90, hingeHM: 0.006, articulate: false } }
  ],
  params: {
    lengthM: num(1.2, 'm', '展开长', { gt: 0, title: '铰链轴到板外缘（各折叠段之和）' }),
    widthM: num(0.6, 'm', '宽', { gt: 0, title: '沿铰链轴（局部 Y）的宽度' }),
    rows: int(2, '折叠段数', { min: 1, max: 30, title: '沿展开方向的折叠段数（星链单翼约 14 段）' }),
    cols: int(1, '列数', { min: 1, max: 4, title: '沿铰链方向的分列数' }),
    gapM: num(0.01, 'm', '段间缝', { min: 0 }),
    thicknessM: num(0.02, 'm', '板厚', { gt: 0, title: '铝蜂窝基板 15–25 mm；立方星电路板式太阳板 1.6–3 mm' }),
    deployDeg: num(90, '°', '展开角', { min: 0, max: 180, title: '板面与安装面的夹角：0 = 收拢贴在安装面上（向局部 +X 折，电池朝外）、90 = 垂直安装面、180 = 向局部 −X 平伸' }),
    hingeHM: num(0.02, 'm', '铰链高', { min: 0, title: '铰链轴离安装面的高度' }),
    cellType: CELL,
    bothFaces: bool(false, '双面电池', { title: '板背面也贴电池片' }),
    back: enm('solar_substrate', ['solar_substrate', 'white_paint', 'carbon'], '背面', { optionLabels: BACK_FIN, title: '基板侧面与背面（星链单翼背面白色漫反射）' }),
    efficiency: EFF,
    articulate: bool(true, '转动关节', { title: 'AGI 关节：绕铰链轴转动（零位 = 设定展开角；星链单翼即绕铰链单轴对日）；关 = 固定展开（立方星）' })
  },
  validate: (p) => {
    const rp = Math.max(0.003, Math.min(0.015, 0.9 * p.thicknessM + 0.002))
    const out = []
    if ((p.lengthM - 1.8 * rp - (p.rows - 1) * p.gapM) / p.rows <= 0.005) out.push('折叠段太短（展开长不够分段）')
    if ((p.widthM - (p.cols - 1) * p.gapM) / p.cols <= 0.005) out.push('列太窄（宽度不够分列）')
    return out
  },
  sockets: (p) => [ROOT(Math.min(p.widthM, 0.6), 90)],
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'wing', name: '太阳翼', role: 'solarArray' }
    const d = p.deployDeg * DEG, c = Math.cos(d), s = Math.sin(d)
    const R = [[c, 0, s].map(z0), [0, 1, 0], [-s, 0, c].map(z0)], t = [0, 0, p.hingeHM]
    const w = addWingHw(ctx, R, t, part, CELL_MATS[p.cellType] || 'solar_cell', (put) => hingedPanels(put, LOCAL_F, { L: p.lengthM, W: p.widthM, rows: p.rows, cols: p.cols, gap: p.gapM, t: p.thicknessM, cell: p.cellType, both: p.bothFaces, back: p.back }))
    const r = w.ret
    // 铰链座（静止）：每个铰链节下一枚钛座托住铰链轴
    addHw(ctx, 'wing_hinge', part, 'solarArray', 'titanium', (put) => {
      const hz = p.hingeHM + r.rp
      for (const y of r.knuckles) obox(put('titanium'), LOCAL_F, [0, y, hz / 2], [1.2 * r.rp + 0.003, Math.min(0.012, 0.04 * p.widthM + 0.004), hz / 2], ['+x', '-x', '+y', '-y', '+z'])
    })
    const x0 = 1.8 * r.rp, xc = (x0 + p.lengthM) / 2
    plateComp(ctx, 'wing_panels', (ctx.dens.panelAreal + ctx.dens.cellAreal * (p.bothFaces ? 2 : 1)) * r.area, inL(R, t, [xc, 0, 0]), R, p.lengthM - x0, p.widthM)
    finishWing(ctx, p, R, w, r.cellArea, { name: 'rotate', type: 'yRotate', minimumValue: z0(p.deployDeg - 180), maximumValue: p.deployDeg, initialValue: 0 })
    apLocal(ctx, 'axis', t, [0, 1, 0])
    return ctx
  }
}

// ───────────────────────────── 柔性太阳翼 ─────────────────────────────

const flexWing = {
  type: 'sat.wing.flex', domain: SAT, title: 'Flexible solar array (mast + blankets)', titleZh: '柔性太阳翼', role: 'solarArray', category: 'power',
  aliases: ['柔性', '折叠帆', '伸展杆', '空间站', '天宫', '问天', '梦天', 'ISS', 'FAST', 'flexible', 'blanket'],
  presets: [
    { id: 'iss', titleZh: '空间站大型柔性翼', title: 'Large space station flexible array', aliases: ['国际空间站', 'ISS', '问天', '梦天'], params: { lengthM: 32, blanketWM: 4.6, gapM: 0.9, segments: 41, mastDM: 1.1, yokeLenM: 1.2 } }
  ],
  params: {
    lengthM: num(13, 'm', '帆长', { gt: 0, title: '帆沿翼展的长度（收纳箱到顶箱）' }),
    blanketWM: num(2.5, 'm', '单帆宽', { gt: 0, title: '每张帆的宽度（伸展杆两侧各一张）' }),
    gapM: num(0.5, 'm', '两帆间距', { gt: 0, title: '两张帆之间的空当（伸展杆在其中）' }),
    segments: int(26, '折叠板数', { min: 1, max: 120, title: '每张帆沿翼展的折叠板数（板缝即折痕）' }),
    mastDM: num(0.35, 'm', '伸展杆直径', { gt: 0, title: '三角桁架伸展杆外接圆直径' }),
    yokeLenM: num(0.6, 'm', '连接架长度', { min: 0, title: 'SADA 外端到收纳箱' }),
    yoke: YOKE_STYLE,
    ...SADA_P,
    tiltDeg: TILT,
    cellType: CELL,
    efficiency: EFF,
    articulate: ART
  },
  sockets: (p) => [ROOT(p.sadaLenM > 0 && p.sadaDM > 0 ? p.sadaDM : 0.3, 90)],
  mirrorPlanes: ['xz'],
  mirror: mirrorTilt,
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'wing', name: '太阳翼', role: 'solarArray' }
    addSada(ctx, p)
    const R = wingR(p.tiltDeg), t = [0, 0, 0], y0 = p.sadaLenM + p.yokeLenM
    let yk = []
    const W = 2 * p.blanketWM + p.gapM
    const w = addWingHw(ctx, R, t, part, CELL_MATS[p.cellType] || 'solar_cell', (put) => {
      if (p.yokeLenM > 0.01) yk = solarYoke(put, LOCAL_F, { y0: p.sadaLenM, y1: y0, W0: Math.min(W, 2.5), r: G.yokeRodDM / 2, style: p.yoke })
      return flexBlanketWing(put, LOCAL_F, { y0, L: p.lengthM, wB: p.blanketWM, gap: p.gapM, n: p.segments, mastD: p.mastDM, cell: p.cellType })
    })
    const r = w.ret
    yokeMass(ctx, R, yk)
    // 质量：两张帆（flexAreal）、伸展杆（boomLinear × 杆长 × 杆径 / 0.1 m）、收纳箱与顶箱（towerAreal × 箱表面积）
    plateComp(ctx, 'wing_blankets', ctx.dens.flexAreal * r.blanketArea, inL(R, t, [0, y0 + r.bh + p.lengthM / 2, 0]), R, W, p.lengthM)
    rodMass(ctx, 'wing_mast', inL(R, t, [0, y0 + r.bh, 0]), inL(R, t, [0, y0 + r.bh + p.lengthM, 0]), ctx.dens.boomLinear * Math.max(1, p.mastDM / 0.1))
    const boxA = (h, d) => 2 * (W * h + W * d + h * d)
    pointComp(ctx, 'wing_box', ctx.dens.towerAreal * boxA(r.bh, r.bd), inL(R, t, r.boxes[0]))
    pointComp(ctx, 'wing_tipbox', ctx.dens.towerAreal * boxA(0.6 * r.bh, 0.7 * r.bd), inL(R, t, r.boxes[1]))
    finishWing(ctx, p, R, w, r.cellArea)
    apLocal(ctx, 'axis', [0, 0, 0], [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 卷展式太阳翼 ─────────────────────────────

const rosaWingDef = {
  type: 'sat.wing.rosa', domain: SAT, title: 'Roll-out solar array (ROSA)', titleZh: '卷展式太阳翼', role: 'solarArray', category: 'power',
  aliases: ['卷展', '卷轴', 'ROSA', 'iROSA', '开口薄壁管', 'DART', 'roll-out', 'flexible'],
  presets: [
    { id: 'irosa', titleZh: '空间站卷展翼（iROSA）', title: 'iROSA space station roll-out array', aliases: ['iROSA', '国际空间站', 'ISS'], params: { lengthM: 19, widthM: 6, boomDM: 0.2, rollDM: 0.45, yokeLenM: 1.0 } }
  ],
  params: {
    lengthM: num(8.5, 'm', '展开长', { gt: 0, title: '根部横梁到翼尖卷筒轴（DART 约 8.5 m）' }),
    widthM: num(2.4, 'm', '帆宽', { gt: 0 }),
    boomDM: num(0.08, 'm', '卷展杆直径', { gt: 0, title: '两侧开口薄壁管伸展杆展开后的外径' }),
    rollDM: num(0.25, 'm', '卷筒直径', { gt: 0, title: '翼尖卷筒（收拢时帆与杆卷在上面）直径' }),
    yokeLenM: num(0.5, 'm', '连接架长度', { min: 0, title: 'SADA 外端到根部横梁' }),
    yoke: enm('rod', ['v', 'trap', 'rod'], '连接架形式', { optionLabels: { v: 'V 形', trap: '梯形', rod: '单杆' } }),
    ...SADA_P,
    tiltDeg: TILT,
    cellType: CELL,
    efficiency: EFF,
    articulate: ART
  },
  validate: (p) => (p.lengthM <= p.rollDM / 2 + 0.2 ? ['展开长须大于卷筒半径 + 0.2 m'] : []),
  sockets: (p) => [ROOT(p.sadaLenM > 0 && p.sadaDM > 0 ? p.sadaDM : 0.3, 90)],
  mirrorPlanes: ['xz'],
  mirror: mirrorTilt,
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'wing', name: '太阳翼', role: 'solarArray' }
    addSada(ctx, p)
    const R = wingR(p.tiltDeg), t = [0, 0, 0], y0 = p.sadaLenM + p.yokeLenM
    let yk = []
    const w = addWingHw(ctx, R, t, part, CELL_MATS[p.cellType] || 'solar_cell', (put) => {
      if (p.yokeLenM > 0.01) yk = solarYoke(put, LOCAL_F, { y0: p.sadaLenM, y1: y0, W0: Math.min(p.widthM, 2.5), r: G.yokeRodDM / 2, style: p.yoke })
      return rosaWing(put, LOCAL_F, { y0, L: p.lengthM, W: p.widthM, boomD: p.boomDM, rollD: p.rollDM, cell: p.cellType })
    })
    const r = w.ret
    yokeMass(ctx, R, yk)
    // 质量：帆（flexAreal）、两根卷展杆（boomLinear）、卷筒（towerAreal × 筒面积）
    plateComp(ctx, 'wing_blanket', ctx.dens.flexAreal * r.blanketArea, inL(R, t, [0, y0 + p.lengthM / 2, 0]), R, p.widthM, p.lengthM)
    for (const s of [1, -1]) rodComp(ctx, `wing_boom_${s > 0 ? 'a' : 'b'}`, inL(R, t, [s * r.xb, y0, 0]), inL(R, t, [s * r.xb, y0 + p.lengthM, 0]))
    const rr = p.rollDM / 2, Lr = 2 * r.xb + p.boomDM, mr = ctx.dens.towerAreal * 2 * Math.PI * rr * Lr
    comp(ctx, 'wing_roll', 'cylinder', mr, inL(R, t, [0, y0 + p.lengthM, 0]), (() => { const it = mr * (3 * rr * rr + Lr * Lr) / 12; return [mr * rr * rr, 0, 0, 0, it, 0, 0, 0, it] })())
    finishWing(ctx, p, R, w, r.cellArea)
    apLocal(ctx, 'axis', [0, 0, 0], [0, 0, 1])
    return ctx
  }
}

// ───────────────────────────── 圆形太阳翼 ─────────────────────────────

const circularWingDef = {
  type: 'sat.wing.circular', domain: SAT, title: 'Circular solar array (UltraFlex)', titleZh: '圆形太阳翼', role: 'solarArray', category: 'power',
  aliases: ['圆形', '扇形', '伞形', 'UltraFlex', 'MegaFlex', '天鹅座', 'Cygnus', 'InSight', '露西', 'Lucy', 'circular'],
  presets: [
    { id: 'large', titleZh: '大型圆形太阳翼', title: 'Large circular solar array', aliases: ['露西', 'Lucy', '深空'], params: { diameterM: 7.3, gores: 10, yokeLenM: 0.8 } }
  ],
  params: {
    diameterM: num(3.7, 'm', '直径', { gt: 0, title: '帆展开后的外接圆直径（天鹅座货运飞船约 3.7 m、露西号约 7.3 m）' }),
    gores: int(10, '扇区数', { min: 5, max: 24, title: '扇形折叠的三角帆片数（多边形边数）' }),
    sweepDeg: num(360, '°', '展开角度', { min: 120, max: 360, title: '帆展开扫过的角度；不足 360° 时缺口朝翼根' }),
    yokeLenM: num(0.4, 'm', '连接架长度', { min: 0, title: 'SADA 外端到帆外缘（连接架从帆背后接到中心毂）' }),
    ...SADA_P,
    tiltDeg: TILT,
    cellType: CELL,
    efficiency: EFF,
    articulate: ART
  },
  sockets: (p) => [ROOT(p.sadaLenM > 0 && p.sadaDM > 0 ? p.sadaDM : 0.3, 90)],
  mirrorPlanes: ['xz'],
  mirror: mirrorTilt,
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'wing', name: '太阳翼', role: 'solarArray' }
    addSada(ctx, p)
    const R = wingR(p.tiltDeg), t = [0, 0, 0]
    const Rd = p.diameterM / 2, y0 = p.sadaLenM + p.yokeLenM
    const sw = Math.min(360, p.sweepDeg)
    // 毂心：帆朝翼根那一侧的最近点离毂心 Rd（满圆）或 Rd·cos(缺口半角)（扇形缺口朝翼根）
    const near = sw >= 360 ? Rd * Math.cos(Math.PI / p.gores) : Math.max(0.15 * Rd, Rd * Math.cos(Math.min(Math.PI / 2, (360 - sw) / 2 * DEG)))
    const yc = y0 + near, hubR = Math.max(0.05, 0.045 * Rd), zb = Math.max(0.08, 0.04 * Rd)
    const yr = Math.max(0.012, G.yokeRodDM / 2)
    const w = addWingHw(ctx, R, t, part, CELL_MATS[p.cellType] || 'solar_cell', (put) => {
      // 连接架：自 SADA 外端斜到帆背后，再沿翼展到毂心（毂伸到帆背后 zb 处与它相接）
      const a = [0, p.sadaLenM, 0], b = [0, p.sadaLenM + Math.min(0.15, 0.4 * Math.max(0.05, p.yokeLenM)), -zb], c = [0, yc, -zb]
      for (const [u, v] of [[a, b], [b, c]]) if (Math.hypot(v[1] - u[1], v[2] - u[2]) > 1e-3) cyl(put('carbon'), u, v, yr, 10, true, true)
      return circularWing(put, LOCAL_F, { yc, R: Rd, n: p.gores, sweep: sw, hubR, cell: p.cellType, zb })
    })
    const r = w.ret
    finishWing(ctx, p, R, w, r.cellArea)
    plateComp(ctx, 'wing_blanket', ctx.dens.flexAreal * r.area, inL(R, t, [0, yc, 0]), R, p.diameterM / Math.SQRT2, p.diameterM / Math.SQRT2)
    rodComp(ctx, 'wing_yoke', inL(R, t, [0, p.sadaLenM, 0]), inL(R, t, [0, yc, -zb]))
    apLocal(ctx, 'axis', [0, 0, 0], [0, 0, 1])
    return ctx
  }
}

export const SAT_WING_COMPONENTS = Object.freeze([hingedWing, flexWing, rosaWingDef, circularWingDef])
