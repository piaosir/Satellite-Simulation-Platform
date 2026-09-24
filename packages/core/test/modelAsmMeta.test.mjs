// 装配件入库元数据自测（packages/core/models/asmMeta.mjs；三期 P3 契约 §2.3 / §9.1）。运行：node packages/core/test/modelAsmMeta.test.mjs
//
// 为什么测：装配件的 ModelMeta 在工作台装配页入库、库里实体模板预览、主进程 saveImported 三处读写，字段口径错一处，
// 就会出现「库里是卫星、3D 页按飞机摆」「bboxM 一处本体系一处模型轴」「param: 带着装配文档被 buildParamModel 静默生成成一个点」。
// 钉死：
//   ① 五个领域各一份最小文档（卫星：平台体 + 镜像太阳翼；其余：本领域根件已登记就用它、否则 prim.box；另挂一件镜像自由件）
//      → buildAssembly → assemblyModelMeta：validateMeta 通过（入库前 files 空按 lods:'none'；主进程填 lod0 后照常过；节点名引用齐全）、
//      normalizeMeta 幂等、kind / group 按领域、frame.q = DOMAIN_FRAMES[领域].q 且 importQ 同值、bboxM 经 frame 回到本体系 = bboxBody、
//      来源 user 可分发、质量特性丢明细、挂点 / 关节 / 太阳翼组原样；
//   ② 名字缺省（base.name > 文档名 > 领域缺省名）、ent 预览（builtin 来源）、坏输入抛 TypeError、不改入参；
//   ③ 对账：assembly.ASM_ID_RE ≡ schema 的 asm 规则、ASM_DOMAIN_KINDS 键 ≡ ASM_DOMAINS、param: 配装配文档 → 报错；
//   ④ A3 的 entityTemplates.mjs 在时：模板 id 都过 schema 的 ent 规则，模板文档经 assemblyModelMeta（ent 预览口径）全部过校验。
// 不联网。

import assert from 'node:assert/strict'
import * as A from '../models/assembly.mjs'
import * as S from '../models/schema.mjs'
import * as BF from '../models/bodyFrame.mjs'
import { getComponent, fillParams } from '../models/components/index.mjs'
import { assemblyModelMeta, defaultAsmName, ASM_DEFAULT_NAMES } from '../models/asmMeta.mjs'

let pass = 0
const ok = (c, msg) => { assert.ok(c, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const nearV = (a, b, tol, msg) => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= tol, `${msg}[${i}]：${x} vs ${b[i]}`)); pass++ }
const SHA = (c) => c.repeat(64)
const json = (x) => JSON.parse(JSON.stringify(x))

// —— 各领域的最小文档
// 本领域根件（A3 登记后才有）：能生成就用它，否则退回 prim.box（A3 施工期间某件暂时生成不了也不让本测试跟着红）
const DOMAIN_ROOT = { ground: 'es.pedestal.azel', aircraft: 'air.fuselage', ship: 'sea.hull', vehicle: 'veh.body' }
const rootTypeFor = (domain) => {
  const ty = DOMAIN_ROOT[domain]
  if (!ty || !getComponent(ty)) return 'prim.box'
  try { A.buildComponent(ty); return ty } catch { return 'prim.box' }
}
function docFor(domain, idHex) {
  if (domain === 'spacecraft') {
    return {
      kind: 'assembly', schema: 1, domain, name: '测试卫星',
      comps: [
        { id: 'bus', type: 'sat.bus.box', parent: null, params: { mli: 'none', radiators: false, adapter: false } },
        { id: 'wing', type: 'sat.wing', parent: 'bus', attach: { mode: 'surface', face: '+Y', uv: [0, 0], roll: 0 }, params: { panels: 2 }, sym: { op: 'mirrorXZ' } }
      ]
    }
  }
  const rt = rootTypeFor(domain)
  return {
    kind: 'assembly', schema: 1, domain, name: `测试${idHex}`,
    comps: [
      { id: 'base', type: rt, parent: null, params: {} },
      // 自由件 + 镜像：任何根件都挂得上（不依赖 A3 件的插座 / 面名）
      { id: 'pod', type: 'prim.cyl', parent: 'base', attach: { mode: 'free' }, t: [0.4, 1.2, -0.3], q: [0, 0, 0, 1], sym: { op: 'mirrorXZ' } }
    ]
  }
}
const idOf = (i) => `asm:${String(i).padStart(12, 'a').slice(-12).replace(/[^0-9a-f]/g, 'a')}`

// ① 五个领域
const built = {}
for (const [i, domain] of A.ASM_DOMAINS.entries()) {
  const id = idOf(i + 1)
  const doc = docFor(domain, i)
  const r = A.buildAssembly(doc)
  built[domain] = r
  const specBefore = JSON.stringify(r.spec), partsBefore = JSON.stringify(r.parts)
  const m = assemblyModelMeta(r, { id })
  ok(JSON.stringify(r.spec) === specBefore && JSON.stringify(r.parts) === partsBefore, `${domain}：不改入参`)
  eq(json(m), m, `${domain}：纯数据`)
  const nodeNames = r.ir.nodes.map((n) => n.name)
  const v0 = S.validateMeta(m, { lods: 'none', nodeNames })
  ok(v0.ok && v0.warnings.length === 0, `${domain}：入库前（files 空）validateMeta 通过、无告警：${v0.errors.join('；')}${v0.warnings.join('；')}`)
  const filled = S.normalizeMeta({ ...m, files: { lod0: { sha256: SHA('a'), bytes: 1000, tris: m.geometry.tris } } })
  ok(S.validateMeta(filled).ok, `${domain}：主进程填 lod0 后照常通过`)
  eq(S.normalizeMeta(m), m, `${domain}：normalizeMeta 幂等`)
  eq(S.parseModelId(m.id), { prefix: 'asm', body: id.slice(4) }, `${domain}：id 是 asm:`)
  eq([m.kind, m.group, m.fidelity], [S.ASM_DOMAIN_KINDS[domain], S.ASM_DOMAIN_KINDS[domain], 'parametric'], `${domain}：kind / group 按领域、parametric`)
  eq(m.source, { kind: 'user', url: '', credit: '', license: '', redistributable: true }, `${domain}：来源 user、可分发`)
  ok(S.isRedistributable(m), `${domain}：isRedistributable`)
  const q = A.DOMAIN_FRAMES[domain].q
  eq(m.frame, { q_model2body: [...q], t_model2body: [0, 0, 0], verified: true, importQ: [...q] }, `${domain}：frame.q = 领域 q、importQ 同值、核过`)
  ok(m.frame.importQ !== m.frame.q_model2body, `${domain}：importQ 与 q_model2body 不共用数组`)
  eq(m.frame.q_model2body, domain === 'spacecraft' ? [...BF.DEFAULT_Q_MODEL2BODY] : [...BF.Q_YUP_ZENITH], `${domain}：卫星 = STK 映射，其余 = +Y 天顶`)
  if (domain !== 'spacecraft') eq(m.frame.importQ, S.importDefaultQOf({ id: m.id, kind: m.kind, attachPoints: m.attachPoints, articulations: m.articulations }), `${domain}：实体领域的 importQ = 类别缺省（带 AGI 也一样）`)
  // bboxM：模型轴米，经 frame 回到本体系 = bboxBody
  const R = BF.quatToMat(m.frame.q_model2body)
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? m.geometry.bboxM.max[0] : m.geometry.bboxM.min[0], c & 2 ? m.geometry.bboxM.max[1] : m.geometry.bboxM.min[1], c & 4 ? m.geometry.bboxM.max[2] : m.geometry.bboxM.min[2]]
    for (let k = 0; k < 3; k++) { const vb = R[k][0] * p[0] + R[k][1] * p[1] + R[k][2] * p[2]; if (vb < mn[k]) mn[k] = vb; if (vb > mx[k]) mx[k] = vb }
  }
  nearV(mn, r.bboxBody.min, 1e-12, `${domain}：bboxM 经 frame 回到本体系 min`)
  nearV(mx, r.bboxBody.max, 1e-12, `${domain}：bboxM 经 frame 回到本体系 max`)
  ok(m.geometry.bboxM.min.every((v, k) => v <= m.geometry.bboxM.max[k]), `${domain}：bboxM min ≤ max`)
  eq([m.geometry.boundingRadiusM, m.geometry.tris], [r.boundingRadiusM, r.ir.meshes.reduce((s, x) => s + x.index.length / 3, 0)], `${domain}：包围半径 / 三角形数`)
  eq([m.geometry.areaM2, m.geometry.volumeM3, m.geometry.closed, m.geometry.centroidM], [0, null, false, [0, 0, 0]], `${domain}：面积 / 体积 / 闭合 / 质心按参数化口径`)
  eq(m.units, { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false }, `${domain}：米制`)
  // 质量特性：丢逐件明细
  eq(m.massProps, { massKg: r.massProps.massKg, comBody: r.massProps.comBody, inertiaBody: r.massProps.inertiaBody, source: 'components', confidence: 'low' }, `${domain}：质量特性丢 components 明细`)
  ok(m.massProps.massKg > 0, `${domain}：质量 > 0`)
  // 名字由组件 id 派生的几样原样
  eq(m.attachPoints.map((a) => [a.name, a.posBody, a.dirBody]), r.attachPoints.map((a) => [a.name, a.posBody, a.dirBody]), `${domain}：挂点原样`)
  eq(m.articulations.map((a) => [a.name, a.nodes]), r.articulations.map((a) => [a.name, a.nodes]), `${domain}：关节原样`)
  eq(m.solarPanelGroups, r.solarPanelGroups.map((g) => ({ name: g.name, nodes: g.nodes, efficiency: g.efficiency })), `${domain}：太阳翼组原样`)
  eq(m.parts.map((p) => p.id), r.parts.map((p) => p.id), `${domain}：部件原样`)
  eq(m.spec, json(r.spec), `${domain}：spec = 归一后的装配文档`)
  ok(S.isAssemblySpec(m.spec) && m.spec.domain === domain, `${domain}：spec 是装配文档`)
  eq([m.title, m.titleZh, m.tags, m.aliases, m.files, m.updatedAt], [doc.name, doc.name, ['assembly', domain], [doc.name], {}, null], `${domain}：标题 / 标签 / 别名 / 文件 / 时间`)
  ok(!S.validateMeta({ ...filled, id: 'param:0123456789ab', source: { kind: 'param', url: '', credit: '', license: '', redistributable: true } }).ok, `${domain}：同一份 meta 换成 param: id → 报错`)
}
{
  // 卫星：镜像太阳翼两翼关于 XZ 面对称，两翼电池片法向相同（镜像不翻电池面）；太阳翼组与关节带前缀
  const r = built.spacecraft
  const m = assemblyModelMeta(r, { id: 'asm:0123456789ab' })
  ok(Math.abs(r.specOriginBody[1]) < 1e-9, `卫星：镜像两翼 → 文档系 y 区间关于 0 对称（几何中心 y = ${r.specOriginBody[1]}）`)
  eq([m.geometry.bboxM.min, m.geometry.bboxM.max].map((v) => v.map((x) => Math.abs(x))).reduce((a, b) => a.map((x, k) => Math.abs(x - b[k]) < 1e-12)), [true, true, true], '卫星：模型轴 bboxM 关于原点对称（原点 = 几何中心）')
  ok(m.solarPanelGroups.length === 2 && m.solarPanelGroups.every((g) => /^wing(-1)?_/.test(g.name)), `卫星：两翼太阳翼组（wing_ / wing-1_ 前缀）：${m.solarPanelGroups.map((g) => g.name)}`)
  ok(m.articulations.some((a) => a.name.startsWith('wing_')) && m.articulations.some((a) => a.name.startsWith('wing-1_')), '卫星：两翼关节都在')
  const cells = m.parts.filter((p) => p.role === 'solarArray' && p.normalBody)
  ok(cells.length === 2 && cells.every((p) => p.normalBody.every((v, k) => Math.abs(v - cells[0].normalBody[k]) < 1e-12)), `卫星：两翼电池片法向相同（镜像不翻电池面）：${JSON.stringify(cells.map((p) => p.normalBody))}`)
}

// ② 名字 / 来源 / 时间 / 坏输入
{
  const r = built.aircraft
  eq(assemblyModelMeta(r, { id: 'asm:0123456789ab', name: '  我的飞机  ' }).title, '我的飞机', 'base.name 优先（去首尾空白）')
  const r2 = A.buildAssembly({ ...docFor('aircraft', 9), name: '' })
  eq(assemblyModelMeta(r2, { id: 'asm:0123456789ab' }).title, '飞机装配件', '文档名空 → 领域缺省名')
  eq(assemblyModelMeta(r2, { id: 'asm:0123456789ab', name: '   ' }).titleZh, '飞机装配件', '空白名同空')
  eq(A.ASM_DOMAINS.map(defaultAsmName), ['卫星装配件', '地球站装配件', '飞机装配件', '船舶装配件', '车辆装配件'], 'defaultAsmName 五个领域')
  eq([defaultAsmName('mars'), defaultAsmName(undefined), defaultAsmName('constructor')], ['装配件', '装配件', '装配件'], 'defaultAsmName 认不出 → 装配件（原型链键不认）')
  eq(Object.keys(ASM_DEFAULT_NAMES).sort(), [...A.ASM_DOMAINS].sort(), 'ASM_DEFAULT_NAMES 覆盖全部领域')
  eq(assemblyModelMeta(r, { id: 'asm:0123456789ab', updatedAt: '2026-09-24T01:02:03.000Z' }).updatedAt, '2026-09-24T01:02:03.000Z', 'updatedAt 透传')
  eq(assemblyModelMeta(r, { id: 'asm:0123456789ab', tags: ['x', 'assembly', ''] }).tags, ['assembly', 'aircraft', 'x'], '额外标签去重追加')
  // ent 预览：builtin 来源、ent: id，照常过校验
  const src = { kind: 'builtin', url: 'https://example.org/a', credit: 'X', license: 'param', redistributable: true }
  const me = assemblyModelMeta(r, { id: 'ent:a320neo', name: 'A320neo', source: src })
  eq([me.source, me.kind], [src, 'aircraft'], 'ent 预览：builtin 来源原样、kind 按领域')
  ok(S.validateMeta(me, { lods: 'none' }).ok, `ent 预览过校验：${S.validateMeta(me, { lods: 'none' }).errors.join('；')}`)
  // domain 覆盖（base.domain 认得就用）
  eq(assemblyModelMeta(r, { id: 'asm:0123456789ab', domain: 'ship' }).kind, 'ship', 'base.domain 覆盖')
  eq(assemblyModelMeta(r, { id: 'asm:0123456789ab', domain: 'mars' }).kind, 'aircraft', 'base.domain 认不出 → 取文档领域')
  for (const bad of [null, undefined, 3, {}, { spec: { kind: 'x' } }, { spec: null }]) assert.throws(() => assemblyModelMeta(bad, { id: 'asm:0123456789ab' }), TypeError, `坏 r 抛 TypeError：${JSON.stringify(bad)}`)
  pass++
  // 两次生成逐字节相同（时间戳不进来）
  eq(JSON.stringify(assemblyModelMeta(r, { id: 'asm:0123456789ab' })), JSON.stringify(assemblyModelMeta(r, { id: 'asm:0123456789ab' })), '确定性')
}

// ③ 对账
{
  let seed = 20260924
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = 0; i < 200; i++) {
    const id = A.newAsmId(rnd)
    assert.ok(A.ASM_ID_RE.test(id) && A.isAsmId(id) && S.parseModelId(id)?.prefix === 'asm', `newAsmId → schema 认得：${id}`)
  }
  for (let i = 0; i < 20; i++) { const id = A.newAsmId(); assert.ok(S.parseModelId(id)?.prefix === 'asm', `crypto newAsmId：${id}`) }
  pass++
  for (const s of ['asm:0123456789ab', 'asm:0123456789AB', 'asm:0123456789a', 'asm:0123456789abc', 'asm:', 'asm:g123456789ab', ' asm:0123456789ab', 'asm:0123456789ab\n']) {
    assert.equal(A.ASM_ID_RE.test(s), S.parseModelId(s)?.prefix === 'asm', `ASM_ID_RE ≡ schema asm 规则：${JSON.stringify(s)}`)
  }
  pass++
  eq(Object.keys(S.ASM_DOMAIN_KINDS).sort(), [...A.ASM_DOMAINS].sort(), 'schema.ASM_DOMAIN_KINDS 的键 ≡ assembly.ASM_DOMAINS')
  eq(S.ASM_DOMAIN_KINDS.ground, 'ground', '地球站 kind 沿用 ground（SPEC §12-2）')
  for (const d of A.ASM_DOMAINS) if (d !== 'spacecraft') ok(BF.ENTITY_KINDS.includes(S.ASM_DOMAIN_KINDS[d]), `${d}：实体领域的 kind 在 bodyFrame.ENTITY_KINDS 里（导入缺省 +Y 天顶 = 领域 q）`)
  // 主进程 models.js 手写的 ASM_ID_RE 与这里同式
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../../electron/services/models.js', import.meta.url), 'utf8')
  ok(src.includes('const ASM_ID_RE = /^asm:[0-9a-f]{12}$/') && String(A.ASM_ID_RE) === '/^asm:[0-9a-f]{12}$/', '主进程 ASM_ID_RE 与 assembly.ASM_ID_RE 同式')
  // 编辑器入参的 buildComponent 带局部关节（P3 契约 §2.4）
  const bc = A.buildComponent('sat.wing')
  ok(Array.isArray(bc.articulations) && bc.articulations.length === 1 && bc.articulations[0].nodes.every((n) => bc.ir.nodes.some((x) => x.name === n)), 'buildComponent().articulations：局部短名、节点都在 IR 里')
  const bc2 = A.buildComponent('sat.wing')
  bc2.articulations[0].stages[0].initialValue = 99
  ok(A.buildComponent('sat.wing').articulations[0].stages[0].initialValue !== 99, 'buildComponent().articulations 每次新拷贝')
  eq(A.buildComponent('prim.box').articulations, [], '没有关节的件 → []')
  ok(fillParams(getComponent('sat.wing'), {}).panels > 0, '注册表可用')
}

// ④ A3 的实体模板（在就测；A3 未落地 → 跳过）
{
  let E = null
  try { E = await import('../models/entityTemplates.mjs') } catch (e) { if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(e && (e.code || e.message)))) throw e }
  if (!E || !Array.isArray(E.ENTITY_TEMPLATE_IDS)) console.log('NOTE：entityTemplates.mjs 未落地，跳过 ④')
  else {
    for (const id of E.ENTITY_TEMPLATE_IDS) assert.equal(S.parseModelId(id)?.prefix, 'ent', `模板 id 过 schema 的 ent 规则：${id}`)
    pass++
    const cat = typeof E.entityTemplateCatalog === 'function' ? E.entityTemplateCatalog() : []
    for (const c of cat) {
      assert.ok(S.MODEL_KINDS.includes(c.kind), `${c.id}：kind ${c.kind} 合法`)
      const d = E.entityTemplateDoc(c.id)
      assert.ok(d && S.isAssemblySpec(d.doc), `${c.id}：entityTemplateDoc 给装配文档`)
      const r = A.buildAssembly(d.doc)
      const m = assemblyModelMeta(r, { id: c.id, name: c.titleZh, source: c.source })
      const v = S.validateMeta(m, { lods: 'none', nodeNames: r.ir.nodes.map((n) => n.name) })
      assert.ok(v.ok, `${c.id}：ent 预览 meta 过校验：${v.errors.join('；')}`)
      assert.equal(m.kind, c.kind, `${c.id}：kind 与目录一致`)
      assert.deepEqual(m.frame.importQ, [...A.DOMAIN_FRAMES[d.doc.domain].q], `${c.id}：importQ = 领域 q`)
    }
    pass++
    console.log(`实体模板 ${cat.length} 个已对拍`)
  }
}

console.log(`modelAsmMeta: ${pass} 项通过`)
