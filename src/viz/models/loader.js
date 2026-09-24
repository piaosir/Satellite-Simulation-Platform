// glb 加载器单例：GLTFLoader + Draco + meshopt + KTX2；按 URL 缓存解析结果 + 引用计数 + 延迟释放。
//
// 为什么要缓存与引用计数：同一个模型会同时出现在工作台预览、库卡片缩略图重绘、3D 球的图标与跟随视图里。
// 解析一次（Draco 解码 + 贴图解码）要几十到几百毫秒，重复解析既慢又双倍占显存。所以同 URL 共享一份「模板」，
// 每个使用方拿 template.clone(true)（Object3D 树各自一份，几何 / 材质 / 贴图共享），用完 handle.release()；
// 引用归零后再等 60 s 才真释放 —— 跟随视图进进出出、库页来回切时不会反复解码。
//
// 取解码器（DESIGN §5.1 / deps 报告 §2.2 方案 A）：
//   DRACOLoader / KTX2Loader 按「目录 + 固定文件名」fetch 取 wasm，不能被 vite 打哈希，所以由 electron.vite.config.mjs 的
//   viteStaticCopy 把 draco/gltf 两个文件、basis 两个文件原样拷到 three-libs/ 下：dev 由 static-copy 中间件出，
//   build 落 out/renderer/three-libs/（随 out/** 进 asar，file:// 下 fetch 实测可用）。
//   ★ 绝对 URL 在主线程按 document.baseURI 算好再交给 DRACOLoader：它把 wrapper 拼成 blob: Worker，
//     Worker 里的相对路径会以 assets/ 为基准，是错的。
//   meshopt 解码器 wasm 内嵌在 JS 里（base64），不需要拷文件。
//
// 加载后处理（对模板做一次）：
//   · 删掉 glb 自带的相机与灯光（含 KHR_lights_punctual）—— NASA 美术模型常带 Blender 的灯，会污染我们的影棚光照。
//   · KHR_materials_pbrSpecularGlossiness（three r147 起不再支持，材质会退成默认白）→ 转 MeshStandard：
//     diffuse → color / map，glossiness → 1 − roughness，metalness 0。计数写进返回的 info 与控制台。
//   · 网格开投影 / 受影（影棚与太阳档都有阴影）。
//   · 不释放 CPU 侧几何数组：WebGL 上下文丢失后 three 靠它们懒重建（deps 报告 / globe-scene §8）。
//
// 节点名：GLTFLoader 会 sanitize node.name（空白变 _、删 [ ] . : /、重名加 _N），原名在 userData.name。
// ★ 一切按节点名的逻辑（AGI、gmdf、parts.nodes、articulation）一律用原名：originalName(obj)。
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

export const THREE_LIBS = (typeof document !== 'undefined' && document.baseURI)
  ? new URL('./three-libs/', document.baseURI).href
  : './three-libs/'

// 离屏出图脚本（scripts/nasa3d/sheets.mjs 的 sheet:// 页）没有 three-libs 目录，允许它改指到 node_modules 下的原目录
let _dracoBase = THREE_LIBS + 'draco/gltf/'
let _basisBase = THREE_LIBS + 'basis/'
/** 改解码器目录（只在第一次加载前调有效） */
export function setDecoderBase({ draco, basis } = {}) {
  if (draco) _dracoBase = draco.endsWith('/') ? draco : draco + '/'
  if (basis) _basisBase = basis.endsWith('/') ? basis : basis + '/'
}

let _draco = null
function dracoLoader() {
  if (_draco) return _draco
  // 默认 4 个 worker、每个各一份 wasm 堆；模型一次只解一两个，2 个够用
  _draco = new DRACOLoader().setDecoderPath(_dracoBase).setDecoderConfig({ type: 'wasm' }).setWorkerLimit(2)
  return _draco
}
// 一个 renderer 一个 KTX2Loader（同一 realm 多个活跃实例 three 会告警，且 detectSupport 依赖具体上下文）
const _ktx2 = new Map()

/** 造一个配好解码器的 GLTFLoader。给了 renderer 才挂 KTX2（basisu 贴图要按 GPU 能力选转码目标）。 */
export function makeGltfLoader(renderer) {
  const l = new GLTFLoader().setDRACOLoader(dracoLoader()).setMeshoptDecoder(MeshoptDecoder)
  if (renderer) {
    let k = _ktx2.get(renderer)
    if (!k) { k = new KTX2Loader().setTranscoderPath(_basisBase).detectSupport(renderer); _ktx2.set(renderer, k) }
    l.setKTX2Loader(k)
  }
  return l
}

/** 窗口卸载 / renderer 销毁时调：释放 Draco worker 与该 renderer 的 KTX2 转码器（不给 renderer 则全放） */
export function disposeLoaders(renderer) {
  if (renderer) { const k = _ktx2.get(renderer); if (k) { k.dispose(); _ktx2.delete(renderer) } return }
  for (const k of _ktx2.values()) k.dispose()
  _ktx2.clear()
  if (_draco) { _draco.dispose(); _draco = null }
}

/** 节点原名（导入时 GLTFLoader 改写过 name，原名在 userData.name） */
export function originalName(obj) {
  return (obj && obj.userData && typeof obj.userData.name === 'string') ? obj.userData.name : (obj ? obj.name : '')
}

// ---------------------------------------------------------------------------------------------
// 释放
// ---------------------------------------------------------------------------------------------
function closeBitmap(t) {
  const img = t && t.source && t.source.data
  if (img && typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) { try { img.close() } catch { /* ignore */ } }
}
function disposeMaterial(m, seenTex) {
  if (!m || (m.userData && m.userData._shared)) return
  for (const k in m) {
    const v = m[k]
    if (v && v.isTexture && !(v.userData && v.userData._shared) && !seenTex.has(v)) {
      seenTex.add(v)
      v.dispose()
      closeBitmap(v)   // ImageBitmap 不会随 texture.dispose 回收（GLTFLoader.js:80 注释），不手动 close 就是内存泄漏
    }
  }
  m.dispose()
}

/**
 * 释放一棵 Object3D 树的几何、材质、贴图（跳过 userData._shared 标记的共享件）。
 * 几何上若挂了 three-mesh-bvh 的 boundsTree 一并摘掉。树本身不从父节点移除（调用方决定）。
 */
export function disposeObject(obj) {
  if (!obj) return
  const geoms = new Set(), mats = new Set(), seenTex = new Set()
  obj.traverse((o) => {
    if (o.geometry && !(o.geometry.userData && o.geometry.userData._shared)) geoms.add(o.geometry)
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of ms) mats.add(m)
  })
  for (const g of geoms) { if (g.boundsTree) g.boundsTree = null; g.dispose() }
  for (const m of mats) disposeMaterial(m, seenTex)
}

// ---------------------------------------------------------------------------------------------
// 节点位姿（挂点）
// AGI 元数据本身的读取不在这里：用 packages/core/models/agi.mjs 的 readAgiFromGltfJson(handle.json)（与主进程 / 单测同一份白名单口径）。
// 本文件不引 @core —— scripts/nasa3d/sheets.mjs 的离屏页只映射了 three。
// ---------------------------------------------------------------------------------------------
/**
 * 按节点原名取节点在 root 局部系（= 模型系）下的位姿：位置、视轴 = 节点局部 +Y、上向 = 节点局部 +X
 * （挂点节点的轴向口径以 packages/core/models/agi.mjs「挂点节点的轴向口径」为准：按本机 STK 12 核定，与 attachNodeMatrix /
 * attachPointPoses 同一套；本文件不引 @core，所以在这里照抄轴的对应关系）。
 * 给「从 STK / 导入件的 isAttachPoint 节点生成 attachPoints」用；换算到本体系由调用方乘 frame。
 */
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3()
export function nodePosesInRoot(root, names) {
  const want = new Set(names), out = []
  root.updateMatrixWorld(true)
  _inv.copy(root.matrixWorld).invert()
  root.traverse((o) => {
    const nm = originalName(o)
    if (!want.has(nm)) return
    _m.multiplyMatrices(_inv, o.matrixWorld).decompose(_p, _q, _s)
    const d = new THREE.Vector3(0, 1, 0).applyQuaternion(_q), u = new THREE.Vector3(1, 0, 0).applyQuaternion(_q)
    out.push({ name: nm, pos: [_p.x, _p.y, _p.z], dir: [d.x, d.y, d.z], up: [u.x, u.y, u.z] })
  })
  return out
}

// ---------------------------------------------------------------------------------------------
// 加载后处理
// ---------------------------------------------------------------------------------------------
async function convertSpecGloss(gltf) {
  const parser = gltf.parser, json = parser.json
  const defs = Array.isArray(json.materials) ? json.materials : []
  if (!defs.some((d) => d && d.extensions && d.extensions.KHR_materials_pbrSpecularGlossiness)) return 0
  const replaced = new Map()   // 旧材质 → 新材质
  const jobs = []
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return
    const list = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of list) {
      if (replaced.has(m)) continue
      const as = parser.associations.get(m)
      const idx = as && as.materials
      const def = idx != null ? defs[idx] : null
      const sg = def && def.extensions && def.extensions.KHR_materials_pbrSpecularGlossiness
      if (!sg) continue
      const df = Array.isArray(sg.diffuseFactor) ? sg.diffuseFactor : [1, 1, 1, 1]
      const params = {
        name: m.name,
        color: new THREE.Color().setRGB(df[0], df[1], df[2]),
        opacity: df[3] != null ? df[3] : 1,
        transparent: def.alphaMode === 'BLEND',
        alphaTest: def.alphaMode === 'MASK' ? (def.alphaCutoff ?? 0.5) : 0,
        metalness: 0,
        roughness: 1 - (sg.glossinessFactor != null ? sg.glossinessFactor : 1),
        side: m.side,
        normalMap: m.normalMap || null, normalScale: m.normalScale ? m.normalScale.clone() : undefined,
        aoMap: m.aoMap || null, emissive: m.emissive ? m.emissive.clone() : undefined, emissiveMap: m.emissiveMap || null,
        vertexColors: m.vertexColors, flatShading: m.flatShading
      }
      const p = (sg.diffuseTexture ? parser.assignTexture(params, 'map', sg.diffuseTexture, THREE.SRGBColorSpace) : Promise.resolve())
        .then(() => { replaced.set(m, new THREE.MeshStandardMaterial(params)) })
      replaced.set(m, null)
      jobs.push(p)
    }
  })
  await Promise.all(jobs)
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return
    if (Array.isArray(o.material)) o.material = o.material.map((m) => replaced.get(m) || m)
    else if (replaced.get(o.material)) o.material = replaced.get(o.material)
  })
  for (const old of replaced.keys()) old.dispose()   // 旧材质的贴图（normal/ao/emissive）被新材质沿用，不 dispose 贴图
  return replaced.size
}

function postProcess(gltf) {
  // 场景根打标：exporter 见到它就把它「摊平」（子节点直接当 glTF 场景根节点），导出再导入不会一层层套壳
  gltf.scene.userData.__sceneRoot = true
  const drop = []
  let tris = 0, meshes = 0
  gltf.scene.traverse((o) => {
    if (o.isCamera || o.isLight) { drop.push(o); return }
    if (o.isMesh) {
      meshes++
      o.castShadow = true; o.receiveShadow = true
      const g = o.geometry
      const n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)
      tris += Math.floor(n / 3)
      if (!g.boundingBox) g.computeBoundingBox()
      if (!g.boundingSphere) g.computeBoundingSphere()
    }
  })
  // 相机 / 灯光节点可能还挂着子节点（少见）：GLTFLoader 把「带 camera 的节点」本身建成相机对象（节点的 TRS 在它身上），
  // 子节点相对它摆 —— 提给父节点时要把相机节点的局部矩阵乘进去，否则子网格位置跳变
  hoistAndDrop(drop)
  return { tris, meshes, dropped: drop.length }
}

/**
 * 删掉这些节点；它们的子节点提给各自的父节点，子节点局部矩阵先左乘被删节点的局部矩阵（世界位姿不变），
 * 并放回被删节点原来的位置（先序顺序不变 —— irLayout 的节点序与全局三角形号依赖它）。importers.js 共用。
 * @param {THREE.Object3D[]} list
 */
export function hoistAndDrop(list) {
  // 从深到浅删：被删节点下面还有被删节点时，里层先提到外层、外层再提一次，变换逐层累乘
  const depth = (o) => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d }
  for (const o of list.slice().sort((a, b) => depth(b) - depth(a))) {
    const p = o.parent
    if (!p) continue
    o.updateMatrix()
    const at = p.children.indexOf(o)
    const kids = o.children.slice()
    for (const c of kids) { c.updateMatrix(); c.applyMatrix4(o.matrix); o.remove(c) }
    p.remove(o)
    for (let i = 0; i < kids.length; i++) { const c = kids[i]; c.parent = p; p.children.splice(at + i, 0, c) }
  }
}

// ---------------------------------------------------------------------------------------------
// 加载 + 缓存
// ---------------------------------------------------------------------------------------------
const RELEASE_DELAY_MS = 60000
const _cache = new Map()   // url → { promise, template, gltf, info, refs, timer, ctrl }

async function parseBytes(bytes, path, renderer) {
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer
  return makeGltfLoader(renderer).parseAsync(buf, path || '')
}

async function build(gltf, t0) {
  const specGloss = await convertSpecGloss(gltf)
  if (specGloss) console.info('[models] KHR_materials_pbrSpecularGlossiness → 金属粗糙度：' + specGloss + ' 个材质')
  const pp = postProcess(gltf)
  const json = gltf.parser.json
  const info = {
    ms: Math.round(performance.now() - t0), tris: pp.tris, meshes: pp.meshes, droppedCamerasLights: pp.dropped, specGlossConverted: specGloss,
    materials: Array.isArray(json.materials) ? json.materials.length : 0,
    textures: Array.isArray(json.textures) ? json.textures.length : 0,
    nodes: Array.isArray(json.nodes) ? json.nodes.length : 0,
    generator: (json.asset && typeof json.asset.generator === 'string') ? json.asset.generator : ''
  }
  return { template: gltf.scene, gltf, info }
}

function makeHandle(key, entry) {
  let released = false
  return {
    key,
    get info() { return entry.info },
    /** 原始 glTF JSON（节点原名、AGI 扩展都在这里；只读） */
    get json() { return entry.gltf.parser.json },
    get satsim() { const s = entry.gltf.userData && entry.gltf.userData.satsim; return s && typeof s === 'object' ? s : null },
    release() {
      if (released) return
      released = true
      entry.refs--
      if (entry.refs > 0) return
      if (key == null) { disposeObject(entry.template); return }   // 字节来源不入缓存：没人能再命中，立刻放
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        if (entry.refs > 0) return
        _cache.delete(key)
        disposeObject(entry.template)
      }, RELEASE_DELAY_MS)
    }
  }
}

/**
 * 加载模型。
 * @param {string|{bytes:Uint8Array,name?:string}} src  URL（models:// / http / 相对）或内存字节（导入件，主进程读好经 IPC 传来）
 * @param {{renderer?:THREE.WebGLRenderer, signal?:AbortSignal}} [o]
 * @returns {Promise<{root:THREE.Object3D, gltf:object, handle:{release():void, info:object, json:object, satsim:object|null}}>}
 *   root 是模板的 clone(true)：节点树各自一份，几何 / 材质 / 贴图与其他使用方共享 —— 要改材质（淡入淡出等）自己 clone。
 */
export async function loadModel(src, o = {}) {
  const { renderer, signal } = o
  const t0 = performance.now()
  if (src && typeof src === 'object' && src.bytes) {
    if (signal && signal.aborted) throw abortErr()
    const gltf = await parseBytes(src.bytes, '', renderer)
    const entry = Object.assign(await build(gltf, t0), { refs: 1 })
    if (signal && signal.aborted) { disposeObject(entry.template); throw abortErr() }
    return { root: entry.template, gltf, handle: makeHandle(null, entry) }
  }
  const url = String(src)
  let entry = _cache.get(url)
  if (!entry) {
    const ctrl = new AbortController()
    entry = { refs: 0, timer: 0, ctrl, template: null, gltf: null, info: null }
    entry.promise = (async () => {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const buf = new Uint8Array(await res.arrayBuffer())
      const base = url.slice(0, url.lastIndexOf('/') + 1)
      const gltf = await parseBytes(buf, base, renderer)
      const b = await build(gltf, t0)
      entry.template = b.template; entry.gltf = b.gltf; entry.info = b.info
      return entry
    })()
    entry.promise.catch(() => { if (_cache.get(url) === entry) _cache.delete(url) })
    _cache.set(url, entry)
  }
  clearTimeout(entry.timer)
  entry.refs++
  let onAbort = null
  try {
    await (signal ? Promise.race([entry.promise, new Promise((_, rej) => {
      onAbort = () => rej(abortErr())
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true })
    })]) : entry.promise)
  } catch (e) {
    entry.refs--
    // 最后一个等它的人也撤了、而它还在下载 / 解码：整条作废
    if (entry.refs <= 0 && !entry.template) { entry.ctrl.abort(); if (_cache.get(url) === entry) _cache.delete(url) }
    else if (entry.refs <= 0 && entry.template) makeHandle(url, Object.assign(entry, { refs: 1 })).release()
    throw e
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
  const root = entry.template.clone(true)
  return { root, gltf: entry.gltf, handle: makeHandle(url, entry) }
}

function abortErr() { const e = new Error('已取消'); e.name = 'AbortError'; return e }

/** 缓存现状（调试 / 性能读数用） */
export function loaderCacheStats() {
  let refs = 0
  for (const e of _cache.values()) refs += e.refs
  return { entries: _cache.size, refs }
}
