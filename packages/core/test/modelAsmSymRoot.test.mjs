// 装配对称判据 / 换根 / 改尺寸跟随 / 生成缓存分层 / 哈希快算（P3 修复轮 rv2）单测。
//
// ① 对称副本与原件重合按几何判（onSymLocus + componentBox）：飞机机翼原点在机身中线（y = 0）、几何整个在一侧 → 镜像 XZ 照收
//    （拖入 ghost / 快速添加 / M / 属性面板四条路都是这一个判据：ghost 与快速添加用组件包围盒 + 解算位姿、M 与属性面板走 applyCmd setSym）；
//    反射面装在平台体 +X 插座上（几何对 XZ 面对称）仍拒收；径向同理。实体模板里的对称件一律不判重合，去掉对称后能再镜像回来。
// ② 换位类命令（setAttach / setMode / reparent）把带对称的件挪到对称面上 → 同一条命令里去掉对称（symDropped），质量不多一份。
// ③ setRoot：对称面 / 轴按新本体系重述（映不上的同一条命令拆分）；全部展开件（含 ~k 与拆分出的副本）世界位姿 = inv(P0[新根])·P0，误差 ≤ 1e-9；
//    目标质量的余量汇点与根解耦，换根后总质量不变。
// ④ setParams：父件面缩小，贴面子件 uv 按新旧半宽等比换算、仍在面内；带面锚的自由件跟着走。
// ⑤ 目标质量：没有平台体（地球站）时告警「未生效」；质量汇点不要求是根件。
// ⑥ 模块级生成缓存分两层：componentBox = buildComponent 包围盒；重层按字节限额；clearBuildCache 清空。
// ⑦ fnv1a64Hex（16 位分量写法）与 BigInt 参考实现逐位相同（含多字节 UTF-8、代理对、孤立代理项）。
// 不联网。

import assert from 'node:assert/strict'
import * as S from '../models/asmSnap.mjs'
import * as A from '../models/assembly.mjs'
import { fnv1a64Hex, canon } from '../models/paramBus.mjs'
import { templateSpec, DEFAULT_TEMPLATE_ID } from '../models/paramTemplates.mjs'
import { ENTITY_TEMPLATE_IDS, entityTemplateDoc } from '../models/entityTemplates.mjs'
import { getComponent, fillParams } from '../models/components/index.mjs'
import * as L from '../../../src/model/asmLogic.js'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（容差 ${tol}）`)
const nearM = (a, b, tol, msg) => { for (let i = 0; i < 16; i++) near(a[i], b[i], tol, `${msg}[${i}]`) }
const docOf = (comps, domain = 'spacecraft', extra = {}) => A.normalizeAssembly({ domain, comps, ...extra })
const poses = (doc) => { const m = new Map(); for (const [id, p] of A.solvePose(doc)) m.set(id, Float64Array.from(p.m)); return m }
const box6 = (type, params) => { const b = A.buildComponent(type, params || {}).bbox; return [...b.min, ...b.max] }
const BUS = { id: 'bus', type: 'sat.bus.box', parent: null }
const FUS = { id: 'fus', type: 'air.fuselage', parent: null }
const WING = { id: 'wing', type: 'air.wing', parent: 'fus', attach: { mode: 'socket', socket: 'wing' } }

// ═════════════════════════ ① 几何判据 ═════════════════════════

t('机翼装在机身 wing 插座（原点在中线）：镜像 XZ 四条路都接受；副本在另一侧', () => {
  const d0 = docOf([FUS, WING], 'aircraft')
  const pm = A.solvePose(d0).get('wing').m
  near(pm[13], 0, 1e-12, '机翼原点在对称面上')
  // ghost / 快速添加：组件包围盒 + 解算位姿
  assert.equal(S.onSymLocus({ op: 'mirrorXZ' }, pm, box6('air.wing')), false, '几何在一侧：不重合')
  assert.equal(S.onSymLocus({ op: 'mirrorXZ' }, pm), true, '不给包围盒退回原点判据（旧口径）')
  // 属性面板 / M：applyCmd setSym
  const r = S.applyCmd(d0, { type: 'setSym', id: 'wing', sym: { op: 'mirrorXZ' } })
  assert.ok(r.ok, r.error)
  assert.deepEqual(S.compById(r.doc, 'wing').sym, { group: 'wing', op: 'mirrorXZ' })
  // 派生翼是钩子件（镜像参数重生成）：几何中心按它自己的包围盒 × 派生位姿算
  const P = A.solvePose(r.doc), def = getComponent('air.wing'), p0 = fillParams(def, {})
  const cy = (m, B) => { const b = new Float64Array(6); S.boxXform(B, 0, m, 0, b, 0); return (b[1] + b[4]) / 2 }
  assert.equal(P.get('wing~1').mode, 'hook')
  const y0 = cy(P.get('wing').m, box6('air.wing')), y1 = cy(P.get('wing~1').m, box6('air.wing', def.mirror(p0, P.get('wing~1').plane)))
  assert.ok(y0 * y1 < 0, `两只翼分在中线两侧：${y0} / ${y1}`)
  near(y0, -y1, 1e-9, '关于中线对称')
  assert.ok(Math.abs(y0) > 1, '翼的几何中心离中线一米以上')
  // 拖入 / 快速添加直接带对称加件
  const a = S.addComp(docOf([FUS], 'aircraft'), { type: 'air.wing', parent: 'fus', attach: { mode: 'socket', socket: 'wing' }, sym: { op: 'mirrorXZ' } })
  assert.ok(a.ok && !S.symCoincides(a.doc, S.compById(a.doc, a.id)))
})

t('反射面装在平台体 +X 插座（几何对 XZ 面对称）：镜像 XZ 仍拒收（code onLocus）；YZ 照收', () => {
  const d = docOf([BUS, { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+X' } }])
  const r = S.applyCmd(d, { type: 'setSym', id: 'refl', sym: { op: 'mirrorXZ' } })
  assert.equal(r.ok, false); assert.equal(r.error, '件在对称面上。'); assert.equal(r.code, 'onLocus')
  assert.ok(S.applyCmd(d, { type: 'setSym', id: 'refl', sym: { op: 'mirrorYZ' } }).ok)
  // 径向：+Z 插座上的推力器在 +Z 轴上 → 拒收；+X 插座上的离轴 → 照收
  const dz = docOf([BUS, { id: 'thr', type: 'sat.thruster', parent: 'bus', attach: { mode: 'socket', socket: '+Z' } }])
  const rz = S.applyCmd(dz, { type: 'setSym', id: 'thr', sym: { op: 'radial', n: 4 } })
  assert.equal(rz.error, '件在对称轴上。'); assert.equal(rz.code, 'onLocus')
  const dx = docOf([BUS, { id: 'thr', type: 'sat.thruster', parent: 'bus', attach: { mode: 'socket', socket: '+X' } }])
  assert.ok(S.applyCmd(dx, { type: 'setSym', id: 'thr', sym: { op: 'radial', n: 4 } }).ok)
})

t('实体模板：对称件一律不判重合；去掉对称后能再镜像回来', () => {
  let nSym = 0
  for (const id of ENTITY_TEMPLATE_IDS) {
    const d = A.normalizeAssembly(entityTemplateDoc(id).doc)
    for (const c of d.comps) {
      if (!c.sym) continue
      nSym++
      assert.equal(S.symCoincides(d, c), false, `${id} ${c.id}`)
      const off = S.applyCmd(d, { type: 'setSym', id: c.id, sym: null })
      assert.ok(off.ok && S.compById(off.doc, c.id).sym === null)
      const on = S.applyCmd(off.doc, { type: 'setSym', id: c.id, sym: { op: c.sym.op, n: c.sym.n, axis: c.sym.axis } })
      assert.ok(on.ok, `${id} ${c.id}：${on.error}`)
      assert.equal(A.combineMass(on.doc).massKg.toFixed(6), A.combineMass(d).massKg.toFixed(6), `${id} 质量复原`)
    }
  }
  assert.ok(nSym >= 7, `模板里的对称件 ${nSym} 个`)
})

// ═════════════════════════ ② 换位去对称 ═════════════════════════

t('setAttach / setMode 把带对称的件挪到对称面上：同一条命令去掉对称，质量不多一份', () => {
  const d = docOf([BUS, { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+Y' }, sym: { op: 'mirrorXZ' } }])
  const one = A.combineMass(docOf([BUS, { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+X' } }])).massKg
  assert.ok(A.combineMass(d).massKg > one, '+Y 上带镜像：两份')
  const r = S.applyCmd(d, { type: 'setAttach', id: 'refl', attach: { socket: '+X' } })
  assert.ok(r.ok, r.error)
  assert.deepEqual(r.symDropped, ['refl'])
  assert.equal(S.compById(r.doc, 'refl').sym, null)
  assert.equal(A.combineMass(r.doc).massKg, one, '去掉对称后只有一份')
  assert.equal(A.solvePose(r.doc).has('refl~1'), false)
  // 不在对称面上：对称照留
  const r2 = S.applyCmd(d, { type: 'setAttach', id: 'refl', attach: { roll: 30 } })
  assert.ok(r2.ok && !r2.symDropped && S.compById(r2.doc, 'refl').sym)
  // setMode：自由件切插座，最近的空闲插座在对称面上（+X）
  const df = docOf([BUS, { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'free' }, t: [1, 0.12, 0], q: [0, 0.7071067811865476, 0, 0.7071067811865476], sym: { op: 'mirrorXZ' } }])
  const r3 = S.applyCmd(df, { type: 'setMode', id: 'refl', mode: 'socket' })
  assert.ok(r3.ok, r3.error)
  assert.equal(S.compById(r3.doc, 'refl').attach.socket, '+X')
  assert.deepEqual(r3.symDropped, ['refl'])
})

// ═════════════════════════ ③ 换根 ═════════════════════════

t('setRoot：默认卫星换任一件为根，全部展开件世界位姿 = inv(P0[新根])·P0（含 ~k / 拆分副本），质量不变', () => {
  const doc = A.specToAssembly(templateSpec(DEFAULT_TEMPLATE_ID).spec)
  assert.ok(doc.massTargetKg > 0, '默认卫星带目标质量')
  const P0 = poses(doc), m0 = A.combineMass(doc).massKg
  let nSplit = 0, nKept = 0
  for (const c of doc.comps) {
    if (c.parent == null || S.inSymSubtree(doc, c.id)) continue
    const r = S.applyCmd(doc, { type: 'setRoot', id: c.id })
    assert.ok(r.ok, `${c.id}：${r.error}`)
    const inv = S.m4InvRigid(new Float64Array(16), P0.get(c.id))
    const P1 = poses(r.doc)
    const fresh = [...P1.keys()].filter((k) => !P0.has(k))
    for (const [k, m] of P0) {
      const want = S.m4Mul(new Float64Array(16), inv, m)
      if (P1.has(k)) { nearM(P1.get(k), want, 1e-9, `${c.id} → ${k}`); continue }
      // 被拆分的派生件：换成了一个新 id 的独立件，位姿一样
      assert.ok(r.split && r.split.includes(S.primaryIdOf(k)), `${c.id}：${k} 不见了`)
      const hit = fresh.find((f) => { const q = P1.get(f); for (let i = 0; i < 16; i++) if (Math.abs(q[i] - want[i]) > 1e-9) return false; return true })
      assert.ok(hit, `${c.id}：${k} 的拆分副本位姿`)
    }
    if (r.split) nSplit++; else if ([...P0.keys()].some((k) => k.includes('~'))) nKept++
    near(A.combineMass(r.doc).massKg, m0, 1e-9, `${c.id} 为根：总质量`)
    assert.deepEqual(A.combineMass(r.doc).warnings, [], `${c.id} 为根：目标质量照常生效`)
    assert.ok(A.validateAssembly(r.doc).ok)
  }
  assert.ok(nSplit > 0 && nKept > 0, `拆分 ${nSplit} 例、镜面重述 ${nKept} 例`)
  // horn1 专门看一遍（审查意见给的复现）：-Y 翼在换根后不跳
  const r = S.applyCmd(doc, { type: 'setRoot', id: 'horn1' })
  assert.ok(r.ok)
  const inv = S.m4InvRigid(new Float64Array(16), P0.get('horn1'))
  const want = S.m4Mul(new Float64Array(16), inv, P0.get('wing1~1'))
  assert.ok([...poses(r.doc).values()].some((q) => q.every((v, i) => Math.abs(v - want[i]) <= 1e-9)), '-Y 太阳翼位姿不变')
})

t('setRoot：径向对称按新本体系重述轴（带符号）；镜面换成另一个主平面', () => {
  // 平台体 +X 面上立一根杆（杆轴沿本体 +X），杆端挂 4 份径向推力器（绕本体 +X）；以杆为根：杆局部 +Z = 旧 +X
  const d = docOf([BUS,
    { id: 'boom', type: 'sat.boom', parent: 'bus', attach: { mode: 'socket', socket: '+X' } },
    { id: 'thr', type: 'sat.thruster', parent: 'bus', attach: { mode: 'free' }, t: [1.2, 0.4, 0], q: [0, 0, 0, 1], sym: { op: 'radial', n: 4, axis: '+X' } },
    { id: 'rad', type: 'prim.box', parent: 'bus', attach: { mode: 'socket', socket: '+Y' }, sym: { op: 'mirrorXZ' } }
  ])
  const P0 = poses(d)
  const r = S.applyCmd(d, { type: 'setRoot', id: 'boom' })
  assert.ok(r.ok, r.error)
  assert.equal(r.split, undefined, '都能重述、不拆分')
  const s = S.compById(r.doc, 'thr').sym
  assert.equal(s.op, 'radial'); assert.equal(s.n, 4); assert.ok(/^[+-]Z$/.test(s.axis), s.axis)
  const inv = S.m4InvRigid(new Float64Array(16), P0.get('boom'))
  const P1 = poses(r.doc)
  for (const [k, m] of P0) nearM(P1.get(k), S.m4Mul(new Float64Array(16), inv, m), 1e-9, k)
  assert.ok(['mirrorXZ', 'mirrorYZ'].includes(S.compById(r.doc, 'rad').sym.op))
})

// ═════════════════════════ ④ 改尺寸跟随 ═════════════════════════

t('setParams：平台体缩半，+Y 面上的散热板 uv 等比换算、仍在面内；带面锚的自由件跟着走', () => {
  const d = docOf([{ ...BUS, params: { xM: 2, yM: 2, zM: 3 } },
    { id: 'rad', type: 'sat.radiator', parent: 'bus', attach: { mode: 'surface', face: '+Y', uv: [1.35, 0.9] } },
    { id: 'box', type: 'prim.box', parent: 'bus', attach: { mode: 'free', face: '-Y', uv: [0.6, -0.4] }, t: [0, 0, 0.1], q: [0, 0, 0, 1] }])
  const r = S.applyCmd(d, { type: 'setParams', id: 'bus', params: { xM: 1, yM: 1, zM: 1.5 } })
  assert.ok(r.ok, r.error)
  const fy = S.compGeo(S.compById(r.doc, 'bus')).faces.find((f) => f.id === '+Y')
  const uv = S.compById(r.doc, 'rad').attach.uv
  assert.deepEqual(uv, [0.675, 0.45])
  assert.ok(Math.abs(uv[0]) <= fy.halfU && Math.abs(uv[1]) <= fy.halfV, '在面内')
  assert.deepEqual(S.compById(r.doc, 'box').attach.uv, [0.3, -0.2])
  // 世界位置：散热板贴在新 +Y 面上（y = 0.5 附近）、落在面的范围里
  const m = A.solvePose(r.doc).get('rad').m
  assert.ok(Math.abs(m[12]) <= 0.5 + 1e-9 && Math.abs(m[14]) <= 0.75 + 1e-9, `散热板 (${m[12]}, ${m[13]}, ${m[14]})`)
  // 放大回去：回到原 uv
  const r2 = S.applyCmd(r.doc, { type: 'setParams', id: 'bus', params: { xM: 2, yM: 2, zM: 3 } })
  assert.deepEqual(S.compById(r2.doc, 'rad').attach.uv, [1.35, 0.9])
})

// ═════════════════════════ ⑤ 目标质量 ═════════════════════════

t('目标质量：地球站没有平台体 → 告警「未生效」；汇点不要求是根件', () => {
  const g = A.normalizeAssembly({ ...entityTemplateDoc('ent:es-4p5').doc, massTargetKg: 9999 })
  const cm = A.combineMass(g)
  assert.equal(cm.warnings.length, 1); assert.ok(cm.warnings[0].includes('未生效'), cm.warnings[0])
  near(cm.massKg, A.combineMass(entityTemplateDoc('ent:es-4p5').doc).massKg, 1e-9, '质量不受目标影响')
  // 平台体挂在一个立方体下面（根件不是平台体）：照样吃余量
  const d = docOf([{ id: 'base', type: 'prim.box', parent: null }, { id: 'bus', type: 'sat.bus.box', parent: 'base', attach: { mode: 'socket', socket: '+Z' } }], 'spacecraft', { massTargetKg: 4000 })
  const c2 = A.combineMass(d)
  near(c2.massKg, 4000, 1e-6, '总质量 = 目标'); assert.deepEqual(c2.warnings, [])
  const b = A.buildAssembly(d)
  near(b.massProps.massKg, 4000, 1e-6, 'buildAssembly 同口径')
})

// ═════════════════════════ ⑥ 生成缓存分层 ═════════════════════════

t('生成缓存：componentBox = buildComponent 包围盒；重层按字节限额；clearBuildCache 清空', () => {
  for (const type of ['air.wing', 'sat.reflector', 'sea.hull', 'es.radome']) {
    const b = A.componentBox(type, {})
    assert.deepEqual(b, box6(type), type)
  }
  assert.equal(A.componentBox('nope.x', {}), null)
  for (const id of ENTITY_TEMPLATE_IDS) A.buildAssembly(entityTemplateDoc(id).doc)
  const st = A.buildCacheStats()
  assert.ok(st.heavyBytes <= st.heavyCap, `重层 ${st.heavyBytes} ≤ ${st.heavyCap}`)
  assert.ok(st.light > 0)
  // 轻层命中不出 IR 也能合成质量（combineMass 不要 items）
  const d = entityTemplateDoc('ent:container-14k').doc
  const m1 = A.combineMass(d).massKg
  A.clearBuildCache()
  assert.deepEqual([A.buildCacheStats().light, A.buildCacheStats().heavy, A.buildCacheStats().heavyBytes], [0, 0, 0])
  assert.equal(A.combineMass(d).massKg, m1, '清缓存后重算同值')
  assert.equal(A.buildCacheStats().heavy >= 0, true)
  // 烘焙件的轻结果：质量元与完整结果逐项一致
  const b1 = A.buildAssembly(d).massProps.massKg
  near(b1, m1, 1e-9, 'buildAssembly 与 combineMass 同值')
})

t('componentFacts / componentDensityKeys：轻层取质量 / 包围盒 / 读到的密度键，与 buildComponent 同值', () => {
  for (const type of ['sat.bus.box', 'sat.boom', 'air.fuselage', 'sea.hull', 'es.radome']) {
    const f = A.componentFacts(type, {}), b = A.buildComponent(type, {})
    near(f.massKg, b.massKg, 1e-9, type + ' 质量')
    assert.deepEqual(f.bbox, [...b.bbox.min, ...b.bbox.max], type + ' 包围盒')
  }
  assert.deepEqual(A.componentDensityKeys('sat.boom', {}), ['boomLinear'])
  assert.deepEqual(A.componentDensityKeys('sat.thruster', { kind: 'lae' }), ['laeMass'])
  assert.deepEqual(A.componentDensityKeys('no.such', {}), [])
  for (const type of ['air.fuselage', 'air.wing', 'sea.hull', 'sat.reflector']) assert.deepEqual([...L.densityKeysOf(type, {})], A.componentDensityKeys(type, {}), type + '：属性面板与生成记录同口径')
  assert.equal(A.componentFacts('sat.bus.box', { xM: -1 }), null, '参数非法 → null')
})

t('属性面板密度行：主结构体密度按领域取名（平台体 / 机体 / 船体 / 车体 / 结构）；给了 domainKeys 就不在主线程生成整个领域', () => {
  const lab = (domain) => L.densityRows({ busVolume: 300 }, { domain, comps: [] }, { domainKeys: ['busVolume'] }).find((r) => r.key === 'busVolume').label
  assert.deepEqual(['spacecraft', 'aircraft', 'ship', 'vehicle', 'ground'].map(lab), ['平台体', '机体', '船体', '车体', '结构'])
  assert.equal(L.densityRows({ busVolume: 300 }).find((r) => r.key === 'busVolume').label, '平台体', '不给文档：原口径')
  const rows = L.densityRows({}, { domain: 'aircraft', comps: [] }, { domainKeys: [] })
  assert.deepEqual(rows, [], '领域键未到、文档空、没改过：不列')
})

// ═════════════════════════ ⑦ 哈希快算 ═════════════════════════

t('fnv1a64Hex：16 位分量写法与 BigInt 参考逐位相同', () => {
  const ref = (str) => { const bytes = new TextEncoder().encode(str); let h = 0xcbf29ce484222325n; for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn } return h.toString(16).padStart(16, '0') }
  const cases = ['', 'a', '装配件', '😀x', '\ud800', 'a\udc00b', '\ud83d', 'x😀\ud800', '\u007f\u0080߿ࠀ￿']
  let r = 7
  for (let i = 0; i < 2000; i++) {
    let s = ''
    for (let j = 0; j < i % 37; j++) { r = (Math.imul(r, 1103515245) + 12345) >>> 0; const k = r % 5; s += String.fromCharCode(k === 0 ? r % 128 : k === 1 ? 0x80 + r % 0x780 : k === 2 ? 0x800 + r % 0xd000 : k === 3 ? 0xd800 + r % 0x800 : 0xe000 + r % 0x2000) }
    cases.push(s)
  }
  for (const c of cases) assert.equal(fnv1a64Hex(c), ref(c), JSON.stringify(c))
  const doc = A.specToAssembly(templateSpec(DEFAULT_TEMPLATE_ID).spec)
  assert.equal(A.asmHash(doc), ref(canon(A.normalizeAssembly(doc))), 'asmHash 与参考实现同值')
})

console.log(`modelAsmSymRoot: ${n} 项通过`)
