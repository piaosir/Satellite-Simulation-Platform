// 球面模型图标批次（modelLayer 的球面图标模式；设计契约 §6.2 ①）。
//
// 为什么要批：原来每颗聚焦星一棵模型克隆 + 一套克隆材质，逐网格一次 draw call（星座精模 20–40 个网格），几百颗就扛不住，
// 只好封顶 32 颗 —— 而且按选中顺序取，地球背面的星照样占名额，聚焦一个星座时屏幕上只剩「个别几个」。
// 现在：同一个模型（+ 同一套逐星轴覆盖）的星归一组，组内把静止位姿按「材质 × 关节链」烘成本体系部件，
// 每个部件一次实例化 draw call —— draw call 数与颗数无关。屏幕定尺、地球遮挡、淡入淡出、地影压暗全在着色器里按实例属性算：
//   逐帧 CPU：几个 uniform；淡入淡出期间写透明度；每 100 ms 量一次在画颗数选抽稀档；
//   逐拍 CPU：每颗就地写位置 / 姿态 / 对日角（Float32Array，零分配）。
//
// 实例属性（同组各部件、各抽稀档共用同一份 InstancedBufferAttribute，逐拍只传一次）：
//   iPos  锚点（场景单位，llaToVec 大地版）          iQuat 本体 → 场景（qL2S ⊗ qB2L）
//   iMisc [图标像素, 透明度, 地影因子, 0]              iArt0 / iArt1 对日关节转角（弧度，至多 8 个关节）
// 与原逐颗画法逐项同口径（modelLayer 原 updateIcons）：
//   屏幕半径 pxR = px · pointZoomK(|C|) / 2；世界缩放 k0 = pxR · D · (2·tan(fov/2)/h) / 模型半径；
//   透明度 = 淡入值 × smoothstep(2.5, 5, pxR)；整颗剔除 = 透明度 ≤ 0.002 / pxR ≤ 1.2 / 整颗都在地球后面（见下）；
//   底色 × (下限 + (1 − 下限)·e)、环境反射 × (0.6 + 0.4·e)（e = 地影因子按 1/50 取整，晨昏效果关时恒 1）。
//   另加视锥外整颗剔除（只省顶点，不改画面）。剔除的实例在 main 开头把 gl_Position 打到裁剪体外就 return，后面一句不跑。
// 地球遮挡（2026-10-07 起逐像素）：图标是放大了成千上万倍的符号 ——
//   拿放大后的几何与地球比深度不行（低轨图标下半截扎进球面被削掉，图标那一趟因此先清深度）；
//   只看锚点整颗显隐也不行（原口径）：锚点没被挡就整颗压在地球上，地球背面、只是露在轮廓外的星把地球盖住；锚点一被挡，露在轮廓外的大半个模型整颗消失。
//   现口径：图标当成立在锚点、正对相机的一块板，板距 = 锚点距离往相机提 min(图标世界半径, 4 ×(切线长 − 锚点距离))（boardAt）——
//   近地侧的大图标不被球面鼓起处削掉；比切线远的锚点（背面的、轮廓外但在切点后面的）一点不提，只按地球轮廓裁；
//   片元沿视线与地球球面（半径 EARTH_R = 地球网格）求交，交点比板近就藏，轮廓线与板面交线各按 1 px 过渡（icEarthVis）。
//   整颗剔除只剔「图标视锥整个落在地球轮廓内、且板比切线还远」的（icHidden，保守：凡剔掉的逐像素也必全藏）。
// 对日关节：与跟随视图同一份算式（modelLayer.sunTrackDeg，逐实例记上一拍角度、同样的 0.05° 死区）；着色器里按静止位姿下
//   关节节点的本体系矩阵 W 套 W·R(θ)·W⁻¹（由内到外，至多 3 层嵌套），法向用 W⁻ᵀ·R·Wᵀ。镜像节点烘焙时翻转绕序。
// 抽稀：iconLod.js（Worker）。档位 = 像素误差 ≤ 1 px 的最粗一档，再按「在画颗数 × 三角形」总预算兜底。
// 点精灵遮罩：dotMaskHash.js 的哈希表（锚点 + 实例号）与实例表（透明度 / 像素 / 整颗藏）由本批次建，scene 的点着色器查。
import * as THREE from 'three'
import { pointZoomK } from './zoomScale.js'
import { ICON_LOD_ERR } from './iconLod.js'
import { buildDotMaskTable } from './dotMaskHash.js'

const FADE_S = 0.3
export const ICON_MAX_ART = 8          // 至多几个对日关节逐实例驱动（多出来的停在静止位姿）
export const ICON_MAX_NEST = 3         // 关节链至多几层（再深的取最外三层）
export const ICON_TRI_BUDGET = 6e6     // 在画颗数 × 三角形的总预算（超了逐组往粗里退档）
const LOD_PX_ERR = 1                   // 选档：抽稀误差折到屏幕上不超过 1 px
const VIS_EVERY_MS = 100               // 在画颗数（选档用）最多每 100 ms 量一次
const EMPTY_KEEP_MS = 30000            // 组空了留 30 s 再拆（反复勾选同一批星不必重烘、重编着色器）
const CULL_MARGIN = 1.25               // 视锥 / 地球后整颗剔除的余量（× 图标世界半径）
export const EARTH_R = 0.998           // 地球遮挡球半径 = 地球网格（scene.js 海洋 / 影像球）：轮廓与画出来的地球边缘对齐
const BOARD_K = 4                      // 板往相机提的量 = min(图标世界半径, BOARD_K · (切线长 − 锚点距离))：见 boardAt
const BASE_ATTRS = ['normal', 'uv', 'uv1', 'uv2', 'uv3', 'color', 'tangent']
const DEG = Math.PI / 180

// ============================================================================================
// 烘焙：挂好架的模型（mountInstance 的结果，静止位姿）→ 本体系部件（材质 × 关节链 × 属性集 合并）
// ============================================================================================
const _nm = new THREE.Matrix3(), _bv = new THREE.Vector3()
/**
 * @param {{holder:THREE.Object3D, body:THREE.Object3D}} mount
 * @param {object[]|null} specs 对日关节规格（modelLayer.sunTrackSpecs 的 list），下标即实例属性里的关节号
 * @returns {{parts:{key:string, mat:THREE.Material, attrs:Object<string,{array:Float32Array,itemSize:number}>, index:Uint32Array, nv:number,
 *   bones:{W:THREE.Matrix4, Wi:THREE.Matrix4, axis:THREE.Vector3, art:number}[]}[], tris:number}}
 */
export function bakeParts(mount, specs) {
  const holder = mount.holder
  holder.updateMatrixWorld(true)
  // 关节节点 → 关节号（同一节点挂在几条关节上时后一条为准 —— 与 makeSunTrackers 逐条覆写节点矩阵同口径）
  const artOf = new Map()
  const list = Array.isArray(specs) ? specs.slice(0, ICON_MAX_ART) : []
  list.forEach((t, k) => { for (const n of t.nodes) artOf.set(n, k) })
  const bins = new Map()
  holder.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return
    // 关节链：从网格往上到本体组，由内到外
    let chain = []
    for (let p = o; p && p !== mount.body; p = p.parent) if (artOf.has(p)) chain.push(p)
    if (chain.length > ICON_MAX_NEST) chain = chain.slice(chain.length - ICON_MAX_NEST)
    const g = o.geometry
    const multi = Array.isArray(o.material)
    const mats = multi ? o.material : [o.material]
    const groups = multi && g.groups && g.groups.length ? g.groups : [{ start: 0, count: Infinity, materialIndex: 0 }]
    const names = BASE_ATTRS.filter((k) => g.attributes[k])
    for (const gr of groups) {
      const mat = mats[gr.materialIndex || 0]
      if (!mat || mat.visible === false) continue
      const key = mat.uuid + '|' + chain.map((n) => n.uuid).join(',') + '|' + names.map((k) => k + g.attributes[k].itemSize).join(',')
      let b = bins.get(key)
      if (!b) { b = { key, mat, chain, names, srcs: [] }; bins.set(key, b) }
      b.srcs.push({ mesh: o, start: gr.start || 0, count: gr.count })
    }
  })
  const parts = []
  let tris = 0
  for (const b of bins.values()) {
    const p = mergeSources(b)
    if (!p) continue
    p.bones = b.chain.map((n) => {
      const W = n.matrixWorld.clone()
      return { W, Wi: W.clone().invert(), axis: list[artOf.get(n)].axis.clone().normalize(), art: artOf.get(n) }
    })
    tris += p.index.length / 3
    parts.push(p)
  }
  return { parts, tris }
}

// 同一箱的网格并成一份：顶点乘网格的本体系矩阵（法向乘法向矩阵、切向乘线性部分），行列式为负的翻转绕序
function mergeSources(b) {
  let nv = 0, ni = 0
  const plans = []
  for (const s of b.srcs) {
    const g = s.mesh.geometry
    const vc = g.attributes.position.count
    const idx = g.index
    const total = idx ? idx.count : vc
    const start = Math.max(0, Math.min(total, s.start))
    const end = s.count === Infinity || s.count == null ? total : Math.min(total, start + s.count)
    const cnt = Math.floor((end - start) / 3) * 3
    if (cnt < 3) continue
    plans.push({ g, vc, idx, start, cnt, M: s.mesh.matrixWorld, base: nv, mesh: s.mesh })
    nv += vc; ni += cnt
  }
  if (!ni) return null
  const attrs = { position: { array: new Float32Array(nv * 3), itemSize: 3 } }
  for (const k of b.names) {
    const sz = plans[0].g.attributes[k].itemSize
    attrs[k] = { array: new Float32Array(nv * sz), itemSize: sz }
  }
  const index = new Uint32Array(ni)
  let io = 0
  for (const pl of plans) {
    const M = pl.M, g = pl.g
    _nm.getNormalMatrix(M)
    const flip = M.determinant() < 0
    const P = g.attributes.position, out = attrs.position.array
    for (let i = 0; i < pl.vc; i++) {
      _bv.fromBufferAttribute(P, i).applyMatrix4(M)
      const o = (pl.base + i) * 3
      out[o] = _bv.x; out[o + 1] = _bv.y; out[o + 2] = _bv.z
    }
    for (const k of b.names) {
      const A = g.attributes[k], a = attrs[k], sz = a.itemSize, arr = a.array
      if (k === 'normal') {
        for (let i = 0; i < pl.vc; i++) {
          _bv.set(A.getComponent(i, 0), A.getComponent(i, 1), A.getComponent(i, 2)).applyMatrix3(_nm)
          const l = _bv.length() || 1
          const o = (pl.base + i) * sz
          arr[o] = _bv.x / l; arr[o + 1] = _bv.y / l; arr[o + 2] = _bv.z / l
        }
      } else if (k === 'tangent') {
        for (let i = 0; i < pl.vc; i++) {
          _bv.set(A.getComponent(i, 0), A.getComponent(i, 1), A.getComponent(i, 2)).transformDirection(M)
          const o = (pl.base + i) * sz
          arr[o] = _bv.x; arr[o + 1] = _bv.y; arr[o + 2] = _bv.z
          if (sz > 3) arr[o + 3] = A.getComponent(i, 3) * (flip ? -1 : 1)
        }
      } else {
        for (let i = 0; i < pl.vc; i++) for (let c = 0; c < sz; c++) arr[(pl.base + i) * sz + c] = A.getComponent(i, c)
      }
    }
    for (let t = 0; t < pl.cnt; t += 3) {
      const r = pl.start + t
      const a = pl.idx ? pl.idx.getX(r) : r, b1 = pl.idx ? pl.idx.getX(r + 1) : r + 1, c = pl.idx ? pl.idx.getX(r + 2) : r + 2
      index[io++] = pl.base + a
      if (flip) { index[io++] = pl.base + c; index[io++] = pl.base + b1 } else { index[io++] = pl.base + b1; index[io++] = pl.base + c }
    }
  }
  // srcs：各来源网格在合并顶点表里的起点（单测按它逐顶点对拍真场景树）
  return { key: b.key, mat: b.mat, attrs, index, nv, srcs: plans.map((pl) => ({ mesh: pl.mesh, base: pl.base, vc: pl.vc })) }
}

/**
 * 着色器顶点变换的逐句 JS 镜像（单测拿它与真场景树对拍；运行时不调）。
 * p：烘好的本体系顶点；angles：各关节转角（弧度）；inst：{pos:[3], quat:[4], k0}（世界缩放）。返回场景坐标。
 */
export function iconVertexMirror(part, p, angles, inst) {
  let v = new THREE.Vector3(p[0], p[1], p[2])
  const R = new THREE.Matrix4()
  for (const b of part.bones) {
    R.makeRotationAxis(b.axis, angles[b.art] || 0)
    v.applyMatrix4(b.Wi).applyMatrix4(R).applyMatrix4(b.W)
  }
  if (!inst) return [v.x, v.y, v.z]
  const q = new THREE.Quaternion(inst.quat[0], inst.quat[1], inst.quat[2], inst.quat[3])
  v.multiplyScalar(inst.k0).applyQuaternion(q)
  return [inst.pos[0] + v.x, inst.pos[1] + v.y, inst.pos[2] + v.z]
}

// ============================================================================================
// 着色器（onBeforeCompile 注入；原材质的光照模型、贴图、双面一概不动）
// ============================================================================================
const VS_PARS = (nb, na) => `
#define IC_NB ${nb}
#define IC_NA ${na}
#define IC_RE ${EARTH_R.toFixed(4)}
attribute vec3 iPos;
attribute vec4 iQuat;
attribute vec4 iMisc;
#if IC_NA > 0
attribute vec4 iArt0;
#endif
#if IC_NA > 4
attribute vec4 iArt1;
#endif
uniform float uIcZk;
uniform float uIcWpp;
uniform float uIcR;
uniform float uIcFloor;
#if IC_NB > 0
uniform mat4 uIcBW[ IC_NB ];
uniform mat4 uIcBWi[ IC_NB ];
uniform vec4 uIcBA[ IC_NB ];
#endif
varying float vIcA;
varying float vIcK;
varying float vIcEnv;
varying vec3 vIcW;
varying vec4 vIcBb;
vec3 icRot( vec4 q, vec3 v ) { vec3 t = 2.0 * cross( q.xyz, v ); return v + q.w * t + cross( q.xyz, t ); }
// 整个图标都在地球后面（与 JS hiddenAt 同式）：a 锚点方向（单位），wb 板距，s 图标视锥半角的正弦（含余量）。
// 视锥整个落在地球轮廓锥内（φ + θ < θE），且板比切线远（逐像素那头的交点距离都 ≤ 切线长）→ 每个片元都会被藏
bool icHidden( vec3 a, float wb, float s ) {
  float cc = dot( cameraPosition, cameraPosition );
  float l2 = cc - IC_RE * IC_RE;
  if ( wb <= 0.0 || wb * wb <= l2 || s >= 1.0 ) return false;
  float ca = - dot( a, cameraPosition ) / sqrt( cc );
  if ( ca <= 0.0 ) return false;
  return ca * sqrt( 1.0 - s * s ) - sqrt( max( 0.0, 1.0 - ca * ca ) ) * s > sqrt( l2 / cc );
}
#if IC_NB > 0
float icAng( int k ) {
#if IC_NA > 4
  return k < 4 ? iArt0[ k ] : iArt1[ k - 4 ];
#elif IC_NA > 0
  return iArt0[ min( k, 3 ) ];
#else
  return 0.0;
#endif
}
mat3 icAxisAngle( vec3 a, float th ) {
  float c = cos( th ), s = sin( th ), t = 1.0 - c;
  return mat3( t * a.x * a.x + c, t * a.x * a.y + s * a.z, t * a.x * a.z - s * a.y,
               t * a.x * a.y - s * a.z, t * a.y * a.y + c, t * a.y * a.z + s * a.x,
               t * a.x * a.z + s * a.y, t * a.y * a.z - s * a.x, t * a.z * a.z + c );
}
#endif
`
const VS_PRE = `
  float icPxR = iMisc.x * uIcZk * 0.5;
  float icT = clamp( ( icPxR - 2.5 ) / 2.5, 0.0, 1.0 );
  vIcA = iMisc.y * icT * icT * ( 3.0 - 2.0 * icT );
  vIcK = uIcFloor + ( 1.0 - uIcFloor ) * iMisc.z;
  vIcEnv = 0.6 + 0.4 * iMisc.z;
  vec3 icDv = iPos - cameraPosition;
  float icD = length( icDv );
  float icK0 = icPxR * icD * uIcWpp / uIcR;
  float icRw = icK0 * uIcR;
  float icTl = sqrt( max( 0.0, dot( cameraPosition, cameraPosition ) - IC_RE * IC_RE ) );
  vIcBb = vec4( icDv / icD, icD - min( icRw, max( 0.0, ${BOARD_K.toFixed(1)} * ( icTl - icD ) ) ) );
  bool icCull = vIcA <= 0.002 || icPxR <= 1.2;
  if ( ! icCull ) icCull = icHidden( vIcBb.xyz, vIcBb.w, icRw * ${CULL_MARGIN.toFixed(2)} / icD );
  if ( ! icCull ) {
    vec4 icC = projectionMatrix * ( viewMatrix * vec4( iPos, 1.0 ) );
    float icRm = icRw * ${CULL_MARGIN.toFixed(2)};
    icCull = icC.w <= 0.0 || abs( icC.x ) > icC.w + icRm * projectionMatrix[ 0 ][ 0 ] || abs( icC.y ) > icC.w + icRm * projectionMatrix[ 1 ][ 1 ];
  }
  if ( icCull ) { gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 ); return; }
`
const VS_NRM = `
#if IC_NB > 0
  for ( int icI = 0; icI < IC_NB; icI ++ ) {
    mat3 icRn = icAxisAngle( uIcBA[ icI ].xyz, icAng( int( uIcBA[ icI ].w + 0.5 ) ) );
    objectNormal = transpose( mat3( uIcBWi[ icI ] ) ) * ( icRn * ( transpose( mat3( uIcBW[ icI ] ) ) * objectNormal ) );
  #ifdef USE_TANGENT
    objectTangent = mat3( uIcBW[ icI ] ) * ( icRn * ( mat3( uIcBWi[ icI ] ) * objectTangent ) );
  #endif
  }
#endif
  objectNormal = icRot( iQuat, objectNormal );
#ifdef USE_TANGENT
  objectTangent = icRot( iQuat, objectTangent );
#endif
`
const VS_POS = `
#if IC_NB > 0
  for ( int icI = 0; icI < IC_NB; icI ++ ) {
    mat3 icRp = icAxisAngle( uIcBA[ icI ].xyz, icAng( int( uIcBA[ icI ].w + 0.5 ) ) );
    vec4 icL = uIcBWi[ icI ] * vec4( transformed, 1.0 );
    transformed = ( uIcBW[ icI ] * vec4( icRp * icL.xyz, 1.0 ) ).xyz;
  }
#endif
  transformed = iPos + icRot( iQuat, transformed * icK0 );
  vIcW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`
// 逐像素地球遮挡（与 JS earthOccludes 同式，这里另带 1 px 过渡）：视线 u 与地球球面的近交点 t1 比板（vIcBb：锚点方向 + 板距）近就藏。
// 视线背着地球（b ≥ 0）时交点在相机身后：ds 取 −l2 —— 与 b = 0 处的 b² − l2 接上，fwidth 不跳
const FS_PARS = `
#define IC_RE ${EARTH_R.toFixed(4)}
varying float vIcA;
varying float vIcK;
varying float vIcEnv;
varying vec3 vIcW;
varying vec4 vIcBb;
float icEarthVis() {
  vec3 u = normalize( vIcW - cameraPosition );
  float b = dot( u, cameraPosition );
  float l2 = dot( cameraPosition, cameraPosition ) - IC_RE * IC_RE;
  float ds = b < 0.0 ? b * b - l2 : - l2;
  float h = vIcBb.w / max( dot( u, vIcBb.xyz ), 1e-3 ) - ( - b - sqrt( max( ds, 0.0 ) ) );
  float vL = clamp( 0.5 - ds / max( fwidth( ds ), 1e-12 ), 0.0, 1.0 );
  float vD = clamp( 0.5 - h / max( fwidth( h ), 1e-12 ), 0.0, 1.0 );
  return max( vL, vD );
}
`
const FS_COL = `
  diffuseColor.rgb *= vIcK;
  float icVis = icEarthVis();
  if ( icVis < 0.004 ) discard;
  diffuseColor.a *= vIcA * icVis;
`
// 环境反射逐颗按地影压暗：envMapIntensity 是全材质一个 uniform，换成乘上实例系数的版本（两处 return 各乘一次）
const ENV_PARS = THREE.ShaderChunk.envmap_physical_pars_fragment.split('* envMapIntensity;').join('* envMapIntensity * vIcEnv;')

function patchMaterial(src, nb, na, U, G, boneU, envTex, envI) {
  const m = src.clone()
  m.userData = { ...m.userData }
  delete m.userData._shared   // 克隆归本批次所有（disposeObject 见到 _shared 会跳过）
  // 恒为 transparent（淡入淡出靠它；不透明度 1 时混合结果与不透明画法相同）、写深度（图标之间靠深度互相遮挡）——与原逐颗画法同
  m.transparent = true; m.opacity = 1; m.depthWrite = true
  if ('envMap' in m && envTex) { m.envMap = envTex; if ('envMapIntensity' in m) m.envMapIntensity = envI }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uIcZk = U.uIcZk; sh.uniforms.uIcWpp = U.uIcWpp; sh.uniforms.uIcFloor = U.uIcFloor
    sh.uniforms.uIcR = G.uR
    if (nb) { sh.uniforms.uIcBW = boneU.uIcBW; sh.uniforms.uIcBWi = boneU.uIcBWi; sh.uniforms.uIcBA = boneU.uIcBA }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VS_PARS(nb, na))
      .replace('void main() {', 'void main() {\n' + VS_PRE)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + VS_NRM)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VS_POS)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FS_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FS_COL)
      .replace('#include <envmap_physical_pars_fragment>', ENV_PARS)
  }
  m.customProgramCacheKey = () => 'iconBatch|' + nb + '|' + na
  m.needsUpdate = true
  return m
}

// ============================================================================================
// 四元数（数组 [x,y,z,w]，零分配）
// ============================================================================================
// out = a ⊗ b
function qMulTo(a, b, out, o) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3]
  out[o] = aw * bx + ax * bw + ay * bz - az * by
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz
}
// 向量按 q 的逆旋转（q 单位）：v' = q* ⊗ v ⊗ q
function qRotInvTo(q, o, v, out) {
  const x = -q[o], y = -q[o + 1], z = -q[o + 2], w = q[o + 3]
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x)
  out.x = v.x + w * tx + (y * tz - z * ty)
  out.y = v.y + w * ty + (z * tx - x * tz)
  out.z = v.z + w * tz + (x * ty - y * tx)
}

// 相机 → P 的线段是否先穿过单位球（scene.occludedByGlobe 同一判据）。图标已改逐像素遮挡，这里只留给单测当旧口径对照
function occludedAt(C, x, y, z) {
  const dx = x - C.x, dy = y - C.y, dz = z - C.z
  const a = dx * dx + dy * dy + dz * dz
  const b = 2 * (C.x * dx + C.y * dy + C.z * dz)
  const c = C.x * C.x + C.y * C.y + C.z * C.z - 1
  const disc = b * b - 4 * a * c
  if (disc <= 0) return false
  const sq = Math.sqrt(disc), EPS = 1e-4
  const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a)
  return (t1 > EPS && t1 < 1 - EPS) || (t2 > EPS && t2 < 1 - EPS)
}
// 板距（着色器 vIcBb.w 同式）：锚点距离 d 往相机提 min(图标世界半径 rw, BOARD_K·(切线长 L − d))。
//   比切线近的锚点（看得见、在地球轮廓前面）提满一个半径：近地侧的大图标不被球面鼓起处削掉（BOARD_K = 1 时贴边低轨大图标削掉 17%，4 起只剩轮廓边上 ≤ 3% 的外圈）；
//   比切线远的（地球背面的、轮廓外但在切点后面的）一点不提：大图标只按地球轮廓裁，不会提到地球前面。d 过切线长时板距连续
function boardAt(C, d, rw) {
  const L = Math.sqrt(Math.max(0, C.x * C.x + C.y * C.y + C.z * C.z - EARTH_R * EARTH_R))
  return d - Math.min(rw, Math.max(0, BOARD_K * (L - d)))
}
// 整颗图标都在地球后面（着色器 icHidden 的镜像）：C 相机；(x,y,z) 锚点；rw 图标世界半径（= pxR · D · 世界/像素）
function hiddenAt(C, x, y, z, rw) {
  const dx = x - C.x, dy = y - C.y, dz = z - C.z
  const d = Math.hypot(dx, dy, dz)
  const cc = C.x * C.x + C.y * C.y + C.z * C.z
  const l2 = cc - EARTH_R * EARTH_R
  const wb = boardAt(C, d, rw), s = rw * CULL_MARGIN / d
  if (!(d > 0) || wb <= 0 || wb * wb <= l2 || s >= 1) return false
  const ca = -(dx * C.x + dy * C.y + dz * C.z) / (d * Math.sqrt(cc))
  if (ca <= 0) return false
  return ca * Math.sqrt(1 - s * s) - Math.sqrt(Math.max(0, 1 - ca * ca)) * s > Math.sqrt(l2 / cc)
}
// 逐像素遮挡（着色器 icEarthVis 的硬边版，单测对拍用）：u 视线单位矢量；a 锚点方向单位矢量；wb 板距 → 这条视线上的图标被地球挡住
function earthOccludes(C, u, a, wb) {
  const b = u.x * C.x + u.y * C.y + u.z * C.z
  const l2 = C.x * C.x + C.y * C.y + C.z * C.z - EARTH_R * EARTH_R
  const ds = b < 0 ? b * b - l2 : -l2
  if (ds <= 0) return false
  const t1 = -b - Math.sqrt(ds)
  const tb = wb / Math.max(u.x * a.x + u.y * a.y + u.z * a.z, 1e-3)
  return t1 < tb
}

/**
 * 抽稀档的选法（chooseLevels 用）：抽稀误差折到输出像素不超过 LOD_PX_ERR 的最粗一档。
 * extent / radius：模型最大边与包围半径（同一单位）；pxR：图标屏上半径（CSS px）；scale：输出像素 / CSS 像素（屏上 1，出图 = 渲染倍率）
 */
export function iconLodLevel(extent, radius, pxR, scale = 1) {
  const r = pxR * (scale > 1 ? scale : 1)
  for (let j = ICON_LOD_ERR.length - 1; j >= 1; j--) if (ICON_LOD_ERR[j] * extent * r / radius <= LOD_PX_ERR) return j
  return 0
}

// ============================================================================================
// 批次
// ============================================================================================
/**
 * @param {{scene:THREE.Scene, acquire:(id:string)=>Promise<object|null>, mount:(inst:object, frame:object|null)=>object,
 *   frameSig:(frame:object|null)=>string, waitRenderer:()=>Promise|null, warmUp:(obj:THREE.Object3D)=>Promise,
 *   envTex:()=>THREE.Texture|null, gpuTrack?:(obj:THREE.Object3D)=>void, isWeak:()=>boolean, envI:number, eclFloor:number}} o
 */
export function createIconBatch(o) {
  const scene = o.scene
  const groups = new Map()        // 组键（modelId + '#' + 轴覆盖签名）→ 组
  const groupArr = []             // 同一批组（逐帧下标循环）
  const recs = new Map()          // 星键 → { g, i, gid }
  const U = { uIcZk: { value: 1 }, uIcWpp: { value: 1e-3 }, uIcFloor: { value: o.eclFloor } }
  let defaultPx = 28, sunLit = true, lastGate = null, zk = 1, disposed = false
  let zkFixed = null   // 缩放联动系数的定值（跟随卫星时由模型层给跟随档 zoomScale.FOLLOW_ICON_K；null = 按相机离地心距离算）
  let lastCam = null, visT = 0, visDirty = true
  // 抽稀档的像素倍率（输出像素 / CSS 像素）：屏上恒 1；3D 出图 / 视频出帧时由 scene 设成渲染倍率（见 setLodScale）。
  // lodForce：下一次 update 不等 100 ms 节流、当场重选档位
  let lodScale = 1, lodForce = false
  const camPos = new THREE.Vector3(), camMat = new Float64Array(18)
  const _sb = { x: 1, y: 0, z: 0 }, _sbB = { x: 1, y: 0, z: 0 }
  const sunS = new THREE.Vector3(1, 0, 0)

  // ---------------- 实例号（点精灵遮罩的实例表下标） ----------------
  const freeGid = []
  let gidTop = 0
  const allocGid = () => (freeGid.length ? freeGid.pop() : gidTop++)
  const releaseGid = (g) => { if (g >= 0) freeGid.push(g) }

  // ---------------- 组 ----------------
  function newGroup(key, modelId, frame) {
    const g = {
      key, modelId, frame: frame || null, state: 'loading', req: 0, inst: null, radius: 1, extent: 1,
      specs: null, bodyToModel: null, na: 0, parts: [], levels: [], level: 0, lodReq: 0,
      root: new THREE.Group(), uR: { value: 1 },
      cap: 0, n: 0, keys: [], want: null, gid: null, ecl: null, prev: null,
      pos: null, quat: null, misc: null, art0: null, art1: null, attrs: null,
      maxPx: 0, fading: false, alphaMax: 0, emptySince: 0, visN: 0, anglesStale: false
    }
    g.root.name = 'iconGroup:' + modelId
    g.root.matrixAutoUpdate = false
    grow(g, 16)
    groups.set(key, g); groupArr.push(g)
    loadGroup(g)
    return g
  }
  // 实例数组扩容（×2）：实例属性换新对象、就地挂到各档几何上（three 按属性对象认缓冲，换了就重绑、重传）。
  // ★ 不许 dispose 再重建几何：各档几何共用顶点属性，dispose 一个会把共用的 GPU 缓冲删掉，别的档的 VAO 还指着它 —— 整组画不出来
  function grow(g, need) {
    let cap = Math.max(16, g.cap)
    while (cap < need) cap *= 2
    if (cap === g.cap) return
    const cp = (a, k) => { const b = new Float32Array(cap * k); if (a) b.set(a.subarray(0, g.n * k)); return b }
    g.pos = cp(g.pos, 3); g.quat = cp(g.quat, 4); g.misc = cp(g.misc, 4); g.art0 = cp(g.art0, 4); g.art1 = cp(g.art1, 4)
    g.ecl = cp(g.ecl, 1)
    const prev = new Float32Array(cap * ICON_MAX_ART).fill(NaN); if (g.prev) prev.set(g.prev.subarray(0, g.n * ICON_MAX_ART)); g.prev = prev
    const want = new Uint8Array(cap); if (g.want) want.set(g.want.subarray(0, g.n)); g.want = want
    const gid = new Int32Array(cap).fill(-1); if (g.gid) gid.set(g.gid.subarray(0, g.n)); g.gid = gid
    g.cap = cap
    const mk = (arr, k) => { const a = new THREE.InstancedBufferAttribute(arr, k); a.setUsage(THREE.DynamicDrawUsage); return a }
    g.attrs = { iPos: mk(g.pos, 3), iQuat: mk(g.quat, 4), iMisc: mk(g.misc, 4), iArt0: mk(g.art0, 4), iArt1: mk(g.art1, 4) }
    for (const lv of g.levels) if (lv) for (const geo of lv.geos) if (geo) attachInst(g, geo, g.na)
  }
  function markAll(g, name, k) {
    const a = g.attrs[name]
    a.clearUpdateRanges()
    if (g.n) a.addUpdateRange(0, g.n * k)
    a.needsUpdate = true
  }
  // 全部实例属性（位置 / 姿态 / 尺寸与透明度 / 对日角）整份重传
  function markInst(g) {
    markAll(g, 'iPos', 3); markAll(g, 'iQuat', 4); markAll(g, 'iMisc', 4)
    if (g.na) { markAll(g, 'iArt0', 4); if (g.na > 4) markAll(g, 'iArt1', 4) }
  }

  // 模板：取模型 → 挂架（静止位姿 + 对日关节）→ 烘部件 → 克隆材质打补丁 → 第 0 档几何 → 后台预编译着色器 → 上场景
  async function loadGroup(g) {
    const req = ++g.req
    const live = () => !disposed && groups.get(g.key) === g && req === g.req
    if (o.isWeak()) { g.state = 'weak'; return }
    let inst = null
    try { inst = await o.acquire(g.modelId) } catch { inst = null }
    if (!live()) { if (inst) inst.release(); return }
    if (!inst) { if (g.state !== 'ready') g.state = 'none'; return }   // 没模型：留着点精灵（下载就绪时 onModelReady 重取）
    const w = o.waitRenderer()
    if (w) await w
    if (!live() || o.isWeak()) { inst.release(); if (live()) g.state = 'weak'; return }
    let built
    try { built = buildTemplate(g, inst) } catch (e) { console.warn('[models] 图标批次烘焙失败：' + g.modelId + ' ' + ((e && e.message) || e)); inst.release(); if (g.state !== 'ready') g.state = 'none'; return }
    try { await o.warmUp(built.levelRoot) } catch { /* 编不过：交给正常渲染路径 */ }
    if (!live()) { disposeBuilt(built); inst.release(); return }
    // 换上（元数据刷新时旧模板照画到新的就绪，实例与透明度不动）
    const wasReady = g.state === 'ready'
    disposeTemplate(g)
    g.inst = inst; g.radius = built.radius; g.extent = built.extent; g.uR.value = built.radius
    g.specs = built.specs; g.bodyToModel = built.bodyToModel; g.na = built.na
    g.parts = built.parts; g.levels = [built.level0]; g.level = 0
    // ★ 第 0 档几何是在预编译（warmUp，约 0.1–1 s）之前按当时的实例数 / 实例属性造的。这期间 set() 加进来的同模型星：
    //   instanceCount 停在旧值（setCount 只改 g.levels 上的档，这一档还不在里面），扩容换的新实例属性也只挂到旧档上 ——
    //   新星在全精度档上一颗不画，而它们照常淡入、原位的点照常被遮，图标调大 / 拉近时就一直缺。
    //   换上之后按此刻的实例属性与颗数重挂一遍、整份重传
    for (const geo of built.level0.geos) if (geo) attachInst(g, geo, g.na)
    markInst(g)
    g.root.add(built.levelRoot)
    g.state = 'ready'
    if (!g.root.parent) scene.add(g.root)
    if (o.gpuTrack) o.gpuTrack(g.root)
    // 对日角按现有姿态与太阳重算一遍（模板到之前不知道有几个关节）
    if (g.na) { g.prev.fill(NaN); for (let i = 0; i < g.n; i++) trackSunAt(g, i) ; markAll(g, 'iArt0', 4); markAll(g, 'iArt1', 4) }
    if (!wasReady) g.fading = true
    visDirty = true
    requestLods(g)
  }
  function buildTemplate(g, inst) {
    const mount = o.mount(inst, g.frame)
    const specs = mount.sun ? mount.sun.specs : null
    const bodyToModel = mount.sun ? mount.sun.bodyToModel : null
    const na = specs ? Math.min(ICON_MAX_ART, specs.length) : 0
    const { parts: raw } = bakeParts(mount, specs)
    const envTex = o.envTex()
    const parts = raw.map((p) => {
      const base = {}
      base.position = new THREE.BufferAttribute(p.attrs.position.array, 3)
      for (const k in p.attrs) if (k !== 'position') base[k] = new THREE.BufferAttribute(p.attrs[k].array, p.attrs[k].itemSize)
      const nb = p.bones.length
      const boneU = nb ? {
        uIcBW: { value: p.bones.map((b) => b.W) },
        uIcBWi: { value: p.bones.map((b) => b.Wi) },
        uIcBA: { value: p.bones.map((b) => new THREE.Vector4(b.axis.x, b.axis.y, b.axis.z, b.art)) }
      } : null
      const mat = patchMaterial(p.mat, nb, na > 4 ? 8 : (na > 0 ? 4 : 0), U, g, boneU, envTex, o.envI)
      // pos / bones：链路箭头让图标轮廓要按此刻姿态投影部件（见 edgePx）
      return { base, nv: p.nv, index0: p.index, mat, raw: p.attrs, pos: p.attrs.position.array, bones: p.bones }
    })
    // 包围：mountInstance 的本体系外包盒与半径（与原逐颗画法同一个半径 —— 屏幕尺寸对得上）
    const bx = mount.box
    const extent = bx ? Math.max(bx.max[0] - bx.min[0], bx.max[1] - bx.min[1], bx.max[2] - bx.min[2]) : mount.radius * 2
    const level0 = makeLevel(g, parts, parts.map((p) => p.index0), na)
    return { parts, specs, bodyToModel, na, radius: mount.radius, extent: Math.max(1e-3, extent), level0, levelRoot: level0.root }
  }
  // 一档：每个部件一个网格（几何 = 共用顶点属性 + 本档索引 + 共用实例属性；材质各档共用）
  function makeLevel(g, parts, indices, na) {
    const root = new THREE.Group()
    root.matrixAutoUpdate = false
    const geos = []
    let tris = 0
    parts.forEach((p, i) => {
      const ix = indices[i]
      if (!ix || ix.length < 3) { geos.push(null); return }
      const arr = p.nv <= 65535 ? Uint16Array.from(ix) : (ix instanceof Uint32Array ? ix : Uint32Array.from(ix))
      const geo = levelGeo(g, p, new THREE.BufferAttribute(arr, 1), na)
      const mesh = new THREE.Mesh(geo, p.mat)
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false
      root.add(mesh)
      geos.push(geo)
      tris += ix.length / 3
    })
    return { root, geos, tris }
  }
  function levelGeo(g, p, index, na) {
    const geo = new THREE.InstancedBufferGeometry()
    for (const k in p.base) geo.setAttribute(k, p.base[k])
    geo.setIndex(index)
    attachInst(g, geo, na)
    return geo
  }
  function attachInst(g, geo, na) {
    geo.setAttribute('iPos', g.attrs.iPos); geo.setAttribute('iQuat', g.attrs.iQuat); geo.setAttribute('iMisc', g.attrs.iMisc)
    if (na > 0) geo.setAttribute('iArt0', g.attrs.iArt0)
    if (na > 4) geo.setAttribute('iArt1', g.attrs.iArt1)
    geo.instanceCount = g.n
    // ★ three 第一次绑实例属性时把「属性容量」记成 _maxInstanceCount，之后只在几何 dispose 时清 —— 扩容换了更大的属性不清它，
    //   超出旧容量的那些星就一颗也画不出来（WebGLBindingStates / WebGLRenderer.renderBufferDirect）
    delete geo._maxInstanceCount
  }
  function setCount(g) {
    for (const lv of g.levels) if (lv) for (const geo of lv.geos) if (geo) geo.instanceCount = g.n
  }
  // 只用于从没上过场景的模板（three 还没在它的几何上挂释放监听，dispose 不会碰到与现役模板共用的实例属性缓冲）
  function disposeBuilt(b) {
    if (!b) return
    for (const p of b.parts) p.mat.dispose()
    b.level0.geos.forEach((geo) => { if (geo) geo.dispose() })
  }
  function disposeTemplate(g) {
    for (const lv of g.levels) if (lv) { g.root.remove(lv.root); for (const geo of lv.geos) if (geo) geo.dispose() }
    for (const p of g.parts) p.mat.dispose()
    g.levels = []; g.parts = []; g.level = 0; g.lodReq++
    if (g.inst) { g.inst.release(); g.inst = null }
  }
  function disposeGroup(g) {
    g.req++
    disposeTemplate(g)
    if (g.root.parent) g.root.parent.remove(g.root)
    for (let i = 0; i < g.n; i++) { releaseGid(g.gid[i]); recs.delete(g.keys[i]) }
    g.n = 0
    groups.delete(g.key)
    const k = groupArr.indexOf(g); if (k >= 0) groupArr.splice(k, 1)
    maskDirty = true
  }

  // ---------------- 抽稀档（Worker） ----------------
  let lodWorker = null, lodSeq = 0
  const lodJobs = new Map()
  function lodRun(parts, errs) {
    if (typeof Worker === 'undefined') return Promise.resolve(null)
    try {
      if (!lodWorker) {
        lodWorker = new Worker(new URL('./iconLodWorker.js', import.meta.url), { type: 'module' })
        lodWorker.onmessage = (ev) => { const d = ev.data || {}; const j = lodJobs.get(d.id); if (!j) return; lodJobs.delete(d.id); j(d.ok ? d.levels : null) }
        lodWorker.onerror = () => { for (const j of lodJobs.values()) j(null); lodJobs.clear(); try { lodWorker.terminate() } catch { /* ignore */ } lodWorker = null }
      }
    } catch { return Promise.resolve(null) }
    const id = ++lodSeq
    const payload = parts.map((p) => ({ pos: p.raw.position.array.slice(), nrm: p.raw.normal ? p.raw.normal.array.slice() : null, idx: p.index0.slice() }))
    const tr = []
    for (const q of payload) { tr.push(q.pos.buffer, q.idx.buffer); if (q.nrm) tr.push(q.nrm.buffer) }
    return new Promise((res) => { lodJobs.set(id, res); lodWorker.postMessage({ id, parts: payload, errs }, tr) })
  }
  function requestLods(g) {
    const req = ++g.lodReq
    const errs = ICON_LOD_ERR.slice(1).map((e) => e * g.extent)
    const parts = g.parts
    lodRun(parts, errs).then((levels) => {
      if (disposed || !levels || req !== g.lodReq || g.parts !== parts) return
      levels.forEach((ixs, l) => {
        const lv = makeLevel(g, parts, ixs, g.na)
        lv.root.visible = false
        g.levels[l + 1] = lv.tris > 0 ? lv : null
        if (lv.tris > 0) { g.root.add(lv.root); if (o.gpuTrack) o.gpuTrack(lv.root) }
      })
      visDirty = true
    })
  }
  function switchLevel(g, k) {
    if (k === g.level || !g.levels[k]) return
    if (g.levels[g.level]) g.levels[g.level].root.visible = false
    g.levels[k].root.visible = true
    g.level = k
  }

  // ---------------- 实例 ----------------
  function addInst(g, key, alpha) {
    if (g.n >= g.cap) grow(g, g.n + 1)
    const i = g.n++
    g.keys[i] = key
    g.misc[i * 4 + 1] = alpha
    g.want[i] = 1
    g.prev.fill(NaN, i * ICON_MAX_ART, (i + 1) * ICON_MAX_ART)
    for (let k = 0; k < 4; k++) { g.art0[i * 4 + k] = 0; g.art1[i * 4 + k] = 0 }
    g.gid[i] = allocGid()
    g.emptySince = 0
    setCount(g)
    recs.set(key, { g, i })
    return i
  }
  // 摘掉第 i 颗（末尾那颗挪进来填洞）
  function removeInst(g, i, keepGid) {
    const key = g.keys[i]
    const last = g.n - 1
    if (!keepGid) releaseGid(g.gid[i])
    recs.delete(key)
    if (i !== last) {
      const cp = (a, k) => { for (let c = 0; c < k; c++) a[i * k + c] = a[last * k + c] }
      cp(g.pos, 3); cp(g.quat, 4); cp(g.misc, 4); cp(g.art0, 4); cp(g.art1, 4); cp(g.ecl, 1); cp(g.prev, ICON_MAX_ART)
      g.want[i] = g.want[last]; g.gid[i] = g.gid[last]
      const mk = g.keys[last]; g.keys[i] = mk
      const r = recs.get(mk); if (r) r.i = i
    }
    g.keys.length = last
    g.n = last
    setCount(g)
    maskDirty = true
  }
  function trackSunAt(g, i) {
    if (!g.na || !g.specs) return
    qRotInvTo(g.quat, i * 4, _sb, _sbB)
    for (let k = 0; k < g.na; k++) {
      const pi = i * ICON_MAX_ART + k
      const d = sunTrackDegFn(g.specs[k], _sbB, g.bodyToModel, g.prev[pi])
      if (Number.isFinite(d)) g.prev[pi] = d
      const v = Number.isFinite(g.prev[pi]) ? g.prev[pi] * DEG : 0
      if (k < 4) g.art0[i * 4 + k] = v; else g.art1[i * 4 + k - 4] = v
    }
  }
  let sunTrackDegFn = () => NaN

  // ---------------- 链路箭头让图标轮廓（scene 图上链路，见 edgePx） ----------------
  // 图上链路的端点（终点 / 跟随近场的起点）画着模型图标时，箭头尖停在图标【此刻屏上轮廓】沿这条线的外沿 —— 与 2D「箭头尖停在终点符号外沿」
  // 同一口径。原先让图标的包围圆（图标按包围半径定尺寸，带长杆 / 长太阳翼的星约等于半翼展）：链路只要不顺着翼展过来，箭头就停在星外一大截
  // （2026-10-08 用户实拍：3D 视图聚焦两颗星，星间链路）。
  // ★ 不取「沿链路射向星心、3D 撞上模型表面」那一点：图标那一趟画在链路之上，交点投到屏上常落在轮廓里面 —— 平板星（星链类）从侧下方来的链路
  //   撞在板面上离中心几厘米处，箭头整个被图标盖住（实测平板模板沿各方向的撞面深度中位数只有包围半径的 0.4%）。
  // 轮廓表：以图标中心的屏幕位置为原点，SIL_N 个方向（伪角均分，≈ 0.5°）上轮廓的最远覆盖半径（px）。几何取正在画的那一档（抽稀误差 ≤ 1 px），
  // 对日关节按该实例此刻的转角摆好，顶点按本帧相机透视投影（屏幕边上的拉伸照算）。按相机 + 视口 + 位姿 + 屏幕半径 + 转角 + 档位缓存在实例记录上：
  // 静止零开销；拖动 / 播放时一颗星一帧建一次表，挂在它上面的各条线只查表
  const SIL_N = 720
  const SIL_DX = new Float64Array(SIL_N), SIL_DY = new Float64Array(SIL_N)
  for (let k = 0; k < SIL_N; k++) {
    const d = (k + 0.5) * 4 / SIL_N
    const x = d < 2 ? 1 - d : d - 3, y = d < 1 ? d : (d < 3 ? 2 - d : d - 4)
    const l = Math.hypot(x, y)
    SIL_DX[k] = x / l; SIL_DY[k] = y / l
  }
  // 伪角（菱形角）：与真角同序、一圈 [0, 4)，免 atan2
  function dia(x, y) {
    if (y >= 0) return x >= 0 ? (x + y > 0 ? y / (x + y) : 0) : 1 - x / (y - x)
    return x < 0 ? 2 - y / (-x - y) : 3 + x / (x - y)
  }
  const wrap4 = (x) => x - 4 * Math.floor((x + 2) / 4)   // → [−2, 2)
  // 三角形 (a, b, c)（相对图标中心的屏幕坐标）在档 k0..k1（不绕回）上的出射距离：射线 t·u 与三条边的交点里最远的那个，比表里大才换。
  // rm = 三条边上的点离中心最远也就最远顶点那么远：表里已不小于它的档直接跳过（外先内后排过序，大多数内部三角形在这里就跳掉了）
  function silBins(tab, k0, k1, rm, ax, ay, bx, by, qx, qy) {
    for (let k = k0; k <= k1; k++) {
      let tm = tab[k]
      if (tm >= rm) continue
      const ux = SIL_DX[k], uy = SIL_DY[k]
      let ex = bx - ax, ey = by - ay, den = ux * ey - uy * ex
      if (den !== 0) { const t = (ax * ey - ay * ex) / den; if (t > tm) { const s = (ax * uy - ay * ux) / den; if (s >= 0 && s <= 1) tm = t } }
      ex = qx - bx; ey = qy - by; den = ux * ey - uy * ex
      if (den !== 0) { const t = (bx * ey - by * ex) / den; if (t > tm) { const s = (bx * uy - by * ux) / den; if (s >= 0 && s <= 1) tm = t } }
      ex = ax - qx; ey = ay - qy; den = ux * ey - uy * ex
      if (den !== 0) { const t = (qx * ey - qy * ex) / den; if (t > tm) { const s = (qx * uy - qy * ux) / den; if (s >= 0 && s <= 1) tm = t } }
      tab[k] = tm
    }
  }
  function artAt(g, i, k) { return k < 4 ? g.art0[i * 4 + k] : g.art1[i * 4 + k - 4] }
  let lastW = 1600
  const _vp = new THREE.Matrix4(), _wm = new THREE.Matrix4(), _bm = new THREE.Matrix4(), _am = new THREE.Matrix4(), _rm = new THREE.Matrix4(), _tm = new THREE.Matrix4()
  const _q4 = new THREE.Quaternion(), _p3 = new THREE.Vector3(), _s3 = new THREE.Vector3()
  const _sig = new Float64Array(16 + 2 + 2 + 3 + 4 + 2 + ICON_MAX_ART)
  const SIL_NB = 8   // 外先内后：按三角形最远顶点离中心的距离分几桶
  // 每帧建表预算（ms，update 里清零）：超了的星本帧沿用上一张表 —— 拖动 / 快放时轮廓最多慢一两帧，停下即准；
  // 一颗星全精度建一张约 1–2 ms（3–4 万面），屏上那一档通常已抽稀、更省
  const SIL_BUDGET_MS = 3
  let silSpent = 0
  const silCnt = new Int32Array(SIL_NB + 1)
  let silX = new Float64Array(0), silY = new Float64Array(0), silA = new Float64Array(0), silR = new Float64Array(0)
  let silRM = new Float64Array(0), silBK = new Uint8Array(0), silORD = new Int32Array(0), silIn = new Int32Array(0)
  // 正在画的那一档：各部件的索引拼成一张全局三角形表（顶点按部件先后偏移）。拓扑不随视角变，按组 × 档缓存
  function silTris(g, lv) {
    if (!g._silTri || g._silTri.parts !== g.parts) g._silTri = { parts: g.parts, byLv: new Map() }
    let c = g._silTri.byLv.get(lv)
    if (c) return c
    let nv = 0, ni = 0
    for (let pk = 0; pk < g.parts.length; pk++) {
      nv += (g.parts[pk].pos.length / 3) | 0
      const geo = lv.geos[pk]
      if (geo && geo.index) ni += geo.index.count - (geo.index.count % 3)
    }
    const tri = new Int32Array(ni), base = new Int32Array(g.parts.length)
    let off = 0, o = 0
    for (let pk = 0; pk < g.parts.length; pk++) {
      base[pk] = off
      const geo = lv.geos[pk]
      if (geo && geo.index) { const I = geo.index.array, n = geo.index.count - (geo.index.count % 3); for (let t = 0; t < n; t++) tri[o++] = off + I[t] }
      off += (g.parts[pk].pos.length / 3) | 0
    }
    c = { tri, base, nv, nt: ni / 3 }
    g._silTri.byLv.set(lv, c)
    return c
  }
  // 第 i 颗的轮廓表（sx0, sy0：图标中心的屏幕位置；_vp 已是本帧的相机 → 裁剪矩阵）
  function buildSil(g, i, pxR, W, H, sx0, sy0, tab) {
    tab.fill(0)
    const lv = g.levels[g.level] || g.levels[0]
    if (!lv) return
    const T = silTris(g, lv)
    if (silX.length < T.nv) { const c = Math.ceil(T.nv * 1.5); silX = new Float64Array(c); silY = new Float64Array(c); silA = new Float64Array(c); silR = new Float64Array(c) }
    if (silRM.length < T.nt) { const c = Math.ceil(T.nt * 1.5); silRM = new Float64Array(c); silBK = new Uint8Array(c); silORD = new Int32Array(c); silIn = new Int32Array(c) }
    const cam = lastCam
    const cx = g.pos[i * 3], cy = g.pos[i * 3 + 1], cz = g.pos[i * 3 + 2]
    const D = Math.hypot(cx - cam.position.x, cy - cam.position.y, cz - cam.position.z)
    // 本体 → 场景：锚点 + 世界缩放 k0 × 姿态（与图标着色器 icK0 同式）；再乘相机 → 裁剪空间
    const k0 = pxR * D * (2 * Math.tan(cam.fov * Math.PI / 360) / Math.max(1, H)) / g.radius
    _q4.set(g.quat[i * 4], g.quat[i * 4 + 1], g.quat[i * 4 + 2], g.quat[i * 4 + 3])
    _wm.compose(_p3.set(cx, cy, cz), _q4, _s3.set(k0, k0, k0))
    _bm.multiplyMatrices(_vp, _wm)
    // ① 顶点投到屏上（相对图标中心，px）：位置 / 伪角 / 离中心距离
    for (let pk = 0; pk < g.parts.length; pk++) {
      const p = g.parts[pk]
      let M = _bm
      if (p.bones && p.bones.length) {
        // 对日关节：部件静止系 → 本体 = Π W·R(θ)·W⁻¹（由内到外，与 iconVertexMirror / 着色器同式）
        _am.identity()
        for (const b of p.bones) { _rm.makeRotationAxis(b.axis, artAt(g, i, b.art) || 0); _am.premultiply(_tm.multiplyMatrices(b.W, _rm).multiply(b.Wi)) }
        _am.premultiply(_bm)
        M = _am
      }
      const P = p.pos, nv = (P.length / 3) | 0, o = T.base[pk]
      const a = M.elements
      for (let v = 0; v < nv; v++) {
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2]
        const w = a[3] * x + a[7] * y + a[11] * z + a[15]
        if (!(w > 0)) { silX[o + v] = NaN; silR[o + v] = 0; continue }   // 相机背后
        const sx = ((a[0] * x + a[4] * y + a[8] * z + a[12]) / w * 0.5 + 0.5) * W - sx0
        const sy = ((a[1] * x + a[5] * y + a[9] * z + a[13]) / w * 0.5 + 0.5) * H - sy0
        silX[o + v] = sx; silY[o + v] = sy; silA[o + v] = dia(sx, sy); silR[o + v] = Math.sqrt(sx * sx + sy * sy)
      }
    }
    // ② 外先内后：按三角形最远顶点离中心的距离计数排序（外圈的先把表撑起来，内部的大多在 silBins 开头就跳掉）
    const tri = T.tri, nt = T.nt
    let rmax = 0
    for (let t = 0; t < nt; t++) {
      const j = t * 3
      let r = silR[tri[j]]
      const r2 = silR[tri[j + 1]], r3 = silR[tri[j + 2]]
      if (r2 > r) r = r2
      if (r3 > r) r = r3
      silRM[t] = r
      if (r > rmax) rmax = r
    }
    silCnt.fill(0)
    const sc = rmax > 0 ? SIL_NB / rmax : 0
    for (let t = 0; t < nt; t++) { const b = Math.min(SIL_NB - 1, ((rmax - silRM[t]) * sc) | 0); silBK[t] = b; silCnt[b + 1]++ }
    for (let b = 0; b < SIL_NB; b++) silCnt[b + 1] += silCnt[b]
    for (let t = 0; t < nt; t++) silORD[silCnt[silBK[t]]++] = t
    // ③ 逐个三角形：覆盖的方向是它张的角（< 180°）里的各档；原点落在三角形里的（一整圈）先记下、最后做
    let nIn = 0
    for (let q = 0; q < nt; q++) {
      const t = silORD[q], j = t * 3, ia = tri[j], ib = tri[j + 1], ic = tri[j + 2]
      const ax = silX[ia], bx = silX[ib], qx = silX[ic]
      if (ax !== ax || bx !== bx || qx !== qx) continue
      const ay = silY[ia], by = silY[ib], qy = silY[ic]
      const area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax)
      if (area === 0) continue
      const s1 = ax * by - ay * bx, s2 = bx * qy - by * qx, s3 = qx * ay - qy * ax
      if (area > 0 ? (s1 >= 0 && s2 >= 0 && s3 >= 0) : (s1 <= 0 && s2 <= 0 && s3 <= 0)) { silIn[nIn++] = t; continue }
      const pa = silA[ia], db = wrap4(silA[ib] - pa), dc = wrap4(silA[ic] - pa)
      let k0 = Math.ceil((pa + Math.min(0, db, dc)) * SIL_N / 4 - 0.5), k1 = Math.floor((pa + Math.max(0, db, dc)) * SIL_N / 4 - 0.5)
      if (k1 < k0) continue
      const rm = silRM[t]
      if (k0 < 0) { silBins(tab, k0 + SIL_N, SIL_N - 1, rm, ax, ay, bx, by, qx, qy); k0 = 0 }
      if (k1 >= SIL_N) { silBins(tab, 0, k1 - SIL_N, rm, ax, ay, bx, by, qx, qy); k1 = SIL_N - 1 }
      silBins(tab, k0, k1, rm, ax, ay, bx, by, qx, qy)
    }
    // ④ 含原点的：一整圈。外沿已经都不小于它的最远顶点就整片跳过
    let tmin = Infinity
    for (let k = 0; k < SIL_N; k++) if (tab[k] < tmin) tmin = tab[k]
    for (let n2 = 0; n2 < nIn; n2++) {
      const t = silIn[n2]
      if (silRM[t] <= tmin) continue
      const j = t * 3, ia = tri[j], ib = tri[j + 1], ic = tri[j + 2]
      silBins(tab, 0, SIL_N - 1, silRM[t], silX[ia], silY[ia], silX[ib], silY[ib], silX[ic], silY[ic])
    }
  }
  /**
   * 图上链路的端点画着这颗星的模型图标：沿这条线（other：链路另一端，场景坐标）从图标中心往外，图标此刻屏上轮廓的外沿离中心多少 px。
   * 图标没在画（没就绪 / 不在表里正淡出 / 太小画成点 / 在相机背后 / 本帧还没有相机）→ −1。须在本帧 update 之后问（相机、缩放系数取本帧的）
   */
  function edgePx(key, other) {
    const r = recs.get(key)
    if (!r || !other || !lastCam) return -1
    const g = r.g, i = r.i
    if (g.state !== 'ready' || !g.want[i] || !(g.radius > 0)) return -1
    const pxR = g.misc[i * 4] * zk * 0.5
    if (!(g.misc[i * 4 + 1] > 0.01) || !(pxR > 1.2)) return -1
    const cam = lastCam, W = lastW, H = lastH
    cam.updateMatrixWorld()
    _vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    const e = _vp.elements
    const cx = g.pos[i * 3], cy = g.pos[i * 3 + 1], cz = g.pos[i * 3 + 2]
    const cw = e[3] * cx + e[7] * cy + e[11] * cz + e[15]
    if (!(cw > 0)) return -1
    const sx0 = ((e[0] * cx + e[4] * cy + e[8] * cz + e[12]) / cw * 0.5 + 0.5) * W
    const sy0 = ((e[1] * cx + e[5] * cy + e[9] * cz + e[13]) / cw * 0.5 + 0.5) * H
    // 线在屏上的方向：取线上离图标很近、必在相机前面的一点（3D 直线投到屏上仍是直线，方向与取哪一点无关）
    const ox = other.x - cx, oy = other.y - cy, oz = other.z - cz
    const ol = Math.hypot(ox, oy, oz)
    if (!(ol > 0)) return -1
    const f = Math.min(1, 0.02 * Math.hypot(cx - cam.position.x, cy - cam.position.y, cz - cam.position.z) / ol)
    const px = cx + ox * f, py = cy + oy * f, pz = cz + oz * f
    const pw = e[3] * px + e[7] * py + e[11] * pz + e[15]
    if (!(pw > 0)) return -1
    const dx = ((e[0] * px + e[4] * py + e[8] * pz + e[12]) / pw * 0.5 + 0.5) * W - sx0
    const dy = ((e[1] * px + e[5] * py + e[9] * pz + e[13]) / pw * 0.5 + 0.5) * H - sy0
    if (dx === 0 && dy === 0) return 0
    // 轮廓表：相机 / 视口 / 位姿 / 屏幕半径 / 档位 / 对日转角都没变就复用
    const s = _sig
    const me = cam.matrixWorld.elements, pe = cam.projectionMatrix.elements
    for (let k = 0; k < 16; k++) s[k] = me[k]
    s[16] = pe[0]; s[17] = pe[5]; s[18] = W; s[19] = H
    s[20] = cx; s[21] = cy; s[22] = cz
    for (let k = 0; k < 4; k++) s[23 + k] = g.quat[i * 4 + k]
    s[27] = pxR; s[28] = g.level
    for (let k = 0; k < ICON_MAX_ART; k++) s[29 + k] = k < g.na ? artAt(g, i, k) : 0
    let c = r.sil
    if (!c) c = r.sil = { sig: new Float64Array(s.length).fill(NaN), tab: new Float32Array(SIL_N), parts: null }
    let same = c.parts === g.parts
    if (same) for (let k = 0; k < s.length; k++) if (c.sig[k] !== s[k]) { same = false; break }
    // 本帧预算用完、手上又有这颗星（同一模板）的上一张表：先沿用，签名不动 —— 下一帧接着重建
    if (!same && !(silSpent > SIL_BUDGET_MS && c.parts === g.parts)) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
      c.sig.set(s); c.parts = g.parts
      buildSil(g, i, pxR, W, H, sx0, sy0, c.tab)
      silSpent += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    }
    // 查表：取线方向两侧最近的两档里大的那个（宁可停在轮廓外一点，不扎进图标底下）
    const fb = dia(dx, dy) * SIL_N / 4 - 0.5
    const k0 = ((Math.floor(fb) % SIL_N) + SIL_N) % SIL_N
    return Math.max(c.tab[k0], c.tab[(k0 + 1) % SIL_N])
  }

  let tick = 0
  /**
   * 每拍：聚焦星的图标状态（同 modelLayer.setIcons 的入参）。不在表里的淡出后摘掉。
   * @param {object[]} list
   */
  function set(list) {
    tick++
    _sb.x = sunS.x; _sb.y = sunS.y; _sb.z = sunS.z
    const seen = tick
    const arr = Array.isArray(list) ? list : []
    for (let n = 0; n < arr.length; n++) {
      const it = arr[n]
      if (!it || !it.key || !it.modelId || !it.anchor || !it.qL2S) continue
      const gk = it.modelId + '#' + o.frameSig(it.frame || null)
      let g = groups.get(gk)
      if (!g) g = newGroup(gk, it.modelId, it.frame || null)
      let r = recs.get(it.key)
      if (r && r.g !== g) {
        // 换了模型 / 轴覆盖：从旧组摘下（立刻，不淡出 —— 与原逐颗画法「换模型先撤旧实例」同）；新组已就绪就接着当前透明度画
        const a = r.g.misc[r.i * 4 + 1]
        const gid = r.g.gid[r.i]
        removeInst(r.g, r.i, true)
        const i = addInst(g, it.key, g.state === 'ready' ? a : 0)
        releaseGid(g.gid[i]); g.gid[i] = gid
        r = recs.get(it.key)
        g.fading = true
      } else if (!r) {
        addInst(g, it.key, 0)
        r = recs.get(it.key)
        g.fading = true
      }
      const i = r.i
      if (!g.want[i]) { g.want[i] = 1; g.fading = true }
      g.keys[i] = it.key
      const a = it.anchor
      g.pos[i * 3] = a[0]; g.pos[i * 3 + 1] = a[1]; g.pos[i * 3 + 2] = a[2]
      const qb = it.qB2L || null
      if (qb) qMulTo(it.qL2S, qb, g.quat, i * 4)
      else { g.quat[i * 4] = it.qL2S[0]; g.quat[i * 4 + 1] = it.qL2S[1]; g.quat[i * 4 + 2] = it.qL2S[2]; g.quat[i * 4 + 3] = it.qL2S[3] }
      g.misc[i * 4] = Number(it.px) > 0 ? Number(it.px) : defaultPx
      const e = Number.isFinite(it.eclipse) ? it.eclipse : 1
      g.ecl[i] = e
      g.misc[i * 4 + 2] = sunLit ? Math.round(e * 50) / 50 : 1
      trackSunAt(g, i)
      g._seen = seen
      r.seen = seen
    }
    // 不在表里的：淡出（透明度到 0 时在 update 里摘掉）
    for (let k = 0; k < groupArr.length; k++) {
      const g = groupArr[k]
      let mx = 0
      for (let i = 0; i < g.n; i++) {
        const r = recs.get(g.keys[i])
        if (!r || r.seen !== seen) { if (g.want[i]) { g.want[i] = 0; g.fading = true } }
        if (g.misc[i * 4] > mx) mx = g.misc[i * 4]
      }
      g.maxPx = mx
      markInst(g)
    }
    maskDirty = true; instDirty = true; visDirty = true
  }

  // ---------------- 点精灵遮罩 ----------------
  let maskDirty = false, instDirty = false
  let maskRes = null, maskTex = null, instTex = null, instArr = null, instCap = 0
  let mxyz = new Float32Array(0), mgid = new Int32Array(0)
  let extra = [], extraGid = []
  function setMaskExtra(list) {
    for (const g of extraGid) releaseGid(g)
    extra = Array.isArray(list) ? list.filter((p) => Array.isArray(p) && p.length >= 3) : []
    extraGid = extra.map(() => allocGid())
    maskDirty = true; instDirty = true
  }
  function maskCount() { let n = extra.length; for (let k = 0; k < groupArr.length; k++) n += groupArr[k].n; return n }
  function rebuildMask() {
    const n = maskCount()
    if (mxyz.length < n * 3) { mxyz = new Float32Array(Math.max(64, n * 2) * 3); mgid = new Int32Array(Math.max(64, n * 2)) }
    let m = 0
    for (let k = 0; k < groupArr.length; k++) {
      const g = groupArr[k]
      for (let i = 0; i < g.n; i++) { mxyz[m * 3] = g.pos[i * 3]; mxyz[m * 3 + 1] = g.pos[i * 3 + 1]; mxyz[m * 3 + 2] = g.pos[i * 3 + 2]; mgid[m] = g.gid[i]; m++ }
    }
    for (let j = 0; j < extra.length; j++) { mxyz[m * 3] = extra[j][0]; mxyz[m * 3 + 1] = extra[j][1]; mxyz[m * 3 + 2] = extra[j][2]; mgid[m] = extraGid[j]; m++ }
    const prev = maskRes
    maskRes = buildDotMaskTable(mxyz, mgid, m, prev)
    if (!maskTex || maskTex.image.data !== maskRes.tab) {
      if (maskTex) maskTex.dispose()
      maskTex = dataTex(maskRes.tab, maskRes.w, maskRes.h)
    } else maskTex.needsUpdate = true
  }
  function fillInst() {
    let cap = 64
    while (cap < gidTop) cap *= 2
    if (cap !== instCap) {
      instCap = cap
      instArr = new Float32Array(cap * 4)
      if (instTex) instTex.dispose()
      const w = Math.min(cap, 1024)
      instTex = dataTex(instArr, w, cap / w)
    }
    instArr.fill(0)
    for (let k = 0; k < groupArr.length; k++) {
      const g = groupArr[k]
      for (let i = 0; i < g.n; i++) { const d = g.gid[i] * 4; instArr[d] = g.misc[i * 4 + 1]; instArr[d + 1] = g.misc[i * 4] }
    }
    for (const gd of extraGid) instArr[gd * 4 + 2] = 1
    instTex.needsUpdate = true
  }
  function dataTex(arr, w, h) {
    const t = new THREE.DataTexture(arr, w, h, THREE.RGBAFormat, THREE.FloatType)
    t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false
    t.needsUpdate = true
    return t
  }
  const maskOut = { tab: null, inst: null, bits: -1, twb: 0, iwb: 0, zk: 1 }

  // ---------------- 逐帧 ----------------
  /**
   * @param {number} dt 秒
   * @param {THREE.PerspectiveCamera} camera 地球相机
   * @param {number} h 画布 CSS 高
   * @param {boolean} gate 图标总闸（开关开着、不是软件光栅；跟随中照开 —— 主星与邻星页面本就不给）
   * @returns {boolean} 还在淡入淡出（要继续出帧）
   */
  function update(dt, camera, h, gate) {
    if (disposed) return false
    lastCam = camera
    silSpent = 0   // 链路箭头让图标轮廓：每帧建表预算（见 edgePx）
    camPos.copy(camera.position)
    zk = zkFixed != null ? zkFixed : pointZoomK(camPos.length())
    U.uIcZk.value = zk
    U.uIcWpp.value = 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, h)
    if (gate !== lastGate) { lastGate = gate; for (let k = 0; k < groupArr.length; k++) groupArr[k].fading = true }
    let busy = false
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    for (let k = groupArr.length - 1; k >= 0; k--) {
      const g = groupArr[k]
      if (g.fading) {
        const ok = gate && g.state === 'ready'
        const st = dt > 0 ? dt / FADE_S : 0
        let still = false, changed = false, moved = false, mx = 0
        for (let i = g.n - 1; i >= 0; i--) {
          const target = g.want[i] && ok ? 1 : 0
          let a = g.misc[i * 4 + 1]
          if (a !== target) {
            a = target > a ? Math.min(target, a + st) : Math.max(target, a - st)
            g.misc[i * 4 + 1] = a
            changed = true
            if (a !== target) still = true
          }
          if (!g.want[i] && a <= 0) { removeInst(g, i); moved = true; continue }
          if (a > mx) mx = a
        }
        g.alphaMax = mx
        // 摘过实例＝末尾那颗挪进了空出的槽（removeInst 只挪 CPU 数组），位姿 / 对日角也得整份重传。只传 iMisc 的话
        // GPU 那一格还是被摘那颗的位姿 —— 同模型换聚焦星，新星的模型画在刚取消的那颗星上，等下一拍 set() 才归位（时钟停着就一直错）
        if (moved) markInst(g)
        else if (changed) markAll(g, 'iMisc', 4)
        if (changed || moved) instDirty = true
        g.fading = still
        if (still) busy = true
      }
      // 空组：留一阵再拆（同一批星再勾回来不必重烘）
      if (g.n === 0) {
        if (!g.emptySince) g.emptySince = now
        else if (now - g.emptySince > EMPTY_KEEP_MS) disposeGroup(g)
      }
    }
    // 在画颗数与抽稀档：相机动了 / 数据变了，且离上次至少 100 ms
    if (!camMatSame(camera)) visDirty = true
    if (visDirty && (lodForce || now - visT >= VIS_EVERY_MS)) { visT = now; visDirty = false; lodForce = false; countVisible(camera, gate); chooseLevels() }
    else if (visDirty) busy = true   // 欠着一次选档：下一帧接着出
    if (maskDirty) { maskDirty = false; rebuildMask(); instDirty = true }
    if (instDirty) { instDirty = false; fillInst() }
    maskOut.tab = maskTex; maskOut.inst = instTex
    maskOut.bits = maskRes && maskCount() ? maskRes.bits : -1
    maskOut.twb = maskRes ? maskRes.twBits : 0
    maskOut.iwb = Math.log2(Math.min(instCap || 64, 1024)) | 0
    maskOut.zk = zk
    return busy
  }
  function camMatSame(camera) {
    const e = camera.matrixWorld.elements, p = camera.projectionMatrix.elements
    let same = true
    for (let i = 0; i < 16; i++) { if (camMat[i] !== e[i]) { same = false; camMat[i] = e[i] } }
    if (camMat[16] !== p[0] || camMat[17] !== p[5]) { same = false; camMat[16] = p[0]; camMat[17] = p[5] }
    return same
  }
  const _vm = new THREE.Matrix4(), _cp = new THREE.Vector4()
  function countVisible(camera, gate) {
    camera.updateMatrixWorld()
    _vm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const tanH = Math.tan(camera.fov * Math.PI / 360)
    const P0 = camera.projectionMatrix.elements[0], P5 = camera.projectionMatrix.elements[5]
    for (let k = 0; k < groupArr.length; k++) {
      const g = groupArr[k]
      let n = 0
      if (gate && g.state === 'ready') {
        for (let i = 0; i < g.n; i++) {
          if (!(g.misc[i * 4 + 1] > 0.002)) continue
          const pxR = g.misc[i * 4] * zk * 0.5
          if (pxR <= 1.2) continue
          const x = g.pos[i * 3], y = g.pos[i * 3 + 1], z = g.pos[i * 3 + 2]
          const D = Math.hypot(x - camPos.x, y - camPos.y, z - camPos.z)
          const rw0 = pxR * D * 2 * tanH / Math.max(1, lastH)
          if (hiddenAt(camPos, x, y, z, rw0)) continue
          _cp.set(x, y, z, 1).applyMatrix4(_vm)
          const rw = rw0 * CULL_MARGIN
          if (_cp.w <= 0 || Math.abs(_cp.x) > _cp.w + rw * P0 || Math.abs(_cp.y) > _cp.w + rw * P5) continue
          n++
        }
      }
      g.visN = n
    }
  }
  // 选档：像素误差 ≤ 1 px 的最粗一档（没出来的档往细里找）；再按在画颗数 × 三角形总预算逐组往粗里退。
  // 误差按【输出像素】量：屏上 lodScale = 1（CSS px）；4× 出图 / 视频超采样时乘上渲染倍率 —— 否则沿用屏上那一档放大出图，
  // 折面、被 Prune 掉的小部件跟着放大 4 倍（星链 V2 Mini 只剩 754 / 15726 个三角形）
  function chooseLevels() {
    let total = 0
    for (let k = 0; k < groupArr.length; k++) {
      const g = groupArr[k]
      if (g.state !== 'ready' || !g.levels[0]) continue
      let lv = iconLodLevel(g.extent, g.radius, g.maxPx * zk * 0.5, lodScale)
      while (lv > 0 && !g.levels[lv]) lv--
      g._want = lv
      total += g.visN * g.levels[lv].tris
    }
    while (total > ICON_TRI_BUDGET) {
      let best = null, bv = 0, bn = -1
      for (let k = 0; k < groupArr.length; k++) {
        const g = groupArr[k]
        if (g.state !== 'ready' || !g.levels[0] || !g.visN) continue
        let n2 = g._want + 1
        while (n2 < g.levels.length && !g.levels[n2]) n2++
        if (n2 >= g.levels.length) continue
        const v = g.visN * g.levels[g._want].tris
        if (v > bv) { bv = v; best = g; bn = n2 }
      }
      if (!best) break
      total -= best.visN * (best.levels[best._want].tris - best.levels[bn].tris)
      best._want = bn
    }
    for (let k = 0; k < groupArr.length; k++) { const g = groupArr[k]; if (g.state === 'ready' && g.levels[0]) switchLevel(g, g._want) }
  }
  let lastH = 900

  return {
    set,
    update(dt, camera, w, h, gate) { lastH = h || lastH; lastW = w || lastW; return update(dt, camera, h, gate) },
    /** 图上链路箭头让图标轮廓：沿线（other = 链路另一端，场景坐标）的轮廓外沿离图标中心多少 px；没在画 → −1（见 edgePx） */
    edgePx,
    /** 单测用（只读）：这颗星的图标此刻的部件 / 对日转角 / 位姿 / 包围半径 / 屏幕半径 / 档位 | null */
    _edgeState(key) {
      const r = recs.get(key)
      if (!r || r.g.state !== 'ready') return null
      const g = r.g, i = r.i
      return { parts: g.parts, angles: Array.from({ length: g.na }, (_, k) => artAt(g, i, k)), quat: Array.from(g.quat.subarray(i * 4, i * 4 + 4)),
        pos: Array.from(g.pos.subarray(i * 3, i * 3 + 3)), radius: g.radius, pxR: g.misc[i * 4] * zk * 0.5, level: g.level, alpha: g.misc[i * 4 + 1] }
    },
    /** 有没有要画的（某组就绪且有透明度 > 0 的实例） */
    drawable() { for (let k = 0; k < groupArr.length; k++) { const g = groupArr[k]; if (g.state === 'ready' && g.n && g.alphaMax > 0) return true } return false },
    count: () => recs.size,
    setSun(v) { if (v) { sunS.set(v[0] ?? v.x, v[1] ?? v.y, v[2] ?? v.z).normalize() } },
    setSunTrackFn(fn) { sunTrackDegFn = fn },
    setDefaultPx(px) { if (Number(px) > 0) defaultPx = Number(px) },
    /**
     * 缩放联动系数定值（null = 恢复按相机离地心距离 pointZoomK）。跟随卫星时相机贴着主星、离地心只有 1.0x 个地球半径，
     * 照原式算图标放大 3 倍：模型层在跟随期间给跟随档（与星点 / 在轨点 scene.zoomDist 同一把尺）
     */
    setZoomK(k) {
      const v = Number.isFinite(k) && k > 0 ? k : null
      if (v === zkFixed) return
      zkFixed = v; visDirty = true; lodForce = true
    },
    /**
     * 出图 / 视频出帧的像素倍率（输出像素 / CSS 像素，< 1 按 1）：抽稀档按输出像素误差 ≤ 1 px 选（误差门限除以倍率）。
     * 每次调用都让下一次 update 当场重选档位（不等 100 ms 节流：出图只渲一帧、视频逐帧换机位）；出完调回 1
     */
    setLodScale(s) {
      lodScale = Number(s) > 1 ? Number(s) : 1
      visDirty = true; lodForce = true
    },
    lodScale: () => lodScale,
    /** 晨昏效果开关：地影因子口径换了，各实例的 iMisc.z 重写 */
    setSunLit(on) {
      on = !!on
      if (on === sunLit) return
      sunLit = on
      for (const g of groupArr) { for (let i = 0; i < g.n; i++) g.misc[i * 4 + 2] = sunLit ? Math.round(g.ecl[i] * 50) / 50 : 1; markAll(g, 'iMisc', 4) }
    },
    setMaskExtra,
    /** 点精灵遮罩要不要开（有实例或有整颗藏的邻星） */
    maskWanted: () => recs.size > 0 || extra.length > 0,
    dotMask: () => maskOut,
    /** 元数据刷新：该模型（缺省全部）的组原位重挂（旧模板照画到新的就绪，透明度不重来） */
    refreshModel(id) { for (const g of groupArr) if (!id || g.modelId === id) loadGroup(g) },
    /** 某个模型刚下载好：没有模型可画的组重取 */
    onModelReady(id) { for (const g of groupArr) if (g.modelId === id && g.state === 'none') loadGroup(g) },
    /** 软件光栅（真 / 模拟）：撤掉全部模板，回到点精灵；撤销模拟时重取 */
    setWeak(on) {
      for (const g of groupArr) {
        if (on) { g.req++; disposeTemplate(g); if (g.root.parent) g.root.parent.remove(g.root); g.state = 'weak'; g.fading = true }
        else if (g.state === 'weak') loadGroup(g)
      }
    },
    stats() {
      let vis = 0, draws = 0, tris = 0
      const px = [], lv = []
      const C = lastCam ? lastCam.position : null
      const wpp = lastCam ? 2 * Math.tan(lastCam.fov * Math.PI / 360) / Math.max(1, lastH) : 0
      for (const g of groupArr) {
        const L = g.levels[g.level]
        if (g.state === 'ready' && L && g.n) { draws += L.geos.filter(Boolean).length; tris += L.tris * g.n }
        lv.push({ model: g.modelId, n: g.n, state: g.state, level: g.level, levels: g.levels.map((x) => (x ? x.tris : 0)), visN: g.visN })
        if (!C || g.state !== 'ready') continue
        for (let i = 0; i < g.n; i++) {
          const a = g.misc[i * 4 + 1], pxR = g.misc[i * 4] * zk * 0.5
          if (!(a > 0.002) || !(pxR > 1.2)) continue
          const x = g.pos[i * 3], y = g.pos[i * 3 + 1], z = g.pos[i * 3 + 2]
          if (hiddenAt(C, x, y, z, pxR * Math.hypot(x - C.x, y - C.y, z - C.z) * wpp)) continue
          vis++
          px.push([g.keys[i], +(2 * pxR).toFixed(2)])
        }
      }
      return { icons: recs.size, iconsVisible: vis, iconsPx: px, iconGroups: groupArr.length, iconDraws: draws, iconTris: tris, iconLevels: lv }
    },
    dispose() {
      if (disposed) return
      for (const g of groupArr.slice()) disposeGroup(g)
      disposed = true
      if (lodWorker) { try { lodWorker.terminate() } catch { /* ignore */ } lodWorker = null }
      for (const j of lodJobs.values()) j(null)
      lodJobs.clear()
      if (maskTex) maskTex.dispose()
      if (instTex) instTex.dispose()
      maskTex = null; instTex = null
    }
  }
}

export const __test = { occludedAt, boardAt, hiddenAt, earthOccludes, qMulTo, qRotInvTo, CULL_MARGIN }
