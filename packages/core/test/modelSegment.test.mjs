// 部件分割自测（packages/core/models/segment.mjs）。运行：node packages/core/test/modelSegment.test.mjs
//
// 判据（任务书 §5.4）：
//   · 合成「盒 + 两翼（各 3 块板）+ 一个偏置抛物面（f=1.2 m，D=2.4 m，偏置 0.3 m）+ 焦点处馈源」：
//     ③ 识别出两翼，投影面积误差 < 1 %（一翼薄盒、一翼双面重合片，两种建模都要对）；
//     ④ 识别出反射面，焦距误差 < 0.5 %、口径误差 < 2 %；自动挂点取向按物理验证（焦点发出的射线经碟面反射后沿 dir 出射）；
//   · fitParaboloid / planarCluster / roleFromName / roleHint / connectedComponents 单项；
//   · 材质名提示的第二档残差门限；
//   · 单材质多节点装配：材质组每实例一票（少数派不接管整组）；§5.4 ① 按节点出部件（含祖先装配节点、整星命名的根节点不作数）；
//   · 部件面积按三角形去重（厚壳碟 areaM2 = 真实表面积，各部件面积之和 = 总面积）；
//   · 太阳翼组只从几何翼生成：名字给的太阳翼三角形落在翼包络里的并进翼，其余留作部件不出组；部件上反写 solarGroup / attachPoint，
//     经 schema.normalizeMeta 后仍在；triRange 在全局连续时给出；
//   · 50 万三角形分割 < 5 s；
//   · 6 个 NASA 夹具跑 autoSegment 不抛、三角形全划分、太阳翼组一一对应几何翼，打印部件数（数量不设硬判据）。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  roleFromName, roleHint, segmentByMaterial, connectedComponents, planarCluster, fitParaboloid, autoSegment,
} from '../models/segment.mjs'
import { weldByPosition } from '../models/massProps.mjs'

let pass = 0
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS  ' + name) } catch (e) { console.error('FAIL  ' + name + '\n      ' + (e && e.stack)); process.exitCode = 1 }
}
const relErr = (a, b) => Math.abs(a - b) / Math.abs(b)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] }
const dist = (a, b) => Math.hypot(...sub(a, b))

// ───────── 网格构造 ─────────

class MeshBuilder {
  constructor() { this.p = []; this.i = [] }
  v(x) { this.p.push(x[0], x[1], x[2]); return this.p.length / 3 - 1 }
  tri(a, b, c) { this.i.push(a, b, c) }
  /** 网格面：corner + s·U/nu + t·V/nv，法向 = U × V */
  grid(corner, U, V, nu = 1, nv = 1, flip = false) {
    const base = this.p.length / 3
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) this.v(add(corner, add(scl(U, i / nu), scl(V, j / nv))))
    const at = (i, j) => base + j * (nu + 1) + i
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1)
        if (flip) { this.tri(a, c, b); this.tri(a, d, c) } else { this.tri(a, b, c); this.tri(a, c, d) }
      }
    }
  }
  /** 长方体（外法向），每面 n×n 网格 */
  box(x0, y0, z0, x1, y1, z1, n = 1) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0
    this.grid([x1, y0, z0], [0, dy, 0], [0, 0, dz], n, n)
    this.grid([x0, y0, z0], [0, 0, dz], [0, dy, 0], n, n)
    this.grid([x0, y1, z0], [0, 0, dz], [dx, 0, 0], n, n)
    this.grid([x0, y0, z0], [dx, 0, 0], [0, 0, dz], n, n)
    this.grid([x0, y0, z1], [dx, 0, 0], [0, dy, 0], n, n)
    this.grid([x0, y0, z0], [0, dy, 0], [dx, 0, 0], n, n)
  }
  /**
   * 偏置抛物面碟：顶点 V、轴 k（单位）、e1 为偏置方向；口面圆心在 (h, 0)、直径 D。
   * ripple：在 w 上叠 A·cos(8φ)·(ρ/R)²，模拟伞状网面肋间下垂。
   */
  dish(V, k, e1, f, D, h, nr, ns, ripple = 0) {
    const e2 = cross(k, e1), R = D / 2
    const P = (rho, phi) => {
      const u = h + rho * Math.cos(phi), v = rho * Math.sin(phi)
      const w = (u * u + v * v) / (4 * f) + ripple * Math.cos(8 * phi) * (rho / R) ** 2
      return add(V, add(scl(e1, u), add(scl(e2, v), scl(k, w))))
    }
    const c = this.v(P(0, 0))
    const ring = []
    for (let r = 1; r <= nr; r++) {
      const row = []
      for (let s = 0; s < ns; s++) row.push(this.v(P((R * r) / nr, (2 * Math.PI * s) / ns)))
      ring.push(row)
    }
    for (let s = 0; s < ns; s++) this.tri(c, ring[0][s], ring[0][(s + 1) % ns])
    for (let r = 0; r < nr - 1; r++) {
      for (let s = 0; s < ns; s++) {
        const a = ring[r][s], b = ring[r + 1][s], cc = ring[r + 1][(s + 1) % ns], d = ring[r][(s + 1) % ns]
        this.tri(a, b, cc); this.tri(a, cc, d)
      }
    }
  }
  mesh(name, material) { return { name, position: Float32Array.from(this.p), index: Uint32Array.from(this.i), material } }
}

// 场景常量（米）
const F = 1.2, D = 2.4, CLEAR = 0.3, H = CLEAR + D / 2          // 偏置：轴线到口面下缘 0.3 m → 口面中心离轴 1.5 m
const K = norm([0.25, 0.1, 1])                                  // 反射面轴向（故意不沿坐标轴）
const E1 = norm(sub([1, 0, 0], scl(K, K[0])))                    // 偏置朝 +x 一侧
const VERT = [1.2, 0.0, -1.8]
const ROOT = [10, 20, 30]                                       // 根节点平移：检验节点世界矩阵
const PANEL_Y = 2.2, PANEL_Z = 1.8, PANEL_T = 0.025, GAP = 0.1
const WING_AREA = 3 * PANEL_Y * PANEL_Z

/**
 * 合成卫星。opts.dense：加密到约 50 万三角形（性能测）；opts.ripple：碟面扇贝；opts.names：材质名
 */
function buildSat(opts = {}) {
  const dense = !!opts.dense
  const bus = new MeshBuilder(); bus.box(-1, -1, -1.2, 1, 1, 1.2, dense ? 100 : 1)
  const yokes = new MeshBuilder()
  yokes.box(-0.04, 1.0, -0.04, 0.04, 2.0, 0.04); yokes.box(-0.04, -2.0, -0.04, 0.04, -1.0, 0.04)
  // 翼 A（+y）：三块薄盒
  const wa = new MeshBuilder()
  for (let p = 0; p < 3; p++) {
    const y0 = 2.0 + p * (PANEL_Y + GAP)
    wa.box(-PANEL_T / 2, y0, -PANEL_Z / 2, PANEL_T / 2, y0 + PANEL_Y, PANEL_Z / 2)
  }
  // 翼 B（−y）：三块双面重合片（正反绕向各一层），在局部系里建、由节点矩阵摆到 −y
  const wb = new MeshBuilder()
  const nq = dense ? 60 : 3
  for (let p = 0; p < 3; p++) {
    const y0 = 2.0 + p * (PANEL_Y + GAP)
    wb.grid([0, y0, -PANEL_Z / 2], [0, PANEL_Y, 0], [0, 0, PANEL_Z], nq, nq, false)
    wb.grid([0, y0, -PANEL_Z / 2], [0, PANEL_Y, 0], [0, 0, PANEL_Z], nq, nq, true)
  }
  const dish = new MeshBuilder()
  dish.dish(VERT, K, E1, F, D, H, dense ? 220 : 24, dense ? 800 : 96, opts.ripple || 0)
  const feed = new MeshBuilder()
  const Fo = add(VERT, scl(K, F))
  feed.box(Fo[0] - 0.06, Fo[1] - 0.06, Fo[2] - 0.06, Fo[0] + 0.06, Fo[1] + 0.06, Fo[2] + 0.06)
  const names = opts.names || ['m0', 'm1', 'm2', 'm3', 'm4']
  return {
    materials: names.map((name) => ({ name })),
    meshes: [bus.mesh('bus', 0), yokes.mesh('yokes', 1), wa.mesh('wingA', 2), wb.mesh('wingB', 2), dish.mesh('dish', 3), feed.mesh('feed', 4)],
    nodes: [
      { name: 'Sat', parent: -1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...ROOT, 1] },
      { name: 'Bus', parent: 0, mesh: 0 },
      { name: 'Yokes', parent: 0, mesh: 1 },
      { name: 'WingA', parent: 0, mesh: 2 },
      // 局部 +y 的翼经「绕 z 转 180°」（x→−x、y→−y，列主序）摆到 −y
      { name: 'WingB', parent: 0, mesh: 3, matrix: [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { name: 'Dish', parent: 0, mesh: 4 },
      { name: 'Feed', parent: 5, mesh: 5 },
    ],
  }
}
const W = (p) => add(p, ROOT)
const totalTris = (ir) => ir.meshes.reduce((s, m) => s + m.index.length / 3, 0)

/** 各部件三角形数之和 = 总数，且 nodes / triRanges 覆盖无重叠 */
function assertPartition(ir, r) {
  const T = totalTris(ir)
  assert.equal(r.parts.reduce((s, p) => s + p.tris, 0), T, '部件三角形之和 ≠ 总数')
  const seen = new Map()
  const nodeTris = new Map(ir.nodes.filter((n) => n.mesh != null).map((n) => [n.name, ir.meshes[n.mesh].index.length / 3]))
  for (const p of r.parts) {
    let n = 0
    for (const nm of p.nodes) n += nodeTris.get(nm)
    for (const tr of p.triRanges) for (const [s, c] of tr.ranges) {
      n += c
      for (let t = s; t < s + c; t++) {
        const key = tr.node + '#' + t
        assert.ok(!seen.has(key), `三角形 ${key} 被两个部件认领`)
        seen.set(key, p.id)
      }
    }
    assert.equal(n, p.tris, `${p.id} 的 nodes/triRanges 与 tris 不符`)
  }
}

// ───────── 名字关键词 ─────────

await ok('roleFromName：关键词、优先级、短词整词匹配、中文', () => {
  const cases = {
    SolarPanel_01: 'solarArray', 'NGTDRSS-SolarPanel22.002': 'solarArray', SOLARPANEL: 'solarArray', PV: 'solarArray', 'Parasol-Solar1': 'solarArray',
    'NGTDRSS-MainDish': 'reflector', Antenna: 'reflector', ant: 'reflector', ReflectorMesh: 'reflector',
    Feed_Horn: 'feed', horn: 'feed', FeedAssembly: 'feed',
    Thruster_Nozzle: 'thruster', OSR: 'radiator', Radiator_Panel: 'radiator',
    antenna_boom: 'boom', 'Goes2-main-MagBoom-sm': 'boom', Mast: 'boom', RobotArm: 'boom', solar_array_boom: 'boom',
    Master_Material: 'other', plant: 'other', quantum: 'other', hornet: 'other', '': 'other',
    太阳翼: 'solarArray', 馈源喇叭: 'feed', 反射面: 'reflector', 天线支架臂: 'boom', 推力器: 'thruster',
  }
  for (const [n, r] of Object.entries(cases)) assert.equal(roleFromName(n), r, n)
})

await ok('roleHint：敏感器先于太阳翼、radiation 先于 panel、泛称 array / panel 标弱提示、热控包覆不算反射面', () => {
  const cases = {
    太阳敏感器: 'sensor', SunSensor: 'sensor', Star_Tracker: 'sensor', StarTrackerBaffle: 'sensor', 星敏感器: 'sensor', 相机: 'sensor',
    'MODIS Thermal Radiation Panel': 'radiator', Cellular: 'other', SolarCells: 'solarArray', Reflective_Foil: 'other', reflectiveMLI: 'other',
    太阳电池阵: 'solarArray', 太阳能帆板: 'solarArray', Magnetometer_Boom: 'boom', Camera_Boom: 'boom',
  }
  for (const [n, r] of Object.entries(cases)) assert.equal(roleFromName(n), r, n)
  assert.deepEqual(roleHint('Side Panel 3'), { role: 'solarArray', weak: true })
  assert.deepEqual(roleHint('MainSidePanels'), { role: 'solarArray', weak: true })
  assert.deepEqual(roleHint('NGTDRSS-SolarPanel22.002'), { role: 'solarArray', weak: false })
  assert.deepEqual(roleHint('Bus'), { role: 'other', weak: false })
})

await ok('segmentByMaterial：按材质分组、角色、面积（按节点矩阵）', () => {
  const ir = buildSat({ names: ['MLI_Gold', 'Yoke_Boom', 'SolarCell', 'Dish_Reflector', 'Feed_Horn'] })
  const g = segmentByMaterial(ir)
  const by = Object.fromEntries(g.map((x) => [x.name, x]))
  assert.equal(by.SolarCell.role, 'solarArray'); assert.equal(by.Dish_Reflector.role, 'reflector')
  assert.equal(by.Feed_Horn.role, 'feed'); assert.equal(by.Yoke_Boom.role, 'boom'); assert.equal(by.MLI_Gold.role, 'other')
  assert.deepEqual(by.SolarCell.nodes.sort(), ['WingA', 'WingB'])
  // 总线盒 2×2×2.4
  assert.ok(relErr(by.MLI_Gold.areaM2, 2 * (4 + 4.8 + 4.8)) < 1e-6)
})

// 单材质 CAD 装配：节点各是一个零件，网格名 = 节点名 + '_mesh'（Blender 导出常态）。
// 根节点故意以整星命名且带 solar 字样，检验「大节点不按名字认」。
function buildAssembly() {
  const ir = { materials: [{ name: 'Default' }], meshes: [], nodes: [{ name: 'Solar Dynamics Observatory', parent: -1 }] }
  const put = (name, b, parent = 0) => {
    const m = new MeshBuilder(); m.box(...b)
    ir.meshes.push(m.mesh(name + '_mesh', 0))
    ir.nodes.push({ name, parent, mesh: ir.meshes.length - 1 })
  }
  put('Bus', [-1, -1, -1, 1, 1, 1])
  put('Thruster_1', [-0.1, -0.1, -1.3, 0.1, 0.1, -1.0])
  put('Thruster_2', [0.5, 0.5, -1.3, 0.7, 0.7, -1.0])
  put('Magnetometer_Boom', [1, -0.02, -0.02, 3, 0.02, 0.02])
  put('Star_Tracker', [-0.8, -0.8, 1, -0.6, -0.6, 1.2])
  put('Radiator_Panel_East', [-0.9, 1.0, -0.9, 0.9, 1.01, 0.9])
  // 装配节点（无网格）叫推进舱推力器组件，底下零件名 Body1 / Body2 认不出：按祖先归成一个推力器部件
  ir.nodes.push({ name: 'Propulsion_Thruster_Assy', parent: 0 })
  const assy = ir.nodes.length - 1
  put('Body1', [-0.6, 0.3, -1.25, -0.4, 0.5, -1.02], assy)
  put('Body2', [0.3, -0.6, -1.25, 0.5, -0.4, -1.02], assy)
  put('Widget', [0.6, -0.9, 1.0, 0.8, -0.7, 1.1])
  return ir
}

await ok('segmentByMaterial：单材质多节点装配，每实例一票，少数派角色（推力器 24/108 面）不得接管整组', () => {
  const ir = buildAssembly()
  const g = segmentByMaterial(ir)
  assert.equal(g.length, 1)
  assert.equal(g[0].role, 'other', `整组被标成 ${g[0].role}`)
  // 推力器真占多数（再把 Bus、Widget、Star_Tracker 改成 Thruster_*，60/108 面）时照常认
  const ir2 = buildAssembly()
  for (const n of ir2.nodes) if (['Bus', 'Widget', 'Star_Tracker'].includes(n.name)) n.name = 'Thruster_' + n.name
  for (const m of ir2.meshes) m.name = 'mesh'
  assert.equal(segmentByMaterial(ir2)[0].role, 'thruster')
})

// ───────── 连通分量 / 平面性 ─────────

await ok('connectedComponents：两块分离的盒 + 共点即连通', () => {
  const b = new MeshBuilder(); b.box(0, 0, 0, 1, 1, 1); b.box(3, 0, 0, 4, 1, 1)
  const m = b.mesh('x', 0)
  const w = weldByPosition(m.position, m.index)
  const cc = connectedComponents(w.index, w.vertexCount)
  assert.equal(cc.count, 2)
  assert.deepEqual(Array.from(cc.triCount), [12, 12])
  const b2 = new MeshBuilder(); b2.box(0, 0, 0, 1, 1, 1); b2.box(1, 0, 0, 2, 1, 1)   // 共面贴合、共用 4 个角点
  const m2 = b2.mesh('y', 0), w2 = weldByPosition(m2.position, m2.index)
  assert.equal(connectedComponents(w2.index, w2.vertexCount).count, 1)
})

await ok('planarCluster：薄盒 / 双面重合片 / 半数翻面单层片的投影面积都等于板面；臂杆不算平面', () => {
  const thin = new MeshBuilder(); thin.box(0, 0, 0, 2.2, 1.8, 0.025)
  const t = thin.mesh('t', 0)
  const a = planarCluster(t.position, t.index)
  assert.equal(a.planar, true); assert.ok(relErr(a.areaM2, 3.96) < 1e-6, `薄盒 ${a.areaM2}`)
  assert.ok(Math.abs(Math.abs(a.normal[2]) - 1) < 1e-9)
  const dbl = new MeshBuilder(); dbl.grid([0, 0, 0], [2.2, 0, 0], [0, 1.8, 0], 4, 4); dbl.grid([0, 0, 0], [2.2, 0, 0], [0, 1.8, 0], 4, 4, true)
  const d = dbl.mesh('d', 0)
  assert.ok(relErr(planarCluster(d.position, d.index).areaM2, 3.96) < 1e-6)
  // 单层片、棋盘式一半三角形翻面：正 = 背 = 一半，并集才是整块
  const mix = new MeshBuilder(); mix.grid([0, 0, 0], [2.2, 0, 0], [0, 1.8, 0], 6, 6)
  for (let q = 0; q < mix.i.length; q += 6) { const x = mix.i[q + 1]; mix.i[q + 1] = mix.i[q + 2]; mix.i[q + 2] = x }
  const mm = mix.mesh('m', 0)
  const pm = planarCluster(mm.position, mm.index)
  assert.ok(Math.abs(pm.frontM2 - pm.backM2) < 1e-6)
  assert.ok(relErr(pm.areaM2, 3.96) < 1e-6, `半数翻面 ${pm.areaM2}`)
  const boom = new MeshBuilder(); boom.box(0, 0, 0, 3, 0.03, 0.03)
  const bm = boom.mesh('b', 0)
  assert.equal(planarCluster(bm.position, bm.index).planar, false)
})

// ───────── 抛物面拟合 ─────────

function dishPoints(f, Dm, h, nr, ns, k = [0, 0, 1], e1 = [1, 0, 0], V = [0, 0, 0], noise = 0) {
  const b = new MeshBuilder(); b.dish(V, k, e1, f, Dm, h, nr, ns)
  let seed = 7
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5) * 2
  const p = Float64Array.from(b.p)
  if (noise) for (let q = 0; q < p.length; q++) p[q] += noise * rnd()
  return p
}

await ok('fitParaboloid：正馈、偏置、倾斜轴、带噪', () => {
  const on = fitParaboloid(dishPoints(0.9, 3.0, 0, 20, 180))
  assert.ok(relErr(on.focalM, 0.9) < 1e-5, `正馈 f ${on.focalM}`)
  assert.ok(relErr(on.diameterM, 3.0) < 1e-3, `正馈 D ${on.diameterM}`)
  assert.ok(on.offsetM < 1e-3 * 3)
  const k = norm([0.3, -0.4, 0.8]), e1 = norm(sub([1, 0, 0], scl(k, k[0])))
  const off = fitParaboloid(dishPoints(F, D, H, 24, 180, k, e1, [5, -3, 2]))
  assert.ok(relErr(off.focalM, F) < 1e-5, `偏置 f ${off.focalM}`)
  assert.ok(relErr(off.diameterM, D) < 1e-3, `偏置 D ${off.diameterM}`)
  assert.ok(relErr(off.offsetM, H) < 1e-3, `偏置量 ${off.offsetM}`)
  assert.ok(dot(off.axis, k) > 1 - 1e-8, '轴向（顶点 → 焦点）')
  assert.ok(dist(off.vertex, [5, -3, 2]) < 1e-5 * D, '顶点')
  assert.ok(dist(off.focus, add([5, -3, 2], scl(k, F))) < 1e-5 * D, '焦点')
  assert.ok(off.rmsRel < 1e-6)
  // 带 ±0.1 % D 均匀噪声：焦距仍 < 0.5 %
  const noisy = fitParaboloid(dishPoints(F, D, H, 24, 180, k, e1, [0, 0, 0], 0.001 * D))
  assert.ok(relErr(noisy.focalM, F) < 0.005, `带噪 f ${noisy.focalM}`)
  assert.ok(noisy.rmsRel < 0.005)
})

await ok('fitParaboloid：半球（深球冠）残差大，平面没有有限焦距', () => {
  const pts = []
  for (let i = 1; i <= 12; i++) for (let j = 0; j < 48; j++) {
    const th = (i / 12) * (Math.PI / 2), ph = (2 * Math.PI * j) / 48
    pts.push(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), -Math.cos(th))
  }
  const h = fitParaboloid(pts.reduce((a, _, q) => (q % 3 ? a : (a.push([pts[q], pts[q + 1], pts[q + 2]]), a)), []))
  assert.ok(h === null || h.rmsRel > 0.005, `半球 rms ${h && h.rmsRel}`)
  const plane = []
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) plane.push(i * 0.1, j * 0.1, 0.3 * i * 0.1 - 0.2 * j * 0.1)
  const p = fitParaboloid(Float64Array.from(plane))
  assert.ok(p === null || p.fOverD > 10, `平面 ${p && p.fOverD}`)
})

// ───────── 合成卫星全流程 ─────────

await ok('autoSegment 合成卫星：③ 两翼面积 < 1 %；④ 反射面焦距 < 0.5 %、口径 < 2 %；馈源、本体、完整划分', () => {
  const ir = buildSat()
  const r = autoSegment(ir)
  assertPartition(ir, r)
  const solar = r.parts.filter((p) => p.role === 'solarArray')
  assert.equal(solar.length, 2, '两翼')
  solar.sort((a, b) => b.centroidBody[1] - a.centroidBody[1])
  for (const [p, ySign] of [[solar[0], 1], [solar[1], -1]]) {
    assert.ok(relErr(p.areaM2, WING_AREA) < 0.01, `${p.id} 面积 ${p.areaM2}（应 ${WING_AREA}）`)
    assert.ok(Math.abs(Math.abs(p.normalBody[0]) - 1) < 1e-6, `${p.id} 法向 ${p.normalBody}`)
    const yc = 2.0 + (3 * PANEL_Y + 2 * GAP) / 2
    assert.ok(Math.abs(p.centroidBody[1] - (ROOT[1] + ySign * yc)) < 0.05, `${p.id} 质心 ${p.centroidBody}`)
  }
  // 翼 A 整节点归翼；翼 B 同
  assert.deepEqual([...solar[0].nodes], ['WingA']); assert.deepEqual([...solar[1].nodes], ['WingB'])
  const refl = r.parts.filter((p) => p.role === 'reflector')
  assert.equal(refl.length, 1, '一面反射面')
  const f = refl[0].fitted
  assert.ok(relErr(f.focalM, F) < 0.005, `焦距 ${f.focalM}`)
  assert.ok(relErr(f.diameterM, D) < 0.02, `口径 ${f.diameterM}`)
  assert.ok(relErr(f.offsetM, H) < 0.02, `偏置 ${f.offsetM}`)
  assert.ok(dot(f.axisBody, K) > 1 - 1e-6)
  assert.ok(dist(f.vertexBody, W(VERT)) < 1e-3 * D)
  console.log(`      翼面积 ${solar.map((p) => p.areaM2.toFixed(4)).join(' / ')}（应 ${WING_AREA.toFixed(4)}）· f ${f.focalM.toFixed(5)} · D ${f.diameterM.toFixed(5)} · 偏置 ${f.offsetM.toFixed(5)} · rms ${(f.rmsRel * 100).toFixed(5)} %`)
  // 馈源、本体、太阳翼组
  const feed = r.parts.find((p) => p.role === 'feed')
  assert.ok(feed && feed.nodes.includes('Feed'), '焦点处的小盒识别为馈源')
  const bus = r.parts.find((p) => p.role === 'bus')
  assert.ok(bus && bus.nodes.includes('Bus'), '本体')
  assert.deepEqual(r.solarPanelGroups.map((g) => [g.name, g.efficiency]), [['SolarArray1', 28], ['SolarArray2', 28]])
})

await ok('自动挂点取向：pos=焦点；dir=顶点→焦点=波束视轴（焦点射线经碟面反射后沿 dir 出射）；up ⟂ dir 指向偏置侧', () => {
  const r = autoSegment(buildSat())
  assert.equal(r.attachPoints.length, 1)
  const ap = r.attachPoints[0]
  const Fw = W(add(VERT, scl(K, F)))
  assert.ok(dist(ap.posBody, Fw) < 1e-3 * D, `挂点位置 ${ap.posBody}`)
  assert.ok(dot(ap.dirBody, K) > 1 - 1e-6, 'dir = +轴向')
  assert.ok(Math.abs(dot(ap.upBody, ap.dirBody)) < 1e-9, 'up ⟂ dir')
  assert.ok(dot(ap.upBody, E1) > 0.999, 'up 指向偏置侧')
  // 几何光学：从焦点射向碟面上若干点的射线，按碟面法向镜面反射后都平行于 dir
  const e2 = cross(K, E1)
  for (const [u, v] of [[H, 0], [H + 1, 0.3], [H - 0.9, -0.6], [H + 0.2, 1.1]]) {
    const P = W(add(VERT, add(scl(E1, u), add(scl(e2, v), scl(K, (u * u + v * v) / (4 * F))))))
    const n = norm(sub(K, add(scl(E1, u / (2 * F)), scl(e2, v / (2 * F)))))   // 曲面 w = ρ²/4f 的法向
    const din = norm(sub(P, ap.posBody))
    const dout = sub(din, scl(n, 2 * dot(din, n)))
    assert.ok(dot(dout, ap.dirBody) > 1 - 1e-5, `(${u},${v}) 反射方向 ${dout}`)
  }
  // 馈源朝向反射面：从焦点指向口面中心的方向与 −dir 同侧（馈源「背对」波束出射方向）
  const C = W(add(VERT, add(scl(E1, H), scl(K, (H * H) / (4 * F)))))
  assert.ok(dot(sub(C, ap.posBody), ap.dirBody) < 0)
})

await ok('bodyMatrix：输出的 *Body 字段经模型系 → 本体系变换；均匀缩放同时换算长度与面积', () => {
  // 绕 x 转 90°（y→z、z→−y）再平移 (1,2,3)，列主序
  const M = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 1, 2, 3, 1]
  const a = autoSegment(buildSat()), b = autoSegment(buildSat(), { bodyMatrix: M })
  const xf = (p) => [p[0] + 1, -p[2] + 2, p[1] + 3], xd = (d) => [d[0], -d[2], d[1]]
  const ra = a.parts.find((p) => p.role === 'reflector'), rb = b.parts.find((p) => p.role === 'reflector')
  assert.ok(dist(rb.fitted.focusBody, xf(ra.fitted.focusBody)) < 1e-9)
  assert.ok(dist(rb.fitted.axisBody, xd(ra.fitted.axisBody)) < 1e-12)
  assert.ok(dist(b.attachPoints[0].upBody, xd(a.attachPoints[0].upBody)) < 1e-12)
  assert.ok(dist(rb.centroidBody, xf(ra.centroidBody)) < 1e-9)
  // 带均匀缩放（模型单位英尺 → 米）：长度乘 s、面积乘 s²，方向仍是单位向量
  const s = 0.3048, MS = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]
  const c = autoSegment(buildSat(), { bodyMatrix: MS })
  const rc = c.parts.find((p) => p.role === 'reflector')
  assert.ok(relErr(rc.fitted.focalM, F * s) < 1e-6 && relErr(rc.fitted.diameterM, D * s) < 1e-6)
  assert.ok(Math.abs(Math.hypot(...rc.fitted.axisBody) - 1) < 1e-12)
  for (const p of c.parts.filter((q) => q.role === 'solarArray')) assert.ok(relErr(p.areaM2, WING_AREA * s * s) < 0.01)
  assert.ok(dist(c.attachPoints[0].posBody, scl(W(add(VERT, scl(K, F))), s)) < 1e-6)
})

await ok('材质名第二档：扇贝形碟（rms 0.5 %–1.5 %）纯几何不认，材质名叫 Dish 才认', () => {
  // 节点名、网格名也算名字提示（叫 Dish 同样会认），纯几何这一例把它们也换成中性的
  const irPlain = buildSat({ ripple: 0.05 })
  irPlain.nodes.find((n) => n.name === 'Dish').name = 'n4'
  irPlain.meshes.find((m) => m.name === 'dish').name = 'mesh4'
  const plain = autoSegment(irPlain, { debug: true })
  const fit = plain.stats.debug.fits.filter((x) => x.D > 2).sort((a, b) => a.rmsRel - b.rmsRel)[0]
  assert.ok(fit && fit.rmsRel > 0.005 && fit.rmsRel < 0.015, `扇贝碟 rms ${fit && fit.rmsRel}`)
  assert.equal(plain.parts.filter((p) => p.role === 'reflector' && p.source === 'geometry').length, 0)
  const named = autoSegment(buildSat({ ripple: 0.05, names: ['m0', 'm1', 'm2', 'Main_Dish', 'm4'] }))
  const r = named.parts.filter((p) => p.role === 'reflector' && p.source === 'geometry')
  assert.equal(r.length, 1)
  // 扇贝面本身就不是抛物面（偏置口面上 cos 8φ 的起伏与 x²+y² 项不正交），焦距只要求量级对
  assert.ok(relErr(r[0].fitted.focalM, F) < 0.1, `扇贝碟 f ${r[0].fitted.focalM}`)
  console.log(`      扇贝碟 rms ${(fit.rmsRel * 100).toFixed(3)} %，材质提示后 f = ${r[0].fitted.focalM.toFixed(4)}`)
})

await ok('autoSegment ①：有节点树的按节点——共用材质的装配里认得出名字的节点各成部件（含祖先装配节点），整星命名的根节点不作数', () => {
  const ir = buildAssembly()
  const r = autoSegment(ir)
  assertPartition(ir, r)
  const by = new Map(r.parts.map((p) => [p.name, p]))
  const expect = { Thruster_1: 'thruster', Thruster_2: 'thruster', Magnetometer_Boom: 'boom', Star_Tracker: 'sensor', Radiator_Panel_East: 'radiator', Propulsion_Thruster_Assy: 'thruster' }
  for (const [n, role] of Object.entries(expect)) {
    const p = by.get(n)
    assert.ok(p, `缺部件 ${n}：${r.parts.map((q) => q.name).join(', ')}`)
    assert.equal(p.role, role, n)
    assert.equal(p.source, 'node', n)
  }
  assert.deepEqual([...by.get('Propulsion_Thruster_Assy').nodes].sort(), ['Body1', 'Body2'])
  assert.deepEqual(by.get('Thruster_1').nodes, ['Thruster_1'])
  assert.deepEqual(r.parts.find((p) => p.role === 'bus').nodes, ['Bus'])
  assert.deepEqual(r.parts.find((p) => p.role === 'other').nodes, ['Widget'])
  assert.equal(r.parts.filter((p) => p.role === 'solarArray').length, 0, '根节点名里的 Solar 不作数')
  assert.equal(r.solarPanelGroups.length, 0)
})

/** 厚壳正馈碟：前后两张抛物面（间距 t）+ 口沿，闭合 */
function thickDish(f, Dm, t, nr, ns) {
  const b = new MeshBuilder()
  const R = Dm / 2
  const P = (rho, phi, off) => [rho * Math.cos(phi), rho * Math.sin(phi), (rho * rho) / (4 * f) + off]
  const layer = (off, flip) => {
    const c = b.v(P(0, 0, off)), ring = []
    for (let r = 1; r <= nr; r++) { const row = []; for (let s = 0; s < ns; s++) row.push(b.v(P((R * r) / nr, (2 * Math.PI * s) / ns, off))); ring.push(row) }
    const tri = (x, y, z) => (flip ? b.tri(x, z, y) : b.tri(x, y, z))
    for (let s = 0; s < ns; s++) tri(c, ring[0][s], ring[0][(s + 1) % ns])
    for (let r = 0; r < nr - 1; r++) for (let s = 0; s < ns; s++) { const a = ring[r][s], q = ring[r + 1][s], c2 = ring[r + 1][(s + 1) % ns], d = ring[r][(s + 1) % ns]; tri(a, q, c2); tri(a, c2, d) }
    return ring[nr - 1]
  }
  const top = layer(0, false), bot = layer(-t, true)
  for (let s = 0; s < ns; s++) { const a = top[s], q = top[(s + 1) % ns], c = bot[(s + 1) % ns], d = bot[s]; b.tri(a, d, c); b.tri(a, c, q) }
  return b
}
const meshArea = (m) => {
  let A = 0
  const P = m.position, I = m.index
  for (let q = 0; q < I.length; q += 3) {
    const a = I[q] * 3, b = I[q + 1] * 3, c = I[q + 2] * 3
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], w = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]
    A += 0.5 * Math.hypot(...cross(u, w))
  }
  return A
}

await ok('部件读数去重：厚壳碟（前后两张抛物面 + 口沿）areaM2 = 真实表面积；各部件面积之和 = 模型总面积', () => {
  const dish = thickDish(1, 2, 0.004, 24, 96).mesh('dish', 0)
  const bus = new MeshBuilder(); bus.box(-0.5, -0.5, -2, 0.5, 0.5, -1)
  const ir = { materials: [{ name: 'm0' }, { name: 'm1' }], meshes: [dish, bus.mesh('bus', 1)], nodes: [{ name: 'N0', parent: -1, mesh: 0 }, { name: 'N1', parent: -1, mesh: 1 }] }
  const r = autoSegment(ir)
  assertPartition(ir, r)
  const rp = r.parts.filter((p) => p.role === 'reflector')
  assert.equal(rp.length, 1)
  const A = meshArea(dish)
  assert.ok(relErr(rp[0].areaM2, A) < 1e-9, `反射面 areaM2 ${rp[0].areaM2}，真实 ${A}`)
  assert.ok(relErr(rp[0].surfaceM2, A) < 1e-9)
  assert.ok(relErr(rp[0].fitted.focalM, 1) < 0.005)
  const tot = ir.meshes.reduce((s, m) => s + meshArea(m), 0)
  assert.ok(relErr(r.parts.reduce((s, p) => s + p.surfaceM2, 0), tot) < 1e-9, '部件面积之和')
  // 合成卫星同样：全部部件表面积之和 = 模型总面积（翼吸收的分量、反射面分量与光滑片都不重复计）
  const irs = buildSat(), rs = autoSegment(irs)
  assert.ok(relErr(rs.parts.reduce((s, p) => s + p.surfaceM2, 0), irs.meshes.reduce((s, m) => s + meshArea(m), 0)) < 1e-9)
})

await ok('太阳翼组只从几何翼生成：叫 Solar 的边框落在翼包络里的并进翼，伸出去的与体装电池片留作部件、不出组；关联经 schema 归一仍在', async () => {
  const ir = buildSat({ names: ['m0', 'm1', 'm2', 'm3', 'm4', 'SolarPanel_Frame', 'SolarCell_Body'] })
  // 翼 A 外缘一根细框（z 0.900–0.905，全长在翼薄板包络里）+ 末端一根伸出包络的撑杆，焊成同一连通分量：
  // 分量整体出了包络，几何那一步吸收不了；细框各面窄于平面候选的面积门槛，也进不了平片候选
  const yEnd = 2.0 + 3 * PANEL_Y + 2 * GAP
  const fr = new MeshBuilder()
  fr.box(-0.0025, 2.0, 0.9, 0.0025, yEnd, 0.905)
  fr.box(-0.0025, yEnd - 0.005, 0.9, 0.0025, yEnd, 1.6)
  // 本体 +x 面上一片体装电池（名字是强提示，但不在任何翼包络里，也不是「两面朝空」的翼）
  const bc = new MeshBuilder(); bc.box(1.0, -0.5, -0.5, 1.005, 0.5, 0.5)
  ir.meshes.push(fr.mesh('frame', 5), bc.mesh('patch', 6))
  ir.nodes.push({ name: 'WingA_Frame', parent: 0, mesh: ir.meshes.length - 2 }, { name: 'BodyPatch', parent: 0, mesh: ir.meshes.length - 1 })
  const r = autoSegment(ir)
  assertPartition(ir, r)
  const wings = r.parts.filter((p) => p.role === 'solarArray' && p.source === 'geometry')
  assert.equal(wings.length, 2)
  assert.equal(r.solarPanelGroups.length, 2)
  for (const p of wings) {
    assert.ok(relErr(p.areaM2, WING_AREA) < 0.01, `${p.id} 面积 ${p.areaM2}`)
    const g = r.solarPanelGroups.find((x) => x.partId === p.id)
    assert.ok(g && p.solarGroup === g.name)
  }
  const wA = wings.find((p) => p.centroidBody[1] > ROOT[1])
  const fTr = wA.triRanges.find((t) => t.node === 'WingA_Frame')
  assert.ok(fTr && fTr.ranges.reduce((s, x) => s + x[1], 0) >= 12, '细框并进翼 A')
  assert.equal(wA.triRange, undefined, '翼 A 跨实例、全局不连续，不给 triRange')
  const left = r.parts.filter((p) => p.role === 'solarArray' && p.source !== 'geometry')
  assert.ok(left.some((p) => p.name === 'SolarPanel_Frame' && p.source === 'material'), '伸出包络的撑杆留作材质部件')
  assert.ok(left.some((p) => p.name === 'SolarCell_Body'), '体装电池片留作部件')
  for (const p of left) assert.equal(p.solarGroup, undefined)
  const refl = r.parts.find((p) => p.role === 'reflector')
  assert.equal(refl.attachPoint, r.attachPoints[0].name)
  assert.equal(r.attachPoints[0].part, refl.id)
  // 经 W1 的 normalizeMeta：组上的 partId、挂点上的 part 会被删，部件上的 solarGroup / attachPoint 保留
  const { normalizeMeta } = await import('../models/schema.mjs')
  const meta = normalizeMeta({
    id: 'user:0123456789ab', title: 't', source: { kind: 'user', url: '', credit: '', license: 'x', redistributable: true },
    parts: r.parts, attachPoints: r.attachPoints, solarPanelGroups: r.solarPanelGroups,
  })
  assert.equal(meta.solarPanelGroups.length, 2)
  for (const g of meta.solarPanelGroups) assert.ok(meta.parts.some((p) => p.solarGroup === g.name && p.role === 'solarArray'), g.name)
  assert.ok(meta.parts.some((p) => p.attachPoint === meta.attachPoints[0].name && p.role === 'reflector'))
})

await ok('triRange：部件三角形全局连续时给 [start, count]（全局编号 = 实例顺序拼接）', () => {
  const m = new MeshBuilder()
  m.box(-1, -1, -1, 1, 1, 1)                                     // 三角形 0–11：本体
  m.dish(VERT, K, E1, F, D, H, 24, 96)                           // 12 起：反射面
  const nd = m.i.length / 3 - 12
  const ir = { materials: [{ name: 'x' }], meshes: [m.mesh('all', 0)], nodes: [{ name: 'Root', parent: -1 }, { name: 'All', parent: 0, mesh: 0 }] }
  const r = autoSegment(ir)
  assertPartition(ir, r)
  const refl = r.parts.find((p) => p.role === 'reflector'), bus = r.parts.find((p) => p.role === 'bus')
  assert.deepEqual(refl.triRange, [12, nd])
  assert.deepEqual(refl.triRanges, [{ node: 'All', mesh: 0, ranges: [[12, nd]] }])
  assert.deepEqual(bus.triRange, [0, 12])
})

await ok('空输入 / 无三角形不抛', () => {
  assert.deepEqual(autoSegment({ meshes: [] }).parts, [])
  assert.deepEqual(autoSegment(null).parts, [])
  assert.equal(fitParaboloid([[0, 0, 0], [1, 0, 0]]), null)
})

// ───────── 性能 ─────────

await ok('性能：50 万三角形分割 < 5 s，结果不变', () => {
  const ir = buildSat({ dense: true })
  const T = totalTris(ir)
  assert.ok(T >= 500000, `三角形 ${T}`)
  const t0 = performance.now()
  const r = autoSegment(ir)
  const ms = performance.now() - t0
  console.log(`      ${T} 三角形 · ${ms.toFixed(0)} ms · 部件 ${r.parts.length} · ${JSON.stringify({ comps: r.stats.components, patches: r.stats.patches, fits: r.stats.reflectorFits })}`)
  assertPartition(ir, r)
  const solar = r.parts.filter((p) => p.role === 'solarArray')
  assert.equal(solar.length, 2)
  for (const p of solar) assert.ok(relErr(p.areaM2, WING_AREA) < 0.01)
  const refl = r.parts.filter((p) => p.role === 'reflector')
  assert.equal(refl.length, 1)
  assert.ok(relErr(refl[0].fitted.focalM, F) < 0.005 && relErr(refl[0].fitted.diameterM, D) < 0.02)
  assert.ok(ms < 5000, `耗时 ${ms.toFixed(0)} ms`)
})

// ───────── NASA 夹具（Draco 解码；不联网）─────────

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'models')

async function irFromGlb(io, path) {
  const doc = await io.readBinary(new Uint8Array(readFileSync(path)))
  const root = doc.getRoot()
  const mats = root.listMaterials()
  const mi = new Map(mats.map((m, i) => [m, i]))
  const ir = { materials: mats.map((m, i) => ({ name: m.getName() || `material_${i}` })), meshes: [], nodes: [] }
  const el = [0, 0, 0]
  const visit = (node, parent) => {
    const ni = ir.nodes.length
    ir.nodes.push({ name: node.getName() || `node_${ni}`, parent, matrix: Array.from(node.getMatrix()) })
    const mesh = node.getMesh()
    if (mesh) {
      mesh.listPrimitives().filter((p) => p.getMode() === 4 && p.getAttribute('POSITION')).forEach((p, k) => {
        const acc = p.getAttribute('POSITION'), n = acc.getCount(), position = new Float32Array(n * 3)
        for (let i = 0; i < n; i++) { acc.getElement(i, el); position.set(el, i * 3) }
        const ia = p.getIndices()
        const m = ir.meshes.push({ name: mesh.getName() || 'mesh', position, index: ia ? Uint32Array.from(ia.getArray()) : null, material: p.getMaterial() ? mi.get(p.getMaterial()) : -1 }) - 1
        if (k === 0) ir.nodes[ni].mesh = m
        else ir.nodes.push({ name: `${ir.nodes[ni].name}#${k}`, parent: ni, mesh: m })
      })
    }
    for (const c of node.listChildren()) visit(c, ni)
  }
  for (const n of (root.getDefaultScene() || root.listScenes()[0]).listChildren()) visit(n, -1)
  return ir
}

await ok('NASA 夹具 6 件：autoSegment 不抛、三角形全划分（打印部件数）', async () => {
  const { NodeIO } = await import('@gltf-transform/core')
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions')
  const draco3d = (await import('draco3dgltf')).default
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() })
  const files = readdirSync(FIX).filter((f) => f.endsWith('.glb')).sort()
  assert.equal(files.length, 6)
  for (const f of files) {
    const ir = await irFromGlb(io, join(FIX, f))
    // 无索引的图元补顺序索引，assertPartition 按 index 数三角形
    for (const m of ir.meshes) if (!m.index) m.index = Uint32Array.from({ length: m.position.length / 3 }, (_, i) => i)
    const r = autoSegment(ir)
    assertPartition(ir, r)
    // 不变式：太阳翼组一一对应几何翼，部件上反写了组名；各部件面积之和 = 总面积（不重复计）
    const byId = new Map(r.parts.map((p) => [p.id, p]))
    for (const g of r.solarPanelGroups) {
      const p = byId.get(g.partId)
      assert.ok(p && p.source === 'geometry' && p.role === 'solarArray' && p.solarGroup === g.name, `${f} ${g.name}`)
    }
    assert.equal(r.solarPanelGroups.length, r.parts.filter((p) => p.source === 'geometry' && p.role === 'solarArray').length)
    const by = {}
    for (const p of r.parts) by[p.role] = (by[p.role] || 0) + 1
    console.log(`      ${f.padEnd(20)} ${String(r.stats.tris).padStart(6)} 面 · ${r.stats.ms.toFixed(0).padStart(4)} ms · 部件 ${r.parts.length} ${JSON.stringify(by)} · 太阳翼组 ${r.solarPanelGroups.length} · 挂点 ${r.attachPoints.length}`)
  }
})

console.log(`modelSegment: ${pass} 项通过`)
if (process.exitCode) process.exit(process.exitCode)
