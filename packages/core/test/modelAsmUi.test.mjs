// 装配页 UI 纯逻辑单测（契约 scratchpad p3/CONTRACT.md §9.1「modelAsmUi」）：
//   wbLogic 新分段 / 类别 / entryFacts.asm·ent；asmLogic 的参数行模型（四类 ParamSpec → 控件、占位、title 三行、描红两条判据）、
//   结构树扁平化（深度、折叠、派生不列、角标计数、祖先对称、坏文档容错）、草稿取舍、工具状态清洗、组件库分组 / 搜索、
//   插座 / 面 / 安装插座选项、拆分对称判据、自由件位姿反算（本体系 ↔ 相对父件）。
// 裸 node 跑：asmLogic.js / wbLogic.js 只 import packages/core（相对路径），不碰 three / vue / DOM。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(path.join(HERE, p)).href)
const W = await imp('../../../src/model/wbLogic.js')
const L = await imp('../../../src/model/asmLogic.js')
const C = await imp('../models/components/index.mjs')
const A = await imp('../models/assembly.mjs')
const BF = await imp('../models/bodyFrame.mjs')
const PB = await imp('../models/paramBus.mjs')
const PKG = { E: await imp('../models/entityTemplates.mjs') }

let n = 0
const ok = (name, fn) => { try { fn() } catch (e) { console.error('✗ ' + name); throw e } n++ }
const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`)
const nearV = (a, b, tol = 1e-9, msg = '') => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => near(x, b[i], tol, msg + '[' + i + ']')) }

// ─────────────────────────── wbLogic：分段 / 类别 / 条目事实 ───────────────────────────
const ASM_E = { id: 'asm:0123456789ab', origin: 'user', title: '卫星装配件', source: { kind: 'user' }, local: { lod0: 'ready' }, kind: 'spacecraft' }
const ENT_E = { id: 'ent:a320neo', origin: 'entTemplate', tplOrder: 100, title: 'Airbus A320neo', titleZh: '空客 A320neo', source: { kind: 'builtin' }, local: {}, kind: 'aircraft', group: 'aircraft', tags: ['entity', 'aircraft'] }
const TPL_E = { id: 'param:default-sat', origin: 'template', tplOrder: 0, titleZh: '默认卫星', source: { kind: 'param' }, local: {}, group: 'spacecraft' }
ok('分段：「装配」在「参数化」之后；类别补飞机 / 船舶 / 车辆（其他仍在最后）', () => {
  const keys = W.SEGMENTS.map((s) => s.key)
  assert.equal(keys.indexOf('asm'), keys.indexOf('param') + 1)
  assert.equal(W.SEGMENTS.find((s) => s.key === 'asm').label, '装配')
  const ck = W.CATEGORIES.map((c) => c.key)
  for (const k of ['aircraft', 'ship', 'vehicle']) assert.ok(ck.includes(k), k)
  assert.equal(ck[ck.length - 1], 'other')
  assert.deepEqual(W.CATEGORIES.filter((c) => ['aircraft', 'ship', 'vehicle'].includes(c.key)).map((c) => c.label), ['飞机', '船舶', '车辆'])
})
ok('entryFacts：装配件 = 本机 + 装配；实体模板 = 装配 + 就绪（运行时生成），不是云端 / 内置；参数化模板不算装配', () => {
  const a = W.entryFacts(ASM_E), e = W.entryFacts(ENT_E), t = W.entryFacts(TPL_E)
  assert.deepEqual([a.asm, a.ent, a.local, a.param], [true, false, true, false])
  assert.deepEqual([e.asm, e.ent, e.ready, e.cloud, e.builtin, e.local], [true, true, true, false, false, false])
  assert.deepEqual([t.asm, t.ent, t.param, t.ready], [false, false, true, true])
  assert.equal(W.entryFacts({ id: 'user:0123456789ab', spec: { kind: 'assembly' }, source: { kind: 'user' } }).asm, true)
  assert.equal(W.matchSegment(ASM_E, 'asm'), true)
  assert.equal(W.matchSegment(ENT_E, 'asm'), true)
  assert.equal(W.matchSegment(TPL_E, 'asm'), false)
  // 排序：实体模板（tplOrder 100+）排在参数化模板之后、普通条目之前
  const s = W.filterEntries([ASM_E, ENT_E, TPL_E], { lang: 'zh' }).map((x) => x.id)
  assert.deepEqual(s, ['param:default-sat', 'ent:a320neo', 'asm:0123456789ab'])
  assert.equal(W.categoryOf(ENT_E), 'aircraft')
})

// ─────────────────────────── 参数行模型 ───────────────────────────
const FAKE = {
  type: 'test.fake', keys: ['lenM', 'dM', 'n', 'panels', 'style', 'mode', 'flag'],
  params: {
    lenM: { kind: 'num', def: 2, min: 0.1, max: 20, unit: 'm', source: 'illustrative', label: '长度', title: '沿本件 +Z' },
    dM: { kind: 'num', def: null, gt: 0, nullable: true, unit: 'm', source: 'https://example.org/spec', label: '直径' },
    n: { kind: 'int', def: 3, min: 1, max: 12, source: 'illustrative', label: '段数' },
    panels: { kind: 'int', def: 2, options: [0, 2, 4], source: 'illustrative', label: '侧板' },
    style: { kind: 'enum', def: 'kingpost', options: ['kingpost', 'tripod'], source: 'illustrative', label: '座型' },
    mode: { kind: 'enum', def: null, options: ['a', 'b'], nullable: true, source: 'illustrative', label: '模式' },
    flag: { kind: 'bool', def: true, source: 'illustrative', label: '带罩' }
  },
  validate: (p) => (p.lenM < p.n * 0.2 ? ['长度须 ≥ 段数 × 0.2 m'] : [])
}
ok('paramRows：四类 ParamSpec → 控件类型、占位、夹取界、选项与显示名', () => {
  const rows = L.paramRows(FAKE, { lenM: 3 }, { compId: 'mast' })
  const by = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.deepEqual(rows.map((r) => r.key), FAKE.keys)
  assert.equal(by.lenM.control, 'num'); assert.equal(by.lenM.min, 0.1); assert.equal(by.lenM.max, 20); assert.equal(by.lenM.unit, 'm'); assert.equal(by.lenM.value, 3)
  assert.equal(by.lenM.allowEmpty, false); assert.equal(by.lenM.placeholder, '')
  // gt 只描红不夹取；可空 → 允许留空、占位「自动」
  assert.equal(by.dM.min, -Infinity); assert.equal(by.dM.allowEmpty, true); assert.equal(by.dM.placeholder, '自动'); assert.equal(by.dM.value, null)
  assert.equal(by.n.control, 'num'); assert.equal(by.n.integer, true)
  assert.equal(by.panels.control, 'select'); assert.deepEqual(by.panels.options.map((o) => o.value), [0, 2, 4]); assert.deepEqual(by.panels.options.map((o) => o.label), ['0', '2', '4'])
  assert.equal(by.style.control, 'select'); assert.deepEqual(by.style.options.map((o) => o.label), ['锥形立柱', '三脚架'])
  assert.deepEqual(by.mode.options.map((o) => o.value), [null, 'a', 'b']); assert.equal(by.mode.options[0].label, '自动')
  assert.equal(by.flag.control, 'bool'); assert.equal(by.flag.value, true)
  assert.equal(by.lenM.path, 'mast.lenM')
})
ok('paramRows：title 三行（口径 / 示意值或出处 / 范围）', () => {
  const by = Object.fromEntries(L.paramRows(FAKE, {}, { compId: 'x' }).map((r) => [r.key, r]))
  assert.deepEqual(by.lenM.title.split('\n'), ['沿本件 +Z', '示意值', '范围 0.1 – 20 m'])
  assert.deepEqual(by.dM.title.split('\n'), ['出处：https://example.org/spec', '范围 > 0 m'])
  assert.deepEqual(by.n.title.split('\n'), ['示意值', '范围 1 – 12'])
  assert.equal(by.panels.title, '示意值')   // 有选项的 int 不写范围
})
ok('模板出处进悬停：从 ent:a320neo 复制，翼展行写 airbus.com 出处、不写「示意值」；派生量带派生式；改过 / 值变了回到组件口径；清洗保留 sources', () => {
  const E = PKG.E, t = E.entityTemplateDoc('ent:a320neo'), doc = t.doc
  const sources = L.templateSources(t, doc)
  assert.ok(sources['wing.spanM'] && sources['wing.spanM'].urls.some((u) => /airbus\.com/.test(u)), '翼展有出处')
  assert.equal(sources['wing.spanM'].value, 35.8)
  const prov = { illustrative: t.illustrative.slice(), touched: [], sources }
  const wingC = doc.comps.find((c) => c.id === 'wing'), wing = C.getComponent('air.wing')
  const rowOf = (pv, params = wingC.params) => L.paramRows(wing, params, { compId: 'wing', prov: pv }).find((r) => r.key === 'spanM')
  const r0 = rowOf(prov)
  assert.match(r0.title, /出处：https:\/\/[^\n]*airbus\.com/); assert.doesNotMatch(r0.title, /示意值/)
  assert.deepEqual(r0.provenance.urls, sources['wing.spanM'].urls); assert.equal(r0.bad, false)
  // 派生量：机身高 = 机身宽 × 高宽比 → 出处 + 派生式
  const fusC = doc.comps.find((c) => c.id === 'fus'), fh = L.paramRows(C.getComponent('air.fuselage'), fusC.params, { compId: 'fus', prov }).find((r) => r.key === 'heightM')
  assert.match(fh.title, /出处：/); assert.match(fh.title, /派生：fuselageWidthM × hRatio/)
  // 用户改过（touched）或值已不同 → 回到组件口径（示意值）
  assert.match(rowOf({ ...prov, touched: ['wing.spanM'] }).title, /示意值/)
  const r2 = rowOf(prov, { ...wingC.params, spanM: 40 })
  assert.match(r2.title, /示意值/); assert.equal(r2.provenance, null)
  // 清洗：保留 sources、只收 http(s) URL；没带 sources 的旧标记形状不变
  const sp = L.sanitizeProv({ ...prov, sources: { ...sources, 'x.bad': { urls: ['javascript:alert(1)'], value: 1 }, 'x.y': 3 } })
  assert.deepEqual(sp.sources['wing.spanM'], sources['wing.spanM'])
  assert.ok(!('x.bad' in sp.sources) && !('x.y' in sp.sources))
  assert.deepEqual(Object.keys(L.sanitizeProv({ illustrative: [], touched: [] })), ['illustrative', 'touched'])
  // 模板示意值（翼根位置比）仍描红
  const fx = L.paramRows(C.getComponent('air.fuselage'), fusC.params, { compId: 'fus', prov }).find((r) => r.key === 'wingXFrac')
  assert.equal(fx.illustrative, true); assert.match(fx.title, /模板示意值/)
})
ok('paramRows 描红：校验报到该键 / 模板示意值未改过；改过（touched）不再描红；组件级约束归 general', () => {
  const bad = Object.fromEntries(L.paramRows(FAKE, { lenM: 30, dM: 0 }, { compId: 'x' }).map((r) => [r.key, r]))
  assert.equal(bad.lenM.bad, true); assert.match(bad.lenM.err, /≤ 20/); assert.ok(bad.lenM.title.endsWith(bad.lenM.err))
  assert.equal(bad.dM.bad, true); assert.match(bad.dM.err, /> 0/)
  assert.equal(bad.n.bad, false)
  const prov = { illustrative: ['x.n', 'x.style', 'y.n'], touched: ['x.style'] }
  const ill = Object.fromEntries(L.paramRows(FAKE, {}, { compId: 'x', prov }).map((r) => [r.key, r]))
  assert.equal(ill.n.bad, true); assert.equal(ill.n.illustrative, true); assert.match(ill.n.title, /模板示意值/)
  assert.equal(ill.style.bad, false, 'touched')
  assert.equal(ill.lenM.bad, false)
  const e = L.paramErrors(FAKE, { lenM: 0.3, n: 3 })
  assert.deepEqual(e.byKey, {}); assert.deepEqual(e.general, ['长度须 ≥ 段数 × 0.2 m'])
  // 真组件：缺省参数全绿
  for (const d of C.listComponents()) assert.ok(L.paramRows(d, {}, { compId: 'c' }).every((r) => !r.bad), d.type)
})
ok('select 值编码：数字 / 字符串 / null 原样来回；枚举显示名查不到退回材质名、再退回原值', () => {
  for (const v of [0, 2, 'kingpost', null, 'mli_gold']) assert.deepEqual(L.decOpt(L.encOpt(v)), v)
  assert.equal(L.decOpt('not json'), null)
  assert.equal(L.enumLabel('mli', 'none'), '无')
  assert.equal(L.enumLabel('mli', 'mli_gold'), '金色 MLI')
  assert.equal(L.enumLabel('whatever', 'zz'), 'zz')
  assert.equal(L.enumLabel('style', null), '自动')
  const mo = L.materialOptions()
  assert.equal(mo.length, Object.keys(PB.MATERIALS).length + 1)
  assert.deepEqual(mo[0], { value: '', label: '组件缺省' })
  for (const o of mo.slice(1)) assert.ok(o.label && o.label !== o.value, o.value)   // 现有材质键都有中文名
})

// ─────────────────────────── 结构树 ───────────────────────────
const DOC = A.normalizeAssembly({
  kind: 'assembly', domain: 'spacecraft', name: '测试星',
  comps: [
    { id: 'bus', type: 'sat.bus.box', parent: null },
    { id: 'wing', type: 'sat.wing', parent: 'bus', attach: { mode: 'socket', socket: '+Y' }, sym: { op: 'mirrorXZ' } },
    { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+X' } },
    { id: 'feed', type: 'sat.feed.horn', parent: 'refl', attach: { mode: 'socket', socket: 'focus' }, name: '主馈源' },
    { id: 'thr', type: 'sat.thruster', parent: 'wing', attach: { mode: 'free' }, hidden: true, locked: true },
    { id: 'arr', type: 'sat.array.phased', parent: 'bus', attach: { mode: 'free' }, sym: { op: 'radial', n: 4 } }
  ]
})
ok('flattenTree：前序、深度、子件、对称角标、祖先对称、隐藏 / 锁定、显示名', () => {
  const rows = L.flattenTree(DOC)
  assert.deepEqual(rows.map((r) => r.id), ['bus', 'wing', 'thr', 'refl', 'feed', 'arr'])
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 2, 1, 2, 1])
  assert.deepEqual(rows.map((r) => r.hasKids), [true, true, false, true, false, false])
  const by = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.deepEqual([by.wing.sym.icon, by.wing.sym.n], ['flip-horizontal-2', 2])
  assert.deepEqual([by.arr.sym.icon, by.arr.sym.n], ['orbit', 4])
  assert.equal(by.bus.sym, null)
  assert.equal(by.thr.inherited, true); assert.equal(by.feed.inherited, false)
  assert.equal(by.thr.hidden, true); assert.equal(by.thr.locked, true)
  assert.equal(by.feed.label, '主馈源')
  assert.equal(by.bus.label, C.getComponent('sat.bus.box').titleZh)
  assert.equal(by.refl.icon, L.roleIcon(C.getComponent('sat.reflector').role))
  assert.equal(rows.length, DOC.comps.length, '派生件不单列')
})
ok('flattenTree：折叠的件不列子孙、自己仍列；坏文档（孤儿 / 成环）不丢件不死循环', () => {
  const rows = L.flattenTree(DOC, new Set(['bus']))
  assert.deepEqual(rows.map((r) => [r.id, r.open]), [['bus', false]])
  const r2 = L.flattenTree(DOC, ['refl'])
  assert.deepEqual(r2.map((r) => r.id), ['bus', 'wing', 'thr', 'refl', 'arr'])
  const bad = { comps: [{ id: 'a', type: 'prim.box', parent: 'b' }, { id: 'b', type: 'prim.box', parent: 'a' }, { id: 'c', type: 'prim.box', parent: 'zz' }, { id: 'd', type: 'prim.box', parent: 'd' }] }
  const r3 = L.flattenTree(bad)
  assert.deepEqual(r3.map((r) => r.id).sort(), ['a', 'b', 'c', 'd'])
  assert.deepEqual(L.flattenTree(null), [])
})
ok('subtreeIds / parentChoices：父件下拉排除自身子树', () => {
  assert.deepEqual([...L.subtreeIds(DOC, 'wing')].sort(), ['thr', 'wing'])
  assert.deepEqual([...L.subtreeIds(DOC, 'bus')].sort(), DOC.comps.map((c) => c.id).sort())
  assert.deepEqual(L.parentChoices(DOC, 'wing').map((o) => o.value), ['bus', 'refl', 'feed', 'arr'])
  assert.ok(L.parentChoices(DOC, 'wing')[0].label.includes('（bus）'))
})
ok('插座 / 面 / 安装插座选项：兄弟占用的插座不列（本件当前的照列），接不了的类型不列', () => {
  const wing = L.compById(DOC, 'wing')
  const sw = L.socketChoices(DOC, wing).map((o) => o.value)
  assert.ok(sw.includes('+Y'), '本件当前插座')
  assert.ok(!sw.includes('+X'), '+X 已被反射面占用')
  const refl = L.compById(DOC, 'refl')
  assert.ok(!L.socketChoices(DOC, refl).map((o) => o.value).includes('+Y'), '+Y 已被太阳翼占用')
  const busSockets = L.socketsOf(L.compById(DOC, 'bus'))
  for (const o of L.socketChoices(DOC, wing)) {
    const s = busSockets.find((x) => x.id === o.value)
    assert.ok(o.value === '+Y' || C.socketAccepts(s, 'sat.wing'), o.value)
  }
  assert.deepEqual(L.socketChoices(DOC, L.compById(DOC, 'bus')), [])   // 根件没有父件
  const faces = L.faceChoices(DOC, wing)
  assert.deepEqual(faces.map((f) => f.value), L.facesOf(L.compById(DOC, 'bus')).map((f) => f.id))
  assert.ok(faces.every((f) => f.halfU > 0 && f.halfV > 0))
  const mc = L.mountChoices(refl)
  assert.equal(mc[0].value, ''); assert.match(mc[0].label, /back/)
  assert.deepEqual(mc.slice(1).map((o) => o.value), L.socketsOf(refl).map((s) => s.id))
})
ok('拆分对称判据：径向恒可；镜像要钩子或对称面，烘焙件不可拆', () => {
  assert.equal(L.splitSymInfo(L.compById(DOC, 'arr')).ok, true)
  assert.equal(L.splitSymInfo(L.compById(DOC, 'wing')).ok, true)    // 太阳翼有 mirror 钩子
  assert.equal(L.splitSymInfo({ type: 'prim.box', params: {}, sym: { op: 'mirrorXZ' } }).ok, true)   // 关于 yz / xz 对称
  const baked = L.splitSymInfo({ type: 'air.prop', params: {}, sym: { op: 'mirrorYZ' } })
  if (C.getComponent('air.prop')) { assert.equal(baked.ok, false); assert.ok(baked.why) }
  assert.equal(L.splitSymInfo(L.compById(DOC, 'bus')).ok, false)
})

// ─────────────────────────── 组件库 ───────────────────────────
ok('libGroups：当前领域组在前、通用（prim.*）在后；只列该领域可用组件；搜索（中英文 / type / 参数名）', () => {
  const g = L.libGroups('spacecraft')
  assert.equal(g[0].key, 'spacecraft'); assert.equal(g[g.length - 1].key, 'common')
  const all = g.flatMap((x) => x.items.map((d) => d.type))
  assert.deepEqual(all.slice().sort(), C.listComponents('spacecraft').map((d) => d.type).sort())
  assert.ok(g.find((x) => x.key === 'common').items.every((d) => d.type.startsWith('prim.')))
  for (const dom of ['ground', 'aircraft', 'ship', 'vehicle']) {
    const gg = L.libGroups(dom)
    const types = gg.flatMap((x) => x.items.map((d) => d.type))
    assert.deepEqual(types.slice().sort(), C.listComponents(dom).map((d) => d.type).sort(), dom)
    if (gg.length > 1 && C.listComponents(dom).some((d) => d.domain[0] === dom && !d.type.startsWith('prim.'))) assert.equal(gg[0].key, dom)
    assert.equal(gg[gg.length - 1].key, 'common')
  }
  const wing = C.getComponent('sat.wing')
  for (const q of ['太阳翼', 'SAT.WING', 'ｗｉｎｇ', wing.params[wing.keys[0]].label]) assert.ok(L.libGroups('spacecraft', q).some((x) => x.items.some((d) => d.type === 'sat.wing')), q)
  assert.deepEqual(L.libGroups('spacecraft', 'zzzz-无此组件'), [])
  // 注入定义表：未知首领域的组也不丢
  const fake = [{ type: 'x.a', domain: ['mars'], titleZh: '甲', keys: [], params: {} }, { type: 'prim.q', domain: ['mars'], titleZh: '乙', keys: [], params: {} }]
  const gf = L.libGroups('spacecraft', '', fake)
  assert.deepEqual(gf.map((x) => x.key), ['common', 'mars'])
  assert.equal(L.compTip(wing).split('\n').pop(), 'sat.wing')
})

// ─────────────────────────── 草稿 / 工具状态 ───────────────────────────
ok('pickDraft：同 id 且草稿更新才用；库里没盖过戳 → 草稿胜；坏草稿一律不用', () => {
  const doc = { comps: [] }
  const at = Date.parse('2026-09-24T10:00:00.000Z')
  const d = { id: 'asm:0123456789ab', at, doc }
  assert.equal(L.pickDraft(d, { id: d.id, updatedAt: '2026-09-24T09:59:59.000Z' }), true)
  assert.equal(L.pickDraft(d, { id: d.id, updatedAt: '2026-09-24T10:00:00.000Z' }), false)
  assert.equal(L.pickDraft(d, { id: d.id, updatedAt: '2026-09-24T10:00:01.000Z' }), false)
  assert.equal(L.pickDraft(d, { id: 'asm:ffffffffffff', updatedAt: null }), false)
  assert.equal(L.pickDraft(d, { id: d.id, updatedAt: null }), true)
  assert.equal(L.pickDraft(d, { id: d.id }), true)
  for (const b of [null, {}, { ...d, id: 'user:0123456789ab' }, { ...d, at: 'x' }, { ...d, doc: null }, { ...d, doc: { comps: 1 } }]) assert.equal(L.pickDraft(b, { id: d.id }), false)
  assert.equal(L.draftOk(d), true)
  // 库里那份带装配文档：按内容判（与时间无关）——入库途中又改了一处马上关窗，草稿的 at 早于主进程随后盖的 updatedAt，内容不同照样用草稿
  const spec = { kind: 'assembly', domain: 'spacecraft', comps: [{ id: 'bus', type: 'sat.bus.box', parent: null, params: { xM: 2 } }] }
  const d2 = { id: d.id, at, doc: { ...spec, comps: [{ ...spec.comps[0], params: { xM: 2.7 } }] } }
  assert.equal(L.pickDraft(d2, { id: d.id, updatedAt: '2026-09-24T10:00:01.000Z', spec }), true, '内容不同 → 草稿（哪怕库里时间更晚）')
  assert.equal(L.pickDraft({ ...d2, doc: spec }, { id: d.id, updatedAt: '2026-09-24T09:00:00.000Z', spec }), false, '内容相同 → 库里那份（哪怕草稿时间更晚）')
  assert.equal(L.pickDraft({ ...d2, doc: { ...spec, name: '' } }, { id: d.id, spec: { ...spec, schema: 1 } }), false, '归一后相同即相同')
  assert.deepEqual(L.sanitizeProv({ illustrative: ['a.b', 'a.b', 3], touched: 'x' }), { illustrative: ['a.b'], touched: [] })
  assert.equal(L.sanitizeProv(null), null)
  assert.equal(L.provKey('asm:0123456789ab'), 'model/asm/prov/asm:0123456789ab')
})
ok('sanitizeUi：坏值逐项回缺省；栏宽 / 比例夹在范围里；步长只认 MOVE_STEPS / ROT_STEPS', () => {
  const d = L.sanitizeUi(null)
  assert.deepEqual(d, JSON.parse(JSON.stringify(L.UI_DEFAULTS)))
  const s = L.sanitizeUi({ tool: 'rotate', space: 'mount', snap: { on: false, move: 0.5, rot: 90 }, sym: { op: 'radial', n: 6 }, dockW: 9999, split: 0.01, libQ: 'x', secOpen: { a: true, b: 'no' }, posePreview: true, showCom: false, showSockets: false, posFrame: 'body' })
  assert.deepEqual(s, { tool: 'rotate', space: 'mount', snap: { on: false, move: 0.5, rot: 90 }, sym: { op: 'radial', n: 6 }, dockW: L.DOCK_W_MAX, split: 0.15, libQ: 'x', secOpen: { a: true }, posePreview: true, showCom: false, showSockets: false, showAxes: true, posFrame: 'body' })
  assert.equal(L.sanitizeUi({ showAxes: false }).showAxes, false, '原点三轴开关')
  const b = L.sanitizeUi({ tool: 'scale', space: 'world', snap: { move: 0.07, rot: 7 }, sym: { op: 'mirror', n: 9 }, dockW: 10, split: 'x' })
  assert.deepEqual([b.tool, b.space, b.snap.move, b.snap.rot, b.sym.op, b.sym.n, b.dockW, b.split], ['move', 'body', 0.05, 15, 'none', 2, L.DOCK_W_MIN, 0.42])
  assert.deepEqual(['body', 'local', 'mount'].map(L.nextSpace), ['local', 'mount', 'body'])
})

// ─────────────────────────── 位姿读数与自由件反算 ───────────────────────────
function rnd(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }
const R = rnd(20260924)
const rq = () => BF.quatCanonical([R() - 0.5, R() - 0.5, R() - 0.5, R() - 0.5])
const rt = () => [R() * 4 - 2, R() * 4 - 2, R() * 4 - 2]
ok('mul16 / invRigid16 / m16FromTQ：M·M⁻¹ = I，与 bodyFrame.mat4FromQuatT 同式', () => {
  for (let i = 0; i < 20; i++) {
    const q = rq(), t = rt()
    const M = L.m16FromTQ(t, q)
    nearV(M, BF.mat4FromQuatT(q, t), 1e-15)
    const I = L.mul16(M, L.invRigid16(M))
    nearV(I, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 1e-12)
  }
})
ok('poseReadout ↔ withPoseComponent：改一个分量，其余读数不动（3-2-1 欧拉）', () => {
  for (let i = 0; i < 20; i++) {
    const t = rt()
    const rpy = [R() * 300 - 150, R() * 160 - 80, R() * 300 - 150]
    const M = L.m16FromTQ(t, BF.fineRotate([0, 0, 0, 1], rpy[0], rpy[1], rpy[2]))
    const r = L.poseReadout(M)
    nearV(r.t, t, 1e-12); nearV(r.rpy, rpy, 1e-8)
    for (let k = 0; k < 6; k++) {
      const v = k < 3 ? R() * 2 - 1 : (R() * 120 - 60)
      const r2 = L.poseReadout(L.withPoseComponent(M, k, v))
      const want = [...t, ...rpy]; want[k] = v
      nearV([...r2.t, ...r2.rpy], want, 1e-8, 'k' + k)
    }
  }
  assert.equal(L.poseReadout(null), null)
})
ok('freeTQFromBody：M = A·T(t,q) 时，期望位姿 → 新 t / q 精确还原（A 不必知道）', () => {
  for (let i = 0; i < 30; i++) {
    const Aa = L.m16FromTQ(rt(), rq())
    const t0 = rt(), q0 = rq(), t1 = rt(), q1 = rq()
    const M0 = L.mul16(Aa, L.m16FromTQ(t0, q0)), M1 = L.mul16(Aa, L.m16FromTQ(t1, q1))
    const r = L.freeTQFromBody(t0, q0, M0, M1)
    nearV(r.t, t1, 1e-9); nearV(r.q, BF.quatCanonical(q1), 1e-9)
  }
})
ok('位姿与 solvePose 同口径：自由件改本体系位置后，solvePose 解出的就是那个位置', () => {
  const d = A.normalizeAssembly({ kind: 'assembly', domain: 'spacecraft', comps: [
    { id: 'bus', type: 'sat.bus.box', parent: null },
    { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+X' } },
    { id: 'box', type: 'prim.box', parent: 'refl', attach: { mode: 'free', socket: 'focus' }, t: [0.1, 0.2, 0.3], q: rq() }
  ] })
  const P = A.solvePose(d, new Map())
  const Mc = Array.from(P.get('box').m), Mp = Array.from(P.get('refl').m)
  // 本体系改 x
  const want = L.withPoseComponent(Mc, 0, 1.2345)
  const c = d.comps[2]
  const r = L.freeTQFromBody(c.t, c.q, Mc, want)
  const d2 = JSON.parse(JSON.stringify(d)); d2.comps[2].t = r.t; d2.comps[2].q = r.q
  nearV(Array.from(A.solvePose(d2, new Map()).get('box').m), want, 1e-9)
  // 相对父件改偏航
  const rel = L.relPose(Mp, Mc)
  const rel2 = L.withPoseComponent(rel, 5, 33)
  const want2 = L.mul16(Mp, rel2)
  const r2 = L.freeTQFromBody(c.t, c.q, Mc, want2)
  const d3 = JSON.parse(JSON.stringify(d)); d3.comps[2].t = r2.t; d3.comps[2].q = r2.q
  const got = Array.from(A.solvePose(d3, new Map()).get('box').m)
  nearV(got, want2, 1e-9)
  near(L.poseReadout(L.relPose(Mp, got)).rpy[2], 33, 1e-8)
})

// ─────────────────────────── 密度行 ───────────────────────────
ok('densityRows：DENSITY 全部键、显示名 / 单位 / 缺省值 / 覆盖值', () => {
  const rows = L.densityRows({ busVolume: 300 })
  assert.deepEqual(rows.map((r) => r.key), Object.keys(PB.DENSITY))
  const bv = rows.find((r) => r.key === 'busVolume')
  assert.deepEqual([bv.label, bv.unit, bv.def, bv.value], ['平台体', 'kg/m³', PB.DENSITY.busVolume.value, 300])
  assert.ok(rows.filter((r) => r.key !== 'busVolume').every((r) => r.value === null && r.label !== r.key))
  assert.match(bv.title, /^示意值：/)
})
ok('densityRows(doc)：只列文档内各件 ∪ 本领域组件实际读到的密度键，外加改过的键', () => {
  assert.deepEqual([...L.densityKeysOf('sat.boom', {})], ['boomLinear'])
  assert.deepEqual([...L.densityKeysOf('sat.thruster', { kind: 'lae' })], ['laeMass'])
  assert.deepEqual([...L.densityKeysOf('no.such', {})], [])
  const sat = L.densityRows({}, { domain: 'spacecraft', comps: [] }).map((r) => r.key)
  for (const k of ['busVolume', 'panelAreal', 'reflectorAreal', 'mliAreal', 'boomLinear']) assert.ok(sat.includes(k), '卫星领域含 ' + k)
  // 飞机文档：卫星材料（太阳翼基板 / 电池片 / 反射面 / MLI / OSR）一概不列
  const air = L.densityRows({}, { domain: 'aircraft', comps: [] }).map((r) => r.key)
  for (const k of ['panelAreal', 'cellAreal', 'reflectorAreal', 'meshReflectorAreal', 'mliAreal', 'radiatorAreal']) assert.ok(!air.includes(k), '飞机领域不列 ' + k)
  // 改过的键总要看得见（能清）
  assert.ok(L.densityRows({ mliAreal: 1.2 }, { domain: 'aircraft', comps: [] }).some((r) => r.key === 'mliAreal' && r.value === 1.2))
})

console.log(`modelAsmUi: ${n} 项通过`)
