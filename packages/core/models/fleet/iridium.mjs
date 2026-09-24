// 铱星二代（Iridium NEXT）精模（2026-09-25）：Thales Alenia Space 总包、ELiTeBus-1000 平台、Orbital ATK 总装，860 kg。
//
// ★ 坐标：+X 迎风（Aireon 载荷与反速度推力器端）、+Z 对地（主任务天线 MMA 面）、±Y 太阳翼（两轴驱动）；原点 = 本体几何中心。
// ★ 一手数据：整星 860 kg、干重 678 kg、收拢 3.1 × 2.4 × 1.5 m、展开翼展 9.4 m、4 块太阳板、MMA 168 个收发单元、2 副两轴馈电天线、
//   4 条 23 GHz 星间链路（2 固定 + 2 两轴可转）、一端 4 + 4 台主推力器、另一端 1 台反速度推力器（铱星官方标注图 / FCC 离轨计划）。
//   本体三轴各对应哪个收拢尺寸、MMA 尺寸与部件位置按照片 / 标注图推算（±20 %，facts 逐条标注）。

import { F, IMG } from './sources.mjs'
import { MB, BODY, frame, add, sub, scl, nrm, madd, bevelBox, obox, prism, cyl, cone, disc, ring, quadPts } from './kit.mjs'
import { group, wing, skinBox, gimbalDish, fixedDish, nozzle, addStarTracker } from './parts.mjs'

const S = {
  EVERETTS: 'https://www.spaceweather.gov/sites/default/files/images/u63/05.%20Everets_Iridium%20Presentation%20Space%20Weather%20Workshop.pdf',
  FCC_ODAR: 'https://fcc.report/IBFS/SAT-MOD-20131227-00148/1031325.pdf',
  FCC_DRAG: 'https://fcc.report/IBFS/SAT-MOD-20131227-00148/1097984.pdf',
  ORBITAL_ATK: 'https://web.archive.org/web/20150926094943/https://www.orbitalatk.com/space-systems/commercial-satellites/communications-satellites/iridium-next/',
  IRIDIUM_MMA: 'https://investor.iridium.com/july-21-2014-first-flight-main-mission-antennas-complete',
  SEMI_TODAY: 'https://www.semiconductor-today.com/news_items/2014/SEP/INDIUM_230914.shtml',
  FCC_AIREON: 'https://fcc.report/IBFS/SAT-MOD-20131227-00148/1031326.pdf'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

function buildNext(B) {
  const h = P(1.2, 0.8, 0.6), ZN = h[2]         // 主箱 2.4（X）× 1.6（Y）× 1.2（Z）；两端载荷 / 天线把全长撑到 ≈3.1 m
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, P(0, 0, 0), h, 0.03)
  // 外观：侧面 / 对地面大面积银色（铝胶带网格感）+ 金色 MLI 包边与顶部（2017、2023 发射前照片）
  skinBox(g, BODY, P(0, 0, 0), h, { '+x': 'mli_gold', '-x': 'mli_gold', '+y': 'mli_silver', '-y': 'mli_silver', '-z': 'mli_gold', '+z': 'mli_silver' })
  g.flush()
  B.box('bus', 700, P(0, 0, 0), h)
  // 主任务天线 MMA（L 波段有源相控阵，168 个收发单元）：对地面居中偏 −X，≈1.2 × 1.3 m，左右为六角锯齿边；铜红色、表面圆形贴片六角栅格
  const gM = group(B, 'mma', '主任务天线（L 波段相控阵）', 'feed')
  const mc = P(-0.2, 0, ZN + 0.012)
  const Fm = frame(mc, [1, 0, 0], [0, 1, 0], [0, 0, 1])
  const edge = []
  for (let k = 0; k <= 12; k++) edge.push([0.62 + (k % 2 ? 0.05 : 0), -0.6 + k * 0.1])
  const outline = [...edge, ...edge.slice().reverse().map(([x, y]) => [-x, y])]
  prism(gM.mb('mli_gold'), Fm, outline, 0, 0.03, { cap0: false, cap1: false })
  prism(gM.mb('copper'), Fm, [[-0.62, -0.6], [0.62, -0.6], [0.62, 0.6], [-0.62, 0.6]], 0, 0.035, { cap0: false })
  let n = 0
  for (let j = 0; j < 14 && n < 168; j++) for (let i = 0; i < 12 && n < 168; i++) {
    const x = -0.57 + i * 0.1 + (j % 2 ? 0.05 : 0), y = -0.55 + j * 0.0846
    if (Math.abs(x) > 0.6) continue
    const q = add(mc, P(x, y, 0.035))
    cyl(gM.mb('copper'), q, add(q, P(0, 0, 0.008)), 0.034, 10, false, true)
    n++
  }
  gM.flush()
  B.point('mma', 40, add(mc, P(0, 0, 0.02)))
  B.ap('mma', add(mc, P(0, 0, 0.05)), Z)
  // Aireon 星基 ADS-B 托管载荷：对地面 +X 端白色盒（2 × 5 圆角方形贴片）
  const gA = group(B, 'aireon', 'Aireon ADS-B 载荷', 'feed')
  obox(gA.mb('white_paint'), BODY, P(0.9, 0, ZN + 0.16), P(0.2, 0.35, 0.15))
  for (let i = 0; i < 2; i++) for (let j = 0; j < 5; j++) obox(gA.mb('radome'), BODY, P(0.82 + i * 0.16, -0.28 + j * 0.14, ZN + 0.318), P(0.06, 0.055, 0.006), ['+x', '-x', '+y', '-y', '+z'])
  gA.flush()
  B.point('aireon', 50, P(0.9, 0, ZN + 0.16))
  B.ap('aireon_adsb', P(0.9, 0, ZN + 0.33), Z)
  // Ka 馈电天线：对地面两端两副（两轴万向，≈Ø0.4 m）
  gimbalDish(B, { name: 'feeder_1', title: 'Ka 馈电天线 1', base: P(-1.0, 0.55, ZN + 0.012), n: Z, look: Z, D: 0.4, fd: 0.35, postH: 0.16, mat: 'reflector' })
  gimbalDish(B, { name: 'feeder_2', title: 'Ka 馈电天线 2', base: P(0.62, -0.55, ZN + 0.012), n: Z, look: Z, D: 0.4, fd: 0.35, postH: 0.16, mat: 'reflector' })
  // 23 GHz 星间链路：±X 端各 1 副固定（前后同轨道面邻星），背地侧两端上角各 1 副两轴可转（相邻轨道面）
  const gX = group(B, 'crosslinks_fixed', '星间链路天线（固定）', 'reflector')
  fixedDish(gX, P(1.21, 0.35, -0.2), P(1, 0, 0), { D: 0.36, fd: 0.35 })
  fixedDish(gX, P(-1.21, -0.35, -0.2), P(-1, 0, 0), { D: 0.36, fd: 0.35 })
  gX.flush()
  B.ap('crosslink_fore', P(1.4, 0.35, -0.2), P(1, 0, 0))
  B.ap('crosslink_aft', P(-1.4, -0.35, -0.2), P(-1, 0, 0))
  gimbalDish(B, { name: 'crosslink_steer_1', title: '星间链路天线（可转）1', base: P(0.95, 0.5, -ZN - 0.012), n: P(0, 0, -1), look: nrm(P(0, 1, -0.3)), D: 0.32, fd: 0.35, postH: 0.14 })
  gimbalDish(B, { name: 'crosslink_steer_2', title: '星间链路天线（可转）2', base: P(-0.95, -0.5, -ZN - 0.012), n: P(0, 0, -1), look: nrm(P(0, -1, -0.3)), D: 0.32, fd: 0.35, postH: 0.14 })
  // 推进：−X 端主推力器 4 + 4 备份；+X 端 1 台反速度推力器（喷口朝 +X）
  const gT = group(B, 'thrusters', '肼推力器', 'thruster')
  for (const sy of [1, -1]) for (const sz of [1, -1]) for (const k of [0, 1]) nozzle(gT.mb('titanium'), P(-h[0] - 0.012, sy * (0.5 + k * 0.1), sz * 0.4), nrm(P(-1, sy * 0.15, sz * 0.15)), 0.018, 0.06)
  nozzle(gT.mb('titanium'), P(h[0] + 0.012, 0, 0.35), P(1, 0, 0), 0.02, 0.07)
  gT.flush()
  const gS = group(B, 'star_trackers', '星敏感器（AA-STR）', 'sensor')
  for (const sy of [1, -1]) addStarTracker(gS, { base: P(-0.6, sy * 0.45, -ZN - 0.012), dir: nrm(P(-0.3, sy * 0.4, -1)), up: P(1, 0, 0), box: [0.1, 0.1, 0.07], dB: 0.09, lB: 0.12 })
  gS.flush()
  // 太阳翼：每翼 2 块并排（垂直于展开臂），臂 ≈2.3 m、板 ≈1.5（沿臂）× 1.1 m，两轴驱动（这里只设翼轴转动）；翼展 9.4 m
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 0.812, -0.1), span: P(0, s, 0), normal: P(0, 0, -1),
      panels: [{ x: 0.57, y: 2.4, w: 1.1, h: 1.5 }, { x: -0.57, y: 2.4, w: 1.1, h: 1.5 }], yokeLen: 2.25, yoke: 'rod', yokeD: 0.06, sadaLen: 0.15, sadaD: 0.2,
      t: 0.028, margin: 0.03, frameW: 0.02, efficiency: 29, massKg: 25 })
  }
}

export const IRIDIUM_MODELS = [
  { id: 'iridium-next', rev: 1, family: 'iridium', maker: 'Thales Alenia Space', title: 'Iridium NEXT', titleZh: '铱星二代（NEXT）', basis: 'ELiTeBus-1000', tags: ['leo', 'comsat', 'iridium'], aliases: ['IRIDIUM NEXT', '铱星'],
    massKg: F(860, 'kg', S.EVERETTS, { quote: 'WEIGHT: Approx. 860 kg (164 kg fuel)' }),
    facts: {
      massKg: F(860, 'kg', S.EVERETTS, { quote: 'WEIGHT: Approx. 860 kg (164 kg fuel)' }),
      stowed: F([3.1, 2.4, 1.5], 'm', S.EVERETTS, { quote: 'STOWED DIMENSIONS: 3.1 m x 2.4 m x 1.5 m' }),
      span: F(9.4, 'm', S.EVERETTS, { quote: 'DEPLOYED WINGSPAN: 9.4 m' }),
      panels: F(4, '块', S.SEMI_TODAY, { quote: 'The array that powers the satellites contains four solar panels and will span 9.4m' }),
      mma: F(168, '单元', S.IRIDIUM_MMA, { quote: '168 transmit and receive modules' }),
      feeders: F(2, '副', S.FCC_ODAR, { quote: '2 gimbaled feeder link antennas, each with a 2-axis drive mechanism' }),
      crosslinks: F('2 固定 + 2 可转', '', S.ORBITAL_ATK, { quote: 'Four 23 GHz crosslinks to adjacent Iridium NEXT satellites for relay communications, two steerable, two fixed' }),
      thrusters: F('一端 4 + 4、另一端 1 台反速度推力器', '', S.EVERETTS, { quote: 'PRIMARY SET OF 4 THRUSTERS + REDUNDANT SET OF 4 THRUSTERS' }),
      bodyAxes: IMG([2.4, 1.6, 1.2], 'm', S.EVERETTS, '分配器照片：对地面长宽比 ≈1.47；Z 向无可靠依据')
    },
    build: buildNext }
]
