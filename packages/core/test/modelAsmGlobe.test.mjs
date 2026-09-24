// 装配件上 3D 球（P3 CONTRACT §9.1 / P1 验收第 8 步的单测一半）：卫星装配文档（平台体 + 镜像太阳翼 + 反射面）
// buildAssembly → irToThree → modelLayer.mountInstance：建得出对日驱动；200 个随机太阳方向下两翼电池片法向都在翼轴法平面内
// 正对太阳投影（偏差 < 1e-6，同 modelGlobeLayer ⑤ 的口径）；镜像翼的电池面朝向与主翼相同（镜像不翻电池面）；
// 包围半径与 buildAssembly 的 boundingRadiusM 同量级（±15 %）；径向对称的翼组同样对日。
// 渲染端源码用 @core/… 别名：先注册解析钩子再动态导入（写法同 modelGlobeLayer.test.mjs）。不联网。
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
const { irToThree } = await import(SRC + 'models/irToThree.js')
const A = await import(CORE + 'models/assembly.mjs')

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
let seed = 0x2545f491
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

// 材质库的程序纹理要画布（node 里没有）：去掉材质键走普通材质 —— 只验几何
const plainIR = (ir) => { for (const m of ir.materials) delete m.key; return ir }
const BUS = { id: 'bus', type: 'sat.bus.box', parent: null }
const DOC = A.normalizeAssembly({ domain: 'spacecraft', name: '装配星', comps: [BUS,
  { id: 'wing', type: 'sat.wing', parent: 'bus', attach: { mode: 'socket', socket: '+Y' }, params: { panels: 3 }, sym: { op: 'mirrorXZ' } },
  { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+X' }, params: { diameterM: 2.2 } }] })

function mount(doc) {
  const r = A.buildAssembly(doc)
  const inst = { root: irToThree(plainIR(r.ir)), meta: { frame: r.frame, units: { scaleToMeters: 1 }, geometry: { boundingRadiusM: r.boundingRadiusM }, articulations: r.articulations, solarPanelGroups: r.solarPanelGroups } }
  return { r, m: ML.__test.mountInstance(inst) }
}
function cellNormalsBody(m, r) {
  const names = new Set(r.solarPanelGroups.flatMap((g) => g.nodes))
  m.holder.updateMatrixWorld(true)
  const out = []
  m.holder.traverse((o) => {
    const nm = (o.userData && o.userData.name) || o.name
    if (!o.isMesh || !names.has(nm)) return
    const n0 = ML.__test.faceNormal(o.geometry)
    out.push({ name: nm, n: n0.applyMatrix3(new THREE.Matrix3().getNormalMatrix(o.matrixWorld)).normalize() })
  })
  return out
}
/** 翼轴沿 axis（本体系单位向量）：绕它转到正对太阳时，最好情况 n·s = √(1 − (s·axis)²)。 */
function checkTracking(doc, axisOf) {
  const { r, m } = mount(doc)
  assert.ok(m.sun, '没建出对日驱动')
  let worst = 0, cnt = 0
  for (let k = 0; k < 200; k++) {
    const u = rnd() * 2 - 1, p = rnd() * 2 * Math.PI, q = Math.sqrt(1 - u * u)
    const s = new THREE.Vector3(q * Math.cos(p), q * Math.sin(p), u)
    m.sun.update(s)
    for (const c of cellNormalsBody(m, r)) {
      const ax = axisOf(c.name), sa = s.dot(ax)
      if (Math.abs(sa) > 0.98) continue   // 太阳几乎沿翼轴：法平面投影退化，驱动按兵不动
      worst = Math.max(worst, Math.abs(c.n.dot(s) - Math.sqrt(1 - sa * sa)))
      cnt++
    }
  }
  assert.ok(cnt > 150, `样本 ${cnt}`)
  assert.ok(worst < 1e-6, `worst ${worst}`)
  return { r, m }
}

t('装配星：两翼（主 + 镜像派生）都建出对日驱动、200 个随机太阳方向电池片正对太阳投影（< 1e-6）', () => {
  const { r } = checkTracking(DOC, () => new THREE.Vector3(0, 1, 0))
  assert.equal(r.solarPanelGroups.length, 2, '两翼各一组')
  assert.deepEqual(r.solarPanelGroups.map((g) => g.name.split('_')[0]).sort(), ['wing', 'wing-1'])
})

t('镜像不翻电池面：两翼电池片部件 normalBody 相同；翼尖在 ±Y 对称', () => {
  const r = A.buildAssembly(DOC)
  const cells = r.parts.filter((p) => p.role === 'solarArray' && Array.isArray(p.normalBody))
  const a = cells.filter((p) => p.id.startsWith('wing_')), b = cells.filter((p) => p.id.startsWith('wing-1_'))
  assert.ok(a.length && a.length === b.length, `${a.length} vs ${b.length}`)
  for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[i].normalBody[k] - b[i].normalBody[k]) < 1e-12, `${a[i].id} / ${b[i].id}`)
  assert.ok(Math.abs(r.bboxBody.min[1] + r.bboxBody.max[1]) < 1e-9, 'y 区间关于 0 对称')
})

t('包围半径（本体原点 → 最远角点）与 buildAssembly 的 boundingRadiusM 同量级（±15 %）', () => {
  const { r, m } = mount(DOC)
  assert.ok(Math.abs(m.radius - r.boundingRadiusM) / r.boundingRadiusM < 0.15, `${m.radius} vs ${r.boundingRadiusM}`)
})

t('径向对称 3 翼（绕 +Z）：各翼轴沿自己的径向，同样正对太阳投影', () => {
  const d = A.normalizeAssembly({ domain: 'spacecraft', comps: [BUS, { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'socket', socket: '+Y' }, params: { panels: 2 }, sym: { op: 'radial', n: 3 } }] })
  const axes = { w: new THREE.Vector3(0, 1, 0) }
  for (const k of [1, 2]) { const a = (2 * Math.PI * k) / 3; axes[`w-${k}`] = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0) }
  const { r } = checkTracking(d, (name) => axes[name.split('_')[0]])
  assert.equal(r.solarPanelGroups.length, 3)
})

t('没有太阳翼的装配件不建驱动', () => {
  const d = A.normalizeAssembly({ domain: 'spacecraft', comps: [BUS, { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+X' } }] })
  assert.equal(mount(d).m.sun, null)
})

console.log(`modelAsmGlobe: ${n} 项通过`)
