// 装配编辑器（P3，CONTRACT §5；assembly-ux §3.4 / §3.5 / §6）：借工作台视口（live 根）做「纯手动拖拽安装模块」。
//
// ─────────────── 结构 ───────────────
//   视口 holder ⊃ asmRoot（单位阵，本体系 = 文档坐标）
//     ├─ 条目组 × N（每个展开件一个，平铺不嵌套，名 = nodePrefix(id)；矩阵 = 渲染等式：pose.m，镜像派生件把镜面列取反）
//     │    └─ 组件子树（几何缓存模板的 clone，共享几何 / 材质 / BVH；节点名 `${前缀}_${短名}`）
//     └─ frameHolder ⊃ pivot（gizmo 代理：TransformControls 永远 local 空间挂在 pivot 上，frameHolder 按安装方式取系）
//   vp.scene ⊃ fxRoot（显示矩阵，第 1 层）：选中 / 悬停描边 / 穿插红 / 非法件占位 / ghost（asmLive.js）/ 原点三轴（深度测试那份）——不进网格表 / 包围盒 / 阴影 / AO
//   vp.overlay ⊃ 插座标记 / 目标面轮廓 / 吸附锚点 / 质心记号 / 原点三轴（35 % 常在最上层那份）（asmOverlay.js）+ TransformControls 手柄
//
// ─────────────── 状态机（assembly-ux §3.4）───────────────
//   idle ─(指针在件上)→ hover ─(左键点件)→ 选中 ─(按住 gizmo 手柄)→ gizmo ─(松手)→ idle
//   idle ─(库卡片越过 4 px：beginDragFromLib)→ ghost ─(松手在有效位 → 加件；无效位 / Esc → 取消)→ idle
//   选中 ─(G / Ctrl+D)→ pickup ─(左键 → 重新安装 / 复制；Esc / 右键 → 复原)→ idle
//   吸附优先级：插座（18 px）> 贴面（BVH 命中 + 面判据；面内推断点 12 px、否则面心起算的绝对网格）> 自由贴（命中件无匹配面）> 原点（空文档）；
//   候选切换带 4 px 滞回；命中派生件时把命中点 / 法向映回主件求安装语义（子件随对称继承自动出现在指针处）。
//
// ─────────────── 热路径（拖动每帧，全部在视口帧钩子里做）───────────────
//   就地改工作文档里那一个件的 attach.uv / roll / t / q → solvePose（稳态零分配）→ 逐条目拷 16 个数进矩阵 → 质量读数
//   → 质心记号 / 读数 → refreshLive({moved:true})。不重建树、不 applyFrame、不跑穿插。自己的代码不 new 向量 / 矩阵 / 数组 / 闭包：
//   暂存全部预分配；three / three-mesh-bvh 为命中结果分配的小对象不计。候选插座表、拾取包围球只在拖动开始 / 同步时建。
//   重活（逐顶点包围盒、接触阴影、BVH、穿插检测）只在松手 / 提交后做；穿插时间切片、下一次拖动开始即作废。
//   ★ 双精度不经实参传给大函数（未内联的调用会装箱）：面推断 / 夹紧 / 命中判据走 asmSnap 的 IO 形式（faceInferIO / clampIO /
//     faceAtHit 的 out.tol），记号坐标从数组读（marker.showAt / com.atArr）。
//   ★ 拾取先比包围球再下 BVH：three-mesh-bvh 的加速射线每个网格每次都新建三个类型数组视图，整星七十来个网格一条射线 25 KB。
//   ★ 拖入 / 拾起的质量读数：静态部分拖动开始时算一次 + 拖动件局部质量特性 × 各份渲染矩阵（asmSnap.massCombine）；
//     设了目标质量的拾起走整份 combineMass：换父件时解算计划重建，但生成缓存按「id + 组件定义」过继（assembly.getPlan），
//     再加模块级生成缓存，换一次父件 ≤ 1 ms，不再每换一次就把三十来件重新生成一遍（整星 7–13 ms、每次分配 ~28 MB）。
//   ★ 透明双面材质一律 forceSinglePass：否则 three 分两趟画、每趟之间重算程序缓存键，一件高亮每帧十几 KB 垃圾。
//   ★ TransformControls 的手柄只在有目标时挂进叠加层（它的 updateMatrixWorld 不看显隐、每帧都跑）。
//
// ─────────────── 与契约的出入（理由见各处注释）───────────────
//   · 淡染 / 描边 / ghost 放 vp.scene 里的 fxRoot（第 1 层），不挂 asmRoot 下：挂在 live 根里会进视口的网格表、包围盒、三角形数。
//   · 拾起不切第 1 层，改用拾取掩码排除移动子树（切层会让它在 AO / 阴影里闪一下）。
//   · 插座 / 贴面件的滚转按绝对角吸附（插座档 = 插座 roll、贴面档 = 旋转步长）；自由件用 TransformControls 的增量吸附。
//   · 带对称的件（工具栏对称的拖入件、自带对称的拾起件）几何落在对称面 / 轴上（KSP 堆叠节点口径；按包围盒中心判，不按原点——
//     机翼原点在中线上、几何在一侧，照样镜像）：这一次不带对称（拖动中只显示一份，拾起件提交即去掉对称）——副本会与原件重合。
//   · 边线 / BVH 在几何 Worker 里预先算好；ghost 材质副本按源材质常驻并异步预编译；叠加层 / gizmo 材质 attach 时预编译：交互那一帧不现建、不同步 link。
//   · 穿插：另跳过同一主件的对称副本之间；接触（面贴面、杆件端接）不报——B 件先各面收进 δ 再求交；MLI 包覆不参与。
//   · 贴面判据在面外侧让出一层蒙皮（min(5 cm, 3 % 件尺寸)）：平台体 MLI 离结构面 2 cm，只按 ±2 mm 判打不中面。
//
// ─────────────── 撤销 ───────────────
//   命令外壳 + 文档快照内核：{label, before, after, key, at}（JSON 串；相邻两条的 after / before 复用同一个串）；上限 100；setParams 同件同键 500 ms 内合并；一次拖动一条；
//   load 清空。撤销 / 重做 = 解析快照 → 同一条增量重建。与工作台元数据撤销栈完全分开。
//   文档没变的收尾（Esc 取消、点了手柄没拖、原地放下）照样同步，但 change 事件带 changed:false —— 会话不当作一次提交。
//
// ─────────────── 悬停 ───────────────
//   指针移动只排编辑器自己的 rAF 做一次拾取；悬停件真换了才刷叠加并请视口重画（鼠标在同一件上晃不画帧）。
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { normalizeAssembly, solvePose, combineMass, expandSymmetry, clearBuildCache } from '@core/models/assembly.mjs'
import { getComponent, fillParams, checkParams } from '@core/models/components/index.mjs'
import * as S from '@core/models/asmSnap.mjs'
import { poseArticulations, restoreFilePose } from './thumbs.js'
import { createGeomCache, fillEntry, prefixedArts, palette, createFxLayer, createGhostPool, FX, writeRenderMatrix } from './asmLive.js'
import { createAsmOverlay } from './asmOverlay.js'
import { createClashRunner } from './asmClash.js'

/** 编辑器挂 live 根时给视口的 meta：单位阵（live 根的子件直接就是本体系 / 文档坐标）。 */
const LIVE_META = Object.freeze({ frame: Object.freeze({ q_model2body: Object.freeze([0, 0, 0, 1]), t_model2body: Object.freeze([0, 0, 0]) }), units: Object.freeze({ scaleToMeters: 1 }) })
const KEY_SOCK = 1e6, KEY_FACE = 2e6, KEY_FREE = 3e6, KEY_ROOT = 4e6
const D2R = Math.PI / 180
const TC_SIZE = 0.78
const AXIS_RGB = [0xe5484d, 0x30a46c, 0x3e63dd]
const INFER_TEXT = ['', '', '吸附：面心', '吸附：边中点', '吸附：角点']
const MOVED = Object.freeze({ moved: true })   // refreshLive 的拖动参数（每帧传同一个对象，不分配）
const TOOLS = ['move', 'rotate'], SPACES = ['body', 'local', 'mount']

const onSymLocus = S.onSymLocus   // 件原点落在对称面 / 轴上（asmSnap：拖入、快速添加、镜像、属性面板共用一个判据）

// 发给 UI 的文档快照：冻结对象、纯数字数组不冻结（asmSnap.freezeDoc 注释）。
// ★ 不变式：冻结快照绝不进 assembly.mjs 的热函数（属性面板的位姿读数走 poseOf，不自己 solvePose）。
const freezeDoc = S.freezeDoc

/**
 * @param {object} vp viewport.js 的句柄（用 CONTRACT §4 的 live 根 API）
 * @param {{theme?:'light'|'dark', lang?:()=>'zh'|'en'}} [opts]
 */
export function createAssemblyEditor(vp, opts = {}) {
  let theme = opts.theme === 'dark' ? 'dark' : 'light'

  // ───────────── 事件 ─────────────
  const subs = new Map()
  function on(name, cb) {
    let s = subs.get(name)
    if (!s) subs.set(name, (s = new Set()))
    s.add(cb)
    return () => s.delete(cb)
  }
  function emit(name, payload) {
    const s = subs.get(name)
    if (!s || !s.size) return
    for (const cb of s) { try { cb(payload) } catch (e) { console.error(`[asm] ${name} 回调出错`, e) } }
  }

  // ───────────── 文档 / 解算 ─────────────
  let doc = normalizeAssembly({ kind: 'assembly', domain: 'spacecraft', comps: [] })
  const poses = new Map()
  const massOut = {}
  const massStatic = {}, massMoving = {}   // 拾起时静态部分 / 移动子树的质量合成（常驻：解算计划与生成缓存跨次拾起沿用）

  // ───────────── three 件 ─────────────
  const D = vp.displayMatrix.elements   // 本体 → 显示（纯旋转；逆 = 转置）
  const asmRoot = new THREE.Group(); asmRoot.name = 'assembly'; asmRoot.matrixAutoUpdate = false
  const fxRoot = new THREE.Group(); fxRoot.name = 'assembly_fx'; fxRoot.matrixAutoUpdate = false
  fxRoot.matrix.copy(vp.displayMatrix); fxRoot.matrixWorldNeedsUpdate = true
  const frameHolder = new THREE.Group(); frameHolder.name = 'asm_gizmo_frame'; frameHolder.matrixAutoUpdate = false
  const pivot = new THREE.Object3D(); pivot.name = 'asm_gizmo_pivot'
  frameHolder.add(pivot); asmRoot.add(frameHolder)
  // 边线 / BVH 在几何 Worker 里算：某件到齐时，它若正描着边（选中 / 悬停 / 派生）就补画，拖入的 ghost 补上边线，穿插在等它就接着跑
  const cache = createGeomCache({ onReady: onItemReady, onEvict: (it) => ghost.forget(it) })
  const fx = createFxLayer(fxRoot, cache)
  const precompile = (o) => (typeof vp.precompile === 'function' ? vp.precompile(o) : null)
  const ghost = createGhostPool(fxRoot, cache, { precompile, onWarm: (it) => { if (dr.active && dr.item === it) { ghost.refresh(); vp.invalidate() } } })
  const ov = createAsmOverlay(vp.overlay, vp.displayMatrix)
  vp.overlay.remove(ov.group)   // attach 时才挂
  const clash = createClashRunner()
  let pal = palette(false), lightMode = ''

  // ───────────── 条目（展开件）─────────────
  // {id, pid, k, prefix, parentId, index, group, item, meshes, comp, sockets, faces, size, invalid, visible, symTaint,
  //  poseM:Float64Array（solvePose 的 m，引用）, plane, ax, m:Float64Array(16) 渲染矩阵, fx, poseMap}
  let entries = new Map()
  let list = []
  const meshEntry = new WeakMap()
  let pickList = []                 // 可拾取网格（可见条目）
  // 拾取粗筛：每个可拾取网格的包围球（本体系 cx, cy, cz, r）与参与标记（拾起时移动子树置 0）。
  // three-mesh-bvh 的加速射线不先比包围球、每个网格每次都新建三个类型数组视图（BufferStack），整星七十来个网格
  // 一条射线就是 25 KB——先用包围球挑出射线穿过的那几个再下 BVH。
  let pickSph = new Float64Array(0), pickMask = new Uint8Array(0)
  let pickSkipLo = -1, pickSkipHi = -1   // castPick 临时跳过的拾取表下标段（插座遮挡判据：不算插座所在件自己）
  let invalidById = {}, invalidKey = '{}'

  // ───────────── 选择 / 工具 ─────────────
  let sel = []
  let hoverId = null
  let mode = 'idle'
  let tool = 'move', space = 'body'
  const snap = { on: S.SNAP_DEFAULTS.on, move: S.SNAP_DEFAULTS.move, rotate: S.SNAP_DEFAULTS.rotate }
  const symUi = { op: 'none', n: 2 }
  let posePreview = false, showCom = true, showSockets = false
  let shiftDown = false
  let attached = false, savedView = null, everAttached = false

  // ───────────── 历史 ─────────────
  const hist = []
  let hptr = 0

  // ───────────── 读数 ─────────────
  const I3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const st = { count: 0, tris: 0, massKg: 0, com: new Float64Array(3), inertiaDiag: new Float64Array(3), inertia: I3, bbox: new Float64Array(6), clashes: 0, invalid: 0, dirtyGeom: false, massWarn: '' }
  // 质量预览暂存（13 元：见 asmSnap.massCombine）
  const M13 = new Float64Array(13), MA0 = new Float64Array(13), MA1 = new Float64Array(13), MOUT = new Float64Array(13), MMATS = new Float64Array(16 * 9)
  let statsDirty = false
  let boxesP = new Float64Array(0), matsP = new Float64Array(0), nBoxes = 0
  let clashPairs = [], clashSet = new Set(), lastFocus = []
  let curStatus = { kind: '', text: '' }

  // ───────────── 暂存（热路径零分配）─────────────
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4()
  const _Z = new THREE.Vector3(0, 0, 1)
  const _ndc = new THREE.Vector2()
  const rc = new THREE.Raycaster(); rc.firstHitOnly = true; rc.layers.set(0)
  const hits = []
  const _plane = new THREE.Plane()
  const HP = new Float64Array(3), HN = new Float64Array(3), HW = new Float64Array(3), CB = new Float64Array(3)
  const T0 = new Float64Array(16), T1 = new Float64Array(16), T2 = new Float64Array(16), T3 = new Float64Array(16)
  // io 对象的数值字段一开始就给双精度（字段表示从一开始就是 Double，之后原地写、不装箱）
  const faceOut = { u: 0.5, v: 0.5, d: 0.5, tol: 0.002, skin: 0.05 }, inf = { u: 0.5, v: 0.5, kind: 0, ppm: 1.5 }
  const Z3 = new Float64Array(3)
  const lastPtr = { x: 0, y: 0, in: false }
  const dragEv = { phase: 'start', kind: 'ghost', id: '', attach: null }
  let dragEvDirty = false
  const hy = S.createHysteresis(S.HYSTERESIS_PX)
  const down = { x: 0, y: 0, b: -1 }

  // ───────────── 调试钩子 ─────────────
  const dbg = { frames: 0, statsLog: [], logOn: false, logDoc: false, hookMs: 0, hookMax: 0, syncMs: 0, hookLog: null }

  // ═════════════════════════ 小工具 ═════════════════════════
  // 状态片：吸附 / 穿插是持续状态（跟着拖动 / 穿插结果走）；命令告警（warn / error）4 s 后自己清——编辑器这边清，
  // 会话跟着这边的 status 事件走，两边不会一边清了一边还记着旧值（否则同一条告警第二次会被这里的去重吞掉）
  const STATUS_TTL = 4000
  let statusT = 0
  function setStatus(kind, text, ttl) {
    const ms = ttl !== undefined ? ttl : (kind === 'warn' || kind === 'error' ? STATUS_TTL : 0)
    if (statusT) { clearTimeout(statusT); statusT = 0 }
    if (ms > 0 && text) statusT = setTimeout(() => { statusT = 0; if (curStatus.kind === kind && curStatus.text === text) { curStatus = { kind: '', text: '' }; emit('status', curStatus) } }, ms)
    // 吸附 / 穿插这类持续状态去重（同一条不重复发）；命令告警每次都发（会话那边可能已经清了，同一条第二次也要出来）
    if (curStatus.kind === kind && curStatus.text === text && kind !== 'warn' && kind !== 'error') return
    curStatus = { kind, text }
    emit('status', { kind, text })
  }
  /** 清状态片（text 给了就只在当前正是这条时清）。会话层自己的定时清除同步调它。 */
  function clearStatus(text) {
    if (text !== undefined && curStatus.text !== text) return
    if (statusT) { clearTimeout(statusT); statusT = 0 }
    if (!curStatus.kind && !curStatus.text) return
    curStatus = { kind: '', text: '' }
    emit('status', { kind: '', text: '' })
  }
  /** 命令告警（warn / error）让位：换文档、选择变了时清掉，不挂着上一件的告警。 */
  function dropWarn() { if (curStatus.kind === 'warn' || curStatus.kind === 'error') clearStatus() }
  function nameOf(id) {
    const c = S.compById(doc, S.primaryIdOf(id))
    if (!c) return String(id)
    const def = getComponent(c.type)
    return c.name || (def ? def.titleZh : c.type)
  }
  function effSpace() {
    const c = sel.length === 1 ? S.compById(doc, sel[0]) : null
    return c && c.parent != null && c.attach.mode !== 'free' ? 'mount' : space
  }
  function emitMode() {
    const c = sel.length === 1 ? S.compById(doc, sel[0]) : null
    emit('mode', { state: mode, tool, space: effSpace(), spaceFixed: !!(c && c.parent != null && c.attach.mode !== 'free') })
  }
  function setMode(m) { if (mode !== m) { mode = m; emitMode() } }
  const busy = () => dr.active || gz.active
  function cssH() { return Math.max(1, vp.canvas.clientHeight || 1) }
  /** 显示系点 → 本体系（显示矩阵的转置）。 */
  function toBody(p, out) {
    out[0] = D[0] * p.x + D[1] * p.y + D[2] * p.z
    out[1] = D[4] * p.x + D[5] * p.y + D[6] * p.z
    out[2] = D[8] * p.x + D[9] * p.y + D[10] * p.z
  }
  /** 本体系点 → 屏幕客户区（CSS 像素）；写 out.x / out.y，在相机后面返回 false。 */
  function bodyToClient(x, y, z, rect, out) {
    _v.set(D[0] * x + D[4] * y + D[8] * z, D[1] * x + D[5] * y + D[9] * z, D[2] * x + D[6] * y + D[10] * z).project(vp.camera)
    if (_v.z > 1 || _v.z < -1) return false
    out.x = (_v.x * 0.5 + 0.5) * rect.width + rect.left
    out.y = (0.5 - _v.y * 0.5) * rect.height + rect.top
    return true
  }
  function camBody(out) {
    const c = vp.camera.position
    out[0] = D[0] * c.x + D[1] * c.y + D[2] * c.z
    out[1] = D[4] * c.x + D[5] * c.y + D[6] * c.z
    out[2] = D[8] * c.x + D[9] * c.y + D[10] * c.z
  }
  function refreshPalette() {
    lightMode = vp.mode
    pal = palette(theme === 'dark' || vp.mode === 'sun')
    fx.setPalette(pal); ghost.setPalette(pal); ov.setPalette(pal)
    if (tc) { const r = lookRoll; lookRoll = null; gizmoLook(!!r) }
  }

  // ═════════════════════════ 条目重建（结构 + 几何）═════════════════════════
  /**
   * 按当前文档重建条目表：增删条目、参数 / 材质变了的主件换几何（派生件跟着换）、写矩阵与显隐。
   * 参数非法的件保留上一次合法几何（红染）；没有合法几何的先画包围盒线框占位。返回几何是否有变。
   */
  function rebuildEntries() {
    const exp = expandSymmetry(doc)
    solvePose(doc, poses)
    const prim = new Map()
    const inv = {}
    for (const c of doc.comps) {
      const def = getComponent(c.type)
      const errs = def ? checkParams(def, fillParams(def, c.params), 'params') : [`type：未知组件 ${c.type}`]
      const prev = entries.get(c.id)
      let item = null
      if (!errs.length) { try { item = cache.get(c) } catch (e) { errs.push(String((e && e.message) || e)) } }
      const invalid = errs.length > 0
      if (invalid) { item = prev ? prev.item : null; inv[c.id] = errs }
      // 安装解算失败（插座 / 面 / 安装插座不在了）：按单位阵摆在父件原点 —— 同样算非法件（树 / 属性标红、不入库、换文档前确认）
      const p = poses.get(c.id)
      if (p && p.bad) (inv[c.id] || (inv[c.id] = [])).push(poseBadText(c, p.bad))
      const g = S.compGeo(c)
      prim.set(c.id, { comp: c, item, invalid: !!inv[c.id], sockets: g.sockets, faces: g.faces, symTaint: S.inSymSubtree(doc, c.id) })
    }
    let changed = false
    const next = new Map(), nl = []
    for (const x of exp) {
      const P = prim.get(x.src)
      if (!P) continue
      let e = entries.get(x.id)
      if (e) entries.delete(x.id)
      else {
        const group = new THREE.Group(); group.name = x.prefix; group.matrixAutoUpdate = false; group.userData.name = x.prefix
        e = { id: x.id, pid: x.src, k: x.k, prefix: x.prefix, parentId: x.parent, index: 0, group, item: undefined, meshes: [], rels: [], comp: null, sockets: [], faces: [], size: 0.3, rod: 0, invalid: false, visible: true, symTaint: false, poseM: null, plane: null, ax: -1, m: new Float64Array(16), fx: 0, poseMap: null, pick0: -1, pickN: 0 }
        asmRoot.add(group)
        changed = true
      }
      e.pid = x.src; e.k = x.k; e.parentId = x.parent
      if (e.item !== P.item) {
        if (e.poseMap) { restoreFilePose(e.poseMap); e.poseMap = null }
        // BVH 不在这里同步建：条目进缓存时已排进几何 Worker（拖入件在拖动开始时插队）；没到的由视口 ensureBvh 兜底
        if (P.item) e.meshes = fillEntry(e.group, P.item, x.prefix)
        else { for (const ch of e.group.children.slice()) e.group.remove(ch); e.meshes = [] }
        for (const m of e.meshes) meshEntry.set(m, e)
        e.item = P.item
        e.rels = P.item ? P.item.meshes.map((mm) => mm.rel.clone()) : []
        changed = true
      }
      e.comp = P.comp; e.sockets = P.sockets; e.faces = P.faces; e.invalid = P.invalid; e.symTaint = P.symTaint
      e.visible = !P.comp.hidden
      e.group.visible = e.visible
      e.size = P.item ? P.item.size : 0.3
      e.rod = rodRadius(P.sockets)
      e.index = nl.length
      next.set(x.id, e); nl.push(e)
    }
    for (const e of entries.values()) { if (e.poseMap) restoreFilePose(e.poseMap); asmRoot.remove(e.group); changed = true }
    entries = next; list = nl
    writeMatrices()
    const active = new Set()
    for (const e of list) if (e.item) active.add(e.item)
    if (dr.active && dr.item) active.add(dr.item)
    cache.sweep(active)
    pickList = []
    for (const e of list) if (e.visible) for (const m of e.meshes) pickList.push(m)
    buildPickSpheres()
    // 读数用的打包包围盒（隐藏件写空盒）
    const cap = list.length + 9
    if (boxesP.length < 6 * cap) { boxesP = new Float64Array(6 * cap); matsP = new Float64Array(16 * cap) }
    for (let i = 0; i < list.length; i++) {
      const e = list[i], o = 6 * i
      if (e.item && e.visible) for (let k = 0; k < 6; k++) boxesP[o + k] = e.item.box6[k]
      else { boxesP[o] = boxesP[o + 1] = boxesP[o + 2] = Infinity; boxesP[o + 3] = boxesP[o + 4] = boxesP[o + 5] = -Infinity }
    }
    nBoxes = list.length
    if (posePreview) { applyPosePreview(true); buildPickSpheres() }
    const key = JSON.stringify(inv)
    invalidById = inv
    st.invalid = Object.keys(inv).length
    if (key !== invalidKey) { invalidKey = key; emit('invalid', { byId: JSON.parse(key) }) }
    return changed
  }

  /** 安装解算失败的状态文案（solvePose 的 p.bad）。 */
  function poseBadText(c, bad) {
    const a = c.attach || {}
    if (bad === 'socket') return `attach.socket：父件 ${c.parent} 没有插座 "${a.socket}"`
    if (bad === 'face') return `attach.face：父件 ${c.parent} 没有面 "${a.face}"`
    if (bad === 'mount') return `attach.mount：本件没有插座 "${a.mount || (getComponent(c.type) || {}).mountSocket}"`
    return 't / q：位姿非法'
  }
  /** 杆件（安装插座在原点、tip 插座在局部 +Z 端）的半径；不是杆 0。穿插检测按接头放宽杆的两端。 */
  function rodRadius(sockets) {
    let tip = null
    for (const s of sockets) if (s.id === 'tip') { tip = s; break }
    return tip && Math.abs(tip.pos[0]) < 1e-9 && Math.abs(tip.pos[1]) < 1e-9 && tip.pos[2] > 0 && tip.size > 0 ? tip.size / 2 : 0
  }
  /**
   * 条目里每个网格相对条目组的当前矩阵（沿父链把局部矩阵乘起来，到条目组为止）：初值姿态预览把关节节点摆开之后，
   * 描边 / 淡染与拾取包围球都按它走（模板的 rel 是静止位姿）。只在姿态开关 / 条目重建时调（允许分配）。
   */
  function refreshRels(e) {
    for (let k = 0; k < e.meshes.length; k++) {
      const r = e.rels[k] || (e.rels[k] = new THREE.Matrix4())
      r.identity()
      for (let o = e.meshes[k]; o && o !== e.group; o = o.parent) { if (o.matrixAutoUpdate) o.updateMatrix(); r.premultiply(o.matrix) }
    }
  }

  /** 逐条目写渲染矩阵（零分配）：pose.m，镜像派生件把镜面列取反。 */
  function writeMatrices() {
    for (let i = 0; i < list.length; i++) {
      const e = list[i], p = poses.get(e.id)
      if (!p) continue
      e.poseM = p.m
      e.plane = p.plane
      e.ax = p.plane === 'yz' ? 0 : p.plane === 'xz' ? 1 : p.plane === 'xy' ? 2 : -1
      writeRenderMatrix(e.m, p.m, e.ax)
      const el = e.group.matrix.elements
      for (let j = 0; j < 16; j++) el[j] = e.m[j]
      e.group.matrixWorldNeedsUpdate = true
    }
  }

  /** 拖动中的本体系包围盒（局部盒 × 渲染矩阵外包；ghost 一并算）。零分配。 */
  function liveBBox(extraN) {
    for (let i = 0; i < nBoxes; i++) { const m = list[i].m, o = 16 * i; for (let k = 0; k < 16; k++) matsP[o + k] = m[k] }
    S.liveBox(boxesP, matsP, nBoxes + (extraN || 0), st.bbox)
  }

  /** 质量读数写进 st（13 元：质量 / 质心 / 对质心惯量，见 asmSnap.massCombine）+ 质心记号。零分配。 */
  function applyMass13(a) {
    st.massKg = a[0]
    st.com[0] = a[1]; st.com[1] = a[2]; st.com[2] = a[3]
    for (let r = 0; r < 3; r++) { const row = I3[r]; row[0] = a[4 + 3 * r]; row[1] = a[5 + 3 * r]; row[2] = a[6 + 3 * r] }
    st.inertiaDiag[0] = a[4]; st.inertiaDiag[1] = a[8]; st.inertiaDiag[2] = a[12]
    if (st.massKg > 0) { ov.com.atArr(st.com); ov.com.visible = showCom } else ov.com.visible = false
    statsDirty = true
  }
  function updateMass(d, out) {
    try { combineMass(d, out) } catch { return }
    applyMass13(S.massPack(out, M13))
    // 目标质量没生效（没有可吃余量的平台体 / 目标小于其余件合计）：告警串 combineMass 按类型缓存，同一告警每帧同一个串
    const w = out.warnings && out.warnings.length ? out.warnings[0] : ''
    if (st.massWarn !== w) { st.massWarn = w; statsDirty = true }
  }
  /**
   * 拖动中的质量读数：pickup / ghost 走「静态部分（拖动开始时算一次）+ 拖动件局部质量特性 × 各份渲染矩阵」（massCombine）；
   * 设了目标质量的拾起平台体要吃余量，走整份 combineMass（计划过继，换父件不重跑生成）。
   */
  function dragMass() {
    if (dr.massMode === 0) { updateMass(doc, massOut); return }
    let n = 0
    if (dr.massMode === 1) {
      if (dr.kind === 'ghost') {
        if (dr.valid) {
          const p0 = dr.poses.get(dr.id)
          if (p0) { putMat(0, p0.m, -1); n = 1 }
          for (let k = 1; k < dr.count && n > 0; k++) {
            const p = dr.poses.get(dr.derivedIds[k - 1])
            if (p) putMat(16 * n++, p.m, p.plane === 'yz' ? 0 : p.plane === 'xz' ? 1 : p.plane === 'xy' ? 2 : -1)
          }
        }
      } else for (let i = 0; i < dr.rootEntries.length && i < 9; i++) putMat(16 * n++, dr.rootEntries[i].m, -1)
    }
    if (n === 0 || !(MA1[0] > 0)) applyMass13(MA0)
    else applyMass13(S.massCombine(MA0, MA1, MMATS, n, MOUT))
  }
  function putMat(o, m, ax) {
    for (let i = 0; i < 16; i++) MMATS[o + i] = m[i]
    if (ax >= 0) { MMATS[o + 4 * ax] = -MMATS[o + 4 * ax]; MMATS[o + 4 * ax + 1] = -MMATS[o + 4 * ax + 1]; MMATS[o + 4 * ax + 2] = -MMATS[o + 4 * ax + 2] }
  }

  // ═════════════════════════ 提交后的完整同步 ═════════════════════════
  // 取景 / 接触阴影 / 精确包围盒（逐顶点、按屏上几何）只在几何或位姿真变了时重做：改名、锁定、隐藏以外的纯元数据提交不付这笔
  let frameKey = ''
  function frameSig() {
    let s = ''
    for (const e of list) { s += e.id + (e.visible ? '|' : '/') + (e.item ? e.item.key : '') + ':'; const m = e.m; for (let i = 0; i < 16; i++) s += m[i] + ',' }
    return s
  }
  /**
   * @param {string} reason
   * @param {string[]} ids
   * @param {boolean} [changed] 文档是否真变了：Esc 取消、点了 gizmo 没拖、拾起后原地放下时为 false——change 事件带 changed:false，
   *   会话只换快照、不当作一次提交（不涨提交号、不标脏、不写草稿、不入库）
   * @param {string} [json] 当前文档的 JSON 串（提交路径上现成的 after 串：不再重新序列化一遍；change 事件带出去给会话判「与库里相同」）
   */
  function sync(reason, ids, changed = true, json) {
    const t0 = performance.now()
    clash.cancel()
    const geomChanged = rebuildEntries()
    const sig = frameSig()
    const reframe = geomChanged || sig !== frameKey
    frameKey = sig
    if (attached) vp.refreshLive({ meshes: geomChanged, frame: reframe })
    else asmRoot.updateMatrixWorld(true)
    updateMass(doc, massOut)
    st.count = list.length
    let tris = 0
    for (const e of list) if (e.visible && e.item) tris += e.item.tris
    st.tris = tris
    if (attached && list.length) {
      const b = vp.bounds.bboxBody
      st.bbox[0] = b.min[0]; st.bbox[1] = b.min[1]; st.bbox[2] = b.min[2]; st.bbox[3] = b.max[0]; st.bbox[4] = b.max[1]; st.bbox[5] = b.max[2]
    } else liveBBox(0)
    st.dirtyGeom = false
    sel = sel.filter((id) => S.compById(doc, id))
    if (hoverId && !entries.has(hoverId)) hoverId = null
    lastFocus = Array.isArray(ids) ? ids : []
    refreshSocketMarkers()
    clashPairs = []; clashSet = new Set(); st.clashes = 0
    refreshFx()
    configureGizmo()
    runClash()
    statsDirty = true
    if (!attached) flushStats()
    const js = typeof json === 'string' ? json : JSON.stringify(doc)
    emit('change', { doc: freezeDoc(JSON.parse(js)), json: js, reason, ids: lastFocus.slice(), changed: changed !== false })
    emit('history', { canUndo: hptr > 0, canRedo: hptr < hist.length })
    vp.invalidate()
    dbg.syncMs = performance.now() - t0
  }

  function flushStats() {
    if (!statsDirty) return
    statsDirty = false
    emit('stats', st)
    if (dbg.logOn) dbg.statsLog.push({ t: performance.now(), com: [st.com[0], st.com[1], st.com[2]], massKg: st.massKg, ...(dbg.logDoc ? { doc: JSON.stringify(dr.active ? dr.doc : doc) } : {}) })
  }

  // ═════════════════════════ 穿插 ═════════════════════════
  // 热控包覆（MLI / Kapton）是零厚度的外包皮：杆件、支架从结构面伸出来必然「穿过」它，不算穿插
  const SKIN_RE = /^(mli_|kapton_)/
  function solidMeshes(e) {
    let out = null
    for (let i = 0; i < e.meshes.length; i++) {
      const m = e.meshes[i], mat = Array.isArray(m.material) ? m.material[0] : m.material
      const k = mat && mat.userData ? mat.userData.materialKey : ''
      if (typeof k === 'string' && SKIN_RE.test(k)) { if (!out) out = e.meshes.slice(0, i) } else if (out) out.push(m)
    }
    return out || e.meshes
  }
  // 穿插要各件的 BVH：几何 Worker / 视口还没挂好的，等一会儿再跑（不在提交那一帧同步建树）；下一次同步 / 拖动开始即作废
  let clashWaitT = 0, clashWaits = 0
  function clashRetry() {
    clashWaitT = 0
    if (!attached || dr.active || gz.active) return
    runClash(true)
  }
  function runClash(retry) {
    if (clashWaitT) { clearTimeout(clashWaitT); clashWaitT = 0 }
    if (!retry) clashWaits = 0
    // 最多等 ~6 s（某件的 BVH 始终建不出来时照跑：缺 BVH 的那件只作 B 方参与）
    if (clashWaits < 50) {
      for (const e of list) {
        if (!e.visible || !e.item || !e.meshes.length) continue
        if (!cache.bvhReady(e.item)) { clashWaits++; clashWaitT = setTimeout(clashRetry, 120); return }
      }
    }
    const items = [], idx = []
    for (const e of list) {
      if (!e.visible || !e.item || !e.meshes.length) continue
      const meshes = solidMeshes(e)
      if (!meshes.length) continue
      const box = new Float64Array(6)
      S.boxXform(e.item.box6, 0, e.m, 0, box, 0)
      items.push({ meshes, box, e, rod: e.rod })
      idx.push(e)
    }
    if (items.length < 2) { applyClash([]); return }
    // 跳过：父子安装对（贴合面共面相交会全报）；同一主件的对称副本之间（翼根在机身中线会合、对开件在对称面相接是设计本身）
    const skip = (i, j) => { const a = idx[i], b = idx[j]; return a.parentId === b.id || b.parentId === a.id || a.pid === b.pid }
    clash.run(items, skip, (pairs) => applyClash(pairs.map(([i, j]) => [idx[i].id, idx[j].id])))
  }
  function applyClash(pairs) {
    clashPairs = pairs
    // 只染每对里较小的那件（平台体被一根杆扎到时整块染红等于没报）；两件都列在状态里
    clashSet = new Set()
    for (const [a, b] of pairs) {
      const ea = entries.get(a), eb = entries.get(b)
      clashSet.add(ea && eb && ea.size > eb.size ? b : a)
    }
    st.clashes = pairs.length
    statsDirty = true
    refreshFx()
    if (pairs.length) {
      const focus = lastFocus.length ? lastFocus : sel
      let text = ''
      for (const [a, b] of pairs) {
        const fa = focus.includes(S.primaryIdOf(a)), fb = focus.includes(S.primaryIdOf(b))
        if (fa && !fb) { text = `与 ${nameOf(b)} 穿插。`; break }
        if (fb && !fa) { text = `与 ${nameOf(a)} 穿插。`; break }
      }
      if (!text) text = `${nameOf(pairs[0][0])} 与 ${nameOf(pairs[0][1])} 穿插。`
      setStatus('clash', text)
    } else if (curStatus.kind === 'clash') setStatus('', '')
    if (!attached) flushStats()
    vp.invalidate()
  }

  // ═════════════════════════ 叠加（淡染 / 描边 / 插座标记）═════════════════════════
  function refreshFx() {
    const selSet = new Set(sel)
    const moving = dr.active && dr.kind === 'pickup' ? dr.moving : null
    for (const e of list) {
      let m = 0
      if (selSet.has(e.pid)) m |= e.k === 0 ? FX.SEL : FX.SEL_WEAK
      else if (e.id === hoverId) m |= FX.HOVER
      if (clashSet.has(e.id)) m |= FX.CLASH
      if (e.invalid) m |= FX.INVALID
      if (moving && moving.has(e.id)) m |= dr.valid ? FX.MOVING : FX.CLASH
      e.fx = m
    }
    fx.update(list)
    vp.invalidate()
  }

  /** 几何 Worker 把某件的边线 / BVH 送到了：正描着边的条目补画（fx.update 按「边线到没到」重建），ghost 补上边线。 */
  function onItemReady(it) {
    if (dr.active && dr.item === it) { ghost.refresh(); vp.invalidate() }
    for (const e of list) if (e.item === it && e.fx) { refreshFx(); break }
  }
  /** attach 时：叠加层各材质（选中粗线 / 被挡部分 / 悬停 / 派生 / 淡染 / 占位）交给视口异步预编译——第一次选中 / 悬停不卡着色器编译。 */
  let fxWarmed = false
  function warmFx() {
    if (fxWarmed || typeof vp.precompile !== 'function') return
    fxWarmed = true
    const g = fx.warmGroup()
    Promise.resolve(vp.precompile(g)).catch(() => null).then(() => { if (g.userData.dispose) g.userData.dispose() })
    // 叠加层（插座标记 / 目标面轮廓与淡填充 / 吸附锚点 / 质心 / 原点三轴）与 gizmo 手柄：第一次拖入 / 选中时不同步编译
    // （compile 走 traverse、不看显隐：藏着的记号材质一并编）
    try { vp.precompile(ov.group, { overlay: true }) } catch { /* 预热失败不挡 */ }
    try { vp.precompile(ov.originScene) } catch { /* 同上 */ }
    try { if (tc) vp.precompile(tc.getHelper(), { overlay: true }) } catch { /* 同上 */ }
  }
  /**
   * 库卡片按下（还没过拖动门槛）：先把这件建进几何缓存、边线 / BVH 插队进 Worker、ghost 材质副本异步编译——
   * 真拖起来时 ghost 第一帧不再同步编译着色器、落下时不再现建 BVH / 描边。
   */
  function prewarmGhost(type, o = {}) {
    if (!attached || dr.active) return false
    const def = getComponent(type)
    if (!def || !def.domain.includes(doc.domain)) return false
    const params = o && o.params && typeof o.params === 'object' ? JSON.parse(JSON.stringify(o.params)) : {}
    let item
    try { item = cache.get({ type, params, material: null }) } catch { return false }
    cache.prep(item, true)
    ghost.warm(item)
    return true
  }

  const sk = { pos: new Float64Array(0), nrm: new Float64Array(0), n: 0, ent: [] }
  function ensureSk(n) { if (sk.pos.length < 3 * n) { sk.pos = new Float64Array(3 * Math.max(64, 2 * n)); sk.nrm = new Float64Array(3 * Math.max(64, 2 * n)) } }
  /** 插座世界位置 / 朝外法向（本体系）写进 pos / nrm 的第 i 格。 */
  function socketBody(e, s, pos, nrm, i) {
    const m = e.m, p = s.pos, n = s.n, o = 3 * i
    pos[o] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]
    pos[o + 1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]
    pos[o + 2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
    nrm[o] = m[0] * n[0] + m[4] * n[1] + m[8] * n[2]
    nrm[o + 1] = m[1] * n[0] + m[5] * n[1] + m[9] * n[2]
    nrm[o + 2] = m[2] * n[0] + m[6] * n[1] + m[10] * n[2]
  }
  function ownMountId(c) {
    if (!c || c.parent == null || c.attach.mode === 'free') return null
    const def = getComponent(c.type)
    return c.attach.mount || (def ? def.mountSocket : 'root')
  }
  /**
   * 空闲插座标记（idle，开关 showSockets）：只标选中件（含其派生件）的空闲插座；没有选中件时不标（载入 / 转换后整星三十来个
   * 橙圈会盖住星体）。拖入 / 拾起时由候选表接管（候选色，不走这里）。被别的件挡住的插座在同步 / 相机停下后按件 BVH 判一次视线，
   * 降到 0.25 透明（插座标记本身不做深度测试：否则贴在面上的那半个圈会被自己的面吃掉）。
   */
  function refreshSocketMarkers() {
    if (dr.active) return
    if (!showSockets || !sel.length) { ov.sockets.visible = false; vp.invalidate(); return }
    const used = S.usedSocketKeys(doc)
    const scope = new Set(sel)
    let n = 0
    for (const e of list) if (e.visible && scope.has(e.pid)) n += e.sockets.length
    ensureSk(n)
    n = 0
    sk.ent.length = 0
    for (const e of list) {
      if (!e.visible || !scope.has(e.pid)) continue
      const own = ownMountId(e.comp)
      for (const s of e.sockets) {
        if (s.id === own || used.has(`${e.pid}|${s.id}`)) continue
        sk.ent.push(e)
        socketBody(e, s, sk.pos, sk.nrm, n++)
      }
    }
    sk.n = n
    ov.sockets.set(sk.pos, sk.nrm, n, 0)
    ov.sockets.visible = true
    occludeSockets()
    vp.invalidate()
  }
  /**
   * 第 i 个插座（本体系位置 pos[3i..]，属于条目 owner）被别的件挡住：相机 → 插座这段射线先打到别的件（拾起时移动子树不算，见 pickMask）。
   * 插座所在的件自己不算遮挡：机身里的翼根插座、平台体里的安装点本来就在自己的几何里面；自己背面那一侧的插座由朝向判据（背面不画）管。
   */
  const _oc = new THREE.Vector3()
  function sockOccluded(pos, i, owner) {
    const cam = vp.camera.position
    const o = 3 * i, x = pos[o], y = pos[o + 1], z = pos[o + 2]
    _oc.set(D[0] * x + D[4] * y + D[8] * z, D[1] * x + D[5] * y + D[9] * z, D[2] * x + D[6] * y + D[10] * z).sub(cam)
    const dist = _oc.length()
    if (!(dist > 1e-6)) return false
    rc.ray.origin.copy(cam); rc.ray.direction.copy(_oc).multiplyScalar(1 / dist)
    if (owner && owner.pick0 >= 0) { pickSkipLo = owner.pick0; pickSkipHi = owner.pick0 + owner.pickN }
    const hit = castPick()
    pickSkipLo = pickSkipHi = -1
    return !!hit && hit.distance < dist - Math.max(0.06, 0.02 * dist)
  }
  /** 空闲插座（选中件的）的视线遮挡：件少，同步判。只在同步 / 选择变了 / 相机停下后调。 */
  function occludeSockets() {
    if (dr.active) { occludeCandidates(); return }
    if (!ov.sockets.visible || !sk.n || !pickList.length) return
    asmRoot.updateWorldMatrix(true, true)   // 同步刚写完矩阵、还没渲染过：射线求交要新的世界矩阵
    for (let i = 0; i < sk.n; i++) ov.sockets.occl(i, sockOccluded(sk.pos, i, sk.ent[i]))
  }
  /**
   * 拖入 / 拾起的候选插座遮挡：候选多（整星上百个），在空闲时段里分片判（每片 ≤ 4 ms），判完之前先按「挡住」藏着——
   * 被挡住的候选既不画（不会叠在正对相机的面上被误认）、也不参与吸附。拖动开始、相机停下后各判一遍。
   */
  let candIdle = 0, candI = 0
  function occludeCandidates() {
    candI = 0
    if (!candIdle) candIdle = idleCall(candStep)
  }
  function candStep(dl) {
    candIdle = 0
    if (!attached || !dr.active || !pickList.length) return
    if (candI === 0) asmRoot.updateWorldMatrix(true, true)
    const t0 = performance.now(), budget = dl && typeof dl.timeRemaining === 'function' && !dl.didTimeout ? Math.max(2, Math.min(dl.timeRemaining(), 6)) : 4
    while (candI < dr.cN) {
      const occ = sockOccluded(dr.cPos, candI, dr.cE[candI])
      dr.cOcc[candI] = occ ? 1 : 0
      ov.sockets.occl(candI, occ)
      candI++
      if (performance.now() - t0 > budget) break
    }
    dr.pending = true
    vp.invalidate()
    if (candI < dr.cN) candIdle = idleCall(candStep)
  }
  const idleCall = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 60 }) : setTimeout(() => fn(null), 16))
  const idleCancel = (h) => { if (typeof cancelIdleCallback === 'function') cancelIdleCallback(h); else clearTimeout(h) }
  // 相机动过：停下 ~150 ms 后重判一次遮挡（一个复用的计时器；相机转动 / gizmo 拖动中不判）
  let camMovedAt = 0, occlTimer = 0
  function occlTick() {
    occlTimer = 0
    if (!attached) return
    if (performance.now() - camMovedAt < 150 || gz.active) { occlTimer = setTimeout(occlTick, 160); return }
    occludeSockets()
    vp.invalidate()
  }
  function onCamChange() {
    camMovedAt = performance.now()
    if (!occlTimer && ov.sockets.visible && (dr.active ? dr.cN : sk.n)) occlTimer = setTimeout(occlTick, 160)
  }

  // ═════════════════════════ 拾取 ═════════════════════════
  /** 各可拾取网格的包围球（本体系）：条目渲染矩阵 × 网格相对矩阵（e.rels，含初值姿态）× 几何包围球。条目静止时有效（同步 / 换父件 / 姿态开关后重建）。 */
  function buildPickSpheres() {
    const n = pickList.length
    if (pickSph.length < 4 * n) { pickSph = new Float64Array(4 * Math.max(16, 2 * n)); pickMask = new Uint8Array(Math.max(16, 2 * n)) }
    let i = 0
    for (const e of list) {
      e.pick0 = -1; e.pickN = 0
      if (!e.visible) continue
      e.pick0 = i; e.pickN = e.meshes.length   // 这一件的网格在拾取表里的下标段（插座遮挡判据排除插座所在件自己）
      for (let k = 0; k < e.meshes.length; k++, i++) {
        const g = e.meshes[k].geometry
        if (!g.boundingSphere) g.computeBoundingSphere()
        const bs = g.boundingSphere, rel = e.rels[k] ? e.rels[k].elements : null
        let x = bs.center.x, y = bs.center.y, z = bs.center.z
        if (rel) { const X = rel[0] * x + rel[4] * y + rel[8] * z + rel[12], Y = rel[1] * x + rel[5] * y + rel[9] * z + rel[13], Z = rel[2] * x + rel[6] * y + rel[10] * z + rel[14]; x = X; y = Y; z = Z }
        const m = e.m, o = 4 * i
        pickSph[o] = m[0] * x + m[4] * y + m[8] * z + m[12]
        pickSph[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
        pickSph[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
        pickSph[o + 3] = bs.radius * 1.0001 + 1e-6
        pickMask[i] = 1
      }
    }
  }
  /**
   * 射线（rc.ray，显示系）打可拾取网格：包围球粗筛 → 逐个 BVH（firstHitOnly）→ 取最近的可见命中。
   * 结果写 pickHit.hit / pickHit.e；没有命中 hit = null。零分配（BVH 内部为命中结果分配的小对象除外）。
   */
  const pickHit = { hit: null, e: null }
  function castPick() {
    pickHit.hit = null; pickHit.e = null
    const o = rc.ray.origin, d = rc.ray.direction
    const ox = D[0] * o.x + D[1] * o.y + D[2] * o.z, oy = D[4] * o.x + D[5] * o.y + D[6] * o.z, oz = D[8] * o.x + D[9] * o.y + D[10] * o.z
    const dx = D[0] * d.x + D[1] * d.y + D[2] * d.z, dy = D[4] * d.x + D[5] * d.y + D[6] * d.z, dz = D[8] * d.x + D[9] * d.y + D[10] * d.z
    let best = Infinity
    for (let i = 0; i < pickList.length; i++) {
      if (!pickMask[i] || (i >= pickSkipLo && i < pickSkipHi)) continue
      const q = 4 * i, cx = pickSph[q] - ox, cy = pickSph[q + 1] - oy, cz = pickSph[q + 2] - oz, r = pickSph[q + 3]
      const tca = cx * dx + cy * dy + cz * dz, d2 = cx * cx + cy * cy + cz * cz - tca * tca
      if (d2 > r * r) continue
      const thc = Math.sqrt(r * r - d2)
      if (tca + thc < 0 || tca - thc > best) continue
      const mesh = pickList[i]
      hits.length = 0
      mesh.raycast(rc, hits)
      if (!hits.length || hits[0].distance >= best) continue
      const e = meshEntry.get(mesh)
      if (!e || !shownMesh(mesh, e)) continue
      best = hits[0].distance
      pickHit.hit = hits[0]; pickHit.e = e
    }
    return pickHit.hit
  }
  function setRay(x, y, rect) {
    _ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1)
    rc.setFromCamera(_ndc, vp.camera)
  }
  function shownMesh(o, e) { for (let p = o; p && p !== e.group; p = p.parent) if (!p.visible) return false; return true }
  /** 屏幕点 → 条目（最近的可见件；没有 null）。 */
  function entryAt(x, y) {
    if (!pickList.length) return null
    setRay(x, y, vp.canvas.getBoundingClientRect())
    return castPick() ? pickHit.e : null
  }

  // ═════════════════════════ 选择 ═════════════════════════
  function select(ids, o = {}) {
    if (busy()) return
    const want = []
    for (const id of Array.isArray(ids) ? ids : []) { const p = S.primaryIdOf(id); if (S.compById(doc, p) && !want.includes(p)) want.push(p) }
    let next
    if (o.toggle) { next = sel.slice(); for (const id of want) { const i = next.indexOf(id); if (i >= 0) next.splice(i, 1); else next.push(id) } } else if (o.additive) { next = sel.slice(); for (const id of want) if (!next.includes(id)) next.push(id) } else next = want
    if (next.length === sel.length && next.every((x, i) => x === sel[i])) return
    sel = next
    lastSelKey = sel.join(',')
    dropWarn()
    refreshFx()
    refreshSocketMarkers()
    configureGizmo()
    emit('select', { ids: sel.slice(), primary: sel.length ? sel[sel.length - 1] : null })
    emitMode()
  }
  function frameSelection() {
    if (!attached) return
    const B = T0
    let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity
    for (const id of sel) {
      const e = entries.get(id)
      if (!e || !e.item) continue
      if (!S.boxXform(e.item.box6, 0, e.m, 0, B, 0)) continue
      a0 = Math.min(a0, B[0]); a1 = Math.min(a1, B[1]); a2 = Math.min(a2, B[2]); b0 = Math.max(b0, B[3]); b1 = Math.max(b1, B[4]); b2 = Math.max(b2, B[5])
    }
    if (!(a0 <= b0)) { vp.setView('auto'); return }
    focusBox(a0, a1, a2, b0, b1, b2)
  }
  function focusBox(a0, a1, a2, b0, b1, b2) {
    const r = Math.max(0.02, Math.hypot(b0 - a0, b1 - a1, b2 - a2) / 2)
    vp.focusBody([(a0 + b0) / 2, (a1 + b1) / 2, (a2 + b2) / 2], r)
  }
  function focusEntry(e) {
    const B = T0
    if (e.item && S.boxXform(e.item.box6, 0, e.m, 0, B, 0)) focusBox(B[0], B[1], B[2], B[3], B[4], B[5])
    else vp.focusBody([e.m[12], e.m[13], e.m[14]], 0.3)
  }

  // ═════════════════════════ 撤销 / 重做 / 命令 ═════════════════════════
  function pushHist(label, before, after, key) {
    const now = performance.now()
    if (key && hptr > 0 && hptr === hist.length) {
      const top = hist[hptr - 1]
      if (top.key === key && now - top.at < S.MERGE_MS) { top.after = after; top.at = now; return }
    }
    hist.length = hptr
    // 相邻两条里「上一条的 after」与「这一条的 before」内容相同：复用栈顶那个字符串对象（新串随即可回收，撤销栈常驻减半）
    if (hptr > 0 && hist[hptr - 1].after === before) before = hist[hptr - 1].after
    hist.push({ label, before, after, key: key || null, at: now })
    while (hist.length > S.UNDO_CAP) hist.shift()
    hptr = hist.length
  }
  function commitDoc(label, next, ids, key) {
    const before = JSON.stringify(doc), after = JSON.stringify(next)
    if (before === after) return false
    pushHist(label, before, after, key)
    doc = next
    sync(label, ids, true, after)
    return true
  }
  function apply(cmd) {
    if (busy()) return { ok: false, error: '正在拖动。' }
    const r = S.applyCmd(doc, cmd)
    if (!r.ok) { setStatus('warn', r.error); return { ok: false, error: r.error } }
    if (r.changed) commitDoc(cmd.type, r.doc, r.ids, r.mergeKey)
    // 改参数让插座 / 面消失：挂在上面的件在同一条命令里改成了自由件（保持世界位姿）
    if (r.freed && r.freed.length) setStatus('warn', `${r.freed.map(nameOf).join('、')} 改为自由安装。`)
    // 换位后落在对称面 / 轴上：同一条命令里去掉了对称；换根时映不上新本体系的对称已拆分成独立件
    else if (r.symDropped && r.symDropped.length) setStatus('warn', `${r.symDropped.map(nameOf).join('、')} 已去掉对称。`)
    else if (r.split && r.split.length) setStatus('warn', `${r.split.map(nameOf).join('、')} 的对称已拆分。`)
    return { ok: true }
  }
  function undo() {
    if (busy() || hptr <= 0) return
    const e = hist[--hptr]
    doc = normalizeAssembly(JSON.parse(e.before))
    sync('undo', [])
    emitSelIfPruned()
  }
  function redo() {
    if (busy() || hptr >= hist.length) return
    const e = hist[hptr++]
    doc = normalizeAssembly(JSON.parse(e.after))
    sync('redo', [])
    emitSelIfPruned()
  }
  let lastSelKey = ''
  function emitSelIfPruned() {
    const k = sel.join(',')
    if (k !== lastSelKey) { lastSelKey = k; emit('select', { ids: sel.slice(), primary: sel.length ? sel[sel.length - 1] : null }); emitMode() }
  }

  // ═════════════════════════ gizmo（TransformControls 挂代理 pivot）═════════════════════════
  let tc = null
  const gz = { id: null, comp: null, mode: '', active: false, dirty: false, before: '', face: null, v0: 0, rollStep: 0, frame: new Float64Array(16), anchor: new Float64Array(16) }
  function ensureTc() {
    if (tc) return
    tc = new TransformControls(vp.camera, vp.canvas)
    tc.setSpace('local')
    tc.setSize(TC_SIZE)
    tc.translationSnap = null
    tc.enabled = false
    tc.addEventListener('dragging-changed', (e) => { vp.controls.enabled = !e.value })
    tc.addEventListener('change', () => vp.invalidate())
    tc.addEventListener('mouseDown', onGizmoDown)
    tc.addEventListener('objectChange', () => { if (gz.active) gz.dirty = true })
    tc.addEventListener('mouseUp', onGizmoUp)
    tc.setColors(AXIS_RGB[0], AXIS_RGB[1], AXIS_RGB[2], pal.amber)
  }
  // 只剩一个滚转自由度（插座件 / 贴面件的旋转档）：那一条环放大、改琥珀色（不和本体轴的蓝、选中描边的墨色混）
  let lookRoll = null
  function gizmoLook(roll) {
    if (!tc || lookRoll === roll) return
    lookRoll = roll
    tc.setSize(roll ? TC_SIZE * 1.3 : TC_SIZE)
    if (roll) tc.setColors(AXIS_RGB[0], AXIS_RGB[1], pal.amber, pal.accent); else tc.setColors(AXIS_RGB[0], AXIS_RGB[1], AXIS_RGB[2], pal.amber)
  }
  // 手柄只在有 gizmo 目标时挂进叠加层：TransformControls 的 updateMatrixWorld 不看显隐、每帧拼数组算手柄（几 KB），没目标时别让它跑
  let helperOn = false
  function detachGizmo() {
    gz.id = null; gz.comp = null
    if (tc) { tc.detach(); tc.enabled = false }
    if (helperOn) { vp.overlay.remove(tc.getHelper()); helperOn = false }
  }
  function setPivotFrom(m) {
    _m4.fromArray(m)
    _m4.decompose(pivot.position, pivot.quaternion, pivot.scale)
  }
  /** 按选中件的安装方式定 gizmo 取向与手柄（CONTRACT §5.4-C）。 */
  function configureGizmo() {
    if (!tc) return
    const id = sel.length === 1 ? sel[0] : null
    const c = id ? S.compById(doc, id) : null
    const e = id ? entries.get(id) : null
    const pe = c && c.parent != null ? entries.get(c.parent) : null
    if (!c || !e || !pe || !e.poseM || !pe.poseM || c.locked || c.hidden || posePreview || dr.active || !attached) { detachGizmo(); vp.invalidate(); return }
    const a = c.attach, Mp = pe.poseM
    tc.minX = tc.minY = tc.minZ = -Infinity; tc.maxX = tc.maxY = tc.maxZ = Infinity
    tc.showX = tc.showY = tc.showZ = true
    pivot.scale.set(1, 1, 1)
    gizmoLook(a.mode === 'socket' || (a.mode === 'surface' && tool !== 'move'))
    if (a.mode === 'socket') {
      const s = pe.sockets.find((x) => x.id === a.socket)
      if (!s) { detachGizmo(); return }
      S.m4Mul(gz.frame, Mp, S.socketFrame(T0, s))
      pivot.position.set(0, 0, 0)
      pivot.quaternion.setFromAxisAngle(_Z, (Number(a.roll) || 0) * D2R)
      tc.setMode('rotate')
      tc.showX = false; tc.showY = false
      gz.rollStep = s.roll > 0 ? s.roll : snap.rotate
    } else if (a.mode === 'surface') {
      const f = pe.faces.find((x) => x.id === a.face)
      if (!f) { detachGizmo(); return }
      gz.face = f
      const uv = Array.isArray(a.uv) ? a.uv : [0, 0]
      gz.v0 = f.kind === 'cyl' ? uv[1] : 0
      S.m4Mul(gz.frame, Mp, S.faceFrame(T0, f, 0, gz.v0))
      pivot.position.set(uv[0], uv[1] - gz.v0, 0)
      if (tool === 'move') {
        tc.setMode('translate')
        tc.showZ = false
        pivot.quaternion.identity()
        tc.minX = -f.halfU; tc.maxX = f.halfU
        if (f.kind !== 'cyl') { tc.minY = -f.halfV; tc.maxY = f.halfV }
      } else {
        tc.setMode('rotate')
        tc.showX = false; tc.showY = false
        pivot.quaternion.setFromAxisAngle(_Z, (Number(a.roll) || 0) * D2R)
      }
    } else {
      S.m4Mul(gz.anchor, Mp, S.anchorFrame(T0, c, pe))
      const W = e.poseM
      if (space === 'local') { S.m4Copy(gz.frame, W); pivot.position.set(0, 0, 0); pivot.quaternion.identity() } else if (space === 'mount') { S.m4Copy(gz.frame, gz.anchor); S.m4Mul(T1, S.m4InvRigid(T2, gz.anchor), W); setPivotFrom(T1) } else { S.m4Ident(gz.frame); setPivotFrom(W) }
      tc.setMode(tool === 'move' ? 'translate' : 'rotate')
    }
    const el = frameHolder.matrix.elements
    for (let i = 0; i < 16; i++) el[i] = gz.frame[i]
    frameHolder.matrixWorldNeedsUpdate = true
    pivot.updateMatrix()
    gz.id = id; gz.comp = c; gz.mode = a.mode
    tc.rotationSnap = a.mode === 'free' && snap.on && !shiftDown ? snap.rotate * D2R : null
    tc.attach(pivot)
    tc.enabled = true
    if (!helperOn) { vp.overlay.add(tc.getHelper()); helperOn = true }
    vp.invalidate()
  }
  function onGizmoDown() {
    if (!gz.id) return
    gz.active = true; gz.dirty = false
    gz.before = JSON.stringify(doc)
    clash.cancel()
    vp.killInertia()
    st.dirtyGeom = true
    setMode('gizmo')
    dragEv.phase = 'start'; dragEv.kind = 'gizmo'; dragEv.id = gz.id; dragEv.attach = gz.comp.attach
    emit('drag', dragEv)
  }
  /** 把 pivot 的变化换算回安装语义（帧钩子里做；零分配）。 */
  function applyGizmo() {
    gz.dirty = false
    const c = gz.comp
    if (!c) return
    pivot.updateMatrix()
    const P = pivot.matrix.elements
    const snapOn = snap.on && !shiftDown
    if (gz.mode === 'socket' || (gz.mode === 'surface' && tc.mode === 'rotate')) {
      let r = S.twistDeg(P)
      const step = gz.mode === 'socket' ? gz.rollStep : snap.rotate
      if (snapOn && step > 0) {
        const rs = S.snapAngle(r, step)
        if (rs !== r) { r = rs; pivot.quaternion.setFromAxisAngle(_Z, r * D2R); pivot.updateMatrix() }
      }
      c.attach.roll = r
    } else if (gz.mode === 'surface') {
      inf.u = P[12]; inf.v = P[13] + gz.v0; inf.kind = 0
      if (snapOn) {
        pivot.getWorldPosition(_v)
        inf.ppm = cssH() / (2 * Math.max(1e-6, _v.distanceTo(vp.camera.position)) * Math.tan(vp.camera.fov * Math.PI / 360))
        S.faceInferIO(gz.face, inf, S.INFER_PX, snap.move)
      }
      S.clampIO(gz.face, inf)
      if (pivot.position.x !== inf.u || pivot.position.y !== inf.v - gz.v0) { pivot.position.set(inf.u, inf.v - gz.v0, 0); pivot.updateMatrix() }
      c.attach.uv[0] = inf.u; c.attach.uv[1] = inf.v
    } else {
      if (tc.mode === 'translate' && snapOn && snap.move > 0) {
        const x = S.snapTo(pivot.position.x, snap.move), y = S.snapTo(pivot.position.y, snap.move), z = S.snapTo(pivot.position.z, snap.move)
        if (x !== pivot.position.x || y !== pivot.position.y || z !== pivot.position.z) { pivot.position.set(x, y, z); pivot.updateMatrix() }
      }
      S.m4Mul(T0, gz.frame, P)
      S.m4Mul(T1, S.m4InvRigid(T2, gz.anchor), T0)
      S.m4ToQT(T1, c.q, c.t)
    }
    afterLiveEdit(0)
    dragEv.phase = 'move'
    dragEvDirty = true
  }
  /** Esc：放弃这次 gizmo 拖动（文档回到按下时）。 */
  function cancelGizmo() {
    if (!gz.active) return
    gz.active = false; gz.dirty = false
    if (tc && tc.dragging) { tc.pointerUp({ x: 0, y: 0, button: 0 }); vp.canvas.removeEventListener('pointermove', tc._onPointerMove) }
    vp.controls.enabled = true
    setMode('idle')
    dragEv.phase = 'cancel'; dragEv.kind = 'gizmo'; dragEv.id = gz.id
    emit('drag', dragEv)
    doc = normalizeAssembly(JSON.parse(gz.before))
    sync('cancel', [], false)
  }
  function onGizmoUp() {
    if (!gz.active) return
    if (gz.dirty) applyGizmo()
    gz.active = false
    const id = gz.id
    setMode('idle')
    dragEv.phase = 'end'; dragEv.kind = 'gizmo'; dragEv.id = id
    emit('drag', dragEv)
    const next = normalizeAssembly(doc)
    const after = JSON.stringify(next)
    // 点了手柄没拖（或拖回原处）：文档没变 → 不入撤销栈、不算提交
    if (after === gz.before) { doc = next; st.dirtyGeom = false; sync('gizmo', [id], false, after); return }
    pushHist(tool === 'move' ? 'move' : 'rotate', gz.before, after)
    doc = next
    sync(tool === 'move' ? 'move' : 'rotate', [id], true, after)
  }
  /** 拖动中改了文档之后：解算 → 写矩阵 → 叠加跟随 → 质量 → 包围盒读数 → 视口随动（零分配）。 */
  function afterLiveEdit(extraBoxes) {
    solvePose(doc, poses)
    writeMatrices()
    fx.follow()
    if (dr.active) dragMass(); else updateMass(doc, massOut)
    liveBBox(extraBoxes)
    st.dirtyGeom = true
    statsDirty = true
    if (attached) vp.refreshLive(MOVED)
  }

  // ═════════════════════════ 拖入 ghost / 拾起（共用吸附求解）═════════════════════════
  const dr = {
    active: false, kind: 'ghost', pending: false, valid: false, empty: false,
    type: '', def: null, item: null, params: null, comp: null, doc: null, poses: null, mass: null,
    id: '', roll: 0, uv: [0, 0], count: 1, derivedIds: [], before: '', label: '',
    cN: 0, cE: [], cS: [], cMount: [], cLabel: [], cPos: new Float64Array(0), cNrm: new Float64Array(0), cX: new Float64Array(0), cY: new Float64Array(0), cOcc: new Uint8Array(0),
    moving: new Set(), symBlock: false, symWanted: null, wasInvalid: false, massMode: 0, rootEntries: [], rect: null, faceKey: -1, faceEntry: null, statusKey: -2, activeSock: -1, center: new THREE.Vector3(),
    boxBase: 0
  }

  /** 候选插座（拖动开始时建一次）：可见、非移动、兼容、空闲、不是非根件自己的安装插座；pickup 且移动子树自带对称时跳过对称子树。 */
  function buildCandidates(type, movingPrimary) {
    const used = S.usedSocketKeys(doc, movingPrimary)
    let n = 0
    for (const e of list) n += e.sockets.length
    if (dr.cPos.length < 3 * n) { const cap = Math.max(64, 2 * n); dr.cPos = new Float64Array(3 * cap); dr.cNrm = new Float64Array(3 * cap); dr.cX = new Float64Array(cap); dr.cY = new Float64Array(cap) }
    dr.cE.length = 0; dr.cS.length = 0; dr.cMount.length = 0; dr.cLabel.length = 0
    n = 0
    for (const e of list) {
      if (!e.visible || dr.moving.has(e.id)) continue
      if (dr.symBlock && e.symTaint) continue
      const own = ownMountId(e.comp)
      for (const s of e.sockets) {
        if (s.id === own || used.has(`${e.pid}|${s.id}`)) continue
        if (s.accepts != null && !s.accepts.some((p) => type.startsWith(p))) continue
        socketBody(e, s, dr.cPos, dr.cNrm, n)
        dr.cE.push(e); dr.cS.push(s)
        const m = S.mountFor(dr.def, dr.params, s)
        dr.cMount.push(m === dr.def.mountSocket ? null : m)
        dr.cLabel.push(`吸附：插座 ${s.id}`)
        n++
      }
    }
    dr.cN = n
    ov.sockets.set(dr.cPos, dr.cNrm, n, 1)
    ov.sockets.visible = true
    dr.activeSock = -1
    // 遮挡未判之前按「挡住」算（不画、不吸附），空闲时段里分片判完再放出来
    if (dr.cOcc.length < n) dr.cOcc = new Uint8Array(Math.max(64, 2 * n))
    for (let i = 0; i < n; i++) { dr.cOcc[i] = 1; ov.sockets.occl(i, true) }
    occludeCandidates()
  }
  function beginDrag(kind) {
    dr.active = true; dr.kind = kind; dr.pending = true; dr.valid = false
    dr.faceKey = -1; dr.faceEntry = null; dr.statusKey = -2
    dr.rect = vp.canvas.getBoundingClientRect()
    hy.reset()
    clash.cancel()
    detachGizmo()
    hoverId = null
    // 无效位的承托平面过装配中心
    liveBBox(0)
    const b = st.bbox, cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2
    dr.center.set(D[0] * cx + D[4] * cy + D[8] * cz, D[1] * cx + D[5] * cy + D[9] * cz, D[2] * cx + D[6] * cy + D[10] * cz)
    vp.controls.enableZoom = false
    window.addEventListener('pointermove', onDragMove, true)
    window.addEventListener('pointerup', onDragUp, true)
    window.addEventListener('pointerdown', onDragDown, true)
    window.addEventListener('pointercancel', onDragCancel, true)
    window.addEventListener('keydown', onDragKey, true)
    window.addEventListener('keyup', onDragKeyUp, true)
    window.addEventListener('wheel', onDragWheel, { capture: true, passive: false })
    document.body.style.cursor = kind === 'ghost' ? 'grabbing' : 'move'
    setMode(kind)
    dragEv.phase = 'start'; dragEv.kind = kind; dragEv.id = dr.id; dragEv.attach = dr.comp.attach
    emit('drag', dragEv)
    vp.invalidate()
  }
  function endDragListeners() {
    if (candIdle) { idleCancel(candIdle); candIdle = 0 }
    window.removeEventListener('pointermove', onDragMove, true)
    window.removeEventListener('pointerup', onDragUp, true)
    window.removeEventListener('pointerdown', onDragDown, true)
    window.removeEventListener('pointercancel', onDragCancel, true)
    window.removeEventListener('keydown', onDragKey, true)
    window.removeEventListener('keyup', onDragKeyUp, true)
    window.removeEventListener('wheel', onDragWheel, { capture: true })
    document.body.style.cursor = ''
    vp.controls.enableZoom = true
  }
  function onDragMove(ev) {
    lastPtr.x = ev.clientX; lastPtr.y = ev.clientY; lastPtr.in = true
    if (shiftDown !== ev.shiftKey) shiftDown = ev.shiftKey
    dr.pending = true
    vp.invalidate()
  }
  function onDragUp(ev) {
    if (dr.kind !== 'ghost' || ev.button !== 0) return
    lastPtr.x = ev.clientX; lastPtr.y = ev.clientY
    solveDrag()
    finishDrag(dr.valid)
  }
  function onDragDown(ev) {
    if (dr.kind !== 'pickup') return
    ev.preventDefault(); ev.stopPropagation()
    if (ev.button === 0) { lastPtr.x = ev.clientX; lastPtr.y = ev.clientY; solveDrag(); finishDrag(dr.valid) } else if (ev.button === 2) finishDrag(false)
  }
  function onDragCancel() { finishDrag(false) }
  function onDragKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finishDrag(false); return }
    if (ev.key === 'Shift' && !shiftDown) { shiftDown = true; dr.pending = true; vp.invalidate() }
  }
  function onDragKeyUp(ev) { if (ev.key === 'Shift' && shiftDown) { shiftDown = false; dr.pending = true; vp.invalidate() } }
  function onDragWheel(ev) {
    ev.preventDefault(); ev.stopPropagation()
    const d = ev.deltaY || ev.deltaX
    if (!d) return
    const step = ev.shiftKey ? 1 : S.WHEEL_ROLL_DEG
    dr.roll = S.snapAngle(dr.roll + (d < 0 ? step : -step), 0)
    dr.pending = true
    vp.invalidate()
  }

  /** ghost 件的对称：父件在对称子树里 → 继承（不叠工具栏对称）；否则带工具栏对称。返回展开份数。 */
  function ghostSymFor(pid) {
    dr.comp.sym = null
    dr.symWanted = null
    if (pid == null) return 1
    for (const aid of [pid, ...S.ancestorsOf(doc, pid)]) {
      const a = S.compById(doc, aid)
      if (a && a.sym) return a.sym.op === 'radial' ? (a.sym.n || 2) : 2
    }
    const s = S.symFromUi(symUi.op, symUi.n, doc.domain)
    if (!s) return 1
    s.group = dr.id
    dr.comp.sym = s
    dr.symWanted = s
    return s.op === 'radial' ? s.n : 2
  }
  /** 展开份数变了（换父 / 对称压制切换）时重排派生 id 与 ghost 池。 */
  function setGhostCount(n) {
    dr.count = n
    dr.derivedIds.length = 0
    for (let k = 1; k < n; k++) dr.derivedIds.push(`${dr.id}~${k}`)
    ghost.ensure(n)
  }
  /** 拖动件换父（只在候选的父件变了时调：允许分配）。 */
  function setDragParent(pid) {
    const c = dr.comp
    if (c.parent === pid) return
    const inh0 = dr.kind === 'pickup' ? inhCount(c.parent) : 0
    c.parent = pid
    if (dr.kind === 'ghost') setGhostCount(ghostSymFor(pid))
    else if (inhCount(pid) !== inh0) pickupRestructure()   // pickup：对称展开份数变了（继承 / 不再继承）
  }
  /** 拾起中对称展开份数变了（换父件改了继承、落到对称面上临时去掉自带对称）：重建条目，移动集合与拾取表跟着更新。只在切换时调（会分配）。 */
  function pickupRestructure() {
    rebuildEntries()
    const sub = new Set(S.subtreeOf(doc, dr.id))
    dr.moving.clear()
    for (const e of list) if (sub.has(e.pid)) dr.moving.add(e.id)
    maskMoving()
    dr.rootEntries = list.filter((e) => e.pid === dr.id)
    refreshFx()
    if (attached) vp.refreshLive({ meshes: true })
  }
  /** 拾起：移动子树的网格不参与拾取（射线不打自己）。 */
  function maskMoving() {
    for (let i = 0; i < pickList.length; i++) { const e = meshEntry.get(pickList[i]); pickMask[i] = e && dr.moving.has(e.id) ? 0 : 1 }
  }
  /** 挂在 pid 下的件会被展开成几份（pid 或其祖先的对称份数；没有 1）。只在换父件时调。 */
  function inhCount(pid) {
    for (let a = pid, g = 0; a != null && g < 1000; g++) {
      const x = S.compById(doc, a)
      if (!x) return 1
      if (x.sym) return x.sym.op === 'radial' ? (x.sym.n || 2) : 2
      a = x.parent
    }
    return 1
  }

  /** 每帧一次（帧钩子里）：按指针位置求吸附候选、改拖动件的安装语义、解算、上屏。零分配（除换父件）。 */
  function solveDrag() {
    dr.pending = false
    const r = dr.rect
    const px = lastPtr.x, py = lastPtr.y
    if (!(px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)) { dragInvalid(false); return }
    setRay(px, py, r)
    const cam = vp.camera
    // 1) 插座候选投屏（背面剔除）
    let si = -1, sd = Infinity
    if (dr.cN && !shiftDown) {
      camBody(CB)
      for (let i = 0; i < dr.cN; i++) {
        const o = 3 * i, x = dr.cPos[o], y = dr.cPos[o + 1], z = dr.cPos[o + 2]
        // 背面（朝外法向背离相机）与被别的件挡住的候选：不吸附（也不画，见 asmOverlay）
        if (dr.cOcc[i] || (CB[0] - x) * dr.cNrm[o] + (CB[1] - y) * dr.cNrm[o + 1] + (CB[2] - z) * dr.cNrm[o + 2] < 0) { dr.cX[i] = NaN; continue }
        _v.set(D[0] * x + D[4] * y + D[8] * z, D[1] * x + D[5] * y + D[9] * z, D[2] * x + D[6] * y + D[10] * z).project(cam)
        if (_v.z > 1 || _v.z < -1) { dr.cX[i] = NaN; continue }
        dr.cX[i] = (_v.x * 0.5 + 0.5) * r.width + r.left
        dr.cY[i] = (0.5 - _v.y * 0.5) * r.height + r.top
      }
      si = S.pickNearest(dr.cX, dr.cY, dr.cN, px, py, S.SOCKET_PX)
      if (si >= 0) { const dx = dr.cX[si] - px, dy = dr.cY[si] - py; sd = Math.sqrt(dx * dx + dy * dy) }
    }
    // 2) 表面（BVH 射线，排除 ghost / 移动子树）
    const hit = castPick(), he = pickHit.e
    let pe = null, fi = -1, surfKey = -1
    if (hit) {
      pe = he.k > 0 ? entries.get(he.pid) : he
      toBody(hit.point, HP)
      HW[0] = HP[0]; HW[1] = HP[1]; HW[2] = HP[2]
      _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
      if (_n.dot(rc.ray.direction) > 0) _n.negate()
      toBody(_n, HN)
      if (he.k > 0 && pe) S.mirrorHitToPrimary(he.poseM, pe.poseM, he.plane, HP, HN, HP, HN)
      if (pe && pe.poseM) {
        // 面判据：离面容差 max(2 mm, 0.2 % 件尺寸)；面外侧再让出一层蒙皮（MLI / 散热面离结构面几厘米）：min(5 cm, 3 % 件尺寸)
        faceOut.tol = pe.size > 1 ? 0.002 * pe.size : 0.002
        faceOut.skin = 0.03 * pe.size < 0.05 ? 0.03 * pe.size : 0.05
        fi = S.faceAtHit(pe.faces, pe.poseM, HP, HN, undefined, faceOut)
        surfKey = fi >= 0 ? KEY_FACE + pe.index * 64 + fi : KEY_FREE + pe.index
      }
    }
    // 3) 滞回：当前候选本帧还有效就先报它的代价，再报本帧最优
    const cur = hy.key
    if (cur >= KEY_SOCK && cur < KEY_FACE) {
      const j = cur - KEY_SOCK
      let dj = Infinity
      if (!shiftDown && j < dr.cN && dr.cX[j] === dr.cX[j]) { const dx = dr.cX[j] - px, dy = dr.cY[j] - py; dj = Math.sqrt(dx * dx + dy * dy) }
      if (dj <= S.SOCKET_PX + S.HYSTERESIS_PX) hy.offer(cur, dj); else hy.reset()
    } else if (cur >= KEY_FACE && cur < KEY_ROOT) { if (cur !== surfKey) hy.reset() } else if (cur === KEY_ROOT) { if (!dr.empty) hy.reset() } else hy.reset()
    if (si >= 0) hy.offer(KEY_SOCK + si, sd)
    else if (surfKey >= 0) hy.offer(surfKey, S.SOCKET_PX)
    else if (dr.empty) hy.offer(KEY_ROOT, 0)
    const key = hy.key
    if (key < 0) { dragInvalid(true); return }
    const c = dr.comp, a = c.attach
    let markerKind = 0
    if (key === KEY_ROOT) {
      setDragParent(null)
      a.mode = 'free'; a.socket = null; a.face = null; a.uv = null; a.roll = 0; a.mount = null
      hideFace(); ov.marker.showAt(Z3, 0, 5)
      markActiveSock(-1)
      statusFor(KEY_ROOT, 0, '吸附：原点')
    } else if (key < KEY_FACE) {
      const i = key - KEY_SOCK, e = dr.cE[i], s = dr.cS[i]
      setDragParent(e.pid)
      a.mode = 'socket'; a.socket = s.id; a.face = null; a.uv = null; a.mount = dr.cMount[i]
      a.roll = s.roll > 0 ? S.snapAngle(dr.roll, s.roll) : 0
      hideFace()
      ov.marker.showAt(dr.cPos, 3 * i, 5)
      markActiveSock(i)
      statusFor(key, 0, dr.cLabel[i])
    } else if (key < KEY_FREE && hit && pe && fi >= 0) {
      const f = pe.faces[fi]
      setDragParent(pe.pid)
      inf.u = faceOut.u; inf.v = faceOut.v; inf.kind = 0
      if (snap.on && !shiftDown) {
        inf.ppm = dr.rect.height / (2 * Math.max(1e-6, hit.distance) * Math.tan(cam.fov * Math.PI / 360))
        S.faceInferIO(f, inf, S.INFER_PX, snap.move)
      }
      S.clampIO(f, inf)
      dr.uv[0] = inf.u; dr.uv[1] = inf.v
      a.mode = 'surface'; a.socket = null; a.face = f.id; a.uv = dr.uv; a.mount = null
      a.roll = snap.on && !shiftDown ? S.snapAngle(dr.roll, snap.rotate) : dr.roll
      markerKind = inf.kind
      // 锚点记号画在指针那一侧（命中派生件时从主件映回派生件）
      S.faceFrameUV(T0, f, dr.uv)
      S.m4Mul(T1, pe.m, T0)
      if (he !== pe) { S.m4Mul(T0, S.m4InvRigid(T2, pe.m), T1); S.m4Mul(T1, he.m, T0) }
      ov.marker.showAt(T1, 12, markerKind)
      if (dr.faceKey !== key || dr.faceEntry !== he) { ov.face.show(he.m, f, S.faceFrame); dr.faceKey = key; dr.faceEntry = he }
      markActiveSock(-1)
      statusFor(key * 8 + inf.kind, inf.kind, null, f.id)
    } else if (hit && pe) {
      // 自由贴：mount 插座法向贴命中法向；滚转零位取父件局部轴在切平面上投影最长的那根
      setDragParent(pe.pid)
      const M = pe.poseM
      let bx = 0, by = 0, bz = 0, bl = -1
      for (let k = 0; k < 3; k++) {
        const ax = M[4 * k], ay = M[4 * k + 1], az = M[4 * k + 2], dd = ax * HN[0] + ay * HN[1] + az * HN[2]
        const tx = ax - dd * HN[0], ty = ay - dd * HN[1], tz = az - dd * HN[2], l = tx * tx + ty * ty + tz * tz
        if (l > bl + 1e-12) { bl = l; bx = tx; by = ty; bz = tz }
      }
      CB[0] = bx; CB[1] = by; CB[2] = bz
      S.frameZX(T0, HP, HN, CB, 1)
      S.m4RotZ(T1, shiftDown ? dr.roll : S.snapAngle(dr.roll, S.WHEEL_ROLL_DEG))
      S.m4Mul(T2, T0, T1)
      const ms = mountSocketFor(c)
      if (ms) { S.mountFrame(T0, ms); S.m4InvRigid(T1, T0); S.m4Mul(T3, T2, T1) } else S.m4Copy(T3, T2)
      S.m4Mul(T0, S.m4InvRigid(T1, M), T3)
      S.m4ToQT(T0, c.q, c.t)
      a.mode = 'free'; a.socket = null; a.face = null; a.uv = null; a.roll = 0; a.mount = null
      hideFace(); ov.marker.showAt(HW, 0, 0)
      markActiveSock(-1)
      statusFor(key, 0, '吸附：表面')
    } else { dragInvalid(true); return }
    // 解算 + 上屏
    dr.valid = true
    if (dr.kind === 'ghost') {
      solvePose(dr.doc, dr.poses)
      // 工具栏对称的件几何落在对称面 / 对称轴上（KSP 的堆叠节点口径）：副本会与原件重合，这一次放置不带对称；离开对称面再带上。
      // 按几何判（件的包围盒中心），不按原点：机翼这种从中线插座往外长的件原点在对称面上、几何在一侧，照样带镜像
      if (dr.symWanted) {
        const pm = dr.poses.get(dr.id)
        const want = !(pm && onSymLocus(dr.symWanted, pm.m, dr.item.box6))
        if (want !== (dr.comp.sym !== null)) {
          dr.comp.sym = want ? dr.symWanted : null
          setGhostCount(want ? (dr.symWanted.op === 'radial' ? dr.symWanted.n : 2) : 1)
          solvePose(dr.doc, dr.poses)
        }
      }
      const p0 = dr.poses.get(dr.id)
      if (p0) ghost.place(0, p0.m, -1)
      for (let k = 1; k < dr.count; k++) {
        const p = dr.poses.get(dr.derivedIds[k - 1])
        if (p) ghost.place(k, p.m, p.plane === 'yz' ? 0 : p.plane === 'xz' ? 1 : p.plane === 'xy' ? 2 : -1)
      }
      ghost.showCount(dr.count)
      ghost.setValid(true)
      packGhostBoxes()
      dragMass()
      liveBBox(dr.count)
      statsDirty = true
    } else {
      // 拾起带自带对称的件：同一口径——落到对称面 / 轴上时临时只留一份（松手提交即去掉对称），离开再带上。只在切换时重建条目
      if (dr.symWanted) {
        solvePose(doc, poses)
        const pm = poses.get(dr.id), e0 = entries.get(dr.id)
        const want = !(pm && onSymLocus(dr.symWanted, pm.m, e0 && e0.item ? e0.item.box6 : null))
        if (want !== (dr.comp.sym !== null)) { dr.comp.sym = want ? dr.symWanted : null; pickupRestructure() }
      }
      afterLiveEdit(0)
      if (dr.wasInvalid) { dr.wasInvalid = false; refreshFx() }
    }
    dragEv.phase = 'move'
    dragEvDirty = true
    vp.invalidate()
  }
  /** 藏目标面轮廓并复位缓存键（藏了不复位的话，指针途经插座候选再回到同一个面，轮廓不再出来）。 */
  function hideFace() { ov.face.hide(); dr.faceKey = -1; dr.faceEntry = null }
  function mountSocketFor(c) {
    const def = getComponent(c.type)
    if (!def) return null
    const id = c.attach.mount || def.mountSocket
    const list0 = dr.item && dr.kind === 'ghost' ? dr.item.sockets : (entries.get(c.id) || {}).sockets || []
    for (let i = 0; i < list0.length; i++) if (list0[i].id === id) return list0[i]
    return null
  }
  function packGhostBoxes() {
    const b = dr.item.box6
    for (let k = 0; k < dr.count && k < 8; k++) {
      const o = 6 * (nBoxes + k), om = 16 * (nBoxes + k)
      for (let j = 0; j < 6; j++) boxesP[o + j] = b[j]
      const p = k === 0 ? dr.poses.get(dr.id) : dr.poses.get(dr.derivedIds[k - 1])
      if (p) for (let j = 0; j < 16; j++) matsP[om + j] = p.m[j]
    }
  }
  function markActiveSock(i) {
    if (dr.activeSock === i) return
    if (dr.activeSock >= 0) ov.sockets.state(dr.activeSock, 1)
    if (i >= 0) ov.sockets.state(i, 2)
    dr.activeSock = i
  }
  /** 状态栏吸附文案：只在候选 / 推断类型变了时拼串（热路径不每帧分配）。 */
  function statusFor(key, kind, text, faceId) {
    if (dr.statusKey === key) return
    dr.statusKey = key
    setStatus('snap', text || INFER_TEXT[kind] || `吸附：贴面 ${faceId}`)
  }
  /** 无效位：ghost 停在过装配中心、垂直视线的平面上并改 danger 色；pickup 件同样跟到平面上（红染），松手 = 复原。 */
  function dragInvalid(inside) {
    hy.reset()
    dr.valid = false
    hideFace(); ov.marker.hide()
    markActiveSock(-1)
    if (dr.statusKey !== -1) { dr.statusKey = -1; setStatus('', '') }
    dragEv.phase = 'move'
    if (!inside) { if (dr.kind === 'ghost') ghost.hide(); dragEvDirty = true; vp.invalidate(); return }
    const cam = vp.camera
    cam.getWorldDirection(_v2)
    _plane.setFromNormalAndCoplanarPoint(_v2, dr.center)
    if (!rc.ray.intersectPlane(_plane, _v)) { if (dr.kind === 'ghost') ghost.hide(); return }
    toBody(_v, HP)
    if (dr.kind === 'ghost') {
      S.m4RotZ(T0, dr.roll); T0[12] = HP[0]; T0[13] = HP[1]; T0[14] = HP[2]
      ghost.place(0, T0, -1); ghost.showCount(1); ghost.setValid(false)
      dragMass()
      liveBBox(0)
    } else {
      const c = dr.comp, e = entries.get(dr.id), pe = c.parent != null ? entries.get(c.parent) : null
      if (e && pe && e.poseM && pe.poseM) {
        S.m4Copy(T3, e.poseM); T3[12] = HP[0]; T3[13] = HP[1]; T3[14] = HP[2]
        S.m4Mul(T0, S.m4InvRigid(T1, pe.poseM), T3)
        S.m4ToQT(T0, c.q, c.t)
        const ca = c.attach
        ca.mode = 'free'; ca.socket = null; ca.face = null; ca.uv = null; ca.roll = 0; ca.mount = null
        afterLiveEdit(0)
      }
      if (!dr.wasInvalid) { dr.wasInvalid = true; refreshFx() }
    }
    dragEvDirty = true
    vp.invalidate()
  }

  /** 结束拖入 / 拾起：ok = 在有效位提交（一条撤销）；否则取消 / 复原。 */
  function finishDrag(ok) {
    if (!dr.active) return
    endDragListeners()
    const kind = dr.kind, id = dr.id
    dr.active = false
    ghost.hide(); ghost.setItem(null)
    ov.hideDrag()
    setStatus('', '')
    dragEv.phase = ok ? 'end' : 'cancel'; dragEv.kind = kind; dragEv.id = id
    if (kind === 'ghost') {
      if (ok) {
        const c = dr.comp
        const spec = { id, type: dr.type, params: dr.params, parent: c.parent, attach: { ...c.attach, uv: Array.isArray(c.attach.uv) ? c.attach.uv.slice() : null }, t: c.t.slice(), q: c.q.slice(), sym: c.sym ? { ...c.sym } : null }
        const r = S.addComp(doc, spec)
        setMode('idle')
        emit('drag', dragEv)
        if (r.ok) { commitDoc('add', r.doc, [r.id]); sel = []; select([r.id]); return }
        setStatus('warn', r.error)
      } else { setMode('idle'); emit('drag', dragEv) }
      refreshSocketMarkers(); updateMass(doc, massOut); liveBBox(0); configureGizmo(); flushIdle()
      return
    }
    // pickup / duplicate
    setMode('idle')
    emit('drag', dragEv)
    if (ok) {
      const next = normalizeAssembly(doc)
      const after = JSON.stringify(next)
      doc = next
      const moved = after !== dr.before
      if (moved) pushHist(dr.label, dr.before, after)
      sync(dr.label, [id], moved, after)
      // 带对称的件落在对称面 / 轴上（拖动中已只显示一份）：提交时去掉了对称
      if (moved && dr.symWanted) { const c = S.compById(doc, id); if (c && !c.sym) setStatus('warn', `${nameOf(id)} 已去掉对称。`) }
    } else {
      doc = normalizeAssembly(JSON.parse(dr.before))
      sync('cancel', [], false)
      emitSelIfPruned()
    }
  }
  function flushIdle() { statsDirty = true; vp.invalidate() }

  function beginDragFromLib(type, clientX, clientY, o = {}) {
    if (!attached || busy() || posePreview) return false
    const def = getComponent(type)
    if (!def || !def.domain.includes(doc.domain)) return false
    const params = o && o.params && typeof o.params === 'object' ? JSON.parse(JSON.stringify(o.params)) : {}
    let item
    try { item = cache.get({ type, params, material: null }) } catch { return false }
    cache.prep(item, true)   // 边线 / BVH 插队：ghost 露面时有边线、落下时有 BVH（库卡片按下时多半已经预热过）
    dr.type = type; dr.def = def; dr.item = item; dr.params = params
    dr.id = S.compIdFor(doc, type)
    dr.roll = 0; dr.uv[0] = 0; dr.uv[1] = 0; dr.count = 1; dr.derivedIds.length = 0; dr.wasInvalid = false; dr.symWanted = null
    dr.empty = doc.comps.length === 0
    dr.comp = { id: dr.id, type, params: fillParams(def, params), parent: undefined, attach: { mode: 'free', socket: null, face: null, uv: null, roll: 0, mount: null }, sym: null, name: null, massKg: null, material: null, hidden: false, locked: false, t: [0, 0, 0], q: [0, 0, 0, 1] }
    dr.doc = { kind: 'assembly', schema: doc.schema, domain: doc.domain, name: doc.name, comps: [...doc.comps, dr.comp], density: doc.density, massTargetKg: doc.massTargetKg }
    dr.poses = new Map()
    dr.moving.clear(); dr.symBlock = false
    buildCandidates(type, null)
    // 质量预览：静态 = 当前文档（缓存命中）；拖动件 = 几何缓存条目上记着的单件质量特性（不再现拼一份单件文档从头生成）
    updateMass(doc, massOut)
    S.massPack(massOut, MA0)
    dr.massMode = doc.massTargetKg == null ? 1 : 2
    MA1.set(cache.mass13(item, doc.density, doc.domain))
    ghost.setItem(item); ghost.setPalette(pal); ghost.hide()
    lastPtr.x = clientX; lastPtr.y = clientY; lastPtr.in = true
    beginDrag('ghost')
    return true
  }

  function startPickup(id, label, before) {
    const c = S.compById(doc, id)
    if (!c) return false
    if (!c.t) c.t = [0, 0, 0]
    if (!c.q) c.q = [0, 0, 0, 1]
    const def = getComponent(c.type)
    dr.type = c.type; dr.def = def; dr.item = null; dr.params = c.params
    dr.id = id; dr.comp = c; dr.doc = doc; dr.poses = poses; dr.count = 1; dr.derivedIds.length = 0
    dr.roll = Number(c.attach.roll) || 0; dr.uv[0] = 0; dr.uv[1] = 0; dr.wasInvalid = false
    dr.symWanted = c.sym ? { ...c.sym } : null   // 自带对称：落到对称面 / 轴上临时去掉（solveDrag），松手时按那一刻的状态提交
    dr.empty = false
    dr.before = before; dr.label = label
    const sub = new Set(S.subtreeOf(doc, id))
    dr.moving.clear()
    for (const e of list) if (sub.has(e.pid)) dr.moving.add(e.id)
    dr.symBlock = S.subtreeHasOwnSym(doc, id)
    maskMoving()
    dr.rootEntries = list.filter((e) => e.pid === id)
    // 质量预览：静态 = 去掉移动子树的文档、拖动件 = 以移动件为根的子树文档（各算一次，常驻 out：计划过继 + 模块级生成缓存都命中）；
    // 有目标质量的走整份 combineMass（余量归平台体，随拾起件的份数变；换父件时计划重建、生成缓存过继，不重跑生成）
    dr.massMode = 0
    if (doc.massTargetKg == null) {
      try {
        const base = { kind: 'assembly', domain: doc.domain, name: doc.name, density: doc.density, massTargetKg: null }
        S.massPack(combineMass(normalizeAssembly({ ...base, comps: doc.comps.filter((x) => !sub.has(x.id)) }), massStatic), MA0)
        S.massPack(combineMass(normalizeAssembly({ ...base, comps: doc.comps.filter((x) => sub.has(x.id)).map((x) => (x.id === id ? { ...x, parent: null, attach: null, sym: null, t: undefined, q: undefined } : x)) }), massMoving), MA1)
        dr.massMode = 1
      } catch { dr.massMode = 0 }
    }
    buildCandidates(c.type, sub)
    beginDrag('pickup')
    dr.valid = true   // 还没动：件在原位，是有效位
    refreshFx()
    if (!lastPtr.in) dr.pending = false
    return true
  }
  function pickup() {
    if (!attached || busy() || posePreview) return false
    if (sel.length !== 1) return false
    const c = S.compById(doc, sel[0])
    if (!c) return false
    if (c.parent == null) { setStatus('warn', '根件不能拾起。'); return false }
    if (c.locked) { setStatus('warn', '件已锁定。'); return false }
    return startPickup(c.id, 'reattach', JSON.stringify(doc))
  }
  function duplicate() {
    if (busy() || posePreview || !sel.length) return false
    const before = JSON.stringify(doc)
    const r = S.duplicateComps(doc, sel)
    if (!r.ok) { setStatus('warn', r.error); return false }
    if (r.roots.length === 1 && attached) {
      doc = r.doc
      const geom = rebuildEntries()
      vp.refreshLive({ meshes: geom })
      sel = [r.roots[0]]
      emit('select', { ids: sel.slice(), primary: sel[0] })
      return startPickup(r.roots[0], 'duplicate', before)
    }
    const ok = commitDoc('duplicate', r.doc, r.roots)
    sel = []; select(r.roots)
    return ok
  }
  function remove() {
    if (busy() || !sel.length) return false
    const r = S.removeComps(doc, sel)
    if (!r.ok) { setStatus('warn', r.error); return false }
    sel = []
    commitDoc('remove', r.doc, r.removed)
    emit('select', { ids: [], primary: null })
    emitMode()
    return true
  }
  /**
   * M：开 / 关选中件的镜像对称。功能区选了镜像档就用它；否则先 XZ——只有 XZ 真的让副本压在原件上（件的几何在 XZ 面上，
   * applyCmd 以 code onLocus 拒收）才换 YZ；别的拒收理由（嵌套对称…）照报不换面。根件不能镜像。
   */
  function mirror() {
    if (busy() || !sel.length) return false
    const ops = symUi.op === 'mirrorXZ' || symUi.op === 'mirrorYZ' ? [symUi.op] : ['mirrorXZ', 'mirrorYZ']
    let d = doc, roots = 0
    for (const id of sel) {
      const c = S.compById(d, id)
      if (!c) continue
      if (c.parent == null) { roots++; continue }
      let r = null
      if (c.sym) r = S.applyCmd(d, { type: 'setSym', id, sym: null })
      else for (const op of ops) { r = S.applyCmd(d, { type: 'setSym', id, sym: { op } }); if (r.ok || r.code !== 'onLocus') break }
      if (!r.ok) { setStatus('warn', r.error); return false }
      d = r.doc
    }
    if (roots && roots === sel.length) { setStatus('warn', '根件不能镜像。'); return false }
    if (d === doc) return false
    return commitDoc('mirror', d, sel.slice())
  }
  function quickAdd(type) {
    if (busy() || posePreview) return false
    const def = getComponent(type)
    if (!def || !def.domain.includes(doc.domain)) return false
    let spec
    if (!doc.comps.length) spec = { type, parent: null }
    else {
      const root = doc.comps.find((c) => c.parent == null)
      const pid = sel.length ? sel[sel.length - 1] : (root ? root.id : null)
      const parent = pid ? S.compById(doc, pid) : null
      if (!parent) return false
      const socks = S.freeSocketsOf(doc, pid, type)
      if (socks.length) {
        const s = socks[0], m = S.mountFor(def, {}, s)
        spec = { type, parent: pid, attach: { mode: 'socket', socket: s.id, roll: 0, mount: m === def.mountSocket ? null : m } }
      } else {
        const faces = S.compGeo(parent).faces
        if (!faces.length) { setStatus('warn', '没有可用的插座。'); return false }
        spec = { type, parent: pid, attach: { mode: 'surface', face: faces[0].id, uv: [0, 0], roll: 0 } }
      }
      if (!S.inSymSubtree(doc, pid)) spec.sym = S.symFromUi(symUi.op, symUi.n, doc.domain)
    }
    let r = S.addComp(doc, spec)
    if (!r.ok) { setStatus('warn', r.error); return false }
    // 与拖入同一判据：件的几何落在对称面 / 轴上（副本会压在原件上）这一次不带对称
    const c = S.compById(r.doc, r.id)
    if (c && c.sym && S.symCoincides(r.doc, c)) { spec.sym = null; r = S.addComp(doc, spec) }
    commitDoc('add', r.doc, [r.id])
    sel = []; select([r.id])
    return true
  }

  // ═════════════════════════ 视口事件（attach 期间）═════════════════════════
  function ownerFn(kind, ev) {
    if (dr.active) return true
    if (kind === 'click') {
      if (tc && tc.object && tc.axis !== null) return true
      const e = entryAt(ev.clientX, ev.clientY)
      if (e) select([e.pid], { toggle: ev.ctrlKey || ev.metaKey, additive: ev.shiftKey })
      else if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey) select([])
      return true
    }
    if (kind === 'dbl') {
      const e = entryAt(ev.clientX, ev.clientY)
      if (!e) return false
      focusEntry(e)
      return true
    }
    return false
  }
  function onCanvasDownCap(ev) {
    down.x = ev.clientX; down.y = ev.clientY; down.b = ev.button
    // TransformControls 按下不看按键就抓指针、也不听 pointercancel：只让左键进它
    if (tc) tc.enabled = ev.button === 0 && !!gz.id && !posePreview && !dr.active
  }
  // 悬停拾取与渲染分开：指针一动只排编辑器自己的 rAF 做一次拾取，悬停件真换了才 refreshFx（它会 invalidate）；
  // 鼠标在同一件上晃不画帧（高刷屏上满帧率空转是持续的 GPU / 电量开销）
  let hoverRaf = 0
  function hoverFrame() { hoverRaf = 0; doHover() }
  function onCanvasMove(ev) {
    lastPtr.x = ev.clientX; lastPtr.y = ev.clientY; lastPtr.in = true
    if (ev.buttons || dr.active || gz.active) return
    if (!hoverRaf) hoverRaf = requestAnimationFrame(hoverFrame)
  }
  function onCanvasLeave() {
    lastPtr.in = false
    if (hoverId && !dr.active) { hoverId = null; refreshFx(); if (mode === 'hover') setMode('idle') }
  }
  /**
   * 视口右键菜单在 contextmenu 事件里开（不在 pointerup 里）：Windows 上 contextmenu 在 mouseup 之后才派发，pointerup 里先开了菜单，
   * 随后这个 contextmenu 落到刚插进来的菜单遮罩上、把菜单当场关掉。右键拖（> 5 px，平移视角）不开；键盘菜单键（button ≠ 2）不开。
   */
  function onCanvasCtx(ev) {
    ev.preventDefault()
    if (ev.button !== 2 || down.b !== 2 || dr.active || gz.active) return
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return
    const e = entryAt(ev.clientX, ev.clientY)
    if (!e) return
    if (!sel.includes(e.pid)) select([e.pid])
    emit('context', { ids: sel.slice(), clientX: ev.clientX, clientY: ev.clientY })
  }
  function onCanvasCancel() {
    if (tc && tc.dragging) {
      tc.pointerUp({ x: 0, y: 0, button: 0 })
      vp.canvas.removeEventListener('pointermove', tc._onPointerMove)
    }
  }
  function onWinUp() { if (tc && !tc.dragging) tc.enabled = !!gz.id && !posePreview && !dr.active }
  function onWinKey(ev) {
    if (ev.key === 'Escape' && ev.type === 'keydown' && gz.active) { ev.preventDefault(); ev.stopPropagation(); cancelGizmo(); return }
    if (ev.key !== 'Shift') return
    const d = ev.type === 'keydown'
    if (d === shiftDown) return
    shiftDown = d
    if (gz.active) { if (gz.mode === 'free') tc.rotationSnap = snap.on && !shiftDown ? snap.rotate * D2R : null; gz.dirty = true; vp.invalidate() }
  }
  function onWinBlur() { shiftDown = false }
  function doHover() {
    if (!lastPtr.in || dr.active || gz.active) return
    let id = null
    if (!(tc && tc.object && tc.axis !== null)) { const e = entryAt(lastPtr.x, lastPtr.y); id = e ? e.id : null }
    if (id === hoverId) return
    hoverId = id
    refreshFx()
    setMode(id ? 'hover' : 'idle')
  }

  /** 视口帧钩子：本帧积攒的指针 / gizmo 变化在渲染前换算上屏。 */
  function hook() {
    const t0 = performance.now()
    dbg.frames++
    if (vp.mode !== lightMode) refreshPalette()
    if (dr.active && dr.pending) solveDrag()
    if (gz.active && gz.dirty) applyGizmo()
    if (dr.active || gz.active) fx.follow()
    ov.tick(vp.camera, cssH())
    if (statsDirty) flushStats()
    if (dragEvDirty) { dragEvDirty = false; if (dr.active || gz.active) { dragEv.attach = dr.active ? dr.comp.attach : gz.comp ? gz.comp.attach : null; emit('drag', dragEv) } }
    const dt = performance.now() - t0
    dbg.hookMs = dt
    if (dt > dbg.hookMax) dbg.hookMax = dt
    if (dbg.hookLog && dbg.hookLog.n < dbg.hookLog.a.length) dbg.hookLog.a[dbg.hookLog.n++] = dt
  }

  // ═════════════════════════ 生命周期 ═════════════════════════
  function attach() {
    if (attached) return
    ensureTc()
    attached = true
    vp.setLiveRoot(asmRoot, LIVE_META, { keepView: true })   // 收网格表 + BVH + 取景 + 叠加：离开期间文档被 load / 改过也在这一步补上
    vp.setDisplayUp(doc.domain)
    vp.scene.add(fxRoot)
    fxRoot.add(ov.originScene)
    vp.overlay.add(ov.group)
    vp.controls.addEventListener('change', onCamChange)
    tc.connect(vp.canvas)
    vp.canvas.style.touchAction = 'none'
    ov.setDpr(vp.renderer.getPixelRatio())
    refreshPalette()
    warmFx()
    const cv = vp.canvas
    cv.addEventListener('pointerdown', onCanvasDownCap, true)
    cv.addEventListener('pointermove', onCanvasMove)
    cv.addEventListener('pointerleave', onCanvasLeave)
    cv.addEventListener('contextmenu', onCanvasCtx)
    cv.addEventListener('pointercancel', onCanvasCancel)
    cv.addEventListener('lostpointercapture', onCanvasCancel)
    window.addEventListener('pointerup', onWinUp)
    window.addEventListener('keydown', onWinKey, true)
    window.addEventListener('keyup', onWinKey, true)
    window.addEventListener('blur', onWinBlur)
    vp.setPointerOwner(ownerFn)
    vp.setFrameHook(hook)
    frameKey = frameSig()
    if (savedView) vp.setViewState(savedView)
    else if (!everAttached) fitView()
    everAttached = true
    if (list.length) { const b = vp.bounds.bboxBody; st.bbox[0] = b.min[0]; st.bbox[1] = b.min[1]; st.bbox[2] = b.min[2]; st.bbox[3] = b.max[0]; st.bbox[4] = b.max[1]; st.bbox[5] = b.max[2] }
    refreshSocketMarkers()
    refreshFx()
    updateMass(doc, massOut)
    configureGizmo()
    emitMode()
    statsDirty = true
    vp.invalidate()
  }
  function detach() {
    if (!attached) return
    clash.cancel()   // 途中的穿插切片：切走以后不再跑完、不再多画一帧
    if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0 }
    if (occlTimer) { clearTimeout(occlTimer); occlTimer = 0 }
    vp.controls.removeEventListener('change', onCamChange)
    finishDrag(false)
    if (tc && tc.dragging) onCanvasCancel()
    savedView = vp.viewState()
    vp.setPointerOwner(null)
    vp.setFrameHook(null)
    detachGizmo()
    if (tc) tc.disconnect()
    vp.canvas.style.touchAction = 'none'
    vp.overlay.remove(ov.group)
    vp.scene.remove(fxRoot)
    fxRoot.remove(ov.originScene)
    const cv = vp.canvas
    cv.removeEventListener('pointerdown', onCanvasDownCap, true)
    cv.removeEventListener('pointermove', onCanvasMove)
    cv.removeEventListener('pointerleave', onCanvasLeave)
    cv.removeEventListener('contextmenu', onCanvasCtx)
    cv.removeEventListener('pointercancel', onCanvasCancel)
    cv.removeEventListener('lostpointercapture', onCanvasCancel)
    window.removeEventListener('pointerup', onWinUp)
    window.removeEventListener('keydown', onWinKey, true)
    window.removeEventListener('keyup', onWinKey, true)
    window.removeEventListener('blur', onWinBlur)
    vp.controls.enabled = true
    vp.controls.enableZoom = true
    hoverId = null; lastPtr.in = false
    if (mode !== 'idle') setMode('idle')
    attached = false
  }
  let disposed = false
  function dispose() {
    if (disposed) return
    detach()
    disposed = true
    clash.cancel()
    // 视口还把 asmRoot 当 live 根挂着（detach 只撤钩子、不摘根）：摘掉，网格表 / 帧钩子一并清，不留着一堆已释放的网格
    if (vp.liveRoot === asmRoot) vp.setLiveRoot(null)
    if (asmRoot.parent) asmRoot.parent.remove(asmRoot)
    if (tc) { tc.dispose(); tc = null }
    for (const e of list) { if (e.poseMap) restoreFilePose(e.poseMap); asmRoot.remove(e.group) }
    frameHolder.remove(pivot); asmRoot.remove(frameHolder)
    entries = new Map(); list = []; pickList = []
    if (statusT) { clearTimeout(statusT); statusT = 0 }
    if (clashWaitT) { clearTimeout(clashWaitT); clashWaitT = 0 }
    fx.dispose(); ghost.dispose(); ov.dispose(); cache.dispose()
    clearBuildCache()   // 模块级生成缓存（网格数组在 JS 堆里）不在编辑器之后常驻
    subs.clear()
  }

  function load(d, o = {}) {
    if (dr.active) finishDrag(false)
    doc = normalizeAssembly(d)
    hist.length = 0; hptr = 0
    sel = []; hoverId = null; lastSelKey = ''
    clearStatus()   // 上一份文档的告警 / 吸附 / 穿插状态不挂到新文档上
    if (attached) vp.setDisplayUp(doc.domain)
    sync('load', [])
    emit('select', { ids: [], primary: null })
    emitMode()
    if (o.fit !== false && attached) fitView()
    // 换文档：模块级生成缓存的重层（网格 JS 数组）不再留上一份文档的——几何已在本编辑器的几何缓存里；轻层（质量合成用）照留
    clearBuildCache({ heavyOnly: true })
  }
  /** 取景：有件走视口「自动」视角；空文档看原点附近 ±3 m（地面网格与第一件的落点都在画面里）。 */
  function fitView() {
    if (list.length) vp.setView('auto')
    else vp.focusBody([0, 0, 0], 3, 'iso')
  }
  function getDoc() { return JSON.parse(JSON.stringify(doc)) }
  /** 某件的本体系位姿（编辑器解算表里拷 16 个数；没有 null）。属性面板的位置读数用它，不自己对冻结快照 solvePose。 */
  function poseOf(id) { const p = poses.get(id); return p ? Array.from(p.m) : null }
  /**
   * 拖动中被拖件的实时量（小对象，UI 15 Hz 取；不深拷整份文档）：{id, attach, t, q, m（本体系位姿）, pm（父件位姿）}。
   * 被拖的不是这一件 / 没在拖：null。
   */
  function liveOf(id) {
    if (!(dr.active || gz.active)) return null
    const c = S.compById(dr.active ? dr.doc : doc, id)
    if (!c) return null
    const pp = dr.active && dr.kind === 'ghost' ? dr.poses : poses
    const p = pp.get(id), q = c.parent != null ? pp.get(c.parent) : null
    const a = c.attach || {}
    return {
      id, parent: c.parent,
      attach: { mode: a.mode, socket: a.socket, face: a.face, uv: Array.isArray(a.uv) ? a.uv.slice() : null, roll: a.roll, mount: a.mount },
      t: Array.isArray(c.t) ? c.t.slice() : null, q: Array.isArray(c.q) ? c.q.slice() : null,
      m: p ? Array.from(p.m) : null, pm: q ? Array.from(q.m) : null
    }
  }

  // ═════════════════════════ 工具状态 ═════════════════════════
  function setTool(t) { if (!TOOLS.includes(t) || t === tool) return; tool = t; if (!gz.active) configureGizmo(); emitMode() }
  function setSpace(s) { if (!SPACES.includes(s) || s === space) return; space = s; if (!gz.active) configureGizmo(); emitMode() }
  function setSnap(o = {}) {
    if (typeof o.on === 'boolean') snap.on = o.on
    if (S.MOVE_STEPS.includes(Number(o.move))) snap.move = Number(o.move)
    if (S.ROT_STEPS.includes(Number(o.rotate))) snap.rotate = Number(o.rotate)
    if (tc && gz.id) tc.rotationSnap = gz.mode === 'free' && snap.on && !shiftDown ? snap.rotate * D2R : null
    if (gz.mode === 'socket' && gz.id) configureGizmo()
  }
  function setSym(o = {}) {
    if (['none', 'mirrorXZ', 'mirrorYZ', 'radial'].includes(o.op)) symUi.op = o.op
    const n = Math.round(Number(o.n))
    if (n >= 2 && n <= 8) symUi.n = n
    if (dr.active && dr.kind === 'ghost') { const pid = dr.comp.parent; dr.comp.parent = undefined; setDragParent(pid === undefined ? null : pid); dr.pending = true; vp.invalidate() }
  }
  /** 初值姿态摆上 / 撤掉；摆动过的条目刷新网格相对矩阵（描边 / 淡染与拾取包围球跟着真实几何走）。 */
  function applyPosePreview(onp) {
    for (const e of list) {
      if (!e.item) continue
      if (onp && e.item.arts.length) {
        e.poseMap = poseArticulations(e.group, prefixedArts(e.item.arts, e.prefix), null, { pose: e.poseMap || new Map() })
        e.group.matrixWorldNeedsUpdate = true
        refreshRels(e)
      } else if (!onp && e.poseMap) { restoreFilePose(e.poseMap); e.poseMap = null; e.group.matrixWorldNeedsUpdate = true; refreshRels(e) }
    }
  }
  function setPosePreview(onp) {
    onp = !!onp
    if (onp && !cache.hasArtsField) return
    if (onp === posePreview) return
    if (dr.active) finishDrag(false)
    if (gz.active && tc && tc.dragging) onCanvasCancel()
    posePreview = onp
    applyPosePreview(onp)
    buildPickSpheres()
    fx.clear(); refreshFx()   // 叠加组按新的网格相对矩阵重建
    configureGizmo()
    if (attached) vp.refreshLive({ frame: true })
    emitMode()
  }
  function setShowCom(onc) { showCom = !!onc; ov.com.visible = showCom && st.massKg > 0; vp.invalidate() }
  function setShowSockets(ons) { showSockets = !!ons; refreshSocketMarkers(); vp.invalidate() }
  function setShowAxes(ona) { ov.originAxes.visible = !!ona; vp.invalidate() }
  function setTheme(t) { theme = t === 'dark' ? 'dark' : 'light'; refreshPalette(); vp.invalidate() }

  // ═════════════════════════ 验证台钩子（常驻、零 UI）═════════════════════════
  const _cl = { x: 0, y: 0 }
  function client(bx, by, bz) {
    const r = vp.canvas.getBoundingClientRect()
    return bodyToClient(bx, by, bz, r, _cl) ? { x: _cl.x, y: _cl.y } : null
  }
  const _debug = {
    get frames() { return dbg.frames },
    /** 帧钩子耗时：最近一帧 / 最大（ms）；logHook(n) 开一段 n 帧的逐帧记录（Float64Array，预分配），hookLog() 取回。 */
    get hookMs() { return dbg.hookMs },
    get hookMax() { return dbg.hookMax },
    get syncMs() { return dbg.syncMs },
    logHook(nFrames) { dbg.hookMax = 0; dbg.hookLog = nFrames > 0 ? { a: new Float64Array(nFrames), n: 0 } : null },
    hookLog() { return dbg.hookLog ? Array.from(dbg.hookLog.a.subarray(0, dbg.hookLog.n)) : [] },
    get statsLog() { return dbg.statsLog },
    enableStatsLog(onl, o = {}) { dbg.logOn = !!onl; dbg.logDoc = !!(o && o.withDoc); if (onl) dbg.statsLog.length = 0 },
    socketClient(id, sockId) {
      const e = entries.get(id)
      const s = e && e.sockets.find((x) => x.id === sockId)
      if (!s) return null
      socketBody(e, s, T0, T1, 0)
      return client(T0[0], T0[1], T0[2])
    },
    faceClient(id, faceId, uv = [0, 0]) {
      const e = entries.get(id)
      const f = e && e.faces.find((x) => x.id === faceId)
      if (!f) return null
      S.faceFrame(T0, f, uv[0] || 0, uv[1] || 0)
      S.m4Mul(T1, e.m, T0)
      return client(T1[12], T1[13], T1[14])
    },
    entryClient(id) {
      const e = entries.get(id)
      if (!e) return null
      if (e.item) { S.boxXform(e.item.box6, 0, e.m, 0, T0, 0); return client((T0[0] + T0[3]) / 2, (T0[1] + T0[4]) / 2, (T0[2] + T0[5]) / 2) }
      return client(e.m[12], e.m[13], e.m[14])
    },
    gizmoHandleClient(axis) {
      if (!tc || !tc.object) return null
      const k = String(axis || '').toUpperCase()
      const idx = k === 'X' ? 0 : k === 'Y' ? 1 : k === 'Z' ? 2 : -1
      if (idx < 0) return null
      pivot.updateWorldMatrix(true, false)
      const wp = new THREE.Vector3(), wq = new THREE.Quaternion()
      pivot.matrixWorld.decompose(wp, wq, new THREE.Vector3())
      const cam = vp.camera
      const factor = wp.distanceTo(cam.position) * Math.min(1.9 * Math.tan(cam.fov * Math.PI / 360) / cam.zoom, 7)
      const scale = factor * tc.size / 4
      const dir = new THREE.Vector3(idx === 0 ? 1 : 0, idx === 1 ? 1 : 0, idx === 2 ? 1 : 0).applyQuaternion(wq)
      let p
      if (tc.mode === 'translate') p = wp.clone().addScaledVector(dir, 0.45 * scale)
      else {
        const eye = cam.position.clone().sub(wp).normalize()
        const side = new THREE.Vector3().crossVectors(dir, eye)
        if (side.lengthSq() < 1e-10) side.set(1, 0, 0).cross(dir)
        side.normalize()
        p = wp.clone().addScaledVector(side, 0.5 * scale)
      }
      const r = vp.canvas.getBoundingClientRect()
      const toC = (v) => { const q = v.clone().project(cam); return { x: (q.x * 0.5 + 0.5) * r.width + r.left, y: (0.5 - q.y * 0.5) * r.height + r.top } }
      const a = toC(p), c = toC(wp)
      return { x: a.x, y: a.y, cx: c.x, cy: c.y, r: Math.hypot(a.x - c.x, a.y - c.y) }
    },
    poses() { const o = {}; for (const [id, p] of poses) o[id] = Array.from(p.m); return o },
    /** 验证台：几何缓存的 LRU 收紧到 cap 条（量常驻用）。 */
    trimCache(cap = 0) { const active = new Set(); for (const e of list) if (e.item) active.add(e.item); cache.sweep(active, cap); return cache.stats() },
    /** 验证台：屏幕点拾取（与悬停 / 右键同一条 entryAt）。 */
    pickAt(x, y) {
      const e = entryAt(x, y)
      let bvh = 0
      for (const m of pickList) if (m.geometry.boundsTree) bvh++
      return { n: pickList.length, bvh, id: e ? e.id : null, mask: Array.from(pickMask.subarray(0, pickList.length)), skip: [pickSkipLo, pickSkipHi] }
    },
    /** 验证台：不经事件直接喂一次指针位置（拖动 / 悬停按下一帧处理）。 */
    pointer(x, y, shift = false) { lastPtr.x = x; lastPtr.y = y; lastPtr.in = true; shiftDown = !!shift; if (dr.active) { dr.pending = true; vp.invalidate() } else if (!hoverRaf) hoverRaf = requestAnimationFrame(hoverFrame) },
    state() {
      return {
        mode, tool, space: effSpace(), sel: sel.slice(), hover: hoverId, posePreview,
        ghost: dr.active ? { kind: dr.kind, type: dr.type, id: dr.id, parent: dr.comp.parent === undefined ? null : dr.comp.parent, attach: JSON.parse(JSON.stringify(dr.comp.attach)), valid: dr.valid, count: dr.count } : null,
        gizmo: gz.id ? { id: gz.id, mode: gz.mode, tcMode: tc ? tc.mode : null, dragging: !!(tc && tc.dragging) } : null,
        clashes: clashPairs.map((p) => p.slice()), invalid: JSON.parse(invalidKey), history: { size: hist.length, ptr: hptr, labels: hist.map((h) => h.label) },
        cache: cache.stats(), fx: fx.count, status: { ...curStatus }
      }
    },
    entries() { return list.map((e) => ({ id: e.id, pid: e.pid, k: e.k, prefix: e.prefix, parent: e.parentId, visible: e.visible, invalid: e.invalid, tris: e.item ? e.item.tris : 0, nodes: e.group.children.length })) }
  }

  rebuildEntries()   // 空文档也把读数用的打包数组备好

  return {
    attach, detach, dispose,
    load, getDoc, poseOf, liveOf, apply,
    select, frameSelection,
    setTool, setSpace, setSnap, setSym, setPosePreview, setShowCom, setShowSockets, setShowAxes, setTheme,
    canPosePreview: () => cache.hasArtsField,
    beginDragFromLib, prewarmGhost, quickAdd, duplicate, remove, pickup, mirror, clearStatus,
    undo, redo, canUndo: () => hptr > 0, canRedo: () => hptr < hist.length,
    stats: () => st,
    on,
    get selection() { return sel.slice() },
    get mode() { return mode },
    get attached() { return attached },
    _debug
  }
}
