// IR（中间表示）自测（packages/core/models/ir.mjs）。运行：node packages/core/test/modelIr.test.mjs
//
// 为什么测：paramBus / occt / OBJ·STL·FBX 三条来源都经 IR 进渲染与分析；IR 的统计（包围盒、面积、三角形数）
// 直接进 ModelMeta.geometry 与工作台读数，节点名唯一化决定 gmdf 能不能对上。这里钉死：
// ① 构造器的归一与类型转换；② 世界矩阵按父子链相乘、同一网格多实例各算一次；③ 面积 / 包围盒对解析值；
// ④ validateIR 抓住每一类坏数据且不抛，2 万层深链不爆栈；⑤ 节点名唯一化规则（不抢别人的原名、保留原名映射）与线性耗时。
import assert from 'node:assert/strict'
import * as I from '../models/ir.mjs'

let pass = 0
const ok = (c, msg) => { assert.ok(c, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const near = (a, b, tol, msg) => { const A = [a].flat(), Bv = [b].flat(); assert.equal(A.length, Bv.length, msg); A.forEach((x, i) => assert.ok(Math.abs(x - Bv[i]) <= tol, `${msg}：${x} vs ${Bv[i]}`)); pass++ }

// 单位立方体 [-0.5, 0.5]³，12 个三角形，外法向绕向
const cube = () => ({
  position: [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5],
  index: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]
})
// 列主序：缩放 s + 平移 t
const TS = (s, t) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, t[0], t[1], t[2], 1]

// ① 构造器
const ir = I.makeIR({ unitHint: 'mm', sourceFormat: 'step' })
eq([ir.units, ir.unitHint, ir.sourceFormat, ir.materials.length], ['m', 'mm', 'step', 0], 'makeIR')
eq(I.makeIR({ unitHint: 'furlong', sourceFormat: 'dwg' }).unitHint, 'unknown', '非法 unitHint → unknown')
eq(I.makeIR(null).sourceFormat, 'param', '非对象参数 → 缺省')
const m0 = I.addMaterial(ir, { name: 'gold', key: 'mli_gold', color: [2, -1, 0.5], metalness: 3, roughness: -2, opacity: 0.3, doubleSided: true, emissive: [0, 0, 5] })
eq(ir.materials[m0], { name: 'gold', key: 'mli_gold', color: [1, 0, 0.5], metalness: 1, roughness: 0, opacity: 0.3, doubleSided: true, emissive: [0, 0, 1] }, '材质字段钳到 0..1')
const m1 = I.addMaterial(ir, { key: 'unobtainium' })
ok(!('key' in ir.materials[m1]) && ir.materials[m1].name === 'material_1' && ir.materials[m1].roughness === 0.5, '未知材质键丢掉、缺省名与粗糙度')
const me = I.addMesh(ir, { ...cube(), material: m0 })
ok(ir.meshes[me].position instanceof Float32Array && ir.meshes[me].index instanceof Uint32Array, '普通数组转成契约的 TypedArray')
const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const me2 = I.addMesh(ir, { position: pos, material: m1 })
ok(ir.meshes[me2].position === pos, '已是 Float32Array 不拷贝')
eq(Array.from(ir.meshes[me2].index), [0, 1, 2], '没给 index → 按非索引三角形生成')
const ir0 = I.makeIR()
I.addMesh(ir0, { position: pos })
eq([ir0.materials.length, ir0.meshes[0].material], [1, 0], '没有材质时自动补一个默认材质')
const root = I.addNode(ir, { name: 'bus', mesh: me, matrix: TS(2, [10, 0, 0]), role: 'bus', extras: { a: 1 } })
const child = I.addNode(ir, { name: 'bus_copy', parent: root, mesh: me, matrix: TS(1, [0, 5, 0]), role: 'nonsense' })
const tri = I.addNode(ir, { name: '', mesh: me2 })
eq(ir.nodes[tri].name, `node_${tri}`, '空名 → node_<下标>')
ok(!('role' in ir.nodes[child]), '非法 role 不写')
ok(I.validateIR(ir).ok, '构造出的 IR 通过校验')

// ② 世界矩阵 ③ 统计
const W = I.nodeWorldMatrices(ir)
eq(W[child].slice(12, 15), [10, 10, 0], '子节点世界平移 = 父缩放 × 子平移 + 父平移')
const st = I.irStats(ir)
eq([st.tris, st.instances], [12 + 12 + 1, 3], '同一网格两个实例各算一次')
// 父：边长 2 的立方体（面积 24），子：继承父缩放 2 → 边长 2（面积 24），三角形 0.5
near(st.areaM2, 24 + 24 + 0.5, 1e-9, '表面积对解析值')
near([...st.bboxM.min, ...st.bboxM.max], [0, -1, -1, 11, 11, 1], 1e-9, '包围盒（含三角形实例 [0,1]²）')
near(st.radiusFromOriginM, Math.hypot(11, 11, 1), 1e-9, '离原点最远距离')
const flat = I.makeIR(); I.addMesh(flat, cube())
const fs = I.irStats(flat)
eq([fs.tris, fs.instances], [12, 1], '没有节点：每个网格按单位矩阵统计一次')
near(fs.areaM2, 6, 1e-12, '单位立方体面积 6')
const iso = I.makeIR(); I.addMesh(iso, { position: [0, 0, 0, 1, 0, 0, 0, 1, 0, 100, 100, 100], index: [0, 1, 2] })
near(I.irStats(iso).bboxM.max, [1, 1, 0], 0, '孤立顶点不撑大包围盒')
const deg = I.makeIR(); I.addMesh(deg, { position: [0, 0, 0, 1, 1, 1, 2, 2, 2], index: [0, 1, 2] })
eq([I.irStats(deg).tris, I.irStats(deg).areaM2], [1, 0], '退化三角形计数、面积 0')
eq(I.irStats(null), { tris: 0, vertices: 0, bboxM: null, areaM2: 0, radiusFromOriginM: 0, instances: 0 }, '坏输入 → 全零不抛')
eq(I.irStats(I.makeIR()).bboxM, null, '空 IR → bboxM null')
// 旋转 90°（绕 Z）：包围盒随之换轴
const rot = I.makeIR(); const rm = I.addMesh(rot, { position: [0, 0, 0, 3, 0, 0, 0, 1, 0], index: [0, 1, 2] })
I.addNode(rot, { name: 'r', mesh: rm, matrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })
near([...I.irStats(rot).bboxM.min, ...I.irStats(rot).bboxM.max], [-1, 0, 0, 0, 3, 0], 1e-12, '节点旋转作用到包围盒')

// ④ 校验抓坏数据
const bad = (mut, frag, msg) => {
  const x = I.makeIR(); I.addMaterial(x, {}); I.addMesh(x, cube()); I.addNode(x, { name: 'a', mesh: 0 }); I.addNode(x, { name: 'b', parent: 0 })
  mut(x)
  const r = I.validateIR(x)
  assert.ok(!r.ok && r.errors.some((e) => e.includes(frag)), `${msg}：${JSON.stringify(r.errors)}`)
  pass++
}
bad((x) => { x.units = 'mm' }, 'units', 'units 不是 m')
bad((x) => { x.sourceFormat = 'dwg' }, 'sourceFormat', '来源格式非法')
bad((x) => { x.nodes[1].name = 'a' }, '重名', '节点重名')
bad((x) => { x.nodes[1].name = '  ' }, 'name', '节点空名')
bad((x) => { x.meshes[0].index[5] = 99 }, '越界', '索引越界')
bad((x) => { x.meshes[0].position[4] = NaN }, '有限数', '顶点 NaN')
bad((x) => { x.meshes[0].position = [0, 0, 0] }, 'Float32Array', '顶点不是 Float32Array')
bad((x) => { x.meshes[0].normal = new Float32Array(3) }, 'normal', '法线长度不符')
bad((x) => { x.meshes[0].uv = new Float32Array(3) }, 'uv', 'UV 长度不符')
bad((x) => { x.meshes[0].index = new Uint32Array([0, 1]) }, '3 的倍数', '索引长度不是 3 的倍数')
bad((x) => { x.meshes[0].material = 7 }, 'material', '材质下标越界')
bad((x) => { x.nodes[0].parent = 1 }, '成环', 'parent 成环')
bad((x) => { x.nodes[1].parent = 9 }, 'parent', 'parent 越界')
bad((x) => { x.nodes[0].matrix = [1, 2, 3] }, 'matrix', 'matrix 不是 16 个数')
bad((x) => { x.nodes[0].role = 'antenna' }, 'role', 'role 非法')
bad((x) => { x.nodes[0].mesh = 3 }, 'mesh', '网格下标越界')
bad((x) => { x.materials[0].color = [1, 1] }, 'color', '颜色不是三元组')
bad((x) => { x.materials[0].key = 'x' }, 'key', '材质键不在库里')
eq(I.validateIR('ir').ok, false, '非对象 IR')
eq(I.validateIR({ units: 'm', unitHint: 'm', sourceFormat: 'glb' }).errors.length, 3, '缺 materials / meshes / nodes 各记一条')
const cyc = I.makeIR(); I.addNode(cyc, { name: 'p' }); I.addNode(cyc, { name: 'q', parent: 0 }); cyc.nodes[0].parent = 1
eq(I.nodeWorldMatrices(cyc), [null, null], '成环节点世界矩阵为 null（统计时跳过）')
eq(I.irStats(cyc).instances, 0, '成环 IR 统计不死循环')
// 深链：2 万层、父下标大于子下标（递归实现在这里爆栈，irStats 跟着抛）
const DEEP = 20000
const deepIr = I.makeIR()
I.addMesh(deepIr, cube())
for (let i = 0; i < DEEP; i++) I.addNode(deepIr, { name: `n${i}`, parent: i + 1 < DEEP ? i + 1 : -1, matrix: TS(1, [0, 0, 1]), mesh: i === 0 ? 0 : undefined })
let deepSt = null
try { deepSt = I.irStats(deepIr) } catch (e) { deepSt = e }
ok(!(deepSt instanceof Error) && deepSt.instances === 1, `反向 ${DEEP} 层父子链：irStats 不抛`)
near([deepSt.bboxM.min[2], deepSt.bboxM.max[2]], [DEEP - 0.5, DEEP + 0.5], 1e-9, '叶节点的平移沿链累加')
eq(I.nodeWorldMatrices({ nodes: [{ name: 'a', parent: 5 }, { name: 'b', parent: 0 }, 'x', { name: 'c', parent: 2 }] }), [null, null, null, null], '父下标越界 / 父节点不是对象 → 自己与子孙 null')

// ⑤ 节点名唯一化
const u = I.uniqueNodeNames(['a', 'a', '', 'a_2', null, '  ', 'node_2', 'b'])
eq(u.names, ['a', 'a_3', 'node_2_2', 'a_2', 'node_4', 'node_5', 'node_2', 'b'], '重名加后缀但不抢后面节点的原名；空名给 node_<下标>')
eq(u.map, { a_3: 'a', node_2_2: '', node_4: '', node_5: '  ' }, '映射只收改过的，记原名')
eq(new Set(u.names).size, u.names.length, '结果唯一')
eq(I.uniqueNodeNames(['x', 'x', 'x']).names, ['x', 'x_2', 'x_3'], '连续重名')
eq(I.uniqueNodeNames([' pad ', ' pad ']).names, [' pad ', ' pad _2'], '非空名字不 trim（STK 逐字符比对）')
eq(I.uniqueNodeNames('bad'), { names: [], map: {} }, '坏输入 → 空')
// 性能：CAD / OBJ 太阳翼常见上万个同名「Cell」。从头数后缀是 O(n²)（2 万个 37 s），续数是 O(n)
const many = new Array(50000).fill('Cell')
const t0 = performance.now()
const um = I.uniqueNodeNames(many)
const dt = performance.now() - t0
ok(dt < 200 && um.names[49999] === 'Cell_50000' && new Set(um.names).size === 50000, `5 万个同名节点唯一化 ${dt.toFixed(0)} ms（< 200 ms，本机冷启动约 30 ms；O(n²) 实现约 150 s）`)
// 续数与「每次从 2 数起」逐位同结果：对照一个直写的参考实现，随机名字表里故意混进 a_2 / a_3 这类「像后缀的原名」和空名
const refUnique = (list) => {
  const valid = (s) => typeof s === 'string' && s.trim() !== ''
  const originals = new Set(list.filter(valid)), used = new Set(), out = new Array(list.length), map = {}, first = new Map()
  list.forEach((s, i) => { if (valid(s) && !first.has(s)) first.set(s, i) })
  for (const [s, i] of first) { out[i] = s; used.add(s) }
  const take = (b) => { if (!used.has(b) && !originals.has(b)) { used.add(b); return b } for (let k = 2; ; k++) { const c = `${b}_${k}`; if (!used.has(c) && !originals.has(c)) { used.add(c); return c } } }
  list.forEach((s, i) => { if (out[i] !== undefined) return; const n = valid(s) ? take(s) : take(`node_${i}`); out[i] = n; map[n] = valid(s) ? s : (typeof s === 'string' ? s : '') })
  return { names: out, map }
}
let rs = 99
const rpick = (arr) => { rs = (rs * 1664525 + 1013904223) >>> 0; return arr[rs % arr.length] }
const POOL = ['a', 'a', 'a', 'a_2', 'a_3', 'a_2_2', 'b', 'b_2', '', null, ' ', 'node_3', 'node_3_2']
let same = true
for (let k = 0; k < 300 && same; k++) {
  const list = Array.from({ length: 1 + (k % 40) }, () => rpick(POOL))
  same = JSON.stringify(I.uniqueNodeNames(list)) === JSON.stringify(refUnique(list))
}
ok(same, '300 张随机名字表：结果与逐次从 2 数起的参考实现逐位相同')
ok(['mli_gold', 'solar_cell', 'reflector', 'dark_metal'].every((k) => I.MATERIAL_KEYS.includes(k)) && I.MATERIAL_KEYS.length === 24, '材质键 24 个（契约 §3.1 的 15 个 + A3 扩充 9 个）')
eq(I.PART_ROLES.length, 9, '部件角色 9 个')

console.log(`modelIr: ${pass} 项通过`)
