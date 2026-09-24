// 装配件的入库元数据（三期 P3「装配」页签，DESIGN3 E1–E5；P3 实施契约 §1.3 / §2.3）。
//
// 为什么单独成模块：同一份「buildAssembly 结果 → ModelMeta」要在三处出：工作台装配页入库（wbStore.saveAssembly）、
// 库里实体模板的运行时预览（wbStore.showAssembly，ent: 条目）、单测。字段口径若各写一份，迟早出现「入库的 kind 与预览不同」
// 「bboxM 一处是本体系、一处是模型轴」。主进程 saveImported 的 asm 分支另按同一张 ASM_DOMAIN_KINDS 强制 kind / 来源（渲染端给的不认）。
//
// 口径：
//   · id：asm:<12 位十六进制>（入库件）或 ent:<模板 id>（运行时预览）；由调用方给，这里不生成。
//   · source：缺省 {kind:'user', redistributable:true}（用户自建件，E4）；ent 预览传 builtin 那份。
//   · kind / group：按装配领域（schema.ASM_DOMAIN_KINDS；地球站 = 'ground'）。fidelity = 'parametric'。
//   · frame：buildAssembly 的 frame（领域 q：卫星 = STK 映射，飞机 / 船 / 车 / 地球站 = +Y 天顶），importQ = 同一个 q
//     （工作台「本体轴 · 出厂映射」回到它；装配件的轴向由领域定，不由来源猜）。
//   · geometry.bboxM：【模型轴、米】（与 NASA 条目 / 参数化 / 导入件同口径）：本体 bboxBody 的 8 个角点按 frame 逆变换再取外包。
//     领域 q 都是带号轴置换，逆变换逐分量是 ±原值，结果精确（−0 抹成 0）。
//   · massProps：只留 massKg / comBody / inertiaBody（source 'components'、confidence 'low'），丢掉逐件明细 components。
//   · parts / attachPoints / articulations / solarPanelGroups：buildAssembly 原样（名字只由组件 id 派生，改显示名不动）。
//   · title = titleZh = 文档名（空则按领域「卫星装配件」…）；tags = ['assembly', 领域]；aliases = [文档名]。
//   · files 留空：主进程 saveImported 入库时填 lod0 / thumb。
//
// 导出：
//   ASM_DEFAULT_NAMES, defaultAsmName(domain), assemblyModelMeta(r, base)
//
// 只 import schema.mjs / bodyFrame.mjs（不 import assembly.mjs：不把组件注册表拖进只需要元数据的调用方）。纯函数、零 three。

import { ASM_DOMAIN_KINDS, SCHEMA_VERSION, isAssemblySpec, normalizeMeta } from './schema.mjs'
import { quatToMat } from './bodyFrame.mjs'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const z0 = (v) => (v === 0 ? 0 : v)

/** 领域 → 缺省文档名（name 为空时用）。 */
export const ASM_DEFAULT_NAMES = Object.freeze({
  spacecraft: '卫星装配件',
  ground: '地球站装配件',
  aircraft: '飞机装配件',
  ship: '船舶装配件',
  vehicle: '车辆装配件'
})

/** 领域 → 缺省名；认不出的领域给「装配件」。 */
export function defaultAsmName(domain) {
  return typeof domain === 'string' && Object.hasOwn(ASM_DEFAULT_NAMES, domain) ? ASM_DEFAULT_NAMES[domain] : '装配件'
}

/**
 * 本体系包围盒 → 模型轴包围盒：v_model = Rᵀ·(v_body − t)，8 个角点取外包。q 非法 / 盒子不成形返回 null。
 * 领域 q 是带号轴置换时逐分量精确（0·x 与 ±1·x 都不引入舍入），只抹 −0。
 */
function bodyBoxToModel(bb, frame) {
  if (!isObj(bb) || !isVec3(bb.min) || !isVec3(bb.max) || !isObj(frame)) return null
  const R = quatToMat(frame.q_model2body)
  if (!R) return null
  const t = isVec3(frame.t_model2body) ? frame.t_model2body : [0, 0, 0]
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let c = 0; c < 8; c++) {
    const p = [(c & 1 ? bb.max[0] : bb.min[0]) - t[0], (c & 2 ? bb.max[1] : bb.min[1]) - t[1], (c & 4 ? bb.max[2] : bb.min[2]) - t[2]]
    for (let k = 0; k < 3; k++) {
      // Rᵀ 的第 k 行 = R 的第 k 列
      const v = R[0][k] * p[0] + R[1][k] * p[1] + R[2][k] * p[2]
      if (v < mn[k]) mn[k] = v
      if (v > mx[k]) mx[k] = v
    }
  }
  return { min: mn.map(z0), max: mx.map(z0) }
}

/**
 * buildAssembly 结果 → 完整 ModelMeta（已 normalizeMeta）。
 * @param {object} r     buildAssembly(doc) 的返回（与 buildParamModel 同键；r.spec 为归一后的装配文档）
 * @param {{id:string, name?:string, domain?:string, source?:object, updatedAt?:string|null, tags?:string[]}} base
 *        id 必给（asm:… 或 ent:…）；name 缺省取 r.spec.name、再缺按领域缺省名；domain 缺省取 r.spec.domain；
 *        source 缺省 user / 可分发；updatedAt 缺省 null（入库时主进程另盖时间戳）。
 * @returns {object} ModelMeta
 */
export function assemblyModelMeta(r, base) {
  if (!isObj(r) || !isAssemblySpec(r.spec)) throw new TypeError('assemblyModelMeta：r 须为 buildAssembly 的结果')
  const b = isObj(base) ? base : {}
  const spec = r.spec
  const domain = typeof b.domain === 'string' && Object.hasOwn(ASM_DOMAIN_KINDS, b.domain)
    ? b.domain
    : (Object.hasOwn(ASM_DOMAIN_KINDS, spec.domain) ? spec.domain : 'spacecraft')
  const kind = ASM_DOMAIN_KINDS[domain]
  const nm = [b.name, spec.name].find((s) => typeof s === 'string' && s.trim())
  const name = nm ? nm.trim() : defaultAsmName(domain)
  const fr = isObj(r.frame) ? r.frame : {}
  const q = Array.isArray(fr.q_model2body) ? fr.q_model2body.slice() : null
  const frame = {
    q_model2body: q,
    t_model2body: isVec3(fr.t_model2body) ? fr.t_model2body.slice() : [0, 0, 0],
    // 装配件的轴向由领域定死（不是猜的），按「核过」记
    verified: fr.verified !== false,
    importQ: q ? q.slice() : undefined
  }
  if (!frame.importQ) delete frame.importQ
  const meshes = r.ir && Array.isArray(r.ir.meshes) ? r.ir.meshes : []
  let tris = 0
  for (const m of meshes) if (m && m.index && Number.isInteger(m.index.length)) tris += Math.floor(m.index.length / 3)
  const bboxM = bodyBoxToModel(r.bboxBody, frame) || { min: [0, 0, 0], max: [0, 0, 0] }
  const mp = isObj(r.massProps) ? r.massProps : null
  const source = isObj(b.source) ? plain(b.source) : { kind: 'user', url: '', credit: '', license: '', redistributable: true }
  const tags = ['assembly', domain]
  if (Array.isArray(b.tags)) for (const t of b.tags) if (typeof t === 'string' && t && !tags.includes(t)) tags.push(t)
  return normalizeMeta({
    schema: SCHEMA_VERSION,
    id: b.id,
    title: name,
    titleZh: name,
    kind,
    group: kind,
    fidelity: 'parametric',
    source,
    files: {},
    units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false },
    frame,
    geometry: {
      bboxM,
      boundingRadiusM: isNum(r.boundingRadiusM) ? r.boundingRadiusM : 0,
      tris,
      areaM2: 0,
      volumeM3: null,
      closed: false,
      centroidM: [0, 0, 0]
    },
    parts: plain(r.parts) || [],
    massProps: mp ? { massKg: mp.massKg, comBody: plain(mp.comBody), inertiaBody: plain(mp.inertiaBody), source: 'components', confidence: 'low' } : null,
    attachPoints: plain(r.attachPoints) || [],
    articulations: plain(r.articulations) || [],
    solarPanelGroups: plain(r.solarPanelGroups) || [],
    spec: plain(spec),
    tags,
    aliases: [name],
    updatedAt: b.updatedAt === undefined ? null : b.updatedAt
  })
}
