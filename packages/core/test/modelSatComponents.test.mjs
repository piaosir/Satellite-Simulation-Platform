// 卫星组件补全（2026-10-08）：天线 / 有效载荷 / 设备 / 星体新件与相控阵、喇叭、杆件、网状反射面升级。
//
// ① 登记：卫星件全部带功能分组 category 与搜索别名、枚举选项全部有中文名（optionLabels）、主要参数键都存在；新件逐件多组参数可生成、
//    无非有限数、质量 > 0（星敏 / 太敏 / 地敏 / 测控天线照旧只画不计质量）。
// ② 旧版兼容：相控阵「矩形 + 白色罩面 + 白边框」与旧实现（逐块无底面白盒 + 面板质量元）逐位相同——specToAssembly 的平板 LEO 阵面靠它与整星同形。
// ③ 指向机构运动学：方位-俯仰 / X-Y 两种，挂点视轴 = 设定指向；关节 stage 增量叠到节点系上恰为「设定指向 + 增量」的两轴指向（烘焙口径见 satAntenna.mjs 文件头）。
// ④ 对称面：声明的对称面与几何逐点一致（顶点集合关于该局部面镜像后仍在集合里）。
// ⑤ 多波束馈源阵装到反射面焦点：按 mountFor 规则用口面接口对接，口面中心落在焦点、口面朝反射面口径中心。
// ⑥ 组件库：卫星组按功能小组分（结构与机构 → … → 热控），别名可搜（QHA / LCT / 圣诞树 / SAR…）；枚举显示名取 optionLabels。
// ⑦ 掩模自遮挡：装配件天线挂点 <前缀>_boresight 排除本组件全部部件；反射面 refl<n>_focus 旧口径不变。
// ⑧ 质量式：贮箱 = 壳 + 推进剂（充填率 × 容积 × 密度）、激光终端按口径平方缩放、光学相机按入瞳面积；电推臂 / 遮阳板 / 消旋天线。
// ⑨ 常用型号：每个型号补缺省后参数合法、可生成；组件库里各占一张卡片（键 type#id），可搜、悬停带所属组件，体装电池片归电源小组；
//    坏型号（未知参数键 / 参数越界 / 重复 id）登记时就抛错。
// ⑩ 电推力器指向臂 / 遮阳板 / 机械消旋天线运动学：关节链静止时恒等，增量叠上去恰为「设定构型 + 增量」（展开 / 肘部 / 两轴指向 / 消旋 / 俯仰）。
// ⑪ 太阳翼五种（刚性 / 铰接式 / 柔性 / 卷展式 / 圆形）：单轴对日关节（pointingVector = 电池面法向）、太阳翼组含全部电池节点、
//    镜像钩子（绕翼轴转角取反）生成的几何 = 原几何的真镜像（逐顶点）、刚性翼新外形选项缺省时与整星逐字节同式、质量式。
// ⑫ 星体四种（多棱柱 / 立方星 / 球形 / 舱段式）：接口落在表面上、可贴面合法、质量式（体密度 / 每 1U / 密封舱密度）、立方星体装电池成组。
// 不联网。

import assert from 'node:assert/strict'
import { getComponent, getPreset, listComponents, registerComponent, fillParams, checkParams, COMPONENT_CATEGORIES } from '../models/components/index.mjs'
import { buildComponent, buildAssembly, solvePose } from '../models/assembly.mjs'
import { mountFor } from '../models/asmSnap.mjs'
import { reflectorFrame } from '../models/components/sat.mjs'
import { PROPELLANT_DENSITY } from '../models/components/satUnit.mjs'
import { DENSITY } from '../models/paramBus.mjs'
import { MB, box } from '../models/meshKit.mjs'
import * as L from '../../../src/model/asmLogic.js'
import { ownAntennaNodes } from '../../../src/model/mountLogic.js'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} ≠ ${b}（容差 ${tol}）`)
const nearV = (a, b, tol, msg) => { for (let k = 0; k < 3; k++) near(a[k], b[k], tol, `${msg}[${k}]`) }
const D2R = Math.PI / 180

const NEW = ['sat.bus.trap', 'sat.bus.flat', 'sat.antenna.gimbal', 'sat.antenna.helix', 'sat.antenna.omni', 'sat.antenna.lpda', 'sat.antenna.shroud', 'sat.antenna.slot',
  'sat.feed.cluster', 'sat.lct', 'sat.camera', 'sat.instrument', 'sat.lra', 'sat.tank', 'sat.sensor.mag', 'sat.dock', 'sat.ep.arm', 'sat.visor', 'sat.antenna.despun',
  'sat.wing.hinged', 'sat.wing.flex', 'sat.wing.rosa', 'sat.wing.circular', 'sat.bus.prism', 'sat.bus.cubesat', 'sat.bus.sphere', 'sat.bus.module']
const MASSLESS = new Set(['sat.sensor.star', 'sat.sensor.sun', 'sat.sensor.earth', 'sat.antenna.ttc'])
const VARIANTS = {
  'sat.array.phased': [{}, { face: 'disc', shape: 'oct' }, { face: 'horn', freqGHz: 12 }, { face: 'dipole', freqGHz: 1.6 }, { face: 'radome', shape: 'chamfer' }, { face: 'sunshield', shape: 'hex' }, { shape: 'circle' }, { tiles: 6, wM: 2.7, hM: 2.3 }, { tiles: 5, tileRows: 1, wM: 12, hM: 0.8, face: 'radome' }, { freqGHz: 30 }],
  'sat.antenna.gimbal': [{}, { gimbal: 'xy', azDeg: 30, tiltDeg: 40 }, { gimbal: 'fixed', tiltDeg: 20 }, { feed: 'cass', front: 'black' }, { azDeg: 90, tiltDeg: 60, struts: 3 }, { articulate: false }],
  'sat.antenna.helix': [{}, { layout: 'single', freqGHz: 0.4 }, { layout: 'ring', nInner: 6 }, { layout: 'grid', gridN: 4, cap: true }, { hand: 'lhcp' }],
  'sat.antenna.omni': [{}, { kind: 'monopole' }, { kind: 'dipole' }, { kind: 'qha', freqGHz: 2.2 }, { kind: 'qha', radome: false }, { kind: 'patch', freqGHz: 2.2 }, { kind: 'patch', chokes: 4, freqGHz: 1.575 }, { style: 'tape' }, { kind: 'conemast', freqGHz: 2.2 }],
  'sat.antenna.lpda': [{}, { crossed: false }, { fLowGHz: 0.05, fHighGHz: 0.1 }],
  'sat.antenna.shroud': [{}, { style: 'dome' }],
  'sat.antenna.slot': [{}, { bars: 1, fanDeg: 0 }],
  'sat.feed.cluster': [{}, { rings: 0 }, { rings: 4, style: 'terraced', cap: 'ge' }, { plate: 'circle', backHM: 0 }],
  'sat.lct': [{}, { type: 'periscope', azDeg: 45, tiltDeg: 30 }, { electronics: false, tiltDeg: 60 }],
  'sat.camera': [{}, { type: 'box' }, { cutDeg: 0 }],
  'sat.instrument': [{}, { window: 'side', cooler: 'none' }],
  'sat.lra': [{}, { layout: 'grid' }, { layout: 'ring' }, { layout: 'ring', ringN: 35, ringRM: 0.3 }],
  'sat.dock': [{}, { type: 'probe' }, { type: 'grapple' }, { sizeM: 1.666, lengthM: 0.15 }],
  'sat.bus.cyl': [{}, { drumCells: true, mli: 'none' }],
  'sat.tank': [{}, { shape: 'capsule' }, { propellant: 'none' }],
  'sat.sensor.mag': [{}, { type: 'cube' }],
  'sat.bus.trap': [{}, { mli: 'none' }],
  'sat.bus.flat': [{}, { chamferM: 0, ribs: false }],
  'sat.feed.horn': [{}, { kind: 'pyramid' }],
  'sat.boom': [{}, { style: 'lattice', dM: 0.3, canister: true }],
  'sat.reflector': [{ surface: 'mesh', diameterM: 9, meshStyle: 'radial' }, { surface: 'mesh', diameterM: 9, meshStyle: 'modular' }],
  'sat.ep.arm': [{}, { arm: 'one', thrusters: 1 }, { arm: 'none' }, { azDeg: 40, tiltDeg: 10 }, { rootDeg: 120, elbowDeg: -30 }, { articulate: false }],
  'sat.visor': [{}, { panels: 1, frame: true, deployDeg: 90 }, { deployDeg: 0 }, { deployDeg: 180, panels: 3 }, { hingeHM: 0, articulate: false }],
  'sat.antenna.despun': [{}, { kind: 'mech' }, { kind: 'mech', azDeg: 30, elevDeg: 10 }, { columns: 31, discDM: 0, mastHM: 0 }],
  'sat.wing': [{}, { yoke: 'trap' }, { yoke: 'scissor', yokeLenM: 2 }, { yoke: 'rod', yokeLenM: 1 }, { columns: 3 }, { cellType: 'si', bothFaces: true, frame: true, hinges: true }, { concentrator: true }, { sidePanels: 2, hinges: true }],
  'sat.wing.hinged': [{}, { rows: 14, cols: 2, lengthM: 8.1, widthM: 2.8 }, { deployDeg: 0 }, { deployDeg: 180, bothFaces: true, cellType: 'si' }, { articulate: false, hingeHM: 0 }],
  'sat.wing.flex': [{}, { yoke: 'trap', tiltDeg: 30 }, { yokeLenM: 0, sadaLenM: 0 }, { segments: 1, cellType: 'si' }],
  'sat.wing.rosa': [{}, { yoke: 'v' }, { yokeLenM: 0 }],
  'sat.wing.circular': [{}, { sweepDeg: 200, gores: 7 }, { cellType: 'si', yokeLenM: 0 }],
  'sat.bus.prism': [{}, { sides: 3 }, { sides: 5, mli: 'none' }, { sides: 24 }],
  'sat.bus.cubesat': [{}, { skin: 'black' }, { skin: 'aluminum' }, { skin: 'gold', xM: 0.3405, yM: 0.3405, zM: 0.366 }],
  'sat.bus.sphere': [{}, { form: 'polyhedron' }, { form: 'polyhedron', lonSeg: 7, latSeg: 3, accent: 'gold_metal', reflectors: 40 }, { reflectors: 100 }],
  'sat.bus.module': [{}, { front: 'dome', aft: 'dome' }, { coneLenM: 0, lSmallM: 0, front: 'flat', bands: false }, { aft: 'dock', dSmallM: 4 }]
}

// ───────────────────────── ① 登记 ─────────────────────────

t('登记：卫星件都带 category / aliases，枚举选项全有中文名，主要参数键都存在；新件全在库里', () => {
  const sat = listComponents('spacecraft').filter((d) => d.type.startsWith('sat.'))
  assert.equal(sat.length, 42)
  for (const ty of NEW) assert.ok(getComponent(ty), `缺 ${ty}`)
  for (const d of sat) {
    assert.ok(COMPONENT_CATEGORIES.includes(d.category), `${d.type} 缺功能分组`)
    assert.ok(Array.isArray(d.aliases) && d.aliases.length >= 2, `${d.type} 缺搜索别名`)
    for (const k of d.keys) {
      const s = d.params[k]
      if (s.kind !== 'enum') continue
      if (k === 'mli') continue   // 多层材质走材质名表（MATERIAL_LABELS）
      for (const o of s.options) assert.ok(s.optionLabels && s.optionLabels[o], `${d.type}.${k} 选项 ${o} 缺中文名`)
    }
    for (const k of L.keyParamsOf(d)) assert.ok(d.keys.includes(k), `${d.type} 主要参数 ${k} 不存在`)
    assert.ok(L.keyParamsOf(d).length >= 2, `${d.type} 主要参数太少`)
  }
})

t('逐件多组参数可生成：无非有限数、质量 > 0（只画不计质量的敏感器 / 测控天线除外）、参数校验通过', () => {
  for (const d of listComponents('spacecraft')) {
    for (const v of [...(VARIANTS[d.type] || [{}]), ...(d.presets || []).map((x) => x.params)]) {
      const p = fillParams(d, v)
      assert.deepEqual(checkParams(d, p), [], `${d.type} ${JSON.stringify(v)} 参数`)
      const c = buildComponent(d.type, v)
      for (const m of c.ir.meshes) assert.ok(m.position.every(Number.isFinite) && m.normal.every(Number.isFinite), `${d.type} ${JSON.stringify(v)} 网格非有限数`)
      if (!MASSLESS.has(d.type) && !d.type.startsWith('prim.')) assert.ok(c.massKg > 0, `${d.type} ${JSON.stringify(v)} 质量 ${c.massKg}`)
      for (const a of c.attachPoints) assert.ok(a.posBody.every(Number.isFinite) && Math.abs(Math.hypot(...a.dirBody) - 1) < 1e-9, `${d.type} 挂点 ${a.name}`)
    }
  }
})

t('参数约束：分块与外廓 / 行数、频率上下限、贮箱总长、观测窗尺寸', () => {
  const bad = (type, v, re) => { const d = getComponent(type); assert.match(checkParams(d, fillParams(d, v)).join('；'), re, `${type} ${JSON.stringify(v)}`) }
  bad('sat.array.phased', { tiles: 4, shape: 'hex' }, /分块仅适用于矩形/)
  bad('sat.array.phased', { tiles: 5, tileRows: 2 }, /整数倍/)
  bad('sat.antenna.lpda', { fLowGHz: 0.4, fHighGHz: 0.2 }, /最高频率须大于最低频率/)
  bad('sat.antenna.helix', { layout: 'dual', innerRM: 0.5, outerRM: 0.3 }, /外环半径须大于内环半径/)
  bad('sat.instrument', { windowWM: 2 }, /观测窗大于所在面/)
  bad('sat.camera', { lengthM: 0.2 }, /总长过短/)
})

// ───────────────────────── ② 相控阵旧版兼容 ─────────────────────────

t('相控阵：矩形 + 白色罩面 + 白边框 = 旧实现逐位相同（逐块无底面白盒、单节点 array、每块一个面板质量元）', () => {
  for (const tiles of [1, 2, 4]) {
    const p = { wM: 1.37, hM: 0.83, tM: 0.012, tiles, gapM: 0.031, standoffM: 0.01, shape: 'rect', face: 'radome', faceMat: 'white_paint', frameMat: 'white_paint' }
    const c = buildComponent('sat.array.phased', p)
    // 旧实现（2026-10-07 版 sat.mjs arrayPhased.build）
    const nx = tiles >= 4 ? 2 : 1, ny = tiles >= 2 ? 2 : 1
    const tw = (p.wM - p.gapM * (nx - 1)) / nx, th = (p.hM - p.gapM * (ny - 1)) / ny
    const am = new MB()
    let area = 0
    for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
      box(am, [-p.wM / 2 + tw / 2 + ix * (tw + p.gapM), -p.hM / 2 + th / 2 + iy * (th + p.gapM), p.standoffM + p.tM / 2], [tw / 2, th / 2, p.tM / 2], ['+x', '-x', '+y', '-y', '+z'])
      area += tw * th
    }
    assert.equal(c.ir.meshes.length, 1, `分块 ${tiles}：只有一个网格`)
    assert.deepEqual(Array.from(c.ir.meshes[0].position), Array.from(Float32Array.from(am.p)), `分块 ${tiles}：顶点`)
    assert.deepEqual(Array.from(c.ir.meshes[0].index), am.idx, `分块 ${tiles}：三角形`)
    assert.equal(c.ir.materials[0].key, 'white_paint')
    near(c.massKg, DENSITY.arrayAreal.value * area, 1e-12, `分块 ${tiles}：质量`)
  }
})

// ───────────────────────── ③ 指向机构运动学 ─────────────────────────

const colR = (m) => [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]]          // 节点矩阵 → 三根轴（列向量）
const app = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2], R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2], R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]]
const appT = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]]
const rx = (a, v) => { const c = Math.cos(a * D2R), s = Math.sin(a * D2R); return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]] }
const ry = (a, v) => { const c = Math.cos(a * D2R), s = Math.sin(a * D2R); return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]] }
const rz = (a, v) => { const c = Math.cos(a * D2R), s = Math.sin(a * D2R); return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]] }
const pdir = (az, th) => [Math.sin(th * D2R) * Math.cos(az * D2R), Math.sin(th * D2R) * Math.sin(az * D2R), Math.cos(th * D2R)]

t('双轴指向天线（方位-俯仰）：挂点视轴 = 设定指向；关节增量 (Δφ, Δθ) 叠在节点系上 = 指向 (φ+Δφ, θ+Δθ)', () => {
  for (const [az, th] of [[0, 0], [30, 40], [-120, 75], [90, 10]]) {
    const c = buildComponent('sat.antenna.gimbal', { azDeg: az, tiltDeg: th })
    const ap = c.attachPoints.find((a) => a.name === 'boresight')
    nearV(ap.dirBody, pdir(az, th), 1e-12, `视轴 ${az}/${th}`)
    const g = c.articulations.find((a) => a.name === 'gimbal')
    assert.deepEqual(g.stages.map((s) => [s.name, s.type, s.initialValue]), [['azimuth', 'zRotate', 0], ['elevation', 'xRotate', 0]])
    const node = c.ir.nodes.find((nd) => nd.name === g.nodes[0])
    const R = colR(node.matrix), b0 = appT(R, ap.dirBody)
    for (const [da, de] of [[15, -10], [-40, 20], [100, 5]]) {
      const w = app(R, rz(da, rx(de, b0)))
      nearV(w, pdir(az + da, th + de), 1e-9, `增量 ${da}/${de}`)
    }
    // 转台只随方位转：同一节点系
    const tu = c.articulations.find((a) => a.name === 'azimuth')
    assert.deepEqual(colR(c.ir.nodes.find((nd) => nd.name === tu.nodes[0]).matrix), R)
  }
})

t('双轴指向天线（X-Y）：挂点视轴 = 设定指向；X / Y 增量 = Rx(a1+Δ1)·Ry(a2+Δ2)·ẑ；平移级恒为 ±d、静止位姿不动', () => {
  for (const [az, th] of [[30, 40], [180, 25], [-60, 70]]) {
    const c = buildComponent('sat.antenna.gimbal', { gimbal: 'xy', azDeg: az, tiltDeg: th })
    const b = pdir(az, th)
    const ap = c.attachPoints.find((a) => a.name === 'boresight')
    nearV(ap.dirBody, b, 1e-12, `视轴 ${az}/${th}`)
    const a1 = Math.atan2(-b[1], b[2]) / D2R, a2 = Math.asin(b[0]) / D2R
    const g = c.articulations.find((a) => a.name === 'gimbal')
    assert.deepEqual(g.stages.map((s) => s.type), ['xRotate', 'zTranslate', 'yRotate', 'zTranslate'])
    assert.equal(g.stages[1].minimumValue, g.stages[1].maximumValue); assert.equal(g.stages[1].initialValue, -g.stages[3].initialValue)
    const R = colR(c.ir.nodes.find((nd) => nd.name === g.nodes[0]).matrix), b0 = appT(R, b)
    for (const [d1, d2] of [[10, -5], [-30, 20]]) nearV(app(R, rx(d1, ry(d2, b0))), rx(a1 + d1, ry(a2 + d2, [0, 0, 1])), 1e-9, `增量 ${d1}/${d2}`)
  }
})

t('激光通信终端：镜筒式挂点视轴 = 设定指向（含电子箱抬高）；潜望式只有方位关节', () => {
  const c = buildComponent('sat.lct', { azDeg: 50, tiltDeg: 35 })
  nearV(c.attachPoints[0].dirBody, pdir(50, 35), 1e-12, '镜筒式视轴')
  assert.deepEqual(c.articulations.map((a) => a.name).sort(), ['lct_azimuth', 'lct_gimbal'])
  const p = buildComponent('sat.lct', { type: 'periscope', azDeg: 50, tiltDeg: 35 })
  nearV(p.attachPoints[0].dirBody, pdir(50, 35), 1e-12, '潜望式视轴')
  assert.deepEqual(p.articulations.map((a) => a.name), ['lct_azimuth'])
  assert.ok(c.bbox.min[2] >= -1e-9, '电子箱在安装面以上')
})

// ───────────────────────── ④ 对称面与几何一致 ─────────────────────────

/** 组件全部网格顶点（组件局部系）；镜像后逐点在集合里找（量化格 + 邻格） */
function symOk(type, params, plane) {
  const c = buildComponent(type, params)
  const pts = []
  for (const nd of c.ir.nodes) {
    if (nd.mesh === undefined) continue
    const m = nd.matrix, P = c.ir.meshes[nd.mesh].position
    for (let i = 0; i < P.length; i += 3) pts.push([m[0] * P[i] + m[4] * P[i + 1] + m[8] * P[i + 2] + m[12], m[1] * P[i] + m[5] * P[i + 1] + m[9] * P[i + 2] + m[13], m[2] * P[i] + m[6] * P[i + 1] + m[10] * P[i + 2] + m[14]])
  }
  const q = 2e-4, key = (x, y, z) => `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`
  const set = new Set(pts.map((p) => key(...p)))
  const ax = plane === 'yz' ? 0 : plane === 'xz' ? 1 : 2
  let miss = 0
  for (const p of pts) {
    const r = p.slice(); r[ax] = -r[ax]
    let hit = false
    for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) for (let dz = -1; dz <= 1 && !hit; dz++) if (set.has(key(r[0] + dx * q, r[1] + dy * q, r[2] + dz * q))) hit = true
    if (!hit) miss++
  }
  return miss / pts.length
}
t('声明的对称面与几何一致（顶点镜像后仍在顶点集合里）', () => {
  const cases = [['sat.array.phased', {}], ['sat.array.phased', { face: 'disc', shape: 'oct', lattice: 'tri' }], ['sat.array.phased', { face: 'horn', freqGHz: 12 }], ['sat.array.phased', { face: 'dipole', freqGHz: 1.6, tiles: 4 }],
    ['sat.feed.cluster', { rings: 3 }], ['sat.antenna.lpda', {}], ['sat.antenna.lpda', { crossed: false }], ['sat.antenna.shroud', {}], ['sat.antenna.slot', {}], ['sat.tank', { shape: 'capsule' }], ['sat.lra', {}],
    ['sat.camera', {}], ['sat.camera', { type: 'box' }], ['sat.instrument', {}], ['sat.instrument', { cooler: 'none' }], ['sat.antenna.gimbal', {}], ['sat.antenna.gimbal', { tiltDeg: 45 }], ['sat.antenna.gimbal', { gimbal: 'xy', tiltDeg: 40 }],
    ['sat.antenna.gimbal', { gimbal: 'fixed', azDeg: 90, tiltDeg: 30 }], ['sat.antenna.gimbal', { feed: 'cass', tiltDeg: 20 }], ['sat.lct', { tiltDeg: 30 }], ['sat.bus.trap', {}], ['sat.bus.flat', {}], ['sat.feed.horn', { kind: 'pyramid' }],
    ['sat.sensor.mag', {}], ['sat.lra', { layout: 'ring' }], ['sat.lra', { layout: 'ring', ringN: 35 }], ['sat.dock', {}], ['sat.dock', { type: 'probe' }], ['sat.bus.cyl', { drumCells: true, seg: 48 }],
    ['sat.ep.arm', {}], ['sat.ep.arm', { arm: 'one', thrusters: 1 }], ['sat.ep.arm', { arm: 'none' }], ['sat.ep.arm', { azDeg: 180, tiltDeg: 45 }], ['sat.ep.arm', { rootDeg: 120, elbowDeg: -30 }],
    ['sat.visor', {}], ['sat.visor', { frame: true, panels: 3, deployDeg: 140 }], ['sat.antenna.despun', {}], ['sat.antenna.despun', { kind: 'mech' }], ['sat.antenna.despun', { kind: 'mech', azDeg: 90, elevDeg: 15 }],
    ['sat.antenna.despun', { columns: 31 }], ['sat.wing.hinged', {}], ['sat.wing.hinged', { rows: 5, cols: 3, deployDeg: 40, bothFaces: true, cellType: 'si' }],
    ['sat.bus.prism', {}], ['sat.bus.prism', { sides: 3 }], ['sat.bus.prism', { sides: 5 }], ['sat.bus.cubesat', {}], ['sat.bus.cubesat', { xM: 0.2263, zM: 0.366 }],
    ['sat.bus.sphere', {}], ['sat.bus.sphere', { form: 'polyhedron' }], ['sat.bus.sphere', { form: 'polyhedron', lonSeg: 9 }], ['sat.bus.module', {}], ['sat.bus.module', { front: 'dome', aft: 'flat' }]]
  for (const [type, params] of cases) {
    const d = getComponent(type), p = fillParams(d, params)
    const planes = typeof d.symmetricPlanes === 'function' ? d.symmetricPlanes(p) : (d.symmetricPlanes || [])
    assert.ok(planes.length, `${type} ${JSON.stringify(params)} 应声明对称面`)
    for (const pl of planes) { const r = symOk(type, params, pl); assert.ok(r < 1e-3, `${type} ${JSON.stringify(params)} 关于 ${pl}：${(100 * r).toFixed(2)} % 顶点不对称`) }
  }
  // 不对称的情形不声明：偏转方向不在坐标面内的指向机构、行列交错的角反射器、三根撑杆的正馈
  for (const [type, params] of [['sat.antenna.gimbal', { azDeg: 30, tiltDeg: 40 }], ['sat.lra', { layout: 'grid' }], ['sat.antenna.gimbal', { struts: 3, tiltDeg: 10 }], ['sat.ep.arm', { azDeg: 40 }],
    ['sat.antenna.despun', { kind: 'mech', azDeg: 30 }]]) {
    const d = getComponent(type)
    assert.deepEqual(d.symmetricPlanes(fillParams(d, params)), [], `${type} ${JSON.stringify(params)}`)
  }
})

// ───────────────────────── ⑤ 馈源阵装焦点 ─────────────────────────

t('多波束馈源阵装到反射面焦点：口面接口对接，口面中心落在焦点、口面朝口径中心', () => {
  const rp = { diameterM: 2.6, feed: 'none' }
  const refl = getComponent('sat.reflector')
  const focus = refl.sockets(fillParams(refl, rp)).find((s) => s.id === 'focus')
  const cl = getComponent('sat.feed.cluster')
  assert.equal(mountFor(cl, {}, focus), 'aperture', '焦点插座用口面接口')
  const doc = { kind: 'assembly', schema: 1, domain: 'spacecraft', name: 't', comps: [
    { id: 'refl', type: 'sat.reflector', parent: null, params: rp },
    { id: 'cl', type: 'sat.feed.cluster', parent: 'refl', attach: { mode: 'socket', socket: 'focus', mount: 'aperture', roll: 0 }, params: { rings: 2 } }] }
  const poses = solvePose(doc)
  const M = poses.get('cl').m
  const ap = cl.sockets(fillParams(cl, { rings: 2 })).find((s) => s.id === 'aperture')
  const w = [0, 1, 2].map((k) => M[k] * ap.pos[0] + M[4 + k] * ap.pos[1] + M[8 + k] * ap.pos[2] + M[12 + k])
  const g = reflectorFrame(fillParams(refl, rp))
  nearV(w, g.F, 1e-9, '口面中心 = 焦点')
  const nW = [0, 1, 2].map((k) => M[8 + k])   // 局部 +Z（口面朝向）
  const toPc = [g.Pc[0] - g.F[0], g.Pc[1] - g.F[1], g.Pc[2] - g.F[2]], l = Math.hypot(...toPc)
  assert.ok((nW[0] * toPc[0] + nW[1] * toPc[1] + nW[2] * toPc[2]) / l > 0.999, '口面朝反射面口径中心')
  const r = buildAssembly(doc)
  assert.ok(r.attachPoints.some((a) => a.name === 'cl_boresight') && r.attachPoints.some((a) => a.name === 'refl_focus'))
})

// ───────────────────────── ⑥ 组件库 ─────────────────────────

t('组件库：按功能分组排（结构与机构 → 电源 → 天线 → 有效载荷 → 推进 → 姿轨控 → 热控 → 通用），天线组按组件族分小组，别名可搜，枚举显示名取 optionLabels', () => {
  const g = L.libGroups('spacecraft')
  assert.deepEqual(g.map((x) => x.label), ['结构与机构', '电源', '天线', '有效载荷', '推进', '姿轨控', '热控', '通用'])
  assert.deepEqual(g.find((x) => x.key === 'antenna').subs.map((s) => s.label), ['反射面天线', '阵列天线', '喇叭与馈源', '线天线', '天线座', '天线罩'])
  for (const x of g) if (x.subs) assert.equal(x.subs.reduce((k, s) => k + s.items.length, 0), x.items.length, x.key)
  assert.ok(!g.find((x) => x.key === 'common').subs, '通用组没有小组')
  const hit = (q) => L.libGroups('spacecraft', q).flatMap((x) => x.items.map((d) => d.type))
  assert.ok(hit('QHA').includes('sat.antenna.omni'))
  assert.ok(hit('LCT').includes('sat.lct'))
  assert.ok(hit('圣诞树').includes('sat.antenna.lpda'))
  assert.ok(hit('SAR').includes('sat.array.phased'))
  assert.ok(hit('全向').includes('sat.antenna.omni') && hit('全向').includes('sat.antenna.ttc'))
  assert.ok(hit('贮箱').includes('sat.tank'))
  const arr = getComponent('sat.array.phased')
  const rows = L.paramRows(arr, {})
  assert.deepEqual(rows.find((r) => r.key === 'face').options.map((o) => o.label), ['方形贴片', '圆形贴片', '喇叭单元', '交叉偶极子', '天线罩（白）', '锗膜遮阳罩'])
  assert.equal(L.enumLabel('style', 'terraced', getComponent('sat.feed.horn').params.style), '台阶锥')
  assert.equal(L.enumLabel('style', 'kingpost'), '锥形立柱', '老表照旧')
  assert.equal(L.materialLabel('radome'), '天线罩')
})

// ───────────────────────── ⑦ 掩模自遮挡 ─────────────────────────

t('掩模自遮挡：<前缀>_boresight 排除本组件全部部件（含派生件前缀），反射面焦点旧口径不变，非天线挂点不排除', () => {
  const parts = [{ id: 'gimbal_antenna', nodes: ['gimbal_base', 'gimbal_turret', 'gimbal_payload'] }, { id: 'gimbal2_antenna', nodes: ['gimbal2_base'] },
    { id: 'gimbal-1_antenna', nodes: ['gimbal-1_base'] }, { id: 'bus_bus', nodes: ['bus_bus'] }, { id: 'refl1_reflector', nodes: ['refl1_reflector'] }, { id: 'sup1_boom', nodes: ['sup1_boom'] }]
  assert.deepEqual(ownAntennaNodes(parts, 'gimbal_boresight'), ['gimbal_base', 'gimbal_turret', 'gimbal_payload'])
  assert.deepEqual(ownAntennaNodes(parts, 'gimbal-1_boresight'), ['gimbal-1_base'])
  assert.deepEqual(ownAntennaNodes(parts, 'refl1_focus'), ['refl1_reflector', 'sup1_boom'])
  assert.deepEqual(ownAntennaNodes(parts, 'nadir_center'), [])
  assert.deepEqual(ownAntennaNodes(parts, 'reflector_1_focus'), [])
})

// ───────────────────────── ⑧ 质量式 ─────────────────────────

t('质量式：贮箱 = 壳 + 推进剂、激光终端 ∝ 口径²、光学相机 ∝ 入瞳面积、螺旋阵 = 阵元 × 个数 + 底板', () => {
  const R = 0.3, V = (4 / 3) * Math.PI * R ** 3, A = 4 * Math.PI * R * R
  near(buildComponent('sat.tank', {}).massKg, DENSITY.tankAreal.value * A + PROPELLANT_DENSITY.n2h4 * V * 0.8, 1e-9, '球形肼贮箱')
  near(buildComponent('sat.tank', { propellant: 'none' }).massKg, DENSITY.tankAreal.value * A, 1e-9, '空箱')
  near(buildComponent('sat.lct', { apertureM: 0.16 }).massKg, 4 * DENSITY.lctMass.value, 1e-9, '激光终端')
  near(buildComponent('sat.camera', { apertureM: 0.5 }).massKg, DENSITY.opticsAreal.value * Math.PI * 0.25 / 4, 1e-9, '光学相机')
  const h = buildComponent('sat.antenna.helix', { layout: 'ring', nInner: 6 })
  assert.ok(h.massKg > 6 * DENSITY.helixMass.value, '螺旋阵含底板')
  near(buildComponent('sat.sensor.mag', { scale: 2 }).massKg, 8 * DENSITY.magMass.value, 1e-12, '磁强计按尺寸立方')
})

t('圆柱星体太阳鼓：侧面电池带单独构成太阳翼组（效率随参数）；对接与分离机构三型都有安装接口、探杆 / 靶标有端部挂点', () => {
  const c = buildComponent('sat.bus.cyl', { drumCells: true, efficiency: 17 })
  const r = buildAssembly({ kind: 'assembly', schema: 1, domain: 'spacecraft', name: 't', comps: [{ id: 'bus', type: 'sat.bus.cyl', parent: null, params: { drumCells: true, efficiency: 17 } }] })
  assert.deepEqual(r.solarPanelGroups.map((g) => [g.name, g.nodes, g.efficiency]), [['bus_cells', ['bus_bus_cells'], 17]])
  assert.ok(c.ir.nodes.some((nd) => nd.name === 'bus_cells'))
  for (const ty of ['lvring', 'probe', 'grapple']) {
    const d = buildComponent('sat.dock', { type: ty })
    assert.ok(d.sockets.some((s) => s.id === 'root') && d.massKg > 0, ty)
    assert.equal(d.attachPoints.some((a) => a.name === 'tip'), ty !== 'lvring', ty)
  }
  assert.ok(L.libGroups('spacecraft', '对接环').flatMap((x) => x.items.map((d) => d.type)).includes('sat.dock'))
})

t('质量式：电推臂 = 关节 × epJointMass + 臂杆 boomLinear + 推力器 × epMass；遮阳板 = visorAreal × 板面积；消旋天线 = 阵面 / 反射面 + BAPTA', () => {
  const D = (k) => DENSITY[k].value
  near(buildComponent('sat.ep.arm', {}).massKg, 4 * D('epJointMass') + 2.1 * D('boomLinear') + 2 * D('epMass'), 1e-9, '两节臂双推力器')
  near(buildComponent('sat.ep.arm', { arm: 'one', thrusters: 1 }).massKg, 3 * D('epJointMass') + 1.1 * D('boomLinear') + D('epMass'), 1e-9, '单节臂')
  near(buildComponent('sat.ep.arm', { arm: 'none' }).massKg, 2 * D('epJointMass') + 2 * D('epMass'), 1e-9, '无臂')
  const v = buildComponent('sat.visor', { panels: 1, widthM: 1, depthM: 0.5, thicknessM: 0.02 })
  const rp = 0.5 * 0.02 + 0.004
  near(v.massKg, D('visorAreal') * (0.5 - 1.8 * rp) * 1, 1e-9, '遮阳板')
  const e = buildComponent('sat.antenna.despun', { discDM: 0, mastHM: 0 })
  near(e.massKg, D('arrayAreal') * 2 * Math.PI * 0.65 * 0.5, 1e-9, '电子消旋阵')
  const m = buildComponent('sat.antenna.despun', { kind: 'mech', diameterM: 1.8 })
  const dB = Math.max(0.25, 0.22 * 1.8), mastH = 0.55 * 1.8 + 0.1
  near(m.massKg, D('baptaMass') + D('boomLinear') * mastH + D('reflectorAreal') * Math.PI * 0.81, 1e-9, '机械消旋')
  assert.ok(dB > 0)
})

// ───────────────────────── ⑨ 常用型号 ─────────────────────────

t('常用型号：补缺省后合法、组件库一型一卡（键 type#id）、可搜、悬停带所属组件、按型号参数拖入；体装电池片归电源小组；坏型号登记即抛错', () => {
  let n = 0
  for (const d of listComponents('spacecraft')) {
    const ids = new Set()
    for (const p of d.presets || []) {
      assert.ok(!ids.has(p.id), `${d.type} 型号 ${p.id} 重复`); ids.add(p.id)
      assert.deepEqual(checkParams(d, fillParams(d, p.params)), [], `${d.type}#${p.id}`)
      assert.ok(p.titleZh && p.title && p.titleZh !== d.titleZh, `${d.type}#${p.id} 名称`)
      assert.equal(getPreset(d.type, p.id), p)
      n++
    }
  }
  assert.ok(n >= 50, `型号数 ${n}`)
  const lib = L.libGroups('spacecraft')
  const sat = { items: lib.flatMap((x) => x.items) }
  const keys = sat.items.map((e) => e.key)
  assert.equal(new Set(keys).size, keys.length, '卡片键不重复')
  const uhf = sat.items.find((e) => e.key === 'sat.antenna.helix#single-uhf')
  assert.ok(uhf && uhf.titleZh === 'UHF 螺旋天线' && uhf.params.layout === 'single' && uhf.params.freqGHz === 0.4)
  assert.equal(keys.indexOf('sat.antenna.helix#single-uhf'), keys.indexOf('sat.antenna.helix') + 1, '型号紧跟组件本身')
  const tip = L.compTip(uhf).split('\n')
  assert.ok(tip.includes('组件：螺旋天线')); assert.equal(tip[tip.length - 1], 'sat.antenna.helix · single-uhf')
  assert.equal(lib.find((x) => x.key === 'power').items.some((e) => e.key === 'sat.radiator#cells'), true, '体装电池片在电源组')
  const hit = (q) => L.libGroups('spacecraft', q).flatMap((x) => x.items.map((e) => e.key))
  assert.ok(hit('UHF').includes('sat.antenna.helix#single-uhf'))
  assert.ok(hit('四臂').includes('sat.antenna.omni#qha') && hit('四臂').includes('sat.antenna.omni#qha-bare'))
  assert.ok(hit('螺旋天线').includes('sat.antenna.helix#grid'), '搜组件名列出它的全部型号')
  assert.ok(hit('VisorSat').includes('sat.visor') && hit('电推').includes('sat.ep.arm#gimbal') && hit('消旋').includes('sat.antenna.despun#mech'))
  assert.deepEqual(L.libKeyParams('sat.antenna.helix#single-uhf'), { type: 'sat.antenna.helix', params: { layout: 'single', freqGHz: 0.4, turns: 10 } })
  assert.deepEqual(L.libKeyParams('sat.wing'), { type: 'sat.wing', params: {} })
  assert.deepEqual(L.libKeyParams('sat.wing#nope'), { type: 'sat.wing', params: {} })
  // 坏型号：登记时就抛错（抛在写注册表之前，注册表不受影响）
  const base = { type: 'zz.preset.bad', domain: ['ground'], role: 'other', params: { a: { kind: 'num', def: 1, min: 0, max: 2, label: 'a', source: 'illustrative' } }, build: (p, kit) => kit.createCtx() }
  assert.throws(() => registerComponent({ ...base, presets: [{ id: 'x', titleZh: '甲', title: 'A', params: { b: 1 } }] }), /参数 b 不在组件定义里/)
  assert.throws(() => registerComponent({ ...base, presets: [{ id: 'x', titleZh: '甲', title: 'A', params: { a: 5 } }] }), /须 ≤ 2/)
  assert.throws(() => registerComponent({ ...base, presets: [{ id: 'x', titleZh: '甲', title: 'A', params: {} }, { id: 'x', titleZh: '乙', title: 'B', params: {} }] }), /重复/)
  assert.throws(() => registerComponent({ ...base, presets: [{ id: 'Bad Id', titleZh: '甲', title: 'A', params: {} }] }), /id 非法/)
  assert.equal(getComponent('zz.preset.bad'), null)
})

// ───────────────────────── ⑩ 新件运动学 ─────────────────────────

/** 节点系里的点 / 方向过一串 stage（右乘，最后一级先作用）再进组件局部系 */
function chainApply(node, stages, vals, v, isDir) {
  let q = v.slice()
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i], x = Object.hasOwn(vals, s.name) ? vals[s.name] : s.initialValue
    if (s.type === 'xRotate') q = rx(x, q)
    else if (s.type === 'yRotate') q = ry(x, q)
    else if (s.type === 'zRotate') q = rz(x, q)
    else if (!isDir) { const k = { xTranslate: 0, yTranslate: 1, zTranslate: 2 }[s.type]; q[k] += x }
  }
  const R = colR(node.matrix), w = app(R, q)
  return isDir ? w : [w[0] + node.matrix[12], w[1] + node.matrix[13], w[2] + node.matrix[14]]
}
const elevDir = (deg) => [Math.cos(deg * D2R), 0, Math.sin(deg * D2R)]

t('电推力器指向臂：静止恒等；展开 / 肘部增量 = 仰角减增量；末端两轴 = 绕指向系两轴转喷流；转动中心随臂走', () => {
  for (const pr of [{}, { rootDeg: 70, elbowDeg: 10, azDeg: 0, tiltDeg: 45 }, { azDeg: 35, tiltDeg: 20 }, { arm: 'one' }, { arm: 'none', tiltDeg: 15 }]) {
    const c = buildComponent('sat.ep.arm', pr), p = fillParams(getComponent('sat.ep.arm'), pr)
    const segs = p.arm === 'two' ? 2 : p.arm === 'one' ? 1 : 0
    const arts = Object.fromEntries(c.articulations.map((a) => [a.name, a]))
    assert.deepEqual(Object.keys(arts).sort(), (segs === 2 ? ['deploy', 'elbow', 'pointing'] : segs === 1 ? ['deploy', 'pointing'] : ['pointing']).sort())
    const pt = arts.pointing, node = c.ir.nodes.find((nd) => nd.name === pt.nodes[0])
    const R = colR(node.matrix), t0 = [node.matrix[12], node.matrix[13], node.matrix[14]]
    const toNode = (w, dir) => appT(R, dir ? w : [w[0] - t0[0], w[1] - t0[1], w[2] - t0[2]])
    // 指向系与转动中心（局部）：按参数现算
    const b = pdir(p.azDeg, p.tiltDeg), ax = [-Math.sin(p.azDeg * D2R), Math.cos(p.azDeg * D2R), 0]
    const h0 = Math.max(0.05, 1.5 * Math.max(0.03, 0.75 * p.armDM))
    const T = segs === 0 ? [0, 0, Math.max(0.12, 1.6 * 1.5 * p.thrusterDM)] : [0, 1, 2].map((k) => [0, 0, h0][k] + p.seg1M * elevDir(p.rootDeg)[k] + (segs === 2 ? p.seg2M * elevDir(p.elbowDeg)[k] : 0))
    // 静止：恒等
    nearV(chainApply(node, pt.stages, {}, toNode(b, true), true), b, 1e-9, '静止喷流')
    nearV(chainApply(node, pt.stages, {}, toNode(T, false), false), T, 1e-9, '静止转动中心')
    // 末端两轴：绕 ax（第一轴）转 Δ1 → 喷流绕 ax 转
    const rotAbout = (k, deg, v) => { const c0 = Math.cos(deg * D2R), s0 = Math.sin(deg * D2R), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], x = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]]; return [0, 1, 2].map((i) => v[i] * c0 + x[i] * s0 + k[i] * d * (1 - c0)) }
    nearV(chainApply(node, pt.stages, { pointX: 12 }, toNode(b, true), true), rotAbout(ax, 12, b), 1e-9, '第一轴')
    const ay = [b[1] * ax[2] - b[2] * ax[1], b[2] * ax[0] - b[0] * ax[2], b[0] * ax[1] - b[1] * ax[0]]
    nearV(chainApply(node, pt.stages, { pointY: -9 }, toNode(b, true), true), rotAbout(ay, -9, b), 1e-9, '第二轴')
    nearV(chainApply(node, pt.stages, { pointX: 20, pointY: 10 }, toNode(T, false), false), T, 1e-9, '两轴转动不挪转动中心')
    if (segs >= 1) {
      // 展开增量 Δ：第一节仰角 − Δ（整臂绕局部 Y 过根部铰链轴转）；肘部增量 ε：第二节再 − ε
      const d = 15, e = segs === 2 ? -25 : 0
      const T2 = [0, 1, 2].map((k) => [0, 0, h0][k] + p.seg1M * elevDir(p.rootDeg - d)[k] + (segs === 2 ? p.seg2M * elevDir(p.elbowDeg - d - e)[k] : 0))
      nearV(chainApply(node, pt.stages, { deploy: d, ...(segs === 2 ? { elbow: e } : {}) }, toNode(T, false), false), T2, 1e-9, '转动中心随臂')
      nearV(chainApply(node, pt.stages, { deploy: d, ...(segs === 2 ? { elbow: e } : {}) }, toNode(b, true), true), ry(d + e, b), 1e-9, '喷流随臂转')
      const s1 = arts.deploy, n1 = c.ir.nodes.find((nd) => nd.name === s1.nodes[0])
      assert.deepEqual(colR(n1.matrix), R, '各节共用节点系')
      if (segs === 2) {
        const el = arts.elbow, E = [0, 1, 2].map((k) => [0, 0, h0][k] + p.seg1M * elevDir(p.rootDeg)[k])
        nearV(chainApply(node, el.stages, { deploy: 0, elbow: 30 }, toNode(E, false), false), E, 1e-9, '肘部转动不挪肘部铰链')
      }
    }
  }
})

t('遮阳板：静止恒等；展开铰链增量 Δ = 展开角减 Δ（板面外缘绕铰链轴转）', () => {
  for (const dep of [0, 70, 135]) {
    const c = buildComponent('sat.visor', { deployDeg: dep, depthM: 1 }), a = c.articulations[0]
    assert.equal(a.name, 'hinge'); assert.deepEqual(a.stages.map((s) => [s.type, s.minimumValue, s.maximumValue, s.initialValue]), [['yRotate', dep - 180, dep, 0]])
    const node = c.ir.nodes.find((nd) => nd.name === a.nodes[0])
    const H = [node.matrix[12], node.matrix[13], node.matrix[14]]
    const edge = (deg) => [0, 1, 2].map((k) => H[k] + elevDir(deg)[k])
    nearV(chainApply(node, a.stages, {}, [1, 0, 0], false), edge(dep), 1e-9, `静止外缘 ${dep}`)
    nearV(chainApply(node, a.stages, { deploy: 30 }, [1, 0, 0], false), edge(dep - 30), 1e-9, `收拢 30 ${dep}`)
  }
})

t('消旋天线：电子消旋挂点视轴 = 设定方位 / 仰角、无关节；机械消旋静止恒等、消旋 = 绕 Z、俯仰增量 = 仰角减增量（过桅杆顶俯仰轴）', () => {
  const e = buildComponent('sat.antenna.despun', { azDeg: 40, elevDeg: 5 })
  const hd = (az, el) => [Math.cos(el * D2R) * Math.cos(az * D2R), Math.cos(el * D2R) * Math.sin(az * D2R), Math.sin(el * D2R)]
  nearV(e.attachPoints[0].dirBody, hd(40, 5), 1e-12, '电子消旋视轴')
  assert.equal(e.articulations.length, 0)
  for (const [az, el] of [[0, 0], [30, 10], [-120, -20]]) {
    const c = buildComponent('sat.antenna.despun', { kind: 'mech', azDeg: az, elevDeg: el })
    const b = hd(az, el)
    nearV(c.attachPoints[0].dirBody, b, 1e-12, `视轴 ${az}/${el}`)
    const a = c.articulations.find((x) => x.name === 'elevation'), node = c.ir.nodes.find((nd) => nd.name === a.nodes[0])
    const R = colR(node.matrix), bN = appT(R, b)
    nearV(chainApply(node, a.stages, {}, bN, true), b, 1e-9, '静止')
    nearV(chainApply(node, a.stages, { despin: 25 }, bN, true), hd(az + 25, el), 1e-9, '消旋')
    nearV(chainApply(node, a.stages, { elevation: 10 }, bN, true), hd(az, el - 10), 1e-9, '俯仰')
    const zP = a.stages[1].initialValue
    nearV(chainApply(node, a.stages, { elevation: 10, despin: 40 }, appT(R, [0, 0, zP]), false), [0, 0, zP], 1e-9, '俯仰轴在桅杆顶')
  }
})

// ───────────────────────── ⑪ 太阳翼 ─────────────────────────

const WINGS = ['sat.wing', 'sat.wing.hinged', 'sat.wing.flex', 'sat.wing.rosa', 'sat.wing.circular']
/** 组件全部网格顶点（组件局部系） */
function vertsOf(c) {
  const pts = []
  for (const nd of c.ir.nodes) {
    if (nd.mesh === undefined) continue
    const m = nd.matrix, P = c.ir.meshes[nd.mesh].position
    for (let i = 0; i < P.length; i += 3) pts.push([m[0] * P[i] + m[4] * P[i + 1] + m[8] * P[i + 2] + m[12], m[1] * P[i] + m[5] * P[i + 1] + m[9] * P[i + 2] + m[13], m[2] * P[i] + m[6] * P[i + 1] + m[10] * P[i + 2] + m[14]])
  }
  return pts
}

t('太阳翼五种：单轴对日关节（绕翼展 / 铰链轴，pointingVector = 电池面法向）、太阳翼组含全部电池节点、电池面朝局部 −X（转角 0°）', () => {
  for (const ty of WINGS) {
    const c = buildComponent(ty, {})
    const a = c.articulations.find((x) => x.name === 'wing')
    assert.ok(a && a.stages.length === 1 && a.stages[0].type === 'yRotate', `${ty} 关节`)
    assert.deepEqual(a.pointingVector, [0, 0, 1], `${ty} pointingVector`)
    const node = c.ir.nodes.find((nd) => nd.name === a.nodes[0]), R = colR(node.matrix)
    nearV(R[2], [-1, 0, 0], 1e-12, `${ty} 电池面法向`)
    nearV(R[1], ty === 'sat.wing.hinged' ? [0, 1, 0] : [0, 0, 1], 1e-12, `${ty} 转轴`)
    const cellNodes = c.ir.nodes.filter((nd) => nd.mesh !== undefined && ['solar_cell', 'cell_si'].includes(c.ir.materials[c.ir.meshes[nd.mesh].material].key)).map((nd) => nd.name)
    assert.ok(cellNodes.length >= 1, `${ty} 有电池节点`)
    for (const nm of cellNodes) assert.ok(a.nodes.includes(nm), `${ty} 电池节点 ${nm} 在对日关节里`)
  }
  // 硅电池：材质键 cell_si + 白色汇流条
  const si = buildComponent('sat.wing.flex', { cellType: 'si' })
  assert.ok(si.ir.materials.some((m) => m.key === 'cell_si') && si.ir.materials.some((m) => m.key === 'white_paint'))
})

t('太阳翼镜像：钩子（绕翼轴转角取反）生成的几何 = 原几何关于局部 xz 面的真镜像；铰接式直接关于 xz 面对称', () => {
  const q = 2e-4, key = (p) => p.map((v) => Math.round(v / q)).join(',')
  const cases = [['sat.wing', { tiltDeg: 35, yoke: 'trap', cellType: 'si', hinges: true, frame: true }], ['sat.wing', { tiltDeg: -20, yoke: 'scissor', yokeLenM: 2, columns: 2, concentrator: true }],
    ['sat.wing.flex', { tiltDeg: 30 }], ['sat.wing.rosa', { tiltDeg: -45, yoke: 'trap' }], ['sat.wing.circular', { tiltDeg: 60, sweepDeg: 240, gores: 8 }]]
  for (const [ty, pr] of cases) {
    const d = getComponent(ty), p = fillParams(d, pr)
    const m = d.mirror(p, 'xz')
    assert.equal(m.tiltDeg, -p.tiltDeg, `${ty} 转角取反`)
    const A = vertsOf(buildComponent(ty, p)), B = new Set(vertsOf(buildComponent(ty, m)).map(key))
    let miss = 0
    for (const v of A) {
      const r = [v[0], -v[1], v[2]]
      let hit = false
      for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) for (let dz = -1; dz <= 1 && !hit; dz++) if (B.has(key([r[0] + dx * q, r[1] + dy * q, r[2] + dz * q]))) hit = true
      if (!hit) miss++
    }
    assert.ok(miss / A.length < 1e-3, `${ty} ${JSON.stringify(pr)}：${(100 * miss / A.length).toFixed(2)} % 顶点不是真镜像`)
  }
})

t('刚性太阳翼：新外形选项缺省 = 整星同式（逐位）；聚光板与侧板互斥、分列太窄报错；铰接式 / 柔性 / 卷展 / 圆形质量式', () => {
  const a = buildComponent('sat.wing', {}), b = buildComponent('sat.wing', { yoke: 'auto', columns: 1, cellType: 'gaas', bothFaces: false, frame: false, hinges: false, concentrator: false })
  assert.equal(a.ir.meshes.length, b.ir.meshes.length)
  a.ir.meshes.forEach((m, i) => assert.deepEqual(Array.from(m.position), Array.from(b.ir.meshes[i].position)))
  const w = getComponent('sat.wing')
  assert.match(checkParams(w, fillParams(w, { concentrator: true, sidePanels: 2 })).join('；'), /聚光板不能与侧板同时使用/)
  assert.match(checkParams(w, fillParams(w, { columns: 4, panelWM: 0.1 })).join('；'), /列太窄/)
  const D = (k) => DENSITY[k].value
  // 铰接式：(panelAreal + cellAreal) × 板面积
  const hp = { lengthM: 1.2, widthM: 0.6, rows: 2, cols: 1, gapM: 0.01, thicknessM: 0.02 }
  const rp = Math.max(0.003, Math.min(0.015, 0.9 * hp.thicknessM + 0.002)), segL = (hp.lengthM - 1.8 * rp - hp.gapM) / 2
  near(buildComponent('sat.wing.hinged', hp).massKg, (D('panelAreal') + D('cellAreal')) * 2 * segL * hp.widthM, 1e-9, '铰接式')
  // 柔性：帆 flexAreal × 2 × 单帆宽 × 帆长 + 伸展杆 + 两只箱（> 帆）；卷展：帆 + 两杆 + 卷筒
  const fx = buildComponent('sat.wing.flex', { yokeLenM: 0 })
  assert.ok(fx.massKg > D('flexAreal') * 2 * 2.5 * 13 + D('boomLinear') * 13 * 3.5, '柔性翼含帆与伸展杆')
  const rs = buildComponent('sat.wing.rosa', { yokeLenM: 0 })
  assert.ok(rs.massKg > D('flexAreal') * 2.4 * 8 + 2 * D('boomLinear') * 8.5, '卷展翼含帆与两杆')
  const ci = buildComponent('sat.wing.circular', { yokeLenM: 0 })
  const Rr = 3.7 / 2, area = 10 * 0.5 * Rr * Rr * Math.sin(2 * Math.PI / 10)
  assert.ok(ci.massKg > D('flexAreal') * area, '圆形翼含帆')
})

// ───────────────────────── ⑫ 星体 ─────────────────────────

t('星体四种：接口落在表面上（多面体按块面求交）、可贴面合法、质量式、立方星体装电池成组', () => {
  const D = (k) => DENSITY[k].value
  // 多棱柱：体密度 × 正多边形面积 × 高；奇数棱只关于 xz 对称
  const pr = getComponent('sat.bus.prism')
  for (const n of [3, 5, 8]) {
    const R = 1.1, A = 0.5 * n * R * R * Math.sin(2 * Math.PI / n)
    near(buildComponent('sat.bus.prism', { sides: n, mli: 'none' }).massKg, D('busVolume') * A * 2.0, 1e-6, `${n} 棱柱`)
    assert.deepEqual(pr.symmetricPlanes(fillParams(pr, { sides: n })), n % 2 ? ['xz'] : ['yz', 'xz'])
    const s = pr.sockets(fillParams(pr, { sides: n })).find((x) => x.id === 'side0')
    near(s.pos[0], R * Math.cos(Math.PI / n), 1e-12, '侧面接口在内切圆上')
  }
  // 立方星：每 1U 体积 1.33 kg；四个侧面体装电池成一个太阳翼组
  const cs = buildComponent('sat.bus.cubesat', {})
  near(buildComponent('sat.bus.cubesat', { skin: 'aluminum' }).massKg, D('cubesatMass') * 3, 1e-9, '3U 质量')
  assert.ok(cs.massKg > D('cubesatMass') * 3, '体装电池另计质量')
  const r3 = buildAssembly({ kind: 'assembly', schema: 1, domain: 'spacecraft', name: 't', comps: [{ id: 'bus', type: 'sat.bus.cubesat', parent: null, params: {} }] })
  assert.deepEqual(r3.solarPanelGroups.map((g) => g.name), ['bus_cells'])
  near(buildComponent('sat.bus.cubesat', { zM: 0.1135, skin: 'aluminum' }).massKg, D('cubesatMass'), 1e-9, '1U 质量')
  // 球 / 多面体：接口在表面上；多面体接口离球心介于内切与外接半径之间
  const sp = getComponent('sat.bus.sphere')
  for (const pv of [{}, { form: 'polyhedron' }, { form: 'polyhedron', lonSeg: 7, latSeg: 5 }]) {
    const p = fillParams(sp, pv)
    for (const s of sp.sockets(p)) {
      const r = Math.hypot(...s.pos)
      assert.ok(r <= 0.5 + 1e-9 && r > 0.5 * Math.cos(Math.PI / p.lonSeg) * Math.cos(Math.PI / p.latSeg) - 1e-9, `${JSON.stringify(pv)} 接口 ${s.id} 半径 ${r}`)
    }
  }
  near(buildComponent('sat.bus.sphere', {}).massKg, D('busVolume') * 4 / 3 * Math.PI * 0.125, 1e-9, '球体质量')
  assert.ok(buildComponent('sat.bus.sphere', { reflectors: 426 }).ir.materials.some((m) => m.key === 'glass'), '角反射器')
  // 舱段：密封舱密度 × (大柱段 + 锥台 + 小柱段)
  const g = { R1: 1.5, R2: 1.1, L1: 4, Lc: 0.6, L2: 1.5 }
  const V = Math.PI * g.R1 ** 2 * g.L1 + Math.PI * g.Lc / 3 * (g.R1 ** 2 + g.R1 * g.R2 + g.R2 ** 2) + Math.PI * g.R2 ** 2 * g.L2
  near(buildComponent('sat.bus.module', {}).massKg, D('moduleVolume') * V, 1e-6, '舱段质量')
  const md = getComponent('sat.bus.module'), mf = md.faces(fillParams(md, {}))
  assert.deepEqual(mf.map((f) => [f.id, f.kind]), [['large', 'cyl'], ['small', 'cyl'], ['-Z', 'plane']])
  assert.deepEqual(md.symmetricPlanes(fillParams(md, {})), ['yz'], '对接口三片导向瓣只关于 yz 对称')
  // 组件库：结构与机构组「主体结构」族里九种星体都在（含型号卡片）
  const st = L.libGroups('spacecraft').find((x) => x.key === 'structure').subs.find((s) => s.key === 'structure-body')
  for (const k of ['sat.bus.prism#tri', 'sat.bus.cubesat#6u', 'sat.bus.sphere#dfh1', 'sat.bus.sphere#lageos', 'sat.bus.module#core', 'sat.bus.box#small']) assert.ok(st.items.some((e) => e.key === k), k)
})

console.log(`modelSatComponents: ${n} 项通过`)
