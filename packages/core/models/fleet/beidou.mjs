// 北斗精模（2026-09-25）：北斗三号 MEO（五院 / 带搜救板 / 微小卫星院 A 型 / B 型）、北斗三号 IGSO、北斗三号 GEO、北斗二号 GEO、北斗二号 IGSO / MEO。
//
// ★ 坐标：IGS 本体系（+Z 指地 = 导航天线视轴、Y = 太阳翼转轴、+X 补全右手系），原点 = 卫星质心——
//   中国卫星导航系统管理办公室（CSNO）卫星信息文件 / 天线文件与 IGS 元数据给的激光角反射器、导航天线相位中心偏置都是「相对质心」，
//   直接按它们落位；质量模型用 def.comTarget = [0,0,0] 把整星质心钉回原点（builder.finishModel）。
//   与本平台本体系（+X 速度、+Z 天底、+Y 补全）同向：零偏 / 动偏姿态下 Y 沿轨道面法向、太阳翼绕 Y 转。
// ★ 数据：整星质量 / 本体尺寸 / 太阳翼面积 / 螺旋阵元数 / 各面热控材料（吸收率）逐条有出处（facts）；
//   单板尺寸、连接架长、反射面口径、部分小天线的位置只能看官方渲染 / 展示模型估（IMG，写明怎么量的），
//   纯造型细节（螺距、线径、倒角、推力器大小……）是示意值。
// ★ 各面颜色按 CSNO 光压参数的吸收率定：α 0.35 = 金色 MLI、α 0.135 = OSR 银白散热镜、α 0.92 / 0.87 = 黑色膜、α 0.20 = OSR / 白漆。
//
// 2026-09-24 用户拍板「内置建模不带任何中国平台模板」针对的是参数化模板（东方红平台）；2026-09-25 用户点名要北斗星座精模，
// 这里只做在轨星座卫星的外形，不进参数化模板目录（生成页选不到它）。

import { F, IMG, ILL } from './sources.mjs'
import { MB, BODY, frame, frameZX, toW, add, sub, scl, nrm, madd, cross, bevelBox, obox, prism, ngon, cyl, cone, disc, truss, hinge, quadPts } from './kit.mjs'
import { group, wing, skinBox, helixElement, hexMeshReflector, fixedDish, nozzle, addStarTracker, addLRA } from './parts.mjs'

const S = {
  CSNO_META: 'http://www.beidou.gov.cn/yw/gfgg/201912/W020191230559858089737.rar',
  CSNO_ATX: 'http://www.beidou.gov.cn/yw/gfgg/201912/W020200323534413069510.atx',
  CSNO_SAR: 'http://en.beidou.gov.cn/SYSTEMS/ICD/202008/P020200803535920317313.pdf',
  CHEN_WU_2020: 'https://doi.org/10.16356/j.1005-2615.2020.06.001',
  ENG_2021: 'https://www.engineering.org.cn/engi/CN/10.1016/j.eng.2021.04.002',
  ZHAO_2022: 'https://doi.org/10.1186/s43020-021-00062-y',
  XIE_2025: 'https://doi.org/10.1186/s43020-025-00166-9',
  IGS_META: 'https://files.igs.org/pub/station/general/igs_satellite_metadata.snx',
  MONTENBRUCK_2015: 'https://elib.dlr.de/97732/1/ASR_151015_GNSS_SatGeomAtt.pdf',
  ASTRONAUTIX_DFH3: 'http://www.astronautix.com/d/dfh-3.html',
  ILRS_M31: 'https://ilrs.gsfc.nasa.gov/docs/ilrsmsr_M31.pdf',
  ARXIV_2208: 'https://arxiv.org/abs/2208.07210',
  SECM_PATENT: 'https://patents.google.com/patent/CN103863577A/zh'
}
const IMG_ZHAO = 'https://doi.org/10.1186/s43020-021-00062-y#fig1'
const IMG_CHEN17 = 'https://doi.org/10.16356/j.1005-2615.2020.06.001#fig17'
const IMG_CHEN16 = 'https://doi.org/10.16356/j.1005-2615.2020.06.001#fig16'
const IMG_MONT8 = 'https://elib.dlr.de/97732/1/ASR_151015_GNSS_SatGeomAtt.pdf#fig8'

const Z = [0, 0, 1]
const P = (x, y, z) => [x, y, z]

// ───────────────────────────── 共用小件 ─────────────────────────────

/** 盒体（结构倒角盒 + 分面热控蒙皮），并登记平台体质量元（由 finishModel 按整星质量与质心对齐）。 */
function busBlock(g, c, h, faces, bevel = 0.02) {
  bevelBox(g.mb('struct_grey'), BODY, c, h, bevel)
  skinBox(g, BODY, c, h, faces)
}
/** 圆形接地板上的螺旋阵：rings = [{n, r, H, phase?}]，中心 (cx, cy)、板面高 z0（板厚 pt）。返回板顶高度。 */
function helixArray(g, { cx, cy, z0, plateR, pt = 0.022, plateMat, coilMat, baseMat = 'radome', rings, R = 0.032, pitch = 0.048, wire = 0.0045, cupR = 0, capR = 0, tiltDeg = 0 }) {
  const zt = z0 + pt
  cyl(g.mb(plateMat), [cx, cy, z0], [cx, cy, zt], plateR, 48, false, true)
  for (const rg of rings) {
    for (let k = 0; k < rg.n; k++) {
      const th = (rg.phase || 0) * Math.PI / 180 + (2 * Math.PI * k) / rg.n
      const px = cx + rg.r * Math.cos(th), py = cy + rg.r * Math.sin(th)
      // 外圈阵元略向外倾（赋形覆球波束）：tiltDeg 只作用在 r > 0 的圈
      const tl = rg.r > 0 ? (rg.tilt ?? tiltDeg) * Math.PI / 180 : 0
      const ax = nrm([Math.cos(th) * Math.sin(tl), Math.sin(th) * Math.sin(tl), Math.cos(tl)])
      helixElement(g.mb(coilMat), g.mb(baseMat), [px, py, zt], ax, { R, pitch, turns: rg.H / pitch, wire, cupR, capR })
    }
  }
  return zt
}
/** 桅杆式全向测控天线（杆 + 白色圆柱天线罩）。 */
function ttcMast(g, base, dir, L = 0.32, rr = 0.05, rl = 0.16) {
  const d = nrm(dir)
  cyl(g.mb('aluminum'), base, madd(base, d, L), 0.012, 10, true, false)
  cyl(g.mb('radome'), madd(base, d, L), madd(base, d, L + rl), rr, 16, true, true)
  cone(g.mb('radome'), madd(base, d, L + rl), rr, madd(base, d, L + rl + rr * 0.8), 0.004, 16, false, false)
}
/** 平板角反射器阵（本体系里朝 n 的面上）：中心 c，行列 nx × ny，节距 pitch，棱镜半径 r。 */
function lraAt(g, c, n, nx, ny, pitch, r, xHint = [1, 0, 0]) {
  addLRA(g, { F: frameZX(c, n, xHint), nx, ny, pitch, r, hh: 0.006, plateT: 0.012 })
}

// ───────────────────────────── 北斗三号 MEO（五院） ─────────────────────────────
//
// T 形本体（Xie 2025 / Zhao 2022）：对地侧大块 T1 1.68(X) × 1.30(Y) × 1.30(Z)，背地侧窄块 T2 1.00 × 1.30 × 0.85（X 向居中）。
// 质心原点下的摆位按 CSNO 偏置反推（研究稿 layoutEstimate）：对地面 z ≈ +1.20 → T1 z∈[−0.10, 1.20]、T2 z∈[−0.95, −0.10]。
// 各面热控（CSNO 光压参数 / Zhao 2022）：+X 与 −Z 全包 MLI（α 0.35）；±Y 为 OSR 散热面（α 0.135）；−X 的 T2 段 OSR、T1 段 α 0.92；
// 对地面 α 0.92。
function buildBds3MeoCast(B, { sar = false } = {}) {
  const ZN = 1.20
  const T1 = { c: P(0, 0, 0.55), h: P(0.84, 0.65, 0.65) }
  const T2 = { c: P(0, 0, -0.525), h: P(0.5, 0.65, 0.425) }
  const g = group(B, 'bus', '平台体', 'bus')
  busBlock(g, T1.c, T1.h, { '+x': 'mli_gold', '-x': 'kapton_black', '+y': 'radiator', '-y': 'radiator', '+z': 'kapton_black', '-z': 'mli_gold' })
  busBlock(g, T2.c, T2.h, { '+x': 'mli_gold', '-x': 'radiator', '+y': 'radiator', '-y': 'radiator', '-z': 'mli_gold' })
  // 姿轨控 5 N 推力器：背地端四角斜出 + ±X 面各两台（锥形喷管）
  const gT = group(B, 'thrusters', '姿轨控推力器', 'thruster')
  for (const sx of [1, -1]) for (const sy of [1, -1]) nozzle(gT.mb('titanium'), P(sx * 0.42, sy * 0.56, -0.965), nrm(P(sx * 0.25, sy * 0.25, -1)), 0.022, 0.07)
  for (const sx of [1, -1]) for (const sz of [0.25, 0.95]) nozzle(gT.mb('titanium'), P(sx * 0.855, 0.45, sz), P(sx, 0, 0), 0.02, 0.06)
  gT.flush()
  // 星敏：背地端两只（渲染里是蓝色短筒），视轴斜指天顶
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  for (const sx of [1, -1]) addStarTracker(gS, { base: P(sx * 0.22, 0.32, -0.962), dir: nrm(P(sx * 0.4, 0.25, -1)), up: P(1, 0, 0), box: [0.13, 0.13, 0.09], dB: 0.11, lB: 0.15, bodyMat: 'blue_grey' })
  gS.flush()
  g.flush()
  B.box('bus', 900, P(0, 0, 0.2), P(0.84, 0.65, 1.07))
  // 导航阵：对地面偏 −X（相位中心 x = −0.21 m），1 m 圆形安装板上 12 根长短不一的螺旋（内 4 高、外 8 低）
  const gN = group(B, 'nav_antenna', 'B1/B2/B3 导航阵列天线', 'feed')
  const zt = helixArray(gN, { cx: -0.21, cy: 0, z0: ZN + 0.012, plateR: 0.5, plateMat: 'struct_light', coilMat: 'nav_red', rings: [{ n: 4, r: 0.17, H: 0.55, phase: 45 }, { n: 8, r: 0.37, H: 0.32, phase: 22.5 }], R: 0.034, pitch: 0.05, cupR: 0.052, capR: 0.04, tiltDeg: 6 })
  gN.flush()
  B.point('nav_antenna', 24, P(-0.21, 0, ZN + 0.15))
  B.ap('nav_antenna', P(-0.21, 0, zt + 0.25), Z)
  // Ka 星间链路相控阵（位置 / 口面按五院爆炸图估）：对地面后缘 +X 侧，梯形底座 + 方形辐射口面
  const gK = group(B, 'isl_ka', 'Ka 星间链路相控阵', 'feed')
  const kc = P(0.52, 0.36, ZN + 0.012)
  prism(gK.mb('struct_grey'), frame(kc, [1, 0, 0], [0, 1, 0], [0, 0, 1]), [[-0.13, -0.13], [0.13, -0.13], [0.13, 0.13], [-0.13, 0.13]], 0, 0.2)
  obox(gK.mb('radome'), BODY, add(kc, P(0, 0, 0.225)), P(0.19, 0.19, 0.025))
  gK.flush()
  B.point('isl_ka', 9, add(kc, P(0, 0, 0.12)))
  B.ap('isl_ka', add(kc, P(0, 0, 0.25)), Z)
  // 激光角反射器（NCRIEO 38 棱镜，CSNO 偏置 (0.593, −0.087, 1.260)）
  const gL = group(B, 'lra', '激光角反射器阵', 'sensor')
  lraAt(gL, P(0.593, -0.087, ZN + 0.02), Z, 6, 6, 0.036, 0.0165)
  gL.flush()
  // S 频段测控：对地 / 背地各一根桅杆天线（4π 覆盖）
  const gC = group(B, 'ttc', 'S 频段测控天线', 'feed')
  ttcMast(gC, P(0.66, -0.5, ZN + 0.012), nrm(P(0.25, -0.15, 1)))
  ttcMast(gC, P(-0.38, -0.46, -0.962), nrm(P(-0.2, -0.2, -1)))
  gC.flush()
  B.ap('ttc_earth', P(0.74, -0.55, ZN + 0.5), Z)
  B.ap('ttc_zenith', P(-0.45, -0.52, -1.45), scl(Z, -1))
  // 搜救 UHF 接收天线板（M13 / M14 / M23 / M24）：展开后与对地面共面、自 −X 边伸出 0.85 m；背面银色 MLI，正面 2 × 2 圆形贴片
  if (sar) {
    const gR = group(B, 'sar_antenna', '搜救天线板', 'feed')
    const xc = -0.84 - 0.04 - 0.425
    obox(gR.mb('mli_silver'), BODY, P(xc, 0, ZN - 0.02), P(0.425, 0.65, 0.018))
    for (const sy of [1, -1]) hinge(gR.mb('titanium'), P(-0.86, sy * 0.45, ZN - 0.02), P(0, 1, 0), 0.02, 0.12)
    for (const dx of [-0.2, 0.2]) for (const dy of [-0.3, 0.3]) cyl(gR.mb('radome'), P(xc + dx, dy, ZN - 0.002), P(xc + dx, dy, ZN + 0.012), 0.15, 32, false, true)
    gR.flush()
    B.point('sar_antenna', 7, P(xc, 0, ZN))
    B.ap('sar_uhf', P(xc, 0, ZN + 0.02), Z)
  }
  // 太阳翼：每翼 3 块（官方渲染），单翼 10.22 m²（CSNO）；板 2.10 × 1.62 m、V 形连接架 0.7 m（看图估）；转轴过质心附近
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 0.662, -0.05), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 3, panelW: 1.62, panelH: 2.1, gap: 0.045, yokeLen: 0.7, yoke: 'V', yokeD: 0.04, sadaLen: 0.14, sadaD: 0.16, t: 0.028, margin: 0.03, frameW: 0.018, hingeR: 0.014, efficiency: 28, massKg: 32 })
  }
}

// ───────────────────────────── 北斗三号 MEO（微小卫星院） ─────────────────────────────
//
// 沿 X 拉长的细长方柱（框架面板式，长边作主散热面；发射轴 = X）：A 型 2.55 × 1.02 × 1.23 m、B 型 2.80 × 0.92 × 1.35 m（Zhao 2022 / CSNO 面积反推）。
// 六面吸收率都是 0.20（CSNO）→ OSR / 白漆的银白外观；对地面上一排排带金色接地盘的螺旋（渲染计数约 18 根），+X 端另有两块星间 / 通信口面。
function buildBds3MeoSecm(B, { dims, lra }) {
  const [X, Y, Zh] = dims, hx = X / 2, hy = Y / 2, hz = Zh / 2
  const ZN = hz
  const g = group(B, 'bus', '平台体', 'bus')
  busBlock(g, P(0, 0, 0), P(hx, hy, hz), { '+x': 'radiator', '-x': 'radiator', '+y': 'radiator', '-y': 'radiator', '+z': 'white_paint', '-z': 'mli_silver' }, 0.025)
  // 侧面的金色窄条（渲染：+Y 面靠 +X 端一道竖向金色压条）
  for (const s of [1, -1]) quadPts(g.mb('mli_gold'), P(hx - 0.34, s * (hy + 0.016), -0.3), P(hx - 0.25, s * (hy + 0.016), -0.3), P(hx - 0.25, s * (hy + 0.016), 0.3), P(hx - 0.34, s * (hy + 0.016), 0.3), P(0, s, 0))
  // 星箭四点接口：−X 端面四个分离螺栓座
  for (const sy of [1, -1]) for (const sz of [1, -1]) cyl(g.mb('titanium'), P(-hx - 0.012, sy * (hy - 0.12), sz * (hz - 0.12)), P(-hx - 0.07, sy * (hy - 0.12), sz * (hz - 0.12)), 0.035, 16, false, true)
  const gT = group(B, 'thrusters', '姿轨控推力器', 'thruster')
  for (const sy of [1, -1]) for (const sz of [1, -1]) nozzle(gT.mb('titanium'), P(-hx - 0.012, sy * (hy - 0.24), sz * (hz - 0.24)), nrm(P(-1, sy * 0.3, sz * 0.3)), 0.018, 0.06)
  gT.flush()
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  for (const sx of [0.35, -0.55]) addStarTracker(gS, { base: P(sx, 0.22, -hz - 0.012), dir: nrm(P(0.2, 0.35, -1)), up: P(1, 0, 0), box: [0.12, 0.12, 0.08], dB: 0.1, lB: 0.13 })
  gS.flush()
  g.flush()
  B.box('bus', 900, P(0, 0, 0), P(hx, hy, hz))
  // 导航螺旋阵：对地面上 3 行 × 6 列交错（渲染计数约 18 根），金色接地盘 + 金色螺旋；外两行略外倾
  const gN = group(B, 'nav_antenna', 'B1/B2/B3 导航阵列天线', 'feed')
  const zt = ZN + 0.014
  const cols = [-1.02, -0.74, -0.46, -0.18, 0.1, 0.38].map((x) => x * (X / 2.55))
  cols.forEach((x, i) => {
    for (const [j, y] of [[-1, -0.3 * (Y / 1.02)], [0, 0], [1, 0.3 * (Y / 1.02)]]) {
      const yy = y + (i % 2 ? 0.07 : -0.07)
      const tl = j * 9 * Math.PI / 180
      helixElement(gN.mb('gold_metal'), gN.mb('gold_metal'), P(x, yy, zt), nrm(P(0, Math.sin(tl), Math.cos(tl))), { R: 0.026, pitch: 0.04, turns: 5.5, wire: 0.004, cupR: 0.062, cupH: 0.012, support: true })
    }
  })
  gN.flush()
  B.point('nav_antenna', 20, P(-0.3, 0, ZN + 0.1))
  B.ap('nav_antenna', P(0.027, -0.005, ZN + 0.49), Z)
  // +X 端：Ka 星间链路相控阵（六边形口面）与圆形口面天线（与导航阵共面安装——微小卫星院「Ka、RNSS 天线共面」）
  const gK = group(B, 'isl_ka', 'Ka 星间链路相控阵', 'feed')
  const xk = hx - 0.28
  prism(gK.mb('radome'), frame(P(xk, 0.2, zt), [1, 0, 0], [0, 1, 0], [0, 0, 1]), ngon(6, 0.19, 30), 0, 0.045)
  prism(gK.mb('struct_grey'), frame(P(xk, 0.2, zt), [1, 0, 0], [0, 1, 0], [0, 0, 1]), ngon(6, 0.2, 30), -0.001, 0.018)
  cyl(gK.mb('radome'), P(xk, -0.2, zt), P(xk, -0.2, zt + 0.04), 0.16, 36, false, true)
  gK.flush()
  B.point('isl_ka', 8, P(xk, 0.2, zt + 0.02))
  B.ap('isl_ka', P(xk, 0.2, zt + 0.05), Z)
  // +X 端面：两只金色圆盘状天线（渲染；功能未公开，推测测控 / 短报文）
  const gD = group(B, 'end_antennas', '+X 端圆盘天线', 'feed')
  for (const sy of [1, -1]) {
    const b = P(hx + 0.012, sy * 0.2, hz - 0.28), d = nrm(P(1, 0, 0.55))
    cyl(gD.mb('aluminum'), b, madd(b, d, 0.1), 0.02, 10, true, false)
    fixedDish(gD, madd(b, d, 0.1), d, { D: 0.32, fd: 0.35, feed: false, reflMat: 'gold_metal', na: 28, nr: 5 })
  }
  gD.flush()
  // 激光角反射器（上海天文台 42 棱镜）
  const gL = group(B, 'lra', '激光角反射器阵', 'sensor')
  lraAt(gL, P(lra[0], lra[1], ZN + 0.014), Z, 7, 6, 0.036, 0.0165)
  gL.flush()
  // 太阳翼：每翼 3 块（渲染），单翼 5.4 m²（CSNO）；板 1.5 × 1.2 m、金色细长连杆 1.0 m（看图估）
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(-0.1, s * (hy + 0.012), -0.05), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 3, panelW: 1.2, panelH: 1.5, gap: 0.04, yokeLen: 1.0, yoke: 'V', yokeD: 0.026, yokeMat: 'gold_metal', sadaLen: 0.1, sadaD: 0.12, t: 0.025, margin: 0.025, frameW: 0.014, hingeR: 0.011, efficiency: 28, massKg: 17 })
  }
}

// ───────────────────────────── 东三B 导航星（北斗三号 IGSO / GEO） ─────────────────────────────
//
// 高长方体 2.10(X) × 2.36(Y) × 3.60(Z)，长轴指地（Zhao 2022 / CSNO 面积反推一致）；对地面约 z = +1.95（LRA / 相位中心偏置）。
// 各面：±X MLI（α 0.35）、±Y OSR（α 0.135）、±Z α 0.87（按黑色膜画对地面，背地端按渲染画金色 MLI）。
// 导航阵 24 螺旋（陈忠贵 2020）立在米色圆地板上，偏 −Y（相位中心 y = −0.31）。
function buildDfh3bNav(B, { geo }) {
  const ZN = 1.95, ZB = -1.65
  const h = P(1.05, 1.18, (ZN - ZB) / 2), c = P(0, 0, (ZN + ZB) / 2)
  const g = group(B, 'bus', '平台体', 'bus')
  busBlock(g, c, h, { '+x': 'mli_gold', '-x': 'mli_gold', '+y': 'radiator', '-y': 'radiator', '+z': 'kapton_black', '-z': 'mli_gold' }, 0.03)
  // 背地端：星箭对接环 + 490 N 远地点发动机
  cyl(g.mb('aluminum'), P(0, 0, ZB - 0.012), P(0, 0, ZB - 0.11), 0.6, 48, false, false)
  cyl(g.mb('aluminum'), P(0, 0, ZB - 0.11), P(0, 0, ZB - 0.012), 0.565, 48, false, false)
  disc(g.mb('aluminum'), P(0, 0, ZB - 0.11), scl(Z, -1), 0.6, 48)
  const gT = group(B, 'thrusters', '推进', 'thruster')
  nozzle(gT.mb('titanium'), P(0, 0, ZB - 0.02), scl(Z, -1), 0.13, 0.38)
  for (const sx of [1, -1]) for (const sy of [1, -1]) nozzle(gT.mb('titanium'), P(sx * 0.9, sy * 1.02, ZB - 0.02), nrm(P(sx * 0.3, sy * 0.3, -1)), 0.03, 0.08)
  for (const sx of [1, -1]) for (const sy of [1, -1]) nozzle(gT.mb('titanium'), P(sx * 1.08, sy * 0.95, ZB + 0.25), P(sx, 0, 0), 0.028, 0.07)
  gT.flush()
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  for (const sy of [1, -1]) addStarTracker(gS, { base: P(-0.75, sy * 0.55, ZB - 0.012), dir: nrm(P(-0.3, sy * 0.3, -1)), up: P(1, 0, 0), box: [0.15, 0.15, 0.1], dB: 0.12, lB: 0.17 })
  gS.flush()
  g.flush()
  B.box('bus', 2600, c, h)
  // 导航阵：24 螺旋（内 8 高、外 16 低），米色地板 Ø1.3 m
  const gN = group(B, 'nav_antenna', 'B1/B2/B3 导航阵列天线', 'feed')
  const zt = helixArray(gN, { cx: -0.07, cy: -0.31, z0: ZN + 0.012, plateR: 0.65, plateMat: 'radome_warm', coilMat: 'nav_red', rings: [{ n: 8, r: 0.25, H: 0.44, phase: 22.5 }, { n: 16, r: 0.53, H: 0.3, phase: 0 }], R: 0.032, pitch: 0.046, cupR: 0.05, capR: 0.038, tiltDeg: 5 })
  gN.flush()
  B.point('nav_antenna', 38, P(-0.07, -0.31, ZN + 0.12))
  B.ap('nav_antenna', P(-0.07, -0.31, zt + 0.24), Z)
  // 对地面其它件：六边形角反射器阵（上海天文台 90 棱镜，IGSO 偏置 (−0.989, −0.712)）、测控喇叭、地球敏感器、L 上行注入天线
  const gL = group(B, 'lra', '激光角反射器阵', 'sensor')
  lraAt(gL, P(-0.93, -0.72, ZN + 0.012), Z, 7, 13, 0.034, 0.0165)
  gL.flush()
  const gD = group(B, 'deck', '对地面设备', 'sensor')
  for (const [x, y] of [[0.78, 0.8], [0.78, -0.95]]) {
    cone(gD.mb('aluminum'), P(x, y, ZN + 0.012), 0.035, P(x, y, ZN + 0.2), 0.07, 20, true, false)
    cone(gD.mb('black_paint'), P(x, y, ZN + 0.02), 0.03, P(x, y, ZN + 0.198), 0.066, 20, false, false)
  }
  obox(gD.mb('struct_grey'), BODY, P(0.62, 0.35, ZN + 0.09), P(0.09, 0.07, 0.08))
  cyl(gD.mb('dark_glass'), P(0.62, 0.35, ZN + 0.17), P(0.62, 0.35, ZN + 0.19), 0.045, 20, false, true)
  ttcMast(gD, P(-0.85, 0.85, ZN + 0.012), nrm(P(-0.3, 0.3, 1)), 0.25)
  gD.flush()
  B.ap('ttc_earth', P(-0.95, 0.95, ZN + 0.45), Z)
  // RDSS / 短报文：六边形构架式网状反射面——IGSO 1 副（+X），GEO 2 副（±X，一上一下错开）；馈源阵装在对地面 ±X 边
  // 口径未公开：展示模型 ≈ 2.2 × 本体宽、官方渲染 ≈ 1.5 ×，取中值对角 4 m（外接圆半径 2 m）
  const refl = geo ? [{ s: 1, name: 'rdss_reflector_+X', title: 'RDSS 固定波束反射面', zHub: 2.55 }, { s: -1, name: 'rdss_reflector_-X', title: 'RDSS 可动点波束反射面', zHub: 1.75 }]
    : [{ s: 1, name: 'rdss_reflector', title: '六边形构架网状反射面', zHub: 2.55 }]
  for (const r of refl) {
    const hub = P(r.s * 3.35, 0, r.zHub)
    hexMeshReflector(B, { name: r.name, title: r.title, hub, n: nrm(P(-r.s * 0.42, 0, 1)), up: P(0, 1, 0), R: 2.0, depth: 0.22, rings: 6, curvature: 0.09, trussMat: 'gold_metal',
      armFrom: P(r.s * 1.075, 0, r.zHub > 2 ? 1.55 : 0.9) })
    // 馈源阵：对地面 ±X 边上一簇喇叭，朝反射面
    const gF = group(B, `${r.name}_feed`, `${r.title}馈源`, 'feed')
    const fb = P(r.s * 0.85, 0.05, ZN + 0.012)
    const aim = nrm(sub(hub, add(fb, P(0, 0, 0.3))))
    cyl(gF.mb('struct_grey'), fb, add(fb, P(0, 0, 0.26)), 0.09, 16, false, true)
    for (const dy of [-0.13, 0, 0.13]) {
      const ap = madd(add(fb, P(0, dy, 0.32)), aim, 0.18)
      cone(gF.mb('aluminum'), add(fb, P(0, dy, 0.26)), 0.035, ap, 0.075, 20, true, false)
      cone(gF.mb('black_paint'), madd(add(fb, P(0, dy, 0.265)), aim, 0.002), 0.03, madd(ap, aim, -0.002), 0.07, 20, false, false)
    }
    gF.flush()
  }
  // IGSO：背地端两副白色小抛物面（高速数传 / 处理试验；口径 ~1.4 m，按展示模型估）
  if (!geo) {
    const gSd = group(B, 'dt_dishes', '数传试验天线', 'reflector')
    for (const sy of [1, -1]) {
      const root = P(-1.062, sy * 0.72, ZB + 0.35), vtx = P(-1.72, sy * 0.95, ZB - 0.2)
      truss(gSd.mb('carbon'), [root, add(vtx, P(0.1, 0, 0.1))], 0.025, 8)
      fixedDish(gSd, vtx, nrm(P(-0.55, sy * 0.2, 0.8)), { D: 1.4, fd: 0.4, reflMat: 'reflector' })
    }
    gSd.flush()
    B.point('dt_dishes', 16, P(-1.7, 0, ZB - 0.2))
  }
  // 太阳翼：每翼 3 块，单翼 17.7 m²（CSNO）；IGSO 板 2.7 × 2.2、GEO 板 2.9 × 2.0，V 形连杆 1.9 m（看图估）
  const pw = geo ? 2.0 : 2.2, ph = geo ? 2.9 : 2.7
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * 1.192, 0.15), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 3, panelW: pw, panelH: ph, gap: 0.05, yokeLen: 1.9, yoke: 'V', yokeD: 0.055, sadaLen: 0.2, sadaD: 0.28, t: 0.03, margin: 0.035, frameW: 0.022, hingeR: 0.018, efficiency: 28, massKg: 55 })
  }
}

// ───────────────────────────── 东三平台导航星（北斗二号） ─────────────────────────────
//
// 2.00(X) × 1.72(Y) × 2.20(Z)（Zhao 2022 / CSNO 面积反推）；机械原点在 −X 端（星箭接口），质心约在 x = +1.15 → 相对质心 x∈[−1.15, 0.85]。
// −X 面是 490 N 远地点发动机大喷管（Montenbruck 2015）；导航阵偏 +X（相位中心 x ≈ +0.61~0.75）；硅电池亮蓝翼、白色梯形连接架，翼展 18.1 m。
// GEO 另有一副 ≈ 2 m 通信抛物面（面积 3.14 m²，+X 面折叠、展开后接 +Z 面）与 C 频段喇叭（+X 面）。
function buildDfh3Nav(B, { geo }) {
  const c = P(-0.15, 0, 0), h = P(1.0, 0.86, 1.1), ZN = 1.1
  const g = group(B, 'bus', '平台体', 'bus')
  bevelBox(g.mb('struct_grey'), BODY, c, h, 0.025)
  // 热控：金色 MLI 为主；GEO 渲染是亮橙金 + ±Y 面黑色散热片，IGSO / MEO 是淡金 + ±Y 面嵌 OSR
  skinBox(g, BODY, c, h, { '+x': 'mli_gold', '-x': 'mli_gold', '+z': 'mli_gold', '-z': 'mli_gold', '+y': 'mli_gold', '-y': 'mli_gold' })
  for (const s of [1, -1]) {
    const y = s * (h[1] + 0.02), mat = geo ? 'kapton_black' : 'radiator'
    for (const [x0, x1] of (geo ? [[-1.05, -0.62], [0.2, 0.7]] : [[-0.95, 0.65]])) quadPts(g.mb(mat), P(x0, y, -0.8), P(x1, y, -0.8), P(x1, y, 0.8), P(x0, y, 0.8), P(0, s, 0))
  }
  g.flush()
  B.box('bus', 1100, c, h)
  // −X 面：490 N 远地点发动机（黑色大喷管 + 隔热罩）
  const gE = group(B, 'apogee_engine', '远地点发动机', 'thruster')
  cyl(gE.mb('kapton_black'), P(-1.162, 0, 0), P(-1.33, 0, 0), 0.3, 32, false, true)
  nozzle(gE.mb('black_paint'), P(-1.33, 0, 0), P(-1, 0, 0), 0.24, 0.42, 32)
  gE.flush()
  const gT = group(B, 'thrusters', '姿轨控推力器', 'thruster')
  for (const sy of [1, -1]) for (const sz of [1, -1]) nozzle(gT.mb('titanium'), P(-1.162, sy * 0.72, sz * 0.95), nrm(P(-1, sy * 0.3, sz * 0.3)), 0.022, 0.07)
  gT.flush()
  // 导航阵：对地面偏 +X，3 × 4 铜色螺旋
  const gN = group(B, 'nav_antenna', '导航阵列天线', 'feed')
  const cx = 0.45, zt = ZN + 0.03
  obox(gN.mb('struct_light'), BODY, P(cx, 0, ZN + 0.02), P(0.36, 0.28, 0.01))
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    helixElement(gN.mb('copper'), gN.mb('radome'), P(cx - 0.27 + i * 0.18, -0.18 + j * 0.18, zt), nrm(P(0.12, 0, 1)), { R: 0.036, pitch: 0.05, turns: 5.6, wire: 0.0048, cupR: 0.055, support: true })
  }
  gN.flush()
  B.point('nav_antenna', 18, P(cx, 0, ZN + 0.12))
  B.ap('nav_antenna', P(0.61, 0, ZN + 0.3), Z)
  // 角反射器（SHAO 90 棱镜，对地面 −X/−Y 角）
  const gL = group(B, 'lra', '激光角反射器阵', 'sensor')
  lraAt(gL, P(-0.5, -0.56, ZN + 0.012), Z, 10, 9, 0.034, 0.0165)
  gL.flush()
  const gC = group(B, 'ttc', '测控天线', 'feed')
  ttcMast(gC, P(-0.9, 0.65, ZN + 0.012), nrm(P(-0.2, 0.2, 1)), 0.22)
  ttcMast(gC, P(-0.9, 0.65, -ZN - 0.012), nrm(P(-0.2, 0.2, -1)), 0.22)
  gC.flush()
  B.ap('ttc_earth', P(-0.95, 0.7, ZN + 0.4), Z)
  if (geo) {
    // 通信天线（RDSS）：Ø2.0 m（面积 3.14 m²，Zhao 2022）棕金色网面，铰在 +X / +Z 棱，展开后朝地；+X 面 C 频段喇叭
    const gA = group(B, 'comm_dish', '通信天线', 'reflector')
    const vtx = P(1.55, 0, 1.35), ax = nrm(P(-0.35, 0, 1))
    fixedDish(gA, vtx, ax, { D: 2.0, fd: 0.38, reflMat: 'reflector_mesh', strutMat: 'mli_gold', legs: 4 })
    truss(gA.mb('carbon'), [P(0.862, 0, 0.9), add(vtx, P(-0.1, 0, -0.05))], 0.03, 10)
    truss(gA.mb('carbon'), [P(0.862, 0.45, 0.6), add(vtx, P(0, 0.35, 0.02))], 0.022, 10)
    truss(gA.mb('carbon'), [P(0.862, -0.45, 0.6), add(vtx, P(0, -0.35, 0.02))], 0.022, 10)
    gA.flush()
    B.point('comm_dish', 14, vtx)
    B.ap('comm_dish', madd(vtx, ax, 0.76), ax)
    const gH = group(B, 'c_horn', 'C 频段喇叭', 'feed')
    cone(gH.mb('aluminum'), P(0.862, 0.4, -0.3), 0.05, P(1.2, 0.4, -0.3), 0.14, 24, true, false)
    cone(gH.mb('black_paint'), P(0.87, 0.4, -0.3), 0.045, P(1.198, 0.4, -0.3), 0.136, 24, false, false)
    gH.flush()
    B.ap('c_horn', P(1.2, 0.4, -0.3), P(1, 0, 0))
  }
  // 太阳翼：每翼 3 块（渲染），单翼 11.35 m²（CSNO），硅电池（α 0.72）；板 2.2 × 1.72 m、白色梯形连接架，翼展 18.1 m（DFH-3）
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(-0.15, s * 0.872, 0), span: P(0, s, 0), normal: P(0, 0, -1),
      n: 3, panelW: 1.72, panelH: 2.2, gap: 0.04, yokeLen: 1.55, yoke: 'trap', yokeD: 0.05, yokeMat: 'white_paint', sadaLen: 0.12, sadaD: 0.18, t: 0.028, margin: 0.03, frameW: 0.02, hingeR: 0.014, cellMat: 'cell_si', cellLines: { du: 0.172, dv: 0.11, w: 0.006 }, efficiency: 17, massKg: 38 })
  }
}

// ───────────────────────────── 型号表 ─────────────────────────────

const castFacts = {
  massKg: F(1060, 'kg', S.CHEN_WU_2020, { quote: '整个卫星设计起飞质量1 060 kg', note: 'CSNO 在轨质量 941–1061 kg' }),
  bus: F({ T1: [1.68, 1.30, 1.30], T2: [1.00, 1.30, 0.85] }, 'm', S.ZHAO_2022, { quote: 'T-shaped (T1) ~ 1000 1.68 1.30 1.30 20.44', note: 'T2 在 X 向居中，两侧各缩 0.34 m（Xie 2025）' }),
  arrayAreaPerWing: F(10.22, 'm²', S.CSNO_META, { quote: 'SATEWING   +Y 0010.220000' }),
  navHelices: F(12, '根', S.CHEN_WU_2020, { quote: '12个螺旋单元形成的一副B1/B2/B3阵列天线' }),
  lra: F([0.5933, -0.087, 1.26], 'm', S.CSNO_META, { note: '相对质心，NCRIEO 38 棱镜' }),
  navPco: F([-0.208, -0.003, 1.487], 'm', S.CSNO_ATX, { note: 'B1 相位中心，相对质心' }),
  panelsPerWing: IMG(3, '块', IMG_CHEN17, '五院官方渲染每翼 3 块'),
  panelSize: IMG([2.1, 1.62], 'm', IMG_CHEN17, '收拢板覆盖 ±Y 侧面；10.22/3 反推'),
  finish: F({ '+X': 'MLI α0.35', '±Y': 'OSR α0.135', '+Z': 'α0.92' }, '', S.ZHAO_2022, { quote: 'For CAST MEO satellites, +X and -Z surfaces are covered by MLIs totally' })
}
const secmFactsA = {
  massKg: F(1008.6, 'kg', S.CSNO_META, { rep: 'BEIDOU-3 M10（C208）', quote: 'C C208 2018-029B C30 … 1008.60 BEIDOU-3M-SECM' }),
  bus: F([2.55, 1.02, 1.23], 'm', S.ZHAO_2022, { quote: 'SECM-A ~ 1050 2.55 1.02 1.51 10.8 0.59', note: 'Z 取 CSNO 面积反推的 1.23 m（与 LRA z = +0.61 自洽）' }),
  arrayAreaPerWing: F(5.4, 'm²', S.CSNO_META, { quote: 'SATEWING   +Y 0005.400000' }),
  lra: F([0.61, 0.43, 0.61], 'm', S.CSNO_META, { note: '相对质心，SHAO 42 棱镜' }),
  navHelices: IMG(18, '根', IMG_ZHAO, '官方渲染计数约 16–20 根'),
  finish: F('六面 α0.20', '', S.ZHAO_2022, { quote: 'all the six surfaces have the same absorption coefficient of 0.20' })
}
const secmFactsB = {
  ...secmFactsA,
  massKg: F(1078.8, 'kg', S.CSNO_META, { rep: 'BEIDOU-3 M22（C225）', quote: 'C C225 2019-078A C43 … 1078.80' }),
  bus: F([2.80, 0.92, 1.35], 'm', S.ZHAO_2022, { quote: 'SECM-B ~ 1050 2.80 0.92 1.35 10.8 0.48' }),
  lra: F([-1.06, -0.287, 0.61], 'm', S.IGS_META, { quote: 'C225 LRA_BDS_SHAO_42 L -1.0608 -0.2872 0.6098' })
}
const dfh3bFacts = (geo) => ({
  massKg: geo ? F(2968, 'kg', S.CSNO_META, { rep: 'BEIDOU-3 G1（C217）', quote: 'C C217 2018-085A C59 … 2968.00  BEIDOU-3G-CAST' })
    : F(2952, 'kg', S.CSNO_META, { rep: 'BEIDOU-3 IGSO-1（C220）', quote: 'C C220 … 2952.00' }),
  bus: F([2.10, 2.36, 3.60], 'm', S.ZHAO_2022, { quote: `${geo ? 'GEO' : 'IGSO'} DFH-3B ~ ${geo ? 2970 : 2910} 2.10 2.36 3.60 35.4 1.71` }),
  arrayAreaPerWing: F(17.7, 'm²', S.CSNO_META, { quote: 'SATEWING   +Y 0017.700000' }),
  navHelices: F(24, '根', S.CHEN_WU_2020, { quote: '导航天线为24螺旋单元形成的B1/B2/B3阵列天线' }),
  reflectors: F(geo ? 2 : 1, '副', S.ZHAO_2022, { quote: 'BDS-3 GEO and IGSO are equipped with two and one hexagonal antennas folded on the ±X and +X surfaces' }),
  reflectorSize: IMG(4, 'm（对角）', IMG_CHEN16, '展示模型 ≈ 2.2 × 本体宽、官方渲染 ≈ 1.5 ×，取中值'),
  panelSize: IMG(geo ? [2.9, 2.0] : [2.7, 2.2], 'm', IMG_CHEN16, '模型本体宽 190 px ↔ 2.36 m 标度'),
  navPco: geo ? F([-0.056, -0.31, 2.08], 'm', S.CSNO_ATX) : F([-0.07, -0.31, 2.0], 'm', S.CSNO_ATX)
})
const dfh3Facts = (geo) => ({
  massKg: geo ? F(1551, 'kg', S.CSNO_META, { rep: 'BEIDOU-2 G5（C016）', quote: 'C C016 … 1551.00', note: 'CSNO 在轨质量 1382–1551 kg' })
    : F(1284, 'kg', S.CSNO_META, { rep: 'BEIDOU-2 IGSO-1（C005）', quote: 'C C005 … 1284.00' }),
  bus: F([2.00, 1.72, 2.20], 'm', S.ZHAO_2022, { quote: `${geo ? 'BDS-2 GEO' : 'IGSO'} DFH-3A ~ ${geo ? 2000 : 1280} 2.00 1.72 2.20 22.7` }),
  arrayAreaPerWing: F(11.35, 'm²', S.CSNO_META, { quote: 'SATEWING   +Y 0011.350000 ********   0000.720000', note: 'α 0.72：硅电池' }),
  span: F(18.1, 'm', S.ASTRONAUTIX_DFH3, { quote: 'Span : 18.10 m (59.30 ft)', note: 'DFH-3 平台（二手）' }),
  apogeeEngine: F('−X 面', '', S.MONTENBRUCK_2015, { quote: 'the location of the apogee boost motor (−xBF-panel)' }),
  ...(geo ? { commDish: F(2.0, 'm', S.ZHAO_2022, { quote: 'with an area approximately 3.14 m 2', note: '面积反推口径' }) } : {}),
  look: IMG('淡金 MLI 方盒、对地面 3 × 4 铜色螺旋', '', IMG_MONT8, 'CSNO 官方渲染')
})

const common = { family: 'beidou', maker: '中国空间技术研究院（航天五院）', tags: ['gnss', 'beidou'], comTarget: [0, 0, 0] }
export const BEIDOU_MODELS = [
  { ...common, id: 'beidou3-meo-cast', rev: 1, title: 'BeiDou-3 MEO (CAST)', titleZh: '北斗三号 MEO（五院）', basis: 'T 形本体、12 螺旋导航阵', aliases: ['BEIDOU-3 M', 'BDS-3 MEO'],
    massKg: castFacts.massKg, facts: castFacts, build: (B) => buildBds3MeoCast(B, { sar: false }) },
  { ...common, id: 'beidou3-meo-cast-sar', rev: 1, title: 'BeiDou-3 MEO (CAST, SAR)', titleZh: '北斗三号 MEO（五院，带搜救载荷）', basis: 'M13 / M14 / M23 / M24', aliases: ['BDS-3 MEO SAR'],
    massKg: castFacts.massKg, facts: { ...castFacts, sarPanel: F([0.85, 1.30], 'm', S.XIE_2025, { quote: 'hs = 0.85 m', note: '展开后与 +Z 面共面、自 −X 边伸出' }), sarSats: F(['M13', 'M14', 'M23', 'M24'], '', S.CSNO_SAR) },
    build: (B) => buildBds3MeoCast(B, { sar: true }) },
  { ...common, id: 'beidou3-meo-secm-a', rev: 1, maker: '中国科学院微小卫星创新研究院', title: 'BeiDou-3 MEO (SECM-A)', titleZh: '北斗三号 MEO（微小卫星院 A 型）', basis: '细长方柱 2.55 × 1.02 × 1.23 m', aliases: ['BDS-3 MEO SECM'],
    massKg: secmFactsA.massKg, facts: secmFactsA, build: (B) => buildBds3MeoSecm(B, { dims: [2.55, 1.02, 1.23], lra: [0.61, 0.43] }) },
  { ...common, id: 'beidou3-meo-secm-b', rev: 1, maker: '中国科学院微小卫星创新研究院', title: 'BeiDou-3 MEO (SECM-B)', titleZh: '北斗三号 MEO（微小卫星院 B 型）', basis: '2.80 × 0.92 × 1.35 m', aliases: ['BDS-3 MEO SECM-B'],
    massKg: secmFactsB.massKg, facts: secmFactsB, build: (B) => buildBds3MeoSecm(B, { dims: [2.80, 0.92, 1.35], lra: [-1.06, -0.287] }) },
  { ...common, id: 'beidou3-igso', rev: 1, title: 'BeiDou-3 IGSO', titleZh: '北斗三号 IGSO', basis: '东三B 导航平台', aliases: ['BDS-3 IGSO'],
    massKg: dfh3bFacts(false).massKg, facts: dfh3bFacts(false), build: (B) => buildDfh3bNav(B, { geo: false }) },
  { ...common, id: 'beidou3-geo', rev: 1, title: 'BeiDou-3 GEO', titleZh: '北斗三号 GEO', basis: '东三B 导航平台', aliases: ['BDS-3 GEO'],
    massKg: dfh3bFacts(true).massKg, facts: dfh3bFacts(true), build: (B) => buildDfh3bNav(B, { geo: true }) },
  { ...common, id: 'beidou2-geo', rev: 1, title: 'BeiDou-2 GEO', titleZh: '北斗二号 GEO', basis: '东三A 平台', aliases: ['BDS-2 GEO'],
    massKg: dfh3Facts(true).massKg, facts: dfh3Facts(true), build: (B) => buildDfh3Nav(B, { geo: true }) },
  { ...common, id: 'beidou2-igso', rev: 1, title: 'BeiDou-2 IGSO / MEO', titleZh: '北斗二号 IGSO / MEO', basis: '东三平台', aliases: ['BDS-2 IGSO', 'BDS-2 MEO'],
    massKg: dfh3Facts(false).massKg, facts: dfh3Facts(false), build: (B) => buildDfh3Nav(B, { geo: false }) }
]
