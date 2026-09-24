// 装配页（P3，契约 scratchpad p3/CONTRACT.md §6）的纯逻辑：组件库分组 / 搜索、属性面板的参数行模型、结构树扁平化、
// 安装选项（父件 / 插座 / 面 / 安装插座）、位姿读数与自由件的反算、草稿取舍、工具状态的缺省与清洗。
// 无 three / vue / DOM —— node 单测直接 import（packages/core/test/modelAsmUi.test.mjs）。
//
// ★ 引 packages/core 一律走相对路径（不用 @core 别名）：单测是裸 node 跑的；渲染端 vite 对相对路径照样解析。
// ★ 组件清单一律 listComponents(domain) 现取（A3 并行登记新领域组件，这里不写死任何 type）。
// ★ 界面零说明文字：口径 / 出处 / 范围一律进 title；这里拼的 title 串就是给悬停用的。
import { getComponent, listComponents, fillParams, checkParams, socketAccepts, ASM_DOMAINS } from '../../packages/core/models/components/index.mjs'
import { MATERIALS, DENSITY } from '../../packages/core/models/paramBus.mjs'
import { quatToMat, matToQuat, quatToEulerZYX, fineRotate } from '../../packages/core/models/bodyFrame.mjs'
import { MOVE_STEPS, ROT_STEPS } from '../../packages/core/models/asmSnap.mjs'
import { asmHash, componentDensityKeys } from '../../packages/core/models/assembly.mjs'
import { normText } from './wbLogic.js'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ───────────────────────────── 领域 / 角色 / 标签表 ─────────────────────────────

/** 「新建」菜单与副标题的领域顺序（= ASM_DOMAINS） */
export const NEW_DOMAINS = Object.freeze([...ASM_DOMAINS])
export const DOMAIN_LABELS = Object.freeze({ spacecraft: '卫星', ground: '地球站', aircraft: '飞机', ship: '船舶', vehicle: '车辆' })
export const DOMAIN_ICONS = Object.freeze({ spacecraft: 'satellite', ground: 'satellite-dish', aircraft: 'plane', ship: 'ship', vehicle: 'car' })
/** 组件库分组：领域组 + 「通用」（prim.* 基本体）；通用恒排最后 */
export const LIB_GROUP_LABELS = Object.freeze({ ...DOMAIN_LABELS, common: '通用' })

/** 部件角色 → 图标（结构树行首、组件卡片占位） */
export const ROLE_ICONS = Object.freeze({
  bus: 'box', solarArray: 'sun', reflector: 'satellite-dish', feed: 'radio-tower', boom: 'ruler',
  radiator: 'grid-3x3', thruster: 'arrow-down', sensor: 'scan-eye', other: 'hexagon'
})
export const roleIcon = (role) => ROLE_ICONS[role] || 'hexagon'

/** 材质键 → 显示名（paramBus.MATERIALS 的键；A3 扩充的漆面键预先给名，查不到显示原键） */
export const MATERIAL_LABELS = Object.freeze({
  mli_gold: '金色 MLI', mli_silver: '银色 MLI', mli_black: '黑色 MLI', kapton_black: '黑色聚酰亚胺',
  solar_cell: '电池片', solar_substrate: '太阳翼基板', reflector: '反射面涂层', reflector_mesh: '金属网',
  aluminum: '铝', radiator: 'OSR 散热面', titanium: '钛', carbon: '碳纤维', white_paint: '白漆', glass: '玻璃', dark_metal: '深色金属',
  paint_red: '红漆', paint_navy: '深蓝漆', paint_blue: '蓝漆', paint_green: '绿漆', paint_orange: '橙漆', paint_yellow: '黄漆',
  paint_grey: '灰漆', rubber: '橡胶', concrete: '混凝土'
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
  noseStyle: { airliner: '客机式', bizjet: '公务机式', uav: '无人机式' },
  side: { right: '右', left: '左' },
  winglet: { none: '无', sharklet: '鲨鳍小翼', blended: '融合式小翼', raked: '斜削翼梢' },
  exhaust: { separate: '分开排气', mixed: '混合排气' },
  model: { gat5530: 'GAT-5530', v100nx: 'V100NX', v130nx: 'V130NX', v240m: 'V240M', 'kymeta-u8': 'Kymeta u8', 'inetvu-1202': 'iNetVu 1202', custom: '自定义' },
  style: { kingpost: '锥形立柱', tripod: '三脚架', suv: '越野车', pickup: '皮卡', van: '厢式车' },
  gimbal: { azel: '方位俯仰', xy: 'X-Y 座', none: '固定' },
  feedArm: { auto: '自动', boom: '单杆', tripod: '三杆' },
  kind: { corrugated: '波纹喇叭', horn: '喇叭', lnb: '高频头', patch: '贴片', lae: '远地点发动机', rcs: '姿轨控推力器', ep: '电推力器', radiator: '散热面', cells: '体装电池片' },
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
export function enumLabel(key, value) {
  if (value === null) return '自动'
  const t = ENUM_LABELS[key]
  if (t && Object.hasOwn(t, value)) return t[value]
  if (typeof value === 'string' && Object.hasOwn(MATERIAL_LABELS, value)) return MATERIAL_LABELS[value]
  return String(value)
}

/** 密度表显示名（与生成页同一套；查不到的键显示原键） */
export const DENSITY_LABELS = Object.freeze({
  busVolume: '平台体', panelAreal: '太阳翼基板', cellAreal: '电池片', reflectorAreal: '实面反射面', meshReflectorAreal: '网状反射面',
  mliAreal: 'MLI', radiatorAreal: '散热面 OSR', hornAreal: '喇叭', towerAreal: '天线塔', arrayAreal: '相控阵', boomLinear: '杆件',
  laeMass: '远地点发动机', rcsMass: '姿轨控推力器', epMass: '电推力器'
})
/** 主结构体密度（busVolume 键）按领域的显示名：「平台体」是卫星用语，飞机 / 船 / 车 / 地球站各用各的。键名不变。 */
export const BUS_VOLUME_LABELS = Object.freeze({ spacecraft: '平台体', aircraft: '机体', ship: '船体', vehicle: '车体', ground: '结构' })
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
  { key: 'none', label: '无', short: '无', tip: '不对称' },
  { key: 'mirrorXZ', label: '镜像 XZ', short: 'XZ', tip: '镜像 XZ：关于本体 XZ 面镜像（±Y 成对，如一对太阳翼）' },
  { key: 'mirrorYZ', label: '镜像 YZ', short: 'YZ', tip: '镜像 YZ：关于本体 YZ 面镜像（±X 成对，如东西两副反射面）' },
  { key: 'radial', label: '径向', short: '径向', tip: '径向：绕轴均布 N 件（卫星 / 地球站 / 船 / 车绕本体 Z，飞机绕机身 X）' }
])
export const SYM_AXIS_OPTIONS = Object.freeze(['+X', '-X', '+Y', '-Y', '+Z', '-Z'])
export const SPACE_UI = Object.freeze([
  { key: 'body', label: '本体', tip: '本体系：手柄 = 本体 X / Y / Z（与本体轴叠加同色）' },
  { key: 'local', label: '局部', tip: '局部：手柄随组件自身取向' },
  { key: 'mount', label: '安装面', tip: '安装面：手柄取父件的安装锚点系（插座 / 贴面件恒为此档）' }
])
export const MODE_UI = Object.freeze([
  { key: 'socket', label: '插座', tip: '本件安装插座贴父件插座：只可绕插座法向滚转' },
  { key: 'surface', label: '贴面', tip: '贴父件的面：面内 u / v 平移 + 绕法向滚转' },
  { key: 'free', label: '自由', tip: '相对父件的自由位姿（6 自由度）' }
])
const SPACE_KEYS = SPACE_UI.map((s) => s.key)
/** Q 键：本体 → 局部 → 安装面 → 本体 */
export const nextSpace = (s) => SPACE_KEYS[(SPACE_KEYS.indexOf(s) + 1) % SPACE_KEYS.length]

// ───────────────────────────── 工具状态（localStorage model/asm/ui）─────────────────────────────

export const UI_KEY = 'model/asm/ui'
export const UI_DEFAULTS = Object.freeze({
  tool: 'move', space: 'body', snap: Object.freeze({ on: true, move: 0.05, rot: 15 }), sym: Object.freeze({ op: 'none', n: 2 }),
  dockW: 320, split: 0.42, libQ: '', secOpen: Object.freeze({}), posePreview: false, showCom: true, showSockets: true, showAxes: true, posFrame: 'parent'
})
export const DOCK_W_MIN = 260, DOCK_W_MAX = 520
/** 本机存的工具状态 → 合法值（坏值逐项回缺省；这是便利数据，丢了、改坏了都不许把页面带崩） */
export function sanitizeUi(raw) {
  const r = isObj(raw) ? raw : {}
  const d = UI_DEFAULTS
  const snap = isObj(r.snap) ? r.snap : {}
  const sym = isObj(r.sym) ? r.sym : {}
  const sec = {}
  if (isObj(r.secOpen)) for (const [k, v] of Object.entries(r.secOpen)) if (typeof v === 'boolean' && k.length <= 64) sec[k] = v
  return {
    tool: r.tool === 'rotate' ? 'rotate' : 'move',
    space: SPACE_KEYS.includes(r.space) ? r.space : d.space,
    snap: {
      on: typeof snap.on === 'boolean' ? snap.on : d.snap.on,
      move: MOVE_STEPS.includes(snap.move) ? snap.move : d.snap.move,
      rot: ROT_STEPS.includes(snap.rot) ? snap.rot : d.snap.rot
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

/** 组件的库分组键：prim.* 归「通用」，其余按首领域 */
export const libGroupOf = (def) => (def && typeof def.type === 'string' && def.type.startsWith('prim.') ? 'common' : (def && def.domain && def.domain[0]) || 'common')

/** 组件是否匹配搜索词（中英文名、type、参数标签；大小写 / 全角半角 / 连字符不计） */
export function compMatches(def, q) {
  const nq = normText(q)
  if (!nq) return true
  const hay = [def.titleZh, def.title, def.type]
  for (const k of def.keys || []) { const s = def.params[k]; if (s) hay.push(s.label, s.labelEn) }
  return hay.some((s) => s && normText(s).includes(nq))
}

/**
 * 组件库分组（装配文档领域 domain 下可用的组件；登记顺序）：当前领域组排最前、通用排最后，其余按 ASM_DOMAINS 顺序。
 * @param {string} domain
 * @param {string} [q] 搜索词
 * @param {object[]} [defs] 组件定义表（缺省 listComponents(domain)；单测注入）
 * @returns {{key:string, label:string, icon:string, items:object[]}[]}
 */
export function libGroups(domain, q = '', defs) {
  const list = Array.isArray(defs) ? defs : listComponents(domain)
  const by = new Map()
  for (const d of list) {
    if (!compMatches(d, q)) continue
    const k = libGroupOf(d)
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(d)
  }
  const order = [domain, ...ASM_DOMAINS.filter((x) => x !== domain), 'common']
  const out = []
  for (const k of order) if (by.has(k)) out.push({ key: k, label: LIB_GROUP_LABELS[k] || k, icon: k === 'common' ? 'boxes' : (DOMAIN_ICONS[k] || 'hexagon'), items: by.get(k) })
  for (const [k, items] of by) if (!order.includes(k)) out.push({ key: k, label: LIB_GROUP_LABELS[k] || k, icon: 'hexagon', items })
  return out
}

/** 组件卡片悬停：中文名 / 英文名 / type */
export const compTip = (def) => [def.titleZh, def.title && def.title !== def.titleZh ? def.title : '', def.type].filter(Boolean).join('\n')

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
  return def.keys.map((key) => {
    const s = def.params[key]
    const path = `${ctx.compId || ''}.${key}`
    const err = errs.byKey[key] || ''
    const illustrative = ill.has(path) && !touched.has(path)
    // 模板出处：路径在 sources 里、用户没改过、值仍是复制时那个 → 悬停写出处与派生式（替换组件口径的「示意值」）
    const sv = srcs && Object.hasOwn(srcs, path) && isObj(srcs[path]) ? srcs[path] : null
    const pv = sv && Array.isArray(sv.urls) && !touched.has(path) && sameProvValue(sv.value, p[key]) ? sv : null
    const row = {
      key, path, label: s.label, unit: s.unit || '', value: p[key], err, illustrative,
      provenance: pv ? { urls: pv.urls.slice(), derive: pv.derive || null } : null,
      bad: !!err || illustrative,
      title: [paramTitle(s, pv), illustrative ? '模板示意值' : '', err].filter(Boolean).join('\n'),
      control: 'num', integer: false, allowEmpty: !!s.nullable, placeholder: s.nullable ? '自动' : '',
      min: isNum(s.min) ? s.min : -Infinity, max: isNum(s.max) ? s.max : Infinity, options: null
    }
    if (s.kind === 'bool') row.control = 'bool'
    else if (s.kind === 'enum' || (s.kind === 'int' && Array.isArray(s.options))) {
      row.control = 'select'
      row.options = s.options.map((v) => ({ value: v, label: s.kind === 'enum' ? enumLabel(key, v) : String(v) }))
      if (s.nullable) row.options.unshift({ value: null, label: '自动' })
    } else if (s.kind === 'int') row.integer = true
    return row
  })
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

/**
 * 能否「拆分对称」：径向恒可；镜像要组件有镜像钩子或在某个局部面上对称（否则走烘焙镜像，派生件没有对应参数，拆不出来）。
 * @returns {{ok:boolean, why:string}}
 */
export function splitSymInfo(comp) {
  if (!comp || !isObj(comp.sym)) return { ok: false, why: '没有对称' }
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
