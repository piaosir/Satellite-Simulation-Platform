// 关节「加载时的位姿」与精确包围盒（src/viz/models/thumbs.js：poseArticulations / applyRestPose / restoreFilePose / exactBox / stageMatrix）。
// 预览视口、缩略图 / 三视图、导入后分析三处共用这一份：STK 件的喷焰是 uniformScale 初值 0 的关节，按文件位姿画 / 量就被火焰撑大。
// 裸 node 跑：thumbs.js 只依赖 three 与本目录相对路径（nasa3d:sheets 离屏页同样的约束），不需要 @core 解析钩子。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const THREE = await import('three')
const T = await import(pathToFileURL(path.join(HERE, '../../../src/viz/models/thumbs.js')).href)

let n = 0
const ok = (name, fn) => { fn(); n++ }
const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`)
const nearV = (a, b, tol = 1e-9, msg = '') => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => near(x, b[i], tol, msg + '[' + i + ']')) }

// 小星：盒 1 m 立方（原点）+ 一块板（+Y 侧，绕局部 Y 转）+ 一团喷焰（−Z 方向 10 m 长，原名 Thruster_1）
function sat() {
  const root = new THREE.Group(); root.name = 'root'
  const mk = (name, sx, sy, sz, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshBasicMaterial())
    m.name = name; m.userData.name = name; m.position.set(x, y, z)
    root.add(m)
    return m
  }
  const bus = mk('bus', 1, 1, 1, 0, 0, 0)
  const panel = mk('panel', 0.2, 2, 1, 0, 1.5, 0)
  const plume = mk('Thruster_1', 0.4, 0.4, 10, 0, 0, -5.5)
  root.updateMatrixWorld(true)
  return { root, bus, panel, plume }
}
const ARTS = [
  { name: 'Thruster_1', nodes: ['Thruster_1'], stages: [{ name: 'Size', type: 'uniformScale', minimumValue: 0, maximumValue: 1, initialValue: 0 }] },
  { name: 'Panel', nodes: ['panel'], stages: [{ name: 'Rot', type: 'yRotate', minimumValue: -180, maximumValue: 180, initialValue: 30 }] }
]

ok('stage 矩阵：旋转按度、平移 / 缩放按值；未知类型为单位阵', () => {
  const v = new THREE.Vector3()
  v.set(1, 0, 0).applyMatrix4(T.stageMatrix('zRotate', 90)); nearV(v.toArray(), [0, 1, 0], 1e-12)
  v.set(0, 0, 1).applyMatrix4(T.stageMatrix('yRotate', 90)); nearV(v.toArray(), [1, 0, 0], 1e-12)
  v.set(0, 0, 0).applyMatrix4(T.stageMatrix('xTranslate', 2.5)); nearV(v.toArray(), [2.5, 0, 0])
  v.set(1, 1, 1).applyMatrix4(T.stageMatrix('uniformScale', 3)); nearV(v.toArray(), [3, 3, 3])
  v.set(1, 1, 1).applyMatrix4(T.stageMatrix('zScale', 2)); nearV(v.toArray(), [1, 1, 2])
  assert.ok(T.stageMatrix('nope', 7).equals(new THREE.Matrix4()))
})
ok('加载时的位姿：初值 0 的缩放件藏起来且矩阵不退化；初值 30° 的板转过去；别的件不动', () => {
  const { root, bus, panel, plume } = sat()
  const m0 = plume.matrix.clone()
  const pose = T.applyRestPose(root, { articulations: ARTS })
  assert.equal(plume.visible, false)
  assert.ok(plume.matrix.equals(m0), '喷焰保持文件位姿（不写 0 缩放）')
  assert.ok(Math.abs(plume.matrix.determinant()) > 0.5)
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6)
  near(panel.quaternion.angleTo(q), 0, 1e-9, '板转 30°')
  nearV(panel.position.toArray(), [0, 1.5, 0], 1e-12)
  assert.equal(bus.visible, true); assert.equal(pose.size, 2)
})
ok('反复摆不累加：同一 pose 表摆两次结果相同；滑杆值（数组 / 按 stage 名）优先于初值；null 回初值', () => {
  const { root, panel } = sat()
  const pose = new Map()
  T.poseArticulations(root, ARTS, null, { pose })
  const q30 = panel.quaternion.clone()
  T.poseArticulations(root, ARTS, null, { pose })
  near(panel.quaternion.angleTo(q30), 0, 1e-12, '两次摆同一结果')
  T.poseArticulations(root, ARTS, { Panel: [90] }, { pose })
  near(panel.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)), 0, 1e-9)
  T.poseArticulations(root, ARTS, { Panel: { Rot: -45 } }, { pose })
  near(panel.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 4)), 0, 1e-9)
  T.poseArticulations(root, ARTS, null, { pose })
  near(panel.quaternion.angleTo(q30), 0, 1e-12)
})
ok('滑杆把缩放件拉开：看得见、按比例缩；再拉回 0 又藏起来', () => {
  const { root, plume } = sat()
  const pose = new Map()
  T.poseArticulations(root, ARTS, { Thruster_1: [0.5] }, { pose })
  assert.equal(plume.visible, true)
  nearV(plume.scale.toArray(), [0.5, 0.5, 0.5], 1e-12)
  T.poseArticulations(root, ARTS, { Thruster_1: [0] }, { pose })
  assert.equal(plume.visible, false)
  nearV(plume.scale.toArray(), [1, 1, 1], 1e-12)
})
ok('复原文件位姿：矩阵与显隐都回去', () => {
  const { root, panel, plume } = sat()
  const p0 = panel.matrix.clone()
  const pose = T.applyRestPose(root, { articulations: ARTS })
  T.restoreFilePose(pose)
  assert.ok(panel.matrix.equals(p0)); assert.equal(plume.visible, true)
})
ok('collapse（导入后分析用）：真写 0 缩放 + 隐藏；三角形数不变', () => {
  const { root, plume } = sat()
  const tris0 = plume.geometry.index.count / 3
  T.applyRestPose(root, { articulations: ARTS }, { collapse: true })
  assert.equal(plume.visible, false)
  nearV(plume.scale.toArray(), [0, 0, 0])
  root.updateMatrixWorld(true)
  assert.equal(plume.matrixWorld.determinant(), 0)
  assert.equal(plume.geometry.index.count / 3, tris0)
})
ok('同一节点挂两条关节：按关节顺序依次右乘', () => {
  const { root, panel } = sat()
  const arts = [
    { name: 'A', nodes: ['panel'], stages: [{ name: 's', type: 'zRotate', minimumValue: -180, maximumValue: 180, initialValue: 90 }] },
    { name: 'B', nodes: ['panel'], stages: [{ name: 's', type: 'xTranslate', minimumValue: -9, maximumValue: 9, initialValue: 1 }] }
  ]
  T.poseArticulations(root, arts, null)
  // 文件 T(0,1.5,0) × Rz(90°) × Tx(1)：局部 +X 平移 1 经 Rz(90°) 变成 +Y
  nearV(panel.position.toArray(), [0, 2.5, 0], 1e-12)
})
ok('节点按原名解析；重名节点都动；缺 stages / nodes 的关节跳过', () => {
  const { root } = sat()
  const twin = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); twin.userData.name = 'panel'; root.add(twin)
  T.poseArticulations(root, [...ARTS, { name: 'X', nodes: [], stages: [{ name: 's', type: 'xTranslate', initialValue: 5, minimumValue: 0, maximumValue: 9 }] }, { name: 'Y', nodes: ['bus'], stages: [] }], null)
  near(twin.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6)), 0, 1e-9)
  assert.equal(root.children[0].position.x, 0)   // bus 没被 Y（空 stages）碰
})
ok('自定义解析（视口按 IR 名）：只动解析出来的节点', () => {
  const { root, panel, bus } = sat()
  T.poseArticulations(root, ARTS, null, { resolve: (names) => (names.has('panel') ? [bus] : []) })
  near(bus.quaternion.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6)), 0, 1e-9)
  near(panel.quaternion.angleTo(new THREE.Quaternion()), 0, 1e-12)
})
ok('精确包围盒：只算可见件；逐顶点（旋转的件不按局部盒八角外扩）；半径 = 最远顶点离原点', () => {
  const { root } = sat()
  const eb0 = T.exactBox(root)
  nearV(eb0.min, [-0.5, -0.5, -10.5], 1e-9, '文件位姿含喷焰'); nearV(eb0.max, [0.5, 2.5, 0.5], 1e-9)
  T.applyRestPose(root, { articulations: ARTS })
  root.updateMatrixWorld(true)
  const eb = T.exactBox(root)
  // 板 0.2 × 2 × 1 绕 Y 转 30°：x 半宽 = 0.1·cos30 + 0.5·sin30 = 0.33660，z 半宽 = 0.1·sin30 + 0.5·cos30 = 0.48301（都比盒 0.5 小）
  nearV(eb.min, [-0.5, -0.5, -0.5], 1e-9, '喷焰不算'); nearV(eb.max, [0.5, 2.5, 0.5], 1e-9)
  near(eb.radius, Math.hypot(0.1, 2.5, 0.5), 1e-6, '最远点是板的外角（绕 Y 转不改 x² + z²）')
  // Box3.setFromObject 的缺省口径：局部盒八角变过去再外包 —— 旋转件偏大，且把藏起来的喷焰也算进去
  const loose = new THREE.Box3().setFromObject(root)
  assert.ok(loose.min.z < -10, 'setFromObject 不看显隐')
  assert.equal(T.exactBox(new THREE.Group()).empty, true)
})
ok('精确包围盒：pre 矩阵左乘（模型 → 本体）；借用顶点缓冲的子网格只算自己索引到的点', () => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, /* 另一组 */ 50, 50, 50, 51, 50, 50, 50, 51, 50], 3))
  const sub = new THREE.BufferGeometry()
  sub.setAttribute('position', g.attributes.position); sub.setIndex([0, 1, 2]); sub.userData._borrowed = true
  const root = new THREE.Group(); root.add(new THREE.Mesh(sub)); root.updateMatrixWorld(true)
  const eb = T.exactBox(root)
  nearV(eb.min, [0, 0, 0]); nearV(eb.max, [1, 1, 0])
  const pre = new THREE.Matrix4().makeScale(2, 2, 2)
  nearV(T.exactBox(root, pre).max, [2, 2, 0])
  // 不借用的几何：逐顶点（未被索引的点也算 —— 这是整份几何自己的顶点）
  const own = new THREE.BufferGeometry(); own.setAttribute('position', g.attributes.position.clone()); own.setIndex([0, 1, 2])
  const r2 = new THREE.Group(); r2.add(new THREE.Mesh(own)); r2.updateMatrixWorld(true)
  nearV(T.exactBox(r2).max, [51, 51, 50])
})

console.log(`modelWorkbenchPose: ${n} 项通过`)
