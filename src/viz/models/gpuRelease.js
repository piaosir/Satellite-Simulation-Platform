// 按 renderer 精确释放「共享资源」上的 GPU 副本与 dispose 监听。
//
// 为什么需要：three 的 WebGLRenderer 第一次用到一个几何 / 材质 / 贴图时，会在它身上挂一个本 renderer 私有的 'dispose' 监听
// （WebGLGeometries / WebGLRenderer.getProgram / WebGLTextures / WebGLShadowMap 各一个闭包），等资源自己 dispose 时回收 GPU 副本。
// renderer.dispose() 不摘这些监听。于是：
//   · 材质库的材质与程序纹理全窗口共享、永不 dispose —— 每建一个视口 / 缩略图 renderer 就多挂一组监听，死 renderer 连同画布、
//     上下文包装被它们引用着，永远释放不掉（验证台实测：视口建拆 5 次，mli_gold 的 dispose 监听 1 → 5）；
//   · loader 模板的几何要引用归零 60 s 后才 dispose —— 这期间已经摘下的模型仍在视口的 GPU 里占着显存。
// 办法：renderer 建好后画一个「哨兵」（退化三角形 + 1×1 贴图 + alphaTest 投影），截下这四类闭包；之后对任何资源，
// 只要它身上挂着本 renderer 的闭包，就直接以 {target: 资源} 调一次 —— 效果与该资源派发 dispose 完全相同，但只作用于本 renderer：
// 其他 renderer 的 GPU 副本与监听原样不动，资源的 CPU 数据也不动（别处照用、本 renderer 再用会重新上传）。
//
// 跟踪：track(root) 把树里的几何 / 材质 / 贴图记成 WeakRef（不拖住已被主人释放的 CPU 数组）；releaseAll() 在 renderer.dispose() 之前调。
import * as THREE from 'three'

function texturesOf(m, out) {
  for (const k in m) { const v = m[k]; if (v && v.isTexture) out.add(v) }
  return out
}

/** 一棵树里用到的几何 / 材质 / 贴图（去重） */
export function collectResources(root) {
  const geoms = new Set(), mats = new Set(), texs = new Set()
  if (!root) return { geoms, mats, texs }
  root.traverse((o) => {
    if (o.geometry && o.geometry.isBufferGeometry) geoms.add(o.geometry)
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of ms) if (m) { mats.add(m); texturesOf(m, texs) }
  })
  return { geoms, mats, texs }
}

/**
 * @param {THREE.WebGLRenderer} renderer 刚建好的 renderer（开着 shadowMap 才截得到阴影那一个闭包）
 */
export function createGpuReleaser(renderer) {
  const fns = { geo: [], mat: [], tex: [] }
  const hook = (obj, kind) => {
    const orig = obj.addEventListener
    obj.addEventListener = function (type, fn) {
      if (type === 'dispose' && !fns[kind].includes(fn)) fns[kind].push(fn)
      return orig.call(this, type, fn)
    }
  }
  // ---- 哨兵：一帧就能让四类闭包都挂上来 ----
  {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
    tex.needsUpdate = true
    hook(tex, 'tex')
    // alphaTest + map：WebGLShadowMap 为这种材质单独缓存深度材质，并在原材质上另挂一个 dispose 监听
    const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5 })
    hook(mat, 'mat')
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3))   // 退化三角形：零面积，什么也画不出来
    hook(geo, 'geo')
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false; mesh.castShadow = true
    const light = new THREE.DirectionalLight(0xffffff, 1)
    light.castShadow = !!renderer.shadowMap.enabled
    light.shadow.mapSize.set(1, 1)
    const scene = new THREE.Scene()
    scene.add(mesh, light, light.target)
    const cam = new THREE.PerspectiveCamera()
    const clear = renderer.autoClear
    renderer.autoClear = false   // 不动调用方画布上已有的内容
    try { renderer.render(scene, cam) } catch (e) { console.warn('[models] gpuRelease 哨兵渲染失败：' + ((e && e.message) || e)) }
    renderer.autoClear = clear
    geo.dispose(); mat.dispose(); tex.dispose(); light.dispose()
  }

  const refs = []
  const seen = new WeakSet()
  let compactAt = 256
  const add = (x) => {
    if (!x || seen.has(x)) return
    seen.add(x)
    refs.push(new WeakRef(x))
  }

  /** 只放本 renderer 的那一份（资源身上没挂本 renderer 的闭包 = 本 renderer 没用过 / 已放过：什么也不做） */
  function releaseOne(x) {
    if (!x || typeof x.hasEventListener !== 'function') return
    const list = x.isBufferGeometry ? fns.geo : x.isMaterial ? fns.mat : x.isTexture ? fns.tex : null
    if (!list) return
    for (const f of list) if (x.hasEventListener('dispose', f)) f({ type: 'dispose', target: x })
  }

  return {
    /** 记下一棵树里的资源（renderer 以后可能用到它们） */
    track(root) {
      const r = collectResources(root)
      for (const s of [r.geoms, r.mats, r.texs]) for (const x of s) add(x)
      if (refs.length > compactAt) {
        // 主人已释放、被回收的条目清掉，列表不随浏览过的模型数无限增长
        let w = 0
        for (let i = 0; i < refs.length; i++) if (refs[i].deref()) refs[w++] = refs[i]
        refs.length = w
        compactAt = Math.max(256, w * 2)
      }
    },
    /**
     * 放掉一棵树在本 renderer 里的 GPU 副本。
     * @param {THREE.Object3D} root
     * @param {{kinds?:('geo'|'mat'|'tex')[], keepShared?:boolean, keep?:{geoms:Set,mats:Set,texs:Set}}} [o]
     *   kinds 缺省 ['geo','tex']：材质留着 —— 放材质会连带销毁着色器程序，下一个模型要重编译；程序不占多少显存。
     *   keepShared：跳过 userData._shared（材质库）的；keep：跳过这些（下一个模型也要用的）。
     */
    releaseTree(root, o = {}) {
      const kinds = o.kinds || ['geo', 'tex']
      const r = collectResources(root)
      const skip = (x, set) => (o.keepShared && x.userData && x.userData._shared) || (set && set.has(x))
      if (kinds.includes('geo')) for (const g of r.geoms) if (!skip(g, o.keep && o.keep.geoms)) releaseOne(g)
      if (kinds.includes('tex')) for (const t of r.texs) if (!skip(t, o.keep && o.keep.texs)) releaseOne(t)
      if (kinds.includes('mat')) for (const m of r.mats) if (!skip(m, o.keep && o.keep.mats)) releaseOne(m)
    },
    releaseOne,
    /** 放掉记过的全部（renderer.dispose() 之前调） */
    releaseAll() {
      for (const w of refs) { const x = w.deref(); if (x) releaseOne(x) }
      refs.length = 0
    },
    /** 调试 / 验证台用：截到的闭包个数 */
    get captured() { return { geo: fns.geo.length, mat: fns.mat.length, tex: fns.tex.length } }
  }
}
