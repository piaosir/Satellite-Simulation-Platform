// 参数化整星生成（任务书 §5.6、附录 A 档 1；设计契约 §3.1 IR、§3.5 id）。
//
// spec → { ir, attachPoints, articulations, solarPanelGroups, massProps, parts, frame, … }，纯函数、确定性：
// 同一份 spec 两次生成的 IR 逐字段相等（不用随机数、不读时钟、遍历顺序固定），specHash 稳定。
// 渲染端只负责把 IR 变 three 几何（irToThree.js）；本模块不碰 three，node / Worker / 主进程都能跑。
//
// ★ 坐标（为什么这么绕）：
//   几何一律先在【本体系】里建（+X 速度、+Y 补全右手、+Z 天底；GEO 下 ±Y=南北面挂太阳翼、±X=东西面挂反射面），
//   因为布局规则、挂点、质量特性都按本体系写才看得懂。输出 IR 时不去改每个顶点，而是在最外层放一个根节点
//   「satellite」，其矩阵 = 出厂映射的逆（bodyFrame.mjs ROOT_MATRIX_BODY2MODEL；出厂映射 = STK 映射，本体 → glTF 模型轴：
//   model.x = body.y、model.y = body.z、model.z = body.x），子节点仍是本体系坐标。于是 IR 在模型轴下是 STK 口径的 glTF
//   （+Y = 天底面、+Z = 速度向，与 STK 自带 tdrs.glb 同习惯），而 frame.q_model2body 恰好是出厂默认值——
//   按默认映射摆回本体系就是生成时的样子，无需任何覆盖；导出到 STK 天线也朝地。
//   出厂映射只在 bodyFrame.mjs 定义一次，这里 import，不抄数（2026-09-24 从附录 B 切到 STK 映射时只改了那一处）。
//   IR 原点 = 几何中心（本体系包围盒中心）：建完后整体平移，平移量在 specOriginBody 里（spec 坐标 = 输出坐标 + 它）。
//
// ★ 太阳翼节点为什么是「平铺」的：
//   AGI 规范里一个 articulation 可被多个节点引用、各自在【自己的局部系】里做 yRotate。若翼内节点层层嵌套，
//   父子都挂同一关节就会转两遍。所以每翼的轭 / 各板基板 / 各板电池面都是根节点的直接子节点，且共用同一个局部系：
//   原点在南北面 SADA 转轴处、局部 +y 沿翼展向外、局部 +z 为电池面法向——对每个节点做 yRotate 恰好是整翼绕翼轴刚体转动。
//   太阳翼组只含电池面节点（AGI：组内节点的全部网格都当受光面），基板 / 轭 / SADA 另成节点。
//
// ★ 挂点节点（与 agi.mjs「挂点节点的轴向口径」同一套，按本机 STK 12 核定）：节点局部 +Y = 视轴、局部 +X = 上向，
//   矩阵一律由 agi.mjs 的 attachNodeMatrix 造（attachPointPoses 读回才是同一套数）；上向缺省按二期契约 D1
//   （bodyFrame.defaultUpBody：本体 −Y 在视轴法平面的投影，退化取 +X），与 schema.normalizeMeta 的挂点兜底同一口径。
//
// ★ 反射面约定（与 segment.mjs 一致）：
//   母抛物面：顶点 V、单位轴 a（由顶点指向焦点）、焦距 f，焦点 F = V + f·a；偏置口径面中心到母轴距离 offsetHM（GRASP 口径）。
//   反射面焦点挂点：pos = F，dir = a —— 天线波束视轴，沿母轴离开反射面凹侧（馈源在焦点、朝反射面，即沿 −dir 看过去
//   正对反射面；平行于轴的出射波束沿 +dir 离开）。GEO 对地通信星 a ≈ +Z_body。
//
// 导出：
//   buildParamModel(spec)            → 结果（见函数注释）；spec 不合法、或生成结果含非有限数时抛 Error
//                                      （err.code='SPEC_INVALID'，err.errors / err.missing）
//   buildTemplateModel(id, {fill})   → 同上（先 templateSpec 再生成），另带 template 信息（id 可为旧模板 id 别名，template.id 为现行 id）
//   validateSpec(spec)               → {ok, errors, missing}；missing 的路径写法与 paramTemplates 的 needsInput 相同
//   normalizeSpec(spec)              → 补缺省后的深拷贝（生成器实际用的那份；幂等）
//   specHash(spec)                   → 16 位十六进制（normalizeSpec 后规范化 JSON 的 FNV-1a 64）
//   paramModelIdForSpec(spec)        → 'param:<specHash 前 12 位>'（用户改过参数后保存用）
//   LAYOUT_PRESETS                   → 布局族可配的细节档（生成页下拉按它过滤）
//   PRESET_KEYS                      → 各布局族生成器会读的细节档键（单测查每档带齐）
//   DENSITY                          → 密度 / 面密度表（可在 spec.density 里逐项覆盖 value）
//   MATERIALS                        → IR 材质库（按 MaterialKey）
//   DEFAULT_Q_MODEL2BODY, ROOT_MATRIX
//   ——装配组件复用（DESIGN3 §1；网格原语、质量元、生成上下文、paraLayout 在 meshKit.mjs）——
//   buildWing(ctx, w, opt)           → 太阳翼（w 须是归一后的条目；给 hingeBody 就不读 ctx.spec；无 ctx.spec 时 SADA 单独成件，
//                                      opt.sadaPart / opt.sadaMassKg 可覆盖部件归属、登记 SADA 质量）
//   buildReflector(ctx, r, i, L)     → 偏置抛物面反射面（L = meshKit.paraLayout(...) 再补 mesh）
//   buildFeed(ctx, r, i, L, towerTop)→ 馈源（L 不带平台半边长 h、towerTop 为空时不画支架）
//   resolveDensity(over)             → 密度表取值（DENSITY.value，over 逐项覆盖）；createCtx({dens: …}) 用
//   SOLAR_EFFICIENCY_DEFAULT         → 太阳翼组效率缺省（%）
//   defaultSidePanelAt(panels)       → 侧板缺省挂在第几块（倒数第二块 → 十字形翼）
//   canon(v) / fnv1a64Hex(str)       → 规范化 JSON / FNV-1a 64（specHash = fnv1a64Hex(canon(normalizeSpec(spec)))）
//   nonFiniteReport(res)             → 生成结果里含非有限数的对象名（出口兜底）

import { DETAIL_PRESETS, templateSpec, TEMPLATES, resolveTemplateId } from './paramTemplates.mjs'
import { DEFAULT_Q_MODEL2BODY, ROOT_MATRIX_BODY2MODEL } from './bodyFrame.mjs'
import { attachNodeMatrix } from './agi.mjs'
// 网格原语 / 质量元 / 生成上下文（DESIGN3 §1 P0 从本文件原样抽出，装配组件共用；零漂移由 modelMeshKit 金标准看守）
import {
  isNum, isVec3, add, sub, scl, cross, len, nrm, reject, madd, clampN, z0, IDR, rApply, rotAboutLocalY, m3zero, m3add, pAxis, rotInertia,
  MB, quad, box, perpPair, frustum, tube, annulus, horn, worldPositions, meshArea, shellProps,
  createCtx, addItem, comp, boxComp, plateComp, rodComp, shellComp, pointComp, addAp, paraLayout, colMajor
} from './meshKit.mjs'
// 星上硬件造型库（喇叭 / 馈电链 / 喷管 / SADA 护套 / 对接环 …，2026-10-08）：只出网格，质量元照旧由本文件按包络登记
import { feedHorn, feedChain, bellNozzle, rcsPod, rcsThruster, hallThruster, earthSensor, starTrackerHead, wedgeMount, wcaHorn, ttcBicone, sadaBoot, lvRing, reflectorBacking, adtmBlock } from './hardware.mjs'
import { siLines } from './solarArrays.mjs'
import { quadPts } from './fleet/kit.mjs'

// ───────────────────────────── 常量 ─────────────────────────────

/** 出厂 q_model2body（bodyFrame.mjs 的唯一真值源，转出供老调用方按名取；本模块生成的 frame.q_model2body 就是它）。 */
export { DEFAULT_Q_MODEL2BODY }
/** 根节点矩阵（列主序）：本体 → 模型轴 = 出厂 Rᵀ（= bodyFrame.ROOT_MATRIX_BODY2MODEL）。列 = 本体 X/Y/Z 在模型轴下的像。 */
export const ROOT_MATRIX = ROOT_MATRIX_BODY2MODEL

/**
 * 密度表。value 可被 spec.density[key] 覆盖（数字）。没有一项有逐字出处——全部标 illustrative，写明量级依据。
 * 面密度按「逻辑面积」计（板取 宽×长，不算侧边；反射面取反射面面积，背面与边环不另计）。
 */
export const DENSITY = Object.freeze({
  // busVolume 量级：GEO 大平台公开参数（发射质量 5200 kg、平台体 2.36 × 2.1 × 3.6 m），数值示意
  busVolume: Object.freeze({ value: 290, unit: 'kg/m³', source: 'illustrative', note: '平台体等效体密度（含推进剂）。量级：典型 GEO 大平台发射质量 5200 kg ÷ 平台体积 2.36×2.1×3.6 = 17.84 m³ ≈ 291 kg/m³' }),
  panelAreal: Object.freeze({ value: 1.5, unit: 'kg/m²', source: 'illustrative', note: '铝蜂窝夹层太阳翼基板（碳面板）面密度量级' }),
  cellAreal: Object.freeze({ value: 0.9, unit: 'kg/m²', source: 'illustrative', note: '三结砷化镓电池片 + 盖片 + 互连面密度量级' }),
  reflectorAreal: Object.freeze({ value: 1.8, unit: 'kg/m²', source: 'illustrative', note: '碳纤维夹层实面反射面（含背筋）面密度量级' }),
  meshReflectorAreal: Object.freeze({ value: 0.6, unit: 'kg/m²', source: 'illustrative', note: '可展开网状反射面（按口径面积摊入肋 / 桁架）量级' }),
  mliAreal: Object.freeze({ value: 0.4, unit: 'kg/m²', source: 'illustrative', note: '多层隔热组件面密度量级' }),
  radiatorAreal: Object.freeze({ value: 0.5, unit: 'kg/m²', source: 'illustrative', note: 'OSR 片 + 胶层面密度量级（散热板结构计入平台体）' }),
  hornAreal: Object.freeze({ value: 2.7, unit: 'kg/m²', source: 'illustrative', note: '按 1 mm 铝板：2700 kg/m³ × 0.001 m' }),
  towerAreal: Object.freeze({ value: 2.0, unit: 'kg/m²', source: 'illustrative', note: '对地板天线塔（碳纤维蒙皮）面密度量级' }),
  arrayAreal: Object.freeze({ value: 8.0, unit: 'kg/m²', source: 'illustrative', note: '平板相控阵天线面密度量级' }),
  boomLinear: Object.freeze({ value: 1.0, unit: 'kg/m', source: 'illustrative', note: '碳纤维管（轭 / 展开臂）线密度量级' }),
  laeMass: Object.freeze({ value: 4.5, unit: 'kg', source: 'illustrative', note: '400 N 级远地点发动机量级' }),
  rcsMass: Object.freeze({ value: 0.35, unit: 'kg', source: 'illustrative', note: '10 N 级推力器量级' }),
  epMass: Object.freeze({ value: 2.0, unit: 'kg', source: 'illustrative', note: '电推力器量级' }),
  // 星上天线 / 有效载荷组件（components/satAntenna.mjs、satUnit.mjs，2026-10-08）
  apmMass: Object.freeze({ value: 4.0, unit: 'kg', source: 'illustrative', note: '双轴天线指向机构（两只旋转作动器 + 支架 + 旋转关节）量级；反射面另按面密度计' }),
  helixMass: Object.freeze({ value: 0.25, unit: 'kg', source: 'illustrative', note: '单个轴向模螺旋阵元（含接地杯与支撑）量级；L 频段导航阵元' }),
  lgaMass: Object.freeze({ value: 0.15, unit: 'kg', source: 'illustrative', note: '全向 / 低增益天线（单极子、四臂螺旋、贴片）量级' }),
  lctMass: Object.freeze({ value: 15, unit: 'kg', source: 'illustrative', note: '激光通信终端（口径 80 mm 级，含粗指向机构与光学头）量级；组件按口径平方缩放' }),
  tankAreal: Object.freeze({ value: 6.0, unit: 'kg/m²', source: 'illustrative', note: '钛合金推进剂贮箱壳体面密度量级（壁厚约 1.3 mm，含焊缝与凸台）' }),
  opticsAreal: Object.freeze({ value: 450, unit: 'kg/m²', source: 'illustrative', note: '光学相机按入瞳面积折算的质量密度量级（主次镜 + 镜筒 + 遮光罩 + 焦面），0.3 m 口径约 32 kg' }),
  lraAreal: Object.freeze({ value: 25, unit: 'kg/m²', source: 'illustrative', note: '激光角反射器阵（熔石英角锥棱镜 + 铝托板）面密度量级' }),
  magMass: Object.freeze({ value: 0.3, unit: 'kg', source: 'illustrative', note: '三轴磁通门磁强计探头量级' }),
  epJointMass: Object.freeze({ value: 3.5, unit: 'kg', source: 'illustrative', note: '电推力器指向臂单个转动关节（展开铰链驱动或指向机构的一根轴，含支架）量级；推力器与臂杆另计' }),
  visorAreal: Object.freeze({ value: 1.2, unit: 'kg/m²', source: 'illustrative', note: '遮阳板（泡沫芯板或聚酰亚胺膜 + 边框）面密度量级' }),
  baptaMass: Object.freeze({ value: 15, unit: 'kg', source: 'illustrative', note: '机械消旋组件（轴承与功率传输组件 BAPTA + 消旋电机 + 桅杆接口）量级' }),
  flexAreal: Object.freeze({ value: 1.1, unit: 'kg/m²', source: 'illustrative', note: '柔性太阳电池帆（电池片 + 聚酰亚胺基底 + 互连）面密度量级；伸展杆、收纳箱另计' }),
  cubesatMass: Object.freeze({ value: 1.33, unit: 'kg', source: 'illustrative', note: '立方星每 1U 体积的质量量级（CubeSat 设计规范 CDS 第 13 版的 1U 上限 1.33 kg，第 14 版放宽到 2 kg）；立方星星体按包络体积 / 1U 体积折算' }),
  moduleVolume: Object.freeze({ value: 150, unit: 'kg/m³', source: 'illustrative', note: '密封舱段等效体密度量级：空间站核心舱约 22.5 t ÷ 160 m³ ≈ 140、货运飞船约 13.5 t ÷ 88 m³ ≈ 150 kg/m³' })
})

/** IR 材质库（线性色；W5 materials.js 按 key 换成真正的 PBR 材质，这里给的是无程序纹理时的合理回退）。 */
export const MATERIALS = Object.freeze({
  mli_gold: Object.freeze({ color: [0.83, 0.6, 0.25], metalness: 1, roughness: 0.28 }),
  mli_silver: Object.freeze({ color: [0.85, 0.85, 0.85], metalness: 1, roughness: 0.25 }),
  mli_black: Object.freeze({ color: [0.03, 0.03, 0.03], metalness: 0.2, roughness: 0.5 }),
  kapton_black: Object.freeze({ color: [0.03, 0.03, 0.03], metalness: 0.2, roughness: 0.5 }),
  solar_cell: Object.freeze({ color: [0.02, 0.04, 0.12], metalness: 0.35, roughness: 0.18 }),
  solar_substrate: Object.freeze({ color: [0.55, 0.56, 0.58], metalness: 0.1, roughness: 0.6 }),
  reflector: Object.freeze({ color: [0.92, 0.92, 0.92], metalness: 0, roughness: 0.55 }),
  reflector_mesh: Object.freeze({ color: [0.8, 0.66, 0.35], metalness: 0.8, roughness: 0.45, doubleSided: true, opacity: 0.85 }),
  aluminum: Object.freeze({ color: [0.91, 0.92, 0.92], metalness: 1, roughness: 0.35 }),
  radiator: Object.freeze({ color: [0.95, 0.95, 0.96], metalness: 0.9, roughness: 0.08 }),
  titanium: Object.freeze({ color: [0.62, 0.6, 0.57], metalness: 1, roughness: 0.4 }),
  carbon: Object.freeze({ color: [0.06, 0.06, 0.07], metalness: 0.3, roughness: 0.45 }),
  white_paint: Object.freeze({ color: [0.9, 0.9, 0.88], metalness: 0, roughness: 0.6 }),
  glass: Object.freeze({ color: [0.9, 0.95, 1], metalness: 0, roughness: 0.05, opacity: 0.3 }),
  dark_metal: Object.freeze({ color: [0.12, 0.12, 0.13], metalness: 0.8, roughness: 0.4 }),
  // A3 扩充（颜色线性；A3 规格 §11-3）：漆面均为非金属。防污漆（水线下）无光，干舷 / 集装箱 / 机身漆半光，甲板防滑漆偏糙
  paint_red: Object.freeze({ color: [0.45, 0.05, 0.04], metalness: 0, roughness: 0.7 }),
  paint_navy: Object.freeze({ color: [0.03, 0.05, 0.12], metalness: 0, roughness: 0.5 }),
  paint_blue: Object.freeze({ color: [0.05, 0.18, 0.45], metalness: 0, roughness: 0.55 }),
  paint_green: Object.freeze({ color: [0.12, 0.3, 0.14], metalness: 0, roughness: 0.75 }),
  paint_orange: Object.freeze({ color: [0.8, 0.3, 0.05], metalness: 0, roughness: 0.45 }),
  paint_yellow: Object.freeze({ color: [0.8, 0.6, 0.08], metalness: 0, roughness: 0.55 }),
  paint_grey: Object.freeze({ color: [0.45, 0.47, 0.5], metalness: 0, roughness: 0.45 }),
  rubber: Object.freeze({ color: [0.02, 0.02, 0.02], metalness: 0, roughness: 0.9 }),
  concrete: Object.freeze({ color: [0.55, 0.54, 0.5], metalness: 0, roughness: 0.95 }),
  // 星上硬件造型库（hardware.mjs，2026-10-08）：阿洛丁 / 镀金件（馈源口沿、线圈、注入器颈）、锗镀黑聚酰亚胺遮阳膜（深灰微金属光泽，
  // 调研 #2E2F33）、氮化硼陶瓷（霍尔放电通道环，白）、消光黑漆（遮光罩 / 喷管 / 喇叭内壁）。与星座精模的同名定制色同值
  gold_metal: Object.freeze({ color: [0.85, 0.62, 0.28], metalness: 1, roughness: 0.3 }),
  sunshield: Object.freeze({ color: [0.027, 0.028, 0.032], metalness: 0.55, roughness: 0.45 }),
  ceramic: Object.freeze({ color: [0.78, 0.77, 0.74], metalness: 0, roughness: 0.8 }),
  black_paint: Object.freeze({ color: [0.025, 0.025, 0.028], metalness: 0, roughness: 0.55 }),
  // 星上天线造型库（antennas.mjs，2026-10-08）：天线罩 / 阵面罩（石英布、锗涂层 Kapton 的白色介质罩，比白漆更哑）、裸铜（螺旋阵元、
  // 贴片、馈线）。与星座精模的同名定制色同值（精模从此改走语义键，外观不变）
  radome: Object.freeze({ color: [0.80, 0.80, 0.77], metalness: 0, roughness: 0.78 }),
  copper: Object.freeze({ color: [0.80, 0.46, 0.28], metalness: 1, roughness: 0.35 }),
  // 硅太阳电池（亮蓝，东三平台 / 北斗二号 / 早期卫星；solarArrays.mjs 另画白色汇流条）。与星座精模 FLEET_MATERIALS.cell_si 同值
  cell_si: Object.freeze({ color: [0.05, 0.11, 0.42], metalness: 0.25, roughness: 0.28 })
})

export const SOLAR_EFFICIENCY_DEFAULT = 28   // 太阳翼组效率缺省（百分数，AGI_stk_metadata 口径；装配件太阳翼组件同一缺省）
const CELL_LIFT = 0.0005              // 电池面离基板表面（防 z-fighting）
const PARA_NA = 48, PARA_NR = 12      // 抛物面细分：周向 48 × 径向 12（任务书 ≥ 48×12）

// ───────────────────────────── spec 校验 / 归一 / 哈希 ─────────────────────────────

const LAYOUTS = ['geo', 'leo-flat', 'cubesat']
const SIDE_SLOTS = ['+X', '-X', '+X2', '-X2']
const DECK_SLOTS = ['deck+Y', 'deck-Y']
const FEED_TYPES = ['horn', 'array']
const BUS_SHAPES = ['box']   // cylinder / hex（任务书 §5.6）未实现：validateSpec 报错，不静默画成盒子

/**
 * 布局族 → 可配的细节档（第一个是缺省）。错配时生成器会从另一族的档里读到 undefined，整星几何变 NaN
 * （09-23 审查四种错配都复现过），所以 validateSpec 按这张表拒绝。
 */
export const LAYOUT_PRESETS = Object.freeze({
  geo: Object.freeze(['geo', 'small']),
  'leo-flat': Object.freeze(['leo']),
  cubesat: Object.freeze(['cubesat'])
})

// 各生成器从细节档里读的键。PRESET_KEYS[layout] ⊆ 该族每一档的键（单测逐档查有限数）。
const KEYS_REFLECTOR = ['fdSide', 'fdSolid', 'fdMesh', 'meshAboveDM', 'feedInsetM', 'feedStandoffM', 'wallGapM', 'shellM', 'towerWM', 'reflDetailScale', 'meshTrussDepthFrac', 'meshTrussRodFrac']
const KEYS_WING = ['sadaLenM', 'sadaDM', 'yokeRodDM', 'panelTM', 'cellMarginM', 'gapM']
export const PRESET_KEYS = Object.freeze({
  geo: Object.freeze([...KEYS_WING, ...KEYS_REFLECTOR, 'yokeLenM', 'mliOffM', 'radiatorFrac', 'adapterDM', 'adapterHM', 'deckHorns', 'hornApM', 'hornLenM', 'laeExitDM', 'laeLenM', 'rcsExitDM', 'rcsLenM']),
  'leo-flat': Object.freeze([...KEYS_WING, ...KEYS_REFLECTOR, 'phasedTiles', 'phasedTileFrac', 'phasedTileTM', 'thrusterDM', 'thrusterLenM']),
  cubesat: Object.freeze([...KEYS_REFLECTOR, 'railWM', 'railFootM', 'panelTM', 'cellMarginM', 'bodyCellFrac', 'cellLiftM', 'bodyInsetM', 'patchWM'])
})

/**
 * 偏置方向与视轴的最小夹角正弦（≈ 2.9°）。低于它时「偏置方向在视轴法平面上的投影」又短又随参数乱翻，
 * 恰好平行时退化成零向量、整副反射面塌成一个点（面积 0、不出告警）——validateSpec 直接拒绝。
 */
const OFFSET_PAR_MIN = 0.05
const hasPreset = (k) => typeof k === 'string' && Object.hasOwn(DETAIL_PRESETS, k)
/**
 * 侧板缺省挂在第几块（1 起）：倒数第二块（外侧还留一块 → 十字形，SSL-1300 / Spacebus 4000 在轨外形），只有一块时就是它。
 * 板数不是正整数时回 1（validateSpec 另报 panels 的错）。装配组件（components/sat.mjs）与设计页快速设置同一缺省。
 */
export function defaultSidePanelAt(panels) {
  return Number.isInteger(panels) && panels >= 2 ? panels - 1 : 1
}
const slotSign = (slot) => (slot.startsWith('-') || slot === 'deck-Y' ? -1 : 1)
/** 槽位推出的缺省偏置方向（自母轴指向口径中心）：侧挂向外（±X），塔馈向南北（±Y）。 */
const slotOffsetDir = (slot) => (slot.startsWith('deck') ? [0, slotSign(slot), 0] : [slotSign(slot), 0, 0])

/**
 * @typedef {Object} WingSpec
 * @property {'+Y'|'-Y'} side      挂在哪个面（翼轴 = ±Y_body）
 * @property {number} panels        串联板数（沿翼展）
 * @property {number} panelHM       单板沿翼展长（m）
 * @property {number} panelWM       单板横宽（m，垂直翼轴、在板面内）
 * @property {number} [sidePanels] 侧板数（0 或 2）：挂在第 sidePanelAt 块两侧、与主列垂直展开（SSL-1300 / Spacebus 4000 类十字形翼）
 * @property {number} [sidePanelAt] 侧板挂在第几块（自翼根数起，1 … panels）；缺省 = 倒数第二块（panels ≥ 2；外侧还有一块 → 十字形），
 *           只有一块时就是这一块。只在 sidePanels = 2 时有意义；sidePanels = 0 时不写进归一结果（specHash 与改前一致）
 * @property {number} yokeLenM      轭长：SADA 外端到第一块板内缘（m）；0 = 无轭
 * @property {number} gapM          板间缝（m）
 * @property {number} [tiltDeg]     绕翼轴转角（度；0 时电池面朝 −Z_body，即天顶）——烘进几何，关节初值记 0
 * @property {'y'} [axis]           翼轴（保留字段，只支持 'y'）
 * @property {number[]} [hingeBody] 翼根铰点（本体系；缺省 = 南北面中心；立方星展开板用背地端棱）
 * @property {number} [efficiency]  太阳翼组效率（%，缺省 28）
 *
 * @typedef {Object} ReflectorSpec
 * @property {'+X'|'-X'|'+X2'|'-X2'|'deck+Y'|'deck-Y'} [slot]  自动布局槽位（东西侧壁展开 / 对地板天线塔馈）；给 posBody 时只用来定偏置方向。
 *           缺省 = 按 mount 取第一个没被自动布局条目占用的槽位
 * @property {'side'|'deck'} [mount]  只在没给 slot 时用来挑槽位族；归一后恒由 slot 推出
 * @property {number} diameterM     偏置口径面直径（m）
 * @property {number|null} focalM   母抛物面焦距（m）；null = 按 f/D 示意值
 * @property {number|null} offsetHM 口径面中心到母轴的距离（m，GRASP 口径）；null = 自动（内缘离侧壁留净空）
 * @property {number[]|null} posBody 焦点（= 馈源相位中心，本体系、spec 原点）；null = 按槽位自动
 * @property {number[]} [boresightBody] 母抛物面轴（波束视轴），缺省 +Z
 * @property {number[]} [offsetDirBody] 偏置方向（自母轴指向口径中心），缺省按槽位（+X / −X / ±Y）
 * @property {'horn'|'array'} [feedType]
 * @property {number} [feedApertureM]
 * @property {boolean} [mesh]       网状反射面（材质 reflector_mesh、面密度 meshReflectorAreal）
 * @property {boolean} [shaped]     赋形（一期只记录，不改几何）
 *
 * @typedef {Object} ParamSpec
 * @property {'geo'|'leo-flat'|'cubesat'} layout  布局族（通用小卫星用 geo 布局 + small 细节档）；缺省 geo
 * @property {string} [template]    源模板 id（只作记录，参与哈希）
 * @property {string} [name]
 * @property {'geo'|'small'|'leo'|'cubesat'} [detailPreset]  工程细节示意档（paramTemplates.DETAIL_PRESETS），须在
 *           LAYOUT_PRESETS[layout] 里；缺省取该族第一档
 * @property {number|null} [massTargetKg]  整星估算质量（kg）：给了就让平台体吃掉「目标 − 其余组件」的余量，总质量钉在它上；
 *           bus.massKg 显式给出时以 bus.massKg 为准、不再对齐目标
 * @property {{shape:'box', xM:number, yM:number, zM:number, mli?:string|null, massKg?:number|null}} bus
 *           平台体（只支持 box：cylinder / hex 报错）。massKg 给了就不用体密度。
 * @property {WingSpec[]|null} wings  null / 省略 = 待填（missing 'wings'）；无翼给 []；立方星省略即 []、给翼报错
 * @property {ReflectorSpec[]|null} [reflectors]  省略 = 无反射面；null = 待填（missing 'reflectors'）。三个布局族都可加
 * @property {{kind:'horn'|'patchArray', posBody:number[], dirBody:number[], apertureM:number}[]} [feeds]  额外独立馈源 / 喇叭
 * @property {{fromBody:number[], toBody:number[], dM:number}[]} [booms]  额外杆件
 * @property {{posBody:number[], dirBody:number[], exitDM:number, lengthM:number}[]} [thrusters]  额外推力器（dir = 喷流方向）
 * @property {{face:'+X'|'-X'|'+Y'|'-Y'|'+Z'|'-Z', wM:number, hM:number}[]} [radiators]  额外散热面
 * @property {{hM:number, wM:number}} [tower]  对地板天线塔（缺省按对地板反射面焦距自动）
 * @property {{mli?:boolean, radiators?:boolean, thrusters?:boolean, adapter?:boolean, deckHorns?:number}} [detail]  自动细节开关
 * @property {{tiles?:number}} [phasedArray]  LEO 平板对地面相控阵块数（1 / 2 / 4）
 * @property {{bodyCells?:boolean, deployPanels?:0|2}} [cubesat]  立方星：体装电池片 / 背地端两块展开板
 * @property {Object<string, number>} [density]  覆盖 DENSITY 的 value
 */

/**
 * 补缺省后的深拷贝（不改入参）。幂等：normalizeSpec(normalizeSpec(x)) 与 normalizeSpec(x) 逐字段相等（specHash 靠它）。
 * 非法的 layout / detailPreset 在这里换成缺省值好让生成器不崩，但 validateSpec 看的是原值、照样报错。
 */
export function normalizeSpec(spec) {
  const s = JSON.parse(JSON.stringify(spec && typeof spec === 'object' ? spec : {}))
  // 源模板 id 只作记录（参与哈希）：旧模板 id 别名换成现行 id，老 spec 与现模板 spec 记同一个来源；未知 id 原样留
  if (typeof s.template === 'string') s.template = resolveTemplateId(s.template) || s.template
  if (!LAYOUTS.includes(s.layout)) s.layout = 'geo'
  if (!hasPreset(s.detailPreset)) s.detailPreset = LAYOUT_PRESETS[s.layout][0]
  const D = DETAIL_PRESETS[s.detailPreset]
  s.bus = { shape: 'box', mli: null, massKg: null, ...(s.bus && typeof s.bus === 'object' ? s.bus : {}) }
  if (s.layout === 'cubesat' && (s.wings === undefined || s.wings === null)) s.wings = []
  if (Array.isArray(s.wings)) {
    s.wings = s.wings.map((w) => {
      const o = {
        sidePanels: 0, yokeLenM: isNum(D.yokeLenM) ? D.yokeLenM : 0, gapM: isNum(D.gapM) ? D.gapM : 0.02, tiltDeg: 0, axis: 'y',
        efficiency: SOLAR_EFFICIENCY_DEFAULT, ...(w && typeof w === 'object' ? w : {})
      }
      // 侧板位置缺省：倒数第二块（十字形；2026-10-08 前恒挂最外一块 = T 字形，与 SSL-1300 / Spacebus 4000 在轨外形不符）
      if (o.sidePanels === 2 && (o.sidePanelAt === undefined || o.sidePanelAt === null)) o.sidePanelAt = defaultSidePanelAt(o.panels)
      // 没有侧板时这一项不起作用：不留在归一结果里（驱动装配件可能写回 null），specHash 与引入它之前一致
      if (o.sidePanels !== 2 && (o.sidePanelAt === undefined || o.sidePanelAt === null)) delete o.sidePanelAt
      return o
    })
  }
  // reflectors：省略 = 无；null = 待填（保留 null，validateSpec 报缺）
  if (s.reflectors === undefined) s.reflectors = []
  if (Array.isArray(s.reflectors)) {
    const items = s.reflectors.map((r) => (r && typeof r === 'object' ? r : {}))
    const given = (v) => v !== undefined && v !== null && v !== ''
    // 没给槽位的按 mount 取第一个空闲槽位（不是按下标取模）：删掉中间一副再加一副，不会撞上还在的那副
    const used = new Set(items.filter((r) => given(r.slot) && !r.posBody).map((r) => r.slot))
    s.reflectors = items.map((r, i) => {
      let slot = r.slot
      if (!given(slot)) {
        const pool = r.mount === 'deck' ? DECK_SLOTS : SIDE_SLOTS
        slot = pool.find((q) => !used.has(q)) ?? pool[i % pool.length]
        if (!r.posBody) used.add(slot)
      }
      return {
        focalM: null, offsetHM: null, posBody: null, boresightBody: [0, 0, 1], feedType: 'horn', mesh: false, shaped: false,
        ...r, slot, mount: typeof slot === 'string' && slot.startsWith('deck') ? 'deck' : 'side'
      }
    })
  }
  for (const k of ['feeds', 'booms', 'thrusters', 'radiators']) if (!Array.isArray(s[k])) s[k] = []
  const dd = s.layout === 'geo' ? { mli: true, radiators: true, thrusters: true, adapter: true, deckHorns: D.deckHorns ?? 0 } : { mli: false, radiators: false, thrusters: s.layout === 'leo-flat', adapter: false, deckHorns: 0 }
  s.detail = { ...dd, ...(s.detail || {}) }
  if (s.layout === 'leo-flat') s.phasedArray = { tiles: D.phasedTiles, ...(s.phasedArray || {}) }
  if (s.layout === 'cubesat') s.cubesat = { bodyCells: true, deployPanels: 0, ...(s.cubesat || {}) }
  s.density = { ...(s.density || {}) }
  return s
}

/**
 * 校验（在 normalizeSpec 之后跑；layout / detailPreset 另查原值）。
 * missing = 生成必需但为空的字段路径（界面描红、按钮禁用；与 templateSpec().needsInput 同写法）；errors = 值非法。
 * 文案只写状态本身（CLAUDE.md），会原样拼进 SPEC_INVALID 的 message 显示到状态栏。
 * @returns {{ok:boolean, errors:string[], missing:string[]}}
 */
export function validateSpec(spec) {
  const raw = spec && typeof spec === 'object' ? spec : {}
  const s = normalizeSpec(spec)
  const errors = [], missing = []
  const pos = (v, path, allowZero = false) => {
    if (v === null || v === undefined) missing.push(path)
    else if (!isNum(v) || (allowZero ? v < 0 : v <= 0)) errors.push(`${path}：须为${allowZero ? '非负' : '正'}数`)
  }
  if (raw.layout !== undefined && raw.layout !== null && !LAYOUTS.includes(raw.layout)) errors.push(`layout：未知 ${raw.layout}`)
  if (raw.detailPreset !== undefined && raw.detailPreset !== null && !hasPreset(raw.detailPreset)) errors.push(`detailPreset：未知 ${raw.detailPreset}`)
  else if (!LAYOUT_PRESETS[s.layout].includes(s.detailPreset)) errors.push(`detailPreset：${s.detailPreset} 与布局 ${s.layout} 不配套`)
  if (!BUS_SHAPES.includes(s.bus.shape)) errors.push(`bus.shape：不支持 ${s.bus.shape}`)
  pos(s.bus.xM, 'bus.xM'); pos(s.bus.yM, 'bus.yM'); pos(s.bus.zM, 'bus.zM')
  if (s.bus.massKg !== null && s.bus.massKg !== undefined && !(isNum(s.bus.massKg) && s.bus.massKg > 0)) errors.push('bus.massKg：须为正数或 null')
  if (s.massTargetKg !== null && s.massTargetKg !== undefined && !(isNum(s.massTargetKg) && s.massTargetKg > 0)) errors.push('massTargetKg：须为正数或 null')
  if (s.bus.mli !== null && s.bus.mli !== undefined && !MATERIALS[s.bus.mli]) errors.push(`bus.mli：未知材质 ${s.bus.mli}`)
  if (s.wings === null || s.wings === undefined) missing.push('wings')
  else if (!Array.isArray(s.wings)) errors.push('wings：须为数组')
  else {
    const seen = new Set()
    s.wings.forEach((w, i) => {
      const p = `wings[${i}]`
      if (w.side !== '+Y' && w.side !== '-Y') errors.push(`${p}.side：须为 +Y / −Y`)
      else if (seen.has(w.side)) errors.push(`${p}.side：${w.side} 重复`)
      seen.add(w.side)
      if (w.panels === null || w.panels === undefined) missing.push(`${p}.panels`)
      else if (!(Number.isInteger(w.panels) && w.panels >= 1 && w.panels <= 20)) errors.push(`${p}.panels：须为 1–20 的整数`)
      pos(w.panelHM, `${p}.panelHM`); pos(w.panelWM, `${p}.panelWM`)
      pos(w.yokeLenM, `${p}.yokeLenM`, true); pos(w.gapM, `${p}.gapM`, true)
      if (!isNum(w.tiltDeg)) errors.push(`${p}.tiltDeg：须为数`)
      if (!(w.sidePanels === 0 || w.sidePanels === 2)) errors.push(`${p}.sidePanels：须为 0 或 2`)
      else if (w.sidePanels === 2 && Number.isInteger(w.panels) && !(Number.isInteger(w.sidePanelAt) && w.sidePanelAt >= 1 && w.sidePanelAt <= w.panels)) errors.push(`${p}.sidePanelAt：须为 1–${w.panels} 的整数`)
      if (w.hingeBody !== undefined && !isVec3(w.hingeBody)) errors.push(`${p}.hingeBody：须为 [x,y,z]`)
      if (!(isNum(w.efficiency) && w.efficiency >= 0 && w.efficiency <= 100)) errors.push(`${p}.efficiency：须在 0–100`)
    })
  }
  if (s.reflectors === null) missing.push('reflectors')
  else if (!Array.isArray(s.reflectors)) errors.push('reflectors：须为数组')
  else {
    // 只有自动布局（无 posBody）的条目占槽位：给了 posBody 的槽位只定偏置方向，可与别的条目同槽
    const slots = new Set()
    s.reflectors.forEach((r, i) => {
      const p = `reflectors[${i}]`
      const slotOk = SIDE_SLOTS.includes(r.slot) || DECK_SLOTS.includes(r.slot)
      if (!slotOk) errors.push(`${p}.slot：非法槽位 ${r.slot}`)
      else if (!r.posBody && slots.has(r.slot)) errors.push(`${p}.slot：槽位 ${r.slot} 重复`)
      if (slotOk && !r.posBody) slots.add(r.slot)
      pos(r.diameterM, `${p}.diameterM`)
      if (r.focalM !== null && !(isNum(r.focalM) && r.focalM > 0)) errors.push(`${p}.focalM：须为正数或 null`)
      if (r.offsetHM !== null && !(isNum(r.offsetHM) && r.offsetHM >= 0)) errors.push(`${p}.offsetHM：须为非负数或 null`)
      if (r.posBody !== null && !isVec3(r.posBody)) errors.push(`${p}.posBody：须为 [x,y,z] 或 null`)
      if (!FEED_TYPES.includes(r.feedType)) errors.push(`${p}.feedType：须为 horn / array`)
      if (isNum(r.feedApertureM) ? !(r.feedApertureM > 0) : (r.feedApertureM !== undefined && r.feedApertureM !== null)) errors.push(`${p}.feedApertureM：须为正数`)
      const a = isVec3(r.boresightBody) && len(r.boresightBody) >= 1e-9 ? nrm(r.boresightBody) : null
      if (!a) errors.push(`${p}.boresightBody：须为非零 [x,y,z]`)
      // 偏置方向：显式给的查它，没给的查槽位推出的缺省方向（视轴恰好沿槽位方向时缺省方向退化，同样要拒绝）
      const explicitU = r.offsetDirBody !== undefined && r.offsetDirBody !== null
      if (explicitU && !(isVec3(r.offsetDirBody) && len(r.offsetDirBody) >= 1e-9)) errors.push(`${p}.offsetDirBody：须为非零 [x,y,z]`)
      else if (a && slotOk) {
        const u0 = explicitU ? nrm(r.offsetDirBody) : slotOffsetDir(r.slot)
        if (len(reject(u0, a)) < OFFSET_PAR_MIN) errors.push(explicitU ? `${p}.offsetDirBody：与视轴近平行` : `${p}.boresightBody：与槽位 ${r.slot} 的偏置方向近平行`)
      }
    })
  }
  if (s.wings && s.wings.length && s.layout === 'cubesat') errors.push('wings：立方星不支持')
  if (s.layout === 'cubesat' && !(s.cubesat.deployPanels === 0 || s.cubesat.deployPanels === 2)) errors.push('cubesat.deployPanels：须为 0 或 2')
  if (s.layout === 'leo-flat' && ![0, 1, 2, 4].includes(s.phasedArray.tiles)) errors.push('phasedArray.tiles：须为 0 / 1 / 2 / 4')
  for (const [k, v] of Object.entries(s.density)) {
    if (!DENSITY[k]) errors.push(`density.${k}：未知键`)
    else if (!(isNum(v) && v >= 0)) errors.push(`density.${k}：须为非负数`)
  }
  s.feeds.forEach((f, i) => { if (!isVec3(f.posBody) || !isVec3(f.dirBody) || !(isNum(f.apertureM) && f.apertureM > 0)) errors.push(`feeds[${i}]：须有 posBody / dirBody / apertureM`) })
  s.booms.forEach((b, i) => { if (!isVec3(b.fromBody) || !isVec3(b.toBody) || !(isNum(b.dM) && b.dM > 0)) errors.push(`booms[${i}]：须有 fromBody / toBody / dM`) })
  s.thrusters.forEach((t, i) => { if (!isVec3(t.posBody) || !isVec3(t.dirBody) || !(isNum(t.exitDM) && t.exitDM > 0) || !(isNum(t.lengthM) && t.lengthM > 0)) errors.push(`thrusters[${i}]：须有 posBody / dirBody / exitDM / lengthM`) })
  s.radiators.forEach((r, i) => { if (!['+X', '-X', '+Y', '-Y', '+Z', '-Z'].includes(r.face) || !(isNum(r.wM) && r.wM > 0) || !(isNum(r.hM) && r.hM > 0)) errors.push(`radiators[${i}]：须有 face / wM / hM`) })
  return { ok: errors.length === 0 && missing.length === 0, errors, missing }
}

/** 规范化 JSON：键排序、−0→0、非有限数→null、undefined 丢弃（与 JSON.stringify 一致）。装配文档哈希（asmHash）同一口径。 */
export function canon(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v === 0 ? 0 : v) : 'null'
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : canon(x))).join(',') + ']'
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  }
  return 'null'
}
/**
 * spec 的稳定哈希：normalizeSpec → 规范化 JSON → UTF-8 → FNV-1a 64 位 → 16 位小写十六进制。
 * 先归一：只差「缺省值写没写出来」的两份 spec 生成同一颗星，必须拿到同一个 param:<hash> id（契约 §3.5）——
 * 否则工作台按表单 spec 算 id、存进 meta 的却是归一后的 spec，重开再存就多出一条重复条目。
 * 键顺序、−0、多余 undefined 也都不影响结果。buildParamModel 返回的 specHash === specHash(返回的 spec)。
 */
export function specHash(spec) {
  return fnv1a64Hex(canon(normalizeSpec(spec)))
}
/**
 * 字符串 → UTF-8 → FNV-1a 64 位 → 16 位小写十六进制（specHash / asmHash 共用）。
 * 64 位状态拆成四个 16 位分量（h0 最低）逐字节乘素数 0x100000001b3（分量 0x1b3 / 0 / 0x100 / 0）：每步中间量 < 2^27，全程是双精度里的精确整数，
 * 结果与 BigInt 写法逐位相同（单测对拍），却不逐字节造 BigInt、不经 TextEncoder——整份装配文档一次从几十毫秒降到亚毫秒。
 * UTF-8 就地编码，与 TextEncoder 同口径：代理对 → 4 字节；孤立代理项 → U+FFFD（EF BF BD）。
 */
export function fnv1a64Hex(str) {
  const s = String(str), n = s.length
  let h0 = 0x2325, h1 = 0x8422, h2 = 0x9ce4, h3 = 0xcbf2
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, k = 0
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) { b0 = c; k = 1 } else if (c < 0x800) { b0 = 0xc0 | (c >> 6); b1 = 0x80 | (c & 63); k = 2 } else if (c >= 0xd800 && c <= 0xdfff) {
      const d = i + 1 < n ? s.charCodeAt(i + 1) : 0
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        b0 = 0xf0 | (cp >> 18); b1 = 0x80 | ((cp >> 12) & 63); b2 = 0x80 | ((cp >> 6) & 63); b3 = 0x80 | (cp & 63); k = 4; i++
      } else { b0 = 0xef; b1 = 0xbf; b2 = 0xbd; k = 3 }
    } else { b0 = 0xe0 | (c >> 12); b1 = 0x80 | ((c >> 6) & 63); b2 = 0x80 | (c & 63); k = 3 }
    for (let j = 0; j < k; j++) {
      h0 ^= j === 0 ? b0 : j === 1 ? b1 : j === 2 ? b2 : b3
      const t0 = h0 * 0x1b3
      let t1 = h1 * 0x1b3, t2 = h2 * 0x1b3 + h0 * 0x100, t3 = h3 * 0x1b3 + h1 * 0x100
      t1 += t0 >>> 16; h0 = t0 & 0xffff
      t2 += t1 >>> 16; h1 = t1 & 0xffff
      t3 += t2 >>> 16; h2 = t2 & 0xffff
      h3 = t3 & 0xffff
    }
  }
  const x4 = (v) => (v + 0x10000).toString(16).slice(1)
  return x4(h3) + x4(h2) + x4(h1) + x4(h0)
}
/** 用户改过参数后保存的模型 id（契约 §3.5）。 */
export const paramModelIdForSpec = (spec) => `param:${specHash(spec).slice(0, 12)}`

// ───────────────────────────── 生成上下文 ─────────────────────────────

/** 密度表取值：DENSITY 的 value，over 里给了有限数的键覆盖（整星 spec.density 与装配组件同一口径）。 */
export function resolveDensity(over) {
  const o = over && typeof over === 'object' ? over : {}
  const dens = {}
  for (const k of Object.keys(DENSITY)) dens[k] = isNum(o[k]) ? o[k] : DENSITY[k].value
  return dens
}

/** 整星生成上下文：meshKit.createCtx 的通用容器 + 本星 spec / 细节档 / 密度表取值（容器形状见 meshKit 文件头）。 */
function newCtx(spec) {
  return createCtx({ spec, D: DETAIL_PRESETS[spec.detailPreset], dens: resolveDensity(spec.density) })
}

// ───────────────────────────── 部件生成器 ─────────────────────────────

/** 平台体结构盒 + MLI 包覆 + 南北散热面 + 对接环（GEO / 通用小卫星）。 */
function buildGeoBus(ctx) {
  const { spec, D, dens } = ctx
  const h = [spec.bus.xM / 2, spec.bus.yM / 2, spec.bus.zM / 2]
  const busPart = { id: 'bus', name: '星体', role: 'bus' }
  const mb = new MB(); box(mb, [0, 0, 0], h)
  addItem(ctx, { name: 'bus', role: 'bus', part: busPart, mat: 'aluminum', mb })
  const V = spec.bus.xM * spec.bus.yM * spec.bus.zM
  boxComp(ctx, 'bus', isNum(spec.bus.massKg) ? spec.bus.massKg : dens.busVolume * V, [0, 0, 0], h)

  if (spec.detail.mli && spec.bus.mli) {
    // 包覆东西面与上下面（南北面是 OSR 散热面，不包）；离结构面 mliOffM，边上留缝不互相穿插
    const o = D.mliOffM, mm = new MB()
    quad(mm, [h[0] + o, 0, 0], [0, h[1] * 0.985, 0], [0, 0, h[2] * 0.985])
    quad(mm, [-h[0] - o, 0, 0], [0, 0, h[2] * 0.985], [0, h[1] * 0.985, 0])
    quad(mm, [0, 0, h[2] + o], [h[0] * 0.985, 0, 0], [0, h[1] * 0.985, 0])
    quad(mm, [0, 0, -h[2] - o], [0, h[1] * 0.985, 0], [h[0] * 0.985, 0, 0])
    const it = addItem(ctx, { name: 'bus_mli', role: 'bus', part: busPart, mat: spec.bus.mli, mb: mm })
    shellComp(ctx, 'bus_mli', it, dens.mliAreal)
  }
  if (spec.detail.radiators) {
    for (const s of [1, -1]) {
      const side = s > 0 ? '+Y' : '-Y', rm = new MB(), fx = h[0] * D.radiatorFrac, fz = h[2] * D.radiatorFrac
      if (s > 0) quad(rm, [0, h[1] + 0.004, 0], [0, 0, fz], [fx, 0, 0]); else quad(rm, [0, -h[1] - 0.004, 0], [fx, 0, 0], [0, 0, fz])
      const it = addItem(ctx, { name: `radiator_${side}`, role: 'radiator', part: { id: `radiator_${side}`, name: `散热面 ${side}`, role: 'radiator' }, mat: 'radiator', mb: rm })
      const sp = shellComp(ctx, `radiator_${side}`, it, dens.radiatorAreal)
      ctx.parts.get(`radiator_${side}`).normalBody = [0, s, 0]
      ctx.parts.get(`radiator_${side}`).areaM2 = sp.area
    }
  }
  // 星箭对接环：背地面（−Z）中心；环径不超过平台短边的 90 %
  if (spec.detail.adapter) busAdapter(ctx, busPart, h, Math.min(D.adapterDM / 2, 0.45 * Math.min(spec.bus.xM, spec.bus.yM)), D.adapterHM)
  return h
}

/**
 * 星箭对接环（卫星侧，hardware.lvRing：圆柱段 + 下缘 V 形包带法兰）：背地面中心向 −Z 伸出 hh。只画不计质量（并进平台体）。
 * 整星与装配件平台体组件共用。
 */
export function busAdapter(ctx, part, h, rOut, hh) {
  const am = new MB()
  lvRing(() => am, { c: [0, 0, -h[2]], dir: [0, 0, -1], up: [1, 0, 0], D: 2 * rOut, H: hh, seg: 64 })
  addItem(ctx, { name: 'bus_adapter', role: 'bus', part, mat: 'aluminum', mb: am })
}

/**
 * GEO 姿轨控推力器（10 N）布局（整星与装配件 satSpecToComps 共用）：背地面四角斜出 4 处 + 东西面近背地端 4 处。
 * d = 喷流方向；up = 一处两只（A/B 主备）喷管排开的方向；face = 装在哪个面。
 * @returns {{p:number[], d:number[], up:number[], face:string}[]}
 */
export function rcsLayout(h) {
  const inset = Math.min(0.15, 0.2 * Math.min(h[0], h[1]))
  const list = []
  for (const sx of [1, -1]) for (const sy of [1, -1]) list.push({ p: [sx * (h[0] - inset), sy * (h[1] - inset), -h[2]], d: nrm([sx * 0.35, sy * 0.35, -1]), up: [sx, -sy, 0], face: '-Z' })
  for (const sx of [1, -1]) for (const sy of [1, -1]) list.push({ p: [sx * h[0], sy * (h[1] - inset), -h[2] + inset], d: [sx, 0, 0], up: [0, 0, 1], face: sx > 0 ? '+X' : '-X' })
  return list
}

/**
 * 推力器（调研 components.md §7）：远地点发动机（背地面中心；hardware.bellNozzle 'lae'：铂铑燃烧室 + 深色延伸段钟形喷管、出口唇环，
 * 燃烧室与阀头缩在星体里，露出的是喷管）+ 8 处 10 N 姿轨控（rcsLayout；每处一只 MLI 小支架上并排两只钟形喷管，hardware.rcsPod）。
 * 质量点照旧（远地点发动机 laeMass 在出口前 0.4 laeLenM、每处一只 rcsMass 在 0.4 rcsLenM）——造型细部不改质量模型。
 */
function buildGeoThrusters(ctx, h) {
  const { D, dens } = ctx
  addHw(ctx, 'thruster_lae', { id: 'thruster_lae', name: '远地点发动机', role: 'thruster' }, 'thruster', 'dark_metal',
    (put) => bellNozzle(put, { exit: [0, 0, -h[2] - D.laeLenM], dir: [0, 0, -1], up: [1, 0, 0], kind: 'lae', De: D.laeExitDM }))
  pointComp(ctx, 'thruster_lae', dens.laeMass, [0, 0, -h[2] - D.laeLenM * 0.4])
  const list = rcsLayout(h)
  addHw(ctx, 'thruster_rcs', { id: 'thruster_rcs', name: '姿轨控推力器', role: 'thruster' }, 'thruster', 'mli_gold',
    (put) => { for (const q of list) rcsPod(put, { base: q.p, dir: q.d, up: q.up, scale: D.rcsExitDM / 0.05 }) })
  list.forEach((q, i) => pointComp(ctx, `thruster_rcs_${i + 1}`, dens.rcsMass, madd(q.p, q.d, D.rcsLenM * 0.4)))
}

/** 对地板小喇叭 / 地球敏感器的首选位置（平台半边长的比例）：前三处喇叭、第四处地球敏感器（整星与装配件共用；实际落点见 deckSpots）。 */
export const DECK_SPOTS = Object.freeze([[0.76, 0.6], [-0.76, -0.6], [0.76, -0.6], [-0.76, 0.6]])
const DECK_SCALES = [1, 0.85, 1.15, 0.7, 1.3, 0.55, 0.4, 0.25]
/** 点 p 到线段 ab 在对地板（xy）上投影的距离 */
const segDistXY = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
  const t = l2 > 1e-18 ? clampN(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2, 0, 1) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/**
 * 对地板上方的遮挡件（deckSpots 用；整星与装配件共用）：馈源本体（馈电链尾 back → 口面的外包胶囊：喇叭 1.23 a/2、平面阵半边长）
 * + 支架杆；塔馈另加口面投影圆（对地板喇叭朝 +Z，头顶不能被反射面盖住）。
 * @returns {{a:number[], b:number[], r:number}[]}
 */
export function deckKeepOfFeed(r, L, back, towerTop) {
  const at = L.feedAt || L.F
  const out = [{ a: back, b: at, r: r.feedType === 'array' ? feedArraySize(r, L.D, L.k) / 2 : 1.23 * feedHornGeom(r, L).ap / 2 }]
  if (towerTop || L.h) { const rr = feedSupportR(L); for (const [p0, p1] of feedSupportRods(back, L, towerTop)) out.push({ a: p0, b: p1, r: rr }) }
  if (L.mount === 'deck') out.push({ a: L.Pc, b: L.Pc, r: L.D / 2 })
  return out
}

/** 天线塔（towerH 为 null = 没塔）与对地板测控天线（sensors 关时没有）的遮挡（deckSpots 用；整星与装配件共用）。 */
export function deckKeepOfDeck(h, D, tw, towerH, ttcKind, sensors) {
  const out = []
  if (towerH !== null) out.push({ a: [0, 0, h[2]], b: [0, 0, h[2] + towerH], r: tw * Math.SQRT1_2 })
  if (sensors) {
    const SL = geoSensorLayout(h, D, ttcKind)
    for (const q of SL.ttc) if (q.face === '+Z') out.push({ a: q.base, b: madd(q.base, q.dir, q.mastLen + 0.06 * SL.ks), r: 0.07 * SL.ks })
  }
  return out
}

/**
 * 对地板小喇叭 / 地球敏感器的落点（整星与装配件共用）。首选 DECK_SPOTS；遮挡件（keep，端点都不高于对地板的不算）投影到对地板后
 * 与本件外包圆（喇叭 1.23 a/2、地球敏感器 0.12 m×ks）留 0.03 m×k 净空，件与件之间同样留净空。首选点被占就在 x / y 各按
 * DECK_SCALES 缩放出的候选里取离首选点最近的空位，全被占回首选点（穿插检查会报出来）。
 * 东西各挂两副反射面（E3000 / SSL-1300 类）时下层馈源的三脚架正落在对地板角上，喇叭得往里让。
 * @param {number} n 喇叭数（> 3 只放 3 个；≥ 1 时另放地球敏感器）
 * @returns {(number[]|null)[]} 4 个 [x, y]（没放的为 null）
 */
export function deckSpots(h, D, keep, n) {
  const k = D.reflDetailScale, ks = D.hornApM / 0.12, gap = 0.03 * k
  const rad = (i) => (i < 3 ? 1.23 * D.hornApM / 2 : 0.12 * ks)
  const obs = keep.filter((o) => Math.max(o.a[2], o.b[2]) > h[2] + 1e-9)
  const out = [null, null, null, null]
  for (const i of [0, 1, 2, 3]) {
    if (i < 3 ? i >= n : n < 1) continue
    const r = rad(i), xm = h[0] - r - 0.02 * k, ym = h[1] - r - 0.02 * k
    const p0 = [DECK_SPOTS[i][0] * h[0], DECK_SPOTS[i][1] * h[1]]
    const ok = (p) => obs.every((o) => segDistXY(p, o.a, o.b) > o.r + r + gap) &&
      out.every((q, j) => q === null || Math.hypot(p[0] - q[0], p[1] - q[1]) > rad(j) + r + gap)
    let best = null, bd = Infinity
    for (const sx of DECK_SCALES) for (const sy of DECK_SCALES) {
      const p = [clampN(sx * p0[0], -xm, xm), clampN(sy * p0[1], -ym, ym)]
      const d = Math.hypot(p[0] - p0[0], p[1] - p0[1])
      if (d < bd - 1e-12 && ok(p)) { best = p; bd = d }
    }
    out[i] = best || p0
  }
  return out
}

/**
 * 馈源喇叭的质量元：外包锥面（口部外半径 1.23 a、长 L、24 段）× 喇叭面密度——造型细部（台阶 / 波纹 / 馈电链）不改质量模型。
 * 整星（侧挂馈源 / 对地板喇叭 / 显式附加喇叭）与装配件 sat.feed.horn 同一式子，转为装配后质量逐项对得上。
 */
export function hornShellMass(ctx, name, ap, dir, D, L) {
  const env = new MB()
  horn(env, ap, dir, 1.23 * D / 2, L, 24)
  const sp = shellProps(worldPositions(env, IDR, [0, 0, 0]), env.idx, ctx.dens.hornAreal)
  comp(ctx, name, 'shell', sp.massKg, sp.com, sp.I)
  return sp
}

/**
 * 对地板（+Z）小喇叭（信标 / 测控；台阶锥本色铝喇叭）与地球敏感器（IRES 类金色盒 + 顶窗，只画不计质量）。
 * 落点由 deckSpots 避开天线塔、反射面、馈源与支架、测控天线——所以排在反射面之后建。
 */
function buildDeckHorns(ctx, h, n) {
  const { D, spec } = ctx
  const spots = deckSpots(h, D, ctx.deckKeep.concat(deckKeepOfDeck(h, D, ctx.towerW, ctx.towerBuilt ? ctx.towerH : null, spec.detail.ttc, spec.detail.sensors !== false)), n)
  for (let i = 0; i < Math.min(n, 3); i++) {
    const [x, y] = spots[i], ap = [x, y, h[2] + D.hornLenM]
    const id = `deck_horn_${i + 1}`
    addHw(ctx, id, { id, name: `对地板喇叭 ${i + 1}`, role: 'feed' }, 'feed', 'aluminum',
      (put) => feedHorn(put, { ap, dir: [0, 0, 1], up: [1, 0, 0], D: D.hornApM, L: D.hornLenM, style: 'terraced', mat: { body: 'aluminum', rim: 'gold_metal', inner: 'black_paint' }, seg: 20 }))
    const sp = hornShellMass(ctx, id, ap, [0, 0, 1], D.hornApM, D.hornLenM)
    ctx.parts.get(id).areaM2 = sp.area
    ctx.parts.get(id).normalBody = [0, 0, 1]
  }
  if (n >= 1) {
    const [x, y] = spots[3]
    addHw(ctx, 'earth_sensor', { id: 'earth_sensor', name: '地球敏感器', role: 'sensor' }, 'sensor', 'gold_metal',
      (put) => earthSensor(put, { base: [x, y, h[2]], dir: [0, 0, 1], up: [1, 0, 0], type: 'ires', scale: D.hornApM / 0.12 }))
  }
}

/**
 * GEO 平台敏感器 / 测控天线布局（整星与装配件共用；调研 components.md §4–§5，位置是工程示意）：
 *   星敏两头：北板（−Y）对地端的楔形座上，视轴离 −Y 35°、方位 −45° / −135°（偏东 / 偏西并朝背地），两头相隔 48°——
 *            躲开太阳（赤道面 ±23.4° + 26° 排除角）、地球（18.5° 排除角）与南北翼；
 *   测控：对地板一角的桅杆顶（朝 +Z）+ 背地面对角（朝 −Z，躲开远地点发动机、对接环与姿控支架）。
 *         kind 'wca'（欧洲平台：两只宽波束「管」喇叭）/ 'bicone'（北美平台：对地板桅杆上是双锥全向天线）。
 * 尺寸随 ks（= 对地板喇叭口径 / 0.12：GEO 档 1、小平台 0.5）。
 * @returns {{stars:{base, n, dir, cantDeg, rollDeg, uv}[], ttc:{kind, base, dir, mastLen, face, uv}[], ks:number}}
 */
export function geoSensorLayout(h, D, ttcKind) {
  const ks = D.hornApM / 0.12
  const a = 35 * Math.PI / 180, stars = []
  for (const az of [-45, -135]) {
    const t = az * Math.PI / 180
    const dir = [Math.sin(a) * Math.cos(t), -Math.cos(a), Math.sin(a) * Math.sin(t)]
    const x = Math.sign(Math.cos(t)) * 0.22 * ks, z = h[2] - 0.3 * ks
    // −Y 面的面系：u = +Z、v = n × u = −X；倾斜方位角（自 u 量起）= atan2(视轴在 v 上的分量, 在 u 上的分量)
    const rollDeg = Math.atan2(-dir[0], dir[2]) * 180 / Math.PI
    // 斜装方向（视轴在安装面内的投影）：楔形座的方块边与光学头的接插件都朝它（装配件星敏组件局部 +X 经滚转后就是它）
    const tilt = nrm([dir[0], 0, dir[2]])
    stars.push({ base: [x, -h[1], z], n: [0, -1, 0], dir, tilt, cantDeg: 35, rollDeg, uv: [z, -x] })
  }
  const kind = ttcKind === 'bicone' ? 'bicone' : 'wca'
  const ttc = [
    { kind, base: [-0.85 * h[0], -0.85 * h[1], h[2]], dir: [0, 0, 1], mastLen: 0.45 * ks, face: '+Z', uv: [-0.85 * h[0], -0.85 * h[1]] },
    // −Z 面系：u = +X、v = n × u = −Y
    { kind: 'wca', base: [0.55 * h[0], 0.75 * h[1], -h[2]], dir: [0, 0, -1], mastLen: 0.1 * ks, face: '-Z', uv: [0.55 * h[0], -0.75 * h[1]] }
  ]
  return { stars, ttc, ks }
}

/** 星敏感器（两头，hardware.starTrackerHead 'hydra' 在楔形座上）+ 测控天线（WCA / 双锥 + 桅杆）。只画不计质量（敏感器 / 天线组件同口径）。 */
function buildGeoSensors(ctx, h) {
  const { spec, D } = ctx
  const L = geoSensorLayout(h, D, spec.detail.ttc)
  L.stars.forEach((s, i) => {
    const id = `star_tracker_${i + 1}`
    addHw(ctx, id, { id, name: `星敏感器 ${i + 1}`, role: 'sensor' }, 'sensor', 'aluminum', (put) => {
      const w = wedgeMount(put, { base: s.base, n: s.n, top: s.dir, size: 1.33 * 0.135 * L.ks, up: s.tilt })
      starTrackerHead(put, { base: w.top, dir: s.dir, up: s.tilt, type: 'hydra', scale: L.ks, seg: 32 })
    })
  })
  L.ttc.forEach((q, i) => {
    const id = `ttc_antenna_${i + 1}`
    addHw(ctx, id, { id, name: `测控天线 ${i + 1}`, role: 'feed' }, 'feed', 'aluminum', (put) => ttcAntenna(put, { base: q.base, dir: q.dir, up: [1, 0, 0], kind: q.kind, mastLen: q.mastLen, scale: L.ks }))
  })
}

/**
 * 测控天线（整星与装配件 sat.antenna.ttc 共用）：桅杆（白漆细管 + 脚法兰）顶上一只宽波束「管」喇叭（WCA）或双锥全向天线（带琥珀色圆极化套筒）。
 * o = { base（安装面中心）, dir（朝外）, up?, kind:'wca'|'bicone', band?:'Ku'|'C', mastLen, scale?, polarizer? }
 * @returns {{top:number[]}}
 */
export function ttcAntenna(put, o) {
  const k = isNum(o.scale) ? o.scale : 1, d = nrm(o.dir)
  if (o.kind === 'bicone') return ttcBicone(put, { base: o.base, dir: d, up: o.up, band: o.band, mastLen: o.mastLen, polarizer: o.polarizer, mastR: 0.018 * k, scale: k })
  const mastR = 0.018 * k
  let top = o.base
  if (o.mastLen > 0.002) {
    cylP(put('white_paint'), o.base, madd(o.base, d, o.mastLen), mastR)
    cylP(put('aluminum'), o.base, madd(o.base, d, 0.006 * k), 2 * mastR)
    top = madd(o.base, d, o.mastLen)
  }
  wcaHorn(put, { base: top, dir: d, up: o.up, band: o.band, scale: k })
  return { top: madd(top, d, 0.06 * k * (o.band === 'C' ? 2.5 : 1)) }
}
const cylP = (mb, p0, p1, r) => frustum(mb, p0, r, p1, r, 16, false, true, false)

/**
 * 电推力器造型（整星 LEO 平板与装配件 sat.thruster 'ep' 共用）：霍尔推力器（hardware.hallThruster，放电通道直径 Dch）出口面在安装点沿
 * 喷流 L 处（不足本体深 1.2 Dch 时取本体深）；本体背面到安装面之间补一段方形支座。
 */
export function epThruster(put, base, dir, up, Dch, L) {
  const d = nrm(dir), Lb = 1.2 * Dch, zE = Math.max(L, Lb)
  return hallThruster(put, { exit: madd(base, d, zE), dir: d, up, Dch, standoff: zE - Lb })
}

/**
 * 太阳翼（GEO / LEO / 立方星展开板共用）。
 * 局部系（本体系下的列向量）：y_l = 翼展向外（side·Y）、z_l = −Z_body（电池面朝天顶）、x_l = y_l × z_l；
 * 再绕 y_l 转 tiltDeg。原点 = 铰点（缺省南北面中心）。板面中面过转轴（基板 z_l∈[−t/2, t/2]）。
 * 组件复用：ctx = meshKit.createCtx({dens})，w 给 hingeBody（如 [0,0,0]）就不读 ctx.spec；节点 / 挂点名固定为 wing_±Y_*，
 * 两副翼要各开一个 ctx（合并时加组件 id 前缀）。
 * opt = {sadaLenM, sadaDM, yokeRodDM, panelTM, cellMarginM, articulate, sadaPart?, sadaMassKg?,
 *        yokeStyle?, columns?, cellMat?, bothFaces?, frame?, hinges?, concentrator?}（后七项是装配组件 sat.wing 的可选外形，2026-10-08
 *        「太阳翼种类补全」；整星不传 → 与旧版逐字节相同）：
 *   sadaPart   SADA 节点归哪个部件。缺省：整星（ctx.spec 在）并进平台体 {id:'bus'}——SADA 质量由平台质量兜着；
 *              组件（无 ctx.spec）单独成件 {id:'wing_±Y_sada', name:'太阳翼驱动机构 ±Y', role:'bus'}，不凭空冒出 id='bus' 的假平台件。
 *   sadaMassKg SADA 质量（kg）：给了正有限数才登记一个实心圆柱质量元（名 wing_±Y_sada）；整星不传（平台质量已含）。
 *              出厂不给缺省值——没有出处可查的 SADA 质量，组件要记就由装配件参数显式给。
 * @returns {{hinge:number[], tipBody:number[]}}
 */
export function buildWing(ctx, w, opt) {
  const { dens } = ctx
  const s = w.side === '-Y' ? -1 : 1
  const wname = `wing_${w.side}`
  const R0 = [[-s, 0, 0], [0, s, 0], [0, 0, -1]]
  const R = rotAboutLocalY(R0, w.tiltDeg)
  if (!isVec3(w.hingeBody) && !ctx.spec) throw new Error(`paramBus：太阳翼 ${w.side} 未给 hingeBody、ctx 也没有 spec（组件用法须给铰点）`)
  const hinge = isVec3(w.hingeBody) ? w.hingeBody.slice() : [0, s * ctx.spec.bus.yM / 2, 0]
  const t = opt.panelTM, m = opt.cellMarginM, W = w.panelWM, H = w.panelHM
  const artNodes = [], cellNodes = [], wingPart = { id: wname, name: `太阳翼 ${w.side}`, role: 'solarArray' }
  const toW = (p) => add(hinge, rApply(R, p))
  // SADA：固定在平台上（不随关节转）。驱动机构本体装在南北板里，外面只露输出端 + 翼根支座、裹一只 MLI 护套（hardware.sadaBoot，
  // 调研 components.md §8.1）：总长 = sadaLenM、护套底径 = sadaDM
  if (opt.sadaLenM > 0) {
    const sadaPart = opt.sadaPart || (ctx.spec ? { id: 'bus' } : { id: `${wname}_sada`, name: `太阳翼驱动机构 ${w.side}`, role: 'bus' })
    addHw(ctx, `${wname}_sada`, sadaPart, 'bus', 'aluminum', (put) => sadaBoot(put, { root: hinge, dir: [0, s, 0], up: [1, 0, 0], kz: opt.sadaLenM / 0.25, kr: opt.sadaDM / 0.26 }))
    if (isNum(opt.sadaMassKg) && opt.sadaMassKg > 0) {
      // 实心圆柱（沿局部 y，长 = 画出的 −0.01 … sadaLenM）：轴向 m r²/2、横向 m(3r² + L²)/12
      const mS = opt.sadaMassKg, rS = opt.sadaDM / 2, lS = opt.sadaLenM + 0.01, iT = mS * (3 * rS * rS + lS * lS) / 12
      comp(ctx, `${wname}_sada`, 'cylinder', mS, add(hinge, rApply(R0, [0, (opt.sadaLenM - 0.01) / 2, 0])), rotInertia(R0, iT, mS * rS * rS / 2, iT))
    }
  }
  const y0 = opt.sadaLenM + w.yokeLenM
  // 轭：长的画 V 形双杆 + 横梁；短的（< 0.3 m）画单根短杆。opt.yokeStyle 可指定 'v' / 'trap'（梯形框 + 交叉斜撑，北斗二号 / 东三平台）/ 'rod' /
  // 'scissor'（剪叉式展开架：交叉杆逐节伸出，星链 V2 Mini 翼根）
  if (w.yokeLenM > 0.01) {
    const ym = new MB(), r = opt.yokeRodDM / 2
    const root = [0, opt.sadaLenM, 0]
    const style = opt.yokeStyle && opt.yokeStyle !== 'auto' ? opt.yokeStyle : (w.yokeLenM >= 0.3 ? 'v' : 'rod')
    const ya = opt.sadaLenM, yb = y0 - r, ta = 0.22 * W, tb = 0.42 * W
    const rods = style === 'v'
      ? [[root, [0.4 * W, y0 - r, 0]], [root, [-0.4 * W, y0 - r, 0]], [[-0.4 * W, y0 - r, 0], [0.4 * W, y0 - r, 0]]]
      : style === 'trap'
        ? [[[-ta, ya, 0], [-tb, yb, 0]], [[ta, ya, 0], [tb, yb, 0]], [[-tb, yb, 0], [tb, yb, 0]], [[-ta, ya, 0], [ta, ya, 0]], [[-ta, ya, 0], [tb, yb, 0]], [[ta, ya, 0], [-tb, yb, 0]]]
        : style === 'scissor' ? scissorRods(ya, yb, 0.25 * W, Math.max(2, Math.round((yb - ya) / (0.5 * W))))
          : [[root, [0, y0, 0]]]
    rods.forEach(([a, b], i) => { tube(ym, a, b, r, 10); rodComp(ctx, `${wname}_yoke_${i + 1}`, toW(a), toW(b)) })
    addItem(ctx, { name: `${wname}_yoke`, role: 'boom', part: { id: `${wname}_yoke`, name: `太阳翼轭 ${w.side}`, role: 'boom' }, mat: 'carbon', mb: ym, R, t: hinge })
    artNodes.push(`${wname}_yoke`)
  }
  let cellArea = 0
  // 可选外形（装配组件）：多列 / 硅电池汇流条 / 双面电池 / 板框 / 板间铰链 / 聚光板；装饰件各并成一个随翼转的节点
  const cols = Number.isInteger(opt.columns) && opt.columns > 1 ? opt.columns : 1
  const cellMat = opt.cellMat || 'solar_cell'
  const deco = { lines: cellMat === 'cell_si' ? new MB() : null, frame: opt.frame ? new MB() : null, hinges: opt.hinges ? new MB() : null, conc: opt.concentrator ? new MB() : null }
  const FI = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
  const panelAt = (tag, cx, yStart) => {
    const cy = yStart + H / 2
    const sw = cols > 1 ? (W - (cols - 1) * w.gapM) / cols : W
    for (let j = 0; j < cols; j++) {
      const x = cols > 1 ? cx - W / 2 + sw / 2 + j * (sw + w.gapM) : cx
      const tg = cols > 1 ? `${tag}c${j + 1}` : tag
      const sm = new MB(); box(sm, [x, cy, 0], [sw / 2, H / 2, t / 2])
      const sub_ = addItem(ctx, { name: `${wname}_${tg}_substrate`, role: 'solarArray', part: wingPart, mat: 'solar_substrate', mb: sm, R, t: hinge })
      plateComp(ctx, sub_.name, dens.panelAreal * sw * H, toW([x, cy, 0]), R, sw, H)
      const cm = new MB(), cw = Math.max(0.001, sw / 2 - m), ch = Math.max(0.001, H / 2 - m)
      quad(cm, [x, cy, t / 2 + CELL_LIFT], [cw, 0, 0], [0, ch, 0])
      if (opt.bothFaces) quad(cm, [x, cy, -t / 2 - CELL_LIFT], [0, ch, 0], [cw, 0, 0])
      const cel = addItem(ctx, { name: `${wname}_${tg}_cells`, role: 'solarArray', part: wingPart, mat: cellMat, mb: cm, R, t: hinge })
      const ca = 4 * cw * ch
      plateComp(ctx, cel.name, dens.cellAreal * ca, toW([x, cy, t / 2 + CELL_LIFT]), R, 2 * cw, 2 * ch)
      if (opt.bothFaces) plateComp(ctx, `${cel.name}_back`, dens.cellAreal * ca, toW([x, cy, -t / 2 - CELL_LIFT]), R, 2 * cw, 2 * ch)
      cellArea += ca
      artNodes.push(sub_.name, cel.name); cellNodes.push(cel.name)
      if (deco.lines) {
        siLines(deco.lines, FI, x, cy, cw, ch, t / 2 + CELL_LIFT + 0.0007, [0, 0, 1])
        if (opt.bothFaces) siLines(deco.lines, FI, x, cy, cw, ch, -t / 2 - CELL_LIFT - 0.0007, [0, 0, -1])
      }
      if (deco.frame) {
        const fw = Math.min(0.02, 0.04 * Math.min(sw, H)), fz = t / 2 + 0.002
        box(deco.frame, [x - sw / 2 + fw / 2, cy, 0], [fw / 2, H / 2, fz], ['+x', '-x', '+z', '-z'])
        box(deco.frame, [x + sw / 2 - fw / 2, cy, 0], [fw / 2, H / 2, fz], ['+x', '-x', '+z', '-z'])
        box(deco.frame, [x, cy - H / 2 + fw / 2, 0], [sw / 2, fw / 2, fz], ['+y', '-y', '+z', '-z'])
        box(deco.frame, [x, cy + H / 2 - fw / 2, 0], [sw / 2, fw / 2, fz], ['+y', '-y', '+z', '-z'])
      }
    }
    if (deco.conc) {
      // 聚光板：两条长边（沿翼展）各一条，自板边向电池面一侧外倾 60°（板宽 0.45 W），双面
      const wr = 0.45 * W, cA = Math.cos(60 * Math.PI / 180), sA = Math.sin(60 * Math.PI / 180)
      for (const s of [1, -1]) {
        const xe = cx + s * W / 2, x2 = xe + s * wr * cA, z2 = t / 2 + wr * sA
        const a = [xe, cy - H / 2, t / 2], b2 = [xe, cy + H / 2, t / 2], c = [x2, cy + H / 2, z2], d = [x2, cy - H / 2, z2]
        const n = nrm(cross(sub(b2, a), sub(d, a)))
        quadPts(deco.conc, a, b2, c, d, n); quadPts(deco.conc, a, d, c, b2, scl(n, -1))
        plateComp(ctx, `${wname}_${tag}_conc${s > 0 ? 'a' : 'b'}`, dens.mliAreal * wr * H, toW([(xe + x2) / 2, cy, (t / 2 + z2) / 2]), R, wr, H)
      }
    }
  }
  for (let k = 0; k < w.panels; k++) panelAt(String(k + 1), 0, y0 + k * (H + w.gapM))
  if (w.sidePanels === 2) {
    // 侧板挂在第 at 块两侧（缺省倒数第二块 → 十字形；见 defaultSidePanelAt）
    const at = Number.isInteger(w.sidePanelAt) ? Math.min(w.panels, Math.max(1, w.sidePanelAt)) : defaultSidePanelAt(w.panels)
    const yl = y0 + (at - 1) * (H + w.gapM)
    panelAt(`${at}a`, W + w.gapM, yl); panelAt(`${at}b`, -(W + w.gapM), yl)
    if (deco.hinges) for (const s of [1, -1]) for (const f of [-0.38, 0.38]) tube(deco.hinges, [s * (W / 2 + w.gapM / 2), yl + H / 2 + f * H - 0.04 * H, 0], [s * (W / 2 + w.gapM / 2), yl + H / 2 + f * H + 0.04 * H, 0], Math.max(0.008, 0.6 * t), 10)
  }
  if (deco.hinges) {
    // 板间铰链：相邻两块之间（主列），两端各一只
    for (let k = 1; k < w.panels; k++) {
      const yj = y0 + k * (H + w.gapM) - w.gapM / 2
      for (const s of [1, -1]) tube(deco.hinges, [s * 0.38 * W - 0.04 * W, yj, 0], [s * 0.38 * W + 0.04 * W, yj, 0], Math.max(0.008, 0.6 * t), 10)
    }
  }
  for (const [k, mat] of [['lines', 'white_paint'], ['frame', 'carbon'], ['hinges', 'titanium'], ['conc', 'aluminum']]) {
    if (!deco[k] || !deco[k].tcount) continue
    const nm = `${wname}_${k === 'conc' ? 'concentrators' : k}`
    addItem(ctx, { name: nm, role: 'solarArray', part: wingPart, mat, mb: deco[k], R, t: hinge })
    artNodes.push(nm)
  }
  const p = ctx.parts.get(wname)
  p.areaM2 = cellArea; p.normalBody = nrm(R[2])
  if (opt.articulate) {
    // pointingVector = 节点局部 +Z（电池面法向）：导到 STK 后太阳翼可直接单轴对日（审查 P1-8；节点局部系即翼局部系）
    ctx.arts.push({ name: wname, nodes: artNodes, stages: [{ name: 'rotate', type: 'yRotate', minimumValue: -180, maximumValue: 180, initialValue: 0 }], pointingVector: [0, 0, 1] })
  }
  ctx.spg.push({ name: wname, nodes: cellNodes, efficiency: w.efficiency })
  addAp(ctx, `${wname}_axis`, hinge, [0, s, 0])
  const tipY = y0 + w.panels * H + (w.panels - 1) * w.gapM
  return { hinge, tipBody: toW([0, tipY, 0]) }
}

/** 剪叉式展开架的杆（翼局部系 xy 平面，ya → yb、半宽 hw、n 节）：每节两根交叉杆 + 两端横杆 */
function scissorRods(ya, yb, hw, n) {
  const P = (k, s) => [s * hw, ya + ((yb - ya) * k) / n, 0], out = []
  for (let k = 0; k < n; k++) out.push([P(k, -1), P(k + 1, 1)], [P(k, 1), P(k + 1, -1)])
  out.push([P(0, -1), P(0, 1)], [P(n, -1), P(n, 1)])
  return out
}

/** 平面馈源阵边长：给了 feedApertureM 就用，否则按口径 12 % 取、夹在 (0.6–2 m)×k（示意）。 */
const feedArraySize = (r, Dm, k) => (isNum(r.feedApertureM) ? r.feedApertureM : clampN(0.12 * Dm, 0.6 * k, 2.0 * k))

/**
 * 硬件造型件落进生成上下文（hardware.mjs 按材质分桶出网格）：主材质的桶叫 name，其余桶叫 name_<材质键>，都登记在同一部件下。
 * 只登记几何节点、不登记质量元（质量由调用方按包络另记）。build(put) 的返回值原样带回。装配组件（components/sat.mjs）同一口径。
 * @returns {{ret:any, items:object[]}}
 */
export function addHw(ctx, name, part, role, mainMat, build) {
  const buckets = new Map()
  const put = (k) => { if (!Object.hasOwn(MATERIALS, k)) throw new Error(`paramBus：硬件造型件用了未知材质 ${k}（生成器内部错误）`); if (!buckets.has(k)) buckets.set(k, new MB()); return buckets.get(k) }
  put(mainMat)
  const ret = build(put)
  const items = []
  for (const [k, mb] of buckets) if (mb.tcount) items.push(addItem(ctx, { name: k === mainMat ? name : `${name}_${k}`, role, part, mat: k, mb }))
  return { ret, items }
}

/**
 * 馈源喇叭的轴向几何（整星 buildFeed 与装配件 satSpecToComps / 反射面组件焦点插座共用同一式子）。
 * 口径缺省 0.03 × 焦距：馈源要在反射面张角上打出 −12 dB 边缘照射，口径随焦距线性涨（调研 components.md §2.1：f/D 1.6 的 2.4 m Ku
 * 反射面配 ≈ 4.4 λ = 0.11 m 的喇叭；对地板 f/D 0.8 的小反射面只要 2–3 λ），夹在 0.06–0.3 m × k；
 * 喇叭长 2.12 × 口径（窄张角 12° 的波纹锥喇叭，L/D 2.12）；之后接馈电链（圆波导颈 + 极化器 + 正交模变换器方盒，共 ≈ 5.3 λ，λ = 口径 / 2.8）。
 * @returns {{ap:number, hl:number, back:number[]}} back = 馈电链尾中心（支架落脚的起点）
 */
export const feedApDefault = (f, k) => clampN(0.03 * f, 0.06 * k, 0.3 * k)
export function feedHornGeom(r, L) {
  const k = L.k
  const ap = isNum(r.feedApertureM) ? r.feedApertureM : feedApDefault(L.f, k)
  const hl = 2.12 * ap, lam = ap / 2.8
  const dir = nrm(sub(L.Pc, L.F))
  return { ap, hl, dir, back: madd(L.F, dir, -(hl + 0.035 * hl + 5.32 * lam)) }
}

/**
 * 馈源支架（整星与装配件共用）：侧挂馈源 = 三脚架落到对地板（不是一根圆柱——在轨照片里都是支架 / 撑杆框，调研 part_feeds §2(d)）；
 * 塔馈 = 两根撑杆接到塔顶。返回线段表 [[p0, p1], …]（不足 2 cm 的段丢掉）。
 */
export function feedSupportRods(back, L, towerTop) {
  const k = L.k, h = L.h
  const segs = []
  if (towerTop) {
    for (const sx of [1, -1]) segs.push([back, [sx * 0.12 * k, clampN(back[1], -0.2 * k, 0.2 * k), towerTop]])
  } else if (h) {
    const cx = clampN(back[0], -h[0] + 0.05 * k, h[0] - 0.05 * k), cy = clampN(back[1], -h[1] + 0.05 * k, h[1] - 0.05 * k)
    const sx = Math.sign(back[0]) || 1, d = 0.14 * k
    for (const [ox, oy] of [[sx * d, d], [sx * d, -d], [-sx * d, 0]]) {
      segs.push([back, [clampN(cx + ox, -h[0] + 0.03 * k, h[0] - 0.03 * k), clampN(cy + oy, -h[1] + 0.03 * k, h[1] - 0.03 * k), h[2]]])
    }
  }
  // 各杆的上端接在馈电链尾托架（0.1 m×k 见方）朝自己落脚点那一侧的棱上，不共用一个点：几根杆夹角小（长三脚架只差几度）时
  // 共点会在顶端互相吃进去一大截（转为装配后的穿插检测按两杆端帽深度放行，管不到这么长的重叠）
  const out = []
  for (const [a, b] of segs) {
    const hz = [b[0] - a[0], b[1] - a[1], 0], l = len(hz)
    const a1 = l > 1e-9 ? madd(a, hz, 0.05 * k / l) : a
    if (len(sub(b, a1)) > 0.02 * k) out.push([a1, b])
  }
  return out
}
/** 馈源支架杆半径（整星与装配件共用） */
export const feedSupportR = (L) => Math.max(0.008 * L.k, 0.012 * Math.min(1, L.D / 2.5))
const isMeshRefl = (r, D) => r.mesh === true || r.diameterM > D.meshAboveDM
/** 焦距：spec 给了用它，否则按焦径比——网状 / 对地板塔馈实面 / 东西侧挂实面各一档（装配件 satSpecToComps、设计页 effFocalM 同式） */
const focalOf = (r, D) => (isNum(r.focalM) ? r.focalM : (isMeshRefl(r, D) ? D.fdMesh : r.mount === 'deck' ? D.fdSolid : D.fdSide) * r.diameterM)
/** 塔馈反射面缺省偏置：口径中心离母轴 = 半口径 + 0.1 m×k。塔高（buildReflectors）与布局两处都用，必须同一个式子。 */
const deckOffset = (r, D) => (isNum(r.offsetHM) ? r.offsetHM : r.diameterM / 2 + 0.1 * D.reflDetailScale)

/** 天线塔外表面：平台 MLI 同色（无 MLI 时白漆）。装配件 satSpecToComps 同式。 */
export const towerFinish = (spec) => (spec.detail.mli && spec.bus.mli ? spec.bus.mli : 'white_paint')
/** 反射面正面 / 背面外观选项 → 材质键（调研 components.md §1(c)）。 */
const REFL_FRONT = Object.freeze({ white: 'reflector', sunshield: 'sunshield', silver: 'mli_silver' })
const REFL_REAR = Object.freeze({ cfrp: 'carbon', mli_gold: 'mli_gold', mli_black: 'mli_black' })

/**
 * 侧挂实面反射面的两轴展开机构与单臂（整星与装配件共用；调研 components.md §1(d)(e)：Airbus US 11,858,663——支撑框内侧横梁上的
 * 连接点由一根直臂接到侧壁背地端附近的展开机构 ADTM；ESA ADS 项目臂长 1.8 m 量级）。
 * ADTM 装在侧壁上：高度取连接点下方 0.35 m×k（夹在侧壁内）、横向比连接点再往 −e2 偏 0.25 R（与 hardware.adtmBlock 同一套盒 / 鼓尺寸）；
 * 臂径 Ø ≈ 0.07 m（2.45 m 反射面）。L 须带 link（reflectorBacking 的连接点）、h、s、k。
 * @returns {{base:number[], n:number[], out:number[], link:number[], r:number, k:number}}
 */
export function sideArmGeom(L) {
  const h = L.h, k = L.k, R = L.D / 2
  const y = clampN(L.link[1] - 0.25 * R * L.e2[1], -h[1] + 0.15 * k, h[1] - 0.15 * k)
  const z = clampN(L.link[2] - 0.35 * k, -h[2] + 0.2 * k, h[2] - 0.2 * k)
  const base = [L.s * h[0], y, z], n = [L.s, 0, 0]
  // 输出端 = 盒高 0.15k + 鼓 1 中心高 0.048k + 鼓 2 伸出 0.09k（hardware.adtmBlock）
  return { base, n, out: madd(base, n, 0.288 * k), link: L.link.slice(), r: Math.max(0.012 * k, 0.035 * Math.min(1.5, L.D / 2.45)), k }
}

/**
 * 反射面几何解算（全部 double，本体系 spec 原点）。
 * 平台半边长取 ctx.hRefl（各布局族自己给：立方星的「对地板」是结构体顶面，不是导轨端脚）。
 * 附件净空 / 间距按 k = D.reflDetailScale 缩放：GEO 档 k = 1，与缩放前的常数逐位一致。
 * @returns {{F, a, u, e2, V, f, D, dc, Pc, nc, P, N, mount, s, mesh, h, k}}
 */
function reflectorLayout(ctx, r, resolved) {
  const { spec, D } = ctx
  const h = ctx.hRefl, k = D.reflDetailScale
  const a = nrm(r.boresightBody)
  const Dm = r.diameterM
  const mesh = isMeshRefl(r, D)
  const f = focalOf(r, D)
  const side = r.mount === 'side'
  const s = slotSign(r.slot)
  const u0 = r.offsetDirBody != null ? r.offsetDirBody : slotOffsetDir(r.slot)
  // validateSpec 已拒绝近平行；这里再守一道：退化成零向量时整副反射面会悄悄塌成一个点
  if (len(reject(nrm(u0), a)) < OFFSET_PAR_MIN) throw new Error(`paramBus：反射面 ${r.slot} 偏置方向与视轴近平行（生成器内部错误）`)
  const u = nrm(reject(u0, a))
  let F, dc
  if (side) {
    const outer = r.slot.endsWith('2')
    const pair = spec.reflectors.some((q) => q !== r && q.mount === 'side' && !q.posBody && (q.slot === (outer ? r.slot.slice(0, 2) : r.slot + '2')))
    const yF = pair ? (outer ? -h[1] / 2 : h[1] / 2) : 0
    const inner = outer ? resolved.get(r.slot.slice(0, 2)) : null
    dc = isNum(r.offsetHM) ? r.offsetHM
      : (inner ? inner.dc + inner.D / 2 + Dm / 2 + 0.3 * k : Dm / 2 + D.feedInsetM + D.wallGapM)
    // 平面馈源阵（大网状反射面）口面有米级宽、斜对反射面：焦点抬高到阵面下角不插进平台顶面
    const standoff = r.feedType === 'array' ? Math.max(D.feedStandoffM, 0.75 * feedArraySize(r, Dm, k)) : D.feedStandoffM
    F = r.posBody ? r.posBody.slice() : [s * (h[0] - D.feedInsetM), yF, h[2] + standoff]
  } else {
    dc = deckOffset(r, D)
    const tw = spec.tower && isNum(spec.tower.wM) ? spec.tower.wM : D.towerWM
    F = r.posBody ? r.posBody.slice() : [0, s * (tw / 2 + 0.1 * k), h[2] + ctx.towerH]
  }
  // 母抛物面几何（顶点 / 口径面点 / 法向）交给 meshKit.paraLayout；这里只补整星语义（挂法、槽位符号、网状、平台半边长）
  const L = paraLayout(F, a, u, f, Dm, dc, k)
  L.mount = r.mount; L.s = s; L.mesh = mesh; L.h = h
  // 东西侧挂实面：Airbus 式矩形支撑框 + 单臂两轴展开机构（buildReflectorArm）；对地板塔馈只有背架（固定在支撑杆上）
  L.support = side && !mesh ? 'rect' : 'none'
  return L
}

/**
 * 偏置抛物面反射面。正面网格：中心点 + 12 圈 × 48 段（口径面极坐标，米制 uv）。
 *   L 至少带 paraLayout 的全部字段 + mesh（布尔），可带 support（'rect' | 'none'）；读 ctx.D 的 shellM / meshTrussDepthFrac /
 *   meshTrussRodFrac 与 ctx.dens。r 只读外观选项（都可省）：front（'white' 白漆 | 'sunshield' 锗膜遮阳罩深灰 | 'silver' 银色遮阳罩）、
 *   rear（'cfrp' 本色碳纤维 | 'mli_gold' 背面整包金色 MLI）、backing（'ring8' | 'none'）、support（覆盖 L.support）。
 *   实面：正面（朝焦点）+ 背壳（沿法向退 shellM）+ 边缘厚度环 + 背架（SPRINT 八边形环框，金色 MLI）+ 可选支撑框（hardware.reflectorBacking）；
 *     背架 / 支撑框只画不计质量（reflectorAreal 已含背筋）。遮阳罩正面另贴一圈口缘压边带（浅灰 / 金色，调研 components.md §1(c)）。
 *   网状（mesh）：只有一层金属网（reflector_mesh：双面、半透明）+ 周边桁架（AstroMesh 类：前后两环 + 竖杆 + 交替斜杆）。
 *     不画实心背壳——否则从背面看是整块黑碟、从正面看是金网叠黑壳，半透明网白做（09-23 审查）。
 *     桁架质量已按口径面积摊进 meshReflectorAreal，不另计。
 */
export function buildReflector(ctx, r, i, L) {
  const { D, dens } = ctx
  const R = L.D / 2
  const fm = new MB()
  const grid = []
  // 网状径向肋式（伞状）：肋在 nRib 个方位上，肋间网面外缘向里收成扇贝形（越靠口缘收得越多，最深 4 % 半径）
  const radial = L.mesh && r && r.meshStyle === 'radial'
  const nRib = radial ? (L.D < 8 ? 12 : 16) : 0
  const c0 = fm.v(L.P(L.dc, 0), L.N(L.dc, 0), 0, 0)
  for (let k = 1; k <= PARA_NR; k++) {
    const rho = (R * k) / PARA_NR, row = []
    for (let j = 0; j < PARA_NA; j++) {
      const ph = (2 * Math.PI * j) / PARA_NA
      const rr = radial ? rho * (1 - 0.04 * Math.sin(Math.PI * ((j * nRib / PARA_NA) % 1)) * (k / PARA_NR) ** 2) : rho
      const x1 = L.dc + rr * Math.cos(ph), x2 = rr * Math.sin(ph)
      row.push(fm.v(L.P(x1, x2), L.N(x1, x2), rr * Math.cos(ph), rr * Math.sin(ph)))
    }
    grid.push(row)
  }
  for (let j = 0; j < PARA_NA; j++) fm.t(c0, grid[0][j], grid[0][(j + 1) % PARA_NA])
  for (let k = 0; k < PARA_NR - 1; k++) {
    for (let j = 0; j < PARA_NA; j++) {
      const j1 = (j + 1) % PARA_NA, a = grid[k][j], b = grid[k + 1][j], c = grid[k + 1][j1], d = grid[k][j1]
      fm.t(a, b, c); fm.t(a, c, d)
    }
  }
  const id = `reflector_${i + 1}`
  const part = { id, name: `反射面 ${i + 1}`, role: 'reflector' }
  const frontKey = r && r.front, rearKey = r && r.rear
  const front = addItem(ctx, { name: id, role: 'reflector', part, mat: L.mesh ? 'reflector_mesh' : (REFL_FRONT[frontKey] || 'reflector'), mb: fm })
  const outer = grid[PARA_NR - 1]
  const pAt = (vi) => [fm.p[3 * vi], fm.p[3 * vi + 1], fm.p[3 * vi + 2]]
  const nAt = (vi) => [fm.n[3 * vi], fm.n[3 * vi + 1], fm.n[3 * vi + 2]]
  if (radial) {
    // 径向肋（碳纤维，贴在网面背后）+ 口径中心毂：肋沿抛物面自 0.06 R 伸到口缘
    const tm = new MB(), rr = Math.max(0.01 * L.k, 0.0035 * L.D)
    for (let q = 0; q < nRib; q++) {
      const ph = (2 * Math.PI * q) / nRib, c = Math.cos(ph), sn = Math.sin(ph)
      const pts = []
      for (let k = 0; k <= PARA_NR; k++) {
        const rho = R * (0.06 + 0.94 * k / PARA_NR), x1 = L.dc + rho * c, x2 = rho * sn
        pts.push(madd(L.P(x1, x2), L.N(x1, x2), -1.3 * rr))
      }
      for (let k = 0; k < PARA_NR; k++) tube(tm, pts[k], pts[k + 1], rr, 6)
    }
    addItem(ctx, { name: `${id}_truss`, role: 'reflector', part, mat: 'carbon', mb: tm })
    const hm = new MB(), hr = Math.max(0.06 * L.k, 0.05 * L.D)
    tube(hm, madd(L.Pc, L.nc, 0.01 * L.D), madd(L.Pc, L.nc, -0.08 * L.D), hr, 24)
    addItem(ctx, { name: `${id}_hub`, role: 'reflector', part, mat: 'aluminum', mb: hm })
  } else if (L.mesh && r && r.meshStyle === 'modular') {
    // 构架式（模块化可展开桁架）：口径面三角网格（边长 D/8）的前后两层桁杆 + 节点竖杆，网边一道前环
    const tm = new MB(), rr = Math.max(0.006 * L.k, 0.0022 * L.D), dp = D.meshTrussDepthFrac * L.D, sp = L.D / 8
    const R2 = (0.985 * R) ** 2, h3 = Math.sqrt(3) / 2, nI = Math.ceil(R / sp) + 2
    const nodes = new Map()
    for (let j = -nI; j <= nI; j++) {
      for (let q = -nI; q <= nI; q++) {
        const x = (q + j / 2) * sp, y = j * h3 * sp
        if (x * x + y * y > R2) continue
        const P = L.P(L.dc + x, y), N = L.N(L.dc + x, y)
        nodes.set(q + ',' + j, { q, j, f: madd(P, N, -0.5 * rr), b: madd(P, N, -dp) })
      }
    }
    for (const nd of nodes.values()) {
      for (const [dq, dj] of [[1, 0], [0, 1], [-1, 1]]) {
        const m2 = nodes.get((nd.q + dq) + ',' + (nd.j + dj))
        if (!m2) continue
        tube(tm, nd.f, m2.f, rr, 4); tube(tm, nd.b, m2.b, 0.8 * rr, 4)
      }
      tube(tm, nd.f, nd.b, 0.8 * rr, 4)
    }
    for (let j = 0; j < PARA_NA; j++) tube(tm, pAt(outer[j]), pAt(outer[(j + 1) % PARA_NA]), 1.2 * rr, 6)
    addItem(ctx, { name: `${id}_truss`, role: 'reflector', part, mat: 'carbon', mb: tm })
  } else if (L.mesh) {
    // 周边桁架：外圈每隔一个顶点取一个节点（24 格），前环贴网边、后环沿法向退 depth
    const depth = D.meshTrussDepthFrac * L.D, rr = Math.max(0.01 * L.k, D.meshTrussRodFrac * L.D)
    const tm = new MB(), ringF = [], ringB = []
    for (let j = 0; j < PARA_NA; j += 2) { const vi = outer[j]; ringF.push(pAt(vi)); ringB.push(madd(pAt(vi), nAt(vi), -depth)) }
    const nb = ringF.length
    for (let j = 0; j < nb; j++) {
      const j1 = (j + 1) % nb
      tube(tm, ringF[j], ringF[j1], rr, 6); tube(tm, ringB[j], ringB[j1], rr, 6); tube(tm, ringF[j], ringB[j], rr, 6)
      if (j % 2 === 0) tube(tm, ringF[j], ringB[j1], rr, 6); else tube(tm, ringB[j], ringF[j1], rr, 6)
    }
    addItem(ctx, { name: `${id}_truss`, role: 'reflector', part, mat: 'carbon', mb: tm })
  } else {
    const sh = D.shellM, bm = new MB(), rm = new MB()
    // 背壳：同网格沿 −法向退 sh，法向取反、绕序反
    for (let vi = 0; vi < fm.vcount; vi++) {
      const p = pAt(vi), n = nAt(vi)
      bm.v(madd(p, n, -sh), scl(n, -1), fm.uv[2 * vi], fm.uv[2 * vi + 1])
    }
    for (let t = 0; t < fm.idx.length; t += 3) bm.t(fm.idx[t], fm.idx[t + 2], fm.idx[t + 1])
    // 边缘厚度环：正面外圈 ↔ 背面外圈，法向取口径面内的径向
    for (let j = 0; j <= PARA_NA; j++) {
      const jj = j % PARA_NA, ph = (2 * Math.PI * jj) / PARA_NA
      const rad = nrm(add(scl(L.u, Math.cos(ph)), scl(L.e2, Math.sin(ph))))
      const vi = outer[jj], p = pAt(vi), n = nAt(vi)
      const s0 = (2 * Math.PI * R * j) / PARA_NA
      rm.v(p, rad, s0, 0); rm.v(madd(p, n, -sh), rad, s0, sh)
    }
    for (let j = 0; j < PARA_NA; j++) { const f0 = 2 * j, b0 = f0 + 1, f1 = f0 + 2, b1 = f0 + 3; rm.t(f0, b0, f1); rm.t(f1, b0, b1) }
    const rearMat = REFL_REAR[rearKey] || 'carbon'
    addItem(ctx, { name: `${id}_back`, role: 'reflector', part, mat: rearMat, mb: bm })
    addItem(ctx, { name: `${id}_rim`, role: 'reflector', part, mat: rearMat, mb: rm })
    // 遮阳罩口缘压边带：正面最外 0.015 m×k 一圈（沿法向抬 1 mm 防闪烁）
    if (frontKey === 'sunshield' || frontKey === 'silver') {
      const tm = new MB(), w = Math.min(0.015 * L.k, 0.1 * R), rIn = R - w
      for (let j = 0; j <= PARA_NA; j++) {
        const ph = (2 * Math.PI * (j % PARA_NA)) / PARA_NA, c = Math.cos(ph), sn = Math.sin(ph)
        const x1o = L.dc + R * c, x2o = R * sn, x1i = L.dc + rIn * c, x2i = rIn * sn
        const no = L.N(x1o, x2o), ni = L.N(x1i, x2i)
        tm.v(madd(L.P(x1o, x2o), no, 0.001), no, R * c, R * sn); tm.v(madd(L.P(x1i, x2i), ni, 0.001), ni, rIn * c, rIn * sn)
      }
      for (let j = 0; j < PARA_NA; j++) { const o0 = 2 * j, i0 = o0 + 1, o1 = o0 + 2, i1 = o0 + 3; tm.t(o0, o1, i0); tm.t(i0, o1, i1) }
      addItem(ctx, { name: `${id}_tape`, role: 'reflector', part, mat: frontKey === 'silver' ? 'gold_metal' : 'white_paint', mb: tm })
    }
    // 背架 + 支撑框（连接点记进 L.link，供展开臂接）
    const bk = (r && r.backing) || 'ring8', sup = (r && r.support) || L.support || 'none'
    if (bk !== 'none' || sup !== 'none') L.link = addHw(ctx, `${id}_frame`, part, 'reflector', 'mli_gold', (put) => reflectorBacking(put, L, { sh, backing: bk, support: sup })).ret.link
  }
  const sp = shellComp(ctx, id, front, L.mesh ? dens.meshReflectorAreal : dens.reflectorAreal)
  const p = ctx.parts.get(id)
  p.areaM2 = sp.area; p.normalBody = L.a.slice()
  p.fitted = { kind: 'paraboloid', focalM: L.f, diameterM: L.D, vertexBody: L.V.slice(), axisBody: L.a.slice(), focusBody: L.F.slice(), offsetM: L.dc }
  addAp(ctx, `${id}_focus`, L.F, L.a)
  return sp
}

/**
 * 馈源：喇叭（截锥，口面中心在焦点、朝反射面口径中心）或平面馈源阵（大网状反射面）+ 支架。
 * 读 r.feedType / r.feedApertureM；支架落脚要 L.h（平台半边长）或 towerTop（塔顶高度），两者都没有就不画支架。
 */
export function buildFeed(ctx, r, i, L, towerTop) {
  const { dens } = ctx
  const k = L.k
  const dir = nrm(sub(L.Pc, L.F))
  const id = `feed_${i + 1}`, part = { id, name: `馈源 ${i + 1}`, role: 'feed' }
  const fm = new MB()
  let back
  if (r.feedType === 'array') {
    const a = feedArraySize(r, L.D, k)
    const [e1, e2] = perpPair(dir), th = 0.08 * k
    const c = madd(L.F, dir, -th / 2)
    // 平面阵：一个沿 dir 的薄盒（手写六面，局部轴 e1 / e2 / dir）
    const hx = scl(e1, a / 2), hy = scl(e2, a / 2), hz = scl(dir, th / 2)
    quad(fm, add(c, hz), hx, hy); quad(fm, sub(c, hz), hy, hx)
    quad(fm, add(c, hx), hy, hz); quad(fm, sub(c, hx), hz, hy)
    quad(fm, add(c, hy), hz, hx); quad(fm, sub(c, hy), hx, hz)
    back = madd(L.F, dir, -th)
    const it = addItem(ctx, { name: id, role: 'feed', part, mat: 'white_paint', mb: fm })
    shellComp(ctx, id, it, dens.hornAreal)
  } else {
    // 波纹锥喇叭（在轨外观：金色 MLI 外壳 + 金属口环 + 锗膜遮阳盖）+ 馈电链（极化器 + 正交模变换器方盒 + 波导端口）。
    // L.feedAt / L.feedDir：格里高利双反射面的馈源在第二焦点、朝副面（装配件反射面组件的副反射面选项给；整星不给）
    const g = feedHornGeom(r, L)
    const at = L.feedAt || L.F, fdir = L.feedDir ? nrm(L.feedDir) : dir
    addHw(ctx, id, part, 'feed', 'mli_gold', (put) => {
      const hh = feedHorn(put, { ap: at, dir: fdir, D: g.ap, L: g.hl, style: 'smooth', mat: { body: 'mli_gold', rim: 'gold_metal', inner: 'black_paint' }, cap: 'ge', seg: 28 })
      feedChain(put, { throat: hh.throat, dir: fdir, D: g.ap, mat: { body: 'mli_gold', flange: 'aluminum' }, seg: 16 })
    })
    back = L.feedAt ? madd(at, fdir, -(g.hl * 1.035 + 5.32 * g.ap / 2.8)) : g.back
    hornShellMass(ctx, id, at, fdir, g.ap, g.hl)
    ctx.parts.get(id).normalBody = fdir
  }
  if (!ctx.parts.get(id).normalBody) ctx.parts.get(id).normalBody = dir
  if (ctx.deckKeep) ctx.deckKeep.push(...deckKeepOfFeed(r, L, back, towerTop))
  // 支架：侧挂 → 三脚架落到对地板；塔馈 → 两根撑杆接塔顶（feedSupportRods，装配件同一式子）。
  // 组件模式（L 不带平台半边长 h、也没有塔顶）：不画支架——馈源怎么撑由装配件自己决定（整星路径恒带 h，不受影响）
  if (!towerTop && !L.h) return
  const segs = feedSupportRods(back, L, towerTop)
  if (segs.length) {
    const sm = new MB(), rr = feedSupportR(L)
    segs.forEach(([p0, p1], j) => { tube(sm, p0, p1, rr, 8); rodComp(ctx, `${id}_support_${j + 1}`, p0, p1) })
    box(sm, back, [0.05 * k, 0.05 * k, 0.05 * k])
    addItem(ctx, { name: `${id}_support`, role: 'boom', part: { id: `${id}_support`, name: `馈源支架 ${i + 1}`, role: 'boom' }, mat: 'aluminum', mb: sm })
  }
}

/**
 * 反射面展开臂 / 支撑杆。
 *   侧挂实面：侧壁背地端附近的两轴展开机构（ADTM）→ 一根直臂 → 支撑框内侧横梁上的连接点（sideArmGeom；臂与机构裹金色 MLI）。
 *   塔馈实面：对地板两根支撑 + 内缘到背面中心一根。
 *   网状没有背壳可接，臂只接桁架：侧挂 = 铰点分别到内缘（φ=π）桁架后环与前环节点，成 V 形；塔馈 = 对地板到内外缘后环。
 */
function buildReflectorArm(ctx, r, i, L) {
  const { D } = ctx
  const h = L.h, k = L.k, R = L.D / 2
  if (L.mount === 'side' && !L.mesh && L.link) {
    const g = sideArmGeom(L)
    const id = `reflector_${i + 1}_arm`
    addHw(ctx, id, { id, name: `反射面展开臂 ${i + 1}`, role: 'boom' }, 'boom', 'mli_gold', (put) => {
      adtmBlock(put, { base: g.base, n: g.n, up: [0, 1, 0], k: g.k })
      tube(put('mli_gold'), g.out, g.link, g.r, 12)
    })
    rodComp(ctx, `${id}_1`, g.out, g.link)
    return
  }
  const am = new MB(), rodR = Math.max(0.015 * k, 0.025 * Math.min(2, L.D / 2.5))
  const behind = L.mesh ? D.meshTrussDepthFrac * L.D : D.shellM
  const back = (x1, x2, off) => madd(L.P(x1, x2), L.N(x1, x2), -(behind + off))
  const edge = L.mesh ? 1 : 0.96
  const A = back(L.dc - R * edge, 0, L.mesh ? 0 : 0.04 * k)   // 内缘（靠母轴一侧）背后
  const segs = []
  if (L.mount === 'side') {
    const hinge = [L.s * h[0], clampN(L.F[1], -h[1] + 0.1 * k, h[1] - 0.1 * k), clampN(A[2], -h[2] + 0.1 * k, h[2] - 0.1 * k)]
    segs.push([hinge, A])
    if (L.mesh) segs.push([hinge, L.P(L.dc - R, 0)])
    else segs.push([A, back(L.dc, 0, 0.12 * k)])   // 口径中心背面
    box(am, hinge, [0.06 * k, 0.06 * k, 0.06 * k])
  } else {
    const Cf = back(L.dc + R * edge, 0, L.mesh ? 0 : 0.04 * k)
    const deckA = [A[0], A[1], h[2]], deckC = [clampN(Cf[0], -h[0], h[0]), clampN(Cf[1], -h[1] + 0.05 * k, h[1] - 0.05 * k), h[2]]
    if (A[2] - h[2] > 0.02 * k) segs.push([deckA, A])
    segs.push([deckC, Cf])
    if (!L.mesh) segs.push([A, back(L.dc, 0, 0.12 * k)])
  }
  segs.forEach(([p0, p1], j) => { if (len(sub(p1, p0)) > 0.01 * k) { tube(am, p0, p1, rodR, 10); rodComp(ctx, `reflector_${i + 1}_arm_${j + 1}`, p0, p1) } })
  addItem(ctx, { name: `reflector_${i + 1}_arm`, role: 'boom', part: { id: `reflector_${i + 1}_arm`, name: `反射面展开臂 ${i + 1}`, role: 'boom' }, mat: 'carbon', mb: am })
}

/** 反射面群：天线塔（有自动布局的塔馈反射面才画）→ 逐副解算布局 → 反射面 / 馈源 / 展开臂。三个布局族共用。 */
function buildReflectors(ctx) {
  const { spec, D, dens } = ctx
  const refl = spec.reflectors
  if (!refl.length) return
  const h = ctx.hRefl, k = D.reflDetailScale
  // 塔高：对地板反射面近缘（离母轴最近处 = 最低点）离对地板留 0.15 m×k
  const deck = refl.filter((r) => r.mount === 'deck' && !r.posBody)
  let th = 0
  for (const r of deck) {
    const f = focalOf(r, D), dc = deckOffset(r, D)
    const near = Math.max(0, dc - r.diameterM / 2)
    th = Math.max(th, f - near * near / (4 * f) + 0.15 * k)
  }
  ctx.towerH = spec.tower && isNum(spec.tower.hM) ? spec.tower.hM : th
  ctx.towerW = spec.tower && isNum(spec.tower.wM) ? spec.tower.wM : D.towerWM
  ctx.towerBuilt = !!(deck.length || (spec.tower && isNum(spec.tower.hM)))
  if (ctx.towerBuilt) {
    const tw = ctx.towerW
    const tm = new MB()
    box(tm, [0, 0, h[2] + ctx.towerH / 2], [tw / 2, tw / 2, ctx.towerH / 2], ['+x', '-x', '+y', '-y', '+z'])
    // 塔裹平台同色 MLI（调研 components.md §3(c)：在轨照片里塔 / 支架都包 MLI，不是白漆）
    const it = addItem(ctx, { name: 'antenna_tower', role: 'boom', part: { id: 'antenna_tower', name: '天线塔', role: 'boom' }, mat: towerFinish(spec), mb: tm })
    shellComp(ctx, 'antenna_tower', it, dens.towerAreal)
  }
  // 解算顺序：先内槽后外槽（外槽的偏置依赖内槽口径）
  const order = refl.map((r, i) => i).sort((a, b) => (refl[a].slot.endsWith('2') ? 1 : 0) - (refl[b].slot.endsWith('2') ? 1 : 0) || a - b)
  const resolved = new Map(), layouts = []
  for (const i of order) {
    const L = reflectorLayout(ctx, refl[i], resolved)
    if (!refl[i].posBody) resolved.set(refl[i].slot, L)
    layouts[i] = L
  }
  refl.forEach((r, i) => {
    const L = layouts[i]
    buildReflector(ctx, r, i, L)
    buildFeed(ctx, r, i, L, r.mount === 'deck' && !r.posBody ? h[2] + ctx.towerH : null)
    buildReflectorArm(ctx, r, i, L)
    if (L.mount === 'side' && !r.posBody) {
      const innerX = L.F[0] + L.s * (L.dc - L.D / 2)
      if (L.s * innerX < h[0] + 0.02 * k) ctx.warnings.push(`反射面 ${i + 1} 内缘伸进平台体（偏置 ${L.dc.toFixed(2)} m）`)
    }
  })
}

/** 显式附加喇叭的长度（口面 posBody 往后 2.12 × 口径；装配件 satSpecToComps 同式） */
export const extraHornLen = (ap) => 2.12 * ap

/** 显式附加件：feeds / booms / thrusters / radiators。 */
function buildExtras(ctx) {
  const { spec, dens } = ctx
  const h = [spec.bus.xM / 2, spec.bus.yM / 2, spec.bus.zM / 2]
  spec.feeds.forEach((f, i) => {
    const d = nrm(f.dirBody), id = `extra_feed_${i + 1}`, part = { id, name: `馈源 ${i + 1}`, role: 'feed' }
    if (f.kind === 'patchArray') {
      const m = new MB(), [e1, e2] = perpPair(d), a = f.apertureM / 2
      quad(m, madd(f.posBody, d, 0.005), scl(e1, a), scl(e2, a)); quad(m, f.posBody, scl(e2, a), scl(e1, a))
      const it = addItem(ctx, { name: id, role: 'feed', part, mat: 'white_paint', mb: m })
      shellComp(ctx, it.name, it, dens.hornAreal)
      return
    }
    // 波纹锥喇叭（台阶锥、阿洛丁金色）+ 线极化馈电链；质量按外包锥面（与装配件 sat.feed.horn 同式）
    const L = extraHornLen(f.apertureM)
    addHw(ctx, id, part, 'feed', 'gold_metal', (put) => {
      const hh = feedHorn(put, { ap: f.posBody, dir: d, D: f.apertureM, L, style: 'terraced', mat: { body: 'gold_metal', rim: 'gold_metal', inner: 'black_paint' }, seg: 24 })
      feedChain(put, { throat: hh.throat, dir: d, D: f.apertureM, kind: 'linear', seg: 16 })
    })
    hornShellMass(ctx, id, f.posBody, d, f.apertureM, L)
  })
  spec.booms.forEach((b, i) => {
    const m = new MB(); tube(m, b.fromBody, b.toBody, b.dM / 2, 10)
    addItem(ctx, { name: `boom_${i + 1}`, role: 'boom', part: { id: `boom_${i + 1}`, name: `杆 ${i + 1}`, role: 'boom' }, mat: 'carbon', mb: m })
    rodComp(ctx, `boom_${i + 1}`, b.fromBody, b.toBody)
  })
  spec.thrusters.forEach((t, i) => {
    // 钟形喷管（10 N 级双组元姿控造型，出口面在安装点沿喷流 lengthM 处；装配件 sat.thruster 'rcs' 同式）；质量点在安装点
    const d = nrm(t.dirBody), id = `thruster_${i + 1}`
    addHw(ctx, id, { id, name: `推力器 ${i + 1}`, role: 'thruster' }, 'thruster', 'titanium', (put) => rcsThruster(put, { base: t.posBody, dir: d, De: t.exitDM, L: t.lengthM, seg: 16 }))
    pointComp(ctx, id, dens.rcsMass, t.posBody)
  })
  const FACE = { '+X': [0, [1, 0, 0]], '-X': [0, [-1, 0, 0]], '+Y': [1, [0, 1, 0]], '-Y': [1, [0, -1, 0]], '+Z': [2, [0, 0, 1]], '-Z': [2, [0, 0, -1]] }
  spec.radiators.forEach((r, i) => {
    const [ax, n] = FACE[r.face], c = scl(n, h[ax] + 0.006)
    const [e1] = perpPair(n)
    const m = new MB(); quad(m, c, scl(e1, r.wM / 2), scl(cross(n, e1), r.hM / 2))
    const it = addItem(ctx, { name: `radiator_extra_${i + 1}`, role: 'radiator', part: { id: `radiator_extra_${i + 1}`, name: `散热面 ${i + 1}`, role: 'radiator' }, mat: 'radiator', mb: m })
    shellComp(ctx, it.name, it, dens.radiatorAreal)
  })
}

// ───────────────────────────── 三个布局族 ─────────────────────────────

function buildGeoLayout(ctx) {
  const { spec, D } = ctx
  const h = buildGeoBus(ctx)
  ctx.hRefl = h
  ctx.deckKeep = []
  if (spec.detail.thrusters) buildGeoThrusters(ctx, h)
  if (spec.detail.sensors !== false) buildGeoSensors(ctx, h)
  const wopt = { sadaLenM: D.sadaLenM, sadaDM: D.sadaDM, yokeRodDM: D.yokeRodDM, panelTM: D.panelTM, cellMarginM: D.cellMarginM, articulate: true }
  for (const w of spec.wings) buildWing(ctx, w, wopt)
  buildReflectors(ctx)
  if (spec.detail.deckHorns > 0) buildDeckHorns(ctx, h, spec.detail.deckHorns)
  buildExtras(ctx)
  addAp(ctx, 'nadir_center', [0, 0, h[2]], [0, 0, 1])
  addAp(ctx, 'zenith_center', [0, 0, -h[2]], [0, 0, -1])
}

function buildLeoLayout(ctx) {
  const { spec, D, dens } = ctx
  const h = [spec.bus.xM / 2, spec.bus.yM / 2, spec.bus.zM / 2]
  ctx.hRefl = h
  const busPart = { id: 'bus', name: '星体', role: 'bus' }
  const mb = new MB(); box(mb, [0, 0, 0], h)
  addItem(ctx, { name: 'bus', role: 'bus', part: busPart, mat: 'aluminum', mb })
  boxComp(ctx, 'bus', isNum(spec.bus.massKg) ? spec.bus.massKg : dens.busVolume * spec.bus.xM * spec.bus.yM * spec.bus.zM, [0, 0, 0], h)
  // 对地面相控阵：2×2（或 1×2 / 1 块）平板，离对地面 1 cm
  const nT = spec.phasedArray.tiles
  if (nT > 0) {
    const nx = nT >= 4 ? 2 : 1, ny = nT >= 2 ? 2 : 1, fr = D.phasedTileFrac * (nT === 1 ? 2 : 1)
    const tx = Math.min(h[0] * 2 * fr, (2 * h[0]) / nx * 0.92) / 2, ty = Math.min(h[1] * 2 * fr, (2 * h[1]) / ny * 0.92) / 2
    const am = new MB(), tT = D.phasedTileTM
    let k = 0
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        const cx = nx === 1 ? 0 : (ix === 0 ? -h[0] / 2 : h[0] / 2), cy = ny === 1 ? 0 : (iy === 0 ? -h[1] / 2 : h[1] / 2)
        const c = [cx, cy, h[2] + 0.01 + tT / 2]
        box(am, c, [tx, ty, tT / 2], ['+x', '-x', '+y', '-y', '+z'])
        plateComp(ctx, `phased_array_${++k}`, dens.arrayAreal * 4 * tx * ty, c, IDR, 2 * tx, 2 * ty)
      }
    }
    addItem(ctx, { name: 'phased_array', role: 'feed', part: { id: 'phased_array', name: '相控阵面', role: 'feed' }, mat: 'white_paint', mb: am })
    const p = ctx.parts.get('phased_array'); p.areaM2 = nT * 4 * tx * ty; p.normalBody = [0, 0, 1]
  }
  const wopt = { sadaLenM: D.sadaLenM, sadaDM: D.sadaDM, yokeRodDM: D.yokeRodDM, panelTM: D.panelTM, cellMarginM: D.cellMarginM, articulate: true }
  for (const w of spec.wings) buildWing(ctx, w, wopt)
  if (spec.detail.thrusters) {
    // 电推力器：背速度面（−X）中心，喷流 −X（霍尔推力器造型，放电通道直径 = thrusterDM；装配件 sat.thruster 'ep' 同式）
    const p0 = [-h[0], 0, 0]
    addHw(ctx, 'thruster_ep', { id: 'thruster_ep', name: '电推力器', role: 'thruster' }, 'thruster', 'aluminum', (put) => epThruster(put, p0, [-1, 0, 0], [0, 0, 1], D.thrusterDM, D.thrusterLenM))
    pointComp(ctx, 'thruster_ep', dens.epMass, madd(p0, [-1, 0, 0], D.thrusterLenM / 2))
  }
  buildReflectors(ctx)
  buildExtras(ctx)
  addAp(ctx, 'nadir_center', [0, 0, h[2]], [0, 0, 1])
  addAp(ctx, 'zenith_center', [0, 0, -h[2]], [0, 0, -1])
}

function buildCubesatLayout(ctx) {
  const { spec, D, dens } = ctx
  const X = spec.bus.xM, Y = spec.bus.yM, Z = spec.bus.zM
  const rw = D.railWM, foot = D.railFootM
  const zb = Z - 2 * foot, hb = [X / 2 - D.bodyInsetM, Y / 2 - D.bodyInsetM, zb / 2]
  const busPart = { id: 'bus', name: '星体', role: 'bus' }
  const bm = new MB(); box(bm, [0, 0, 0], hb)
  addItem(ctx, { name: 'bus', role: 'bus', part: busPart, mat: 'dark_metal', mb: bm })
  // CDS：四根角导轨贯通全长（含两端端脚）
  const rm = new MB()
  for (const sx of [1, -1]) for (const sy of [1, -1]) box(rm, [sx * (X / 2 - rw / 2), sy * (Y / 2 - rw / 2), 0], [rw / 2, rw / 2, Z / 2])
  addItem(ctx, { name: 'bus_rails', role: 'bus', part: busPart, mat: 'aluminum', mb: rm })
  boxComp(ctx, 'bus', isNum(spec.bus.massKg) ? spec.bus.massKg : dens.busVolume * X * Y * Z, [0, 0, 0], [X / 2, Y / 2, Z / 2])
  const cellNodes = []
  if (spec.cubesat.bodyCells) {
    const lift = D.cellLiftM, fr = D.bodyCellFrac
    const faces = [
      ['+X', [hb[0] + lift, 0, 0], [0, (Y / 2 - rw) * fr, 0], [0, 0, hb[2] * fr]],
      ['-X', [-hb[0] - lift, 0, 0], [0, 0, hb[2] * fr], [0, (Y / 2 - rw) * fr, 0]],
      ['+Y', [0, hb[1] + lift, 0], [0, 0, hb[2] * fr], [(X / 2 - rw) * fr, 0, 0]],
      ['-Y', [0, -hb[1] - lift, 0], [(X / 2 - rw) * fr, 0, 0], [0, 0, hb[2] * fr]]
    ]
    for (const [tag, c, u, v] of faces) {
      const cm = new MB(); quad(cm, c, u, v)
      const nm = `body_cells_${tag}`
      // 逐面一个部件、各带外法向与本面面积（同装配件 components/sat.mjs：每面一件体装电池片）。四面合成一个部件时太阳翼功率
      // 只能按面数均分面积：方截面（1U–3U、12U）碰巧对，6U 的 ±X 面 0.047 m²、±Y 面 0.019 m² 被均分成各 0.033 m²，功率偏 −30 % ~ +71 %
      addItem(ctx, { name: nm, role: 'solarArray', part: { id: nm, name: `体装电池片 ${tag}`, role: 'solarArray' }, mat: 'solar_cell', mb: cm })
      const a = 4 * len(u) * len(v)
      const n = nrm(cross(u, v)), Rf = [nrm(u), nrm(v), n]
      const p = ctx.parts.get(nm)
      p.areaM2 = a; p.normalBody = n.slice()
      plateComp(ctx, nm, dens.cellAreal * a, c, Rf, 2 * len(u), 2 * len(v))
      cellNodes.push(nm)
    }
    ctx.spg.push({ name: 'body', nodes: cellNodes, efficiency: SOLAR_EFFICIENCY_DEFAULT })
  }
  // 反射面的「平台」：侧壁取导轨外缘（CDS 包络），对地板取结构体顶面（不是导轨端脚——塔 / 支架落在端脚上会悬空）
  ctx.hRefl = [X / 2, Y / 2, hb[2]]
  // 对地端贴片天线：有自动布局的塔馈反射面时对地面中心让给天线塔
  if (!spec.reflectors.some((r) => r.mount === 'deck' && !r.posBody)) {
    const pm = new MB(), pw = Math.min(D.patchWM, X * 0.5) / 2
    box(pm, [0, 0, hb[2] + 0.0015], [pw, pw, 0.0015], ['+x', '-x', '+y', '-y', '+z'])
    addItem(ctx, { name: 'patch_antenna', role: 'feed', part: { id: 'patch_antenna', name: '贴片天线', role: 'feed' }, mat: 'white_paint', mb: pm })
  }
  if (spec.cubesat.deployPanels === 2) {
    // 背地端（−Z）棱铰链展开：板贴在 z=−zb/2 平面里沿 ±Y 伸出，电池面朝天顶；无 SADA，不设关节
    const wopt = { sadaLenM: 0, sadaDM: 0, yokeRodDM: 0.004, panelTM: D.panelTM, cellMarginM: D.cellMarginM, articulate: false }
    for (const side of ['+Y', '-Y']) {
      const s = side === '+Y' ? 1 : -1
      buildWing(ctx, { side, panels: 1, panelHM: zb, panelWM: X - 2 * rw, sidePanels: 0, yokeLenM: 0, gapM: 0, tiltDeg: 0, efficiency: SOLAR_EFFICIENCY_DEFAULT, hingeBody: [0, s * (Y / 2), -zb / 2 - D.panelTM / 2] }, wopt)
    }
  }
  buildReflectors(ctx)
  buildExtras(ctx)
  addAp(ctx, 'nadir_center', [0, 0, hb[2]], [0, 0, 1])
  addAp(ctx, 'zenith_center', [0, 0, -hb[2]], [0, 0, -1])
}

// ───────────────────────────── 汇总与输出 ─────────────────────────────

/**
 * spec → 参数化整星。
 * @param {ParamSpec} spec
 * @returns {{
 *   ir: object,                         // 契约 §3.1；根节点「satellite」带本体→模型轴旋转，其余节点为其直接子节点
 *   attachPoints: {name, node, posBody, dirBody, upBody}[],
 *   articulations: {name, nodes, stages}[],
 *   solarPanelGroups: {name, nodes, efficiency}[],
 *   massProps: {massKg, comBody, inertiaBody, source:'components', confidence:'low', components:{name, kind, massKg, comBody}[]},
 *   parts: {id, name, role, nodes, areaM2, normalBody?, fitted?}[],
 *   frame: {q_model2body, t_model2body, verified:true},
 *   bboxBody: {min, max}, boundingRadiusM, specOriginBody:number[3], specHash:string, spec:object, warnings:string[]
 * }}
 *   所有 *Body 坐标都在输出的本体系（原点 = 几何中心）；spec 里的坐标 = 输出坐标 + specOriginBody。
 */
export function buildParamModel(spec) {
  const v = validateSpec(spec)
  if (!v.ok) {
    const err = new Error(`参数不完整或非法：${[...v.missing.map((p) => p + ' 缺'), ...v.errors].join('；')}`)
    err.code = 'SPEC_INVALID'; err.errors = v.errors; err.missing = v.missing
    throw err
  }
  const s = normalizeSpec(spec)
  const ctx = newCtx(s)
  if (s.layout === 'leo-flat') buildLeoLayout(ctx)
  else if (s.layout === 'cubesat') buildCubesatLayout(ctx)
  else buildGeoLayout(ctx)

  // —— 包围盒（本体系、spec 原点）→ 几何中心平移
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  const worldCache = new Map()
  for (const it of ctx.items) {
    if (!it.mb || !it.mb.tcount) continue
    const P = worldPositions(it.mb, it.R, it.t)
    worldCache.set(it, P)
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const q = P[i + k]; if (q < mn[k]) mn[k] = q; if (q > mx[k]) mx[k] = q }
  }
  const c = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2)
  const sh = (p) => sub(p, c).map(z0)

  // —— 整星估算质量对齐：平台体吃余量（平台体是均质盒，惯量与质量成正比，按比例缩放）
  if (isNum(s.massTargetKg) && s.massTargetKg > 0 && !isNum(s.bus.massKg)) {
    const busC = ctx.comps.find((q) => q.name === 'bus')
    const other = ctx.comps.reduce((a, q) => a + (q === busC ? 0 : q.massKg), 0)
    const mb = s.massTargetKg - other
    if (busC && mb > 0.05 * s.massTargetKg) { const k = mb / busC.massKg; busC.massKg = mb; busC.I = busC.I.map((x) => x * k) }
    else ctx.warnings.push(`整星质量 ${s.massTargetKg} kg 小于附件合计 ${other.toFixed(1)} kg 的 1.05 倍，平台体按密度表估算`)
  }

  // —— 质量特性（components 累加，平行轴定理）
  let M = 0; const S = [0, 0, 0]
  for (const q of ctx.comps) { M += q.massKg; S[0] += q.massKg * q.com[0]; S[1] += q.massKg * q.com[1]; S[2] += q.massKg * q.com[2] }
  const com = scl(S, 1 / M)
  let I = m3zero()
  for (const q of ctx.comps) I = m3add(I, m3add(q.I, pAxis(q.massKg, sub(q.com, com))))
  // 数值对称化（组件惯量各自对称，累加后的舍入差抹平，避免 schema 的不对称判据误报）
  const Is = [[I[0], (I[1] + I[3]) / 2, (I[2] + I[6]) / 2], [(I[1] + I[3]) / 2, I[4], (I[5] + I[7]) / 2], [(I[2] + I[6]) / 2, (I[5] + I[7]) / 2, I[8]]].map((r) => r.map(z0))
  const massProps = {
    massKg: M, comBody: sh(com), inertiaBody: Is, source: 'components', confidence: 'low',
    components: ctx.comps.map((q) => ({ name: q.name, kind: q.kind, massKg: q.massKg, comBody: sh(q.com) }))
  }

  // —— IR
  const ir = { units: 'm', unitHint: 'm', sourceFormat: 'param', materials: [], meshes: [], nodes: [] }
  const matIdx = new Map()
  const matOf = (key) => {
    if (!matIdx.has(key)) {
      const d = MATERIALS[key]
      const m = { name: key, key, color: d.color.slice(), metalness: d.metalness, roughness: d.roughness }
      if (d.doubleSided) m.doubleSided = true
      if (isNum(d.opacity)) m.opacity = d.opacity
      ir.materials.push(m); matIdx.set(key, ir.materials.length - 1)
    }
    return matIdx.get(key)
  }
  if (ctx.names.has('satellite')) throw new Error('paramBus：节点名 satellite 被占用')
  ir.nodes.push({ name: 'satellite', parent: -1, matrix: ROOT_MATRIX.slice(), role: 'other', extras: { paramRoot: true } })
  for (const it of ctx.items) {
    const node = { name: it.name, parent: 0, matrix: colMajor(it.R, sh(it.t)) }
    if (it.role) node.role = it.role
    if (it.part) node.extras = { part: it.part.id }
    if (it.mb && it.mb.tcount) {
      ir.meshes.push({ name: it.name, position: Float32Array.from(it.mb.p), normal: Float32Array.from(it.mb.n), uv: Float32Array.from(it.mb.uv), index: Uint32Array.from(it.mb.idx), material: matOf(it.mat) })
      node.mesh = ir.meshes.length - 1
    }
    ir.nodes.push(node)
  }
  const attachPoints = ctx.aps.map((a) => {
    const pos = sh(a.posBody)
    // 挂点节点：局部 +Y = 视轴、+X = 上向（agi.mjs 口径，attachPointPoses 读回同一套数）；父节点是根，故入参就是本体系
    ir.nodes.push({ name: a.name, parent: 0, matrix: attachNodeMatrix(pos, a.dirBody, a.upBody), extras: { attachPoint: true } })
    return { name: a.name, node: a.name, posBody: pos, dirBody: a.dirBody.map(z0), upBody: a.upBody.map(z0) }
  })

  // —— 部件
  const parts = []
  for (const p of ctx.parts.values()) {
    if (!(p.areaM2 > 0)) {
      let A = 0
      for (const it of ctx.items) if (p.nodes.includes(it.name) && worldCache.has(it)) A += meshArea(worldCache.get(it), it.mb.idx)
      p.areaM2 = A
    }
    const o = { id: p.id, name: p.name, role: p.role, nodes: p.nodes.slice(), areaM2: p.areaM2 }
    if (p.normalBody) o.normalBody = p.normalBody.map(z0)
    if (p.fitted) o.fitted = { ...p.fitted, vertexBody: sh(p.fitted.vertexBody), focusBody: sh(p.fitted.focusBody), axisBody: p.fitted.axisBody.map(z0) }
    parts.push(o)
  }

  const bmin = sh(mn), bmax = sh(mx)
  const res = {
    ir, attachPoints,
    articulations: ctx.arts.map((a) => ({ name: a.name, nodes: a.nodes.slice(), stages: a.stages.map((q) => ({ ...q })) })),
    solarPanelGroups: ctx.spg.map((g) => ({ name: g.name, nodes: g.nodes.slice(), efficiency: g.efficiency })),
    massProps, parts,
    frame: { q_model2body: DEFAULT_Q_MODEL2BODY.slice(), t_model2body: [0, 0, 0], verified: true },
    bboxBody: { min: bmin, max: bmax },
    boundingRadiusM: Math.hypot(...sub(bmax, bmin)) / 2,
    specOriginBody: c.map(z0),
    specHash: specHash(s),
    spec: s,
    warnings: ctx.warnings.slice()
  }
  // 出口兜底：validateSpec 管不到的数值病（极端尺寸溢出、将来改生成器漏了细节档的键……）一律在这里拦下，
  // 不让 NaN 几何 / 坐标流进缩略图、导出和 3D 页（comp() 的 massKg>0 会滤掉 NaN 组件，只看质量是发现不了的）
  const bad = nonFiniteReport(res)
  if (bad.length) {
    const err = new Error(`生成结果含非有限数：${bad.slice(0, 6).join('、')}${bad.length > 6 ? ` 等 ${bad.length} 处` : ''}`)
    err.code = 'SPEC_INVALID'; err.errors = [err.message]; err.missing = []
    throw err
  }
  return res
}

/** 列出结果里含非有限数（或面积为 0 的反射面）的对象名；空数组 = 干净。装配件出口兜底用同一套（结果形状与 buildParamModel 同）。 */
export function nonFiniteReport(res) {
  const bad = new Set()
  const fin = (v) => typeof v === 'number' && Number.isFinite(v)
  const arr = (a) => { for (let i = 0; i < a.length; i++) if (!fin(a[i])) return false; return true }
  for (const m of res.ir.meshes) for (const key of ['position', 'normal', 'uv']) if (m[key] && !arr(m[key])) bad.add(m.name)
  for (const n of res.ir.nodes) if (n.matrix && !arr(n.matrix)) bad.add(n.name)
  for (const a of res.attachPoints) if (!arr(a.posBody) || !arr(a.dirBody) || !arr(a.upBody)) bad.add(a.name)
  const mp = res.massProps
  if (!fin(mp.massKg) || !(mp.massKg > 0) || !arr(mp.comBody) || !mp.inertiaBody.every(arr)) bad.add('massProps')
  for (const q of mp.components) if (!fin(q.massKg) || !arr(q.comBody)) bad.add(`massProps.${q.name}`)
  for (const p of res.parts) {
    if (!fin(p.areaM2) || (p.normalBody && !arr(p.normalBody))) bad.add(p.id)
    if (p.role === 'reflector' && !(p.areaM2 > 0)) bad.add(p.id)
    if (p.fitted && (!fin(p.fitted.focalM) || !arr(p.fitted.vertexBody) || !arr(p.fitted.focusBody) || !arr(p.fitted.axisBody))) bad.add(p.id)
  }
  if (!arr(res.bboxBody.min) || !arr(res.bboxBody.max) || !fin(res.boundingRadiusM) || !arr(res.specOriginBody)) bad.add('bbox')
  return [...bad]
}

/**
 * 模板 → 整星（templateSpec + buildParamModel）。fill 缺省 'illustrative'（needsInput 空位用示意值补齐，3D 页替身用）。
 * @returns 同 buildParamModel，另带 template:{id, needsInput, illustrative, specSources, warnings}
 */
export function buildTemplateModel(id, opts = {}) {
  const tid = resolveTemplateId(id)            // 旧模板 id 别名 → 现行 id（templateSpec 内部同样换）
  const t = templateSpec(id, opts)
  if (!t.spec || !tid) { const e = new Error(`未知模板「${id}」`); e.code = 'NO_TEMPLATE'; throw e }
  const r = buildParamModel(t.spec)
  r.template = { id: tid, title: TEMPLATES[tid].title, titleZh: TEMPLATES[tid].titleZh, needsInput: t.needsInput, illustrative: t.illustrative, specSources: t.specSources, warnings: t.warnings }
  return r
}
