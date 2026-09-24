// 离屏缩略图（512 WebP，透明底）与三视图 + 透视四宫格（PNG，报告用）。
//
// 与工作台预览同一套光照（studio.js）与同一个「自动」视角（autoViewDir，见下），所以库卡片上的缩略图
// 与点开后的预览是同一张脸。scripts/nasa3d/sheets.mjs 的离屏页也直接调这里（只依赖 three 与本目录的
// studio / view / materials —— 都不引 @core 与 src/shared）。
//
// 画质：先按 2 倍边长画（MSAA 之上再超采样），再在 2D 画布里高质量缩回目标尺寸 —— 天线杆、桁架这些
// 亚像素细件在 512 px 缩略图里不至于断成虚线。
//
// renderer 是模块级单例（同一窗口批量出几十张图不反复建上下文）；窗口卸载或批处理结束调 disposeThumbs()。
// 模型不搬家：每次画的是 root.clone(true)（节点树各一份、几何 / 材质共享），画完就摘，不影响预览里那一份。
//
// ★ 串行：场景、画布尺寸、环境强度、剪裁状态都是这个单例的，两次调用交错就会互相踩（第一张停在 await toBlob 时第二张已经
//   把自己的模型挂上去，画出来是两个模型叠在一起 —— 验证台实测过）。所以 renderThumb / renderThreeView / disposeThumbs
//   一律排进同一条队列；每张图的 GPU 部分（挂模型 → 画 → 拷进 2D 画布 → 摘模型）是同步做完的，编码成图片才异步。
// GPU 资源：画完就把这个模型的几何 / 贴图在本 renderer 里的副本放掉（gpuRelease.js，只动本 renderer，别处不受影响）——
//   批量出图不让显存随模型数累积；材质留着（着色器程序复用），disposeThumbs 时连同材质库上的监听一起摘干净。
import * as THREE from 'three'
import { configureRenderer, createStudio, rigOrientFor } from './studio.js'
import { setMaterialAnisotropy } from './materials.js'
import { createGpuReleaser } from './gpuRelease.js'
import { BODY_TO_DISPLAY, BODY_VIEWS, ZENITH_DISPLAY, modelToBodyMatrix, viewDir, sampleWorldPoints, fitPerspective, boundingRadius } from './view.js'

// ---------------------------------------------------------------------------------------------
// 阴影趟共用深度材质：钉死 map / alphaMap（「texSubImage2D: The source data has been detached」告警的根因）
// ---------------------------------------------------------------------------------------------
// three 的 WebGLShadowMap 对「不需要按材质建变体」的投影物共用一个 _depthMaterial，逐物体做 result.map = material.map。
//   · 它的着色器第一次编译时若碰上带贴图的物体就带上 USE_MAP，此后 map 再变也不重编（needsProgramChange 不看 map）；
//   · refreshUniforms 只在 map 非空时写 uniforms.map.value —— 换到无贴图的物体时 uniform 仍指着上一个模型的贴图。
// 那个模型释放时 loader 已 close() 了它的 ImageBitmap（loader.js closeBitmap），本 renderer 下一趟阴影绑到这张旧贴图，
// 版本号对不上就重新上传 → texSubImage2D 读到已分离的位图（验证台 .modelharness/w10 detached 步抓到的调用栈正是
// WebGLShadowMap.renderObject → setProgram → WebGLUniforms.upload → setTexture2D → uploadTexture）。
// 共用深度材质只在「alphaTest = 0，或没有 map / alphaMap」时被选中（有贴图且 alphaTest > 0 的走按材质缓存的变体，
// 变体随原材质一起释放），这时 map / alphaMap 对深度结果没有任何作用。所以把共用那一份的这两个属性钉成恒 null：
// 程序永不带 USE_MAP / USE_ALPHAMAP，也就永不留旧贴图的引用；深度结果不变（alphaTest = 0 时片元的 alpha 本来就不参与）。
// 每个 renderer 建好（configureRenderer 开了阴影）之后、画任何模型之前调一次。
const _pinned = new WeakSet()
export function pinShadowDepthMaps(renderer) {
  const sm = renderer && renderer.shadowMap
  if (!sm || !sm.enabled) return false
  let dm = null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3))   // 退化三角形：什么也画不出来
  const mat = new THREE.MeshBasicMaterial()   // 无贴图、无 alphaTest → 阴影趟必走共用深度材质
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false; mesh.castShadow = true
  mesh.onBeforeShadow = (r, o, c, sc, g, depthMaterial) => { dm = depthMaterial }
  const light = new THREE.DirectionalLight(0xffffff, 1)   // 影棚 / 太阳档只用平行光（studio.js），点光的距离材质不涉及
  light.castShadow = true; light.shadow.mapSize.set(1, 1)
  const scene = new THREE.Scene()
  scene.add(mesh, light, light.target)
  const clear = renderer.autoClear, nu = sm.needsUpdate
  renderer.autoClear = false; sm.needsUpdate = true   // autoUpdate 关着的 renderer 也要走这一趟阴影
  try { renderer.render(scene, new THREE.PerspectiveCamera()) } catch (e) { console.warn('[models] 阴影深度材质探针失败：' + ((e && e.message) || e)) }
  renderer.autoClear = clear; sm.needsUpdate = nu
  geo.dispose(); mat.dispose(); light.dispose()
  if (!dm || !dm.isMaterial) return false
  if (!_pinned.has(dm)) {
    for (const k of ['map', 'alphaMap']) Object.defineProperty(dm, k, { configurable: true, enumerable: true, get: () => null, set: () => {} })
    _pinned.add(dm)
  }
  return true
}

let _T = null
function ctx(W, H) {
  if (!_T) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H })
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(1)
    renderer.setClearColor(0x000000, 0)
    configureRenderer(renderer)
    setMaterialAnisotropy(renderer)
    const gpu = createGpuReleaser(renderer)
    pinShadowDepthMaps(renderer)
    const scene = new THREE.Scene()
    const body = new THREE.Group(); body.matrixAutoUpdate = false; body.matrix.copy(BODY_TO_DISPLAY)
    const holder = new THREE.Group(); holder.matrixAutoUpdate = false
    body.add(holder); scene.add(body)
    const studio = createStudio(renderer, scene, { mode: 'studio', shadowMapSize: 2048 })
    studio.setUp(ZENITH_DISPLAY)   // 太阳档的地球反照 / 太空环境：地球在天底（显示系天顶朝上、地球在下，见 view.js）
    _T = { canvas, renderer, scene, body, holder, studio, gpu }
  }
  if (_T.canvas.width !== W || _T.canvas.height !== H) _T.renderer.setSize(W, H, false)
  return _T
}

/**
 * 参数化模板缩略图的本机缓存版本号（localStorage 键 model/tplThumb/<版本>/<模板 id>）。工作台（wbStore）与 3D 页侧栏
 * （ModelSidePanel）同源共用一份缓存，两边都从这里取：renderThumb 的材质 / 光照 / 显示系口径一改就升版本，旧图自动作废。
 * v4 = 材质 / 光照口径 + 显示系「天顶朝上、地球在下」。
 */
export const TPL_THUMB_VER = 'v4'

const ISO = viewDir('iso', new THREE.Vector3()), _rq = new THREE.Quaternion(), _q0 = new THREE.Quaternion()
let _queue = Promise.resolve()
function serial(fn) {
  const p = _queue.then(() => fn())
  _queue = p.then(() => {}, () => {})
  return p
}

/** 释放离屏 renderer（批量出图结束 / 窗口卸载）。排在已提交的出图之后执行。 */
export function disposeThumbs() {
  return serial(() => {
    if (!_T) return
    _T.gpu.releaseAll()   // 摘掉材质库 / 模型资源上本 renderer 的 dispose 监听（否则死 renderer 被它们引用着放不掉）
    _T.studio.dispose()
    _T.renderer.dispose()
    try { _T.renderer.forceContextLoss() } catch { /* ignore */ }
    _T = null
  })
}

// ---------------------------------------------------------------------------------------------
// 关节静止位姿（AGI initialValue）与精确包围盒 —— 预览视口、缩略图 / 三视图、导入后分析三处共用这一份
// ---------------------------------------------------------------------------------------------
// 为什么要有：AGI_articulations 的 initialValue 是「模型加载时的位置」，文件里的节点矩阵只是它的静止基准。STK 自带件把
// 喷焰（Thruster_1…12、Engine_Main）做成 uniformScale 初值 0 的关节 —— STK 缺省不显示；按文件位姿画就是满屏橙色 / 蓝色火焰，
// 包围盒、缩略图取景、自动分割、单位反算全被喷焰撑大（tdrs 的 Z 向被拖到 −25.7 m，星体只有 8 m 左右）。
// 口径与 bodyMask.worker.js 相同：局部 = 文件位姿 × Π stage（按 stages 顺序右乘；角度为度、平移为模型单位），缺的 stage 取 initialValue。
// 同一节点挂在几条关节上时按关节顺序依次右乘。导出（exporter）一律用文件位姿 —— 位姿只作用于调用方给的那份克隆。
const _S = new THREE.Matrix4(), _A = new THREE.Matrix4()
/** 单个 stage 的矩阵（AGI 节点局部系） */
export function stageMatrix(type, v, out = new THREE.Matrix4()) {
  const r = v * Math.PI / 180
  switch (type) {
    case 'xTranslate': return out.makeTranslation(v, 0, 0)
    case 'yTranslate': return out.makeTranslation(0, v, 0)
    case 'zTranslate': return out.makeTranslation(0, 0, v)
    case 'xRotate': return out.makeRotationX(r)
    case 'yRotate': return out.makeRotationY(r)
    case 'zRotate': return out.makeRotationZ(r)
    case 'xScale': return out.makeScale(v, 1, 1)
    case 'yScale': return out.makeScale(1, v, 1)
    case 'zScale': return out.makeScale(1, 1, v)
    case 'uniformScale': return out.makeScale(v, v, v)
    default: return out.identity()
  }
}
// 节点原名（= loader.js 的 originalName；这里不引 loader.js：本文件要能在 nasa3d:sheets 离屏页里少依赖地单独加载）
const nodeName = (o) => ((o && o.userData && typeof o.userData.name === 'string') ? o.userData.name : (o ? o.name : ''))
/** 缺省节点解析：按原名（userData.name，GLTFLoader / importers / irToThree 同一口径）匹配 */
function resolveByName(root) {
  let map = null
  return (names) => {
    if (!map) { map = new Map(); root.traverse((o) => { const n = nodeName(o); if (!n) return; if (!map.has(n)) map.set(n, []); map.get(n).push(o) }) }
    const out = []
    for (const n of names) { const l = map.get(n); if (l) out.push(...l) }
    return out
  }
}
function isIdentity(m) {
  const e = m.elements
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - (i % 5 === 0 ? 1 : 0)) > 1e-12) return false
  return true
}
/** 位姿表里记的节点全部回文件位姿（矩阵与显隐） */
export function restoreFilePose(pose) {
  if (!pose) return
  for (const [o, r] of pose) { o.matrix.copy(r.m); o.matrix.decompose(o.position, o.quaternion, o.scale); o.visible = r.vis }
}
/**
 * 按关节值摆节点：先把 pose 表里动过的节点复原到文件位姿，再逐条关节右乘 Π stage。
 * @param {THREE.Object3D} root 模型根（调用方自己的克隆；导出件别传进来）
 * @param {object[]} articulations meta.articulations
 * @param {Object<string, number[]|Object<string, number>>|null} [values] 关节名 → 各 stage 值（数组按 stages 顺序，或 {stage 名: 值}）；缺的取 initialValue
 * @param {{pose?:Map, resolve?:(names:Set<string>)=>Iterable<THREE.Object3D>, collapse?:boolean}} [o]
 *   pose：文件位姿表（Map<节点, {m, vis}>；同一份模型反复摆时传同一个，复原靠它）；
 *   resolve：关节节点名（IR 名）→ three 节点（视口按 irNodeTable 解析；缺省按原名）；
 *   collapse：缩放到 0 的节点怎么处理 —— 缺省（画面用）不写退化矩阵，节点保持此前的矩阵、visible = false
 *     （退化矩阵的法向矩阵求逆出 NaN，光照、阴影、BVH 拾取都会坏）；true（导入后分析用）真写 0 缩放并隐藏 ——
 *     threeToIR 不看 visible，零面积三角形在分割 / 质量特性里自动跳过，三角形编号不变。
 * @returns {Map} pose 表（第一次动某节点时记下它的文件位姿）
 */
export function poseArticulations(root, articulations, values, o = {}) {
  const pose = o.pose || new Map()
  restoreFilePose(pose)
  if (!root || !Array.isArray(articulations) || !articulations.length) return pose
  const resolve = o.resolve || resolveByName(root)
  for (const a of articulations) {
    if (!a || !Array.isArray(a.stages) || !a.stages.length || !Array.isArray(a.nodes) || !a.nodes.length) continue
    const v = values ? values[a.name] : null
    _A.identity()
    a.stages.forEach((s, i) => {
      const x = Array.isArray(v) ? v[i] : (v && typeof v === 'object' ? v[s.name] : undefined)
      const val = Number.isFinite(x) ? x : (Number.isFinite(s.initialValue) ? s.initialValue : 0)
      _A.multiply(stageMatrix(s.type, val, _S))
    })
    if (isIdentity(_A)) continue
    const zero = Math.abs(_A.determinant()) < 1e-15
    for (const n of resolve(new Set(a.nodes))) {
      if (!pose.has(n)) { n.updateMatrix(); pose.set(n, { m: n.matrix.clone(), vis: n.visible }) }
      if (zero) {
        n.visible = false
        if (o.collapse) { n.scale.set(0, 0, 0); n.updateMatrix() }
        continue
      }
      n.matrix.multiply(_A)
      n.matrix.decompose(n.position, n.quaternion, n.scale)
    }
  }
  return pose
}
/** 从关节元数据摆「加载时的位姿」（全部取 initialValue） */
export function applyRestPose(root, meta, o = {}) {
  return poseArticulations(root, meta && Array.isArray(meta.articulations) ? meta.articulations : null, null, o)
}

const _bm = new THREE.Matrix4()
/**
 * 精确包围盒：逐顶点、只算【实际可见】的网格（隐藏节点整棵子树不算）。顶点先乘网格世界矩阵，再左乘 pre（缺省单位阵）。
 * 为什么不用 Box3.setFromObject：缺省口径把各网格的局部包围盒八个角变过去再取外包，节点带旋转时偏大；precise 口径又不看显隐。
 * 同时出「离原点最远的顶点距离」（包围半径，离本体原点）。调用前世界矩阵要是新的（updateMatrixWorld）。
 * @param {THREE.Object3D} root
 * @param {THREE.Matrix4|null} [pre]
 * @returns {{min:number[], max:number[], radius:number, empty:boolean}}
 */
export function exactBox(root, pre = null) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, r2 = 0
  root.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return
    const p = o.geometry.attributes.position
    _bm.copy(o.matrixWorld)
    if (pre) _bm.premultiply(pre)
    const e = _bm.elements
    // 多材质网格拆出来的子网格（irToThree.splitMultiMaterial / 部件高亮：打 _borrowed）共享整份顶点缓冲，只算自己索引到的顶点，
    // 否则某个材质组被藏起来时别的组的点照样算进来；其余几何逐顶点扫一遍（比按索引少三倍）
    const idx = o.geometry.userData && o.geometry.userData._borrowed ? o.geometry.index : null
    const n = idx ? idx.count : p.count
    for (let k = 0; k < n; k++) {
      const i = idx ? idx.getX(k) : k
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const X = e[0] * x + e[4] * y + e[8] * z + e[12], Y = e[1] * x + e[5] * y + e[9] * z + e[13], Z = e[2] * x + e[6] * y + e[10] * z + e[14]
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z
      const d2 = X * X + Y * Y + Z * Z; if (d2 > r2) r2 = d2
    }
  })
  if (x0 > x1) return { min: [0, 0, 0], max: [0, 0, 0], radius: 0, empty: true }
  return { min: [x0, y0, z0], max: [x1, y1, z1], radius: Math.sqrt(r2), empty: false }
}

function mount(T, root, meta, mode) {
  const clone = root.clone(true)
  applyRestPose(clone, meta)   // 喷焰这类初值为 0 的关节件不进缩略图（STK 缺省也不显示）
  T.gpu.track(clone)
  modelToBodyMatrix(meta, T.holder.matrix)
  T.holder.matrixWorldNeedsUpdate = true
  T.holder.add(clone)
  T.scene.updateMatrixWorld(true)
  const pts = sampleWorldPoints(clone, 30000)
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2]
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  const center = pts.length ? new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2) : new THREE.Vector3()
  const radius = pts.length ? Math.max(1e-3, boundingRadius(pts, center.x, center.y, center.z)) : 1
  T.studio.setMode(mode === 'sun' ? 'sun' : 'studio')
  T.studio.fit(center, radius)
  return { clone, pts, center, radius }
}
function unmount(T, clone) {
  T.holder.remove(clone)
  T.gpu.releaseTree(clone, { kinds: ['geo', 'tex'], keepShared: true })
}

// ---------------------------------------------------------------------------------------------
// 自动取景方向（缩略图 / 预览「自动」视角共用：库卡片与点开后的第一眼是同一张脸）
// ---------------------------------------------------------------------------------------------
// 为什么不一律用固定的等轴（方位 35°、俯仰 25°）：模型各自的「好看的一面」不在同一侧——显示系天顶朝上（view.js），
// 通信星的电池面静止位朝天顶（从上方看得见），但也有电池面朝别处、或太阳翼顺着视线方向只剩一条线的件；固定一个方向，
// 库里总有一排缩略图只剩基板背面或一根杆。
// 口径：候选 = 四个 3/4 方位（35° + k·90°）× 俯仰 ±25° / ±40°；
//   得分 = 投影占格数（按面积撒的表面点落进固定世界格距的 32 × 32 栅格：看得见的面越大越好）× 电池片朝向加成（看得到电池面的方向加分）× 作者上方加成（+俯仰 × 1.06）。
// 纯函数、只读点集：点数 ≤ 3 万、候选 16 个，几毫秒。
const _CANDS = []
for (const az of [35, 125, 215, 305]) for (const el of [25, 40, -25, -40]) {
  const a = az * Math.PI / 180, e = el * Math.PI / 180
  _CANDS.push({ az, el, d: [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)] })
}
/**
 * 取景用的表面采样：按面积均匀撒点（顶点采样对大平板只落在四个角上，量不出「看得见的面积」）+ 电池片的面积加权平均朝向。
 * 大网格按步长抽三角形（只要面积分布与方向，不要精确），总计 ≤ 约 6 万个三角形参与，出 8000 个点。
 * 电池片认材质库键 solar_cell，或名字里带 solar / cell / 电池 的材质。坐标是世界系（= 显示系）。
 * @returns {{pts:Float32Array, cells:{n:number[]|null, share:number}}}
 */
export function viewSample(root, nOut = 8000) {
  root.updateMatrixWorld(true)
  const meshes = []
  let totalTris = 0
  root.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return
    const g = o.geometry
    totalTris += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3)
    meshes.push(o)
  })
  const step = Math.max(1, Math.ceil(totalTris / 60000))
  const tri = []   // [ax,ay,az, bx,by,bz, cx,cy,cz] × k
  const area = []
  let ax = 0, ay = 0, az = 0, cellA = 0, allA = 0
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3()
  for (const o of meshes) {
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    const isCell = mats.some((m) => m && ((m.userData && m.userData.materialKey === 'solar_cell') || /solar|cell|电池/i.test(m.name || '')))
    const g = o.geometry, p = g.attributes.position, idx = g.index
    const nt = Math.floor((idx ? idx.count : p.count) / 3)
    for (let t = 0; t < nt; t += step) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
      va.fromBufferAttribute(p, i0).applyMatrix4(o.matrixWorld); vb.fromBufferAttribute(p, i1).applyMatrix4(o.matrixWorld); vc.fromBufferAttribute(p, i2).applyMatrix4(o.matrixWorld)
      e1.subVectors(vb, va); e2.subVectors(vc, va); e1.cross(e2)   // |e1| = 2 × 面积，方向 = 面法向
      const a = e1.length() * 0.5 * step
      if (!(a > 0)) continue
      tri.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z); area.push(a)
      allA += a
      if (isCell) { ax += e1.x; ay += e1.y; az += e1.z; cellA += a }
    }
  }
  const l = Math.hypot(ax, ay, az)
  const cells = { n: l > 0 ? [ax / l, ay / l, az / l] : null, share: allA > 0 ? cellA / allA : 0 }
  const k = area.length
  if (!k) return { pts: new Float32Array(0), cells }
  // 按面积的累积分布 + 分层抽样（确定性：同一模型每次同一组点，缩略图可复现）
  const cum = new Float64Array(k)
  let acc = 0
  for (let i = 0; i < k; i++) { acc += area[i]; cum[i] = acc }
  const pts = new Float32Array(nOut * 3)
  let seed = 12345
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  let j = 0
  for (let s = 0; s < nOut; s++) {
    const target = ((s + rnd()) / nOut) * acc
    while (j < k - 1 && cum[j] < target) j++
    let u = rnd(), v = rnd()
    if (u + v > 1) { u = 1 - u; v = 1 - v }
    const b = j * 9
    for (let c = 0; c < 3; c++) pts[s * 3 + c] = tri[b + c] + (tri[b + 3 + c] - tri[b + c]) * u + (tri[b + 6 + c] - tri[b + c]) * v
  }
  return { pts, cells }
}
/**
 * @param {Float32Array} pts 显示系表面采样点（viewSample().pts）
 * @param {{n:number[]|null, share:number}} [cells] viewSample().cells
 * @returns {THREE.Vector3} 从目标指向相机的单位向量（显示系）
 */
export function autoViewDir(pts, cells, out = new THREE.Vector3()) {
  const N = pts.length / 3
  if (!N) return viewDir('iso', out)
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < N; i++) { cx += pts[i * 3]; cy += pts[i * 3 + 1]; cz += pts[i * 3 + 2] }
  cx /= N; cy /= N; cz /= N
  const r = Math.max(1e-6, boundingRadius(pts, cx, cy, cz))
  const G = 32, cellW = (2 * r) / G
  const occ = new Uint8Array(G * G)
  const f = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0)
  let best = null, bestS = -1
  for (const c of _CANDS) {
    f.fromArray(c.d)
    right.crossVectors(Y, f).normalize()
    up.crossVectors(f, right).normalize()
    occ.fill(0)
    let cnt = 0
    for (let i = 0; i < N; i++) {
      const px = pts[i * 3] - cx, py = pts[i * 3 + 1] - cy, pz = pts[i * 3 + 2] - cz
      const x = Math.floor((px * right.x + py * right.y + pz * right.z + r) / cellW)
      const y = Math.floor((px * up.x + py * up.y + pz * up.z + r) / cellW)
      if (x < 0 || y < 0 || x >= G || y >= G) continue
      const k = y * G + x
      if (!occ[k]) { occ[k] = 1; cnt++ }
    }
    let s = cnt * (c.el > 0 ? 1.06 : 1)
    if (cells && cells.n && cells.share > 0.05) s *= 1 + 1.2 * Math.min(1, cells.share * 2.5) * Math.max(0, f.dot(Y.set(cells.n[0], cells.n[1], cells.n[2])))
    Y.set(0, 1, 0)
    if (s > bestS) { bestS = s; best = c }
  }
  return out.fromArray(best.d).normalize()
}

/** 模型根（已挂进场景、世界矩阵是显示系）→ 自动取景方向 */
export function autoViewFor(root, out) { const v = viewSample(root); return autoViewDir(v.pts, v.cells, out) }

async function toBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality })
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 失败'))), type, quality))
}
function canvas2d(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  return Object.assign(document.createElement('canvas'), { width: w, height: h })
}

/**
 * 缩略图：3/4 视角（缺省自动取景 autoViewDir；o.view 可点名 iso / front …）、按采样点取景留 8% 边、透明底、影棚光、ACES。
 * @param {THREE.Object3D} root 模型根（模型系）
 * @param {object} meta ModelMeta（取 frame 与 units）
 * @param {{size?:number, mode?:'studio'|'sun', view?:string, type?:string, quality?:number, supersample?:number}} [o]
 * @returns {Promise<Blob>} image/webp（浏览器不支持 WebP 时会静默退 PNG：调用方按 blob.type 判）
 */
export function renderThumb(root, meta, o = {}) {
  return serial(() => {
    const size = o.size || 512
    const ss = Math.max(1, Math.min(3, o.supersample || 2))
    const W = size * ss
    const T = ctx(W, W)
    const { clone, pts } = mount(T, root, meta, o.mode)
    let out
    try {
      const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 1000)
      const dir = o.view && o.view !== 'auto' ? viewDir(o.view) : autoViewFor(clone)
      T.studio.orient(rigOrientFor(dir, ISO, _rq))   // 灯组随取景方向转：从下方取景的星同样是正面布光
      const fit = fitPerspective(pts, dir, cam.fov, 1, 0.08)
      cam.position.copy(fit.target).addScaledVector(dir, fit.dist)
      cam.near = Math.max(1e-3, (fit.dist - fit.radius * 2) * 0.5, fit.dist * 0.01)
      cam.far = fit.dist + fit.radius * 4
      cam.lookAt(fit.target)
      cam.updateProjectionMatrix()
      T.renderer.setClearColor(0x000000, 0)
      T.renderer.render(T.scene, cam)
      out = canvas2d(size, size)
      const c = out.getContext('2d')
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'
      c.drawImage(T.canvas, 0, 0, size, size)
    } finally { T.studio.orient(_q0); unmount(T, clone) }   // 画面已经拷进 2D 画布：编码之前就摘模型
    return toBlob(out, o.type || 'image/webp', o.quality ?? 0.9)
  })
}

// ---------------------------------------------------------------------------------------------
// 三视图 + 透视（报告出图）
// ---------------------------------------------------------------------------------------------
const AXIS_CSS = { X: '#d8363c', Y: '#1f8f58', Z: '#2f55cc' }
// 三视图按【本体轴】取（view.js 的 BODY_VIEWS：前 / 侧视天顶朝上、顶视速度 +X 朝上），与显示系怎么摆无关 ——
// 标题写的就是拍摄方向：「前视（+X）」相机在本体 +X、「侧视（+Y）」在 +Y、「顶视（−Z）」在天顶往天底看（单测逐格核对）。
const VIEWS3 = Object.freeze([
  Object.freeze({ key: 'front', title: '前视（+X）', body: 'front', dir: BODY_VIEWS.front.dir, up: BODY_VIEWS.front.up }),
  Object.freeze({ key: 'right', title: '侧视（+Y）', body: 'side', dir: BODY_VIEWS.side.dir, up: BODY_VIEWS.side.up }),
  Object.freeze({ key: 'top', title: '顶视（−Z）', body: 'top', dir: BODY_VIEWS.top.dir, up: BODY_VIEWS.top.up })
])
/** 报告三视图的三格（标题与拍摄方向：body = BODY_VIEWS 的键；单测核对标题里的轴 = 相机所在的本体轴） */
export const THREE_VIEW_CELLS = VIEWS3
// 挂点名排位的候选：朝外方向（格心 → 锚点）左右各偏 25° 一档直到背向，引线长按基准的倍数（3 / 4 倍是给挤的时候
// 把名字拉到格里上下的空白带）
const CALLOUT_ANG = Object.freeze([0, 25, -25, 50, -50, 75, -75, 100, -100, 130, -130, 160, -160, 180])
const CALLOUT_LEN = Object.freeze([1, 0.6, 1.5, 0.3, 2.1, 3, 4])
const rectOverlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
// 线段 (x0,y0)-(x1,y1) 是否穿过矩形内部（Liang–Barsky 裁剪，只擦到边不算）
function segHitsRect(x0, y0, x1, y1, r) {
  let t0 = 0, t1 = 1
  const dx = x1 - x0, dy = y1 - y0
  const P = [-dx, dx, -dy, dy], Q = [x0 - r[0], r[2] - x0, y0 - r[1], r[3] - y0]
  for (let k = 0; k < 4; k++) {
    if (P[k] === 0) { if (Q[k] <= 0) return false; continue }
    const t = Q[k] / P[k]
    if (P[k] < 0) { if (t > t0) t0 = t } else if (t < t1) t1 = t
    if (t0 >= t1) return false
  }
  return t1 - t0 > 1e-6
}
// 两条线段真相交（共端点、共线不算）
function segCross(a, b) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
  const d1 = o(b[0], b[1], b[2], b[3], a[0], a[1]), d2 = o(b[0], b[1], b[2], b[3], a[2], a[3])
  const d3 = o(a[0], a[1], a[2], a[3], b[0], b[1]), d4 = o(a[0], a[1], a[2], a[3], b[2], b[3])
  return d1 * d2 < 0 && d3 * d4 < 0
}
function segPointDist(x0, y0, x1, y1, px, py) {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0
  return Math.hypot(x0 + dx * t - px, y0 + dy * t - py)
}

/**
 * 挂点名排位（报告三视图用；纯函数，不碰画布）。每个锚点在格内找一处放名字矩形：
 *   硬约束 —— 整块落在 box 内缩 pad 的范围里（越界的候选整块往里推，贴右沿的名字就此改成向内）；不压 obstacles、已放的名字、
 *            已放的引线、任何锚点（含自己的）；引线不穿已放的名字。都满足不了时取「压得最少」的一处（宁叠不丢），ok = false。
 *   代价 —— 偏离朝外方向、引线长偏离基准、被推移的距离、压模型的比例（cover）、与已放引线交叉、引线擦过别的锚点、引线穿占位。
 * 离格心远的锚点先排（贴边的可选位置少）；同一输入结果确定。
 * @param {{x:number,y:number,w:number,h:number}[]} items 锚点像素坐标与名字矩形宽高（w / h 为 0 = 无名字，只当障碍）
 * @param {{box:number[], pad?:number, gap?:number, dot?:number, lead?:number, center?:number[], obstacles?:number[][],
 *          cover?:(r:number[])=>number}} o box / obstacles 为 [x0,y0,x1,y1]；cover 返回矩形里模型像素的占比 0–1
 * @returns {({rect:number[], lx:number, ly:number, align:'left'|'right'|'center', ok:boolean}|null)[]} 与 items 同序；
 *          lx / ly = 引线终点（名字矩形上离锚点最近的点）；无名字的项为 null
 */
export function placeCallouts(items, o = {}) {
  const box = Array.isArray(o.box) ? o.box : [0, 0, 0, 0]
  const pad = o.pad > 0 ? o.pad : 0, gap = o.gap > 0 ? o.gap : 0, dot = o.dot > 0 ? o.dot : 0
  const lead = o.lead > 0 ? o.lead : 40
  const obst = Array.isArray(o.obstacles) ? o.obstacles : []
  const cover = typeof o.cover === 'function' ? o.cover : null
  const [cx, cy] = Array.isArray(o.center) ? o.center : [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
  const L0 = box[0] + pad, R0 = box[2] - pad, T0 = box[1] + pad, B0 = box[3] - pad
  const anchors = items.map((it) => [it.x - dot, it.y - dot, it.x + dot, it.y + dot])
  // 贪心一趟；有没排开的（ok = false）就把它们挪到最前面再排一趟（先占位的先挑），最多三趟，取「没排开的最少、总代价最小」的一趟
  let order = items.map((_, i) => i).sort((a, b) =>
    (Math.hypot(items[b].x - cx, items[b].y - cy) - Math.hypot(items[a].x - cx, items[a].y - cy)) || a - b)
  let best = null
  for (let pass = 0; pass < 3; pass++) {
    const r = placePass(order)
    if (!best || r.fails.length < best.fails.length || (r.fails.length === best.fails.length && r.cost < best.cost - 1e-9)) best = r
    if (!r.fails.length) break
    const f = new Set(r.fails)
    const next = [...r.fails, ...order.filter((i) => !f.has(i))]
    if (next.every((v, k) => v === order[k])) break
    order = next
  }
  return best.out

  // 按给定顺序贪心排一趟
  function placePass(order) {
    const out = items.map(() => null)
    const placed = [], leads = [], fails = []
    let total = 0
    for (const i of order) {
      const it = items[i]
      if (!(it.w > 0 && it.h > 0)) continue
      const w = Math.min(it.w, Math.max(0, R0 - L0)), h = Math.min(it.h, Math.max(0, B0 - T0))
      const th0 = Math.hypot(it.x - cx, it.y - cy) > 1e-6 ? Math.atan2(it.y - cy, it.x - cx) : -Math.PI / 4
      let pick = null
      for (const ad of CALLOUT_ANG) {
        const th = th0 + ad * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th)
        for (const lk of CALLOUT_LEN) {
          const ex = it.x + cs * lead * lk, ey = it.y + sn * lead * lk
          let r, align
          if (cs > 0.34) { align = 'left'; r = [ex + gap, ey - h / 2, ex + gap + w, ey + h / 2] }
          else if (cs < -0.34) { align = 'right'; r = [ex - gap - w, ey - h / 2, ex - gap, ey + h / 2] }
          else { align = 'center'; r = sn < 0 ? [ex - w / 2, ey - gap - h, ex + w / 2, ey - gap] : [ex - w / 2, ey + gap, ex + w / 2, ey + gap + h] }
          const sx = r[0] < L0 ? L0 - r[0] : (r[2] > R0 ? R0 - r[2] : 0)
          const sy = r[1] < T0 ? T0 - r[1] : (r[3] > B0 ? B0 - r[3] : 0)
          r = [r[0] + sx, r[1] + sy, r[2] + sx, r[3] + sy]
          const lx = Math.min(r[2], Math.max(r[0], it.x)), ly = Math.min(r[3], Math.max(r[1], it.y))
          // 硬约束：压到的面积（占位 / 已放名字 / 锚点）+ 引线穿名字（按名字面积计）
          let bad = 0
          for (const q of obst) bad += rectOverlap(r, q)
          for (const q of placed) { bad += rectOverlap(r, q); if (segHitsRect(it.x, it.y, lx, ly, q)) bad += (q[2] - q[0]) * (q[3] - q[1]) }
          for (const sg of leads) if (segHitsRect(sg[0], sg[1], sg[2], sg[3], r)) bad += w * h   // 名字压在先放的引线上（线从字里穿过去）
          for (const q of anchors) bad += rectOverlap(r, q)
          let cost = Math.abs(ad) / 60 + Math.abs(lk - 1) * 0.35 + (Math.abs(sx) + Math.abs(sy)) / Math.max(1, h) * 0.3
          if (cover) cost += Math.max(0, Math.min(1, cover(r) || 0)) * 2.5
          for (const sg of leads) if (segCross([it.x, it.y, lx, ly], sg)) cost += 1.5
          for (let k = 0; k < items.length; k++) if (k !== i && segPointDist(it.x, it.y, lx, ly, items[k].x, items[k].y) < dot) cost += 1
          for (const q of obst) if (segHitsRect(it.x, it.y, lx, ly, q)) cost += 0.8
          const key = bad > 0 ? 1e6 + bad : cost
          if (!pick || key < pick.key) pick = { key, rect: r, lx, ly, align, ok: bad === 0 }
        }
      }
      placed.push(pick.rect)
      leads.push([it.x, it.y, pick.lx, pick.ly])
      out[i] = { rect: pick.rect, lx: pick.lx, ly: pick.ly, align: pick.align, ok: pick.ok }
      if (!pick.ok) fails.push(i)
      total += pick.ok ? pick.key : 0
    }
    return { out, fails, cost: total }
  }
}

/**
 * 名字逐行折到 maxW 以内（measure(t) → 像素宽）。有空格优先在空格处断，否则逐字断（中文没有空格）；一个字都放不下也至少放一个字。
 * @returns {string[]}
 */
export function wrapLabel(s, maxW, measure) {
  const chars = Array.from(String(s == null ? '' : s))
  const lines = []
  let cur = ''
  for (const ch of chars) {
    const next = cur + ch
    if (!cur || measure(next) <= maxW) { cur = next; continue }
    const sp = cur.lastIndexOf(' ')
    if (ch !== ' ' && sp > 0) { lines.push(cur.slice(0, sp)); cur = cur.slice(sp + 1) + ch }
    else { lines.push(cur.trimEnd()); cur = ch === ' ' ? '' : ch }
  }
  if (cur.trim()) lines.push(cur.trim())
  return lines.length ? lines : ['']
}

// 渲染画布的模型占位（alpha > 24 算模型）：缩到 1/4 边长取 alpha，积分图常数时间求任一矩形里模型像素的占比。
// 读的是另开的小画布（willReadFrequently），不在出图的 2D 画布上 getImageData —— 那会把它切到 CPU 光栅、抗锯齿换档。
function coverageOf(src, W, H) {
  const S = 4, w = Math.max(1, Math.ceil(W / S)), h = Math.max(1, Math.ceil(H / S))
  let d
  try {
    const cv = canvas2d(w, h)
    const g = cv.getContext('2d', { willReadFrequently: true })
    g.drawImage(src, 0, 0, w, h)
    d = g.getImageData(0, 0, w, h).data
  } catch { return null }
  const I = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) { row += d[(y * w + x) * 4 + 3] > 24 ? 1 : 0; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row }
  }
  const cl = (v, n) => Math.max(0, Math.min(n, v))
  return (r) => {
    const x0 = cl(Math.floor(r[0] / S), w), x1 = cl(Math.ceil(r[2] / S), w), y0 = cl(Math.floor(r[1] / S), h), y1 = cl(Math.ceil(r[3] / S), h)
    const a = (x1 - x0) * (y1 - y0)
    if (a <= 0) return 0
    return (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / a
  }
}

function niceLen(x) {
  const e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * e
}
function fmtM(v) { return v >= 1 ? String(+v.toFixed(2)) + ' m' : v >= 0.01 ? String(+(v * 100).toFixed(1)) + ' cm' : String(+(v * 1000).toFixed(1)) + ' mm' }

/**
 * 三视图（前 / 侧 / 顶，正交、同一比例尺）+ 透视，四宫格 PNG，透明底。
 * 叠：各格标题、本体轴三角（投影到该视平面的方向，指向观者的轴画圆点、背离的画叉）、挂点引线与名称、米制比例尺。
 * 取景把挂点一并框进去；挂点名按实测字宽排进格内（placeCallouts），不会被格边截掉。
 * @param {THREE.Object3D} root
 * @param {object} meta ModelMeta（frame / units / attachPoints）
 * @param {{cell?:number, font?:string, ink?:string, halo?:string, titles?:string[]}} [o] titles：四格标题（前 / 侧 / 顶 / 透视），缺省中文
 * @returns {Promise<Blob>} image/png
 */
export function renderThreeView(root, meta, o = {}) {
  return serial(() => {
    const out = drawThreeView(root, meta, o)
    return toBlob(out, 'image/png')
  })
}

// 同步画完四宫格 + 2D 叠加，返回 2D 画布（serial 里调；GPU 状态在 finally 里全部复原，出错也不留给下一张）
function drawThreeView(root, meta, o) {
  const cell = o.cell || 640
  const W = cell * 2, H = cell * 2
  const T = ctx(W, H)
  const font = o.font || '"Microsoft YaHei", "Segoe UI", Arial, sans-serif'
  const ink = o.ink || '#2b2d31', halo = o.halo || 'rgba(255,255,255,0.9)'
  const { clone, pts, center, radius } = mount(T, root, meta, 'studio')
  const r = T.renderer
  const envI = T.scene.environmentIntensity
  try {
    r.setClearColor(0x000000, 0)
    // 正交视图是平行光线：玻璃盖片 / 金属面整面映到环境里同一个方向（俯视时正是影棚顶灯），会糊成一片白。
    // 制图用环境压到 0.2 倍（0.45 倍时俯视的电池片仍整片映成灰白），主光与补光照旧 —— 只为读形状，不追求光泽；透视格同样处理，四格观感一致。
    T.scene.environmentIntensity = envI * 0.2
    r.setScissorTest(true)
    r.setViewport(0, 0, W, H); r.setScissor(0, 0, W, H); r.clear()
    // 挂点（本体系 → 显示系世界坐标）一并进取景：挂点在模型外（尺寸未核定的件、挂点按真实尺寸填）时，点、引线与名字照样落在格内
    const aps = meta && Array.isArray(meta.attachPoints)
      ? meta.attachPoints.filter((a) => a && Array.isArray(a.posBody) && a.posBody.length === 3 && a.posBody.every(Number.isFinite))
      : []
    const apW = aps.map((a) => new THREE.Vector3().fromArray(a.posBody).applyMatrix4(BODY_TO_DISPLAY))
    let fitPts = pts
    if (apW.length) {
      fitPts = new Float32Array(pts.length + apW.length * 3)
      fitPts.set(pts)
      apW.forEach((w, k) => { fitPts[pts.length + k * 3] = w.x; fitPts[pts.length + k * 3 + 1] = w.y; fitPts[pts.length + k * 3 + 2] = w.z })
    }
    // 统一比例尺：三视图各自投影范围里取最大的那个，四周留 10%
    const basis = VIEWS3.map((v) => {
      const d = new THREE.Vector3().fromArray(v.dir).normalize(), up = new THREE.Vector3().fromArray(v.up)
      const right = new THREE.Vector3().crossVectors(d.clone().negate(), up).normalize()
      const u = new THREE.Vector3().crossVectors(right, d.clone().negate()).normalize()
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (let i = 0; i < fitPts.length; i += 3) {
        const x = fitPts[i] * right.x + fitPts[i + 1] * right.y + fitPts[i + 2] * right.z
        const y = fitPts[i] * u.x + fitPts[i + 1] * u.y + fitPts[i + 2] * u.z
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      }
      return { ...v, d, up: u, right, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hw: (x1 - x0) / 2, hh: (y1 - y0) / 2 }
    })
    const half = Math.max(1e-3, ...basis.map((b) => Math.max(b.hw, b.hh))) * 1.22   // 每格半宽（米）
    const mPerPx = (2 * half) / cell
    const cells = [[0, 0], [1, 0], [0, 1]]   // 左上 前视、右上 侧视、左下 顶视、右下 透视
    const ortho = new THREE.OrthographicCamera(-half, half, half, -half, radius * 0.1, radius * 8)
    const proj = []   // 每格：世界 → 该格像素（2D 叠加用）
    basis.forEach((b, i) => {
      const [cx, cy] = cells[i]
      const tgt = new THREE.Vector3().addScaledVector(b.right, b.cx).addScaledVector(b.up, b.cy)
      // 目标点沿视向的分量取包围中心（相机要站在模型外）
      tgt.addScaledVector(b.d, center.dot(b.d) - tgt.dot(b.d))
      ortho.position.copy(tgt).addScaledVector(b.d, radius * 3)
      ortho.up.copy(b.up)
      ortho.lookAt(tgt)
      ortho.updateProjectionMatrix(); ortho.updateMatrixWorld()
      // 每格灯组按该格相机转（含屏幕上方）：顶视从天顶看、前 / 侧视天顶朝上，各格都是左上主光的制图布光
      T.studio.orient(rigOrientFor(b.d, ISO, _rq, b.up))
      const vy = H - (cy + 1) * cell   // WebGL 视口原点在左下
      r.setViewport(cx * cell, vy, cell, cell); r.setScissor(cx * cell, vy, cell, cell)
      r.render(T.scene, ortho)
      proj.push({ cam: ortho.clone(), x: cx * cell, y: cy * cell, b })
    })
    // 透视格
    const pc = new THREE.PerspectiveCamera(30, 1, 0.01, 1000)
    const dir = autoViewFor(clone)
    T.studio.orient(rigOrientFor(dir, ISO, _rq))
    const fit = fitPerspective(fitPts, dir, pc.fov, 1, 0.1)
    pc.position.copy(fit.target).addScaledVector(dir, fit.dist)
    pc.near = Math.max(1e-3, fit.dist * 0.01); pc.far = fit.dist + fit.radius * 4
    pc.lookAt(fit.target); pc.updateProjectionMatrix(); pc.updateMatrixWorld()
    r.setViewport(cell, 0, cell, cell); r.setScissor(cell, 0, cell, cell)
    r.render(T.scene, pc)
    proj.push({ cam: pc, x: cell, y: cell, b: null })

    // ---- 2D 叠加 ----
    const out = canvas2d(W, H)
    const c = out.getContext('2d')
    c.drawImage(T.canvas, 0, 0)
    const cover = coverageOf(T.canvas, W, H)   // 模型占位（渲染出的 alpha）：挂点名尽量落在空白处
    const fs = Math.round(cell / 40)
    const text = (s, x, y, color = ink, align = 'left', bold = false, size = fs) => {
      c.font = `${bold ? 600 : 400} ${size}px ${font}`; c.textAlign = align; c.textBaseline = 'middle'
      c.lineJoin = 'round'; c.lineWidth = Math.max(3, size * 0.28); c.strokeStyle = halo; c.strokeText(s, x, y)
      c.fillStyle = color; c.fillText(s, x, y)
    }
    const v = new THREE.Vector3()
    const toPx = (P, p) => { v.copy(p).project(P.cam); return [P.x + (v.x * 0.5 + 0.5) * cell, P.y + (0.5 - v.y * 0.5) * cell, v.z] }
    // 格线
    c.strokeStyle = 'rgba(120,124,130,0.55)'; c.lineWidth = 1
    c.beginPath(); c.moveTo(cell + 0.5, 0); c.lineTo(cell + 0.5, H); c.moveTo(0, cell + 0.5); c.lineTo(W, cell + 0.5); c.stroke()
    // 每格的占位（格标题 / 轴三角 / 比例尺）：挂点名与它们不相交
    const obst = proj.map(() => [])
    const titles = Array.isArray(o.titles) && o.titles.length >= 4 ? o.titles.slice(0, 4).map((x) => String(x == null ? '' : x)) : [...VIEWS3.map((x) => x.title), '透视']
    proj.forEach((P, i) => {
      text(titles[i], P.x + fs, P.y + fs * 1.2, ink, 'left', true)
      c.font = `600 ${fs}px ${font}`
      // 标题带宽取「标题实宽」与 0.47 格宽的大者：lbBodyLayout.relabelViews（英文报告）会清掉左上 0.45 格宽 × 2.2 字高重写标题
      obst[i].push([P.x, P.y, P.x + Math.max(c.measureText(titles[i]).width + fs * 1.6, cell * 0.47), P.y + fs * 2.5])
    })
    // 本体轴三角：每格左下
    const axes = [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]]
    for (const [i, P] of proj.entries()) {
      const ox = P.x + fs * 4.5, oy = P.y + cell - fs * 4.5, L = fs * 2.4
      obst[i].push([ox - fs * 4.3, oy - fs * 4.3, ox + fs * 4.3, oy + fs * 4.3])   // 箭长 2.4 + 轴名外推 0.8 + 半字宽，四向都够
      const camQ = P.cam.quaternion.clone().invert()
      for (const [nm, a] of axes) {
        const d = new THREE.Vector3(a[0], a[1], a[2]).applyMatrix4(BODY_TO_DISPLAY).applyQuaternion(camQ)
        const len = Math.hypot(d.x, d.y)
        c.strokeStyle = AXIS_CSS[nm]; c.fillStyle = AXIS_CSS[nm]; c.lineWidth = Math.max(2, fs * 0.14)
        if (len < 0.2) {
          // 轴垂直于视平面：指向观者画圆点、背离观者画叉（工程制图惯例）
          c.beginPath(); c.arc(ox, oy, fs * 0.45, 0, Math.PI * 2); c.stroke()
          if (d.z > 0) { c.beginPath(); c.arc(ox, oy, fs * 0.14, 0, Math.PI * 2); c.fill() }
          else { const k = fs * 0.3; c.beginPath(); c.moveTo(ox - k, oy - k); c.lineTo(ox + k, oy + k); c.moveTo(ox + k, oy - k); c.lineTo(ox - k, oy + k); c.stroke() }
          text(nm, ox + fs * 0.7, oy - fs * 0.6, AXIS_CSS[nm], 'left', true)
        } else {
          const ex = ox + d.x * L, ey = oy - d.y * L
          c.beginPath(); c.moveTo(ox, oy); c.lineTo(ex, ey); c.stroke()
          const ang = Math.atan2(ey - oy, ex - ox), hk = fs * 0.5
          c.beginPath(); c.moveTo(ex, ey); c.lineTo(ex - hk * Math.cos(ang - 0.4), ey - hk * Math.sin(ang - 0.4)); c.lineTo(ex - hk * Math.cos(ang + 0.4), ey - hk * Math.sin(ang + 0.4)); c.closePath(); c.fill()
          text(nm, ex + Math.cos(ang) * fs * 0.8, ey + Math.sin(ang) * fs * 0.8, AXIS_CSS[nm], 'center', true)
        }
      }
    }
    // 比例尺（三个正交格同一比例）：约占格宽 22%，取 1 / 2 / 5 × 10ⁿ 米
    const lenM = niceLen(mPerPx * cell * 0.22), lenPx = lenM / mPerPx
    for (const [i, P] of proj.slice(0, 3).entries()) {
      const x1 = P.x + cell - fs * 1.5, x0 = x1 - lenPx, y = P.y + cell - fs * 2
      c.strokeStyle = ink; c.lineWidth = Math.max(2, fs * 0.12)
      c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.moveTo(x0, y - fs * 0.4); c.lineTo(x0, y + fs * 0.4); c.moveTo(x1, y - fs * 0.4); c.lineTo(x1, y + fs * 0.4)
      c.moveTo((x0 + x1) / 2, y - fs * 0.25); c.lineTo((x0 + x1) / 2, y + fs * 0.25); c.stroke()
      text(fmtM(lenM), (x0 + x1) / 2, y - fs * 0.9, ink, 'center')
      c.font = `400 ${fs}px ${font}`
      const lw = c.measureText(fmtM(lenM)).width
      obst[i].push([Math.min(x0, (x0 + x1) / 2 - lw / 2) - fs * 0.5, y - fs * 1.7, P.x + cell, P.y + cell])
    }
    // 挂点：点 + 引线 + 名称。名字按实测字宽排（placeCallouts）：整块落在格内、不压标题 / 轴三角 / 比例尺 / 别的名字与锚点、
    // 引线不穿别的名字，尽量朝外、少压模型；格宽放不下的名字先缩字号（≥ 0.72 倍）再逐字折行 —— 出图里没有被格边截掉的字
    const pad = fs * 0.4, padX = fs * 0.3, lineK = 1.3
    const labelOf = (name) => {
      const s = String(name == null ? '' : name).trim()
      if (!s) return null
      const maxW = cell - 2 * pad - 2 * padX
      let size = fs
      c.font = `400 ${size}px ${font}`
      let tw = c.measureText(s).width
      if (tw > maxW) {
        size = Math.max(Math.round(fs * 0.72), Math.floor(fs * maxW / tw))
        c.font = `400 ${size}px ${font}`
        tw = c.measureText(s).width
      }
      const measure = (t) => c.measureText(t).width
      const lines = tw > maxW ? wrapLabel(s, maxW, measure) : [s]
      const w = Math.max(...lines.map(measure)) + 2 * padX
      return { size, lines, w, h: lines.length * size * lineK }
    }
    const labels = aps.map((a) => labelOf(a.name))
    const LEAD = '#b7791f', DOT_FILL = '#e8a33a', DOT_EDGE = '#7a4d0c'
    for (const [i, P] of proj.entries()) {
      const items = [], lab = []
      for (let k = 0; k < aps.length; k++) {
        const [px, py] = toPx(P, apW[k])
        if (!(px >= P.x - 0.5 && px <= P.x + cell + 0.5 && py >= P.y - 0.5 && py <= P.y + cell + 0.5)) continue   // 取景已纳入挂点，出格只会是数值病例
        items.push({ x: px, y: py, w: labels[k] ? labels[k].w : 0, h: labels[k] ? labels[k].h : 0 })
        lab.push(labels[k])
      }
      if (!items.length) continue
      const res = placeCallouts(items, {
        box: [P.x, P.y, P.x + cell, P.y + cell], pad, obstacles: obst[i], center: [P.x + cell / 2, P.y + cell / 2],
        lead: cell * 0.12, gap: fs * 0.25, dot: fs * 0.45, cover
      })
      c.save(); c.beginPath(); c.rect(P.x, P.y, cell, cell); c.clip()
      // 先引线、再锚点、最后名字：名字压在所有引线之上
      c.strokeStyle = LEAD; c.lineWidth = Math.max(1.5, fs * 0.08)
      c.beginPath()
      items.forEach((it, k) => { const q = res[k]; if (q && Math.hypot(q.lx - it.x, q.ly - it.y) > fs * 0.3) { c.moveTo(it.x, it.y); c.lineTo(q.lx, q.ly) } })
      c.stroke()
      for (const it of items) {
        c.fillStyle = DOT_FILL; c.beginPath(); c.arc(it.x, it.y, fs * 0.28, 0, Math.PI * 2); c.fill()
        c.strokeStyle = DOT_EDGE; c.lineWidth = 1; c.stroke()
      }
      items.forEach((it, k) => {
        const q = res[k], L = lab[k]
        if (!q || !L) return
        const [x0, y0, x1, y1] = q.rect
        // 挤到排不开（宁叠不丢）时，被别的引线穿过的名字垫一块底色：线不从字里穿过去（排得开时不会有这种名字）
        const crossed = !res.every((p, j) => j === k || !p || !segHitsRect(items[j].x, items[j].y, p.lx, p.ly, q.rect))
        if (!q.ok || crossed) { c.fillStyle = halo; c.fillRect(x0, y0, x1 - x0, y1 - y0) }
        const tx = q.align === 'right' ? x1 - padX : (q.align === 'center' ? (x0 + x1) / 2 : x0 + padX)
        L.lines.forEach((ln, j) => text(ln, tx, y0 + L.size * lineK * (j + 0.5), DOT_EDGE, q.align, false, L.size))
      })
      c.restore()
    }
    return out
  } finally {
    r.setScissorTest(false)
    r.setViewport(0, 0, W, H)
    T.studio.orient(_q0)
    T.scene.environmentIntensity = envI
    unmount(T, clone)
  }
}
