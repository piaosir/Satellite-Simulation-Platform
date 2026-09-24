// 3D 球模型层二期（src/viz/globe3d/modelLayer.js）里不依赖 GPU 的几何口径：
//   ① 挂架先摆关节静止位姿（thumbs.applyRestPose）：初值为 0 的缩放关节（STK 喷焰）藏掉、不进包围盒 / 包围半径
//   ② 带 pointingVector 的太阳翼关节按太阳转（attitude.articulationSunAngle）：转后的指向在转轴法平面内正对太阳投影（< 1e-6 rad）
//   ③ 限位：最优角落在限位外时夹到圆周角差更近的一端；静止位姿含 initialValue 时限位按「相对静止位姿」换算
//   ④ 名字像天线的关节即便带 pointingVector 也不跟太阳（它要对的是地面 / 目标星）；没有电池片也没有 pointingVector 的不动
//   ⑤ 跟随 HUD 挂点名按屏幕避让：视轴几乎平行的几副挂点从斜侧机位看，默认锚点下名字互相压住；declutter 之后两两不重叠，
//     也不压其它 HUD 字标；机位回正（不再重叠）时回到原位（行号 0）
//   ⑥ 避让不出画布：锚点贴上下沿（含刚出下沿两行内）时名字拉回画面、两两不重叠；右沿放不下、左侧放得下时翻到锚点左侧
//   ⑦ 输入没变不重排（静止帧只剩投影）：同一机位连两帧只重排一次、结果逐位相同；机位变 / 挂点表变就重排
// 图元与画面（跟随 HUD 挂点射线 / 视场锥、偏航导引）在真 Electron 验证台 .modelharness/w11/ 里跑。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const THREE = await import('three')
const ML = await import(SRC + 'globe3d/modelLayer.js')

let n = 0
const t = (name, fn) => { try { fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
const D2R = Math.PI / 180

// 小模型：本体盒 + 太阳翼（节点 SA_Wing，其下电池片 Cells：xy 平面板，法向 +Z）+ 喷焰（初值 0 的缩放关节，放在 −Z 20 m）+ 天线碟
function box(name, sx, sy, sz, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshBasicMaterial())
  m.name = name; m.userData.name = name; m.position.set(x, y, z)
  return m
}
function plate(name) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -4, 0, 1, -4, 0, 1, 4, 0, -1, -4, 0, 1, 4, 0, -1, 4, 0], 3))
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial())
  m.name = name; m.userData.name = name
  return m
}
function makeModel(arts, { wingRest = null } = {}) {
  const root = new THREE.Group(); root.name = 'root'
  root.add(box('Body', 2, 2, 2))
  const wing = new THREE.Group(); wing.name = 'SA_Wing'; wing.userData.name = 'SA_Wing'; wing.position.set(0, 3, 0)
  if (wingRest) wing.quaternion.setFromAxisAngle(new THREE.Vector3(...wingRest.axis), wingRest.deg * D2R)
  wing.add(plate('Cells'))
  root.add(wing)
  const thr = box('Thruster', 0.5, 0.5, 3, 0, 0, -20); root.add(thr)
  const dishG = new THREE.Group(); dishG.name = 'Dish'; dishG.userData.name = 'Dish'; dishG.add(box('DishMesh', 1, 1, 0.1, 0, 0, 1.5)); root.add(dishG)
  const meta = {
    frame: { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0] }, units: { scaleToMeters: 1 },
    solarPanelGroups: [], articulations: arts
  }
  return { inst: { root, meta }, wing, thr, dishG }
}
const stage = (type, min, max, init = 0) => ({ name: type, type, minimumValue: min, maximumValue: max, initialValue: init })
const THRUST = { name: 'Thrust_Main', nodes: ['Thruster'], stages: [stage('uniformScale', 0, 1, 0)] }
// 电池片法向（本体系）：把 Cells 网格的面法向经 matrixWorld 转过去
function cellNormalBody(mount) {
  mount.holder.updateMatrixWorld(true)
  let mesh = null
  mount.holder.traverse((o) => { if (!mesh && o.isMesh && (o.userData.name === 'Cells' || o.name === 'Cells')) mesh = o })
  const n0 = new THREE.Vector3(0, 0, 1)
  return n0.applyMatrix3(new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld)).normalize()
}
const perpAngle = (n, s, axis) => {
  // 太阳在转轴法平面上的投影与法向的夹角（法向本就在该平面内）
  const sp = s.clone().addScaledVector(axis, -s.dot(axis)).normalize()
  return Math.atan2(n.clone().cross(sp).length(), n.dot(sp))
}

t('① 静止位姿：初值 0 的喷焰藏掉、不进包围盒与包围半径', () => {
  const { inst, thr } = makeModel([THRUST])
  const m = ML.__test.mountInstance(inst)
  assert.equal(thr.visible, false, '喷焰节点隐藏')
  assert.ok(m.box.min[2] > -2, '包围盒没被 −Z 20 m 的喷焰撑大：' + m.box.min[2])
  assert.ok(m.radius < 9, '包围半径 ' + m.radius)   // 翼尖角点 ≈ 7.2 m；喷焰算进来会到 21 m 以上
  // 对照：不带关节时喷焰照画、盒子到 −21.5
  const b = makeModel([])
  const m2 = ML.__test.mountInstance(b.inst)
  assert.equal(b.thr.visible, true)
  assert.ok(m2.box.min[2] < -21, String(m2.box.min[2]))
})

t('② pointingVector 太阳翼：绕 Y 转到正对太阳投影（多个太阳方向 < 1e-6 rad）', () => {
  const art = { name: 'SolarArray', nodes: ['SA_Wing'], stages: [stage('yRotate', -180, 180)], pointingVector: [0, 0, 1] }
  const { inst } = makeModel([art, THRUST])
  const m = ML.__test.mountInstance(inst)
  assert.ok(m.sun && m.sun.count === 1, '只有太阳翼一条被驱动')
  const axis = new THREE.Vector3(0, 1, 0)
  let worst = 0
  for (let k = 0; k < 24; k++) {
    const th = (k * 15 + 7) * D2R, el = (k % 5 - 2) * 12 * D2R
    const s = new THREE.Vector3(Math.cos(el) * Math.sin(th), Math.sin(el), Math.cos(el) * Math.cos(th))
    m.sun.update(s)
    worst = Math.max(worst, perpAngle(cellNormalBody(m), s, axis))
  }
  assert.ok(worst < 1e-6, '残差 ' + worst)
  const a = m.sun.angles()
  assert.equal(a.length, 1)
  assert.ok(Number.isFinite(a[0]))
})

t('③ 限位与 initialValue：最优角在限位外夹到近端；静止位姿含初值时按相对区间夹', () => {
  // 限位 [−30, 30]，初值 0：太阳在 +X（最优 +90°）→ 夹到 +30
  const art = { name: 'SolarArray', nodes: ['SA_Wing'], stages: [stage('yRotate', -30, 30)], pointingVector: [0, 0, 1] }
  const { inst } = makeModel([art])
  const m = ML.__test.mountInstance(inst)
  m.sun.update(new THREE.Vector3(1, 0, 0))
  assert.ok(Math.abs(m.sun.angles()[0] - 30) < 1e-9, String(m.sun.angles()[0]))
  // 初值 20（applyRestPose 先把翼转 20°），限位 [−30, 30] → 相对静止位姿只能再转 [−50, 10]
  const art2 = { name: 'SolarArray', nodes: ['SA_Wing'], stages: [stage('yRotate', -30, 30, 20)], pointingVector: [0, 0, 1] }
  const b = makeModel([art2])
  const m2 = ML.__test.mountInstance(b.inst)
  m2.sun.update(new THREE.Vector3(1, 0, 0))
  assert.ok(Math.abs(m2.sun.angles()[0] - 10) < 1e-9, '相对静止位姿 +10° → 绝对 30°：' + m2.sun.angles()[0])
  // 电池片法向与 +Z 的实际夹角 = 30°（绕 Y：+Z 转向 +X）
  const nb = cellNormalBody(m2)
  assert.ok(Math.abs(Math.atan2(nb.x, nb.z) / D2R - 30) < 1e-6, String(Math.atan2(nb.x, nb.z) / D2R))
})

t('④ 天线类关节（带 pointingVector）不跟太阳；无电池片无 pointingVector 的不动', () => {
  const ant = { name: 'Antenna_Gimbal', nodes: ['Dish'], stages: [stage('zRotate', -90, 90)], pointingVector: [0, 1, 0] }
  const bare = { name: 'SolarWing_NoPv', nodes: ['SA_Wing'], stages: [stage('yRotate', -180, 180)] }
  const { inst } = makeModel([ant, bare])
  const m = ML.__test.mountInstance(inst)
  assert.equal(m.sun, null)
  // 同样的 bare 关节，但电池片节点在太阳翼组里（节点名命中关节）→ 按电池片法向驱动
  const grp = { name: 'SolarArray', nodes: ['Cells'], stages: [stage('yRotate', -180, 180)] }
  const b = makeModel([grp])
  b.inst.meta.solarPanelGroups = [{ name: 'SA', nodes: ['Cells'], efficiency: 30 }]
  const m2 = ML.__test.mountInstance(b.inst)
  assert.ok(m2.sun && m2.sun.count === 1)
  const s = new THREE.Vector3(0.6, 0.2, -0.77).normalize()
  m2.sun.update(s)
  assert.ok(perpAngle(cellNormalBody(m2), s, new THREE.Vector3(0, 1, 0)) < 1e-6)
})

t('⑤ HUD 挂点名按屏幕避让：斜侧机位下两两不重叠、不压其它字标；不撞时回原位', () => {
  // 假 document：makeLabel 只要一块能量字宽的 canvas（字宽按 0.6 em 估）
  const prevDoc = globalThis.document
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ font: '', textBaseline: '', lineJoin: '', strokeStyle: '', lineWidth: 0, fillStyle: '', measureText: (s) => ({ width: String(s).length * 48 * 0.6 }), strokeText() {}, fillText() {} }) }) }
  try {
    const hud = ML.__test.createHud(new Set())
    // 典型 GEO 通信星的对地挂点：视轴都朝本体 +Z（差零点几度），装在星体底面相邻几处
    const mounts = [
      { name: 'Ku 可动点波束 1', posBody: [0.6, 0.5, 1.2], dir: [0.01, 0, 1] },
      { name: 'Ku 可动点波束 2', posBody: [-0.6, 0.5, 1.2], dir: [-0.01, 0, 1] },
      { name: '全球波束', posBody: [0, -0.9, 1.3], dir: [0, 0, 1], fovDeg: 17.4 },
      { name: 'C 赋形', posBody: [0, 0.9, 1.3], dir: [0, 0.005, 1] }
    ]
    hud.setMounts(mounts)
    const W = 1200, H = 800
    const cam = new THREE.PerspectiveCamera(42, W / H, 0.01, 1e5)
    const labelK = 2 * Math.tan(42 * Math.PI / 360) / H
    const on = { bodyAxes: true, lvlh: false, nadir: false, velocity: false, sun: false, mounts: true }
    // 斜侧机位：几乎顺着视轴方向看过去（视轴被透视压扁，沿射线错开的长度不起作用）
    cam.position.set(4, 3, -30); cam.lookAt(0, 0, 0)
    hud.update(on, 3, cam.position.length(), labelK)
    const overlap = (rs) => { let k = 0; for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], b = rs[j]; if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) k++ } return k }
    const before = hud.mountLabelRects(cam, W, H)
    assert.equal(before.length, 4)
    assert.ok(overlap(before) > 0, '斜侧机位下默认锚点应当有重叠（否则本例没测到东西）')
    const moved = hud.declutter(cam, W, H)
    const after = hud.mountLabelRects(cam, W, H)
    assert.equal(overlap(after), 0, JSON.stringify(after.map((r) => [r.name, Math.round(r.y0), Math.round(r.y1)])))
    assert.ok(moved > 0)
    // 不压其它 HUD 字标（本体轴 +X / +Y / +Z）
    const axisRects = ['bx', 'by', 'bz'].map((k) => { const s = hud.items[k].label; s.getWorldPosition(new THREE.Vector3()); const p = s.getWorldPosition(new THREE.Vector3()).project(cam); const px = (p.x + 1) / 2 * W, py = (1 - p.y) / 2 * H, hh = s.userData.pxH, ww = hh * s.userData.ar; return { x0: px - s.center.x * ww, x1: px - s.center.x * ww + ww, y0: py - hh / 2, y1: py + hh / 2 } })
    assert.equal(overlap([...after, ...axisRects]) - overlap(axisRects), 0, '挂点名不压本体轴字标')
    // 同一机位再来一帧：结果不变（上一帧的行号先试，不抖）
    const again = hud.declutter(cam, W, H)
    assert.equal(again, moved)
    assert.deepEqual(hud.mountLabelRects(cam, W, H).map((r) => Math.round(r.y0)), after.map((r) => Math.round(r.y0)))
    // 机位回正（从 +X 侧面看，四支射线在屏上分得开）：不撞就回原位
    cam.position.set(30, 0, 0); cam.lookAt(0, 0, 0)
    hud.update(on, 3, cam.position.length(), labelK)
    const free = hud.mountLabelRects(cam, W, H)
    hud.declutter(cam, W, H)
    const back = hud.mountLabelRects(cam, W, H)
    if (overlap(free) === 0) assert.deepEqual(back.map((r) => Math.round(r.y0)), free.map((r) => Math.round(r.y0)), '不重叠时应回到默认锚点')
    assert.equal(overlap(back), 0)
    hud.dispose()
  } finally { globalThis.document = prevDoc }
})

// ⑥ / ⑦ 共用：假 document + 五副几乎平行的对地挂点（⑤ 的四副再加一副，挤得更密）
function withHud(fn) {
  const prevDoc = globalThis.document
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ font: '', textBaseline: '', lineJoin: '', strokeStyle: '', lineWidth: 0, fillStyle: '', measureText: (s) => ({ width: String(s).length * 48 * 0.6 }), strokeText() {}, fillText() {} }) }) }
  const hud = ML.__test.createHud(new Set())
  try {
    hud.setMounts([
      { name: 'Ku 可动点波束 1', posBody: [0.6, 0.5, 1.2], dir: [0.01, 0, 1] },
      { name: 'Ku 可动点波束 2', posBody: [-0.6, 0.5, 1.2], dir: [-0.01, 0, 1] },
      { name: '全球波束', posBody: [0, -0.9, 1.3], dir: [0, 0, 1], fovDeg: 17.4 },
      { name: 'C 赋形', posBody: [0, 0.9, 1.3], dir: [0, 0.005, 1] },
      { name: 'Ku 频段反射面（西）', posBody: [0.3, -0.4, 1.25], dir: [0.004, 0.002, 1] }
    ])
    fn(hud)
  } finally { hud.dispose(); globalThis.document = prevDoc }
}
const overlapN = (rs) => { let k = 0; for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], b = rs[j]; if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) k++ } return k }

t('⑥ 避让不出画布：锚点贴上下沿（含刚出下沿）时名字拉回画面、两两不重叠；右沿放不下时翻到锚点左侧', () => {
  withHud((hud) => {
    const W = 1200, H = 800
    const cam = new THREE.PerspectiveCamera(42, W / H, 0.01, 1e5)
    const labelK = 2 * Math.tan(42 * Math.PI / 360) / H
    const on = { bodyAxes: false, lvlh: false, nadir: false, velocity: false, sun: false, mounts: true }
    // 纵向扫：机位不动、视线目标上下平移，挂点名锚点（射线端点）从画面中部一路压过上 / 下沿
    let checked = 0, edge = 0, outside = 0
    for (let k = -90; k <= 90; k++) {
      cam.position.set(4, 3, -30); cam.lookAt(0, k * 0.25, 6)
      hud.update(on, 3, cam.position.length(), labelK)
      hud.declutter(cam, W, H)
      const rs = hud.mountLabelRects(cam, W, H)
      if (rs.length !== 5) continue
      const hh = rs[0].y1 - rs[0].y0
      // 锚点横向在画布里、纵向不超出画布两行的机位才判（再远的名字跟着锚点留在画外）
      if (!rs.every((r) => r.px >= 0 && r.px <= W && r.py >= -2 * hh && r.py <= H + 2 * hh)) continue
      checked++
      if (rs.some((r) => r.py - hh / 2 < 0 || r.py + hh / 2 > H)) edge++          // 原位会出上下沿
      if (rs.some((r) => r.py < 0 || r.py > H)) outside++                          // 锚点本身已出画布
      const out = rs.filter((r) => r.y0 < -1e-9 || r.y1 > H + 1e-9 || r.x0 < -1e-9 || r.x1 > W + 1e-9)
      assert.equal(out.length, 0, `目标 y=${k * 0.25}：${JSON.stringify(out.map((r) => [r.name, Math.round(r.py), Math.round(r.y0), Math.round(r.y1)]))}`)
      assert.equal(overlapN(rs), 0, `目标 y=${k * 0.25} 仍有重叠：${JSON.stringify(rs.map((r) => [r.name, Math.round(r.x0), Math.round(r.y0), r.cx]))}`)
    }
    assert.ok(checked > 20, '有效机位 ' + checked)
    assert.ok(edge >= 2 && outside >= 1, `贴边机位 ${edge}、锚点出画布的机位 ${outside}（否则本例没测到边界）`)
    // 横向扫：本机位下屏幕右 = 世界 −X，视线目标往 +X 挪 → 画面内容往右走，锚点压到右沿
    let flips = 0, checkedX = 0
    for (let k = 0; k <= 120; k++) {
      cam.position.set(4, 3, -30); cam.lookAt(k * 0.2, 0, 6)
      hud.update(on, 3, cam.position.length(), labelK)
      hud.declutter(cam, W, H)
      for (const r of hud.mountLabelRects(cam, W, H)) {
        const ww = r.x1 - r.x0
        if (!(r.px >= 0 && r.px <= W && r.py >= 0 && r.py <= H)) continue
        checkedX++
        const fitsRight = r.px + 0.15 * ww + ww <= W, fitsLeft = r.px - 1.15 * ww >= 0
        if (fitsRight || fitsLeft) assert.ok(r.x0 >= -1e-9 && r.x1 <= W + 1e-9, `${r.name} 横向出界：px=${r.px.toFixed(1)} x0=${r.x0.toFixed(1)} x1=${r.x1.toFixed(1)}`)
        if (!fitsRight && fitsLeft) { assert.ok(Math.abs(r.cx - 1.15) < 1e-12, `${r.name} 右侧放不下却没翻`); flips++ }
      }
    }
    assert.ok(checkedX > 40 && flips > 0, `横向有效 ${checkedX}、翻转 ${flips}`)
  })
})

t('⑦ 输入没变不重排：同一机位连调两帧只重排一次、结果相同；机位一动就重排', () => {
  withHud((hud) => {
    const W = 1200, H = 800
    const cam = new THREE.PerspectiveCamera(42, W / H, 0.01, 1e5)
    const labelK = 2 * Math.tan(42 * Math.PI / 360) / H
    const on = { bodyAxes: true, lvlh: false, nadir: false, velocity: false, sun: false, mounts: true }
    cam.position.set(4, 3, -30); cam.lookAt(0, 0, 0)
    hud.update(on, 3, cam.position.length(), labelK)
    const r0 = hud.declutterRuns()
    const m1 = hud.declutter(cam, W, H)
    const a = hud.mountLabelRects(cam, W, H)
    hud.update(on, 3, cam.position.length(), labelK)   // 逐帧照样调 update（值不变）
    const m2 = hud.declutter(cam, W, H)
    assert.equal(hud.declutterRuns() - r0, 1, '静止第二帧应跳过重排')
    assert.equal(m2, m1)
    assert.deepEqual(hud.mountLabelRects(cam, W, H), a)
    cam.position.set(4.5, 3, -30); cam.lookAt(0, 0, 0)
    hud.update(on, 3, cam.position.length(), labelK)
    hud.declutter(cam, W, H)
    assert.equal(hud.declutterRuns() - r0, 2, '机位变了要重排')
    // 挂点表换了（名字变 → 字标是新对象）：即便屏幕位置没变也要重排
    hud.setMounts([{ name: '改名', posBody: [0.6, 0.5, 1.2], dir: [0.01, 0, 1] }])
    hud.update(on, 3, cam.position.length(), labelK)
    hud.declutter(cam, W, H)
    assert.equal(hud.declutterRuns() - r0, 3, '挂点表变了要重排')
  })
})

console.log(`modelGlobeLayerP2: ${n} 项通过`)
