// 渲染端模型栈（src/viz/models/*）里不依赖 GPU / DOM 的部分：
//   坐标口径（view.js）、IR ⇄ three 往返与三角形编号（irToThree.js，须与 segment.mjs 的 triRanges 对得上）、
//   meshopt 压缩往返（exporter.js 的 meshoptCompressGlb）、LOD 抽稀（analyzeWorker.js 的 simplifyMeshes）、
//   OBJ / STL 导入与单位提示（importers.js）、STK 导出闸、材质键与 IR 契约一致。
// 渲染与出图（viewport / thumbs / studio 画面、GLTFExporter 全流程、gltf-validator）在真 Electron 窗口的验证台
// .modelharness/ 里跑，这里不重复。
// 渲染端源码用 @core/… 别名（vite 配置里的），node 不认：先注册一个把 @core/ 映到 packages/core/ 的解析钩子再动态导入。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz/models') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const THREE = await import('three')
const view = await import(SRC + 'view.js')
const { irToThree, threeToIR, triTable, irNodeTable, irLayout, splitMultiMaterial } = await import(SRC + 'irToThree.js')
const { meshoptCompressGlb, exportBlocked, exportGlb } = await import(SRC + 'exporter.js')
const { simplifyMeshes } = await import(SRC + 'analyzeWorker.js')
const { buildSerializedBvh } = await import(SRC + 'bvhWorker.js')
const { importFile } = await import(SRC + 'importers.js')
const { hoistAndDrop } = await import(SRC + 'loader.js')
const { MeshBVH, acceleratedRaycast } = await import('three-mesh-bvh')
const { readAgiFromGltfJson, attachPointPoses } = await import(CORE + 'models/agi.mjs')
const { defaultUpBody } = await import(CORE + 'models/bodyFrame.mjs')
const { MATERIAL_KEYS, keyNeedsUv, ROLE_COLORS } = await import(SRC + 'materials.js')
const BF = await import(CORE + 'models/bodyFrame.mjs')
const CORE_Q = BF.DEFAULT_Q_MODEL2BODY
const IRM = await import(CORE + 'models/ir.mjs')
const { autoSegment } = await import(CORE + 'models/segment.mjs')
const { parseGlb, buildGlb } = await import(CORE + 'models/glb.mjs')
const { MeshoptDecoder } = await import('meshoptimizer')

let n = 0
const t = (name, fn) => { fn(); n++ }
const ta = async (name, fn) => { await fn(); n++ }
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const nearV = (v, arr, eps = 1e-9) => near(v.x, arr[0], eps) && near(v.y, arr[1], eps) && near(v.z, arr[2], eps)

// ───────── view.js：模型系 → 本体系 → 显示系 ─────────
t('出厂四元数就是 bodyFrame.mjs 的常量（view.js 转出，不是抄的数）', () => {
  assert.equal(view.DEFAULT_Q_MODEL2BODY, CORE_Q)
})
t('出厂映射（STK）：meta 缺 frame 时 glTF 各轴 → 本体 = bodyFrame 出厂 R 的列', () => {
  const M = view.modelToBodyMatrix({})
  for (let j = 0; j < 3; j++) {
    const e = [0, 0, 0]; e[j] = 1
    assert.ok(nearV(new THREE.Vector3(...e).applyMatrix4(M), [BF.R_GLTF_TO_BODY[0][j], BF.R_GLTF_TO_BODY[1][j], BF.R_GLTF_TO_BODY[2][j]], 1e-12), `glTF 轴 ${j}`)
  }
  assert.ok(nearV(new THREE.Vector3(0, 1, 0).applyMatrix4(M), BF.modelToBody([0, 1, 0], BF.Q_MODEL2BODY_STK), 1e-12), 'glTF +Y → 本体 +Z（天底，STK 口径）')
})
t('显示系（轴映射终案 ③：天顶朝上、地球在下）：+Y 天顶件（NASA / 普通导入）glTF +Y 朝上、STK 件朝下；NASA 件画面与切换前逐位相同', () => {
  const Mz = new THREE.Matrix4().multiplyMatrices(view.BODY_TO_DISPLAY, view.modelToBodyMatrix({ frame: { q_model2body: BF.Q_YUP_ZENITH.slice() } }))
  assert.ok(nearV(new THREE.Vector3(0, 1, 0).applyMatrix4(Mz), [0, 1, 0], 1e-12), '+Y 天顶件：glTF +Y（作者的上）→ 显示 +Y')
  const Ms = new THREE.Matrix4().multiplyMatrices(view.BODY_TO_DISPLAY, view.modelToBodyMatrix({}))
  assert.ok(nearV(new THREE.Vector3(0, 1, 0).applyMatrix4(Ms), [0, -1, 0], 1e-12), 'STK 件（出厂映射）：glTF +Y（对地面）→ 显示 −Y（朝下）')
  // 回归基线：2026-09-23 之前 = 附录 B × 天顶朝上显示系（旧 view.js 的原值）——NASA 件（Q_YUP_ZENITH = 附录 B）同一视角下逐位不变
  const oldDisplay = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1)
  const Mold = new THREE.Matrix4().multiplyMatrices(oldDisplay, new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...BF.Q_MODEL2BODY_APPENDIXB)))
  assert.ok(Mz.elements.every((x, i) => near(x, Mold.elements[i], 1e-12)), `${Mz.elements} vs ${Mold.elements}`)
  // 天顶 / 天底常量与矩阵一致：天顶 = 屏幕上方
  assert.ok(nearV(new THREE.Vector3(0, 0, -1).applyMatrix4(view.BODY_TO_DISPLAY), view.ZENITH_DISPLAY, 1e-12))
  assert.ok(nearV(new THREE.Vector3(0, 0, 1).applyMatrix4(view.BODY_TO_DISPLAY), view.NADIR_DISPLAY, 1e-12))
  assert.ok(nearV(new THREE.Vector3(...view.ZENITH_DISPLAY), [0, 1, 0], 0) && nearV(new THREE.Vector3(...view.NADIR_DISPLAY), [0, -1, 0], 0))
})
t('frame 的 q / t 与 units.scaleToMeters 按 v_body = R(q)·(s·v) + t 组合', () => {
  const M = view.modelToBodyMatrix({ frame: { q_model2body: [0, 0, 0, 1], t_model2body: [1, 2, 3] }, units: { scaleToMeters: 0.3048 } })
  assert.ok(nearV(new THREE.Vector3(10, 0, 0).applyMatrix4(M), [1 + 3.048, 2, 3], 1e-12))
})
t('本体 → 显示：本体 −Z（天顶）朝上、+Z（天底）朝下、纯旋转、两个就地换算与矩阵 / 四元数一致且互逆', () => {
  assert.ok(nearV(new THREE.Vector3(0, 0, -1).applyMatrix4(view.BODY_TO_DISPLAY), [0, 1, 0], 1e-12))
  assert.ok(nearV(new THREE.Vector3(0, 0, 1).applyMatrix4(view.BODY_TO_DISPLAY), [0, -1, 0], 1e-12))
  assert.ok(nearV(new THREE.Vector3(1, 0, 0).applyMatrix4(view.BODY_TO_DISPLAY), [1, 0, 0], 1e-12), '本体 +X 不动（front 视角语义不变）')
  assert.ok(near(view.BODY_TO_DISPLAY.determinant(), 1, 1e-12))
  const v = new THREE.Vector3(0.3, -0.7, 1.9)
  const w = view.bodyToDisplayVec(v.clone())
  assert.ok(nearV(w, new THREE.Vector3(0.3, -0.7, 1.9).applyMatrix4(view.BODY_TO_DISPLAY).toArray(), 1e-12))
  assert.ok(nearV(new THREE.Vector3(0.3, -0.7, 1.9).applyQuaternion(view.BODY_TO_DISPLAY_Q), w.toArray(), 1e-12), '四元数 = 矩阵')
  assert.ok(nearV(view.displayToBodyVec(w), [0.3, -0.7, 1.9], 1e-12))
  assert.ok(nearV(new THREE.Vector3(0.3, -0.7, 1.9).applyMatrix4(view.DISPLAY_TO_BODY), view.displayToBodyVec(new THREE.Vector3(0.3, -0.7, 1.9)).toArray(), 1e-12), 'DISPLAY_TO_BODY = 就地逆换算')
})
t('工程视角 BODY_VIEWS：按本体轴定义（前 +X / 侧 +Y / 顶 −Z），换回本体系逐项相等、dir ⟂ up，与显示系怎么摆无关', () => {
  for (const [k, v] of Object.entries(view.BODY_VIEWS)) {
    assert.ok(nearV(new THREE.Vector3(...v.dir).applyMatrix4(view.DISPLAY_TO_BODY), v.fromBody, 1e-12), `${k} dir`)
    assert.ok(nearV(new THREE.Vector3(...v.up).applyMatrix4(view.DISPLAY_TO_BODY), v.upBody, 1e-12), `${k} up`)
    assert.ok(near(new THREE.Vector3(...v.dir).dot(new THREE.Vector3(...v.up)), 0, 1e-12), `${k} dir ⟂ up`)
  }
  assert.deepEqual([view.BODY_VIEWS.front.fromBody, view.BODY_VIEWS.side.fromBody, view.BODY_VIEWS.top.fromBody], [[1, 0, 0], [0, 1, 0], [0, 0, -1]])
})
t('视角：等轴 = 方位 35°、俯仰 25°；俯视屏幕上方 = 本体 +X', () => {
  const d = view.viewDir('iso')
  assert.ok(near(Math.asin(d.y) * 180 / Math.PI, 25, 1e-9))
  assert.ok(near(Math.atan2(d.z, d.x) * 180 / Math.PI, 35, 1e-9))
  // 六个轴向视角按本体轴定（工作台按钮「前（+X）/ 后（−X）/ 左（−Y）/ 右（+Y）/ 顶（−Z）/ 底（+Z）」与 viewport 轴球点击同口径），
  // 与显示系怎么摆无关：换回本体系 ≈ 对应本体轴
  const AX = { front: [1, 0, 0], back: [-1, 0, 0], right: [0, 1, 0], side: [0, 1, 0], left: [0, -1, 0], top: [0, 0, -1], bottom: [0, 0, 1] }
  for (const [k, b] of Object.entries(AX)) {
    const d = view.viewDir(k).applyMatrix4(view.DISPLAY_TO_BODY)
    assert.ok(nearV(d, b, 2e-4), `${k}：相机在本体 ${b} 一侧，实际 ${d.toArray()}`)   // 顶 / 底有意偏 1e-4（见 view.js）
  }
  // 顶 / 底（沿显示竖直轴看）：OrbitControls 上向 = 显示 +Y，相机 lookAt 原点后屏幕上方 = 本体 +X（速度朝上）
  for (const k of ['top', 'bottom']) {
    const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
    cam.position.copy(view.viewDir(k)).multiplyScalar(10); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld()
    const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).applyMatrix4(view.DISPLAY_TO_BODY)
    assert.ok(nearV(screenUp, [1, 0, 0], 2e-4), `${k}：屏幕上方 ${screenUp.toArray()}`)
  }
  assert.ok(Object.isFrozen(view.VIEW_DIRS) && Object.isFrozen(view.VIEW_DIRS.top), '视角常量冻结')
  // 等轴：相机在天顶一侧（俯仰 25°），本体 +X（速度）朝右前（屏幕右半、朝向观者），+Y 朝左前
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
  cam.position.copy(view.viewDir('iso')).multiplyScalar(10); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld()
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), toCam = view.viewDir('iso')
  const X = new THREE.Vector3(1, 0, 0).applyMatrix4(view.BODY_TO_DISPLAY), Y = new THREE.Vector3(0, 1, 0).applyMatrix4(view.BODY_TO_DISPLAY), Zn = new THREE.Vector3(0, 0, -1).applyMatrix4(view.BODY_TO_DISPLAY)
  assert.ok(X.dot(right) > 0.5 && X.dot(toCam) > 0.5, `+X 右前：右 ${X.dot(right)}、前 ${X.dot(toCam)}`)
  assert.ok(Y.dot(right) < -0.5 && Y.dot(toCam) > 0.3, `+Y 左前：右 ${Y.dot(right)}、前 ${Y.dot(toCam)}`)
  assert.ok(Zn.dot(toCam) > 0.4, '相机在天顶一侧')
})
t('参数化模型（几何按本体系建、根矩阵 = 出厂映射的逆）：模型系 → 本体系合成为单位阵，天顶（电池片静止位）落在显示 +Y；固定等轴从天顶一侧看', () => {
  const root = new THREE.Matrix4().fromArray(BF.ROOT_MATRIX_BODY2MODEL)
  const M = new THREE.Matrix4().multiplyMatrices(view.modelToBodyMatrix({}), root)
  assert.ok(M.elements.every((v, i) => near(v, i % 5 === 0 ? 1 : 0, 1e-12)), '出厂映射 × 根矩阵 = I')
  const zen = new THREE.Vector3(0, 0, -1).applyMatrix4(root).applyMatrix4(view.modelToBodyMatrix({})).applyMatrix4(view.BODY_TO_DISPLAY)
  assert.ok(nearV(zen, view.ZENITH_DISPLAY, 1e-12) && nearV(zen, [0, 1, 0], 1e-12), `天顶 → 显示 ${zen.toArray()}`)
  assert.ok(view.viewDir('iso').dot(zen) > 0.4, '固定等轴的相机在天顶一侧（俯仰 25° → 与天顶夹角 65°）：看得见电池面')
})
await ta('报告三视图（thumbs.THREE_VIEW_CELLS）：标题里的轴 = 相机所在的本体轴（BODY_VIEWS），前 / 侧视天顶朝上、顶视速度朝上', async () => {
  const TH = await import(SRC + 'thumbs.js')
  const cells = TH.THREE_VIEW_CELLS
  assert.equal(cells.length, 3)
  const AX = { '+X': [1, 0, 0], '+Y': [0, 1, 0], '−Z': [0, 0, -1] }
  for (const c of cells) {
    const m = /（([+−][XYZ])）/.exec(c.title)
    assert.ok(m && AX[m[1]], c.title)
    const bv = view.BODY_VIEWS[c.body]
    assert.deepEqual(c.dir, bv.dir); assert.deepEqual(c.up, bv.up)
    assert.ok(nearV(new THREE.Vector3(...c.dir).applyMatrix4(view.DISPLAY_TO_BODY), AX[m[1]], 1e-12), `${c.title}：拍摄方向`)
  }
  assert.ok(nearV(new THREE.Vector3(...cells[0].up), view.ZENITH_DISPLAY, 1e-12) && nearV(new THREE.Vector3(...cells[1].up), view.ZENITH_DISPLAY, 1e-12), '前 / 侧视天顶朝上')
  assert.ok(nearV(new THREE.Vector3(...cells[2].up).applyMatrix4(view.DISPLAY_TO_BODY), [1, 0, 0], 1e-12), '顶视速度 +X 朝上')
})
await ta('导入件材质兜底（materials.js）与离线管线 build.mjs 同口径：常量逐条相等；OBJ 无 .mtl → 中性灰、退化黑按名字还原', async () => {
  const MAT = await import(SRC + 'materials.js')
  const B = await import(pathToFileURL(path.resolve(HERE, '../../../scripts/nasa3d/build.mjs')).href)
  assert.equal(MAT.NEUTRAL_MATERIAL_NAME, B.NEUTRAL_MATERIAL_NAME)
  assert.equal(MAT.DEGENERATE_SHARE, B.DEGENERATE_SHARE)
  assert.equal(String(MAT.SOLAR_FACE_RE), String(B.SOLAR_FACE_RE))
  assert.equal(MAT.DEGENERATE_PALETTE.length, B.DEGENERATE_PALETTE.length)
  MAT.DEGENERATE_PALETTE.forEach((p, i) => { const q = B.DEGENERATE_PALETTE[i]; assert.equal(String(p.re), String(q.re)); assert.deepEqual([p.color, p.metallic, p.roughness], [q.color, q.metallic, q.roughness]) })
  for (const nm of ['Noaa-solarpanelFace', 'white paint', 'gold_mli', 'xyz']) assert.deepEqual(MAT.degeneratePaletteFor(nm).color, B.degeneratePaletteFor(nm).color, nm)
  // OBJ 没有 .mtl：OBJLoader 的缺省白 Phong → 中性浅灰
  const L = (...a) => a.join(String.fromCharCode(10)) + String.fromCharCode(10)
  const obj = L('o box', 'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'usemtl nothing', 'f 1 2 3', 'f 1 3 4')
  const r1 = await importFile({ bytes: new TextEncoder().encode(obj), name: 'nomtl.obj' }, {})
  const m1 = []; r1.root.traverse((o) => { if (o.isMesh) m1.push(o.material) })
  assert.ok(m1.length && m1.every((m) => m.name === MAT.NEUTRAL_MATERIAL_NAME && Math.abs(m.color.r - 0.8) < 1e-9 && m.metalness === 0), m1.map((m) => m.name))
  assert.equal(r1.materialFallback.noMaterialMeshes, m1.length)
  // .mtl 里的全黑材质占满整件 → 按名字还原（名字带 white → 白漆）；电池片正面的名字不论占比都还原
  const mtl = L('newmtl white_body', 'Kd 0 0 0', 'Ks 0 0 0', 'Ns 10', 'newmtl solar_front', 'Kd 0 0 0', 'Ks 0 0 0', 'Ns 10')
  const obj2 = L('mtllib a.mtl', 'o a', 'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 0 0 1', 'usemtl white_body', 'f 1 2 3', 'f 1 3 4', 'f 1 2 5', 'usemtl solar_front', 'f 2 3 5')
  const r2 = await importFile({ bytes: new TextEncoder().encode(obj2), name: 'a.obj' }, { readSibling: async (n) => (n === 'a.mtl' ? new TextEncoder().encode(mtl) : null) })
  const byName = new Map(); r2.root.traverse((o) => { if (o.isMesh) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) byName.set(m.name, m) })
  assert.ok(byName.get('white_body') && byName.get('white_body').color.r > 0.8, '白漆还原')
  assert.ok(byName.get('solar_front') && byName.get('solar_front').color.b > byName.get('solar_front').color.r, '电池片外观')
  assert.deepEqual(r2.materialFallback.degenerate.fixed.slice().sort(), ['solar_front', 'white_body'])
})
await ta('view.js 只依赖 three 与相对路径（不用 @core 别名）：不注册解析钩子的裸 node 进程能直接加载（nasa3d:sheets 离屏页只映射 three）', async () => {
  const fs = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const file = fileURLToPath(SRC + 'view.js')
  const specs = [...fs.readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] || m[2])
  assert.ok(specs.length >= 2, `import 语句 ${specs}`)
  for (const s of specs) assert.ok(s === 'three' || s.startsWith('three/') || s.startsWith('./') || s.startsWith('../'), `view.js 的 import「${s}」不是 three 或相对路径`)
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const v = await import(${JSON.stringify(SRC + 'view.js')}); if (JSON.stringify(v.DEFAULT_Q_MODEL2BODY) !== ${JSON.stringify(JSON.stringify(CORE_Q))}) process.exit(3)`], { encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, `裸 node 加载 view.js 失败：${r.stderr}`)
})
t('透视取景：所有点落进画面、四周留边，且至少一条边贴到留边线', () => {
  let s = 7
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const pts = new Float32Array(3000)
  for (let i = 0; i < 1000; i++) { pts[i * 3] = rnd() * 20 - 10; pts[i * 3 + 1] = rnd() * 2 - 1; pts[i * 3 + 2] = rnd() * 4 - 2 }
  for (const name of ['iso', 'front', 'top', 'left']) {
    const dir = view.viewDir(name)
    const fov = 35, aspect = 1.6, margin = 0.08
    const fit = view.fitPerspective(pts, dir, fov, aspect, margin)
    const cam = new THREE.PerspectiveCamera(fov, aspect, 0.01, 1e4)
    cam.position.copy(fit.target).addScaledVector(dir, fit.dist); cam.lookAt(fit.target); cam.updateMatrixWorld(); cam.updateProjectionMatrix()
    let mx = 0, my = 0
    const v = new THREE.Vector3()
    for (let i = 0; i < 1000; i++) { v.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]).project(cam); mx = Math.max(mx, Math.abs(v.x)); my = Math.max(my, Math.abs(v.y)) }
    const lim = 1 - 2 * margin
    assert.ok(mx <= lim + 1e-6 && my <= lim + 1e-6, `${name}: ${mx} ${my}`)
    assert.ok(Math.max(mx, my) > lim * 0.9, `${name}: 取景太松 ${mx} ${my}`)
  }
})

// ───────── irToThree.js ─────────
function makeTestIR() {
  const ir = IRM.makeIR({ sourceFormat: 'param' })
  const m0 = IRM.addMaterial(ir, { name: 'a', color: [0.5, 0.5, 0.5] })
  const m1 = IRM.addMaterial(ir, { name: 'b', color: [0.1, 0.2, 0.3], metalness: 1 })
  const quad = { position: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], index: [0, 1, 2, 0, 2, 3] }
  const tri = { position: [0, 0, 0, 1, 0, 0, 0, 1, 0], index: [0, 1, 2] }
  const q = IRM.addMesh(ir, { ...quad, material: m0 }), r = IRM.addMesh(ir, { ...tri, material: m1 })
  const root = IRM.addNode(ir, { name: 'bus' })
  IRM.addNode(ir, { name: 'panel', parent: root, mesh: q, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1], role: 'solarArray' })
  IRM.addNode(ir, { name: 'horn', parent: root, mesh: r })
  IRM.addNode(ir, { name: 'panel copy', mesh: q })
  return ir
}
t('IR → three → IR：节点名、父子、矩阵、三角形数、角色原样', () => {
  const ir = makeTestIR()
  const root = irToThree(ir)
  assert.equal(root.userData.__sceneRoot, true)
  const back = threeToIR(root)
  const names = back.nodes.map((x) => x.name)
  assert.deepEqual(names, ['ir_root', 'bus', 'panel', 'horn', 'panel copy'])
  const tris = (x) => x.meshes.reduce((a, m) => a + m.index.length / 3, 0)
  assert.equal(tris(back), 2 + 1 + 2)
  const panel = back.nodes.find((x) => x.name === 'panel')
  assert.equal(panel.role, 'solarArray')
  assert.equal(panel.matrix[13], 2)
  assert.equal(back.nodes[panel.parent].name, 'bus')
  let o = null; root.traverse((x) => { if (x.name === 'panel') o = x })
  assert.equal(o.userData.name, 'panel')   // 原名进 userData.name（与 GLTFLoader 同口径）
})
t('三角形编号：triTable 全局号 = segment.mjs 的实例顺序；irNodeTable 能落回网格', () => {
  const root = irToThree(makeTestIR())
  const tab = triTable(root)
  assert.deepEqual(tab.map((e) => [e.name, e.global, e.count]), [['panel', 0, 2], ['horn', 2, 1], ['panel copy', 3, 2]])
  const nt = irNodeTable(root)
  assert.equal(nt.get('horn').mesh.name, 'horn')
  const seg = autoSegment(threeToIR(root, { uv: false, normal: false }))
  for (const p of seg.parts) for (const tr of p.triRanges || []) assert.ok(nt.has(tr.node), '分割结果里的节点名在 three 侧找得到：' + tr.node)
  const total = seg.parts.reduce((a, p) => a + (p.tris || 0), 0)
  assert.equal(total, 5)
})
t('多材质网格：按组拆成「对象名_材质名」子节点，重名 / 空名唯一化', () => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0, 2, 1, 0], 3))
  g.setIndex([0, 1, 2, 1, 3, 2, 1, 4, 3, 4, 5, 3])
  g.addGroup(0, 6, 0); g.addGroup(6, 6, 1)
  const m = new THREE.Mesh(g, [new THREE.MeshStandardMaterial({ name: 'gold' }), new THREE.MeshStandardMaterial({ name: 'cell' })])
  m.name = 'part'
  const root = new THREE.Group(); root.name = 'r'
  const dup = new THREE.Group(); dup.name = 'part'
  const empty = new THREE.Group()
  root.add(m, dup, empty)
  const lay = irLayout(root).map((e) => e.name)
  assert.deepEqual(lay, ['r', 'part', 'part_gold', 'part_cell', 'part_2', 'node_5'])
  const ir = threeToIR(root)
  assert.equal(ir.meshes.length, 2)
  assert.equal(ir.meshes[0].position, ir.meshes[1].position)   // 同一几何的顶点只摊一份
  assert.equal(IRM.validateIR(ir).ok, true, JSON.stringify(IRM.validateIR(ir).errors))
})

// ───────── meshopt 压缩往返 ─────────
await ta('meshopt：顶点逐位相等、三角形集合相等、扩展与回退缓冲登记齐全', async () => {
  // 手搭一个 30×30 网格的 glb（位置 + 法向 + uint16 索引，各占一个缓冲视图）
  const N = 30, pos = [], nrm = [], idx = []
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { pos.push(i / N, Math.sin(i * 0.3) * 0.1, j / N); nrm.push(0, 1, 0) }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i; idx.push(a, a + N + 1, a + 1, a + 1, a + N + 1, a + N + 2) }
  const P = new Float32Array(pos), Nn = new Float32Array(nrm), I = new Uint16Array(idx)
  const bin = new Uint8Array(P.byteLength + Nn.byteLength + I.byteLength)
  bin.set(new Uint8Array(P.buffer), 0); bin.set(new Uint8Array(Nn.buffer), P.byteLength); bin.set(new Uint8Array(I.buffer), P.byteLength + Nn.byteLength)
  const nv = P.length / 3
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'grid' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min: [0, -0.1, 0], max: [1, 0.1, 1] },
      { bufferView: 1, componentType: 5126, count: nv, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: I.length, type: 'SCALAR' }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 },
      { buffer: 0, byteOffset: P.byteLength, byteLength: Nn.byteLength, target: 34962 },
      { buffer: 0, byteOffset: P.byteLength + Nn.byteLength, byteLength: I.byteLength, target: 34963 }],
    buffers: [{ byteLength: bin.byteLength }]
  }
  const glb = buildGlb(json, bin)
  const out = await meshoptCompressGlb(glb)
  assert.ok(out.byteLength < glb.byteLength, `${out.byteLength} < ${glb.byteLength}`)
  const p = parseGlb(out)
  assert.ok(p.ok)
  const j = p.json
  assert.ok(j.extensionsUsed.includes('EXT_meshopt_compression') && j.extensionsRequired.includes('EXT_meshopt_compression'))
  assert.equal(j.buffers.length, 2)
  assert.equal(j.buffers[1].extensions.EXT_meshopt_compression.fallback, true)
  await MeshoptDecoder.ready
  const dec = (k) => {
    const e = j.bufferViews[k].extensions.EXT_meshopt_compression
    const dst = new Uint8Array(e.count * e.byteStride)
    MeshoptDecoder.decodeGltfBuffer(dst, e.count, e.byteStride, p.bin.subarray(e.byteOffset, e.byteOffset + e.byteLength), e.mode, e.filter || 'NONE')
    return dst
  }
  assert.deepEqual(new Float32Array(dec(0).buffer), P)
  assert.deepEqual(new Float32Array(dec(1).buffer), Nn)
  const I2 = new Uint16Array(dec(2).buffer)
  const key = (a, b, c) => { const m = Math.min(a, b, c); return m === a ? `${a},${b},${c}` : m === b ? `${b},${c},${a}` : `${c},${a},${b}` }
  const s1 = new Set(); for (let k = 0; k < I.length; k += 3) s1.add(key(I[k], I[k + 1], I[k + 2]))
  for (let k = 0; k < I2.length; k += 3) assert.ok(s1.has(key(I2[k], I2[k + 1], I2[k + 2])))
  assert.equal(I2.length, I.length)
})

// ───────── LOD 抽稀 ─────────
await ta('抽稀：50×50 平面 ratio 0.1 降到目标附近；输出索引都在压实后的顶点范围内', async () => {
  const N = 50, pos = [], idx = []
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) pos.push(i, 0.02 * Math.sin(i * 0.2) * Math.cos(j * 0.2), j)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i; idx.push(a, a + N + 1, a + 1, a + 1, a + N + 1, a + N + 2) }
  const [res] = await simplifyMeshes({ meshes: [{ attributes: { position: { array: new Float32Array(pos), itemSize: 3, normalized: false } }, index: new Uint32Array(idx) }], ratio: 0.1, error: 0.05 })
  const r = res[0]
  assert.equal(r.tris0, N * N * 2)
  assert.ok(r.tris1 <= r.tris0 * 0.15 && r.tris1 > 0, `${r.tris1}`)
  const nv = r.attributes.position.array.length / 3
  for (const v of r.index) assert.ok(v < nv)
})
await ta('抽稀：三角形汤（STL 形态）先建索引再简化', async () => {
  const N = 20, pos = []
  const P = (i, j) => [i, 0.01 * Math.sin(i + j), j]
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pos.push(...P(i, j), ...P(i, j + 1), ...P(i + 1, j), ...P(i + 1, j), ...P(i, j + 1), ...P(i + 1, j + 1))
  const [res] = await simplifyMeshes({ meshes: [{ attributes: { position: { array: new Float32Array(pos), itemSize: 3, normalized: false } }, index: null }], ratio: 0.2, error: 0.05 })
  assert.ok(res[0].tris1 < res[0].tris0 * 0.4, `${res[0].tris0} → ${res[0].tris1}`)
  assert.equal(res[0].attributes.position.array.length / 3 <= (N + 1) * (N + 1), true)
})

// ───────── importers.js ─────────
await ta('OBJ + MTL：Maya 头注释 → cm；Phong 转 Standard，带色高光 → 金属；节点原名进 userData', async () => {
  const obj = '# This file uses centimeters as units for non-parametric coordinates.\nmtllib a.mtl\no panel\nv 0 0 0\nv 100 0 0\nv 100 100 0\nv 0 100 0\nusemtl gold\nf 1 2 3\nf 1 3 4\n'
  const mtl = 'newmtl gold\nKd 0.8 0.6 0.2\nKs 0.9 0.7 0.3\nNs 200\n'
  const r = await importFile({ bytes: new TextEncoder().encode(obj), name: 'x.obj' }, { readSibling: async (nm) => (nm === 'a.mtl' ? new TextEncoder().encode(mtl) : null) })
  assert.equal(r.format, 'obj'); assert.equal(r.unitHint, 'cm'); assert.equal(r.tris, 2)
  let mesh = null; r.root.traverse((o) => { if (o.isMesh) mesh = o })
  assert.ok(mesh.material.isMeshStandardMaterial)
  assert.ok(mesh.material.metalness > 0.5)
  assert.ok(Math.abs(mesh.material.roughness - Math.sqrt(2 / 202)) < 1e-9)
  assert.equal(mesh.userData.name, 'panel')
  assert.equal(r.root.userData.__sceneRoot, true)
})
await ta('STL 二进制：一个三角形、单位 unknown；坏 FBX 只抛状态', async () => {
  const buf = new ArrayBuffer(84 + 50), dv = new DataView(buf)
  dv.setUint32(80, 1, true)
  ;[0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((x, i) => dv.setFloat32(84 + i * 4, x, true))
  const s = await importFile({ bytes: new Uint8Array(buf), name: 'a.stl' })
  assert.equal(s.tris, 1); assert.equal(s.unitHint, 'unknown')
  await assert.rejects(() => importFile({ bytes: new Uint8Array([1, 2, 3]), name: 'b.fbx' }), /FBX 解析失败/)
  await assert.rejects(() => importFile({ bytes: new Uint8Array([1]), name: 'c.ply' }), /不支持的格式/)
})

// ───────── 命名一套规则 / 多材质拆分 / 导出件节点名 ─────────
t('irLayout 唯一化 = ir.mjs uniqueNodeNames：后缀不抢原名、场景根不参与争名', () => {
  const root = new THREE.Group(); root.name = 'satellite'; root.userData.__sceneRoot = true
  const mk = (nm) => { const g = new THREE.Group(); g.name = nm; return g }
  root.add(mk('a'), mk('a'), mk('a_2'), mk('satellite'), mk(''))
  const lay = irLayout(root)
  // 'a' 第二个不能取 'a_2'（后面有节点原名就叫 a_2）；对象 satellite 不被根抢名；空名按去掉根之后的序号
  assert.deepEqual(lay.map((e) => e.name), ['satellite_2', 'a', 'a_3', 'a_2', 'satellite', 'node_4'])
  assert.deepEqual(lay.slice(1).map((e) => e.name), IRM.uniqueNodeNames(['a', 'a', 'a_2', 'satellite', '']).names)
})

// 多材质网格（两个同名对象 part，各带 gold / cell 两组）+ 一个子节点，用来核对拆分前后布局逐一相同
function multiMatScene() {
  const mkMesh = () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0, 2, 1, 0], 3))
    g.setIndex([0, 1, 2, 1, 3, 2, 1, 4, 3, 4, 5, 3])
    g.addGroup(0, 6, 0); g.addGroup(6, 6, 1)
    const m = new THREE.Mesh(g, [new THREE.MeshStandardMaterial({ name: 'gold' }), new THREE.MeshStandardMaterial({ name: 'cell' })])
    m.name = 'part'; m.userData.name = 'part'
    return m
  }
  const root = new THREE.Group(); root.name = 'r'; root.userData.__sceneRoot = true
  const a = mkMesh(), b = mkMesh()
  const kid = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial()); kid.name = 'kid'
  a.add(kid); a.position.set(1, 2, 3)
  root.add(a, b)
  return root
}
t('splitMultiMaterial：拆完 irLayout 的名字、父子、全局三角形号与拆之前逐一相同；子几何共享属性', () => {
  const root = multiMatScene()
  const before = irLayout(root).map((e) => [e.name, e.parent])
  const tb = triTable(root).map((e) => [e.name, e.global, e.count])
  const s = splitMultiMaterial(root.clone(true))
  const after = irLayout(s).map((e) => [e.name, e.parent])
  assert.deepEqual(after, before)
  assert.deepEqual(triTable(s).map((e) => [e.name, e.global, e.count]), tb)
  assert.deepEqual(before.map((x) => x[0]), ['r', 'part', 'part_gold', 'part_cell', 'kid', 'part_2', 'part_gold_2', 'part_cell_2'])
  let sub = null, grp = null
  s.traverse((o) => { if (o.name === 'part_cell_2') sub = o; if (o.name === 'part' && !o.isMesh && !grp) grp = o })
  assert.ok(sub && sub.isMesh && !Array.isArray(sub.material) && sub.material.name === 'cell')
  assert.deepEqual(Array.from(sub.geometry.index.array), [1, 4, 3, 4, 5, 3])
  assert.equal(sub.geometry.userData._borrowed, true)
  assert.ok(grp && grp.position.x === 1 && grp.children.map((c) => c.name).join() === 'part_gold,part_cell,kid')
  const multi = []; root.traverse((o) => { if (o.isMesh && Array.isArray(o.material)) multi.push(o) })
  const src = multi[1]   // part_cell_2 属于第二个对象
  assert.equal(sub.geometry.attributes.position, src.geometry.attributes.position)   // 顶点属性共享，不复制
  // segment 的实例名（IR 名）在拆后的树里都是节点
  const seg = autoSegment(threeToIR(root, { uv: false, normal: false }))
  const names = new Set(); s.traverse((o) => names.add(o.name))
  for (const p of seg.parts) for (const nm of p.nodes || []) assert.ok(names.has(nm), nm)
})
t('irNodeTable：多材质子节点落到该材质组那一段索引；无网格节点给对象', () => {
  const nt = irNodeTable(multiMatScene())
  const e = nt.get('part_cell_2')
  assert.equal(e.sub, true); assert.equal(e.start, 6); assert.equal(e.count, 6)
  assert.equal(nt.get('part').mesh, null); assert.ok(nt.get('part').obj.isMesh)
  assert.equal(nt.get('kid').count, 36)
})

// GLTFExporter 的二进制输出走 FileReader（浏览器 API）：node 里补一个最小实现（只用 readAsArrayBuffer）
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class { readAsArrayBuffer(b) { b.arrayBuffer().then((ab) => { this.result = ab; if (this.onloadend) this.onloadend() }) } }
}
function satelliteObj() {
  // 同一个对象 satellite：金箔盒 + 两块电池片翼（usemtl 两段 solar_cells），OBJ / FBX 多材质件的典型形态
  const V = [], F = []
  const box = (x0, y0, z0, x1, y1, z1, mtl) => {
    const b = V.length
    for (const [x, y, z] of [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]) V.push(`v ${x} ${y} ${z}`)
    F.push('usemtl ' + mtl)
    for (const f of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]]) { F.push(`f ${b + f[0] + 1} ${b + f[1] + 1} ${b + f[2] + 1}`); F.push(`f ${b + f[0] + 1} ${b + f[2] + 1} ${b + f[3] + 1}`) }
  }
  box(-1, -1, -1, 1, 1, 1, 'gold_mli')
  box(1.2, -0.02, -0.8, 7, 0.02, 0.8, 'solar_cells')
  box(-7, -0.02, -0.8, -1.2, 0.02, 0.8, 'solar_cells')
  return {
    obj: 'mtllib s.mtl\no satellite\n' + V.join('\n') + '\n' + F.join('\n') + '\n',
    mtl: 'newmtl gold_mli\nKd 0.8 0.6 0.2\nKs 0.9 0.7 0.3\nNs 200\nnewmtl solar_cells\nKd 0.05 0.05 0.2\nKs 0.2 0.2 0.2\nNs 100\n'
  }
}
await ta('多材质 OBJ → 自动分割 → 导出 glb：太阳翼组 / 部件引用的 IR 子节点名都在导出件里，AGI 读回逐项相等', async () => {
  const { obj, mtl } = satelliteObj()
  const r = await importFile({ bytes: new TextEncoder().encode(obj), name: 'satellite.obj' }, { readSibling: async (nm) => (nm === 's.mtl' ? new TextEncoder().encode(mtl) : null) })
  const seg = autoSegment(threeToIR(r.root, { uv: false, normal: false }))
  assert.ok(seg.solarPanelGroups.length >= 1)
  assert.ok(seg.solarPanelGroups.every((g) => g.nodes.every((n) => /^satellite_solar_cells/.test(n))), JSON.stringify(seg.solarPanelGroups))
  const meta = { id: 'user:0123456789ab', title: 'sat', source: { kind: 'user', redistributable: true }, units: { scaleToMeters: 1 },
    parts: seg.parts, solarPanelGroups: seg.solarPanelGroups.map((g) => ({ name: g.name, efficiency: g.efficiency, nodes: g.nodes })),
    articulations: [{ name: 'wing_drive', nodes: [seg.solarPanelGroups[0].nodes[0]], stages: [{ name: 'rot', type: 'xRotate', minimumValue: -180, maximumValue: 180, initialValue: 0 }] }],
    attachPoints: [{ name: 'ap_earth', posBody: [0.5, 0.2, 1.1], dirBody: [0, 0, 1], upBody: [0, -1, 0] }, { name: 'ap_tilt', posBody: [-0.3, 0, -1], dirBody: [0.6, 0, -0.8] }],
    noObscurationNodes: [] }
  const e = await exportGlb(r.root, meta, { originAtCom: false })
  assert.deepEqual(e.info.errors, [])
  const p = parseGlb(e.glb)
  assert.ok(p.ok)
  const names = p.json.nodes.map((n) => n.name)
  // 场景根被摊平；对象名 satellite 没被文件名根抢走；每个材质组一个节点
  assert.deepEqual(names.slice().sort(), ['ap_earth', 'ap_tilt', 'satellite', 'satellite_gold_mli', 'satellite_solar_cells', 'satellite_solar_cells_2'])
  const agi = readAgiFromGltfJson(p.json)
  assert.deepEqual(agi.errors, [])
  const byName = (l) => Object.fromEntries(l.map((x) => [x.name, x]))
  const g0 = byName(meta.solarPanelGroups), g1 = byName(agi.solarPanelGroups)
  assert.deepEqual(Object.keys(g1).sort(), Object.keys(g0).sort())
  for (const k of Object.keys(g0)) { assert.deepEqual(g1[k].nodes, g0[k].nodes); assert.equal(g1[k].efficiency, g0[k].efficiency) }
  assert.deepEqual(agi.articulations.map((a) => [a.name, a.nodes]), [['wing_drive', meta.articulations[0].nodes]])
  for (const part of seg.parts) for (const nm of part.nodes || []) assert.ok(names.includes(nm), '部件节点 ' + nm)
  // 三角形数不变、材质不重复（两段 solar_cells 共用一个材质）
  const tris = p.json.meshes.reduce((a, m) => a + m.primitives.reduce((b, pr) => b + p.json.accessors[pr.indices].count / 3, 0), 0)
  assert.equal(tris, r.tris)
  assert.equal(p.json.materials.length, 2)
  assert.equal(p.json.extras.satsim.id, meta.id)
  // 挂点：导出件里造的空节点按 agi.mjs 的轴向口径（attachNodeMatrix），attachPointPoses 读回本体系位姿逐项相等；缺省上向按 D1
  const poses = attachPointPoses(p.json, agi.attachPoints, p.json.extras.satsim.frame)
  const want = { ap_earth: { pos: [0.5, 0.2, 1.1], dir: [0, 0, 1], up: [0, -1, 0] }, ap_tilt: { pos: [-0.3, 0, -1], dir: [0.6, 0, -0.8], up: defaultUpBody([0.6, 0, -0.8]) } }
  assert.equal(poses.length, 2)
  for (const q of poses) {
    const w = want[q.name]
    for (let k = 0; k < 3; k++) { assert.ok(near(q.posBody[k], w.pos[k], 1e-6), q.name + ' pos'); assert.ok(near(q.dirBody[k], w.dir[k], 1e-6), q.name + ' dir'); assert.ok(near(q.upBody[k], w.up[k], 1e-6), q.name + ' up') }
  }
  // 烘焙目标 = 出厂映射（STK 口径）：导出件的 frame.q 是出厂值；对地挂点节点的局部 +Y 在导出件的 glTF 系里 = 出厂 Rᵀ·(本体 +Z)，
  // 即 STK 读进去（按同一映射换轴）视轴朝天底
  assert.deepEqual(p.json.extras.satsim.frame.q_model2body, [...CORE_Q])
  const earth = p.json.nodes.find((nd) => nd.name === 'ap_earth')
  const qn = earth.rotation || [0, 0, 0, 1]
  const yLocal = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...qn))
  assert.ok(nearV(yLocal, BF.bodyToModel([0, 0, 1], CORE_Q), 1e-6), `导出件里对地挂点的视轴 ${yLocal.toArray()}`)
  assert.ok(nearV(new THREE.Vector3(...BF.modelToBody(yLocal.toArray(), BF.Q_MODEL2BODY_STK)), [0, 0, 1], 1e-6), 'STK 按它的换轴读：视轴 = 本体 +Z')
})
await ta('OBJ：多个对象 usemtl 同一材质 → 转成同一个 MeshStandardMaterial（材质分组不被拆散）', async () => {
  const obj = 'mtllib a.mtl\no p1\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl gold\nf 1 2 3\no p2\nv 2 0 0\nv 3 0 0\nv 2 1 0\nusemtl gold\nf 4 5 6\n'
  const mtl = 'newmtl gold\nKd 0.8 0.6 0.2\nKs 0.9 0.7 0.3\nNs 200\n'
  const r = await importFile({ bytes: new TextEncoder().encode(obj), name: 'x.obj' }, { readSibling: async () => new TextEncoder().encode(mtl) })
  const ms = []; r.root.traverse((o) => { if (o.isMesh) ms.push(o.material) })
  assert.equal(ms.length, 2)
  assert.equal(ms[0], ms[1])
  assert.ok(ms[0].isMeshStandardMaterial)
  const ir = threeToIR(r.root)
  assert.equal(ir.materials.length, 1)
})
t('删相机 / 灯节点：子网格提给父节点、世界位姿不变、先序位置不变', () => {
  const root = new THREE.Group()
  const a = new THREE.Group(); a.name = 'a'
  const cam = new THREE.PerspectiveCamera(); cam.position.set(5, 0, 0); cam.rotation.set(0, Math.PI / 2, 0); cam.scale.set(2, 2, 2)
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); m.name = 'm'; m.position.set(1, 1, 0)
  const b = new THREE.Group(); b.name = 'b'
  cam.add(m); root.add(a, cam, b)
  root.updateMatrixWorld(true)
  const w0 = m.matrixWorld.clone()
  hoistAndDrop([cam])
  root.updateMatrixWorld(true)
  assert.deepEqual(root.children.map((c) => c.name), ['a', 'm', 'b'])
  assert.ok(m.matrixWorld.elements.every((x, i) => near(x, w0.elements[i], 1e-12)))
})

// ───────── LOD：焊接 + 整模型误差 ─────────
await ta('抽稀：有索引但顶点不共享（每三角形各一份顶点）也先焊接再简化', async () => {
  const N = 30, pos = []
  const P = (i, j) => [i, 0.01 * Math.sin(i * 0.7 + j), j]
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pos.push(...P(i, j), ...P(i, j + 1), ...P(i + 1, j), ...P(i + 1, j), ...P(i, j + 1), ...P(i + 1, j + 1))
  const idx = new Uint32Array(pos.length / 3).map((_, i) => i)
  const [res] = await simplifyMeshes({ meshes: [{ attributes: { position: { array: new Float32Array(pos), itemSize: 3, normalized: false } }, index: idx }], ratio: 0.1, error: 0.05 })
  assert.ok(res[0].tris1 <= res[0].tris0 * 0.15, `${res[0].tris0} → ${res[0].tris1}`)
})
await ta('抽稀：errorScale 把误差换算成整模型口径 —— 小件放得更开；Prune 档可整块剔除', async () => {
  // 一个细分球（小件，errorScale 大）：同 error 下 errorScale=1 几乎不动，=50 时降到目标附近；Prune + 超大误差时整块剔除
  const geo = new THREE.SphereGeometry(1, 48, 32)
  const mk = () => ({ attributes: { position: { array: Float32Array.from(geo.attributes.position.array), itemSize: 3, normalized: false } }, index: Uint32Array.from(geo.index.array) })
  const [[a]] = await simplifyMeshes({ meshes: [mk()], ratio: 0.05, error: 0.001 })
  const [[b]] = await simplifyMeshes({ meshes: [{ ...mk(), errorScale: 50 }], ratio: 0.05, error: 0.001 })
  assert.ok(b.tris1 < a.tris1 * 0.5, `${a.tris1} vs ${b.tris1}`)
  const [[c]] = await simplifyMeshes({ meshes: [{ ...mk(), errorScale: 2000 }], ratio: 0.05, error: 0.001, prune: true })
  assert.ok(c.tris1 <= b.tris1, `${c.tris1}`)
})

// ───────── BVH Worker 的建树函数 ─────────
t('BVH：Worker 里建 → serialize → 主线程 deserialize，与直接建的逐位相同、拾取结果一致', () => {
  const g = new THREE.TorusKnotGeometry(1, 0.3, 120, 16)
  g.addGroup(0, 900, 0); g.addGroup(900, g.index.count - 900, 1)
  const [d, transfer] = buildSerializedBvh({ position: g.attributes.position.array.slice(), index: g.index.array.slice(), groups: g.groups, drawRange: g.drawRange })
  assert.ok(transfer.length >= 2)
  const g2 = g.clone()
  g2.boundsTree = MeshBVH.deserialize({ ...d, index: null }, g2, { setIndex: false, indirect: true })
  const direct = new MeshBVH(g.clone(), { indirect: true })
  assert.equal(d.roots.length, direct._roots.length)
  d.roots.forEach((r, i) => assert.deepEqual(new Uint8Array(r), new Uint8Array(direct._roots[i])))
  assert.deepEqual(Array.from(d.indirectBuffer), Array.from(direct._indirectBuffer))
  assert.deepEqual(Array.from(g2.index.array), Array.from(g.index.array))   // indirect：原索引不动
  const mesh = new THREE.Mesh(g2, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]); mesh.raycast = acceleratedRaycast
  const plain = new THREE.Mesh(g.clone(), mesh.material)
  const rc = new THREE.Raycaster(new THREE.Vector3(5, 0.3, 0.2), new THREE.Vector3(-1, 0, 0))
  const h1 = rc.intersectObject(mesh)[0], h2 = rc.intersectObject(plain)[0]
  assert.ok(h1 && h2 && near(h1.distance, h2.distance, 1e-9) && h1.faceIndex === h2.faceIndex)
})

// ───────── 其余 ─────────
t('导出闸 = isRedistributable（与主进程 models:export 同一判据）；STK 给专门状态', () => {
  assert.equal(exportBlocked({ id: 'stk:0123456789ab', source: { kind: 'stk-local', redistributable: false } }), 'STK 模型不可导出。')
  assert.equal(exportBlocked({ id: 'stk:0123456789ab', source: { kind: 'user', redistributable: true } }), 'STK 模型不可导出。')
  assert.equal(exportBlocked({ id: 'user:0123456789ab', source: { kind: 'stk-local', redistributable: true } }), 'STK 模型不可导出。')
  assert.equal(exportBlocked({ id: 'nasa:goes', source: { kind: 'nasa', redistributable: true } }), null)
  assert.equal(exportBlocked({ id: 'user:0123456789ab', source: { kind: 'user', redistributable: true } }), null)   // 主进程入库时用户导入记 true
  assert.equal(exportBlocked({ id: 'user:0123456789ab', source: { kind: 'user', redistributable: false } }), '该模型不可导出。')
  assert.equal(exportBlocked({ id: 'nasa:goes' }), '该模型不可导出。')   // 没有 source：不放行（与 isRedistributable 同）
})
t('材质库键 = IR 契约的 MaterialKey；贴图材质要米制 UV；部件角色都有叠色', () => {
  assert.deepEqual([...MATERIAL_KEYS].sort(), [...IRM.MATERIAL_KEYS].sort())
  assert.equal(keyNeedsUv('solar_cell'), true); assert.equal(keyNeedsUv('reflector'), false)
  for (const r of IRM.PART_ROLES) assert.ok(Number.isInteger(ROLE_COLORS[r]), r)
})

await ta('glb / glTF 的材质兜底（materials.gltfMaterialFallback，JSON 层）与离线管线 build.mjs applyMaterialFallbacks（gltf-transform）逐项同结果；只动 JSON 块', async () => {
  const MAT = await import(SRC + 'materials.js')
  const B = await import(pathToFileURL(path.resolve(HERE, '../../../scripts/nasa3d/build.mjs')).href)
  const { NodeIO } = await import('@gltf-transform/core')
  const { KHRONOS_EXTENSIONS } = await import('@gltf-transform/extensions')
  // 一份最小 glb：四个网格各一个图元（非索引三角形），POSITION 共用一个 bufferView（前 3t 个顶点）
  //   m0 没有材质（2 三角形）· m1 「white paint」退化黑（tris 个）· m2 「Noaa-solarpanelFace」退化黑（1）· m3 正常红漆（1）
  const mk = (whiteTris) => {
    const V = 3 * Math.max(2, whiteTris)
    const pos = new Float32Array(V * 3)
    for (let k = 0; k < V; k++) { pos[3 * k] = k % 3 === 1 ? 1 : 0; pos[3 * k + 1] = k % 3 === 2 ? 1 : 0; pos[3 * k + 2] = Math.floor(k / 3) * 0.01 }
    const acc = (t) => ({ bufferView: 0, componentType: 5126, count: 3 * t, type: 'VEC3', min: [0, 0, 0], max: [1, 1, Math.floor((3 * t - 1) / 3) * 0.01] })
    const black = (name) => ({ name, pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 0.9], metallicFactor: 0.3, roughnessFactor: 0.9 }, extensions: { KHR_materials_specular: { specularFactor: 0 } } })
    const json = {
      asset: { version: '2.0' }, extensionsUsed: ['KHR_materials_specular'],
      buffers: [{ byteLength: pos.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
      accessors: [acc(2), acc(whiteTris), acc(1), acc(1)],
      materials: [black('white paint'), black('Noaa-solarpanelFace'), { name: 'red', pbrMetallicRoughness: { baseColorFactor: [0.6, 0.1, 0.1, 1] } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 1 }, material: 0 }] }, { primitives: [{ attributes: { POSITION: 2 }, material: 1 }] }, { primitives: [{ attributes: { POSITION: 3 }, material: 2 }] }],
      nodes: [0, 1, 2, 3].map((k) => ({ mesh: k })), scenes: [{ nodes: [0, 1, 2, 3] }], scene: 0
    }
    return buildGlb(json, new Uint8Array(pos.buffer))
  }
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
  for (const whiteTris of [6, 1]) {   // 6：退化黑占 7/10 > 一半 → 全还原；1：占 2/5 → 只还原电池片正面
    const glb = mk(whiteTris)
    // 离线管线那一边
    const doc = await io.readBinary(glb)
    const fb = B.applyMaterialFallbacks(doc)
    const want = new Map(doc.getRoot().listMaterials().map((m) => [m.getName(), { bc: m.getBaseColorFactor().map((x) => +x.toFixed(6)), me: m.getMetallicFactor(), ro: m.getRoughnessFactor(), spec: !!m.getExtension('KHR_materials_specular'), ds: m.getDoubleSided() }]))
    // 渲染端 JSON 层这一边（patchGlbJson：BIN 逐字节不动）
    let st = null
    const r = parseGlb(glb)
    const P = await import(CORE + 'models/glb.mjs')
    const pr = P.patchGlbJson(glb, (json) => { st = MAT.gltfMaterialFallback(json); return st.changed ? undefined : false })
    assert.ok(pr.ok && pr.changed, 'JSON 改了')
    assert.deepEqual(Array.from(parseGlb(pr.glb).bin), Array.from(r.bin), 'BIN 块逐字节不动')
    assert.equal(st.noMaterialPrims, fb.noMaterialPrims)
    assert.equal(st.degenerate.share, fb.degenerate.share)
    assert.deepEqual(st.degenerate.fixed.slice().sort(), fb.degenerate.fixed.slice().sort())
    const got = new Map(pr.json.materials.map((m) => { const q = m.pbrMetallicRoughness || {}; return [m.name, { bc: (q.baseColorFactor || [1, 1, 1, 1]).map((x) => +Number(x).toFixed(6)), me: q.metallicFactor === undefined ? 1 : q.metallicFactor, ro: q.roughnessFactor === undefined ? 1 : q.roughnessFactor, spec: !!(m.extensions && m.extensions.KHR_materials_specular), ds: !!m.doubleSided }] }))
    assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort())
    for (const [k, v] of want) assert.deepEqual(got.get(k), v, whiteTris + '：' + k)
    // 改完的件 gltf-transform 读得进来；电池片正面不论占比都还原；没人再用 KHR_materials_specular 时声明一起去掉
    const doc2 = await io.readBinary(pr.glb)
    assert.equal(doc2.getRoot().listMaterials().length, 4)
    assert.ok(st.degenerate.fixed.includes('Noaa-solarpanelFace'))
    assert.equal((pr.json.extensionsUsed || []).includes('KHR_materials_specular'), whiteTris === 1, '白漆没还原时它还在用 specular')
    assert.equal(pr.json.meshes[0].primitives[0].material, pr.json.materials.findIndex((m) => m.name === MAT.NEUTRAL_MATERIAL_NAME))
  }
  // 什么都不用改：原样（patchGlbJson 回 changed:false）
  const clean = { asset: { version: '2.0' }, materials: [{ name: 'ok', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }], meshes: [] }
  assert.equal(MAT.gltfMaterialFallback(clean).changed, false)
  assert.equal(MAT.isDegenerateBlackGltf({ pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1] } }), false, '没有 specular = 0 不算退化黑（黑漆）')
  assert.equal(MAT.isDegenerateBlackGltf({ pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1] }, extensions: { KHR_materials_specular: {} } }), false, 'specularFactor 缺省 1')
})
await ta('STL 没有材质：与 OBJ 无 .mtl 同一条路，换成中性浅灰（不再是 0.62 灰金属）', async () => {
  const MAT = await import(SRC + 'materials.js')
  // ASCII STL 一个三角形
  const stl = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n'
  const r = await importFile({ bytes: new TextEncoder().encode(stl), name: 't.stl' }, {})
  const mats = []; r.root.traverse((o) => { if (o.isMesh) mats.push(o.material) })
  assert.equal(mats.length, 1)
  assert.equal(mats[0].name, MAT.NEUTRAL_MATERIAL_NAME)
  assert.ok(Math.abs(mats[0].color.r - 0.8) < 1e-9 && mats[0].metalness === 0 && mats[0].roughness === 0.6)
  assert.equal(r.materialFallback.noMaterialMeshes, 1)
})

console.log(`modelRenderStack: ${n} 项通过`)
