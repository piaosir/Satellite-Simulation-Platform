// 星链精模（2026-09-25）：v1.0（无遮阳板 / VisorSat 遮阳板）、v1.5（激光星间链路）、V2 Mini、V2 Mini 优化版、V2 Mini 直连手机（DTC）。
//
// ★ 坐标（SpaceX 未公布星体系，按官方「展书 / 鲨鱼鳍」说明取）：+Z 对地（相控阵面）、+X = 展书构型下太阳翼铺出的方向（升轨飞行方向）、
//   +Y 补全右手系；原点 = 本体几何中心。v1.x 的本体长边（2.8 m）沿 Y，也是太阳翼铰链轴；V2 Mini 的本体长轴（4.1 m）沿 X，两翼沿 ±Y。
// ★ 尺寸出处：SpaceX 2022-10 / 2023-05 两份 FCC 尺寸表（McDowell StarGen2 转录：F9-1 本体 2.8 × 1.3、翼 8.1 × 2.8；F9-2 本体 4.1 × 2.7、
//   翼 12.8 × 4.1 × 2；F9-3 本体 + 直连天线 7.4 × 2.7）、SpaceX 官网 / 2024–2025 进展报告（天线个数、激光数、推力器工质与推力）、
//   2024-01 直连手机更新（2.7 × 2.3 m 相控阵）。本体厚度取 McDowell GCAT（0.2 / 0.3 m）。部件位置按官方渲染 / 星堆照片量（IMG）。
// ★ 外观（官方《卫星亮度缓解最佳实践》）：v1.x 相控阵白色漫反射、底板抛光金属，VisorSat 边缘加黑 + 黑色泡沫遮阳板；v1.5 起取消遮阳板、
//   多处贴介质镜面膜；二代底面整面镜面膜、抛物面低反射黑漆、剪式展开架哑光黑、太阳翼背板不透光暗色。

import { F, IMG, ILL } from './sources.mjs'
import { MB, BODY, frame, add, sub, scl, nrm, madd, cross, obox, prism, cyl, cone, disc, ring, truss, quadPts, patchGrid } from './kit.mjs'
import { group, wing, hingedArray, pantograph, gimbalDish, addHall, addStarTracker, addLaser, mergeInto } from './parts.mjs'

const S = {
  STARGEN2: 'https://planet4589.org/astro/starsim/papers/StarGen2.pdf',
  GCAT: 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv',
  SFN_2019: 'https://spaceflightnow.com/2019/11/10/spacex-readies-upgraded-starlink-satellites-for-launch/',
  SPACEX_2020: 'https://www.spacex.com/updates/starlink-update-04-28-2020/',
  STARLINK_TECH: 'https://www.starlink.com/technology',
  STARLINK_TECH_2022: 'https://web.archive.org/web/20220907135034/https://www.starlink.com/technology',
  BMBP: 'https://www.starlink.com/public-files/BrightnessMitigationBestPracticesSatelliteOperators.pdf',
  PROGRESS_2024: 'https://starlink.com/public-files/starlinkProgressReport_2024.pdf',
  PROGRESS_2025: 'https://starlink.com/public-files/starlinkProgressReport_2025.pdf',
  DTC_UPDATE: 'https://api.starlink.com/public-files/DIRECT_TO_CELL_FIRST_TEXT_UPDATE.pdf',
  FCC_F93: 'https://www.fcc.gov/ecfs/document/10530137821424/1',
  ARXIV_2107: 'https://arxiv.org/abs/2107.06026',
  ARXIV_2506: 'https://arxiv.org/abs/2506.19092',
  FCC_DAS_2018: 'https://api-prod.fcc.gov/icfs-attachment/exp/api/v1/7c4744568756a610b986a7570cbb'
}
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]
/** 倒角矩形（半长 a × 半宽 b，倒角 c）——星链本体 / 相控阵面板的切角轮廓。 */
const chamRect = (a, b, c) => [[-a + c, -b], [a - c, -b], [a, -b + c], [a, b - c], [a - c, b], [-a + c, b], [-a, b - c], [-a, -b + c]]

// ───────────────────────────── v1.0 / v1.5（平板本体 + 单翼） ─────────────────────────────
function buildV1(B, { visor = false, lasers = 0, mirror = false } = {}) {
  const hx = 0.65, hy = 1.4, hz = 0.1           // 本体 1.3（X）× 2.8（Y）× 0.2（Z）
  const g = group(B, 'bus', '平台体', 'bus')
  const Fb = frame(P(0, 0, 0), [1, 0, 0], [0, 1, 0], [0, 0, 1])
  const outline = chamRect(hx, hy, 0.1)
  prism(g.mb('struct_grey'), Fb, outline, -hz, hz, { cap0: true, cap1: false })
  // 对地面：抛光金属底板（v1.5 贴介质镜面膜）；VisorSat 批次底板边缘加黑（第三方 2021 观察）
  prism(g.mb(mirror ? 'mirror_film' : 'aluminum'), Fb, chamRect(hx - (visor ? 0.06 : 0.005), hy - (visor ? 0.06 : 0.005), 0.1), hz, hz + 0.004, { cap0: false, cap1: true })
  if (visor) prism(g.mb('black_paint'), Fb, outline, hz - 0.001, hz + 0.003, { cap0: false, cap1: true })
  // 背地面：深灰等栅格结构（肋条 8 × 3 格）
  for (let k = -3; k <= 3; k++) obox(g.mb('dark_metal'), BODY, P(0, k * 0.4, -hz - 0.01), P(hx - 0.06, 0.012, 0.01), ['+x', '-x', '+y', '-y', '-z'])
  for (const x of [-0.3, 0.3]) obox(g.mb('dark_metal'), BODY, P(x, 0, -hz - 0.01), P(0.012, hy - 0.08, 0.01), ['+x', '-x', '+y', '-y', '-z'])
  g.flush()
  B.box('bus', 200, P(0, 0, 0), P(hx, hy, hz))
  // 4 块 Ku 用户相控阵（白色漫反射、切角近八边形）：一端 3 块成 L 形（A + B/C 并排），另一端 1 块（D）——官方对地面渲染
  const gA = group(B, 'phased_arrays', 'Ku 用户相控阵', 'feed')
  const tiles = [[0.0, -1.0], [-0.3, -0.45], [0.3, -0.45], [0.0, 0.95]]
  for (const [x, y] of tiles) {
    prism(gA.mb('radome'), frame(P(x, y, hz + 0.004), [1, 0, 0], [0, 1, 0], [0, 0, 1]), chamRect(0.26, 0.26, 0.06), 0, 0.035)
  }
  gA.flush()
  B.point('phased_arrays', 20, P(0, -0.2, hz + 0.02))
  tiles.forEach(([x, y], i) => B.ap(`ku_array_${i + 1}`, P(x, y, hz + 0.04), Z))
  // 2 副抛物面（关口站 Ka / Ku，两轴万向）：本体两端靠 −X 长边，挂在对地侧；v1.0 后期起碟面涂黑
  gimbalDish(B, { name: 'gateway_1', title: '关口站抛物面 1', base: P(-0.42, -1.18, hz + 0.004), n: Z, look: Z, D: 0.45, fd: 0.36, postH: 0.12, mat: 'black_paint' })
  gimbalDish(B, { name: 'gateway_2', title: '关口站抛物面 2', base: P(-0.42, 1.18, hz + 0.004), n: Z, look: Z, D: 0.45, fd: 0.36, postH: 0.12, mat: 'black_paint' })
  // 氪工质霍尔推力器 1 台：与翼铰接边相对的 −X 长边中部（展书构型沿 +X 推进）
  const gT = group(B, 'propulsion', '霍尔推力器（氪）', 'thruster')
  obox(gT.mb('black_paint'), BODY, P(-hx - 0.02, 0.2, 0), P(0.02, 0.1, 0.08))
  addHall(gT, { exit: P(-hx - 0.1, 0.2, 0), dir: P(-1, 0, 0), R: 0.045, L: 0.07 })
  gT.flush()
  B.point('thruster', 1.7, P(-hx - 0.05, 0.2, 0))
  B.ap('hall_thruster', P(-hx - 0.1, 0.2, 0), P(-1, 0, 0))
  // 星敏：本体两端侧边各一（官方：滚转时一台朝地、一台朝日）
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  addStarTracker(gS, { base: P(0.2, -hy - 0.005, 0), dir: nrm(P(0, -1, -0.5)), up: P(1, 0, 0), box: [0.07, 0.07, 0.05], dB: 0.06, lB: 0.08 })
  addStarTracker(gS, { base: P(0.2, hy + 0.005, 0), dir: nrm(P(0, 1, 0.5)), up: P(1, 0, 0), box: [0.07, 0.07, 0.05], dB: 0.06, lB: 0.08 })
  gS.flush()
  // v1.5：激光星间链路终端（黑色光学头；个数未单列，按官网「每星 3 个」）——本体两端角部
  if (lasers > 0) {
    const gL = group(B, 'lasers', '激光星间链路终端', 'feed')
    const spots = [[P(0.45, -hy, -hz), P(0.3, -1, -0.6)], [P(-0.45, -hy, -hz), P(-0.3, -1, -0.6)], [P(0.0, hy, -hz), P(0, 1, -0.6)]]
    spots.slice(0, lasers).forEach(([b, look], i) => {
      addLaser(gL, { base: b, n: nrm(P(0, Math.sign(b[1]), -1)), look: nrm(look), D: 0.09, bodyMat: 'black_paint', baseMat: 'dark_metal' })
      B.ap(`laser_${i + 1}`, madd(b, nrm(look), 0.2), nrm(look))
    })
    gL.flush()
  }
  // VisorSat 遮阳板：沿 −X 长边铰接、向对地侧斜垂的两片黑色泡沫板（阶梯轮廓；官方未给尺寸，按渲染量 ≈0.9 m 深）
  if (visor) {
    const gV = group(B, 'visor', '遮阳板', 'other')
    const ang = 70 * Math.PI / 180, d = P(-Math.cos(ang), 0, Math.sin(ang))
    for (const [y0, y1, dep] of [[-hy + 0.05, -0.02, 0.92], [0.02, hy - 0.05, 0.82]]) {
      const a0 = P(-hx, y0, hz), a1 = P(-hx, y1, hz)
      const b0 = madd(a0, d, dep), b1 = madd(a1, d, dep)
      const nn = nrm(cross(sub(a1, a0), sub(b0, a0)))
      quadPts(gV.mb('kapton_black'), a0, a1, b1, b0, nn)
      quadPts(gV.mb('kapton_black'), madd(a0, nn, -0.02), madd(a1, nn, -0.02), madd(b1, nn, -0.02), madd(b0, nn, -0.02), scl(nn, -1))
      for (const [p, q] of [[a0, b0], [a1, b1], [b0, b1]]) {
        const e = nrm(sub(q, p)), en = nrm(cross(e, nn))
        quadPts(gV.mb('kapton_black'), p, q, madd(q, nn, -0.02), madd(p, nn, -0.02), dotSign(en, sub(scl(add(a0, b1), 0.5), p)) > 0 ? scl(en, -1) : en)
      }
    }
    gV.flush()
    B.point('visor', 3, P(-hx - 0.3, 0, hz + 0.4))
  }
  // 单翼：8.1 × 2.8 m，沿本体 +X 长边铰接（无支杆）；静止位姿 = 鲨鱼鳍（竖立在本体上方，展书时向 +X 平铺）；
  //   折叠段约 13–14 段 × 2 列（官方展书渲染）；电池面蓝色、片间衬底暗红（后期），背面白色漫反射
  hingedArray(B, { name: 'wing_solar', title: '太阳翼', hinge: P(hx + 0.02, 0, -hz + 0.02), axis: P(0, 1, 0), span: P(0, 0, -1),
    L: 8.1, W: 2.8, rows: 14, cols: 2, t: 0.02, gap: 0.012, offset: 0.05, cellsOn: 1, backMat: 'white_paint', massKg: 30, limits: [-90, 75], efficiency: 29 })
}
const dotSign = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// ───────────────────────────── V2 Mini（含优化版 / 直连手机） ─────────────────────────────
function buildV2(B, { dtc = false } = {}) {
  const hx = 2.05, hy = 1.35, hz = 0.15         // 本体 4.1（X）× 2.7（Y）× 0.3（Z）
  const g = group(B, 'bus', '平台体', 'bus')
  const Fb = frame(P(0, 0, 0), [1, 0, 0], [0, 1, 0], [0, 0, 1])
  prism(g.mb('struct_grey'), Fb, chamRect(hx, hy, 0.12), -hz, hz, { cap0: true, cap1: false })
  // 对地面：第二代介质镜面膜整面覆盖
  prism(g.mb('mirror_film'), Fb, chamRect(hx - 0.01, hy - 0.01, 0.12), hz, hz + 0.004, { cap0: false, cap1: true })
  // 背地面：沿长轴一条中央纵梁 + 两半各一片矩形网格
  obox(g.mb('dark_metal'), BODY, P(0, 0, -hz - 0.02), P(hx - 0.08, 0.05, 0.02), ['+x', '-x', '+y', '-y', '-z'])
  for (const s of [1, -1]) {
    for (let k = -4; k <= 4; k++) obox(g.mb('dark_metal'), BODY, P(k * 0.45, s * 0.68, -hz - 0.01), P(0.012, 0.6, 0.01), ['+x', '-x', '+y', '-y', '-z'])
    for (const yy of [0.3, 0.68, 1.06]) obox(g.mb('dark_metal'), BODY, P(0, s * yy, -hz - 0.01), P(hx - 0.1, 0.012, 0.01), ['+x', '-x', '+y', '-y', '-z'])
  }
  g.flush()
  B.box('bus', 600, P(0, 0, 0), P(hx, hy, hz))
  // 5 块 Ku 相控阵：对地面 3 × 2 分格，5 格白色阵面、1 格灰色设备盒（2024 进展报告特写）
  const gA = group(B, 'phased_arrays', 'Ku 用户相控阵', 'feed')
  const cells = []
  for (const x of [-1.33, 0, 1.33]) for (const y of [-0.66, 0.66]) cells.push([x, y])
  cells.forEach(([x, y], i) => {
    if (i === 5) { obox(gA.mb('struct_light'), BODY, P(x, y, hz + 0.08), P(0.45, 0.4, 0.075)); return }
    const Fa = frame(P(x, y, hz + 0.004), [1, 0, 0], [0, 1, 0], [0, 0, 1])
    prism(gA.mb('radome'), Fa, chamRect(0.6, 0.6, 0.08), 0, 0.03)
    patchGrid(gA.mb('white_paint'), Fa, { nx: 10, ny: 10, px: 0.11, py: 0.11, w: 0.07, h: 0.07, t: 0.006, z0: 0.03 })
  })
  gA.flush()
  B.point('phased_arrays', 60, P(0, 0, hz + 0.03))
  cells.slice(0, 5).forEach(([x, y], i) => B.ap(`ku_array_${i + 1}`, P(x, y, hz + 0.04), Z))
  // 3 副 Ka / E 双频抛物面（低反射黑漆、6 条径向肋、两轴万向，挂在对地侧两端 / 角部）
  const dishes = [[-1.85, 1.02], [-1.85, -1.02], [1.85, -1.02]]
  dishes.forEach(([x, y], i) => gimbalDish(B, { name: `gateway_${i + 1}`, title: `Ka / E 双频抛物面 ${i + 1}`, base: P(x, y, hz + 0.004), n: Z, look: Z, D: 0.5, fd: 0.35, postH: 0.14, mat: 'black_paint' }))
  // 3 个激光终端（每星 3 个，官方进展报告）：本体背地侧周边角部，黑色光学头
  const gL = group(B, 'lasers', '激光星间链路终端', 'feed')
  const lz = [[P(1.85, 1.1, -hz), P(0.6, 0.5, -0.8)], [P(-1.85, 1.1, -hz), P(-0.6, 0.5, -0.8)], [P(1.85, -1.1, -hz), P(0.6, -0.5, -0.8)]]
  lz.forEach(([b, look], i) => {
    addLaser(gL, { base: b, n: P(0, 0, -1), look: nrm(look), D: 0.1, bodyMat: 'black_paint', baseMat: 'dark_metal' })
    B.ap(`laser_${i + 1}`, madd(b, nrm(look), 0.25), nrm(look))
  })
  gL.flush()
  // 氩工质霍尔推力器（170 mN，SpaceX 自研）：−X 短端黑色安装板 + 旁侧大圆柱贮箱
  const gT = group(B, 'propulsion', '霍尔推力器（氩）', 'thruster')
  obox(gT.mb('black_paint'), BODY, P(-hx - 0.025, 0.35, 0), P(0.025, 0.22, 0.12))
  addHall(gT, { exit: P(-hx - 0.14, 0.35, 0), dir: P(-1, 0, 0), R: 0.075, L: 0.1 })
  cyl(gT.mb('struct_light'), P(-hx + 0.05, -0.55, -hz - 0.02), P(-hx + 0.95, -0.55, -hz - 0.02), 0.17, 28, true, true)
  gT.flush()
  B.point('thruster', 2.1, P(-hx - 0.08, 0.35, 0))
  B.ap('hall_thruster', P(-hx - 0.14, 0.35, 0), P(-1, 0, 0))
  const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
  for (const y of [0.5, -0.5]) addStarTracker(gS, { base: P(1.2, y, -hz - 0.02), dir: nrm(P(0.3, y, -1)), up: P(1, 0, 0), box: [0.08, 0.08, 0.06], dB: 0.07, lB: 0.1 })
  gS.flush()
  // 两翼：剪式展开架（外露 ≈2.5 m，哑光黑）接在两条长边中点；每翼 2 列 × 16 段，翼长 12.8 m（FCC 保守包络）、宽按图 ≈3.9 m
  for (const s of [1, -1]) {
    const side = s > 0 ? '+Y' : '-Y'
    const gP = group(B, `pantograph_${side}`, `剪式展开架 ${side}`, 'boom')
    pantograph(gP.mb('black_paint'), P(0, s * hy, -0.02), P(0, s, 0), P(1, 0, 0), 2.4, 0.9, 4, 0.022)
    gP.flush()
    const panels = []
    const segL = (12.8 - 15 * 0.012) / 16
    for (let k = 0; k < 16; k++) for (const sx of [1, -1]) panels.push({ x: sx * 0.98, y: 2.45 + k * (segL + 0.012), w: 1.94, h: segL })
    wing(B, { name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(0, s * hy, -0.02), span: P(0, s, 0), normal: P(0, 0, -1),
      panels, yokeLen: 0, yoke: 'none', sadaLen: 0, t: 0.018, margin: 0.012, backMat: 'kapton_black', efficiency: 29, massKg: 45 })
  }
  // 直连手机：2.7 × 2.3 m 大相控阵（官方 2024-01），铰在 +X 短端、翻出到本体外、辐射面朝地；黑框上密排银色杯状阵元
  if (dtc) {
    const gD = group(B, 'dtc_array', '直连手机相控阵', 'feed')
    const x0 = hx + 0.08, Lx = 2.3, Wy = 2.7
    const Fd = frame(P(x0 + Lx / 2, 0, hz + 0.02), [1, 0, 0], [0, 1, 0], [0, 0, 1])
    obox(gD.mb('black_paint'), Fd, P(0, 0, 0), P(Lx / 2, Wy / 2, 0.03))
    patchGrid(gD.mb('aluminum'), Fd, { nx: 33, ny: 39, px: 0.0685, py: 0.0685, w: 0.05, h: 0.05, t: 0.012, z0: 0.03 })
    for (const sy of [1, -1]) {
      cyl(gD.mb('aluminum'), P(hx + 0.01, sy * 0.9, hz), P(hx + 0.12, sy * 0.9, hz), 0.04, 12, true, true)
      obox(gD.mb('aluminum'), BODY, P(hx + 0.06, sy * 0.9, hz + 0.03), P(0.06, 0.06, 0.03))
    }
    gD.flush()
    B.point('dtc_array', 120, P(x0 + Lx / 2, 0, hz + 0.02))
    B.ap('dtc_array', P(x0 + Lx / 2, 0, hz + 0.08), Z)
  }
}

// ───────────────────────────── 型号表 ─────────────────────────────

const v1Facts = (v15) => ({
  massKg: v15 ? F(303, 'kg', S.STARGEN2, { quote: 'Total Area F9-1 … 26.32 30 303', note: 'FCC 申报 DAS 质量（McDowell 转录）' })
    : F(260, 'kg', S.SFN_2019, { quote: 'each weigh around 573 pounds (260 kilograms), according to SpaceX' }),
  bus: F([1.3, 2.8], 'm', S.STARGEN2, { quote: 'Bus F9-1 … 2.8 1.3 1 … 3.64' }),
  thickness: F(0.2, 'm', S.GCAT, { note: 'McDowell GCAT 估值' }),
  array: F([8.1, 2.8], 'm', S.STARGEN2, { quote: 'Solar Array F9-1 8.1 2.8 1 … 22.68' }),
  antennas: F({ phasedArrays: 4, parabolic: 2 }, '副', S.STARLINK_TECH_2022, { quote: 'Each Starlink satellite uses 4 powerful phased array antennas and 2 parabolic antennas' }),
  arrayPoses: F('展书 / 鲨鱼鳍', '', S.SPACEX_2020, { quote: "solar array raised above the satellite in a vertical orientation that we call 'shark-fin.'" }),
  thruster: F('氪工质霍尔推力器 1 台', '', S.FCC_DAS_2018, { quote: 'Thruster Internals | 1 | Iron | 1.66' }),
  ...(v15 ? { lasers: F(3, '个', S.STARLINK_TECH, { quote: 'Each Starlink satellite contains 3 space lasers', note: 'v1.5 未单列，按官网口径' }), finish: F('介质镜面膜', '', S.BMBP, { quote: 'SpaceX also started using dielectric mirror film on many surfaces of the satellite' }) } : {}),
  layout: IMG('底面 4 阵：一端 3 块 L 形 + 另一端 1 块', '', S.PROGRESS_2024, '2024 进展报告对地面渲染')
})
const v2Facts = (kind) => ({
  massKg: kind === 'opt' ? F(575, 'kg', S.PROGRESS_2024, { quote: 'approximately 575 kilograms (1,267 pounds) at launch, nearly 22% lighter than the original V2 Mini' })
    : kind === 'dtc' ? F(970, 'kg', S.FCC_F93, { quote: 'Total Area F9-3 125.0 130 970', note: 'FCC 示意构型（保守）' })
      : F(800, 'kg', S.STARGEN2, { quote: 'Total Area F9-2 116.03 120 800', note: 'FCC 保守包络；按「优化版轻 22 %」反推约 737 kg' }),
  bus: F([4.1, 2.7], 'm', S.STARGEN2, { quote: 'Bus F9-2 4.1 2.7 1 11.07' }),
  thickness: F(0.3, 'm', S.GCAT),
  arrays: F([12.8, 4.1, 2], 'm', S.STARGEN2, { quote: 'Solar Array F9-2 12.8 4.1 2 104.96' }),
  antennas: F({ ku: 5, kaE: 3 }, '副', S.STARLINK_TECH, { quote: 'uses 5 advanced Ku-band phased array antennas and 3 dual-band (Ka-band and E-band) antennas' }),
  lasers: F(3, '个', S.PROGRESS_2025, { quote: 'Each Starlink V2 Mini satellite is equipped with three advanced laser inter-satellite links' }),
  thruster: F('氩霍尔推力器 170 mN', '', S.PROGRESS_2024, { quote: 'offering 170 mN of thrust, which is 2.4 times the thrust' }),
  finish: F('底面介质镜面膜、抛物面黑漆、展开架哑光黑', '', S.BMBP, { quote: 'SpaceX covers the bottom of its satellites with a second-generation dielectric mirror film' }),
  ...(kind === 'dtc' ? { dtcArray: F([2.7, 2.3], 'm', S.DTC_UPDATE, { quote: 'We also developed large 2.7 m x 2.3 m advanced phased arrays' }) } : {})
})

const common = { family: 'starlink', maker: 'SpaceX', tags: ['leo', 'comsat', 'starlink'] }
export const STARLINK_MODELS = [
  { ...common, id: 'starlink-v1', rev: 1, title: 'Starlink v1.0', titleZh: '星链 v1.0', basis: '平板本体 + 单翼（2019–2020 首批，无遮阳板）', aliases: ['STARLINK V1.0'],
    massKg: v1Facts(false).massKg, facts: v1Facts(false), build: (B) => buildV1(B, {}) },
  { ...common, id: 'starlink-v1-visor', rev: 1, title: 'Starlink v1.0 (VisorSat)', titleZh: '星链 v1.0（遮阳板）', basis: '2020-06 起加装黑色遮阳板', aliases: ['VISORSAT'],
    massKg: v1Facts(false).massKg, facts: { ...v1Facts(false), visor: F('黑色泡沫遮阳板，发射时平贴本体、分离时展开', '', S.SPACEX_2020, { quote: 'This visor lays flat on the chassis during launch and deploys during satellite separation' }) },
    build: (B) => buildV1(B, { visor: true }) },
  { ...common, id: 'starlink-v15', rev: 1, title: 'Starlink v1.5', titleZh: '星链 v1.5', basis: '平板本体 + 单翼 + 激光星间链路', aliases: ['STARLINK V1.5'],
    massKg: v1Facts(true).massKg, facts: v1Facts(true), build: (B) => buildV1(B, { lasers: 3, mirror: true }) },
  { ...common, id: 'starlink-v2mini', rev: 1, title: 'Starlink V2 Mini', titleZh: '星链 V2 Mini', basis: '4.1 × 2.7 m 平板 + 双翼', aliases: ['STARLINK V2 MINI'],
    massKg: v2Facts('base').massKg, facts: v2Facts('base'), build: (B) => buildV2(B, {}) },
  { ...common, id: 'starlink-v2mini-opt', rev: 1, title: 'Starlink V2 Mini Optimized', titleZh: '星链 V2 Mini 优化版', basis: '外形同 V2 Mini，减重 22 %', aliases: ['STARLINK V2 MINI OPTIMIZED'],
    massKg: v2Facts('opt').massKg, facts: v2Facts('opt'), build: (B) => buildV2(B, {}) },
  { ...common, id: 'starlink-v2mini-dtc', rev: 1, title: 'Starlink V2 Mini (Direct to Cell)', titleZh: '星链 V2 Mini 直连手机', basis: 'V2 Mini + 2.7 × 2.3 m 直连相控阵', aliases: ['STARLINK DTC', 'DIRECT TO CELL'],
    massKg: v2Facts('dtc').massKg, facts: v2Facts('dtc'), build: (B) => buildV2(B, { dtc: true }) }
]
