// 低档（lod1 / lod2）外观保真（2026-10-08）：平面细节烘焙 + 原件法线朝向纠正。由 build.mjs 调用（worker 内），纯 gltf-transform 文档操作。
//
// 为什么（2026-10-08 用户：「NASA 模型在平台里的效果不如 NASA 官网，比如 SSL-1300」；对照台 .modelharness/viz26 实测）：
//   ① 平面细节被简化删掉：NASA 美术件的太阳翼 / OSR 散热面是「成千上万块按材质分组、互不相连的小方片」贴在底板上
//      （SSL-1300：两翼 7.2 万个三角形落在同一平面、6 种蓝色材质各一个图元）。meshopt 简化只能沿边塌缩，互不相连的小方片
//      减不动就只能整块删 —— lod1 电池片成片缺失、lod2（随包内置、库页预览、球面图标都用它）电池片全没了，只剩深灰底板。
//      TDRS-D 的电池片、Landsat-8 的翼面同样。
//   ② 原件法线与绕向相反：全语料 213 个原件里 12 个几乎整件反向（TDRS-E、Spitzer、Swift、LADEE、Hinode…，全是双面材质），
//      另 4 个各有一个图元反向。three 按绕向判正反面、双面材质背面翻法线 —— 反向件的受光面用的是背光的法线，整件发暗；
//      lod1 / lod2 按绕向重算法线后又变亮，两档颜色对不上（TDRS-E 的翼面 lod0 深紫、lod1 品红）。
//
// 做法：
//   fixInvertedNormals(doc)：逐图元按面积多数表决（三角形绕向法线 · 三个顶点法线之和 < 0 记反向），反向占一半以上的整图元翻法线
//     （切线 w 同翻）。双面材质下与翻绕向等价；单面材质保留绕向（剔除面不变），只让受光面用对朝向的法线。三档都用（lod0 也修）。
//   bakePlanarDetail(doc, F, sharp, o)：低档专用（lod0 不烘）——
//     ① 共面聚类：按三角形法线（2° 内同组，法线哈希栅格找邻居）+ 平面偏移（层容差 = 网格对角线 × layerFrac 内的叠层算一组：
//        电池片比底板高 1 mm、金色汇流条再高 1 mm）。
//     ② 组内按平面上的占用栅格（格 = 对角线 × gridFrac）分连通区域（两翼共面但隔着星体 → 两个区域；板缝 5 cm 被格子跨过 → 一翼一个区域）。
//     ③ 够「碎」才烘：三角形 ≥ minTris、长边 ≥ 整件对角线 × minExtentFrac、且（材质 ≥ 2 种 或 互不相连的块 ≥ minComponents）——
//        单材质连成片的细分平面简化器自己减得动，不烘。含半透明（BLEND）材质的区域不烘。
//     ④ 图集：区域的平面坐标系取「边方向直方图（模 90°）的峰」作 u 轴（矩形板贴边对齐），全部区域按同一纹素密度装箱（货架法），
//        密度 = min(目标密度, 装得下的最大密度)，图集边长上限按档（BAKE_LOD）。
//     ⑤ 光栅化：每区域按层偏移从低到高逐三角形写样本（上层覆盖下层 = 电池片盖住底板），每像素 ss × ss 个样本，样本解出材质色
//        （底色系数 × 底色贴图双线性 × 顶点色，线性空间；自发光并进底色），像素 = 覆盖样本的均值、alpha = 覆盖率；
//        空像素按邻域扩张（mip 取样不串黑边）。金属度 / 粗糙度全图一致用系数，否则另出一张 MR 图集（G 粗糙、B 金属）。
//     ⑥ 原三角形删掉，换成区域外接矩形的四边形（贴图集；alpha 遮罩 MASK 0.5：十字翼的空角透明），法线 = 组法线（已按纠正后的朝向）。
//        双面照原材质；同一平面正反两组都烘了时两块都改单面（双面共面会互相 z-fighting）。四边形图元打 extras.satsimBake，
//        build.mjs 的去法线 / 简化 / 折痕法线一律跳过它们（lod2 的 Prune 会把整块四边形当零碎件删掉）。
//   图集贴图名 / URI 以 BAKE_TEX_PREFIX 开头：build.mjs 的通用贴图压缩跳过它们（这里已按目标尺寸出 WebP，不再二次有损 + 缩到 256）。
//
// 纯函数（rasterTri / packShelves / dominantAngle / linearToSrgb8 / perpPair）导出给单测（packages/core/test/modelLodBake.test.mjs）。

import { EXTTextureWebP } from '@gltf-transform/extensions'

export const BAKE_TEX_PREFIX = 'satsim_bake'
export const BAKE_DEFAULTS = Object.freeze({
  angleDeg: 2,            // 法线同组角度
  layerFrac: 0.001,       // 叠层容差（网格局部对角线的比例；SSL-1300 ≈ 2.5 cm）
  gridFrac: 0.004,        // 分区域的占用栅格（对角线的比例；SSL-1300 ≈ 10 cm，跨过 5 cm 板缝）
  minTris: 48,
  minExtentFrac: 0.02,    // 区域长边 ≥ 整件对角线的 2 %
  minComponents: 6,       // 单材质区域至少这么多互不相连的块才算「碎」
  ss: 2,                  // 每像素 ss × ss 个样本
  pad: 2                  // 区域四周留的像素（mip 防串色）
})
// 目标纹素：整件对角线 / texelsPerDiag（SSL-1300：lod1 ≈ 1 cm、lod2 ≈ 4 cm）；图集边长上限按档
export const BAKE_LOD = Object.freeze({
  lod1: Object.freeze({ texelsPerDiag: 2400, atlas: 2048 }),
  lod2: Object.freeze({ texelsPerDiag: 600, atlas: 512 })
})

// ─────────────────────────────── 小工具（纯函数） ───────────────────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** 线性 → sRGB 8 位（glTF 底色贴图按 sRGB 存） */
export function linearToSrgb8(c) {
  const v = clamp01(c)
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.round(s * 255)
}
const SRGB_LUT = new Float32Array(256)
for (let i = 0; i < 256; i++) { const s = i / 255; SRGB_LUT[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
/** sRGB 8 位 → 线性 */
export const srgb8ToLinear = (b) => SRGB_LUT[b & 255]

/** 与单位向量 n 垂直的一对单位向量（确定性：先取与 n 最不平行的坐标轴） */
export function perpPair(n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2])
  const t = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  const x = n[1] * t[2] - n[2] * t[1], y = n[2] * t[0] - n[0] * t[2], z = n[0] * t[1] - n[1] * t[0]
  const L = Math.hypot(x, y, z)
  const e1 = [x / L, y / L, z / L]
  const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]]
  return [e1, e2]
}

/** 4×4 列主序矩阵的平均轴缩放（区域尺寸 × 它 = 世界尺寸） */
export function matScale(m) {
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10])
  return (sx + sy + sz) / 3 || 1
}

/**
 * 边方向直方图（模 90°，1° 一格，按边长加权，邻格半权平滑）的峰：矩形板的边都贴着它或与它垂直。
 * edges：[du0, dv0, du1, dv1, …]（平面坐标里的边向量）。返回弧度 [0, π/2)。峰格附近 ±1.5° 内按边长加权均值细化。
 */
export function dominantAngle(edges) {
  const H = new Float64Array(90)
  const angOf = (du, dv) => (((Math.atan2(dv, du) * 180 / Math.PI) % 90) + 90) % 90
  for (let i = 0; i < edges.length; i += 2) {
    const L = Math.hypot(edges[i], edges[i + 1])
    if (L > 0) H[Math.min(89, Math.floor(angOf(edges[i], edges[i + 1])))] += L
  }
  let best = 0, bv = -1
  for (let k = 0; k < 90; k++) {
    const v = H[(k + 89) % 90] * 0.5 + H[k] + H[(k + 1) % 90] * 0.5
    if (v > bv) { bv = v; best = k }
  }
  let s = 0, w = 0
  for (let i = 0; i < edges.length; i += 2) {
    const L = Math.hypot(edges[i], edges[i + 1])
    if (!(L > 0)) continue
    let d = angOf(edges[i], edges[i + 1]) - (best + 0.5)
    if (d > 45) d -= 90; else if (d < -45) d += 90
    if (Math.abs(d) <= 1.5) { s += d * L; w += L }
  }
  const deg = best + 0.5 + (w > 0 ? s / w : 0)
  return (((deg % 90) + 90) % 90) * Math.PI / 180
}

/**
 * 货架装箱：rects = [{w, h}]（像素，含 pad），按高度降序逐行摆进宽 S 的图集。返回 {ok, W, H, pos:[{x,y}]}（ok = 宽高都不超过 S）。
 * 确定性（同高按宽、再按原下标）。
 */
export function packShelves(rects, S) {
  const order = rects.map((r, i) => i).sort((a, b) => rects[b].h - rects[a].h || rects[b].w - rects[a].w || a - b)
  const pos = new Array(rects.length)
  let x = 0, y = 0, rowH = 0, W = 0
  for (const i of order) {
    const r = rects[i]
    if (r.w > S) return { ok: false, W: 0, H: 0, pos }
    if (x + r.w > S) { y += rowH; x = 0; rowH = 0 }
    pos[i] = { x, y }
    x += r.w; rowH = Math.max(rowH, r.h); W = Math.max(W, x)
  }
  const H = y + rowH
  return { ok: H <= S, W, H, pos }
}

/**
 * 三角形光栅化（样本中心 (x+0.5, y+0.5)；含边——同一区域里后画的覆盖先画的，边界归谁不讲究）。
 * 每个覆盖样本调 put(index)（index = y·W + x）。返回覆盖样本数。坐标是样本空间。
 */
export function rasterTri(ax, ay, bx, by, cx, cy, W, H, put) {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  if (!(Math.abs(area) > 1e-12)) return 0
  const s = area > 0 ? 1 : -1
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)))
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)))
  const eps = -1e-9 * Math.abs(area)
  let n = 0
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5
      if (s * ((bx - px) * (cy - py) - (by - py) * (cx - px)) < eps) continue
      if (s * ((cx - px) * (ay - py) - (cy - py) * (ax - px)) < eps) continue
      if (s * ((ax - px) * (by - py) - (ay - py) * (bx - px)) < eps) continue
      put(y * W + x); n++
    }
  }
  return n
}

// ─────────────────────────────── 法线朝向纠正 ───────────────────────────────

/**
 * 原件法线与绕向相反的图元（面积多数表决）整图元翻法线（切线 w 同翻；新 accessor，原 accessor 可能被别的图元共用）。
 * 只看 TRIANGLES 且带 NORMAL 的图元；退化三角形不计。返回 {prims, flipped:[材质名]}。
 */
export function fixInvertedNormals(doc) {
  const out = { prims: 0, flipped: [] }
  const el = [0, 0, 0, 0]
  const buffer = doc.getRoot().listBuffers()[0]
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue
      const pos = prim.getAttribute('POSITION'), nor = prim.getAttribute('NORMAL')
      if (!pos || !nor) continue
      out.prims++
      const nv = pos.getCount()
      const P = new Float64Array(nv * 3), N = new Float64Array(nv * 3)
      for (let i = 0; i < nv; i++) {
        pos.getElement(i, el); P[3 * i] = el[0]; P[3 * i + 1] = el[1]; P[3 * i + 2] = el[2]
        nor.getElement(i, el); N[3 * i] = el[0]; N[3 * i + 1] = el[1]; N[3 * i + 2] = el[2]
      }
      const idx = prim.getIndices()
      const I = idx ? idx.getArray() : null
      const nf = Math.floor((I ? I.length : nv) / 3)
      let neg = 0, tot = 0
      for (let f = 0; f < nf; f++) {
        const a = I ? I[3 * f] : 3 * f, b = I ? I[3 * f + 1] : 3 * f + 1, c = I ? I[3 * f + 2] : 3 * f + 2
        const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2]
        const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2]
        const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
        const L = Math.hypot(x, y, z)
        if (!(L > 0)) continue
        const d = x * (N[3 * a] + N[3 * b] + N[3 * c]) + y * (N[3 * a + 1] + N[3 * b + 1] + N[3 * c + 1]) + z * (N[3 * a + 2] + N[3 * b + 2] + N[3 * c + 2])
        tot += L
        if (d < 0) neg += L
      }
      if (!(tot > 0) || neg <= 0.5 * tot) continue
      const dst = new Float32Array(nv * 3)
      for (let i = 0; i < nv * 3; i++) dst[i] = -N[i]
      const na = doc.createAccessor().setType('VEC3').setArray(dst)
      if (buffer) na.setBuffer(buffer)
      prim.setAttribute('NORMAL', na)
      const tan = prim.getAttribute('TANGENT')
      if (tan) {
        const T = new Float32Array(nv * 4)
        for (let i = 0; i < nv; i++) { tan.getElement(i, el); T[4 * i] = el[0]; T[4 * i + 1] = el[1]; T[4 * i + 2] = el[2]; T[4 * i + 3] = -el[3] }
        const ta = doc.createAccessor().setType('VEC4').setArray(T)
        if (buffer) ta.setBuffer(buffer)
        prim.setAttribute('TANGENT', ta)
      }
      const m = prim.getMaterial()
      out.flipped.push((m && m.getName()) || '（无材质）')
    }
  }
  return out
}

// ─────────────────────────────── 平面细节烘焙 ───────────────────────────────

/** 烘焙四边形图元（简化 / 去法线 / 折痕法线都跳过它） */
export const isBakePrim = (prim) => {
  const x = prim && typeof prim.getExtras === 'function' ? prim.getExtras() : null
  return !!(x && x.satsimBake)
}

/** 材质 → 取色器（线性 RGBA 系数 + 可选底色贴图像素 + 金属 / 粗糙 / 自发光）。贴图解码走 sharp（raw RGBA）。 */
async function materialSampler(mat, sharp) {
  const s = { base: [0.8, 0.8, 0.8, 1], metal: 0, rough: 1, tex: null, texCoord: 0, emissive: [0, 0, 0] }
  if (!mat) return s
  s.base = mat.getBaseColorFactor().slice()
  s.metal = mat.getMetallicFactor(); s.rough = mat.getRoughnessFactor()
  s.emissive = mat.getEmissiveFactor().slice()
  const t = mat.getBaseColorTexture()
  if (t && t.getImage()) {
    try {
      const { data, info } = await sharp(Buffer.from(t.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      s.tex = { data, w: info.width, h: info.height }
      const ti = mat.getBaseColorTextureInfo()
      s.texCoord = ti ? ti.getTexCoord() : 0
    } catch { s.tex = null }
  }
  return s
}

/** 贴图双线性取样（repeat 包裹），线性 RGB 写进 out[0..2] */
function sampleTex(tex, u, v, out) {
  const { data, w, h } = tex
  const x = (u - Math.floor(u)) * w - 0.5, y = (v - Math.floor(v)) * h - 0.5
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
  const X0 = ((x0 % w) + w) % w, X1 = ((x0 + 1) % w + w) % w, Y0 = ((y0 % h) + h) % h, Y1 = ((y0 + 1) % h + h) % h
  for (let c = 0; c < 3; c++) {
    const a = srgb8ToLinear(data[(Y0 * w + X0) * 4 + c]), b = srgb8ToLinear(data[(Y0 * w + X1) * 4 + c])
    const cc = srgb8ToLinear(data[(Y1 * w + X0) * 4 + c]), d = srgb8ToLinear(data[(Y1 * w + X1) * 4 + c])
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy
  }
  return out
}

/** 读一个 accessor 进 Float64Array（逐元素 getElement：反量化 / 归一化交给 gltf-transform） */
function readAcc(acc, comps) {
  const n = acc.getCount(), out = new Float64Array(n * comps), el = [0, 0, 0, 0]
  const k = acc.getElementSize()
  for (let i = 0; i < n; i++) { acc.getElement(i, el); for (let c = 0; c < comps; c++) out[comps * i + c] = c < k ? el[c] : 1 }
  return out
}

/**
 * 收集一个网格里可能要烘的区域（见文件头 ①–③）。返回 [{n, tris:[{pi, f}], …}]（tris 是该区域三角形的「图元号 + 面号」）。
 */
function findRegions(mesh, scale, Dw, C) {
  const prims = mesh.listPrimitives().filter((p) => p.getMode() === 4 && p.getIndices() && p.getAttribute('POSITION') && !isBakePrim(p))
  if (!prims.length) return null
  const PP = prims.map((p) => readAcc(p.getAttribute('POSITION'), 3))
  const II = prims.map((p) => p.getIndices().getArray())
  let nTri = 0
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let pi = 0; pi < prims.length; pi++) {
    nTri += Math.floor(II[pi].length / 3)
    const P = PP[pi]
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < lo[k]) lo[k] = P[i + k]; if (P[i + k] > hi[k]) hi[k] = P[i + k] }
  }
  const Dm = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  if (!(Dm > 0) || nTri < C.minTris) return null
  const tau = C.layerFrac * Dm, gBase = C.gridFrac * Dm
  const cosT = Math.cos(C.angleDeg * Math.PI / 180)
  // 逐三角形：图元号、面号、单位法线、面积
  const tP = new Int32Array(nTri), tF = new Int32Array(nTri), tN = new Float64Array(nTri * 3), tA = new Float64Array(nTri)
  let t = 0
  for (let pi = 0; pi < prims.length; pi++) {
    const P = PP[pi], I = II[pi]
    for (let f = 0; f < I.length / 3; f++, t++) {
      const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2]
      const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2]
      const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2]
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
      const L = Math.hypot(x, y, z)
      tP[t] = pi; tF[t] = f; tA[t] = L / 2
      if (L > 0) { tN[3 * t] = x / L; tN[3 * t + 1] = y / L; tN[3 * t + 2] = z / L }
    }
  }
  const vtx = (i, c) => { const P = PP[tP[i]], vi = II[tP[i]][3 * tF[i] + c]; return [P[3 * vi], P[3 * vi + 1], P[3 * vi + 2]] }
  // ① 法线聚类（哈希栅格 1/24 一格，查 27 邻格；大三角形先定代表方向）
  const order = []
  for (let i = 0; i < nTri; i++) if (tA[i] > 0) order.push(i)
  order.sort((a, b) => tA[b] - tA[a] || a - b)
  const reps = [], cellMap = new Map(), tCl = new Int32Array(nTri).fill(-1)
  const Q = 24
  const ckey = (x, y, z) => ((x + 64) * 256 + (y + 64)) * 256 + (z + 64)
  for (const i of order) {
    const nx = tN[3 * i], ny = tN[3 * i + 1], nz = tN[3 * i + 2]
    const gx = Math.round(nx * Q), gy = Math.round(ny * Q), gz = Math.round(nz * Q)
    let found = -1
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const L = cellMap.get(ckey(gx + dx, gy + dy, gz + dz))
      if (!L) continue
      for (const k of L) { const r = reps[k]; if (r[0] * nx + r[1] * ny + r[2] * nz >= cosT) { found = k; break } }
    }
    if (found < 0) {
      found = reps.length; reps.push([nx, ny, nz])
      const key = ckey(gx, gy, gz)
      if (!cellMap.has(key)) cellMap.set(key, [])
      cellMap.get(key).push(found)
    }
    tCl[i] = found
  }
  const byCl = new Map()
  for (const i of order) { const k = tCl[i]; if (!byCl.has(k)) byCl.set(k, []); byCl.get(k).push(i) }
  const out = []
  for (const [k, list] of byCl) {
    if (list.length < C.minTris) continue
    const n = reps[k]
    // 叠层：按偏移排序、间隔 > tau 断开
    const dOf = list.map((i) => { const p = vtx(i, 0); return n[0] * p[0] + n[1] * p[1] + n[2] * p[2] })
    const idx = list.map((_, j) => j).sort((a, b) => dOf[a] - dOf[b] || a - b)
    const stacks = []
    let cur = [idx[0]]
    for (let q = 1; q < idx.length; q++) {
      if (dOf[idx[q]] - dOf[idx[q - 1]] > tau) { stacks.push(cur); cur = [] }
      cur.push(idx[q])
    }
    stacks.push(cur)
    const [e1, e2] = perpPair(n)
    for (const st of stacks) {
      if (st.length < C.minTris) continue
      // ② 占用栅格分区域（三角形 2D 包围盒覆盖的格子；8 邻接并查集）。格子边长 = max(对角线 × gridFrac, 0.75 × 本叠层三角形的典型边长)：
      //    片与片之间的缝远小于片宽，没有同层底板垫着时（片直接浮在更低的底板上方、隔着层容差）也连得成一片
      const sz = st.map((q) => Math.sqrt(2 * tA[list[q]])).sort((a, b) => a - b)
      const g = Math.max(gBase, 0.75 * sz[sz.length >> 1])
      const cells = new Map(), parent = []
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
      const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b) }
      const KEY = (gx, gy) => (gx + 40000) * 80000 + (gy + 40000)
      const triCell = new Int32Array(st.length)
      for (let q = 0; q < st.length; q++) {
        const i = list[st[q]]
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
        for (let c = 0; c < 3; c++) {
          const p = vtx(i, c), u = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2], v = e2[0] * p[0] + e2[1] * p[1] + e2[2] * p[2]
          if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v
        }
        const gx0 = Math.floor(u0 / g), gx1 = Math.floor(u1 / g), gy0 = Math.floor(v0 / g), gy1 = Math.floor(v1 / g)
        let first = -1
        for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
          const key = KEY(gx, gy)
          let id = cells.get(key)
          if (id === undefined) { id = parent.length; parent.push(id); cells.set(key, id) }
          if (first < 0) first = id; else union(first, id)
        }
        triCell[q] = first
      }
      for (const [key, id] of cells) {
        const gx = Math.floor(key / 80000) - 40000, gy = (key % 80000) - 40000
        for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
          const nb = cells.get(KEY(gx + dx, gy + dy))
          if (nb !== undefined) union(id, nb)
        }
      }
      const groups = new Map()
      for (let q = 0; q < st.length; q++) { const r = find(triCell[q]); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(list[st[q]]) }
      for (const tris of groups.values()) {
        if (tris.length < C.minTris) continue
        // ③ 够不够碎、够不够大
        const mats = new Set()
        let blend = false
        for (const i of tris) { const m = prims[tP[i]].getMaterial(); mats.add(m); if (m && m.getAlphaMode() === 'BLEND') blend = true }
        if (blend) continue
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
        for (const i of tris) for (let c = 0; c < 3; c++) {
          const p = vtx(i, c), u = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2], v = e2[0] * p[0] + e2[1] * p[1] + e2[2] * p[2]
          if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v
        }
        if (Math.max(u1 - u0, v1 - v0) * scale < C.minExtentFrac * Dw) continue
        if (mats.size < 2) {
          // 单材质：数互不相连的块（同一图元里共用顶点号即相连）
          const par = new Map()
          const f2 = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x) } return x }
          for (const i of tris) {
            const I = II[tP[i]], base = tP[i] * 1e8
            const vs = [base + I[3 * tF[i]], base + I[3 * tF[i] + 1], base + I[3 * tF[i] + 2]]
            for (const v of vs) if (!par.has(v)) par.set(v, v)
            const r0 = f2(vs[0])
            for (let c = 1; c < 3; c++) { const r = f2(vs[c]); if (r !== r0) par.set(r, r0) }
          }
          const roots = new Set()
          for (const v of par.keys()) roots.add(f2(v))
          if (roots.size < C.minComponents) continue
        }
        out.push({ n, e1, e2, tris: tris.map((i) => ({ pi: tP[i], f: tF[i] })) })
      }
    }
  }
  return { prims, PP, II, Dm, regions: out }
}

/**
 * 低档平面细节烘焙（见文件头）。doc 原地改：烘掉的三角形从原图元删除（删空的图元 dispose），每个网格追加烘焙四边形图元。
 * o = { lod:'lod1'|'lod2', texelsPerDiag?, atlas?, …BAKE_DEFAULTS 覆盖 }
 * 返回 { regions, trisRemoved, atlas:{w,h}|null, mr:boolean, texel }（没有可烘区域时 regions = 0、文档不动）。
 */
export async function bakePlanarDetail(doc, F, sharp, o = {}) {
  const C = { ...BAKE_DEFAULTS, ...(BAKE_LOD[o.lod] || BAKE_LOD.lod1), ...o }
  const root = doc.getRoot()
  const scene = root.getDefaultScene() || root.listScenes()[0]
  const res = { regions: 0, trisRemoved: 0, atlas: null, mr: false, texel: 0 }
  if (!scene) return res
  const bw = F.getBounds(scene)
  const Dw = Math.hypot(bw.max[0] - bw.min[0], bw.max[1] - bw.min[1], bw.max[2] - bw.min[2])
  if (!(Dw > 0)) return res
  // 网格 → 世界尺度（取第一个引用它的节点；NASA 件几乎全是单位矩阵）
  const meshScale = new Map()
  scene.traverse((node) => { const m = node.getMesh(); if (m && !meshScale.has(m)) meshScale.set(m, matScale(node.getWorldMatrix())) })
  const cosT = Math.cos(C.angleDeg * Math.PI / 180)

  // —— ①–③ 找区域（跨网格汇总）
  const R = []
  for (const [mesh, scale] of meshScale) {
    const fr = findRegions(mesh, scale, Dw, C)
    if (!fr) continue
    for (const r of fr.regions) R.push({ ...r, mesh, scale, prims: fr.prims, PP: fr.PP, II: fr.II, Dm: fr.Dm })
  }
  if (!R.length) return res

  // —— ④ 区域平面系（主边方向）+ 外接矩形 + 每三角形层偏移
  for (const r of R) {
    const pt = (t, c) => { const P = r.PP[t.pi], vi = r.II[t.pi][3 * t.f + c]; return [P[3 * vi], P[3 * vi + 1], P[3 * vi + 2]] }
    const edges = new Float64Array(r.tris.length * 6)
    let k = 0
    for (const t of r.tris) {
      const uv = [0, 1, 2].map((c) => { const p = pt(t, c); return [r.e1[0] * p[0] + r.e1[1] * p[1] + r.e1[2] * p[2], r.e2[0] * p[0] + r.e2[1] * p[1] + r.e2[2] * p[2]] })
      for (let c = 0; c < 3; c++) { const a = uv[c], b = uv[(c + 1) % 3]; edges[k++] = b[0] - a[0]; edges[k++] = b[1] - a[1] }
    }
    const th = dominantAngle(edges), ct = Math.cos(th), sn = Math.sin(th), n = r.n
    const a = [r.e1[0] * ct + r.e2[0] * sn, r.e1[1] * ct + r.e2[1] * sn, r.e1[2] * ct + r.e2[2] * sn]
    const b = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]]
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, dTop = -Infinity
    // 每个三角形 3 个顶点的平面坐标（u, v）与平均层偏移
    const U = new Float64Array(r.tris.length * 3), V = new Float64Array(r.tris.length * 3), D = new Float64Array(r.tris.length)
    r.tris.forEach((t, q) => {
      let ds = 0
      for (let c = 0; c < 3; c++) {
        const p = pt(t, c), u = a[0] * p[0] + a[1] * p[1] + a[2] * p[2], v = b[0] * p[0] + b[1] * p[1] + b[2] * p[2]
        U[3 * q + c] = u; V[3 * q + c] = v
        if (u < a0) a0 = u; if (u > a1) a1 = u; if (v < b0) b0 = v; if (v > b1) b1 = v
        ds += n[0] * p[0] + n[1] * p[1] + n[2] * p[2]
      }
      D[q] = ds / 3
      if (D[q] > dTop) dTop = D[q]
    })
    Object.assign(r, { a, b, a0, a1, b0, b1, dTop, U, V, D, single: false })
  }
  // 同一平面正反两组都烘：两块改单面（见文件头）
  for (let i = 0; i < R.length; i++) {
    for (let j = i + 1; j < R.length; j++) {
      const A = R[i], B = R[j]
      if (A.mesh !== B.mesh || A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2] > -cosT) continue
      if (Math.abs(A.dTop + B.dTop) > 0.005 * A.Dm) continue
      A.single = true; B.single = true
    }
  }

  // —— 图集装箱：统一纹素密度 rho（世界单位 → 像素） = min(目标, 装得下的最大值)
  const S = C.atlas, pad = C.pad, ss = C.ss
  const rectsAt = (rho) => R.map((r) => ({ w: Math.max(4, Math.ceil((r.a1 - r.a0) * r.scale * rho)) + 2 * pad, h: Math.max(4, Math.ceil((r.b1 - r.b0) * r.scale * rho)) + 2 * pad }))
  let rho = C.texelsPerDiag / Dw
  let pk = packShelves(rectsAt(rho), S)
  if (!pk.ok) {
    let lo = 0, hi = rho
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (packShelves(rectsAt(mid), S).ok) lo = mid; else hi = mid }
    rho = lo
    pk = packShelves(rectsAt(rho), S)
    if (!(rho > 0) || !pk.ok) return res
  }
  const rects = rectsAt(rho)
  const AW = Math.max(4, Math.ceil(pk.W / 4) * 4), AH = Math.max(4, Math.ceil(pk.H / 4) * 4)

  // —— ⑤ 光栅化
  const samplers = new Map()
  for (const r of R) for (const t of r.tris) { const m = r.prims[t.pi].getMaterial(); if (!samplers.has(m)) samplers.set(m, await materialSampler(m, sharp)) }
  // 顶点色 / 贴图坐标（只给需要的图元读一次）
  const extra = new Map()
  const extraOf = (prims, pi) => {
    const p = prims[pi]
    if (extra.has(p)) return extra.get(p)
    const ms = samplers.get(p.getMaterial())
    const uv = ms && ms.tex ? p.getAttribute(`TEXCOORD_${ms.texCoord}`) : null
    const col = p.getAttribute('COLOR_0')
    const e = { UV: uv ? readAcc(uv, 2) : null, COL: col ? readAcc(col, 4) : null }
    extra.set(p, e)
    return e
  }
  const col = new Float32Array(AW * AH * 3), alp = new Float32Array(AW * AH), met = new Float32Array(AW * AH), rgh = new Float32Array(AW * AH)
  const tmp = [0, 0, 0]
  let mMin = Infinity, mMax = -Infinity, rMin = Infinity, rMax = -Infinity
  for (let ri = 0; ri < R.length; ri++) {
    const r = R[ri], rect = rects[ri], at = pk.pos[ri]
    const k = r.scale * rho                       // 局部单位 → 像素
    const W = rect.w * ss, H = rect.h * ss
    const buf = new Int32Array(W * H).fill(-1)
    const SX = new Float64Array(r.tris.length * 3), SY = new Float64Array(r.tris.length * 3)
    for (let q = 0; q < r.tris.length; q++) for (let c = 0; c < 3; c++) {
      SX[3 * q + c] = (pad + (r.U[3 * q + c] - r.a0) * k) * ss
      SY[3 * q + c] = (pad + (r.V[3 * q + c] - r.b0) * k) * ss
    }
    // 低层先画、上层覆盖（同层按原顺序）
    const ord = r.tris.map((_, q) => q).sort((p, q) => r.D[p] - r.D[q] || p - q)
    for (const q of ord) rasterTri(SX[3 * q], SY[3 * q], SX[3 * q + 1], SY[3 * q + 1], SX[3 * q + 2], SY[3 * q + 2], W, H, (s) => { buf[s] = q })
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        let cr = 0, cg = 0, cb = 0, n = 0, mm = 0, rr = 0
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
          const q = buf[(y * ss + sy) * W + x * ss + sx]
          if (q < 0) continue
          const t = r.tris[q], prim = r.prims[t.pi], ms = samplers.get(prim.getMaterial())
          let R0 = ms.base[0], G0 = ms.base[1], B0 = ms.base[2]
          const ex = (ms.tex || prim.getAttribute('COLOR_0')) ? extraOf(r.prims, t.pi) : null
          if (ex && ((ms.tex && ex.UV) || ex.COL)) {
            // 样本处的重心坐标（样本空间）
            const px = x * ss + sx + 0.5, py = y * ss + sy + 0.5
            const x0 = SX[3 * q], y0 = SY[3 * q], x1 = SX[3 * q + 1], y1 = SY[3 * q + 1], x2 = SX[3 * q + 2], y2 = SY[3 * q + 2]
            const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
            let l0 = den ? ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den : 1 / 3
            let l1 = den ? ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den : 1 / 3
            l0 = clamp01(l0); l1 = clamp01(l1)
            const l2 = Math.max(0, 1 - l0 - l1)
            const I = r.II[t.pi], v0 = I[3 * t.f], v1 = I[3 * t.f + 1], v2 = I[3 * t.f + 2]
            if (ms.tex && ex.UV) {
              const U2 = ex.UV
              sampleTex(ms.tex, U2[2 * v0] * l0 + U2[2 * v1] * l1 + U2[2 * v2] * l2, U2[2 * v0 + 1] * l0 + U2[2 * v1 + 1] * l1 + U2[2 * v2 + 1] * l2, tmp)
              R0 *= tmp[0]; G0 *= tmp[1]; B0 *= tmp[2]
            }
            if (ex.COL) {
              const A = ex.COL
              R0 *= A[4 * v0] * l0 + A[4 * v1] * l1 + A[4 * v2] * l2
              G0 *= A[4 * v0 + 1] * l0 + A[4 * v1 + 1] * l1 + A[4 * v2 + 1] * l2
              B0 *= A[4 * v0 + 2] * l0 + A[4 * v1 + 2] * l1 + A[4 * v2 + 2] * l2
            }
          }
          cr += R0 + ms.emissive[0]; cg += G0 + ms.emissive[1]; cb += B0 + ms.emissive[2]
          mm += ms.metal; rr += ms.rough; n++
        }
        if (!n) continue
        const o2 = (at.y + y) * AW + at.x + x
        col[3 * o2] = cr / n; col[3 * o2 + 1] = cg / n; col[3 * o2 + 2] = cb / n
        alp[o2] = n / (ss * ss); met[o2] = mm / n; rgh[o2] = rr / n
      }
    }
    for (const t of r.tris) {
      const ms = samplers.get(r.prims[t.pi].getMaterial())
      if (ms.metal < mMin) mMin = ms.metal; if (ms.metal > mMax) mMax = ms.metal
      if (ms.rough < rMin) rMin = ms.rough; if (ms.rough > rMax) rMax = ms.rough
    }
    dilate(col, alp, met, rgh, AW, at.x, at.y, rect.w, rect.h, pad + 4)
  }

  // —— 写图集（WebP；alpha 无损）
  const rgba = new Uint8Array(AW * AH * 4)
  for (let o2 = 0; o2 < AW * AH; o2++) {
    rgba[4 * o2] = linearToSrgb8(col[3 * o2]); rgba[4 * o2 + 1] = linearToSrgb8(col[3 * o2 + 1]); rgba[4 * o2 + 2] = linearToSrgb8(col[3 * o2 + 2])
    rgba[4 * o2 + 3] = Math.round(clamp01(alp[o2]) * 255)
  }
  const tag = o.lod || 'lod'
  const webp = await sharp(Buffer.from(rgba.buffer), { raw: { width: AW, height: AH, channels: 4 } }).webp({ quality: 92, alphaQuality: 100, effort: 4 }).toBuffer()
  doc.createExtension(EXTTextureWebP).setRequired(true)
  const tex = doc.createTexture(`${BAKE_TEX_PREFIX}_${tag}`).setImage(new Uint8Array(webp)).setMimeType('image/webp').setURI(`${BAKE_TEX_PREFIX}_${tag}.webp`)
  let mrTex = null
  if (mMax - mMin > 0.05 || rMax - rMin > 0.05) {
    const mr = new Uint8Array(AW * AH * 4)
    for (let o2 = 0; o2 < AW * AH; o2++) { mr[4 * o2] = 255; mr[4 * o2 + 1] = Math.round(clamp01(rgh[o2]) * 255); mr[4 * o2 + 2] = Math.round(clamp01(met[o2]) * 255); mr[4 * o2 + 3] = 255 }
    const mw = await sharp(Buffer.from(mr.buffer), { raw: { width: AW, height: AH, channels: 4 } }).webp({ quality: 90, effort: 4 }).toBuffer()
    mrTex = doc.createTexture(`${BAKE_TEX_PREFIX}_${tag}_mr`).setImage(new Uint8Array(mw)).setMimeType('image/webp').setURI(`${BAKE_TEX_PREFIX}_${tag}_mr.webp`)
  }
  let sm = 0, sr = 0, sn = 0
  for (let o2 = 0; o2 < AW * AH; o2++) if (alp[o2] > 0) { sm += met[o2]; sr += rgh[o2]; sn++ }
  const mats = new Map()
  const matFor = (ds) => {
    if (mats.has(ds)) return mats.get(ds)
    const m = doc.createMaterial(`${BAKE_TEX_PREFIX}_${tag}_${ds ? 'ds' : 'ss'}`).setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(tex)
      .setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(ds)
    if (mrTex) m.setMetallicRoughnessTexture(mrTex).setMetallicFactor(1).setRoughnessFactor(1)
    else m.setMetallicFactor(sn ? sm / sn : 0).setRoughnessFactor(sn ? sr / sn : 1)
    mats.set(ds, m)
    return m
  }

  // —— ⑥ 删原三角形 + 追加四边形
  const buffer = root.listBuffers()[0]
  const removeByPrim = new Map(), quadsByMesh = new Map()
  for (let ri = 0; ri < R.length; ri++) {
    const r = R[ri], at = pk.pos[ri], k = r.scale * rho
    let ds = false
    for (const t of r.tris) {
      const p = r.prims[t.pi]
      if (!removeByPrim.has(p)) removeByPrim.set(p, new Set())
      removeByPrim.get(p).add(t.f)
      const m = p.getMaterial()
      if (m && m.getDoubleSided()) ds = true
    }
    if (r.single) ds = false
    const corner = (u, v) => [0, 1, 2].map((c) => r.n[c] * r.dTop + r.a[c] * u + r.b[c] * v)
    const uvOf = (u, v) => [(at.x + pad + (u - r.a0) * k) / AW, (at.y + pad + (v - r.b0) * k) / AH]
    const q = { ds, n: r.n, P: [corner(r.a0, r.b0), corner(r.a1, r.b0), corner(r.a1, r.b1), corner(r.a0, r.b1)], UV: [uvOf(r.a0, r.b0), uvOf(r.a1, r.b0), uvOf(r.a1, r.b1), uvOf(r.a0, r.b1)] }
    if (!quadsByMesh.has(r.mesh)) quadsByMesh.set(r.mesh, [])
    quadsByMesh.get(r.mesh).push(q)
    res.regions++
    res.trisRemoved += r.tris.length
  }
  for (const [p, faces] of removeByPrim) {
    const I = p.getIndices().getArray()
    const keep = []
    for (let f = 0; f < I.length / 3; f++) if (!faces.has(f)) keep.push(I[3 * f], I[3 * f + 1], I[3 * f + 2])
    if (!keep.length) { p.dispose(); continue }
    const nv = p.getAttribute('POSITION').getCount()
    const acc = doc.createAccessor().setType('SCALAR').setArray(nv > 65535 ? Uint32Array.from(keep) : Uint16Array.from(keep))
    if (buffer) acc.setBuffer(buffer)
    p.setIndices(acc)
    F.compactPrimitive(p)
  }
  const mk = (type, arr) => { const a = doc.createAccessor().setType(type).setArray(arr); if (buffer) a.setBuffer(buffer); return a }
  for (const [mesh, qs] of quadsByMesh) {
    for (const ds of [true, false]) {
      const L = qs.filter((q) => q.ds === ds)
      if (!L.length) continue
      const P = new Float32Array(L.length * 12), N = new Float32Array(L.length * 12), T = new Float32Array(L.length * 8), I = new Uint16Array(L.length * 6)
      L.forEach((q, j) => {
        for (let c = 0; c < 4; c++) { P.set(q.P[c], (4 * j + c) * 3); N.set(q.n, (4 * j + c) * 3); T.set(q.UV[c], (4 * j + c) * 2) }
        I.set([4 * j, 4 * j + 1, 4 * j + 2, 4 * j, 4 * j + 2, 4 * j + 3], 6 * j)
      })
      mesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', mk('VEC3', P)).setAttribute('NORMAL', mk('VEC3', N)).setAttribute('TEXCOORD_0', mk('VEC2', T))
        .setIndices(mk('SCALAR', I)).setMaterial(matFor(ds)).setExtras({ satsimBake: true }))
    }
  }
  res.atlas = { w: AW, h: AH }
  res.mr = !!mrTex
  res.texel = 1 / rho
  return res
}

/** 区域矩形内的空像素按 8 邻域均值扩张 iters 轮（颜色 / 金属 / 粗糙一起；alpha 不动） */
function dilate(col, alp, met, rgh, AW, x0, y0, w, h, iters) {
  const filled = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alp[(y0 + y) * AW + x0 + x] > 0) filled[y * w + x] = 1
  for (let it = 0; it < iters; it++) {
    const add = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (filled[y * w + x]) continue
        let r = 0, g = 0, b = 0, m = 0, rr = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !filled[yy * w + xx]) continue
          const o = (y0 + yy) * AW + x0 + xx
          r += col[3 * o]; g += col[3 * o + 1]; b += col[3 * o + 2]; m += met[o]; rr += rgh[o]; n++
        }
        if (n) add.push(x, y, r / n, g / n, b / n, m / n, rr / n)
      }
    }
    if (!add.length) break
    for (let i = 0; i < add.length; i += 7) {
      const x = add[i], y = add[i + 1], o = (y0 + y) * AW + x0 + x
      col[3 * o] = add[i + 2]; col[3 * o + 1] = add[i + 3]; col[3 * o + 2] = add[i + 4]; met[o] = add[i + 5]; rgh[o] = add[i + 6]
      filled[y * w + x] = 1
    }
  }
}
