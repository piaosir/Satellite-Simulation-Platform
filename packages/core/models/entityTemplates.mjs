// 内置实体模板（三期契约 DESIGN3 §1 P1b、E13；A3 规格 §7）：地球站 / 飞机 / 船 / 车的装配文档预设。
//
// 纯 ESM、零 three 依赖、node 可测。每个模板 = 一份装配文档（assembly.mjs 的 AssemblySpec）+ 有出处的尺寸（dims，逐字抄研究表）
// + 组件参数来源映射（prov）+ 运行参数（ops）+ 待补字段（needsInput）。数据在 entityTemplates/<领域>.mjs，本文件只做汇总、
// 加载期校验、冻结与对外 API。组件登记靠 components/index.mjs（经 assembly.mjs 引入），这里不登记组件。
//
// ★ 两条用法（编排者 2026-09-24 裁定 §12-2）：
//   · 3D 球 / 工作台对 'ent:<slug>' 像 'param:' 一样运行时现生成：buildAssembly(entityTemplateDoc(id).doc)（零存储）；
//   · 装配页「从模板开始」：entityTemplateDoc(id).doc 是可改的新深拷贝，调用方配 newAsmId() 存成 'asm:<id>' 用户件。
// ★ 不内置相关型号（用户 2026-09-24 定：内置目录不带、界面也不出现）；船型取国际船型补充调研（见 entityTemplates/sea.mjs 文件头）。
// ★ 记录形状见 entityTemplates/common.mjs；prov 的键 '<compId>.<param>' = 组件参数、'<compId>#massKg' = 组件级质量覆盖。
//   illustrative（运行时算）= 模板文档里显式填写、却不在 prov 里的组件参数路径——即模板作者取的示意量（缺省参数不算：
//   组件缺省一律示意，口径在组件参数的悬停 title 里）。
//
// 导出：
//   ENTITY_ID_RE                       /^ent:([a-z0-9][a-z0-9-]{0,47})$/（与 schema.mjs 的 ent 前缀同式）
//   ENTITY_DOMAINS                     ['ground', 'aircraft', 'ship', 'vehicle']（界面顺序）
//   ENTITY_TEMPLATES                   深冻结数组，顺序 = 界面顺序：地球站（口径从小到大）→ 飞机 → 船 → 车
//   ENTITY_TEMPLATE_IDS                冻结 id 数组
//   isEntityTemplateId(id)             是否内置实体模板 id
//   getEntityTemplate(id)              冻结记录 | null
//   listEntityTemplates(domain?)       按领域过滤（'ground' | 'aircraft' | 'ship' | 'vehicle'）；缺省全部
//   entityTemplateDoc(id)              → {doc（normalizeAssembly 后的新深拷贝，可改）, dims, prov, ops, needsInput, illustrative}（后几项也是深拷贝）| null
//   entityTemplateCatalog()            → ModelMeta 片段数组（与 paramTemplates.templateCatalog 同形）

import { normalizeAssembly, COMP_ID_RE, RESERVED_COMP_IDS } from './assembly.mjs'
import { getComponent } from './components/index.mjs'
import { GROUND_TEMPLATES } from './entityTemplates/ground.mjs'
import { AIR_TEMPLATES } from './entityTemplates/air.mjs'
import { SEA_TEMPLATES } from './entityTemplates/sea.mjs'
import { VEH_TEMPLATES } from './entityTemplates/veh.mjs'

export const ENTITY_ID_RE = /^ent:([a-z0-9][a-z0-9-]{0,47})$/
export const ENTITY_DOMAINS = Object.freeze(['ground', 'aircraft', 'ship', 'vehicle'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const URL_RE = /^https?:\/\/\S+$/
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]) } return o }
const clone = (v) => JSON.parse(JSON.stringify(v))

/** prov 路径 → [compId, 参数名, 是否组件级（#）]。 */
function splitPath(path) {
  const m = /^([a-z][a-z0-9]{0,23})([.#])([A-Za-z][A-Za-z0-9]*)$/.exec(path)
  return m ? [m[1], m[3], m[2] === '#'] : null
}

/** 加载期校验（内置数据错了是开发期错误：抛）。 */
function check(list) {
  const ids = new Set(), bad = []
  for (const r of list) {
    const at = (m) => bad.push(`${r && r.id}：${m}`)
    if (!isObj(r) || typeof r.id !== 'string' || !ENTITY_ID_RE.test(r.id)) { at('id 非法'); continue }
    if (ids.has(r.id)) at('id 重复')
    ids.add(r.id)
    if (!ENTITY_DOMAINS.includes(r.domain)) at(`domain 非法（${r.domain}）`)
    if (!isObj(r.doc) || r.doc.domain !== r.domain) at('doc.domain 与记录 domain 不一致')
    for (const k of ['title', 'titleZh', 'representative', 'hover']) if (typeof r[k] !== 'string' || !r[k]) at(`缺 ${k}`)
    if (!isObj(r.dims) || !isObj(r.prov) || !isObj(r.ops) || !Array.isArray(r.needsInput) || !Array.isArray(r.urls) || !r.urls.length) at('dims / prov / ops / needsInput / urls 形状不对')
    for (const [k, d] of Object.entries(r.dims || {})) {
      if (!isObj(d) || !Object.hasOwn(d, 'value') || d.value === null) at(`dims.${k} 无值`)
      else if (typeof d.source !== 'string' || !URL_RE.test(d.source)) at(`dims.${k} 出处不是 URL`)
      else if (!['primary', 'secondary', 'tertiary'].includes(d.confidence)) at(`dims.${k} 置信度非法`)
    }
    const comps = new Map((isObj(r.doc) && Array.isArray(r.doc.comps) ? r.doc.comps : []).map((c) => [c.id, c]))
    for (const c of comps.values()) {
      if (!COMP_ID_RE.test(c.id) || RESERVED_COMP_IDS.includes(c.id)) at(`组件 id 非法：${c.id}`)
      if (!getComponent(c.type)) at(`组件 ${c.id}：未知类型 ${c.type}`)
    }
    for (const [path, p] of Object.entries(r.prov || {})) {
      const sp = splitPath(path)
      if (!sp) { at(`prov 路径非法：${path}`); continue }
      const [cid, key, compLevel] = sp, c = comps.get(cid), def = c && getComponent(c.type)
      if (!c || !def) at(`prov ${path}：没有组件 ${cid}`)
      else if (compLevel ? key !== 'massKg' || typeof c.massKg !== 'number' : !Object.hasOwn(def.params, key)) at(`prov ${path}：${compLevel ? '组件级质量未填' : `${c.type} 没有参数 ${key}`}`)
      const ds = typeof p.dim === 'string' ? [p.dim] : Array.isArray(p.dims) ? p.dims : []
      if (!ds.length) at(`prov ${path}：没有出处字段`)
      for (const d of ds) if (!Object.hasOwn(r.dims, d)) at(`prov ${path}：dims 里没有 ${d}`)
      if (p.dims && (typeof p.fn !== 'string' || typeof p.derive !== 'string' || !isObj(p.with))) at(`prov ${path}：派生条目缺 fn / derive / with`)
    }
  }
  if (bad.length) throw new Error(`内置实体模板数据有误：${bad.join('；')}`)
}

const ALL = [...GROUND_TEMPLATES, ...AIR_TEMPLATES, ...SEA_TEMPLATES, ...VEH_TEMPLATES]
check(ALL)

export const ENTITY_TEMPLATES = deepFreeze(ALL)
export const ENTITY_TEMPLATE_IDS = Object.freeze(ENTITY_TEMPLATES.map((r) => r.id))
const BY_ID = new Map(ENTITY_TEMPLATES.map((r) => [r.id, r]))

export const isEntityTemplateId = (id) => typeof id === 'string' && BY_ID.has(id)
export const getEntityTemplate = (id) => (typeof id === 'string' && BY_ID.get(id)) || null
export function listEntityTemplates(domain) {
  return domain === undefined || domain === null ? ENTITY_TEMPLATES.slice() : ENTITY_TEMPLATES.filter((r) => r.domain === domain)
}

/** 模板文档里显式填写的参数路径（'<compId>.<param>'，含组件级质量 '<compId>#massKg'），不在 prov 里的那些 = 示意量。 */
function illustrativeOf(r) {
  const out = []
  for (const c of r.doc.comps) {
    for (const k of Object.keys(c.params || {})) { const p = `${c.id}.${k}`; if (!Object.hasOwn(r.prov, p)) out.push(p) }
    if (typeof c.massKg === 'number' && !Object.hasOwn(r.prov, `${c.id}#massKg`)) out.push(`${c.id}#massKg`)
  }
  return out
}

/** 模板 → 可改的装配文档（归一后的新深拷贝）与出处表的副本；未知 id 返回 null。 */
export function entityTemplateDoc(id) {
  const r = getEntityTemplate(id)
  if (!r) return null
  return { doc: normalizeAssembly(r.doc), dims: clone(r.dims), prov: clone(r.prov), ops: clone(r.ops), needsInput: r.needsInput.slice(), illustrative: illustrativeOf(r) }
}

/** ModelMeta 片段（manifest / 库页）；id 就是模板 id（'ent:<slug>'），source.kind = builtin（schema PREFIX_SOURCES.ent）。 */
export function entityTemplateCatalog() {
  return ENTITY_TEMPLATES.map((r) => ({
    id: r.id, templateId: r.id, title: r.title, titleZh: r.titleZh,
    kind: r.modelKind, group: r.modelKind, fidelity: 'parametric',
    source: { kind: 'builtin', url: r.urls[0], credit: `卫星仿真平台参数化生成；尺寸参照 ${r.representative}`, license: 'param', redistributable: true },
    tags: ['entity', r.domain], aliases: [r.title, r.titleZh], needsInput: r.needsInput.slice(), hover: r.hover
  }))
}
