// 导出：Object3D + ModelMeta → { glb, gmdf, satsimJson }（DESIGN §5.5 / 任务书 §5.7）。
//
// 产物口径（STK 能直接读、本工具能原样读回）：
//   · glTF 2.0 binary、Y 朝上、米、节点名唯一且是原名（GLTFLoader 读进来时 sanitize 过，原名在 userData.name，这里恢复）。
//   · 轴向「烘进几何」（bakeFrame，缺省开）：导出坐标 = 出厂映射下的 glTF 系，即 v_gltf' = R₀⁻¹·(v_body − t')，
//     R₀ = 出厂映射 = STK 映射（bodyFrame.mjs DEFAULT_Q_MODEL2BODY，经 view.js 转出；2026-09-24 从附录 B 切过来）：
//     glTF +Y = 本体 +Z（天底面）、glTF +Z = 本体 +X（速度向）、glTF +X = 本体 +Y。于是导出件的 q_model2body 恒为出厂值——
//     STK 读 glTF 时正是按这个换轴，卫星本体 +Z 对准天底后天线朝地，不用再告诉它这颗星怎么转；本工具读回也不用改 frame。
//     ★ 飞机 / 船舶 / 车辆 / 地球站（kind ∈ ENTITY_KINDS）的烘焙目标是 Q_YUP_ZENITH（标准 glTF「+Y 上、+Z 前」，STK 的
//     Air / Sea / Land / facility 件同口径；P3 契约 §11-2 / DESIGN3 E5），见 bakeTargetOf。
//   · 原点 = 质心（originAtCom，缺省开，有 massProps.comBody 时）：t' = comBody，写进 satsim.frame.t_model2body；
//     本体系下的一切（挂点 posBody、质心、部件法向）数值不变 —— 平移只发生在「模型系 ↔ 本体系」这一层。
//     没有质量特性时 t' = 原 t（原点不动）。
//   · 变换放在场景根节点的 TRS 上（trs:true），不改顶点：节点层级与节点名原样保留，按节点名的 AGI / gmdf / parts 不受影响。
//     根是 GLTFLoader 的场景组 / irToThree 的 ir_root / importers 的根（打了 userData.__sceneRoot）时把它「摊平」：
//     它的子节点直接当 glTF 场景根节点 —— 否则每导出再导入一次就多套一层。
//   · AGI：根级 AGI_articulations.articulations、AGI_stk_metadata.solarPanelGroups 与节点级标记，一律经 GLTFExporter 插件的
//     afterParse 钩子调 packages/core/models/agi.mjs 的 applyAgiToGltfJson 写（与主进程、单测同一份规则：名字合法性、
//     一节点一关节、空段省略、extensionsUsed 同步）。★ 不整份深拷 writer.json 回写：贴图的 bufferView 在 afterParse
//     之后才异步回填到 json.images[i]，换了对象就回填丢了。只把节点的 extensions 与根 extensions 两处搬回去。
//     挂点若没有对应节点（参数化 / 手点的挂点），在导出坐标里新建一个空节点：原点 = 挂点位置，轴向按 agi.mjs 的
//     attachNodeMatrix（视轴 = 局部 +Y、上向 = 局部 +X，按本机 STK 12 核定；与 attachPointPoses 读回同一套数）。
//   · extras.satsim = 全量 ModelMeta（去掉本机专用的 local / files，units 改为米、frame 改为导出后的值）。
//   · .gmdf = agi.mjs buildGmdf（按节点名）；没有任何 AGI 元数据时为 null（不写旁车）。
//   · 导出前逐网格 normalizeNormals（glTF-Validator 把非单位法向判 Error；零长法向补 (0,1,0)）；
//     userData 里的内部键（_ 开头、gltfExtensions、name）清掉，免得变成 extras 垃圾。
//
// 授权闸（四道闸之一「导出 glb」，DESIGN §0.1 / §4）：与主进程 models:export 同一判据 —— schema.mjs 的 isRedistributable
//   （redistributable === true 且不是 STK 来源）。不满足抛 { code:'not-redistributable' }；STK 本机模型的状态是「STK 模型不可导出。」
//   （AGI SLA §2.3(d)「拆出独立使用」）。用户自己导入的模型主进程入库时记 redistributable:true，所以照样能导。
//
// meshopt 压缩（EXT_meshopt_compression v0，可选）：对 GLTFExporter 的产物再过一遍 —— 顶点属性按 ATTRIBUTES、
//   三角形索引按 TRIANGLES 编码进 BIN，原数据位置改指一个无数据的回退缓冲（fallback:true）。不量化（量化会动顶点值，
//   读回逐项相等就不成立了）。见 meshoptCompressGlb 的注释与验证台结论。
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import * as WebGLTextureUtils from 'three/addons/utils/WebGLTextureUtils.js'
import { applyAgiToGltfJson, buildGmdf, attachNodeMatrix } from '@core/models/agi.mjs'
import { defaultUpBody, isUpDegenerate, ENTITY_KINDS, Q_YUP_ZENITH } from '@core/models/bodyFrame.mjs'
import { parseGlb, buildGlb } from '@core/models/glb.mjs'
import { uniqueNodeNames } from '@core/models/ir.mjs'
import { isRedistributable } from '@core/models/schema.mjs'
import { modelToBodyMatrix, DEFAULT_Q_MODEL2BODY } from './view.js'
import { LOD_PRESETS, createAnalyzer, disposeLod } from './analyze.js'
import { irLayout, splitMultiMaterial, disposeBorrowed } from './irToThree.js'
import { originalName } from './loader.js'

const codeErr = (code, msg) => Object.assign(new Error(msg), { code })

/** 是否 STK 来源（状态文案用） */
export function isStkModel(meta) {
  const s = meta && meta.source
  if (s && s.kind === 'stk-local') return true
  return typeof (meta && meta.id) === 'string' && meta.id.startsWith('stk:')
}

/**
 * 导出闸：返回 null = 放行；否则返回状态文案（界面直接显示；条款放 title，由调用方写）。
 * 判据与主进程 models:export、云端发布、分享包同一个 isRedistributable。
 */
export function exportBlocked(meta) {
  if (isRedistributable(meta)) return null
  return isStkModel(meta) ? 'STK 模型不可导出。' : '该模型不可导出。'
}

/**
 * 烘焙目标（bakeFrame 开时导出件的 q_model2body；P3 契约 §11-2 / DESIGN3 E5）：
 *   飞机 / 船舶 / 车辆 / 地球站（bodyFrame.ENTITY_KINDS）→ Q_YUP_ZENITH（标准 glTF「+Y 朝上、+Z 朝前」，STK Air / Sea / Land / facility 件同口径）；
 *   其余（卫星 / 运载 / 未知）→ 出厂 STK 映射 DEFAULT_Q_MODEL2BODY。
 * @param {object} meta ModelMeta（只读 kind）
 * @returns {{q:number[], key:'yup'|'stk'}} q 为新数组
 */
export function bakeTargetOf(meta) {
  const ent = !!(meta && typeof meta.kind === 'string' && ENTITY_KINDS.includes(meta.kind))
  return ent ? { q: Q_YUP_ZENITH.slice(), key: 'yup' } : { q: DEFAULT_Q_MODEL2BODY.slice(), key: 'stk' }
}

function cleanUserData(ud) {
  if (!ud) return
  for (const k of Object.keys(ud)) if (k === 'name' || k === 'gltfExtensions' || k.startsWith('_')) delete ud[k]
}

// 法向：单位化；零长 / 非有限的补一个合法单位向量（Validator 对 ACCESSOR_NON_UNIT 判 Error）
function fixNormals(g) {
  const n = g.attributes.normal
  if (n) {
    for (let i = 0; i < n.count; i++) {
      let x = n.getX(i), y = n.getY(i), z = n.getZ(i)
      const l = Math.hypot(x, y, z)
      if (!(l > 1e-12) || !Number.isFinite(l)) { x = 0; y = 1; z = 0 } else { x /= l; y /= l; z /= l }
      n.setXYZ(i, x, y, z)
    }
    n.needsUpdate = true
  }
  const t = g.attributes.tangent
  if (t && t.itemSize === 4) {
    for (let i = 0; i < t.count; i++) {
      let x = t.getX(i), y = t.getY(i), z = t.getZ(i)
      const l = Math.hypot(x, y, z)
      if (!(l > 1e-12)) { x = 1; y = 0; z = 0 } else { x /= l; y /= l; z /= l }
      t.setXYZW(i, x, y, z, t.getW(i) < 0 ? -1 : 1)
    }
  }
}

/**
 * @param {THREE.Object3D} root 模型根（模型系；来自 loader / irToThree / importers）
 * @param {object} meta ModelMeta
 * @param {{lod?:'lod0'|'lod1'|'lod2', meshopt?:boolean, originAtCom?:boolean, bakeFrame?:boolean, alreadyLod?:boolean}} [opts]
 * @returns {Promise<{glb:Uint8Array, gmdf:object|null, satsimJson:object, info:{bytes:number, nodes:number, ms:number, errors:string[], warnings:string[], lodTris?:object}}>}
 */
export async function exportGlb(root, meta, opts = {}) {
  const t0 = performance.now()
  const blocked = exportBlocked(meta)
  if (blocked) throw codeErr('not-redistributable', blocked)
  const lod = LOD_PRESETS[opts.lod] ? opts.lod : 'lod0'
  const originAtCom = opts.originAtCom !== false
  const bake = opts.bakeFrame !== false
  const warnings = []

  let src = root, lodObj = null
  if (lod !== 'lod0' && !opts.alreadyLod) {
    const an = createAnalyzer()
    try { lodObj = await an.simplifyObject(root, LOD_PRESETS[lod]) } finally { an.dispose() }
    src = lodObj
  }
  const madeGeoms = [], madeMats = [], borrowed = []
  try {
    // ---- 1. 克隆（几何深拷：要改法向；材质浅拷：共享贴图）----
    // 几何按「原几何 → 拷贝」去重：同一几何被多个节点实例引用时导出件里仍是一份（GLTFExporter 按属性对象缓存访问器）
    const flatten = !!(src.isScene || (src.userData && src.userData.__sceneRoot))
    const model0 = src.clone(true)
    const matMap = new Map(), geoMap = new Map()
    const cloneMat = (m) => {
      if (!m) return m
      let c = matMap.get(m)
      if (!c) {
        c = m.clone()
        const key = m.userData && m.userData.materialKey
        c.userData = key ? { materialKey: key } : {}
        matMap.set(m, c); madeMats.push(c)
      }
      return c
    }
    model0.traverse((o) => {
      if (o.isMesh && o.geometry) {
        let g = geoMap.get(o.geometry)
        if (!g) { g = o.geometry.clone(); g.userData = {}; fixNormals(g); geoMap.set(o.geometry, g); madeGeoms.push(g) }
        o.geometry = g
        o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material)
      }
    })
    // ---- 1b. 多材质网格拆成 IR 的样子 + 节点名 = IR 名（irLayout）----
    // segment.mjs / paramBus 给出的 parts.nodes、solarPanelGroups.nodes 用的是 IR 名：多材质子节点「对象名_材质名」、
    // 重名节点的 _2 / _3。导出件的节点必须就叫这些名字，AGI 太阳翼组与部件才找得到节点、再导入后逐项相等。
    const model = splitMultiMaterial(model0)
    model.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.userData._borrowed) borrowed.push(o.geometry) })
    const renamed = Object.create(null)
    for (const e of irLayout(model)) {
      const orig = originalName(e.obj)
      e.obj.name = e.name
      if (!(e.isRoot && flatten) && e.name !== orig) renamed[e.name] = orig
    }
    model.traverse((o) => cleanUserData(o.userData))

    // ---- 2. 导出坐标：E = R_keep⁻¹ · T(−t') · M(模型→本体)；烘焙时 R_keep = 按类别的烘焙目标（bakeTargetOf：
    //      飞机 / 船 / 车 / 地球站 = +Y 天顶，其余 = 出厂 STK 映射），否则保留原 q ----
    const f = (meta && meta.frame) || {}
    const q0 = Array.isArray(f.q_model2body) && f.q_model2body.length === 4 ? f.q_model2body : DEFAULT_Q_MODEL2BODY
    const t0v = Array.isArray(f.t_model2body) && f.t_model2body.length === 3 ? f.t_model2body : [0, 0, 0]
    const com = originAtCom && meta && meta.massProps && Array.isArray(meta.massProps.comBody) && meta.massProps.comBody.length === 3 && meta.massProps.comBody.every(Number.isFinite)
      ? meta.massProps.comBody : null
    const tNew = com ? com.slice() : t0v.slice()
    const qKeep = bake ? bakeTargetOf(meta).q : q0.slice()
    const Rk = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(qKeep[0], qKeep[1], qKeep[2], qKeep[3]).normalize())
    const RkInv = Rk.clone().invert()
    const E = RkInv.clone().multiply(new THREE.Matrix4().makeTranslation(-tNew[0], -tNew[1], -tNew[2])).multiply(modelToBodyMatrix(meta))

    const tops = flatten ? model.children.slice() : [model]
    const setTop = (o, M) => { o.matrix.copy(M); o.matrix.decompose(o.position, o.quaternion, o.scale); o.matrixAutoUpdate = true }
    if (flatten) {
      model.updateMatrix()
      const RL = model.matrix.clone()
      for (const c of tops) { c.updateMatrix(); setTop(c, E.clone().multiply(RL).multiply(c.matrix)) }
    } else {
      model.updateMatrix()
      setTop(model, E.clone().multiply(model.matrix))
    }

    // ---- 3. 节点名：非空、唯一（互操作硬要求）；改了名的记进 nodeNameMap ----
    // 1b 已按 irLayout 唯一化过；这里再过一遍 uniqueNodeNames 只是兜底（摊平后的顶层集合是 irLayout 名字的子集，正常不会再改）
    const all = []
    for (const t of tops) t.traverse((o) => all.push(o))
    const un = uniqueNodeNames(all.map((o) => o.name))
    all.forEach((o, i) => { o.name = un.names[i] })
    for (const [nw, old] of Object.entries(un.map)) renamed[nw] = Object.hasOwn(renamed, old) ? renamed[old] : old
    const nRenamed = Object.keys(renamed).length
    if (nRenamed) warnings.push('节点名重名或为空，已改名 ' + nRenamed + ' 个')
    const names = new Set(un.names)

    // ---- 4. 挂点：有节点的直接标；没有的在导出坐标里造空节点 ----
    const aps = []
    const vp = new THREE.Vector3(), vz = new THREE.Vector3(), vy = new THREE.Vector3()
    const byName = new Map()
    for (const o of all) if (!byName.has(o.name)) byName.set(o.name, o)
    const topSet = new Set(tops)
    for (const ap of (meta && Array.isArray(meta.attachPoints) ? meta.attachPoints : [])) {
      if (!ap || typeof ap.name !== 'string' || !ap.name) continue
      const explicit = typeof ap.node === 'string' && ap.node
      const key = explicit ? ap.node : ap.name
      const hit = byName.get(key)
      // 空的顶层节点 = 上一次导出时我们造的挂点节点（读回来又导出）：就地按当前 posBody / dirBody 重摆，不另造 ——
      // 否则每往返一次多一批节点（验证台实测过 70 → 73）
      const ours = hit && !hit.isMesh && hit.children.length === 0 && topSet.has(hit) && Array.isArray(ap.posBody)
      if (hit && !ours && (explicit || !Array.isArray(ap.posBody))) { aps.push({ name: ap.name, node: key }); continue }   // 指名道姓的节点：位姿以节点为准
      if (!Array.isArray(ap.posBody)) { warnings.push('挂点「' + ap.name + '」没有位置，未导出'); continue }
      // 节点局部轴口径由 agi.mjs 定（按本机 STK 12 核定：视轴 = 局部 +Y、上向 = 局部 +X），矩阵一律由 attachNodeMatrix 造，
      // 读回 attachPointPoses 才是同一套数。上向缺省 / 退化时在本体系里按 D1 规则（defaultUpBody）补好再换到导出坐标 ——
      // attachNodeMatrix 自己的兜底只在本体系里才等于 D1。
      const dirB = Array.isArray(ap.dirBody) && ap.dirBody.length === 3 ? ap.dirBody : [0, 0, 1]
      const upB = Array.isArray(ap.upBody) && ap.upBody.length === 3 && !isUpDegenerate(dirB, ap.upBody) ? ap.upBody : (defaultUpBody(dirB) || [1, 0, 0])
      vp.fromArray(ap.posBody).sub(new THREE.Vector3(tNew[0], tNew[1], tNew[2])).applyMatrix4(RkInv)
      vz.fromArray(dirB).applyMatrix4(RkInv)
      vy.fromArray(upB).applyMatrix4(RkInv)
      const M = attachNodeMatrix([vp.x, vp.y, vp.z], [vz.x, vz.y, vz.z], [vy.x, vy.y, vy.z])
      if (!M) { warnings.push('挂点「' + ap.name + '」位姿不合法，未导出'); continue }
      let o = ours ? hit : null
      let nm = key
      if (!o) {
        // 自由挂点与已有网格节点重名：另起「名字_ap」，免得把挂点标到那个网格上
        if (names.has(nm)) { let k = 1; do { nm = ap.name + '_ap' + (k > 1 ? k : ''); k++ } while (names.has(nm)) }
        o = new THREE.Object3D()
        o.name = nm
        names.add(nm)
        tops.push(o)
      }
      o.matrix.fromArray(M)
      o.matrix.decompose(o.position, o.quaternion, o.scale)
      aps.push({ name: ap.name, node: nm })
    }
    const agiInput = {
      attachPoints: aps,
      articulations: (meta && Array.isArray(meta.articulations)) ? meta.articulations : [],
      solarPanelGroups: (meta && Array.isArray(meta.solarPanelGroups)) ? meta.solarPanelGroups : [],
      noObscurationNodes: (meta && Array.isArray(meta.noObscurationNodes)) ? meta.noObscurationNodes : []
    }

    // ---- 5. satsim 元数据 ----
    const satsimJson = JSON.parse(JSON.stringify(meta || {}))
    delete satsimJson.local; delete satsimJson.files
    satsimJson.units = { ...(satsimJson.units || {}), scaleToMeters: 1, unitGuess: 'm' }
    // importQ：导出件的「出厂映射」就是这次烘焙 / 保留的 q（读回时 metaFromGltf 按 extras.satsim.frame 的 q 定，与它一致）
    satsimJson.frame = { ...(satsimJson.frame || {}), q_model2body: qKeep, t_model2body: tNew, importQ: qKeep.slice() }
    if (nRenamed) satsimJson.nodeNameMap = { ...(satsimJson.nodeNameMap || {}), ...renamed }
    // LOD 件：三角形重新编过号，按 lod0 编号的 triRanges / triRange / tris 全部作废（只留按节点名的归属），三角形数改成本档的
    if (lod !== 'lod0') {
      for (const p of Array.isArray(satsimJson.parts) ? satsimJson.parts : []) { if (p && typeof p === 'object') { delete p.triRanges; delete p.triRange; delete p.tris } }
      const st = src.userData && src.userData._lodStats
      if (st && satsimJson.geometry && typeof satsimJson.geometry === 'object') satsimJson.geometry.tris = st.tris1
    }
    // 挂点记下落在哪个节点（下次导出直接认它，不再造新节点）
    if (Array.isArray(satsimJson.attachPoints)) for (const p of satsimJson.attachPoints) { const hit = aps.find((x) => x.name === p.name); if (hit) p.node = hit.node }
    satsimJson.updatedAt = new Date().toISOString()

    // ---- 6. GLTFExporter + afterParse ----
    let agiErrors = [], agiWarnings = []
    const exporter = new GLTFExporter()
    // KTX2（CompressedTexture）贴图导出前要先解压回位图；不设这个 GLTFExporter 直接抛错（deps 报告 §1.3 ④）
    exporter.setTextureUtils(WebGLTextureUtils)
    exporter.register((writer) => ({
      afterParse() {
        const j = writer.json
        const nodes = Array.isArray(j.nodes) ? j.nodes : []
        const shim = { nodes: nodes.map((n) => ({ name: n.name, extensions: n.extensions ? { ...n.extensions } : undefined })), extensions: j.extensions ? { ...j.extensions } : undefined, extensionsUsed: Object.keys(writer.extensionsUsed) }
        const r = applyAgiToGltfJson(shim, agiInput)
        agiErrors = r.errors; agiWarnings = r.warnings
        if (r.json) {
          nodes.forEach((n, i) => { const e = r.json.nodes[i] && r.json.nodes[i].extensions; if (e && Object.keys(e).length) n.extensions = e; else delete n.extensions })
          if (r.json.extensions) j.extensions = r.json.extensions; else delete j.extensions
          const used = new Set(r.json.extensionsUsed || [])
          for (const k of ['AGI_articulations', 'AGI_stk_metadata']) { if (used.has(k)) writer.extensionsUsed[k] = true; else delete writer.extensionsUsed[k] }
        }
        j.extras = { ...(j.extras || {}), satsim: satsimJson }
        if (Array.isArray(j.scenes) && j.scenes[0]) j.scenes[0].name = String((meta && (meta.title || meta.id)) || 'model')
      }
    }))
    const maxTextureSize = LOD_PRESETS[lod].maxTexture
    const ab = await exporter.parseAsync(tops, { binary: true, trs: true, onlyVisible: true, includeCustomExtensions: false, maxTextureSize })
    let glb = new Uint8Array(ab)
    if (opts.meshopt) glb = await meshoptCompressGlb(glb)

    const gm = buildGmdf(agiInput)
    const info = {
      bytes: glb.byteLength, nodes: names.size,
      ms: Math.round(performance.now() - t0),
      errors: [...agiErrors, ...gm.errors], warnings: [...warnings, ...agiWarnings, ...gm.warnings]
    }
    if (src.userData && src.userData._lodStats) info.lodTris = src.userData._lodStats
    return { glb, gmdf: gm.gmdf, satsimJson, info }
  } finally {
    for (const g of borrowed) disposeBorrowed(g)   // 子几何与拷贝几何共享属性：先摘属性再放，只放自己的索引
    for (const g of madeGeoms) g.dispose()
    for (const m of madeMats) m.dispose()
    if (lodObj) disposeLod(lodObj)
  }
}

// ---------------------------------------------------------------------------------------------
// EXT_meshopt_compression（version 0）
// ---------------------------------------------------------------------------------------------
const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const align4 = (n) => (n + 3) & ~3

/**
 * 给 GLTFExporter 的 glb 加 meshopt 压缩。只压「一个访问器独占、紧排、从 0 起」的缓冲视图（GLTFExporter 的产物都是这样）；
 * 顶点属性元素字节数须是 4 的倍数（规范要求），不满足的原样留着。贴图、动画等其余视图原样搬进新 BIN。
 * @param {Uint8Array} glbU8
 * @returns {Promise<Uint8Array>}
 */
export async function meshoptCompressGlb(glbU8) {
  const { MeshoptEncoder } = await import('meshoptimizer')
  await MeshoptEncoder.ready
  const p = parseGlb(glbU8)
  if (!p.ok) throw new Error(p.error)
  const json = JSON.parse(JSON.stringify(p.json))
  const bin = p.bin || new Uint8Array(0)
  const bvs = Array.isArray(json.bufferViews) ? json.bufferViews : []
  const acc = Array.isArray(json.accessors) ? json.accessors : []
  const users = bvs.map(() => [])
  acc.forEach((a, i) => { if (a && Number.isInteger(a.bufferView)) users[a.bufferView].push(i) })
  const plan = bvs.map(() => null)   // {mode, count, stride}
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const attrs = Object.values(prim.attributes || {})
      for (const t of prim.targets || []) attrs.push(...Object.values(t))
      for (const ai of attrs) {
        const a = acc[ai]; if (!a || !Number.isInteger(a.bufferView)) continue
        const bv = bvs[a.bufferView]
        const es = COMP_SIZE[a.componentType] * TYPE_N[a.type]
        const stride = bv.byteStride || es
        if (users[a.bufferView].length !== 1 || (a.byteOffset || 0) !== 0 || stride % 4 || stride > 256 || stride * a.count !== bv.byteLength) continue
        plan[a.bufferView] = { mode: 'ATTRIBUTES', count: a.count, stride }
      }
      if (Number.isInteger(prim.indices)) {
        const a = acc[prim.indices]; if (!a || !Number.isInteger(a.bufferView)) continue
        const bv = bvs[a.bufferView], es = COMP_SIZE[a.componentType]
        if (users[a.bufferView].length !== 1 || (a.byteOffset || 0) !== 0 || (es !== 2 && es !== 4) || es * a.count !== bv.byteLength) continue
        const tri = (prim.mode === undefined || prim.mode === 4) && a.count % 3 === 0
        plan[a.bufferView] = { mode: tri ? 'TRIANGLES' : 'INDICES', count: a.count, stride: es }
      }
    }
  }
  // 新 BIN：压缩数据与未压缩视图依次排，4 字节对齐；压缩视图的原位置改指回退缓冲（buffer 1，无数据）
  const parts = []
  let off = 0, fbOff = 0, nComp = 0
  bvs.forEach((bv, i) => {
    const src = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)
    const pl = plan[i]
    if (pl) {
      const enc = MeshoptEncoder.encodeGltfBuffer(src, pl.count, pl.stride, pl.mode, 0)
      parts.push([off, enc])
      bv.extensions = { ...(bv.extensions || {}), EXT_meshopt_compression: { buffer: 0, byteOffset: off, byteLength: enc.byteLength, byteStride: pl.stride, count: pl.count, mode: pl.mode } }
      off = align4(off + enc.byteLength)
      bv.buffer = 1; bv.byteOffset = fbOff
      fbOff = align4(fbOff + bv.byteLength)
      nComp++
    } else {
      parts.push([off, src])
      bv.buffer = 0; bv.byteOffset = off
      off = align4(off + bv.byteLength)
    }
  })
  if (!nComp) return glbU8
  const out = new Uint8Array(off)
  for (const [o, d] of parts) out.set(d, o)
  json.buffers = [{ byteLength: off }, { byteLength: Math.max(4, fbOff), extensions: { EXT_meshopt_compression: { fallback: true } } }]
  const add = (k, name) => { const l = Array.isArray(json[k]) ? json[k] : []; if (!l.includes(name)) l.push(name); json[k] = l }
  add('extensionsUsed', 'EXT_meshopt_compression')
  add('extensionsRequired', 'EXT_meshopt_compression')
  return buildGlb(json, out)
}
