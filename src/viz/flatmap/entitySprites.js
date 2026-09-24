// 平面图（2D）上的标记实体模型图：地球站 / 点标记 / 航迹载具挂了 3D 模型时，平面图不再画通用符号，改画【这件模型的正射俯视图】。
//
// 口径（与 3D 球上的实体模型图标 globe3d/entityLayer.js 是同一件东西、同一把尺）：
//   · 视角：正射、从天顶往下看 —— 地图本身就是俯视的平面，Cesium 的 2D 模式画 glTF 模型即此画法（ArcGIS Pro 在 2D 地图里
//     也是把 3D 模型符号画成一张平面图像）。屏幕上方 = 本体 +X 转过 rot（载具 = 机头 / 船艏在图上的走向；站 / 点 = 正北在图上的
//     走向），屏幕右方 = 本体 +Y（右舷 / 正东）。真实的站在卫星影像底图上也正是这个样子（一枚仰着的白色碟面）。
//   · 尺寸：px = 包围球直径的屏幕像素（包围球 = 本体系可见几何外包盒的外接球，与 entityLayer 的 radius 同一个），
//     平面图再乘它顶替的那枚符号同一条缩放联动（克制版 iz，页面算好放进 px）。
//   · 锚点：entityRuntime.anchorBodyOf（datum 挂点 / 飞机盒心 / 盒底 · 方位轴），俯视下取它的水平投影落在站址 / 航迹点上。
//   · 姿态：载具按航向；站有方位 / 俯仰关节的按 solveAim 驱动关节（与 3D 同一个解、同一条停放律，只是不做过渡动画），
//     没有关节的整体转方位；船按吃水线（过锚点的水平面）裁掉水下部分（与 3D 的 aClip 同口径）。飞机的高度 / 俯仰俯视下看不出，不管。
//   · 光照：与 entityLayer「晨昏效果关 = 全亮」那一档同一套 —— 相机头灯 3.0（相机系 HEADLIGHT_C：从屏幕左上方来，恰是制图惯用的
//     西北光）+ 环境光 0x9fb4d8 × 0.14 + RoomEnvironment 环境反射 0.45，ACES、曝光 1.0。灯钉在屏幕上：载具转向时光不跟着转 ——
//     所以按转角逐档出图，而不是出一张图拿去旋转（那样机翼的亮面会随航向翻到右下）。
//   · 描边：与 3D 图标同一套制图套色 —— 内圈 1.3 px @ 0.62、外晕 3.0 px @ 0.2，色 rgb(6,11,18)（屏幕 CSS px）。
//
// 出图：独立的离屏 WebGLRenderer（第一次要图时才建；平面图上没有挂模型的实体时一个上下文都不开）。一张图 = 挂上 → 正射出图
//   （2× 超采样，亚像素细件——馈源支杆、桁架——不断成虚线）→ 2D 画布高质量缩到目标分辨率 → 按 alpha 裁边 → 套描边 →
//   存成一张 <canvas>（svgcanvas 导出矢量 PDF 只认 CANVAS / IMG，OffscreenCanvas / ImageBitmap 进不去）。
//   缓存键 = 模型 × 类别 × 转角档（2°）× 关节档（2°）× 尺寸档（每倍频 8 档）× 像素倍率；取图时差出来的零头（≤ 1° 转角 /
//   ≤ 4.5 % 缩放）画时补上。
//   预算：同一趟重画（beginPass 之后）里当场出图累计 ≤ 8 ms，超出的排进队列、之后每帧（rAF）≤ 6 ms 补出，出好一批回调 onChange
//   （平面图只重画文字层）。排队期间先拿这个实体上一次画过的那张顶着（按新的转角 / 尺寸补），再没有才退回通用符号 —— 换档不闪。
//   导出（mode 'sync'）一律当场出图、不看预算；模型还没取到时照样退回通用符号。
// 模型：借 modelLayer.source（与卫星图标、实体层共用一份缓存 / 元数据 / 就绪通知），取 lod2；着色器先在后台预编（compileAsync），
//   编好前不当场出图（第一次同步编译能卡几十上百毫秒）。最后一次要图后 60 s 没人用就把实例还回去、放掉本 renderer 里的 GPU 副本
//   （gpuRelease：只动本 renderer，别处的副本与监听原样不动）。
//
// 模块顶层不碰 DOM / WebGL：分档 / 画时描述 / 站姿态 / 挂架矩阵这些纯函数单独导出（node 可直接 import 验算）。
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { modelToBodyMatrix, BODY_TO_DISPLAY } from '../models/view.js'
import { applyRestPose, poseArticulations } from '../models/thumbs.js'
import { createGpuReleaser } from '../models/gpuRelease.js'
import { anchorBodyOf, aimRigOf, makeAimState, solveAim, parkAim, jointValuesOf } from '../../../packages/core/models/entityRuntime.mjs'

const DEG = Math.PI / 180
export const ROT_STEP = 2            // 转角分档（度）：画时补的零头 ≤ 1°
export const JOINT_STEP = 2          // 关节分档（度）
export const SIZE_OCT = 8            // 尺寸档：每倍频 8 档（相邻差 9 %，画时缩放 ≤ 4.5 %）
const SS_MAX = 2                     // 超采样倍数
const GL_MAX = 2048                  // 离屏画布边长上限（大图降超采样倍数）
const PASS_MS = 8                    // 同一趟重画里当场出图的预算（ms）
const PUMP_MS = 6                    // 排队补出：每帧预算（ms）
const RELEASE_MS = 60000             // 模型 / 实体状态最后一次被用到后留 60 s
const SWEEP_MS = 10000
const CACHE_PIX = 16 * 1024 * 1024   // 缓存上限：像素（≈ 64 MB）
const CACHE_N = 2048                 // 缓存上限：张数
const ALPHA_MIN = 8                  // 裁边阈值（0–255）
// 描边（= entityLayer HALO_*，屏幕 CSS px）
export const HALO_R1 = 1.3, HALO_R2 = 3.0, HALO_A1 = 0.62, HALO_A2 = 0.2
const HALO_RGB = 'rgb(6,11,18)'
// 内圈叠在外晕上：两层 source-over 叠出来是 a1' + a2·(1 − a1')，要它等于 3D 那边的 max(a1, a2) = a1 → a1' = (a1 − a2) / (1 − a2)
export const HALO_A1_OVER = (HALO_A1 - HALO_A2) / (1 - HALO_A2)
// 打光（= entityLayer ENV_I / SUN_I / AMB_*）；头灯方向 = entityLayer HEADLIGHT_C（相机系：右 −0.5、上 0.65、朝观者 0.85）
const ENV_I = 0.45, SUN_I = 3.0, AMB_C = 0x9fb4d8, AMB_I = 0.14
const HEAD_C = [-0.5, 0.65, 0.85]

// ───────────────────────────── 纯函数（node 可测） ─────────────────────────────

/** 转角（度，屏幕正上起顺时针，任意范围）→ 档：deg = 档中心 ∈ [0, 360)，res = 零头 ∈ [−ROT_STEP/2, ROT_STEP/2]（画时补） */
export function rotBucket(deg, out = { deg: 0, res: 0 }) {
  let d = Number.isFinite(deg) ? deg % 360 : 0
  if (d < 0) d += 360
  let b = Math.round(d / ROT_STEP) * ROT_STEP
  if (b >= 360) b -= 360
  let r = d - b
  if (r > 180) r -= 360; else if (r < -180) r += 360
  out.deg = b; out.res = r
  return out
}
/** 包围球直径（设备 px）→ 尺寸档（设备 px，整数；非正 → 0） */
export function sizeBucket(devPx) {
  if (!(devPx > 0) || !Number.isFinite(devPx)) return 0
  return Math.max(4, Math.round(Math.pow(2, Math.round(Math.log2(devPx) * SIZE_OCT) / SIZE_OCT)))
}
/** 关节值（度）→ 档中心；NaN（静止位姿）原样 */
export const jointBucket = (v) => (Number.isFinite(v) ? Math.round(v / JOINT_STEP) * JOINT_STEP : NaN)

/**
 * 缓存里的一张图 → 画时描述（CSS px，相对锚点、y 向下）：画 = translate(锚点) · rotate(rot) · drawImage(canvas, dx, dy, dw, dh)。
 * 图按 Db 设备 px 的包围球直径出、请求要 px CSS px —— 一个图像素恰是 px / Db 个 CSS px（与两边的像素倍率无关）。
 * l / r / u / d = 可见外廓离锚点的距离（含内圈描边、不含外晕）：标注让位与命中用。
 * @param {object} S  缓存项
 * @param {number} px 请求的包围球直径（CSS px）
 * @param {number} resDeg 画时补的转角零头（度，顺时针）
 */
export function drawDesc(S, px, resDeg) {
  const f = px / S.Db
  return {
    canvas: S.canvas, dx: -S.ax * f, dy: -S.ay * f, dw: S.w * f, dh: S.h * f, rot: (resDeg || 0) * DEG,
    l: S.el * f, r: S.er * f, u: S.eu * f, d: S.ed * f
  }
}

/** 站姿态的每站状态（跨帧保留：关节解离上一次最近、停放时方位保持、无关节整体转方位时的上一个航向） */
export function makeStationPose() { return { yaw: NaN, a1: NaN, a2: NaN, aim: makeAimState(), _d: [0, 0, 0] } }
/**
 * 站在平面图上的姿态：与 entityLayer.refreshAim 同一条律（去掉目标切换时的一阶过渡 —— 平面图按帧出静图，不演动画）。
 *   有方位 / 俯仰关节（rig）：没有读数 → 静止位姿（a1 = a2 = NaN）；停放（仰角 < 0 / 没有目标）→ parkAim；
 *     否则画面口径方位 / 仰角转回本体（NED：北、东、下）视线 → solveAim（限位内、离上一次最近）。整体不转（yaw = 0）。
 *   没有关节：没有读数 → yaw = 0（静止）；有读数且没停放 → yaw = 方位；停放 → 保持上一次（首次 0）。
 * @param {object|null} rig  entityRuntime.aimRigOf(meta)
 * @param {{az:number, el:number, park:boolean}|null} aim  度
 * @param {object} st makeStationPose()
 */
export function stationPoseOf(rig, aim, st) {
  if (rig) {
    st.yaw = 0
    if (!aim) { st.a1 = NaN; st.a2 = NaN; return st }
    let ok = true
    try {
      if (aim.park || !Number.isFinite(aim.az) || !Number.isFinite(aim.el)) parkAim(rig, st.aim)
      else {
        const az = aim.az * DEG, el = aim.el * DEG, ce = Math.cos(el), d = st._d
        d[0] = ce * Math.cos(az); d[1] = ce * Math.sin(az); d[2] = -Math.sin(el)
        solveAim(rig, d, st.aim)
      }
    } catch { ok = false }
    st.a1 = ok && Number.isFinite(st.aim.a1) ? st.aim.a1 : NaN
    st.a2 = ok && Number.isFinite(st.aim.a2) ? st.aim.a2 : NaN
    return st
  }
  st.a1 = NaN; st.a2 = NaN
  if (!aim) st.yaw = 0
  else if (!aim.park && Number.isFinite(aim.az)) st.yaw = aim.az
  else if (!Number.isFinite(st.yaw)) st.yaw = 0
  return st
}

const _pT = new THREE.Matrix4(), _pR = new THREE.Matrix4(), _pv = new THREE.Vector3()
/**
 * 挂架矩阵（模型系 → 出图世界系，米）：世界系 = 显示系（view.js：+Y 天顶、本体 +X ↦ +X、本体 +Y ↦ +Z），原点 = 锚点；
 * 俯视相机在 +Y 往下看、屏幕上方 = +X、屏幕右方 = +Z。
 *   H = RotY(−rot) · T(−BODY_TO_DISPLAY · 锚点) · BODY_TO_DISPLAY · MB
 * rot（度）俯视顺时针为正：本体 +X 从屏幕上方转向右方（= 罗盘航向的转法）。
 */
export function planMatrix(MB, anchorBody, rotDeg, out = new THREE.Matrix4()) {
  _pv.set(anchorBody[0], anchorBody[1], anchorBody[2]).applyMatrix4(BODY_TO_DISPLAY)
  out.multiplyMatrices(BODY_TO_DISPLAY, MB)
  out.premultiply(_pT.makeTranslation(-_pv.x, -_pv.y, -_pv.z))
  out.premultiply(_pR.makeRotationY(-(Number.isFinite(rotDeg) ? rotDeg : 0) * DEG))
  return out
}

// 本体系（米）可见几何外包盒：与 entityLayer.bodyBox 同口径（逐网格几何包围盒八角变过去再并）—— 两边的包围球是同一个，px 才是同一把尺
const _bb = new THREE.Box3(), _bm = new THREE.Matrix4()
export function bodyBox(root, MB) {
  const out = new THREE.Box3()
  root.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
    _bb.copy(o.geometry.boundingBox).applyMatrix4(_bm.multiplyMatrices(MB, o.matrixWorld))
    out.union(_bb)
  })
  return out
}

/**
 * 模型 → 出图要用的几何量：本体系外包盒、盒心 c、包围球半径 R（盒心到八角的最远距离，= entityLayer radius）。
 * root 须已摆静止位姿、世界矩阵是新的。
 */
export function modelGeom(root, MB) {
  const b = bodyBox(root, MB)
  if (b.isEmpty()) return { box: { min: [-1, -1, -1], max: [1, 1, 1] }, c: [0, 0, 0], R: Math.sqrt(3) }
  const c = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2]
  let R = 0
  for (let i = 0; i < 8; i++) {
    const x = (i & 1 ? b.max.x : b.min.x) - c[0], y = (i & 2 ? b.max.y : b.min.y) - c[1], z = (i & 4 ? b.max.z : b.min.z) - c[2]
    R = Math.max(R, Math.sqrt(x * x + y * y + z * z))
  }
  return { box: { min: b.min.toArray(), max: b.max.toArray() }, c, R: R > 0 ? R : 1 }
}

/** 锚点（本体系里落在站址 / 航迹点上的那一点）：entityRuntime.anchorBodyOf，取不出时按 entityLayer 的兜底（盒心 / 盒底） */
export function anchorFor(meta, box, kind) {
  let a = null
  try { a = anchorBodyOf({ attachPoints: meta && meta.attachPoints, box, modelKind: meta && meta.kind }, kind, { pos: [0, 0, 0], src: '', liftM: 0 }) } catch { a = null }
  if (a && a.pos && a.pos.every(Number.isFinite)) return [a.pos[0], a.pos[1], a.pos[2]]
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, kind === 'aircraft' ? (box.min[2] + box.max[2]) / 2 : box.max[2]]
}

// ───────────────────────────── 出图器 ─────────────────────────────
/**
 * @param {{source:{acquire:Function, forget?:Function, onReady?:Function}, onChange?:Function}} o
 * @returns {{beginPass:Function, get:Function, setOnChange:Function, refreshModel:Function, stats:Function, dispose:Function, _debug:object}}
 */
export function createEntitySprites(o = {}) {
  const source = o.source || null
  let onChange = typeof o.onChange === 'function' ? o.onChange : null
  let disposed = false
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

  const models = new Map()       // 模型 id → M
  const cache = new Map()        // 缓存键 → S（Map 次序即 LRU：命中挪到尾）
  const queue = new Map()        // 缓存键 → 待出图项
  const ents = new Map()         // 实体键（'st:' / 'pt:' / 'tr:' + id）→ {pose, last, used}
  let cachePix = 0, gen = 0, passUsed = 0
  let renders = 0, renderMs = 0, raf = 0, sweepT = 0

  // ───────── 离屏 GL（第一次要出图时才建）─────────
  let G = null, glDead = false, lost = false
  function ensureGl() {
    if (G || glDead || disposed) return G
    if (typeof document === 'undefined') { glDead = true; return null }
    try {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 256
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'default' })
      renderer.setPixelRatio(1)
      renderer.setSize(256, 256, false)
      renderer.setClearColor(0x000000, 0)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.0
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true })
      // 上下文回来：three 自己重新上传资源；已出好的图是 2D 画布、不受影响，只把「预编过」的标记清掉
      canvas.addEventListener('webglcontextrestored', () => { lost = false; for (const M of models.values()) { M.warm = false; if (M.state === 'ready') warm(M) } })
      const gpu = createGpuReleaser(renderer)
      const scene = new THREE.Scene()
      const pm = new THREE.PMREMGenerator(renderer)
      const room = new RoomEnvironment()
      const env = pm.fromScene(room, 0.04)
      room.dispose(); pm.dispose()
      scene.environment = env.texture
      scene.environmentIntensity = ENV_I
      // 头灯钉在屏幕上：俯视相机系（右, 上, 朝观者）= 世界（+Z, +X, +Y）
      const key = new THREE.DirectionalLight(0xffffff, SUN_I)
      key.position.set(HEAD_C[1], HEAD_C[2], HEAD_C[0]).normalize().multiplyScalar(10)
      scene.add(key, key.target, new THREE.AmbientLight(AMB_C, AMB_I))
      const holder = new THREE.Group()
      holder.matrixAutoUpdate = false
      scene.add(holder)
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
      cam.up.set(1, 0, 0)   // 屏幕上方 = 世界 +X
      const clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)]   // 船：只留锚点所在水平面（吃水线）以上
      G = { canvas, renderer, gpu, scene, env, holder, cam, clip, side: 256, sc: null, mdl: null, sil: null, acc: null }
    } catch (e) {
      console.warn('[entitySprites] 离屏渲染器创建失败，平面图照画通用符号：' + ((e && e.message) || e))
      glDead = true; G = null
    }
    return G
  }
  function ensureSide(n) {
    if (G.side >= n) return
    let s = G.side
    while (s < n) s *= 2
    s = Math.min(s, GL_MAX)
    G.renderer.setSize(s, s, false)
    G.side = s
  }
  // 2D 暂存画布（复用；缩图那张要逐像素读 alpha → willReadFrequently，一开始就走 CPU 那一路）
  function scratch(k, w, h, read) {
    let c = G[k]
    if (!c) { c = document.createElement('canvas'); G[k] = c; c._ctx = c.getContext('2d', read ? { willReadFrequently: true } : undefined) }
    const x = c._ctx
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h }   // 改尺寸即清空并复位状态
    else { x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, w, h) }
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'
    return c
  }

  // ───────── 模型 ─────────
  function newModel(id) {
    const M = { id, state: 'idle', req: 0, inst: null, root: null, meta: null, MB: null, rig: null, box: null, c: [0, 0, 0], R: 1,
      anchors: {}, poseMap: null, jv: {}, poseSig: '', warm: false, used: now(), noneAt: 0, onUp: null }
    M.onUp = () => { if (!disposed && M.state !== 'dead') load(M) }
    return M
  }
  function modelOf(id) {
    let M = models.get(id)
    if (!M) { M = newModel(id); models.set(id, M); armSweep() }
    M.used = now()
    if (M.state === 'idle') load(M)
    return M
  }
  async function load(M) {
    const req = ++M.req
    if (!M.inst) M.state = 'loading'   // 有旧实例（工作台改了模型）：新的就绪前旧图照用
    let inst = null
    try { inst = source && typeof source.acquire === 'function' ? await source.acquire(M.id, 'lod2', M.onUp) : null } catch { inst = null }
    if (disposed || req !== M.req || M.state === 'dead') { if (inst) { try { inst.release() } catch { /* ignore */ } } return }
    if (!inst) { if (!M.inst) { M.state = 'none'; M.noneAt = now() } return }   // 没有模型（未下载 / 已移除）：通用符号照画；下载好了 onReady 再来
    let P
    try {
      const meta = inst.meta || {}
      const root = inst.root
      if (root.parent) root.parent.remove(root)
      const poseMap = new Map()
      try { applyRestPose(root, meta, { pose: poseMap }) } catch { /* 关节数据坏：按文件位姿画 */ }
      root.updateMatrixWorld(true)
      const MB = modelToBodyMatrix(meta, new THREE.Matrix4())
      let rig = null
      try { rig = aimRigOf(meta) || null } catch { rig = null }
      P = { root, meta, MB, rig, poseMap, ...modelGeom(root, MB) }
    } catch (e) {
      console.warn('[entitySprites] 模型准备失败：' + M.id + ' ' + ((e && e.message) || e))
      try { inst.release() } catch { /* ignore */ }
      if (!M.inst) M.state = 'none'
      return
    }
    releaseInst(M)
    Object.assign(M, P)
    M.inst = inst; M.anchors = {}; M.jv = {}; M.poseSig = ''; M.warm = false; M.state = 'ready'
    dropModel(M.id)
    warm(M)
  }
  // 着色器预编（后台，KHR_parallel_shader_compile）：挂在一个临时场景里、灯光与环境取出图场景的（compile 的 targetScene），
  // 编好前这件模型不当场出图 —— 第一次同步编译一组 PBR 程序能卡几十上百毫秒
  async function warm(M) {
    const g = ensureGl()
    if (!g || lost || typeof g.renderer.compileAsync !== 'function') { M.warm = true; kick(); return }
    const req = M.req
    const hold = new THREE.Group()
    hold.matrixAutoUpdate = false
    hold.matrix.multiplyMatrices(BODY_TO_DISPLAY, M.MB)
    const ws = new THREE.Scene()
    ws.add(hold); hold.add(M.root)
    try { await g.renderer.compileAsync(ws, g.cam, g.scene) } catch { /* 编不过：交给出图时同步编 */ } finally {
      if (M.root && M.root.parent === hold) hold.remove(M.root)
    }
    if (disposed || req !== M.req) return
    M.warm = true
    kick()
  }
  function releaseInst(M) {
    if (M.root && G) { try { G.gpu.releaseTree(M.root, { kinds: ['geo', 'tex'], keepShared: true }) } catch { /* ignore */ } }
    if (M.inst) { try { M.inst.release() } catch { /* ignore */ } }
    M.inst = null; M.root = null
  }
  function releaseModel(M) {
    M.state = 'dead'; M.req++
    dropModel(M.id)
    releaseInst(M)
    if (source && typeof source.forget === 'function') source.forget(M.onUp)
    models.delete(M.id)
    for (const E of ents.values()) if (E.last && E.last.id === M.id) E.last = null
  }
  function dropModel(id) {
    for (const [k, S] of cache) if (S.id === id) { cache.delete(k); cachePix -= S.pix }
    for (const [k, it] of queue) if (it.M.id === id) queue.delete(k)
  }
  const offReady = source && typeof source.onReady === 'function'
    ? source.onReady((id) => { const M = models.get(id); if (M && M.state === 'none') load(M) })
    : null

  // ───────── 出图 ─────────
  const _H = new THREE.Matrix4()
  function poseModel(M, a1, a2) {
    if (!M.rig || !M.meta || !Array.isArray(M.meta.articulations)) return
    const sig = a1 + ',' + a2
    if (sig === M.poseSig) return
    const vals = Number.isFinite(a1) && Number.isFinite(a2) ? jointValuesOf(M.rig, a1, a2, M.jv) : null
    poseArticulations(M.root, M.meta.articulations, vals, { pose: M.poseMap })
    M.poseSig = sig
  }
  /**
   * 当场出一张图（同步：挂上 → 画 → 缩 → 裁 → 描边 → 摘）。返回缓存项；画面里一个像素都没有时返回 {empty: true}。
   * @param {number} rot 转角档（度）  @param {number} a1 / a2 关节档（度，NaN = 静止位姿）
   * @param {number} Db 包围球直径（设备 px）  @param {number} s 像素倍率（设备 px / CSS px：描边宽按它折）
   */
  function renderSprite(M, kind, rot, a1, a2, Db, s) {
    const g = ensureGl()
    if (!g || lost || !M.root) return null
    const t0 = now()
    let anc = M.anchors[kind]
    if (!anc) { anc = anchorFor(M.meta, M.box, kind); M.anchors[kind] = anc }
    poseModel(M, a1, a2)
    // 画布：锚点居中；半边 =（包围球半径 + 锚点到球心的水平距）× 每米像素 —— 任何转角 / 关节位姿都框得住，出完再按 alpha 裁
    const ppm = Db / (2 * M.R)
    const half = Math.ceil((M.R + Math.hypot(anc[0] - M.c[0], anc[1] - M.c[1])) * ppm) + 2
    const W = 2 * half
    const GW = Math.min(GL_MAX, Math.ceil(W * SS_MAX))
    ensureSide(GW)
    const hm = half / ppm                       // 世界系半边（米）：W 设备 px ↔ 2·hm 米，像素网格对齐锚点
    const cam = g.cam
    cam.left = -hm; cam.right = hm; cam.top = hm; cam.bottom = -hm
    const yc = anc[2] - M.c[2]                  // 球心的世界 y（显示 y = −本体 z，原点在锚点）
    const m = 0.05 * M.R + 0.01
    const camY = Math.max(yc + M.R + m, m)      // 相机在包围球顶上（锚点若在球外上方也不越过原点，lookAt 不退化）
    cam.position.set(0, camY, 0)
    cam.near = 0.5 * m; cam.far = camY - (yc - M.R - m)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix(); cam.updateMatrixWorld(true)
    g.holder.matrix.copy(planMatrix(M.MB, anc, rot, _H))
    g.holder.matrixWorldNeedsUpdate = true
    g.holder.add(M.root)
    const r = g.renderer, side = g.side
    r.clippingPlanes = kind === 'ship' ? g.clip : []
    try {
      r.setViewport(0, side - GW, GW, GW)       // GL 视口原点在左下：画进画布左上那一块
      r.setScissor(0, side - GW, GW, GW)
      r.setScissorTest(true)
      r.clear(true, true, false)
      r.render(g.scene, cam)
    } finally {
      g.holder.remove(M.root)
      r.setScissorTest(false)
      r.clippingPlanes = []
    }
    // 缩到目标分辨率（超采样的下采样）→ 读 alpha 求包围框
    const sc = scratch('sc', W, W, true), c2 = sc._ctx
    c2.drawImage(g.canvas, 0, 0, GW, GW, 0, 0, W, W)
    const px = c2.getImageData(0, 0, W, W).data
    let x0 = W, y0 = W, x1 = -1, y1 = -1
    for (let y = 0; y < W; y++) {
      const row = y * W * 4
      for (let x = 0; x < W; x++) {
        if (px[row + x * 4 + 3] <= ALPHA_MIN) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        y1 = y
      }
    }
    if (x1 < 0) return { empty: true, id: M.id, pix: 0 }
    // 裁边 + 描边：外晕、内圈、模型本体三层（剪影 = 模型 alpha 灌上套色；膨胀 = 剪影绕一圈平移叠画）
    const r1 = HALO_R1 * s, r2 = HALO_R2 * s
    const pad = Math.ceil(r2 + 1)
    const w = x1 - x0 + 1 + 2 * pad, h = y1 - y0 + 1 + 2 * pad
    const mdl = scratch('mdl', w, h)
    mdl._ctx.drawImage(sc, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1)
    const sil = scratch('sil', w, h), sx = sil._ctx
    sx.drawImage(mdl, 0, 0)
    sx.globalCompositeOperation = 'source-in'; sx.fillStyle = HALO_RGB; sx.fillRect(0, 0, w, h)
    sx.globalCompositeOperation = 'source-over'
    const out = document.createElement('canvas')
    out.width = w; out.height = h
    const oc = out.getContext('2d')
    const acc = scratch('acc', w, h), ac = acc._ctx
    const dilate = (ra, rb) => {
      ac.clearRect(0, 0, w, h)
      ac.drawImage(sil, 0, 0)
      for (let k = 0; k < 12; k++) {
        const t = k * Math.PI / 6, cx = Math.cos(t), cy = Math.sin(t)
        ac.drawImage(sil, cx * ra, cy * ra)
        ac.drawImage(sil, cx * rb, cy * rb)
      }
    }
    dilate(r2, 0.5 * (r1 + r2)); oc.globalAlpha = HALO_A2; oc.drawImage(acc, 0, 0)
    dilate(r1, 0.5 * r1); oc.globalAlpha = HALO_A1_OVER; oc.drawImage(acc, 0, 0)
    oc.globalAlpha = 1; oc.drawImage(mdl, 0, 0)
    // 锚点在缩图里恰是正中（half, half）；外廓按锚点四向量（锚点偶尔落在形体外沿之外：那一侧记 0，不给负距离）
    const S = {
      id: M.id, kind, canvas: out, w, h, ax: half - x0 + pad, ay: half - y0 + pad,
      el: Math.max(0, half - x0) + r1, er: Math.max(0, x1 + 1 - half) + r1, eu: Math.max(0, half - y0) + r1, ed: Math.max(0, y1 + 1 - half) + r1,
      Db, s, rot, a1, a2, pix: w * h, gen
    }
    renders++
    renderMs += (now() - t0 - renderMs) * 0.1
    return S
  }
  function put(key, S) {
    cache.set(key, S)
    cachePix += S.pix || 0
    if (cachePix > CACHE_PIX || cache.size > CACHE_N) {
      for (const [k, T] of cache) {
        if (cachePix <= CACHE_PIX * 0.8 && cache.size <= CACHE_N * 0.8) break
        if (T.gen >= gen - 1) continue   // 这一趟 / 上一趟还在画的不动
        cache.delete(k); cachePix -= T.pix || 0
      }
    }
  }

  // ───────── 排队补出 ─────────
  function kick() { if (!disposed && onChange) { try { onChange() } catch { /* ignore */ } } }
  function schedule() {
    if (raf || disposed || typeof requestAnimationFrame !== 'function') return
    raf = requestAnimationFrame(pump)
  }
  function pump() {
    raf = 0
    if (disposed) return
    const t0 = now()
    let made = 0, more = false
    for (const [key, it] of queue) {
      if (now() - t0 > PUMP_MS) { more = true; break }
      const M = it.M
      if (it.gen < gen - 1 || cache.has(key) || M.state !== 'ready' || lost) { queue.delete(key); continue }   // 过期 / 已出 / 模型不在了
      if (!M.warm) continue                                                                                 // 着色器还在后台编：编好会 kick
      queue.delete(key)
      let S = null
      try { S = renderSprite(M, it.kind, it.rot, it.a1, it.a2, it.Db, it.s) } catch (e) { console.warn('[entitySprites] 出图失败：' + M.id + ' ' + ((e && e.message) || e)) }
      if (S) { S.gen = it.gen; put(key, S); made++ }
    }
    if (made) kick()
    if (more) schedule()
  }

  // ───────── 清理（模型 / 实体状态 60 s 没人用就放掉）─────────
  function armSweep() { if (!sweepT && !disposed) sweepT = setTimeout(sweep, SWEEP_MS) }
  function sweep() {
    sweepT = 0
    if (disposed) return
    const t = now()
    for (const M of [...models.values()]) {
      if (t - M.used > RELEASE_MS) releaseModel(M)
      else if (M.state === 'none' && t - (M.noneAt || 0) > 30000) M.state = 'idle'   // 当时取不到（主进程还没起来 / 授权闸）：下次要图时再试一次
    }
    for (const [k, E] of ents) if (t - E.used > RELEASE_MS) ents.delete(k)
    if (models.size || ents.size) armSweep()
  }

  // ───────── 取图 ─────────
  const _rb = { deg: 0, res: 0 }
  // 实体上一次画过的那张（同一模型 / 类别）：按新的转角 / 尺寸补着画
  function fallback(E, q, rotDeg) {
    const S = E && E.last
    if (!S || S.empty || S.id !== q.id || S.kind !== q.kind) return null
    let r = rotDeg - S.rot
    r = ((r % 360) + 540) % 360 - 180
    return drawDesc(S, q.px, r)
  }
  /**
   * 取一个实体的模型图（同步；平面图画文字层 / 命中时调）。
   * @param {{id:string, kind:string, ent:string, rot:number, aim?:{az,el,park}|null, px:number, scale:number}} q
   *   id 模型 id；kind 'station' | 'point' | 'aircraft' | 'ship' | 'vehicle'；ent 实体键（跨帧状态）；rot 本体 +X 在图上的朝向（弧度，屏幕正上起顺时针）；
   *   aim 站对星（度，画面口径）；px 包围球直径（CSS px，已含缩放联动）；scale 设备 px / CSS px
   * @param {'draw'|'peek'|'sync'} [mode] draw：预算内当场出、超了排队；peek：只看缓存（命中判定），不出图、不排队；sync：当场出（导出）
   * @returns {object|null} drawDesc 的画时描述；null = 这一帧画通用符号
   */
  function get(q, mode = 'draw') {
    if (disposed || !q || !q.id || !(q.px > 0)) return null
    const scale = q.scale > 0 ? q.scale : 1
    const Db = sizeBucket(q.px * scale)
    if (!Db) return null
    const M = modelOf(String(q.id))
    let E = ents.get(q.ent)
    if (!E) { E = { pose: null, last: null, used: 0 }; ents.set(q.ent, E) }
    E.used = now()
    let yaw = 0, a1 = NaN, a2 = NaN
    if (q.kind === 'station' && M.state === 'ready') {
      if (!E.pose) E.pose = makeStationPose()
      stationPoseOf(M.rig, q.aim || null, E.pose)
      yaw = E.pose.yaw || 0
      a1 = jointBucket(E.pose.a1); a2 = jointBucket(E.pose.a2)
    }
    const rotDeg = (Number.isFinite(q.rot) ? q.rot / DEG : 0) + yaw
    rotBucket(rotDeg, _rb)
    const key = M.id + '|' + q.kind + '|' + _rb.deg + '|' + a1 + ',' + a2 + '|' + Db + '|' + Math.round(scale * 4)
    let S = cache.get(key)
    if (S) {
      cache.delete(key); cache.set(key, S)   // LRU：挪到尾
      S.gen = gen
      if (S.empty) return null
      E.last = S
      return drawDesc(S, q.px, _rb.res)
    }
    if (M.state !== 'ready' || lost || glDead || mode === 'peek') return fallback(E, q, rotDeg)
    if (mode === 'sync' || (M.warm && passUsed < PASS_MS)) {
      const t0 = now()
      let T = null
      try { T = renderSprite(M, q.kind, _rb.deg, a1, a2, Db, scale) } catch (e) {
        console.warn('[entitySprites] 出图失败：' + M.id + ' ' + ((e && e.message) || e))
        T = null
      }
      passUsed += now() - t0
      if (T) {
        T.gen = gen
        put(key, T)
        if (T.empty) return null
        E.last = T
        return drawDesc(T, q.px, _rb.res)
      }
      return fallback(E, q, rotDeg)
    }
    if (!queue.has(key)) queue.set(key, { M, kind: q.kind, rot: _rb.deg, a1, a2, Db, s: scale, gen })
    else queue.get(key).gen = gen
    schedule()
    return fallback(E, q, rotDeg)
  }

  return {
    /** 每趟重画文字层开头调一次：当场出图的预算从这里起算；排队项按趟次判过期 */
    beginPass() { gen++; passUsed = 0 },
    get,
    setOnChange(fn) { onChange = typeof fn === 'function' ? fn : null },
    /** 工作台存了元数据 / 清单变了：该模型（null = 全部）换新实例、旧图作废（参数化 param: / 实体模板 ent: 是现生成的，不随存盘变） */
    refreshModel(id) {
      for (const M of [...models.values()]) {
        if (id && M.id !== id) continue
        if (M.id.startsWith('param:') || M.id.startsWith('ent:')) continue
        if (M.state === 'none' || M.state === 'idle') { M.state = 'idle'; continue }
        dropModel(M.id)
        load(M)
      }
      kick()
    },
    stats() {
      let ready = 0
      for (const M of models.values()) if (M.state === 'ready') ready++
      return { models: models.size, ready, sprites: cache.size, pix: cachePix, queue: queue.size, ents: ents.size, renders, renderMs: +renderMs.toFixed(3), gl: !!G, lost, glDead }
    },
    dispose() {
      if (disposed) return
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
      raf = 0
      if (sweepT) { clearTimeout(sweepT); sweepT = 0 }
      for (const M of [...models.values()]) releaseModel(M)
      disposed = true
      cache.clear(); queue.clear(); ents.clear(); cachePix = 0
      if (offReady) { try { offReady() } catch { /* ignore */ } }
      if (G) {
        try { G.gpu.releaseAll() } catch { /* ignore */ }
        try { G.env.dispose() } catch { /* ignore */ }
        G.renderer.dispose()
        try { G.renderer.forceContextLoss() } catch { /* ignore */ }
        G = null
      }
      onChange = null
    },
    _debug: {
      keys: () => [...cache.keys()],
      sprite: (key) => cache.get(key) || null,
      model: (id) => { const M = models.get(id); return M ? { state: M.state, warm: M.warm, R: M.R, c: M.c.slice(), box: M.box, rig: !!M.rig, anchors: { ...M.anchors } } : null },
      ent: (k) => { const E = ents.get(k); return E ? { pose: E.pose ? { yaw: E.pose.yaw, a1: E.pose.a1, a2: E.pose.a2 } : null, last: E.last ? E.last.canvas : null } : null },
      gl: () => (G ? G.canvas : null)
    }
  }
}
