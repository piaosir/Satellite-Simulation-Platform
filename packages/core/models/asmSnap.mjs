// 装配编辑器的纯逻辑（P3，CONTRACT §5.2 / §5.8；assembly-ux §3.4）：吸附判据、面内推断、滞回、位姿换算、镜像回映，
// 以及文档级编辑命令（13 种 apply 命令 + 编辑器内部的增 / 删 / 复制）。
//
// 纯 ESM、零 three 依赖、node 可测。编辑器（src/viz/models/assemblyEditor.js）与属性面板共用这些常量与判据。
//
// ★ 热路径（拖动时每帧）：pickNearest / createHysteresis().offer / faceInfer / clampToFace / snapTo / snapAngle / twistDeg /
//   uvOnFace / faceAtHit / mirrorHitToPrimary / liveBox / boxXform 以及 4×4 小工具（m4* / frameZX / faceFrame）一律不分配：
//   结果写进调用方给的 out（数组 / 对象）或直接返回标量；算中间量只用局部变量与模块级 Float64Array 暂存。
// ★ 文档命令（applyCmd 与 addComp / removeComps / duplicateComps …）只在提交时跑：允许分配，输入不改，返回归一后的新文档。
//   位姿保持类命令（setMode / reparent / setRoot / splitSym）用 assembly.solvePose 取当前世界位姿再反算安装语义，
//   与编辑器屏上看到的位姿同一个解算器（逐位一致）。
//
// 坐标与矩阵：4×4 一律列主序（与 assembly.solvePose 的 m 同一口径），本体系 = 文档坐标（根件坐标系）。
//   插座系 / 面系：z = 朝外法向、x = 滚转零位；子件 mount 插座系：z = −n（见 assembly.mjs 文件头）。
//
// 导出（常量）：DRAG_START_PX, SOCKET_PX, SOCKET_MAG_PX, FACE_MAG_PX, INFER_PX, INFER_LINE_PX, HYSTERESIS_PX, PASS_MAX, BAND,
//   MOVE_STEPS, MOVE_STEP_OPTS, ROT_STEPS, WHEEL_ROLL_DEG, UNDO_CAP, MERGE_MS, SNAP_DEFAULTS, INFER, CMD_TYPES, ID_PREFIX, SYM_LOCUS_REL, SOCKET_LABELS,
//   FACE_LABELS, ANCHOR_SOCKET_M, ANCHOR_SOCKET_REL, ANCHOR_FACE_REL, ANCHOR_MAX_M, GRID_STEPS
// 导出（对称判据）：symCoincides(doc, comp) —— 文档里这一件带着的对称会不会让副本压在原件上（onSymLocus + 组件包围盒）
//   socketSingle(doc, comp) —— 件装在父件声明的单件接口上（ComponentDef.singleSockets：直升机尾桨），工具栏对称的缺省不作用于它
// 导出（吸附 / 数学）：compIdFor, mountFor, pickNearest, createHysteresis, faceInfer, faceInferIO, clampToFace, clampIO, snapTo, snapAngle, twistDeg,
//   uvOnFace, uvOnFaceP, faceAtHit, faceMagnetIO, socketDedicated, socketLabel, faceLabel, symFromUi, onSymLocus, mirrorHitToPrimary, liveBox, boxXform, aabbPairs,
//   autoGridStep, resolveMoveStep, isFullCyl, passThroughOf（components/index.mjs 再出口）,
//   m4Ident, m4Copy, m4Mul, m4InvRigid, m4FromQT, m4ToQT, m4RotZ, frameZX, faceFrame, faceFrameUV, socketFrame, mountFrame, planeAxis
// 导出（质量预览）：massCombine, massPack
// 导出（文档）：primaryIdOf, compById, childrenOf, subtreeOf, ancestorsOf, inSymSubtree, subtreeHasOwnSym, compGeo, mountSocketOf,
//   usedSocketKeys, occupiedSocketKeys, freeSocketsOf, freeSocketChoices, ownMountKey, ownMountKeys, foldedSocketOf, isFoldedSocket, socketTwoSided, faceMountable, socketUsable,
//   mountChoices, mountLabel, anchorFrame, mountedFrame, geomKey, applyCmd, addComp, removeComps, duplicateComps,
//   attachFromWorld, attachFromWorldExact, pickAnchor, mkAttach（assembly.mjs 再出口）, freezeDoc
//
// ★ 带锚安装（2026-10 设计页交互重构 §3.3.1）：attach 恒为 {mode, socket, face, uv, roll, mount, off, tilt}（assembly.mjs 文件头）。
//   位姿保持类命令一律「保持世界位姿 + 保锚」：setMode('free') 保留现锚（t / q 相对锚系）；setMode('socket') 只在
//   pickAnchor 阈值内的空闲接口里选（没有报「无可用接口。」）；setMode('surface') / reparent 按 pickAnchor 就近取锚；splitSym 的
//   顶层副本先取主件锚的镜像（mirroredAnchor：机身中线上的翼根镜像回自己 = 与主件共锚，星体 +Y 面 → −Y 面），对不上再 pickAnchor；
//   再用 attachFromWorldExact 精确反解 off / roll / tilt（往返 ≤ 1e-9；原地重放取原值，文档逐字节不变）。
//   取锚阈值：平面 |u| ≤ 1.05·halfU、|v| ≤ 1.05·halfV、−min(件尺寸, 0.5 m) ≤ 法向距离 ≤ 件尺寸 → 空闲接口 ≤ min(max(5 cm, 25 % 件尺寸),
//   0.5 m) → 柱面（轴向同平面、整圆或弧内、法向距离同平面）→ 都不中 = 无锚自由（相对父件）。件尺寸 = 组件局部包围盒最长边；
//   0.5 m（ANCHOR_MAX_M）是大件的绝对上限（嵌进父件的深度 / 离接口的距离）。面安装件的 off 只有法向分量（面内走 uv）。
// ★ 候选净化：非根件自己的安装接口不作落点（ownMountKey / ownMountKeys：'@面' / '@bbox' 安装端连同与它同位同向的本件插座）；
//   与同件平面面心重合的通用接口（accepts = null）是「折叠接口」（isFoldedSocket / foldedSocketOf），编辑器不单列、由面心推断代替；
//   机构 / 小件 / 纯外观件的面不可安装（faceMountable），折叠在这种面上的接口一并不收（socketUsable）；其中贴在面上的纯外观薄件
//   （对地贴片）射线穿过（passThroughOf）。占用（occupiedSocketKeys）按几何认：任一件（含对称派生副本）的安装点落在某件插座上
//   即占用，键按主件 id。
//
// ★ 拖入 / 拾起的落点判定（编辑器 solveDrag；2026-10-07 v3「指到哪装到哪」）：指针下那一件说了算——
//   ① 指针压在某个空闲插座标记上（SOCKET_PX 内，可见的）→ 该插座；
//   ② 射线打中件 E：E 有给本件「专用」的空闲插座（accepts 里非 'prim.' 的前缀匹配：机翼根、焦点、俯仰轴、车顶…）→ 最近的那个
//      （E 没有安装面时不限距离：短舱进翼下挂点、馈源进焦点）；否则命中处是 E 的可贴面 → 贴面（面心 / 边中点 / 角点 / 中线 / 边线 /
//      网格推断）；否则 E 上任一兼容空闲插座 → 最近的那个；否则命中点就近投到 E 的可贴面（投影点离指针不远时）；
//      都没有：E 是贴在面上的薄件（passThroughOf：散热面 / 体装电池片 / 纯外观薄贴片）→ 射线穿过 E 再找（PASS_MAX 次）；
//      别的件 → 贴在指针处的表面上（表面安装：安装端法向贴命中法向，松手按 pickAnchor 就近带锚），不报「无可用安装位」；
//      接口的正背面：socketTwoSided 的接口（无安装面的件上的、中面里的横向对齐接口）两面都可选，其余背向相机的不自动选；
//   ③ 射线什么都没打中：SOCKET_MAG_PX 内的可见插座、FACE_MAG_PX 内的可贴面（指针在面外侧的近失，离面轮廓的屏幕距离）磁吸；空文档 = 原点；
//   ④ 都没有 = 未吸附（松手不装）。按住 Shift：不吸附，贴在指针处的表面上（原样贴）。
//   候选按 BAND 分档记代价（档 × 1000 + 屏幕距离），配合滞回：档内按距离、跨档按优先级。

import { getComponent, fillParams, socketAccepts, faceAccepts, passThroughOf } from './components/index.mjs'
import { normalizeAssembly, solvePose, componentBox, componentMounts, componentMount, mkAttach, COMP_ID_RE, RESERVED_COMP_IDS, SYM_OPS, SYM_AXES, ATTACH_MODES } from './assembly.mjs'
import { MATERIALS, canon } from './paramBus.mjs'

export { mkAttach, passThroughOf }

// ───────────────────────────── 常量 ─────────────────────────────

/** 库卡片按下后越过这么多 CSS 像素才算开始拖（与结构树行拖动同一门槛）。 */
export const DRAG_START_PX = 4
/** 插座吸附半径（屏幕 CSS 像素）：指针压在插座标记上的判据。 */
export const SOCKET_PX = 22
/** 指针没打中任何件时，插座的磁吸半径（屏幕 CSS 像素；只算看得见的插座）。 */
export const SOCKET_MAG_PX = 56
/** 指针没打中任何件时，可贴面的磁吸半径（指针到面轮廓的屏幕距离，CSS 像素；只算朝向相机的平面面）。 */
export const FACE_MAG_PX = 36
/** 面内推断点（面心 / 边中点 / 角点）吸附半径（屏幕 CSS 像素）。 */
export const INFER_PX = 12
/** 面内推断线（中线 / 边线）吸附半径（屏幕 CSS 像素；≤ INFER_PX / √2：两条线同时吸住的地方恰被推断点先接走）。 */
export const INFER_LINE_PX = 8
/** 候选切换滞回：新候选的屏幕代价比当前好这么多像素以上才换。 */
export const HYSTERESIS_PX = 4
/** 射线穿过「什么都接不了、又贴在面上」的薄件（ComponentDef.passThrough）再找的次数上限。 */
export const PASS_MAX = 3
/**
 * 落点候选的优先档（代价 = 档 × 1000 + 屏幕距离；越小越优先）。空白处的插座磁吸与面磁吸同一档、按距离就近
 * （面另加 FACE_MAG_BIAS_PX：差不多近时插座优先），指针贴着面边缘时不会被远处的插座抢走。
 */
export const BAND = Object.freeze({ SOCKET: 0, DEDICATED: 1, FACE: 2, PART_SOCKET: 3, MAG: 4, ROOT: 6 })
/** 空白处磁吸：面比插座多算这么多像素（两者差不多近时取插座）。 */
export const FACE_MAG_BIAS_PX = 6
/** 平移吸附步长（米）。 */
export const MOVE_STEPS = Object.freeze([0.01, 0.05, 0.1, 0.5])
/**
 * 平移吸附步长的可选档：'auto'（autoGridStep：锚面短边 / 20 取 1-2-5 档）+ MOVE_STEPS。MOVE_STEPS 保持纯数字（老调用方当数字下拉 /
 * includes 判值用），新 UI 用这一份；数值一律经 resolveMoveStep 落成米再交给 faceInferIO / snapTo。
 */
export const MOVE_STEP_OPTS = Object.freeze(['auto', ...MOVE_STEPS])
/** 自动网格的 1-2-5 档（米，1 mm–1 m）。 */
export const GRID_STEPS = Object.freeze([0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1])
/** 取锚（pickAnchor）：空闲接口的距离上限 = max(ANCHOR_SOCKET_M, ANCHOR_SOCKET_REL × 件尺寸)。 */
export const ANCHOR_SOCKET_M = 0.05
export const ANCHOR_SOCKET_REL = 0.25
/** 取锚：平面面内范围 |u| ≤ ANCHOR_FACE_REL·halfU、|v| ≤ ANCHOR_FACE_REL·halfV（与 faceAtHit 的 1.05 倍边界同）。 */
export const ANCHOR_FACE_REL = 1.05
/**
 * 取锚的绝对上限（米）：安装点嵌进父件面背侧的深度、离接口的距离都不超过它（按件尺寸放大的阈值对翼展十几米的大件会挂上没有
 * 意义的锚——镜像机翼挂到机腹面、法向偏移 −1.45 m；朝外的离面距离不受它限：塔顶反射面改挂星体照样取顶面）。
 */
export const ANCHOR_MAX_M = 0.5
/** 旋转吸附步长（度）。 */
export const ROT_STEPS = Object.freeze([5, 15, 45, 90])
/** 拖入 / 拾起中滚轮一格的滚转（度）；按住 Shift 为 1°。 */
export const WHEEL_ROLL_DEG = 15
/** 撤销栈上限。 */
export const UNDO_CAP = 100
/** 同件同键的参数编辑在这么多毫秒内合并为一条撤销。 */
export const MERGE_MS = 500
/** 出厂吸附设置：开、平移 0.05 m、旋转 15°。 */
export const SNAP_DEFAULTS = Object.freeze({ on: true, move: 0.05, rotate: 15 })
/**
 * faceInfer 的 out.kind：0 自由、1 网格、2 面心（柱面：轴向中线）、3 边中点（柱面：端线）、4 角点、
 * 6 在中线上（平面：u = 0 或 v = 0，另一向按网格）、7 在边线上（平面：u = ±halfU 或 v = ±halfV，另一向按网格）。
 * （5 留给编辑器的插座记号，推断不用。）
 */
export const INFER = Object.freeze({ FREE: 0, GRID: 1, CENTER: 2, EDGE: 3, CORNER: 4, CLINE: 6, ELINE: 7 })
/** applyCmd 认的命令类型（CONTRACT §5.1 表）。 */
export const CMD_TYPES = Object.freeze(['setParams', 'rename', 'setHidden', 'setLocked', 'setMaterial', 'setMass', 'setAttach', 'setMode', 'reparent', 'setRoot', 'setSym', 'splitSym', 'setDoc'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const z0 = (v) => (v === 0 ? 0 : v)
/** 位姿反算出来的数抹掉 1e-12 以下的浮点尘（文档 JSON 干净、同一位姿两次存盘字节相同）。 */
const clean = (v) => (Math.abs(v) < 1e-12 ? 0 : v)
const D2R = Math.PI / 180, R2D = 180 / Math.PI

// ───────────────────────────── 组件 id ─────────────────────────────

/** type（或 `前缀.*` 通配）→ 可读 id 前缀。按段边界匹配，取最长的那条；表外按 type 末段。 */
export const ID_PREFIX = Object.freeze([
  ['sat.bus.*', 'bus'], ['sat.wing', 'wing'], ['sat.reflector', 'refl'], ['sat.feed.horn', 'feed'], ['sat.array.phased', 'arr'], ['sat.tower', 'tower'],
  ['sat.boom', 'boom'], ['sat.thruster', 'thr'], ['sat.radiator', 'rad'], ['sat.sensor.star', 'star'], ['sat.sensor.sun', 'sun'], ['sat.sensor.earth', 'esen'], ['sat.antenna.ttc', 'ttc'], ['prim.box', 'box'], ['prim.cyl', 'cyl'],
  ['es.pedestal.*', 'ped'], ['es.refl.*', 'refl'], ['es.subrefl', 'sub'], ['es.feed', 'feed'], ['es.radome', 'radome'], ['es.shelter', 'shelter'], ['es.tower', 'tower'],
  ['es.vsat.mount', 'mnt'], ['es.mast', 'mast'],
  ['air.fuselage', 'fus'], ['air.wing', 'wing'], ['air.htail', 'ht'], ['air.vtail', 'vt'], ['air.nacelle', 'eng'], ['air.prop', 'prop'], ['air.radome', 'rdm'],
  ['air.turret', 'tur'], ['air.gear', 'gear'], ['air.heli', 'heli'], ['air.mrbody', 'body'], ['air.boom', 'boom'], ['air.rotor', 'rotor'],
  ['sea.hull', 'hull'], ['sea.superstructure', 'brg'], ['sea.funnel', 'fnl'], ['sea.mast', 'mast'], ['sea.containers', 'box'], ['sea.vsat.radome', 'vsat'],
  ['veh.body', 'body'], ['veh.cotm.flat', 'cotm'], ['veh.driveaway', 'dw']
].map((r) => Object.freeze(r)))

function prefixFor(type) {
  const t = typeof type === 'string' ? type : ''
  let best = null, bl = -1
  for (const [k, p] of ID_PREFIX) {
    const base = k.endsWith('.*') ? k.slice(0, -2) : k
    if ((t === base && !k.endsWith('.*')) || t.startsWith(base + '.')) { if (base.length > bl) { bl = base.length; best = p } }
  }
  if (best) return best
  const seg = (t.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
  if (!seg) return 'c'
  return /^[a-z]/.test(seg) ? seg : ('c' + seg).slice(0, 16)
}

// 驱动装配件（drive.mjs）基线件的 id：文档里的新件要避开它们——包括被用户删掉的基线件（新件拿了那个 id 就会被当成那件基线件的
// 改写，驱动参数一变还会被当生成件删掉，v1.5.0 排查 #20）。drive.mjs import 本模块、本模块不能反过来 import 它，由它载入时登记
let driveReservedIds = null
/** drive.mjs 登记：fn(doc) → 该驱动文档当前基线的全部件 id（可迭代） */
export function setDriveReservedIds(fn) { driveReservedIds = typeof fn === 'function' ? fn : null }

/**
 * 可读组件 id：按 type 查前缀表（ID_PREFIX），首个不带号，之后 2、3…；合 COMP_ID_RE、避开保留名与已用 id
 * （驱动装配件另避开基线件的 id，见 setDriveReservedIds）。
 * @param {object} doc 装配文档（读 comps[].id）
 * @param {string} type
 * @param {Set<string>} [used] 另外要避开的 id（一次造多个时传同一个 Set，函数会把新 id 加进去）
 */
export function compIdFor(doc, type, used) {
  const taken = new Set(used || [])
  for (const c of (isObj(doc) && Array.isArray(doc.comps) ? doc.comps : [])) if (c && typeof c.id === 'string') taken.add(c.id)
  if (driveReservedIds && isObj(doc) && isObj(doc.drive)) { try { for (const id of driveReservedIds(doc) || []) taken.add(id) } catch { /* 驱动参数坏了：不避 */ } }
  const base = prefixFor(type)
  const ok = (id) => COMP_ID_RE.test(id) && !RESERVED_COMP_IDS.includes(id) && !taken.has(id)
  let id = base
  for (let k = 2; !ok(id); k++) {
    const suf = String(k)
    id = base.slice(0, 24 - suf.length) + suf
  }
  if (used) used.add(id)
  return id
}

// ───────────────────────────── 安装插座选择 ─────────────────────────────

/** 父插座 id → 子件优先用哪个插座去贴（有该插座才用）。 */
const MOUNT_RULES = Object.freeze([Object.freeze({ parent: 'focus', child: 'aperture' })])

/**
 * 子件拿哪个插座去贴父插座：规则表（父插座 'focus' 且子件有 'aperture' → 'aperture'）→ 否则 def.mountSocket。
 * @returns {string} 插座 id（等于 def.mountSocket 时编辑器存 null）
 */
export function mountFor(def, params, parentSocket) {
  const dflt = (def && def.mountSocket) || 'root'
  if (!def || !parentSocket) return dflt
  let socks = null
  for (const r of MOUNT_RULES) {
    if (parentSocket.id !== r.parent) continue
    if (!socks) { try { socks = def.sockets(fillParams(def, params)) } catch { socks = [] } }
    if (socks.some((s) => s.id === r.child)) return r.child
  }
  return dflt
}

/**
 * 插座是不是「专用」给 type 的：accepts 里有 type 匹配上的前缀、且不是通用基本体前缀 'prim.'（各专用插座都顺带收基本体当占位，
 * 那不算专用）。拖入 / 拾起时指针下的件若有给本件的专用空闲插座，优先它（机翼进翼根、馈源进焦点、反射面上俯仰轴），不按命中处贴面。
 */
export function socketDedicated(s, type) {
  if (!s || s.accepts == null || typeof type !== 'string') return false
  for (const p of s.accepts) if (p !== 'prim.' && type.startsWith(p)) return true
  return false
}

/** 插座 id → 中文名（吸附状态、属性面板用；面心插座 '+X' 一类不在表里，按「接口 +X」写）。 */
export const SOCKET_LABELS = Object.freeze({
  root: '根部', back: '背面', focus: '焦点', aperture: '口面', front: '阵面', top: '顶部', tip: '端部',
  el: '俯仰轴', y: 'Y 轴', mast: '杆顶', floor: '底板',
  wing: '翼根', htail: '平尾根', vtail: '垂尾根', ventral: '腹鳍根', aftEng: '尾吊挂点', tail: '尾锥', crown: '背部', chin: '颔部', eng1: '发动机挂点',
  eng2: '外侧发动机挂点', nose: '机头', dorsal: '背负挂点', rotor: '旋翼轴', trotor: '尾桨轴', fwd: '前电机', aft: '后电机', end: '撑杆尾端', gimbal: '云台',
  m1: '电机 1', m2: '电机 2', m3: '电机 3', m4: '电机 4', m5: '电机 5', m6: '电机 6', m7: '电机 7', m8: '电机 8',
  deck: '甲板', bow: '艏楼', stern: '艉部', platform: '平台', yardP: '左横桁', yardS: '右横桁', wingP: '左舷翼台', wingS: '右舷翼台',
  roof: '车顶', hitch: '拖钩', bed: '货箱',
  side0: '侧面 1', side1: '侧面 2', side2: '侧面 3', side3: '侧面 4', side4: '侧面 5', side5: '侧面 6'
})
/** 插座的显示名：表里有 → 中文名；没有 → 「接口 <id>」。 */
export const socketLabel = (id) => (Object.hasOwn(SOCKET_LABELS, id) ? SOCKET_LABELS[id] : '接口 ' + id)
/** 安装面 id → 中文名（安装端「面心 …」、读数的面名用）；盒面 '+X' 一类轴号原样。 */
export const FACE_LABELS = Object.freeze({
  side: '侧面', top: '顶面', deck: '甲板', bowdeck: '艏楼甲板', roof: '车顶', bed: '货箱',
  skin: '蒙皮', belly: '腹部', sideR: '右侧', sideL: '左侧'
})
/**
 * 安装面的显示名：表里有 → 中文名；编号面按前缀（六棱柱 side0… → 「侧面 1…」、船体 deckFwd1… → 「前甲板 1…」、deckAft1… →
 * 「后甲板 1…」、bowdeck2… → 「艏楼甲板 2…」）；其余原样（盒面轴号）。
 */
export function faceLabel(id) {
  const s = String(id)
  if (Object.hasOwn(FACE_LABELS, s)) return FACE_LABELS[s]
  const m = /^(side|deckFwd|deckAft|bowdeck)(\d+)$/.exec(s)
  if (!m) return s
  const k = Number(m[2])
  return m[1] === 'side' ? `侧面 ${k + 1}` : `${m[1] === 'deckFwd' ? '前甲板' : m[1] === 'deckAft' ? '后甲板' : '艏楼甲板'} ${k}`
}

// ───────────────────────────── 屏幕候选 / 滞回 ─────────────────────────────

/** 屏幕坐标（CSS 像素）里离 (px, py) 最近且在 rPx 内的下标；NaN 坐标跳过（被剔除的候选）；没有返回 −1。 */
export function pickNearest(xs, ys, n, px, py, rPx) {
  let best = -1, bd = rPx * rPx
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - px, dy = ys[i] - py, d2 = dx * dx + dy * dy
    if (d2 <= bd) { bd = d2; best = i }
  }
  return best
}

/**
 * 候选滞回器（创建时分配一次，之后零分配）：
 *   offer(key, cost) —— key 等于当前：只刷新当前代价、返回 false；当前为空（key < 0）：直接换、返回 true；
 *                       否则 cost 比当前代价小 px 以上才换（返回 true），不然保持（false）。
 *   用法：每帧先把当前候选这一帧的代价 offer 一次（仍有效时），再 offer 本帧最优；当前已失效就先 reset()。
 */
export function createHysteresis(px = HYSTERESIS_PX) {
  const h = {
    key: -1, cost: Infinity, px,
    offer(key, cost) {
      if (key === h.key) { h.cost = cost; return false }
      if (h.key < 0 || cost < h.cost - h.px) { h.key = key; h.cost = cost; return true }
      return false
    },
    reset() { h.key = -1; h.cost = Infinity }
  }
  return h
}

// ───────────────────────────── 标量吸附 ─────────────────────────────

/** 按步长取整（step ≤ 0 原样）；结果抹掉 1e-9 以下的十进制尘（6 × 0.05 = 0.3 而不是 0.30000000000000004）、−0 → 0。 */
export function snapTo(x, step) {
  if (!(step > 0)) return x
  const r = Math.round(Math.round(x / step) * step * 1e9) / 1e9
  return r === 0 ? 0 : r
}
/** 角度按步长取整并归到 (−180, 180]（step ≤ 0 只归一）。 */
export function snapAngle(deg, step) {
  let a = step > 0 ? Math.round(deg / step) * step : deg
  a = ((a % 360) + 540) % 360 - 180
  if (a === -180) a = 180
  a = Math.round(a * 1e9) / 1e9
  return a === 0 ? 0 : a
}

/**
 * 旋转绕局部某轴的扭转角（swing-twist 分解取 twist，度，(−180, 180]）。m 为列主序 4×4（只读旋转部分），axisIdx 0/1/2 = x/y/z。
 * 绕 z：atan2(R10 − R01, R00 + R11) = 2·atan2(q_z, q_w)（双角公式），纯扭转时就是转角本身，±180° 两侧连续。
 */
export function twistDeg(m, axisIdx = 2) {
  let s, c
  if (axisIdx === 0) { s = m[6] - m[9]; c = m[5] + m[10] } else if (axisIdx === 1) { s = m[8] - m[2]; c = m[10] + m[0] } else { s = m[1] - m[4]; c = m[0] + m[5] }
  const a = Math.atan2(s, c) * R2D
  return a === 0 ? 0 : (a === -180 ? 180 : a)
}

// ───────────────────────────── 4×4（列主序，写进 o） ─────────────────────────────

export function m4Ident(o) { for (let i = 0; i < 16; i++) o[i] = i % 5 === 0 ? 1 : 0; return o }
export function m4Copy(o, a) { for (let i = 0; i < 16; i++) o[i] = a[i]; return o }
/** o = a · b（o 不得与 a / b 同一数组）。 */
export function m4Mul(o, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[4 * c], b1 = b[4 * c + 1], b2 = b[4 * c + 2], b3 = b[4 * c + 3]
    o[4 * c] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
    o[4 * c + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
    o[4 * c + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
    o[4 * c + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
  }
  return o
}
/** 正交（含镜像）+ 平移的逆（o 不得与 a 同一数组）。 */
export function m4InvRigid(o, a) {
  o[0] = a[0]; o[1] = a[4]; o[2] = a[8]; o[3] = 0
  o[4] = a[1]; o[5] = a[5]; o[6] = a[9]; o[7] = 0
  o[8] = a[2]; o[9] = a[6]; o[10] = a[10]; o[11] = 0
  o[12] = -(o[0] * a[12] + o[4] * a[13] + o[8] * a[14])
  o[13] = -(o[1] * a[12] + o[5] * a[13] + o[9] * a[14])
  o[14] = -(o[2] * a[12] + o[6] * a[13] + o[10] * a[14])
  o[15] = 1
  return o
}
/** 四元数 [x,y,z,w]（先归一；零四元数按单位阵）+ 平移 → o。 */
export function m4FromQT(o, q, t) {
  let x = q[0], y = q[1], z = q[2], w = q[3]
  const n = Math.sqrt(x * x + y * y + z * z + w * w)
  if (n > 0) { x /= n; y /= n; z /= n; w /= n } else { x = 0; y = 0; z = 0; w = 1 }
  o[0] = 1 - 2 * (y * y + z * z); o[1] = 2 * (x * y + w * z); o[2] = 2 * (x * z - w * y); o[3] = 0
  o[4] = 2 * (x * y - w * z); o[5] = 1 - 2 * (x * x + z * z); o[6] = 2 * (y * z + w * x); o[7] = 0
  o[8] = 2 * (x * z + w * y); o[9] = 2 * (y * z - w * x); o[10] = 1 - 2 * (x * x + y * y); o[11] = 0
  o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1
  return o
}
/** 真旋转 + 平移 → 四元数 q（[x,y,z,w]，归一，w ≥ 0）与平移 t（写进给的数组；Shepperd 法，数值稳）。 */
export function m4ToQT(m, q, t) {
  const r00 = m[0], r11 = m[5], r22 = m[10], tr = r00 + r11 + r22
  let x, y, z, w
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s } else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (m[6] - m[9]) / s; x = s / 4; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s } else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (m[8] - m[2]) / s; x = (m[4] + m[1]) / s; y = s / 4; z = (m[9] + m[6]) / s } else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = s / 4 }
  const n = Math.sqrt(x * x + y * y + z * z + w * w) * (w < 0 ? -1 : 1)
  q[0] = x / n; q[1] = y / n; q[2] = z / n; q[3] = w / n
  if (t) { t[0] = m[12]; t[1] = m[13]; t[2] = m[14] }
  return q
}
/** 绕局部 +Z 转 deg 度（过原点）。90° 的整数倍取精确值。 */
export function m4RotZ(o, deg) {
  const r = ((deg % 360) + 360) % 360
  let c, s
  // 与 assembly.mjs 的 rotAxis 同一写法（deg * π / 180，不先算 π/180）：同一滚转两边逐位相同
  if (r === 0) { c = 1; s = 0 } else if (r === 90) { c = 0; s = 1 } else if (r === 180) { c = -1; s = 0 } else if (r === 270) { c = 0; s = -1 } else { const t = deg * Math.PI / 180; c = Math.cos(t); s = Math.sin(t) }
  m4Ident(o)
  o[0] = c; o[1] = s; o[4] = -s; o[5] = c
  return o
}
/** 以 z = sz·n、x = up 去掉 z 分量（退化取 X / Y）建系，原点 p（与 assembly.mjs 的 frameZX 同式）。 */
export function frameZX(o, p, n, up, sz) {
  let zx = n[0] * sz, zy = n[1] * sz, zz = n[2] * sz
  const zl = Math.sqrt(zx * zx + zy * zy + zz * zz)
  if (!(zl > 0)) { m4Ident(o); o[12] = p[0]; o[13] = p[1]; o[14] = p[2]; return false }
  zx /= zl; zy /= zl; zz /= zl
  let k = up[0] * zx + up[1] * zy + up[2] * zz
  let xx = up[0] - k * zx, xy = up[1] - k * zy, xz = up[2] - k * zz, xl = Math.sqrt(xx * xx + xy * xy + xz * xz)
  if (!(xl > 1e-9)) {
    const ax = Math.abs(zx) < 0.9 ? 1 : 0, ay = 1 - ax
    k = ax * zx + ay * zy; xx = ax - k * zx; xy = ay - k * zy; xz = -k * zz; xl = Math.sqrt(xx * xx + xy * xy + xz * xz)
  }
  xx /= xl; xy /= xl; xz /= xl
  o[0] = xx; o[1] = xy; o[2] = xz; o[3] = 0
  o[4] = zy * xz - zz * xy; o[5] = zz * xx - zx * xz; o[6] = zx * xy - zy * xx; o[7] = 0
  o[8] = zx; o[9] = zy; o[10] = zz; o[11] = 0
  o[12] = p[0]; o[13] = p[1]; o[14] = p[2]; o[15] = 1
  return true
}
/** 插座系（z = 朝外法向 n、x = up）。写 o，返回 o。 */
export function socketFrame(o, s) { frameZX(o, s.pos, s.n, s.up, 1); return o }
/** 子件 mount 插座系（z = −n：指向本件内部）。写 o，返回 o。 */
export function mountFrame(o, s) { frameZX(o, s.pos, s.n, s.up, -1); return o }
const UV_ = new Float64Array(2)
/** 面系（面内坐标 (u, v)；与 assembly.mjs 的 faceFrameAt 同式）：平面 z = n、x = u、y = v；柱面 z = 径向、x = 轴、y = z × x。 */
export function faceFrame(o, f, u, v) { UV_[0] = u; UV_[1] = v; return faceFrameUV(o, f, UV_) }
/** faceFrame 的数组形式：uv 从数组读（热路径：双精度不经实参传）。 */
export function faceFrameUV(o, f, uv) {
  const u = uv[0], v = uv[1]
  const g = f.origin
  if (f.kind === 'cyl') {
    const a = f.axis, rf = f.ref, r = f.radius, ph = -v / r, c = Math.cos(ph), s = Math.sin(ph)
    const wx = a[1] * rf[2] - a[2] * rf[1], wy = a[2] * rf[0] - a[0] * rf[2], wz = a[0] * rf[1] - a[1] * rf[0]
    const rx = c * rf[0] + s * wx, ry = c * rf[1] + s * wy, rz = c * rf[2] + s * wz
    o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = 0
    o[4] = ry * a[2] - rz * a[1]; o[5] = rz * a[0] - rx * a[2]; o[6] = rx * a[1] - ry * a[0]; o[7] = 0
    o[8] = rx; o[9] = ry; o[10] = rz; o[11] = 0
    o[12] = g[0] + a[0] * u + rx * r; o[13] = g[1] + a[1] * u + ry * r; o[14] = g[2] + a[2] * u + rz * r
  } else {
    const fu = f.u, fv = f.v, n = f.n
    o[0] = fu[0]; o[1] = fu[1]; o[2] = fu[2]; o[3] = 0
    o[4] = fv[0]; o[5] = fv[1]; o[6] = fv[2]; o[7] = 0
    o[8] = n[0]; o[9] = n[1]; o[10] = n[2]; o[11] = 0
    o[12] = g[0] + fu[0] * u + fv[0] * v; o[13] = g[1] + fu[1] * u + fv[1] * v; o[14] = g[2] + fu[2] * u + fv[2] * v
  }
  o[15] = 1
  return o
}
/** 局部镜面 → 法向所在轴下标（'yz' 0、'xz' 1、'xy' 2；其它 −1）。 */
export const planeAxis = (plane) => (plane === 'yz' ? 0 : plane === 'xz' ? 1 : plane === 'xy' ? 2 : -1)

// ───────────────────────────── 面：推断 / 夹紧 / 反算 / 命中判据 ─────────────────────────────

/**
 * 面内推断（零分配）：离 (u, v) 最近、屏幕距离在 rPx 内的推断点——平面：角点 / 边中点 / 面心（按距离取最近）；
 * 柱面：轴向取 0（面心 = 轴向中线）或 ±halfU（端线），弧向 v 取 0（参考母线）。
 * 推断点都不中时（只平面）：linePx > 0 → 离中线（u = 0 / v = 0）或边线（u = ±halfU / v = ±halfV）linePx 内的那一向吸到线上
 * （SketchUp 的「在轴上 / 在边上」），另一向照网格；都不中时 gridStep > 0 按面心起算的绝对网格取整。
 * 结果写 out.u / out.v / out.kind（INFER）；吸到线上时 out.gu = 1（u 吸在线上）/ out.gv = 1（v 吸在线上），否则 0（引导线据此画）。
 * pxPerM：命中处每米的屏幕像素。热路径请用 faceInferIO（输入也从 io 读：双精度不经实参传，未内联的调用不装箱）。
 * shortPx（可选）：该面在屏上的短边像素——给了就把推断半径随面的屏上尺寸收小：推断点 min(rPx, 0.12·shortPx)、
 * 推断线 min(linePx, 0.08·shortPx)（小面拉远时吸附圈不再盖住大半个面）；不给行为不变。
 */
export function faceInfer(face, u, v, pxPerM, rPx, gridStep, out, linePx = 0, shortPx) {
  out.u = u; out.v = v; out.ppm = pxPerM
  return faceInferIO(face, out, rPx, gridStep, linePx, shortPx)
}
/**
 * faceInfer 的 IO 形式：读 io.u / io.v / io.ppm（每米像素），写回 io.u / io.v / io.kind（/ io.gu / io.gv）。
 * shortPx 热路径请传整数像素（Smi，Math.round 过）：双精度实参在未内联的调用里会装箱。
 */
export function faceInferIO(face, io, rPx, gridStep, linePx = 0, shortPx) {
  const u = io.u, v = io.v, ppm = io.ppm
  const sp = typeof shortPx === 'number' && shortPx > 0 ? shortPx : 0
  // 半径只在双精度之间合流（Smi 实参与算出来的双精度在同一个变量里合流会退回带标记表示、装箱）
  let rM = ppm > 0 ? rPx / ppm : 0
  if (sp > 0 && ppm > 0 && 0.12 * sp < rPx) rM = 0.12 * sp / ppm
  const hu = face.halfU, hv = face.halfV
  io.gu = 0; io.gv = 0
  // 结果一律直接写 io（不让「原值 / 推断值」在分支间汇合成一个变量：汇合点会退回通用表示、写入时装箱）
  if (face.kind === 'cyl') {
    const du0 = Math.abs(u), dU = Math.abs(du0 - hu)
    let kind = INFER.FREE
    if (du0 <= rM && du0 <= dU) { io.u = 0; kind = INFER.CENTER } else if (dU <= rM) { io.u = u < 0 ? -hu : hu; kind = INFER.EDGE } else if (gridStep > 0) { io.u = Math.round(Math.round(u / gridStep) * gridStep * 1e9) / 1e9 + 0; kind = INFER.GRID }
    if (Math.abs(v) <= rM) io.v = 0
    else if (gridStep > 0) { io.v = Math.round(Math.round(v / gridStep) * gridStep * 1e9) / 1e9 + 0; if (kind === INFER.FREE) kind = INFER.GRID }
    io.kind = kind
    return io
  }
  // 候选编号：0–3 角点（i&1 → +u、i&2 → +v）、4–7 边中点（+u / −u / +v / −v）、8 面心
  let best = -1, bd = rM * rM
  for (let i = 0; i < 4; i++) {
    const du = (i & 1 ? hu : -hu) - u, dv = (i & 2 ? hv : -hv) - v, d2 = du * du + dv * dv
    if (d2 <= bd) { bd = d2; best = i }
  }
  for (let i = 0; i < 4; i++) {
    const du = (i === 0 ? hu : i === 1 ? -hu : 0) - u, dv = (i === 2 ? hv : i === 3 ? -hv : 0) - v, d2 = du * du + dv * dv
    if (d2 < bd) { bd = d2; best = 4 + i }
  }
  if (u * u + v * v < bd) best = 8
  if (best >= 8) { io.u = 0; io.v = 0; io.kind = INFER.CENTER } else if (best >= 4) {
    io.u = best === 4 ? hu : best === 5 ? -hu : 0
    io.v = best === 6 ? hv : best === 7 ? -hv : 0
    io.kind = INFER.EDGE
  } else if (best >= 0) {
    io.u = best & 1 ? hu : -hu
    io.v = best & 2 ? hv : -hv
    io.kind = INFER.CORNER
  } else {
    // 推断线：每一向各自看离中线 / 边线够不够近（中线优先：面很窄时两者都近）；吸住的那一向写线值，没吸住的照网格
    let rL = ppm > 0 && linePx > 0 ? linePx / ppm : -1
    if (rL > 0 && sp > 0 && 0.08 * sp < linePx) rL = 0.08 * sp / ppm
    const au = Math.abs(u), av = Math.abs(v)
    let lu = 0, lv = 0   // 0 没吸、1 中线、2 边线
    if (au <= rL) lu = 1; else if (Math.abs(au - hu) <= rL) lu = 2
    if (av <= rL) lv = 1; else if (Math.abs(av - hv) <= rL) lv = 2
    if (lu === 1) io.u = 0; else if (lu === 2) io.u = u < 0 ? -hu : hu
    else if (gridStep > 0) io.u = Math.round(Math.round(u / gridStep) * gridStep * 1e9) / 1e9 + 0
    if (lv === 1) io.v = 0; else if (lv === 2) io.v = v < 0 ? -hv : hv
    else if (gridStep > 0) io.v = Math.round(Math.round(v / gridStep) * gridStep * 1e9) / 1e9 + 0
    if (lu || lv) {
      io.gu = lu ? 1 : 0; io.gv = lv ? 1 : 0
      io.kind = lu === 1 || lv === 1 ? INFER.CLINE : INFER.ELINE
    } else io.kind = gridStep > 0 ? INFER.GRID : INFER.FREE
  }
  return io
}

/**
 * 柱面是不是整圆（弧向可回绕）：面带 full 标记就用它，否则按 |2·halfV − 2πr| < 1e-6·r 现判（局部弧：机身蒙皮四段 ±45–49°）。
 * 平面 / 非柱面 false。零分配。
 */
export function isFullCyl(face) {
  if (!face || face.kind !== 'cyl') return false
  if (face.full === true) return true
  if (face.full === false) return false
  const r = face.radius
  return Math.abs(2 * face.halfV - 2 * Math.PI * r) < 1e-6 * r
}
/**
 * 把 (u, v) 夹进面内（平面：|u| ≤ halfU、|v| ≤ halfV；柱面：u 夹轴向，整圆 v 按周长回绕到 (−πr, πr]、局部弧 v 夹进 ±halfV
 * ——局部弧回绕会让件越过弧端瞬移到对侧）。写 out.u / out.v。
 */
export function clampToFace(face, u, v, out) {
  out.u = u; out.v = v
  return clampIO(face, out)
}
/** clampToFace 的 IO 形式：读写 io.u / io.v（热路径用，双精度不经实参传）。 */
export function clampIO(face, io) {
  const u = io.u, v = io.v
  const hu = face.halfU, hv = face.halfV
  if (u < -hu) io.u = -hu; else if (u > hu) io.u = hu
  if (face.kind === 'cyl' && isFullCyl(face)) {
    const P = 2 * hv
    if (P > 0) { const w = ((v + hv) % P + P) % P - hv; io.v = w === -hv ? hv : w }
  } else if (v < -hv) io.v = -hv; else if (v > hv) io.v = hv
  return io
}

/**
 * 自动网格步长（米）：锚面短边 / 20，向下取 1-2-5 档（GRID_STEPS，夹在 1 mm–1 m）。ref = 面（平面短边 = 2·min(halfU, halfV)；
 * 柱面 = min(2·halfU, 弧长 2·halfV)）或直接给尺度（米：socket 件 / 法向偏移用锚面短边，无面时父件包围盒短边）。
 * 给不出正尺度时返回 SNAP_DEFAULTS.move。零分配（只返回标量）。
 */
export function autoGridStep(ref) {
  let s = 0
  if (typeof ref === 'number') s = ref
  else if (ref && typeof ref === 'object') s = ref.kind === 'cyl' ? Math.min(2 * ref.halfU, 2 * ref.halfV) : 2 * Math.min(ref.halfU, ref.halfV)
  if (!(s > 0) || !Number.isFinite(s)) return SNAP_DEFAULTS.move
  const t = s / 20
  let best = GRID_STEPS[0]
  for (let i = 0; i < GRID_STEPS.length; i++) if (GRID_STEPS[i] <= t * (1 + 1e-9)) best = GRID_STEPS[i]
  return best
}
/** 平移步长设置 → 米：'auto' 走 autoGridStep(ref)，数值原样（非正 / 非数 → 0 = 不吸网格）。 */
export function resolveMoveStep(move, ref) {
  if (move === 'auto') return autoGridStep(ref)
  return typeof move === 'number' && move > 0 ? move : 0
}

/**
 * 点 → 面坐标（零分配）：F = 面在 uv = (0, 0) 处的面系（本体系列主序 4×4，= 件位姿 · faceFrame(f, 0, 0)）。
 * 写 out.u / out.v 与 out.d（离面 / 柱面的法向距离，外正内负）。柱面 v = r·atan2(p·y, p·z + r)（与 faceFrame 的弧长方向一致）。
 */
export function uvOnFace(face, F, px, py, pz, out) {
  return uvOnFaceAt(face, F, px - F[12], py - F[13], pz - F[14], out)
}
/** uvOnFace 的数组形式：点 p 从类型数组 / 数组读（热路径：双精度不经实参传）。 */
export function uvOnFaceP(face, F, p, out) {
  return uvOnFaceAt(face, F, p[0] - F[12], p[1] - F[13], p[2] - F[14], out)
}
function uvOnFaceAt(face, F, dx, dy, dz, out) {
  const lx = F[0] * dx + F[1] * dy + F[2] * dz, ly = F[4] * dx + F[5] * dy + F[6] * dz, lz = F[8] * dx + F[9] * dy + F[10] * dz
  if (face.kind === 'cyl') {
    const r = face.radius, zc = lz + r
    out.u = lx
    out.v = r * Math.atan2(ly, zc)
    out.d = Math.sqrt(ly * ly + zc * zc) - r
  } else { out.u = lx; out.v = ly; out.d = lz }
  return out
}

/**
 * 命中点落在哪个面上（零分配；CONTRACT §5.4-B-2 判据）：p / n = 本体系命中点与法向（法向朝射线来处），M = 件位姿。
 *   平面：法向点积 ≥ 0.95、离面 −tol ≤ d ≤ tol + skin、面内 |u| ≤ 1.05·halfU + tol 且 |v| ≤ 1.05·halfV + tol；
 *   柱面：离轴 − r 同上、轴向 ≤ 1.05·halfU + tol、法向与径向点积 ≥ 0.95。
 *   skin（out.skin，缺省 0）= 面外侧允许的蒙皮厚度：可贴面定义在结构面上，而看得见、射线打得到的往往是离面几厘米的
 *   包覆层（平台体 MLI 离结构面 mliOffM、散热面离 4 mm）——只按 ±tol 判，打在 MLI 上的点一律认不出面。
 * 多个满足取离面最近的；写 out.u / out.v / out.d（面坐标、离面距离）。tol 不是数时取 out.tol（热路径传法）。
 * @returns {number} faces 下标，没有 −1
 */
export function faceAtHit(faces, M, p, n, tol, out) {
  // 热路径：容差放在 out.tol 里传（双精度不经实参传）；比较里只用 tl
  const tl = typeof tol === 'number' ? tol + 0 : out.tol + 0
  const sk = typeof out.skin === 'number' ? out.skin + 0 : 0
  const dx = p[0] - M[12], dy = p[1] - M[13], dz = p[2] - M[14]
  // 局部 = Rᵀ·(p − t)（位姿是真旋转；派生件先经 mirrorHitToPrimary 映回主件）
  const plx = M[0] * dx + M[1] * dy + M[2] * dz, ply = M[4] * dx + M[5] * dy + M[6] * dz, plz = M[8] * dx + M[9] * dy + M[10] * dz
  const nlx = M[0] * n[0] + M[1] * n[1] + M[2] * n[2], nly = M[4] * n[0] + M[5] * n[1] + M[6] * n[2], nlz = M[8] * n[0] + M[9] * n[1] + M[10] * n[2]
  let best = -1, bd = Infinity, bu = 0, bv = 0, bdd = 0
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i], g = f.origin
    const wx = plx - g[0], wy = ply - g[1], wz = plz - g[2]
    if (f.kind === 'cyl') {
      const a = f.axis, ax = wx * a[0] + wy * a[1] + wz * a[2]
      if (Math.abs(ax) > 1.05 * f.halfU + tl) continue
      const rx = wx - ax * a[0], ry = wy - ax * a[1], rz = wz - ax * a[2], rl = Math.sqrt(rx * rx + ry * ry + rz * rz)
      if (!(rl > 0)) continue
      const d = rl - f.radius
      if (d < -tl || d > tl + sk) continue
      if ((nlx * rx + nly * ry + nlz * rz) / rl < 0.95) continue
      const rf = f.ref, cx = a[1] * rf[2] - a[2] * rf[1], cy = a[2] * rf[0] - a[0] * rf[2], cz = a[0] * rf[1] - a[1] * rf[0]
      const ph = Math.atan2(rx * cx + ry * cy + rz * cz, rx * rf[0] + ry * rf[1] + rz * rf[2])
      if (Math.abs(d) < bd) { bd = Math.abs(d); best = i; bu = ax; bv = -f.radius * ph; bdd = d }
    } else {
      const fn = f.n
      if (nlx * fn[0] + nly * fn[1] + nlz * fn[2] < 0.95) continue
      const d = wx * fn[0] + wy * fn[1] + wz * fn[2]
      if (d < -tl || d > tl + sk) continue
      const u = wx * f.u[0] + wy * f.u[1] + wz * f.u[2], v = wx * f.v[0] + wy * f.v[1] + wz * f.v[2]
      if (Math.abs(u) > 1.05 * f.halfU + tl || Math.abs(v) > 1.05 * f.halfV + tl) continue
      if (Math.abs(d) < bd) { bd = Math.abs(d); best = i; bu = u; bv = v; bdd = d }
    }
  }
  if (best >= 0) { out.u = bu === 0 ? 0 : bu; out.v = bv === 0 ? 0 : bv; out.d = bdd }
  return best
}

/**
 * 面的「磁吸」（零分配；指针没打中任何件时找离指针最近的可贴面用）：射线 ray（本体系，Float64Array 6 元 [ox,oy,oz,dx,dy,dz]，
 * 方向不必归一）与件 M（渲染矩阵，列主序；可含镜像 —— 正交阵的逆仍是转置）上平面面 face 所在平面求交，交点夹进面内。
 * 面须朝向射线来处（射线逆着朝外法向走）且交点在射线前方。写 io.u / io.v（面坐标 = 件局部系里的面坐标：派生件按渲染矩阵算出来的
 * 就是主件的面坐标）、io.x / io.y / io.z（夹紧后那一点的本体系坐标）与 io.c（交点落在面外、被夹紧过 = 1，否则 0）。柱面不参与。
 * 磁吸只认 io.c = 1 的「近失」：交点在面内而射线没打中这个面，说明面被别的件挡着（反射面后面的平台面），不能吸过去。
 * @returns {boolean} 有这样的点
 */
export function faceMagnetIO(face, M, ray, io) {
  if (face.kind === 'cyl') return false
  const dx = ray[0] - M[12], dy = ray[1] - M[13], dz = ray[2] - M[14]
  // 局部 = Rᵀ·(o − t)；方向 = Rᵀ·d（M 的三列正交，镜像也一样）
  const ox = M[0] * dx + M[1] * dy + M[2] * dz, oy = M[4] * dx + M[5] * dy + M[6] * dz, oz = M[8] * dx + M[9] * dy + M[10] * dz
  const rx = ray[3], ry = ray[4], rz = ray[5]
  const lx = M[0] * rx + M[1] * ry + M[2] * rz, ly = M[4] * rx + M[5] * ry + M[6] * rz, lz = M[8] * rx + M[9] * ry + M[10] * rz
  const n = face.n, g = face.origin, fu = face.u, fv = face.v
  const den = lx * n[0] + ly * n[1] + lz * n[2]
  if (!(den < -1e-12)) return false
  const t = ((g[0] - ox) * n[0] + (g[1] - oy) * n[1] + (g[2] - oz) * n[2]) / den
  if (!(t > 0)) return false
  const px = ox + t * lx - g[0], py = oy + t * ly - g[1], pz = oz + t * lz - g[2]
  let u = px * fu[0] + py * fu[1] + pz * fu[2], v = px * fv[0] + py * fv[1] + pz * fv[2]
  const hu = face.halfU, hv = face.halfV
  let c = 0
  if (u < -hu) { u = -hu; c = 1 } else if (u > hu) { u = hu; c = 1 }
  if (v < -hv) { v = -hv; c = 1 } else if (v > hv) { v = hv; c = 1 }
  io.u = u + 0; io.v = v + 0; io.c = c
  const qx = g[0] + u * fu[0] + v * fv[0], qy = g[1] + u * fu[1] + v * fv[1], qz = g[2] + u * fu[2] + v * fv[2]
  io.x = M[0] * qx + M[4] * qy + M[8] * qz + M[12]
  io.y = M[1] * qx + M[5] * qy + M[9] * qz + M[13]
  io.z = M[2] * qx + M[6] * qy + M[10] * qz + M[14]
  return true
}

// ───────────────────────────── 对称 ─────────────────────────────

/**
 * 功能区对称档 → 文档 sym（null = 无）：'mirrorXZ' / 'mirrorYZ' → {op}；'radial' → {op, n（2–8 取整夹紧）, axis（飞机 +X，其余 +Z）}。
 */
export function symFromUi(op, n, domain) {
  if (op === 'mirrorXZ' || op === 'mirrorYZ') return { op }
  if (op === 'radial') {
    const k = Math.round(Number(n))
    return { op: 'radial', n: Number.isFinite(k) ? Math.min(8, Math.max(2, k)) : 2, axis: domain === 'aircraft' ? '+X' : '+Z' }
  }
  return null
}

/** onSymLocus 的相对容差：几何中心离对称面 / 轴的距离小于该方向半宽的这个比例（且不小于 1 μm）算「在面 / 轴上」。 */
export const SYM_LOCUS_REL = 0.02
/**
 * 对称副本与原件重合（件的几何落在对称面 / 对称轴上）：按几何判、不按原点——主件局部包围盒（box6 从 off 起的 6 元）的中心经本体系位姿 m
 * 变到本体系，镜像 XZ 看 |y|、镜像 YZ 看 |x|、径向看离轴距离，小于 max(1 μm, 该方向半宽 × SYM_LOCUS_REL) 算重合（KSP 堆叠节点口径：
 * 这样的件带对称，副本压在原件上，屏上看不出、质量与入库几何却多一份）。
 * 机翼、太阳翼这类从中线插座往外长的单侧件，原点在对称面上、几何却整个在一侧：镜像副本不与原件重合，照常对称。
 * 钩子件（镜像参数重生成）同样按主件自己的包围盒判：钩子给的几何 = 关于局部镜面的镜像（assembly.mjs 文件头），派生件的世界几何仍是主件的镜像。
 * sym = {op, axis?}；m = 件的本体系位姿（列主序 16 元）；box6 缺省（给不出几何）按原点判（半宽 0）。零分配。
 */
export function onSymLocus(sym, m, box6, off = 0) {
  if (!sym || !m) return false
  let cx = m[12], cy = m[13], cz = m[14], ex = 0, ey = 0, ez = 0
  if (box6 && box6[off] <= box6[off + 3] && box6[off + 1] <= box6[off + 4] && box6[off + 2] <= box6[off + 5]) {
    const lx = (box6[off] + box6[off + 3]) / 2, ly = (box6[off + 1] + box6[off + 4]) / 2, lz = (box6[off + 2] + box6[off + 5]) / 2
    const hx = (box6[off + 3] - box6[off]) / 2, hy = (box6[off + 4] - box6[off + 1]) / 2, hz = (box6[off + 5] - box6[off + 2]) / 2
    cx = m[0] * lx + m[4] * ly + m[8] * lz + m[12]
    cy = m[1] * lx + m[5] * ly + m[9] * lz + m[13]
    cz = m[2] * lx + m[6] * ly + m[10] * lz + m[14]
    ex = Math.abs(m[0]) * hx + Math.abs(m[4]) * hy + Math.abs(m[8]) * hz
    ey = Math.abs(m[1]) * hx + Math.abs(m[5]) * hy + Math.abs(m[9]) * hz
    ez = Math.abs(m[2]) * hx + Math.abs(m[6]) * hy + Math.abs(m[10]) * hz
  }
  const E = 1e-6, K = SYM_LOCUS_REL
  if (sym.op === 'mirrorXZ') return Math.abs(cy) < (K * ey > E ? K * ey : E)
  if (sym.op === 'mirrorYZ') return Math.abs(cx) < (K * ex > E ? K * ex : E)
  if (sym.op !== 'radial') return false
  const ax = sym.axis && sym.axis[1] === 'X' ? 0 : sym.axis && sym.axis[1] === 'Y' ? 1 : 2
  const a = ax === 0 ? cy : cx, b = ax === 2 ? cy : cz, ea = ax === 0 ? ey : ex, eb = ax === 2 ? ey : ez
  const tol = K * Math.sqrt(ea * ea + eb * eb)
  return a * a + b * b < (tol > E ? tol * tol : E * E)
}

/**
 * 派生件上的命中（点 p、法向 n，本体系）映回主件（零分配）：派生件渲染矩阵 G = derivedM 把 plane 对应的列取反（镜像件；径向 plane 为 null 不取反）
 * = T·M_主，于是主件上的对应点 = M_主 · G⁻¹ · p，法向同理（只转不移）。写 outP / outN（可与 p / n 同一数组）。
 */
export function mirrorHitToPrimary(derivedM, primaryM, plane, p, n, outP, outN) {
  const ax = planeAxis(plane)
  // G⁻¹ = [Rgᵀ, −Rgᵀ·t]（Rg 正交，含镜像）；G 的第 ax 列取反 = 局部坐标的第 ax 个分量取反
  const dx = p[0] - derivedM[12], dy = p[1] - derivedM[13], dz = p[2] - derivedM[14]
  let lx = derivedM[0] * dx + derivedM[1] * dy + derivedM[2] * dz
  let ly = derivedM[4] * dx + derivedM[5] * dy + derivedM[6] * dz
  let lz = derivedM[8] * dx + derivedM[9] * dy + derivedM[10] * dz
  let mx = derivedM[0] * n[0] + derivedM[1] * n[1] + derivedM[2] * n[2]
  let my = derivedM[4] * n[0] + derivedM[5] * n[1] + derivedM[6] * n[2]
  let mz = derivedM[8] * n[0] + derivedM[9] * n[1] + derivedM[10] * n[2]
  if (ax === 0) { lx = -lx; mx = -mx } else if (ax === 1) { ly = -ly; my = -my } else if (ax === 2) { lz = -lz; mz = -mz }
  const P = primaryM
  const ox = P[0] * lx + P[4] * ly + P[8] * lz + P[12], oy = P[1] * lx + P[5] * ly + P[9] * lz + P[13], oz = P[2] * lx + P[6] * ly + P[10] * lz + P[14]
  const nx = P[0] * mx + P[4] * my + P[8] * mz, ny = P[1] * mx + P[5] * my + P[9] * mz, nz = P[2] * mx + P[6] * my + P[10] * mz
  outP[0] = ox; outP[1] = oy; outP[2] = oz
  outN[0] = nx; outN[1] = ny; outN[2] = nz
}

// ───────────────────────────── 包围盒 ─────────────────────────────

/** 局部 AABB（6 元 [minx,miny,minz,maxx,maxy,maxz]，从 off6 起）× 列主序矩阵（从 offM 起）→ 外包 AABB（写 out 从 offO 起）。空盒（min > max）写空盒。 */
export function boxXform(box, off6, m, offM, out, offO) {
  const x0 = box[off6], y0 = box[off6 + 1], z0_ = box[off6 + 2], x1 = box[off6 + 3], y1 = box[off6 + 4], z1 = box[off6 + 5]
  if (!(x0 <= x1 && y0 <= y1 && z0_ <= z1)) { out[offO] = Infinity; out[offO + 1] = Infinity; out[offO + 2] = Infinity; out[offO + 3] = -Infinity; out[offO + 4] = -Infinity; out[offO + 5] = -Infinity; return false }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0_ + z1) / 2, ex = (x1 - x0) / 2, ey = (y1 - y0) / 2, ez = (z1 - z0_) / 2
  for (let r = 0; r < 3; r++) {
    const a = m[offM + r], b = m[offM + 4 + r], c = m[offM + 8 + r]
    const w = a * cx + b * cy + c * cz + m[offM + 12 + r]
    const e = Math.abs(a) * ex + Math.abs(b) * ey + Math.abs(c) * ez
    out[offO + r] = w - e; out[offO + 3 + r] = w + e
  }
  return true
}
/** 各件局部 AABB（Float64Array 6n）× 矩阵（Float64Array 16n）→ 本体系外包（out6；一件都没有写全 0）。拖动中包围盒读数用，零分配。 */
export function liveBox(boxes, mats, n, out6) {
  let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity
  for (let i = 0; i < n; i++) {
    if (!boxXform(boxes, 6 * i, mats, 16 * i, out6, 0)) continue
    if (out6[0] < a0) a0 = out6[0]; if (out6[1] < a1) a1 = out6[1]; if (out6[2] < a2) a2 = out6[2]
    if (out6[3] > b0) b0 = out6[3]; if (out6[4] > b1) b1 = out6[4]; if (out6[5] > b2) b2 = out6[5]
  }
  if (a0 > b0) { out6[0] = out6[1] = out6[2] = out6[3] = out6[4] = out6[5] = 0; return out6 }
  out6[0] = a0; out6[1] = a1; out6[2] = a2; out6[3] = b0; out6[4] = b1; out6[5] = b2
  return out6
}
/** 宽相：本体系 AABB（Float64Array 6n）两两相交（严格重叠超过 1e-9）的候选对 [[i, j]…]（i < j），skip(i, j) 为真的跳过。松手时用，允许分配。 */
export function aabbPairs(boxes, n, skip) {
  const out = []
  const E = 1e-9
  for (let i = 0; i < n; i++) {
    const o = 6 * i
    if (!(boxes[o] <= boxes[o + 3])) continue
    for (let j = i + 1; j < n; j++) {
      const q = 6 * j
      if (!(boxes[q] <= boxes[q + 3])) continue
      if (boxes[o] > boxes[q + 3] - E || boxes[q] > boxes[o + 3] - E) continue
      if (boxes[o + 1] > boxes[q + 4] - E || boxes[q + 1] > boxes[o + 4] - E) continue
      if (boxes[o + 2] > boxes[q + 5] - E || boxes[q + 2] > boxes[o + 5] - E) continue
      if (skip && skip(i, j)) continue
      out.push([i, j])
    }
  }
  return out
}

// ───────────────────────────── 质量合成（拖动预览）─────────────────────────────

/**
 * 刚体质量合成（零分配）：静态部分 a0 + 一组「局部质量特性 a1」按 n 个矩阵各放一份，写 out。
 * a0 / a1 / out 都是 13 元：[m, cx, cy, cz, I00, I01, I02, I10, I11, I12, I20, I21, I22]（质心 + 对自身质心的惯量，行主序）；
 * a0 在本体系，a1 在件局部系（质心、惯量都相对件原点 / 件轴）；mats = 列主序 16n（本体系位姿，可含镜像：惯量按 R·I·Rᵀ 转，
 * 对反射同样成立）。out 的质心 / 惯量在本体系、对合质心（与 assembly.combineMass 同口径；总质量 0 时全 0）。
 * 拖动预览用：静态部分只算一次（combineMass 缓存命中），拖动件的质量元不随位姿变——换父件不必让 combineMass 重建整份计划。
 */
export function massCombine(a0, a1, mats, n, out) {
  const m0 = a0[0], m1 = a1[0]
  let M = m0, sx = m0 * a0[1], sy = m0 * a0[2], sz = m0 * a0[3]
  for (let k = 0; k < n; k++) {
    const o = 16 * k, x = a1[1], y = a1[2], z = a1[3]
    const wx = mats[o] * x + mats[o + 4] * y + mats[o + 8] * z + mats[o + 12]
    const wy = mats[o + 1] * x + mats[o + 5] * y + mats[o + 9] * z + mats[o + 13]
    const wz = mats[o + 2] * x + mats[o + 6] * y + mats[o + 10] * z + mats[o + 14]
    M += m1; sx += m1 * wx; sy += m1 * wy; sz += m1 * wz
  }
  if (!(M > 0)) { for (let i = 0; i < 13; i++) out[i] = 0; return out }
  const cx = sx / M, cy = sy / M, cz = sz / M
  // 静态部分：自身惯量 + 平行轴
  let dx = a0[1] - cx, dy = a0[2] - cy, dz = a0[3] - cz, d2 = dx * dx + dy * dy + dz * dz
  let i00 = a0[4] + m0 * (d2 - dx * dx), i01 = a0[5] - m0 * dx * dy, i02 = a0[6] - m0 * dx * dz
  let i11 = a0[8] + m0 * (d2 - dy * dy), i12 = a0[9] - m0 * dy * dz, i22 = a0[12] + m0 * (d2 - dz * dz)
  for (let k = 0; k < n; k++) {
    const o = 16 * k, x = a1[1], y = a1[2], z = a1[3]
    dx = mats[o] * x + mats[o + 4] * y + mats[o + 8] * z + mats[o + 12] - cx
    dy = mats[o + 1] * x + mats[o + 5] * y + mats[o + 9] * z + mats[o + 13] - cy
    dz = mats[o + 2] * x + mats[o + 6] * y + mats[o + 10] * z + mats[o + 14] - cz
    d2 = dx * dx + dy * dy + dz * dz
    // R·I1·Rᵀ（R 的 (r, c) 元 = mats[o + r + 4c]），只算上三角
    for (let r = 0; r < 3; r++) {
      for (let c = r; c < 3; c++) {
        let sum = 0
        for (let a = 0; a < 3; a++) {
          const Rra = mats[o + r + 4 * a]
          if (Rra === 0) continue
          for (let b = 0; b < 3; b++) sum += Rra * a1[4 + 3 * a + b] * mats[o + c + 4 * b]
        }
        if (r === 0) { if (c === 0) i00 += sum; else if (c === 1) i01 += sum; else i02 += sum } else if (r === 1) { if (c === 1) i11 += sum; else i12 += sum } else i22 += sum
      }
    }
    i00 += m1 * (d2 - dx * dx); i01 -= m1 * dx * dy; i02 -= m1 * dx * dz
    i11 += m1 * (d2 - dy * dy); i12 -= m1 * dy * dz; i22 += m1 * (d2 - dz * dz)
  }
  out[0] = M; out[1] = cx + 0; out[2] = cy + 0; out[3] = cz + 0
  out[4] = i00 + 0; out[5] = i01 + 0; out[6] = i02 + 0; out[7] = i01 + 0; out[8] = i11 + 0; out[9] = i12 + 0; out[10] = i02 + 0; out[11] = i12 + 0; out[12] = i22 + 0
  return out
}
/** combineMass 的结果（{massKg, comBody, inertiaBody}）→ 13 元数组（写 out）。 */
export function massPack(cm, out) {
  out[0] = cm.massKg || 0
  const c = cm.comBody, I = cm.inertiaBody
  out[1] = c[0]; out[2] = c[1]; out[3] = c[2]
  for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) out[4 + 3 * r + k] = I[r][k]
  return out
}

// ───────────────────────────── 文档查询 ─────────────────────────────

/**
 * 发给 UI 的文档快照冻结（就地冻结并返回）：对象 / 对象数组冻结，★ 纯数字数组（t / q / uv …）不冻结。
 * 冻结数组的元素类型是 PACKED_FROZEN（通用标记型）：这种快照一旦被喂进 assembly.mjs 的热函数（fromQT / faceFrameAt / quatOk …），
 * 同一批读取点就混进了两种元素类型，优化后的代码从此把读出来的双精度装箱，编辑器拖动热路径每帧都在分配（100 件 ~25 KB/帧）。
 * 约定仍是冻结快照不进热函数（属性面板位姿走编辑器 poseOf）；数字数组不冻结是第二道保险（单测量过：混喂也不涨分配）。
 */
export function freezeDoc(o) {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o
  if (Array.isArray(o) && o.every((x) => typeof x === 'number')) return o
  Object.freeze(o)
  for (const k of Object.keys(o)) freezeDoc(o[k])
  return o
}

/** 展开 id（`c3~1`）→ 主件 id（`c3`）。 */
export const primaryIdOf = (id) => { const s = String(id); const k = s.indexOf('~'); return k < 0 ? s : s.slice(0, k) }
const compsOf = (doc) => (isObj(doc) && Array.isArray(doc.comps) ? doc.comps : [])
/** id → 组件（找不到 null）。 */
export function compById(doc, id) { for (const c of compsOf(doc)) if (c && c.id === id) return c; return null }
/** 直接子件（按文档顺序）。 */
export function childrenOf(doc, id) { return compsOf(doc).filter((c) => c && c.parent === id) }
/** 子树（先序：自己在前）。成环时每个 id 只出现一次。 */
export function subtreeOf(doc, id) {
  const kids = new Map()
  for (const c of compsOf(doc)) { if (!c || c.parent == null) continue; if (!kids.has(c.parent)) kids.set(c.parent, []); kids.get(c.parent).push(c.id) }
  const out = [], seen = new Set(), st = [id]
  while (st.length) {
    const x = st.pop()
    if (seen.has(x) || !compById(doc, x)) continue
    seen.add(x); out.push(x)
    const k = kids.get(x) || []
    for (let i = k.length - 1; i >= 0; i--) st.push(k[i])
  }
  return out
}
/** 祖先链（父、祖父…，到根；成环截断）。 */
export function ancestorsOf(doc, id) {
  const out = [], seen = new Set([id])
  let c = compById(doc, id)
  while (c && c.parent != null && !seen.has(c.parent)) { out.push(c.parent); seen.add(c.parent); c = compById(doc, c.parent) }
  return out
}
/** 自己或某个祖先带对称（= 在对称子树里：会被展开成派生件）。 */
export function inSymSubtree(doc, id) {
  const c = compById(doc, id)
  if (c && c.sym) return true
  return ancestorsOf(doc, id).some((a) => { const x = compById(doc, a); return !!(x && x.sym) })
}
/** 子树里（含自己）有自带对称的件。 */
export function subtreeHasOwnSym(doc, id) { return subtreeOf(doc, id).some((x) => { const c = compById(doc, x); return !!(c && c.sym) }) }

/** 组件（主件）的插座 / 面 / 缺省参数（与 solvePose 同口径：fillParams 后取；出错按空表）。 */
export function compGeo(comp) {
  const def = comp ? getComponent(comp.type) : null
  if (!def) return { def: null, params: {}, sockets: [], faces: [] }
  const params = fillParams(def, comp.params)
  let sockets = [], faces = []
  try { sockets = def.sockets(params) || [] } catch { sockets = [] }
  try { faces = def.faces(params) || [] } catch { faces = [] }
  return { def, params, sockets, faces }
}
/**
 * 本件拿来贴父件的安装端（attach.mount ‖ def.mountSocket）：普通插座，或 '@<面 id>' / '@bbox±X…'（插座同形对象，见
 * assembly.componentMounts）；找不到 null。
 */
export function mountSocketOf(comp, geo = compGeo(comp)) {
  const id = (comp && comp.attach && comp.attach.mount) || (geo.def ? geo.def.mountSocket : 'root')
  if (typeof id === 'string' && id[0] === '@') return comp ? componentMount(comp.type, comp.params, id) : null
  return geo.sockets.find((s) => s.id === id) || null
}
/** 安装端显示名：插座 → socketLabel；'@<面 id>' → 「面心 <面名>」（faceLabel）；'@bbox+X' → 「包围盒 +X」。 */
export function mountLabel(id) {
  const s = String(id)
  if (s.startsWith('@bbox')) return '包围盒 ' + s.slice(5)
  if (s[0] === '@') return '面心 ' + faceLabel(s.slice(1))
  return socketLabel(s)
}
/** 两个安装端（插座同形）同位同向：位置差 ≤ 1e-9 × 尺度、法向点积 > 1 − 1e-9（滚转零位不比：差的只是滚转起点，Q / E 就能转到）。 */
function samePosN(a, b) {
  const sc = 1e-9 * Math.max(1, Math.abs(b.pos[0]), Math.abs(b.pos[1]), Math.abs(b.pos[2]))
  return Math.abs(a.pos[0] - b.pos[0]) <= sc && Math.abs(a.pos[1] - b.pos[1]) <= sc && Math.abs(a.pos[2] - b.pos[2]) <= sc &&
    a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2] > 1 - 1e-9
}
/**
 * 本件安装端候选（属性面板「安装端」下拉 / 编辑器 B 键循环共用）：assembly.componentMounts（插座 ∪ 平面面心 ∪ 包围盒面心），
 * 位置 + 法向与前面某项重合的去掉（prim.box 的 '+X' 接口、'@+X' 面心、'@bbox+X' 是同一点同一朝向；es.subrefl 的 root 与
 * '@bbox-X' 只差滚转零位）：同组只留最先那项——插座 id 优先，旧文档里的写法不变；件现在用着的安装端（comp.attach.mount）
 * 落在某组里时由它顶替该组的代表（下拉里恒有当前值）。comp 只读 type / params / attach（库拖入的件没有 id 也行）。
 * @returns {{id:string, label:string, kind:'socket'|'face'|'bbox'}[]}
 */
export function mountChoices(comp) {
  if (!comp || !getComponent(comp.type)) return []
  const cur = comp.attach && typeof comp.attach.mount === 'string' ? comp.attach.mount : null
  const list = componentMounts(comp.type, comp.params), kept = []
  for (const m of list) {
    const j = kept.findIndex((k) => samePosN(k, m))
    if (j < 0) kept.push(m)
    else if (m.id === cur) kept[j] = m
  }
  return kept.map((m) => ({ id: m.id, label: mountLabel(m.id), kind: m.id[0] !== '@' ? 'socket' : m.id.startsWith('@bbox') ? 'bbox' : 'face' }))
}
/**
 * 件 comp 贴父件的那一端占着的本件插座 id（非根件；根件 []）：安装端本身是插座 → 它；'@面' / '@bbox' 安装端 → 与它同位同向的
 * 本件插座（prim.box 以 '@+Z' 装上去时，'+Z' 接口同样压在父件上）。自由件按 def.mountSocket 算。
 */
function ownMountIds(comp, geo = compGeo(comp)) {
  if (!comp || comp.parent == null) return []
  const a = comp.attach
  const id = (a && a.mode !== 'free' && a.mount) || (geo.def ? geo.def.mountSocket : 'root')
  if (id[0] !== '@') return [id]
  const ms = componentMount(comp.type, comp.params, id)
  const out = ms ? geo.sockets.filter((s) => samePosN(s, ms)).map((s) => s.id) : []
  out.push(id)
  return out
}
/**
 * 件 comp 自己的安装接口键（非根件；根件 null）：它是件贴父件的那一端，不能再作别的件的落点（自由件也算——模板里的带锚自由件
 * rcs / refl / hinge 的 root / back 以前混进候选，2026-10 诊断 S2）。安装端是 '@面' / '@bbox' 且有同位同向的本件插座时给该插座的键
 * （编辑器拿它比插座候选），否则 `${id}|${安装端 id}`。全部键（插座 + '@' 安装端）见 ownMountKeys。
 */
export function ownMountKey(doc, comp) {
  const ks = ownMountKeys(doc, comp)
  return ks.length ? ks[0] : null
}
/** 件 comp 贴父件那一端占着的全部键 `${id}|…`：安装端插座，或 '@' 安装端连同与它同位同向的本件插座（插座在前）。根件 []。 */
export function ownMountKeys(doc, comp) {
  void doc
  return ownMountIds(comp).map((x) => `${comp.id}|${x}`)
}
/** 插座 s 与平面面 f 重合（位置 < 1e-6 × 面尺度、法向同向）。 */
function sockOnFace(s, f) {
  if (!s || !f || f.kind === 'cyl') return false
  const tol = 1e-6 * Math.max(1e-3, f.halfU, f.halfV)
  const dx = s.pos[0] - f.origin[0], dy = s.pos[1] - f.origin[1], dz = s.pos[2] - f.origin[2]
  return dx * dx + dy * dy + dz * dz < tol * tol && s.n[0] * f.n[0] + s.n[1] * f.n[1] + s.n[2] * f.n[2] > 1 - 1e-9
}
/**
 * 平面面 faceId 的「折叠接口」：与该面面心重合、法向同向、accepts = null 的通用接口（星体 / 方块 / 塔 / 方舱…每个面心都有一个）。
 * 编辑器不把它单列为接口候选，由面心推断代替（滚转步长沿用该接口的 roll 档）；面心推断前查它是否已占。没有 null。
 * geo = compGeo(件) 或任何带 sockets / faces 的对象。
 */
export function foldedSocketOf(geo, faceId) {
  if (!geo) return null
  const f = geo.faces.find((x) => x.id === faceId)
  if (!f || f.kind === 'cyl') return null
  return geo.sockets.find((s) => s.accepts == null && sockOnFace(s, f)) || null
}
/** 插座 sockId 是不是折叠接口（与同件某个平面面心重合的通用接口）。 */
export function isFoldedSocket(geo, sockId) {
  if (!geo) return false
  const s = geo.sockets.find((x) => x.id === sockId)
  return !!s && s.accepts == null && geo.faces.some((f) => sockOnFace(s, f))
}
/**
 * 插座没有「背面」（2026-10-07 落点判定 v3）：拖入 / 拾起时从件的哪一侧看都可选、标记都画。两种：
 *   ① 件没有任何安装面（机翼、平尾、垂尾、短舱、太阳翼、反射面、馈源、推力器…）：这类件多是薄件或功能件，接口贴在它的某一侧
 *      （翼下发动机挂点、反射面前方的焦点），从另一侧指着这一件照样是要装上去——按朝向剔掉就会「指着机翼装不上发动机」；
 *   ② 落在本件某个对称面上、法向沿该对称面法向的横向对齐接口（机身中线上的翼根 / 平尾根、垂尾顶的 T 尾接口）：接口在件的中面里，
 *      按设计服务两侧（另一侧由镜像给出）。
 * 有安装面的件（星体、机身、塔、船体…）其余接口仍按朝向取舍：背面的接口在件的另一侧，指着正面时不该被选中（垂尾不进腹鳍根）。
 * geo = compGeo(件)；s = 该件的插座（局部系）。
 */
export function socketTwoSided(geo, s) {
  if (!geo || !s) return false
  if (!geo.faces || !geo.faces.length) return true
  let planes = geo.def ? geo.def.symmetricPlanes : null
  if (typeof planes === 'function') { try { planes = planes(geo.params) } catch { planes = null } }
  if (!Array.isArray(planes)) return false
  const p = s.pos, n = s.n
  const nl = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
  if (!(nl > 0)) return false
  const sc = 1e-9 * Math.max(1, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))
  for (const pl of planes) {
    const ax = planeAxis(pl)
    if (ax >= 0 && Math.abs(p[ax]) <= sc && Math.abs(n[ax]) / nl > 1 - 1e-9) return true
  }
  return false
}
/**
 * 件 comp 的面 faceId 可否作 type 的安装基面（ComponentDef.mountableFaces + 面级 accepts，见 components/index.mjs faceAccepts）。
 * 机构 / 小件 / 纯外观件（hasMass 关的 prim：模板里的铰座、地球敏感器、导轨、贴片）的面不收件。type 可省（只看组件开关）。
 */
export function faceMountable(comp, faceId, type, geo = compGeo(comp)) {
  if (!geo.def) return false
  const f = geo.faces.find((x) => x.id === faceId)
  return !!f && faceAccepts(geo.def, geo.params, f, type)
}
/**
 * 件 comp 的插座 s 能不能接 type：socketAccepts，且折叠接口所在的面须可安装（面不收件的件，面心接口一并不收）。
 */
export function socketUsable(comp, s, type, geo = compGeo(comp)) {
  if (!socketAccepts(s, type)) return false
  if (s.accepts != null || !geo.def) return true
  const f = geo.faces.find((x) => sockOnFace(s, x))
  return !f || faceAccepts(geo.def, geo.params, f, type)
}
/** 已被占用的插座：Set(`${父 id}|${插座 id}`)（子件 attach.socket 指着的，含自由件的插座锚）；exclude = 不算占用的子件 id 集合。 */
export function usedSocketKeys(doc, exclude) {
  const out = new Set()
  for (const c of compsOf(doc)) {
    if (!c || c.parent == null || (exclude && exclude.has(c.id))) continue
    if (c.attach && typeof c.attach.socket === 'string' && c.attach.socket) out.add(`${c.parent}|${c.attach.socket}`)
  }
  return out
}
/** 件的「生效对称」：自带的，或最近一个带对称的祖先的（子树跟着主件复制；嵌套对称以祖先为准，与 assembly.buildPlan 同）。 */
function effSymOf(doc, c) {
  let best = c && c.sym ? c.sym : null
  for (const a of ancestorsOf(doc, c.id)) { const x = compById(doc, a); if (x && x.sym) best = x.sym }
  if (!best || !SYM_OPS.includes(best.op)) return null
  if (best.op !== 'radial') return { op: best.op, n: 2, axis: null }
  const dom = isObj(doc) && doc.domain === 'aircraft' ? '+X' : '+Z'
  const n = Number.isInteger(best.n) && best.n >= 2 && best.n <= 8 ? best.n : 2
  return { op: 'radial', n, axis: SYM_AXES.includes(best.axis) ? best.axis : dom }
}
/** 世界点 w 按对称的第 k 份变换（镜像 XZ / YZ 取反 y / x；径向绕 ±X/±Y/±Z 转 360°·k/n，过本体系原点）。 */
function symPoint(sy, k, w) {
  if (sy.op === 'mirrorXZ') return [w[0], -w[1], w[2]]
  if (sy.op === 'mirrorYZ') return [-w[0], w[1], w[2]]
  const deg = (360 * k) / sy.n, r = ((deg % 360) + 360) % 360
  let c, s
  if (r === 90) { c = 0; s = 1 } else if (r === 180) { c = -1; s = 0 } else if (r === 270) { c = 0; s = -1 } else { const t = deg * Math.PI / 180; c = Math.cos(t); s = Math.sin(t) }
  if (sy.axis[0] === '-') s = -s
  const ax = sy.axis[1]
  if (ax === 'X') return [w[0], c * w[1] - s * w[2], s * w[1] + c * w[2]]
  if (ax === 'Y') return [c * w[0] + s * w[2], w[1], -s * w[0] + c * w[2]]
  return [c * w[0] - s * w[1], s * w[0] + c * w[1], w[2]]
}
const xfPt = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]]
/** poses（solvePose 结果 {m, bad} 或 worldPoses 的 Float64Array）里 id 的矩阵；没有 / 解算失败 null。 */
const poseMat = (poses, id) => { const p = poses ? poses.get(id) : null; return !p || p.bad ? null : (p.m || p) }

/**
 * 被占用的插座（usedSocketKeys 之外再认两种）：件自己声明占着的（ComponentDef.busySockets）；
 * 按几何认：任一件（非根）的安装点（它安装端的原点）落在某个件的插座上（离插座原点 ≤ max(5 mm, 5 % 插座名义尺寸)）——
 * 贴面件贴在面心、自由件摆在插座上、展开臂的下一节接在上一节端部，那个插座同样不能再接第二件（否则两件叠在一处）。
 * 对称件（自带或继承）的派生副本同样算：派生副本的安装点 = 主件安装点经世界镜像 / 径向变换（与 solvePose 的派生条目 M'·S_l·mount
 * 同一点），键按主件 id 生成（default-sat：bus 的 −Y 被镜像太阳翼 wing1~1 占着）。只查主件的插座（派生件的插座与主件共用键）。
 * poses = solvePose(doc) 的结果（id → {m}）或 id → Float64Array(16)（worldPoses）；exclude = 不算占用的件 id 集合（拾起中的子树，
 * 连同它们的派生副本）。只在拖动开始 / 同步 / 提交时调（允许分配）。
 * @returns {Set<string>} `${件 id}|${插座 id}`
 */
export function occupiedSocketKeys(doc, poses, exclude) {
  const out = usedSocketKeys(doc, exclude)
  // 件自己就占着的插座（ComponentDef.busySockets：自带馈源的反射面占焦点）
  for (const c of compsOf(doc)) {
    const def = c ? getComponent(c.type) : null
    if (!def || typeof def.busySockets !== 'function') continue
    let ids = []
    try { ids = def.busySockets(fillParams(def, c.params)) || [] } catch { ids = [] }
    for (const id of ids) out.add(`${c.id}|${id}`)
  }
  if (!poses) return out
  const geo = new Map()
  const geoOf = (c) => { let g = geo.get(c.id); if (!g) { g = compGeo(c); geo.set(c.id, g) } return g }
  // ① 各件安装点（本体系）：主件 + 派生副本，记下属主 id（不拿自己的安装点占自己的插座）
  const px = [], owner = []
  for (const c of compsOf(doc)) {
    if (!c || c.parent == null || (exclude && exclude.has(c.id))) continue
    const M = poseMat(poses, c.id)
    if (!M) continue
    const ms = mountSocketOf(c, geoOf(c))
    const w = xfPt(M, ms ? ms.pos : [0, 0, 0])
    px.push(w); owner.push(c.id)
    const sy = effSymOf(doc, c)
    if (sy) for (let k = 1; k < sy.n; k++) { px.push(symPoint(sy, k, w)); owner.push(c.id) }
  }
  if (!px.length) return out
  // ② 各主件的插座（本体系）逐个看有没有别的件的安装点落在上面
  for (const p of compsOf(doc)) {
    if (!p) continue
    const Mp = poseMat(poses, p.id)
    if (!Mp) continue
    for (const s of geoOf(p).sockets) {
      const key = `${p.id}|${s.id}`
      if (out.has(key)) continue
      const sw = xfPt(Mp, s.pos), tol = Math.max(0.005, 0.05 * (s.size > 0 ? s.size : 0)), t2 = tol * tol
      for (let i = 0; i < px.length; i++) {
        if (owner[i] === p.id) continue
        const q = px[i]
        if ((q[0] - sw[0]) ** 2 + (q[1] - sw[1]) ** 2 + (q[2] - sw[2]) ** 2 <= t2) { out.add(key); break }
      }
    }
  }
  return out
}
/**
 * 父件 parentId 上还能接 type 的插座（socketUsable + 空闲；非根父件自己的安装接口不算——自由件也一样，ownMountKey）。
 * selfId = 正在换位的件（它的整棵子树自己占的不算占用）。poses 给了（solvePose / worldPoses 的结果）就按 occupiedSocketKeys
 * 连几何占用（含对称派生副本）一起认。
 * @returns {object[]} 插座（局部系）
 */
export function freeSocketsOf(doc, parentId, type, selfId, poses) {
  const p = compById(doc, parentId)
  if (!p) return []
  const g = compGeo(p)
  const ex = selfId ? new Set(subtreeOf(doc, primaryIdOf(selfId))) : null
  const used = poses ? occupiedSocketKeys(doc, poses, ex) : usedSocketKeys(doc, ex)
  const own = ownMountIds(p, g)
  return g.sockets.filter((s) => !own.includes(s.id) && !used.has(`${p.id}|${s.id}`) && socketUsable(p, s, type, g))
}
/**
 * 属性面板「接口」下拉（与编辑器落点同一口径）：件 compId 装到 parentId（缺省 = 现父件）上可选的接口——兼容（socketUsable）、
 * 不是父件自己的安装接口、没被别的件占（attach 指着的 / busySockets / 几何占用 / 对称派生副本占用；件自己的整棵子树不算）。
 * 件现在用着的接口（同一父件上）恒列出——拆分对称后与主件共锚的副本，其接口同时被主件占着也照列。按父件插座顺序。
 * poses 缺省现算 solvePose(doc)。
 * @returns {{id:string, label:string, socket:object, dedicated:boolean, folded:boolean}[]}
 */
export function freeSocketChoices(doc, compId, parentId, poses) {
  const c = compById(doc, primaryIdOf(compId))
  if (!c) return []
  const pid = parentId == null ? c.parent : primaryIdOf(parentId)
  const p = pid == null ? null : compById(doc, pid)
  if (!p) return []
  const g = compGeo(p)
  const free = new Set(freeSocketsOf(doc, p.id, c.type, c.id, poses || solvePose(doc)).map((s) => s.id))
  const a = c.attach
  const cur = pid === c.parent && a && typeof a.socket === 'string' && a.socket && a.mode !== 'surface' ? a.socket : null
  const list = g.sockets.filter((s) => free.has(s.id) || s.id === cur)
  return list.map((s) => ({ id: s.id, label: socketLabel(s.id), socket: s, dedicated: socketDedicated(s, c.type), folded: isFoldedSocket(g, s.id) }))
}
/**
 * 件的安装锚系（父件局部）：socket 模式 / 自由件带插座锚 → 插座系；surface / 自由件带面锚 → 面系(uv)；否则单位阵。
 * （与 solvePose 的 S0 同一式子。）写 o，返回 o。
 */
export function anchorFrame(o, comp, parentGeo) {
  const a = comp && comp.attach ? comp.attach : null
  m4Ident(o)
  if (!a || !parentGeo) return o
  if (typeof a.socket === 'string' && a.socket && a.mode !== 'surface') {
    const s = parentGeo.sockets.find((x) => x.id === a.socket)
    if (s) socketFrame(o, s)
  } else if (typeof a.face === 'string' && a.face && a.mode !== 'socket') {
    const f = parentGeo.faces.find((x) => x.id === a.face)
    const uv = Array.isArray(a.uv) ? a.uv : null
    if (f) faceFrame(o, f, uv && isNum(uv[0]) ? uv[0] : 0, uv && isNum(uv[1]) ? uv[1] : 0)
  }
  return o
}
/** 几何缓存键：type | 规范化参数（fillParams 后）| 材质覆盖。参数值一样的件共用一份几何与 BVH。 */
export function geomKey(comp) {
  const def = comp ? getComponent(comp.type) : null
  const params = def ? fillParams(def, comp.params) : (comp && isObj(comp.params) ? comp.params : {})
  return `${comp ? comp.type : ''}|${canon(params)}|${(comp && comp.material) || ''}`
}

// ───────────────────────────── 位姿 ↔ 安装语义 ─────────────────────────────

const T0 = new Float64Array(16), T1 = new Float64Array(16), T2 = new Float64Array(16), T3 = new Float64Array(16)

/** 当前主件世界位姿表（id → Float64Array(16) 副本）。 */
function worldPoses(doc) {
  const out = new Map()
  for (const [id, p] of solvePose(doc)) out.set(id, Float64Array.from(p.m))
  return out
}
function setFree(c, parentM, W) {
  // t / q = inv(M_父) · W（不带锚：自由件相对父件系）
  m4Mul(T1, m4InvRigid(T0, parentM), W)
  const q = [0, 0, 0, 1], t = [0, 0, 0]
  m4ToQT(T1, q, t)
  c.attach = mkAttach()
  c.t = t.map(clean); c.q = q.map(clean)
}
/**
 * 由期望的世界位姿 W 反算某种安装方式的语义（不改文档；旧口径：只反算滚转，off / tilt 取缺省——要精确保位姿用 attachFromWorldExact）。
 * mode：'free' → {attach, t, q}（无锚）；'socket' / 'surface' 需给 target（插座 / 面，父件局部）与 uv（面）——roll 取 W 相对锚系的扭转角。
 * @returns {{attach:object, t?:number[], q?:number[]}}
 */
export function attachFromWorld(comp, parentM, W, mode, target, uv) {
  const geo = compGeo(comp)
  if (mode === 'free') {
    const c = { attach: null }
    setFree(c, parentM, W)
    return { attach: c.attach, t: c.t, q: c.q }
  }
  const ms = mountSocketOf(comp, geo)
  if (mode === 'socket') socketFrame(T2, target); else faceFrame(T2, target, uv[0], uv[1])
  // X = inv(M_父·锚) · W · mount：Rz(roll) 的理想值；取 z 向扭转
  m4Mul(T3, parentM, T2)
  m4InvRigid(T0, T3)
  m4Mul(T1, T0, W)
  if (ms) mountFrame(T2, ms); else m4Ident(T2)
  m4Mul(T3, T1, T2)
  const roll = clean(Math.round(twistDeg(T3) * 1e9) / 1e9)
  const mount = comp.attach && comp.attach.mount ? comp.attach.mount : null
  if (mode === 'socket') return { attach: mkAttach({ mode: 'socket', socket: target.id, roll, mount }) }
  return { attach: mkAttach({ mode: 'surface', face: target.id, uv: [clean(uv[0]), clean(uv[1])], roll, mount }) }
}

// ───────────────────────────── 精确反解 / 取锚（带锚偏移 / 倾角） ─────────────────────────────

const X0 = new Float64Array(16), X1 = new Float64Array(16), X2 = new Float64Array(16), X3 = new Float64Array(16)
/** 角度取 1e-9°、长度取 1e-12 m（反解结果的浮点尘：25.999999999999996 → 26、0.30000000000000004 → 0.3），−0 → 0。 */
const r9 = (x) => { const y = Math.round(x * 1e9) / 1e9; return y === 0 ? 0 : y }
const r12 = (x) => { const y = Math.round(x * 1e12) / 1e12; return y === 0 ? 0 : y }
/** 角度差（度，折到 (−180, 180]）。 */
const angDiff = (a, b) => { let d = ((a - b) % 360 + 540) % 360 - 180; if (d === -180) d = 180; return d }
/** 解出的角度：与原值差在 1e-7° 以内取原值（原地重放逐位不变），否则取 1e-9° 档、折到 (−180, 180]。 */
function keepAng(v, prev) {
  if (isNum(prev) && Math.abs(angDiff(v, prev)) <= 1e-7) return prev
  let a = r9(v)
  if (a <= -180) a += 360; else if (a > 180) a -= 360
  return a === 0 ? 0 : a
}
/** 解出的长度：与原值差在 1e-9 m 以内取原值，否则取 1e-12 m 档。 */
const keepLen = (v, prev) => (isNum(prev) && Math.abs(v - prev) <= 1e-9 ? prev : r12(v))
/** 锚系（父件局部）写进 o：插座系 / 面系(uv)；target 为空 = 单位阵。 */
function anchorOf(o, target, uv) {
  if (!target) return m4Ident(o)
  if (target.kind === 'plane' || target.kind === 'cyl') return faceFrame(o, target, uv && isNum(uv[0]) ? uv[0] : 0, uv && isNum(uv[1]) ? uv[1] : 0)
  return socketFrame(o, target)
}
/**
 * 旋转部分（列主序 4×4 的 3×3）分解为 Rz(roll) · Rx(t0) · Ry(t1)（度）：t0 = atan2(R21, cos t0)（cos t0 取两组小元的均方根，
 * 贴近 ±90° 也不失精度）；|cos t0| < 1e-9（万向锁）时 t1 取原值（没有原值取 0）、转角并进 roll；roll 由 R·(Rx·Ry)ᵀ 现算，
 * t1 的舍入误差被 roll 吸收（重组误差 ~1e-16）。写 out[0..2] = [roll, t0, t1]。
 */
function decompRxy(X, prevT1, out) {
  const c0 = Math.sqrt((X[4] * X[4] + X[5] * X[5] + X[2] * X[2] + X[10] * X[10]) / 2)
  const t0 = Math.atan2(X[6], c0) * R2D
  let t1 = c0 < 1e-9 ? (isNum(prevT1) ? prevT1 : 0) : Math.atan2(-X[2], X[10]) * R2D
  t1 = keepAng(t1, prevT1)
  const c1 = Math.cos(t1 * D2R), s1 = Math.sin(t1 * D2R)
  out[0] = Math.atan2(X[1] * c1 + X[9] * s1, X[0] * c1 + X[8] * s1) * R2D
  out[1] = t0; out[2] = t1
  return out
}
const vecOr = (v, n) => (Array.isArray(v) && v.length === n ? v : null)

/**
 * 精确反解（保位姿）：期望世界位姿 W（本件本体系位姿）挂在给定锚上时的安装语义，solvePose 复现 W（往返 ≤ 1e-9）。
 *   mode 'socket'：target = 父件插座 → off（接口系，z = 法向）、roll、tilt；
 *   mode 'surface'：target = 父件的面 → 面内位置进 uv（平面：投影；柱面：轴向 + 弧长，局部弧不夹紧）、off = [0, 0, 法向距离]、roll、tilt；
 *   mode 'free'：target = 插座 / 面 / null（无锚）→ t / q 相对锚系（面锚的位置 = uv 参数，缺省 [0, 0]）。
 * 约定：roll ∈ (−180°, 180°]、t0 ∈ [−90°, 90°]、t1 ∈ (−180°, 180°]；|cos t0| < 1e-9 时 t1 取原值（无原值 0）、转角并进 roll。
 * prev（缺省 comp：读 prev.attach / prev.t / prev.q）：解出的量与原值只差浮点尘（角度 1e-7°、长度 1e-9 m、四元数分量 1e-9）时取
 * 原值——原地重放文档逐字节不变、驱动标记不误判改写；其余结果过 clean（角度 1e-9°、长度 1e-12 m 档）。mount 沿用 comp.attach.mount
 * （自由件不用）。
 * 已知口径：「方式」三键来回切（free → surface → free 等）位姿误差 ≤ 1e-9、不瞬移，但文档不保证逐字节复原——中间方式的结果已按
 * 档取整（自由件 t 落到 1e-12 m 档），带接口锚的自由件经面安装回到自由后改为面锚（面安装只认面）。逐字节复原靠撤销。
 * @returns {{attach:object, t?:number[], q?:number[]}}
 */
export function attachFromWorldExact(comp, parentM, W, mode, target, uv, prev = comp) {
  const pa = prev && isObj(prev.attach) ? prev.attach : {}
  if (mode === 'free') {
    const isFace = !!target && (target.kind === 'plane' || target.kind === 'cyl')
    const puv = vecOr(pa.uv, 2)
    const u0 = isFace ? keepLen(uv && isNum(uv[0]) ? uv[0] : 0, puv ? puv[0] : undefined) : 0
    const v0 = isFace ? keepLen(uv && isNum(uv[1]) ? uv[1] : 0, puv ? puv[1] : undefined) : 0
    anchorOf(X0, target, [u0, v0])
    m4Mul(X1, parentM, X0)
    m4InvRigid(X0, X1)
    m4Mul(X1, X0, W)
    const q = [0, 0, 0, 1], t = [0, 0, 0]
    m4ToQT(X1, q, t)
    const pt = vecOr(prev && prev.t, 3), pq = vecOr(prev && prev.q, 4)
    const tt = t.map((x, i) => keepLen(x, pt ? pt[i] : undefined))
    // 四元数 ±q 同一旋转：与原值（任一号）只差浮点尘取原值。容差 1e-9 与角度的 1e-7° 档同量级（转角 θ 的分量差 ≈ θ/2 ≈ 8.7e-10）
    const same = pq && [1, -1].some((sg) => q.every((x, i) => isNum(pq[i]) && Math.abs(x - sg * pq[i]) <= 1e-9))
    const qq = same ? pq.slice() : q.map(clean)
    const attach = mkAttach({ mode: 'free', socket: target && !isFace ? target.id : null, face: isFace ? target.id : null, uv: isFace ? (puv && puv[0] === u0 && puv[1] === v0 ? puv.slice() : [u0, v0]) : null })
    return { attach, t: pt && tt.every((x, i) => x === pt[i]) ? pt.slice() : tt, q: qq }
  }
  const ms = mountSocketOf(comp, compGeo(comp))
  if (ms) mountFrame(X2, ms); else m4Ident(X2)
  let u = 0, v = 0
  if (mode === 'surface') {
    // 先在 uv = (0, 0) 的面系里求安装点，再定 uv（平面：面内坐标；柱面：轴向 + 弧长 v = r·atan2(y, z + r)，与 uvOnFace 同式）
    faceFrame(X0, target, 0, 0)
    m4Mul(X1, parentM, X0); m4InvRigid(X0, X1); m4Mul(X1, X0, W); m4Mul(X0, X1, X2)
    const px = X0[12], py = X0[13], pz = X0[14]
    if (target.kind === 'cyl') { u = px; v = target.radius * Math.atan2(py, pz + target.radius) } else { u = px; v = py }
    const puv = vecOr(pa.uv, 2)
    u = keepLen(u, puv ? puv[0] : undefined); v = keepLen(v, puv ? puv[1] : undefined)
    faceFrame(X0, target, u, v)
  } else socketFrame(X0, target)
  // X = inv(M_父 · 锚) · W · mount = T(off) · Rz(roll) · Rx(t0) · Ry(t1)
  m4Mul(X1, parentM, X0); m4InvRigid(X0, X1); m4Mul(X1, X0, W); m4Mul(X0, X1, X2)
  const po = vecOr(pa.off, 3), pt = vecOr(pa.tilt, 2)
  const ang = decompRxy(X0, pt ? pt[1] : undefined, [0, 0, 0])
  const roll = keepAng(ang[0], pa.roll), t0 = keepAng(ang[1], pt ? pt[0] : undefined), t1 = ang[2]
  const off = mode === 'surface' ? [0, 0, keepLen(X0[14], po ? po[2] : undefined)] : [keepLen(X0[12], po ? po[0] : undefined), keepLen(X0[13], po ? po[1] : undefined), keepLen(X0[14], po ? po[2] : undefined)]
  const mount = (comp.attach && comp.attach.mount) || null
  const base ={ roll, mount, off: po && off.every((x, i) => x === po[i]) ? po.slice() : off, tilt: pt && pt[0] === t0 && pt[1] === t1 ? pt.slice() : [t0, t1] }
  if (mode === 'socket') return { attach: mkAttach({ mode: 'socket', socket: target.id, ...base }) }
  return { attach: mkAttach({ mode: 'surface', face: target.id, uv: [u, v], ...base }) }
}

/**
 * 件安装端在父件局部的位姿（gizmo 安装系 / 属性面板读数用）：socket / surface = 锚系 · T(off) · Rz(roll) · Rx(t0) · Ry(t1)
 * （原点 = 本件安装点）；free = 锚系 · T(t) · R(q) · mount 系（同样落在安装端上）。parentGeo = compGeo(父件)。写 o，返回 o。
 */
export function mountedFrame(o, comp, parentGeo) {
  const a = comp && comp.attach ? comp.attach : null
  anchorFrame(X0, comp, parentGeo)
  if (!a || a.mode === 'free') {
    const q = vecOr(comp && comp.q, 4) || [0, 0, 0, 1], t = vecOr(comp && comp.t, 3) || [0, 0, 0]
    m4FromQT(X1, q, t)
    m4Mul(X2, X0, X1)
    const ms = comp ? mountSocketOf(comp) : null
    if (ms) mountFrame(X1, ms); else m4Ident(X1)
    return m4Mul(o, X2, X1)
  }
  const off = vecOr(a.off, 3) || [0, 0, 0], tl = vecOr(a.tilt, 2) || [0, 0], inPlane = a.mode !== 'surface'
  m4RotZ(X1, isNum(a.roll) ? a.roll : 0)
  m4Mul(X2, X1, rotXY(X3, isNum(tl[0]) ? tl[0] : 0, isNum(tl[1]) ? tl[1] : 0))
  // 面安装只认法向分量（与 assembly 解算同口径：面内位置走 uv）
  X2[12] = inPlane && isNum(off[0]) ? off[0] : 0; X2[13] = inPlane && isNum(off[1]) ? off[1] : 0; X2[14] = isNum(off[2]) ? off[2] : 0
  return m4Mul(o, X0, X2)
}
/** Rx(t0) · Ry(t1)（度）→ o。 */
function rotXY(o, t0, t1) {
  const a = t0 * D2R, b = t1 * D2R, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b)
  // 行：[[cb, 0, sb], [sa·sb, ca, −sa·cb], [−ca·sb, sa, ca·cb]]，列主序写入
  o[0] = cb; o[1] = sa * sb; o[2] = -ca * sb; o[3] = 0
  o[4] = 0; o[5] = ca; o[6] = sa; o[7] = 0
  o[8] = sb; o[9] = -sa * cb; o[10] = ca * cb; o[11] = 0
  o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1
  return o
}

/** 件尺寸（米）：组件局部包围盒最长边；给不出几何时退到安装端名义尺寸、再退 0.1 m。 */
function compSizeM(comp, density) {
  const b = comp ? componentBox(comp.type, comp.params, density) : null
  if (b) { const s = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]); if (s > 0) return s }
  const ms = comp ? mountSocketOf(comp) : null
  return ms && ms.size > 0 ? ms.size : 0.1
}

/**
 * 取锚：件 comp 以世界位姿 W 挂到父件 parentId 上时，按几何就近取锚（2026-10 §3.3.1）。安装点 = W · 本件安装端原点，换到父件局部后：
 *   ① 平面（可安装面）：|u| ≤ 1.05·halfU、|v| ≤ 1.05·halfV、−min(件尺寸, 0.5 m) ≤ 法向距离 ≤ 件尺寸 → 取 |法向距离| 最小的面；
 *   ② 空闲接口（socketUsable、未占用、不是父件自己的安装接口）：距离 ≤ min(max(5 cm, 25 % 件尺寸), 0.5 m) → 最近的；
 *   ③ 柱面（可安装面）：轴向 ≤ 1.05·halfU、整圆或角度在弧内（|v| ≤ halfV）、法向距离同① → 最小的；
 *   都不中 → null（无锚自由，相对父件）。0.5 m = ANCHOR_MAX_M（大件的绝对上限，见常量注释）。
 * opts.only = 'socket'（只看②，setMode('socket')）/ 'face'（只看①③）；opts.exclude = 不算占用的件 id 集合（缺省 = comp 的整棵子树）。
 * poses = solvePose / worldPoses 的结果（取父件位姿与几何占用）。不改文档。
 * @returns {null | {kind:'face', id:string, face:object, uv:number[], d:number} | {kind:'socket', id:string, socket:object, dist:number}}
 */
export function pickAnchor(doc, poses, comp, parentId, W, opts = {}) {
  if (!comp || parentId == null || !W) return null
  const pid = primaryIdOf(parentId)
  const p = compById(doc, pid), Mp = poseMat(poses, pid)
  if (!p || !Mp) return null
  const only = opts.only || null
  const pg = compGeo(p), ms = mountSocketOf(comp)
  const w = xfPt(W, ms ? ms.pos : [0, 0, 0])
  m4InvRigid(X0, Mp)
  const L = xfPt(X0, w)
  const size = compSizeM(comp, isObj(doc) ? doc.density : null)
  // 法向距离窗口：朝外 ≤ 件尺寸、嵌进背侧 ≤ min(件尺寸, ANCHOR_MAX_M)
  const dOut = size, dIn = Math.min(size, ANCHOR_MAX_M)
  const okFace = (f) => faceAccepts(pg.def, pg.params, f, comp.type)
  if (only !== 'socket') {
    let best = null
    for (const f of pg.faces) {
      if (f.kind === 'cyl' || !okFace(f)) continue
      const rx = L[0] - f.origin[0], ry = L[1] - f.origin[1], rz = L[2] - f.origin[2]
      const u = rx * f.u[0] + ry * f.u[1] + rz * f.u[2], v = rx * f.v[0] + ry * f.v[1] + rz * f.v[2], d = rx * f.n[0] + ry * f.n[1] + rz * f.n[2]
      if (Math.abs(u) > ANCHOR_FACE_REL * f.halfU || Math.abs(v) > ANCHOR_FACE_REL * f.halfV || d > dOut || d < -dIn) continue
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { kind: 'face', id: f.id, face: f, uv: [u, v], d }
    }
    if (best) return best
  }
  if (only !== 'face') {
    const ex = opts.exclude || (compById(doc, comp.id) ? new Set(subtreeOf(doc, comp.id)) : null)
    const used = occupiedSocketKeys(doc, poses, ex)
    const own = ownMountIds(p, pg), lim = Math.min(Math.max(ANCHOR_SOCKET_M, ANCHOR_SOCKET_REL * size), ANCHOR_MAX_M)
    let best = null
    for (const s of pg.sockets) {
      const key = `${p.id}|${s.id}`
      if (own.includes(s.id) || used.has(key) || !socketUsable(p, s, comp.type, pg)) continue
      const dist = Math.hypot(s.pos[0] - L[0], s.pos[1] - L[1], s.pos[2] - L[2])
      if (dist <= lim && (!best || dist < best.dist)) best = { kind: 'socket', id: s.id, socket: s, dist }
    }
    if (best) return best
  }
  if (only !== 'socket') {
    let best = null
    const io = { u: 0, v: 0, d: 0 }
    for (const f of pg.faces) {
      if (f.kind !== 'cyl' || !okFace(f)) continue
      faceFrame(X1, f, 0, 0)
      uvOnFace(f, X1, L[0], L[1], L[2], io)
      if (Math.abs(io.u) > ANCHOR_FACE_REL * f.halfU || io.d > dOut || io.d < -dIn) continue
      if (!isFullCyl(f) && Math.abs(io.v) > f.halfV) continue
      if (!best || Math.abs(io.d) < Math.abs(best.d)) best = { kind: 'face', id: f.id, face: f, uv: [io.u, io.v], d: io.d }
    }
    if (best) return best
  }
  return null
}

// ───────────────────────────── 文档命令 ─────────────────────────────

const fail = (error, code) => (code ? { ok: false, error, code } : { ok: false, error })
const EDIT_WHEN_LOCKED = new Set(['setHidden', 'setLocked', 'setDoc'])
/** 对称副本与原件重合时的拒收文案（onSymLocus）。 */
const locusText = (sym) => (sym && sym.op === 'radial' ? '件在对称轴上。' : '件在对称面上。')

/**
 * 文档 d 里的组件 c 带着的对称（c.sym）会不会让副本压在原件上：c 的本体系位姿（solvePose）+ 组件局部包围盒（componentBox，
 * 走生成缓存的轻层）交给 onSymLocus。c 没有自带对称 / 解不出位姿时 false。只在提交时调（允许分配）。
 */
export function symCoincides(d, c) {
  if (!c || !c.sym) return false
  const pm = solvePose(d).get(c.id)
  if (!pm || pm.bad) return false
  return onSymLocus(c.sym, pm.m, componentBox(c.type, c.params, d.density))
}

/**
 * 件 c 装在父件声明的「单件接口」上（父件 ComponentDef.singleSockets：数组或 (补过缺省的参数) => 数组）：直升机尾桨这类按设计只在一侧的件，
 * 拖入 / 拾起 / 快速添加时工具栏对称（飞机缺省镜像 XZ）不作用于它；用户在属性面板里显式设对称照常生效。零分配（singleSockets 为数组时）。
 */
export function socketSingle(d, c) {
  if (!c || !c.parent || !c.attach || c.attach.mode !== 'socket' || typeof c.attach.socket !== 'string') return false
  const par = compById(d, c.parent), def = par ? getComponent(par.type) : null, ss = def ? def.singleSockets : null
  if (!ss) return false
  const list = typeof ss === 'function' ? ss(fillParams(def, par.params)) : ss
  return Array.isArray(list) && list.includes(c.attach.socket)
}

function idsOfCmd(cmd) { return Array.isArray(cmd.ids) ? cmd.ids.map(primaryIdOf) : (typeof cmd.id === 'string' ? [primaryIdOf(cmd.id)] : []) }

/**
 * 执行一条编辑命令（CONTRACT §5.1 表的 13 种），不改入参。
 * @param {object} doc 装配文档（归一或未归一均可）
 * @param {object} cmd {type, …}
 * @returns {{ok:true, doc:object, ids:string[], changed:boolean, mergeKey?:string, freed?:string[], symDropped?:string[], split?:string[]} | {ok:false, error:string, code?:string}}
 *   doc = 归一后的新文档；changed = 文档是否真变了（没变编辑器不入撤销栈）；mergeKey：setParams 的合并键（同件同键）；
 *   freed = 改参数后插座 / 面没了、改成自由件的；symDropped = 换位后落在对称面 / 轴上、去掉了对称的；split = 换根时拆分了对称的；
 *   code = 'onLocus'：setSym 因副本与原件重合被拒
 */
export function applyCmd(doc, cmd) {
  if (!isObj(cmd) || !CMD_TYPES.includes(cmd.type)) return fail('未知命令。')
  const d = normalizeAssembly(doc)
  const before = canon(d)
  const ids = idsOfCmd(cmd)
  if (cmd.type !== 'setDoc') {
    if (!ids.length) return fail('未找到组件。')
    for (const id of ids) if (!compById(d, id)) return fail('未找到组件。')
    if (!EDIT_WHEN_LOCKED.has(cmd.type)) for (const id of ids) if (compById(d, id).locked) return fail('件已锁定。')
  }
  const c = ids.length ? compById(d, ids[0]) : null
  let mergeKey, freed = null, symDropped = null, split = null
  switch (cmd.type) {
    case 'setParams': {
      const def = getComponent(c.type)
      if (!def) return fail('未知组件。')
      if (!isObj(cmd.params)) return fail('参数无效。')
      for (const k of Object.keys(cmd.params)) if (!Object.hasOwn(def.params, k)) return fail(`未知参数 ${k}。`)
      // 改参数前的世界位姿：参数变了插座 / 面集合可能跟着变（机翼发动机数、车型、桅横桁…），挂在消失的插座 / 面上的子件
      // （以及本件自己的安装插座消失时的本件）在同一条命令里改成保持世界位姿的自由件——不留「指着不存在的插座」的孤儿
      const P0 = worldPoses(d)
      const g0 = compGeo(c)
      c.params = { ...c.params }
      for (const [k, v] of Object.entries(cmd.params)) c.params[k] = v === undefined ? def.params[k].def : v
      mergeKey = `${c.id}|${Object.keys(cmd.params).sort().join(',')}`
      // 面还在、尺寸变了：贴在面上的子件（贴面 / 带面锚的自由件）的 uv 按新旧半宽等比换算（相对布局不变、不会悬到面外）
      rescaleFaceKids(d, c, g0)
      freed = rehomeOrphans(d, c, P0)
      break
    }
    case 'rename': c.name = typeof cmd.name === 'string' && cmd.name.trim() ? cmd.name.trim() : null; break
    case 'setHidden': for (const id of ids) compById(d, id).hidden = !!cmd.on; break
    case 'setLocked': for (const id of ids) compById(d, id).locked = !!cmd.on; break
    case 'setMaterial':
      if (cmd.material != null && !Object.hasOwn(MATERIALS, cmd.material)) return fail('未知材质。')
      c.material = cmd.material == null ? null : cmd.material
      break
    case 'setMass':
      if (cmd.massKg != null && !(isNum(cmd.massKg) && cmd.massKg > 0)) return fail('质量须为正数。')
      c.massKg = cmd.massKg == null ? null : cmd.massKg
      break
    case 'setAttach': {
      if (c.parent == null) return fail('根件无安装方式。')
      const a = isObj(cmd.attach) ? cmd.attach : {}
      if (a.mode !== undefined && !ATTACH_MODES.includes(a.mode)) return fail('安装方式无效。')
      const next = { ...c.attach }
      for (const k of ['mode', 'socket', 'face', 'uv', 'roll', 'mount', 'off', 'tilt']) if (k in a) next[k] = Array.isArray(a[k]) ? a[k].slice() : a[k]
      // 换了方式但没给锚：按新方式补（socket / face 键互斥由 normalizeAssembly 收拾）
      if (next.mode === 'socket') { next.face = null; next.uv = null } else if (next.mode === 'surface') { next.socket = null; if (!Array.isArray(next.uv)) next.uv = [0, 0] }
      c.attach = next
      if (next.mode === 'free') { if (Array.isArray(cmd.t)) c.t = cmd.t.slice(); if (Array.isArray(cmd.q)) c.q = cmd.q.slice() } else { delete c.t; delete c.q }
      break
    }
    case 'setMode': {
      const r = setModeOp(d, c, cmd.mode)
      if (!r.ok) return r
      break
    }
    case 'reparent': {
      const r = reparentOp(d, c, primaryIdOf(cmd.parent))
      if (!r.ok) return r
      break
    }
    case 'setRoot': {
      const r = setRootOp(d, c)
      if (!r.ok) return r
      if (r.split && r.split.length) split = r.split
      break
    }
    case 'setSym': {
      if (c.parent == null) return fail('根件不能对称。')
      if (cmd.sym == null) { c.sym = null; break }
      const s = cmd.sym
      if (!isObj(s) || !SYM_OPS.includes(s.op)) return fail('对称方式无效。')
      if (ancestorsOf(d, c.id).some((a) => compById(d, a).sym)) return fail('不支持嵌套对称。')
      if (subtreeOf(d, c.id).slice(1).some((x) => compById(d, x).sym)) return fail('不支持嵌套对称。')
      const o = { group: typeof s.group === 'string' && s.group ? s.group : c.id, op: s.op }
      if (s.op === 'radial') {
        const n = Math.round(Number(s.n === undefined ? 2 : s.n))
        if (!(n >= 2 && n <= 8)) return fail('径向份数须为 2–8。')
        o.n = n
        o.axis = s.axis === undefined ? (d.domain === 'aircraft' ? '+X' : '+Z') : s.axis
        if (!SYM_AXES.includes(o.axis)) return fail('径向轴无效。')
      }
      c.sym = o
      // 件的几何在对称面 / 轴上：副本与原件重合（屏上看不出、质量与入库几何却多一份）→ 拒收（code onLocus：M 键据此改试另一个镜面）
      if (symCoincides(d, c)) return fail(locusText(o), 'onLocus')
      break
    }
    case 'splitSym': {
      const r = splitSymOp(d, c)
      if (!r.ok) return r
      break
    }
    case 'setDoc': {
      const p = isObj(cmd.patch) ? cmd.patch : {}
      if ('name' in p) d.name = typeof p.name === 'string' ? p.name : ''
      if ('massTargetKg' in p) {
        if (p.massTargetKg != null && !(isNum(p.massTargetKg) && p.massTargetKg > 0)) return fail('目标质量须为正数。')
        d.massTargetKg = p.massTargetKg == null ? null : p.massTargetKg
      }
      if ('density' in p) {
        if (!isObj(p.density)) return fail('密度表无效。')
        const dn = { ...d.density }
        for (const [k, v] of Object.entries(p.density)) { if (v == null) delete dn[k]; else dn[k] = v }
        d.density = dn
      }
      break
    }
  }
  // 换位类命令（换插座 / 面 / uv、换安装方式、换父件）把带对称的件挪到了对称面 / 轴上：副本会压在原件上 → 同一条命令里去掉对称
  // （与编辑器拖入 / 拾起落在对称面上的口径一致；撤销一次就回来）
  if ((cmd.type === 'setAttach' || cmd.type === 'setMode' || cmd.type === 'reparent') && c.sym && symCoincides(d, c)) {
    c.sym = null
    symDropped = [c.id]
  }
  const out = normalizeAssembly(d)
  const changed = canon(out) !== before
  const r = mergeKey ? { ok: true, doc: out, ids, changed, mergeKey } : { ok: true, doc: out, ids, changed }
  if (freed && freed.length) r.freed = freed
  if (symDropped) r.symDropped = symDropped
  if (split) r.split = split
  return r
}

/**
 * setParams 之后：c 的面还在、尺寸变了 → 贴在该面上的子件（贴面件 / 带面锚的自由件）uv 按新旧半宽等比换算（柱面弧长按半径比 = 角度不变），
 * 再夹进新面内。就地改 d；父件改尺寸子件跟随，不会悬在面外。
 */
function rescaleFaceKids(d, c, g0) {
  const g1 = compGeo(c)
  const o = { u: 0, v: 0 }
  const r9 = (x) => { const y = Math.round(x * 1e9) / 1e9; return y === 0 ? 0 : y }
  for (const ch of childrenOf(d, c.id)) {
    const a = ch.attach
    if (!a || typeof a.face !== 'string' || !a.face || a.mode === 'socket' || !Array.isArray(a.uv)) continue
    const f0 = g0.faces.find((f) => f.id === a.face), f1 = g1.faces.find((f) => f.id === a.face)
    if (!f0 || !f1 || f0.kind !== f1.kind) continue
    const su = f0.halfU > 0 && f1.halfU > 0 ? f1.halfU / f0.halfU : 1, sv = f0.halfV > 0 && f1.halfV > 0 ? f1.halfV / f0.halfV : 1
    if (su === 1 && sv === 1) continue
    const u0 = isNum(a.uv[0]) ? a.uv[0] : 0, v0 = isNum(a.uv[1]) ? a.uv[1] : 0
    clampToFace(f1, u0 * su, v0 * sv, o)
    ch.attach = { ...a, uv: [r9(o.u), r9(o.v)] }
  }
}

/**
 * setParams 之后：c 的新插座 / 面集合里没有了的安装锚 → 挂在上面的子件改自由（保持改参数前的世界位姿）；c 自己的安装插座
 * （attach.mount ‖ def.mountSocket）没有了 → c 改自由。就地改 d，返回被改成自由件的 id（没有返回 []）。
 */
function rehomeOrphans(d, c, P0) {
  const out = []
  const g = compGeo(c)
  const hasS = (id) => g.sockets.some((s) => s.id === id)
  const hasF = (id) => g.faces.some((f) => f.id === id)
  if (c.parent != null && c.attach && c.attach.mode !== 'free') {
    const mid = c.attach.mount || (g.def ? g.def.mountSocket : 'root')
    const Mp = P0.get(c.parent), W = P0.get(c.id)
    // 安装端按 g.mounts 口径查：'@面' / '@bbox' 安装端随参数仍在就不算消失
    const has = mid[0] === '@' ? !!componentMount(c.type, c.params, mid) : hasS(mid)
    if (!has && Mp && W) { setFree(c, Mp, W); out.push(c.id) }
  }
  const lost = []
  for (const ch of childrenOf(d, c.id)) {
    const a = ch.attach || {}
    const sockGone = typeof a.socket === 'string' && a.socket && a.mode !== 'surface' && !hasS(a.socket)
    const faceGone = typeof a.face === 'string' && a.face && a.mode !== 'socket' && !hasF(a.face)
    if (sockGone || faceGone) lost.push(ch)
  }
  if (!lost.length) return out
  const Mc = worldPoses(d).get(c.id)   // c 的新位姿（参数可能动了它自己的安装插座位置）
  for (const ch of lost) {
    const W = P0.get(ch.id)
    if (!Mc || !W) continue
    setFree(ch, Mc, W)
    out.push(ch.id)
  }
  return out
}

/** 精确反解结果写回件（自由件带 t / q，其余删掉）。 */
function applyExact(c, r) {
  c.attach = r.attach
  if (r.attach.mode === 'free') { c.t = r.t; c.q = r.q } else { delete c.t; delete c.q }
}
/** 件现在的锚（父件局部的插座 / 面对象 + uv）：socket 模式 / 带插座锚的自由件 → 插座；surface / 带面锚的自由件 → 面；否则 null。 */
function currentAnchor(c, pg) {
  const a = c.attach
  if (!a) return null
  if (typeof a.socket === 'string' && a.socket && a.mode !== 'surface') { const s = pg.sockets.find((x) => x.id === a.socket); return s ? { kind: 'socket', socket: s } : null }
  if (typeof a.face === 'string' && a.face && a.mode !== 'socket') { const f = pg.faces.find((x) => x.id === a.face); return f ? { kind: 'face', face: f, uv: Array.isArray(a.uv) ? a.uv : [0, 0] } : null }
  return null
}
/**
 * 按取到的锚把件挂上（保持世界位姿）：原为自由件 → 带锚自由（t / q 相对锚系）；锚是接口 → socket；锚是面 → surface；
 * 原为接口件且阈值内有空闲接口 → 仍按接口写（不因面心推断优先改成面安装）；没有锚 → 无锚自由。就地改 c（c.parent 已是新父件）。
 */
function attachByAnchor(d, P, c, m0, W) {
  const Mp = P.get(c.parent)
  if (m0 === 'socket') {
    const ks = pickAnchor(d, P, c, c.parent, W, { only: 'socket' })
    if (ks) { applyExact(c, attachFromWorldExact(c, Mp, W, 'socket', ks.socket)); return }
  }
  const k = pickAnchor(d, P, c, c.parent, W)
  if (!k) applyExact(c, attachFromWorldExact(c, Mp, W, 'free', null))
  else if (m0 === 'free') applyExact(c, attachFromWorldExact(c, Mp, W, 'free', k.socket || k.face, k.uv))
  else if (k.kind === 'socket') applyExact(c, attachFromWorldExact(c, Mp, W, 'socket', k.socket))
  else applyExact(c, attachFromWorldExact(c, Mp, W, 'surface', k.face))
}

/**
 * 换安装方式、保持世界位姿、保锚（就地改 d 里的 c）：
 *   free    —— 保留现锚（接口 / 面 + uv），t / q 相对锚系（带锚自由）；
 *   socket  —— 现锚是接口就用它（off 吸收偏移）；否则只在 pickAnchor 阈值内的空闲接口里选，没有报「无可用接口。」；
 *   surface —— 现锚是面就用它；否则按 pickAnchor 取面（平面 → 柱面），没有报「无可安装面。」。
 * off / roll / tilt 由 attachFromWorldExact 精确反解（不再瞬移、不丢倾角）。
 */
function setModeOp(d, c, mode) {
  if (c.parent == null) return fail('根件无安装方式。')
  if (!ATTACH_MODES.includes(mode)) return fail('安装方式无效。')
  if (c.attach.mode === mode) return { ok: true }
  const P = worldPoses(d), W = P.get(c.id), Mp = P.get(c.parent)
  if (!W || !Mp) return fail('未找到组件。')
  const pg = compGeo(compById(d, c.parent)), cur = currentAnchor(c, pg)
  if (mode === 'free') {
    applyExact(c, attachFromWorldExact(c, Mp, W, 'free', cur ? (cur.socket || cur.face) : null, cur && cur.uv))
    return { ok: true }
  }
  if (mode === 'socket') {
    let s = cur && cur.kind === 'socket' ? cur.socket : null
    if (!s) { const k = pickAnchor(d, P, c, c.parent, W, { only: 'socket' }); s = k ? k.socket : null }
    if (!s) return fail('无可用接口。')
    applyExact(c, attachFromWorldExact(c, Mp, W, 'socket', s))
    return { ok: true }
  }
  let f = cur && cur.kind === 'face' ? cur.face : null
  if (!f) { const k = pickAnchor(d, P, c, c.parent, W, { only: 'face' }); f = k ? k.face : null }
  if (!f) return fail('无可安装面。')
  applyExact(c, attachFromWorldExact(c, Mp, W, 'surface', f))
  return { ok: true }
}

/** 改父件：保持世界位姿，在新父件上按 pickAnchor 就近取锚（方式随原件：自由件仍自由但带锚，接口件优先接口）。 */
function reparentOp(d, c, pid) {
  if (c.parent == null) return fail('根件不能改父件。')
  const p = compById(d, pid)
  if (!p) return fail('未找到组件。')
  if (pid === c.id || subtreeOf(d, c.id).includes(pid)) return fail('父子关系成环。')
  if (c.parent === pid) return { ok: true }
  if (subtreeHasOwnSym(d, c.id) && inSymSubtree(d, pid)) return fail('不支持嵌套对称。')
  const P = worldPoses(d), W = P.get(c.id)
  if (!W || !P.get(pid)) return fail('未找到组件。')
  const m0 = c.attach.mode
  c.parent = pid
  attachByAnchor(d, P, c, m0, W)
  return { ok: true }
}

/**
 * 旧本体系里定义的对称，换到以 Pc（新根在旧本体系里的位姿）为原点的新本体系里还能不能照样表述：
 *   镜像 —— 新原点在旧镜面上、且旧镜面法向在新系里是 ±X / ±Y（新系的 YZ / XZ 面）→ 换算后的 {op}；
 *   径向 —— 新原点在旧轴线上、且旧轴方向在新系里是某根主轴 → 换算后的 {axis}（方向带符号：派生件 ~k 的转角方向不变、逐件对得上）。
 * 表述不了返回 null（调用方在同一条命令里拆分对称）。派生件位姿 S'·M'·S_l 与换根前的世界位姿一致：S' = N·S·N⁻¹、
 * 局部镜面 S_l 的挑法只看位姿列与镜面法向的夹角（换根前后相同），见 assembly.mjs bestPlane。
 */
function symInFrame(s, Pc) {
  const E = 1e-9
  const unitAxis = (v) => { for (let j = 0; j < 3; j++) if (Math.abs(Math.abs(v[j]) - 1) < E) return j; return -1 }
  if (s.op === 'mirrorXZ' || s.op === 'mirrorYZ') {
    const na = s.op === 'mirrorXZ' ? 1 : 0
    if (Math.abs(Pc[12 + na]) > E) return null
    // 旧法向 e_na 在新系 = Rcᵀ·e_na = Rc 的第 na 行
    const j = unitAxis([Pc[na], Pc[na + 4], Pc[na + 8]])
    if (j === 1) return { ...s, op: 'mirrorXZ' }
    if (j === 0) return { ...s, op: 'mirrorYZ' }
    return null
  }
  if (s.op !== 'radial') return null
  const i = s.axis && s.axis[1] === 'X' ? 0 : s.axis && s.axis[1] === 'Y' ? 1 : 2, sg = s.axis && s.axis[0] === '-' ? -1 : 1
  for (let k = 0; k < 3; k++) if (k !== i && Math.abs(Pc[12 + k]) > E) return null
  const v = [Pc[i] * sg, Pc[i + 4] * sg, Pc[i + 8] * sg]
  const j = unitAxis(v)
  if (j < 0) return null
  return { ...s, axis: (v[j] > 0 ? '+' : '-') + 'XYZ'[j] }
}

/**
 * 以 c 为新根：全部世界位姿左乘 inv(M_新根)，原根到新根路径上的件改自由。
 * 对称面 / 轴定义在本体系（根件坐标系）里：各对称件按新本体系重述（symInFrame）；重述不了的在同一条命令里先拆分对称（世界几何不变），
 * 返回 split = 被拆分的件 id。拆不了（烘焙件）整条拒收。
 */
function setRootOp(d, c) {
  if (c.parent == null) return { ok: true }
  if (inSymSubtree(d, c.id)) return fail('对称件不能设为根。')
  let P = worldPoses(d)
  const Pc = P.get(c.id)
  if (!Pc) return fail('未找到组件。')
  const remap = [], split = []
  for (const x of d.comps) {
    if (!x.sym) continue
    const s = symInFrame(x.sym, Pc)
    if (s) remap.push([x, s]); else split.push(x.id)
  }
  for (const id of split) { const r = splitSymOp(d, compById(d, id)); if (!r.ok) return fail('对称件不能换算到新根。') }
  if (split.length) P = worldPoses(d)
  for (const [x, s] of remap) x.sym = s
  const inv = m4InvRigid(new Float64Array(16), P.get(c.id))
  const W = (id) => m4Mul(new Float64Array(16), inv, P.get(id))
  const path = [c.id, ...ancestorsOf(d, c.id)]
  const Wn = new Map(path.map((id) => [id, W(id)]))
  for (let i = path.length - 1; i >= 1; i--) {
    const x = compById(d, path[i]), child = path[i - 1]
    x.parent = child
    setFree(x, Wn.get(child), Wn.get(path[i]))
  }
  c.parent = null
  c.attach = mkAttach()
  c.sym = null
  delete c.t; delete c.q
  return { ok: true, split }
}

/**
 * 拆分对称：派生件转成独立件（钩子件参数取 def.mirror；烘焙件不能拆）。世界位姿 = 原派生件；副本按 pickAnchor 在父件上
 * 就近取锚（镜像太阳翼落回 −Y 接口 / 面；方式随原件，见 attachByAnchor），取不到锚的才是无锚自由件。
 */
function splitSymOp(d, c) {
  if (!c.sym) return fail('该组件无对称。')
  const poses = solvePose(d)
  const sub = subtreeOf(d, c.id)
  const n = c.sym.op === 'radial' ? (c.sym.n || 2) : 2
  for (let k = 1; k < n; k++) for (const id of sub) { const p = poses.get(`${id}~${k}`); if (!p || p.mode === 'bake') return fail('该组件不能拆分对称。') }
  const used = new Set()
  const added = [], modes = new Map(), topK = new Map()
  const sy = effSymOf(d, c)
  for (let k = 1; k < n; k++) {
    const map = new Map()
    for (const id of sub) {
      const src = compById(d, id), def = getComponent(src.type), pose = poses.get(`${id}~${k}`)
      const nid = compIdFor({ drive: d.drive, comps: [...d.comps, ...added] }, src.type, used)
      map.set(id, nid)
      const copy = JSON.parse(JSON.stringify(src))
      copy.id = nid; copy.sym = null
      copy.parent = id === c.id ? src.parent : map.get(src.parent)
      if (pose.mode === 'hook' && def && def.mirror) copy.params = def.mirror(fillParams(def, src.params), pose.plane) || copy.params
      const parentM = id === c.id ? poses.get(src.parent).m : poses.get(`${src.parent}~${k}`).m
      setFree(copy, parentM, pose.m)
      added.push(copy)
      modes.set(copy.id, src.attach ? src.attach.mode : 'free')
      if (id === c.id) topK.set(copy.id, k)
    }
  }
  c.sym = null
  d.comps.push(...added)
  // 逐件保锚（父在子前）：先以无锚自由件落下（位姿 = 派生件），再精确反解到锚上（取锚不动世界位姿，P 一直有效）。
  // 顶层副本（与主件同父）先取「镜像锚」：主件的锚经同一份对称变换落到的接口 / 平面——父件参数一改，主件与副本跟着同一对锚走、
  // 仍然对称（机身中线上的翼根接口镜像回自己：副本与主件共锚）；子树里的副本挂在副本父件上，按 pickAnchor 就近取（同名接口）
  const P = worldPoses(d)
  for (const copy of added) {
    const W = P.get(copy.id), Mp = P.get(copy.parent)
    if (!W || !Mp) continue
    const k = topK.get(copy.id), m0 = modes.get(copy.id)
    const ma = k && sy ? mirroredAnchor(d, P, c, copy, sy, k) : null
    if (!ma) attachByAnchor(d, P, copy, m0, W)
    else if (m0 === 'free') applyExact(copy, attachFromWorldExact(copy, Mp, W, 'free', ma.socket || ma.face, ma.uv))
    else if (ma.kind === 'socket') applyExact(copy, attachFromWorldExact(copy, Mp, W, 'socket', ma.socket))
    else applyExact(copy, attachFromWorldExact(copy, Mp, W, 'surface', ma.face))
  }
  return { ok: true }
}

/**
 * 拆分对称时顶层副本 copy 的镜像锚：主件 src 现在的锚（接口 / 平面；方式随原件）经对称第 k 份变换（sy：effSymOf）后落到父件的
 * 哪个接口 / 平面上。接口：位置差 ≤ max(5 mm, 5 % 名义尺寸)、法向同向；落回主件自己的接口（接口在对称面 / 轴上）→ 共锚；
 * 落到别的接口 → 须空闲（副本自己的子树不算）、可用、不是父件的安装接口。平面：面心与法向对上、面可装；带面锚自由件的 uv =
 * 主件锚点经同一变换后在新面上的面内坐标。柱面锚 / 对不上 → null（调用方退回 pickAnchor）。P = 拆分后文档的 worldPoses。
 * @returns {null | {kind:'socket', socket:object} | {kind:'face', face:object, uv:number[]}}
 */
function mirroredAnchor(d, P, src, copy, sy, k) {
  const p = compById(d, src.parent), Mp = P.get(src.parent)
  if (!p || !Mp) return null
  const pg = compGeo(p), cur = currentAnchor(src, pg)
  if (!cur) return null
  const inv = m4InvRigid(new Float64Array(16), Mp)
  const rot = (M, v) => [M[0] * v[0] + M[4] * v[1] + M[8] * v[2], M[1] * v[0] + M[5] * v[1] + M[9] * v[2], M[2] * v[0] + M[6] * v[1] + M[10] * v[2]]
  // 对称变换过本体系原点、是线性的：点与方向都用 symPoint
  const mapPt = (lp) => xfPt(inv, symPoint(sy, k, xfPt(Mp, lp))), mapDir = (ln) => rot(inv, symPoint(sy, k, rot(Mp, ln)))
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  if (cur.kind === 'socket') {
    const s = cur.socket, q = mapPt(s.pos), nn = mapDir(s.n), tol = Math.max(0.005, 0.05 * (s.size > 0 ? s.size : 0))
    // 接口原点在对称面 / 轴上（机身中线的翼根：法向镜像后反向，副本的翻面由 off / roll / tilt 表述）→ 与主件共锚
    if (d2(s.pos, q) <= tol * tol) return { kind: 'socket', socket: s }
    const hit = pg.sockets.find((x) => x.id !== s.id && d2(x.pos, q) <= tol * tol && dot(x.n, nn) > 1 - 1e-6)
    if (!hit) return null
    const occ = occupiedSocketKeys(d, P, new Set(subtreeOf(d, copy.id)))
    if (occ.has(`${p.id}|${hit.id}`) || ownMountIds(p, pg).includes(hit.id) || !socketUsable(p, hit, copy.type, pg)) return null
    return { kind: 'socket', socket: hit }
  }
  const f = cur.face
  if (f.kind === 'cyl') return null
  const o = mapPt(f.origin), nn = mapDir(f.n), tol = 1e-6 * Math.max(1, f.halfU, f.halfV)
  const hit = pg.faces.find((x) => x.kind !== 'cyl' && d2(x.origin, o) <= tol * tol && dot(x.n, nn) > 1 - 1e-6 && faceAccepts(pg.def, pg.params, x, copy.type))
  if (!hit) return null
  const uv = cur.uv, u0 = isNum(uv[0]) ? uv[0] : 0, v0 = isNum(uv[1]) ? uv[1] : 0
  faceFrame(T0, f, u0, v0)
  const ap = mapPt([T0[12], T0[13], T0[14]]), r = [ap[0] - hit.origin[0], ap[1] - hit.origin[1], ap[2] - hit.origin[2]]
  return { kind: 'face', face: hit, uv: [clean(dot(r, hit.u)), clean(dot(r, hit.v))] }
}

// ───────────────────────────── 编辑器内部命令（增 / 删 / 复制） ─────────────────────────────

/**
 * 加一个组件（编辑器松手 / 双击卡片）：spec = {type, params?, parent, attach, t?, q?, sym?, id?}。id 缺省按 compIdFor。
 * @returns {{ok:true, doc, id} | {ok:false, error}}
 */
export function addComp(doc, spec) {
  const d = normalizeAssembly(doc)
  const def = getComponent(spec && spec.type)
  if (!def) return fail('未知组件。')
  if (!def.domain.includes(d.domain)) return fail('该组件不能用于此领域。')
  const parent = spec.parent == null ? null : String(spec.parent)
  if (parent === null && d.comps.length) return fail('已有根件。')
  if (parent !== null && !compById(d, parent)) return fail('未找到组件。')
  const id = typeof spec.id === 'string' && COMP_ID_RE.test(spec.id) && !compById(d, spec.id) && !RESERVED_COMP_IDS.includes(spec.id) ? spec.id : compIdFor(d, spec.type)
  const c = { id, type: spec.type, params: isObj(spec.params) ? { ...spec.params } : {}, parent, attach: parent === null ? null : { ...(spec.attach || {}) } }
  if (parent !== null && c.attach.mode === 'free') { c.t = Array.isArray(spec.t) ? spec.t.map(clean) : [0, 0, 0]; c.q = Array.isArray(spec.q) ? spec.q.map(clean) : [0, 0, 0, 1] }
  if (parent !== null && spec.sym && !inSymSubtree(d, parent)) c.sym = spec.sym
  d.comps.push(c)
  return { ok: true, doc: normalizeAssembly(d), id }
}

/**
 * 删子树（主件连派生；多个 id 一起删）。根件在还有别的件时拒绝；子树里有锁定件拒绝。
 * @returns {{ok:true, doc, removed:string[]} | {ok:false, error}}
 */
export function removeComps(doc, ids) {
  const d = normalizeAssembly(doc)
  const drop = new Set()
  for (const id0 of ids || []) {
    const id = primaryIdOf(id0), c = compById(d, id)
    if (!c) continue
    if (c.parent == null && d.comps.length > 1) return fail('根件不能删除。')
    const sub = subtreeOf(d, id)
    if (sub.some((x) => compById(d, x).locked)) return fail('件已锁定。')
    for (const x of sub) drop.add(x)
  }
  if (!drop.size) return fail('未找到组件。')
  d.comps = d.comps.filter((c) => !drop.has(c.id))
  return { ok: true, doc: normalizeAssembly(d), removed: [...drop] }
}

/**
 * 复制子树（新 id；自带 sym 照留，子件的继承对称自然跟着复制）。原样安装（与原件重合），编辑器随后进入拾起放置。
 * 某个 id 的祖先也在 ids 里时只复制祖先那棵。
 * @returns {{ok:true, doc, map:Map<string,string>, roots:string[]} | {ok:false, error}}
 */
export function duplicateComps(doc, ids) {
  const d = normalizeAssembly(doc)
  const want = [...new Set((ids || []).map(primaryIdOf))].filter((id) => compById(d, id))
  const roots = want.filter((id) => !ancestorsOf(d, id).some((a) => want.includes(a)))
  if (!roots.length) return fail('未找到组件。')
  if (roots.some((id) => compById(d, id).parent == null)) return fail('根件不能复制。')
  const used = new Set(), map = new Map(), added = []
  for (const r of roots) {
    for (const id of subtreeOf(d, r)) {
      const src = compById(d, id)
      const nid = compIdFor({ drive: d.drive, comps: [...d.comps, ...added] }, src.type, used)
      map.set(id, nid)
      const copy = JSON.parse(JSON.stringify(src))
      copy.id = nid
      copy.parent = id === r ? src.parent : map.get(src.parent)
      copy.locked = false
      if (copy.sym) copy.sym = { ...copy.sym, group: nid }
      added.push(copy)
    }
  }
  d.comps.push(...added)
  return { ok: true, doc: normalizeAssembly(d), map, roots: roots.map((r) => map.get(r)) }
}
