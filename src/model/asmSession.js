// 装配会话（P3，契约 scratchpad p3/CONTRACT.md §6.6）：ModelApp 建一份、provide('asm')。
// 2026-10 起没有独立的「装配」页签：设计页激活的是装配签（wb.designAsm()）时本会话激活，激活的是模型签 / 没有签时休眠。
//
// 分工：
//   · 文档与交互全在编辑器（src/viz/models/assemblyEditor.js，第一次进装配视图才建）；本会话只做四件事：
//     ① 进出装配视图时借还视口（wb.lendViewport / reclaimViewport）并 attach / detach 编辑器；
//     ② 把编辑器事件落进一份响应式 ui（树 / 属性 / 功能区 / 读数只读它）：stats / drag 节流到 ≤ 15 Hz，松手后精确一次；
//     ③ 编辑器跟着激活签走（2026-10-06 文档标签条）：换到另一个装配签时，编辑器里那份的状态（撤销栈 / 选择 / 相机 / 对称档 / 初值姿态）
//        暂存回它的 DocState（wb.stashDoc），再载入新签（有暂存按暂存还原，否则按它最近一次提交、取景、对称缺省（飞机「镜像 XZ」、
//        其余「无」）、零位）；
//        每次提交交给 wb，按「编辑器里载着的是哪份文档」回写（草稿 + 自动入库）；那份文档的内容被整份换掉（「另存副本并还原原件」，
//        wb.docEpoch 变了）之后编辑器里的旧版本作废：不暂存、提交不回写，换上它时按新内容重载；
//     ④ 驱动装配件（drive.mjs）：快速设置改驱动参数 → 三方合并 → 编辑器整文档替换（一步撤销）；联动参数直写驱动参数；
//        删除对应整星列表条目的件 = 删条目（关联支架 / 展开臂随之去掉）。
//   · 编辑器对象 markRaw、放在响应式之外（three 对象挂满全身，Vue 深代理会把它弄坏）。编辑器模块（TransformControls / BVH 求交 …）
//     第一次进装配页才动态 import：没用过装配页的窗口不为它付加载与解析的代价。
//   · 快捷键（§5.5）在这里分发：守卫 = 设计页的装配视图（wb.designAsm()）；焦点在输入框 / 下拉 / 可编辑区 / 表格里、输入法组字中、事件已被处理（树的
//     Delete / 回车）时一律不管。1 / 3 / 7 / 0 视角与 F 取景仍归 ModelApp（F 在装配页转给 frameSelection）。
//   · 工具状态（吸附 / 坐标系 / 栏宽 …）存 localStorage model/asm/ui（便利数据，坏了回缺省）。对称档与初值姿态不进本机记忆：
//     只在签内有效（随暂存走），新签缺省对称「无」（飞机「镜像 XZ」）、「零位」。
import { reactive, shallowRef, markRaw, watch } from 'vue'
import { theme } from '../stores/theme.js'
import { curLang, byLang } from '../shared/i18n/lang.js'
import { UI_KEY, sanitizeUi, nextSpace, subtreeIds, compById, compLabel } from './asmLogic.js'
import { trimHistory } from './wbLogic.js'
import { clearBuildCache } from '@core/models/assembly.mjs'
import { removeComps } from '@core/models/asmSnap.mjs'
import { isDriven, rebaseDrive, writeThrough, driveRemove, resetToBase, detachDrive, resetAllOverrides, restoreSuppressed } from '@core/models/drive.mjs'

const errText = (e) => (e && e.message) || String(e)
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const UI_HZ_MS = 66   // 拖动中 UI 读数 / 属性面板刷新间隔（≤ 15 Hz）
const SYM_DEFAULT = Object.freeze({ op: 'none', n: 2 })   // 新签的对称档
// 飞机装配件新签缺省「镜像 XZ」（2026-10-07）：机翼 / 平尾 / 翼吊发动机几乎总是成对，落在中线上的件（垂尾、平尾、背部罩、颔部光电球）
// 编辑器按几何自动不带对称（onSymLocus），所以缺省开着只省事、不出错
const SYM_AIRCRAFT = Object.freeze({ op: 'mirrorXZ', n: 2 })
const symDefaultFor = (d) => ({ ...(d && d.domain === 'aircraft' ? SYM_AIRCRAFT : SYM_DEFAULT) })
// 换下的装配签只留最近这么多步撤销（多签常驻的撤销栈全是整份文档 JSON；激活签自己的栈上限照编辑器的 UNDO_CAP）
const STASH_HIST_MAX = 30
// 方向键微调（编辑器 nudge）：键名（小写）→ 方向
const NUDGE_KEYS = Object.freeze({ arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down', pageup: 'pageup', pagedown: 'pagedown' })

/**
 * @param {{wb:object, getVp:()=>object|null, ov?:object}} o
 */
export function createAsmSession({ wb, getVp }) {
  const { st } = wb
  const prefs = (() => { try { return sanitizeUi(JSON.parse(localStorage.getItem(UI_KEY) || 'null')) } catch { return sanitizeUi(null) } })()

  const ui = reactive({
    ready: false, active: false,
    tool: prefs.tool, space: prefs.space, snap: { ...prefs.snap }, sym: { ...SYM_DEFAULT },
    posePreview: false, showCom: prefs.showCom, showSockets: prefs.showSockets, showAxes: prefs.showAxes, posFrame: prefs.posFrame,
    selIds: [], primary: null, canUndo: false, canRedo: false,
    mode: 'idle', status: { kind: '', text: '' }, dragging: false, dragKind: '',
    dragTarget: '',   // 拖入 / 拾起中落点所在的件（主件 id；结构树对应行高亮）
    invalid: {},
    stats: { count: 0, tris: 0, massKg: 0, com: [0, 0, 0], inertiaDiag: [0, 0, 0], inertia: null, bbox: [0, 0, 0, 0, 0, 0], clashes: 0, invalid: 0, massWarn: '' },
    dockW: prefs.dockW, split: prefs.split, libQ: prefs.libQ, secOpen: { ...prefs.secOpen },
    ctx: null,        // 右键菜单 {ids, x, y}（树 / 视口共用一份）
    live: null,       // 拖动中被拖件（且是选中件）的实时量 {id, parent, attach, t, q, m, pm}（编辑器 liveOf：小对象，不深拷整份文档）
    renaming: '',     // 结构树里正在改名的件
    // 光标读数（编辑器 cursor 事件，拖动中逐帧）：指针右下的「目标件 · 接口 / 面 · 推断 · i/n · 滚转°」；只有 asm/AsmCursor.vue 读它
    cursor: { on: false, x: 0, y: 0, text: '' },
    step: null        // 平移网格的生效步长读数（编辑器 step 事件 {move: 设置值 'auto' | 米, m: 生效米数}）
  })
  const doc = shallowRef(null)     // 编辑器最近一次提交的冻结快照（树 / 属性面板只读它）
  let editor = null
  const offs = []
  let started = false, attached = false, loadSeq = 0, loadSeen = -1
  // 编辑器里现在载着哪份文档（DocState 对象；按对象认、不按 id：关签后同 id 重开是另一份，另存换 id 后还是这一份）。
  // 编辑器的 change / invalid 事件一律回写到它，不看此刻激活的是哪个签
  let loaded = null
  // 载入时那份文档的内容代次（wb.docEpoch）：「另存副本并还原原件」把原件内容整份换掉时代次 +1，编辑器里的旧版本作废——
  // 不再暂存它、提交不再回写，换上它时按新内容重载
  let loadedEpoch = -1
  const fresh = () => !!loaded && wb.docEpoch(loaded) === loadedEpoch
  let switchMs = 0                 // 最近一次装配签互切（暂存 + 载入）的耗时（验证台读数）

  // ── 工具状态落盘（防抖；对称档与初值姿态不落盘，只在签内有效）──
  let prefT = 0
  watch(() => [ui.tool, ui.space, ui.snap.on, ui.snap.move, ui.snap.rot, ui.dockW, ui.split, ui.libQ, ui.showCom, ui.showSockets, ui.showAxes, ui.posFrame, JSON.stringify(ui.secOpen)], () => {
    clearTimeout(prefT)
    prefT = setTimeout(() => {
      const v = { tool: ui.tool, space: ui.space, snap: plain(ui.snap), dockW: ui.dockW, split: ui.split, libQ: ui.libQ, secOpen: plain(ui.secOpen), showCom: ui.showCom, showSockets: ui.showSockets, showAxes: ui.showAxes, posFrame: ui.posFrame }
      try { localStorage.setItem(UI_KEY, JSON.stringify(v)) } catch { /* 便利数据 */ }
    }, 300)
  })

  // ── 状态行（运行时状态）──
  // 编辑器发来的状态（吸附 / 穿插 / 命令告警）由编辑器自己管时长（告警 4 s 后编辑器清、再发一次空状态）；本会话自己的短语（模块加载失败、
  // 命令抛错）按 ms 清，清的时候顺手让编辑器也清掉同一条（两边不留一边清了一边还记着的旧值：否则同一条告警第二次会被编辑器的去重吞掉）
  let statusT = 0
  function setStatus(kind, text, ms = 0) {
    clearTimeout(statusT); statusT = 0
    ui.status = { kind: kind || '', text: text || '' }
    // 会话这边清空（Esc / 程序性清除）：编辑器那边同步清，免得它还记着旧告警、同一条第二次被去重吞掉
    if (!text && editor && typeof editor.clearStatus === 'function') { try { editor.clearStatus() } catch { /* 无 */ } }
    if (ms > 0) {
      statusT = setTimeout(() => {
        statusT = 0
        if (ui.status.text !== text) return
        ui.status = { kind: '', text: '' }
        if (editor && typeof editor.clearStatus === 'function') { try { editor.clearStatus(text) } catch { /* 无 */ } }
      }, ms)
    }
  }

  // ── 读数节流：拖动中 ≤ 15 Hz，其余即时 ──
  let statsSrc = null, statsT = 0
  function flushStats() {
    clearTimeout(statsT); statsT = 0
    const s = statsSrc
    if (!s) return
    const o = ui.stats
    o.count = s.count | 0; o.tris = s.tris | 0; o.massKg = Number(s.massKg) || 0
    o.com = [s.com[0], s.com[1], s.com[2]]
    o.inertiaDiag = [s.inertiaDiag[0], s.inertiaDiag[1], s.inertiaDiag[2]]
    o.inertia = Array.isArray(s.inertia) ? s.inertia.map((r) => Array.from(r)) : null
    o.bbox = Array.from(s.bbox)
    o.clashes = s.clashes | 0; o.invalid = s.invalid | 0
    if (o.massWarn !== (s.massWarn || '')) o.massWarn = s.massWarn || ''
  }
  function onStats(s) {
    statsSrc = s
    if (ui.dragging) { if (!statsT) statsT = setTimeout(flushStats, UI_HZ_MS) } else flushStats()
  }
  // 拖动中属性面板的实时量：只取被拖件的安装量与位姿（编辑器 liveOf，小对象；≤ 15 Hz）。结构类选项（父件 / 插座 / 面 / 参数行）
  // 不跟着拖动重算——拖动中只有安装量与位姿在变
  let liveT = 0, liveId = null
  function flushLive() {
    liveT = 0
    if (!ui.dragging || !editor || !liveId || !ui.selIds.includes(liveId)) { if (ui.live) ui.live = null; return }
    let v = null
    try { v = editor.liveOf(liveId) } catch { v = null }
    ui.live = v ? Object.freeze(v) : null
  }
  function onDrag(d) {
    if (!d) return
    if (d.phase === 'start') {
      ui.dragging = true; ui.dragKind = d.kind || ''; liveId = d.id || null
      ui.dragTarget = ''
      wb.asmSetDragging(true)
    } else if (d.phase === 'move') {
      liveId = d.id || liveId
      const tg = d.kind === 'gizmo' ? '' : (d.target || '')
      if (ui.dragTarget !== tg) ui.dragTarget = tg
      if (!liveT) liveT = setTimeout(flushLive, UI_HZ_MS)
    } else {
      ui.dragging = false; ui.dragKind = ''; ui.dragTarget = ''
      clearTimeout(liveT); liveT = 0; liveId = null; ui.live = null
      wb.asmSetDragging(false)
      flushStats()
    }
  }

  function wire(ed) {
    const on = (name, fn) => { try { const off = ed.on(name, fn); if (typeof off === 'function') offs.push(off) } catch (e) { console.warn('[asm] 订阅 ' + name + '：' + errText(e)) } }
    on('change', (e) => {
      if (!e || !e.doc) return
      doc.value = e.doc
      if (e.reason === 'load') { loadSeen = loadSeq; if (loaded) wb.asmAdopt(e.doc, e.json, loaded) }
      else if (e.changed !== false && fresh()) wb.asmCommit(e.doc, e.json, loaded)   // Esc 取消 / 点了手柄没拖 / 原地放下：只换快照，不算一次提交
      // 选中件被删掉了（撤销 / 删除）：选择由编辑器发 select 事件，这里只防树上还挂着改名框
      if (ui.renaming && !e.doc.comps.some((c) => c.id === ui.renaming)) ui.renaming = ''
    })
    on('select', (e) => { ui.selIds = e && Array.isArray(e.ids) ? e.ids.slice() : []; ui.primary = (e && e.primary) || null })
    on('stats', onStats)
    on('drag', onDrag)
    on('status', (s) => { if (s) setStatus(s.kind, s.text) })   // 时长由编辑器管（见 setStatus 注释）
    on('history', (h) => { ui.canUndo = !!(h && h.canUndo); ui.canRedo = !!(h && h.canRedo) })
    on('mode', (m) => { if (m && m.state) ui.mode = m.state })
    on('context', (c) => { if (c) ui.ctx = { ids: Array.isArray(c.ids) ? c.ids.slice() : [], x: c.clientX, y: c.clientY } })
    // 光标读数：编辑器每帧复用同一个对象发，这里逐字段拷（文字没变不写，免得读数组件白白重排）
    on('cursor', (c) => {
      const u = ui.cursor
      if (!c || !c.on) { if (u.on) u.on = false; return }
      if (u.x !== c.x) u.x = c.x
      if (u.y !== c.y) u.y = c.y
      if (u.text !== c.text) u.text = c.text
      if (!u.on) u.on = true
    })
    on('step', (s) => { ui.step = s && typeof s === 'object' ? { move: s.move, m: Number(s.m) || 0 } : null })
    on('invalid', (e) => { const by = (e && e.byId) || {}; ui.invalid = plain(by); if (fresh()) wb.asmSetInvalid(Object.keys(by).length, loaded) })
  }
  // 编辑器桥（wb 不直接碰编辑器）：另存副本时取原签在编辑器里的相机 / 选择 / 对称档 / 初值姿态；模板签分叉后出状态短语
  wb.setEditorBridge({
    stateOf(d) {
      if (d && d === loaded && fresh() && editor) {
        let s = null
        try { s = editor.getState() } catch { s = null }
        return s ? { sel: s.sel, view: s.view, sym: { ...ui.sym }, posePreview: ui.posePreview } : null
      }
      const k = d && d.stash
      return k && k.state ? { sel: k.state.sel || [], view: k.state.view || null, sym: k.sym || null, posePreview: !!k.posePreview } : null
    },
    // 分叉发生在提交路径上：等编辑器把这次提交自己的状态（吸附结果 / 穿插告警）发完再出；状态片被占着就出在功能区状态区，不盖告警
    forked(d) {
      const msg = byLang('已创建副本。', 'Copy created.')
      setTimeout(() => { if (d === loaded && ui.active && !ui.status.text) setStatus('', msg, 3000); else wb.toast(msg) }, 0)
    }
  })
  /** 视口外的屏幕点落在结构树哪一行（拖入 / 拾起时指针移到树行上 = 装到那一件）；不在行上 null。 */
  function treeRowAt(x, y) {
    const el = document.elementFromPoint(x, y)
    const row = el && el.closest ? el.closest('.asm-tree .asm-tr[data-id]') : null
    return row ? row.getAttribute('data-id') : null
  }
  let edLoad = null
  async function ensureEditor() {
    if (editor) return editor
    const vp = getVp()
    if (!vp) return null
    if (!edLoad) edLoad = import('../viz/models/assemblyEditor.js')
    let mod
    try { mod = await edLoad } catch (e) { edLoad = null; console.error('[asm] 编辑器模块：', e); setStatus('error', errText(e), 6000); return null }
    if (editor) return editor
    editor = markRaw(mod.createAssemblyEditor(vp, { theme: theme.resolved === 'dark' ? 'dark' : 'light', lang: () => (curLang() === 'en' ? 'en' : 'zh'), targetAt: treeRowAt }))
    wire(editor)
    return editor
  }
  /** 工具状态推给编辑器（attach 之后、换文档之后都推一遍：编辑器不记 UI 偏好） */
  function pushPrefs(ed) {
    try {
      ed.setTool(ui.tool); ed.setSpace(ui.space)
      ed.setSnap({ on: ui.snap.on, move: ui.snap.move, rotate: ui.snap.rot })
      ed.setSym({ op: ui.sym.op, n: ui.sym.n })
      ed.setShowCom(ui.showCom); ed.setShowSockets(ui.showSockets)
      if (typeof ed.setShowAxes === 'function') ed.setShowAxes(ui.showAxes)
      ed.setPosePreview(ui.posePreview)
    } catch (e) { console.warn('[asm] 工具状态：' + errText(e)) }
  }

  // ── 页签进出 / 换签 ──
  async function activate() {
    if (ui.active) return
    const vp = getVp()
    if (!vp) return
    ui.active = true
    wb.lendViewport('asm')
    const ed = await ensureEditor()
    if (!ed || !ui.active) return   // 等编辑器模块期间又切走了：deactivate 已还视口
    // attach 抛了也按「已借上」处理：它多半只是某个叠加件没建起来，live 根与指针钩子已经挂上；
    // 当成没挂上的话之后的文档一份也载不进来，整页卡在空文档（detach 照样会调，钩子撤得掉）
    try { ed.attach() } catch (e) { console.error('[asm] attach：', e) } finally { attached = true }
    pushPrefs(ed)
    ui.ready = true
    syncDoc()
    flushQueuedAdd()
  }
  /**
   * 离开装配视图（切到模型签 / 关掉最后一个装配签 / 离开设计页）：detach 编辑器（文档留在里面休眠，换回同一签不重载）、还视口。
   * 离开设计页才立即入库（库 / 导出页要看到最新的）；签之间切换只写草稿（wb.activateDoc 已写），排着的自动入库照常在后台跑。
   */
  function deactivate() {
    if (!ui.active) return
    ui.active = false
    ui.ctx = null; ui.renaming = ''
    if (editor && attached) { try { editor.detach() } catch (e) { console.error('[asm] detach：', e) } }
    attached = false
    if (st.tab !== 'design' && wb.isDocOpen(loaded)) wb.flushDocSave(loaded)
    wb.reclaimViewport()
    // 模块级生成缓存（网格数组住在 JS 堆里）不在离开装配页之后常驻；编辑器解算计划里的轻结果照留，回来不重生成
    clearBuildCache()
  }
  /**
   * 编辑器跟上激活签：已经载着它就不动；否则先把编辑器里那份的状态暂存回它的 DocState（它还开着的话），再载入激活签。
   * 同步做完（没有 await）：Ctrl+Tab 连按不会交错。
   */
  function syncDoc() {
    const d = wb.activeAsmDoc()
    if (!d || !editor || !ui.active || !attached || (loaded === d && fresh())) return
    const t0 = performance.now()
    stashLoaded()
    const s = wb.takeStash(d)
    let src = null
    if (s) { try { src = JSON.parse(s.json) } catch { src = null } }
    const base = src || wb.docOf(d)
    ui.sym = s && s.sym ? { ...s.sym } : symDefaultFor(base)
    ui.posePreview = !!(s && s.posePreview)
    ui.ctx = null; ui.renaming = ''
    loaded = d
    loadedEpoch = wb.docEpoch(d)
    if (src) loadDoc(src, { fit: false, state: s.state })
    else loadDoc(base, { fit: true })
    switchMs = performance.now() - t0
    flushQueuedAdd()
  }
  /** 编辑器里载着的那份 → 暂存（撤销栈截到最近 STASH_HIST_MAX 步；文档 JSON 由 wb 取它最近一次提交） */
  function stashLoaded() {
    const a = loaded
    if (!a || !editor || !wb.isDocOpen(a) || !fresh()) return
    let state = null
    try { state = trimHistory(editor.getState(), STASH_HIST_MAX) } catch (e) { console.warn('[asm] 暂存：' + errText(e)); state = null }
    wb.stashDoc(a, { state, sym: { ...ui.sym }, posePreview: ui.posePreview })
  }
  function loadDoc(d, o = {}) {
    if (!d || !editor || !ui.active || !attached) return
    const seq = ++loadSeq
    const target = loaded
    try { editor.load(d, { fit: o.fit !== false, state: o.state || null }) } catch (e) {
      console.error('[asm] load：', e); setStatus('error', errText(e), 4000)
      // 抛在工作文档换上之后（叠加层 / 取景出错）：树与属性跟着编辑器实际持有的那份走，不挂着上一份
      let g = null
      try { g = editor.getDoc() } catch { g = null }
      if (g && g.domain === d.domain && g.comps.length === d.comps.length && loadSeen !== seq) { doc.value = Object.freeze(g); wb.asmAdopt(doc.value, JSON.stringify(g), target) }
      return
    }
    // 编辑器 load 会同步发 change(load)；万一没发，这里兜一份快照（不然树 / 属性还挂着上一份文档）
    if (loadSeen !== seq) {
      const g = editor.getDoc()
      if (g) { doc.value = Object.freeze(g); wb.asmAdopt(doc.value, JSON.stringify(g), target) }
    }
    ui.live = null
    pushPrefs(editor)
  }
  // 视图驱动：先于卫星页等的视口联动注册（ModelApp 在 setup 里先建本会话），切走时先还视口、它们再喂。
  // 激活签换成另一个装配签（设计页上停着不动）：只换编辑器里的文档
  watch(() => [wb.designAsm(), wb.activeAsmDoc()], ([on]) => {
    if (!started) return
    if (!on) deactivate()
    else if (!ui.active) activate()
    else syncDoc()
  })
  watch(() => theme.resolved, (t) => { if (editor && typeof editor.setTheme === 'function') editor.setTheme(t === 'dark' ? 'dark' : 'light') })
  /** ModelApp 在视口建好、清单读过之后调一次 */
  function start() {
    started = true
    if (wb.designAsm()) activate()
  }

  // ── 薄包装（统一 catch；失败只写状态短语）──
  function cmd(c) {
    if (!editor) return { ok: false }
    let r
    try { r = editor.apply(plain(c)) } catch (e) { r = { ok: false, error: errText(e) } }
    if (r && r.ok === false && r.error) setStatus('error', r.error, 4000)
    return r || { ok: false }
  }
  const call = (name, ...a) => { if (!editor) return undefined; try { return editor[name](...a) } catch (e) { console.error('[asm] ' + name + '：', e); setStatus('error', errText(e), 4000); return undefined } }
  const select = (ids, o) => call('select', Array.isArray(ids) ? ids.slice() : [], o || {})
  const frameSelection = () => call('frameSelection')
  function setTool(t) { ui.tool = t === 'rotate' ? 'rotate' : 'move'; call('setTool', ui.tool) }
  function setSpace(s) { ui.space = s; call('setSpace', s) }
  function setSnap(p) { Object.assign(ui.snap, p); call('setSnap', { on: ui.snap.on, move: ui.snap.move, rotate: ui.snap.rot }) }
  function setSym(p) { Object.assign(ui.sym, p); call('setSym', { op: ui.sym.op, n: ui.sym.n }) }
  function setPosePreview(on) { ui.posePreview = !!on; call('setPosePreview', ui.posePreview) }
  function setShowCom(on) { ui.showCom = !!on; call('setShowCom', ui.showCom) }
  function setShowSockets(on) { ui.showSockets = !!on; call('setShowSockets', ui.showSockets) }
  function setShowAxes(on) { ui.showAxes = !!on; call('setShowAxes', ui.showAxes) }
  /** 某件的本体系位姿（编辑器解算表的副本，16 个数；没有 null）：属性面板的位置读数 */
  const poseOf = (id) => (editor ? call('poseOf', id) || null : null)
  const undo = () => call('undo')
  const redo = () => call('redo')
  const duplicate = () => call('duplicate')
  const pickup = () => call('pickup')
  const mirror = () => call('mirror')
  /** 双击库卡片：params = 常用型号的型号参数（组件本身传 null） */
  const quickAdd = (type, params) => call('quickAdd', type, params ? { params } : {})
  /**
   * 库页组件档右键「添加到当前设计」：与双击卡片同一口径（quickAdd），但要等编辑器载上目标签——切到设计页要先借视口、等编辑器模块、
   * 载入文档。已载上就当场加；目标签换成了别的签 / 关掉了，这次添加作废。d 缺省 = 激活装配签。
   */
  let queuedAdd = null
  function queueAdd(type, params, d) {
    const doc = d || wb.activeAsmDoc()
    if (!doc || typeof type !== 'string') return false
    queuedAdd = { type, params: params && typeof params === 'object' && Object.keys(params).length ? plain(params) : null, doc }
    flushQueuedAdd()
    return true
  }
  function flushQueuedAdd() {
    const p = queuedAdd
    if (!p) return
    if (!wb.isDocOpen(p.doc) || (wb.activeAsmDoc() && wb.activeAsmDoc() !== p.doc)) { queuedAdd = null; return }
    if (!editor || !ui.active || !attached || loaded !== p.doc || !fresh()) return
    queuedAdd = null
    // 设计签停在「初值」姿态：编辑器拒收（quickAdd 静默 false）——把原因说出来，不让这次添加无声无息地丢掉
    if (ui.posePreview) { setStatus('warn', '初值姿态下不可编辑', 4000); return }
    quickAdd(p.type, p.params)
  }
  const beginDragFromLib = (type, x, y, o) => !!call('beginDragFromLib', type, x, y, o || {})
  /** 库卡片按下（还没过拖动门槛）：编辑器先把这件建进缓存、边线 / BVH 插队、ghost 材质异步编译 */
  const prewarm = (type, o) => { if (editor && ui.active && typeof editor.prewarmGhost === 'function') call('prewarmGhost', type, o || {}) }
  // ── 驱动装配件（快速设置层，drive.mjs）──
  const curDoc = () => { if (!editor) return null; try { return editor.getDoc() } catch { return null } }
  const nameOfId = (d, id) => { const c = compById(d, id); return c ? compLabel(c) : id }
  /** 整文档替换（编辑器 replaceDoc：入撤销栈；同 mergeKey 500 ms 内合并成一步）；失败写状态短语 */
  function replaceDoc(next, o = {}) {
    if (!editor || typeof editor.replaceDoc !== 'function') return { ok: false }
    let r
    try { r = editor.replaceDoc(next, { label: o.label || 'replace', mergeKey: o.mergeKey }) } catch (e) { r = { ok: false, error: errText(e) } }
    if (r && r.ok === false && r.error) setStatus('error', r.error, 4000)
    return r || { ok: false }
  }
  /**
   * 改驱动参数（快速设置面板 / 联动参数直写）：新整星 spec → 三方合并（改写保留、关联件重排）→ 整文档替换。
   * 驱动参数不合法时文档不动、状态行报原因。o.mergeKey：数字框连续输入合成一步撤销。
   */
  function driveSet(nextSpec, o = {}) {
    const d = curDoc()
    if (!d || !isDriven(d)) return { ok: false }
    const r = rebaseDrive(d, nextSpec)
    if (!r.ok) { setStatus('error', r.error, 4000); return r }
    const out = replaceDoc(r.doc, { label: 'drive', mergeKey: o.mergeKey })
    if (out.ok && r.rehomed.length) setStatus('warn', `${r.rehomed.map((id) => nameOfId(r.doc, id)).join('、')} 改为自由安装。`, 4000)
    return out
  }
  /** 设参数：驱动装配件里与整星参数一一对应的参数直写驱动参数（关联件随之重排）；其余照常改本件 */
  function setParams(id, params, o = {}) {
    const d = curDoc()
    if (d && isDriven(d)) {
      const spec = writeThrough(d, id, params)
      if (spec) return driveSet(spec, { mergeKey: o.mergeKey || `p|${id}|${Object.keys(params).sort().join(',')}` })
    }
    return cmd({ type: 'setParams', id, params })
  }
  /**
   * 删除选中件（整棵子树，同编辑器口径）。驱动装配件：子树里对应整星列表条目的件（反射面 / 太阳翼 / 附加件）从驱动参数删条目，
   * 关联支架 / 展开臂随新基线去掉；其余件照常删（删掉的生成件以后改驱动参数也不会回来）。一步撤销。
   */
  function remove() {
    const d = curDoc()
    const sel = ui.selIds.map((id) => String(id).split('~')[0])
    if (d && isDriven(d) && sel.length) {
      const all = new Set()
      for (const id of sel) for (const x of subtreeIds(d, id)) all.add(x)
      // 锁定件不删（同编辑器的删除命令 removeComps）：驱动这一支先改 spec 再合并，不经 removeComps，锁定要在这里先查
      if ([...all].some((id) => { const c = compById(d, id); return !!(c && c.locked) })) { setStatus('warn', '件已锁定。', 4000); return false }
      const r = driveRemove(d, [...all])
      if (r) {
        const rb = rebaseDrive(d, r.spec)
        if (!rb.ok) { setStatus('error', rb.error, 4000); return false }
        let next = rb.doc
        const left = [...all].filter((id) => compById(next, id))
        if (left.length) {
          const rr = removeComps(next, left)
          if (!rr.ok) { setStatus('warn', rr.error, 4000); return false }
          next = rr.doc
        }
        return replaceDoc(next, { label: 'remove' }).ok
      }
    }
    return !!call('remove')
  }
  /** 恢复驱动值：what = 参数键 / 'pose' / 'mass' / 'material' / 'name' / 'all' */
  function resetBase(id, what = 'all') {
    const d = curDoc()
    if (!d || !isDriven(d)) return false
    const next = resetToBase(d, id, what)
    return next ? replaceDoc(next, { label: 'reset' }).ok : false
  }
  /** 全部改写一次恢复 / 找回删掉的驱动件（各一步撤销） */
  function resetAll() { const d = curDoc(); const next = d && isDriven(d) ? resetAllOverrides(d) : null; return next ? replaceDoc(next, { label: 'reset' }).ok : false }
  function restoreDeleted() { const d = curDoc(); const next = d && isDriven(d) ? restoreSuppressed(d) : null; return next ? replaceDoc(next, { label: 'restore' }).ok : false }
  /** 解除驱动：组件原样保留，转成普通装配件（快速设置不再联动） */
  function detach() {
    const d = curDoc()
    if (!d || !isDriven(d)) return false
    return replaceDoc(detachDrive(d), { label: 'detach' }).ok
  }

  /** 保存：立即入库（有未存改动时；从未入库的新文档原样也能存） */
  function save() { return wb.flushDocSave(loaded || wb.activeAsmDoc(), { force: true }) }
  /**
   * 另存副本（§3.2）：当前内容存成新 id 的副本、作为新签打开并激活，原签保留。o.restore = 「另存副本并还原原件」：原件写回打开时的快照。
   * 新签的相机 / 选择 / 对称档沿用（编辑器桥），撤销栈从新签开始。
   */
  async function saveAs(o = {}) {
    const d = loaded && wb.isDocOpen(loaded) ? loaded : wb.activeAsmDoc()
    if (!d) return null
    const r = await wb.saveDocCopy(d.id, { restore: !!o.restore })
    if (r && r.ok === false && r.code !== 'unavailable') setStatus('error', r.error || (r.code === 'empty' ? '暂无组件。' : r.code === 'invalid' ? '参数无效。' : '保存失败'), 4000)
    return r
  }

  // ── 快捷键 ──
  const editing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || !!(t.closest && t.closest('.eg-scroll')))
  function onKey(e) {
    if (!wb.designAsm() || !editor || !ui.active) return
    if (e.defaultPrevented || e.isComposing || editing(e.target)) return
    if (document.querySelector('.lb-mask, .adlg-mask')) return   // 应用内对话框 / 确认框开着
    const k = String(e.key || '').toLowerCase()
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) { undo(); e.preventDefault() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { redo(); e.preventDefault() }
      else if (k === 'd') { duplicate(); e.preventDefault() }
      return
    }
    // 方向键 / PageUp / PageDown：微调选中件（按住连续走、Shift 细调；结构树有焦点时方向键归树导航）
    const nd = NUDGE_KEYS[k]
    if (nd && !e.altKey) {
      if (e.target && e.target.closest && e.target.closest('.asm-tree')) return
      if (call('nudge', nd, e.shiftKey)) e.preventDefault()
      return
    }
    if (e.altKey || e.repeat) return
    switch (k) {
      case 'w': setTool('move'); break
      case 'e': setTool('rotate'); break
      case 'q': setSpace(nextSpace(ui.space)); break
      case 'g': pickup(); break
      case 'm': mirror(); break
      case 'delete': case 'backspace': remove(); break
      case 'escape':
        // 拖入 / 拾起 / gizmo 拖动中的 Esc 由编辑器自己收；空闲时 Esc = 清选择
        if (ui.ctx) ui.ctx = null
        else if (ui.mode === 'idle' || ui.mode === 'hover') select([])
        else return
        break
      default: return
    }
    e.preventDefault()
  }
  window.addEventListener('keydown', onKey)

  function dispose() {
    window.removeEventListener('keydown', onKey)
    clearTimeout(prefT); clearTimeout(statusT); clearTimeout(statsT); clearTimeout(liveT)
    for (const off of offs) { try { off() } catch { /* 无 */ } }
    offs.length = 0
    if (editor) { try { editor.dispose() } catch (e) { console.error('[asm] dispose：', e) } editor = null }
  }

  return {
    ui, doc, editor: () => editor,
    // 编辑器里载着的文档（DocState）/ 最近一次装配签互切耗时（ms，验证台读数）
    loadedDoc: () => loaded, switchMs: () => switchMs,
    start, activate, deactivate, onKey, dispose,
    cmd, select, frameSelection, setTool, setSpace, setSnap, setSym, setPosePreview, setShowCom, setShowSockets, setShowAxes, poseOf,
    undo, redo, duplicate, remove, pickup, mirror, quickAdd, queueAdd, beginDragFromLib, prewarm, save, saveAs, setStatus,
    replaceDoc, driveSet, setParams, resetBase, resetAll, restoreDeleted, detach
  }
}
