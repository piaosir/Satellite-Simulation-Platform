// 模型工作台预览视口（DESIGN §5.4）：独立 renderer、OrbitControls、右上角轴球、叠加层（本体轴 / LVLH / 挂点 / 质心 /
// 部件着色 / 节点着色 / 线框 / 地面网格 / 标签）、表面拾取（three-mesh-bvh）、按需渲染；二期起加后处理画质管线。
//
// 坐标：model（glb 原坐标）→ holder（meta.frame × 缩放 → 本体系）→ bodyRoot（本体系 → 显示系，天顶朝上、地球在下，见 view.js）→ 世界。
//   叠加层用本体系坐标（挂点 posBody / 质心 comBody 原样放）；拾取结果也换回本体系交出去。见 view.js 头注释。
//
// ─────────────── 画质管线（setQuality）───────────────
//   low   直接画到画布（上下文自带 MSAA），无后处理 —— 弱 GPU / 超大模型交互用。
//   high  主场景画进多重采样的半浮点离屏目标（MSAA 4×，HDR 线性）→ GTAO 环境光遮蔽（半分辨率，泊松去噪）→ OutputPass
//         （ACES + sRGB）上屏；再在画布上直接叠「不该吃 AO 的」叠加层（本体轴、挂点、质心、标签、拾取标记）与轴球。
//   ultra 同 high，MSAA 8×（GPU 支持时）、AO 全分辨率、阴影贴图 4096。
//   ★ 为什么自己串三步而不用 EffectComposer：它的读写两块缓冲都会克隆成多重采样目标，1.5 倍像素比下光这两块就一百多 MB；
//     这里只有主场景那一块是 MSAA，AO 输出到一块普通目标，显存省一半。
//   ★ AO 只算模型：GTAO 自己会再画一遍法向 / 深度（覆盖材质），叠加层与地面进去会被当成几何（精灵画成方块、地面把模型底部压黑），
//     所以按图层分：0 = 模型（投影、AO）、1 = 场景内叠加（部件 / 节点着色、线框：要与模型做深度比较）、2 = 地面（网格、阴影承接面、接触阴影）。
//     GTAO 那一遍把相机图层临时收成只看 0。
//   ★ 大模型交互降级：总三角形数过 AUTO_LOD_TRIS 时，拖动 / 缩放期间先不算 AO（少画一整遍法向），停手后补一帧带 AO 的
//     —— CAD 查看器的「交互粗、静止精」口径，百万面的 ISS 转起来不掉帧。
//
// ─────────────── 接地（影棚档）───────────────
//   主光的投影落在侧面、离模型有一段；真正让模型「坐」在地上的是正下方那一片柔和的接触阴影：从地面朝上正交拍一张模型深度
//   （越近越黑），两遍高斯模糊后贴在地面上（three 官方 contact shadows 的做法）。只在模型 / 轴向 / 关节变了时重拍，不逐帧。
//
// 按需渲染：静止不空转。只在 invalidate() 时排一帧；OrbitControls 阻尼期间 update() 返回 true 就续排下一帧。
// 逐帧零分配：帧函数里只用预分配的向量；标签按屏幕像素定尺用 sizeAttenuation:false 的精灵，尺寸只在 resize 时算一次。
// dispose 完整：几何、材质、贴图（本视口造的）、PMREM、阴影贴图、后处理目标与通道、控件与 DOM 监听、ResizeObserver、BVH Worker、
//   renderer 上下文；以及共享资源（材质库、loader 模板的几何 / 贴图）上本 renderer 挂的 dispose 监听（gpuRelease.js）。
// 模型：setModel(root) 内部 clone(true) 一份来挂（节点树各一份、几何 / 材质共享）。关节滑杆只驱动这份克隆。
// 关节位姿：挂上就摆到「加载时的位姿」（各 stage 的 initialValue，thumbs.js poseArticulations，与缩略图 / 导入后分析同一份）——
//   STK 件的喷焰是初值 0 的缩放关节，按文件位姿画就满屏火焰。滑杆值按关节名记在视口里（artLive），元数据每改一格重喂时
//   先回文件位姿、再按「滑杆值 ‖ 初值」重摆，预览与滑杆始终一致；换模型清空，同一模型换 LOD（keepPose）保留。
// 包围盒：逐顶点精确算（thumbs.exactBox，只算可见件、按关节初值位姿），只在几何 / 轴向 / 缩放 / 关节初值变了时重算；
//   采样点（≤ 2 万）只拿来取景。同一趟另出「模型轴、米」的包围盒（bounds.bboxModelM，轴映射终案 ④：落盘的 geometry.bboxM 是它）。
//
// ─────────────── 二期叠加（DESIGN2 §2 / §3，任务书 §6.1 / §6.4）───────────────
//   挂点（mount，卫星绑定上的天线安装位）：setMounts(list) 之后「挂点」叠加改画 mount —— 小圆盘（垂直视轴）+ 视轴射线 +
//     视场锥（半角 = coneHalfDeg：fovDeg/2 或方向图 −3 dB 半宽，由调用方算好传进来）+ 名称；选中的换色放大、射线加长、画上向。
//     点在圆盘 / 射线端附近（屏幕 14 px 内）= 点选该挂点（onMountPick 回调，与表格选中联动）。setMounts(null) 回到画模型挂点。
//   关节联动：挂在关节节点（或其子孙）上的挂点 / mount（attach point 的 node）随关节滑杆走：叠加件装在一个随动组里，
//     组矩阵 = 本体系位姿增量 H·N_now·N_file⁻¹·H⁻¹（H = 模型系 → 本体系，N = 节点相对模型根的局部链），滑杆一动只改矩阵、不重建。
//   掩模球面片（setMaskOverlay）：以掩模射线起点为球心、2 × 包围半径（离本体原点）为半径，遮挡格按 D2 的 az / el 画半透明红色
//     球面片 + 遮挡区边界线（本体系，与 mask.mjs maskDir 同一口径：az 自 +X 向 +Y、el = +90° 为 +Z 天底）。
//   天线视角（setAntennaView）：相机放在掩模射线起点（挂点 + 1 cm·视轴）沿视轴看，上向 = 挂点 up，竖直视场 = 给定视场；
//     本体用 overrideMaterial 画成半透明红，掩模边界线与视场圈画在最上层（不做深度比较）——红色本体的剪影与掩模边界应当重合。
//
// ─────────────── 三期 live 根（装配编辑器借视口，P3 CONTRACT §4）───────────────
//   setLiveRoot(root, meta, {keepView}) 直接挂调用方的树（不克隆、不拆多材质、不摆关节、资源归调用方，摘下时不释放）；
//   refreshLive({meshes, frame, overlays, moved}) 由编辑器在改完树后通知：拖动中只 moved（零分配），松手才 frame（包围盒 / 地面 / 接触阴影）。
//   setPointerOwner(fn) 让编辑器先认领单击 / 双击；setFrameHook(fn) 在每帧最前同步回调；viewState / setViewState 存取相机。
//   句柄 scene / overlay / controls / canvas / displayMatrix 只读暴露。任何非 live 的 setModel 都会先收回 live 根、撤销归属与钩子。
//   不传这些 API 时一切行为与二期逐行相同。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js'
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js'
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh'
import { configureRenderer, createStudio, studioBackground, paintStudioBackground, rigOrientFor } from './studio.js'
import { setMaterialAnisotropy, ROLE_COLORS } from './materials.js'
import { originalName, disposeLoaders } from './loader.js'
import { triTable, irNodeTable, disposeBorrowed, splitMultiMaterial } from './irToThree.js'
import { createGpuReleaser, collectResources } from './gpuRelease.js'
import { BODY_TO_DISPLAY, BODY_TO_DISPLAY_Q, DISPLAY_TO_BODY, ZENITH_DISPLAY, modelToBodyMatrix, viewDir, sampleWorldPoints, fitPerspective, boundingRadius } from './view.js'
import { autoViewFor, poseArticulations, exactBox, pinShadowDepthMaps } from './thumbs.js'

// 拾取 BVH：总三角形数到这个量以内在主线程直接建（≈ 20 ms 以内）；更大的进 Worker，建好之前拾取与悬停标记暂停
const BVH_SYNC_TRIS = 60000
// 交互期暂停 AO 的门槛（总三角形数）
const AUTO_LOD_TRIS = 600000

const AXIS_COL = { x: 0xe5484d, y: 0x30a46c, z: 0x3e63dd }
const AP_COL = 0xffb224
const AP_SEL_COL = 0x00b3ff
const MOUNT_COL = 0x2fbf9b          // 卫星绑定的挂点（mount）：青绿，与模型挂点（attach point）的橙色分开
const MASK_COL = 0xe5484d           // 掩模球面片 / 天线视角里的本体：暖红（与 maskChart 的遮挡色同一色相）
const NODE_HL_COL = 0x3d7bff
const MOUNT_PICK_PX = 14            // 点选挂点的屏幕半径（CSS 像素）
const FOV = 35
const UI_FONT = '"Segoe UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif'

// 图层（见文件头）
const L_MODEL = 0, L_SCENE_OV = 1, L_GROUND = 2

/** 画质档（setQuality）。maxDpr：设备像素比上限（MSAA × 半浮点的显存随它平方涨）。 */
export const QUALITY = {
  low: { pp: false, maxDpr: 1.5, shadowMap: 2048, ao: false },
  high: { pp: true, samples: 4, maxDpr: 1.5, shadowMap: 2048, ao: true, aoScale: 0.5, aoSamples: 16 },
  ultra: { pp: true, samples: 8, maxDpr: 2, shadowMap: 4096, ao: true, aoScale: 1, aoSamples: 24 }
}

// ---------------------------------------------------------------------------------------------
// 小件：标签精灵、箭头、质心符号
// ---------------------------------------------------------------------------------------------
// px = 精灵高度（CSS 像素）；字形约占 0.66 —— 18 px 精灵 ≈ 12 px 字，与界面正文同级
function makeLabel(text, color, theme, px = 18, bold = true) {
  const fs = 32, pad = 8
  const cv = document.createElement('canvas')
  const c0 = cv.getContext('2d')
  c0.font = `${bold ? 600 : 500} ${fs}px ${UI_FONT}`
  const tw = Math.ceil(c0.measureText(text).width)
  cv.width = Math.max(1, tw + pad * 2); cv.height = Math.ceil(fs * 1.45)
  const c = cv.getContext('2d')
  c.font = `${bold ? 600 : 500} ${fs}px ${UI_FONT}`
  c.textBaseline = 'middle'
  c.lineJoin = 'round'
  // 描边光晕：浅色背景用白晕、深色背景用黑晕，保证叠在模型任何颜色上都读得出
  c.lineWidth = 7
  c.strokeStyle = theme === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.85)'
  c.strokeText(text, pad, cv.height / 2)
  c.fillStyle = '#' + new THREE.Color(color).getHexString()
  c.fillText(text, pad, cv.height / 2)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.minFilter = THREE.LinearFilter; t.generateMipmaps = false
  const m = new THREE.SpriteMaterial({ map: t, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false })
  const s = new THREE.Sprite(m)
  s.center.set(-0.08, 0.5)
  s.renderOrder = 30
  s.userData.aspect = cv.width / cv.height
  s.userData.px = px
  s.userData.isLabel = true
  return s
}

// 单位箭头几何（沿 +Y，长 1）：杆 86% + 头 14%。全视口共享，dispose 时统一放。
function arrowGeoms() {
  const shaft = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false).translate(0, 0.5, 0)
  const head = new THREE.ConeGeometry(1, 1, 20, 1, false).translate(0, 0.5, 0)
  return { shaft, head }
}
function makeArrow(G, dir, len, rad, mat) {
  const g = new THREE.Group()
  const s = new THREE.Mesh(G.shaft, mat); s.scale.set(rad, len - Math.min(len * 0.1, rad * 16), rad); s.renderOrder = 20
  const h = new THREE.Mesh(G.head, mat); h.scale.set(rad * 3.4, Math.min(len * 0.1, rad * 16), rad * 3.4); h.position.y = len - Math.min(len * 0.1, rad * 16); h.renderOrder = 20
  g.add(s, h)
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  return g
}
// 质心符号：黑白四象限球（工程图上的质心记号）
function comTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 32
  const c = cv.getContext('2d')
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { c.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4'; c.fillRect(i * 16, j * 16, 16, 16) }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter
  return t
}

// 地面网格：一张平面 + 片元着色器画米制细 / 粗格线（fwidth 抗锯齿），离模型越远越淡。
function gridMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    uniforms: { uStep: { value: 1 }, uColor: { value: new THREE.Color(0x6b7280) }, uOpacity: { value: 0.6 }, uCenter: { value: new THREE.Vector2() }, uFade: { value: 10 } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `
      uniform float uStep; uniform vec3 uColor; uniform float uOpacity; uniform vec2 uCenter; uniform float uFade;
      varying vec3 vW;
      float line(vec2 p, float s, float w) { vec2 c = p / s; vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c); return 1.0 - min(min(g.x, g.y) / w, 1.0); }
      void main() {
        vec2 p = vW.xz;
        float a = max(line(p, uStep, 1.0) * 0.45, line(p, uStep * 5.0, 1.4));
        float d = length(p - uCenter);
        a *= 1.0 - smoothstep(uFade * 0.45, uFade, d);
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a * uOpacity);
      }`
  })
}
function gridStepFor(r) { return r < 0.6 ? 0.1 : r < 4 ? 1 : r < 25 ? 5 : 10 }

function setLayerDeep(obj, layer) { obj.traverse((o) => o.layers.set(layer)) }

// ---------------------------------------------------------------------------------------------
// 接触阴影（影棚档接地）：从地面朝上正交拍模型深度 → 两遍高斯模糊 → 贴在地面
// ---------------------------------------------------------------------------------------------
function createContactShadow() {
  const RES = 512
  const rtOpts = { type: THREE.UnsignedByteType }
  const rt = new THREE.WebGLRenderTarget(RES, RES, rtOpts); rt.texture.generateMipmaps = false
  const rtBlur = new THREE.WebGLRenderTarget(RES, RES, rtOpts); rtBlur.texture.generateMipmaps = false
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1)
  cam.layers.set(L_MODEL)
  const darkness = { value: 1.6 }
  const depthMat = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide })
  depthMat.depthTest = false; depthMat.depthWrite = false
  // 深度越近（贴地）越黑；超出拍摄高度的部分透明
  depthMat.onBeforeCompile = (sh) => {
    sh.uniforms.darkness = darkness
    sh.fragmentShader = 'uniform float darkness;\n' + sh.fragmentShader.replace(
      'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
      'gl_FragColor = vec4( vec3( 0.0 ), clamp( ( 1.0 - fragCoordZ ) * darkness, 0.0, 1.0 ) );')
  }
  depthMat.customProgramCacheKey = () => 'contactShadowDepth'
  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader); hBlur.depthTest = false
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader); vBlur.depthTest = false
  const quad = new FullScreenQuad(null)
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({ map: rt.texture, transparent: true, depthWrite: false, opacity: 0.6, toneMapped: false })
  const plane = new THREE.Mesh(geo, mat)
  plane.scale.y = -1            // 从下往上拍的图，纹理 v 与地面方向相反
  plane.renderOrder = 0
  plane.layers.set(L_GROUND)
  const grp = new THREE.Group()
  grp.add(plane, cam)
  cam.rotation.x = Math.PI / 2  // 朝上看
  let size = 1
  function place(center, y, span, height) {
    size = span
    grp.position.set(center.x, y, center.z)
    plane.scale.set(span, -1, span)
    cam.left = -span / 2; cam.right = span / 2; cam.top = span / 2; cam.bottom = -span / 2
    cam.near = 0; cam.far = Math.max(1e-3, height)
    cam.updateProjectionMatrix()
  }
  function blur(renderer, amount) {
    quad.material = hBlur
    hBlur.uniforms.tDiffuse.value = rt.texture
    hBlur.uniforms.h.value = amount / 256
    renderer.setRenderTarget(rtBlur); quad.render(renderer)
    quad.material = vBlur
    vBlur.uniforms.tDiffuse.value = rtBlur.texture
    vBlur.uniforms.v.value = amount / 256
    renderer.setRenderTarget(rt); quad.render(renderer)
  }
  /** 重拍：scene 里只有图层 0（模型）会被 cam 看见 */
  function render(renderer, scene) {
    const bg = scene.background, env = scene.environment
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha()
    const shadowAuto = renderer.shadowMap.autoUpdate
    renderer.shadowMap.autoUpdate = false        // 拍深度不需要更新阴影贴图
    scene.background = null
    scene.overrideMaterial = depthMat
    renderer.setClearColor(0x000000, 0)
    renderer.setRenderTarget(rt); renderer.clear()
    grp.updateMatrixWorld(true)
    renderer.render(scene, cam)
    scene.overrideMaterial = null
    scene.background = bg; scene.environment = env
    blur(renderer, 3.2)
    blur(renderer, 1.3)
    renderer.setRenderTarget(null)
    renderer.setClearColor(cc, ca)
    renderer.shadowMap.autoUpdate = shadowAuto
  }
  function dispose() {
    rt.dispose(); rtBlur.dispose(); depthMat.dispose(); hBlur.dispose(); vBlur.dispose(); quad.dispose(); geo.dispose(); mat.dispose()
  }
  return { group: grp, plane, place, render, dispose, get size() { return size } }
}

// ---------------------------------------------------------------------------------------------
// 视口
// ---------------------------------------------------------------------------------------------
/**
 * @param {HTMLElement} el 容器（视口占满它；容器负责尺寸）
 * @param {{theme?:'light'|'dark', mode?:'studio'|'sun', quality?:'low'|'high'|'ultra', pixelRatio?:number}} [opts]
 */
export function createViewport(el, opts = {}) {
  let theme = opts.theme === 'dark' ? 'dark' : 'light'
  let quality = QUALITY[opts.quality] ? opts.quality : 'high'
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  const dprOf = () => Math.min(opts.pixelRatio || window.devicePixelRatio || 1, QUALITY[quality].maxDpr)
  renderer.setPixelRatio(dprOf())
  renderer.setClearColor(0x000000, 0)
  // ★ 手动清屏：ViewHelper.render 内部再调一次 renderer.render，autoClear 开着会把刚画好的整帧清掉
  renderer.autoClear = false
  // ★ draw call / 三角形读数：info 缺省每次 render() 自动清零；改成手动，帧开头 reset，主场景画完记一次
  renderer.info.autoReset = false
  configureRenderer(renderer)
  setMaterialAnisotropy(renderer)
  const gpu = createGpuReleaser(renderer)   // 要在 configureRenderer 之后（开着阴影才截得到阴影那一个闭包）
  pinShadowDepthMaps(renderer)   // 共用深度材质不留旧贴图引用（换模型后「source data has been detached」，见 thumbs.js）
  const canvas = renderer.domElement
  canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none'
  el.appendChild(canvas)
  const maxSamples = renderer.capabilities.maxSamples || 4

  // ---------------- 场景 ----------------
  const scene = new THREE.Scene()
  const bodyRoot = new THREE.Group(); bodyRoot.name = 'body'
  // matrixAutoUpdate 关掉的节点，matrixWorldNeedsUpdate 缺省是 false：不置真，render 里的非强制 updateMatrixWorld 永远不算它的世界矩阵
  bodyRoot.matrixAutoUpdate = false; bodyRoot.matrix.copy(BODY_TO_DISPLAY); bodyRoot.matrixWorldNeedsUpdate = true
  const holder = new THREE.Group(); holder.name = 'model_holder'; holder.matrixAutoUpdate = false
  const ovWorld = new THREE.Group(); ovWorld.name = 'overlay_world'        // 场景内叠加（部件 / 节点着色、线框），矩阵手动同步
  const ground = new THREE.Group(); ground.name = 'ground'
  bodyRoot.add(holder)
  scene.add(bodyRoot, ovWorld, ground)
  // 画在画布上、不吃 AO / 色调映射的叠加：本体系一组（轴 / 挂点 / 质心 / 标签）+ 世界系的拾取标记
  const overlay = new THREE.Scene()
  const ovRoot = new THREE.Group(); ovRoot.matrixAutoUpdate = false; ovRoot.matrix.copy(BODY_TO_DISPLAY); ovRoot.matrixWorldNeedsUpdate = true
  const ovBody = new THREE.Group(); ovBody.name = 'overlay_body'
  ovRoot.add(ovBody)
  overlay.add(ovRoot)
  // 掩模球面片：本体系组两份——scene 里的做深度比较（平常看）、overlay 里的画在最上层（天线视角）；天线视角的视场圈也在 overlay
  const maskSceneGrp = new THREE.Group(); maskSceneGrp.name = 'mask_patch'
  bodyRoot.add(maskSceneGrp)
  const maskTopGrp = new THREE.Group(); maskTopGrp.name = 'mask_patch_top'; maskTopGrp.visible = false
  const avGrp = new THREE.Group(); avGrp.name = 'antenna_view'; avGrp.visible = false
  ovRoot.add(maskTopGrp, avGrp)

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1000)
  camera.position.set(8, 5, 6)
  camera.layers.enable(L_SCENE_OV); camera.layers.enable(L_GROUND)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.12
  controls.screenSpacePanning = true
  controls.rotateSpeed = 0.8

  let mode = opts.mode === 'sun' ? 'sun' : 'studio'
  const studio = createStudio(renderer, scene, { mode, shadowMapSize: QUALITY[quality].shadowMap })
  // 太阳档：地球反照与太空环境的地球在天底方向（显示系天顶朝上 = studio 缺省的「上」；显式设一次，显示系再换也不用改这里）
  studio.setUp(ZENITH_DISPLAY)
  el.style.background = studioBackground(mode, theme)

  // 轴球：显示「本体」三轴（把 ViewHelper 的子件整体转一个 本体→显示），点轴直切到对应视角
  const helper = new ViewHelper(camera, canvas)
  helper.location = { top: 8, right: 8, bottom: 0, left: null }
  const helperInner = new THREE.Group()
  helperInner.quaternion.copy(BODY_TO_DISPLAY_Q)
  for (const c of helper.children.slice()) helperInner.add(c)
  helper.add(helperInner)
  helper.setLabels('X', 'Y', 'Z')
  const HELPER_DIM = 128
  const helperSprites = helperInner.children.filter((c) => c.isSprite)

  // ---------------- 状态 ----------------
  let srcRoot = null              // 调用方给的 root（只读，不挂进场景、不改）
  let root = null, meta = null    // root = srcRoot.clone(true)，挂在 holder 下、关节驱动它
  let meshes = []                 // 模型里的 Mesh（拾取 / 线框 / 统计）
  let tris = 0
  let pts = new Float32Array(0)   // 采样点（显示系）
  const center = new THREE.Vector3()
  let radius = 1, radiusO = 1     // 包围半径（绕包围中心 / 绕本体原点）
  const bboxBody = { min: [0, 0, 0], max: [0, 0, 0] }
  const bboxModel = { min: [0, 0, 0], max: [0, 0, 0], ok: false }   // 模型轴、米（geometry.bboxM 口径）
  const _pm = new THREE.Matrix4(), _sm = new THREE.Matrix4()
  const ov = { axes: true, lvlh: false, attach: true, com: true, parts: false, wireframe: false, grid: true, labels: true }
  let highlight = null            // Set<partId> | null
  let nodeHl = null               // Set<IR 节点名> | null（太阳翼组 / 不遮挡节点等按节点的高亮）
  let apSel = null                // 选中挂点名
  const filePose = new Map()      // 关节节点 → 文件位姿 {m, vis}（poseArticulations 复原用）
  let artLive = {}                // 关节名 → 滑杆值（按 stages 顺序的数组）；没有的取 initialValue
  let nLive = 0
  let frameKey = ''               // 上次算包围盒 / 取景时的「轴向 × 缩放 × 关节初值」签名：没变就不重算
  const labels = []               // 所有标签精灵（按像素定尺）
  let pick = { kind: null, cb: null }
  // 二期叠加（见文件头）
  let mounts = null               // 卫星绑定的挂点列表（null = 画模型挂点）
  let mountSel = null             // 选中挂点 id
  let mountPickCb = null          // 点选挂点回调 (id) => void
  const mountHits = []            // 本帧可点的挂点：{id, disk, tip}（disk / tip 是叠加件，取世界坐标投屏）
  const followers = []            // 随关节走的叠加组：{g, node}
  let maskOv = null               // {blocked:Uint8Array, originBody:[3], key}
  let maskOn = true
  let av = null                   // 天线视角：{posBody, dirBody, upBody, fovDeg, saved}
  let avChangeCb = null           // 天线视角被视口自己退出（切视角 / 聚焦）时通知外面：(on:boolean) => void
  let bvhReady = false, bvhToken = 0, bvhWorker = null, bvhReqSeq = 0
  const bvhPending = new Map()   // 请求号 → {res, rej}
  // live 模式（装配编辑器借视口，CONTRACT §4）：root 是调用方的树本身（不克隆、不拆多材质、资源归调用方）；
  //   pointerOwner = 点击 / 双击归属询问、frameHook = 每帧最前的同步钩子；displayDomain = setDisplayUp 记下的领域
  let liveMode = false
  let pointerOwner = null
  let frameHook = null
  let displayDomain = 'spacecraft'

  // 叠加层自己造的资源（dispose 用）
  const own = { geoms: new Set(), mats: new Set(), texs: new Set() }
  const G = arrowGeoms(); own.geoms.add(G.shaft); own.geoms.add(G.head)
  const disk = new THREE.CircleGeometry(1, 40); own.geoms.add(disk)
  const ring = new THREE.RingGeometry(0.72, 1, 40); own.geoms.add(ring)
  const sphere = new THREE.SphereGeometry(1, 24, 16); own.geoms.add(sphere)
  const comTex = comTexture(); own.texs.add(comTex)
  // 单位视场锥：顶点在原点、底面在 z = 1、底半径 1（开口）；按 (L·tanθ, L·tanθ, L) 缩放再转到视轴。底圈另一条折线
  const coneGeo = new THREE.ConeGeometry(1, 1, 48, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2); own.geoms.add(coneGeo)
  const coneRim = (() => {
    const n = 64, p = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p[i * 3] = Math.cos(a); p[i * 3 + 1] = Math.sin(a); p[i * 3 + 2] = 1 }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    return g
  })(); own.geoms.add(coneRim)
  // 掩模球面片（本体系；scene 里一份做深度比较，overlay 里一份给天线视角画在最上层）与天线视角的材质
  const maskFillMat = new THREE.MeshBasicMaterial({ color: MASK_COL, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }); own.mats.add(maskFillMat)
  const maskFillTopMat = new THREE.MeshBasicMaterial({ color: MASK_COL, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }); own.mats.add(maskFillTopMat)
  const maskLineMat = new THREE.LineBasicMaterial({ color: MASK_COL, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }); own.mats.add(maskLineMat)
  const maskLineTopMat = new THREE.LineBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false }); own.mats.add(maskLineTopMat)
  const avBodyMat = new THREE.MeshBasicMaterial({ color: MASK_COL, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }); own.mats.add(avBodyMat)
  const avRimMat = new THREE.LineBasicMaterial({ color: 0x9fe7ff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false }); own.mats.add(avRimMat)
  const maskDyn = { geoms: [] }   // 球面片几何（随掩模 / 半径重建）
  const avDyn = []                // 天线视角的视场圈 / 十字几何（进出天线视角时重建 / 放掉）

  // 地面：网格 + 主光投影承接面 + 接触阴影
  const gridMat = gridMaterial(); own.mats.add(gridMat)
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2); own.geoms.add(plane)
  const gridMesh = new THREE.Mesh(plane, gridMat); gridMesh.renderOrder = 2
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.2, depthWrite: false }); own.mats.add(shadowMat)
  const shadowMesh = new THREE.Mesh(plane, shadowMat); shadowMesh.receiveShadow = true; shadowMesh.renderOrder = 1
  const contact = createContactShadow()
  ground.add(contact.group, shadowMesh, gridMesh)
  ground.visible = false   // 没有模型时不画（1 × 1 的网格面会在原点画出一个十字）
  setLayerDeep(ground, L_GROUND)
  contact.group.children.forEach((o) => { if (o.isCamera) o.layers.set(L_MODEL) })
  let contactDirty = true

  // 拾取悬停标记
  const hoverMat = new THREE.MeshBasicMaterial({ color: AP_COL, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide, toneMapped: false }); own.mats.add(hoverMat)
  const hover = new THREE.Mesh(ring, hoverMat); hover.visible = false; hover.renderOrder = 40
  overlay.add(hover)

  // ---------------- 后处理管线 ----------------
  let pp = null
  const outPass = new OutputPass()
  function buildPipeline() {
    disposePipeline()
    const q = QUALITY[quality]
    if (!q.pp) return
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2())
    const w = Math.max(1, sz.x), h = Math.max(1, sz.y)
    const samples = Math.min(q.samples, maxSamples)
    const ms = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthBuffer: true })
    ms.texture.name = 'wb_main'
    const col = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false })
    let ao = null
    if (q.ao) {
      const aw = Math.max(1, Math.round(w * q.aoScale)), ah = Math.max(1, Math.round(h * q.aoScale))
      ao = new GTAOPass(scene, camera, aw, ah)
      ao.output = GTAOPass.OUTPUT.Default
      ao.renderToScreen = false
      ao.updatePdMaterial({ samples: 16, rings: 2, radiusExponent: 2, radius: 8, lumaPhi: 10, depthPhi: 2, normalPhi: 3 })
      ao._aoScale = q.aoScale
    }
    pp = { ms, col, ao, samples }
    tuneAo()
  }
  function disposePipeline() {
    if (!pp) return
    pp.ms.dispose(); pp.col.dispose()
    if (pp.ao) pp.ao.dispose()
    pp = null
  }
  function resizePipeline() {
    if (!pp) return
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2())
    const w = Math.max(1, sz.x), h = Math.max(1, sz.y)
    pp.ms.setSize(w, h); pp.col.setSize(w, h)
    if (pp.ao) pp.ao.setSize(Math.max(1, Math.round(w * pp.ao._aoScale)), Math.max(1, Math.round(h * pp.ao._aoScale)))
  }
  // AO 参数随模型尺度：半径取包围半径的 6%（桁架缝、天线背面、翼根这类尺度），太阳档硬光下 AO 只作点缀
  function tuneAo() {
    if (!pp || !pp.ao) return
    const q = QUALITY[quality]
    pp.ao.updateGtaoMaterial({ radius: Math.max(1e-3, radius * 0.06), distanceExponent: 1.4, thickness: Math.max(1e-3, radius * 0.02), distanceFallOff: 1, scale: 1.1, samples: q.aoSamples })
    pp.ao.blendIntensity = mode === 'sun' ? 0.55 : 0.9
  }
  let aoSkip = false              // 本帧跳过 AO（大模型交互期）
  let aoPending = false           // 交互停了还欠一帧带 AO 的
  let liveMoving = false          // 编辑器本帧在拖件（refreshLive({moved:true}) 置、frame 用完即清）
  function runAo(write, read) {
    // GTAO 自己那遍法向 / 深度只看模型（图层 0）
    // 阴影贴图这一遍不必重画（主场景刚画过、光与模型都没动）
    const mask = camera.layers.mask, su = renderer.shadowMap.autoUpdate
    camera.layers.set(L_MODEL)
    renderer.shadowMap.autoUpdate = false
    pp.ao.render(renderer, write, read)
    renderer.shadowMap.autoUpdate = su
    camera.layers.mask = mask
  }
  /** 主场景（含地面、场景内叠加）画到屏幕：low 直接画；high / ultra 过 MSAA 离屏 → AO → 输出 */
  function renderMain() {
    if (av) { renderAntennaView(); return }
    if (!pp) {
      renderer.setRenderTarget(null)
      renderer.clear()
      renderer.render(scene, camera)
      return
    }
    renderer.setRenderTarget(pp.ms)
    renderer.clear()
    renderer.render(scene, camera)
    let src = pp.ms
    if (pp.ao && !aoSkip) { runAo(pp.col, pp.ms); src = pp.col }
    outPass.renderToScreen = true
    outPass.render(renderer, null, src)
    renderer.setRenderTarget(null)
  }
  /**
   * 天线视角：本体整体 overrideMaterial 半透明红（只画模型图层：地面、部件着色、场景里那份掩模片都不画），直接上屏（不过 AO——
   * 覆盖材质下 AO 没有意义）。掩模边界线 / 视场圈在 overlay 里（不做深度比较）随后叠上。
   */
  function renderAntennaView() {
    const mask = camera.layers.mask, bg = scene.background
    const hide = av && av.hide, was = av && av.hideVis
    if (hide) for (let i = 0; i < hide.length; i++) { was[i] = hide[i].visible; hide[i].visible = false }   // 挂点排除节点（掩模同一份名单）不画
    camera.layers.set(L_MODEL)
    scene.overrideMaterial = avBodyMat
    scene.background = null
    renderer.setRenderTarget(null)
    renderer.clear()
    renderer.render(scene, camera)
    scene.overrideMaterial = null
    scene.background = bg
    camera.layers.mask = mask
    if (hide) for (let i = 0; i < hide.length; i++) hide[i].visible = was[i]
  }

  // ---------------- 预分配 ----------------
  const raycaster = new THREE.Raycaster(); raycaster.firstHitOnly = true
  raycaster.layers.set(L_MODEL)
  const ndc = new THREE.Vector2()
  const hits = []
  const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m3 = new THREE.Matrix3(), _inv = new THREE.Matrix4()
  const _dir = new THREE.Vector3(), _q = new THREE.Quaternion()
  const _Z = new THREE.Vector3(0, 0, 1)

  // ---------------- 渲染循环（按需） ----------------
  let raf = 0, alive = true, lastT = 0
  let frameMs = 0, fps = 0, calls = 0, drawnTris = 0
  // inHook：帧钩子里的 invalidate 不再排下一帧（本帧紧接着就画，排了就是白画一帧）
  let inHook = false
  function invalidate() { if (!raf && alive && !inHook) raf = requestAnimationFrame(frame) }
  function renderNow() {
    const t0 = performance.now()
    if (contactDirty) updateContact()
    renderer.info.reset()
    renderMain()
    calls = renderer.info.render.calls; drawnTris = renderer.info.render.triangles   // 主场景（含阴影趟与 AO 法向趟），不含叠加与轴球
    renderer.clearDepth()
    declutter(cssW, cssH)
    renderer.render(overlay, camera)
    helper.render(renderer)
    const dt = performance.now() - t0
    frameMs = frameMs ? frameMs * 0.85 + dt * 0.15 : dt
  }
  function frame(now) {
    raf = 0
    if (!alive) return
    // 编辑器的每帧钩子：本帧积攒的指针 / gizmo 变化在这里换算上屏（controls.update 之前，零延迟）
    if (frameHook) { inHook = true; try { frameHook(now) } catch (e) { console.error('[viewport] frameHook 出错', e) } finally { inHook = false } }
    const dt = lastT ? (now - lastT) : 0
    lastT = now
    if (dt > 0 && dt < 250) { const f = 1000 / dt; fps = fps ? fps * 0.9 + f * 0.1 : f }
    // 天线视角：相机钉在挂点上、不归 OrbitControls 管（update 会按球坐标把相机拉回轨道）
    const moving = av ? false : controls.update(dt > 0 ? dt / 1000 : null)
    if (groundOn) ground.visible = !av && camera.position.y >= gridMesh.position.y
    if (hoverPending) doHover()
    const big = tris > AUTO_LOD_TRIS && pp && pp.ao
    const editing = liveMoving
    liveMoving = false
    aoSkip = !!(big && (moving || dragging || editing))
    if (aoSkip) aoPending = true
    renderNow()
    if (moving) invalidate()
    else {
      lastT = 0
      // 停手后第一帧（没有 moved）补一帧带 AO 的
      if (aoPending && !dragging && !editing) { aoPending = false; aoSkip = false; invalidate() }
    }
  }
  controls.addEventListener('change', invalidate)
  let dragging = false
  controls.addEventListener('start', () => { dragging = true })
  controls.addEventListener('end', () => { dragging = false; invalidate() })

  // ---------------- 尺寸 ----------------
  let cssW = 1, cssH = 1
  function labelScale(h = cssH, k = 1) {
    const f = 1 / Math.tan(camera.fov * Math.PI / 360)
    for (const s of labels) {
      const sz = 2 * s.userData.px * k / (f * h)
      s.scale.set(sz * s.userData.aspect, sz, 1)
    }
  }
  function resize(force) {
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight)
    if (!force && w === cssW && h === cssH) return
    cssW = w; cssH = h
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    resizePipeline()
    labelScale()
    invalidate()
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null
  if (ro) ro.observe(el)
  resize(true)
  buildPipeline()

  // ---------------- 模型与取景 ----------------
  function collectMeshes() {
    meshes = []; tris = 0
    if (!root) return
    root.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.attributes.position) {
        meshes.push(o)
        const g = o.geometry
        tris += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3)
      }
    })
  }
  // 关节位姿：回文件位姿后按「滑杆值 ‖ 初值」重摆（withLive=false 只摆初值：量包围盒用）
  function applyPose(withLive = true) {
    if (!root) return
    poseArticulations(root, meta && Array.isArray(meta.articulations) ? meta.articulations : null, withLive && nLive ? artLive : null, { pose: filePose, resolve: resolveNodes })
  }
  // 关节节点名（IR 名，irLayout 口径，与导出件一致）→ 预览克隆里的节点；原名兜底
  let _nameIdx = null
  function resolveNodes(names) {
    const hit = new Set()
    const tab = nodeTable()
    for (const nm of names) { const e = tab.get(nm); if (e) hit.add(e.obj) }
    if (!_nameIdx) { _nameIdx = new Map(); root.traverse((o) => { const n = originalName(o); if (!n) return; if (!_nameIdx.has(n)) _nameIdx.set(n, []); _nameIdx.get(n).push(o) }) }
    for (const nm of names) { const l = _nameIdx.get(nm); if (l) for (const o of l) hit.add(o) }
    return hit
  }
  // 关节初值签名（节点、stage 类型、初值）：包围盒按初值位姿量，初值改了要重量
  function restKey() {
    const arts = meta && Array.isArray(meta.articulations) ? meta.articulations : []
    let s = ''
    for (const a of arts) {
      if (!a) continue
      s += (Array.isArray(a.nodes) ? a.nodes.join('\u0001') : '') + '\u0002'
      for (const st of Array.isArray(a.stages) ? a.stages : []) s += (st && st.type) + ':' + (st && st.initialValue) + ';'
      s += '\u0003'
    }
    return s
  }
  /**
   * 模型系 → 本体系矩阵就位；轴向 / 缩放 / 关节初值（或几何）变了才重算包围盒、取景采样、地面与相机裁剪面。
   * 元数据别的字段（改名、挂点、部件…）不重算 —— 精确包围盒是逐顶点的，百万面的件一趟十几毫秒。
   * @param {boolean} [force] 换了几何时 true
   * @returns {boolean} 是否重算了
   */
  function applyFrame(force) {
    modelToBodyMatrix(meta, holder.matrix)
    holder.matrixWorldNeedsUpdate = true
    const key = root ? holder.matrix.elements.join(',') + '|' + restKey() : ''
    if (!force && key === frameKey) { scene.updateMatrixWorld(true); return false }
    frameKey = key
    // 包围盒、取景都按「加载时的位姿」量：滑杆拖着的时候先临时摆回初值，量完再摆回去
    const live = !!(root && nLive)
    if (live) applyPose(false)
    scene.updateMatrixWorld(true)
    pts = root ? sampleWorldPoints(root, 20000) : new Float32Array(0)
    const eb = root ? exactBox(root) : null      // 显示系、逐顶点、只算可见件
    // 模型轴、米（轴映射终案 ④：geometry.bboxM 的口径）：顶点 → 模型系（去掉 holder 的轴向 / 平移 / 缩放）→ × scaleToMeters
    if (root) {
      const s0 = meta && meta.units && Number.isFinite(meta.units.scaleToMeters) && meta.units.scaleToMeters > 0 ? meta.units.scaleToMeters : 1
      _pm.copy(holder.matrixWorld).invert().premultiply(_sm.makeScale(s0, s0, s0))
      const em = exactBox(root, _pm)
      if (!em.empty) { bboxModel.min = em.min.slice(); bboxModel.max = em.max.slice(); bboxModel.ok = true } else bboxModel.ok = false
    } else bboxModel.ok = false
    if (pts.length && eb && !eb.empty) {
      const [x0, y0, z0] = eb.min, [x1, y1, z1] = eb.max
      center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
      radius = Math.max(1e-3, boundingRadius(pts, center.x, center.y, center.z))
      radiusO = Math.max(1e-3, eb.radius)
      // 显示系包围盒 → 本体系：DISPLAY_TO_BODY 是带符号的置换（纯 90° 旋转），逐轴取对应显示轴的区间（负号翻区间）。
      // 不写死哪个轴对哪个轴：显示系口径（view.js）换过一次，写死的换算会静默给出转了 90° 的包围盒。
      const dmin = [x0, y0, z0], dmax = [x1, y1, z1], e = DISPLAY_TO_BODY.elements
      for (let i = 0; i < 3; i++) {
        let j = 0, sg = 0
        for (let k = 0; k < 3; k++) { const m = e[k * 4 + i]; if (Math.abs(m) > 0.5) { j = k; sg = Math.sign(m) } }
        bboxBody.min[i] = sg > 0 ? dmin[j] : -dmax[j]
        bboxBody.max[i] = sg > 0 ? dmax[j] : -dmin[j]
      }
      // 地面：模型最低点下面一丝；网格格距按尺寸取 0.1 / 1 / 5 / 10 m
      const gy = y0 - radius * 0.004
      const span = Math.max(x1 - x0, z1 - z0) * 0.5 + radius
      const size = span * 4
      gridMesh.position.set(center.x, gy, center.z); gridMesh.scale.set(size, 1, size)
      shadowMesh.position.set(center.x, gy - radius * 0.0005, center.z); shadowMesh.scale.set(size, 1, size)
      gridMat.uniforms.uStep.value = gridStepFor(radius)
      gridMat.uniforms.uCenter.value.set(center.x, center.z)
      gridMat.uniforms.uFade.value = span * 1.25
      // 接触阴影：罩住模型脚印外扩一圈；拍摄高度取模型高度的 35%（贴地部分最黑、往上渐淡）
      const foot = Math.max(x1 - x0, z1 - z0) * 1.35 + radius * 0.25
      contact.place(center, gy + radius * 0.0008, foot, Math.max(radius * 0.05, (y1 - y0) * 0.35))
    } else if (liveMode && root) {
      // live 空树（装配文档还没有件）：原点下方 1 m 铺 ±5 m、格距 1 m 的地面——第一件拖进来要有落点参照；相机裁剪面按半径 5 m
      center.set(0, 0, 0); radius = radiusO = 5; bboxBody.min = [0, 0, 0]; bboxBody.max = [0, 0, 0]
      gridMesh.position.set(0, -1, 0); gridMesh.scale.set(10, 1, 10)
      shadowMesh.position.set(0, -1.0025, 0); shadowMesh.scale.set(10, 1, 10)
      gridMat.uniforms.uStep.value = 1
      gridMat.uniforms.uCenter.value.set(0, 0)
      gridMat.uniforms.uFade.value = 5
      contact.place(center, -0.999, 10, 0.5)
    } else { center.set(0, 0, 0); radius = radiusO = 1; bboxBody.min = [0, 0, 0]; bboxBody.max = [0, 0, 0] }
    if (live) { applyPose(true); scene.updateMatrixWorld(true) }
    autoDir = null
    camera.near = Math.max(0.001, radius * 0.002)
    camera.far = radius * 200
    camera.updateProjectionMatrix()
    controls.minDistance = radius * (liveMode ? 0.01 : 0.15)   // 装配编辑要能凑近看小件（星敏 / 馈源），预览照旧
    controls.maxDistance = radius * 60
    fitStudio()
    tuneAo()
    contactDirty = true
    return true
  }
  function fitStudio() { studio.fit(center, radius * (ov.grid && mode === 'studio' ? 1.7 : 1)) }
  // 地面（网格 / 承影面 / 接触阴影）只属于影棚：太阳档是太空，一张地板网格铺满黑背景只剩一片杂线。
  // 相机钻到地板下面时（从下方看电池面）整个地面不画 —— 从下往上隔着一层网格看模型没有意义；逐帧判（零分配）。
  let groundOn = false, shadowOn = true
  function rebuildGroundVis() {
    groundOn = ov.grid && !!root && mode === 'studio'
    shadowMesh.visible = groundOn && shadowOn
    ground.visible = groundOn && camera.position.y >= gridMesh.position.y
  }
  function contactOn() { return !!root && ov.grid && mode === 'studio' }
  function updateContact() {
    contactDirty = false
    contact.plane.visible = contactOn()
    if (!contact.plane.visible) return
    contact.render(renderer, scene)
  }

  function killInertia() {
    // OrbitControls 的阻尼余量是私有字段；直切视角时必须清零，否则切过去还会接着转一段
    if (controls._sphericalDelta) controls._sphericalDelta.set(0, 0, 0)
    if (controls._panOffset) controls._panOffset.set(0, 0, 0)
    if (controls._scale != null) controls._scale = 1
  }
  // 「自动」视角（autoViewFor：与缩略图同一套取景，库卡片与预览第一眼同一张脸）：按模型算一次，几何 / 轴向变了作废
  let autoDir = null
  // 太阳档的自动太阳：没有真实太阳矢量时（工作台看模型），每次选视角把太阳摆在「相机右肩后、比相机更偏向它那一侧」——
  //   方位 = 视线绕竖直轴转 50°（屏幕右侧），俯仰 = 相机俯仰 × 1.25 ± 12°（同号）：看得见的一侧受光、明暗交界落在星体上，暗面近黑（NASA Eyes 的硬光观感）。
  //   俯仰跟着相机走：自动视角也会从下方看（电池面朝别处的件），太阳若固定在上方，看得见的那一面全在背光里。
  //   只在选视角时摆一次、转动相机时不跟（跟着转就成了头灯，看不到暗面）。
  let sunExplicit = false
  const _sd = new THREE.Vector3(), _iso = viewDir('iso', new THREE.Vector3()), _rq = new THREE.Quaternion(), _kd = new THREE.Vector3()
  // 影棚灯组跟着选定的视角转（studio.orient）：从哪一面看都是同一套布光；转动相机时不跟
  function orientRig() {
    studio.orient(rigOrientFor(_dir, _iso, _rq))
    // 主光转到地平线以下时，地板承影面上的投影会从下往上投，不画
    shadowOn = studio.keyDirection(_kd).y > 0.12
    rebuildGroundVis()
    contactDirty = true
  }
  function aimSun() {
    if (sunExplicit) return
    const a = 50 * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a)
    _sd.set(_dir.x * c + _dir.z * sn, 0, -_dir.x * sn + _dir.z * c)
    if (_sd.lengthSq() < 1e-8) _sd.set(1, 0, 0)
    _sd.normalize()
    const camEl = Math.asin(Math.max(-1, Math.min(1, _dir.y)))
    const ce = camEl * 180 / Math.PI
    const el = Math.max(-75, Math.min(75, ce * 1.25 + (ce < 0 ? -12 : 12))) * Math.PI / 180
    _sd.multiplyScalar(Math.cos(el)); _sd.y = Math.sin(el)
    studio.setSunDir(_sd)
  }
  // 用户切视角 / 聚焦把天线视角顶掉：退出并通知外面（分析页「天线视角」按钮要跟着灭，否则按钮亮着、视口已经出来了）。
  // 换模型（setModel）退出不通知：外面按模型变化自己重进（同一挂点换 LOD 后接着看）
  function exitAntennaViewByUser() {
    if (!av) return
    setAntennaView(null)
    if (avChangeCb) { try { avChangeCb(false) } catch (e) { console.warn('[viewport] onAntennaViewChange 回调出错', e) } }
  }
  function onAntennaViewChange(cb) { avChangeCb = typeof cb === 'function' ? cb : null }
  function setView(name) {
    exitAntennaViewByUser()
    if (name === 'auto') {
      if (!autoDir && root) autoDir = autoViewFor(root)
      if (autoDir) _dir.copy(autoDir); else viewDir('iso', _dir)
    } else viewDir(name, _dir)
    aimSun(); orientRig()
    const fit = fitPerspective(pts.length ? pts : new Float32Array([0, 0, 0]), _dir, camera.fov, camera.aspect, 0.08)
    killInertia()
    controls.target.copy(fit.target)
    camera.position.copy(fit.target).addScaledVector(_dir, fit.dist)
    camera.lookAt(fit.target)
    controls.update()
    invalidate()
  }

  /**
   * 聚焦到本体系里的一个球（部件 / 挂点 / 近景检查）：视线方向不变（或按 view 名换），距离让半径 r 的球正好占满竖直视场的 80 %。
   * @param {number[]} centerBody 球心（本体系，米）
   * @param {number} r 半径（米）
   * @param {string} [view] 视角名（缺省沿当前视线）
   */
  function focusBody(centerBody, r, view) {
    if (!Array.isArray(centerBody) || !(r > 0)) return
    exitAntennaViewByUser()
    if (view) { if (view === 'auto') { if (!autoDir && root) autoDir = autoViewFor(root); _dir.copy(autoDir || viewDir('iso')) } else viewDir(view, _dir); aimSun(); orientRig() }
    else _dir.copy(camera.position).sub(controls.target).normalize()
    _v.set(centerBody[0], centerBody[1], centerBody[2]).applyMatrix4(BODY_TO_DISPLAY)
    const d = r / Math.sin(camera.fov * Math.PI / 360) / 0.8
    killInertia()
    controls.target.copy(_v)
    camera.position.copy(_v).addScaledVector(_dir, d)
    camera.lookAt(_v)
    controls.update()
    invalidate()
  }

  /**
   * @param {THREE.Object3D|null} r 模型根（模型系）。视口内部 clone(true) 一份来挂，r 本身不挂进场景、不被关节改动。
   * @param {object|null} m ModelMeta
   * @param {{keepView?:boolean}} [o]
   */
  function setModel(r, m, o = {}) {
    // 非 live 的喂模型：装配编辑器借走的视口先收回（live 根只摘不放），点击归属 / 帧钩子一并撤销（编辑器忘了 detach 也不吞别页的点击）
    if (liveMode) exitLive()
    pointerOwner = null; frameHook = null
    if (r && r === srcRoot) {
      // 同一根重喂（元数据改了一格）：关节按「滑杆值 ‖ 新初值」重摆 —— 不能只回静止位，滑杆还停在原处
      meta = m || null
      applyPose(true)
      if (applyFrame() && maskOv) buildMaskPatch()
      rebuildOverlays()
      contactDirty = true
      invalidate()
      return
    }
    // 换了模型：天线视角退出、掩模片作废（它属于上一个模型的某个挂点）；卫星挂点列表（属于卫星绑定）照留
    if (av) setAntennaView(null)
    if (maskOv) { maskOv = null; clearMaskPatch(); syncMaskVis() }
    // 换模型清滑杆值；同一模型换 LOD（keepPose）保留，免得升档那一下关节弹回初值、滑杆却没动
    if (!o.keepPose) { artLive = {}; nLive = 0 }
    // 克隆 + 多材质网格拆成 IR 的样子（与导出件同构）：关节 / 部件按 IR 名（含「对象名_材质名」子节点）都能落到独立节点上
    const next = r ? splitMultiMaterial(r.clone(true)) : null
    // 换模型：旧模型在本 renderer 里的几何 / 贴图副本放掉（新模型也用的那些留着，免得重传）
    const keep = next ? collectResources(next) : null
    clearModel(true, keep)
    srcRoot = r || null; root = next; meta = m || null
    if (!root) { artLive = {}; nLive = 0; rebuildOverlays(); invalidate(); return }
    gpu.track(root)
    holder.add(root)
    collectMeshes()
    bvhReady = false
    applyPose(true)
    applyFrame(true)
    rebuildOverlays()
    if (pick.kind) ensureBvh()
    if (!o.keepView) setView('auto')
    invalidate()
  }
  function clearModel(silent, keep) {
    if (root) {
      holder.remove(root)
      // live 根的资源归调用方（装配编辑器按件缓存、自己 dispose）：只摘下，不放 GPU 副本
      if (!liveMode) gpu.releaseTree(root, { kinds: ['geo', 'tex'], keepShared: true, keep })
    }
    liveMode = false
    srcRoot = null; root = null; meta = null; meshes = []; tris = 0; pts = new Float32Array(0)
    filePose.clear(); frameKey = ''
    _nodeTab = null; _triTab = null; _nameIdx = null
    bvhReady = false; bvhToken++
    hover.visible = false
    clearOverlays()
    contact.plane.visible = false
    if (!silent) invalidate()
  }

  // ---------------- live 根（装配编辑器，CONTRACT §4）----------------
  /** 退出 live：摘下 live 根（不释放）、清点击归属与帧钩子。 */
  function exitLive() {
    clearModel(true)
    pointerOwner = null; frameHook = null
  }
  /**
   * 挂 live 根：不克隆、不拆多材质、不释放（资源归调用方）、不摆关节。root = null → 退出 live（视口变空）。
   * meta 只读 frame / units（缺省 = 单位阵 / 米）：编辑器传单位阵，live 根的子件直接就是本体系（文档）坐标。
   * @param {THREE.Object3D|null} r
   * @param {{frame?:object, units?:object}|null} [m]
   * @param {{keepView?:boolean}} [o] 缺省 keepView = true（不跳视角）
   */
  function setLiveRoot(r, m, o = {}) {
    const keepView = !o || o.keepView !== false
    if (av) setAntennaView(null)
    if (maskOv) { maskOv = null; clearMaskPatch(); syncMaskVis() }
    artLive = {}; nLive = 0
    clearModel(true)   // 非 live 的克隆照旧 releaseTree；旧 live 根只摘下
    if (!r) { pointerOwner = null; frameHook = null; rebuildOverlays(); invalidate(); return }
    liveMode = true
    srcRoot = null     // 之后 setModel(同一个工作台根) 不会被「同根重喂」短路
    root = r
    const f = m && m.frame ? m.frame : {}
    meta = {
      frame: { q_model2body: Array.isArray(f.q_model2body) ? f.q_model2body.slice() : [0, 0, 0, 1], t_model2body: Array.isArray(f.t_model2body) ? f.t_model2body.slice() : [0, 0, 0] },
      units: { scaleToMeters: m && m.units && Number.isFinite(m.units.scaleToMeters) && m.units.scaleToMeters > 0 ? m.units.scaleToMeters : 1 }
    }
    holder.add(root)
    gpu.track(root)
    collectMeshes()
    bvhReady = false
    ensureBvh()
    applyFrame(true)
    rebuildOverlays()
    if (!keepView) setView('auto')
    invalidate()
  }
  /**
   * live 根内容变了之后通知视口（非 live 时无效果）：
   *   meshes 重收网格表 + 追踪资源 + 补 BVH；frame 重算包围盒 / 地面 / 接触阴影 / 裁剪面（重，松手后）；
   *   overlays 重建叠加层（缺省 = frame）；moved 只同步随动叠加（零分配，拖动中每帧可调）。总是 invalidate。
   */
  function refreshLive(o = {}) {
    if (!liveMode || !root) return
    const ms = !!o.meshes, fr = !!o.frame, ovs = o.overlays === undefined ? fr : !!o.overlays
    if (ms) {
      collectMeshes()
      gpu.track(root)
      _nodeTab = null; _triTab = null; _nameIdx = null
      bvhReady = false
      ensureBvh()
    }
    if (fr) { applyFrame(true); contactDirty = true }
    if (ovs || (ms && ov.wireframe)) rebuildOverlays()
    else if (o.moved && ovWorld.children.length) syncWorldOverlays()
    // 编辑器拖件（gizmo / ghost / 拾起）期间 OrbitControls 被禁用、不发 start：这里记一帧「在动」，大模型照样跳过 AO（frame 里用完即清）
    if (o.moved) liveMoving = true
    invalidate()
  }
  /**
   * 预编译 obj 里各材质的着色器程序（编辑器的 ghost 材质副本 / 叠加层材质）：按主场景的灯光、环境与画面去向编译
   * （有后处理时主场景画进离屏 MSAA 目标：色调映射 / 输出色彩空间与那一趟一致，程序缓存键对得上），走 KHR_parallel_shader_compile
   * 异步完成，不在交互那一帧同步 link。obj 不必挂进场景。o.overlay = 按叠加层那一趟编译（直接画到屏幕、叠加场景的灯光）。
   * 返回 Promise（编好 resolve）。
   */
  function precompile(obj, o = {}) {
    if (!obj || !alive) return Promise.resolve()
    const rt = renderer.getRenderTarget()
    let p
    try {
      renderer.setRenderTarget(o.overlay ? null : (pp && !av ? pp.ms : null))
      p = renderer.compileAsync(obj, camera, o.overlay ? overlay : scene)
    } catch (e) { p = Promise.resolve(); console.warn('[viewport] 预编译失败：' + ((e && e.message) || e)) } finally { renderer.setRenderTarget(rt) }
    return p
  }
  /** 按领域设显示朝上。四类领域本体 +Z 一律朝下（卫星天底 / FRD / NED），显示矩阵同一个：只记下领域，返回 false（矩阵未变）。 */
  function setDisplayUp(domain) { displayDomain = typeof domain === 'string' ? domain : 'spacecraft'; return false }
  /** 指针归属：fn(kind, ev) → true = 这次被吃掉（'click' / 'dbl'）；null 撤销。 */
  function setPointerOwner(fn) { pointerOwner = typeof fn === 'function' ? fn : null }
  /** 每帧钩子：fn(nowMs) 在 frame() 最前同步调用；null 撤销。 */
  function setFrameHook(fn) { frameHook = typeof fn === 'function' ? fn : null; if (frameHook) invalidate() }
  function ownerEats(kind, ev) {
    if (!pointerOwner) return false
    try { return pointerOwner(kind, ev) === true } catch (e) { console.error('[viewport] pointerOwner 出错', e); return false }
  }
  /** 相机状态（显示系）。 */
  function viewState() { return { pos: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov } }
  function setViewState(s) {
    if (!s || !Array.isArray(s.pos) || s.pos.length !== 3 || !Array.isArray(s.target) || s.target.length !== 3) return
    if (![...s.pos, ...s.target].every(Number.isFinite)) return
    exitAntennaViewByUser()
    killInertia()
    camera.position.fromArray(s.pos)
    controls.target.fromArray(s.target)
    if (Number.isFinite(s.fov) && s.fov > 1 && s.fov < 170 && s.fov !== camera.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); labelScale() }
    camera.lookAt(controls.target)
    controls.update()
    invalidate()
  }

  // ---------------- 叠加层 ----------------
  const dynamic = { geoms: new Set(), mats: new Set(), texs: new Set() }   // 随模型重建的那部分
  function dynMat(m) { dynamic.mats.add(m); return m }
  // prio：屏幕避让时谁先占位（选中挂点 4 > 本体轴 3 > LVLH 2 > 其余 1）
  function addLabel(parent, text, color, pos, px = 12, bold = true, prio = 1) {
    const s = makeLabel(text, color, mode === 'sun' ? 'dark' : theme, px, bold)
    dynamic.texs.add(s.material.map); dynamic.mats.add(s.material)
    s.position.copy(pos)
    s.visible = ov.labels
    s.userData.prio = prio
    parent.add(s); labels.push(s)
    return s
  }
  // 标签屏幕避让：挂点密集处（参数化星对地板上一簇馈源焦点）名字叠成一团时，按优先级依次占位，与已占位的矩形相交就不画。
  // 每帧做（相机一动遮挡关系就变）；n ≤ 百来个，O(n²) 的矩形相交可忽略。零分配：矩形放预分配的数组里。
  const _rects = new Float32Array(4 * 512)
  function declutter(wPx, hPx, k = 1) {
    if (!ov.labels || !labels.length) return
    let n = 0
    for (const s of labels) {
      s.visible = true
      s.getWorldPosition(_v)
      _v.project(camera)
      if (_v.z > 1 || _v.z < -1) { s.visible = false; continue }
      const px = s.userData.px * k, w = px * s.userData.aspect
      // 精灵锚点 center = (−0.08, 0.5)：画在锚点右侧 [0.08w, 1.08w]、上下各半高；字形（含描边光晕）约占高度的 80 %
      const x0 = (_v.x * 0.5 + 0.5) * wPx + 0.08 * w, y0 = (0.5 - _v.y * 0.5) * hPx - px * 0.4
      const x1 = x0 + w * 0.92, y1 = y0 + px * 0.8
      let hit = false
      for (let i = 0; i < n; i++) {
        const o = i * 4
        if (x0 < _rects[o + 2] && x1 > _rects[o] && y0 < _rects[o + 3] && y1 > _rects[o + 1]) { hit = true; break }
      }
      if (hit) { s.visible = false; continue }
      if (n < 512) { const o = n * 4; _rects[o] = x0; _rects[o + 1] = y0; _rects[o + 2] = x1; _rects[o + 3] = y1; n++ }
    }
  }
  function clearOverlays() {
    for (const g of [ovBody, ovWorld]) { for (const c of g.children.slice()) g.remove(c) }
    for (const x of dynamic.geoms) {
      // 部件子集几何与模型共享属性缓冲（打了 _borrowed）：先摘掉属性再 dispose，只放掉自己的索引缓冲
      if (x.userData && x.userData._borrowed) disposeBorrowed(x)
      else x.dispose()
    }
    for (const x of dynamic.mats) x.dispose()
    for (const x of dynamic.texs) x.dispose()
    dynamic.geoms.clear(); dynamic.mats.clear(); dynamic.texs.clear()
    labels.length = 0
  }
  function rebuildOverlays() {
    clearOverlays()
    rebuildGroundVis()
    gridMat.uniforms.uColor.value.set(mode === 'sun' ? 0x5b6b80 : theme === 'dark' ? 0x9aa3ad : 0x6b7280)
    gridMat.uniforms.uOpacity.value = mode === 'sun' ? 0.3 : theme === 'dark' ? 0.36 : 0.32
    shadowMat.opacity = theme === 'dark' ? 0.34 : 0.16
    contact.plane.material.opacity = theme === 'dark' ? 0.8 : 0.58
    if (contact.plane.visible !== contactOn()) contactDirty = true
    if (!root) return
    const r = radius, rO = Math.max(radiusO, radius * 0.6)
    const dark = mode === 'sun' || theme === 'dark'
    // 本体轴：长 0.6 × 本体原点到最远点（长翼星按 1.3 r 画字标全落画外）；细杆：轴是参照，不该比模型的桁架还粗
    if (ov.axes) {
      // 逐轴定长：伸出模型在该轴正向的外表面 12 %（CAD 里坐标轴的习惯长度）—— 统一取 0.6 倍最远点距离时，
      // 原点偏在一侧的美术件（NASA TDRS 的原点在星体中心、翼展方向远）Z 箭头冲出画面，扁的星轴又短得看不见
      const rad = r * 0.0035
      for (const [k, d] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
        const i = k === 'x' ? 0 : k === 'y' ? 1 : 2
        const L = Math.min(rO * 0.9, Math.max(r * 0.28, bboxBody.max[i] * 1.12))
        const m = dynMat(new THREE.MeshBasicMaterial({ color: AXIS_COL[k], depthTest: false, transparent: true, opacity: 0.95, toneMapped: false }))
        const dv = new THREE.Vector3(d[0], d[1], d[2])
        ovBody.add(makeArrow(G, dv, L, rad, m))
        addLabel(ovBody, k.toUpperCase(), AXIS_COL[k], dv.clone().multiplyScalar(L * 1.03), 20, true, 3)
      }
    }
    // LVLH（对地定向律下与本体轴重合；虚线画长一截以示区别）
    if (ov.lvlh) {
      const L = rO * 0.85
      const ink = dark ? 0xc8ccd2 : 0x55595f
      const m = dynMat(new THREE.LineDashedMaterial({ color: ink, dashSize: r * 0.06, gapSize: r * 0.04, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false }))
      for (const [nm, d] of [['LVLH X', [1, 0, 0]], ['LVLH Y', [0, 1, 0]], ['LVLH Z', [0, 0, 1]]]) {
        const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(L)])
        dynamic.geoms.add(g)
        const line = new THREE.Line(g, m); line.computeLineDistances(); line.renderOrder = 19
        ovBody.add(line)
        addLabel(ovBody, nm, ink, new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(L * 1.02), 17, true, 2)
      }
    }
    // 挂点：小圆盘（垂直视轴）+ 视轴射线 + 名称；选中的那个换色、放大、射线加长。
    // 卫星页 / 分析页给了 mounts 时画卫星绑定的挂点（再加视场锥），否则画模型自带的 attach point。
    // 挂在关节节点上的装进随动组（updateFollowers 按关节位姿给组矩阵），关节滑杆一动就跟着走
    followers.length = 0; mountHits.length = 0
    const apList = meta && Array.isArray(meta.attachPoints) ? meta.attachPoints : []
    const nodeOfAp = (name) => { if (!name) return ''; const a = apList.find((x) => x && x.name === name); return a && typeof a.node === 'string' ? a.node : '' }
    const holderFor = (node) => {
      if (!node) return ovBody
      const g = new THREE.Group(); g.matrixAutoUpdate = false; g.name = 'follow:' + node
      ovBody.add(g); followers.push({ g, node })
      return g
    }
    if (ov.attach && mounts) {
      const inkM = mode !== 'sun' && theme === 'light' ? 0x137a63 : MOUNT_COL
      const inkSel = mode !== 'sun' && theme === 'light' ? 0x006d9c : AP_SEL_COL
      const mk = (col, op) => dynMat(new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }))
      const lk = (col, op) => dynMat(new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: op, toneMapped: false }))
      const M = { disk: mk(MOUNT_COL, 0.9), line: lk(MOUNT_COL, 0.9), cone: mk(MOUNT_COL, 0.1), rim: lk(MOUNT_COL, 0.55) }
      const S = { disk: mk(AP_SEL_COL, 0.95), line: lk(AP_SEL_COL, 1), cone: mk(AP_SEL_COL, 0.16), rim: lk(AP_SEL_COL, 0.85) }
      for (const mt of mounts) {
        if (!mt || !Array.isArray(mt.posBody)) continue
        const sel = mountSel != null && mt.id === mountSel
        const K = sel ? S : M
        const parent = holderFor(nodeOfAp(mt.attachPoint))
        const p = new THREE.Vector3().fromArray(mt.posBody)
        const bd = Array.isArray(mt.boresightBody) ? mt.boresightBody : mt.dirBody
        const d = Array.isArray(bd) ? new THREE.Vector3().fromArray(bd).normalize() : new THREE.Vector3(0, 0, 1)
        if (!(d.lengthSq() > 0.5)) d.set(0, 0, 1)
        const dk = new THREE.Mesh(disk, K.disk); dk.scale.setScalar(r * (sel ? 0.032 : 0.022)); dk.position.copy(p); dk.quaternion.setFromUnitVectors(_Z, d); dk.renderOrder = sel ? 25 : 22
        const rayL = r * (sel ? 0.5 : 0.35)
        const tip = p.clone().addScaledVector(d, rayL)
        const g = new THREE.BufferGeometry().setFromPoints([p, tip]); dynamic.geoms.add(g)
        const ln = new THREE.Line(g, K.line); ln.renderOrder = sel ? 25 : 22
        parent.add(dk, ln)
        // 视场锥：半角 = coneHalfDeg（fov/2 或方向图 −3 dB 半宽），画面上夹在 [0.3°, 80°]（再宽就翻成一张盘，读不出方向）
        const half = Number(mt.coneHalfDeg)
        if (half > 0) {
          const h = Math.min(80, Math.max(0.3, half)) * Math.PI / 180
          const Lc = r * (sel ? 0.42 : 0.28), rc = Lc * Math.tan(h)
          const q = new THREE.Quaternion().setFromUnitVectors(_Z, d)
          const cone = new THREE.Mesh(coneGeo, K.cone); cone.scale.set(rc, rc, Lc); cone.position.copy(p); cone.quaternion.copy(q); cone.renderOrder = sel ? 24 : 21
          const rim = new THREE.LineLoop(coneRim, K.rim); rim.scale.set(rc, rc, Lc); rim.position.copy(p); rim.quaternion.copy(q); rim.renderOrder = sel ? 24 : 21
          parent.add(cone, rim)
        }
        if (sel && Array.isArray(mt.upBody)) {
          const u = new THREE.Vector3().fromArray(mt.upBody).normalize()
          const gu = new THREE.BufferGeometry().setFromPoints([p, p.clone().addScaledVector(u, r * 0.12)]); dynamic.geoms.add(gu)
          const lu = new THREE.Line(gu, K.line); lu.renderOrder = 25
          parent.add(lu)
        }
        const tipObj = new THREE.Object3D(); tipObj.position.copy(tip); parent.add(tipObj)
        mountHits.push({ id: mt.id, disk: dk, tip: tipObj })
        addLabel(parent, String(mt.name || mt.id || ''), sel ? inkSel : inkM, p.clone().addScaledVector(d, r * (sel ? 0.52 : 0.37)), sel ? 20 : 18, true, sel ? 4 : 1)
      }
    } else if (ov.attach && apList.length) {
      const dm = dynMat(new THREE.MeshBasicMaterial({ color: AP_COL, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide, toneMapped: false }))
      const lm = dynMat(new THREE.LineBasicMaterial({ color: AP_COL, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }))
      const dms = dynMat(new THREE.MeshBasicMaterial({ color: AP_SEL_COL, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide, toneMapped: false }))
      const lms = dynMat(new THREE.LineBasicMaterial({ color: AP_SEL_COL, depthTest: false, toneMapped: false }))
      const inkAp = mode !== 'sun' && theme === 'light' ? 0x9a5b00 : AP_COL
      const inkSel = mode !== 'sun' && theme === 'light' ? 0x006d9c : AP_SEL_COL
      for (const ap of apList) {
        if (!ap || !Array.isArray(ap.posBody)) continue
        const sel = apSel != null && ap.name === apSel
        const parent = holderFor(typeof ap.node === 'string' ? ap.node : '')
        const p = new THREE.Vector3().fromArray(ap.posBody)
        const d = Array.isArray(ap.dirBody) ? new THREE.Vector3().fromArray(ap.dirBody).normalize() : new THREE.Vector3(0, 0, 1)
        const dk = new THREE.Mesh(disk, sel ? dms : dm); dk.scale.setScalar(r * (sel ? 0.032 : 0.022)); dk.position.copy(p); dk.quaternion.setFromUnitVectors(_Z, d); dk.renderOrder = sel ? 23 : 22
        const g = new THREE.BufferGeometry().setFromPoints([p, p.clone().addScaledVector(d, r * (sel ? 0.5 : 0.35))]); dynamic.geoms.add(g)
        const ln = new THREE.Line(g, sel ? lms : lm); ln.renderOrder = sel ? 23 : 22
        parent.add(dk, ln)
        // 选中挂点的上向（本体系），细短线：看得出天线滚转
        if (sel && Array.isArray(ap.upBody)) {
          const u = new THREE.Vector3().fromArray(ap.upBody).normalize()
          const gu = new THREE.BufferGeometry().setFromPoints([p, p.clone().addScaledVector(u, r * 0.12)]); dynamic.geoms.add(gu)
          const lu = new THREE.Line(gu, lms); lu.renderOrder = 23
          parent.add(lu)
        }
        addLabel(parent, String(ap.name || ''), sel ? inkSel : inkAp, p.clone().addScaledVector(d, r * (sel ? 0.52 : 0.37)), sel ? 20 : 18, true, sel ? 4 : 1)
      }
    }
    updateFollowers()
    // 质心
    const com = meta && meta.massProps && Array.isArray(meta.massProps.comBody) ? meta.massProps.comBody : null
    if (ov.com && com) {
      const p = new THREE.Vector3().fromArray(com)
      const sm = dynMat(new THREE.MeshBasicMaterial({ map: comTex, depthTest: false, transparent: true, toneMapped: false }))
      const s = new THREE.Mesh(sphere, sm); s.scale.setScalar(r * 0.028); s.position.copy(p); s.renderOrder = 24
      ovBody.add(s)
      const L = r * 0.11
      for (const k of ['x', 'y', 'z']) {
        const lm = dynMat(new THREE.LineBasicMaterial({ color: AXIS_COL[k], depthTest: false, transparent: true, toneMapped: false }))
        const a = new THREE.Vector3(k === 'x' ? L : 0, k === 'y' ? L : 0, k === 'z' ? L : 0)
        const g = new THREE.BufferGeometry().setFromPoints([p.clone().sub(a), p.clone().add(a)]); dynamic.geoms.add(g)
        const ln = new THREE.Line(g, lm); ln.renderOrder = 23
        ovBody.add(ln)
      }
    }
    // 线框：共享模型几何，矩阵跟网格世界矩阵同步（场景内叠加：要与模型做深度比较）
    if (ov.wireframe) {
      const wm = dynMat(new THREE.MeshBasicMaterial({ color: dark ? 0x9fd3ff : 0x1c4f8a, wireframe: true, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }))
      for (const mesh of meshes) {
        const w = new THREE.Mesh(mesh.geometry, wm)
        w.matrixAutoUpdate = false; w.userData.follow = mesh; w.renderOrder = 5
        w.layers.set(L_SCENE_OV)
        ovWorld.add(w)
      }
    }
    buildParts()
    buildNodeHighlight()
    syncWorldOverlays()
    labelScale()   // 新标签按当前视口高度定尺（精灵缺省 scale 1 = 半个屏幕高）
    labels.sort((a, b) => (b.userData.prio || 0) - (a.userData.prio || 0))   // 避让按优先级占位（稳定排序：同级保持加入顺序）
  }

  // 部件着色：按 role 调色，半透明叠在原材质上（不改原材质）。
  // 部件给法（segment.mjs / paramBus / 手工，四种都认）：parts.nodes = IR 节点名（整节点归本部件）、triRanges = IR 节点名 + 实例内三角形段、
  // triRange / tris = 全局三角形号。IR 节点名与 irLayout 同一口径（多材质网格拆出的「对象名_材质名」子节点、重名节点的 _2…），
  // 所以按名字先查 irNodeTable（子节点落到该材质组那一段索引），查不到再退回按原名找 three 节点。
  let _nodeTab = null, _triTab = null   // 随模型缓存（setModel 时清）
  function nodeTable() { return _nodeTab || (_nodeTab = irNodeTable(root)) }
  function triTab() { return _triTab || (_triTab = triTable(root)) }
  function subsetGeom(src, ranges) {
    // ranges：[[索引起点, 索引个数], …]（索引个数计）；共享属性缓冲，只造自己的索引
    const ia = src.index ? src.index.array : null
    let n = 0
    for (const r of ranges) n += r[1]
    if (!n) return null
    const idx = new (src.attributes.position.count <= 65535 ? Uint16Array : Uint32Array)(n)
    let w = 0
    for (const [s, c] of ranges) for (let k = 0; k < c; k++) idx[w++] = ia ? ia[s + k] : s + k
    const g = new THREE.BufferGeometry()
    for (const k of Object.keys(src.attributes)) g.setAttribute(k, src.attributes[k])
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    if (src.boundingSphere) g.boundingSphere = src.boundingSphere.clone()
    if (src.boundingBox) g.boundingBox = src.boundingBox.clone()
    g.userData._borrowed = true
    dynamic.geoms.add(g)
    return g
  }
  function tintMat(color, op) {
    return dynMat(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, toneMapped: false }))
  }
  function addTint(mesh, geom, m) {
    if (!geom) return
    const w = new THREE.Mesh(geom, m); w.matrixAutoUpdate = false; w.userData.follow = mesh; w.renderOrder = 6
    w.layers.set(L_SCENE_OV)
    ovWorld.add(w)
  }
  // 单材质网格节点 = 一个 IR 实例：只画它自己（子节点是别的实例，各归各的）；无网格节点（组、多材质网格对象本身）= 整棵子树
  function tintNode(obj, m) {
    if (obj.isMesh && obj.geometry && !Array.isArray(obj.material)) addTint(obj, obj.geometry, m)
    else obj.traverse((o) => { if (o.isMesh && o.geometry) addTint(o, o.geometry, m) })
  }
  let _byName = null
  function byOrigName(nm) {
    if (!_byName) { _byName = new Map(); root.traverse((o) => { const n = originalName(o); if (n && !_byName.has(n)) _byName.set(n, o) }) }
    return _byName.get(nm)
  }
  function tintNames(names, m) {
    let drew = false
    const nodeTab = nodeTable()
    for (const nm of names) {
      const e = nodeTab.get(nm)
      if (e && e.sub) { addTint(e.mesh, subsetGeom(e.mesh.geometry, [[e.start, e.count]]), m); drew = true; continue }
      if (e) { tintNode(e.obj, m); drew = true; continue }
      const o = byOrigName(nm)
      if (o) { tintNode(o, m); drew = true }
    }
    return drew
  }
  function buildParts() {
    _byName = null
    const parts = meta && Array.isArray(meta.parts) ? meta.parts : []
    if (!parts.length || (!ov.parts && !(highlight && highlight.size))) return
    const table = triTab()
    const nodeTab = nodeTable()
    for (const part of parts) {
      const on = highlight && highlight.has(part.id)
      if (!ov.parts && !on) continue
      const base = ROLE_COLORS[part.role] ?? ROLE_COLORS.other
      const op = on ? 0.62 : (highlight && highlight.size ? 0.12 : 0.36)
      const m = tintMat(base, op)
      let drew = false
      if (Array.isArray(part.nodes) && part.nodes.length) drew = tintNames(part.nodes, m) || drew
      // segment.mjs 的口径：triRanges = [{node: IR 节点名, ranges: [[起始三角形, 个数], …]}]（实例内局部编号）。
      // 「整节点 + 部分三角形」的部件（翼 + 并进来的边框）两者都画
      if (Array.isArray(part.triRanges) && part.triRanges.length) {
        for (const tr of part.triRanges) {
          const e = tr && nodeTab.get(tr.node)
          if (!e || !e.mesh || !Array.isArray(tr.ranges)) continue
          const rr = []
          for (const rg of tr.ranges) {
            const s = Math.max(0, rg[0] | 0), n = Math.max(0, Math.min(rg[1] | 0, e.count / 3 - s))
            if (n) rr.push([e.start + s * 3, n * 3])
          }
          const g = subsetGeom(e.mesh.geometry, rr)
          if (g) { addTint(e.mesh, g, m); drew = true }
        }
      }
      if (drew) continue
      // 三角形子集（全局编号）：按全局编号落到各网格，拼新索引（共享属性缓冲）
      let list = null
      if (Array.isArray(part.triRange) && part.triRange.length === 2) { const [s, c] = part.triRange; list = { has: (t) => t >= s && t < s + c, lo: s, hi: s + c } }
      else if (part.tris && part.tris.length) { const st = new Set(part.tris); let lo = Infinity, hi = -Infinity; for (const t of st) { if (t < lo) lo = t; if (t > hi) hi = t } list = { has: (t) => st.has(t), lo, hi: hi + 1 } }
      if (!list) continue
      for (const e of table) {
        if (e.global + e.count <= list.lo || e.global >= list.hi) continue
        const rr = []
        for (let t = 0; t < e.count; t++) {
          if (!list.has(e.global + t)) continue
          const b = e.start + t * 3
          const last = rr[rr.length - 1]
          if (last && last[0] + last[1] === b) last[1] += 3; else rr.push([b, 3])
        }
        addTint(e.mesh, subsetGeom(e.mesh.geometry, rr), m)
      }
    }
  }
  function buildNodeHighlight() {
    if (!nodeHl || !nodeHl.size || !root) return
    tintNames([...nodeHl], tintMat(NODE_HL_COL, 0.55))
  }
  function syncWorldOverlays() {
    scene.updateMatrixWorld(true)
    for (const w of ovWorld.children) { const f = w.userData.follow; if (f) { w.matrix.copy(f.matrixWorld); w.matrixWorldNeedsUpdate = true; w.visible = shown(f) } }
  }

  // ---------------- 关节联动（挂点叠加随关节位姿走）----------------
  // 挂点（attach point）的 posBody / dirBody 是按【文件位姿】量的（导入 / 生成时节点矩阵原样）；关节把节点从文件位姿挪到当前位姿，
  // 挂点跟着同一个刚体变换走。节点相对模型根的局部链 N = Π（被摆过的取文件位姿 / 当前矩阵），本体系增量
  // T = H·N_now·N_file⁻¹·H⁻¹（H = holder × root：模型系 → 本体系）。链上没有被摆过的节点 → 不动（单位阵）。
  const _fm = new THREE.Matrix4(), _nm = new THREE.Matrix4(), _hm = new THREE.Matrix4(), _hi = new THREE.Matrix4()
  function nodeDeltaBody(name, out) {
    out.identity()
    if (!root || !name || !filePose.size) return false
    let o = null
    for (const x of resolveNodes(new Set([name]))) { o = x; break }
    if (!o) return false
    let posed = false
    for (let p = o; p && p !== root; p = p.parent) if (filePose.has(p)) { posed = true; break }
    if (!posed) return false
    _fm.identity(); _nm.identity()
    for (let p = o; p && p !== root; p = p.parent) {
      const fp = filePose.get(p)
      _fm.premultiply(fp ? fp.m : p.matrix)
      _nm.premultiply(p.matrix)
    }
    _hm.multiplyMatrices(holder.matrix, root.matrix)
    _hi.copy(_hm).invert()
    out.copy(_hm).multiply(_nm).multiply(_fm.invert()).multiply(_hi)
    return true
  }
  function updateFollowers() {
    for (const f of followers) {
      nodeDeltaBody(f.node, f.g.matrix)
      f.g.matrixWorldNeedsUpdate = true
    }
  }
  /** 调试 / 验证台：某挂点（模型挂点名）当前（随关节）在本体系的位置；不在关节链上返回原位 */
  function attachPoseNow(name) {
    const a = meta && Array.isArray(meta.attachPoints) ? meta.attachPoints.find((x) => x && x.name === name) : null
    if (!a || !Array.isArray(a.posBody)) return null
    const M = new THREE.Matrix4()
    nodeDeltaBody(typeof a.node === 'string' ? a.node : '', M)
    const p = new THREE.Vector3().fromArray(a.posBody).applyMatrix4(M)
    return [p.x, p.y, p.z]
  }

  function setOverlays(o) {
    if (!o) return
    let changed = false
    for (const k of Object.keys(ov)) if (k in o && ov[k] !== !!o[k]) { ov[k] = !!o[k]; changed = true }
    if (!changed) return
    if ('grid' in o) { fitStudio(); contactDirty = true }
    rebuildOverlays()
    invalidate()
  }
  function highlightParts(ids) {
    highlight = ids && ids.length ? new Set(ids) : null
    rebuildOverlays()
    invalidate()
  }
  /** 按 IR 节点名高亮（太阳翼组 / 不遮挡节点 / 关节节点）；null 清除 */
  function highlightNodes(names) {
    nodeHl = names && names.length ? new Set(names) : null
    rebuildOverlays()
    invalidate()
  }
  /** 选中挂点（名字；null 清除）：换色放大、画上向 */
  function setAttachHighlight(name) {
    const n = name == null || name === '' ? null : String(name)
    if (n === apSel) return
    apSel = n
    rebuildOverlays()
    invalidate()
  }

  // ---------------- 二期：卫星挂点 / 掩模球面片 / 天线视角 ----------------
  /**
   * 卫星绑定的挂点（mount）列表：[{id, name, posBody, boresightBody, upBody, attachPoint?, coneHalfDeg?}]（本体系，纯数据）；
   * null = 回到画模型挂点。opts.selId 顺带设选中。
   */
  function setMounts(list, opts = {}) {
    mounts = Array.isArray(list) ? list.map((m) => ({ ...m })) : null
    if (opts && 'selId' in opts) mountSel = opts.selId == null || opts.selId === '' ? null : String(opts.selId)
    rebuildOverlays()
    invalidate()
  }
  function setMountSelection(id) {
    const n = id == null || id === '' ? null : String(id)
    if (n === mountSel) return
    mountSel = n
    if (mounts) { rebuildOverlays(); invalidate() }
  }
  /** 预览里点选挂点（圆盘或射线端 14 px 内）→ cb(id)；null 取消 */
  function onMountPick(cb) { mountPickCb = typeof cb === 'function' ? cb : null }
  function mountAtScreen(ev) {
    if (!mounts || !ov.attach || !mountHits.length) return null
    const rc = canvas.getBoundingClientRect()
    ovRoot.updateMatrixWorld(true)
    let best = null, bd = MOUNT_PICK_PX * MOUNT_PICK_PX
    for (const h of mountHits) {
      for (const o of [h.disk, h.tip]) {
        o.getWorldPosition(_v); _v.project(camera)
        if (_v.z > 1 || _v.z < -1) continue
        const x = (_v.x * 0.5 + 0.5) * rc.width + rc.left, y = (0.5 - _v.y * 0.5) * rc.height + rc.top
        const d2 = (x - ev.clientX) * (x - ev.clientX) + (y - ev.clientY) * (y - ev.clientY)
        if (d2 < bd) { bd = d2; best = h.id }
      }
    }
    return best
  }

  /**
   * 掩模球面片（D2 口径，本体系）：o = {blocked: Uint8Array(360×181), originBody:[3]} | null。
   * 球心 = 掩模射线起点，半径 = 2 × 包围半径（本体原点到最远顶点）；遮挡格按行合并成段、每段按 ≤ 2° 细分成四边形。
   */
  function setMaskOverlay(o) {
    maskOv = o && o.blocked && o.blocked.length === 360 * 181 ? { blocked: o.blocked, originBody: Array.isArray(o.originBody) ? o.originBody.slice() : [0, 0, 0] } : null
    buildMaskPatch()
    invalidate()
  }
  function setMaskVisible(on) { maskOn = !!on; syncMaskVis(); invalidate() }
  function syncMaskVis() {
    maskSceneGrp.visible = !!maskOv && maskOn && !av
    maskTopGrp.visible = !!maskOv && maskOn && !!av
  }
  function clearAvGrp() {
    for (const c of avGrp.children.slice()) avGrp.remove(c)
    for (const g of avDyn) g.dispose()
    avDyn.length = 0
  }
  function clearMaskPatch() {
    for (const g of [maskSceneGrp, maskTopGrp]) for (const c of g.children.slice()) g.remove(c)
    for (const g of maskDyn.geoms) g.dispose()
    maskDyn.geoms.length = 0
  }
  function buildMaskPatch() {
    clearMaskPatch()
    syncMaskVis()
    if (!maskOv || !root) return
    const B = maskOv.blocked, O = maskOv.originBody
    const R = 2 * Math.max(radiusO, radius)
    const D2R = Math.PI / 180
    const pos = [], idx = [], seg = []
    const put = (az, el) => { const a = az * D2R, e = el * D2R, ce = Math.cos(e); pos.push(O[0] + R * ce * Math.cos(a), O[1] + R * ce * Math.sin(a), O[2] + R * Math.sin(e)); return pos.length / 3 - 1 }
    const vtx = (az, el) => { const a = az * D2R, e = el * D2R, ce = Math.cos(e); return [O[0] + R * ce * Math.cos(a), O[1] + R * ce * Math.sin(a), O[2] + R * Math.sin(e)] }
    const edge = (a0, e0, a1, e1) => { const p = vtx(a0, e0), q = vtx(a1, e1); seg.push(p[0], p[1], p[2], q[0], q[1], q[2]) }
    const blk = (a, e) => (e < 0 || e > 180 ? 0 : B[e * 360 + (((a % 360) + 360) % 360)])
    for (let e = 0; e <= 180; e++) {
      const lo = Math.max(-90, e - 90 - 0.5), hi = Math.min(90, e - 90 + 0.5)
      const row = e * 360
      // 按行找遮挡段（段可以跨 0 / 360 缝：从一个通畅格起扫一整圈；整行全遮挡另算）
      let start = -1
      for (let k = 0; k < 360; k++) if (!B[row + k]) { start = k; break }
      const runs = []
      if (start < 0) runs.push([0, 359])
      else {
        let a0 = -1
        for (let t = 1; t <= 360; t++) {
          const a = (start + t) % 360, b = B[row + a]
          if (b && a0 < 0) a0 = start + t
          if ((!b || t === 360) && a0 >= 0) { runs.push([a0, start + t - (b ? 0 : 1)]); a0 = -1 }
        }
      }
      for (const [a0, a1] of runs) {
        const az0 = a0 - 0.5, az1 = a1 + 0.5
        const n = Math.max(1, Math.ceil((az1 - az0) / 2))
        let pl = put(az0, lo), ph = put(az0, hi)
        for (let k = 1; k <= n; k++) {
          const az = az0 + (az1 - az0) * k / n
          const ql = put(az, lo), qh = put(az, hi)
          idx.push(pl, ql, qh, pl, qh, ph)
          pl = ql; ph = qh
        }
      }
      // 遮挡区边界：遮挡格与通畅格之间的格边（极点行的外缘在极点上，不画）
      for (let a = 0; a < 360; a++) {
        if (!B[row + a]) continue
        if (!blk(a - 1, e)) edge(a - 0.5, lo, a - 0.5, hi)
        if (!blk(a + 1, e)) edge(a + 0.5, lo, a + 0.5, hi)
        if (e > 0 && !blk(a, e - 1)) edge(a - 0.5, lo, a + 0.5, lo)
        if (e < 180 && !blk(a, e + 1)) edge(a - 0.5, hi, a + 0.5, hi)
      }
    }
    if (!idx.length) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
    const gl = new THREE.BufferGeometry()
    gl.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3))
    maskDyn.geoms.push(g, gl)
    const fill = new THREE.Mesh(g, maskFillMat); fill.renderOrder = 8; fill.layers.set(L_SCENE_OV); fill.frustumCulled = false
    const line = new THREE.LineSegments(gl, maskLineMat); line.renderOrder = 9; line.layers.set(L_SCENE_OV); line.frustumCulled = false
    maskSceneGrp.add(fill, line)
    const fillT = new THREE.Mesh(g, maskFillTopMat); fillT.renderOrder = 40; fillT.frustumCulled = false
    const lineT = new THREE.LineSegments(gl, maskLineTopMat); lineT.renderOrder = 41; lineT.frustumCulled = false
    maskTopGrp.add(fillT, lineT)
  }

  /**
   * 天线视角：o = {posBody, boresightBody, upBody, fovDeg, hideNodes?} | null。相机在掩模射线起点（挂点 + 1 cm·视轴）沿视轴看，
   * 上向 = 挂点 up，竖直视场 = fovDeg（夹在 [1°, 170°]）；视场圈 = 视轴周围半角 fov/2 的方向（画在最上层）。
   * hideNodes = 挂点的排除节点（连同子孙；与掩模计算同一份名单）：这一视角里不画，看到的遮挡与掩模一致。
   * 进入时存下相机与控件状态，退出（null）时原样恢复。
   */
  function setAntennaView(o) {
    if (!o) {
      if (!av) return
      const s = av.saved
      av = null
      camera.up.set(0, 1, 0)
      camera.fov = s.fov; camera.near = s.near; camera.far = s.far
      camera.position.copy(s.pos)
      controls.target.copy(s.target)
      camera.lookAt(s.target)
      camera.updateProjectionMatrix()
      controls.enabled = true
      killInertia(); controls.update()
      ovBody.visible = true
      avGrp.visible = false
      clearAvGrp()
      syncMaskVis(); rebuildGroundVis()
      invalidate()
      return
    }
    if (!root) return
    const bd = Array.isArray(o.boresightBody) ? o.boresightBody : o.dirBody
    const d = new THREE.Vector3().fromArray(Array.isArray(bd) ? bd : [0, 0, 1])
    if (!(d.lengthSq() > 0)) d.set(0, 0, 1)
    d.normalize()
    const u = new THREE.Vector3().fromArray(Array.isArray(o.upBody) ? o.upBody : [0, -1, 0])
    u.addScaledVector(d, -u.dot(d))
    if (u.lengthSq() < 1e-8) u.set(Math.abs(d.x) < 0.9 ? 1 : 0, Math.abs(d.x) < 0.9 ? 0 : 1, 0).addScaledVector(d, -d.x)
    u.normalize()
    const p = new THREE.Vector3().fromArray(Array.isArray(o.posBody) ? o.posBody : [0, 0, 0]).addScaledVector(d, 0.01)   // 与 mask.maskRayOrigin 同一个起点
    if (!av) av = { saved: { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, near: camera.near, far: camera.far } }
    av.fovDeg = Math.min(170, Math.max(1, Number(o.fovDeg) || 60))
    av.hide = Array.isArray(o.hideNodes) && o.hideNodes.length ? [...resolveNodes(o.hideNodes)] : null
    av.hideVis = av.hide ? new Array(av.hide.length).fill(true) : null
    controls.enabled = false
    killInertia()
    const pd = p.clone().applyMatrix4(BODY_TO_DISPLAY), dd = d.clone().applyMatrix4(BODY_TO_DISPLAY), ud = u.clone().applyMatrix4(BODY_TO_DISPLAY)
    camera.position.copy(pd)
    camera.up.copy(ud)
    camera.lookAt(pd.clone().add(dd))
    camera.fov = av.fovDeg
    camera.near = Math.max(1e-4, radius * 1e-4)
    camera.far = Math.max(radius, radiusO) * 8
    camera.updateProjectionMatrix()
    // 视场圈（半角 fov/2 的方向，距 2R）+ 视轴十字：本体系、画在最上层
    clearAvGrp()
    const R = 2 * Math.max(radiusO, radius), half = av.fovDeg / 2 * Math.PI / 180
    const x = new THREE.Vector3().crossVectors(u, d).normalize()
    const pts = []
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2
      pts.push(p.clone().addScaledVector(d, R * Math.cos(half)).addScaledVector(x, R * Math.sin(half) * Math.cos(a)).addScaledVector(u, R * Math.sin(half) * Math.sin(a)))
    }
    const gRim = new THREE.BufferGeometry().setFromPoints(pts); avDyn.push(gRim)
    const rim = new THREE.Line(gRim, avRimMat); rim.renderOrder = 42; rim.frustumCulled = false
    const cr = Math.tan(Math.min(half, 0.35) * 0.08) * R
    const c0 = p.clone().addScaledVector(d, R)
    const gX = new THREE.BufferGeometry().setFromPoints([c0.clone().addScaledVector(x, -cr), c0.clone().addScaledVector(x, cr), c0.clone().addScaledVector(u, -cr), c0.clone().addScaledVector(u, cr)]); avDyn.push(gX)
    const cross = new THREE.LineSegments(gX, avRimMat); cross.renderOrder = 42; cross.frustumCulled = false
    avGrp.add(rim, cross)
    avGrp.visible = true
    ovBody.visible = false
    hover.visible = false
    ground.visible = false
    syncMaskVis()
    invalidate()
  }

  // ---------------- 光照 / 主题 / 画质 ----------------
  function setLight(m) {
    mode = m === 'sun' ? 'sun' : 'studio'
    studio.setMode(mode)
    el.style.background = studioBackground(mode, theme)
    fitStudio()
    tuneAo()
    contactDirty = true
    rebuildOverlays()
    invalidate()
  }
  /** 太阳方向，本体系（从模型指向太阳） */
  // 显式给过（二期「分析」页按真实太阳矢量摆）就一直用它；null 回到自动
  function setSunDir(v) {
    if (!v) { sunExplicit = false; aimSun(); invalidate(); return }
    _v.set(v[0], v[1], v[2])
    if (_v.lengthSq() === 0) return
    sunExplicit = true
    _v.applyMatrix4(BODY_TO_DISPLAY)
    studio.setSunDir(_v)
    invalidate()
  }
  function setTheme(t) {
    theme = t === 'dark' ? 'dark' : 'light'
    el.style.background = studioBackground(mode, theme)
    rebuildOverlays()
    invalidate()
  }
  function setQuality(q) {
    const nq = QUALITY[q] ? q : 'high'
    if (nq === quality) return
    quality = nq
    renderer.setPixelRatio(dprOf())
    renderer.setSize(cssW, cssH, false)
    if (studio.setShadowMapSize) studio.setShadowMapSize(QUALITY[quality].shadowMap)
    buildPipeline()
    labelScale()
    contactDirty = true
    invalidate()
  }

  // ---------------- 关节 ----------------
  /**
   * 驱动关节：stageValues 可以是按 stages 顺序的数组，也可以是 {stageName: 值}；缺的取 initialValue。
   * 各 stage 依次右乘在节点文件位姿上（AGI：按顺序作用于节点自身坐标系；角度为度、平移为模型单位），数学在 thumbs.poseArticulations。
   * 值记在视口里（artLive）：之后元数据改动重喂时照这个值重摆。null = 该关节回初值。
   */
  function setArticulation(name, stageValues) {
    if (!root) return false
    const art = meta && Array.isArray(meta.articulations) ? meta.articulations.find((a) => a && a.name === name) : null
    const next = { ...artLive }
    // null：清掉这条的滑杆值 —— 关节改了名 / 删掉之后元数据里已经没有它，照样要清
    if (stageValues == null) { if (!(name in next)) return !!art; delete next[name] }
    else if (!art) return false
    else next[name] = Array.isArray(stageValues) ? stageValues.slice() : (art.stages || []).map((s) => stageValues[s.name])
    artLive = next; nLive = Object.keys(next).length
    applyPose(true)
    syncWorldOverlays()
    updateFollowers()
    contactDirty = true
    invalidate()
    return true
  }
  /** 全部关节回初值（加载时的位姿） */
  function resetArticulations() { artLive = {}; nLive = 0; applyPose(true); syncWorldOverlays(); updateFollowers(); contactDirty = true; invalidate() }
  /** 当前滑杆值（关节名 → 数组）；没动过的关节不在里面 */
  function articulationState() { const o = {}; for (const k of Object.keys(artLive)) o[k] = artLive[k].slice(); return o }

  // ---------------- 拾取 ----------------
  // indirect：不重排原索引（部件 triRange、交出去的三角形号都按原索引数）
  function bvhWorkerCall(g) {
    if (!bvhWorker) {
      bvhWorker = new Worker(new URL('./bvhWorker.js', import.meta.url), { type: 'module' })
      bvhWorker.onmessage = (ev) => {
        const d = ev.data || {}, p = bvhPending.get(d.id)
        if (!p) return
        bvhPending.delete(d.id)
        d.ok ? p.res(d) : p.rej(new Error(d.error))
      }
      bvhWorker.onerror = (ev) => {
        for (const p of bvhPending.values()) p.rej(new Error('BVH 线程出错：' + (ev.message || '')))
        bvhPending.clear()
      }
    }
    // 位置拷一份送过去（原数组还在画）；交错 / 量化属性按分量解成普通 Float32
    const pa = g.attributes.position
    let position
    if (!pa.isInterleavedBufferAttribute && !pa.normalized && pa.array instanceof Float32Array && pa.itemSize === 3) position = pa.array.slice(0, pa.count * 3)
    else { position = new Float32Array(pa.count * 3); for (let i = 0; i < pa.count; i++) { position[i * 3] = pa.getX(i); position[i * 3 + 1] = pa.getY(i); position[i * 3 + 2] = pa.getZ(i) } }
    const index = g.index ? g.index.array.slice() : null
    const id = ++bvhReqSeq
    return new Promise((res, rej) => {
      bvhPending.set(id, { res, rej })
      bvhWorker.postMessage({ id, position, index, groups: g.groups.map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex })), drawRange: { start: g.drawRange.start, count: g.drawRange.count } },
        index ? [position.buffer, index.buffer] : [position.buffer])
    })
  }
  function ensureBvh() {
    if (bvhReady) return
    const tok = ++bvhToken
    const todo = []
    let total = 0
    for (const m of meshes) {
      const g = m.geometry
      if (!g.boundsTree && !todo.includes(g)) { todo.push(g); total += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3) }
    }
    const finish = () => { for (const m of meshes) if (m.geometry.boundsTree) m.raycast = acceleratedRaycast; bvhReady = true; if (pick.kind === 'surface') canvas.style.cursor = 'crosshair' }
    if (total <= BVH_SYNC_TRIS) { for (const g of todo) g.boundsTree = new MeshBVH(g, { indirect: true }); finish(); return }
    // 大模型：Worker 里逐个几何建树，建好一个挂一个；全部到齐才开放拾取（半套 BVH 会漏命中）
    if (pick.kind === 'surface') canvas.style.cursor = 'progress'
    ;(async () => {
      for (const g of todo) {
        if (tok !== bvhToken || !alive) return
        if (g.boundsTree) continue
        try {
          const d = await bvhWorkerCall(g)
          if (!g.boundsTree) g.boundsTree = MeshBVH.deserialize({ version: d.version, roots: d.roots, indirectBuffer: d.indirectBuffer, index: null }, g, { setIndex: false, indirect: true })
        } catch (e) {
          if (tok !== bvhToken || !alive) return
          if (!g.boundsTree) g.boundsTree = new MeshBVH(g, { indirect: true })
          console.warn('[models] BVH Worker 失败，改主线程：' + ((e && e.message) || e))
        }
      }
      if (tok === bvhToken && alive) { finish(); invalidate() }
    })()
  }
  function setNdc(ev) {
    const r = canvas.getBoundingClientRect()
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
  }
  // 实际可见（自身与祖先都 visible）：Raycaster 不看 visible，初值为 0 被藏起来的喷焰照样会被打中
  function shown(o) { for (let p = o; p && p !== root; p = p.parent) if (!p.visible) return false; return true }
  function castAt(ev) {
    if (!bvhReady) return null
    setNdc(ev)
    raycaster.setFromCamera(ndc, camera)
    hits.length = 0
    raycaster.intersectObjects(meshes, false, hits)
    for (let i = 0; i < hits.length; i++) if (shown(hits[i].object)) return hits[i]   // 按距离排好的：第一个看得见的
    return null
  }
  function hitToBody(h) {
    _inv.copy(bodyRoot.matrixWorld).invert()
    const p = _v.copy(h.point).applyMatrix4(_inv)
    _m3.getNormalMatrix(h.object.matrixWorld)
    const n = _n.copy(h.face.normal).applyMatrix3(_m3).normalize()
    if (n.dot(raycaster.ray.direction) > 0) n.negate()      // 双面材质打到背面：法向朝射线来处
    n.applyQuaternion(_q.copy(BODY_TO_DISPLAY_Q).invert())
    let o = h.object, nodeName = ''
    while (o && o !== root) { if (o.userData && typeof o.userData.name === 'string') { nodeName = o.userData.name; break } o = o.parent }
    if (!nodeName) nodeName = h.object.name
    // 三种编号一起交出去：网格内三角形号 triIndex、IR 节点名 + 实例内编号（segment.mjs 的 triRanges 口径）、全局编号
    const meshIndex = meshes.indexOf(h.object)
    let globalTri = -1, irNode = '', irTri = -1
    for (const e of triTab()) {
      if (e.mesh !== h.object) continue
      const local = h.faceIndex - e.start / 3
      if (local >= 0 && local < e.count) { globalTri = e.global + local; irNode = e.name; irTri = local; break }
    }
    return { pointBody: [p.x, p.y, p.z], normalBody: [n.x, n.y, n.z], nodeName, triIndex: h.faceIndex, meshIndex, globalTri, irNode, irTri }
  }
  let hoverPending = null
  function doHover() {
    const ev = hoverPending; hoverPending = null
    const h = castAt(ev)
    if (!h) { if (hover.visible) { hover.visible = false } return }
    _m3.getNormalMatrix(h.object.matrixWorld)
    _n.copy(h.face.normal).applyMatrix3(_m3).normalize()
    if (_n.dot(raycaster.ray.direction) > 0) _n.negate()
    hover.position.copy(h.point).addScaledVector(_n, radius * 0.002)
    hover.quaternion.setFromUnitVectors(_Z, _n)
    hover.scale.setScalar(radius * 0.025)
    hover.visible = true
  }
  /**
   * 拾取模式：'surface' 点表面（十字光标 + 悬停圆环，点击交出命中点 / 法向）；'select' 点选（普通光标，点击交出命中，
   * 点在空处交 null）；null 关闭。cb 收 hitToBody 的结果。
   */
  function pickMode(kind, cb) {
    const k = kind === 'surface' || kind === 'select' ? kind : null
    pick = { kind: k, cb: k ? cb : null }
    canvas.style.cursor = k === 'surface' ? 'crosshair' : ''
    if (k) ensureBvh()
    if (k !== 'surface') { hover.visible = false; invalidate() }
  }

  // 轴球点击：把六个轴端精灵按当前朝向投到 128 px 方框里，取离点击最近（且靠前）的那个
  const HELPER_VIEW = { posX: 'front', negX: 'back', posY: 'right', negY: 'left', posZ: 'bottom', negZ: 'top' }
  function helperHit(ev) {
    const r = canvas.getBoundingClientRect()
    const x0 = r.left + r.width - HELPER_DIM - 8, y0 = r.top + 8
    const lx = ev.clientX - x0, ly = ev.clientY - y0
    if (lx < 0 || ly < 0 || lx > HELPER_DIM || ly > HELPER_DIM) return false
    const px = (lx / HELPER_DIM) * 4 - 2, py = -((ly / HELPER_DIM) * 4 - 2)
    let best = null, bz = -Infinity
    for (const s of helperSprites) {
      s.getWorldPosition(_v)
      const d2 = (_v.x - px) * (_v.x - px) + (_v.y - py) * (_v.y - py)
      if (d2 < 0.36 * 0.36 && _v.z > bz) { best = s; bz = _v.z }
    }
    if (!best) return true
    setView(HELPER_VIEW[best.userData.type] || 'iso')
    return true
  }

  // ---------------- 指针事件 ----------------
  let down = null
  function onDown(ev) { down = { x: ev.clientX, y: ev.clientY, b: ev.button }; invalidate() }
  function onUp(ev) {
    const d = down; down = null
    if (!d || d.b !== 0) return
    if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5) return
    if (helperHit(ev)) return
    if (pointerOwner && ownerEats('click', ev)) return
    if (av) return
    // 点在卫星挂点的圆盘 / 射线端附近 = 选中它（点表面新增挂点的拾取模式下不抢）
    if (mountPickCb && pick.kind !== 'surface') {
      const id = mountAtScreen(ev)
      if (id != null) { try { mountPickCb(id) } catch (e) { console.error(e) } return }
    }
    if (pick.kind && pick.cb) {
      const h = castAt(ev)
      if (h) { try { pick.cb(hitToBody(h)) } catch (e) { console.error(e) } }
      else if (pick.kind === 'select') { try { pick.cb(null) } catch (e) { console.error(e) } }
    }
  }
  function onMove(ev) {
    if (pick.kind !== 'surface' || ev.buttons) return
    hoverPending = ev
    invalidate()
  }
  function onLeave() { if (hover.visible) { hover.visible = false; invalidate() } }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  function onDbl(ev) {   // 双击空处：回全景（自动视角）；live 模式先问点击归属（双击件 = 聚焦该件）
    if (pick.kind === 'surface' || helperHit(ev) || av) return
    if (pointerOwner && ownerEats('dbl', ev)) return
    setView('auto')
  }
  canvas.addEventListener('dblclick', onDbl)

  // ---------------- 快照 ----------------
  /**
   * 按指定尺寸重画一帧出图（不带轴球与拾取标记；叠加层照画）。走当前画质管线（AO / MSAA 与屏上一致）。
   * @param {{w?:number,h?:number,transparent?:boolean,type?:string,quality?:number}} [o]
   * @returns {Promise<Blob>}
   */
  function snapshot(o = {}) {
    const pr = renderer.getPixelRatio()
    const w = Math.max(1, Math.round(o.w || cssW * pr))
    const h = Math.max(1, Math.round(o.h || cssH * pr))
    const type = o.type || 'image/png'
    const hv = hover.visible
    hover.visible = false
    renderer.setPixelRatio(1)
    renderer.setSize(w, h, false)
    camera.aspect = w / h; camera.updateProjectionMatrix()
    resizePipeline()
    labelScale(h, h / cssH)
    if (contactDirty) updateContact()
    aoSkip = false
    renderMain()
    renderer.clearDepth()
    declutter(w, h, h / cssH)
    renderer.render(overlay, camera)
    let out = canvas
    if (!o.transparent) {
      // 不透明：把影棚 / 太阳背景画进 2D 画布再叠 WebGL 帧 —— 必须与 render 同一个任务里取，drawingBuffer 下一帧就清了
      out = document.createElement('canvas'); out.width = w; out.height = h
      const c = out.getContext('2d')
      paintStudioBackground(c, w, h, mode, theme)
      c.drawImage(canvas, 0, 0)
    } else {
      out = document.createElement('canvas'); out.width = w; out.height = h
      out.getContext('2d').drawImage(canvas, 0, 0)
    }
    const p = new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 失败'))), type, o.quality ?? 0.92))
    // 恢复
    renderer.setPixelRatio(pr)
    renderer.setSize(cssW, cssH, false)
    camera.aspect = cssW / cssH; camera.updateProjectionMatrix()
    resizePipeline()
    labelScale()
    hover.visible = hv
    renderNow()
    return p
  }

  /** 读数：tris = 模型三角形数；calls / drawnTris = 上一帧主场景实际提交的 draw call 与三角形 */
  function stats() {
    let hidden = 0
    for (const o of filePose.keys()) if (!o.visible) hidden++
    let maskTris = 0, maskSegs = 0
    for (const c of maskSceneGrp.children) { if (c.isMesh && c.geometry.index) maskTris += c.geometry.index.count / 3; else if (c.isLineSegments) maskSegs += c.geometry.attributes.position.count / 2 }
    return {
      tris, fps: Math.round(fps * 10) / 10, frameMs: Math.round(frameMs * 100) / 100, calls, drawnTris, pickReady: bvhReady, quality, ao: !!(pp && pp.ao), samples: pp ? pp.samples : 0,
      hlParts: highlight ? highlight.size : 0, hlNodes: nodeHl ? nodeHl.size : 0, labels: labels.length, labelsShown: labels.reduce((n, s) => n + (s.visible ? 1 : 0), 0),
      posedNodes: filePose.size, hiddenNodes: hidden, liveArticulations: nLive,
      mounts: mounts ? mounts.length : null, mountSel, followers: followers.length, maskTris, maskSegs, antennaView: !!av, antennaFovDeg: av ? av.fovDeg : null,
      live: liveMode
    }
  }
  /** 调试 / 验证台：按 IR 名（原名兜底）取预览克隆里节点的局部矩阵与显隐（关节是否真的动了） */
  function probeNode(name) {
    if (!root) return null
    for (const o of resolveNodes(new Set([String(name)]))) { o.updateMatrix(); return { matrix: o.matrix.toArray(), visible: o.visible, shown: shown(o) } }
    return null
  }

  function dispose() {
    alive = false
    avChangeCb = null; mountPickCb = null
    pointerOwner = null; frameHook = null   // live 根由下面的 clearModel 只摘不放（资源归编辑器）
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    if (ro) ro.disconnect()
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerleave', onLeave)
    canvas.removeEventListener('dblclick', onDbl)
    controls.removeEventListener('change', invalidate)
    controls.dispose()
    if (bvhWorker) { bvhWorker.terminate(); bvhWorker = null }
    for (const p of bvhPending.values()) p.rej(new Error('已取消'))
    bvhPending.clear()
    clearModel(true)
    clearOverlays()
    clearMaskPatch()
    clearAvGrp()
    helper.dispose()
    studio.dispose()
    disposePipeline()
    outPass.dispose()
    contact.dispose()
    disposeLoaders(renderer)   // 本 renderer 名下的 KTX2 转码器（makeGltfLoader(vp.renderer) 时建的）
    gpu.releaseAll()           // 共享资源（材质库、模型几何 / 贴图）上本 renderer 的 dispose 监听全部摘掉，死 renderer 才放得掉
    for (const g of own.geoms) g.dispose()
    for (const m of own.mats) m.dispose()
    for (const t of own.texs) t.dispose()
    renderer.dispose()
    try { renderer.forceContextLoss() } catch { /* ignore */ }
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
    el.style.background = ''
  }

  invalidate()
  return {
    setModel, clearModel: () => clearModel(false),
    setOverlays, setView, focusBody, setLight, setSunDir, setTheme, setQuality,
    highlightParts, highlightNodes, setAttachHighlight, setArticulation, resetArticulations, articulationState, pickMode,
    setMounts, setMountSelection, onMountPick, setMaskOverlay, setMaskVisible, setAntennaView, onAntennaViewChange, attachPoseNow,
    snapshot, stats, probeNode, resize: () => resize(), invalidate, dispose,
    // live 根（装配编辑器，CONTRACT §4）
    setLiveRoot, refreshLive, setDisplayUp, setPointerOwner, setFrameHook, viewState, setViewState, killInertia, precompile,
    get scene() { return scene },
    get overlay() { return overlay },
    get controls() { return controls },
    get canvas() { return canvas },
    get displayMatrix() { return BODY_TO_DISPLAY },
    get isLive() { return liveMode },
    get liveRoot() { return liveMode ? root : null },
    get displayDomain() { return displayDomain },
    get antennaView() { return !!av },
    get renderer() { return renderer },
    get camera() { return camera },
    get overlays() { return { ...ov } },
    get quality() { return quality },
    get mode() { return mode },
    get bounds() {
      return {
        center: center.toArray(), radius, radiusFromOrigin: radiusO, bboxBody: { min: bboxBody.min.slice(), max: bboxBody.max.slice() },
        bboxModelM: bboxModel.ok ? { min: bboxModel.min.slice(), max: bboxModel.max.slice() } : null
      }
    }
  }
}
