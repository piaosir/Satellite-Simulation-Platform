// 坐标轴图层（仅 3D 球体）：
//   ① 参考系轴（地图综合设置 → 坐标系 → 参考系）：地心地固系 ECEF 三轴、J2000 惯性系三轴、赤道面
//   ② 聚焦卫星的 RIC 三轴（卫星聚焦特效设置 → 轨道坐标系）：R 径向 / I 沿迹 / C 轨道面法向，屏幕像素定长
//
// 场景轴 = ECEF (X, Z, −Y)、单位 = 地球半径。地球网格不转（惯性视角只转相机），故 ECEF 三轴是静态几何；
// J2000 三轴每拍由页面给「J2000 三根轴在场景里的方向」（shared/orbitState.j2000AxesInEcef：refFrames 同一条链，
// IAU-76 岁差 + IAU-80 章动 + GMST —— 与卫星 TEME→ECEF 只转 GMST 的口径配套，轴与星位不会差出一个章动）。
//
// 版式（对标 STK 3D Graphics 的 Axes 显示 / STK Graphics AxesPrimitive）：
//   · 箭头是实体：圆柱杆 + 圆锥头 + 锥底封盖，受光照（光源钉在相机上，任何机位都读得出立体）。杆粗与锥头按【屏幕像素】定尺 ——
//     顶点着色器按各点的视深把像素折成世界长度（AxesPrimitive.Width「随相机距离自动缩放、保住像素粗细」同一口径）：
//     拉远不糊成发丝、拉近锥头不胀；轴长仍是世界长度（R⊕）。不透明、照写深度：被地球挡住的那截自然不画。
//   · 一套轴一种颜色（STK 每个 Axes 元素一个 Color）：ECEF 与 J2000 同屏时靠颜色认坐标系、靠轴端字标认轴。
//     两套 Z 轴只差岁差章动（~0.4°）、几乎重合，两个锥头互相穿插会碎成条纹：两套同屏时 J2000 那套沿视线朝相机挪一点
//     （挪的量按像素折算、略大于杆 / 锥的直径；沿视线挪不改屏上位置），重合处恒压在上面。
//     RIC 三轴是单独一套（在星上），仍按 R / I / C 红绿蓝。
//   · 轴端字标：轴名衬线斜体 + 坐标系名正体下标（X_ECEF / X_J2000：变量斜体、说明性下标正体，同信息栏与视频叠加的符号体例），
//     600 字重 + 实心深色套边（同地名注记）。字标沿轴的屏幕方向排在锥尖外侧、不压箭头；相撞（如两套 Z 轴）就沿各自的轴外推错开。
//   · 赤道面：半透明面 + 极坐标网格（30° 一根辐条、0 / 90 / 180 / 270° 加重；同心环按半径取 0.5 / 1 / 2 R⊕ 一档）+ 外缘环
//     （STK Plane Grid 的 circular 档）。辐条随地固系：0° 那根 = ECEF X 轴方向。
// 宿主（scene.js）注入：scene / fatSegments / lineMats / occluded(P) —— 本模块不碰地球场景的其它东西。

import * as THREE from 'three'

export const REF_AXES_DEF = { ecef: false, j2000: false, equator: false, len: 2, ecefColor: '#f0a43c', j2000Color: '#45c9c1' }
export const REF_LEN_RANGE = [1.1, 10]               // 轴长 = 赤道面半径（地球半径）
export const SAT_TRIAD_DEF = { on: false, px: 72 }
export const SAT_TRIAD_PX = [32, 200]
const RIC_COLOR = ['#e36b5d', '#5cbf74', '#5c9ce6']  // R / I / C：红绿蓝三轴惯例，压一档饱和度
const RIC_INK = ['#ff9d90', '#93e2a6', '#98c2ff']    // 字标墨色（比箭头亮一档，暗底上读得清）
const EQ_COLOR = 0x9fb4c8
const LOCAL_DIRS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
const ECEF_DIRS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)]   // ECEF X / Y / Z 在场景轴里
const ORIGIN = new THREE.Vector3()
// 箭头尺寸（屏幕 CSS px）：[杆半径, 锥长, 锥底半径]
const FRAME_ARROW = [1.25, 15, 5.2]
const TRIAD_ARROW = [1.1, 11, 4]
const SEG = 18                                       // 圆周分段
const LABEL_PX = 14                                  // 轴名字号（下标 0.64 号）
const LABEL_GAP = 5                                  // 锥尖到字面的间隙
const LABEL_FONT = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'
const SYM_FONT = '"Times New Roman", Times, serif'  // 同视频叠加 hud.js 的符号字体
const CASING = 'rgb(8,12,18)'                        // 套边色：同视频叠加 / 平面图影像档地名
const ORDER = { disk: 4.4, grid: 6.1, ring: 6.12, axis: 6.26, triad: 35, label: 40 }
const clampLen = (v) => Math.max(REF_LEN_RANGE[0], Math.min(REF_LEN_RANGE[1], Number(v) || REF_AXES_DEF.len))

// —— 实体箭头：每个顶点都存「锥尖」(position，本地) + 圆周径向 aRad + 部位 aKind，真正的位置在顶点着色器里按像素现算 ——
//   aKind：0 杆根（原点）｜1 杆梢（锥底处）｜2 锥底圈｜3 锥尖（径向取扇面中线，锥面平滑着色）｜4 封盖圈｜5 封盖中心
//   所有箭头共用本地原点（一套轴的三根都从原点出发）。轴在屏上太短时锥头按比例缩到轴长的 45%，不倒插进杆里。
//   先截到相机前方：轴长大于相机距离、视线又顺着某根轴时，锥尖（跟随视图里也可能是原点）落到近裁剪面后面，那一头按像素折出的
//   半径塌成 0，杆两圈之间线性插值会让靠相机那段越画越粗（实测 1.5–4 倍）。故把杆截到视深 dMin 处、那一圈照常按像素定半径；
//   被截掉的锥头本就在相机背后，整组收成退化。两头都在后面时整根丢出裁剪体。
const ARROW_VS = `
uniform float uPx;
uniform float uNear;
uniform vec3 uSize;
uniform float uBias;
attribute vec3 aRad;
attribute float aKind;
attribute vec3 aCol;
varying vec3 vN;
varying vec3 vV;
varying vec3 vCol;
void main() {
  vec3 O = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 T = (modelViewMatrix * vec4(position, 1.0)).xyz;
  float dMin = uNear * 1.5, dO = -O.z, dT = -T.z;
  if (dO < dMin && dT < dMin) { vN = vec3(0.0, 0.0, 1.0); vV = vN; vCol = aCol; gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  bool cut = dT < dMin;
  if (cut) T = O + (T - O) * ((dO - dMin) / (dO - dT));
  else if (dO < dMin) O = T + (O - T) * ((dT - dMin) / (dT - dO));
  vec3 ax = T - O;
  float len = length(ax);
  vec3 dir = ax / max(len, 1e-9);
  vec3 r = (modelViewMatrix * vec4(aRad, 0.0)).xyz;
  float rl = length(r);
  r = rl > 1e-12 ? r / rl : vec3(0.0);
  float wT = uPx * max(-T.z, 1e-6);
  float sc = min(1.0, 0.45 * len / max(uSize.y * wT, 1e-12));
  float hl = cut ? 0.0 : uSize.y * wT * sc;
  float hr = cut ? 0.0 : uSize.z * wT * sc;
  vec3 B = T - dir * hl;
  vec3 P;
  vec3 N;
  if (aKind < 0.5) { P = O + r * (uSize.x * sc * uPx * max(-O.z, 1e-6)); N = r; }
  else if (aKind < 1.5) { P = B + r * (uSize.x * sc * uPx * max(-B.z, 1e-6)); N = r; }
  else if (cut) { P = T; N = dir; }
  else if (aKind < 3.5) { P = aKind < 2.5 ? B + r * hr : T; N = normalize(r * hl + dir * hr); }
  else { P = aKind < 4.5 ? B + r * hr : B; N = -dir; }
  if (uBias > 0.0) P += normalize(-P) * (uBias * (aKind < 1.5 ? uSize.x : uSize.z) * sc * uPx * max(-P.z, 1e-6));
  vN = N;
  vV = -P;
  vCol = aCol;
  gl_Position = projectionMatrix * vec4(P, 1.0);
}`
// 头灯式光照：主光在相机左上前方、补光在右下，高光一点点 —— 颜色本身仍是主体（环境项给足），只靠明暗读出圆柱 / 圆锥
const ARROW_FS = `
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
varying vec3 vCol;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  vec3 l = normalize(vec3(-0.34, 0.5, 0.8));
  float dif = max(dot(n, l), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, -0.35, 0.72))), 0.0);
  float spec = pow(max(dot(n, normalize(l + v)), 0.0), 36.0);
  vec3 c = vCol * (0.42 + 0.52 * dif + 0.12 * fill) + vec3(0.2 * spec);
  gl_FragColor = vec4(c, uOpacity);
  #include <colorspace_fragment>
}`

// specs：[{ tip: Vector3（本地，锥尖）, color: THREE.Color }]，合成一个几何（一套轴一次绘制）
export function arrowGeometry(specs) {
  const pos = [], rad = [], kind = [], col = [], idx = []
  const v = new THREE.Vector3()
  for (const sp of specs) {
    const d = sp.tip.clone().normalize()
    const p1 = (Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).cross(d).normalize()
    const p2 = d.clone().cross(p1)                 // (p1, p2, d) 右手系：角度自 p1 转向 p2 = 绕 d 逆时针
    const put = (a, k) => {
      if (a == null) rad.push(0, 0, 0)
      else { v.copy(p1).multiplyScalar(Math.cos(a)).addScaledVector(p2, Math.sin(a)); rad.push(v.x, v.y, v.z) }
      pos.push(sp.tip.x, sp.tip.y, sp.tip.z); kind.push(k); col.push(sp.color.r, sp.color.g, sp.color.b)
      return pos.length / 3 - 1
    }
    const A = [], B = [], R = [], T = [], C = []
    for (let i = 0; i < SEG; i++) {
      const a = i / SEG * Math.PI * 2
      A.push(put(a, 0)); B.push(put(a, 1)); R.push(put(a, 2)); T.push(put(a + Math.PI / SEG, 3)); C.push(put(a, 4))
    }
    const c0 = put(null, 5)
    // 绕向：从外面看逆时针（正面）
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG
      idx.push(A[i], A[j], B[j], A[i], B[j], B[i])   // 杆
      idx.push(R[i], R[j], T[i])                     // 锥面
      idx.push(c0, C[j], C[i])                       // 锥底封盖（朝后）
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aRad', new THREE.Float32BufferAttribute(rad, 3))
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1))
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3))
  g.setIndex(idx)
  return g
}

// 赤道面同心环半径（R⊕）：间距随外缘半径取 0.5 / 1 / 2 一档；r = 1 是地表（赤道本身）不画，贴着外缘的那一环让给外缘环
export function eqRingRadii(L) {
  const step = L <= 2.5 ? 0.5 : (L <= 6 ? 1 : 2)
  const out = []
  for (let r = Math.floor(1 / step + 1) * step; r < L - step * 0.35; r += step) out.push(Math.round(r * 1e6) / 1e6)
  return out
}

// 字标框（w × h，px）中心相对锚点的偏移：沿屏幕方向 (ux, uy)（y 朝上、单位矢量）排在锚点外侧，近边离锚点 gap
export function labelOffset(ux, uy, w, h, gap) {
  const ax = Math.abs(ux), ay = Math.abs(uy)
  const edge = Math.min(ax > 1e-6 ? w / 2 / ax : Infinity, ay > 1e-6 ? h / 2 / ay : Infinity)
  const d = gap + (Number.isFinite(edge) ? edge : 0)
  return [ux * d, uy * d]
}

// 避让：框（中心 cx, cy，w × h）与已摆好的框（rects：{ x, y, w, h }）相撞就沿 (ux, uy) 外推到刚好不撞（留 margin），最多推几轮
export function clearAlong(cx, cy, ux, uy, w, h, rects, margin = 1) {
  for (let it = 0; it < 6; it++) {
    let hit = null
    for (const r of rects) if (Math.abs(cx - r.x) < (w + r.w) / 2 + margin && Math.abs(cy - r.y) < (h + r.h) / 2 + margin) { hit = r; break }
    if (!hit) break
    const hx = (w + hit.w) / 2 + margin + 0.01, hy = (h + hit.h) / 2 + margin + 0.01
    const tx = Math.abs(ux) > 1e-6 ? (hx - (cx - hit.x) * Math.sign(ux)) / Math.abs(ux) : Infinity
    const ty = Math.abs(uy) > 1e-6 ? (hy - (cy - hit.y) * Math.sign(uy)) / Math.abs(uy) : Infinity
    const t = Math.max(0, Math.min(tx, ty))
    if (!Number.isFinite(t)) break
    cx += ux * t; cy += uy * t
  }
  return [cx, cy]
}

// 墨色：在 sRGB 里向白色提一档（字标比箭头亮，暗底与影像底图上都读得清）
function inkOf(hex, t = 0.3) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0
  const ch = (s) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * t)
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`
}

// 屏幕像素定尺的字标：轴名（italic=衬线斜体，否则无衬线正体）+ 可选正体下标；600 字重 + 实心深色套边（先整组描边再整组填色，
// 下标的套边不会啃到轴名）。颜色烘进贴图。★ 画布同步画完再建贴图
function makeLabel(main, sub, ink, italic) {
  const fs = 64, fsSub = Math.round(fs * 0.64)
  const fMain = `${italic ? 'italic ' : ''}600 ${fs}px ${italic ? SYM_FONT : LABEL_FONT}`
  const fSub = `600 ${fsSub}px ${LABEL_FONT}`
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  ctx.font = fMain
  const mm = ctx.measureText(main)
  const asc = mm.actualBoundingBoxAscent || fs * 0.7
  let ws = 0
  if (sub) { ctx.font = fSub; ws = ctx.measureText(sub).width }
  // 下标贴在轴名的前进宽度之后（不加斜体校正 —— 下标本就该缩进斜体字母的右下方，TeX 同此）；没有下标时字面宽取墨迹右沿
  const wm = sub ? mm.width : Math.max(mm.width, mm.actualBoundingBoxRight || 0)
  const gap = sub ? fs * 0.03 : 0
  const drop = sub ? fs * 0.24 : 0                   // 下标基线下沉（同视频叠加）
  const pad = Math.ceil(fs * 0.16)
  const iw = wm + gap + ws, ih = asc + Math.max(fs * 0.04, drop)
  c.width = Math.ceil(iw + pad * 2); c.height = Math.ceil(ih + pad * 2)
  const base = pad + asc
  const runs = [[fMain, main, pad, base, fs]]
  if (sub) runs.push([fSub, sub, pad + wm + gap, base + drop, fsSub])
  ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round'; ctx.miterLimit = 2
  ctx.strokeStyle = CASING
  for (const [f, s, x, y, px] of runs) { ctx.font = f; ctx.lineWidth = Math.max(2, px * 0.16); ctx.strokeText(s, x, y) }
  ctx.fillStyle = ink
  for (const [f, s, x, y] of runs) { ctx.font = f; ctx.fillText(s, x, y) }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const m = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false })
  const s = new THREE.Sprite(m)
  s.renderOrder = ORDER.label
  const k = LABEL_PX / fs
  s.userData.ar = c.width / c.height
  s.userData.pxH = c.height * k
  s.userData.iw = iw * k; s.userData.ih = ih * k     // 字面框（不含套边留白）：排位与避让按它算
  s.visible = false
  return s
}

export function createAxesLayer({ scene, fatSegments, lineMats, occluded }) {
  let cfg = { ...REF_AXES_DEF }
  let ecef = null, j2k = null, eq = null      // { group, meshes, lines, labels:[{ s, k }] }
  const j2kDirs = LOCAL_DIRS.map((d) => d.clone())   // 场景里 J2000 三轴（每拍更新）
  let triadCfg = { ...SAT_TRIAD_DEF }
  let triad = null, triadState = null          // triadState：{ p:Vector3, dirs:[R, I, C] }（场景）
  const mats = new Set()                       // 箭头材质：uPx 逐帧刷
  const placed = []                            // 本帧已摆好的字标框（避让用）
  const _m4 = new THREE.Matrix4(), _t = new THREE.Vector3(), _ndc = new THREE.Vector3()
  const _a = new THREE.Vector2(), _b = new THREE.Vector2()

  function arrowMesh(tips, colors, size, order) {
    const g = arrowGeometry(tips.map((tip, k) => ({ tip, color: new THREE.Color(colors[k]) })))
    const m = new THREE.ShaderMaterial({
      uniforms: { uPx: { value: 0.002 }, uNear: { value: 0.004 }, uSize: { value: new THREE.Vector3(size[0], size[1], size[2]) }, uBias: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: ARROW_VS, fragmentShader: ARROW_FS,
      side: THREE.FrontSide
    })
    mats.add(m)
    const mesh = new THREE.Mesh(g, m)
    mesh.frustumCulled = false                   // 顶点 position 全是锥尖，包围球不代表实际范围
    mesh.renderOrder = order
    return mesh
  }
  function disposeLine(o) {
    if (!o) return
    if (o.parent) o.parent.remove(o)
    if (o.geometry) o.geometry.dispose()
    if (o.material) { lineMats.delete(o.material); o.material.dispose() }
  }
  function disposeSprite(s) { if (!s) return; if (s.parent) s.parent.remove(s); s.material.map.dispose(); s.material.dispose() }
  function disposeSet(set) {
    if (!set) return
    for (const o of set.lines || []) disposeLine(o)
    for (const l of set.labels || []) disposeSprite(l.s)
    for (const o of set.meshes || []) { if (o.parent) o.parent.remove(o); o.geometry.dispose(); mats.delete(o.material); o.material.dispose() }
    if (set.group && set.group.parent) set.group.parent.remove(set.group)
  }

  // 一套参考系：三根单位长箭头（组缩放 = 轴长，改轴长不重建），三枚字标 X/Y/Z + 坐标系名下标。
  // ECEF 用场景方向直接建；J2000 用本地 x̂ ŷ ẑ 建、整组按每拍的方向转
  function buildFrame(dirs, sub, color) {
    const group = new THREE.Group()
    const mesh = arrowMesh(dirs, [color, color, color], FRAME_ARROW, ORDER.axis)
    group.add(mesh)
    group.scale.setScalar(cfg.len)
    const ink = inkOf(color)
    const labels = ['X', 'Y', 'Z'].map((a, k) => { const s = makeLabel(a, sub, ink, true); scene.add(s); return { s, k } })
    scene.add(group)
    return { group, meshes: [mesh], lines: [], labels }
  }
  function buildEquator(L) {
    const group = new THREE.Group()
    const g = new THREE.RingGeometry(1, L, 192, 1)
    g.rotateX(-Math.PI / 2)                                              // 场景赤道面 = XZ 面
    const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: EQ_COLOR, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false }))
    fill.renderOrder = ORDER.disk
    group.add(fill)
    const circle = (out, r, n) => {
      for (let i = 0; i < n; i++) {
        const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2
        out.push(r * Math.cos(a0), 0, -r * Math.sin(a0), r * Math.cos(a1), 0, -r * Math.sin(a1))
      }
      return out
    }
    const minor = [], major = []
    for (const r of eqRingRadii(L)) circle(minor, r, Math.max(96, Math.round(r * 72)))
    for (let deg = 0; deg < 360; deg += 30) {                            // 辐条：自地表到外缘；经度 λ 的方向 = (cos λ, 0, −sin λ)
      const a = deg * Math.PI / 180, c = Math.cos(a), s = -Math.sin(a)
      ;(deg % 90 ? minor : major).push(c, 0, s, L * c, 0, L * s)
    }
    // 半透明粗线每段两头是圆帽，相邻两段的帽在接缝处叠两遍 alpha —— 圆周上段多（侧视时还被透视压密），外缘环会读成一串珠子。
    // 这几条线照写深度、深度比较取严格小于：接缝处后画的那一段与先画的同深度，被挡掉，每个像素只调一次色（网格交叉点同理）
    const lines = []
    const add = (ln) => { ln.material.depthWrite = true; ln.material.depthFunc = THREE.LessDepth; ln.frustumCulled = false; group.add(ln); lines.push(ln) }
    for (const [flat, op] of [[minor, 0.16], [major, 0.3]]) if (flat.length) add(fatSegments(flat, EQ_COLOR, 1, op, ORDER.grid))
    add(fatSegments(circle([], L, 288), EQ_COLOR, 1.25, 0.6, ORDER.ring))
    scene.add(group)
    return { group, meshes: [fill], lines, labels: [] }
  }
  function applyJ2000() {
    if (!j2k) return
    const [a, b, c] = j2kDirs
    _m4.set(a.x, b.x, c.x, 0, a.y, b.y, c.y, 0, a.z, b.z, c.z, 0, 0, 0, 0, 1)
    j2k.group.quaternion.setFromRotationMatrix(_m4)
  }

  // cfg：{ ecef, j2000, equator, len, ecefColor, j2000Color }。改轴长：两套轴只改组缩放，赤道面重建（环距跟半径走）；改颜色：那一套重建
  function setRefAxes(o) {
    const next = { ...REF_AXES_DEF, ...(o || {}) }
    next.len = clampLen(next.len)
    if (ecef && (!next.ecef || next.ecefColor !== cfg.ecefColor)) { disposeSet(ecef); ecef = null }
    if (j2k && (!next.j2000 || next.j2000Color !== cfg.j2000Color)) { disposeSet(j2k); j2k = null }
    if (eq && (!next.equator || next.len !== cfg.len)) { disposeSet(eq); eq = null }
    cfg = next
    if (cfg.ecef && !ecef) ecef = buildFrame(ECEF_DIRS, 'ECEF', cfg.ecefColor)
    if (cfg.j2000 && !j2k) { j2k = buildFrame(LOCAL_DIRS, 'J2000', cfg.j2000Color); applyJ2000() }
    if (cfg.equator && !eq) eq = buildEquator(cfg.len)
    if (ecef) ecef.group.scale.setScalar(cfg.len)
    if (j2k) {
      j2k.group.scale.setScalar(cfg.len)
      j2k.meshes[0].material.uniforms.uBias.value = ecef ? 2.2 : 0   // 两套同屏才挪（见文件头）：单开 J2000 时与地球的遮挡关系一点不动
    }
  }
  // 每拍：J2000 三根轴在场景里的方向（三个单位矢量，场景轴）
  function setJ2000Axes(dirs) {
    if (!dirs || dirs.length !== 3) return
    for (let k = 0; k < 3; k++) j2kDirs[k].set(dirs[k][0], dirs[k][1], dirs[k][2]).normalize()
    applyJ2000()
  }

  // 聚焦卫星 RIC 三轴：st = { p:[x,y,z]（场景）, R, I, C（场景单位矢量）} | null
  function setSatTriad(st, o) {
    if (o) triadCfg = { ...SAT_TRIAD_DEF, ...o }
    triadState = st && triadCfg.on ? { p: new THREE.Vector3(st.p[0], st.p[1], st.p[2]), dirs: [st.R, st.I, st.C].map((d) => new THREE.Vector3(d[0], d[1], d[2]).normalize()) } : null
    if (triadState && !triad) {
      const group = new THREE.Group()
      const mesh = arrowMesh(LOCAL_DIRS, RIC_COLOR, TRIAD_ARROW, ORDER.triad)
      group.add(mesh)
      const labels = ['R', 'I', 'C'].map((a, k) => { const s = makeLabel(a, '', RIC_INK[k], false); scene.add(s); return { s, k } })
      scene.add(group)
      triad = { group, meshes: [mesh], lines: [], labels }
    }
    if (triad) {
      triad.group.visible = !!triadState
      if (triadState) {
        const [a, b, c] = triadState.dirs
        _m4.set(a.x, b.x, c.x, 0, a.y, b.y, c.y, 0, a.z, b.z, c.z, 0, 0, 0, 0, 1)
        triad.group.quaternion.setFromRotationMatrix(_m4)
        triad.group.position.copy(triadState.p)
      } else for (const l of triad.labels) l.s.visible = false
    }
  }

  // 世界点 → 屏幕 CSS px（y 朝上）；在相机背后 / 远裁剪面外返回 false
  function toScreen(P, camera, W, H, out) {
    _ndc.copy(P).project(camera)
    if (!(_ndc.z > -1 && _ndc.z < 1)) return false
    out.set((_ndc.x * 0.5 + 0.5) * W, (_ndc.y * 0.5 + 0.5) * H)
    return true
  }
  // 一枚字标：锚在锥尖、沿「原点 → 锥尖」的屏幕方向排在外侧；与本帧已摆好的字标相撞就沿该方向外推
  function putLabel(l, tip, org, camera, W, H, k) {
    const s = l.s, u = s.userData
    if (occluded(tip) || !toScreen(tip, camera, W, H, _a)) { s.visible = false; return }
    let ux = 0, uy = 0
    if (toScreen(org, camera, W, H, _b)) { ux = _a.x - _b.x; uy = _a.y - _b.y }
    const n = Math.hypot(ux, uy)
    if (n > 1) { ux /= n; uy /= n } else { ux = Math.SQRT1_2; uy = Math.SQRT1_2 }   // 轴正对相机：排右上
    const [ox, oy] = labelOffset(ux, uy, u.iw, u.ih, LABEL_GAP)
    const [cx, cy] = clearAlong(_a.x + ox, _a.y + oy, ux, uy, u.iw, u.ih, placed)
    placed.push({ x: cx, y: cy, w: u.iw, h: u.ih })
    const w = u.pxH * u.ar, h = u.pxH
    s.center.set(0.5 - (cx - _a.x) / w, 0.5 - (cy - _a.y) / h)
    s.position.copy(tip)
    s.scale.set(w * k, h * k, 1)
    s.visible = true
  }

  // 逐帧（loop / snapshot / capture 与 rescaleMarkers 同一处）：箭头像素尺度、字标排位与遮挡、RIC 三轴屏幕定长。
  // following：跟随视图里不画 RIC（跟随 HUD 自有 LVLH）
  function update(camera, curH, following) {
    const H = Math.max(1, curH), W = H * camera.aspect
    const k = 2 * Math.tan(camera.fov * Math.PI / 360) / H
    for (const m of mats) { m.uniforms.uPx.value = k; m.uniforms.uNear.value = camera.near }
    camera.updateMatrixWorld()                   // 字标按本帧机位投影（controls.update 之后 matrixWorld 要到出帧才刷）
    placed.length = 0
    if (ecef) for (const l of ecef.labels) putLabel(l, _t.copy(ECEF_DIRS[l.k]).multiplyScalar(cfg.len), ORIGIN, camera, W, H, k)
    if (j2k) for (const l of j2k.labels) putLabel(l, _t.copy(j2kDirs[l.k]).multiplyScalar(cfg.len), ORIGIN, camera, W, H, k)
    if (triad) {
      const on = !!triadState && !following
      triad.group.visible = on
      if (!on) for (const l of triad.labels) l.s.visible = false
      else {
        const L = triadCfg.px * camera.position.distanceTo(triadState.p) * k
        triad.group.scale.setScalar(L)
        for (const l of triad.labels) putLabel(l, _t.copy(triadState.p).addScaledVector(triadState.dirs[l.k], L), triadState.p, camera, W, H, k)
      }
    }
  }

  function dispose() {
    disposeSet(ecef); disposeSet(j2k); disposeSet(eq); disposeSet(triad)
    ecef = j2k = eq = triad = null
  }
  return { setRefAxes, setJ2000Axes, setSatTriad, update, dispose }
}
