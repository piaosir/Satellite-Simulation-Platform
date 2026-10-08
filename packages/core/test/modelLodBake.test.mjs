// 低档外观保真（scripts/nasa3d/lodbake.mjs）：法线朝向纠正 + 平面细节烘焙的单测。不联网、不读 .models-src。
// 运行：node packages/core/test/modelLodBake.test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href)
const K = await imp('scripts/nasa3d/lodbake.mjs')
const B = await imp('scripts/nasa3d/build.mjs')
const { Document } = await import('@gltf-transform/core')
const F = await import('@gltf-transform/functions')
const sharp = (await import('sharp')).default
const { MeshoptSimplifier } = await import('meshoptimizer')
await MeshoptSimplifier.ready

let n = 0
const ok = (c, m) => { assert.ok(c, m); n++ }
const eq = (a, b, m) => { assert.equal(a, b, m); n++ }
const near = (a, b, tol, m) => { assert.ok(Math.abs(a - b) <= tol, `${m}：${a} vs ${b}（容差 ${tol}）`); n++ }

// ─────────────── ① 纯函数 ───────────────
{
  eq(K.linearToSrgb8(0), 0, 'sRGB：0'); eq(K.linearToSrgb8(1), 255, 'sRGB：1'); eq(K.linearToSrgb8(0.2159), 128, 'sRGB：0.2159 → 128')
  near(K.srgb8ToLinear(128), 0.2158, 0.001, 'sRGB 反变换')
  for (const nrm of [[0, 0, 1], [1, 0, 0], [0.6, 0.8, 0], [0.267, 0.535, 0.802]]) {
    const L = Math.hypot(...nrm), nn = nrm.map((v) => v / L)
    const [a, b] = K.perpPair(nn)
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
    near(dot(a, nn), 0, 1e-12, 'perpPair ⟂ n'); near(dot(b, nn), 0, 1e-12, 'perpPair ⟂ n'); near(dot(a, b), 0, 1e-12, 'perpPair 互相垂直')
    near(Math.hypot(...a), 1, 1e-12, 'perpPair 单位长')
  }
  // 主边方向：转了 23° 的方格网 → 23°（模 90°）
  const th = 23 * Math.PI / 180, edges = []
  for (let i = 0; i < 40; i++) { edges.push(Math.cos(th), Math.sin(th), -Math.sin(th) * 0.5, Math.cos(th) * 0.5) }
  edges.push(0.3, 0.1)   // 一条杂边
  near(K.dominantAngle(edges) * 180 / Math.PI, 23, 0.05, 'dominantAngle 取到网格方向')
  near(K.dominantAngle([1, 0, 0, 1]) * 180 / Math.PI, 0, 0.6, 'dominantAngle 轴对齐 → 0°')
  // 货架装箱：不重叠、不出界
  const rects = [{ w: 50, h: 40 }, { w: 30, h: 60 }, { w: 70, h: 20 }, { w: 20, h: 20 }, { w: 64, h: 33 }]
  const pk = K.packShelves(rects, 128)
  ok(pk.ok && pk.W <= 128 && pk.H <= 128, 'packShelves：装得下')
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const A = { ...pk.pos[i], ...rects[i] }, Bq = { ...pk.pos[j], ...rects[j] }
    ok(A.x + A.w <= Bq.x || Bq.x + Bq.w <= A.x || A.y + A.h <= Bq.y || Bq.y + Bq.h <= A.y, `packShelves：${i} 与 ${j} 不重叠`)
  }
  ok(!K.packShelves([{ w: 200, h: 10 }], 128).ok, 'packShelves：比图集宽 → 装不下')
  // 光栅化：直角三角形盖住 10×10 方格的一半（样本中心规则下 55 个，含对角线）
  const cov = new Set()
  const cnt = K.rasterTri(0, 0, 10, 0, 0, 10, 16, 16, (s) => cov.add(s))
  eq(cnt, cov.size, 'rasterTri：回调与返回数一致')
  ok(cnt >= 45 && cnt <= 55, `rasterTri：覆盖约一半（${cnt}）`)
  eq(K.rasterTri(0, 0, 1, 1, 2, 2, 8, 8, () => {}), 0, 'rasterTri：退化三角形不画')
}

// ─────────────── 合成文档：底板 + 8×8 两色电池片（互不相连，高 1 mm）+ 一个盒子 ───────────────
function mkDoc({ invert = false } = {}) {
  const doc = new Document()
  const buf = doc.createBuffer()
  const scene = doc.createScene('s')
  doc.getRoot().setDefaultScene(scene)
  const node = doc.createNode('sat')
  scene.addChild(node)
  const mesh = doc.createMesh('m')
  node.setMesh(mesh)
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf)
  const mat = (name, c, ds = true) => doc.createMaterial(name).setBaseColorFactor([...c, 1]).setMetallicFactor(1).setRoughnessFactor(0.9).setDoubleSided(ds)
  const addQuads = (quads, m) => {
    const P = [], N = [], I = []
    for (const q of quads) {
      const b = P.length / 3
      for (const p of q.p) { P.push(...p); N.push(...(invert ? q.n.map((v) => -v) : q.n)) }
      I.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
    mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', acc('VEC3', new Float32Array(P))).setAttribute('NORMAL', acc('VEC3', new Float32Array(N)))
      .setIndices(acc('SCALAR', new Uint16Array(I))).setMaterial(m))
  }
  // 底板：x∈[0,8]、z∈[0,8]、y=0，法线 +Y（绕向：(0,0,0)→(0,0,8)→(8,0,8)→(8,0,0) 给出 +Y）
  const up = [0, 1, 0]
  const quad = (x0, z0, x1, z1, y) => ({ p: [[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], n: up })
  addQuads([quad(0, 0, 8, 8, 0)], mat('substrate', [0.1, 0.1, 0.1]))
  const blue = [], purple = []
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) ((i + j) % 2 ? purple : blue).push(quad(i + 0.05, j + 0.05, i + 0.95, j + 0.95, 0.001))
  addQuads(blue, mat('cells_blue', [0.05, 0.1, 0.6]))
  addQuads(purple, mat('cells_purple', [0.3, 0.05, 0.5]))
  // 盒子（非共面细节，不该被烘）
  const box = []
  const bx = (c, h) => {
    const [cx, cy, cz] = c
    const f = (n, u, v) => ({ p: [[cx + n[0] * h - u[0] * h - v[0] * h, cy + n[1] * h - u[1] * h - v[1] * h, cz + n[2] * h - u[2] * h - v[2] * h], [cx + n[0] * h + u[0] * h - v[0] * h, cy + n[1] * h + u[1] * h - v[1] * h, cz + n[2] * h + u[2] * h - v[2] * h], [cx + n[0] * h + u[0] * h + v[0] * h, cy + n[1] * h + u[1] * h + v[1] * h, cz + n[2] * h + u[2] * h + v[2] * h], [cx + n[0] * h - u[0] * h + v[0] * h, cy + n[1] * h - u[1] * h + v[1] * h, cz + n[2] * h - u[2] * h + v[2] * h]], n })
    box.push(f([1, 0, 0], [0, 1, 0], [0, 0, 1]), f([-1, 0, 0], [0, 0, 1], [0, 1, 0]), f([0, 1, 0], [0, 0, 1], [1, 0, 0]), f([0, -1, 0], [1, 0, 0], [0, 0, 1]), f([0, 0, 1], [1, 0, 0], [0, 1, 0]), f([0, 0, -1], [0, 1, 0], [1, 0, 0]))
  }
  bx([4, -2, 4], 0.8)
  addQuads(box, mat('box', [0.8, 0.8, 0.8], false))
  return { doc, mesh }
}

// ─────────────── ② 法线朝向纠正 ───────────────
{
  const { doc } = mkDoc({ invert: true })
  const r = K.fixInvertedNormals(doc)
  eq(r.prims, 4, 'fixInvertedNormals：数了 4 个图元')
  eq(r.flipped.length, 4, 'fixInvertedNormals：整件反向的 4 个图元都翻')
  const p = doc.getRoot().listMeshes()[0].listPrimitives()[0]
  const el = [0, 0, 0]
  p.getAttribute('NORMAL').getElement(0, el)
  near(el[1], 1, 1e-6, 'fixInvertedNormals：底板法线翻回 +Y')
  const again = K.fixInvertedNormals(doc)
  eq(again.flipped.length, 0, 'fixInvertedNormals：已一致的不再翻（幂等）')
  const { doc: d2 } = mkDoc()
  eq(K.fixInvertedNormals(d2).flipped.length, 0, 'fixInvertedNormals：正常件不动')
}

// ─────────────── ③ 平面细节烘焙 ───────────────
{
  const { doc, mesh } = mkDoc()
  const before = mesh.listPrimitives().length
  const r = await K.bakePlanarDetail(doc, F, sharp, { lod: 'lod1' })
  eq(r.regions, 1, '烘焙：底板 + 电池片合成 1 个区域')
  eq(r.trisRemoved, 2 + 64 * 2, '烘焙：底板 2 + 电池片 128 个三角形删掉')
  const prims = mesh.listPrimitives()
  const bake = prims.filter((p) => K.isBakePrim(p))
  eq(bake.length, 1, '烘焙：追加 1 个四边形图元')
  eq(prims.length - bake.length, 1, `烘焙：只剩盒子（原 ${before} 个图元）`)
  eq(prims.find((p) => !K.isBakePrim(p)).getMaterial().getName(), 'box', '烘焙：盒子（非共面）不烘')
  const bp = bake[0], m = bp.getMaterial()
  eq(m.getAlphaMode(), 'MASK', '烘焙材质：alpha 遮罩')
  ok(m.getDoubleSided(), '烘焙材质：原材质双面 → 双面')
  ok(m.getBaseColorTexture() && m.getBaseColorTexture().getName().startsWith(K.BAKE_TEX_PREFIX), '烘焙贴图：名字带前缀（通用贴图压缩跳过它）')
  eq(m.getBaseColorTexture().getMimeType(), 'image/webp', '烘焙贴图：WebP')
  ok(!m.getMetallicRoughnessTexture(), '烘焙材质：金属 / 粗糙全一致 → 用系数、不出 MR 图')
  near(m.getRoughnessFactor(), 0.9, 1e-6, '烘焙材质：粗糙度系数 = 原值')
  // 四边形：覆盖底板 [0,8]²、落在顶层（y = 0.001）、法线 +Y
  const pos = bp.getAttribute('POSITION'), nor = bp.getAttribute('NORMAL'), uv = bp.getAttribute('TEXCOORD_0')
  eq(pos.getCount(), 4, '四边形 4 个顶点')
  const lo = pos.getMin([]), hi = pos.getMax([])
  near(lo[0], 0, 1e-5, '四边形 x 下界'); near(hi[0], 8, 1e-5, '四边形 x 上界'); near(lo[2], 0, 1e-5, '四边形 z 下界'); near(hi[2], 8, 1e-5, '四边形 z 上界')
  near(lo[1], 0.001, 1e-6, '四边形在顶层（电池片面）'); near(hi[1], 0.001, 1e-6, '四边形共面')
  const el = [0, 0, 0]
  nor.getElement(0, el); near(el[1], 1, 1e-6, '四边形法线 +Y')
  // 贴图：在电池片中心按 UV 取样 → 该片颜色（sRGB），在片缝处 → 底板色
  const img = await sharp(Buffer.from(m.getBaseColorTexture().getImage())).raw().toBuffer({ resolveWithObject: true })
  const W = img.info.width, H = img.info.height, ch = img.info.channels
  // 世界 (x,z) → UV：按四边形四角的 UV 双线性（矩形，轴对齐或转过都行）
  const P = [], T = []
  for (let i = 0; i < 4; i++) { pos.getElement(i, el); P.push([el[0], el[2]]); uv.getElement(i, el); T.push([el[0], el[1]]) }
  const uvAt = (x, z) => {
    // 解 (s,t)：P0 + s(P1−P0) + t(P3−P0)
    const ax = P[1][0] - P[0][0], az = P[1][1] - P[0][1], bx = P[3][0] - P[0][0], bz = P[3][1] - P[0][1]
    const det = ax * bz - az * bx, dx = x - P[0][0], dz = z - P[0][1]
    const s = (dx * bz - dz * bx) / det, t = (ax * dz - az * dx) / det
    return [T[0][0] + s * (T[1][0] - T[0][0]) + t * (T[3][0] - T[0][0]), T[0][1] + s * (T[1][1] - T[0][1]) + t * (T[3][1] - T[0][1])]
  }
  const px = (x, z) => { const [u, v] = uvAt(x, z); const X = Math.min(W - 1, Math.floor(u * W)), Y = Math.min(H - 1, Math.floor(v * H)); const o = (Y * W + X) * ch; return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]] }
  const s8 = (c) => c.map(K.linearToSrgb8)
  const tol = 6
  const cBlue = px(0.5, 0.5), cPurple = px(1.5, 0.5), cGap = px(1.0, 3.5)
  const eBlue = s8([0.05, 0.1, 0.6]), ePurple = s8([0.3, 0.05, 0.5]), eGap = s8([0.1, 0.1, 0.1])
  for (let c = 0; c < 3; c++) {
    near(cBlue[c], eBlue[c], tol, `贴图取色：蓝片中心 通道 ${c}`)
    near(cPurple[c], ePurple[c], tol, `贴图取色：紫片中心 通道 ${c}`)
  }
  for (let c = 0; c < 3; c++) near(cGap[c], eGap[c], 8, `贴图取色：片缝露底板 通道 ${c}`)
  eq(cBlue[3], 255, '贴图：覆盖处 alpha = 255')
}

// ─────────────── ④ 同一平面正反两组 → 两块单面；单材质连成片的细分平面不烘 ───────────────
{
  const doc = new Document()
  const buf = doc.createBuffer()
  const scene = doc.createScene('s'); doc.getRoot().setDefaultScene(scene)
  const node = doc.createNode('n'); scene.addChild(node)
  const mesh = doc.createMesh('m'); node.setMesh(mesh)
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf)
  const mat = (name, c) => doc.createMaterial(name).setBaseColorFactor([...c, 1]).setDoubleSided(true)
  // 正面 64 片（两色）、背面 64 片（两色，绕向反），都在 y=0 面
  const add = (flip, m, filter) => {
    const P = [], N = [], I = []
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      if (!filter(i, j)) continue
      const b = P.length / 3, x0 = i + 0.05, x1 = i + 0.95, z0 = j + 0.05, z1 = j + 0.95
      const q = flip ? [[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]] : [[x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0]]
      for (const p of q) { P.push(...p); N.push(0, flip ? -1 : 1, 0) }
      I.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
    mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', acc('VEC3', new Float32Array(P))).setAttribute('NORMAL', acc('VEC3', new Float32Array(N))).setIndices(acc('SCALAR', new Uint16Array(I))).setMaterial(m))
  }
  add(false, mat('a', [0.1, 0.2, 0.7]), (i, j) => (i + j) % 2 === 0); add(false, mat('b', [0.2, 0.1, 0.6]), (i, j) => (i + j) % 2 === 1)
  add(true, mat('c', [0.2, 0.2, 0.2]), (i, j) => (i + j) % 2 === 0); add(true, mat('d', [0.3, 0.3, 0.3]), (i, j) => (i + j) % 2 === 1)
  const r = await K.bakePlanarDetail(doc, F, sharp, { lod: 'lod2' })
  eq(r.regions, 2, '正反两组：各烘一块')
  const bake = mesh.listPrimitives().filter((p) => K.isBakePrim(p))
  eq(bake.length, 1, '正反两组：同一材质变体（单面）合成一个图元')
  ok(!bake[0].getMaterial().getDoubleSided(), '正反两组共面：四边形改单面（防 z-fighting）')

  // 单材质、连成片的细分平面：简化器减得动，不烘
  const d2 = new Document()
  const b2 = d2.createBuffer(); const s2 = d2.createScene('s'); d2.getRoot().setDefaultScene(s2)
  const n2 = d2.createNode('n'); s2.addChild(n2); const m2 = d2.createMesh('m'); n2.setMesh(m2)
  const G = 10, P = [], N = [], I = []
  for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) { P.push(i, 0, j); N.push(0, 1, 0) }
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) { const a = i * (G + 1) + j, b = a + 1, c = a + G + 2, d = a + G + 1; I.push(a, b, c, a, c, d) }
  const ac = (t, arr) => d2.createAccessor().setType(t).setArray(arr).setBuffer(b2)
  m2.addPrimitive(d2.createPrimitive().setAttribute('POSITION', ac('VEC3', new Float32Array(P))).setAttribute('NORMAL', ac('VEC3', new Float32Array(N))).setIndices(ac('SCALAR', new Uint16Array(I))).setMaterial(d2.createMaterial('one')))
  eq((await K.bakePlanarDetail(d2, F, sharp, { lod: 'lod1' })).regions, 0, '单材质连通细分平面：不烘')
}

// ─────────────── ⑤ simplifyToBudget：烘焙四边形扛过 lod2 的 Prune / 简化 ───────────────
{
  const { doc } = mkDoc()
  const spec = B.LOD_SPECS.find((x) => x.key === 'lod2')
  const S = B.withSimplifyFlags(MeshoptSimplifier, [...B.LOD2_FLAGS])
  const r = await B.simplifyToBudget(doc, F, spec, { simplifier: S, raw: MeshoptSimplifier, flags: [...B.LOD2_FLAGS], uvWeight: B.LOD2_UV_WEIGHT, sharp })
  ok(r.budget.bake && r.budget.bake.regions === 1, 'simplifyToBudget：预算里记烘焙')
  const prims = r.doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
  const bake = prims.filter((p) => K.isBakePrim(p))
  eq(bake.length, 1, 'simplifyToBudget：烘焙四边形留下')
  eq(bake[0].getIndices().getCount(), 6, 'simplifyToBudget：四边形没被简化')
  ok(bake[0].getAttribute('NORMAL'), 'simplifyToBudget：四边形法线没被去掉')
  const r0 = await B.simplifyToBudget(doc, F, spec, { simplifier: S, raw: MeshoptSimplifier, flags: [...B.LOD2_FLAGS], uvWeight: B.LOD2_UV_WEIGHT, sharp, bake: false })
  ok(!r0.budget.bake, 'simplifyToBudget：bake:false 不烘')
}

console.log(`modelLodBake: ${n} 项通过`)
