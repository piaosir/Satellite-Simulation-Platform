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
//   idle ─(库卡片越过 4 px：beginDragFromLib)→ ghost ─(松手在有效位 → 加件；无效位 / Esc / 右键 → 取消，状态「未安装。」)→ idle
//   选中 ─(按住选中件本体拖过 4 px)→ pickup（按下拖动式：松手落位；无效位松手复原，状态「未移动。」）→ idle
//   选中 ─(G / Ctrl+D)→ pickup ─(左键 → 重新安装 / 复制；Esc / 右键 → 复原)→ idle
//   落点判定（2026-10-06 设计页交互重构 §3.3.2；判据点 = 指针，按住拖时件按抓取偏移跟手、目标与面 / 接口仍按指针选）：
//   ① 指针压在看得见的接口标记上（半径 min(22 px, 该件屏上尺寸 × 0.25)）→ 接口；
//   ② 指针下那一件 E（派生件映回主件）：朝向相机、屏距 ≤ R_ded = clamp(E 屏上尺寸 × 0.3, 24, 72) px 的专用空闲接口优先（E 没有可安装面时
//      放宽到 clamp(× 0.35, 48, 160) px；又只有一个兼容专用接口时不限距离，拾起件本来就装在它上面除外）> 命中处的可安装面（推断 + 网格）
//      > E 的兼容空闲接口 ≤ 56 px > 命中点投影到 E 最近的可安装面
//      （近失，投影点离指针 ≤ 48 px）> 薄件穿透（passThroughOf）> 表面安装（贴在指针处的表面，松手就近带锚；2026-10-07 v3 起不再报
//      「X 无可用安装位」，吊挂件指着无安装面的件的上表面时挂到下表面）。背向相机的接口不自动选（只进 Tab 列表）——没有背面的接口除外
//      （asmSnap.socketTwoSided：无安装面的件上的接口、机身中线上的翼根 / 平尾根这类横向对齐接口，两面都算正面）；
//   ③ 空白处：净化后的看得见的接口 56 px / 平面面近失 36 px 磁吸；④ 空文档 = 原点；都没有 = 未吸附（松手取消）。
//   候选净化：各件自己的安装接口（ownMountKeys）不作落点；与面心重合的通用接口（折叠接口）不单列、不画，由面心推断代替（面心已占不推断，
//   滚转步长沿用该接口的档）；不可安装面（faceMountable）不收件。
//   Shift = 原样贴（命中面 → 面安装无推断无网格；命中非面 → 贴命中点，松手时按 pickAnchor 带锚）。Tab = 在候选间循环（按下时快照、按身份键锁定；
//   表面安装恒在表里）；
//   B = 本件安装端循环（asmSnap.mountChoices）。候选按档记代价、切换带 4 px 滞回；命中派生件时把命中点 / 法向映回主件求安装语义。
//   拖动中：滚轮缩放（朝指针缩放）、按住 Alt 移动指针转视角、Q / E 按当前落点的滚转档转向；右键不移动松开 / Esc / 窗口失焦 = 取消；
//   落点所在件描边、结构树对应行高亮，落点不在跟手点下时画牵引线，指针右下出光标读数（cursor 事件）；
//   指针移到结构树某一行上 = 装到那一件（专用插座 > 兼容空闲接口 > 最朝向相机的可安装面面心）。
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
import { getComponent, fillParams, checkParams, socketAccepts, frameConvention } from '@core/models/components/index.mjs'
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
// 面内推断的读数名（INFER 下标；网格 / 自由不另写）
const INFER_NAME = ['', '', '面心', '边中点', '角点', '', '中线', '边线']
const BAND = S.BAND
const LIST_MAX = 64                 // Tab 候选表上限（预分配）
const DED_R_REL = 0.3, DED_R_MIN = 24, DED_R_MAX = 72   // 专用接口优先半径 R_ded = clamp(E 屏上尺寸 × 0.3, 24, 72) px
const DED2_R_REL = 0.35, DED2_R_MIN = 48, DED2_R_MAX = 160   // 没有安装面的件（机翼、反射面…）放宽：clamp(E 屏上尺寸 × 0.35, 48, 160) px
const MARK_REL = 0.25               // 接口标记命中半径 = min(SOCKET_PX, 该件屏上尺寸 × 0.25)
const NEAR_COST = 3500              // 近失（命中点投影到 E 最近的可安装面）的代价基数：排在「E 的兼容接口」（档 3）之后、空白磁吸（档 4）之前
const NEAR_PX = 48                  // 近失只收投影点离指针这么多像素以内的（再远就贴在指针处的表面：机头锥 / 尾锥上装天线不被拉到等直段端头）
const RAW_COST = 3600               // 表面安装（贴在指针处的表面）的代价：E 上什么接口 / 面都接不了时的兜底，Tab 也能换到它
const HANG_UP = 0.25                // 吊挂件：命中法向朝上分量超过它（非卫星领域 +Z 向下）才算指着上表面、挂到下表面去
const LIST_BACK = 900, LIST_OTHER = 700   // Tab 列表：背向相机的接口 / 指针没压着的面排在后面（只影响列表顺序）
const LOCK_MOVE_PX = 24             // Tab 在空白处锁定后，指针移出这么多像素复位
const RB_MOVE_PX = 5                // 放置中按下右键后移动这么多像素就不算「单击取消」
const STILL_PX = 8, STILL_MS = 150  // 按住拖重新放置：松手点离按下点 < 8 px 或按住 < 150 ms → 原样复位（不记撤销、不提交）
const LEAD_MIN_PX = 8   // 落点离指针超过这么多像素才画牵引线
const DASH_PX = 6       // 牵引线一节虚线的屏幕长度
const MOVED = Object.freeze({ moved: true })   // refreshLive 的拖动参数（每帧传同一个对象，不分配）
const TOOLS = ['move', 'rotate'], SPACES = ['body', 'local', 'mount']

const onSymLocus = S.onSymLocus   // 件原点落在对称面 / 轴上（asmSnap：拖入、快速添加、镜像、属性面板共用一个判据）

// 发给 UI 的文档快照：冻结对象、纯数字数组不冻结（asmSnap.freezeDoc 注释）。
// ★ 不变式：冻结快照绝不进 assembly.mjs 的热函数（属性面板的位姿读数走 poseOf，不自己 solvePose）。
const freezeDoc = S.freezeDoc

/**
 * @param {object} vp viewport.js 的句柄（用 CONTRACT §4 的 live 根 API）
 * @param {{theme?:'light'|'dark', lang?:()=>'zh'|'en', targetAt?:(clientX:number, clientY:number)=>string|null}} [opts]
 *   targetAt：视口外的屏幕点落在哪个组件上（结构树的行；没有 null）——拖入 / 拾起时指针移到那里 = 装到那一件
 */
export function createAssemblyEditor(vp, opts = {}) {
  let theme = opts.theme === 'dark' ? 'dark' : 'light'
  const targetAt = typeof opts.targetAt === 'function' ? opts.targetAt : null

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
  const HP = new Float64Array(3), HN = new Float64Array(3), HW = new Float64Array(3), CB = new Float64Array(3), AX3 = new Float64Array(3)
  const T0 = new Float64Array(16), T1 = new Float64Array(16), T2 = new Float64Array(16), T3 = new Float64Array(16)
  // io 对象的数值字段一开始就给双精度（字段表示从一开始就是 Double，之后原地写、不装箱）
  const faceOut = { u: 0.5, v: 0.5, d: 0.5, tol: 0.002, skin: 0.05 }, inf = { u: 0.5, v: 0.5, kind: 0, ppm: 1.5, gu: 0, gv: 0 }
  const mag = { u: 0.5, v: 0.5, x: 0.5, y: 0.5, z: 0.5, c: 0 }   // 面磁吸（asmSnap.faceMagnetIO）的结果
  const RAY = new Float64Array(6)                          // 本帧指针射线（本体系 [ox,oy,oz,dx,dy,dz]）
  const PP = new Float64Array(3)                           // 牵引线的指针端（本体系，取在落点那一层深度上）
  const Z3 = new Float64Array(3)
  const lastPtr = { x: 0, y: 0, in: false }
  const dragEv = { phase: 'start', kind: 'ghost', id: '', attach: null, target: '' }
  // 本帧的落点候选：best = 本帧最优（只收严格判据内的）；cur = 当前候选（滞回）这一帧的代价（放宽一个滞回量也算还在）
  const cand = { key: -1, cost: Infinity, curCost: Infinity }
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
      // 薄件穿透按「补过缺省的参数」判（passThroughWhen：零质量的极薄基本体也算），按件缓存，热路径只读布尔
      prim.set(c.id, { comp: c, item, invalid: !!inv[c.id], sockets: g.sockets, faces: g.faces, geo: g, pass: S.passThroughOf(g.def, g.params), symTaint: S.inSymSubtree(doc, c.id) })
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
        e = { id: x.id, pid: x.src, k: x.k, prefix: x.prefix, parentId: x.parent, index: 0, group, item: undefined, meshes: [], rels: [], comp: null, sockets: [], faces: [], geo: null, pass: false, size: 0.3, rod: 0, invalid: false, visible: true, symTaint: false, poseM: null, plane: null, ax: -1, m: new Float64Array(16), fx: 0, poseMap: null, pick0: -1, pickN: 0,
          // 拖动开始时按拖动件类型建（buildCandidates）：可安装面（faceAtHit 用的子表 + 回原面下标）、各面的折叠接口（e.sockets 下标）/ 已占 / 滚转档
          dFaces: [], dFi: new Int32Array(0), dFn: 0, fold: new Int32Array(0), foldBusy: new Uint8Array(0), foldRoll: new Float64Array(0) }
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
      e.comp = P.comp; e.sockets = P.sockets; e.faces = P.faces; e.geo = P.geo; e.pass = P.pass; e.invalid = P.invalid; e.symTaint = P.symTaint
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
    if (bad === 'socket') return `attach.socket：父件 ${c.parent} 无接口 "${a.socket}"`
    if (bad === 'face') return `attach.face：父件 ${c.parent} 无安装面 "${a.face}"`
    if (bad === 'mount') return `attach.mount：本件无接口 "${a.mount || (getComponent(c.type) || {}).mountSocket}"`
    return 't / q：位姿无效'
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
        if (fa && !fb) { text = `与 ${nameOf(b)} 干涉。`; break }
        if (fb && !fa) { text = `与 ${nameOf(a)} 干涉。`; break }
      }
      if (!text) text = `${nameOf(pairs[0][0])} 与 ${nameOf(pairs[0][1])} 干涉。`
      setStatus('clash', text)
    } else if (curStatus.kind === 'clash') setStatus('', '')
    if (!attached) flushStats()
    vp.invalidate()
  }

  // ═════════════════════════ 叠加（淡染 / 描边 / 插座标记）═════════════════════════
  function refreshFx() {
    const selSet = new Set(sel)
    const moving = dr.active && dr.kind === 'pickup' ? dr.moving : null
    const tgt = dr.active ? dr.tgtEntry : null
    for (const e of list) {
      let m = 0
      if (selSet.has(e.pid)) m |= e.k === 0 ? FX.SEL : FX.SEL_WEAK
      else if (e.id === hoverId) m |= FX.HOVER
      if (e === tgt) m |= FX.TARGET
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
    if (!def) return false
    const params = o && o.params && typeof o.params === 'object' ? JSON.parse(JSON.stringify(o.params)) : {}
    let item
    try { item = cache.get({ type, params, material: null }) } catch { return false }
    cache.prep(item, true)
    ghost.warm(item)
    return true
  }

  const sk = { pos: new Float64Array(0), nrm: new Float64Array(0), ded: new Uint8Array(0), n: 0, ent: [] }
  function ensureSk(n) { if (sk.pos.length < 3 * n) { sk.pos = new Float64Array(3 * Math.max(64, 2 * n)); sk.nrm = new Float64Array(3 * Math.max(64, 2 * n)); sk.ded = new Uint8Array(Math.max(64, 2 * n)) } }
  /**
   * 没有背面的接口（asmSnap.socketTwoSided：无安装面的件上的接口、中面里的横向对齐接口）：第 i 格法向记 0——朝向判据（frontSock、
   * 标记着色器的 dot(n, 相机 − 点) ≥ 0）两面都算正面：从上方看机翼也能选中、看见翼下的发动机挂点。
   */
  function twoSide(nrm, i) { const o = 3 * i; nrm[o] = 0; nrm[o + 1] = 0; nrm[o + 2] = 0 }
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
  /**
   * 各件自己的安装接口键（asmSnap.ownMountKeys：安装端插座，'@' 安装端连同与它同位同向的本件插座；自由件按 def.mountSocket；根件无）：
   * 不作落点、不标（2026-10 诊断 S2：模板里带锚自由件的 root / back 曾混进候选）。允许分配（同步 / 拖动开始时调）。
   */
  function ownKeySet() {
    const out = new Set()
    for (const c of doc.comps) for (const k of S.ownMountKeys(doc, c)) out.add(k)
    return out
  }
  /**
   * 空闲插座标记（idle，开关 showSockets）：只标选中件（含其派生件）的空闲插座；没有选中件时不标（载入 / 转换后整星三十来个
   * 橙圈会盖住星体）。拖入 / 拾起时由候选表接管（候选色，不走这里）。被别的件挡住的插座在同步 / 相机停下后按件 BVH 判一次视线，
   * 降到 0.25 透明（插座标记本身不做深度测试：否则贴在面上的那半个圈会被自己的面吃掉）。
   * 折叠接口（与面心重合的通用接口）不标：落点由面心推断代替。限定收件类型的接口画实心、通用接口画空心。
   */
  function refreshSocketMarkers() {
    if (dr.active) return
    if (!showSockets || !sel.length) { ov.sockets.visible = false; vp.invalidate(); return }
    const used = S.occupiedSocketKeys(doc, poses)
    const own = ownKeySet()
    const scope = new Set(sel)
    let n = 0
    for (const e of list) if (e.visible && scope.has(e.pid)) n += e.sockets.length
    ensureSk(n)
    n = 0
    sk.ent.length = 0
    for (const e of list) {
      if (!e.visible || !scope.has(e.pid)) continue
      for (const s of e.sockets) {
        const key = `${e.pid}|${s.id}`
        if (own.has(key) || used.has(key) || S.isFoldedSocket(e.geo, s.id)) continue
        sk.ent.push(e)
        sk.ded[n] = s.accepts != null ? 1 : 0
        socketBody(e, s, sk.pos, sk.nrm, n)
        if (S.socketTwoSided(e.geo, s)) twoSide(sk.nrm, n)
        n++
      }
    }
    sk.n = n
    ov.sockets.set(sk.pos, sk.nrm, n, 0, sk.ded)
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
    // 拖动中滚轮缩放：落点跟着新视角重判（插座投屏、射线都变了）
    if (dr.active) dr.pending = true
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
   * 射线（rc.ray，显示系）打可拾取网格：包围球粗筛 → 逐个 BVH（firstHitOnly）→ 取最近的可见命中。lo / hi = 只打拾取表这一段
   * （缺省全表；吊挂件找出射点时只打那一件自己的网格）。
   * 结果写 pickHit.hit / pickHit.e；没有命中 hit = null。零分配（BVH 内部为命中结果分配的小对象除外）。
   */
  const pickHit = { hit: null, e: null }
  function castPick(lo = 0, hi = pickList.length) {
    pickHit.hit = null; pickHit.e = null
    const o = rc.ray.origin, d = rc.ray.direction
    const ox = D[0] * o.x + D[1] * o.y + D[2] * o.z, oy = D[4] * o.x + D[5] * o.y + D[6] * o.z, oz = D[8] * o.x + D[9] * o.y + D[10] * o.z
    const dx = D[0] * d.x + D[1] * d.y + D[2] * d.z, dy = D[4] * d.x + D[5] * d.y + D[6] * d.z, dz = D[8] * d.x + D[9] * d.y + D[10] * d.z
    let best = Infinity
    for (let i = lo; i < hi; i++) {
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
    updateCursor()
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
    else if (r.symDropped && r.symDropped.length) setStatus('warn', `${r.symDropped.map(nameOf).join('、')} 已取消对称。`)
    else if (r.split && r.split.length) setStatus('warn', `${r.split.map(nameOf).join('、')} 的对称已拆分。`)
    return { ok: true }
  }
  /**
   * 整文档替换（可撤销）：快速设置改驱动参数 / 删件 / 恢复驱动值这类「按整份文档改」的操作走这里。
   * next 先归一（顶层别的字段如 drive 由 normalizeAssembly 原样保留），再走 commitDoc：入撤销栈、发 change；同 mergeKey 500 ms 内合并
   * （数字框连续输入）。新文档里没有的件从选择里剔除（同撤销那条路：sync 收 gizmo / 悬停，emitSelIfPruned 发 select）。拖动中拒收。
   * @param {object} next 装配文档
   * @param {{label?:string, mergeKey?:string}} [o]
   * @returns {{ok:boolean, changed?:boolean, error?:string}}
   */
  function replaceDoc(next, o = {}) {
    if (busy()) return { ok: false, error: '正在拖动。' }
    let d
    try { d = normalizeAssembly(next) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
    const label = o && typeof o.label === 'string' && o.label ? o.label : 'replace'
    const key = o && typeof o.mergeKey === 'string' && o.mergeKey ? o.mergeKey : undefined
    const changed = commitDoc(label, d, [], key)
    if (changed) emitSelIfPruned()
    return { ok: true, changed }
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
  // face / sock：安装系的锚（面 / 接口）；pm：父件渲染矩阵（推断记号用）；ref：网格「自动」档的基准尺度（米，0 = 按 face）；
  // step：按下时定下的平移网格步长（米）；busy：面心已被别的件占着（面心推断不往那儿吸）
  const gz = { id: null, comp: null, mode: '', active: false, dirty: false, before: '', face: null, sock: null, pm: null, ref: 0, step: 0, busy: false, v0: 0, rollStep: 0, frame: new Float64Array(16), anchor: new Float64Array(16) }
  const GZR = new Float64Array(2)   // gizmo 面内推断前的原始 uv（面心已占时退回）
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
  /** 包围盒最短边（米；没有几何 0）。 */
  function boxShort(e) {
    const b = e && e.item ? e.item.box6 : null
    if (!b) return 0
    const x = b[3] - b[0], y = b[4] - b[1], z = b[5] - b[2]
    return x < y ? (x < z ? x : z) : (y < z ? y : z)
  }
  /** 接口 s 所在的父件平面面（接口原点落在面内、法向同向）；没有 null。网格「自动」档以它为基准。 */
  function faceOfSocket(pe, s) {
    for (const f of pe.faces) {
      if (f.kind === 'cyl') continue
      const dx = s.pos[0] - f.origin[0], dy = s.pos[1] - f.origin[1], dz = s.pos[2] - f.origin[2]
      const d = dx * f.n[0] + dy * f.n[1] + dz * f.n[2], u = dx * f.u[0] + dy * f.u[1] + dz * f.u[2], v = dx * f.v[0] + dy * f.v[1] + dz * f.v[2]
      const tol = 1e-6 * Math.max(1e-3, f.halfU, f.halfV)
      if (Math.abs(d) <= tol && Math.abs(u) <= f.halfU + tol && Math.abs(v) <= f.halfV + tol && s.n[0] * f.n[0] + s.n[1] * f.n[1] + s.n[2] * f.n[2] > 1 - 1e-9) return f
    }
    return null
  }
  /**
   * 件 c（条目 e、父件条目 pe）当前生效的平移网格步长（米；吸附关、步长无效 0）：'auto' 档的基准 = 面安装件 → 安装面；
   * 接口件 → 接口所在的面（没有取父件包围盒短边）；自由件 → 本件包围盒短边（§3.3.2 网格步长）。允许分配（选择 / 按下时调）。
   */
  function stepOf(c, e, pe) {
    if (!snap.on) return 0
    if (snap.move !== 'auto') return S.resolveMoveStep(snap.move, 0)
    const a = c && c.attach
    if (!a || !pe) return S.resolveMoveStep('auto', boxShort(e))
    if (a.mode === 'surface') { const f = pe.faces.find((x) => x.id === a.face); return S.resolveMoveStep('auto', f || boxShort(pe)) }
    if (a.mode === 'socket') { const s = pe.sockets.find((x) => x.id === a.socket); const f = s ? faceOfSocket(pe, s) : null; return S.resolveMoveStep('auto', f || boxShort(pe)) }
    return S.resolveMoveStep('auto', boxShort(e))
  }
  /** 网格步长读数（运行时）：变了才发 'step' 事件 {move: 设置值（'auto' | 米）, m: 当前生效步长（米）}。 */
  let stepNow = -1, stepSet = null
  function emitStep(m) {
    if (m === stepNow && stepSet === snap.move) return
    stepNow = m; stepSet = snap.move
    emit('step', { move: snap.move, m })
  }
  /** 当前选中件的生效步长（单选非根件按它的锚；否则按设置值 / 自动档取根件包围盒短边）。 */
  function selStep() {
    const c = sel.length === 1 ? S.compById(doc, sel[0]) : null
    if (c && c.parent != null) return stepOf(c, entries.get(c.id), entries.get(c.parent))
    if (!snap.on) return 0
    if (snap.move !== 'auto') return S.resolveMoveStep(snap.move, 0)
    const r = list.length ? list[0] : null
    return S.resolveMoveStep('auto', boxShort(r))
  }
  /** 面在屏上的短边（整数像素；faceInferIO 的 shortPx：推断半径随屏上尺寸收小）。 */
  function shortPxOf(f, ppm) {
    const s = f.kind === 'cyl' ? Math.min(2 * f.halfU, 2 * f.halfV) : 2 * Math.min(f.halfU, f.halfV)
    return Math.round(s * ppm) | 0
  }
  /**
   * 按选中件的安装方式定 gizmo 取向与手柄（§3.3.3：恒在安装系）：接口件 / 面安装件的移动手柄 X / Y 写接口系偏移 off.xy（接口）或 uv（面），
   * Z 写法向偏移 off[2]；旋转工具只给绕法向的滚转环（倾角走数值）。自由件照旧 6 自由度（本体 / 局部 / 安装面三种坐标系）。
   */
  function configureGizmo() {
    if (!tc) return
    const id = sel.length === 1 ? sel[0] : null
    const c = id ? S.compById(doc, id) : null
    const e = id ? entries.get(id) : null
    const pe = c && c.parent != null ? entries.get(c.parent) : null
    if (!dr.active) emitStep(selStep())
    if (!c || !e || !pe || !e.poseM || !pe.poseM || c.locked || c.hidden || posePreview || dr.active || !attached) { detachGizmo(); vp.invalidate(); return }
    const a = c.attach, Mp = pe.poseM, roll = Number(a.roll) || 0, off = Array.isArray(a.off) ? a.off : Z3
    tc.minX = tc.minY = tc.minZ = -Infinity; tc.maxX = tc.maxY = tc.maxZ = Infinity
    tc.showX = tc.showY = tc.showZ = true
    pivot.scale.set(1, 1, 1)
    gizmoLook(a.mode !== 'free' && tool !== 'move')
    gz.face = null; gz.sock = null; gz.v0 = 0; gz.pm = pe.m
    if (a.mode === 'socket') {
      const s = pe.sockets.find((x) => x.id === a.socket)
      if (!s) { detachGizmo(); return }
      gz.sock = s
      S.m4Mul(gz.frame, Mp, S.socketFrame(T0, s))
      // 原点 = 本件安装点（接口系 · T(off)）：先偏移后滚转，滚转环绕件自己转
      pivot.position.set(off[0], off[1], off[2])
      gz.rollStep = s.roll > 0 ? s.roll : snap.rotate
    } else if (a.mode === 'surface') {
      const f = pe.faces.find((x) => x.id === a.face)
      if (!f) { detachGizmo(); return }
      gz.face = f
      const uv = Array.isArray(a.uv) ? a.uv : Z3
      gz.v0 = f.kind === 'cyl' ? uv[1] : 0
      S.m4Mul(gz.frame, Mp, S.faceFrame(T0, f, 0, gz.v0))
      pivot.position.set(uv[0], uv[1] - gz.v0, off[2])
      gz.rollStep = snap.rotate
      if (tool === 'move') {
        // 手柄限位：u 夹在面内；平面 v 同样夹；柱面局部弧夹在弧内（不回绕：越过弧端会瞬移到对侧），整圆不限
        tc.minX = -f.halfU; tc.maxX = f.halfU
        if (f.kind !== 'cyl') { tc.minY = -f.halfV; tc.maxY = f.halfV } else if (!S.isFullCyl(f)) { tc.minY = -f.halfV - gz.v0; tc.maxY = f.halfV - gz.v0 }
      }
    } else {
      S.m4Mul(gz.anchor, Mp, S.anchorFrame(T0, c, pe))
      const W = e.poseM
      if (space === 'local') { S.m4Copy(gz.frame, W); pivot.position.set(0, 0, 0); pivot.quaternion.identity() } else if (space === 'mount') { S.m4Copy(gz.frame, gz.anchor); S.m4Mul(T1, S.m4InvRigid(T2, gz.anchor), W); setPivotFrom(T1) } else { S.m4Ident(gz.frame); setPivotFrom(W) }
      tc.setMode(tool === 'move' ? 'translate' : 'rotate')
    }
    if (a.mode !== 'free') {
      if (tool === 'move') { tc.setMode('translate'); pivot.quaternion.identity() } else {
        tc.setMode('rotate')
        tc.showX = false; tc.showY = false
        pivot.quaternion.setFromAxisAngle(_Z, roll * D2R)
      }
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
    // 平移网格步长按下时定（'auto' 按锚面 / 父件 / 本件包围盒）；面安装件的面心已被别的件占着时，面心推断不往那儿吸
    const c = gz.comp, pe = c && c.parent != null ? entries.get(c.parent) : null
    gz.step = stepOf(c, entries.get(gz.id), pe)
    gz.busy = false
    if (gz.face && pe) {
      const fs = S.foldedSocketOf(pe.geo, gz.face.id)
      if (fs) gz.busy = S.occupiedSocketKeys(doc, poses, new Set(S.subtreeOf(doc, gz.id))).has(`${pe.pid}|${fs.id}`)
    }
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
    const a = c.attach
    if (gz.mode !== 'free' && tc.mode === 'rotate') {
      // 接口件 / 面安装件的旋转工具只有绕法向的滚转环（倾角走属性面板数值）
      let r = S.twistDeg(P)
      const step = gz.rollStep
      if (snapOn && step > 0) {
        const rs = S.snapAngle(r, step)
        if (rs !== r) { r = rs; pivot.quaternion.setFromAxisAngle(_Z, r * D2R); pivot.updateMatrix() }
      }
      a.roll = r
    } else if (gz.mode === 'surface') {
      // X / Y → uv（面内推断 + 网格，面心已占不吸面心），Z → 法向偏移 off[2]（按同一网格）
      const f = gz.face
      inf.u = P[12]; inf.v = P[13] + gz.v0; inf.kind = 0; inf.gu = 0; inf.gv = 0
      if (snapOn) {
        GZR[0] = inf.u; GZR[1] = inf.v
        pivot.getWorldPosition(_v)
        inf.ppm = cssH() / (2 * Math.max(1e-6, _v.distanceTo(vp.camera.position)) * Math.tan(vp.camera.fov * Math.PI / 360))
        S.faceInferIO(f, inf, S.INFER_PX, gz.step, S.INFER_LINE_PX, shortPxOf(f, inf.ppm))
        if (gz.busy && inf.u === 0 && inf.v === 0) { inf.u = GZR[0]; inf.v = GZR[1]; inf.kind = 0; inf.gu = 0; inf.gv = 0 }
      }
      S.clampIO(f, inf)
      let z = P[14]
      if (snapOn && gz.step > 0) z = S.snapTo(z, gz.step)
      if (pivot.position.x !== inf.u || pivot.position.y !== inf.v - gz.v0 || pivot.position.z !== z) { pivot.position.set(inf.u, inf.v - gz.v0, z); pivot.updateMatrix() }
      a.uv[0] = inf.u; a.uv[1] = inf.v; a.off[2] = z
      gizmoMarks(f)
    } else if (gz.mode === 'socket') {
      // X / Y / Z → 接口系偏移 off（Z = 法向偏移）
      let x = P[12], y = P[13], z = P[14]
      if (snapOn && gz.step > 0) { x = S.snapTo(x, gz.step); y = S.snapTo(y, gz.step); z = S.snapTo(z, gz.step) }
      if (pivot.position.x !== x || pivot.position.y !== y || pivot.position.z !== z) { pivot.position.set(x, y, z); pivot.updateMatrix() }
      a.off[0] = x; a.off[1] = y; a.off[2] = z
    } else {
      if (tc.mode === 'translate' && snapOn && gz.step > 0) {
        const x = S.snapTo(pivot.position.x, gz.step), y = S.snapTo(pivot.position.y, gz.step), z = S.snapTo(pivot.position.z, gz.step)
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
  /** gizmo 面内推断的记号（锚点 + 中线 / 边线引导线；网格 / 自由不画）。零分配。 */
  function gizmoMarks(f) {
    const k = inf.kind
    if (k === S.INFER.CENTER || k === S.INFER.EDGE || k === S.INFER.CORNER || k === S.INFER.CLINE || k === S.INFER.ELINE) {
      S.faceFrameUV(T0, f, gz.comp.attach.uv)
      S.m4Mul(T1, gz.pm, T0)
      ov.marker.showAt(T1, 12, k === S.INFER.CLINE || k === S.INFER.ELINE ? 1 : k)
      ov.guide.show(gz.pm, f, S.faceFrame, inf.gu, inf.gv, gz.comp.attach.uv)
    } else { ov.marker.hide(); ov.guide.hide() }
  }
  /** Esc：放弃这次 gizmo 拖动（文档回到按下时）。 */
  function cancelGizmo() {
    if (!gz.active) return
    gz.active = false; gz.dirty = false
    if (tc && tc.dragging) { tc.pointerUp({ x: 0, y: 0, button: 0 }); vp.canvas.removeEventListener('pointermove', tc._onPointerMove) }
    vp.controls.enabled = true
    ov.hideDrag()
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
    ov.hideDrag()
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
    // 候选插座：所属条目 / 插座 / 安装插座（ghost 按 mountFor 规则）/ 本体系位置与法向 / 屏幕坐标（cX·cY 只留看得见的，aX·aY 全投）/ 遮挡 / 是否专用给本件
    cN: 0, cE: [], cS: [], cMount: [], cPos: new Float64Array(0), cNrm: new Float64Array(0), cX: new Float64Array(0), cY: new Float64Array(0),
    aX: new Float64Array(0), aY: new Float64Array(0), cOcc: new Uint8Array(0), cDed: new Uint8Array(0),
    // 候选平面面（空白处磁吸用）：所属条目 / 面下标（e.faces）
    fN: 0, fE: [], fI: [],
    moving: new Set(), symBlock: false, symWanted: null, wasInvalid: false, massMode: 0, rootEntries: [], rect: null, faceKey: -1, faceEntry: null, statusKey: -2, statusRoll: 0, activeSock: -1, center: new THREE.Vector3(),
    boxBase: 0,
    tgtEntry: null,    // 落点所在的条目（描边）
    blockE: null,      // 本帧指针下却什么都接不了的件（未吸附时的状态短语用）
    press: false, offX: 0, offY: 0, pointerId: -1,   // 按下拖动式拾起：松手落位；跟手点 = 指针 − 抓取偏移（安装点按它定位，目标按指针选）
    pressX: 0, pressY: 0, pressT: 0,                 // 按下拖动式拾起的按下点 / 时刻（松手离它 < 8 px 或按住 < 150 ms → 原样复位）
    via: 0,            // 本帧落点从哪来：0 视口、1 结构树的行
    tanH: 0.5,         // 本帧 tan(fov / 2)
    // 2026-10-06：Q / E 按过没有（没按过时落回原锚保持原滚转、面上不按档取整）；B 的安装端候选 / 对应的安装端对象 / 当前选的下标（−1 = 按规则）
    rollTouched: false, mounts: [], mountSock: [], mountIdx: -1,
    // 拾起件原来的安装语义（orig：落回原锚只改真正变了的量）与换锚时带过去的量（keep：滚转 / 倾角 / 偏移 / 安装端）；ghost 全缺省
    orig: null, keep: { roll: 0.5, t0: 0.5, t1: 0.5, ox: 0.5, oy: 0.5, oz: 0.5, sockOff: false, mount: null },
    uvA: [0, 0],       // 带面锚自由件落回原面柱面时的锚 uv
    step: 0.5, stepFace: null,   // 当前落点面的平移网格步长（米；换面才重算）
    lastInfer: 0, foldRoll: 0.5, // 本帧面内推断类型 / 该面折叠接口的滚转档（面心推断时 Q / E 用它）
    rawFree: false,    // 本帧落点是「原样贴到非面处」（松手时就近带锚）
    rawUnder: false,   // 本帧的表面安装点是吊挂件穿过薄件取的下表面（光标读数「下表面」）
    px0: NaN, py0: NaN,          // 上一次指针位置（Alt 转视角的增量）
    gate: 0, gateRow: null       // G / Ctrl+D 的结构树门：0 开、1 关（起始行未离开）、−1 还不知道（第一次移动时定）
  }

  /**
   * 件 e 对拖动件类型 type 的可安装面（faceMountable：dFaces 子表 + dFi 回 e.faces 下标）与各面的折叠接口（与面心重合的通用接口：
   * e.sockets 下标 / 已被别的件占着 / 滚转档）。拖动开始时调（允许分配）。
   */
  function prepFaces(e, type, used) {
    const nf = e.faces.length
    if (e.dFi.length < nf) { e.dFi = new Int32Array(nf); e.fold = new Int32Array(nf); e.foldBusy = new Uint8Array(nf); e.foldRoll = new Float64Array(nf) }
    e.dFaces.length = 0
    let k = 0
    for (let i = 0; i < nf; i++) {
      const f = e.faces[i]
      e.fold[i] = -1; e.foldBusy[i] = 0; e.foldRoll[i] = 0
      const fs = f.kind === 'cyl' ? null : S.foldedSocketOf(e.geo, f.id)
      if (fs) { e.fold[i] = e.sockets.indexOf(fs); e.foldBusy[i] = used.has(`${e.pid}|${fs.id}`) ? 1 : 0; e.foldRoll[i] = fs.roll > 0 ? fs.roll : 0 }
      if (!S.faceMountable(e.comp, f.id, type, e.geo)) continue
      e.dFaces.push(f); e.dFi[k++] = i
    }
    e.dFn = k
  }
  /**
   * 候选插座 / 平面面（拖动开始时建一次，2026-10-06 候选净化）：可见、非移动、socketUsable、空闲（按几何认占用，含对称派生件）、
   * 不是任一件自己的安装接口（ownMountKeys）、不是折叠接口（与面心重合的通用接口：由面心推断代替，不单列、不画）；
   * 面只收可安装面（faceMountable）。pickup 且移动子树自带对称时跳过对称子树。没有背面的接口（twoSide）法向记 0。
   */
  function buildCandidates(type, movingPrimary) {
    const used = S.occupiedSocketKeys(doc, poses, movingPrimary)
    const own = ownKeySet()
    let n = 0
    for (const e of list) n += e.sockets.length
    if (dr.cPos.length < 3 * n) {
      const cap = Math.max(64, 2 * n)
      dr.cPos = new Float64Array(3 * cap); dr.cNrm = new Float64Array(3 * cap); dr.cX = new Float64Array(cap); dr.cY = new Float64Array(cap)
      dr.aX = new Float64Array(cap); dr.aY = new Float64Array(cap)
    }
    if (dr.cDed.length < n) dr.cDed = new Uint8Array(Math.max(64, 2 * n))
    dr.cE.length = 0; dr.cS.length = 0; dr.cMount.length = 0
    dr.fE.length = 0; dr.fI.length = 0
    n = 0
    for (const e of list) {
      if (!e.visible || dr.moving.has(e.id) || (dr.symBlock && e.symTaint)) { e.dFaces.length = 0; e.dFn = 0; continue }
      prepFaces(e, type, used)
      for (const s of e.sockets) {
        const key = `${e.pid}|${s.id}`
        if (own.has(key) || used.has(key) || S.isFoldedSocket(e.geo, s.id) || !S.socketUsable(e.comp, s, type, e.geo)) continue
        socketBody(e, s, dr.cPos, dr.cNrm, n)
        if (S.socketTwoSided(e.geo, s)) twoSide(dr.cNrm, n)
        dr.cE.push(e); dr.cS.push(s)
        dr.cDed[n] = S.socketDedicated(s, type) ? 1 : 0
        const m = S.mountFor(dr.def, dr.params, s)
        dr.cMount.push(m === dr.def.mountSocket ? null : m)
        n++
      }
      for (let k = 0; k < e.dFn; k++) if (e.dFaces[k].kind !== 'cyl' && e.dFi[k] < 64) { dr.fE.push(e); dr.fI.push(e.dFi[k]) }
    }
    dr.cN = n
    dr.fN = dr.fE.length
    ov.sockets.set(dr.cPos, dr.cNrm, n, 1, dr.cDed)
    ov.sockets.visible = true
    dr.activeSock = -1
    // 遮挡未判之前按「挡住」算（不画、不当可见插座吸附——指针下那一件的插座照样能定落点），空闲时段里分片判完再放出来
    if (dr.cOcc.length < n) dr.cOcc = new Uint8Array(Math.max(64, 2 * n))
    for (let i = 0; i < n; i++) { dr.cOcc[i] = 1; ov.sockets.occl(i, true) }
    occludeCandidates()
  }
  let zoomToCursor0 = false
  function beginDrag(kind) {
    dr.active = true; dr.kind = kind; dr.pending = true; dr.valid = false
    dr.faceKey = -1; dr.faceEntry = null; dr.statusKey = -2; dr.statusRoll = 0; dr.tgtEntry = null; dr.blockE = null
    dr.rect = vp.canvas.getBoundingClientRect()
    dr.rollTouched = false; dr.mountIdx = -1; dr.stepFace = null; dr.step = 0; dr.lastInfer = 0; dr.foldRoll = 0; dr.rawFree = false; dr.px0 = NaN; dr.py0 = NaN
    lock.on = false; rdn.on = false; ln = 0; rd.key = -1
    hy.reset()
    clash.cancel()
    detachGizmo()
    hoverId = null
    // 无效位的承托平面过装配中心
    liveBBox(0)
    const b = st.bbox, cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2
    dr.center.set(D[0] * cx + D[4] * cy + D[8] * cz, D[1] * cx + D[5] * cy + D[9] * cz, D[2] * cx + D[6] * cy + D[10] * cz)
    // 拖动中滚轮照常缩放（朝指针缩放：缩近看清要装的那个插座），转向归 Q / E
    zoomToCursor0 = !!vp.controls.zoomToCursor
    vp.controls.zoomToCursor = true
    window.addEventListener('pointermove', onDragMove, true)
    window.addEventListener('pointerup', onDragUp, true)
    window.addEventListener('pointerdown', onDragDown, true)
    window.addEventListener('pointercancel', onDragCancel, true)
    window.addEventListener('mousedown', onDragMouse, true)
    window.addEventListener('mouseup', onDragMouse, true)
    window.addEventListener('keydown', onDragKey, true)
    window.addEventListener('keyup', onDragKeyUp, true)
    window.addEventListener('blur', onDragCancel)
    document.body.style.cursor = kind === 'ghost' ? 'grabbing' : 'move'
    setMode(kind)
    updateCursor()
    dragEv.phase = 'start'; dragEv.kind = kind; dragEv.id = dr.id; dragEv.attach = dr.comp.attach; dragEv.target = ''
    emit('drag', dragEv)
    vp.invalidate()
  }
  function endDragListeners() {
    if (candIdle) { idleCancel(candIdle); candIdle = 0 }
    window.removeEventListener('pointermove', onDragMove, true)
    window.removeEventListener('pointerup', onDragUp, true)
    window.removeEventListener('pointerdown', onDragDown, true)
    window.removeEventListener('pointercancel', onDragCancel, true)
    window.removeEventListener('mousedown', onDragMouse, true)
    window.removeEventListener('mouseup', onDragMouse, true)
    window.removeEventListener('keydown', onDragKey, true)
    window.removeEventListener('keyup', onDragKeyUp, true)
    window.removeEventListener('blur', onDragCancel)
    document.body.style.cursor = ''
    vp.controls.zoomToCursor = zoomToCursor0
    if (dr.press && dr.pointerId >= 0) { try { vp.canvas.releasePointerCapture(dr.pointerId) } catch { /* 已经放了 */ } }
  }
  function onDragMove(ev) {
    rbTrack(ev.buttons, ev.clientX, ev.clientY)
    if (!dr.active) return
    // 按住 Alt 移动指针 = 转视角（与空闲态 Alt + 左键拖同一修饰键）：跟手点不动，落点按新视角重算
    if (ev.altKey && dr.px0 === dr.px0 && typeof vp.orbitBy === 'function') {
      vp.orbitBy(ev.clientX - dr.px0, ev.clientY - dr.py0)
      dr.px0 = ev.clientX; dr.py0 = ev.clientY
      dr.pending = true
      vp.invalidate()
      return
    }
    dr.px0 = ev.clientX; dr.py0 = ev.clientY
    if (dr.gate < 0) gateInit(ev.clientX, ev.clientY)
    lastPtr.x = ev.clientX; lastPtr.y = ev.clientY; lastPtr.in = true
    if (shiftDown !== ev.shiftKey) shiftDown = ev.shiftKey
    dr.pending = true
    vp.invalidate()
  }
  function onDragUp(ev) {
    rbTrack(ev.buttons, ev.clientX, ev.clientY)
    if (!dr.active) return
    // 从库里拖进来的 ghost 与「按住选中件拖」的拾起：松手落位（G / Ctrl+D 的拾起是点一下落位，见 onDragDown）
    if (!(dr.kind === 'ghost' || dr.press) || ev.button !== 0) return
    // 按住 Alt 转视角时跟手点没跟着指针走：松手照跟手点落位
    if (!ev.altKey) { lastPtr.x = ev.clientX; lastPtr.y = ev.clientY }
    // 按住拖重新放置：松手点离按下点 < 8 px 或按住 < 150 ms（手抖 / 点一下）→ 原样复位（不记撤销、不提交、不提示）
    if (dr.press) {
      const dx = ev.clientX - dr.pressX, dy = ev.clientY - dr.pressY
      if (dx * dx + dy * dy < STILL_PX * STILL_PX || performance.now() - dr.pressT < STILL_MS) { finishDrag(false); return }
    }
    solveDrag()
    finishDrag(dr.valid, true)
  }
  // ── 放置中的右键（§3.3.2）：拖入 / 按住拖时左键一直按着，浏览器不再为右键派发 pointerdown / pointerup，只从 pointermove（以及
  //    mousedown / mouseup）的 buttons 位掩码看出来——自己识别：按下后不移动（< 5 px）就松开 = 取消；移动过不算取消。
  //    随后的 contextmenu 一直屏蔽到全部按键松开（muteCtx）。G / Ctrl+D 点击落位态里右键是正常的 pointerdown，走同一套。
  const rdn = { on: false, x: 0, y: 0, moved: false }
  function rbTrack(buttons, x, y) {
    const down = (buttons & 2) !== 0
    if (down && !rdn.on) { rdn.on = true; rdn.x = x; rdn.y = y; rdn.moved = false; muteCtx(); return }
    if (!rdn.on) return
    if (down) {
      if (!rdn.moved) { const dx = x - rdn.x, dy = y - rdn.y; if (dx * dx + dy * dy >= RB_MOVE_PX * RB_MOVE_PX) rdn.moved = true }
      return
    }
    rdn.on = false
    if (!rdn.moved && dr.active) { ctxMuteUntil = performance.now() + 600; finishDrag(false) }
  }
  function onDragMouse(ev) { if (ev.button === 2) rbTrack(ev.buttons, ev.clientX, ev.clientY) }
  // contextmenu 屏蔽：右键在放置中按下过 → 窗口捕获阶段吞掉 contextmenu，直到全部按键松开后的那一个（Windows 在 mouseup 之后才派发）
  let ctxMuteUntil = 0, ctxMuted = false, ctxEnd = 0, ctxT = 0
  function muteCtx() {
    ctxEnd = Infinity
    if (ctxMuted) return
    ctxMuted = true
    window.addEventListener('contextmenu', onCtxMute, true)
    window.addEventListener('pointerup', onCtxBtn, true)
    window.addEventListener('mouseup', onCtxBtn, true)
    window.addEventListener('pointermove', onCtxBtn, true)
  }
  function unmuteCtx() {
    if (!ctxMuted) return
    ctxMuted = false
    if (ctxT) { clearTimeout(ctxT); ctxT = 0 }
    window.removeEventListener('contextmenu', onCtxMute, true)
    window.removeEventListener('pointerup', onCtxBtn, true)
    window.removeEventListener('mouseup', onCtxBtn, true)
    window.removeEventListener('pointermove', onCtxBtn, true)
  }
  function onCtxBtn(ev) {
    if (ev.buttons & 2) { ctxEnd = Infinity; return }
    if (ctxEnd !== Infinity || ev.buttons) return
    ctxEnd = performance.now() + 400
    if (!ctxT) ctxT = setTimeout(function tick() { ctxT = 0; if (performance.now() > ctxEnd) unmuteCtx(); else ctxT = setTimeout(tick, 120) }, 450)
  }
  function onCtxMute(ev) {
    if (performance.now() > ctxEnd) { unmuteCtx(); return }
    ev.preventDefault(); ev.stopImmediatePropagation()
    if (ctxEnd !== Infinity) unmuteCtx()   // 全部按键松开后的那一个已吞掉
  }
  // ── G / Ctrl+D 的结构树门：从树上（右键菜单）进入时，指针下那一行要等指针进过一次视口、或离开那一行之后才作为落点 ──
  function treeRow(x, y) { if (!targetAt) return null; try { return targetAt(x, y) } catch { return null } }
  function inRect(x, y) { const r = dr.rect; return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom }
  function gateInit(x, y) {
    if (inRect(x, y)) { dr.gate = 0; return }
    const row = treeRow(x, y)
    dr.gate = row ? 1 : 0; dr.gateRow = row
  }
  function onDragDown(ev) {
    if (ev.button === 2) { ev.preventDefault(); ev.stopPropagation(); rbTrack(ev.buttons | 2, ev.clientX, ev.clientY); return }
    if (dr.kind !== 'pickup' || dr.press || ev.button !== 0) return
    // G / Ctrl+D 点击落位：只认视口与结构树行里的左键点击；点到别的界面 = 取消，并放行这一下点击（不拦、不吞）
    const onCanvas = ev.target === vp.canvas
    if (!onCanvas && dr.gate < 0) gateInit(ev.clientX, ev.clientY)
    const row = onCanvas ? null : treeRow(ev.clientX, ev.clientY)
    if (onCanvas || (row && (dr.gate === 0 || row !== dr.gateRow))) {
      ev.preventDefault(); ev.stopPropagation()
      if (!ev.altKey) { lastPtr.x = ev.clientX; lastPtr.y = ev.clientY; lastPtr.in = onCanvas }
      if (row) dr.gate = 0
      solveDrag()
      finishDrag(dr.valid, true)
      return
    }
    finishDrag(false)
  }
  function onDragCancel() { finishDrag(false) }
  function onDragKey(ev) {
    const k = String(ev.key || '').toLowerCase()
    if (k === 'escape') { ev.preventDefault(); ev.stopPropagation(); finishDrag(false); return }
    if (ev.key === 'Shift') { if (!shiftDown) { shiftDown = true; dr.pending = true; vp.invalidate() } return }
    if (ev.key === 'Alt') { ev.preventDefault(); return }   // 单按 Alt 不唤菜单、不移焦点（Alt + 移动 = 转视角）
    const mod = ev.ctrlKey || ev.metaKey
    // 放置中屏蔽：Ctrl+Tab / Ctrl+W（文档签）、Ctrl+Z / Ctrl+Y（撤销）、Ctrl+D（复制）、Delete / Backspace（删除）；1 / 3 / 7 / 0 放行
    if (mod && (k === 'tab' || k === 'w' || k === 'z' || k === 'y' || k === 'd')) { ev.preventDefault(); ev.stopPropagation(); return }
    if (k === 'delete' || k === 'backspace') { ev.preventDefault(); ev.stopPropagation(); return }
    if (mod || ev.altKey) return
    // Tab：在候选间循环（捕获阶段拦下，不移走焦点）
    if (k === 'tab') { ev.preventDefault(); ev.stopPropagation(); cycleCand(); return }
    // B：本件安装端循环
    if (k === 'b') { ev.preventDefault(); ev.stopPropagation(); if (!ev.repeat) cycleMount(); return }
    // Q / E：按当前落点的滚转档转向（插座档 / 吸附旋转步长；不吸附时 15°）。拖动中这两个键不再当工具快捷键
    if (k === 'q' || k === 'e') {
      ev.preventDefault(); ev.stopPropagation()
      const step = rollStep()
      if (step > 0) { dr.roll = S.snapAngle(dr.roll + (k === 'e' ? step : -step), 0); dr.rollTouched = true; dr.pending = true; vp.invalidate() }
    }
  }
  function onDragKeyUp(ev) {
    if (ev.key === 'Shift' && shiftDown) { shiftDown = false; dr.pending = true; vp.invalidate(); return }
    const k = String(ev.key || '').toLowerCase()
    if (k === 'q' || k === 'e' || k === 'b' || k === 'tab') { ev.preventDefault(); ev.stopPropagation() }
  }
  /** B：本件安装端在 asmSnap.mountChoices 之间循环（写进 attach.mount；ghost 实时换端）。只有一档时不动作。 */
  function cycleMount() {
    const n = dr.mounts.length
    if (!dr.active || n <= 1) return
    const a = dr.comp.attach
    const cur = a.mount || (dr.def ? dr.def.mountSocket : 'root')
    let j = -1
    for (let i = 0; i < n; i++) if (dr.mounts[i].id === cur) { j = i; break }
    dr.mountIdx = (j + 1) % n
    dr.pending = true
    vp.invalidate()
  }
  /** 本帧落点用的安装端（attach.mount 写法：等于组件缺省时 null）：B 选过 → 它；ghost → 接口 i 的 mountFor 规则；拾起 → 保持原安装端。 */
  function mountEff(i) {
    if (dr.mountIdx >= 0) { const id = dr.mounts[dr.mountIdx].id; return dr.def && id === dr.def.mountSocket ? null : id }
    if (dr.kind === 'ghost') return i >= 0 ? dr.cMount[i] : null
    return dr.keep.mount
  }
  // ── Tab 候选循环（§3.3.2）：本帧候选表 LK / LC（按代价排序、按身份键去重；一个面只算一个候选、推断点不进表；背面接口在表里）——
  //    按下 Tab 时快照进 lock，按身份键记住所选；之后每帧只校验它是否仍可行（面候选的 uv 照样跟指针）、锁定期间绕过滞回；
  //    命中件变了 / 空白处锁定后指针移出 24 px / 所选失效 / Shift 切换 → 复位。只有 1 个候选时不动作。零分配（预分配、插入排序）。
  const LK = new Int32Array(LIST_MAX), LC = new Float64Array(LIST_MAX)
  let ln = 0
  const lock = { on: false, key: -1, i: 0, n: 0, keys: new Int32Array(LIST_MAX), pe: null, x0: 0.5, y0: 0.5, raw: false }
  function listAdd(key, cost) {
    for (let i = 0; i < ln; i++) {
      if (LK[i] !== key) continue
      if (cost < LC[i]) {
        let j = i
        while (j > 0 && LC[j - 1] > cost) { LK[j] = LK[j - 1]; LC[j] = LC[j - 1]; j-- }
        LK[j] = key; LC[j] = cost
      }
      return
    }
    if (ln >= LIST_MAX) { if (cost >= LC[ln - 1]) return; ln-- }
    let j = ln++
    while (j > 0 && LC[j - 1] > cost) { LK[j] = LK[j - 1]; LC[j] = LC[j - 1]; j-- }
    LK[j] = key; LC[j] = cost
  }
  function cycleCand() {
    if (!dr.active || dr.via === 1) return
    if (!lock.on) {
      if (ln <= 1) return
      for (let i = 0; i < ln; i++) lock.keys[i] = LK[i]
      lock.n = ln
      let cur = -1
      for (let i = 0; i < ln; i++) if (LK[i] === hy.key) { cur = i; break }
      lock.i = cur
      lock.pe = tg.pe; lock.x0 = lastPtr.x; lock.y0 = lastPtr.y; lock.raw = shiftDown
    } else if (lock.n <= 1) return
    lock.i = (lock.i + 1) % lock.n
    lock.key = lock.keys[lock.i]
    lock.on = true
    dr.pending = true
    vp.invalidate()
  }
  /**
   * 当前落点的滚转档：插座 = 插座的 roll（0 = 不许转）；面心推断落在折叠接口上 = 该接口的档；贴面 = 吸附旋转步长；
   * 自由贴 / 不吸附 = 15°。
   */
  function rollStep() {
    const key = lock.on ? lock.key : hy.key
    if (key >= KEY_SOCK && key < KEY_FACE) { const s = dr.cS[key - KEY_SOCK]; return s ? s.roll : 0 }
    if (key >= KEY_FACE && key < KEY_FREE && dr.lastInfer === S.INFER.CENTER && dr.foldRoll > 0 && snap.on && !shiftDown) return dr.foldRoll
    if (dr.comp && dr.comp.attach && dr.comp.attach.mode === 'socket') {
      const p = dr.comp.parent != null ? entries.get(dr.comp.parent) : null
      const s = p ? p.sockets.find((x) => x.id === dr.comp.attach.socket) : null
      return s ? s.roll : 0
    }
    return snap.on && !shiftDown ? snap.rotate : S.WHEEL_ROLL_DEG
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

  /** 本帧指针射线换到本体系（rc.ray 在显示系）→ R（缺省 RAY）。零分配。 */
  function bodyRay(R = RAY) {
    const o = rc.ray.origin, d = rc.ray.direction
    R[0] = D[0] * o.x + D[1] * o.y + D[2] * o.z; R[1] = D[4] * o.x + D[5] * o.y + D[6] * o.z; R[2] = D[8] * o.x + D[9] * o.y + D[10] * o.z
    R[3] = D[0] * d.x + D[1] * d.y + D[2] * d.z; R[4] = D[4] * d.x + D[5] * d.y + D[6] * d.z; R[5] = D[8] * d.x + D[9] * d.y + D[10] * d.z
  }
  /**
   * 跟手点（指针 − 抓取偏移）的射线（本体系）→ RAYO：按住拖时安装点按它定位（目标件 / 面 / 接口仍按指针选，B08）。每帧最多算一次；
   * 没有抓取偏移时就是指针射线。会改写 rc.ray（只在拾取之后调）。零分配。
   */
  const RAYO = new Float64Array(6)
  let rayoOk = false
  function offRay() {
    if (rayoOk) return
    rayoOk = true
    if (dr.offX === 0 && dr.offY === 0) { for (let k = 0; k < 6; k++) RAYO[k] = RAY[k]; return }
    setRay(lastPtr.x - dr.offX, lastPtr.y - dr.offY, dr.rect)
    bodyRay(RAYO)
  }
  /** 第 i 个候选接口朝外法向朝向相机（与叠加层着色器同一判据；相机本体系位置在 CB）。 */
  function frontSock(i) {
    const o = 3 * i
    return (CB[0] - dr.cPos[o]) * dr.cNrm[o] + (CB[1] - dr.cPos[o + 1]) * dr.cNrm[o + 1] + (CB[2] - dr.cPos[o + 2]) * dr.cNrm[o + 2] >= 0
  }
  /** 平面面 f（件 e 的渲染矩阵）朝向相机；柱面恒算朝向（总有一侧看得见）。 */
  function faceFront(e, f) {
    if (f.kind === 'cyl') return true
    const m = e.m, g = f.origin, n = f.n
    const ox = m[0] * g[0] + m[4] * g[1] + m[8] * g[2] + m[12], oy = m[1] * g[0] + m[5] * g[1] + m[9] * g[2] + m[13], oz = m[2] * g[0] + m[6] * g[1] + m[10] * g[2] + m[14]
    const nx = m[0] * n[0] + m[4] * n[1] + m[8] * n[2], ny = m[1] * n[0] + m[5] * n[1] + m[9] * n[2], nz = m[2] * n[0] + m[6] * n[1] + m[10] * n[2]
    return (CB[0] - ox) * nx + (CB[1] - oy) * ny + (CB[2] - oz) * nz > 0
  }
  /**
   * 射线（本体系 6 元）与件 M（渲染矩阵，可含镜像）上柱面 f 的交点 → io.u / io.v（主件面坐标：轴向 + 弧长，与 uvOnFace 同式）。
   * 取射线前方最近的交点；没有交点返回 false。零分配。
   */
  function rayCylIO(f, M, ray, io) {
    S.faceFrame(T2, f, 0, 0); S.m4Mul(T3, M, T2)
    const F = T3, r = f.radius
    const dx = ray[0] - F[12], dy = ray[1] - F[13], dz = ray[2] - F[14]
    const ox = F[0] * dx + F[1] * dy + F[2] * dz, oy = F[4] * dx + F[5] * dy + F[6] * dz, oz = F[8] * dx + F[9] * dy + F[10] * dz + r
    const rx = ray[3], ry = ray[4], rz = ray[5]
    const lx = F[0] * rx + F[1] * ry + F[2] * rz, ly = F[4] * rx + F[5] * ry + F[6] * rz, lz = F[8] * rx + F[9] * ry + F[10] * rz
    const A = ly * ly + lz * lz
    if (!(A > 1e-12)) return false
    const B = 2 * (oy * ly + oz * lz), C = oy * oy + oz * oz - r * r, disc = B * B - 4 * A * C
    if (!(disc >= 0)) return false
    const sq = Math.sqrt(disc)
    let t = (-B - sq) / (2 * A)
    if (!(t > 0)) t = (-B + sq) / (2 * A)
    if (!(t > 0)) return false
    io.u = ox + t * lx + 0
    io.v = r * Math.atan2(oy + t * ly, oz + t * lz) + 0
    return true
  }
  /**
   * 近失：命中点（主件系 HP）投影到主件条目 pe 最近的可安装面（平面夹进面内；柱面轴向夹紧、局部弧夹进弧内）。
   * 写 tg.nfi（e.faces 下标）/ tg.nu / tg.nv，投影点（画在命中的条目 he 上）到指针的屏距写 NEARD[0]；没有可安装面返回 −1。零分配。
   */
  const NEARD = new Float64Array(1)
  const nio = { u: 0.5, v: 0.5, d: 0.5 }
  function nearFace(pe, he, px, py) {
    let best = -1, bd = Infinity, bu = 0, bv = 0
    for (let k = 0; k < pe.dFn; k++) {
      const f = pe.dFaces[k]
      S.faceFrame(T2, f, 0, 0); S.m4Mul(T3, pe.poseM, T2)
      S.uvOnFaceP(f, T3, HP, nio)
      const hu = f.halfU, hv = f.halfV
      let u = nio.u, v = nio.v
      if (u < -hu) u = -hu; else if (u > hu) u = hu
      if (f.kind !== 'cyl' || !S.isFullCyl(f)) { if (v < -hv) v = -hv; else if (v > hv) v = hv }
      const du = u - nio.u, dv = v - nio.v, d2 = du * du + dv * dv + nio.d * nio.d
      if (d2 < bd) { bd = d2; best = k; bu = u; bv = v }
    }
    if (best < 0) return -1
    tg.nfi = pe.dFi[best]; tg.nu = bu; tg.nv = bv
    UV2[0] = bu; UV2[1] = bv
    S.faceFrameUV(T2, pe.dFaces[best], UV2)
    S.m4Mul(T3, he.m, T2)
    if (projArr(T3, 12)) { const dx = CL.x - px, dy = CL.y - py; NEARD[0] = Math.sqrt(dx * dx + dy * dy) } else NEARD[0] = 0
    return tg.nfi
  }
  const UV2 = [0.5, 0.5]
  /** 本体系点 src[o..o+2] → 拖动视口里的屏幕坐标，写 CL.x / CL.y（CL.z = NDC 深度）；在相机后面返回 false。零分配。 */
  const CL = { x: 0.5, y: 0.5, z: 0.5 }
  function projArr(src, o) {
    const x = src[o], y = src[o + 1], z = src[o + 2]
    _v.set(D[0] * x + D[4] * y + D[8] * z, D[1] * x + D[5] * y + D[9] * z, D[2] * x + D[6] * y + D[10] * z).project(vp.camera)
    if (_v.z > 1 || _v.z < -1) return false
    const r = dr.rect
    CL.x = (_v.x * 0.5 + 0.5) * r.width + r.left
    CL.y = (0.5 - _v.y * 0.5) * r.height + r.top
    CL.z = _v.z
    return true
  }
  /**
   * 本帧报一个候选：strict = 在严格判据内（可当本帧最优，并进 Tab 候选表）；不论严不严，是当前候选就记下它这一帧的代价（滞回）。
   */
  function offer(key, cost, strict) {
    if (key === hy.key && cost < cand.curCost) cand.curCost = cost
    if (strict) { listAdd(key, cost); if (cost < cand.cost) { cand.key = key; cand.cost = cost } }
  }

  /** 每帧一次（帧钩子里）：按指针位置求落点候选（判据见文件头 / asmSnap）、改拖动件的安装语义、解算、上屏。零分配（除换父件 / 换落点件）。 */
  function solveDrag() {
    dr.pending = false
    const r = dr.rect
    // 判据点 = 指针（B08）：目标件、面 / 接口都按指针选；按住拖时件按抓取偏移跟手（安装点按跟手点射线定位，见 offRay）
    const px = lastPtr.x, py = lastPtr.y
    ln = 0; rayoOk = false
    if (!(px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)) {
      lock.on = false
      if (dropOnTree()) return
      dragInvalid(false); return
    }
    if (dr.gate !== 0) dr.gate = 0   // 指针进过视口：结构树行从此都可作落点
    dr.via = 0
    setRay(px, py, r)
    bodyRay()
    cand.key = -1; cand.cost = Infinity; cand.curCost = Infinity
    dr.blockE = null
    const raw = shiftDown
    camBody(CB)
    dr.tanH = Math.tan(vp.camera.fov * Math.PI / 360)
    // 1) 插座投屏：aX / aY 全投（在相机后面 NaN）；cX / cY 只留看得见的（背面、被别的件挡住的 NaN）
    if (dr.cN) {
      const H = r.height
      for (let i = 0; i < dr.cN; i++) {
        const o = 3 * i
        if (!projArr(dr.cPos, o)) { dr.aX[i] = NaN; dr.cX[i] = NaN; continue }
        dr.aX[i] = CL.x; dr.aY[i] = CL.y
        if (!dr.cOcc[i] && frontSock(i)) { dr.cX[i] = CL.x; dr.cY[i] = CL.y } else dr.cX[i] = NaN
      }
      // ① 指针压在看得见的接口标记上：半径 min(22 px, 该件屏上尺寸 × 0.25)（远看小件时标记圈不再盖住大半个件）
      if (!raw) {
        for (let i = 0; i < dr.cN; i++) {
          const sx = dr.cX[i]
          if (sx !== sx) continue
          const dx = sx - px, dy = dr.cY[i] - py, d = Math.sqrt(dx * dx + dy * dy)
          if (d > S.SOCKET_PX + S.HYSTERESIS_PX) continue
          const o = 3 * i, cx = CB[0] - dr.cPos[o], cy = CB[1] - dr.cPos[o + 1], cz = CB[2] - dr.cPos[o + 2]
          const dist = Math.sqrt(cx * cx + cy * cy + cz * cz)
          let rm = MARK_REL * dr.cE[i].size * H / (2 * (dist > 1e-6 ? dist : 1e-6) * dr.tanH)
          if (rm > S.SOCKET_PX) rm = S.SOCKET_PX
          if (d <= rm + S.HYSTERESIS_PX) offer(KEY_SOCK + i, BAND.SOCKET * 1000 + d, d <= rm)
        }
      }
    }
    // ② 指针下那一件（接不了的薄件穿过去）
    const hit = pickTarget(px, py, raw)
    // ③ 空白处磁吸：看得见的插座、朝向相机的平面面（只认指针在面外侧的近失）。指针压在接不了的件上（blockE）不磁吸：
    //    指针明明在那一件上，报它「无可用安装位」比跳到旁边某个接口上更清楚
    if (!hit && !raw && !dr.blockE) {
      for (let i = 0; i < dr.cN; i++) {
        const sx = dr.cX[i]
        if (sx !== sx) continue
        const dx = sx - px, dy = dr.cY[i] - py, d = Math.sqrt(dx * dx + dy * dy)
        if (d <= S.SOCKET_MAG_PX + S.HYSTERESIS_PX) offer(KEY_SOCK + i, BAND.MAG * 1000 + d, d <= S.SOCKET_MAG_PX)
      }
      for (let j = 0; j < dr.fN; j++) {
        const e = dr.fE[j], fi = dr.fI[j]
        if (!S.faceMagnetIO(e.faces[fi], e.m, RAY, mag) || !mag.c) continue
        PP[0] = mag.x; PP[1] = mag.y; PP[2] = mag.z
        if (!projArr(PP, 0)) continue
        const dx = CL.x - px, dy = CL.y - py, d = Math.sqrt(dx * dx + dy * dy)
        if (d <= S.FACE_MAG_PX + S.HYSTERESIS_PX) offer(KEY_FACE + e.index * 64 + fi, BAND.MAG * 1000 + d + S.FACE_MAG_BIAS_PX, d <= S.FACE_MAG_PX)
      }
    }
    // ④ 空文档：原点
    if (dr.empty) offer(KEY_ROOT, BAND.ROOT * 1000, true)
    // Tab 锁定：复位条件（Shift 切换 / 命中件变了 / 空白处锁定后指针移出 24 px）；否则绕过滞回、只校验所选仍可行
    if (lock.on) {
      const dx = px - lock.x0, dy = py - lock.y0
      if (raw !== lock.raw || tg.pe !== lock.pe || (!lock.pe && dx * dx + dy * dy > LOCK_MOVE_PX * LOCK_MOVE_PX)) lock.on = false
      else {
        hy.key = lock.key; hy.cost = 0
        if (applyKey(lock.key, px, py)) return
        lock.on = false; hy.reset()
      }
    }
    // 滞回：当前候选这一帧还在（放宽一个滞回量）就先报它的代价，再报本帧最优
    if (hy.key >= 0 && cand.curCost < Infinity) hy.offer(hy.key, cand.curCost); else hy.reset()
    if (cand.key >= 0) hy.offer(cand.key, cand.cost)
    if (hy.key < 0 || !applyKey(hy.key, px, py)) { hy.reset(); dragInvalid(true) }
  }

  // 射线命中的件（对 KEY_FACE / KEY_FREE 落点：命中处在主件系的面坐标 faceOut、本体系点 / 法向 HP / HN、离相机距离）；
  // 近失投影（nfi：e.faces 下标，nu / nv：投影点的面坐标）
  const tg = { e: null, pe: null, fi: -1, dist: 0.5, nfi: -1, nu: 0.5, nv: 0.5 }
  const HNW = new Float64Array(3)   // 命中处法向（本体系、映回主件之前）：原样贴的跟手点在切平面上求
  let passIdx = new Int32Array(64)
  /**
   * ② 指针下那一件 E（§3.3.2 第 3 步；2026-10-07 v3「指到哪装到哪」）：朝向相机（或没有背面，twoSide）、屏距 ≤ R_ded 的专用空闲接口
   * （E 没有可安装面且只有一个兼容专用接口时不限距离）> 命中处的可安装面 > E 的兼容空闲接口 ≤ 56 px > 命中点投影到 E 最近的可安装面
   * （近失，投影点离指针 ≤ NEAR_PX）；都没有 → 薄件（passThroughOf）射线穿过它再找（PASS_MAX 次），别的件贴在指针处的表面上
   * （表面安装 KEY_FREE，松手 anchorRaw 就近带锚；吊挂件指着无安装面的件的上表面时取下表面，见 rawUnder）——不再报「无可用安装位」，
   * 只有嵌套对称装不进去的件（拾起件自带对称、这一件在别的对称子树里）照旧报。有别的候选时表面安装也进 Tab 列表。
   * 背向相机的接口、指针没压着的面只进 Tab 列表。
   * raw（Shift）：打中什么贴什么（可安装面贴面、别处原样贴），不看接口、不穿透。返回是否定了落点件。零分配（穿透表不够时扩一次）。
   */
  function pickTarget(px, py, raw) {
    tg.e = null; tg.pe = null; tg.fi = -1; tg.nfi = -1
    dr.rawUnder = false
    let found = false, nMask = 0
    const H = dr.rect.height
    for (let pass = 0; pass <= S.PASS_MAX; pass++) {
      const hit = castPick(), he = pickHit.e
      if (!hit) break
      const pe = he.k > 0 ? entries.get(he.pid) : he
      if (!pe || !pe.poseM) break
      tg.nfi = -1
      toBody(hit.point, HP)
      HW[0] = HP[0]; HW[1] = HP[1]; HW[2] = HP[2]
      _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
      if (_n.dot(rc.ray.direction) > 0) _n.negate()
      toBody(_n, HN)
      HNW[0] = HN[0]; HNW[1] = HN[1]; HNW[2] = HN[2]
      if (he.k > 0) S.mirrorHitToPrimary(he.poseM, pe.poseM, he.plane, HP, HN, HP, HN)
      // 面判据：离面容差 max(2 mm, 0.2 % 件尺寸)；面外侧再让出一层蒙皮（MLI / 散热面离结构面几厘米）：min(5 cm, 3 % 件尺寸)。只认可安装面
      faceOut.tol = pe.size > 1 ? 0.002 * pe.size : 0.002
      faceOut.skin = 0.03 * pe.size < 0.05 ? 0.03 * pe.size : 0.05
      const fk = pe.dFn > 0 ? S.faceAtHit(pe.dFaces, pe.poseM, HP, HN, undefined, faceOut) : -1
      const fi = fk >= 0 ? pe.dFi[fk] : -1
      const dist = hit.distance
      if (raw) {
        tg.e = he; tg.pe = pe; tg.fi = fi; tg.dist = dist
        offer(fi >= 0 ? KEY_FACE + he.index * 64 + fi : KEY_FREE + he.index, BAND.FACE * 1000, true)
        found = true
        break
      }
      // 嵌套对称装不进去（拾起件的子树自带对称、这一件在别的对称子树里：候选表里没收它）：停在这里报「X 无可用安装位」
      if (dr.symBlock && pe.symTaint) { if (!dr.blockE) dr.blockE = he; break }
      // E 的屏上尺寸 → 专用接口优先半径：有安装面的件 R_ded = clamp(0.3 × 屏上尺寸, 24, 72) px；没有安装面的件（机翼、反射面、垂尾…）
      // 只有接口能定落点，放宽到 clamp(0.35 × 屏上尺寸, 48, 160) px（再远就贴在指针处的表面：翼下任意位置挂发动机）
      const faceless = pe.dFn === 0
      let rDed = (faceless ? DED2_R_REL : DED_R_REL) * he.size * H / (2 * (dist > 1e-6 ? dist : 1e-6) * dr.tanH)
      const rMin = faceless ? DED2_R_MIN : DED_R_MIN, rMax = faceless ? DED2_R_MAX : DED_R_MAX
      if (rDed < rMin) rDed = rMin; else if (rDed > rMax) rDed = rMax
      let nDedAll = 0, iDed = -1
      for (let i = 0; i < dr.cN; i++) if (dr.cE[i] === he && dr.cDed[i]) { nDedAll++; iDed = i }
      // 馈源进焦点、反射面进座、短舱进唯一的翼下挂点：没有安装面、只有一个兼容专用接口 → 不限距离。拾起件本来就装在这个接口上时不算
      // （按住它拖到别处 = 要换位置：照半径判，再远贴在指针处的表面）
      const lone = faceless && nDedAll === 1 && !(dr.orig && dr.orig.parent === pe.pid && dr.orig.sock === dr.cS[iDed].id)
      let nHit = 0
      for (let i = 0; i < dr.cN; i++) {
        if (dr.cE[i] !== he) continue
        const sx = dr.aX[i]
        if (sx !== sx) continue
        const dx = sx - px, dy = dr.aY[i] - py, d = Math.sqrt(dx * dx + dy * dy)
        // 背向相机的接口永不自动选，只进 Tab 列表（没有背面的接口法向记 0，恒算朝向相机：翼下挂点、反射面焦点从哪一侧指都选得上）
        if (!frontSock(i)) { listAdd(KEY_SOCK + i, (dr.cDed[i] ? BAND.DEDICATED : BAND.PART_SOCKET) * 1000 + LIST_BACK + d); continue }
        if (dr.cDed[i] && (lone || d <= rDed + S.HYSTERESIS_PX)) {
          const ok = lone || d <= rDed
          offer(KEY_SOCK + i, BAND.DEDICATED * 1000 + d, ok)
          if (ok) nHit++
        } else if (fi < 0 && d <= S.SOCKET_MAG_PX + S.HYSTERESIS_PX) {
          const ok = d <= S.SOCKET_MAG_PX
          offer(KEY_SOCK + i, BAND.PART_SOCKET * 1000 + d, ok)
          if (ok) nHit++
        } else listAdd(KEY_SOCK + i, BAND.PART_SOCKET * 1000 + LIST_OTHER + d)
      }
      if (fi >= 0) { offer(KEY_FACE + he.index * 64 + fi, BAND.FACE * 1000, true); nHit++ } else if (pe.dFn > 0) {
        // 命中处不在可安装面上：投影到 E 最近的可安装面（近失，代价排在 E 的兼容接口之后）。投影点离指针超过 NEAR_PX（机头锥、尾锥上
        // 离等直段好几米）不算——贴在指针处的表面，投影只进 Tab 列表
        const nf = nearFace(pe, he, px, py)
        if (nf >= 0) {
          const nd = NEARD[0]
          if (nd <= NEAR_PX + S.HYSTERESIS_PX) { const ok = nd <= NEAR_PX; offer(KEY_FACE + he.index * 64 + nf, NEAR_COST + nd, ok); if (ok) nHit++ } else listAdd(KEY_FACE + he.index * 64 + nf, NEAR_COST + nd)
        }
      }
      // Tab 列表：E 其余朝向相机的可安装面（一个面一个候选）
      for (let k = 0; k < pe.dFn; k++) {
        const j = pe.dFi[k]
        if (j !== fi && j !== tg.nfi && faceFront(he, pe.dFaces[k])) listAdd(KEY_FACE + he.index * 64 + j, BAND.FACE * 1000 + LIST_OTHER + k)
      }
      if (nHit) {
        tg.e = he; tg.pe = pe; tg.fi = fi; tg.dist = dist
        // Tab 还能换到「贴在指针处的表面」（翼上发动机、反射面背上的小件…）
        rawUnderAt(he, pe, dist)
        listAdd(KEY_FREE + he.index, RAW_COST)
        found = true
        break
      }
      // 这一件的接口 / 面都接不了：贴在面上的薄件（散热面 / 体装电池片 / 零质量薄基本体：passThroughOf）射线穿过它再找后面的面
      if (he.pass && he.pick0 >= 0) {
        if (passIdx.length < nMask + he.pickN) { const a = new Int32Array(2 * (nMask + he.pickN)); a.set(passIdx.subarray(0, nMask)); passIdx = a }
        for (let i = he.pick0; i < he.pick0 + he.pickN; i++) if (pickMask[i]) { pickMask[i] = 0; passIdx[nMask++] = i }
        continue
      }
      // 别的件（太阳翼、反射面、机翼、推力器…）：贴在指针处的表面上（表面安装，松手就近带锚）
      tg.e = he; tg.pe = pe; tg.fi = -1; tg.dist = dist
      rawUnderAt(he, pe, dist)
      offer(KEY_FREE + he.index, RAW_COST, true)
      found = true
      break
    }
    for (let k = 0; k < nMask; k++) pickMask[passIdx[k]] = 1
    if (found) dr.blockE = null
    return found
  }
  /**
   * 吊挂件（hangOf：发动机短舱、光电球）指着没有安装面的件（机翼、平尾…）的上表面：表面安装点取射线穿过这一件的出射处（下表面），
   * 件挂在翼下而不是立在翼上（翼上发动机按住 Shift 原样贴）。改写 HP / HN / HW / HNW 并置 dr.rawUnder；不满足条件什么都不改。
   * 只在命中件上的接口 / 面都评完之后调（之后只有 KEY_FREE 落点读 HP / HN）。零分配（BVH 内部为命中结果分配的小对象除外）。
   */
  function rawUnderAt(he, pe, dist) {
    if (pe.dFn !== 0 || !(HNW[2] < -HANG_UP) || !hangOf()) return
    if (exitThrough(he, pe, dist)) dr.rawUnder = true
  }
  /**
   * 拖动件是吊挂件：非卫星领域（本体 +Z 向下）、按 FRD 约定建的件（frameConvention：卫星件局部 −Z 贴父面是「立在面上」、不是吊挂，
   * 跨领域装上飞机 / 船时照样立在命中面上；基本体不分）、表面安装要用的安装端（mountEff：B 选过的 / 拾起件原来的 / 缺省）
   * 法向 = 局部 −Z（shapeKit.hangSocket：短舱 / 光电球）。零分配。
   */
  function hangOf() {
    if (doc.domain === 'spacecraft' || !dr.type || frameConvention(dr.def || getComponent(dr.type)) !== 'frd') return false
    const ms = mountSockById(mountEff(-1) || (dr.def ? dr.def.mountSocket : 'root'), dr.comp)
    return !!ms && ms.n[2] < -0.99
  }
  /**
   * 表面安装的滚转零位参考轴（本体系，写 out；frameZX 自己再去掉法向分量）：取父件局部轴，按各领域面坐标的 u 约定——
   *   非卫星领域（FRD / NED：机身 / 船体 / 车体 / 地面件，局部 +X = 机头 / 船艏 / 车头）：父件 +X；命中法向几乎沿 ±X（前后端面，
   *   |n·X| > √½）时取父件 −Z（上），同 shapeKit.FRD_FACES 的 ±X 面 u = −Z；
   *   卫星：法向几乎沿 ±Z（|n·Z| ≥ √½）取父件 +X，侧面取 +Z，同 sat.mjs FACE_FRAMES。
   * 旧口径「投影最长的那根轴」在翼型这类缓曲面上会在 X / Y 之间来回跳（翼下发动机机头转向翼展方向），2026-10-07 改。零分配。
   * 跟的是父件自己的面坐标约定（frameConvention；2026-10-12 组件不限领域后，船上的卫星件、卫星上的地面站件各按各的），
   * 基本体（不分约定）沿用文档领域。
   */
  function rawRefAxis(M, n, out, ptype) {
    const nx = M[0] * n[0] + M[1] * n[1] + M[2] * n[2], nz = M[8] * n[0] + M[9] * n[1] + M[10] * n[2]
    const fc = frameConvention(getComponent(ptype))
    let k = 0, sg = 1
    if (fc === null ? doc.domain === 'spacecraft' : fc === 'spacecraft') { if (!(Math.abs(nz) >= Math.SQRT1_2)) k = 2 } else if (Math.abs(nx) > Math.SQRT1_2) { k = 2; sg = -1 }
    out[0] = sg * M[4 * k]; out[1] = sg * M[4 * k + 1]; out[2] = sg * M[4 * k + 2]
  }
  const _ro = new THREE.Vector3(), _rd = new THREE.Vector3()
  /**
   * 射线穿过件 he 的出射处：从命中点沿射线再往前（2 × 件尺寸 + 1 cm）处反向打 he 自己的网格，第一个交点即出射点。
   * 写 HP / HN / HW / HNW（本体系；法向朝外 = 背离相机那一侧；派生件映回主件）。打不着返回 false、什么都不改。rc.ray 用完复原。
   */
  function exitThrough(he, pe, dist) {
    if (he.pick0 < 0 || !(he.pickN > 0)) return false
    _ro.copy(rc.ray.origin); _rd.copy(rc.ray.direction)
    rc.ray.origin.copy(_rd).multiplyScalar(dist + 2 * he.size + 0.01).add(_ro)
    rc.ray.direction.copy(_rd).negate()
    const hit = castPick(he.pick0, he.pick0 + he.pickN)
    let ok = false
    if (hit && pickHit.e === he) {
      toBody(hit.point, HP)
      HW[0] = HP[0]; HW[1] = HP[1]; HW[2] = HP[2]
      _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
      if (_n.dot(rc.ray.direction) > 0) _n.negate()
      toBody(_n, HN)
      HNW[0] = HN[0]; HNW[1] = HN[1]; HNW[2] = HN[2]
      if (he.k > 0) S.mirrorHitToPrimary(he.poseM, pe.poseM, he.plane, HP, HN, HP, HN)
      ok = true
    }
    rc.ray.origin.copy(_ro); rc.ray.direction.copy(_rd)
    return ok
  }

  /**
   * 指针移出视口、停在结构树的某一行上 = 装到那一件（选位见 autoSlot）。
   * 返回是否接管了这一帧（指针在树行上：定了落点或报了「无可用安装位」）。只在指针离开视口时调（允许小量分配）。
   */
  function dropOnTree() {
    if (!targetAt) return false
    const pid = treeRow(lastPtr.x, lastPtr.y)
    // G / Ctrl+D 从树上进入：起始行要等指针进过一次视口、或离开它之后才作落点（之前当指针不在视口里）
    if (dr.gate !== 0) { if (dr.gate < 0 || pid === dr.gateRow) return false; dr.gate = 0 }
    const e = pid ? entries.get(pid) : null
    if (!e) return false
    dr.via = 1
    // 拖的就是这一件（或它的子树）/ 嵌套对称装不进去：不报「无可用安装位」，当作指针不在视口里
    if (dr.moving.has(e.id) || (dr.symBlock && e.symTaint)) { dr.blockE = null; dragInvalid(false); return true }
    let key = -1
    if (e.visible) {
      const socks = []
      for (let i = 0; i < dr.cN; i++) if (dr.cE[i] === e) socks.push(dr.cS[i])
      // 面心已被占着的面不放（折叠接口已占）
      const faces = []
      for (let k = 0; k < e.dFn; k++) if (!e.foldBusy[e.dFi[k]]) faces.push(e.dFaces[k])
      const slot = autoSlot(e.pid, dr.type, socks, faces)
      if (slot && slot.socket) { for (let i = 0; i < dr.cN; i++) if (dr.cE[i] === e && dr.cS[i] === slot.socket) { key = KEY_SOCK + i; break } } else if (slot && slot.face) key = KEY_FACE + e.index * 64 + e.faces.indexOf(slot.face)
    }
    if (key < 0) { dr.blockE = e; dragInvalid(false, true); return true }
    hy.reset(); hy.offer(key, 0)
    tg.e = null; tg.pe = null; tg.fi = -1; tg.nfi = -1
    if (!applyKey(key, NaN, NaN)) { dr.blockE = e; dragInvalid(false, true) }
    return true
  }
  /**
   * 自动选位（结构树行落点 / 双击卡片快速添加）：专用接口 > 兼容空闲接口 > 可安装面（面心），各取最朝向相机的那个。
   * socks = 已按兼容 / 空闲 / 非折叠筛好的接口（件局部系），faces = 该件可安装、面心没被占的面。返回 {socket} | {face} | null。
   * 允许分配（不在热路径上）。
   */
  function autoSlot(pid, type, socks, faces) {
    const e = entries.get(pid)
    if (!e) return null
    camBody(CB)
    const M = e.m
    const score = (p, n) => facing(M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14],
      M[0] * n[0] + M[4] * n[1] + M[8] * n[2], M[1] * n[0] + M[5] * n[1] + M[9] * n[2], M[2] * n[0] + M[6] * n[1] + M[10] * n[2])
    let best = null, bs = -Infinity, bDed = false
    for (const s of socks) {
      const ded = S.socketDedicated(s, type), v = score(s.pos, s.n)
      if ((ded && !bDed) || (ded === bDed && v > bs)) { best = s; bs = v; bDed = ded }
    }
    if (best) return { socket: best }
    let bf = null, fs = -Infinity
    for (const f of faces || []) { const v = f.kind === 'cyl' ? 0 : score(f.origin, f.n); if (v > fs) { fs = v; bf = f } }
    return bf ? { face: bf } : null
  }
  /** 朝向相机的程度：法向 n 与「点 → 相机」单位向量的点积（相机本体系位置在 CB）。 */
  function facing(x, y, z, nx, ny, nz) {
    const dx = CB[0] - x, dy = CB[1] - y, dz = CB[2] - z, l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    return (dx * nx + dy * ny + dz * nz) / (l * nl)
  }

  /** off / tilt 归零（就地；接口 / 面以外的方式不用它们）。 */
  function zeroExt(a) { a.off[0] = 0; a.off[1] = 0; a.off[2] = 0; a.tilt[0] = 0; a.tilt[1] = 0 }
  /** 拾起件的 t / q 写回原值（就地）。 */
  function copyTQ(c, o) { c.t[0] = o.t[0]; c.t[1] = o.t[1]; c.t[2] = o.t[2]; c.q[0] = o.q[0]; c.q[1] = o.q[1]; c.q[2] = o.q[2]; c.q[3] = o.q[3] }
  /**
   * 接口落点写进 attach（§3.3.2 重新放置）：落回原接口、没按 Q / E / B → 原样（接口件 off / tilt / 滚转 / 安装端逐位不动；带接口锚的
   * 自由件 t / q 原样）；否则 socket + 安装端（B / mountFor 规则 / 保持原端）、滚转按接口档取整、倾角与法向偏移带过去，
   * 接口系面内偏移只在原来就是接口落点时保留（换了落点类型清零）。i = 候选下标（折叠接口还原时 −1）。零分配。
   */
  function writeSock(a, c, pid, s, i) {
    const o = dr.orig, k = dr.keep
    if (o && o.parent === pid && o.sock === s.id && !dr.rollTouched && dr.mountIdx < 0) {
      a.socket = s.id; a.face = null; a.uv = null; a.mount = o.mount
      if (o.mode === 'free') { a.mode = 'free'; a.roll = 0; zeroExt(a); copyTQ(c, o) } else {
        a.mode = 'socket'; a.roll = o.roll
        a.off[0] = o.off[0]; a.off[1] = o.off[1]; a.off[2] = o.off[2]; a.tilt[0] = o.tilt[0]; a.tilt[1] = o.tilt[1]
      }
      return
    }
    a.mode = 'socket'; a.socket = s.id; a.face = null; a.uv = null; a.mount = mountEff(i)
    a.roll = s.roll > 0 ? S.snapAngle(dr.roll, s.roll) : 0
    a.off[0] = k.sockOff ? k.ox : 0; a.off[1] = k.sockOff ? k.oy : 0; a.off[2] = k.oz
    a.tilt[0] = k.t0; a.tilt[1] = k.t1
  }
  /**
   * 面落点（面坐标在 inf / dr.uv）写进 attach：原 attach 是这个面的折叠接口且落点仍在面心 → 保持原接口写法；带面锚的自由件落回原面
   * → 只改 t（平面：面内位移并进 t.xy；柱面：锚 uv 跟着走），q / 法向分量 / 锚 uv 原样；面安装件落回原面 → 只改 uv；
   * 其余 → surface + 安装端、倾角与法向偏移带过去、面内偏移清零，滚转（拖入或按过 Q / E 时）按档取整（面心推断落在折叠接口上用它的档）。
   */
  function writeFace(a, c, pe, f, fi, raw) {
    const o = dr.orig, k = dr.keep
    if (o && o.sock && o.parent === pe.pid && pe.fold[fi] >= 0 && pe.sockets[pe.fold[fi]].id === o.sock && inf.u === 0 && inf.v === 0) { writeSock(a, c, pe.pid, pe.sockets[pe.fold[fi]], -1); return }
    const same = !!o && o.parent === pe.pid && o.face === f.id && !dr.rollTouched && dr.mountIdx < 0
    if (same && o.mode === 'free') {
      const du = inf.u - o.mpU, dv = inf.v - o.mpV, uv = dr.uvA
      a.mode = 'free'; a.socket = null; a.face = f.id; a.roll = 0; a.mount = o.mount; zeroExt(a)
      copyTQ(c, o)
      if (f.kind !== 'cyl') { uv[0] = o.uv[0]; uv[1] = o.uv[1]; c.t[0] = o.t[0] + du; c.t[1] = o.t[1] + dv } else { uv[0] = o.uv[0] + du; uv[1] = o.uv[1] + dv }
      a.uv = uv
      return
    }
    a.mode = 'surface'; a.socket = null; a.face = f.id; a.uv = dr.uv
    if (same && o.mode === 'surface') { a.roll = o.roll; a.mount = o.mount } else {
      a.mount = mountEff(-1)
      const step = inf.kind === S.INFER.CENTER && pe.foldRoll[fi] > 0 ? pe.foldRoll[fi] : snap.rotate
      a.roll = snap.on && !raw && (dr.kind === 'ghost' || dr.rollTouched) ? S.snapAngle(dr.roll, step) : dr.roll
    }
    a.off[0] = 0; a.off[1] = 0; a.off[2] = k.oz
    a.tilt[0] = k.t0; a.tilt[1] = k.t1
  }
  /**
   * 把选定的落点（候选键）写进拖动件的安装语义、画记号 / 牵引线 / 描边、解算、上屏；落点不可行（面候选算不出面坐标）返回 false。
   * px / py 是 NaN = 指针不在视口里（结构树落点，不画牵引线）。牵引线从跟手点（指针 − 抓取偏移）连到落点。
   */
  function applyKey(key, px, py) {
    const c = dr.comp, a = c.attach, cam = vp.camera
    const lx = px - dr.offX, ly = py - dr.offY
    let tgt = null, rpe = null, rs = null, rf = null, kind = 0
    dr.rawFree = false
    if (key === KEY_ROOT) {
      setDragParent(null)
      a.mode = 'free'; a.socket = null; a.face = null; a.uv = null; a.roll = 0; a.mount = null; zeroExt(a)
      hideFace(); ov.guide.hide(); ov.leader.hide(); ov.marker.showAt(Z3, 0, 5)
      markActiveSock(-1)
    } else if (key < KEY_FACE) {
      const i = key - KEY_SOCK, e = dr.cE[i], s = dr.cS[i]
      if (!e || !s) return false
      tgt = e; rpe = e; rs = s
      setDragParent(e.pid)
      writeSock(a, c, e.pid, s, i)
      hideFace(); ov.guide.hide()
      ov.marker.showAt(dr.cPos, 3 * i, 5)
      markActiveSock(i)
      leaderTo(dr.cPos, 3 * i, lx, ly)
    } else if (key < KEY_FREE) {
      const k = key - KEY_FACE, idx = Math.floor(k / 64), fi = k - 64 * idx
      const e = list[idx], pe = e ? (e.k > 0 ? entries.get(e.pid) : e) : null
      const f = pe && pe.poseM ? pe.faces[fi] : null
      if (!f) return false
      // 安装点的面坐标：结构树行 = 面心；指针压着这个面 = 命中点；近失 = 投影点；否则指针射线与面所在平面的交点（夹进面内）
      let dist = 1
      if (dr.via === 1) { inf.u = 0; inf.v = 0 } else if (tg.e === e && tg.fi === fi) { inf.u = faceOut.u; inf.v = faceOut.v; dist = tg.dist } else if (tg.pe === pe && tg.nfi === fi) { inf.u = tg.nu; inf.v = tg.nv; dist = tg.dist } else if (f.kind !== 'cyl' && S.faceMagnetIO(f, e.m, RAY, mag)) {
        inf.u = mag.u; inf.v = mag.v
        PP[0] = mag.x; PP[1] = mag.y; PP[2] = mag.z
        _v.set(D[0] * PP[0] + D[4] * PP[1] + D[8] * PP[2], D[1] * PP[0] + D[5] * PP[1] + D[9] * PP[2], D[2] * PP[0] + D[6] * PP[1] + D[10] * PP[2])
        dist = _v.distanceTo(cam.position)
      } else return false
      // 按住拖的跟手：安装点取跟手点射线与这个面的交点（交不上沿用指针那一点）
      if (dr.via !== 1 && (dr.offX !== 0 || dr.offY !== 0)) {
        offRay()
        if (f.kind === 'cyl' ? rayCylIO(f, e.m, RAYO, mag) : S.faceMagnetIO(f, e.m, RAYO, mag)) { inf.u = mag.u; inf.v = mag.v }
      }
      tgt = e; rpe = pe; rf = f
      setDragParent(pe.pid)
      const raw = shiftDown
      inf.kind = dr.via === 1 ? S.INFER.CENTER : S.INFER.FREE; inf.gu = 0; inf.gv = 0
      // 网格步长（'auto' = 安装面短边 / 20 取 1-2-5 档，夹 1 mm–1 m）：换面才重算
      if (dr.stepFace !== f) { dr.stepFace = f; dr.step = snap.on ? S.resolveMoveStep(snap.move, f) : 0; emitStep(dr.step) }
      if (dr.via !== 1 && snap.on && !raw) {
        inf.ppm = dr.rect.height / (2 * Math.max(1e-6, dist) * dr.tanH)
        GZR[0] = inf.u; GZR[1] = inf.v
        S.faceInferIO(f, inf, S.INFER_PX, dr.step, S.INFER_LINE_PX, shortPxOf(f, inf.ppm))
        // 面心已被别的件占着：不往面心吸
        if (pe.foldBusy[fi] && inf.u === 0 && inf.v === 0) { inf.u = GZR[0]; inf.v = GZR[1]; inf.kind = S.INFER.FREE; inf.gu = 0; inf.gv = 0 }
      }
      S.clampIO(f, inf)
      kind = inf.kind
      dr.lastInfer = kind
      dr.foldRoll = pe.foldRoll[fi]
      dr.uv[0] = inf.u; dr.uv[1] = inf.v
      writeFace(a, c, pe, f, fi, raw)
      if (a.mode === 'socket' && pe.fold[fi] >= 0) rs = pe.sockets[pe.fold[fi]]
      // 锚点记号 / 面轮廓 / 引导线画在指针那一侧（派生件的渲染矩阵 × 面系 = 主件同一面坐标在派生件上的那一点）
      S.faceFrameUV(T0, f, dr.uv)
      S.m4Mul(T1, e.m, T0)
      ov.marker.showAt(T1, 12, kind === S.INFER.CLINE || kind === S.INFER.ELINE ? 1 : kind)
      if (dr.faceKey !== key || dr.faceEntry !== e) { ov.face.show(e.m, f, S.faceFrame); dr.faceKey = key; dr.faceEntry = e }
      ov.guide.show(e.m, f, S.faceFrame, inf.gu, inf.gv, dr.uv)
      markActiveSock(-1)
      leaderTo(T1, 12, lx, ly)
    } else {
      // 表面安装（按住 Shift 的原样贴，或指针下那一件的接口 / 面都接不了时的兜底）：安装端法向贴命中法向；滚转零位取父件的参考轴
      // （rawRefAxis，与各领域面坐标的 u 约定一致）在切平面上的投影。拖动中是相对父件的自由位姿，松手时就近带锚（anchorRaw）
      const pe = tg.pe
      if (!pe || !pe.poseM) return false
      tgt = tg.e; rpe = pe
      setDragParent(pe.pid)
      // 按住拖的跟手：跟手射线与命中处切平面的交点（主件上命中时；派生件就用命中点）
      if ((dr.offX !== 0 || dr.offY !== 0) && tg.e && tg.e.k === 0) {
        offRay()
        const den = RAYO[3] * HNW[0] + RAYO[4] * HNW[1] + RAYO[5] * HNW[2]
        if (den < -1e-9) {
          const t = ((HW[0] - RAYO[0]) * HNW[0] + (HW[1] - RAYO[1]) * HNW[1] + (HW[2] - RAYO[2]) * HNW[2]) / den
          if (t > 0) { HP[0] = HW[0] = RAYO[0] + t * RAYO[3]; HP[1] = HW[1] = RAYO[1] + t * RAYO[4]; HP[2] = HW[2] = RAYO[2] + t * RAYO[5] }
        }
      }
      const M = pe.poseM
      rawRefAxis(M, HN, AX3, pe.comp ? pe.comp.type : null)
      a.mode = 'free'; a.socket = null; a.face = null; a.uv = null; a.roll = 0; a.mount = mountEff(-1); zeroExt(a)
      S.frameZX(T0, HP, HN, AX3, 1)
      S.m4RotZ(T1, dr.roll)
      S.m4Mul(T2, T0, T1)
      const ms = mountSocketFor(c)
      if (ms) { S.mountFrame(T0, ms); S.m4InvRigid(T1, T0); S.m4Mul(T3, T2, T1) } else S.m4Copy(T3, T2)
      S.m4Mul(T0, S.m4InvRigid(T1, M), T3)
      S.m4ToQT(T0, c.q, c.t)
      hideFace(); ov.guide.hide(); ov.marker.showAt(HW, 0, 0)
      // 吊挂件挂到下表面（rawUnder）：落点不在指针下，牵引线连过去
      if (dr.rawUnder) leaderTo(HW, 0, lx, ly); else ov.leader.hide()
      markActiveSock(-1)
      dr.rawFree = true
    }
    // 落点有效：拖动中的告警（「未吸附」「X 无可用安装位」）让位；落点说明进光标读数，不进状态片
    if (dr.statusKey !== 0) { dr.statusKey = 0; setStatus('', '') }
    setTarget(tgt)
    // 解算 + 上屏
    dr.valid = true
    if (dr.kind === 'ghost') {
      solvePose(dr.doc, dr.poses)
      // 工具栏对称的件几何落在对称面 / 对称轴上（KSP 的堆叠节点口径）：副本会与原件重合，这一次放置不带对称；离开对称面再带上。
      // 按几何判（件的包围盒中心），不按原点：机翼这种从中线插座往外长的件原点在对称面上、几何在一侧，照样带镜像
      if (dr.symWanted) {
        const pm = dr.poses.get(dr.id)
        const want = !(pm && onSymLocus(dr.symWanted, pm.m, dr.item.box6)) && !S.socketSingle(dr.doc, dr.comp)
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
        const want = !(pm && onSymLocus(dr.symWanted, pm.m, e0 && e0.item ? e0.item.box6 : null)) && !S.socketSingle(doc, dr.comp)
        if (want !== (dr.comp.sym !== null)) { dr.comp.sym = want ? dr.symWanted : null; pickupRestructure() }
      }
      afterLiveEdit(0)
      if (dr.wasInvalid) { dr.wasInvalid = false; refreshFx() }
    }
    cursorAt(key, kind, rpe, rs, rf, px, py)
    dragEv.phase = 'move'
    dragEvDirty = true
    vp.invalidate()
    return true
  }
  // ── 光标读数（§3.3.2）：拖动中跟在指针右下的「目标件 · 接口名 / 面名 · 推断 · i/n · 滚转°」（运行时数据，cursor 事件；
  //    帧钩子里发，同一个对象复用）。文字只在落点 / 推断 / 滚转 / 序号 / 安装端变了时重拼（热路径不每帧分配）。
  const CUR = { on: false, x: 0.5, y: 0.5, text: '' }
  let curDirty = false
  const rd = { key: -1, kind: -1, roll: 0.5, i: -1, n: -1, mount: null, raw: false, pid: '', under: false }
  function cursorAt(key, kind, pe, s, f, px, py) {
    let i = 0, n = 0
    if (lock.on) { i = lock.i + 1; n = lock.n } else { n = ln; for (let j = 0; j < ln; j++) if (LK[j] === key) { i = j + 1; break } }
    const a = dr.comp.attach, roll = a.mode === 'free' ? 0 : a.roll, mnt = a.mount, raw = shiftDown, pid = pe ? pe.pid : '', under = dr.rawUnder
    if (!CUR.on || rd.key !== key || rd.kind !== kind || rd.roll !== roll || rd.i !== i || rd.n !== n || rd.mount !== mnt || rd.raw !== raw || rd.pid !== pid || rd.under !== under) {
      rd.key = key; rd.kind = kind; rd.roll = roll; rd.i = i; rd.n = n; rd.mount = mnt; rd.raw = raw; rd.pid = pid; rd.under = under
      CUR.text = cursorText(key, kind, pe, s, f, i, n, roll, mnt, raw)
    }
    CUR.x = px === px ? px : lastPtr.x; CUR.y = py === py ? py : lastPtr.y
    CUR.on = true
    curDirty = true
  }
  function cursorOff() { if (CUR.on) { CUR.on = false; curDirty = true } }
  function cursorText(key, kind, pe, s, f, i, n, roll, mnt, raw) {
    const parts = []
    if (key === KEY_ROOT) parts.push('原点')
    else {
      if (pe) parts.push(nameOf(pe.pid))
      if (s) parts.push(S.socketLabel(s.id)); else if (f) parts.push(faceName(f.id)); else parts.push(dr.rawUnder && !raw ? '下表面' : '表面')
      if (!s && INFER_NAME[kind]) parts.push(INFER_NAME[kind])
    }
    if (i > 0 && n > 1) parts.push(`${i}/${n}`)
    if (roll) parts.push(`${fmtDeg(roll)}°`)
    if (mnt) parts.push('本件 ' + S.mountLabel(mnt))
    if (raw) parts.push('原样')
    return parts.join(' · ')
  }
  /** 面的显示名：表里的中文名；盒面轴号（+X …）后缀「面」。 */
  function faceName(id) { const t = S.faceLabel(id); return /^[+−-][XYZ]$/.test(t) ? t + ' 面' : t }
  /**
   * 落点不在指针下时画牵引线：指针端取在落点那一层深度上（反投影回本体系），两端投到屏上恰是「指针 → 落点」那一段。
   * px 是 NaN（结构树落点）或落点就在指针下（< LEAD_MIN_PX）不画。零分配（坐标从数组读）。
   */
  function leaderTo(src, o, px, py) {
    if (px !== px || !projArr(src, o)) { ov.leader.hide(); return }
    const dx = CL.x - px, dy = CL.y - py
    if (dx * dx + dy * dy < LEAD_MIN_PX * LEAD_MIN_PX) { ov.leader.hide(); return }
    const r = dr.rect
    _v2.set(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1, CL.z).unproject(vp.camera)
    toBody(_v2, PP)
    // 一节虚线 DASH_PX 像素：按落点到相机的距离换成米
    const x = src[o], y = src[o + 1], z = src[o + 2]
    _v.set(D[0] * x + D[4] * y + D[8] * z, D[1] * x + D[5] * y + D[9] * z, D[2] * x + D[6] * y + D[10] * z)
    const dist = _v.distanceTo(vp.camera.position)
    const mPerPx = (2 * dist * Math.tan(vp.camera.fov * Math.PI / 360)) / Math.max(1, r.height)
    ov.leader.show(PP, 0, src, o, DASH_PX * mPerPx)
  }
  /** 落点所在的件变了：描边换过去、结构树对应行跟着亮（drag 事件带 target）。只在换件时 refreshFx。 */
  function setTarget(e) {
    if (dr.tgtEntry === e) return
    dr.tgtEntry = e
    dragEv.target = e ? e.pid : ''
    refreshFx()
  }
  const fmtDeg = (v) => { const r = Math.round(v * 100) / 100; return String(r < 0 ? '−' + -r : r) }
  /** 藏目标面轮廓并复位缓存键（藏了不复位的话，指针途经插座候选再回到同一个面，轮廓不再出来）。 */
  function hideFace() { ov.face.hide(); dr.faceKey = -1; dr.faceEntry = null }
  /** 拖动件当前安装端（attach.mount ‖ 组件缺省）的插座同形对象：先查 B 的候选表（含 '@面' / '@bbox'），再查件自己的插座。 */
  function mountSocketFor(c) { return mountSockById(c.attach.mount || (dr.def ? dr.def.mountSocket : 'root'), c) }
  /** 拖动件安装端 id → 插座同形对象（同上的查法；零分配）。 */
  function mountSockById(id, c) {
    for (let i = 0; i < dr.mounts.length; i++) if (dr.mounts[i].id === id) return dr.mountSock[i]
    const e = dr.kind === 'ghost' ? null : entries.get(c.id)
    const list0 = dr.item && dr.kind === 'ghost' ? dr.item.sockets : e ? e.sockets : []
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
  /**
   * 无效位：ghost 停在过装配中心、垂直视线的平面上并改 danger 色；pickup 件同样跟到平面上（红染），松手 = 复原。
   * 状态：指针下有件却接不了 → 「X 无可用安装位」；视口里空处 → 「未吸附」；指针在视口外不报。
   * keepGhost：结构树行上「无可用安装位」时 ghost 藏起来（指针不在视口里）。
   */
  function dragInvalid(inside, onTree) {
    hy.reset()
    dr.valid = false
    dr.rawFree = false
    hideFace(); ov.marker.hide(); ov.guide.hide(); ov.leader.hide()
    markActiveSock(-1)
    setTarget(null)
    cursorOff()
    const be = inside || onTree ? dr.blockE : null
    const skey = be ? -100 - be.index : inside ? -1 : -3
    if (dr.statusKey !== skey) {
      dr.statusKey = skey; dr.statusRoll = 0
      // 告警色、不自动消失（拖动中的持续状态，换了落点才变）
      if (be) setStatus('warn', `${nameOf(be.pid)} 无可用安装位`, 0); else if (inside) setStatus('warn', '未吸附', 0); else setStatus('', '')
    }
    dragEv.phase = 'move'
    if (!inside) { if (dr.kind === 'ghost') ghost.hide(); dragEvDirty = true; vp.invalidate(); return }
    const cam = vp.camera
    cam.getWorldDirection(_v2)
    _plane.setFromNormalAndCoplanarPoint(_v2, dr.center)
    // 按住拖：件按跟手点（指针 − 抓取偏移）跟到承托平面上
    if (dr.offX !== 0 || dr.offY !== 0) setRay(lastPtr.x - dr.offX, lastPtr.y - dr.offY, dr.rect)
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
  /**
   * dropped：在无效位松手 / 点下（不是 Esc、右键、指针被系统取消）——没装上 / 没挪动要说一声（「未安装。」「未移动。」），
   * 不然件凭空消失、或者原地不动，看不出是没吸上。
   */
  /**
   * 原样贴到非面处的件（拖动中是相对父件的自由位姿）：松手时按 pickAnchor 就近带锚（E 上最近的面 / 接口），用 attachFromWorldExact
   * 精确反解 uv / off / 滚转 / 倾角（位姿不变）；没有可取的锚就保持无锚自由。只在松手时调（允许分配）。
   */
  function anchorRaw() {
    const c = dr.comp, d0 = dr.kind === 'ghost' ? dr.doc : doc, ps = dr.kind === 'ghost' ? dr.poses : poses
    if (c.parent == null) return
    solvePose(d0, ps)
    const pm = ps.get(dr.id), pp = ps.get(c.parent)
    if (!pm || !pp || pm.bad || pp.bad) return
    const W = Float64Array.from(pm.m), PM = Float64Array.from(pp.m)
    let pa = null, r = null
    try { pa = S.pickAnchor(d0, ps, c, c.parent, W) } catch { pa = null }
    if (!pa) return
    try { r = S.attachFromWorldExact(c, PM, W, pa.kind === 'face' ? 'surface' : 'socket', pa.kind === 'face' ? pa.face : pa.socket, pa.uv) } catch { r = null }
    if (r && r.attach) c.attach = r.attach
  }
  function finishDrag(ok, dropped) {
    if (!dr.active) return
    endDragListeners()
    const kind = dr.kind, id = dr.id, wasEmpty = dr.empty
    if (ok && dr.valid && dr.rawFree) anchorRaw()
    dr.active = false
    dr.press = false; dr.offX = 0; dr.offY = 0; dr.pointerId = -1
    lock.on = false; rdn.on = false
    cursorOff()
    if (curDirty) { curDirty = false; emit('cursor', CUR) }
    updateCursor()
    const hadTarget = !!dr.tgtEntry
    dr.tgtEntry = null
    ghost.hide(); ghost.setItem(null)
    ov.hideDrag()
    setStatus('', '')
    dragEv.phase = ok ? 'end' : 'cancel'; dragEv.kind = kind; dragEv.id = id; dragEv.target = ''
    if (kind === 'ghost') {
      if (ok) {
        const c = dr.comp
        const spec = { id, type: dr.type, params: dr.params, parent: c.parent, attach: S.mkAttach(c.attach), t: c.t.slice(), q: c.q.slice(), sym: c.sym ? { ...c.sym } : null }
        const r = S.addComp(doc, spec)
        setMode('idle')
        emit('drag', dragEv)
        // 空文档落下第一件（根件）：取景整件
        if (r.ok) { commitDoc('add', r.doc, [r.id]); sel = []; select([r.id]); if (wasEmpty && attached) fitView(); return }
        setStatus('warn', r.error)
      } else {
        setMode('idle'); emit('drag', dragEv)
        if (dropped) setStatus('warn', '未安装。')
      }
      if (hadTarget) refreshFx()
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
      if (moved && dr.symWanted) { const c = S.compById(doc, id); if (c && !c.sym) setStatus('warn', `${nameOf(id)} 已取消对称。`) }
    } else {
      doc = normalizeAssembly(JSON.parse(dr.before))
      sync('cancel', [], false)
      emitSelIfPruned()
      if (dropped) setStatus('warn', dr.label === 'duplicate' ? '未复制。' : '未移动。')
    }
  }
  function flushIdle() { statsDirty = true; vp.invalidate() }

  function beginDragFromLib(type, clientX, clientY, o = {}) {
    if (!attached || busy() || posePreview) return false
    // 组件不限领域（2026-10-12）：卫星相控阵拖上船、地面站馈源拖上卫星都行
    const def = getComponent(type)
    if (!def) return false
    const params = o && o.params && typeof o.params === 'object' ? JSON.parse(JSON.stringify(o.params)) : {}
    let item
    try { item = cache.get({ type, params, material: null }) } catch { return false }
    cache.prep(item, true)   // 边线 / BVH 插队：ghost 露面时有边线、落下时有 BVH（库卡片按下时多半已经预热过）
    dr.type = type; dr.def = def; dr.item = item; dr.params = params
    dr.id = S.compIdFor(doc, type)
    dr.roll = 0; dr.uv[0] = 0; dr.uv[1] = 0; dr.count = 1; dr.derivedIds.length = 0; dr.wasInvalid = false; dr.symWanted = null
    dr.press = false; dr.offX = 0; dr.offY = 0; dr.pointerId = -1; dr.gate = 0
    dr.empty = doc.comps.length === 0
    dr.comp = { id: dr.id, type, params: fillParams(def, params), parent: undefined, attach: S.mkAttach(), sym: null, name: null, massKg: null, material: null, hidden: false, locked: false, t: [0, 0, 0], q: [0, 0, 0, 1] }
    dr.orig = null
    setKeep(0, 0, 0, 0, 0, 0, false, null)
    prepMounts(dr.comp)
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

  /** 换锚时带过去的量（就地写 dr.keep：热路径只读）。 */
  function setKeep(roll, t0, t1, ox, oy, oz, sockOff, mount) {
    const k = dr.keep
    k.roll = roll; k.t0 = t0; k.t1 = t1; k.ox = ox; k.oy = oy; k.oz = oz; k.sockOff = sockOff; k.mount = mount
  }
  /** B 的安装端候选（asmSnap.mountChoices，与属性面板「安装端」下拉同一份）与对应的插座同形对象。拖动开始时调（允许分配）。 */
  function prepMounts(c) {
    dr.mountIdx = -1
    try { dr.mounts = S.mountChoices(c) } catch { dr.mounts = [] }
    dr.mountSock = dr.mounts.map((m) => { try { return S.mountSocketOf({ type: c.type, params: c.params, attach: { mount: m.id } }) } catch { return null } })
  }
  /**
   * 拾起件原来的安装语义（落回原锚只改真正变了的量）+ 换锚时带过去的量（§3.3.2 重新放置：保留倾角、法向偏移、安装端）：
   * 接口 / 面安装件直接取 attach；带锚自由件把 t / q 相对原锚系精确分解成 滚转 / 倾角 / 偏移（attachFromWorldExact），
   * 另记安装点在锚面上的面坐标（落回原面时把面内位移并进 t）。无锚自由件全取缺省。拾起时调（允许分配）。
   */
  function captureOrig(c) {
    const a = c.attach, pe = c.parent != null ? entries.get(c.parent) : null
    const sock = a.mode !== 'surface' && typeof a.socket === 'string' && a.socket ? a.socket : null
    const face = !sock && a.mode !== 'socket' && typeof a.face === 'string' && a.face ? a.face : null
    const o = {
      parent: c.parent, mode: a.mode, sock, face, uv: Array.isArray(a.uv) ? [a.uv[0], a.uv[1]] : [0, 0], roll: Number(a.roll) || 0, mount: a.mount || null,
      off: Array.isArray(a.off) ? a.off.slice() : [0, 0, 0], tilt: Array.isArray(a.tilt) ? a.tilt.slice() : [0, 0], t: c.t.slice(), q: c.q.slice(), mpU: 0, mpV: 0
    }
    dr.orig = o
    if (a.mode !== 'free') { setKeep(o.roll, o.tilt[0], o.tilt[1], o.off[0], o.off[1], o.off[2], a.mode === 'socket', o.mount); return }
    setKeep(0, 0, 0, 0, 0, 0, false, o.mount)
    const e = entries.get(c.id)
    const tgt = !pe ? null : sock ? pe.sockets.find((s) => s.id === sock) : face ? pe.faces.find((f) => f.id === face) : null
    if (!tgt || !e || !e.poseM || !pe.poseM) return
    try {
      const r = S.attachFromWorldExact(c, pe.poseM, e.poseM, sock ? 'socket' : 'surface', tgt, o.uv)
      const x = r && r.attach
      if (x) setKeep(Number(x.roll) || 0, x.tilt[0], x.tilt[1], x.off[0], x.off[1], x.off[2], !!sock, o.mount)
    } catch { /* 分解不了：按缺省带 */ }
    if (face) {
      S.mountedFrame(T0, c, pe.geo)
      S.faceFrame(T1, tgt, 0, 0)
      const io = { u: 0, v: 0, d: 0 }
      S.uvOnFace(tgt, T1, T0[12], T0[13], T0[14], io)
      o.mpU = io.u; o.mpV = io.v
    }
  }
  /**
   * @param {{press?:boolean, grabX?:number, grabY?:number, pointerId?:number, t0?:number}} [o] press：按下拖动式（松手落位，见 onCanvasDownCap）——
   *   目标按指针选，安装点按跟手点（指针 − 抓取偏移）定位：件跟着指针平移、不一下跳到指针上；t0 = 按下时刻（< 150 ms 松手原样复位）
   */
  function startPickup(id, label, before, o = {}) {
    const c = S.compById(doc, id)
    if (!c) return false
    if (!c.t) c.t = [0, 0, 0]
    if (!c.q) c.q = [0, 0, 0, 1]
    const def = getComponent(c.type)
    dr.type = c.type; dr.def = def; dr.item = null; dr.params = c.params
    dr.id = id; dr.comp = c; dr.doc = doc; dr.poses = poses; dr.count = 1; dr.derivedIds.length = 0
    captureOrig(c)
    prepMounts(c)
    dr.roll = dr.keep.roll; dr.uv[0] = 0; dr.uv[1] = 0; dr.wasInvalid = false
    dr.press = !!o.press; dr.pointerId = o.press && Number.isInteger(o.pointerId) ? o.pointerId : -1; dr.offX = 0; dr.offY = 0
    dr.pressX = o.press && Number.isFinite(o.grabX) ? o.grabX : 0; dr.pressY = o.press && Number.isFinite(o.grabY) ? o.grabY : 0
    dr.pressT = o.press && Number.isFinite(o.t0) ? o.t0 : performance.now()
    // G / Ctrl+D：指针最后在视口里 → 结构树行不设门；否则第一次移动时按指针所在定（从树的右键菜单进入时起始行先不算落点）
    dr.gate = o.press || lastPtr.in ? 0 : -1; dr.gateRow = null
    if (o.press && Number.isFinite(o.grabX) && Number.isFinite(o.grabY)) {
      const e = entries.get(id), ms = e ? mountSocketFor(c) : null
      if (e) {
        if (ms) socketBody(e, ms, T0, T1, 0); else { T0[0] = e.m[12]; T0[1] = e.m[13]; T0[2] = e.m[14] }
        if (bodyToClient(T0[0], T0[1], T0[2], vp.canvas.getBoundingClientRect(), _cl)) { dr.offX = o.grabX - _cl.x; dr.offY = o.grabY - _cl.y }
      }
    }
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
    if (c.parent == null) { setStatus('warn', '根件不能重新放置。'); return false }
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
   * M 的镜面（§3.3.2）：卫星按件中心（包围盒中心，本体系）的主方向挑——±Y 侧 → XZ、±X 侧 → YZ、±Z 面上的件按所在安装面 / 接口的法向
   * （法向沿 ±X → YZ、沿 ±Y → XZ），挑不出退 XZ；飞机 / 船 / 车 / 地面站一律 XZ（纵向对称面）。
   */
  function mirrorOpFor(c) {
    if (doc.domain !== 'spacecraft') return 'mirrorXZ'
    const e = entries.get(c.id)
    if (!e) return 'mirrorXZ'
    let x = e.m[12], y = e.m[13], z = e.m[14]
    if (e.item && S.boxXform(e.item.box6, 0, e.m, 0, T0, 0)) { x = (T0[0] + T0[3]) / 2; y = (T0[1] + T0[4]) / 2; z = (T0[2] + T0[5]) / 2 }
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z), tol = 1e-6
    if (ay > ax + tol && ay >= az) return 'mirrorXZ'
    if (ax > ay + tol && ax >= az) return 'mirrorYZ'
    // ±Z 面上（或两向相当）：按安装面 / 接口的法向（父件位姿转到本体系）
    const pe = c.parent != null ? entries.get(c.parent) : null, a = c.attach
    let n = null
    if (pe && a) {
      if (a.socket && a.mode !== 'surface') { const s = pe.sockets.find((q) => q.id === a.socket); if (s) n = s.n } else if (a.face && a.mode !== 'socket') { const f = pe.faces.find((q) => q.id === a.face); if (f && f.kind !== 'cyl') n = f.n }
    }
    if (n && pe) {
      const M = pe.m, nx = Math.abs(M[0] * n[0] + M[4] * n[1] + M[8] * n[2]), ny = Math.abs(M[1] * n[0] + M[5] * n[1] + M[9] * n[2]), nz = Math.abs(M[2] * n[0] + M[6] * n[1] + M[10] * n[2])
      if (nx > ny + tol && nx > nz) return 'mirrorYZ'
      if (ny > nx + tol && ny > nz) return 'mirrorXZ'
    }
    return 'mirrorXZ'
  }
  /**
   * M：开 / 关选中件的镜像对称。功能区选了镜像档就用它；否则按 mirrorOpFor 挑镜面。镜面过本件（副本会压在原件上：applyCmd 以 code onLocus
   * 拒收）报「镜像面过本件。」；成功出状态短语「镜像 XZ」/「镜像 YZ」。根件不能镜像。
   */
  function mirror() {
    if (busy() || !sel.length) return false
    let d = doc, roots = 0, used = ''
    for (const id of sel) {
      const c = S.compById(d, id)
      if (!c) continue
      if (c.parent == null) { roots++; continue }
      let r = null
      if (c.sym) r = S.applyCmd(d, { type: 'setSym', id, sym: null })
      else {
        const op = symUi.op === 'mirrorXZ' || symUi.op === 'mirrorYZ' ? symUi.op : mirrorOpFor(c)
        r = S.applyCmd(d, { type: 'setSym', id, sym: { op } })
        if (!r.ok && r.code === 'onLocus') { setStatus('warn', '镜像面过本件。'); return false }
        if (r.ok) used = op
      }
      if (!r.ok) { setStatus('warn', r.error); return false }
      d = r.doc
    }
    if (roots && roots === sel.length) { setStatus('warn', '根件不能镜像。'); return false }
    if (d === doc) return false
    const ok = commitDoc('mirror', d, sel.slice())
    if (ok && used) setStatus('snap', used === 'mirrorYZ' ? '镜像 YZ' : '镜像 XZ', 3000)
    return ok
  }
  /** 件 parent 的面 f 的面心已被占着：折叠接口已占（按几何认，含对称派生件），或有件以面安装 / 面锚落在面心。 */
  function centerBusy(parent, g, f, used) {
    const fs = f.kind === 'cyl' ? null : S.foldedSocketOf(g, f.id)
    if (fs && used.has(`${parent.id}|${fs.id}`)) return true
    for (const c of doc.comps) {
      if (c.parent !== parent.id) continue
      const a = c.attach
      if (a && a.face === f.id && a.mode !== 'socket' && Array.isArray(a.uv) && Math.abs(a.uv[0]) < 1e-6 && Math.abs(a.uv[1]) < 1e-6) return true
    }
    return false
  }
  /**
   * 双击组件卡片快速添加：选中件（没选中则根件）上自动选位（专用接口 > 兼容空闲接口 > 面心没被占的可安装面面心，各取最朝向相机的那个）；
   * 选中件没有可用位置 → 退到父件 → … → 根件。空文档 = 根件，并取景。o.params = 常用型号卡片的型号参数（缺 = 缺省参数）。
   */
  function quickAdd(type, o = {}) {
    if (busy() || posePreview) return false
    const def = getComponent(type)
    if (!def) return false
    const params = o && o.params && typeof o.params === 'object' ? JSON.parse(JSON.stringify(o.params)) : {}
    let spec
    const wasEmpty = !doc.comps.length
    if (wasEmpty) spec = { type, parent: null }
    else {
      const root = doc.comps.find((c) => c.parent == null)
      const chain = []
      for (let id = sel.length ? sel[sel.length - 1] : (root ? root.id : null), g = 0; id != null && g < 1000; g++) {
        if (chain.includes(id)) break
        chain.push(id)
        const c = S.compById(doc, id)
        id = c ? c.parent : null
      }
      if (root && !chain.includes(root.id)) chain.push(root.id)
      const used = S.occupiedSocketKeys(doc, poses)
      let slot = null, pid = null
      for (const id of chain) {
        const parent = S.compById(doc, id)
        if (!parent || !entries.get(id)) continue
        const g = S.compGeo(parent)
        const socks = S.freeSocketsOf(doc, id, type, null, poses).filter((s) => !S.isFoldedSocket(g, s.id))
        const faces = g.faces.filter((f) => S.faceMountable(parent, f.id, type, g) && !centerBusy(parent, g, f, used))
        slot = autoSlot(id, type, socks, faces)
        if (slot) { pid = id; break }
      }
      if (!slot) { setStatus('warn', '无可用接口。'); return false }
      if (slot.socket) {
        const m = S.mountFor(def, params, slot.socket)
        spec = { type, parent: pid, attach: S.mkAttach({ mode: 'socket', socket: slot.socket.id, mount: m === def.mountSocket ? null : m }) }
      } else spec = { type, parent: pid, attach: S.mkAttach({ mode: 'surface', face: slot.face.id, uv: [0, 0] }) }
      if (!S.inSymSubtree(doc, pid)) spec.sym = S.symFromUi(symUi.op, symUi.n, doc.domain)
    }
    spec.params = params
    let r = S.addComp(doc, spec)
    if (!r.ok) { setStatus('warn', r.error); return false }
    // 与拖入同一判据：件的几何落在对称面 / 轴上（副本会压在原件上）这一次不带对称
    const c = S.compById(r.doc, r.id)
    if (c && c.sym && (S.symCoincides(r.doc, c) || S.socketSingle(r.doc, c))) { spec.sym = null; r = S.addComp(doc, spec) }
    commitDoc('add', r.doc, [r.id])
    sel = []; select([r.id])
    if (wasEmpty && attached) fitView()
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
    armPress(ev)
  }

  // ── 按住选中件本体拖 = 重新放置（按下拖动式拾起，Onshape / KSP 手感）──
  // 只认单选、非根、未锁、可见的主件，且按下点落在它自己身上、不在 gizmo 手柄上：这一下不交给轨道控件 / gizmo / 视口点选
  // （捕获阶段 stopImmediatePropagation，它们都挂在 canvas 上），越过 DRAG_START_PX 才开始拖；没越过就松手 = 一次点击
  // （Ctrl / ⌘ 切换选择，其余保持选中）。拖空处 / 没选中的件照旧转视角。
  const press = { on: false, id: '', x: 0, y: 0, pid: -1, toggle: false, t0: 0 }
  function movableSel() {
    if (sel.length !== 1 || posePreview) return null
    const c = S.compById(doc, sel[0])
    return c && c.parent != null && !c.locked && !c.hidden ? c.id : null
  }
  function armPress(ev) {
    if (ev.button !== 0 || !attached || dr.active || gz.active || press.on || ev.altKey) return
    // gizmo 的悬停轴只在指针移动时更新：按下这一刻先按当前指针重算一遍（它自己的 pointerdown 也是先 hover 再 down），压在手柄上就归 gizmo
    if (tc && tc.object && tc.enabled) {
      const r = vp.canvas.getBoundingClientRect()
      try { tc.pointerHover({ x: ((ev.clientX - r.left) / r.width) * 2 - 1, y: -((ev.clientY - r.top) / r.height) * 2 + 1, button: 0 }) } catch { /* 无 */ }
    }
    if (tc && tc.object && tc.axis !== null) return
    const id = movableSel()
    if (!id) return
    const e = entryAt(ev.clientX, ev.clientY)
    if (!e || e.id !== id) return
    ev.stopImmediatePropagation(); ev.preventDefault()
    press.on = true; press.id = id; press.x = ev.clientX; press.y = ev.clientY; press.pid = ev.pointerId; press.toggle = ev.ctrlKey || ev.metaKey; press.t0 = performance.now()
    try { vp.canvas.setPointerCapture(ev.pointerId) } catch { /* 无 */ }
    vp.killInertia()
    window.addEventListener('pointermove', onPressMove, true)
    window.addEventListener('pointerup', onPressUp, true)
    window.addEventListener('pointercancel', onPressCancel, true)
  }
  function endPress(release) {
    if (release && press.pid >= 0) { try { vp.canvas.releasePointerCapture(press.pid) } catch { /* 已经放了 */ } }
    press.on = false
    window.removeEventListener('pointermove', onPressMove, true)
    window.removeEventListener('pointerup', onPressUp, true)
    window.removeEventListener('pointercancel', onPressCancel, true)
  }
  function onPressMove(ev) {
    if (!press.on || ev.pointerId !== press.pid) return
    const dx = ev.clientX - press.x, dy = ev.clientY - press.y
    if (dx * dx + dy * dy < S.DRAG_START_PX * S.DRAG_START_PX) return
    const id = press.id, gx = press.x, gy = press.y, pid = press.pid, t0 = press.t0
    endPress(false)
    lastPtr.x = ev.clientX; lastPtr.y = ev.clientY; lastPtr.in = true
    if (!S.compById(doc, id) || busy() || !startPickup(id, 'reattach', JSON.stringify(doc), { press: true, grabX: gx, grabY: gy, pointerId: pid, t0 })) {
      try { vp.canvas.releasePointerCapture(pid) } catch { /* 无 */ }
      return
    }
    dr.pending = true
    vp.invalidate()
  }
  function onPressUp(ev) {
    if (!press.on || ev.pointerId !== press.pid) return
    const id = press.id, toggle = press.toggle
    endPress(true)
    if (toggle) select([id], { toggle: true })
  }
  function onPressCancel(ev) { if (press.on && ev.pointerId === press.pid) endPress(true) }
  /** 指针停在选中的可挪件上 → canvas 光标「grab」（这一件按住能拖）；别处恢复。 */
  let cursorNow = ''
  function updateCursor() {
    const want = attached && !dr.active && !gz.active && !!hoverId && hoverId === movableSel() ? 'grab' : ''
    if (want === cursorNow) return
    cursorNow = want
    vp.canvas.style.cursor = want
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
    updateCursor()
  }
  /**
   * 视口右键菜单在 contextmenu 事件里开（不在 pointerup 里）：Windows 上 contextmenu 在 mouseup 之后才派发，pointerup 里先开了菜单，
   * 随后这个 contextmenu 落到刚插进来的菜单遮罩上、把菜单当场关掉。右键拖（> 5 px，平移视角）不开；键盘菜单键（button ≠ 2）不开。
   */
  function onCanvasCtx(ev) {
    ev.preventDefault()
    if (ev.button !== 2 || down.b !== 2 || dr.active || gz.active || performance.now() < ctxMuteUntil) return
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
    // gizmo 拖动中屏蔽：Ctrl+Z / Ctrl+Y（撤销）、Ctrl+D（复制）、Ctrl+Tab / Ctrl+W（文档签）、Delete / Backspace（删除）
    if (gz.active && ev.type === 'keydown') {
      const k = String(ev.key || '').toLowerCase(), mod = ev.ctrlKey || ev.metaKey
      if ((mod && (k === 'z' || k === 'y' || k === 'd' || k === 'tab' || k === 'w')) || k === 'delete' || k === 'backspace') { ev.preventDefault(); ev.stopPropagation(); return }
    }
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
    updateCursor()
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
    if (curDirty) { curDirty = false; emit('cursor', CUR) }
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
    if (press.on) endPress(true)
    finishDrag(false)
    unmuteCtx()
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
    cursorNow = ''; vp.canvas.style.cursor = ''
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

  /**
   * 载入文档。o.state（文档签换回来时的暂存，getState 的结果）：撤销栈 + 指针、选择、相机一起还原，不取景；
   * 没有 state：撤销栈清空、无选择、o.fit !== false 时取景。
   */
  function load(d, o = {}) {
    if (dr.active) finishDrag(false)
    doc = normalizeAssembly(d)
    hist.length = 0; hptr = 0
    sel = []; hoverId = null; lastSelKey = ''
    const s = o.state && typeof o.state === 'object' ? o.state : null
    if (s) {
      // 条目浅拷（before / after 串共用）；合并键与时间戳作废：还原后的第一笔提交不与暂存前那一笔合并
      if (Array.isArray(s.hist)) for (const h of s.hist) if (h && typeof h.before === 'string' && typeof h.after === 'string') hist.push({ label: h.label, before: h.before, after: h.after, key: null, at: 0 })
      hptr = Math.max(0, Math.min(hist.length, Math.trunc(Number(s.hptr)) || 0))
      if (Array.isArray(s.sel)) for (const id of s.sel) if (typeof id === 'string' && S.compById(doc, id) && !sel.includes(id)) sel.push(id)
    }
    clearStatus()   // 上一份文档的告警 / 吸附 / 穿插状态不挂到新文档上
    if (attached) vp.setDisplayUp(doc.domain)
    sync('load', [])
    lastSelKey = sel.join(',')
    emit('select', { ids: sel.slice(), primary: sel.length ? sel[sel.length - 1] : null })
    emitMode()
    if (s && s.view) { if (attached) vp.setViewState(s.view); else savedView = { ...s.view } }
    else if (o.fit !== false && attached) fitView()
    // 换文档：模块级生成缓存的重层（网格 JS 数组）不再留上一份文档的——几何已在本编辑器的几何缓存里；轻层（质量合成用）照留
    clearBuildCache({ heavyOnly: true })
  }
  /** 取景：有件走视口「自动」视角；空文档看原点附近 ±3 m（地面网格与第一件的落点都在画面里）。 */
  function fitView() {
    if (list.length) vp.setView('auto')
    else vp.focusBody([0, 0, 0], 3, 'iso')
  }
  function getDoc() { return JSON.parse(JSON.stringify(doc)) }
  /**
   * 文档签换下时的暂存（配 load(doc, {state}) 还原）：撤销栈（条目浅拷，before / after 串共用）+ 指针、选择、相机。
   * 拖动 / 放置途中取的是已提交的那份（拖动本身不进暂存）；没挂上视口时相机取 detach 时记下的那份。
   * @returns {{hist:{label:string, before:string, after:string}[], hptr:number, sel:string[], view:object|null}}
   */
  function getState() {
    return {
      hist: hist.map((h) => ({ label: h.label, before: h.before, after: h.after })),
      hptr,
      sel: sel.slice(),
      view: attached ? vp.viewState() : (savedView ? { ...savedView } : null)
    }
  }
  /** 某件的本体系位姿（编辑器解算表里拷 16 个数；没有 null）。属性面板的位置读数用它，不自己对冻结快照 solvePose。 */
  function poseOf(id) { const p = poses.get(id); return p ? Array.from(p.m) : null }
  /**
   * 拖动中被拖件的实时量（小对象，UI 15 Hz 取；不深拷整份文档）：{id, parent, attach（含 off / tilt）, t, q, m（本体系位姿）, pm（父件位姿）,
   * step（当前生效的平移网格步长，米）}。被拖的不是这一件 / 没在拖：null。
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
      attach: {
        mode: a.mode, socket: a.socket, face: a.face, uv: Array.isArray(a.uv) ? a.uv.slice() : null, roll: a.roll, mount: a.mount,
        off: Array.isArray(a.off) ? a.off.slice() : [0, 0, 0], tilt: Array.isArray(a.tilt) ? a.tilt.slice() : [0, 0]
      },
      t: Array.isArray(c.t) ? c.t.slice() : null, q: Array.isArray(c.q) ? c.q.slice() : null,
      m: p ? Array.from(p.m) : null, pm: q ? Array.from(q.m) : null,
      step: moveStep()
    }
  }
  /** 当前生效的平移网格步长（米；吸附关 0）：拖动中按落点面、gizmo 拖动中按下时定的那一档、其余按选中件的锚（'auto' 档的读数）。 */
  function moveStep() {
    if (dr.active) return dr.stepFace ? dr.step : selStep()
    if (gz.active) return gz.step
    return selStep()
  }
  /**
   * 写安装语义（属性面板「安装」节：偏移 / 倾角 / 安装端 / 接口 / 面 …）：applyCmd setAttach（patch 只含要改的键，off / tilt 整组给），
   * 可撤销；o.mergeKey 给了时同键 500 ms 内合并成一条撤销（数字框连续输入）。拖动中拒收。
   * @param {string} id
   * @param {object} patch {mode?, socket?, face?, uv?, roll?, mount?, off?, tilt?}
   * @param {{mergeKey?:string, t?:number[], q?:number[]}} [o]
   * @returns {{ok:boolean, error?:string}}
   */
  function setAttach(id, patch, o = {}) {
    if (busy()) return { ok: false, error: '正在拖动。' }
    const cmd = { type: 'setAttach', id, attach: patch && typeof patch === 'object' ? patch : {} }
    if (Array.isArray(o.t)) cmd.t = o.t
    if (Array.isArray(o.q)) cmd.q = o.q
    const r = S.applyCmd(doc, cmd)
    if (!r.ok) { setStatus('warn', r.error); return { ok: false, error: r.error } }
    if (r.changed) commitDoc('setAttach', r.doc, r.ids, typeof o.mergeKey === 'string' && o.mergeKey ? o.mergeKey : undefined)
    if (r.symDropped && r.symDropped.length) setStatus('warn', `${r.symDropped.map(nameOf).join('、')} 已取消对称。`)
    return { ok: true }
  }
  /**
   * 方向键微调选中件（2026-10-07）：←→ / ↑↓ 沿安装锚系（接口系 / 面系(uv) / 自由件的锚系或父件系）两根面内轴里屏上方向最接近的那根
   * 走一格（selStep 的生效步长；吸附关或步长为 0 时 1 cm；fine = Shift 取 1/10），PageUp / PageDown 沿锚系法向（离开 / 压向父件）。
   * 接口件写 off、面安装件写 uv（夹在面内）/ off[2]、自由件写 t；落到该步长的网格线上（snapTo）。同件同键 500 ms 内合并成一条撤销。
   * 根件 / 锁定件 / 多选 / 拖动中不动，返回 false。
   * @param {'left'|'right'|'up'|'down'|'pageup'|'pagedown'} dir
   * @param {boolean} [fine]
   */
  function nudge(dir, fine) {
    if (busy() || posePreview || sel.length !== 1) return false
    const c = S.compById(doc, sel[0])
    if (!c || c.parent == null) return false
    if (c.locked) { setStatus('warn', '件已锁定。'); return false }
    const pe = entries.get(c.parent)
    if (!pe || !pe.poseM || !pe.geo) return false
    let step = selStep()
    if (!(step > 0)) step = 0.01
    if (fine) step /= 10
    // 锚系三根轴（本体系）= 父件位姿 · 锚系
    S.anchorFrame(T0, c, pe.geo)
    S.m4Mul(T1, pe.poseM, T0)
    let ax = 2, sg = dir === 'pageup' ? 1 : -1
    if (dir !== 'pageup' && dir !== 'pagedown') {
      // 面内两根轴投到屏上（相机视空间的 x / y 分量占比）：水平键挑水平占比大的、竖直键挑竖直占比大的（挑到同一根时竖直键换另一根）
      for (let k = 0; k < 2; k++) {
        const x = T1[4 * k], y = T1[4 * k + 1], z = T1[4 * k + 2]
        _v.set(D[0] * x + D[4] * y + D[8] * z, D[1] * x + D[5] * y + D[9] * z, D[2] * x + D[6] * y + D[10] * z).transformDirection(vp.camera.matrixWorldInverse)
        const l = Math.hypot(_v.x, _v.y) || 1
        NV[2 * k] = _v.x / l; NV[2 * k + 1] = _v.y / l
      }
      const kh = Math.abs(NV[0]) >= Math.abs(NV[2]) ? 0 : 1
      let kv = Math.abs(NV[1]) >= Math.abs(NV[3]) ? 0 : 1
      if (kv === kh) kv = 1 - kh
      const horiz = dir === 'left' || dir === 'right', want = dir === 'right' || dir === 'up' ? 1 : -1
      ax = horiz ? kh : kv
      sg = (horiz ? NV[2 * ax] : NV[2 * ax + 1]) >= 0 ? want : -want
    }
    const d = sg * step, key = `nudge|${c.id}|${dir}`, a = c.attach
    if (a.mode === 'socket' || (a.mode === 'surface' && ax === 2)) {
      const off = Array.isArray(a.off) ? a.off.slice() : [0, 0, 0]
      off[ax] = S.snapTo(off[ax] + d, step)
      return setAttach(c.id, { off }, { mergeKey: key }).ok
    }
    if (a.mode === 'surface') {
      const uv = Array.isArray(a.uv) ? a.uv.slice() : [0, 0]
      uv[ax] = S.snapTo(uv[ax] + d, step)
      const f = pe.faces.find((x) => x.id === a.face)
      if (f) { const io = { u: uv[0], v: uv[1] }; S.clampIO(f, io); uv[0] = io.u; uv[1] = io.v }
      return setAttach(c.id, { uv }, { mergeKey: key }).ok
    }
    const t = Array.isArray(c.t) ? c.t.slice() : [0, 0, 0]
    t[ax] = S.snapTo(t[ax] + d, step)
    return setAttach(c.id, {}, { mergeKey: key, t, q: Array.isArray(c.q) ? c.q.slice() : [0, 0, 0, 1] }).ok
  }
  const NV = new Float64Array(4)

  // ═════════════════════════ 工具状态 ═════════════════════════
  function setTool(t) { if (!TOOLS.includes(t) || t === tool) return; tool = t; if (!gz.active) configureGizmo(); emitMode() }
  function setSpace(s) { if (!SPACES.includes(s) || s === space) return; space = s; if (!gz.active) configureGizmo(); emitMode() }
  /** 吸附设置：on、move（平移步长：'auto' 或 MOVE_STEPS 里的米数）、rotate（ROT_STEPS）。生效步长变了发 'step'。 */
  function setSnap(o = {}) {
    if (typeof o.on === 'boolean') snap.on = o.on
    if (o.move === 'auto') snap.move = 'auto'
    else if (S.MOVE_STEPS.includes(Number(o.move))) snap.move = Number(o.move)
    if (S.ROT_STEPS.includes(Number(o.rotate))) snap.rotate = Number(o.rotate)
    if (tc && gz.id) tc.rotationSnap = gz.mode === 'free' && snap.on && !shiftDown ? snap.rotate * D2R : null
    if (dr.active) { dr.stepFace = null; dr.pending = true; vp.invalidate() }
    if (gz.id && !gz.active) configureGizmo()
    else if (!dr.active && !gz.active) emitStep(selStep())
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
  function keyName(key) {
    if (key === KEY_ROOT) return 'root'
    if (key >= KEY_SOCK && key < KEY_FACE) { const i = key - KEY_SOCK, e = dr.cE[i], s = dr.cS[i]; return e && s ? `socket:${e.id}|${s.id}` : `socket:?${i}` }
    if (key >= KEY_FACE && key < KEY_FREE) { const k = key - KEY_FACE, idx = Math.floor(k / 64), fi = k - 64 * idx, e = list[idx]; const f = e ? e.faces[fi] : null; return e && f ? `face:${e.id}|${f.id}` : `face:?${k}` }
    if (key >= KEY_FREE && key < KEY_ROOT) { const e = list[key - KEY_FREE]; return `free:${e ? e.id : '?'}` }
    return String(key)
  }
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
    /** 验证台：本体系任意点 → 屏幕坐标（在相机后面 null）。 */
    bodyClient(bx, by, bz) { return client(bx, by, bz) },
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
        cache: cache.stats(), fx: fx.count, status: { ...curStatus },
        cursor: { ...CUR }, step: moveStep(), snapMove: snap.move,
        lock: { on: lock.on, i: lock.i, n: lock.n, key: lock.key }, list: Array.from(LK.subarray(0, ln)).map(keyName),
        mounts: dr.active ? dr.mounts.map((m) => m.id) : [], mountIdx: dr.active ? dr.mountIdx : -1
      }
    },
    /** 验证台：拖动中的候选接口（下标、所属主件、接口 id、是否专用）。 */
    cands() { return dr.active ? dr.cS.map((s, i) => ({ i, pid: dr.cE[i].pid, entry: dr.cE[i].id, socket: s.id, ded: !!dr.cDed[i] })) : [] },
    /** 验证台：候选键 → 可读名（socket:件|接口 / face:件|面 / free:件 / root）。 */
    keyName,
    entries() { return list.map((e) => ({ id: e.id, pid: e.pid, k: e.k, prefix: e.prefix, parent: e.parentId, visible: e.visible, invalid: e.invalid, tris: e.item ? e.item.tris : 0, nodes: e.group.children.length })) }
  }

  rebuildEntries()   // 空文档也把读数用的打包数组备好

  return {
    attach, detach, dispose,
    load, getDoc, getState, poseOf, liveOf, moveStep, setAttach, nudge, apply, replaceDoc,
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
