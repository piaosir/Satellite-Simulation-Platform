// 装配文档核心（packages/core/models/assembly.mjs）+ 组件注册表 / 卫星组件（components/index.mjs、components/sat.mjs）单测
// （三期契约 DESIGN3 §1 P1；装配调研 assembly-ux §7 P1 六条 + §6 第 5 条镜像数学）。
//
// ① assembly-ux §7 P1：同一文档两次生成逐字段相等；质量合成对解析 < 1e-9；镜像翼翼尖在 −Y、电池面朝 −Z；
//    平台体 yM 加 0.4 m 翼根跟着 ±0.2 m；validateIR 通过、nonFiniteReport 为空；buildAssembly 返回键集合与 buildParamModel 相同。
// ② 镜像数学：翼走 mirror 钩子（转角取反）；偏置反射面缺省走对称面（关于母轴 + 偏置方向面对称，几何原样复用）；
//    烘焙路径（登记一个不声明对称面的反射面变体）：世界顶点乘 S、法向乘 S、绕序翻转、节点矩阵真旋转。
// ③ specToAssembly：default-sat 转出的装配件质量与原参数化模型相对误差 < 1e-6（另对拍全部模板、带 / 不带目标质量、质心 / 惯量 / 挂点）。
// ④ 其余：注册表 15 件逐件生成、id / 哈希 / 归一幂等、校验报错、径向对称、插座安装（馈源插焦点）、柱面贴装、
//    solvePose / combineMass 的 out 复用、质量覆盖 / 目标质量、子树随对称复制、buildComponent。
// 不联网。

import assert from 'node:assert/strict'
import * as A from '../models/assembly.mjs'
import { execFileSync } from 'node:child_process'
import { getComponent, listComponents, componentTypes, registerComponent, fillParams, checkParams, socketAccepts } from '../models/components/index.mjs'
import { FACE_FRAMES, reflectorFrame } from '../models/components/sat.mjs'
import { buildParamModel, nonFiniteReport, DENSITY } from '../models/paramBus.mjs'
import { templateSpec, TEMPLATE_IDS, DEFAULT_TEMPLATE_ID } from '../models/paramTemplates.mjs'
import { validateIR } from '../models/ir.mjs'
import { ROOT_MATRIX_BODY2MODEL, DEFAULT_Q_MODEL2BODY } from '../models/bodyFrame.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（容差 ${tol}）`)
const nearV = (a, b, tol, msg) => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => near(x, b[i], tol, `${msg}[${i}]`)) }
const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300)
const NAME_RE = /^[A-Za-z0-9_+-]+$/

// —— IR 小工具：节点在本体系的 4×4（根节点之下的链乘；根矩阵是本体 → 模型轴，不乘）
function mulM(a, b) {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[4 * c + r] += a[4 * k + r] * b[4 * c + k]
  return o
}
function bodyMatrix(ir, i) {
  let m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  for (let k = i; k > 0; k = ir.nodes[k].parent) m = mulM(ir.nodes[k].matrix, m)
  return m
}
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
const nodeIdx = (ir, name) => { const i = ir.nodes.findIndex((x) => x.name === name); assert.ok(i >= 0, `找不到节点 ${name}`); return i }
/** 网格节点的世界（本体系）顶点 / 法向（加 specOriginBody 还原成文档坐标）。 */
function worldMesh(res, name) {
  const ir = res.ir, i = nodeIdx(ir, name), M = bodyMatrix(ir, i), mesh = ir.meshes[ir.nodes[i].mesh], o = res.specOriginBody
  const P = [], N = []
  for (let v = 0; v < mesh.position.length; v += 3) {
    const x = mesh.position[v], y = mesh.position[v + 1], z = mesh.position[v + 2]
    P.push([M[0] * x + M[4] * y + M[8] * z + M[12] + o[0], M[1] * x + M[5] * y + M[9] * z + M[13] + o[1], M[2] * x + M[6] * y + M[10] * z + M[14] + o[2]])
    const a = mesh.normal[v], b = mesh.normal[v + 1], c = mesh.normal[v + 2]
    N.push([M[0] * a + M[4] * b + M[8] * c, M[1] * a + M[5] * b + M[9] * c, M[2] * a + M[6] * b + M[10] * c])
  }
  return { P, N, index: mesh.index, M }
}
const specPos = (res, p) => p.map((x, i) => x + res.specOriginBody[i])
const apOf = (res, name) => { const a = res.attachPoints.find((x) => x.name === name); assert.ok(a, `找不到挂点 ${name}`); return a }
/** 顶点集合（量化到 1e-4 m）。 */
const vset = (P, S = [1, 1, 1]) => new Set(P.map((p) => p.map((x, k) => Math.round(x * S[k] * 1e4) || 0).join(',')))
const sameSet = (a, b, msg) => { assert.equal(a.size, b.size, `${msg}：点数`); for (const k of a) assert.ok(b.has(k), `${msg}：${k} 无对应`) }

const BUS = (over = {}, params = {}) => ({ id: 'bus', type: 'sat.bus.box', parent: null, params: { mli: 'none', radiators: false, adapter: false, ...params }, ...over })
const docOf = (comps, extra = {}) => ({ kind: 'assembly', schema: 1, domain: 'spacecraft', name: 't', comps, ...extra })
const wingDoc = (yM = 2.1, wingParams = {}, sym = { op: 'mirrorXZ' }) => docOf([
  BUS({}, { yM }),
  { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'surface', face: '+Y', uv: [0, 0], roll: 0 }, params: { panels: 2, ...wingParams }, sym }
])

// ───────────────────────── 注册表与组件 ─────────────────────────

t('注册表：13 个卫星组件 + 2 个基本体，逐件以缺省参数作根件可生成，IR 合法、名字合规、参数带出处', () => {
  const sat = ['sat.bus.box', 'sat.bus.cyl', 'sat.bus.hex', 'sat.wing', 'sat.reflector', 'sat.feed.horn', 'sat.array.phased', 'sat.tower', 'sat.boom', 'sat.thruster', 'sat.radiator', 'sat.sensor.star', 'sat.sensor.sun']
  for (const ty of [...sat, 'prim.box', 'prim.cyl']) assert.ok(componentTypes().includes(ty), `缺 ${ty}`)
  assert.equal(listComponents('spacecraft').length, 15)
  // 非卫星领域的组件（ground / air / sea / veh）不漏进卫星库；它们的同类检查在 modelAsmDomains.test（A3 规格 §12-1）
  assert.ok(listComponents('spacecraft').every((d) => d.type.startsWith('sat.') || d.type.startsWith('prim.')), '卫星领域只见 sat.* 与基本体')
  for (const def of listComponents('spacecraft')) {
    for (const k of def.keys) { const s = def.params[k]; assert.ok(s.source && s.label, `${def.type}.${k} 缺出处 / 标签`) }
    assert.deepStrictEqual(checkParams(def, fillParams(def, {})), [], `${def.type} 缺省参数合法`)
    const doc = docOf([{ id: 'c1', type: def.type, parent: null, massKg: 7 }])
    const r = A.buildAssembly(doc)
    assert.ok(validateIR(r.ir).ok, `${def.type} validateIR：${validateIR(r.ir).errors.join('；')}`)
    assert.deepStrictEqual(nonFiniteReport(r), [], `${def.type} 非有限数`)
    near(r.massProps.massKg, 7, 1e-9, `${def.type} 手填质量`)
    for (const nd of r.ir.nodes) assert.ok(NAME_RE.test(nd.name), `${def.type} 节点名 ${nd.name}`)
    for (const s of def.sockets(fillParams(def, {}))) { assert.ok(Math.abs(Math.hypot(...s.n) - 1) < 1e-12, `${def.type} 插座 ${s.id} 法向单位长`) }
    for (const f of def.faces(fillParams(def, {}))) if (f.kind === 'plane') {
      const c = [f.u[1] * f.v[2] - f.u[2] * f.v[1], f.u[2] * f.v[0] - f.u[0] * f.v[2], f.u[0] * f.v[1] - f.u[1] * f.v[0]]
      nearV(c, f.n, 1e-12, `${def.type} 面 ${f.id}：u × v = n`)
    }
  }
  assert.throws(() => registerComponent({ ...getComponent('prim.box') }), /重复登记/)
  assert.deepStrictEqual(Object.keys(fillParams(getComponent('prim.box'), { xM: 2, bogus: 1 })), ['xM', 'yM', 'zM', 'hasMass'], '定义外的键丢掉')
  assert.equal(fillParams(getComponent('sat.reflector'), { focalM: null }).focalM, null, '可空参数保留 null')
  assert.equal(fillParams(getComponent('prim.box'), { xM: null }).xM, 0.5, '不可空参数给 null 回缺省')
})

t('插座描述（assembly-ux §3.2 字段名）：{id,pos,n,up,size,accepts,roll}；焦点插座只接馈源类；登记时查形状与 mountSocket', () => {
  for (const def of listComponents()) {
    const p = fillParams(def, {})
    for (const s of def.sockets(p)) {
      assert.deepStrictEqual(Object.keys(s).sort(), ['accepts', 'id', 'n', 'pos', 'roll', 'size', 'up'], `${def.type}.${s.id} 字段`)
      assert.ok(s.size > 0 && Number.isFinite(s.size), `${def.type}.${s.id} size`)
      assert.ok([15, 60, 90].includes(s.roll), `${def.type}.${s.id} roll 档`)
      assert.ok(s.accepts === null || (Array.isArray(s.accepts) && s.accepts.length), `${def.type}.${s.id} accepts`)
    }
    assert.ok(def.sockets(p).some((s) => s.id === def.mountSocket), `${def.type} mountSocket 在插座里`)
  }
  const focus = getComponent('sat.reflector').sockets(fillParams(getComponent('sat.reflector'), {})).find((s) => s.id === 'focus')
  assert.ok(socketAccepts(focus, 'sat.feed.horn') && socketAccepts(focus, 'sat.array.phased') && socketAccepts(focus, 'prim.box'))
  assert.ok(!socketAccepts(focus, 'sat.wing') && !socketAccepts(focus, undefined))
  assert.ok(socketAccepts(getComponent('sat.bus.box').sockets(fillParams(getComponent('sat.bus.box'), {}))[0], 'sat.wing'), 'accepts null 不限')
  const box = getComponent('prim.box')
  assert.throws(() => registerComponent({ ...box, type: 'test.badsock', sockets: () => [{ id: 'root', pos: [0, 0, 0], n: [0, 0, -1], up: [1, 0, 0], rollStep: 90, accepts: null }] }), /size 须为正数/)
  assert.throws(() => registerComponent({ ...box, type: 'test.badmount', mountSocket: 'nope' }), /mountSocket/)
  assert.equal(getComponent('test.badsock'), null, '登记失败不入表')
})

t('盒面约定：侧面滚转零位 +Z、±Z 面 +X，u × v = n', () => {
  for (const [id, f] of Object.entries(FACE_FRAMES)) {
    const n0 = f.n, u = f.u
    assert.equal(n0[0] * u[0] + n0[1] * u[1] + n0[2] * u[2], 0, `${id} u ⟂ n`)
    assert.deepStrictEqual(u, id.endsWith('Z') ? [1, 0, 0] : [0, 0, 1], id)
  }
})

// ───────────────────────── id / 归一 / 哈希 / 校验 ─────────────────────────

t('newAsmId：注入随机源确定、12 位十六进制；缺省随机源格式正确', () => {
  let k = 0
  const seq = () => ((k++ * 7) % 16) / 16
  assert.equal(A.newAsmId(seq), 'asm:07e5c3a18f6d')
  const r = () => 0.999999
  assert.equal(A.newAsmId(r), 'asm:ffffffffffff')
  for (let i = 0; i < 20; i++) assert.ok(A.isAsmId(A.newAsmId()))
  assert.ok(!A.isAsmId('asm:12345') && !A.isAsmId('param:0123456789ab') && !A.isAsmId('asm:0123456789AB'))
  assert.equal(A.nextCompId(docOf([{ id: 'c2' }, { id: 'bus' }, { id: 'c10' }])), 'c11')
  assert.equal(A.nextCompId({}), 'c1')
  assert.equal(A.nodePrefix('c3~1'), 'c3-1'); assert.equal(A.nodePrefix('c3'), 'c3')
})

t('normalizeAssembly 幂等；asmHash 不受键序 / −0 / 缺省值写没写影响，改参数哈希变', () => {
  const d = wingDoc()
  const n1 = A.normalizeAssembly(d), n2 = A.normalizeAssembly(n1)
  assert.deepStrictEqual(n2, n1)
  assert.equal(n1.comps[1].params.panelHM, 3, '缺省参数补上')
  assert.equal(n1.comps[0].attach.mode, 'free', '根件 attach 归一')
  assert.deepStrictEqual(n1.comps[1].sym, { group: 'w', op: 'mirrorXZ' })
  const h = A.asmHash(d)
  assert.match(h, /^[0-9a-f]{16}$/)
  assert.equal(A.asmHash(n1), h)
  const reordered = { comps: d.comps.map((c) => Object.fromEntries(Object.entries(c).reverse())), name: 't', domain: 'spacecraft', schema: 1, kind: 'assembly' }
  assert.equal(A.asmHash(reordered), h, '键序')
  const d2 = JSON.parse(JSON.stringify(d)); d2.comps[1].attach.uv = [-0, 0]
  assert.equal(A.asmHash(d2), h, '−0')
  const d3 = JSON.parse(JSON.stringify(d)); d3.comps[1].params.panelHM = 3; d3.comps[1].params.bogus = 1
  assert.equal(A.asmHash(d3), h, '缺省值写出 / 定义外的键')
  const d4 = JSON.parse(JSON.stringify(d)); d4.comps[1].params.panelHM = 3.4
  assert.notEqual(A.asmHash(d4), h, '改参数')
  // 自由件四元数归一到规范号（q 与 −q 同一旋转同一哈希）
  const f = (q) => docOf([BUS(), { id: 'p', type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, t: [1, 2, 3], q }])
  assert.equal(A.asmHash(f([0, 0, 0.7071067811865476, 0.7071067811865476])), A.asmHash(f([0, 0, -1.4142135623730951, -1.4142135623730951])))
})

t('validateAssembly：结构 / 参数 / 安装 / 对称的非法情形逐条报出', () => {
  const V = (d) => A.validateAssembly(d)
  const errs = (d) => V(d).errors.join('\n')
  assert.ok(V(wingDoc()).ok)
  assert.deepStrictEqual(V(docOf([])).missing, ['comps'])
  assert.deepStrictEqual(V({}).missing, ['comps'])
  assert.match(errs({ ...wingDoc(), kind: 'param' }), /kind/)
  assert.match(errs({ ...wingDoc(), domain: 'moon' }), /domain/)
  assert.match(errs(docOf([BUS(), BUS()])), /重复/)
  assert.match(errs(docOf([BUS(), { ...BUS(), id: 'bus2' }])), /根件多于一个/)
  assert.match(errs(docOf([{ ...BUS(), id: 'Bus' }])), /comps\[0\]\.id/)
  assert.match(errs(docOf([{ ...BUS(), id: 'satellite' }])), /保留名/)
  assert.match(errs(docOf([{ ...BUS(), id: 'my_bus' }])), /comps\[0\]\.id/, 'id 不含下划线')
  assert.match(errs(docOf([BUS(), { id: 'x', type: 'sat.nope', parent: 'bus' }])), /未知组件/)
  assert.match(errs({ ...docOf([{ id: 'c1', type: 'sat.wing', parent: null }]), domain: 'ship' }), /不能用于 ship/)
  assert.match(errs(docOf([BUS({}, { xM: -1 })])), /bus\.params\.xM：须 > 0/)
  assert.match(errs(docOf([BUS({}, { bogus: 1 })])), /bus\.params\.bogus：未知参数/)
  assert.match(errs(docOf([BUS({}, { mli: 'gold' })])), /bus\.params\.mli/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'surface', face: '+Y' }, params: { sidePanels: 1 } }])), /sidePanels/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'nobody', attach: { mode: 'surface', face: '+Y' } }])), /找不到 nobody/)
  assert.match(errs(docOf([BUS(), { id: 'a', type: 'prim.box', parent: 'b', attach: { face: '+Z' } }, { id: 'b', type: 'prim.box', parent: 'a', attach: { face: '+Z' } }])), /成环/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'surface', face: '+W' } }])), /没有面 "\+W"/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'socket', socket: 'top' } }])), /没有插座 "top"/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'socket', socket: '+Y', mount: 'tip' } }])), /本件没有插座 "tip"/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'glue', face: '+Y' } }])), /attach\.mode/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'surface', face: '+Y', uv: [0] } }])), /uv/)
  assert.match(errs(docOf([BUS(), { id: 'p', type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, q: [0, 0, 0, 0] }])), /p\.q/)
  assert.match(errs(docOf([BUS({ sym: { op: 'mirrorXZ' } })])), /根件不能对称/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { face: '+Y' }, sym: { op: 'flip' } }])), /sym\.op/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { face: '+Y' }, sym: { op: 'radial', n: 9 } }])), /sym\.n/)
  assert.match(errs(docOf([BUS(), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { face: '+Y' }, sym: { op: 'mirrorXZ' } },
    { id: 's', type: 'sat.sensor.sun', parent: 'w', attach: { mode: 'free' }, sym: { op: 'mirrorYZ' } }])), /嵌套对称/)
  assert.match(errs(docOf([BUS({ massKg: -3, material: 'unobtainium' })])), /massKg[\s\S]*material/)
  assert.match(errs(docOf([BUS()], { density: { busVolume: -1, foo: 1 } })), /density\.busVolume[\s\S]*density\.foo/)
  assert.match(errs(docOf([BUS()], { massTargetKg: 0 })), /massTargetKg/)
  assert.throws(() => A.buildAssembly(docOf([BUS({}, { xM: -1 })])), (e) => e.code === 'SPEC_INVALID' && e.errors.length > 0)
  assert.throws(() => A.buildAssembly(docOf([])), (e) => e.code === 'SPEC_INVALID' && e.missing[0] === 'comps')
  assert.throws(() => A.buildAssembly(docOf([{ id: 'c1', type: 'prim.box', parent: null, params: { hasMass: false } }])), (e) => e.code === 'SPEC_INVALID' && /总质量为 0/.test(e.message))
  // 非有限数：归一（JSON）会把它们变成 null / 缺省，校验查原文
  const nf = errs(docOf([BUS({ massKg: NaN }, { xM: NaN, zM: Infinity }), { id: 'r', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+Z' }, params: { focalM: -Infinity } }], { massTargetKg: NaN }))
  for (const k of ['massTargetKg', 'bus.massKg', 'bus.params.xM：须为有限数', 'bus.params.zM：须为有限数', 'r.params.focalM：须为有限数']) assert.ok(nf.includes(k), `非有限数 ${k}：${nf}`)
  assert.throws(() => A.buildAssembly(docOf([BUS({}, { yM: NaN })])), (e) => e.code === 'SPEC_INVALID' && /yM/.test(e.message))
})

t('基本体缺省计质量（体积 × density.busVolume），纯基本体文档可生成（非卫星领域 P1 只有这两件）；hasMass 关 = 外观件', () => {
  const g = A.buildAssembly({ domain: 'ship', comps: [{ id: 'hull', type: 'prim.box', parent: null, params: { xM: 4, yM: 1, zM: 0.5 } }, { id: 'mast', type: 'prim.cyl', parent: 'hull', attach: { mode: 'socket', socket: '+Z' }, params: { dM: 0.2, hM: 2 } }] })
  const rho = DENSITY.busVolume.value
  near(g.massProps.massKg, rho * (4 * 1 * 0.5 + Math.PI * 0.01 * 2), 1e-9, '体积 × 密度')
  assert.deepStrictEqual(nonFiniteReport(g), [])
  const d2 = A.buildAssembly({ domain: 'ship', density: { busVolume: 100 }, comps: [{ id: 'hull', type: 'prim.box', parent: null, params: { xM: 4, yM: 1, zM: 0.5 } }] })
  near(d2.massProps.massKg, 200, 1e-9, '密度覆盖')
  const ghost = A.buildAssembly(docOf([BUS(), { id: 'g', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+Z' }, params: { hasMass: false } }]))
  assert.ok(!ghost.massProps.components.some((c) => c.name.startsWith('g_')), '外观件无质量元')
  near(A.buildAssembly(docOf([BUS(), { id: 'g', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+Z' }, params: { hasMass: false }, massKg: 3 }])).massProps.components.find((c) => c.name.startsWith('g_')).massKg, 3, 1e-12, '外观件手填质量按 unitMass 分布')
})

t('combineMass 恒为有限数：空文档 / 只有无质量件 → 质量 0、质心与惯量全 0', () => {
  for (const doc of [docOf([]), {}, null, docOf([{ id: 'c1', type: 'prim.box', parent: null, params: { hasMass: false } }]), { domain: 'ship', comps: [{ id: 'c1', type: 'prim.cyl', parent: null, params: { hasMass: false } }] }]) {
    const out = {}
    A.combineMass(doc, out)
    assert.equal(out.massKg, 0)
    assert.deepStrictEqual(out.comBody, [0, 0, 0])
    assert.deepStrictEqual(out.inertiaBody, [[0, 0, 0], [0, 0, 0], [0, 0, 0]])
    assert.ok(Object.is(out.comBody[0], 0), '不是 −0')
    assert.equal(out.count, 0)
  }
  // 同一个 out 从有质量变回无质量：数组复用、值清零
  const out = {}, doc = wingDoc()
  A.combineMass(doc, out)
  const com = out.comBody
  assert.ok(out.massKg > 0)
  A.combineMass(docOf([]), out)
  assert.equal(out.comBody, com); assert.deepStrictEqual(com, [0, 0, 0]); assert.equal(out.massKg, 0)
})

t('solvePose / combineMass 收未归一文档：缺省推断与 normalizeAssembly 同一套（attach 缺 mode、radial 缺 axis、自由件缺 t / q）', () => {
  const raw = docOf([
    BUS({}, { yM: 2.1 }),
    { id: 'blk', type: 'prim.box', parent: 'bus', attach: { face: '+Z' }, params: { xM: 1, yM: 1, zM: 1 } },   // 缺 mode：有 face → surface
    { id: 'ss', type: 'sat.sensor.sun', parent: 'bus', attach: { socket: '+X', roll: 30 } },                // 缺 mode：有 socket → socket
    { id: 'th', type: 'sat.thruster', parent: 'bus', attach: {}, sym: { op: 'radial', n: 3 } },             // 自由件缺 t / q
    { id: 'p', type: 'prim.box', parent: 'bus', attach: { mode: 'free', face: '-Z', uv: [0.3, 0.2] } }
  ])
  const a = A.solvePose(raw), b = A.solvePose(A.normalizeAssembly(raw))
  assert.deepStrictEqual([...a.keys()], [...b.keys()])
  for (const [id, p] of a) {
    assert.deepStrictEqual(Array.from(p.m), Array.from(b.get(id).m), id)
    assert.equal(p.bad, null, `${id} 未归一也不报解算失败`); assert.equal(p.mode, b.get(id).mode, `${id} mode`)
  }
  near(a.get('blk').m[14], 1.5, 1e-15, '缺 mode 的贴面件坐在 +Z 面上（不是半截插进父件）')
  const r = A.buildAssembly(raw), cm = A.combineMass(raw)
  near(cm.massKg, r.massProps.massKg, 1e-9, '质量')
  nearV(cm.comBody, specPos(r, r.massProps.comBody), 1e-12, 'combineMass = buildAssembly 质心')
  // 飞机：radial 缺 axis 取 +X（机身轴），与归一件同
  const ac = { domain: 'aircraft', comps: [{ id: 'f', type: 'prim.cyl', parent: null, params: { dM: 1, hM: 6 } }, { id: 'e', type: 'prim.box', parent: 'f', attach: { mode: 'free' }, t: [0, 1.5, 3], sym: { op: 'radial', n: 2 } }] }
  const pa = A.solvePose(ac), pb = A.solvePose(A.normalizeAssembly(ac))
  nearV(Array.from(pa.get('e~1').m).slice(12, 15), [0, -1.5, -3], 1e-15, '绕 +X 转 180°')
  assert.deepStrictEqual(Array.from(pa.get('e~1').m), Array.from(pb.get('e~1').m))
  // 同一个 out：领域一改，缺省轴跟着变（计划缓存按领域失效）
  const out = new Map()
  A.solvePose(ac, out)
  A.solvePose({ ...ac, domain: 'ship' }, out)
  nearV(Array.from(out.get('e~1').m).slice(12, 15), [0, -1.5, 3], 1e-15, '换领域后绕 +Z 转 180°')
})

// ───────────────────────── assembly-ux §7 P1 六条 ─────────────────────────

t('P1-1 同一文档两次生成逐字段相等（含 IR TypedArray 字节）', () => {
  const doc = A.specToAssembly(templateSpec(DEFAULT_TEMPLATE_ID).spec)
  const a = A.buildAssembly(doc), b = A.buildAssembly(JSON.parse(JSON.stringify(doc)))
  assert.deepStrictEqual(a, b)
  assert.equal(a.specHash, A.asmHash(doc))
})

t('P1-2 质量合成对解析值误差 < 1e-9（平台体 + 远地点发动机 + 手填质量的盒，含密度覆盖）', () => {
  const doc = docOf([
    BUS({}, { xM: 2, yM: 3, zM: 4, massKg: 1000 }),
    { id: 'lae', type: 'sat.thruster', parent: 'bus', attach: { mode: 'surface', face: '-Z', uv: [0, 0] }, params: { kind: 'lae' } },
    { id: 'blk', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+X', uv: [0.3, -0.2], roll: 30 }, params: { xM: 0.5, yM: 0.5, zM: 0.5 }, massKg: 10 }
  ], { density: { laeMass: 7 } })
  const r = A.buildAssembly(doc), mp = r.massProps
  // 解析：平台体 1000 kg 实心盒 2×3×4（中心 0）；发动机 7 kg 质点在 −Z 面下 0.4×0.35 m；盒 10 kg 实心 0.5³，中心在 +X 面外 0.25 m、面内偏移（u=+Z 0.3，v=−Y −0.2）
  const parts = [
    { m: 1000, c: [0, 0, 0], I: [1000 * (9 + 16) / 12, 1000 * (4 + 16) / 12, 1000 * (4 + 9) / 12] },
    { m: 7, c: [0, 0, -2 - 0.4 * 0.35], I: [0, 0, 0] },
    { m: 10, c: [1.25, 0.2, 0.3], I: [10 * 0.5 / 12, 10 * 0.5 / 12, 10 * 0.5 / 12] }
  ]
  const M = parts.reduce((s, p) => s + p.m, 0)
  const com = [0, 1, 2].map((k) => parts.reduce((s, p) => s + p.m * p.c[k], 0) / M)
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const p of parts) {
    const d = p.c.map((x, k) => x - com[k]), d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[i][j] += (i === j ? p.I[i] : 0) + p.m * ((i === j ? d2 : 0) - d[i] * d[j])
  }
  assert.ok(relErr(mp.massKg, M) < 1e-9, '质量')
  nearV(specPos(r, mp.comBody), com, 1e-9 * 4, '质心')
  const scale = Math.max(...I.flat().map(Math.abs))
  I.flat().forEach((x, i) => near(mp.inertiaBody[Math.floor(i / 3)][i % 3], x, 1e-9 * scale, `惯量[${i}]`))
  // combineMass（根件坐标系）与之同数
  const cm = A.combineMass(doc)
  assert.ok(relErr(cm.massKg, M) < 1e-12)
  nearV(cm.comBody, com, 1e-12, 'combineMass 质心')
})

t('P1-3 镜像翼：派生件走钩子，翼尖在 −Y、电池面朝 −Z，位姿为真旋转且等于装在 −Y 面滚转 0°', () => {
  const r = A.buildAssembly(wingDoc())
  const poses = A.solvePose(wingDoc())
  const p1 = poses.get('w~1')
  assert.equal(p1.mode, 'hook'); assert.equal(p1.plane, 'xz')
  near(det3(Array.from(p1.m)), 1, 1e-12, '派生位姿 det')
  // 与「同参数装在 −Y 面、滚转 0°」逐位相同
  const direct = A.solvePose(docOf([BUS({}, { yM: 2.1 }), { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'surface', face: '-Y' }, params: { panels: 2 } }])).get('w')
  assert.deepStrictEqual(Array.from(p1.m), Array.from(direct.m))
  // 翼尖（最外板电池面顶点的 y 极值）在 −Y、电池面法向 −Z
  const cells = worldMesh(r, 'w-1_wing_2_cells')
  assert.ok(Math.max(...cells.P.map((p) => p[1])) < -1.05 - 2.5, '翼尖在 −Y 且越过平台 + 轭')
  for (const nv of cells.N) nearV(nv, [0, 0, -1], 1e-6, '电池面法向')
  const part = r.parts.find((p) => p.id === 'w-1_wing')
  nearV(part.normalBody, [0, 0, -1], 1e-12, '部件法向')
  const prim = worldMesh(r, 'w_wing_2_cells')
  assert.ok(Math.min(...prim.P.map((p) => p[1])) > 1.05 + 2.5, '主件翼尖在 +Y')
  // 反例（坑 §6.5）：翼板节点局部 y = 翼展、z = 电池面法向；只换位姿 (S·R·S) 时 (S·R·S)·ŷ = S·R·(−ŷ) 仍朝 +Y
  const S = [1, -1, 1]
  const Mi = bodyMatrix(r.ir, nodeIdx(r.ir, 'w_wing_1_substrate')), Md = bodyMatrix(r.ir, nodeIdx(r.ir, 'w-1_wing_1_substrate'))
  nearV([0, 1, 2].map((k) => S[k] * -Mi[4 + k]), [0, 1, 0], 1e-12, '只换位姿：翼展仍朝 +Y')
  nearV([Md[4], Md[5], Md[6]], [0, -1, 0], 1e-12, '钩子：派生翼板翼展朝 −Y')
  nearV([Md[8], Md[9], Md[10]], [0, 0, -1], 1e-12, '钩子：派生翼板电池面法向 −Z')
  near(det3(Md), 1, 1e-12, '派生翼板节点真旋转')
  // 挂点 / 关节 / 太阳翼组都成对、名字由组件 id 派生
  assert.deepStrictEqual(r.articulations.map((a) => a.name), ['w_wing', 'w-1_wing'])
  assert.deepStrictEqual(r.solarPanelGroups.map((g) => g.name), ['w_wing', 'w-1_wing'])
  nearV(apOf(r, 'w-1_axis').dirBody, [0, -1, 0], 1e-12, '翼轴挂点')
})

t('P1-3b 带转角的翼：钩子把转角取反，派生几何 = 主件几何关于 XZ 面的镜像（顶点集合逐点对上）', () => {
  const r = A.buildAssembly(wingDoc(2.1, { tiltDeg: 30, sidePanels: 2 }))
  for (const nd of ['wing_1_substrate', 'wing_2_cells', 'wing_2a_substrate', 'wing_yoke', 'wing_sada']) {
    const a = worldMesh(r, `w_${nd}`), b = worldMesh(r, `w-1_${nd}`)
    const mirrored = vset(a.P, [1, -1, 1]), got = vset(b.P)
    if (nd.endsWith('a_substrate')) { const bb = worldMesh(r, 'w-1_wing_2b_substrate'); sameSet(mirrored, vset(bb.P), `${nd}（a ↔ b 互换）`) } else sameSet(mirrored, got, nd)
  }
  assert.equal(A.normalizeAssembly(wingDoc(2.1, { tiltDeg: 30 })).comps[1].params.tiltDeg, 30, '文档只存主件')
})

t('P1-4 平台体 yM 加 0.4 m：两翼翼根跟着 ±0.2 m（解算位姿与挂点）', () => {
  const a = A.solvePose(wingDoc(2.1)), b = A.solvePose(wingDoc(2.5))
  near(b.get('w').m[13] - a.get('w').m[13], 0.2, 1e-12, '+Y 翼根')
  near(b.get('w~1').m[13] - a.get('w~1').m[13], -0.2, 1e-12, '−Y 翼根')
  near(a.get('w').m[13], 1.05, 1e-15, '翼根在 +Y 面上')
  const ra = A.buildAssembly(wingDoc(2.1)), rb = A.buildAssembly(wingDoc(2.5))
  near(specPos(rb, apOf(rb, 'w_axis').posBody)[1] - specPos(ra, apOf(ra, 'w_axis').posBody)[1], 0.2, 1e-12, 'w_axis')
  near(specPos(rb, apOf(rb, 'w-1_axis').posBody)[1] - specPos(ra, apOf(ra, 'w-1_axis').posBody)[1], -0.2, 1e-12, 'w-1_axis')
})

t('P1-5 validateIR 通过、nonFiniteReport 为空（手搭文档与 default-sat 转换件）', () => {
  for (const doc of [wingDoc(), A.specToAssembly(templateSpec(DEFAULT_TEMPLATE_ID).spec)]) {
    const r = A.buildAssembly(doc)
    const v = validateIR(r.ir)
    assert.ok(v.ok, v.errors.join('；'))
    assert.deepStrictEqual(nonFiniteReport(r), [])
    assert.ok(r.ir.nodes.every((nd) => NAME_RE.test(nd.name)), '节点名只含 [A-Za-z0-9_+-]')
    assert.ok(r.ir.nodes.every((nd, i) => i === 0 || Math.abs(det3(nd.matrix) - 1) < 1e-9), '节点矩阵都是真旋转')
  }
})

t('P1-6 buildAssembly 返回键集合与 buildParamModel 相同；根节点 / frame 取 bodyFrame 出厂映射', () => {
  const spec = templateSpec(DEFAULT_TEMPLATE_ID).spec
  const r = A.buildAssembly(A.specToAssembly(spec)), p = buildParamModel(spec)
  assert.deepStrictEqual(Object.keys(r).sort(), Object.keys(p).sort())
  assert.deepStrictEqual(Object.keys(r.massProps).sort(), Object.keys(p.massProps).sort())
  assert.deepStrictEqual(Object.keys(r.frame).sort(), Object.keys(p.frame).sort())
  assert.equal(r.ir.nodes[0].name, 'satellite')
  assert.deepStrictEqual(r.ir.nodes[0].matrix, Array.from(ROOT_MATRIX_BODY2MODEL))
  assert.deepStrictEqual(r.frame.q_model2body, Array.from(DEFAULT_Q_MODEL2BODY))
  assert.equal(r.spec.kind, 'assembly')
  // 非卫星领域：根节点矩阵换成 Q_YUP_ZENITH 的逆
  const g = A.buildAssembly({ domain: 'ship', comps: [{ id: 'c1', type: 'prim.box', parent: null, massKg: 5 }] })
  assert.equal(g.ir.nodes[0].name, 'ship')
  assert.deepStrictEqual(g.frame.q_model2body, Array.from(A.DOMAIN_FRAMES.ship.q))
})

// ───────────────────────── 镜像数学：偏置反射面 ─────────────────────────

const reflDoc = (type, op = 'mirrorYZ') => docOf([
  BUS(),
  { id: 'r', type, parent: 'bus', attach: { mode: 'free', socket: '+X' }, t: [0, -0.3, 1.2], q: [0.1, -0.2, 0.05, 0.97], params: { diameterM: 1.6, offsetHM: 1.0, feed: 'horn' }, sym: { op } }
])

t('偏置反射面镜像（缺省）：关于母轴 + 偏置方向面对称 → 走对称面，几何复用，世界顶点集合 = S × 主件', () => {
  const pose = A.solvePose(reflDoc('sat.reflector')).get('r~1')
  assert.equal(pose.mode, 'plane'); assert.equal(pose.plane, 'xz')
  assert.deepStrictEqual(getComponent('sat.reflector').symmetricPlanes({ ...fillParams(getComponent('sat.reflector'), {}), offsetHM: 0 }), ['yz', 'xz'], '正馈两面对称')
  const r = A.buildAssembly(reflDoc('sat.reflector'))
  for (const nd of ['reflector', 'reflector_back', 'reflector_rim', 'feed']) {
    const a = worldMesh(r, `r_${nd}`), b = worldMesh(r, `r-1_${nd}`)
    sameSet(vset(a.P, [-1, 1, 1]), vset(b.P), nd)
  }
  // 焦点挂点 / 拟合几何也是镜像
  nearV(specPos(r, apOf(r, 'r-1_focus').posBody), specPos(r, apOf(r, 'r_focus').posBody).map((x, k) => (k === 0 ? -x : x)), 1e-12, '焦点')
  const fa = r.parts.find((p) => p.id === 'r_reflector').fitted, fb = r.parts.find((p) => p.id === 'r-1_reflector').fitted
  nearV(fb.axisBody, fa.axisBody.map((x, k) => (k === 0 ? -x : x)), 1e-12, '母轴')
})

t('偏置反射面烘焙镜像（不声明对称面的变体）：顶点乘 S、法向乘 S、绕序翻转、节点矩阵真旋转', () => {
  registerComponent({ ...getComponent('sat.reflector'), type: 'test.reflasym', symmetricPlanes: undefined }, { replace: true })
  const doc = reflDoc('test.reflasym')
  const pose = A.solvePose(doc).get('r~1')
  assert.equal(pose.mode, 'bake')
  near(det3(Array.from(pose.m)), 1, 1e-12, '派生组件位姿 det')
  const r = A.buildAssembly(doc)
  const S = [-1, 1, 1]
  for (const nd of ['reflector', 'reflector_back', 'reflector_rim', 'feed']) {
    const a = worldMesh(r, `r_${nd}`), b = worldMesh(r, `r-1_${nd}`)
    assert.equal(a.P.length, b.P.length)
    a.P.forEach((p, i) => nearV(b.P[i], p.map((x, k) => x * S[k]), 2e-5, `${nd} 顶点 ${i} 乘 S`))
    a.N.forEach((v, i) => nearV(b.N[i], v.map((x, k) => x * S[k]), 2e-6, `${nd} 法向 ${i} 乘 S`))
    for (let k = 0; k < a.index.length; k += 3) assert.deepStrictEqual([b.index[k], b.index[k + 1], b.index[k + 2]], [a.index[k], a.index[k + 2], a.index[k + 1]], `${nd} 绕序翻转`)
    near(det3(b.M), 1, 1e-9, `${nd} 节点矩阵真旋转`)
    // 绕序与顶点法向自洽（几何法向与平均顶点法向同侧，和主件一样）
    const side = (m) => { let s = 0; for (let k = 0; k < m.index.length; k += 3) { const [p0, p1, p2] = [m.P[m.index[k]], m.P[m.index[k + 1]], m.P[m.index[k + 2]]]; const u = p1.map((x, j) => x - p0[j]), w = p2.map((x, j) => x - p0[j]); const g = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; const nv = m.N[m.index[k]]; s += Math.sign(g[0] * nv[0] + g[1] * nv[1] + g[2] * nv[2]) } return s }
    assert.equal(Math.sign(side(b)), Math.sign(side(a)), `${nd} 法向与绕序同侧`)
  }
  nearV(specPos(r, apOf(r, 'r-1_focus').posBody), specPos(r, apOf(r, 'r_focus').posBody).map((x, k) => x * S[k]), 1e-12, '焦点挂点乘 S')
  // 烘焙件质量特性 = 主件的镜像
  const ca = r.massProps.components.find((c) => c.name === 'r_reflector'), cb = r.massProps.components.find((c) => c.name === 'r-1_reflector')
  near(cb.massKg, ca.massKg, 1e-12, '烘焙件质量')
  nearV(specPos(r, cb.comBody), specPos(r, ca.comBody).map((x, k) => x * S[k]), 1e-12, '烘焙件质心')
  // 带关节的件被烘焙时，节点局部镜面保留关节轴：翼板节点局部 y（yRotate 轴）= 主件翼轴的镜像
  const w = getComponent('sat.wing')
  registerComponent({ ...w, type: 'test.wingnohook', mirror: undefined, mirrorPlanes: undefined }, { replace: true })
  const wd = wingDoc(2.1, { tiltDeg: 25 }); wd.comps[1].type = 'test.wingnohook'
  assert.equal(A.solvePose(wd).get('w~1').mode, 'bake')
  const rw = A.buildAssembly(wd)
  for (const nd of ['wing_1_substrate', 'wing_2_cells', 'wing_yoke']) {
    const a = worldMesh(rw, `w_${nd}`), b = worldMesh(rw, `w-1_${nd}`), Sy = [1, -1, 1]
    a.P.forEach((p, i) => nearV(b.P[i], p.map((x, k) => x * Sy[k]), 2e-5, `${nd} 顶点 ${i}`))
    near(det3(b.M), 1, 1e-9, `${nd} 真旋转`)
    nearV([b.M[4], b.M[5], b.M[6]].map(Math.abs), [a.M[4], -a.M[5], a.M[6]].map(Math.abs), 1e-12, `${nd} 关节轴是镜像`)
  }
  assert.deepStrictEqual(rw.articulations.find((x) => x.name === 'w-1_wing').stages[0].type, 'yRotate')
})

t('烘焙件手填质量：自身无质量元时按 unitMass 分布，unitMass 也过局部镜面（偏轴质心镜像到位）', () => {
  // 变体：不声明对称面、自身无质量元、unitMass 质心偏在局部 +y 0.4 m
  const sun = getComponent('sat.sensor.sun')
  registerComponent({ ...sun, type: 'test.unitoff', symmetricPlanes: undefined, unitMass: () => [{ name: 'body', kind: 'point', massKg: 1, com: [0, 0.4, 0.01], I: [0, 0.2, 0, 0.2, 0, 0.3, 0, 0.3, 0] }] }, { replace: true })
  const doc = docOf([BUS(), { id: 'u', type: 'test.unitoff', parent: 'bus', attach: { mode: 'surface', face: '+Z', uv: [0.2, 0.1] }, massKg: 2, sym: { op: 'mirrorXZ' } }])
  assert.equal(A.solvePose(doc).get('u~1').mode, 'bake')
  const r = A.buildAssembly(doc)
  const a = r.massProps.components.find((c) => c.name === 'u_body'), b = r.massProps.components.find((c) => c.name === 'u-1_body')
  near(a.massKg, 2, 1e-12, '主件'); near(b.massKg, 2, 1e-12, '派生件')
  nearV(specPos(r, a.comBody), [0.2, 0.5, 1.51], 1e-12, '主件质心')
  nearV(specPos(r, b.comBody), [0.2, -0.5, 1.51], 1e-12, '派生件质心 = 主件的 XZ 镜像')
  // 惯量交叉项随镜像翻号：两件对 xz 面对称 → 合成惯量的 xy / yz 项只剩平台体（对称）的 0
  const cm = A.combineMass(doc)
  near(cm.comBody[1], 0, 1e-12, '合成质心在 XZ 面上')
  near(cm.inertiaBody[0][1], 0, 1e-9, 'Ixy'); near(cm.inertiaBody[1][2], 0, 1e-9, 'Iyz')
})

// ───────────────────────── specToAssembly ─────────────────────────

t('specToAssembly(default-sat)：装配件质量与原参数化模型相对误差 < 1e-6（带 / 不带目标质量；质心、惯量、挂点同对）', () => {
  const spec = templateSpec(DEFAULT_TEMPLATE_ID).spec
  for (const s of [spec, { ...spec, massTargetKg: null }]) {
    const doc = A.specToAssembly(s)
    assert.ok(A.validateAssembly(doc).ok)
    const r = A.buildAssembly(doc), p = buildParamModel(s)
    assert.ok(relErr(r.massProps.massKg, p.massProps.massKg) < 1e-6, `质量 ${r.massProps.massKg} vs ${p.massProps.massKg}`)
    nearV(specPos(r, r.massProps.comBody), specPos(p, p.massProps.comBody), 1e-9, '质心（文档坐标）')
    const sc = Math.max(...p.massProps.inertiaBody.flat().map(Math.abs))
    r.massProps.inertiaBody.flat().forEach((x, i) => near(x, p.massProps.inertiaBody.flat()[i], 1e-6 * sc, `惯量[${i}]`))
    assert.equal(r.massProps.components.length, p.massProps.components.length, '质量元一一对应')
    assert.equal(r.articulations.length, p.articulations.length); assert.equal(r.solarPanelGroups.length, p.solarPanelGroups.length)
    const pairs = [['refl1_focus', 'reflector_1_focus'], ['refl2_focus', 'reflector_2_focus'], ['refl3_focus', 'reflector_3_focus'], ['refl4_focus', 'reflector_4_focus'], ['wing1_axis', 'wing_+Y_axis'], ['wing1-1_axis', 'wing_-Y_axis'], ['bus_nadir_center', 'nadir_center']]
    for (const [a, b] of pairs) {
      const x = apOf(r, a), y = apOf(p, b)
      nearV(specPos(r, x.posBody), specPos(p, y.posBody), 1e-9, `${a} 位置`)
      nearV(x.dirBody, y.dirBody, 1e-12, `${a} 视轴`); nearV(x.upBody, y.upBody, 1e-12, `${a} 上向`)
    }
    const fr = r.parts.find((q) => q.id === 'refl1_reflector').fitted, fp = p.parts.find((q) => q.id === 'reflector_1').fitted
    near(fr.focalM, fp.focalM, 1e-12, '焦距'); nearV(specPos(r, fr.vertexBody), specPos(p, fp.vertexBody), 1e-9, '顶点')
  }
  // 太阳翼成对 → 主件 + 镜像 XZ；反射面挂在平台侧壁插座 / 天线塔顶
  const doc = A.specToAssembly(spec)
  const w = doc.comps.find((c) => c.id === 'wing1')
  assert.deepStrictEqual([w.attach.mode, w.attach.face, w.sym.op], ['surface', '+Y', 'mirrorXZ'])
  assert.deepStrictEqual(doc.comps.filter((c) => c.type === 'sat.reflector').map((c) => `${c.parent}:${c.attach.socket}`), ['bus:+X', 'bus:-X', 'tower:top', 'tower:top'])
  assert.equal(doc.massTargetKg, spec.massTargetKg)
  assert.throws(() => A.specToAssembly(templateSpec(DEFAULT_TEMPLATE_ID, { fill: 'none' }).spec), (e) => e.code === 'SPEC_INVALID')
})

t('specToAssembly：全部模板 × 带 / 不带目标质量，总质量 / 质心 / 惯量与原参数化模型一致', () => {
  for (const id of TEMPLATE_IDS) {
    const spec = templateSpec(id).spec
    for (const s of [spec, { ...spec, massTargetKg: null }]) {
      const r = A.buildAssembly(A.specToAssembly(s)), p = buildParamModel(s)
      assert.ok(relErr(r.massProps.massKg, p.massProps.massKg) < 1e-9, `${id} 质量`)
      const L = Math.max(...p.bboxBody.max.map((x, k) => x - p.bboxBody.min[k]))
      nearV(specPos(r, r.massProps.comBody), specPos(p, p.massProps.comBody), 1e-9 * L, `${id} 质心`)
      const sc = Math.max(...p.massProps.inertiaBody.flat().map(Math.abs))
      r.massProps.inertiaBody.flat().forEach((x, i) => near(x, p.massProps.inertiaBody.flat()[i], 1e-9 * sc, `${id} 惯量[${i}]`))
      assert.ok(validateIR(r.ir).ok, id)
    }
  }
  // 带转角的翼对 → 径向 2（整星 ±Y 翼是绕 Z 转 180° 的关系）；显式附加件也能转
  const s = { ...templateSpec('generic').spec }
  s.wings = s.wings.map((w) => ({ ...w, tiltDeg: 20 }))
  s.feeds = [{ kind: 'horn', posBody: [0.2, 0.1, 0.9], dirBody: [0, 0, 1], apertureM: 0.1 }, { kind: 'patchArray', posBody: [-0.2, 0.1, 0.61], dirBody: [0, 0.3, 1], apertureM: 0.12 }]
  s.booms = [{ fromBody: [0.5, 0.5, 0.6], toBody: [0.9, 0.9, 1.5], dM: 0.03 }]
  s.thrusters = [{ posBody: [-0.5, 0, -0.3], dirBody: [-1, 0, -0.2], exitDM: 0.03, lengthM: 0.06 }]
  s.radiators = [{ face: '+X', wM: 0.4, hM: 0.6 }, { face: '-Z', wM: 0.3, hM: 0.2 }]
  s.reflectors = [{ slot: '+X', diameterM: 0.8, mesh: false, feedType: 'horn' }, { slot: '+X2', diameterM: 0.6 }, { slot: 'deck+Y', diameterM: 0.5, feedType: 'array' }, { posBody: [0.2, -0.3, 1.4], diameterM: 0.4, boresightBody: [0.1, 0, 1], offsetDirBody: [0, -1, 0] }]
  const doc = A.specToAssembly(s)
  assert.equal(doc.comps.find((c) => c.id === 'wing1').sym.op, 'radial')
  const r = A.buildAssembly(doc), p = buildParamModel(s)
  assert.ok(relErr(r.massProps.massKg, p.massProps.massKg) < 1e-9, '附加件变体质量')
  nearV(specPos(r, r.massProps.comBody), specPos(p, p.massProps.comBody), 1e-9, '附加件变体质心')
  for (let i = 1; i <= 4; i++) nearV(specPos(r, apOf(r, `refl${i}_focus`).posBody), specPos(p, apOf(p, `reflector_${i}_focus`).posBody), 1e-9, `refl${i} 焦点`)
  // 翼（带转角）的电池面逐位置对上整星
  const wa = worldMesh(r, 'wing1-1_wing_1_cells'), pi = p.ir.nodes.findIndex((x) => x.name === 'wing_-Y_1_cells')
  const pm = p.ir.meshes[p.ir.nodes[pi].mesh], pM = bodyMatrix(p.ir, pi)
  for (let v = 0; v < pm.position.length; v += 3) {
    const x = pm.position[v], y = pm.position[v + 1], z = pm.position[v + 2]
    nearV(wa.P[v / 3], [0, 1, 2].map((k) => pM[k] * x + pM[4 + k] * y + pM[8 + k] * z + pM[12 + k] + p.specOriginBody[k]), 1e-9, `−Y 翼电池面顶点 ${v / 3}`)
  }
})

t('specToAssembly 立方星：结构盒按导轨内缩画、质量按包络；体装电池片 / 贴片在结构盒外、导轨包络内，导轨面不与结构盒共面', () => {
  const base = templateSpec('cubesat-3u').spec
  const rich = JSON.parse(JSON.stringify(base))
  rich.cubesat = { bodyCells: true, deployPanels: 2 }
  rich.radiators = [{ face: '+X', wM: 0.05, hM: 0.1 }, { face: '-Z', wM: 0.04, hM: 0.04 }, { face: '+Y', wM: 0.03, hM: 0.05 }]
  rich.reflectors = [{ slot: '+X', diameterM: 0.3, mesh: false, feedType: 'horn' }, { slot: 'deck+Y', diameterM: 0.2 }]
  const cases = [...TEMPLATE_IDS.filter((id) => templateSpec(id).spec.layout === 'cubesat').map((id) => [id, templateSpec(id).spec]), ['cubesat-3u 全附件', rich]]
  for (const [id, spec] of cases) {
    const doc = A.specToAssembly(spec)
    const r = A.buildAssembly(doc), p = buildParamModel(spec)
    // 质量 / 质心 / 惯量 / 挂点仍与原模型一致
    assert.ok(relErr(r.massProps.massKg, p.massProps.massKg) < 1e-9, `${id} 质量`)
    nearV(specPos(r, r.massProps.comBody), specPos(p, p.massProps.comBody), 1e-9, `${id} 质心`)
    const sc = Math.max(...p.massProps.inertiaBody.flat().map(Math.abs))
    r.massProps.inertiaBody.flat().forEach((x, i) => near(x, p.massProps.inertiaBody.flat()[i], 1e-9 * sc, `${id} 惯量[${i}]`))
    for (const [a, b] of [['bus_nadir_center', 'nadir_center'], ['bus_zenith_center', 'zenith_center']]) nearV(specPos(r, apOf(r, a).posBody), specPos(p, apOf(p, b).posBody), 1e-12, `${id} ${a}`)
    // 结构盒（组件 bus 的网格）= paramBus 的内缩盒
    const X = spec.bus.xM, Y = spec.bus.yM, Z = spec.bus.zM
    const bus = worldMesh(r, 'bus_bus').P, hs = [0, 1, 2].map((k) => Math.max(...bus.map((q) => Math.abs(q[k]))))
    const pb = worldMesh({ ir: p.ir, specOriginBody: p.specOriginBody }, 'bus').P
    nearV(hs, [0, 1, 2].map((k) => Math.max(...pb.map((q) => Math.abs(q[k])))), 1e-12, `${id} 结构盒与原模型同尺寸`)
    assert.ok(hs[0] < X / 2 && hs[1] < Y / 2 && hs[2] < Z / 2, `${id} 结构盒比包络小`)
    // 体装电池片：在结构盒外（沿面法向）、导轨包络内
    const cellNodes = r.solarPanelGroups.filter((g) => /^cells[pm][xy]_/.test(g.name)).flatMap((g) => g.nodes)
    assert.equal(cellNodes.length, spec.cubesat.bodyCells ? 4 : 0, `${id} 体装电池片 4 块`)
    for (const nd of cellNodes) {
      const P = worldMesh(r, nd).P, ax = /x_/.test(nd) ? 0 : 1
      for (const q of P) assert.ok(Math.abs(q[ax]) > hs[ax] + 1e-4 && Math.abs(q[ax]) < [X, Y][ax] / 2, `${id} ${nd} 顶点 ${q} 应在结构盒外、包络内`)
    }
    // 对地贴片：底面贴结构盒顶面、顶面高出
    if (r.ir.nodes.some((n) => n.name === 'patch_box')) {
      const P = worldMesh(r, 'patch_box').P, zs = P.map((q) => q[2])
      near(Math.min(...zs), hs[2], 1e-6, `${id} 贴片底面（Float32 顶点）`); assert.ok(Math.max(...zs) > hs[2] + 1e-3, `${id} 贴片高出结构盒`)
    }
    // 导轨：外表面在包络上，没有一个面与结构盒的面共面
    for (let i = 1; i <= 4; i++) {
      const P = worldMesh(r, `rail${i}_box`).P
      for (let k = 0; k < 3; k++) for (const q of P) assert.ok(Math.abs(Math.abs(q[k]) - hs[k]) > 1e-4, `${id} rail${i} 轴 ${k} 与结构盒面共面`)
      near(Math.max(...P.map((q) => Math.abs(q[0]))), X / 2, 1e-6, `${id} rail${i} 外缘 = 包络（Float32 顶点）`)
    }
  }
})

// ───────────────────────── 其余解算 ─────────────────────────

t('径向对称：4 个推力器绕 +Z 均布（派生位姿 = Rz(90°k)·主件）', () => {
  const doc = docOf([BUS(), { id: 'th', type: 'sat.thruster', parent: 'bus', attach: { mode: 'free', face: '-Z', uv: [0.6, 0.4] }, q: [0.2, 0, 0, 0.98], sym: { op: 'radial', n: 4 } }])
  const P = A.solvePose(doc)
  assert.deepStrictEqual([...P.keys()], ['bus', 'th', 'th~1', 'th~2', 'th~3'])
  const t0 = Array.from(P.get('th').m).slice(12, 15)
  for (let k = 1; k < 4; k++) {
    const m = P.get(`th~${k}`), c = Math.round(Math.cos(k * Math.PI / 2)), s = Math.round(Math.sin(k * Math.PI / 2))
    assert.equal(m.mode, 'radial')
    nearV(Array.from(m.m).slice(12, 15), [c * t0[0] - s * t0[1], s * t0[0] + c * t0[1], t0[2]], 1e-15, `th~${k}`)
  }
  assert.deepStrictEqual(A.expandSymmetry(doc).map((e) => `${e.id}/${e.prefix}/${e.parent}`), ['bus/bus/null', 'th/th/bus', 'th~1/th-1/bus', 'th~2/th-2/bus', 'th~3/th-3/bus'])
  const r = A.buildAssembly(doc)
  near(r.massProps.components.filter((c) => c.name.startsWith('th')).length, 4, 0, '4 个质点')
})

t('插座安装：馈源 aperture 插到反射面 focus → 口面中心在焦点、朝向口径中心；反射面参数改了馈源跟着走', () => {
  const mk = (D) => docOf([
    BUS({}, { zM: 3.6 }),
    { id: 'r', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+Z', roll: 90 }, params: { diameterM: D, feed: 'none' } },
    { id: 'f', type: 'sat.feed.horn', parent: 'r', attach: { mode: 'socket', socket: 'focus', mount: 'aperture' }, params: { apertureM: 0.15 } }
  ])
  for (const D of [1.2, 2.0]) {
    const P = A.solvePose(mk(D)), Mr = P.get('r').m, Mf = P.get('f').m
    const g = reflectorFrame(fillParams(getComponent('sat.reflector'), { diameterM: D }))
    const w = (M, v) => [0, 1, 2].map((k) => M[k] * v[0] + M[4 + k] * v[1] + M[8 + k] * v[2] + M[12 + k])
    const Fw = w(Mr, g.F), Pcw = w(Mr, g.Pc)
    const ap = w(Mf, [0, 0, 0.15 * 1.6])
    nearV(ap, Fw, 1e-12, `D=${D} 口面中心在焦点`)
    const dir = [Mf[8], Mf[9], Mf[10]], want = Pcw.map((x, k) => x - Fw[k]), l = Math.hypot(...want)
    nearV(dir, want.map((x) => x / l), 1e-12, `D=${D} 喇叭朝口径中心`)
    // 反射面背面贴在 +Z 面心、口径中心法向 = +Z
    nearV(w(Mr, [0, 0, 0]), [0, 0, 1.8], 1e-12, '安装基准在 +Z 面心')
    nearV([Mr[8], Mr[9], Mr[10]], [0, 0, 1], 1e-12, '口径中心法向')
  }
  assert.ok(A.validateAssembly(mk(1.2)).ok)
})

t('柱面贴装：bus.cyl 侧面 uv（沿轴高度, 弧长）→ 位置与朝向；uv1 沿面系 +y', () => {
  const doc = (uv) => docOf([{ id: 'b', type: 'sat.bus.cyl', parent: null, params: { dM: 2, hM: 3, mli: 'none' } },
    { id: 's', type: 'sat.sensor.sun', parent: 'b', attach: { mode: 'surface', face: 'side', uv } }])
  const m0 = A.solvePose(doc([0.5, 0])).get('s').m
  nearV(Array.from(m0).slice(12, 15), [1, 0, 0.5], 1e-15, '弧长 0 在 +X')
  nearV([m0[8], m0[9], m0[10]], [1, 0, 0], 1e-15, '径向外法向')
  nearV([m0[0], m0[1], m0[2]], [0, 0, 1], 1e-15, '滚转零位 = 轴向')
  const m1 = A.solvePose(doc([0, Math.PI / 2])).get('s').m   // 弧长 π/2（r = 1）→ 转 −90°：到 −Y，且沿面系 +y（= −Y）走
  nearV(Array.from(m1).slice(12, 15), [0, -1, 0], 1e-15, '弧长 π/2 在 −Y')
  nearV([m0[4], m0[5], m0[6]], [0, -1, 0], 1e-15, 'uv1 方向 = 面系 +y')
  assert.ok(A.validateAssembly(doc([0.5, 1])).ok)
  // 六棱平台的侧面插座
  const hx = A.solvePose(docOf([{ id: 'b', type: 'sat.bus.hex', parent: null, params: { acrossFlatsM: 2, hM: 2, mli: 'none' } },
    { id: 'w', type: 'sat.wing', parent: 'b', attach: { mode: 'socket', socket: 'side1' } }])).get('w').m
  nearV(Array.from(hx).slice(12, 15), [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3), 0], 1e-12, 'side1 面心（对边距 2）')
})

t('solvePose / combineMass 的 out 复用：条目与数组同一实例，改 uv / 参数后值更新，删组件后 out 去掉', () => {
  const doc = wingDoc()
  const out = new Map()
  A.solvePose(doc, out)
  const e = out.get('w~1'), arr = e.m
  const y0 = arr[13]
  doc.comps[1].attach.uv = [0.3, 0.1]   // 就地改（编辑器拖动）
  A.solvePose(doc, out)
  assert.equal(out.get('w~1'), e); assert.equal(out.get('w~1').m, arr)
  near(arr[13], y0, 1e-15, '面内偏移不动法向坐标')
  near(out.get('w').m[14], 0.3, 1e-15, '沿 u（+Z）走 0.3')
  near(out.get('w~1').m[14], 0.3, 1e-15, '派生件跟着主件')
  doc.comps[0].params.yM = 3.1   // 就地改父件参数：缓存按值比对，不读旧插座
  A.solvePose(doc, out)
  near(out.get('w').m[13], 1.55, 1e-15, '父件参数改了子件跟着走')
  const cm = {}
  A.combineMass(doc, cm)
  const com = cm.comBody, I = cm.inertiaBody, m1 = cm.massKg
  doc.comps[1].attach.uv = [0, 0]
  A.combineMass(doc, cm)
  assert.equal(cm.comBody, com); assert.equal(cm.inertiaBody, I)
  near(cm.massKg, m1, 1e-9, '挪位置质量不变')
  assert.ok(Object.keys(cm).every((k) => ['massKg', 'comBody', 'inertiaBody', 'count', 'warnings'].includes(k)), '缓存不可枚举')
  doc.comps.splice(1, 1)
  A.solvePose(doc, out)
  assert.deepStrictEqual([...out.keys()], ['bus'])
})

t('热路径零分配：归一件拖动（就地改 uv / roll / 自由件 t）时 solvePose + combineMass 稳态不涨新生代（独立进程量）', () => {
  // 在新进程里量：本文件前面的用例喂过大量未归一的原始文档，V8 的类型反馈已被搅乱，不代表编辑器稳态（编辑器持有归一件）。
  // 口径：new_space 已用字节，短窗口（避开 GC）取中位数，减去同样测法的空循环基线；JIT 没升到优化档时多热身几轮再量。
  const asmUrl = new URL('../models/assembly.mjs', import.meta.url).href
  const tplUrl = new URL('../models/paramTemplates.mjs', import.meta.url).href
  const src = [
    `import * as A from '${asmUrl}'`,
    `import { templateSpec, DEFAULT_TEMPLATE_ID } from '${tplUrl}'`,
    "import v8 from 'node:v8'",
    "const newSpace = () => v8.getHeapSpaceStatistics().find((s) => s.space_name === 'new_space').space_used_size",
    'const perFrame = (f, frames) => { const d = []; for (let w = 0; w < 25; w++) { const a = newSpace(); for (let i = 0; i < frames; i++) f(i); const b = newSpace(); if (b >= a) d.push((b - a) / frames) } d.sort((x, y) => x - y); return d.length ? d[d.length >> 1] : Infinity }',
    // 混合各种安装模式的手搭件：插座 / 贴面 / 自由（带面锚、带插座锚）、镜像 + 径向、子树、目标质量、双精度滚转
    "const BUS = { id: 'bus', type: 'sat.bus.box', parent: null, params: { xM: 2.1, yM: 2.3, zM: 3.1 } }",
    'const mixed = A.normalizeAssembly({ domain: "spacecraft", massTargetKg: 2500, comps: [BUS,',
    "  { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'surface', face: '+Y', uv: [0.1, 0] }, params: { panels: 3, tiltDeg: 12.5 }, sym: { op: 'mirrorXZ' } },",
    "  { id: 'ss', type: 'sat.sensor.sun', parent: 'w', attach: { mode: 'surface', face: '+Z', uv: [0.1, 0] } },",
    "  { id: 'th', type: 'sat.thruster', parent: 'bus', attach: { mode: 'free', face: '-Z', uv: [0.4, 0.3] }, t: [0, 0, 0.01], q: [0.1, 0, 0, 1], sym: { op: 'radial', n: 3 } },",
    "  { id: 'r', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+X', roll: 22.5 }, params: { diameterM: 1.6, feed: 'none' } },",
    "  { id: 'f', type: 'sat.feed.horn', parent: 'r', attach: { mode: 'socket', socket: 'focus', mount: 'aperture' } },",
    "  { id: 'st', type: 'sat.sensor.star', parent: 'bus', attach: { mode: 'free', socket: '-X' }, t: [0.1, 0.2, 0.05], q: [0, 0.2, 0, 0.98] },",
    "  { id: 'bx', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+Z', uv: [-0.3, 0.2], roll: 7.5 }, massKg: 12.5 }] })",
    'const out = []',
    'for (const doc of [A.specToAssembly(templateSpec(DEFAULT_TEMPLATE_ID).spec), mixed]) {',
    '  const poses = new Map(), cm = {}',
    "  const drags = doc.comps.filter((c) => c.parent && c.attach.mode !== 'free').slice(0, 3), frees = doc.comps.filter((c) => c.parent && c.attach.mode === 'free').slice(0, 2)",
    '  const f = (i) => {',
    "    for (const c of drags) { if (c.attach.uv) c.attach.uv[0] = 0.001 * (i % 50); c.attach.roll = 7.5 * (i % 8) }",
    '    for (const c of frees) c.t[2] = 0.002 * (i % 7)',
    '    A.solvePose(doc, poses); A.combineMass(doc, cm)',
    '  }',
    '  const noop = () => {}',
    '  let got = Infinity',
    '  for (let round = 0; round < 4 && got > 4; round++) { for (let i = 0; i < 15000; i++) f(i); for (let i = 0; i < 2000; i++) noop(i); got = perFrame(f, 200) - perFrame(noop, 200) }',
    '  out.push({ n: doc.comps.length, got, mass: cm.massKg })',
    '}',
    'console.log(JSON.stringify(out))'
  ].join('\n')
  const res = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop())
  assert.equal(res.length, 2)
  for (const r of res) {
    assert.ok(r.got <= 4, `每帧分配 ${r.got.toFixed(1)} B（${r.n} 件）`)
    assert.ok(Number.isFinite(r.mass) && r.mass > 0)
  }
})

t('combineMass = buildAssembly.massProps（文档坐标）；手填质量按比例缩放；目标质量由根件平台体吃余量', () => {
  const doc = A.specToAssembly(templateSpec('generic').spec)
  const r = A.buildAssembly(doc), cm = A.combineMass(doc)
  near(cm.massKg, r.massProps.massKg, 1e-9, '质量')
  nearV(cm.comBody, specPos(r, r.massProps.comBody), 1e-12, '质心')
  assert.equal(cm.count, r.massProps.components.length)
  // 手填组件质量：自身有质量元时整体按比例缩放
  const d2 = wingDoc(); d2.comps[1].massKg = 100
  const r2 = A.buildAssembly(d2)
  const wingM = r2.massProps.components.filter((c) => c.name.startsWith('w_')).reduce((s, c) => s + c.massKg, 0)
  near(wingM, 100, 1e-9, '主件手填质量'); near(r2.massProps.components.filter((c) => c.name.startsWith('w-1_')).reduce((s, c) => s + c.massKg, 0), 100, 1e-9, '派生件同')
  // 目标质量：平台体吃余量；根件手填质量时不吃、告警
  const d3 = { ...wingDoc(), massTargetKg: 3000 }
  near(A.buildAssembly(d3).massProps.massKg, 3000, 1e-9, '目标质量')
  const d4 = { ...wingDoc(), massTargetKg: 3000 }; d4.comps[0].params.massKg = 500
  const r4 = A.buildAssembly(d4)
  assert.ok(r4.massProps.massKg < 3000 && r4.warnings.some((w) => /目标质量/.test(w)))
  const d5 = { ...wingDoc(), massTargetKg: 10 }
  assert.ok(A.buildAssembly(d5).warnings.some((w) => /1\.05 倍/.test(w)))
  // 密度覆盖走 doc.density（与 spec.density 同口径）
  const d6 = { ...wingDoc(), density: { busVolume: DENSITY.busVolume.value * 2 } }
  assert.ok(A.combineMass(d6).massKg > A.combineMass(wingDoc()).massKg)
})

t('子树随对称复制：翼上挂的太阳敏在派生翼上也有一份（`~1` 挂在 `w~1` 下），位置是镜像', () => {
  const doc = wingDoc()
  doc.comps.push({ id: 'ss', type: 'sat.sensor.sun', parent: 'w', attach: { mode: 'free' }, t: [0.2, 0.3, 1.0], q: [0, 0.3, 0, 0.95] })
  const ex = A.expandSymmetry(doc)
  assert.deepStrictEqual(ex.map((e) => `${e.id}<${e.parent}`), ['bus<null', 'w<bus', 'w~1<bus', 'ss<w', 'ss~1<w~1'])
  const P = A.solvePose(doc)
  const a = Array.from(P.get('ss').m).slice(12, 15), b = Array.from(P.get('ss~1').m).slice(12, 15)
  nearV(b, [a[0], -a[1], a[2]], 1e-12, '镜像位置')
  assert.equal(P.get('ss~1').mode, 'plane')
  const r = A.buildAssembly(doc)
  assert.ok(r.attachPoints.some((x) => x.name === 'ss-1_boresight'))
  nearV(apOf(r, 'ss-1_boresight').dirBody, apOf(r, 'ss_boresight').dirBody.map((x, k) => (k === 1 ? -x : x)), 1e-12, '视轴镜像')
})

t('组件节点层级：根 → 组件节点（本体系位姿）→ 几何节点；部件 / 关节名由组件 id 派生，显示名只进 extras', () => {
  const doc = wingDoc(); doc.comps[1].name = '南翼'; doc.comps[1].material = 'mli_black'
  const r = A.buildAssembly(doc)
  const wi = nodeIdx(r.ir, 'w'), ci = nodeIdx(r.ir, 'w_wing_1_cells')
  assert.equal(r.ir.nodes[wi].parent, 0); assert.equal(r.ir.nodes[ci].parent, wi)
  assert.deepStrictEqual(r.ir.nodes[wi].extras, { asmComp: 'w', type: 'sat.wing', asmName: '南翼' })
  assert.equal(r.ir.materials[r.ir.meshes[r.ir.nodes[ci].mesh].material].key, 'mli_black', '组件材质覆盖')
  assert.ok(r.parts.find((p) => p.id === 'w_wing').name.startsWith('南翼'))
  assert.equal(r.ir.nodes[nodeIdx(r.ir, 'w_axis')].parent, 0, '挂点节点挂根下')
  const renamed = JSON.parse(JSON.stringify(doc)); renamed.comps[1].name = '北翼'
  const r2 = A.buildAssembly(renamed)
  assert.deepStrictEqual(r2.attachPoints.map((a) => a.name), r.attachPoints.map((a) => a.name), '改显示名挂点名不变')
  assert.deepStrictEqual(r2.articulations, r.articulations)
})

t('buildComponent：单件局部 IR / 插座 / 面 / 挂点（编辑器缓存与 ghost）', () => {
  const c = A.buildComponent('sat.reflector', { diameterM: 1.5 })
  assert.ok(validateIR(c.ir).ok)
  assert.deepStrictEqual(c.sockets.map((s) => s.id), ['back', 'focus'])
  assert.deepStrictEqual(c.symmetricPlanes, ['xz'])
  assert.ok(c.massKg > 0 && c.attachPoints[0].name === 'focus')
  assert.ok(c.ir.nodes.some((x) => x.name === 'feed'))
  const b = A.buildComponent('sat.bus.box')
  assert.equal(b.faces.length, 6); assert.equal(b.sockets.length, 6)
  assert.throws(() => A.buildComponent('sat.nope'), (e) => e.code === 'SPEC_INVALID')
  assert.throws(() => A.buildComponent('prim.box', { xM: 0 }), (e) => e.code === 'SPEC_INVALID')
})

console.log(`modelAssembly: ${n} 项通过`)
