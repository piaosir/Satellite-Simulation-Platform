// 模型工作台纯逻辑（src/model/wbLogic.js）单测：库页分段 / 搜索 / 排序、读数格式化、元数据随轴向 / 缩放 / 原点的整体变换、
// 最近 90° 基准、spec 路径工具与描红口径、部件合并拆分、部件分割结果并入、JSON 进出、路径平移。
// 裸 node 跑：wbLogic.js 只 import packages/core/models/bodyFrame.mjs（相对路径），不碰 three / vue / DOM。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const W = await import(pathToFileURL(path.join(HERE, '../../../src/model/wbLogic.js')).href)
const BF = await import(pathToFileURL(path.join(HERE, '../models/bodyFrame.mjs')).href)

let n = 0
const ok = (name, fn) => { fn(); n++ }
const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`)
const nearV = (a, b, tol = 1e-9, msg = '') => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => near(x, b[i], tol, msg + '[' + i + ']')) }
const clone = (o) => JSON.parse(JSON.stringify(o))

// ─────────────────────────── 库页：分段 / 搜索 / 排序 ───────────────────────────
const E = {
  tpl: { id: 'param:default-sat', origin: 'template', tplOrder: 0, titleZh: '默认卫星', title: 'Default satellite', source: { kind: 'param' }, local: {}, group: 'spacecraft' },
  builtin: { id: 'nasa:tdrs-a', origin: 'remote', title: 'TDRS-A', titleZh: '跟踪与数据中继卫星 A', source: { kind: 'nasa' }, local: { builtin: ['lod2'], lod2: 'ready' }, group: 'spacecraft', tags: ['tdrs', 'relay'] },
  cached: { id: 'nasa:goes', origin: 'remote', title: 'GOES', titleZh: '地球静止环境业务卫星', source: { kind: 'nasa' }, local: { lod0: 'ready' }, group: 'spacecraft' },
  cloud: { id: 'nasa:iss-b', origin: 'remote', title: 'International Space Station (B)', titleZh: '国际空间站（B）', source: { kind: 'nasa' }, local: {}, group: 'station', aliases: ['ISS'] },
  user: { id: 'user:0123456789ab', origin: 'user', title: 'bracket', source: { kind: 'user' }, local: { lod0: 'ready' }, kind: 'component' },
  stk: { id: 'stk:0123456789ab', origin: 'user', title: 'tdrs', source: { kind: 'stk-local' }, local: { lod0: 'ready' }, kind: 'spacecraft' },
  partial: { id: 'nasa:hubble', origin: 'remote', title: 'Hubble', source: { kind: 'nasa' }, local: { lod0: 'partial' }, group: 'spacecraft' }
}
ok('分段口径（互不排斥：内置件同时属于云端）', () => {
  const f = (e) => W.entryFacts(e)
  assert.deepEqual([f(E.builtin).builtin, f(E.builtin).cached, f(E.builtin).cloud], [true, false, true])
  assert.deepEqual([f(E.cached).builtin, f(E.cached).cached, f(E.cached).cloud], [false, true, true])
  assert.deepEqual([f(E.cloud).cloud, f(E.cloud).ready, f(E.cloud).cached], [true, false, false])
  assert.deepEqual([f(E.user).local, f(E.user).stk, f(E.user).cloud], [true, false, false])
  assert.deepEqual([f(E.stk).stk, f(E.stk).local, f(E.stk).cloud], [true, false, false])
  assert.deepEqual([f(E.tpl).param, f(E.tpl).ready, f(E.tpl).local], [true, true, false])
  assert.equal(f(E.partial).partial, true)
  for (const e of Object.values(E)) assert.equal(W.matchSegment(e, 'all'), true)
  assert.equal(W.matchSegment(E.stk, 'local'), false)
})
ok('搜索归一：大小写 / 全角 / 连字符 / 空白不计，别名与标签也搜', () => {
  for (const q of ['TDRS-A', 'tdrs a', 'ＴＤＲＳ', 'tdrs_a', 'relay']) assert.equal(W.matchQuery(E.builtin, q), true, q)
  assert.equal(W.matchQuery(E.cloud, 'iss'), true)
  assert.equal(W.matchQuery(E.cloud, '空间站'), true)
  assert.equal(W.matchQuery(E.cached, 'tdrs'), false)
  assert.equal(W.matchQuery(E.cached, ''), true)
})
ok('筛选 + 排序：模板按目录序在前，其余按显示名；类别下拉按 group > kind', () => {
  const list = Object.values(E)
  const all = W.filterEntries(list, { seg: 'all', lang: 'zh' })
  assert.equal(all[0].id, 'param:default-sat')
  assert.equal(all.length, list.length)
  assert.deepEqual(W.filterEntries(list, { seg: 'cloud', cat: 'station' }).map((e) => e.id), ['nasa:iss-b'])
  assert.deepEqual(W.filterEntries(list, { cat: 'component' }).map((e) => e.id), ['user:0123456789ab'])
  assert.equal(W.categoryOf({ kind: 'ground' }), 'ground')
  assert.equal(W.categoryOf({}), 'other')
  const en = W.filterEntries([E.cached, E.cloud], { lang: 'en' }).map((e) => e.id)
  assert.deepEqual(en, ['nasa:goes', 'nasa:iss-b'])
  assert.equal(W.displayName(E.builtin, 'zh'), '跟踪与数据中继卫星 A')
  assert.equal(W.displayName(E.builtin, 'en'), 'TDRS-A')
})

// ─────────────────────────── 读数格式化 ───────────────────────────
ok('数字读数：有效数字 / 去尾零 / 科学计数 / 千分位 / 字节 / 包围盒', () => {
  assert.equal(W.fmtNum(5200, 4), '5200')
  assert.equal(W.fmtNum(3.14159, 3), '3.14')
  assert.equal(W.fmtNum(0.000012345, 3), '1.23e-5')
  assert.equal(W.fmtNum(-2.5, 4), '-2.5')
  assert.equal(W.fmtNum(0, 4), '0')
  assert.equal(W.fmtNum(NaN), '—')
  assert.equal(W.fmtInt(1234567), '1,234,567')
  assert.equal(W.fmtBytes(0), '0 B')
  assert.equal(W.fmtBytes(1536), '1.50 KB')
  assert.equal(W.fmtBytes(2 * 1024 ** 3), '2.00 GB')
  assert.equal(W.fmtBox({ min: [-1, -17.1, -2], max: [1, 17.1, 3.19] }), '2 × 34.2 × 5.19')
  assert.equal(W.fmtBox(null), '—')
})

// ─────────────────────────── 元数据整体变换 ───────────────────────────
const META = {
  frame: { q_model2body: BF.DEFAULT_Q_MODEL2BODY.slice(), t_model2body: [0.1, -0.2, 0.3], verified: false },
  units: { scaleToMeters: 1, unitGuess: 'm' },
  attachPoints: [{ name: 'AP1', posBody: [1, 2, 3], dirBody: [0, 0, 1], upBody: [0, -1, 0] }],
  parts: [{ id: 'p1', name: 'dish', role: 'reflector', centroidBody: [0.5, 0, 1], normalBody: [0, 0, 1], areaM2: 2, surfaceM2: 4, extentsM: [1, 1, 0.2],
    fitted: { vertexBody: [0, 0, 1], focusBody: [0, 0, 2], axisBody: [0, 0, 1], focalM: 1, diameterM: 2, offsetM: 0.5, rmsRel: 0.001 } }],
  massProps: { massKg: 100, comBody: [0.1, 0.2, 0.3], inertiaBody: [[10, 1, 2], [1, 20, 3], [2, 3, 30]], source: 'manual', confidence: 'high' },
  geometry: { bboxM: { min: [-1, -2, -3], max: [1, 2, 3] }, boundingRadiusM: 4, areaM2: 50, volumeM3: 8, centroidM: [0, 0, 0.5] }
}
ok('缩放 ×k：长度 ×k、面积 ×k²、体积 ×k³、惯量 ×k²、质量不变、方向不变；来回一趟回到原值', () => {
  const k = 2.5
  const m = W.rescaleMeta(META, k)
  nearV(m.attachPoints[0].posBody, [2.5, 5, 7.5])
  nearV(m.attachPoints[0].dirBody, [0, 0, 1])
  nearV(m.frame.t_model2body, [0.25, -0.5, 0.75])
  near(m.parts[0].areaM2, 2 * k * k); near(m.parts[0].surfaceM2, 4 * k * k)
  near(m.parts[0].fitted.focalM, k); near(m.parts[0].fitted.diameterM, 2 * k)
  near(m.geometry.volumeM3, 8 * k ** 3); near(m.geometry.boundingRadiusM, 4 * k)
  near(m.massProps.massKg, 100)
  near(m.massProps.inertiaBody[1][1], 20 * k * k)
  nearV(m.geometry.bboxM.max, [2.5, 5, 7.5])
  const back = W.rescaleMeta(m, 1 / k)
  nearV(back.attachPoints[0].posBody, META.attachPoints[0].posBody, 1e-12)
  near(back.massProps.inertiaBody[2][2], 30, 1e-9)
  assert.deepEqual(W.rescaleMeta(META, 1), clone(META))
  assert.notEqual(W.rescaleMeta(META, 2), META)   // 不改入参
  assert.deepEqual(META.attachPoints[0].posBody, [1, 2, 3])
})
ok('轴向改变：本体系量随模型同转（点 / 方向 / 惯量 ΔR·I·ΔRᵀ / t），迹不变；转回来复原', () => {
  const q0 = META.frame.q_model2body
  const q1 = BF.axisStep(q0, 'x', 90)
  const m = W.reframeMeta(META, q0, q1)
  // 本体 X 轴 +90°：(x, y, z) → (x, −z, y)
  nearV(m.attachPoints[0].posBody, [1, -3, 2], 1e-12)
  nearV(m.attachPoints[0].dirBody, [0, -1, 0], 1e-12)
  nearV(m.attachPoints[0].upBody, [0, 0, -1], 1e-12)
  nearV(m.parts[0].fitted.axisBody, [0, -1, 0], 1e-12)
  const I = m.massProps.inertiaBody
  near(I[0][0] + I[1][1] + I[2][2], 60, 1e-9)
  near(I[1][1], 30, 1e-9); near(I[2][2], 20, 1e-9)
  nearV(m.frame.t_model2body, [0.1, -0.3, -0.2], 1e-12)
  assert.ok(W.sameRotation(m.frame.q_model2body, q1))
  const back = W.reframeMeta(m, q1, q0)
  nearV(back.attachPoints[0].posBody, [1, 2, 3], 1e-12)
  nearV(back.massProps.inertiaBody[0], [10, 1, 2], 1e-9)
})
ok('原点平移：点平移、方向 / 惯量不变；「原点移到质心」后质心落在原点', () => {
  const m = W.retranslateMeta(META, META.massProps.comBody.map((v) => -v))
  nearV(m.massProps.comBody, [0, 0, 0], 1e-15)
  nearV(m.attachPoints[0].posBody, [0.9, 1.8, 2.7], 1e-12)
  nearV(m.attachPoints[0].dirBody, [0, 0, 1])
  nearV(m.frame.t_model2body, [0, -0.4, 0], 1e-12)
  assert.deepEqual(m.massProps.inertiaBody, META.massProps.inertiaBody)
  assert.deepEqual(W.retranslateMeta(META, [0, 0, 0]), clone(META))
  // 轴映射终案 ④：bboxM 是模型轴口径，平移原点（在模型系之后）不改它
  assert.deepEqual(m.geometry.bboxM, META.geometry.bboxM)
})
ok('bboxM 模型轴口径（轴映射终案 ④）：换轴向 / 平移不动它、缩放 ×k；本体系包围盒由 frame 现算，与模型轴互逆', () => {
  const q0 = META.frame.q_model2body
  const m = W.reframeMeta(META, q0, BF.axisStep(q0, 'z', 90))
  assert.deepEqual(m.geometry.bboxM, META.geometry.bboxM, '换轴向')
  // STK 映射：body = (m.z, m.x, m.y)；模型轴 [−1,1]×[−2,2]×[−3,3] → 本体 X∈[−3,3]、Y∈[−1,1]、Z∈[−2,2]，再加 t
  const bb = W.bodyBoxOfMeta(META)
  nearV(bb.min, [-3 + 0.1, -1 - 0.2, -2 + 0.3], 1e-12); nearV(bb.max, [3 + 0.1, 1 - 0.2, 2 + 0.3], 1e-12)
  const back = W.bodyBoxToModelBox(bb, META.frame)
  nearV(back.min, META.geometry.bboxM.min, 1e-12); nearV(back.max, META.geometry.bboxM.max, 1e-12)
  // 附录 B（+Y 天顶）：glTF +Y ↦ 本体 −Z
  const yz = { ...clone(META), frame: { q_model2body: BF.Q_YUP_ZENITH.slice(), t_model2body: [0, 0, 0] } }
  const b2 = W.bodyBoxOfMeta(yz)
  nearV([b2.min[2], b2.max[2]], [-2, 2], 1e-12)
  assert.equal(W.bodyBoxOfMeta({ geometry: {} }), null)
  assert.equal(W.bodyBoxToModelBox(null, META.frame), null)
})
ok('最近的 90° 整数倍朝向：24 个轴向基准各加小扰动都回到自己；行列式 +1', () => {
  const bases = []
  let q = [0, 0, 0, 1]
  const seen = new Set()
  const key = (x) => BF.quatCanonical(x).map((v) => v.toFixed(6)).join(',')
  const stack = [q]
  while (stack.length) {
    const c = stack.pop(); const k = key(c)
    if (seen.has(k)) continue
    seen.add(k); bases.push(c)
    for (const ax of ['x', 'y', 'z']) stack.push(BF.axisStep(c, ax, 90))
  }
  assert.equal(bases.length, 24)
  for (const b of bases) {
    const p = BF.fineRotate(b, 3.1, -2.2, 4.4)
    const r = W.nearestAxisQuat(p)
    assert.ok(W.sameRotation(r, b, 1e-6), 'base ' + key(b))
    const R = BF.quatToMat(r)
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0])
    near(det, 1, 1e-9)
  }
})

// ─────────────────────────── spec 路径 / 出处 / 描红 ───────────────────────────
ok('spec 路径：解析 / 读 / 写（缺层按下一个键补对象或数组）/ [*] 通配键', () => {
  assert.deepEqual(W.parsePath('wings[0].panelHM'), ['wings', 0, 'panelHM'])
  assert.deepEqual(W.parsePath('a.b[2][3].c'), ['a', 'b', 2, 3, 'c'])
  const o = {}
  W.setPath(o, 'wings[1].panelHM', 3.3)
  assert.ok(Array.isArray(o.wings)); assert.equal(o.wings[1].panelHM, 3.3)
  assert.equal(W.getPath(o, 'wings[1].panelHM'), 3.3)
  assert.equal(W.getPath(o, 'wings[5].panelHM'), undefined)
  assert.equal(W.sourceKey('reflectors[12].diameterM'), 'reflectors[*].diameterM')
})
ok('出处 title：精确键优先、[*] 通配兜底；示意 / 推算标注', () => {
  const ss = {
    'bus.xM': { source: 'https://example.org/a', kind: 'source' },
    'wings[*].panelHM': { source: 'https://example.org/b', note: '表 2', kind: 'source' },
    'wings[0].panelHM': { source: 'illustrative', note: '示意值 3 m', kind: 'illustrative' },
    'wings[*].yokeLenM': { source: 'derived', note: '端到端 − 平台', kind: 'derived', from: 'https://example.org/c' }
  }
  assert.equal(W.sourceTitle(ss, 'bus.xM'), 'https://example.org/a')
  assert.equal(W.sourceTitle(ss, 'wings[1].panelHM'), 'https://example.org/b\n表 2')
  assert.equal(W.sourceTitle(ss, 'wings[0].panelHM'), '示意值\n示意值 3 m')
  assert.equal(W.sourceTitle(ss, 'wings[1].yokeLenM'), '推算值\n端到端 − 平台\nhttps://example.org/c')
  assert.equal(W.sourceTitle(ss, 'nope'), '')
})
ok('描红口径：整体被点名时其字段也算；前缀不串名（wings 不点名 wingsX）', () => {
  assert.equal(W.pathFlagged(['wings'], 'wings[0].panels'), true)
  assert.equal(W.pathFlagged(['wings[0].panels'], 'wings[0].panels'), true)
  assert.equal(W.pathFlagged(['wings[0].panels'], 'wings[1].panels'), false)
  assert.equal(W.pathFlagged(['bus'], 'busX'), false)
  assert.equal(W.pathFlagged([], 'x'), false)
})
ok('删条目后路径平移：arr[i] 的删掉、后面的前移、别的数组不动', () => {
  const p = ['wings[0].panels', 'wings[1].panelHM', 'wings[2]', 'reflectors[1].diameterM', 'bus.xM', 'wings']
  assert.deepEqual(W.shiftIndexedPaths(p, 'wings', 1), ['wings[0].panels', 'wings[1]', 'reflectors[1].diameterM', 'bus.xM', 'wings'])
  assert.deepEqual(W.shiftIndexedPaths(new Set(['reflectors[0].slot', 'reflectors[3].focalM']), 'reflectors', 0), ['reflectors[2].focalM'])
})

// ─────────────────────────── 名称 / 部件 ───────────────────────────
ok('唯一名：空白换下划线、_2 _3 顺延', () => {
  assert.equal(W.uniqueName('AP 1', []), 'AP_1')
  assert.equal(W.uniqueName('AP', ['AP', 'AP_2']), 'AP_3')
  assert.equal(W.uniqueName('', []), 'item')
})
const PARTS = [
  { id: 'a', name: 'wingA', role: 'solarArray', nodes: ['n1'], areaM2: 2, centroidBody: [0, 2, 0], tris: 10, massKg: 5 },
  { id: 'b', name: 'wingB', role: 'solarArray', nodes: ['n2'], triRanges: [{ node: 'n9', mesh: 0, ranges: [[0, 4]] }], areaM2: 6, centroidBody: [0, -2, 0], tris: 4, massKg: 7, fitted: { focalM: 1 } },
  { id: 'c', name: 'bus', role: 'bus', nodes: ['n3'], areaM2: 10 }
]
ok('合并部件：节点 / 三角形段并起来、面积相加、质心按面积加权、质量相加、拟合作废、位置在第一个', () => {
  const out = W.mergeParts(PARTS, ['a', 'b'])
  assert.equal(out.length, 2)
  assert.equal(out[0].id, 'a')
  assert.deepEqual(out[0].nodes, ['n1', 'n2'])
  assert.equal(out[0].triRanges.length, 1)
  near(out[0].areaM2, 8); nearV(out[0].centroidBody, [0, -1, 0]); near(out[0].massKg, 12)
  assert.equal(out[0].fitted, undefined)
  assert.equal(out[1].id, 'c')
  assert.deepEqual(W.mergeParts(PARTS, ['a']).map((p) => p.id), ['a', 'b', 'c'])
})
ok('按节点拆分：每个节点一个部件，三角形段跟着节点走', () => {
  const out = W.splitPartByNodes(PARTS, 'b')
  assert.deepEqual(out.map((p) => p.id), ['a', 'b', 'b_2', 'c'])
  assert.deepEqual(out[1].nodes, ['n2'])
  assert.deepEqual(out[2].triRanges, [{ node: 'n9', mesh: 0, ranges: [[0, 4]] }])
  assert.equal(new Set(out.map((p) => p.name)).size, out.length)
})
ok('组件质量表：只收质量为正的；质心取 comBody > centroidBody', () => {
  const c = W.partsAsComponents([...PARTS, { id: 'd', massKg: 3, comBody: [9, 9, 9], centroidBody: [1, 1, 1] }, { id: 'e', massKg: 0, centroidBody: [0, 0, 0] }])
  assert.deepEqual(c.map((x) => x.massKg), [5, 7, 3])
  assert.deepEqual(c[2].comBody, [9, 9, 9])
})
ok('点选命中 → 部件：三角形段 > 整节点 > 全局段', () => {
  const parts = [...PARTS, { id: 'g', triRange: [100, 10] }]
  assert.equal(W.partAtHit(parts, { irNode: 'n9', irTri: 2, globalTri: 0 }).id, 'b')
  assert.equal(W.partAtHit(parts, { irNode: 'n3', irTri: 0, globalTri: 5 }).id, 'c')
  assert.equal(W.partAtHit(parts, { irNode: 'zz', irTri: 0, globalTri: 105 }).id, 'g')
  assert.equal(W.partAtHit(parts, { irNode: 'zz', irTri: 0, globalTri: 999 }), null)
})
ok('部件分割结果并入：手填质量 / 确认 / 手改角色按名继承；已有挂点一个不动；没有挂点才补自动挂点；已有太阳翼组不动', () => {
  const meta = { parts: [{ id: 'x', name: 'wingA', role: 'other', roleManual: true, massKg: 9, confirmed: true }], attachPoints: [{ name: 'AGI_AP', posBody: [0, 0, 0], dirBody: [0, 0, 1] }], solarPanelGroups: [{ name: 'G1', nodes: ['n1'], efficiency: 30 }] }
  const seg = { parts: [{ id: 'p1', name: 'wingA', role: 'solarArray' }, { id: 'p2', name: 'bus', role: 'bus' }], attachPoints: [{ name: 'refl_focus', posBody: [1, 0, 0], dirBody: [0, 0, 1] }], solarPanelGroups: [{ name: 'SolarArray1', nodes: [] }] }
  const m = W.mergeSegment(meta, seg)
  assert.equal(m.parts.length, 2)
  assert.deepEqual([m.parts[0].massKg, m.parts[0].confirmed, m.parts[0].role], [9, true, 'other'])
  assert.deepEqual(m.attachPoints.map((a) => a.name), ['AGI_AP'])
  assert.deepEqual(m.solarPanelGroups.map((g) => g.name), ['G1'])
  const m2 = W.mergeSegment({}, seg)
  assert.deepEqual(m2.attachPoints.map((a) => a.name), ['refl_focus'])
  assert.deepEqual(m2.solarPanelGroups, [{ name: 'SolarArray1', nodes: [], efficiency: 28 }])
  assert.equal(meta.parts[0].role, 'other')   // 不改入参
})

// ─────────────────────────── JSON 进出 ───────────────────────────
ok('JSON 导入：挂点数组 / 只挂点对象 / 整份元数据（id · source · files 不许覆盖）/ 非法', () => {
  const base = { id: 'user:1', source: { kind: 'user' }, files: { lod0: { sha256: 'x' } }, title: 'A', attachPoints: [] }
  const r1 = W.applyJsonImport(base, [{ name: 'a', posBody: [0, 0, 0], dirBody: [0, 0, 1] }])
  assert.equal(r1.ok, true); assert.equal(r1.what, 'attach'); assert.equal(r1.meta.attachPoints.length, 1)
  const r2 = W.applyJsonImport(base, { attachPoints: [{ name: 'b', posBody: [1, 1, 1] }] })
  assert.equal(r2.what, 'attach'); assert.equal(r2.meta.attachPoints[0].name, 'b')
  const r3 = W.applyJsonImport(base, { id: 'evil', source: { kind: 'nasa' }, files: {}, title: 'B', frame: { q_model2body: [0, 0, 0, 1] }, massProps: { massKg: 1 } })
  assert.equal(r3.what, 'meta'); assert.deepEqual(r3.fields.sort(), ['frame', 'massProps', 'title'])
  assert.equal(r3.meta.id, 'user:1'); assert.equal(r3.meta.source.kind, 'user'); assert.deepEqual(r3.meta.files, base.files); assert.equal(r3.meta.title, 'B')
  assert.equal(W.applyJsonImport(base, [{ name: 'x' }]).ok, false)
  assert.equal(W.applyJsonImport(base, 'str').ok, false)
  assert.equal(W.applyJsonImport(base, { foo: 1 }).ok, false)
})
ok('JSON 导出：去掉本机专用字段；挂点子集', () => {
  const m = W.metaForExport({ id: 'a', local: { lod0: 'ready' }, origin: 'remote', builtin: ['lod2'], overridesId: 'a', tplOrder: 1, title: 'T' })
  assert.deepEqual(m, { id: 'a', title: 'T' })
  assert.deepEqual(W.attachSubset({ attachPoints: [{ name: 'q' }] }), { attachPoints: [{ name: 'q' }] })
})

// ─────────────────────────── 杂项 ───────────────────────────
ok('导入格式分派 / 扩展名', () => {
  assert.equal(W.importRoute('a.GLB'), 'glb'); assert.equal(W.importRoute('a.gltf'), 'glb')
  assert.equal(W.importRoute('x.obj'), 'mesh'); assert.equal(W.importRoute('x.STL'), 'mesh'); assert.equal(W.importRoute('x.fbx'), 'mesh')
  for (const e of ['step', 'stp', 'iges', 'igs', 'brep']) assert.equal(W.importRoute('m.' + e), 'cad')
  assert.equal(W.importRoute('m.3ds'), null); assert.equal(W.importRoute('noext'), null)
  assert.equal(W.extOf('C:\\a.b\\c.StP'), 'stp')
})
ok('同一旋转判定（q 与 −q、容差按角度）', () => {
  const q = BF.DEFAULT_Q_MODEL2BODY
  assert.ok(W.sameRotation(q, q.map((v) => -v)))
  assert.ok(!W.sameRotation(q, BF.axisStep(q, 'z', 90)))
  assert.ok(W.sameRotation(q, BF.fineRotate(q, 0, 0, 1e-8), 1e-6))
})

// ─────────────────────────── 修复轮（2026-09-24 审查）───────────────────────────
ok('来源短标签：只给短词，整句署名不上界面', () => {
  assert.equal(W.sourceTag({ source: { kind: 'nasa', credit: 'NASA/JPL-Caltech 很长一句' } }), 'NASA')
  assert.equal(W.sourceTag({ source: { kind: 'stk-local' } }), 'AGI STK')
  assert.equal(W.sourceTag({ source: { kind: 'param', credit: '卫星仿真平台参数化生成；尺寸参照 CAST 平台通用指标' } }), '参数化')
  assert.equal(W.sourceTag({}), ''); assert.equal(W.sourceTag(null), '')
  for (const k of Object.keys(W.SOURCE_TAG)) assert.ok(W.SOURCE_TAG[k].length <= 8 && !/[；。，]/.test(W.SOURCE_TAG[k]))
  assert.deepEqual(Object.keys(W.SOURCE_TAG).sort(), Object.keys(W.SOURCE_LABEL).sort())
})
ok('STL 单位兜底：只在「包围盒判厘米」那一档改毫米；别的格式 / 档位原样', () => {
  const cm = { unitGuess: 'cm', scaleToMeters: 0.01, rule: 'bbox', confidence: 'low', notes: ['x'] }
  const r = W.meshUnitTieBreak(cm, 'stl')
  assert.deepEqual([r.unitGuess, r.scaleToMeters, r.rule], ['mm', 0.001, 'stl-mm'])
  assert.equal(r.notes.length, 2); assert.equal(cm.unitGuess, 'cm')   // 不改入参
  assert.equal(W.meshUnitTieBreak(cm, 'STL').unitGuess, 'mm')
  assert.equal(W.meshUnitTieBreak(cm, 'obj'), cm)
  assert.equal(W.meshUnitTieBreak({ ...cm, rule: 'exporter' }, 'stl').unitGuess, 'cm')
  assert.equal(W.meshUnitTieBreak({ unitGuess: 'm', scaleToMeters: 1, rule: 'bbox' }, 'stl').unitGuess, 'm')
  assert.equal(W.meshUnitTieBreak(null, 'stl'), null)
  // 夹具 cubesat3u_mm.stl：最大边 660 → 0.66 m（不再是 6.6 m）
  assert.equal(660 * W.meshUnitTieBreak(cm, 'stl').scaleToMeters, 0.66)
})
ok('最近导入恢复：没走完的作业不再挂着「排队 / 读取」；已入库的记完成 + 中断', () => {
  assert.deepEqual(W.restoreJob({ id: 'a', name: 'x.stp', phase: 'queued' }), { id: 'a', name: 'x.stp', phase: 'canceled', live: false })
  assert.equal(W.restoreJob({ id: 'b', name: 'x', phase: 'read' }).phase, 'canceled')
  const c = W.restoreJob({ id: 'c', name: 'x', phase: 'segment', modelId: 'user:1', error: '' })
  assert.deepEqual([c.phase, c.error, c.live], ['done', '分析已中断', false])
  assert.equal(W.restoreJob({ id: 'd', name: 'x', phase: 'thumb', modelId: 'user:1', error: '缩略图失败' }).error, '缩略图失败；分析已中断')
  for (const p of ['done', 'error', 'canceled']) assert.equal(W.restoreJob({ id: 'e', name: 'x', phase: p, error: 'q' }).phase, p)
  assert.equal(W.restoreJob({ id: 'f', name: 'x', phase: 'done', live: true }).live, false)
})
ok('能否取消：排队都能；CAD 入库前能；OBJ/STL/FBX 读取 / 转换时能；glb 跑起来不能；分析阶段不能', () => {
  const J = (o) => ({ live: true, ...o })
  assert.equal(W.canCancelJob(J({ phase: 'queued', route: 'glb' })), true)
  assert.equal(W.canCancelJob(J({ phase: 'read', route: 'glb' })), false)
  assert.equal(W.canCancelJob(J({ phase: 'read', route: 'mesh' })), true)
  assert.equal(W.canCancelJob(J({ phase: 'convert', route: 'mesh' })), true)
  assert.equal(W.canCancelJob(J({ phase: 'write', route: 'mesh' })), false)
  assert.equal(W.canCancelJob(J({ phase: 'simplify', route: 'cad', token: 't' })), true)
  assert.equal(W.canCancelJob(J({ phase: 'start', route: 'cad' })), false)   // 还没拿到令牌
  for (const p of ['analyze', 'segment', 'mass', 'thumb', 'done', 'error', 'canceled']) assert.equal(W.canCancelJob(J({ phase: p, route: 'cad', token: 't' })), false)
  assert.equal(W.canCancelJob({ live: false, phase: 'queued' }), false)
  assert.equal(W.canCancelJob(J({ phase: 'queued', route: 'stk' })), true)
  assert.equal(W.canCancelJob(J({ phase: 'read', route: 'stk' })), false)
})
ok('重开已存参数化模型：存档里的质量特性 / 轴向 / 效率 / 挂点赢，缺的才用生成结果', () => {
  const regen = { frame: { q_model2body: [0.5, 0.5, 0.5, 0.5] }, units: { scaleToMeters: 1 }, parts: [{ id: 'bus' }], massProps: { massKg: 5200, source: 'components' },
    articulations: [{ name: 'wing', stages: [] }], solarPanelGroups: [{ name: 'G', efficiency: 28 }], geometry: { tris: 10 }, attachPoints: [{ name: 'ap' }] }
  const stored = { id: 'param:0123456789ab', spec: { a: 1 }, massProps: { massKg: 5000, source: 'manual' }, frame: { q_model2body: [0, 0, 0, 1] }, solarPanelGroups: [{ name: 'G', efficiency: 30 }], attachPoints: [] }
  const m = W.mergeParamMeta(stored, regen)
  assert.equal(m.massProps.massKg, 5000); assert.equal(m.massProps.source, 'manual')
  assert.deepEqual(m.frame.q_model2body, [0, 0, 0, 1])
  assert.equal(m.solarPanelGroups[0].efficiency, 30)
  assert.deepEqual(m.attachPoints, [])            // 用户删光了挂点：照存档，不从生成结果补回来
  assert.deepEqual(m.parts, [{ id: 'bus' }])      // 存档没有的字段才取生成结果
  assert.equal(m.geometry.tris, 10)
  assert.equal(m.id, 'param:0123456789ab'); assert.deepEqual(m.spec, { a: 1 })
  assert.equal(stored.parts, undefined)           // 不改入参
  assert.deepEqual(W.mergeParamMeta(null, regen).massProps, regen.massProps)
})
ok('关节编辑：新 stage 名唯一、量程按量纲；改类型同量纲留量程、换量纲换缺省；新关节名唯一且合 AGI 命名', () => {
  assert.deepEqual(W.stageDefaults('yRotate'), { minimumValue: -180, maximumValue: 180, initialValue: 0 })
  assert.deepEqual(W.stageDefaults('zTranslate'), { minimumValue: -1, maximumValue: 1, initialValue: 0 })
  assert.deepEqual(W.stageDefaults('uniformScale'), { minimumValue: 0, maximumValue: 1, initialValue: 1 })
  const s1 = W.newStage([], 'xRotate')
  assert.deepEqual(s1, { name: 'Rotate', type: 'xRotate', minimumValue: -180, maximumValue: 180, initialValue: 0 })
  assert.equal(W.newStage([s1], 'zRotate').name, 'Rotate_2')
  assert.equal(W.newStage([s1], 'uniformScale').name, 'Scale')
  assert.equal(W.newStage([], 'bogus').type, 'zRotate')
  const custom = { name: 'Az', type: 'zRotate', minimumValue: -90, maximumValue: 90, initialValue: 10 }
  assert.deepEqual(W.retypeStage(custom, 'xRotate'), { ...custom, type: 'xRotate' })
  assert.deepEqual(W.retypeStage(custom, 'xTranslate'), { name: 'Az', type: 'xTranslate', minimumValue: -1, maximumValue: 1, initialValue: 0 })
  assert.equal(W.retypeStage(custom, 'nope'), custom)
  const a = W.newArticulation(['Articulation'], ['n1'])
  assert.equal(a.name, 'Articulation_2'); assert.deepEqual(a.nodes, ['n1']); assert.equal(a.stages.length, 1)
  assert.ok(/^[^\s]+$/.test(a.name) && a.stages.every((s) => /^[^\s]+$/.test(s.name)))
  assert.deepEqual(W.STAGE_TYPE_LIST.slice().sort(), ['uniformScale', 'xRotate', 'xScale', 'xTranslate', 'yRotate', 'yScale', 'yTranslate', 'zRotate', 'zScale', 'zTranslate'])
  for (const t of W.STAGE_TYPE_LIST) assert.ok(W.STAGE_LABEL[t])
})

console.log(`modelWorkbench: ${n} 项通过`)
