// 导出烘焙目标按类别（P3 契约 §11-2 / DESIGN3 E5）：src/viz/models/exporter.js 的 bakeTargetOf 与 exportGlb 缺省烘焙。
//   · 飞机 / 船舶 / 车辆 / 地球站（bodyFrame.ENTITY_KINDS）→ Q_YUP_ZENITH（glTF +Y = 天顶、+Z = 前）；其余 → 出厂 STK 映射；
//   · 烘焙前后本体系几何逐位不变（q 都是带号轴置换 → 角点变换精确）；bakeFrame:false 保留原 q；importQ 跟烘焙目标走。
// 渲染端源码用 @core/… 别名：照 modelRenderStack.test.mjs 先注册解析钩子再动态导入；GLTFExporter 的二进制输出要 FileReader，补最小实现。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz/models') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class { readAsArrayBuffer(b) { b.arrayBuffer().then((ab) => { this.result = ab; if (this.onloadend) this.onloadend() }) } }
}

const THREE = await import('three')
const { bakeTargetOf, exportGlb } = await import(SRC + 'exporter.js')
const BF = await import(CORE + 'models/bodyFrame.mjs')
const { parseGlb, gltfBoundsApprox } = await import(CORE + 'models/glb.mjs')

let n = 0
const t = async (name, fn) => { try { await fn(); n++ } catch (e) { console.error('✗ ' + name); throw e } }
const QY = Array.from(BF.Q_YUP_ZENITH), QS = Array.from(BF.DEFAULT_Q_MODEL2BODY)

await t('bakeTargetOf：四类实体 → +Y 天顶；卫星 / 运载 / 其它 / 缺省 → STK 映射；每次新数组', () => {
  for (const k of BF.ENTITY_KINDS) { const r = bakeTargetOf({ kind: k }); assert.deepEqual(r, { q: QY, key: 'yup' }, k) }
  for (const k of ['spacecraft', 'launcher', 'other', '', undefined]) assert.deepEqual(bakeTargetOf({ kind: k }), { q: QS, key: 'stk' }, String(k))
  assert.deepEqual(bakeTargetOf(null), { q: QS, key: 'stk' })
  assert.deepEqual(bakeTargetOf(undefined), { q: QS, key: 'stk' })
  const a = bakeTargetOf({ kind: 'ship' }).q, b = bakeTargetOf({ kind: 'ship' }).q
  assert.notEqual(a, b); a[0] = 9; assert.deepEqual(Array.from(BF.Q_YUP_ZENITH), QY)
  assert.ok(!Object.isFrozen(bakeTargetOf({ kind: 'spacecraft' }).q))
})
await t('+Y 天顶口径：glTF +Y ↦ 本体 −Z（FRD / NED 天顶）、glTF +Z ↦ 本体 +X（前）', () => {
  assert.deepEqual(BF.modelToBody([0, 1, 0], QY).map((v) => v + 0), [0, 0, -1])
  assert.deepEqual(BF.modelToBody([0, 0, 1], QY).map((v) => v + 0), [1, 0, 0])
})

// 一个不对称的盒（模型系），按 q0 放进本体系；导出后从 glb 的 accessor 包围盒按导出件的 q 回到本体系，应与原本体包围盒逐位相等
function boxModel() {
  const g = new THREE.BoxGeometry(4, 2, 1).translate(0.5, 0.25, -0.3)
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial())
  mesh.name = 'hull'
  const root = new THREE.Group(); root.name = 'root'; root.add(mesh)
  return root
}
function bodyBoxOfModelBox(min, max, q) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < 8; k++) {
    const p = BF.modelToBody([k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]], q)
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]) }
  }
  return { min: lo.map((v) => v + 0), max: hi.map((v) => v + 0) }
}
const MODEL_BOX = { min: [-1.5, -0.75, -0.8], max: [2.5, 1.25, 0.2] }
const metaOf = (kind, q) => ({ id: 'user:0123456789ab', title: 't', kind, source: { kind: 'user', url: '', credit: '', license: '', redistributable: true },
  units: { scaleToMeters: 1 }, frame: { q_model2body: q.slice(), t_model2body: [0, 0, 0] } })
async function roundTrip(kind, q0, opts = {}) {
  const e = await exportGlb(boxModel(), metaOf(kind, q0), { originAtCom: false, ...opts })
  assert.deepEqual(e.info.errors, [])
  const p = parseGlb(e.glb)
  assert.ok(p.ok)
  const f = p.json.extras.satsim.frame
  const bb = gltfBoundsApprox(p.json)
  return { f, body: bodyBoxOfModelBox(bb.min, bb.max, f.q_model2body), want: bodyBoxOfModelBox(MODEL_BOX.min, MODEL_BOX.max, q0) }
}
const near = (a, b, tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

for (const kind of BF.ENTITY_KINDS) {
  await t(`exportGlb 缺省烘焙：${kind}（原 q = STK）→ 导出件 q = importQ = +Y 天顶、本体包围盒不变`, async () => {
    const r = await roundTrip(kind, QS)
    assert.deepEqual(r.f.q_model2body, QY); assert.deepEqual(r.f.importQ, QY)
    assert.ok(near(r.body.min, r.want.min) && near(r.body.max, r.want.max), JSON.stringify(r))
  })
}
await t('exportGlb 缺省烘焙：spacecraft（原 q = +Y 天顶）→ 导出件 q = STK 映射、本体包围盒不变', async () => {
  const r = await roundTrip('spacecraft', QY)
  assert.deepEqual(r.f.q_model2body, QS); assert.deepEqual(r.f.importQ, QS)
  assert.ok(near(r.body.min, r.want.min) && near(r.body.max, r.want.max), JSON.stringify(r))
})
await t('exportGlb 缺省烘焙：没有 kind → STK 映射（与改前一致）', async () => {
  const r = await roundTrip(undefined, QY)
  assert.deepEqual(r.f.q_model2body, QS)
  assert.ok(near(r.body.min, r.want.min) && near(r.body.max, r.want.max))
})
await t('bakeFrame:false：保留原 q（装配件入库口径），不看类别', async () => {
  for (const [kind, q0] of [['aircraft', QS], ['ground', QY], ['spacecraft', QY], ['ship', QS]]) {
    const r = await roundTrip(kind, q0, { bakeFrame: false })
    assert.deepEqual(r.f.q_model2body, q0, kind); assert.deepEqual(r.f.importQ, q0, kind)
    assert.ok(near(r.body.min, r.want.min) && near(r.body.max, r.want.max), kind)
  }
})

console.log(`modelExportFrame: ${n} 项通过`)
