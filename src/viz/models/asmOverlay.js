// 装配编辑器的叠加指示（P3，CONTRACT §5.3 / §5.4-B）：插座标记、目标面轮廓、吸附锚点（面心 / 边中点 / 角点 / 网格 / 插座）、质心记号。
//
// 全部挂在 vp.overlay 里一个本体系组下（矩阵 = 显示矩阵）：清深度后画在最上层、不吃 AO / 色调映射、不进拾取。
// 屏幕恒定尺寸：点状记号走 gl_PointSize（CSS 像素 × 设备像素比，不随距离变）；质心轴线按相机距离每帧缩放（tick，零分配）。
// 插座标记在着色器里按「朝外法向是否朝向相机」取舍：背面的插座不画；被别的件挡住的（编辑器按视线判、相机停下后更新）也不画——
// 半透明叠在正对相机的面上，会被误认成这个面上的插座。
// 颜色按主题（palette）：浅色底用深墨 + 白晕、深色底用亮色 + 黑晕，叠在任何颜色的模型上都读得出。
import * as THREE from 'three'

const AXIS_RGB = [0xe5484d, 0x30a46c, 0x3e63dd]
const SOCKET_PX = 13, MARKER_PX = 18, COM_PX = 15, COM_AXIS_PX = 34
const ORIGIN_AXIS_PX = 60, AXIS_LABEL_PX = 14   // 本体原点三轴：屏幕恒定长度 / 轴名字高（CSS 像素）
const FACE_SEG = 160   // 目标面轮廓线段上限（柱面两端圆各 48 段 + 4 条母线 + 面心十字）

const pointVS = `
attribute vec3 aNrm;
attribute float aState;
attribute float aOcc;
uniform vec3 uCam;
uniform float uPx;
uniform float uDpr;
varying float vState;
varying float vFace;
varying float vSize;
varying float vOcc;
void main() {
  vState = aState;
  vOcc = aOcc;
  if (aState < -0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vFace = 0.0; vSize = 1.0; return; }
  vFace = dot(aNrm, uCam - position) >= 0.0 ? 1.0 : 0.0;
  float k = aState > 1.5 ? 1.7 : (aState > 0.5 ? 1.25 : 1.0);
  vSize = uPx * k * uDpr;
  gl_PointSize = vSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
const socketFS = `
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uHalo;
varying float vState;
varying float vFace;
varying float vSize;
varying float vOcc;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float px = 2.0 / max(vSize, 1.0);
  vec3 col = vState > 1.5 ? uC2 : (vState > 0.5 ? uC1 : uC0);
  float dotR = vState > 1.5 ? 0.36 : 0.2;
  float ring = smoothstep(0.5 - px, 0.5 + px, r) * (1.0 - smoothstep(0.8 - px, 0.8 + px, r));
  float dotc = 1.0 - smoothstep(dotR - px, dotR + px, r);
  float halo = 1.0 - smoothstep(1.0 - 2.0 * px, 1.0, r);
  float ink = max(ring, dotc);
  vec3 c = mix(uHalo, col, ink);
  // 背面（朝外法向背离相机）与被别的件挡住的插座一律不画：叠在正对相机的面上会被误认成这个面上的插座
  if (vFace < 0.5 || vOcc > 0.5) discard;
  float a = max(ink, halo * 0.6);
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}`
const markerVS = `
uniform float uPx;
uniform float uDpr;
varying float vSize;
void main() {
  vSize = uPx * uDpr;
  gl_PointSize = vSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`
// 吸附锚点：0 自由（点）、1 网格（十字）、2 面心（环 + 点）、3 边中点（方框）、4 角点（菱形）、5 插座（实心圆）
const markerFS = `
uniform float uKind;
uniform vec3 uCol;
uniform vec3 uHalo;
varying float vSize;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float px = 2.0 / max(vSize, 1.0);
  float r = length(p);
  vec2 q = abs(p);
  float d;
  if (uKind < 0.5) d = r - 0.26;
  else if (uKind < 1.5) d = min(max(q.x - 0.11, q.y - 0.62), max(q.y - 0.11, q.x - 0.62));
  else if (uKind < 2.5) d = min(abs(r - 0.56) - 0.1, r - 0.18);
  else if (uKind < 3.5) d = abs(max(q.x, q.y) - 0.5) - 0.1;
  else if (uKind < 4.5) d = abs((q.x + q.y) * 0.7071 - 0.46) - 0.1;
  else d = r - 0.5;
  float ink = 1.0 - smoothstep(-px, px, d);
  float halo = 1.0 - smoothstep(-px, px, d - 3.0 * px);
  if (halo < 0.004) discard;
  gl_FragColor = vec4(mix(uHalo, uCol, ink), max(ink, halo * 0.9));
  #include <colorspace_fragment>
}`
// 质心：黑白四象限圆（工程图质心记号）
const comFS = `
uniform vec3 uHalo;
varying float vSize;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  float px = 2.0 / max(vSize, 1.0);
  if (r > 1.0) discard;
  float q = p.x * p.y > 0.0 ? 1.0 : 0.0;
  vec3 c = mix(vec3(0.96), vec3(0.06), q);
  float rim = smoothstep(0.78 - px, 0.78 + px, r);
  c = mix(c, vec3(0.06), rim * (1.0 - smoothstep(0.9 - px, 0.9 + px, r)));
  float a = 1.0 - smoothstep(1.0 - 2.0 * px, 1.0, r);
  c = mix(c, uHalo, smoothstep(0.9 - px, 0.9 + px, r));
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}`

function pointMat(fs, uniforms, vs = markerVS) {
  return new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })
}

/**
 * @param {THREE.Scene} overlayScene vp.overlay
 * @param {THREE.Matrix4} displayMatrix vp.displayMatrix（本体 → 显示）
 */
export function createAsmOverlay(overlayScene, displayMatrix) {
  const group = new THREE.Group(); group.name = 'asm_overlay'; group.matrixAutoUpdate = false
  group.matrix.copy(displayMatrix); group.matrixWorldNeedsUpdate = true
  overlayScene.add(group)
  const D = displayMatrix.elements
  const dpr = { value: 1 }

  // —— 插座标记 ——
  const sockU = { uCam: { value: new THREE.Vector3() }, uPx: { value: SOCKET_PX }, uDpr: dpr, uC0: { value: new THREE.Color() }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uHalo: { value: new THREE.Color() } }
  const sockMat = pointMat(socketFS, sockU, pointVS)
  const sockGeo = new THREE.BufferGeometry()
  let sockCap = 0, sockN = 0, sockState = null, sockOcc = null
  const sockPts = new THREE.Points(sockGeo, sockMat); sockPts.frustumCulled = false; sockPts.renderOrder = 60; sockPts.visible = false
  group.add(sockPts)
  function ensureSock(n) {
    if (n <= sockCap && sockState) return
    sockCap = Math.max(64, n * 2)
    sockGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sockCap * 3), 3))
    sockGeo.setAttribute('aNrm', new THREE.BufferAttribute(new Float32Array(sockCap * 3), 3))
    sockState = new THREE.BufferAttribute(new Float32Array(sockCap), 1)
    sockState.setUsage(THREE.DynamicDrawUsage)
    sockGeo.setAttribute('aState', sockState)
    sockOcc = new THREE.BufferAttribute(new Float32Array(sockCap), 1)
    sockOcc.setUsage(THREE.DynamicDrawUsage)
    sockGeo.setAttribute('aOcc', sockOcc)
  }
  const sockets = {
    /** 设标记（本体系位置 / 朝外法向，Float64Array 3n；state 缺省 0）。 */
    set(pos, nrm, n, state = 0) {
      ensureSock(n)
      const P = sockGeo.attributes.position.array, N = sockGeo.attributes.aNrm.array, S = sockState.array
      for (let i = 0; i < 3 * n; i++) { P[i] = pos[i]; N[i] = nrm[i] }
      for (let i = 0; i < n; i++) { S[i] = state; sockOcc.array[i] = 0 }
      sockOcc.needsUpdate = true
      sockN = n
      sockGeo.setDrawRange(0, n)
      sockGeo.attributes.position.needsUpdate = true; sockGeo.attributes.aNrm.needsUpdate = true; sockState.needsUpdate = true
      sockGeo.boundingSphere = null
    },
    /** 第 i 个标记的状态：−1 藏、0 空闲、1 可吸附候选、2 当前吸附（零分配）。 */
    state(i, s) { if (i >= 0 && i < sockN && sockState.array[i] !== s) { sockState.array[i] = s; sockState.needsUpdate = true } },
    /** 第 i 个标记被别的件挡住（视线遮挡）：不画。 */
    occl(i, on) { const v = on ? 1 : 0; if (i >= 0 && i < sockN && sockOcc.array[i] !== v) { sockOcc.array[i] = v; sockOcc.needsUpdate = true } },
    get count() { return sockN },
    set visible(v) { sockPts.visible = !!v && sockN > 0 },
    get visible() { return sockPts.visible }
  }

  // —— 目标面轮廓 ——
  const faceArr = new Float32Array(FACE_SEG * 6)
  const faceGeo = new THREE.BufferGeometry()
  faceGeo.setAttribute('position', new THREE.BufferAttribute(faceArr, 3).setUsage(THREE.DynamicDrawUsage))
  faceGeo.setDrawRange(0, 0)
  const faceMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false })
  const faceLines = new THREE.LineSegments(faceGeo, faceMat); faceLines.frustumCulled = false; faceLines.renderOrder = 58; faceLines.visible = false
  group.add(faceLines)
  let fw = 0
  const TF = new Float64Array(16)
  function fpt(M, x, y, z) {
    const o = fw * 3
    faceArr[o] = M[0] * x + M[4] * y + M[8] * z + M[12]; faceArr[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]; faceArr[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14]
    fw++
  }
  function mulInto(o, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[4 * c], b1 = b[4 * c + 1], b2 = b[4 * c + 2], b3 = b[4 * c + 3]
      o[4 * c] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
      o[4 * c + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
      o[4 * c + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
      o[4 * c + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
    }
  }
  // 目标面淡填充（叠在最上层，看得出「贴到哪个面」）：平面两个三角形、柱面 48 段条带
  const FILL_N = 48
  const fillArr = new Float32Array(FILL_N * 18)
  const fillGeo = new THREE.BufferGeometry()
  fillGeo.setAttribute('position', new THREE.BufferAttribute(fillArr, 3).setUsage(THREE.DynamicDrawUsage))
  fillGeo.setDrawRange(0, 0)
  const fillMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.13, depthTest: false, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false })
  const fillMesh = new THREE.Mesh(fillGeo, fillMat); fillMesh.frustumCulled = false; fillMesh.renderOrder = 57; fillMesh.visible = false
  group.add(fillMesh)
  let fv = 0
  function fillPt(M, x, y, z) {
    const o = fv * 3
    fillArr[o] = M[0] * x + M[4] * y + M[8] * z + M[12]; fillArr[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]; fillArr[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14]
    fv++
  }
  const FF = new Float64Array(16), FG = new Float64Array(16), TG = new Float64Array(16)
  const face = {
    /**
     * 画目标面轮廓：R = 该件渲染矩阵（本体系，派生件含镜面列），F0 = 面在 uv (0,0) 的面系（件局部，平面）或 null（柱面按 face 自己算）。
     * 只在目标面换了时调（不必每帧）。
     */
    show(R, f, faceFrameFn) {
      fw = 0
      if (f.kind === 'cyl') {
        const n = 48, hu = f.halfU, r = f.radius
        for (const u of [-hu, hu]) {
          for (let i = 0; i < n; i++) {
            faceFrameFn(FF, f, u, (i / n) * 2 * Math.PI * r); mulInto(TF, R, FF); fpt(TF, 0, 0, 0)
            faceFrameFn(FF, f, u, ((i + 1) / n) * 2 * Math.PI * r); mulInto(TF, R, FF); fpt(TF, 0, 0, 0)
          }
        }
        for (let k = 0; k < 4; k++) {
          const v = (k / 4) * 2 * Math.PI * r
          faceFrameFn(FF, f, -hu, v); mulInto(TF, R, FF); fpt(TF, 0, 0, 0)
          faceFrameFn(FF, f, hu, v); mulInto(TF, R, FF); fpt(TF, 0, 0, 0)
        }
        // 填充：沿周向 48 段、每段一个四边形（轴向贯穿）
        fv = 0
        for (let i = 0; i < FILL_N; i++) {
          const v0 = (i / FILL_N) * 2 * Math.PI * r, v1 = ((i + 1) / FILL_N) * 2 * Math.PI * r
          faceFrameFn(FF, f, -hu, v0); mulInto(TF, R, FF); faceFrameFn(FG, f, hu, v0); mulInto(TG, R, FG)
          const ax = TF[12], ay = TF[13], az = TF[14], bx = TG[12], by = TG[13], bz = TG[14]
          faceFrameFn(FF, f, -hu, v1); mulInto(TF, R, FF); faceFrameFn(FG, f, hu, v1); mulInto(TG, R, FG)
          fillArr.set([ax, ay, az, bx, by, bz, TG[12], TG[13], TG[14], ax, ay, az, TG[12], TG[13], TG[14], TF[12], TF[13], TF[14]], fv * 3)
          fv += 6
        }
      } else {
        faceFrameFn(FF, f, 0, 0); mulInto(TF, R, FF)
        const a = f.halfU, b = f.halfV, c = 0.14 * Math.min(a, b)
        fpt(TF, -a, -b, 0); fpt(TF, a, -b, 0); fpt(TF, a, -b, 0); fpt(TF, a, b, 0)
        fpt(TF, a, b, 0); fpt(TF, -a, b, 0); fpt(TF, -a, b, 0); fpt(TF, -a, -b, 0)
        fpt(TF, -c, 0, 0); fpt(TF, c, 0, 0); fpt(TF, 0, -c, 0); fpt(TF, 0, c, 0)
        fv = 0
        fillPt(TF, -a, -b, 0); fillPt(TF, a, -b, 0); fillPt(TF, a, b, 0)
        fillPt(TF, -a, -b, 0); fillPt(TF, a, b, 0); fillPt(TF, -a, b, 0)
      }
      faceGeo.setDrawRange(0, fw)
      faceGeo.attributes.position.needsUpdate = true
      faceLines.visible = fw > 0
      fillGeo.setDrawRange(0, fv)
      fillGeo.attributes.position.needsUpdate = true
      fillMesh.visible = fv > 0
    },
    hide() { faceLines.visible = false; fillMesh.visible = false }
  }

  // —— 吸附锚点 ——
  const mkU = { uPx: { value: MARKER_PX }, uDpr: dpr, uKind: { value: 2 }, uCol: { value: new THREE.Color() }, uHalo: { value: new THREE.Color() } }
  const mkGeo = new THREE.BufferGeometry()
  mkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage))
  const mkPts = new THREE.Points(mkGeo, pointMat(markerFS, mkU)); mkPts.frustumCulled = false; mkPts.renderOrder = 62; mkPts.visible = false
  group.add(mkPts)
  const marker = {
    /** 锚点记号放在本体系 src[off..off+2]，形状 kind（0–5，见着色器注释）。零分配（坐标从数组读，双精度不经实参传）。 */
    showAt(src, off, kind) {
      const a = mkGeo.attributes.position.array
      if (a[0] !== src[off] || a[1] !== src[off + 1] || a[2] !== src[off + 2]) { a[0] = src[off]; a[1] = src[off + 1]; a[2] = src[off + 2]; mkGeo.attributes.position.needsUpdate = true }
      mkU.uKind.value = kind
      mkPts.visible = true
    },
    hide() { mkPts.visible = false }
  }

  // —— 质心记号：四象限圆 + 三根本体轴向短线（屏幕恒定长度）——
  const comU = { uPx: { value: COM_PX }, uDpr: dpr, uHalo: { value: new THREE.Color() } }
  const comGeo = new THREE.BufferGeometry()
  comGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
  const comPts = new THREE.Points(comGeo, pointMat(comFS, comU)); comPts.frustumCulled = false; comPts.renderOrder = 64
  const axGeo = new THREE.BufferGeometry()
  {
    const p = new Float32Array(18), c = new Float32Array(18), col = new THREE.Color()
    for (let k = 0; k < 3; k++) { p[k * 6 + 3 + k] = 1; col.setHex(AXIS_RGB[k]); for (let j = 0; j < 2; j++) { c[k * 6 + j * 3] = col.r; c[k * 6 + j * 3 + 1] = col.g; c[k * 6 + j * 3 + 2] = col.b } }
    axGeo.setAttribute('position', new THREE.BufferAttribute(p, 3))
    axGeo.setAttribute('color', new THREE.BufferAttribute(c, 3))
  }
  const axMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false })
  const axLines = new THREE.LineSegments(axGeo, axMat); axLines.frustumCulled = false; axLines.renderOrder = 63
  const comGrp = new THREE.Group(); comGrp.visible = false
  comGrp.add(axLines, comPts)
  group.add(comGrp)
  const com = {
    /** 质心位置（本体系，src[0..2]）。零分配。 */
    atArr(src) { comGrp.position.set(src[0], src[1], src[2]); comGrp.visible = on.com },
    set visible(v) { on.com = !!v; comGrp.visible = on.com },
    get visible() { return comGrp.visible }
  }
  const on = { com: true, axes: true }

  // —— 本体原点三轴（装配页代替视口那套按整件半径缩放的实心箭头：那套装上 31 m 太阳翼后粗到 11 cm、横压在平台体上，
  //    又和 gizmo 手柄同是红绿蓝，看着像能拖）：像素恒定 ~60 px 的细线 + X / Y / Z 字标。
  //    两份：场景里一份做深度测试、全不透明（originScene，编辑器挂进 fxRoot 第 1 层）；叠加层一份常在最上层 35 %（被件挡住的那段淡着看得见）。
  const oaDepthMat = new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false })
  const oaTopMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, toneMapped: false })
  const oaDepth = new THREE.LineSegments(axGeo, oaDepthMat); oaDepth.frustumCulled = false; oaDepth.layers.set(1)
  const originScene = new THREE.Group(); originScene.name = 'asm_origin_axes'; originScene.add(oaDepth)
  const oaTop = new THREE.LineSegments(axGeo, oaTopMat); oaTop.frustumCulled = false; oaTop.renderOrder = 55
  const oaGrp = new THREE.Group(); oaGrp.add(oaTop)
  const labels = [], labelCv = []
  for (let k = 0; k < 3; k++) {
    const cv = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 64, height: 64 }) : new OffscreenCanvas(64, 64)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false }))
    sp.frustumCulled = false; sp.renderOrder = 56
    labels.push(sp); labelCv.push(cv); oaGrp.add(sp)
  }
  let labelHalo = -1
  function drawLabels(halo) {
    if (halo === labelHalo) return
    labelHalo = halo
    const hc = '#' + halo.toString(16).padStart(6, '0')
    for (let k = 0; k < 3; k++) {
      const c = labelCv[k].getContext('2d')
      c.clearRect(0, 0, 64, 64)
      c.font = '600 44px "Segoe UI", Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'
      c.lineWidth = 8; c.lineJoin = 'round'; c.strokeStyle = hc; c.strokeText('XYZ'[k], 32, 34)
      c.fillStyle = '#' + AXIS_RGB[k].toString(16).padStart(6, '0'); c.fillText('XYZ'[k], 32, 34)
      labels[k].material.map.needsUpdate = true
    }
  }
  group.add(oaGrp)
  const originAxes = {
    set visible(v) { on.axes = !!v; oaGrp.visible = on.axes; oaDepth.visible = on.axes },
    get visible() { return on.axes }
  }

  const _v = new THREE.Vector3()
  function setPalette(p) {
    sockU.uC0.value.setHex(p.amber); sockU.uC1.value.setHex(p.candidate); sockU.uC2.value.setHex(p.accent); sockU.uHalo.value.setHex(p.halo)
    faceMat.color.setHex(p.accent); fillMat.color.setHex(p.accent)
    mkU.uCol.value.setHex(p.accent); mkU.uHalo.value.setHex(p.halo)
    comU.uHalo.value.setHex(p.halo)
    drawLabels(p.halo)
  }
  return {
    group, sockets, face, marker, com, originAxes, originScene, setPalette,
    setDpr(v) { dpr.value = v > 0 ? v : 1 },
    /** 每帧：相机位置换本体系（插座正背面判定）、质心轴线 / 原点三轴按距离定长、轴名字按像素定大小。零分配。 */
    tick(camera, cssH) {
      const c = camera.position
      const H = Math.max(1, cssH), tf = Math.tan(camera.fov * Math.PI / 360)
      // 本体 = 显示矩阵的转置 · 显示（纯旋转）
      sockU.uCam.value.set(D[0] * c.x + D[1] * c.y + D[2] * c.z, D[4] * c.x + D[5] * c.y + D[6] * c.z, D[8] * c.x + D[9] * c.y + D[10] * c.z)
      if (comGrp.visible) {
        const p = comGrp.position
        _v.set(D[0] * p.x + D[4] * p.y + D[8] * p.z, D[1] * p.x + D[5] * p.y + D[9] * p.z, D[2] * p.x + D[6] * p.y + D[10] * p.z)
        const dist = _v.distanceTo(c)
        const s = (COM_AXIS_PX * 2 * dist * tf) / H
        axLines.scale.set(s, s, s)
      }
      if (on.axes) {
        // 原点在显示系也是原点（显示矩阵纯旋转）：距离 = 相机到原点
        const s = (ORIGIN_AXIS_PX * 2 * c.length() * tf) / H
        oaTop.scale.set(s, s, s); oaDepth.scale.set(s, s, s)
        // 字标：不随距离缩放的精灵，尺寸 = 像素 × 2 · tan(fov/2) / 视口高
        const ls = (AXIS_LABEL_PX * 2 * tf) / H, off = 1.16 * s
        for (let k = 0; k < 3; k++) { labels[k].scale.set(ls, ls, 1); labels[k].position.set(k === 0 ? off : 0, k === 1 ? off : 0, k === 2 ? off : 0) }
      }
    },
    hideDrag() { face.hide(); marker.hide() },
    dispose() {
      overlayScene.remove(group)
      if (originScene.parent) originScene.parent.remove(originScene)
      sockGeo.dispose(); sockMat.dispose(); faceGeo.dispose(); faceMat.dispose(); fillGeo.dispose(); fillMat.dispose()
      mkGeo.dispose(); mkPts.material.dispose(); comGeo.dispose(); comPts.material.dispose(); axGeo.dispose(); axMat.dispose()
      oaDepthMat.dispose(); oaTopMat.dispose()
      for (const l of labels) { l.material.map.dispose(); l.material.dispose() }
    }
  }
}
