// OBJ(+MTL) / STL / FBX → three Object3D（渲染端解析；glb / glTF 走 loader.js，STEP / IGES / BREP 走主进程 occt）。
//
// 字节从哪来：主进程 models:readFile 读好经 IPC 传 Uint8Array（DESIGN §4）。不拿 file:// URL —— dev 页在 http://localhost，
// Chromium 拒载本地文件，打包版却能载，会形成两种行为（deps 报告 §2.1）。.mtl 与贴图这些「旁车」按同目录文件名再读：
// 调用方给 readSibling(相对名) → Uint8Array|null；贴图由挂在 LoadingManager 上的旁车加载器按名字现读、转 blob: URL 解码
// （sidecarManager），导入器返回前等它们全部落定，落定后仍没有图像的贴图从材质上摘掉并记告警（settleTextures）。
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

// 贴图落定的封顶：按「多久没有一张落定」算，不按总时长 —— 大件几十张贴图陆续到不会被误砍；只防 IPC / 解码卡死
// 把整个导入队列一起挂住（正常整批几十到几百毫秒）
const TEX_SETTLE_MS = 60000
const isInline = (u) => /^(blob|data):/i.test(u)

// 贴图旁车（MTLLoader / FBXLoader 共用）。两家取每张贴图之前都先问 manager.getHandler(名字)：这里挂一个「按名字去模型所在目录
// 读字节」的加载器。字节经 IPC 异步到手，所以 load() 先回一张空贴图（three 的 TextureLoader 也是先回空壳），读到 → blob: URL →
// 解码完再把 image 填进去；导入器返回前由 settleTextures 等它们全部落定 —— 以前不等就返回，wbStore 紧接着导出 glb，
// image 还是 null，GLTFExporter 整件抛「No valid image data found」，带贴图的 OBJ / FBX 一律入不了库。
//   · 名字先按原样读（.mtl 里写的相对路径），读不到再按文件名在同目录找：3ds Max 的 .mtl 常写绝对路径；
//     FBX 的外部贴图（FBXLoader 只给文件名）也走这一条 —— 以前一律记缺
//   · 同一文件只读一次、只解码一次，各贴图共用同一个 image：几个材质共用一张图集时导出件里也只有一份图（GLTFExporter 按 image 去重）
//   · FBX 内嵌贴图是 FBXLoader 现造的 blob: / data: URL，原样解码
//   · blob:（我们造的，和 FBXLoader 造了不管回收的）一解码完就撤 —— 图已到手，撤了不影响（GLTFLoader 也是载完即撤）；
//     卡住没回来的那张本来就没造 blob:，不会漏
//   · 只经 readSibling 取字节：不出网、不碰模型目录以外的文件（兜底的 URL 修饰器把漏网的普通地址一律换成空地址）
function sidecarManager(readSibling) {
  const mgr = new THREE.LoadingManager()
  mgr.setURLModifier((url) => (isInline(url) ? url : 'data:,'))
  const images = new THREE.ImageLoader(mgr)
  const sources = new Map()     // 'f:' 规范化文件名 / 'u:' 内嵌 URL → Promise<{url, own, jpeg}|null>
  const info = new WeakMap()    // 贴图 → {ref, why?: 'missing' | 'bad', jpeg?: boolean}
  const pending = []
  const once = (key, make) => { if (!sources.has(key)) sources.set(key, make()); return sources.get(key) }
  const fileSrc = (name) => once('f:' + name.replace(/\\/g, '/').toLowerCase(), async () => {
    let b = null
    try { b = readSibling ? await readSibling(name) : null } catch { b = null }
    if (!b || !b.byteLength) return null
    const url = URL.createObjectURL(new Blob([b], { type: MIME[extOf(name)] || 'application/octet-stream' }))
    return { url, own: true, jpeg: b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }
  })
  const inlineSrc = (ref) => once('u:' + ref, async () => {
    if (/^data:/i.test(ref)) return { url: ref, own: false, jpeg: /^data:image\/jpe?g[;,]/i.test(ref) }
    let jpeg = false
    try { jpeg = (await (await fetch(ref)).blob()).type === 'image/jpeg' } catch { /* 只影响导出时的编码 */ }
    return { url: ref, own: true, jpeg }
  })
  const decode = (src) => src.img || (src.img = new Promise((res) => images.load(src.url, res, undefined, () => res(null)))
    .then((img) => { if (src.own) URL.revokeObjectURL(src.url); return img }))
  async function fill(tex, rec) {
    const ref = rec.ref
    const src = isInline(ref) ? await inlineSrc(ref)
      : ref ? (await fileSrc(ref)) || (/[\\/]/.test(ref) ? await fileSrc(baseName(ref)) : null) : null
    if (!src) { rec.why = 'missing'; return }
    const img = await decode(src)
    if (!img) { rec.why = 'bad'; return }
    tex.image = img
    tex.needsUpdate = true
    rec.jpeg = src.jpeg
  }
  class SiblingTextureLoader extends THREE.Loader {
    load(url, onLoad, onProgress, onError) {
      const tex = new THREE.Texture()
      const rec = { ref: String(url || '') }
      info.set(tex, rec)
      pending.push(fill(tex, rec).catch(() => { rec.why = rec.why || 'bad' }).then(() => {
        if (rec.why) { if (onError) onError(new Error(rec.ref)) } else if (onLoad) onLoad(tex)
      }))
      return tex
    }
  }
  // /^/：什么名字都由它接（MTLLoader 按整条路径问，FBXLoader 按「.扩展名」问）
  mgr.addHandler(/^/, new SiblingTextureLoader(mgr))
  return {
    mgr,
    info: (tex) => info.get(tex),
    /** 等在途贴图全部落定（读不到 / 解不开也算落定）；一张都没要过的立即返回。返回 true = 连续 ms 没有一张落定、剩下的不等了 */
    settle(ms = TEX_SETTLE_MS) {
      if (!pending.length) return Promise.resolve(false)
      return new Promise((resolve) => {
        let left = pending.length, timer = 0, over = false
        const end = (late) => { if (over) return; over = true; clearTimeout(timer); resolve(late) }
        const arm = () => { clearTimeout(timer); timer = setTimeout(end, ms, true) }
        const one = () => { if (--left === 0) end(false); else if (!over) arm() }
        for (const p of pending) p.then(one, one)
        arm()
      })
    }
  }
}

// 贴图落定之后，image 仍为空的（读不到 / 解不开 / 超时；FBX 里没有文件名的占位贴图同理）从材质上摘掉：留着 image = null 的贴图，
// GLTFExporter 整件抛错、模型入不了库；摘掉后照样入库，按原因记告警（只记模型里真用到的）。必须在 finish 之前做：
// toStandard 照搬贴图槽，materials.js 的退化黑判据要看「有没有底色贴图」。
// JPEG 源的颜色图标上 mimeType（GLTFExporter 认它）：导出件里照样存 JPEG、不胀成 PNG（与 materials.js 程序贴图同一口径，法线 / 凹凸等留 PNG）
async function settleTextures(root, side, warnings, waitMs) {
  const late = await side.settle(waitMs)
  const lost = { missing: new Set(), bad: new Set(), late: new Set() }
  const seen = new Set()
  root.traverse((o) => {
    if (!o.material) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || seen.has(m)) continue
      seen.add(m)
      for (const k of Object.keys(m)) {
        const t = m[k]
        if (!t || !t.isTexture) continue
        const rec = side.info(t)
        if (t.image != null) {
          if (rec && rec.jpeg && (k === 'map' || k === 'emissiveMap')) t.userData.mimeType = 'image/jpeg'
          continue
        }
        m[k] = null
        // 没经过旁车加载器的（FBX 无文件名的占位贴图）算缺；经过了却没落定原因的只能是到封顶还没回来
        const why = rec ? rec.why || (late ? 'late' : 'bad') : 'missing'
        lost[why].add((rec && rec.ref && !isInline(rec.ref) ? baseName(rec.ref) : '') || t.name || m.name || '?')
      }
    }
  })
  const names = (s) => [...s].slice(0, 5).join('、')
  if (lost.missing.size) warnings.push('缺少贴图 ' + names(lost.missing))
  if (lost.bad.size) warnings.push('贴图无法解码 ' + names(lost.bad))
  if (lost.late.size) warnings.push('贴图读取超时 ' + names(lost.late))
}

async function importObj(bytes, name, readSibling, warnings, texWaitMs) {
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
      if (b) mtlTexts.push(new TextDecoder('utf-8').decode(b)); else warnings.push('缺少材质库 ' + baseName(n))
    }
    if (mtlTexts.length) {
      side = sidecarManager(readSibling)
      const mtl = new MTLLoader(side.mgr)
      const creators = mtlTexts.map((t) => mtl.parse(t, ''))
      // 多个 mtllib：合并成一个 MaterialCreator 的材质表
      const mc = creators[0]
      for (const c of creators.slice(1)) Object.assign(mc.materialsInfo, c.materialsInfo)
      // 不 preload：OBJLoader 按 usemtl 现取现造材质（贴图随之开读），.mtl 里没被用到的材质不去读它的贴图、也不必等
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
  if (side) await settleTextures(root, side, warnings, texWaitMs)
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

async function importFbx(bytes, name, readSibling, warnings, texWaitMs) {
  // 贴图：内嵌的（FBXLoader 现造 blob: / data:）原样解码，外部的按文件名去同目录读 —— 都由 sidecarManager 的加载器接住，解析完一起等落定
  const side = sidecarManager(readSibling)
  const root = new FBXLoader(side.mgr).parse(u8buf(bytes), '')
  // FBX 里没有材质的网格：FBXLoader 给名为 __DEFAULT 的灰 Phong（THREE.Loader.DEFAULT_MATERIAL_NAME）→ 标成「没有材质」
  root.traverse((o) => {
    if (!o.isMesh) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && m.name === THREE.Loader.DEFAULT_MATERIAL_NAME) m.userData.__noMaterial = true
  })
  await settleTextures(root, side, warnings, texWaitMs)
  const usf = Number(root.userData && root.userData.unitScaleFactor)
  // UnitScaleFactor = 每单位多少厘米：1 → cm（FBX 出厂）、100 → m、0.1 → mm、2.54 → in、30.48 → ft
  let unitHint = 'unknown'
  if (Number.isFinite(usf) && usf > 0) {
    const table = [[1, 'cm'], [100, 'm'], [0.1, 'mm'], [2.54, 'in'], [30.48, 'ft']]
    for (const [v, u] of table) if (Math.abs(usf / v - 1) < 0.01) unitHint = u
  }
  return { root, unitHint, fbxUnitScaleFactor: Number.isFinite(usf) ? usf : null }
}

/**
 * 解析一个 OBJ / STL / FBX 文件。
 * @param {{bytes:Uint8Array, name:string}} file
 * @param {{readSibling?:(relName:string)=>Promise<Uint8Array|null>, texWaitMs?:number}} [o]
 *   texWaitMs：贴图落定的封顶（连续这么久没有一张落定就不再等；缺省 TEX_SETTLE_MS = 60 s），没等到的贴图按「读取超时」摘掉
 * @returns {Promise<{root:THREE.Object3D, format:string, unitHint:string, fbxUnitScaleFactor?:number|null, tris:number, ms:number, warnings:string[],
 *   materialFallback:{noMaterialMeshes:number, degenerate:{share:number, fixed:string[]}}}>}
 *   返回时贴图已全部落定：材质上留下的贴图都有图像（可直接 exportGlb），缺 / 坏 / 超时的已摘掉并记进 warnings。
 *   失败抛 Error（message 只是状态，界面直接显示）
 */
export async function importFile(file, o = {}) {
  const t0 = performance.now()
  const fmt = extOf(file && file.name)
  if (!IMPORT_FORMATS.includes(fmt)) throw new Error('不支持的格式：' + (fmt || '未知'))
  if (!file.bytes || !file.bytes.byteLength) throw new Error('文件为空。')
  const warnings = []
  const texWaitMs = Number.isFinite(o.texWaitMs) && o.texWaitMs >= 0 ? o.texWaitMs : TEX_SETTLE_MS
  let r
  try {
    if (fmt === 'obj') r = await importObj(file.bytes, file.name, o.readSibling, warnings, texWaitMs)
    else if (fmt === 'stl') r = importStl(file.bytes, file.name)
    else r = await importFbx(file.bytes, file.name, o.readSibling, warnings, texWaitMs)
  } catch (e) {
    throw new Error((fmt.toUpperCase()) + ' 解析失败：' + ((e && e.message) || e))
  }
  const fin = finish(r.root, file.name)
  if (!fin.tris) throw new Error('文件中不含三角形。')
  return { root: r.root, format: fmt, unitHint: r.unitHint, fbxUnitScaleFactor: r.fbxUnitScaleFactor, tris: fin.tris, ms: Math.round(performance.now() - t0), warnings, materialFallback: fin.materialFallback }
}
