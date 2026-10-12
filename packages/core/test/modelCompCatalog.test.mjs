// 组件不限领域 + 按功能分组的组件库（2026-10-12）：
//   ① 分类完整：除基本体外每个组件都有功能分组；分了族的分组（结构与机构 / 天线 / 推进）里每件都有族；族属于分组；型号的族属于型号的分组；
//      组件名不重名（统一组件库里同名卡片分不清）
//   ② 登记校验：族不存在 / 族与分组不符 / 型号族与分组不符 / accepts 里写了不存在的族记号 → 抛错
//   ③ 跨领域：每个组件作根件在五个领域里都合法、可生成；卫星相控阵装上车顶 / 船甲板 / 机背视轴朝天，地面站反射面装上卫星对地面朝天底，
//      螺旋天线上方位俯仰座视轴沿俯仰轴零位；editor 的 addComp 不再按领域拒收
//   ④ 族记号 accepts：车顶 / 上层建筑 / 桅杆平台 / 机背 / 座架俯仰轴 / 焦点按族收件、专用接口判据随之生效；老前缀口径不变
//   ⑤ 组件库分组：同一族里常用于当前领域的件在前、别的领域的件带设计领域角标；库页浏览不分常用、不带角标；按领域筛只列常用件；
//      搜分组 / 族名列出整族；悬停多一行「常用于：…」，浏览档的操作要点换成浏览口径
//   ⑥ 编号名（以组件新建装配件的文档名）
// 裸 node 跑（asmLogic.js / wbLogic.js 只 import packages/core 的相对路径）。
import assert from 'node:assert/strict'
import * as C from '../models/components/index.mjs'
import { validateAssembly, buildAssembly, normalizeAssembly, ASM_DOMAINS } from '../models/assembly.mjs'
import { addComp, socketDedicated } from '../models/asmSnap.mjs'
import * as L from '../../../src/model/asmLogic.js'
import { numberedNameOf, copyNameOf } from '../../../src/model/wbLogic.js'

let n = 0
const t = (name, fn) => {
  try { fn(); n++ } catch (e) { console.error('✗ ' + name); console.error(e); process.exitCode = 1 }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} ≠ ${b}`)
const nearV = (a, b, tol, msg) => { for (let i = 0; i < 3; i++) near(a[i], b[i], tol, `${msg}[${i}]`) }
const ALL = C.listComponents()
const FAMILIES = C.COMPONENT_FAMILIES
const FAMILY_CATS = new Set(Object.values(FAMILIES))

// ───────────────────────── ① 分类完整 ─────────────────────────

t('分类完整：除基本体外都有功能分组；分了族的分组里每件都有族、族属于分组；型号族合法；组件名不重名', () => {
  for (const d of ALL) {
    if (d.type.startsWith('prim.')) { assert.equal(d.category, undefined, d.type); continue }
    assert.ok(C.COMPONENT_CATEGORIES.includes(d.category), `${d.type} 缺功能分组`)
    if (FAMILY_CATS.has(d.category)) assert.ok(Object.hasOwn(FAMILIES, d.family), `${d.type} 缺组件族`)
    if (d.family !== undefined) assert.equal(FAMILIES[d.family], d.category, `${d.type} 族 ${d.family} 属于 ${FAMILIES[d.family]}`)
    for (const p of d.presets || []) {
      const cat = p.category || d.category
      if (p.family !== undefined) assert.equal(FAMILIES[p.family], cat, `${d.type}#${p.id} 族`)
    }
  }
  // 每个族、每个分组都有件（表里不留空族）
  for (const f of Object.keys(FAMILIES)) assert.ok(ALL.some((d) => d.family === f), `族 ${f} 没有组件`)
  for (const c of C.COMPONENT_CATEGORIES) assert.ok(ALL.some((d) => d.category === c), `分组 ${c} 没有组件`)
  const names = new Map()
  for (const d of ALL) { assert.ok(!names.has(d.titleZh), `组件名重名：${d.titleZh}（${names.get(d.titleZh)} / ${d.type}）`); names.set(d.titleZh, d.type) }
  assert.equal(C.getComponent('es.radome').titleZh, '球形天线罩')
  // 跨领域同族：卫星相控阵与平板动中通同在阵列族，星载反射面与地面站反射面同在反射面族
  assert.equal(C.getComponent('sat.array.phased').family, C.getComponent('veh.cotm.flat').family)
  assert.equal(C.getComponent('sat.reflector').family, C.getComponent('es.refl.cass').family)
  assert.equal(C.getPreset('sat.antenna.despun', 'mech').family, 'reflector', '机械消旋归反射面族')
  // 非卫星件补了搜索别名
  for (const d of ALL) if (!d.type.startsWith('prim.')) assert.ok(Array.isArray(d.aliases) && d.aliases.length, `${d.type} 缺别名`)
  // 设计领域 / 局部系约定
  assert.equal(C.homeDomain(C.getComponent('sat.array.phased')), 'spacecraft')
  assert.equal(C.homeDomain(C.getComponent('es.refl.cass')), 'ground')
  assert.equal(C.frameConvention(C.getComponent('sat.antenna.helix')), 'spacecraft')
  assert.equal(C.frameConvention(C.getComponent('air.nacelle')), 'frd')
  assert.equal(C.frameConvention(C.getComponent('prim.box')), null)
})

// ───────────────────────── ② 登记校验 ─────────────────────────

t('登记校验：族不存在 / 族与分组不符 / 型号族与分组不符 / accepts 族记号未定义 → 抛错（写注册表之前）', () => {
  const base = {
    type: 'zz.catalog.bad', domain: ['ground'], title: 'Bad', titleZh: '坏件', role: 'other', category: 'antenna', family: 'array',
    params: { a: { kind: 'num', def: 1, min: 0, max: 2, label: 'a', source: 'illustrative' } },
    build: (p, kit) => kit.createCtx()
  }
  assert.throws(() => C.registerComponent({ ...base, family: 'nope' }), /family 非法/)
  assert.throws(() => C.registerComponent({ ...base, category: 'power' }), /不属于 category/)
  assert.throws(() => C.registerComponent({ ...base, presets: [{ id: 'x', titleZh: '甲', title: 'A', params: {}, family: 'thruster' }] }), /型号 x family thruster 不属于 category antenna/)
  assert.throws(() => C.registerComponent({ ...base, presets: [{ id: 'x', titleZh: '甲', title: 'A', params: {}, family: 'nope' }] }), /family 非法/)
  const sock = (accepts) => ({ id: 'root', pos: [0, 0, 0], n: [0, 0, -1], up: [1, 0, 0], size: 0.1, roll: 90, accepts })
  assert.throws(() => C.registerComponent({ ...base, sockets: () => [sock(['@nofamily'])] }), /组件族 @nofamily 未定义/)
  assert.equal(C.getComponent('zz.catalog.bad'), null, '抛错的定义不进注册表')
  // 型号只改分组不给族：族为空（体装电池片 → 电源）
  const cells = L.libEntries(C.getComponent('sat.radiator')).find((e) => e.preset === 'cells')
  assert.equal(cells.category, 'power'); assert.equal(cells.family, undefined)
})

// ───────────────────────── ③ 跨领域 ─────────────────────────

t('跨领域：每个组件作根件在五个领域里都合法、可生成（IR 非空、无告警）', () => {
  for (const d of ALL) {
    for (const dom of ASM_DOMAINS) {
      // 手填质量：测控天线 / 三种敏感器缺省不计质量（单件文档总质量为 0 会被 buildAssembly 拒收，与 modelAssembly 注册表用例同口径）
      const doc = { kind: 'assembly', domain: dom, comps: [{ id: 'c1', type: d.type, parent: null, massKg: 7 }] }
      const v = validateAssembly(doc)
      assert.ok(v.ok, `${d.type} @ ${dom}：${v.errors.join('；')}`)
      const r = buildAssembly(doc)
      assert.ok(r.ir.meshes.length > 0, `${d.type} @ ${dom} 无网格`)
      assert.deepEqual(r.warnings, [], `${d.type} @ ${dom} 告警`)
    }
  }
})

const bore = (doc, name) => {
  const v = validateAssembly(doc)
  assert.ok(v.ok, v.errors.join('；'))
  const a = buildAssembly(doc).attachPoints.find((x) => x.name === name)
  assert.ok(a, `缺挂点 ${name}`)
  return a.dirBody
}
t('跨领域装配朝向：相控阵上车顶 / 船甲板 / 机背视轴朝天（FRD / NED −Z），地面站反射面装卫星对地面朝天底（+Z），螺旋天线上座架沿俯仰轴零位', () => {
  nearV(bore({ kind: 'assembly', domain: 'vehicle', comps: [{ id: 'body', type: 'veh.body', parent: null }, { id: 'arr', type: 'sat.array.phased', parent: 'body', attach: { mode: 'socket', socket: 'roof' } }] }, 'arr_boresight'), [0, 0, -1], 1e-9, '车顶相控阵')
  nearV(bore({ kind: 'assembly', domain: 'ship', comps: [{ id: 'hull', type: 'sea.hull', parent: null }, { id: 'arr', type: 'sat.array.phased', parent: 'hull', attach: { mode: 'surface', face: 'deck' } }] }, 'arr_boresight'), [0, 0, -1], 1e-9, '甲板相控阵')
  nearV(bore({ kind: 'assembly', domain: 'aircraft', comps: [{ id: 'fus', type: 'air.fuselage', parent: null }, { id: 'arr', type: 'sat.array.phased', parent: 'fus', attach: { mode: 'socket', socket: 'crown' } }] }, 'arr_boresight'), [0, 0, -1], 1e-9, '机背相控阵')
  nearV(bore({ kind: 'assembly', domain: 'spacecraft', comps: [{ id: 'bus', type: 'sat.bus.box', parent: null }, { id: 'refl', type: 'es.refl.prime', parent: 'bus', attach: { mode: 'surface', face: '+Z' } }] }, 'refl_boresight'), [0, 0, 1], 1e-9, '卫星对地面主焦反射面')
  nearV(bore({ kind: 'assembly', domain: 'ground', comps: [{ id: 'ped', type: 'es.pedestal.azel', parent: null }, { id: 'hx', type: 'sat.antenna.helix', parent: 'ped', attach: { mode: 'socket', socket: 'el' } }] }, 'hx_boresight'), [1, 0, 0], 1e-9, '座架上的螺旋天线')
  // 编辑器加件（asmSnap.addComp）不再按领域拒收
  const r = addComp(normalizeAssembly({ kind: 'assembly', domain: 'ship', comps: [] }), { type: 'sat.antenna.helix', parent: null })
  assert.ok(r.ok, r.error)
  assert.equal(r.doc.comps[0].type, 'sat.antenna.helix')
})

// ───────────────────────── ④ 族记号 accepts ─────────────────────────

const sockOf = (type, id, params = {}) => {
  const d = C.getComponent(type)
  const s = d.sockets(C.fillParams(d, params)).find((x) => x.id === id)
  assert.ok(s, `${type} 无接口 ${id}`)
  return s
}
t('族记号 accepts：天线安装位按族收件，专用接口判据随之生效；不收的照旧不收、老前缀口径不变', () => {
  assert.equal(C.acceptsType('@array', 'sat.array.phased'), true)
  assert.equal(C.acceptsType('@array', 'veh.cotm.flat'), true)
  assert.equal(C.acceptsType('@array', 'sat.reflector'), false)
  assert.equal(C.acceptsType('@array', 'no.such.type'), false)
  assert.equal(C.acceptsType('sat.feed.', 'sat.feed.horn'), true)
  const cases = [
    ['veh.body', 'roof', {}, ['sat.array.phased', 'sat.antenna.omni', 'sat.antenna.helix', 'sat.antenna.shroud', 'es.radome', 'veh.cotm.flat', 'es.pedestal.azel'], ['sat.thruster', 'sat.wing', 'es.refl.prime', 'sat.reflector']],
    ['sea.superstructure', 'top', {}, ['sat.array.phased', 'sat.antenna.omni', 'air.radome', 'sea.vsat.radome', 'es.pedestal.xy'], ['sat.reflector', 'es.refl.cass', 'sat.thruster']],
    ['sea.mast', 'platform', {}, ['sat.antenna.omni', 'sat.array.phased', 'sat.antenna.shroud', 'es.radome'], ['sat.bus.box']],
    ['air.fuselage', 'crown', {}, ['sat.array.phased', 'veh.cotm.flat', 'air.radome', 'sat.antenna.omni'], ['air.nacelle', 'sat.reflector']],
    ['es.pedestal.azel', 'el', {}, ['es.refl.prime', 'sat.reflector', 'sat.array.phased', 'sat.antenna.helix', 'sat.feed.horn'], ['es.subrefl', 'sat.thruster', 'es.pedestal.xy']],
    ['es.refl.prime', 'focus', {}, ['es.feed', 'es.subrefl', 'sat.feed.horn', 'sat.feed.cluster'], ['sat.array.phased']],
    ['sat.reflector', 'focus', {}, ['sat.feed.horn', 'sat.array.phased', 'es.feed'], ['sat.antenna.helix']],
    ['sat.boom', 'tip', {}, ['sat.reflector', 'sat.antenna.omni', 'es.refl.offset', 'es.feed', 'veh.cotm.flat'], ['sat.sensor.star', 'sat.sensor.sun']]
  ]
  for (const [type, id, params, yes, no] of cases) {
    const s = sockOf(type, id, params)
    for (const x of yes) { assert.ok(C.socketAccepts(s, x), `${type}.${id} 应收 ${x}`); assert.ok(socketDedicated(s, x), `${type}.${id} 是 ${x} 的专用接口`) }
    for (const x of no) assert.ok(!C.socketAccepts(s, x), `${type}.${id} 不收 ${x}`)
    assert.ok(C.socketAccepts(s, 'prim.box') && !socketDedicated(s, 'prim.box'), `${type}.${id} 收基本体占位、不算专用`)
  }
})

// ───────────────────────── ⑤ 组件库分组 ─────────────────────────

const entriesOf = (gs) => gs.flatMap((g) => g.items)
const famOf = (gs, cat, fam) => gs.find((g) => g.key === cat).subs.find((s) => s.key === `${cat}-${fam}`)
t('组件库：族内常用于当前领域的件在前、别的领域的件带设计领域角标；库页浏览不分常用不带角标；按领域筛只列常用件', () => {
  const ship = L.libGroups('ship')
  const arr = famOf(ship, 'antenna', 'array').items.map((e) => e.key)
  assert.ok(arr.indexOf('veh.cotm.flat') < arr.indexOf('sat.array.phased'), '船舶文档：平板动中通排在卫星相控阵前')
  const refl = famOf(ship, 'antenna', 'reflector').items
  const firstSat = refl.findIndex((e) => !e.native)
  assert.ok(firstSat > 0 && refl.slice(0, firstSat).every((e) => e.native) && refl.slice(firstSat).every((e) => !e.native), '常用件整段在前')
  const pa = entriesOf(ship).find((e) => e.key === 'sat.array.phased')
  assert.deepEqual([pa.badge.domain, pa.badge.icon, pa.badge.tip], ['spacecraft', 'satellite', '常用于：卫星'])
  assert.equal(entriesOf(ship).find((e) => e.key === 'es.feed').badge, null, '常用于船舶的件不带角标')
  assert.equal(entriesOf(ship).find((e) => e.key === 'prim.box').badge, null, '基本体不带角标')
  const sc = L.libGroups('spacecraft')
  assert.equal(entriesOf(sc).find((e) => e.key === 'sat.array.phased').badge, null)
  assert.equal(entriesOf(sc).find((e) => e.key === 'es.feed').badge.tip, '常用于：地球站 / 船舶 / 车辆')
  // 型号与组件本身同一角标、同一常用口径；型号仍紧跟组件本身
  const ka = entriesOf(ship).find((e) => e.key === 'sat.array.phased#ka')
  assert.equal(ka.native, false); assert.equal(ka.badge.domain, 'spacecraft')
  const keys = famOf(ship, 'antenna', 'array').items.map((e) => e.key)
  assert.equal(keys.indexOf('sat.array.phased#disc-oct'), keys.indexOf('sat.array.phased') + 1)
  // 浏览（库页）：不分常用、不带角标，顺序 = 登记顺序
  const br = L.libGroups(null)
  assert.ok(entriesOf(br).every((e) => e.native && !e.badge))
  // 按领域筛：只列常用于该领域的件（基本体恒在）
  const veh = entriesOf(L.libGroups(null, '', undefined, { only: 'vehicle' }))
  assert.ok(veh.length && veh.every((e) => e.def.domain.includes('vehicle')))
  assert.ok(veh.some((e) => e.type === 'veh.cotm.flat') && veh.some((e) => e.type === 'prim.box') && !veh.some((e) => e.type === 'sat.array.phased'))
  // 搜分组 / 族名：列出整族（「天线座」找到全部座架，虽然它们名叫「方位俯仰座」「X-Y 座」）
  const mounts = entriesOf(L.libGroups('ground', '天线座')).map((e) => e.type)
  for (const ty of ['es.pedestal.azel', 'es.pedestal.xy', 'es.pedestal.wheeltrack', 'es.vsat.mount', 'veh.driveaway']) assert.ok(mounts.includes(ty), ty)
  // 船舶文档里也搜得到卫星相控阵（2026-10-12 之前只有卫星文档里有）
  const pas = entriesOf(L.libGroups('ship', '相控阵')).map((e) => e.key)
  assert.ok(pas.includes('sat.array.phased') && pas.includes('sat.array.phased#ka') && pas.includes('veh.cotm.flat'))
})

t('悬停：多一行「常用于：…」（基本体不给）；浏览档的操作要点换成浏览口径；末行恒为 type', () => {
  const e = L.libEntries(C.getComponent('sat.array.phased'), 'ship')[0]
  const tip = L.compTip(e).split('\n')
  assert.ok(tip.includes('常用于：卫星'))
  assert.ok(tip.some((s) => s.startsWith('拖入视口安装')) && tip[tip.length - 1] === 'sat.array.phased')
  const b = L.compTip(e, { browse: true }).split('\n')
  assert.ok(b.includes('双击：以此为根件新建装配件') && b.includes('右键：添加到当前设计') && !b.some((s) => s.startsWith('拖入视口安装')))
  assert.ok(!L.compTip(L.libEntries(C.getComponent('prim.box'))[0]).includes('常用于'))
  assert.equal(L.domainBadge(C.getComponent('prim.cyl'), 'aircraft'), null)
  assert.equal(L.domainsText(C.getComponent('veh.cotm.flat')), '车辆 / 船舶 / 地球站 / 飞机')
})

// ───────────────────────── ⑥ 编号名 ─────────────────────────

t('编号名：没被占用原名，否则「名 2」「名 3」…（英文不分大小写）；副本名口径不变', () => {
  assert.equal(numberedNameOf('相控阵天线', ['反射面天线']), '相控阵天线')
  assert.equal(numberedNameOf('相控阵天线', ['相控阵天线']), '相控阵天线 2')
  assert.equal(numberedNameOf('相控阵天线', ['相控阵天线', '相控阵天线 2']), '相控阵天线 3')
  assert.equal(numberedNameOf('Phased array antenna', ['phased ARRAY antenna'], 'en'), 'Phased array antenna 2')
  assert.equal(numberedNameOf('', []), '未命名')
  assert.equal(numberedNameOf('X 副本', ['X 副本']), 'X 副本 2', '编号名不剥副本后缀')
  assert.equal(copyNameOf('相控阵天线', []), '相控阵天线 副本')
  assert.equal(copyNameOf('X 副本', ['X 副本']), 'X 副本 2')
})

console.log(`modelCompCatalog: ${n} 项通过`)
