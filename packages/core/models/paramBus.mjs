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
//   canon(v) / fnv1a64Hex(str)       → 规范化 JSON / FNV-1a 64（specHash = fnv1a64Hex(canon(normalizeSpec(spec)))）
//   nonFiniteReport(res)             → 生成结果里含非有限数的对象名（出口兜底）

import { DETAIL_PRESETS, templateSpec, TEMPLATES, resolveTemplateId } from './paramTemplates.mjs'
import { DEFAULT_Q_MODEL2BODY, ROOT_MATRIX_BODY2MODEL } from './bodyFrame.mjs'
import { attachNodeMatrix } from './agi.mjs'
// 网格原语 / 质量元 / 生成上下文（DESIGN3 §1 P0 从本文件原样抽出，装配组件共用；零漂移由 modelMeshKit 金标准看守）
import {
  isNum, isVec3, add, sub, scl, cross, len, nrm, reject, madd, clampN, z0, IDR, rApply, rotAboutLocalY, m3zero, m3add, pAxis, rotInertia,
  MB, quad, box, perpPair, frustum, tube, annulus, horn, worldPositions, meshArea,
  createCtx, addItem, comp, boxComp, plateComp, rodComp, shellComp, pointComp, addAp, paraLayout, colMajor
} from './meshKit.mjs'

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
  epMass: Object.freeze({ value: 2.0, unit: 'kg', source: 'illustrative', note: '电推力器量级' })
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
  concrete: Object.freeze({ color: [0.55, 0.54, 0.5], metalness: 0, roughness: 0.95 })
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
const KEYS_REFLECTOR = ['fdSolid', 'fdMesh', 'meshAboveDM', 'feedInsetM', 'feedStandoffM', 'wallGapM', 'shellM', 'towerWM', 'reflDetailScale', 'meshTrussDepthFrac', 'meshTrussRodFrac']
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
const slotSign = (slot) => (slot.startsWith('-') || slot === 'deck-Y' ? -1 : 1)
/** 槽位推出的缺省偏置方向（自母轴指向口径中心）：侧挂向外（±X），塔馈向南北（±Y）。 */
const slotOffsetDir = (slot) => (slot.startsWith('deck') ? [0, slotSign(slot), 0] : [slotSign(slot), 0, 0])

/**
 * @typedef {Object} WingSpec
 * @property {'+Y'|'-Y'} side      挂在哪个面（翼轴 = ±Y_body）
 * @property {number} panels        串联板数（沿翼展）
 * @property {number} panelHM       单板沿翼展长（m）
 * @property {number} panelWM       单板横宽（m，垂直翼轴、在板面内）
 * @property {number} [sidePanels] 最外一块两侧的侧板数（0 或 2，Spacebus 4000 类）
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
    s.wings = s.wings.map((w) => ({
      sidePanels: 0, yokeLenM: isNum(D.yokeLenM) ? D.yokeLenM : 0, gapM: isNum(D.gapM) ? D.gapM : 0.02, tiltDeg: 0, axis: 'y',
      efficiency: SOLAR_EFFICIENCY_DEFAULT, ...(w && typeof w === 'object' ? w : {})
    }))
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
  const busPart = { id: 'bus', name: '平台体', role: 'bus' }
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
  if (spec.detail.adapter) {
    // 星箭对接环：背地面（−Z）中心的铝环；环径不超过平台短边的 90 %
    const rOut = Math.min(D.adapterDM / 2, 0.45 * Math.min(spec.bus.xM, spec.bus.yM)), rIn = rOut * 0.94, hh = D.adapterHM
    const am = new MB(), c0 = [0, 0, -h[2]], c1 = [0, 0, -h[2] - hh]
    frustum(am, c0, rOut, c1, rOut, 48, false, false, false)
    frustum(am, c0, rIn, c1, rIn, 48, false, false, true)
    annulus(am, c1, [0, 0, -1], rIn, rOut, 48, [0, 0, -1])
    addItem(ctx, { name: 'bus_adapter', role: 'bus', part: busPart, mat: 'aluminum', mb: am })
  }
  return h
}

/** 推力器：远地点发动机（背地面中心）+ 8 个姿轨控推力器（背地面四角斜出 + 东西面四个）。dir = 喷流方向。 */
function buildGeoThrusters(ctx, h) {
  const { D, dens } = ctx
  const lm = new MB(), exitR = D.laeExitDM / 2
  const p0 = [0, 0, -h[2]], p1 = [0, 0, -h[2] - D.laeLenM]
  frustum(lm, p0, exitR * 0.35, p1, exitR, 32, true, false, false)
  frustum(lm, p0, exitR * 0.35 * 0.85, p1, exitR * 0.94, 32, false, false, true)
  addItem(ctx, { name: 'thruster_lae', role: 'thruster', part: { id: 'thruster_lae', name: '远地点发动机', role: 'thruster' }, mat: 'titanium', mb: lm })
  pointComp(ctx, 'thruster_lae', dens.laeMass, [0, 0, -h[2] - D.laeLenM * 0.4])
  const rm = new MB(), er = D.rcsExitDM / 2, inset = Math.min(0.15, 0.2 * Math.min(h[0], h[1]))
  const list = []
  for (const sx of [1, -1]) for (const sy of [1, -1]) list.push([[sx * (h[0] - inset), sy * (h[1] - inset), -h[2]], nrm([sx * 0.35, sy * 0.35, -1])])
  for (const sx of [1, -1]) for (const sy of [1, -1]) list.push([[sx * h[0], sy * (h[1] - inset), -h[2] + inset], [sx, 0, 0]])
  list.forEach(([p, d], i) => {
    frustum(rm, p, er * 0.35, madd(p, d, D.rcsLenM), er, 12, true, false, false)
    pointComp(ctx, `thruster_rcs_${i + 1}`, dens.rcsMass, madd(p, d, D.rcsLenM * 0.4))
  })
  addItem(ctx, { name: 'thruster_rcs', role: 'thruster', part: { id: 'thruster_rcs', name: '姿轨控推力器', role: 'thruster' }, mat: 'titanium', mb: rm })
}

/** 对地板（+Z）小喇叭（测控 / 信标）与地球敏感器。避开中心天线塔与东西缘的馈源。 */
function buildDeckHorns(ctx, h, n) {
  const { D, dens } = ctx
  const spots = [[0.76, 0.6], [-0.76, -0.6], [0.76, -0.6], [-0.76, 0.6]]
  const ra = D.hornApM / 2
  for (let i = 0; i < Math.min(n, 3); i++) {
    const [fx, fy] = spots[i], hm = new MB(), ap = [fx * h[0], fy * h[1], h[2] + D.hornLenM]
    horn(hm, ap, [0, 0, 1], ra, D.hornLenM, 20)
    const it = addItem(ctx, { name: `deck_horn_${i + 1}`, role: 'feed', part: { id: `deck_horn_${i + 1}`, name: `对地板喇叭 ${i + 1}`, role: 'feed' }, mat: 'aluminum', mb: hm })
    const sp = shellComp(ctx, `deck_horn_${i + 1}`, it, dens.hornAreal)
    ctx.parts.get(`deck_horn_${i + 1}`).areaM2 = sp.area
    ctx.parts.get(`deck_horn_${i + 1}`).normalBody = [0, 0, 1]
  }
  if (n >= 1) {
    const [fx, fy] = spots[3], sm = new MB(), e = Math.max(0.04, D.hornApM * 0.6)
    box(sm, [fx * h[0], fy * h[1], h[2] + e / 2], [e / 2, e / 2, e / 2], ['+x', '-x', '+y', '-y', '+z'])
    addItem(ctx, { name: 'earth_sensor', role: 'sensor', part: { id: 'earth_sensor', name: '地球敏感器', role: 'sensor' }, mat: 'dark_metal', mb: sm })
  }
}

/**
 * 太阳翼（GEO / LEO / 立方星展开板共用）。
 * 局部系（本体系下的列向量）：y_l = 翼展向外（side·Y）、z_l = −Z_body（电池面朝天顶）、x_l = y_l × z_l；
 * 再绕 y_l 转 tiltDeg。原点 = 铰点（缺省南北面中心）。板面中面过转轴（基板 z_l∈[−t/2, t/2]）。
 * 组件复用：ctx = meshKit.createCtx({dens})，w 给 hingeBody（如 [0,0,0]）就不读 ctx.spec；节点 / 挂点名固定为 wing_±Y_*，
 * 两副翼要各开一个 ctx（合并时加组件 id 前缀）。
 * opt = {sadaLenM, sadaDM, yokeRodDM, panelTM, cellMarginM, articulate, sadaPart?, sadaMassKg?}：
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
  // SADA：固定在平台上（不随关节转），用未转的 R0
  if (opt.sadaLenM > 0) {
    const sm = new MB()
    tube(sm, [0, -0.01, 0], [0, opt.sadaLenM, 0], opt.sadaDM / 2, 24)
    const sadaPart = opt.sadaPart || (ctx.spec ? { id: 'bus' } : { id: `${wname}_sada`, name: `太阳翼驱动机构 ${w.side}`, role: 'bus' })
    addItem(ctx, { name: `${wname}_sada`, role: 'bus', part: sadaPart, mat: 'aluminum', mb: sm, R: R0, t: hinge })
    if (isNum(opt.sadaMassKg) && opt.sadaMassKg > 0) {
      // 实心圆柱（沿局部 y，长 = 画出的 −0.01 … sadaLenM）：轴向 m r²/2、横向 m(3r² + L²)/12
      const mS = opt.sadaMassKg, rS = opt.sadaDM / 2, lS = opt.sadaLenM + 0.01, iT = mS * (3 * rS * rS + lS * lS) / 12
      comp(ctx, `${wname}_sada`, 'cylinder', mS, add(hinge, rApply(R0, [0, (opt.sadaLenM - 0.01) / 2, 0])), rotInertia(R0, iT, mS * rS * rS / 2, iT))
    }
  }
  const y0 = opt.sadaLenM + w.yokeLenM
  // 轭：长的画 V 形双杆 + 横梁；短的（< 0.3 m）画单根短杆
  if (w.yokeLenM > 0.01) {
    const ym = new MB(), r = opt.yokeRodDM / 2
    const root = [0, opt.sadaLenM, 0]
    const rods = w.yokeLenM >= 0.3
      ? [[root, [0.4 * W, y0 - r, 0]], [root, [-0.4 * W, y0 - r, 0]], [[-0.4 * W, y0 - r, 0], [0.4 * W, y0 - r, 0]]]
      : [[root, [0, y0, 0]]]
    rods.forEach(([a, b], i) => { tube(ym, a, b, r, 10); rodComp(ctx, `${wname}_yoke_${i + 1}`, toW(a), toW(b)) })
    addItem(ctx, { name: `${wname}_yoke`, role: 'boom', part: { id: `${wname}_yoke`, name: `太阳翼轭 ${w.side}`, role: 'boom' }, mat: 'carbon', mb: ym, R, t: hinge })
    artNodes.push(`${wname}_yoke`)
  }
  let cellArea = 0
  const panelAt = (tag, cx, yStart) => {
    const cy = yStart + H / 2
    const sm = new MB(); box(sm, [cx, cy, 0], [W / 2, H / 2, t / 2])
    const sub_ = addItem(ctx, { name: `${wname}_${tag}_substrate`, role: 'solarArray', part: wingPart, mat: 'solar_substrate', mb: sm, R, t: hinge })
    plateComp(ctx, sub_.name, dens.panelAreal * W * H, toW([cx, cy, 0]), R, W, H)
    const cm = new MB(), cw = Math.max(0.001, W / 2 - m), ch = Math.max(0.001, H / 2 - m)
    quad(cm, [cx, cy, t / 2 + CELL_LIFT], [cw, 0, 0], [0, ch, 0])
    const cel = addItem(ctx, { name: `${wname}_${tag}_cells`, role: 'solarArray', part: wingPart, mat: 'solar_cell', mb: cm, R, t: hinge })
    const ca = 4 * cw * ch
    plateComp(ctx, cel.name, dens.cellAreal * ca, toW([cx, cy, t / 2 + CELL_LIFT]), R, 2 * cw, 2 * ch)
    cellArea += ca
    artNodes.push(sub_.name, cel.name); cellNodes.push(cel.name)
  }
  for (let k = 0; k < w.panels; k++) panelAt(String(k + 1), 0, y0 + k * (H + w.gapM))
  if (w.sidePanels === 2) {
    const yl = y0 + (w.panels - 1) * (H + w.gapM)
    panelAt(`${w.panels}a`, W + w.gapM, yl); panelAt(`${w.panels}b`, -(W + w.gapM), yl)
  }
  const p = ctx.parts.get(wname)
  p.areaM2 = cellArea; p.normalBody = nrm(R[2])
  if (opt.articulate) {
    ctx.arts.push({ name: wname, nodes: artNodes, stages: [{ name: 'rotate', type: 'yRotate', minimumValue: -180, maximumValue: 180, initialValue: 0 }] })
  }
  ctx.spg.push({ name: wname, nodes: cellNodes, efficiency: w.efficiency })
  addAp(ctx, `${wname}_axis`, hinge, [0, s, 0])
  const tipY = y0 + w.panels * H + (w.panels - 1) * w.gapM
  return { hinge, tipBody: toW([0, tipY, 0]) }
}

/** 平面馈源阵边长：给了 feedApertureM 就用，否则按口径 12 % 取、夹在 (0.6–2 m)×k（示意）。 */
const feedArraySize = (r, Dm, k) => (isNum(r.feedApertureM) ? r.feedApertureM : clampN(0.12 * Dm, 0.6 * k, 2.0 * k))
const isMeshRefl = (r, D) => r.mesh === true || r.diameterM > D.meshAboveDM
const focalOf = (r, D) => (isNum(r.focalM) ? r.focalM : (isMeshRefl(r, D) ? D.fdMesh : D.fdSolid) * r.diameterM)
/** 塔馈反射面缺省偏置：口径中心离母轴 = 半口径 + 0.1 m×k。塔高（buildReflectors）与布局两处都用，必须同一个式子。 */
const deckOffset = (r, D) => (isNum(r.offsetHM) ? r.offsetHM : r.diameterM / 2 + 0.1 * D.reflDetailScale)

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
  return L
}

/**
 * 偏置抛物面反射面。正面网格：中心点 + 12 圈 × 48 段（口径面极坐标，米制 uv）。
 *   L 至少带 paraLayout 的全部字段 + mesh（布尔）；读 ctx.D 的 shellM / meshTrussDepthFrac / meshTrussRodFrac 与 ctx.dens。r 不读。
 *   实面：正面（reflector，朝焦点）+ 背壳（carbon，沿法向退 shellM）+ 边缘厚度环。
 *   网状（mesh）：只有一层金属网（reflector_mesh：双面、半透明）+ 周边桁架（AstroMesh 类：前后两环 + 竖杆 + 交替斜杆）。
 *     不画实心背壳——否则从背面看是整块黑碟、从正面看是金网叠黑壳，半透明网白做（09-23 审查）。
 *     桁架质量已按口径面积摊进 meshReflectorAreal，不另计。
 */
export function buildReflector(ctx, r, i, L) {
  const { D, dens } = ctx
  const R = L.D / 2
  const fm = new MB()
  const grid = []
  const c0 = fm.v(L.P(L.dc, 0), L.N(L.dc, 0), 0, 0)
  for (let k = 1; k <= PARA_NR; k++) {
    const rho = (R * k) / PARA_NR, row = []
    for (let j = 0; j < PARA_NA; j++) {
      const ph = (2 * Math.PI * j) / PARA_NA, x1 = L.dc + rho * Math.cos(ph), x2 = rho * Math.sin(ph)
      row.push(fm.v(L.P(x1, x2), L.N(x1, x2), rho * Math.cos(ph), rho * Math.sin(ph)))
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
  const front = addItem(ctx, { name: id, role: 'reflector', part, mat: L.mesh ? 'reflector_mesh' : 'reflector', mb: fm })
  const outer = grid[PARA_NR - 1]
  const pAt = (vi) => [fm.p[3 * vi], fm.p[3 * vi + 1], fm.p[3 * vi + 2]]
  const nAt = (vi) => [fm.n[3 * vi], fm.n[3 * vi + 1], fm.n[3 * vi + 2]]
  if (L.mesh) {
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
    addItem(ctx, { name: `${id}_back`, role: 'reflector', part, mat: 'carbon', mb: bm })
    addItem(ctx, { name: `${id}_rim`, role: 'reflector', part, mat: 'carbon', mb: rm })
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
    const ap = isNum(r.feedApertureM) ? r.feedApertureM : clampN(0.08 * L.D, 0.1 * k, 0.4 * k)
    const hl = 1.6 * ap
    horn(fm, L.F, dir, ap / 2, hl, 24)
    back = madd(L.F, dir, -hl)
    const it = addItem(ctx, { name: id, role: 'feed', part, mat: 'aluminum', mb: fm })
    shellComp(ctx, id, it, dens.hornAreal)
  }
  ctx.parts.get(id).normalBody = dir
  // 支架：侧挂 → 竖直落到对地板；塔馈 → 水平接到塔顶中心。
  // 组件模式（L 不带平台半边长 h、也没有塔顶）：不画支架——馈源怎么撑由装配件自己决定（整星路径恒带 h，不受影响）
  const sm = new MB()
  const h = L.h
  if (!towerTop && !h) return
  const foot = towerTop ? [0, clampN(back[1], -0.2 * k, 0.2 * k), towerTop] : [clampN(back[0], -h[0] + 0.05 * k, h[0] - 0.05 * k), clampN(back[1], -h[1] + 0.05 * k, h[1] - 0.05 * k), h[2]]
  if (len(sub(foot, back)) > 0.02 * k) {
    tube(sm, back, foot, Math.max(0.01 * k, 0.02 * Math.min(1, L.D / 2.5)), 8)
    addItem(ctx, { name: `${id}_support`, role: 'boom', part: { id: `${id}_support`, name: `馈源支架 ${i + 1}`, role: 'boom' }, mat: 'carbon', mb: sm })
    rodComp(ctx, `${id}_support`, back, foot)
  }
}

/**
 * 反射面展开臂 / 支撑杆。实面接背壳：侧挂 = 侧壁铰点 → 内缘背面 → 背面中心；塔馈 = 对地板两根支撑。
 * 网状没有背壳可接，臂只接桁架：侧挂 = 铰点分别到内缘（φ=π）桁架后环与前环节点，成 V 形；塔馈 = 对地板到内外缘后环。
 */
function buildReflectorArm(ctx, r, i, L) {
  const { D } = ctx
  const h = L.h, k = L.k, R = L.D / 2
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
  if (deck.length || (spec.tower && isNum(spec.tower.hM))) {
    const tw = spec.tower && isNum(spec.tower.wM) ? spec.tower.wM : D.towerWM
    const tm = new MB()
    box(tm, [0, 0, h[2] + ctx.towerH / 2], [tw / 2, tw / 2, ctx.towerH / 2], ['+x', '-x', '+y', '-y', '+z'])
    const it = addItem(ctx, { name: 'antenna_tower', role: 'boom', part: { id: 'antenna_tower', name: '天线塔', role: 'boom' }, mat: 'white_paint', mb: tm })
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

/** 显式附加件：feeds / booms / thrusters / radiators。 */
function buildExtras(ctx) {
  const { spec, dens } = ctx
  const h = [spec.bus.xM / 2, spec.bus.yM / 2, spec.bus.zM / 2]
  spec.feeds.forEach((f, i) => {
    const m = new MB(), d = nrm(f.dirBody)
    if (f.kind === 'patchArray') {
      const [e1, e2] = perpPair(d), a = f.apertureM / 2
      quad(m, madd(f.posBody, d, 0.005), scl(e1, a), scl(e2, a)); quad(m, f.posBody, scl(e2, a), scl(e1, a))
    } else horn(m, f.posBody, d, f.apertureM / 2, 1.6 * f.apertureM, 20)
    const it = addItem(ctx, { name: `extra_feed_${i + 1}`, role: 'feed', part: { id: `extra_feed_${i + 1}`, name: `馈源 ${i + 1}`, role: 'feed' }, mat: f.kind === 'patchArray' ? 'white_paint' : 'aluminum', mb: m })
    shellComp(ctx, it.name, it, dens.hornAreal)
  })
  spec.booms.forEach((b, i) => {
    const m = new MB(); tube(m, b.fromBody, b.toBody, b.dM / 2, 10)
    addItem(ctx, { name: `boom_${i + 1}`, role: 'boom', part: { id: `boom_${i + 1}`, name: `杆 ${i + 1}`, role: 'boom' }, mat: 'carbon', mb: m })
    rodComp(ctx, `boom_${i + 1}`, b.fromBody, b.toBody)
  })
  spec.thrusters.forEach((t, i) => {
    const m = new MB(), d = nrm(t.dirBody)
    frustum(m, t.posBody, t.exitDM * 0.175, madd(t.posBody, d, t.lengthM), t.exitDM / 2, 16, true, false, false)
    addItem(ctx, { name: `thruster_${i + 1}`, role: 'thruster', part: { id: `thruster_${i + 1}`, name: `推力器 ${i + 1}`, role: 'thruster' }, mat: 'titanium', mb: m })
    pointComp(ctx, `thruster_${i + 1}`, dens.rcsMass, t.posBody)
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
  if (spec.detail.thrusters) buildGeoThrusters(ctx, h)
  if (spec.detail.deckHorns > 0) buildDeckHorns(ctx, h, spec.detail.deckHorns)
  const wopt = { sadaLenM: D.sadaLenM, sadaDM: D.sadaDM, yokeRodDM: D.yokeRodDM, panelTM: D.panelTM, cellMarginM: D.cellMarginM, articulate: true }
  for (const w of spec.wings) buildWing(ctx, w, wopt)
  buildReflectors(ctx)
  buildExtras(ctx)
  addAp(ctx, 'nadir_center', [0, 0, h[2]], [0, 0, 1])
  addAp(ctx, 'zenith_center', [0, 0, -h[2]], [0, 0, -1])
}

function buildLeoLayout(ctx) {
  const { spec, D, dens } = ctx
  const h = [spec.bus.xM / 2, spec.bus.yM / 2, spec.bus.zM / 2]
  ctx.hRefl = h
  const busPart = { id: 'bus', name: '平台体', role: 'bus' }
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
    // 电推力器：背速度面（−X）中心，喷流 −X
    const tm = new MB(), p0 = [-h[0], 0, 0]
    frustum(tm, p0, D.thrusterDM / 2, madd(p0, [-1, 0, 0], D.thrusterLenM), D.thrusterDM / 2 * 0.8, 20, false, true, false)
    addItem(ctx, { name: 'thruster_ep', role: 'thruster', part: { id: 'thruster_ep', name: '电推力器', role: 'thruster' }, mat: 'dark_metal', mb: tm })
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
  const busPart = { id: 'bus', name: '平台体', role: 'bus' }
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
    let area = 0
    for (const [tag, c, u, v] of faces) {
      const cm = new MB(); quad(cm, c, u, v)
      const nm = `body_cells_${tag}`
      addItem(ctx, { name: nm, role: 'solarArray', part: { id: 'body_cells', name: '体装电池片', role: 'solarArray' }, mat: 'solar_cell', mb: cm })
      const a = 4 * len(u) * len(v); area += a
      const n = nrm(cross(u, v)), Rf = [nrm(u), nrm(v), n]
      plateComp(ctx, nm, dens.cellAreal * a, c, Rf, 2 * len(u), 2 * len(v))
      cellNodes.push(nm)
    }
    ctx.parts.get('body_cells').areaM2 = area
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
