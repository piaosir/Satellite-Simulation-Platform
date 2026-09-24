// 3D 球上的标记实体模型层（P4 契约 §3.1；DESIGN3 E7–E10；摸底 map3/scene-entity.md §3 / §6）。
//
// 画什么：地球站 / 点标记 / 航迹载具（飞机、船、车）挂的 3D 模型，一律【屏幕定尺】的图标（地球视图下真实尺寸 < 1 px）。
//   尺寸随缩放联动：px 是默认视角下的像素，屏幕像素 = px × zoomScale.markerZoomK(相机距离) —— 与它顶替的标记精灵、让位的标记文字
//   同一系数，拉近变大、拉远变小（原先恒定像素：调大了在全球视角下连片压住地图，拉近又显小）。
//   挂在 scene.js 的具名插槽 setEntityOverlay 上：宇宙空间主趟之后、卫星模型层（modelLayer）之前，独立一趟、先 clearDepth ——
//   图标是屏幕定尺的符号，不与地球比深度（放大后的地面件世界尺寸能到上百 km，比深度会在近地平被球面截掉半截）；图标之间照常遮挡。
//   背面按标记精灵同一条半球规则淡出（dot(锚点方向, 相机方向)：≤ 0.05 不画、0.05–0.22 线性、≥ 0.22 满），模型与精灵同时出现 / 消失。
//
// 怎么画（几百个实体、两位数绘制调用）：
//   · 同一 modelId 的所有实体共享一份模型资源（引用计数，最后一个实体离开 60 s 后释放，与 loader 同节奏）。
//   · 每个模型按「帧 × 材质」合批：关节静止位姿下，不受驱动的网格烘进本体系（米）合成一份几何；受天线跟踪驱动的关节节点
//     （aimRigOf 的方位 / 俯仰两级）各成一帧，帧内网格烘到该节点自己的局部系。每组一个 THREE.InstancedMesh，
//     实例矩阵 = 实体矩阵 E（静态帧）或 E · D_f（关节帧，D_f 逐实例按关节值算）。绘制调用 = Σ 在画模型的（帧 × 材质）数。
//   · 实体矩阵 E = T(锚点) · R(qB2S) · S(k) · T(−锚点在本体系的那一点)：锚点 = llaToVec 球面口径 r = 1 + h / 6371 km（不沿天顶额外抬高，
//     契约 §7-2）；本体里要落在锚点上的点由 entityRuntime.anchorBodyOf 定（datum 挂点 → 包围盒底 / 飞机取盒心）；
//     k = 屏幕像素 × 每像素场景长度 / 包围半径（像素 = 包围球在屏幕上的直径 = px × 缩放联动系数）。
//   · 淡入淡出按逐实例 aFade：画布开了 MSAA 走 alpha-to-coverage（解析后平滑半透明），没开走 4×4 Bayer 屏幕门抖动（两档都
//     不透明、写深度、不排序）；图标外沿一圈深色描边（制图套色，屏幕空间三趟，见「描边」）；光照系数逐实例 aShade（outgoingLight 整体压：
//     漫反射 + 镜面 + 环境一起，等价于 modelLayer 按材质压色 + 压环境强度）；船按水线面裁剪（逐实例 aClip：过锚点的当地切平面，
//     吃水线以下不画）。实例属性建层时就建好（首次写入不触发重编），onBeforeCompile 注入、customProgramCacheKey 带 'entIcon'。
//   · 图标 LOD：图元三角形 > 6000 的模型在后台（analyze Worker，meshopt）抽一档 ≈ 4000 三角形的图标档，就绪后此刻屏幕像素 ≤ 96 的实例
//     原位换上（节点名保留，关节照驱动）；> 96 的实例仍画原档（同一模型两档并存；拉近拉远跨过 96 就换档）。
//
// 光照口径跟卫星模型层（modelLayer.setSunLit）走：晨昏效果关 = 全亮（主光改相机头灯、不压暗）；开 = 太阳方向主光 3.0 + 相机侧补光 0.6
//   （modelLayer FILL_LIT）+ 当地太阳高度角 smoothstep(−6°, +0.8°) 压暗到底色 0.5（entityRuntime.shadeOf，= modelLayer ICON_ECL_FLOOR），
//   暗面有补光托着、结构看得清。环境反射 RoomEnvironment PMREM，强度 0.45（modelLayer ICON_ENV_I）。ACES、曝光 1.0，画完恢复。
//
// 地球站天线跟踪：画面按「星场景锚点 − 站场景锚点」（页面 pickTrackTarget 给的 aim.dir，场景轴单位视线）；转回本体（NED）后
//   有方位 / 俯仰关节的模型按 entityRuntime.solveAim 的 gimbal 主解驱动关节（限位内、离上一次最近；仰角 < 0 停放 parkAim），
//   没有关节的整体绕天顶转方位（航向 = 罗盘方位）。目标一跳 > 2° 时按 τ = 180 ms 一阶逼近，连续跟踪直接贴合。
//
// 性能：逐帧 update 零分配（槽位状态 Float64Array / 复用对象、下标循环、预分配暂存）；相机与状态都没变时直接返回、一个实例都不写；
//   可见实例前移压实，mesh.count = 可见数，只上传用到的那一段（addUpdateRange）。frustumCulled = false（可见性在 CPU 上判）。
//
// 模块顶层不碰 DOM / WebGL（node 单测直接 import）；analyze Worker 懒建（第一次要抽图标档时动态 import）。
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { modelToBodyMatrix } from '../models/view.js'
import { applyRestPose, stageMatrix } from '../models/thumbs.js'
import { splitMultiMaterial } from '../models/irToThree.js'
import { isSoftwareRenderer } from './spaceFx.js'
import { markerZoomK } from './zoomScale.js'
import { sceneAnchor, entityPoseAt, makeEntityPose } from '@core/models/entityPose.mjs'
import { anchorBodyOf, aimRigOf, makeAimState, solveAim, parkAim, jointValuesOf, shadeOf, ENT_FADE_S } from '@core/models/entityRuntime.mjs'

const DEG = Math.PI / 180
const FADE_S = Number.isFinite(ENT_FADE_S) && ENT_FADE_S > 0 ? ENT_FADE_S : 0.3
const ENV_I = 0.45                // = modelLayer ICON_ENV_I
const SUN_I = 3.0                 // = modelLayer iconSun
const FILL_LIT = 0.6              // = modelLayer FILL_LIT（晨昏效果开时的相机侧补光）
const AMB_C = 0x9fb4d8, AMB_I = 0.14
const CAP_CLASS = 1024            // 每类上限：地球站 + 点 1024、载具 1024；超出的不画模型（精灵照旧）
const LOD_TRIS = 6000, LOD_PX = 96, LOD_TRIS_TARGET = 4000
const RELEASE_MS = 60000          // 最后一个实体离开后留 60 s（再挂回来不用重建）
const AIM_SNAP = 2, AIM_DONE = 0.02, AIM_TAU = 0.18
const HEMI_LO = 0.05, HEMI_SPAN = 0.17
const PX_MIN = 8, PX_MAX = 256, PX_DEF = 28
const MARK1 = 12500000.5, MARK2 = 25000000.25   // jointValuesOf 探针值：建模时一次性认出哪一级吃 a1 / a2
const CLASS_OF = { station: 0, point: 0, aircraft: 1, ship: 1, vehicle: 1 }
// 相机系（相机朝 −Z）：全亮头灯 / 相机侧补光方向（= modelLayer HEADLIGHT_C）
const HEADLIGHT_C = new THREE.Vector3(-0.5, 0.65, 0.85).normalize()
const _warmCam = new THREE.PerspectiveCamera(42, 1, 0.01, 1e6)

// ───────────────────────────── 着色器注入 ─────────────────────────────
const V_DECL = 'attribute float aFade;\nattribute float aShade;\nattribute vec4 aClip;\n' +
  'varying float vEntFade;\nvarying float vEntShade;\nvarying vec4 vEntClip;\nvarying vec3 vEntW;\n'
const V_BODY = `
	{
		vec4 entW = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		entW = instanceMatrix * entW;
	#endif
		vEntW = ( modelMatrix * entW ).xyz;
	}
	vEntFade = aFade; vEntShade = aShade; vEntClip = aClip;
`
// 4×4 Bayer 门限（(i + 0.5) / 16）：aFade = 1 一个像素都不丢，aFade = 0 全丢
const F_DECL = 'varying float vEntFade;\nvarying float vEntShade;\nvarying vec4 vEntClip;\nvarying vec3 vEntW;\n' +
  'float entBayer( vec2 fc ) {\n' +
  '\tconst float B[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );\n' +
  '\tivec2 p = ivec2( mod( fc, 4.0 ) );\n' +
  '\treturn ( B[ p.x + p.y * 4 ] + 0.5 ) / 16.0;\n' +
  '}\n'
// 淡化两档：画布开了 MSAA → alpha-to-coverage（material.alphaToCoverage，three 置 ALPHA_TO_COVERAGE）：按子样本覆盖率淡，
// 解析后是平滑半透明；没有 MSAA（画质档关了抗锯齿）→ 4×4 Bayer 屏幕门抖动。两档都不透明写深度、不排序
const F_CLIP = `
	if ( dot( vEntClip.xyz, vEntW ) < vEntClip.w ) discard;
#ifdef ALPHA_TO_COVERAGE
	if ( vEntFade <= 0.004 ) discard;
#else
	if ( vEntFade < entBayer( gl_FragCoord.xy ) ) discard;
#endif
`
const F_OUT = `outgoingLight *= vEntShade;
#ifdef ALPHA_TO_COVERAGE
	diffuseColor.a = vEntFade;
#endif
	#include <opaque_fragment>`
// 描边遮罩档（mask = true）：只裁水线、不抖动，R 通道直接写淡化系数 —— 描边随图标一起淡入淡出，不被抖动打出洞
const F_CLIP_MASK = `
	if ( dot( vEntClip.xyz, vEntW ) < vEntClip.w ) discard;
`
const DEFAULT_OBC = THREE.Material.prototype.onBeforeCompile
function injectEntShader(m, mask = false) {
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (sh, r) => {
    if (prev && prev !== DEFAULT_OBC) prev.call(m, sh, r)
    sh.vertexShader = V_DECL + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n' + V_BODY)
    sh.fragmentShader = F_DECL + sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + (mask ? F_CLIP_MASK : F_CLIP))
      .replace('#include <opaque_fragment>', mask ? 'gl_FragColor = vec4( vEntFade, 0.0, 0.0, 1.0 );' : F_OUT)
  }
  m.customProgramCacheKey = () => (mask ? 'entMask' : 'entIcon')
  m.needsUpdate = true
  return m
}

// ───────────────────────────── 描边（制图套色 casing） ─────────────────────────────
// 地面件图标多是浅色（白色天线、机身），压在浅色陆地底图上几乎看不出轮廓；标记精灵与文字都有深色描边（制图的套色口径），
// 模型图标同一口径：图标外沿一圈深色描边 + 一道更淡的外晕。做法（屏幕空间，与模型面数 / 实例数无关）：
//   ① 遮罩：同一批 InstancedMesh 用 overrideMaterial 画进一张 CSS 分辨率（× min(2, 像素比)）的离屏图，alpha = 淡化系数；
//   ② 膨胀：离屏图上按两圈半径（内 HALO_R1、外 HALO_R2，CSS px）取邻域最大值 → r = 内描边、g = 外晕；
//   ③ 合成：一次全屏（剪到所有图标外包矩形）采样叠到画面上，再清深度画图标本体 —— 描边只露出图标外沿那一圈。
// 两张离屏图都不带深度、不开 MSAA（描边是软边，线性采样放大即可）；遮罩那一趟材质不打光、不抖动，代价远低于本体那一趟。
const HALO_R1 = 1.3, HALO_R2 = 3.0          // CSS px
const HALO_A1 = 0.62, HALO_A2 = 0.2         // 内描边 / 外晕不透明度
const HALO_RGB = [6 / 255, 11 / 255, 18 / 255]   // 与 2D 落点环的深色衬边同色（sRGB 直写）
const FS_VERT = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }\n'
const DILATE_FRAG = `
uniform sampler2D tMask;
uniform vec2 uTexel;
uniform float uR1;
uniform float uR2;
varying vec2 vUv;
float mk( vec2 o ) { return texture2D( tMask, vUv + o * uTexel ).r; }
void main() {
	float a1 = mk( vec2( 0.0 ) );
	float a2 = 0.0;
	for ( int i = 0; i < 12; i ++ ) {
		float t = float( i ) * 0.5235987756;
		vec2 d = vec2( cos( t ), sin( t ) );
		a1 = max( a1, max( mk( d * uR1 ), mk( d * ( uR1 * 0.5 ) ) ) );
		a2 = max( a2, max( mk( d * uR2 ), mk( d * ( 0.5 * ( uR1 + uR2 ) ) ) ) );
	}
	gl_FragColor = vec4( a1, max( a1, a2 ), 0.0, 1.0 );
}
`
const COMP_FRAG = `
uniform sampler2D tHalo;
uniform vec3 uColor;
uniform float uA1;
uniform float uA2;
varying vec2 vUv;
void main() {
	vec2 h = texture2D( tHalo, vUv ).rg;
	float a = max( h.r * uA1, h.g * uA2 );
	if ( a < 0.004 ) discard;
	gl_FragColor = vec4( uColor, a );
}
`

// ───────────────────────────── 小工具（热路径零分配） ─────────────────────────────
const nodeName = (o) => ((o && o.userData && typeof o.userData.name === 'string') ? o.userData.name : (o ? o.name : ''))
// 列主序 4×4 乘：out[oo..] = a[ao..] · b[bo..]（out 不可与 a / b 重叠）
function mul4(a, ao, b, bo, out, oo) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[bo + c * 4], b1 = b[bo + c * 4 + 1], b2 = b[bo + c * 4 + 2], b3 = b[bo + c * 4 + 3]
    out[oo + c * 4] = a[ao] * b0 + a[ao + 4] * b1 + a[ao + 8] * b2 + a[ao + 12] * b3
    out[oo + c * 4 + 1] = a[ao + 1] * b0 + a[ao + 5] * b1 + a[ao + 9] * b2 + a[ao + 13] * b3
    out[oo + c * 4 + 2] = a[ao + 2] * b0 + a[ao + 6] * b1 + a[ao + 10] * b2 + a[ao + 14] * b3
    out[oo + c * 4 + 3] = a[ao + 3] * b0 + a[ao + 7] * b1 + a[ao + 11] * b2 + a[ao + 15] * b3
  }
  return out
}
function copy16(src, so, dst, doff) { for (let i = 0; i < 16; i++) dst[doff + i] = src[so + i] }
function ident16(dst, doff) { for (let i = 0; i < 16; i++) dst[doff + i] = (i % 5 === 0) ? 1 : 0 }
const ne = (a, b) => a !== b && !(a !== a && b !== b)   // 不等（NaN 与 NaN 算相等）
const wrap180 = (x) => { const v = ((x % 360) + 540) % 360 - 180; return v === -180 ? 180 : v }
const nextPow2 = (n) => { let c = 4; while (c < n) c *= 2; return c }

// ───────────────────────────── 模型展平（纯几何，node 可测） ─────────────────────────────
/**
 * 驱动级识别：rig（aimRigOf）→ 各关节各级吃 a1 / a2 / 静止值（jointValuesOf 探针一次认出，与页面 / 单测同一份口径）。
 * @returns {Map<string, Map<string, number>>} 关节名 → (stage 名 → 1 | 2)
 */
function drivenCodes(rig) {
  const out = new Map()
  if (!rig || typeof jointValuesOf !== 'function') return out
  let v = null
  try { v = jointValuesOf(rig, MARK1, MARK2, {}) } catch { v = null }
  if (!v || typeof v !== 'object') return out
  for (const art of Object.keys(v)) {
    const sv = v[art]
    if (!sv || typeof sv !== 'object') continue
    const m = new Map()
    for (const st of Object.keys(sv)) { if (sv[st] === MARK1) m.set(st, 1); else if (sv[st] === MARK2) m.set(st, 2) }
    if (m.size) out.set(art, m)
  }
  return out
}

const _Sm = new THREE.Matrix4(), _Am = new THREE.Matrix4(), _Im = new THREE.Matrix4(), _Bm = new THREE.Matrix4()
const _n3 = new THREE.Matrix3()
const _bb = new THREE.Box3(), _bv = new THREE.Vector3()

/**
 * 模型帧结构（只与节点树 / 关节有关，与网格抽稀无关 —— 原档与图标档共用）：
 *   frames[0] = 静态帧（L = 单位、无 stage）；frames[f ≥ 1] = 受驱动的关节节点（等价节点合并：同父帧、同 stage 序列、同 L）。
 *   L_f：父帧局部系 → 该帧节点局部系（静止位姿去掉自身 stage 的「文件位姿」）；顶层帧的 L 已左乘 modelToBody（米制本体）。
 *   st：该帧的 stage 序列 {type, init, code}（code 0 = 静止值、1 = a1、2 = a2），按 poseArticulations 的次序右乘。
 * 节点 → 帧按「节点名 + 同名序号」认（图标档是原树的克隆，同名同序）。
 */
function buildFrames(root, meta, rig, MB) {
  const arts = Array.isArray(meta && meta.articulations) ? meta.articulations : []
  const codes = drivenCodes(rig)
  // 节点名 → 它挂在哪些关节（按关节顺序）
  const artsOfName = new Map()
  for (const a of arts) {
    if (!a || !Array.isArray(a.stages) || !a.stages.length || !Array.isArray(a.nodes)) continue
    for (const nm of a.nodes) { if (!artsOfName.has(nm)) artsOfName.set(nm, []); artsOfName.get(nm).push(a) }
  }
  const frames = [{ parent: -1, L: null, st: [], key: 'static' }]
  const frameOfKey = new Map()   // 'name#k' → 帧下标
  const nodeFrame = new Map()    // 节点对象 → 帧下标（本树）
  const seenName = new Map()
  const occKey = (o) => { const n = nodeName(o); const k = seenName.get(n) || 0; seenName.set(n, k + 1); return n + '#' + k }
  // 先序遍历（父先于子）：每个节点定「最近受驱动祖先（含自身）」的帧
  const walk = (o, parentFrame) => {
    const key = occKey(o)
    let f = parentFrame
    const al = artsOfName.get(nodeName(o))
    if (al) {
      // 该节点的 stage 序列与是否受驱动
      const st = []
      let driven = false
      for (const a of al) {
        const cm = codes.get(a.name)
        for (const s of a.stages) {
          const code = cm ? (cm.get(s.name) || 0) : 0
          if (code) driven = true
          st.push({ type: s.type, init: Number.isFinite(s.initialValue) ? s.initialValue : 0, code })
        }
      }
      if (driven) {
        // 静止 stage 积 → 文件位姿 = 当前（静止位姿）矩阵 · S_rest⁻¹
        _Am.identity()
        for (const s of st) _Am.multiply(stageMatrix(s.type, s.init, _Sm))
        if (Math.abs(_Am.determinant()) > 1e-15) {
          o.updateMatrix()
          const fileM = _Bm.copy(o.matrix).multiply(_Im.copy(_Am).invert())
          // L = inv(父帧节点 world) · parent(o).world · filePose（顶层帧：MB · parent(o).world · filePose）
          const Lm = new THREE.Matrix4()
          if (o.parent) Lm.copy(o.parent.matrixWorld); else Lm.identity()
          Lm.multiply(fileM)
          if (parentFrame > 0) Lm.premultiply(_Im.copy(frames[parentFrame].node.matrixWorld).invert())
          else Lm.premultiply(MB)
          // 等价帧合并（同父帧、同 stage 序列、L 逐元素 ≤ 1e-9）
          let hit = -1
          for (let i = 1; i < frames.length && hit < 0; i++) {
            const F = frames[i]
            if (F.parent !== parentFrame || F.st.length !== st.length) continue
            let same = true
            for (let j = 0; j < st.length && same; j++) same = F.st[j].type === st[j].type && F.st[j].init === st[j].init && F.st[j].code === st[j].code
            for (let j = 0; j < 16 && same; j++) same = Math.abs(F.L[j] - Lm.elements[j]) <= 1e-9
            if (same) hit = i
          }
          if (hit < 0) {
            frames.push({ parent: parentFrame, L: Float64Array.from(Lm.elements), st, key, node: o })
            hit = frames.length - 1
          }
          f = hit
          frameOfKey.set(key, f)
        }
      }
    }
    nodeFrame.set(o, f)
    for (const c of o.children) walk(c, f)
  }
  walk(root, 0)
  return { frames, frameOfKey }
}

/**
 * 一棵（已摆静止位姿、世界矩阵已更新的）树 → 合批组。frameOf(o) 给节点的帧；bakeOf(prim, frame) 给烘焙矩阵。
 * 组键 = 帧 | 源材质 | 顶点属性签名。烘焙：静态帧 MB · prim.world；关节帧 inv(帧节点.world) · prim.world。
 */
function collectPrims(root, frameAt, MB) {
  const prims = []
  root.traverseVisible((o) => {
    const f = frameAt(o)
    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return
    if (o.isInstancedMesh || o.isSkinnedMesh) return
    // 最近的受驱动祖先（含自身）：帧节点
    let A = null
    if (f > 0) { let p = o; while (p && frameAt(p) === f) { A = p; p = p.parent } }
    const bake = new THREE.Matrix4()
    if (f > 0 && A) bake.copy(A.matrixWorld).invert().multiply(o.matrixWorld)
    else bake.multiplyMatrices(MB, o.matrixWorld)
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    prims.push({ mesh: o, frame: f > 0 && A ? f : 0, bake, mat: mats[0] || null, name: nodeName(o), colSize: 0 })
  })
  return prims
}

function attrSig(g, mat) {
  const a = g.attributes
  const uv = a.uv ? 'u' : ''
  const col = mat && mat.vertexColors && a.color ? 'c' + a.color.itemSize : ''
  return uv + col
}

/** 一组网格 → 一份合批几何（位置 / 法向烘进目标系，镜像矩阵翻绕序）。新数组、不引用源几何。 */
function mergePrims(list) {
  let nv = 0, ni = 0
  const withUv = !!list[0].mesh.geometry.attributes.uv
  const colSize = list[0].colSize || 0
  for (const p of list) {
    const g = p.mesh.geometry
    nv += g.attributes.position.count
    ni += g.index ? g.index.count : g.attributes.position.count
  }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3)
  const uv = withUv ? new Float32Array(nv * 2) : null
  const col = colSize ? new Float32Array(nv * colSize) : null
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni)
  let vo = 0, io = 0
  for (const p of list) {
    const g = p.mesh.geometry
    const P = g.attributes.position
    let N = g.attributes.normal
    if (!N) { const t = new THREE.BufferGeometry(); t.setAttribute('position', P); if (g.index) t.setIndex(g.index); t.computeVertexNormals(); N = t.attributes.normal }
    const e = p.bake.elements
    _n3.getNormalMatrix(p.bake)
    const n = _n3.elements
    const cnt = P.count
    for (let i = 0; i < cnt; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i)
      const o3 = (vo + i) * 3
      pos[o3] = e[0] * x + e[4] * y + e[8] * z + e[12]
      pos[o3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]
      pos[o3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
      const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i)
      let ax = n[0] * nx + n[3] * ny + n[6] * nz, ay = n[1] * nx + n[4] * ny + n[7] * nz, az = n[2] * nx + n[5] * ny + n[8] * nz
      const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1
      ax /= l; ay /= l; az /= l
      nrm[o3] = ax; nrm[o3 + 1] = ay; nrm[o3 + 2] = az
    }
    if (uv) { const U = g.attributes.uv; for (let i = 0; i < cnt; i++) { uv[(vo + i) * 2] = U.getX(i); uv[(vo + i) * 2 + 1] = U.getY(i) } }
    if (col) { const C = g.attributes.color; for (let i = 0; i < cnt; i++) for (let c = 0; c < colSize; c++) col[(vo + i) * colSize + c] = C.getComponent(i, c) }
    const flip = p.bake.determinant() < 0
    if (g.index) {
      const I = g.index, m = I.count
      for (let t = 0; t + 2 < m; t += 3) {
        const a = I.getX(t) + vo, b = I.getX(t + 1) + vo, c = I.getX(t + 2) + vo
        idx[io++] = a; idx[io++] = flip ? c : b; idx[io++] = flip ? b : c
      }
    } else {
      for (let t = 0; t + 2 < cnt; t += 3) { idx[io++] = vo + t; idx[io++] = vo + (flip ? t + 2 : t + 1); idx[io++] = vo + (flip ? t + 1 : t + 2) }
    }
    vo += cnt
  }
  const base = {
    position: new THREE.BufferAttribute(pos, 3),
    normal: new THREE.BufferAttribute(nrm, 3),
    uv: uv ? new THREE.BufferAttribute(uv, 2) : null,
    color: col ? new THREE.BufferAttribute(col, colSize) : null,
    index: new THREE.BufferAttribute(io === idx.length ? idx : idx.slice(0, io), 1)
  }
  return { base, tris: io / 3 }
}

/** 本体系（米）可见几何外包盒（静止位姿；与 modelLayer.visibleBox 同口径：逐网格几何包围盒八角变过去再并） */
function bodyBox(root, MB) {
  const out = new THREE.Box3()
  root.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
    _bb.copy(o.geometry.boundingBox).applyMatrix4(_Am.multiplyMatrices(MB, o.matrixWorld))
    out.union(_bb)
  })
  return out
}

// ============================================================================================
/**
 * @param {{source:{acquire:Function, forget?:Function, onReady?:Function}, simplify?:boolean, getQuality?:()=>({tier:string}),
 *          waitGpu?:boolean}} o
 *   waitGpu（缺省 true）：模型建好后等拿到 renderer、预编好着色器再亮出来（首帧不卡）；node 单测传 false（没有 GPU，建好即就绪）
 */
export function createEntityLayer(o = {}) {
  const source = o.source || null
  const simplifyOn = o.simplify !== false
  const waitGpu = o.waitGpu !== false
  const getQuality = typeof o.getQuality === 'function' ? o.getQuality : null

  let renderer = null, gpuWeak = false, disposed = false, enabled = false, sunLit = true
  let a2c = false   // 画布有 MSAA：淡化走 alpha-to-coverage（见 F_CLIP）；没有走 Bayer 抖动
  let env = null
  let analyzer = null, disposeLodFn = null
  const sunS = new THREE.Vector3(1, 0, 0)
  const _sunArr = [1, 0, 0]
  const iconScene = new THREE.Scene()
  iconScene.matrixWorldAutoUpdate = true
  const sunLight = new THREE.DirectionalLight(0xffffff, SUN_I)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0)
  const ambLight = new THREE.AmbientLight(AMB_C, AMB_I)
  iconScene.add(sunLight, sunLight.target, fillLight, fillLight.target, ambLight)

  const models = new Map(), modelArr = []
  const slots = new Map(), slotArr = []
  let gen = 0, dirty = true, busyFlag = false, anyAlpha = false, pendingGpu = 0, lodPending = 0, truncated = 0
  let shown = 0, drawCalls = 0, instances = 0, trisDrawn = 0
  const perfF = new Float64Array(4)   // [update EMA, render EMA, 本次起点, 暂存]（ms）：double 存进定型数组，不装箱
  const camSig = new Float64Array(20)
  let camSigOk = false
  const _hl = new THREE.Vector3()
  const _dirB = [0, 0, 0]
  const _E2 = new Float64Array(16), _acc = new Float64Array(16), _tmp = new Float64Array(16)
  let rendererWaiters = []
  // 描边（见文件头「描边」）：离屏遮罩 / 膨胀图、三只材质、全屏三角；本帧在画图标的外包矩形（CSS px：x0, y0, x1, y1，y 向下）
  let maskRT = null, haloRT = null, maskMat = null, dilateMat = null, compMat = null, fsMesh = null, fsScene = null, fsCam = null
  const haloRect = new Float64Array(4)
  let haloAny = false
  const _cc = new THREE.Color(), _sc = new THREE.Vector4()

  // ───────────── 模型 ─────────────
  function newModel(id) {
    const M = { id, refs: 0, zeroAt: 0, state: 'loading', req: 0, inst: null, meta: null, root: null, MB: null,
      frames: null, frameOfKey: null, full: null, icon: null, lodState: '', rig: null, box: null, center: [0, 0, 0], radius: 1,
      anchors: {}, mats: null, dead: false, onUp: null, drest: null }
    M.onUp = () => { if (!disposed && !M.dead) loadModel(M) }
    return M
  }
  function refModel(id) {
    let M = models.get(id)
    if (!M) { M = newModel(id); models.set(id, M); modelArr.push(M); loadModel(M) }
    M.refs++
    return M
  }
  function unrefModel(M) {
    if (!M) return
    M.refs = Math.max(0, M.refs - 1)
    if (!M.refs) M.zeroAt = nowMs()
  }
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

  function waitRenderer() {
    if (renderer) return Promise.resolve()
    return new Promise((res) => { rendererWaiters.push(res); setTimeout(res, 800) })
  }
  function ensureEnv() {
    if (env || !renderer) return
    try {
      const pm = new THREE.PMREMGenerator(renderer)
      const room = new RoomEnvironment()
      env = pm.fromScene(room, 0.04)
      room.dispose(); pm.dispose()
    } catch { env = null }
    if (env) for (let i = 0; i < modelArr.length; i++) {
      const ms = modelArr[i].mats
      if (ms) for (const m of ms) if ('envMap' in m && m.envMap !== env.texture) { m.envMap = env.texture; m.envMapIntensity = ENV_I; m.needsUpdate = true }
    }
  }

  function cloneMat(src) {
    let m
    if (src && (src.isMeshStandardMaterial || src.isMeshLambertMaterial || src.isMeshPhongMaterial || src.isMeshBasicMaterial)) m = src.clone()
    else m = new THREE.MeshStandardMaterial({ color: src && src.color ? src.color : 0xb4b8bf, metalness: 0.2, roughness: 0.6 })
    if (m.userData) delete m.userData._shared
    m.transparent = false; m.opacity = 1; m.depthWrite = true; m.depthTest = true
    if ('alphaHash' in m) m.alphaHash = false
    if ('transmission' in m) m.transmission = 0
    if ('envMap' in m) { m.envMap = env ? env.texture : null; m.envMapIntensity = ENV_I }
    m.alphaToCoverage = a2c
    return injectEntShader(m)
  }

  /** 一棵已摆好静止位姿的树 → 一档（variant）：合批组 + 实例属性（容量 cap） */
  function buildVariant(M, root, lod) {
    root.updateMatrixWorld(true)
    // 本树节点 → 帧：按「名 + 同名序号」查模型帧表
    const seen = new Map(), map = new Map()
    const walk = (o, pf) => {
      const n = nodeName(o), k = seen.get(n) || 0
      seen.set(n, k + 1)
      const f = M.frameOfKey.has(n + '#' + k) ? M.frameOfKey.get(n + '#' + k) : pf
      map.set(o, f)
      for (const c of o.children) walk(c, f)
    }
    walk(root, 0)
    const prims = collectPrims(root, (x) => (map.has(x) ? map.get(x) : 0), M.MB)
    // 分组：帧 | 材质 | 属性签名
    const groups = new Map()
    for (const p of prims) {
      if (!p.mat) continue
      const sig = attrSig(p.mesh.geometry, p.mat)
      p.colSize = sig.indexOf('c') >= 0 ? p.mesh.geometry.attributes.color.itemSize : 0
      const key = p.frame + '|' + p.mat.uuid + '|' + sig
      let g = groups.get(key)
      if (!g) { g = { frame: p.frame, src: p.mat, list: [] }; groups.set(key, g) }
      g.list.push(p)
    }
    const V = { lod, groups: [], frameUse: new Uint8Array(M.frames.length), frameAttr: new Array(M.frames.length).fill(null),
      cap: 0, n: 0, lastN: -1, fade: null, shade: null, clip: null, tris: 0, prims: prims.length, bakes: prims.map((p) => ({ name: p.name, frame: p.frame, bake: p.bake, node: p.mesh })) }
    for (const g of groups.values()) {
      const merged = mergePrims(g.list)
      let mat = M.matMap.get(g.src)
      if (!mat) { mat = cloneMat(g.src); M.matMap.set(g.src, mat); M.mats.push(mat) }
      V.groups.push({ frame: g.frame, base: merged.base, tris: merged.tris, mat, mesh: null, geo: null })
      V.frameUse[g.frame] = 1
      V.tris += merged.tris
    }
    allocVariant(V, 16)
    return V
  }
  // 实例属性（容量 cap，2 的幂）：建好即挂（首次写入不触发重编）。扩容 = 新包装几何 + 新实例属性；
  // 旧包装几何 dispose 前先摘掉共享的底几何属性（three 的 onGeometryDispose 会删属性的 GPU 缓冲），旧实例矩阵挂到旧包装上一起收
  function allocVariant(V, cap) {
    const oldFade = V.fade, oldGeos = []
    V.cap = cap
    V.fade = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1)
    V.shade = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1)
    V.clip = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4)
    for (const a of [V.fade, V.shade, V.clip]) a.setUsage(THREE.DynamicDrawUsage)
    const oldFrameAttr = V.frameAttr.slice()
    for (let f = 0; f < V.frameAttr.length; f++) {
      if (!V.frameUse[f]) continue
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16)
      a.setUsage(THREE.DynamicDrawUsage)
      V.frameAttr[f] = a
    }
    for (const g of V.groups) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', g.base.position)
      geo.setAttribute('normal', g.base.normal)
      if (g.base.uv) geo.setAttribute('uv', g.base.uv)
      if (g.base.color) geo.setAttribute('color', g.base.color)
      geo.setIndex(g.base.index)
      geo.setAttribute('aFade', V.fade)
      geo.setAttribute('aShade', V.shade)
      geo.setAttribute('aClip', V.clip)
      if (g.geo) oldGeos.push(g.geo)
      g.geo = geo
      if (!g.mesh) {
        const mesh = new THREE.InstancedMesh(geo, g.mat, 1)
        mesh.frustumCulled = false
        mesh.matrixAutoUpdate = false
        mesh.count = 0
        mesh.visible = false
        mesh.instanceMatrix = V.frameAttr[g.frame]
        g.mesh = mesh
      } else {
        g.mesh.geometry = geo
        g.mesh.instanceMatrix = V.frameAttr[g.frame]
      }
    }
    // 旧件：底几何属性摘掉、旧实例矩阵挂上，一起 dispose（只释放本档自己的实例缓冲）
    for (let i = 0; i < oldGeos.length; i++) {
      const og = oldGeos[i]
      for (const k of ['position', 'normal', 'uv', 'color']) og.deleteAttribute(k)
      og.setIndex(null)
      if (i === 0) for (let f = 0; f < oldFrameAttr.length; f++) if (oldFrameAttr[f]) og.setAttribute('_im' + f, oldFrameAttr[f])
      og.dispose()
    }
    void oldFade
    V.lastN = -1
  }
  function disposeVariant(V, scene) {
    if (!V) return
    for (const g of V.groups) {
      if (g.mesh) { if (scene) scene.remove(g.mesh); g.mesh.dispose() }
      if (g.geo) g.geo.dispose()
      g.mesh = null; g.geo = null
    }
    V.groups.length = 0
  }
  function variantMeshesIn(V, parent) { for (const g of V.groups) parent.add(g.mesh) }

  /** acquire 回来的实例 → 模型资源（帧表 / 原档 / 包围盒 / 锚点缓存 / rig） */
  function buildModel(M, inst) {
    const meta = inst.meta || {}
    let root = inst.root
    try { applyRestPose(root, meta) } catch { /* 关节数据坏：按文件位姿画 */ }
    root = splitMultiMaterial(root)
    if (root.parent) root.parent.remove(root)
    // 模型系 = 根的父系（根自身的矩阵保留：与 mountInstance 把根挂在 body 下同口径）
    root.updateMatrixWorld(true)
    const MB = modelToBodyMatrix(meta, new THREE.Matrix4())
    let rig = null
    try { rig = aimRigOf(meta) || null } catch { rig = null }
    const fr = buildFrames(root, meta, rig, MB)
    const box = bodyBox(root, MB)
    const R = { root, meta, MB, rig, frames: fr.frames, frameOfKey: fr.frameOfKey, mats: [], matMap: new Map(), box: null, center: [0, 0, 0], radius: 1 }
    if (!box.isEmpty()) {
      R.box = { min: box.min.toArray(), max: box.max.toArray() }
      box.getCenter(_bv); R.center = _bv.toArray()
      let r = 0
      for (let i = 0; i < 8; i++) {
        const x = (i & 1 ? box.max.x : box.min.x) - R.center[0], y = (i & 2 ? box.max.y : box.min.y) - R.center[1], z = (i & 4 ? box.max.z : box.min.z) - R.center[2]
        r = Math.max(r, Math.sqrt(x * x + y * y + z * z))
      }
      R.radius = r > 0 ? r : 1
    } else R.box = { min: [-1, -1, -1], max: [1, 1, 1] }
    // 静止关节值下各帧的 D（槽位没有瞄准时直接拷它）
    const tmp = { frames: R.frames }
    R.drest = new Float64Array(R.frames.length * 16)
    framesD(tmp, NaN, NaN, R.drest)
    // 原档（占位：模型字段先挂上，buildVariant 读 M.frameOfKey / matMap）
    const save = { frames: M.frames, frameOfKey: M.frameOfKey, matMap: M.matMap, mats: M.mats, MB: M.MB }
    M.frames = R.frames; M.frameOfKey = R.frameOfKey; M.matMap = R.matMap; M.mats = R.mats; M.MB = MB
    let full
    try { full = buildVariant(M, root, 'full') } finally { Object.assign(M, save) }
    R.full = full
    return R
  }
  /** 关节值 (a1, a2)（NaN = 静止值）→ 各帧本体系矩阵 D（out：frames × 16） */
  function framesD(M, a1, a2, out) {
    const F = M.frames
    ident16(out, 0)
    for (let f = 1; f < F.length; f++) {
      const fr = F[f]
      // acc = D_parent · L
      mul4(out, fr.parent * 16, fr.L, 0, _acc, 0)
      const st = fr.st
      for (let j = 0; j < st.length; j++) {
        const s = st[j]
        const v = s.code === 1 && Number.isFinite(a1) ? a1 : (s.code === 2 && Number.isFinite(a2) ? a2 : s.init)
        stageMatrix(s.type, v, _Sm)
        mul4(_acc, 0, _Sm.elements, 0, _tmp, 0)
        copy16(_tmp, 0, _acc, 0)
      }
      copy16(_acc, 0, out, f * 16)
    }
    return out
  }

  async function warm(V) {
    const r = renderer
    if (!r || typeof r.compileAsync !== 'function' || !V) return
    const g = new THREE.Group()
    for (const x of V.groups) { x.mesh.count = 1; x.mesh.visible = true; g.add(x.mesh) }
    const tm = r.toneMapping
    let p = null
    try { r.toneMapping = THREE.ACESFilmicToneMapping; g.updateMatrixWorld(true); p = r.compileAsync(g, _warmCam, iconScene) } catch { p = null } finally { r.toneMapping = tm }
    if (p) { try { await p } catch { /* 编不过：交给正常渲染路径 */ } }
    for (const x of V.groups) { g.remove(x.mesh); x.mesh.count = 0; x.mesh.visible = false }
  }

  function disposeModelGpu(M) {
    disposeVariant(M.full, iconScene); disposeVariant(M.icon, iconScene)
    M.full = null; M.icon = null
    if (M.mats) for (const m of M.mats) m.dispose()
    M.mats = null; M.matMap = null
  }

  async function loadModel(M) {
    const req = ++M.req
    const stale = () => disposed || M.dead || req !== M.req
    if (!source || typeof source.acquire !== 'function') { M.state = 'none'; return }
    let inst = null
    try { inst = await source.acquire(M.id, 'lod2', M.onUp) } catch { inst = null }
    if (stale()) { if (inst) inst.release(); return }
    if (!inst) { if (!M.full) M.state = 'none'; return }
    let counted = false
    if (waitGpu && !renderer) { pendingGpu++; counted = true; await waitRenderer() }
    if (counted) pendingGpu--
    if (stale() || gpuWeak) { inst.release(); if (!M.full) M.state = 'none'; return }
    if (waitGpu) ensureEnv()
    let R
    try { R = buildModel(M, inst) } catch (e) {
      console.warn('[entity] 模型展平失败：' + M.id + ' ' + ((e && e.message) || e))
      inst.release(); if (!M.full) M.state = 'none'; return
    }
    // 着色器预编译（与画它那一趟同一组程序参数：ACES、同一套灯）
    const tmpM = { full: R.full }
    if (waitGpu) await warm(tmpM.full)
    if (stale()) { disposeVariant(R.full, null); for (const m of R.mats) m.dispose(); inst.release(); return }
    // 换上（原位：旧档照画到新的就绪）
    disposeModelGpu(M)
    if (M.inst) M.inst.release()
    M.inst = inst; M.meta = R.meta; M.root = R.root; M.MB = R.MB; M.rig = R.rig; M.frames = R.frames; M.frameOfKey = R.frameOfKey
    M.mats = R.mats; M.matMap = R.matMap; M.box = R.box; M.center = R.center; M.radius = R.radius; M.drest = R.drest
    M.full = R.full; M.icon = null; M.lodState = ''; M.anchors = {}
    variantMeshesIn(M.full, iconScene)
    M.state = 'ready'
    for (let i = 0; i < slotArr.length; i++) {
      const s = slotArr[i]
      if (s.model !== M) continue
      s.anchor = null; s.aimSt = null; s.a1 = NaN; s.a2 = NaN; s.t1 = NaN; s.t2 = NaN; s.trans = false
      s.D = new Float64Array(M.frames.length * 16); s.D.set(M.drest)
      s.poseDirty = true; s.aimDirty = true; s.jointDirty = true
    }
    dirty = true
  }

  // 图标档（后台抽稀）
  function maybeLod(M) {
    if (!simplifyOn || M.lodState || M.state !== 'ready' || !M.full || M.full.tris <= LOD_TRIS || !M.root) return
    M.lodState = 'pending'
    lodPending++
    const req = M.req
    const tier = getQuality ? (getQuality() || {}).tier : ''
    const target = tier === 'low' ? LOD_TRIS_TARGET / 2 : LOD_TRIS_TARGET
    ;(async () => {
      let lodRoot = null
      try {
        if (!analyzer) {
          const mod = await import('../models/analyze.js')
          analyzer = mod.createAnalyzer(); disposeLodFn = mod.disposeLod
        }
        lodRoot = await analyzer.simplifyObject(M.root, { ratio: Math.min(1, target / M.full.tris), error: 0.02, prune: true })
        if (disposed || M.dead || req !== M.req || M.state !== 'ready') return
        const V = buildVariant(M, lodRoot, 'icon')
        if (waitGpu) await warm(V)
        if (disposed || M.dead || req !== M.req) { disposeVariant(V, null); return }
        M.icon = V
        variantMeshesIn(V, iconScene)
        M.lodState = 'done'
        dirty = true
      } catch (e) {
        M.lodState = 'failed'
        console.warn('[entity] 图标档抽稀失败：' + M.id + ' ' + ((e && e.message) || e))
      } finally {
        if (lodRoot && disposeLodFn) { try { disposeLodFn(lodRoot) } catch { /* ignore */ } }
        lodPending--
      }
    })()
  }

  function releaseModel(M) {
    M.dead = true
    M.req++
    disposeModelGpu(M)
    if (M.inst) { try { M.inst.release() } catch { /* ignore */ } M.inst = null }
    if (source && typeof source.forget === 'function') source.forget(M.onUp)
    models.delete(M.id)
    const i = modelArr.indexOf(M); if (i >= 0) modelArr.splice(i, 1)
  }

  const offReady = source && typeof source.onReady === 'function'
    ? source.onReady((id) => { const M = models.get(id); if (M && !M.dead && M.state === 'none') loadModel(M) })
    : null

  // ───────────── 槽位 ─────────────
  function newSlot(key) {
    return {
      key, kind: 'point', cls: 0, modelId: '', model: null, px: PX_DEF, pxE: 0,   // pxE：上一次写实例时的屏幕像素（px × 缩放联动系数）
      lat: NaN, lon: NaN, altM: 0, hdg: 0, pit: 0,
      hasAim: false, aimDir: [0, 0, 1], aimAz: NaN, aimEl: NaN, park: true,
      gen: 0, want: true, trunc: false,
      alpha: 0, fade: 0, shade: 1, sunElev: 0, shadeDirty: true,
      A: new Float64Array(3), An: new Float64Array(3), altEff: 0, clip: new Float64Array([0, 0, 0, -1e9]),
      pose: makeEntityPose(), R: new Float64Array(9),
      aimSt: null, a1: NaN, a2: NaN, t1: NaN, t2: NaN, trans: false, yaw: NaN, yawT: NaN, yawTrans: false, aimMode: 'rest',
      poseDirty: true, aimDirty: true, jointDirty: true,
      E: new Float64Array(16), D: null, k: 0, drawn: false, vIsIcon: false,
      sx: 0, sy: 0, sr: 0, onScreen: false, anchor: null, vIdx: -1
    }
  }
  function attachModel(s) {
    if (s.model) unrefModel(s.model)
    s.model = s.modelId ? refModel(s.modelId) : null
    s.anchor = null; s.aimSt = null; s.a1 = NaN; s.a2 = NaN; s.t1 = NaN; s.t2 = NaN; s.trans = false
    s.D = null
    if (s.model && s.model.state === 'ready') { s.D = new Float64Array(s.model.frames.length * 16); s.D.set(s.model.drest) }
    s.poseDirty = true; s.aimDirty = true; s.jointDirty = true
  }
  function dropSlot(i) {
    const s = slotArr[i]
    if (s.model) unrefModel(s.model)
    s.model = null
    slots.delete(s.key)
    const last = slotArr.pop()
    if (i < slotArr.length) slotArr[i] = last
  }

  /** 每拍 / 编辑后：实体表（page 复用对象，这里只拷值） */
  function setEntities(list) {
    const g = ++gen
    let c0 = 0, c1 = 0
    truncated = 0
    const n = Array.isArray(list) ? list.length : 0
    for (let i = 0; i < n; i++) {
      const it = list[i]
      if (!it || typeof it.key !== 'string' || !it.modelId) continue
      let s = slots.get(it.key)
      if (!s) { s = newSlot(it.key); slots.set(it.key, s); slotArr.push(s); dirty = true }
      s.gen = g
      if (!s.want) { s.want = true; dirty = true }
      const kind = CLASS_OF[it.kind] !== undefined ? it.kind : 'point'
      if (kind !== s.kind) { s.kind = kind; s.cls = CLASS_OF[kind]; s.anchor = null; s.poseDirty = true; s.aimDirty = true }
      // 截断：按表内次序，每类至多 CAP_CLASS 个画模型
      const tr = s.cls === 0 ? c0 >= CAP_CLASS : c1 >= CAP_CLASS
      if (tr) truncated++; else if (s.cls === 0) c0++; else c1++
      if (tr !== s.trunc) { s.trunc = tr; dirty = true }
      const mid = String(it.modelId)
      if (mid !== s.modelId) {
        s.modelId = mid
        if (!s.model || s.alpha <= 0) attachModel(s)   // 否则先淡出旧模型，update 里再换
        dirty = true
      }
      let px = +it.px
      px = Number.isFinite(px) ? (px < PX_MIN ? PX_MIN : (px > PX_MAX ? PX_MAX : px)) : PX_DEF
      if (px !== s.px) { s.px = px; dirty = true }
      const lat = +it.lat, lon = +it.lon
      const alt = Number.isFinite(it.altM) ? +it.altM : 0
      const hd = Number.isFinite(it.headingDeg) ? +it.headingDeg : 0
      const pt = Number.isFinite(it.pitchDeg) ? +it.pitchDeg : 0
      if (ne(lat, s.lat) || ne(lon, s.lon) || alt !== s.altM || hd !== s.hdg || pt !== s.pit) {
        s.lat = lat; s.lon = lon; s.altM = alt; s.hdg = hd; s.pit = pt
        s.poseDirty = true; s.aimDirty = true
      }
      const a = it.aim
      if (a && a.dir) {
        const d = a.dir, dx = +d[0], dy = +d[1], dz = +d[2], pk = !!a.park
        const az = Number.isFinite(a.azDeg) ? +a.azDeg : NaN, el = Number.isFinite(a.elDeg) ? +a.elDeg : NaN
        if (!s.hasAim || dx !== s.aimDir[0] || dy !== s.aimDir[1] || dz !== s.aimDir[2] || pk !== s.park || ne(az, s.aimAz) || ne(el, s.aimEl)) {
          s.hasAim = true; s.aimDir[0] = dx; s.aimDir[1] = dy; s.aimDir[2] = dz; s.park = pk; s.aimAz = az; s.aimEl = el
          s.aimDirty = true
        }
      } else if (s.hasAim) { s.hasAim = false; s.aimDirty = true }
    }
    for (let i = 0; i < slotArr.length; i++) { const s = slotArr[i]; if (s.gen !== g && s.want) { s.want = false; dirty = true } }
  }

  // 锚点（本体系里落在场景锚点上的那一点），按（模型 × 挂载类别）缓存
  function anchorFor(M, kind) {
    const c = M.anchors[kind]
    if (c) return c
    let a = null
    try { a = anchorBodyOf({ attachPoints: M.meta && M.meta.attachPoints, box: M.box, modelKind: M.meta && M.meta.kind }, kind, { pos: [0, 0, 0], src: '', liftM: 0 }) } catch { a = null }
    if (!a || !a.pos || !a.pos.every(Number.isFinite)) {
      const b = M.box
      a = { pos: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, kind === 'aircraft' ? (b.min[2] + b.max[2]) / 2 : b.max[2]], src: kind === 'aircraft' ? 'center' : 'bottom', liftM: 0 }
    }
    const out = { pos: [a.pos[0], a.pos[1], a.pos[2]], src: a.src || '', liftM: Number.isFinite(a.liftM) ? a.liftM : 0 }
    M.anchors[kind] = out
    return out
  }

  function refreshShade(s) {
    const An = s.An
    const dt = An[0] * _sunArr[0] + An[1] * _sunArr[1] + An[2] * _sunArr[2]
    s.sunElev = Math.asin(dt < -1 ? -1 : (dt > 1 ? 1 : dt)) / DEG
    let e = 1
    try { e = shadeOf(An, _sunArr, sunLit) } catch { e = 1 }
    if (!Number.isFinite(e)) e = 1
    e = Math.round(e * 50) / 50
    if (e !== s.shade) { s.shade = e; dirty = true }
    s.shadeDirty = false
  }

  function refreshPose(s) {
    const M = s.model
    const ready = M && M.state === 'ready'
    if (ready && !s.anchor) s.anchor = anchorFor(M, s.kind)
    const lift = s.anchor ? s.anchor.liftM : 0
    s.altEff = s.kind === 'aircraft' ? Math.max(s.altM, lift) : s.altM
    if (!(Number.isFinite(s.lat) && Number.isFinite(s.lon))) { s.poseDirty = false; return }
    sceneAnchor(s.lat, s.lon, s.altEff / 1000, s.A)
    const A = s.A, l = Math.sqrt(A[0] * A[0] + A[1] * A[1] + A[2] * A[2]) || 1
    s.An[0] = A[0] / l; s.An[1] = A[1] / l; s.An[2] = A[2] / l
    let hd = s.hdg, pt = s.pit
    if (s.aimMode === 'yaw') { hd = Number.isFinite(s.yaw) ? s.yaw : 0; pt = 0 }
    entityPoseAt(s.lat, s.lon, hd, pt, 0, s.pose)
    const q = s.pose.qB2S, x = q[0], y = q[1], z = q[2], w = q[3], R = s.R
    R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y + z * w); R[2] = 2 * (x * z - y * w)       // 第 0 列
    R[3] = 2 * (x * y - z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z + x * w)       // 第 1 列
    R[6] = 2 * (x * z + y * w); R[7] = 2 * (y * z - x * w); R[8] = 1 - 2 * (x * x + y * y)       // 第 2 列
    const c = s.clip
    if (s.kind === 'ship') { c[0] = s.An[0]; c[1] = s.An[1]; c[2] = s.An[2]; c[3] = s.An[0] * A[0] + s.An[1] * A[1] + s.An[2] * A[2] }
    else { c[0] = 0; c[1] = 0; c[2] = 0; c[3] = -1e9 }
    refreshShade(s)
    s.poseDirty = false
    dirty = true
  }

  function setJointTarget(s, a1, a2) {
    if (!Number.isFinite(a1) || !Number.isFinite(a2)) return
    s.t1 = a1; s.t2 = a2
    if (!Number.isFinite(s.a1) || !Number.isFinite(s.a2)) { s.a1 = a1; s.a2 = a2; s.trans = false; s.jointDirty = true; return }
    if (!s.trans && (Math.abs(a1 - s.a1) > AIM_SNAP || Math.abs(a2 - s.a2) > AIM_SNAP)) s.trans = true
    if (!s.trans && (a1 !== s.a1 || a2 !== s.a2)) { s.a1 = a1; s.a2 = a2; s.jointDirty = true }
  }
  function setYawTarget(s, y) {
    if (!Number.isFinite(y)) return
    s.yawT = y
    if (!Number.isFinite(s.yaw)) { s.yaw = y; s.yawTrans = false; s.poseDirty = true; return }
    const d = wrap180(y - s.yaw)
    if (!s.yawTrans && Math.abs(d) > AIM_SNAP) s.yawTrans = true
    if (!s.yawTrans && d !== 0) { s.yaw = y; s.poseDirty = true }
  }
  // 瞄准：rig → 关节目标；无 rig → 整体方位目标
  function refreshAim(s) {
    s.aimDirty = false
    const M = s.model
    if (!s.hasAim || !M || M.state !== 'ready') {
      if (s.aimMode !== 'rest') { s.aimMode = 'rest'; s.a1 = NaN; s.a2 = NaN; s.t1 = NaN; s.t2 = NaN; s.trans = false; s.yaw = NaN; s.yawT = NaN; s.yawTrans = false; s.jointDirty = true; s.poseDirty = true }
      return
    }
    if (M.rig) {
      if (s.aimMode !== 'joints') { s.aimMode = 'joints'; s.poseDirty = true; s.yaw = NaN; s.yawT = NaN }
      if (s.poseDirty) refreshPose(s)
      if (!s.aimSt) s.aimSt = makeAimState()
      let ok = true
      try {
        if (s.park) parkAim(M.rig, s.aimSt)
        else {
          // dirBody = conj(qB2S) ⊗ aim.dir（R 的转置乘）
          const R = s.R, d = s.aimDir
          _dirB[0] = R[0] * d[0] + R[1] * d[1] + R[2] * d[2]
          _dirB[1] = R[3] * d[0] + R[4] * d[1] + R[5] * d[2]
          _dirB[2] = R[6] * d[0] + R[7] * d[1] + R[8] * d[2]
          solveAim(M.rig, _dirB, s.aimSt)
        }
      } catch { ok = false }
      if (ok) setJointTarget(s, s.aimSt.a1, s.aimSt.a2)
    } else {
      if (s.aimMode !== 'yaw') { s.aimMode = 'yaw'; s.a1 = NaN; s.a2 = NaN; s.jointDirty = true }
      if (!s.park && Number.isFinite(s.aimAz)) setYawTarget(s, s.aimAz)
      else if (!Number.isFinite(s.yawT)) setYawTarget(s, 0)
    }
  }
  function computeD(s) {
    const M = s.model
    s.jointDirty = false
    if (!M || M.state !== 'ready') return
    if (!s.D || s.D.length !== M.frames.length * 16) s.D = new Float64Array(M.frames.length * 16)
    if (M.frames.length <= 1) { ident16(s.D, 0); return }
    if (s.aimMode === 'joints' && Number.isFinite(s.a1) && Number.isFinite(s.a2)) framesD(M, s.a1, s.a2, s.D)
    else s.D.set(M.drest)
    dirty = true
  }

  // ───────────── 每帧 ─────────────
  function camChanged(camera, h) {
    const p = camera.position, q = camera.quaternion
    const v0 = p.x, v1 = p.y, v2 = p.z, v3 = q.x, v4 = q.y, v5 = q.z, v6 = q.w, v7 = camera.fov, v8 = camera.aspect, v9 = h
    const S = camSig
    const same = camSigOk && S[0] === v0 && S[1] === v1 && S[2] === v2 && S[3] === v3 && S[4] === v4 && S[5] === v5 && S[6] === v6 && S[7] === v7 && S[8] === v8 && S[9] === v9
    S[0] = v0; S[1] = v1; S[2] = v2; S[3] = v3; S[4] = v4; S[5] = v5; S[6] = v6; S[7] = v7; S[8] = v8; S[9] = v9
    camSigOk = true
    return !same
  }

  function update(dt, camera, w, h) {
    if (disposed || !camera) return
    perfF[2] = nowMs()
    let busy = false
    const st = dt > 0 ? dt / FADE_S : 0
    const fk = dt > 0 ? 1 - Math.exp(-dt / AIM_TAU) : 0
    let alive = false
    for (let i = slotArr.length - 1; i >= 0; i--) {   // 倒序：循环里可能摘掉当前槽位
      const s = slotArr[i]
      const M = s.model
      const ready = !!(M && M.state === 'ready' && M.id === s.modelId)
      const target = (enabled && s.want && !s.trunc && ready && !gpuWeak) ? 1 : 0
      if (s.alpha !== target) {
        s.alpha = target > s.alpha ? Math.min(target, s.alpha + st) : Math.max(target, s.alpha - st)
        if (s.alpha !== target) busy = true
        dirty = true
      }
      if (!s.want && s.alpha <= 0) { dropSlot(i); dirty = true; continue }
      if (M && M.id !== s.modelId && s.alpha <= 0) attachModel(s)
      const Mm = s.model
      if (Mm && Mm.state === 'ready' && !s.D) { s.D = new Float64Array(Mm.frames.length * 16); s.D.set(Mm.drest) }
      if (s.aimDirty) refreshAim(s)   // 关节档里先按基座姿态解（内部会先刷姿态）；整体方位档改了航向再刷姿态
      if (s.poseDirty) refreshPose(s)
      if (s.shadeDirty) refreshShade(s)
      // 目标切换过渡（一阶逼近）；连续跟踪直接贴合
      if (s.trans) {
        s.a1 += (s.t1 - s.a1) * fk; s.a2 += (s.t2 - s.a2) * fk
        if (Math.abs(s.t1 - s.a1) < AIM_DONE && Math.abs(s.t2 - s.a2) < AIM_DONE) { s.a1 = s.t1; s.a2 = s.t2; s.trans = false } else busy = true
        s.jointDirty = true
      }
      if (s.yawTrans) {
        const d = wrap180(s.yawT - s.yaw)
        s.yaw = wrap180(s.yaw + d * fk)
        if (Math.abs(wrap180(s.yawT - s.yaw)) < AIM_DONE) { s.yaw = s.yawT; s.yawTrans = false } else busy = true
        refreshPose(s)
      }
      if (s.jointDirty) computeD(s)
      if (s.alpha > 0) alive = true
    }
    anyAlpha = alive
    busyFlag = busy
    // 引用归零满 60 s 的模型释放；有待出的图标档
    if (modelArr.length) {
      const tn = perfF[2]
      for (let i = modelArr.length - 1; i >= 0; i--) {
        const M = modelArr[i]
        if (!M.refs && tn - M.zeroAt > RELEASE_MS) { releaseModel(M); continue }
        if (M.refs && M.state === 'ready' && !M.lodState && simplifyOn && M.full && M.full.tris > LOD_TRIS && anySmallPx(M)) maybeLod(M)
      }
    }
    const camMoved = camChanged(camera, h)
    if (!dirty && !camMoved) { perfF[3] = nowMs() - perfF[2]; perfF[0] += (perfF[3] - perfF[0]) * 0.1; return }
    dirty = false
    writeInstances(camera, w, h)
    perfF[3] = nowMs() - perfF[2]; perfF[0] += (perfF[3] - perfF[0]) * 0.1
  }
  // 按此刻的屏幕像素判（还没写过实例的按设定像素）：拉远后才变小的也要有图标档
  function anySmallPx(M) {
    for (let i = 0; i < slotArr.length; i++) { const s = slotArr[i]; if (s.model === M && (s.pxE > 0 ? s.pxE : s.px) <= LOD_PX) return true }
    return false
  }

  function writeInstances(camera, w, h) {
    // 投影不经相机矩阵（出帧前 three 才更新 matrixWorld；这里就地按位置 / 朝向 / 视场算，零分配、与本帧相机一致）
    const tanH = Math.tan(camera.fov * Math.PI / 360)
    const C = camera.position
    const cq = camera.quaternion, qx = -cq.x, qy = -cq.y, qz = -cq.z, qw = cq.w   // 世界 → 相机 = conj(q)
    const asp = camera.aspect > 0 ? camera.aspect : 1
    const cl = Math.sqrt(C.x * C.x + C.y * C.y + C.z * C.z) || 1
    const cdx = C.x / cl, cdy = C.y / cl, cdz = C.z / cl
    const hh = Math.max(1, h), ww = Math.max(1, w)
    // 随缩放联动：与标记精灵 / 标记文字同一系数（靶心恒为地心，cl 就是 scene 的 zoomDist；跟随卫星时本层关着）
    const zk = markerZoomK(cl)
    // 1) 计数（容量不够先扩）
    for (let i = 0; i < modelArr.length; i++) { const M = modelArr[i]; if (M.full) M.full.n = 0; if (M.icon) M.icon.n = 0 }
    for (let i = 0; i < slotArr.length; i++) {
      const s = slotArr[i]
      s.drawn = false; s.onScreen = false; s.vIdx = -1
      const M = s.model
      if (s.alpha <= 0 || !M || M.state !== 'ready' || !M.full || !Number.isFinite(s.A[0])) { s.fade = 0; continue }
      const dot = s.An[0] * cdx + s.An[1] * cdy + s.An[2] * cdz
      const hemi = dot <= HEMI_LO ? 0 : (dot >= HEMI_LO + HEMI_SPAN ? 1 : (dot - HEMI_LO) / HEMI_SPAN)
      const f = s.alpha * hemi
      s.fade = f
      if (f <= 0.002) continue
      s.drawn = true
      s.pxE = s.px * zk
      const V = (M.icon && s.pxE <= LOD_PX) ? M.icon : M.full
      s.vIdx = V.n++
      s.vIsIcon = V === M.icon
    }
    // 容量：不够就扩到 2 的幂；在画的掉到四分之一以下收缩（整块上传的量跟着回落；两道门之间有滞回，不来回抖；全藏到背面时不收）
    for (let i = 0; i < modelArr.length; i++) {
      const M = modelArr[i]
      if (M.full && (M.full.n > M.full.cap || (M.full.cap > 16 && M.full.n > 0 && M.full.n * 4 < M.full.cap))) allocVariant(M.full, nextPow2(Math.max(16, M.full.n * 2)))
      if (M.icon && (M.icon.n > M.icon.cap || (M.icon.cap > 16 && M.icon.n > 0 && M.icon.n * 4 < M.icon.cap))) allocVariant(M.icon, nextPow2(Math.max(16, M.icon.n * 2)))
    }
    // 2) 写实例
    let nShown = 0
    let hx0 = Infinity, hy0 = Infinity, hx1 = -Infinity, hy1 = -Infinity
    for (let i = 0; i < slotArr.length; i++) {
      const s = slotArr[i]
      if (!s.drawn) continue
      const M = s.model
      const V = s.vIsIcon ? M.icon : M.full
      const j = s.vIdx
      const A = s.A
      const R = s.R, E = s.E, p = s.anchor ? s.anchor.pos : M.center, cc0 = M.center
      // 像素 = 包围球（盒心为心）在屏幕上的直径：按相机到【图标中心】的距离定尺（地球站锚在盒底，中心比锚点离相机近约一个半径，
      // 按锚点距离定尺近景会大出几个百分点）。中心 = A + k·o（o = R·(盒心 − p)），k = α·D_c（α = pxE·tanH / (H·半径)，pxE = px × 缩放联动系数），
      // D_c = |A − cam + α·D_c·o| 的正根（闭式，无迭代）
      const ux = A[0] - C.x, uy = A[1] - C.y, uz = A[2] - C.z
      const vx = cc0[0] - p[0], vy = cc0[1] - p[1], vz = cc0[2] - p[2]
      const ox = R[0] * vx + R[3] * vy + R[6] * vz, oy = R[1] * vx + R[4] * vy + R[7] * vz, oz = R[2] * vx + R[5] * vy + R[8] * vz
      const al = s.pxE * tanH / (hh * M.radius)
      const uu = ux * ux + uy * uy + uz * uz, uo = ux * ox + uy * oy + uz * oz, oo = ox * ox + oy * oy + oz * oz
      const qa = 1 - al * al * oo
      const Dc = qa > 1e-6 ? (al * uo + Math.sqrt(al * al * uo * uo + qa * uu)) / qa : Math.sqrt(uu)
      const k = al * Dc
      s.k = k
      // E = T(A) · R · S(k) · T(−p)
      E[0] = k * R[0]; E[1] = k * R[1]; E[2] = k * R[2]; E[3] = 0
      E[4] = k * R[3]; E[5] = k * R[4]; E[6] = k * R[5]; E[7] = 0
      E[8] = k * R[6]; E[9] = k * R[7]; E[10] = k * R[8]; E[11] = 0
      E[12] = A[0] - (E[0] * p[0] + E[4] * p[1] + E[8] * p[2])
      E[13] = A[1] - (E[1] * p[0] + E[5] * p[1] + E[9] * p[2])
      E[14] = A[2] - (E[2] * p[0] + E[6] * p[1] + E[10] * p[2])
      E[15] = 1
      const fa = V.frameAttr
      for (let f = 0; f < fa.length; f++) {
        const at = fa[f]
        if (!at) continue
        const arr = at.array, o16 = j * 16
        if (f === 0) { for (let e = 0; e < 16; e++) arr[o16 + e] = E[e] }
        else { mul4(E, 0, s.D, f * 16, _E2, 0); for (let e = 0; e < 16; e++) arr[o16 + e] = _E2[e] }
      }
      V.fade.array[j] = s.fade
      V.shade.array[j] = s.shade
      const ca = V.clip.array, c = s.clip
      ca[j * 4] = c[0]; ca[j * 4 + 1] = c[1]; ca[j * 4 + 2] = c[2]; ca[j * 4 + 3] = c[3]
      // 屏幕缓存（命中用）：图标中心 = E · 盒心
      const cc = M.center
      const px0 = E[0] * cc[0] + E[4] * cc[1] + E[8] * cc[2] + E[12] - C.x
      const py0 = E[1] * cc[0] + E[5] * cc[1] + E[9] * cc[2] + E[13] - C.y
      const pz0 = E[2] * cc[0] + E[6] * cc[1] + E[10] * cc[2] + E[14] - C.z
      // v' = v + w·t + q × t，t = 2·(q × v)（q = 相机朝向的共轭）
      const tx = 2 * (qy * pz0 - qz * py0), ty = 2 * (qz * px0 - qx * pz0), tz = 2 * (qx * py0 - qy * px0)
      const cx = px0 + qw * tx + (qy * tz - qz * ty), cy = py0 + qw * ty + (qz * tx - qx * tz), cz = pz0 + qw * tz + (qx * ty - qy * tx)
      if (-cz > camera.near) {
        const nx = cx / (-cz * tanH * asp), ny = cy / (-cz * tanH)
        s.sx = (nx * 0.5 + 0.5) * ww; s.sy = (0.5 - ny * 0.5) * hh; s.sr = s.pxE / 2
        s.onScreen = true
        const rr = s.sr + 1
        if (s.sx - rr < hx0) hx0 = s.sx - rr
        if (s.sy - rr < hy0) hy0 = s.sy - rr
        if (s.sx + rr > hx1) hx1 = s.sx + rr
        if (s.sy + rr > hy1) hy1 = s.sy + rr
      } else { hx0 = -Infinity; hy0 = -Infinity; hx1 = Infinity; hy1 = Infinity }   // 贴着相机的（屏幕位置不可信）：整屏
      nShown++
    }
    // 描边合成的剪裁矩形（外晕半径 + 余量；夹到画布）
    const hm = HALO_R2 + 2
    haloAny = nShown > 0
    haloRect[0] = Math.max(0, Math.floor(hx0 - hm)); haloRect[1] = Math.max(0, Math.floor(hy0 - hm))
    haloRect[2] = Math.min(ww, Math.ceil(hx1 + hm)); haloRect[3] = Math.min(hh, Math.ceil(hy1 + hm))
    if (!(haloRect[2] > haloRect[0] && haloRect[3] > haloRect[1])) haloAny = false
    // 3) 上传范围 / 绘制数
    let dc = 0, ni = 0, tr = 0
    for (let i = 0; i < modelArr.length; i++) {
      const M = modelArr[i]
      for (let v = 0; v < 2; v++) {
        const V = v === 0 ? M.full : M.icon
        if (!V) continue
        const n = V.n
        if (n > 0 || V.lastN !== 0) {
          for (let f = 0; f < V.frameAttr.length; f++) { const at = V.frameAttr[f]; if (at) touch(at, n) }
          touch(V.fade, n); touch(V.shade, n); touch(V.clip, n)
        }
        V.lastN = n
        for (let g = 0; g < V.groups.length; g++) {
          const G = V.groups[g]
          if (!G.mesh) continue
          G.mesh.count = n
          G.mesh.visible = n > 0
          if (n > 0) { dc++; tr += G.tris * n }
        }
        ni += n
      }
    }
    shown = nShown; drawCalls = dc; instances = ni; trisDrawn = tr
  }
  // 上传：整块（needsUpdate、不给区间）。★ 不走 addUpdateRange：它每次 push 一个新 {start, count}，three 上传完又把 updateRanges
  //   清成长度 0（V8 随之丢掉数组的存储区），下一帧再 push 就是重新分配 —— 热路径上躲不开。容量按 2 的幂、且 n 掉到容量四分之一以下
  //   会收缩（见 writeInstances），整块上传至多是实际量的 4 倍（1024 个实例 × 64 B = 64 KB 一帧），换来零分配
  function touch(at, n) { if (n > 0) at.needsUpdate = true }
  // ───────────── 出帧 ─────────────
  function ensureRenderer(r) {
    if (renderer === r) return
    renderer = r
    try {
      const gl = r.getContext()
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      gpuWeak = isSoftwareRenderer(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      const wantA2c = (gl.getParameter(gl.SAMPLES) || 0) > 1
      if (wantA2c !== a2c) {
        a2c = wantA2c
        for (let i = 0; i < modelArr.length; i++) { const ms = modelArr[i].mats; if (ms) for (const m of ms) { m.alphaToCoverage = a2c; m.needsUpdate = true } }
      }
    } catch { gpuWeak = false }
    if (gpuWeak) { for (let i = 0; i < slotArr.length; i++) slotArr[i].alpha = 0; anyAlpha = false; dirty = true }
    ensureEnv()
    const ws = rendererWaiters; rendererWaiters = []
    for (const f of ws) { try { f() } catch { /* ignore */ } }
  }
  // 描边的离屏件：首次出帧时建，画布尺寸 / 像素比变了跟着改（导出临时抬倍率时也跟）
  function ensureHalo(r, w, h) {
    const pr = typeof r.getPixelRatio === 'function' ? r.getPixelRatio() : 1
    const hs = Math.min(1.5, Math.max(1, pr || 1))
    const W = Math.max(1, Math.ceil(w * hs)), H = Math.max(1, Math.ceil(h * hs))
    if (!maskRT) {
      // 单 / 双通道 8 位（R8 遮罩、RG8 内描边 + 外晕）：2560×1440 的画布、×1.5 也只 25 MB 上下
      const opt = { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, type: THREE.UnsignedByteType }
      maskRT = new THREE.WebGLRenderTarget(W, H, { ...opt, format: THREE.RedFormat })
      haloRT = new THREE.WebGLRenderTarget(W, H, { ...opt, format: THREE.RGFormat })
      maskMat = injectEntShader(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false }), true)
      dilateMat = new THREE.ShaderMaterial({
        uniforms: { tMask: { value: maskRT.texture }, uTexel: { value: new THREE.Vector2(1 / W, 1 / H) }, uR1: { value: HALO_R1 * hs }, uR2: { value: HALO_R2 * hs } },
        vertexShader: FS_VERT, fragmentShader: DILATE_FRAG, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
      })
      compMat = new THREE.ShaderMaterial({
        uniforms: { tHalo: { value: haloRT.texture }, uColor: { value: new THREE.Vector3(HALO_RGB[0], HALO_RGB[1], HALO_RGB[2]) }, uA1: { value: HALO_A1 }, uA2: { value: HALO_A2 } },
        vertexShader: FS_VERT, fragmentShader: COMP_FRAG, transparent: true, depthTest: false, depthWrite: false, toneMapped: false
      })
      fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dilateMat)
      fsMesh.frustumCulled = false
      fsScene = new THREE.Scene()
      fsScene.add(fsMesh)
      fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    }
    if (maskRT.width !== W || maskRT.height !== H) { maskRT.setSize(W, H); haloRT.setSize(W, H) }
    dilateMat.uniforms.uTexel.value.set(1 / W, 1 / H)
    dilateMat.uniforms.uR1.value = HALO_R1 * hs
    dilateMat.uniforms.uR2.value = HALO_R2 * hs
    return hs
  }
  // 描边三趟（遮罩 → 膨胀 → 合成）；调用方已置 autoClear = false。清屏色 / 渲染目标 / 剪裁状态全部原样还回去
  function drawHalo(r, camera, w, h) {
    if (!haloAny) return
    const hs = ensureHalo(r, w, h)
    const prevRT = r.getRenderTarget()
    r.getClearColor(_cc)
    const ca = r.getClearAlpha()
    // ① 遮罩（整张清掉：WebGL 的 clear 受剪裁约束，这里剪裁关着）
    maskRT.scissorTest = false
    r.setRenderTarget(maskRT)
    r.setClearColor(0x000000, 0)
    r.clear(true, false, false)
    iconScene.overrideMaterial = maskMat
    try { r.render(iconScene, camera) } finally { iconScene.overrideMaterial = null }
    // ② 膨胀：只算外包矩形那一块（离屏图像素、y 向上）
    const x0 = Math.floor(haloRect[0] * hs), x1 = Math.ceil(haloRect[2] * hs)
    const yTop = Math.floor(haloRect[1] * hs), yBot = Math.ceil(haloRect[3] * hs)
    haloRT.scissor.set(x0, haloRT.height - yBot, x1 - x0, yBot - yTop)
    haloRT.scissorTest = true
    r.setRenderTarget(haloRT)
    fsMesh.material = dilateMat
    r.render(fsScene, fsCam)
    // ③ 合成到原目标（剪到同一矩形，CSS px、y 向上）
    r.setRenderTarget(prevRT)
    r.setClearColor(_cc, ca)
    const st = r.getScissorTest()
    r.getScissor(_sc)
    r.setScissor(haloRect[0], h - haloRect[3], haloRect[2] - haloRect[0], haloRect[3] - haloRect[1])
    r.setScissorTest(true)
    fsMesh.material = compMat
    try { r.render(fsScene, fsCam) } finally {
      r.setScissor(_sc)
      r.setScissorTest(st)
    }
  }
  function render(r, camera, w, h) {
    ensureRenderer(r)
    if (gpuWeak || !enabled || !anyAlpha || !drawCalls) return
    const t0 = nowMs()
    const tm = r.toneMapping, te = r.toneMappingExposure, ac = r.autoClear
    try {
      if (sunLit) {
        sunLight.position.copy(sunS).multiplyScalar(10)
        fillLight.intensity = FILL_LIT
        fillLight.position.copy(_hl.copy(HEADLIGHT_C).applyQuaternion(camera.quaternion)).multiplyScalar(10)
      } else {
        sunLight.position.copy(_hl.copy(HEADLIGHT_C).applyQuaternion(camera.quaternion)).multiplyScalar(10)
        fillLight.intensity = 0
      }
      sunLight.target.position.set(0, 0, 0); fillLight.target.position.set(0, 0, 0)
      r.autoClear = false
      // 描边垫在图标下面（先画）；画布尺寸缺省按渲染器的 CSS 尺寸
      if (w > 0 && h > 0) drawHalo(r, camera, w, h)
      r.clearDepth()   // 屏幕定尺的符号：不与地球比深度；图标之间照常遮挡
      r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0
      r.render(iconScene, camera)
    } finally {
      r.toneMapping = tm; r.toneMappingExposure = te; r.autoClear = ac
    }
    perfF[1] += (nowMs() - t0 - perfF[1]) * 0.1
  }

  const overlay = {
    update,
    render,
    isEmpty() { return !enabled || (!anyAlpha && !(pendingGpu > 0 && !renderer)) },
    busy() { return busyFlag || (pendingGpu > 0 && !renderer) },
    /** 该实体的模型图标此刻在画布上的中心与半径（CSS 像素）：[x, y, r]；没画 / 背面淡到看不见 → null（scene 的拖放命中与高亮环用） */
    screenOf(key) { const s = slots.get(key); return s && s.drawn && s.onScreen && s.fade > 0.05 ? [s.sx, s.sy, s.sr] : null },
    dispose() { api.dispose() }
  }

  // ───────────── 对外 ─────────────
  const api = {
    overlay,
    setEnabled(on) {
      on = !!on
      if (on === enabled) return
      enabled = on
      // 即时：关 → 全部 alpha 0（精灵权重 1）；开 → 已就绪的槽位直接满 alpha（切视图 / 跟随进出不做交叉淡化）
      for (let i = 0; i < slotArr.length; i++) {
        const s = slotArr[i]
        const M = s.model
        s.alpha = on && s.want && !s.trunc && !gpuWeak && M && M.state === 'ready' && M.id === s.modelId ? 1 : 0
      }
      anyAlpha = false
      if (on) for (let i = 0; i < slotArr.length; i++) if (slotArr[i].alpha > 0) { anyAlpha = true; break }
      dirty = true
    },
    setSun(v) {
      if (!v) return
      const x = +(v.x !== undefined ? v.x : v[0]), y = +(v.y !== undefined ? v.y : v[1]), z = +(v.z !== undefined ? v.z : v[2])
      const l = Math.sqrt(x * x + y * y + z * z)
      if (!(l > 0)) return
      if (x / l === _sunArr[0] && y / l === _sunArr[1] && z / l === _sunArr[2]) return
      _sunArr[0] = x / l; _sunArr[1] = y / l; _sunArr[2] = z / l
      sunS.set(_sunArr[0], _sunArr[1], _sunArr[2])
      for (let i = 0; i < slotArr.length; i++) slotArr[i].shadeDirty = true
    },
    setSunLit(on) {
      on = !!on
      if (on === sunLit) return
      sunLit = on
      for (let i = 0; i < slotArr.length; i++) slotArr[i].shadeDirty = true
      dirty = true
    },
    setEntities,
    spriteWeight(key) {
      if (!enabled) return 1
      const s = slots.get(key)
      return s ? 1 - s.alpha : 1
    },
    hitTest(sx, sy) {
      if (!enabled) return null
      let best = null, bd = Infinity
      for (let i = 0; i < slotArr.length; i++) {
        const s = slotArr[i]
        if (!s.onScreen || !s.drawn || s.fade <= 0.05) continue
        const r = Math.max(8, s.sr)
        const d = Math.hypot(s.sx - sx, s.sy - sy)
        if (d <= r && d / r < bd) { bd = d / r; best = s.key }
      }
      return best
    },
    refreshModel(id) {
      for (let i = 0; i < modelArr.length; i++) {
        const M = modelArr[i]
        if (M.dead || (id && M.id !== id)) continue
        if (M.id.startsWith('param:') || M.id.startsWith('ent:')) continue   // 现生成的一份，不随工作台存盘变
        loadModel(M)
      }
    },
    stats() {
      let nm = 0, prims = 0
      for (let i = 0; i < modelArr.length; i++) {
        const M = modelArr[i]
        if (M.state === 'ready' && M.refs) { nm++; prims += (M.full ? M.full.groups.length : 0) + (M.icon ? M.icon.groups.length : 0) }
      }
      return { enabled, entities: slotArr.length, shown, models: nm, prims, drawCalls, instances, tris: trisDrawn, lodPending, truncated,
        updateMs: +perfF[0].toFixed(3), renderMs: +perfF[1].toFixed(3), gpuWeak }
    },
    _debug: {
      entity(key) {
        const s = slots.get(key)
        if (!s) return null
        const M = s.model
        return {
          modelId: s.modelId, kind: s.kind, alpha: s.alpha, fade: s.fade, px: s.px, pxE: s.pxE, k: s.k,
          anchor: Array.from(s.A), anchorSrc: s.anchor ? s.anchor.src : '', anchorBody: s.anchor ? s.anchor.pos.slice() : null,
          liftM: s.anchor ? s.anchor.liftM : 0, altEffM: s.altEff, qB2S: s.pose.qB2S.slice(),
          aimMode: s.aimMode, a1: s.a1, a2: s.a2, t1: s.t1, t2: s.t2, yawDeg: s.yaw, park: s.park, sunElevDeg: s.sunElev, shade: s.shade,
          screen: [s.sx, s.sy, s.sr], onScreen: s.onScreen, drawn: s.drawn, lod: s.drawn ? (s.vIsIcon ? 'icon' : 'full') : '',
          ready: !!(M && M.state === 'ready'), trunc: s.trunc, clip: Array.from(s.clip),
          E: Array.from(s.E), D: s.D ? Array.from(s.D) : null
        }
      },
      models() {
        const out = []
        for (let i = 0; i < modelArr.length; i++) {
          const M = modelArr[i]
          for (const V of [M.full, M.icon]) {
            if (!V) continue
            out.push({ id: M.id, lod: V.lod, prims: V.groups.length, instances: V.n, tris: V.tris, rig: !!M.rig, frames: M.frames ? M.frames.length : 0,
              box: M.box, radius: M.radius, refs: M.refs, state: M.state, cap: V.cap })
          }
          if (!M.full) out.push({ id: M.id, lod: '', prims: 0, instances: 0, tris: 0, rig: !!M.rig, frames: 0, box: null, radius: 0, refs: M.refs, state: M.state, cap: 0 })
        }
        return out
      },
      /** 单测 / 验证台：某模型某档的内部件（网格 → 帧 / 烘焙矩阵、合批组的 InstancedMesh、帧表） */
      internals(id, lod = 'full') {
        const M = models.get(id)
        if (!M) return null
        const V = lod === 'icon' ? M.icon : M.full
        return { M, V, frames: M.frames, rig: M.rig, root: M.root, MB: M.MB, radius: M.radius, center: M.center, box: M.box, scene: iconScene }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (let i = modelArr.length - 1; i >= 0; i--) releaseModel(modelArr[i])
      models.clear(); modelArr.length = 0
      slots.clear(); slotArr.length = 0
      if (env) { env.dispose(); env = null }
      if (maskRT) {
        maskRT.dispose(); haloRT.dispose(); maskMat.dispose(); dilateMat.dispose(); compMat.dispose(); fsMesh.geometry.dispose()
        maskRT = haloRT = maskMat = dilateMat = compMat = fsMesh = fsScene = fsCam = null
      }
      sunLight.dispose(); fillLight.dispose(); ambLight.dispose()
      if (offReady) { try { offReady() } catch { /* ignore */ } }
      if (analyzer) { try { analyzer.dispose() } catch { /* ignore */ } analyzer = null }
      const ws = rendererWaiters; rendererWaiters = []
      for (const f of ws) { try { f() } catch { /* ignore */ } }
    }
  }
  return api
}
