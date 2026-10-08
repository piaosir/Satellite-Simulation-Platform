// 卫星领域装配组件 · 星体（2026-10-08「星体种类补全」）：多棱柱、立方星、球形 / 多面体、舱段式。箱形 / 圆柱 / 六棱柱 / 梯形截面 /
// 扁平板式在 sat.mjs（箱形与整星 paramBus 同式）。
//
// 为什么（2026-10-08 用户：「星体种类也补全」）：组件库的星体只有箱 / 柱 / 六棱柱 / 梯形 / 平板五种，立方星要拿箱形加四根基本体导轨拼，
// 铱星一代那种三棱柱、东方红一号那种多面体、LAGEOS 测地球、空间站 / 货运飞船那种柱段 + 锥段的舱体都拼不出来。
//
// ★ 局部系同 sat.mjs 的星体：原点 = 几何中心，安装接口 '-Z'（星体多作根件），+Z = 对地面 / 前端；可贴面只有平面 'plane' 与柱面 'cyl'
//   （球面没有可贴面，只给六个轴向接口）；挂点 nadir_center / zenith_center；massSink 'bus'（装配件目标质量的余量进星体）。
// ★ 质量：多棱柱 / 球按体密度 busVolume × 体积；舱段按密封舱体密度 moduleVolume × 体积；立方星按 cubesatMass（每 1U 体积 1.33 kg，CDS 第 13 版上限）× 体积 / 1U 体积。
//   都可用「星体质量」手填覆盖。
// ★ 对称面：圆周分段一律按偶数判；立方星的分离弹簧 / 行程开关四角都画，关于两个面对称；舱段对接口三片导向瓣只关于 yz 对称；
//   球面上的角反射器（黄金角螺旋布点）与多面体棋盘格不对称，不声明（镜像时烘焙）。
//
// 导出：SAT_BUS_COMPONENTS（sat.bus.prism / sat.bus.cubesat / sat.bus.sphere / sat.bus.module）

import { isNum, z0, MB, box, frustum, lathe, scl, sub, cross, dot, nrm, addItem, boxComp, comp, shellComp } from '../meshKit.mjs'
import { MATERIALS, SOLAR_EFFICIENCY_DEFAULT } from '../paramBus.mjs'
import { DETAIL_PRESETS } from '../paramTemplates.mjs'
import { prism as kitPrism, obox, cyl, disc, ring, quadPts, tri } from '../fleet/kit.mjs'
import { num, int, bool, enm, sock, apLocal } from './shapeKit.mjs'

const SAT = ['spacecraft']
const C = DETAIL_PRESETS.cubesat
const G = DETAIL_PRESETS.geo
const vz = (v) => v.map(z0)
const F0 = Object.freeze({ o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] })
const MLI_OPTIONS = ['none', ...['mli_gold', 'mli_silver', 'mli_black', 'kapton_black'].filter((k) => MATERIALS[k])]
const MLI = enm('mli_gold', MLI_OPTIONS, '热控多层', { title: '星体多层隔热组件（MLI）外表面；无 = 不包覆' })
const MASS = num(null, 'kg', '星体质量', { nullable: true, gt: 0, title: '星体（含未单列的载荷与推进剂）质量；留空按体密度估算；装配件指定目标质量时由其承担质量差额' })
const MLI_OFF = num(G.mliOffM, 'm', 'MLI 离面', { min: 0, max: 0.5 })
const BUS_PART = Object.freeze({ id: 'bus', name: '星体', role: 'bus' })
/** 平面可贴面（u × v = n） */
const plane = (id, origin, n, u, halfU, halfV) => ({ id, kind: 'plane', origin: vz(origin), n: vz(n), u: vz(u), v: vz(cross(n, u)), halfU, halfV })
/** 柱面可贴面（轴 axis、圆周零位 ref；uv0 = 沿轴高度、uv1 = 弧长；整圆） */
const cylFace = (id, origin, axis, ref, radius, halfU) => ({ id, kind: 'cyl', origin, axis, ref, radius, halfU, halfV: Math.PI * radius, full: true })
/** 面 → 接口（面心、法向、滚转零位 = u） */
const faceSockets = (faces) => faces.filter((f) => f.kind === 'plane').map((f) => sock(f.id, f.origin, f.n, f.u, 2 * Math.min(f.halfU, f.halfV)))
/** 实心圆柱质量元（轴 z） */
const cylMass = (ctx, name, m, c, r, h) => { const it = m * (3 * r * r + h * h) / 12; comp(ctx, name, 'cylinder', m, c, [it, 0, 0, 0, it, 0, 0, 0, m * r * r / 2]) }

// ───────────────────────────── 多棱柱星体 ─────────────────────────────

/** 正 n 棱柱：外接圆半径 R、内切（对边）半径 a、侧面 k 外法向角 2πk/n（side0 朝 +X）、顶点在两侧面法向的角平分线上 */
function prismGeom(p) {
  const n = p.sides, R = p.diameterM / 2, a = R * Math.cos(Math.PI / n), hz = p.hM / 2
  const sides = [], corners = []
  for (let k = 0; k < n; k++) {
    const th = (2 * Math.PI * k) / n, nn = vz([Math.cos(th), Math.sin(th), 0])
    sides.push({ id: `side${k}`, n: nn, origin: vz(scl(nn, a)) })
    const tc = th - Math.PI / n
    corners.push([R * Math.cos(tc), R * Math.sin(tc)])
  }
  return { n, R, a, hz, sides, corners, edge: 2 * R * Math.sin(Math.PI / n) }
}
function prismFaces(p) {
  const g = prismGeom(p), hc = 0.7 * g.a
  return [
    ...g.sides.map((s) => plane(s.id, s.origin, s.n, [0, 0, 1], g.hz, g.edge / 2)),
    plane('+Z', [0, 0, g.hz], [0, 0, 1], [1, 0, 0], hc, hc), plane('-Z', [0, 0, -g.hz], [0, 0, -1], [1, 0, 0], hc, hc)
  ]
}

const busPrism = {
  type: 'sat.bus.prism', domain: SAT, title: 'Bus (polygonal prism)', titleZh: '星体（多棱柱形）', role: 'bus', category: 'structure',
  aliases: ['平台', '本体', '棱柱', '三棱柱', '八棱柱', '多边形', '铱星', 'bus', 'prism'],
  presets: [
    { id: 'tri', titleZh: '三棱柱星体', title: 'Triangular prism bus', aliases: ['三棱柱', '铱星', 'Iridium'], params: { sides: 3, diameterM: 1.2, hM: 4.0 } },
    { id: 'dodeca', titleZh: '十二棱柱星体', title: 'Dodecagonal prism bus', aliases: ['十二棱柱', '自旋'], params: { sides: 12, diameterM: 2.2, hM: 1.6 } }
  ],
  params: {
    sides: int(8, '棱数', { min: 3, max: 24, title: '侧面数（三棱柱：铱星一代；八棱柱：多见于对地观测平台）' }),
    diameterM: num(2.2, 'm', '外接圆直径', { gt: 0, title: '截面外接圆直径（过棱）' }),
    hM: num(2.0, 'm', '高', { gt: 0 }),
    mli: MLI, massKg: MASS, mliOffM: MLI_OFF
  },
  mountSocket: '-Z',
  sockets: (p) => faceSockets(prismFaces(p)),
  faces: prismFaces,
  massSink: 'bus',
  symmetricPlanes: (p) => (p.sides % 2 === 0 ? ['yz', 'xz'] : ['xz']),
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const g = prismGeom(p)
    const mb = new MB(); kitPrism(mb, F0, g.corners, -g.hz, g.hz)
    addItem(ctx, { name: 'bus', role: 'bus', part: BUS_PART, mat: 'aluminum', mb })
    const A = 0.5 * g.n * g.R * g.R * Math.sin((2 * Math.PI) / g.n)
    cylMass(ctx, 'bus', isNum(p.massKg) ? p.massKg : dens.busVolume * A * p.hM, [0, 0, 0], Math.sqrt(A / Math.PI), p.hM)
    if (p.mli !== 'none') {
      const k = (g.a + p.mliOffM) / g.a, mm = new MB()
      kitPrism(mm, F0, g.corners.map(([x, y]) => [x * k, y * k]), -g.hz * 0.985, g.hz * 0.985, { cap0: false, cap1: false })
      const it = addItem(ctx, { name: 'bus_mli', role: 'bus', part: BUS_PART, mat: p.mli, mb: mm })
      shellComp(ctx, 'bus_mli', it, dens.mliAreal)
    }
    apLocal(ctx, 'nadir_center', [0, 0, g.hz], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, -g.hz], [0, 0, -1])
    return ctx
  }
}

// ───────────────────────────── 立方星星体 ─────────────────────────────

const ONE_U_VOL = 0.1 * 0.1 * 0.1135      // 1U 体积（含导轨脚的外包络，m³）
/** 立方星几何：外包络（导轨外缘）半边长 E、侧板（结构盒）半边长 h、导轨宽 rw、导轨脚 rf */
function cubeGeom(p) {
  const rw = p.railWM, rf = p.railFootM, ins = C.bodyInsetM
  return { E: [p.xM / 2, p.yM / 2, p.zM / 2], h: [p.xM / 2 - ins, p.yM / 2 - ins, p.zM / 2 - rf], rw, rf }
}
function cubeFaces(p) {
  const { h, rw } = cubeGeom(p)
  // 侧面只算导轨之间的板面；两端面让开四角导轨
  return [
    plane('+X', [h[0], 0, 0], [1, 0, 0], [0, 0, 1], h[2], h[1] - rw), plane('-X', [-h[0], 0, 0], [-1, 0, 0], [0, 0, 1], h[2], h[1] - rw),
    plane('+Y', [0, h[1], 0], [0, 1, 0], [0, 0, 1], h[2], h[0] - rw), plane('-Y', [0, -h[1], 0], [0, -1, 0], [0, 0, 1], h[2], h[0] - rw),
    plane('+Z', [0, 0, h[2]], [0, 0, 1], [1, 0, 0], h[0] - rw, h[1] - rw), plane('-Z', [0, 0, -h[2]], [0, 0, -1], [1, 0, 0], h[0] - rw, h[1] - rw)
  ]
}
const CUBE_SKIN = Object.freeze({ cells: '体装电池片', black: '黑色阳极化', aluminum: '本色铝', gold: '阿洛丁（金色）' })

const busCubesat = {
  type: 'sat.bus.cubesat', domain: SAT, title: 'CubeSat bus', titleZh: '立方星星体', role: 'bus', category: 'structure',
  aliases: ['立方星', 'CubeSat', '纳星', '微纳卫星', '1U', '3U', '6U', '12U', '导轨', 'bus'],
  presets: [
    { id: '1u', titleZh: '1U 立方星', title: '1U CubeSat', aliases: ['1U'], params: { zM: 0.1135 } },
    { id: '2u', titleZh: '2U 立方星', title: '2U CubeSat', aliases: ['2U'], params: { zM: 0.227 } },
    { id: '6u', titleZh: '6U 立方星', title: '6U CubeSat', aliases: ['6U'], params: { xM: 0.2263, yM: 0.1, zM: 0.366 } },
    { id: '12u', titleZh: '12U 立方星', title: '12U CubeSat', aliases: ['12U'], params: { xM: 0.2263, yM: 0.2263, zM: 0.366 } }
  ],
  params: {
    xM: num(0.1, 'm', 'X 边长', { gt: 0, title: '导轨外缘包络（CDS：1U–3U 截面 100 mm，6U / 12U 截面宽 226.3 mm）' }),
    yM: num(0.1, 'm', 'Y 边长', { gt: 0, title: '导轨外缘包络（CDS：1U–3U 截面 100 mm，6U / 12U 截面宽 226.3 mm）' }),
    zM: num(0.3405, 'm', '长', { gt: 0, title: '沿导轨（局部 Z）含两端导轨脚：1U 113.5 / 2U 227 / 3U 340.5 / 6U、12U 366 mm' }),
    skin: enm('cells', ['cells', 'black', 'aluminum', 'gold'], '侧板', { optionLabels: CUBE_SKIN, title: '体装电池片：四个侧面贴 40 × 80 mm 三结电池片（黑色电路板上）' }),
    railWM: num(C.railWM, 'm', '导轨宽', { gt: 0, title: '四角导轨截面边长（CDS 8.5 mm）' }),
    railFootM: num(C.railFootM, 'm', '导轨脚长', { min: 0, title: '导轨伸出两端面的长度（1U：(113.5 − 100) / 2 mm）' }),
    efficiency: num(SOLAR_EFFICIENCY_DEFAULT, '%', '电池片效率', { min: 0, max: 100, title: '电池片光电转换效率（AGI 太阳翼组 efficiency，百分数）' }),
    massKg: num(null, 'kg', '星体质量', { nullable: true, gt: 0, title: '留空按每 1U 体积 1.33 kg（CDS 第 13 版上限）估算；装配件指定目标质量时由其承担质量差额' })
  },
  validate: (p) => (p.xM > 2 * p.railWM + 0.02 && p.yM > 2 * p.railWM + 0.02 && p.zM > 2 * p.railFootM + 0.02 ? [] : ['尺寸小于导轨（导轨宽 / 导轨脚过大）']),
  mountSocket: '-Z',
  sockets: (p) => faceSockets(cubeFaces(p)),
  faces: cubeFaces,
  massSink: 'bus',
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const { E, h, rw, rf } = cubeGeom(p)
    const mb = new MB(); box(mb, [0, 0, 0], h)
    addItem(ctx, { name: 'bus', role: 'bus', part: BUS_PART, mat: 'aluminum', mb })
    // 四角导轨（全长，外缘即包络）+ 导轨端头：+Z 端分离弹簧柱塞、−Z 端行程开关（四角都画）
    const rm = new MB(), dm = new MB()
    for (const sx of [1, -1]) for (const sy of [1, -1]) {
      const cx = sx * (E[0] - rw / 2), cy = sy * (E[1] - rw / 2)
      box(rm, [cx, cy, 0], [rw / 2, rw / 2, E[2]])
      cyl(dm, [cx, cy, E[2]], [cx, cy, E[2] + 0.0025], 0.3 * rw, 8, false, true)
      box(dm, [cx, cy, -E[2] - 0.0012], [0.28 * rw, 0.28 * rw, 0.0012], ['+x', '-x', '+y', '-y', '-z'])
    }
    addItem(ctx, { name: 'bus_rails', role: 'bus', part: BUS_PART, mat: 'aluminum', mb: rm })
    addItem(ctx, { name: 'bus_switches', role: 'bus', part: BUS_PART, mat: 'dark_metal', mb: dm })
    // 侧板外表面
    const faces = [[[1, 0, 0], h[1]], [[-1, 0, 0], h[1]], [[0, 1, 0], h[0]], [[0, -1, 0], h[0]]]
    if (p.skin !== 'aluminum') {
      const sk = new MB(), cm = new MB(), lift = 0.0006
      let cellArea = 0
      for (const [n, half] of faces) {
        const ax = n[0] !== 0 ? 0 : 1, s = n[ax], t = ax === 0 ? [0, 1, 0] : [1, 0, 0]
        const c0 = [0, 0, 0]; c0[ax] = s * (h[ax] + lift)
        const w2 = half - rw, h2 = h[2]
        const P = (u, v, l = 0) => { const q = c0.slice(); q[ax] += s * l; return [q[0] + t[0] * u, q[1] + t[1] * u, v] }
        quadPts(sk, P(-w2, -h2), P(w2, -h2), P(w2, h2), P(-w2, h2), n)
        if (p.skin === 'cells') {
          // 40 × 80 mm 电池片（宽沿板宽、长沿 Z），格间 2 mm，整体居中
          const cw = 0.04, ch = 0.08, g = 0.002
          const nc = Math.max(0, Math.floor((2 * w2 - 0.002 + g) / (cw + g))), nr = Math.max(0, Math.floor((2 * h2 - 0.004 + g) / (ch + g)))
          const u0 = -(nc * cw + (nc - 1) * g) / 2, v0 = -(nr * ch + (nr - 1) * g) / 2
          for (let i = 0; i < nc; i++) for (let j = 0; j < nr; j++) {
            const ua = u0 + i * (cw + g), va = v0 + j * (ch + g)
            quadPts(cm, P(ua, va, 0.0005), P(ua + cw, va, 0.0005), P(ua + cw, va + ch, 0.0005), P(ua, va + ch, 0.0005), n)
            cellArea += cw * ch
          }
        }
      }
      addItem(ctx, { name: 'bus_skin', role: 'bus', part: BUS_PART, mat: p.skin === 'gold' ? 'gold_metal' : 'black_paint', mb: sk })
      if (cm.tcount) {
        const it = addItem(ctx, { name: 'bus_cells', role: 'solarArray', part: { id: 'cells', name: '体装太阳电池', role: 'solarArray' }, mat: 'solar_cell', mb: cm })
        shellComp(ctx, 'bus_cells', it, dens.cellAreal)
        ctx.parts.get('cells').areaM2 = cellArea
        ctx.spg.push({ name: 'cells', nodes: ['bus_cells'], efficiency: p.efficiency })
      }
    }
    const m = isNum(p.massKg) ? p.massKg : dens.cubesatMass * (p.xM * p.yM * p.zM) / ONE_U_VOL
    boxComp(ctx, 'bus', m, [0, 0, 0], E)
    apLocal(ctx, 'nadir_center', [0, 0, h[2]], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, -h[2]], [0, 0, -1])
    return ctx
  }
}

// ───────────────────────────── 球形 / 多面体星体 ─────────────────────────────

const SPH_FIN = Object.freeze({ aluminum: '本色铝', gold_metal: '镀金', white_paint: '白漆', mli_silver: '银色 MLI', black_paint: '黑色' })
const ACCENT = Object.freeze({ none: '无', gold_metal: '镀金', black_paint: '黑色', white_paint: '白漆', dark_metal: '深色金属' })
/** 多面体顶点：纬线 φj = −90° + 180°·j/latSeg、经线 λk = 360°·(k + ½)/lonSeg（块心落在 ±X 方向）、外接半径 R */
const polyV = (R, j, k, latSeg, lonSeg) => {
  const ph = -Math.PI / 2 + (Math.PI * j) / latSeg, la = (2 * Math.PI * (k + 0.5)) / lonSeg
  return [R * Math.cos(ph) * Math.cos(la), R * Math.cos(ph) * Math.sin(la), R * Math.sin(ph)].map(z0)
}
/** 凸多面体沿单位方向 d 的表面点（各块平面求交取最近）；球面直接取 R */
function sphereSurface(p, d) {
  const R = p.diameterM / 2
  if (p.form !== 'polyhedron') return scl(d, R)
  let tMin = R
  for (let j = 0; j < p.latSeg; j++) for (let k = 0; k < p.lonSeg; k++) {
    const a = polyV(R, j, k, p.latSeg, p.lonSeg), b = polyV(R, j, k + 1, p.latSeg, p.lonSeg), c = polyV(R, j + 1, k + 1, p.latSeg, p.lonSeg), e = polyV(R, j + 1, k, p.latSeg, p.lonSeg)
    let n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]])
    if (Math.hypot(...n) < 1e-12) n = cross([c[0] - a[0], c[1] - a[1], c[2] - a[2]], [e[0] - a[0], e[1] - a[1], e[2] - a[2]])
    n = nrm(n)
    if (dot(n, a) < 0) n = scl(n, -1)
    const dn = dot(n, d)
    if (dn > 1e-9) tMin = Math.min(tMin, dot(n, a) / dn)
  }
  return scl(d, tMin)
}
const AXES = [['+X', [1, 0, 0], [0, 0, 1]], ['-X', [-1, 0, 0], [0, 0, 1]], ['+Y', [0, 1, 0], [0, 0, 1]], ['-Y', [0, -1, 0], [0, 0, 1]], ['+Z', [0, 0, 1], [1, 0, 0]], ['-Z', [0, 0, -1], [1, 0, 0]]]

const busSphere = {
  type: 'sat.bus.sphere', domain: SAT, title: 'Bus (sphere / polyhedron)', titleZh: '星体（球形）', role: 'bus', category: 'structure',
  aliases: ['球形', '多面体', '东方红一号', '测地', 'LAGEOS', '角反射器球', '斯普特尼克', 'sphere', 'bus'],
  presets: [
    { id: 'dfh1', titleZh: '72 面体星体（东方红一号式）', title: '72-facet polyhedral bus (DFH-1 style)', aliases: ['东方红一号', '72 面体', '多面体'], params: { form: 'polyhedron', diameterM: 1.0, lonSeg: 12, latSeg: 6 } },
    { id: 'lageos', titleZh: '测地卫星（角反射器球）', title: 'Geodetic satellite (retroreflector sphere)', aliases: ['LAGEOS', '测地', '激光测距'], params: { diameterM: 0.6, reflectors: 426, massKg: 406 } }
  ],
  params: {
    diameterM: num(1.0, 'm', '直径', { gt: 0, title: '外接球直径（东方红一号约 1 m、LAGEOS 0.6 m）' }),
    form: enm('sphere', ['sphere', 'polyhedron'], '外形', { optionLabels: { sphere: '球面', polyhedron: '多面体' }, title: '多面体：按经纬分块的平面多面体（东方红一号为 72 面体 = 6 层 × 12 块）' }),
    lonSeg: int(12, '经向块数', { min: 4, max: 48, title: '多面体每层绕一圈的块数' }),
    latSeg: int(6, '纬向层数', { min: 2, max: 24 }),
    finish: enm('aluminum', ['aluminum', 'gold_metal', 'white_paint', 'mli_silver', 'black_paint'], '外表面', { optionLabels: SPH_FIN }),
    accent: enm('none', ['none', 'gold_metal', 'black_paint', 'white_paint', 'dark_metal'], '间隔块外表面', { optionLabels: ACCENT, title: '多面体相邻块交替用另一种外表面（棋盘格）；无 = 全部同色' }),
    reflectors: int(0, '角反射器数', { min: 0, max: 1000, title: '球面上均布的激光角反射器（黄金角螺旋布点；LAGEOS 0.6 m 球上 426 块）；0 = 无' }),
    reflectorDM: num(0.038, 'm', '角反射器口径', { gt: 0 }),
    massKg: MASS
  },
  mountSocket: '-Z',
  sockets: (p) => AXES.map(([id, d, up]) => sock(id, vz(sphereSurface(p, d)), d, up, 0.4 * p.diameterM, 15)),
  massSink: 'bus',
  symmetricPlanes: (p) => (p.reflectors > 0 || (p.form === 'polyhedron' && p.accent !== 'none') ? [] : p.form === 'polyhedron' && p.lonSeg % 2 ? ['xz'] : ['yz', 'xz']),
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const R = p.diameterM / 2
    if (p.form === 'polyhedron') {
      const m1 = new MB(), m2 = new MB()
      for (let j = 0; j < p.latSeg; j++) for (let k = 0; k < p.lonSeg; k++) {
        const a = polyV(R, j, k, p.latSeg, p.lonSeg), b = polyV(R, j, k + 1, p.latSeg, p.lonSeg), c = polyV(R, j + 1, k + 1, p.latSeg, p.lonSeg), e = polyV(R, j + 1, k, p.latSeg, p.lonSeg)
        const mb = p.accent !== 'none' && (j + k) % 2 ? m2 : m1
        // 两极那层退化成三角形（同一极点出两次）；块面法向取真平面法向、朝外
        const pts = j === 0 ? [a, c, e] : j === p.latSeg - 1 ? [a, b, c] : [a, b, c, e]
        const ctr = scl(pts.reduce((s, q) => [s[0] + q[0], s[1] + q[1], s[2] + q[2]], [0, 0, 0]), 1 / pts.length)
        let nf = nrm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])))
        if (dot(nf, ctr) < 0) nf = scl(nf, -1)
        if (pts.length === 3) tri(mb, pts[0], pts[1], pts[2], nf); else quadPts(mb, pts[0], pts[1], pts[2], pts[3], nf)
      }
      addItem(ctx, { name: 'bus', role: 'bus', part: BUS_PART, mat: p.finish, mb: m1 })
      if (m2.tcount) addItem(ctx, { name: 'bus_accent', role: 'bus', part: BUS_PART, mat: p.accent, mb: m2 })
    } else {
      const prof = []
      for (let i = 0; i <= 24; i++) { const th = (Math.PI * i) / 24; prof.push([R * Math.sin(th), -R * Math.cos(th)]) }
      const mb = new MB(); lathe(mb, [0, 0, 0], [0, 0, 1], prof, 48, { creaseDeg: 60 })
      addItem(ctx, { name: 'bus', role: 'bus', part: BUS_PART, mat: p.finish, mb })
    }
    if (p.reflectors > 0) {
      // 角反射器：黄金角螺旋均布（深色玻璃口 + 铝托环），口面略高于球面
      const gl = new MB(), rg = new MB(), N = p.reflectors, ga = Math.PI * (3 - Math.sqrt(5)), rr = p.reflectorDM / 2
      for (let i = 0; i < N; i++) {
        const z = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(Math.max(0, 1 - z * z)), a = i * ga
        const d = [r * Math.cos(a), r * Math.sin(a), z], c = sphereSurface(p, d)
        disc(gl, scl(d, Math.hypot(...c) + 0.0015), d, 0.82 * rr, 12)
        ring(rg, scl(d, Math.hypot(...c) + 0.001), d, 0.82 * rr, 1.08 * rr, 12)
      }
      addItem(ctx, { name: 'bus_reflectors', role: 'bus', part: BUS_PART, mat: 'glass', mb: gl })
      addItem(ctx, { name: 'bus_reflector_rims', role: 'bus', part: BUS_PART, mat: 'aluminum', mb: rg })
    }
    const m = isNum(p.massKg) ? p.massKg : dens.busVolume * (4 / 3) * Math.PI * R * R * R
    comp(ctx, 'bus', 'sphere', m, [0, 0, 0], [0.4 * m * R * R, 0, 0, 0, 0.4 * m * R * R, 0, 0, 0, 0.4 * m * R * R])
    apLocal(ctx, 'nadir_center', vz(sphereSurface(p, [0, 0, 1])), [0, 0, 1])
    apLocal(ctx, 'zenith_center', vz(sphereSurface(p, [0, 0, -1])), [0, 0, -1])
    return ctx
  }
}

// ───────────────────────────── 舱段式星体 ─────────────────────────────

const MOD_FIN = Object.freeze({ white_paint: '白漆', mli_silver: '银色 MLI', mli_gold: '金色 MLI', aluminum: '本色铝' })
const END = Object.freeze({ dock: '对接口', dome: '球冠封头', flat: '平端面' })
/** 舱段轮廓（沿 Z，后端 → 前端）：大柱段 → 锥段 → 小柱段；两端封头 / 对接口。返回各段 z 与半径 */
function moduleGeom(p) {
  const R1 = p.dLargeM / 2, R2 = p.dSmallM / 2, L1 = p.lLargeM, Lc = p.coneLenM, L2 = p.lSmallM
  const Lt = L1 + Lc + L2, za = -Lt / 2, z1 = za + L1, z2 = z1 + Lc, zf = Lt / 2
  const Rf = L2 > 0 || Lc > 0 ? R2 : R1                   // 前端半径
  const dome = (R) => 0.28 * R
  const dock = (R) => ({ rt: Math.min(0.45, 0.32 * R), L: 0.32 })
  return { R1, R2, L1, Lc, L2, Lt, za, z1, z2, zf, Rf, dome, dock }
}
/** 端头外伸长度（封头球冠高 / 对接通道长） */
const endExt = (g, kind, R) => (kind === 'dome' ? g.dome(R) : kind === 'dock' ? g.dock(R).L + 0.02 : 0)
function moduleFaces(p) {
  const g = moduleGeom(p), out = [cylFace('large', [0, 0, (g.za + g.z1) / 2], [0, 0, 1], [1, 0, 0], g.R1, g.L1 / 2)]
  if (g.L2 > 0) out.push(cylFace('small', [0, 0, (g.z2 + g.zf) / 2], [0, 0, 1], [1, 0, 0], g.R2, g.L2 / 2))
  if (p.aft === 'flat') out.push(plane('-Z', [0, 0, g.za], [0, 0, -1], [1, 0, 0], 0.7 * g.R1, 0.7 * g.R1))
  if (p.front === 'flat') out.push(plane('+Z', [0, 0, g.zf], [0, 0, 1], [1, 0, 0], 0.7 * g.Rf, 0.7 * g.Rf))
  return out
}

const busModule = {
  type: 'sat.bus.module', domain: SAT, title: 'Bus (pressurized module)', titleZh: '舱段式星体', role: 'bus', category: 'structure',
  aliases: ['舱段', '舱体', '空间站', '天宫', '核心舱', '货运飞船', '天舟', '天鹅座', 'module', 'station', 'bus'],
  presets: [
    { id: 'core', titleZh: '空间站核心舱式', title: 'Space station core module', aliases: ['核心舱', '天和', '空间站'], params: { dLargeM: 4.2, lLargeM: 7.5, coneLenM: 1.2, dSmallM: 2.8, lSmallM: 4.5, front: 'dock', aft: 'dock' } },
    { id: 'can', titleZh: '单柱段密封舱', title: 'Single-cylinder pressurized module', aliases: ['密封舱', '货运', '天鹅座'], params: { dLargeM: 3.1, lLargeM: 4.0, coneLenM: 0, lSmallM: 0, front: 'dock', aft: 'dome' } }
  ],
  params: {
    dLargeM: num(3.0, 'm', '大柱段直径', { gt: 0 }),
    lLargeM: num(4.0, 'm', '大柱段长', { gt: 0 }),
    coneLenM: num(0.6, 'm', '锥段长', { min: 0, title: '大柱段到小柱段的过渡锥段；0 = 台阶' }),
    dSmallM: num(2.2, 'm', '小柱段直径', { gt: 0 }),
    lSmallM: num(1.5, 'm', '小柱段长', { min: 0, title: '0 = 无小柱段（锥段直接收到前端）' }),
    front: enm('dock', ['dock', 'dome', 'flat'], '前端', { optionLabels: END, title: '对接口：对接通道 + 对接环 + 三片导向瓣（异体同构周边式）' }),
    aft: enm('flat', ['flat', 'dome', 'dock'], '后端', { optionLabels: END }),
    finish: enm('white_paint', ['white_paint', 'mli_silver', 'mli_gold', 'aluminum'], '外表面', { optionLabels: MOD_FIN }),
    bands: bool(true, '环向带', { title: '各段对接框处的深色环向带' }),
    seg: int(48, '分段', { min: 16, max: 128 }),
    massKg: MASS
  },
  mountSocket: '-Z',
  sockets(p) {
    const g = moduleGeom(p), zm = (g.za + g.z1) / 2
    const out = [
      sock('-Z', [0, 0, g.za - endExt(g, p.aft, g.R1)], [0, 0, -1], [1, 0, 0], p.aft === 'dock' ? 2 * g.dock(g.R1).rt : g.R1, 15),
      sock('+Z', [0, 0, g.zf + endExt(g, p.front, g.Rf)], [0, 0, 1], [1, 0, 0], p.front === 'dock' ? 2 * g.dock(g.Rf).rt : g.Rf, 15)
    ]
    for (const [id, n] of [['+X', [1, 0, 0]], ['-X', [-1, 0, 0]], ['+Y', [0, 1, 0]], ['-Y', [0, -1, 0]]]) out.push(sock(id, vz([n[0] * g.R1, n[1] * g.R1, zm]), n, [0, 0, 1], Math.min(g.L1, g.R1)))
    if (g.L2 > 0) {
      const zs = (g.z2 + g.zf) / 2
      for (const [id, n] of [['small+X', [1, 0, 0]], ['small-X', [-1, 0, 0]], ['small+Y', [0, 1, 0]], ['small-Y', [0, -1, 0]]]) out.push(sock(id, vz([n[0] * g.R2, n[1] * g.R2, zs]), n, [0, 0, 1], Math.min(g.L2, g.R2)))
    }
    return out
  },
  faces: moduleFaces,
  massSink: 'bus',
  symmetricPlanes: (p) => (p.front === 'dock' || p.aft === 'dock' ? (p.seg % 2 ? [] : ['yz']) : (p.seg % 2 ? ['xz'] : ['yz', 'xz'])),
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const g = moduleGeom(p), seg = p.seg
    // 外形：一条母线车出来（后端面 → 大柱段 → 锥段 → 小柱段 → 前端面），封头另画
    const prof = [[0, g.za], [g.R1, g.za], [g.R1, g.z1]]
    if (g.Lc > 0) prof.push([g.R2, g.z2]); else if (g.L2 > 0) prof.push([g.R2, g.z1])
    prof.push([g.Rf, g.zf], [0, g.zf])
    const mb = new MB(); lathe(mb, [0, 0, 0], [0, 0, 1], prof, seg, { creaseDeg: 25 })
    addItem(ctx, { name: 'bus', role: 'bus', part: BUS_PART, mat: p.finish, mb })
    const hw = new MB(), dk = new MB()
    const endCap = (kind, z0e, R, s) => {
      if (kind === 'dome') {
        const hd = g.dome(R), pr = []
        for (let i = 0; i <= 8; i++) { const t = (i / 8) * (Math.PI / 2); pr.push([R * Math.cos(t), hd * Math.sin(t)]) }
        lathe(mb, [0, 0, z0e], [0, 0, s], pr.map(([r, z]) => [r * 0.999, z]), seg, { creaseDeg: 60 })
      } else if (kind === 'dock') {
        const d = g.dock(R), zt = z0e + s * d.L
        cyl(dk, [0, 0, z0e], [0, 0, zt], d.rt, seg, false, false)
        ring(dk, [0, 0, zt], [0, 0, s], 0, d.rt + 0.14, seg)
        cyl(dk, [0, 0, zt], [0, 0, zt + s * 0.02], d.rt + 0.14, seg, false, true)
        // 三片导向瓣（外倾 30°）：在 90° / 210° / 330°
        for (let k = 0; k < 3; k++) {
          const a = Math.PI / 2 + (2 * Math.PI * k) / 3, c = Math.cos(a), sn = Math.sin(a), tg = [-sn, c, 0]
          const base = [c * (d.rt + 0.07), sn * (d.rt + 0.07), zt + s * 0.02], hgt = 0.22, wb = 0.16
          const tip = [base[0] + c * hgt * 0.5, base[1] + sn * hgt * 0.5, base[2] + s * hgt * 0.866]
          const pa = [base[0] + tg[0] * wb, base[1] + tg[1] * wb, base[2]], pb = [base[0] - tg[0] * wb, base[1] - tg[1] * wb, base[2]]
          const nn = nrm(cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [tip[0] - pa[0], tip[1] - pa[1], tip[2] - pa[2]]))
          tri(dk, pa, pb, tip, nn); tri(dk, pa, tip, pb, scl(nn, -1))
        }
      }
    }
    endCap(p.aft, g.za, g.R1, -1)
    endCap(p.front, g.zf, g.Rf, 1)
    if (p.bands) {
      const band = (z, R) => frustum(hw, [0, 0, z - 0.04], R + 0.008, [0, 0, z + 0.04], R + 0.008, seg, false, false)
      band(g.za + 0.05, g.R1); band(g.z1, g.R1)
      if (g.L2 > 0) { band(g.z2, g.R2); band(g.zf - 0.05, g.R2) } else band(g.zf - 0.05, g.Rf)
    }
    if (hw.tcount) addItem(ctx, { name: 'bus_bands', role: 'bus', part: BUS_PART, mat: 'dark_metal', mb: hw })
    if (dk.tcount) addItem(ctx, { name: 'bus_docking', role: 'bus', part: BUS_PART, mat: 'aluminum', mb: dk })
    // 质量：等效体密度 × 体积（大柱段 + 锥台 + 小柱段），质心按体积加权
    const V1 = Math.PI * g.R1 * g.R1 * g.L1, Vc = (Math.PI * g.Lc / 3) * (g.R1 * g.R1 + g.R1 * g.R2 + g.R2 * g.R2), V2 = Math.PI * g.R2 * g.R2 * g.L2, V = V1 + Vc + V2
    const zc = (V1 * (g.za + g.z1) / 2 + Vc * (g.z1 + g.z2) / 2 + V2 * (g.z2 + g.zf) / 2) / V
    const m = isNum(p.massKg) ? p.massKg : dens.moduleVolume * V
    cylMass(ctx, 'bus', m, [0, 0, zc], Math.sqrt(V / (Math.PI * g.Lt)), g.Lt)
    apLocal(ctx, 'nadir_center', [0, 0, g.zf + endExt(g, p.front, g.Rf)], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, g.za - endExt(g, p.aft, g.R1)], [0, 0, -1])
    return ctx
  }
}

export const SAT_BUS_COMPONENTS = Object.freeze([busPrism, busCubesat, busSphere, busModule])
