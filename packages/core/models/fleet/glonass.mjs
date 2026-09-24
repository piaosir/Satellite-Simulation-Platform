// 格洛纳斯精模（2026-09-25）：GLONASS-M（加压舱）、GLONASS-K1（Ekspress-1000K 非加压平台）、GLONASS-K2（「扁平」KAUR-4N 平台，703K / 704K）。
//
// ★ 坐标：IGS 本体系（+Z 指地、Y = 太阳翼转轴、+X 补全右手系），原点 = 卫星质心——俄方厂家系（+X 背地、+Z = 太阳翼轴）按
//   Montenbruck 2015 的换算 x_IGS = −y_BF、y_IGS = +z_BF、z_IGS = −x_BF 转过来；角反射器 / 导航阵偏置取 IGS 元数据与 IAC / Reshetnev 公布值。
// ★ 数据可信度：K1 有 Reshetnev 经 IGS 发布的尺寸图（Mitrikas 2011），整星几何最可靠；M 的圆柱直径 / 长度与帆板尺寸是文献假设值 + 看图；
//   K2 只有官方外包络 2.53 × 6.01 × 1.43 m 与展示模型，形体按模型比例估（facts 里逐条标注）。

import { F, IMG } from './sources.mjs'
import { BODY, frame, add, sub, scl, nrm, madd, bevelBox, obox, prism, ngon, cyl, cone, disc, ring, truss, quadPts } from './kit.mjs'
import { group, wing, skinBox, helixElement, nozzle, addLRA } from './parts.mjs'
import { frustum } from '../meshKit.mjs'

const S = {
  RESHETNEV_M: 'http://web.archive.org/web/20211020071432/https://www.iss-reshetnev.ru/spacecraft/glonass-m',
  DUAN_2020: 'https://link.springer.com/content/pdf/10.1007/s00190-020-01400-9.pdf',
  IGSMAIL_2005: 'https://lists.igs.org/pipermail/igsmail/2005/006475.html',
  MITRIKAS_2011: 'https://acc.igs.org/glonass/GLONASS-K_mitrikas_24aug11.txt',
  MITRIKAS_FIG4: 'https://acc.igs.org/glonass/Fig4.jpg',
  MITRIKAS_FIG1: 'https://acc.igs.org/glonass/Fig1.jpg',
  MITRIKAS_FIG3: 'https://acc.igs.org/glonass/Fig3.jpg',
  IAC_GUIDE: 'https://glonass-iac.ru/guide/glonass.php',
  IAC_LIST: 'https://glonass-iac.ru/glonass/sostavOG/sostavOG_json.php?lang=en&sort=point',
  IGS_META: 'https://files.igs.org/pub/station/general/igs_satellite_metadata.snx',
  MONTENBRUCK_2015: 'https://elib.dlr.de/97732/1/ASR_151015_GNSS_SatGeomAtt.pdf',
  ILRS_112: 'https://ilrs.gsfc.nasa.gov/images/glonass-112ccr.jpg',
  ILRS_K2: 'https://ilrs.gsfc.nasa.gov/docs/2014/glonassretros_shargorodsky_20140501.pdf',
  RSW_K2: 'https://www.russianspaceweb.com/glonass-k2.html'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

/** 环形角反射器（K1 / K2 的 ARS）：外径 od、内径 id、厚 t；棱镜 n 个排在中圈。 */
function lraRing(g, c, od, id, t, n, prismR) {
  cyl(g.mb('aluminum'), c, add(c, P(0, 0, t)), od / 2, 48, false, true)
  cyl(g.mb('aluminum'), add(c, P(0, 0, t)), c, id / 2, 48, false, false)
  const rm = (od + id) / 4
  for (let k = 0; k < n; k++) {
    const a = 2 * Math.PI * k / n
    const q = add(c, P(rm * Math.cos(a), rm * Math.sin(a), t))
    cyl(g.mb('dark_glass'), q, add(q, P(0, 0, 0.006)), prismR, 12, false, true)
  }
}
/** 锥顶天线罩螺旋（格洛纳斯导航阵元：圆柱罩 + 圆锥顶）。 */
function conicalRadome(g, base, H, r, mat = 'radome') {
  cyl(g.mb(mat), base, add(base, P(0, 0, H * 0.72)), r, 18, false, false)
  cone(g.mb(mat), add(base, P(0, 0, H * 0.72)), r, add(base, P(0, 0, H)), 0.006, 18, false, false)
}

// ───────────────────────────── GLONASS-M ─────────────────────────────
// 加压圆柱舱（假设值 Ø1.63 × 2.03 m，Duan 2020）+ 对地端白色 MLI 平台（比圆柱宽，导航阵偏 −X 0.545 m、角反射器偏 +X）+ 背地端圆顶；
// 圆柱中段一圈电机驱动的热控百叶窗；两翼各 2 × 2 块板，总面积 30.85 m²（IGS 邮件 2005）。
function buildM(B) {
  const zc0 = -0.55, zc1 = 1.43, rc = 0.815, ZP = 1.83
  const g = group(B, 'bus', '平台体', 'bus')
  cyl(g.mb('struct_light'), P(0, 0, zc0), P(0, 0, zc1), rc, 48, false, false)
  // 百叶窗带：圆柱中段一圈竖向叶片（微微张开）
  for (let k = 0; k < 36; k++) {
    const a = 2 * Math.PI * k / 36, n = P(Math.cos(a), Math.sin(a), 0), tng = P(-Math.sin(a), Math.cos(a), 0)
    const cc = P(n[0] * (rc + 0.02), n[1] * (rc + 0.02), 0.45)
    const u = madd(scl(tng, 0.06), n, 0.02), v = P(0, 0, 0.42)
    quadPts(g.mb('aluminum'), sub(sub(cc, u), v), add(sub(cc, v), u), add(add(cc, u), v), add(sub(cc, u), v), nrm(madd(n, tng, -0.3)))
  }
  ring(g.mb('dark_metal'), P(0, 0, 0.03), P(0, 0, -1), rc, rc + 0.05, 48)
  ring(g.mb('dark_metal'), P(0, 0, 0.87), Z, rc, rc + 0.05, 48)
  // 背地端圆顶（渲染里是橄榄色）
  frustum(g.mb('blue_grey'), P(0, 0, zc0), rc, P(0, 0, zc0 - 0.18), rc * 0.72, 48, false, false, false)
  frustum(g.mb('blue_grey'), P(0, 0, zc0 - 0.18), rc * 0.72, P(0, 0, zc0 - 0.25), rc * 0.3, 48, false, true, false)
  // 对地平台：白色 MLI 箱（比圆柱宽，底宽 2.2 × 1.9 m、厚 0.4 m）
  const hp = P(1.1, 0.95, (ZP - zc1) / 2), cp = P(0, 0, (ZP + zc1) / 2)
  bevelBox(g.mb('struct_grey'), BODY, cp, hp, 0.02)
  skinBox(g, BODY, cp, hp, { '+x': 'white_paint', '-x': 'white_paint', '+y': 'white_paint', '-y': 'white_paint', '+z': 'white_paint', '-z': 'white_paint' })
  g.flush()
  B.cylMass('bus', 1200, P(0, 0, 0.5), Z, rc, 2.4)
  // 导航阵：12 根锥顶罩螺旋，偏 −X 0.545 m（IGS）
  const gN = group(B, 'nav_antenna', 'L 波段导航天线阵', 'feed')
  const nc = P(-0.545, 0, ZP + 0.012)
  cyl(gN.mb('struct_light'), nc, add(nc, P(0, 0, 0.02)), 0.42, 40, false, true)
  for (const [n, r, H] of [[4, 0.12, 0.42], [8, 0.32, 0.3]]) for (let k = 0; k < n; k++) {
    const a = (360 * k / n + (n === 4 ? 45 : 22.5)) * Math.PI / 180
    conicalRadome(gN, add(nc, P(r * Math.cos(a), r * Math.sin(a), 0.02)), H, 0.045)
  }
  gN.flush()
  B.point('nav_antenna', 20, add(nc, P(0, 0, 0.15)))
  B.ap('nav_antenna', P(-0.545, 0, 2.18), Z)
  // 角反射器：7 × 16 = 112 棱镜，板 311 × 508 mm（ILRS 图纸），IGS 偏置 (0.137, 0.003, 1.874)
  const gL = group(B, 'lra', '激光角反射器阵', 'sensor')
  addLRA(gL, { F: frame(P(0.42, 0.003, ZP + 0.012), [0, 1, 0], [-1, 0, 0], [0, 0, 1]), nx: 16, ny: 7, pitch: 0.0387, r: 0.0145, hh: 0.008, plateT: 0.03, hexStagger: false })
  gL.flush()
  const gT = group(B, 'thrusters', '推力器', 'thruster')
  for (const sx of [1, -1]) for (const sy of [1, -1]) nozzle(gT.mb('titanium'), P(sx * 0.95, sy * 0.8, zc1 + 0.02), nrm(P(sx, sy, -0.6)), 0.018, 0.05)
  gT.flush()
  // 太阳翼：每翼 2 × 2 块（Reshetnev 渲染），单板 3.86 m²（30.85 / 8）；翼根靠背地端（圆顶旁）
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    const y0 = 0.1 + 0.9, ph = 2.15, pw = 1.79
    const panels = []
    for (let k = 0; k < 2; k++) for (const sx of [1, -1]) panels.push({ x: sx * (pw / 2 + 0.03), y: y0 + k * (ph + 0.06), w: pw, h: ph })
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * (rc + 0.01), -0.25), span: P(0, s, 0), normal: P(0, 0, -1),
      panels, yokeLen: 0.9, yoke: 'V', yokeD: 0.05, sadaLen: 0.1, sadaD: 0.18, t: 0.028, margin: 0.03, frameW: 0.02, hingeR: 0.015, efficiency: 17, massKg: 70 })
  }
}

// ───────────────────────────── GLONASS-K1 ─────────────────────────────
// Reshetnev 图纸（Mitrikas 2011 图 1 / 3 / 4）：本体沿径向 2.66 m、1.60 m 宽、沿太阳翼轴只有 0.795 m 厚；对地板更宽（2.18 m）；
// 每翼 2 块 1.60（沿翼展）× 2.65 m 板，V 形杆 0.905 m，翼展 9.2 m；总面积 16.96 m²。对地板中心是环形角反射器（外径 0.634、内径 0.3425），
// 导航螺旋围着它排（K1B / K1+ 导航阵合并）；COSPAS-SARSAT 接收天线（带八角地盘的粗螺旋）在 −X / +Y 棱外侧的杆上。
function buildK1(B) {
  const ZE = 1.314, ZB = -1.346
  const hb = P(0.8, 0.3975, (ZE - ZB) / 2), cb = P(0, 0, (ZE + ZB) / 2)
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, cb, hb, 0.02)
  skinBox(g, BODY, cb, hb, { '+x': 'mli_gold', '-x': 'mli_gold', '+y': 'radiator', '-y': 'radiator', '-z': 'mli_gold' })
  // 对地板：2.18（X）× 0.795（Y），厚 0.06 m，白色
  obox(g.mb('white_paint'), BODY, P(0, 0, ZE + 0.03), P(1.09, 0.3975, 0.03))
  g.flush()
  B.box('bus', 800, cb, hb)
  // 环形角反射器 + 导航螺旋（环内 4 根、环外沿 X 两侧各 6 根，奶油色锥顶罩）
  const gN = group(B, 'nav_antenna', 'L 波段导航天线阵', 'feed')
  const zt = ZE + 0.06
  for (const [x, y] of [[0.06, 0.06], [-0.06, 0.06], [0.06, -0.06], [-0.06, -0.06]]) conicalRadome(gN, P(x, y, zt), 0.3, 0.04, 'radome_warm')
  for (const sx of [1, -1]) for (const [dx, y] of [[0.45, 0.18], [0.45, -0.18], [0.66, 0.2], [0.66, -0.2], [0.87, 0.18], [0.87, -0.18]]) conicalRadome(gN, P(sx * dx, y, zt), 0.36, 0.05, 'radome_warm')
  gN.flush()
  B.point('nav_antenna', 25, P(0, 0, ZE + 0.2))
  B.ap('nav_antenna', P(0, 0, ZE + 0.3), Z)
  const gL = group(B, 'lra', '激光角反射器（环形）', 'sensor')
  lraRing(gL, P(0, 0, zt), 0.634, 0.3425, 0.08, 40, 0.017)
  gL.flush()
  // COSPAS-SARSAT 接收天线：−X / +Y 棱外侧斜杆 + 八角地盘 + 粗螺旋（朝地）；Earth 板角上的黑色锥形喇叭
  const gS = group(B, 'sar_antenna', 'COSPAS-SARSAT 接收天线', 'feed')
  const root = P(-0.8, 0.3975, 0.4), tip = P(-1.35, 0.75, 1.05)
  truss(gS.mb('aluminum'), [root, tip], 0.03, 10)
  prism(gS.mb('aluminum'), frame(tip, [1, 0, 0], [0, 1, 0], [0, 0, 1]), ngon(8, 0.22, 22.5), 0, 0.02)
  helixElement(gS.mb('copper'), gS.mb('radome_warm'), add(tip, P(0, 0, 0.02)), Z, { R: 0.07, pitch: 0.09, turns: 6, wire: 0.008, support: true })
  const hc = P(1.0, -0.3, ZE + 0.06)
  cone(gS.mb('black_paint'), hc, 0.04, add(hc, P(0, 0, 0.2)), 0.1, 20, true, false)
  gS.flush()
  B.ap('sar', add(tip, P(0, 0, 0.6)), Z)
  const gT = group(B, 'thrusters', '推力器', 'thruster')
  for (const sx of [1, -1]) for (const sy of [1, -1]) nozzle(gT.mb('titanium'), P(sx * 0.7, sy * 0.3, ZB - 0.012), nrm(P(sx * 0.3, sy * 0.3, -1)), 0.016, 0.05)
  gT.flush()
  // 太阳翼：每翼 2 块 1.60 × 2.65 m，V 形杆 0.905 m、板间 0.10 m（图 4：4205 / 905 / 1600）；背面奶油色
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 0.3975, 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 2, panelW: 2.65, panelH: 1.6, gap: 0.1, yokeLen: 0.8, yoke: 'V', yokeD: 0.045, sadaLen: 0.105, sadaD: 0.16, t: 0.025, margin: 0.03, frameW: 0.02, hingeR: 0.014, backMat: 'radome_warm', efficiency: 28, massKg: 30 })
  }
}

// ───────────────────────────── GLONASS-K2 ─────────────────────────────
// 「扁平」KAUR-4N：长轴沿 X（约 6 m，官方外包络 6.01 m），沿太阳翼轴约 0.9–1.0 m，径向约 2.2 m（按 Army-2023 展示模型比例估）；
// 对地长条面上两列交错约 26 根导航螺旋 + 中段环形角反射器（Ø0.68 / 0.432 m、36 棱镜）；每翼 3 块宽板，白色 V 形杆接在侧面中段。
function buildK2(B) {
  const hb = P(3.0, 0.47, 1.1), ZE = hb[2]
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, P(0, 0, 0), hb, 0.03)
  skinBox(g, BODY, P(0, 0, 0), hb, { '+x': 'mli_gold', '-x': 'mli_gold', '+y': 'radiator', '-y': 'radiator', '+z': 'white_paint', '-z': 'mli_gold' })
  // ±Y 大面上的金色 MLI 分区（散热面之外的设备区）
  for (const s of [1, -1]) for (const [x0, x1] of [[-2.95, -2.1], [2.1, 2.95]]) quadPts(g.mb('mli_gold'), P(x0, s * (hb[1] + 0.02), -1.05), P(x1, s * (hb[1] + 0.02), -1.05), P(x1, s * (hb[1] + 0.02), 1.05), P(x0, s * (hb[1] + 0.02), 1.05), P(0, s, 0))
  g.flush()
  B.box('bus', 1400, P(0, 0, 0), hb)
  const gN = group(B, 'nav_antenna', 'L 波段导航天线阵', 'feed')
  const zt = ZE + 0.012
  for (let i = 0; i < 13; i++) for (const sy of [1, -1]) {
    const x = -2.7 + i * 0.45 + (sy > 0 ? 0.2 : 0)
    if (Math.abs(x) < 0.45) continue
    conicalRadome(gN, P(x, sy * 0.22, zt), 0.32, 0.045)
  }
  for (const [x, y] of [[0.08, 0.08], [-0.08, 0.08], [0.08, -0.08], [-0.08, -0.08]]) conicalRadome(gN, P(x, y, zt), 0.3, 0.04)
  gN.flush()
  B.point('nav_antenna', 40, P(0, 0, ZE + 0.15))
  B.ap('nav_antenna', P(0, 0, ZE + 0.3), Z)
  const gL = group(B, 'lra', '激光角反射器（环形，36 棱镜）', 'sensor')
  lraRing(gL, P(0, 0, zt), 0.68, 0.432, 0.07, 36, 0.021)
  gL.flush()
  const gT = group(B, 'thrusters', '推力器', 'thruster')
  for (const sx of [1, -1]) for (const sy of [1, -1]) nozzle(gT.mb('titanium'), P(sx * 2.9, sy * 0.38, -ZE - 0.012), nrm(P(sx * 0.3, sy * 0.2, -1)), 0.02, 0.06)
  gT.flush()
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * (hb[1] + 0.02), 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 3, panelW: 4.5, panelH: 1.1, gap: 0.06, yokeLen: 0.8, yoke: 'V', yokeD: 0.05, yokeMat: 'white_paint', sadaLen: 0.1, sadaD: 0.18, t: 0.025, margin: 0.03, frameW: 0.02, hingeR: 0.014, efficiency: 28, massKg: 55 })
  }
}

const common = { family: 'glonass', maker: 'ISS Reshetnev', tags: ['gnss', 'glonass'], comTarget: [0, 0, 0] }
export const GLONASS_MODELS = [
  { ...common, id: 'glonass-m', rev: 1, title: 'GLONASS-M', titleZh: '格洛纳斯-M', basis: '加压圆柱舱', aliases: ['URAGAN-M', 'GLONASS M'],
    massKg: F(1415, 'kg', S.RESHETNEV_M, { quote: 'Масса | 1415 кг' }),
    facts: {
      massKg: F(1415, 'kg', S.RESHETNEV_M, { quote: 'Масса | 1415 кг' }),
      cylinder: F({ diameter: 1.63, length: 2.03 }, 'm', S.DUAN_2020, { quote: 'we assume that the diameter of the cylinder is 1.63m', note: '文献假设值' }),
      arrayArea: F(30.85, 'm²', S.IGSMAIL_2005, { quote: 'Total square of the solar panels is 30.85 sqm' }),
      navOffset: F(0.5, 'm', S.MONTENBRUCK_2015, { quote: 'the navigation antenna, which is shifted by about 0.5 m' }),
      lra: F({ cubes: 112, plate: [0.311, 0.508] }, 'm', S.ILRS_112, { quote: 'overall 311 x 508, 7 columns x 16 rows, pitch 38.7' }),
      panels: IMG('每翼 2 × 2 块', '', S.MONTENBRUCK_2015, 'Reshetnev 渲染')
    }, build: buildM },
  { ...common, id: 'glonass-k1', rev: 1, title: 'GLONASS-K1', titleZh: '格洛纳斯-K1', basis: 'Ekspress-1000K 非加压平台', aliases: ['URAGAN-K', 'GLONASS K'],
    massKg: F(935, 'kg', S.MITRIKAS_2011, { quote: 'The S/V mass is 935 kg.' }),
    facts: {
      massKg: F(935, 'kg', S.MITRIKAS_2011, { quote: 'The S/V mass is 935 kg.' }),
      body: F({ radial: 2.66, width: 1.6, alongArray: 0.795, earthPanel: 2.18 }, 'm', S.MITRIKAS_FIG1, { quote: 'Рисунок 1: 2660 / Рисунок 3: 2180 x 795' }),
      panels: F({ perWing: 2, size: [1.6, 2.65], boom: 0.905 }, 'm', S.MITRIKAS_FIG4, { quote: 'Рисунок 4: 1600 | 1600 | 2650 | 905 | 4205' }),
      arrayArea: F(16.96, 'm²', S.MITRIKAS_2011, { quote: 'Total dimension of solar panels is 16.96 m^2.' }),
      lra: F([0, 0, 1.473], 'm', S.IGS_META, { quote: 'R805 LRA_GLO_K1 L 0.0000 0.0000 1.4730' })
    }, build: buildK1 },
  { ...common, id: 'glonass-k2', rev: 1, title: 'GLONASS-K2', titleZh: '格洛纳斯-K2', basis: 'KAUR-4N 扁平平台（703K / 704K）', aliases: ['URAGAN-K2', 'GLONASS K2'],
    massKg: F(1645, 'kg', S.IGS_META, { quote: 'R803 … 1645.000 GLO-K2' }),
    facts: {
      massKg: F(1645, 'kg', S.IGS_META, { quote: 'R803 … 1645.000 GLO-K2' }),
      envelope: F([2.53, 6.01, 1.43], 'm', S.IAC_GUIDE, { quote: 'Габариты КА, м | … | 2,53х6,01х1,43' }),
      body: IMG([6.0, 0.94, 2.2], 'm', S.RSW_K2, 'Army-2023 展示模型：对地面长宽比 ≈ 6.7 : 1、环形 LRA 占面宽 0.67'),
      lra: F({ cubes: 36, od: 0.68, id: 0.432 }, 'm', S.ILRS_K2, { quote: 'ø628 ø570 ø490 ø432 ø680 ø664 Ретрорефлектор 36 шт.' })
    }, build: buildK2 }
]
