// 一网（OneWeb）第一代精模（2026-09-25）：Airbus / OneWeb Satellites「Arrow」平台，147.5 kg。
//
// ★ 坐标：+X 沿迹（1.3 m 长轴，也是 Ku 棒条长轴——窄的南北向波束要求天线沿南北长）、+Z 对地、+Y = Z × X（太阳翼轴）。
//   原点 = 星体几何中心。Ka 舱端按推断取 +X（前），霍尔推力器 / DogTag 端取 −X（后，升轨要朝后喷）——照片无法确认飞行朝向。
// ★ 外形（研究稿，照片为准）：梯形截面棱柱（对地面宽 1.00、背地面宽 0.65、深 0.95、长 1.30 m），琥珀色 Kapton MLI 包覆；
//   对地面前段两副 Ku 用户天线（各 8 根带方形辐射口的铝棒条，扇形排开，对应 FCC 文件的 16 条东西长、南北窄的固定波束），
//   后段 Ka 舱并排两面可转抛物面（两轴万向架）；每侧 1 块刚性太阳板 + 长展开臂，总展长约 6 m；−X 端面霍尔推力器 + DogTag 抓捕靶。
//   尺寸除整星质量（Arianespace 发射手册）与 Ku / Ka 天线个数（FCC）外都是照片 + 公开约数推算，误差约 ±15 %（facts 逐条标注）。

import { F, IMG, ILL } from './sources.mjs'
import { MB, BODY, frame, add, sub, scl, nrm, madd, obox, prism, cyl, cone, disc, ring, truss, quadPts, rotV } from './kit.mjs'
import { group, wing, gimbalDish, addHall, addStarTracker } from './parts.mjs'

const S = {
  ARIANE_ST27: 'https://www.arianespace.com/wp-content/uploads/2020/01/ST27-launch-kit_EN.pdf',
  FCC_LOI: 'https://fcc.report/IBFS/SAT-LOI-20160428-00041/1134939.pdf',
  EOPORTAL: 'https://www.eoportal.org/satellite-missions/oneweb',
  ARXIV_2110: 'https://arxiv.org/pdf/2110.10578',
  AIRBUS_ARROW150: 'https://airbusus.com/wp-content/uploads/2025/04/ARROW150_25.pdf',
  AMOS_2021: 'https://amostech.com/TechnicalPapers/2021/Non-Resolved-Object-Characterization/Johnson.pdf',
  ODAR_2017: 'https://cdn.arstechnica.net/wp-content/uploads/2017/10/OneWeb-Orbital-Debris-Assessment-Report.pdf',
  BUSEK_BHT350: 'https://www.busek.com/bht350',
  ALTIUS: 'https://www.prnewswire.com/news-releases/voyager-subsidiary-altius-space-machines-announces-first-launch-of-dogtags-301208066.html'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

function buildOneWeb(B) {
  const LX = 1.3, WN = 1.0, WZ = 0.65, DZ = 0.95
  // 梯形棱柱：截面在 (Y, Z) 平面，沿 X 挤出（局部系 x = 本体 Y、y = 本体 Z、z = 本体 X）
  const Fb = frame(P(0, 0, 0), [0, 1, 0], [0, 0, 1], [1, 0, 0])
  const sec = [[-WN / 2, DZ / 2], [WN / 2, DZ / 2], [WZ / 2, -DZ / 2], [-WZ / 2, -DZ / 2]]
  const g = group(B, 'bus', '平台体', 'bus')
  prism(g.mb('struct_grey'), Fb, sec, -LX / 2, LX / 2)
  // MLI：同形略大一圈（离结构面 1.5 cm）
  const secM = [[-WN / 2 - 0.012, DZ / 2 + 0.006], [WN / 2 + 0.012, DZ / 2 + 0.006], [WZ / 2 + 0.012, -DZ / 2 - 0.012], [-WZ / 2 - 0.012, -DZ / 2 - 0.012]]
  prism(g.mb('mli_gold'), Fb, secM, -LX / 2 - 0.012, LX / 2 + 0.012)
  // 背地面：白色散热面（渲染；照片未见，低置信）
  quadPts(g.mb('radiator'), P(-0.6, -0.3, -DZ / 2 - 0.02), P(0.6, -0.3, -DZ / 2 - 0.02), P(0.6, 0.3, -DZ / 2 - 0.02), P(-0.6, 0.3, -DZ / 2 - 0.02), scl(Z, -1))
  g.flush()
  B.box('bus', 100, P(0, 0, 0), P(LX / 2, 0.42, DZ / 2))
  const ZN = DZ / 2 + 0.006
  // Ku 用户天线：对地面前段（x∈[−0.6, 0.12]）两副，每副 8 根铝棒条（长 0.45 m、中心距 27 mm），逐根扇形外倾 0°…±24°
  const gK = group(B, 'ku_antennas', 'Ku 用户天线（2 副 × 8 棒条）', 'feed')
  obox(gK.mb('mli_gold'), BODY, P(-0.24, 0, ZN + 0.02), P(0.4, 0.4, 0.02))
  for (const s of [1, -1]) {
    for (let k = 0; k < 8; k++) {
      const ang = s * (3 + k * 3), yb = s * (0.08 + k * 0.027)
      const base = P(-0.24, yb, ZN + 0.04)
      const n = nrm(rotV(Z, P(1, 0, 0), ang))          // 棒条口面法向：绕 X 外倾
      const side = nrm([0, n[2], -n[1]])
      const c = madd(base, n, 0.035)
      // 棒条：0.45 × 0.022 × 0.07 m 铝型材
      const hx = P(0.225, 0, 0), hy = scl(side, 0.011), hz = scl(n, 0.035)
      const bx = gK.mb('aluminum')
      quadPts(bx, add(add(sub(c, hx), hy), hz), add(add(add(c, hx), hy), hz), add(sub(add(c, hx), hy), hz), add(sub(sub(c, hx), hy), hz), n)
      quadPts(bx, add(sub(c, hx), hy), add(add(c, hx), hy), add(add(c, hx), add(hy, scl(hz, 2))), add(sub(c, hx), add(hy, scl(hz, 2))), side)
      quadPts(bx, sub(sub(c, hx), hy), sub(add(c, hx), hy), sub(add(c, hx), sub(hy, scl(hz, 2))), sub(sub(c, hx), sub(hy, scl(hz, 2))), scl(side, -1))
      // 口面上 33 个方形辐射口（深色）
      for (let j = 0; j < 33; j++) {
        const q = madd(madd(c, P(1, 0, 0), -0.208 + j * 0.013), n, 0.0352)
        const a = scl(P(1, 0, 0), 0.0045), b = scl(side, 0.0065)
        quadPts(gK.mb('black_paint'), sub(sub(q, a), b), sub(add(q, a), b), add(add(q, a), b), add(sub(q, a), b), n)
      }
    }
  }
  gK.flush()
  B.point('ku_antennas', 12, P(-0.24, 0, ZN + 0.06))
  B.ap('ku_user_1', P(-0.24, 0.2, ZN + 0.11), Z)
  B.ap('ku_user_2', P(-0.24, -0.2, ZN + 0.11), Z)
  // Ka 关口站天线：对地面 +X 端并排两面 Ø0.32 m 抛物面，两轴万向（FCC：两面独立可转）
  for (const s of [1, -1]) {
    gimbalDish(B, { name: `ka_gateway_${s > 0 ? 1 : 2}`, title: `Ka 关口站天线 ${s > 0 ? 1 : 2}`, base: P(0.42, s * 0.22, ZN + 0.012), n: Z, look: Z, D: 0.32, fd: 0.38, postH: 0.12 })
  }
  // −X 端面：霍尔推力器（SPT-50M / BHT-350）+ DogTag 抓捕靶；背地面两台星敏（Sodern）
  const gT = group(B, 'propulsion', '电推进', 'thruster')
  addHall(gT, { exit: P(-LX / 2 - 0.05, 0, -0.05), dir: P(-1, 0, 0), R: 0.045, L: 0.07 })
  cyl(gT.mb('mli_gold'), P(-LX / 2 - 0.012, 0, -0.05), P(-LX / 2 - 0.05, 0, -0.05), 0.06, 20, false, false)
  gT.flush()
  B.point('thruster', 1.3, P(-LX / 2 - 0.04, 0, -0.05))
  B.ap('hall_thruster', P(-LX / 2 - 0.05, 0, -0.05), P(-1, 0, 0))
  const gD = group(B, 'dogtag', 'DogTag 抓捕靶', 'other')
  obox(gD.mb('black_paint'), BODY, P(-LX / 2 - 0.03, 0.26, 0.22), P(0.018, 0.05, 0.05))
  for (const [dy, dz] of [[-0.022, 0.022], [0.022, -0.022], [0, 0]]) quadPts(gD.mb('white_paint'), P(-LX / 2 - 0.049, 0.26 + dy - 0.008, 0.22 + dz - 0.008), P(-LX / 2 - 0.049, 0.26 + dy + 0.008, 0.22 + dz - 0.008), P(-LX / 2 - 0.049, 0.26 + dy + 0.008, 0.22 + dz + 0.008), P(-LX / 2 - 0.049, 0.26 + dy - 0.008, 0.22 + dz + 0.008), P(-1, 0, 0))
  gD.flush()
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  for (const sx of [1, -1]) addStarTracker(gS, { base: P(sx * 0.35, 0.12, -DZ / 2 - 0.012), dir: nrm(P(sx * 0.3, 0.3, -1)), up: P(1, 0, 0), box: [0.08, 0.08, 0.06], dB: 0.07, lB: 0.09 })
  gS.flush()
  // 太阳翼：每侧 1 块刚性板（≈1.30 × 0.95 m，收拢时贴满斜侧面），单根展开臂 ≈1.4 m；总展长 ≈6 m（AMOS 2021 估计）
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 0.43, 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 1, panelW: 1.3, panelH: 0.95, yokeLen: 1.4, yoke: 'rod', yokeD: 0.035, sadaLen: 0.06, sadaD: 0.1, t: 0.02, margin: 0.02, frameW: 0.012, frameMat: 'mli_gold', efficiency: 29, massKg: 5 })
  }
}

export const ONEWEB_MODELS = [
  { id: 'oneweb-gen1', rev: 1, family: 'oneweb', maker: 'OneWeb Satellites（Airbus）', title: 'OneWeb Gen 1', titleZh: '一网第一代', basis: 'Arrow 平台', tags: ['leo', 'comsat', 'oneweb'], aliases: ['ONEWEB', 'EUTELSAT ONEWEB'],
    massKg: F(147.5, 'kg', S.ARIANE_ST27, { quote: '5,015 kg. (147.5 kg. for each satellite)' }),
    facts: {
      massKg: F(147.5, 'kg', S.ARIANE_ST27, { quote: '5,015 kg. (147.5 kg. for each satellite)' }),
      antennas: F({ ttc: 2, ku: 2, ka: 2 }, '副', S.ARIANE_ST27, { quote: 'Two TTC omni antennas ; two Ku-band antennas ; two Ka-band antennas' }),
      kuBeams: F(16, '条', S.FCC_LOI, { quote: 'Each OneWeb satellite will have 16 nominally identical user beams, operating in Ku-band' }),
      kaSteerable: F(2, '副', S.FCC_LOI, { quote: 'two identical steerable gateway beam antennas, operating in Ka-band' }),
      bus: F('梯形截面、对地面多棱面', '', S.ARXIV_2110, { quote: 'The satellite bus is not rectangular but features angled sides and a multi-faceted nadir facing side.' }),
      envelope: F([1.0, 1.0, 1.3], 'm', S.EOPORTAL, { quote: 'a box shaped structure measuring approximately 1 m x 1 m x 1.3 m', note: '二手约数' }),
      span: F(6, 'm', S.AMOS_2021, { quote: 'The span of its solar arrays is estimated to be approximately 6 m.' }),
      thruster: F('霍尔推力器（第 15 次发射起 BHT-350）', '', S.BUSEK_BHT350),
      busSection: IMG({ nadir: 1.0, zenith: 0.65, depth: 0.95, length: 1.3 }, 'm', S.EOPORTAL, '堆叠照片端面梯形比例'),
      kaDish: IMG(0.32, 'm', S.EOPORTAL, '单面口径 ≈ 对地面框宽的 0.38')
    },
    build: buildOneWeb }
]
