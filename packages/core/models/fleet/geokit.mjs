// GEO 卫星精模的共用造型件（2026-10-07）。
//
// 2026-10-07 用户：「现在的 GEO 卫星都是统一的模型，我希望对于比较有名的 GEO 卫星模型进行参数化，和 GPS GLONASS 那些一样」。
// GEO 星绝大多数是三轴稳定箱形平台：结构盒 + 南北散热面 + 南北太阳翼 + 东西侧壁可展开反射面 + 对地板天线塔，差别在比例、
// 翼板数、反射面的数量 / 口径 / 摆法、特殊大件（大型网状天线、电推臂、气象仪器）。所以这里把这些件做成参数化造型件，
// 各型号文件（geo-*.mjs）用 buildGeo(B, cfg) 一把画出，个别特殊件（自旋圆柱、气象仪器……）再在 cfg.extra 里自己补。
//
// ★ 坐标：本平台本体系——+Z 对地（对地板 Earth deck）、+X 东（速度方向）、+Y 南、原点 = 平台结构盒几何中心。
//   太阳翼在南北（±Y）面、绕 Y 转；东西（±X）侧壁挂可展开反射面、馈源在对地板东 / 西缘；背地面（−Z）是对接环与远地点发动机。
// ★ 偏置抛物面复用 meshKit.paraLayout（与参数化模板 paramBus 同一套公式）：焦点 F、视轴 a（顶点 → 焦点 = 波束方向）、
//   偏置方向 u（⟂ a，自母轴指向口径中心）、焦距 f、偏置量 dc。侧挂缺省：F 在对地板东 / 西缘内缩 inset、高出 standoff；
//   a = +Z；u = 朝外（±X）；dc = D/2 + inset + gap（反射面内缘离侧壁留 gap）——展开后反射面立在侧壁外、口面斜朝馈源，
//   与在轨照片里「东西两侧各挂一副、口面朝地」的外观一致。
// ★ 数值口径：平台体尺寸、翼板数 / 板尺寸、反射面口径 / 数量这些平台级数据由型号文件逐条带出处给；
//   这里的缺省（板厚、桁杆粗细、喇叭大小、塔宽、焦径比、偏置净空……）都是造型示意值（任何平台都不公开）。
// ★ 节点预算：同一部件同一材质并成一个节点（parts.group），一颗 GEO 星控制在 ≲ 60 个节点（单测上限 70，含挂点）。
//
// 导出：
//   buildGeo(B, cfg)        整星（平台体 → 太阳翼 → 侧挂反射面 → 对地板反射面 → 网状大天线 → 电推臂 → 对地板小件 → cfg.extra）
//   geoBus / geoWings / sideReflector / deckTower / deckReflector / meshReflector / epArms / deckFurniture / gimbalSpot / feedCluster / dishShell2
//   instrument / boom       气象 / 科学仪器盒（口径窗 + 遮光檐 + 辐冷板）、伸杆（磁强计杆 / 配平帆）
//   spinnerSat              自旋稳定圆柱星（体装电池 + 设备带扫描窗 + 消旋天线）
//   yokeForSpan             按有出处的在轨翼展反推轭长
//   GEO_DEFAULTS            造型示意缺省（只读）

import { MB, BODY, frame, frameZX, toW, add, sub, scl, nrm, madd, dot, cross, len, reject, rotV, bevelBox, obox, prism, ngon, cyl, cone, disc, ring, truss, hinge, quadPts, tri, perpPair, horn } from './kit.mjs'
import { group, wing, skinBox, gimbalDish, nozzle } from './parts.mjs'
import { paraLayout, frustum } from '../meshKit.mjs'
// 星上硬件造型库（2026-10-08）：喇叭 / 馈电链 / 钟形喷管 / 霍尔推力器 / 星敏 / 地敏 / 测控天线 / 对接环 / 反射面背架与展开机构
import { feedHorn as hwFeedHorn, feedChain as hwFeedChain, bellNozzle, rcsPod, hallThruster, starTrackerHead, wedgeMount, earthSensor, lvRing, reflectorBacking, adtmBlock } from '../hardware.mjs'
import { feedSupportRods, ttcAntenna, geoSensorLayout } from '../paramBus.mjs'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const P = (x, y, z) => [x, y, z]
const Z = [0, 0, 1]

/** 造型示意缺省（没有出处的工程细节；型号文件可逐项覆盖）。 */
export const GEO_DEFAULTS = Object.freeze({
  bevel: 0.03, skinOff: 0.012,
  bandDeck: 0.18, bandAft: 0.22,          // 南北散热面上下两端的 MLI 包边带高
  adapterD: 1.194, adapterH: 0.12,        // 星箭对接环（常见 Ø1194 mm 档）
  laeExitD: 0.3, laeLen: 0.35,            // 远地点发动机喷管
  sadaLen: 0.2, sadaD: 0.3,               // 太阳翼驱动机构外露段
  panelT: 0.03, wingGap: 0.05, yokeD: 0.06,
  // 侧挂反射面（2026-10-08 按调研：Airbus US 11,858,663 D 2.2–2.7 m 配 F 3.58–4.20 m、母轴到近缘 0.65–1.30 m；Thales「f ≥ 1.5 D」）：
  // 焦径比 1.6、馈源相位中心在东西棱外 8 cm（负内缩）、高出对地板 0.25 m、内缘离侧壁 0.93 m（母轴到近缘 0.85 m）
  fdSide: 1.6, inset: -0.08, standoff: 0.25, gap: 0.93,
  fdDeck: 0.6, towerW: 0.5,                              // 对地板塔馈反射面
  shell: 0.02                                            // 实面反射面边缘厚
})
const G = GEO_DEFAULTS
// 硬件造型件进精模部件组时的材质归并（节点预算：同一部件同一材质一个节点，GEO 星 ≤ 70 个节点）：小件的镀金 / 黑漆 / 玻璃并进组里已有的材质
// 馈源组：喇叭外壳 / 馈电链 / 支架都裹金色 MLI（在轨多如此），口环并进 MLI，喇叭内腔与锗膜遮阳盖并进碳纤维黑——单喇叭两个节点
const FEED_MAT = Object.freeze({ gold_metal: 'mli_gold', aluminum: 'mli_gold', black_paint: 'carbon', sunshield: 'carbon' })
const DECK_MAT = Object.freeze({ gold_metal: 'mli_gold', black_paint: 'carbon', glass: 'carbon', titanium: 'aluminum', radiator: 'aluminum' })
const PROP_MAT = Object.freeze({ black_paint: 'dark_metal', gold_metal: 'mli_gold', aluminum: 'titanium' })
const HALL_MAT = Object.freeze({ aluminum: 'dark_metal', black_paint: 'dark_metal', gold_metal: 'titanium' })

// ───────────────────────────── 平台体 ─────────────────────────────

/**
 * 平台结构盒 + 分面热控 + 南北散热面（上下 MLI 包边带）+ 对接环 + 远地点发动机 + 姿控推力器 + 星敏，并登记平台体质量元。
 * o = {
 *   x, y, z                 结构盒全尺寸（东西 × 南北 × 对地轴，m）
 *   faces                   {east, west, deck, aft, band}（材质键；缺省东西 / 对地 / 背地金色 MLI，散热面包边金色 MLI）
 *   ns                      南北面：'radiator'（OSR，缺省）| 材质键（整面同一材质）
 *   bandDeck / bandAft      散热面上 / 下包边带高（m）；ribs：散热面竖向热管压条数（0 = 不画）
 *   adapterD / adapterH     对接环外径 / 高（0 = 不画）；lae：{exitD, len} | false；rcs：false 关姿控推力器
 *   trackers                'north'（缺省：北面靠对地端两只，斜指北天）| 'aft' | false
 *   deployRad               可展开散热板 [{z, w, l, tilt?, x?, mat?}]：南北面高度 z 处各铰一块，向外伸 l、宽 w（波音 702 等）
 *   busMassKg               平台体质量元初值（finishModel 按整星质量吃余量，缺省 1500）
 * }
 * @returns {{h:number[], ZN:number, ZA:number}}
 */
export function geoBus(B, o) {
  const h = [o.x / 2, o.y / 2, o.z / 2], ZN = h[2], ZA = -h[2]
  const f = { east: 'mli_gold', west: 'mli_gold', deck: 'mli_gold', aft: 'mli_gold', band: 'mli_gold', ...(o.faces || {}) }
  const g = group(B, 'bus', '星体', 'bus')
  bevelBox(g.mb(o.structMat || 'struct_grey'), BODY, P(0, 0, 0), h, isNum(o.bevel) ? o.bevel : G.bevel)
  skinBox(g, BODY, P(0, 0, 0), h, { '+x': f.east, '-x': f.west, '+z': f.deck, '-z': f.aft })
  // 南北面：OSR 散热面占中段，上下两端各一道 MLI 包边带（在轨照片里散热面上下沿都压着一圈金色 / 黑色毯子）
  const off = G.skinOff, bd = isNum(o.bandDeck) ? o.bandDeck : G.bandDeck, ba = isNum(o.bandAft) ? o.bandAft : G.bandAft
  const ns = o.ns || 'radiator'
  for (const s of [1, -1]) {
    const y = s * (h[1] + off), n = P(0, s, 0), x0 = -h[0] + 0.01, x1 = h[0] - 0.01
    const zR0 = ZA + ba, zR1 = ZN - bd
    quadPts(g.mb(ns), P(x0, y, zR0), P(x1, y, zR0), P(x1, y, zR1), P(x0, y, zR1), n)
    if (ns === 'radiator') {
      if (bd > 0.005) quadPts(g.mb(f.band), P(x0, y + s * 0.002, zR1), P(x1, y + s * 0.002, zR1), P(x1, y + s * 0.002, ZN - 0.01), P(x0, y + s * 0.002, ZN - 0.01), n)
      if (ba > 0.005) quadPts(g.mb(f.band), P(x0, y + s * 0.002, ZA + 0.01), P(x1, y + s * 0.002, ZA + 0.01), P(x1, y + s * 0.002, zR0), P(x0, y + s * 0.002, zR0), n)
      const ribs = o.ribs | 0
      for (let i = 1; i <= ribs; i++) {
        const x = x0 + (x1 - x0) * i / (ribs + 1)
        obox(g.mb('aluminum'), BODY, P(x, y + s * 0.006, (zR0 + zR1) / 2), P(0.012, 0.006, (zR1 - zR0) / 2 - 0.02), ['+x', '-x', s > 0 ? '+y' : '-y', '+z', '-z'])
      }
    }
  }
  // 可展开散热板（波音 702 等）：南北两面在高度 z 处各铰一块板，向外（±Y）伸出 l、宽 w（沿 X），tilt = 绕 X 轴上翘角（度，0 = 平行对地板）
  for (const d of o.deployRad || []) {
    for (const s of [1, -1]) {
      const t = ((d.tilt || 0) * Math.PI) / 180
      const out = P(0, s * Math.cos(t), Math.sin(t)), nrmv = P(0, -s * Math.sin(t), Math.cos(t))
      const root = P(d.x || 0, s * (h[1] + off), d.z)
      const c = madd(root, out, d.l / 2)
      const F = { o: c, x: [s, 0, 0], y: out, z: nrmv }   // x 随 s 翻号：保持右手系（obox 按 x×y 定面朝向）
      obox(g.mb(d.mat || 'radiator'), F, [0, 0, 0], [d.w / 2, d.l / 2, 0.018], ['+z', '-z'])
      obox(g.mb('struct_light'), F, [0, 0, 0], [d.w / 2, d.l / 2, 0.018], ['+x', '-x', '+y', '-y'])
      cyl(g.mb('titanium'), madd(root, [1, 0, 0], -d.w * 0.4), madd(root, [1, 0, 0], d.w * 0.4), 0.025, 10, true, true)
    }
  }
  // 对接环（背地面中心，环径不超过短边 90 %）
  const aD = isNum(o.adapterD) ? o.adapterD : G.adapterD, aH = isNum(o.adapterH) ? o.adapterH : G.adapterH
  if (aD > 0 && aH > 0) {
    // 卫星侧对接环：圆柱段 + 下缘 V 形包带法兰（hardware.lvRing）
    const rO = Math.min(aD / 2, 0.45 * Math.min(o.x, o.y))
    lvRing(() => g.mb('aluminum'), { c: P(0, 0, ZA - off), dir: P(0, 0, -1), up: P(1, 0, 0), D: 2 * rO, H: aH, seg: 48 })
  }
  g.flush()
  B.box('bus', isNum(o.busMassKg) ? o.busMassKg : 1500, P(0, 0, 0), h)
  // 推进：远地点发动机（背地面中心、对接环里；钟形喷管，燃烧室缩在星体里）+ 姿控推力器（背地面四角斜出 + 东西面近背地端，
  // 每处一块 MLI 小支架上 A/B 两只 10 N 钟形喷管）——hardware.bellNozzle / rcsPod
  const gT = group(B, 'propulsion', '推进（远地点发动机 + 姿控推力器）', 'thruster')
  const tput = (k) => gT.mb(PROP_MAT[k] || k)
  if (o.lae !== false) {
    const L = o.lae || {}, De = isNum(L.exitD) ? L.exitD : G.laeExitD, ll = isNum(L.len) ? L.len : G.laeLen
    bellNozzle(tput, { exit: P(0, 0, ZA - off - ll), dir: P(0, 0, -1), up: P(1, 0, 0), kind: 'lae', De, seg: 32 })
    B.point('lae', 4.5, P(0, 0, ZA - ll * 0.4))
  }
  if (o.rcs !== false) {
    const ix = Math.min(0.2, 0.15 * h[0]), iy = Math.min(0.2, 0.15 * h[1])
    for (const sx of [1, -1]) for (const sy of [1, -1]) rcsPod(tput, { base: P(sx * (h[0] - ix), sy * (h[1] - iy), ZA - off), dir: nrm(P(sx * 0.35, sy * 0.35, -1)), up: P(sx, -sy, 0) })
    for (const sx of [1, -1]) for (const sy of [1, -1]) rcsPod(tput, { base: P(sx * (h[0] + off), sy * (h[1] - iy), ZA + 0.3), dir: P(sx, 0, 0), up: P(0, 0, 1) })
  }
  gT.flush()
  // 星敏：两只 Hydra 类光学头装在楔形座上——缺省北板对地端，视轴离 −Y 35°、偏东 / 偏西并朝背地（paramBus.geoSensorLayout 同一布局）；
  // 'aft'：背地面靠北两只
  if (o.trackers !== false) {
    const gS = group(B, 'star_trackers', '星敏感器', 'sensor')
    const sput = (k) => gS.mb(k === 'glass' ? 'black_paint' : k)
    if (o.trackers === 'aft') {
      for (const sx of [1, -1]) {
        const dir = nrm(P(sx * 0.3, -0.5, -1)), tilt = nrm(reject(dir, P(0, 0, -1)))
        const w = wedgeMount(sput, { base: P(sx * h[0] * 0.55, -h[1] * 0.55, ZA - off), n: P(0, 0, -1), top: dir, size: 0.18, up: tilt })
        starTrackerHead(sput, { base: w.top, dir, up: tilt })
      }
    } else {
      const SL = geoSensorLayout([h[0], h[1] + off, h[2]], { hornApM: 0.12 }, 'wca')
      for (const st of SL.stars) {
        const w = wedgeMount(sput, { base: st.base, n: st.n, top: st.dir, size: 0.18, up: st.tilt })
        starTrackerHead(sput, { base: w.top, dir: st.dir, up: st.tilt })
      }
    }
    gS.flush()
  }
  return { h, ZN, ZA }
}

// ───────────────────────────── 太阳翼 ─────────────────────────────

/**
 * GEO 太阳翼（南北两翼或单翼）：一列 panels 块板（沿翼展 along × 横宽 across），可在某一块两侧加侧板（十字形翼：SSL-1300 / Spacebus 4000）。
 * o = { panels, along, across, gap?, yokeLen, yoke?:'V'|'trap'|'rod', yokeD?, yokeMat?, sadaLen?, sadaD?, xRoot?, zRoot?, t?,
 *       side?:{n:2, along?, across?, at?:板序号（0 起；缺省倒数第二块——外侧还有一块，成十字；2026-10-08 前缺省最外一块 = T 字形，
 *       与在轨外形不符）| 板序号数组（多处挂侧板）, half?:板序号数组（只在局部 +x 一侧挂一块：两翼局部 x 相反，于是两翼的单块
 *       侧板落在点对称的两边——欧洲之星 Neo 的 Hot Bird 13F：第 2 块两侧各一、第 3 块单侧一块）}, single?:'+Y'|'-Y',
 *       cell?:'gaas'|'si', cellMat? / cellLines?（电池材质 / 栅线），massKg?（每翼）, efficiency?, frame?:材质,
 *       onWing?:(F, side) => 节点名[]（随翼转动的附加件，见 parts.wing）,
 *       flap?:{at?, along?, across?, tilt?, wing?:'+Y'|'-Y'|'both', edge?:1|-1, mat?, faceMat?}（欧洲之星 E3000 的 ADCS 配平小翼，随翼转：
 *       不在翼尖——是一块没有电池、约一块板长的板，铰在倒数第二块板（at 缺省）的长边上、斜出阵面 tilt°；多数星只有一翼有，
 *       缺省 +Y 翼；调研 eurostar_spacebus：Eutelsat 172B / Türksat 5B 第 3 块（共 4）、Türksat 5A / Inmarsat-4 第 4 块（共 5）） }
 * 翼根在南 / 北面 (xRoot, ±(y/2), zRoot)；电池面静止朝天顶（−Z，与 paramBus / 其他精模同口径），关节 yRotate 自动对日。
 */
export function geoWings(B, h, o) {
  const sides = o.single ? [o.single === '-Y' ? -1 : 1] : [1, -1]
  const gap = isNum(o.gap) ? o.gap : G.wingGap
  const sadaLen = isNum(o.sadaLen) ? o.sadaLen : G.sadaLen
  const y0 = sadaLen + o.yokeLen
  const panels = []
  for (let k = 0; k < o.panels; k++) panels.push({ x: 0, y: y0 + k * (o.along + gap), w: o.across, h: o.along })
  if (o.side) {
    // 侧板挂在哪几块（0 起）：一个数 = 一处十字；数组 = 多处（ViaSat-3 每翼第 2、3 块各挂一对，双排十字）
    const sw = o.side.across || o.across, sh = o.side.along || o.along
    const ats = Array.isArray(o.side.at) ? o.side.at : [isNum(o.side.at) ? o.side.at : Math.max(0, o.panels - 2)]
    for (const at0 of ats) {
      const at = Math.min(o.panels - 1, Math.max(0, at0))
      for (const sx of [1, -1]) panels.push({ x: sx * (o.across / 2 + gap + sw / 2), y: y0 + at * (o.along + gap) + (o.along - sh) / 2, w: sw, h: sh })
    }
    for (const at0 of o.side.half || []) {
      const at = Math.min(o.panels - 1, Math.max(0, at0))
      panels.push({ x: o.across / 2 + gap + sw / 2, y: y0 + at * (o.along + gap) + (o.along - sh) / 2, w: sw, h: sh })
    }
  }
  const si = o.cell === 'si'
  const out = []
  // ADCS 配平小翼：铰在第 at 块板的长边（局部 x = edge·半宽）上，沿翼展与该板等长，绕翼展轴斜出阵面 tilt°（朝电池面背后）
  const flapOn = (side) => {
    const f = o.flap
    const w = f.wing || '+Y'
    return w === 'both' || w === side
  }
  const flapNodes = (F, side) => {
    const f = o.flap
    const t = ((isNum(f.tilt) ? f.tilt : 30) * Math.PI) / 180, e = f.edge === -1 ? -1 : 1
    const at = Math.min(o.panels - 1, Math.max(0, isNum(f.at) ? f.at : o.panels - 2))
    const fl = f.along || o.along, fa = f.across || 0.45 * o.across
    const yc = y0 + at * (o.along + gap) + o.along / 2
    const dir = [e * Math.cos(t), 0, -Math.sin(t)], y = [0, 1, 0]
    const c = madd([e * (o.across / 2 + 0.03), yc, 0], dir, fa / 2)
    const Ff = { o: c, x: dir, y, z: cross(dir, y) }
    const mb = new MB(), mf = new MB()
    obox(mb, Ff, [0, 0, 0], [fa / 2, fl / 2, 0.012], ['+x', '-x', '+y', '-y', '-z'])
    obox(mf, Ff, [0, 0, 0], [fa / 2 - 0.03, fl / 2 - 0.03, 0.0125], ['+z'])
    // 铰链：两只小圆柱
    for (const k of [-0.3, 0.3]) cyl(mb, [e * (o.across / 2 + 0.01), yc + k * fl - 0.06, 0], [e * (o.across / 2 + 0.01), yc + k * fl + 0.06, 0], 0.02, 8, true, true)
    const nm = `wing_${side}_flap`, part = { id: nm, name: `配平小翼 ${side}`, role: 'solarArray' }
    B.item(nm, { part, role: 'solarArray', mat: f.mat || 'solar_substrate', mb, F })
    B.item(`${nm}_face`, { part, role: 'solarArray', mat: f.faceMat || 'mli_silver', mb: mf, F })
    return [nm, `${nm}_face`]
  }
  for (const s of sides) {
    const side = s > 0 ? '+Y' : '-Y'
    out.push(wing(B, {
      name: `wing_${side}`, title: `太阳翼 ${side}`, root: P(o.xRoot || 0, s * (h[1] + G.skinOff), isNum(o.zRoot) ? o.zRoot : 0), span: P(0, s, 0), normal: P(0, 0, -1),
      panels, yokeLen: o.yokeLen, yokeW: o.across, yoke: o.yoke || 'V', yokeD: isNum(o.yokeD) ? o.yokeD : G.yokeD, yokeMat: o.yokeMat,
      sadaLen, sadaD: isNum(o.sadaD) ? o.sadaD : G.sadaD, t: isNum(o.t) ? o.t : G.panelT, margin: 0.035, frameW: 0.022, hingeR: 0.018, frameMat: o.frame,
      cellMat: si ? 'cell_si' : (o.cellMat || 'solar_cell'), cellLines: o.cellLines || (si ? { du: 0.2, dv: 0.12, w: 0.006 } : undefined),
      efficiency: isNum(o.efficiency) ? o.efficiency : (si ? 17 : 28), massKg: isNum(o.massKg) ? o.massKg : undefined,
      onWing: (o.onWing || (o.flap && flapOn(side))) ? (F) => [...(o.flap && flapOn(side) ? flapNodes(F, side) : []), ...(o.onWing ? o.onWing(F, side) : [])] : undefined
    }))
  }
  return out
}

/**
 * 按有出处的在轨翼展反推连接架（轭）长：span = 2·(y/2 + 蒙皮 + SADA + 轭 + n·板长 + (n−1)·板缝)。
 * GEO 星普遍只公布「Span in orbit」，轭长没人公布——型号文件用它从跨度倒推，facts 里记 derived。
 * @returns {number} 轭长（m，夹在 0.3 … 8 之间；夹过说明板数 / 板长与跨度对不上，调用方应复核）
 */
export function yokeForSpan(spanM, busY, panels, along, gap = G.wingGap, sadaLen = G.sadaLen) {
  const y = spanM / 2 - busY / 2 - G.skinOff - sadaLen - panels * along - (panels - 1) * gap
  return Math.max(0.3, Math.min(8, y))
}

// ───────────────────────────── 偏置抛物面网格 ─────────────────────────────

/**
 * 偏置抛物面壳（口径面椭圆：沿 u 半轴 R1、沿 e2 半轴 R2）：正面（朝焦点）进 front，背面沿 −法向退 sh 进 back，边缘厚度带进 rim。
 * back / rim 为 null 时只画正面（网状反射面）；doubleFace：正面再贴一层背向的同网格（单面材质从背后也看得见网）。
 * @returns {{outer:number[][], nOuter:number[][]}} 外圈点与法向（给桁架 / 展开臂找落点）
 */
export function dishShell2(front, back, rim, L, R1, R2, { na = 40, nr = 8, sh = G.shell, doubleFace = false } = {}) {
  const pts = [], nrs = []
  const at = (k, j) => {
    const rho = k / nr, ph = (2 * Math.PI * j) / na
    const x1 = L.dc + R1 * rho * Math.cos(ph), x2 = R2 * rho * Math.sin(ph)
    return [L.P(x1, x2), L.N(x1, x2)]
  }
  const emit = (mb, sign, off) => {
    const base = mb.vcount
    const [pc, nc] = at(0, 0)
    mb.v(madd(pc, nc, off), scl(nc, sign))
    for (let k = 1; k <= nr; k++) for (let j = 0; j < na; j++) { const [p, n] = at(k, j); mb.v(madd(p, n, off), scl(n, sign), R1 * k / nr * Math.cos(2 * Math.PI * j / na), R2 * k / nr * Math.sin(2 * Math.PI * j / na)) }
    const idx = (k, j) => base + 1 + (k - 1) * na + (j % na)
    for (let j = 0; j < na; j++) { if (sign > 0) mb.t(base, idx(1, j), idx(1, j + 1)); else mb.t(base, idx(1, j + 1), idx(1, j)) }
    for (let k = 1; k < nr; k++) for (let j = 0; j < na; j++) {
      const a = idx(k, j), b = idx(k + 1, j), c = idx(k + 1, j + 1), d = idx(k, j + 1)
      if (sign > 0) { mb.t(a, b, c); mb.t(a, c, d) } else { mb.t(a, c, b); mb.t(a, d, c) }
    }
  }
  emit(front, 1, 0)
  if (doubleFace) emit(front, -1, -0.001)
  if (back) emit(back, -1, -sh)
  for (let j = 0; j < na; j++) { const [p, n] = at(nr, j); pts.push(p); nrs.push(n) }
  if (rim) {
    for (let j = 0; j < na; j++) {
      const j1 = (j + 1) % na, p0 = pts[j], p1 = pts[j1], n0 = nrs[j], n1 = nrs[j1]
      const rad = nrm(sub(scl(add(p0, p1), 0.5), L.Pc))
      quadPts(rim, p0, p1, madd(p1, n1, -sh), madd(p0, n0, -sh), rad)
    }
  }
  return { outer: pts, nOuter: nrs }
}

// ───────────────────────────── 馈源 ─────────────────────────────

/**
 * 馈源簇（多波束 HTS 的单馈源每波束阵 / 普通单喇叭）：口面中心 c、朝向 dir；n = 1 / 7 / 19 / 37（六角密排，第 k 圈 6k 个，节距 2.08 rh）。
 * 有 aim（反射面口径中心）时口面排在以 aim 为心、过 c 的球冠上、每只喇叭各自对准 aim（调研 components.md §2.5：Ka 单馈源每波束阵
 * 的口面在 R ≈ 1.1 F 的球冠上、逐只指向反射面）；背后一块六边形安装板（随簇外形）。喇叭进 mb，安装板进 plate。
 */
export function feedCluster(mb, plate, c, dir, { n = 1, rh = 0.06, lh = 0.16, seg = 12, aim = null } = {}) {
  const d = nrm(dir), [e1, e2] = perpPair(d)
  const pos = [[0, 0]]
  const rings = n >= 37 ? 3 : n >= 19 ? 2 : n >= 7 ? 1 : 0
  const pitch = 2.08 * rh
  for (let k = 1; k <= rings; k++) {
    for (let side = 0; side < 6; side++) {
      const a0 = (Math.PI / 3) * side, a1 = (Math.PI / 3) * (side + 1)
      for (let i = 0; i < k; i++) {
        const t = i / k
        const x = k * pitch * ((1 - t) * Math.cos(a0) + t * Math.cos(a1)), y = k * pitch * ((1 - t) * Math.sin(a0) + t * Math.sin(a1))
        pos.push([x, y])
      }
    }
  }
  const Rs = aim ? len(sub(aim, c)) : 0
  let ext = 0
  for (const [x, y] of pos) {
    let ap = add(c, add(scl(e1, x), scl(e2, y))), hd = d
    if (aim && Rs > 1e-6) { hd = nrm(sub(aim, ap)); ap = madd(aim, hd, -Rs) }
    if (n === 1) horn(mb, ap, hd, rh, lh, Math.max(16, seg))
    else frustum(mb, madd(ap, hd, -lh), rh * 0.45, ap, rh, seg, true, false, false)
    ext = Math.max(ext, Math.hypot(x, y) + rh)
  }
  if (plate && n > 1) {
    // 六边形安装板（顶点朝簇的六个角方向），在口面后 lh + 2 cm
    const F = frameZX(madd(c, d, -lh - 0.02), d, e1)
    prism(plate, F, ngon(6, ext * 1.04, 0), -0.02, 0.02)
  }
  return { back: madd(c, d, -lh - (n > 1 ? 0.04 : 0)), ext }
}

// ───────────────────────────── 东西侧壁偏置反射面 ─────────────────────────────

/**
 * 东 / 西侧壁可展开偏置抛物面 + 馈源 + 展开机构（2026-10-08 按调研重做，components.md §1 / §1-V1 / §1-V2 / §2–§3）。
 * o = {
 *   name, title, side:'E'|'W', D（沿偏置方向口径）, Dy?（横向口径，椭圆口面）, fd?（焦径比：实面缺省 1.6、双栅 1.0、网状 0.5）,
 *   y?（焦点南北位置，缺省 0）, inset? / standoff?（馈源相位中心离东西壁内缩（负 = 伸出壁外）/ 高出对地板）, gap?（反射面内缘离侧壁）, dc?（直接给偏置量）,
 *   F?（直接给焦点）, tiltX? / tiltY?（视轴绕 Y / 绕 X 倾斜，度；+tiltX 向东）, out?（外挂：在缺省偏置上再外移 m，叠放第二副时用）,
 *   type:'solid'|'grid'|'mesh', mat?（正面材质，缺省白漆反射面 / 双栅凯夫拉前壳）, backMat?（背壳，缺省碳纤维）,
 *   feed:{n, rh, lh}（缺省单只波纹喇叭）, sub?:{D}（格里高利副反射面）, arm?:false, hingeZ?（展开机构高度）
 * }
 * 实面 / 双栅：背面八边形环框 + Airbus 式矩形支撑框（金色 MLI）；展开机构（ADTM）装在侧壁、一根直臂接支撑框内侧横梁。
 * 双栅（DGR）：前壳（凯夫拉色）与后壳之间是楔形间隙（内缘 0.03 m → 外缘 0.13 m）+ 一圈连续的周边围带。
 * 格里高利：凹面椭球副反射面在焦点外侧（背向主面），馈源移到第二焦点、朝副面；副面与馈源立在一座裹 MLI 的支架上。
 * 部件：`${name}`（反射面 + 背架 + 展开机构）与 `${name}_feed`；挂点 `${name}`：口径中心、视轴 a。
 * @returns {object} paraLayout 结果（含 Pc / nc 等）
 */
export function sideReflector(B, h, o) {
  const s = o.side === 'W' ? -1 : 1
  const grid = o.type === 'grid', mesh = o.type === 'mesh'
  const D = o.D, Dy = o.Dy || o.D, f = (isNum(o.fd) ? o.fd : grid ? 1.0 : mesh ? 0.5 : G.fdSide) * D
  const inset = isNum(o.inset) ? o.inset : G.inset, standoff = isNum(o.standoff) ? o.standoff : G.standoff, gap = isNum(o.gap) ? o.gap : G.gap
  let a = Z.slice()
  if (isNum(o.tiltX) && o.tiltX) a = rotV(a, [0, 1, 0], o.tiltX)
  if (isNum(o.tiltY) && o.tiltY) a = rotV(a, [1, 0, 0], -o.tiltY)
  a = nrm(a)
  const F = o.F ? o.F.slice() : P(s * (h[0] - inset), isNum(o.y) ? o.y : 0, h[2] + standoff)
  const u = nrm(reject(P(s, 0, 0), a))
  const dc = isNum(o.dc) ? o.dc : D / 2 + inset + gap + (isNum(o.out) ? o.out : 0)
  const L = paraLayout(F, a, u, f, D, dc)
  const part = o.title || o.name
  const g = group(B, o.name, part, 'reflector')
  // 小件材质并进组里已有的三种（反射面正面 / 碳纤维 / 金色 MLI）：节点预算
  const put = (k) => g.mb(k === 'aluminum' ? 'mli_gold' : k)
  const sh = mesh ? 0 : G.shell
  const ring_ = dishShell2(g.mb(o.mat || (mesh ? 'reflector_mesh' : grid ? 'kevlar' : 'reflector')), mesh ? null : g.mb(o.backMat || 'carbon'), mesh ? null : g.mb(o.backMat || 'carbon'), L, D / 2, Dy / 2, { sh, doubleFace: mesh })
  const R = D / 2
  if (grid) {
    // 双栅：后壳 = 前壳沿 −法向退 s(x1)（内缘 0.03 → 外缘 0.13 m，两层焦点不同、间距沿口径线性变）+ 周边连续围带
    const sOf = (x1) => 0.03 + 0.10 * Math.min(1, Math.max(0, (x1 - (L.dc - R)) / (2 * R)))
    const rearL = { ...L, P: (x1, x2) => { const n = L.N(x1, x2); return madd(L.P(x1, x2), n, -(sh + sOf(x1))) } }
    dishShell2(g.mb('carbon'), null, null, rearL, R, Dy / 2, { na: 40, nr: 6 })
    const band = g.mb('kevlar'), na = ring_.outer.length
    for (let j = 0; j < na; j++) {
      const j1 = (j + 1) % na, ph0 = (2 * Math.PI * j) / na, ph1 = (2 * Math.PI * j1) / na
      const x10 = L.dc + R * Math.cos(ph0), x11 = L.dc + R * Math.cos(ph1)
      const p0 = madd(ring_.outer[j], ring_.nOuter[j], -sh), p1 = madd(ring_.outer[j1], ring_.nOuter[j1], -sh)
      const q0 = madd(p0, ring_.nOuter[j], -sOf(x10)), q1 = madd(p1, ring_.nOuter[j1], -sOf(x11))
      quadPts(band, p0, p1, q1, q0, nrm(sub(scl(add(p0, p1), 0.5), L.Pc)))
    }
  }
  // 背架 + 支撑框（金色 MLI）：连接点给展开臂
  let link = null
  if (!mesh) link = reflectorBacking(put, L, { sh: grid ? sh + 0.13 : sh, Ry: Dy / 2, backing: 'ring8', support: 'rect' }).link
  if (o.arm !== false) {
    if (link) {
      // 侧壁上的两轴展开机构 → 一根直臂 → 支撑框内侧横梁（paramBus.sideArmGeom 同一套几何）
      const e2y = cross(a, u)[1]
      const y = Math.max(-h[1] + 0.15, Math.min(h[1] - 0.15, link[1] - 0.25 * R * e2y))
      const z = isNum(o.hingeZ) ? o.hingeZ : Math.max(-h[2] + 0.2, Math.min(h[2] - 0.2, link[2] - 0.35))
      const ad = adtmBlock(put, { base: P(s * (h[0] + G.skinOff), y, z), n: P(s, 0, 0), up: P(0, 1, 0) })
      cyl(g.mb('mli_gold'), ad.out, link, Math.max(0.03, 0.035 * Math.min(1.5, D / 2.45)), 12, true, true)
      B.rod(`${o.name}_arm_1`, ad.out, link)
    } else {
      // 网状：侧壁铰点 → 内缘桁架（V 形两根）
      const am = g.mb('carbon')
      const back = (x1, x2, off) => madd(L.P(x1, x2), L.N(x1, x2), -(sh + off))
      const A = back(L.dc - R * 0.85, 0, 0.03), C = back(L.dc, 0, 0.08)
      const hz = isNum(o.hingeZ) ? o.hingeZ : Math.max(-h[2] + 0.2, Math.min(h[2] - 0.2, A[2]))
      const H = P(s * (h[0] + G.skinOff), Math.max(-h[1] + 0.15, Math.min(h[1] - 0.15, F[1])), hz)
      truss(am, [H, A], 0.022, 10)
      truss(am, [H, C], 0.02, 10)
      obox(g.mb('carbon'), frameZX(H, P(s, 0, 0), P(0, 1, 0)), [0, 0, 0.03], [0.07, 0.07, 0.03])
      B.rod(`${o.name}_arm_1`, H, A); B.rod(`${o.name}_arm_2`, H, C)
    }
  }
  g.flush()
  B.point(`${o.name}_dish`, (mesh ? 0.6 : 1.8) * Math.PI * D * Dy / 4, L.Pc)
  const pp = B.ctx.parts.get(o.name)
  if (pp) { pp.areaM2 = Math.PI * D * Dy / 4; pp.normalBody = a.slice() }
  // 馈源（对地板东 / 西棱外）：单只波纹喇叭 + 馈电链 / HTS 馈源簇；格里高利另有副反射面与支架
  const gF = group(B, `${o.name}_feed`, `${part}馈源`, 'feed')
  const fput = (k) => gF.mb(FEED_MAT[k] || k)
  const dirMain = nrm(sub(L.Pc, F))
  const fc = o.feed || {}
  let feedAt = F, feedDir = dirMain, back
  if (o.sub) {
    // 格里高利：副面中心 S 在焦点外侧（主面中心 → F 的延长线上）；馈源在第二焦点 F2：从 S 看与 S→F 成 40°、往南北中线一侧偏
    // （落在对地板棱上方，不挡副面到主面的光路），距 S 1.2 D_s、口面朝 S
    const sD = o.sub.D || 0.6
    const w = scl(dirMain, -1), S = madd(F, w, 0.45 * sD + 0.15)
    const ys = F[1] > 0.01 ? -1 : 1, c40 = Math.cos(40 * Math.PI / 180), s40 = Math.sin(40 * Math.PI / 180)
    const v1 = nrm(sub(F, S)), F2 = madd(S, nrm(add(scl(v1, c40), P(0, ys * s40, 0))), 1.2 * sD)
    const nS = nrm(add(nrm(sub(F, S)), nrm(sub(F2, S))))
    const fs = sD / (16 * 0.06)
    const Ls = paraLayout(madd(S, nS, fs), nS, perpPair(nS)[0], fs, sD, 0)
    dishShell2(gF.mb(o.mat || 'reflector'), gF.mb('carbon'), gF.mb('carbon'), Ls, sD / 2, sD / 2, { na: 28, nr: 4, sh: 0.015 })
    // 副面与馈源的支架：一根裹 MLI 的立柱从对地板升到副面背后
    const sb = madd(S, nS, -0.06)
    const foot = P(Math.max(-h[0] + 0.1, Math.min(h[0] - 0.1, sb[0])), Math.max(-h[1] + 0.1, Math.min(h[1] - 0.1, sb[1])), h[2] + G.skinOff)
    bevelBox(gF.mb('mli_gold'), frameZX(scl(add(foot, sb), 0.5), sub(sb, foot), P(1, 0, 0)), [0, 0, 0], [0.09, 0.09, len(sub(sb, foot)) / 2], 0.015)
    feedAt = F2; feedDir = nrm(sub(S, F2))
  }
  if ((fc.n || 1) === 1) {
    const ap = fc.rh ? 2 * fc.rh : Math.min(0.3, Math.max(0.06, 0.03 * f))
    const hh = hwFeedHorn(fput, { ap: feedAt, dir: feedDir, D: ap, L: fc.lh || 2.12 * ap, style: 'smooth', mat: { body: 'mli_gold', rim: 'gold_metal', inner: 'black_paint' }, cap: 'ge', seg: 24 })
    back = hwFeedChain(fput, { throat: hh.throat, dir: feedDir, D: ap, mat: { body: 'mli_gold', flange: 'aluminum' }, seg: 12 }).back
  } else {
    back = feedCluster(gF.mb('aluminum'), gF.mb(fc.plateMat || 'mli_gold'), feedAt, feedDir, { n: fc.n, rh: fc.rh || Math.min(0.14, Math.max(0.06, 0.035 * D)), lh: fc.lh || Math.min(0.4, Math.max(0.16, 0.09 * D)), aim: o.sub ? null : L.Pc }).back
  }
  // 馈源支架：三脚架落到对地板（各杆接在托架朝自己落脚点的一侧；paramBus.feedSupportRods 同式）
  for (const [p0, p1] of feedSupportRods(back, { h, k: 1 }, null)) cyl(fput('aluminum'), p0, madd(p1, [0, 0, 1], G.skinOff), 0.012, 8, false, true)
  obox(fput('aluminum'), frameZX(back, feedDir, P(0, 1, 0)), [0, 0, 0], [0.05, 0.05, 0.05])
  gF.flush()
  B.point(`${o.name}_feed`, fc.n > 1 ? 4 + 0.5 * fc.n : 2, F)
  B.ap(o.name, madd(L.Pc, a, 0.05), a)
  return L
}

// ───────────────────────────── 对地板天线塔与塔馈反射面 ─────────────────────────────

/**
 * 对地板天线塔（方柱，裹平台同色 MLI——调研 components.md §3(c)：在轨照片里塔 / 支架都包 MLI，不是白漆）。
 * o = {x?, y?, w?, h, mat?}；返回塔顶高度。多副塔馈反射面共用一座塔时先调它再逐副 deckReflector。
 */
export function deckTower(B, h, o) {
  const w = o.w || G.towerW, x = o.x || 0, y = o.y || 0
  const g = group(B, o.name || 'antenna_tower', o.title || '天线塔', 'boom')
  bevelBox(g.mb(o.mat || 'mli_gold'), BODY, P(x, y, h[2] + G.skinOff + o.h / 2), [w / 2, w / 2, o.h / 2], 0.02)
  g.flush()
  B.point(`${o.name || 'antenna_tower'}_mass`, 2.0 * 4 * w * o.h, P(x, y, h[2] + o.h / 2))
  return h[2] + G.skinOff + o.h
}

/**
 * 对地板偏置反射面（塔馈 / 对地板边缘馈）：焦点 F（缺省塔顶旁），偏置方向 u（对地板平面内，dish 往哪边伸），视轴 a（缺省 +Z）。
 * o = { name, title, D, Dy?, fd?, F?, at?:[x,y]（塔中心）, towerW?, towerTop?（塔顶 z）, towerMat?, u:[ux,uy,uz], a?, dc?, type, mat?, feed?, sub? }
 * 塔高缺省按「反射面近缘离对地板留 0.15 m」反推（paramBus 同式）。背面一圈八边形环框（碳纤维，节点预算：并进背壳）。
 */
export function deckReflector(B, h, o) {
  const D = o.D, Dy = o.Dy || D, f = (isNum(o.fd) ? o.fd : G.fdDeck) * D
  const a = nrm(o.a || Z), u = nrm(reject(o.u || P(0, 1, 0), a))
  const dc = isNum(o.dc) ? o.dc : D / 2 + 0.1
  let F = o.F ? o.F.slice() : null
  if (!F) {
    const near = Math.max(0, dc - D / 2)
    const th = isNum(o.towerTop) ? o.towerTop - h[2] : f - near * near / (4 * f) + 0.15
    const at = o.at || [0, 0], tw = o.towerW || G.towerW
    F = P(at[0] + u[0] * (tw / 2 + 0.1), at[1] + u[1] * (tw / 2 + 0.1), h[2] + G.skinOff + th)
    if (!isNum(o.towerTop) && o.tower !== false) deckTower(B, h, { name: `${o.name}_tower`, title: `${o.title || o.name}天线塔`, x: at[0], y: at[1], w: tw, h: th, mat: o.towerMat })
  }
  const L = paraLayout(F, a, u, f, D, dc)
  const g = group(B, o.name, o.title || o.name, 'reflector')
  const mesh = o.type === 'mesh'
  dishShell2(g.mb(o.mat || (mesh ? 'reflector_mesh' : 'reflector')), mesh ? null : g.mb(o.backMat || 'carbon'), mesh ? null : g.mb(o.backMat || 'carbon'), L, D / 2, Dy / 2, { sh: mesh ? 0 : G.shell, doubleFace: mesh, na: 36, nr: 7 })
  if (!mesh) reflectorBacking(() => g.mb(o.backMat || 'carbon'), L, { sh: G.shell, Ry: Dy / 2, backing: 'ring8', support: 'none' })
  // 支撑：反射面背面两根杆落到对地板（近缘 / 远缘）
  const back = (x1, x2) => madd(L.P(x1, x2), L.N(x1, x2), -(G.shell + 0.03))
  const pN = back(L.dc - D / 2 * 0.8, 0), pFar = back(L.dc + D / 2 * 0.6, 0)
  for (const p of [pN, pFar]) {
    const foot = P(Math.max(-h[0], Math.min(h[0], p[0])), Math.max(-h[1], Math.min(h[1], p[1])), h[2] + G.skinOff)
    if (p[2] - foot[2] > 0.05) truss(g.mb('carbon'), [foot, p], 0.018, 8)
  }
  g.flush()
  B.point(`${o.name}_dish`, 1.8 * Math.PI * D * Dy / 4, L.Pc)
  const pp = B.ctx.parts.get(o.name)
  if (pp) { pp.areaM2 = Math.PI * D * Dy / 4; pp.normalBody = a.slice() }
  const gF = group(B, `${o.name}_feed`, `${o.title || o.name}馈源`, 'feed')
  const fput = (k) => gF.mb(FEED_MAT[k] || k)
  const dir = nrm(sub(L.Pc, F)), fc = o.feed || {}
  if ((fc.n || 1) === 1) {
    const ap = fc.rh ? 2 * fc.rh : Math.min(0.3, Math.max(0.06, 0.03 * f))
    const hh = hwFeedHorn(fput, { ap: F, dir, D: ap, L: fc.lh || 2.12 * ap, style: 'smooth', mat: { body: 'mli_gold', rim: 'gold_metal', inner: 'black_paint' }, cap: 'ge', seg: 20 })
    hwFeedChain(fput, { throat: hh.throat, dir, D: ap, mat: { body: 'mli_gold', flange: 'aluminum' }, seg: 12 })
  } else feedCluster(gF.mb('aluminum'), gF.mb('mli_gold'), F, dir, { n: fc.n, rh: fc.rh || Math.min(0.1, Math.max(0.045, 0.035 * D)), lh: fc.lh || Math.min(0.3, Math.max(0.12, 0.09 * D)), aim: L.Pc })
  gF.flush()
  B.ap(o.name, madd(L.Pc, a, 0.05), a)
  return L
}

// ───────────────────────────── 大型可展开网状天线 ─────────────────────────────

/**
 * 大型可展开网状反射面（移动通信 / 数据中继 / 雷达）+ 展开臂 + 对地板馈源阵。
 * o = {
 *   name, title, D, fd?（缺省 0.5）, F（焦点 = 馈源阵相位中心）, a?（视轴，缺省 +Z）, u（偏置方向）, dc?,
 *   style:'astromesh'（周边环形桁架，Northrop AstroMesh 类）| 'umbrella'（中心毂 + 径向肋，Harris 类）, bays?（桁架格数）/ ribs?（肋数）,
 *   depth?（桁架高，缺省 0.06·D）, mat?, trussMat?, boomFrom（展开臂根部，本体系）, elbow?（臂中间折点）, feedArray?:{w, h}（馈源阵板尺寸，0 = 不画）
 * }
 */
export function meshReflector(B, h, o) {
  const D = o.D, f = (isNum(o.fd) ? o.fd : 0.5) * D
  const a = nrm(o.a || Z), u = nrm(reject(o.u, a))
  const dc = isNum(o.dc) ? o.dc : D / 2 + 0.6
  const L = paraLayout(o.F, a, u, f, D, dc)
  const R = D / 2
  const g = group(B, o.name, o.title || o.name, 'reflector')
  const net = g.mb(o.mat || 'reflector_mesh'), tr = g.mb(o.trussMat || 'white_paint')
  const style = o.style || 'astromesh'
  let rimPts = [], rimN = []
  if (style === 'umbrella') {
    // 径向肋 + 肋间网面（扇贝形：肋间外缘内收 3 %）
    const nR = o.ribs || 18, nr = 7
    const ptAt = (rho, ph) => { const x1 = L.dc + R * rho * Math.cos(ph), x2 = R * rho * Math.sin(ph); return [L.P(x1, x2), L.N(x1, x2)] }
    const [pc, ncv] = ptAt(0, 0)
    for (let j = 0; j < nR; j++) {
      const ph0 = (2 * Math.PI * j) / nR, ph1 = (2 * Math.PI * (j + 1)) / nR
      const rib = []
      for (let k = 0; k <= nr; k++) rib.push(ptAt(k / nr, ph0)[0])
      for (let k = 0; k < nr; k++) cyl(tr, madd(rib[k], ptAt(k / nr, ph0)[1], -0.02), madd(rib[k + 1], ptAt((k + 1) / nr, ph0)[1], -0.02), Math.max(0.012, 0.0022 * D), 5, false, false)
      // 网面：每个扇区按径向 nr 段、周向 2 段剖分，外缘中点内收
      for (let k = 0; k < nr; k++) {
        const r0 = k / nr, r1 = (k + 1) / nr
        const scal = (r, t) => (r >= 0.999 ? 1 - 0.03 * Math.sin(Math.PI * t) : 1)
        const q = (r, t) => ptAt(r * scal(r, t), ph0 + (ph1 - ph0) * t)
        for (const [t0, t1] of [[0, 0.5], [0.5, 1]]) {
          const A = q(r0, t0), Bq = q(r1, t0), C = q(r1, t1), Dd = q(r0, t1)
          tri(net, A[0], Bq[0], C[0], A[1]); tri(net, A[0], C[0], Dd[0], A[1])
          tri(net, A[0], C[0], Bq[0], scl(A[1], -1)); tri(net, A[0], Dd[0], C[0], scl(A[1], -1))
        }
      }
      rimPts.push(rib[nr]); rimN.push(ptAt(1, ph0)[1])
    }
    // 中心毂
    cyl(tr, madd(pc, ncv, -0.25), madd(pc, ncv, 0.05), Math.max(0.12, 0.025 * D), 16, true, true)
  } else {
    const r = dishShell2(net, null, null, L, R, R, { na: 48, nr: 8, doubleFace: true })
    rimPts = r.outer; rimN = r.nOuter
    // 周边桁架：前环（网边）+ 后环（沿法向退 depth）+ 竖杆 + 交替斜杆
    const nb = o.bays || 24, dp = isNum(o.depth) ? o.depth : 0.06 * D, rr = Math.max(0.012, 0.0022 * D)
    const step = rimPts.length / nb
    const F0 = [], B0 = []
    for (let j = 0; j < nb; j++) { const i = Math.round(j * step) % rimPts.length; F0.push(rimPts[i]); B0.push(madd(rimPts[i], rimN[i], -dp)) }
    for (let j = 0; j < nb; j++) {
      const j1 = (j + 1) % nb
      cyl(tr, F0[j], F0[j1], rr, 5, false, false); cyl(tr, B0[j], B0[j1], rr, 5, false, false); cyl(tr, F0[j], B0[j], rr, 5, false, false)
      if (j % 2 === 0) cyl(tr, F0[j], B0[j1], rr * 0.7, 4, false, false); else cyl(tr, B0[j], F0[j1], rr * 0.7, 4, false, false)
    }
  }
  // 展开臂：根部 → （折点）→ 反射面离根部最近的外缘点
  if (o.boomFrom) {
    let best = 0, bd = Infinity
    for (let i = 0; i < rimPts.length; i++) { const d = len(sub(rimPts[i], o.boomFrom)); if (d < bd) { bd = d; best = i } }
    const tip = style === 'umbrella' ? madd(L.Pc, L.nc, -0.25) : madd(rimPts[best], rimN[best], -(isNum(o.depth) ? o.depth : 0.06 * D) / 2)
    const pts = o.elbow ? [o.boomFrom, o.elbow, tip] : [o.boomFrom, tip]
    const bm = g.mb(o.boomMat || 'carbon'), br = Math.max(0.04, 0.006 * D)
    for (let i = 0; i + 1 < pts.length; i++) { cyl(bm, pts[i], pts[i + 1], br, 12, true, true); B.rod(`${o.name}_boom_${i + 1}`, pts[i], pts[i + 1]) }
    for (const p of pts.slice(0, -1)) cyl(g.mb('titanium'), madd(p, [0, 0, 1], -br * 1.6), madd(p, [0, 0, 1], br * 1.6), br * 1.7, 14, true, true)
  }
  g.flush()
  B.point(`${o.name}_dish`, 0.6 * Math.PI * R * R * 1.4, L.Pc)
  const pp = B.ctx.parts.get(o.name)
  if (pp) { pp.areaM2 = Math.PI * R * R; pp.normalBody = a.slice() }
  // 馈源阵（对地板上的平面阵 / 喇叭阵，口面朝反射面）
  const fa = o.feedArray === undefined ? { w: Math.min(1.6, 0.09 * D), h: Math.min(1.2, 0.07 * D) } : o.feedArray
  if (fa && fa.w > 0) {
    const gF = group(B, `${o.name}_feed`, `${o.title || o.name}馈源阵`, 'feed')
    const dir = nrm(sub(L.Pc, o.F))
    const Ff = frameZX(o.F, dir, P(0, 1, 0))
    obox(gF.mb(fa.mat || 'white_paint'), Ff, [0, 0, -0.06], [fa.w / 2, fa.h / 2, 0.06])
    const nx = Math.max(2, Math.round(fa.w / 0.22)), ny = Math.max(2, Math.round(fa.h / 0.22))
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const c = toW(Ff, [(i - (nx - 1) / 2) * fa.w / nx, (j - (ny - 1) / 2) * fa.h / ny, 0.002])
      cyl(gF.mb('mli_gold'), c, madd(c, dir, 0.012), Math.min(fa.w / nx, fa.h / ny) * 0.36, 10, false, true)
    }
    // 馈源阵支架：落到对地板
    const foot = P(Math.max(-h[0], Math.min(h[0], o.F[0])), Math.max(-h[1], Math.min(h[1], o.F[1])), h[2] + G.skinOff)
    if (o.F[2] - foot[2] > 0.1) truss(gF.mb('carbon'), [foot, madd(o.F, dir, -0.13)], 0.04, 10)
    gF.flush()
    B.point(`${o.name}_feed`, 20 + 8 * fa.w * fa.h, o.F)
  }
  B.ap(o.name, madd(L.Pc, a, 0.05), a)
  return L
}

// ───────────────────────────── 电推力器展开臂 ─────────────────────────────

/**
 * 电推力器指向机构 / 展开臂：背地面（或东西面）伸出 n 根臂，每根末端挂 k 台霍尔推力器（喷流朝背地外斜）。
 * o = { arms:[{from:[x,y,z], to:[x,y,z], dir:[x,y,z]}…] 或缺省（背地面南北各一根，斜向下外伸 0.9 m）, per?:2, R?:0.07 }
 */
export function epArms(B, h, o = {}) {
  const g = group(B, 'ep', '电推力器展开臂', 'thruster')
  // 缺省：背地面南北各一根两节臂（欧洲之星 E3000EOR / Neo：两根约 3 m 的三关节金色 MLI 臂，末端各一个双推力器吊舱；调研 components.md §7.4）
  const arms = o.arms || [1, -1].map((s) => ({ from: P(0, s * (h[1] - 0.25), -h[2] - G.skinOff), elbow: P(0, s * (h[1] + 0.35), -h[2] - 0.9), to: P(0, s * (h[1] + 1.1), -h[2] - 1.6), dir: nrm(P(0, s * 0.35, -1)) }))
  const R = o.R || 0.07, per = o.per || 2
  arms.forEach((ar, i) => {
    const pts = ar.elbow ? [ar.from, ar.elbow, ar.to] : [ar.from, ar.to]
    truss(g.mb(ar.elbow ? 'mli_gold' : 'titanium'), pts, 0.04, 10)
    for (const p of pts.slice(0, -1)) cyl(g.mb('titanium'), madd(p, P(1, 0, 0), -0.07), madd(p, P(1, 0, 0), 0.07), 0.055, 14, true, true)
    const [e1] = perpPair(ar.dir)
    for (let k = 0; k < per; k++) {
      const off = per === 1 ? 0 : (k - (per - 1) / 2) * R * 2.6
      hallThruster((k) => g.mb(HALL_MAT[k] || k), { exit: madd(madd(ar.to, e1, off), ar.dir, 0.12), dir: ar.dir, up: e1, Dch: 1.4 * R, seg: 24 })
    }
    obox(g.mb('dark_metal'), frameZX(ar.to, ar.dir, e1), [0, 0, 0], [R * 1.6 * Math.max(1, per * 0.75), R * 1.4, 0.05])
    B.point(`ep_${i + 1}`, 2.0 * per + 3, ar.to)
  })
  g.flush()
}

// ───────────────────────────── 对地板小件 ─────────────────────────────

/**
 * 对地板小件（调研 components.md §4 / §6）：测控天线、地球敏感器、测控 / 信标喇叭。
 *   测控：对地板一角桅杆顶（欧洲平台宽波束「管」喇叭 WCA；北美平台双锥全向天线 + 圆极化套筒）+ 背地面对角一只 WCA（短托架）。
 *   地球敏感器：IRES 类金色盒 + 顶窗（老平台两只；新平台多只用星敏，可关）。喇叭：台阶锥本色铝。
 * o = { omni?:[x,y]（缺省北侧靠西）| false, ttc?:'wca'|'bicone', aftOmni?:false, sensors?:false, horns?:[[x,y,ap]…] }
 */
export function deckFurniture(B, h, o = {}) {
  const ZN = h[2] + G.skinOff
  const g = group(B, 'deck_items', '对地板测控 / 敏感器', 'sensor')
  const put = (k) => g.mb(DECK_MAT[k] || k)
  if (o.omni !== false) {
    const [x, y] = o.omni || [-h[0] * 0.55, -h[1] * 0.6]
    ttcAntenna(put, { base: P(x, y, ZN), dir: Z, up: P(1, 0, 0), kind: o.ttc === 'bicone' ? 'bicone' : 'wca', mastLen: 0.45 })
  }
  if (o.aftOmni !== false) ttcAntenna(put, { base: P(h[0] * 0.5, h[1] * 0.55, -h[2] - G.skinOff), dir: P(0, 0, -1), up: P(1, 0, 0), kind: 'wca', mastLen: 0.1 })
  if (o.sensors !== false) {
    for (const [x, y] of [[h[0] * 0.18, -h[1] * 0.7], [-h[0] * 0.18, -h[1] * 0.7]]) earthSensor(put, { base: P(x, y, ZN), dir: Z, up: P(1, 0, 0), type: 'ires' })
  }
  for (const [x, y, ap] of o.horns || []) {
    const A = ap || 0.12
    hwFeedHorn(put, { ap: P(x, y, ZN + 2.12 * A), dir: Z, up: P(1, 0, 0), D: A, L: 2.12 * A, style: 'terraced', mat: { body: 'aluminum', rim: 'gold_metal', inner: 'black_paint' }, seg: 20 })
  }
  g.flush()
}

/** 对地板双轴万向节点波束天线（parts.gimbalDish 的 GEO 便捷封装）：at = [x, y]，look 缺省对地。 */
export function gimbalSpot(B, h, { name, title, at, D, look, postH, mat, articulate = true }) {
  return gimbalDish(B, { name, title, base: P(at[0], at[1], h[2] + G.skinOff), n: Z, look: look || Z, D, fd: 0.38, postH: isNum(postH) ? postH : 0.35 * D, mat: mat || 'reflector', articulate })
}

// ───────────────────────────── 仪器 / 伸杆 ─────────────────────────────

/**
 * 仪器盒（成像仪 / 探测仪 / 闪电成像仪 / 太阳观测仪……）：盒体 + 口径窗（深色玻璃）+ 窗口遮光檐 + 辐冷板。
 * o = { name, title, c（盒中心，本体系）, size:[x,y,z]（全尺寸）, mat?（缺省 mli_silver）,
 *       aperture?:{dir:[…]（窗口朝向，只认 ±x/±y/±z 轴向）, w, h, shade?（遮光檐伸出长）}, cooler?:{dir, w, h}（辐冷板，常朝北）, massKg? }
 */
export function instrument(B, o) {
  const g = group(B, o.name, o.title || o.name, 'sensor')
  const h = o.size.map((v) => v / 2)
  bevelBox(g.mb(o.mat || 'mli_silver'), BODY, o.c, h, Math.min(0.02, 0.1 * Math.min(...h)))
  const face = (dir, w, hh, mat, out = 0.004) => {
    const d = nrm(dir), k = Math.abs(d[0]) > 0.5 ? 0 : Math.abs(d[1]) > 0.5 ? 1 : 2
    const ctr = madd(o.c, d, h[k] + out)
    const F = frameZX(ctr, d, k === 2 ? [1, 0, 0] : [0, 0, 1])
    quadPts(g.mb(mat), toW(F, [-w / 2, -hh / 2, 0]), toW(F, [w / 2, -hh / 2, 0]), toW(F, [w / 2, hh / 2, 0]), toW(F, [-w / 2, hh / 2, 0]), d)
    return { F, k, d }
  }
  if (o.aperture) {
    const a = o.aperture, f = face(a.dir, a.w, a.h, 'dark_glass')
    if (a.shade > 0) {
      // 遮光檐：口径四周四片斜板（白色），外张 15°
      const sh = a.shade, sp = Math.tan(15 * Math.PI / 180) * sh
      const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
      for (let i = 0; i < 4; i++) {
        const [x0, y0] = C[i], [x1, y1] = C[(i + 1) % 4]
        const p0 = toW(f.F, [x0 * a.w / 2, y0 * a.h / 2, 0]), p1 = toW(f.F, [x1 * a.w / 2, y1 * a.h / 2, 0])
        const q1 = toW(f.F, [x1 * (a.w / 2 + sp), y1 * (a.h / 2 + sp), sh]), q0 = toW(f.F, [x0 * (a.w / 2 + sp), y0 * (a.h / 2 + sp), sh])
        const mid = scl(add(add(p0, p1), add(q0, q1)), 0.25), cen = toW(f.F, [0, 0, sh / 2])
        const n = nrm(sub(mid, cen))
        quadPts(g.mb(a.shadeMat || 'white_paint'), p0, p1, q1, q0, n)
        quadPts(g.mb(a.shadeMat || 'white_paint'), p0, q0, q1, p1, scl(n, -1))
      }
    }
  }
  if (o.cooler) face(o.cooler.dir, o.cooler.w, o.cooler.h, 'radiator', 0.006)
  g.flush()
  if (isNum(o.massKg)) B.point(o.name, o.massKg, o.c)
  if (o.aperture) B.ap(o.name, madd(o.c, nrm(o.aperture.dir), Math.max(...h)), nrm(o.aperture.dir))
}

/**
 * 可盘绕桁架杆（coilable lattice mast，磁强计杆常用）：三根纵杆按三角排布，每节一圈横撑 + 一根斜撑。画进 mb。
 * @param {MB} mb
 * @param {number[]} from @param {number[]} to
 * @param {{r?:number, bay?:number, rod?:number}} [o] r 三角外接圆半径、bay 节距、rod 杆径
 */
export function latticeBoom(mb, from, to, o = {}) {
  const r = o.r || 0.1, bay = o.bay || 0.45, rr = o.rod || 0.008
  const d = nrm(sub(to, from)), L = len(sub(to, from)), [e1, e2] = perpPair(d)
  const n = Math.max(1, Math.round(L / bay))
  const node = (i, k) => { const t = (2 * Math.PI * k) / 3 + i * 0.35; return madd(add(madd(from, d, (L * i) / n), scl(e1, r * Math.cos(t))), e2, r * Math.sin(t)) }
  for (let k = 0; k < 3; k++) for (let i = 0; i < n; i++) cyl(mb, node(i, k), node(i + 1, k), rr, 4, false, false)
  for (let i = 0; i <= n; i++) for (let k = 0; k < 3; k++) cyl(mb, node(i, k), node(i, (k + 1) % 3), rr * 0.8, 4, false, false)
  for (let i = 0; i < n; i++) cyl(mb, node(i, i % 3), node(i + 1, (i + 1) % 3), rr * 0.7, 4, false, false)
}

/** 伸杆（磁强计杆 / 太阳帆杆）：from → to 一根细管，末端可挂探头盒（tip:[x,y,z] 全尺寸）或配平板（sail:{w, h, mat}）。 */
export function boom(B, o) {
  const g = group(B, o.name, o.title || o.name, 'boom')
  const r = o.r || 0.025
  cyl(g.mb(o.mat || 'carbon'), o.from, o.to, r, 10, true, true)
  B.rod(`${o.name}_rod`, o.from, o.to)
  if (o.tip) obox(g.mb(o.tipMat || 'mli_gold'), frameZX(o.to, nrm(sub(o.to, o.from)), [0, 0, 1]), [0, 0, o.tip[2] / 2], o.tip.map((v) => v / 2))
  if (o.sail) {
    const d = nrm(sub(o.to, o.from)), F = frameZX(o.to, o.sail.normal || [0, 0, -1], d)
    obox(g.mb(o.sail.mat || 'mli_silver'), F, [0, o.sail.h / 2, 0], [o.sail.w / 2, o.sail.h / 2, 0.01])
  }
  g.flush()
}

// ───────────────────────────── 自旋稳定圆柱星 ─────────────────────────────

/**
 * 自旋稳定圆柱星（Meteosat 第二代这类）：自旋轴 = 本体 Y（南北，⟂ 轨道面）；侧面一整圈体装电池（太阳鼓），朝 +Z 一块开成像仪光窗；
 * 顶端（top，缺省 −Y 北）天线平台：居中圆柱电子消旋阵 + 白色顶盘 + 中央桅杆、外缘一圈交叉偶极子；底端（+Y）锥形遮阳罩与推力器。
 * o = { D, H（鼓直径 / 高）, facets?（侧面棱数，缺省 32）, top?:-1|1（天线端，缺省 −1 = 北）,
 *       window?:{w, h, y?, frameMat?}（光窗：跑道形深色口 + 边框，朝 +Z，y 为中心高度）, patches?:[{az（度，自 +Z 绕 Y）, y, w, h, mat}]（鼓侧方窗）,
 *       eda?:{d, h, discD?, mastD?, mastH?, rodH?}（电子消旋阵 + 顶盘 + 测控桅杆 / 顶端细杆；false 不画）, dipoles?:{n, h, r?}（偶极子环）,
 *       shade?:{d0, d1, h}（底端锥罩：根部径 / 末端径 / 高）, panels?（弧形板块数，画板缝）, rimMat?（鼓上下沿包边）, cellMat?, efficiency? }
 * 太阳电池登记成一个太阳翼组（体装，无关节）；平台体质量元由 finishModel 按整星质量吃余量。
 */
export function spinnerSat(B, o) {
  const R = o.D / 2, H = o.H, hy = H / 2, nf = o.facets || 32
  const top = o.top === 1 ? 1 : -1, yT = top * hy, yB = -top * hy
  const g = group(B, 'bus', '平台体（自旋太阳鼓）', 'bus')
  const cells = new MB()
  const ring_ = (y, r = R) => { const pts = []; for (let k = 0; k < nf; k++) { const t = (2 * Math.PI * k) / nf; pts.push(P(r * Math.sin(t), y, r * Math.cos(t))) } return pts }
  // 侧面：一整圈电池（每棱一块平面，法向取棱中）
  const a = ring_(-hy + 0.04), b = ring_(hy - 0.04)
  for (let k = 0; k < nf; k++) {
    const k1 = (k + 1) % nf, tm = (2 * Math.PI * (k + 0.5)) / nf
    quadPts(cells, a[k], a[k1], b[k1], b[k], P(Math.sin(tm), 0, Math.cos(tm)))
  }
  // 板缝：太阳鼓由 o.panels 块弧形板拼成（竖向细缝），外加一道腰缝
  const seams = o.panels | 0
  for (let k = 0; k < seams; k++) {
    const t = (2 * Math.PI * (k + 0.5)) / seams, n = P(Math.sin(t), 0, Math.cos(t)), u = P(Math.cos(t), 0, -Math.sin(t))
    const c = madd(P(0, 0, 0), n, R + 0.003)
    quadPts(g.mb('struct_light'), madd(madd(c, u, -0.008), [0, 1, 0], -hy + 0.04), madd(madd(c, u, 0.008), [0, 1, 0], -hy + 0.04), madd(madd(c, u, 0.008), [0, 1, 0], hy - 0.04), madd(madd(c, u, -0.008), [0, 1, 0], hy - 0.04), n)
  }
  // 上下沿包边带（4 cm）+ 两端面
  const rim = o.rimMat || 'mli_gold'
  for (const s of [1, -1]) {
    const r0 = ring_(s * hy), r1 = ring_(s * (hy - 0.04))
    for (let k = 0; k < nf; k++) {
      const k1 = (k + 1) % nf, tm = (2 * Math.PI * (k + 0.5)) / nf
      quadPts(g.mb(rim), r0[k], r0[k1], r1[k1], r1[k], P(Math.sin(tm), 0, Math.cos(tm)))
      tri(g.mb(rim), P(0, s * hy, 0), r0[k], r0[k1], P(0, s, 0))
    }
  }
  // 光窗（朝 +Z）：跑道形（上下两端半圆）深色开口 + 铜色 Kapton 边框——离电池面 6 mm 盖在上面
  const win = o.window || { w: 0.75, h: 1.3 }
  const zw = R + 0.006, yw = isNum(win.y) ? win.y : 0
  const stadium = (w, h, z) => {
    const r = w / 2, pts = []
    for (let k = 0; k <= 12; k++) { const t = Math.PI * k / 12; pts.push(P(r * Math.cos(t), yw + (h / 2 - r) + r * Math.sin(t), z)) }
    for (let k = 0; k <= 12; k++) { const t = Math.PI + Math.PI * k / 12; pts.push(P(r * Math.cos(t), yw - (h / 2 - r) + r * Math.sin(t), z)) }
    return pts
  }
  const fr = 0.07
  const so = stadium(win.w + 2 * fr, win.h + 2 * fr, zw), si = stadium(win.w, win.h, zw + 0.002)
  for (let k = 0; k < so.length; k++) { const k1 = (k + 1) % so.length; quadPts(g.mb(win.frameMat || 'copper'), so[k], so[k1], si[k1], si[k], Z) }
  for (let k = 0; k < si.length; k++) tri(g.mb('dark_glass'), P(0, yw, zw + 0.002), si[k], si[(k + 1) % si.length], Z)
  // 鼓侧方窗（金色 MLI 等）
  for (const p of o.patches || []) {
    const t = (p.az * Math.PI) / 180, n = P(Math.sin(t), 0, Math.cos(t)), u = P(Math.cos(t), 0, -Math.sin(t))
    const c = madd(P(0, p.y || 0, 0), n, zw)
    quadPts(g.mb(p.mat || 'mli_gold'), madd(madd(c, u, -p.w / 2), [0, 1, 0], -p.h / 2), madd(madd(c, u, p.w / 2), [0, 1, 0], -p.h / 2), madd(madd(c, u, p.w / 2), [0, 1, 0], p.h / 2), madd(madd(c, u, -p.w / 2), [0, 1, 0], p.h / 2), n)
  }
  g.flush()
  B.item('body_cells', { part: { id: 'body_cells', name: '体装太阳电池（太阳鼓）', role: 'solarArray' }, role: 'solarArray', mat: o.cellMat || 'solar_cell', mb: cells })
  B.spg('body', ['body_cells'], isNum(o.efficiency) ? o.efficiency : 17)   // 部件面积由 finishModel 按网格量
  B.box('bus', 1000, P(0, 0, 0), P(R * 0.75, hy, R * 0.75))
  // 顶端天线平台
  const gA = group(B, 'antenna_farm', '天线平台（电子消旋阵 / UHF 偶极子 / 测控桅杆）', 'feed')
  const out = (d) => yT + top * d   // 自顶端面向外 d
  if (o.eda !== false) {
    const e = o.eda || { d: 1.3, h: 0.5 }
    cyl(gA.mb('mli_silver'), P(0, out(0), 0), P(0, out(e.h), 0), e.d / 2, 40, false, false)
    disc(gA.mb('white_paint'), P(0, out(e.h + 0.01), 0), P(0, top, 0), (e.discD || e.d * 1.15) / 2, 40)
    disc(gA.mb('white_paint'), P(0, out(e.h), 0), P(0, -top, 0), (e.discD || e.d * 1.15) / 2, 40)
    const mh = isNum(e.mastH) ? e.mastH : 0.42, rh = isNum(e.rodH) ? e.rodH : 0.2
    cyl(gA.mb('dark_metal'), P(0, out(e.h + 0.01), 0), P(0, out(e.h + 0.01 + mh), 0), (e.mastD || 0.28) / 2, 20, false, true)
    if (rh > 0) cyl(gA.mb('aluminum'), P(0, out(e.h + 0.01 + mh), 0), P(0, out(e.h + 0.01 + mh + rh), 0), 0.02, 8, false, true)
    B.ap('eda', P(0, out(e.h / 2), e.d / 2), Z)
  }
  if (o.dipoles) {
    const dp = o.dipoles, rr = dp.r || R * 0.86
    for (let k = 0; k < dp.n; k++) {
      const t = (2 * Math.PI * k) / dp.n, x = rr * Math.sin(t), z = rr * Math.cos(t)
      cyl(gA.mb('mli_gold'), P(x, out(0), z), P(x, out(dp.h), z), 0.018, 8, false, true)
      const c = P(x, out(dp.h), z), e1 = P(Math.cos(t), 0, -Math.sin(t)), e2 = P(Math.sin(t), 0, Math.cos(t))
      cyl(gA.mb('aluminum'), madd(c, e1, -0.11), madd(c, e1, 0.11), 0.007, 6, true, true)
      cyl(gA.mb('aluminum'), madd(c, e2, -0.11), madd(c, e2, 0.11), 0.007, 6, true, true)
    }
  }
  gA.flush()
  B.point('antenna_farm', 60, P(0, out(0.4), 0))
  // 底端：锥形遮阳罩（成像仪被动制冷器）+ 推力器
  const gS = group(B, 'cooler_shade', '制冷器遮阳罩', 'sensor')
  const sd = o.shade || { d0: 1.3, d1: 0.6, h: 0.32 }
  cone(gS.mb('mli_silver'), P(0, yB, 0), sd.d0 / 2, P(0, yB - top * sd.h, 0), sd.d1 / 2, 32, false, false)
  disc(gS.mb('dark_metal'), P(0, yB - top * sd.h, 0), P(0, -top, 0), sd.d1 / 2, 32)
  for (let k = 0; k < 4; k++) {
    const t = (Math.PI / 2) * k + Math.PI / 4, p = P(R * 0.85 * Math.sin(t), yB - top * 0.012, R * 0.85 * Math.cos(t))
    nozzle(gS.mb('titanium'), p, P(0, -top, 0), 0.03, 0.08)
  }
  gS.flush()
  B.ap('imager', P(0, 0, zw), Z)
  return { R, hy }
}

// ───────────────────────────── 整星 ─────────────────────────────

/**
 * 整星：cfg = { bus（geoBus 参数）, wings?（geoWings 参数）, side?:[sideReflector…], tower?:[deckTower…], deck?:[deckReflector…],
 *              mesh?:[meshReflector…], gimbals?:[gimbalSpot…], ep?（epArms 参数 | true）, furniture?（deckFurniture 参数）, extra?(B, body) }
 * @returns {{h, ZN, ZA}}
 */
export function buildGeo(B, cfg) {
  const body = geoBus(B, cfg.bus)
  const { h } = body
  if (cfg.wings) geoWings(B, h, cfg.wings)
  // 天线塔裹平台对地面同色 MLI
  const towerMat = (cfg.bus.faces && cfg.bus.faces.deck) || 'mli_gold'
  for (const t of cfg.tower || []) deckTower(B, h, { mat: towerMat, ...t })
  for (const r of cfg.side || []) sideReflector(B, h, r)
  for (const r of cfg.deck || []) deckReflector(B, h, { towerMat, ...r })
  for (const m of cfg.mesh || []) meshReflector(B, h, m)
  for (const s of cfg.gimbals || []) gimbalSpot(B, h, s)
  if (cfg.ep) epArms(B, h, cfg.ep === true ? {} : cfg.ep)
  if (cfg.furniture !== false) deckFurniture(B, h, cfg.furniture || {})
  if (cfg.extra) cfg.extra(B, body)
  B.ap('nadir_center', P(0, 0, h[2]), Z)
  B.ap('zenith_center', P(0, 0, -h[2]), P(0, 0, -1))
  return body
}
