// OBJ(+MTL) / STL / FBX → three Object3D（渲染端解析；glb / glTF 走 loader.js，STEP / IGES / BREP 走主进程 occt）。
//
// 字节从哪来：主进程 models:readFile 读好经 IPC 传 Uint8Array（DESIGN §4）。不拿 file:// URL —— dev 页在 http://localhost，
// Chromium 拒载本地文件，打包版却能载，会形成两种行为（deps 报告 §2.1）。.mtl 与贴图这些「旁车」按同目录文件名再读：
// 调用方给 readSibling(相对名) → Uint8Array|null；贴图字节转 blob: URL，经 LoadingManager.setURLModifier 喂给 three 的加载器。
//
// 统一出口：
//   · 材质一律转成 MeshStandardMaterial（MTL / FBX 给的是 Phong / Lambert：它们不吃 scene.environment 的 PMREM 环境，
//     放在影棚里是一块发灰的塑料）。Kd → color，map_Kd → map，Ns → roughness ≈ √(2 / (Ns + 2))（Blinn-Phong ↔ GGX 的
//     常用换算），Ks 很亮且偏彩色的当金属。STL 没有材质：与「没有材质」同一条路，给中性浅灰（带顶点色的给白底让顶点色原样显出来）。
//   · 删掉文件自带的相机与灯光（FBX 常带环境光 / 点光源，会污染影棚光照）。
//   · 材质兜底（materials.js，与离线管线 build.mjs 同口径）：没有材质的（OBJ 没 .mtl 或 .mtl 里没这个名字、FBX 的 __DEFAULT）
//     换成共用的中性浅灰；退化黑（底色近黑、不反射）占整件一半以上或名字是电池片正面时按名字还原。计数进返回的 materialFallback。
//   · 单位只给「提示」（unitHint），不在这里缩放：OBJ 按文件头注释（Maya 写 centimeters、3ds Max 默认英寸，
//     规则在 packages/core/models/units.mjs 的 objHeaderUnit）；FBX 读 GlobalSettings.UnitScaleFactor（每单位多少厘米）；
//     STL 没有单位信息，'unknown'（交给 units.mjs 的包围盒规则与用户的已知尺寸反算）。
//   · 根节点打 userData.__sceneRoot（exporter 导出时摊平，不多套一层）；每个节点 userData.name = 原名（与 glb 同一口径）。
import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { objHeaderUnit } from '@core/models/units.mjs'
import { hoistAndDrop } from './loader.js'
import { neutralMaterial, applyDegenerateFallback } from './materials.js'

export const IMPORT_FORMATS = ['obj', 'stl', 'fbx']

const baseName = (s) => String(s || '').split(/[\\/]/).pop()
const stem = (s) => baseName(s).replace(/\.[^.]+$/, '')
const extOf = (s) => { const m = /\.([^.\\/]+)$/.exec(String(s || '')); return m ? m[1].toLowerCase() : '' }
const u8buf = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer)
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif', tga: 'image/x-tga' }

// Phong / Lambert / Basic → Standard（保留贴图对象，不重复上传）。
// 调用方按「旧材质 → 新材质」缓存：OBJ 的 MaterialCreator 让所有 usemtl 同名的对象共用一个 Phong 材质，
// 逐网格各转一份的话 20 个对象就是 20 个互不相同的材质 —— 材质分组（segment §5.4②）分出 20 组、导出件里 20 份重复材质，
// 原材质还被 dispose 20 次。
function toStandard(m) {
  if (!m || m.isMeshStandardMaterial) return m
  const p = {
    name: m.name || '',
    color: m.color ? m.color.clone() : new THREE.Color(0.7, 0.7, 0.7),
    map: m.map || null, normalMap: m.normalMap || null, alphaMap: m.alphaMap || null, aoMap: m.aoMap || null,
    emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0, 0, 0), emissiveMap: m.emissiveMap || null,
    transparent: !!m.transparent, opacity: m.opacity != null ? m.opacity : 1,
    side: m.side, vertexColors: !!m.vertexColors, flatShading: !!m.flatShading,
    metalness: 0, roughness: 0.7
  }
  if (m.bumpMap) { p.bumpMap = m.bumpMap; p.bumpScale = m.bumpScale }
  if (m.isMeshPhongMaterial) {
    const ns = Number.isFinite(m.shininess) ? m.shininess : 30
    p.roughness = Math.min(1, Math.max(0.04, Math.sqrt(2 / (ns + 2))))
    // 高光色很亮、且有颜色（不是白 / 灰）→ 金属（MTL 里给金属就是这么写的：Kd 暗、Ks 带色）
    const s = m.specular
    if (s) {
      const mx = Math.max(s.r, s.g, s.b), mn = Math.min(s.r, s.g, s.b)
      if (mx > 0.5 && mx - mn > 0.15) { p.metalness = 0.9; p.color = s.clone() }
    }
  }
  if (p.map) p.map.colorSpace = THREE.SRGBColorSpace
  const out = new THREE.MeshStandardMaterial(p)
  m.dispose()
  return out
}

function finish(root, name) {
  const drop = []
  let tris = 0, noMaterial = 0
  const conv = new Map()   // 旧材质 → 新材质（每个旧材质只转一次、只 dispose 一次）
  let neutral = null, neutralVc = null
  // 没有材质（导入器标了 __noMaterial，或根本没给）→ 中性浅灰（带顶点色的另给一份白底的，让顶点色原样显出来）
  const fallback = (m, vc) => {
    noMaterial++
    if (m && m.dispose && !conv.has(m)) { conv.set(m, null); m.dispose() }
    if (vc) return neutralVc || (neutralVc = neutralMaterial({ vertexColors: true }))
    return neutral || (neutral = neutralMaterial())
  }
  const std = (m, vc) => {
    if (!m || (m.userData && m.userData.__noMaterial)) return fallback(m, vc)
    let n = conv.get(m); if (!n) { n = toStandard(m); conv.set(m, n) } return n
  }
  root.traverse((o) => {
    if (o !== root && (o.isCamera || o.isLight)) { drop.push(o); return }
    if (typeof o.userData.name !== 'string') o.userData.name = o.name || ''
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true
      const vc = !!(o.geometry && o.geometry.attributes.color)
      o.material = Array.isArray(o.material) ? o.material.map((m) => std(m, vc)) : std(o.material, vc)
      const g = o.geometry
      if (g && !g.attributes.normal && g.attributes.position) g.computeVertexNormals()
      if (g && g.attributes.position) tris += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3)
      if (g) { g.computeBoundingBox(); g.computeBoundingSphere() }
    }
  })
  // 相机 / 灯光节点上挂着的子节点（FBX 偶见：灯下挂着灯罩网格）提给父节点，并把相机 / 灯自身的变换乘进去，位置不跳
  hoistAndDrop(drop)
  root.name = root.name || stem(name)
  root.userData.__sceneRoot = true
  const deg = applyDegenerateFallback(root)
  return { tris, materialFallback: { noMaterialMeshes: noMaterial, degenerate: deg } }
}

// 贴图旁车：先把 MTL / 调用方点名的文件读成 blob: URL，加载器按文件名（不分大小写、不看目录）命中
async function sidecarManager(names, readSibling) {
  const urls = new Map(), made = []
  for (const n of names) {
    const key = baseName(n).toLowerCase()
    if (!key || urls.has(key)) continue
    let bytes = null
    try { bytes = readSibling ? await readSibling(n) : null } catch { bytes = null }
    if (!bytes) continue
    const u = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(n)] || 'application/octet-stream' }))
    urls.set(key, u); made.push(u)
  }
  const mgr = new THREE.LoadingManager()
  const missing = new Set()
  mgr.setURLModifier((url) => {
    if (/^(blob:|data:)/.test(url)) return url
    const hit = urls.get(baseName(decodeURIComponent(url)).toLowerCase())
    if (hit) return hit
    missing.add(baseName(url))
    return 'data:,'   // 找不到的贴图给个空地址：加载器报错走 onError，不会去网络上乱找
  })
  const done = new Promise((res) => { mgr.onLoad = res; setTimeout(res, 8000) })   // 贴图全到（或 8 s 兜底）再回收 blob
  return { mgr, missing, cleanup: async () => { await done; for (const u of made) URL.revokeObjectURL(u) } }
}

async function importObj(bytes, name, readSibling, warnings) {
  const text = new TextDecoder('utf-8').decode(bytes)
  const unitHint = objHeaderUnit(text) || 'unknown'
  const mtlNames = []
  for (const m of text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)) mtlNames.push(m[1])
  const loader = new OBJLoader()
  let side = null
  if (mtlNames.length) {
    const mtlTexts = []
    for (const n of mtlNames) {
      let b = null
      try { b = readSibling ? await readSibling(n) : null } catch { b = null }
      if (b) mtlTexts.push(new TextDecoder('utf-8').decode(b)); else warnings.push('缺材质库 ' + baseName(n))
    }
    if (mtlTexts.length) {
      const texNames = []
      for (const t of mtlTexts) for (const m of t.matchAll(/^\s*(?:map_Kd|map_Ka|map_Ks|map_d|map_bump|bump|norm|map_Bump)\s+(?:-\S+\s+\S+\s+)*(.+?)\s*$/gim)) texNames.push(m[1])
      side = await sidecarManager(texNames, readSibling)
      const mtl = new MTLLoader(side.mgr)
      const creators = mtlTexts.map((t) => mtl.parse(t, ''))
      // 多个 mtllib：合并成一个 MaterialCreator 的材质表
      const mc = creators[0]
      for (const c of creators.slice(1)) Object.assign(mc.materialsInfo, c.materialsInfo)
      mc.preload()
      loader.setMaterials(mc)
    }
  }
  const root = loader.parse(text)
  // OBJLoader 对「没有 .mtl / .mtl 里没定义这个名字」的 usemtl 现造一个默认 Phong（纯白、无贴图）：标成「没有材质」，finish 换中性灰
  const known = new Set()
  if (loader.materials && loader.materials.materialsInfo) for (const k of Object.keys(loader.materials.materialsInfo)) known.add(k)
  root.traverse((o) => {
    if (!o.isMesh) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && m.isMeshPhongMaterial && !known.has(m.name)) m.userData.__noMaterial = true
  })
  if (side) { side.cleanup(); if (side.missing.size) warnings.push('缺贴图 ' + [...side.missing].slice(0, 5).join('、')) }
  return { root, unitHint }
}

function importStl(bytes, name) {
  const geom = new STLLoader().parse(u8buf(bytes))
  // STL 本身没有材质：标成「没有材质」，finish 换成与 OBJ / FBX / 离线管线同一份的中性浅灰（线性 0.8、金属 0、粗糙 0.6、双面）
  const mat = new THREE.MeshStandardMaterial({ name: 'stl' })
  mat.userData.__noMaterial = true
  const mesh = new THREE.Mesh(geom, mat)
  mesh.name = stem(name)
  const root = new THREE.Group()
  root.name = stem(name)
  root.add(mesh)
  return { root, unitHint: 'unknown' }
}

async function importFbx(bytes, name, readSibling, warnings) {
  // FBX 的外部贴图名要解析完才知道；这里不预读，只接住内嵌贴图（二进制 FBX 多为内嵌），外部的记缺
  const side = await sidecarManager([], readSibling)
  const root = new FBXLoader(side.mgr).parse(u8buf(bytes), '')
  // FBX 里没有材质的网格：FBXLoader 给名为 __DEFAULT 的灰 Phong（THREE.Loader.DEFAULT_MATERIAL_NAME）→ 标成「没有材质」
  root.traverse((o) => {
    if (!o.isMesh) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && m.name === THREE.Loader.DEFAULT_MATERIAL_NAME) m.userData.__noMaterial = true
  })
  side.cleanup().then(() => { if (side.missing.size) console.info('[models] FBX 缺贴图：' + [...side.missing].join('、')) })
  const usf = Number(root.userData && root.userData.unitScaleFactor)
  // UnitScaleFactor = 每单位多少厘米：1 → cm（FBX 出厂）、100 → m、0.1 → mm、2.54 → in、30.48 → ft
  let unitHint = 'unknown'
  if (Number.isFinite(usf) && usf > 0) {
    const table = [[1, 'cm'], [100, 'm'], [0.1, 'mm'], [2.54, 'in'], [30.48, 'ft']]
    for (const [v, u] of table) if (Math.abs(usf / v - 1) < 0.01) unitHint = u
  }
  if (side.missing.size) warnings.push('缺贴图 ' + [...side.missing].slice(0, 5).join('、'))
  return { root, unitHint, fbxUnitScaleFactor: Number.isFinite(usf) ? usf : null }
}

/**
 * 解析一个 OBJ / STL / FBX 文件。
 * @param {{bytes:Uint8Array, name:string}} file
 * @param {{readSibling?:(relName:string)=>Promise<Uint8Array|null>}} [o]
 * @returns {Promise<{root:THREE.Object3D, format:string, unitHint:string, fbxUnitScaleFactor?:number|null, tris:number, ms:number, warnings:string[],
 *   materialFallback:{noMaterialMeshes:number, degenerate:{share:number, fixed:string[]}}}>}
 *   失败抛 Error（message 只是状态，界面直接显示）
 */
export async function importFile(file, o = {}) {
  const t0 = performance.now()
  const fmt = extOf(file && file.name)
  if (!IMPORT_FORMATS.includes(fmt)) throw new Error('不支持的格式：' + (fmt || '未知'))
  if (!file.bytes || !file.bytes.byteLength) throw new Error('文件为空。')
  const warnings = []
  let r
  try {
    if (fmt === 'obj') r = await importObj(file.bytes, file.name, o.readSibling, warnings)
    else if (fmt === 'stl') r = importStl(file.bytes, file.name)
    else r = await importFbx(file.bytes, file.name, o.readSibling, warnings)
  } catch (e) {
    throw new Error((fmt.toUpperCase()) + ' 解析失败：' + ((e && e.message) || e))
  }
  const fin = finish(r.root, file.name)
  if (!fin.tris) throw new Error('文件里没有三角形。')
  return { root: r.root, format: fmt, unitHint: r.unitHint, fbxUnitScaleFactor: r.fbxUnitScaleFactor, tris: fin.tris, ms: Math.round(performance.now() - t0), warnings, materialFallback: fin.materialFallback }
}
