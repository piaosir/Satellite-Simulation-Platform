// 伽利略精模（2026-09-25）：IOV（GSAT01xx）、FOC（GSAT02xx，含第三批——官方只改了内部单机，外形同 FOC）。
//
// ★ 坐标：IGS 本体系（+Z 指地、Y = 太阳翼转轴、+X = 动偏时的向阳面；x_IGS = −X_厂家、y_IGS = −Y_厂家），原点 = 卫星质心——
//   欧洲 GNSS 服务中心（GSC）《Galileo Satellite Metadata》给了逐星质心、导航天线参考点、角反射器相位中心（厂家机械系），
//   研究稿换算到 IGS 系后按盒中心落位，这里再整体平移「−质心」，模型原点即质心（def.comTarget = [0,0,0]）。
// ★ 各面热控按 GSC 表逐面取（A = 黑色碳 Kapton MLI α0.93、B = 镀锗黑 Kapton（导航天线遮阳罩）、C = OSR 镜面、D = Kapton HN、E = 电池片）：
//   向阳面（+X）全黑 MLI；钟面（−X）以 OSR 镜为主；±Y 大片 OSR；对地面黑 MLI + 导航天线黑色遮阳罩（银色包边）；背地面黑 MLI + OSR。
//   ESA 早期美术图是金色 MLI + 三角轭——飞行件照片是黑色，按飞行件画。

import { F, IMG } from './sources.mjs'
import { BODY, frame, add, sub, scl, nrm, madd, bevelBox, obox, prism, ngon, cyl, cone, disc, ring, quadPts } from './kit.mjs'
import { group, wing, skinBox, helixElement, nozzle, addLRA } from './parts.mjs'
import { frustum } from '../meshKit.mjs'

const S = {
  GSC_META: 'https://www.gsc-europa.eu/support-to-developers/galileo-satellite-metadata',
  ESA_FACTS: 'https://www.esa.int/Applications/Satellite_navigation/Galileo/Facts_and_figures',
  ESA_FACE: 'https://www.esa.int/ESA_Multimedia/Images/2022/06/The_face_of_Galileo',
  ESA_12THINGS: 'https://www.esa.int/Applications/Satellite_navigation/12_things_you_never_knew_about_Galileo',
  EOPORTAL_FOC: 'https://www.eoportal.org/satellite-missions/galileo-foc',
  ILRS_FOC_LRA: 'https://ilrs.gsfc.nasa.gov/docs/2014/Galileo_FOC_LRA_additional_information_sign.pdf',
  ILRS_IOV: 'https://ilrs.gsfc.nasa.gov/missions/satellite_missions/current_missions/ga01_reflector.html',
  MONTENBRUCK_2015: 'https://elib.dlr.de/97732/1/ASR_151015_GNSS_SatGeomAtt.pdf',
  AIRBORNE: 'https://www.airborne.com/new-contract-airborne-to-supply-48-solar-array-panels-for-galileo/'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

/**
 * 伽利略通用骨架。o：
 *   box [X,Y,Z]、com（相对盒中心，IGS 系）、nav {x, y, D}、sar {x, plate:[wx, wy], kind:'foc'|'iov'}、lra {x, y, plate:[a,b], nx, ny, r}、
 *   cband {x, y}、earthSensors [[x,y],…]、wingYoke、span
 */
function buildGalileo(B, o) {
  const [X, Y, Zh] = o.box, hb = P(X / 2, Y / 2, Zh / 2)
  const c0 = scl(o.com, -1)                    // 盒中心在质心原点下的位置
  const at = (x, y, z) => add(c0, P(x, y, z))  // 研究稿给的「相对盒中心」坐标 → 质心原点坐标
  const ZN = hb[2]
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, c0, hb, 0.02)
  skinBox(g, BODY, c0, hb, { '+x': 'mli_black', '-x': 'radiator', '+y': 'mli_black', '-y': 'mli_black', '+z': 'mli_black', '-z': 'mli_black' })
  // ±Y 面大片 OSR（GSC：OSR 占 ±Y 面积的 55–65 %）：面中部一整块，翼根 SADM 周围留黑 MLI
  for (const s of [1, -1]) {
    const y = c0[1] + s * (hb[1] + 0.016)
    for (const [x0, x1] of [[-hb[0] + 0.06, -0.22], [0.22, hb[0] - 0.06]]) {
      quadPts(g.mb('radiator'), at(x0, 0, -hb[2] + 0.07).map((v, k) => (k === 1 ? y : v)), at(x1, 0, -hb[2] + 0.07).map((v, k) => (k === 1 ? y : v)),
        at(x1, 0, hb[2] - 0.07).map((v, k) => (k === 1 ? y : v)), at(x0, 0, hb[2] - 0.07).map((v, k) => (k === 1 ? y : v)), P(0, s, 0))
    }
  }
  // 背地面：OSR 块 + 分离面四个接口座
  quadPts(g.mb('radiator'), at(-0.9, -0.35, -ZN - 0.016), at(0.2, -0.35, -ZN - 0.016), at(0.2, 0.35, -ZN - 0.016), at(-0.9, 0.35, -ZN - 0.016), scl(Z, -1))
  for (const sx of [1, -1]) for (const sy of [1, -1]) cyl(g.mb('titanium'), at(sx * (hb[0] * 0.64), sy * (hb[1] * 0.9), -ZN - 0.012), at(sx * (hb[0] * 0.64), sy * (hb[1] * 0.9), -ZN - 0.06), 0.035, 14, false, true)
  // 向阳面（+X）一角的琥珀色 Kapton 补片（飞行件照片）
  quadPts(g.mb('mli_gold'), at(hb[0] + 0.018, -hb[1] + 0.05, 0.05), at(hb[0] + 0.018, -0.15, 0.05), at(hb[0] + 0.018, -0.15, hb[2] - 0.05), at(hb[0] + 0.018, -hb[1] + 0.05, hb[2] - 0.05), P(1, 0, 0))
  g.flush()
  B.box('bus', 600, c0, hb)
  // 推力器：向阳面四角各一对斜置 1 N 肼推力器（2 × 4，eoPortal）
  const gT = group(B, 'thrusters', '姿轨控推力器', 'thruster')
  for (const sy of [1, -1]) for (const sz of [1, -1]) {
    obox(gT.mb('mli_black'), BODY, at(hb[0] + 0.05, sy * (hb[1] - 0.08), sz * (hb[2] - 0.08)), P(0.05, 0.06, 0.06))
    for (const k of [-1, 1]) nozzle(gT.mb('titanium'), at(hb[0] + 0.1, sy * (hb[1] - 0.08) + k * 0.025, sz * (hb[2] - 0.08)), nrm(P(1, sy * 0.35, sz * 0.35)), 0.012, 0.035)
  }
  gT.flush()
  // 导航天线（Ø1.4 m 平面阵，黑色镀锗 Kapton 遮阳罩 + 银色包边，高出对地面 0.115 m）
  const gN = group(B, 'nav_antenna', 'L 波段导航天线', 'feed')
  const nc = at(o.nav.x, o.nav.y, ZN + 0.012), R = o.nav.D / 2
  cyl(gN.mb('struct_light'), nc, add(nc, P(0, 0, 0.09)), R + 0.02, 64, false, false)
  cyl(gN.mb('kapton_black'), add(nc, P(0, 0, 0.09)), add(nc, P(0, 0, 0.115)), R, 64, false, true)
  ring(gN.mb('mli_silver'), add(nc, P(0, 0, 0.0905)), Z, R, R + 0.02, 64)
  gN.flush()
  B.point('nav_antenna', 14, add(nc, P(0, 0, 0.05)))
  B.ap('nav_antenna', add(nc, P(0, 0, 0.115)), Z)
  // 搜救天线：六边形银色地板 + 6 根金色螺旋（六个顶点）+ 中心白色多孔圆盘（ESA《The face of Galileo》）
  const gS = group(B, 'sar_antenna', '搜救天线', 'feed')
  const sc = at(o.sar.x, 0, ZN + 0.012)
  const hex = ngon(6, o.sar.plate[1] / 2, 30).map(([x, y]) => [x * (o.sar.plate[0] / o.sar.plate[1]), y])
  prism(gS.mb('mli_silver'), frame(sc, [1, 0, 0], [0, 1, 0], [0, 0, 1]), hex, 0, 0.03)
  cyl(gS.mb('radome'), add(sc, P(0, 0, 0.03)), add(sc, P(0, 0, 0.06)), o.sar.disk / 2, 32, false, true)
  for (const [x, y] of ngon(6, o.sar.plate[1] / 2 - 0.1, 30).map(([x, y]) => [x * (o.sar.plate[0] / o.sar.plate[1]), y])) {
    helixElement(gS.mb('gold_metal'), gS.mb('gold_metal'), add(sc, P(x, y, 0.03)), Z, { R: 0.03, pitch: 0.035, turns: o.sar.helixH / 0.035, wire: 0.004, cupR: 0.045, support: true })
  }
  gS.flush()
  B.ap('sar', add(sc, P(0, 0, 0.3)), Z)
  // 角反射器（FOC：60 棱镜、板 253 × 350 × 62 mm，长边沿 Y；IOV：84 棱镜）
  const gL = group(B, 'lra', '激光角反射器阵', 'sensor')
  addLRA(gL, { F: frame(at(o.lra.x, o.lra.y, ZN + 0.012), [1, 0, 0], [0, 1, 0], [0, 0, 1]), nx: o.lra.nx, ny: o.lra.ny, pitch: o.lra.pitch, r: o.lra.r, hh: 0.008, plateT: 0.04 })
  gL.flush()
  // C 频段上注天线（同心环喇叭 Ø0.23 m）、红外地球敏感器（两台）、S 频段测控（白色短棒罩，对角两只）
  const gD = group(B, 'deck', '对地面设备', 'sensor')
  if (o.cband) {
    const cc = at(o.cband.x, o.cband.y, ZN + 0.012)
    cyl(gD.mb('struct_light'), cc, add(cc, P(0, 0, 0.12)), 0.115, 32, false, false)
    for (const r of [0.115, 0.08, 0.045]) ring(gD.mb(r > 0.1 ? 'aluminum' : 'black_paint'), add(cc, P(0, 0, 0.12 - (0.115 - r) * 0.6)), Z, r - 0.02, r, 32)
    disc(gD.mb('black_paint'), add(cc, P(0, 0, 0.06)), Z, 0.03, 16)
  }
  for (const [x, y] of o.earthSensors) {
    const ec = at(x, y, ZN + 0.012)
    obox(gD.mb('struct_grey'), BODY, add(ec, P(0, 0, 0.06)), P(0.07, 0.06, 0.06))
    obox(gD.mb('black_paint'), BODY, add(ec, P(0, 0, 0.121)), P(0.045, 0.04, 0.002))
  }
  const batons = [[at(hb[0] - 0.08, -hb[1] + 0.12, ZN), P(1, 0, 0.25)], [at(-hb[0] + 0.08, hb[1] - 0.12, -ZN), P(-1, 0, -0.25)]]
  for (const [b, d0] of batons) {
    const d = nrm(d0)
    cyl(gD.mb('aluminum'), b, madd(b, d, 0.1), 0.02, 10, true, false)
    cyl(gD.mb('radome'), madd(b, d, 0.1), madd(b, d, 0.3), 0.05, 20, true, true)
  }
  gD.flush()
  B.ap('ttc_1', madd(batons[0][0], nrm(batons[0][1]), 0.3), nrm(batons[0][1]))
  B.ap('ttc_2', madd(batons[1][0], nrm(batons[1][1]), 0.3), nrm(batons[1][1]))
  // 太阳翼：每翼 2 块（2 × 2.75 m² 基板，电池区 5.000 × 1.082 m），白色长轭；翼根在 ±Y 面中点；电池片正面深蓝近黑、背面黑
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: at(0, s * (hb[1] + 0.016), 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 2, panelW: 1.1, panelH: 2.5, gap: 0.05, yokeLen: o.wingYoke, yoke: 'V', yokeD: 0.04, yokeMat: 'white_paint', sadaLen: 0.12, sadaD: 0.16,
      t: 0.025, margin: 0.01, frameW: 0.015, hingeR: 0.013, backMat: 'kapton_black', efficiency: 28, massKg: 29 })
  }
}

const focFacts = {
  massKg: F(705.685, 'kg', S.GSC_META, { rep: 'GSAT0203', quote: 'COM and mass of FOC satellites', note: '发射质量 732.8 kg（FOC 5–26）/ 约 700 kg（27–34）' }),
  bus: F([2.53, 1.2, 1.1], 'm', S.GSC_META, { quote: 'ΔX = 2.530m ΔY = 1.200m ΔZ = 1.100m' }),
  span: F(14.67, 'm', S.ESA_FACTS, { quote: 'Size: 2.5 x 14.67 x 1.1 m (solar wings deployed)' }),
  wingActive: F([5.0, 1.082], 'm', S.GSC_META, { quote: 'The surface area of each solar array amounts to 5.41 m^2 (= 5.000 m x 1.082 m)' }),
  panelsPerWing: F(2, '块', S.AIRBORNE, { quote: 'two wings, consisting of two panels of 2.75 sqm' }),
  navAntenna: F(1.4, 'm', S.ESA_FACE, { quote: 'main 1.4-m diameter antenna transmits L-band navigation signals' }),
  sar: F('六边形地板 + 6 根突出阵元', '', S.ESA_12THINGS, { quote: 'a smaller hexagonal-shaped antenna incorporating six protruding elements' }),
  lra: F({ cubes: 60, plate: [0.253, 0.35, 0.062] }, 'm', S.ILRS_FOC_LRA, { quote: 'Number of Corner Cubes = 60' }),
  com: F([0.194, 0.011, 0.015], 'm', S.GSC_META, { note: 'GSAT0234 质心（厂家系 260.98, −10.72, 565.31 mm）换到 IGS 盒中心系' }),
  finish: F('逐面 A/B/C/D/E 材料表', '', S.GSC_META)
}
const iovFacts = {
  massKg: F(696.802, 'kg', S.GSC_META, { rep: 'GSAT0101', quote: '0101 | 696.802' }),
  bus: F([2.611, 1.149, 1.149], 'm', S.GSC_META, { quote: 'ΔX = 2.611m | ΔY=1.149m | ΔZ=1.149m' }),
  span: F(14.5, 'm', S.ESA_FACTS, { quote: 'Size: 2.74 x 14.5 x 1.59 m (solar wings deployed)' }),
  wingActive: F([5.0, 1.082], 'm', S.GSC_META),
  lra: F({ cubes: 84 }, '', S.ILRS_IOV, { quote: 'Galileo-101 and -102 Number of CCRs: 84' }),
  sarSide: F('SAR 与 LRA 相对 +X 的位置与 FOC 相反', '', S.MONTENBRUCK_2015, { quote: 'the LRA and SAR antenna placement with respect to the spacecraft +x-axis is inverted' }),
  com: F([0.1, -0.055, -0.021], 'm', S.GSC_META, { note: 'GSAT0101 质心换到 IGS 盒中心系' })
}

const common = { family: 'galileo', tags: ['gnss', 'galileo'], comTarget: [0, 0, 0] }
export const GALILEO_MODELS = [
  { ...common, id: 'galileo-foc', rev: 1, maker: 'OHB System / SSTL', title: 'Galileo FOC', titleZh: '伽利略 FOC', basis: 'GSC 官方元数据', aliases: ['GALILEO FOC', 'GSAT02'],
    massKg: focFacts.massKg, facts: focFacts,
    build: (B) => buildGalileo(B, { box: [2.53, 1.2, 1.1], com: [0.194, 0.011, 0.015], nav: { x: 0.315, y: 0, D: 1.4 },
      sar: { x: -0.845, plate: [0.65, 0.95], disk: 0.4, helixH: 0.25 }, lra: { x: 1.1, y: 0.028, nx: 7, ny: 9, pitch: 0.034, r: 0.0141 },
      cband: { x: 1.115, y: 0.33 }, earthSensors: [[1.155, -0.46], [0.935, -0.46]], wingYoke: 1.57 }) },
  { ...common, id: 'galileo-iov', rev: 1, maker: 'Astrium / Thales Alenia Space', title: 'Galileo IOV', titleZh: '伽利略 IOV', basis: 'GSC 官方元数据', aliases: ['GALILEO IOV', 'GSAT01'],
    massKg: iovFacts.massKg, facts: iovFacts,
    build: (B) => buildGalileo(B, { box: [2.611, 1.149, 1.149], com: [0.1, -0.055, -0.021], nav: { x: -0.07, y: -0.026, D: 1.4 },
      sar: { x: 0.86, plate: [0.8, 1.05], disk: 0.3, helixH: 0.18 }, lra: { x: -0.993, y: -0.021, nx: 10, ny: 9, pitch: 0.042, r: 0.0165 },
      cband: null, earthSensors: [[-1.1, 0.36], [-1.1, 0.14]], wingYoke: 1.51 }) }
]
