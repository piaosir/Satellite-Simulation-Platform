// GPS 精模（2026-09-25）：Block IIR、IIR-M、IIF、III（SV01–08）、III（SV09 起带激光角反射器）。
//
// ★ 坐标：IGS 本体系（+Z 指地 = 导航天线视轴、Y = 太阳翼转轴、+X 补全右手系且动偏时为向阳面），原点 = 平台体盒中心
//   （GPS 各代的质心偏置公开数据互相矛盾——III 的角反射器与相位中心反推差 1 m——不按质心落位）。
//   IIR / III 的厂家系与 IGS 系 X、Y 反号（Montenbruck 2015），本文件一律用 IGS 系。
// ★ 飞行外观（研究稿逐条出处）：
//   IIR / IIR-M：黑色 MLI 方盒（α 0.94），对地面整片罩在黑色多面体隔热罩下（导航 12 螺旋 + UHF 星间阵都在罩里，飞行时看不见），
//     罩外只露白色爆闪探测器遮光喇叭与 1.14 m 的 S 频段测控杆；±X 3.11 m 外各一棵黑色「圣诞树」（核爆探测 W 传感器对数周期天线）；
//     每翼 2 块 1.77 × 1.92 m 硅电池板，翼展 11.42 m（Adhya 2005 技术图纸，洛马图纸转引）。
//   IIF：金色 MLI 方盒 2.51 × 2.06 × 1.80 m（波音 99 × 81 × 71 in），对地面偏 +X 0.394 m 一只黑色八角天线台立 12 根黑色锥顶螺旋；
//     −X 面伸出 NDS 辅助载荷接收天线；每翼 3 块 GaAs 板，总面积 22.25 m²，翼展 17.5 m。
//   III：2.46 × 1.78 × 3.40 m 高方盒（洛马 97 × 70 × 134 in）；+X 银色 MLI、−X 黑色 MLI、±Y 白色 OSR 散热面；
//     对地端整片罩在银色透波 MLI 帐下，露出白色遮光杯与 1.1 m 测控杆；每翼 2 块大板共 28.5 m²，翼展 15 m；SV09 / SV10 带 NASA 的 48 棱镜角反射器。

import { F, IMG } from './sources.mjs'
import { MB, BODY, frame, frameZX, toW, add, sub, scl, nrm, madd, bevelBox, obox, prism, ngon, cyl, cone, disc, ring, truss, quadPts, loft } from './kit.mjs'
import { group, wing, skinBox, helixElement, nozzle } from './parts.mjs'
import { frustum } from '../meshKit.mjs'

const S = {
  ADHYA_2005: 'https://discovery.ucl.ac.uk/id/eprint/1445243/1/U592563.pdf',
  BHATTARAI_2019: 'https://discovery.ucl.ac.uk/id/eprint/10075909/3/Bhattarai_2019_Article_Demonstrating_developments_in_high-fidelity_analytical_radiation_force_modelling_methods_for_spacecraft_with_a_new_model_for_GPS_IIR-IIR-M.pdf',
  NAVI_123: 'https://www.ion.org/publications/upload/NAVI.123.pdf',
  MONTENBRUCK_2015: 'https://elib.dlr.de/97732/1/ASR_151015_GNSS_SatGeomAtt.pdf',
  DLR_GPS3_2020: 'https://elib.dlr.de/134969/1/1-s2.0-S0273117720301988-main%5B1%5D.pdf',
  IGS_META: 'https://files.igs.org/pub/station/general/igs_satellite_metadata.snx',
  IGS20_ATX: 'https://files.igs.org/pub/station/general/igs20.atx',
  AFA_GPS: 'https://www.airandspaceforces.com/weapons/gps/',
  BOEING_IIF: 'http://web.archive.org/web/20170118100049/http://www.boeing.com:80/space/global-positioning-system/',
  SFN_IIF: 'https://spaceflightnow.com/atlas/av039/gps2ffactsheet.pdf',
  TUM_BOXWING: 'https://mediatum.ub.tum.de/doc/1188612/719708.pdf',
  LM_GPS3: 'https://web.archive.org/web/20150906010446/http://www.lockheedmartin.com/content/dam/lockheed/data/space/documents/gps/GPS_III_Fact_Sheet.pdf',
  ILRS_GPS3: 'https://ilrs.gsfc.nasa.gov/missions/satellite_missions/current_missions/gps3_general.html',
  SPRINGER_2023: 'https://link.springer.com/content/pdf/10.1007/s00190-023-01809-y.pdf'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

/** 八角 → 16 点（顶点 + 边中点），放样成多面体罩的底圈用。r = 内切圆半径（对边距离的一半）。 */
function octa16(inR, phaseDeg = 22.5) {
  const R = inR / Math.cos(Math.PI / 8)
  const v = ngon(8, R, phaseDeg)
  const out = []
  for (let k = 0; k < 8; k++) { const a = v[k], b = v[(k + 1) % 8]; out.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) }
  return out
}
/** 多面体隔热罩（八角底 → 16 边平顶，折面硬边）。 */
function faceted(mb, c, inR, zTop, topR, { sx = 1, sy = 1 } = {}) {
  const A = octa16(inR).map(([x, y]) => [x * sx, y * sy])
  const Bq = ngon(16, topR, 11.25)
  loft(mb, frame(c, [1, 0, 0], [0, 1, 0], [0, 0, 1]), A, 0, Bq, zTop - c[2], { capB: true })
}
/** 对数周期「圣诞树」：竖杆（x, y, z0 → 顶），每站两根 ±45° 交叉偶极子（整长 L）。 */
function xmasTree(mb, x, y, z0, stations, r = 0.011) {
  const zTop = Math.max(...stations.map((s) => s[0]))
  cyl(mb, P(x, y, z0), P(x, y, zTop + 0.06), r * 1.6, 10, true, true)
  const c = Math.SQRT1_2
  for (const [z, L] of stations) {
    for (const s of [1, -1]) cyl(mb, P(x - c * L / 2, y - s * c * L / 2, z), P(x + c * L / 2, y + s * c * L / 2, z), r, 8, true, true)
    cyl(mb, P(x, y, z - 0.03), P(x, y, z + 0.03), r * 2.6, 10, true, true)
  }
}

// ───────────────────────────── IIR / IIR-M ─────────────────────────────
function buildIIR(B) {
  const h = P(0.98, 0.78, 0.765), ZN = h[2]
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, P(0, 0, 0), h, 0.02)
  skinBox(g, BODY, P(0, 0, 0), h, { '+x': 'mli_black', '-x': 'mli_black', '+y': 'mli_black', '-y': 'mli_black', '+z': 'mli_black', '-z': 'mli_black' })
  // ±Y 面 OSR 散热片（L 形两块 + 矩形一块，按 Adhya 图 5.2 的轮廓取外接矩形）
  for (const s of [1, -1]) {
    const y = s * (h[1] + 0.02)
    for (const [x0, x1, z0, z1] of [[0.49, 0.83, -0.005, 0.535], [-0.85, -0.26, -0.585, -0.185], [-0.66, -0.26, 0.245, 0.535]]) {
      quadPts(g.mb('radiator'), P(x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(x0, y, z1), P(0, s, 0))
    }
  }
  // 背地面：远地点发动机喷流挡板（梯形，底宽 0.86、深 0.30，黑色 MLI）
  loft(g.mb('mli_black'), frame(P(0, 0, -ZN - 0.012), [1, 0, 0], [0, 1, 0], [0, 0, -1]), [[-0.43, -0.43], [0.43, -0.43], [0.43, 0.43], [-0.43, 0.43]], 0, [[-0.26, -0.26], [0.26, -0.26], [0.26, 0.26], [-0.26, 0.26]], 0.3, { capB: true })
  g.flush()
  B.box('bus', 900, P(0, 0, 0), h)
  // 对地面：黑色多面体天线罩（底宽 1.5 m、顶面 Ø0.95 m、高 0.63 m），罩下是 12 螺旋 L 波段阵 + UHF 星间阵
  const gS = group(B, 'antenna_shroud', '导航天线罩（L 波段 12 螺旋 + UHF 阵）', 'feed')
  faceted(gS.mb('mli_black'), P(0, 0, ZN + 0.012), 0.75, ZN + 0.63, 0.475)
  gS.flush()
  B.point('nav_antenna', 30, P(0, 0, ZN + 0.25))
  B.ap('nav_antenna', P(0, 0, ZN + 0.63), Z)
  // 爆闪探测器遮光喇叭（白外壁 / 黑内壁，口径 0.41 m，+X 边中）与地球敏感器、S 频段测控杆（1.14 m）
  const gD = group(B, 'deck', '对地面设备', 'sensor')
  frustum(gD.mb('white_paint'), P(0.87, 0, ZN + 0.012), 0.11, P(0.87, 0, ZN + 0.6), 0.205, 24, true, false, false)
  frustum(gD.mb('black_paint'), P(0.87, 0, ZN + 0.02), 0.1, P(0.87, 0, ZN + 0.598), 0.195, 24, false, false, true)
  ring(gD.mb('white_paint'), P(0.87, 0, ZN + 0.6), Z, 0.195, 0.205, 24)
  obox(gD.mb('struct_grey'), BODY, P(0.68, 0.64, ZN + 0.09), P(0.1, 0.12, 0.075))
  cyl(gD.mb('dark_glass'), P(0.68, 0.64, ZN + 0.165), P(0.68, 0.64, ZN + 0.18), 0.05, 20, false, true)
  cyl(gD.mb('black_paint'), P(-0.72, 0.58, ZN + 0.012), P(-0.72, 0.58, ZN + 1.14), 0.035, 12, true, false)
  cone(gD.mb('white_paint'), P(-0.72, 0.58, ZN + 1.0), 0.06, P(-0.72, 0.58, ZN + 1.16), 0.015, 12, true, false)
  gD.flush()
  B.ap('burst_detector', P(0.87, 0, ZN + 0.6), Z)
  B.ap('sband_ttc', P(-0.72, 0.58, ZN + 1.14), Z)
  // W 传感器「圣诞树」：低频（+X，6 站，最长偶极子 3.28 m）、高频（−X，6 站），杆自背地棱伸出 3.11 m（Adhya 图 5.2 / 5.3）
  const gW = group(B, 'w_sensors', 'W 传感器天线（核爆探测）', 'feed')
  const low = [[-0.525, 3.28], [-0.085, 2.89], [0.235, 2.47], [0.595, 2.21], [0.805, 1.83], [1.045, 1.64]]
  const high = [[-0.035, 1.57], [0.175, 1.41], [0.325, 1.21], [0.465, 0.99], [0.615, 0.8], [0.765, 0.6]]
  for (const [s, st] of [[1, low], [-1, high]]) {
    truss(gW.mb('black_paint'), [P(s * 0.99, -0.59, -0.74), P(s * 3.11, 0, -0.765)], 0.022, 10)
    truss(gW.mb('black_paint'), [P(s * 0.99, 0.3, -0.74), P(s * 2.2, 0, -0.76)], 0.014, 8)
    xmasTree(gW.mb('black_paint'), s * 3.11, 0, -0.765, st)
  }
  gW.flush()
  B.point('w_sensor_low', 9, P(3.11, 0, 0.2)); B.point('w_sensor_high', 5, P(-3.11, 0, 0.3))
  B.ap('w_sensor_low', P(3.11, 0, 1.1), Z); B.ap('w_sensor_high', P(-3.11, 0, 0.82), Z)
  // 太阳翼：每翼 2 块 1.77 × 1.92 m 硅电池板，板间 0.14 m，内板离星体面 0.95 m（Adhya 图 5.3；翼展 11.42 m）
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 0.792, 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 2, panelW: 1.77, panelH: 1.92, gap: 0.14, yokeLen: 0.82, yoke: 'V', yokeD: 0.05, yokeMat: 'aluminum', sadaLen: 0.12, sadaD: 0.18,
      t: 0.03, margin: 0.03, frameW: 0.02, hingeR: 0.016, efficiency: 15, massKg: 45 })
  }
}

// ───────────────────────────── IIF ─────────────────────────────
function buildIIF(B) {
  const h = P(1.255, 1.03, 0.9), ZN = h[2]
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, P(0, 0, 0), h, 0.025)
  skinBox(g, BODY, P(0, 0, 0), h, { '+x': 'mli_gold', '-x': 'mli_gold', '+z': 'mli_black', '-z': 'mli_gold' })
  // ±Y：灰银色散热面 + 黑色竖条（波音渲染）
  for (const s of [1, -1]) {
    const y = s * (h[1] + 0.012)
    quadPts(g.mb('radiator'), P(-1.23, y, -0.88), P(1.23, y, -0.88), P(1.23, y, 0.88), P(-1.23, y, 0.88), P(0, s, 0))
    for (const x of [-0.82, -0.28, 0.28, 0.82]) quadPts(g.mb('kapton_black'), P(x - 0.05, y + s * 0.002, -0.88), P(x + 0.05, y + s * 0.002, -0.88), P(x + 0.05, y + s * 0.002, 0.88), P(x - 0.05, y + s * 0.002, 0.88), P(0, s, 0))
  }
  // 背地面：对接环（Ø0.9 m 裸铝）
  cyl(g.mb('aluminum'), P(0, 0, -ZN - 0.012), P(0, 0, -ZN - 0.1), 0.45, 40, false, false)
  cyl(g.mb('aluminum'), P(0, 0, -ZN - 0.1), P(0, 0, -ZN - 0.012), 0.42, 40, false, false)
  ring(g.mb('aluminum'), P(0, 0, -ZN - 0.1), scl(Z, -1), 0.42, 0.45, 40)
  g.flush()
  B.box('bus', 1400, P(0, 0, 0), h)
  // 推力器箱：±X 面背地角各两只银色箱（0.4 × 0.25 × 0.25 m）+ 喷管
  const gT = group(B, 'thrusters', '推力器组件', 'thruster')
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    const c = P(sx * (h[0] + 0.125), sy * 0.72, -0.72)
    obox(gT.mb('mli_silver'), BODY, c, P(0.125, 0.2, 0.125))
    nozzle(gT.mb('titanium'), add(c, P(0, 0, -0.125)), nrm(P(sx * 0.2, 0, -1)), 0.02, 0.06)
    nozzle(gT.mb('titanium'), add(c, P(sx * 0.125, 0, 0)), P(sx, 0, 0), 0.02, 0.06)
  }
  gT.flush()
  // 对地面：黑色八角天线台（对边 1.3 m、高 0.3 m，偏 +X 0.394 m），12 根黑色锥顶螺旋（内 4 外 8）
  const gN = group(B, 'nav_antenna', 'L 波段导航天线阵', 'feed')
  const cx = 0.394, z1 = ZN + 0.3
  prism(gN.mb('mli_black'), frame(P(cx, 0, ZN + 0.012), [1, 0, 0], [0, 1, 0], [0, 0, 1]), ngon(8, 0.65 / Math.cos(Math.PI / 8), 22.5), 0, z1 - ZN - 0.012)
  for (const [n, r, az0, H] of [[4, 0.17, 22.5, 0.32], [8, 0.47, 0, 0.2]]) {
    for (let k = 0; k < n; k++) {
      const t = (az0 + 360 * k / n) * Math.PI / 180
      helixElement(gN.mb('black_paint'), gN.mb('black_paint'), P(cx + r * Math.cos(t), r * Math.sin(t), z1), Z, { R: 0.034, pitch: 0.045, turns: H / 0.045, wire: 0.0045, cupR: 0.05, capR: 0.04 })
    }
  }
  gN.flush()
  B.point('nav_antenna', 35, P(cx, 0, ZN + 0.2))
  B.ap('nav_antenna', P(cx, 0, z1 + 0.25), Z)
  // −X 面：NDS 辅助载荷接收天线（弯杆 + 黑色钟形头，朝地）；对地面：爆闪探测接收杆、S 频段测控杆（金色包覆 + 黑头）
  const gA = group(B, 'aux', '辅助载荷天线', 'feed')
  sweepBent(gA.mb('black_paint'), [P(-h[0], 0.1, 0.35), P(-1.62, 0.1, 0.45), P(-1.62, 0.1, 1.05)], 0.028)
  frustum(gA.mb('black_paint'), P(-1.62, 0.1, 1.05), 0.06, P(-1.62, 0.1, 1.28), 0.15, 24, true, true, false)
  cyl(gA.mb('black_paint'), P(-0.95, 0.72, ZN + 0.012), P(-0.95, 0.72, ZN + 0.8), 0.012, 8, true, true)
  cyl(gA.mb('mli_gold'), P(-1.08, -0.86, ZN + 0.012), P(-1.08, -0.86, ZN + 0.38), 0.04, 12, false, false)
  cone(gA.mb('black_paint'), P(-1.08, -0.86, ZN + 0.38), 0.045, P(-1.08, -0.86, ZN + 0.46), 0.01, 12, true, false)
  gA.flush()
  B.ap('nds_aux', P(-1.62, 0.1, 1.28), Z)
  B.ap('sband_ttc', P(-1.08, -0.86, ZN + 0.46), Z)
  // 太阳翼：每翼 3 块 GaAs 板（2.2 × 1.69 m，面积 22.25 / 6 反推），轭 0.92 m，翼展 17.5 m
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 1.042, 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 3, panelW: 1.69, panelH: 2.2, gap: 0.1, yokeLen: 0.8, yoke: 'V', yokeD: 0.05, yokeMat: 'aluminum', sadaLen: 0.12, sadaD: 0.2,
      t: 0.03, margin: 0.03, frameW: 0.02, hingeR: 0.016, efficiency: 28, massKg: 60 })
  }
}
function sweepBent(mb, pts, r) { truss(mb, pts, r, 10) }

// ───────────────────────────── III ─────────────────────────────
function buildIII(B, { lra }) {
  const h = P(1.23, 0.89, 1.7), ZN = h[2]
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, P(0, 0, 0), h, 0.03)
  skinBox(g, BODY, P(0, 0, 0), h, { '+x': 'mli_silver', '-x': 'mli_black', '+y': 'radiator', '-y': 'radiator', '-z': 'mli_black', '+z': 'mli_silver' })
  // 背地面：100 lbf 液体远地点发动机 + 对接环
  cyl(g.mb('aluminum'), P(0, 0, -ZN - 0.012), P(0, 0, -ZN - 0.12), 0.6, 48, false, false)
  cyl(g.mb('aluminum'), P(0, 0, -ZN - 0.12), P(0, 0, -ZN - 0.012), 0.57, 48, false, false)
  ring(g.mb('aluminum'), P(0, 0, -ZN - 0.12), scl(Z, -1), 0.57, 0.6, 48)
  g.flush()
  B.box('bus', 2000, P(0, 0, 0), h)
  const gT = group(B, 'thrusters', '推进', 'thruster')
  nozzle(gT.mb('titanium'), P(0, 0, -ZN - 0.03), scl(Z, -1), 0.12, 0.34)
  for (const sx of [1, -1]) for (const sy of [1, -1]) nozzle(gT.mb('titanium'), P(sx * 1.05, sy * 0.72, -ZN - 0.012), nrm(P(sx * 0.3, sy * 0.3, -1)), 0.025, 0.07)
  gT.flush()
  // 对地端：银色透波 MLI 帐（罩住 12 螺旋 L 波段主阵 + 4 元 M 码阵 + UHF 星间阵），帐外露白色遮光杯、地球敏感器、1.1 m 测控杆
  const gS = group(B, 'antenna_tent', '天线罩（L 波段主阵 / M 码阵 / UHF 阵）', 'feed')
  faceted(gS.mb('mli_silver'), P(-0.05, 0, ZN + 0.012), 0.86, ZN + 0.5, 0.55, { sx: 1.18 })
  gS.flush()
  B.point('nav_antenna', 40, P(0, 0, ZN + 0.2))
  B.ap('nav_antenna', P(-0.06, 0.017, ZN + 0.5), Z)
  const gD = group(B, 'deck', '对地面设备', 'sensor')
  frustum(gD.mb('white_paint'), P(-1.02, -0.66, ZN + 0.012), 0.12, P(-1.02, -0.66, ZN + 0.27), 0.2, 24, true, false, false)
  frustum(gD.mb('black_paint'), P(-1.02, -0.66, ZN + 0.02), 0.11, P(-1.02, -0.66, ZN + 0.268), 0.19, 24, false, false, true)
  ring(gD.mb('white_paint'), P(-1.02, -0.66, ZN + 0.27), Z, 0.19, 0.2, 24)
  obox(gD.mb('white_paint'), BODY, P(1.0, -0.66, ZN + 0.08), P(0.1, 0.13, 0.068))
  for (const dy of [-0.05, 0.05]) cyl(gD.mb('dark_glass'), P(1.0, -0.66 + dy, ZN + 0.148), P(1.0, -0.66 + dy, ZN + 0.16), 0.035, 16, false, true)
  cyl(gD.mb('mli_silver'), P(-1.02, 0.66, ZN + 0.012), P(-1.02, 0.66, ZN + 1.1), 0.04, 12, false, false)
  obox(gD.mb('white_paint'), BODY, P(-1.02, 0.66, ZN + 1.16), P(0.07, 0.07, 0.06))
  gD.flush()
  B.ap('burst_detector', P(-1.02, -0.66, ZN + 0.27), Z)
  B.ap('sband_ttc', P(-1.02, 0.66, ZN + 1.22), Z)
  // SV09 起：NASA 平面角反射器（Ø0.406 m、48 棱镜，偏置 (1.103, 0.007, +Z 面)）——黑色圆框、金色 MLI 包边
  if (lra) {
    const gL = group(B, 'lra', '激光角反射器阵', 'sensor')
    const c = P(1.03, 0.007, ZN + 0.012)
    cyl(gL.mb('mli_gold'), c, add(c, P(0, 0, 0.02)), 0.24, 40, false, true)
    cyl(gL.mb('black_paint'), add(c, P(0, 0, 0.02)), add(c, P(0, 0, 0.05)), 0.203, 40, false, true)
    let n = 0
    for (let j = -4; j <= 4 && n < 48; j++) for (let i = -4; i <= 4 && n < 48; i++) {
      const x = (i + (j % 2 ? 0.5 : 0)) * 0.043, y = j * 0.043 * 0.866
      if (Math.hypot(x, y) > 0.175) continue
      cyl(gL.mb('dark_glass'), add(c, P(x, y, 0.05)), add(c, P(x, y, 0.056)), 0.019, 12, false, true)
      n++
    }
    gL.flush()
    B.ap('lra', add(c, P(0, 0, 0.056)), Z)
  }
  // 太阳翼：每翼 2 块大板（2.3 沿翼展 × 3.1 m，面积 28.5 / 4），白色 V 形轭 1.9 m，翼展 15 m；UTJ 电池近黑
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 0.902, 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 2, panelW: 3.1, panelH: 2.3, gap: 0.1, yokeLen: 1.75, yoke: 'V', yokeD: 0.06, yokeMat: 'white_paint', sadaLen: 0.15, sadaD: 0.24,
      t: 0.03, margin: 0.035, frameW: 0.022, hingeR: 0.018, efficiency: 29, massKg: 75 })
  }
}

// ───────────────────────────── 型号表 ─────────────────────────────

const iirFacts = {
  massKg: F(1080, 'kg', S.IGS_META, { quote: 'G044 … 1080.000 GPS-IIR-A', note: '在轨质量；发射质量 2032 kg（含 Star-37FM 远地点发动机）' }),
  bus: F([1.96, 1.56, 1.53], 'm', S.ADHYA_2005, { quote: "Figure 5.3: Technical drawing of GPS Block IIR — '1.96' / '1.56'", note: 'Z 向 1.53 m 按图 5.2 比例尺量取' }),
  panels: F({ perWing: 2, size: [1.77, 1.92], gap: 0.14, yoke: 0.95 }, 'm', S.ADHYA_2005, { quote: "panel width label '1.77' / length '1.92' / '0.95' from bus face" }),
  span: F(11.42, 'm', S.ADHYA_2005, { note: '2 × 4.93 + 1.56；美空军事实表 38 ft' }),
  shroud: F({ topDiameter: 0.95 }, 'm', S.ADHYA_2005, { quote: "label '0.95' at the nadir end of the shroud" }),
  lband: F('内 4 外 8，两圈错开 22.5°', '', S.NAVI_123, { quote: 'eight helix elements positioned in a circle with four helix elements in the center' }),
  wSensor: F({ offsetX: 3.11 }, 'm', S.ADHYA_2005, { quote: "labels '3.11' (tree axis to bus centre) and '6.22'" }),
  finish: F('黑色 MLI α 0.94，±Y OSR', '', S.TUM_BOXWING, { quote: 'the bus of block IIR is reported to have very high absorption coefficients' })
}
const iifFacts = {
  massKg: F(1633, 'kg', S.BOEING_IIF, { quote: 'Mass at Launch 3,600 lbs (1,633 kg)', note: '直接入轨、无远地点发动机，发射 ≈ 在轨' }),
  bus: F([2.51, 2.06, 1.80], 'm', S.BOEING_IIF, { quote: 'Dimensions 99 in by 81 in by 71 in (251 cm by 206 cm by 180 cm)' }),
  arrayArea: F(22.25, 'm²', S.TUM_BOXWING, { quote: 'Solar panels 22.250' }),
  panelsPerWing: F(3, '块', S.SFN_IIF, { quote: '3-Panel Improved Triple Junction GaAs Solar Arrays' }),
  span: F(17.5, 'm', S.DLR_GPS3_2020, { quote: 'Block IIF … Span width … 17.5 m' }),
  navOffsetX: F(0.394, 'm', S.IGS20_ATX, { quote: 'BLOCK IIF G25 G062 … 394.00 0.00 1454.15' })
}
const iiiFacts = (lra) => ({
  massKg: F(2269, 'kg', S.LM_GPS3, { quote: 'On-orbit weight 5,003 lb', note: '发射质量 8,553 lb（3880 kg）' }),
  bus: F([2.46, 1.78, 3.40], 'm', S.LM_GPS3, { quote: 'Size 97 in wide, 70 in deep, 134 in high' }),
  arrayArea: F(28.5, 'm²', S.LM_GPS3, { quote: 'Solar array 307 ft2; high-efficiency UTJ cells' }),
  span: F(15, 'm', S.DLR_GPS3_2020, { quote: 'Block III … Span width … 15 m' }),
  finish: F('+X 银色 MLI、−X 黑色 MLI、+Z 银色透波 MLI', '', S.DLR_GPS3_2020, { quote: 'the complete -X surface … is covered by black MLI, whereas the +X surface is basically covered by silver MLI' }),
  panelsPerWing: IMG(2, '块', S.LM_GPS3, '洛马渲染每翼两块大板'),
  ...(lra ? { lra: F({ diameter: 0.406, cubes: 48, offset: [1.103, 0.007, 2.173] }, 'm', S.ILRS_GPS3, { quote: 'RRA Size: 16 inch diameter / Reflectors: 48 corner cubes' }) } : {})
})

const common = { family: 'gps', tags: ['gnss', 'gps'] }
export const GPS_MODELS = [
  { ...common, id: 'gps-iir', rev: 1, maker: 'Lockheed Martin', title: 'GPS Block IIR', titleZh: 'GPS IIR', basis: 'AS-4000 平台', aliases: ['NAVSTAR IIR', 'GPS BIIR'],
    massKg: iirFacts.massKg, facts: iirFacts, build: buildIIR },
  { ...common, id: 'gps-iirm', rev: 1, maker: 'Lockheed Martin', title: 'GPS Block IIR-M', titleZh: 'GPS IIR-M', basis: '外形同 IIR（改进型天线板在罩内）', aliases: ['NAVSTAR IIR-M', 'GPS BIIRM'],
    massKg: F(1080, 'kg', S.IGS_META, { quote: 'G053 … 1080.000 GPS-IIR-M' }),
    facts: { ...iirFacts, sameAsIIR: F('外形同 IIR', '', S.NAVI_123, { quote: 'The exterior view of the IIR-M SV is very similar to the IIR SV' }) }, build: buildIIR },
  { ...common, id: 'gps-iif', rev: 1, maker: 'Boeing', title: 'GPS Block IIF', titleZh: 'GPS IIF', basis: '波音 GPS IIF 平台', aliases: ['NAVSTAR IIF', 'GPS BIIF'],
    massKg: iifFacts.massKg, facts: iifFacts, build: buildIIF },
  { ...common, id: 'gps-iii', rev: 1, maker: 'Lockheed Martin', title: 'GPS III', titleZh: 'GPS III', basis: 'A2100M 平台（SV01–SV08）', aliases: ['NAVSTAR III', 'GPS BIII'],
    massKg: iiiFacts(false).massKg, facts: iiiFacts(false), build: (B) => buildIII(B, { lra: false }) },
  { ...common, id: 'gps-iii-lra', rev: 1, maker: 'Lockheed Martin', title: 'GPS III (with LRA)', titleZh: 'GPS III（带激光反射器）', basis: 'SV09 起', aliases: ['GPS BIII-9', 'GPS BIII-10'],
    massKg: iiiFacts(true).massKg, facts: iiiFacts(true), build: (B) => buildIII(B, { lra: true }) }
]
