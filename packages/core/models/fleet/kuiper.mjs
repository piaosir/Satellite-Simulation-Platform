// 亚马逊 Kuiper（Amazon Leo）量产星精模（2026-09-25，2025 年起发射的 KUIPER-000xx）。
//
// ★ 亚马逊从未公布展开构型。能落实的：梯形本体 + 折叠太阳翼（亚马逊 2025-05 发布）、单条长翼可绕长轴转动对日（星载相机自拍 + Mallama 2026）、
//   三块天线板发射时折叠、在轨展开成一整块对地大板且部分为镜面（arXiv 2601.07708）、霍尔推力器 + 推进剂贮箱（亚马逊）、
//   关口站用机械转动反射面 Ø0.45 m（Kuiper 技术附件）、光学星间链路；McDowell GCAT：长 1.8、「直径」0.7、翼展 5.0 m、质量 490 kg（带问号）。
//   本模型按这些描述搭外形，尺寸除上述几项外都是示意（facts 逐条标注），不冒充工程外形。
// ★ 坐标：+Z 对地、本体长轴沿 X、单翼沿 +Y；原点 = 本体几何中心。

import { F, IMG, ILL } from './sources.mjs'
import { BODY, frame, add, scl, nrm, madd, obox, prism, cyl, quadPts, patchGrid } from './kit.mjs'
import { group, wing, gimbalDish, addHall, addLaser, addStarTracker } from './parts.mjs'

const S = {
  AMAZON_2025: 'https://www.aboutamazon.com/news/innovation-at-amazon/project-kuiper-satellite-internet-first-launch',
  AMAZON_PROP: 'https://www.aboutamazon.com/news/innovation-at-amazon/amazon-project-kuiper-space-propulsion',
  GIGAZINE: 'https://gigazine.net/gsc_news/en/20250514-amazon-kuiper-satellite/',
  ARXIV_2601: 'https://arxiv.org/abs/2601.07708',
  KUIPER_TECH: 'https://cdn.geekwire.com/wp-content/uploads/2019/07/Kuiper-Technical.pdf',
  GCAT: 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

function buildKuiper(B) {
  const LX = 1.8, WN = 0.7, WZ = 0.46, D = 0.55
  const Fb = frame(P(0, 0, 0), [0, 1, 0], [0, 0, 1], [1, 0, 0])
  const g = group(B, 'bus', '平台体', 'bus')
  prism(g.mb('struct_grey'), Fb, [[-WN / 2, D / 2], [WN / 2, D / 2], [WZ / 2, -D / 2], [-WZ / 2, -D / 2]], -LX / 2, LX / 2)
  prism(g.mb('mirror_film'), Fb, [[-WN / 2 - 0.01, D / 2 + 0.004], [WN / 2 + 0.01, D / 2 + 0.004], [WZ / 2 + 0.01, -D / 2 - 0.01], [-WZ / 2 - 0.01, -D / 2 - 0.01]], -LX / 2 + 0.02, LX / 2 - 0.02)
  g.flush()
  B.box('bus', 300, P(0, 0, 0), P(LX / 2, 0.3, D / 2))
  // 三块天线板在轨展开成一整块对地大板（中板贴本体、两侧板翻出），部分镜面；板上用户相控阵口面
  const gA = group(B, 'antenna_panel', '对地天线大板（三折展开）', 'feed')
  const zp = D / 2 + 0.03
  for (const [yc, w] of [[0, 0.72], [-0.74, 0.72], [0.74, 0.72]]) {
    obox(gA.mb('struct_grey'), BODY, P(0, yc, zp), P(LX / 2, w / 2 - 0.01, 0.02))
    prism(gA.mb('mirror_film'), frame(P(0, yc, zp + 0.02), [1, 0, 0], [0, 1, 0], [0, 0, 1]), [[-LX / 2 + 0.02, -w / 2 + 0.02], [LX / 2 - 0.02, -w / 2 + 0.02], [LX / 2 - 0.02, w / 2 - 0.02], [-LX / 2 + 0.02, w / 2 - 0.02]], 0, 0.003, { cap0: false })
  }
  for (const [x, y] of [[-0.45, -0.74], [0.45, -0.74], [0, 0.74]]) {
    const Fa = frame(P(x, y, zp + 0.023), [1, 0, 0], [0, 1, 0], [0, 0, 1])
    prism(gA.mb('radome'), Fa, [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], 0, 0.02)
    patchGrid(gA.mb('white_paint'), Fa, { nx: 8, ny: 8, px: 0.07, py: 0.07, w: 0.045, h: 0.045, t: 0.005, z0: 0.02 })
  }
  for (const s of [1, -1]) for (const x of [-0.6, 0, 0.6]) cyl(gA.mb('dark_metal'), P(x, s * 0.37, zp), P(x + 0.08, s * 0.37, zp), 0.018, 10, true, true)
  gA.flush()
  B.point('antenna_panel', 60, P(0, 0, zp))
  B.ap('user_array_1', P(-0.45, -0.74, zp + 0.05), Z); B.ap('user_array_2', P(0.45, -0.74, zp + 0.05), Z); B.ap('user_array_3', P(0, 0.74, zp + 0.05), Z)
  // 关口站机械转动反射面 Ø0.45 m：本体两端各一（量产星个数未公开，按原型星写法取 2 + 手递 1 中的 2 副示意）
  for (const [s, name] of [[1, 'gateway_1'], [-1, 'gateway_2']]) {
    gimbalDish(B, { name, title: `关口站反射面 ${s > 0 ? 1 : 2}`, base: P(s * (LX / 2 + 0.01), 0, 0.12), n: P(s, 0, 0), look: nrm(P(s * 0.25, 0, 1)), D: 0.45, fd: 0.35, postH: 0.12, mat: 'white_paint' })
  }
  // 光学星间链路终端（个数未公开，示意两台）、霍尔推力器（−X 端）、星敏
  const gL = group(B, 'lasers', '光学星间链路终端', 'feed')
  for (const s of [1, -1]) {
    const b = P(s * 0.6, -0.12, -D / 2 - 0.01), look = nrm(P(s, 0, -0.5))
    addLaser(gL, { base: b, n: P(0, 0, -1), look, D: 0.08, bodyMat: 'black_paint', baseMat: 'dark_metal' })
    B.ap(`laser_${s > 0 ? 1 : 2}`, madd(b, look, 0.2), look)
  }
  gL.flush()
  const gT = group(B, 'propulsion', '霍尔推力器', 'thruster')
  addHall(gT, { exit: P(-LX / 2 - 0.08, 0.12, -0.08), dir: P(-1, 0, 0), R: 0.04, L: 0.06 })
  gT.flush()
  B.ap('hall_thruster', P(-LX / 2 - 0.08, 0.12, -0.08), P(-1, 0, 0))
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  addStarTracker(gS, { base: P(0.1, 0.12, -D / 2 - 0.01), dir: nrm(P(0, 0.4, -1)), up: P(1, 0, 0), box: [0.07, 0.07, 0.05], dB: 0.06, lB: 0.08 })
  gS.flush()
  // 单条长翼（≥5 段，绕长轴转动对日），从本体 +Y 侧背地棱伸出；GCAT 翼展 5.0 m
  wing(B, { name: 'wing_+Y', title: '太阳翼', root: P(0, WZ / 2 + 0.01, -D / 2 + 0.05), span: P(0, 1, 0), normal: P(0, 0, -1),
    n: 6, panelW: 1.6, panelH: 0.68, gap: 0.03, yokeLen: 0.12, yoke: 'rod', yokeD: 0.03, sadaLen: 0.05, sadaD: 0.08, t: 0.02, margin: 0.02, frameW: 0.012, backMat: 'kapton_black', efficiency: 30, massKg: 18 })
}

export const KUIPER_MODELS = [
  { id: 'kuiper', rev: 1, family: 'kuiper', maker: 'Amazon', title: 'Amazon Leo (Kuiper)', titleZh: 'Kuiper（Amazon Leo）量产星', basis: '外形按亚马逊公开描述与星载自拍示意', tags: ['leo', 'comsat', 'kuiper'], aliases: ['KUIPER', 'AMAZON LEO', 'PROJECT KUIPER'],
    massKg: F(490, 'kg', S.GCAT, { quote: 'Kuiper-00008 … Mass 490 ?', note: 'McDowell 带问号；FCC 反推上限 571 kg' }),
    facts: {
      massKg: F(490, 'kg', S.GCAT, { quote: 'Kuiper-00008 … Mass 490 ?' }),
      shape: F('梯形本体 + 折叠太阳翼', '', S.GIGAZINE, { quote: 'Kuiper is trapezoidal in shape and will launch with a folding solar array' }),
      antennaPanel: F('三块天线板展开成一整块对地大板', '', S.ARXIV_2601, { quote: 'three antenna panels are folded at launch and deploy to form a large, nadir-facing panel' }),
      gateway: F(0.45, 'm', S.KUIPER_TECH, { quote: 'Downlink 17.7 GHz @ Nadir, 0.45 m, 2.8 Degree HPBW' }),
      thruster: F('霍尔推力器', '', S.AMAZON_PROP, { quote: 'a hall-effect thruster that propels the satellite' }),
      gcat: F({ length: 1.8, diameter: 0.7, span: 5.0 }, 'm', S.GCAT, { quote: 'Length 1.8 ? Diameter 0.7 ? Span 5.0 ?' }),
      wing: IMG('单条长翼、≥5 段、绕长轴转动', '', S.ARXIV_2601, '星载相机自拍与视频截图')
    },
    build: buildKuiper }
]
