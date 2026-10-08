// GEO 气象星精模（2026-10-07）：GOES-R 系列（GOES 16 / 17 / 18）与 GOES-U（GOES 19）……（其余气象星随调研补齐）
//
// ★ 坐标：本平台本体系（+Z 对地、+X 东、+Y 南），原点 = 平台结构盒几何中心。GOES-R 数据手册的本体系与此同向
//   （「Assembly (SAWA), is folded against the +Y side」「the solar array is pointed south」——+Y 即南）。
// ★ 数据：整星质量 / 收拢包络 / 太阳翼板数与单板尺寸 / 磁强计杆长 / 各件所在面逐条出处（facts，数据手册与 NOAA 页原文）；
//   平台体尺寸、反射面口径、天线翼大小、ABI 外形只能对照数据手册 CAD 图与官方渲染估（IMG，写明标度），其余为造型示意。

import { F, IMG } from './sources.mjs'
import { MB, BODY, toW, add, nrm, obox, cyl, cone, disc, truss, quadPts } from './kit.mjs'
import { group, gimbalDish, helixElement, addStarTracker } from './parts.mjs'
import { buildGeo, instrument, latticeBoom, spinnerSat } from './geokit.mjs'
import { horn, frustum } from '../meshKit.mjs'

const S = {
  GOESR_BOOK: 'https://web.archive.org/web/20250113214216id_/https://www.goes-r.gov/downloads/resources/documents/GOES-RSeriesDataBook.pdf',
  NOAA_SC: 'https://www.nesdis.noaa.gov/our-satellites/currently-flying/goes-east-west/goes-r-series-spacecraft-instruments',
  GOESR_RENDER: 'https://web.archive.org/web/20230101045127id_/https://www.goes-r.gov/imagesContent/spacecraft/labelledImageMaps/spacecraftLabelled-front_right.png',
  ESA_MSG_FACTS: 'https://www.esa.int/Applications/Observing_the_Earth/Meteorological_missions/Meteosat/Meteosat_Second_Generation_Facts_and_Figures',
  ESA_MSG1_IMG: 'https://www.esa.int/ESA_Multimedia/Images/2002/07/MSG-1_is_a_3.7_m-high_cylindrically-shaped_satellite_designed_for_weather_observation',
  ESA_MSG_ARCH: 'https://www.esa.int/Applications/Observing_the_Earth/Meteorological_missions/Meteosat/Satellite_Architecture',
  EOP_MSG: 'https://www.eoportal.org/satellite-missions/meteosat-second-generation',
  VA207: 'https://europeanspaceflight.com/wp-content/uploads/2023/11/VA207-launchkit.pdf',
  MSG_TEST_IMG: 'https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2002/07/msg_satellite_undergoing_testing/9130308-5-eng-GB/MSG_satellite_undergoing_testing_pillars.jpg',
  EUM_MTGI: 'https://www-cdn.eumetsat.int/files/2026-06/MTG-I_Facts%20and%20Figures_web.pdf',
  S4_SAT: 'https://sentinels.copernicus.eu/missions/sentinel-4/satellite-description',
  EOP_MTG: 'https://www.eoportal.org/satellite-missions/meteosat-third-generation',
  VA259: 'https://europeanspaceflight.com/wp-content/uploads/2023/11/VA259-launchkit.pdf',
  ESA_MTGI_SA: 'https://www.esa.int/var/esa/storage/images/esa_multimedia/images/2022/12/mtg-i_solar_arrays_deploy/24625299-1-eng-GB/MTG-I_solar_arrays_deploy_pillars.png'
}
const BOOK_FIG = (p) => `${S.GOESR_BOOK}#page=${p}`
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

// ───────────────────────────── GOES-R 系列（Lockheed Martin A2100） ─────────────────────────────
//
// 平台体 3.0（X）× 2.25（Y）× 2.6（Z）m：数据手册图 9-5（近正视 −Y 面）本体宽高比 ≈ 275:235 px，以收拢包络 Width 3.88 m 扣去两侧收拢件
// 定宽；Depth 2.69 m 扣去 +Y 侧收拢太阳翼定 Y。对地板上隔振的对地平台 EPP 载 ABI（−Y 半，辐冷朝北）与 GLM（+Y 半，辐冷板朝南）；
// 南侧单翼 5 块 1.357 × 3.923 m 板，翼根三角连接架上的太阳指向平台 SPP 载 SUVI / EXIS（GOES-U 加 CCOR-1），随翼转；
// +X 侧二轴万向 X 频段反射面与可盘绕桁架磁强计杆（外侧探头离星 8.56 m）；−X 侧天线翼 AWA（UHF 四螺旋 + GRB 喇叭）展开后朝地。
function buildGoesR(B, { ccor = false } = {}) {
  const hx = 1.5, hy = 1.125, hz = 1.3
  const ZE = hz + 0.3   // EPP 板顶面
  buildGeo(B, {
    bus: { x: 2 * hx, y: 2 * hy, z: 2 * hz, faces: { east: 'mli_black', west: 'mli_black', deck: 'mli_black', aft: 'mli_black', band: 'mli_black' }, ribs: 4, trackers: false, adapterD: 1.575 },
    wings: {
      single: '+Y', panels: 5, along: 1.357, across: 3.923, gap: 0.04, yokeLen: 1.8, yoke: 'V', yokeD: 0.07, yokeMat: 'struct_light',
      cellMat: 'cell_brown', cellLines: { du: 0.49, dv: 0.68, w: 0.01, mat: 'gold_metal' }, efficiency: 29, frame: 'struct_light',
      onWing: (Fw) => spp(B, Fw, ccor)
    },
    furniture: { omni: [-1.05, 0.75], sensors: false },
    extra: (B2) => goesRExtras(B2, { hx, hy, hz, ZE })
  })
}
/** 太阳指向平台（翼局部系：y 沿翼展、z 为电池面法向）：矩形框 + SUVI 望远镜筒 + EXIS 盒（GOES-U 再加 CCOR-1 日冕仪筒）。 */
function spp(B, Fw, ccor) {
  const part = { id: 'spp', name: ccor ? '太阳指向平台（SUVI / EXIS / CCOR-1）' : '太阳指向平台（SUVI / EXIS）', role: 'sensor' }
  const names = []
  const add_ = (nm, mat, fn) => {
    const mb = new MB()
    fn(mb)
    B.item(nm, { part, role: 'sensor', mat, mb, F: Fw })
    names.push(nm)
  }
  const y0 = 0.2 + 0.95, y1 = 0.2 + 1.72, xw = 1.55
  add_('spp_frame', 'struct_light', (mb) => {
    const pts = [P(-xw, y0, 0), P(xw, y0, 0), P(xw, y1, 0), P(-xw, y1, 0)]
    for (let i = 0; i < 4; i++) cyl(mb, pts[i], pts[(i + 1) % 4], 0.03, 8, true, true)
    cyl(mb, P(0, y0, 0), P(0, y1, 0), 0.025, 8, true, true)
  })
  add_('spp_instruments', 'mli_black', (mb) => {
    obox(mb, BODY, P(-0.7, (y0 + y1) / 2, 0.12), P(0.55, 0.2, 0.14))      // SUVI 望远镜筒（侧放长盒）
    obox(mb, BODY, P(0.55, (y0 + y1) / 2, 0.1), P(0.3, 0.22, 0.12))       // EXIS
    if (ccor) cyl(mb, P(1.1, (y0 + y1) / 2, 0.02), P(1.1, (y0 + y1) / 2, 0.55), 0.11, 16, true, true)   // CCOR-1 日冕仪筒（朝日）
  })
  add_('spp_apertures', 'dark_glass', (mb) => {
    quadPts(mb, P(-0.2, (y0 + y1) / 2 - 0.12, 0.262), P(0.0, (y0 + y1) / 2 - 0.12, 0.262), P(0.0, (y0 + y1) / 2 + 0.12, 0.262), P(-0.2, (y0 + y1) / 2 + 0.12, 0.262), Z)
    quadPts(mb, P(0.45, (y0 + y1) / 2 - 0.1, 0.222), P(0.65, (y0 + y1) / 2 - 0.1, 0.222), P(0.65, (y0 + y1) / 2 + 0.1, 0.222), P(0.45, (y0 + y1) / 2 + 0.1, 0.222), Z)
  })
  B.point('spp', 72 + 30 + (ccor ? 25 : 0), toW(Fw, P(0, (y0 + y1) / 2, 0.1)))
  return names
}

function goesRExtras(B, { hx, hy, hz, ZE }) {
  // 对地平台 EPP：隔振支柱 + 黑色 MLI 平台板
  const gE = group(B, 'epp', '对地平台 EPP', 'bus')
  obox(gE.mb('mli_black'), BODY, P(0, 0, ZE - 0.06), P(1.35, 0.98, 0.06))
  for (const sx of [1, -1]) for (const sy of [1, -1]) cyl(gE.mb('titanium'), P(sx * 1.1, sy * 0.75, hz + 0.012), P(sx * 1.1, sy * 0.75, ZE - 0.12), 0.05, 12, false, false)
  for (const sx of [1, -1]) addStarTracker(gE, { base: P(-1.05, sx * 0.55, ZE), dir: nrm(P(-0.35, sx * 0.25, -0.15 + 0.5)), up: P(0, 0, 1), box: [0.16, 0.16, 0.12], dB: 0.13, lB: 0.2, bodyMat: 'struct_light' })
  gE.flush()
  B.point('epp', 60, P(0, 0, ZE - 0.06))
  // ABI（−Y 半，扫描口朝地、辐冷朝北）
  instrument(B, { name: 'abi', title: '先进基线成像仪 ABI', c: P(0.05, -0.42, ZE + 0.62), size: [2.1, 1.05, 1.24], mat: 'mli_black',
    aperture: { dir: Z, w: 0.62, h: 0.48, shade: 0.28, shadeMat: 'mli_silver' }, cooler: { dir: P(0, -1, 0), w: 1.1, h: 0.95 }, massKg: 450 })
  // GLM（+Y 半）：棱台底座 + 锥形镜筒（高 1.50 m、底宽 0.635 m）+ 朝南辐冷板
  const gG = group(B, 'glm', '静止轨道闪电成像仪 GLM', 'sensor')
  const gb = P(0.75, 0.42, ZE)
  obox(gG.mb('mli_black'), BODY, add(gb, P(0, 0, 0.28)), P(0.318, 0.318, 0.28))
  cone(gG.mb('mli_silver'), add(gb, P(0, 0, 0.56)), 0.3, add(gb, P(0, 0, 1.5)), 0.2, 24, false, false)
  cone(gG.mb('dark_glass'), add(gb, P(0, 0, 1.49)), 0.0, add(gb, P(0, 0, 1.5)), 0.19, 24, false, true)
  quadPts(gG.mb('radiator'), P(0.2, 0.96, ZE + 0.15), P(1.25, 0.96, ZE + 0.15), P(1.25, 0.96, ZE + 1.25), P(0.2, 0.96, ZE + 1.25), P(0, 1, 0))
  quadPts(gG.mb('mli_black'), P(0.2, 0.955, ZE + 0.15), P(0.2, 0.955, ZE + 1.25), P(1.25, 0.955, ZE + 1.25), P(1.25, 0.955, ZE + 0.15), P(0, -1, 0))
  gG.flush()
  B.point('glm', 67, add(gb, P(0, 0, 0.6)))
  B.ap('glm', add(gb, P(0, 0, 1.5)), Z)
  // +X：二轴万向 X 频段反射面（对地板侧、靠北）
  gimbalDish(B, { name: 'xband', title: 'X 频段反射面', base: P(hx + 0.012, -0.45, hz - 0.35), n: P(1, 0, 0), look: nrm(P(0.35, 0, 1)), D: 1.1, fd: 0.38, postH: 0.38, mat: 'reflector' })
  // +X：可盘绕桁架磁强计杆（内 / 外两个探头：离星 6.35 / 8.56 m）
  const gM = group(B, 'mag_boom', '磁强计杆', 'boom')
  const r0 = P(hx + 0.012, 0.55, 0.35), r1 = P(hx + 8.56, 0.55, 0.35)
  latticeBoom(gM.mb('white_paint'), r0, r1, { r: 0.09, bay: 0.42, rod: 0.007 })
  obox(gM.mb('mli_black'), BODY, add(r0, P(0.12, 0, 0)), P(0.12, 0.2, 0.2))
  for (const d of [6.35, 8.56]) cyl(gM.mb('mli_silver'), P(hx + d - 0.08, 0.55, 0.35), P(hx + d + 0.08, 0.55, 0.35), 0.1, 16, true, true)
  gM.flush()
  B.rod('mag_boom_mast', r0, r1)
  // −X：天线翼 AWA（展开后朝地）：UHF 四螺旋（外半）+ GRB 双喇叭 + L/S 喇叭（内半）
  const gA = group(B, 'awa', '天线翼 AWA', 'feed')
  const ac = P(-hx - 1.05, 0.05, hz + 0.25)
  obox(gA.mb('mli_silver'), BODY, ac, P(0.65, 1.1, 0.05))
  truss(gA.mb('struct_light'), [P(-hx - 0.012, 0.6, hz - 0.15), add(ac, P(0.55, 0.55, -0.05))], 0.035, 10)
  truss(gA.mb('struct_light'), [P(-hx - 0.012, -0.5, hz - 0.15), add(ac, P(0.55, -0.55, -0.05))], 0.035, 10)
  for (const dx of [-0.32, 0.0]) for (const dy of [-0.5, -0.12]) {
    const b = add(ac, P(dx - 0.05, dy - 0.25, 0.05))
    helixElement(gA.mb('gold_metal'), gA.mb('white_paint'), b, Z, { R: 0.06, pitch: 0.07, turns: 3.2, wire: 0.006, cupR: 0.13, cupH: 0.08, support: true })
  }
  for (const [dy, ra] of [[0.35, 0.21], [0.78, 0.15]]) horn(gA.mb('aluminum'), add(ac, P(0.1, dy, 0.05 + 1.5 * ra)), Z, ra, 1.5 * ra, 28)
  gA.flush()
  B.point('awa', 35, ac)
  B.ap('awa_grb', add(ac, P(0.1, 0.35, 0.4)), Z)
  // SEISS 粒子探测器柜（背地端 −Y 侧）
  const gS = group(B, 'seiss', '空间环境原位探测组 SEISS', 'sensor')
  obox(gS.mb('mli_silver'), BODY, P(hx - 0.45, -hy - 0.27, -hz + 0.4), P(0.38, 0.26, 0.3))
  gS.flush()
}

// ───────────────────────────── Meteosat 第二代（MSG，自旋稳定太阳鼓） ─────────────────────────────
//
// 鼓径 3.2 m、鼓高 2.4 m、连天线与底部锥罩总高 3.7 m（ESA）；8 块 2.4 × 1.25 m 弧形硅电池板围成鼓，其一开 SEVIRI 光窗（ESA）；
// 自旋轴平行地球南北轴、100 rpm（ESA / eoPortal）。顶端天线平台：居中 L 频段电子消旋阵（银色栅格圆柱 ≈ Ø1.3 × 0.5 m）+ 白色顶盘
// + 黑色 S 频段桅杆，外缘一圈镀金短杆交叉偶极子（UHF，≈16 根 × 0.49 m）；鼓侧铜框跑道形光窗（≈0.75 × 1.3 m，偏顶端）与金色 MLI 方窗
// （≈0.58 × 0.95 m）；底端收窄的银色锥罩（SEVIRI 被动制冷器）——几何按 ESA 实拍「MSG satellite undergoing testing」量（IMG）。
// 天线端朝北（−Y）为示意（原文只说「upper part」）。
function buildMsg(B) {
  spinnerSat(B, {
    D: 3.2, H: 2.4, facets: 40, top: -1, panels: 8, cellMat: 'cell_violet', rimMat: 'mli_gold', efficiency: 15,
    window: { w: 0.75, h: 1.3, y: -0.28 },
    patches: [{ az: 90, y: 0.15, w: 0.58, h: 0.95, mat: 'mli_gold' }, { az: -95, y: 0.15, w: 0.5, h: 0.9, mat: 'mli_silver' }],
    eda: { d: 1.3, h: 0.5, discD: 1.5, mastD: 0.28, mastH: 0.42, rodH: 0.2 },
    dipoles: { n: 16, h: 0.49, r: 1.42 },
    shade: { d0: 1.3, d1: 0.6, h: 0.32 }
  })
}

// ───────────────────────────── Meteosat 第三代（MTG-I / MTG-S，OHB 通用平台） ─────────────────────────────
//
// 收拢 2.3 × 2.8 × 5.2 m（EUMETSAT；MTG-S 2280 × 2760 × 5170 mm），发射轴 = Z、对地端是主仪器；平台体取 2.8（X）× 2.3（Y）× 3.6（Z）m
// （扣对地端仪器与背地端发动机）。两翼各一块整板（ESA / TAS 实拍），太阳阵总面积 10.7 m²（ESA）→ 单板 ≈ 3.1 × 1.7 m（长边沿翼展，按照片长宽比）；
// Y 形连接架 ≈ 1.3 m（渲染量）。黑色 MLI 本体、南北散热面银白；侧边二轴机构上一副 ≈1 m Ka 数传碟；背地端发动机带圆形隔热罩。
// MTG-I：FCI 白色大遮光筒 + LI 四镜筒 + DCS / GEOSAR 天线盒；MTG-S：IRS 望远镜遮光锥 + Sentinel-4 UVN。
function buildMtg(B, { sounder }) {
  const hx = 1.4, hy = 1.15, hz = 1.8, ZN = hz + 0.012
  buildGeo(B, {
    bus: { x: 2 * hx, y: 2 * hy, z: 2 * hz, faces: { east: 'mli_black', west: 'mli_black', deck: 'mli_black', aft: 'mli_black', band: 'mli_black' }, ribs: 3, trackers: 'aft', adapterD: 1.194 },
    wings: { panels: 1, along: 3.1, across: 1.7, yokeLen: 1.3, yoke: 'V', yokeD: 0.05, yokeMat: 'struct_light', zRoot: 0.2, efficiency: 28 },
    furniture: { omni: [-hx * 0.75, -hy * 0.75], sensors: false },
    extra: (B2) => {
      // 背地端：远地点发动机圆形隔热罩
      const gH = group(B2, 'lae_shield', '远地点发动机隔热罩', 'thruster')
      cyl(gH.mb('mli_black'), P(0, 0, -hz - 0.02), P(0, 0, -hz - 0.06), 0.62, 36, false, true)
      gH.flush()
      if (!sounder) {
        // FCI：仪器体 + 白色大遮光筒（对地）
        instrument(B2, { name: 'fci', title: '灵活组合成像仪 FCI', c: P(-0.55, -0.1, ZN + 0.45), size: [1.5, 1.6, 0.9], mat: 'mli_black', massKg: 390 })
        const gF = group(B2, 'fci_shade', 'FCI 遮光筒', 'sensor')
        cyl(gF.mb('white_paint'), P(-0.55, -0.1, ZN + 0.9), P(-0.55, -0.1, ZN + 2.0), 0.62, 36, false, false)
        frustum(gF.mb('black_paint'), P(-0.55, -0.1, ZN + 0.9), 0.6, P(-0.55, -0.1, ZN + 2.0), 0.6, 36, false, false, true)
        disc(gF.mb('dark_glass'), P(-0.55, -0.1, ZN + 0.92), Z, 0.6, 36)
        gF.flush()
        B2.ap('fci', P(-0.55, -0.1, ZN + 2.0), Z)
        // LI：光学头盒 + 四个金色镜筒
        instrument(B2, { name: 'li', title: '闪电成像仪 LI', c: P(0.85, 0.1, ZN + 0.45), size: [0.72, 1.2, 0.9], mat: 'mli_black', massKg: 90 })
        const gL = group(B2, 'li_barrels', 'LI 四镜筒', 'sensor')
        for (const [dx, dy] of [[-0.17, -0.3], [0.17, -0.3], [-0.17, 0.3], [0.17, 0.3]]) {
          cyl(gL.mb('gold_metal'), P(0.85 + dx, 0.1 + dy, ZN + 0.9), P(0.85 + dx, 0.1 + dy, ZN + 1.42), 0.13, 20, false, true)
          disc(gL.mb('dark_glass'), P(0.85 + dx, 0.1 + dy, ZN + 1.425), Z, 0.11, 20)
        }
        gL.flush()
        B2.ap('li', P(0.85, 0.1, ZN + 1.45), Z)
        // DCS / GEOSAR 天线盒（西侧挂在本体外，口面朝地）
        instrument(B2, { name: 'dcs', title: 'DCS / GEOSAR 天线', c: P(-hx - 0.55, 0.3, hz - 0.35), size: [1.0, 0.95, 0.6], mat: 'mli_black', aperture: { dir: Z, w: 0.85, h: 0.8 } })
      } else {
        // IRS：仪器体 + 遮光锥（对地）
        instrument(B2, { name: 'irs', title: '红外探测仪 IRS', c: P(-0.3, -0.05, ZN + 0.63), size: [1.44, 1.3, 1.25], mat: 'mli_black', massKg: 470 })
        const gI = group(B2, 'irs_shade', 'IRS 遮光锥', 'sensor')
        cone(gI.mb('mli_silver'), P(-0.3, -0.05, ZN + 1.25), 0.33, P(-0.3, -0.05, ZN + 2.05), 0.5, 32, false, false)
        frustum(gI.mb('black_paint'), P(-0.3, -0.05, ZN + 1.25), 0.31, P(-0.3, -0.05, ZN + 2.05), 0.48, 32, false, false, true)
        disc(gI.mb('dark_glass'), P(-0.3, -0.05, ZN + 1.27), Z, 0.31, 32)
        gI.flush()
        B2.ap('irs', P(-0.3, -0.05, ZN + 2.05), Z)
        // Sentinel-4 UVN（金色包膜）
        instrument(B2, { name: 'uvn', title: 'Sentinel-4 UVN 光谱仪', c: P(0.85, 0.35, ZN + 0.3), size: [0.8, 0.7, 0.6], mat: 'mli_gold', aperture: { dir: Z, w: 0.3, h: 0.2, shade: 0.12 }, massKg: 200 })
      }
      // Ka 数传碟：东侧短臂 + 二轴机构（MTG-I 中部、MTG-S 靠背地端）
      gimbalDish(B2, { name: 'ka_dl', title: 'Ka 数传天线', base: P(hx + 0.012, -0.3, sounder ? -hz + 0.6 : 0.2), n: P(1, 0, 0), look: nrm(P(0.25, 0, 1)), D: 1.0, fd: 0.38, postH: 0.55, mat: 'reflector' })
    }
  })
}

// ───────────────────────────── 向日葵 8 / 9 号（MELCO DS2000） ─────────────────────────────
//
// 展开后整星 5.2（X）× 8.0（Y）× 5.3（Z）m（eoPortal）：南侧单翼（Y 向 8.0 m = 本体 + 单翼），对地板上 AHI 成像仪（辐冷朝北），东侧二轴 Ka 数传碟。
// 本体比例、翼板数、AHI 外形为示意。
function buildHimawari(B) {
  const hx = 1.2, hy = 1.3, hz = 1.5
  buildGeo(B, {
    bus: { x: 2 * hx, y: 2 * hy, z: 2 * hz, faces: { east: 'mli_gold', west: 'mli_gold', deck: 'mli_gold', aft: 'mli_black', band: 'mli_gold' }, ribs: 3, trackers: 'aft' },
    wings: { single: '+Y', panels: 2, along: 2.35, across: 2.4, yokeLen: 0.55, yoke: 'V', yokeD: 0.05 },
    furniture: { omni: [-hx * 0.7, -hy * 0.6], sensors: false },
    extra: (B2) => {
      instrument(B2, { name: 'ahi', title: '先进葵花成像仪 AHI', c: P(-0.25, -0.2, hz + 0.6), size: [1.4, 1.2, 1.15], mat: 'mli_silver',
        aperture: { dir: Z, w: 0.5, h: 0.45, shade: 0.3 }, cooler: { dir: P(0, -1, 0), w: 0.9, h: 0.8 }, massKg: 330 })
      gimbalDish(B2, { name: 'ka_dl', title: 'Ka 数传天线', base: P(hx + 0.012, -0.3, hz - 0.4), n: P(1, 0, 0), look: nrm(P(0.3, 0, 1)), D: 0.9, fd: 0.38, postH: 0.4, mat: 'reflector' })
    }
  })
}

// ───────────────────────────── 型号表 ─────────────────────────────

const goesFacts = (u) => ({
  massKg: u ? F(5000, 'kg', S.NOAA_SC, { quote: 'GOES-U mass at launch (fueled): 11,023 lbs (5,000 kg)' })
    : F(5192, 'kg', S.NOAA_SC, { quote: 'GOES-R, S, T mass at launch (fueled): 11,446 lbs (5,192 kg)' }),
  platform: F('Lockheed Martin A2100', '', S.GOESR_BOOK, { quote: 'The GOES-R series satellite is based on the Lockheed Martin A2100 bus.' }),
  stowed: F([6.129, 3.880, 2.688], 'm', S.GOESR_BOOK, { quote: 'Height 6129.27 mm (241.31 in) Width 3879.60 mm (152.74 in) Depth 2687.57 mm (105.81 in)', note: '整星收拢包络（含 EPP 仪器、收拢太阳翼与天线翼）' }),
  wing: F('单翼、+Y（南）侧', '', S.GOESR_BOOK, { quote: 'Assembly (SAWA), is folded against the +Y side of the spacecraft bus' }),
  panels: F({ n: 5, size: [1.357, 3.923] }, 'm', S.GOESR_BOOK, { quote: 'Panels 5 panels, 135.7 cm x 392.3 cm each', note: '392.3 cm 为横宽（数据手册图 15-1 / 图 11-3 实拍判定）' }),
  magBoom: F({ inboard: 6.35, outboard: 8.56 }, 'm', S.GOESR_BOOK, { quote: 'the outboard magnetometer is deployed 8.56 meters', note: '同段原文「The inboard magnetometer is deployed 6.35」；杆装 +X 侧' }),
  xband: F('+X 侧', '', S.GOESR_BOOK, { quote: 'controlled X-band reflector, mounted on the +X side of the spacecraft which is blanketed as well.' }),
  awa: F('−X 侧、展开后朝 +Z', '', S.GOESR_BOOK, { quote: 'The antenna wing assembly (AWA) is mounted on the –X side and faces in the +Z direction after' }),
  epp: F('对地板上方隔振平台（ABI / GLM / 星敏）', '', S.GOESR_BOOK, { quote: 'The Earth Pointing Platform is mounted on top of the nadir deck.' }),
  glm: F({ heightM: 1.5, baseM: 0.635, massKg: 67 }, '', S.GOESR_BOOK, { quote: 'Mass (Sensor Unit) 67 kg', note: '高 59 in / 底宽 25 in 见数据手册图 4-4 尺寸标注' }),
  sideMli: F('±X 侧壁 MLI', '', S.GOESR_BOOK, { quote: 'The +X and –X sides of the spacecraft are blanketed with MLI.' }),
  bus: IMG([3.0, 2.25, 2.6], 'm', BOOK_FIG(122), '图 9-5 近正视 −Y 面：本体宽高 ≈ 275 : 235 px；宽按收拢 Width 3.88 m 扣两侧收拢件，深按 Depth 2.69 m 扣收拢太阳翼'),
  yoke: IMG(1.8, 'm', BOOK_FIG(161), '图 15-1：以内侧板沿翼展 1.357 m 为标度量连接架 + SPP 段 ≈ 1.35 倍板宽'),
  xbandD: IMG(1.1, 'm', BOOK_FIG(161), '图 15-1 / 图 9-5：反射面椭圆长轴与本体侧板比'),
  look: IMG('黑色 MLI 本体夹银色块、深褐电池面带金色汇流条', '', S.GOESR_RENDER, '官方渲染 + 数据手册图 11-3 实拍'),
  ...(u ? { ccor: F('SPP 上加装 CCOR-1', '', S.NOAA_SC, { quote: 'Includes EXIS and SUVI on GOES-R/S/T and EXIS, SUVI, and CCOR on GOES-U' }) } : {})
})

const msgFacts = {
  massKg: F(2037, 'kg', S.VA207, { rep: 'MSG-3（Meteosat-10）', quote: 'Mass Total mass at lift-off: 2,037 kg', note: 'MSG-4 为 2043 kg（VA224）；ESA：每颗发射质量约两吨' }),
  drum: F({ D: 3.2, H: 2.4 }, 'm', S.ESA_MSG_FACTS, { quote: '2.4 m high, 3.2 m diameter and 2000 kg in geostationary transfer orbit' }),
  height: F(3.7, 'm', S.ESA_MSG1_IMG, { quote: 'Meteosat Second Generation is a 3.7 m high, cylindrically-shaped satellite' }),
  spin: F(100, 'rpm', S.ESA_MSG_FACTS, { quote: 'spin stabilized at 100 RPM' }),
  spinAxis: F('∥ 地球南北轴', '', S.EOP_MSG, { quote: 'The spin axis is nominally oriented parallel to the north-south axis of the Earth.', confidence: 'secondary' }),
  panels: F({ n: 8, size: [2.4, 1.25] }, 'm', S.ESA_MSG_ARCH, { quote: 'The MSG solar array is built from eight curved panels (2.4 m high and 1.25 m wide) linked in a drum skirt around the satellite body.' }),
  cutout: F('一块板开光窗', '', S.ESA_MSG_ARCH, { quote: 'One of the panels has a cut-out for the instrument aperture.' }),
  cells: F('硅电池', '', S.EOP_MSG, { quote: 'The solar network utilizes 7854 Silicon High Eta cells delivering a beginning of life power of 740 W.', confidence: 'secondary' }),
  window: IMG([0.75, 1.3], 'm', S.MSG_TEST_IMG, '实拍：跑道形缺口宽 ≈ 253 px（按 cos24° 还原）、高 ≈ 480 px，按鼓径 3.2 m ≈ 1085 px、鼓高 2.4 m ≈ 885 px 换算'),
  antennas: IMG({ eda: [1.3, 0.5], disc: 1.5, dipoles: 16, dipoleH: 0.49, mast: [0.28, 0.62] }, 'm', S.MSG_TEST_IMG, '实拍：同上标度量电子消旋阵 / 顶盘 / 偶极子杆 / 桅杆'),
  shade: IMG({ d0: 1.3, d1: 0.6, h: 0.32 }, 'm', S.MSG_TEST_IMG, '实拍：鼓底锥罩外廓；高按总高 3.7 m 扣鼓高与顶端天线核过')
}

const mtgCommon = {
  stowed: F([2.3, 2.8, 5.2], 'm', S.EUM_MTGI, { quote: 'Dimensions 2.3m x 2.8m 5.2m (launch configuration)' }),
  bus: F('OHB LUXOR 通用平台', '', S.S4_SAT, { quote: 'Luxor bus from OHB-System GmbH' }),
  array: F(10.7, 'm²', S.S4_SAT, { quote: '2 kW, solar array of 10.7 m2' }),
  twoWings: F(2, '翼', S.EOP_MTG, { quote: 'A two-winged satellite configuration is selected, which minimizes the solar momentum build-up', confidence: 'secondary' }),
  ka: F('Ka 数传天线：折叠发射、二轴指向', '', S.EOP_MTG, { quote: 'The latter is folded at launch and then deployed once in orbit. It is mounted on a two-axis pointing mechanism', confidence: 'secondary' }),
  panel: IMG([3.1, 1.7], 'm', S.ESA_MTGI_SA, '每翼一块整板（渲染 / TAS 实拍）；面积 10.7 m² ÷ 2、长宽比 ≈1.9 推算'),
  yoke: IMG(1.3, 'm', S.ESA_MTGI_SA, 'ESA 2022 渲染 Y 形连接架与板长边比'),
  kaD: IMG(1.0, 'm', S.EOP_MTG, 'TAS 构型图（eoPortal 图 6）碟面长轴与本体侧面高之比'),
  busBox: IMG([2.8, 2.3, 3.6], 'm', S.ESA_MTGI_SA, '收拢包络扣对地端仪器（≈1.2 m）与背地端发动机（≈0.4 m）'),
  look: IMG('黑色 MLI 本体、银白南北散热面', '', S.ESA_MTGI_SA, 'ESA 2022 渲染 / TAS 洁净间实拍')
}
const mtgiFacts = {
  ...mtgCommon,
  massKg: F(3760, 'kg', S.VA259, { quote: 'MASS AT LAUNCH 3.76 tonnes' }),
  fci: F([1.57, 1.72, 2.2], 'm', S.EOP_MTG, { quote: 'Volume: 1.57 m x 1.72 m x 2.2 m', confidence: 'secondary', note: 'FCI 安装包络' }),
  li: F([0.718, 1.2, 1.456], 'm', S.EOP_MTG, { quote: 'LI optical head envelope 718 mm x 1200 mm x 1456 mm', confidence: 'secondary' })
}
const mtgsFacts = {
  ...mtgCommon,
  massKg: F(3600, 'kg', S.S4_SAT, { quote: 'Launch mass 3600 kg', note: 'EUMETSAT 事实页另给 3800 kg（含 2 t 推进剂，MTG 通用口径）' }),
  stowed: F([2.28, 2.76, 5.17], 'm', S.S4_SAT, { quote: 'Stowed dimensions 2280 x 2760 x 5170 mm' }),
  irs: F([1.44, 1.3, 1.25], 'm', S.EOP_MTG, { quote: 'Volume: 1.44 m x 1.30 m x 1.25 m', confidence: 'secondary', note: '方案期包络' })
}

const common = { family: 'geo-wx', maker: 'Lockheed Martin', tags: ['geo', 'weather', 'goes'] }
export const GEO_WX_MODELS = [
  { ...common, id: 'goes-r', rev: 1, title: 'GOES-R series (GOES-16/17/18)', titleZh: 'GOES-R 系列（GOES-16 / 17 / 18）', basis: 'A2100，南侧单翼 5 板 + 太阳指向平台，ABI / GLM', aliases: ['GOES-R', 'GOES-S', 'GOES-T', 'GOES-16', 'GOES-17', 'GOES-18'],
    massKg: goesFacts(false).massKg, facts: goesFacts(false), build: (B) => buildGoesR(B, { ccor: false }) },
  { ...common, id: 'goes-u', rev: 1, title: 'GOES-U (GOES-19)', titleZh: 'GOES-U（GOES-19）', basis: '同 GOES-R，太阳指向平台加 CCOR-1 日冕仪', aliases: ['GOES-U', 'GOES-19'],
    massKg: goesFacts(true).massKg, facts: goesFacts(true), build: (B) => buildGoesR(B, { ccor: true }) },
  { id: 'msg', rev: 1, family: 'geo-wx', maker: 'Thales Alenia Space（原 Alcatel Space）', title: 'Meteosat Second Generation (MSG)', titleZh: 'Meteosat 第二代（MSG）',
    basis: '自旋稳定太阳鼓 Ø3.2 × 2.4 m，SEVIRI', tags: ['geo', 'weather', 'meteosat', 'spinner'], aliases: ['MSG', 'MSG-2', 'MSG-3', 'MSG-4', 'METEOSAT-9', 'METEOSAT-10', 'METEOSAT-11'],
    bodyCells: true, massKg: msgFacts.massKg, facts: msgFacts, build: buildMsg },
  { id: 'mtg-i', rev: 1, family: 'geo-wx', maker: 'Thales Alenia Space（平台 OHB）', title: 'MTG-I (Meteosat-12)', titleZh: 'Meteosat 第三代成像星（MTG-I）', basis: 'OHB 通用平台，FCI + LI',
    tags: ['geo', 'weather', 'meteosat'], aliases: ['MTG-I1', 'METEOSAT-12'], massKg: mtgiFacts.massKg, facts: mtgiFacts, build: (B) => buildMtg(B, { sounder: false }) },
  { id: 'mtg-s', rev: 1, family: 'geo-wx', maker: 'OHB System', title: 'MTG-S (Sentinel-4)', titleZh: 'Meteosat 第三代探测星（MTG-S）', basis: 'OHB 通用平台，IRS + Sentinel-4 UVN',
    tags: ['geo', 'weather', 'meteosat'], aliases: ['MTG-S1', 'SENTINEL-4'], massKg: mtgsFacts.massKg, facts: mtgsFacts, build: (B) => buildMtg(B, { sounder: true }) },
  { id: 'himawari', rev: 1, family: 'geo-wx', maker: '三菱电机（MELCO）', title: 'Himawari-8 / 9', titleZh: '向日葵 8 号 / 9 号', basis: 'DS2000，南侧单翼，AHI 成像仪',
    tags: ['geo', 'weather', 'himawari'], aliases: ['HIMAWARI-8', 'HIMAWARI-9'],
    massKg: F(3500, 'kg', 'https://space.skyrocket.de/doc_sdat/himawari-8.htm', { quote: 'Mass: ~3500 kg; 1300 kg (dry)', confidence: 'secondary' }),
    facts: {
      massKg: F(3500, 'kg', 'https://space.skyrocket.de/doc_sdat/himawari-8.htm', { quote: 'Mass: ~3500 kg; 1300 kg (dry)', confidence: 'secondary' }),
      platform: F('DS2000', '', 'https://space.skyrocket.de/doc_sdat/himawari-8.htm', { quote: 'Configuration: DS-2000', confidence: 'secondary' }),
      deployed: F([5.2, 8.0, 5.3], 'm', 'https://www.eoportal.org/satellite-missions/himawari-8-9', { quote: 'The overall size of the deployed spacecraft is 5.2 m (X-axis), 8.0 m (Y-axis), and 5.3 m (Z-axis)', confidence: 'secondary' }),
      shape: { value: '本体比例、翼板数、AHI 外形与 Ka 天线位置为示意', unit: '', source: 'illustrative', url: null }
    },
    build: buildHimawari }
]
