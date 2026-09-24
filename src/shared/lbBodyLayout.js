// 链路预算报告第 5 章「卫星本体与天线布局」的数据块（渲染端组装，纯数据过 IPC）。
// 二期契约 DESIGN2 §4 / D14–D16；摸底 map2/lb-sunoutage-report.md §3.5；任务书 §6.9。
//
// 流程（四个链路预算窗口共用；各窗只交出「本份报告用到的卫星库条目」与窗口命名空间）：
//   库条目 → 绑定键（lbsat:<ns>:<条目 id> 优先，回退 norad:<号> → GRD 树同名星的 norad / grdsat:<folder>）
//   → 绑定表（models.bindingsGet）→ 模型（绑定里指定的 / 自动匹配 autoMatch.match，与 3D 页 modelOf 同一口径）
//   → 三视图 + 透视 PNG（thumbs.renderThreeView，挂点引线画的是本星的 mounts，不是模型自带的 attach point）
//     + 本体系包围盒（thumbs.exactBox：静止位姿、只算可见网格；比 meta.geometry 更可靠——那是模型轴口径）
//   → { sats:[…] }，交 lbReport.buildReportModel 排成图与两张表。
//
// 哪些星进章：绑定表里有这颗星的记录，且记录里真有布局数据——指定了模型（不是「自动」也不是「无」）、或有挂点、
//   或有质量特性覆盖。只靠自动匹配、从没编辑过的星不算（对话框据此决定出不出「含卫星本体与天线布局」这一项）。
// 授权（D16）：isRedistributable(meta) 为假（STK 本机导入 / AGI SLA）一律不出图（连画都不画），数字表照出；
//   NASA / 社区 / CC BY 模型的图题带署名（credit），CC BY 另带许可名。
// 视轴方位 / 俯仰与本体遮挡掩模同一个函数（mask.maskAzEl，D2：本体系，az 自 +X 转向 +Y，el = +90° 为 +Z 天底），
//   报告与掩模图说的是同一套角（摸底 §3.5 坑⑤）。滚转 = 上向量相对 D1 缺省上向量（bodyFrame.defaultUpBody）绕视轴的右手角。
// 加载分两层，链路预算窗口平时两层都不背：
//   · 本文件（连同下面静态引的 schema / mask / bodyFrame / autoMatch / paramTemplates，及它们带进来的 glb / AGI 解析）
//     由 useLbReport 动态 import——第一次打开导出对话框数布局星时才载入；
//   · three / 加载器 / 参数化生成再动态 import 一层（stack()）——勾了这一章、真出图时才载入。
import { lbSatKey, grdSatKey, isRedistributable, SATKEY_NORAD_MAX } from '../../packages/core/models/schema.mjs'
import { maskAzEl } from '../../packages/core/models/mask.mjs'
import { defaultUpBody } from '../../packages/core/models/bodyFrame.mjs'
import { match as autoMatch } from '../../packages/core/models/autoMatch.mjs'
// 旧模板 id（2026-09-24 撤下的那几个，别名表见 paramTemplates.LEGACY_TEMPLATE_IDS）静默换成现行 id（param:default-sat）：老绑定照样出图、图题用现行模板名。
// paramTemplates 无依赖，autoMatch 本就静态引了它，这里不多背一字节
import { resolveParamModelId, resolveTemplateId, templateModelId, templateCatalog } from '../../packages/core/models/paramTemplates.mjs'
import { loadSatTree } from '../ngso/satTree.js'

// 对话框的注入键住在 lbReport.js（启动时就要、不能跟本文件一起按需加载），这里原样转出
export { LB_REPORT_LAYOUT_KEY } from './lbReport.js'

const R2D = 180 / Math.PI
const str = (v) => (v === undefined || v === null ? '' : String(v).trim())
const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(fin)
const z0 = (v) => (Object.is(v, -0) ? 0 : v)
function unit3(v) {
  if (!isVec3(v)) return null
  const n = Math.hypot(v[0], v[1], v[2])
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const noradNum = (v) => { const s = str(v); if (!/^\d{1,9}$/.test(s)) return null; const n = Number(s); return n >= 1 && n < SATKEY_NORAD_MAX ? n : null }

// —— 卫星库条目的身份 ——
// 四窗条目的形状：{ id, name, form:{ satelliteName, orbitAltitude?… }, grd?:{ satFolder }（GSO）,
//   ngsoSat?:{ mode, name, noradId, folder, orbit:{ name?, noradId? } }（NGSO / 再生 / 端到端） }
// 卫星名称字段四窗的出厂值（linkbudget/params.js、ngso/ngsoParams.js、regen/regenParams.js、e2e/e2eParams.js 的 def）——
// 只是占位符，不算星名（与 lbAutoName.SAT_NAME_PLACEHOLDER 同口径）
const SAT_NAME_PLACEHOLDER = 'Satellite'
// 取过星（天线树 / 星历检索，mode ≠ manual 且有轨道）时所选星的名字；手动轨道为空
function pickedNameOf(e) {
  const ns = (e && e.ngsoSat) || {}
  return ns.mode && ns.mode !== 'manual' && ns.orbit ? str(ns.name) : ''
}
/**
 * 报告里这颗星叫什么：与窗口自己的星名同口径（NGSO / 再生式 satNameOf）——取过星以所选星为准，其次表单里的卫星名称；
 * 卫星名称还是出厂占位符「Satellite」时改用库条目名（多颗星都没改名时，5.n 小节 / 表题 / 图题才分得清谁是谁），
 * 最后才回落到占位符本身与条目 id。
 */
export function satNameOf(e) {
  if (!e || typeof e !== 'object') return ''
  const f = e.form || {}, ns = e.ngsoSat || {}
  const form = str(f.satelliteName)
  return pickedNameOf(e) || (form && form !== SAT_NAME_PLACEHOLDER ? form : '') || str(e.name) || form || str(ns.name) || str(e.id)
}
function noradOf(e) {
  const ns = (e && e.ngsoSat) || {}
  return noradNum(ns.noradId) || noradNum(ns.orbit && ns.orbit.noradId) || noradNum(e && e.form && e.form.noradId) || null
}
function folderOf(e) { return str(e && e.ngsoSat && e.ngsoSat.folder) || str(e && e.grd && e.grd.satFolder) }
function treeNodeOf(e, tree) {
  const f = folderOf(e)
  return f ? (tree || []).find((s) => s && s.folder === f) || null : null
}

/**
 * 条目 → 绑定键候选（优先级从高到低，去重）：
 *   ① lbsat:<ns>:<条目 id>（D8：链路预算卫星库条目本身的身份，ns = 窗口库命名空间 geo / ngso / regen / e2e）；
 *   ② norad:<号>（条目选过星：ngsoSat.noradId / orbit.noradId）；
 *   ③ 条目引了 GRD 树里的星（ngsoSat.folder / grd.satFolder）：该星有 NORAD 就 norad:<号>，再 grdsat:<folder>（D8）。
 * @param {string} ns
 * @param {object} e 库条目
 * @param {{folder:string, noradId?:any}[]} [tree] GRD 卫星树（loadSatTree().sats）
 */
export function satKeysOf(ns, e, tree) {
  const keys = []
  const push = (k) => { if (k && !keys.includes(k)) keys.push(k) }
  if (!e || typeof e !== 'object') return keys
  push(lbSatKey(ns, e.id))
  const n = noradOf(e)
  if (n) push('norad:' + n)
  const f = folderOf(e)
  if (f) {
    const node = treeNodeOf(e, tree)
    const tn = node ? noradNum(node.noradId) : null
    if (tn) push('norad:' + tn)
    push(grdSatKey(f))
  }
  return keys
}

/**
 * 自动匹配（绑定写「自动」时）的输入：与 3D 页 modelOf 取同一颗星的同一组量——
 *   · NORAD：命中的键就是 norad:<号> 时用这个号（经 GRD 树命中的号条目自己不带）；否则条目选过的号，再否则所引树节点的号；
 *   · 名称：3D 页用的是目录名（OMM OBJECT_NAME）。条目里最接近它的依次是：取星轨道里记的目录名（ngsoSat.orbit.name，
 *     星历检索 / 树上关联星解析出的池记录名）→ 取星时的星名 → 所引 GRD 树节点的星名（GSO 取星把它回填进表单名，
 *     但用户可能改过表单名）→ 报告里的星名。
 * 用户自己起的名（「天链中继」）仍可能与目录名（TDRS 5）不同，那时只能靠 NORAD 规则兜，与模型工作台同一局限。
 */
export function matchInputOf(e, hitKey, tree) {
  const m = /^norad:(\d+)$/.exec(String(hitKey || ''))
  const node = treeNodeOf(e, tree)
  const ns = (e && e.ngsoSat) || {}
  const picked = pickedNameOf(e)
  const orbitName = picked && ns.orbit ? str(ns.orbit.name) : ''
  return {
    noradId: (m && noradNum(m[1])) || noradOf(e) || (node ? noradNum(node.noradId) : null) || null,
    name: orbitName || picked || (node ? str(node.satName) : '') || satNameOf(e)
  }
}

// 同名的星加条目名区分（「Satellite（中星6D-Ku）」）；条目名也撞（或没有）就按出场次序编号
function disambiguate(list, lang) {
  const en = lang === 'en'
  const wrap = (a, b) => (en ? `${a} (${b})` : `${a}（${b}）`)
  const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())
  const c0 = count(list.map((it) => it.satName))
  for (const it of list) {
    const en_ = str(it.entry && it.entry.name)
    if (c0.get(it.satName) > 1 && en_ && en_ !== it.satName) it.satName = wrap(it.satName, en_)
  }
  const c1 = count(list.map((it) => it.satName))
  const seq = new Map()
  for (const it of list) {
    if (c1.get(it.satName) < 2) continue
    const k = (seq.get(it.satName) || 0) + 1
    seq.set(it.satName, k)
    it.satName = wrap(it.satName, String(k))
  }
  return list
}

/** 绑定里有没有「布局数据」：指定模型（非 auto / 非 null）、挂点、质量特性覆盖三者有其一。 */
export function hasLayoutData(b) {
  if (!b || typeof b !== 'object') return false
  const mid = b.model && Object.prototype.hasOwnProperty.call(b.model, 'id') ? b.model.id : 'auto'
  return (typeof mid === 'string' && mid !== 'auto') || (Array.isArray(b.mounts) && b.mounts.length > 0) || !!(b.massProps && typeof b.massProps === 'object')
}

/**
 * 本份报告的卫星里哪些进第 5 章：逐条目按候选键找第一份「有布局数据」的绑定；同一颗星（同一个键）只出一次，次序 = 首次出现。
 * 进章的星名撞了（常见于几颗星的卫星名称都没改、库条目名也回落成占位符）按条目名 / 次序区分，见 disambiguate。
 * @param {{ns:string, sats:object[], bindings:object, tree?:object[], lang?:'zh'|'en'}} o
 * @returns {{entry:object, satKey:string, binding:object, satName:string, norad:number|null, match:{name:string, noradId:number|null}}[]}
 */
export function resolveLayoutSats({ ns, sats, bindings, tree, lang } = {}) {
  const out = []
  const seen = new Set()
  const B = bindings && typeof bindings === 'object' ? bindings : {}
  for (const e of sats || []) {
    if (!e || typeof e !== 'object') continue
    let hit = null
    for (const k of satKeysOf(ns, e, tree)) {
      const b = Object.prototype.hasOwnProperty.call(B, k) ? B[k] : null
      if (hasLayoutData(b)) { hit = { k, b }; break }
    }
    if (!hit || seen.has(hit.k)) continue
    seen.add(hit.k)
    const match = matchInputOf(e, hit.k, tree)
    out.push({ entry: e, satKey: hit.k, binding: hit.b, satName: satNameOf(e), norad: match.noradId, match })
  }
  return disambiguate(out, lang)
}

// —— 挂点 → 报告读数（全部是数，名字除外）——
/**
 * @param {object} m 绑定表里的 mount（schema.normalizeMount 的产出）
 * @returns {{id, name, pos:number[3], azDeg, elDeg, rollDeg, fovDeg:number|null, gimbalType:'none'|'azel'|'xy',
 *            limits:{a1Min,a1Max,a2Min,a2Max}|null, rateDegS:number|null, sysTempK:number|null}|null}
 */
export function mountReadout(m) {
  if (!m || typeof m !== 'object' || !isVec3(m.posBody)) return null
  const bore = unit3(m.boresightBody) || [0, 0, 1]
  const ae = maskAzEl(bore)
  // 滚转：上向量相对 D1 缺省上向量（本体 −Y 在视轴法平面的投影）绕视轴的右手角，(−180, 180]；缺省上向量 = 0
  const u0 = defaultUpBody(bore)
  let roll = 0
  const up = unit3(m.upBody)
  if (u0 && up) {
    const k = dot3(up, bore)
    const u = unit3([up[0] - k * bore[0], up[1] - k * bore[1], up[2] - k * bore[2]])
    if (u) roll = Math.atan2(dot3(cross3(u0, u), bore), dot3(u0, u)) * R2D
    if (Math.abs(roll) < 1e-9) roll = 0
    if (roll <= -180) roll += 360
  }
  const g = m.gimbal && typeof m.gimbal === 'object' ? m.gimbal : {}
  const type = g.type === 'azel' || g.type === 'xy' ? g.type : 'none'
  const L = g.limits && typeof g.limits === 'object' ? g.limits : {}
  const lim = (k, d) => (fin(L[k]) ? L[k] : d)
  return {
    id: str(m.id), name: str(m.name) || str(m.id),
    pos: m.posBody.map(z0),
    azDeg: z0(ae.az), elDeg: z0(ae.el), rollDeg: z0(roll),
    fovDeg: fin(m.fovDeg) && m.fovDeg > 0 ? m.fovDeg : null,
    gimbalType: type,
    limits: type === 'none' ? null : { a1Min: lim('a1Min', -180), a1Max: lim('a1Max', 180), a2Min: lim('a2Min', -90), a2Max: lim('a2Max', 90) },
    rateDegS: type !== 'none' && fin(g.rateDegS) && g.rateDegS > 0 ? g.rateDegS : null,
    sysTempK: fin(m.sysTempK) && m.sysTempK > 0 ? m.sysTempK : null
  }
}

// 署名：NASA / 社区件带 credit（NASA 用途准则「保留第三方贡献者署名」）；CC BY 必须署名，并带许可名
function creditOf(meta) {
  const s = (meta && meta.source) || {}
  const credit = str(s.credit), lic = str(s.license)
  const cc = /\bCC[\s-]*BY\b[\w\s.-]*/i.exec(lic)
  if (cc) return { credit: credit || str(meta && (meta.title || meta.titleZh)) || str(meta && meta.id), license: cc[0].trim() }
  if ((s.kind === 'nasa' || s.kind === 'community') && credit) return { credit, license: '' }
  return null
}

/**
 * 一颗星的纯数据块（报告模型 bodyLayout.sats[i]）。授权闸在这里兜底：redistributable=false 的模型即便调用方给了图也丢掉。
 * @param {{satKey, satName, norad?, binding, modelId?, meta?, bboxBody?:{min,max}|null, views?:{dataUrl,w,h}|null, lang?}} o
 */
export function layoutSatBlock(o) {
  const b = o.binding || {}
  const meta = o.meta || null
  const mp = (b.massProps && typeof b.massProps === 'object') ? b.massProps : (meta && meta.massProps) || null
  const redist = meta ? isRedistributable(meta) : null
  const box = o.bboxBody
  const bbox = box && isVec3(box.min) && isVec3(box.max) ? [0, 1, 2].map((k) => z0(box.max[k] - box.min[k])) : null
  const cr = meta ? creditOf(meta) : null
  const en = o.lang === 'en'
  const views = redist && o.views && typeof o.views.dataUrl === 'string' && /^data:image\/png;base64,/.test(o.views.dataUrl)
    ? { dataUrl: o.views.dataUrl, w: o.views.w | 0, h: o.views.h | 0 } : null
  let mass = null
  if (mp && fin(mp.massKg) && mp.massKg > 0 && isVec3(mp.comBody)) {
    const I = Array.isArray(mp.inertiaBody) && mp.inertiaBody.length === 3 && mp.inertiaBody.every(isVec3) ? mp.inertiaBody.map((r) => r.map(z0)) : null
    mass = {
      massKg: mp.massKg, com: mp.comBody.map(z0), inertia: I,
      source: ['manual', 'estimate', 'components'].includes(mp.source) ? mp.source : 'manual',
      // 与 schema.normMassProps 同口径：惯量缺失的估算只能是 low
      confidence: mp.confidence === 'high' && (I || mp.source !== 'estimate') ? 'high' : 'low',
      overridden: !!(b.massProps && typeof b.massProps === 'object')
    }
  }
  return {
    satKey: str(o.satKey), satName: str(o.satName), norad: o.norad || null,
    modelId: str(o.modelId) || null,
    modelTitle: meta ? (en ? str(meta.title) || str(meta.titleZh) : str(meta.titleZh) || str(meta.title)) || str(meta.id) : '',
    credit: cr ? cr.credit : '', license: cr ? cr.license : '',
    redistributable: redist,
    views,
    bbox, sizeVerified: !!(meta && meta.units && meta.units.sizeVerified),
    mass,
    mounts: (Array.isArray(b.mounts) ? b.mounts : []).map(mountReadout).filter(Boolean)
  }
}

// —— 自动匹配（绑定写 'auto' 时用哪个模型；与 3D 页 modelOf 同一口径：名称 / NORAD / 轨道区制，输入取法见 matchInputOf）——
function orbitKindOf(ns, e) {
  if (ns === 'geo') return 'GEO'
  const alt = Number(e && e.form && e.form.orbitAltitude)
  if (!(alt > 0)) return ''
  return alt > 30000 ? 'GEO' : alt > 2000 ? 'MEO' : 'LEO'
}
function modelIdFor(it, ns, lib, prefs) {
  const mid = it.binding.model && Object.prototype.hasOwnProperty.call(it.binding.model, 'id') ? it.binding.model.id : 'auto'
  if (mid === null) return null
  if (typeof mid === 'string' && mid !== 'auto') return resolveParamModelId(mid)
  const mi = it.match || { name: it.satName, noradId: it.norad }
  const hit = autoMatch({ name: mi.name, noradId: mi.noradId, orbitKind: orbitKindOf(ns, it.entry) },
    { available: lib && lib.length ? new Set(lib) : null, prefs: prefs || undefined })
  return (hit && hit.id && resolveParamModelId(hit.id)) || null
}

async function readBindings(api) {
  const m = api && api.models
  if (!m || !m.bindingsGet) return null
  let r = null
  try { r = await m.bindingsGet() } catch (e) { r = null }
  if (!r || r.locked || !r.bindings || typeof r.bindings !== 'object') return null
  return { bindings: r.bindings, prefs: r.prefs || null }
}
function readTree() { try { return loadSatTree().sats || [] } catch (e) { return [] } }
const listOf = (sats) => (typeof sats === 'function' ? sats() : sats) || []

/**
 * 对话框用：本份报告里有几颗星有布局数据（0 = 不出那一项）。只读绑定表，不加载模型。
 * @param {{api:object, ns:string, sats:object[]|(()=>object[])}} o
 */
export async function probeBodyLayout(o) {
  const b = await readBindings(o && o.api)
  if (!b) return 0
  return resolveLayoutSats({ ns: o.ns, sats: listOf(o.sats), bindings: b.bindings, tree: readTree() }).length
}

/**
 * 组第 5 章的数据块。
 * @param {{api:object, ns:string, sats:object[]|(()=>object[]), lang?:'zh'|'en', font?:string,
 *          onStep?:(text:string, done:number, total:number)=>void,
 *          render?:(o:{api, modelId, binding, attachPoints, lang, font, onWait})=>Promise<{meta, bboxBody, views}|null>}} o
 *   render 缺省 = 本文件的 three 出图（单测注入假的）；onWait(received, total) 是等远端模型下载时的进度回调（可为 null）。
 * @returns {Promise<{sats:object[]}|null>} 没有任何星有布局数据时为 null
 */
export async function buildBodyLayout(o) {
  const api = o && o.api
  const b = await readBindings(api)
  if (!b) return null
  const lang = o.lang === 'en' ? 'en' : 'zh'
  const list = resolveLayoutSats({ ns: o.ns, sats: listOf(o.sats), bindings: b.bindings, tree: readTree(), lang })
  if (!list.length) return null
  // 自动匹配要知道库里有哪些模型（与 3D 页同：manifest 为空时视为全部可用）
  let lib = null, prefs = b.prefs
  if (list.some((it) => !it.binding.model || it.binding.model.id === 'auto' || it.binding.model.id === undefined)) {
    try {
      const man = api.models.manifest ? await api.models.manifest() : null
      if (man && !man.locked && Array.isArray(man.models)) lib = man.models.map((m) => m && m.id).filter(Boolean)
      if (!prefs && man && man.prefs) prefs = man.prefs
    } catch (e) { lib = null }
  }
  const render = typeof o.render === 'function' ? o.render : renderBody
  const out = []
  try {
    for (let i = 0; i < list.length; i++) {
      const it = list[i]
      const label = it.satName || it.satKey
      if (o.onStep) o.onStep(label, i, list.length)
      // 远端模型在下载时把进度写进同一行（「TDRS · 下载模型 1.2 / 3.4 MB」），免得看着像卡住
      const onWait = o.onStep ? (got, tot) => o.onStep(label + downloadText(got, tot, lang), i, list.length) : null
      const modelId = modelIdFor(it, o.ns, lib, prefs)
      // 三视图上的挂点引线画本星的 mounts（摸底 §3.5：浅拷进 meta.attachPoints）
      const attachPoints = (Array.isArray(it.binding.mounts) ? it.binding.mounts : [])
        .filter((m) => m && isVec3(m.posBody))
        .map((m) => ({ name: str(m.name) || str(m.id), posBody: m.posBody.slice(), dirBody: (m.boresightBody || [0, 0, 1]).slice(), upBody: Array.isArray(m.upBody) ? m.upBody.slice() : undefined }))
      let r = null
      if (modelId) {
        try { r = await render({ api, modelId, binding: it.binding, attachPoints, lang, font: o.font, onWait }) } catch (e) {
          r = null
          if (typeof console !== 'undefined') console.warn('[report] 卫星本体出图失败：' + (it.satName || it.satKey) + ' ' + ((e && e.message) || e))
        }
      }
      const blk = layoutSatBlock({
        satKey: it.satKey, satName: it.satName, norad: it.norad, binding: it.binding, modelId,
        meta: r && r.meta, bboxBody: r && r.bboxBody, views: r && r.views, lang
      })
      // 什么都给不出（模型取不到、没挂点、没质量）就不占一节
      if (blk.views || blk.bbox || blk.mass || blk.mounts.length) out.push(blk)
    }
  } finally {
    if (render === renderBody) await releaseRenderer()
  }
  if (o.onStep) o.onStep('', list.length, list.length)
  return out.length ? { sats: out } : null
}

// ============================================================================================
// 缺省出图：模型 → 本体系包围盒 + 三视图四宫格（three，动态加载）
// ============================================================================================
let _stack = null
function stack() {
  if (!_stack) {
    _stack = Promise.all([
      import('three'),
      import('../viz/models/thumbs.js'),
      import('../viz/models/view.js'),
      import('../viz/models/loader.js'),
      import('../viz/models/irToThree.js'),
      import('../../packages/core/models/paramBus.mjs'),
      import('../../packages/core/models/fleet/index.mjs')
    ]).then(([THREE, thumbs, view, loader, ir, pb, fl]) => ({ THREE, thumbs, view, loader, ir, pb, fl }))
    _stack.catch(() => { _stack = null })
  }
  return _stack
}
async function releaseRenderer() {
  if (!_stack) return
  try { const S = await _stack; await S.thumbs.disposeThumbs() } catch (e) { /* 出图器没建过 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function downloadText(got, tot, lang) {
  const mb = (b) => (b / 1048576).toFixed(1)
  const en = lang === 'en'
  const g = Number(got) > 0 ? Number(got) : 0, t = Number(tot) > 0 ? Number(tot) : 0
  return (en ? ' · downloading model ' : ' · 下载模型 ') + (t ? `${mb(g)} / ${mb(t)} MB` : `${mb(g)} MB`)
}
// 远端模型取哪个文件（models.ensure 的契约见 electron/services/models.js 头注）。报告一格 640 px：
//   ① 要 lod1；本机已有就用它；
//   ② lod1 不在本机、但本机有别的档（随包的 lod2 / 缓存过的 lod0）：立刻用那一档出图，不等——lod1 留在后台接着下，下回就是它；
//   ③ 本机一档都没有：改要最小的 lod2（下载队列里 lod2 本就排最前），边等边把字节进度交给 onWait；
//      有进展就一直等（总上限 90 s），连续 12 s 一个字节都没进（断网 / 卡住）就放弃——这颗星不出图，数字表照出。
const STALL_MS = 12000, WAIT_MAX_MS = 90000, POLL_MS = 400
/** @param {{stall?:number, max?:number, poll?:number}} [tm] 三个时限（单测缩短用；缺省 12 s / 90 s / 0.4 s） */
export async function modelUrl(api, id, onWait, tm) {
  const stall = (tm && tm.stall) || STALL_MS, max = (tm && tm.max) || WAIT_MAX_MS, poll = (tm && tm.poll) || POLL_MS
  const t0 = Date.now()
  let want = 'lod1', lastGot = -1, lastMove = t0
  for (;;) {
    let r = null
    try { r = await api.models.ensure({ id, lod: want }) } catch (e) { r = null }
    if (!r || r.locked || r.state === 'missing' || r.state === 'param') return null
    if (r.state === 'ready' && r.url) return r.url
    if (r.fallback && r.fallback.url) return r.fallback.url
    if (r.state === 'error') {
      if (want !== 'lod2') { want = 'lod2'; continue }
      return null
    }
    if (want !== 'lod2') { want = 'lod2'; continue }
    const now = Date.now()
    const got = Number(r.received) || 0
    if (got !== lastGot) { lastGot = got; lastMove = now }
    if (onWait) { try { onWait(got, Number(r.total) || 0) } catch (e) { /* 进度显示出错不拦出图 */ } }
    if (now - lastMove > stall || now - t0 > max) return null
    await sleep(poll)
  }
}
async function acquire(S, api, id, onWait) {
  if (id.startsWith('param:')) {
    // 参数化：模板现场生成；用户另存的参数化件（param:<hash>）按元数据里的 spec 生成（与 3D 页 modelLayer 同）
    // 次序与 3D 页 modelLayer.paramTemplate 同：模板 id（含旧 id 别名）按模板现生成，其余按元数据里的 spec
    let m0 = null
    try { m0 = api.models && api.models.getMeta ? await api.models.getMeta(id) : null } catch (e) { m0 = null }
    if (m0 && (m0.locked || typeof m0 !== 'object')) m0 = null
    const tid = resolveTemplateId(id.slice(6))
    let r = null
    if (tid) r = S.pb.buildTemplateModel(tid)
    else if (S.fl.isFleetId(id)) r = S.fl.buildFleetModel(id)   // 星座精模（fleet/）：按型号现生成
    else if (m0 && m0.spec) r = S.pb.buildParamModel(m0.spec)
    if (!r) return null
    const cid = tid ? templateModelId(tid) : id
    const cat = templateCatalog().find((c) => c.id === cid) || (r.fleet ? S.fl.fleetCatalog().find((c) => c.id === cid) : null) || null
    const meta = Object.assign({ id, title: cat ? cat.title : id, titleZh: cat ? cat.titleZh : '' }, m0 || {}, {
      id,
      source: (m0 && m0.source) || (cat && cat.source) || { kind: 'param', credit: '', license: 'param', redistributable: true },
      frame: r.frame, units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: true },
      massProps: (m0 && m0.massProps) || r.massProps,
      articulations: r.articulations
    })
    const root = S.ir.irToThree(r.ir)
    return { root, meta, release: () => S.loader.disposeObject(root) }
  }
  let meta = null
  try { meta = await api.models.getMeta(id) } catch (e) { meta = null }
  if (!meta || meta.locked || !meta.frame) return null
  const url = await modelUrl(api, id, onWait)
  if (!url) return { root: null, meta, release() {} }
  const res = await S.loader.loadModel(url)
  return { root: res.root, meta, release: () => res.handle.release() }
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error || new Error('读取图片失败'))
    fr.readAsDataURL(blob)
  })
}
const VIEW_TITLES_EN = ['Front (+X)', 'Side (+Y)', 'Top (−Z)', 'Perspective']

// —— 挂点纳入取景 ——
// thumbs.renderThreeView 的取景只看模型网格（sampleWorldPoints）：挂点在模型外（常见于模型尺寸未核定、挂点按真实尺寸填的：
// NASA TDRS 件 3 m、单址天线挂点在 ±4 m）时，点与引线会跑出格子、名字被格边裁掉。这里给每个挂点挂一块退化三角形
// （三个顶点重合、面积 0：光栅化不出任何像素，取景采样却一定采到它的第 0 号顶点——sampleWorldPoints 每个网格从 0 号起抽），
// 让四格的取景都把挂点框进去。只加在出图用的那一层外壳上，包围盒（exactBox）另用不带它们的克隆量，报告的尺寸不受影响。
function withMountProxies(S, root, meta, attachPoints) {
  const THREE = S.THREE
  const host = new THREE.Group()
  host.add(root)
  const toModel = S.view.modelToBodyMatrix(meta).invert()   // 本体 → 模型轴（与 thumbs 挂架的 holder 矩阵互逆）
  const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false })
  const geos = []
  const v = new THREE.Vector3()
  for (const ap of attachPoints) {
    if (!isVec3(ap.posBody)) continue
    v.fromArray(ap.posBody).applyMatrix4(toModel)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([v.x, v.y, v.z, v.x, v.y, v.z, v.x, v.y, v.z], 3))
    geos.push(g)
    const m = new THREE.Mesh(g, mat)
    m.name = '__report_mount_proxy'
    m.frustumCulled = false
    host.add(m)
  }
  return {
    host,
    release() {
      host.remove(root)
      for (const g of geos) g.dispose()
      mat.dispose()
    }
  }
}

// —— 英文报告的格标题 ——
// thumbs.renderThreeView 的格标题写死中文（前视（+X）/ 侧视（+Y）/ 顶视（−Z）/ 透视）。英文报告在这里改写：清掉各格左上的
// 标题带、按同一字号 / 字重 / 描边写英文。标题带（格边下 2.2 字高）不会碰到别的东西：正交格的取景四周留 9% 格宽（1.22 倍半宽），
// 透视格留 10%，挂点名的中心被夹在 3 字高以下（上沿 2.35 字高）——且挂点已纳入取景（见上），引线也到不了这一带。
// renderThreeView 以后认 o.titles 了（已照传），这一步就是原样重写一遍，无害。
async function relabelViews(blob, cell, titles, font) {
  const W = cell * 2
  const bmp = await createImageBitmap(blob)
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = W
  const c = cv.getContext('2d')
  c.drawImage(bmp, 0, 0)
  if (bmp.close) bmp.close()
  const fs = Math.round(cell / 40)   // 与 thumbs.drawThreeView 同一字号
  const cells = [[0, 0], [1, 0], [0, 1], [1, 1]]   // 左上 前视、右上 侧视、左下 顶视、右下 透视（同 thumbs）
  cells.forEach(([cx, cy], i) => {
    const x = cx * cell, y = cy * cell
    c.clearRect(x + 2, y + 2, Math.round(cell * 0.45), Math.round(fs * 2.2))   // 让开格线（x = cell + 0.5 / y = cell + 0.5）
    c.font = `600 ${fs}px ${font}`; c.textAlign = 'left'; c.textBaseline = 'middle'
    c.lineJoin = 'round'; c.lineWidth = Math.max(3, fs * 0.28); c.strokeStyle = 'rgba(255,255,255,0.9)'
    c.strokeText(titles[i], x + fs, y + fs * 1.2)
    c.fillStyle = '#2b2d31'; c.fillText(titles[i], x + fs, y + fs * 1.2)
  })
  return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'))
}

async function renderBody({ api, modelId, binding, attachPoints, lang, font, onWait }) {
  const S = await stack()
  const a = await acquire(S, api, modelId, onWait)
  if (!a) return null
  // 逐星的模型轴覆盖（绑定表 model.frameOverride {q, t}，契约 §3.4）：同 3D 页 modelLayer.frameMeta，缩放仍取元数据
  const fo = binding && binding.model && binding.model.frameOverride
  //   与 frameMeta 逐条同：q 必须合法，t 缺省沿用元数据里的（再缺省原点）
  const f0 = (a.meta && a.meta.frame) || {}
  const meta = fo && Array.isArray(fo.q) && fo.q.length === 4
    ? Object.assign({}, a.meta, { frame: Object.assign({}, f0, { q_model2body: fo.q.slice(), t_model2body: Array.isArray(fo.t) && fo.t.length === 3 ? fo.t.slice() : (f0.t_model2body || [0, 0, 0]).slice() }) })
    : a.meta
  try {
    if (!a.root) return { meta, bboxBody: null, views: null }
    // 本体系包围盒：自己的一份克隆摆静止位姿（喷焰这类初值 0 的关节件不算），逐顶点左乘「模型 → 本体」
    const clone = a.root.clone(true)
    S.thumbs.applyRestPose(clone, meta)
    clone.updateMatrixWorld(true)
    const box = S.thumbs.exactBox(clone, S.view.modelToBodyMatrix(meta))
    const bboxBody = box.empty ? null : { min: box.min, max: box.max }
    let views = null
    if (isRedistributable(meta)) {
      const cell = 640
      const face = font || '"Microsoft YaHei", "Segoe UI", Arial, sans-serif'
      const opts = { cell, font: face }
      if (lang === 'en') opts.titles = VIEW_TITLES_EN.slice()
      const px = withMountProxies(S, a.root, meta, attachPoints)
      let blob = null
      try {
        blob = await S.thumbs.renderThreeView(px.host, Object.assign({}, meta, { attachPoints }), opts)
      } finally { px.release() }
      if (blob && lang === 'en') {
        // 改写失败（画布 / 解码出错）就用原图：格标题是中文，总比整张图丢了好
        try { blob = (await relabelViews(blob, cell, VIEW_TITLES_EN, face)) || blob } catch (e) { /* 原图 */ }
      }
      if (blob && /png/.test(blob.type || 'image/png')) views = { dataUrl: await blobToDataUrl(blob), w: cell * 2, h: cell * 2 }
    }
    return { meta, bboxBody, views }
  } finally {
    try { a.release() } catch (e) { /* ignore */ }
  }
}
