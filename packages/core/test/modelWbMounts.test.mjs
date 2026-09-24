// 模型工作台「卫星」页纯逻辑（src/model/mountLogic.js）单测：绑定工作副本归一、挂点表格 行 ⇄ mount（视轴 az / el 与掩模 D2 同口径、
// 滚转与报告挂点表同口径）、从 attach point / 预览点选 / 模板新增、复制、JSON 进出、天线引用选项与方向图宽度。
// 裸 node 跑：mountLogic.js 只 import packages/core（相对路径），不碰 three / vue / DOM。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(path.join(HERE, p)).href)
const M = await imp('../../../src/model/mountLogic.js')
const MASK = await imp('../models/mask.mjs')
const BF = await imp('../models/bodyFrame.mjs')
const SCH = await imp('../models/schema.mjs')
const PB = await imp('../models/paramBus.mjs')
const PT = await imp('../models/paramTemplates.mjs')
const LBL = await imp('../../../src/shared/lbBodyLayout.js')

let n = 0
const ok = (name, fn) => { fn(); n++ }
const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`)
const nearV = (a, b, tol = 1e-9, msg = '') => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => near(x, b[i], tol, msg + '[' + i + ']')) }
let seed = 20260924
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const rdir = () => { for (;;) { const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; const l = Math.hypot(...v); if (l > 0.1 && l < 1) return v.map((x) => x / l) } }

ok('视轴 az / el 与掩模 D2 口径逐位一致（mask.maskAzEl），往返回到原方向', () => {
  for (let k = 0; k < 500; k++) {
    const d = rdir()
    const a = M.azElOf(d), b = MASK.maskAzEl(d)
    near(a.az, b.az, 1e-12, 'az'); near(a.el, b.el, 1e-12, 'el')
    nearV(M.dirOfAzEl(a.az, a.el), d, 1e-12)
  }
  assert.deepEqual(M.azElOf([0, 0, 1]), { az: 0, el: 90 })
  assert.deepEqual(M.azElOf([0, 1, 0]), { az: 90, el: 0 })
  nearV(M.dirOfAzEl(0, -90), [0, 0, -1], 1e-15)
})
ok('滚转：0 = D1 缺省上向；往返；与报告挂点表（lbBodyLayout.mountReadout）同一个数', () => {
  for (let k = 0; k < 300; k++) {
    const d = rdir(), roll = rnd() * 360 - 180
    const u = M.upOfRoll(d, roll)
    near(u[0] * d[0] + u[1] * d[1] + u[2] * d[2], 0, 1e-12, '⟂')
    near(M.rollOf(d, u), roll, 1e-9, 'roll')
    const r = LBL.mountReadout({ id: 'a', posBody: [0, 0, 0], boresightBody: d, upBody: u })
    near(r.rollDeg, roll, 1e-9, 'report')
    near(r.azDeg, M.azElOf(d).az, 1e-12); near(r.elDeg, M.azElOf(d).el, 1e-12)
  }
  nearV(M.upOfRoll([0, 0, 1], 0), BF.defaultUpBody([0, 0, 1]))
  assert.equal(M.rollOf([0, 0, 1], [0, -1, 0]), 0)
  near(M.rollOf([0, 0, 1], [1, 0, 0]), 90, 1e-12, '−Y 绕 +Z 右手转 90° 到 +X')
})
ok('表格改格：az / el 保滚转、位置改了掩模签名作废、万向节键 / 名两种写法、数字非法返回 null、视场留空删掉', () => {
  const m0 = SCH.defaultMount({ id: 'a', posBody: [1, 2, 3], boresightBody: [0, 0, 1], upBody: M.upOfRoll([0, 0, 1], 30), maskSig: 'a'.repeat(16), fovDeg: 20 })
  const m1 = M.applyMountEdit(m0, 'az', 45)
  near(M.azElOf(m1.boresightBody).az, 0, 1e-9, '天底 az 无定义按 0')
  const m2 = M.applyMountEdit(m0, 'el', 60)
  near(M.azElOf(m2.boresightBody).el, 60, 1e-9); near(M.rollOf(m2.boresightBody, m2.upBody), 30, 1e-9, '滚转不变')
  assert.equal(m2.maskSig, undefined, '视轴改了：签名作废')
  const m3 = M.applyMountEdit(m2, 'az', 400)
  near(M.azElOf(m3.boresightBody).az, 40, 1e-9); near(M.rollOf(m3.boresightBody, m3.upBody), 30, 1e-9)
  const m4 = M.applyMountEdit(m0, 'px', -5)
  assert.deepEqual(m4.posBody, [-5, 2, 3]); assert.equal(m4.maskSig, undefined)
  assert.equal(M.applyMountEdit(m0, 'px', NaN), null)
  assert.equal(M.applyMountEdit(m0, 'px', 'abc'), null)
  const m5 = M.applyMountEdit(m0, 'roll', -45)
  near(M.rollOf(m5.boresightBody, m5.upBody), -45, 1e-9); assert.equal(m5.maskSig, 'a'.repeat(16), '滚转不影响掩模（掩模不看 up）')
  assert.equal(M.applyMountEdit(m0, 'gimbal', 'X-Y').gimbal.type, 'xy')
  assert.equal(M.applyMountEdit(m0, 'gimbal', 'azel').gimbal.type, 'azel')
  assert.equal(M.applyMountEdit(m0, 'gimbal', 'bogus'), null)
  const m6 = M.applyMountEdit(M.applyMountEdit(m0, 'gimbal', 'xy'), 'a1Min', -12)
  assert.equal(m6.gimbal.limits.a1Min, -12); assert.equal(m6.gimbal.type, 'xy')
  assert.equal(M.applyMountEdit(m0, 'fov', null).fovDeg, undefined)
  assert.equal(M.applyMountEdit(m0, 'fov', 0), null)
  // 排除节点：只按逗号 / 分号（中英文）/ 换行切，空格不是分隔符（导入件节点名常带空格）
  assert.deepEqual(M.applyMountEdit(m0, 'exclude', 'A, B；C  D').excludeNodes, ['A', 'B', 'C  D'])
  assert.deepEqual(M.applyMountEdit(m0, 'exclude', 'Solar Array Left, Feed Horn').excludeNodes, ['Solar Array Left', 'Feed Horn'])
  assert.equal(M.applyMountEdit(m0, 'rate', 2).gimbal.rateDegS, 2)
  assert.equal(M.applyMountEdit(M.applyMountEdit(m0, 'rate', 2), 'rate', null).gimbal.rateDegS, undefined)
  assert.equal(M.applyMountEdit(m0, 'sysTempK', 800).sysTempK, 800)
  assert.equal(M.applyMountEdit(m0, 'name', '  '), null)
  // attach point：选了就取它的位姿；不存在的名字不写
  const aps = [{ name: 'AP1', posBody: [4, 5, 6], dirBody: [1, 0, 0], upBody: [0, 0, -1] }]
  const m7 = M.applyMountEdit(m0, 'attachPoint', 'AP1', { attachPoints: aps })
  assert.deepEqual([m7.attachPoint, m7.posBody, m7.boresightBody, m7.upBody], ['AP1', [4, 5, 6], [1, 0, 0], [0, 0, -1]])
  assert.equal(M.applyMountEdit(m0, 'attachPoint', 'nope', { attachPoints: aps }), null)
  assert.equal(M.applyMountEdit(m7, 'attachPoint', '').attachPoint, null)
  // 每次改完都是 schema 归一过的（能直接落盘）
  for (const x of [m1, m2, m3, m4, m5, m6, m7]) assert.deepEqual(SCH.normalizeMount(x).errors, [])
})
ok('新增：从 attach point（位姿取挂点、id 去重、名字 = 挂点名）/ 预览点选（命中点 + 面法向）/ 空白', () => {
  const ap = { name: 'SA_E_Attachpoint', posBody: [4, 0, 2], dirBody: [0, 0, 1], upBody: [1, 0, 0] }
  const a = M.mountFromAttachPoint(ap, new Set(['SA_E']))
  assert.deepEqual([a.id, a.name, a.attachPoint, a.posBody, a.boresightBody, a.upBody], ['SA_E_2', 'SA_E_Attachpoint', 'SA_E_Attachpoint', [4, 0, 2], [0, 0, 1], [1, 0, 0]])
  const h = M.mountFromHit({ pointBody: [0.1234567891, 1, 2], normalBody: [0, 2, 0] }, new Set(['mount_1']))
  assert.deepEqual([h.id, h.posBody, h.boresightBody, h.attachPoint], ['mount_2', [0.123457, 1, 2], [0, 1, 0], null])
  nearV(h.upBody, BF.defaultUpBody([0, 1, 0]))
  const b = M.blankMount([])
  assert.deepEqual([b.id, b.posBody, b.boresightBody, b.upBody], ['mount_1', [0, 0, 0], [0, 0, 1], [0, -1, 0]])
})
ok('复制：id 加 _copy 去重、名字加「副本」、掩模签名不带', () => {
  const ms = [SCH.defaultMount({ id: 'a', name: 'A', maskSig: 'b'.repeat(16), posBody: [1, 1, 1] }), SCH.defaultMount({ id: 'a_copy', name: 'X' })]
  const out = M.duplicateMounts(ms, ['a'])
  assert.equal(out.length, 3)
  assert.deepEqual([out[2].id, out[2].name, out[2].maskSig, out[2].posBody], ['a_copy_2', 'A 副本', undefined, [1, 1, 1]])
})
ok('模板套用：默认卫星对上参数化模型的四个反射面焦点（位姿以模型为准）；追加时 id 去重、替换时整表换掉', () => {
  const r = PB.buildParamModel(PT.templateSpec(PT.DEFAULT_TEMPLATE_ID).spec)
  const aps = r.attachPoints
  const a = M.applyTemplate('default-sat', [], aps, 'append')
  assert.equal(a.mounts.length, 4); assert.equal(a.matched.length, 4); assert.deepEqual(a.errors, [])
  for (const m of a.mounts) {
    const ap = aps.find((x) => x.name === m.attachPoint)
    assert.ok(ap, m.attachPoint); nearV(m.posBody, ap.posBody, 1e-12); nearV(m.boresightBody, ap.dirBody, 1e-12)
  }
  const b = M.applyTemplate('default-sat', a.mounts, aps, 'append')
  assert.equal(b.mounts.length, 8); assert.equal(new Set(b.mounts.map((m) => m.id)).size, 8)
  const c = M.applyTemplate('tdrs', a.mounts, [], 'replace')
  assert.equal(c.mounts.length, 4); assert.equal(c.unmatched.length, 4); assert.ok(c.mounts.every((m) => m.attachPoint === null))
  assert.equal(M.applyTemplate('dfh4', [], aps).mounts.length, 4, '旧模板 id 别名到默认卫星')
  assert.equal(M.applyTemplate('nope', [], aps), null)
  assert.ok(M.templateOptions().every((t) => t.id && t.label) && !M.templateOptions().some((t) => /DFH|东方红/.test(t.label)), '模板下拉不出现已撤下的中国平台模板')
})
ok('反射面焦点挂点自动排除自身天线（反射面 / 展开臂 / 馈源 / 馈源支架）；模板与「从 attach point」两条路同口径，用户填过的不覆盖', () => {
  const r = PB.buildTemplateModel('default-sat')
  const own3 = M.ownAntennaNodes(r.parts, 'reflector_3_focus')
  assert.deepEqual([...own3].sort(), ['feed_3', 'feed_3_support', 'reflector_3', 'reflector_3_arm', 'reflector_3_back', 'reflector_3_rim'])
  assert.deepEqual(M.ownAntennaNodes(r.parts, 'nadir_center'), [])
  assert.deepEqual(M.ownAntennaNodes(null, 'reflector_3_focus'), [])
  const a = M.applyTemplate('default-sat', [], r.attachPoints, 'append', r.parts)
  for (const m of a.mounts) {
    const k = /^reflector_(\d+)_focus$/.exec(m.attachPoint)[1]
    assert.ok(m.excludeNodes.includes('reflector_' + k) && m.excludeNodes.includes('feed_' + k) && !m.excludeNodes.some((x) => x.endsWith('_' + (k === '1' ? '2' : '1'))), m.id)
  }
  assert.ok(M.applyTemplate('default-sat', [], r.attachPoints, 'append').mounts.every((m) => !m.excludeNodes || !m.excludeNodes.length), '不给 parts 时不猜')
  const ap = r.attachPoints.find((x) => x.name === 'reflector_4_focus')
  assert.deepEqual(M.mountFromAttachPoint(ap, [], r.parts).excludeNodes, M.ownAntennaNodes(r.parts, 'reflector_4_focus'))
  assert.ok(!(M.mountFromAttachPoint(r.attachPoints.find((x) => x.name === 'nadir_center'), [], r.parts).excludeNodes || []).length)
  // 表格改 attach point：排除名单空着才补，填过的不动
  const blank = M.blankMount([])
  assert.deepEqual(M.applyMountEdit(blank, 'attachPoint', 'reflector_3_focus', { attachPoints: r.attachPoints, parts: r.parts }).excludeNodes, own3)
  const mine = { ...blank, excludeNodes: ['bus'] }
  assert.deepEqual(M.applyMountEdit(mine, 'attachPoint', 'reflector_3_focus', { attachPoints: r.attachPoints, parts: r.parts }).excludeNodes, ['bus'])
})
ok('JSON 进出：往返逐字相等；认 {mounts}、裸数组、整条绑定；id 与已有撞了改名；坏条丢弃并报错', () => {
  const a = M.applyTemplate('goes', [], []).mounts
  const txt = M.mountsToJson(a, { satKey: 'norad:1' })
  const back = M.mountsFromJson(txt, [])
  assert.deepEqual(back.mounts, a); assert.deepEqual(back.errors, [])
  assert.equal(M.mountsFromJson(JSON.stringify(a), []).mounts.length, a.length)
  const bind = { model: { id: 'auto' }, mounts: a, attitude: { law: 'yawSteer', params: {} } }
  const r = M.mountsFromJson(JSON.stringify(bind), [a[0].id])
  assert.equal(r.mounts[0].id, a[0].id + '_2'); assert.equal(r.attitude.law, 'yawSteer')
  const bad = M.mountsFromJson(JSON.stringify([{ id: 'x' }, { id: 'y', posBody: [0, 0, 0] }]), [])
  assert.equal(bad.mounts.length, 1); assert.ok(bad.errors.length >= 1)
  assert.equal(M.mountsFromJson('not json').mounts, null)
  assert.equal(M.mountsFromJson('{"a":1}').mounts, null)
})
ok('绑定工作副本：归一（坏模型 id 按自动、mount id 去重）、空绑定判据', () => {
  const r = M.normalizeBinding({ model: { id: 'bogus id' }, mounts: [{ id: 'a', posBody: [0, 0, 0] }, { id: 'a', posBody: [1, 0, 0] }, { posBody: 'x' }], attitude: { law: 'bad' } })
  assert.equal(r.binding.model.id, 'auto'); assert.equal(r.binding.mounts.length, 2)
  assert.notEqual(r.binding.mounts[0].id, r.binding.mounts[1].id)
  assert.equal(r.binding.attitude.law, 'nadir'); assert.ok(r.errors.length >= 2)
  assert.equal(M.isEmptyBinding(M.emptyBinding()), true)
  assert.equal(M.isEmptyBinding({ model: { id: 'auto' }, mounts: [], attitude: { law: 'nadir', params: { yawBiasDeg: 0 } } }), true)
  assert.equal(M.isEmptyBinding({ model: { id: null }, mounts: [], attitude: { law: 'nadir', params: {} } }), false)
  assert.equal(M.isEmptyBinding({ model: { id: 'auto' }, mounts: [], attitude: { law: 'sun', params: {} } }), false)
  assert.equal(M.isEmptyBinding({ model: { id: 'auto' }, mounts: [SCH.defaultMount({})], attitude: { law: 'nadir' } }), false)
  // 归一结果过得了主进程的 validateBindings（零错误）
  const v = SCH.validateBindings({ schema: 1, bindings: { 'norad:25544': r.binding } })
  assert.equal(v.ok, true); assert.deepEqual(v.errors, [])
})
ok('天线引用：下拉编码 ⇄ antennaRef、显示名、方向图 −3 dB 宽（hpbw → 70λ/D → 增益反推）、视场锥半角（fov 优先）', () => {
  const opts = M.antennaOptions({ grdSats: [{ folder: 'f1', satName: 'S1', antennas: [{ name: 'A' }] }], lbSats: [{ ns: 'geo', id: 'sat3', name: 'X', summary: 'Ku' }] })
  assert.deepEqual(opts.map((o) => o.value), ['', 'param', 'grd:f1|A', 'lb:geo:sat3'])
  assert.deepEqual(M.antennaFromValue('grd:f1|A'), { kind: 'grd', id: 'f1|A' })
  assert.deepEqual(M.antennaFromValue('lb:geo:sat3'), { kind: 'lbAntenna', id: 'geo:sat3' })
  assert.deepEqual(M.antennaFromValue('param', { kind: 'param', spec: { diameterM: 2 } }), { kind: 'param', spec: { diameterM: 2 } })
  assert.equal(M.antennaFromValue(''), null)
  for (const v of ['', 'param', 'grd:f1|A', 'lb:geo:sat3']) assert.equal(M.antennaValue(M.antennaFromValue(v)), v)
  assert.equal(M.antennaLabel({ kind: 'grd', id: 'f1|A' }, opts), 'S1 · A')
  assert.equal(M.antennaLabel({ kind: 'grd', id: 'gone|B' }, opts), 'gone|B')
  near(M.hpbwOf({ kind: 'param', spec: { diameterM: 1.2, freqGHz: 14.25 } }), 20.98547 / (14.25 * 1.2), 1e-12)
  near(M.hpbwOf({ kind: 'param', spec: { diameterM: 1.2, freqGHz: 14.25 } }, 12), 20.98547 / (12 * 1.2), 1e-12, '外给频率优先')
  assert.equal(M.hpbwOf({ kind: 'param', spec: { hpbwDeg: 26, diameterM: 1 } }), 26)
  near(M.hpbwOf({ kind: 'param', spec: { gainDbi: 30 } }), Math.sqrt(41253 / 1000), 1e-12)
  assert.equal(M.hpbwOf({ kind: 'param', spec: { gainDbi: 0 } }), null, '全向给不出锥')
  assert.equal(M.hpbwOf({ kind: 'grd', id: 'x' }), null)
  assert.equal(M.coneHalfOf({ fovDeg: 17.4, antennaRef: { kind: 'param', spec: { hpbwDeg: 3 } } }), 8.7)
  assert.equal(M.coneHalfOf({ antennaRef: { kind: 'param', spec: { hpbwDeg: 3 } } }), 1.5)
  assert.equal(M.coneHalfOf({ antennaRef: null }), null)
})
ok('表格行：显示文本（数字 6 位有效、万向节显示名）、默认卫星 Ku 点波束一行', () => {
  const m = M.applyTemplate('default-sat', [], []).mounts[2]
  const r = M.mountRow(m, [])
  assert.deepEqual([r.name, r.px, r.py, r.pz, r.az, r.el, r.roll, r.gimbal, r.a1Min, r.a2Max, r.sysTempK], ['Ku 可动点波束 1', 0, 0.35, 2.462, 0, 90, 0, 'xy', -9, 9, 500])
  assert.equal(M.cellText(r, { key: 'gimbal' }), 'X-Y')
  assert.equal(M.cellText({ x: 1 / 3 }, { key: 'x', num: true }), '0.333333')
  assert.equal(M.cellText({ x: null }, { key: 'x', num: true }), '')
  assert.ok(r.antenna.startsWith('参数化'))
  assert.equal(M.MOUNT_COLS.length, 18)
})

ok('排除节点名单：带空格的名字整体保留、引号里的分隔符照留、显示 ⇄ 读回往返', () => {
  assert.deepEqual(M.parseNameList('Solar Array Left, Feed Horn；  boom\nX'), ['Solar Array Left', 'Feed Horn', 'boom', 'X'])
  assert.deepEqual(M.parseNameList('"a, b", c'), ['a, b', 'c'])
  assert.deepEqual(M.parseNameList('「x"y」;z'), ['x"y', 'z'])
  assert.deepEqual(M.parseNameList(' , ；\n'), [])
  assert.deepEqual(M.parseNameList('A, A, B'), ['A', 'B'], '去重保序')
  for (const arr of [['Solar Array Left', 'Feed Horn'], ['a, b', 'c;d', ' lead', 'q"x', 'plain'], []]) {
    assert.deepEqual(M.parseNameList(M.formatNameList(arr)), arr, JSON.stringify(arr))
  }
  // 表格往返：mountRow 的显示文本原样写回，名单不变
  const m = SCH.defaultMount({ id: 'k', posBody: [0, 0, 0], excludeNodes: ['Solar Array Left', 'a, b'] })
  const r = M.mountRow(m, [])
  assert.deepEqual(M.applyMountEdit(m, 'exclude', r.exclude).excludeNodes, ['Solar Array Left', 'a, b'])
})
ok('天线格粘贴 / 填充：显示名认回引用（选项名 · 本表别的行 · 参数化整份口径），认不出不写', () => {
  const opts = M.antennaOptions({ grdSats: [{ folder: 'f1', satName: 'S1', antennas: [{ name: 'A' }] }], lbSats: [{ ns: 'geo', id: 'sat3', name: 'X', summary: 'Ku' }] })
  const spec = { diameterM: 1.2, freqGHz: 14.25, efficiency: 0.6, pattern: 'reflector' }
  const src = SCH.defaultMount({ id: 's', posBody: [0, 0, 0], antennaRef: { kind: 'param', spec } })
  const dst = SCH.defaultMount({ id: 'd', posBody: [1, 0, 0], antennaRef: { kind: 'grd', id: 'f1|A' } })
  const ctx = { antOptions: opts, mounts: [src, dst] }
  // 源行天线格的显示名（cellRaw）粘到目标行：连效率 / 方向图类型一起过去
  const lbl = M.mountRow(src, opts).antenna
  assert.ok(lbl.startsWith('参数化'), lbl)
  assert.deepEqual(M.applyMountEdit(dst, 'antenna', lbl, ctx).antennaRef, { kind: 'param', spec })
  assert.deepEqual(M.applyMountEdit(src, 'antenna', 'S1 · A', ctx).antennaRef, { kind: 'grd', id: 'f1|A' }, '选项名')
  assert.deepEqual(M.applyMountEdit(src, 'antenna', 'X · Ku', ctx).antennaRef, { kind: 'lbAntenna', id: 'geo:sat3' }, '链路预算库条目名')
  assert.deepEqual(M.applyMountEdit(src, 'antenna', 'grd:f1|A', ctx).antennaRef, { kind: 'grd', id: 'f1|A' }, '下拉编码值')
  assert.deepEqual(M.applyMountEdit(dst, 'antenna', 'param:{"diameterM":2,"freqGHz":12}', ctx).antennaRef, { kind: 'param', spec: { diameterM: 2, freqGHz: 12 } })
  assert.equal(M.applyMountEdit(src, 'antenna', '', ctx).antennaRef, null, '清空')
  assert.equal(M.applyMountEdit(src, 'antenna', '无', ctx).antennaRef, null)
  assert.equal(M.applyMountEdit(src, 'antenna', '认不出的名字', ctx), null, '认不出 → 不写（原引用保留）')
  assert.equal(M.applyMountEdit(src, 'antenna', 'param:{bad json', ctx), null)
})
ok('视场全锥角（万向节固定天线判据）：挂点视场 → −3 dB 全宽 → 全向 360°；全向判据', () => {
  const refl = M.applyTemplate('default-sat', [], []).mounts.find((x) => x.id === 'refl_c_e')
  assert.ok(refl && refl.fovDeg === undefined, '模板固定天线不填 fov')
  near(M.fovFullOf(refl), 20.98547 / (6.175 * 2.5), 1e-12, '2.5 m @ 6.175 GHz → 70λ/D')
  assert.equal(M.fovFullOf({ fovDeg: 30, antennaRef: { kind: 'param', spec: { hpbwDeg: 3 } } }), 30)
  assert.equal(M.fovFullOf({ antennaRef: { kind: 'param', spec: { freqGHz: 2.1, gainDbi: 0, pattern: 'omni' } } }), 360)
  assert.equal(M.fovFullOf({ antennaRef: { kind: 'param', spec: { gainDbi: 2 } } }), 360, '≤ 3 dBi 只给增益 = 全向')
  assert.equal(M.fovFullOf({ antennaRef: null }), null)
  assert.equal(M.isOmni({ kind: 'param', spec: { gainDbi: 2, diameterM: 1 } }), false, '给了口径不是全向')
})
ok('掩模签名：与旧分析页内联算式逐位相同（已落盘的 maskSig 照认）；换模型 / 轴向 / 缩放 / 关节 / 挂点位置 / 排除名单即变，滚转不变', () => {
  const meta = { id: 'm1', files: { lod1: { sha256: 'ab'.repeat(32) } }, frame: { q_model2body: [0.5, 0.5, 0.5, 0.5] }, units: { scaleToMeters: 0.01 }, noObscurationNodes: ['plume'],
    articulations: [{ name: 'wing', stages: [{ name: 's', type: 'xRotate', initialValue: 10 }] }, { name: 'nostage', stages: [] }] }
  const mount = SCH.defaultMount({ id: 'a', posBody: [1, 2, 3], boresightBody: [0, 0, 1], excludeNodes: ['feed'] })
  const model = { meta, kind: 'glb', lod: 'lod1', id: 'm1' }
  const art = M.articulationStateOf(meta, {})
  assert.deepEqual(art, { wing: [10] }, '没动过取初值；无 stage 的关节不列')
  assert.deepEqual(M.articulationStateOf(meta, { wing: [42] }), { wing: [42] })
  const old = MASK.maskSignature({ modelSha: 'ab'.repeat(32), lod: 'lod1', frame: meta.frame, scaleToMeters: 0.01, articulations: art, mountPos: mount.posBody, mountBoresight: mount.boresightBody, excludeNodes: ['feed'], noObscurationNodes: ['plume'], sunBin: null })
  const sig = M.maskSigFor(model, mount, art)
  assert.equal(sig, old)
  const d = (m2, mo = model, a = art) => M.maskSigFor(mo, m2, a) !== sig
  assert.ok(d(mount, { ...model, meta: { ...meta, files: { lod1: { sha256: 'cd'.repeat(32) } } } }), '换模型文件')
  assert.ok(d(mount, { ...model, meta: { ...meta, frame: { q_model2body: [0, 0, 0, 1] } } }), '轴向')
  assert.ok(d(mount, { ...model, meta: { ...meta, units: { scaleToMeters: 1 } } }), '缩放')
  assert.ok(d(mount, model, { wing: [11] }), '关节值')
  assert.ok(d({ ...mount, posBody: [1, 2, 3.5] }), '挂点位置')
  assert.ok(d({ ...mount, excludeNodes: [] }), '排除名单')
  assert.ok(!d({ ...mount, upBody: M.upOfRoll([0, 0, 1], 40) }), '滚转不进签名')
  assert.ok(d(mount, { ...model, lod: 'lod0' }), 'lod')
  // 参数化件：lod 恒 'param'、指纹 = spec 的 FNV-32
  const pm = { meta: { id: 'tpl:x', spec: { a: 1 } }, kind: 'tpl', lod: 'lod1', id: 'tpl:x' }
  assert.equal(M.maskLodOf('tpl', 'lod1'), 'param'); assert.equal(M.maskLodOf('glb', ''), 'lod0')
  assert.ok(/^spec:[0-9a-f]+$/.test(M.maskModelSha(pm.meta, 'lod1')))
  assert.notEqual(M.maskSigFor(pm, mount, {}), M.maskSigFor({ ...pm, meta: { ...pm.meta, spec: { a: 2 } } }, mount, {}), '改参数化口径')
  assert.notEqual(M.maskSigFor(model, mount, art, 3), sig, '对日扫描档号')
})
ok('链路预算库条目：G/T · EIRP · 上行频率 · 挂的 G/T 方向图；下拉短标签；G/T 反推主瓣宽', () => {
  const geo = { ns: 'geo', id: 'g1', form: { frequencyBand: 'Ku', centerFrequency: '14.25', rxCenterFrequency: '12.5', orbitPosition: '125', sfdGtRef: '3' }, grd: { gtKey: 'CS26|GT1' } }
  assert.deepEqual(M.lbAntennaInfo(geo), { freqGHz: 14.25, gtDbK: 3, eirpDbw: null, grdKey: 'CS26|GT1' })
  assert.equal(M.lbAntennaSummary(geo), 'Ku · 14.25/12.5 GHz · G/T 3 dB/K · 125°')
  const e2e = { ns: 'e2e', id: 'e1', form: { frequencyBand: 'Ka', gt: '2', eirpSat: '46' } }
  assert.deepEqual(M.lbAntennaInfo(e2e), { freqGHz: 29.5, gtDbK: 2, eirpDbw: 46, grdKey: '' }, '没填频率按频段出厂上行频率')
  assert.equal(M.lbAntennaSummary(e2e), 'Ka · G/T 2 dB/K · EIRP 46 dBW')
  near(M.hpbwFromGt(0, 500), Math.sqrt(41253 / 500), 1e-9, 'G = 0 + 10 lg 500 ≈ 27 dBi')
  assert.equal(M.hpbwFromGt(-30, 500), null, '增益 ≤ 3 dBi 给不出主瓣')
  assert.equal(M.hpbwFromGt(null, 500), null)
  const opts = M.antennaOptions({ lbSats: [{ ...geo, name: 'CS26', summary: M.lbAntennaSummary(geo) }] })
  assert.equal(opts[2].label, 'CS26 · Ku · 14.25/12.5 GHz · G/T 3 dB/K · 125°')
})
ok('姿态律缺省判据（模板 / JSON 导入只在缺省时采用）', () => {
  assert.equal(M.isDefaultAttitude(undefined), true)
  assert.equal(M.isDefaultAttitude({ law: 'nadir', params: {} }), true)
  assert.equal(M.isDefaultAttitude({ law: 'nadir', params: { yawBiasDeg: 0 } }), true)
  assert.equal(M.isDefaultAttitude({ law: 'nadir', params: { yawBiasDeg: 5 } }), false)
  assert.equal(M.isDefaultAttitude({ law: 'yawSteer', params: {} }), false)
})

console.log(`modelWbMounts: ${n} 项通过`)
