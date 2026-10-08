// 驱动装配件（packages/core/models/drive.mjs，模型工作台「设计」页快速设置层）单测。
//
// ① 新建：全部 12 个整星模板都能建成驱动装配件，组件与 specToAssembly 逐件相同（id / 参数 / 位姿），列表条目全带 uid，
//    buildAssembly 质量与 paramBus 原模型一致；旧数据（不带 uid）的组件 id 与加 uid 之前逐位相同。
// ② 三方合并：改驱动参数后，用户没碰过的件 / 字段跟新基线走，改写（参数 / 面上位置 / 材质 / 名称）保留，删过的基线件继续删着，
//    用户件保留；删中间一副反射面不让后面的件继承别人的改写（稳定序号）；关联件（展开臂 / 馈源支架 / 天线塔）随驱动参数重排。
// ③ 失效挂点：挂在被删反射面下的用户件改挂根件、世界位姿不变（< 1e-9）。
// ④ 直写：联动参数（平台尺寸 / 翼板数 / 镜像翼转角 / 反射面口径与型式 / 包覆）写回 spec；非联动或写完不合法 → null。
// ⑤ 删除映射、标记（link / over / user / pose）、恢复驱动值、解除驱动、目标质量与密度三方。
// 不联网。

import assert from 'node:assert/strict'
import * as A from '../models/assembly.mjs'
import * as D from '../models/drive.mjs'
import { templateSpec, TEMPLATE_IDS, DEFAULT_TEMPLATE_ID } from '../models/paramTemplates.mjs'
import { buildParamModel, validateSpec } from '../models/paramBus.mjs'
import * as S from '../models/asmSnap.mjs'
import { getComponent, fillParams } from '../models/components/index.mjs'
import { quatCanonical } from '../models/bodyFrame.mjs'
import * as Q from '../../../src/model/quickLogic.js'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（容差 ${tol}）`)
const clone = (o) => JSON.parse(JSON.stringify(o))
const byId = (doc, id) => doc.comps.find((c) => c.id === id)
const ids = (doc) => doc.comps.map((c) => c.id)
const spec0 = () => clone(D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID }).drive.spec)

t('新建：12 个模板都能建驱动装配件，组件与 specToAssembly 逐件相同、质量与 paramBus 一致', () => {
  for (const id of TEMPLATE_IDS) {
    const doc = D.newDrivenDoc({ templateId: id })
    assert.ok(D.isDriven(doc), id)
    assert.equal(doc.drive.templateId, id)
    assert.ok(A.validateAssembly(doc).ok, id)
    const plain = A.specToAssembly(templateSpec(id).spec)
    assert.deepEqual(ids(doc), ids(plain), `${id} 组件 id`)
    for (const c of plain.comps) assert.deepEqual(byId(doc, c.id), c, `${id}.${c.id}`)
    for (const k of D.DRIVE_LISTS) for (const it of doc.drive.spec[k] || []) assert.ok(Number.isInteger(it.uid) && it.uid > 0, `${id} ${k} uid`)
    const r = A.buildAssembly(doc), p = buildParamModel(doc.drive.spec)
    near(r.massProps.massKg, p.massProps.massKg, 1e-6 * p.massProps.massKg, `${id} 质量`)
  }
})

t('旧数据不带 uid：组件 id 与加 uid 之前一致（refl1… / wing1 / sup1 / arm1a）', () => {
  const doc = A.specToAssembly(templateSpec(DEFAULT_TEMPLATE_ID).spec)
  for (const id of ['bus', 'wing1', 'tower', 'refl1', 'refl2', 'refl3', 'refl4', 'sup1', 'arm1a', 'hinge1']) assert.ok(byId(doc, id), id)
})

t('三方合并：驱动变化跟进、改写保留、删过的继续删、用户件保留', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  byId(doc, 'refl1').params.shellM = 0.05                        // 非联动参数改写
  byId(doc, 'horn2').attach.uv = [0.3, -0.2]                      // 面上位置改写
  byId(doc, 'lae').material = 'titanium'
  byId(doc, 'rcs1').name = '一号推力器'
  doc.comps = doc.comps.filter((c) => c.id !== 'rcs5')            // 删一个基线件
  doc.comps.push({ id: 'c1', type: 'sat.feed.horn', parent: 'bus', attach: { mode: 'surface', face: '-Z', uv: [0.4, 0.4] }, params: { apertureM: 0.2 } })
  doc = A.normalizeAssembly(doc)
  const s1 = clone(doc.drive.spec)
  s1.bus.xM = 2.8
  const r = D.rebaseDrive(doc, s1)
  assert.ok(r.ok, r.error)
  const d = r.doc
  assert.equal(byId(d, 'bus').params.xM, 2.8)
  assert.equal(byId(d, 'refl1').params.shellM, 0.05)
  // 面上位置改写保留，但随父件面尺寸等比换算（星体 X 2.36 → 2.8：u 跟着放大，v 不变；同普通装配件改参数，排查 #12）
  near(byId(d, 'horn2').attach.uv[0], 0.3 * 2.8 / 2.36, 1e-9, 'horn2 u'); assert.equal(byId(d, 'horn2').attach.uv[1], -0.2)
  assert.equal(byId(d, 'lae').material, 'titanium')
  assert.equal(byId(d, 'rcs1').name, '一号推力器')
  assert.equal(byId(d, 'rcs5'), undefined)
  assert.ok(byId(d, 'c1'))
  // 没碰过的件跟新基线：rcs2 的面上位置随平台加宽外移
  const plain = A.normalizeAssembly(A.specToAssembly(r.doc.drive.spec))
  assert.deepEqual(byId(d, 'rcs2').attach, byId(plain, 'rcs2').attach)
  assert.deepEqual(byId(d, 'refl3'), byId(plain, 'refl3'))
  assert.ok(A.validateAssembly(d).ok)
})

t('稳定序号：删掉第 2 副反射面，第 3 副的改写不串到别的件上', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const uid3 = doc.drive.spec.reflectors[2].uid
  byId(doc, `refl${uid3}`).params.shellM = 0.07
  doc = A.normalizeAssembly(doc)
  const s1 = clone(doc.drive.spec)
  s1.reflectors.splice(1, 1)
  const r = D.rebaseDrive(doc, s1)
  assert.ok(r.ok, r.error)
  assert.equal(byId(r.doc, `refl${uid3}`).params.shellM, 0.07)
  const others = r.doc.comps.filter((c) => c.type === 'sat.reflector' && c.id !== `refl${uid3}`)
  for (const c of others) assert.notEqual(c.params.shellM, 0.07, c.id)
  assert.ok(!byId(r.doc, 'refl2') && !byId(r.doc, 'sup2') && !byId(r.doc, 'arm2a'), '第 2 副及其支架 / 展开臂一起去掉')
  assert.ok(r.dropped.includes('refl2'))
})

t('加条目：新条目取新序号，不撞文档里用户手加的同名件', () => {
  let doc = D.newDrivenDoc({ templateId: 'ssl1300' })
  // 用户手加一副反射面，id 正好是下一个序号
  const nextId = `refl${doc.drive.serial}`
  doc.comps.push({ id: nextId, type: 'sat.reflector', parent: 'bus', attach: { mode: 'free' }, t: [0, 0, 3], q: [0, 0, 0, 1], params: { diameterM: 0.6 } })
  doc = A.normalizeAssembly(doc)
  const s1 = clone(doc.drive.spec)
  s1.reflectors.push({ slot: 'deck+Y', diameterM: 1.8 })   // SSL-1300 东西四个侧挂槽位已满，加在对地板
  const r = D.rebaseDrive(doc, s1)
  assert.ok(r.ok, r.error)
  assert.equal(byId(r.doc, nextId).params.diameterM, 0.6, '用户件原样')
  const newItem = r.doc.drive.spec.reflectors.at(-1)
  assert.ok(newItem.uid > doc.drive.serial - 1 && `refl${newItem.uid}` !== nextId)
  assert.equal(byId(r.doc, `refl${newItem.uid}`).params.diameterM, 1.8)
})

t('关联件随驱动参数重排：改反射面口径（直写）后展开臂 / 支架跟着变，天线塔随对地板反射面焦距重算', () => {
  const doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const u1 = doc.drive.spec.reflectors[0].uid, u3 = doc.drive.spec.reflectors[2].uid
  const s1 = D.writeThrough(doc, `refl${u1}`, { diameterM: 3.2 })
  assert.ok(s1, '口径是联动参数')
  assert.equal(s1.reflectors[0].diameterM, 3.2)
  const r = D.rebaseDrive(doc, s1)
  assert.ok(r.ok, r.error)
  assert.equal(byId(r.doc, `refl${u1}`).params.diameterM, 3.2)
  assert.notDeepEqual(byId(r.doc, `arm${u1}a`), byId(doc, `arm${u1}a`), '展开臂重排')
  const s2 = D.writeThrough(r.doc, `refl${u3}`, { focalM: 1.6 })
  const r2 = D.rebaseDrive(r.doc, s2)
  assert.ok(r2.ok, r2.error)
  assert.ok(byId(r2.doc, 'tower').params.hM > byId(r.doc, 'tower').params.hM, '塔高随焦距加长')
})

t('失效挂点：挂在被删反射面上的用户件改挂根件、世界位姿不变', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const u2 = doc.drive.spec.reflectors[1].uid
  doc.comps.push({ id: 'c7', type: 'sat.feed.horn', parent: `refl${u2}`, attach: { mode: 'free' }, t: [0.1, 0.2, 0.9], q: [0, 0, 0.3826834323650898, 0.9238795325112867], params: { apertureM: 0.15 } })
  doc = A.normalizeAssembly(doc)
  const m0 = A.solvePose(doc).get('c7').m
  const del = D.driveRemove(doc, [`refl${u2}`])
  assert.ok(del && del.rest.length === 0)
  assert.equal(del.spec.reflectors.length, 3)
  const r = D.rebaseDrive(doc, del.spec)
  assert.ok(r.ok, r.error)
  const c7 = byId(r.doc, 'c7')
  assert.equal(c7.parent, 'bus'); assert.equal(c7.attach.mode, 'free')
  assert.deepEqual(r.rehomed, ['c7'])
  const m1 = A.solvePose(r.doc).get('c7').m
  for (let i = 0; i < 16; i++) near(m1[i], m0[i], 1e-9, `c7 位姿[${i}]`)
})

t('直写：平台尺寸 / 镜像翼（两翼 + 转角取反）/ 型式 / 包覆；非联动或不合法 → null', () => {
  const doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const s = D.writeThrough(doc, 'bus', { yM: 2.4 })
  assert.equal(s.bus.yM, 2.4)
  const w = D.writeThrough(doc, 'wing1', { panels: 5, tiltDeg: 10 })
  assert.equal(w.wings[0].panels, 5); assert.equal(w.wings[1].panels, 5)
  assert.equal(w.wings[0].tiltDeg, 10); assert.equal(w.wings[1].tiltDeg, -10, '镜像 XZ：−Y 翼转角取反')
  const u1 = doc.drive.spec.reflectors[0].uid
  assert.equal(D.writeThrough(doc, `refl${u1}`, { surface: 'mesh' }).reflectors[0].mesh, true)
  const m = D.writeThrough(doc, 'bus', { mli: 'none' })
  assert.equal(m.detail.mli, false)
  const m2 = D.writeThrough(doc, 'bus', { mli: 'mli_silver' })
  assert.equal(m2.bus.mli, 'mli_silver'); assert.equal(m2.detail.mli, true)
  assert.equal(D.writeThrough(doc, `refl${u1}`, { shellM: 0.03 }), null, '细节档参数不联动')
  assert.equal(D.writeThrough(doc, `refl${u1}`, { diameterM: 3, shellM: 0.03 }), null, '混了非联动键整体不直写')
  assert.equal(D.writeThrough(doc, `refl${u1}`, { feed: 'none' }), null, 'spec 不支持的馈电型式')
  assert.equal(D.writeThrough(doc, 'rcs1', { exitDM: 0.1 }), null)
  assert.ok(validateSpec(w).ok)
})

t('删除映射：反射面 / 对称翼（派生件按主件）对应 spec 条目，其余件留给调用方', () => {
  const doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const u4 = doc.drive.spec.reflectors[3].uid
  const r = D.driveRemove(doc, ['wing1~1', `refl${u4}`, 'rcs3'])
  assert.equal(r.spec.wings.length, 0)
  assert.equal(r.spec.reflectors.length, 3)
  assert.deepEqual(r.rest, ['rcs3'])
  assert.equal(D.driveRemove(doc, ['rcs3', 'horn1']), null)
  const rb = D.rebaseDrive(doc, r.spec)
  assert.ok(rb.ok, rb.error)
  assert.ok(!byId(rb.doc, 'wing1') && !byId(rb.doc, `refl${u4}`) && !byId(rb.doc, `sup${u4}`))
})

t('标记与恢复：link / over / pose / user；恢复参数 / 位置 / 整件', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const u1 = doc.drive.spec.reflectors[0].uid
  byId(doc, `refl${u1}`).params.shellM = 0.05
  byId(doc, 'horn1').attach.uv = [0.1, 0.1]
  doc.comps.push({ id: 'c1', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+X', uv: [0, 0] }, params: {} })
  doc = A.normalizeAssembly(doc)
  const mk = D.driveMarks(doc)
  assert.equal(mk[`refl${u1}`].params.diameterM, 'link')
  assert.equal(mk[`refl${u1}`].params.shellM, 'over')
  assert.equal(mk.horn1.attach, true)
  assert.equal(mk.c1.user, true)
  assert.equal(mk.bus.params.xM, 'link')
  const d1 = D.resetToBase(doc, `refl${u1}`, 'shellM')
  assert.notEqual(byId(d1, `refl${u1}`).params.shellM, 0.05)
  const d2 = D.resetToBase(doc, 'horn1', 'pose')
  assert.deepEqual(byId(d2, 'horn1').attach, byId(D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID }), 'horn1').attach)
  assert.equal(D.resetToBase(doc, 'c1', 'all'), null, '用户件没有驱动值')
  assert.equal(D.resetToBase(doc, 'bus', 'xM'), null, '没改过就没什么可恢复')
})

t('目标质量与密度：没改过的跟驱动、改过的留着；解除驱动后是普通装配件', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  assert.equal(doc.massTargetKg, 5550)
  const s1 = clone(doc.drive.spec); s1.massTargetKg = 6000; s1.density = { panelAreal: 2 }
  let r = D.rebaseDrive(doc, s1)
  assert.equal(r.doc.massTargetKg, 6000); assert.equal(r.doc.density.panelAreal, 2)
  doc = A.normalizeAssembly({ ...r.doc, massTargetKg: 6200, density: { panelAreal: 2.5 } })
  const s2 = clone(doc.drive.spec); s2.massTargetKg = 6500; s2.density = { panelAreal: 3 }
  r = D.rebaseDrive(doc, s2)
  assert.equal(r.doc.massTargetKg, 6200, '属性面板改过的目标质量保留')
  assert.equal(r.doc.density.panelAreal, 2.5)
  const plain = D.detachDrive(r.doc)
  assert.ok(!D.isDriven(plain) && !('drive' in plain))
  assert.deepEqual(plain.comps, r.doc.comps)
})

t('非法驱动参数：不改文档、报错短语；不是驱动装配件的文档 normalizeAssembly 不带 drive 键', () => {
  const doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const s1 = clone(doc.drive.spec); s1.bus.xM = -1
  const r = D.rebaseDrive(doc, s1)
  assert.equal(r.ok, false); assert.ok(/bus\.xM/.test(r.error))
  const plain = A.normalizeAssembly({ kind: 'assembly', domain: 'spacecraft', comps: [] })
  assert.ok(!('drive' in plain))
  const ground = A.normalizeAssembly({ kind: 'assembly', domain: 'ground', comps: [], drive: { kind: 'sat', spec: spec0() } })
  assert.ok(!('drive' in ground), '只有卫星领域能带整星驱动')
  assert.throws(() => D.newDrivenDoc({ templateId: 'nope' }), (e) => e.code === 'SPEC_INVALID')
})

// ───────────────────────── v1.5.0 上线前排查（2026-10-08）#11 / #12 / #20 / #21 / #41 ─────────────────────────

t('#11 连续改反射面口径：没碰过的件不被误判「位置改写」、展开臂朝向跟新基线；quatCanonical 归一幂等', () => {
  let seed = 11
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let k = 0; k < 20000; k++) {
    const q = quatCanonical([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5])
    assert.deepEqual(quatCanonical(q), q, '归一结果再归一逐位不变')
  }
  // 审查实测（改前）：口径 1.6 / 2.2 / 3.0 / 3.6 m 时 arm1a 被判位置改写、与基线夹角 4.1° / 8.0° / 12.9° / 16.4°
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  for (const [i, dm] of [[0, 1.0], [0, 1.6], [0, 2.2], [0, 3.0], [0, 3.6], [1, 1.9], [3, 0.9]]) {
    const r = D.rebaseDrive(doc, Q.setReflValue(doc.drive.spec, i, 'diameterM', dm))
    assert.ok(r.ok, r.error)
    doc = A.normalizeAssembly(JSON.parse(JSON.stringify(A.normalizeAssembly(r.doc))))   // 编辑器 replaceDoc + 撤销栈 / 草稿读回
    const nb = D.driveBase(doc.drive.spec), mk = D.driveMarks(doc)
    const posed = Object.entries(mk).filter(([, m]) => m.pose || m.attach).map(([id]) => id)
    assert.deepEqual(posed, [], `口径 ${dm}：被判位置改写 ${posed.join(' ')}`)
    for (const c of doc.comps) {
      const n = nb.byId.get(c.id)
      if (n && n.q) for (let k = 0; k < 4; k++) near(c.q[k], n.q[k], 1e-12, `口径 ${dm} ${c.id}.q`)
    }
  }
})

t('#12 改星体尺寸：面上用户件（与 uv 改写过的基线件）按新旧面半宽等比换算、夹在面内——与普通装配件 setParams 同值', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const face = (d, id, fid) => { const c = byId(d, id), def = getComponent(c.type); return def.faces(fillParams(def, c.params)).find((f) => f.id === fid) }
  const f0 = face(doc, 'bus', '+X')
  const r0 = S.addComp(doc, { type: 'sat.sensor.star', parent: 'bus', attach: { mode: 'surface', face: '+X', uv: [0.9 * f0.halfU, 0.8 * f0.halfV] } })
  assert.ok(r0.ok, r0.error)
  doc = r0.doc
  const sid = r0.id
  const rb = D.rebaseDrive(doc, Q.setSpecValue(Q.setSpecValue(doc.drive.spec, 'bus.yM', 1.4), 'bus.zM', 2.0))
  assert.ok(rb.ok, rb.error)
  const f1 = face(rb.doc, 'bus', '+X'), uv = byId(rb.doc, sid).attach.uv
  assert.ok(Math.abs(uv[0]) <= f1.halfU + 1e-12 && Math.abs(uv[1]) <= f1.halfV + 1e-12, `星敏在面内：${uv} / ${f1.halfU} × ${f1.halfV}（改前悬出 0.6 m）`)
  const plain = S.applyCmd(D.detachDrive(doc), { type: 'setParams', id: 'bus', params: { yM: 1.4, zM: 2.0 } })
  assert.deepEqual(uv, byId(plain.doc, sid).attach.uv, '与普通装配件改参数同一换算')
  // 没碰过的基线件仍跟新基线（新基线按新尺寸生成，不再换算一遍）
  const base = D.driveBase(rb.doc.drive.spec).byId.get('horn1')
  assert.deepEqual(byId(rb.doc, 'horn1').attach, base.attach)
})

t('#20 用户件 id 撞上新基线才生成的件：用户件改名不被认领，之后驱动参数再变也不会被当生成件删掉', () => {
  // generic 没有天线塔：用户先在 −Z 面拖一座塔（id tower），塔顶挂星敏；再在快速设置加一副对地板反射面（新基线生成 tower）
  let doc = D.newDrivenDoc({ templateId: 'generic' })
  let r = S.addComp(doc, { type: 'sat.tower', parent: 'bus', attach: { mode: 'surface', face: '-Z', uv: [0.3, 0] } })
  assert.equal(r.id, 'tower')
  doc = r.doc
  r = S.addComp(doc, { type: 'sat.sensor.star', parent: 'tower', attach: { mode: 'socket', socket: 'top' } })
  doc = r.doc
  const star = r.id
  const a = Q.addReflector(doc.drive.spec)
  let rb = D.rebaseDrive(doc, a.spec)
  assert.ok(rb.ok, rb.error)
  doc = rb.doc
  const i = doc.drive.spec.reflectors.length - 1
  rb = D.rebaseDrive(doc, Q.setReflValue(doc.drive.spec, i, 'slot', 'deck+Y'))
  assert.ok(rb.ok, rb.error)
  assert.equal(rb.renamed.length, 1)
  const [oldId, newId] = rb.renamed[0]
  assert.equal(oldId, 'tower'); assert.notEqual(newId, 'tower')
  doc = rb.doc
  const mine = byId(doc, newId)
  assert.ok(mine && mine.type === 'sat.tower' && mine.attach.face === '-Z', '用户塔原样留在 −Z 面')
  assert.equal(byId(doc, star).parent, newId, '星敏跟着改名后的塔')
  assert.ok(D.driveMarks(doc)[newId].user, '仍是用户件')
  assert.equal(byId(doc, 'tower').attach.face === '-Z', false, 'tower 是新基线的塔')
  // 删掉这副反射面：基线的塔没了，用户的塔与星敏都还在
  rb = D.rebaseDrive(doc, Q.removeReflector(doc.drive.spec, i))
  assert.ok(rb.ok, rb.error)
  assert.ok(rb.dropped.includes('tower') && !rb.dropped.includes(newId))
  assert.ok(byId(rb.doc, newId) && byId(rb.doc, star) && byId(rb.doc, star).parent === newId)
  // 编辑器起新 id 时避开当前基线的件 id——包括被用户删掉的（默认卫星删掉基线天线塔后再拖一座塔进来：不能拿 tower）
  const d0 = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const cut = { ...d0, comps: d0.comps.filter((c) => c.id !== 'tower' && c.parent !== 'tower') }
  assert.equal(D.suppressedIds(cut).includes('tower'), true)
  assert.notEqual(S.compIdFor(cut, 'sat.tower'), 'tower', '基线（含已删）的 id 不给新件')
  assert.equal(S.compIdFor(D.detachDrive(cut), 'sat.tower'), 'tower', '普通装配件照旧')
})

t('#21 挪过位置的反射面改「安装位置」：驱动换了锚 → 安装量整套跟新基线（不落进星体）；同锚的改写照旧保留', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const c3 = byId(doc, 'refl3')
  assert.equal(c3.parent, 'tower')
  doc = S.applyCmd(doc, { type: 'setAttach', id: 'refl3', attach: c3.attach, t: [c3.t[0] + 0.2, c3.t[1], c3.t[2]], q: c3.q }).doc
  const i3 = doc.drive.spec.reflectors.findIndex((x) => x.uid === 3)
  const rb = D.rebaseDrive(doc, Q.setReflValue(doc.drive.spec, i3, 'slot', '+X2'))
  assert.ok(rb.ok, rb.error)
  const base = D.driveBase(rb.doc.drive.spec).byId.get('refl3'), m3 = byId(rb.doc, 'refl3')
  assert.equal(m3.parent, base.parent); assert.deepEqual(m3.attach, base.attach)
  for (let k = 0; k < 3; k++) near(m3.t[k], base.t[k], 1e-12, 't'); for (let k = 0; k < 4; k++) near(m3.q[k], base.q[k], 1e-12, 'q')
  // 同一锚上的改写（挪过的 refl1，驱动只改口径）：用户的 t 留着
  let d2 = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const c1 = byId(d2, 'refl1')
  const t1 = [c1.t[0] + 0.15, c1.t[1], c1.t[2]]
  d2 = S.applyCmd(d2, { type: 'setAttach', id: 'refl1', attach: c1.attach, t: t1, q: c1.q }).doc
  const rb2 = D.rebaseDrive(d2, Q.setReflValue(d2.drive.spec, 0, 'diameterM', 2.0))
  assert.ok(rb2.ok, rb2.error)
  for (let k = 0; k < 3; k++) near(byId(rb2.doc, 'refl1').t[k], t1[k], 1e-12, '同锚改写保留')
  assert.ok(D.driveMarks(rb2.doc).refl1.pose)
})

t('#41 全部恢复 / 恢复本件：隐藏与锁定留着、锁定件不动；「对称」项能单独恢复', () => {
  let doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const ap = (c) => { const r = S.applyCmd(doc, c); assert.ok(r.ok, r.error); doc = r.doc }
  ap({ type: 'setHidden', ids: ['horn1', 'wing1'], on: true })
  ap({ type: 'setMaterial', id: 'lae', material: 'titanium' })
  ap({ type: 'setLocked', ids: ['lae'], on: true })
  ap({ type: 'setParams', id: 'refl2', params: { shellM: 0.05 } })
  ap({ type: 'setMaterial', id: 'horn1', material: 'titanium' })
  const all = D.resetAllOverrides(doc)
  assert.ok(all)
  assert.equal(byId(all, 'horn1').hidden, true); assert.equal(byId(all, 'wing1').hidden, true)
  assert.equal(byId(all, 'horn1').material, null, '改写恢复了')
  assert.equal(byId(all, 'refl2').params.shellM, D.driveBase(all.drive.spec).byId.get('refl2').params.shellM)
  assert.equal(byId(all, 'lae').locked, true); assert.equal(byId(all, 'lae').material, 'titanium', '锁定件不动')
  assert.equal(D.resetToBase(doc, 'lae', 'material'), null, '锁定件单项恢复也不动')
  const one = D.resetToBase(doc, 'horn1', 'all')
  assert.equal(byId(one, 'horn1').hidden, true); assert.equal(byId(one, 'horn1').material, null)
  // 对称：给 horn1 加镜像、去掉 wing1 的镜像 → 「对称」项各自恢复
  ap({ type: 'setSym', id: 'horn1', sym: { op: 'mirrorXZ' } })
  ap({ type: 'setSym', id: 'wing1', sym: null })
  const mk = D.driveMarks(doc)
  assert.ok(mk.horn1.sym && mk.wing1.sym)
  const h = D.resetToBase(doc, 'horn1', 'sym'), w = D.resetToBase(doc, 'wing1', 'sym')
  assert.ok(h && w, '对称项有恢复结果')
  assert.equal(byId(h, 'horn1').sym, null)
  assert.deepEqual(byId(w, 'wing1').sym, D.driveBase(w.drive.spec).byId.get('wing1').sym)
  assert.equal(D.driveMarks(w).wing1.sym, false)
})

t('合并性能：整星（36 件）改一次驱动参数 < 30 ms', () => {
  const doc = D.newDrivenDoc({ templateId: DEFAULT_TEMPLATE_ID })
  const s1 = clone(doc.drive.spec)
  let best = Infinity
  for (let i = 0; i < 5; i++) {
    s1.bus.zM = 3.6 + 0.01 * (i + 1)
    const t0 = performance.now()
    const r = D.rebaseDrive(doc, s1)
    best = Math.min(best, performance.now() - t0)
    assert.ok(r.ok)
  }
  assert.ok(best < 30, `${best.toFixed(1)} ms`)
})

console.log(`modelDrive: ${n} 项通过`)
