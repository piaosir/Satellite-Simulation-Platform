// 装配页（P3，契约 scratchpad p3/CONTRACT.md §6）的纯逻辑：组件库分组 / 搜索、属性面板的参数行模型、结构树扁平化、
// 安装选项（父件 / 插座 / 面 / 安装插座）、位姿读数与自由件的反算、草稿取舍、工具状态的缺省与清洗。
// 无 three / vue / DOM —— node 单测直接 import（packages/core/test/modelAsmUi.test.mjs）。
//
// ★ 引 packages/core 一律走相对路径（不用 @core 别名）：单测是裸 node 跑的；渲染端 vite 对相对路径照样解析。
// ★ 组件清单一律 listComponents() 现取（A3 并行登记新领域组件，这里不写死任何 type）。
// ★ 界面零说明文字：口径 / 出处 / 范围一律进 title；这里拼的 title 串就是给悬停用的。
import { getComponent, getPreset, listComponents, fillParams, checkParams, socketAccepts, ASM_DOMAINS, COMPONENT_CATEGORIES, COMPONENT_FAMILIES } from '../../packages/core/models/components/index.mjs'
import { MATERIALS, DENSITY } from '../../packages/core/models/paramBus.mjs'
import { quatToMat, matToQuat, quatToEulerZYX, fineRotate } from '../../packages/core/models/bodyFrame.mjs'
import { MOVE_STEPS, MOVE_STEP_OPTS, ROT_STEPS, socketLabel, faceLabel, resolveMoveStep } from '../../packages/core/models/asmSnap.mjs'
import { asmHash, componentDensityKeys, componentBox } from '../../packages/core/models/assembly.mjs'
import { normText } from './wbLogic.js'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ───────────────────────────── 领域 / 角色 / 标签表 ─────────────────────────────

/** 「新建」菜单与副标题的领域顺序（= ASM_DOMAINS） */
export const NEW_DOMAINS = Object.freeze([...ASM_DOMAINS])
export const DOMAIN_LABELS = Object.freeze({ spacecraft: '卫星', ground: '地球站', aircraft: '飞机', ship: '船舶', vehicle: '车辆' })
export const DOMAIN_ICONS = Object.freeze({ spacecraft: 'satellite', ground: 'satellite-dish', aircraft: 'plane', ship: 'ship', vehicle: 'car' })
/** 组件库的功能分组（ComponentDef.category；顺序 = core COMPONENT_CATEGORIES）：显示名与组标题图标 */
export const CATEGORY_LABELS = Object.freeze({ structure: '结构与机构', power: '电源', antenna: '天线', payload: '有效载荷', propulsion: '推进', aocs: '姿轨控', thermal: '热控' })
export const CATEGORY_ICONS = Object.freeze({ structure: 'box', power: 'sun', antenna: 'satellite-dish', payload: 'scan-eye', propulsion: 'arrow-down', aocs: 'crosshair', thermal: 'grid-3x3' })
/** 组件库分组：功能分组 + 「其他」（没给 category 的）+ 「通用」（prim.* 基本体）；通用恒排最后 */
export const LIB_GROUP_LABELS = Object.freeze({ ...CATEGORY_LABELS, other: '其他', common: '通用' })
/** 功能分组下的组件族（ComponentDef.family；键与顺序 = core COMPONENT_FAMILIES）：显示名与小标题图标 */
export const FAMILY_LABELS = Object.freeze({
  body: '主体结构', aero: '机翼与尾翼', truss: '塔架与杆件', facility: '舱室与设施', dock: '对接与分离',
  reflector: '反射面天线', array: '阵列天线', horn: '喇叭与馈源', wire: '线天线', mount: '天线座', radome: '天线罩',
  thruster: '推力器与贮箱', powerplant: '动力装置'
})
export const FAMILY_ICONS = Object.freeze({
  body: 'box', aero: 'plane', truss: 'ruler', facility: 'package', dock: 'link-2',
  reflector: 'satellite-dish', array: 'grid-3x3', horn: 'radio-tower', wire: 'waves', mount: 'rotate-3d', radome: 'hexagon',
  thruster: 'flame', powerplant: 'rotate-cw'
})

/** 部件角色 → 图标（结构树行首、组件卡片占位） */
export const ROLE_ICONS = Object.freeze({
  bus: 'box', solarArray: 'solar-panel', reflector: 'satellite-dish', feed: 'radio-tower', boom: 'ruler',
  radiator: 'grid-3x3', thruster: 'flame', sensor: 'scan-eye', other: 'hexagon'
})
export const roleIcon = (role) => ROLE_ICONS[role] || 'hexagon'

/** 材质键 → 显示名（paramBus.MATERIALS 的键；A3 扩充的漆面键预先给名，查不到显示原键） */
export const MATERIAL_LABELS = Object.freeze({
  mli_gold: '金色 MLI', mli_silver: '银色 MLI', mli_black: '黑色 MLI', kapton_black: '黑色聚酰亚胺',
  solar_cell: '电池片', solar_substrate: '太阳翼基板', reflector: '反射面涂层', reflector_mesh: '金属网',
  aluminum: '铝', radiator: 'OSR 散热面', titanium: '钛', carbon: '碳纤维', white_paint: '白漆', glass: '玻璃', dark_metal: '深色金属',
  paint_red: '红漆', paint_navy: '深蓝漆', paint_blue: '蓝漆', paint_green: '绿漆', paint_orange: '橙漆', paint_yellow: '黄漆',
  paint_grey: '灰漆', rubber: '橡胶', concrete: '混凝土',
  gold_metal: '镀金金属', sunshield: '遮阳膜', ceramic: '陶瓷', black_paint: '消光黑漆', radome: '天线罩', copper: '裸铜', cell_si: '硅电池片'
})
export const materialLabel = (k) => (k == null || k === '' ? '组件缺省' : (MATERIAL_LABELS[k] || String(k)))
/** 材质下拉：'' = 组件缺省，其余按 MATERIALS 的键序 */
export function materialOptions() {
  return [{ value: '', label: '组件缺省' }, ...Object.keys(MATERIALS).map((k) => ({ value: k, label: materialLabel(k) }))]
}

/**
 * 枚举参数的选项显示名：ENUM_LABELS[参数键][取值]。同名键在不同组件里取值不冲突时共表；查不到退回材质名（MLI 包覆的选项就是材质键）、
 * 再退回原值。型号类选项（gat5530 / v130nx …）按产品名显示。
 */
export const ENUM_LABELS = Object.freeze({
  noseStyle: { airliner: '客机式', bizjet: '公务机式', uav: '无人机式', pod: '牵引发动机罩', hale: '高空长航时式' },
  planform: { helicopter: '直升机桨叶', propeller: '螺旋桨型' },
  tip: { square: '矩形', swept: '后掠', tapered: '梯形收窄' },
  hub: { articulated: '全铰接', hingeless: '无铰', compact: '电机罩式' },
  hand: { ccw: '逆时针', cw: '顺时针' },
  trSide: { left: '左侧', right: '右侧' },
  stab: { both: '两侧', right: '仅右侧', left: '仅左侧', none: '无' },
  gear: { sponson: '浮筒式（收起）', skid: '滑橇', legs: '支腿', none: '无' },
  layout: { x: 'X 形', plus: '十字形' },
  side: { right: '右', left: '左' },
  winglet: { none: '无', sharklet: '鲨鳍小翼', blended: '融合式小翼', raked: '斜削翼梢' },
  exhaust: { separate: '分开排气', mixed: '混合排气' },
  model: { gat5530: 'GAT-5530', v100nx: 'V100NX', v130nx: 'V130NX', v240m: 'V240M', 'kymeta-u8': 'Kymeta u8', 'inetvu-1202': 'iNetVu 1202', custom: '自定义' },
  style: { kingpost: '锥形立柱', tripod: '三脚架', suv: '越野车', pickup: '皮卡', van: '厢式车' },
  gimbal: { azel: '方位俯仰', xy: 'X-Y 座', none: '固定' },
  feedArm: { auto: '自动', boom: '单杆', tripod: '三杆' },
  kind: { corrugated: '波纹喇叭', horn: '喇叭', lnb: 'LNB', patch: '贴片', lae: '远地点发动机', rcs: '姿轨控推力器', ep: '电推力器', radiator: '散热面', cells: '体装电池片' },
  size: { '10ft': '10 ft', '20ft': '20 ft', '40ft': '40 ft', custom: '自定义' },
  form: { shelter: '方舱', container: '集装箱' },
  mli: { none: '无' },
  surface: { auto: '自动', solid: '实面', mesh: '网状' },
  feed: { horn: '喇叭', array: '阵列', none: '无' },
  bow: { bulb: '球鼻艏', plain: '普通艏' },
  stern: { transom: '方艉', cruiser: '巡洋舰艉' },
  palette: { mixed: '混色', mono: '单色' },
  paint: { white_paint: '白漆', titanium: '灰漆', dark_metal: '深色金属漆', aluminum: '银色金属漆' }
})
/**
 * 枚举选项的显示名：组件参数自带的 optionLabels（ParamSpec，各组件自定、不串键）> ENUM_LABELS[参数键] > 材质名 > 原值。
 * spec 可省（老调用）。
 */
export function enumLabel(key, value, spec) {
  if (value === null) return '自动'
  const ol = spec && spec.optionLabels
  if (ol && Object.hasOwn(ol, String(value))) return ol[String(value)]
  const t = ENUM_LABELS[key]
  if (t && Object.hasOwn(t, value)) return t[value]
  if (typeof value === 'string' && Object.hasOwn(MATERIAL_LABELS, value)) return MATERIAL_LABELS[value]
  return String(value)
}

/** 密度表显示名（与生成页同一套；查不到的键显示原键） */
export const DENSITY_LABELS = Object.freeze({
  busVolume: '星体', panelAreal: '太阳翼基板', cellAreal: '电池片', reflectorAreal: '实面反射面', meshReflectorAreal: '网状反射面',
  mliAreal: 'MLI', radiatorAreal: '散热面 OSR', hornAreal: '喇叭', towerAreal: '天线塔', arrayAreal: '相控阵', boomLinear: '杆件',
  laeMass: '远地点发动机', rcsMass: '姿轨控推力器', epMass: '电推力器',
  apmMass: '双轴指向机构', helixMass: '螺旋阵元', lgaMass: '全向天线', lctMass: '激光通信终端', tankAreal: '贮箱壳体', opticsAreal: '光学相机', lraAreal: '激光角反射器', magMass: '磁强计',
  epJointMass: '电推臂关节', visorAreal: '遮阳板', baptaMass: '消旋组件', flexAreal: '柔性太阳帆', cubesatMass: '立方星（每 1U）', moduleVolume: '舱段'
})
/** 主结构体密度（busVolume 键）按领域的显示名：「星体」是卫星用语，飞机 / 船 / 车 / 地球站各用各的。键名不变。 */
export const BUS_VOLUME_LABELS = Object.freeze({ spacecraft: '星体', aircraft: '机体', ship: '船体', vehicle: '车体', ground: '结构' })
/** 整件的叫法（结构树根节点、整体质量行）：整星 / 整站 / 整机 / 全船 / 整车 */
export const ROOT_LABELS = Object.freeze({ spacecraft: '整星', ground: '整站', aircraft: '整机', ship: '全船', vehicle: '整车' })
// 模型类别（schema.MODEL_KINDS）→ 领域：空间站 / 载人 / 深空都按卫星叫；运载器、部件、其他没有专门叫法
const KIND_DOMAIN = Object.freeze({ spacecraft: 'spacecraft', station: 'spacecraft', crewed: 'spacecraft', deepspace: 'spacecraft', ground: 'ground', aircraft: 'aircraft', ship: 'ship', vehicle: 'vehicle' })
/**
 * 整体质量的叫法（快速设置 / 属性面板三处统一一个口径）：领域或模型类别 → 「整星质量」「整机质量」「全船质量」「整车质量」「整站质量」；
 * 认不出的类别（运载器 / 部件 / 其他）→「整件质量」。飞机、船不再显示「整星」。
 */
export function wholeMassLabel(domainOrKind) {
  const d = KIND_DOMAIN[domainOrKind]
  return (d ? ROOT_LABELS[d] : '整件') + '质量'
}
/**
 * 组件（按参数）生成时实际读了密度表的哪些键：拿一个记录读取的密度表跑一次 build（结果按 type + 参数缓存；参数非法 / 生成失败 → 空）。
 * 注册表动态：A3 新登记的领域件不读密度表（质量走自己的参数），自然不出现在密度节里。
 */
const densUse = new Map()
export function densityKeysOf(type, params) {
  const def = getComponent(type)
  if (!def) return []
  const p = fillParams(def, params)
  const key = type + '|' + JSON.stringify(def.keys.map((k) => p[k]))
  let out = densUse.get(key)
  if (out) return out
  // 生成时顺手记下的读取键（assembly 生成缓存的轻层：编辑器里已生成过的件直接命中，不为这个另跑一遍生成）
  out = Object.freeze(componentDensityKeys(type, p))
  if (densUse.size > 400) densUse.clear()
  densUse.set(key, out)
  return out
}
/**
 * 文档属性的密度行（显示名 / 单位 / 缺省值 / 悬停口径）。给了 doc 时只列「文档内各件 ∪ 本领域组件（缺省参数）」生成时实际读到的键，
 * 外加文档里已经改过的键（改过的总要看得见、能清）；不给 doc 列 DENSITY 全部键。
 * @param {object|null} density 文档 density
 * @param {{domain?:string, comps?:object[]}|null} [doc]
 */
export function densityRows(density, doc = null, o = {}) {
  const d = isObj(density) ? density : {}
  let keys = Object.keys(DENSITY)
  if (doc) {
    const used = new Set(Object.keys(d).filter((k) => Object.hasOwn(DENSITY, k) && isNum(d[k])))
    // 本领域组件（缺省参数）读到的键：调用方给了现成的（o.domainKeys，属性面板在 Worker 里算好的）就用它，不在主线程把整个领域生成一遍
    if (Array.isArray(o.domainKeys)) for (const k of o.domainKeys) used.add(k)
    else for (const def of listComponents(doc.domain)) for (const k of densityKeysOf(def.type, {})) used.add(k)
    for (const c of Array.isArray(doc.comps) ? doc.comps : []) for (const k of densityKeysOf(c.type, c.params)) used.add(k)
    keys = keys.filter((k) => used.has(k))
  }
  const busLab = doc && Object.hasOwn(BUS_VOLUME_LABELS, doc.domain) ? BUS_VOLUME_LABELS[doc.domain] : null
  return keys.map((k) => ({
    key: k, label: k === 'busVolume' && busLab ? busLab : (DENSITY_LABELS[k] || k), unit: DENSITY[k].unit, def: DENSITY[k].value,
    value: isNum(d[k]) ? d[k] : null,
    title: (DENSITY[k].source === 'illustrative' ? '示意值：' : '出处：' + DENSITY[k].source + '\n') + (DENSITY[k].note || '') +
      (k === 'busVolume' ? '\n密度表键 busVolume（各领域主结构体共用一个键）' : '')
  }))
}

export const SYM_UI = Object.freeze([
  { key: 'none', label: '无', short: '无', tip: '无对称' },
  { key: 'mirrorXZ', label: '镜像 XZ', short: 'XZ', tip: '镜像 XZ：关于本体 XZ 面镜像（±Y 成对，如一对太阳翼）' },
  { key: 'mirrorYZ', label: '镜像 YZ', short: 'YZ', tip: '镜像 YZ：关于本体 YZ 面镜像（±X 成对，如东西两副反射面）' },
  { key: 'radial', label: '径向', short: '径向', tip: '径向：绕轴均布 N 件（卫星 / 地球站 / 船舶 / 车辆绕本体 Z，飞机绕机身 X）' }
])
export const SYM_AXIS_OPTIONS = Object.freeze(['+X', '-X', '+Y', '-Y', '+Z', '-Z'])
export const SPACE_UI = Object.freeze([
  { key: 'body', label: '本体', tip: '本体系：手柄 = 本体 X / Y / Z（与本体轴叠加同色）' },
  { key: 'local', label: '局部', tip: '局部：手柄随组件自身取向' },
  { key: 'mount', label: '安装面', tip: '安装面：手柄取父件的安装锚点系（接口 / 面安装件固定为此档）' }
])
export const MODE_UI = Object.freeze([
  { key: 'socket', label: '接口', tip: '本件安装接口与父件接口对接：接口系内偏移 + 绕接口法向滚转 + 两轴倾角；世界位姿保持，就近取接口' },
  { key: 'surface', label: '面安装', tip: '安装于父件表面：面内 u / v + 法向偏移 + 绕法向滚转 + 两轴倾角；世界位姿保持，就近取面' },
  { key: 'free', label: '自由', tip: '6 自由度位姿；保留现有锚点（接口 / 面），位姿相对锚点系' }
])
const SPACE_KEYS = SPACE_UI.map((s) => s.key)
/** Q 键：本体 → 局部 → 安装面 → 本体 */
export const nextSpace = (s) => SPACE_KEYS[(SPACE_KEYS.indexOf(s) + 1) % SPACE_KEYS.length]

// ───────────────────────────── 工具状态（localStorage model/asm/ui）─────────────────────────────

export const UI_KEY = 'model/asm/ui'
/**
 * snap.move：平移吸附步长（asmSnap.MOVE_STEP_OPTS：'auto' 或米）；出厂「自动」（锚面短边 / 20 取 1-2-5 档）。
 * snap.moveSet：用户在功能区手动选过步长（之后按所选；没选过的一律跟出厂缺省走）。
 */
export const UI_DEFAULTS = Object.freeze({
  tool: 'move', space: 'body', snap: Object.freeze({ on: true, move: 'auto', rot: 15, moveSet: false }), sym: Object.freeze({ op: 'none', n: 2 }),
  dockW: 320, split: 0.42, libQ: '', secOpen: Object.freeze({}), posePreview: false, showCom: true, showSockets: true, showAxes: true, posFrame: 'parent'
})
/** 2026-10 之前的出厂平移步长：老偏好里没有 moveSet 标志、值又等于它的，视为从未显式设置（改走新出厂「自动」） */
const LEGACY_MOVE_DEFAULT = 0.05
export const DOCK_W_MIN = 260, DOCK_W_MAX = 520
/** 本机存的工具状态 → 合法值（坏值逐项回缺省；这是便利数据，丢了、改坏了都不许把页面带崩） */
export function sanitizeUi(raw) {
  const r = isObj(raw) ? raw : {}
  const d = UI_DEFAULTS
  const snap = isObj(r.snap) ? r.snap : {}
  const sym = isObj(r.sym) ? r.sym : {}
  const sec = {}
  if (isObj(r.secOpen)) for (const [k, v] of Object.entries(r.secOpen)) if (typeof v === 'boolean' && k.length <= 64) sec[k] = v
  // 平移步长：手动选过（moveSet）→ 按所选；老偏好（无标志）只有改过出厂值的才算显式设置；其余 → 出厂「自动」
  const moveSet = snap.moveSet === true ? MOVE_STEP_OPTS.includes(snap.move) : (MOVE_STEPS.includes(snap.move) && snap.move !== LEGACY_MOVE_DEFAULT)
  return {
    tool: r.tool === 'rotate' ? 'rotate' : 'move',
    space: SPACE_KEYS.includes(r.space) ? r.space : d.space,
    snap: {
      on: typeof snap.on === 'boolean' ? snap.on : d.snap.on,
      move: moveSet ? snap.move : d.snap.move,
      rot: ROT_STEPS.includes(snap.rot) ? snap.rot : d.snap.rot,
      moveSet
    },
    sym: {
      op: SYM_UI.some((s) => s.key === sym.op) ? sym.op : d.sym.op,
      n: Number.isInteger(sym.n) && sym.n >= 2 && sym.n <= 8 ? sym.n : d.sym.n
    },
    dockW: isNum(r.dockW) ? Math.min(DOCK_W_MAX, Math.max(DOCK_W_MIN, Math.round(r.dockW))) : d.dockW,
    split: isNum(r.split) ? Math.min(0.8, Math.max(0.15, r.split)) : d.split,
    libQ: typeof r.libQ === 'string' ? r.libQ.slice(0, 80) : '',
    secOpen: sec,
    posePreview: r.posePreview === true,
    showCom: typeof r.showCom === 'boolean' ? r.showCom : d.showCom,
    showSockets: typeof r.showSockets === 'boolean' ? r.showSockets : d.showSockets,
    showAxes: typeof r.showAxes === 'boolean' ? r.showAxes : d.showAxes,
    posFrame: r.posFrame === 'body' ? 'body' : 'parent'
  }
}

// ───────────────────────────── 组件库 ─────────────────────────────
//
// 2026-10-12 组件不限领域（components/index.mjs：def.domain 只是常用领域）：组件库按功能分组 → 组件族排，列全部组件——
// 地球站 / 飞机 / 船 / 车的文档里也看得到并能装卫星相控阵、螺旋天线、太阳翼，卫星文档里也有地面站馈源、天线罩。
// 当前领域（装配文档的领域）只决定两件事：族内常用于当前领域的件排前面；别的领域的件在卡片角上标它的设计领域（domainBadge）。
// 库页「组件」档（浏览，不带当前领域）：不分常用与否、不标角标，可按领域筛（libGroups 的 o.only）。

/** 组件的库分组键：prim.* 归「通用」，其余按功能分组（没给 category 的归「其他」） */
export const libGroupOf = (def) => (def && typeof def.type === 'string' && def.type.startsWith('prim.') ? 'common' : (def && def.category) || 'other')
/** 组件常用于领域 domain（def.domain 含它；基本体五个领域都含）。domain 空 = 不分（库页浏览）→ 真 */
export const nativeTo = (def, domain) => !!def && (!domain || (Array.isArray(def.domain) && def.domain.includes(domain)))
/** 组件常用领域的显示名（「地球站 / 船舶 / 车辆」：悬停与角标用） */
export const domainsText = (def) => (def && Array.isArray(def.domain) ? def.domain.map((d) => DOMAIN_LABELS[d] || d).join(' / ') : '')
/**
 * 卡片角标（组件不常用于当前领域时，标它的设计领域 = domain 首项）：{domain, icon, tip}；常用于当前领域 / 没有当前领域 / 基本体 → null。
 * tip 是悬停「常用于：卫星」。
 */
export function domainBadge(def, domain) {
  if (!def || !domain || nativeTo(def, domain) || !Array.isArray(def.domain) || !def.domain.length) return null
  const home = def.domain[0]
  return { domain: home, icon: DOMAIN_ICONS[home] || 'hexagon', tip: '常用于：' + domainsText(def) }
}

/** 组件是否匹配搜索词（中英文名、type、别名、功能分组 / 组件族名、参数标签；大小写 / 全角半角 / 连字符不计） */
export function compMatches(def, q) {
  const nq = normText(q)
  if (!nq) return true
  const hay = [def.titleZh, def.title, def.type, ...(Array.isArray(def.aliases) ? def.aliases : []), CATEGORY_LABELS[def.category], FAMILY_LABELS[def.family]]
  for (const k of def.keys || []) { const s = def.params[k]; if (s) hay.push(s.label, s.labelEn) }
  return hay.some((s) => s && normText(s).includes(nq))
}

/**
 * 组件库条目：组件本身（缺省参数）+ 它的各个常用型号（ComponentDef.presets，各占一张卡片、拖入即带这组参数）。
 * 条目 = {key（卡片键 / 缩略图缓存键：type 或 `${type}#${型号 id}`）, type, preset（型号 id | null）, def, titleZh, title, role,
 *        category / family（型号可另给，如体装电池片归电源、机械消旋归反射面；只改分组没给族时族空）, params（型号参数 | null）, aliases,
 *        native（常用于 domain；domain 空 = 真）, badge（domainBadge(def, domain)）}
 * @param {object} def
 * @param {string|null} [domain] 当前装配文档领域（null = 库页浏览：不分常用、不标角标）
 */
export function libEntries(def, domain = null) {
  const native = nativeTo(def, domain), badge = domainBadge(def, domain)
  const out = [{ key: def.type, type: def.type, preset: null, def, titleZh: def.titleZh, title: def.title, role: def.role, category: def.category, family: def.family, params: null, aliases: Array.isArray(def.aliases) ? def.aliases : [], native, badge }]
  for (const p of Array.isArray(def.presets) ? def.presets : []) {
    const cat = p.category || def.category
    const fam = p.family || (cat === def.category ? def.family : undefined)
    out.push({ key: `${def.type}#${p.id}`, type: def.type, preset: p.id, def, titleZh: p.titleZh, title: p.title, role: def.role, category: cat, family: fam, params: p.params, aliases: Array.isArray(p.aliases) ? p.aliases : [], native, badge })
  }
  return out
}
/** 库卡片键 → {type, params}（params：型号参数的拷贝；组件本身 / 型号已不存在 → {}） */
export function libKeyParams(key) {
  const s = String(key || ''), i = s.indexOf('#')
  if (i < 0) return { type: s, params: {} }
  const type = s.slice(0, i), p = getPreset(type, s.slice(i + 1))
  return { type, params: p ? { ...p.params } : {} }
}
/** 库条目是否匹配搜索词：组件本身同 compMatches；型号按型号名 / 别名 / id，外加所属组件名、分组 / 族名（搜「螺旋天线」列出全部螺旋型号） */
export function entryMatches(e, q) {
  if (!e.preset) return compMatches(e.def, q)
  const nq = normText(q)
  if (!nq) return true
  const hay = [e.titleZh, e.title, e.type, e.preset, e.def.titleZh, e.def.title, ...e.aliases, CATEGORY_LABELS[e.category], FAMILY_LABELS[e.family]]
  return hay.some((s) => s && normText(s).includes(nq))
}

const FAMILY_ORDER = Object.freeze(Object.keys(COMPONENT_FAMILIES))
/** 族内排序：常用于当前领域的条目在前、其余在后，各自保持登记顺序（稳定划分；型号紧跟组件本身不变） */
const nativeFirst = (items) => { const a = [], b = []; for (const e of items) (e.native ? a : b).push(e); return b.length && a.length ? a.concat(b) : items }

/**
 * 组件库分组（全部组件——2026-10-12 起任何组件都能装进任何领域的装配件；登记顺序，组件后紧跟它的常用型号）：
 *   组 = 功能分组（COMPONENT_CATEGORIES 顺序），没给 category 的归「其他」、基本体归「通用」，两者排在最后（通用恒为末组）；
 *   组内有条目带 family 时另给 subs：按 COMPONENT_FAMILIES 顺序的组件族（反射面天线 / 阵列天线 / …），没带族的归「其他」小组排最后；
 *   族内（没分族的组内）常用于 domain 的条目在前（nativeFirst）。items 是全组扁平表、与 subs 拼起来同序（计数 / 懒取缩略图照旧用它）。
 * 条目形状见 libEntries（带 native / badge）。
 * @param {string|null} domain 当前装配文档领域（null = 库页浏览：不分常用、不标角标）
 * @param {string} [q] 搜索词
 * @param {object[]} [defs] 组件定义表（缺省 listComponents()；单测注入）
 * @param {{only?:string}} [o] only = 只列常用于该领域的组件（库页「领域」筛选；基本体恒在）
 * @returns {{key:string, label:string, icon:string, items:object[], subs?:{key:string, label:string, icon:string, items:object[]}[]}[]}
 */
export function libGroups(domain, q = '', defs, o = {}) {
  const list = Array.isArray(defs) ? defs : listComponents()
  const only = o && typeof o.only === 'string' && o.only ? o.only : null
  const by = new Map()
  for (const d of list) {
    if (only && !nativeTo(d, only)) continue
    const common = libGroupOf(d) === 'common'
    for (const e of libEntries(d, domain || null)) {
      if (!entryMatches(e, q)) continue
      const k = common ? 'common' : (e.category || 'other')   // 型号可另归分组（体装电池片 → 电源）
      if (!by.has(k)) by.set(k, [])
      by.get(k).push(e)
    }
  }
  const order = [...COMPONENT_CATEGORIES, 'other', 'common']
  const keys = [...order.filter((k) => by.has(k)), ...[...by.keys()].filter((k) => !order.includes(k))]
  return keys.map((k) => {
    const all = by.get(k)
    const g = { key: k, label: LIB_GROUP_LABELS[k] || k, icon: k === 'common' ? 'boxes' : (CATEGORY_ICONS[k] || 'hexagon'), items: all }
    if (k !== 'common' && all.some((e) => e.family)) {
      const fams = new Map()
      for (const e of all) { const f = e.family && Object.hasOwn(FAMILY_LABELS, e.family) ? e.family : 'other'; if (!fams.has(f)) fams.set(f, []); fams.get(f).push(e) }
      g.subs = [...FAMILY_ORDER, 'other'].filter((f) => fams.has(f)).map((f) => ({ key: k + '-' + f, label: FAMILY_LABELS[f] || '其他', icon: FAMILY_ICONS[f] || 'hexagon', items: nativeFirst(fams.get(f)) }))
      g.items = g.subs.flatMap((s) => s.items)
    } else g.items = nativeFirst(all)
    return g
  })
}

// 库卡片悬停：名称 / 英文名 /（型号卡片）所属组件 / 常用领域 / 操作要点 / type（末行恒为 type；型号卡片为「type · 型号 id」）。操作要点只放悬停，不占界面
// 放置中（库拖入 / 重新放置 / 复制后放置）的键位：功能区「吸附」「重新放置」与组件卡片悬停同一份
export const PLACE_KEYS_TIP = '放置中：Q / E 滚转，Tab 切换落点候选，B 切换安装接口，按住 Alt 移动指针旋转视角，按住 Shift 不吸附，右键或 Esc 取消'
const LIB_DRAG_TIP = '拖入视口安装：以指针所指的件为安装目标，优先匹配专用接口；拖至结构树某一行 = 安装到该件\n' +
  '拖动中：Q / E 旋转朝向，Tab 切换落点候选，B 切换安装接口，按住 Alt 移动指针旋转视角，滚轮缩放，按住 Shift 不吸附，Esc 或右键取消\n' +
  '双击：安装到选中件'
// 库页「组件」档（浏览）：没有视口编辑器可拖，双击 = 以这一件为根件新建装配件
const LIB_BROWSE_TIP = '双击：以此为根件新建装配件\n右键：添加到当前设计'
/**
 * 组件卡片悬停串。o.browse = 库页浏览（操作要点换成浏览档的）。常用领域一行只给不是基本体的件（基本体五个领域都常用）。
 */
export const compTip = (e, o = {}) => [e.titleZh, e.title && e.title !== e.titleZh ? e.title : '', e.preset && e.def ? '组件：' + e.def.titleZh : '',
  e.def && !String(e.type).startsWith('prim.') && domainsText(e.def) ? '常用于：' + domainsText(e.def) : '',
  o && o.browse ? LIB_BROWSE_TIP : LIB_DRAG_TIP,
  e.preset ? `${e.type} · ${e.preset}` : e.type].filter(Boolean).join('\n')

/** 平移吸附步长下拉的显示：'auto' → 「自动」，数值 → 「0.05 m」 */
export const moveStepLabel = (v) => (v === 'auto' ? '自动' : `${v} m`)
/** 步长读数（米 → 「0.02 m」；三位有效，不出科学计数法） */
export const fmtStep = (m) => (typeof m === 'number' && m > 0 ? `${String(+m.toPrecision(3))} m` : '')

// ───────────────────────────── 参数行模型（属性面板） ─────────────────────────────

const fmtBound = (v) => String(+Number(v).toPrecision(6))
/** 参数的范围短语（悬停用）：[min, max] / > gt / ≥ min / ≤ max */
export function paramRange(s) {
  if (!s || (s.kind !== 'num' && s.kind !== 'int') || Array.isArray(s.options)) return ''
  const u = s.unit ? ' ' + s.unit : ''
  const lo = isNum(s.gt) ? '> ' + fmtBound(s.gt) : isNum(s.min) ? '≥ ' + fmtBound(s.min) : ''
  const hi = isNum(s.max) ? '≤ ' + fmtBound(s.max) : ''
  if (isNum(s.min) && isNum(s.max) && !isNum(s.gt)) return `范围 ${fmtBound(s.min)} – ${fmtBound(s.max)}${u}`
  const both = [lo, hi].filter(Boolean).join('，')
  return both ? `范围 ${both}${u}` : ''
}
/**
 * 参数悬停三行：口径 / 示意值或出处 / 范围。pv = 模板带来的出处（{urls, derive}，见 templateSources）：给了就用它替换
 * 组件 ParamSpec 的「示意值」——模板里有出处的值（翼展、俯仰轴高、车长…）悬停显示 URL 与派生式，不再写成示意值。
 */
export function paramTitle(s, pv = null) {
  if (!s) return ''
  const src = pv && Array.isArray(pv.urls) && pv.urls.length
    ? [...pv.urls.map((u) => '出处：' + u), pv.derive ? '派生：' + pv.derive : ''].filter(Boolean).join('\n')
    : s.source === 'illustrative' ? '示意值' : (s.source ? '出处：' + s.source : '')
  return [s.title, src, paramRange(s)].filter(Boolean).join('\n')
}
/** 模板出处记下的值与当前值是否仍相同（数值按 1e-9 相对容差）：不同就说明被改过，不再标出处。 */
const sameProvValue = (a, b) => (isNum(a) && isNum(b) ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)) : a === b)

/**
 * checkParams 的报错按参数键归档：{byKey:{key: 状态短语}, general:[组件级约束]}。
 * 前缀用 '§'（组件参数键只含字母数字，不会撞）。
 */
export function paramErrors(def, params) {
  const out = { byKey: {}, general: [] }
  if (!def) return out
  let errs = []
  try { errs = checkParams(def, fillParams(def, params), '§') } catch (e) { errs = ['§：' + ((e && e.message) || String(e))] }
  for (const e of errs) {
    const m = /^§\.([A-Za-z0-9_]+)：(.*)$/.exec(e)
    if (m && !out.byKey[m[1]]) out.byKey[m[1]] = m[2]
    else if (!m) out.general.push(e.replace(/^§：/, ''))
  }
  return out
}

/**
 * 属性面板的参数行（按 def.keys 顺序）。
 *   control：'num'（NumIn；int 无选项时 integer）/ 'select'（enum，或 int 带选项）/ 'bool'（复选框：参数才用复选框）
 *   select 的 options：[{value, label}]；可空的补「自动」（value null）
 *   bad：该键有校验错误，或是模板示意值且用户还没改过（ctx.prov.illustrative 含 `${compId}.${key}`、touched 不含）
 * @param {object} def ComponentDef
 * @param {object} params 组件参数（未补缺省也可）
 * @param {{compId?:string, prov?:{illustrative?:string[], touched?:string[]}|null}} [ctx]
 */
export function paramRows(def, params, ctx = {}) {
  if (!def) return []
  const p = fillParams(def, params)
  const errs = paramErrors(def, p)
  const ill = new Set(ctx.prov && Array.isArray(ctx.prov.illustrative) ? ctx.prov.illustrative : [])
  const touched = new Set(ctx.prov && Array.isArray(ctx.prov.touched) ? ctx.prov.touched : [])
  const srcs = ctx.prov && isObj(ctx.prov.sources) ? ctx.prov.sources : null
  const keySet = new Set(keyParamsOf(def))
  return def.keys.map((key) => {
    const s = def.params[key]
    const path = `${ctx.compId || ''}.${key}`
    const err = errs.byKey[key] || ''
    const illustrative = ill.has(path) && !touched.has(path)
    // 模板出处：路径在 sources 里、用户没改过、值仍是复制时那个 → 悬停写出处与派生式（替换组件口径的「示意值」）
    const sv = srcs && Object.hasOwn(srcs, path) && isObj(srcs[path]) ? srcs[path] : null
    const pv = sv && Array.isArray(sv.urls) && !touched.has(path) && sameProvValue(sv.value, p[key]) ? sv : null
    const row = {
      key, path, label: s.label, unit: s.unit || '', value: p[key], err, illustrative, main: keySet.has(key),
      provenance: pv ? { urls: pv.urls.slice(), derive: pv.derive || null } : null,
      bad: !!err || illustrative,
      title: [paramTitle(s, pv), illustrative ? '模板示意值' : '', err].filter(Boolean).join('\n'),
      control: 'num', integer: false, allowEmpty: !!s.nullable, placeholder: s.nullable ? '自动' : '',
      min: isNum(s.min) ? s.min : -Infinity, max: isNum(s.max) ? s.max : Infinity, options: null
    }
    if (s.kind === 'bool') row.control = 'bool'
    else if (s.kind === 'enum' || (s.kind === 'int' && Array.isArray(s.options))) {
      row.control = 'select'
      row.options = s.options.map((v) => ({ value: v, label: s.kind === 'enum' ? enumLabel(key, v, s) : (s.optionLabels && Object.hasOwn(s.optionLabels, String(v)) ? s.optionLabels[String(v)] : String(v)) }))
      if (s.nullable) row.options.unshift({ value: null, label: '自动' })
    } else if (s.kind === 'int') row.integer = true
    return row
  })
}
/**
 * 组件的「主要参数」：快速设置（普通装配件）与属性面板第一档只列这些，其余收进「细节参数」（专业设置照样全量可改）。
 * 取舍：决定外形与用途的尺度 / 型式（口径、翼展、基板数、座架、船长…）进主要；示意细节（分段、离面、内缩、桁架比、面密度…）不进。
 * 表里没有的组件退回「前三个数值参数」。键名照组件定义，查不到的键自动略过。
 */
export const KEY_PARAMS = Object.freeze({
  'prim.box': ['xM', 'yM', 'zM'], 'prim.cyl': ['dM', 'hM'],
  'sat.bus.box': ['xM', 'yM', 'zM', 'mli'], 'sat.bus.cyl': ['dM', 'hM', 'mli', 'drumCells'], 'sat.bus.hex': ['acrossFlatsM', 'hM', 'mli'],
  'sat.wing': ['panels', 'panelHM', 'panelWM', 'sidePanels', 'yokeLenM', 'tiltDeg', 'cellType'],
  'sat.wing.hinged': ['lengthM', 'widthM', 'rows', 'cols', 'deployDeg', 'cellType'], 'sat.wing.flex': ['lengthM', 'blanketWM', 'segments', 'mastDM', 'tiltDeg', 'cellType'],
  'sat.wing.rosa': ['lengthM', 'widthM', 'boomDM', 'rollDM', 'tiltDeg', 'cellType'], 'sat.wing.circular': ['diameterM', 'gores', 'sweepDeg', 'yokeLenM', 'tiltDeg', 'cellType'],
  'sat.reflector': ['diameterM', 'focalM', 'offsetHM', 'surface', 'feed', 'front', 'support'],
  'sat.feed.horn': ['kind', 'apertureM', 'apertureBM', 'style', 'finish'], 'sat.array.phased': ['wM', 'hM', 'shape', 'face', 'freqGHz', 'tiles'], 'sat.tower': ['wM', 'hM', 'finish'],
  'sat.boom': ['lengthM', 'dM', 'style'], 'sat.thruster': ['kind', 'exitDM', 'pair'], 'sat.radiator': ['kind', 'wM', 'hM'],
  'sat.antenna.gimbal': ['diameterM', 'feed', 'gimbal', 'azDeg', 'tiltDeg'], 'sat.antenna.helix': ['layout', 'freqGHz', 'turns', 'nInner', 'nOuter', 'gridN'],
  'sat.antenna.omni': ['kind', 'freqGHz', 'style', 'cantDeg'], 'sat.feed.cluster': ['rings', 'hornDM', 'style', 'finish'],
  'sat.lct': ['type', 'apertureM', 'azDeg', 'tiltDeg'], 'sat.camera': ['type', 'apertureM', 'lengthM', 'cutDeg'], 'sat.lra': ['layout', 'rings', 'ringN', 'cubeDM'],
  'sat.tank': ['shape', 'diameterM', 'lengthM', 'propellant', 'fill'], 'sat.sensor.mag': ['type', 'scale'],
  'sat.antenna.lpda': ['fLowGHz', 'fHighGHz', 'tau', 'crossed', 'finish'], 'sat.antenna.shroud': ['style', 'baseDM', 'topDM', 'heightM', 'finish'],
  'sat.antenna.slot': ['bars', 'freqGHz', 'lengthM', 'fanDeg'], 'sat.instrument': ['xM', 'yM', 'zM', 'window', 'cooler'],
  'sat.bus.trap': ['lengthM', 'nadirWM', 'zenithWM', 'depthM', 'mli'], 'sat.bus.prism': ['sides', 'diameterM', 'hM', 'mli'],
  'sat.bus.cubesat': ['xM', 'yM', 'zM', 'skin'], 'sat.bus.sphere': ['diameterM', 'form', 'lonSeg', 'latSeg', 'reflectors'],
  'sat.bus.module': ['dLargeM', 'lLargeM', 'coneLenM', 'dSmallM', 'lSmallM', 'front', 'aft'], 'sat.bus.flat': ['xM', 'yM', 'zM', 'chamferM', 'nadir'],
  'sat.dock': ['type', 'sizeM', 'lengthM'],
  'sat.ep.arm': ['arm', 'thrusters', 'rootDeg', 'elbowDeg', 'tiltDeg', 'finish'], 'sat.visor': ['widthM', 'depthM', 'panels', 'deployDeg', 'finish'],
  'sat.antenna.despun': ['kind', 'diameterM', 'heightM', 'azDeg', 'elevDeg'],
  'sat.sensor.star': ['type', 'bodyM', 'hoodDM', 'cantDeg'], 'sat.sensor.sun': ['type', 'wM', 'lM'],
  'sat.sensor.earth': ['type', 'scale'], 'sat.antenna.ttc': ['kind', 'band', 'mastLenM'],
  'es.pedestal.azel': ['style', 'elAxisHM', 'azTravelDeg'], 'es.pedestal.xy': ['xAxisHM', 'limitDeg'],
  'es.refl.prime': ['diameterM', 'fD', 'gimbal', 'el0Deg'], 'es.refl.cass': ['diameterM', 'fD', 'subDM', 'gimbal', 'el0Deg'],
  'es.refl.offset': ['diameterM', 'offsetDeg', 'gimbal', 'el0Deg'], 'es.subrefl': ['diameterM'], 'es.feed': ['kind', 'apertureDM'],
  'es.radome': ['diameterM', 'heightM', 'translucent'], 'es.shelter': ['size', 'lengthM', 'widthM', 'heightM'],
  'es.tower': ['heightM', 'baseWM', 'topWM'], 'es.vsat.mount': ['frameM', 'mastHM'], 'es.pedestal.wheeltrack': ['elAxisHM', 'railDM'], 'es.mast': ['heightM', 'mastDM'],
  'air.fuselage': ['lengthM', 'widthM', 'heightM', 'noseStyle'], 'air.wing': ['spanM', 'rootChordM', 'sweepDeg', 'engines'],
  'air.htail': ['spanM', 'rootChordM'], 'air.vtail': ['heightM', 'rootChordM'], 'air.nacelle': ['diameterM', 'lengthM'], 'air.prop': ['diameterM', 'blades'],
  'air.radome': ['model', 'lengthM', 'heightM', 'antenna'], 'air.turret': ['diameterM'],
  'air.heli': ['lengthM', 'widthM', 'heightM', 'trSide', 'gear'], 'air.mrbody': ['arms', 'layout', 'wheelbaseM', 'heightM', 'gear'],
  'air.boom': ['lengthM', 'diameterM', 'fwdFrac'], 'air.rotor': ['diameterM', 'blades', 'planform', 'hand'],
  'sea.hull': ['loaM', 'beamM', 'depthM', 'draftM'], 'sea.superstructure': ['lengthM', 'widthM', 'tiers'], 'sea.funnel': ['heightM'],
  'sea.mast': ['heightM', 'radars'], 'sea.containers': ['size', 'bays', 'rows', 'tiers'], 'sea.vsat.radome': ['model', 'diameterM', 'reflectorDM'],
  'veh.body': ['style', 'lengthM', 'widthM', 'heightM'], 'veh.cotm.flat': ['model', 'lengthM', 'widthM'], 'veh.driveaway': ['model', 'lengthM']
})
/** 组件定义 → 主要参数键（按 KEY_PARAMS；表里没有的取前三个数值参数） */
export function keyParamsOf(def) {
  if (!def || !Array.isArray(def.keys)) return []
  const k = KEY_PARAMS[def.type]
  if (Array.isArray(k)) return k.filter((x) => def.keys.includes(x))
  return def.keys.filter((x) => def.params[x] && def.params[x].kind === 'num').slice(0, 3)
}

/** select 的值编码（数字 / 字符串 / null 都能原样来回：option 的 value 只能是串） */
export const encOpt = (v) => JSON.stringify(v === undefined ? null : v)
export const decOpt = (s) => { try { return JSON.parse(s) } catch { return null } }

// ───────────────────────────── 结构树 ─────────────────────────────

/** 父 id → 子件（文档顺序）；找不到父件的当根处理（容错：坏文档也要看得见每一件） */
export function childrenMap(doc) {
  const comps = doc && Array.isArray(doc.comps) ? doc.comps : []
  const ids = new Set(comps.map((c) => c.id))
  const map = new Map([[null, []]])
  for (const c of comps) {
    const p = c.parent && ids.has(c.parent) && c.parent !== c.id ? c.parent : null
    if (!map.has(p)) map.set(p, [])
    map.get(p).push(c)
  }
  return map
}
/** 组件在库里的显示名：用户起的名 > 组件中文名 > type */
export function compLabel(c) {
  if (!c) return ''
  if (typeof c.name === 'string' && c.name.trim()) return c.name
  const def = getComponent(c.type)
  return (def && (def.titleZh || def.title)) || c.type || c.id
}
/** 对称角标：镜像 ×2、径向 ×n；无对称 null */
export function symBadge(sym) {
  if (!isObj(sym)) return null
  if (sym.op === 'radial') return { icon: 'orbit', n: Number.isInteger(sym.n) ? sym.n : 2, tip: `径向 ×${Number.isInteger(sym.n) ? sym.n : 2}（绕 ${sym.axis || '+Z'}）` }
  if (sym.op === 'mirrorXZ' || sym.op === 'mirrorYZ') return { icon: 'flip-horizontal-2', n: 2, tip: sym.op === 'mirrorXZ' ? '镜像 XZ ×2' : '镜像 YZ ×2' }
  return null
}

/**
 * 文档 → 结构树行（前序；collapsed 里的件不展开子件）。派生件不单列（角标给出件数）。
 * 行：{id, depth, parent, hasKids, open, label, type, role, icon, sym, hidden, locked, inherited}
 *   inherited = 祖先带对称（本件随祖先一起被复制）
 * 成环 / 自指的坏文档：已访问过的件不再下钻（不死循环），没挂上的件补在末尾（depth 0）。
 */
export function flattenTree(doc, collapsed) {
  const shut = collapsed instanceof Set ? collapsed : new Set(Array.isArray(collapsed) ? collapsed : [])
  const kids = childrenMap(doc)
  const rows = [], seen = new Set()
  const walk = (c, depth, inh) => {
    if (seen.has(c.id)) return
    seen.add(c.id)
    const ks = kids.get(c.id) || []
    const def = getComponent(c.type)
    const open = !shut.has(c.id)
    rows.push({
      id: c.id, depth, parent: c.parent || null, hasKids: ks.length > 0, open,
      label: compLabel(c), type: c.type, role: def ? def.role : 'other', icon: roleIcon(def ? def.role : 'other'),
      sym: symBadge(c.sym), hidden: c.hidden === true, locked: c.locked === true, inherited: inh
    })
    if (open) for (const k of ks) walk(k, depth + 1, inh || !!c.sym)
    else for (const k of ks) markSeen(k)
  }
  const markSeen = (c) => { if (seen.has(c.id)) return; seen.add(c.id); for (const k of kids.get(c.id) || []) markSeen(k) }
  for (const r of kids.get(null) || []) walk(r, 0, false)
  for (const c of doc && Array.isArray(doc.comps) ? doc.comps : []) if (!seen.has(c.id)) walk(c, 0, false)
  return rows
}

/** id 与它的全部子孙（含自身） */
export function subtreeIds(doc, id) {
  const kids = childrenMap(doc)
  const out = new Set()
  const st = [id]
  while (st.length) {
    const x = st.pop()
    if (out.has(x)) continue
    out.add(x)
    for (const k of kids.get(x) || []) st.push(k.id)
  }
  return out
}
/** 父件下拉：排除自身子树（改父件 = reparent；成环由编辑器再兜一次） */
export function parentChoices(doc, id) {
  const sub = subtreeIds(doc, id)
  return (doc && Array.isArray(doc.comps) ? doc.comps : []).filter((c) => !sub.has(c.id)).map((c) => ({ value: c.id, label: `${compLabel(c)}（${c.id}）` }))
}
export const compById = (doc, id) => (doc && Array.isArray(doc.comps) ? doc.comps.find((c) => c.id === id) : null) || null

const safeList = (fn) => { try { const r = fn(); return Array.isArray(r) ? r : [] } catch { return [] } }
/** 某件的插座（按当前参数） */
export function socketsOf(c) {
  const def = c && getComponent(c.type)
  return def ? safeList(() => def.sockets(fillParams(def, c.params))) : []
}
/** 某件的可贴面（按当前参数） */
export function facesOf(c) {
  const def = c && getComponent(c.type)
  return def ? safeList(() => def.faces(fillParams(def, c.params))) : []
}
/**
 * 插座下拉：父件插座里接得了本件 type、且没被兄弟件占用的，外加本件当前那个（哪怕已不兼容，也要看得见现状）。
 * @returns {{value:string, label:string, taken:boolean, ok:boolean}[]}
 */
export function socketChoices(doc, comp) {
  const par = comp && comp.parent ? compById(doc, comp.parent) : null
  if (!par) return []
  const taken = new Set()
  for (const c of doc.comps) if (c.id !== comp.id && c.parent === par.id && c.attach && c.attach.mode === 'socket' && c.attach.socket) taken.add(c.attach.socket)
  const cur = comp.attach && comp.attach.socket
  return socketsOf(par)
    .filter((s) => s.id === cur || (!taken.has(s.id) && socketAccepts(s, comp.type)))
    .map((s) => ({ value: s.id, label: s.id, taken: taken.has(s.id), ok: socketAccepts(s, comp.type) }))
}
export function faceChoices(doc, comp) {
  const par = comp && comp.parent ? compById(doc, comp.parent) : null
  return par ? facesOf(par).map((f) => ({ value: f.id, label: f.id, kind: f.kind, halfU: f.halfU, halfV: f.halfV })) : []
}
/** 安装插座下拉：'' = 组件缺省（def.mountSocket），其余为本件插座 */
export function mountChoices(comp) {
  const def = comp && getComponent(comp.type)
  if (!def) return []
  return [{ value: '', label: `缺省（${def.mountSocket}）` }, ...socketsOf(comp).map((s) => ({ value: s.id, label: s.id }))]
}

// ───────────────────────────── 「安装」节：偏移 / 倾角 / 锚点 / 生效步长（2026-10-06 任务书 §3.3.3） ─────────────────────────────
// attach 恒为 {mode, socket, face, uv, roll, mount, off, tilt}（assembly.mkAttach）：off = [x, y, 法向]（米，锚系：接口系 / 面系），
// tilt = [t0, t1]（度，t0 ∈ [−90, 90]）；位姿 M = M父 · 锚系 · T(off) · Rz(roll) · Rx(t0) · Ry(t1) · mount⁻¹。面安装件面内位置走 uv，
// off 只认法向分量（归一时 off[0] / off[1] 清零）。属性面板的数值写入一律走 setAttach，按「件 + 键」合并撤销（MERGE_MS）。

const z0 = (v) => (v === 0 ? 0 : v)
/** 下拉选项文字：显示名里没有 id 时补「 · id」（「焦点 · focus」；「接口 +X」「面心 +Z」原样） */
export const optText = (label, id) => { const l = String(label), i = String(id); return l.includes(i) ? l : `${l} · ${i}` }
/** 方式 → 「偏移」可编辑分量（接口：x / y / 法向；面安装：法向；自由：无） */
export const offAxesOf = (mode) => (mode === 'socket' ? [0, 1, 2] : mode === 'surface' ? [2] : [])
/** attach.off / tilt 的读数（缺省 / 坏值补 0；−0 记 0） */
export const offOf = (a) => [0, 1, 2].map((k) => (a && Array.isArray(a.off) && isNum(a.off[k]) ? z0(a.off[k]) : 0))
export const tiltOf = (a) => [0, 1].map((k) => (a && Array.isArray(a.tilt) && isNum(a.tilt[k]) ? z0(a.tilt[k]) : 0))
/** setAttach 补丁：偏移第 k 分量改成 v（面安装件面内两分量恒 0） */
export function offPatch(a, k, v) {
  const off = offOf(a)
  off[k] = isNum(v) ? z0(v) : 0
  if (a && a.mode === 'surface') { off[0] = 0; off[1] = 0 }
  return { off }
}
/** setAttach 补丁：倾角第 k 轴改成 v（t0 夹在 ±90°，t1 不夹） */
export function tiltPatch(a, k, v) {
  const tilt = tiltOf(a)
  let x = isNum(v) ? v : 0
  if (k === 0) x = Math.max(-90, Math.min(90, x))
  tilt[k] = z0(x)
  return { tilt }
}
/** 属性面板数值写入的撤销合并键：同件同键在 MERGE_MS 内连续输入合成一步 */
export const attachMergeKey = (id, key) => `${id}|attach.${key}`
/**
 * 锚点读数（自由件的参考系）：接口锚 {kind:'socket', id, label} / 面锚 {kind:'face', id, label, uv}；无锚（相对父件）null。
 * 与 assembly 解算同口径：socket 键非空且方式不是面安装 → 接口锚；否则 face 键非空且方式不是接口 → 面锚。
 */
export function anchorOf(a) {
  if (!a) return null
  if (typeof a.socket === 'string' && a.socket && a.mode !== 'surface') return { kind: 'socket', id: a.socket, label: socketLabel(a.socket) }
  if (typeof a.face === 'string' && a.face && a.mode !== 'socket') {
    const uv = Array.isArray(a.uv) ? [isNum(a.uv[0]) ? z0(a.uv[0]) : 0, isNum(a.uv[1]) ? z0(a.uv[1]) : 0] : [0, 0]
    return { kind: 'face', id: a.face, label: faceLabel(a.face), uv }
  }
  return null
}
/** 自由件 t / q（相对锚系）→ 读数 {t, rpy}（3-2-1 欧拉，度；与位置节同口径） */
export function tqReadout(t, q) {
  const r = poseReadout(m16FromTQ(Array.isArray(t) && t.length === 3 ? t : [0, 0, 0], Array.isArray(q) && q.length === 4 ? q : [0, 0, 0, 1]))
  return r ? { t: r.t, rpy: r.rpy } : { t: [0, 0, 0], rpy: [0, 0, 0] }
}
/**
 * 自由件 t / q 换一个分量：k = 0..2 平移 x / y / z（q 原样不动），3..5 roll / pitch / yaw（度，t 原样不动）。返回 {t, q}（新数组）。
 */
export function tqWith(t, q, k, v) {
  const t0 = Array.isArray(t) && t.length === 3 ? t.slice() : [0, 0, 0]
  const q0 = Array.isArray(q) && q.length === 4 ? q.slice() : [0, 0, 0, 1]
  if (k < 3) { t0[k] = isNum(v) ? z0(v) : 0; return { t: t0, q: q0 } }
  const r = tqReadout(t0, q0)
  const rpy = r.rpy.slice()
  rpy[k - 3] = isNum(v) ? v : 0
  const qn = fineRotate([0, 0, 0, 1], rpy[0], rpy[1], rpy[2]).map(clean)
  return { t: t0, q: qn }
}
/** 平面面 faces 里装着接口 s 的那一面（接口原点在面上、法向同向、在面内）；没有 null。生效步长的锚面用。 */
function faceUnderSocket(faces, s) {
  if (!s || !Array.isArray(s.pos) || !Array.isArray(s.n)) return null
  for (const f of faces) {
    if (!f || f.kind === 'cyl' || !Array.isArray(f.origin) || !Array.isArray(f.n)) continue
    const tol = 1e-6 * Math.max(1e-3, f.halfU, f.halfV)
    const rx = s.pos[0] - f.origin[0], ry = s.pos[1] - f.origin[1], rz = s.pos[2] - f.origin[2]
    const d = rx * f.n[0] + ry * f.n[1] + rz * f.n[2]
    if (Math.abs(d) > tol || s.n[0] * f.n[0] + s.n[1] * f.n[1] + s.n[2] * f.n[2] < 1 - 1e-9) continue
    const u = rx * f.u[0] + ry * f.u[1] + rz * f.u[2], v = rx * f.v[0] + ry * f.v[1] + rz * f.v[2]
    if (Math.abs(u) <= f.halfU + tol && Math.abs(v) <= f.halfV + tol) return f
  }
  return null
}
/**
 * 「自动」平移步长的基准（asmSnap.resolveMoveStep / autoGridStep 的 ref）：面安装 / 面锚 → 该面；接口 / 接口锚 → 接口所在的平面面；
 * 都没有 → 父件包围盒短边（米）。根件 / 找不到父件 null。doc 请传普通（非冻结）副本：componentBox 走组件生成缓存。
 */
export function moveStepRef(doc, comp) {
  if (!comp || comp.parent == null) return null
  const par = compById(doc, comp.parent)
  if (!par) return null
  const a = comp.attach || {}
  const faces = facesOf(par)
  if (typeof a.face === 'string' && a.face && a.mode !== 'socket') { const f = faces.find((x) => x.id === a.face); if (f) return f }
  if (typeof a.socket === 'string' && a.socket && a.mode !== 'surface') {
    const f = faceUnderSocket(faces, socketsOf(par).find((x) => x.id === a.socket))
    if (f) return f
  }
  let b = null
  try { b = componentBox(par.type, par.params, doc && isObj(doc.density) ? doc.density : undefined) } catch { b = null }
  if (!b) return null
  const e = [b[3] - b[0], b[4] - b[1], b[5] - b[2]].filter((x) => isNum(x) && x > 0)
  return e.length ? Math.min(...e) : null
}
/** 选中件的生效平移步长（米）：move = 'auto' 按 moveStepRef，数值原样；给不出 null */
export function effMoveStep(doc, comp, move) {
  if (move !== 'auto') return isNum(move) && move > 0 ? move : null
  const ref = moveStepRef(doc, comp)
  return ref == null ? null : resolveMoveStep('auto', ref)
}

/**
 * 能否「拆分对称」：径向恒可；镜像要组件有镜像钩子或在某个局部面上对称（否则走烘焙镜像，派生件没有对应参数，拆不出来）。
 * @returns {{ok:boolean, why:string}}
 */
export function splitSymInfo(comp) {
  if (!comp || !isObj(comp.sym)) return { ok: false, why: '无对称' }
  if (comp.sym.op === 'radial') return { ok: true, why: '' }
  const def = getComponent(comp.type)
  if (!def) return { ok: false, why: '未知组件' }
  if (def.mirror) return { ok: true, why: '' }
  const sp = safeList(() => (typeof def.symmetricPlanes === 'function' ? def.symmetricPlanes(fillParams(def, comp.params)) : (def.symmetricPlanes || [])))
  return sp.length ? { ok: true, why: '' } : { ok: false, why: '该组件的镜像件由几何烘焙生成，不能拆分' }
}

// ───────────────────────────── 位姿读数与自由件反算（列主序 4×4，本体系） ─────────────────────────────

/** q + t → 列主序 4×4（普通数组） */
export function m16FromTQ(t, q) {
  const R = quatToMat(q) || [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const tt = Array.isArray(t) && t.length === 3 ? t : [0, 0, 0]
  return [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, tt[0], tt[1], tt[2], 1]
}
/** a · b（列主序） */
export function mul16(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[4 * c + r] = a[r] * b[4 * c] + a[4 + r] * b[4 * c + 1] + a[8 + r] * b[4 * c + 2] + a[12 + r] * b[4 * c + 3]
  return o
}
/** 刚体逆（旋转 + 平移；镜像矩阵也成立：Rᵀ 对正交阵都是逆） */
export function invRigid16(m) {
  const o = new Array(16).fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[4 * c + r] = m[4 * r + c]
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14])
  o[15] = 1
  return o
}
const rows3 = (m) => [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]]
const clean = (v) => (Math.abs(v) < 5e-12 ? 0 : v)
/** 位姿 → {t:[3], rpy:[roll, pitch, yaw] 度, q}（3-2-1 欧拉，与 bodyFrame.quatToEulerZYX 同口径） */
export function poseReadout(m) {
  if (!m || m.length !== 16) return null
  const q = matToQuat(rows3(m), 1e-6)
  const e = q ? quatToEulerZYX(q) : null
  return { t: [clean(m[12]), clean(m[13]), clean(m[14])], rpy: e ? [e.rollDeg, e.pitchDeg, e.yawDeg].map(clean) : [0, 0, 0], q }
}
/** 父件系下的位姿：inv(M_父)·M（根件 / 无父：原样） */
export const relPose = (mParent, m) => (mParent ? mul16(invRigid16(mParent), m) : Array.from(m))
/** 位姿换一个分量：k = 0..2 平移 x/y/z，3..5 roll/pitch/yaw（度）；返回新矩阵（原数组不动） */
export function withPoseComponent(m, k, v) {
  const r = poseReadout(m)
  if (!r) return Array.from(m)
  const t = r.t.slice(), rpy = r.rpy.slice()
  if (k < 3) t[k] = v
  else rpy[k - 3] = v
  return m16FromTQ(t, fineRotate([0, 0, 0, 1], rpy[0], rpy[1], rpy[2]))
}
/**
 * 自由件：期望本体位姿 mNew → 新的 t / q。已知当前 t / q 与当前位姿 mCur：M = A·T(t,q)（A = 父件系·锚系，不必知道），
 * 于是 T_new = T(t,q)·inv(mCur)·mNew。结果 q 规范化、分量抹掉 1e-12 以下的噪声。
 */
export function freeTQFromBody(tCur, qCur, mCur, mNew) {
  const T = mul16(mul16(m16FromTQ(tCur, qCur), invRigid16(mCur)), mNew)
  const q = matToQuat(rows3(T), 1e-6) || [0, 0, 0, 1]
  return { t: [clean(T[12]), clean(T[13]), clean(T[14])], q: q.map(clean) }
}

// ───────────────────────────── 草稿 / 来源标记 ─────────────────────────────

export const DRAFT_KEY = 'model/asm/draft'
export const LAST_KEY = 'model/asm/last'
export const provKey = (id) => 'model/asm/prov/' + id
/** 草稿形状是否可用（坏草稿一律当没有） */
export function draftOk(d) {
  return isObj(d) && typeof d.id === 'string' && /^asm:[0-9a-f]{12}$/.test(d.id) && isNum(d.at) && isObj(d.doc) && Array.isArray(d.doc.comps)
}
/**
 * 打开库里的装配件时是否改用本机草稿（同一 id）。按内容判：草稿文档与库里那份的装配文档不同 → 用草稿。
 * 理由：草稿只在「入库成功且期间没有新提交」时才清，同 id 的草稿还在、内容又与库里不同，就一定含有没确认入库的提交
 * （入库途中又改了一处马上关窗：草稿的 at 早于主进程随后盖的 updatedAt，按时间判会把最后一处改动丢掉）。
 * 库里那份没有装配文档（坏 meta）时退回按时间比：草稿晚于 updatedAt（缺 = 从没盖过戳 → 草稿胜）。
 */
export function pickDraft(draft, meta) {
  if (!draftOk(draft) || !isObj(meta) || draft.id !== meta.id) return false
  if (isObj(meta.spec) && meta.spec.kind === 'assembly') {
    try { return asmHash(draft.doc) !== asmHash(meta.spec) } catch { /* 坏文档：按时间 */ }
  }
  const t = typeof meta.updatedAt === 'string' ? Date.parse(meta.updatedAt) : NaN
  return !Number.isFinite(t) || draft.at > t
}
/**
 * 来源标记（从模板复制来的文档：示意值路径 / 用户改过的路径 / 有出处的参数路径）清洗。
 * sources：{路径: {urls:[http(s) URL], derive: 派生式|null, value: 复制时的参数值}}；原对象带 sources 时才出这个键。
 */
export function sanitizeProv(p) {
  if (!isObj(p)) return null
  const arr = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string' && x.length <= 80))] : [])
  const out = { illustrative: arr(p.illustrative), touched: arr(p.touched) }
  if (isObj(p.sources)) {
    const src = {}
    for (const [k, v] of Object.entries(p.sources).slice(0, 500)) {
      if (k.length > 80 || !isObj(v)) continue
      const urls = [...new Set((Array.isArray(v.urls) ? v.urls : []).filter((u) => typeof u === 'string' && u.length <= 500 && /^https?:\/\/\S+$/.test(u)))].slice(0, 4)
      if (!urls.length) continue
      const val = isNum(v.value) || typeof v.value === 'boolean' || (typeof v.value === 'string' && v.value.length <= 80) ? v.value : null
      src[k] = { urls, derive: typeof v.derive === 'string' && v.derive ? v.derive.slice(0, 300) : null, value: val }
    }
    out.sources = src
  }
  return out
}
/**
 * 实体模板 → 有出处的参数路径表（fromTemplate 存进来源标记）：prov 的每条（'<compId>.<param>'；组件级质量 '#' 不进）取它引用的
 * dims 的出处 URL（去重，按引用顺序）、派生式与文档里的参数值。t = entityTemplateDoc(id) 的结果，doc = 复制出来的文档。
 */
export function templateSources(t, doc) {
  const out = {}
  if (!t || !isObj(t.prov) || !isObj(t.dims)) return out
  const comps = doc && Array.isArray(doc.comps) ? doc.comps : []
  for (const [path, pr] of Object.entries(t.prov)) {
    const m = /^([a-z][a-z0-9]*)\.(\w+)$/.exec(path)
    if (!m || !isObj(pr)) continue
    const c = comps.find((x) => x.id === m[1])
    if (!c || !isObj(c.params) || !Object.hasOwn(c.params, m[2])) continue
    const keys = typeof pr.dim === 'string' ? [pr.dim] : Array.isArray(pr.dims) ? pr.dims : []
    const urls = [...new Set(keys.map((k) => t.dims[k] && t.dims[k].source).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))]
    if (urls.length) out[path] = { urls, derive: typeof pr.derive === 'string' ? pr.derive : null, value: c.params[m[2]] }
  }
  return out
}
