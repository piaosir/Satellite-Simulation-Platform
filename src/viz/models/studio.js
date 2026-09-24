// 影棚 / 太阳两档光照与环境（工作台预览、缩略图、离屏出图、3D 球跟随视图共用同一套，画面口径一致）。
//
// 只依赖 'three' 与 'three/addons/...'：scripts/nasa3d/sheets.mjs 的离屏页用 importmap 只映射了这两个前缀，
// 这里不许引 @core 或 src/shared。
//
// 两档：
//   studio（影棚）：PMREM(RoomEnvironment) 环境 + 三灯（暖主光带软阴影、冷补光、背后上方轮廓光）。产品摄影的布光：
//     主光定形、补光压反差、轮廓光把暗面边缘从背景里勾出来 —— NASA 3D Resources 缩略图就是这个观感。
//   sun（太阳）：单一硬平行光沿太阳矢量 + 半球光模拟地球反照（天顶 0 / 地面深海蓝），暗面近黑 —— NASA Eyes 的观感。
//     环境反射换成「太空」环境：上半球全黑、下半球是被照亮的地球（蓝、地平线附近偏亮的大气辉光）。
//     ★ 与 DESIGN §5.3 的差异：DESIGN 写的是 sun 档也用 RoomEnvironment × 0.25；实测房间环境在金属（金箔 / 铝）上
//       会映出一间「屋子」的亮块，太空里不可能有 —— 换成太空环境后金属下缘映出地球蓝，正是 NASA Eyes 的样子。
//       强度按新环境重调（见 SUN_ENV_INTENSITY），接口不变。
//   两档都是「场景」级设置：scene.environment / scene.environmentIntensity / environmentRotation，
//   不碰材质的 envMapIntensity（材质在工作台、缩略图、球面第二趟之间共享）。
//
// 色调：工作台 renderer 直接 ACES（configureRenderer）；3D 球共享 renderer 那一趟由 W8 按 T12 临时切、画完恢复。
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

// 影棚环境 0.55（DESIGN 写 1.0）：NASA 美术模型多为白 / 银，环境 1.0 是四面八方一样亮的漫射，叠三灯再过 ACES，
// 白件整片顶到肩部、没了明暗层次（TDRS-A 实测一片灰白）。环境压下来、主光抬到 3.2，形体才立得起来
export const STUDIO_ENV_INTENSITY = 0.55
export const SUN_ENV_INTENSITY = 0.55

/** 工作台 / 缩略图专用 renderer 的统一设置：ACES、sRGB 输出、PCF 软阴影 */
export function configureRenderer(renderer, { shadows = true, exposure = 1.0 } = {}) {
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = exposure
  renderer.shadowMap.enabled = !!shadows
  // r184 起 PCFSoftShadowMap 已并入 PCFShadowMap（Vogel 盘 + 交错梯度噪声的软 PCF，半径走 light.shadow.radius）
  renderer.shadowMap.type = THREE.PCFShadowMap
}

// 太空环境：大球内壁逐顶点着色（线性值），下半球地球、上半球黑，地平线一圈大气辉光。
// 用顶点色而不是贴图：PMREM 只需要低频信息，64×32 段的球足够，也省一张纹理的生命周期。
function spaceEnvScene() {
  const s = new THREE.Scene()
  const g = new THREE.SphereGeometry(50, 64, 32)
  const pos = g.attributes.position, n = pos.count
  const col = new Float32Array(n * 3)
  const earth = [0.10, 0.18, 0.32], deep = [0.035, 0.07, 0.14], haze = [0.35, 0.5, 0.75]
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i) / 50        // −1 天底 … +1 天顶
    let r = 0, gg = 0, b = 0
    if (y < 0) {
      // 地球盘：天底最亮（正下方的照亮地面），往地平线逐渐变深（斜看大气层变厚、夜侧也在这一带）
      const k = Math.min(1, -y / 0.9)
      r = deep[0] + (earth[0] - deep[0]) * k; gg = deep[1] + (earth[1] - deep[1]) * k; b = deep[2] + (earth[2] - deep[2]) * k
    }
    // 大气辉光：地平线上下 ±6° 一圈
    const h = Math.exp(-Math.pow(y / 0.08, 2))
    r += haze[0] * h * 0.5; gg += haze[1] * h * 0.5; b += haze[2] * h * 0.5
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const m = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })
  s.add(new THREE.Mesh(g, m))
  s.userData.dispose = () => { g.dispose(); m.dispose() }
  return s
}

const _up = new THREE.Vector3(0, 1, 0)
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene  局部场景（绝不传 3D 球的地球场景：会改它的 environment）
 * @param {{mode?:'studio'|'sun', shadowMapSize?:number, shadows?:boolean}} [o]
 */
export function createStudio(renderer, scene, o = {}) {
  const shadows = o.shadows !== false
  let mapSize = o.shadowMapSize || 2048
  const rig = new THREE.Group()
  rig.name = 'studio_rig'
  scene.add(rig)

  const pmrem = new THREE.PMREMGenerator(renderer)
  const env = { studio: null, sun: null }
  function envFor(mode) {
    if (env[mode]) return env[mode]
    if (mode === 'studio') {
      const room = new RoomEnvironment()
      env.studio = pmrem.fromScene(room, 0.04)
      room.dispose()
    } else {
      const sp = spaceEnvScene()
      env.sun = pmrem.fromScene(sp, 0.03)
      sp.userData.dispose()
    }
    return env[mode]
  }

  const mkDir = (color, intensity, cast) => {
    const l = new THREE.DirectionalLight(color, intensity)
    rig.add(l); rig.add(l.target)
    if (cast && shadows) {
      l.castShadow = true
      l.shadow.mapSize.set(mapSize, mapSize)
      l.shadow.bias = -0.0002
      l.shadow.radius = o.shadowRadius != null ? o.shadowRadius : 3   // 影棚软影；太阳档在 apply() 里改硬
    }
    return l
  }
  // 影棚三灯。方向是「从哪照过来」（光源位置方向），在显示坐标系（Y 上）里定；色温：主光略暖、补光偏冷
  const key = mkDir(new THREE.Color().setRGB(1.0, 0.955, 0.90), 3.2, true)
  const fill = mkDir(new THREE.Color().setRGB(0.86, 0.91, 1.0), 0.5, false)
  const rim = mkDir(0xffffff, 1.3, false)
  const KEY_DIR = new THREE.Vector3(1, 1.4, 0.8).normalize()
  const FILL_DIR = new THREE.Vector3(-1, 0.35, 0.55).normalize()
  const RIM_DIR = new THREE.Vector3(-0.45, 0.9, -1.1).normalize()
  // 太阳档
  const sun = mkDir(new THREE.Color().setRGB(1.0, 0.98, 0.95), 3.2, true)
  const hemi = new THREE.HemisphereLight(0x000000, 0x1d3a5f, 0.35)
  rig.add(hemi)

  let mode = o.mode === 'sun' ? 'sun' : 'studio'
  // 影棚灯组的整体朝向（相对「等轴视角下的标准布光」转了多少）：换视角时灯跟着视角转，从哪一面看都是同一套产品摄影布光
  // （主光在相机左上后方、轮廓光在背后）—— 不然从下方看（电池面朝下的星，自动视角常这样取）整面都在背光里。
  // 只作用于影棚档；太阳档的太阳方向另由 setSunDir 管。
  const rigQ = new THREE.Quaternion()
  const _d = new THREE.Vector3(), _e = new THREE.Euler()
  const center = new THREE.Vector3()
  let radius = 1
  const sunDir = new THREE.Vector3(1, 1, 0.6).normalize()
  const up = new THREE.Vector3(0, 1, 0)
  let eclipse = 1

  function placeDir(l, dir) {
    l.position.copy(dir).multiplyScalar(radius * 4).add(center)
    l.target.position.copy(center)
    if (l.castShadow) {
      // 阴影相机罩住包围球：正交半宽 = r（稍放一点），近远面沿光方向 [r·4 − r·1.2, r·4 + r·1.2]
      const c = l.shadow.camera
      const h = radius * 1.08
      c.left = -h; c.right = h; c.top = h; c.bottom = -h
      c.near = Math.max(1e-3, radius * 2.6); c.far = radius * 5.4
      c.updateProjectionMatrix()
      // 法向偏移按阴影贴图一个纹素的 1.5 倍（世界单位）：薄太阳翼既不自阴影长痘，也不漏光
      l.shadow.normalBias = (2 * h / mapSize) * 1.5
    }
  }

  function apply() {
    const st = mode === 'studio'
    key.visible = fill.visible = rim.visible = st
    sun.visible = hemi.visible = !st
    key.castShadow = st && shadows
    // 太阳是 0.5° 的小光源：本影边缘几乎是硬的；影棚主光模拟柔光箱，边缘放软
    key.shadow.radius = 3; sun.shadow.radius = 1
    sun.castShadow = !st && shadows
    scene.environment = envFor(mode).texture
    if (st) {
      scene.environmentIntensity = STUDIO_ENV_INTENSITY
      scene.environmentRotation.copy(_e.setFromQuaternion(rigQ))
      placeDir(key, _d.copy(KEY_DIR).applyQuaternion(rigQ)); placeDir(fill, _d.copy(FILL_DIR).applyQuaternion(rigQ)); placeDir(rim, _d.copy(RIM_DIR).applyQuaternion(rigQ))
    } else {
      // 地影期：太阳强度 × 地影因子（本影里留 0.02 的底，不至于全黑到看不出轮廓），地球反照照旧
      sun.intensity = Math.max(0.02, 3.2 * eclipse)
      scene.environmentIntensity = SUN_ENV_INTENSITY
      _q.setFromUnitVectors(_up, up)
      scene.environmentRotation.setFromQuaternion(_q)
      hemi.position.copy(up)
      placeDir(sun, sunDir)
    }
  }
  apply()

  return {
    rig,
    get mode() { return mode },
    setMode(m) { mode = m === 'sun' ? 'sun' : 'studio'; apply() },
    /** 太阳方向（从模型指向太阳，场景坐标） */
    setSunDir(v) { _v.set(v[0] ?? v.x, v[1] ?? v.y, v[2] ?? v.z); if (_v.lengthSq() > 0) { sunDir.copy(_v).normalize(); if (mode === 'sun') placeDir(sun, sunDir) } },
    /** 本地「上」（径向向上，场景坐标）：定半球光方向与太空环境的地球朝向 */
    setUp(v) { _v.set(v[0] ?? v.x, v[1] ?? v.y, v[2] ?? v.z); if (_v.lengthSq() > 0) { up.copy(_v).normalize(); if (mode === 'sun') apply() } },
    /** 地影因子 0（本影）… 1（全日照） */
    setEclipse(f) { eclipse = Math.max(0, Math.min(1, +f || 0)); if (mode === 'sun') sun.intensity = Math.max(0.02, 3.2 * eclipse) },
    /** 影棚灯组与环境整体转 q（相对标准布光；单位四元数 = 标准） */
    orient(q) { rigQ.copy(q).normalize(); if (mode === 'studio') apply() },
    /** 影棚主光的方向（从模型指向光源，显示系；含 orient 的转动） */
    keyDirection(out = new THREE.Vector3()) { return out.copy(KEY_DIR).applyQuaternion(rigQ) },
    /** 按模型包围球摆灯与阴影相机（模型换了 / 缩放变了调一次） */
    fit(c, r) { center.copy(c); radius = Math.max(1e-3, r); apply() },
    /** 改阴影贴图边长（画质档）：旧贴图放掉，下一帧按新尺寸重建；法向偏移按新纹素重算 */
    setShadowMapSize(n) {
      const s = Math.max(256, Math.min(8192, n | 0))
      if (s === mapSize) return
      mapSize = s
      for (const l of [key, sun]) {
        l.shadow.mapSize.set(s, s)
        if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null }
      }
      apply()
    },
    dispose() {
      scene.remove(rig)
      for (const l of [key, fill, rim, sun]) { if (l.shadow && l.shadow.map) l.shadow.map.dispose(); l.dispose() }
      hemi.dispose()
      if (scene.environment === (env.studio && env.studio.texture) || scene.environment === (env.sun && env.sun.texture)) scene.environment = null
      if (env.studio) env.studio.dispose()
      if (env.sun) env.sun.dispose()
      pmrem.dispose()
    }
  }
}

/**
 * 从「标准等轴相机」到给定相机朝向的相对旋转（studio.orient 的入参）：灯组随视角转，相对相机的布光与等轴视角一致。
 * @param {THREE.Vector3} dir 目标指向相机的单位向量（显示系）
 * @param {THREE.Vector3} isoDir 标准等轴方向（view.js 的 VIEW_DIRS.iso）
 * @param {THREE.Quaternion} out
 * @param {THREE.Vector3} [up] 该相机的屏幕上方（显示系；轴映射终案 ③ 天顶朝上 = 显示 +Y，即 view.js 的 ZENITH_DISPLAY [0, 1, 0]。
 *        ★ 这个显示系已经换过两次，别照旧注释传 −Y —— 三视图的灯组会整个倒过来）
 */
const _o0 = new THREE.Object3D(), _o1 = new THREE.Object3D(), _qi = new THREE.Quaternion(), _qt = new THREE.Quaternion(), _ax = new THREE.Vector3()
/**
 * 正视（相机沿某根坐标轴看：六个命名视角、报告三视图的正交格）时灯组额外绕相机右轴抬的角度（度）。
 * 为什么：标准布光的主光离等轴相机方向只有 ~23°（产品摄影的「顺光偏侧」）。等轴看时模型各面都是斜的，这样亮度正好；
 * 正视时迎面的大平面（白漆背板、反射面、基板）几乎被主光正照，ACES 之后整片顶到白（参数化星从天底看模型区平均亮度 229/255，
 * 读不出形状）。正视时把灯组朝相机上方抬 30°，主光离视线 ~50°：迎面大平面落到中间调，边、槽、翼根的明暗还在。
 * 只影响正视；等轴 / 自动取景（相机不沿坐标轴）不变，缩略图与预览第一眼逐像素不变。
 */
export const AXIS_VIEW_TILT_DEG = 30
/** 相机方向是不是沿某根坐标轴（显示系）：任一分量绝对值 > cos 10° */
export const isAxisView = (dir) => Math.max(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)) > 0.985
export function rigOrientFor(dir, isoDir, out = new THREE.Quaternion(), up = null, tiltDeg = null) {
  _o0.position.copy(isoDir); _o0.up.set(0, 1, 0); _o0.lookAt(0, 0, 0)
  _o1.position.copy(dir)
  if (up) _o1.up.copy(up)
  // 沿竖直轴看时 lookAt 的上向退化：借用视角的微偏（view.js axisView 在 X 上偏了 1e-4）也不够稳，这里显式给一个上向
  else if (Math.abs(dir.y) > 0.999) _o1.up.set(1, 0, 0)   // 与 view.js axisView 同口径：屏幕上方 = 显示 +X
  else _o1.up.set(0, 1, 0)
  _o1.lookAt(0, 0, 0)
  _qi.copy(_o0.quaternion).invert()
  out.copy(_o1.quaternion).multiply(_qi)
  // 正视：灯组绕相机右轴（世界系）再转 tilt，主光往相机上方抬（缺省：沿坐标轴看时 AXIS_VIEW_TILT_DEG，否则 0）
  const t = tiltDeg == null ? (isAxisView(dir) ? AXIS_VIEW_TILT_DEG : 0) : tiltDeg
  if (t) {
    // ★ Object3D.lookAt 让物体 +Z 指向目标（相机是 −Z），所以 _o1 的局部 +X 是相机的【左】：绕它转 +t = 绕相机右轴转 −t = 主光上抬
    _ax.set(1, 0, 0).applyQuaternion(_o1.quaternion)
    out.premultiply(_qt.setFromAxisAngle(_ax, t * Math.PI / 180))
  }
  return out
}

/** 预览背景（CSS，透明 renderer 下由容器画）：影棚档按主题，太阳档恒为近黑 */
export function studioBackground(mode, theme) {
  if (mode === 'sun') return 'radial-gradient(ellipse at 50% 42%, #0b0f16 0%, #020305 75%)'
  return theme === 'dark'
    ? 'radial-gradient(ellipse at 50% 38%, #34363a 0%, #1d1e21 55%, #111214 100%)'
    : 'radial-gradient(ellipse at 50% 38%, #fbfbfc 0%, #eceef1 55%, #d7dade 100%)'
}

/** 同上，但画进 2D 画布（不透明快照用） */
export function paintStudioBackground(ctx, w, h, mode, theme) {
  const stops = mode === 'sun' ? [[0, '#0b0f16'], [0.75, '#020305'], [1, '#020305']]
    : theme === 'dark' ? [[0, '#34363a'], [0.55, '#1d1e21'], [1, '#111214']]
      : [[0, '#fbfbfc'], [0.55, '#eceef1'], [1, '#d7dade']]
  const g = ctx.createRadialGradient(w * 0.5, h * 0.38, 0, w * 0.5, h * 0.38, Math.hypot(w, h) * 0.6)
  for (const [t, c] of stops) g.addColorStop(t, c)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}
