// AGI 互操作：AGI_articulations / AGI_stk_metadata 扩展与 .gmdf 旁车的读写（任务书 §2.2；设计契约 T5、T15）。
//
// 为什么和 STK 同一套语义：挂点 / 关节 / 太阳翼组 / 不遮挡标记是 STK 用户已经在用的概念，按它的字段名
// 原样读写，模型在两边来回不丢信息；本平台专有的东西放 extras.satsim，不注册新扩展名（任务书 §2.5）。
//
// 字段口径（Khronos Vendor 扩展规范 + github.com/AnalyticalGraphicsInc/gmdf 的 schema，2026-09-23 核对原文）：
//   glTF 根：extensions.AGI_articulations = { articulations: [ { name, stages:[{name,type,minimumValue,maximumValue,initialValue}], pointingVector? } ] }
//            extensions.AGI_stk_metadata  = { solarPanelGroups: [ { name, efficiency /*0–100 百分数*/ } ] }
//   glTF 节点：extensions.AGI_articulations = { isAttachPoint:true } 和 / 或 { articulationName }
//              extensions.AGI_stk_metadata  = { solarPanelGroupName } 和 / 或 { noObscuration:true }
//   .gmdf：{ AGI_articulations:{ attachPoints:[节点名], articulations:[{name, modelNodes:[节点名], stages, pointingVector?}] },
//            AGI_stk_metadata:{ solarPanelGroups:[{name, efficiency, modelNodes:[节点名]}], noObscurationNodes:[节点名] } }
//   · 关节名 / 关节级名 / 太阳翼组名不许含空白（schema pattern ^[^\s]+$）；数组都是 minItems 1——所以写出时空数组整段省略。
//   · 多个节点可以引用同一个关节（联动）；gmdf 里同名节点全部生效。
//   · ★ gmdf 与内嵌元数据同时存在时，STK 忽略内嵌、只用 gmdf（gmdf README「the embedded metadata are ignored」）。
//     mergeAgi 缺省照此（mode:'stk'）；另给 mode:'union' 按名合并、gmdf 同名优先，供工作台「保留两边」时用。
//
// 节点名一律用 json.nodes[i].name 原名（GLTFLoader 会把 node.name sanitize，原名在 userData.name；
// 这里读的是 JSON，拿到的就是原名）。无名节点记作 node_<下标>（与 ir.uniqueNodeNames 同一规则）并给警告。
//
// 安全：只读白名单字段，别的键（包括扩展对象里的 extensions / extras）一概不取；不 eval。
//
// 导出：
//   AGI_ARTICULATIONS, AGI_STK_METADATA, STAGE_TYPES, agiNameOk, emptyAgi, agiCounts
//   readAgiFromGltfJson(json)            → {attachPoints, articulations, solarPanelGroups, noObscurationNodes, nodeCount, errors, warnings}
//   readGmdf(objOrText)                  → 同上形状（无 nodeCount）
//   mergeAgi(embedded, gmdf, {mode})     → 同上形状 + source:'gmdf'|'embedded'|'union'|'none'
//   applyAgiToGltfJson(json, agi)        → {json /*深拷贝后改*/, errors, warnings}
//   buildGmdf(agi)                       → {gmdf: object|null, errors, warnings}
//   attachPointPoses(json, attachPoints, frame) → 给挂点补 posBody / dirBody / upBody（按节点世界矩阵；视轴 = 节点 +Y）
//   attachNodeMatrix(pos, dir, up)       → 挂点节点的局部矩阵（写出用，attachPointPoses 的逆）

import { gltfWorldMatrices } from './glb.mjs'
import { quatNormalize, modelToBody, quatRotate, DEFAULT_Q_MODEL2BODY, defaultUpBody, isUpDegenerate } from './bodyFrame.mjs'

export const AGI_ARTICULATIONS = 'AGI_articulations'
export const AGI_STK_METADATA = 'AGI_stk_metadata'
export const STAGE_TYPES = Object.freeze([
  'xTranslate', 'yTranslate', 'zTranslate',
  'xRotate', 'yRotate', 'zRotate',
  'xScale', 'yScale', 'zScale', 'uniformScale'
])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const q = (s) => JSON.stringify(s)

/** AGI 名字规则：非空、不含空白（关节名、关节级名、太阳翼组名适用；节点名不受此限）。 */
export function agiNameOk(s) {
  return typeof s === 'string' && /^[^\s]+$/.test(s)
}

export function emptyAgi() {
  return { attachPoints: [], articulations: [], solarPanelGroups: [], noObscurationNodes: [] }
}

/** 数量摘要（STK 扫描表的四列）。 */
export function agiCounts(agi) {
  const a = isObj(agi) ? agi : {}
  const n = (k) => (Array.isArray(a[k]) ? a[k].length : 0)
  return { attachPoints: n('attachPoints'), articulations: n('articulations'), solarPanelGroups: n('solarPanelGroups'), noObscurationNodes: n('noObscurationNodes') }
}

// 读一个关节级（stage）：五个字段必须齐全；不齐的丢弃并记警告（STK 的 schema 也是五个 required）
function readStage(s, where, warnings) {
  if (!isObj(s)) { warnings.push(`${where}：不是对象，已跳过`); return null }
  const out = {
    name: typeof s.name === 'string' ? s.name : '',
    type: typeof s.type === 'string' ? s.type : '',
    minimumValue: s.minimumValue,
    maximumValue: s.maximumValue,
    initialValue: s.initialValue
  }
  if (!out.name) { warnings.push(`${where}：缺 name，已跳过`); return null }
  if (!['minimumValue', 'maximumValue', 'initialValue'].every((k) => isNum(out[k]))) {
    warnings.push(`${where}「${out.name}」：minimumValue / maximumValue / initialValue 须为有限数，已跳过`)
    return null
  }
  if (!STAGE_TYPES.includes(out.type)) warnings.push(`${where}「${out.name}」：未知类型 ${q(out.type)}（原样保留）`)
  if (!agiNameOk(out.name)) warnings.push(`${where}：名字 ${q(out.name)} 含空白，STK 不认`)
  if (out.minimumValue > out.maximumValue) warnings.push(`${where}「${out.name}」：minimumValue > maximumValue`)
  return out
}

// 读一条关节定义（不含节点归属）；stages 为空的整条丢弃（schema minItems 1）
function readArticulationDef(a, where, errors, warnings) {
  if (!isObj(a)) { errors.push(`${where}：不是对象，已跳过`); return null }
  if (typeof a.name !== 'string' || !a.name) { errors.push(`${where}：缺 name，已跳过`); return null }
  if (!agiNameOk(a.name)) warnings.push(`${where}：关节名 ${q(a.name)} 含空白，STK 不认`)
  const stages = []
  if (!Array.isArray(a.stages)) errors.push(`${where}「${a.name}」：stages 不是数组`)
  else a.stages.forEach((s, k) => { const st = readStage(s, `${where}「${a.name}」.stages[${k}]`, warnings); if (st) stages.push(st) })
  if (!stages.length) { errors.push(`${where}「${a.name}」：没有有效的 stage，已跳过`); return null }
  const out = { name: a.name, nodes: [], stages }
  if (a.pointingVector !== undefined) {
    const pv = a.pointingVector
    if (Array.isArray(pv) && pv.length === 3 && pv.every(isNum) && Math.hypot(...pv) > 0) out.pointingVector = pv.slice()
    else warnings.push(`${where}「${a.name}」：pointingVector 不是非零三维向量，已忽略`)
  }
  return out
}

function readGroupDef(g, where, errors, warnings) {
  if (!isObj(g)) { errors.push(`${where}：不是对象，已跳过`); return null }
  if (typeof g.name !== 'string' || !g.name) { errors.push(`${where}：缺 name，已跳过`); return null }
  if (!agiNameOk(g.name)) warnings.push(`${where}：组名 ${q(g.name)} 含空白，STK 不认`)
  if (!isNum(g.efficiency)) { errors.push(`${where}「${g.name}」：efficiency 须为数（百分数 0–100），已跳过`); return null }
  if (g.efficiency < 0 || g.efficiency > 100) warnings.push(`${where}「${g.name}」：efficiency ${g.efficiency} 不在 0–100`)
  return { name: g.name, efficiency: g.efficiency, nodes: [] }
}

const pushUnique = (arr, v) => { if (!arr.includes(v)) arr.push(v) }

/**
 * 从 glTF JSON 读 AGI 元数据（根级定义 + 节点级归属）。坏结构不抛，进 errors / warnings。
 * 返回的 nodes 数组按节点下标顺序；多个节点引用同一关节 / 组时全部收进来。
 */
export function readAgiFromGltfJson(json) {
  const res = { ...emptyAgi(), nodeCount: 0, errors: [], warnings: [] }
  if (!isObj(json)) { res.errors.push('glTF JSON 不是对象'); return res }
  const nodes = Array.isArray(json.nodes) ? json.nodes : []
  res.nodeCount = nodes.length
  const rootExt = isObj(json.extensions) ? json.extensions : {}

  const artByName = new Map()
  const rootArt = rootExt[AGI_ARTICULATIONS]
  if (rootArt !== undefined) {
    if (!isObj(rootArt)) res.errors.push('根 AGI_articulations 不是对象')
    else if (rootArt.articulations !== undefined) {
      if (!Array.isArray(rootArt.articulations)) res.errors.push('根 AGI_articulations.articulations 不是数组')
      else rootArt.articulations.forEach((a, i) => {
        const d = readArticulationDef(a, `articulations[${i}]`, res.errors, res.warnings)
        if (!d) return
        if (artByName.has(d.name)) { res.warnings.push(`articulations[${i}]：关节名「${d.name}」重复，只取第一条`); return }
        artByName.set(d.name, d)
        res.articulations.push(d)
      })
    }
  }
  const grpByName = new Map()
  const rootMeta = rootExt[AGI_STK_METADATA]
  if (rootMeta !== undefined) {
    if (!isObj(rootMeta)) res.errors.push('根 AGI_stk_metadata 不是对象')
    else if (rootMeta.solarPanelGroups !== undefined) {
      if (!Array.isArray(rootMeta.solarPanelGroups)) res.errors.push('根 AGI_stk_metadata.solarPanelGroups 不是数组')
      else rootMeta.solarPanelGroups.forEach((g, i) => {
        const d = readGroupDef(g, `solarPanelGroups[${i}]`, res.errors, res.warnings)
        if (!d) return
        if (grpByName.has(d.name)) { res.warnings.push(`solarPanelGroups[${i}]：组名「${d.name}」重复，只取第一条`); return }
        grpByName.set(d.name, d)
        res.solarPanelGroups.push(d)
      })
    }
  }

  const nameCount = new Map()
  nodes.forEach((n) => { if (isObj(n) && typeof n.name === 'string' && n.name) nameCount.set(n.name, (nameCount.get(n.name) || 0) + 1) })
  const referenced = new Set()
  nodes.forEach((n, i) => {
    if (!isObj(n) || !isObj(n.extensions)) return
    const ea = n.extensions[AGI_ARTICULATIONS]
    const em = n.extensions[AGI_STK_METADATA]
    if (ea === undefined && em === undefined) return
    let name = typeof n.name === 'string' && n.name ? n.name : null
    if (!name) { name = `node_${i}`; res.warnings.push(`节点 #${i} 无名，按「${name}」记（gmdf 按名引用，建议先给节点起名）`) }
    else referenced.add(name)
    if (ea !== undefined) {
      if (!isObj(ea)) res.warnings.push(`节点「${name}」的 AGI_articulations 不是对象，已忽略`)
      else {
        if (ea.isAttachPoint === true) res.attachPoints.push({ name, node: name, nodeIndex: i })
        if (ea.articulationName !== undefined) {
          const d = typeof ea.articulationName === 'string' ? artByName.get(ea.articulationName) : null
          if (d) d.nodes.push(name)
          else res.warnings.push(`节点「${name}」引用的关节 ${q(ea.articulationName)} 在根上没有定义，已忽略`)
        }
      }
    }
    if (em !== undefined) {
      if (!isObj(em)) res.warnings.push(`节点「${name}」的 AGI_stk_metadata 不是对象，已忽略`)
      else {
        if (em.solarPanelGroupName !== undefined) {
          const g = typeof em.solarPanelGroupName === 'string' ? grpByName.get(em.solarPanelGroupName) : null
          if (g) g.nodes.push(name)
          else res.warnings.push(`节点「${name}」引用的太阳翼组 ${q(em.solarPanelGroupName)} 在根上没有定义，已忽略`)
        }
        if (em.noObscuration === true) pushUnique(res.noObscurationNodes, name)
      }
    }
  })
  for (const name of referenced) {
    if ((nameCount.get(name) || 0) > 1) res.warnings.push(`节点名「${name}」不唯一（${nameCount.get(name)} 个），按名引用时会同时命中`)
  }
  for (const d of res.articulations) if (!d.nodes.length) res.warnings.push(`关节「${d.name}」没有节点引用`)
  for (const g of res.solarPanelGroups) if (!g.nodes.length) res.warnings.push(`太阳翼组「${g.name}」没有节点引用`)
  return res
}

// gmdf 里的节点名表：字符串数组，去重、去非字符串
function readNameList(v, where, warnings) {
  if (v === undefined) return []
  if (!Array.isArray(v)) { warnings.push(`${where} 不是数组，已忽略`); return [] }
  const out = []
  v.forEach((s, i) => {
    if (typeof s !== 'string' || !s) warnings.push(`${where}[${i}] 不是非空字符串，已跳过`)
    else pushUnique(out, s)
  })
  return out
}

/**
 * 读 .gmdf（对象或 JSON 文本，允许带 BOM）。形状与 readAgiFromGltfJson 相同，节点一律按名。
 * 坏 JSON / 坏结构 → errors，不抛。
 */
export function readGmdf(input) {
  const res = { ...emptyAgi(), errors: [], warnings: [] }
  let obj = input
  if (typeof input === 'string') {
    try { obj = JSON.parse(input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input) } catch (e) { res.errors.push(`gmdf 不是合法 JSON：${e.message}`); return res }
  }
  if (!isObj(obj)) { res.errors.push('gmdf 不是对象'); return res }
  const art = obj[AGI_ARTICULATIONS]
  if (art !== undefined) {
    if (!isObj(art)) res.errors.push('gmdf.AGI_articulations 不是对象')
    else {
      for (const n of readNameList(art.attachPoints, 'gmdf.AGI_articulations.attachPoints', res.warnings)) res.attachPoints.push({ name: n, node: n })
      if (art.articulations !== undefined) {
        if (!Array.isArray(art.articulations)) res.errors.push('gmdf.AGI_articulations.articulations 不是数组')
        else {
          const seen = new Set()
          art.articulations.forEach((a, i) => {
            const d = readArticulationDef(a, `gmdf.articulations[${i}]`, res.errors, res.warnings)
            if (!d) return
            if (seen.has(d.name)) { res.warnings.push(`gmdf.articulations[${i}]：关节名「${d.name}」重复，只取第一条`); return }
            seen.add(d.name)
            d.nodes = readNameList(a.modelNodes, `gmdf.articulations[${i}].modelNodes`, res.warnings)
            if (!d.nodes.length) res.warnings.push(`gmdf 关节「${d.name}」没有 modelNodes`)
            res.articulations.push(d)
          })
        }
      }
    }
  }
  const meta = obj[AGI_STK_METADATA]
  if (meta !== undefined) {
    if (!isObj(meta)) res.errors.push('gmdf.AGI_stk_metadata 不是对象')
    else {
      if (meta.solarPanelGroups !== undefined) {
        if (!Array.isArray(meta.solarPanelGroups)) res.errors.push('gmdf.AGI_stk_metadata.solarPanelGroups 不是数组')
        else {
          const seen = new Set()
          meta.solarPanelGroups.forEach((g, i) => {
            const d = readGroupDef(g, `gmdf.solarPanelGroups[${i}]`, res.errors, res.warnings)
            if (!d) return
            if (seen.has(d.name)) { res.warnings.push(`gmdf.solarPanelGroups[${i}]：组名「${d.name}」重复，只取第一条`); return }
            seen.add(d.name)
            d.nodes = readNameList(g.modelNodes, `gmdf.solarPanelGroups[${i}].modelNodes`, res.warnings)
            if (!d.nodes.length) res.warnings.push(`gmdf 太阳翼组「${d.name}」没有 modelNodes`)
            res.solarPanelGroups.push(d)
          })
        }
      }
      res.noObscurationNodes = readNameList(meta.noObscurationNodes, 'gmdf.AGI_stk_metadata.noObscurationNodes', res.warnings)
    }
  }
  return res
}

// 深拷贝四个字段（只取白名单字段），供 merge 返回，避免调用方改结果时连带改了输入
function cloneAgi(a) {
  const s = isObj(a) ? a : {}
  const arr = (k) => (Array.isArray(s[k]) ? s[k] : [])
  return {
    attachPoints: arr('attachPoints').filter(isObj).map((p) => {
      const o = { name: p.name, node: p.node ?? p.name }
      if (Number.isInteger(p.nodeIndex)) o.nodeIndex = p.nodeIndex
      return o
    }),
    articulations: arr('articulations').filter(isObj).map((d) => {
      const o = { name: d.name, nodes: Array.isArray(d.nodes) ? d.nodes.slice() : [], stages: Array.isArray(d.stages) ? d.stages.map((st) => ({ ...st })) : [] }
      if (Array.isArray(d.pointingVector)) o.pointingVector = d.pointingVector.slice()
      return o
    }),
    solarPanelGroups: arr('solarPanelGroups').filter(isObj).map((g) => ({ name: g.name, efficiency: g.efficiency, nodes: Array.isArray(g.nodes) ? g.nodes.slice() : [] })),
    noObscurationNodes: arr('noObscurationNodes').filter((s) => typeof s === 'string').slice()
  }
}

/**
 * 合并内嵌与 gmdf。
 *   mode 'stk'（缺省）：gmdf 在（非 null）就整份用 gmdf、内嵌全部忽略——与 STK 行为一致，工作台看到的就是 STK 看到的。
 *   mode 'union'：按名合并，gmdf 同名项覆盖内嵌；挂点 / 不遮挡节点取并集。
 * errors / warnings 两边拼起来（带「内嵌：」「gmdf：」前缀），便于在状态栏里定位。
 */
export function mergeAgi(embedded, gmdf, opts = {}) {
  const mode = opts && opts.mode === 'union' ? 'union' : 'stk'
  const errs = (x, tag) => (isObj(x) && Array.isArray(x.errors) ? x.errors.map((e) => `${tag}${e}`) : [])
  const warns = (x, tag) => (isObj(x) && Array.isArray(x.warnings) ? x.warnings.map((e) => `${tag}${e}`) : [])
  const hasE = isObj(embedded), hasG = isObj(gmdf)
  const errors = [...errs(embedded, '内嵌：'), ...errs(gmdf, 'gmdf：')]
  const warnings = [...warns(embedded, '内嵌：'), ...warns(gmdf, 'gmdf：')]
  if (!hasG && !hasE) return { ...emptyAgi(), source: 'none', errors, warnings }
  if (!hasG) return { ...cloneAgi(embedded), source: 'embedded', errors, warnings }
  if (mode === 'stk' || !hasE) {
    if (hasE && (embedded.attachPoints?.length || embedded.articulations?.length || embedded.solarPanelGroups?.length || embedded.noObscurationNodes?.length)) {
      warnings.push('存在 gmdf，内嵌 AGI 元数据按 STK 规则忽略')
    }
    return { ...cloneAgi(gmdf), source: 'gmdf', errors, warnings }
  }
  const e = cloneAgi(embedded), g = cloneAgi(gmdf)
  const byName = (base, over) => {
    const m = new Map(base.map((x) => [x.name, x]))
    for (const x of over) m.set(x.name, x)
    return [...m.values()]
  }
  const ap = new Map(e.attachPoints.map((p) => [p.name, p]))
  for (const p of g.attachPoints) ap.set(p.name, p)
  const noObs = e.noObscurationNodes.slice()
  for (const n of g.noObscurationNodes) pushUnique(noObs, n)
  return {
    attachPoints: [...ap.values()],
    articulations: byName(e.articulations, g.articulations),
    solarPanelGroups: byName(e.solarPanelGroups, g.solarPanelGroups),
    noObscurationNodes: noObs,
    source: 'union', errors, warnings
  }
}

// 从节点扩展对象里删掉我们管理的键；删空了就把整个扩展删掉，extensions 空了也删
function stripNodeAgi(n) {
  if (!isObj(n) || !isObj(n.extensions)) return
  const ea = n.extensions[AGI_ARTICULATIONS]
  if (isObj(ea)) { delete ea.isAttachPoint; delete ea.articulationName; if (!Object.keys(ea).length) delete n.extensions[AGI_ARTICULATIONS] }
  else if (ea !== undefined) delete n.extensions[AGI_ARTICULATIONS]
  const em = n.extensions[AGI_STK_METADATA]
  if (isObj(em)) { delete em.solarPanelGroupName; delete em.noObscuration; if (!Object.keys(em).length) delete n.extensions[AGI_STK_METADATA] }
  else if (em !== undefined) delete n.extensions[AGI_STK_METADATA]
  if (!Object.keys(n.extensions).length) delete n.extensions
}

// 'node_<i>' → [i]（仅当第 i 个节点确实无名）；否则 null
function unnamedByFallback(nodes, name) {
  const m = typeof name === 'string' ? /^node_(\d+)$/.exec(name) : null
  if (!m) return null
  const i = Number(m[1])
  const n = nodes[i]
  return isObj(n) && !(typeof n.name === 'string' && n.name) ? [i] : null
}

const nodeExt = (n, key) => {
  if (!isObj(n.extensions)) n.extensions = {}
  if (!isObj(n.extensions[key])) n.extensions[key] = {}
  return n.extensions[key]
}

function cleanStage(s) {
  return { name: s.name, type: s.type, minimumValue: s.minimumValue, maximumValue: s.maximumValue, initialValue: s.initialValue }
}

/**
 * 把 AGI 元数据写进 glTF JSON（根级定义 + 节点级归属 + extensionsUsed）。输入 json 不改，返回深拷贝。
 * agi 直接传 ModelMeta 也行（字段同名）。
 * 规则：
 *   · 先清掉 JSON 里原有的 AGI 节点键与根定义，再按 agi 重写——调用两次结果相同；
 *   · 节点按原名定位，同名节点全部命中（与 gmdf 语义一致）；找不到的记 errors，该项其余节点照写；
 *   · 名字不合 AGI 规则（空白）的关节 / 太阳翼组 / stage 记 errors 并跳过，不写出 STK 读不了的东西；
 *   · 一个节点只能挂一个关节、一个太阳翼组：冲突时先到先得，后者记 errors；
 *   · 空数组整段省略（schema minItems 1）；某扩展一处都没用到就从 extensionsUsed / extensionsRequired 删掉，
 *     用到了就进 extensionsUsed（不进 extensionsRequired：规范建议可选）。
 */
export function applyAgiToGltfJson(json, agi) {
  const errors = [], warnings = []
  if (!isObj(json)) return { json: null, errors: ['glTF JSON 不是对象'], warnings }
  const out = JSON.parse(JSON.stringify(json))
  const a = cloneAgi(agi)
  const nodes = Array.isArray(out.nodes) ? out.nodes : []
  nodes.forEach(stripNodeAgi)
  const byName = new Map()
  nodes.forEach((n, i) => {
    if (isObj(n) && typeof n.name === 'string' && n.name) {
      if (!byName.has(n.name)) byName.set(n.name, [])
      byName.get(n.name).push(i)
    }
  })
  const find = (name, what) => {
    let hit = typeof name === 'string' ? byName.get(name) : null
    // 与读取端的兜底对称：无名节点读出来记作 node_<下标>，写回时同名找不到就按下标认回去
    // （STK 自带的 cubesat_3u_radial_panel.glb 根节点就是无名的，挂着关节）
    if (!hit) hit = unnamedByFallback(nodes, name)
    if (!hit) { errors.push(`${what}：找不到节点 ${q(name)}`); return [] }
    if (hit.length > 1) warnings.push(`${what}：节点名「${name}」有 ${hit.length} 个，全部生效`)
    return hit
  }
  let usedArt = false, usedMeta = false

  for (const p of a.attachPoints) {
    const nodeName = p.node ?? p.name
    for (const i of find(nodeName, `挂点「${p.name}」`)) { nodeExt(nodes[i], AGI_ARTICULATIONS).isAttachPoint = true; usedArt = true }
  }

  const rootArts = []
  const artOf = new Map()
  const seenArt = new Set()
  for (const d of a.articulations) {
    if (!agiNameOk(d.name)) { errors.push(`关节名 ${q(d.name)} 为空或含空白，已跳过`); continue }
    if (seenArt.has(d.name)) { errors.push(`关节名「${d.name}」重复，已跳过`); continue }
    const stages = []
    const seenStage = new Set()
    for (const s of d.stages) {
      if (!isObj(s) || !agiNameOk(s.name)) { errors.push(`关节「${d.name}」：stage 名 ${q(s && s.name)} 为空或含空白，已跳过`); continue }
      if (seenStage.has(s.name)) { errors.push(`关节「${d.name}」：stage 名「${s.name}」重复，已跳过`); continue }
      if (!STAGE_TYPES.includes(s.type)) { errors.push(`关节「${d.name}」.「${s.name}」：未知类型 ${q(s.type)}，已跳过`); continue }
      if (!['minimumValue', 'maximumValue', 'initialValue'].every((k) => isNum(s[k]))) { errors.push(`关节「${d.name}」.「${s.name}」：数值不全，已跳过`); continue }
      seenStage.add(s.name)
      stages.push(cleanStage(s))
    }
    if (!stages.length) { errors.push(`关节「${d.name}」：没有有效 stage，已跳过`); continue }
    seenArt.add(d.name)
    const def = { name: d.name, stages }
    if (Array.isArray(d.pointingVector) && d.pointingVector.length === 3 && d.pointingVector.every(isNum)) def.pointingVector = d.pointingVector.slice()
    rootArts.push(def)
    if (!d.nodes.length) warnings.push(`关节「${d.name}」没有节点`)
    for (const nn of d.nodes) {
      for (const i of find(nn, `关节「${d.name}」`)) {
        if (artOf.has(i)) { errors.push(`节点「${nn}」已挂关节「${artOf.get(i)}」，不能再挂「${d.name}」`); continue }
        artOf.set(i, d.name)
        nodeExt(nodes[i], AGI_ARTICULATIONS).articulationName = d.name
      }
    }
  }

  const rootGroups = []
  const grpOf = new Map()
  const seenGrp = new Set()
  for (const g of a.solarPanelGroups) {
    if (!agiNameOk(g.name)) { errors.push(`太阳翼组名 ${q(g.name)} 为空或含空白，已跳过`); continue }
    if (seenGrp.has(g.name)) { errors.push(`太阳翼组名「${g.name}」重复，已跳过`); continue }
    if (!isNum(g.efficiency) || g.efficiency < 0 || g.efficiency > 100) { errors.push(`太阳翼组「${g.name}」：efficiency 须在 0–100，已跳过`); continue }
    seenGrp.add(g.name)
    rootGroups.push({ name: g.name, efficiency: g.efficiency })
    if (!g.nodes.length) warnings.push(`太阳翼组「${g.name}」没有节点`)
    for (const nn of g.nodes) {
      for (const i of find(nn, `太阳翼组「${g.name}」`)) {
        if (grpOf.has(i)) { errors.push(`节点「${nn}」已在太阳翼组「${grpOf.get(i)}」，不能再进「${g.name}」`); continue }
        grpOf.set(i, g.name)
        nodeExt(nodes[i], AGI_STK_METADATA).solarPanelGroupName = g.name
        usedMeta = true
      }
    }
  }

  for (const nn of a.noObscurationNodes) {
    for (const i of find(nn, '不遮挡节点')) { nodeExt(nodes[i], AGI_STK_METADATA).noObscuration = true; usedMeta = true }
  }
  if (artOf.size) usedArt = true

  // 根级：保留原扩展对象里我们不管的键（extras 等），只替换 articulations / solarPanelGroups
  if (!isObj(out.extensions)) out.extensions = {}
  const ra = isObj(out.extensions[AGI_ARTICULATIONS]) ? out.extensions[AGI_ARTICULATIONS] : {}
  delete ra.articulations
  if (rootArts.length) { ra.articulations = rootArts; usedArt = true }
  if (Object.keys(ra).length) out.extensions[AGI_ARTICULATIONS] = ra
  else delete out.extensions[AGI_ARTICULATIONS]
  const rm = isObj(out.extensions[AGI_STK_METADATA]) ? out.extensions[AGI_STK_METADATA] : {}
  delete rm.solarPanelGroups
  if (rootGroups.length) { rm.solarPanelGroups = rootGroups; usedMeta = true }
  if (Object.keys(rm).length) out.extensions[AGI_STK_METADATA] = rm
  else delete out.extensions[AGI_STK_METADATA]
  if (!Object.keys(out.extensions).length) delete out.extensions

  // 最后按实际留下的扩展对象定 extensionsUsed：原文件的扩展对象里可能还剩我们不管的键（extras 等），
  // 那也算「用到」，否则 glTF-Validator 会报 UNDECLARED_EXTENSION
  const present = (key) => (isObj(out.extensions) && out.extensions[key] !== undefined) ||
    nodes.some((n) => isObj(n) && isObj(n.extensions) && n.extensions[key] !== undefined)
  usedArt = usedArt || present(AGI_ARTICULATIONS)
  usedMeta = usedMeta || present(AGI_STK_METADATA)

  const setUsed = (key, used) => {
    // 已在表里的保持原位置（不无谓改动 JSON，方便 diff）；没有才追加
    const had = Array.isArray(out.extensionsUsed) && out.extensionsUsed.includes(key)
    let list = Array.isArray(out.extensionsUsed) ? out.extensionsUsed.filter((x) => x !== key || used) : []
    if (used && !had) list.push(key)
    if (list.length) out.extensionsUsed = list
    else delete out.extensionsUsed
    if (!used && Array.isArray(out.extensionsRequired)) {
      out.extensionsRequired = out.extensionsRequired.filter((x) => x !== key)
      if (!out.extensionsRequired.length) delete out.extensionsRequired
    }
  }
  setUsed(AGI_ARTICULATIONS, usedArt)
  setUsed(AGI_STK_METADATA, usedMeta)
  return { json: out, errors, warnings }
}

/**
 * 生成 .gmdf 对象（按节点名）。空段省略；什么都没有返回 gmdf:null（不写旁车）。
 * 键序照 gmdf README 的示例（name、modelNodes、stages），纯为人读 diff 方便。
 * 名字不合规、没有节点（modelNodes minItems 1）的项跳过并记错——写出去 STK 也读不了。
 */
export function buildGmdf(agi) {
  const errors = [], warnings = []
  const a = cloneAgi(agi)
  const gm = {}
  const art = {}
  const aps = []
  for (const p of a.attachPoints) {
    const n = p.node ?? p.name
    if (typeof n !== 'string' || !n) { errors.push(`挂点 ${q(p.name)} 没有节点名，已跳过`); continue }
    pushUnique(aps, n)
  }
  if (aps.length) art.attachPoints = aps
  const arts = []
  const seen = new Set()
  for (const d of a.articulations) {
    if (!agiNameOk(d.name) || seen.has(d.name)) { errors.push(`关节名 ${q(d.name)} 不合规或重复，已跳过`); continue }
    const modelNodes = d.nodes.filter((s) => typeof s === 'string' && s)
    if (!modelNodes.length) { errors.push(`关节「${d.name}」没有节点（gmdf 要求 modelNodes 非空），已跳过`); continue }
    const stages = d.stages.filter((s) => isObj(s) && agiNameOk(s.name) && STAGE_TYPES.includes(s.type) && ['minimumValue', 'maximumValue', 'initialValue'].every((k) => isNum(s[k]))).map(cleanStage)
    if (stages.length !== d.stages.length) errors.push(`关节「${d.name}」有 ${d.stages.length - stages.length} 个 stage 不合规，已跳过这些 stage`)
    if (!stages.length) { errors.push(`关节「${d.name}」没有有效 stage，已跳过`); continue }
    seen.add(d.name)
    const o = { name: d.name, modelNodes: [...new Set(modelNodes)], stages }
    if (Array.isArray(d.pointingVector) && d.pointingVector.length === 3 && d.pointingVector.every(isNum)) o.pointingVector = d.pointingVector.slice()
    arts.push(o)
  }
  if (arts.length) art.articulations = arts
  if (Object.keys(art).length) gm[AGI_ARTICULATIONS] = art

  const meta = {}
  const groups = []
  const seenG = new Set()
  for (const g of a.solarPanelGroups) {
    if (!agiNameOk(g.name) || seenG.has(g.name)) { errors.push(`太阳翼组名 ${q(g.name)} 不合规或重复，已跳过`); continue }
    if (!isNum(g.efficiency) || g.efficiency < 0 || g.efficiency > 100) { errors.push(`太阳翼组「${g.name}」：efficiency 须在 0–100，已跳过`); continue }
    const modelNodes = g.nodes.filter((s) => typeof s === 'string' && s)
    if (!modelNodes.length) { errors.push(`太阳翼组「${g.name}」没有节点（gmdf 要求 modelNodes 非空），已跳过`); continue }
    seenG.add(g.name)
    groups.push({ name: g.name, efficiency: g.efficiency, modelNodes: [...new Set(modelNodes)] })
  }
  if (groups.length) meta.solarPanelGroups = groups
  const noObs = [...new Set(a.noObscurationNodes.filter((s) => typeof s === 'string' && s))]
  if (noObs.length) meta.noObscurationNodes = noObs
  if (Object.keys(meta).length) gm[AGI_STK_METADATA] = meta
  return { gmdf: Object.keys(gm).length ? gm : null, errors, warnings }
}

// ─────────────────────────────── 挂点节点的轴向口径 ───────────────────────────────
//
// ★ 挂点节点的局部轴怎么对应挂点系（z = 视轴、y = 上向、x = y × z；二期契约 D1 / D2）——2026-09-23 按本机 STK 12 核定：
//     视轴 = 节点局部 +Y，上向 = 节点局部 +X，挂点系 x = 节点局部 +Z。
// 为什么不是 glTF 字面上的「+Z 前、+Y 上」：
//   · STK 读 glTF 时把模型从 glTF 轴（+Y 上）整体换成自己的轴（+Z 上 / 天底），换轴是一个轴置换
//     P：stk.x = gltf.z、stk.y = gltf.x、stk.z = gltf.y（bodyFrame.mjs R_GLTF_TO_BODY_STK 同一个 P）。
//     节点局部系跟着一起换，所以节点在 STK 里的 (+X, +Y, +Z) 就是它在 glTF 里的 (+Z, +X, +Y)；STK 传感器的视轴是它自己的 +Z，
//     即节点局部 +Y。STK 帮助 vo/glTFmodel.htm 的 pointingVector 例子也按「+Y 朝外」写（太阳翼朝上 → [0,1,0]）。
//   · 数据：tdrs.glb 的五个天线挂点（MA / SA_E / SA_W / SGL / Omni）局部 +Y 全等于 glTF +Y，正是天线口面朝向；
//     局部 +Z 却是 ±glTF X，而且 SA_E 与 SA_W 相反——若取 +Z 当视轴，两副对称装的 SA 天线会指向相反的横向。
//   · 上向取 +X 而不是 +Z：同一个置换下挂点系 y 轴 = STK 挂点 +Y = 节点局部 +X（x = y × z = X × Y = Z，右手），
//     这是从换轴推出来的，还没在 STK 里挂传感器实测过；二期「从挂点套用」上线前应在 STK 里对一次（视轴方向已有 tdrs 数据佐证）。
// AGI 规范本身只把挂点定义为「位置」（传感器 / 尾迹的原点），朝向语义是上面这套换轴推出来的；
// pointingVector 属于另一个概念（可指向部件，关节上的属性），这里不拿它当挂点视轴。
// 写出（导出件、参数化模型造挂点节点）必须用 attachNodeMatrix，读回（attachPointPoses）才是同一套数。

const unitv = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null }
const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const crossv = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const rejectv = (a, d) => { const k = dotv(a, d); return [a[0] - k * d[0], a[1] - k * d[1], a[2] - k * d[2]] }
const clean0 = (v) => v.map((x) => (x === 0 ? 0 : x))

/**
 * 挂点节点的局部矩阵（列主序 16 元，glTF node.matrix / THREE.Matrix4.fromArray 口径），attachPointPoses 的逆：
 *   列 0（局部 +X）= up 去掉沿视轴分量后归一，列 1（局部 +Y）= 视轴，列 2（局部 +Z）= up × dir，列 3 = pos。
 * pos / dir / up 三者须在同一个坐标系里（节点父系：导出坐标、参数化模型根节点下的本体系……都行，函数不关心是哪个）。
 * up 缺省或与视轴平行时按 D1 规则（defaultUpBody）补——在本体系里调用时这就是 D1；在别的坐标系里只是个确定的兜底。
 * dir 非法 / 零长或 pos 非法返回 null。
 */
export function attachNodeMatrix(pos, dir, up) {
  if (!(Array.isArray(pos) && pos.length === 3 && pos.every(isNum))) return null
  if (!(Array.isArray(dir) && dir.length === 3 && dir.every(isNum))) return null
  const y = unitv(dir)
  if (!y) return null
  let x = Array.isArray(up) && up.length === 3 && up.every(isNum) && !isUpDegenerate(y, up) ? unitv(rejectv(up, y)) : null
  if (!x) x = defaultUpBody(y)
  const z = crossv(x, y)
  return clean0([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, pos[0], pos[1], pos[2], 1])
}

/**
 * 给挂点补几何位姿（本体系，米）：位置 = 节点原点，视轴 dirBody = 节点局部 +Y，上向 upBody = 节点局部 +X
 * （去掉沿视轴的分量后归一；节点带非均匀缩放 / 剪切时两轴可能不正交）。口径见上方「挂点节点的轴向口径」。
 * frame：{ q_model2body?, t_model2body?, scaleToMeters? }（缺省出厂映射 DEFAULT_Q_MODEL2BODY、零平移、1:1）。
 * 局部 +X 与视轴平行（退化）时 upBody 按 D1 规则补。找不到节点的挂点原样返回（不带位姿）。不抛。
 * @returns {Array<{name, node, nodeIndex?, posBody?, dirBody?, upBody?}>}
 */
export function attachPointPoses(json, attachPoints, frame = {}) {
  const list = Array.isArray(attachPoints) ? attachPoints : []
  const f = isObj(frame) ? frame : {}
  const qq = quatNormalize(f.q_model2body) || DEFAULT_Q_MODEL2BODY
  const t = Array.isArray(f.t_model2body) && f.t_model2body.length === 3 && f.t_model2body.every(isNum) ? f.t_model2body : [0, 0, 0]
  const s = isNum(f.scaleToMeters) && f.scaleToMeters > 0 ? f.scaleToMeters : 1
  const W = isObj(json) ? gltfWorldMatrices(json) : []
  const nodes = isObj(json) && Array.isArray(json.nodes) ? json.nodes : []
  const idxByName = new Map()
  nodes.forEach((n, i) => { if (isObj(n) && typeof n.name === 'string' && n.name && !idxByName.has(n.name)) idxByName.set(n.name, i) })
  // 世界矩阵第 c 列（局部轴在模型系里的像）→ 本体系单位向量；缩放为 0 的轴给 null
  const axis = (m, c) => {
    const v = unitv([m[c * 4], m[c * 4 + 1], m[c * 4 + 2]])
    return v ? quatRotate(qq, v) : null
  }
  return list.filter(isObj).map((p) => {
    const out = { ...p }
    const key = p.node ?? p.name
    const i = Number.isInteger(p.nodeIndex) && nodes[p.nodeIndex] ? p.nodeIndex
      : (idxByName.has(key) ? idxByName.get(key) : (unnamedByFallback(nodes, key) || [])[0])
    const m = i !== undefined ? W[i] : null
    if (!m) return out
    out.posBody = modelToBody([m[12] * s, m[13] * s, m[14] * s], qq, t)
    const d = axis(m, 1)
    if (!d) return out
    out.dirBody = clean0(d)
    const x = axis(m, 0)
    const u = x && !isUpDegenerate(d, x) ? unitv(rejectv(x, d)) : null
    out.upBody = clean0(u || defaultUpBody(d))
    return out
  })
}
