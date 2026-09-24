// O3b 精模（2026-09-25）：第一代（Thales Alenia Space，ELiTeBus，PFM / FM2–FM20，MEO 8062 km）与 mPOWER（Boeing 702X，F1–F13）。
//
// ★ 坐标：+Z 对地、±Y 太阳翼、+X 补全；原点 = 本体几何中心。
// ★ 第一代：Arianespace 发射手册给整星 7.72 × 3.2 × 1.7 m（未标轴向：按「翼展 × 本体长 × 对地面宽」解读）、700 kg；
//   梯形截面长盒（Arianespace：trapezoidal-shaped）；对地面 12 副可转 Ka 反射面（O3b：Twelve fully steerable antennas），
//   按 2012 ITU 渲染逐个数为 2 行 × 6 列交错、沿本体长轴排列；实物照片碟面黑色（碳纤维）、金色 MLI 包覆的万向座；全身金色 MLI；
//   两翼各 3 块长条板（板长边平行本体长轴）。碟径未公开，按图 ≈0.55 m。
// ★ mPOWER：702X 数字波束成形相控阵，对地面两块正八边形口面（大发小收，按图 ≈0.8 / 0.6 m）、银白遮光膜、古铜色边框、周边黑色 MLI；
//   全电推（氙）；每翼 4 块近方形板，翼展 ≈27 m（McDowell GCAT，带问号）；干重 1900 kg（SES）。本体尺寸只能按堆叠照片估。

import { F, IMG, ILL } from './sources.mjs'
import { MB, BODY, frame, add, sub, scl, nrm, madd, bevelBox, obox, prism, ngon, cyl, cone, disc, ring, quadPts } from './kit.mjs'
import { group, wing, skinBox, fixedDish, nozzle, addHall, addStarTracker } from './parts.mjs'

const S = {
  ARIANE_VS22: 'http://web.archive.org/web/20230706000559/https://www.arianespace.com/wp-content/uploads/2015/09/VS22-launchkit-EN.pdf',
  ARIANE_MISSION: 'http://web.archive.org/web/20230706013422/https://www.arianespace.com/mission-update/',
  ARIANE_LIFTOFF: 'http://web.archive.org/web/20240528044513/https://www.arianespace.com/wp-content/uploads/2014/12/VS10-launchkit-EN.pdf',
  O3B_SV: 'http://web.archive.org/web/20090219201829/http://o3bnetworks.com/spacevehicle.html',
  ITU_2012: 'https://www.itu.int/dms_pub/itu-r/md/12/iturka.band/c/R12-ITURKA.BAND-C-0010!!PDF-E.pdf',
  SKYROCKET_O3B: 'https://space.skyrocket.de/doc_sdat/o3b.htm',
  SES_MPOWER: 'https://www.ses.com/sites/default/files/2022-07/O3b-mPOWER-Satellite-Technology.pdf',
  BOEING_MPOWER: 'https://boeing.mediaroom.com/news-releases-statements?item=131182',
  GCAT: 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv',
  SFN_2022: 'https://spaceflightnow.com/2022/12/15/first-o3b-mpower-broadband-satellites-set-for-launch/'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

// ───────────────────────────── 第一代 ─────────────────────────────
function buildGen1(B) {
  const LX = 3.2, WN = 1.7, WZ = 1.0, D = 1.2
  const Fb = frame(P(0, 0, 0), [0, 1, 0], [0, 0, 1], [1, 0, 0])      // 截面在 (Y, Z)，沿 X 挤出
  const g = group(B, 'bus', '平台体', 'bus')
  prism(g.mb('struct_grey'), Fb, [[-WN / 2, D / 2], [WN / 2, D / 2], [WZ / 2, -D / 2], [-WZ / 2, -D / 2]], -LX / 2, LX / 2)
  prism(g.mb('mli_gold'), Fb, [[-WN / 2 - 0.012, D / 2 + 0.006], [WN / 2 + 0.012, D / 2 + 0.006], [WZ / 2 + 0.012, -D / 2 - 0.012], [-WZ / 2 - 0.012, -D / 2 - 0.012]], -LX / 2 - 0.012, LX / 2 + 0.012)
  // 对地面外缘平板檐（照片）+ 端面两个灰色矩形盒
  prism(g.mb('mli_gold'), frame(P(0, 0, D / 2 + 0.006), [1, 0, 0], [0, 1, 0], [0, 0, 1]), [[-LX / 2 - 0.05, -WN / 2 - 0.08], [LX / 2 + 0.05, -WN / 2 - 0.08], [LX / 2 + 0.05, WN / 2 + 0.08], [-LX / 2 - 0.05, WN / 2 + 0.08]], 0, 0.02)
  for (const y of [-0.3, 0.3]) obox(g.mb('struct_light'), BODY, P(LX / 2 + 0.06, y, 0), P(0.05, 0.14, 0.18))
  g.flush()
  B.box('bus', 500, P(0, 0, 0), P(LX / 2, 0.68, D / 2))
  const ZN = D / 2 + 0.026
  // 12 副可转 Ka 反射面：2 行 × 6 列交错，黑色碟面 + 金色 MLI 包覆的万向座（每副单独一个挂点；不设关节，节点数克制）
  const gD = group(B, 'ka_dishes', 'Ka 可转反射面天线 × 12', 'reflector')
  let k = 0
  for (let i = 0; i < 6; i++) for (const [row, dx] of [[-1, 0], [1, 0.25]]) {
    const x = -1.35 + i * 0.5 + dx, y = row * 0.42
    if (x > 1.45) continue
    const base = P(x, y, ZN)
    cyl(gD.mb('mli_gold'), base, add(base, P(0, 0, 0.18)), 0.09, 16, false, true)
    const look = nrm(P(0, row * 0.12, 1))
    fixedDish(gD, add(base, P(0, 0, 0.24)), look, { D: 0.55, fd: 0.36, reflMat: 'carbon', strutMat: 'mli_gold', feedMat: 'white_paint', na: 28, nr: 6 })
    k++
    B.ap(`ka_${k}`, madd(add(base, P(0, 0, 0.24)), look, 0.2), look)
  }
  // 对地面中部两个白帽圆柱（测控 / 全向天线，未证实）
  for (const y of [-0.12, 0.12]) { cyl(gD.mb('mli_gold'), P(0, y, ZN), P(0, y, ZN + 0.25), 0.05, 16, false, false); cyl(gD.mb('white_paint'), P(0, y, ZN + 0.25), P(0, y, ZN + 0.32), 0.055, 16, false, true) }
  gD.flush()
  B.point('ka_dishes', 60, P(0, 0, ZN + 0.25))
  const gT = group(B, 'thrusters', '肼推力器（8 × 1 N）', 'thruster')
  for (const sy of [1, -1]) for (const sz of [1, -1]) nozzle(gT.mb('titanium'), P(-LX / 2 - 0.012, sy * 0.35, sz * 0.35), nrm(P(-1, sy * 0.2, sz * 0.2)), 0.016, 0.05)
  gT.flush()
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  for (const x of [0.8, -0.8]) addStarTracker(gS, { base: P(x, 0.2, -D / 2 - 0.012), dir: nrm(P(0, 0.3, -1)), up: P(1, 0, 0), box: [0.1, 0.1, 0.07], dB: 0.09, lB: 0.12 })
  gS.flush()
  // 两翼各 3 块长条板（长边平行本体长轴 X），翼展 7.72 m（Arianespace）；翼根在斜侧面中部
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 0.68, -0.05), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 3, panelW: 2.9, panelH: 0.86, gap: 0.04, yokeLen: 0.44, yoke: 'V', yokeD: 0.04, sadaLen: 0.08, sadaD: 0.14, t: 0.025, margin: 0.025, frameW: 0.016, hingeR: 0.012, efficiency: 28, massKg: 18 })
  }
}

// ───────────────────────────── mPOWER（Boeing 702X） ─────────────────────────────
function buildMpower(B) {
  const h = P(1.1, 0.65, 1.5), ZN = h[2]          // 对地面 2.2（X）× 1.3（Y），深 3.0 m（按堆叠照片估）
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, P(0, 0, 0), h, 0.03)
  skinBox(g, BODY, P(0, 0, 0), h, { '+x': 'mli_black', '-x': 'mli_black', '+y': 'radiator', '-y': 'radiator', '+z': 'mli_black', '-z': 'mli_black' })
  // 背地面中央矩形格栅窗口（功能未知）
  const gz = -ZN - 0.02
  for (let i = -3; i <= 3; i++) obox(g.mb('struct_light'), BODY, P(i * 0.1, 0, gz), P(0.012, 0.3, 0.01))
  for (let j = -2; j <= 2; j++) obox(g.mb('struct_light'), BODY, P(0, j * 0.12, gz), P(0.35, 0.012, 0.01))
  g.flush()
  B.box('bus', 1600, P(0, 0, 0), h)
  // 两块正八边形数字相控阵口面（大发小收——推断）：银白遮光膜 + 古铜边框
  const gA = group(B, 'phased_arrays', 'Ka 数字相控阵', 'feed')
  for (const [x, R, name] of [[-0.5, 0.42, 'tx_array'], [0.58, 0.32, 'rx_array']]) {
    const Fa = frame(P(x, 0, ZN + 0.012), [1, 0, 0], [0, 1, 0], [0, 0, 1])
    prism(gA.mb('copper'), Fa, ngon(8, R + 0.05, 22.5), 0, 0.05)
    prism(gA.mb('mli_silver'), Fa, ngon(8, R, 22.5), 0.05, 0.065, { cap0: false })
    B.ap(name, P(x, 0, ZN + 0.08), Z)
  }
  gA.flush()
  B.point('phased_arrays', 120, P(0, 0, ZN + 0.04))
  // 全电推（氙）：背地面两台霍尔 / 离子推力器（位置未公开，示意）
  const gT = group(B, 'propulsion', '电推进（氙）', 'thruster')
  for (const s of [1, -1]) addHall(gT, { exit: P(s * 0.75, 0.4, -ZN - 0.1), dir: nrm(P(s * 0.3, 0, -1)), R: 0.08, L: 0.1 })
  gT.flush()
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  for (const s of [1, -1]) addStarTracker(gS, { base: P(s * 0.8, -0.4, -ZN - 0.012), dir: nrm(P(s * 0.3, -0.3, -1)), up: P(1, 0, 0), box: [0.12, 0.12, 0.08], dB: 0.1, lB: 0.14 })
  gS.flush()
  // 每翼 4 块近方形板（波音 / SES 渲染），翼展 ≈27 m（GCAT）
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 0.662, 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 4, panelW: 2.9, panelH: 2.85, gap: 0.06, yokeLen: 1.0, yoke: 'V', yokeD: 0.06, sadaLen: 0.18, sadaD: 0.25, t: 0.03, margin: 0.03, frameW: 0.02, hingeR: 0.016, efficiency: 30, massKg: 80 })
  }
}

export const O3B_MODELS = [
  { id: 'o3b-gen1', rev: 1, family: 'o3b', maker: 'Thales Alenia Space', title: 'O3b (Gen 1)', titleZh: 'O3b 第一代', basis: 'ELiTeBus，梯形长盒', tags: ['meo', 'comsat', 'o3b'], aliases: ['O3B'],
    massKg: F(700, 'kg', S.ARIANE_LIFTOFF, { quote: 'Total mass at lift-off 700kg (per satellite)' }),
    facts: {
      massKg: F(700, 'kg', S.ARIANE_LIFTOFF, { quote: 'Total mass at lift-off 700kg (per satellite)' }),
      dims: F([7.72, 3.2, 1.7], 'm', S.ARIANE_VS22, { quote: 'DIMENSIONS 7.72 m. x 3.2 m. x 1.7 m.', note: '未标轴向：按翼展 × 本体长 × 对地面宽解读' }),
      shape: F('梯形截面', '', S.ARIANE_MISSION, { quote: 'The trapezoidal-shaped Ka-band relay platforms' }),
      antennas: F(12, '副', S.O3B_SV, { quote: 'Twelve (12) fully steerable antennas ensure an optimized connection' }),
      layout: IMG('2 行 × 6 列交错', '', S.ITU_2012, '2012 ITU 渲染逐个数'),
      dish: IMG(0.55, 'm', S.ITU_2012, '碟径未公开，按渲染比例')
    },
    build: buildGen1 },
  { id: 'o3b-mpower', rev: 1, family: 'o3b', maker: 'Boeing', title: 'O3b mPOWER', titleZh: 'O3b mPOWER', basis: 'Boeing 702X', tags: ['meo', 'comsat', 'o3b'], aliases: ['O3B MPOWER', 'MPOWER'],
    massKg: F(1900, 'kg', S.SES_MPOWER, { quote: '1,900kg dry mass' }),
    facts: {
      massKg: F(1900, 'kg', S.SES_MPOWER, { quote: '1,900kg dry mass', note: 'Gunter 记 1700 kg' }),
      platform: F('702X + Spectrolab 太阳翼', '', S.BOEING_MPOWER, { quote: 'The satellites combine Boeing’s flight-proven 702 platform, Boeing subsidiary Spectrolab’s custom-designed solar arrays' }),
      propulsion: F('全电推（氙）', '', S.SFN_2022, { quote: 'The xenon will fuel the low-thrust, but highly efficient plasma thrusters on each satellite.' }),
      span: F(27, 'm', S.GCAT, { quote: 'O3b mPOWER F1 … Span 27.0 ?', note: 'McDowell 带问号' }),
      body: IMG([2.2, 1.3, 3.0], 'm', S.SFN_2022, '堆叠照片：对地面宽高比 1.7；按适配环口径反推'),
      apertures: IMG([0.8, 0.6], 'm', S.SFN_2022, '实物照片：两块正八边形口面')
    },
    build: buildMpower }
]
