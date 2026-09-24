// 本体遮挡掩模射线核（src/viz/models/bodyMask.worker.js）——node 直接跑 Worker 的纯函数部分：
//   · 与 packages/core/models/mask.mjs 的纯 JS 解析真值（boxMask / rayAabb）逐格对拍（多挂点、多长方体）；
//   · 方向表 = maskDir 逐格；极点行整行同值；起点 = maskRayOrigin；
//   · 按节点排除（连同子孙）、关节（AGI stage，缺省 initialValue）、frame（q/t/缩放）三条几何通路各自对拍解析真值；
//   · Worker 消息协议（needGeom / 缓存 / 分行）与整表一致；几何签名随内容变；
//   · 默认卫星参数化模型：排除名单里的节点永不出现在命中节点里；报耗时（不设硬门槛，真 Electron 的数字在 .modelharness/p2v）。
// 渲染端源码用 @core/… 别名：先注册解析钩子（同 modelRenderStack.test.mjs）。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz/models') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const W = await import(SRC + 'bodyMask.worker.js')
const M = await import(CORE + 'models/mask.mjs')
const { buildTemplateModel } = await import(CORE + 'models/paramBus.mjs')
const { DEFAULT_Q_MODEL2BODY, quatToMat } = await import(CORE + 'models/bodyFrame.mjs')
const THREE = await import('three')

let n = 0
const t = (name, fn) => { try { fn() } catch (e) { e.message = name + '：' + e.message; throw e } n++ }
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false; return true }

// ───────── 工具：长方体 IR（12 三角形，绕向故意混杂——双面判交不该在乎） ─────────
function boxMesh(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return { position: new Float32Array(v.flat()), index: new Uint32Array(f.flat()) }
}
const IDQ = { q_model2body: [0, 0, 0, 1] }
function compare(mask, truth, tolM = 1e-5) {
  let diff = 0, dmax = 0
  for (let k = 0; k < M.MASK_N; k++) {
    if (mask.blocked[k] !== truth.blocked[k]) diff++
    else if (mask.blocked[k]) dmax = Math.max(dmax, Math.abs(mask.clearance[k] - truth.clearance[k]))
    else if (mask.clearance[k] !== Infinity) diff++
  }
  return { diff, dmax, ok: diff === 0 && dmax < tolM }
}

// ───────── 方向表 / 起点 ─────────
t('方向表逐格 = mask.mjs maskDir（含极点行精确 ±Z）', () => {
  const tab = W.maskDirTable(), d = [0, 0, 0]
  for (let j = 0; j < M.MASK_H; j++) for (let i = 0; i < M.MASK_W; i++) {
    M.maskDir(i, j, d)
    const k = (j * M.MASK_W + i) * 3
    assert.ok(tab[k] === d[0] && tab[k + 1] === d[1] && tab[k + 2] === d[2], `${i},${j}`)
  }
  assert.deepEqual([tab[2], tab[180 * 360 * 3 + 2]], [-1, 1])
})
t('尺寸常量取自 mask.mjs', () => {
  assert.equal(W.MASK_W, M.MASK_W); assert.equal(W.MASK_H, M.MASK_H); assert.equal(W.MASK_N, M.MASK_N); assert.equal(W.MASK_RAY_OFFSET_M, 0.01)
})
t('起点 = maskRayOrigin（posBody + 1 cm·视轴）；非法入参不抛', () => {
  const m = { posBody: [1, 2, 3], dirBody: [0, 0, 5] }
  assert.deepEqual(W.maskOrigin(m), M.maskRayOrigin(m.posBody, m.dirBody))
  assert.deepEqual(W.maskOrigin(m), [1, 2, 3.01])
  assert.deepEqual(W.maskOrigin({ posBody: [1, 2, 3] }), [1, 2, 3])
  assert.deepEqual(W.maskOrigin({ posBody: [NaN, 0, 0], dirBody: [1, 0, 0] }), [0.01, 0, 0])
  assert.deepEqual(W.maskOrigin(null), [0, 0, 0])
})

// ───────── 与解析真值逐格对拍 ─────────
const BOXES = [
  { min: [1.2, -0.7, -0.4], max: [2.3, 0.9, 0.8] },
  { min: [-3.1, -2.2, 0.35], max: [-0.4, 2.6, 0.55] },
  { min: [-0.9, 3.05, -1.7], max: [0.62, 3.4, 1.9] }
]
const boxIR = { nodes: [{ name: 'root', parent: -1 }, ...BOXES.map((b, i) => ({ name: 'b' + i, parent: 0, mesh: i }))], meshes: BOXES.map((b) => boxMesh(b.min, b.max)) }
const boxGeom = W.bodyGeometryFromIR(boxIR, { frame: IDQ })
const MOUNTS = [
  { posBody: [0.137, 0.211, 0.093], dirBody: [0.3, -0.2, 0.93] },
  { posBody: [-1.03, 0.77, -0.61], dirBody: [0, 0, 1] },
  { posBody: [0.51, -1.37, 1.13], dirBody: [-0.6, 0.1, -0.2] },
  { posBody: [2.9, 2.3, -2.2], dirBody: [1, 1, 1] }
]
MOUNTS.forEach((mt, i) => t(`三长方体 · 挂点 ${i + 1}：逐格 = boxMask（blocked 全等、净空 < 1e-5 m）`, () => {
  const m = W.computeBodyMask(boxGeom, mt)
  const truth = M.boxMask(BOXES, M.maskRayOrigin(mt.posBody, mt.dirBody))
  const r = compare(m, truth)
  assert.ok(r.ok, `不一致 ${r.diff} 格，净空最大偏差 ${r.dmax}`)
  const s = M.maskStats(m)
  assert.ok(s.blockedCells > 100 && s.blockedCells < M.MASK_N)
}))
t('极点行整行同值（blocked / clearance / hitNode）', () => {
  const m = W.computeBodyMask(boxGeom, { posBody: [0.2, 3.2, -3], dirBody: [0, 0, 1] })
  for (const j of [0, 180]) {
    const o = j * 360
    for (let i = 1; i < 360; i++) {
      assert.equal(m.blocked[o + i], m.blocked[o]); assert.ok(Object.is(m.clearance[o + i], m.clearance[o])); assert.equal(m.hitNode[o + i], m.hitNode[o])
    }
  }
  assert.equal(m.blocked[180 * 360], 1)   // 起点在第三块盒正下方：+Z 极点被挡
})
t('命中节点 = 真值里最近那块的节点', () => {
  const mt = MOUNTS[0], o = M.maskRayOrigin(mt.posBody, mt.dirBody)
  const m = W.computeBodyMask(boxGeom, mt)
  const d = [0, 0, 0]
  let checked = 0
  for (let k = 0; k < M.MASK_N; k += 7) {
    if (!m.blocked[k]) { assert.equal(m.hitNode[k], -1); continue }
    M.maskDir(k % 360, Math.floor(k / 360), d)
    const ts = BOXES.map((b) => M.rayAabb(o, d, b.min, b.max))
    const best = ts.indexOf(Math.min(...ts))
    if (ts.filter((x) => Math.abs(x - ts[best]) < 1e-6).length > 1) continue   // 两块同距（棱上）不判
    assert.equal(boxGeom.nodeNames[m.hitNode[k]], 'b' + best); checked++
  }
  assert.ok(checked > 500)
})

// ───────── 排除 / 关节 / frame ─────────
t('按名排除（连同子孙）：排除 b1 与其子节点后 = 只剩 b0、b2 的真值', () => {
  const ir = JSON.parse(JSON.stringify({ nodes: boxIR.nodes }))
  ir.nodes.push({ name: 'b1_child', parent: 2, mesh: 3 })   // b1 的子节点，挂一块额外的盒
  const extra = { min: [-2.5, -1.9, 0.9], max: [-1.1, -0.3, 1.3] }
  ir.meshes = [...boxIR.meshes, boxMesh(extra.min, extra.max)]
  const g = W.bodyGeometryFromIR(ir, { frame: IDQ })
  const mt = MOUNTS[1]
  const o = M.maskRayOrigin(mt.posBody, mt.dirBody)
  const all = W.computeBodyMask(g, mt)
  assert.ok(compare(all, M.boxMask([...BOXES, extra], o)).ok)
  const ex = W.computeBodyMask(g, { ...mt, excludeNodes: ['b1'] })
  assert.ok(compare(ex, M.boxMask([BOXES[0], BOXES[2]], o)).ok)
  const ex2 = W.computeBodyMask(g, mt, { exclude: ['b1_child'] })   // opts.exclude（noObscurationNodes 通路）同样生效
  assert.ok(compare(ex2, M.boxMask(BOXES, o)).ok)
  const flags = W.excludedNodeFlags(g, ['b1'])
  assert.deepEqual(Array.from(flags), [0, 0, 1, 0, 1])
})
t('全部排除：一格不挡、净空全 +Inf', () => {
  const m = W.computeBodyMask(boxGeom, MOUNTS[0], { exclude: ['root'] })
  assert.equal(M.maskStats(m).blockedCells, 0)
  assert.ok(m.clearance.every((v) => v === Infinity))
  assert.equal(m.stats.keptTris, 0)
})
t('关节：yRotate 90° 把板转到新位置；缺省取 initialValue；签名只含生效值', () => {
  // 板节点局部系：绕 y 转 90°，(x,z) → (z,−x)
  const plate = { min: [1.0, -0.5, -0.05], max: [2.0, 0.5, 0.05] }
  const ir = { nodes: [{ name: 'root', parent: -1 }, { name: 'plate', parent: 0, mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.3, 1] }], meshes: [boxMesh(plate.min, plate.max)] }
  const arts = [{ name: 'wing', nodes: ['plate'], stages: [{ name: 'rot', type: 'yRotate', minimumValue: -180, maximumValue: 180, initialValue: 90 }] }]
  const mt = { posBody: [-0.8, 0.02, -1.23], dirBody: [1, 0, 0] }, o = M.maskRayOrigin(mt.posBody, mt.dirBody)
  const rotated = { min: [-0.05, -0.5, 0.3 - 2.0], max: [0.05, 0.5, 0.3 - 1.0] }
  const g90 = W.bodyGeometryFromIR(ir, { frame: IDQ, articulations: arts })        // 缺省 = initialValue 90°
  assert.ok(compare(W.computeBodyMask(g90, mt), M.boxMask(rotated, o), 1e-4).ok)
  const g0 = W.bodyGeometryFromIR(ir, { frame: IDQ, articulations: arts, articulationState: { wing: [0] } })
  const flat = { min: [1.0, -0.5, 0.25], max: [2.0, 0.5, 0.35] }
  assert.ok(compare(W.computeBodyMask(g0, mt), M.boxMask(flat, o), 1e-4).ok)
  const g0b = W.bodyGeometryFromIR(ir, { frame: IDQ, articulations: arts, articulationState: { wing: { rot: 0 } } })
  assert.equal(W.geometryHash(g0), W.geometryHash(g0b))
  assert.notEqual(W.geometryHash(g0), W.geometryHash(g90))
  assert.equal(g90.artSig, 'wing=90'); assert.equal(g0.artSig, 'wing=0')
})
t('stage 矩阵与 three Matrix4 逐项一致（viewport.setArticulation 同式）', () => {
  const m4 = new THREE.Matrix4()
  const pairs = [['xRotate', 37, () => m4.makeRotationX(37 * Math.PI / 180)], ['yRotate', -122, () => m4.makeRotationY(-122 * Math.PI / 180)],
    ['zRotate', 181, () => m4.makeRotationZ(181 * Math.PI / 180)], ['xTranslate', 2.5, () => m4.makeTranslation(2.5, 0, 0)],
    ['zTranslate', -1, () => m4.makeTranslation(0, 0, -1)], ['uniformScale', 0.5, () => m4.makeScale(0.5, 0.5, 0.5)], ['yScale', 3, () => m4.makeScale(1, 3, 1)]]
  for (const [ty, v, mk] of pairs) {
    const a = W.stageMatrix(ty, v), b = mk().elements
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-15, ty + ' ' + i)
  }
})
t('frame：模型系几何按 q / t / 缩放摆回本体系后 = 本体系真值', () => {
  // 任取一个非轴对齐以外的 q：绕 (1,1,1) 转 120°（STK 映射），t 与英尺缩放
  const q = [0.5, 0.5, 0.5, 0.5], tt = [0.4, -0.2, 0.1], s = 0.3048
  const R = quatToMat(q)
  // 真值盒（本体系，轴对齐）→ 反求模型系盒：model = Rᵀ·(body − t) / s；R 是轴置换，盒仍轴对齐
  const bodyBox = { min: [1.1, -0.6, -0.3], max: [1.9, 0.7, 0.45] }
  const inv = (p) => { const d = [p[0] - tt[0], p[1] - tt[1], p[2] - tt[2]]; return [0, 1, 2].map((c) => (R[0][c] * d[0] + R[1][c] * d[1] + R[2][c] * d[2]) / s) }
  const a = inv(bodyBox.min), b = inv(bodyBox.max)
  const mmin = a.map((v, i) => Math.min(v, b[i])), mmax = a.map((v, i) => Math.max(v, b[i]))
  const ir = { nodes: [{ name: 'r', parent: -1, mesh: 0 }], meshes: [boxMesh(mmin, mmax)] }
  const g = W.bodyGeometryFromIR(ir, { frame: { q_model2body: q, t_model2body: tt }, scaleToMeters: s })
  const mt = { posBody: [0.1, 0.05, 0.02], dirBody: [1, 0, 0] }
  assert.ok(compare(W.computeBodyMask(g, mt), M.boxMask(bodyBox, M.maskRayOrigin(mt.posBody, mt.dirBody)), 1e-5).ok)
  // meta 通路同口径
  const g2 = W.bodyGeometryFromIR(ir, { meta: { frame: { q_model2body: q, t_model2body: tt }, units: { scaleToMeters: s } } })
  assert.equal(W.geometryHash(g), W.geometryHash(g2))
})
t('frame 缺省取 bodyFrame.mjs 的出厂 q（不写死数字）', () => {
  const M4 = W.modelToBodyM4(undefined, 1), R = quatToMat(DEFAULT_Q_MODEL2BODY)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(M4[c * 4 + r] - R[r][c]) < 1e-15)
  const bad = W.modelToBodyM4({ q_model2body: [0, 0, 0, 0] }, 1)
  assert.deepEqual(bad, M4)
})

// ───────── Worker 消息协议 ─────────
t('Worker 协议：无几何无缓存 → needGeom；带几何建树；分行结果拼回 = 整表', () => {
  const mt = MOUNTS[2], exclude = []
  const key = W.geometryHash(boxGeom) + '|' + W.excludeKey(exclude)
  const origin = W.maskOrigin(mt)
  const [r0] = W.handleMessage({ id: 1, key, exclude, origin, rows: [0, 1] })
  assert.equal(r0.needGeom, true)
  const full = W.computeBodyMask(boxGeom, mt)
  const blocked = new Uint8Array(M.MASK_N), clear = new Float32Array(M.MASK_N)
  const K = 3
  for (let w = 0; w < K; w++) {
    const rows = []; for (let j = w; j < M.MASK_H; j += K) rows.push(j)
    const [r, transfer] = W.handleMessage({ id: 2 + w, key, exclude, origin, rows, geom: w === 0 ? boxGeom : undefined })
    assert.ok(r.ok, JSON.stringify(r).slice(0, 80))
    assert.equal(transfer.length, 3)
    if (w > 0) assert.equal(r.buildMs, 0)   // 第二、三片命中缓存，没带几何也能算
    rows.forEach((j, i) => { blocked.set(r.blocked.subarray(i * 360, i * 360 + 360), j * 360); clear.set(r.clearance.subarray(i * 360, i * 360 + 360), j * 360) })
  }
  assert.ok(same(blocked, full.blocked) && same(clear, full.clearance))
})
t('几何签名：同内容同签名、改一个顶点就变', () => {
  const g2 = { ...boxGeom, positions: boxGeom.positions.slice() }
  assert.equal(W.geometryHash(g2), W.geometryHash(boxGeom))
  g2.positions[5] += 1e-6
  assert.notEqual(W.geometryHash(g2), W.geometryHash(boxGeom))
  assert.match(W.geometryHash(boxGeom), /^[0-9a-f]{16}$/)
})

// ───────── 默认卫星参数化 ─────────
t('默认卫星：排除名单里的节点永不出现在命中节点里；报耗时', () => {
  const r = buildTemplateModel('default-sat')
  const t0 = performance.now()
  const g = W.bodyGeometryFromIR(r.ir, { frame: r.frame, articulations: r.articulations, articulationState: {} })
  const tSoup = performance.now() - t0
  const own = ['feed_1', 'feed_1_support', 'reflector_1', 'reflector_1_back', 'reflector_1_rim', 'reflector_1_arm']
  const ap = r.attachPoints.find((a) => a.name === 'reflector_1_focus')
  W.computeBodyMask(g, { ...ap, excludeNodes: own })   // 预热 JIT
  const m = W.computeBodyMask(g, { ...ap, excludeNodes: own })
  const ownIdx = new Set(own.map((nm) => g.nodeNames.indexOf(nm)))
  for (let k = 0; k < M.MASK_N; k++) if (m.blocked[k]) assert.ok(!ownIdx.has(m.hitNode[k]) && m.hitNode[k] >= 0)
  const s = M.maskStats(m)
  assert.ok(s.blockedFrac > 0.2 && s.blockedFrac < 0.6, String(s.blockedFrac))
  console.log(`  默认卫星：${g.tris} 三角形（压实后 ${m.stats.keptTris}）· 取几何 ${tSoup.toFixed(1)} ms · 建树 ${m.stats.buildMs.toFixed(1)} ms · 射线 ${m.stats.castMs.toFixed(1)} ms（${m.stats.rays} 条，单线程）· 遮挡立体角 ${(s.blockedFrac * 100).toFixed(1)}% · 最小净空 ${s.minClearanceM.toFixed(3)} m`)
})
t('编解码往返（D18 .bin）：Worker 结果经 encodeMask / decodeMask 逐位不变', () => {
  const m = W.computeBodyMask(boxGeom, MOUNTS[0])
  const back = M.decodeMask(M.encodeMask(m))
  assert.ok(same(back.blocked, m.blocked) && same(back.clearance, m.clearance))
})

console.log(`modelBodyMask: ${n} 项通过`)
