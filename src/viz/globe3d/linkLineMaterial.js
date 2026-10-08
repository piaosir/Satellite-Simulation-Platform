// 图上链路专用线材质（3D，scene.setLinks 用；2D 同口径画法在 flatmap/flatCoverage.js 的 drawLinkArrow / drawLinkDashes）。
//
// 一个 draw call 画完一批跳的三样东西：
//   ① 线芯：屏幕像素宽的粗线（同 three LineMaterial 的非世界单位口径：两端在裁剪空间投影、按屏幕像素外扩成四边形，近平面裁切
//      一字照搬 trimSegment），圆头、1 px 抗锯齿；不可见的跳（uDash）画屏幕像素虚线（6 on / 5 off，缩放不变）。
//   ② 末端单箭头（2026-10-08 三轮定稿，取代沿线等距 V 标）：每跳一枚实心箭头，尖停在终点符号外沿 uGap 处
//      （专业流向图口径：箭头在线端、按线宽定尺寸、不压节点 —— Jenny 等 2018）；尾部微凹（uNotch）、1 px 深色衬边。
//      终点符号按实例属性 instanceTip 给的圆算（圆心在终点上方 x px、半径 y px，z = 随缩放联动，w = 画不画这枚），
//      从终点沿线往回、走出这个圆的那一点就是箭头尖（顶点里解一元二次，结果走 flat varying）。
//   ③ 流动（uFlow）：箭头不动，线身淡底（uFlowBase）+ 沿信号方向匀速走的虚线（uDashOn / uDashP，uOff = 时间 × 速度按周期取模），
//      虚线画到箭头尾凹处为止 —— draw.io「Flow animation」/ React Flow animated edge 的口径。淡底让线照样连续，与不可见跳的断开虚线分得开。
//   一切尺寸按屏幕 CSS 像素：沿线 / 横向坐标在顶点里按屏幕算好、片元里做【屏幕线性】插值 ——
//   直接给 varying 会被透视校正插值弄弯（两端深度差几万 km，虚线会一头密一头疏），故顶点输出 值 × w 与 w，片元相除还原。
//
// instanceTip.z（终点符号圆的尺寸口径）：0 屏幕恒定 / 1 × uZoomK（标记精灵的缩放联动）/ 2 × uIconK（卫星模型图标的缩放联动，
//   终点星画着模型图标时圆 = 图标的包围圆）/ 3 屏幕恒定（跟随视图里终点是主星本体：模型层先把端点挪到本体外包盒上，见 modelLayer）。
//
// 跟随视图（2026-10-08）：以主星为端点的跳整跳交模型层局部那一趟画（见 scene.js followA 那段），另开两样：
//   cut  线芯停在终点符号外沿（局部那一趟画在一切地球层之后，终点的圆点 / 图标 / 站符号压不住线头）；
//   occ  逐片元地球遮挡（LINK_OCC：局部那一趟没有地球的深度）—— 由屏幕线性参数反推线段上的视空间点（透视），
//        相机 → 该点的线段先穿过地球球面（uOcc = 视空间球心 + 半径）就丢弃。
//
// 宿主：mesh 用 LineSegments2（它的 onBeforeRender 每帧按视口回填 resolution）+ LineSegmentsGeometry.setPositions，
//   再挂一条 InstancedBufferAttribute 'instanceTip'（每段 4 个数，见上）；材质的 .resolution 指向同一个 Vector2
//   （scene 的 regMat / lineMats 照常管它）。uZoomK / uIconK（缩放联动系数）与 uOff 由宿主每帧回填；uOcc 由模型层每帧回填。
import * as THREE from 'three'

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

uniform vec2 resolution;
uniform float uHalf;
uniform float uArrow;
uniform float uArrowL;
uniform float uGap;
uniform float uZoomK;
uniform float uIconK;
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute vec4 instanceTip;
varying float vAW;
varying float vCW;
varying float vWw;
flat varying float vLen;
flat varying float vTip;
flat varying float vEdge;
#ifdef LINK_OCC
attribute vec4 instanceTip0;
uniform vec4 uOcc;
flat varying vec3 vP0;
flat varying vec3 vP1;
flat varying vec2 vPw;
flat varying float vStart;
// 相机（视空间原点）→ P 的线段先穿过地球球面（uOcc：视空间球心 + 半径）
bool linkOccluded( vec3 P ) {
  float pl = length( P );
  if ( pl <= 0.0 ) return false;
  float b = dot( P / pl, uOcc.xyz );
  float c0 = length( uOcc.xyz );
  float disc = b * b - ( c0 - uOcc.w ) * ( c0 + uOcc.w );
  if ( disc <= 0.0 ) return false;
  float s1 = b - sqrt( disc );
  return s1 > 0.0 && s1 < pl;
}
#endif

void trimSegment( const in vec4 start, inout vec4 end ) {
  float a = projectionMatrix[ 2 ][ 2 ];
  float b = projectionMatrix[ 3 ][ 2 ];
  float nearEstimate = - 0.5 * b / a;
  float alpha = ( nearEstimate - start.z ) / ( end.z - start.z );
  end.xyz = mix( start.xyz, end.xyz, alpha );
}

void main() {
  vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
  vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
  bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 );
  bool endCut = false, startCut = false;
  if ( perspective ) {
    if ( start.z < 0.0 && end.z >= 0.0 ) { trimSegment( start, end ); endCut = true; }
    else if ( end.z < 0.0 && start.z >= 0.0 ) { trimSegment( end, start ); startCut = true; }
  }
  vec4 clipStart = projectionMatrix * start;
  vec4 clipEnd = projectionMatrix * end;
  vec2 sS = ( clipStart.xy / clipStart.w * 0.5 + 0.5 ) * resolution;
  vec2 sE = ( clipEnd.xy / clipEnd.w * 0.5 + 0.5 ) * resolution;
  vec2 d = sE - sS;
  float len = length( d );
  vec2 dir = len > 1e-4 ? d / len : vec2( 1.0, 0.0 );
  vec2 nrm = vec2( dir.y, - dir.x );   // ★ 与 LineMaterial 同向（反过来四边形绕序翻成背面，整条线被背面剔除吃掉）
  // 终点符号外沿的沿线位置 edge：从终点沿线往回（u = −dir）走出终点符号圆（半径再加 uGap）的那一点。
  // 屏幕 y 向上：圆心 C = 终点 + (0, 上移量)，w = 终点 − C；|w + t·u| = R 取大根（终点在圆内时即「走出」的那一根）。
  // 箭头尖就停在 edge；终点被近平面裁掉（在相机背后）/ 这一段不画箭头 / 剩下的线放不下一枚箭头 → −1
  float edge = - 1.0;
  if ( ! endCut ) {
    float k = instanceTip.z > 2.5 ? 1.0 : ( instanceTip.z > 1.5 ? uIconK : ( instanceTip.z > 0.5 ? uZoomK : 1.0 ) );
    vec2 w = vec2( 0.0, - instanceTip.x * k );
    vec2 u = - dir;
    float R = instanceTip.y * k + uGap;
    float wu = dot( w, u );
    float disc = wu * wu - dot( w, w ) + R * R;
    float t = disc > 0.0 ? max( 0.0, - wu + sqrt( disc ) ) : 0.0;
    edge = len - t;
  }
  vEdge = edge;
  vTip = uArrow > 0.5 && instanceTip.w > 0.5 && edge >= uArrowL + 6.0 ? edge : - 1.0;
#ifdef LINK_OCC
  vP0 = start.xyz; vP1 = end.xyz; vPw = vec2( clipStart.w, clipEnd.w );
  // 起点符号外沿的沿线位置（cut 用）：从起点沿 dir 走出起点符号圆的那一点；圆半径 0（起点是主星本体 / 没有身份）或起点被近平面裁掉 → 0（不切）
  float st0 = 0.0;
  if ( ! startCut && instanceTip0.y > 0.0 ) {
    float k0 = instanceTip0.z > 1.5 ? uIconK : ( instanceTip0.z > 0.5 ? uZoomK : 1.0 );
    vec2 w0 = vec2( 0.0, - instanceTip0.x * k0 );
    float R0 = instanceTip0.y * k0 + uGap;
    float wd = dot( w0, dir );
    float disc0 = wd * wd - dot( w0, w0 ) + R0 * R0;
    st0 = disc0 > 0.0 ? max( 0.0, - wd + sqrt( disc0 ) ) : 0.0;
  }
  vStart = st0;
  // 终点在地球背后：不画箭头（地球那一趟里它随终点一起被深度藏住）。箭头的屏幕像素按透视映回线段上的点 ——
  // 跟随时相机贴着起点，映回去的点离相机只有几百公里、在地球前面，逐片元遮挡认不出来；箭头代表的是终点，就按终点本身判
  if ( vTip > 0.0 && ! endCut && linkOccluded( end.xyz ) ) vTip = - 1.0;
#endif
  bool atEnd = position.y > 0.5;
  vec4 clip = atEnd ? clipEnd : clipStart;
  float along = atEnd ? len : 0.0;
  float side = position.x < 0.0 ? - 1.0 : 1.0;
  vec2 off = nrm * side * uHalf;
  if ( position.y < 0.0 ) { off -= dir * uHalf; along -= uHalf; }
  else if ( position.y > 1.0 ) { off += dir * uHalf; along += uHalf; }
  clip.xy += off / resolution * 2.0 * clip.w;
  gl_Position = clip;
  vAW = along * clip.w;
  vCW = side * uHalf * clip.w;
  vWw = clip.w;
  vLen = len;
  vec4 mvPosition = atEnd ? end : start;
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
}
`

const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>

uniform vec3 diffuse;
uniform float opacity;
uniform float uCore;
uniform float uCoreA;
uniform float uDash;
uniform float uArrowA;
uniform float uArrowL;
uniform float uArrowH;
uniform float uNotch;
uniform float uFlow;
uniform float uOff;
uniform float uDashOn;
uniform float uDashP;
uniform float uFlowBase;
uniform float uCut;
varying float vAW;
varying float vCW;
varying float vWw;
flat varying float vLen;
flat varying float vTip;
flat varying float vEdge;
#ifdef LINK_OCC
uniform vec4 uOcc;
flat varying vec3 vP0;
flat varying vec3 vP1;
flat varying vec2 vPw;
flat varying float vStart;
#endif

float segDist( vec2 p, vec2 a, vec2 b ) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 );
  return length( pa - ba * h );
}

void main() {
  #include <clipping_planes_fragment>
  float along = vAW / vWw;
  float across = vCW / vWw;
  float L = vLen;
#ifdef LINK_OCC
  // 逐片元地球遮挡：屏幕线性参数 u → 线段参数 t = u·w0 / (u·w0 + (1 − u)·w1)（透视），视空间点 P；
  // 视线（相机在原点）沿 P 方向与球面的近交点比 P 近就藏。球心距与半径的平方差拆成 (c − R)(c + R)，免得 float 大数相减
  {
    float u = clamp( along / max( L, 1e-6 ), 0.0, 1.0 );
    float t = u * vPw.x / max( u * vPw.x + ( 1.0 - u ) * vPw.y, 1e-20 );
    vec3 P = mix( vP0, vP1, t );
    float pl = length( P );
    if ( pl > 0.0 ) {
      float b = dot( P / pl, uOcc.xyz );
      float c0 = length( uOcc.xyz );
      float disc = b * b - ( c0 - uOcc.w ) * ( c0 + uOcc.w );
      if ( disc > 0.0 ) {
        float s1 = b - sqrt( disc );
        if ( s1 > 0.0 && s1 < pl ) discard;
      }
    }
  }
#endif
  // ① 线芯：圆头 + 1 px 抗锯齿；不可见的跳 = 屏幕像素虚线
  float dc = along < 0.0 ? length( vec2( along, across ) ) : ( along > L ? length( vec2( along - L, across ) ) : abs( across ) );
  float core = clamp( uCore + 0.5 - dc, 0.0, 1.0 );
  if ( uDash > 0.5 ) {
    float m = mod( max( along, 0.0 ), 11.0 );
    core *= clamp( min( m, 6.0 - m ) + 0.5, 0.0, 1.0 );
  }
  // cut：线芯停在终点符号外沿、从起点符号外沿起画（跟随视图局部那一趟：两端的圆点 / 图标 / 站符号画在它下面，压不住线头）
  if ( uCut > 0.5 && vEdge > 0.0 ) core *= clamp( vEdge - along + 0.5, 0.0, 1.0 );
#ifdef LINK_OCC
  if ( uCut > 0.5 && vStart > 0.0 ) core *= clamp( along - vStart + 0.5, 0.0, 1.0 );
#endif
  // ② 流动：淡底 + 沿信号方向走的虚线（uOff 增大 → 图样向终点走），画到箭头尾凹处为止
  if ( uFlow > 0.5 ) {
    float stopAt = vTip > 0.0 ? vTip - uArrowL * ( 1.0 - uNotch ) : L;
    float m = mod( along - uOff, uDashP );
    float dsh = clamp( max( min( m, uDashOn - m ), m - uDashP ) + 0.5, 0.0, 1.0 );
    dsh *= clamp( stopAt - along + 0.5, 0.0, 1.0 );
    core *= mix( uFlowBase, 1.0, dsh );
  }
  core *= uCoreA;
  // ③ 末端箭头：尖在沿线 vTip、朝信号去向；按 |across| 对折成半边三角 尖 (0, 0)、尾角 B (−长, 半宽)、尾凹 N (−长·(1 − notch), 0)。
  //    距离只量两条外边（对折轴上那条不是边界，量了会在箭头中线上留一道缝）；内外按三条边的叉积同号判
  float arrow = 0.0;
  float halo = 0.0;
  if ( vTip > 0.0 ) {
    vec2 q = vec2( along - vTip, abs( across ) );
    vec2 B = vec2( - uArrowL, uArrowH );
    vec2 N = vec2( - uArrowL * ( 1.0 - uNotch ), 0.0 );
    float dd = min( segDist( q, vec2( 0.0 ), B ), segDist( q, B, N ) );
    float c1 = B.x * q.y - B.y * q.x;
    float c2 = ( N.x - B.x ) * ( q.y - B.y ) - ( N.y - B.y ) * ( q.x - B.x );
    float c3 = - N.x * q.y;
    bool inside = ( c1 >= 0.0 && c2 >= 0.0 && c3 >= 0.0 ) || ( c1 <= 0.0 && c2 <= 0.0 && c3 <= 0.0 );
    float sd = inside ? - dd : dd;
    arrow = clamp( 0.5 - sd, 0.0, 1.0 ) * uArrowA;
    halo = clamp( 1.5 - sd, 0.0, 1.0 ) * uArrowA * 0.6;
  }
  // 合成：深色衬边在下，线芯 / 箭头（链路色）在上
  float a = max( core, arrow );
  float hA = halo * ( 1.0 - a );
  float outA = a + hA;
  if ( outA < 0.004 ) discard;
  vec3 rgb = ( diffuse * a + vec3( 0.031, 0.047, 0.071 ) * hA ) / outA;
  gl_FragColor = vec4( rgb, outA * opacity );
  #include <logdepthbuf_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

// 流动虚线：亮段 10 px、节距 18 px（与 2D 的 LINK_DASH_ON / LINK_DASH_OFF 同值）；宿主按节距给 uOff 取模
export const LINK_DASH_ON = 10, LINK_DASH_PERIOD = 18

/**
 * 链路线材质。o：
 *   color      链路色（'#rrggbb' / THREE.Color / 数值）
 *   core       线芯半宽 px；coreA 线芯不透明度；dash 不可见跳的虚线
 *   arrow      画末端箭头；arrowA 不透明度；arrowL / arrowH 长度 / 半宽（px）
 *   flow       线身流动虚线（宿主每帧改 uniforms.uOff）
 *   cut        线芯停在终点符号外沿（跟随视图局部那一趟用，见文件头）
 *   occ        逐片元地球遮挡（跟随视图局部那一趟用；宿主每帧改 uniforms.uOcc）
 * 箭头尖与终点符号外沿的间隙、尾凹、流动淡底是定值（与 2D 同一套，见文件头）。
 * 返回 ShaderMaterial（透明、不写深度、照常做深度测试——地球背面被遮挡），.resolution 指向 uniforms.resolution.value。
 */
export function createLinkLineMaterial(o) {
  const core = Math.max(0.3, Number(o.core) || 0.6)
  const arrowL = Number(o.arrowL) || 9, arrowH = Number(o.arrowH) || 3.6
  const half = Math.max(core + 1.5, arrowH + 2.5)
  const mat = new THREE.ShaderMaterial({
    defines: o.occ ? { LINK_OCC: '' } : {},
    uniforms: {
      diffuse: { value: new THREE.Color(o.color != null ? o.color : '#3d8bff') },
      opacity: { value: 1 },
      resolution: { value: new THREE.Vector2(1, 1) },
      uHalf: { value: half },
      uCore: { value: core },
      uCoreA: { value: o.coreA != null ? o.coreA : 1 },
      uDash: { value: o.dash ? 1 : 0 },
      uArrow: { value: o.arrow ? 1 : 0 },
      uArrowA: { value: o.arrowA != null ? o.arrowA : 1 },
      uArrowL: { value: arrowL },
      uArrowH: { value: arrowH },
      uNotch: { value: 0.28 },
      uGap: { value: 2 },
      uZoomK: { value: 1 },
      uIconK: { value: 1 },
      uFlow: { value: o.flow ? 1 : 0 },
      uOff: { value: 0 },
      uDashOn: { value: LINK_DASH_ON },
      uDashP: { value: LINK_DASH_PERIOD },
      uFlowBase: { value: 0.45 },
      uCut: { value: o.cut ? 1 : 0 },
      uOcc: { value: new THREE.Vector4(0, 0, 0, 0) }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,   // 屏幕空间四边形本就朝着相机；双面兜底，绕序口径不再是能让整条线消失的单点
    clipping: true
  })
  mat.resolution = mat.uniforms.resolution.value
  mat.isLinkLine = true
  // 跟随局部那一趟临时开着 ACES 色调映射：近场链路不吃它，与地球那一趟画的同色（同 modelLayer 近截线的 toneMapped:false）
  if (o.occ) mat.toneMapped = false
  return mat
}
