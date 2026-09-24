// 装配穿插检测（src/viz/models/asmClash.js）对「转为装配」的回归（P3 修复轮 rv1：出厂星一打开就报假穿插）。
//
// 照编辑器 runClash 的口径搭一份 live 树的等价物：展开对称 → solvePose → 条目渲染矩阵（镜像派生件把镜面列取反）× 组件节点矩阵；
// 几何 = buildComponent 的 IR 网格（按件建 BVH）；热控包覆（MLI / Kapton 材质键）不参与；跳过「父子安装对」与同一主件的对称副本；
// 杆件（root 在原点、tip 在 +Z 端）给半径（两端按接头放宽）。然后跑真的 createClashRunner。
//   ① 全部参数化模板经 specToAssembly 后穿插对为 0（支臂链端接、铰座嵌进侧板、馈源支架落在塔顶都不算）；
//   ② 对照：真扎进去的（一块盒子沉进平台体一半、一根杆从中段横穿平台体）照报。
// three / three-mesh-bvh 走 node_modules；@core 别名用 loader 钩子解析（同 modelRenderStack）。不联网。
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
const { MeshBVH } = await import('three-mesh-bvh')
const A = await import(CORE + 'models/assembly.mjs')
const { templateSpec, TEMPLATE_IDS } = await import(CORE + 'models/paramTemplates.mjs')
const { createClashRunner } = await import(SRC + 'asmClash.js')

let n = 0
const t = async (name, fn) => { try { await fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const SKIN_RE = /^(mli_|kapton_)/
const PLANE_AX = { yz: 0, xz: 1, xy: 2 }

/** 组件几何缓存（type | 参数 | 材质 → 网格模板：{geometry, rel, key}[]、局部盒、杆半径）。 */
const geoCache = new Map()
function compGeom(c, density) {
  const key = c.type + '|' + JSON.stringify(c.params) + '|' + (c.material || '') + '|' + JSON.stringify(density || {})
  let g = geoCache.get(key)
  if (g) return g
  const bc = A.buildComponent(c.type, c.params, { density })
  const parts = []
  for (const nd of bc.ir.nodes) {
    if (!Number.isInteger(nd.mesh)) continue
    const m = bc.ir.meshes[nd.mesh]
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(m.position), 3))
    geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.index), 1))
    geo.boundsTree = new MeshBVH(geo)
    const mat = bc.ir.materials[m.material]
    const k = c.material || (mat && mat.key) || ''
    parts.push({ geometry: geo, rel: new THREE.Matrix4().fromArray(nd.matrix), skin: SKIN_RE.test(k) })
  }
  const tip = bc.sockets.find((s) => s.id === 'tip')
  const rod = tip && Math.abs(tip.pos[0]) < 1e-9 && Math.abs(tip.pos[1]) < 1e-9 && tip.pos[2] > 0 ? tip.size / 2 : 0
  const bb = bc.bbox
  g = { parts, box6: [bb.min[0], bb.min[1], bb.min[2], bb.max[0], bb.max[1], bb.max[2]], rod }
  geoCache.set(key, g)
  return g
}
function boxXform(b, m) {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? b[3] : b[0], y = i & 2 ? b[4] : b[1], z = i & 4 ? b[5] : b[2]
    const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
    for (let k = 0; k < 3; k++) { out[k] = Math.min(out[k], w[k]); out[k + 3] = Math.max(out[k + 3], w[k]) }
  }
  return out
}
/** 文档 → 穿插对（id 对）。 */
function clashPairs(doc) {
  const d = A.normalizeAssembly(doc)
  const poses = A.solvePose(d)
  const exp = A.expandSymmetry(d)
  const byId = new Map(d.comps.map((c) => [c.id, c]))
  const items = [], ents = []
  for (const x of exp) {
    const c = byId.get(x.src)
    if (!c || c.hidden) continue
    const g = compGeom(c, d.density)
    const p = poses.get(x.id)
    const m = Array.from(p.m)
    const ax = p.plane ? PLANE_AX[p.plane] : -1
    if (ax >= 0) { m[4 * ax] = -m[4 * ax]; m[4 * ax + 1] = -m[4 * ax + 1]; m[4 * ax + 2] = -m[4 * ax + 2] }
    const M = new THREE.Matrix4().fromArray(m)
    const meshes = []
    for (const q of g.parts) {
      if (q.skin) continue
      const mesh = new THREE.Mesh(q.geometry)
      mesh.matrixAutoUpdate = false
      mesh.matrixWorld.multiplyMatrices(M, q.rel)
      meshes.push(mesh)
    }
    if (!meshes.length) continue
    items.push({ meshes, box: boxXform(g.box6, m), rod: g.rod })
    ents.push({ id: x.id, pid: x.src, parent: x.parent })
  }
  const skip = (i, j) => { const a = ents[i], b = ents[j]; return a.parent === b.id || b.parent === a.id || a.pid === b.pid }
  return new Promise((res) => createClashRunner().run(items, skip, (pairs) => res(pairs.map(([i, j]) => [ents[i].id, ents[j].id]))))
}

await t('全部参数化模板「转为装配」后穿插对为 0（支臂链端接 / 铰座 / 馈源支架落塔顶不报）', async () => {
  const bad = []
  for (const id of TEMPLATE_IDS) {
    const doc = A.specToAssembly(templateSpec(id).spec)
    const pairs = await clashPairs(doc)
    if (pairs.length) bad.push(`${id}：${pairs.map((p) => p.join('↔')).join('、')}`)
  }
  assert.deepEqual(bad, [], bad.join('\n'))
})

await t('对照：真扎进去的照报（盒子沉进平台体一半、杆从中段横穿平台体），杆端落在平台体面上不报', async () => {
  const base = { kind: 'assembly', domain: 'spacecraft', name: 't' }
  const bus = { id: 'bus', type: 'sat.bus.box', parent: null }
  // 平台体缺省尺寸：取它 +X 面的位置
  const bx = A.buildComponent('sat.bus.box', {}).sockets.find((s) => s.id === '+X').pos[0]
  const sunk = await clashPairs({ ...base, comps: [bus, { id: 'bx', type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, t: [0, 0, 0], q: [0, 0, 0, 1], params: { xM: 0.3, yM: 0.3, zM: 0.3 } },
    { id: 'box', type: 'prim.box', parent: 'bx', attach: { mode: 'free' }, t: [bx, 0.2, 0], q: [0, 0, 0, 1], params: { xM: 0.4, yM: 0.4, zM: 0.4 } }] })
  assert.ok(sunk.some((p) => p.includes('box') && p.includes('bus')), '盒子沉进平台体：' + JSON.stringify(sunk))
  // 杆沿 X 横穿平台体（中段在体内）：照报
  const cross = await clashPairs({ ...base, comps: [bus, { id: 'bx', type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, t: [0, 0, 0], q: [0, 0, 0, 1], params: { xM: 0.3, yM: 0.3, zM: 0.3 } },
    { id: 'rod', type: 'sat.boom', parent: 'bx', attach: { mode: 'free' }, t: [-bx - 1, 0.3, 0], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2], params: { lengthM: 2 * bx + 2, dM: 0.05 } }] })
  assert.ok(cross.some((p) => p.includes('rod') && p.includes('bus')), '杆横穿平台体：' + JSON.stringify(cross))
  // 杆端正好落在平台体 +X 面上（沿 +X 伸出去）：接头，不报
  const touch = await clashPairs({ ...base, comps: [bus, { id: 'bx', type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, t: [0, 0, 0], q: [0, 0, 0, 1], params: { xM: 0.3, yM: 0.3, zM: 0.3 } },
    { id: 'rod', type: 'sat.boom', parent: 'bx', attach: { mode: 'free' }, t: [bx, 0.3, 0], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2], params: { lengthM: 1, dM: 0.05 } }] })
  assert.ok(!touch.some((p) => p.includes('rod') && p.includes('bus')), '杆端接在面上：' + JSON.stringify(touch))
})

console.log(`modelAsmClash: ${n} 项通过`)
