// 全球星精模（2026-09-25）：第二代（Thales Alenia Space，ELiTeBus-1000，M073–M097）、第一代在轨备份（SSL LS-400，M065–M072，2007 年发射）、
// 第二代补网星（MDA 总包、Rocket Lab 平台，M098 起，2026 年发射）。
//
// ★ 公开资料很少：二代只有「梯形截面、两翼、约 700 kg、2.4 kW、对地面装 C 波段关口站天线与 L / S 波段用户相控阵」（Starsem 发射资料）；
//   一代只有「梯形、两翼、450 kg、1100 W、本体安装相控阵」；补网星只有 500 kg 与照片里的 2 台 Busek 霍尔推力器。
//   本体尺寸按发射整流罩装星几何与照片比例估（IMG），翼板尺寸按功率反推（ILL），在 facts 里逐条标注——型号区分到位、细部是示意。
// ★ 坐标：+Z 对地、±Y 为本体长轴 = 太阳翼伸出方向（渲染：翼沿长轴从两端伸出）、+X 补全；原点 = 本体几何中心。

import { F, IMG, ILL } from './sources.mjs'
import { MB, BODY, frame, add, sub, scl, nrm, madd, obox, prism, ngon, cyl, cone, disc, ring, quadPts, patchGrid } from './kit.mjs'
import { group, wing, addHall, addStarTracker, nozzle } from './parts.mjs'

const S = {
  STARSEM_G2: 'http://www.starsem.com/news/images/Globalstar2_presskit.pdf',
  RSW_G2: 'https://www.russianspaceweb.com/globalstar2.html',
  SKYROCKET_G1: 'https://space.skyrocket.de/doc_sdat/globalstar.htm',
  ROCKETLAB_MDA: 'https://rocketlabcorp.com/updates/rocket-lab-selected-by-mda-to-design-and-build-17-spacecraft-buses-for-globalstar/',
  FCC_2R: 'https://docs.fcc.gov/public/attachments/DA-24-825A1.pdf'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

/**
 * o = { Ly（长轴）, Wn（对地面宽）, Wz（背地面宽）, D（深）, panels:{n, w, h}, yoke, arrays:'hex'|'patch', thrusters:'hyd'|'hall', skin }
 */
function buildGS(B, o) {
  const { Ly, Wn, Wz, D } = o
  // 梯形截面在 (X, Z) 平面、沿 Y 挤出（局部 x = 本体 X、y = 本体 Z、z = 本体 −Y… 取 z = 本体 Y 保持右手：x = Z × Y? 直接用 x=X, y=Z 需 z = X × Z = −Y）
  const Fb = frame(P(0, 0, 0), [1, 0, 0], [0, 0, 1], [0, -1, 0])
  const sec = [[-Wn / 2, D / 2], [Wn / 2, D / 2], [Wz / 2, -D / 2], [-Wz / 2, -D / 2]]
  const g = group(B, 'bus', '平台体', 'bus')
  prism(g.mb('struct_grey'), Fb, sec, -Ly / 2, Ly / 2)
  const secM = [[-Wn / 2 - 0.012, D / 2 + 0.006], [Wn / 2 + 0.012, D / 2 + 0.006], [Wz / 2 + 0.012, -D / 2 - 0.012], [-Wz / 2 - 0.012, -D / 2 - 0.012]]
  prism(g.mb(o.skin || 'mli_gold'), Fb, secM, -Ly / 2 + 0.03, Ly / 2 - 0.03)
  // 斜侧面上的 OSR 散热面（±X 两侧中段）
  for (const s of [1, -1]) {
    const a = [s * (Wn / 2 + 0.02), D / 2 - 0.1], b = [s * (Wz / 2 + 0.02), -D / 2 + 0.1]
    const nx = s * (D), nz = (Wn - Wz) / 2, nl = Math.hypot(nx, nz)
    const n = P(nx / nl, 0, nz / nl)
    quadPts(g.mb('radiator'), P(a[0], -Ly * 0.3, a[1]), P(a[0], Ly * 0.3, a[1]), P(b[0], Ly * 0.3, b[1]), P(b[0], -Ly * 0.3, b[1]), n)
  }
  g.flush()
  B.box('bus', 400, P(0, 0, 0), P(Wn / 2, Ly / 2, D / 2))
  const ZN = D / 2 + 0.006
  // 对地面：L 波段接收阵（大单元）与 S 波段发射阵（小单元）两块六角阵面沿长轴并列；两端 C 波段关口站喇叭
  const gA = group(B, 'user_arrays', 'L / S 波段用户相控阵', 'feed')
  const rA = Math.min(Wn * 0.46, Ly * 0.2)
  for (const [yc, pitch, el, band] of [[-Ly * 0.22, 0.13, 0.09, 'L'], [Ly * 0.18, 0.085, 0.06, 'S']]) {
    const Fa = frame(P(0, yc, ZN), [1, 0, 0], [0, 1, 0], [0, 0, 1])
    prism(gA.mb('radome'), Fa, ngon(6, rA, 30), 0, 0.04)
    for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {
      const x = (i + (j % 2 ? 0.5 : 0)) * pitch, y = j * pitch * 0.866
      if (Math.hypot(x, y) > rA * 0.82) continue
      cyl(gA.mb('white_paint'), add(Fa.o, P(x, y, 0.04)), add(Fa.o, P(x, y, 0.05)), el / 2, 10, false, true)
    }
    B.ap(`${band}_band_array`, P(0, yc, ZN + 0.06), Z)
  }
  gA.flush()
  B.point('user_arrays', 40, P(0, 0, ZN + 0.03))
  const gC = group(B, 'c_band', 'C 波段关口站天线', 'feed')
  for (const s of [1, -1]) {
    const b = P(Wn * 0.3, s * (Ly / 2 - 0.2), ZN)
    cone(gC.mb('aluminum'), b, 0.05, add(b, P(0, 0, 0.22)), 0.12, 24, true, false)
    cone(gC.mb('black_paint'), add(b, P(0, 0, 0.01)), 0.045, add(b, P(0, 0, 0.218)), 0.114, 24, false, false)
  }
  gC.flush()
  B.ap('c_band_feeder', P(Wn * 0.3, Ly / 2 - 0.2, ZN + 0.22), Z)
  // 推进
  const gT = group(B, 'thrusters', o.thrusters === 'hall' ? '霍尔推力器（Busek）' : '肼推力器', 'thruster')
  if (o.thrusters === 'hall') for (const s of [1, -1]) addHall(gT, { exit: P(s * 0.18, -Ly / 2 - 0.08, -0.1), dir: P(0, -1, 0), R: 0.04, L: 0.06 })
  else for (const sx of [1, -1]) for (const sz of [1, -1]) nozzle(gT.mb('titanium'), P(sx * Wz * 0.35, -Ly / 2 - 0.012, sz * D * 0.3), nrm(P(sx * 0.2, -1, sz * 0.2)), 0.018, 0.06)
  gT.flush()
  const gS = group(B, 'star_trackers', '姿态敏感器', 'sensor')
  addStarTracker(gS, { base: P(0, Ly * 0.3, -D / 2 - 0.012), dir: nrm(P(0.3, 0.3, -1)), up: P(0, 1, 0), box: [0.08, 0.08, 0.06], dB: 0.07, lB: 0.09 })
  gS.flush()
  // 太阳翼：沿长轴从两端伸出、单轴对日（Starsem：自动跟踪太阳）
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * (Ly / 2 + 0.01), 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: o.panels.n, panelW: o.panels.w, panelH: o.panels.h, gap: 0.04, yokeLen: o.yoke, yoke: o.yokeKind || 'V', yokeD: 0.04, yokeMat: o.yokeMat || 'carbon',
      sadaLen: 0.1, sadaD: 0.14, t: 0.025, margin: 0.025, frameW: 0.016, hingeR: 0.012, backMat: o.panelBack || 'solar_substrate', efficiency: 28, massKg: o.wingKg })
  }
}

const common = { family: 'globalstar', tags: ['leo', 'comsat', 'globalstar'] }
export const GLOBALSTAR_MODELS = [
  { ...common, id: 'globalstar-2', rev: 1, maker: 'Thales Alenia Space', title: 'Globalstar-2', titleZh: '全球星二代', basis: 'ELiTeBus-1000，梯形本体', aliases: ['GLOBALSTAR 2'],
    massKg: F(700, 'kg', S.STARSEM_G2, { quote: 'Each second-generation Globalstar satellite weighs approximately 700 kg, offers power of 2.4 kW' }),
    facts: {
      massKg: F(700, 'kg', S.STARSEM_G2, { quote: 'Each second-generation Globalstar satellite weighs approximately 700 kg' }),
      shape: F('梯形本体、两副太阳翼', '', S.STARSEM_G2, { quote: 'a trapezoidal main body with two solar arrays' }),
      antennas: F('C 波段关口站 + L / S 波段用户天线', '', S.STARSEM_G2, { quote: 'There are C-band antennas for communications with Globalstar gateways, and L- and S-band antennas' }),
      body: IMG([1.3, 2.7, 1.1], 'm', S.RSW_G2, 'Soyuz 整流罩内 6 星装星几何 + 对地面长宽比 ≈2.1'),
      panels: ILL({ perWing: 3, size: [1.3, 1.5] }, 'm', '按 2.4 kW 反推面积、渲染每翼 3 块')
    },
    build: (B) => buildGS(B, { Ly: 2.7, Wn: 1.3, Wz: 0.8, D: 1.1, panels: { n: 3, w: 1.3, h: 1.5 }, yoke: 0.5, wingKg: 22 }) },
  { ...common, id: 'globalstar-1', rev: 1, maker: 'Space Systems/Loral', title: 'Globalstar-1', titleZh: '全球星一代', basis: 'LS-400（2007 年发射的在轨备份）', aliases: ['GLOBALSTAR 1'],
    massKg: F(450, 'kg', S.SKYROCKET_G1, { quote: 'Each satellite weighs 450 kg, with a dry mass of 350 kg' }),
    facts: {
      massKg: F(450, 'kg', S.SKYROCKET_G1, { quote: 'Each satellite weighs 450 kg, with a dry mass of 350 kg' }),
      shape: F('梯形本体、两副太阳翼、本体安装相控阵', '', S.SKYROCKET_G1, { quote: 'The payload antennas are phased arrays mounted on the satellite body.' }),
      body: ILL([1.0, 1.9, 0.9], 'm', '按 450 kg 级与梯形构型示意'),
      panels: IMG({ perWing: 4 }, '', S.SKYROCKET_G1, '渲染中每翼 4 块板串联、白色矩形框式轭')
    },
    build: (B) => buildGS(B, { Ly: 1.9, Wn: 1.0, Wz: 0.62, D: 0.9, panels: { n: 4, w: 0.95, h: 1.05 }, yoke: 0.45, yokeKind: 'trap', yokeMat: 'white_paint', wingKg: 14 }) },
  { ...common, id: 'globalstar-2r', rev: 1, maker: 'MDA / Rocket Lab', title: 'Globalstar-2 Replacement', titleZh: '全球星补网星', basis: 'MDA 总包、Rocket Lab 平台（外形按二代布局示意）', aliases: ['GLOBALSTAR 2R'],
    massKg: F(500, 'kg', S.ROCKETLAB_MDA, { quote: 'All 17 of the 500kg spacecraft will be designed and manufactured at Rocket Lab' }),
    facts: {
      massKg: F(500, 'kg', S.ROCKETLAB_MDA, { quote: 'All 17 of the 500kg spacecraft' }),
      yoke: F('铝制轭', '', S.FCC_2R, { quote: 'no longer including titanium yoke components, but instead an aluminum component' }),
      thrusters: IMG('2 台 Busek 霍尔推力器', '', S.ROCKETLAB_MDA, 'MDA 照片：红色保护罩印有 BUSEK'),
      body: ILL([1.1, 2.2, 0.9], 'm', '外形未公开，按二代布局与 500 kg 量级示意')
    },
    build: (B) => buildGS(B, { Ly: 2.2, Wn: 1.1, Wz: 0.7, D: 0.9, panels: { n: 4, w: 1.1, h: 1.1 }, yoke: 0.4, thrusters: 'hall', panelBack: 'mli_silver', yokeMat: 'aluminum', wingKg: 16 }) }
]
